// Extracts real peak-amplitude envelopes from same-origin audio files (wav/mp3) so the
// timeline's Waveform canvases can render actual audio instead of random decoration.
//
// Decoded AudioBuffers are cached in-module by URL ONLY (not by url+buckets) — bucket
// counts are cheap to recompute from an already-decoded buffer with a single array pass,
// so callers (and the Waveform component itself, per canvas pixel width) can ask for a
// different resolution on resize/zoom without ever re-fetching or re-decoding the file.

const bufferCache = new Map<string, Promise<AudioBuffer>>();

// Lazily created, reused AudioContext — created on first extraction request and
// suspended (not closed) between uses so it can be resumed cheaply for the next decode.
let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new AudioContext();
  }
  return sharedCtx;
}

async function decodeAudioBuffer(url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch audio (${response.status}): ${url}`);
  const arrayBuffer = await response.arrayBuffer();

  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => {});
  }

  // decodeAudioData handles both wav and mp3 (and anything else the browser supports)
  // via the same codec-sniffing path — no format branching needed.
  // Don't close the context afterwards — keep it around for the next extraction, just
  // let it idle. Suspending here would race with any other in-flight decode.
  return ctx.decodeAudioData(arrayBuffer.slice(0));
}

/** Fetches and decodes the audio at `url`, caching the resulting AudioBuffer by url. */
function getAudioBuffer(url: string): Promise<AudioBuffer> {
  const cached = bufferCache.get(url);
  if (cached) return cached;

  const promise = decodeAudioBuffer(url).catch((err) => {
    // Don't poison the cache with a failed attempt — let a future call retry.
    bufferCache.delete(url);
    throw err;
  });

  bufferCache.set(url, promise);
  return promise;
}

function computePeaks(audioBuffer: AudioBuffer, buckets: number): number[] {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const bucketSize = Math.max(1, Math.floor(length / buckets));
  const peaks: number[] = new Array(buckets).fill(0);

  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    channelData.push(audioBuffer.getChannelData(c));
  }

  for (let b = 0; b < buckets; b++) {
    const start = b * bucketSize;
    const end = b === buckets - 1 ? length : Math.min(length, start + bucketSize);
    let max = 0;
    for (let i = start; i < end; i++) {
      // Downmix channels by taking the max absolute sample across all channels.
      for (let c = 0; c < channels; c++) {
        const v = Math.abs(channelData[c][i]);
        if (v > max) max = v;
      }
    }
    peaks[b] = max;
  }

  // Normalize 0..1 against the loudest bucket so quiet masters still fill the lane.
  const peakMax = peaks.reduce((m, v) => (v > m ? v : m), 0);
  if (peakMax > 0) {
    for (let b = 0; b < buckets; b++) peaks[b] = peaks[b] / peakMax;
  }

  return peaks;
}

/**
 * Per-bucket signed min/max — the pair of values a classic DAW waveform bar is drawn
 * from (top edge from `max`, bottom edge from `min`), rather than a single rectified
 * peak. Downmixes channels by taking, per sample, the most extreme positive value
 * across channels for `max` and the most extreme negative value for `min`.
 */
function computeMinMax(audioBuffer: AudioBuffer, buckets: number): { min: number[]; max: number[] } {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const bucketSize = Math.max(1, Math.floor(length / buckets));
  const min: number[] = new Array(buckets).fill(0);
  const max: number[] = new Array(buckets).fill(0);

  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    channelData.push(audioBuffer.getChannelData(c));
  }

  let overallAbsMax = 0;

  for (let b = 0; b < buckets; b++) {
    const start = b * bucketSize;
    const end = b === buckets - 1 ? length : Math.min(length, start + bucketSize);
    let bucketMin = 0;
    let bucketMax = 0;
    for (let i = start; i < end; i++) {
      for (let c = 0; c < channels; c++) {
        const v = channelData[c][i];
        if (v > bucketMax) bucketMax = v;
        if (v < bucketMin) bucketMin = v;
      }
    }
    min[b] = bucketMin;
    max[b] = bucketMax;
    const absMax = Math.max(bucketMax, -bucketMin);
    if (absMax > overallAbsMax) overallAbsMax = absMax;
  }

  // Normalize both arrays against the single loudest excursion (preserving the min/max
  // asymmetry of the waveform) so quiet masters still fill the lane.
  if (overallAbsMax > 0) {
    for (let b = 0; b < buckets; b++) {
      min[b] = min[b] / overallAbsMax;
      max[b] = max[b] / overallAbsMax;
    }
  }

  return { min, max };
}

/**
 * Fetches and decodes the audio at `url`, returning `buckets` peak-amplitude values
 * (max(|sample|) per bucket, downmixed across channels, normalized 0..1).
 * The underlying decode is cached per-url (see `getAudioBuffer`) — calling this again
 * for the same url with a different bucket count is a cheap re-bucket, not a re-fetch.
 */
export async function extractPeaks(url: string, buckets: number): Promise<number[]> {
  const audioBuffer = await getAudioBuffer(url);
  return computePeaks(audioBuffer, buckets);
}

/**
 * Fetches and decodes the audio at `url`, returning `buckets` signed min/max pairs
 * suitable for classic DAW-style bar rendering (each bar spans `[min[i], max[i]]`
 * rather than a single rectified magnitude). Shares the same cached AudioBuffer as
 * `extractPeaks` — requesting both for the same url only decodes once.
 */
export async function extractPeaksMinMax(url: string, buckets: number): Promise<{ min: number[]; max: number[] }> {
  const audioBuffer = await getAudioBuffer(url);
  return computeMinMax(audioBuffer, buckets);
}
