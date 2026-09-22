# Lyria 3 Pro — Technical Deep Dive

**Model ID:** `lyria-3-pro-preview`  
**Status:** Preview  
**Reference material current as of:** July 15, 2026

---

## Read this first

This document is a technical reference for single-turn Lyria 3 generation. Most of it describes Google's documented contract. Three points below govern how you should write code against that contract, and they override any later passage that reads otherwise.

1. **You do not choose the container; you detect it.** Google documents a WAV response path for Pro (`response_format: { type: "audio" }`) and MP3 for Clip; OpenRouter returns **MP3 for both Pro and Clip**. Output is stereo 44.1 kHz either way. Because the container you get depends on the provider and can differ from the container you asked for, never name a file after the request. `detectAudioFormat` in `server/lyria.ts` reads the magic bytes, and that detected format — not the request — drives the file extension, the manifest `format` field, the metadata embedder and the duration math. Treat every `format: "wav"` in the code samples below as a *request*, and name the file you write from the bytes you received. (`LYRIA_MOCK=1` synthesizes a local WAV and never reaches a provider; mock takes say nothing about provider behavior.)

2. **Each provider has an entitlement precondition before any generation succeeds.** Google's free tier grants **zero Lyria requests per day**, so a free-tier key fails the generation request immediately with `429 Rate limit exceeded for model lyria-3-clip (limit: 0 requests per day on Free Tier)`. That is an entitlement wall, not congestion — no amount of backoff clears it, and a retry wrapper must special-case it. Gemini generation therefore requires a **billing-enabled** Google API key. OpenRouter requires account credits and refuses any audio request while the balance is under **$0.50**, returning `402` before generating, so a refused request is not billed. Gemini request/response details below are Google's documented contract.

3. **Duration is a prompt-side target, not a guarantee.** There is no duration parameter anywhere in the API. The requested length is written into the prompt text, and the model is free to miss it in either direction — a track can come back materially longer or shorter than asked. Timestamped structure improves adherence; nothing enforces it. Clip is fixed at roughly 30 seconds by the model and ignores the target entirely.

---

## 1. Core Specification

| Property | Lyria 3 Pro |
|---|---|
| Primary purpose | Full-length, structured song generation |
| API | Gemini Interactions API; OpenRouter chat-completions is the alternative route |
| JavaScript SDK | `@google/genai` 2.3.0+ |
| Python SDK | `google-genai` 2.3.0+ |
| Model ID | `lyria-3-pro-preview` (OpenRouter: `google/lyria-3-pro-preview`) |
| Typical duration | Approximately a couple of minutes |
| Duration control | Prompt- and timestamp-influenced only; no duration parameter, no guarantee — the returned length can miss the target in either direction |
| Input modalities | Text and images |
| Maximum images | Up to 10 |
| Uploaded audio input | Not documented |
| Output channels | Stereo |
| Sample rate | 44.1 kHz |
| Format on OpenRouter | MP3 for both Pro and Clip |
| Format documented by Google | WAV for Pro through `response_format`; MP3 for Clip — detect it from the bytes regardless |
| Vocals | Supported |
| Custom lyrics | Supported |
| Multilingual lyrics | Supported |
| Instrumental generation | Supported |
| Song structure prompting | Supported |
| Timestamp prompting | Supported |
| Price | $0.08 per successful Pro request |
| Free API tier | None — Google's free tier grants zero Lyria requests per day and answers with `429 ... limit: 0 requests per day on Free Tier`; OpenRouter needs credits (minimum $0.50 balance for audio) |
| Generation workflow | Single-turn |
| Watermarking | SynthID |
| Native stems | Not documented |
| Native MIDI | Not documented |
| Native section editing | Not documented |
| Seed control | Not documented |
| Deterministic repetition | Not supported |

---

## 2. What Lyria 3 Pro Generates

Lyria 3 Pro is intended for complete songs rather than short loops or continuous live streams. A generation can contain:

- Intro
- Verse
- Pre-chorus
- Chorus
- Bridge
- Breakdown
- Final chorus
- Outro
- Lead vocals
- Vocal harmonies
- User-provided or generated lyrics
- Full instrumental arrangement
- Dynamic and production changes across sections

The model returns a finished audio result rather than an editable internal project.

---

## 3. Prompt Controls

A Lyria 3 Pro prompt can specify:

- Genre and genre blends
- BPM or general tempo
- Key or scale
- Time-signature language
- Instrumentation
- Vocal range, character, and delivery
- Lyric language
- User-written lyrics
- Lyrical subject
- Instrumental-only output
- A target song duration (prompt-side only — there is no duration parameter and no guarantee)
- Section order
- Timestamped arrangement instructions
- Mood and atmosphere
- Energy curve
- Production style
- Dynamics
- Stereo-width language
- Arrangement density
- Image references

