// Pure mapping from a version's real audio analysis (Analysis.sections, mm:ss
// timestamps detected from the actual generated audio) to timeline segments with
// percentage widths. This is the only source of the timeline's section header —
// there is no hardcoded structure anywhere: no analysis, no sections.
//
// Kept free of React/DOM so it can be unit-tested in the vitest node environment
// alongside the server suites.

export interface AnalysisSectionLike {
  name: string;
  start: string; // mm:ss
  end: string; // mm:ss
}

export interface TimelineSection {
  /** Detected section name (uppercased for the display header), '' for a gap spacer. */
  name: string;
  startSeconds: number;
  endSeconds: number;
  /** Percentage of the full track width, 0-100. */
  widthPct: number;
  /** Human range label, e.g. "0:25 - 0:46 (21s)". */
  rangeLabel: string;
  /** True for unnamed filler between/after detected sections — rendered dim, not selectable. */
  isGap: boolean;
}

/** Parses "m:ss" / "mm:ss" (and tolerant "h:mm:ss") into seconds; null when unusable. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some(p => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  const seconds = nums.reduce((acc, n) => acc * 60 + n, 0);
  return Number.isFinite(seconds) ? seconds : null;
}

/** Formats seconds as "m:ss" (matching the transport's readout style). */
export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function rangeLabel(start: number, end: number): string {
  return `${formatSeconds(start)} - ${formatSeconds(end)} (${Math.max(0, Math.round(end - start))}s)`;
}

/** Gaps shorter than this are absorbed into the neighboring section instead of rendered. */
const MIN_GAP_SECONDS = 1.5;

/**
 * Builds contiguous timeline segments covering [0, total] from detected analysis
 * sections. `durationSeconds` (the real measured track duration from the manifest)
 * wins as the total when present; otherwise the last section's end is trusted.
 * Unparseable/degenerate sections are dropped; gaps between detected sections become
 * unnamed spacer segments so widths always sum to the full track. Returns [] when
 * nothing usable remains — callers must render no structure in that case.
 */
export function buildTimelineSections(
  sections: AnalysisSectionLike[] | undefined | null,
  durationSeconds?: number,
): TimelineSection[] {
  if (!sections || sections.length === 0) return [];

  const parsed = sections
    .map(sec => ({
      name: (sec.name ?? '').trim(),
      start: parseTimestamp(sec.start),
      end: parseTimestamp(sec.end),
    }))
    .filter((sec): sec is { name: string; start: number; end: number } =>
      sec.start !== null && sec.end !== null && sec.end > sec.start)
    .sort((a, b) => a.start - b.start);

  if (parsed.length === 0) return [];

  const lastEnd = parsed[parsed.length - 1].end;
  const total = durationSeconds && durationSeconds > 0 ? Math.max(durationSeconds, lastEnd) : lastEnd;
  if (total <= 0) return [];

  const out: TimelineSection[] = [];
  let cursor = 0;

  const push = (name: string, start: number, end: number, isGap: boolean) => {
    const clampedStart = Math.max(0, Math.min(total, start));
    const clampedEnd = Math.max(clampedStart, Math.min(total, end));
    if (clampedEnd - clampedStart <= 0) return;
    out.push({
      name,
      startSeconds: clampedStart,
      endSeconds: clampedEnd,
      widthPct: ((clampedEnd - clampedStart) / total) * 100,
      rangeLabel: rangeLabel(clampedStart, clampedEnd),
      isGap,
    });
  };

  for (const sec of parsed) {
    const start = Math.max(cursor, sec.start); // overlapping sections: later one yields
    if (start - cursor >= MIN_GAP_SECONDS) {
      push('', cursor, start, true);
    }
    const effectiveStart = start - cursor < MIN_GAP_SECONDS ? cursor : start; // absorb sub-threshold gap
    if (sec.end > effectiveStart) {
      push(sec.name, effectiveStart, sec.end, false);
      cursor = sec.end;
    }
  }

  if (total - cursor >= MIN_GAP_SECONDS) {
    push('', cursor, total, true);
  } else if (total > cursor && out.length > 0) {
    // Stretch the final segment over a sub-threshold tail so widths total 100%.
    const last = out[out.length - 1];
    last.endSeconds = total;
    last.widthPct = ((last.endSeconds - last.startSeconds) / total) * 100;
    last.rangeLabel = rangeLabel(last.startSeconds, last.endSeconds);
  }

  return out;
}

/** Index of the segment containing playback position `seconds`, or null when outside/no data. */
export function sectionIndexAt(sections: TimelineSection[], seconds: number): number | null {
  if (sections.length === 0 || !Number.isFinite(seconds) || seconds < 0) return null;
  for (let i = 0; i < sections.length; i++) {
    if (seconds < sections[i].endSeconds) return i;
  }
  return null;
}
