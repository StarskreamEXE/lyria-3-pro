import React, { useState, useEffect } from 'react';
import { Download } from 'lucide-react';

const FORMATS = ['WAV', 'MP3'];

export function ExportPanel({ version = 1, model = 'LYRIA 3 PRO', audioUrl = null, fileFormat = null }: { version?: number; model?: string; audioUrl?: string | null; fileFormat?: string | null }) {
  const [format, setFormat] = useState('WAV');

  // Native WAV output is documented for Lyria 3 Pro only
  const wavDisabled = model === 'LYRIA 3 CLIP';

  // The export button never converts audio — it only downloads the file the server
  // already generated. Prefer the version's own `format` field (carried on the payload)
  // over parsing audioUrl, whose extension parse breaks on query strings; the URL path
  // (query/hash stripped) is only a fallback for older entries without a format field.
  const nativeExt = fileFormat
    ? fileFormat.toUpperCase()
    : audioUrl
      ? (audioUrl.split(/[?#]/)[0].split('.').pop() || '').toUpperCase()
      : null;
  const nativeFormat = nativeExt === 'MP3' ? 'MP3' : 'WAV'; // default assumption before any audio exists

  useEffect(() => {
    if (audioUrl != null) {
      // Only one chip is ever real once audio exists — keep selection in sync with it.
      setFormat(nativeFormat);
    } else if (wavDisabled && format === 'WAV') {
      setFormat('MP3');
    }
  }, [wavDisabled, audioUrl, nativeFormat, format]);

  const handleExport = () => {
    if (!audioUrl) { alert('This version has no generated audio yet — generate first.'); return; }
    const a = document.createElement('a');
    a.href = audioUrl;
    // Same precedence as nativeExt above: real format field first, then the
    // query/hash-stripped URL path extension as a fallback.
    const ext = (fileFormat || audioUrl.split(/[?#]/)[0].split('.').pop() || 'wav').toLowerCase();
    a.download = `lyria-v${version}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
  };

  return (
    <div className="shrink-0 bg-[#110e0c]/85 backdrop-blur-lg rounded-xl border border-[#2b2521] p-3 flex flex-col gap-2.5 shadow-[0_4px_20px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)] relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-t from-[#14110f] to-transparent opacity-50 pointer-events-none"></div>

      <div className="flex items-center justify-between relative z-10">
        <span className="font-display text-[10px] text-lyria-text-muted uppercase tracking-widest font-medium">EXPORT</span>
        <span title="Version number this export applies to" className="text-[9px] text-lyria-text-muted font-mono">V{version}</span>
      </div>

      {/* Format */}
      <div className="grid grid-cols-2 gap-1.5 relative z-10">
        {FORMATS.map((f) => {
          // WAV is disabled for CLIP versions (product rule); whichever chip doesn't
          // match the server's actual file is also disabled, since export never
          // converts — it only downloads what the server generated.
          const wrongNativeFormat = audioUrl != null && f !== nativeFormat;
          const disabled = (f === 'WAV' && wavDisabled) || wrongNativeFormat;
          const title = f === 'WAV' && wavDisabled
            ? 'Native WAV requires Lyria 3 Pro — this version was generated as Clip'
            : wrongNativeFormat
              ? `Unavailable — the server generated this version as ${nativeFormat}, and export never converts formats`
              : `Selects ${f} as the export format`;
          return (
            <button
              key={f}
              onClick={() => { if (!disabled) setFormat(f); }}
              disabled={disabled}
              title={title}
              aria-label={`${f} export format${disabled ? ' (unavailable)' : format === f ? ' (selected)' : ''}`}
              aria-pressed={format === f}
              className={`h-7 rounded-lg border text-[9px] font-medium tracking-widest transition-colors duration-150 lyria-focus-ring ${
                disabled
                  ? 'border-[#2b2521] bg-[#14110f] text-lyria-text-muted cursor-not-allowed'
                  : format === f
                    ? 'border-lyria-gold/60 bg-lyria-gold/10 text-lyria-gold shadow-[0_0_10px_rgba(214,180,133,0.15)] cursor-pointer active:scale-95'
                    : 'border-[#2b2521] bg-[#14110f] text-lyria-text-muted hover:text-lyria-text-main hover:border-[#38302b] cursor-pointer active:scale-95'
              }`}
            >
              {f}
            </button>
          );
        })}
      </div>
      {audioUrl != null && (
        <span title="The actual file format the server generated — export downloads this exact file" className="text-[8px] text-lyria-text-muted font-mono -mt-1.5 relative z-10">
          server file is {nativeFormat}
        </span>
      )}

      {/* Export action */}
      <button
        onClick={handleExport}
        title="Downloads this version's audio file (the exact file the server generated)"
        aria-label={`Export version ${version} as ${format}`}
        className="h-9 rounded-lg border border-lyria-gold/40 bg-gradient-to-b from-lyria-gold/10 to-transparent flex items-center justify-center gap-2 hover:border-lyria-gold/60 transition-colors duration-150 active:scale-[0.98] relative z-10 cursor-pointer lyria-focus-ring"
      >
        <Download size={12} className="text-lyria-gold" />
        <span className="text-[10px] tracking-[0.2em] font-medium text-lyria-gold uppercase">
          EXPORT {format}
        </span>
      </button>
    </div>
  );
}
