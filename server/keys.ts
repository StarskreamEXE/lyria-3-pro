// Ordered provider keys with failover.
//
// A provider key can stop working for reasons that have nothing to do with the
// request: the key is revoked, the account is out of credit, or the tier grants
// zero requests for the model (Google's free tier does exactly that for Lyria).
// Every one of those is fixed by using a different key, so the server accepts an
// ordered list per provider and walks it until one key is accepted.
//
// Sources, highest priority first:
//   1. the browser's `x-<provider>-api-keys` header (comma or newline separated)
//   2. the browser's legacy single-key `x-<provider>-api-key` header
//   3. `<PROVIDER>_API_KEY` in the environment, which may itself hold a list
//   4. `<PROVIDER>_API_KEY_2`, `_3`, ... for people who prefer one per line

/** Placeholder values shipped in .env.example that must never be sent to a provider. */
const PLACEHOLDERS = new Set(['MY_GEMINI_API_KEY', 'MY_OPENROUTER_API_KEY', 'your-key-here']);

/** Splits a raw list value on commas/newlines, trims, drops blanks, placeholders and duplicates. */
export function parseKeyList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of String(raw).split(/[,\n\r]+/)) {
    const key = part.trim();
    if (!key || PLACEHOLDERS.has(key)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

export interface KeySources {
  /** Value of the `x-<provider>-api-keys` header, if the browser sent one. */
  listHeader?: string;
  /** Value of the legacy single-key header, if the browser sent one. */
  singleHeader?: string;
  /** `<PROVIDER>_API_KEY`, which may hold a separated list. */
  env?: string;
  /** Numbered env fallbacks, in order: `<PROVIDER>_API_KEY_2`, `_3`, ... */
  numberedEnv?: (string | undefined)[];
}

/**
 * Resolves the ordered key list for one provider. Browser keys come first so a
 * key pasted into Settings still overrides the server's, exactly as before;
 * server keys follow as fallbacks rather than being discarded.
 */
export function resolveKeys(sources: KeySources): string[] {
  const ordered = [
    ...parseKeyList(sources.listHeader),
    ...parseKeyList(sources.singleHeader),
    ...parseKeyList(sources.env),
    ...(sources.numberedEnv ?? []).flatMap(v => parseKeyList(v)),
  ];
  return ordered.filter((key, i) => ordered.indexOf(key) === i);
}

/** Reads every `<PREFIX>_2`, `_3`, ... variable present in an environment object. */
export function numberedEnvValues(env: NodeJS.ProcessEnv, prefix: string, max = 10): string[] {
  const out: string[] = [];
  for (let i = 2; i <= max; i++) {
    const value = env[`${prefix}_${i}`];
    if (value) out.push(value);
  }
  return out;
}

/** One failed attempt, reported back so the UI can show which key was rejected. */
export interface KeyAttempt {
  index: number;
  status?: number;
  reason: string;
}

export class AllKeysFailedError extends Error {
  constructor(message: string, readonly attempts: KeyAttempt[]) {
    super(message);
  }
}

/** HTTP statuses that mean "this key cannot do it, another one might". */
const KEY_FAULT_STATUSES = new Set([401, 402, 403, 429]);

/**
 * True when an error is the key's fault rather than the request's: bad or revoked
 * credentials, no credit, or a quota/entitlement wall. A 429 counts because the
 * case this feature exists for — a tier granting zero requests per day — is
 * reported as 429 and never clears on retry with the same key.
 */
export function isKeyFault(error: unknown): boolean {
  const status = (error as { status?: number; statusCode?: number })?.status
    ?? (error as { statusCode?: number })?.statusCode;
  if (typeof status === 'number' && KEY_FAULT_STATUSES.has(status)) return true;
  const message = String((error as Error)?.message ?? '').toLowerCase();
  return /invalid api key|api key not valid|unauthorized|permission denied|quota|rate limit|insufficient credit|insufficient_quota|billing/.test(message);
}

/** Numeric HTTP status carried by an error, whichever property the thrower used. */
function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown; statusCode?: unknown } | null;
  const value = e?.status ?? e?.statusCode;
  return typeof value === 'number' ? value : undefined;
}

/** Short, key-free description of why an attempt failed. Never includes key material. */
export function describeFailure(error: unknown): string {
  const status = (error as { status?: number; statusCode?: number })?.status
    ?? (error as { statusCode?: number })?.statusCode;
  const message = String((error as Error)?.message ?? 'request failed');
  const trimmed = message.length > 200 ? `${message.slice(0, 200)}...` : message;
  return status ? `${status}: ${trimmed}` : trimmed;
}

export interface FailoverResult<T> {
  value: T;
  /** Index in the resolved list of the key that was accepted. */
  usedIndex: number;
  /** Keys rejected before it, in order. Empty when the first key worked. */
  attempts: KeyAttempt[];
}

/**
 * Runs `attempt` against each key in order until one succeeds. Only key-fault
 * errors move on to the next key; anything else (a malformed request, a provider
 * outage) throws immediately, because trying more keys would just repeat it and
 * bill the account again. Throws AllKeysFailedError when every key is rejected.
 */
export async function withKeyFailover<T>(
  keys: string[],
  attempt: (key: string, index: number) => Promise<T>,
  onKeyFault?: (failure: KeyAttempt) => void,
): Promise<FailoverResult<T>> {
  if (!keys.length) throw new AllKeysFailedError('No API key is configured.', []);

  const attempts: KeyAttempt[] = [];
  for (let i = 0; i < keys.length; i++) {
    try {
      return { value: await attempt(keys[i], i), usedIndex: i, attempts };
    } catch (error) {
      if (!isKeyFault(error) || i === keys.length - 1) {
        if (isKeyFault(error)) {
          const failure = { index: i, status: statusOf(error), reason: describeFailure(error) };
          attempts.push(failure);
          onKeyFault?.(failure);
          throw new AllKeysFailedError(
            keys.length === 1
              ? describeFailure(error)
              : `All ${keys.length} configured keys were rejected. Last error - ${describeFailure(error)}`,
            attempts,
          );
        }
        throw error;
      }
      const failure = { index: i, status: statusOf(error), reason: describeFailure(error) };
      attempts.push(failure);
      onKeyFault?.(failure);
    }
  }

  throw new AllKeysFailedError('No API key is configured.', attempts);
}
