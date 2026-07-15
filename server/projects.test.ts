import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listProjects, createProject, updateProject, archiveProject, ProjectNotFoundError } from './projects';
import type { Project } from './projects';
import { InvalidIdError } from './lyria';

describe('createProject', () => {
  // Test isolation: every call passes the injectable dir param so NOTHING is ever
  // written to the real projects/ library (which these tests previously polluted).
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-create-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('fills id/createdAt/updatedAt and applies defaults for an empty input', async () => {
    const project = await createProject({}, tmpDir);

    expect(project.id).toMatch(/^proj-\d+-[a-z0-9]+$/);
    expect(project.name).toBe('Untitled Project');
    expect(project.prompt).toBe('');
    expect(project.lyrics).toBe('');
    expect(project.versionIds).toEqual([]);
    expect(project.settings).toEqual({
      model: 'LYRIA 3 PRO',
      durationTarget: '3:00',
      batchCount: 1,
      language: 'EN',
    });
    expect(typeof project.createdAt).toBe('string');
    expect(typeof project.updatedAt).toBe('string');
    expect(project.createdAt).toBe(project.updatedAt);
    expect(Number.isNaN(Date.parse(project.createdAt))).toBe(false);
  });

  it('accepts a partial input and merges settings over the defaults', async () => {
    const project = await createProject({
      name: 'My Track',
      prompt: 'Cinematic darkwave',
      settings: { batchCount: 3 },
    }, tmpDir);

    expect(project.name).toBe('My Track');
    expect(project.prompt).toBe('Cinematic darkwave');
    expect(project.settings).toEqual({
      model: 'LYRIA 3 PRO',
      durationTarget: '3:00',
      batchCount: 3,
      language: 'EN',
    });
  });

  it('coerces non-string/non-array garbage input defensively instead of writing it to disk', async () => {
    const project = await createProject({
      name: 12345 as any,
      prompt: { evil: true } as any,
      lyrics: null as any,
      versionIds: 'not-an-array' as any,
    }, tmpDir);

    expect(project.name).toBe('Untitled Project');
    expect(project.prompt).toBe('');
    expect(project.lyrics).toBe('');
    expect(project.versionIds).toEqual([]);
  });

  it('filters versionIds to only strings', async () => {
    const project = await createProject({
      versionIds: ['gen-1', 42, 'gen-2', null] as any,
    }, tmpDir);
    expect(project.versionIds).toEqual(['gen-1', 'gen-2']);
  });

  it('persists the created project as pretty-printed JSON under <dir>/<id>.json', async () => {
    const project = await createProject({ name: 'Persisted' }, tmpDir);
    const raw = await fs.readFile(path.join(tmpDir, `${project.id}.json`), 'utf8');
    expect(raw).toContain('\n'); // pretty-printed, not minified
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(project.id);
    expect(parsed.name).toBe('Persisted');
  });
});

