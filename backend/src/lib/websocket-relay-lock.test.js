import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./redis.js", () => ({
  connectRedisClient: vi.fn(async () => ({ isOpen: false })),
}));

import { logger } from "./logger.js";
import { createFakeRedis } from "../../tests/helpers/fake-redis.js";
import {
  DEFAULT_RELAY_LOCK_TTL_MS,
  RELAY_LOCK_BUSY,
  RELAY_LOCK_LOST,
  RELEASE_RELAY_LOCK_SCRIPT,
  RENEW_RELAY_LOCK_SCRIPT,
  RelayLockScope,
  acquireRelayLock,
  buildRelayLockKey,
  createSingleFlight,
  resetLocalRelayLocksForTests,
  resolveRelayLockTtlMs,
  tryAcquireRelayLock,
  withRelayLock,
} from "./websocket-relay-lock.js";
import {
  relayLockAcquisitionsTotal,
  relayLockLostTotal,
} from "./websocket-relay-metrics.js";

async function counterValue(counter, labels) {
  const { values } = await counter.get();
  const match = values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match ? match.value : 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLocalRelayLocksForTests();
  relayLockAcquisitionsTotal.reset();
  relayLockLostTotal.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildRelayLockKey (issue #1455)", () => {
  it("namespaces by scope and hashes the resource", () => {
    const key = buildRelayLockKey(RelayLockScope.EVENT, "evt_123");
    expect(key).toMatch(/^lock:ws-relay:event:[0-9a-f]{64}$/);
    expect(key).not.toContain("evt_123");
  });

  it("is deterministic per resource and distinct across scopes", () => {
    expect(buildRelayLockKey("event", "a")).toBe(buildRelayLockKey("event", "a"));
    expect(buildRelayLockKey("event", "a")).not.toBe(buildRelayLockKey("dlq-drain", "a"));
  });

  it("neutralises key-injection characters in the resource", () => {
    const key = buildRelayLockKey("connection", "conn:1\r\nDEL *");
    expect(key.split(":")).toHaveLength(4);
    expect(key).not.toMatch(/[\r\n* ]/);
  });

  it("rejects unknown scopes, empty and oversized resources", () => {
    expect(() => buildRelayLockKey("admin", "x")).toThrow(TypeError);
    expect(() => buildRelayLockKey("event", "")).toThrow(TypeError);
    expect(() => buildRelayLockKey("event", "   ")).toThrow(TypeError);
    expect(() => buildRelayLockKey("event", 42)).toThrow(TypeError);
    expect(() => buildRelayLockKey("event", "x".repeat(513))).toThrow(RangeError);
  });
});

describe("resolveRelayLockTtlMs", () => {
  it("defaults, clamps and reads the env override", () => {
    expect(resolveRelayLockTtlMs(undefined, {})).toBe(DEFAULT_RELAY_LOCK_TTL_MS);
    expect(resolveRelayLockTtlMs("abc", {})).toBe(DEFAULT_RELAY_LOCK_TTL_MS);
    expect(resolveRelayLockTtlMs(10, {})).toBe(1_000);
    expect(resolveRelayLockTtlMs(10_000_000, {})).toBe(120_000);
    expect(resolveRelayLockTtlMs(undefined, { WS_RELAY_LOCK_TTL_MS: "5000" })).toBe(5_000);
  });
});

