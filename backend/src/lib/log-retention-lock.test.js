import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  LOG_RETENTION_LOCK_PREFIX,
  acquireLogRetentionLock,
  buildLogRetentionLockKey,
  resetLogRetentionLocks,
  withLogRetentionLock,
} from "./log-retention-lock.js";
import { logRetentionLockTotal } from "./log-retention-telemetry.js";

const KEY = buildLogRetentionLockKey("webhook_delivery_logs");
const noRetry = { maxAttempts: 1 };

async function lockCount(result) {
  const { values } = await logRetentionLockTotal.get();
  return values.find((v) => v.labels.result === result)?.value ?? 0;
}

/** pg Pool double: connect() hands out one client whose query is scripted. */
function makePool(queryImpl) {
  const client = {
    query: vi.fn(queryImpl),
    release: vi.fn(),
  };
  return {
    client,
    pool: {
      query: vi.fn(),
      connect: vi.fn(async () => client),
    },
  };
}

const granted = async (sql) =>
  /advisory_unlock/.test(sql)
    ? { rows: [{ released: true }] }
    : { rows: [{ acquired: true }] };

describe("buildLogRetentionLockKey (#1475)", () => {
  it("namespaces the table name", () => {
    expect(KEY).toBe(`${LOG_RETENTION_LOCK_PREFIX}:webhook_delivery_logs`);
  });

  it.each(["", null, "Webhook", "logs; DROP TABLE x", "a-b", "1abc", 7])(
    "rejects %p",
    (name) => {
      expect(() => buildLogRetentionLockKey(name)).toThrow(TypeError);
    },
  );
});

