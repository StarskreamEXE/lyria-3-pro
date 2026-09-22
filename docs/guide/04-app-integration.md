# 04 — App Integration Map

*How the frontend's concepts map onto the real Lyria 3 API. This is the contract for wiring the UI to real generation; for the user-facing version of the same ground, see the [User Guide](../USER_GUIDE.md).*

## The core mapping

| UI concept | API reality |
|---|---|
| GENERATE button | One generation request per version (`lyria-3-pro-preview` / `lyria-3-clip-preview` on Gemini, `google/…` equivalents on OpenRouter) |
| BATCH ×1/×2/×4 | N **parallel** requests (no `sample_count` on Lyria 3), each billed in full. The recorded count lands on every manifest as `batchCount` |
| Version tab (V1, V2 …) | One completed generation = one immutable artifact + manifest. Never "edited," only superseded. A new project has **no tabs at all**; the first real take is V1, and reopening a project does not renumber anything |
| PROMPT box | The whole technical-direction + exclusions + structure portion of the prompt (see [02](02-prompting-guide.md)). The server adds nothing to it |
| LYRICS box | Appended by the server as a `Lyrics (sing in <LANG>):` block. Sent only when VOCALS is on |
| VOCALS toggle (off) | No lyrics are sent at all, and `Instrumental only — no vocals.` is added to that request. The PROMPT box is left untouched |
| Language chip (EN…) | Names the language inside the server-side lyrics block; also recorded on the manifest as `language` |
| DUR chip (1:00/2:00/3:00) | Prompt-side **target only**, never a parameter — the model can overshoot or undershoot it. Recorded on the manifest as `durationTarget`. Disabled for Clip, which is fixed at ~0:30 |
| MODEL chip | Model id selection, and the price the cost readout quotes. It does **not** decide the export format — the real container is detected from the returned bytes |
| Track name field | Optional `title` on the request; written to the manifest and into the audio file's tags. Batch members get `(2)`, `(3)` suffixes |
| Settings → AI PROVIDER (GEMINI \| OPENROUTER) | Selects which backend `/api/ai/*` and `/api/lyria/generate` call; see [Provider selection](#provider-selection) below |
| IMAGE REFERENCES (≤10) | `image` parts (Gemini) / `image_url` data-URLs (OpenRouter) in the multimodal input array |
| ANALYZE button | `POST /api/ai/analyze` — a separate **paid** text call over the generation's real audio, run **only** when asked. Result is cached into that generation's manifest under `analysis` |
| Timeline sections | Purely analysis output. Until a version is analyzed, it has no sections |
| Inspector REGENERATE/EXTEND/RESTYLE/REPLACE | Writes a `[start - end] SECTION: directive` line **into the PROMPT box** (visible and undoable there), then queues a new full generation. Repeating the same action on the same section replaces its own previous line instead of stacking |
| LOCK SECTION | Writes a keep-as-is directive for that time range; UNLOCK removes exactly the line it added |
| INSTRUMENTAL tool | One generation with no lyrics and the instrumental directive scoped to that single request. The PROMPT box and the VOCALS toggle are untouched |
| CHANGE STYLE tool | Opens an input for a **user-typed** style instruction; on submit the line is appended to the PROMPT box and a new version is generated. Nothing is charged until an instruction is submitted |
| EDIT LYRICS tool | Pure UI: opens and pins the lyrics editor. No request |
| Cost readout under GENERATE | Real arithmetic: `$0.08 × N` Pro / `$0.04 × N` Clip, plus the live OpenRouter balance when the key can read it |
| EXPORT | Downloads the exact bytes on disk for the active version. No conversion, no format chooser. Disabled when the active version has no audio |

## Provider selection

Settings modal has an AI PROVIDER selector (`GEMINI` \| `OPENROUTER`, persisted to localStorage `ai_provider`) and an OpenRouter API key field (localStorage `openrouter_api_key`), alongside the Gemini key field (`gemini_api_key`). With nothing stored, the selector follows the server's own default.

**Both generation providers are paid and both have an entitlement requirement.** A Google key needs billing enabled: on the free tier Lyria's quota is 0 requests per day, and generation fails immediately with `429 Rate limit exceeded for model lyria-3-clip (limit: 0 requests per day on Free Tier)` — a configuration failure that retrying cannot clear. OpenRouter needs at least $0.50 of account credit for any audio request. The Gemini text helpers and analysis use a different quota and are unaffected. Details in [01 — Provider reality](01-lyria-models.md#provider-reality) and [03](03-api-integration.md#openrouter).

Request headers sent by the client to `/api/ai/modify`, `/api/ai/enhance-prompt`, `/api/ai/analyze` and `/api/lyria/generate`:

| Header | Carries |
|---|---|
| `x-ai-provider` | `gemini` or `openrouter` (from localStorage `ai_provider`) |
| `x-gemini-api-key` | Gemini key from localStorage `gemini_api_key` |
| `x-openrouter-api-key` | OpenRouter key from localStorage `openrouter_api_key` |

Server precedence: header value > env var (`AI_PROVIDER`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`) > default `gemini`. `.env.example` documents these plus `OPENROUTER_TEXT_MODEL` and `OPENROUTER_ANALYZE_MODEL` (both default `google/gemini-3.5-flash`). Full request/response contract for the OpenRouter path (models, SSE audio parsing, the $0.50 balance gate) is in [03](03-api-integration.md#openrouter).

## Cost by model/provider

| Path | Model | Cost |
|---|---|---|
| Gemini Pro | `lyria-3-pro-preview` | $0.08/song |
| Gemini Clip | `lyria-3-clip-preview` | $0.04/clip |
| OpenRouter Pro | `google/lyria-3-pro-preview` | $0.08/song |
| OpenRouter Clip | `google/lyria-3-clip-preview` | $0.04/clip |

Analysis and the two text helpers (wand, AUTO) are extra paid calls on top of this — small, not free. OpenRouter requires ≥$0.50 account balance for any audio-output request, or it returns 402 before generating (no charge on the failed request).

## The event bus (wiring points)

All cross-component coordination uses window CustomEvents — extend these, don't lift state:

- `lyria-generated {count, payload}` — SidebarLeft fires this once per resolved generation request. `payload` is the `VersionPayload` returned by `generateVersion()` (`id`, `audioUrl`, `lyrics`, `model`, `format`, `provider`, `title`, `durationSeconds`, optional `structure`). CenterPanel appends a version tab per event; SidebarRight's history list also listens and prepends a real entry (deduped by id against the persisted library fetch).
- `lyria-request-generate` — fired by anything that wants a real generation without owning the GENERATE button's state: CenterPanel's `+` (new version) tab, SidebarRight's `style`/`instrumental` tool actions, and inspector section actions (after they've written their directive). SidebarLeft listens and runs the same `handleGenerate` flow used by the GENERATE button.
- `lyria-active-version {n, audioUrl, format}` — CenterPanel fires this whenever `activeVersion` changes (switching tabs, or a new version becoming active after generation). `audioUrl`/`format` are `null` for a version with no audio. BottomBar listens and points the transport's singleton player at the new source.
- `lyria-transport-play` — fired by CenterPanel immediately **after** `lyria-active-version`, to auto-play a just-generated take once BottomBar has synchronously swapped the source.
- `lyria-load-generation {payload}` — SidebarRight dispatches this when a HISTORY entry (from the persistent library, `GET /api/generations`) is clicked. `payload` is a full `GenerationEntry`. CenterPanel listens: if a version tab with that id already exists it just switches to it, otherwise it materializes a new `Version` from the payload — either way it never re-dispatches `lyria-generated`, since loading a past generation is not a new one and must not re-log into history.
- `lyria-load-params {prompt?, lyrics?, model?, language?, durationTarget?, batchCount?}` — the **only** bus event that can REPLACE prompt text. Used by HISTORY's "Load with settings", the version tab's "Load settings from this version", and the inspector when it has to rewrite a directive line it previously wrote. Fields absent from an older manifest are left out entirely, so a load never resets a control to an invented default.
- `lyria-prompt-append {text}` — inspector/tools add prompt directives through this (append only).
- `lyria-request-analysis {id}` — a context menu asking the center panel to analyze that generation (paid).
- `lyria-analysis {id, analysis}` — CenterPanel broadcasting a completed analysis so other panels can pick it up.
- `lyria-generation-renamed {id, title}` — a rename committed in a version tab or a HISTORY row, so the other list stays in step.
- `lyria-project-load {project}` — `projectStore` announcing that a different project's state is now current.
- `lyria-provider-change {provider}` — Settings announcing a saved provider change, so cost/provider labels re-read it.
- `lyria-batch-change {count}`, `lyria-model-change {model}`, `lyria-duration-change {duration}` — chip state fan-out.
- `lyria-focus-lyrics` — opens/pins the lyrics editor.
- `lyria-action-start` / `lyria-action-end` — visualizer activity signal (orb speed/intensity); fire around any in-flight request.

(`lyria-generating` and `lyria-cascade-in` are CSS class names, not events.)

## Prompt assembly

`assembleLyriaPrompt` in `server/lyria.ts` builds the final request text from exactly three things:

1. The PROMPT box text, verbatim — including any "Avoid:" exclusions, structure blocks and section directives the user or the inspector put there.
2. For Pro only, one duration paragraph stating the target as a total running time plus an end timestamp (see [02 — Duration language](02-prompting-guide.md#duration-language)). Omitted for Clip.
3. The lyrics block, `Lyrics (sing in <LANG>):` followed by the LYRICS box, when lyrics were sent at all.

Nothing else is injected. An empty prompt is rejected before any provider call. The audio plus a manifest (`generations/<id>.json`) is then persisted; manifest fields are listed in [03 — Cost & batching](03-api-integration.md#cost--batching).

## Real-data-only UI

The rule is: **the UI renders only elements backed by real data.** Nothing is drawn, toggled, or exported to imply a capability the app doesn't have. Concretely:

- A brand-new project shows **no version tabs** — the timeline says so in words rather than drawing empty placeholder takes. Version numbers come from the project's own recorded version list, so a reload does not renumber anything.
- The timeline shows exactly one **MASTER** lane, drawn from real decoded audio. There are no VOCALS/DRUMS/BASS/SYNTHS/PADS/OTHER stem lanes in the UI today.
- Stem support exists in the data model only, **not visible in the UI** until real data exists: `Version.stems?: { name: string; audioUrl: string }[]` (see `src/components/CenterPanel.tsx`) — if a version's manifest ever carries a populated `stems` array, the timeline auto-renders one waveform sub-row per stem. Lyria returns one mixed master, so today zero stem rows render.
- Timeline sections exist only after a paid analysis of that version's real audio. An unanalyzed version shows no sections rather than a guessed arrangement, and BPM or key the analyzer could not identify are omitted rather than invented.
- There is no STEM EXPORT tool, no FLAC/STEMS chips, and **no export format chooser at all**. `ExportPanel` (`src/components/ExportPanel.tsx`) reports the real container of the file on disk and downloads that file unchanged; with no audio on the active version it reads `NO AUDIO YET` and the button is disabled.
- DURATION and MODEL in the center panel are the active version's own recorded values (measured file length, manifest model id). When a version records neither, they show a dash instead of borrowing the current chips.
- Lyrics shown in the inspector are the words the provider actually returned, with its structural/timing markup (`[[A0]]`, `[:]`, `[2.0:6.1]`) stripped by `src/lib/lyricsText.ts`. The raw text stays in the manifest; only the display is cleaned.
- No SynthID mention in the UI (all outputs are watermarked regardless).

If a backend ever performs real stem separation and starts returning populated `stems[]` in the manifest, the UI already has the rendering path — no frontend change needed to light it up. Do not pre-build stem lanes, meters, or export formats ahead of that data existing.

## What's real now

Generation is **real**: `POST /api/lyria/generate` (`server/lyria.ts`, wired into `server.ts`) assembles the prompt server-side, calls either the Gemini Interactions API or OpenRouter's chat completions endpoint (per [Provider selection](#provider-selection) above), and persists the audio + a manifest under `generations/`. The manifest carries `provider` (`gemini | openrouter | mock`), the **detected** `format`, the request's `language` / `durationTarget` / `batchCount`, an optional `title` / `durationSeconds` / `structure`, and any cached `analysis`. `LYRIA_MOCK=1` bypasses both providers and runs the full pipeline against a locally synthesized WAV instead, at no cost. Since the detected format drives the file extension, the manifest and EXPORT, the app never has to assume a container: OpenRouter delivers MP3 for Pro and Clip alike, whatever the request asked for.

Each `Version` object carries `id` / `audioUrl` / `lyrics` / `format` / `provider` / `title` / `structure` / optional `stems` once its generation resolves. The transport (BottomBar) plays whichever version is active via a singleton `HTMLAudioElement` (`src/lib/player.ts`), following `lyria-active-version`, and drives its stereo meters from a real WebAudio analyser graph (`MediaElementSource → ChannelSplitter → 2 AnalyserNodes`, `player.getLevels()`) — not a cosmetic animation. The timeline's MASTER waveform lane is real decoded audio too: `src/lib/waveformData.ts` fetches and decodes the active version's audio via `AudioContext.decodeAudioData`, extracts peak amplitudes, and caches them per URL; a version whose audio cannot be read renders as a flat line, never a fake random shape.

Analysis is **manual and paid**. It never runs automatically after a generation. `POST /api/ai/analyze` sends the generation's real audio to the selected provider's text model, which returns genre, mood, energy, BPM, key, instrumentation and timestamped section boundaries; the result is cached into the manifest so a generation is analyzed at most once. The detected sections are what the timeline and the section inspector are built on.

EXPORT downloads the native generated file for the active version as-is — no format conversion, no fake formats, no chooser — named after the track title and falling back to the generation id.

HISTORY (SidebarRight) is a **persistent library**: it fetches `GET /api/generations` on mount (every manifest on disk, newest-first) and also listens for live `lyria-generated` events, deduping by id; clicking an entry dispatches `lyria-load-generation`, and "Load with settings" additionally replays the recorded prompt/lyrics/model/language/duration/batch through `lyria-load-params`. "Remove from list" and CLEAR are **view-only and persistent**: the dismissed ids are stored per browser in localStorage (`lyria_hidden_generations`) so they stay hidden across reloads, a SHOW N HIDDEN control brings them all back, and **no audio file or manifest is ever deleted**.

Projects (`src/lib/projectStore.ts`, `server/projects.ts`) persist prompt, lyrics, settings and the version list per project; archiving moves a project file to `projects/archived/` rather than deleting it.

Nothing in the UI today is a stand-in for data that doesn't exist. If you find UI that renders a value with no backing state or API response, that's a bug.

The two text-only AI helper endpoints, `/api/ai/modify` and `/api/ai/enhance-prompt` in `server.ts`, are routable to either provider per [Provider selection](#provider-selection) above. Both are paid calls; a failed AUTO prompt enhancement cancels the generation rather than sending an un-enhanced prompt, so nothing is charged for the music request.
