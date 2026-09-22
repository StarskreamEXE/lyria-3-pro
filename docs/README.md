# Lyria 3 Pro — Documentation

Documentation for the Lyria 3 Pro app and the Google Lyria 3 API it drives. Installation and configuration live in the [project README](../README.md).

> **What the app does vs. what the API documents.** Statements about *the app* describe the shipped code. Statements about the Lyria API describe Google's or OpenRouter's published contract, which providers do not always honor byte for byte — the output container is the clearest example, which is why the server detects the format from the returned bytes instead of trusting the one it requested. Both generation providers are paid: a Google API key needs billing enabled (the free tier grants 0 Lyria requests per day) and an OpenRouter account needs at least $0.50 of credit for any audio request.

## User Guide

**[USER_GUIDE.md](USER_GUIDE.md)**: how to use every part of the app, from first launch to export — prompts, structure, AI assist, versions, analysis, projects, playback, export, settings, mock mode, shortcuts and troubleshooting.

## The Guide (`guide/`)

| Doc | Contents |
|---|---|
| [01 — Models & Capabilities](guide/01-lyria-models.md) | Lyria 3 Pro / Clip / Lyria 2 specs, what a generation really returns (container, duration, provider requirements), inputs, hard limitations |
| [02 — Prompting Guide](guide/02-prompting-guide.md) | The prompting framework: structure, section tags, timestamps, duration language, vocals, lyrics, exclusions, multimodal |
| [03 — API Integration](guide/03-api-integration.md) | Interactions API request/response and parsing, errors and retries, cost and manifests, streaming, the OpenRouter path, key management |
| [04 — App Integration Map](guide/04-app-integration.md) | How the UI maps onto the API: controls, provider selection, the event bus, prompt assembly, what is real today |
| [05 — RealTime & Roadmap](guide/05-realtime-and-roadmap.md) | Lyria RealTime (LiveMusic), content streaming, what has shipped, remaining roadmap and watch list |

## Reference documents

- [`Lyria_3_Pro_Technical_Deep_Dive.md`](Lyria_3_Pro_Technical_Deep_Dive.md) — full technical reference for single-turn generation: production-grade TS/Python generators, REST examples, retry wrapper, manifest schemas. The guide summarizes it; the deep dive is the reference for generation code. Where the deep dive and the shipped code disagree (output container in particular), the shipped behavior described in the guide is what the app does.
- [`Lyria_RealTime_Technical_Deep_Dive.md`](Lyria_RealTime_Technical_Deep_Dive.md) — full technical reference for `lyria-realtime-exp` (v1alpha): WebSocket session flow, weighted-prompt morphing, config state management, PCM16 jitter buffers + WAV capture, scene system, reconnection strategy, DAW threading architecture. Source of truth for JAM-mode work. Lyria RealTime is not wired into this app.
