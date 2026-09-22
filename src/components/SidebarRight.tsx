import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, MicOff, FileText, Trash2 } from 'lucide-react';
import { listGenerations, renameGeneration, type GenerationEntry } from '../lib/lyriaClient';
import { stripProviderLyricMarkup } from '../lib/lyricsText';
import { showContextMenu } from './ContextMenu';

// Only operations the single-turn Lyria 3 API can honor.
// 'style' = the user types a style change, it is appended to the prompt editor
// (visible and undoable) and a new version is generated from that exact text.
const TOOLS = [
  { id: 2, label: 'CHANGE STYLE', desc: 'Type a style change — it is added to your prompt, then a new version is generated from it (paid: $0.08 Pro / $0.04 Clip)', Icon: Sparkles, action: 'style' as const },
  { id: 4, label: 'EDIT LYRICS', desc: 'Opens and pins the lyrics editor', Icon: FileText, action: 'lyrics' as const },
  { id: 5, label: 'INSTRUMENTAL', desc: 'Adds an instrumental-only instruction and generates a new version (paid: $0.08 Pro / $0.04 Clip)', Icon: MicOff, action: 'instrumental' as const },
];

// HISTORY rows the user dismissed ("Remove from list" / CLEAR). Kept in localStorage
// so a dismissal survives a reload — it is a per-browser view preference only:
// nothing is ever deleted from the server or from disk, and RESTORE brings every
// hidden row back.
const HIDDEN_GENERATIONS_KEY = 'lyria_hidden_generations';

function readHiddenIds(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_GENERATIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // Unreadable or unparseable storage must never break the history list.
    return [];
  }
}

function writeHiddenIds(ids: string[]): void {
  try { localStorage.setItem(HIDDEN_GENERATIONS_KEY, JSON.stringify(ids)); } catch { /* storage unavailable */ }
}

interface HistoryItem {
  id: string | number;
  title: string;
  desc: string;
  time: string;
  type: string;
  isActive: boolean;
  isMock: boolean;
  payload?: GenerationEntry | Record<string, unknown>;
}

// Shortens e.g. "google/lyria-3-pro-preview" / "lyria-3-clip-preview" -> "LYRIA 3 PRO" for the desc line.
function modelShortName(model: string | undefined): string {
  if (!model) return 'lyria';
  const stripped = model.split('/').pop() ?? model;
  const m = stripped.match(/lyria-?(\d)?-?(pro|clip)?/i);
  if (!m) return stripped;
  const [, ver, variant] = m;
  return `LYRIA${ver ? ` ${ver}` : ''}${variant ? ` ${variant.toUpperCase()}` : ''}`.trim();
}

// Line-2 short model tag: "PRO" / "CLIP", falling back to the first word of
// modelShortName's output for anything else an older manifest may carry.
function modelShortTag(model: string | undefined): string {
  const full = modelShortName(model);
  if (/CLIP/i.test(full)) return 'CLIP';
  if (/PRO/i.test(full)) return 'PRO';
  return full.split(' ')[0] || 'LYRIA';
}

