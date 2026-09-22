import { loadKeys, withKeyHeaders, type Provider } from './apiKeys';

// ---------------------------------------------------------------------------
// Multi-key support
//
// The browser stores an ordered list of keys per provider (src/lib/apiKeys.ts).
// Every provider-backed request sends the whole list; the server walks it and
// falls back past key-level rejections (401/402/429). It then reports which key
// it ended up using via `x-lyria-key-index`, and, when it had to fall back,
// the rejected attempts via `x-lyria-key-attempts`.
//
// Nothing in here ever carries or renders key material: an attempt is only an
// index, an HTTP status and a short reason.
// ---------------------------------------------------------------------------

/** One rejected key, as reported by the server. `index` is 0-based into the sent list. */
export interface KeyAttempt {
  index: number;
  status?: number;
  reason?: string;
}

/** What a provider-backed response says about key selection. */
export interface KeyOutcome {
  /** 0-based index of the key the server accepted, or null when it didn't say. */
  usedIndex: number | null;
  /** Rejected keys, in the order they were tried. Empty when the first key worked. */
  attempts: KeyAttempt[];
}

/** Detail carried by the `lyria-key-fallback` window event. */
export interface KeyFallbackDetail extends KeyOutcome {
  provider: Provider | null;
}

export const KEY_FALLBACK_EVENT = 'lyria-key-fallback';

/** Drops anything that isn't a plain {index,status,reason} record — key material can never survive this. */
function normalizeAttempts(raw: unknown): KeyAttempt[] {
  if (!Array.isArray(raw)) return [];
  const attempts: KeyAttempt[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { index, status, reason } = entry as Record<string, unknown>;
    if (typeof index !== 'number' || !Number.isFinite(index)) continue;
    attempts.push({
      index,
      ...(typeof status === 'number' ? { status } : {}),
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    });
  }
  return attempts;
}

/** Reads the key-selection headers off a response. Absent headers mean "single-key server" — no fallback happened. */
export function readKeyOutcome(response: Response): KeyOutcome {
  const rawIndex = response.headers.get('x-lyria-key-index');
  const parsedIndex = rawIndex === null ? NaN : Number(rawIndex);
  const rawAttempts = response.headers.get('x-lyria-key-attempts');
  let attempts: KeyAttempt[] = [];
  if (rawAttempts) {
    try {
      attempts = normalizeAttempts(JSON.parse(rawAttempts));
    } catch {
      attempts = [];
    }
  }
  return { usedIndex: Number.isFinite(parsedIndex) ? parsedIndex : null, attempts };
}

/**
 * Announces a successful request that only succeeded after falling back down the key
 * list, so the UI can tell the user which key is actually carrying their traffic.
 * A no-op when the first key worked.
 */
export function notifyKeyFallback(response: Response, provider: Provider | null = currentProvider()): KeyOutcome {
  const outcome = readKeyOutcome(response);
  if (outcome.attempts.length > 0) {
    window.dispatchEvent(new CustomEvent<KeyFallbackDetail>(KEY_FALLBACK_EVENT, {
      detail: { ...outcome, provider },
    }));
  }
  return outcome;
}

/** Plain-words summary of rejected keys, e.g. "2 keys were rejected: key 1 (429 quota), key 2 (401 invalid)". */
export function describeKeyAttempts(attempts: KeyAttempt[] | undefined): string {
  if (!attempts || attempts.length === 0) return '';
  const parts = attempts.map(a => {
    const detail = [a.status ? String(a.status) : '', a.reason || ''].filter(Boolean).join(' ');
    return `key ${a.index + 1}${detail ? ` (${detail})` : ''}`;
  });
  const noun = attempts.length === 1 ? '1 key was' : `${attempts.length} keys were`;
  return `${noun} rejected: ${parts.join(', ')}`;
}

/** "Used key 2 after key 1 was rejected" — the successful-fallback note. */
export function describeKeyFallback(detail: KeyOutcome): string {
  if (!detail.attempts.length) return '';
  const rejected = detail.attempts.map(a => `key ${a.index + 1}`).join(', ');
  const verb = detail.attempts.length === 1 ? 'was' : 'were';
  const used = detail.usedIndex === null ? 'a later key' : `key ${detail.usedIndex + 1}`;
  return `Used ${used} after ${rejected} ${verb} rejected`;
}

/** An error from a provider-backed endpoint, carrying the server's per-key rejection list. */
export class ProviderRequestError extends Error {
  attempts: KeyAttempt[];
  status: number;
  constructor(message: string, attempts: KeyAttempt[], status: number) {
    super(message);
    this.name = 'ProviderRequestError';
    this.attempts = attempts;
    this.status = status;
  }
}

