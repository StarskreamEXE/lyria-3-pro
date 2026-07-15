import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, MicOff, FileText, Trash2 } from 'lucide-react';
import { listGenerations, renameGeneration, type GenerationEntry } from '../lib/lyriaClient';
import { showContextMenu } from './ContextMenu';

// Only operations the single-turn Lyria 3 API can honor.
// 'generate' = prompt-level rewrite → new version.
const TOOLS = [
  { id: 2, label: 'CHANGE STYLE', desc: 'Generates a new version from the current prompt (paid: $0.08 Pro / $0.04 Clip)', Icon: Sparkles, action: 'generate' as const },
  { id: 4, label: 'EDIT LYRICS', desc: 'Opens and pins the lyrics editor', Icon: FileText, action: 'lyrics' as const },
  { id: 5, label: 'INSTRUMENTAL', desc: 'Adds an instrumental-only instruction and generates a new version (paid: $0.08 Pro / $0.04 Clip)', Icon: MicOff, action: 'instrumental' as const },
];

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
// modelShortName's output for anything else (e.g. plain "LYRIA" for lyria-002).
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

// mm:ss from a real duration in seconds (pinned contract: GenerationEntry.durationSeconds,
// absent until the server persists it — callers must treat undefined as "unknown", never 0:00).
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

export function SidebarRight() {
  const [activeTool, setActiveTool] = useState<number | null>(null);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  // Row currently swapped to an inline rename input (id of the HistoryItem, or null).
  const [renamingId, setRenamingId] = useState<string | number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const removeHistoryItem = (id: string | number) => {
    setHistoryItems(items => items.filter(item => item.id !== id));
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
    window.dispatchEvent(new CustomEvent('lyria-load-params', {
      detail: {
        prompt: entry.prompt,
        lyrics: entry.lyrics,
        model: modelIdToLabel(entry.model),
        language: (entry as Record<string, unknown>).language as string | undefined,
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
      // Silent-warn per spec — the row simply keeps its previous title (route may not
      // exist yet per the pinned contract, or the id/title was rejected server-side).
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

  // On mount, populate HISTORY from the persisted library (newest-first, per the API contract)
  useEffect(() => {
    let cancelled = false;
    listGenerations()
      .then(entries => {
        if (cancelled) return;
        setHistoryItems(entries.map(entry => ({
          id: entry.id,
          title: resolveTitle(entry),
          desc: buildMetaLine(entry),
          time: '',
          type: 'audio',
          isActive: false,
          isMock: entry.provider === 'mock',
          payload: entry,
        })));
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

  // CenterPanel dispatches this once a real analysis completes for a version — retitle
  // the matching HISTORY entry with the analysis's real track name.
  useEffect(() => {
    const handleAnalysis = (e: Event) => {
      const { id, analysis } = (e as CustomEvent).detail ?? {};
      if (!id || !analysis?.title) return;
      setHistoryItems(items => items.map(item => (
        item.id === id ? { ...item, title: analysis.title } : item
      )));
    };
    window.addEventListener('lyria-analysis', handleAnalysis);
    return () => window.removeEventListener('lyria-analysis', handleAnalysis);
  }, []);

  const handleToolClick = (tool: typeof TOOLS[number]) => {
    setActiveTool(tool.id);

    if (tool.action === 'lyrics') {
      window.dispatchEvent(new CustomEvent('lyria-focus-lyrics'));
      setTimeout(() => setActiveTool(null), 600);
      return;
    }

    if (tool.action === 'instrumental') {
      window.dispatchEvent(new CustomEvent('lyria-prompt-append', { detail: { text: 'Instrumental only — no vocals.' } }));
    }

    // Real generation path — SidebarLeft's flow emits action-start/end itself
    window.dispatchEvent(new CustomEvent('lyria-request-generate'));
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
      </div>

      {/* History */}
      <div className="flex-1 min-h-0 bg-[#110e0c]/80 backdrop-blur-md rounded-xl border border-[#2b2521] p-3 flex flex-col gap-2 shadow-[0_4px_20px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)] relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-t from-[#14110f] to-transparent opacity-50 pointer-events-none"></div>
        <div className="flex items-center justify-between relative z-10 shrink-0">
          <span className="font-display text-[10px] text-lyria-text-muted uppercase tracking-widest font-medium" title="Generations loaded from the library, newest first">HISTORY</span>
          <button onClick={() => setHistoryItems([])} title="Clears the list display only — audio files on disk are never deleted" className="text-[10px] text-lyria-text-muted hover:text-lyria-text-main uppercase tracking-widest transition-colors duration-150 cursor-pointer rounded lyria-focus-ring">CLEAR</button>
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
                   <button onClick={(e) => { e.stopPropagation(); removeHistoryItem(item.id); }} title="Removes this entry from the list only — the audio file on disk is never deleted" aria-label={`Remove ${item.title} from the history list`} className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-lyria-text-muted hover:text-lyria-signal transition-all duration-150 p-1 active:scale-90 cursor-pointer rounded lyria-focus-ring">
                     <Trash2 size={10} />
                   </button>
                 </div>
               </div>
            </div>
          ))}

          {historyItems.length === 0 && (
             <div className="flex items-center justify-center py-6 text-lyria-text-muted text-[10px] tracking-wide">
               No generations yet
             </div>
          )}
        </div>
      </div>

    </div>
  );
}