function truncate(text: string | undefined, max = 40): string {
  const t = (text ?? '').trim();
  if (!t) return 'Untitled generation';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// mm:ss from a real duration in seconds (GenerationEntry.durationSeconds may be absent on
// older manifests — callers must treat undefined as "unknown", never 0:00).
function formatDuration(seconds: number | undefined): string | null {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Short date for line 2: "16:41" if generatedAt is today, else "Jul 14".
function formatShortDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (isToday) {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Builds the line-2 metadata string: "PRO · gemini · 2:14 · 16:41" — each segment
// omitted individually when its underlying data isn't present yet.
function buildMetaLine(entry: { model?: string; provider?: string; durationSeconds?: number; generatedAt?: string }): string {
  const parts: string[] = [];
  if (entry.model) parts.push(modelShortTag(entry.model));
  if (entry.provider) parts.push(entry.provider);
  const dur = formatDuration(entry.durationSeconds);
  if (dur) parts.push(dur);
  const date = formatShortDate(entry.generatedAt);
  if (date) parts.push(date);
  return parts.join(' · ');
}

// Line-1 title precedence: manifest title > analysis.title > truncated prompt.
function resolveTitle(entry: { title?: string; analysis?: { title?: string }; prompt?: string }): string {
  if (entry.title && entry.title.trim()) return entry.title.trim();
  if (entry.analysis?.title && entry.analysis.title.trim()) return entry.analysis.title.trim();
  return truncate(entry.prompt);
}

// lyria-3-pro-preview -> 'LYRIA 3 PRO', lyria-3-clip-preview -> 'LYRIA 3 CLIP' — matches
// SidebarLeft's MODEL_OPTIONS labels, for the 'lyria-load-params' dispatch's `model` field.
// Exported: CenterPanel's version-tab "Load settings" action shares this exact mapping.
export function modelIdToLabel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (/clip/i.test(model)) return 'LYRIA 3 CLIP';
  if (/lyria-3-pro/i.test(model) || /pro/i.test(model)) return 'LYRIA 3 PRO';
  return undefined;
}

// Maps library entries to HISTORY rows, dropping the ones the user has hidden.
function toHistoryItems(entries: GenerationEntry[], hidden: string[]): HistoryItem[] {
  const hiddenSet = new Set(hidden);
  return entries
    .filter(entry => !hiddenSet.has(String(entry.id)))
    .map(entry => ({
      id: entry.id,
      title: resolveTitle(entry),
      desc: buildMetaLine(entry),
      time: '',
      type: 'audio',
      isActive: false,
      isMock: entry.provider === 'mock',
      payload: entry,
    }));
}

export function SidebarRight() {
  const [activeTool, setActiveTool] = useState<number | null>(null);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  // Ids hidden from this list (persisted per browser — see HIDDEN_GENERATIONS_KEY).
  const [hiddenIds, setHiddenIds] = useState<string[]>(() => readHiddenIds());
  // CHANGE STYLE's inline instruction input.
  const [isStyleOpen, setIsStyleOpen] = useState(false);
  const [styleInput, setStyleInput] = useState('');
  const styleInputRef = useRef<HTMLInputElement>(null);
  // Row currently swapped to an inline rename input (id of the HistoryItem, or null).
  const [renamingId, setRenamingId] = useState<string | number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Hides one row and remembers it, so it stays hidden across reloads. The audio file
  // and its manifest are never touched — this only filters what this list shows.
  const removeHistoryItem = (id: string | number) => {
    const key = String(id);
    setHistoryItems(items => items.filter(item => item.id !== id));
    setHiddenIds(prev => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      writeHiddenIds(next);
      return next;
    });
  };

  // CLEAR — hides every row currently listed (same persistence, same "nothing is
  // deleted" guarantee as a single row's removal).
  const clearHistory = () => {
    const ids = historyItems.map(item => String(item.id));
    setHistoryItems([]);
    setHiddenIds(prev => {
      const next = [...new Set([...prev, ...ids])];
      writeHiddenIds(next);
      return next;
    });
  };

  // Undoes every dismissal and re-reads the library so the hidden rows reappear
  // without a reload.
  const restoreHiddenHistory = () => {
    setHiddenIds([]);
    writeHiddenIds([]);
    listGenerations()
      .then(entries => setHistoryItems(toHistoryItems(entries, [])))
      .catch(err => console.warn('Failed to reload generation history:', err));
  };

  const loadEntry = (payload: HistoryItem['payload']) => {
    if (!payload) return;
    window.dispatchEvent(new CustomEvent('lyria-load-generation', { detail: { payload } }));
  };

  // "Load with settings" — activates the version (same as a normal click) AND replays
  // its prompt/lyrics/model/language into the editors via 'lyria-load-params', which
  // SidebarLeft listens for (see applyLoadedValues there).
  const loadEntryWithSettings = (payload: HistoryItem['payload']) => {
    if (!payload) return;
    window.dispatchEvent(new CustomEvent('lyria-load-generation', { detail: { payload } }));
    const entry = payload as Partial<GenerationEntry>;
    // language / durationTarget / batchCount only exist on newer manifests — read them
    // defensively so an older manifest restores what it has and leaves the rest alone
    // (never undefined-over-a-real-value, never an invented default).
    const extra = entry as Record<string, unknown>;
    const language = typeof extra.language === 'string' ? extra.language : undefined;
    const durationTarget = typeof extra.durationTarget === 'string' ? extra.durationTarget : undefined;
    const batchCount = typeof extra.batchCount === 'number' ? extra.batchCount : undefined;
    window.dispatchEvent(new CustomEvent('lyria-load-params', {
      detail: {
        prompt: entry.prompt,
        // A manifest's lyrics are what the provider returned, which carries its own
        // structural/timing markup ([[A0]], [2.0:6.1], [:]). Strip it so the editor
        // gets readable lyrics; text that was already clean passes through unchanged.
        lyrics: entry.lyrics === undefined ? undefined : stripProviderLyricMarkup(entry.lyrics),
        model: modelIdToLabel(entry.model),
        ...(language ? { language } : {}),
        ...(durationTarget ? { durationTarget } : {}),
        ...(batchCount ? { batchCount } : {}),
      },
    }));
  };

  const beginRename = (item: HistoryItem) => {
    setRenamingId(item.id);
    setRenameValue(item.title);
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };

  const commitRename = async (item: HistoryItem) => {
    const nextTitle = renameValue.trim();
    setRenamingId(null);
    if (!nextTitle || nextTitle === item.title) return;
    const idStr = String(item.id);
    try {
      const updated = await renameGeneration(idStr, nextTitle);
      setHistoryItems(items => items.map(it => (
        it.id === item.id ? { ...it, title: resolveTitle(updated), payload: updated } : it
      )));
      window.dispatchEvent(new CustomEvent('lyria-generation-renamed', { detail: { id: idStr, title: updated.title ?? nextTitle } }));
    } catch (err) {
      // Silent-warn — the row simply keeps its previous title (the id/title was rejected
      // server-side or the request failed).
      console.warn('Failed to rename generation:', err);
    }
  };

  // Another row/tab renamed this generation (e.g. CenterPanel's version-tab rename) —
  // sync this row's title without a re-fetch.
  useEffect(() => {
    const handleRenamed = (e: Event) => {
      const { id, title } = (e as CustomEvent<{ id?: string; title?: string }>).detail ?? {};
      if (!id || !title) return;
      setHistoryItems(items => items.map(it => (
        String(it.id) === id ? { ...it, title } : it
      )));
    };
    window.addEventListener('lyria-generation-renamed', handleRenamed);
    return () => window.removeEventListener('lyria-generation-renamed', handleRenamed);
  }, []);

  const downloadEntry = (item: HistoryItem) => {
    const entry = item.payload as Partial<GenerationEntry> | undefined;
    const audioUrl = entry?.audioUrl;
    if (!audioUrl) return;
    const a = document.createElement('a');
    a.href = audioUrl;
    // Prefer the entry's own `format` field over parsing the URL (query strings break
    // `.split('.').pop()`), so the download always lands with a real extension.
    const ext = (entry?.format || audioUrl.split(/[?#]/)[0].split('.').pop() || 'wav').toLowerCase();
    a.download = `${item.title || 'track'}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const requestAnalysis = (item: HistoryItem) => {
    const id = (item.payload as Partial<GenerationEntry> | undefined)?.id ?? String(item.id);
    if (!id) return;
    // Activate the version first (same as a normal click) so CenterPanel's existing
    // ANALYZE flow has something active to run against, then ask it to analyze.
    loadEntry(item.payload);
    window.dispatchEvent(new CustomEvent('lyria-request-analysis', { detail: { id } }));
  };

  const openRowMenu = (e: React.MouseEvent, item: HistoryItem) => {
    showContextMenu(e, [
      { label: 'Load (audio only)', onClick: () => loadEntry(item.payload) },
      { label: 'Load with settings', onClick: () => loadEntryWithSettings(item.payload) },
      { label: 'Rename…', onClick: () => beginRename(item) },
      { label: 'Analyze', onClick: () => requestAnalysis(item) },
      { label: 'Download', onClick: () => downloadEntry(item), disabled: !(item.payload as Partial<GenerationEntry> | undefined)?.audioUrl },
      { label: 'Remove from list', onClick: () => removeHistoryItem(item.id), danger: true },
    ]);
  };

  // On mount, populate HISTORY from the persisted library (newest-first, per the API
  // contract), minus the rows the user dismissed in a previous session.
  useEffect(() => {
    let cancelled = false;
    listGenerations()
      .then(entries => {
        if (cancelled) return;
        setHistoryItems(toHistoryItems(entries, readHiddenIds()));
      })
      .catch(err => {
        console.warn('Failed to load generation history:', err);
        // keep empty list — no crash, no alert
      });
    return () => { cancelled = true; };
  }, []);

  // Real generations land at the top of HISTORY
  useEffect(() => {
    const handleGenerated = (e: Event) => {
      const payload = (e as CustomEvent).detail?.payload;
      const id = payload?.id ?? crypto.randomUUID();
      setHistoryItems(items => {
        // Dedupe by id — a fresh generation must not appear twice (e.g. if the library
        // fetch resolves after a live generation already landed, or vice versa).
        const withoutDupe = items.filter(item => item.id !== id);
        return [
          {
            id,
            title: resolveTitle(payload ?? {}) !== 'Untitled generation' ? resolveTitle(payload ?? {}) : 'Version generated',
            desc: buildMetaLine(payload ?? {}),
            time: '',
            type: 'audio',
            isActive: true,
            isMock: payload?.provider === 'mock',
            payload,
          },
          ...withoutDupe.map(item => ({ ...item, isActive: false })),
        ];
      });
    };
    window.addEventListener('lyria-generated', handleGenerated);
    return () => window.removeEventListener('lyria-generated', handleGenerated);
  }, []);

  // CenterPanel dispatches this once a real analysis completes for a version — the
  // analysis's invented track name is only adopted by rows that have no title of their
  // own. A user-supplied (or renamed) manifest title ALWAYS wins: analysis must never
  // overwrite what the user named their track.
  useEffect(() => {
    const handleAnalysis = (e: Event) => {
      const { id, analysis } = (e as CustomEvent).detail ?? {};
      if (!id || !analysis?.title) return;
      setHistoryItems(items => items.map(item => {
        if (item.id !== id) return item;
        const userTitle = (item.payload as Partial<GenerationEntry> | undefined)?.title;
        if (userTitle && userTitle.trim()) return item;
        return { ...item, title: analysis.title };
      }));
    };
    window.addEventListener('lyria-analysis', handleAnalysis);
    return () => window.removeEventListener('lyria-analysis', handleAnalysis);
  }, []);

  // CHANGE STYLE — the typed instruction is appended to the PROMPT editor first, so the
  // user sees the exact text the generation will use before a paid call is made, and can
  // undo it there like any other prompt edit.
  const submitStyleChange = () => {
    const instruction = styleInput.trim();
    if (!instruction) return;
    window.dispatchEvent(new CustomEvent('lyria-prompt-append', { detail: { text: instruction } }));
    window.dispatchEvent(new CustomEvent('lyria-request-generate'));
    setStyleInput('');
    setIsStyleOpen(false);
    setActiveTool(null);
  };

  const handleToolClick = (tool: typeof TOOLS[number]) => {
    setActiveTool(tool.id);

    if (tool.action === 'style') {
      // Opens the instruction input — nothing is generated (and nothing is charged)
      // until the user submits an actual style change.
      const next = !isStyleOpen;
      setIsStyleOpen(next);
      setActiveTool(next ? tool.id : null);
      if (next) setTimeout(() => styleInputRef.current?.focus(), 0);
      return;
    }

    if (tool.action === 'lyrics') {
      window.dispatchEvent(new CustomEvent('lyria-focus-lyrics'));
      setTimeout(() => setActiveTool(null), 600);
      return;
    }

    // Real generation path — SidebarLeft's flow emits action-start/end itself.
    // INSTRUMENTAL takes the vocals-off path for this one request: no lyrics are
    // sent and the directive goes into the request prompt only, so the user's
    // prompt box and VOCALS toggle are left exactly as they were.
    window.dispatchEvent(new CustomEvent('lyria-request-generate', {
      detail: { instrumental: tool.action === 'instrumental' },
    }));
    setTimeout(() => setActiveTool(null), 600);
  };

  return (
    <div className="w-[300px] flex-shrink-0 flex flex-col gap-2 min-h-0 lyria-dim-on-generate">

      {/* Tools Grid */}
      <div className="shrink-0 bg-[#110e0c]/85 backdrop-blur-lg rounded-xl border border-[#2b2521] p-3 flex flex-col gap-2 shadow-[0_4px_20px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)]">
        <span className="font-display text-[10px] text-lyria-text-muted uppercase tracking-widest font-medium" title="One-click actions that generate a new paid version">TOOLS</span>
        <div className="grid grid-cols-3 gap-1.5">
          {TOOLS.map((tool) => { const { id, label, desc, Icon } = tool; return (
            <button
              key={id}
              onClick={() => handleToolClick(tool)}
              title={desc}
              className={`h-9 px-2 rounded-lg border bg-gradient-to-b from-[#181513] to-[#110e0c] hover:from-[#1d1816] hover:to-[#14110f] flex items-center gap-2 transition-all duration-150 group shadow-[inset_0_1px_0_rgba(255,255,255,0.02),0_2px_5px_rgba(0,0,0,0.3)] active:scale-[0.98] cursor-pointer lyria-focus-ring ${
                activeTool === id ? 'border-lyria-gold/50' : 'border-[#2b2521]'
              }`}
            >
              <Icon size={12} className={`shrink-0 transition-colors duration-150 ${activeTool === id ? 'text-lyria-gold' : 'text-lyria-gold/70 group-hover:text-lyria-gold'}`} />
              <span className={`text-[8px] font-medium uppercase tracking-wider truncate transition-colors duration-150 ${activeTool === id ? 'text-lyria-gold' : 'text-lyria-text-main group-hover:text-lyria-gold'}`}>{label}</span>
            </button>
          ); })}
        </div>

        {/* CHANGE STYLE instruction — the text typed here is what gets added to the
            prompt and generated from, so the button can never send something the
            user did not see. */}
        {isStyleOpen && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <input
                ref={styleInputRef}
                type="text"
                value={styleInput}
                onChange={(e) => setStyleInput(e.target.value)}
                onKeyDown={(e) => {
                  // e.repeat / isComposing: a held Enter or an IME commit must not fire
                  // a second paid generation.
                  if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submitStyleChange();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setIsStyleOpen(false);
                    setActiveTool(null);
                  }
                }}
                placeholder="New style, e.g. slower, lo-fi, 90bpm"
                aria-label="Style change instruction"
                className="flex-1 min-w-0 bg-black/60 text-[10px] text-lyria-text-main px-2 py-1 rounded-lg border border-[#2b2521] outline-none focus:border-lyria-gold/50 placeholder-[#554e46] transition-colors duration-150"
              />
              <button
                onClick={submitStyleChange}
                disabled={!styleInput.trim()}
                title="Adds this line to your prompt, then generates a new version from it (paid: $0.08 Pro / $0.04 Clip)"
                className={`shrink-0 px-2 h-[22px] rounded-lg border text-[8px] font-medium uppercase tracking-wider transition-colors duration-150 lyria-focus-ring ${
                  styleInput.trim()
                    ? 'border-lyria-gold/50 text-lyria-gold hover:bg-lyria-gold/10 cursor-pointer'
                    : 'border-[#2b2521] text-lyria-text-muted cursor-not-allowed'
                }`}
              >
                APPLY
              </button>
            </div>
            <span className="text-[9px] text-lyria-text-muted leading-snug">
              Added to the end of your prompt, then generated — undo it in the prompt editor.
            </span>
          </div>
        )}
      </div>

      {/* History */}
      <div className="flex-1 min-h-0 bg-[#110e0c]/80 backdrop-blur-md rounded-xl border border-[#2b2521] p-3 flex flex-col gap-2 shadow-[0_4px_20px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)] relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-t from-[#14110f] to-transparent opacity-50 pointer-events-none"></div>
        <div className="flex items-center justify-between relative z-10 shrink-0">
          <span className="font-display text-[10px] text-lyria-text-muted uppercase tracking-widest font-medium" title="Generations loaded from the library, newest first">HISTORY</span>
          <div className="flex items-center gap-2">
            {hiddenIds.length > 0 && (
              <button onClick={restoreHiddenHistory} title="Brings every hidden generation back into this list" className="text-[10px] text-lyria-text-muted hover:text-lyria-text-main uppercase tracking-widest transition-colors duration-150 cursor-pointer rounded lyria-focus-ring">SHOW {hiddenIds.length} HIDDEN</button>
            )}
            <button onClick={clearHistory} title="Hides every listed generation from this list in this browser — audio files on disk are never deleted" className="text-[10px] text-lyria-text-muted hover:text-lyria-text-main uppercase tracking-widest transition-colors duration-150 cursor-pointer rounded lyria-focus-ring">CLEAR</button>
          </div>
        </div>

        <div className="relative pl-3 flex flex-col gap-1 overflow-y-auto min-h-0 z-10">
          {historyItems.length > 0 && (
            <>
              {/* Vertical line connecting timeline dots */}
              <div className="absolute left-[3px] top-2 bottom-4 w-[2px] bg-lyria-border"></div>
              {/* Active gold line segment */}
              <div className="absolute left-[3px] top-2 h-12 w-[2px] bg-gradient-to-b from-lyria-gold to-lyria-border"></div>
            </>
          )}

          {historyItems.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => { if (renamingId !== item.id) loadEntry(item.payload); }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return; // keys inside the rename input / trash button are theirs
                if ((e.key === 'Enter' || e.key === ' ') && renamingId !== item.id) {
                  e.preventDefault();
                  loadEntry(item.payload);
                }
              }}
              onContextMenu={(e) => openRowMenu(e, item)}
              title="Click to load this generation as a version tab — right-click for more actions"
              aria-label={`Load ${item.title} as a version tab`}
              className="relative flex items-start gap-3 group hover:bg-[#1a1715]/50 p-1.5 -ml-1.5 rounded-lg transition-colors duration-150 cursor-pointer lyria-focus-ring"
            >
               <div className={`absolute left-[4px] top-3 w-2 h-2 rounded-full ring-4 ring-lyria-panel ${item.isActive ? 'bg-lyria-gold' : item.type === 'text' ? 'border-2 border-lyria-text-muted bg-lyria-panel' : 'bg-lyria-text-muted'}`}></div>
               <div className="flex-1 flex justify-between items-start ml-2">
                 <div className="flex flex-col min-w-0 flex-1">
                   {renamingId === item.id ? (
                     <input
                       ref={renameInputRef}
                       type="text"
                       value={renameValue}
                       onClick={(e) => e.stopPropagation()}
                       onChange={(e) => setRenameValue(e.target.value)}
                       onKeyDown={(e) => {
                         if (e.key === 'Enter') { e.preventDefault(); void commitRename(item); }
                         if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
                       }}
                       onBlur={() => void commitRename(item)}
                       aria-label="Rename generation"
                       className="text-[10px] text-lyria-text-main font-medium bg-black/60 border border-lyria-gold/40 rounded px-1 py-0.5 outline-none focus:border-lyria-gold transition-colors duration-150 w-full"
                     />
                   ) : (
                     <span className="flex items-center gap-1.5">
                       {/* Inactive rows dim via the muted token (not row-level opacity, which
                           dropped the 9px meta line below WCAG contrast) — hover restores. */}
                       <span className={`text-[10px] font-medium truncate transition-colors duration-150 ${item.isActive ? 'text-lyria-text-main' : 'text-lyria-text-muted group-hover:text-lyria-text-main'}`}>{item.title}</span>
                       {item.isMock && (
                         <span title="Simulated result — no real AI provider generated this audio" className="shrink-0 px-1 py-[1px] rounded text-[7px] font-semibold tracking-wider text-lyria-text-muted bg-white/5 border border-[#2b2521]">MOCK</span>
                       )}
                     </span>
                   )}
                   <span title="Model, provider, duration and date for this version" className="text-[9px] text-lyria-text-muted truncate w-32">{item.desc}</span>
                 </div>
                 <div className="flex items-center gap-1">
                   {item.time && (
                     <span className="text-[9px] text-lyria-text-muted font-mono">{item.time}</span>
                   )}
                   <button onClick={(e) => { e.stopPropagation(); removeHistoryItem(item.id); }} title="Hides this entry from the list in this browser — the audio file on disk is never deleted" aria-label={`Remove ${item.title} from the history list`} className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-lyria-text-muted hover:text-lyria-signal transition-all duration-150 p-1 active:scale-90 cursor-pointer rounded lyria-focus-ring">
                     <Trash2 size={10} />
                   </button>
                 </div>
               </div>
            </div>
          ))}

          {historyItems.length === 0 && (
             <div className="flex items-center justify-center py-6 text-lyria-text-muted text-[10px] tracking-wide text-center">
               {hiddenIds.length > 0 ? 'Nothing visible — use SHOW HIDDEN above' : 'No generations yet'}
             </div>
          )}
        </div>
      </div>

    </div>
  );
}
