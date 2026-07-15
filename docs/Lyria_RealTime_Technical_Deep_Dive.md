# Lyria RealTime — Technical Deep Dive

**Model ID:** `lyria-realtime-exp`  
**SDK connection model:** `models/lyria-realtime-exp`  
**API version:** `v1alpha`  
**Status:** Experimental  
**Current as of:** July 15, 2026

---

## 1. Core Specification

| Property | Lyria RealTime |
|---|---|
| Primary purpose | Continuous, interactively steerable instrumental music generation |
| Model ID | `lyria-realtime-exp` |
| SDK connection string | `models/lyria-realtime-exp` |
| Status | Experimental |
| API version | `v1alpha` |
| Transport | Persistent bidirectional WebSocket |
| Input | Weighted text prompts and generation configuration |
| Output | Raw 16-bit PCM |
| Native documented sample rate | 48 kHz |
| Channels | 2-channel stereo |
| Maximum documented control latency | 2 seconds |
| Generation duration | Continuous while the session remains active |
| Vocals | Instrumental only |
| Vocalization mode | Vocal-like textures as an instrument; not controlled lyrical singing |
| Prompt updates | Supported during playback |
| Multiple simultaneous prompts | Supported through weighted prompt blending |
| BPM range | 60–200 |
| Guidance range | 0.0–6.0 |
| Density range | 0.0–1.0 |
| Brightness range | 0.0–1.0 |
| Temperature range | 0.0–3.0 |
| Top-K range | 1–1000 |
| Seed range | 0–2,147,483,647 |
| Key control | Twelve relative major/minor scale groups |
| Bass control | Mute bass or request bass-and-drums-only behavior |
| Drum control | Mute drums or request bass-and-drums-only behavior |
| Watermarking | Always watermarked |
| Audio-reference input | Not documented |
| MIDI-note input | Not documented as a public API input |
| Native stems | Not documented |
| Native file generation | No; the client records the PCM stream |
| Pricing | No dedicated Lyria RealTime price was listed on the current public pricing page |

---

## 2. What Lyria RealTime Is

Lyria RealTime produces an ongoing stereo music stream instead of returning a completed song file.

A client establishes a persistent WebSocket session, sends one or more weighted text prompts, supplies a complete generation configuration, and starts playback. While the stream is running, the client can:

- Replace or blend prompts
- Change prompt weights
- Adjust guidance
- Adjust density
- Adjust brightness
- Adjust temperature
- Adjust Top-K
- Change generation mode
- Mute bass
- Mute drums
- Request bass-and-drums-only output
- Pause playback
- Resume playback
- Stop playback
- Reset musical context
- Record incoming PCM into takes

Lyria RealTime is designed for interactive music systems, live performance, adaptive game audio, installations, generative DJ tools, and DAW-integrated capture workflows.

---

## 3. Native Audio Format

The current model specification documents:

```text
Encoding: Signed 16-bit PCM
Byte order: Little-endian
Sample rate: 48,000 Hz
Channels: 2
Interleaving: Stereo interleaved
Bytes per sample: 2
Bytes per stereo frame: 4
Raw bytes per second: 192,000
```

Calculation:

```text
48,000 samples/second
× 2 channels
× 2 bytes/sample
= 192,000 bytes/second
```

A one-second client-side jitter buffer therefore requires approximately:

```text
192,000 bytes
```

A two-second buffer requires approximately:

```text
384,000 bytes
```

The official JavaScript example also demonstrates requesting `pcm16` and a selected sample rate. Production software should inspect actual stream metadata when available rather than assuming every future experimental version uses the same format.

---

## 4. Control Latency

The model page documents a maximum control latency of approximately two seconds.

This means a prompt or parameter change is not sample-accurate DAW automation. A control may take effect after the current generated context has advanced.

For musical behavior, schedule transitions around:

- Immediate
- Next beat
- Next bar
- Next phrase
- Next scene boundary

A DAW or performance system should translate user actions into musically quantized control events instead of sending every UI movement directly.

---

## 5. Session Flow

```text
Create client
    ↓
Open persistent music WebSocket
    ↓
Set weighted prompts
    ↓
Set the complete generation configuration
    ↓
Start receive loop
    ↓
Call play()
    ↓
Receive raw PCM chunks continuously
    ↓
Buffer → play → optionally record
    ↓
Update prompts/config during playback
    ↓
Pause, stop, or reset context
    ↓
Close the session
```

---

## 6. Playback Controls

| Command | Purpose |
|---|---|
| `play()` | Start or resume music generation |
| `pause()` | Temporarily hold playback/generation state |
| `stop()` | Stop the active stream |
| `reset_context()` / `resetContext()` | Clear the current musical continuation context |
| Session close | End the WebSocket connection |

The JavaScript SDK documentation has used both snake-case and camel-case naming for context reset in examples. A production wrapper can safely detect the available method at runtime.

---

## 7. Weighted Prompts

A weighted prompt contains:

```json
{
  "text": "Minimal techno",
  "weight": 1.0
}
```

Multiple prompts can be active simultaneously:

```json
[
  {
    "text": "Minimal techno",
    "weight": 1.0
  },
  {
    "text": "Ritual percussion",
    "weight": 0.6
  },
  {
    "text": "String quartet",
    "weight": 0.25
  }
]
```

Prompt weights may use positive or negative values, but cannot be exactly zero. `1.0` is the standard starting value.

A prompt with a greater absolute weight generally has stronger influence on the generated stream.

---

## 8. Prompt Morphing

Abruptly replacing a prompt can produce an abrupt musical transition. Smooth transitions can be created by gradually interpolating prompt weights.

Example transition:

```text
Step 0:
- Minimal techno: 1.00
- Orchestral score: omitted

Step 1:
- Minimal techno: 0.90
- Orchestral score: 0.10

Step 2:
- Minimal techno: 0.75
- Orchestral score: 0.25

Step 3:
- Minimal techno: 0.50
- Orchestral score: 0.50

Step 4:
- Minimal techno: 0.25
- Orchestral score: 0.75

Step 5:
- Minimal techno: 0.10
- Orchestral score: 0.90

Step 6:
- Orchestral score: 1.00
```