describe('listProjects', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-list-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns [] for a missing directory', async () => {
    const missingDir = path.join(tmpDir, 'does-not-exist');
    expect(await listProjects(missingDir)).toEqual([]);
  });

  it('returns [] for an empty directory', async () => {
    expect(await listProjects(tmpDir)).toEqual([]);
  });

  it('sorts projects by updatedAt newest-first', async () => {
    const older: Project = {
      id: 'proj-older',
      name: 'Older',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      prompt: '',
      lyrics: '',
      settings: { model: 'LYRIA 3 PRO', durationTarget: '3:00', batchCount: 1, language: 'EN' },
      versionIds: [],
    };
    const newer: Project = {
      ...older,
      id: 'proj-newer',
      name: 'Newer',
      updatedAt: '2026-06-01T00:00:00.000Z',
    };

    await fs.writeFile(path.join(tmpDir, `${older.id}.json`), JSON.stringify(older), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${newer.id}.json`), JSON.stringify(newer), 'utf8');

    const result = await listProjects(tmpDir);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('proj-newer');
    expect(result[1].id).toBe('proj-older');
  });

  it('skips unparseable manifest files with a console.warn instead of throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fs.writeFile(path.join(tmpDir, 'proj-broken.json'), '{ not valid json', 'utf8');
    const good: Project = {
      id: 'proj-good',
      name: 'Good',
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
      prompt: '',
      lyrics: '',
      settings: { model: 'LYRIA 3 PRO', durationTarget: '3:00', batchCount: 1, language: 'EN' },
      versionIds: [],
    };
    await fs.writeFile(path.join(tmpDir, `${good.id}.json`), JSON.stringify(good), 'utf8');

    const result = await listProjects(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('proj-good');
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('ignores non-.json files in the directory', async () => {
    await fs.writeFile(path.join(tmpDir, 'proj-x.wav'), 'not a manifest', 'utf8');
    expect(await listProjects(tmpDir)).toEqual([]);
  });
});

describe('updateProject', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-update-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('merges a subset of mutable fields and bumps updatedAt', async () => {
    const created = await createProject({ name: 'Original', prompt: 'Original prompt' }, tmpDir);
    const originalUpdatedAt = created.updatedAt;

    // ensure a measurable time delta
    await new Promise(r => setTimeout(r, 5));

    const updated = await updateProject(created.id, { name: 'Renamed', lyrics: 'New lyrics' }, tmpDir);

    expect(updated.name).toBe('Renamed');
    expect(updated.lyrics).toBe('New lyrics');
    expect(updated.prompt).toBe('Original prompt'); // untouched field preserved
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt); // createdAt never changes
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(originalUpdatedAt));
  });

  it('shallow-merges the settings object rather than replacing it', async () => {
    const created = await createProject({ settings: { batchCount: 2, language: 'FR' } }, tmpDir);

    const updated = await updateProject(created.id, { settings: { batchCount: 5 } }, tmpDir);

    expect(updated.settings).toEqual({
      model: 'LYRIA 3 PRO',
      durationTarget: '3:00',
      batchCount: 5,
      language: 'FR', // preserved from prior merge, not reset to default
    });
  });

  it('coerces versionIds to a string array on update', async () => {
    const created = await createProject({}, tmpDir);
    const updated = await updateProject(created.id, { versionIds: ['gen-1', 7, 'gen-2'] as any }, tmpDir);
    expect(updated.versionIds).toEqual(['gen-1', 'gen-2']);
  });

  it('persists the merged result to disk', async () => {
    const created = await createProject({ name: 'Persist Me' }, tmpDir);
    await updateProject(created.id, { name: 'Persisted Update' }, tmpDir);

    const raw = await fs.readFile(path.join(tmpDir, `${created.id}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe('Persisted Update');
  });

  it('throws a typed ProjectNotFoundError for an unknown id', async () => {
    await expect(
      updateProject('proj-1-missing', { name: 'x' }, tmpDir),
    ).rejects.toThrow(ProjectNotFoundError);
  });
});

describe('archiveProject', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-archive-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('moves projects/<id>.json into projects/archived/<id>.json, creating the dir', async () => {
    const created = await createProject({ name: 'To Archive' }, tmpDir);

    await archiveProject(created.id, tmpDir);

    const sourcePath = path.join(tmpDir, `${created.id}.json`);
    const destPath = path.join(tmpDir, 'archived', `${created.id}.json`);

    await expect(fs.access(sourcePath)).rejects.toThrow(); // source gone
    const archivedRaw = await fs.readFile(destPath, 'utf8'); // dest exists
    const archivedParsed = JSON.parse(archivedRaw);
    expect(archivedParsed.id).toBe(created.id);
    expect(archivedParsed.name).toBe('To Archive');
  });

  it('throws a typed ProjectNotFoundError for an unknown id', async () => {
    await expect(archiveProject('proj-1-missing', tmpDir)).rejects.toThrow(ProjectNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Security: id validation (path traversal) on the two client-id project entry points.
// ---------------------------------------------------------------------------

/** The exact attack ids from the security review — all must be rejected before any fs call. */
const TRAVERSAL_IDS = ['../evil', '..%2f..%2fetc', 'gen-1/../../x', 'nope'];

describe('updateProject — id validation (path traversal)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-update-safeid-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each(TRAVERSAL_IDS)('rejects id %j with InvalidIdError (→ would-be 400)', async (bad) => {
    await expect(updateProject(bad, { name: 'x' }, tmpDir)).rejects.toThrow(InvalidIdError);
  });

  it('still works for a well-formed id', async () => {
    const created = await createProject({ name: 'Safe' }, tmpDir);
    const updated = await updateProject(created.id, { name: 'Renamed Safe' }, tmpDir);
    expect(updated.name).toBe('Renamed Safe');
  });
});

describe('archiveProject — id validation (path traversal)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-archive-safeid-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each(TRAVERSAL_IDS)('rejects id %j with InvalidIdError (→ would-be 400)', async (bad) => {
    await expect(archiveProject(bad, tmpDir)).rejects.toThrow(InvalidIdError);
  });

  it('still works for a well-formed id', async () => {
    const created = await createProject({ name: 'Safe Archive' }, tmpDir);
    await archiveProject(created.id, tmpDir);
    await expect(fs.access(path.join(tmpDir, 'archived', `${created.id}.json`))).resolves.toBeUndefined();
  });
});
