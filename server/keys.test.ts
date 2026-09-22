import { describe, it, expect, vi } from 'vitest';
import {
  parseKeyList,
  resolveKeys,
  numberedEnvValues,
  isKeyFault,
  describeFailure,
  withKeyFailover,
  AllKeysFailedError,
} from './keys';
import type { KeyAttempt } from './keys';

/** Fake provider error carrying an HTTP status, like the fetch wrappers throw. */
const httpError = (status: number, message = 'provider said no') =>
  Object.assign(new Error(message), { status });

describe('parseKeyList', () => {
  it('splits on commas', () => {
    expect(parseKeyList('a-one,a-two,a-three')).toEqual(['a-one', 'a-two', 'a-three']);
  });

  it('splits on newlines, including CRLF', () => {
    expect(parseKeyList('a-one\na-two\r\na-three')).toEqual(['a-one', 'a-two', 'a-three']);
  });

  it('splits on a mix of commas and newlines', () => {
    expect(parseKeyList('a-one,a-two\na-three,\na-four')).toEqual(['a-one', 'a-two', 'a-three', 'a-four']);
  });

  it('trims surrounding whitespace', () => {
    expect(parseKeyList('  a-one  ,\t a-two \n   a-three   ')).toEqual(['a-one', 'a-two', 'a-three']);
  });

  it('drops blank entries and separator runs', () => {
    expect(parseKeyList(',,a-one,,\n\n,a-two,')).toEqual(['a-one', 'a-two']);
    expect(parseKeyList('   ')).toEqual([]);
    expect(parseKeyList(',\n,')).toEqual([]);
  });

  it('drops duplicates, keeping first position', () => {
    expect(parseKeyList('a-one,a-two,a-one,a-two,a-three')).toEqual(['a-one', 'a-two', 'a-three']);
  });

  it('drops the .env.example placeholder values', () => {
    expect(parseKeyList('MY_GEMINI_API_KEY')).toEqual([]);
    expect(parseKeyList('MY_OPENROUTER_API_KEY')).toEqual([]);
    expect(parseKeyList('your-key-here')).toEqual([]);
    expect(parseKeyList('MY_GEMINI_API_KEY,a-real,your-key-here')).toEqual(['a-real']);
  });

  it('keeps values that merely contain a placeholder as a substring', () => {
    expect(parseKeyList('MY_GEMINI_API_KEY_REAL')).toEqual(['MY_GEMINI_API_KEY_REAL']);
  });

  it('returns [] for null, undefined and empty string', () => {
    expect(parseKeyList(null)).toEqual([]);
    expect(parseKeyList(undefined)).toEqual([]);
    expect(parseKeyList('')).toEqual([]);
  });
});

describe('resolveKeys', () => {
  it('orders list header, single header, env, then numbered env', () => {
    expect(
      resolveKeys({
        listHeader: 'hdr-1,hdr-2',
        singleHeader: 'single-1',
        env: 'env-1,env-2',
        numberedEnv: ['num-2', 'num-3'],
      }),
    ).toEqual(['hdr-1', 'hdr-2', 'single-1', 'env-1', 'env-2', 'num-2', 'num-3']);
  });

  it('falls through to the next source when higher ones are absent', () => {
    expect(resolveKeys({ env: 'env-1' })).toEqual(['env-1']);
    expect(resolveKeys({ singleHeader: 'single-1', env: 'env-1' })).toEqual(['single-1', 'env-1']);
    expect(resolveKeys({ numberedEnv: ['num-2'] })).toEqual(['num-2']);
  });

  it('de-duplicates across sources, keeping the highest-priority position', () => {
    expect(
      resolveKeys({
        listHeader: 'shared,hdr-2',
        singleHeader: 'shared',
        env: 'hdr-2,env-1',
        numberedEnv: ['shared', 'env-1', 'num-4'],
      }),
    ).toEqual(['shared', 'hdr-2', 'env-1', 'num-4']);
  });

  it('skips undefined numbered env slots', () => {
    expect(resolveKeys({ numberedEnv: [undefined, 'num-3', undefined] })).toEqual(['num-3']);
  });

  it('returns [] when every source is empty, blank or a placeholder', () => {
    expect(resolveKeys({})).toEqual([]);
    expect(resolveKeys({ listHeader: '', singleHeader: '   ', env: ',,', numberedEnv: [] })).toEqual([]);
    expect(resolveKeys({ env: 'MY_GEMINI_API_KEY', numberedEnv: ['your-key-here'] })).toEqual([]);
  });
});

