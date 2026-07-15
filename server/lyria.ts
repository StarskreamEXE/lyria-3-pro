export interface PromptParts {
  prompt: string;
  lyrics: string;
  language: string;
  durationTarget: string;
  model?: 'pro' | 'clip';
}

export function assembleLyriaPrompt(parts: PromptParts): string {
  const prompt = parts.prompt.trim();
  if (!prompt) throw new Error('Prompt cannot be empty.');

  const sections: string[] = [prompt];
  if (parts.model !== 'clip' && parts.durationTarget) {
    sections.push(`Target duration: approximately ${parts.durationTarget}.`);
  }
  const lyrics = parts.lyrics.trim();
  if (lyrics) {
    sections.push(`Lyrics (sing in ${parts.language || 'EN'}):\n\n${lyrics}`);
  }
  return sections.join('\n\n');
}

export interface ParsedLyriaResponse {
  interactionId?: string;
  audio: Buffer;
  textBlocks: string[];
  jsonBlocks: unknown[];
  rawTextBlocks: string[];
}

export function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();

  const looksLikeObject =
    trimmed.startsWith("{") && trimmed.endsWith("}");

  const looksLikeArray =
    trimmed.startsWith("[") && trimmed.endsWith("]");

  if (!looksLikeObject && !looksLikeArray) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function parseInteraction(interaction: any): ParsedLyriaResponse {
  const textBlocks: string[] = [];
  const rawTextBlocks: string[] = [];
  const jsonBlocks: unknown[] = [];
  const audioBlocks: Buffer[] = [];

  for (const step of interaction.steps ?? []) {
    if (step?.type !== "model_output") {
      continue;
    }

    for (const contentBlock of step.content ?? []) {
      if (contentBlock?.type === "audio" && contentBlock.data) {
        audioBlocks.push(
          Buffer.from(contentBlock.data, "base64"),
        );
        continue;
      }

      if (contentBlock?.type === "text" && contentBlock.text) {
        const text = String(contentBlock.text);
        rawTextBlocks.push(text);

        const parsedJson = tryParseJson(text);

        if (parsedJson !== undefined) {
          jsonBlocks.push(parsedJson);
        } else {
          textBlocks.push(text);
        }
      }
    }
  }

  if (audioBlocks.length === 0 && interaction.output_audio?.data) {
    audioBlocks.push(
      Buffer.from(interaction.output_audio.data, "base64"),
    );
  }

  if (
    rawTextBlocks.length === 0 &&
    typeof interaction.output_text === "string"
  ) {
    const text = interaction.output_text;
    rawTextBlocks.push(text);

    const parsedJson = tryParseJson(text);

    if (parsedJson !== undefined) {
      jsonBlocks.push(parsedJson);
    } else {
      textBlocks.push(text);
    }
  }

  if (audioBlocks.length === 0) {
    throw new Error("Lyria returned no audio block.");
  }

  return {
    interactionId: interaction.id,
    audio: Buffer.concat(audioBlocks),
    textBlocks,
    jsonBlocks,
    rawTextBlocks,
  };
}

export interface ParsedOpenRouterAudioSSE {
  audio: Buffer;
  transcript: string;
  textBlocks: string[];
}

/**
 * Parses a full accumulated OpenRouter chat-completions SSE stream (audio-output mode)
 * into a single decoded audio buffer, the concatenated sung transcript, and any plain
 * delta.content text blocks. Pure/sync so it's unit-testable without a live stream.
 */
export function parseOpenRouterAudioSSE(sseText: string): ParsedOpenRouterAudioSSE {
  const audioFragments: string[] = [];
  const transcriptFragments: string[] = [];
  const textBlocks: string[] = [];

  const lines = sseText.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;

    const data = trimmed.slice('data:'.length).trim();
    if (data === '[DONE]') break;
    if (!data) continue;

    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue; // ignore malformed/keep-alive lines
    }

    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) continue;

    const audio = delta.audio;
    if (audio?.data) audioFragments.push(audio.data);
    if (audio?.transcript) transcriptFragments.push(audio.transcript);

    if (typeof delta.content === 'string' && delta.content) {
      textBlocks.push(delta.content);
    }
  }

  if (audioFragments.length === 0) {
    throw new Error('OpenRouter returned no audio fragments in the SSE stream.');
  }

  return {
    audio: Buffer.from(audioFragments.join(''), 'base64'),
    transcript: transcriptFragments.join(''),
    textBlocks,
  };
}

export function makeMockWav(seconds = 8): Buffer {
  const rate = 44100, channels = 2, bytesPer = 2;
  const frames = seconds * rate;
  const dataLen = frames * channels * bytesPer;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii'); buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * bytesPer, 28);
  buf.writeUInt16LE(channels * bytesPer, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(dataLen, 40);
  const base = 110 + Math.random() * 110;
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 4) * Math.min(1, (seconds - t) * 4) * 0.3;
    const s = env * (Math.sin(2 * Math.PI * base * t) + 0.5 * Math.sin(2 * Math.PI * base * 1.5 * t) + 0.25 * Math.sin(2 * Math.PI * base * 2.02 * t));
    const v = Math.max(-1, Math.min(1, s)) * 32767;
    buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 44 + i * 4 + 2);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Embedded audio metadata: WAV LIST/INFO chunk + ID3v2.3 tag, plus wav duration parsing.
// ---------------------------------------------------------------------------

export interface EmbedTags {
  title?: string;
  artist?: string;
  comment?: string;
}

interface RiffChunk {
  id: string;
  size: number;
  bodyOffset: number;
}

/** Walks top-level RIFF chunks (id/size/bodyOffset), not recursing into LIST sub-chunks. */
function walkRiffChunks(wav: Buffer): RiffChunk[] {
  const chunks: RiffChunk[] = [];
  let offset = 12; // past 'RIFF' + size(4) + 'WAVE'
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const bodyOffset = offset + 8;
    if (bodyOffset + size > wav.length) break; // malformed/truncated chunk; stop walking
    chunks.push({ id, size, bodyOffset });
    offset = bodyOffset + size + (size % 2); // word-align
  }
  return chunks;
}

