/**
 * Unit tests for the Horizon Client backoff policy (issue #1439).
 */

import { describe, it, expect } from 'vitest';
import {
  computeBackoffDelay,
  normalizeRetryDelays,
  parseRetryAfterMs,
  resolveBackoffOptions,
} from './backoff.js';
import { BACKOFF_LIMITS, DEFAULT_BACKOFF_OPTIONS, DEFAULT_RETRY_DELAYS_MS } from './constants.js';

const NO_ENV = {};

describe('resolveBackoffOptions', () => {
  it('defaults to jittered exponential backoff with the legacy attempt count', () => {
    const policy = resolveBackoffOptions({}, NO_ENV);
    expect(policy.strategy).toBe('exponential');
    expect(policy.jitter).toBe('full');
    expect(policy.maxRetries).toBe(DEFAULT_RETRY_DELAYS_MS.length);
    expect(policy.baseDelayMs).toBe(DEFAULT_BACKOFF_OPTIONS.baseDelayMs);
    expect(policy.fixedDelays).toBeNull();
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('switches to the fixed strategy when an explicit schedule is given', () => {
    const policy = resolveBackoffOptions({ retryDelays: [50, 100, 200] }, NO_ENV);
    expect(policy.strategy).toBe('fixed');
    expect(policy.maxRetries).toBe(3);
    expect(policy.fixedDelays).toEqual([50, 100, 200]);
  });

  it('reads environment variables when no option is given', () => {
    const policy = resolveBackoffOptions({}, {
      HORIZON_RETRY_MAX_RETRIES: '4',
      HORIZON_RETRY_BASE_DELAY_MS: '20',
      HORIZON_RETRY_MAX_DELAY_MS: '400',
      HORIZON_RETRY_MULTIPLIER: '2',
      HORIZON_RETRY_JITTER: 'EQUAL',
      HORIZON_RETRY_MAX_ELAPSED_MS: '3000',
      HORIZON_RETRY_MAX_RETRY_AFTER_MS: '1500',
    });
    expect(policy).toMatchObject({
      maxRetries: 4,
      baseDelayMs: 20,
      maxDelayMs: 400,
      multiplier: 2,
      jitter: 'equal',
      maxElapsedMs: 3000,
      maxRetryAfterMs: 1500,
    });
  });

  it('prefers explicit options over the environment', () => {
    const policy = resolveBackoffOptions({ maxRetries: 1 }, { HORIZON_RETRY_MAX_RETRIES: '5' });
    expect(policy.maxRetries).toBe(1);
  });

  it.each([
    ['garbage strings', { maxRetries: 'abc', baseDelayMs: 'x', jitter: 'chaotic', strategy: 'random' }],
    ['non-finite numbers', { maxRetries: Infinity, baseDelayMs: NaN, multiplier: -Infinity }],
  ])('falls back to safe defaults for %s', (_label, options) => {
    const policy = resolveBackoffOptions(options, NO_ENV);
    expect(policy.strategy).toBe('exponential');
    expect(policy.jitter).toBe('full');
    expect(policy.maxRetries).toBe(DEFAULT_BACKOFF_OPTIONS.maxRetries);
    expect(policy.baseDelayMs).toBe(DEFAULT_BACKOFF_OPTIONS.baseDelayMs);
    expect(policy.multiplier).toBe(DEFAULT_BACKOFF_OPTIONS.multiplier);
  });

  it('clamps out-of-range values to hard ceilings', () => {
    const policy = resolveBackoffOptions({
      maxRetries: 1_000,
      baseDelayMs: 10_000_000,
      maxDelayMs: 10_000_000,
      multiplier: 1_000,
      maxElapsedMs: 10_000_000,
    }, NO_ENV);
    expect(policy.maxRetries).toBe(BACKOFF_LIMITS.maxRetries);
    expect(policy.baseDelayMs).toBe(BACKOFF_LIMITS.maxDelayMs);
    expect(policy.maxDelayMs).toBe(BACKOFF_LIMITS.maxDelayMs);
    expect(policy.multiplier).toBe(BACKOFF_LIMITS.maxMultiplier);
    expect(policy.maxElapsedMs).toBe(BACKOFF_LIMITS.maxElapsedMs);
  });

  it('never lets maxDelayMs drop below baseDelayMs', () => {
    const policy = resolveBackoffOptions({ baseDelayMs: 500, maxDelayMs: 100 }, NO_ENV);
    expect(policy.maxDelayMs).toBe(500);
  });
});

describe('normalizeRetryDelays', () => {
  it('returns null for a non-array', () => {
    expect(normalizeRetryDelays(undefined)).toBeNull();
    expect(normalizeRetryDelays('100,200')).toBeNull();
  });

  it('drops invalid entries and caps large ones', () => {
    expect(normalizeRetryDelays([NaN, -1, 10, '20', 1e12])).toEqual([10, 20, BACKOFF_LIMITS.maxDelayMs]);
  });

  it('limits the schedule length', () => {
    expect(normalizeRetryDelays(new Array(50).fill(1))).toHaveLength(BACKOFF_LIMITS.maxRetries);
  });
});

describe('computeBackoffDelay', () => {
  const exponential = (overrides = {}) =>
    resolveBackoffOptions({ baseDelayMs: 100, maxDelayMs: 1_000, multiplier: 2, ...overrides }, NO_ENV);

  it('grows exponentially without jitter', () => {
    const policy = exponential({ jitter: 'none' });
    expect([0, 1, 2, 3].map((n) => computeBackoffDelay(n, policy))).toEqual([100, 200, 400, 800]);
  });

  it('is capped at maxDelayMs', () => {
    const policy = exponential({ jitter: 'none' });
    expect(computeBackoffDelay(10, policy)).toBe(1_000);
    expect(computeBackoffDelay(10_000, policy)).toBe(1_000);
  });

  it('full jitter stays within [0, ceiling)', () => {
    const policy = exponential({ jitter: 'full' });
    expect(computeBackoffDelay(2, policy, () => 0)).toBe(0);
    expect(computeBackoffDelay(2, policy, () => 0.5)).toBe(200);
    expect(computeBackoffDelay(2, policy, () => 0.999)).toBeLessThan(400);
  });

  it('equal jitter keeps at least half the ceiling', () => {
    const policy = exponential({ jitter: 'equal' });
    expect(computeBackoffDelay(2, policy, () => 0)).toBe(200);
    expect(computeBackoffDelay(2, policy, () => 1)).toBe(400);
  });

  it('tolerates a misbehaving random source', () => {
    const policy = exponential({ jitter: 'full' });
    expect(computeBackoffDelay(1, policy, () => NaN)).toBe(0);
    expect(computeBackoffDelay(1, policy, () => 5)).toBe(200);
    expect(computeBackoffDelay(1, policy, () => -5)).toBe(0);
  });

  it('treats negative or invalid indices as the first retry', () => {
    const policy = exponential({ jitter: 'none' });
    expect(computeBackoffDelay(-3, policy)).toBe(100);
    expect(computeBackoffDelay('x', policy)).toBe(100);
  });

  it('returns 0 when the base delay is 0', () => {
    expect(computeBackoffDelay(3, exponential({ baseDelayMs: 0, maxDelayMs: 0 }))).toBe(0);
  });

  it('follows the fixed schedule and repeats its last entry', () => {
    const policy = resolveBackoffOptions({ retryDelays: [50, 100] }, NO_ENV);
    expect([0, 1, 2].map((n) => computeBackoffDelay(n, policy))).toEqual([50, 100, 100]);
  });

  it('returns 0 for an empty fixed schedule', () => {
    const policy = resolveBackoffOptions({ retryDelays: [] }, NO_ENV);
    expect(policy.maxRetries).toBe(0);
    expect(computeBackoffDelay(0, policy)).toBe(0);
  });
});

describe('parseRetryAfterMs', () => {
  const NOW = Date.parse('2026-10-15T12:00:00Z');

  it('parses delta-seconds from plain object headers (any casing)', () => {
    expect(parseRetryAfterMs({ response: { headers: { 'Retry-After': '2' } } }, NOW)).toBe(2_000);
    expect(parseRetryAfterMs({ response: { headers: { 'retry-after': '0.5' } } }, NOW)).toBe(500);
  });

  it('parses a Headers-like object', () => {
    const headers = new Headers({ 'retry-after': '3' });
    expect(parseRetryAfterMs({ response: { headers } }, NOW)).toBe(3_000);
  });

  it('parses an HTTP date relative to now', () => {
    const err = { headers: { 'retry-after': 'Thu, 15 Oct 2026 12:00:04 GMT' } };
    expect(parseRetryAfterMs(err, NOW)).toBe(4_000);
  });

  it('returns 0 for a date in the past', () => {
    const err = { headers: { 'retry-after': 'Thu, 15 Oct 2026 11:00:00 GMT' } };
    expect(parseRetryAfterMs(err, NOW)).toBe(0);
  });

  it('reads an explicit retryAfter property and array values', () => {
    expect(parseRetryAfterMs({ retryAfter: 1 }, NOW)).toBe(1_000);
    expect(parseRetryAfterMs({ headers: { 'retry-after': ['2', '9'] } }, NOW)).toBe(2_000);
  });

  it.each([
    [null],
    [{}],
    [{ response: { headers: {} } }],
    [{ headers: { 'retry-after': '' } }],
    [{ headers: { 'retry-after': '-1' } }],
    [{ headers: { 'retry-after': 'soon' } }],
    [{ headers: { 'retry-after': '1'.repeat(100) } }],
  ])('returns null for missing or invalid hints (%#)', (err) => {
    expect(parseRetryAfterMs(err, NOW)).toBeNull();
  });
});