Strong prompts separate technical direction, structure, lyrics, and exclusions.

---

## 4. Recommended Prompt Structure

```text
Create a 2 minute 30 second industrial metalcore and electronic track.

Technical direction:
- 150 BPM
- D minor
- 4/4
- Low male baritone lead vocal
- Down-tuned rhythm guitars
- Distorted electronic bass
- Acoustic metal drums layered with processed percussion
- Dark, aggressive production
- Wide choruses and narrow, intimate verses

Avoid:
- Falsetto
- Bright pop vocals
- Orchestral strings
- Long ambient introduction
- Guitar solos

Structure:

[0:00 - 0:10] Intro
Filtered electronic percussion, distant guitar noise, and a short vocal pickup.

[0:10 - 0:38] Verse 1
Low baritone vocal. Restrained palm-muted guitars and sparse drums.

[0:38 - 0:54] Pre-Chorus
Increase drum activity and harmonic tension. Add layered backing vocals.

[0:54 - 1:22] Chorus
Full-width guitars, heavy drums, electronic bass, and stacked vocal harmonies.

[1:22 - 1:50] Verse 2
Return to a tighter arrangement with more rhythmic vocal phrasing.

[1:50 - 2:06] Breakdown
Half-time drums, syncopated guitar chugs, and sub-bass impacts. No lead vocal.

[2:06 - 2:30] Final Chorus and Outro
Larger final chorus followed by an abrupt final hit.
```

Timestamps guide the arrangement; they do not bind it. This is not merely a sample-level imprecision — the total running time itself is only a target, and the API has no duration parameter to enforce it, so a track can come back considerably longer or shorter than requested. State the running time explicitly and lay out the sections, then measure what you actually received.

---

## 5. Suggested Section Tags

```text
[Intro]
[Verse 1]
[Pre-Chorus]
[Chorus]
[Verse 2]
[Bridge]
[Breakdown]
[Final Chorus]
[Outro]
```

Custom labels can also be used when the musical role is clearly described.

---

## 6. JavaScript / TypeScript Setup

### Install

```bash
npm install @google/genai@^2.3.0
npm install --save-dev typescript tsx @types/node
```

### Set the API key

```bash
# macOS / Linux
export GEMINI_API_KEY="your-key"
```

```powershell
# PowerShell
$env:GEMINI_API_KEY="your-key"
```

---

## 7. Minimal TypeScript Generation

```typescript
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not set.");
}

const ai = new GoogleGenAI({ apiKey });

const result = await ai.interactions.create({
  model: "lyria-3-pro-preview",
  input: `
    Create a 2-minute dark electronic rock song.

    - 132 BPM
    - D minor
    - Low male baritone
    - Heavy electronic bass
    - Layered guitars
    - No falsetto

    [0:00 - 0:15] Intro
    [0:15 - 0:45] Verse
    [0:45 - 1:10] Chorus
    [1:10 - 1:35] Verse 2
    [1:35 - 1:50] Breakdown
    [1:50 - 2:00] Final chorus and ending
  `,
  // Google-documented WAV request path for Pro. It is a request, not a promise:
  // the container you receive depends on the provider. Detect it from the bytes.
  response_format: {
    type: "audio",
  },
  store: false,
});

if (!result.output_audio?.data) {
  throw new Error("No audio returned.");
}

const audio = Buffer.from(result.output_audio.data, "base64");

// Name the file after the bytes you received, never after the format you asked for.
const isWav =
  audio.length >= 12 &&
  audio.toString("ascii", 0, 4) === "RIFF" &&
  audio.toString("ascii", 8, 12) === "WAVE";

fs.writeFileSync(`lyria-song.${isWav ? "wav" : "mp3"}`, audio);

console.log(result.output_text);
```

`server/lyria.ts` ships the full version of that check as `detectAudioFormat`, which also recognizes a bare MPEG frame sync and an `ID3` tag, and returns `"unknown"` rather than guessing.

---

## 8. Production TypeScript Generator

The `format` option below is a **request**, not a result. Providers do not reliably honor it — OpenRouter returns MP3 for both Pro and Clip regardless of what was asked for — so the generator detects the container from the returned bytes and uses the detected value for the file extension and the manifest. This mirrors `detectAudioFormat` / `generateLyria` in `server/lyria.ts`.

