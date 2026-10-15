/**
 * Horizon Client Retry Manager — stress suite (issue #1441).
 *
 * Pushes the Retry Manager well past normal load to check the invariants that
 * matter during a Horizon incident:
 *   - per-process concurrency never exceeds the limiter cap
 *   - cluster-wide concurrent retries never exceed the retry-slot cap
 *   - a shared 429 cooldown is respected by every instance
 *   - overload is shed deterministically (503) instead of queueing forever
 *   - no slot, counter or queue entry leaks after thousands of operations
 *   - Redis failures during load never fail requests (fail-open)
 *
 * Horizon is simulated by in-process operations and Redis by the shared
 * in-memory fake, so the suite is deterministic and fast.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { RetryManager, RETRY_STOP_REASONS } from '../src/lib/stellar/horizon-client/retry-manager.js';
import { HorizonRetryCoordinator } from '../src/lib/stellar/horizon-client/retry-coordinator.js';
import { RETRY_MANAGER_ERROR_CODES } from '../src/lib/stellar/horizon-client/constants.js';
import { createFakeRedis } from '../tests/helpers/fake-redis.js';

const URL = 'https://horizon.stellar.org';
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Like Promise.allSettled for one promise, attached immediately so no rejection is ever unhandled. */
const settle = (promise) => promise.then(
  (value) => ({ status: 'fulfilled', value }),
  (reason) => ({ status: 'rejected', reason }),
);
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