Prompts whose interpolated weight reaches zero should be omitted because zero is not a valid prompt weight.

---

## 9. Music Generation Configuration

The configuration should be treated as a complete state snapshot.

When updating one parameter, resend all parameters that must remain active. Unspecified fields can return to defaults.

### Configuration fields

| Field | Type | Range/default | Effect |
|---|---|---|---|
| `guidance` | Float | 0.0–6.0; default 4.0 | Prompt adherence |
| `bpm` | Integer | 60–200 | Target tempo |
| `density` | Float | 0.0–1.0 | Musical activity and fullness |
| `brightness` | Float | 0.0–1.0 | Darker-to-brighter generative timbre |
| `scale` | Enum | Relative major/minor pair | Pitch-set guidance |
| `mute_bass` / `muteBass` | Boolean | Default false | Reduce or remove bass |
| `mute_drums` / `muteDrums` | Boolean | Default false | Reduce or remove drums |
| `only_bass_and_drums` / `onlyBassAndDrums` | Boolean | Default false | Favor rhythm-section-only output |
| `music_generation_mode` / `musicGenerationMode` | Enum | Quality default | Quality, diversity, or vocalization behavior |
| `temperature` | Float | 0.0–3.0; default 1.1 | Variation and unpredictability |
| `top_k` / `topK` | Integer | 1–1000; default 40 | Candidate sampling restriction |
| `seed` | Integer | 0–2,147,483,647 | Starting random condition |
| `audio_format` / `audioFormat` | String | `pcm16` | Requested PCM encoding |
| `sample_rate_hz` / `sampleRateHz` | Integer | Native documentation: 48,000 | Requested stream rate |

---

## 10. Soft and Hard Configuration Changes

### Usually soft changes

These can generally be updated without resetting the current musical context:

- Weighted prompt changes
- Guidance
- Density
- Brightness
- Temperature
- Top-K
- Bass mute
- Drum mute
- Bass-and-drums-only mode
- Generation mode

### Hard changes

These require a context reset for the model to fully apply them:

- BPM
- Scale
- Explicit user-requested context reset
- Reconnect after connection failure

A context reset does not need to stop the WebSocket stream, but it creates a hard musical transition.

---

## 11. Guidance

```text
Range: 0.0–6.0
Default: 4.0
```

Lower guidance:

- Looser interpretation
- More exploratory behavior
- Potentially smoother prompt transitions
- Less reliable adherence

Higher guidance:

- Stronger adherence to prompt terms
- More obvious instrument or genre control
- Greater likelihood of abrupt transition artifacts

Suggested starting points:

| Use | Guidance |
|---|---:|
| Ambient exploration | 2.0–3.0 |
| Balanced performance | 3.5–4.5 |
| Strong genre adherence | 4.5–5.5 |
| Maximum constraint testing | 5.5–6.0 |

These suggested operating ranges are practical heuristics, not official guarantees.

---

## 12. Density

```text
Range: 0.0–1.0
```

Lower density tends toward:

- Sparse notes
- Fewer simultaneous elements
- More exposed space
- Simpler rhythmic activity

Higher density tends toward:

- Busier arrangements
- More simultaneous sounds
- Greater rhythmic activity
- Increased perceived complexity

Density is a generative arrangement control rather than a simple gain or track-count control.

---

## 13. Brightness

```text
Range: 0.0–1.0
```

Lower brightness tends toward darker timbres.

Higher brightness tends toward brighter timbres and greater high-frequency emphasis.

Brightness is not equivalent to an EQ shelf. It changes generation behavior and instrument/timbre choices.

---

## 14. Temperature, Top-K, and Seed

### Temperature

```text
Range: 0.0–3.0
Default: 1.1
```

Lower values produce more conservative continuation.

Higher values increase unpredictability and musical variation.

### Top-K

```text
Range: 1–1000
Default: 40
```

Lower Top-K values restrict generation to a smaller candidate set.

Higher Top-K values allow broader exploration.

### Seed

```text
Range: 0–2,147,483,647
Default: Randomly selected
```

A stored seed is useful for comparing configurations and reconstructing session intent. Experimental model changes, networking, and session context can still prevent exact reproducibility.

---

## 15. Generation Modes

| Mode | Intended behavior |
|---|---|
| `QUALITY` | Prioritize musical quality and coherence |
| `DIVERSITY` | Prioritize broader musical variation |
| `VOCALIZATION` | Permit vocal-like sounds as an instrument |

`VOCALIZATION` does not provide controlled lyrics or dependable lead singing. The model remains documented as instrumental-only.

---

## 16. Scale Enum Values

| Enum | Relative scale pair |
|---|---|
| `C_MAJOR_A_MINOR` | C major / A minor |
| `D_FLAT_MAJOR_B_FLAT_MINOR` | D♭ major / B♭ minor |
| `D_MAJOR_B_MINOR` | D major / B minor |
| `E_FLAT_MAJOR_C_MINOR` | E♭ major / C minor |
| `E_MAJOR_D_FLAT_MINOR` | E major / C♯ or D♭ minor |
| `F_MAJOR_D_MINOR` | F major / D minor |
| `G_FLAT_MAJOR_E_FLAT_MINOR` | G♭ major / E♭ minor |
| `G_MAJOR_E_MINOR` | G major / E minor |
| `A_FLAT_MAJOR_F_MINOR` | A♭ major / F minor |
| `A_MAJOR_G_FLAT_MINOR` | A major / F♯ or G♭ minor |
| `B_FLAT_MAJOR_G_MINOR` | B♭ major / G minor |
| `B_MAJOR_A_FLAT_MINOR` | B major / G♯ or A♭ minor |
| `SCALE_UNSPECIFIED` | Model-selected |

The model does not distinguish between the relative major and minor within each pair. For example, `C_MAJOR_A_MINOR` supplies the same pitch collection for C major and A minor.

---

## 17. Prompting Categories

Lyria RealTime understands broad musical language, including:

### Instruments

