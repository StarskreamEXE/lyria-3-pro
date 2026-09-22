import React, { useState, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Play, Pause, MoreVertical, Plus, Volume2, VolumeX, MoreHorizontal, RefreshCcw, Maximize2, Sparkles, X, Lock, ZoomIn, ZoomOut, Loader2 } from 'lucide-react';
import { Waveform } from './Waveform';
import { SidebarLeft } from './SidebarLeft';
// modelIdToLabel (model id -> SidebarLeft MODEL_OPTIONS label) is shared from
// SidebarRight — one mapping for both the version-tab and history-row "Load settings"
// actions instead of two drift-prone copies.
import { SidebarRight, modelIdToLabel } from './SidebarRight';
// sanitizeExportName is shared with the EXPORT panel so a tab-menu export and a panel
// export name the file the same way — and neither can be pushed outside the download
// folder by a title containing a path separator.
import { ExportPanel, sanitizeExportName } from './ExportPanel';
import { ContextMenuHost, showContextMenu } from './ContextMenu';
import { extractPeaks } from '../lib/waveformData';
import { buildTimelineSections, sectionIndexAt, formatSeconds } from '../lib/sections';
import { analyzeGeneration, listGenerations, renameGeneration, attemptsFromError, describeKeyAttempts, type Analysis, type GenerationEntry, type Project, type SettingsStatus } from '../lib/lyriaClient';
import { stripProviderLyricMarkup } from '../lib/lyricsText';
import { projectStore } from '../lib/projectStore';
import { player } from '../lib/player';

// Matches the Waveform component's own default so extracted peak buckets line up 1:1
// with the number of bars it would otherwise render.
const WAVEFORM_DEFAULT_BARS = 200;

// A project with no generations has no versions: there are no seeded tabs, no seeded
// active version, and nothing for the timeline to draw. `0` is the "no active version"
// sentinel (real tabs are numbered from 1).
const NO_ACTIVE_VERSION = 0;

// Identity of one section-directive slot in the prompt. The same section (name + range,
// exactly what the directive text itself is built from) and the same action always map
// to the same key, so pressing an action twice replaces its own line instead of
// stacking a new one every click.
function directiveKey(action: string, name: string, range: string): string {
  return `${action}|${name}|${range}`;
}

/**
 * Removes every line equal to `line` from `prompt` (directives are always written as
 * their own line). Returns null when nothing matched — the caller then knows the
 * directive is no longer there (the user edited or undid it) and must not rewrite
 * the prompt.
 */
function removePromptLine(prompt: string, line: string): string | null {
  const target = line.trim();
  if (!target) return null;
  const lines = prompt.split(/\r?\n/);
  const kept = lines.filter(l => l.trim() !== target);
  if (kept.length === lines.length) return null;
  return kept.join('\n').trimEnd();
}

// The AI provider an analyze call will actually route to is the user's Settings choice
// (localStorage 'ai_provider', forwarded as the x-ai-provider header by
// analyzeGeneration), falling back to the server's own default. Subscribed through
// useSyncExternalStore so the readout follows the stored choice instead of freezing
// whatever was set at mount.
function subscribeToProviderChoice(onChange: () => void): () => void {
  // 'storage' only fires in OTHER tabs, so Settings also broadcasts
  // 'lyria-provider-change' for the tab that saved the choice.
  window.addEventListener('storage', onChange);
  window.addEventListener('lyria-provider-change', onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener('lyria-provider-change', onChange);
  };
}

function readProviderChoice(): string {
  try {
    return localStorage.getItem('ai_provider') ?? '';
  } catch {
    return ''; // storage unavailable — fall back to the server default
  }
}

export interface Version {
  n: number;
  id?: string;
  audioUrl?: string;
  prompt?: string;
  lyrics?: string;
  model?: string;
  format?: string;
  provider?: string;
  structure?: unknown;
  analysis?: Analysis;
  // Optional user-supplied or renamed track title — used for the tab tooltip and rename dialogs.
  title?: string;
  // Real measured track duration from the manifest (wav parsed, clip constant) —
  // the denominator for the detected-structure timeline's section widths.
  durationSeconds?: number;
  // Absent/empty today — the server only returns a single mixed master. Populated
  // only if a backend ever supplies real separated stems.
  stems?: { name: string; audioUrl: string }[];
}

// Shared materialization: turns a generation payload (either the live 'lyria-generated'
// payload shape or a persisted GenerationEntry from the library) into a version tab at
// slot `n`. Single source of truth for both the live-generation handler and the
// history-load / project-version-restore handlers below, so the field mapping only
// needs to be right in one place.
function materializeVersion(payload: Partial<GenerationEntry> & { id?: string }, n: number): Version {
  return {
    n,
    id: payload.id,
    audioUrl: payload.audioUrl,
    prompt: payload.prompt,
    lyrics: payload.lyrics,
    model: payload.model,
    format: payload.format,
    provider: payload.provider,
    structure: payload.structure,
    analysis: payload.analysis,
    title: payload.title,
    durationSeconds: payload.durationSeconds,
  };
}