/** Builds one null-terminated, word-aligned LIST/INFO sub-chunk (e.g. INAM/IART/ICMT). */
function buildInfoSubChunk(id: string, value: string): Buffer {
  const textBuf = Buffer.from(value, 'latin1');
  const dataLen = textBuf.length + 1; // + NUL terminator
  const padded = dataLen % 2 === 1;
  const chunk = Buffer.alloc(8 + dataLen + (padded ? 1 : 0));
  chunk.write(id, 0, 'ascii');
  chunk.writeUInt32LE(dataLen, 4);
  textBuf.copy(chunk, 8);
  chunk.writeUInt8(0, 8 + textBuf.length); // NUL terminator
  // trailing pad byte (if any) is already zero from Buffer.alloc
  return chunk;
}

/**
 * Appends (or replaces an existing) RIFF LIST/INFO chunk carrying INAM/IART/ICMT tags onto a
 * WAV buffer, and fixes up the outer RIFF size field. The 'data' chunk and every other existing
 * chunk are copied through untouched. Embedding twice replaces the previous LIST/INFO chunk
 * rather than duplicating it. Pure function — takes and returns Buffers, no I/O.
 */
export function embedWavInfo(wav: Buffer, tags: EmbedTags): Buffer {
  const chunks = walkRiffChunks(wav);

  // Keep every existing chunk except a prior LIST/INFO chunk (which we're replacing).
  const keptRanges: { start: number; end: number }[] = [];
  for (const chunk of chunks) {
    const chunkEnd = chunk.bodyOffset + chunk.size + (chunk.size % 2);
    if (chunk.id === 'LIST') {
      const listType = wav.toString('ascii', chunk.bodyOffset, chunk.bodyOffset + 4);
      if (listType === 'INFO') continue; // drop old LIST/INFO chunk
    }
    keptRanges.push({ start: chunk.bodyOffset - 8, end: chunkEnd });
  }

  const keptBuffers = keptRanges.map(r => wav.subarray(r.start, r.end));

  const subChunks: Buffer[] = [];
  if (tags.title !== undefined) subChunks.push(buildInfoSubChunk('INAM', tags.title));
  if (tags.artist !== undefined) subChunks.push(buildInfoSubChunk('IART', tags.artist));
  if (tags.comment !== undefined) subChunks.push(buildInfoSubChunk('ICMT', tags.comment));

  const infoBody = Buffer.concat([Buffer.from('INFO', 'ascii'), ...subChunks]);
  const listChunk = Buffer.alloc(8 + infoBody.length);
  listChunk.write('LIST', 0, 'ascii');
  listChunk.writeUInt32LE(infoBody.length, 4);
  infoBody.copy(listChunk, 8);

  const body = Buffer.concat([...keptBuffers, listChunk]);
  const out = Buffer.alloc(12 + body.length);
  out.write('RIFF', 0, 'ascii');
  out.write('WAVE', 8, 'ascii');
  body.copy(out, 12);
  out.writeUInt32LE(out.length - 8, 4); // RIFF size = total length minus 'RIFF'+size field itself

  return out;
}

/**
 * Parses a WAV buffer's fmt byteRate and data chunk size into a duration in seconds, rounded to
 * 1 decimal place. Returns null if the buffer isn't a parseable RIFF/WAVE, or is missing a fmt
 * or data chunk, or has a zero byteRate (would divide by zero).
 */
export function wavDurationSeconds(wav: Buffer): number | null {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  const chunks = walkRiffChunks(wav);
  const fmtChunk = chunks.find(c => c.id === 'fmt ');
  const dataChunk = chunks.find(c => c.id === 'data');
  if (!fmtChunk || !dataChunk || fmtChunk.size < 16) return null;

  const byteRate = wav.readUInt32LE(fmtChunk.bodyOffset + 8);
  if (!byteRate) return null;

  const seconds = dataChunk.size / byteRate;
  return Math.round(seconds * 10) / 10;
}

/** Converts a regular (max 28-bit) integer into the 4-byte syncsafe form ID3v2 uses for its tag size. */
function toSyncsafe(value: number): Buffer {
  const out = Buffer.alloc(4);
  out[0] = (value >>> 21) & 0x7f;
  out[1] = (value >>> 14) & 0x7f;
  out[2] = (value >>> 7) & 0x7f;
  out[3] = value & 0x7f;
  return out;
}

/** Builds one ID3v2.3 text frame (TIT2/TPE1) using ISO-8859-1 encoding (encoding byte 0x00). */
function buildId3TextFrame(frameId: string, value: string): Buffer {
  const textBuf = Buffer.from(value, 'latin1');
  const frameBody = Buffer.concat([Buffer.from([0x00]), textBuf, Buffer.from([0x00])]); // encoding + text + NUL
  const frame = Buffer.alloc(10 + frameBody.length);
  frame.write(frameId, 0, 'ascii');
  frame.writeUInt32BE(frameBody.length, 4); // regular (non-syncsafe) size in ID3v2.3 frame headers
  frame.writeUInt16BE(0, 8); // flags
  frameBody.copy(frame, 10);
  return frame;
}

/** Builds an ID3v2.3 COMM frame (encoding + 'eng' language + empty short-description + comment text). */
function buildId3CommentFrame(value: string): Buffer {
  const textBuf = Buffer.from(value, 'latin1');
  const frameBody = Buffer.concat([
    Buffer.from([0x00]), // encoding: ISO-8859-1
    Buffer.from('eng', 'ascii'), // language
    Buffer.from([0x00]), // empty short description + its NUL terminator
    textBuf,
    Buffer.from([0x00]), // NUL terminator for the comment text
  ]);
  const frame = Buffer.alloc(10 + frameBody.length);
  frame.write('COMM', 0, 'ascii');
  frame.writeUInt32BE(frameBody.length, 4);
  frame.writeUInt16BE(0, 8);
  frameBody.copy(frame, 10);
  return frame;
}

/** Returns the byte length of an existing ID3v2 tag at the start of `mp3` (via its syncsafe size), or 0 if none. */
function existingId3TagLength(mp3: Buffer): number {
  if (mp3.length < 10 || mp3.toString('ascii', 0, 3) !== 'ID3') return 0;
  const size = ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
  return 10 + size;
}

