import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, BookOpen, ChevronLeft, ChevronRight } from 'lucide-react';

// Chapter content is sourced from docs/guide/01–04 (Lyria models & limits, prompting
// framework, app↔API mapping). If those docs change, this modal must follow — it is
// the in-app rendering of that guide, not an independent source of truth.

// ————— content primitives —————

function H({ children }: { children: React.ReactNode }) {
  return <h3 className="font-display text-[11px] font-medium text-lyria-gold uppercase tracking-widest mt-6 mb-2 first:mt-0">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-lyria-text-main/90 leading-relaxed mb-3">{children}</p>;
}

function UL({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="mb-3 space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="text-[13px] text-lyria-text-main/90 leading-relaxed pl-4 relative">
          <span className="absolute left-0 text-lyria-gold/60">·</span>
          {item}
        </li>
      ))}
    </ul>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-lyria-bg border border-lyria-border/70 rounded-lg p-3 mb-3 font-mono text-[11px] leading-relaxed text-lyria-text-main/85 whitespace-pre-wrap overflow-x-auto">
      {children}
    </pre>
  );
}

// Inline chip for section tags like [Chorus] and UI control names like MODEL.
function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-block px-1.5 py-[1px] mx-0.5 rounded border border-lyria-border bg-lyria-bg font-mono text-[11px] text-lyria-gold/90 whitespace-nowrap">{children}</span>;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="px-1.5 py-[1px] mx-0.5 rounded border border-lyria-border bg-[#1a1611] font-mono text-[11px] text-lyria-text-main">{children}</kbd>;
}

// Gold-edged callout for load-bearing facts.
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-l-2 border-lyria-gold/60 bg-lyria-gold/5 rounded-r-lg px-3 py-2 mb-3">
      <p className="text-[12px] text-lyria-text-main/90 leading-relaxed">{children}</p>
    </div>
  );
}

// Signal-edged callout for anything that costs real money.
function CostWarn({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-l-2 border-lyria-signal/70 bg-lyria-signal/5 rounded-r-lg px-3 py-2 mb-3">
      <p className="text-[12px] text-lyria-text-main/90 leading-relaxed">{children}</p>
    </div>
  );
}

function SpecTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="mb-3 overflow-x-auto rounded-lg border border-lyria-border/70">
      <table className="w-full text-left">
        <thead>
          <tr className="bg-lyria-bg">
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2 font-display text-[10px] font-medium text-lyria-text-muted uppercase tracking-widest whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-lyria-border/50">
              {row.map((cell, j) => (
                <td key={j} className={`px-3 py-2 text-[12px] leading-relaxed ${j === 0 ? 'text-lyria-gold/90 font-medium whitespace-nowrap' : 'text-lyria-text-main/85'}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ————— chapters —————

interface Chapter {
  id: string;
  title: string;
  body: React.ReactNode;
}

const CHAPTERS: Chapter[] = [
  {
    id: 'overview',
    title: 'Overview & Quick Start',
    body: (
      <>
        <P>
          Lyria 3 Pro is a DAW-style interface for Google's Lyria 3 music-generation models. You describe a song in
          text (plus optional lyrics and image references), and one API call returns a finished, fully arranged track
          — vocals, instrumentation, structure, dynamics — which lands in the timeline as a version tab.
        </P>
        <CostWarn>
          Generation is <strong>real, not simulated</strong>. Every Pro request costs <strong>$0.08</strong> and every
          Clip request <strong>$0.04</strong> on your selected provider, whether or not you like the result.
        </CostWarn>
        <H>Quick start</H>
        <UL
          items={[
            <>Open <Chip>SETTINGS</Chip> (the gear, top right) — pick a provider and add an API key if the server doesn't have one. Generation needs an entitled key either way: a billing-enabled Google key, or an OpenRouter account with credits.</>,
            <>Write a style prompt in the <Chip>PROMPT</Chip> box. Be technical: genre, BPM, key, vocal character (see Writing Prompts).</>,
            <>Optionally add lyrics in the <Chip>LYRICS</Chip> box under section tags like <Chip>[Verse 1]</Chip> and <Chip>[Chorus]</Chip>.</>,
            <>Pick your model and settings with the <Chip>MODEL</Chip>, <Chip>DUR</Chip> and <Chip>BATCH</Chip> chips next to the GENERATE button.</>,
            <>Hit <Chip>GENERATE</Chip> (or <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>). The result appears as a new version tab in the timeline — play it with the transport, download it from EXPORT.</>,
          ]}
        />
        <Note>
          Everything you generate is kept forever in the <Chip>HISTORY</Chip> library (right sidebar) — you can reload
          any past generation into a version tab at any time.
        </Note>
      </>
    ),
  },
  {
    id: 'models',
    title: 'Models: Pro vs Clip',
    body: (
      <>
        <P>Two Lyria 3 models are available from the <Chip>MODEL</Chip> chip. Same prompting language, very different output:</P>
        <SpecTable
          head={['', 'Lyria 3 Pro', 'Lyria 3 Clip']}
          rows={[
            ['Purpose', 'Full structured songs', 'Fast 30-second clips, high volume'],
            ['Duration', 'Up to ~3 minutes (prompt-controlled)', 'Fixed ~30 seconds — ignores the DUR chip'],
            ['Audio format', 'Whatever the provider returns — MP3 on OpenRouter', 'Whatever the provider returns — MP3 on OpenRouter'],
            ['Price', '$0.08 per successful request', '$0.04 per clip'],
          ]}
        />
        <P>
          Both output stereo 44.1 kHz audio, and everything carries a SynthID watermark and C2PA metadata.
        </P>
        <Note>
          You do not choose the container. The app detects the format from the bytes the provider actually returned and
          writes that file to disk — on OpenRouter, <strong>both</strong> Pro and Clip come back as MP3, while Google
          documents a WAV response for Pro. Never assume the format; EXPORT serves whatever file was really written.
        </Note>
        <H>What a Pro generation contains</H>
        <P>
          A single request returns a <strong>finished song</strong>, not an editable project: an
          intro/verse/pre-chorus/chorus/bridge/breakdown/outro arrangement, lead vocals with harmonies, your lyrics
          (or generated ones), full instrumentation, and dynamics that change per section. The response also carries
          the generated lyrics and timestamped structural metadata alongside the audio.
        </P>
        <H>When to use which</H>
        <UL
          items={[
            <><strong>Clip</strong> for iterating on a style cheaply — audition ideas at half the price and a fraction of the wait.</>,
            <><strong>Pro</strong> once the prompt is dialed in — full arrangement, full length, and the provider's own file straight to EXPORT.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'prompting',
    title: 'Writing Prompts',
    body: (
      <>
        <P>
          The prompt is the <strong>only</strong> control surface — Lyria 3 has no structure, vocal, or tempo API
          parameters. Everything musical is said in words.
        </P>
        <H>What a prompt can control</H>
        <P>
          Genre and blends · BPM / tempo · key &amp; scale · time signature · instrumentation · vocal range, character,
          texture and delivery · lyric language · instrumental-only · approximate duration · section order ·
          timestamped arrangement · mood, energy curve, dynamics · production style, stereo width, arrangement density.
        </P>
        <H>The recommended prompt shape</H>
        <P>Strong prompts separate four concerns — direction, exclusions, lyrics, and structure:</P>
        <CodeBlock>{`Create a 2 minute 30 second industrial metalcore and electronic track.

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
Full-width guitars, heavy drums, stacked vocal harmonies.`}</CodeBlock>
        <UL
          items={[
            <><strong>Technical direction</strong> — explicit musical language beats vibes: "132 BPM, D minor, low male baritone" &gt; "dark and cool".</>,
            <><strong>Exclusions</strong> — there is no negative-prompt parameter on Lyria 3; put unwanted elements in an explicit "Avoid:" list. This is officially recommended and it works.</>,
            <><strong>Lyrics</strong> — kept separate from instructions, under section tags (the LYRICS box handles this for you).</>,
            <><strong>Structure</strong> — section tags and/or timestamp directives (next chapter).</>,
          ]}
        />
        <Note>
          The wand button on the PROMPT box and the <Chip>AUTO</Chip> enhance toggle can rewrite a short idea into this
          shape for you — see the AI Assist chapter.
        </Note>
      </>
    ),
  },
  {
    id: 'structure',
    title: 'Structure & Timestamps',
    body: (
      <>
        <H>Section tags</H>
        <P>
          <Chip>[Intro]</Chip> <Chip>[Verse 1]</Chip> <Chip>[Pre-Chorus]</Chip> <Chip>[Chorus]</Chip>{' '}
          <Chip>[Verse 2]</Chip> <Chip>[Bridge]</Chip> <Chip>[Breakdown]</Chip> <Chip>[Final Chorus]</Chip>{' '}
          <Chip>[Outro]</Chip>
        </P>
        <P>
          Custom labels also work as long as you describe the musical role. The model adapts content to each section's
          role: choruses hook harder, bridges add harmonic contrast.
        </P>
        <H>Timestamp prompting — the power workflow</H>
        <P>Assign musical events to timed segments. Ideal for genre shifts mid-track and scoring to picture:</P>
        <CodeBlock>{`[00:00] Begin immediately with a massive gospel choir singing a powerful, uplifting harmony.
[00:15] A heavy, modern hip-hop drum beat and a deep 808 bassline drop in.
[00:30] A male lead vocalist begins rapping a confident verse, choir punctuating his lines.
[01:50] The beat strips back to just a gentle Hammond B3 organ; quiet emotional bridge.
[02:10] Full beat and giant choir return at maximum energy, ending on a sustained chord at [03:00].`}</CodeBlock>
        <Note>
          Timestamps <strong>guide</strong> the arrangement — they are not sample-exact guarantees. Expect the shape,
          not the exact second.
        </Note>
        <H>Energy-curve language</H>
        <P>Describing the dynamic arc in plain language works remarkably well:</P>
        <CodeBlock>{`Begin sparse and intimate.
Increase rhythmic density through the pre-chorus.
Open into a wide full-spectrum chorus.
Collapse into a half-time breakdown.
Return with the largest final chorus.`}</CodeBlock>
      </>
    ),
  },
  {
    id: 'lyrics',
    title: 'Lyrics & Vocals',
    body: (
      <>
        <P>
          The <Chip>LYRICS</Chip> box holds sung words under section tags. At request time it is concatenated into the
          final prompt — you never have to merge it yourself.
        </P>
        <H>Languages</H>
        <P>
          Vocals are supported in <strong>8 languages</strong>: English, German, Spanish, French, Hindi, Japanese,
          Korean, Portuguese. The language chip next to the LYRICS header cycles through them; the selection is sent as
          a prompt-side instruction.
        </P>
        <H>The VOCALS toggle</H>
        <P>
          <Chip>VOCALS</Chip> on: the lyrics box is sung. Off: the track generates as an <strong>instrumental</strong> —
          lyrics are not sent and an "Instrumental only — no vocals." directive is added to the request (your prompt
          box text is left untouched).
        </P>
        <H>Directing the voice</H>
        <P>Vocal direction lives in the prompt, and specificity pays. Cover four angles:</P>
        <UL
          items={[
            <><strong>Range / demographics</strong> — "commanding baritone", "clear high soprano".</>,
            <><strong>Texture</strong> — "gravelly", "soulful", "breathy".</>,
            <><strong>Delivery pattern</strong> — "fast-paced", "laid-back groove", "calmer and quieter as the track progresses".</>,
            <><strong>Layering</strong> — stacked harmonies and multi-vocal styles are supported.</>,
          ]}
        />
        <H>Reordering sections</H>
        <P>
          The reorder popover on the lyrics editor moves whole tagged sections up and down. Untagged text before the
          first section tag stays pinned at the top.
        </P>
        <Note>
          Lyric adherence is <strong>not guaranteed</strong> — the model usually follows written lyrics closely, but it
          may compress, repeat, or slightly alter lines to fit the music.
        </Note>
      </>
    ),
  },
  {
    id: 'ai-assist',
    title: 'AI Assist (Wand & AUTO)',
    body: (
      <>
        <P>
          Two text-AI helpers are built into the editors. Both call your selected provider's text model — these are
          paid text calls (fractions of a cent, but not free).
        </P>
        <H>The wand (refine)</H>
        <P>
          The wand button on the PROMPT and LYRICS boxes rewrites text per your instruction. Highlight a passage first
          and only the <strong>selection</strong> is rewritten in place — leave nothing selected and the whole box is
          rewritten. Every AI modification lands in the undo history, so <Chip>↩</Chip> undo / <Chip>↪</Chip> redo
          always gets you back.
        </P>
        <H>AUTO prompt enhance</H>
        <P>
          The <Chip>AUTO</Chip> toggle on the PROMPT box (off by default): when on, the AI expands your prompt into a
          detailed generation prompt <strong>before each generation</strong>. The enhanced text lands in the box first,
          so you always see exactly what was sent.
        </P>
        <Note>
          If enhancement fails while AUTO is on, generation is <strong>cancelled</strong> — nothing is generated or
          charged. Retry, or turn AUTO off to generate with your prompt as-is.
        </Note>
        <H>AUTO lyrics</H>
        <P>
          The lyrics twin: when on, the AI writes or updates the lyrics to match your (possibly just-enhanced) prompt
          before generation fires. Same visibility guarantee — the result lands in the LYRICS box before the music
          request goes out.
        </P>
      </>
    ),
  },
  {
    id: 'images',
    title: 'Image References',
    body: (
      <>
        <P>
          Drop or click to add up to <strong>10 images</strong> in the IMAGE REFERENCES zone. Images are used as
          creative and emotional context — <strong>never</strong> as audio references.
        </P>
        <H>Directing interpretation</H>
        <P>Tell the model how to read the image in your prompt:</P>
        <CodeBlock>{`Interpret: color palette as harmonic mood, visual density as arrangement
density, lighting as brightness and timbre, perceived movement as
rhythmic intensity.`}</CodeBlock>
        <Note>
          There is <strong>no audio input</strong> of any kind. Lyria 3 cannot listen to, continue, or cover an
          uploaded song — this is an API limitation, not a UI one.
        </Note>
      </>
    ),
  },
  {
    id: 'generating',
    title: 'Generating & Cost',
    body: (
      <>
        <P>
          <Chip>GENERATE</Chip> (or <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>) assembles the final prompt server-side — prompt
          text, exclusions, duration target, structure directives, lyrics, language — and fires the request(s).
        </P>
        <H>The setting chips</H>
        <SpecTable
          head={['Chip', 'What it does']}
          rows={[
            ['MODEL', 'Picks Lyria 3 Pro or Clip — each has its own per-track price.'],
            ['DUR', 'Cycles the target duration (1:00 / 2:00 / 3:00). An approximate target only, written into the prompt; disabled for Clip, which is always ~30s.'],
            ['BATCH', 'Versions per generation. Each is a separate, full API call — cost scales linearly.'],
          ]}
        />
        <Note>
          <Chip>DUR</Chip> is a <strong>target the model may not match</strong>. Lyria 3 has no duration parameter, so
          the figure is only prompt-side language, and a track can come back materially longer or shorter than asked.
          Treat the length you receive — and the price — as fixed regardless of what you asked for.
        </Note>
        <CostWarn>
          BATCH ×4 on Pro is 4 parallel requests = <strong>$0.32</strong>. Lyria 3 has no multi-sample parameter, so
          batching is always N full-price calls. The cost readout under GENERATE shows the real spend for your current
          settings.
        </CostWarn>
        <H>Pricing</H>
        <SpecTable
          head={['Model', 'Gemini', 'OpenRouter']}
          rows={[
            ['Lyria 3 Pro', '$0.08 / song', '$0.08 / song'],
            ['Lyria 3 Clip', '$0.04 / clip', '$0.04 / clip'],
          ]}
        />
        <P>
          OpenRouter requires a balance of at least <strong>$0.50</strong> for any audio request — below that it
          refuses before generating, and nothing is charged.
        </P>
        <H>Naming</H>
        <P>
          The optional name field above GENERATE names the next generation; batches of more than one append (2), (3),
          and so on.
        </P>
        <Note>
          There is no seed control — the same prompt can (and will) produce different results between calls. That's
          what BATCH and versions are for.
        </Note>
      </>
    ),
  },
  {
    id: 'versions',
    title: 'Versions & Timeline',
    body: (
      <>
        <P>
          A brand-new project has <strong>no version tabs at all</strong> — the timeline says so plainly instead of
          showing empty placeholders. Your first generation becomes V1, and reopening the project does not renumber
          anything. Every completed generation becomes a <strong>version tab</strong> (V1, V2, …) above the timeline. A
          version is an immutable artifact — it is never edited, only superseded by a newer version.
        </P>
        <P>
          Right-click a tab for <em>Load settings from this version</em>, <em>Rename…</em>, <em>Analyze</em> and{' '}
          <em>Export</em>. Renaming happens inline in the tab itself — <Kbd>Enter</Kbd> saves, <Kbd>Esc</Kbd> cancels —
          with no browser popup.
        </P>
        <H>Why "edit" means "regenerate"</H>
        <P>
          Lyria 3 generation is <strong>single-turn</strong>: the API does not support refining a generated track with
          follow-up prompts, replacing a section in-place, or audio inpainting. So every edit action in this app is
          really <em>new prompt → new full generation → new version</em> — at full generation price.
        </P>
        <H>Analysis — manual and paid</H>
        <P>
          The timeline's sections come from <Chip>ANALYZE</Chip>, which sends the generation's audio to a text model to
          detect genre, mood, energy, BPM, key, instrumentation and timestamped section boundaries. It{' '}
          <strong>never runs on its own</strong>: it happens only when you press ANALYZE in the center panel or pick
          Analyze from a version tab, waveform or HISTORY right-click menu.
        </P>
        <CostWarn>
          Analysis is a <strong>separate paid call</strong> on your selected provider. The result is cached in the
          generation's manifest, so each generation only needs analyzing once. Until you analyze a version, its
          timeline has no sections and the inspector has nothing to select.
        </CostWarn>
        <H>The section inspector</H>
        <P>Select a detected section on the timeline to open the inspector. Its actions append a timed directive to your prompt — visible and undoable there — and queue a new paid generation:</P>
        <SpecTable
          head={['Action', 'Directive it appends']}
          rows={[
            ['REGENERATE', 'Redo this time range with the same intent.'],
            ['EXTEND', 'Lengthen this section.'],
            ['RESTYLE', 'Change this section’s style.'],
            ['REPLACE', 'Swap this section for something new.'],
            ['LOCK SECTION', 'Keep this time range as-is while the rest changes.'],
          ]}
        />
        <Note>
          Directives guide the next generation the same way timestamps do — the new version aims for your instruction,
          but the untouched parts are re-performed, not copied. Expect a sibling, not a surgical edit.
        </Note>
        <H>The waveform</H>
        <P>
          The MASTER lane draws real decoded peaks from the version's actual audio. A version whose audio file cannot
          be read shows a flat line, and EXPORT stays disabled for it. Left-click or drag the lane to scrub.
          Right-clicking it opens a menu — <em>Seek here</em>, <em>Analyze this version</em>, <em>Export this
          version</em> — and <strong>does not move the playhead</strong>; only the explicit Seek here item does. The{' '}
          <Chip>+</Chip> tab fires a fresh generation with your current settings.
        </P>
        <P>
          Under the inspector's actions, LYRICS shows the words actually sung in this generation as the provider
          returned them, with the provider's own structural and timing markup (<Chip>[[A0]]</Chip>, <Chip>[:]</Chip>,{' '}
          <Chip>[2.0:6.1]</Chip>) stripped out before display.
        </P>
      </>
    ),
  },
  {
    id: 'library',
    title: 'Tools, History & Export',
    body: (
      <>
        <H>Tools</H>
        <SpecTable
          head={['Tool', 'What it does']}
          rows={[
            ['CHANGE STYLE', 'Asks for a style instruction, appends that line to the PROMPT box — where you can read and undo it — then generates a new version from it (paid: $0.08 Pro / $0.04 Clip). Nothing is charged until you submit an instruction.'],
            ['EDIT LYRICS', 'Opens and pins the lyrics editor.'],
            ['INSTRUMENTAL', 'Generates one instrumental version (paid): no lyrics are sent and the instrumental directive goes into that single request only. Your prompt box and the VOCALS toggle are left untouched.'],
          ]}
        />
        <H>History — the permanent library</H>
        <P>
          HISTORY lists every generation ever persisted, newest first. Click an entry to load it as a version tab.
          Right-click for more: <em>Load (audio only)</em>, <em>Load with settings</em>, <em>Rename…</em> (inline, in
          the row), <em>Analyze</em>, <em>Download</em>, <em>Remove from list</em>.
        </P>
        <P>
          <em>Load with settings</em> restores the prompt and lyrics plus the chips that produced the take — model,
          and, for takes recorded since those fields existed, language, duration target and batch size. Anything the
          manifest does not record is left as-is rather than reset to a default.
        </P>
        <Note>
          Remove and CLEAR only tidy the list display, and the hidden rows stay hidden after a reload — it is a
          per-browser view preference, and <strong>audio files on disk are never deleted</strong>. Whenever anything is
          hidden, a <Chip>SHOW N HIDDEN</Chip> button appears next to CLEAR and brings every row straight back. A MOCK
          badge marks simulated dev-mode results that no real provider generated.
        </Note>
        <H>Export</H>
        <P>
          EXPORT downloads the active version's <strong>native</strong> generated file — the exact bytes the server
          wrote, with no conversion and no format chooser. The panel reports the real format it detected rather than
          offering you one. The download is named after the track title (sanitized for your filesystem), falling back
          to the generation id. When the active version has no audio, the panel reads <Chip>NO AUDIO YET</Chip> and the
          button is disabled.
        </P>
      </>
    ),
  },
  {
    id: 'settings',
    title: 'Settings & Providers',
    body: (
      <>
        <H>Provider</H>
        <P>
          The AI PROVIDER selector (<Chip>GEMINI</Chip> | <Chip>OPENROUTER</Chip>) routes <strong>everything</strong> —
          prompt/lyric AI assistance, analysis and music generation all go through the selected provider. Generation
          prices are identical on both.
        </P>
        <Note>
          <strong>What each provider needs before it will generate.</strong> Gemini <em>generation</em> requires a{' '}
          <strong>billing-enabled</strong> Google API key: the free tier grants zero Lyria requests per day, so a
          free-tier key fails at once with <Chip>429 Rate limit exceeded for model lyria-3-clip (limit: 0 requests per
          day on Free Tier)</Chip> — a quota wall that retrying never clears. OpenRouter requires account credits and
          refuses audio requests under a <strong>$0.50</strong> balance; it returns MP3 for both Pro and Clip.
        </Note>
        <H>API keys</H>
        <UL
          items={[
            <>A key entered in Settings is saved in <strong>this browser only</strong> and sent with your requests.</>,
            <>A browser-saved key always <strong>overrides</strong> the server's configured key.</>,
            <>Leave a field empty to fall back to the server key (from <Chip>.env.local</Chip>). The status line under each field shows which key is actually in effect.</>,
          ]}
        />
        <H>OpenRouter balance</H>
        <P>
          With OpenRouter configured, Settings shows your live account balance and an estimate of how many songs/clips
          it buys. Audio requests need a balance of at least <strong>$0.50</strong> — below that the request is refused
          up front and nothing is charged.
        </P>
      </>
    ),
  },
  {
    id: 'limitations',
    title: 'Limitations',
    body: (
      <>
        <P>
          These are hard limits of the Lyria 3 API itself — no UI feature can work around them, and this app never
          pretends otherwise.
        </P>
        <UL
          items={[
            <><strong>Single-turn only.</strong> No iterative editing, section replacement, audio inpainting, or follow-up refinement of a generated track.</>,
            <><strong>No audio input.</strong> No conditioning on, continuation of, or covers of uploaded songs.</>,
            <><strong>No stems, MIDI, or chords.</strong> Output is one mixed stereo master.</>,
            <><strong>No seed / reproducibility.</strong> The same prompt may produce different results between calls.</>,
            <><strong>No multi-candidate parameter.</strong> BATCH is N parallel full-price requests.</>,
            <><strong>No guaranteed duration.</strong> DUR and timestamps are prompt-side targets, not parameters the API enforces — the returned track can be materially longer or shorter than asked.</>,
            <><strong>No choice of container.</strong> You get whatever the provider encodes — MP3 for both models on OpenRouter.</>,
            <><strong>Lyric adherence is not guaranteed.</strong></>,
          ]}
        />
        <Note>
          The consequence that shapes this whole app: every "edit" is a new prompt, a new full generation, and a new
          version tab. Craft the prompt, batch the attempts, keep the winners.
        </Note>
      </>
    ),
  },
];

// ————— modal —————

// Portaled to <body> for the same reason as SettingsModal: TopBar's backdrop-blur makes
// it a containing block for fixed-position descendants, which would trap this overlay
// inside the 64px bar.
export function DocsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [chapterIndex, setChapterIndex] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Each chapter starts reading from the top.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [chapterIndex]);

  if (!isOpen) return null;

  const chapter = CHAPTERS[chapterIndex];

  return createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Documentation"
        className="bg-[#110e0c] border border-lyria-border w-[880px] max-w-[94vw] h-[80vh] rounded-2xl shadow-2xl flex overflow-hidden relative"
      >
        {/* Chapter navigation */}
        <nav className="w-56 shrink-0 border-r border-lyria-border bg-lyria-bg/60 flex flex-col">
          <div className="px-4 pt-5 pb-3 border-b border-lyria-border/70">
            <h2 className="font-display text-sm font-light tracking-widest text-white flex items-center gap-2">
              <BookOpen size={16} className="text-lyria-gold" /> DOCS
            </h2>
            <p className="text-[10px] text-lyria-text-muted mt-1 tracking-wide">Lyria 3 Pro &amp; Clip guide</p>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {CHAPTERS.map((c, i) => (
              <button
                key={c.id}
                onClick={() => setChapterIndex(i)}
                title={`Open chapter: ${c.title}`}
                aria-current={i === chapterIndex ? 'page' : undefined}
                className={`w-full flex items-baseline gap-2.5 px-4 py-2 text-left transition-colors duration-150 cursor-pointer lyria-focus-ring ${
                  i === chapterIndex
                    ? 'bg-lyria-gold/10 text-lyria-gold'
                    : 'text-lyria-text-muted hover:text-lyria-text-main hover:bg-white/5'
                }`}
              >
                <span className="font-mono text-[10px] shrink-0 opacity-60">{String(i + 1).padStart(2, '0')}</span>
                <span className="text-[12px] leading-snug">{c.title}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* Chapter content */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-lyria-border/70 shrink-0">
            <h2 className="font-display text-lg font-light tracking-widest text-white uppercase truncate">
              {chapter.title}
            </h2>
            <button
              onClick={onClose}
              title="Close documentation"
              aria-label="Close documentation"
              className="text-lyria-text-muted hover:text-lyria-text-main transition-colors duration-150 cursor-pointer rounded lyria-focus-ring shrink-0 ml-4"
            >
              <X size={20} />
            </button>
          </div>

          <div ref={contentRef} className="flex-1 overflow-y-auto px-6 py-5">
            {chapter.body}
          </div>

          {/* Prev / next chapter footer */}
          <div className="flex items-center justify-between px-6 py-3 border-t border-lyria-border/70 shrink-0">
            {chapterIndex > 0 ? (
              <button
                onClick={() => setChapterIndex(chapterIndex - 1)}
                title={`Previous chapter: ${CHAPTERS[chapterIndex - 1].title}`}
                className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-lyria-text-muted hover:text-lyria-gold transition-colors duration-150 cursor-pointer rounded lyria-focus-ring"
              >
                <ChevronLeft size={14} /> {CHAPTERS[chapterIndex - 1].title}
              </button>
            ) : (
              <span />
            )}
            {chapterIndex < CHAPTERS.length - 1 ? (
              <button
                onClick={() => setChapterIndex(chapterIndex + 1)}
                title={`Next chapter: ${CHAPTERS[chapterIndex + 1].title}`}
                className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-lyria-text-muted hover:text-lyria-gold transition-colors duration-150 cursor-pointer rounded lyria-focus-ring"
              >
                {CHAPTERS[chapterIndex + 1].title} <ChevronRight size={14} />
              </button>
            ) : (
              <span />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
