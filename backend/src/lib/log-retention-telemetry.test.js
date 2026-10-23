import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  HEALTH_STATE_VALUES,
  LogRetentionHealthMonitor,
  getLogRetentionHealth,
  logRetentionBatchesTotal,
  logRetentionDeletedRowsTotal,
  logRetentionDurationExceededTotal,
  logRetentionHealthState,
  logRetentionLockTotal,
  logRetentionRegister,
  logRetentionRetriesTotal,
  logRetentionRunsTotal,
  pushLogRetentionMetrics,
  recordLogRetentionBatch,
  recordLogRetentionLock,
  recordLogRetentionRetry,
  recordLogRetentionRunFinish,
  recordLogRetentionRunStart,
  resetLogRetentionHealth,
  resolveHealthOptions,
} from "./log-retention-telemetry.js";

async function value(metric, labels = {}) {
  const { values } = await metric.get();
  const match = values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
}

const HOUR = 60 * 60 * 1000;

function monitorAt(start = 1_700_000_000_000, options = {}) {
  let t = start;
  const monitor = new LogRetentionHealthMonitor(
    { maxConsecutiveFailures: 3, maxStalenessMs: 50 * HOUR, stuckAfterMs: 15 * 60 * 1000, ...options },
    () => t,
  );
  return { monitor, advance: (ms) => (t += ms) };
}

function finish(monitor, outcome, extra = {}) {
  monitor.recordStart();
  monitor.recordFinish({ outcome, durationMs: 100, deletedRows: 5, ...extra });
}

describe("LogRetentionHealthMonitor (#1473)", () => {
  it("is idle before any run", () => {
    const { monitor } = monitorAt();
    expect(monitor.snapshot()).toMatchObject({
      status: "idle",
      reasons: [],
      runs: 0,
      in_progress: false,
      last_run_at: null,
      last_success_at: null,
    });
  });

  it("is healthy after a successful run and reports its numbers", () => {
    const { monitor } = monitorAt();
    finish(monitor, "success", { deletedRows: 12, durationMs: 250 });
    const snap = monitor.snapshot();
    expect(snap).toMatchObject({
      status: "healthy",
      runs: 1,
      last_outcome: "success",
      last_deleted_rows: 12,
      last_duration_ms: 250,
      consecutive_failures: 0,
    });
    expect(snap.last_success_at).toBe(snap.last_run_at);
  });

  it("is degraded after a single failure and unhealthy at the streak limit", () => {
    const { monitor } = monitorAt();
    finish(monitor, "failure");
    expect(monitor.snapshot()).toMatchObject({ status: "degraded", reasons: ["last_run_failed"] });
    finish(monitor, "failure");
    finish(monitor, "failure");
    expect(monitor.snapshot()).toMatchObject({
      status: "unhealthy",
      reasons: ["consecutive_failures"],
      consecutive_failures: 3,
    });
  });

  it("resets the failure streak on success", () => {
    const { monitor } = monitorAt();
    finish(monitor, "failure");
    finish(monitor, "failure");
    finish(monitor, "success");
    expect(monitor.snapshot()).toMatchObject({ status: "healthy", consecutive_failures: 0 });
  });

  it("is unhealthy when the last success is older than the staleness limit", () => {
    const { monitor, advance } = monitorAt();
    finish(monitor, "success");
    advance(51 * HOUR);
    expect(monitor.snapshot()).toMatchObject({
      status: "unhealthy",
      reasons: ["last_success_stale"],
    });
  });

  it("is degraded when a run overran its time budget", () => {
    const { monitor } = monitorAt();
    finish(monitor, "success", { durationExceeded: true });
    expect(monitor.snapshot()).toMatchObject({
      status: "degraded",
      reasons: ["duration_exceeded"],
    });
  });

  it("reports an in-progress run and degrades when it is overdue", () => {
    const { monitor, advance } = monitorAt();
    monitor.recordStart();
    expect(monitor.snapshot()).toMatchObject({ status: "healthy", in_progress: true, running_for_ms: 0 });
    advance(16 * 60 * 1000);
    expect(monitor.snapshot()).toMatchObject({ status: "degraded", reasons: ["run_overdue"] });
    monitor.recordFinish({ outcome: "success" });
    expect(monitor.snapshot()).toMatchObject({ in_progress: false, running_for_ms: null });
  });

  it("does not let a skipped run touch the streak or the in-progress count", () => {
    const { monitor } = monitorAt();
    finish(monitor, "failure");
    monitor.recordStart();
    monitor.recordFinish({ outcome: "skipped" });
    const snap = monitor.snapshot();
    expect(snap).toMatchObject({
      skipped_runs: 1,
      runs: 1,
      consecutive_failures: 1,
      in_progress: true,
    });
  });

  it("keeps unhealthy above degraded when several reasons apply", () => {
    const { monitor } = monitorAt();
    finish(monitor, "failure", { durationExceeded: true });
    finish(monitor, "failure", { durationExceeded: true });
    finish(monitor, "failure", { durationExceeded: true });
    const snap = monitor.snapshot();
    expect(snap.status).toBe("unhealthy");
    expect(snap.reasons).toEqual(["consecutive_failures", "duration_exceeded"]);
  });

  it("exposes no table contents, ids or error messages", () => {
    const { monitor } = monitorAt();
    finish(monitor, "failure");
    expect(Object.keys(monitor.snapshot()).sort()).toEqual(
      [
        "consecutive_failures",
        "in_progress",
        "last_deleted_rows",
        "last_duration_ms",
        "last_outcome",
        "last_run_at",
        "last_success_at",
        "reasons",
        "running_for_ms",
        "runs",
        "skipped_runs",
        "status",
        "thresholds",
      ].sort(),
    );
  });
});

