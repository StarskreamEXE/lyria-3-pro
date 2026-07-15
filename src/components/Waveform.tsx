import React, { useRef, useEffect, useState, useCallback, memo } from 'react';
import { player } from '../lib/player';

// Per-bucket signed min/max derived on the fly from the flat `peaks` prop (see
// resampleToMinMax below). Kept local — CenterPanel still only ever hands us a flat
// rectified peak array, so the classic-waveform min/max shape is synthesized here.
interface MinMaxBuckets {
  min: Float32Array;
  max: Float32Array;
}

/**
 * Resamples a flat, rectified (0..1) peak array into `columns` signed min/max pairs by
 * taking the loudest sample in each bucket and mirroring it symmetrically above/below
 * the center line (the source has no sign information to preserve). Rendered as narrow
 * per-column bars this still reads as the classic "spiky" DAW silhouette rather than a
 * smooth blob, because each bar's height now tracks its own bucket's local peak instead
 * of a globally-smoothed envelope. Bucket count is driven by the caller (canvas pixel
 * width), not by the length of `peaks`, so resizes/zoom just re-bucket the same array.
 */
function resampleToMinMax(peaks: number[], columns: number): MinMaxBuckets {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const n = peaks.length;
  if (n === 0 || columns === 0) return { min, max };

  for (let col = 0; col < columns; col++) {
    const start = Math.floor((col / columns) * n);
    const end = Math.max(start + 1, Math.floor(((col + 1) / columns) * n));
    let bucketMax = 0;
    for (let i = start; i < end && i < n; i++) {
      const v = Math.max(0, Math.min(1, peaks[i]));
      if (v > bucketMax) bucketMax = v;
    }
    max[col] = bucketMax;
    min[col] = -bucketMax;
  }

  return { min, max };
}

