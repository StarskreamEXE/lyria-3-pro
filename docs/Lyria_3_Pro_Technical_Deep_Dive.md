# Lyria 3 Pro — Technical Deep Dive

**Model ID:** `lyria-3-pro-preview`  
**Status:** Preview  
**Current as of:** July 15, 2026

---

## 1. Core Specification

| Property | Lyria 3 Pro |
|---|---|
| Primary purpose | Full-length, structured song generation |
| API | Gemini Interactions API |
| JavaScript SDK | `@google/genai` 2.3.0+ |
| Python SDK | `google-genai` 2.3.0+ |
| Model ID | `lyria-3-pro-preview` |
| Typical duration | Approximately a couple of minutes |
| Duration control | Prompt- and timestamp-influenced, not sample-exact |
| Input modalities | Text and images |
| Maximum images | Up to 10 |
| Uploaded audio input | Not documented |
| Output channels | Stereo |
| Sample rate | 44.1 kHz |
| Default format | MP3 |
| Optional format | WAV through `response_format` |
| Vocals | Supported |
| Custom lyrics | Supported |
| Multilingual lyrics | Supported |
| Instrumental generation | Supported |
| Song structure prompting | Supported |
| Timestamp prompting | Supported |
| Price | $0.08 per successful Pro request |
| Free API tier | Not listed |
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
- Approximate song duration
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

Timestamps guide the arrangement but do not guarantee exact sample-level boundaries.

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
  response_format: {
    type: "audio",
  },
  store: false,
});

if (!result.output_audio?.data) {
  throw new Error("No audio returned.");
}

fs.writeFileSync(
  "lyria-song.wav",
  Buffer.from(result.output_audio.data, "base64"),
);

console.log(result.output_text);
```

---

## 8. Production TypeScript Generator

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

  if (format === "wav") {
    request.response_format = {
      type: "audio",
    };
  }

  const interaction = await client.interactions.create(
    request as any,
  );

  const result = parseInteraction(interaction);

  await fs.mkdir(outputDirectory, {
    recursive: true,
  });

  const audioPath = path.join(
    outputDirectory,
    `${basename}.${format}`,
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
        format,
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
  format: "wav",
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
  format: "wav",
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
  format: "wav",
});
```

---

## 12. Python Setup

```bash
pip install "google-genai>=2.3.0"
```

---

## 13. Production Python Generator

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

    if output_format == "wav":
        request["response_format"] = {
            "type": "audio",
        }

    interaction = client.interactions.create(**request)
    result = parse_interaction(interaction)

    output_directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    audio_path = (
        output_directory /
        f"{basename}.{output_format}"
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
        "format": output_format,
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
    output_format="wav",
    store_interaction=False,
)
```

---

## 15. Raw REST Request

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
' response.json | base64 -d > song.wav
```

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
    format: "wav",
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
  "format": "wav",
  "generated_at": "{{ ISO_TIMESTAMP }}",
  "audio_path": "{{ AUDIO_PATH }}",
  "lyrics": "{{ RETURNED_LYRICS }}",
  "structure": "{{ RETURNED_STRUCTURE }}",
  "image_inputs": [],
  "request_version": 1
}
```

---

## 20. Error Handling

| Status | Meaning | Action |
|---|---|---|
| `400` | Invalid request | Fix request shape or input |
| `401` | Invalid authentication | Check API key |
| `403` | Access or permission failure | Check project and model access |
| `408` | Request timeout | Retry |
| `429` | Rate limit or quota exhaustion | Retry with backoff |
| `500` | Server failure | Retry |
| `502` | Upstream failure | Retry |
| `503` | Service unavailable | Retry |
| `504` | Gateway timeout | Retry |

Do not repeatedly retry malformed prompts, invalid image data, or permission failures.

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
- Sample-exact duration
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
  "request": {
    "format": "wav",
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

Lyria 3 Pro is a single-turn, full-song music-generation model that accepts text and image input and produces stereo MP3 or WAV audio with vocals, lyrics, and multi-section arrangements.

Its strongest documented controls are:

- Explicit musical prompting
- Named song sections
- Timestamped arrangement plans
- Custom lyrics
- Vocal direction
- Instrumentation
- BPM and key language
- Approximate duration
- Image-based creative context

Its principal limitations are:

- No native post-generation editing
- No native stems
- No native MIDI
- No audio-reference conditioning
- No deterministic seed
- No exact duration guarantee
- No continuous streaming
