// Browser-side storage for provider API keys.
//
// A provider key can stop working for reasons unrelated to the request (revoked,
// out of credit, or a tier that grants zero requests for the model), so the app
// keeps an ordered list per provider instead of a single key and the server
// falls back down the list. Keys live in this browser only and are sent as
// request headers; they are never rendered back to the user.

export type Provider = 'gemini' | 'openrouter';

/** Where the ordered list lives. The legacy single-key entries are migrated on read. */
const LIST_STORAGE_KEY: Record<Provider, string> = {
  gemini: 'gemini_api_keys',
  openrouter: 'openrouter_api_keys',
};

/** Pre-list storage, still read once so an existing install keeps its key. */
const LEGACY_STORAGE_KEY: Record<Provider, string> = {
  gemini: 'gemini_api_key',
  openrouter: 'openrouter_api_key',
};

/** Header carrying the whole ordered list, comma separated. */
export const LIST_HEADER: Record<Provider, string> = {
  gemini: 'x-gemini-api-keys',
  openrouter: 'x-openrouter-api-keys',
};

/** An optional, user-supplied name so two keys can be told apart without showing either. */
export interface StoredKey {
  key: string;
  label?: string;
}

function safeParse(raw: string | null): StoredKey[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(entry => (typeof entry === 'string' ? { key: entry } : entry))
      .filter((e): e is StoredKey => Boolean(e && typeof e.key === 'string' && e.key.trim()))
      .map(e => ({ key: e.key.trim(), label: e.label?.trim() || undefined }));
  } catch {
    return [];
  }
}

/** Ordered keys for a provider, migrating a legacy single key into the list on first read. */
export function loadKeys(provider: Provider): StoredKey[] {
  try {
    const list = safeParse(localStorage.getItem(LIST_STORAGE_KEY[provider]));
    if (list.length) return list;
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY[provider])?.trim();
    return legacy ? [{ key: legacy }] : [];
  } catch {
    return [];
  }
}

/**
 * Persists the ordered list, dropping blanks and duplicates. The legacy single-key
 * entry is kept in step with the first key so an older tab still works.
 */
export function saveKeys(provider: Provider, keys: StoredKey[]): StoredKey[] {
  const cleaned: StoredKey[] = [];
  for (const entry of keys) {
    const key = entry.key.trim();
    if (!key || cleaned.some(k => k.key === key)) continue;
    cleaned.push({ key, label: entry.label?.trim() || undefined });
  }
  try {
    localStorage.setItem(LIST_STORAGE_KEY[provider], JSON.stringify(cleaned));
    if (cleaned.length) localStorage.setItem(LEGACY_STORAGE_KEY[provider], cleaned[0].key);
    else localStorage.removeItem(LEGACY_STORAGE_KEY[provider]);
  } catch {
    // Storage can be unavailable (private mode, quota). The keys still work for
    // this page's lifetime; failing silently beats breaking Settings.
  }
  return cleaned;
}

/** Header value for a provider: the ordered keys, comma separated. Empty when none are stored. */
export function keyListHeaderValue(provider: Provider): string {
  return loadKeys(provider).map(k => k.key).join(',');
}

/** Adds both providers' key headers to a request when the browser has any stored. */
export function withKeyHeaders(headers: Record<string, string>): Record<string, string> {
  for (const provider of ['gemini', 'openrouter'] as Provider[]) {
    const value = keyListHeaderValue(provider);
    if (value) headers[LIST_HEADER[provider]] = value;
  }
  return headers;
}