export function CenterPanel() {
  const [versions, setVersions] = useState<Version[]>([]);
  const [activeVersion, setActiveVersion] = useState(NO_ACTIVE_VERSION);
  const [freshVersions, setFreshVersions] = useState<number[]>([]);
  // Synchronous mirror of `versions` for event handlers — state updaters must stay pure,
  // so nextN/added are computed from this ref and updated wherever versions changes.
  const versionsRef = useRef<Version[]>(versions);
  const [modelName, setModelName] = useState('LYRIA 3 PRO');
  const [lockedSections, setLockedSections] = useState<Record<string, boolean>>({});
  const [selectedSectionIdx, setSelectedSectionIdx] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);


  // New versions arrive from GENERATE (SidebarLeft) via the app event bus. SidebarLeft
  // dispatches exactly one 'lyria-generated' event per completed generation (it loops
  // client-side over batchCount and fires one event per result), so this handler only
  // ever needs to add a single version per event — no multi-version loop.
  // Pending fresh-version pulse timeout — tracked so it can be cleared when a newer
  // generation supersedes it (so the new tab's pulse isn't cut short by the old timer)
  // and on unmount (no setState after unmount).
  const freshVersionsTimeoutRef = useRef<number | null>(null);
  // Auto-play arming: set on 'lyria-action-start' (a generate is underway), consumed by
  // the FIRST 'lyria-generated' arrival of the batch, disarmed on 'lyria-action-end' so
  // a failed generation can never leave a stale arm behind. The actual play request is
  // dispatched from the active-version broadcast effect below, AFTER BottomBar has
  // swapped the player source to the new version.
  const autoPlayArmedRef = useRef(false);
  const autoPlayVersionNRef = useRef<number | null>(null);
  useEffect(() => {
    const handleGenerated = (e: Event) => {
      const { payload } = (e as CustomEvent).detail ?? {};
      const prev = versionsRef.current;
      const nextN = (prev[prev.length - 1]?.n ?? 0) + 1;
      const added: Version = payload ? materializeVersion(payload, nextN) : { n: nextN };
      const next = [...prev, added];
      versionsRef.current = next;
      setVersions(next);
      setActiveVersion(added.n);
      setFreshVersions([added.n]);
      // Cinematic reveal: the first arrival of the batch auto-plays. Analysis is NOT
      // run here — it is a paid call of its own, so it only ever happens on an explicit
      // user click (the ANALYZE button, the version-tab menu, the waveform-lane menu,
      // or a HISTORY row's Analyze action via 'lyria-request-analysis').
      if (autoPlayArmedRef.current && added.audioUrl) {
        autoPlayArmedRef.current = false;
        autoPlayVersionNRef.current = added.n;
      }
      if (freshVersionsTimeoutRef.current != null) window.clearTimeout(freshVersionsTimeoutRef.current);
      freshVersionsTimeoutRef.current = window.setTimeout(() => {
        freshVersionsTimeoutRef.current = null;
        setFreshVersions([]);
      }, 2500);
    };
    const handleModelChange = (e: Event) => {
      const m = (e as CustomEvent).detail?.model;
      if (m) setModelName(m);
    };

    window.addEventListener('lyria-generated', handleGenerated);
    window.addEventListener('lyria-model-change', handleModelChange);
    return () => {
      window.removeEventListener('lyria-generated', handleGenerated);
      window.removeEventListener('lyria-model-change', handleModelChange);
      if (freshVersionsTimeoutRef.current != null) {
        window.clearTimeout(freshVersionsTimeoutRef.current);
        freshVersionsTimeoutRef.current = null;
      }
    };
  }, []);

  // Loads from HISTORY (SidebarRight's library) arrive here separately from live
  // generations: if a tab already carries this id, just switch to it — otherwise
  // materialize a new tab from the library entry. Never emits 'lyria-generated',
  // since a load is not a new generation and must not re-log into history.
  useEffect(() => {
    const handleLoadGeneration = (e: Event) => {
      const payload = (e as CustomEvent).detail?.payload;
      if (!payload?.id) return;

      const prev = versionsRef.current;
      const existing = prev.find(v => v.id === payload.id);
      if (existing) {
        setActiveVersion(existing.n);
        return;
      }

      const nextN = (prev[prev.length - 1]?.n ?? 0) + 1;
      const newVersion = materializeVersion(payload, nextN);
      const next = [...prev, newVersion];
      versionsRef.current = next;
      setVersions(next);
      setActiveVersion(nextN);
    };

    window.addEventListener('lyria-load-generation', handleLoadGeneration);
    return () => window.removeEventListener('lyria-load-generation', handleLoadGeneration);
  }, []);

  // Set while applyProjectVersions() is rebuilding the tab set from a loaded project's
  // versionIds — suppresses the versionIds-push effect below so re-applying a project's
  // own versionIds doesn't immediately re-PUT the same list back into it.
  const isRestoringVersionsRef = useRef(false);

  // Epoch counter guarding the async listGenerations() restore against a fast A→B
  // project switch — same stale-request pattern as peaksRequestRef below: capture the
  // epoch when the load event arrives, bail in then/catch/finally if a newer load has
  // superseded it, so A's versionIds can never rebuild (or be persisted into) B.
  const projectLoadRequestRef = useRef(0);

  // projectStore dispatches 'lyria-project-load' on init, switchTo, createNew, and
  // post-archive fallback. Rebuilds the entire tab set from project.versionIds, in
  // order, reusing materializeVersion so the mapping stays identical to the live and
  // history-load paths above. Ids no longer present in the generations library are
  // skipped rather than rendered as broken tabs. Empty versionIds (a brand-new project)
  // means no tabs at all — the timeline shows its empty state instead of seeded ones,
  // and the project's first real generation becomes V1 both now and after a reload.
  useEffect(() => {
    const handleProjectLoad = (e: Event) => {
      const project = (e as CustomEvent<{ project: Project }>).detail?.project;
      if (!project) return;

      const requestId = ++projectLoadRequestRef.current;
      isRestoringVersionsRef.current = true;

      const versionIds = project.versionIds ?? [];
      if (versionIds.length === 0) {
        versionsRef.current = [];
        setVersions([]);
        setActiveVersion(NO_ACTIVE_VERSION);
        setTimeout(() => { isRestoringVersionsRef.current = false; }, 0);
        return;
      }

      listGenerations()
        .then((entries) => {
          if (projectLoadRequestRef.current !== requestId) return; // stale — a newer project load superseded this one
          const storeCurrent = projectStore.current();
          if (storeCurrent && storeCurrent.id !== project.id) return; // the store already moved to another project
          const byId = new Map(entries.map(entry => [entry.id, entry]));
          const restored: Version[] = [];
          let n = 1;
          for (const id of versionIds) {
            const entry = byId.get(id);
            if (!entry) continue; // skip ids no longer found in the library
            restored.push(materializeVersion(entry, n));
            n += 1;
          }
          versionsRef.current = restored;
          setVersions(restored);
          setActiveVersion(restored.length > 0 ? restored[restored.length - 1].n : NO_ACTIVE_VERSION);
        })
        .catch((err) => {
          if (projectLoadRequestRef.current !== requestId) return; // stale — outcome belongs to a superseded load
          const storeCurrent = projectStore.current();
          if (storeCurrent && storeCurrent.id !== project.id) return;
          console.warn('Failed to restore project versions:', err);
          // The library is unreachable, so nothing about this project's versions is
          // known — show no tabs rather than inventing any.
          versionsRef.current = [];
          setVersions([]);
          setActiveVersion(NO_ACTIVE_VERSION);
        })
        .finally(() => {
          // Superseded loads must not clear the flag out from under the newer load —
          // the load that owns the current epoch always reaches its own finally.
          if (projectLoadRequestRef.current !== requestId) return;
          setTimeout(() => { isRestoringVersionsRef.current = false; }, 0);
        });
    };

    window.addEventListener('lyria-project-load', handleProjectLoad);
    return () => window.removeEventListener('lyria-project-load', handleProjectLoad);
  }, []);

  // Pushes versionIds into the store whenever the set of real (non-placeholder) ids
  // in `versions` changes — a generation completing, or a library load adding a tab.
  // Skipped while a project-load is actively rebuilding the tab set (isRestoringVersionsRef)
  // to avoid immediately re-PUTting the same versionIds back into the project that just
  // supplied them.
  // Seeded with the serialized initial state (placeholders carry no ids -> '[]') so
  // the mount-time effect run is a no-op: pushing `versionIds: []` before a project
  // has loaded would otherwise queue a patch that wipes the loaded project's real
  // versionIds (projectStore now stashes pre-init updates instead of dropping them).
  const lastPushedVersionIdsRef = useRef<string>('[]');
  useEffect(() => {
    if (isRestoringVersionsRef.current) return;
    const ids = versions.map(v => v.id).filter((id): id is string => Boolean(id));
    const serialized = JSON.stringify(ids);
    if (serialized === lastPushedVersionIdsRef.current) return;
    lastPushedVersionIdsRef.current = serialized;
    projectStore.update({ versionIds: ids });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions]);

  // Broadcast the active version's audio to the transport (BottomBar)
  useEffect(() => {
    const v = versions.find(x => x.n === activeVersion);
    window.dispatchEvent(new CustomEvent('lyria-active-version', {
      detail: { n: activeVersion, audioUrl: v?.audioUrl ?? null, format: v?.format ?? null },
    }));
    // Auto-play the just-generated version — dispatched AFTER the active-version event
    // above, whose BottomBar handler synchronously swaps the player source, so the play
    // request always lands on the fresh track.
    if (autoPlayVersionNRef.current === activeVersion && v?.audioUrl) {
      autoPlayVersionNRef.current = null;
      window.dispatchEvent(new CustomEvent('lyria-transport-play'));
    }
  }, [activeVersion, versions]);

  // Real waveform peaks for the active version's master mix (the single mixed-down
  // file Lyria actually returns). `null` or `[]` both render the same flat dim center
  // line in Waveform (no extraction resolved yet / explicit "no audio" signal) — seeded
  // as `[]` so the very first paint is honest rather than momentarily undefined.
  const [activePeaks, setActivePeaks] = useState<number[] | null>([]);
  const peaksRequestRef = useRef(0);

  useEffect(() => {
    const v = versions.find(x => x.n === activeVersion);
    const audioUrl = v?.audioUrl;
    const requestId = ++peaksRequestRef.current;

    if (!audioUrl) {
      setActivePeaks([]);
      return;
    }

    extractPeaks(audioUrl, WAVEFORM_DEFAULT_BARS)
      .then((peaks) => {
        if (peaksRequestRef.current !== requestId) return; // stale — user switched versions mid-decode
        setActivePeaks(peaks);
      })
      .catch((err) => {
        if (peaksRequestRef.current !== requestId) return;
        console.warn('Failed to extract waveform peaks for', audioUrl, err);
        setActivePeaks([]);
      });
  }, [activeVersion, versions]);

  // Per-stem peaks for the active version's stems, if a backend has supplied any
  // (see Version.stems). Keyed by stem name. Same null/[]-semantics and stale-request
  // guarding as the master peaks above, but tracked per stem so one slow decode doesn't
  // block another stem's lane from rendering.
  const activeVersionData = versions.find(x => x.n === activeVersion);
  const activeStems = activeVersionData?.stems ?? [];

  // Detected-structure timeline: derived ONLY from the active version's real audio
  // analysis (sections + measured duration). No analysis → no structure rendered.
  const timelineSections = useMemo(
    () => buildTimelineSections(activeVersionData?.analysis?.sections, activeVersionData?.durationSeconds),
    [activeVersionData?.analysis?.sections, activeVersionData?.durationSeconds],
  );
  const selectedSection = selectedSectionIdx !== null ? timelineSections[selectedSectionIdx] : undefined;
  // Section lock state is per version + section index (sections are real per-track data now).
  // Separate from directiveKey() below, which keys the prompt text a lock wrote by the
  // section's own name + range so UNLOCK can find and remove exactly that line.
  const lockKeyFor = (idx: number) => `${activeVersionData?.id ?? 'none'}:${idx}`;

  // Inspector lyrics: the provider echoes its own structural/timing markup ([[A0]],
  // [2.0:6.1], [:]) around the sung lines. Readers get the cleaned text — the same
  // stripper the rest of the app shares.
  const activeLyrics = useMemo(
    () => stripProviderLyricMarkup(activeVersionData?.lyrics ?? ''),
    [activeVersionData?.lyrics],
  );

  // INFO readouts: the ACTIVE VERSION's real values, never the current chip settings.
  // Duration is the measured length recorded in the manifest; unknown stays unknown
  // (an em dash) rather than being filled in with the requested target.
  const activeDurationSeconds = activeVersionData?.durationSeconds;
  const activeDurationLabel = typeof activeDurationSeconds === 'number' && Number.isFinite(activeDurationSeconds) && activeDurationSeconds > 0
    ? formatSeconds(activeDurationSeconds)
    : null;
  const activeModelLabel = activeVersionData?.model?.trim() || null;

  // Selection belongs to one version's detected sections — switching versions resets it.
  useEffect(() => {
    setSelectedSectionIdx(null);
  }, [activeVersion]);

  // Live playback highlight: which detected section the playhead is currently inside.
  // Cheap 250ms poll (matches BottomBar's readout cadence), only while sections exist.
  const [playingSectionIdx, setPlayingSectionIdx] = useState<number | null>(null);
  useEffect(() => {
    if (timelineSections.length === 0) {
      setPlayingSectionIdx(null);
      return;
    }
    const tick = () => {
      setPlayingSectionIdx(player.isPlaying ? sectionIndexAt(timelineSections, player.currentTime) : null);
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [timelineSections]);
  const [stemPeaks, setStemPeaks] = useState<Record<string, number[] | null>>({});
  const stemRequestRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (activeStems.length === 0) {
      setStemPeaks({});
      return;
    }

    setStemPeaks(prev => {
      const next: Record<string, number[] | null> = {};
      for (const stem of activeStems) next[stem.name] = prev[stem.name] ?? null;
      return next;
    });

    activeStems.forEach((stem) => {
      const requestId = (stemRequestRef.current[stem.name] ?? 0) + 1;
      stemRequestRef.current[stem.name] = requestId;

      if (!stem.audioUrl) {
        setStemPeaks(prev => ({ ...prev, [stem.name]: [] }));
        return;
      }

      extractPeaks(stem.audioUrl, WAVEFORM_DEFAULT_BARS)
        .then((peaks) => {
          if (stemRequestRef.current[stem.name] !== requestId) return; // stale
          setStemPeaks(prev => ({ ...prev, [stem.name]: peaks }));
        })
        .catch((err) => {
          if (stemRequestRef.current[stem.name] !== requestId) return;
          console.warn('Failed to extract waveform peaks for stem', stem.name, stem.audioUrl, err);
          setStemPeaks(prev => ({ ...prev, [stem.name]: [] }));
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVersion, JSON.stringify(activeStems)]);

  // Real audio analysis (GENRE/MOOD/ENERGY/BPM/KEY/instrumentation/sections) — one paid
  // call per generation, run ONLY from an explicit user action (the ANALYZE button, the
  // version-tab menu, the waveform-lane menu, or a HISTORY row's Analyze) and cached on
  // the version + persisted server-side into the manifest. Keyed by generation id so
  // state survives switching tabs and doesn't leak between versions.
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<{ id: string; message: string } | null>(null);
  // Synchronous re-entrancy guard keyed per generation id (state alone can't guard —
  // it updates a render late): the ANALYZE button, the tab/lane context menus, and
  // 'lyria-request-analysis' can all fire for the same id back-to-back, and each
  // analyze is a paid call. Distinct ids may still run concurrently.
  const analyzingIdsRef = useRef<Set<string>>(new Set());

  const handleAnalyze = async (id: string) => {
    if (analyzingIdsRef.current.has(id)) return; // an analysis for this id is already in flight
    analyzingIdsRef.current.add(id);
    setAnalysisError(null);
    setAnalyzingId(id);
    try {
      const analysis = await analyzeGeneration(id);
      const prev = versionsRef.current;
      const next = prev.map(v => (v.id === id ? { ...v, analysis } : v));
      versionsRef.current = next;
      setVersions(next);
      window.dispatchEvent(new CustomEvent('lyria-analysis', { detail: { id, analysis } }));
    } catch (err) {
      console.warn('Failed to analyze generation', id, err);
      // One error surface for this failure, carrying the server's per-key rejection
      // summary when it fell through several stored keys (indexes/statuses only).
      const base = err instanceof Error ? err.message : 'Analysis failed';
      const keySummary = describeKeyAttempts(attemptsFromError(err));
      setAnalysisError({ id, message: keySummary ? `${base} — ${keySummary}` : base });
    } finally {
      analyzingIdsRef.current.delete(id);
      // Only clear the spinner if it still belongs to this id — a concurrent analyze
      // of a different id may have claimed it since.
      setAnalyzingId(current => (current === id ? null : current));
    }
  };

  // Which provider that paid analyze call will actually go to: the Settings choice wins
  // (analyzeGeneration forwards it as x-ai-provider), otherwise the server's configured
  // default. Null while neither is known — the readout then names no provider rather
  // than claiming the wrong one.
  const providerChoice = useSyncExternalStore(subscribeToProviderChoice, readProviderChoice);
  const [serverDefaultProvider, setServerDefaultProvider] = useState<'gemini' | 'openrouter' | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/status')
      .then(r => (r.ok ? r.json() : null))
      // Partial<SettingsStatus>: the key-count fields only exist on newer servers, and
      // an older server answers without them — read defensively either way.
      .then((status: Partial<SettingsStatus> | null) => {
        if (cancelled) return;
        const fallback = status?.defaultProvider;
        setServerDefaultProvider(fallback === 'openrouter' || fallback === 'gemini' ? fallback : null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('Failed to read the server AI provider default:', err);
        setServerDefaultProvider(null);
      });
    return () => { cancelled = true; };
  }, []);
  const analysisProvider = providerChoice === 'openrouter' || providerChoice === 'gemini'
    ? providerChoice
    : serverDefaultProvider;
  // Gemini analyses always run on gemini-3.5-flash (server-side constant). The
  // OpenRouter model is server-configured (OPENROUTER_ANALYZE_MODEL) and not visible
  // from here, so that path names the provider only.
  const analysisProviderLabel = analysisProvider === 'openrouter'
    ? 'openrouter'
    : analysisProvider === 'gemini'
      ? 'gemini-3.5-flash'
      : null;

  // 'lyria-request-analysis' {id} — dispatched by SidebarRight's row "Analyze" action.
  // Keep it simple: activate the version first via the existing load path
  // (so the id is guaranteed to be materialized as a tab), then run the same ANALYZE
  // flow the button already uses.
  useEffect(() => {
    const handleRequestAnalysis = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;
      const existing = versionsRef.current.find(v => v.id === id);
      if (existing) {
        setActiveVersion(existing.n);
      }
      void handleAnalyze(id);
    };
    window.addEventListener('lyria-request-analysis', handleRequestAnalysis);
    return () => window.removeEventListener('lyria-request-analysis', handleRequestAnalysis);
  }, []);

  // Sync tab titles/tooltips when a rename happens elsewhere (SidebarRight's row rename,
  // or this panel's own commitRenameVersion below broadcasting to keep everyone in sync).
  useEffect(() => {
    const handleRenamed = (e: Event) => {
      const { id, title } = (e as CustomEvent<{ id?: string; title?: string }>).detail ?? {};
      if (!id || !title) return;
      const prev = versionsRef.current;
      const next = prev.map(v => (v.id === id ? { ...v, title } : v));
      versionsRef.current = next;
      setVersions(next);
    };
    window.addEventListener('lyria-generation-renamed', handleRenamed);
    return () => window.removeEventListener('lyria-generation-renamed', handleRenamed);
  }, []);

  // Version-tab context menu action: replay this version's prompt/lyrics/model into
  // the editors (same mechanism as SidebarRight's "Load with settings").
  const loadParamsFromVersion = (v: Version) => {
    window.dispatchEvent(new CustomEvent('lyria-load-params', {
      detail: {
        prompt: v.prompt,
        lyrics: v.lyrics,
        model: modelIdToLabel(v.model),
      },
    }));
  };

  // Version-tab rename: the tab swaps to an inline input, exactly like a HISTORY row
  // (see SidebarRight's beginRename/commitRename) — Enter commits, Escape cancels, blur
  // commits. `renamingVersionId` holds the generation id being renamed, so the input
  // follows the version rather than a tab position.
  const [renamingVersionId, setRenamingVersionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const beginRenameVersion = (v: Version) => {
    if (!v.id) return;
    setRenamingVersionId(v.id);
    setRenameValue(v.title || '');
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };

  // Persists through the same rename API the HISTORY rows use, then updates this tab's
  // title/tooltip and broadcasts so SidebarRight's row stays in sync.
  const commitRenameVersion = async (v: Version) => {
    const nextTitle = renameValue.trim();
    setRenamingVersionId(null);
    if (!v.id || !nextTitle || nextTitle === (v.title ?? '')) return;
    try {
      const updated = await renameGeneration(v.id, nextTitle);
      const title = updated.title ?? nextTitle;
      const prev = versionsRef.current;
      const nextVersions = prev.map(x => (x.id === v.id ? { ...x, title } : x));
      versionsRef.current = nextVersions;
      setVersions(nextVersions);
      window.dispatchEvent(new CustomEvent('lyria-generation-renamed', { detail: { id: v.id, title } }));
    } catch (err) {
      console.warn('Failed to rename version', v.id, err);
    }
  };

  const exportVersion = (v: Version) => {
    if (!v.audioUrl) return;
    const a = document.createElement('a');
    a.href = v.audioUrl;
    // Prefer the version's own `format` field over parsing the URL (query strings
    // break `.split('.').pop()`); the query/hash-stripped path extension is only a
    // fallback for entries without a format field.
    const ext = (v.format || v.audioUrl.split(/[?#]/)[0].split('.').pop() || 'wav').toLowerCase();
    // Same naming rule as the EXPORT panel: sanitized title, then the generation id,
    // then the tab number — never a raw title straight into a file name.
    const base = sanitizeExportName(v.title || '') || sanitizeExportName(v.id || '') || `lyria-v${v.n}`;
    a.download = `${base}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const openVersionTabMenu = (e: React.MouseEvent, v: Version) => {
    showContextMenu(e, [
      { label: 'Load settings from this version', onClick: () => loadParamsFromVersion(v) },
      { label: 'Rename…', onClick: () => beginRenameVersion(v), disabled: !v.id },
      { label: 'Analyze', onClick: () => v.id && handleAnalyze(v.id), disabled: !v.id },
      { label: 'Export', onClick: () => exportVersion(v), disabled: !v.audioUrl },
    ]);
  };

  // Waveform lane (MASTER) context menu — "Seek here" computes the click ratio against
  // the lane's own bounding box so it's correct regardless of current zoom.
  const openWaveformLaneMenu = (e: React.MouseEvent<HTMLDivElement>, v: Version) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0;
    showContextMenu(e, [
      {
        label: 'Seek here',
        onClick: () => {
          if (player.duration > 0) player.seek(ratio * player.duration);
        },
        disabled: !v.audioUrl,
      },
      { label: 'Analyze this version', onClick: () => v.id && handleAnalyze(v.id), disabled: !v.id },
      { label: 'Export this version', onClick: () => exportVersion(v), disabled: !v.audioUrl },
    ]);
  };

  // Section directives this panel has written into the prompt: directiveKey -> the exact
  // line it appended. It is what makes a repeated action replace its own previous line
  // instead of stacking one per click, and what lets UNLOCK remove exactly the line LOCK
  // added.
  const sectionDirectivesRef = useRef<Map<string, string>>(new Map());

  // The prompt text as the editor currently holds it. SidebarLeft mirrors every prompt
  // edit into projectStore synchronously (optimistic apply), so this is the same string
  // the textarea shows. Null before the store has initialized — nothing to rewrite then.
  const readPromptText = (): string | null => {
    const project = projectStore.current();
    return project ? project.prompt ?? '' : null;
  };

  // Rewrites the whole prompt through the existing 'lyria-load-params' contract — the
  // only bus event that can REPLACE prompt text ('lyria-prompt-append' can only add).
  // Used just for the replace/remove paths below, so a first-time directive still goes
  // through the plain append (and keeps its own undo entry).
  const writePromptText = (text: string) => {
    window.dispatchEvent(new CustomEvent('lyria-load-params', { detail: { prompt: text } }));
  };

  // Writes the directive for one (section, action) slot, replacing the line this panel
  // last wrote for that same slot when it is still in the prompt. If the prompt can't be
  // read, or the user has since edited/undone that line, it falls back to a plain append
  // rather than rewriting text the user owns.
  const writeSectionDirective = (key: string, text: string) => {
    const previous = sectionDirectivesRef.current.get(key);
    const prompt = previous === undefined ? null : readPromptText();
    const without = prompt !== null && previous !== undefined ? removePromptLine(prompt, previous) : null;
    if (without !== null) {
      writePromptText(without ? `${without}\n${text}` : text);
    } else {
      window.dispatchEvent(new CustomEvent('lyria-prompt-append', { detail: { text } }));
    }
    sectionDirectivesRef.current.set(key, text);
  };

  // Removes the directive this panel wrote for `key` (UNLOCK's half of the lock toggle).
  // A line the user has already edited out is simply forgotten — never re-removed.
  const clearSectionDirective = (key: string) => {
    const previous = sectionDirectivesRef.current.get(key);
    sectionDirectivesRef.current.delete(key);
    if (previous === undefined) return;
    const prompt = readPromptText();
    if (prompt === null) return;
    const without = removePromptLine(prompt, previous);
    if (without === null) return;
    writePromptText(without);
  };

  // Single-turn API: section edits are prompt directives + a fresh generation. The
  // range in every directive comes from the REAL detected section of the active
  // version's audio (buildTimelineSections above) — never from an invented layout.
  const handleSectionAction = (action: 'regenerate' | 'extend' | 'restyle' | 'replace') => {
    const sec = selectedSection;
    if (!sec) return;
    const range = `${formatSeconds(sec.startSeconds)} - ${formatSeconds(sec.endSeconds)}`;
    const name = sec.name || 'section';
    const directives: Record<string, string> = {
      regenerate: `[${range}] ${name}: generate a new variation of this section`,
      extend: `[${range}] ${name}: extend this section into a longer arrangement`,
      restyle: `[${range}] ${name}: restyle with new texture and instrumentation`,
      replace: `[${range}] ${name}: replace with a contrasting section`,
    };
    writeSectionDirective(directiveKey(action, name, range), directives[action]);
    generateNewVersion();
  };

  // LOCK and UNLOCK are symmetrical: locking writes the keep-as-is directive, unlocking
  // takes that exact line back out, so a lock/unlock round trip leaves the prompt as it
  // was found.
  const toggleLockSection = () => {
    const sec = selectedSection;
    if (sec === undefined || selectedSectionIdx === null) return;
    const key = lockKeyFor(selectedSectionIdx);
    const next = !lockedSections[key];
    setLockedSections(prev => ({ ...prev, [key]: next }));
    const range = `${formatSeconds(sec.startSeconds)} - ${formatSeconds(sec.endSeconds)}`;
    const name = sec.name || 'section';
    const promptKey = directiveKey('lock', name, range);
    if (next) {
      writeSectionDirective(promptKey, `[${range}] ${name}: locked — keep exactly as is`);
    } else {
      clearSectionDirective(promptKey);
    }
  };

  const generateNewVersion = () => {
    window.dispatchEvent(new CustomEvent('lyria-request-generate'));
  };

  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const handleStart = () => {
      // Cinematic generation state: arm auto-play for the batch's first arrival and
      // stamp <html> so CSS can dim the room around the orb (.lyria-dim-on-generate).
      autoPlayArmedRef.current = true;
      document.documentElement.classList.add('lyria-generating');
      if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage({ type: 'ACTION_START' }, '*');
      }
    };
    const handleEnd = () => {
      autoPlayArmedRef.current = false;
      document.documentElement.classList.remove('lyria-generating');
      if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage({ type: 'ACTION_END' }, '*');
      }
    };

    window.addEventListener('lyria-action-start', handleStart);
    window.addEventListener('lyria-action-end', handleEnd);

    return () => {
      window.removeEventListener('lyria-action-start', handleStart);
      window.removeEventListener('lyria-action-end', handleEnd);
      document.documentElement.classList.remove('lyria-generating');
    };
  }, []);


  return (
    <div className="flex-1 flex flex-col overflow-y-auto min-w-0 bg-lyria-bg">
     {/* Singleton context-menu host — mounted once here since CenterPanel itself is
         rendered exactly once at the app root; every showContextMenu() call from
         anywhere in the tree (this file, SidebarRight) portals into this instance. */}
     <ContextMenuHost />
     <div className="w-full max-w-[1600px] mx-auto flex-1 flex flex-col gap-4 p-4 min-h-0">

      {/* Main row: visualizer strip + timeline | creation rail (right) */}
      <div className="flex-1 flex flex-row-reverse gap-4 min-h-0 min-w-0">

        {/* Right rail: prompt / lyrics / references / generate / export */}
        <div className="w-[320px] flex-shrink-0 flex flex-col gap-3 min-h-0">
          <SidebarLeft />

          {/* Export — fed the active version's own title and generation id so a renamed
              track downloads under its real name instead of a bare lyria-vN file. */}
          <ExportPanel
            version={activeVersion}
            model={modelName}
            audioUrl={activeVersionData?.audioUrl ?? null}
            fileFormat={activeVersionData?.format ?? null}
            title={activeVersionData?.title ?? null}
            versionId={activeVersionData?.id ?? null}
          />

          <div className="flex-1" />
        </div>

        {/* Left side: visualizer strip + timeline */}
        <div className="flex-1 flex flex-col gap-4 min-w-0 min-h-0">

        {/* Top strip: Tools & History | Visualization */}
        <div className="h-[450px] shrink-0 flex flex-row-reverse gap-4 min-w-0">

        {/* Center: Visualization & Metadata */}
        <div className="flex-1 min-w-0 bg-lyria-panel rounded-2xl border border-lyria-border flex relative overflow-hidden lyria-breathe-glow">
        
        {/* Central Visualization (Approximation) */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {/* Subtle background glow */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(214,180,133,0.15)_0%,transparent_60%)]"></div>
          
          {/* Central Visualization */}
          <div className="absolute inset-0 w-full h-full flex items-center justify-center opacity-100 mix-blend-screen pointer-events-auto">
             <iframe 
               ref={iframeRef}
               src="/brain-visualizer.html" 
               className="absolute inset-0 w-full h-full border-0 pointer-events-none"
               title="Brain Visualizer"
             />
             {/* Inner glowing core */}
             <div className="absolute w-32 h-32 bg-[radial-gradient(circle_at_center,rgba(214,180,133,0.4)_0%,transparent_70%)] blur-md rounded-full mix-blend-screen z-10 pointer-events-none"></div>
             <div className="absolute w-16 h-16 bg-white/20 blur-xl rounded-full mix-blend-screen z-20 pointer-events-none"></div>
          </div>
        </div>

        {/* Left Stats — ANALYSIS: real per-track audio analysis for the active version.
            Placeholder versions (no audioUrl) render nothing here. Versions with audio but
            no analysis yet show a single ANALYZE button; once analysis exists, real values
            only — bpm/key render nothing when null rather than inventing a number. */}
        {activeVersionData?.audioUrl && (
          <div key={`${activeVersionData.id ?? 'none'}-${activeVersionData.analysis ? 'analyzed' : 'raw'}`} className="absolute left-0 top-0 bottom-0 w-48 p-6 flex flex-col justify-center gap-4 z-10 overflow-y-auto lyria-dim-on-generate">
            {activeVersionData.analysis ? (
              <>
                {/* Badges cascade in one-by-one when the analysis lands (keyed remount above) —
                    the app audibly "listening to its own output" moment. */}
                <div className="lyria-cascade-in" style={{ '--cascade-i': 0 } as React.CSSProperties}>
                  <span title="Detected genre from the real audio analysis" className="text-[9px] text-lyria-text-muted uppercase tracking-[0.2em] block mb-1">GENRE</span>
                  <span className="text-xs text-lyria-text-main font-medium leading-snug block opacity-90">{activeVersionData.analysis.genre}</span>
                </div>
                <div className="lyria-cascade-in" style={{ '--cascade-i': 1 } as React.CSSProperties}>
                  <span title="Detected mood from the real audio analysis" className="text-[9px] text-lyria-text-muted uppercase tracking-[0.2em] block mb-1">MOOD</span>
                  <span className="text-xs text-lyria-text-main font-medium leading-snug block opacity-90">{activeVersionData.analysis.mood}</span>
                </div>
                <div className="lyria-cascade-in" style={{ '--cascade-i': 2 } as React.CSSProperties}>
                  <span title="Detected energy level from the real audio analysis" className="text-[9px] text-lyria-text-muted uppercase tracking-[0.2em] block mb-1">ENERGY</span>
                  <span className="text-sm text-lyria-text-main font-medium">{activeVersionData.analysis.energy}%</span>
                  <div className="w-full h-1 rounded-full bg-[#2b2521] mt-1.5 overflow-hidden">
                    <div className="h-full bg-lyria-gold rounded-full" style={{ width: `${Math.max(0, Math.min(100, activeVersionData.analysis.energy))}%` }}></div>
                  </div>
                </div>
                {activeVersionData.analysis.bpm !== null && (
                  <div className="lyria-cascade-in" style={{ '--cascade-i': 3 } as React.CSSProperties}>
                    <span title="Detected tempo (beats per minute) from the real audio analysis" className="text-[9px] text-lyria-text-muted uppercase tracking-[0.2em] block mb-1">BPM</span>
                    <span className="text-sm text-lyria-text-main font-mono">{activeVersionData.analysis.bpm}</span>
                  </div>
                )}
                {activeVersionData.analysis.key !== null && (
                  <div className="lyria-cascade-in" style={{ '--cascade-i': 4 } as React.CSSProperties}>
                    <span title="Detected musical key from the real audio analysis" className="text-[9px] text-lyria-text-muted uppercase tracking-[0.2em] block mb-1">KEY</span>
                    <span className="text-sm text-lyria-text-main font-mono">{activeVersionData.analysis.key}</span>
                  </div>
                )}
                {activeVersionData.analysis.instrumentation.length > 0 && (
                  <div className="lyria-cascade-in" style={{ '--cascade-i': 5 } as React.CSSProperties}>
                    <span title="Instruments detected from the real audio analysis" className="text-[9px] text-lyria-text-muted uppercase tracking-[0.2em] block mb-1">INSTRUMENTATION</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {activeVersionData.analysis.instrumentation.map((inst) => (
                        <span key={inst} className="px-1.5 py-[1px] rounded text-[8px] text-lyria-text-muted bg-white/5 border border-[#2b2521]">{inst}</span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col gap-2 pointer-events-auto">
                <button
                  onClick={() => activeVersionData.id && handleAnalyze(activeVersionData.id)}
                  disabled={!activeVersionData.id || analyzingId === activeVersionData.id}
                  title={`Run real audio analysis on this generation${analysisProviderLabel ? ` via ${analysisProviderLabel}` : ''} — one paid call, pennies, cached forever`}
                  className="flex items-center gap-2 px-3 py-1.5 text-[8px] tracking-widest text-lyria-gold bg-gradient-to-b from-[#1d1816] to-[#14110f] hover:from-[#2b2521] hover:to-[#1d1816] border border-lyria-gold/40 rounded-lg transition-all duration-150 shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_2px_5px_rgba(0,0,0,0.3)] active:scale-[0.98] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed lyria-focus-ring w-fit"
                >
                  {analyzingId === activeVersionData.id ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    <Sparkles size={10} className="opacity-70" />
                  )}
                  {analyzingId === activeVersionData.id ? 'ANALYZING…' : 'ANALYZE'}
                </button>
                {/* Names the provider the call will really route to (Settings choice, or
                    the server default) — never a hardcoded one. */}
                <span className="text-[8px] text-lyria-text-muted tracking-wide">{analysisProviderLabel ? `${analysisProviderLabel} · pennies per track` : 'pennies per track'}</span>
                {analysisError?.id === activeVersionData.id && (
                  <span className="text-[8px] text-lyria-signal tracking-wide">{analysisError.message}</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Right Stats — the ACTIVE VERSION's own recorded values (measured duration,
            manifest model id), not the current chip settings. Nothing known → an em dash;
            a duration is never inferred from the requested target. */}
        <div className="absolute right-0 top-0 bottom-0 w-48 p-6 flex flex-col justify-center items-end text-right gap-4 z-10 pointer-events-none lyria-dim-on-generate">
          <div>
            <span className="text-[9px] text-lyria-text-muted uppercase tracking-[0.2em] block mb-1">DURATION</span>
            <span
              title={activeDurationLabel
                ? 'Measured length of the active version’s audio file'
                : activeVersionData
                  ? 'This version’s manifest carries no measured duration'
                  : 'No version loaded yet'}
              className="text-sm text-lyria-text-main font-mono"
            >{activeDurationLabel ?? '—'}</span>
          </div>
          <div>
            <span className="text-[9px] text-lyria-text-muted uppercase tracking-[0.2em] block mb-1">MODEL</span>
            <span
              title={activeModelLabel
                ? 'The model that actually generated the active version'
                : activeVersionData
                  ? 'This version’s manifest records no model id'
                  : 'No version loaded yet'}
              className="text-xs text-lyria-text-main font-mono opacity-80"
            >{activeModelLabel ?? '—'}</span>
          </div>
        </div>
        </div>

        {/* Right column: tools / history / DAW dropzone */}
        <SidebarRight />
      </div>

      {/* Bottom Section: Timeline & Stems */}
      <div className="flex-1 bg-[#110e0c] rounded-xl border border-lyria-border flex flex-col overflow-hidden relative shadow-[inset_0_2px_10px_rgba(0,0,0,0.5)] lyria-dim-on-generate">
        
        {/* Unified Header */}
        <div className="h-10 border-b border-[#2b2521] flex items-center shrink-0 bg-[#161311] w-full">
           <div className="flex-1 flex items-center px-4 justify-between">
              {/* Version tabs — one per generation */}
              <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto">
                <span className="font-display text-[8px] text-lyria-text-muted uppercase tracking-widest mr-1 shrink-0">VERSIONS</span>
                {/* One tab per real generation in this project — no seeded tabs, so the
                    first take of a new project is V1 and stays V1 across a reload. */}
                {versions.length === 0 && (
                  <span className="text-[9px] text-lyria-text-muted tracking-wide shrink-0">none yet</span>
                )}
                {versions.map((v) => (
                  renamingVersionId !== null && v.id === renamingVersionId ? (
                    <input
                      key={v.n}
                      ref={renameInputRef}
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); void commitRenameVersion(v); }
                        if (e.key === 'Escape') { e.preventDefault(); setRenamingVersionId(null); }
                      }}
                      onBlur={() => void commitRenameVersion(v)}
                      aria-label={`Rename version ${v.n}`}
                      className="h-6 w-32 shrink-0 rounded px-1.5 text-[9px] font-display tracking-wider text-lyria-text-main bg-black/60 border border-lyria-gold/40 outline-none focus:border-lyria-gold transition-colors duration-150"
                    />
                  ) : (
                  <button
                    key={v.n}
                    onClick={() => setActiveVersion(v.n)}
                    onContextMenu={(e) => openVersionTabMenu(e, v)}
                    title={v.audioUrl ? `${v.title ? `${v.title} — ` : ''}Switch to version ${v.n} — click Play to hear it${v.provider ? ` (${v.provider})` : ''} — right-click for more actions` : `Switch to version ${v.n} — no audio attached`}
                    aria-pressed={activeVersion === v.n}
                    className={`h-6 px-2.5 rounded flex items-center gap-1 shrink-0 text-[9px] font-display tracking-wider border transition-all duration-150 active:scale-95 cursor-pointer lyria-focus-ring ${
                      activeVersion === v.n
                        ? 'border-lyria-gold/60 bg-lyria-gold/10 text-lyria-gold shadow-[0_0_8px_rgba(214,180,133,0.15)]'
                        : 'border-transparent text-[#8b837c] hover:text-lyria-text-main hover:bg-white/5'
                    } ${freshVersions.includes(v.n) ? 'animate-pulse' : ''}`}
                  >
                    V{v.n}
                    {v.provider === 'mock' && (
                      <span title="Simulated placeholder audio — not a real Lyria generation" className="px-1 rounded text-[6px] font-semibold tracking-wider bg-white/10 text-[#8b837c]">MOCK</span>
                    )}
                  </button>
                  )
                ))}
                <button
                  onClick={generateNewVersion}
                  title="Generate a new version (paid)"
                  aria-label="Generate a new version (paid)"
                  className="h-6 w-6 rounded flex items-center justify-center shrink-0 text-[#8b837c] hover:text-lyria-gold border border-dashed border-[#2b2521] hover:border-lyria-gold/40 transition-colors duration-150 active:scale-95 cursor-pointer lyria-focus-ring"
                >
                  <Plus size={10} />
                </button>
              </div>

              {/* Zoom Controls */}
              <div className="flex items-center gap-3">
                 <button title="Zoom out the timeline" aria-label="Zoom out the timeline" className="text-[#8b837c] hover:text-lyria-text-main transition-colors duration-150 active:scale-95 cursor-pointer rounded lyria-focus-ring" onClick={() => setZoom(z => Math.max(0.2, z - 0.2))}><ZoomOut size={12} /></button>
                 <span title="Current timeline zoom level" className="text-[9px] font-mono text-[#8b837c] w-8 text-center">{Math.round(zoom * 100)}%</span>
                 <button title="Zoom in the timeline" aria-label="Zoom in the timeline" className="text-[#8b837c] hover:text-lyria-text-main transition-colors duration-150 active:scale-95 cursor-pointer rounded lyria-focus-ring" onClick={() => setZoom(z => Math.min(3, z + 0.2))}><ZoomIn size={12} /></button>
              </div>
           </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex min-h-0 relative">
        
          {/* Left Side: Permanent Inspector */}
          <div className="w-48 shrink-0 bg-[#161311] border-r border-[#2b2521] flex flex-col z-30">

          <div className="flex items-center justify-between p-3 pb-2 border-b border-[#2b2521]/50 bg-gradient-to-b from-transparent to-black/20">
             <div>
               <span className="font-display text-[9px] text-lyria-gold font-medium tracking-widest block drop-shadow-[0_0_8px_rgba(214,180,133,0.5)]">{(selectedSection?.name || 'SECTION').toUpperCase()} INSPECTOR</span>
               <span className="text-[8px] text-lyria-text-muted font-mono mt-1">{selectedSection ? selectedSection.rangeLabel : 'detected from the real audio'}</span>
             </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 pt-2 flex flex-col gap-3">
             {selectedSection && selectedSectionIdx !== null ? (
             <div className="flex flex-col gap-2">
                <span className="font-display text-[8px] text-lyria-text-muted tracking-widest uppercase mb-0.5 ml-1">Actions</span>

                <button onClick={() => handleSectionAction('regenerate')} title="Writes a section directive into the prompt and generates a new version (paid)" className="flex items-center gap-2 px-3 py-1.5 text-[8px] tracking-widest text-lyria-text-main bg-gradient-to-b from-[#1d1816] to-[#14110f] hover:from-[#2b2521] hover:to-[#1d1816] hover:text-lyria-gold border border-[#2b2521] rounded-lg transition-all duration-150 shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_2px_5px_rgba(0,0,0,0.3)] active:scale-[0.98] cursor-pointer lyria-focus-ring">
                  <RefreshCcw size={10} className="opacity-70 text-lyria-gold" /> REGENERATE
                </button>
                <button onClick={() => handleSectionAction('extend')} title="Writes a section directive into the prompt and generates a new version (paid)" className="flex items-center gap-2 px-3 py-1.5 text-[8px] tracking-widest text-lyria-text-main bg-gradient-to-b from-[#1d1816] to-[#14110f] hover:from-[#2b2521] hover:to-[#1d1816] hover:text-lyria-gold border border-[#2b2521] rounded-lg transition-all duration-150 shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_2px_5px_rgba(0,0,0,0.3)] active:scale-[0.98] cursor-pointer lyria-focus-ring">
                  <Maximize2 size={10} className="opacity-70 text-lyria-gold" /> EXTEND
                </button>
                <button onClick={() => handleSectionAction('restyle')} title="Writes a section directive into the prompt and generates a new version (paid)" className="flex items-center gap-2 px-3 py-1.5 text-[8px] tracking-widest text-lyria-text-main bg-gradient-to-b from-[#1d1816] to-[#14110f] hover:from-[#2b2521] hover:to-[#1d1816] hover:text-lyria-gold border border-[#2b2521] rounded-lg transition-all duration-150 shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_2px_5px_rgba(0,0,0,0.3)] active:scale-[0.98] cursor-pointer lyria-focus-ring">
                  <Sparkles size={10} className="opacity-70 text-lyria-gold" /> RESTYLE
                </button>
                <button onClick={() => handleSectionAction('replace')} title="Writes a section directive into the prompt and generates a new version (paid)" className="flex items-center gap-2 px-3 py-1.5 text-[8px] tracking-widest text-lyria-text-main bg-gradient-to-b from-[#1d1816] to-[#14110f] hover:from-[#2b2521] hover:to-[#1d1816] hover:text-lyria-gold border border-[#2b2521] rounded-lg transition-all duration-150 shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_2px_5px_rgba(0,0,0,0.3)] active:scale-[0.98] cursor-pointer lyria-focus-ring">
                  <RefreshCcw size={10} className="rotate-180 opacity-70 text-lyria-gold" /> REPLACE
                </button>

                <div className="h-px bg-gradient-to-r from-transparent via-[#2b2521] to-transparent my-1"></div>

                <button onClick={toggleLockSection} title="Pins this section's prompt text — appends a keep-as-is directive" aria-pressed={!!lockedSections[lockKeyFor(selectedSectionIdx)]} className={`flex items-center justify-center gap-2 px-3 py-1.5 text-[8px] tracking-widest transition-colors duration-150 active:scale-[0.98] cursor-pointer rounded lyria-focus-ring ${lockedSections[lockKeyFor(selectedSectionIdx)] ? 'text-lyria-gold' : 'text-[#8b837c] hover:text-white'}`}>
                  <Lock size={10} className="opacity-70" /> {lockedSections[lockKeyFor(selectedSectionIdx)] ? 'UNLOCK SECTION' : 'LOCK SECTION'}
                </button>
             </div>
             ) : (
               <span className="text-[8px] leading-relaxed tracking-wide text-lyria-text-muted px-1">
                 {timelineSections.length > 0
                   ? 'Click a detected section in the timeline to inspect and direct it.'
                   : activeVersionData
                     ? 'Sections appear once this version’s audio has been analyzed.'
                     : 'Generate a version, then analyze it, to map its sections.'}
               </span>
             )}

             {/* Real sung lyrics for the active version, when present — the actual paid-for
                 output of a generation, surfaced read-only rather than left with nowhere to show. */}
             {activeLyrics && (
               <div className="flex flex-col gap-1.5">
                 <span title="The actual sung lyrics returned by this generation, with the provider's structural and timing markup stripped" className="text-[8px] text-lyria-text-muted tracking-widest uppercase mb-0.5 ml-1">Lyrics</span>
                 <div className="max-h-40 overflow-y-auto rounded-lg border border-[#2b2521] bg-[#0d0a08] p-2">
                   <pre className="text-[9px] leading-relaxed text-lyria-text-main/80 font-mono whitespace-pre-wrap break-words">{activeLyrics}</pre>
                 </div>
               </div>
             )}

             {/* The timeline header above now renders the detected structure directly —
                 no duplicate read-only list needed here. */}
          </div>
        </div>

        {/* Right Side: Timeline & Stems Content */}
        <div className="flex-1 flex flex-col min-w-0 relative bg-lyria-bg/50">
          
          <div className="flex-1 overflow-y-auto overflow-x-hidden relative flex">
             {versions.length === 0 ? (
             /* Nothing has been generated in this project yet, so there is no audio,
                no waveform and no structure to draw. Say so plainly instead of seeding
                empty tabs and a flat placeholder lane. */
             <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
               <span className="font-display text-[10px] text-lyria-text-muted uppercase tracking-[0.3em]">No versions yet</span>
               <span className="text-[9px] leading-relaxed tracking-wide text-lyria-text-muted max-w-[360px]">
                 Write a prompt in the rail on the right and press GENERATE. The first take lands here as V1, with its real waveform — analyze it to map its structure.
               </span>
             </div>
             ) : (
             <>

             {/* Tracks Headers (Fixed on left) */}
             <div className="w-[180px] shrink-0 border-r border-[#222] bg-[#14110f] z-20 flex flex-col pt-12">
               {/* Stem sub-rows auto-populate from version.stems when a backend supplies
                   real stems; never render stem rows without data. Today the server only ever
                   returns a single mixed master, so this is just the MASTER cell. */}
               <div className="flex-1 border-b border-[#222] flex items-center justify-between px-3">
                 <span className="font-display text-[10px] text-lyria-text-main font-semibold tracking-wider">MASTER</span>
               </div>
               {activeStems.map((stem) => (
                 <div key={stem.name} className="flex-1 border-b border-[#222] flex items-center justify-between pl-6 pr-3">
                   <span className="text-[9px] text-[#8b837c] font-medium tracking-wider">{stem.name}</span>
                 </div>
               ))}
             </div>

             {/* Tracks Content (Scrollable horizontally and vertically synced) */}
             <div 
                className="flex-1 overflow-x-auto overflow-y-hidden relative flex flex-col"
                onWheel={(e) => {
                   // Always zoom on wheel since there's no vertical scrolling needed
                   setZoom(prev => Math.min(Math.max(0.2, prev - e.deltaY * 0.005), 3));
                }}
             >
                {/* Grid and Section Highlight Overlay — real detected sections only */}
                <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-20 flex" style={{ width: `${1000 * zoom}px`, minWidth: '100%' }}>
                  {timelineSections.map((sec, i) => {
                    const isSelected = selectedSectionIdx === i;
                    const isPlayingSection = playingSectionIdx === i;
                    return (
                      <div key={`${sec.startSeconds}-${i}`} className={`relative h-full border-r border-white/5 ${isSelected ? 'bg-[#b5926c]/[0.02]' : ''} ${isPlayingSection ? 'bg-lyria-gold/[0.04]' : ''}`} style={{ width: `${sec.widthPct}%` }}>
                        {isSelected && (
                          <div className="absolute top-0 bottom-0 left-0 right-0 border-x border-[#b5926c] pointer-events-none">
                            <div className="absolute top-0 left-0 right-0 h-px bg-[#b5926c]"></div>
                            <div className="absolute bottom-0 left-0 right-0 h-px bg-[#b5926c]"></div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Sections Header — structure DETECTED from the active version's real audio
                    (Analysis.sections scaled by the measured duration). Cells cascade in when
                    an analysis lands (keyed remount) and the playhead lights up the section
                    it is currently inside. No analysis → an honest empty/'listening' bar. */}
                <div
                  key={`${activeVersionData?.id ?? 'none'}-${timelineSections.length}`}
                  className="h-12 border-b border-[#2b2521] bg-[#14110f] flex shrink-0 sticky top-0 z-10 transition-all duration-300"
                  style={{ width: `${1000 * zoom}px`, minWidth: '100%' }}
                >
                  {timelineSections.length > 0 ? timelineSections.map((sec, i) => {
                     const isSelected = selectedSectionIdx === i;
                     const isPlayingSection = playingSectionIdx === i;
                     if (sec.isGap) {
                       return (
                         <div
                           key={`${sec.startSeconds}-${i}`}
                           title={`Unmapped audio — ${sec.rangeLabel}`}
                           className="border-r border-[#2b2521] flex items-center justify-center text-[9px] text-[#4a443f] font-mono lyria-cascade-in"
                           style={{ width: `${sec.widthPct}%`, '--cascade-i': i } as React.CSSProperties}
                         >···</div>
                       );
                     }
                     return (
                       <div
                         key={`${sec.startSeconds}-${i}`}
                         role="button"
                         tabIndex={0}
                         onClick={() => setSelectedSectionIdx(i)}
                         onKeyDown={(e) => {
                           if (e.key === 'Enter' || e.key === ' ') {
                             e.preventDefault();
                             setSelectedSectionIdx(i);
                           }
                         }}
                         title={`Detected from the real audio — click to inspect ${sec.name}`}
                         aria-label={`Inspect ${sec.name} section (${sec.rangeLabel})`}
                         className={`border-r border-[#2b2521] p-1.5 px-3 flex flex-col justify-center relative cursor-pointer hover:bg-white/5 transition-colors duration-150 lyria-focus-ring lyria-cascade-in ${
                           isSelected ? 'bg-gradient-to-b from-[#2a231d] to-[#14110f] text-[#b5926c]'
                           : isPlayingSection ? 'bg-lyria-gold/5 text-lyria-gold'
                           : 'text-[#8b837c]'
                         }`}
                         style={{ width: `${sec.widthPct}%`, '--cascade-i': i } as React.CSSProperties}
                       >
                         <span className={`font-display text-[9px] font-bold tracking-widest truncate uppercase ${isPlayingSection ? 'drop-shadow-[0_0_6px_rgba(214,180,133,0.6)]' : ''}`}>{sec.name}</span>
                         <span className="text-[8px] font-mono mt-0.5 truncate">{sec.rangeLabel}</span>
                         {lockedSections[lockKeyFor(i)] && <Lock size={8} className="absolute top-1.5 right-1.5 text-lyria-gold/70" />}
                       </div>
                     );
                  }) : (
                    <div className="flex-1 flex items-center px-3">
                      {activeVersionData?.id && analyzingId === activeVersionData.id ? (
                        <span className="font-display text-[8px] tracking-[0.3em] uppercase text-lyria-gold/80 animate-pulse">Listening — detecting structure…</span>
                      ) : activeVersionData?.audioUrl ? (
                        <span className="font-display text-[8px] tracking-[0.3em] uppercase text-[#4a443f]">No structure mapped — ANALYZE detects sections from the audio</span>
                      ) : null}
                    </div>
                  )}
                </div>

                {/* Waveform Lanes: always MASTER, plus one sub-row per version.stems entry. */}
                {/* Stem sub-rows auto-populate from version.stems when a backend supplies
                    real stems; never render stem rows without data. Lyria today returns only a
                    single mixed master, so with no stems this is just the one MASTER lane. */}
                <div className="flex-1 flex flex-col relative transition-all duration-300" style={{ width: `${1000 * zoom}px`, minWidth: '100%' }}>
                   <div
                     className={`flex-1 relative flex items-center ${activeStems.length === 0 ? 'min-h-[150px]' : 'min-h-[120px]'}`}
                     onContextMenu={(e) => activeVersionData && openWaveformLaneMenu(e, activeVersionData)}
                     title="Right-click to seek, analyze, or export this version"
                   >
                      <div className="absolute inset-y-1.5 inset-x-0 rounded-md overflow-hidden border border-white/5 bg-[#14110f]/30">
                         <Waveform key={`v${activeVersion}`} color="#b5926c" opacity={0.9} bars={400 * zoom} peaks={activePeaks} />
                      </div>
                   </div>
                   {activeStems.map((stem) => (
                     <div key={stem.name} className="flex-1 min-h-[44px] relative flex items-center">
                        <div className="absolute inset-y-1.5 inset-x-0 rounded-md overflow-hidden border border-white/5 bg-[#14110f]/30">
                           <Waveform key={`v${activeVersion}-${stem.name}`} color="#b5926c" opacity={0.55} bars={200 * zoom} peaks={stemPeaks[stem.name] ?? null} />
                        </div>
                     </div>
                   ))}
                </div>
             </div>
             </>
             )}
          </div>
        </div>
        </div>
        </div>
      </div>
      </div>
     </div>
    </div>
  );
}