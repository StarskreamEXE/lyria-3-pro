import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadKeys, saveKeys, keyListHeaderValue, withKeyHeaders, LIST_HEADER } from './apiKeys';
import type { StoredKey } from './apiKeys';

// vitest runs with environment: 'node', so there is no DOM localStorage. These
// modules only need the four methods they call, backed by a Map.
interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

let store: Map<string, string>;

function installStorage(overrides: Partial<FakeStorage> = {}) {
  const storage: FakeStorage = {
    getItem: key => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: key => void store.delete(key),
    clear: () => store.clear(),
    ...overrides,
  };
  (globalThis as { localStorage?: FakeStorage }).localStorage = storage;
}

beforeEach(() => {
  store = new Map();
  installStorage();
});

afterEach(() => {
  delete (globalThis as { localStorage?: FakeStorage }).localStorage;
  store.clear();
});

describe('loadKeys', () => {
  it('returns [] for empty storage', () => {
    expect(loadKeys('gemini')).toEqual([]);
    expect(loadKeys('openrouter')).toEqual([]);
  });

  it('reads a stored list of plain strings', () => {
    store.set('gemini_api_keys', JSON.stringify(['key-a', 'key-b']));
    expect(loadKeys('gemini')).toEqual([{ key: 'key-a', label: undefined }, { key: 'key-b', label: undefined }]);
  });

  it('reads a stored list of objects, keeping labels', () => {
    store.set('openrouter_api_keys', JSON.stringify([{ key: 'key-a', label: 'work' }, { key: 'key-b' }]));
    expect(loadKeys('openrouter')).toEqual([{ key: 'key-a', label: 'work' }, { key: 'key-b', label: undefined }]);
  });

  it('reads a mixed list of strings and objects', () => {
    store.set('gemini_api_keys', JSON.stringify(['key-a', { key: 'key-b', label: 'spare' }]));
    expect(loadKeys('gemini')).toEqual([{ key: 'key-a', label: undefined }, { key: 'key-b', label: 'spare' }]);
  });

  it('trims keys and labels, dropping a label that is only whitespace', () => {
    store.set('gemini_api_keys', JSON.stringify([{ key: '  key-a  ', label: '  work  ' }, { key: 'key-b', label: '   ' }]));
    expect(loadKeys('gemini')).toEqual([{ key: 'key-a', label: 'work' }, { key: 'key-b', label: undefined }]);
  });

  it('drops entries with a blank or non-string key', () => {
    store.set('gemini_api_keys', JSON.stringify(['', '   ', { key: '' }, { key: 5 }, null, 'key-a']));
    expect(loadKeys('gemini')).toEqual([{ key: 'key-a', label: undefined }]);
  });

  it('returns [] for malformed JSON', () => {
    store.set('gemini_api_keys', '{not json');
    expect(loadKeys('gemini')).toEqual([]);
  });

  it('returns [] when the stored JSON is not an array', () => {
    store.set('gemini_api_keys', JSON.stringify({ key: 'key-a' }));
    expect(loadKeys('gemini')).toEqual([]);
  });

  it('migrates a legacy single key into the list shape', () => {
    store.set('gemini_api_key', '  legacy-key  ');
    expect(loadKeys('gemini')).toEqual([{ key: 'legacy-key' }]);
    store.set('openrouter_api_key', 'legacy-or');
    expect(loadKeys('openrouter')).toEqual([{ key: 'legacy-or' }]);
  });

  it('ignores a blank legacy key', () => {
    store.set('gemini_api_key', '   ');
    expect(loadKeys('gemini')).toEqual([]);
  });

  it('prefers the list over the legacy key when both exist', () => {
    store.set('gemini_api_keys', JSON.stringify(['key-a']));
    store.set('gemini_api_key', 'legacy-key');
    expect(loadKeys('gemini')).toEqual([{ key: 'key-a', label: undefined }]);
  });

  it('falls back to the legacy key when the list is present but empty', () => {
    store.set('gemini_api_keys', JSON.stringify([]));
    store.set('gemini_api_key', 'legacy-key');
    expect(loadKeys('gemini')).toEqual([{ key: 'legacy-key' }]);
  });

  it('keeps providers separate', () => {
    store.set('gemini_api_keys', JSON.stringify(['gem-key']));
    expect(loadKeys('openrouter')).toEqual([]);
  });

  it('returns [] when storage is unavailable', () => {
    delete (globalThis as { localStorage?: FakeStorage }).localStorage;
    expect(loadKeys('gemini')).toEqual([]);
  });
});

