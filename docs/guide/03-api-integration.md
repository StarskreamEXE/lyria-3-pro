# 03 — API Integration

*Sources: deep dive (§6–§20, authoritative for code), official Lyria 3 notebook, @google/genai SDK api-report. SDKs: `@google/genai` ≥ 2.3.0 (JS/TS), `google-genai` ≥ 2.3.0 (Python).*

> **Before you send a request.** Both provider paths are implemented and both are paid. Gemini needs a **billing-enabled paid-tier** Google key — the free tier grants 0 Lyria requests per day and answers `429 Rate limit exceeded for model lyria-3-clip (limit: 0 requests per day on Free Tier)` (see [Errors & retries](#errors--retries)). OpenRouter needs account credit of at least $0.50 for any audio request. The Gemini request/response material below is Google's documented contract; the container it names is not a guarantee, so detect the format from the returned bytes.

## Two API surfaces

1. **Interactions API** (recommended, GA): `client.interactions.create({ model, input, response_format?, store? })` — REST endpoint `POST https://generativelanguage.googleapis.com/v1beta/interactions` with `x-goog-api-key`.
2. **generateContent** (legacy path): `client.models.generate_content(model, contents, config: { response_modalities: ["AUDIO", "TEXT"] })` — used in the official notebook.

## Request essentials

```ts
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const result = await ai.interactions.create({
  model: "lyria-3-pro-preview",
  input: promptText,                       // or [{type:"text",...}, {type:"image", mime_type, data(base64)}...]
  response_format: { type: "audio" },      // Google-documented: WAV, Pro only. Detect the real container.
  store: false,                            // don't persist the interaction server-side
});
```

- Multimodal input = array of typed parts: one `text` part + up to 10 `image` parts (base64 + mime_type; jpeg/png/webp).
- Google documents WAV as Pro-only, with Clip returning MP3; OpenRouter returns MP3 for both. A documented or requested container is not a guarantee — **never assume it**. Detect it from the bytes (`detectAudioFormat` in `server/lyria.ts` does exactly this, and its result — not the request — is what the manifest and EXPORT report).
- Set `response_modalities: ["AUDIO","TEXT"]` on the legacy path to receive lyrics/structure text alongside audio.

## Response shape & parsing

```text
interaction
├── id
├── output_audio.data          (base64 convenience)
├── output_text                (convenience)
└── steps[]
    └── type: "model_output"
        └── content[]
            ├── { type: "audio", data: base64 }
            └── { type: "text", text: lyrics / structural metadata / JSON }
```

Production rule: **walk every `model_output` step** rather than trusting the convenience props; concat multiple audio blocks; try-parse text blocks as JSON (structural metadata) vs lyrics. Text contains timestamp tags like `[12.5:]` / `[[...]]` that need regex cleanup (see notebook `display_output`). Full reference implementations: deep dive §8 (TS `generateLyriaPro`) and §13 (Python) — both persist audio + text + a JSON manifest per generation.

## Extract via CLI (debugging)

```bash
jq -r '.steps[] | select(.type=="model_output") | .content[] | select(.type=="audio") | .data' response.json | base64 -d > song.out
```

(Name the output by what the bytes actually are, not by what you asked for.)

## Errors & retries

| Status | Action |
|---|---|
| 400 invalid request / 401 bad key / 403 access | Fix — do **not** retry |
| 408 / 429 / 500 / 502 / 503 / 504 | Retry with exponential backoff + jitter (cap ~30s, ~5 attempts) |

Retry wrapper: deep dive §18. Never loop-retry malformed prompts or permission failures.

**Quota 429 is not a transient 429.** Google's free tier grants zero Lyria requests per day, so a free-tier key answers `429 Rate limit exceeded for model lyria-3-clip (limit: 0 requests per day on Free Tier)` on the first call. That is a hard entitlement failure, not congestion: retry and exponential backoff never clear it, and a retry wrapper must special-case it rather than treating it as transient. The fix is a billing-enabled key or a different provider. Surface it to the user as a configuration problem, not as "try again".

## Cost & batching

- **$0.08 per successful Pro request.** No free tier listed. Failed requests aren't billed as "successful."
- No multi-candidate parameter on Lyria 3 → a "×N batch" is N parallel `interactions.create` calls, each billed. This is why the UI's BATCH control is explicit and cost-scaled.
- Analysis (`POST /api/ai/analyze`) and the two text helpers are additional paid calls on top of generation. Analysis in the app is manual-only and its result is cached into the generation's manifest, so a given generation is analyzed once.
- Recommended: persist a manifest per generation. The app's manifest (`GenerationManifest` in `server/lyria.ts`, written to `generations/<id>.json`) carries: `id`, `model`, `format` (detected from the bytes), `provider`, `prompt`, `lyrics`, `generatedAt`, and optionally `interactionId`, `structure`, `analysis`, `title`, `durationSeconds`, plus the request settings `language`, `durationTarget` and `batchCount`. The three settings fields are written only when the request supplied them, so older manifests simply lack them and consumers must treat them as absent rather than defaulting. Maps 1:1 onto a UI "version."

## Streaming (content delta)

The Interactions API accepts `stream=True` (notebook-verified): lyrics/description text and audio chunks arrive as `content.delta` events during generation rather than one blob at the end. Good for progress UX; it is **not** live/continuous music (that's Lyria RealTime — see [05](05-realtime-and-roadmap.md)).

## OpenRouter

OpenRouter is a fully live AI provider alongside Gemini, selectable per-request via the `x-ai-provider` header (see [Key management](#key-management-in-this-app) below). It covers the text-helper endpoints, analysis and Lyria generation. Its entry requirement is account credit rather than a billing tier: see [Cost gate](#cost-gate-openrouter-specific) below.

### Text endpoints via OpenRouter

`/api/ai/modify` and `/api/ai/enhance-prompt` call OpenRouter the same way as Gemini — same prompt, same contract — just against a different backend:

```text
POST https://openrouter.ai/api/v1/chat/completions
```

Non-streaming; the model is `OPENROUTER_TEXT_MODEL` (default `google/gemini-3.5-flash`). Response handling (``` fence stripping, `selectedText` replacement) is unchanged from the Gemini path.

### Lyria generation via OpenRouter

`POST /api/lyria/generate` with provider `openrouter` targets two models:

| Model | Use | Cost |
|---|---|---|
| `google/lyria-3-pro-preview` | Full generation | $0.08/song |
| `google/lyria-3-clip-preview` | Clip | $0.04/clip |

Request shape differs from the Interactions API:

- `modalities: ["text", "audio"]` — required to get audio back.
- `audio: { format }` — the app asks for `mp3` on clip and `wav` on pro, but this is only a request: **OpenRouter returns MP3 for both Pro and Clip.** Its own docs say the audio format varies by model. Detect the container from the returned bytes and ignore what you asked for.
- `stream: true` — audio is **only** delivered via SSE; there is no non-streaming audio response.
- Images go in as `image_url` data-URL parts (same ≤10 cap as Gemini's `image` parts).
- `audio.voice` is **not** required for Lyria models — omit it.

### Response shape & parsing

Audio arrives as base64 fragments in `choices[0].delta.audio.data` across SSE events; concatenate all fragments, then base64-decode once complete. The transcript streams in parallel via `delta.audio.transcript`; for an instrumental generation it is the literal string `<instrumental>` rather than empty or omitted, so handle that value explicitly.

Parsing is handled server-side by `parseOpenRouterAudioSSE` in `server/lyria.ts` (unit-tested). It is the OpenRouter equivalent of "walk every `model_output` step" on the Gemini side — do not assume a single audio blob; accumulate fragments across the SSE stream.

Output detail: **both** Pro and Clip generations come back as a real MP3, stereo 44.1 kHz (written under `generations/` and served as `audio/mpeg`), not a container-only stub. The app writes title/artist/comment tags into the returned file with `embedId3` (`embedWavInfo` for the WAV mock path) without re-encoding the audio.

### Cost gate (OpenRouter-specific)

OpenRouter requires an account balance of **at least $0.50** for *any* audio-output request (Lyria pro or clip). Below that threshold it returns **402** before generation starts — the failed request is not billed. This has no Gemini equivalent and should be surfaced to the user distinctly from a generic auth failure.

### Manifest

The per-generation manifest JSON (fields listed under [Cost & batching](#cost--batching) above; deep dive §23 for the original schema) carries a `provider` field: `gemini | openrouter | mock`, alongside the detected `format` and the recorded request settings `language` / `durationTarget` / `batchCount`.

`LYRIA_MOCK=1` bypasses both providers entirely and is unaffected by any of the above; it is the only path that writes a locally synthesized WAV.

## Key management in this app

Server (`server.ts`) resolves the **provider** as: `x-ai-provider` request header (user-provided via Settings modal → localStorage `ai_provider`) → `AI_PROVIDER` env var → default `gemini`.

Per-provider keys follow the same header-over-env precedence:

- Gemini: `x-gemini-api-key` request header (Settings modal → localStorage `gemini_api_key`) → `GEMINI_API_KEY` in `.env.local`.
- OpenRouter: `x-openrouter-api-key` request header (Settings modal → localStorage `openrouter_api_key`) → `OPENROUTER_API_KEY` in `.env.local`.

`.env.example` documents both providers' env vars, including `OPENROUTER_TEXT_MODEL` and `OPENROUTER_ANALYZE_MODEL` (both default `google/gemini-3.5-flash`). Any future generation endpoint must follow the same precedence.

Note that the server-side default provider is `gemini`. A user whose `AI_PROVIDER` is unset, who has not chosen in Settings, and whose Google key is on the free tier will hit the 0-requests-per-day 429 described above on their first generation. Point them at a billing-enabled Google key, or at OpenRouter with credit on the account.
