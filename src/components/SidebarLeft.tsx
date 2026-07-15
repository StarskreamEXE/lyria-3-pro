import React, { useState, useRef, useEffect } from 'react';
import { Box, Image as ImageIcon, AudioLines, Sparkles, Command, Maximize2, MoveVertical, ChevronRight, ArrowUpDown, ChevronDown, ChevronUp, Pin, X, Undo, Redo, Loader2 } from 'lucide-react';
import { generateVersion, getOpenRouterCredits, type Project } from '../lib/lyriaClient';
import { projectStore } from '../lib/projectStore';

// Real per-track prices shown in the MODEL dropdown — mirrors costPerUnit's mapping
// below (Pro covers LYRIA 3 PRO and LYRIA 2, since lyria-002 wiring is still TBD and
// billed as pro; Clip is its own cheaper per-clip rate).
const MODEL_OPTIONS: { name: string; priceLabel: string }[] = [
  { name: "LYRIA 3 PRO", priceLabel: "$0.08/song" },
  { name: "LYRIA 3 CLIP", priceLabel: "$0.04/clip" },
  { name: "LYRIA 2", priceLabel: "$0.08 (routed as Pro)" },
];

// ——— Lyrics section parsing (for the "Reorder sections" popover) ———
// Tag rule verified against docs/guide/02-prompting-guide.md ("Section tags"):
// `[Intro]` `[Verse 1]` `[Pre-Chorus]` `[Chorus]` `[Verse 2]` `[Bridge]`
// `[Breakdown]` `[Final Chorus]` `[Outro]` — and "custom labels also work",
// so ANY line that starts with a [bracketed label] begins a new section
// (no whitelist). Text before the first tag is an untagged preamble block.
const SECTION_TAG_RE = /^\s*\[([^\]]+)\]/;

interface LyricsSection {
  tag: string | null; // null = untagged preamble before the first tag (pinned at top)
  body: string;       // raw section text incl. its tag line; trailing blank lines trimmed
  preview: string;    // first non-empty lyric line, shown as the row's 1-line preview
}

interface ParsedLyrics {
  sections: LyricsSection[];
  // Separator used to rejoin sections after a reorder — mirrors the source's
  // blank-line style: '\n' only when every original section boundary was tight
  // (no blank line before the next tag); otherwise the conventional '\n\n'.
  separator: string;
}

function parseLyricsSections(lyrics: string): ParsedLyrics {
  const sections: LyricsSection[] = [];
  let current: { tag: string | null; lines: string[] } | null = null;
  let boundaries = 0;
  let blankBoundaries = 0;

  const flush = (atTagBoundary: boolean) => {
    if (!current) return;
    const block = [...current.lines];
    while (block.length > 0 && block[block.length - 1].trim() === '') block.pop();
    if (atTagBoundary) {
      boundaries += 1;
      if (block.length < current.lines.length) blankBoundaries += 1;
    }
    if (block.length > 0) {
      const contentLines = current.tag === null ? block : block.slice(1);
      let preview = (contentLines.find(l => l.trim() !== '') ?? '').trim();
      if (!preview && current.tag !== null) {
        // Tag-only section, or inline text sitting on the tag line itself.
        preview = block[0].replace(SECTION_TAG_RE, '').trim();
      }
      sections.push({ tag: current.tag, body: block.join('\n'), preview });
    }
    current = null;
  };

  for (const line of lyrics.split('\n')) {
    const match = line.match(SECTION_TAG_RE);
    if (match) {
      flush(true);
      current = { tag: match[1].trim(), lines: [line] };
    } else {
      if (!current) current = { tag: null, lines: [] };
      current.lines.push(line);
    }
  }
  flush(false);

  return { sections, separator: boundaries > 0 && blankBoundaries === 0 ? '\n' : '\n\n' };
}

function rebuildLyricsFromSections(sections: LyricsSection[], separator: string): string {
  return sections.map(s => s.body).join(separator);
}