```typescript
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";

const MODEL_ID = "lyria-3-pro-preview";
const MAX_IMAGES = 10;

type OutputFormat = "mp3" | "wav";

interface ImageInput {
  path: string;
  mimeType?: string;
}

interface GenerateLyriaOptions {
  prompt: string;
  outputDirectory: string;
  basename?: string;
  /** Requested container only. The bytes decide what is actually written. */
  format?: OutputFormat;
  images?: ImageInput[];
  storeInteraction?: boolean;
}

interface ParsedLyriaResponse {
  interactionId?: string;
  audio: Buffer;
  textBlocks: string[];
  jsonBlocks: unknown[];
  rawTextBlocks: string[];
}

/**
 * Detects the real container from magic bytes: RIFF/WAVE, an ID3v2 tag, or a bare
 * MPEG frame sync. Returns "unknown" rather than guessing. Full version in
 * server/lyria.ts.
 */
function detectAudioFormat(buf: Buffer): OutputFormat | "unknown" {
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE"
  ) {
    return "wav";
  }

  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3") {
    return "mp3";
  }

  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return "mp3";
  }

  return "unknown";
}

function inferImageMimeType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();

  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      throw new Error(`Unsupported image extension: ${extension}`);
  }
}

async function createInput(
  prompt: string,
  images: ImageInput[],
): Promise<string | Array<Record<string, string>>> {
  if (images.length === 0) {
    return prompt;
  }

  if (images.length > MAX_IMAGES) {
    throw new Error(
      `Lyria 3 accepts at most ${MAX_IMAGES} images; received ${images.length}.`,
    );
  }

  const input: Array<Record<string, string>> = [
    {
      type: "text",
      text: prompt,
    },
  ];

  for (const image of images) {
    const bytes = await fs.readFile(image.path);

    input.push({
      type: "image",
      mime_type: image.mimeType ?? inferImageMimeType(image.path),
      data: bytes.toString("base64"),
    });
  }

  return input;
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();

  const looksLikeObject =
    trimmed.startsWith("{") && trimmed.endsWith("}");

  const looksLikeArray =
    trimmed.startsWith("[") && trimmed.endsWith("]");

  if (!looksLikeObject && !looksLikeArray) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parseInteraction(interaction: any): ParsedLyriaResponse {
  const textBlocks: string[] = [];
  const rawTextBlocks: string[] = [];
  const jsonBlocks: unknown[] = [];
  const audioBlocks: Buffer[] = [];

  for (const step of interaction.steps ?? []) {
    if (step?.type !== "model_output") {
      continue;
    }

    for (const contentBlock of step.content ?? []) {
      if (contentBlock?.type === "audio" && contentBlock.data) {
        audioBlocks.push(
          Buffer.from(contentBlock.data, "base64"),
        );
        continue;
      }

      if (contentBlock?.type === "text" && contentBlock.text) {
        const text = String(contentBlock.text);
        rawTextBlocks.push(text);

        const parsedJson = tryParseJson(text);

        if (parsedJson !== undefined) {
          jsonBlocks.push(parsedJson);
        } else {
          textBlocks.push(text);
        }
      }
    }
  }

  if (audioBlocks.length === 0 && interaction.output_audio?.data) {
    audioBlocks.push(
      Buffer.from(interaction.output_audio.data, "base64"),
    );
  }

  if (
    rawTextBlocks.length === 0 &&
    typeof interaction.output_text === "string"
  ) {
    const text = interaction.output_text;
    rawTextBlocks.push(text);

    const parsedJson = tryParseJson(text);

    if (parsedJson !== undefined) {
      jsonBlocks.push(parsedJson);
    } else {
      textBlocks.push(text);
    }
  }

  if (audioBlocks.length === 0) {
    throw new Error("Lyria returned no audio block.");
  }

  return {
    interactionId: interaction.id,
    audio: Buffer.concat(audioBlocks),
    textBlocks,
    jsonBlocks,
    rawTextBlocks,
  };
}

export async function generateLyriaPro(
  options: GenerateLyriaOptions,
): Promise<ParsedLyriaResponse> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set.");
  }

  const {
    prompt,
    outputDirectory,
    basename = `lyria-${Date.now()}`,
    format = "wav",
    images = [],
    storeInteraction = false,
  } = options;

  if (!prompt.trim()) {
    throw new Error("Prompt cannot be empty.");
  }

  const client = new GoogleGenAI({ apiKey });
  const input = await createInput(prompt, images);

  const request: Record<string, unknown> = {
    model: MODEL_ID,
    input,
    store: storeInteraction,
  };

  // Google-documented WAV request path (Pro only). A request, not a promise.
  if (format === "wav") {
    request.response_format = {
      type: "audio",
    };
  }

  const interaction = await client.interactions.create(
    request as any,
  );

  const result = parseInteraction(interaction);

  // The requested `format` was only a hint. Trust the bytes; fall back to the
  // request only when the container is unidentifiable.
  const detectedFormat = detectAudioFormat(result.audio);

  const actualFormat: OutputFormat =
    detectedFormat === "unknown" ? format : detectedFormat;

  await fs.mkdir(outputDirectory, {
    recursive: true,
  });

  const audioPath = path.join(
    outputDirectory,
    `${basename}.${actualFormat}`,
  );

  const textPath = path.join(
    outputDirectory,
    `${basename}.txt`,
  );

  const manifestPath = path.join(
    outputDirectory,
    `${basename}.json`,
  );

  await fs.writeFile(audioPath, result.audio);

  await fs.writeFile(
    textPath,
    result.rawTextBlocks.join("\n\n---\n\n"),
    "utf8",
  );

  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        model: MODEL_ID,
        interactionId: result.interactionId,
        format: actualFormat,
        requestedFormat: format,
        prompt,
        images: images.map((image) => ({
          filename: path.basename(image.path),
          mimeType:
            image.mimeType ??
            inferImageMimeType(image.path),
        })),
        textBlocks: result.textBlocks,
        structuredBlocks: result.jsonBlocks,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`Audio: ${audioPath}`);
  console.log(`Text: ${textPath}`);
  console.log(`Manifest: ${manifestPath}`);

  return result;
}
```

