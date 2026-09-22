// Singleton project store — same module-singleton shape as player.ts (plain object,
// closure-held private state, no React context). Owns the single "current project"
// and keeps it persisted server-side via debounced PUTs.
//
// Every operation here is best-effort and silent: failures are console.warn'd and
// never thrown to callers, so the app keeps working even if /api/projects/* is
// unreachable.
import {
  type Project,
  type ProjectSettings,
  type ProjectPatch,
  listProjects,
  listProjectsStrict,
  createProject,
  updateProject,
  archiveProject,
} from './lyriaClient';

export type { ProjectPatch };

const OLD_NAME_STORAGE_KEY = 'lyria_project_name';
// Name for the project created on first run. Neutral on purpose: a fabricated
// track-sounding name reads like the user already has work here when they don't.
const DEFAULT_PROJECT_NAME = 'Untitled Project';
const CURRENT_PROJECT_KEY = 'lyria_current_project_id';
const FLUSH_DELAY_MS = 800;

let current: Project | null = null;
let pendingPatch: ProjectPatch | null = null;
// Project id the queued pendingPatch belongs to. null = not yet bound to a project
// (queued before init landed) — adopted by whichever project init resolves to. A patch
// tagged for one project must never be PUT into another after a switch.
let pendingPatchProjectId: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let initPromise: Promise<void> | null = null;

function dispatchLoad(project: Project) {
  window.dispatchEvent(new CustomEvent('lyria-project-load', { detail: { project } }));
}

function rememberCurrent(id: string) {
  try { localStorage.setItem(CURRENT_PROJECT_KEY, id); } catch { /* storage unavailable */ }
}

function mergeSettings(base: ProjectSettings, patch: Partial<ProjectSettings> | undefined): ProjectSettings {
  if (!patch) return base;
  return { ...base, ...patch };
}

// Coalesces `patch` over `base` — settings deep-merge per-key (later wins), everything
// else last-write-wins, matching the server's own PUT semantics. Shared by update(),
// the pre-init stash, and the failed-flush re-queue so none of them can shallow-spread
// `settings` and silently lose keys.
function coalescePatches(base: ProjectPatch | null, patch: ProjectPatch): ProjectPatch {
  const settings = (base?.settings || patch.settings)
    ? { ...base?.settings, ...patch.settings }
    : undefined;
  return { ...base, ...patch, ...(settings ? { settings } : {}) };
}

// Applies a patch to the in-memory `current` project optimistically (settings shallow-merged,
// like the server does), bumping updatedAt locally so UI reads (e.g. dropdown's relative time)
// feel live even before the debounced PUT resolves.
function applyOptimistic(patch: ProjectPatch) {
  if (!current) return;
  const next: Project = {
    ...current,
    ...patch,
    settings: mergeSettings(current.settings, patch.settings),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  current = next;
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, FLUSH_DELAY_MS);
}

async function flushNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // Leave the patch queued (don't consume it) when there's no current project yet —
  // a pre-init stash must survive until init lands and binds it.
  if (!pendingPatch || !current) return;
  // A patch queued for a different project (stale after a switch) is discarded —
  // it must never be PUT into the project we're looking at now.
  if (pendingPatchProjectId !== null && pendingPatchProjectId !== current.id) {
    pendingPatch = null;
    pendingPatchProjectId = null;
    return;
  }
  const patch = pendingPatch;
  const targetId = current.id;
  pendingPatch = null;
  pendingPatchProjectId = null;

  try {
    const saved = await updateProject(targetId, patch);
    // Only adopt the server's copy if we're still looking at the same project —
    // a switchTo() may have already replaced `current` while this PUT was in flight.
    if (current && current.id === saved.id) {
      current = saved;
    }
  } catch (err) {
    console.warn('Failed to save project changes (will retry on next edit):', err);
    // Re-queue so the next edit's flush also carries this patch forward instead of
    // silently losing it — deep-merged (settings per-key) under anything newer that
    // queued while the PUT was in flight. If what queued meanwhile belongs to a
    // different project (a switch happened mid-flight), drop the failed patch instead
    // of contaminating the new project's queue.
    if (pendingPatchProjectId === null || pendingPatchProjectId === targetId) {
      pendingPatch = coalescePatches(patch, pendingPatch ?? {});
      pendingPatchProjectId = targetId;
    }
  }
}