describe("acquireLogRetentionLock", () => {
  beforeEach(() => {
    resetLogRetentionLocks();
  });

  it("takes a session advisory lock on a dedicated connection and releases it", async () => {
    const acquiredBefore = await lockCount("acquired");
    const { pool, client } = makePool(granted);

    const lock = await acquireLogRetentionLock(pool, KEY, noRetry);

    expect(lock).not.toBeNull();
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_try_advisory_lock(hashtext($1))"),
      [KEY],
    );
    expect(await lockCount("acquired")).toBe(acquiredBefore + 1);

    await expect(lock.release()).resolves.toBe(true);
    expect(client.query).toHaveBeenLastCalledWith(
      expect.stringContaining("pg_advisory_unlock(hashtext($1))"),
      [KEY],
    );
    expect(client.release).toHaveBeenCalledWith();
  });

  it("returns null and frees the connection when another session holds the lock", async () => {
    const before = await lockCount("contended");
    const { pool, client } = makePool(async () => ({ rows: [{ acquired: false }] }));

    await expect(acquireLogRetentionLock(pool, KEY, noRetry)).resolves.toBeNull();
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(await lockCount("contended")).toBe(before + 1);

    // The in-process guard was cleared: a later attempt reaches the database.
    await acquireLogRetentionLock(pool, KEY, noRetry);
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  it("skips a second acquire on the same pool without touching the database", async () => {
    const { pool } = makePool(granted);
    const first = await acquireLogRetentionLock(pool, KEY, noRetry);

    await expect(acquireLogRetentionLock(pool, KEY, noRetry)).resolves.toBeNull();
    expect(pool.connect).toHaveBeenCalledTimes(1);

    await first.release();
    const again = await acquireLogRetentionLock(pool, KEY, noRetry);
    expect(again).not.toBeNull();
    await again.release();
  });

  it("treats separate pools as separate instances", async () => {
    const a = makePool(granted);
    const b = makePool(granted);
    const lockA = await acquireLogRetentionLock(a.pool, KEY, noRetry);
    const lockB = await acquireLogRetentionLock(b.pool, KEY, noRetry);
    expect(b.pool.connect).toHaveBeenCalledTimes(1);
    await lockA.release();
    await lockB.release();
  });

  it("destroys the connection and rethrows when acquiring errors", async () => {
    const before = await lockCount("error");
    const err = Object.assign(new Error("permission denied"), { code: "42501" });
    const { pool, client } = makePool(async () => {
      throw err;
    });

    await expect(acquireLogRetentionLock(pool, KEY, noRetry)).rejects.toBe(err);
    expect(client.release).toHaveBeenCalledWith(err);
    expect(await lockCount("error")).toBe(before + 1);

    // Guard cleared after the failure.
    await expect(acquireLogRetentionLock(pool, KEY, noRetry)).rejects.toBe(err);
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  it("retries a transient acquire failure", async () => {
    let calls = 0;
    const { pool } = makePool(async (sql) => {
      if (/try_advisory_lock/.test(sql) && calls++ === 0) {
        throw Object.assign(new Error("deadlock"), { code: "40P01" });
      }
      return granted(sql);
    });

    const lock = await acquireLogRetentionLock(pool, KEY, {
      maxAttempts: 3,
      baseDelayMs: 0,
      sleep: async () => {},
    });
    expect(lock).not.toBeNull();
    await lock.release();
  });

  it("rethrows when the pool cannot hand out a connection", async () => {
    const err = new Error("too many clients");
    const pool = { query: vi.fn(), connect: vi.fn().mockRejectedValue(err) };
    await expect(acquireLogRetentionLock(pool, KEY, noRetry)).rejects.toBe(err);
    // Not left marked as held.
    pool.connect.mockResolvedValueOnce({ query: granted, release: vi.fn() });
    await expect(acquireLogRetentionLock(pool, KEY, noRetry)).resolves.not.toBeNull();
  });

  it("destroys the connection when release fails, and only releases once", async () => {
    const { pool, client } = makePool(async (sql) => {
      if (/advisory_unlock/.test(sql)) throw new Error("connection lost");
      return { rows: [{ acquired: true }] };
    });
    const lock = await acquireLogRetentionLock(pool, KEY, noRetry);

    await expect(lock.release()).resolves.toBe(false);
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    await expect(lock.release()).resolves.toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);

    // Guard cleared even though the release failed.
    const next = await acquireLogRetentionLock(pool, KEY, noRetry);
    expect(next).not.toBeNull();
  });

  it("reports false when the lock was already gone at release", async () => {
    const { pool, client } = makePool(async (sql) =>
      /advisory_unlock/.test(sql) ? { rows: [{ released: false }] } : { rows: [{ acquired: true }] },
    );
    const lock = await acquireLogRetentionLock(pool, KEY, noRetry);
    await expect(lock.release()).resolves.toBe(false);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("works on a single client without connect()", async () => {
    const client = { query: vi.fn(granted) };
    const lock = await acquireLogRetentionLock(client, KEY, noRetry);
    expect(lock).not.toBeNull();
    await expect(lock.release()).resolves.toBe(true);
  });

  it("requires a pool", async () => {
    await expect(acquireLogRetentionLock(null, KEY)).rejects.toThrow(/pg pool/);
  });
});

describe("withLogRetentionLock", () => {
  beforeEach(() => resetLogRetentionLocks());

  it("runs fn under the lock and releases it afterwards", async () => {
    const { pool, client } = makePool(granted);
    const fn = vi.fn(async () => 42);

    await expect(withLogRetentionLock(pool, KEY, fn, noRetry)).resolves.toEqual({
      skipped: false,
      result: 42,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("skips fn when the lock is held elsewhere", async () => {
    const { pool } = makePool(async () => ({ rows: [{ acquired: false }] }));
    const fn = vi.fn();

    await expect(withLogRetentionLock(pool, KEY, fn, noRetry)).resolves.toEqual({ skipped: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("releases the lock when fn throws", async () => {
    const { pool, client } = makePool(granted);
    const err = new Error("purge failed");

    await expect(
      withLogRetentionLock(pool, KEY, async () => {
        throw err;
      }, noRetry),
    ).rejects.toBe(err);
    expect(client.query).toHaveBeenLastCalledWith(
      expect.stringContaining("pg_advisory_unlock"),
      [KEY],
    );
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