/** Reads a 4-byte syncsafe integer (used for all ID3v2 tag sizes and for ID3v2.4 frame sizes). */
function readSyncsafe(buf: Buffer, offset: number): number {
  return ((buf[offset] & 0x7f) << 21) | ((buf[offset + 1] & 0x7f) << 14) | ((buf[offset + 2] & 0x7f) << 7) | (buf[offset + 3] & 0x7f);
}

/** The frames embedId3 re-writes on every embed; every OTHER frame in an existing tag is preserved. */
const REPLACED_ID3_FRAME_IDS = new Set(['TIT2', 'TPE1', 'COMM']);

/**
 * Walks an existing ID3v2.3/v2.4 tag and returns every frame EXCEPT the TIT2/TPE1/COMM frames we
 * re-write, re-encoded with plain ID3v2.3 frame headers (v2.4 syncsafe frame sizes are decoded
 * first). This preserves the C2PA provenance metadata that ships on every Lyria output
 * (docs/guide/01: "SynthID watermark + C2PA metadata on everything") — C2PA rides in an ID3 GEOB
 * frame on MP3, which the old strip-the-whole-tag behavior silently destroyed. Returns null when
 * the tag cannot be safely re-written (unsupported version, tag-level unsynchronisation,
 * flagged/compressed/encrypted frames, malformed frame walk) — callers must then leave the
 * buffer untouched rather than risk destroying provenance.
 */
function extractPreservedId3Frames(tag: Buffer): Buffer[] | null {
  if (tag.length < 10 || tag.toString('ascii', 0, 3) !== 'ID3') return null;
  const version = tag[3];
  if (version !== 3 && version !== 4) return null;
  const tagFlags = tag[5];
  if (tagFlags & 0x80) return null; // tag-level unsynchronisation transforms frame bytes — bail

  let offset = 10;
  if (tagFlags & 0x40) { // skip the extended header (size field differs between v2.3 and v2.4)
    if (offset + 4 > tag.length) return null;
    offset += version === 4 ? readSyncsafe(tag, offset) : tag.readUInt32BE(offset) + 4;
  }

  const preserved: Buffer[] = [];
  while (offset + 10 <= tag.length) {
    const id = tag.toString('latin1', offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding or garbage — end of frames
    const size = version === 4 ? readSyncsafe(tag, offset + 4) : tag.readUInt32BE(offset + 4);
    if (size <= 0 || offset + 10 + size > tag.length) return null; // malformed frame — bail
    if (tag[offset + 8] !== 0 || tag[offset + 9] !== 0) return null; // format-altering frame flags — bail
    if (!REPLACED_ID3_FRAME_IDS.has(id)) {
      const frame = Buffer.alloc(10 + size);
      frame.write(id, 0, 'ascii');
      frame.writeUInt32BE(size, 4); // re-encode as a plain (non-syncsafe) v2.3 frame size
      frame.writeUInt16BE(0, 8); // flags (verified zero above)
      tag.copy(frame, 10, offset + 10, offset + 10 + size);
      preserved.push(frame);
    }
    offset += 10 + size;
  }
  return preserved;
}

/**
 * Prepends an ID3v2.3 tag (TIT2/TPE1/COMM frames, ISO-8859-1 encoded, syncsafe tag size) onto an
 * MP3 buffer. If the buffer already starts with an ID3v2 tag, only its TIT2/TPE1/COMM frames are
 * replaced — every other existing frame (notably the C2PA/provenance GEOB frame on Lyria outputs)
 * is carried over into the new tag, so re-embedding never destroys provenance. If the existing
 * tag cannot be safely re-written, the buffer is returned UNCHANGED. The original audio frame
 * bytes are always preserved untouched, immediately after the (new) tag. Pure function — no I/O.
 */
export function embedId3(mp3: Buffer, tags: EmbedTags): Buffer {
  const oldTagLength = existingId3TagLength(mp3);
  if (oldTagLength > mp3.length) return mp3; // truncated/lying tag header — never rebuild
  const audioBytes = mp3.subarray(oldTagLength);

  let preservedFrames: Buffer[] = [];
  if (oldTagLength > 0) {
    const extracted = extractPreservedId3Frames(mp3.subarray(0, oldTagLength));
    if (extracted === null) return mp3; // unparseable existing tag — leave everything intact
    preservedFrames = extracted;
  }

  const frames: Buffer[] = [];
  if (tags.title !== undefined) frames.push(buildId3TextFrame('TIT2', tags.title));
  if (tags.artist !== undefined) frames.push(buildId3TextFrame('TPE1', tags.artist));
  if (tags.comment !== undefined) frames.push(buildId3CommentFrame(tags.comment));
  frames.push(...preservedFrames);

  const framesBody = Buffer.concat(frames);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'ascii');
  header.writeUInt8(3, 3); // version 2.3
  header.writeUInt8(0, 4); // revision
  header.writeUInt8(0, 5); // flags
  toSyncsafe(framesBody.length).copy(header, 6);

  return Buffer.concat([header, framesBody, audioBytes]);
}

/**
 * Detects the ACTUAL audio container from magic bytes: 'wav' for RIFF/WAVE, 'mp3' for an ID3v2
 * tag ("ID3") or a raw MPEG frame sync (0xFF with the top 3 bits of the next byte set — covers
 * 0xFFFB/0xFFF3/0xFFF2 etc.), 'unknown' otherwise. Providers do not reliably honor the requested
 * format (docs-verified: OpenRouter's audio.format "varies by model", and Lyria clip output is
 * MP3 regardless), so the persisted extension, manifest format, embedder choice, and duration
 * math must all follow these bytes — never the requested format. Pure function — no I/O.
 */
export function detectAudioFormat(buf: Buffer): 'wav' | 'mp3' | 'unknown' {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    return 'wav';
  }
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') {
    return 'mp3';
  }
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return 'mp3';
  }
  return 'unknown';
}

