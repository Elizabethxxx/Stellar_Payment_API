/**
 * Log Retention & Archival Service — stress suite (issue #1476).
 *
 * Many simulated instances (one pool each) purge one shared in-memory
 * Postgres double concurrently, with injected latency and transient
 * failures. No network and no real database.
 *
 * Invariants checked under load:
 *   - every expired row is deleted exactly once; rows inside the retention
 *     window are never touched
 *   - at most one instance holds the purge lock at any moment
 *   - no advisory lock, connection or in-process guard leaks, including
 *     after failures
 *   - run counters add up: success + failure + skipped == attempts
 *   - retries absorb a high rate of transient errors
 *
 * Run with:  npm run test:load -- log-retention-stress
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { purgeWebhookLogs, runLogRetentionPurge } from "../src/lib/log-retention.js";
import {
  logRetentionRunsTotal,
  resetLogRetentionHealth,
} from "../src/lib/log-retention-telemetry.js";
import { resetLogRetentionLocks } from "../src/lib/log-retention-lock.js";
import { createFakeLogRetentionDb, makeRows, pgError } from "../tests/helpers/fake-log-retention-db.js";

const fastRetry = { sleep: async () => {}, baseDelayMs: 0, maxAttempts: 8 };

/** Deterministic PRNG so a failing seed can be replayed. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function runs(outcome) {
  const { values } = await logRetentionRunsTotal.get();
  return values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
}

describe("log retention stress", () => {
  beforeEach(() => {
    resetLogRetentionHealth();
    resetLogRetentionLocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("50 instances racing: one purges, the rest skip, every expired row deleted once", async () => {
    const expired = makeRows(5_000, 90, "old");
    const kept = makeRows(500, 3, "new");
    const db = createFakeLogRetentionDb({ rows: [...expired, ...kept], latencyMs: 1 });

    const before = { success: await runs("success"), skipped: await runs("skipped") };
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        runLogRetentionPurge({
          pool: db.createPool(),
          retentionDays: 30,
          batchSize: 250,
          retry: fastRetry,
        }),
      ),
    );

    const ran = results.filter((r) => !r.skipped);
    expect(ran).toHaveLength(1);
    expect(ran[0].totalDeleted).toBe(5_000);
    expect(results.filter((r) => r.skipped)).toHaveLength(49);
    expect(db.stats.maxLockHolders).toBe(1);
    expect(db.doubleDeletes).toEqual([]);
    expect(new Set(db.deleted).size).toBe(db.deleted.length);
    expect(db.remainingIds().sort()).toEqual(kept.map((r) => r.id).sort());
    expect(db.heldLocks()).toEqual([]);
    expect(db.stats.openConnections).toBe(0);
    expect(await runs("success")).toBe(before.success + 1);
    expect(await runs("skipped")).toBe(before.skipped + 49);
  });

  it("repeated waves with 20% transient failures converge with no leaks", async () => {
    const random = prng(1476);
    const transient = ["40001", "40P01", "55P03", "57014", "08006", "ECONNRESET"];
    const db = createFakeLogRetentionDb({
      rows: [...makeRows(3_000, 45, "old"), ...makeRows(300, 10, "new")],
      latencyMs: () => Math.floor(random() * 3),
      fail: (kind) =>
        kind !== "unlock" && random() < 0.2
          ? pgError(transient[Math.floor(random() * transient.length)])
          : null,
    });

    let attempts = 0;
    let outcomes = { ok: 0, skipped: 0, failed: 0 };
    for (let wave = 0; wave < 10 && db.remainingIds().length > 300; wave += 1) {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => {
          attempts += 1;
          return runLogRetentionPurge({
            pool: db.createPool(),
            retentionDays: 30,
            batchSize: 100,
            retry: fastRetry,
          });
        }),
      );
      for (const r of results) {
        if (r.status === "rejected") outcomes.failed += 1;
        else if (r.value.skipped) outcomes.skipped += 1;
        else outcomes.ok += 1;
      }
      expect(db.heldLocks()).toEqual([]);
      expect(db.stats.openConnections).toBe(0);
    }

    expect(outcomes.ok + outcomes.skipped + outcomes.failed).toBe(attempts);
    expect(outcomes.ok).toBeGreaterThanOrEqual(1);
    expect(db.remainingIds()).toHaveLength(300);
    expect(db.remainingIds().every((id) => id.startsWith("new-"))).toBe(true);
    expect(db.doubleDeletes).toEqual([]);
    expect(db.stats.maxLockHolders).toBe(1);
  });

  it("unlocked direct callers under contention still delete each row once (SKIP LOCKED)", async () => {
    const db = createFakeLogRetentionDb({
      rows: makeRows(4_000, 120),
      latencyMs: () => 1,
    });

    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        purgeWebhookLogs({
          pool: db.createPool(),
          retentionDays: 30,
          batchSize: 64,
          retry: fastRetry,
        }),
      ),
    );

    expect(results.reduce((sum, r) => sum + r.totalDeleted, 0)).toBe(4_000);
    expect(db.doubleDeletes).toEqual([]);
    expect(db.remainingIds()).toEqual([]);
  });

  it("a burst of triggers on one instance runs at most one purge at a time", async () => {
    const db = createFakeLogRetentionDb({ rows: makeRows(1_000, 40), latencyMs: 1 });
    const pool = db.createPool();

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        runLogRetentionPurge({ pool, retentionDays: 30, batchSize: 100, retry: fastRetry }),
      ),
    );

    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    // Skipped in-process: only the winner ever reached the database lock.
    expect(db.callCount("lock")).toBe(1);
    expect(db.remainingIds()).toEqual([]);
  });

  it("keeps purge throughput reasonable for a large backlog", async () => {
    const db = createFakeLogRetentionDb({ rows: makeRows(50_000, 365) });
    const started = Date.now();

    const result = await runLogRetentionPurge({
      pool: db.createPool(),
      retentionDays: 30,
      batchSize: 1_000,
      retry: fastRetry,
    });

    expect(result.totalDeleted).toBe(50_000);
    expect(db.callCount("delete")).toBe(51);
    // Generous ceiling: this guards against accidental O(n^2) per-row work
    // in the service, not against a slow CI machine.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