describe("resolveHealthOptions", () => {
  it("reads env and falls back on bad values", () => {
    expect(
      resolveHealthOptions(
        {},
        {
          LOG_RETENTION_HEALTH_MAX_CONSECUTIVE_FAILURES: "5",
          LOG_RETENTION_HEALTH_MAX_STALENESS_MS: "1000",
          LOG_RETENTION_HEALTH_STUCK_AFTER_MS: "nope",
        },
      ),
    ).toEqual({ maxConsecutiveFailures: 5, maxStalenessMs: 1000, stuckAfterMs: 15 * 60 * 1000 });
  });

  it("never allows a streak limit below 1", () => {
    expect(resolveHealthOptions({ maxConsecutiveFailures: 0 }, {}).maxConsecutiveFailures).toBe(1);
  });
});

describe("record* helpers", () => {
  beforeEach(() => resetLogRetentionHealth());

  it("counts runs by outcome and feeds the shared health monitor", async () => {
    const success = await value(logRetentionRunsTotal, { outcome: "success" });
    const exceeded = await value(logRetentionDurationExceededTotal);

    recordLogRetentionRunStart();
    recordLogRetentionRunFinish({ outcome: "success", durationMs: 1200, deletedRows: 7, durationExceeded: true });

    expect(await value(logRetentionRunsTotal, { outcome: "success" })).toBe(success + 1);
    expect(await value(logRetentionDurationExceededTotal)).toBe(exceeded + 1);
    expect(getLogRetentionHealth()).toMatchObject({ status: "degraded", last_deleted_rows: 7 });
  });

  it("maps an unknown outcome to failure and ignores bad numbers", async () => {
    const failure = await value(logRetentionRunsTotal, { outcome: "failure" });
    recordLogRetentionRunStart();
    recordLogRetentionRunFinish({ outcome: "bogus", durationMs: -5, deletedRows: Number.NaN });
    expect(await value(logRetentionRunsTotal, { outcome: "failure" })).toBe(failure + 1);
    expect(getLogRetentionHealth()).toMatchObject({ last_outcome: "failure", last_duration_ms: 0 });
  });

  it("counts skipped runs without a duration sample", async () => {
    const skipped = await value(logRetentionRunsTotal, { outcome: "skipped" });
    recordLogRetentionRunFinish({ outcome: "skipped" });
    expect(await value(logRetentionRunsTotal, { outcome: "skipped" })).toBe(skipped + 1);
    expect(getLogRetentionHealth()).toMatchObject({ status: "idle", skipped_runs: 1 });
  });

  it("records batches and deleted rows per known table only", async () => {
    const batches = await value(logRetentionBatchesTotal, { table: "webhook_delivery_logs" });
    const rows = await value(logRetentionDeletedRowsTotal, { table: "webhook_delivery_logs" });
    recordLogRetentionBatch("webhook_delivery_logs", 25);
    recordLogRetentionBatch("webhook_delivery_logs", 0);
    recordLogRetentionBatch("users; drop table x", 3);

    expect(await value(logRetentionBatchesTotal, { table: "webhook_delivery_logs" })).toBe(batches + 2);
    expect(await value(logRetentionDeletedRowsTotal, { table: "webhook_delivery_logs" })).toBe(rows + 25);
    expect(await value(logRetentionBatchesTotal, { table: "other" })).toBeGreaterThanOrEqual(1);
    const { values } = await logRetentionBatchesTotal.get();
    expect(values.every((v) => ["webhook_delivery_logs", "other"].includes(v.labels.table))).toBe(true);
  });

  it("sanitises retry and lock results to fixed label sets", async () => {
    recordLogRetentionRetry("scheduled");
    recordLogRetentionRetry("<script>");
    recordLogRetentionLock("acquired");
    recordLogRetentionLock("anything");

    const retries = (await logRetentionRetriesTotal.get()).values.map((v) => v.labels.result);
    const locks = (await logRetentionLockTotal.get()).values.map((v) => v.labels.result);
    expect(retries.every((r) => ["scheduled", "recovered", "exhausted"].includes(r))).toBe(true);
    expect(locks.every((r) => ["acquired", "contended", "error"].includes(r))).toBe(true);
  });

  it("refreshes the health gauges at scrape time", async () => {
    recordLogRetentionRunStart();
    recordLogRetentionRunFinish({ outcome: "failure" });
    recordLogRetentionRunStart();
    recordLogRetentionRunFinish({ outcome: "failure" });
    recordLogRetentionRunStart();
    recordLogRetentionRunFinish({ outcome: "failure" });

    const text = await logRetentionRegister.metrics();
    expect(text).toMatch(/log_retention_health_state\{[^}]*\} 2/);
    expect(text).toMatch(/log_retention_purge_consecutive_failures\{[^}]*\} 3/);
    expect(await value(logRetentionHealthState)).toBe(HEALTH_STATE_VALUES.unhealthy);
  });

  it("registers every series on the module registry", async () => {
    const text = await logRetentionRegister.metrics();
    for (const name of [
      "log_retention_purge_runs_total",
      "log_retention_purge_duration_seconds",
      "log_retention_purge_deleted_rows_total",
      "log_retention_purge_batches_total",
      "log_retention_purge_duration_exceeded_total",
      "log_retention_purge_retries_total",
      "log_retention_purge_lock_total",
      "log_retention_health_state",
      "log_retention_purge_in_progress",
      "log_retention_purge_consecutive_failures",
      "log_retention_purge_last_success_timestamp_seconds",
      "log_retention_purge_last_run_timestamp_seconds",
    ]) {
      expect(text).toContain(`# TYPE ${name}`);
    }
  });
});

