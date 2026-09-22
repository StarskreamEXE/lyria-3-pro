import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assembleLyriaPrompt } from './lyria';
import { parseInteraction } from './lyria';
import { makeMockWav } from './lyria';
import { parseOpenRouterAudioSSE } from './lyria';
import { generateLyria } from './lyria';
import { listGenerations } from './lyria';
import type { GenerationManifest } from './lyria';
import { parseAnalysis } from './lyria';
import { analyzeGeneration, AnalysisNotFoundError } from './lyria';
import type { Analysis } from './lyria';
import { embedWavInfo } from './lyria';
import { embedId3 } from './lyria';
import { detectAudioFormat } from './lyria';
import { wavDurationSeconds, mp3DurationSeconds, computeDurationSeconds } from './lyria';
import { renameGeneration, GenerationNotFoundError } from './lyria';
import { assertSafeId, InvalidIdError, MissingKeyError, writeJsonAtomic } from './lyria';
import { mockModifyText, mockEnhancePrompt, buildMockAnalysis } from './lyria';
import { mapOpenRouterCreditsResponse } from './lyria';

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('assembleLyriaPrompt', () => {
  it('combines prompt, duration, language and lyrics', () => {
    const result = assembleLyriaPrompt({
      prompt: 'Cinematic darkwave track. 128bpm.',
      lyrics: '[Verse]\nCity lights',
      language: 'EN',
      durationTarget: '3:00',
    });
    expect(result).toContain('Cinematic darkwave track. 128bpm.');
    expect(result).toContain('Total running time: 3:00.');
    expect(result).toContain('Lyrics (sing in EN):');
    expect(result).toContain('[Verse]\nCity lights');
  });

  it('omits lyrics block when lyrics empty → instrumental NOT forced', () => {
    const result = assembleLyriaPrompt({
      prompt: 'Lo-fi beat',
      lyrics: '   ',
      language: 'EN',
      durationTarget: '2:00',
    });
    expect(result).not.toContain('Lyrics');
    expect(result).toContain('Lo-fi beat');
  });

  it('omits duration sentence for clip model', () => {
    const result = assembleLyriaPrompt({
      prompt: 'Jingle',
      lyrics: '',
      language: 'EN',
      durationTarget: '3:00',
      model: 'clip',
    });
    expect(result).not.toContain('Total running time');
    expect(result).not.toContain('3:00');
  });

  it('throws on empty prompt', () => {
    expect(() =>
      assembleLyriaPrompt({ prompt: ' ', lyrics: '', language: 'EN', durationTarget: '3:00' }),
    ).toThrow();
  });

  // ITEM 5: the old wording ("Target duration: approximately X.") was too weak — a 1:00 target
  // came back as a 2:19 track on OpenRouter Pro. The instruction must now name the total running
  // time AND the end timestamp, unambiguously, and say it exactly once.
  it('states the duration as an explicit total running time plus an end timestamp', () => {
    const result = assembleLyriaPrompt({
      prompt: 'Synthwave',
      lyrics: '',
      language: 'EN',
      durationTarget: '1:00',
    });
    expect(result).toContain('Total running time: 1:00.');
    expect(result).toContain('starts at 0:00');
    expect(result).toContain('final note at 1:00');
    expect(result).toMatch(/do not end early/i);
    expect(result).toMatch(/do not run past 1:00/i);
  });

  it('does not hedge the duration with "approximately"', () => {
    const result = assembleLyriaPrompt({
      prompt: 'Synthwave',
      lyrics: '',
      language: 'EN',
      durationTarget: '2:30',
    });
    expect(result).not.toMatch(/approximately/i);
  });

  it('states the duration instruction exactly once (one block, one running-time sentence)', () => {
    const result = assembleLyriaPrompt({
      prompt: 'Synthwave',
      lyrics: '[Verse] hello',
      language: 'EN',
      durationTarget: '2:30',
    });
    expect(result.match(/Total running time:/g)).toHaveLength(1);
  });

  it('omits the duration block entirely when no durationTarget is given', () => {
    const result = assembleLyriaPrompt({
      prompt: 'Synthwave',
      lyrics: '',
      language: 'EN',
      durationTarget: '',
    });
    expect(result).not.toContain('Total running time');
    expect(result).toBe('Synthwave');
  });
});

describe('parseInteraction', () => {
  it('extracts audio and text from steps', () => {
    const result = parseInteraction({
      id: 'int_1',
      steps: [
        {
          type: 'model_output',
          content: [
            { type: 'audio', data: b64('AUDIO1') },
            { type: 'text', text: '[Verse] hello' },
            { type: 'text', text: '{"structure":[{"name":"Intro"}]}' },
          ],
        },
      ],
    });
    expect(result.interactionId).toBe('int_1');
    expect(result.audio.toString()).toBe('AUDIO1');
    expect(result.textBlocks).toEqual(['[Verse] hello']);
    expect(result.jsonBlocks).toEqual([{ structure: [{ name: 'Intro' }] }]);
  });

  it('falls back to output_audio/output_text conveniences', () => {
    const result = parseInteraction({
      output_audio: { data: b64('AUDIO2') },
      output_text: 'plain lyrics',
    });
    expect(result.audio.toString()).toBe('AUDIO2');
    expect(result.textBlocks).toEqual(['plain lyrics']);
  });

  it('throws when no audio present', () => {
    expect(() => parseInteraction({ steps: [] })).toThrow(/no audio/i);
  });
});

describe('makeMockWav', () => {
  it('produces a valid RIFF/WAVE header and ~N seconds of audio', () => {
    const wav = makeMockWav(2);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    // 44 header + 2s * 44100 * 2ch * 2bytes
    expect(wav.length).toBe(44 + 2 * 44100 * 4);
  });
});

describe('parseOpenRouterAudioSSE', () => {
  const sseLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

  it('reassembles base64 audio fragments split across multiple chunks, in order', () => {
    const fullAudio = Buffer.from('THIS IS SOME FAKE AUDIO BYTES').toString('base64');
    // Split the base64 string into three fragments to simulate SSE chunking.
    const third = Math.ceil(fullAudio.length / 3);
    const frag1 = fullAudio.slice(0, third);
    const frag2 = fullAudio.slice(third, third * 2);
    const frag3 = fullAudio.slice(third * 2);

    const sse =
      sseLine({ choices: [{ delta: { audio: { data: frag1 } } }] }) +
      sseLine({ choices: [{ delta: { audio: { data: frag2 } } }] }) +
      sseLine({ choices: [{ delta: { audio: { data: frag3 } } }] }) +
      'data: [DONE]\n\n';

    const result = parseOpenRouterAudioSSE(sse);
    expect(result.audio.toString()).toBe('THIS IS SOME FAKE AUDIO BYTES');
  });

  it('accumulates transcript fragments in order', () => {
    // Split one base64-encoded payload across two chunks (as a real provider would
    // fragment the underlying byte stream), each carrying its own transcript piece.
    const fullB64 = b64('AB');
    const half = Math.ceil(fullB64.length / 2);
    const sse =
      sseLine({ choices: [{ delta: { audio: { data: fullB64.slice(0, half), transcript: 'Hello ' } } }] }) +
      sseLine({ choices: [{ delta: { audio: { data: fullB64.slice(half), transcript: 'world' } } }] }) +
      'data: [DONE]\n\n';

    const result = parseOpenRouterAudioSSE(sse);
    expect(result.transcript).toBe('Hello world');
    expect(result.audio.toString()).toBe('AB');
  });

  it('collects delta.content text blocks separately from audio transcript', () => {
    const sse =
      sseLine({ choices: [{ delta: { content: 'Some plain text.' } }] }) +
      sseLine({ choices: [{ delta: { audio: { data: b64('X'), transcript: 'lyric line' } } }] }) +
      sseLine({ choices: [{ delta: { content: ' More text.' } }] }) +
      'data: [DONE]\n\n';

    const result = parseOpenRouterAudioSSE(sse);
    expect(result.textBlocks).toEqual(['Some plain text.', ' More text.']);
    expect(result.transcript).toBe('lyric line');
    expect(result.audio.toString()).toBe('X');
  });

  it('stops processing at the [DONE] sentinel and ignores anything after it', () => {
    const sse =
      sseLine({ choices: [{ delta: { audio: { data: b64('KEEP') } } }] }) +
      'data: [DONE]\n\n' +
      sseLine({ choices: [{ delta: { audio: { data: b64('IGNORED') } } }] });

    const result = parseOpenRouterAudioSSE(sse);
    expect(result.audio.toString()).toBe('KEEP');
  });

  it('ignores malformed JSON and keep-alive lines without throwing', () => {
    const sse =
      ': keep-alive\n\n' +
      'data: not-json-at-all\n\n' +
      sseLine({ choices: [{ delta: { audio: { data: b64('OK') } } }] }) +
      '\n' +
      'data: [DONE]\n\n';

    const result = parseOpenRouterAudioSSE(sse);
    expect(result.audio.toString()).toBe('OK');
  });

  it('throws an error mentioning "no audio" when zero audio fragments are present', () => {
    const sse =
      sseLine({ choices: [{ delta: { content: 'just text, no audio' } }] }) +
      'data: [DONE]\n\n';

    expect(() => parseOpenRouterAudioSSE(sse)).toThrow(/no audio/i);
  });
});

describe('generateLyria (mock mode)', () => {
  const GEN_DIR = path.join(process.cwd(), 'generations');
  const prevMock = process.env.LYRIA_MOCK;
  let createdId: string | undefined;

  beforeEach(() => {
    process.env.LYRIA_MOCK = '1';
  });

  afterEach(async () => {
    process.env.LYRIA_MOCK = prevMock;
    // Clean up only the fixture this test itself created, leaving any real
    // generations produced by the live dev server untouched.
    if (createdId) {
      await fs.rm(path.join(GEN_DIR, `${createdId}.wav`), { force: true });
      await fs.rm(path.join(GEN_DIR, `${createdId}.json`), { force: true });
      createdId = undefined;
    }
  });

  it('returns provider: "mock" without making any real API call', async () => {
    const result = await generateLyria(null, { prompt: 'Lo-fi beat for testing' });
    createdId = result.id;

    expect(result.provider).toBe('mock');
    expect(result.audioUrl).toBe(`/generations/${result.id}.wav`);
    expect(result.lyrics).toBe('[Mock] instrumental');
  });

  it('carries the request prompt on the result, matching the persisted manifest', async () => {
    const result = await generateLyria(null, { prompt: 'Lo-fi beat for testing' });
    createdId = result.id;

    expect(result.prompt).toBe('Lo-fi beat for testing');
  });

  it('omits structure on the mock path', async () => {
    const result = await generateLyria(null, { prompt: 'Another mock track' });
    createdId = result.id;

    expect(result.structure).toBeUndefined();
  });
});

