# Lyria 3 Pro — Documentation

Documentation for the Lyria 3 Pro frontend and the real Google Lyria 3 API it is designed to drive.

## The Guide (`guide/`)

| Doc | Contents |
|---|---|
| [01 — Models & Capabilities](guide/01-lyria-models.md) | Lyria 3 / 3 Pro / Lyria 2 specs, what generation produces, hard limitations |
| [02 — Prompting Guide](guide/02-prompting-guide.md) | The prompting framework: structure, section tags, timestamps, vocals, lyrics, exclusions |
| [03 — API Integration](guide/03-api-integration.md) | Interactions API request/response, TS + Python + REST, WAV output, parsing, retries, errors, pricing |
| [04 — App Integration Map](guide/04-app-integration.md) | How this UI maps onto the API: versions, prompt assembly, event bus, export, theDAW handoff |
| [05 — RealTime & Roadmap](guide/05-realtime-and-roadmap.md) | Lyria RealTime (LiveMusic), streaming interactions, future feature candidates |

## Reference documents

- [`Lyria_3_Pro_Technical_Deep_Dive.md`](Lyria_3_Pro_Technical_Deep_Dive.md) — full technical reference for single-turn generation: production-grade TS/Python generators, REST examples, retry wrapper, manifest schemas. The guide summarizes it; the deep dive is the implementation source of truth.
- [`Lyria_RealTime_Technical_Deep_Dive.md`](Lyria_RealTime_Technical_Deep_Dive.md) — full technical reference for `lyria-realtime-exp` (v1alpha): WebSocket session flow, weighted-prompt morphing, config state management, PCM16 jitter buffers + WAV capture, scene system, reconnection strategy, DAW threading architecture. Source of truth for JAM-mode work.
- [`plans/2026-07-15-versions-design.md`](plans/2026-07-15-versions-design.md) — the validated "versions" design (why takes became version tabs).

## Local doc index (docs-mcp-server)

Indexed libraries for lookups during development: `lyria` (official notebook), `lyria-prompting` (official prompting guide), `lyria-realtime` (official RealTime cookbook quickstart), `google-genai` (JS SDK), `tailwindcss` (4.0.0), `react`, `typescript`, `vite`, `express`.

Known limitation: `ai.google.dev` and JS-rendered pages can't be crawled — use raw GitHub files or WebFetch for those.