import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Shared id validation + atomic JSON persistence (used by lyria.ts, projects.ts, server.ts)
// ---------------------------------------------------------------------------

/** Thrown when a client-supplied id fails validation; route handlers map this to HTTP 400. */
export class InvalidIdError extends Error {}

/** Thrown when a required provider API key is not configured; route handlers map this to HTTP 400. */
export class MissingKeyError extends Error {}

/**
 * Ids must match the exact shape produced by generateLyria / createProject:
 * `gen-<Date.now()>-<Math.random().toString(36).slice(2, 8)>` (and `proj-` respectively),
 * i.e. prefix, decimal timestamp, lowercase base36 suffix. Anything else — including `/`,
 * `\`, `..`, or any other path fragment — is structurally impossible under this pattern.
 */
const SAFE_ID_PATTERN = /^(gen|proj)-\d+-[a-z0-9]+$/;

/**
 * Validates a client-supplied generation/project id BEFORE it is interpolated into any
 * filesystem path. Throws InvalidIdError (mapped to HTTP 400 by the route handlers) for
 * anything that doesn't match SAFE_ID_PATTERN, or that doesn't carry the expected prefix
 * when one is given. The raw id is deliberately not echoed back in the error message.
 */
export function assertSafeId(id: string, prefix?: 'gen' | 'proj'): void {
  if (typeof id !== 'string' || !SAFE_ID_PATTERN.test(id)) {
    throw new InvalidIdError('Invalid id format.');
  }
  if (prefix && !id.startsWith(`${prefix}-`)) {
    throw new InvalidIdError('Invalid id format.');
  }
}

/**
 * Atomically persists pretty-printed JSON: writes to `<path>.tmp`, then fs.rename()s it over
 * the target. The tmp file lives in the same directory (same volume), where rename is atomic,
 * so a crash mid-write can never leave a truncated manifest behind. Note: this adds no
 * cross-request locking — last-writer-wins between concurrent requests is acceptable for
 * this single-user tool.
 */
