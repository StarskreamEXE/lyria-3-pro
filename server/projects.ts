import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafeId, writeJsonAtomic } from './lyria';

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

/** Subset of Project fields a client may supply on create/update; server fills the rest. */
export interface ProjectInput {
  name?: unknown;
  prompt?: unknown;
  lyrics?: unknown;
  settings?: unknown;
  versionIds?: unknown;
}

const PROJECTS_DIR = path.join(process.cwd(), 'projects');
const ARCHIVED_SUBDIR = 'archived';

const DEFAULT_SETTINGS: ProjectSettings = {
  model: 'LYRIA 3 PRO',
  durationTarget: '3:00',
  batchCount: 1,
  language: 'EN',
};

/** Thrown when a requested project id has no manifest; server.ts maps this to HTTP 404. */
export class ProjectNotFoundError extends Error {}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function coerceSettings(value: unknown, base: ProjectSettings): ProjectSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...base };
  }
  const obj = value as Record<string, unknown>;
  return {
    model: typeof obj.model === 'string' ? obj.model : base.model,
    durationTarget: typeof obj.durationTarget === 'string' ? obj.durationTarget : base.durationTarget,
    batchCount: typeof obj.batchCount === 'number' && Number.isFinite(obj.batchCount) ? obj.batchCount : base.batchCount,
    language: typeof obj.language === 'string' ? obj.language : base.language,
  };
}

function manifestPath(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

/**
 * Creates a project from any subset of the mutable fields, filling id/createdAt/updatedAt
 * and defaults for anything missing or malformed. Never trusts raw client input: strings are
 * coerced (non-strings fall back to the default/empty string), versionIds is filtered to only
 * string entries, and settings is shallow-merged over DEFAULT_SETTINGS field-by-field. Persists
 * the result as pretty-printed JSON to <dir>/<id>.json (default: PROJECTS_DIR).
 */
export async function createProject(input: ProjectInput, dir: string = PROJECTS_DIR): Promise<Project> {
  const now = new Date().toISOString();
  const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const project: Project = {
    id,
    name: coerceString(input?.name, 'Untitled Project'),
    createdAt: now,
    updatedAt: now,
    prompt: coerceString(input?.prompt, ''),
    lyrics: coerceString(input?.lyrics, ''),
    settings: coerceSettings(input?.settings, DEFAULT_SETTINGS),
    versionIds: coerceStringArray(input?.versionIds),
  };

  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(manifestPath(dir, id), project);

  return project;
}

/**
 * Lists all persisted projects by reading every *.json manifest in dir (default: PROJECTS_DIR),
 * sorted newest-first by updatedAt. Missing/empty dir -> []. Unparseable manifest files are
 * skipped with a console.warn rather than throwing, matching listGenerations in lyria.ts.
 */
export async function listProjects(dir: string = PROJECTS_DIR): Promise<Project[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const jsonFiles = entries.filter(name => name.endsWith('.json'));
  const items: Project[] = [];

  for (const fileName of jsonFiles) {
    const filePath = path.join(dir, fileName);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const project = JSON.parse(raw) as Project;
      items.push(project);
    } catch (error) {
      console.warn(`Skipping unparseable project manifest "${fileName}":`, error);
    }
  }

  items.sort((a, b) => {
    const bTime = Date.parse(b.updatedAt);
    const aTime = Date.parse(a.updatedAt);
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });

  return items;
}

/**
 * Merges any subset of the mutable fields (name, prompt, lyrics, settings, versionIds) into
 * the persisted project at <dir>/<id>.json, bumps updatedAt, and rewrites the manifest.
 * settings is shallow-merged over the project's existing settings (not the defaults), so
 * previously-set fields survive a partial update. Throws ProjectNotFoundError for an unknown id.
 */
export async function updateProject(id: string, patch: ProjectInput, dir: string = PROJECTS_DIR): Promise<Project> {
  assertSafeId(id, 'proj'); // reject path-traversal ids before ANY fs call

  const filePath = manifestPath(dir, id);

  let project: Project;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    project = JSON.parse(raw) as Project;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new ProjectNotFoundError(`No project found with id "${id}".`);
    }
    throw error;
  }

  const updated: Project = {
    ...project,
    name: patch.name !== undefined ? coerceString(patch.name, project.name) : project.name,
    prompt: patch.prompt !== undefined ? coerceString(patch.prompt, project.prompt) : project.prompt,
    lyrics: patch.lyrics !== undefined ? coerceString(patch.lyrics, project.lyrics) : project.lyrics,
    settings: patch.settings !== undefined ? coerceSettings(patch.settings, project.settings) : project.settings,
    versionIds: patch.versionIds !== undefined ? coerceStringArray(patch.versionIds) : project.versionIds,
    updatedAt: new Date().toISOString(),
  };

  await writeJsonAtomic(filePath, updated);

  return updated;
}

/**
 * Archives a project by moving <dir>/<id>.json to <dir>/archived/<id>.json (creating the
 * archived subdir as needed). Never hard-deletes. Throws ProjectNotFoundError for an unknown id.
 */
export async function archiveProject(id: string, dir: string = PROJECTS_DIR): Promise<void> {
  assertSafeId(id, 'proj'); // reject path-traversal ids before ANY fs call (fs.rename here MOVES files)

  const sourcePath = manifestPath(dir, id);
  const archivedDir = path.join(dir, ARCHIVED_SUBDIR);
  const destPath = manifestPath(archivedDir, id);

  try {
    await fs.access(sourcePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new ProjectNotFoundError(`No project found with id "${id}".`);
    }
    throw error;
  }

  await fs.mkdir(archivedDir, { recursive: true });
  await fs.rename(sourcePath, destPath);
}