export const projectStore = {
  async init(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      let projects: Project[];
      try {
        // STRICT list: a failed fetch must never look like "no projects exist" —
        // that mistake auto-created a new project on every remount during server
        // restarts (44 duplicates on 2026-07-15). On failure: no create, allow retry.
        projects = await listProjectsStrict();
      } catch (err) {
        console.warn('Project list unavailable — not auto-creating; will retry:', err);
        initPromise = null;
        return;
      }
      if (projects.length === 0) {
        const migratedName = (() => {
          try {
            return localStorage.getItem(OLD_NAME_STORAGE_KEY) || DEFAULT_PROJECT_NAME;
          } catch {
            return DEFAULT_PROJECT_NAME;
          }
        })();
        try {
          current = await createProject({ name: migratedName });
        } catch (err) {
          console.warn('Failed to create initial project:', err);
          initPromise = null;
          return;
        }
      } else {
        // Prefer the project the user was last working in (survives reload/HMR);
        // fall back to newest-updated.
        const storedId = (() => {
          try { return localStorage.getItem(CURRENT_PROJECT_KEY); } catch { return null; }
        })();
        current = projects.find(p => p.id === storedId)
          ?? projects.reduce((newest, p) => (
            Date.parse(p.updatedAt) > Date.parse(newest.updatedAt) ? p : newest
          ), projects[0]);
      }
      if (current) {
        rememberCurrent(current.id);
        // Adopt any patch stashed by update() calls that arrived before init landed:
        // bind it to the loaded project, fold it into the in-memory copy (so the load
        // broadcast below already reflects the user's pre-init edits), and let the
        // debounced flush persist it.
        if (pendingPatch && pendingPatchProjectId === null) {
          pendingPatchProjectId = current.id;
          applyOptimistic(pendingPatch);
          scheduleFlush();
        }
        dispatchLoad(current);
      }
    })();
    return initPromise;
  },

  current(): Project | null {
    return current;
  },

  update(patch: ProjectPatch): void {
    if (!current) {
      // Init never landed (e.g. server was mid-restart). Stash the patch — unbound
      // (pendingPatchProjectId stays null) so init adopts it into whichever project
      // it resolves to — instead of dropping the edit, and kick a retry so the
      // routes are re-probed the moment they come back.
      pendingPatch = coalescePatches(pendingPatch, patch);
      void projectStore.init();
      return;
    }
    applyOptimistic(patch);
    // Drop any leftover patch that belongs to a different project (stale after a
    // switch whose flush failed) before coalescing this one into the queue.
    if (pendingPatch && pendingPatchProjectId !== null && pendingPatchProjectId !== current.id) {
      pendingPatch = null;
    }
    // Coalesce with whatever's already queued — settings merge per-key (later wins),
    // everything else last-write-wins, matching the server's own PUT semantics.
    pendingPatch = coalescePatches(pendingPatch, patch);
    pendingPatchProjectId = current.id;
    scheduleFlush();
  },

  async switchTo(project: Project): Promise<void> {
    await flushNow();
    current = project;
    rememberCurrent(project.id);
    dispatchLoad(project);
  },

  async createNew(name?: string): Promise<void> {
    await flushNow();
    try {
      const project = await createProject({ name: name || 'Untitled Project' });
      current = project;
      rememberCurrent(project.id);
      dispatchLoad(project);
    } catch (err) {
      console.warn('Failed to create new project:', err);
    }
  },

  async archive(id: string): Promise<void> {
    const wasCurrent = current?.id === id;
    if (wasCurrent) await flushNow();
    try {
      await archiveProject(id);
    } catch (err) {
      console.warn('Failed to archive project:', err);
      return;
    }
    if (!wasCurrent) return;

    const remaining = (await listProjects()).filter(p => p.id !== id);
    if (remaining.length > 0) {
      const newest = remaining.reduce((a, b) => (Date.parse(b.updatedAt) > Date.parse(a.updatedAt) ? b : a), remaining[0]);
      current = newest;
      rememberCurrent(newest.id);
      dispatchLoad(newest);
    } else {
      await projectStore.createNew();
    }
  },
};