describe("tryAcquireRelayLock with Redis", () => {
  it("acquires with SET NX PX and blocks a second holder across instances", async () => {
    const redis = createFakeRedis();
    const getRedis = async () => redis;
    const key = buildRelayLockKey("event", "evt_1");

    const first = await tryAcquireRelayLock(key, { getRedis, ttlMs: 5_000 });
    const second = await tryAcquireRelayLock(key, { getRedis, ttlMs: 5_000 });

    expect(first).toMatchObject({ key, backend: "redis", ttlMs: 5_000 });
    expect(second).toBeNull();
    expect(redis.calls[0]).toEqual(["SET", key, first.token, "NX", "PX", "5000"]);
    expect(await counterValue(relayLockAcquisitionsTotal, { scope: "event", result: "acquired" })).toBe(1);
    expect(await counterValue(relayLockAcquisitionsTotal, { scope: "event", result: "contended" })).toBe(1);
  });

  it("only lets the owner release, via compare-and-delete", async () => {
    const redis = createFakeRedis();
    const getRedis = async () => redis;
    const key = buildRelayLockKey("event", "evt_2");

    const lease = await tryAcquireRelayLock(key, { getRedis });
    redis.store.set(key, { value: "someone-else", expiresAt: null });

    expect(await lease.release()).toBe(false);
    expect(redis.keys(key)).toEqual([key]);
    expect(redis.calls.at(-1)).toEqual(["EVAL", RELEASE_RELAY_LOCK_SCRIPT, "1", key, lease.token]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("renews only while the lease is still owned", async () => {
    vi.useFakeTimers();
    const redis = createFakeRedis();
    const getRedis = async () => redis;
    const key = buildRelayLockKey("dlq-drain", "global");

    const lease = await tryAcquireRelayLock(key, { getRedis, ttlMs: 2_000 });
    vi.advanceTimersByTime(1_500);
    expect(await lease.renew()).toBe(true);
    expect(redis.calls.at(-1)).toEqual(["EVAL", RENEW_RELAY_LOCK_SCRIPT, "1", key, lease.token, "2000"]);

    vi.advanceTimersByTime(1_500);
    expect(redis.keys(key)).toEqual([key]); // still alive thanks to the renewal

    vi.advanceTimersByTime(1_000);
    expect(await lease.renew()).toBe(false); // expired: renewal must not resurrect it
    expect(await tryAcquireRelayLock(key, { getRedis })).not.toBeNull();
  });

  it("falls back to the local lock when SET fails", async () => {
    const redis = createFakeRedis();
    redis.setFailure(new Error("READONLY"));
    const key = buildRelayLockKey("event", "evt_3");

    const lease = await tryAcquireRelayLock(key, { getRedis: async () => redis });

    expect(lease.backend).toBe("local");
    expect(await counterValue(relayLockAcquisitionsTotal, { scope: "event", result: "error" })).toBe(1);
  });

  it("treats a renewal error as a lost lease", async () => {
    const redis = createFakeRedis();
    const key = buildRelayLockKey("event", "evt_4");
    const lease = await tryAcquireRelayLock(key, { getRedis: async () => redis });

    redis.setFailure(new Error("connection reset"));
    expect(await lease.renew()).toBe(false);
    expect(await lease.release()).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

describe("tryAcquireRelayLock local fallback", () => {
  it("uses the local lock when Redis is a no-op client", async () => {
    const key = buildRelayLockKey("connection", "c1");
    const lease = await tryAcquireRelayLock(key);
    expect(lease.backend).toBe("local");
    expect(await tryAcquireRelayLock(key)).toBeNull();
    expect(await lease.release()).toBe(true);
    expect(await tryAcquireRelayLock(key)).not.toBeNull();
  });

  it("uses the local lock when connecting to Redis throws", async () => {
    const key = buildRelayLockKey("connection", "c2");
    const lease = await tryAcquireRelayLock(key, {
      getRedis: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(lease.backend).toBe("local");
  });

  it("does not release or renew a local lease it no longer owns", async () => {
    vi.useFakeTimers();
    const key = buildRelayLockKey("connection", "c3");
    const stale = await tryAcquireRelayLock(key, { ttlMs: 1_000 });
    vi.advanceTimersByTime(1_001);
    const fresh = await tryAcquireRelayLock(key, { ttlMs: 1_000 });

    expect(await stale.renew()).toBe(false);
    expect(await stale.release()).toBe(false);
    expect(await fresh.renew()).toBe(true);
  });
});

describe("acquireRelayLock waiting", () => {
  it("returns null immediately when waitMs is 0 and the lock is held", async () => {
    const key = buildRelayLockKey("event", "w1");
    await tryAcquireRelayLock(key);
    const sleep = vi.fn();
    expect(await acquireRelayLock(key, { waitMs: 0, sleep })).toBeNull();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("polls until the holder releases within the wait budget", async () => {
    const key = buildRelayLockKey("event", "w2");
    const holder = await tryAcquireRelayLock(key);
    let clock = 0;
    const sleep = vi.fn(async (ms) => {
      clock += ms;
      if (clock >= 200) await holder.release();
    });

    const lease = await acquireRelayLock(key, {
      waitMs: 1_000,
      retryIntervalMs: 100,
      sleep,
      now: () => clock,
    });

    expect(lease).not.toBeNull();
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [ms] of sleep.mock.calls) {
      expect(ms).toBeGreaterThanOrEqual(75);
      expect(ms).toBeLessThanOrEqual(125);
    }
  });

  it("gives up once the wait budget is spent", async () => {
    const key = buildRelayLockKey("event", "w3");
    await tryAcquireRelayLock(key);
    let clock = 0;
    const lease = await acquireRelayLock(key, {
      waitMs: 300,
      retryIntervalMs: 100,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(lease).toBeNull();
    expect(clock).toBeLessThanOrEqual(300);
  });
});

describe("withRelayLock", () => {
  it("runs the work once and releases the lock afterwards", async () => {
    const redis = createFakeRedis();
    const getRedis = async () => redis;
    const work = vi.fn(async ({ lease, signal }) => {
      expect(signal.aborted).toBe(false);
      expect(redis.keys(lease.key)).toEqual([lease.key]);
      return "delivered";
    });

    await expect(withRelayLock("event", "evt_9", work, { getRedis })).resolves.toBe("delivered");
    expect(work).toHaveBeenCalledTimes(1);
    expect(redis.keys("lock:ws-relay:")).toEqual([]);
  });

  it("delivers a contested event exactly once across concurrent workers", async () => {
    const redis = createFakeRedis({ latencyMs: 1 });
    const getRedis = async () => redis;
    const deliver = vi.fn(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => withRelayLock("event", "evt_race", deliver, { getRedis })),
    );

    expect(deliver).toHaveBeenCalledTimes(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ status: 409, code: RELAY_LOCK_BUSY, retryable: true });
    }
  });

  it("releases the lock when the work throws", async () => {
    const redis = createFakeRedis();
    const getRedis = async () => redis;
    await expect(
      withRelayLock("dlq-drain", "global", async () => {
        throw new Error("upstream down");
      }, { getRedis }),
    ).rejects.toThrow("upstream down");
    expect(redis.keys("lock:ws-relay:")).toEqual([]);
  });

  it("aborts the work with RELAY_LOCK_LOST when renewal fails", async () => {
    vi.useFakeTimers();
    const redis = createFakeRedis();
    const getRedis = async () => redis;
    let observedReason;

    const run = withRelayLock(
      "dlq-drain",
      "global",
      ({ lease, signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            observedReason = signal.reason;
            resolve("stopped");
          });
          // Another worker steals the key (e.g. after a GC pause).
          redis.store.set(lease.key, { value: "thief", expiresAt: null });
        }),
      { getRedis, ttlMs: 3_000 },
    );

    await vi.advanceTimersByTimeAsync(2_500);
    await expect(run).resolves.toBe("stopped");
    expect(observedReason).toMatchObject({ code: RELAY_LOCK_LOST });
    expect(await counterValue(relayLockLostTotal, { scope: "dlq-drain" })).toBe(1);
    // The thief's lease survives: we never delete a key we do not own.
    expect(redis.store.get(buildRelayLockKey("dlq-drain", "global")).value).toBe("thief");
  });

  it("keeps a long critical section alive by renewing the lease", async () => {
    vi.useFakeTimers();
    const redis = createFakeRedis();
    const getRedis = async () => redis;
    const key = buildRelayLockKey("dlq-drain", "long");

    const run = withRelayLock(
      "dlq-drain",
      "long",
      ({ signal }) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(signal.aborted), 5_000);
        }),
      { getRedis, ttlMs: 1_500 },
    );

    await vi.advanceTimersByTimeAsync(4_000);
    expect(await tryAcquireRelayLock(key, { getRedis })).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(run).resolves.toBe(false);
  });

  it("rejects a non-function before touching the lock", async () => {
    await expect(withRelayLock("event", "x", null)).rejects.toThrow(TypeError);
  });
});

describe("createSingleFlight", () => {
  it("coalesces concurrent calls for the same key", async () => {
    const flight = createSingleFlight();
    let resolveConnect;
    const connect = vi.fn(() => new Promise((resolve) => {
      resolveConnect = resolve;
    }));

    const a = flight.run("upstream", connect);
    const b = flight.run("upstream", connect);
    await Promise.resolve();
    expect(flight.has("upstream")).toBe(true);
    resolveConnect("socket");

    await expect(Promise.all([a, b])).resolves.toEqual(["socket", "socket"]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(flight.size).toBe(0);
  });

  it("shares a failure and allows a fresh attempt afterwards", async () => {
    const flight = createSingleFlight();
    const failing = vi.fn().mockRejectedValue(new Error("refused"));
    await expect(Promise.all([flight.run("k", failing), flight.run("k", failing)])).rejects.toThrow(
      "refused",
    );
    expect(failing).toHaveBeenCalledTimes(1);

    const ok = vi.fn().mockResolvedValue("ok");
    await expect(flight.run("k", ok)).resolves.toBe("ok");
  });

  it("keeps different keys independent", async () => {
    const flight = createSingleFlight();
    const fn = vi.fn().mockResolvedValue(1);
    await Promise.all([flight.run("a", fn), flight.run("b", fn)]);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