describe('saveKeys', () => {
  it('writes the list and returns the cleaned keys', () => {
    const cleaned = saveKeys('gemini', [{ key: 'key-a', label: 'work' }, { key: 'key-b' }]);
    expect(cleaned).toEqual([{ key: 'key-a', label: 'work' }, { key: 'key-b', label: undefined }]);
    expect(JSON.parse(store.get('gemini_api_keys') as string)).toEqual([
      { key: 'key-a', label: 'work' },
      { key: 'key-b' },
    ]);
  });

  it('drops blanks, trims and de-duplicates while keeping order', () => {
    const cleaned = saveKeys('gemini', [
      { key: '  key-b  ' },
      { key: '' },
      { key: '   ' },
      { key: 'key-a' },
      { key: 'key-b' },
      { key: '  key-a  ', label: ' later ' },
    ]);
    expect(cleaned).toEqual([{ key: 'key-b', label: undefined }, { key: 'key-a', label: undefined }]);
  });

  it('trims labels and drops whitespace-only ones', () => {
    expect(saveKeys('gemini', [{ key: 'key-a', label: '  work  ' }, { key: 'key-b', label: '  ' }])).toEqual([
      { key: 'key-a', label: 'work' },
      { key: 'key-b', label: undefined },
    ]);
  });

  it('mirrors the first key into the legacy entry', () => {
    saveKeys('openrouter', [{ key: 'key-a' }, { key: 'key-b' }]);
    expect(store.get('openrouter_api_key')).toBe('key-a');
    expect(store.get('gemini_api_key')).toBeUndefined();
  });

  it('removes the legacy entry when the cleaned list is empty', () => {
    store.set('gemini_api_key', 'legacy-key');
    expect(saveKeys('gemini', [])).toEqual([]);
    expect(store.has('gemini_api_key')).toBe(false);
    expect(store.get('gemini_api_keys')).toBe('[]');
  });

  it('removes the legacy entry when every supplied key is blank', () => {
    store.set('gemini_api_key', 'legacy-key');
    expect(saveKeys('gemini', [{ key: '   ' }])).toEqual([]);
    expect(store.has('gemini_api_key')).toBe(false);
  });

  it('round-trips through loadKeys', () => {
    saveKeys('gemini', [{ key: 'key-a', label: 'work' }, { key: 'key-b' }]);
    expect(loadKeys('gemini')).toEqual([{ key: 'key-a', label: 'work' }, { key: 'key-b', label: undefined }]);
  });

  it('does not throw when storage throws, and still returns the cleaned list', () => {
    installStorage({
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(saveKeys('gemini', [{ key: 'key-a' }])).toEqual([{ key: 'key-a', label: undefined }]);
    expect(saveKeys('gemini', [])).toEqual([]);
  });

  it('does not throw when storage is missing entirely', () => {
    delete (globalThis as { localStorage?: FakeStorage }).localStorage;
    expect(saveKeys('gemini', [{ key: 'key-a' }])).toEqual([{ key: 'key-a', label: undefined }]);
  });
});

describe('keyListHeaderValue', () => {
  it('joins the stored keys with commas, in order', () => {
    saveKeys('gemini', [{ key: 'key-a' }, { key: 'key-b' }, { key: 'key-c' }]);
    expect(keyListHeaderValue('gemini')).toBe('key-a,key-b,key-c');
  });

  it('is empty when nothing is stored', () => {
    expect(keyListHeaderValue('gemini')).toBe('');
    expect(keyListHeaderValue('openrouter')).toBe('');
  });

  it('includes a migrated legacy key', () => {
    store.set('openrouter_api_key', 'legacy-or');
    expect(keyListHeaderValue('openrouter')).toBe('legacy-or');
  });
});

describe('withKeyHeaders', () => {
  it('exposes the expected header names', () => {
    expect(LIST_HEADER).toEqual({ gemini: 'x-gemini-api-keys', openrouter: 'x-openrouter-api-keys' });
  });

  it('adds both providers when both have stored keys', () => {
    saveKeys('gemini', [{ key: 'gem-1' }, { key: 'gem-2' }]);
    saveKeys('openrouter', [{ key: 'or-1' }]);
    expect(withKeyHeaders({})).toEqual({
      'x-gemini-api-keys': 'gem-1,gem-2',
      'x-openrouter-api-keys': 'or-1',
    });
  });

  it('adds only the provider that has keys', () => {
    saveKeys('openrouter', [{ key: 'or-1' }]);
    expect(withKeyHeaders({})).toEqual({ 'x-openrouter-api-keys': 'or-1' });
  });

  it('adds no header when nothing is stored', () => {
    expect(withKeyHeaders({})).toEqual({});
  });

  it('preserves existing headers and returns the same object', () => {
    saveKeys('gemini', [{ key: 'gem-1' }]);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-ai-provider': 'gemini' };
    const result = withKeyHeaders(headers);
    expect(result).toBe(headers);
    expect(result).toEqual({
      'content-type': 'application/json',
      'x-ai-provider': 'gemini',
      'x-gemini-api-keys': 'gem-1',
    });
  });

  it('keeps key order as stored', () => {
    const keys: StoredKey[] = [{ key: 'gem-3' }, { key: 'gem-1' }, { key: 'gem-2' }];
    saveKeys('gemini', keys);
    expect(withKeyHeaders({})['x-gemini-api-keys']).toBe('gem-3,gem-1,gem-2');
  });
});
