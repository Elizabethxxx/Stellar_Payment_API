/**
 * Horizon Client Retry Manager — integration suite (issue #1441).
 *
 * Drives the real HorizonClient -> RetryManager -> Stellar SDK -> HTTP stack
 * against a local Horizon stub, so status codes, retries, backoff, the
 * concurrency limiter and cross-instance coordination are exercised end to
 * end. Only two edges are simulated:
 *   - Horizon: a node:http server scripted per test
 *   - Redis:   the in-memory fake shared by the other coordination suites
 */
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { HorizonClient } from '../../src/lib/stellar/horizon-client.js';
import { RETRY_STOP_REASONS } from '../../src/lib/stellar/horizon-client/retry-manager.js';
import { RETRY_MANAGER_ERROR_CODES } from '../../src/lib/stellar/horizon-client/constants.js';
import { createFakeRedis } from '../helpers/fake-redis.js';

const PASSPHRASE = 'Test SDF Network ; September 2015';
const TX_HASH = 'a'.repeat(64);
const FEE_STATS = { last_ledger: '1', last_ledger_base_fee: '100', fee_charged: { p50: '100' }, max_fee: { p50: '100' } };

/**
 * Scriptable Horizon stub. `script` is consumed one entry per request; the
 * last entry repeats. Each entry is { status, body?, headers?, delayMs? }.
 */