```text
303 Acid Bass
808 Hip Hop Beat
Alto Saxophone
Bongos
Buchla Synths
Cello
Conga Drums
Dirty Synths
Djembe
Drumline
Fiddle
Flamenco Guitar
Funk Drums
Glockenspiel
Guitar
Hang Drum
Harmonica
Harp
Harpsichord
Kalimba
Koto
Mandolin
Marimba
Mellotron
Moog Oscillations
Piano
Rhodes Piano
Shredding Guitar
Sitar
Slide Guitar
Spacey Synths
Steel Drum
Synth Pads
Tabla
TR-909 Drum Machine
Trumpet
Vibraphone
Warm Acoustic Guitar
Woodwinds
```

### Genres

```text
Acid Jazz
Afrobeat
Baroque
Bhangra
Bluegrass
Bossa Nova
Breakbeat
Chillout
Chiptune
Deep House
Disco Funk
Drum & Bass
Dubstep
EDM
Electro Swing
Funk Metal
Garage Rock
Glitch Hop
Grime
Hyperpop
Indian Classical
Indie Electronic
Jazz Fusion
Latin Jazz
Lo-Fi Hip Hop
Minimal Techno
Neo-Soul
Orchestral Score
Post-Punk
Psytrance
Reggae
Reggaeton
Shoegaze
Ska
Synthpop
Techno
Trance
Trap Beat
Trip Hop
Vaporwave
Witch House
```

### Mood and production language

```text
Ambient
Bright Tones
Chill
Crunchy Distortion
Danceable
Dreamy
Echo
Emotional
Ethereal Ambience
Experimental
Fat Beats
Funky
Glitchy Effects
Huge Drop
Live Performance
Lo-fi
Ominous Drone
Psychedelic
Rich Orchestration
Saturated Tones
Subdued Melody
Sustained Chords
Swirling Phasers
Tight Groove
Unsettling
Upbeat
Virtuoso
Weird Noises
```

Prompt vocabulary is not limited to these examples.

---

## 18. Python Setup

```bash
pip install "google-genai>=1.0.0" pyaudio
```

Set the API key:

```bash
# macOS / Linux
export GEMINI_API_KEY="your-key"
```

```powershell
# PowerShell
$env:GEMINI_API_KEY="your-key"
```

On some systems, PyAudio requires PortAudio development libraries.

---

## 19. Minimal Python Stream

```python
import asyncio
import os

import pyaudio
from google import genai
from google.genai import types

MODEL = "models/lyria-realtime-exp"
RATE = 48_000
CHANNELS = 2
FORMAT = pyaudio.paInt16
FRAMES_PER_BUFFER = 4_800


async def main() -> None:
    api_key = os.environ.get("GEMINI_API_KEY")

    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set.")

    client = genai.Client(
        api_key=api_key,
        http_options={
            "api_version": "v1alpha",
        },
    )

    audio = pyaudio.PyAudio()
    output = audio.open(
        format=FORMAT,
        channels=CHANNELS,
        rate=RATE,
        output=True,
        frames_per_buffer=FRAMES_PER_BUFFER,
    )

    try:
        async with client.aio.live.music.connect(
            model=MODEL,
        ) as session:

            await session.set_weighted_prompts(
                prompts=[
                    types.WeightedPrompt(
                        text=(
                            "Minimal techno with deep bass, "
                            "sparse percussion, and atmospheric synths"
                        ),
                        weight=1.0,
                    ),
                ]
            )

            await session.set_music_generation_config(
                config=types.LiveMusicGenerationConfig(
                    bpm=124,
                    guidance=4.0,
                    density=0.55,
                    brightness=0.35,
                    temperature=1.1,
                    top_k=40,
                    scale=types.Scale.E_FLAT_MAJOR_C_MINOR,
                    music_generation_mode=(
                        types.MusicGenerationMode.QUALITY
                    ),
                )
            )

            await session.play()

            async for message in session.receive():
                if message.filtered_prompt:
                    print(
                        "Filtered prompt:",
                        message.filtered_prompt,
                    )
                    continue

                if not message.server_content:
                    continue

                for chunk in (
                    message.server_content.audio_chunks or []
                ):
                    output.write(chunk.data)

    finally:
        output.stop_stream()
        output.close()
        audio.terminate()


if __name__ == "__main__":
    asyncio.run(main())
```

---

## 20. Python Stream with Jitter Buffer and WAV Recording

