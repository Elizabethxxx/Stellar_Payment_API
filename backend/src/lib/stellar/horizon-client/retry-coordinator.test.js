/**
 * Unit tests for the Horizon retry coordinator (issue #1440).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  HorizonRetryCoordinator,
  RELEASE_SLOT_SCRIPT,
  configureHorizonRetryCoordination,
  hashHorizonScope,
  resetHorizonRetryCoordination,
  resolveCoordinationOptions,
  sanitizeOperationName,
} from './retry-coordinator.js';
import { DEFAULT_RETRY_COORDINATION_OPTIONS } from './constants.js';
import { createFakeRedis } from '../../../../tests/helpers/fake-redis.js';
import { logger } from '../../logger.js';

afterEach(() => {
  resetHorizonRetryCoordination();
  vi.clearAllMocks();
});

describe('helpers', () => {
  it('sanitizeOperationName only allows a bounded safe alphabet', () => {
    expect(sanitizeOperationName('loadAccount')).toBe('loadAccount');
    expect(sanitizeOperationName('a:b')).toBe('unknown');
    expect(sanitizeOperationName('x'.repeat(65))).toBe('unknown');
    expect(sanitizeOperationName(undefined)).toBe('unknown');
  });

  it('hashHorizonScope is stable and does not leak the URL', () => {
    const a = hashHorizonScope('https://horizon.stellar.org');
    expect(a).toBe(hashHorizonScope('https://horizon.stellar.org'));
    expect(a).not.toBe(hashHorizonScope('https://horizon-testnet.stellar.org'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('resolveCoordinationOptions clamps values and rejects unsafe prefixes', () => {
    expect(resolveCoordinationOptions({}, {})).toEqual(DEFAULT_RETRY_COORDINATION_OPTIONS);
    const resolved = resolveCoordinationOptions({ maxConcurrentRetries: 0, keyPrefix: 'bad prefix\r\n' }, {});
    expect(resolved.maxConcurrentRetries).toBe(1);
    expect(resolved.keyPrefix).toBe(DEFAULT_RETRY_COORDINATION_OPTIONS.keyPrefix);
    expect(resolveCoordinationOptions({}, { HORIZON_RETRY_MAX_CONCURRENT_RETRIES: '7' }).maxConcurrentRetries).toBe(7);
  });

  it('the release script is a compare-and-delete', () => {
    expect(RELEASE_SLOT_SCRIPT).toMatch(/get.*KEYS\[1\].*ARGV\[1\].*del/);
  });
});

describe.each([
  ['local', () => null],
  ['redis', () => createFakeRedis()],
])('retry slots (%s backend)', (backend, makeRedis) => {
  const make = (opts = {}) => new HorizonRetryCoordinator({
    redisClient: makeRedis(),
    horizonUrl: 'https://horizon-testnet.stellar.org',
    maxConcurrentRetries: 2,
    ...opts,
  });

  it(`reports the ${backend} backend`, () => {
    expect(make().backend).toBe(backend);
  });

  it('grants at most maxConcurrentRetries slots per operation', async () => {
    const c = make();
    const a = await c.acquireRetrySlot('loadAccount');
    const b = await c.acquireRetrySlot('loadAccount');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(await c.acquireRetrySlot('loadAccount')).toBeNull();
    // Other operations have their own budget.
    expect(await c.acquireRetrySlot('getFeeStats')).not.toBeNull();
    expect(c.getConfig().stats).toMatchObject({ granted: 3, denied: 1 });
  });

  it('frees a slot on release, and release is single-use', async () => {
    const c = make({ maxConcurrentRetries: 1 });
    const slot = await c.acquireRetrySlot('loadAccount');
    expect(await slot.release()).toBe(true);
    expect(await slot.release()).toBe(false);
    expect(await c.acquireRetrySlot('loadAccount')).not.toBeNull();
  });

  it('caps and only extends the cooldown', async () => {
    const c = make({ maxCooldownMs: 1_000 });
    expect(await c.getCooldownRemainingMs()).toBe(0);
    expect(await c.recordCooldown(60_000)).toBe(1_000);
    const remaining = await c.getCooldownRemainingMs();
    expect(remaining).toBeGreaterThan(900);
    expect(remaining).toBeLessThanOrEqual(1_000);

    await c.recordCooldown(10);
    expect(await c.getCooldownRemainingMs()).toBeGreaterThan(900);
  });

  it('ignores zero, negative and garbage cooldowns', async () => {
    const c = make();
    expect(await c.recordCooldown(0)).toBe(0);
    expect(await c.recordCooldown(-50)).toBe(0);
    expect(await c.recordCooldown('soon')).toBe(0);
    expect(await c.getCooldownRemainingMs()).toBe(0);
  });
});

describe('distributed behaviour', () => {
  it('shares retry slots between coordinators (instances) on the same Redis', async () => {
    const redis = createFakeRedis();
    const url = 'https://horizon.stellar.org';
    const a = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: url, maxConcurrentRetries: 1 });
    const b = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: url, maxConcurrentRetries: 1 });

    const slot = await a.acquireRetrySlot('loadAccount');
    expect(slot.backend).toBe('redis');
    expect(await b.acquireRetrySlot('loadAccount')).toBeNull();

    await slot.release();
    expect(await b.acquireRetrySlot('loadAccount')).not.toBeNull();
  });

  it('keeps different Horizon hosts independent', async () => {
    const redis = createFakeRedis();
    const main = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: 'https://a', maxConcurrentRetries: 1 });
    const test = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: 'https://b', maxConcurrentRetries: 1 });
    expect(await main.acquireRetrySlot('op')).not.toBeNull();
    expect(await test.acquireRetrySlot('op')).not.toBeNull();
  });

  it('shares the cooldown between instances', async () => {
    const redis = createFakeRedis();
    const a = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: 'h' });
    const b = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: 'h' });
    await a.recordCooldown(2_000);
    expect(await b.getCooldownRemainingMs()).toBeGreaterThan(1_500);
  });

  it('an expired lease frees the slot, and a stale holder cannot delete the new owner', async () => {
    vi.useFakeTimers();
    try {
      const redis = createFakeRedis();
      const a = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: 'h', maxConcurrentRetries: 1 });
      const b = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: 'h', maxConcurrentRetries: 1 });

      const stale = await a.acquireRetrySlot('op', { leaseMs: 1_000 });
      vi.advanceTimersByTime(1_001);
      const fresh = await b.acquireRetrySlot('op', { leaseMs: 5_000 });
      expect(fresh).not.toBeNull();

      expect(await stale.release()).toBe(false);
      expect(await a.acquireRetrySlot('op')).toBeNull();
      expect(await fresh.release()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never trusts a corrupted or far-future shared cooldown beyond the cap', async () => {
    const redis = createFakeRedis();
    const c = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: 'h', maxCooldownMs: 500 });
    redis.store.set(c.cooldownKey, { value: String(Date.now() + 10 * 60_000), expiresAt: null });
    expect(await c.getCooldownRemainingMs()).toBe(500);

    redis.store.set(c.cooldownKey, { value: 'not-a-number', expiresAt: null });
    expect(await c.getCooldownRemainingMs()).toBe(0);
  });

  it('only writes namespaced keys built from hashed host and sanitized operation', async () => {
    const redis = createFakeRedis();
    const c = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: 'https://h' });
    await c.acquireRetrySlot('evil key\r\nFLUSHALL');
    await c.recordCooldown(100);
    for (const key of redis.store.keys()) {
      expect(key).toMatch(/^horizon:retry:(slot|cooldown):[0-9a-f]{16}(:unknown:\d+)?$/);
    }
  });
});

describe('fail-open behaviour', () => {
  it('falls back to local slots when Redis errors', async () => {
    const redis = createFakeRedis();
    redis.setFailure(new Error('ECONNRESET'));
    const c = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: 'h', maxConcurrentRetries: 1 });

    const slot = await c.acquireRetrySlot('op');
    expect(slot.backend).toBe('local');
    expect(await c.acquireRetrySlot('op')).toBeNull();
    expect(c.getConfig().stats.fallbacks).toBe(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('keeps a local cooldown when Redis errors', async () => {
    const redis = createFakeRedis();
    const c = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: 'h' });
    redis.setFailure(new Error('down'));
    await c.recordCooldown(1_000);
    expect(await c.getCooldownRemainingMs()).toBeGreaterThan(0);
  });

  it('treats a closed or no-op client as local', () => {
    expect(new HorizonRetryCoordinator({ redisClient: { isOpen: false, sendCommand: vi.fn() } }).backend).toBe('local');
    expect(new HorizonRetryCoordinator({ redisClient: { isOpen: true } }).backend).toBe('local');
  });

  it('a slot release error is swallowed (the lease expires on its own)', async () => {
    const redis = createFakeRedis();
    const c = new HorizonRetryCoordinator({ redisClient: redis, horizonUrl: 'h' });
    const slot = await c.acquireRetrySlot('op');
    redis.setFailure(new Error('gone'));
    await expect(slot.release()).resolves.toBe(false);
  });
});

describe('configureHorizonRetryCoordination', () => {
  it('upgrades coordinators that were created without an explicit client', async () => {
    const lazy = new HorizonRetryCoordinator({ horizonUrl: 'h' });
    const forcedLocal = new HorizonRetryCoordinator({ redisClient: null, horizonUrl: 'h' });
    expect(lazy.backend).toBe('local');

    const redis = createFakeRedis();
    expect(configureHorizonRetryCoordination({ redisClient: redis })).toBe(true);
    expect(lazy.backend).toBe('redis');
    expect(forcedLocal.backend).toBe('local');

    await lazy.acquireRetrySlot('op');
    expect(redis.count('SET')).toBe(1);
  });

  it('ignores missing or closed clients', () => {
    expect(configureHorizonRetryCoordination()).toBe(false);
    expect(configureHorizonRetryCoordination({ redisClient: { isOpen: false, sendCommand: vi.fn() } })).toBe(false);
  });
});