describe('numberedEnvValues', () => {
  it('reads _2 upward in order', () => {
    const env = { K_2: 'two', K_3: 'three' } as unknown as NodeJS.ProcessEnv;
    expect(numberedEnvValues(env, 'K')).toEqual(['two', 'three']);
  });

  it('keeps reading across a gap (_2 and _4 present, _3 missing)', () => {
    const env = { K_2: 'two', K_4: 'four' } as unknown as NodeJS.ProcessEnv;
    expect(numberedEnvValues(env, 'K')).toEqual(['two', 'four']);
  });

  it('ignores the unnumbered variable and blank values', () => {
    const env = { K: 'base', K_2: '', K_3: 'three' } as unknown as NodeJS.ProcessEnv;
    expect(numberedEnvValues(env, 'K')).toEqual(['three']);
  });

  it('returns [] when none are present', () => {
    expect(numberedEnvValues({} as NodeJS.ProcessEnv, 'K')).toEqual([]);
    expect(numberedEnvValues({ OTHER_2: 'x' } as unknown as NodeJS.ProcessEnv, 'K')).toEqual([]);
  });

  it('stops at the max bound (default 10)', () => {
    const env = { K_10: 'ten', K_11: 'eleven' } as unknown as NodeJS.ProcessEnv;
    expect(numberedEnvValues(env, 'K')).toEqual(['ten']);
  });

  it('honours an explicit max', () => {
    const env = { K_2: 'two', K_3: 'three', K_4: 'four' } as unknown as NodeJS.ProcessEnv;
    expect(numberedEnvValues(env, 'K', 3)).toEqual(['two', 'three']);
    expect(numberedEnvValues(env, 'K', 1)).toEqual([]);
  });
});

describe('isKeyFault', () => {
  it('is true for key-fault statuses', () => {
    for (const status of [401, 402, 403, 429]) {
      expect(isKeyFault(httpError(status))).toBe(true);
    }
  });

  it('is false for statuses that are not the key\'s fault', () => {
    for (const status of [400, 404, 500, 503]) {
      expect(isKeyFault(httpError(status))).toBe(false);
    }
  });

  it('accepts statusCode as well as status', () => {
    expect(isKeyFault(Object.assign(new Error('nope'), { statusCode: 429 }))).toBe(true);
    expect(isKeyFault(Object.assign(new Error('nope'), { statusCode: 500 }))).toBe(false);
  });

  it('detects key faults from the message alone', () => {
    expect(isKeyFault(new Error('Quota exceeded for this project'))).toBe(true);
    expect(isKeyFault(new Error('API key not valid. Please pass a valid API key.'))).toBe(true);
    expect(isKeyFault(new Error('Invalid API key provided'))).toBe(true);
    expect(isKeyFault(new Error('Insufficient credit on this account'))).toBe(true);
    expect(isKeyFault(new Error('Unauthorized'))).toBe(true);
    expect(isKeyFault(new Error('Permission denied for model'))).toBe(true);
    expect(isKeyFault(new Error('rate limit reached'))).toBe(true);
    expect(isKeyFault(new Error('insufficient_quota'))).toBe(true);
    expect(isKeyFault(new Error('billing account required'))).toBe(true);
  });

  it('is false for a plain message with no key signal', () => {
    expect(isKeyFault(new Error('socket hang up'))).toBe(false);
    expect(isKeyFault(new Error('Malformed request body'))).toBe(false);
  });

  it('does not throw on non-error input', () => {
    expect(isKeyFault(null)).toBe(false);
    expect(isKeyFault(undefined)).toBe(false);
    expect(isKeyFault('quota exceeded')).toBe(false);
    expect(isKeyFault(42)).toBe(false);
    expect(isKeyFault({})).toBe(false);
    expect(isKeyFault({ message: 'quota exceeded' })).toBe(true);
  });
});

