/**
 * Log Retention & Archival Service — integration (issue #1476).
 *
 * Drives the real runLogRetentionPurge() -> lock -> retry -> purge ->
 * telemetry pipeline against an in-memory Postgres double that implements
 * the safety checks, `DELETE ... FOR UPDATE SKIP LOCKED` and session
 * advisory locks. Then checks the same state through the real Express app:
 * GET /metrics and GET /health/log-retention.
 *
 * No network, no real database: Supabase, Horizon and Redis are mocked as in
 * tests/integration/health.test.js.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL ||= "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
  process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
});

vi.mock("../../src/lib/stellar.js", () => ({
  findMatchingPayment: vi.fn(),
  findAnyRecentPayment: vi.fn(),
  findStrictReceivePaths: vi.fn(),
  getNetworkFeeStats: vi.fn(),
  isHorizonReachable: vi.fn(async () => true),
  isValidAssetCode: vi.fn(() => true),
  isValidStellarAccountId: vi.fn(() => true),
  isValidStellarPublicKey: vi.fn(() => true),
  validateMemo: vi.fn(() => ({ valid: true })),
  verifyTransactionSignature: vi.fn(),
  withHorizonRetry: vi.fn(),
}));

vi.mock("../../src/lib/supabase.js", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
      })),
    })),
  },
}));

import { createApp } from "../../src/app.js";
import { closePool } from "../../src/lib/db.js";
import { runLogRetentionPurge, purgeWebhookLogs } from "../../src/lib/log-retention.js";
import {
  getLogRetentionHealth,
  logRetentionLockTotal,
  logRetentionRetriesTotal,
  logRetentionRunsTotal,
  resetLogRetentionHealth,
} from "../../src/lib/log-retention-telemetry.js";
import {
  buildLogRetentionLockKey,
  resetLogRetentionLocks,
} from "../../src/lib/log-retention-lock.js";
import { createFakeLogRetentionDb, makeRows, pgError } from "../helpers/fake-log-retention-db.js";

const KEY = buildLogRetentionLockKey("webhook_delivery_logs");
const fastRetry = { sleep: async () => {}, baseDelayMs: 0, maxAttempts: 4 };

const mockRedisClient = {
  ping: vi.fn().mockResolvedValue("PONG"),
  on: vi.fn(),
  sendCommand: vi.fn().mockResolvedValue("mocked_hash"),
};

async function count(metric, labels) {
  const { values } = await metric.get();
  return (
    values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value ?? 0
  );
}

function seeded(extra = {}) {
  return createFakeLogRetentionDb({
    rows: [...makeRows(25, 45, "old"), ...makeRows(10, 5, "recent")],
    ...extra,
  });
}

describe("Log retention purge pipeline (integration)", () => {
  beforeEach(() => {
    resetLogRetentionHealth();
    resetLogRetentionLocks();
  });

  it("deletes only expired rows in batches and releases everything", async () => {
    const db = seeded();

    const result = await runLogRetentionPurge({
      pool: db.createPool(),
      retentionDays: 30,
      batchSize: 10,
      retry: fastRetry,
    });

    expect(result).toMatchObject({ skipped: false, totalDeleted: 25 });
    expect(db.remainingIds().sort()).toEqual(makeRows(10, 5, "recent").map((r) => r.id).sort());
    expect(db.doubleDeletes).toEqual([]);
    expect(db.heldLocks()).toEqual([]);
    expect(db.stats.openConnections).toBe(0);
    expect(db.callCount("delete")).toBe(4); // 10 + 10 + 5 + empty batch
    expect(getLogRetentionHealth()).toMatchObject({ status: "healthy", last_deleted_rows: 25 });
  });

  it("skips while another host holds the advisory lock, then runs once it is free", async () => {
    const db = seeded();
    const pool = db.createPool();
    const releaseOther = db.holdLock(KEY);
    const contended = await count(logRetentionLockTotal, { result: "contended" });

    await expect(runLogRetentionPurge({ pool, retry: fastRetry })).resolves.toMatchObject({
      skipped: true,
      reason: "locked",
    });
    expect(db.callCount("delete")).toBe(0);
    expect(db.stats.openConnections).toBe(0);
    expect(await count(logRetentionLockTotal, { result: "contended" })).toBe(contended + 1);

    releaseOther();
    await expect(
      runLogRetentionPurge({ pool, retentionDays: 30, retry: fastRetry }),
    ).resolves.toMatchObject({ skipped: false, totalDeleted: 25 });
  });

  it("lets only one of two concurrent instances purge", async () => {
    const db = seeded({ latencyMs: 5 });
    const [a, b] = await Promise.all([
      runLogRetentionPurge({ pool: db.createPool(), retentionDays: 30, batchSize: 5, retry: fastRetry }),
      runLogRetentionPurge({ pool: db.createPool(), retentionDays: 30, batchSize: 5, retry: fastRetry }),
    ]);

    const ran = [a, b].filter((r) => !r.skipped);
    expect(ran).toHaveLength(1);
    expect(ran[0].totalDeleted).toBe(25);
    expect(db.stats.maxLockHolders).toBe(1);
    expect(db.doubleDeletes).toEqual([]);
  });

  it("skips a second trigger in the same process without touching the database", async () => {
    const db = seeded({ latencyMs: 5 });
    const pool = db.createPool();
    const [a, b] = await Promise.all([
      runLogRetentionPurge({ pool, retentionDays: 30, batchSize: 5, retry: fastRetry }),
      runLogRetentionPurge({ pool, retentionDays: 30, batchSize: 5, retry: fastRetry }),
    ]);

    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
    expect(db.callCount("lock")).toBe(1);
  });

  it("recovers from transient failures on lock, checks and delete batches", async () => {
    const recovered = await count(logRetentionRetriesTotal, { result: "recovered" });
    const db = seeded({
      fail: (kind, call) => {
        if (kind === "lock" && call === 1) return pgError("57P01");
        if (kind === "index" && call === 1) return pgError("08006");
        if (kind === "delete" && call === 2) return pgError("40P01");
        return null;
      },
    });

    const result = await runLogRetentionPurge({
      pool: db.createPool(),
      retentionDays: 30,
      batchSize: 10,
      retry: fastRetry,
    });

    expect(result.totalDeleted).toBe(25);
    expect(db.doubleDeletes).toEqual([]);
    expect(await count(logRetentionRetriesTotal, { result: "recovered" })).toBe(recovered + 3);
  });

  it("fails cleanly after exhausting retries and leaves nothing locked", async () => {
    const failures = await count(logRetentionRunsTotal, { outcome: "failure" });
    const db = seeded({ fail: (kind) => (kind === "delete" ? pgError("40001") : null) });

    await expect(
      runLogRetentionPurge({ pool: db.createPool(), retentionDays: 30, retry: fastRetry }),
    ).rejects.toMatchObject({ code: "40001", retryAttempts: 4 });

    expect(db.heldLocks()).toEqual([]);
    expect(db.stats.openConnections).toBe(0);
    expect(db.remainingIds()).toHaveLength(35);
    expect(await count(logRetentionRunsTotal, { outcome: "failure" })).toBe(failures + 1);
    expect(getLogRetentionHealth()).toMatchObject({
      status: "degraded",
      consecutive_failures: 1,
      in_progress: false,
    });
  });

  it("refuses to purge a table without its timestamp index, without retrying", async () => {
    const db = seeded({ hasIndex: false });

    await expect(
      runLogRetentionPurge({ pool: db.createPool(), retry: fastRetry }),
    ).rejects.toThrow("Missing index");
    expect(db.callCount("index")).toBe(1);
    expect(db.callCount("delete")).toBe(0);
    expect(db.heldLocks()).toEqual([]);
  });

  it("drops the lock with the connection if unlocking fails", async () => {
    const db = seeded({ fail: (kind) => (kind === "unlock" ? pgError("08006") : null) });

    await runLogRetentionPurge({ pool: db.createPool(), retentionDays: 30, retry: fastRetry });

    expect(db.stats.destroyedConnections).toBe(1);
    expect(db.heldLocks()).toEqual([]);
  });

  it("never double-deletes when unlocked direct callers overlap (SKIP LOCKED)", async () => {
    const db = createFakeLogRetentionDb({ rows: makeRows(200, 60), latencyMs: 2 });
    const pools = Array.from({ length: 4 }, () => db.createPool());

    const results = await Promise.all(
      pools.map((pool) =>
        purgeWebhookLogs({ pool, retentionDays: 30, batchSize: 7, retry: fastRetry }),
      ),
    );

    expect(results.reduce((sum, r) => sum + r.totalDeleted, 0)).toBe(200);
    expect(db.doubleDeletes).toEqual([]);
    expect(db.remainingIds()).toEqual([]);
  });
});

describe("Log retention telemetry over HTTP (integration)", () => {
  let app;

  beforeAll(async () => {
    ({ app } = await createApp({ redisClient: mockRedisClient }));
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(() => {
    resetLogRetentionHealth();
    resetLogRetentionLocks();
  });

  it("GET /health/log-retention reports idle before any run", async () => {
    const res = await request(app).get("/health/log-retention");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "idle", runs: 0, in_progress: false });
  });

  it("GET /health/log-retention reflects a successful purge", async () => {
    await runLogRetentionPurge({ pool: seeded().createPool(), retentionDays: 30, retry: fastRetry });

    const res = await request(app).get("/health/log-retention");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "healthy", last_outcome: "success", last_deleted_rows: 25 });
  });

  it("GET /health/log-retention returns 503 after repeated failures", async () => {
    for (let i = 0; i < 3; i += 1) {
      const db = seeded({ hasIndex: false });
      await runLogRetentionPurge({ pool: db.createPool(), retry: fastRetry }).catch(() => {});
    }

    const res = await request(app).get("/health/log-retention");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "unhealthy", reasons: ["consecutive_failures"] });
    // No table contents or error text leak into the health body.
    expect(JSON.stringify(res.body)).not.toMatch(/Missing index|webhook_delivery_logs/);
  });

  it("GET /health lists log_retention without changing the overall status", async () => {
    for (let i = 0; i < 3; i += 1) {
      const db = seeded({ hasIndex: false });
      await runLogRetentionPurge({ pool: db.createPool(), retry: fastRetry }).catch(() => {});
    }

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.services.log_retention).toBe("unhealthy");
  });

  it("GET /metrics exposes the log retention series", async () => {
    await runLogRetentionPurge({ pool: seeded().createPool(), retentionDays: 30, retry: fastRetry });

    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/log_retention_purge_runs_total\{[^}]*outcome="success"[^}]*\} \d+/);
    expect(res.text).toContain("log_retention_purge_deleted_rows_total");
    expect(res.text).toContain("log_retention_purge_lock_total");
    expect(res.text).toMatch(/log_retention_health_state\{[^}]*\} 0/);
  });
});