/** Seeded PRNG so failures are reproducible. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeManager({ redis = null, concurrency, coordination, backoff, sleep = tick } = {}) {
  const coordinator = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: URL, ...(coordination ?? {}) });
  return new RetryManager(undefined, {
    horizonUrl: URL,
    backoff: { baseDelayMs: 1, maxDelayMs: 4, maxRetries: 3, maxElapsedMs: 60_000, ...(backoff ?? {}) },
    concurrency: { maxConcurrent: 32, maxQueue: 100_000, queueTimeoutMs: 60_000, ...(concurrency ?? {}) },
    coordinator,
    sleep,
  });
}

function expectNoLeaks(manager) {
  const config = manager.getConfig();
  expect(config.currentConcurrentOperations).toBe(0);
  expect(config.concurrency).toMatchObject({ active: 0, pending: 0 });
  expect(manager.coordinator.localSlots.size).toBe(0);
}

describe('Horizon Client Retry Manager — stress (issue #1441)', () => {
  it('2,000 concurrent operations with 30% transient failures stay within the concurrency cap', async () => {
    const random = mulberry32(42);
    const manager = makeManager({ concurrency: { maxConcurrent: 16 } });
    let running = 0;
    let peak = 0;

    const op = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
      if (random() < 0.3) throw httpError(503);
      return 'ok';
    };

    const settled = await Promise.allSettled(
      Array.from({ length: 2_000 }, () => manager.executeWithRetry(op, 'loadAccount', {}, URL)),
    );

    const ok = settled.filter((s) => s.status === 'fulfilled').length;
    const failed = settled.filter((s) => s.status === 'rejected');
    expect(peak).toBeLessThanOrEqual(16);
    // P(4 consecutive failures) = 0.3^4 ≈ 0.8%; allow generous slack.
    expect(ok).toBeGreaterThan(1_900);
    for (const f of failed) {
      expect(Object.values(RETRY_STOP_REASONS)).toContain(f.reason.retryStopReason);
    }
    expectNoLeaks(manager);
  });

  it('8 instances x 100 calls against a dead Horizon never exceed the cluster retry cap', async () => {
    const redis = createFakeRedis();
    const SLOTS = 4;
    const instances = Array.from({ length: 8 }, () =>
      makeManager({ redis, coordination: { maxConcurrentRetries: SLOTS } }),
    );

    let inFlightRetries = 0;
    let peakRetries = 0;
    let attempts = 0;

    const call = (manager) => {
      let attempt = 0;
      return manager.executeWithRetry(async () => {
        attempts += 1;
        const isRetry = attempt > 0;
        attempt += 1;
        if (isRetry) {
          inFlightRetries += 1;
          peakRetries = Math.max(peakRetries, inFlightRetries);
        }
        await tick();
        if (isRetry) inFlightRetries -= 1;
        throw httpError(500);
      }, 'getFeeStats', {}, URL);
    };

    const settled = await Promise.allSettled(instances.flatMap((m) => Array.from({ length: 100 }, () => call(m))));

    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect(peakRetries).toBeLessThanOrEqual(SLOTS);
    // Without coordination this would be 800 * 4 = 3,200 attempts.
    expect(attempts).toBeLessThan(800 * 2);
    const shed = settled.filter((s) => s.reason.retryStopReason === RETRY_STOP_REASONS.RETRY_SLOTS_EXHAUSTED);
    expect(shed.length).toBeGreaterThan(0);
    expect(redis.keys('horizon:retry:slot:')).toHaveLength(0);
    instances.forEach(expectNoLeaks);
  });

  it('a single 429 holds every instance until the shared cooldown expires', async () => {
    const redis = createFakeRedis();
    const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const instances = Array.from({ length: 5 }, () =>
      makeManager({
        redis,
        sleep: realSleep,
        backoff: { baseDelayMs: 150, maxDelayMs: 150, jitter: 'none', maxRetries: 1 },
      }),
    );

    let throttledAt = null;
    const calls = [];
    const horizon = async () => {
      calls.push(Date.now());
      if (throttledAt === null) {
        throttledAt = Date.now();
        throw httpError(429);
      }
      return 'ok';
    };

    const first = instances[0].executeWithRetry(horizon, 'loadAccount', {}, URL);
    // Fire the rest as soon as the throttle has been published.
    await vi.waitFor(() => expect(redis.keys('horizon:retry:cooldown:')).toHaveLength(1));
    const results = await Promise.all(
      instances.slice(1).flatMap((m) => Array.from({ length: 20 }, () => m.executeWithRetry(horizon, 'loadAccount', {}, URL))),
    );

    expect(await first).toBe('ok');
    expect(results.every((r) => r === 'ok')).toBe(true);
    expect(calls).toHaveLength(1 + 1 + 80);
    const tooEarly = calls.slice(1).filter((at) => at - throttledAt < 140);
    expect(tooEarly).toHaveLength(0);
  });

  it('sheds exactly the overflow when the queue saturates', async () => {
    const manager = makeManager({ concurrency: { maxConcurrent: 4, maxQueue: 50 } });
    const gates = [];
    const op = () => new Promise((resolve) => gates.push(resolve));

    const pending = Array.from({ length: 200 }, () => settle(manager.executeWithRetry(op, 'fetchPayments', {}, URL)));
    await vi.waitFor(() => expect(gates).toHaveLength(4));

    // Drain: release whatever is running until everything settles.
    const drain = setInterval(() => gates.splice(0).forEach((resolve) => resolve('ok')), 1);
    const settled = await Promise.all(pending);
    clearInterval(drain);

    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(rejected).toHaveLength(200 - 4 - 50);
    expect(rejected.every((r) => r.reason.code === RETRY_MANAGER_ERROR_CODES.QUEUE_FULL)).toBe(true);
    expectNoLeaks(manager);
  });

  it('survives Redis flapping under load without failing healthy requests', async () => {
    const redis = createFakeRedis();
    // Enough retry slots that shedding is not what this test measures.
    const manager = makeManager({ redis, coordination: { maxConcurrentRetries: 1_024 } });
    const random = mulberry32(7);
    const flap = setInterval(() => redis.setFailure(random() < 0.5 ? new Error('ECONNRESET') : null), 1);

    const op = vi.fn()
      .mockImplementation(async () => {
        await tick();
        if (random() < 0.2) throw httpError(502);
        return 'ok';
      });

    const settled = await Promise.allSettled(
      Array.from({ length: 1_000 }, () => manager.executeWithRetry(op, 'loadAccount', {}, URL)),
    );
    clearInterval(flap);
    redis.setFailure(null);

    const ok = settled.filter((s) => s.status === 'fulfilled').length;
    expect(ok).toBeGreaterThan(980);
    expect(manager.getConfig().coordination.stats.fallbacks).toBeGreaterThan(0);
    expectNoLeaks(manager);
  });

  it('sustains high throughput on the happy path', async () => {
    const manager = makeManager({ concurrency: { maxConcurrent: 64 } });
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10_000 }, () => manager.executeWithRetry(async () => 'ok', 'getFeeStats', {}, URL)),
    );
    const elapsed = Date.now() - started;
    expect(results).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(10_000);
    expectNoLeaks(manager);
  });
});
