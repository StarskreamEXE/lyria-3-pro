# 01 — Lyria Models & Capabilities

*Sources: official Lyria 3 notebook, Google Cloud "Ultimate prompting guide for Lyria 3 models" (2026-04-07), Gemini API music-generation docs, project deep dive. Current as of 2026-07-15.*

## The model family

| | Lyria 3 Pro | Lyria 3 (Clip) | Lyria 2 |
|---|---|---|---|
| Model ID | `lyria-3-pro-preview` | `lyria-3-clip-preview` | `lyria-002` |
| Purpose | Full structured songs | Fast 30s clips, high volume | Legacy Vertex music gen |
| Duration | Up to ~3 minutes (prompt-controlled) | Fixed ~30 seconds | 30s |
| Native WAV | Yes (`response_format: {type:"audio"}`) | Not documented (MP3) | WAV |
| `sample_count` (multi-sample) | No | No | Yes (excl. with `seed`) |
| `seed` | No | No | Yes |
| `negative_prompt` | No (use prompt-side exclusions) | No | Yes |
| Price | $0.08 per successful request | $0.04 per clip | Vertex pricing |

Shared output characteristics: stereo, 44.1 kHz, MP3 by default, SynthID watermark + C2PA metadata on everything.

## What a Pro generation contains

A single request returns a **finished song**, not an editable project: intro/verse/pre-chorus/chorus/bridge/breakdown/outro arrangement, lead vocals + harmonies, user-provided or generated lyrics, full instrumentation, and dynamics that change per section. The response also carries TEXT blocks with the generated lyrics and structural metadata (timestamped tags) alongside the audio.

## Inputs

- **Text prompt** — the primary control surface (see [02 — Prompting](02-prompting-guide.md)).
- **Images** — up to 10 per request, used as creative/emotional context (never as audio references).
- **PDFs** — the prompting guide lists PDF reference files as a multimodal input.
- **Audio — NOT supported.** No audio conditioning, no cover/continuation of uploaded songs.

## Vocals & languages

Multi-vocal conditioning and generation in **8 languages**: English, German, Spanish, French, Hindi, Japanese, Korean, Portuguese. Write the prompt in the target language or request it explicitly.

## Hard limitations (drive all product decisions)

Generation is **single-turn**. Per the official docs: *"Iterative editing or refining a generated clip through multiple prompts is not supported."* Not documented / not supported for Lyria 3:

- Post-generation editing, section replacement, audio inpainting, follow-up refinement
- Uploaded-audio conditioning or continuation
- Native stems, MIDI, or chord output
- Seed control / exact reproducibility ("results may vary between calls, even with the same prompt")
- Multiple candidates per request (batch = N parallel requests)
- Sample-exact duration or guaranteed structural timing (timestamps *guide*, they don't bind)
- Guaranteed lyric adherence
- Continuous/infinite streaming (content streaming during a generation *is* available — see [05](05-realtime-and-roadmap.md))

**Consequence:** every "edit" is really *new prompt → new full generation → new version*. This is why the app models results as version tabs, not editable takes ([04 — App Integration](04-app-integration.md)).