---

## 9. TypeScript Usage Example

```typescript
import { generateLyriaPro } from "./lyria-pro.js";

const prompt = `
Create a 2 minute 20 second dark electronic metal song.

Musical specification:
- 145 BPM
- C minor
- Low male baritone
- Heavy syncopated guitars
- Distorted synth bass
- Industrial percussion
- Large melodic chorus
- No falsetto
- No guitar solo

[0:00 - 0:12] Intro
Mechanical percussion and filtered guitar texture.

[0:12 - 0:42] Verse 1
Low intimate vocal over restrained drums.

[0:42 - 1:08] Chorus
Full guitars, wide vocal harmonies, and heavy electronic bass.

[1:08 - 1:38] Verse 2
More aggressive rhythm with additional percussion.

[1:38 - 1:58] Breakdown
Half-time rhythm and syncopated guitar hits. Instrumental.

[1:58 - 2:20] Final Chorus
Largest arrangement, followed by an abrupt ending.
`;

await generateLyriaPro({
  prompt,
  outputDirectory: "./generations",
  basename: "industrial-metal-test-01",
  format: "wav", // requested only — OpenRouter returns MP3; the file is named from the bytes
  storeInteraction: false,
});
```

---

## 10. Image-to-Music Example

```typescript
await generateLyriaPro({
  prompt: `
    Compose a 2-minute instrumental soundtrack inspired by these images.

    Interpret:
    - Color palette as harmonic mood
    - Visual density as arrangement density
    - Lighting as brightness and timbre
    - Perceived movement as rhythmic intensity

    Use dark analog synthesizers, processed piano,
    deep percussion, and gradually increasing tension.

    Instrumental only.
  `,
  images: [
    {
      path: "./references/architecture.jpg",
    },
    {
      path: "./references/night-lighting.png",
    },
  ],
  outputDirectory: "./generations",
  basename: "visual-score-01",
  format: "wav", // requested only — OpenRouter returns MP3; the file is named from the bytes
});
```

Images provide creative context. They are not treated as audio references.

---

## 11. Custom Lyrics Example

```typescript
const lyricsPrompt = `
Create a dark electronic rock song in D minor at 132 BPM.

Vocal direction:
- Low male baritone
- Restrained verses
- Layered chorus harmonies
- Clear pronunciation
- No high falsetto notes

Use the following lyrics exactly where practical:

[Verse 1]
Static running underneath the floor
Every signal points me to the door
I can hear the machinery breathe
Building something no one else can see

[Pre-Chorus]
Hold the line
Let the voltage climb

[Chorus]
We are moving through the interference
Turning every fracture into evidence
Nothing in the signal disappears
We become the sound that no one hears

[Bridge]
Strip the arrangement to bass, percussion, and whispered vocals.
Gradually rebuild into the final chorus.
`;

await generateLyriaPro({
  prompt: lyricsPrompt,
  outputDirectory: "./generations",
  basename: "custom-lyrics-01",
  format: "wav", // requested only — OpenRouter returns MP3; the file is named from the bytes
});
```

