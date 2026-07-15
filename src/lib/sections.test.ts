import { describe, it, expect } from 'vitest';
import { parseTimestamp, formatSeconds, buildTimelineSections, sectionIndexAt } from './sections';

describe('parseTimestamp', () => {
  it('parses m:ss and mm:ss', () => {
    expect(parseTimestamp('0:00')).toBe(0);
    expect(parseTimestamp('0:16')).toBe(16);
    expect(parseTimestamp('1:04')).toBe(64);
    expect(parseTimestamp('02:46')).toBe(166);
  });

  it('parses h:mm:ss', () => {
    expect(parseTimestamp('1:02:03')).toBe(3723);
  });

  it('rejects garbage', () => {
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('abc')).toBeNull();
    expect(parseTimestamp('1:2:3:4')).toBeNull();
    expect(parseTimestamp('1:xx')).toBeNull();
    expect(parseTimestamp(42 as unknown as string)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });
});

describe('formatSeconds', () => {
  it('formats as m:ss', () => {
    expect(formatSeconds(0)).toBe('0:00');
    expect(formatSeconds(8)).toBe('0:08');
    expect(formatSeconds(64)).toBe('1:04');
    expect(formatSeconds(166)).toBe('2:46');
  });
});

describe('buildTimelineSections', () => {
  const detected = [
    { name: 'Intro', start: '00:00', end: '00:15' },
    { name: 'Build-up', start: '00:15', end: '00:25' },
    { name: 'Main Electro Section', start: '00:25', end: '00:46' },
    { name: 'Outro', start: '00:46', end: '00:54' },
  ];

  it('returns [] for missing/empty/unusable input — no structure is ever invented', () => {
    expect(buildTimelineSections(undefined)).toEqual([]);
    expect(buildTimelineSections(null)).toEqual([]);
    expect(buildTimelineSections([])).toEqual([]);
    expect(buildTimelineSections([{ name: 'X', start: 'bad', end: 'worse' }])).toEqual([]);
    expect(buildTimelineSections([{ name: 'X', start: '0:10', end: '0:05' }])).toEqual([]);
  });

  it('maps contiguous detected sections to widths that sum to 100%', () => {
    const out = buildTimelineSections(detected, 54);
    expect(out).toHaveLength(4);
    expect(out.every(s => !s.isGap)).toBe(true);
    const totalPct = out.reduce((acc, s) => acc + s.widthPct, 0);
    expect(totalPct).toBeCloseTo(100, 6);
    expect(out[2].name).toBe('Main Electro Section');
    expect(out[2].rangeLabel).toBe('0:25 - 0:46 (21s)');
  });

  it('uses the real measured duration as the total when it exceeds the last section end', () => {
    const out = buildTimelineSections(detected, 60); // 6s unmapped tail
    const tail = out[out.length - 1];
    expect(tail.isGap).toBe(true);
    expect(tail.startSeconds).toBe(54);
    expect(tail.endSeconds).toBe(60);
    expect(out.reduce((acc, s) => acc + s.widthPct, 0)).toBeCloseTo(100, 6);
  });

  it('inserts a gap spacer between non-contiguous sections', () => {
    const out = buildTimelineSections([
      { name: 'A', start: '0:00', end: '0:10' },
      { name: 'B', start: '0:20', end: '0:30' },
    ], 30);
    expect(out.map(s => [s.name, s.isGap])).toEqual([['A', false], ['', true], ['B', false]]);
    expect(out.reduce((acc, s) => acc + s.widthPct, 0)).toBeCloseTo(100, 6);
  });

  it('absorbs sub-threshold gaps and tails instead of rendering slivers', () => {
    const out = buildTimelineSections([
      { name: 'A', start: '0:00', end: '0:10' },
      { name: 'B', start: '0:11', end: '0:20' }, // 1s gap < threshold
    ], 21); // 1s tail < threshold
    expect(out.map(s => s.name)).toEqual(['A', 'B']);
    expect(out[1].endSeconds).toBe(21); // tail folded into B
    expect(out.reduce((acc, s) => acc + s.widthPct, 0)).toBeCloseTo(100, 6);
  });

  it('sorts unordered sections and yields on overlap', () => {
    const out = buildTimelineSections([
      { name: 'B', start: '0:10', end: '0:20' },
      { name: 'A', start: '0:00', end: '0:12' }, // overlaps B by 2s
    ], 20);
    expect(out.map(s => s.name)).toEqual(['A', 'B']);
    expect(out[0].endSeconds).toBe(12);
    expect(out[1].startSeconds).toBe(12);
  });
});

describe('sectionIndexAt', () => {
  const sections = buildTimelineSections([
    { name: 'A', start: '0:00', end: '0:10' },
    { name: 'B', start: '0:10', end: '0:20' },
  ], 20);

  it('locates the section for a playback position', () => {
    expect(sectionIndexAt(sections, 0)).toBe(0);
    expect(sectionIndexAt(sections, 9.9)).toBe(0);
    expect(sectionIndexAt(sections, 10)).toBe(1);
    expect(sectionIndexAt(sections, 19.9)).toBe(1);
  });

  it('returns null outside the mapped range or with no data', () => {
    expect(sectionIndexAt(sections, 25)).toBeNull();
    expect(sectionIndexAt(sections, -1)).toBeNull();
    expect(sectionIndexAt([], 5)).toBeNull();
    expect(sectionIndexAt(sections, NaN)).toBeNull();
  });
});