export async function writeJsonAtomic(filePath: string, obj: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

export interface GenerateRequestBody {
  prompt: string;
  lyrics?: string;
  language?: string;
  durationTarget?: string;
  model?: 'pro' | 'clip';
  format?: 'wav' | 'mp3';
  images?: { mimeType: string; data: string }[]; // base64, ≤10
  title?: string;
}

export interface GenerateResult {
  id: string;
  audioUrl: string;
  prompt: string;
  lyrics: string;
  model: string;
  format: string;
  provider: 'gemini' | 'openrouter' | 'mock';
  interactionId?: string;
  structure?: unknown;
  title?: string;
  durationSeconds?: number;
}

/** Fields actually written to a generation manifest JSON file. */
export interface GenerationManifest {
  id: string;
  model: string;
  format: string;
  provider: 'gemini' | 'openrouter' | 'mock';
  prompt: string;
  lyrics: string;
  generatedAt: string;
  interactionId?: string;
  structure?: unknown;
  analysis?: Analysis;
  title?: string;
  durationSeconds?: number;
}

/** A manifest plus the derived static-file URL, as returned by listGenerations(). */
export interface GenerationListItem extends GenerationManifest {
  audioUrl: string;
}

const MODEL_IDS = { pro: 'lyria-3-pro-preview', clip: 'lyria-3-clip-preview' } as const;
const OR_MODEL_IDS = { pro: 'google/lyria-3-pro-preview', clip: 'google/lyria-3-clip-preview' } as const;
const GEN_DIR = path.join(process.cwd(), 'generations');
const VALID_MODELS = ['pro', 'clip'] as const;
const VALID_FORMATS = ['wav', 'mp3'] as const;
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TITLE_MAX_LENGTH = 120;
const ARTIST_TAG = 'Lyria 3 Pro';
const CLIP_MODEL_DURATION_SECONDS = 30;
const COMMENT_PROMPT_MAX_LENGTH = 200;

/** Trims a raw title and caps it at TITLE_MAX_LENGTH; returns undefined for empty/whitespace-only input. */
function normalizeTitle(rawTitle: unknown): string | undefined {
  if (typeof rawTitle !== 'string') return undefined;
  const trimmed = rawTitle.trim();
  if (!trimmed) return undefined;
  return trimmed.length > TITLE_MAX_LENGTH ? trimmed.slice(0, TITLE_MAX_LENGTH) : trimmed;
}

/** Builds the embedded ICMT comment: model=<model>; provider=<provider>; generated=<generatedAt>; plus a truncated prompt. */
function buildEmbedComment(model: string, provider: string, generatedAt: string, prompt: string): string {
  const truncatedPrompt = prompt.length > COMMENT_PROMPT_MAX_LENGTH ? prompt.slice(0, COMMENT_PROMPT_MAX_LENGTH) : prompt;
  return `model=${model}; provider=${provider}; generated=${generatedAt}; prompt=${truncatedPrompt}`;
}

/** Derives durationSeconds for a freshly generated file: parsed from wav bytes, or a fixed constant for clip/mp3. */
function computeDurationSeconds(format: 'wav' | 'mp3', model: string, audio: Buffer): number | undefined {
  if (format === 'wav') {
    return wavDurationSeconds(audio) ?? undefined;
  }
  return model.includes('clip') ? CLIP_MODEL_DURATION_SECONDS : undefined;
}

/** Thrown for client input errors; server.ts maps this to HTTP 400 (vs 500 for everything else). */
export class LyriaValidationError extends Error {}

export interface GenerateLyriaSource {
  provider?: 'gemini' | 'openrouter';
  openRouterKey?: string;
}

async function generateLyriaViaOpenRouter(
  openRouterKey: string,
  model: string,
  format: 'wav' | 'mp3',
  finalPrompt: string,
  images: { mimeType: string; data: string }[],
): Promise<{ audio: Buffer; lyricsOut: string }> {
  const content: unknown = images.length
    ? [
        { type: 'text', text: finalPrompt },
        ...images.map(img => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } })),
      ]
    : finalPrompt;

  const requestBody = {
    model,
    messages: [{ role: 'user', content }],
    modalities: ['text', 'audio'],
    audio: { format },
    stream: true,
  };

  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openRouterKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`OpenRouter Lyria request failed (${response.status}): ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let sseText = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseText += decoder.decode(value, { stream: true });
  }
  sseText += decoder.decode(); // flush any trailing partial multi-byte sequence

  const parsed = parseOpenRouterAudioSSE(sseText);
  const lyricsOut = parsed.transcript || parsed.textBlocks.join('\n\n');
  return { audio: parsed.audio, lyricsOut };
}

export async function generateLyria(
  ai: any, // GoogleGenAI instance from getAiClient
  body: GenerateRequestBody,
  source?: GenerateLyriaSource,
): Promise<GenerateResult> {
  if (!body?.prompt || !body.prompt.trim()) {
    throw new LyriaValidationError('Prompt is required.');
  }
  if (body.model !== undefined && !VALID_MODELS.includes(body.model as any)) {
    throw new LyriaValidationError(`Invalid model "${body.model}". Must be one of: ${VALID_MODELS.join(', ')}.`);
  }
  if (body.format !== undefined && !VALID_FORMATS.includes(body.format as any)) {
    throw new LyriaValidationError(`Invalid format "${body.format}". Must be one of: ${VALID_FORMATS.join(', ')}.`);
  }

  const provider = source?.provider ?? 'gemini';
  const model = process.env.LYRIA_MOCK === '1'
    ? MODEL_IDS[body.model ?? 'pro']
    : provider === 'openrouter'
      ? OR_MODEL_IDS[body.model ?? 'pro']
      : MODEL_IDS[body.model ?? 'pro'];
  const format = body.model === 'clip' ? 'mp3' : (body.format ?? 'wav');
  const id = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.mkdir(GEN_DIR, { recursive: true });

  let audio: Buffer;
  let lyricsOut = '';
  let interactionId: string | undefined;
  let manifestProvider: 'gemini' | 'openrouter' | 'mock';
  let structure: unknown;

  if (process.env.LYRIA_MOCK === '1') {
    await new Promise(r => setTimeout(r, 1500)); // simulate latency
    audio = makeMockWav(body.model === 'clip' ? 4 : 8);
    lyricsOut = body.lyrics?.trim() || '[Mock] instrumental';
    manifestProvider = 'mock';
  } else if (provider === 'openrouter') {
    if (!source?.openRouterKey) {
      throw new MissingKeyError('OPENROUTER_API_KEY is not configured. Please add it in the Settings.');
    }
    const finalPrompt = assembleLyriaPrompt({
      prompt: body.prompt,
      lyrics: body.lyrics ?? '',
      language: body.language ?? 'EN',
      durationTarget: body.durationTarget ?? '3:00',
      model: body.model ?? 'pro',
    });
    const images = (body.images ?? []).slice(0, 10);
    const result = await generateLyriaViaOpenRouter(source.openRouterKey, model, format, finalPrompt, images);
    audio = result.audio;
    lyricsOut = result.lyricsOut;
    manifestProvider = 'openrouter';
  } else {
    const finalPrompt = assembleLyriaPrompt({
      prompt: body.prompt,
      lyrics: body.lyrics ?? '',
      language: body.language ?? 'EN',
      durationTarget: body.durationTarget ?? '3:00',
      model: body.model ?? 'pro',
    });
    const images = (body.images ?? []).slice(0, 10);
    const input = images.length
      ? [{ type: 'text', text: finalPrompt }, ...images.map(img => ({ type: 'image', mime_type: img.mimeType, data: img.data }))]
      : finalPrompt;
    const request: Record<string, unknown> = { model, input, store: false };
    if (format === 'wav') request.response_format = { type: 'audio' };
    const interaction = await ai.interactions.create(request);
    const parsed = parseInteraction(interaction);
    audio = parsed.audio;
    lyricsOut = parsed.textBlocks.join('\n\n');
    interactionId = parsed.interactionId;
    manifestProvider = 'gemini';

    const structureBlock = parsed.jsonBlocks.find(
      (block): block is { structure: unknown[] } =>
        typeof block === 'object' && block !== null && Array.isArray((block as any).structure),
    );
    if (structureBlock) {
      structure = structureBlock.structure;
    }
  }

  const generatedAt = new Date().toISOString();
  const title = normalizeTitle(body.title);
  // The requested/model-implied `format` is only a hint: providers may return a different
  // container than requested (docs-verified — OpenRouter's audio.format "varies by model";
  // a wav request can come back as MP3 bytes). The ACTUAL format is detected from the bytes
  // and drives the file extension, the manifest format field, the embedder choice, and the
  // duration math, so <id>.<ext> and the manifest can never disagree with the bytes on disk.
  // The requested format is used only as a fallback when the bytes are unidentifiable.
  const detectedFormat = detectAudioFormat(audio);
  const actualFormat: 'wav' | 'mp3' = detectedFormat === 'unknown' ? format : detectedFormat;
  const comment = buildEmbedComment(model, manifestProvider, generatedAt, body.prompt);
  const embedTags: EmbedTags = { title, artist: ARTIST_TAG, comment };
  const embeddedAudio =
    detectedFormat === 'wav' ? embedWavInfo(audio, embedTags)
    : detectedFormat === 'mp3' ? embedId3(audio, embedTags)
    : audio; // unknown bytes: persist verbatim — rebuilding/tagging could corrupt them
  const durationSeconds = computeDurationSeconds(actualFormat, model, audio);

  const audioFile = `${id}.${actualFormat}`;
  await fs.writeFile(path.join(GEN_DIR, audioFile), embeddedAudio);
  const manifest: GenerationManifest = {
    id, model, format: actualFormat, interactionId,
    prompt: body.prompt, lyrics: lyricsOut,
    provider: manifestProvider,
    generatedAt,
    ...(structure !== undefined ? { structure } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
  await writeJsonAtomic(path.join(GEN_DIR, `${id}.json`), manifest);

  return {
    id, audioUrl: `/generations/${audioFile}`, prompt: body.prompt, lyrics: lyricsOut, model,
    format: actualFormat,
    provider: manifestProvider, interactionId,
    ...(structure !== undefined ? { structure } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

/**
 * Lists all persisted generations by reading every *.json manifest in dir (default: GEN_DIR),
 * newest-first by generatedAt. Missing/empty dir -> []. Unparseable manifest files are skipped
 * with a console.warn rather than throwing, so one corrupt file can't break the whole listing.
 */
export async function listGenerations(dir: string = GEN_DIR): Promise<GenerationListItem[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const jsonFiles = entries.filter(name => name.endsWith('.json'));
  const items: GenerationListItem[] = [];

  for (const fileName of jsonFiles) {
    const filePath = path.join(dir, fileName);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const manifest = JSON.parse(raw) as GenerationManifest;
      const backfilled = await backfillDurationSeconds(manifest, dir, filePath);
      items.push({
        ...backfilled,
        audioUrl: `/generations/${backfilled.id}.${backfilled.format}`,
      });
    } catch (error) {
      console.warn(`Skipping unparseable generation manifest "${fileName}":`, error);
    }
  }

  items.sort((a, b) => {
    const bTime = Date.parse(b.generatedAt);
    const aTime = Date.parse(a.generatedAt);
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });

  return items;
}

/**
 * Lazily backfills durationSeconds onto a manifest that predates the field: parses the wav file
 * for real duration, or uses a fixed constant for clip/mp3 manifests. Writes the manifest back to
 * disk once so future calls skip the work. Tolerates a missing audio file (leaves it undefined,
 * does not persist/throw). No-ops (no re-parse, no rewrite) if durationSeconds is already set.
 */
async function backfillDurationSeconds(
  manifest: GenerationManifest,
  dir: string,
  manifestPath: string,
): Promise<GenerationManifest> {
  if (manifest.durationSeconds !== undefined) {
    return manifest;
  }

  const format = manifest.format === 'mp3' ? 'mp3' : 'wav';
  let durationSeconds: number | undefined;

  if (format === 'wav') {
    try {
      const audio = await fs.readFile(path.join(dir, `${manifest.id}.wav`));
      durationSeconds = wavDurationSeconds(audio) ?? undefined;
    } catch {
      durationSeconds = undefined; // audio file missing/unreadable — leave undefined
    }
  } else if (manifest.model.includes('clip')) {
    durationSeconds = CLIP_MODEL_DURATION_SECONDS;
  }

  if (durationSeconds === undefined) {
    return manifest;
  }

  const updated: GenerationManifest = { ...manifest, durationSeconds };
  await writeJsonAtomic(manifestPath, updated);
  return updated;
}

/** Thrown when a requested generation id has no manifest; server.ts maps this to HTTP 404. */
export class GenerationNotFoundError extends Error {}

/** The raw audio payload of a buffer: the WAV 'data' chunk bytes, or the MP3 bytes after any ID3v2 tag. */
function audioPayload(format: 'wav' | 'mp3', buf: Buffer): Buffer | null {
  if (format === 'wav') {
    const dataChunk = walkRiffChunks(buf).find(c => c.id === 'data');
    return dataChunk ? buf.subarray(dataChunk.bodyOffset, dataChunk.bodyOffset + dataChunk.size) : null;
  }
  return buf.subarray(Math.min(existingId3TagLength(buf), buf.length));
}

/**
 * Anti-corruption guard for renameGeneration: re-embedding may only change metadata. The output
 * must still detect as the same format AND carry a byte-identical audio payload — otherwise the
 * rewrite is refused and the file on disk is left untouched. This makes the historical failure
 * mode (a RIFF rebuild run over MP3 bytes shrinking a track to an ~11KB fragment) structurally
 * impossible: an output that lost or altered audio can never be written.
 */
function embeddingPreservesAudio(format: 'wav' | 'mp3', before: Buffer, after: Buffer): boolean {
  if (detectAudioFormat(after) !== format) return false;
  const beforePayload = audioPayload(format, before);
  const afterPayload = audioPayload(format, after);
  return beforePayload !== null && afterPayload !== null && beforePayload.equals(afterPayload);
}

/**
 * Renames a persisted generation: updates manifest.title and re-embeds the title (plus the
 * existing artist/comment tags already on file) into the audio file on disk when it exists.
 * The embedder is chosen from the ACTUAL bytes on disk (detectAudioFormat), never the manifest's
 * claimed format — pre-fix manifests can claim 'wav' for files that are really MP3 (OpenRouter),
 * and running the RIFF rebuilder over non-RIFF bytes destroys the audio. Unidentifiable bytes are
 * never rewritten (manifest-only rename), and every rewrite must pass the embeddingPreservesAudio
 * guard. Returns the GenerationListItem shape (manifest + derived audioUrl). Throws
 * GenerationNotFoundError for an unknown id, or a plain Error for a missing/empty title.
 */
export async function renameGeneration(
  id: string,
  title: string,
  dir: string = GEN_DIR,
): Promise<GenerationListItem> {
  assertSafeId(id, 'gen'); // reject path-traversal ids before ANY fs call

  const normalized = normalizeTitle(title);
  if (!normalized) {
    throw new Error('Title is required.');
  }

  const manifestPath = path.join(dir, `${id}.json`);
  let manifest: GenerationManifest;
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as GenerationManifest;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new GenerationNotFoundError(`No generation found with id "${id}".`);
    }
    throw error;
  }

  const updated: GenerationManifest = { ...manifest, title: normalized };

  // The manifest format only locates the file on disk; it is NOT trusted for embedding.
  const manifestFormat = updated.format === 'mp3' ? 'mp3' : 'wav';
  const audioPath = path.join(dir, `${updated.id}.${manifestFormat}`);
  try {
    const audio = await fs.readFile(audioPath);
    const actualFormat = detectAudioFormat(audio); // trust the bytes, not the manifest claim
    if (actualFormat !== 'unknown') {
      const comment = buildEmbedComment(updated.model, updated.provider, updated.generatedAt, updated.prompt);
      const embedTags: EmbedTags = { title: normalized, artist: ARTIST_TAG, comment };
      const embeddedAudio = actualFormat === 'wav' ? embedWavInfo(audio, embedTags) : embedId3(audio, embedTags);
      if (embeddingPreservesAudio(actualFormat, audio, embeddedAudio)) {
        await fs.writeFile(audioPath, embeddedAudio);
      } else {
        // Guard tripped: the rewrite would lose or alter audio. Keep the file byte-for-byte intact.
        console.warn(`renameGeneration: embedding would not preserve the audio payload of "${audioPath}"; audio file left untouched.`);
      }
    }
    // actualFormat === 'unknown': never rewrite bytes we can't identify — manifest-only rename.
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    // Audio file missing — tolerate it; manifest rename still proceeds.
  }

  await writeJsonAtomic(manifestPath, updated);

  return {
    ...updated,
    audioUrl: `/generations/${updated.id}.${manifestFormat}`,
  };
}

// ---------------------------------------------------------------------------
// Real audio analysis (POST /api/ai/analyze) via gemini-3.5-flash
// ---------------------------------------------------------------------------

export interface AnalysisSection {
  name: string;
  start: string; // mm:ss
  end: string; // mm:ss
}

export interface Analysis {
  title: string;
  genre: string;
  mood: string;
  energy: number; // integer 0-100
  bpm: number | null;
  key: string | null;
  instrumentation: string[];
  sections: AnalysisSection[];
  notes: string;
}

/** Thrown by analyzeGeneration when the requested generation id has no manifest; server.ts maps this to HTTP 404. */
export class AnalysisNotFoundError extends Error {}

function stripCodeFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    const lines = text.split('\n');
    if (lines[0].startsWith('```')) {
      lines.shift();
    }
    if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) {
      lines.pop();
    }
    text = lines.join('\n').trim();
  }
  return text;
}

