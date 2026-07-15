# 04 — App Integration Map

*How this frontend's concepts map onto the real Lyria 3 API, and where theDAW backend takes over. This is the contract for wiring the UI to real generation.*

## The core mapping

| UI concept | API reality |
|---|---|
| GENERATE button | One `interactions.create` call per version (`lyria-3-pro-preview` / `lyria-3-clip-preview`) |
| BATCH ×1/×2/×4 | N **parallel** requests (no `sample_count` on Lyria 3); cost dots scale because each is $0.08 |
| Version tab (V1, V2 …) | One completed generation = one immutable artifact + manifest. Never "edited," only superseded |
| PROMPT box | The technical-direction + structure portion of the prompt (see [02](02-prompting-guide.md)) |
| LYRICS box | The lyrics block, concatenated under section tags into the final prompt at request time |
| Language chip (EN…) | Prompt-side: write/request lyrics in that language |
| DUR chip (1:00/2:00/3:00) | Prompt-side duration language ("Create a 2 minute …"); Clip model ignores it (fixed 30s) |
| MODEL chip | Model ID selection; also gates WAV export + duration display |
| Settings → AI PROVIDER (GEMINI \| OPENROUTER) | Selects which backend `/api/ai/*` and `/api/lyria/generate` call; see [Provider selection](#provider-selection) below |
| IMAGE REFERENCES (≤10) | `image` parts (Gemini) / `image_url` data-URLs (OpenRouter) in the multimodal input array |
| Inspector REGENERATE/EXTEND/RESTYLE/REPLACE | Appends a `[start - end] SECTION: directive` line to the prompt, then queues a **new full generation** |
| LOCK SECTION | Appends a keep-as-is directive for that section's time range |
| INSTRUMENTAL tool | Appends "Instrumental only — no vocals." + new generation |
| CHANGE STYLE tool | Prompt rewrite + new generation |
| EST. COST dots | 3 + batchCount lit (visual stand-in for $0.08 × N Pro / $0.04 × N Clip) |

## Provider selection

Settings modal has an AI PROVIDER selector (`GEMINI` \| `OPENROUTER`, default `gemini`, persisted to localStorage `ai_provider`) and an OpenRouter API key field (localStorage `openrouter_api_key`), alongside the existing Gemini key field.

Request headers sent by the client to `/api/ai/modify`, `/api/ai/enhance-prompt`, and `/api/lyria/generate`:

| Header | Carries |
|---|---|
| `x-ai-provider` | `gemini` or `openrouter` (from localStorage `ai_provider`) |
| `x-gemini-api-key` | Gemini key from localStorage `gemini_api_key` |
| `x-openrouter-api-key` | OpenRouter key from localStorage `openrouter_api_key` |

Server precedence: header value > env var (`AI_PROVIDER`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`) > default `gemini`. `.env.example` documents these plus `OPENROUTER_TEXT_MODEL` (default `google/gemini-3.5-flash`). Full request/response contract for the OpenRouter path (models, SSE audio parsing, the $0.50 balance gate) is in [03](03-api-integration.md#openrouter-second-provider--live-verified-2026-07-15).

## Cost by model/provider

| Path | Model | Cost |
|---|---|---|
| Gemini Pro | `lyria-3-pro-preview` | $0.08/song |
| Gemini Clip | `lyria-3-clip-preview` | $0.04/clip |
| OpenRouter Pro | `google/lyria-3-pro-preview` | $0.08/song |
| OpenRouter Clip | `google/lyria-3-clip-preview` | $0.04/clip |

OpenRouter requires ≥$0.50 account balance for any audio-output request, or it returns 402 before generating (no charge on the failed request).

## The event bus (wiring points)

All cross-component coordination uses window CustomEvents — extend these, don't lift state:

- `lyria-generated {count, payload}` — SidebarLeft fires this once per resolved generation request. `payload` is the `VersionPayload` returned by `generateVersion()` (`id`, `audioUrl`, `lyrics`, `model`, `format`, `provider`, optional `structure`) and is omitted for placeholder/no-op cases. CenterPanel appends a version tab per event, attaching `payload` fields to the new `Version` object when present; SidebarRight's history list also listens and prepends a real entry (deduped by id against the persisted library fetch).
- `lyria-request-generate` — fired by anything that wants a real generation without owning the GENERATE button's state: CenterPanel's `+` (new version) tab, SidebarRight's `generate`/`instrumental` tool actions, and inspector section actions (via `generateNewVersion`, after they've appended their directive with `lyria-prompt-append`). SidebarLeft listens and runs the same `handleGenerate` flow used by the GENERATE button.
- `lyria-active-version {n, audioUrl, format}` — CenterPanel fires this whenever `activeVersion` changes (switching tabs, or a new version becoming active after generation). `audioUrl`/`format` are `null` for placeholder versions with no generated audio. BottomBar listens and points the transport's singleton player at the new source, restarting playback if a version is swapped mid-play.
- `lyria-load-generation {payload}` — SidebarRight dispatches this when a HISTORY entry (from the persistent library, `GET /api/generations`) is clicked. `payload` is a full `GenerationEntry` (id, audioUrl, lyrics, format, model, provider, structure, prompt). CenterPanel listens: if a version tab with that id already exists it just switches to it, otherwise it materializes a new `Version` from the payload — either way, it never re-dispatches `lyria-generated`, since loading a past generation is not a new one and must not re-log into history or re-trigger the fresh-version pulse.
- `lyria-prompt-append {text}` — inspector/tools write prompt directives through this.
- `lyria-batch-change {count}`, `lyria-model-change {model}`, `lyria-duration-change {duration}` — chip state fan-out.
- `lyria-focus-lyrics` — opens/pins the lyrics editor.
- `lyria-action-start` / `lyria-action-end` — visualizer activity signal (orb speed/intensity); fire around any in-flight request.

## Prompt assembly

The request prompt is assembled server-side (`assembleLyriaPrompt` in `server/lyria.ts`) from: PROMPT box text + "Avoid:" exclusions + DUR target sentence + structure directives (accumulated from inspector actions) + LYRICS box content under its section tags + language instruction. The versions design doc and deep dive §23 define the per-generation manifest persisted alongside the audio (`generations/<id>.json`).

## Zero-fake-UI doctrine (supersedes the old theDAW stem/filetype constraint)

**2026-07-15: the previous constraint ("keep stem lanes / FLAC/STEMS / STEM EXPORT for theDAW") is revoked.** The new rule is: **the UI renders only elements backed by real data.** Nothing is drawn, toggled, or exported to imply a capability the app doesn't have. Concretely:

- The timeline shows exactly one **MASTER** lane, drawn from real decoded audio (see [Simulated vs. real, below](#whats-real-now)). There are no VOCALS/DRUMS/BASS/SYNTHS/PADS/OTHER stem lanes in the UI today.
- theDAW integration points still exist, but **dormant in the backend/data model, not visible in the UI** until real data exists: `Version.stems?: { name: string; audioUrl: string }[]` (see `src/components/CenterPanel.tsx`) — if a version's manifest ever carries a populated `stems` array, the timeline auto-renders one waveform sub-row per stem, keyed off that data. Until then (today, always — Lyria returns one mixed master), zero stem rows render.
- There is no STEM EXPORT tool and no FLAC/STEMS export chips. `ExportPanel` (`src/components/ExportPanel.tsx`) offers exactly WAV/MP3 — whichever is the server's actual native output format for the active version — and never claims to convert anything. The download is always the literal file `generateLyria` wrote to `generations/`.
- No SynthID mention in the UI (all outputs are watermarked regardless) — this part of the old direction stands.

If theDAW's backend eventually performs real stem separation and starts returning populated `stems[]` in the manifest, the UI already has the rendering path — no frontend change needed to light it up. Do not pre-build stem lanes, meters, or export formats ahead of that data existing.

## What's real now {#whats-real-now}

Generation is **real**: `POST /api/lyria/generate` (`server/lyria.ts`, wired into `server.ts`) assembles the prompt server-side, calls either the Gemini Interactions API or OpenRouter's chat completions endpoint (per [Provider selection](#provider-selection) above), and persists the audio + a manifest under `generations/`. The manifest JSON carries a `provider` field: `gemini | openrouter | mock`, and an optional `structure` field (Gemini's parsed `jsonBlocks`, when the response includes one). `LYRIA_MOCK=1` bypasses both providers and runs the full pipeline against a locally synthesized WAV instead — the dev-mode default, and how this doc's mapping above was verified end-to-end at $0.00.

Versions are no longer bare numbers: each `Version` object carries `id` / `audioUrl` / `lyrics` / `format` / `provider` / `structure` / optional `stems` once its generation resolves (seed versions 1–4 stay as data-less placeholders). The transport (BottomBar) plays whichever version is active via a singleton `HTMLAudioElement` (`src/lib/player.ts`), following `lyria-active-version`, and drives its stereo meters from a real WebAudio analyser graph (`MediaElementSource → ChannelSplitter → 2 AnalyserNodes`, `player.getLevels()`) — not a cosmetic animation. The timeline's MASTER waveform lane is real decoded audio too: `src/lib/waveformData.ts` fetches and decodes the active version's audio via `AudioContext.decodeAudioData`, extracts peak amplitudes, and caches them per URL; placeholder versions (no audio yet) render as a flat line, never a fake random shape.

EXPORT downloads the native generated file (WAV for Pro, MP3 for Clip) for the active version as-is — no format conversion, no fake formats. HISTORY (SidebarRight) is a **persistent library**: it fetches `GET /api/generations` on mount (every manifest on disk, newest-first) and also listens for live `lyria-generated` events, deduping by id; clicking any entry dispatches `lyria-load-generation` to activate that generation as a version tab. Delete/CLEAR in the History list are UI-only — the underlying generation files are never deleted (project rule: never delete files).

Nothing in the UI today is a stand-in for data that doesn't exist — the last remaining simulated pieces (fake stem lanes, fake LUFS/CPU/44.1kHz readouts, fake export delay/duration/location row, hardcoded hero stats, dead tool strips and view tabs) were removed in the 2026-07-15 standalone conversion, not merely left in place. If you find UI that renders a value with no backing state or API response, that's a bug — fix it or ask, don't add more of it.

The two text-only AI helper endpoints are otherwise unchanged in behavior: `/api/ai/modify` and `/api/ai/enhance-prompt` in `server.ts`, now routable to either provider (`gemini-3.5-flash` or OpenRouter's `OPENROUTER_TEXT_MODEL`) per [Provider selection](#provider-selection) above.
