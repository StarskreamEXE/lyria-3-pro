import { describe, it, expect } from 'vitest';
import { stripProviderLyricMarkup } from './lyricsText';

// The fixtures below are copied verbatim out of real manifests in generations/
// (OpenRouter responses), not invented, so the cleanup is proven against the
// exact shapes the provider actually returns.

describe('stripProviderLyricMarkup', () => {
  it('cleans the structural-id + open-ended-timing shape (gen-1784156639458-zxmlwn)', () => {
    const raw = "[[A0]]\n[[B1]]\n[10.3:] To sleep,\n[:] Perchance, to dream....\n[[C2]]";
    expect(stripProviderLyricMarkup(raw)).toBe('To sleep,\nPerchance, to dream....');
  });

  it('cleans the paired-timing shape (gen-1790083578504-wizy88)', () => {
    const raw = '[2.0:6.1] Neon on the water, engines in the rain\n'
      + '[10.1:16.2] We run until the city forgets our names';
    expect(stripProviderLyricMarkup(raw)).toBe(
      'Neon on the water, engines in the rain\nWe run until the city forgets our names',
    );
  });

  it('keeps every lyric line of a long real response and drops only the markup', () => {
    const raw = "[[A0]]\n[[B1]]\n[30.0:] City lights don't sleep\n[:] They pull me underground\n"
      + "[:] Heartbeat in the streets\n[:] Lost but I'm not down\n[[C2]]\n"
      + '[60.0:] Whispers in the dark\n[:] Calling out my name\n[:] I follow the spark\n'
      + '[:] Straight into the flame';
    expect(stripProviderLyricMarkup(raw).split('\n')).toEqual([
      "City lights don't sleep",
      'They pull me underground',
      'Heartbeat in the streets',
      "Lost but I'm not down",
      'Whispers in the dark',
      'Calling out my name',
      'I follow the spark',
      'Straight into the flame',
    ]);
  });

  it('handles integer-only and zero timings', () => {
    const raw = '[0.0:] We run until the city forgets our names\n[4:8] Swallowed by the shadows';
    expect(stripProviderLyricMarkup(raw)).toBe(
      'We run until the city forgets our names\nSwallowed by the shadows',
    );
  });

  it('leaves already-clean lyrics untouched, section tags and blank lines included', () => {
    const raw = "[Verse]\nCity lights don't sleep\nThey pull me underground\n\n"
      + '[Pre-Chorus]\nWhispers in the dark\nCalling out my name';
    expect(stripProviderLyricMarkup(raw)).toBe(raw);
  });

  it('preserves real section tags mixed into provider markup', () => {
    const raw = '[[A0]]\n[Verse 1]\n[2.0:6.1] Neon on the water\n[[B1]]\n[Chorus]\n[6.1:9.0] We run\n'
      + '[Pre-Chorus]\n[Bridge]\n[Outro]';
    expect(stripProviderLyricMarkup(raw).split('\n')).toEqual([
      '[Verse 1]',
      'Neon on the water',
      '[Chorus]',
      'We run',
      '[Pre-Chorus]',
      '[Bridge]',
      '[Outro]',
    ]);
  });

  it('never mistakes a bracketed tag containing letters for timing markup', () => {
    expect(stripProviderLyricMarkup('[Mock] instrumental')).toBe('[Mock] instrumental');
    expect(stripProviderLyricMarkup('[Chorus: 2x]\nWe run')).toBe('[Chorus: 2x]\nWe run');
    expect(stripProviderLyricMarkup('[Verse 2]')).toBe('[Verse 2]');
  });

  it('collapses the blank runs the removals leave behind', () => {
    const raw = '[[A0]]\n\n\n[2.0:6.0] Neon on the water\n\n\n\n[[B1]]\n\n[6.1:9.0] We run\n\n[[C2]]\n\n';
    expect(stripProviderLyricMarkup(raw)).toBe('Neon on the water\n\nWe run');
  });

  it('returns an empty string for empty, whitespace-only or markup-only input', () => {
    expect(stripProviderLyricMarkup('')).toBe('');
    expect(stripProviderLyricMarkup('   \n\t\n  ')).toBe('');
    expect(stripProviderLyricMarkup('[[A0]]\n[[B1]]\n[[C2]]')).toBe('');
    expect(stripProviderLyricMarkup('[[A0]]\n[30.9:]\n[:]\n[[D6]]')).toBe('');
  });

  it('never throws on values a JS caller can hand it from an untyped manifest', () => {
    expect(stripProviderLyricMarkup(undefined as unknown as string)).toBe('');
    expect(stripProviderLyricMarkup(null as unknown as string)).toBe('');
    expect(stripProviderLyricMarkup(42 as unknown as string)).toBe('');
    expect(stripProviderLyricMarkup({} as unknown as string)).toBe('');
  });

  it('handles CRLF line endings from a Windows-side paste', () => {
    const raw = '[[A0]]\r\n[10.3:] To sleep,\r\n[:] Perchance, to dream....\r\n[[C2]]\r\n';
    expect(stripProviderLyricMarkup(raw)).toBe('To sleep,\nPerchance, to dream....');
  });

  it('strips a structural id and a timing prefix that share a line', () => {
    expect(stripProviderLyricMarkup('[[B1]] [10.3:] To sleep,')).toBe('To sleep,');
  });

  it('strips repeated timing prefixes on one line', () => {
    expect(stripProviderLyricMarkup('[0.0:] [4.1:] We run')).toBe('We run');
  });

  it('is idempotent — cleaning already-cleaned output changes nothing', () => {
    const raw = "[[A0]]\n[[B1]]\n[10.3:] To sleep,\n[:] Perchance, to dream....\n[[C2]]";
    const once = stripProviderLyricMarkup(raw);
    expect(stripProviderLyricMarkup(once)).toBe(once);
  });
});
