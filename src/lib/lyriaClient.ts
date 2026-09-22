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
  const apiKey = localStorage.getItem('gemini_api_key');
  const openRouterApiKey = localStorage.getItem('openrouter_api_key');
  const aiProvider = localStorage.getItem('ai_provider');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-gemini-api-key'] = apiKey;
  if (openRouterApiKey) headers['x-openrouter-api-key'] = openRouterApiKey;
  if (aiProvider) headers['x-ai-provider'] = aiProvider;

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
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Generation failed (${response.status})`);
  }
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
  const openRouterApiKey = localStorage.getItem('openrouter_api_key');
  const headers: Record<string, string> = {};
  if (openRouterApiKey) headers['x-openrouter-api-key'] = openRouterApiKey;

  const response = await fetch('/api/openrouter/credits', { headers });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Failed to fetch OpenRouter credits (${response.status})`);
  }
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
  const apiKey = localStorage.getItem('gemini_api_key');
  const openRouterApiKey = localStorage.getItem('openrouter_api_key');
  const aiProvider = localStorage.getItem('ai_provider');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-gemini-api-key'] = apiKey;
  if (openRouterApiKey) headers['x-openrouter-api-key'] = openRouterApiKey;
  if (aiProvider) headers['x-ai-provider'] = aiProvider;

  const response = await fetch('/api/ai/analyze', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id, force }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Analysis failed (${response.status})`);
  }
  const data = await response.json();
  return data.analysis;
}