function coerceString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Analysis payload is missing a usable "${fieldName}" string.`);
  }
  return value.trim();
}

function coerceOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function coerceNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function coerceNullableString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim());
}

function coerceSections(value: unknown): AnalysisSection[] {
  if (!Array.isArray(value)) return [];
  const sections: AnalysisSection[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const name = coerceOptionalString((entry as any).name);
    const start = coerceOptionalString((entry as any).start);
    const end = coerceOptionalString((entry as any).end);
    if (!name && !start && !end) continue;
    sections.push({ name, start, end });
  }
  return sections;
}

function clampEnergy(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Parses and validates a raw model response into an Analysis object. Strips ``` fences,
 * JSON.parses, and defensively coerces every field: energy is clamped to an integer 0-100,
 * bpm/key fall back to null when unusable (never fabricated), arrays default to [], and
 * strings are trimmed. Throws if the payload isn't a usable JSON object or is missing the
 * required title/genre/mood/notes strings.
 */
export function parseAnalysis(raw: string): Analysis {
  const cleaned = stripCodeFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Analysis response was not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Analysis response JSON must be an object.');
  }

  const obj = parsed as Record<string, unknown>;

  return {
    title: coerceString(obj.title, 'title'),
    genre: coerceString(obj.genre, 'genre'),
    mood: coerceString(obj.mood, 'mood'),
    energy: clampEnergy(obj.energy),
    bpm: coerceNullableNumber(obj.bpm),
    key: coerceNullableString(obj.key),
    instrumentation: coerceStringArray(obj.instrumentation),
    sections: coerceSections(obj.sections),
    notes: coerceOptionalString(obj.notes),
  };
}