describe('listGenerations', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyria-generations-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns [] for a missing directory', async () => {
    const missingDir = path.join(tmpDir, 'does-not-exist');
    expect(await listGenerations(missingDir)).toEqual([]);
  });

  it('returns [] for an empty directory', async () => {
    expect(await listGenerations(tmpDir)).toEqual([]);
  });

  it('parses manifests, derives audioUrl, and sorts newest-first', async () => {
    const older: GenerationManifest = {
      id: 'gen-older',
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'older prompt',
      lyrics: 'older lyrics',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const newer: GenerationManifest = {
      id: 'gen-newer',
      model: 'lyria-3-clip-preview',
      format: 'mp3',
      provider: 'gemini',
      prompt: 'newer prompt',
      lyrics: 'newer lyrics',
      generatedAt: '2026-06-01T00:00:00.000Z',
      structure: [{ name: 'Intro' }],
    };

    await fs.writeFile(path.join(tmpDir, `${older.id}.json`), JSON.stringify(older), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${newer.id}.json`), JSON.stringify(newer), 'utf8');

    const result = await listGenerations(tmpDir);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('gen-newer');
    expect(result[0].audioUrl).toBe('/generations/gen-newer.mp3');
    expect(result[0].structure).toEqual([{ name: 'Intro' }]);
    expect(result[1].id).toBe('gen-older');
    expect(result[1].audioUrl).toBe('/generations/gen-older.wav');
  });

  it('skips unparseable manifest files with a console.warn instead of throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fs.writeFile(path.join(tmpDir, 'gen-broken.json'), '{ not valid json', 'utf8');
    const good: GenerationManifest = {
      id: 'gen-good',
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'ok prompt',
      lyrics: 'ok lyrics',
      generatedAt: '2026-03-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, `${good.id}.json`), JSON.stringify(good), 'utf8');

    const result = await listGenerations(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('gen-good');
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('ignores non-.json files in the directory', async () => {
    await fs.writeFile(path.join(tmpDir, 'gen-x.wav'), 'not a manifest', 'utf8');
    expect(await listGenerations(tmpDir)).toEqual([]);
  });
});

describe('parseAnalysis', () => {
  const validPayload = {
    title: 'Neon Undertow',
    genre: 'Darkwave',
    mood: 'Brooding',
    energy: 72,
    bpm: 128,
    key: 'A minor',
    instrumentation: ['synth bass', 'female vocals', 'drum machine'],
    sections: [
      { name: 'Intro', start: '0:00', end: '0:24' },
      { name: 'Verse', start: '0:24', end: '1:02' },
    ],
    notes: 'Builds from tension to release with a driving four-on-the-floor beat.',
  };

  it('parses a valid raw JSON payload as-is', () => {
    const result = parseAnalysis(JSON.stringify(validPayload));
    expect(result).toEqual(validPayload);
  });

  it('strips ``` fences (with or without a json language tag) before parsing', () => {
    const fenced = '```json\n' + JSON.stringify(validPayload) + '\n```';
    expect(parseAnalysis(fenced)).toEqual(validPayload);

    const fencedNoLang = '```\n' + JSON.stringify(validPayload) + '\n```';
    expect(parseAnalysis(fencedNoLang)).toEqual(validPayload);
  });

  it('clamps energy into the 0-100 range', () => {
    const tooHigh = parseAnalysis(JSON.stringify({ ...validPayload, energy: 150 }));
    expect(tooHigh.energy).toBe(100);

    const tooLow = parseAnalysis(JSON.stringify({ ...validPayload, energy: -20 }));
    expect(tooLow.energy).toBe(0);

    const fractional = parseAnalysis(JSON.stringify({ ...validPayload, energy: 55.7 }));
    expect(Number.isInteger(fractional.energy)).toBe(true);
  });

  it('coerces missing optionals: null bpm/key, [] arrays, trimmed strings', () => {
    const sparse = {
      title: '  Untitled Sketch  ',
      genre: 'Ambient',
      mood: 'Calm',
      energy: 10,
      notes: '  minimal sparse recording  ',
    };
    const result = parseAnalysis(JSON.stringify(sparse));
    expect(result.bpm).toBeNull();
    expect(result.key).toBeNull();
    expect(result.instrumentation).toEqual([]);
    expect(result.sections).toEqual([]);
    expect(result.title).toBe('Untitled Sketch');
    expect(result.notes).toBe('minimal sparse recording');
  });

  it('coerces an explicit null bpm/key through unchanged', () => {
    const result = parseAnalysis(JSON.stringify({ ...validPayload, bpm: null, key: null }));
    expect(result.bpm).toBeNull();
    expect(result.key).toBeNull();
  });

  it('throws on unparseable garbage text', () => {
    expect(() => parseAnalysis('not json at all, sorry')).toThrow();
  });

  it('throws when the payload is valid JSON but not a usable object (e.g. an array)', () => {
    expect(() => parseAnalysis('[1, 2, 3]')).toThrow();
  });

  it('throws when required string fields are missing entirely', () => {
    expect(() => parseAnalysis(JSON.stringify({ energy: 50 }))).toThrow();
  });
});

