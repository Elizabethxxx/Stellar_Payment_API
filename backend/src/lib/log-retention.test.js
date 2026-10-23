import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LogRetentionSafetyError,
  purgeWebhookLogs,
  runLogRetentionPurge,
} from "./log-retention.js";
import {
  getLogRetentionHealth,
  logRetentionBatchesTotal,
  logRetentionRunsTotal,
  resetLogRetentionHealth,
} from "./log-retention-telemetry.js";
import { resetLogRetentionLocks } from "./log-retention-lock.js";

describe("purgeWebhookLogs", () => {
  it("deletes old rows in batches until empty and returns totals", async () => {
    const query = vi
      .fn()
      // validate index
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      // validate no FK references
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      // delete loops
      .mockResolvedValueOnce({ rowCount: 2, rows: [{ id: "1" }, { id: "2" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "3" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const pool = { query };

    const result = await purgeWebhookLogs({
      pool,
      retentionDays: 30,
      batchSize: 2,
      maxDurationMs: 10_000,
    });

    expect(result.totalDeleted).toBe(3);
    expect(result.retentionDays).toBe(30);
    expect(result.batchSize).toBe(2);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("throws when timestamp index is missing", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const pool = { query };

    await expect(
      purgeWebhookLogs({
        pool,
        retentionDays: 30,
        batchSize: 1000,
      }),
    ).rejects.toThrow("Missing index");
  });
});

// ── Issues #1473-#1475 ──────────────────────────────────────────────────────

const noWait = { sleep: async () => {}, baseDelayMs: 0, maxAttempts: 3 };
const safeChecks = (query) =>
  query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
    .mockResolvedValueOnce({ rowCount: 0, rows: [] });
const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code });

async function metricValue(metric, labels) {
  const { values } = await metric.get();
  return (
    values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value ?? 0
  );
}

describe("purgeWebhookLogs retry (#1474)", () => {
  beforeEach(() => resetLogRetentionHealth());

  it("retries a transient delete failure and keeps the deleted total exact", async () => {
    const query = safeChecks(vi.fn())
      .mockResolvedValueOnce({ rowCount: 2, rows: [] })
      .mockRejectedValueOnce(pgError("40P01"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await purgeWebhookLogs({
      pool: { query },
      retentionDays: 30,
      batchSize: 2,
      maxDurationMs: 60_000,
      retry: noWait,
    });

    expect(result.totalDeleted).toBe(3);
    expect(query).toHaveBeenCalledTimes(6);
  });

  it("retries a transient safety-check failure", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(pgError("57P01"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(
      purgeWebhookLogs({ pool: { query }, retentionDays: 30, batchSize: 10, retry: noWait }),
    ).resolves.toMatchObject({ totalDeleted: 0 });
  });

  it("never retries a failed safety check", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });

    const err = await purgeWebhookLogs({
      pool: { query },
      retentionDays: 30,
      batchSize: 10,
      retry: noWait,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(LogRetentionSafetyError);
    expect(err.retryable).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects when foreign keys reference the table, without retrying", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ conname: "fk_x" }] });

    await expect(
      purgeWebhookLogs({ pool: { query }, retentionDays: 30, batchSize: 10, retry: noWait }),
    ).rejects.toThrow(/referenced by foreign keys/);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("fails the run after exhausting retries", async () => {
    const query = safeChecks(vi.fn()).mockRejectedValue(pgError("40001"));

    await expect(
      purgeWebhookLogs({ pool: { query }, retentionDays: 30, batchSize: 10, retry: noWait }),
    ).rejects.toMatchObject({ code: "40001", retryAttempts: 3 });
    expect(query).toHaveBeenCalledTimes(2 + 3);
  });
});

describe("purgeWebhookLogs concurrency-safe delete (#1475)", () => {
  it("skips rows locked by another purge and binds only days and batch size", async () => {
    const query = safeChecks(vi.fn()).mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await purgeWebhookLogs({ pool: { query }, retentionDays: 14, batchSize: 50 });

    const [sql, params] = query.mock.calls[2];
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/DELETE FROM webhook_delivery_logs/);
    expect(params).toEqual([14, 50]);
  });
});

describe("purgeWebhookLogs telemetry (#1473)", () => {
  beforeEach(() => resetLogRetentionHealth());

  it("records a successful run and its batches", async () => {
    const runs = await metricValue(logRetentionRunsTotal, { outcome: "success" });
    const batches = await metricValue(logRetentionBatchesTotal, { table: "webhook_delivery_logs" });
    const query = safeChecks(vi.fn())
      .mockResolvedValueOnce({ rowCount: 4, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await purgeWebhookLogs({ pool: { query }, retentionDays: 30, batchSize: 4 });

    expect(await metricValue(logRetentionRunsTotal, { outcome: "success" })).toBe(runs + 1);
    expect(
      await metricValue(logRetentionBatchesTotal, { table: "webhook_delivery_logs" }),
    ).toBe(batches + 2);
    expect(getLogRetentionHealth()).toMatchObject({
      status: "healthy",
      last_deleted_rows: 4,
      in_progress: false,
    });
  });

  it("records a failed run and marks health degraded", async () => {
    const failures = await metricValue(logRetentionRunsTotal, { outcome: "failure" });
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(
      purgeWebhookLogs({ pool: { query }, retentionDays: 30, batchSize: 10 }),
    ).rejects.toThrow("Missing index");

    expect(await metricValue(logRetentionRunsTotal, { outcome: "failure" })).toBe(failures + 1);
    expect(getLogRetentionHealth()).toMatchObject({
      status: "degraded",
      reasons: ["last_run_failed"],
      in_progress: false,
    });
  });

  it("flags a run that exceeded its time budget", async () => {
    const query = safeChecks(vi.fn()).mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ rowCount: 0, rows: [] }), 20)),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await purgeWebhookLogs({ pool: { query }, retentionDays: 30, batchSize: 10, maxDurationMs: 1 });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[ALERT][log-retention]"));
    expect(getLogRetentionHealth().reasons).toContain("duration_exceeded");
    errorSpy.mockRestore();
  });
});

describe("runLogRetentionPurge (#1475)", () => {
  beforeEach(() => {
    resetLogRetentionHealth();
    resetLogRetentionLocks();
  });

  function lockingPool({ acquired = true } = {}) {
    const client = {
      query: vi.fn(async (sql) =>
        /advisory_unlock/.test(sql)
          ? { rows: [{ released: true }] }
          : { rows: [{ acquired }] },
      ),
      release: vi.fn(),
    };
    const query = safeChecks(vi.fn()).mockResolvedValueOnce({ rowCount: 0, rows: [] });
    return { client, pool: { query, connect: vi.fn(async () => client) } };
  }

  it("purges under the advisory lock and releases it", async () => {
    const { pool, client } = lockingPool();

    const result = await runLogRetentionPurge({ pool, retentionDays: 30, batchSize: 10 });

    expect(result).toMatchObject({ skipped: false, totalDeleted: 0, tableName: "webhook_delivery_logs" });
    expect(client.query.mock.calls.map(([sql]) => sql.match(/pg_\w+/)[0])).toEqual([
      "pg_try_advisory_lock",
      "pg_advisory_unlock",
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("skips without purging when another instance holds the lock", async () => {
    const skipped = await metricValue(logRetentionRunsTotal, { outcome: "skipped" });
    const { pool } = lockingPool({ acquired: false });

    await expect(runLogRetentionPurge({ pool })).resolves.toEqual({
      skipped: true,
      reason: "locked",
      tableName: "webhook_delivery_logs",
    });
    expect(pool.query).not.toHaveBeenCalled();
    expect(await metricValue(logRetentionRunsTotal, { outcome: "skipped" })).toBe(skipped + 1);
    expect(getLogRetentionHealth()).toMatchObject({ status: "idle", skipped_runs: 1 });
  });

  it("releases the lock when the purge fails", async () => {
    const { pool, client } = lockingPool();
    pool.query.mockReset().mockResolvedValue({ rowCount: 0, rows: [] }); // missing index

    await expect(runLogRetentionPurge({ pool })).rejects.toThrow("Missing index");
    expect(client.query).toHaveBeenLastCalledWith(
      expect.stringContaining("pg_advisory_unlock"),
      expect.any(Array),
    );
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("requires a pool", async () => {
    await expect(runLogRetentionPurge({})).rejects.toThrow(/pg pool/);
  });
});