```python
from __future__ import annotations

import asyncio
import os
import wave
from dataclasses import dataclass
from pathlib import Path

import pyaudio
from google import genai
from google.genai import types

MODEL = "models/lyria-realtime-exp"

RATE = 48_000
CHANNELS = 2
SAMPLE_WIDTH_BYTES = 2
FORMAT = pyaudio.paInt16

BYTES_PER_SECOND = RATE * CHANNELS * SAMPLE_WIDTH_BYTES
START_BUFFER_SECONDS = 1.0
START_BUFFER_BYTES = int(
    BYTES_PER_SECOND * START_BUFFER_SECONDS
)


@dataclass
class StreamStats:
    received_chunks: int = 0
    received_bytes: int = 0
    played_bytes: int = 0
    filtered_prompts: int = 0


class PcmJitterBuffer:
    def __init__(
        self,
        start_threshold_bytes: int,
    ) -> None:
        self.queue: asyncio.Queue[bytes | None] = (
            asyncio.Queue()
        )
        self.start_threshold_bytes = (
            start_threshold_bytes
        )
        self.buffered_bytes = 0
        self.started = False

    async def put(self, data: bytes) -> None:
        self.buffered_bytes += len(data)
        await self.queue.put(data)

    async def close(self) -> None:
        await self.queue.put(None)

    async def get(self) -> bytes | None:
        while (
            not self.started
            and self.buffered_bytes
            < self.start_threshold_bytes
        ):
            await asyncio.sleep(0.01)

        self.started = True

        data = await self.queue.get()

        if data is not None:
            self.buffered_bytes -= len(data)

        return data


async def receive_audio(
    session,
    jitter_buffer: PcmJitterBuffer,
    wav_file: wave.Wave_write,
    stats: StreamStats,
) -> None:
    try:
        async for message in session.receive():
            if message.filtered_prompt:
                stats.filtered_prompts += 1
                print(
                    "Prompt filtered:",
                    message.filtered_prompt,
                )
                continue

            server_content = message.server_content

            if not server_content:
                continue

            for chunk in server_content.audio_chunks or []:
                data = bytes(chunk.data)

                stats.received_chunks += 1
                stats.received_bytes += len(data)

                wav_file.writeframesraw(data)
                await jitter_buffer.put(data)

    finally:
        await jitter_buffer.close()


async def play_audio(
    jitter_buffer: PcmJitterBuffer,
    output_stream,
    stats: StreamStats,
) -> None:
    while True:
        data = await jitter_buffer.get()

        if data is None:
            return

        output_stream.write(data)
        stats.played_bytes += len(data)


async def main() -> None:
    api_key = os.environ.get("GEMINI_API_KEY")

    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set.")

    output_path = Path("lyria-realtime-capture.wav")

    client = genai.Client(
        api_key=api_key,
        http_options={
            "api_version": "v1alpha",
        },
    )

    audio = pyaudio.PyAudio()
    output_stream = audio.open(
        format=FORMAT,
        channels=CHANNELS,
        rate=RATE,
        output=True,
        frames_per_buffer=4_800,
    )

    stats = StreamStats()

    jitter_buffer = PcmJitterBuffer(
        start_threshold_bytes=START_BUFFER_BYTES,
    )

    with wave.open(str(output_path), "wb") as wav_file:
        wav_file.setnchannels(CHANNELS)
        wav_file.setsampwidth(SAMPLE_WIDTH_BYTES)
        wav_file.setframerate(RATE)

        try:
            async with client.aio.live.music.connect(
                model=MODEL,
            ) as session:

                await session.set_weighted_prompts(
                    prompts=[
                        types.WeightedPrompt(
                            text="Dark industrial techno",
                            weight=1.0,
                        ),
                        types.WeightedPrompt(
                            text="Metallic percussion",
                            weight=0.65,
                        ),
                        types.WeightedPrompt(
                            text="Ominous drone",
                            weight=0.3,
                        ),
                    ]
                )

                await session.set_music_generation_config(
                    config=types.LiveMusicGenerationConfig(
                        bpm=128,
                        guidance=4.2,
                        density=0.7,
                        brightness=0.25,
                        temperature=1.0,
                        top_k=40,
                        scale=types.Scale.E_FLAT_MAJOR_C_MINOR,
                        seed=42,
                        music_generation_mode=(
                            types.MusicGenerationMode.QUALITY
                        ),
                    )
                )

                receiver = asyncio.create_task(
                    receive_audio(
                        session,
                        jitter_buffer,
                        wav_file,
                        stats,
                    )
                )

                player = asyncio.create_task(
                    play_audio(
                        jitter_buffer,
                        output_stream,
                        stats,
                    )
                )

                await session.play()

                await asyncio.sleep(60)

                await session.stop()
                receiver.cancel()

                try:
                    await receiver
                except asyncio.CancelledError:
                    pass

                await jitter_buffer.close()
                await player

        finally:
            output_stream.stop_stream()
            output_stream.close()
            audio.terminate()

    print("Saved:", output_path)
    print("Chunks:", stats.received_chunks)
    print("Received bytes:", stats.received_bytes)
    print("Played bytes:", stats.played_bytes)
    print("Filtered prompts:", stats.filtered_prompts)


if __name__ == "__main__":
    asyncio.run(main())
```

---

## 21. Python Interactive Controller

```python
from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace

from google.genai import types


@dataclass
class RealtimeState:
    bpm: int = 120
    guidance: float = 4.0
    density: float = 0.5
    brightness: float = 0.5
    temperature: float = 1.1
    top_k: int = 40
    seed: int | None = None
    scale: types.Scale = types.Scale.SCALE_UNSPECIFIED
    mute_bass: bool = False
    mute_drums: bool = False
    only_bass_and_drums: bool = False
    mode: types.MusicGenerationMode = (
        types.MusicGenerationMode.QUALITY
    )


def build_config(
    state: RealtimeState,
) -> types.LiveMusicGenerationConfig:
    values = {
        "bpm": state.bpm,
        "guidance": state.guidance,
        "density": state.density,
        "brightness": state.brightness,
        "temperature": state.temperature,
        "top_k": state.top_k,
        "scale": state.scale,
        "mute_bass": state.mute_bass,
        "mute_drums": state.mute_drums,
        "only_bass_and_drums": (
            state.only_bass_and_drums
        ),
        "music_generation_mode": state.mode,
    }

    if state.seed is not None:
        values["seed"] = state.seed

    return types.LiveMusicGenerationConfig(**values)


async def apply_state(
    session,
    previous: RealtimeState,
    current: RealtimeState,
) -> None:
    hard_change = (
        previous.bpm != current.bpm
        or previous.scale != current.scale
    )

    await session.set_music_generation_config(
        config=build_config(current)
    )

    if hard_change:
        await session.reset_context()


async def command_loop(session) -> None:
    state = RealtimeState()

    while True:
        command = await asyncio.to_thread(
            input,
            "lyria> ",
        )

        command = command.strip()

        if not command:
            continue

        if command == "quit":
            await session.stop()
            return

        if command == "play":
            await session.play()
            continue

        if command == "pause":
            await session.pause()
            continue

        if command == "stop":
            await session.stop()
            continue

        if command == "reset":
            await session.reset_context()
            continue

        if command.startswith("prompt "):
            prompt = command.removeprefix("prompt ").strip()

            await session.set_weighted_prompts(
                prompts=[
                    types.WeightedPrompt(
                        text=prompt,
                        weight=1.0,
                    )
                ]
            )
            continue

        if command.startswith("bpm "):
            new_state = replace(
                state,
                bpm=int(
                    command.removeprefix("bpm ").strip()
                ),
            )

            await apply_state(
                session,
                state,
                new_state,
            )

            state = new_state
            continue

        if command.startswith("density "):
            new_state = replace(
                state,
                density=float(
                    command.removeprefix(
                        "density "
                    ).strip()
                ),
            )

            await apply_state(
                session,
                state,
                new_state,
            )

            state = new_state
            continue

        print("Unknown command")
```

---

## 22. JavaScript / TypeScript Setup

```bash
npm install @google/genai speaker wav
npm install --save-dev typescript tsx @types/node
```

The `speaker` package uses native audio bindings and may require build tools.

Set the API key:

```bash
# macOS / Linux
export GEMINI_API_KEY="your-key"
```

```powershell
# PowerShell
$env:GEMINI_API_KEY="your-key"
```

---

## 23. Minimal TypeScript Stream

```typescript
import { GoogleGenAI } from "@google/genai";
import Speaker from "speaker";
import { Buffer } from "node:buffer";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not set.");
}

const client = new GoogleGenAI({
  apiKey,
  apiVersion: "v1alpha",
});

const speaker = new Speaker({
  channels: 2,
  bitDepth: 16,
  sampleRate: 48_000,
});

const session = await client.live.music.connect({
  model: "models/lyria-realtime-exp",

  callbacks: {
    onmessage: (message) => {
      const chunks =
        message.serverContent?.audioChunks ?? [];

      for (const chunk of chunks) {
        speaker.write(
          Buffer.from(chunk.data, "base64"),
        );
      }

      if (message.filteredPrompt) {
        console.warn(
          "Prompt filtered:",
          message.filteredPrompt,
        );
      }
    },

    onerror: (error) => {
      console.error(
        "Lyria RealTime session error:",
        error,
      );
    },

    onclose: () => {
      console.log(
        "Lyria RealTime session closed.",
      );

      speaker.end();
    },
  },
});

await session.setWeightedPrompts({
  weightedPrompts: [
    {
      text: (
        "Minimal techno with deep bass, " +
        "sparse percussion, and atmospheric synths"
      ),
      weight: 1.0,
    },
  ],
});

await session.setMusicGenerationConfig({
  musicGenerationConfig: {
    bpm: 124,
    guidance: 4.0,
    density: 0.55,
    brightness: 0.35,
    temperature: 1.1,
    topK: 40,
    audioFormat: "pcm16",
    sampleRateHz: 48_000,
  },
});

await session.play();
```

---

## 24. Runtime-Compatible Context Reset Helper

The published JavaScript documentation has shown more than one reset-method spelling. This helper supports either form:

```typescript
async function resetMusicContext(
  session: any,
): Promise<void> {
  if (
    typeof session.resetContext === "function"
  ) {
    await session.resetContext();
    return;
  }

  if (
    typeof session.reset_context === "function"
  ) {
    await session.reset_context();
    return;
  }

  throw new Error(
    "The connected SDK session exposes no context-reset method.",
  );
}
```

---

## 25. TypeScript WAV Recorder

```typescript
import fs from "node:fs";
import path from "node:path";

class Pcm16WavRecorder {
  private readonly stream: fs.WriteStream;
  private dataBytes = 0;
  private closed = false;

  constructor(
    private readonly outputPath: string,
    private readonly sampleRate = 48_000,
    private readonly channels = 2,
  ) {
    fs.mkdirSync(
      path.dirname(outputPath),
      {
        recursive: true,
      },
    );

    this.stream = fs.createWriteStream(
      outputPath,
    );

    this.stream.write(
      Buffer.alloc(44),
    );
  }

  write(chunk: Buffer): void {
    if (this.closed) {
      throw new Error(
        "Cannot write to a closed WAV recorder.",
      );
    }

    this.dataBytes += chunk.length;
    this.stream.write(chunk);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    await new Promise<void>(
      (resolve, reject) => {
        this.stream.end(() => resolve());
        this.stream.on("error", reject);
      },
    );

    const file = await fs.promises.open(
      this.outputPath,
      "r+",
    );

    try {
      const header = this.createHeader(
        this.dataBytes,
      );

      await file.write(
        header,
        0,
        header.length,
        0,
      );
    } finally {
      await file.close();
    }
  }

  private createHeader(
    dataLength: number,
  ): Buffer {
    const bitsPerSample = 16;
    const blockAlign =
      this.channels * (bitsPerSample / 8);

    const byteRate =
      this.sampleRate * blockAlign;

    const header = Buffer.alloc(44);

    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(
      36 + dataLength,
      4,
    );
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(
      this.channels,
      22,
    );
    header.writeUInt32LE(
      this.sampleRate,
      24,
    );
    header.writeUInt32LE(
      byteRate,
      28,
    );
    header.writeUInt16LE(
      blockAlign,
      32,
    );
    header.writeUInt16LE(
      bitsPerSample,
      34,
    );
    header.write("data", 36, "ascii");
    header.writeUInt32LE(
      dataLength,
      40,
    );

    return header;
  }
}
```

Usage:

```typescript
const recorder = new Pcm16WavRecorder(
  "./captures/session-01.wav",
  48_000,
  2,
);

// Inside onmessage:
for (const chunk of chunks) {
  const pcm = Buffer.from(
    chunk.data,
    "base64",
  );

  recorder.write(pcm);
  speaker.write(pcm);
}

// Before exiting:
await recorder.close();
```

---

## 26. TypeScript Jitter Buffer

```typescript
import { Buffer } from "node:buffer";

type ChunkConsumer = (
  chunk: Buffer,
) => boolean;

class PcmJitterBuffer {
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private started = false;
  private draining = false;

  constructor(
    private readonly startThresholdBytes: number,
    private readonly consume: ChunkConsumer,
  ) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;

    if (
      !this.started &&
      this.bufferedBytes >=
        this.startThresholdBytes
    ) {
      this.started = true;
    }

    if (this.started) {
      this.drain();
    }
  }

  resume(): void {
    this.drain();
  }

  getBufferedSeconds(
    bytesPerSecond = 192_000,
  ): number {
    return (
      this.bufferedBytes /
      bytesPerSecond
    );
  }

  private drain(): void {
    if (this.draining) {
      return;
    }

    this.draining = true;

    try {
      while (this.chunks.length > 0) {
        const chunk = this.chunks[0];
        const accepted = this.consume(chunk);

        if (!accepted) {
          return;
        }

        this.chunks.shift();
        this.bufferedBytes -= chunk.length;
      }
    } finally {
      this.draining = false;
    }
  }
}
```

Usage with a one-second startup buffer:

```typescript
const BYTES_PER_SECOND =
  48_000 * 2 * 2;

const jitterBuffer =
  new PcmJitterBuffer(
    BYTES_PER_SECOND,
    (chunk) => speaker.write(chunk),
  );

speaker.on("drain", () => {
  jitterBuffer.resume();
});

// Inside onmessage:
jitterBuffer.push(pcm);
```