describe('analyzeGeneration (cached-manifest short-circuit)', () => {
  let tmpDir: string;
  const prevMock = process.env.LYRIA_MOCK;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyria-analyze-test-'));
    // Hermeticity: these tests exercise the REAL provider path, which the LYRIA_MOCK
    // gate would short-circuit if the variable leaked in from the ambient environment.
    delete process.env.LYRIA_MOCK;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (prevMock === undefined) {
      delete process.env.LYRIA_MOCK;
    } else {
      process.env.LYRIA_MOCK = prevMock;
    }
  });

  const cachedAnalysis: Analysis = {
    title: 'Cached Track',
    genre: 'Synthwave',
    mood: 'Nostalgic',
    energy: 60,
    bpm: 110,
    key: 'C major',
    instrumentation: ['synth lead'],
    sections: [{ name: 'Intro', start: '0:00', end: '0:15' }],
    notes: 'Previously analyzed.',
  };

  it('returns the cached analysis without invoking the provider callback when analysis exists and force is falsy', async () => {
    const manifest: GenerationManifest & { analysis: Analysis } = {
      id: 'gen-1-cached',
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'cached prompt',
      lyrics: 'cached lyrics',
      generatedAt: '2026-01-01T00:00:00.000Z',
      analysis: cachedAnalysis,
    };
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.wav`), Buffer.from('fake audio'), 'utf8');

    const callAi = vi.fn();
    const result = await analyzeGeneration({ id: 'gen-1-cached', force: false, dir: tmpDir, callAi });

    expect(result).toEqual(cachedAnalysis);
    expect(callAi).not.toHaveBeenCalled();
  });

  it('calls the provider and persists a fresh analysis when force is true, even if one is cached', async () => {
    const manifest: GenerationManifest & { analysis: Analysis } = {
      id: 'gen-1-force',
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'prompt',
      lyrics: 'lyrics',
      generatedAt: '2026-01-01T00:00:00.000Z',
      analysis: cachedAnalysis,
    };
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.wav`), Buffer.from('fake audio'), 'utf8');

    const freshAnalysis: Analysis = { ...cachedAnalysis, title: 'Fresh Track' };
    const callAi = vi.fn().mockResolvedValue(JSON.stringify(freshAnalysis));

    const result = await analyzeGeneration({ id: 'gen-1-force', force: true, dir: tmpDir, callAi });

    expect(result.title).toBe('Fresh Track');
    expect(callAi).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, `${manifest.id}.json`), 'utf8'));
    expect(persisted.analysis.title).toBe('Fresh Track');
  });

  it('calls the provider, parses, and persists when no analysis is cached yet', async () => {
    const manifest: GenerationManifest = {
      id: 'gen-1-new',
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'prompt',
      lyrics: 'lyrics',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.wav`), Buffer.from('fake audio'), 'utf8');

    const newAnalysis: Analysis = {
      title: 'Brand New',
      genre: 'Techno',
      mood: 'Driving',
      energy: 90,
      bpm: null,
      key: null,
      instrumentation: [],
      sections: [],
      notes: '',
    };
    const callAi = vi.fn().mockResolvedValue(JSON.stringify(newAnalysis));

    const result = await analyzeGeneration({ id: 'gen-1-new', force: false, dir: tmpDir, callAi });

    expect(result.title).toBe('Brand New');
    expect(callAi).toHaveBeenCalledTimes(1);
    // callAi should receive the base64-encoded audio bytes and the manifest/format so the
    // caller (server.ts) can build the correct provider request.
    const callArgs = callAi.mock.calls[0][0];
    expect(callArgs.audioBase64).toBe(Buffer.from('fake audio').toString('base64'));
    expect(callArgs.format).toBe('wav');
  });

  it('throws AnalysisNotFoundError for an unknown id', async () => {
    await expect(
      analyzeGeneration({ id: 'gen-1-missing', force: false, dir: tmpDir, callAi: vi.fn() }),
    ).rejects.toThrow(AnalysisNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Embedded metadata: WAV LIST/INFO, ID3v2.3, wavDurationSeconds, renameGeneration
// ---------------------------------------------------------------------------

/** Walks top-level RIFF chunks, returning { id, size, bodyOffset }[] (not recursing into LIST). */
function walkRiffChunks(wav: Buffer): { id: string; size: number; bodyOffset: number }[] {
  const chunks: { id: string; size: number; bodyOffset: number }[] = [];
  let offset = 12; // past 'RIFF' + size(4) + 'WAVE'
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const bodyOffset = offset + 8;
    chunks.push({ id, size, bodyOffset });
    offset = bodyOffset + size + (size % 2); // word-align
  }
  return chunks;
}

/** Finds the LIST/INFO chunk (if any) and parses its INAM/IART/ICMT sub-chunks into a map. */
function parseListInfo(wav: Buffer): Record<string, string> {
  const chunks = walkRiffChunks(wav);
  const listChunk = chunks.find(c => c.id === 'LIST');
  if (!listChunk) return {};
  const listType = wav.toString('ascii', listChunk.bodyOffset, listChunk.bodyOffset + 4);
  if (listType !== 'INFO') return {};

  const result: Record<string, string> = {};
  let offset = listChunk.bodyOffset + 4;
  const end = listChunk.bodyOffset + listChunk.size;
  while (offset + 8 <= end) {
    const subId = wav.toString('ascii', offset, offset + 4);
    const subSize = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const raw = wav.toString('latin1', dataStart, dataStart + subSize);
    result[subId] = raw.replace(/\0+$/, '');
    offset = dataStart + subSize + (subSize % 2);
  }
  return result;
}

describe('embedWavInfo', () => {
  it('embeds INAM/IART/ICMT into a LIST/INFO chunk that round-trips via parsing', () => {
    const wav = makeMockWav(1);
    const out = embedWavInfo(wav, { title: 'My Track', artist: 'Lyria 3 Pro', comment: 'model=x' });

    const info = parseListInfo(out);
    expect(info.INAM).toBe('My Track');
    expect(info.IART).toBe('Lyria 3 Pro');
    expect(info.ICMT).toBe('model=x');
  });

  it('still starts with RIFF/WAVE after embedding', () => {
    const wav = makeMockWav(1);
    const out = embedWavInfo(wav, { title: 'T' });
    expect(out.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(out.subarray(8, 12).toString('ascii')).toBe('WAVE');
  });

  it('fixes up the outer RIFF size field to match the new total length', () => {
    const wav = makeMockWav(1);
    const out = embedWavInfo(wav, { title: 'T' });
    const declaredSize = out.readUInt32LE(4);
    expect(declaredSize).toBe(out.length - 8);
  });

  it('leaves the original data chunk bytes untouched', () => {
    const wav = makeMockWav(1);
    const originalDataChunk = walkRiffChunks(wav).find(c => c.id === 'data')!;
    const originalDataBytes = wav.subarray(originalDataChunk.bodyOffset, originalDataChunk.bodyOffset + originalDataChunk.size);

    const out = embedWavInfo(wav, { title: 'T', artist: 'A', comment: 'C' });
    const newDataChunk = walkRiffChunks(out).find(c => c.id === 'data')!;
    const newDataBytes = out.subarray(newDataChunk.bodyOffset, newDataChunk.bodyOffset + newDataChunk.size);

    expect(newDataBytes.equals(originalDataBytes)).toBe(true);
  });

  it('embedding twice with new tags replaces rather than duplicates the LIST/INFO chunk', () => {
    const wav = makeMockWav(1);
    const once = embedWavInfo(wav, { title: 'First Title', artist: 'A', comment: 'C1' });
    const twice = embedWavInfo(once, { title: 'Second Title', artist: 'A2', comment: 'C2' });

    const listChunks = walkRiffChunks(twice).filter(c => c.id === 'LIST');
    expect(listChunks).toHaveLength(1);

    const info = parseListInfo(twice);
    expect(info.INAM).toBe('Second Title');
    expect(info.IART).toBe('A2');
    expect(info.ICMT).toBe('C2');
  });

  it('omits sub-chunks for tags that are not provided', () => {
    const wav = makeMockWav(1);
    const out = embedWavInfo(wav, { title: 'Only Title' });
    const info = parseListInfo(out);
    expect(info.INAM).toBe('Only Title');
    expect(info.IART).toBeUndefined();
    expect(info.ICMT).toBeUndefined();
  });

  it('word-aligns each sub-chunk (odd-length string data is padded)', () => {
    const wav = makeMockWav(1);
    // 'abc' (3 bytes) + null terminator (1) = 4 bytes total (even) -> no pad needed;
    // 'ab' (2 bytes) + null terminator (1) = 3 bytes total (odd) -> needs 1 pad byte.
    const out = embedWavInfo(wav, { title: 'ab' });
    const chunks = walkRiffChunks(out);
    const listChunk = chunks.find(c => c.id === 'LIST')!;
    // Sub-chunk size field for INAM should be 3 (2 chars + NUL), but chunk must still be
    // word-aligned when walking, i.e. no parse errors / trailing garbage.
    expect(listChunk.size % 2).toBe(0);
  });
});

describe('wavDurationSeconds', () => {
  it('computes seconds from a known 44100Hz/stereo/16-bit mock wav', () => {
    const wav = makeMockWav(3);
    // 44100 Hz * 2 channels * 2 bytes/sample = 176400 bytes/sec; 3s -> exactly 3.0
    expect(wavDurationSeconds(wav)).toBe(3.0);
  });

  it('rounds to 1 decimal place', () => {
    const wav = makeMockWav(2);
    // Truncate the data chunk by a few bytes/frames to force a non-integer second count,
    // then fix up the RIFF/data sizes so the header stays internally consistent.
    const trimmedFrames = Math.floor(2 * 44100 * 0.15); // trims ~0.15s of frames off
    const bytesPerFrame = 4; // 2 channels * 2 bytes
    const trimBytes = trimmedFrames * bytesPerFrame;
    const out = Buffer.from(wav);
    const dataChunk = walkRiffChunks(out).find(c => c.id === 'data')!;
    const newDataSize = dataChunk.size - trimBytes;
    out.writeUInt32LE(newDataSize, dataChunk.bodyOffset - 4);
    out.writeUInt32LE(out.length - trimBytes - 8, 4);
    const truncated = out.subarray(0, out.length - trimBytes);

    const seconds = wavDurationSeconds(truncated)!;
    expect(seconds).toBeCloseTo(1.7, 1);
    expect(Number(seconds.toFixed(1))).toBe(seconds);
  });

  it('returns null for an unparseable buffer', () => {
    expect(wavDurationSeconds(Buffer.from('not a wav file at all'))).toBeNull();
  });

  it('returns null when byteRate is zero (would divide by zero)', () => {
    const wav = makeMockWav(1);
    const out = Buffer.from(wav);
    const fmtChunk = walkRiffChunks(out).find(c => c.id === 'fmt ')!;
    out.writeUInt32LE(0, fmtChunk.bodyOffset + 8); // byteRate field within fmt body
    expect(wavDurationSeconds(out)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ITEM 24: real MP3 duration parsing. OpenRouter returns MP3 for Pro as well as Clip, and those
// files previously got no durationSeconds at all, so HISTORY showed nothing. Fixtures below are
// synthesized byte-for-byte here (no dependencies, no real audio needed) so the frame arithmetic
// is asserted against known-exact values.
// ---------------------------------------------------------------------------

const MPEG1_L3_44100_SAMPLES_PER_FRAME = 1152;
const MPEG1_L3_44100_RATE = 44100;

/**
 * Builds one MPEG-1 Layer III frame header: no CRC, 44100 Hz, joint stereo.
 * bitrateIndex 9 = 128 kbps, 14 = 320 kbps (the rate OpenRouter's Lyria output opens with).
 */
function mpeg1Layer3Header(bitrateIndex: number, padding = 0): Buffer {
  return Buffer.from([
    0xff,
    0xfb, // sync + MPEG-1 + Layer III + no protection
    (bitrateIndex << 4) | (0 << 2) | (padding << 1), // bitrate | 44100 | padding | private
    0x40, // joint stereo, no emphasis
  ]);
}

/** Frame size in bytes for an MPEG-1 Layer III 44100 Hz frame at the given kbps. */
function mpeg1Layer3FrameLength(kbps: number, padding = 0): number {
  return Math.floor((144 * kbps * 1000) / MPEG1_L3_44100_RATE) + padding;
}

/** Concatenates `frameCount` CBR MPEG-1 Layer III frames (zero-filled payloads) at `kbps`. */
function makeCbrMp3(frameCount: number, kbps = 128, bitrateIndex = 9): Buffer {
  const length = mpeg1Layer3FrameLength(kbps);
  const frames: Buffer[] = [];
  for (let i = 0; i < frameCount; i++) {
    const frame = Buffer.alloc(length);
    mpeg1Layer3Header(bitrateIndex).copy(frame, 0);
    frames.push(frame);
  }
  return Buffer.concat(frames);
}

/**
 * Builds a VBR-style MP3: a leading Xing header frame declaring `declaredFrames`, followed by
 * only `realFrames` actual frames. The declared count deliberately disagrees with what a frame
 * walk would find, so the test proves the Xing count is what gets used.
 */
function makeXingMp3(declaredFrames: number, realFrames: number, tag: 'Xing' | 'Info' = 'Xing'): Buffer {
  const length = mpeg1Layer3FrameLength(128);
  const header = Buffer.alloc(length);
  mpeg1Layer3Header(9).copy(header, 0);
  header.write(tag, 36, 'latin1'); // MPEG-1 non-mono: Xing sits 36 bytes into the frame
  header.writeUInt32BE(0x01, 40); // flags: frames field present
  header.writeUInt32BE(declaredFrames, 44);
  return Buffer.concat([header, makeCbrMp3(realFrames)]);
}

/** Wraps mp3 bytes in a minimal (frameless, padded) ID3v2.3 tag of `payloadSize` bytes. */
function withId3Tag(mp3: Buffer, payloadSize = 2048): Buffer {
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'ascii');
  header[3] = 3; // v2.3
  header[6] = (payloadSize >>> 21) & 0x7f;
  header[7] = (payloadSize >>> 14) & 0x7f;
  header[8] = (payloadSize >>> 7) & 0x7f;
  header[9] = payloadSize & 0x7f;
  return Buffer.concat([header, Buffer.alloc(payloadSize), mp3]);
}

const cbrSeconds = (frames: number) =>
  Math.round(((frames * MPEG1_L3_44100_SAMPLES_PER_FRAME) / MPEG1_L3_44100_RATE) * 10) / 10;

describe('mp3DurationSeconds', () => {
  it('walks CBR frames and returns the exact duration', () => {
    const frames = 383; // 383 * 1152 / 44100 = 10.005... -> 10.0
    expect(mp3DurationSeconds(makeCbrMp3(frames))).toBe(cbrSeconds(frames));
    expect(mp3DurationSeconds(makeCbrMp3(frames))).toBe(10.0);
  });

  it('skips a leading ID3v2 tag before looking for the first frame', () => {
    const frames = 383;
    expect(mp3DurationSeconds(withId3Tag(makeCbrMp3(frames)))).toBe(10.0);
  });

  it('handles 320 kbps CBR (the bitrate real OpenRouter Lyria output opens with)', () => {
    const length = mpeg1Layer3FrameLength(320);
    expect(length).toBe(1044);
    const frames = 1178; // the real 30s clip length on disk
    const mp3 = Buffer.concat(
      Array.from({ length: frames }, () => {
        const frame = Buffer.alloc(length);
        mpeg1Layer3Header(14).copy(frame, 0);
        return frame;
      }),
    );
    expect(mp3DurationSeconds(mp3)).toBe(30.8);
  });

  it('VBR: uses the Xing frame count instead of walking frames', () => {
    // 1000 declared frames, but only 5 real ones follow — a frame walk would report ~0.2s.
    const mp3 = makeXingMp3(1000, 5);
    expect(mp3DurationSeconds(mp3)).toBe(cbrSeconds(1001)); // Xing frame + the declared count's own frame
    expect(mp3DurationSeconds(mp3)).toBe(26.1);
  });

  it('VBR: accepts an "Info" (CBR-written LAME) header the same way as "Xing"', () => {
    expect(mp3DurationSeconds(makeXingMp3(1000, 5, 'Info'))).toBe(26.1);
  });

  it('VBR: falls back to a frame walk when the Xing header has no frames flag', () => {
    const mp3 = makeXingMp3(1000, 5);
    mp3.writeUInt32BE(0x00, 40); // clear the flags field: no usable frame count
    expect(mp3DurationSeconds(mp3)).toBe(cbrSeconds(6)); // 1 header frame + 5 real frames
  });

  it('handles VBR streams whose frames change bitrate mid-file (no Xing header)', () => {
    const mixed = Buffer.concat([makeCbrMp3(100, 128, 9), makeCbrMp3(100, 320, 14)]);
    // Bitrate changes the frame SIZE, not the sample count: 200 frames either way.
    expect(mp3DurationSeconds(mixed)).toBe(cbrSeconds(200));
  });

  it('stops cleanly at a trailing ID3v1 tag rather than counting it as audio', () => {
    const frames = 383;
    const id3v1 = Buffer.alloc(128);
    id3v1.write('TAG', 0, 'ascii');
    expect(mp3DurationSeconds(Buffer.concat([makeCbrMp3(frames), id3v1]))).toBe(10.0);
  });

  it('returns null for garbage bytes (never guesses a duration)', () => {
    expect(mp3DurationSeconds(Buffer.from('this is not an mp3 at all, not even close'))).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(mp3DurationSeconds(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for WAV bytes mislabeled as mp3 (the legacy .mp3-holding-RIFF files)', () => {
    expect(mp3DurationSeconds(makeMockWav(1))).toBeNull();
  });

  it('returns null for an ID3 tag with no audio frames after it', () => {
    expect(mp3DurationSeconds(withId3Tag(Buffer.alloc(0), 64))).toBeNull();
  });

  it('returns null for a frame header using the reserved/free bitrate index', () => {
    const frame = Buffer.alloc(mpeg1Layer3FrameLength(128));
    mpeg1Layer3Header(0).copy(frame, 0); // bitrate index 0 = "free format", unsupported
    expect(mp3DurationSeconds(frame)).toBeNull();
  });

  it('rounds to 1 decimal place, matching wavDurationSeconds', () => {
    const seconds = mp3DurationSeconds(makeCbrMp3(500))!;
    expect(seconds).toBe(13.1); // 500 * 1152 / 44100 = 13.061...
    expect(Number(seconds.toFixed(1))).toBe(seconds);
  });
});

// The fresh-generation duration path. Covered directly because the LYRIA_MOCK generator only ever
// emits wav bytes, so the mp3 branch cannot be reached through generateLyria without paying for a
// real provider call.
describe('computeDurationSeconds (fresh-generation duration)', () => {
  it('parses a real duration out of freshly generated mp3 bytes (pro model)', () => {
    expect(computeDurationSeconds('mp3', 'google/lyria-3-pro-preview', makeCbrMp3(383))).toBe(10.0);
  });

  it('parses a real duration out of freshly generated wav bytes', () => {
    expect(computeDurationSeconds('wav', 'lyria-3-pro-preview', makeMockWav(3))).toBe(3.0);
  });

  it('prefers the parsed mp3 duration over the clip constant', () => {
    expect(computeDurationSeconds('mp3', 'lyria-3-clip-preview', makeCbrMp3(383))).toBe(10.0);
  });

  it('falls back to the clip constant only when clip mp3 bytes will not parse', () => {
    expect(computeDurationSeconds('mp3', 'lyria-3-clip-preview', Buffer.from('junk'))).toBe(30);
  });

  it('leaves a pro mp3 undefined when its bytes will not parse (never guesses)', () => {
    expect(computeDurationSeconds('mp3', 'google/lyria-3-pro-preview', Buffer.from('junk'))).toBeUndefined();
  });

  it('leaves an unparseable wav undefined', () => {
    expect(computeDurationSeconds('wav', 'lyria-3-pro-preview', Buffer.from('junk'))).toBeUndefined();
  });
});

describe('embedId3', () => {
  const readId3Frame = (mp3: Buffer, frameId: string): string | undefined => {
    if (mp3.toString('ascii', 0, 3) !== 'ID3') return undefined;
    const sizeBytes = [mp3[6], mp3[7], mp3[8], mp3[9]];
    const tagSize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
    const tagEnd = 10 + tagSize;
    let offset = 10;
    while (offset + 10 <= tagEnd) {
      const id = mp3.toString('ascii', offset, offset + 4);
      const frameSize = mp3.readUInt32BE(offset + 4);
      const dataStart = offset + 10;
      if (id === frameId) {
        const encoding = mp3[dataStart];
        const textStart = dataStart + 1;
        const textEnd = dataStart + frameSize;
        if (encoding === 0) {
          return mp3.toString('latin1', textStart, textEnd).replace(/\0+$/, '');
        }
        return mp3.toString('utf16le', textStart, textEnd).replace(/\0+$/, '');
      }
      offset = dataStart + frameSize;
    }
    return undefined;
  };

  const readId3Comm = (mp3: Buffer): string | undefined => {
    if (mp3.toString('ascii', 0, 3) !== 'ID3') return undefined;
    const sizeBytes = [mp3[6], mp3[7], mp3[8], mp3[9]];
    const tagSize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
    const tagEnd = 10 + tagSize;
    let offset = 10;
    while (offset + 10 <= tagEnd) {
      const id = mp3.toString('ascii', offset, offset + 4);
      const frameSize = mp3.readUInt32BE(offset + 4);
      const dataStart = offset + 10;
      if (id === 'COMM') {
        // encoding(1) + language(3) + short description (NUL-terminated) + actual comment
        const encoding = mp3[dataStart];
        let textStart = dataStart + 1 + 3;
        if (encoding === 0) {
          while (mp3[textStart] !== 0x00) textStart++;
          textStart++; // past the short-description NUL
          return mp3.toString('latin1', textStart, dataStart + frameSize).replace(/\0+$/, '');
        } else {
          while (!(mp3[textStart] === 0x00 && mp3[textStart + 1] === 0x00)) textStart += 2;
          textStart += 2;
          return mp3.toString('utf16le', textStart, dataStart + frameSize).replace(/\0+$/, '');
        }
      }
      offset = dataStart + frameSize;
    }
    return undefined;
  };

  const fakeMp3 = () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.from('FAKEMP3FRAMEBYTES')]);

  it('prepends an ID3v2.3 tag with TIT2/TPE1/COMM frames', () => {
    const mp3 = fakeMp3();
    const out = embedId3(mp3, { title: 'My Song', artist: 'Lyria 3 Pro', comment: 'a comment' });

    expect(out.toString('ascii', 0, 3)).toBe('ID3');
    expect(readId3Frame(out, 'TIT2')).toBe('My Song');
    expect(readId3Frame(out, 'TPE1')).toBe('Lyria 3 Pro');
    expect(readId3Comm(out)).toBe('a comment');
  });

  it('leaves the original audio frame bytes untouched, appended after the tag', () => {
    const mp3 = fakeMp3();
    const out = embedId3(mp3, { title: 'T' });

    const sizeBytes = [out[6], out[7], out[8], out[9]];
    const tagSize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
    const audioStart = 10 + tagSize;
    const audioBytes = out.subarray(audioStart);

    expect(audioBytes.equals(mp3)).toBe(true);
  });

  it('uses syncsafe integers for the tag size (each byte < 0x80)', () => {
    const mp3 = fakeMp3();
    const out = embedId3(mp3, { title: 'X'.repeat(300), artist: 'Y'.repeat(300), comment: 'Z'.repeat(300) });
    for (const b of [out[6], out[7], out[8], out[9]]) {
      expect(b).toBeLessThan(0x80);
    }
  });

  it('re-embedding (double embed) strips the old tag first rather than stacking tags', () => {
    const mp3 = fakeMp3();
    const once = embedId3(mp3, { title: 'First' });
    const twice = embedId3(once, { title: 'Second' });

    // Only one 'ID3' marker should exist, at the very start.
    const id3Occurrences = twice.toString('latin1').split('ID3').length - 1;
    expect(id3Occurrences).toBe(1);
    expect(readId3Frame(twice, 'TIT2')).toBe('Second');

    const sizeBytes = [twice[6], twice[7], twice[8], twice[9]];
    const tagSize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
    const audioStart = 10 + tagSize;
    expect(twice.subarray(audioStart).equals(mp3)).toBe(true);
  });

  it('omits frames for tags that are not provided', () => {
    const mp3 = fakeMp3();
    const out = embedId3(mp3, { title: 'Only Title' });
    expect(readId3Frame(out, 'TIT2')).toBe('Only Title');
    expect(readId3Frame(out, 'TPE1')).toBeUndefined();
    expect(readId3Comm(out)).toBeUndefined();
  });
});

describe('generateLyria (mock mode) — title, durationSeconds, embedded tags', () => {
  const GEN_DIR = path.join(process.cwd(), 'generations');
  const prevMock = process.env.LYRIA_MOCK;
  let createdId: string | undefined;

  beforeEach(() => {
    process.env.LYRIA_MOCK = '1';
  });

  afterEach(async () => {
    process.env.LYRIA_MOCK = prevMock;
    if (createdId) {
      await fs.rm(path.join(GEN_DIR, `${createdId}.wav`), { force: true });
      await fs.rm(path.join(GEN_DIR, `${createdId}.mp3`), { force: true });
      await fs.rm(path.join(GEN_DIR, `${createdId}.json`), { force: true });
      createdId = undefined;
    }
  });

  it('carries an explicit title through to the result and the manifest', async () => {
    const result = await generateLyria(null, { prompt: 'Title test track', title: 'Golden Hour' });
    createdId = result.id;

    expect(result.title).toBe('Golden Hour');

    const manifestRaw = await fs.readFile(path.join(GEN_DIR, `${result.id}.json`), 'utf8');
    const manifest = JSON.parse(manifestRaw) as GenerationManifest;
    expect(manifest.title).toBe('Golden Hour');
  });

  it('trims and caps title at ~120 chars', async () => {
    const longTitle = '  ' + 'A'.repeat(140) + '  ';
    const result = await generateLyria(null, { prompt: 'Long title track', title: longTitle });
    createdId = result.id;

    expect(result.title!.length).toBeLessThanOrEqual(120);
    expect(result.title!.startsWith(' ')).toBe(false);
  });

  it('omits title when not provided', async () => {
    const result = await generateLyria(null, { prompt: 'No title track' });
    createdId = result.id;

    expect(result.title).toBeUndefined();
  });

  it('computes durationSeconds for a wav (mock pro model, 8s clip) on both result and manifest', async () => {
    const result = await generateLyria(null, { prompt: 'Duration test', model: 'pro' });
    createdId = result.id;

    expect(result.format).toBe('wav');
    expect(result.durationSeconds).toBeCloseTo(8.0, 1);

    const manifestRaw = await fs.readFile(path.join(GEN_DIR, `${result.id}.json`), 'utf8');
    const manifest = JSON.parse(manifestRaw) as GenerationManifest;
    expect(manifest.durationSeconds).toBeCloseTo(8.0, 1);
  });

  it('clip model: DETECTED format wins over the model-implied mp3 (mock emits real wav bytes)', async () => {
    const result = await generateLyria(null, { prompt: 'Clip duration test', model: 'clip' });
    createdId = result.id;

    // The mock generator emits RIFF/WAVE bytes even for the clip model. The persisted
    // extension/manifest/duration must follow the ACTUAL bytes (detectAudioFormat), never
    // the requested/model-implied format — the exact invariant that fixes the OpenRouter
    // "wav requested, mp3 returned" mislabel.
    expect(result.format).toBe('wav');
    expect(result.audioUrl).toBe(`/generations/${result.id}.wav`);
    expect(result.durationSeconds).toBeCloseTo(4.0, 1); // parsed from the real wav bytes

    const manifest = JSON.parse(await fs.readFile(path.join(GEN_DIR, `${result.id}.json`), 'utf8')) as GenerationManifest;
    expect(manifest.format).toBe('wav');

    const written = await fs.readFile(path.join(GEN_DIR, `${result.id}.wav`));
    expect(detectAudioFormat(written)).toBe('wav');
    await expect(fs.access(path.join(GEN_DIR, `${result.id}.mp3`))).rejects.toThrow(); // no mislabeled file
  });

  it('embeds the title into the actual written wav file (INAM contains the title)', async () => {
    const result = await generateLyria(null, { prompt: 'Embed check track', title: 'Embedded Title Here' });
    createdId = result.id;

    const written = await fs.readFile(path.join(GEN_DIR, `${result.id}.wav`));
    const info = parseListInfo(written);
    expect(info.INAM).toBe('Embedded Title Here');
  });

  it('embeds artist=Lyria 3 Pro and a comment carrying model/provider/generated metadata into the wav file', async () => {
    const result = await generateLyria(null, { prompt: 'Metadata check track' });
    createdId = result.id;

    const written = await fs.readFile(path.join(GEN_DIR, `${result.id}.wav`));
    const info = parseListInfo(written);
    expect(info.IART).toBe('Lyria 3 Pro');
    expect(info.ICMT).toContain('provider=mock');
  });
});

// ---------------------------------------------------------------------------
// ITEM 19: manifests never stored the generation settings, so History's "load with settings"
// had nothing to restore. language / durationTarget / batchCount are now persisted verbatim —
// and only when the request actually supplied them, so a manifest never invents a setting.
// ---------------------------------------------------------------------------

describe('generateLyria (mock mode) — persisted generation settings', () => {
  const GEN_DIR = path.join(process.cwd(), 'generations');
  const prevMock = process.env.LYRIA_MOCK;
  let createdId: string | undefined;

  const readManifest = async (id: string): Promise<GenerationManifest> =>
    JSON.parse(await fs.readFile(path.join(GEN_DIR, `${id}.json`), 'utf8')) as GenerationManifest;

  beforeEach(() => {
    process.env.LYRIA_MOCK = '1';
  });

  afterEach(async () => {
    process.env.LYRIA_MOCK = prevMock;
    if (createdId) {
      await fs.rm(path.join(GEN_DIR, `${createdId}.wav`), { force: true });
      await fs.rm(path.join(GEN_DIR, `${createdId}.mp3`), { force: true });
      await fs.rm(path.join(GEN_DIR, `${createdId}.json`), { force: true });
      createdId = undefined;
    }
  });

  it('persists language, durationTarget and batchCount onto the manifest', async () => {
    const result = await generateLyria(null, {
      prompt: 'Settings round-trip track',
      language: 'JA',
      durationTarget: '1:30',
      batchCount: 3,
    });
    createdId = result.id;

    const manifest = await readManifest(result.id);
    expect(manifest.language).toBe('JA');
    expect(manifest.durationTarget).toBe('1:30');
    expect(manifest.batchCount).toBe(3);
  });

  it('trims whitespace around language and durationTarget', async () => {
    const result = await generateLyria(null, {
      prompt: 'Whitespace settings track',
      language: '  ES  ',
      durationTarget: '  2:00 ',
    });
    createdId = result.id;

    const manifest = await readManifest(result.id);
    expect(manifest.language).toBe('ES');
    expect(manifest.durationTarget).toBe('2:00');
  });

  it('omits the fields entirely when the request supplies none (never defaults them)', async () => {
    const result = await generateLyria(null, { prompt: 'No settings track' });
    createdId = result.id;

    const manifest = await readManifest(result.id);
    expect(manifest.language).toBeUndefined();
    expect(manifest.durationTarget).toBeUndefined();
    expect(manifest.batchCount).toBeUndefined();
    expect('language' in manifest).toBe(false);
    expect('durationTarget' in manifest).toBe(false);
    expect('batchCount' in manifest).toBe(false);
  });

  it('omits blank/whitespace-only settings rather than storing empty strings', async () => {
    const result = await generateLyria(null, {
      prompt: 'Blank settings track',
      language: '   ',
      durationTarget: '',
    });
    createdId = result.id;

    const manifest = await readManifest(result.id);
    expect(manifest.language).toBeUndefined();
    expect(manifest.durationTarget).toBeUndefined();
  });

  it('rejects a non-positive or non-numeric batchCount instead of storing it', async () => {
    const result = await generateLyria(null, {
      prompt: 'Bad batch track',
      batchCount: 0,
    });
    createdId = result.id;
    expect((await readManifest(result.id)).batchCount).toBeUndefined();

    const negative = await generateLyria(null, { prompt: 'Negative batch track', batchCount: -2 });
    await fs.rm(path.join(GEN_DIR, `${negative.id}.wav`), { force: true });
    await fs.rm(path.join(GEN_DIR, `${negative.id}.json`), { force: true });
    expect(negative.id).not.toBe(result.id);

    const bogus = await generateLyria(null, {
      prompt: 'Bogus batch track',
      batchCount: 'three' as unknown as number,
    });
    const bogusManifest = await readManifest(bogus.id);
    await fs.rm(path.join(GEN_DIR, `${bogus.id}.wav`), { force: true });
    await fs.rm(path.join(GEN_DIR, `${bogus.id}.json`), { force: true });
    expect(bogusManifest.batchCount).toBeUndefined();
  });
});

describe('listGenerations — manifests predating the settings fields', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyria-settings-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('keeps working and reports the settings as undefined (never invents values)', async () => {
    const legacy: GenerationManifest = {
      id: 'gen-legacy-settings',
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'openrouter',
      prompt: 'legacy prompt',
      lyrics: 'legacy lyrics',
      generatedAt: '2026-01-01T00:00:00.000Z',
      durationSeconds: 12,
    };
    await fs.writeFile(path.join(tmpDir, `${legacy.id}.json`), JSON.stringify(legacy), 'utf8');

    const [entry] = await listGenerations(tmpDir);
    expect(entry.id).toBe('gen-legacy-settings');
    expect(entry.language).toBeUndefined();
    expect(entry.durationTarget).toBeUndefined();
    expect(entry.batchCount).toBeUndefined();
  });

  it('passes the settings through untouched when a manifest does carry them', async () => {
    const modern: GenerationManifest = {
      id: 'gen-modern-settings',
      model: 'google/lyria-3-pro-preview',
      format: 'mp3',
      provider: 'openrouter',
      prompt: 'modern prompt',
      lyrics: 'modern lyrics',
      generatedAt: '2026-02-01T00:00:00.000Z',
      durationSeconds: 60,
      language: 'FR',
      durationTarget: '1:00',
      batchCount: 2,
    };
    await fs.writeFile(path.join(tmpDir, `${modern.id}.json`), JSON.stringify(modern), 'utf8');

    const [entry] = await listGenerations(tmpDir);
    expect(entry.language).toBe('FR');
    expect(entry.durationTarget).toBe('1:00');
    expect(entry.batchCount).toBe(2);
  });
});

describe('renameGeneration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyria-rename-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function seedWavGeneration(id: string, dir: string): Promise<void> {
    const manifest: GenerationManifest = {
      id,
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'seed prompt',
      lyrics: 'seed lyrics',
      generatedAt: '2026-01-01T00:00:00.000Z',
      title: 'Old Title',
    };
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(dir, `${id}.wav`), makeMockWav(1));
  }

  it('updates manifest.title and returns the GenerationListItem shape', async () => {
    await seedWavGeneration('gen-1-rename1', tmpDir);

    const result = await renameGeneration('gen-1-rename1', 'New Title', tmpDir);

    expect(result.title).toBe('New Title');
    expect(result.audioUrl).toBe('/generations/gen-1-rename1.wav');
    expect(result.id).toBe('gen-1-rename1');

    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, 'gen-1-rename1.json'), 'utf8'));
    expect(persisted.title).toBe('New Title');
  });

  it('re-embeds the new title into the wav file on disk', async () => {
    await seedWavGeneration('gen-2-rename2', tmpDir);

    await renameGeneration('gen-2-rename2', 'Re-Embedded Title', tmpDir);

    const written = await fs.readFile(path.join(tmpDir, 'gen-2-rename2.wav'));
    const info = parseListInfo(written);
    expect(info.INAM).toBe('Re-Embedded Title');
  });

  it('re-embeds the new title into an mp3 file on disk', async () => {
    const id = 'gen-3-renamemp3';
    const manifest: GenerationManifest = {
      id,
      model: 'lyria-3-clip-preview',
      format: 'mp3',
      provider: 'mock',
      prompt: 'seed prompt',
      lyrics: 'seed lyrics',
      generatedAt: '2026-01-01T00:00:00.000Z',
      title: 'Old Title',
    };
    await fs.writeFile(path.join(tmpDir, `${id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${id}.mp3`), Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.from('FAKE')]));

    const result = await renameGeneration(id, 'New MP3 Title', tmpDir);

    expect(result.title).toBe('New MP3 Title');
    const written = await fs.readFile(path.join(tmpDir, `${id}.mp3`));
    expect(written.toString('ascii', 0, 3)).toBe('ID3');
  });

  it('throws GenerationNotFoundError for an unknown id', async () => {
    await expect(renameGeneration('gen-1-missing', 'New Title', tmpDir)).rejects.toThrow(GenerationNotFoundError);
  });

  it('throws on empty/whitespace-only title', async () => {
    await seedWavGeneration('gen-4-renameempty', tmpDir);
    await expect(renameGeneration('gen-4-renameempty', '   ', tmpDir)).rejects.toThrow();
  });

  it('tolerates a missing audio file (updates manifest, does not throw)', async () => {
    const manifest: GenerationManifest = {
      id: 'gen-5-renamenoaudio',
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'seed prompt',
      lyrics: 'seed lyrics',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, 'gen-5-renamenoaudio.json'), JSON.stringify(manifest), 'utf8');
    // Intentionally no audio file written.

    const result = await renameGeneration('gen-5-renamenoaudio', 'No Audio Title', tmpDir);
    expect(result.title).toBe('No Audio Title');
  });
});

describe('listGenerations — durationSeconds backfill', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyria-backfill-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('backfills durationSeconds for a wav manifest missing it by parsing the file, and persists it', async () => {
    const manifest: GenerationManifest = {
      id: 'gen-backfill-wav',
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'p',
      lyrics: 'l',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.wav`), makeMockWav(5));

    const result = await listGenerations(tmpDir);
    expect(result[0].durationSeconds).toBeCloseTo(5.0, 1);

    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, `${manifest.id}.json`), 'utf8'));
    expect(persisted.durationSeconds).toBeCloseTo(5.0, 1);
  });

  it('backfills durationSeconds to 30 for a clip/mp3 manifest missing it', async () => {
    const manifest: GenerationManifest = {
      id: 'gen-backfill-mp3',
      model: 'lyria-3-clip-preview',
      format: 'mp3',
      provider: 'mock',
      prompt: 'p',
      lyrics: 'l',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.mp3`), Buffer.from('fake mp3 bytes'));

    const result = await listGenerations(tmpDir);
    expect(result[0].durationSeconds).toBe(30);
  });

  it('does not re-parse or rewrite a manifest that already has durationSeconds', async () => {
    const manifest: GenerationManifest = {
      id: 'gen-has-duration',
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'p',
      lyrics: 'l',
      generatedAt: '2026-01-01T00:00:00.000Z',
      durationSeconds: 42.0,
    };
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.json`), JSON.stringify(manifest), 'utf8');
    // No audio file written — if the implementation tried to re-derive duration it would
    // have nothing to parse, but since durationSeconds is already set it must not try.

    const result = await listGenerations(tmpDir);
    expect(result[0].durationSeconds).toBe(42.0);
  });

  it('tolerates a missing audio file when backfilling (leaves durationSeconds undefined)', async () => {
    const manifest: GenerationManifest = {
      id: 'gen-backfill-missing-audio',
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'p',
      lyrics: 'l',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.json`), JSON.stringify(manifest), 'utf8');
    // No audio file written.

    const result = await listGenerations(tmpDir);
    expect(result[0].durationSeconds).toBeUndefined();
  });

  // ITEM 24: every OpenRouter Pro generation on disk is an mp3, and the old backfill only knew
  // how to parse wav — so those rows showed no duration at all. The backfill now parses the real
  // MPEG frame stream, and only falls back to the clip constant for bytes it cannot parse.
  it('backfills a REAL parsed duration for a pro/mp3 manifest (not undefined, not a constant)', async () => {
    const manifest: GenerationManifest = {
      id: 'gen-backfill-real-mp3',
      model: 'google/lyria-3-pro-preview',
      format: 'mp3',
      provider: 'openrouter',
      prompt: 'p',
      lyrics: 'l',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.mp3`), withId3Tag(makeCbrMp3(383)));

    const result = await listGenerations(tmpDir);
    expect(result[0].durationSeconds).toBe(10.0);

    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, `${manifest.id}.json`), 'utf8'));
    expect(persisted.durationSeconds).toBe(10.0);
  });

  it('prefers the parsed mp3 duration over the clip constant for a clip manifest', async () => {
    const manifest: GenerationManifest = {
      id: 'gen-backfill-clip-real',
      model: 'lyria-3-clip-preview',
      format: 'mp3',
      provider: 'openrouter',
      prompt: 'p',
      lyrics: 'l',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.mp3`), makeCbrMp3(383));

    const result = await listGenerations(tmpDir);
    expect(result[0].durationSeconds).toBe(10.0); // parsed, NOT the 30s clip constant
  });

  it('leaves durationSeconds undefined for an unparseable pro/mp3 file (never guesses)', async () => {
    const manifest: GenerationManifest = {
      id: 'gen-backfill-bad-mp3',
      model: 'google/lyria-3-pro-preview',
      format: 'mp3',
      provider: 'openrouter',
      prompt: 'p',
      lyrics: 'l',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.mp3`), Buffer.from('not actually mp3 bytes'));

    const result = await listGenerations(tmpDir);
    expect(result[0].durationSeconds).toBeUndefined();
  });

  it('trusts the BYTES over the manifest format claim (legacy RIFF stored as .mp3)', async () => {
    const manifest: GenerationManifest = {
      id: 'gen-backfill-riff-in-mp3',
      model: 'google/lyria-3-pro-preview',
      format: 'mp3',
      provider: 'openrouter',
      prompt: 'p',
      lyrics: 'l',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${manifest.id}.mp3`), makeMockWav(6)); // RIFF bytes, .mp3 name

    const result = await listGenerations(tmpDir);
    expect(result[0].durationSeconds).toBeCloseTo(6.0, 1);
  });
});

// ---------------------------------------------------------------------------
// Security: id validation (path traversal), typed missing-key errors,
// atomic manifest writes.
// ---------------------------------------------------------------------------

/** The exact attack ids from the security review — all must be rejected before any fs call. */
const TRAVERSAL_IDS = ['../evil', '..%2f..%2fetc', 'gen-1/../../x', 'nope'];

describe('assertSafeId', () => {
  it('accepts an id in the exact format generateLyria produces', () => {
    const id = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    expect(() => assertSafeId(id, 'gen')).not.toThrow();
  });

  it('accepts an id in the exact format createProject produces', () => {
    const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    expect(() => assertSafeId(id, 'proj')).not.toThrow();
  });

  it.each(TRAVERSAL_IDS)('throws InvalidIdError for %j', (bad) => {
    expect(() => assertSafeId(bad)).toThrow(InvalidIdError);
  });

  it('rejects backslash separators and empty strings', () => {
    expect(() => assertSafeId('gen-1\\..\\x')).toThrow(InvalidIdError);
    expect(() => assertSafeId('')).toThrow(InvalidIdError);
  });

  it('enforces the expected prefix (a proj id is not a valid gen id and vice versa)', () => {
    expect(() => assertSafeId('proj-123-abc', 'gen')).toThrow(InvalidIdError);
    expect(() => assertSafeId('gen-123-abc', 'proj')).toThrow(InvalidIdError);
  });
});

describe('renameGeneration — id validation (path traversal)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyria-rename-safeid-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each(TRAVERSAL_IDS)('rejects id %j with InvalidIdError (→ would-be 400)', async (bad) => {
    await expect(renameGeneration(bad, 'New Title', tmpDir)).rejects.toThrow(InvalidIdError);
  });

  it('still works for a well-formed id', async () => {
    const id = 'gen-1712345678901-safe1a';
    const manifest: GenerationManifest = {
      id,
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'seed prompt',
      lyrics: 'seed lyrics',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, `${id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${id}.wav`), makeMockWav(1));

    const result = await renameGeneration(id, 'Safe Rename', tmpDir);
    expect(result.title).toBe('Safe Rename');
  });
});

describe('analyzeGeneration — id validation (path traversal)', () => {
  let tmpDir: string;
  const prevMock = process.env.LYRIA_MOCK;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyria-analyze-safeid-test-'));
    // Hermeticity: "still works for a well-formed id" asserts callAi IS invoked,
    // which the LYRIA_MOCK gate would prevent if the variable leaked in.
    delete process.env.LYRIA_MOCK;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (prevMock === undefined) {
      delete process.env.LYRIA_MOCK;
    } else {
      process.env.LYRIA_MOCK = prevMock;
    }
  });

  it.each(TRAVERSAL_IDS)('rejects id %j with InvalidIdError and never invokes the provider', async (bad) => {
    const callAi = vi.fn();
    await expect(analyzeGeneration({ id: bad, dir: tmpDir, callAi })).rejects.toThrow(InvalidIdError);
    expect(callAi).not.toHaveBeenCalled();
  });

  it('still works for a well-formed id', async () => {
    const id = 'gen-1712345678901-safe2b';
    const manifest: GenerationManifest = {
      id,
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'p',
      lyrics: 'l',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpDir, `${id}.json`), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(tmpDir, `${id}.wav`), Buffer.from('fake audio'), 'utf8');

    const analysis: Analysis = {
      title: 'Safe Analysis',
      genre: 'Techno',
      mood: 'Driving',
      energy: 50,
      bpm: null,
      key: null,
      instrumentation: [],
      sections: [],
      notes: '',
    };
    const callAi = vi.fn().mockResolvedValue(JSON.stringify(analysis));

    const result = await analyzeGeneration({ id, dir: tmpDir, callAi });
    expect(result.title).toBe('Safe Analysis');
    expect(callAi).toHaveBeenCalledTimes(1);
  });
});

describe('generateLyria — missing OpenRouter key (typed config error)', () => {
  const prevMock = process.env.LYRIA_MOCK;

  beforeEach(() => {
    delete process.env.LYRIA_MOCK;
  });

  afterEach(() => {
    if (prevMock === undefined) {
      delete process.env.LYRIA_MOCK;
    } else {
      process.env.LYRIA_MOCK = prevMock;
    }
  });

  it('throws MissingKeyError (→ would-be 400) with the original message when no OpenRouter key is configured', async () => {
    const pending = generateLyria(null, { prompt: 'Needs a key' }, { provider: 'openrouter' });
    await expect(pending).rejects.toBeInstanceOf(MissingKeyError);
    await expect(pending).rejects.toThrow('OPENROUTER_API_KEY is not configured. Please add it in the Settings.');
  });
});

describe('writeJsonAtomic', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyria-atomic-write-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes pretty-printed JSON that round-trips', async () => {
    const target = path.join(tmpDir, 'atomic.json');
    await writeJsonAtomic(target, { a: 1, nested: { b: 'two' } });

    const raw = await fs.readFile(target, 'utf8');
    expect(raw).toContain('\n'); // pretty-printed, not minified
    expect(JSON.parse(raw)).toEqual({ a: 1, nested: { b: 'two' } });
  });

  it('leaves no .tmp file behind', async () => {
    const target = path.join(tmpDir, 'atomic.json');
    await writeJsonAtomic(target, { ok: true });

    const entries = await fs.readdir(tmpDir);
    expect(entries).toEqual(['atomic.json']);
  });

  it('replaces an existing file in place (rename over target)', async () => {
    const target = path.join(tmpDir, 'atomic.json');
    await fs.writeFile(target, JSON.stringify({ old: true }), 'utf8');

    await writeJsonAtomic(target, { fresh: true });
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ fresh: true });
  });
});

// ---------------------------------------------------------------------------
// $0 dev mode (LYRIA_MOCK=1): deterministic mocks for the paid text/analyze
// endpoints, so mock mode never requires a key or makes a network call.
// ---------------------------------------------------------------------------

describe('mockModifyText ($0 dev-mode mock)', () => {
  it('echoes ONLY the selectedText (marked as mock) when a selection is provided', () => {
    const result = mockModifyText({
      instruction: 'make it darker',
      currentText: 'full lyrics here',
      selectedText: 'chorus line',
    });
    expect(result.startsWith('[mock')).toBe(true);
    expect(result).toContain('chorus line');
    expect(result).not.toContain('full lyrics here');
  });

  it('echoes the full currentText (marked as mock) when no selection is provided', () => {
    const result = mockModifyText({
      instruction: 'make it darker',
      currentText: 'full lyrics here',
    });
    expect(result.startsWith('[mock')).toBe(true);
    expect(result).toContain('full lyrics here');
  });

  it('includes the instruction and is deterministic', () => {
    const args = { instruction: 'add a bridge', currentText: 'verse text' };
    const first = mockModifyText(args);
    const second = mockModifyText(args);
    expect(first).toContain('add a bridge');
    expect(first).toBe(second);
  });

  it('tolerates missing currentText without throwing', () => {
    expect(() => mockModifyText({ instruction: 'x' })).not.toThrow();
  });
});

describe('mockEnhancePrompt ($0 dev-mode mock)', () => {
  it('is clearly marked as mock and contains the original prompt', () => {
    const result = mockEnhancePrompt('  lo-fi beat  ');
    expect(result.startsWith('[mock')).toBe(true);
    expect(result).toContain('lo-fi beat');
  });

  it('is deterministic', () => {
    expect(mockEnhancePrompt('synthwave')).toBe(mockEnhancePrompt('synthwave'));
  });
});

describe('buildMockAnalysis ($0 dev-mode mock)', () => {
  it('produces a valid Analysis shape that round-trips through parseAnalysis', () => {
    const analysis = buildMockAnalysis('Cinematic darkwave track');
    // parseAnalysis enforces the required title/genre/mood strings and coerces the rest —
    // round-tripping proves the mock satisfies the exact contract of a real analysis.
    expect(parseAnalysis(JSON.stringify(analysis))).toEqual(analysis);
  });

  it('titles the analysis "[mock] <first words of the generation prompt>"', () => {
    const analysis = buildMockAnalysis('Cinematic darkwave track with heavy synths');
    expect(analysis.title).toBe('[mock] Cinematic darkwave track with heavy synths');
  });

  it('caps the title at the first 6 words of a longer prompt', () => {
    const analysis = buildMockAnalysis('one two three four five six seven eight');
    expect(analysis.title).toBe('[mock] one two three four five six');
  });

  it('uses null bpm/key, empty arrays, and an integer energy in 0-100', () => {
    const analysis = buildMockAnalysis('anything');
    expect(analysis.bpm).toBeNull();
    expect(analysis.key).toBeNull();
    expect(analysis.instrumentation).toEqual([]);
    expect(analysis.sections).toEqual([]);
    expect(Number.isInteger(analysis.energy)).toBe(true);
    expect(analysis.energy).toBeGreaterThanOrEqual(0);
    expect(analysis.energy).toBeLessThanOrEqual(100);
  });

  it('falls back to a usable title for an empty/whitespace prompt', () => {
    const analysis = buildMockAnalysis('   ');
    expect(analysis.title.startsWith('[mock]')).toBe(true);
    expect(analysis.title.length).toBeGreaterThan('[mock]'.length);
  });

  it('derives one clearly-mock-labeled full-take section when a real duration is known', () => {
    const analysis = buildMockAnalysis('anything', 8);
    expect(analysis.sections).toEqual([{ name: '[mock] full take', start: '00:00', end: '00:08' }]);
    // Still round-trips through the real parser with sections present.
    expect(parseAnalysis(JSON.stringify(analysis))).toEqual(analysis);
  });

  it('emits no sections without a usable duration — the mock never invents structure', () => {
    expect(buildMockAnalysis('anything').sections).toEqual([]);
    expect(buildMockAnalysis('anything', 0).sections).toEqual([]);
    expect(buildMockAnalysis('anything', NaN).sections).toEqual([]);
    expect(buildMockAnalysis('anything', -5).sections).toEqual([]);
  });
});

describe('analyzeGeneration — LYRIA_MOCK=1 ($0 dev mode, no provider call)', () => {
  let tmpDir: string;
  const prevMock = process.env.LYRIA_MOCK;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyria-analyze-mock-test-'));
    process.env.LYRIA_MOCK = '1';
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (prevMock === undefined) {
      delete process.env.LYRIA_MOCK;
    } else {
      process.env.LYRIA_MOCK = prevMock;
    }
  });

  async function seedManifest(id: string, extra: Partial<GenerationManifest> = {}): Promise<GenerationManifest> {
    const manifest: GenerationManifest = {
      id,
      model: 'lyria-3-pro-preview',
      format: 'wav',
      provider: 'mock',
      prompt: 'Cinematic darkwave track with heavy synths',
      lyrics: 'l',
      generatedAt: '2026-01-01T00:00:00.000Z',
      ...extra,
    };
    await fs.writeFile(path.join(tmpDir, `${id}.json`), JSON.stringify(manifest), 'utf8');
    return manifest;
  }

  it('returns a deterministic mock analysis without ever invoking callAi', async () => {
    await seedManifest('gen-1-mockanalyze');
    await fs.writeFile(path.join(tmpDir, 'gen-1-mockanalyze.wav'), makeMockWav(1));

    const callAi = vi.fn();
    const result = await analyzeGeneration({ id: 'gen-1-mockanalyze', dir: tmpDir, callAi });

    expect(callAi).not.toHaveBeenCalled();
    expect(result.title).toBe('[mock] Cinematic darkwave track with heavy synths');
    expect(result).toEqual(buildMockAnalysis('Cinematic darkwave track with heavy synths'));
  });

  it('works even when the audio file is missing (mock gate sits before the audio read)', async () => {
    await seedManifest('gen-2-mocknoaudio');
    // Intentionally no audio file written.

    const callAi = vi.fn();
    const result = await analyzeGeneration({ id: 'gen-2-mocknoaudio', dir: tmpDir, callAi });

    expect(callAi).not.toHaveBeenCalled();
    expect(result.title.startsWith('[mock]')).toBe(true);
  });

  it('does NOT persist the mock analysis into the manifest', async () => {
    await seedManifest('gen-3-mocknopersist');

    await analyzeGeneration({ id: 'gen-3-mocknopersist', dir: tmpDir, callAi: vi.fn() });

    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, 'gen-3-mocknopersist.json'), 'utf8'));
    expect(persisted.analysis).toBeUndefined();
  });

  it('a previously cached REAL analysis still wins over the mock when force is falsy', async () => {
    const cached: Analysis = {
      title: 'Real Cached Track',
      genre: 'Synthwave',
      mood: 'Nostalgic',
      energy: 60,
      bpm: 110,
      key: 'C major',
      instrumentation: ['synth lead'],
      sections: [],
      notes: 'Previously analyzed for real.',
    };
    await seedManifest('gen-4-mockcached', { analysis: cached } as Partial<GenerationManifest>);

    const callAi = vi.fn();
    const result = await analyzeGeneration({ id: 'gen-4-mockcached', force: false, dir: tmpDir, callAi });

    expect(result).toEqual(cached);
    expect(callAi).not.toHaveBeenCalled();
  });

  it('force=true in mock mode returns the mock (not the cache) and still never calls callAi', async () => {
    const cached: Analysis = {
      title: 'Real Cached Track',
      genre: 'Synthwave',
      mood: 'Nostalgic',
      energy: 60,
      bpm: 110,
      key: 'C major',
      instrumentation: ['synth lead'],
      sections: [],
      notes: 'Previously analyzed for real.',
    };
    await seedManifest('gen-5-mockforce', { analysis: cached } as Partial<GenerationManifest>);

    const callAi = vi.fn();
    const result = await analyzeGeneration({ id: 'gen-5-mockforce', force: true, dir: tmpDir, callAi });

    expect(result.title.startsWith('[mock]')).toBe(true);
    expect(callAi).not.toHaveBeenCalled();

    // The cached real analysis must survive untouched on disk.
    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, 'gen-5-mockforce.json'), 'utf8'));
    expect(persisted.analysis).toEqual(cached);
  });
});

// ---------------------------------------------------------------------------
// GET /api/openrouter/credits upstream-response mapping.
// Docs-verified (OpenRouter getCredits): the /api/v1/credits endpoint requires a
// MANAGEMENT key and returns 403 for a plain inference key. The client
// (getOpenRouterCredits in src/lib/lyriaClient.ts) treats our 404 as null, so 403
// maps to 404 (silently no balance shown) instead of a surfaced 502 error.
// ---------------------------------------------------------------------------

describe('mapOpenRouterCreditsResponse', () => {
  it('maps a successful upstream body to 200 with available:true and a rounded balance', () => {
    const mapped = mapOpenRouterCreditsResponse({
      ok: true,
      status: 200,
      data: { data: { total_credits: 10.4567, total_usage: 3.2111 } },
    });
    expect(mapped.status).toBe(200);
    expect(mapped.body).toEqual({
      available: true,
      totalCredits: 10.4567,
      totalUsage: 3.2111,
      balance: 7.25, // rounded to 2 decimals
    });
  });

  it('defaults missing upstream totals to 0', () => {
    const mapped = mapOpenRouterCreditsResponse({ ok: true, status: 200, data: {} });
    expect(mapped.status).toBe(200);
    expect(mapped.body).toEqual({ available: true, totalCredits: 0, totalUsage: 0, balance: 0 });
  });

  it('maps upstream 403 (inference key lacks the management-key permission) to a 404', () => {
    const mapped = mapOpenRouterCreditsResponse({ ok: false, status: 403, errText: 'Forbidden' });
    expect(mapped.status).toBe(404);
    expect(String(mapped.body.error)).toMatch(/management key/i);
  });

  it('maps an upstream 401 (bad key) to a 502 carrying the status and body text', () => {
    const mapped = mapOpenRouterCreditsResponse({ ok: false, status: 401, errText: 'Unauthorized' });
    expect(mapped.status).toBe(502);
    expect(String(mapped.body.error)).toContain('401');
    expect(String(mapped.body.error)).toContain('Unauthorized');
  });

  it('maps an upstream 500 to a 502', () => {
    const mapped = mapOpenRouterCreditsResponse({ ok: false, status: 500, errText: 'boom' });
    expect(mapped.status).toBe(502);
    expect(String(mapped.body.error)).toContain('500');
  });
});

// ---------------------------------------------------------------------------
// Format detection + rename anti-corruption (docs-verified: OpenRouter's
// audio.format is a request-side hint that "varies by model" — an OpenRouter
// wav request can return MP3 bytes — and every Lyria output carries C2PA
// provenance metadata that must never be stripped).
// ---------------------------------------------------------------------------

/** Encodes a value as the 4-byte syncsafe integer ID3v2 uses for tag (and v2.4 frame) sizes. */
const syncsafe4 = (value: number): Buffer =>
  Buffer.from([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]);

/** Builds a full ID3v2 tag (v2.3 regular or v2.4 syncsafe frame sizes) from raw frames. */
const buildId3Tag = (
  frames: { id: string; body: Buffer; flags?: number }[],
  version: 3 | 4 = 3,
): Buffer => {
  const frameBufs = frames.map(f => {
    const frame = Buffer.alloc(10 + f.body.length);
    frame.write(f.id, 0, 'ascii');
    if (version === 4) {
      syncsafe4(f.body.length).copy(frame, 4);
    } else {
      frame.writeUInt32BE(f.body.length, 4);
    }
    frame.writeUInt16BE(f.flags ?? 0, 8);
    f.body.copy(frame, 10);
    return frame;
  });
  const framesBody = Buffer.concat(frameBufs);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'ascii');
  header.writeUInt8(version, 3);
  header.writeUInt8(0, 4); // revision
  header.writeUInt8(0, 5); // flags
  syncsafe4(framesBody.length).copy(header, 6);
  return Buffer.concat([header, framesBody]);
};

/** Byte length of an ID3v2 tag at the start of the buffer (0 if none) — mirrors the impl. */
const id3TagLength = (mp3: Buffer): number => {
  if (mp3.length < 10 || mp3.toString('ascii', 0, 3) !== 'ID3') return 0;
  return 10 + (((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f));
};

/** Raw body bytes of the first frame with the given id in a v2.3-sized tag, or undefined. */
const readId3FrameBodyRaw = (mp3: Buffer, frameId: string): Buffer | undefined => {
  const tagEnd = id3TagLength(mp3);
  let offset = 10;
  while (offset + 10 <= tagEnd) {
    const id = mp3.toString('ascii', offset, offset + 4);
    const frameSize = mp3.readUInt32BE(offset + 4);
    if (id === frameId) return mp3.subarray(offset + 10, offset + 10 + frameSize);
    offset += 10 + frameSize;
  }
  return undefined;
};

/** ISO-8859-1 text of a v2.3 text frame body (strips encoding byte + trailing NULs). */
const id3FrameText = (body: Buffer | undefined): string | undefined =>
  body === undefined ? undefined : body.subarray(1).toString('latin1').replace(/\0+$/, '');

/** An ID3v2.3 TIT2 body (ISO-8859-1). */
const tit2Body = (title: string): Buffer =>
  Buffer.concat([Buffer.from([0x00]), Buffer.from(title, 'latin1'), Buffer.from([0x00])]);

/** A GEOB frame body carrying a fake C2PA manifest blob (enc + mime + filename + description + blob). */
const geobBody = (payload = 'FAKE-C2PA-MANIFEST-BYTES'): Buffer => Buffer.concat([
  Buffer.from([0x00]),
  Buffer.from('application/c2pa\0', 'latin1'),
  Buffer.from('manifest\0', 'latin1'),
  Buffer.from('C2PA\0', 'latin1'),
  Buffer.from(payload, 'latin1'),
]);

/** Raw MPEG audio frame bytes (0xFF 0xFB frame sync + fake frame data). */
const mpegAudioBytes = (): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.from('MP3AUDIOFRAMEBYTES-'.repeat(4), 'latin1')]);

describe('detectAudioFormat', () => {
  it('detects a real RIFF/WAVE buffer as wav', () => {
    expect(detectAudioFormat(makeMockWav(1))).toBe('wav');
  });

  it('detects an ID3-tagged buffer as mp3', () => {
    const mp3 = Buffer.concat([buildId3Tag([{ id: 'TIT2', body: tit2Body('X') }]), mpegAudioBytes()]);
    expect(detectAudioFormat(mp3)).toBe('mp3');
  });

  it.each([[0xfb], [0xf3], [0xf2], [0xe0]])(
    'detects a raw MPEG frame sync (0xFF 0x%s) as mp3',
    (second) => {
      expect(detectAudioFormat(Buffer.from([0xff, second as number, 0x90, 0x00]))).toBe('mp3');
    },
  );

  it('returns unknown for 0xFF NOT followed by the 0xE0 sync bits', () => {
    expect(detectAudioFormat(Buffer.from([0xff, 0x1f, 0x90, 0x00]))).toBe('unknown');
  });

  it('returns unknown for RIFF without WAVE (e.g. an AVI container)', () => {
    const avi = Buffer.concat([Buffer.from('RIFF'), Buffer.from([16, 0, 0, 0]), Buffer.from('AVI LIST')]);
    expect(detectAudioFormat(avi)).toBe('unknown');
  });

  it('returns unknown for text bytes, empty, and too-short buffers', () => {
    expect(detectAudioFormat(Buffer.from('not audio at all'))).toBe('unknown');
    expect(detectAudioFormat(Buffer.alloc(0))).toBe('unknown');
    expect(detectAudioFormat(Buffer.from([0xff]))).toBe('unknown');
  });
});

describe('embedId3 — preserves existing non-TIT2/TPE1/COMM frames (C2PA/provenance)', () => {
  it('replaces TIT2 but carries an existing GEOB frame over byte-identically', () => {
    const geob = geobBody();
    const mp3 = Buffer.concat([
      buildId3Tag([{ id: 'TIT2', body: tit2Body('Old Title') }, { id: 'GEOB', body: geob }]),
      mpegAudioBytes(),
    ]);

    const out = embedId3(mp3, { title: 'New Title' });

    expect(id3FrameText(readId3FrameBodyRaw(out, 'TIT2'))).toBe('New Title');
    const preservedGeob = readId3FrameBodyRaw(out, 'GEOB');
    expect(preservedGeob).toBeDefined();
    expect(preservedGeob!.equals(geob)).toBe(true);
    // Audio frame bytes preserved untouched after the tag.
    expect(out.subarray(id3TagLength(out)).equals(mpegAudioBytes())).toBe(true);
  });

  it('replaces only TIT2/TPE1/COMM; other frames (TXXX) survive alongside GEOB', () => {
    const txxx = Buffer.concat([Buffer.from([0x00]), Buffer.from('key\0value', 'latin1')]);
    const mp3 = Buffer.concat([
      buildId3Tag([
        { id: 'TPE1', body: tit2Body('Old Artist') },
        { id: 'TXXX', body: txxx },
        { id: 'GEOB', body: geobBody('BLOB2') },
      ]),
      mpegAudioBytes(),
    ]);

    const out = embedId3(mp3, { title: 'T', artist: 'New Artist', comment: 'c' });

    expect(id3FrameText(readId3FrameBodyRaw(out, 'TPE1'))).toBe('New Artist');
    expect(readId3FrameBodyRaw(out, 'TXXX')!.equals(txxx)).toBe(true);
    expect(readId3FrameBodyRaw(out, 'GEOB')!.equals(geobBody('BLOB2'))).toBe(true);
  });

  it('preserves a large (>127-byte) GEOB from an ID3v2.4 tag (syncsafe frame sizes decoded correctly)', () => {
    const bigGeob = geobBody('X'.repeat(300)); // frame size needs multi-byte syncsafe decoding
    const mp3 = Buffer.concat([
      buildId3Tag([{ id: 'GEOB', body: bigGeob }, { id: 'TIT2', body: tit2Body('Old') }], 4),
      mpegAudioBytes(),
    ]);

    const out = embedId3(mp3, { title: 'Renamed' });

    expect(id3FrameText(readId3FrameBodyRaw(out, 'TIT2'))).toBe('Renamed');
    expect(readId3FrameBodyRaw(out, 'GEOB')!.equals(bigGeob)).toBe(true);
    expect(out.subarray(id3TagLength(out)).equals(mpegAudioBytes())).toBe(true);
  });

  it('returns the buffer UNCHANGED when the existing tag cannot be safely re-written (flagged frames)', () => {
    // A frame with format-altering flags (e.g. compression) cannot be blindly copied; the
    // only provenance-safe move is to leave the whole file untouched.
    const mp3 = Buffer.concat([
      buildId3Tag([{ id: 'GEOB', body: geobBody(), flags: 0x0080 }]),
      mpegAudioBytes(),
    ]);

    const out = embedId3(mp3, { title: 'New Title' });
    expect(out.equals(mp3)).toBe(true);
  });
});

describe('generateLyria (mock mode) — extension, manifest and bytes always agree', () => {
  const GEN_DIR = path.join(process.cwd(), 'generations');
  const prevMock = process.env.LYRIA_MOCK;
  let createdId: string | undefined;

  beforeEach(() => {
    process.env.LYRIA_MOCK = '1';
  });

  afterEach(async () => {
    process.env.LYRIA_MOCK = prevMock;
    if (createdId) {
      await fs.rm(path.join(GEN_DIR, `${createdId}.wav`), { force: true });
      await fs.rm(path.join(GEN_DIR, `${createdId}.mp3`), { force: true });
      await fs.rm(path.join(GEN_DIR, `${createdId}.json`), { force: true });
      createdId = undefined;
    }
  });

  it('writes <id>.<ext> whose extension, manifest format field, and magic bytes all match', async () => {
    const result = await generateLyria(null, { prompt: 'Agreement check', model: 'pro' });
    createdId = result.id;

    expect(result.format).toBe('wav');
    expect(result.audioUrl).toBe(`/generations/${result.id}.wav`);

    const manifest = JSON.parse(await fs.readFile(path.join(GEN_DIR, `${result.id}.json`), 'utf8')) as GenerationManifest;
    expect(manifest.format).toBe('wav');

    const written = await fs.readFile(path.join(GEN_DIR, `${result.id}.${manifest.format}`));
    expect(detectAudioFormat(written)).toBe(manifest.format);
  });
});

describe('renameGeneration — embedder chosen from ACTUAL bytes (anti-corruption guarantee)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyria-rename-anticorrupt-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function seedManifest(id: string, format: 'wav' | 'mp3'): Promise<void> {
    const manifest: GenerationManifest = {
      id,
      model: format === 'mp3' ? 'lyria-3-clip-preview' : 'lyria-3-pro-preview',
      format,
      provider: 'openrouter',
      prompt: 'seed prompt',
      lyrics: 'seed lyrics',
      generatedAt: '2026-01-01T00:00:00.000Z',
      title: 'Old Title',
    };
    await fs.writeFile(path.join(tmpDir, `${id}.json`), JSON.stringify(manifest), 'utf8');
  }

  it('MISLABELED file (manifest claims wav, bytes are ID3 mp3) is NEVER run through the RIFF rebuilder', async () => {
    // The exact data-destroying bug: OpenRouter returned MP3 for a wav request; the old code
    // trusted the manifest and ran embedWavInfo (a RIFF rebuilder) over the MP3 bytes,
    // shrinking the track to an ~11KB fragment and destroying the C2PA GEOB frame.
    const id = 'gen-10-mislabeled';
    const geob = geobBody('REAL-PROVENANCE');
    const audioTail = mpegAudioBytes();
    const original = Buffer.concat([
      buildId3Tag([{ id: 'TIT2', body: tit2Body('Old Title') }, { id: 'GEOB', body: geob }]),
      audioTail,
    ]);
    await seedManifest(id, 'wav'); // manifest LIES: claims wav
    await fs.writeFile(path.join(tmpDir, `${id}.wav`), original); // mp3 bytes in a .wav file

    const result = await renameGeneration(id, 'Fixed Title', tmpDir);
    expect(result.title).toBe('Fixed Title');

    const written = await fs.readFile(path.join(tmpDir, `${id}.wav`));
    expect(detectAudioFormat(written)).toBe('mp3'); // still a real mp3, NOT a fake RIFF shell
    expect(id3FrameText(readId3FrameBodyRaw(written, 'TIT2'))).toBe('Fixed Title');
    expect(readId3FrameBodyRaw(written, 'GEOB')!.equals(geob)).toBe(true); // provenance survives
    expect(written.subarray(id3TagLength(written)).equals(audioTail)).toBe(true); // audio byte-identical
    expect(written.length).toBeGreaterThanOrEqual(audioTail.length); // corrupt-shrink impossible
  });

  it('real RIFF wav: embeds INAM, stays valid, data chunk byte-identical, duration unchanged, never smaller than the audio payload', async () => {
    const id = 'gen-11-realwav';
    const wav = makeMockWav(2);
    await seedManifest(id, 'wav');
    await fs.writeFile(path.join(tmpDir, `${id}.wav`), wav);

    await renameGeneration(id, 'Proper Wav Title', tmpDir);

    const written = await fs.readFile(path.join(tmpDir, `${id}.wav`));
    expect(detectAudioFormat(written)).toBe('wav');
    expect(parseListInfo(written).INAM).toBe('Proper Wav Title');
    expect(wavDurationSeconds(written)).toBe(wavDurationSeconds(wav)); // audio duration untouched

    const beforeData = walkRiffChunks(wav).find(c => c.id === 'data')!;
    const afterData = walkRiffChunks(written).find(c => c.id === 'data')!;
    expect(
      written.subarray(afterData.bodyOffset, afterData.bodyOffset + afterData.size)
        .equals(wav.subarray(beforeData.bodyOffset, beforeData.bodyOffset + beforeData.size)),
    ).toBe(true);
    expect(written.length).toBeGreaterThanOrEqual(beforeData.size); // corrupt-shrink impossible
  });

  it('correctly-labeled ID3 mp3: title frame updated, GEOB + audio frames preserved', async () => {
    const id = 'gen-12-realmp3';
    const geob = geobBody('CLIP-PROVENANCE');
    const audioTail = mpegAudioBytes();
    const original = Buffer.concat([
      buildId3Tag([{ id: 'TIT2', body: tit2Body('Old') }, { id: 'GEOB', body: geob }]),
      audioTail,
    ]);
    await seedManifest(id, 'mp3');
    await fs.writeFile(path.join(tmpDir, `${id}.mp3`), original);

    const result = await renameGeneration(id, 'New MP3 Title', tmpDir);
    expect(result.title).toBe('New MP3 Title');

    const written = await fs.readFile(path.join(tmpDir, `${id}.mp3`));
    expect(detectAudioFormat(written)).toBe('mp3');
    expect(id3FrameText(readId3FrameBodyRaw(written, 'TIT2'))).toBe('New MP3 Title');
    expect(readId3FrameBodyRaw(written, 'GEOB')!.equals(geob)).toBe(true);
    expect(written.subarray(id3TagLength(written)).equals(audioTail)).toBe(true);
  });

  it('UNKNOWN bytes: manifest title updates but the audio file stays byte-for-byte UNCHANGED', async () => {
    const id = 'gen-13-unknownbytes';
    const mystery = Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2, 0, 0]), Buffer.from('some opus-ish payload bytes')]);
    await seedManifest(id, 'wav'); // manifest claim is irrelevant — bytes are unidentifiable
    await fs.writeFile(path.join(tmpDir, `${id}.wav`), mystery);

    const result = await renameGeneration(id, 'Mystery Title', tmpDir);
    expect(result.title).toBe('Mystery Title');

    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, `${id}.json`), 'utf8'));
    expect(persisted.title).toBe('Mystery Title');

    const written = await fs.readFile(path.join(tmpDir, `${id}.wav`));
    expect(written.equals(mystery)).toBe(true); // NEVER rewrite bytes we cannot identify
  });
});