describe('describeFailure', () => {
  it('prefixes the status when one is present', () => {
    expect(describeFailure(httpError(429, 'too many requests'))).toBe('429: too many requests');
    expect(describeFailure(Object.assign(new Error('nope'), { statusCode: 403 }))).toBe('403: nope');
  });

  it('returns the bare message when there is no status', () => {
    expect(describeFailure(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('truncates long messages to 200 characters plus an ellipsis', () => {
    const long = 'x'.repeat(500);
    const described = describeFailure(new Error(long));
    expect(described).toBe(`${'x'.repeat(200)}...`);
    expect(described.length).toBe(203);
  });

  it('does not truncate a message of exactly 200 characters', () => {
    const exact = 'y'.repeat(200);
    expect(describeFailure(new Error(exact))).toBe(exact);
  });

  it('never throws on odd input', () => {
    expect(describeFailure(null)).toBe('request failed');
    expect(describeFailure(undefined)).toBe('request failed');
    expect(describeFailure({})).toBe('request failed');
    expect(describeFailure('boom')).toBe('request failed');
    expect(describeFailure(7)).toBe('request failed');
    expect(describeFailure({ status: 402 })).toBe('402: request failed');
  });
});

describe('withKeyFailover', () => {
  it('uses the first key when it succeeds and records no attempts', async () => {
    const attempt = vi.fn(async () => 'ok');
    const result = await withKeyFailover(['key-a', 'key-b'], attempt);
    expect(result).toEqual({ value: 'ok', usedIndex: 0, attempts: [] });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith('key-a', 0);
  });

  it('moves to the next key after a key fault and reports the rejected one', async () => {
    const attempt = vi.fn(async (key: string) => {
      if (key === 'key-a') throw httpError(429, 'quota exhausted');
      return 'ok';
    });
    const result = await withKeyFailover(['key-a', 'key-b'], attempt);
    expect(result.value).toBe('ok');
    expect(result.usedIndex).toBe(1);
    expect(result.attempts).toEqual([{ index: 0, status: 429, reason: '429: quota exhausted' }]);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('passes (key, index) to the attempt callback in order', async () => {
    const seen: Array<[string, number]> = [];
    await withKeyFailover(['key-a', 'key-b', 'key-c'], async (key, index) => {
      seen.push([key, index]);
      if (index < 2) throw httpError(401, 'invalid');
      return 'ok';
    });
    expect(seen).toEqual([
      ['key-a', 0],
      ['key-b', 1],
      ['key-c', 2],
    ]);
  });

  it('throws AllKeysFailedError when every key faults', async () => {
    const keys = ['key-a', 'key-b', 'key-c'];
    const attempt = vi.fn(async () => {
      throw httpError(403, 'permission denied for model');
    });
    const error = await withKeyFailover(keys, attempt).catch(e => e);
    expect(error).toBeInstanceOf(AllKeysFailedError);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(error.attempts).toHaveLength(keys.length);
    expect(error.attempts.map((a: KeyAttempt) => a.index)).toEqual([0, 1, 2]);
    expect(error.message).toContain('All 3 configured keys were rejected.');
    const serialised = `${error.message} ${JSON.stringify(error.attempts)}`;
    for (const key of keys) expect(serialised).not.toContain(key);
  });

  it('reports the single-key failure without the "all N keys" wording', async () => {
    const error = await withKeyFailover(['key-a'], async () => {
      throw httpError(401, 'API key not valid');
    }).catch(e => e);
    expect(error).toBeInstanceOf(AllKeysFailedError);
    expect(error.message).toBe('401: API key not valid');
    expect(error.attempts).toEqual([{ index: 0, status: 401, reason: '401: API key not valid' }]);
  });

  it('stops immediately on a non-key error and rethrows it as-is', async () => {
    const boom = httpError(400, 'Malformed request body');
    const attempt = vi.fn(async () => {
      throw boom;
    });
    const error = await withKeyFailover(['key-a', 'key-b'], attempt).catch(e => e);
    expect(error).toBe(boom);
    expect(error).not.toBeInstanceOf(AllKeysFailedError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-key error raised by a later key without wrapping it', async () => {
    const boom = new Error('provider outage');
    const attempt = vi.fn(async (key: string) => {
      if (key === 'key-a') throw httpError(429, 'quota');
      throw boom;
    });
    const error = await withKeyFailover(['key-a', 'key-b'], attempt).catch(e => e);
    expect(error).toBe(boom);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('throws AllKeysFailedError for an empty key list without calling attempt', async () => {
    const attempt = vi.fn(async () => 'ok');
    const error = await withKeyFailover([], attempt).catch(e => e);
    expect(error).toBeInstanceOf(AllKeysFailedError);
    expect(error.message).toBe('No API key is configured.');
    expect(error.attempts).toEqual([]);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('fires onKeyFault once per rejected key, with the right index', async () => {
    const faults: KeyAttempt[] = [];
    await withKeyFailover(
      ['key-a', 'key-b', 'key-c'],
      async (_key, index) => {
        if (index < 2) throw httpError(402, 'insufficient credit');
        return 'ok';
      },
      failure => faults.push(failure),
    );
    expect(faults).toEqual([
      { index: 0, status: 402, reason: '402: insufficient credit' },
      { index: 1, status: 402, reason: '402: insufficient credit' },
    ]);
  });

  it('fires onKeyFault for the final key too when all of them fail', async () => {
    const onKeyFault = vi.fn();
    await withKeyFailover(
      ['key-a', 'key-b'],
      async () => {
        throw httpError(429, 'quota');
      },
      onKeyFault,
    ).catch(() => undefined);
    expect(onKeyFault).toHaveBeenCalledTimes(2);
    expect(onKeyFault.mock.calls.map(c => c[0].index)).toEqual([0, 1]);
  });

  it('does not fire onKeyFault for a non-key error', async () => {
    const onKeyFault = vi.fn();
    await withKeyFailover(
      ['key-a', 'key-b'],
      async () => {
        throw new Error('socket hang up');
      },
      onKeyFault,
    ).catch(() => undefined);
    expect(onKeyFault).not.toHaveBeenCalled();
  });
});
