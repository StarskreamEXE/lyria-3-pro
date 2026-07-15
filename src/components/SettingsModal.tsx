import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Key, Save, Trash2 } from 'lucide-react';
import { getOpenRouterCredits } from '../lib/lyriaClient';

interface ServerKeyStatus {
  geminiServerKey: boolean;
  openRouterServerKey: boolean;
  defaultProvider: 'gemini' | 'openrouter';
}

// Real per-unit spend, mirrors SidebarLeft's costPerUnit mapping.
const PRO_SONG_COST = 0.08;
const CLIP_COST = 0.04;

export function SettingsModal({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [openRouterApiKey, setOpenRouterApiKey] = useState('');
  const [aiProvider, setAiProvider] = useState<'gemini' | 'openrouter'>('gemini');
  const [saved, setSaved] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerKeyStatus | null>(null);
  const [openRouterBalance, setOpenRouterBalance] = useState<number | null>(null);

  useEffect(() => {
    if (isOpen) {
      const stored = localStorage.getItem('gemini_api_key');
      setApiKey(stored || '');
      const storedOpenRouter = localStorage.getItem('openrouter_api_key');
      setOpenRouterApiKey(storedOpenRouter || '');
      const storedProvider = localStorage.getItem('ai_provider');
      setAiProvider(storedProvider === 'openrouter' ? 'openrouter' : 'gemini');
      setSaved(false);
      setOpenRouterBalance(null);
      fetch('/api/settings/status')
        .then(r => (r.ok ? r.json() : null))
        .then((status: ServerKeyStatus | null) => {
          setServerStatus(status);
          const hasKey = Boolean(storedOpenRouter) || Boolean(status?.openRouterServerKey);
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

  const handleSave = () => {
    localStorage.setItem('gemini_api_key', apiKey.trim());
    localStorage.setItem('openrouter_api_key', openRouterApiKey.trim());
    localStorage.setItem('ai_provider', aiProvider);
    setSaved(true);
    setTimeout(() => {
      onClose();
    }, 1000);
  };

  const clearGeminiKey = () => {
    setApiKey('');
    localStorage.removeItem('gemini_api_key');
  };

  const clearOpenRouterKey = () => {
    setOpenRouterApiKey('');
    localStorage.removeItem('openrouter_api_key');
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
                onClick={() => setAiProvider('gemini')}
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
                onClick={() => setAiProvider('openrouter')}
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
              <Key size={16} /> GEMINI API KEY
            </h3>
            <KeyStatusLine
              browserKey={apiKey}
              serverConfigured={serverStatus ? serverStatus.geminiServerKey : null}
            />
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="AIzaSy..."
                title="Saved in this browser's localStorage and sent with your requests, overriding the server's .env.local key"
                aria-label="Gemini API key"
                className="flex-1 bg-[#1a1611] border border-lyria-border/50 rounded-lg p-3 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-lyria-gold/70 focus:border-lyria-gold transition-colors duration-150"
              />
              {apiKey && (
                <button
                  onClick={clearGeminiKey}
                  title="Clear the browser-saved key (the server key takes over)"
                  aria-label="Clear saved Gemini API key"
                  className="px-3 rounded-lg border border-lyria-border/50 text-lyria-text-muted hover:text-lyria-signal hover:border-lyria-signal/50 transition-colors duration-150 cursor-pointer lyria-focus-ring"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          </div>

          <div>
            <h3 className="font-display text-sm font-medium text-lyria-gold mb-2 flex items-center gap-2">
              <Key size={16} /> OPENROUTER API KEY
            </h3>
            <KeyStatusLine
              browserKey={openRouterApiKey}
              serverConfigured={serverStatus ? serverStatus.openRouterServerKey : null}
            />
            {openRouterBalance !== null && (
              <p title="Live OpenRouter account balance · estimated tracks remaining at current prices" className={`text-[11px] leading-relaxed mb-2 ${openRouterBalance < 0.5 ? 'text-lyria-signal' : 'text-lyria-text-muted'}`}>
                Balance: ${openRouterBalance.toFixed(2)} · ≈{Math.floor(openRouterBalance / PRO_SONG_COST)} songs / {Math.floor(openRouterBalance / CLIP_COST)} clips
                {openRouterBalance < 0.5 ? ' (audio requests need ≥ $0.50)' : ''}
              </p>
            )}
            <div className="flex gap-2">
              <input
                type="password"
                value={openRouterApiKey}
                onChange={(e) => setOpenRouterApiKey(e.target.value)}
                placeholder="sk-or-v1-..."
                title="Saved in this browser's localStorage and sent with your requests, overriding the server's .env.local key"
                aria-label="OpenRouter API key"
                className="flex-1 bg-[#1a1611] border border-lyria-border/50 rounded-lg p-3 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-lyria-gold/70 focus:border-lyria-gold transition-colors duration-150"
              />
              {openRouterApiKey && (
                <button
                  onClick={clearOpenRouterKey}
                  title="Clear the browser-saved key (the server key takes over)"
                  aria-label="Clear saved OpenRouter API key"
                  className="px-3 rounded-lg border border-lyria-border/50 text-lyria-text-muted hover:text-lyria-signal hover:border-lyria-signal/50 transition-colors duration-150 cursor-pointer lyria-focus-ring"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          </div>

          <p className="text-[11px] text-lyria-text-muted leading-relaxed">
            A key entered here is saved in this browser and overrides the server key for your requests. Leave a field empty to use the server key from .env.local.
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

function KeyStatusLine({ browserKey, serverConfigured }: { browserKey: string; serverConfigured: boolean | null }) {
  const browserPart = browserKey
    ? `Browser: saved (••••${browserKey.slice(-4)}) — overrides server`
    : 'Browser: none';
  const serverPart =
    serverConfigured === null ? 'Server: unknown' : serverConfigured ? 'Server: configured ✓' : 'Server: not configured';
  return (
    <p title="Which key will actually be used: a browser-saved key always overrides the server's .env.local key" className="text-[11px] leading-relaxed mb-2">
      <span className={browserKey ? 'text-lyria-gold' : 'text-lyria-text-muted'}>{browserPart}</span>
      <span className="text-lyria-text-muted"> · </span>
      <span className={serverConfigured ? 'text-lyria-gold' : 'text-lyria-text-muted'}>{serverPart}</span>
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