---

## 12. Python Setup

```bash
pip install "google-genai>=2.3.0"
```

---

## 13. Production Python Generator

As in §8, `output_format` is a **request**. The generator below detects the real container from the returned bytes and writes the file under the detected extension.

```python
from __future__ import annotations

import base64
import json
import mimetypes
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from google import genai

MODEL_ID = "lyria-3-pro-preview"
MAX_IMAGES = 10

OutputFormat = Literal["mp3", "wav"]


@dataclass
class ImageInput:
    path: Path
    mime_type: str | None = None


@dataclass
class LyriaResult:
    interaction_id: str | None
    audio: bytes
    text_blocks: list[str]
    json_blocks: list[Any]
    raw_text_blocks: list[str]


def encode_images(
    prompt: str,
    images: list[ImageInput],
) -> str | list[dict[str, str]]:
    if not images:
        return prompt

    if len(images) > MAX_IMAGES:
        raise ValueError(
            f"Lyria 3 accepts at most {MAX_IMAGES} images; "
            f"received {len(images)}."
        )

    parts: list[dict[str, str]] = [
        {
            "type": "text",
            "text": prompt,
        }
    ]

    for image in images:
        if not image.path.exists():
            raise FileNotFoundError(image.path)

        mime_type = image.mime_type

        if mime_type is None:
            mime_type, _ = mimetypes.guess_type(
                image.path.name,
            )

        if mime_type is None or not mime_type.startswith("image/"):
            raise ValueError(
                f"Could not determine image MIME type: {image.path}"
            )

        encoded = base64.b64encode(
            image.path.read_bytes()
        ).decode("utf-8")

        parts.append(
            {
                "type": "image",
                "mime_type": mime_type,
                "data": encoded,
            }
        )

    return parts


def detect_audio_format(data: bytes) -> str:
    """Detects the real container from magic bytes; returns 'wav', 'mp3' or 'unknown'."""
    if len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"

    if data[0:3] == b"ID3":
        return "mp3"

    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return "mp3"

    return "unknown"


def try_parse_json(text: str) -> Any | None:
    stripped = text.strip()

    looks_like_object = (
        stripped.startswith("{") and stripped.endswith("}")
    )

    looks_like_array = (
        stripped.startswith("[") and stripped.endswith("]")
    )

    if not looks_like_object and not looks_like_array:
        return None

    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return None


def parse_interaction(interaction: Any) -> LyriaResult:
    audio_blocks: list[bytes] = []
    text_blocks: list[str] = []
    json_blocks: list[Any] = []
    raw_text_blocks: list[str] = []

    for step in getattr(interaction, "steps", []) or []:
        if getattr(step, "type", None) != "model_output":
            continue

        for block in getattr(step, "content", []) or []:
            block_type = getattr(block, "type", None)

            if block_type == "audio":
                encoded = getattr(block, "data", None)

                if encoded:
                    audio_blocks.append(
                        base64.b64decode(encoded)
                    )

            elif block_type == "text":
                text = getattr(block, "text", None)

                if not text:
                    continue

                raw_text_blocks.append(text)
                parsed = try_parse_json(text)

                if parsed is None:
                    text_blocks.append(text)
                else:
                    json_blocks.append(parsed)

    if not audio_blocks:
        generated_audio = getattr(
            interaction,
            "output_audio",
            None,
        )

        encoded = getattr(
            generated_audio,
            "data",
            None,
        )

        if encoded:
            audio_blocks.append(
                base64.b64decode(encoded)
            )

    if not raw_text_blocks:
        output_text = getattr(
            interaction,
            "output_text",
            None,
        )

        if output_text:
            raw_text_blocks.append(output_text)
            parsed = try_parse_json(output_text)

            if parsed is None:
                text_blocks.append(output_text)
            else:
                json_blocks.append(parsed)

    if not audio_blocks:
        raise RuntimeError("Lyria returned no audio.")

    return LyriaResult(
        interaction_id=getattr(
            interaction,
            "id",
            None,
        ),
        audio=b"".join(audio_blocks),
        text_blocks=text_blocks,
        json_blocks=json_blocks,
        raw_text_blocks=raw_text_blocks,
    )


def generate_lyria_pro(
    prompt: str,
    output_directory: Path,
    basename: str | None = None,
    output_format: OutputFormat = "wav",
    images: list[ImageInput] | None = None,
    store_interaction: bool = False,
) -> LyriaResult:
    if not os.environ.get("GEMINI_API_KEY"):
        raise RuntimeError("GEMINI_API_KEY is not set.")

    if not prompt.strip():
        raise ValueError("Prompt cannot be empty.")

    images = images or []
    basename = basename or f"lyria-{int(time.time())}"

    client = genai.Client()
    input_data = encode_images(prompt, images)

    request: dict[str, Any] = {
        "model": MODEL_ID,
        "input": input_data,
        "store": store_interaction,
    }

    # Google-documented WAV request path (Pro only). A request, not a promise.
    if output_format == "wav":
        request["response_format"] = {
            "type": "audio",
        }

    interaction = client.interactions.create(**request)
    result = parse_interaction(interaction)

    # The request was only a hint. Trust the bytes; fall back to the request
    # only when the container is unidentifiable.
    detected_format = detect_audio_format(result.audio)

    actual_format = (
        output_format if detected_format == "unknown" else detected_format
    )

    output_directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    audio_path = (
        output_directory /
        f"{basename}.{actual_format}"
    )

    text_path = (
        output_directory /
        f"{basename}.txt"
    )

    manifest_path = (
        output_directory /
        f"{basename}.json"
    )

    audio_path.write_bytes(result.audio)

    text_path.write_text(
        "\n\n---\n\n".join(result.raw_text_blocks),
        encoding="utf-8",
    )

    manifest = {
        "model": MODEL_ID,
        "interaction_id": result.interaction_id,
        "format": actual_format,
        "requested_format": output_format,
        "prompt": prompt,
        "images": [
            {
                "filename": image.path.name,
                "mime_type": image.mime_type,
            }
            for image in images
        ],
        "text_blocks": result.text_blocks,
        "structured_blocks": result.json_blocks,
    }

    manifest_path.write_text(
        json.dumps(
            manifest,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print(f"Audio: {audio_path}")
    print(f"Text: {text_path}")
    print(f"Manifest: {manifest_path}")

    return result
```

