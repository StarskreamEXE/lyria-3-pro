import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Key, Save, Trash2, Plus, ChevronUp, ChevronDown } from 'lucide-react';
import { getOpenRouterCredits } from '../lib/lyriaClient';
import { loadKeys, saveKeys, type Provider, type StoredKey } from '../lib/apiKeys';

interface ServerKeyStatus {
  geminiServerKey: boolean;
  openRouterServerKey: boolean;
  // Newer servers report how many keys they hold per provider. Older ones report only
  // the booleans above, so the counts are optional and fall back to "1 when true".
  geminiServerKeys?: number;
  openRouterServerKeys?: number;
  defaultProvider: 'gemini' | 'openrouter';
}

// Real per-unit spend, mirrors SidebarLeft's costPerUnit mapping.
const PRO_SONG_COST = 0.08;
const CLIP_COST = 0.04;

// A draft row carries a stable identity that is NOT the key material, so React can move
// the real DOM node when a row is reordered (which keeps keyboard focus on the row the
// user is moving) without ever using a secret as a React key.
interface DraftKey extends StoredKey {
  uid: string;
}

let uidSeq = 0;
const nextUid = () => `draft-key-${++uidSeq}`;

const toDraft = (keys: StoredKey[]): DraftKey[] =>
  keys.map(k => ({ uid: nextUid(), key: k.key, label: k.label }));

// Comparison form for the "unsaved changes" hint: order-sensitive, label-trimmed, and
// never rendered. Only used to compare a draft against what is actually persisted.
const fingerprint = (keys: StoredKey[]) =>
  JSON.stringify(keys.map(k => [k.key, k.label?.trim() || '']));

// "Server: 2 keys" / "Browser: none" — counts only, never key material.
const countLabel = (count: number) => (count === 0 ? 'none' : count === 1 ? '1 key' : `${count} keys`);

// The counts endpoint is being widened concurrently; until then derive a count from the
// old boolean so the line stays honest on either shape.
const serverCountOf = (status: ServerKeyStatus | null, provider: Provider): number | null => {
  if (!status) return null;
  const count = provider === 'gemini' ? status.geminiServerKeys : status.openRouterServerKeys;
  if (typeof count === 'number' && Number.isFinite(count)) return Math.max(0, Math.trunc(count));
  return (provider === 'gemini' ? status.geminiServerKey : status.openRouterServerKey) ? 1 : 0;
};