describe("pushLogRetentionMetrics", () => {
  function fakeGateway({ fail = false } = {}) {
    const instances = [];
    class FakeGateway {
      constructor(url, opts, registry) {
        this.url = url;
        this.registry = registry;
        this.pushAdd = vi.fn(async () => {
          if (fail) throw new Error("gateway down");
          return {};
        });
        instances.push(this);
      }
    }
    return { FakeGateway, instances };
  }

  it("pushes this registry under the job name", async () => {
    const { FakeGateway, instances } = fakeGateway();
    await expect(
      pushLogRetentionMetrics("http://pushgateway:9091", { Pushgateway: FakeGateway }),
    ).resolves.toBe(true);
    expect(instances[0].registry).toBe(logRetentionRegister);
    expect(instances[0].pushAdd).toHaveBeenCalledWith({ jobName: "log_retention_purge" });
  });

  it.each(["not a url", "file:///etc/passwd", "ftp://host/x"])("refuses %s", async (url) => {
    const { FakeGateway, instances } = fakeGateway();
    await expect(pushLogRetentionMetrics(url, { Pushgateway: FakeGateway })).resolves.toBe(false);
    expect(instances).toHaveLength(0);
  });

  it("swallows push failures", async () => {
    const { FakeGateway } = fakeGateway({ fail: true });
    await expect(
      pushLogRetentionMetrics("https://user:secret@gw.example:9091", { Pushgateway: FakeGateway }),
    ).resolves.toBe(false);
  });
});