---

## 14. Python Usage Example

```python
from pathlib import Path

prompt = """
Create a 2-minute cinematic electronic instrumental.

- 110 BPM
- A minor
- Granular piano
- Analog synthesizers
- Deep acoustic percussion
- Slow tension build
- No vocals

[0:00 - 0:20] Sparse introduction
[0:20 - 0:55] Establish the main motif
[0:55 - 1:25] Add percussion and bass
[1:25 - 1:50] Full climax
[1:50 - 2:00] Short unresolved outro
"""

generate_lyria_pro(
    prompt=prompt,
    output_directory=Path("./generations"),
    basename="cinematic-electronic-01",
    output_format="wav",  # requested only — OpenRouter returns MP3
    store_interaction=False,
)
```

---

## 15. Raw REST Request

Google's documented contract. This endpoint returns audio only for a billing-enabled key: a free-tier key answers `429 Rate limit exceeded for model lyria-3-clip (limit: 0 requests per day on Free Tier)`, which is an entitlement wall rather than a transient limit. The `response_format` block below is Google's documented WAV request path — treat it as a request and detect the container from the returned bytes.

```bash
curl -X POST \
  "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -d '{
    "model": "lyria-3-pro-preview",
    "input": "Create a 2-minute instrumental industrial electronic track in D minor at 128 BPM. Use distorted synthesizer bass, metallic percussion and dark atmospheric pads. Instrumental only.",
    "response_format": {
      "type": "audio"
    },
    "store": false
  }' > response.json
```

---

## 16. Extract Audio with `jq`

```bash
jq -r '
  .steps[]
  | select(.type == "model_output")
  | .content[]
  | select(.type == "audio")
  | .data
' response.json | base64 -d > song.out
```

Name the output after the bytes, not after the format you requested — check with `file song.out` (or the first four bytes) and rename to `.mp3` or `.wav` accordingly.

---

## 17. Extract Text and Metadata

```bash
jq -r '
  .steps[]
  | select(.type == "model_output")
  | .content[]
  | select(.type == "text")
  | .text
' response.json > song-metadata.txt
```

---

## 18. Retry Wrapper

```typescript
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getHttpStatus(
  error: unknown,
): number | undefined {
  if (
    typeof error !== "object" ||
    error === null
  ) {
    return undefined;
  }

  const value = error as Record<string, any>;

  return (
    value.status ??
    value.statusCode ??
    value.code ??
    value.response?.status
  );
}

function isRetryableStatus(
  status: number | undefined,
): boolean {
  if (status === undefined) {
    return false;
  }

  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  maximumAttempts = 5,
): Promise<T> {
  let finalError: unknown;

  for (
    let attempt = 1;
    attempt <= maximumAttempts;
    attempt++
  ) {
    try {
      return await operation();
    } catch (error) {
      finalError = error;

      const status = getHttpStatus(error);

      if (
        attempt === maximumAttempts ||
        !isRetryableStatus(status)
      ) {
        throw error;
      }

      const baseDelay =
        1_000 * 2 ** (attempt - 1);

      const jitter =
        Math.floor(Math.random() * 500);

      const delay =
        Math.min(
          baseDelay + jitter,
          30_000,
        );

      console.warn(
        `Lyria request failed with status ${status}. ` +
        `Retrying after ${delay} ms.`,
      );

      await sleep(delay);
    }
  }

  throw finalError;
}
```

