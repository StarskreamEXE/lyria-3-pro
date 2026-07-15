# 02 — Prompting Guide

*Distilled from Google's official "Ultimate prompting guide for Lyria 3 models" and the project deep dive (§3–5, §22). The prompt is the ONLY control surface — there are no structure/vocal/tempo API parameters on Lyria 3.*

## What a prompt can control

Genre and blends · BPM / tempo language · key & scale · time signature · instrumentation · vocal range, character, texture (timbre), and delivery · lyric language (8 supported) · user-written lyrics · instrumental-only · approximate duration · section order · timestamped arrangement · mood, energy curve, dynamics · production style, stereo-width, arrangement density · image/PDF references.

## The recommended prompt shape

Strong prompts separate four concerns:

```text
Create a 2 minute 30 second industrial metalcore and electronic track.

Technical direction:
- 150 BPM
- D minor
- 4/4
- Low male baritone lead vocal
- Down-tuned rhythm guitars, distorted electronic bass
- Dark, aggressive production; wide choruses, narrow intimate verses

Avoid:
- Falsetto
- Orchestral strings
- Long ambient introduction

Structure:

[0:00 - 0:10] Intro
Filtered electronic percussion, distant guitar noise.

[0:10 - 0:38] Verse 1
Low baritone vocal. Restrained palm-muted guitars.

[0:54 - 1:22] Chorus
Full-width guitars, heavy drums, stacked vocal harmonies.
```

1. **Technical direction** — explicit musical language beats vibes ("132 BPM, D minor, low male baritone" > "dark and cool").
2. **Exclusions** — there is no `negative_prompt` param on Lyria 3; exclusions go in the prompt as an explicit "Avoid:" list. This works and is officially recommended.
3. **Lyrics** — separated from instructions, under section tags (see below).
4. **Structure** — section tags and/or timestamp directives.

## Section tags

`[Intro]` `[Verse 1]` `[Pre-Chorus]` `[Chorus]` `[Verse 2]` `[Bridge]` `[Breakdown]` `[Final Chorus]` `[Outro]` — custom labels also work when the musical role is described. The model adapts content to the section's role (choruses hook harder, bridges add harmonic contrast).

## Timestamp prompting (the power workflow)

Assign musical events to timed segments — ideal for genre shifts and scoring to picture:

```text
[00:00] Begin immediately with a massive gospel choir singing a powerful, uplifting harmony.
[00:15] A heavy, modern hip-hop drum beat and a deep 808 bassline drop in.
[00:30] A male lead vocalist begins rapping a confident verse, choir punctuating his lines.
[01:50] The beat strips back to just a gentle Hammond B3 organ; quiet emotional bridge.
[02:10] Full beat and giant choir return at maximum energy, ending on a sustained chord at [03:00].
```

Timestamps **guide** the arrangement; they are not sample-exact guarantees.

## Vocal direction

Be specific about: demographics/range ("commanding baritone", "clear high soprano"), texture ("gravelly", "soulful", "breathy"), pattern ("fast-paced", "laid-back groove", "calmer and quieter as the track progresses"), and language. Layered/multi-vocal styles are supported.

## Energy-curve language

```text
Begin sparse and intimate.
Increase rhythmic density through the pre-chorus.
Open into a wide full-spectrum chorus.
Collapse into a half-time breakdown.
Return with the largest final chorus.
```

## Multimodal prompting

Attach up to 10 images (or PDFs) and direct their interpretation: *"Interpret: color palette as harmonic mood, visual density as arrangement density, lighting as brightness and timbre, perceived movement as rhythmic intensity."*

## Full worked examples

See deep dive §7–§11 for complete minimal, production, image-to-music, and custom-lyrics prompts, and §14 for a Python instrumental example.