export function SidebarLeft() {
  const [prompt, setPrompt] = useState("Cinematic darkwave track with driving beats, deep synths, atmospheric pads, female vocals. Build from tension to release. 128bpm.");
  const [lyrics, setLyrics] = useState("[Verse]\nCity lights don't sleep\nThey pull me underground\nHeartbeat in the streets\nLost but I'm not down\n\n[Pre-Chorus]\nWhispers in the dark\nCalling out my name\nI follow the spark\nStraight into the flame");
  const [isGenerating, setIsGenerating] = useState(false);
  // Off by default: silently rewriting the prompt and burning a paid text-enhance
  // call before every generation must be an explicit opt-in, never a surprise.
  const [promptAutoMode, setPromptAutoMode] = useState(false);
  // REAL vocals switch (replaces the old dead lyricsAutoMode toggle, which gated
  // nothing): when OFF, the lyrics box is NOT sent and the outgoing request prompt
  // gets an explicit "Instrumental only — no vocals." directive — the only
  // API-real way to stop Lyria from singing/inventing lyrics.
  const [vocalsEnabled, setVocalsEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('lyria_vocals_enabled') !== 'off'; } catch { return true; }
  });
  const toggleVocals = () => {
    setVocalsEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem('lyria_vocals_enabled', next ? 'on' : 'off'); } catch { /* storage unavailable */ }
      return next;
    });
  };
  // AUTO lyrics — the lyrics twin of the prompt's AUTO: when on, the text AI
  // writes/updates the lyrics to match the style prompt before each generation
  // (REAL this time — the old toggle gated nothing). Off by default: paid call.
  const [lyricsAutoMode, setLyricsAutoMode] = useState(false);
  const [model, setModel] = useState("LYRIA 3 PRO");
  const [durationTarget, setDurationTarget] = useState("3:00");
  const [language, setLanguage] = useState("EN");
  const [batchCount, setBatchCount] = useState(1);
  // Optional pre-generation track name — component-state only (not persisted to the
  // project store, not part of any undo/redo stack). Sent as `title` in the generate
  // request; a batch of >1 appends " (2)", " (3)", etc. per index so multiple versions
  // from one click don't collide on the same name.
  const [trackName, setTrackName] = useState('');
  const [openRouterBalance, setOpenRouterBalance] = useState<number | null>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  // Undo / Redo stacks
  const [promptHistory, setPromptHistory] = useState<string[]>([
    "Cinematic darkwave track with driving beats, deep synths, atmospheric pads, female vocals. Build from tension to release. 128bpm."
  ]);
  const [promptHistoryIndex, setPromptHistoryIndex] = useState(0);

  const [lyricsHistory, setLyricsHistory] = useState<string[]>([
    "[Verse]\nCity lights don't sleep\nThey pull me underground\nHeartbeat in the streets\nLost but I'm not down\n\n[Pre-Chorus]\nWhispers in the dark\nCalling out my name\nI follow the spark\nStraight into the flame"
  ]);
  const [lyricsHistoryIndex, setLyricsHistoryIndex] = useState(0);

  // File states — Lyria 3 accepts up to 10 image references; audio input is not supported
  const [imageAssets, setImageAssets] = useState<{ name: string; url: string }[]>([]);
  const [isDraggingImage, setIsDraggingImage] = useState(false);

  // Object-URL lifecycle for the image references — URL.createObjectURL leaks
  // browser memory until revoked, so: URLs are only created for files that fit
  // under the 10-cap (never create-then-discard), each is revoked on remove,
  // and everything left is revoked on unmount (cleanup effect below). The ref
  // mirror keeps rapid successive drops honest about remaining room and lets
  // the unmount cleanup see the latest list; URL creation stays OUTSIDE any
  // setState updater (StrictMode double-invokes updaters — one set would leak).
  const imageAssetsRef = useRef(imageAssets);
  imageAssetsRef.current = imageAssets;

  const addImageFiles = (files: File[]) => {
    const room = 10 - imageAssetsRef.current.length;
    if (room <= 0 || files.length === 0) return;
    const added = files.slice(0, room).map(f => ({ name: f.name, url: URL.createObjectURL(f) }));
    const next = [...imageAssetsRef.current, ...added];
    imageAssetsRef.current = next;
    setImageAssets(next);
  };

  const removeImageAt = (index: number) => {
    const removed = imageAssetsRef.current[index];
    if (removed) URL.revokeObjectURL(removed.url);
    const next = imageAssetsRef.current.filter((_, j) => j !== index);
    imageAssetsRef.current = next;
    setImageAssets(next);
  };

  useEffect(() => () => {
    // Unmount: release every object URL still alive. (Safe under StrictMode's
    // dev mount→cleanup→mount: the list is empty at that point.)
    imageAssetsRef.current.forEach(img => URL.revokeObjectURL(img.url));
  }, []);

  // Prompt popout states
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const [isPromptPinned, setIsPromptPinned] = useState(false);
  const isPromptActive = isPromptExpanded || isPromptPinned;

  // Lyrics popout states
  const [isLyricsExpanded, setIsLyricsExpanded] = useState(false);
  const [isLyricsPinned, setIsLyricsPinned] = useState(false);
  const isLyricsActive = isLyricsExpanded || isLyricsPinned;

  // Popout containers — any click or focus OUTSIDE a popout always collapses
  // and unpins it; mouseleave alone never collapses while focus is inside (typing).
  const promptBoxRef = useRef<HTMLDivElement>(null);
  const lyricsBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const collapseIfOutside = (e: Event) => {
      const target = e.target as Node;
      if (promptBoxRef.current && !promptBoxRef.current.contains(target)) {
        setIsPromptExpanded(false);
        setIsPromptPinned(false);
        setIsPromptWandOpen(false);
      }
      if (lyricsBoxRef.current && !lyricsBoxRef.current.contains(target)) {
        setIsLyricsExpanded(false);
        setIsLyricsPinned(false);
        setIsLyricsWandOpen(false);
      }
    };
    window.addEventListener('pointerdown', collapseIfOutside);
    window.addEventListener('focusin', collapseIfOutside);
    return () => {
      window.removeEventListener('pointerdown', collapseIfOutside);
      window.removeEventListener('focusin', collapseIfOutside);
    };
  }, []);

  // Model dropdown — same outside-pointerdown-closes convention as the popouts above.
  useEffect(() => {
    if (!isModelMenuOpen) return;
    const closeIfOutside = (e: Event) => {
      const target = e.target as Node;
      if (modelMenuRef.current && !modelMenuRef.current.contains(target)) {
        setIsModelMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', closeIfOutside);
    return () => window.removeEventListener('pointerdown', closeIfOutside);
  }, [isModelMenuOpen]);

  // AI Refinement states
  const [isPromptWandOpen, setIsPromptWandOpen] = useState(false);
  const [promptAiInput, setPromptAiInput] = useState("");
  const [isPromptAiLoading, setIsPromptAiLoading] = useState(false);

  const [isLyricsWandOpen, setIsLyricsWandOpen] = useState(false);
  const [lyricsAiInput, setLyricsAiInput] = useState("");
  const [isLyricsAiLoading, setIsLyricsAiLoading] = useState(false);

  const imageInputRef = useRef<HTMLInputElement>(null);

  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const lyricsTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Latest-value refs (synced every render + inside updatePromptWithHistory).
  // lyria-prompt-append and lyria-request-generate can fire in the same tick
  // (inspector/tool click handlers), before React commits the batched setPrompt —
  // so handlers must read these refs, not render closures, or a generation
  // fires without the directive that triggered it.
  const promptRef = useRef(prompt);
  const promptHistoryRef = useRef(promptHistory);
  const promptHistoryIndexRef = useRef(promptHistoryIndex);
  promptRef.current = prompt;
  promptHistoryRef.current = promptHistory;
  promptHistoryIndexRef.current = promptHistoryIndex;

  // Lyrics twins of the prompt refs above — updateLyricsWithHistory runs after
  // awaits inside handleGenerate (the auto-lyrics path), where the render
  // closure's lyrics/lyricsHistory/lyricsHistoryIndex may be stale; reading
  // these refs keeps a history change made during the enhance/auto-lyrics
  // round-trip from being silently clobbered.
  const lyricsRef = useRef(lyrics);
  const lyricsHistoryRef = useRef(lyricsHistory);
  const lyricsHistoryIndexRef = useRef(lyricsHistoryIndex);
  lyricsRef.current = lyrics;
  lyricsHistoryRef.current = lyricsHistory;
  lyricsHistoryIndexRef.current = lyricsHistoryIndex;

  // Synchronous re-entrancy lock — isGenerating (render state) is not visible
  // until React commits, so two same-tick 'lyria-request-generate' dispatches
  // or a fast double-click can both pass an `if (isGenerating) return` check
  // and fire two paid generations. This ref is set/read synchronously instead.
  const isGeneratingRef = useRef(false);

  // Same synchronous-lock idea for the paid /api/ai/* text calls:
  // isPromptAiLoading/isLyricsAiLoading are render state, so a second Enter in
  // a wand input before React commits would fire a second paid modify call.
  // These refs mirror the loading states (set/cleared everywhere the states
  // are) and are checked in handleAiModify before any spend.
  const isPromptAiLoadingRef = useRef(false);
  const isLyricsAiLoadingRef = useRef(false);

  // Silent, best-effort — never blocks or alerts the user. Only meaningful when
  // the OpenRouter provider is active; called on mount and after each generation
  // batch settles so the readout tracks real spend.
  const refreshOpenRouterBalance = () => {
    if (localStorage.getItem('ai_provider') !== 'openrouter') return;
    getOpenRouterCredits()
      .then(credits => setOpenRouterBalance(credits ? credits.balance : null))
      .catch(err => console.warn('Failed to fetch OpenRouter credits:', err));
  };

  useEffect(() => {
    refreshOpenRouterBalance();
  }, []);

  // Shared reseed logic used by both the project-load handler (below) and the
  // 'lyria-load-params' handler (right-click "Load with settings" from history/version
  // tabs — see the effect further down). Reapplies prompt/lyrics (reseeding both undo/redo
  // stacks so the loaded value becomes the new baseline rather than sitting on top of
  // whatever history already existed) and any settings present, each with the matching
  // *-change dispatch so CenterPanel's mirrored model/duration state stays in sync.
  // Guarded by isApplyingLoadRef so applying these values doesn't immediately re-PUT them
  // back into the project store.
  const applyLoadedValues = (values: {
    prompt?: string;
    lyrics?: string;
    model?: string;
    durationTarget?: string;
    batchCount?: number;
    language?: string;
  }) => {
    isApplyingLoadRef.current = true;

    if (values.prompt !== undefined) {
      const loadedPrompt = values.prompt || '';
      promptRef.current = loadedPrompt;
      promptHistoryRef.current = [loadedPrompt];
      promptHistoryIndexRef.current = 0;
      setPrompt(loadedPrompt);
      setPromptHistory([loadedPrompt]);
      setPromptHistoryIndex(0);
    }

    if (values.lyrics !== undefined) {
      const loadedLyrics = values.lyrics || '';
      lyricsRef.current = loadedLyrics;
      lyricsHistoryRef.current = [loadedLyrics];
      lyricsHistoryIndexRef.current = 0;
      setLyrics(loadedLyrics);
      setLyricsHistory([loadedLyrics]);
      setLyricsHistoryIndex(0);
    }

    if (values.model) {
      setModel(values.model);
      window.dispatchEvent(new CustomEvent('lyria-model-change', { detail: { model: values.model } }));
    }
    if (values.durationTarget) {
      setDurationTarget(values.durationTarget);
      window.dispatchEvent(new CustomEvent('lyria-duration-change', { detail: { duration: values.durationTarget } }));
    }
    if (values.batchCount) {
      setBatchCount(values.batchCount);
      window.dispatchEvent(new CustomEvent('lyria-batch-change', { detail: { count: values.batchCount } }));
    }
    if (values.language) {
      setLanguage(values.language);
    }

    // Release the guard on the next tick — after this event's synchronous setState
    // calls have been queued but state may not have committed yet (multiple state
    // updates within the same handler batch together in React 19).
    setTimeout(() => { isApplyingLoadRef.current = false; }, 0);
  };

  // projectStore dispatches this on init, switchTo, createNew, and post-archive fallback.
  useEffect(() => {
    const handleProjectLoad = (e: Event) => {
      const project = (e as CustomEvent<{ project: Project }>).detail?.project;
      if (!project) return;
      applyLoadedValues({
        prompt: project.prompt || '',
        lyrics: project.lyrics || '',
        model: project.settings?.model,
        durationTarget: project.settings?.durationTarget,
        batchCount: project.settings?.batchCount,
        language: project.settings?.language,
      });
    };
    window.addEventListener('lyria-project-load', handleProjectLoad);
    return () => window.removeEventListener('lyria-project-load', handleProjectLoad);
  }, []);

  // 'lyria-load-params' — dispatched by SidebarRight's "Load with settings" history-row
  // action and CenterPanel's "Load settings from this version" tab action. Same reseed
  // path as a project load, but scoped to just the fields the event carries (all optional).
  useEffect(() => {
    const handleLoadParams = (e: Event) => {
      const detail = (e as CustomEvent<{
        prompt?: string;
        lyrics?: string;
        model?: string;
        durationTarget?: string;
        language?: string;
      }>).detail;
      if (!detail) return;
      applyLoadedValues(detail);
      if (detail.prompt !== undefined) projectStore.update({ prompt: detail.prompt || '' });
      if (detail.lyrics !== undefined) projectStore.update({ lyrics: detail.lyrics || '' });
    };
    window.addEventListener('lyria-load-params', handleLoadParams);
    return () => window.removeEventListener('lyria-load-params', handleLoadParams);
  }, []);

  const handleGenerate = async () => {
    if (isGeneratingRef.current) return;
    isGeneratingRef.current = true;

    try {
      let currentPrompt = promptRef.current;

      if (promptAutoMode && currentPrompt.trim()) {
        setIsGenerating(true);
        setIsPromptAiLoading(true);
        isPromptAiLoadingRef.current = true;
        try {
          const apiKey = localStorage.getItem('gemini_api_key');
          const openRouterApiKey = localStorage.getItem('openrouter_api_key');
          const aiProvider = localStorage.getItem('ai_provider');
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiKey) {
            headers['x-gemini-api-key'] = apiKey;
          }
          if (openRouterApiKey) {
            headers['x-openrouter-api-key'] = openRouterApiKey;
          }
          if (aiProvider) {
            headers['x-ai-provider'] = aiProvider;
          }

          const response = await fetch("/api/ai/enhance-prompt", {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: currentPrompt })
          });
          if (response.ok) {
            const data = await response.json();
            if (data.result) {
              currentPrompt = data.result;
              // Written into the prompt editor's state/history BEFORE the generation
              // call below fires, so the user always sees the exact text they're
              // about to pay to generate — never a silent server-side swap.
              updatePromptWithHistory(currentPrompt);
            }
          } else {
            const errData = await response.json().catch(() => ({}));
            const errMsg = errData.error || "Unknown error";
            console.error("Enhancement failed on server:", errMsg);
            // AUTO promised an enhanced prompt — on failure, ABORT instead of
            // silently spending on the un-enhanced prompt (surprise spend).
            // The outer finally below resets the generating lock/spinner.
            if (typeof errMsg === 'string' && (errMsg.includes('Lightning dunning') || errMsg.includes('leaked'))) {
              alert('API Key Error: ' + errMsg + '\n\nPlease click the Settings button INSIDE THIS APP (the gear icon) to add your own custom Gemini API Key.\n\nGeneration cancelled — nothing was generated or charged. Retry, or turn AUTO off to generate with your prompt as-is.');
            } else {
              alert('Enhancement failed: ' + errMsg + '\n\nGeneration cancelled — nothing was generated or charged. Retry, or turn AUTO off to generate with your prompt as-is.');
            }
            return;
          }
        } catch (err) {
          console.error("Error enhancing prompt:", err);
          // Same abort rule for network-level failures (fetch threw).
          alert('Enhancement failed: ' + (err instanceof Error ? err.message : 'network error') + '\n\nGeneration cancelled — nothing was generated or charged. Retry, or turn AUTO off to generate with your prompt as-is.');
          return;
        } finally {
          setIsPromptAiLoading(false);
          isPromptAiLoadingRef.current = false;
        }
      }

      setIsGenerating(true);
      window.dispatchEvent(new CustomEvent('lyria-action-start'));

      // Read through lyricsRef, not the render closure — when AUTO enhance is
      // on this line runs after an await, and the closure's `lyrics` may be
      // stale by then (same reasoning as promptRef above).
      let currentLyrics = lyricsRef.current;

      // AUTO lyrics: AI writes/updates the lyrics to match the (possibly just
      // enhanced) prompt, landing them visibly in the editor BEFORE the paid
      // generation fires — same visibility guarantee as prompt AUTO. Skipped
      // when vocals are off (nothing would be sung).
      if (lyricsAutoMode && vocalsEnabled && currentPrompt.trim()) {
        setIsGenerating(true);
        setIsLyricsAiLoading(true);
        isLyricsAiLoadingRef.current = true;
        try {
          const apiKey = localStorage.getItem('gemini_api_key');
          const openRouterApiKey = localStorage.getItem('openrouter_api_key');
          const aiProvider = localStorage.getItem('ai_provider');
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiKey) headers['x-gemini-api-key'] = apiKey;
          if (openRouterApiKey) headers['x-openrouter-api-key'] = openRouterApiKey;
          if (aiProvider) headers['x-ai-provider'] = aiProvider;

          const response = await fetch("/api/ai/modify", {
            method: "POST",
            headers,
            body: JSON.stringify({
              type: "lyrics",
              instruction: `Write complete song lyrics that match this music direction: "${currentPrompt}". Keep/use section tags like [Verse], [Pre-Chorus], [Chorus]. If existing lyrics are provided, rewrite or extend them to fit the direction; otherwise write fresh lyrics.`,
              currentText: currentLyrics,
            })
          });
          if (response.ok) {
            const data = await response.json();
            if (data.result) {
              currentLyrics = data.result;
              updateLyricsWithHistory(currentLyrics);
            }
          } else {
            const errData = await response.json().catch(() => ({}));
            console.error("Auto-lyrics failed on server:", errData.error || "Unknown error");
          }
        } catch (err) {
          console.error("Error auto-writing lyrics:", err);
        } finally {
          setIsLyricsAiLoading(false);
          isLyricsAiLoadingRef.current = false;
        }
      }

      // Vocals off = instrumental: suppress the lyrics block AND direct the model
      // in the request prompt (the visible prompt box is left untouched).
      const instrumental = !vocalsEnabled;
      const baseTitle = trackName.trim();
      const opts = {
        prompt: instrumental ? `${currentPrompt}\n\nInstrumental only — no vocals.` : currentPrompt,
        lyrics: instrumental ? '' : currentLyrics,
        language,
        durationTarget,
        model: model === 'LYRIA 3 CLIP' ? 'clip' as const
          : model === 'LYRIA 2' ? 'pro' as const // lyria-002 wiring TBD
          : 'pro' as const,
        images: imageAssets,
      };

      // Per-index title: batch of 1 sends the name as-is; batch >1 appends " (2)", " (3)"
      // etc. so a single click's multiple versions don't collide on the same track name.
      // Silently degrades (server ignores `title` until it lands — see pinned contract).
      const results = await Promise.allSettled(
        Array.from({ length: batchCount }, (_, i) => generateVersion({
          ...opts,
          ...(baseTitle ? { title: i === 0 ? baseTitle : `${baseTitle} (${i + 1})` } : {}),
        }))
      );

      const ok = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const failed = results.length - ok.length;
      ok.forEach(r => {
        window.dispatchEvent(new CustomEvent('lyria-generated', { detail: { count: 1, payload: r.value } }));
      });
      if (failed > 0) {
        alert(`${failed} of ${results.length} generation(s) failed. Check your API key in Settings or the server console.`);
      }
      refreshOpenRouterBalance();
    } finally {
      // Guaranteed cleanup on every exit path — success, the abort-on-enhance-
      // failure returns above, or an unexpected throw — so no path (and no
      // future edit) can leave the orb/spinner stuck or the app permanently
      // unable to generate. The unmatched 'lyria-action-end' on abort paths is
      // harmless: CenterPanel's listener just posts an idempotent ACTION_END.
      setIsGenerating(false);
      window.dispatchEvent(new CustomEvent('lyria-action-end'));
      isGeneratingRef.current = false;
    }
  };

  // Model dropdown row pick — same side effects the old cycleModel step performed
  // (setModel + lyria-model-change dispatch + projectStore.update), just driven by an
  // explicit row pick instead of a cycle.
  const selectModel = (next: string) => {
    setModel(next);
    window.dispatchEvent(new CustomEvent('lyria-model-change', { detail: { model: next } }));
    projectStore.update({ settings: { model: next } });
    setIsModelMenuOpen(false);
  };

  // Duration is a prompt-side control (Lyria 3 Pro); Clip is fixed at 0:30
  const cycleDuration = () => {
    if (model === "LYRIA 3 CLIP") return;
    const durations = ["1:00", "2:00", "3:00"];
    const next = durations[(durations.indexOf(durationTarget) + 1) % durations.length];
    setDurationTarget(next);
    window.dispatchEvent(new CustomEvent('lyria-duration-change', { detail: { duration: next } }));
    projectStore.update({ settings: { durationTarget: next } });
  };

  // Lyria 3 sings in 8 languages, driven by prompt/lyrics language
  const cycleLanguage = () => {
    const langs = ["EN", "DE", "ES", "FR", "HI", "JA", "KO", "PT"];
    const next = langs[(langs.indexOf(language) + 1) % langs.length];
    setLanguage(next);
    projectStore.update({ settings: { language: next } });
  };

  // Each generation is a full independent Lyria call — batching is an explicit spend
  const cycleBatch = () => {
    const options = [1, 2, 4];
    const next = options[(options.indexOf(batchCount) + 1) % options.length];
    setBatchCount(next);
    window.dispatchEvent(new CustomEvent('lyria-batch-change', { detail: { count: next } }));
    projectStore.update({ settings: { batchCount: next } });
  };

  // Real per-unit spend — mirrors the model mapping in handleGenerate's `opts.model`.
  // Pro ($0.08/song) covers LYRIA 3 PRO and LYRIA 2 (lyria-002 wiring TBD, billed as pro);
  // Clip ($0.04/clip) only for LYRIA 3 CLIP. Multiplied by batchCount for total spend.
  const costPerUnit = model === "LYRIA 3 CLIP" ? 0.04 : 0.08;
  const totalCost = costPerUnit * batchCount;

  // Inspector/tools write structure directives into the prompt — the only edit
  // flow Lyria 3 supports (single-turn: new prompt → new generation).
  // Re-subscribed each render; handlers read promptRef so same-tick dispatch
  // sequences (append → request-generate) see un-committed updates.
  useEffect(() => {
    const handleAppend = (e: Event) => {
      const text = (e as CustomEvent).detail?.text;
      if (text) {
        const base = promptRef.current;
        updatePromptWithHistory(base ? `${base}\n${text}` : text);
      }
    };
    const handleFocusLyrics = () => {
      setIsLyricsPinned(true);
    };
    const handleRequestGenerate = () => { void handleGenerate(); };
    window.addEventListener('lyria-prompt-append', handleAppend);
    window.addEventListener('lyria-focus-lyrics', handleFocusLyrics);
    window.addEventListener('lyria-request-generate', handleRequestGenerate);
    return () => {
      window.removeEventListener('lyria-prompt-append', handleAppend);
      window.removeEventListener('lyria-focus-lyrics', handleFocusLyrics);
      window.removeEventListener('lyria-request-generate', handleRequestGenerate);
    };
  });

  // ⌘⏎ / Ctrl+Enter — the shortcut the GENERATE button's badge advertises
  // (docs/guide/04: UI must never imply a capability that doesn't exist).
  // Fires from anywhere in the window EXCEPT text fields, with one deliberate
  // exception: the prompt/lyrics textareas, where "cmd+enter submits" is the
  // standard expectation. Other inputs (wand pills, track name, settings) are
  // excluded so their own Enter semantics stay untouched. e.repeat plus
  // handleGenerate's isGeneratingRef lock make held keys/double-fires
  // spend-safe. Re-subscribed each render (no deps) — same convention as the
  // event-bus effect above, so handleGenerate is never a stale closure.
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter' || e.repeat) return;
      const target = e.target;
      const inTextField = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable);
      const inOwnEditor = target === promptTextareaRef.current || target === lyricsTextareaRef.current;
      if (inTextField && !inOwnEditor) return;
      e.preventDefault();
      void handleGenerate();
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  });

  // Set while applyLoadedProject() is writing loaded prompt/lyrics/settings into state —
  // suppresses the store-push paths below so re-applying a just-loaded project's own
  // values doesn't immediately re-PUT them back (harmless, but a wasted round-trip on
  // every project switch).
  const isApplyingLoadRef = useRef(false);

  // History helpers
  const updatePromptWithHistory = (newVal: string) => {
    // Read/write through refs: callers may hold a stale closure (bus handlers,
    // the async auto-enhance branch in handleGenerate) — slicing the closure's
    // promptHistory would silently drop just-committed undo entries.
    const updatedHistory = promptHistoryRef.current.slice(0, promptHistoryIndexRef.current + 1);
    updatedHistory.push(newVal);
    promptRef.current = newVal;
    promptHistoryRef.current = updatedHistory;
    promptHistoryIndexRef.current = updatedHistory.length - 1;
    setPromptHistory(updatedHistory);
    setPromptHistoryIndex(updatedHistory.length - 1);
    setPrompt(newVal);
    if (!isApplyingLoadRef.current) projectStore.update({ prompt: newVal });
  };

  const handlePromptUndo = () => {
    if (promptHistoryIndex > 0) {
      const prevIndex = promptHistoryIndex - 1;
      setPromptHistoryIndex(prevIndex);
      setPrompt(promptHistory[prevIndex]);
      projectStore.update({ prompt: promptHistory[prevIndex] });
    }
  };

  const handlePromptRedo = () => {
    if (promptHistoryIndex < promptHistory.length - 1) {
      const nextIndex = promptHistoryIndex + 1;
      setPromptHistoryIndex(nextIndex);
      setPrompt(promptHistory[nextIndex]);
      projectStore.update({ prompt: promptHistory[nextIndex] });
    }
  };

  const updateLyricsWithHistory = (newVal: string) => {
    // Read/write through refs (exact mirror of updatePromptWithHistory): the
    // auto-lyrics branch in handleGenerate calls this after awaits — slicing
    // the render closure's lyricsHistory would silently drop any undo entries
    // committed during the round-trip.
    const updatedHistory = lyricsHistoryRef.current.slice(0, lyricsHistoryIndexRef.current + 1);
    updatedHistory.push(newVal);
    lyricsRef.current = newVal;
    lyricsHistoryRef.current = updatedHistory;
    lyricsHistoryIndexRef.current = updatedHistory.length - 1;
    setLyricsHistory(updatedHistory);
    setLyricsHistoryIndex(updatedHistory.length - 1);
    setLyrics(newVal);
    if (!isApplyingLoadRef.current) projectStore.update({ lyrics: newVal });
  };

  const handleLyricsUndo = () => {
    if (lyricsHistoryIndex > 0) {
      const prevIndex = lyricsHistoryIndex - 1;
      setLyricsHistoryIndex(prevIndex);
      setLyrics(lyricsHistory[prevIndex]);
      projectStore.update({ lyrics: lyricsHistory[prevIndex] });
    }
  };

  const handleLyricsRedo = () => {
    if (lyricsHistoryIndex < lyricsHistory.length - 1) {
      const nextIndex = lyricsHistoryIndex + 1;
      setLyricsHistoryIndex(nextIndex);
      setLyrics(lyricsHistory[nextIndex]);
      projectStore.update({ lyrics: lyricsHistory[nextIndex] });
    }
  };

  // ——— Reorder lyrics sections (the ArrowUpDown button in the lyrics footer) ———
  // Re-parsed every render so the popover always reflects the live textarea.
  const parsedLyrics = parseLyricsSections(lyrics);
  const lyricsSections = parsedLyrics.sections;
  const canReorderLyrics = lyricsSections.some(s => s.tag !== null);
  // Untagged preamble (if any) is pinned at the top — only rows below it move.
  const firstMovableIndex = lyricsSections[0]?.tag === null ? 1 : 0;

  const [isReorderOpen, setIsReorderOpen] = useState(false);
  const reorderMenuRef = useRef<HTMLDivElement>(null);
  const reorderTriggerRef = useRef<HTMLButtonElement>(null);
  // Set just before a move commits; the effect below re-focuses the arrow
  // button that travelled with the moved section, so keyboard users can keep
  // pressing Enter/Space to walk one section up or down the whole list.
  const reorderFocusRef = useRef<string | null>(null);

  // Same outside-pointerdown-closes convention as the model dropdown above.
  useEffect(() => {
    if (!isReorderOpen) return;
    const closeIfOutside = (e: Event) => {
      const target = e.target as Node;
      if (reorderMenuRef.current && !reorderMenuRef.current.contains(target)) {
        setIsReorderOpen(false);
      }
    };
    window.addEventListener('pointerdown', closeIfOutside);
    return () => window.removeEventListener('pointerdown', closeIfOutside);
  }, [isReorderOpen]);

  // Runs after every commit (no deps — same convention as the event-bus effect
  // above): applies any pending focus target queued by moveLyricsSection.
  useEffect(() => {
    const key = reorderFocusRef.current;
    if (!key) return;
    reorderFocusRef.current = null;
    const root = reorderMenuRef.current;
    if (!root) return;
    const btn = root.querySelector<HTMLButtonElement>(`[data-reorder-btn="${key}"]`);
    if (btn && !btn.disabled) {
      btn.focus();
      return;
    }
    // The section just hit the top/bottom — that arrow is now disabled; fall
    // back to the row's opposite arrow so focus never drops out of the popover.
    const [idx, dir] = key.split('-');
    root.querySelector<HTMLButtonElement>(`[data-reorder-btn="${idx}-${dir === 'up' ? 'down' : 'up'}"]`)?.focus();
  });

  // Swap the section at `index` with its neighbor, rebuild the full lyrics
  // string in the new order (original blank-line style preserved via the
  // parsed separator), and commit through updateLyricsWithHistory — which both
  // lands the move in the undo stack and pushes projectStore.update({ lyrics })
  // (see its definition above).
  const moveLyricsSection = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (index < firstMovableIndex || target < firstMovableIndex || target >= lyricsSections.length) return;
    const next = [...lyricsSections];
    [next[index], next[target]] = [next[target], next[index]];
    reorderFocusRef.current = `${target}-${direction === -1 ? 'up' : 'down'}`;
    updateLyricsWithHistory(rebuildLyricsFromSections(next, parsedLyrics.separator));
  };

  // AI modification call
  const handleAiModify = async (type: 'prompt' | 'lyrics') => {
    const isPromptType = type === 'prompt';
    // Synchronous re-entrancy guard — a repeat Enter (or double-fire) before
    // the loading state commits must not spend a second paid modify call.
    const loadingRef = isPromptType ? isPromptAiLoadingRef : isLyricsAiLoadingRef;
    if (loadingRef.current) return;
    const instruction = isPromptType ? promptAiInput : lyricsAiInput;
    if (!instruction.trim()) return;

    const currentText = isPromptType ? prompt : lyrics;
    const ref = isPromptType ? promptTextareaRef : lyricsTextareaRef;
    
    let selectedText = "";
    let selectionStart = 0;
    let selectionEnd = 0;

    if (ref.current) {
      selectionStart = ref.current.selectionStart;
      selectionEnd = ref.current.selectionEnd;
      if (selectionStart !== selectionEnd) {
        selectedText = currentText.substring(selectionStart, selectionEnd);
      }
    }

    loadingRef.current = true;
    if (isPromptType) {
      setIsPromptAiLoading(true);
    } else {
      setIsLyricsAiLoading(true);
    }

    try {
      const apiKey = localStorage.getItem('gemini_api_key');
      const openRouterApiKey = localStorage.getItem('openrouter_api_key');
      const aiProvider = localStorage.getItem('ai_provider');
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers['x-gemini-api-key'] = apiKey;
      }
      if (openRouterApiKey) {
        headers['x-openrouter-api-key'] = openRouterApiKey;
      }
      if (aiProvider) {
        headers['x-ai-provider'] = aiProvider;
      }

      const response = await fetch("/api/ai/modify", {
        method: "POST",
        headers,
        body: JSON.stringify({
          type,
          instruction,
          currentText,
          selectedText
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData.error || "AI refinement request failed.";
        if (typeof errMsg === 'string' && (errMsg.includes('Lightning dunning') || errMsg.includes('leaked'))) {
          alert('API Key Error: ' + errMsg + '\n\nPlease click the Settings button INSIDE THIS APP (the gear icon) to add your own custom Gemini API Key.');
        } else {
          alert('Refinement failed: ' + errMsg);
        }
        throw new Error(errMsg);
      }

      const data = await response.json();
      const aiResult = data.result || "";

      let updatedText = "";
      if (selectedText) {
        updatedText = currentText.substring(0, selectionStart) + aiResult + currentText.substring(selectionEnd);
      } else {
        updatedText = aiResult;
      }

      if (isPromptType) {
        updatePromptWithHistory(updatedText);
        setPromptAiInput("");
        setIsPromptWandOpen(false);
      } else {
        updateLyricsWithHistory(updatedText);
        setLyricsAiInput("");
        setIsLyricsWandOpen(false);
      }
    } catch (err) {
      console.error(err);
      alert('AI Modification failed. Please verify your connection or click the Settings button inside this app to set a custom GEMINI_API_KEY.');
    } finally {
      loadingRef.current = false;
      if (isPromptType) {
        setIsPromptAiLoading(false);
      } else {
        setIsLyricsAiLoading(false);
      }
    }
  };

  return (
    <div className="w-full shrink-0 flex flex-col gap-2">
      
      {/* Prompt Section */}
      <div
        ref={promptBoxRef}
        onMouseLeave={() => {
          const focusInside = promptBoxRef.current?.contains(document.activeElement);
          if (!isPromptPinned && !focusInside) {
            setIsPromptExpanded(false);
          }
        }}
        className="relative flex-shrink-0 transition-all duration-300"
        style={{ height: isPromptActive ? '420px' : '240px' }}
      >
        <div className={`absolute top-0 left-0 right-0 bg-[#110e0c]/85 backdrop-blur-lg rounded-xl border p-3 flex flex-col gap-2 shadow-[0_4px_20px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)] transition-all duration-300 ${
          isPromptActive
            ? 'h-[420px] z-40 border-lyria-gold/40 bg-[#14110f]/98 shadow-[0_15px_40px_rgba(0,0,0,0.95)]'
            : 'h-[240px] z-10 border-[#2b2521]'
        }`}>
          <div className="absolute inset-0 bg-gradient-to-t from-[#14110f] to-transparent opacity-50 pointer-events-none rounded-xl"></div>
          
          <div className="flex items-center justify-between relative z-10">
            <span className="font-display text-[10px] text-lyria-text-muted uppercase tracking-widest font-medium">PROMPT</span>
            <div className="flex items-center gap-2">
              <button onClick={() => {
                setPrompt('');
                updatePromptWithHistory('');
              }} title="Clear the prompt text (adds to undo history)" className="text-[10px] text-lyria-text-muted hover:text-lyria-text-main uppercase tracking-widest transition-colors duration-150 mr-1 cursor-pointer rounded lyria-focus-ring">CLEAR</button>
              <button
                onClick={() => setIsPromptPinned(!isPromptPinned)}
                className={`p-1 rounded hover:bg-black/30 transition-colors duration-150 cursor-pointer lyria-focus-ring ${isPromptPinned ? 'text-lyria-gold drop-shadow-[0_0_5px_rgba(214,180,133,0.5)]' : 'text-lyria-text-muted hover:text-lyria-text-main'}`}
                title={isPromptPinned ? "Unpin/Unlock Prompt" : "Pin/Lock Expanded Prompt"}
                aria-label={isPromptPinned ? "Unpin expanded prompt" : "Pin prompt expanded"}
                aria-pressed={isPromptPinned}
              >
                <Pin size={11} className={isPromptPinned ? 'rotate-45 text-lyria-gold' : ''} />
              </button>
            </div>
          </div>
          
          <div className={`relative bg-black/60 rounded-lg p-2.5 border border-[#2b2521] overflow-hidden group z-10 focus-within:border-lyria-gold/40 transition-all duration-300 ${
            isPromptActive ? 'h-[330px]' : 'h-[156px]'
          }`}>
            {/* AI Refinement Wand inside top right */}
            <div className="absolute top-2 right-2 flex items-center gap-1.5 z-20">
              {/* Undo / Redo Buttons */}
              <div className="flex items-center gap-0.5">
                <button
                  onClick={handlePromptUndo}
                  disabled={promptHistoryIndex === 0}
                  aria-label="Undo last prompt modification"
                  className={`p-1 rounded bg-black/50 border border-[#231e1a] transition-all duration-200 active:scale-95 lyria-focus-ring ${
                    promptHistoryIndex > 0
                      ? 'text-lyria-text-muted hover:text-lyria-text-main hover:border-lyria-gold/30 cursor-pointer'
                      : 'text-[#2b2521] cursor-not-allowed'
                  }`}
                  title="Undo last modification"
                >
                  <Undo size={10} />
                </button>
                <button
                  onClick={handlePromptRedo}
                  disabled={promptHistoryIndex >= promptHistory.length - 1}
                  aria-label="Redo last prompt modification"
                  className={`p-1 rounded bg-black/50 border border-[#231e1a] transition-all duration-200 active:scale-95 lyria-focus-ring ${
                    promptHistoryIndex < promptHistory.length - 1
                      ? 'text-lyria-text-muted hover:text-lyria-text-main hover:border-lyria-gold/30 cursor-pointer'
                      : 'text-[#2b2521] cursor-not-allowed'
                  }`}
                  title="Redo last modification"
                >
                  <Redo size={10} />
                </button>
              </div>

              {/* Expanding Pill Input */}
              <div className={`overflow-hidden transition-all duration-300 flex items-center ${
                isPromptWandOpen ? 'max-w-[180px] opacity-100 ml-1' : 'max-w-0 opacity-0 pointer-events-none'
              }`}>
                <input
                  type="text"
                  placeholder="AI Refine selection/all..."
                  aria-label="AI refinement instruction for the prompt"
                  value={promptAiInput}
                  onChange={(e) => setPromptAiInput(e.target.value)}
                  onKeyDown={(e) => {
                    // e.repeat: a held Enter must not queue extra paid calls;
                    // isComposing: Enter that commits an IME composition is not a submit.
                    if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing) {
                      handleAiModify('prompt');
                    }
                  }}
                  className="bg-[#120f0d] text-[11px] text-lyria-text-main px-3 py-1 rounded-full border border-lyria-gold/40 outline-none w-[140px] h-[22px] focus:border-lyria-gold placeholder-[#554e46] transition-colors duration-150"
                />
              </div>

              {/* Wand Circle Button */}
              <button
                onClick={() => setIsPromptWandOpen(!isPromptWandOpen)}
                aria-label="AI refine prompt"
                aria-expanded={isPromptWandOpen}
                className={`w-5 h-5 rounded-full flex items-center justify-center transition-all duration-300 relative cursor-pointer lyria-focus-ring ${
                  isPromptWandOpen
                    ? 'bg-lyria-gold text-black shadow-[0_0_8px_rgba(214,180,133,0.5)]'
                    : 'bg-[#1a1715] border border-[#2b2521] text-lyria-gold hover:bg-lyria-gold/15'
                }`}
                title="AI refine prompt — calls the text AI to rewrite the selection or full prompt"
              >
                {isPromptAiLoading ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Sparkles size={10} />
                )}
              </button>
            </div>

            <textarea
              ref={promptTextareaRef}
              aria-label="Music style prompt"
              className="w-full h-full bg-transparent text-sm text-lyria-text-main resize-none outline-none leading-relaxed placeholder-[#443e38] pr-12 overflow-y-auto"
              placeholder="Describe the music..."
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                // Simple state keeping without filling undo history on every keystroke
                if (!isApplyingLoadRef.current) projectStore.update({ prompt: e.target.value });
              }}
            />
          </div>

          {/* Footer Controls */}
          <div className="flex items-center justify-between relative z-10">
            <div className="flex items-center gap-2">
              <span title="Prompt character count" className="text-[10px] text-lyria-text-muted font-mono mr-1">{prompt.length} chars</span>
              <span className="text-[10px] text-lyria-text-muted uppercase tracking-widest ml-1">AUTO</span>
              <button onClick={() => setPromptAutoMode(!promptAutoMode)} aria-label="AUTO prompt enhancement before each generation" aria-pressed={promptAutoMode} className="w-8 h-4 rounded-full bg-[#1a1715] border border-[#2b2521] flex items-center px-0.5 transition-colors duration-150 cursor-pointer lyria-focus-ring" title="When on, AI rewrites your prompt (a paid text call) before each generation">
                 <div className={`w-3 h-3 rounded-full transition-all duration-300 ${promptAutoMode ? 'bg-lyria-gold translate-x-3.5 shadow-[0_0_8px_rgba(214,180,133,0.6)]' : 'bg-[#443e38]'}`}></div>
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsPromptExpanded(!isPromptExpanded)}
                aria-label={isPromptExpanded ? "Collapse prompt editor" : "Expand prompt editor"}
                aria-expanded={isPromptExpanded}
                className="hover:text-lyria-text-main active:scale-95 transition-all duration-150 text-lyria-text-muted cursor-pointer rounded lyria-focus-ring"
                title={isPromptExpanded ? "Collapse Prompt" : "Expand Prompt"}
              >
                <Maximize2 size={14} className={isPromptExpanded ? 'text-lyria-gold' : ''} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Lyrics Section */}
      <div 
        ref={lyricsBoxRef}
        onMouseLeave={() => {
          const focusInside = lyricsBoxRef.current?.contains(document.activeElement);
          if (!isLyricsPinned && !focusInside) {
            setIsLyricsExpanded(false);
          }
        }}
        className="relative flex-shrink-0 transition-all duration-300"
        style={{ height: isLyricsActive ? '560px' : '282px' }}
      >
        <div className={`absolute top-0 left-0 right-0 bg-[#110e0c]/85 backdrop-blur-lg rounded-xl border p-3 flex flex-col gap-2 shadow-[0_4px_20px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)] transition-all duration-300 ${
          isLyricsActive
            ? 'h-[560px] z-40 border-lyria-gold/40 bg-[#14110f]/98 shadow-[0_15px_40px_rgba(0,0,0,0.95)]'
            : 'h-[282px] z-10 border-[#2b2521]'
        }`}>
          <div className="absolute inset-0 bg-gradient-to-t from-[#14110f] to-transparent opacity-50 pointer-events-none rounded-xl"></div>
          
          <div className="flex items-center justify-between relative z-10">
            <span className="font-display text-[10px] text-lyria-text-muted uppercase tracking-widest font-medium">LYRICS</span>
            <div className="flex items-center gap-2">
              <button onClick={cycleLanguage} title="Vocal language (8 supported)" aria-label={`Vocal language: ${language} — click to cycle`} className="text-[9px] font-mono text-lyria-text-muted hover:text-lyria-gold border border-[#2b2521] rounded px-1.5 py-0.5 mr-1 transition-colors duration-150 active:scale-95 cursor-pointer lyria-focus-ring">{language}</button>
              <span className="text-[10px] text-lyria-text-muted uppercase tracking-widest">VOCALS</span>
              <button onClick={toggleVocals} aria-label="Vocals" aria-pressed={vocalsEnabled} className="w-8 h-4 rounded-full bg-[#1a1715] border border-[#2b2521] flex items-center px-0.5 mr-1 transition-colors duration-150 cursor-pointer lyria-focus-ring" title="On: the lyrics box is sung. Off: generates INSTRUMENTAL — lyrics are not sent and an 'Instrumental only — no vocals.' directive is added to the request (prompt box left untouched)">
                 <div className={`w-3 h-3 rounded-full transition-all duration-300 ${vocalsEnabled ? 'bg-lyria-gold translate-x-3.5 shadow-[0_0_8px_rgba(214,180,133,0.6)]' : 'bg-[#443e38]'}`}></div>
              </button>
              <button onClick={() => {
                setLyrics('');
                updateLyricsWithHistory('');
              }} title="Clear the lyrics text (adds to undo history)" className="text-[10px] text-lyria-text-muted hover:text-lyria-text-main uppercase tracking-widest transition-colors duration-150 mr-1 cursor-pointer rounded lyria-focus-ring">CLEAR</button>
              <button
                onClick={() => setIsLyricsPinned(!isLyricsPinned)}
                className={`p-1 rounded hover:bg-black/30 transition-colors duration-150 cursor-pointer lyria-focus-ring ${isLyricsPinned ? 'text-lyria-gold drop-shadow-[0_0_5px_rgba(214,180,133,0.5)]' : 'text-lyria-text-muted hover:text-lyria-text-main'}`}
                title={isLyricsPinned ? "Unpin/Unlock Lyrics" : "Pin/Lock Expanded Lyrics"}
                aria-label={isLyricsPinned ? "Unpin expanded lyrics" : "Pin lyrics expanded"}
                aria-pressed={isLyricsPinned}
              >
                <Pin size={11} className={isLyricsPinned ? 'rotate-45 text-lyria-gold' : ''} />
              </button>
            </div>
          </div>

          <div className={`relative bg-black/60 rounded-lg p-2.5 border border-[#2b2521] overflow-hidden group z-10 focus-within:border-lyria-gold/40 transition-all duration-300 ${
            isLyricsActive ? 'h-[466px]' : 'h-[198px]'
          }`}>
             {/* AI Refinement Wand inside top right */}
             <div className="absolute top-2 right-2 flex items-center gap-1.5 z-20">
               {/* Undo / Redo Buttons */}
               <div className="flex items-center gap-0.5">
                 <button
                   onClick={handleLyricsUndo}
                   disabled={lyricsHistoryIndex === 0}
                   aria-label="Undo last lyrics modification"
                   className={`p-1 rounded bg-black/50 border border-[#231e1a] transition-all duration-200 active:scale-95 lyria-focus-ring ${
                     lyricsHistoryIndex > 0
                       ? 'text-lyria-text-muted hover:text-lyria-text-main hover:border-lyria-gold/30 cursor-pointer'
                       : 'text-[#2b2521] cursor-not-allowed'
                   }`}
                   title="Undo last modification"
                 >
                   <Undo size={10} />
                 </button>
                 <button
                   onClick={handleLyricsRedo}
                   disabled={lyricsHistoryIndex >= lyricsHistory.length - 1}
                   aria-label="Redo last lyrics modification"
                   className={`p-1 rounded bg-black/50 border border-[#231e1a] transition-all duration-200 active:scale-95 lyria-focus-ring ${
                     lyricsHistoryIndex < lyricsHistory.length - 1
                       ? 'text-lyria-text-muted hover:text-lyria-text-main hover:border-lyria-gold/30 cursor-pointer'
                       : 'text-[#2b2521] cursor-not-allowed'
                   }`}
                   title="Redo last modification"
                 >
                   <Redo size={10} />
                 </button>
               </div>

               {/* Expanding Pill Input */}
               <div className={`overflow-hidden transition-all duration-300 flex items-center ${
                 isLyricsWandOpen ? 'max-w-[180px] opacity-100 ml-1' : 'max-w-0 opacity-0 pointer-events-none'
               }`}>
                 <input
                   type="text"
                   placeholder="AI Refine selection/all..."
                   aria-label="AI refinement instruction for the lyrics"
                   value={lyricsAiInput}
                   onChange={(e) => setLyricsAiInput(e.target.value)}
                   onKeyDown={(e) => {
                     // e.repeat: a held Enter must not queue extra paid calls;
                     // isComposing: Enter that commits an IME composition is not a submit.
                     if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing) {
                       handleAiModify('lyrics');
                     }
                   }}
                   className="bg-[#120f0d] text-[11px] text-lyria-text-main px-3 py-1 rounded-full border border-lyria-gold/40 outline-none w-[140px] h-[22px] focus:border-lyria-gold placeholder-[#554e46] transition-colors duration-150"
                 />
               </div>

               {/* Wand Circle Button */}
               <button
                 onClick={() => setIsLyricsWandOpen(!isLyricsWandOpen)}
                 aria-label="AI refine lyrics"
                 aria-expanded={isLyricsWandOpen}
                 className={`w-5 h-5 rounded-full flex items-center justify-center transition-all duration-300 relative cursor-pointer lyria-focus-ring ${
                   isLyricsWandOpen
                     ? 'bg-lyria-gold text-black shadow-[0_0_8px_rgba(214,180,133,0.5)]'
                     : 'bg-[#1a1715] border border-[#2b2521] text-lyria-gold hover:bg-lyria-gold/15'
                 }`}
                 title="AI refine lyrics — calls the text AI to rewrite the selection or full lyrics"
               >
                 {isLyricsAiLoading ? (
                   <Loader2 size={10} className="animate-spin" />
                 ) : (
                   <Sparkles size={10} />
                 )}
               </button>
             </div>
             
             <textarea
               ref={lyricsTextareaRef}
               aria-label="Lyrics"
               className="w-full h-full bg-transparent text-sm font-sans leading-[1.8] text-[#c0c0c8] resize-none outline-none placeholder-[#443e38] pr-12 overflow-y-auto"
               value={lyrics}
               onChange={(e) => {
                 setLyrics(e.target.value);
                 if (!isApplyingLoadRef.current) projectStore.update({ lyrics: e.target.value });
               }}
               placeholder="Write your lyrics here..."
             />
          </div>

          <div className="flex items-center justify-between relative z-10">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-lyria-text-muted uppercase tracking-widest ml-1">AUTO</span>
              <button onClick={() => setLyricsAutoMode(!lyricsAutoMode)} aria-label="AUTO lyrics writing before each generation" aria-pressed={lyricsAutoMode} className="w-8 h-4 rounded-full bg-[#1a1715] border border-[#2b2521] flex items-center px-0.5 transition-colors duration-150 cursor-pointer lyria-focus-ring" title="When on, AI writes/updates the lyrics to match your prompt (a paid text call) before each generation — the result lands in this box before generation fires">
                 <div className={`w-3 h-3 rounded-full transition-all duration-300 ${lyricsAutoMode ? 'bg-lyria-gold translate-x-3.5 shadow-[0_0_8px_rgba(214,180,133,0.6)]' : 'bg-[#443e38]'}`}></div>
              </button>
            </div>
            <div className="flex items-center gap-2 text-lyria-text-muted">
              <button
                onClick={() => setIsLyricsExpanded(!isLyricsExpanded)}
                aria-label={isLyricsExpanded ? "Collapse lyrics editor" : "Expand lyrics editor"}
                aria-expanded={isLyricsExpanded}
                className="hover:text-lyria-text-main active:scale-95 transition-all duration-150 text-lyria-text-muted cursor-pointer rounded lyria-focus-ring"
                title={isLyricsExpanded ? "Collapse Lyrics" : "Expand Lyrics"}
              >
                <Maximize2 size={14} className={isLyricsExpanded ? 'text-lyria-gold' : ''} />
              </button>
              {/* Reorder sections — parses [Tag] blocks out of the lyrics box and moves
                  whole sections up/down; same popover conventions as the model dropdown
                  (absolute, opens upward, outside-pointerdown closes, Escape closes). */}
              <div ref={reorderMenuRef} className="relative flex items-center">
                <button
                  ref={reorderTriggerRef}
                  onClick={() => { if (canReorderLyrics) setIsReorderOpen(open => !open); }}
                  disabled={!canReorderLyrics}
                  aria-label="Reorder lyrics sections"
                  aria-expanded={isReorderOpen && canReorderLyrics}
                  aria-haspopup="dialog"
                  title={canReorderLyrics
                    ? "Reorder lyrics sections — move [Verse]/[Chorus]/... blocks up or down"
                    : "No section tags to reorder — add tags like [Verse] or [Chorus] to the lyrics first"}
                  className={`active:scale-95 transition-all duration-150 rounded lyria-focus-ring ${
                    canReorderLyrics
                      ? `hover:text-lyria-text-main cursor-pointer ${isReorderOpen ? 'text-lyria-gold' : ''}`
                      : 'text-[#2b2521] cursor-not-allowed'
                  }`}
                >
                  <ArrowUpDown size={14} />
                </button>
                {isReorderOpen && canReorderLyrics && (
                  <div
                    role="dialog"
                    aria-label="Reorder lyrics sections"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setIsReorderOpen(false);
                        reorderTriggerRef.current?.focus();
                      }
                    }}
                    className="absolute bottom-[calc(100%+6px)] right-0 z-50 w-60 bg-[#14110f] border border-lyria-border rounded-lg shadow-2xl overflow-hidden"
                  >
                    <div className="px-2.5 py-1.5 border-b border-lyria-border font-display text-[9px] text-lyria-text-muted uppercase tracking-widest">Reorder sections</div>
                    <div role="list" className="max-h-48 overflow-y-auto">
                      {lyricsSections.map((section, i) => {
                        const pinned = section.tag === null;
                        const canUp = !pinned && i > firstMovableIndex;
                        const canDown = !pinned && i < lyricsSections.length - 1;
                        return (
                          <div key={`${i}-${section.tag ?? 'untagged'}`} role="listitem" className="flex items-center gap-2 px-2.5 py-1.5 border-b border-lyria-border/40 last:border-b-0">
                            <div className="flex-1 min-w-0">
                              <div className={`text-[10px] font-medium truncate ${pinned ? 'text-lyria-text-muted italic' : 'text-lyria-gold'}`}>
                                {pinned ? '(untagged)' : `[${section.tag}]`}
                              </div>
                              {section.preview && (
                                <div className="text-[9px] text-lyria-text-muted truncate">{section.preview}</div>
                              )}
                            </div>
                            {pinned ? (
                              <span className="text-[8px] text-lyria-text-muted uppercase tracking-widest shrink-0" title="Untagged text before the first section tag stays pinned at the top">PINNED</span>
                            ) : (
                              <div className="flex items-center gap-0.5 shrink-0">
                                <button
                                  onClick={() => moveLyricsSection(i, -1)}
                                  disabled={!canUp}
                                  data-reorder-btn={`${i}-up`}
                                  aria-label={`Move [${section.tag}] up (position ${i + 1} of ${lyricsSections.length})`}
                                  title="Move section up"
                                  className={`p-1 rounded bg-black/50 border border-[#231e1a] transition-all duration-200 active:scale-95 lyria-focus-ring ${
                                    canUp
                                      ? 'text-lyria-text-muted hover:text-lyria-text-main hover:border-lyria-gold/30 cursor-pointer'
                                      : 'text-[#2b2521] cursor-not-allowed'
                                  }`}
                                >
                                  <ChevronUp size={10} />
                                </button>
                                <button
                                  onClick={() => moveLyricsSection(i, 1)}
                                  disabled={!canDown}
                                  data-reorder-btn={`${i}-down`}
                                  aria-label={`Move [${section.tag}] down (position ${i + 1} of ${lyricsSections.length})`}
                                  title="Move section down"
                                  className={`p-1 rounded bg-black/50 border border-[#231e1a] transition-all duration-200 active:scale-95 lyria-focus-ring ${
                                    canDown
                                      ? 'text-lyria-text-muted hover:text-lyria-text-main hover:border-lyria-gold/30 cursor-pointer'
                                      : 'text-[#2b2521] cursor-not-allowed'
                                  }`}
                                >
                                  <ChevronDown size={10} />
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* References — Lyria 3 accepts text + up to 10 images (no audio input) */}
      <input
        type="file"
        ref={imageInputRef}
        className="hidden"
        accept="image/*"
        multiple
        onChange={(e) => {
          addImageFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDraggingImage(true);
        }}
        onDragLeave={() => {
          setIsDraggingImage(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDraggingImage(false);
          addImageFiles(Array.from(e.dataTransfer.files ?? []).filter(f => f.type.startsWith('image/')));
        }}
        onClick={() => {
          if (imageAssets.length < 10) imageInputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return; // the per-thumbnail remove buttons handle their own keys
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (imageAssets.length < 10) imageInputRef.current?.click();
          }
        }}
        aria-label={`Add image references (${imageAssets.length} of 10 used)`}
        title="Drop or click to add up to 10 image references (Lyria 3 accepts images; no audio input)"
        className={`w-full bg-lyria-panel rounded-xl border p-2 transition-all duration-300 group lyria-focus-ring ${
          imageAssets.length > 0
            ? 'border-lyria-gold/30 bg-[#16120f] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] cursor-pointer'
            : isDraggingImage
              ? 'border-lyria-gold bg-lyria-gold-dim/15 shadow-[0_0_15px_rgba(214,180,133,0.1)]'
              : 'border-lyria-border cursor-pointer active:scale-[0.99] hover:bg-lyria-panel-light'
        }`}
      >
        <div className="flex items-center justify-between">
          <span className={`font-display text-[9px] uppercase tracking-widest font-medium ${imageAssets.length ? 'text-lyria-gold' : 'text-lyria-text-main'}`}>IMAGE REFERENCES</span>
          <span className="text-[9px] text-lyria-text-muted font-mono">{imageAssets.length}/10</span>
        </div>
        {imageAssets.length === 0 ? (
          <div className="flex items-center gap-2 mt-1.5">
            <div className="w-6 h-6 rounded flex items-center justify-center bg-black/40 text-lyria-text-muted border border-lyria-border border-dashed group-hover:border-lyria-text-muted transition-colors duration-150">
              <ImageIcon size={12} />
            </div>
            <span className="text-[9px] text-lyria-text-muted">Drop up to 10 images, or click</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {imageAssets.map((img, i) => (
              <div key={img.url} className="relative w-8 h-8 rounded overflow-hidden border border-[#44382e] shadow-md group/thumb">
                <img src={img.url} className="w-full h-full object-cover" alt={img.name} />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeImageAt(i); // revokes the object URL, then drops the entry
                  }}
                  className="absolute inset-0 bg-black/60 opacity-0 group-hover/thumb:opacity-100 focus-visible:opacity-100 flex items-center justify-center text-white transition-opacity duration-150 cursor-pointer lyria-focus-ring"
                  title={`Remove ${img.name}`}
                  aria-label={`Remove image reference ${img.name}`}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            {imageAssets.length < 10 && (
              <div className="w-8 h-8 rounded flex items-center justify-center bg-black/40 text-lyria-text-muted border border-lyria-border border-dashed group-hover:border-lyria-text-muted transition-colors duration-150">
                <ImageIcon size={12} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Track name — optional, sent as `title` on the generate request (pinned contract;
          server ignores it silently until it lands). Component state only: not part of
          undo/redo, not persisted to the project store. Batch >1 appends " (2)", " (3)". */}
      <input
        type="text"
        value={trackName}
        onChange={(e) => setTrackName(e.target.value)}
        placeholder="Track name (optional)"
        aria-label="Track name (optional)"
        title="Optional name for the next generation — batches of >1 append (2), (3), etc."
        className="w-full h-8 shrink-0 bg-[#110e0c]/80 backdrop-blur-md rounded-lg border border-[#2b2521] px-3 text-[11px] text-lyria-text-main placeholder-[#554e46] outline-none focus:border-lyria-gold/40 transition-colors duration-150"
      />

      {/* Generate Button */}
      <button onClick={handleGenerate} title={`Generates ×${batchCount} version${batchCount > 1 ? 's' : ''} — total cost shown below`} className="w-full h-12 shrink-0 rounded-xl border border-lyria-gold/40 bg-gradient-to-b from-lyria-gold/10 to-transparent flex items-center justify-center gap-3 group relative overflow-hidden transition-all duration-150 hover:border-lyria-gold/60 active:scale-[0.98] cursor-pointer lyria-focus-ring lyria-breathe-glow">
        <div className={`absolute inset-0 bg-lyria-gold transition-opacity duration-300 ${isGenerating ? 'opacity-10' : 'opacity-0 group-hover:opacity-5'}`}></div>
        {/* Glow effect */}
        <div className="absolute left-4 w-10 h-10 bg-lyria-gold/20 blur-xl rounded-full"></div>

        {isGenerating ? (
          <div className="w-4 h-4 border-2 border-lyria-gold/30 border-t-lyria-gold rounded-full animate-spin relative z-10" />
        ) : (
          <Sparkles size={15} className="text-lyria-gold relative z-10" />
        )}
        <span className="text-sm tracking-[0.2em] font-medium text-lyria-gold relative z-10 uppercase">{isGenerating ? 'GENERATING...' : 'GENERATE'}</span>
        {!isGenerating && (
          <div className="absolute right-4 flex items-center gap-1 text-lyria-gold/80 text-[10px] font-sans border border-lyria-gold/20 rounded px-1.5 py-0.5">
            <span>⌘</span> <span>⏎</span>
          </div>
        )}
      </button>

      {/* Real spend for the current settings — model price × batchCount, plus
          OpenRouter balance and a floor-math "songs/clips remaining" estimate
          at the currently selected model's per-unit price, when that provider is active. */}
      <div className="flex items-center justify-center shrink-0 -mt-1">
        <span title="Real spend for the current model/batch settings, plus OpenRouter balance and estimated tracks remaining when that provider is active" className="text-[9px] text-lyria-text-muted font-mono tracking-wide">
          {model === "LYRIA 3 CLIP" ? "Clip" : "Pro"} ${costPerUnit.toFixed(2)}{batchCount > 1 ? ` ×${batchCount} · $${totalCost.toFixed(2)}` : ` · $${totalCost.toFixed(2)}`}
          {localStorage.getItem('ai_provider') === 'openrouter' && openRouterBalance !== null && (
            <span className={openRouterBalance < 0.5 ? 'text-lyria-signal' : ''}>
              {` · bal $${openRouterBalance.toFixed(2)} (≈${Math.floor(openRouterBalance / costPerUnit)} left)`}
            </span>
          )}
        </span>
      </div>

      {/* Model / Quality / Status */}
      <div className="flex items-center gap-2 shrink-0">
        <div ref={modelMenuRef} className="relative flex-1">
          <button
            onClick={() => setIsModelMenuOpen(open => !open)}
            title="Choose the generation model — each has its own per-track price"
            aria-expanded={isModelMenuOpen}
            aria-haspopup="menu"
            className="w-full h-8 bg-[#110e0c]/80 backdrop-blur-md rounded-lg border border-[#2b2521] px-2 shadow-[0_2px_10px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.02)] flex items-center justify-between hover:bg-[#1a1715] transition-colors duration-150 active:scale-95 cursor-pointer lyria-focus-ring"
          >
             <span className="text-[8px] text-lyria-text-muted uppercase tracking-widest">MODEL</span>
             <span className="flex items-center gap-1 text-[10px] text-lyria-text-main">{model} <ChevronDown size={10} className={`text-lyria-text-muted transition-transform duration-150 ${isModelMenuOpen ? 'rotate-180' : ''}`} /></span>
          </button>
          {isModelMenuOpen && (
            <div className="absolute bottom-[calc(100%+6px)] left-0 right-0 z-50 bg-[#14110f] border border-lyria-border rounded-lg shadow-2xl overflow-hidden">
              {MODEL_OPTIONS.map((opt) => (
                <button
                  key={opt.name}
                  onClick={() => selectModel(opt.name)}
                  title={`Switch to ${opt.name} — ${opt.priceLabel}`}
                  aria-pressed={opt.name === model}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-white/5 cursor-pointer lyria-focus-ring ${
                    opt.name === model ? 'bg-lyria-gold/10' : ''
                  }`}
                >
                  <span className={`text-[10px] font-medium ${opt.name === model ? 'text-lyria-gold' : 'text-lyria-text-main'}`}>{opt.name}</span>
                  <span className="text-[9px] text-lyria-text-muted font-mono shrink-0">{opt.priceLabel}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={cycleDuration} title={model === "LYRIA 3 CLIP" ? "Lyria 3 Clip is fixed at 0:30" : "Target duration — written into the prompt"} aria-disabled={model === "LYRIA 3 CLIP"} className={`h-8 shrink-0 bg-[#110e0c]/80 backdrop-blur-md rounded-lg border border-[#2b2521] px-2 shadow-[0_2px_10px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.02)] flex items-center gap-1.5 transition-colors duration-150 lyria-focus-ring ${model === "LYRIA 3 CLIP" ? 'opacity-50 cursor-not-allowed' : 'hover:bg-[#1a1715] active:scale-95 cursor-pointer'}`}>
           <span className="text-[8px] text-lyria-text-muted uppercase tracking-widest">DUR</span>
           <span className="text-[10px] font-mono text-lyria-text-main">{model === "LYRIA 3 CLIP" ? "0:30" : durationTarget}</span>
        </button>
        <button onClick={cycleBatch} title="Versions per generation — each is a full Lyria call, cost scales" className="h-8 shrink-0 bg-[#110e0c]/80 backdrop-blur-md rounded-lg border border-[#2b2521] px-2 shadow-[0_2px_10px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.02)] flex items-center gap-1.5 hover:bg-[#1a1715] transition-colors duration-150 active:scale-95 cursor-pointer lyria-focus-ring">
           <span className="text-[8px] text-lyria-text-muted uppercase tracking-widest">BATCH</span>
           <span className={`text-[10px] font-mono ${batchCount > 1 ? 'text-lyria-gold' : 'text-lyria-text-main'}`}>×{batchCount}</span>
        </button>
      </div>

    </div>
  );
}