Usage:

```typescript
const result = await withRetry(() =>
  generateLyriaPro({
    prompt,
    outputDirectory: "./generations",
    basename: "retry-test",
    format: "wav", // requested only — OpenRouter returns MP3
  }),
);
```

---

## 19. Response Parsing

Production code should inspect every model-output step rather than relying only on convenience properties.

Expected conceptual structure:

```text
interaction
├── id
├── output_audio
├── output_text
└── steps[]
    └── model_output
        └── content[]
            ├── audio
            │   └── data: base64
            └── text
                └── lyrics or structural metadata
```

Recommended stored manifest:

```json
{
  "model": "lyria-3-pro-preview",
  "interaction_id": "{{ INTERACTION_ID }}",
  "prompt": "{{ ORIGINAL_PROMPT }}",
  "format": "{{ DETECTED_FORMAT }}",
  "requested_format": "{{ REQUESTED_FORMAT }}",
  "generated_at": "{{ ISO_TIMESTAMP }}",
  "audio_path": "{{ AUDIO_PATH }}",
  "lyrics": "{{ RETURNED_LYRICS }}",
  "structure": "{{ RETURNED_STRUCTURE }}",
  "image_inputs": [],
  "request_version": 1
}
```

`format` records what the bytes turned out to be (`mp3` on OpenRouter). Keep the requested value in a separate field if you want it at all; never let it stand in for the real container.

---

## 20. Error Handling

| Status | Meaning | Action |
|---|---|---|
| `400` | Invalid request | Fix request shape or input |
| `401` | Invalid authentication | Check API key |
| `403` | Access or permission failure | Check project and model access |
| `408` | Request timeout | Retry |
| `429` | Rate limit **or** quota/entitlement wall | Retry with backoff only if it is a real rate limit — see below |
| `500` | Server failure | Retry |
| `502` | Upstream failure | Retry |
| `503` | Service unavailable | Retry |
| `504` | Gateway timeout | Retry |

Do not repeatedly retry malformed prompts, invalid image data, or permission failures.

**Not every 429 is retryable.** Google's free tier answers Lyria generation with:

```text
429 Rate limit exceeded for model lyria-3-clip (limit: 0 requests per day on Free Tier)
```

A per-day limit of zero is an entitlement wall, not congestion. No amount of backoff clears it; the fix is a billing-enabled key, or a provider that will serve the model. The retry wrapper in §18 treats 429 as retryable by design, so inspect the message before handing a request to it and surface this case to the user as a configuration problem. Any Gemini generation attempt made with a free-tier key hits exactly this failure.

---

## 21. Native Limitations

Lyria 3 Pro currently does not document native support for:

- Uploaded audio conditioning
- Uploaded-song continuation
- Audio-to-audio transformation
- Native stem output
- Native MIDI output
- Native chord output
- Seed control
- Multiple candidates in one request
- Native section replacement
- Native audio inpainting
- Follow-up editing
- Conversation-based refinement
- Continuous streaming
- Any duration guarantee at all — not merely sample-exact: there is no duration parameter, and the prompt-side target can be missed by a wide margin in either direction
- A choice of output container — you receive whatever the provider encodes (MP3 for both models on OpenRouter)
- Exact reproducibility
- Guaranteed lyric adherence
- Guaranteed structural timing
- SynthID-free output

Every request should be treated as a new complete generation.

---

## 22. Prompting Recommendations

### Explicit musical language

```text
132 BPM, D minor, low male baritone, distorted synth bass,
down-tuned guitars, half-time breakdown, wide layered chorus
```

### Explicit exclusions

```text
No falsetto.
No guitar solo.
No orchestral strings.
No long ambient intro.
No major-key resolution.
```

### Separate lyrics from instructions

```text
Production direction:
- Dark electronic rock
- 128 BPM
- C minor

Lyrics:

[Verse]
...

[Chorus]
...
```

### Describe energy changes

