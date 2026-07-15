import React, { useState, useEffect } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, Square } from 'lucide-react';
import { player } from '../lib/player';

const METER_BARS = 15;
const SEEK_SECONDS = 10;

function formatTime(seconds: number, padMinutes = false): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${padMinutes ? String(m).padStart(2, '0') : String(m)}:${String(s).padStart(2, '0')}`;
}

// Convert a 0..1 RMS level into per-bar opacities for the existing meter visual
// (bars light up left-to-right as level rises; unlit bars stay dim).
function levelToBars(level: number): number[] {
  const lit = Math.round(level * METER_BARS);
  return Array.from({ length: METER_BARS }, (_, i) => (i < lit ? 1 : 0.2));
}

export function BottomBar() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(75);
  const [meters, setMeters] = useState({ left: Array(METER_BARS).fill(0.2), right: Array(METER_BARS).fill(0.2) });
  const [time, setTime] = useState({ elapsed: 0, duration: 0 });
  const [activeVersion, setActiveVersion] = useState<{ n: number; format: string | null } | null>(null);

  // Player lifecycle: ended → reset transport; poll position for the session readout.
  useEffect(() => {
    player.onEnded(() => setIsPlaying(false));
    player.setVolume(volume / 100); // sync initial volume
    const interval = window.setInterval(() => {
      setTime({ elapsed: player.currentTime, duration: player.duration });
    }, 500);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Active version changed (CenterPanel broadcast) → swap the player source.
  useEffect(() => {
    const handleActiveVersion = (e: Event) => {
      const detail = (e as CustomEvent).detail as { n: number; audioUrl: string | null; format: string | null } | undefined;
      player.setSource(detail?.audioUrl ?? null);
      setActiveVersion(detail ? { n: detail.n, format: detail.format } : null);
      if (!detail?.audioUrl) {
        // No audio on the new active version — setSource just paused the player, so
        // the transport must follow: otherwise the button keeps showing Pause and the
        // meter rAF loop runs forever against a paused element.
        setIsPlaying(false);
      } else if (isPlaying) {
        void player.play(); // switching versions mid-play swaps audio
      }
    };
    window.addEventListener('lyria-active-version', handleActiveVersion);
    return () => window.removeEventListener('lyria-active-version', handleActiveVersion);
  }, [isPlaying]);

  // Real meters: while playing, read the player's analyser-derived levels each
  // frame and drive the bar visuals. Rest at zero (dim) when not playing.
  // Also drives the orb visualizer iframe: every other frame (~30fps) we grab
  // band data from the same analyser graph and postMessage it in, and send a
  // single AUDIO_STOP when playback stops (pause, stop, onEnded, or unmount —
  // see the cleanup below for how exactly one stop is guaranteed).
  useEffect(() => {
    let animationFrame: number;
    let frameCount = 0;
    // Smoothed overall output level (0..1), published two ways so the UI can breathe
    // with the music: onto <html> as --lyria-pulse for CSS consumers
    // (.lyria-breathe-glow), and as the plain number player.pulseLevel for per-frame
    // canvas consumers (the Waveform playhead) that must not pay a getComputedStyle()
    // per frame. Both rest at 0 whenever nothing is playing (see the teardown below).
    // Fast-attack / slow-release lerp, matching the orb's feel.
    let pulse = 0;
    // The orb visualizer iframe, resolved once per effect run instead of a
    // document.querySelector on every posted frame (~30x/s while playing).
    const iframe = document.querySelector('iframe');

    if (isPlaying) {
      const updateMeters = () => {
        const levels = player.getLevels();
        setMeters({
          left: levelToBars(levels?.left ?? 0),
          right: levelToBars(levels?.right ?? 0),
        });

        const overall = levels ? Math.min(1, (levels.left + levels.right) / 2) : 0;
        pulse += (overall - pulse) * (overall > pulse ? 0.4 : 0.08);
        player.pulseLevel = pulse; // plain-number write — free at full frame rate

        // Orb visualizer: throttle to ~30fps (every other rAF at ~60fps).
        // --lyria-pulse rides the same every-other-frame budget — one style write ~30fps.
        frameCount++;
        if (frameCount % 2 === 0) {
          document.documentElement.style.setProperty('--lyria-pulse', pulse.toFixed(3));
          const bands = player.getBands();
          if (bands && iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage({
              type: 'AUDIO_LEVELS',
              bands: { bass: bands.bass, mid: bands.mid, high: bands.high },
              level: bands.level,
            }, '*');
          }
        }

        animationFrame = requestAnimationFrame(updateMeters);
      };
      animationFrame = requestAnimationFrame(updateMeters);
    } else {
      setMeters({ left: Array(METER_BARS).fill(0.2), right: Array(METER_BARS).fill(0.2) });
    }

    // Post message to iframe
    if (iframe && iframe.contentWindow) {
      if (isPlaying) {
         iframe.contentWindow.postMessage({ type: 'ACTION_START' }, '*');
      } else {
         iframe.contentWindow.postMessage({ type: 'ACTION_END' }, '*');
      }
    }

    return () => {
      cancelAnimationFrame(animationFrame);
      // Only signal AUDIO_STOP when tearing down an effect run that was
      // actually driving the rAF loop (isPlaying was true this run) — pause,
      // stop, onEnded, and unmount all flow through isPlaying becoming false,
      // which re-runs this effect and fires this cleanup exactly once. Skip
      // it on the false->true transition's cleanup (of the prior idle run),
      // which would otherwise send a redundant stop right as playback starts.
      if (isPlaying) {
        // The pulse must never outlive playback — park every breathe consumer at its
        // inert resting state (--lyria-pulse: 0 / pulseLevel 0 means zero visible glow).
        document.documentElement.style.setProperty('--lyria-pulse', '0');
        player.pulseLevel = 0;
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'AUDIO_STOP' }, '*');
        }
      }
    };
  }, [isPlaying]);

  return (
    <div className="h-16 shrink-0 border-t border-lyria-border flex items-center justify-center px-6 bg-[#0a0a0c] z-20">
     <div className="w-full max-w-[1600px] mx-auto flex items-center justify-between">

      {/* Left: Session readout */}
      <div className="flex items-center gap-4 w-[300px] text-[10px] font-mono text-lyria-text-muted">
        <span title="Playback position / total duration of the current version" className="text-lyria-text-main">{formatTime(time.elapsed, true)} <span className="text-lyria-text-muted">/ {formatTime(time.duration)}</span></span>
        <div className="w-px h-4 bg-lyria-border"></div>
        <span title="Audio format and version number of the file currently loaded in the player">{activeVersion?.format ?? '—'}{activeVersion ? ` · V${activeVersion.n}` : ''}</span>
      </div>

      {/* Center: Transport Controls */}
      <div className="flex items-center justify-center gap-6 flex-1">
        <button
          onClick={() => player.seek(player.currentTime - SEEK_SECONDS)}
          title={`Rewind ${SEEK_SECONDS} seconds`}
          aria-label={`Rewind ${SEEK_SECONDS} seconds`}
          className="text-lyria-text-muted hover:text-lyria-text-main transition-colors duration-150 active:scale-90 cursor-pointer rounded-full lyria-focus-ring"
        >
          <SkipBack size={20} fill="currentColor" />
        </button>
        <button
          onClick={() => { player.stop(); setIsPlaying(false); }}
          title="Stop playback and reset to the beginning"
          aria-label="Stop playback"
          className="text-lyria-text-muted hover:text-lyria-text-main transition-colors duration-150 active:scale-90 cursor-pointer rounded-full lyria-focus-ring"
        >
          <Square size={16} fill="currentColor" />
        </button>

        {/* Play button with glow */}
        <button
          onClick={() => {
            // Side effects live outside the state updater (updaters must stay pure and
            // double-invoke under StrictMode): compute the next state, drive the player,
            // then commit the state.
            const next = !isPlaying;
            if (next) {
              void player.play();
            } else {
              player.pause();
            }
            setIsPlaying(next);
          }}
          title={isPlaying ? 'Pause playback' : 'Play the active version'}
          aria-label={isPlaying ? 'Pause playback' : 'Play the active version'}
          aria-pressed={isPlaying}
          className={`w-12 h-12 rounded-full border flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95 cursor-pointer lyria-focus-ring ${isPlaying ? 'bg-gradient-to-b from-lyria-gold/30 to-lyria-gold/10 border-lyria-gold text-lyria-gold shadow-[0_0_30px_rgba(207,168,116,0.4)]' : 'bg-gradient-to-b from-[#3a3024] to-[#1a1611] border-lyria-gold/40 text-lyria-gold shadow-[0_0_25px_rgba(207,168,116,0.2)]'}`}
        >
          {isPlaying ? (
            <Pause size={20} fill="currentColor" />
          ) : (
            <Play size={24} fill="currentColor" className="ml-1" />
          )}
        </button>

        <button
          onClick={() => player.seek(player.currentTime + SEEK_SECONDS)}
          title={`Fast-forward ${SEEK_SECONDS} seconds`}
          aria-label={`Fast-forward ${SEEK_SECONDS} seconds`}
          className="text-lyria-text-muted hover:text-lyria-text-main transition-colors duration-150 active:scale-90 cursor-pointer rounded-full lyria-focus-ring"
        >
          <SkipForward size={20} fill="currentColor" />
        </button>
      </div>

      {/* Right: Master Volume & Meters */}
      <div className="flex items-center justify-end gap-6 w-[300px]">
        {/* Stereo Meter — driven by real analyser RMS levels from player.getLevels() */}
        <div title="Live output level, left/right channel" className="flex flex-col gap-[2px] w-16 h-4 opacity-80 lyria-breathe-glow">
           <div className="flex gap-[1px] h-full w-full">
              {meters.left.map((opacity, i) => (
                <div key={i} className={`flex-1 ${i > 12 ? 'bg-red-500/50' : i > 9 ? 'bg-yellow-500/50' : 'bg-green-500/50'}`} style={{ opacity }} />
              ))}
           </div>
           <div className="flex gap-[1px] h-full w-full">
              {meters.right.map((opacity, i) => (
                <div key={i} className={`flex-1 ${i > 12 ? 'bg-red-500/50' : i > 9 ? 'bg-yellow-500/50' : 'bg-green-500/50'}`} style={{ opacity }} />
              ))}
           </div>
        </div>

        <div className="flex items-center gap-3 group relative">
          <button
            onClick={() => { const v = volume === 0 ? 75 : 0; setVolume(v); player.setVolume(v / 100); }}
            title={volume === 0 ? 'Unmute' : 'Mute'}
            aria-label={volume === 0 ? 'Unmute' : 'Mute'}
            className="text-lyria-text-muted hover:text-lyria-text-main transition-colors duration-150 cursor-pointer rounded lyria-focus-ring"
          >
            <Volume2 size={16} />
          </button>
          <div title="Playback volume (does not affect the exported file)" className="w-24 h-2 bg-[#1a1a1e] rounded-full relative overflow-hidden flex items-center">
            <div className="absolute left-0 top-0 bottom-0 bg-lyria-gold rounded-full pointer-events-none" style={{ width: `${volume}%` }}></div>
            <input
              type="range"
              min="0" max="100"
              value={volume}
              onChange={(e) => { const v = parseInt(e.target.value); setVolume(v); player.setVolume(v / 100); }}
              title="Playback volume (does not affect the exported file)"
              aria-label="Playback volume"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer lyria-focus-ring rounded-full"
            />
            {/* Slider thumb */}
            <div className="absolute top-1/2 -translate-y-1/2 w-2 h-3 bg-white rounded-sm shadow border border-black/50 -translate-x-1/2 pointer-events-none" style={{ left: `${volume}%` }}></div>
          </div>
        </div>
      </div>

     </div>
    </div>
  );
}
