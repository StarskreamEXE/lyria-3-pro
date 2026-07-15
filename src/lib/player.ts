// Singleton audio player for the active version.
const audio = new Audio();
let currentUrl: string | null = null;

// Real stereo metering graph. Built lazily on first play() because
// AudioContext/createMediaElementSource require a user gesture and can only be
// wired to `audio` once (a second createMediaElementSource call on the same
// element throws InvalidStateError).
let audioCtx: AudioContext | null = null;
let sourceNode: MediaElementAudioSourceNode | null = null;
let splitter: ChannelSplitterNode | null = null;
let analyserL: AnalyserNode | null = null;
let analyserR: AnalyserNode | null = null;
let timeDataL: Float32Array | null = null;
let timeDataR: Float32Array | null = null;
let freqDataL: Uint8Array | null = null;
let freqDataR: Uint8Array | null = null;

function ensureAudioGraph() {
  if (sourceNode) return; // already wired
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  audioCtx = new Ctx();

  sourceNode = audioCtx.createMediaElementSource(audio); // throws if called twice on `audio` — guarded by the check above
  splitter = audioCtx.createChannelSplitter(2);

  analyserL = audioCtx.createAnalyser();
  analyserL.fftSize = 1024;
  analyserR = audioCtx.createAnalyser();
  analyserR.fftSize = 1024;

  timeDataL = new Float32Array(analyserL.fftSize);
  timeDataR = new Float32Array(analyserR.fftSize);
  freqDataL = new Uint8Array(analyserL.frequencyBinCount);
  freqDataR = new Uint8Array(analyserR.frequencyBinCount);

  // source -> splitter -> [analyserL, analyserR]
  sourceNode.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  // source -> destination, so playback stays audible (analysers are taps, not inline).
  sourceNode.connect(audioCtx.destination);
}

function rmsLevel(analyser: AnalyserNode, buffer: Float32Array): number {
  analyser.getFloatTimeDomainData(buffer);
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i++) {
    sumSquares += buffer[i] * buffer[i];
  }
  const rms = Math.sqrt(sumSquares / buffer.length);
  return Math.max(0, Math.min(1, rms));
}

// Average byte magnitude (0..255) across bins whose frequency falls in [loHz, hiHz),
// combined across both channels, normalized to 0..1.
function bandAverage(dataL: Uint8Array, dataR: Uint8Array, binHz: number, loHz: number, hiHz: number): number {
  const loBin = Math.max(0, Math.floor(loHz / binHz));
  const hiBin = Math.min(dataL.length, Math.ceil(hiHz / binHz));
  if (hiBin <= loBin) return 0;
  let sum = 0;
  let count = 0;
  for (let i = loBin; i < hiBin; i++) {
    sum += dataL[i] + dataR[i];
    count += 2;
  }
  return count > 0 ? sum / count / 255 : 0;
}

// Mild perceptual lift (^0.7) so quiet passages still visibly move the orb —
// byte-magnitude FFT data is roughly linear/log-ish in loudness, and a sub-1
// exponent boosts low values more than high ones without clipping 1 -> 1.
function perceptualLift(v: number): number {
  return Math.pow(Math.max(0, Math.min(1, v)), 0.7);
}

export const player = {
  // Shared smoothed output level (0..1) for per-frame canvas consumers. BottomBar's
  // meter loop writes this alongside the --lyria-pulse CSS var it mirrors onto <html>,
  // so readers (e.g. the Waveform playhead glow) get a plain number instead of paying
  // a per-frame getComputedStyle() hit. Rests at 0 whenever nothing is playing.
  pulseLevel: 0,
  setSource(url: string | null) {
    if (url === currentUrl) return;
    currentUrl = url;
    audio.pause();
    if (url) audio.src = url;
  },
  async play() {
    if (!currentUrl) return;
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') {
      await audioCtx.resume(); // autoplay policy: contexts start suspended until a user gesture resumes them
    }
    await audio.play();
  },
  pause() { audio.pause(); },
  stop() { audio.pause(); audio.currentTime = 0; },
  seek(seconds: number) {
    if (!currentUrl) return; // no-op without a source
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    audio.currentTime = Math.max(0, Math.min(duration, seconds));
  },
  setVolume(v: number) { audio.volume = Math.max(0, Math.min(1, v)); },
  get hasSource() { return currentUrl !== null; },
  get currentTime() { return audio.currentTime; },
  get duration() { return Number.isFinite(audio.duration) ? audio.duration : 0; },
  // True while `audio` is actually advancing — driven off the element itself (not just
  // "someone called play()") so a playhead rAF loop can key off it directly and never
  // spin after pause/stop/ended or before a source exists.
  get isPlaying() { return !audio.paused && !audio.ended && currentUrl !== null; },
  onEnded(cb: () => void) { audio.onended = cb; },
  getLevels(): { left: number; right: number } | null {
    if (!analyserL || !analyserR || !timeDataL || !timeDataR) return null;
    return {
      left: rmsLevel(analyserL, timeDataL),
      right: rmsLevel(analyserR, timeDataR),
    };
  },
  // Frequency-band magnitudes for the orb visualizer. Bin->Hz mapping derives
  // from the live AudioContext sample rate, so this stays correct regardless
  // of the device's actual rate. Reuses the freqData arrays allocated in
  // ensureAudioGraph() — no per-call allocation, safe at 30-60fps.
  getBands(): { bass: number; mid: number; high: number; level: number } | null {
    if (!audioCtx || !analyserL || !analyserR || !freqDataL || !freqDataR) return null;
    analyserL.getByteFrequencyData(freqDataL);
    analyserR.getByteFrequencyData(freqDataR);

    const nyquist = audioCtx.sampleRate / 2;
    const binHz = nyquist / analyserL.frequencyBinCount;

    const bass = bandAverage(freqDataL, freqDataR, binHz, 20, 250);
    const mid = bandAverage(freqDataL, freqDataR, binHz, 250, 4000);
    const high = bandAverage(freqDataL, freqDataR, binHz, 4000, 16000);
    const level = bandAverage(freqDataL, freqDataR, binHz, 20, 16000);

    return {
      bass: perceptualLift(bass),
      mid: perceptualLift(mid),
      high: perceptualLift(high),
      level: perceptualLift(level),
    };
  },
};