---

## 27. TypeScript Prompt Morphing

```typescript
interface WeightedPrompt {
  text: string;
  weight: number;
}

function promptMap(
  prompts: WeightedPrompt[],
): Map<string, number> {
  return new Map(
    prompts.map((prompt) => [
      prompt.text,
      prompt.weight,
    ]),
  );
}

function interpolatePrompts(
  from: WeightedPrompt[],
  to: WeightedPrompt[],
  progress: number,
): WeightedPrompt[] {
  const start = promptMap(from);
  const end = promptMap(to);

  const names = new Set([
    ...start.keys(),
    ...end.keys(),
  ]);

  const output: WeightedPrompt[] = [];

  for (const text of names) {
    const fromWeight =
      start.get(text) ?? 0;

    const toWeight =
      end.get(text) ?? 0;

    const weight =
      fromWeight +
      (toWeight - fromWeight) *
        progress;

    if (Math.abs(weight) < 0.001) {
      continue;
    }

    output.push({
      text,
      weight,
    });
  }

  return output;
}

function sleep(
  milliseconds: number,
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function morphPrompts(
  session: any,
  from: WeightedPrompt[],
  to: WeightedPrompt[],
  durationMs = 8_000,
  steps = 16,
): Promise<void> {
  if (steps < 1) {
    throw new Error(
      "steps must be at least 1.",
    );
  }

  const interval =
    durationMs / steps;

  for (
    let index = 1;
    index <= steps;
    index++
  ) {
    const progress =
      index / steps;

    const weightedPrompts =
      interpolatePrompts(
        from,
        to,
        progress,
      );

    await session.setWeightedPrompts({
      weightedPrompts,
    });

    await sleep(interval);
  }
}
```

Usage:

```typescript
await morphPrompts(
  session,
  [
    {
      text: "Minimal techno",
      weight: 1.0,
    },
    {
      text: "Metallic percussion",
      weight: 0.5,
    },
  ],
  [
    {
      text: "Orchestral score",
      weight: 1.0,
    },
    {
      text: "String ostinato",
      weight: 0.7,
    },
  ],
  12_000,
  24,
);
```

---

## 28. TypeScript Configuration State

Because a config update can reset omitted values, store the entire state locally.

```typescript
type GenerationMode =
  | "QUALITY"
  | "DIVERSITY"
  | "VOCALIZATION";

interface RealtimeConfig {
  guidance: number;
  bpm: number;
  density: number;
  brightness: number;
  scale: string;
  muteBass: boolean;
  muteDrums: boolean;
  onlyBassAndDrums: boolean;
  musicGenerationMode: GenerationMode;
  temperature: number;
  topK: number;
  seed?: number;
  audioFormat: "pcm16";
  sampleRateHz: number;
}

const defaultConfig: RealtimeConfig = {
  guidance: 4.0,
  bpm: 120,
  density: 0.5,
  brightness: 0.5,
  scale: "SCALE_UNSPECIFIED",
  muteBass: false,
  muteDrums: false,
  onlyBassAndDrums: false,
  musicGenerationMode: "QUALITY",
  temperature: 1.1,
  topK: 40,
  audioFormat: "pcm16",
  sampleRateHz: 48_000,
};

async function applyConfig(
  session: any,
  previous: RealtimeConfig,
  patch: Partial<RealtimeConfig>,
): Promise<RealtimeConfig> {
  const next: RealtimeConfig = {
    ...previous,
    ...patch,
  };

  const requiresReset =
    next.bpm !== previous.bpm ||
    next.scale !== previous.scale;

  await session.setMusicGenerationConfig({
    musicGenerationConfig: next,
  });

  if (requiresReset) {
    await resetMusicContext(session);
  }

  return next;
}
```

Usage:

```typescript
let config = defaultConfig;

config = await applyConfig(
  session,
  config,
  {
    density: 0.8,
    brightness: 0.25,
  },
);

config = await applyConfig(
  session,
  config,
  {
    bpm: 140,
    scale: "F_MAJOR_D_MINOR",
  },
);
```

---

## 29. Scene System

```typescript
interface Scene {
  id: string;
  name: string;
  prompts: WeightedPrompt[];
  config: Partial<RealtimeConfig>;
  transitionMs?: number;
}

const scenes: Scene[] = [
  {
    id: "intro",
    name: "Intro",
    prompts: [
      {
        text: "Ominous drone",
        weight: 1.0,
      },
      {
        text: "Sparse metallic percussion",
        weight: 0.35,
      },
    ],
    config: {
      bpm: 120,
      density: 0.25,
      brightness: 0.15,
      guidance: 4.0,
    },
    transitionMs: 4_000,
  },
  {
    id: "build",
    name: "Build",
    prompts: [
      {
        text: "Industrial techno",
        weight: 1.0,
      },
      {
        text: "Rising synth pulses",
        weight: 0.65,
      },
      {
        text: "Metallic percussion",
        weight: 0.7,
      },
    ],
    config: {
      bpm: 128,
      density: 0.65,
      brightness: 0.35,
    },
    transitionMs: 8_000,
  },
  {
    id: "drop",
    name: "Drop",
    prompts: [
      {
        text: "Heavy industrial techno",
        weight: 1.2,
      },
      {
        text: "Huge drop",
        weight: 1.0,
      },
      {
        text: "Dirty synth bass",
        weight: 0.9,
      },
    ],
    config: {
      bpm: 128,
      density: 0.95,
      brightness: 0.45,
      guidance: 4.8,
    },
    transitionMs: 4_000,
  },
];
```

Apply a scene:

```typescript
async function applyScene(
  session: any,
  currentPrompts: WeightedPrompt[],
  currentConfig: RealtimeConfig,
  scene: Scene,
): Promise<{
  prompts: WeightedPrompt[];
  config: RealtimeConfig;
}> {
  const config = await applyConfig(
    session,
    currentConfig,
    scene.config,
  );

  await morphPrompts(
    session,
    currentPrompts,
    scene.prompts,
    scene.transitionMs ?? 4_000,
    12,
  );

  return {
    prompts: scene.prompts,
    config,
  };
}
```

