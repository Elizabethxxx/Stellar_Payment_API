/**
 * Tests for Horizon Client payload sanitization and strict validation (#1437)
 */

import { describe, it, expect } from 'vitest';
import {
  HORIZON_VALIDATION_ERROR,
  MAX_CONTEXT_KEYS,
  MAX_CONTEXT_VALUE_LENGTH,
  MAX_ERROR_DETAIL_LENGTH,
  REDACTED,
  sanitizeContext,
  sanitizeErrorDetail,
  sanitizeHorizonUrl,
  sanitizeString,
  validateOperation,
  validateOperationName,
  validateRetryDelays,
} from './sanitizer.js';
import { formatContext, handleError } from './error-handler.js';

const SECRET_SEED = `S${'A'.repeat(55)}`;

describe('sanitizeString', () => {
  it('leaves ordinary text untouched', () => {
    expect(sanitizeString('loadAccount failed')).toBe('loadAccount failed');
  });

  it('strips control characters used for log injection', () => {
    expect(sanitizeString('ok\r\n[ERROR] forged line\u0000')).toBe('ok [ERROR] forged line');
    expect(sanitizeString('a b')).toBe('a b');
  });

  it('redacts Stellar secret seeds and auth headers', () => {
    expect(sanitizeString(`seed=${SECRET_SEED}`)).toBe(`seed=${REDACTED}`);
    expect(sanitizeString('Authorization: Bearer abc.def-123')).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it('does not redact public account ids', () => {
    const account = `G${'A'.repeat(55)}`;
    expect(sanitizeString(account)).toBe(account);
  });

  it('truncates long values with an ellipsis', () => {
    const out = sanitizeString('x'.repeat(1000), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles null and undefined', () => {
    expect(sanitizeString(null)).toBe('');
    expect(sanitizeString(undefined)).toBe('');
  });
});

describe('sanitizeContext', () => {
  it('returns {} for non plain objects', () => {
    expect(sanitizeContext(null)).toEqual({});
    expect(sanitizeContext('accountId=1')).toEqual({});
    expect(sanitizeContext(['a'])).toEqual({});
    expect(sanitizeContext(new Map([['a', 1]]))).toEqual({});
  });

  it('stringifies values, including nested objects and bigint', () => {
    expect(
      sanitizeContext({
        accountId: 'GABC',
        limit: 10,
        options: { order: 'desc', limit: 5 },
        amount: 10n,
        when: new Date('2026-01-01T00:00:00Z'),
        missing: undefined,
      }),
    ).toEqual({
      accountId: 'GABC',
      limit: '10',
      options: '{"order":"desc","limit":5}',
      amount: '10',
      when: '2026-01-01T00:00:00.000Z',
      missing: 'undefined',
    });
  });

  it('redacts values under sensitive keys', () => {
    const out = sanitizeContext({
      secretKey: SECRET_SEED,
      api_key: 'k',
      authorization: 'Bearer x',
      seedPhrase: 'words',
      txHash: 'abc',
    });
    expect(out).toEqual({
      secretKey: REDACTED,
      api_key: REDACTED,
      authorization: REDACTED,
      seedPhrase: REDACTED,
      txHash: 'abc',
    });
  });

  it('redacts secrets hidden inside non-sensitive keys', () => {
    expect(sanitizeContext({ memo: `pay ${SECRET_SEED}` })).toEqual({ memo: `pay ${REDACTED}` });
  });

  it('drops malformed and prototype-polluting keys', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"bad key":1,"a\\nb":2,"ok":3}');
    const out = sanitizeContext(input);
    expect(out).toEqual({ ok: '3' });
    expect({}.polluted).toBeUndefined();
  });

  it('caps the number of keys and value length', () => {
    const big = Object.fromEntries(
      Array.from({ length: MAX_CONTEXT_KEYS + 10 }, (_, i) => [`k${i}`, 'v'.repeat(1000)]),
    );
    const out = sanitizeContext(big);
    expect(Object.keys(out)).toHaveLength(MAX_CONTEXT_KEYS);
    expect(out.k0).toHaveLength(MAX_CONTEXT_VALUE_LENGTH);
  });

  it('survives circular structures', () => {
    const circular = { name: 'x' };
    circular.self = circular;
    expect(sanitizeContext({ circular })).toEqual({ circular: '[unserializable]' });
  });
});

describe('sanitizeHorizonUrl', () => {
  it('keeps scheme, host and path', () => {
    expect(sanitizeHorizonUrl('https://horizon-testnet.stellar.org')).toBe('https://horizon-testnet.stellar.org');
    expect(sanitizeHorizonUrl('https://example.com/horizon')).toBe('https://example.com/horizon');
  });

  it('removes credentials, query string and fragment', () => {
    expect(sanitizeHorizonUrl('https://user:pass@example.com:8000/h?api_key=abc#x')).toBe(
      'https://example.com:8000/h',
    );
  });

  it('rejects non-http schemes and garbage', () => {
    expect(sanitizeHorizonUrl('javascript:alert(1)')).toBe('[invalid-horizon-url]');
    expect(sanitizeHorizonUrl('not a url')).toBe('[invalid-horizon-url]');
    expect(sanitizeHorizonUrl(undefined)).toBe('[unknown-horizon-url]');
  });
});

describe('sanitizeErrorDetail', () => {
  it('caps detail length and stringifies objects', () => {
    expect(sanitizeErrorDetail('x'.repeat(5000))).toHaveLength(MAX_ERROR_DETAIL_LENGTH);
    expect(sanitizeErrorDetail({ extras: { result_codes: 'tx_failed' } })).toBe(
      '{"extras":{"result_codes":"tx_failed"}}',
    );
  });
});

describe('strict validation', () => {
  it('accepts valid operation names', () => {
    expect(validateOperationName('loadAccount')).toBe('loadAccount');
    expect(validateOperationName('fetch_payments_2')).toBe('fetch_payments_2');
  });

  it.each(['', '1load', 'load account', 'load\nAccount', 'x'.repeat(65), null, 42])(
    'rejects invalid operation name %p',
    (name) => {
      expect(() => validateOperationName(name)).toThrow(
        expect.objectContaining({ code: HORIZON_VALIDATION_ERROR, validationType: 'operation_name' }),
      );
    },
  );

  it('requires the operation to be a function', () => {
    const fn = () => 1;
    expect(validateOperation(fn)).toBe(fn);
    expect(() => validateOperation('call')).toThrow(expect.objectContaining({ validationType: 'operation' }));
  });

  it('returns a frozen copy of a valid retry schedule', () => {
    const input = [150, 500];
    const out = validateRetryDelays(input);
    expect(out).toEqual([150, 500]);
    expect(Object.isFrozen(out)).toBe(true);
    input.push(1);
    expect(out).toHaveLength(2);
    expect(validateRetryDelays([])).toEqual([]);
  });

  it.each([
    ['not an array', '150'],
    ['negative', [-1]],
    ['fractional', [1.5]],
    ['NaN', [Number.NaN]],
    ['Infinity', [Infinity]],
    ['too large', [60_001]],
    ['string entry', ['100']],
    ['too many retries', Array(11).fill(1)],
  ])('rejects a retry schedule that is %s', (_label, delays) => {
    expect(() => validateRetryDelays(delays)).toThrow(
      expect.objectContaining({ code: HORIZON_VALIDATION_ERROR, validationType: 'retry_delays' }),
    );
  });
});

describe('error-handler sanitization', () => {
  it('formatContext sanitizes keys and values', () => {
    expect(formatContext({ accountId: 'G1', secret: SECRET_SEED, 'bad key': 1 })).toBe(
      `accountId=G1, secret=${REDACTED}`,
    );
  });

  it('does not leak secrets in 404 messages', () => {
    const err = handleError({ response: { status: 404 } }, 'loadAccount', { seed: SECRET_SEED }, 'https://h');
    expect(err.message).not.toContain(SECRET_SEED);
    expect(err.status).toBe(404);
  });

  it('sanitizes Horizon error detail on 4xx', () => {
    const err = handleError(
      { response: { status: 400, data: { detail: `bad\r\nX-Injected: 1 ${SECRET_SEED}` } } },
      'fetchPayments',
      {},
      'https://h',
    );
    expect(err.message).toBe(`Horizon request error (400): bad X-Injected: 1 ${REDACTED}`);
  });

  it('strips credentials from the Horizon URL on network errors', () => {
    const err = handleError(
      { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },
      'loadAccount',
      {},
      'https://admin:hunter2@horizon.example.com/?token=abc',
    );
    expect(err.message).toBe('Unable to connect to Horizon (https://horizon.example.com): connect ECONNREFUSED');
    expect(err.status).toBe(502);
  });
});
