/**
 * Unit tests for the Horizon Client Retry Manager:
 *   - automated retry with exponential backoff (issue #1439)
 *   - concurrency control and distributed retry coordination (issue #1440)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { RetryManager, RETRY_STOP_REASONS, createRetryManager } from './retry-manager.js';
import { HorizonRetryCoordinator } from './retry-coordinator.js';
import { ConcurrencyLimiter } from './concurrency-limiter.js';
import { RETRY_MANAGER_ERROR_CODES } from './constants.js';
import { createFakeRedis } from '../../../../tests/helpers/fake-redis.js';
import { logger } from '../../logger.js';

const URL = 'https://horizon-testnet.stellar.org';

const httpError = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, ...extra } });
const netError = (code = 'ECONNRESET') => Object.assign(new Error('socket hang up'), { code });

/** Manager with recorded, instant sleeps and deterministic jitter. */
function makeManager({ backoff = {}, retryDelays, coordinator, limiter, random = () => 1 } = {}) {
  const sleeps = [];
  const manager = new RetryManager(retryDelays, {
    horizonUrl: URL,
    backoff: { baseDelayMs: 100, maxDelayMs: 1_000, multiplier: 2, jitter: 'none', ...backoff },
    coordinator: coordinator ?? new HorizonRetryCoordinator({ redisClient: null, horizonUrl: URL }),
    limiter,
    random,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { manager, sleeps };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('exponential backoff (issue #1439)', () => {
  it('returns immediately on success without sleeping', async () => {
    const { manager, sleeps } = makeManager();
    const op = vi.fn().mockResolvedValue('ok');
    await expect(manager.executeWithRetry(op, 'loadAccount', {}, URL)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('retries transient failures with exponentially growing delays', async () => {
    const { manager, sleeps } = makeManager({ backoff: { maxRetries: 3 } });
    const op = vi.fn()
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(netError())
      .mockRejectedValueOnce(httpError(502))
      .mockResolvedValue('ok');

    await expect(manager.executeWithRetry(op, 'loadAccount', {}, URL)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('applies jitter from the injected random source', async () => {
    const { manager, sleeps } = makeManager({ backoff: { jitter: 'full' }, random: () => 0.5 });
    const op = vi.fn().mockRejectedValueOnce(httpError(503)).mockResolvedValue('ok');
    await manager.executeWithRetry(op, 'getFeeStats', {}, URL);
    // 503 also publishes a cooldown, which is waited out before the next attempt.
    expect(sleeps).toContain(50);
  });

  it('throws a wrapped error after exhausting retries', async () => {
    const { manager, sleeps } = makeManager({ backoff: { maxRetries: 2 } });
    const op = vi.fn().mockRejectedValue(httpError(500));

    const err = await manager.executeWithRetry(op, 'loadAccount', {}, URL).catch((e) => e);
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);
    expect(err).toMatchObject({
      status: 502,
      operation: 'loadAccount',
      attempts: 3,
      retryStopReason: RETRY_STOP_REASONS.EXHAUSTED,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: RETRY_STOP_REASONS.EXHAUSTED }),
      'Horizon client: giving up on operation',
    );
  });

  it.each([
    ['404', httpError(404), 404],
    ['400', httpError(400), 400],
    ['an error flagged retryable:false', Object.assign(httpError(500), { retryable: false }), 502],
  ])('does not retry %s', async (_label, error, status) => {
    const { manager, sleeps } = makeManager();
    const op = vi.fn().mockRejectedValue(error);
    const err = await manager.executeWithRetry(op, 'loadAccount', { accountId: 'GABC' }, URL).catch((e) => e);
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(err.status).toBe(status);
    expect(err.retryStopReason).toBe(RETRY_STOP_REASONS.NOT_RETRYABLE);
  });

  it('keeps the legacy fixed schedule when retryDelays is given', async () => {
    const { manager, sleeps } = makeManager({ retryDelays: [10, 20] });
    const op = vi.fn().mockRejectedValue(netError('ETIMEDOUT'));
    await expect(manager.executeWithRetry(op, 'loadAccount', {}, URL)).rejects.toMatchObject({ status: 502 });
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]);
    expect(manager.getConfig()).toMatchObject({ retryDelays: [10, 20], maxAttempts: 3 });
  });

  it('waits at least the Retry-After hint on a 429', async () => {
    const { manager, sleeps } = makeManager();
    const throttled = httpError(429, { headers: { 'retry-after': '0.3' } });
    const op = vi.fn().mockRejectedValueOnce(throttled).mockResolvedValue('ok');

    await manager.executeWithRetry(op, 'fetchPayments', {}, URL);
    // backoff (100) < Retry-After (300): the hint wins.
    expect(sleeps[0]).toBe(300);
  });

  it('fails fast when Retry-After exceeds maxRetryAfterMs', async () => {
    const { manager, sleeps } = makeManager({ backoff: { maxRetryAfterMs: 1_000 } });
    const op = vi.fn().mockRejectedValue(httpError(429, { headers: { 'retry-after': '120' } }));

    const err = await manager.executeWithRetry(op, 'loadAccount', {}, URL).catch((e) => e);
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(err).toMatchObject({ status: 429, retryStopReason: RETRY_STOP_REASONS.RETRY_AFTER_TOO_LONG });
  });

  it('stops when the next wait would exceed the total time budget', async () => {
    const { manager } = makeManager({ backoff: { maxElapsedMs: 150, maxRetries: 5 } });
    const op = vi.fn().mockRejectedValue(httpError(500));

    const err = await manager.executeWithRetry(op, 'loadAccount', {}, URL).catch((e) => e);
    // delay(0)=100 fits, delay(1)=200 does not.
    expect(op).toHaveBeenCalledTimes(2);
    expect(err.retryStopReason).toBe(RETRY_STOP_REASONS.BUDGET_EXCEEDED);
  });

  it('logs only primitive context values', async () => {
    const { manager } = makeManager();
    const op = vi.fn().mockRejectedValueOnce(httpError(500)).mockResolvedValue('ok');
    await manager.executeWithRetry(op, 'fetchPayments', { accountId: 'GABC', options: { secret: 'x' } }, URL);
    const [fields] = logger.warn.mock.calls.find(([, msg]) => msg === 'Horizon client: retrying operation after error');
    expect(fields.accountId).toBe('GABC');
    expect(fields).not.toHaveProperty('options');
  });

  it('accepts the legacy (retryDelays, metricsPrefix) signature', () => {
    const manager = new RetryManager([5], 'prefix_');
    expect(manager.metricsPrefix).toBe('prefix_');
    expect(manager.getConfig().maxAttempts).toBe(2);
    expect(createRetryManager().getConfig().backoff.strategy).toBe('exponential');
  });
});

describe('concurrency control (issue #1440)', () => {
  it('limits concurrent operations and sheds load beyond the queue with 503', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1 });
    const { manager } = makeManager({ limiter });
    let release;
    const slow = () => new Promise((resolve) => { release = () => resolve('slow'); });

    const first = manager.executeWithRetry(slow, 'loadAccount', {}, URL);
    const second = manager.executeWithRetry(async () => 'queued', 'loadAccount', {}, URL);
    await expect(manager.executeWithRetry(async () => 'never', 'loadAccount', {}, URL))
      .rejects.toMatchObject({ status: 503, code: RETRY_MANAGER_ERROR_CODES.QUEUE_FULL });

    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await expect(first).resolves.toBe('slow');
    await expect(second).resolves.toBe('queued');
    expect(manager.getConfig().concurrency).toMatchObject({ active: 0, pending: 0 });
  });

  it('skips a retry when every cluster retry slot is taken', async () => {
    const coordinator = new HorizonRetryCoordinator({ redisClient: null, horizonUrl: URL, maxConcurrentRetries: 1 });
    const held = await coordinator.acquireRetrySlot('loadAccount');
    const { manager } = makeManager({ coordinator });
    const op = vi.fn().mockRejectedValue(httpError(500));

    const err = await manager.executeWithRetry(op, 'loadAccount', {}, URL).catch((e) => e);
    expect(op).toHaveBeenCalledTimes(1);
    expect(err.retryStopReason).toBe(RETRY_STOP_REASONS.RETRY_SLOTS_EXHAUSTED);
    await held.release();
  });

  it('releases retry slots after recovering and after giving up', async () => {
    const coordinator = new HorizonRetryCoordinator({ redisClient: null, horizonUrl: URL, maxConcurrentRetries: 1 });
    const { manager } = makeManager({ coordinator });

    await manager.executeWithRetry(
      vi.fn().mockRejectedValueOnce(httpError(500)).mockResolvedValue('ok'),
      'loadAccount', {}, URL,
    );
    await manager.executeWithRetry(vi.fn().mockRejectedValue(httpError(500)), 'loadAccount', {}, URL).catch(() => {});

    expect(coordinator.localSlots.size).toBe(0);
    expect(await coordinator.acquireRetrySlot('loadAccount')).not.toBeNull();
  });

  it('publishes a cooldown on 429 that a second manager waits out before calling Horizon', async () => {
    const redis = createFakeRedis();
    const coordA = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: URL });
    const coordB = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: URL });
    const a = makeManager({ coordinator: coordA });
    const b = makeManager({ coordinator: coordB });

    await a.manager.executeWithRetry(
      vi.fn().mockRejectedValueOnce(httpError(429, { headers: { 'retry-after': '1' } })).mockResolvedValue('ok'),
      'loadAccount', {}, URL,
    );

    const op = vi.fn().mockResolvedValue('ok');
    await b.manager.executeWithRetry(op, 'loadAccount', {}, URL);
    expect(op).toHaveBeenCalledTimes(1);
    expect(b.sleeps[0]).toBeGreaterThan(500);
    expect(b.sleeps[0]).toBeLessThanOrEqual(1_000);
  });

  it('never waits on a cooldown past the operation budget', async () => {
    const coordinator = new HorizonRetryCoordinator({ redisClient: null, horizonUrl: URL, maxCooldownMs: 5_000 });
    await coordinator.recordCooldown(5_000);
    const { manager, sleeps } = makeManager({ coordinator, backoff: { maxElapsedMs: 200 } });
    await manager.executeWithRetry(async () => 'ok', 'loadAccount', {}, URL);
    expect(sleeps[0]).toBeLessThanOrEqual(200);
  });

  it('keeps working when the coordinator fails', async () => {
    const coordinator = new HorizonRetryCoordinator({ redisClient: null, horizonUrl: URL });
    coordinator.getCooldownRemainingMs = vi.fn().mockRejectedValue(new Error('broken'));
    const { manager } = makeManager({ coordinator });
    await expect(manager.executeWithRetry(async () => 'ok', 'loadAccount', {}, URL)).resolves.toBe('ok');
  });

  it('setCoordinator swaps the coordinator and rejects other objects', () => {
    const { manager } = makeManager();
    const next = new HorizonRetryCoordinator({ redisClient: createFakeRedis(), horizonUrl: URL });
    manager.setCoordinator(next);
    expect(manager.getConfig().coordination.backend).toBe('redis');
    expect(() => manager.setCoordinator({})).toThrow(TypeError);
  });

  it('tracks concurrent operations and never leaks the counter', async () => {
    const { manager } = makeManager();
    await Promise.allSettled([
      manager.executeWithRetry(async () => 'ok', 'a', {}, URL),
      manager.executeWithRetry(async () => { throw httpError(404); }, 'b', {}, URL),
    ]);
    expect(manager.getConfig().currentConcurrentOperations).toBe(0);
  });
});