const ANALYSIS_PROMPT = `You are an expert music analyst listening to an audio recording. Analyze the audio and respond with ONLY a single JSON object (no markdown code fences, no prose) matching exactly this schema:

{
  "title": string,            // a short, evocative track name you would give this piece
  "genre": string,             // the primary musical genre
  "mood": string,               // the overall emotional mood/atmosphere
  "energy": number,             // integer 0-100 rating of the track's energy/intensity
  "bpm": number | null,          // tempo in beats per minute; null if you cannot confidently estimate it
  "key": string | null,          // musical key (e.g. "A minor"); null if you cannot confidently identify it
  "instrumentation": string[],    // instruments/sounds you actually hear
  "sections": [{ "name": string, "start": string, "end": string }],  // structural sections you actually hear, with timestamps in mm:ss
  "notes": string                // any other notable observations about the production, arrangement, or performance
}

CRITICAL: Do not fabricate details you cannot hear. If unsure about bpm or key, use null rather than guessing. Output ONLY the raw JSON object.`;

// ---------------------------------------------------------------------------
// $0 dev mode (LYRIA_MOCK=1) deterministic mocks for the paid text/analyze
// endpoints. generateLyria has always honored LYRIA_MOCK; these extend the same
// guarantee to /api/ai/modify, /api/ai/enhance-prompt, and /api/ai/analyze so
// mock mode never needs an API key and never makes a network call. The modify/
// enhance routes gate in server.ts (right after input validation, before any
// provider/key resolution) using the two pure helpers below; analyze gates
// inside analyzeGeneration, immediately before callAi would be invoked.
// ---------------------------------------------------------------------------

export interface MockModifyArgs {
  instruction: string;
  currentText?: string;
  selectedText?: string;
}

/**
 * Deterministic LYRIA_MOCK stand-in for /api/ai/modify. Mirrors the real contract:
 * when a selection is highlighted the result replaces ONLY that selection, otherwise
 * it replaces the full text — so it echoes exactly the region the editor will paste
 * over, clearly marked as a mock transformation.
 */
export function mockModifyText(args: MockModifyArgs): string {
  const target = args.selectedText ?? args.currentText ?? '';
  return `[mock modify: ${args.instruction}] ${target}`.trim();
}

/** Deterministic LYRIA_MOCK stand-in for /api/ai/enhance-prompt: echoes the prompt, clearly marked. */
export function mockEnhancePrompt(prompt: string): string {
  return `[mock enhance] ${prompt.trim()}`;
}

const MOCK_ANALYSIS_TITLE_WORDS = 6;

