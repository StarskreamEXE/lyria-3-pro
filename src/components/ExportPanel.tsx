import React from 'react';
import { Download } from 'lucide-react';

// Windows rejects \ / : * ? " < > | in file names, plus control characters, and it
// silently trims trailing dots and spaces. Path separators are replaced (never kept)
// so a title can't escape the download folder. Length is capped well below the 255-byte
// name limit so the extension always survives.
const MAX_NAME_LENGTH = 80;

export function sanitizeExportName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_NAME_LENGTH);
  // Re-trim: the slice above can leave a trailing space or dot behind.
  return cleaned.replace(/[. ]+$/, '').trim();
}

export function ExportPanel({
  version = 1,
  audioUrl = null,
  fileFormat = null,
  title = null,
  versionId = null,
}: {
  version?: number;
  // Kept on the prop type because CenterPanel still passes it; the panel no longer
  // branches on the model, since export only ever downloads the server's own file.
  model?: string;
  audioUrl?: string | null;
  fileFormat?: string | null;
  // Optional track title and generation id, used to name the downloaded file.
  title?: string | null;
  versionId?: string | null;
}) {
  const hasAudio = Boolean(audioUrl);

  // Export never converts: it downloads the exact file the server generated, so the
  // format is reported, not chosen. Prefer the version's own `format` field (carried on
  // the payload) over parsing audioUrl, whose extension parse breaks on query strings;
  // the URL path (query/hash stripped) is only a fallback for older entries.
  const nativeExt = (
    fileFormat || (audioUrl ? audioUrl.split(/[?#]/)[0].split('.').pop() || '' : '')
  ).toLowerCase();
  const nativeFormat = nativeExt ? nativeExt.toUpperCase() : null;

  const handleExport = () => {
    if (!audioUrl) return; // button is disabled in this state; guard for keyboard/programmatic calls
    const a = document.createElement('a');
    a.href = audioUrl;
    const ext = nativeExt || 'wav';
    // Name the file after the track title when there is one, then the generation id,
    // then the tab number — the extension always stays the server's real one.
    const base = sanitizeExportName(title || '') || sanitizeExportName(versionId || '') || `lyria-v${version}`;
    a.download = `${base}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
  };

  const exportTitle = hasAudio
    ? "Downloads this version's audio file (the exact file the server generated)"
    : 'Nothing to export yet — this version has no generated audio';

  return (
    <div className="shrink-0 bg-[#110e0c]/85 backdrop-blur-lg rounded-xl border border-[#2b2521] p-3 flex flex-col gap-2.5 shadow-[0_4px_20px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)] relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-t from-[#14110f] to-transparent opacity-50 pointer-events-none"></div>

      <div className="flex items-center justify-between relative z-10">
        <span className="font-display text-[10px] text-lyria-text-muted uppercase tracking-widest font-medium">EXPORT</span>
        {/* version 0 is the "no version loaded" sentinel — show a dash, never "V0". */}
        <span title="Version number this export applies to" className="text-[9px] text-lyria-text-muted font-mono">{version > 0 ? `V${version}` : '—'}</span>
      </div>

      {/* Format — reported, not selectable: only the server's native file can be downloaded. */}
      <div
        title={hasAudio
          ? 'The actual file format the server generated — export downloads this exact file, it never converts'
          : 'The format is known once this version has generated audio'}
        className="flex items-center justify-between h-7 px-2.5 rounded-lg border border-[#2b2521] bg-[#14110f] relative z-10"
      >
        <span className="text-[9px] tracking-widest text-lyria-text-muted uppercase">FORMAT</span>
        <span className={`text-[9px] font-mono tracking-widest ${hasAudio ? 'text-lyria-gold' : 'text-lyria-text-muted'}`}>
          {hasAudio ? `${nativeFormat} (server native)` : 'NO AUDIO YET'}
        </span>
      </div>

      {/* Export action */}
      <button
        onClick={handleExport}
        disabled={!hasAudio}
        title={exportTitle}
        aria-label={hasAudio
          ? `Export version ${version} as ${nativeFormat}`
          : `Export version ${version} (unavailable — no generated audio)`}
        className={`h-9 rounded-lg border flex items-center justify-center gap-2 transition-colors duration-150 relative z-10 lyria-focus-ring ${
          hasAudio
            ? 'border-lyria-gold/40 bg-gradient-to-b from-lyria-gold/10 to-transparent hover:border-lyria-gold/60 active:scale-[0.98] cursor-pointer'
            : 'border-[#2b2521] bg-[#14110f] opacity-60 cursor-not-allowed'
        }`}
      >
        <Download size={12} className={hasAudio ? 'text-lyria-gold' : 'text-lyria-text-muted'} />
        <span className={`text-[10px] tracking-[0.2em] font-medium uppercase ${hasAudio ? 'text-lyria-gold' : 'text-lyria-text-muted'}`}>
          {hasAudio ? `EXPORT ${nativeFormat}` : 'EXPORT'}
        </span>
      </button>
    </div>
  );
}