function createHorizonStub() {
  let script = [{ status: 200, body: FEE_STATS }];
  let index = 0;
  let inFlight = 0;
  const requests = [];
  const state = { peakInFlight: 0 };

  const server = http.createServer(async (req, res) => {
    inFlight += 1;
    state.peakInFlight = Math.max(state.peakInFlight, inFlight);
    requests.push({ url: req.url, at: Date.now() });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    res.writeHead(step.status, { 'Content-Type': 'application/json', ...(step.headers ?? {}) });
    res.end(JSON.stringify(step.body ?? { status: step.status, title: `HTTP ${step.status}` }));
    inFlight -= 1;
  });

  return {
    server,
    requests,
    state,
    get url() {
      return `http://127.0.0.1:${server.address().port}`;
    },
    script(steps) {
      script = steps;
      index = 0;
      requests.length = 0;
      state.peakInFlight = 0;
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function makeClient(url, options = {}) {
  return new HorizonClient(url, PASSPHRASE, {
    serverOptions: { allowHttp: true },
    backoff: { baseDelayMs: 10, maxDelayMs: 40, jitter: 'none', maxRetries: 2, ...(options.backoff ?? {}) },
    concurrency: options.concurrency,
    coordination: options.coordination,
  });
}

describe('Horizon Client Retry Manager — HTTP integration', () => {
  const horizon = createHorizonStub();
  const clients = [];
  const client = (options) => {
    const c = makeClient(horizon.url, options);
    clients.push(c);
    return c;
  };

  beforeAll(() => horizon.listen());
  afterAll(() => horizon.close());
  beforeEach(() => {
    while (clients.length) clients.pop().close();
    horizon.script([{ status: 200, body: FEE_STATS }]);
  });

  it('returns Horizon data on the first attempt', async () => {
    const c = client();
    await expect(c.getFeeStats()).resolves.toMatchObject({ last_ledger_base_fee: '100' });
    expect(horizon.requests).toHaveLength(1);
    expect(horizon.requests[0].url).toBe('/fee_stats');
  });

  it('recovers from transient 503s with exponential backoff', async () => {
    horizon.script([{ status: 503 }, { status: 502 }, { status: 200, body: FEE_STATS }]);
    const c = client();
    await expect(c.getFeeStats()).resolves.toMatchObject({ last_ledger: '1' });
    expect(horizon.requests).toHaveLength(3);

    const [a, b, d] = horizon.requests.map((r) => r.at);
    // 10ms then 30ms (base 10, multiplier 3), allowing for timer slack.
    expect(b - a).toBeGreaterThanOrEqual(8);
    expect(d - b).toBeGreaterThanOrEqual(25);
  });

  it('does not retry a 404 and maps it to a descriptive error', async () => {
    horizon.script([{ status: 404 }]);
    const c = client();
    const err = await c.fetchTransaction(TX_HASH).catch((e) => e);
    expect(err).toMatchObject({ status: 404, operation: 'fetchTransaction' });
    expect(err.message).toContain(`txHash=${TX_HASH}`);
    expect(horizon.requests).toHaveLength(1);
  });

  it('gives up after maxRetries on a persistent 500 and reports why', async () => {
    horizon.script([{ status: 500 }]);
    const c = client();
    const err = await c.getFeeStats().catch((e) => e);
    expect(err).toMatchObject({ status: 502, attempts: 3, retryStopReason: RETRY_STOP_REASONS.EXHAUSTED });
    expect(horizon.requests).toHaveLength(3);
  });

  it('retries a 429 and then succeeds', async () => {
    horizon.script([{ status: 429 }, { status: 200, body: FEE_STATS }]);
    const c = client();
    await expect(c.getFeeStats()).resolves.toBeTruthy();
    expect(horizon.requests).toHaveLength(2);
  });

  it('honours the operation time budget', async () => {
    horizon.script([{ status: 500 }]);
    const c = client({ backoff: { baseDelayMs: 30, maxDelayMs: 1_000, maxRetries: 5, maxElapsedMs: 100 } });
    const started = Date.now();
    const err = await c.getFeeStats().catch((e) => e);
    expect(err.retryStopReason).toBe(RETRY_STOP_REASONS.BUDGET_EXCEEDED);
    expect(Date.now() - started).toBeLessThan(400);
    expect(horizon.requests.length).toBeLessThan(6);
  });

  it('retries connection failures and reports the Horizon URL', async () => {
    const dead = http.createServer();
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const deadUrl = `http://127.0.0.1:${dead.address().port}`;
    await new Promise((resolve) => dead.close(resolve));

    const c = makeClient(deadUrl);
    clients.push(c);
    const err = await c.getFeeStats().catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toContain(deadUrl);
    expect(err.attempts).toBe(3);
  });

  it('never runs more than maxConcurrent requests against Horizon at once', async () => {
    horizon.script([{ status: 200, body: FEE_STATS, delayMs: 20 }]);
    const c = client({ concurrency: { maxConcurrent: 3, maxQueue: 100 } });
    const results = await Promise.all(Array.from({ length: 12 }, () => c.getFeeStats()));
    expect(results).toHaveLength(12);
    expect(horizon.state.peakInFlight).toBeLessThanOrEqual(3);
    expect(c.getRetryManager().getConfig().concurrency).toMatchObject({ active: 0, pending: 0 });
  });

  it('sheds load with 503 when the queue is full instead of hitting Horizon', async () => {
    horizon.script([{ status: 200, body: FEE_STATS, delayMs: 50 }]);
    const c = client({ concurrency: { maxConcurrent: 1, maxQueue: 1 } });
    const settled = await Promise.allSettled([c.getFeeStats(), c.getFeeStats(), c.getFeeStats()]);
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 503, code: RETRY_MANAGER_ERROR_CODES.QUEUE_FULL });
    expect(horizon.requests).toHaveLength(2);
  });

  describe('across instances sharing Redis', () => {
    it('a 429 seen by one instance makes the other wait before calling Horizon', async () => {
      const redis = createFakeRedis();
      const a = client({ backoff: { baseDelayMs: 200, maxDelayMs: 200 } });
      const b = client();
      expect(a.configureRetryCoordination({ redisClient: redis })).toBe('redis');
      expect(b.configureRetryCoordination({ redisClient: redis })).toBe('redis');

      horizon.script([{ status: 429 }, { status: 200, body: FEE_STATS }]);
      const first = a.getFeeStats();
      await vi.waitFor(() => expect(horizon.requests).toHaveLength(1));
      await vi.waitFor(() => expect(redis.keys('horizon:retry:cooldown:')).toHaveLength(1));

      const startedB = Date.now();
      await b.getFeeStats();
      await first;
      const bRequest = horizon.requests.find((r) => r.at >= startedB);
      // B waited out (most of) the 200ms cooldown instead of hitting Horizon immediately.
      expect(bRequest.at - startedB).toBeGreaterThanOrEqual(100);
    });

    it('caps concurrent retries cluster-wide and releases every slot afterwards', async () => {
      const redis = createFakeRedis();
      const nodes = [client(), client(), client()];
      for (const n of nodes) {
        n.configureRetryCoordination({ redisClient: redis, maxConcurrentRetries: 1 });
      }

      horizon.script([{ status: 500, delayMs: 5 }]);
      const settled = await Promise.allSettled(nodes.map((n) => n.getFeeStats()));
      const reasons = settled.map((s) => s.reason.retryStopReason);

      // Only one instance may hold the single retry slot at a time; the
      // others shed their retry instead of piling onto a failing Horizon.
      expect(reasons).toContain(RETRY_STOP_REASONS.RETRY_SLOTS_EXHAUSTED);
      expect(horizon.requests.length).toBeLessThan(nodes.length * 3);
      expect(redis.keys('horizon:retry:slot:')).toHaveLength(0);
    });

    it('keeps serving requests when Redis fails mid-flight', async () => {
      const redis = createFakeRedis();
      const c = client();
      c.configureRetryCoordination({ redisClient: redis });
      redis.setFailure(new Error('ECONNRESET'));

      horizon.script([{ status: 503 }, { status: 200, body: FEE_STATS }]);
      await expect(c.getFeeStats()).resolves.toBeTruthy();
      expect(c.getRetryManager().getConfig().coordination.stats.fallbacks).toBeGreaterThan(0);
    });
  });
});
