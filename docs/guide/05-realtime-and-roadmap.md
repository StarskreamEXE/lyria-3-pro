# 05 — Lyria RealTime & Roadmap

*Sources: `docs/Lyria_RealTime_Technical_Deep_Dive.md` (implementation source of truth — full TS/Python controllers, jitter buffers, WAV capture, scene system), @google/genai SDK api-report, Gemini API realtime-music docs.*

## Lyria RealTime — the other Lyria

Separate from single-turn Lyria 3 generation: a **continuous, live-steerable instrumental music stream** over a persistent WebSocket.

| | Lyria RealTime |
|---|---|
| Model ID | `lyria-realtime-exp` (connect as `models/lyria-realtime-exp`) |
| API version | `v1alpha` — **experimental**, everything can change |
| Output | Raw PCM16 LE, 48 kHz, stereo (192,000 bytes/sec) — client records it, no file generation |
| Vocals | **Instrumental only** (VOCALIZATION mode = vocal-like textures, no lyrics/singing) |
| Control latency | Up to ~2 seconds — not sample-accurate automation |
| Pricing | No dedicated price listed |

```ts
const client = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });
const session = await client.live.music.connect({ model: "models/lyria-realtime-exp", callbacks });
await session.setWeightedPrompts({ weightedPrompts: [{ text: "Minimal techno", weight: 1.0 }] });
await session.setMusicGenerationConfig({ musicGenerationConfig: { bpm: 124, guidance: 4.0, density: 0.55, brightness: 0.35, audioFormat: "pcm16", sampleRateHz: 48_000 } });
await session.play();   // also: pause() / stop() / resetContext()
```

## Control surface (all live-updatable)

- **Weighted prompts** — multiple simultaneous, weights positive or negative but never exactly 0; blend/morph weights gradually for smooth transitions (abrupt swaps = abrupt music).
- **Config** (treat as a full-state snapshot — resend everything on each update): `guidance` 0–6 (default 4, adherence vs smoothness), `bpm` 60–200, `density` 0–1, `brightness` 0–1, `scale` (12 relative major/minor enum pairs), `muteBass` / `muteDrums` / `onlyBassAndDrums`, `musicGenerationMode` QUALITY/DIVERSITY/VOCALIZATION, `temperature` 0–3 (1.1), `topK` 1–1000 (40), `seed`.
- **Soft vs hard changes**: prompts/guidance/density/brightness/mutes update in place; **BPM and scale changes require `resetContext()`** → audible hard transition. Quantize scene changes to musical boundaries.
- **Filtered prompts**: safety-filtered prompts are silently ignored (stream continues) — watch `filteredPrompt` on messages.

## Production notes (deep dive §32–§38)

Jitter-buffer ~1s (192 KB) before playback; never touch network/JSON on the audio thread; record raw PCM before effects; log every prompt/config event with timestamps (capture-manifest schema in §33); treat reconnects as new takes with prompt+config restoration; pin SDK versions; wrap the session behind an adapter interface (SDK naming has drifted: `resetContext` vs `reset_context`).

## Content streaming on single-turn generation

Unrelated to RealTime: `interactions.create(..., stream=True)` emits `content.delta` events (lyrics text, audio chunks) during a normal Lyria 3 generation. Cheap UX win — stream lyrics into the UI instead of a spinner.

## Already shipped (no longer roadmap)

- **Real generation wiring** — the [04](04-app-integration.md) mapping is built: `POST /api/lyria/generate` assembles the prompt server-side, calls Gemini or OpenRouter, persists audio + manifest, and fires `lyria-generated`. Both provider paths are implemented; each needs its own paid entitlement first — billing enabled on a Google key (free-tier Lyria quota is 0/day), or ≥$0.50 credit on OpenRouter (see [01](01-lyria-models.md#provider-reality)).
- **Version manifests** — every generation writes `generations/<id>.json`, and HISTORY is the real persistent log built on top of them.
- **Audio analysis** — a manual, paid analysis pass turns a finished track into genre/mood/BPM/key/instrumentation plus timestamped sections, cached in the manifest and drawn on the timeline.

## Roadmap candidates for this app

1. **Streaming generation UX** — `stream=True` on the Gemini path; lyric deltas into the lyrics panel, orb pulses per chunk. (OpenRouter already streams, but the server accumulates the whole SSE body before responding.)
2. **JAM mode (Lyria RealTime)** — the natural fit for this UI:
   - INTENT/ENERGY/DENSITY/ACOUSTICNESS stats → real inputs (weighted prompts + `density`/`brightness`)
   - TEMPO/KEY in the top bar → `bpm` + `scale` (hard changes — schedule on bar boundaries, fire `resetContext`)
   - Transport play/pause/stop → `session.play()/pause()/stop()`
   - Mute controls → `muteBass`/`muteDrums`/`onlyBassAndDrums` (note: only bass and drums are controllable; the timeline has a single MASTER lane today, so there are no per-stem mute buttons to map)
   - Section-based scenes → the deep dive §29 scene system (prompt morphs + config patches per section)
   - Capture → PCM16→WAV recorder (§25) feeding the version tabs as "live takes"
   - Constraint to design around: **instrumental only** — the lyrics panel is inert in JAM mode.
3. **Batch as native sample_count** — if Google ships it for Lyria 3, the BATCH chip maps to one request with zero UI change.
4. **Prompt diffs between versions** — the manifests already record each version's prompt and settings; HISTORY could show what changed between two takes.
5. **Provider-specific handling on the Gemini generation path** — everything is implemented; what remains is exercising it on a billing-enabled Google key and pinning down its real behavior (including which container Pro actually returns) rather than assuming the documented one.

## Watch list

- `sample_count` / `seed` arriving on Lyria 3 (exists on `lyria-002` today)
- Lyria RealTime leaving experimental (`v1alpha`) — model ID/params/quotas can all change
- Whether the documented Pro WAV path materializes in practice — OpenRouter returns MP3 for Pro and Clip alike regardless of the requested format
- Lyria generation quota on Google's free tier moving off 0 requests/day
- \>3-minute Pro generations, and any real duration control
- Live Music Models paper: https://arxiv.org/abs/2508.04651
