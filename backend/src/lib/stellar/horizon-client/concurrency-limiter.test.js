/**
 * Unit tests for the Horizon Client concurrency limiter (issue #1440).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ConcurrencyLimiter,
  createBackpressureError,
  resolveConcurrencyOptions,
} from './concurrency-limiter.js';
import { DEFAULT_CONCURRENCY_OPTIONS, RETRY_MANAGER_ERROR_CODES } from './constants.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveConcurrencyOptions', () => {
  it('uses defaults, then env, then explicit options', () => {
    expect(resolveConcurrencyOptions({}, {})).toEqual(DEFAULT_CONCURRENCY_OPTIONS);
    expect(resolveConcurrencyOptions({}, { HORIZON_CLIENT_MAX_CONCURRENCY: '8' }).maxConcurrent).toBe(8);
    expect(resolveConcurrencyOptions({ maxConcurrent: 2 }, { HORIZON_CLIENT_MAX_CONCURRENCY: '8' }).maxConcurrent).toBe(2);
  });

  it('never allows zero concurrency and rejects garbage', () => {
    expect(resolveConcurrencyOptions({ maxConcurrent: 0 }, {}).maxConcurrent).toBe(1);
    expect(resolveConcurrencyOptions({ maxConcurrent: 'lots' }, {}).maxConcurrent)
      .toBe(DEFAULT_CONCURRENCY_OPTIONS.maxConcurrent);
    expect(resolveConcurrencyOptions({ maxQueue: -5 }, {}).maxQueue).toBe(0);
  });
});

describe('ConcurrencyLimiter', () => {
  it('runs up to maxConcurrent operations at once', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 2, maxQueue: 10 });
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;

    const tasks = gates.map((gate) =>
      limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await Promise.resolve();
    expect(limiter.getStats()).toMatchObject({ active: 2, pending: 1 });

    gates.forEach((g) => g.resolve());
    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(limiter.getStats()).toMatchObject({ active: 0, pending: 0 });
  });

  it('hands slots to waiters in FIFO order', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 10 });
    const order = [];
    const first = await limiter.acquire();
    const waiters = [1, 2, 3].map((n) => limiter.acquire().then((release) => {
      order.push(n);
      release();
    }));
    first();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects immediately with 503 when the queue is full', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1 });
    const release = await limiter.acquire('loadAccount');
    const queued = limiter.acquire('loadAccount');

    await expect(limiter.acquire('loadAccount')).rejects.toMatchObject({
      status: 503,
      code: RETRY_MANAGER_ERROR_CODES.QUEUE_FULL,
      operation: 'loadAccount',
      retryable: false,
    });

    release();
    (await queued)();
  });

  it('rejects a waiter that exceeds queueTimeoutMs and removes it from the queue', async () => {
    vi.useFakeTimers();
    const onQueueChange = vi.fn();
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 100, onQueueChange });
    const release = await limiter.acquire();
    const waiting = limiter.acquire('fetchPayments');
    const assertion = expect(waiting).rejects.toMatchObject({
      status: 503,
      code: RETRY_MANAGER_ERROR_CODES.QUEUE_TIMEOUT,
    });

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(limiter.pending).toBe(0);
    expect(onQueueChange).toHaveBeenLastCalledWith(0);

    release();
    expect(limiter.getStats().active).toBe(0);
  });

  it('release is idempotent', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 0 });
    const release = await limiter.acquire();
    expect(release()).toBe(true);
    expect(release()).toBe(false);
    expect(limiter.getStats().active).toBe(0);

    // Still only one slot after the double release.
    const again = await limiter.acquire();
    await expect(limiter.acquire()).rejects.toMatchObject({ code: RETRY_MANAGER_ERROR_CODES.QUEUE_FULL });
    again();
  });

  it('releases the slot when the wrapped function throws', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });
    await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(limiter.getStats().active).toBe(0);
  });

  it('a throwing queue observer cannot break the limiter', async () => {
    const limiter = new ConcurrencyLimiter({
      maxConcurrent: 1,
      onQueueChange: () => { throw new Error('metrics down'); },
    });
    const release = await limiter.acquire();
    const queued = limiter.acquire();
    release();
    (await queued)();
    expect(limiter.getStats()).toMatchObject({ active: 0, pending: 0 });
  });
});

describe('createBackpressureError', () => {
  it('produces distinct messages per code', () => {
    expect(createBackpressureError(RETRY_MANAGER_ERROR_CODES.QUEUE_FULL, 'op').message).toMatch(/too many/);
    expect(createBackpressureError(RETRY_MANAGER_ERROR_CODES.QUEUE_TIMEOUT, 'op').message).toMatch(/timed out/);
  });
});
