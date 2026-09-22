# 01 — Lyria Models & Capabilities

*Sources: official Lyria 3 notebook, Google Cloud "Ultimate prompting guide for Lyria 3 models" (2026-04-07), Gemini API music-generation docs, project deep dive. Reference material current as of 2026-07-15.*

> **Documented contract vs. delivered bytes.** The specifications below are what Google and OpenRouter document. Providers do not reliably honor a requested container, so treat container claims as intent, not as a guarantee, and read the format off the returned bytes (see [Container](#container-never-assume-it) and [Provider requirements](#provider-reality)).

## The model family

| | Lyria 3 Pro | Lyria 3 (Clip) | Lyria 2 |
|---|---|---|---|
| Model ID | `lyria-3-pro-preview` | `lyria-3-clip-preview` | `lyria-002` |
| Purpose | Full structured songs | Fast 30s clips, high volume | Legacy Vertex music gen |
| Duration | Prompt-side **target** up to ~3 minutes — not enforced | Fixed ~30 seconds | 30s |
| Output container | Google documents a WAV path (`response_format: {type:"audio"}`); OpenRouter returns MP3. Detect it, don't assume it | MP3 | WAV |
| `sample_count` (multi-sample) | No | No | Yes (excl. with `seed`) |
| `seed` | No | No | Yes |
| `negative_prompt` | No (use prompt-side exclusions) | No | Yes |
| Price | $0.08 per successful request | $0.04 per clip | Vertex pricing |

Shared output characteristics: stereo, 44.1 kHz, SynthID watermark + C2PA metadata on everything.

### Container: never assume it

Google documents a WAV response path for Pro (`response_format: { type: "audio" }`) and MP3 for Clip; OpenRouter returns **MP3 for both Pro and Clip**, and its own docs say the audio format varies by model. A requested container is a request, not a contract — neither provider is obliged to encode what you asked for.

The app therefore never trusts the requested container: `detectAudioFormat` in `server/lyria.ts` reads the actual bytes, and that detected format is what drives the file extension, the manifest `format` field and EXPORT. Any client of either API should do the same.

`LYRIA_MOCK=1` is the only path that produces WAV without touching a provider: it synthesizes a local WAV so the whole pipeline can be exercised without cost.

### Duration: a target, not a contract

There is no duration parameter on Lyria 3. The requested length is ordinary prompt text (`assembleLyriaPrompt` in `server/lyria.ts` states it as an explicit total running time plus an end timestamp), and the model is free to miss it in either direction — overrunning a one-minute target by more than a minute is possible. Strong wording improves adherence; nothing enforces it. Clip is fixed at ~30 seconds by the model and ignores the target entirely.

### Provider reality

Both generation providers are paid, and each has its own entitlement wall to clear before any request succeeds:

- **Google / Gemini.** Lyria generation requires a **billing-enabled paid-tier** key. Google's free tier grants **zero** Lyria requests per day, so a free-tier key fails immediately with `429 Rate limit exceeded for model lyria-3-clip (limit: 0 requests per day on Free Tier)`. That is an entitlement failure, not congestion — retry and backoff never clear it (see [03 — Errors & retries](03-api-integration.md#errors--retries)). Gemini's text-helper and analysis calls use a different quota and are unaffected.
- **OpenRouter.** Requires account credit, and refuses any audio-output request while the balance is under **$0.50**, returning 402 before generation starts.

## What a Pro generation contains

A single request returns a **finished song**, not an editable project: intro/verse/pre-chorus/chorus/bridge/breakdown/outro arrangement, lead vocals + harmonies, user-provided or generated lyrics, full instrumentation, and dynamics that change per section. The response also carries TEXT blocks with the generated lyrics and structural metadata (timestamped tags) alongside the audio. OpenRouter carries the same thing as a streamed transcript. Either way the returned text arrives wrapped in provider markup (`[[A0]]` structural ids, `[2.0:6.1]` timing prefixes); the app strips that before showing lyrics (`src/lib/lyricsText.ts`) but stores the raw text in the manifest.

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
- Any duration guarantee at all — not just sample-exact: the requested running time and the timestamps *guide*, they don't bind, and the model can overshoot a target by minutes
- Choice of output container — you get whatever the provider encodes, regardless of what the request asked for
- Guaranteed lyric adherence
- Continuous/infinite streaming (content streaming during a generation *is* available — see [05](05-realtime-and-roadmap.md))

**Consequence:** every "edit" is really *new prompt → new full generation → new version*. This is why the app models results as version tabs, not editable takes ([04 — App Integration](04-app-integration.md)).