```text
Begin sparse and intimate.
Increase rhythmic density through the pre-chorus.
Open into a wide full-spectrum chorus.
Collapse into a half-time breakdown.
Return with the largest final chorus.
```

### Describe vocals precisely

```text
Low male baritone.
Close-mic intimate verse delivery.
Controlled grit in the chorus.
No falsetto or high-register leaps.
Layered octave doubles only in the final chorus.
```

---

## 23. Suggested Generation Manifest

```json
{
  "model": "lyria-3-pro-preview",
  "prompt_version": 3,
  "prompt_hash": "{{ SHA256 }}",
  "interaction_id": "{{ INTERACTION_ID }}",
  "detected_format": "{{ DETECTED_FORMAT }}",
  "request": {
    "format": "{{ REQUESTED_FORMAT }}",
    "store": false,
    "images": []
  },
  "musical_target": {
    "duration_seconds": 150,
    "bpm": 150,
    "key": "D minor",
    "time_signature": "4/4",
    "vocal_type": "low male baritone",
    "instrumental": false
  },
  "structure": [
    {
      "name": "Intro",
      "start": 0,
      "end": 10
    },
    {
      "name": "Verse 1",
      "start": 10,
      "end": 38
    },
    {
      "name": "Pre-Chorus",
      "start": 38,
      "end": 54
    },
    {
      "name": "Chorus",
      "start": 54,
      "end": 82
    }
  ],
  "outputs": {
    "audio": "{{ AUDIO_PATH }}",
    "text": "{{ TEXT_PATH }}",
    "metadata": "{{ METADATA_PATH }}"
  }
}
```

`musical_target.duration_seconds` is exactly that — a target. Record the measured length separately, from the file.

### What this app actually persists

The shipped schema is `GenerationManifest` in `server/lyria.ts`, written to `generations/<id>.json`. Always present: `id`, `model`, `format` (detected from the bytes, never the request), `provider` (`gemini | openrouter | mock`), `prompt`, `lyrics`, `generatedAt`. Written only when they apply: `interactionId`, `structure`, `analysis`, `title`, `durationSeconds`, and the recorded request settings `language`, `durationTarget` and `batchCount`.

- `language`, `durationTarget` and `batchCount` capture what the user asked for so the History pane can restore the settings later. They are written **only when the request supplied a usable value** — never defaulted — so manifests predating the fields simply lack them. Every consumer must treat all three as optional and absent, rather than substituting a default.
- `durationSeconds` is a real measurement, parsed from the file itself: the RIFF `fmt`/`data` chunks for WAV, and the MPEG frame stream (Xing/Info or VBRI frame count, else a full frame walk) for MP3. Since OpenRouter output is MP3, the MP3 path is the one that runs most often. Bytes that will not parse leave the field undefined rather than being estimated; the only fallback is the Clip model's fixed 30 seconds. Older manifests are backfilled lazily on the next listing.
- `analysis` is filled in only when the user explicitly runs analysis (`POST /api/ai/analyze`), which is an additional paid model call on top of generation. **Nothing analyses automatically after a generation.** The result is cached into the manifest, so a given generation is analyzed once unless the caller forces a refresh.

---

## 24. Official Documentation

- Music generation documentation:  
  `https://ai.google.dev/gemini-api/docs/music-generation`

- Interactions API overview:  
  `https://ai.google.dev/gemini-api/docs/interactions-overview`

- Pricing:  
  `https://ai.google.dev/gemini-api/docs/pricing`

- Troubleshooting:  
  `https://ai.google.dev/gemini-api/docs/troubleshooting`

---

## 25. Summary

Lyria 3 Pro is a single-turn, full-song music-generation model that accepts text and image input and produces stereo 44.1 kHz audio with vocals, lyrics, and multi-section arrangements. On OpenRouter that audio arrives as **MP3** for both Pro and Clip; Google documents a WAV response path for Pro. Either way, detect the container from the returned bytes rather than assuming the one you requested. Generation requires an entitled key on whichever provider you choose: a billing-enabled Google key (the free tier grants zero Lyria requests per day), or an OpenRouter account with at least a $0.50 balance.

Its strongest documented controls are:

- Explicit musical prompting
- Named song sections
- Timestamped arrangement plans
- Custom lyrics
- Vocal direction
- Instrumentation
- BPM and key language
- A prompt-side duration target (best-effort, never binding)
- Image-based creative context

Its principal limitations are:

- No native post-generation editing
- No native stems
- No native MIDI
- No audio-reference conditioning
- No deterministic seed
- No duration guarantee of any kind, and no duration parameter
- No control over the output container — detect it from the bytes
- No continuous streaming