/** Attempts reported alongside an error, whichever shape the caller caught. */
export function attemptsFromError(err: unknown): KeyAttempt[] {
  return err instanceof ProviderRequestError ? err.attempts : [];
}

/** Builds the error for a failed provider-backed response, preferring the body's `attempts` over the headers'. */
export async function providerFailure(response: Response, fallbackMessage: string): Promise<ProviderRequestError> {
  const body = await response.json().catch(() => ({} as Record<string, unknown>));
  const bodyAttempts = normalizeAttempts((body as Record<string, unknown>)?.attempts);
  const attempts = bodyAttempts.length ? bodyAttempts : readKeyOutcome(response).attempts;
  const message = typeof (body as Record<string, unknown>)?.error === 'string' && (body as any).error
    ? (body as any).error as string
    : fallbackMessage;
  return new ProviderRequestError(message, attempts, response.status);
}

/** The provider the user picked in Settings, when they picked one. */
export function currentProvider(): Provider | null {
  try {
    const stored = localStorage.getItem('ai_provider');
    return stored === 'openrouter' || stored === 'gemini' ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Headers for a provider-backed request: the ordered key lists, plus the legacy
 * single-key headers (first key only) so an older server still authenticates,
 * plus the provider choice.
 */
export function providerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers = withKeyHeaders({ ...extra });
  for (const provider of ['gemini', 'openrouter'] as Provider[]) {
    const first = loadKeys(provider)[0]?.key;
    if (first) headers[provider === 'gemini' ? 'x-gemini-api-key' : 'x-openrouter-api-key'] = first;
  }
  const aiProvider = currentProvider();
  if (aiProvider) headers['x-ai-provider'] = aiProvider;
  return headers;
}

/** GET /api/settings/status — booleans plus (newer servers) how many keys each provider has configured. */
export interface SettingsStatus {
  geminiServerKey: boolean;
  openRouterServerKey: boolean;
  defaultProvider: 'gemini' | 'openrouter';
  // Present only on servers that support multiple server-side keys per provider.
  geminiServerKeys?: number;
  openRouterServerKeys?: number;
}

// Real audio analysis, persisted server-side into a generation's manifest once run.
// One paid call per generation — cached forever once present (see analyzeGeneration below).
export interface Analysis {
  title: string;
  genre: string;
  mood: string;
  energy: number; // 0-100 int
  bpm: number | null;
  key: string | null;
  instrumentation: string[];
  sections: { name: string; start: string; end: string }[]; // mm:ss
  notes: string;
}

export interface VersionPayload {
  id: string;
  audioUrl: string;
  prompt: string;
  lyrics: string;
  model: string;
  format: string;
  provider: string;
  structure?: unknown;
  analysis?: Analysis;
  // Optional user-supplied track name, echoed back on the generation payload.
  title?: string;
}

// Shape returned by GET /api/generations — one entry per persisted manifest, newest-first.
export interface GenerationEntry {
  id: string;
  model: string;
  format: string;
  provider: 'gemini' | 'openrouter' | 'mock';
  prompt: string;
  lyrics: string;
  generatedAt: string;
  structure?: unknown;
  audioUrl: string;
  analysis?: Analysis;
  // Optional user-supplied or renamed track title, and the measured audio duration.
  title?: string;
  durationSeconds?: number;
  // The generation settings this entry was produced with, recorded on the manifest so HISTORY
  // can restore them ("load with settings"). Manifests written before these fields existed
  // carry none of them: treat undefined as "unknown" and leave the current setting alone —
  // never substitute a default, which would silently lie about how the track was made.
  language?: string;
  durationTarget?: string;
  batchCount?: number;
}

export interface GenerateOptions {
  prompt: string;
  lyrics: string;
  language: string;
  durationTarget: string;
  model: 'pro' | 'clip';
  images: { name: string; url: string }[]; // object URLs from the tray
  // Optional user-supplied track name, passed through to POST /api/lyria/generate's `title` field.
  title?: string;
  // How many versions this one GENERATE click requested. Forwarded to the server so it lands on
  // every manifest in the batch; omitted from the request body when the caller doesn't supply it,
  // in which case the manifest simply carries no batchCount.
  batchCount?: number;
}

// Project library — shapes shared with server/projects.ts. Every helper below fails
// soft: listProjects returns [] on any failure (the app must still boot if the routes
// are unreachable), the others throw and callers (projectStore) swallow with
// console.warn — never an alert, never a crash.
export interface ProjectSettings {
  model: string;
  durationTarget: string;
  batchCount: number;
  language: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  lyrics: string;
  settings: ProjectSettings;
  versionIds: string[];
}

// Like Partial<Project>, but `settings` may itself be partial — the server (and
// projectStore's optimistic apply) shallow-merge it over the existing settings rather
// than requiring the full object on every write.
export type ProjectPatch = Partial<Omit<Project, 'settings'>> & { settings?: Partial<ProjectSettings> };

export async function listProjects(): Promise<Project[]> {
  try {
    return await listProjectsStrict();
  } catch (err) {
    console.warn('Failed to load projects:', err);
    return [];
  }
}

// Strict variant: THROWS on any failure so callers can tell "no projects exist"
// apart from "the fetch failed". projectStore.init MUST use this one — treating
// a failed fetch as an empty list is what mass-spawned duplicate projects.
export async function listProjectsStrict(): Promise<Project[]> {
  const response = await fetch('/api/projects');
  if (!response.ok) throw new Error(`GET /api/projects failed (${response.status})`);
  const data = await response.json();
  return Array.isArray(data.projects) ? data.projects : [];
}

export async function createProject(partial: ProjectPatch): Promise<Project> {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create project (${response.status})`);
  }
  const data = await response.json();
  return data.project;
}

export async function updateProject(id: string, patch: ProjectPatch): Promise<Project> {
  const response = await fetch(`/api/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update project (${response.status})`);
  }
  const data = await response.json();
  return data.project;
}

export async function archiveProject(id: string): Promise<{ archived: true }> {
  const response = await fetch(`/api/projects/${id}/archive`, { method: 'POST' });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Failed to archive project (${response.status})`);
  }
  return response.json();
}