---

## 30. Complete TypeScript Controller Skeleton

```typescript
import { GoogleGenAI } from "@google/genai";
import Speaker from "speaker";
import { Buffer } from "node:buffer";

class LyriaRealtimeController {
  private readonly client: GoogleGenAI;
  private readonly speaker: Speaker;
  private readonly recorder: Pcm16WavRecorder;
  private session: any;

  private prompts: WeightedPrompt[] = [
    {
      text: "Minimal techno",
      weight: 1.0,
    },
  ];

  private config: RealtimeConfig = {
    ...defaultConfig,
  };

  constructor(
    apiKey: string,
    outputPath: string,
  ) {
    this.client = new GoogleGenAI({
      apiKey,
      apiVersion: "v1alpha",
    });

    this.speaker = new Speaker({
      channels: 2,
      bitDepth: 16,
      sampleRate: 48_000,
    });

    this.recorder =
      new Pcm16WavRecorder(
        outputPath,
        48_000,
        2,
      );
  }

  async connect(): Promise<void> {
    this.session =
      await this.client.live.music.connect({
        model: "models/lyria-realtime-exp",

        callbacks: {
          onmessage: (message: any) => {
            this.handleMessage(message);
          },

          onerror: (error: unknown) => {
            console.error(
              "Lyria RealTime error:",
              error,
            );
          },

          onclose: () => {
            console.log(
              "Lyria RealTime connection closed.",
            );
          },
        },
      });

    await this.session.setWeightedPrompts({
      weightedPrompts: this.prompts,
    });

    await this.session
      .setMusicGenerationConfig({
        musicGenerationConfig:
          this.config,
      });
  }

  async play(): Promise<void> {
    this.assertConnected();
    await this.session.play();
  }

  async pause(): Promise<void> {
    this.assertConnected();
    await this.session.pause();
  }

  async stop(): Promise<void> {
    this.assertConnected();
    await this.session.stop();
  }

  async setPrompts(
    prompts: WeightedPrompt[],
  ): Promise<void> {
    this.assertConnected();

    await this.session.setWeightedPrompts({
      weightedPrompts: prompts,
    });

    this.prompts = prompts;
  }

  async morphTo(
    prompts: WeightedPrompt[],
    durationMs = 8_000,
  ): Promise<void> {
    this.assertConnected();

    await morphPrompts(
      this.session,
      this.prompts,
      prompts,
      durationMs,
      16,
    );

    this.prompts = prompts;
  }

  async updateConfig(
    patch: Partial<RealtimeConfig>,
  ): Promise<void> {
    this.assertConnected();

    this.config = await applyConfig(
      this.session,
      this.config,
      patch,
    );
  }

  async close(): Promise<void> {
    if (this.session) {
      try {
        await this.session.stop();
      } catch {
        // Ignore shutdown errors.
      }
    }

    this.speaker.end();
    await this.recorder.close();
  }

  private handleMessage(
    message: any,
  ): void {
    if (message.filteredPrompt) {
      console.warn(
        "Prompt filtered:",
        message.filteredPrompt,
      );
    }

    const chunks =
      message.serverContent?.audioChunks ??
      [];

    for (const chunk of chunks) {
      const pcm = Buffer.from(
        chunk.data,
        "base64",
      );

      this.recorder.write(pcm);
      this.speaker.write(pcm);
    }
  }

  private assertConnected(): void {
    if (!this.session) {
      throw new Error(
        "Lyria RealTime is not connected.",
      );
    }
  }
}
```

Usage:

```typescript
const apiKey =
  process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error(
    "GEMINI_API_KEY is not set.",
  );
}

const lyria =
  new LyriaRealtimeController(
    apiKey,
    "./captures/live-session.wav",
  );

try {
  await lyria.connect();
  await lyria.play();

  await new Promise((resolve) => {
    setTimeout(resolve, 15_000);
  });

  await lyria.morphTo(
    [
      {
        text: "Industrial techno",
        weight: 1.0,
      },
      {
        text: "Dirty synth bass",
        weight: 0.7,
      },
      {
        text: "Huge drop",
        weight: 0.5,
      },
    ],
    10_000,
  );

  await lyria.updateConfig({
    density: 0.9,
    brightness: 0.3,
    guidance: 4.8,
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 30_000);
  });
} finally {
  await lyria.close();
}
```

---

## 31. Handling Filtered Prompts

Safety-filtered prompts are ignored. The server can return an explanation through `filtered_prompt` or the SDK-equivalent property.

Python:

```python
if message.filtered_prompt:
    print(
        "Prompt was ignored:",
        message.filtered_prompt,
    )
```

TypeScript:

```typescript
if (message.filteredPrompt) {
  console.warn(
    "Prompt was ignored:",
    message.filteredPrompt,
  );
}
```

Do not assume a prompt update succeeded merely because the client sent it.

---

## 32. Reconnection Strategy

Lyria RealTime is experimental and uses a persistent network session. Production clients should implement:

1. Connection-state tracking
2. Backoff before reconnecting
3. Maximum retry limit
4. Session-generation ID
5. Audio queue reset after reconnect
6. Prompt restoration
7. Configuration restoration
8. New recording segment after reconnect
9. Crossfade between old and new capture when possible
10. Visible degraded-state indicator

A reconnect creates a new musical continuation context. It cannot transparently preserve the exact prior stream state.

Example backoff:

```typescript
function wait(
  milliseconds: number,
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function connectWithRetry(
  connect: () => Promise<void>,
  attempts = 5,
): Promise<void> {
  let lastError: unknown;

  for (
    let attempt = 1;
    attempt <= attempts;
    attempt++
  ) {
    try {
      await connect();
      return;
    } catch (error) {
      lastError = error;

      if (attempt === attempts) {
        break;
      }

      const base =
        1_000 * 2 ** (attempt - 1);

      const jitter =
        Math.floor(
          Math.random() * 500,
        );

      await wait(
        Math.min(
          base + jitter,
          30_000,
        ),
      );
    }
  }

  throw lastError;
}
```

---

## 33. Metadata to Store for Every Capture

