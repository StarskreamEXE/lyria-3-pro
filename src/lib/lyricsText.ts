// Cleanup for the lyrics a provider returns alongside generated audio.
//
// OpenRouter echoes the sung lyrics wrapped in its own structural and timing
// markup — `[[A0]]` section ids and `[2.0:6.1]` / `[10.3:]` / `[:]` timing
// prefixes — which is noise to a reader. Real section tags like `[Chorus]`
// are meaningful and stay. Shared by the timeline inspector and by the
// history "load with settings" path so both show the same clean text.

/** `[[A0]]`, `[[B12]]` — provider structural ids, normally alone on their line. */
const STRUCTURAL_TOKEN = /^\s*\[\[[^\]]*\]\]\s*/;

/** `[2.0:6.1] `, `[10.3:] `, `[:] ` — leading timing prefix on a lyric line. */
const TIMING_PREFIX = /^\s*\[\s*\d*(?:\.\d+)?\s*:\s*\d*(?:\.\d+)?\s*\]\s*/;

/** Peels every leading structural id / timing prefix off one line. */
function stripLeadingMarkup(line: string): string {
  let text = line;
  for (;;) {
    const next = text.replace(STRUCTURAL_TOKEN, '').replace(TIMING_PREFIX, '');
    if (next === text) return text;
    text = next;
  }
}

/**
 * Strips provider structural/timing markup from returned lyrics, preserving
 * real section tags, the lyric lines themselves, and their ordering. Never
 * throws; empty, whitespace-only or non-string input returns an empty string.
 */
export function stripProviderLyricMarkup(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';

  const cleaned: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = stripLeadingMarkup(line).trimEnd();
    // A line emptied by the removals was pure markup: drop it outright so no
    // hole is left. Blank lines the writer put there survive, but only one
    // per run and never at the very start or end.
    if (!text.trim() && line.trim()) continue;
    if (!text.trim() && !cleaned.length) continue;
    if (!text.trim() && !cleaned[cleaned.length - 1]?.trim()) continue;
    cleaned.push(text);
  }

  while (cleaned.length && !cleaned[cleaned.length - 1].trim()) cleaned.pop();
  return cleaned.join('\n');
}