export function SettingsModal({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
  const [geminiKeys, setGeminiKeys] = useState<DraftKey[]>([]);
  const [openRouterKeys, setOpenRouterKeys] = useState<DraftKey[]>([]);
  // What is actually persisted in localStorage right now, so the status lines can tell
  // "saved" apart from "edited but not saved yet". Never rendered, only compared.
  const [persistedGeminiKeys, setPersistedGeminiKeys] = useState<StoredKey[]>([]);
  const [persistedOpenRouterKeys, setPersistedOpenRouterKeys] = useState<StoredKey[]>([]);
  const [aiProvider, setAiProvider] = useState<'gemini' | 'openrouter'>('gemini');
  const [saved, setSaved] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerKeyStatus | null>(null);
  const [openRouterBalance, setOpenRouterBalance] = useState<number | null>(null);
  // Set as soon as the user picks a provider, so a late /api/settings/status response
  // can never overwrite an explicit choice with the server default.
  const providerChosenRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      // loadKeys migrates a legacy single key (gemini_api_key / openrouter_api_key)
      // into the ordered list, so an existing install opens with its key in position 1.
      const storedGemini = loadKeys('gemini');
      const storedOpenRouter = loadKeys('openrouter');
      setGeminiKeys(toDraft(storedGemini));
      setPersistedGeminiKeys(storedGemini);
      setOpenRouterKeys(toDraft(storedOpenRouter));
      setPersistedOpenRouterKeys(storedOpenRouter);
      const storedProvider = localStorage.getItem('ai_provider');
      const hasStoredProvider = storedProvider === 'openrouter' || storedProvider === 'gemini';
      providerChosenRef.current = hasStoredProvider;
      if (hasStoredProvider) setAiProvider(storedProvider as 'gemini' | 'openrouter');
      setSaved(false);
      setOpenRouterBalance(null);
      fetch('/api/settings/status')
        .then(r => (r.ok ? r.json() : null))
        .then((status: ServerKeyStatus | null) => {
          setServerStatus(status);
          // No stored choice yet: follow the server's own default instead of showing
          // GEMINI regardless of how the server is configured.
          if (!providerChosenRef.current && status && (status.defaultProvider === 'openrouter' || status.defaultProvider === 'gemini')) {
            setAiProvider(status.defaultProvider);
          }
          // The balance readout uses the first stored OpenRouter key (or the server's).
          const hasKey = storedOpenRouter.length > 0 || (serverCountOf(status, 'openrouter') ?? 0) > 0;
          if (hasKey) {
            getOpenRouterCredits()
              .then(credits => setOpenRouterBalance(credits ? credits.balance : null))
              .catch(err => {
                console.warn('Failed to fetch OpenRouter credits:', err);
                setOpenRouterBalance(null);
              });
          }
        })
        .catch(() => setServerStatus(null));
    }
  }, [isOpen]);

  const chooseProvider = (provider: 'gemini' | 'openrouter') => {
    providerChosenRef.current = true;
    setAiProvider(provider);
  };

  const handleSave = () => {
    // saveKeys returns the cleaned list it actually wrote (blanks and duplicates
    // dropped, labels trimmed) and keeps the legacy single-key entry on the first key.
    const cleanedGemini = saveKeys('gemini', geminiKeys.map(({ key, label }) => ({ key, label })));
    const cleanedOpenRouter = saveKeys('openrouter', openRouterKeys.map(({ key, label }) => ({ key, label })));
    setGeminiKeys(toDraft(cleanedGemini));
    setPersistedGeminiKeys(cleanedGemini);
    setOpenRouterKeys(toDraft(cleanedOpenRouter));
    setPersistedOpenRouterKeys(cleanedOpenRouter);
    localStorage.setItem('ai_provider', aiProvider);
    providerChosenRef.current = true;
    // 'storage' only reaches other tabs; tell this one too, so readouts that name
    // the active provider update without waiting for an unrelated re-render.
    window.dispatchEvent(new CustomEvent('lyria-provider-change', { detail: { provider: aiProvider } }));
    setSaved(true);
    setTimeout(() => {
      onClose();
    }, 1000);
  };

  if (!isOpen) return null;

  // Portaled to <body>: TopBar's backdrop-blur makes it a containing block for
  // fixed-position descendants, which would trap this overlay inside the 64px bar.
  return createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-[#110e0c] border border-lyria-border w-[440px] max-h-[85vh] overflow-y-auto rounded-2xl shadow-2xl p-6 relative">
        <button
          onClick={onClose}
          title="Close without saving unsaved changes"
          aria-label="Close settings"
          className="absolute top-4 right-4 text-lyria-text-muted hover:text-lyria-text-main transition-colors duration-150 cursor-pointer rounded lyria-focus-ring"
        >
          <X size={20} />
        </button>

        <h2 className="font-display text-xl font-light tracking-widest text-white mb-6 flex items-center gap-2">
          <SettingsIcon /> SETTINGS
        </h2>

        <div className="space-y-6">
          <div>
            <h3 className="font-display text-sm font-medium text-lyria-gold mb-2 flex items-center gap-2">
              AI PROVIDER
            </h3>
            <p className="text-xs text-lyria-text-muted leading-relaxed mb-4">
              Choose which provider handles AI prompt/lyric assistance and Lyria generation.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => chooseProvider('gemini')}
                title="Which service handles AI assistance and music generation"
                aria-label="Use Gemini as the AI provider"
                aria-pressed={aiProvider === 'gemini'}
                className={`flex-1 rounded-lg py-2 text-xs tracking-widest border transition-colors duration-150 cursor-pointer lyria-focus-ring ${
                  aiProvider === 'gemini'
                    ? 'bg-lyria-gold/20 text-lyria-gold border-lyria-gold/50'
                    : 'bg-[#1a1611] text-lyria-text-muted border-lyria-border/50 hover:text-lyria-text-main'
                }`}
              >
                GEMINI
              </button>
              <button
                onClick={() => chooseProvider('openrouter')}
                title="Which service handles AI assistance and music generation"
                aria-label="Use OpenRouter as the AI provider"
                aria-pressed={aiProvider === 'openrouter'}
                className={`flex-1 rounded-lg py-2 text-xs tracking-widest border transition-colors duration-150 cursor-pointer lyria-focus-ring ${
                  aiProvider === 'openrouter'
                    ? 'bg-lyria-gold/20 text-lyria-gold border-lyria-gold/50'
                    : 'bg-[#1a1611] text-lyria-text-muted border-lyria-border/50 hover:text-lyria-text-main'
                }`}
              >
                OPENROUTER
              </button>
            </div>
          </div>

          <div>
            <h3 className="font-display text-sm font-medium text-lyria-gold mb-2 flex items-center gap-2">
              <Key size={16} /> GEMINI API KEYS
            </h3>
            <KeyStatusLine
              browserCount={geminiKeys.length}
              serverCount={serverCountOf(serverStatus, 'gemini')}
              unsavedEdit={fingerprint(geminiKeys) !== fingerprint(persistedGeminiKeys)}
            />
            <KeyListEditor
              providerLabel="Gemini"
              keys={geminiKeys}
              persistedKeys={persistedGeminiKeys}
              onChange={setGeminiKeys}
              placeholder="AIzaSy..."
            />
          </div>

          <div>
            <h3 className="font-display text-sm font-medium text-lyria-gold mb-2 flex items-center gap-2">
              <Key size={16} /> OPENROUTER API KEYS
            </h3>
            <KeyStatusLine
              browserCount={openRouterKeys.length}
              serverCount={serverCountOf(serverStatus, 'openrouter')}
              unsavedEdit={fingerprint(openRouterKeys) !== fingerprint(persistedOpenRouterKeys)}
            />
            {openRouterBalance !== null && (
              <p title="Live OpenRouter account balance for the first stored key · estimated tracks remaining at current prices" className={`text-[11px] leading-relaxed mb-2 ${openRouterBalance < 0.5 ? 'text-lyria-signal' : 'text-lyria-text-muted'}`}>
                Balance: ${openRouterBalance.toFixed(2)} · ≈{Math.floor(openRouterBalance / PRO_SONG_COST)} songs / {Math.floor(openRouterBalance / CLIP_COST)} clips
                {openRouterBalance < 0.5 ? ' (audio requests need ≥ $0.50)' : ''}
              </p>
            )}
            <KeyListEditor
              providerLabel="OpenRouter"
              keys={openRouterKeys}
              persistedKeys={persistedOpenRouterKeys}
              onChange={setOpenRouterKeys}
              placeholder="sk-or-v1-..."
            />
          </div>

          <p className="text-[11px] text-lyria-text-muted leading-relaxed">
            Keys entered here are saved in this browser and are tried before the server's .env.local keys. Store no keys for a provider to use the server's keys instead.
          </p>

          <button
            onClick={handleSave}
            title="Saves provider choice and API keys to this browser and closes the panel"
            aria-label="Save settings"
            className="flex items-center justify-center gap-2 w-full bg-lyria-gold/20 hover:bg-lyria-gold/30 text-lyria-gold border border-lyria-gold/50 rounded-lg py-2 transition-colors duration-150 cursor-pointer lyria-focus-ring"
          >
            {saved ? 'Saved!' : <><Save size={16} /> Save Settings</>}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Ordered list editor for one provider's keys. A stored key's value is never rendered:
// a row shows its position, its label (or "Key N" while unlabeled) and whether that row
// is saved. The add field is a password input that clears the moment a key is added.
function KeyListEditor({
  providerLabel,
  keys,
  persistedKeys,
  onChange,
  placeholder,
}: {
  providerLabel: string;
  keys: DraftKey[];
  persistedKeys: StoredKey[];
  onChange: (keys: DraftKey[]) => void;
  placeholder: string;
}) {
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [addError, setAddError] = useState('');

  const addKey = () => {
    const key = newKey.trim();
    if (!key) {
      setAddError('Enter a key before adding.');
      return;
    }
    if (keys.some(k => k.key === key)) {
      // Says only that it is a duplicate — never which row, never any of the value.
      setAddError('That key is already in this list.');
      return;
    }
    onChange([...keys, { uid: nextUid(), key, label: newLabel.trim() || undefined }]);
    setNewKey('');
    setNewLabel('');
    setAddError('');
  };

  const moveKey = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= keys.length) return;
    const next = [...keys];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const removeKey = (index: number) => onChange(keys.filter((_, i) => i !== index));

  const relabelKey = (index: number, label: string) =>
    onChange(keys.map((k, i) => (i === index ? { ...k, label } : k)));

  const onAddFieldKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addKey();
    }
  };

  const fieldClass =
    'bg-transparent text-sm text-white placeholder:text-lyria-text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-lyria-gold/70 rounded px-1 py-0.5';
  const iconButtonClass =
    'shrink-0 p-1 rounded border border-lyria-border/50 text-lyria-text-muted transition-colors duration-150 lyria-focus-ring enabled:cursor-pointer enabled:hover:text-lyria-text-main enabled:hover:border-lyria-gold/50 disabled:opacity-30 disabled:cursor-not-allowed';

  return (
    <div>
      {keys.length === 0 ? (
        <p className="text-[11px] text-lyria-text-muted leading-relaxed mb-2">
          No keys stored in this browser for {providerLabel} — the server's keys are used.
        </p>
      ) : (
        <ol className="space-y-2 mb-2">
          {keys.map((entry, index) => (
            <li
              key={entry.uid}
              className="flex items-center gap-2 bg-[#1a1611] border border-lyria-border/50 rounded-lg px-2 py-1.5"
            >
              <span className="w-5 shrink-0 text-center font-mono text-[11px] text-lyria-gold">{index + 1}</span>
              <input
                type="text"
                value={entry.label ?? ''}
                onChange={e => relabelKey(index, e.target.value)}
                placeholder={`Key ${index + 1}`}
                title="Optional name so two keys can be told apart without showing either"
                aria-label={`Label for ${providerLabel} key ${index + 1}`}
                className={`${fieldClass} flex-1 min-w-0`}
              />
              <RowStatus entry={entry} index={index} persistedKeys={persistedKeys} />
              <button
                onClick={() => moveKey(index, -1)}
                disabled={index === 0}
                title="Try this key earlier"
                aria-label={`Move ${providerLabel} key ${index + 1} up`}
                className={iconButtonClass}
              >
                <ChevronUp size={14} />
              </button>
              <button
                onClick={() => moveKey(index, 1)}
                disabled={index === keys.length - 1}
                title="Try this key later"
                aria-label={`Move ${providerLabel} key ${index + 1} down`}
                className={iconButtonClass}
              >
                <ChevronDown size={14} />
              </button>
              <button
                onClick={() => removeKey(index)}
                title="Remove this key from the list"
                aria-label={`Remove ${providerLabel} key ${index + 1}`}
                className="shrink-0 p-1 rounded border border-lyria-border/50 text-lyria-text-muted hover:text-lyria-signal hover:border-lyria-signal/50 transition-colors duration-150 cursor-pointer lyria-focus-ring"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className="flex gap-2">
        <input
          type="password"
          value={newKey}
          onChange={e => {
            setNewKey(e.target.value);
            if (addError) setAddError('');
          }}
          onKeyDown={onAddFieldKeyDown}
          placeholder={placeholder}
          title="Added to the end of the list, then saved in this browser when you press Save Settings"
          aria-label={`New ${providerLabel} API key`}
          className="flex-1 min-w-0 bg-[#1a1611] border border-lyria-border/50 rounded-lg px-3 py-2 text-sm text-white placeholder:text-lyria-text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-lyria-gold/70 focus:border-lyria-gold transition-colors duration-150"
        />
        <input
          type="text"
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          onKeyDown={onAddFieldKeyDown}
          placeholder="label"
          title="Optional name for the new key, for example personal or work"
          aria-label={`Label for the new ${providerLabel} API key`}
          className="w-20 shrink-0 bg-[#1a1611] border border-lyria-border/50 rounded-lg px-2 py-2 text-sm text-white placeholder:text-lyria-text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-lyria-gold/70 focus:border-lyria-gold transition-colors duration-150"
        />
        <button
          onClick={addKey}
          title="Add this key to the end of the list"
          aria-label={`Add ${providerLabel} API key`}
          className="shrink-0 px-3 rounded-lg border border-lyria-gold/50 bg-lyria-gold/20 text-lyria-gold hover:bg-lyria-gold/30 transition-colors duration-150 cursor-pointer lyria-focus-ring"
        >
          <Plus size={16} />
        </button>
      </div>

      {addError ? (
        <p role="alert" className="text-[11px] text-lyria-signal leading-relaxed mt-1">{addError}</p>
      ) : newKey.trim() ? (
        <p className="text-[11px] text-lyria-signal leading-relaxed mt-1">Press Add to put this key in the list.</p>
      ) : null}

      <p className="text-[11px] text-lyria-text-muted leading-relaxed mt-2">
        Keys are tried in this order, and a key that is rejected — invalid, out of credit, or a quota that
        allows zero requests — is skipped for the next one down.
      </p>
    </div>
  );
}

// Per-row honesty marker. Compares the draft row against what is persisted without
// rendering any part of a key: only whether this exact key is stored, and whether its
// position or label still matches what was saved.
function RowStatus({ entry, index, persistedKeys }: { entry: DraftKey; index: number; persistedKeys: StoredKey[] }) {
  const persistedIndex = persistedKeys.findIndex(k => k.key === entry.key);
  let status: string;
  if (persistedIndex === -1) status = 'New';
  else if (persistedIndex !== index) status = 'Moved';
  else if ((persistedKeys[persistedIndex].label || '') !== (entry.label?.trim() || '')) status = 'Renamed';
  else status = 'Saved';
  return (
    <span
      title={status === 'Saved' ? 'Stored in this browser' : 'Not saved yet — press Save Settings'}
      className={`shrink-0 text-[10px] tracking-wide ${status === 'Saved' ? 'text-lyria-text-muted' : 'text-lyria-signal'}`}
    >
      {status}
    </span>
  );
}

// Reports only counts: how many keys are persisted in this browser and how many the
// server holds. A key that has merely been typed or added to the draft list is reported
// as unsaved, never as saved, and no key material (not even a suffix) is ever rendered.
function KeyStatusLine({
  browserCount,
  serverCount,
  unsavedEdit,
}: {
  browserCount: number;
  serverCount: number | null;
  unsavedEdit: boolean;
}) {
  const serverPart = serverCount === null ? 'Server: unknown' : `Server: ${countLabel(serverCount)}`;
  return (
    <p title="Which keys will be used: the browser list is tried first, in order, then the server's keys" className="text-[11px] leading-relaxed mb-2">
      <span className={browserCount > 0 ? 'text-lyria-gold' : 'text-lyria-text-muted'}>Browser: {countLabel(browserCount)}</span>
      <span className="text-lyria-text-muted"> · </span>
      <span className={serverCount ? 'text-lyria-gold' : 'text-lyria-text-muted'}>{serverPart}</span>
      {unsavedEdit && (
        <>
          <span className="text-lyria-text-muted"> · </span>
          <span className="text-lyria-signal">Unsaved changes — press Save Settings</span>
        </>
      )}
    </p>
  );
}

function SettingsIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  );
}