export const Waveform = memo(({
  color = '#b5926c',
  opacity = 1,
  className = '',
  bars = 200,
  progress = 0, // 0 to 1 — used only as a fallback when there is no seekable player source
  peaks = undefined,
  seekable,
}: {
  color?: string,
  opacity?: number,
  className?: string,
  bars?: number,
  progress?: number,
  peaks?: number[] | null,
  seekable?: boolean,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  // Offscreen bars-layer cache: the bars + glow render is deterministic per
  // (peaks identity, canvas pixel size, color, opacity), so it's rasterized once into
  // an offscreen canvas and blitted per frame. The rAF playhead loop therefore never
  // re-buckets (resampleToMinMax) or re-fills hundreds of bars — its per-frame cost is
  // one drawImage plus the playhead line.
  const barsLayerRef = useRef<{
    canvas: HTMLCanvasElement;
    peaks: number[];
    pixelWidth: number;
    pixelHeight: number;
    color: string;
    opacity: number;
  } | null>(null);

  const hasRealPeaks = !!peaks && peaks.length > 0;
  // Seeking only makes sense once there's real audio-bearing peak data AND the player
  // actually has a source loaded — otherwise there is nothing to scrub to.
  const isSeekable = (seekable ?? true) && hasRealPeaks && player.hasSource;

  // Canvas pixel width in CSS px — recomputed via ResizeObserver so bucket count always
  // matches the actual rendered lane width instead of a fixed 200-point resample.
  const [cssWidth, setCssWidth] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = entry.contentRect.width;
      setCssWidth((prev) => (Math.abs(prev - width) > 0.5 ? width : prev));
    });
    observer.observe(container);
    // Seed synchronously too, in case ResizeObserver's first callback is deferred a tick.
    setCssWidth(container.getBoundingClientRect().width);

    return () => observer.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width <= 0 || height <= 0) return;

    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);

    const midY = height / 2;

    // No real peak data yet — covers both the explicit empty-array "no audio" signal
    // and null/undefined (peaks not resolved yet, e.g. mid-decode). Draw a flat dim
    // center line rather than a placeholder blob.
    if (!hasRealPeaks) {
      ctx.scale(dpr, dpr);
      ctx.globalAlpha = opacity * 0.35;
      ctx.fillStyle = color;
      ctx.fillRect(0, midY - 0.5, width, 1);
      return;
    }

    const peaksArr = peaks as number[];

    // Bars layer — re-rasterized only when the peaks array identity, canvas pixel
    // size, color, or opacity change (i.e. never inside the steady-state rAF playhead
    // loop). Inside the rebuild: identical rendering to the previous per-frame path.
    let layer = barsLayerRef.current;
    if (
      !layer ||
      layer.peaks !== peaksArr ||
      layer.pixelWidth !== pixelWidth ||
      layer.pixelHeight !== pixelHeight ||
      layer.color !== color ||
      layer.opacity !== opacity
    ) {
      const off = layer?.canvas ?? document.createElement('canvas');
      off.width = pixelWidth;
      off.height = pixelHeight;
      const offCtx = off.getContext('2d');
      if (!offCtx) return;
      offCtx.setTransform(1, 0, 0, 1, 0, 0);
      offCtx.clearRect(0, 0, pixelWidth, pixelHeight);
      offCtx.scale(dpr, dpr);

      // Classic DAW bar rendering: crisp vertical columns, one per bucket, drawn from
      // per-bucket signed min/max around a center line. Bar/gap geometry judged at DPR —
      // hairline 1px bars read as noise at low density, so widen slightly at low DPR.
      const barW = dpr >= 2 ? 1 : 2;
      const gap = 1;
      const stride = barW + gap;
      const columns = Math.max(1, Math.floor(width / stride));

      const { min, max } = resampleToMinMax(peaksArr, columns);

      // Bars occupy ~70% of the available height, centered, so even a tall lane reads as
      // a proper waveform rather than a wall of color.
      const maxAmplitude = (height / 2) * 0.7;
      const centerGap = 0.5; // subtle break at the center line, like real DAW meters

      offCtx.fillStyle = color;
      offCtx.globalAlpha = opacity;

      for (let col = 0; col < columns; col++) {
        const x = col * stride;
        const topAmp = Math.max(0, max[col]) * maxAmplitude;
        const bottomAmp = Math.max(0, -min[col]) * maxAmplitude;

        const topY = midY - Math.max(topAmp, centerGap);
        const bottomY = midY + Math.max(bottomAmp, centerGap);
        offCtx.fillRect(x, topY, barW, bottomY - topY);
      }

      // Subtle outer glow: a soft, low-opacity re-stroke of the same bars, wider than the
      // fill — reads as a gentle bloom rather than a duplicated silhouette. Runs only on
      // layer rebuilds, so the shadowBlur cost never recurs per animation frame.
      offCtx.save();
      offCtx.globalAlpha = opacity * 0.12;
      offCtx.shadowColor = color;
      offCtx.shadowBlur = 4;
      for (let col = 0; col < columns; col++) {
        const x = col * stride;
        const topAmp = Math.max(0, max[col]) * maxAmplitude;
        const bottomAmp = Math.max(0, -min[col]) * maxAmplitude;
        const topY = midY - Math.max(topAmp, centerGap);
        const bottomY = midY + Math.max(bottomAmp, centerGap);
        offCtx.fillRect(x, topY, barW, bottomY - topY);
      }
      offCtx.restore();

      layer = { canvas: off, peaks: peaksArr, pixelWidth, pixelHeight, color, opacity };
      barsLayerRef.current = layer;
    }

    // Blit the cached bars at device-pixel scale (the layer is already DPR-sized),
    // then switch to CSS-pixel scale for the playhead overlay.
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.scale(dpr, dpr);

    // Playhead: 1px bright line with a soft glow, positioned from the player's own
    // transport when seekable, else falls back to the `progress` prop.
    const ratio = isSeekable
      ? (player.duration > 0 ? player.currentTime / player.duration : 0)
      : progress;
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    if (isSeekable || progress > 0) {
      // The playhead breathes with the music: while playing, read the smoothed
      // 0..1 level BottomBar's meter loop publishes as player.pulseLevel (the
      // same value it mirrors onto <html> as --lyria-pulse for CSS consumers —
      // read here as a plain number instead of paying a per-frame
      // getComputedStyle() hit) and let it swell the glow's blur and alpha. At
      // the resting state (pulse 0, i.e. any time nothing is playing) the values
      // below collapse to exactly the previous static 6px/0.9 playhead.
      let pulseLevel = 0;
      if (isSeekable && player.isPlaying) {
        const raw = player.pulseLevel;
        if (Number.isFinite(raw)) pulseLevel = Math.max(0, Math.min(1, raw));
      }
      const playheadX = clampedRatio * width;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.shadowColor = `rgba(255, 250, 235, ${(0.9 + 0.1 * pulseLevel).toFixed(3)})`;
      ctx.shadowBlur = 6 + 10 * pulseLevel;
      ctx.fillStyle = 'rgba(255, 252, 240, 0.95)';
      ctx.fillRect(playheadX - 0.5, 0, 1, height);
      ctx.restore();
    }
  }, [color, opacity, peaks, hasRealPeaks, isSeekable, progress]);

  // Repaint whenever peaks/size/style change.
  useEffect(() => {
    draw();
  }, [draw, cssWidth]);

  // rAF playhead loop — runs only while the player is actually playing, and
  // self-terminates the instant it stops (pause/end/no source) rather than polling
  // indefinitely in the background. A lightweight low-frequency interval (not rAF)
  // watches for playback starting so we're not spending a full animation frame budget
  // while paused/idle — it only ever does a cheap boolean check.
  useEffect(() => {
    if (!isSeekable) return;

    const tick = () => {
      if (!player.isPlaying) {
        rafRef.current = null;
        return;
      }
      draw();
      rafRef.current = requestAnimationFrame(tick);
    };

    const startIfPlaying = () => {
      if (rafRef.current == null && player.isPlaying) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    // Covers the case where playback is already underway when this effect (re-)runs.
    startIfPlaying();
    const watchdog = window.setInterval(startIfPlaying, 250);

    return () => {
      window.clearInterval(watchdog);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isSeekable, draw]);

  const ratioFromPointer = useCallback((clientX: number): number => {
    const container = containerRef.current;
    if (!container) return 0;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const seekToClientX = useCallback((clientX: number) => {
    if (!isSeekable || player.duration <= 0) return;
    const ratio = ratioFromPointer(clientX);
    player.seek(ratio * player.duration);
    draw(); // one immediate repaint so the playhead doesn't wait for the next rAF tick
  }, [isSeekable, ratioFromPointer, draw]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isSeekable) return;
    isDraggingRef.current = true;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    seekToClientX(e.clientX);
  }, [isSeekable, seekToClientX]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isSeekable || !isDraggingRef.current) return;
    seekToClientX(e.clientX);
  }, [isSeekable, seekToClientX]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full ${className}`}
      style={isSeekable ? { cursor: 'ew-resize' } : undefined}
      onPointerDown={isSeekable ? handlePointerDown : undefined}
      onPointerMove={isSeekable ? handlePointerMove : undefined}
      onPointerUp={isSeekable ? handlePointerUp : undefined}
      onPointerCancel={isSeekable ? handlePointerUp : undefined}
      aria-label={isSeekable ? 'Waveform — drag to seek playback position' : undefined}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
});

Waveform.displayName = 'Waveform';