async function objectUrlToBase64(url: string): Promise<{ mimeType: string; data: string }> {
  const blob = await fetch(url).then(r => r.blob());
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const [head, data] = dataUrl.split(',');
  return { mimeType: head.match(/data:(.*?);/)?.[1] ?? blob.type, data };
}

export async function generateVersion(opts: GenerateOptions): Promise<VersionPayload> {
  const headers = providerHeaders({ 'Content-Type': 'application/json' });

  const images = await Promise.all(opts.images.slice(0, 10).map(i => objectUrlToBase64(i.url)));

  const response = await fetch('/api/lyria/generate', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt: opts.prompt,
      lyrics: opts.lyrics,
      language: opts.language,
      durationTarget: opts.durationTarget,
      model: opts.model,
      format: 'wav',
      images,
      ...(opts.title ? { title: opts.title } : {}),
      ...(typeof opts.batchCount === 'number' ? { batchCount: opts.batchCount } : {}),
    }),
  });
  if (!response.ok) {
    throw await providerFailure(response, `Generation failed (${response.status})`);
  }
  notifyKeyFallback(response);
  return response.json();
}

export async function listGenerations(): Promise<GenerationEntry[]> {
  const response = await fetch('/api/generations');
  if (!response.ok) {
    throw new Error(`Failed to load generations (${response.status})`);
  }
  const data = await response.json();
  return data.generations;
}

export async function getOpenRouterCredits(): Promise<{ totalCredits: number; totalUsage: number; balance: number } | null> {
  const headers = providerHeaders();

  const response = await fetch('/api/openrouter/credits', { headers });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await providerFailure(response, `Failed to fetch OpenRouter credits (${response.status})`);
  }
  notifyKeyFallback(response, 'openrouter');
  return response.json();
}

// PUT /api/generations/:id {title} -> {generation}. Renames a persisted generation's manifest title. Throws on any
// non-OK response (404 unknown id, 400 empty title) — unlike listGenerations/listProjects,
// callers here are direct user actions (row rename) that want to surface the failure,
// not silently degrade.
export async function renameGeneration(id: string, title: string): Promise<GenerationEntry> {
  const response = await fetch(`/api/generations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Failed to rename generation (${response.status})`);
  }
  const data = await response.json();
  return data.generation;
}

export async function analyzeGeneration(id: string, force = false): Promise<Analysis> {
  const headers = providerHeaders({ 'Content-Type': 'application/json' });

  const response = await fetch('/api/ai/analyze', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id, force }),
  });
  if (!response.ok) {
    throw await providerFailure(response, `Analysis failed (${response.status})`);
  }
  notifyKeyFallback(response);
  const data = await response.json();
  return data.analysis;
}