```json
{
  "model": "lyria-realtime-exp",
  "api_version": "v1alpha",
  "session_id": "{{ SESSION_ID }}",
  "capture_id": "{{ CAPTURE_ID }}",
  "started_at": "{{ ISO_TIMESTAMP }}",
  "ended_at": "{{ ISO_TIMESTAMP }}",
  "audio": {
    "format": "pcm16",
    "sample_rate_hz": 48000,
    "channels": 2,
    "wav_path": "{{ WAV_PATH }}"
  },
  "initial_prompts": [
    {
      "text": "{{ PROMPT }}",
      "weight": 1.0
    }
  ],
  "initial_config": {
    "bpm": 128,
    "guidance": 4.0,
    "density": 0.6,
    "brightness": 0.3,
    "temperature": 1.1,
    "top_k": 40,
    "scale": "E_FLAT_MAJOR_C_MINOR",
    "seed": 42,
    "music_generation_mode": "QUALITY"
  },
  "events": [
    {
      "time_seconds": 12.4,
      "type": "prompt_update",
      "value": [
        {
          "text": "Industrial techno",
          "weight": 1.0
        }
      ]
    },
    {
      "time_seconds": 28.0,
      "type": "config_update",
      "value": {
        "density": 0.85
      }
    },
    {
      "time_seconds": 46.0,
      "type": "context_reset",
      "reason": "bpm_change"
    }
  ],
  "filtered_prompts": []
}
```

---

## 34. Recommended DAW Architecture

```text
Plugin UI or standalone controller
    ↓
Prompt and scene state
    ↓
Transition scheduler
    ↓
Lyria RealTime SDK adapter
    ↓
Persistent WebSocket
    ↓
Incoming PCM chunk queue
    ↓
Jitter buffer
    ↓
Audio-safe ring buffer
    ↓
DAW audio thread
    ↓
Live monitoring + capture
    ↓
WAV take browser
```

Critical separation:

- Never perform network operations on the DAW audio thread.
- Never parse JSON on the DAW audio thread.
- Never allocate large buffers on the DAW audio thread.
- Use a lock-free or audio-safe ring buffer between the network receiver and host callback.
- Resample outside the time-critical callback when possible.
- Maintain enough audio ahead of playback to absorb network jitter.
- Separate live monitoring from disk recording.

---

## 35. Suggested Ring-Buffer Capacity

At 48 kHz stereo PCM16:

```text
0.25 seconds = 48,000 bytes
0.50 seconds = 96,000 bytes
1.00 second  = 192,000 bytes
2.00 seconds = 384,000 bytes
4.00 seconds = 768,000 bytes
```

A practical starting buffer is one second.

For local studio use with reliable networking, 0.5 seconds may be acceptable.

For installations or unstable Wi-Fi, two to four seconds may be safer, at the cost of delayed control feedback.

---

## 36. Native Limitations

Lyria RealTime currently does not document native support for:

- Controlled lyrical singing
- User-provided lyrics
- Uploaded audio references
- Audio-to-audio transformation
- Exact melody conditioning
- Exact chord-progression input
- Native MIDI-note input
- Native individual stems
- More than stereo output
- Waveform inpainting
- Region regeneration
- Uploaded-song continuation
- Exact section timelines
- Exact time-signature control
- Guaranteed deterministic replay
- SynthID-free output

The public API is focused on continuous instrumental generation controlled by weighted text prompts and high-level configuration.

---

## 37. Production Risks

### Experimental model risk

The model ID, endpoint behavior, parameter definitions, quotas, and SDK methods can change.

### Network dependency

The system cannot generate without a stable connection.

### Jitter and underruns

Incoming PCM chunks may not arrive at perfectly uniform intervals.

### Control delay

Prompt changes are not sample-accurate and can take up to approximately two seconds.

### Hard transitions

BPM, scale, reconnects, and context resets can create audible discontinuities.

### Non-determinism

A seed improves session traceability but does not guarantee bit-identical reconstruction.

### Safety filtering

A prompt can be ignored while the previous musical state continues.

### SDK naming drift

Experimental SDK examples may use different property or method casing between versions.

---

## 38. Best Practices

- Keep a complete local configuration object.
- Resend the full configuration on every config update.
- Reset context after BPM or scale changes.
- Morph prompt weights gradually.
- Omit prompts whose weight reaches zero.
- Buffer incoming PCM before playback.
- Record the raw stream before applying effects.
- Store every prompt/config event with a timestamp.
- Detect and log filtered prompts.
- Separate network, recording, and playback threads.
- Quantize scene changes to musical boundaries.
- Treat reconnects as new takes.
- Inspect actual audio metadata when available.
- Pin the SDK version for production builds.
- Place the model adapter behind an interface so it can be replaced when the experimental API changes.

---

## 39. Official Documentation

- Lyria RealTime guide:  
  `https://ai.google.dev/gemini-api/docs/realtime-music-generation`

- Lyria RealTime model page:  
  `https://ai.google.dev/gemini-api/docs/models/lyria-realtime-exp`

- Gemini API models:  
  `https://ai.google.dev/gemini-api/docs/models`

- Gemini API pricing:  
  `https://ai.google.dev/gemini-api/docs/pricing`

- Official Python cookbook:  
  `https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_LyriaRealTime.py`

- Live Music Models paper:  
  `https://arxiv.org/abs/2508.04651`

---

## 40. Summary

Lyria RealTime is an experimental continuous music engine built around a persistent bidirectional WebSocket.

It generates raw stereo PCM16 audio and supports live control through:

- Weighted text prompts
- Prompt blending
- Prompt-weight morphing
- Guidance
- BPM
- Density
- Brightness
- Relative major/minor scale groups
- Bass and drum controls
- Quality, diversity, and vocalization modes
- Temperature
- Top-K
- Seed
- Play, pause, stop, and context reset

Its strongest use cases are:

- Live generative performance
- Prompt-based DJ systems
- Adaptive game music
- Interactive installations
- Continuous soundscapes
- DAW capture tools
- Scene-based music engines
- Real-time audiovisual systems

Its principal constraints are:

- Instrumental-only generation
- Experimental API stability
- Network-dependent streaming
- Maximum documented control latency of approximately two seconds
- No native stems
- No audio-reference conditioning
- No exact timeline control
- No controlled lyrical vocals