/** Formats seconds as the mm:ss shape real analyses use for section timestamps. */
function mockTimestamp(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Deterministic LYRIA_MOCK stand-in for /api/ai/analyze: a fixed, valid Analysis
 * (round-trips through parseAnalysis) titled "[mock] <first words of the generation
 * prompt>". bpm/key stay null and instrumentation stays empty — the mock never
 * fabricates musical details, matching the real prompt's "don't guess" rule. The one
 * exception is derived, not invented: when the manifest carries a real measured
 * durationSeconds, a single clearly-mock-labeled "[mock] full take" section spanning
 * exactly 00:00–duration is included so the client's detected-structure timeline can
 * be exercised end-to-end in $0 dev mode. No duration → no sections.
 */
export function buildMockAnalysis(prompt: string, durationSeconds?: number): Analysis {
  const firstWords = prompt.trim().split(/\s+/).filter(Boolean).slice(0, MOCK_ANALYSIS_TITLE_WORDS).join(' ');
  const sections: AnalysisSection[] =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? [{ name: '[mock] full take', start: mockTimestamp(0), end: mockTimestamp(durationSeconds) }]
      : [];
  return {
    title: `[mock] ${firstWords || 'untitled'}`,
    genre: 'Mock',
    mood: 'Deterministic',
    energy: 50,
    bpm: null,
    key: null,
    instrumentation: [],
    sections,
    notes: 'Mock analysis produced by LYRIA_MOCK=1 — no AI provider was called.',
  };
}

export interface AnalyzeGenerationCallAiArgs {
  audioBase64: string;
  mimeType: string;
  format: 'wav' | 'mp3';
  prompt: string;
}

export interface AnalyzeGenerationOptions {
  id: string;
  force?: boolean;
  dir?: string;
  /** Invokes the resolved provider (Gemini direct or OpenRouter) and returns its raw text response. */
  callAi: (args: AnalyzeGenerationCallAiArgs) => Promise<string>;
}

const AUDIO_MIME_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
};

/**
 * Orchestrates POST /api/ai/analyze: looks up generations/<id>.json + its audio file. If the
 * manifest already has a cached `analysis` and `force` is falsy, returns it WITHOUT invoking
 * callAi. In LYRIA_MOCK=1 mode it then short-circuits to a deterministic buildMockAnalysis
 * (never invoking callAi, never persisting — so a cached real analysis is never overwritten
 * by a mock, and a real one can still be produced once mock mode is off). Otherwise reads+
 * base64-encodes the audio, invokes callAi (provider-specific request building lives in
 * server.ts), parses/validates the response with parseAnalysis, persists the result into the
 * manifest, and returns it. Throws AnalysisNotFoundError for an unknown id.
 */
export async function analyzeGeneration(options: AnalyzeGenerationOptions): Promise<Analysis> {
  const { id, force, dir = GEN_DIR, callAi } = options;
  assertSafeId(id, 'gen'); // reject path-traversal ids before ANY fs call (worst case here: arbitrary file read exfiltrated to a paid API)

  const manifestPath = path.join(dir, `${id}.json`);

  let manifest: GenerationManifest;
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as GenerationManifest;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new AnalysisNotFoundError(`No generation found with id "${id}".`);
    }
    throw error;
  }

  if (manifest.analysis && !force) {
    return manifest.analysis;
  }

  // $0 dev mode (LYRIA_MOCK=1): deterministic mock analysis with no key, no audio read,
  // and no provider call — mirrors generateLyria's mock gate. Deliberately NOT persisted.
  if (process.env.LYRIA_MOCK === '1') {
    return buildMockAnalysis(manifest.prompt, manifest.durationSeconds);
  }

  const format = (manifest.format === 'mp3' ? 'mp3' : 'wav') as 'wav' | 'mp3';
  const audioPath = path.join(dir, `${id}.${format}`);
  const audioBuffer = await fs.readFile(audioPath);
  const audioBase64 = audioBuffer.toString('base64');
  const mimeType = AUDIO_MIME_TYPES[format];

  const rawResponse = await callAi({ audioBase64, mimeType, format, prompt: ANALYSIS_PROMPT });
  const analysis = parseAnalysis(rawResponse);

  manifest.analysis = analysis;
  await writeJsonAtomic(manifestPath, manifest);

  return analysis;
}

// ---------------------------------------------------------------------------
// GET /api/openrouter/credits — upstream-response mapping (pure, unit-testable).
// Lives here (not server.ts) because server.ts starts a listener at import time
// and therefore can't be imported by the test suite.
// ---------------------------------------------------------------------------

export interface CreditsUpstream {
  ok: boolean;
  status: number;
  /** Parsed JSON body of a 2xx upstream response. */
  data?: unknown;
  /** Raw body text of a non-2xx upstream response. */
  errText?: string;
}

export interface CreditsRouteResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Maps OpenRouter's GET /api/v1/credits response onto this app's /api/openrouter/credits
 * contract. Docs-verified (OpenRouter getCredits reference): the credits endpoint requires
 * a MANAGEMENT key and returns 403 for a plain inference key — the key every normal user of
 * this app configures. The client (getOpenRouterCredits in src/lib/lyriaClient.ts) already
 * maps our HTTP 404 to null ("no balance shown", same as no key configured), so upstream
 * 403 is deliberately translated to a 404 here: the UI silently hides the balance instead
 * of surfacing a 502 error for a perfectly valid inference key. A success keeps the
 * { totalCredits, totalUsage, balance } shape the client expects, plus an additive
 * `available: true`. Every other upstream failure (401 bad key, 5xx) stays a 502.
 */
export function mapOpenRouterCreditsResponse(upstream: CreditsUpstream): CreditsRouteResponse {
  if (upstream.ok) {
    const data = upstream.data as any;
    const totalCredits = data?.data?.total_credits ?? 0;
    const totalUsage = data?.data?.total_usage ?? 0;
    const balance = Math.round((totalCredits - totalUsage) * 100) / 100;
    return { status: 200, body: { available: true, totalCredits, totalUsage, balance } };
  }

  if (upstream.status === 403) {
    return {
      status: 404,
      body: { error: 'OpenRouter credits require a management key; balance is unavailable for this API key.' },
    };
  }

  return {
    status: 502,
    body: { error: `OpenRouter credits request failed (${upstream.status}): ${upstream.errText ?? ''}` },
  };
}
