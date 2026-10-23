/**
 * Log Retention & Archival Service telemetry (issue #1473).
 *
 * Prometheus alert metrics and a health snapshot for the webhook delivery
 * log purge (log-retention.js). Every label value comes from a fixed
 * server-side set, never from table contents, row ids or error messages, so
 * the purge cannot inflate series cardinality or leak log data into metrics.
 *
 * The metrics live in their own registry so they can be tested in isolation
 * and pushed from the standalone purge script. /metrics merges this registry
 * with the others.
 *
 * Health is derived from the run history kept in this process:
 *   unhealthy  - N consecutive failed runs, or the last success is older than
 *                the staleness limit
 *   degraded   - the last run failed, overran its time budget, or a run has
 *                been in progress for longer than the stuck limit
 *   healthy    - otherwise
 *   idle       - no run recorded in this process yet (not an error)
 */

import client from 'prom-client';
import { logger } from './logger.js';

const register = new client.Registry();

register.setDefaultLabels({
  app: 'stellar-payment-api',
});

/** outcome: success | failure | skipped */
export const logRetentionRunsTotal = new client.Counter({
  name: 'log_retention_purge_runs_total',
  help: 'Log retention purge runs, by outcome (skipped = another instance held the lock)',
  labelNames: ['outcome'],
});

export const logRetentionRunDuration = new client.Histogram({
  name: 'log_retention_purge_duration_seconds',
  help: 'Wall time of a log retention purge run, by outcome',
  labelNames: ['outcome'],
  buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1200],
});

export const logRetentionDeletedRowsTotal = new client.Counter({
  name: 'log_retention_purge_deleted_rows_total',
  help: 'Rows deleted by the log retention purge',
  labelNames: ['table'],
});

export const logRetentionBatchesTotal = new client.Counter({
  name: 'log_retention_purge_batches_total',
  help: 'Delete batches executed by the log retention purge',
  labelNames: ['table'],
});

/** Alert counter: a run took longer than LOG_PURGE_MAX_DURATION_MS. */
export const logRetentionDurationExceededTotal = new client.Counter({
  name: 'log_retention_purge_duration_exceeded_total',
  help: 'Log retention purge runs that exceeded their max duration budget',
});

/** result: scheduled | recovered | exhausted (issue #1474) */
export const logRetentionRetriesTotal = new client.Counter({
  name: 'log_retention_purge_retries_total',
  help: 'Log retention purge query retries with exponential backoff, by result',
  labelNames: ['result'],
});

/** result: acquired | contended | error (issue #1475) */
export const logRetentionLockTotal = new client.Counter({
  name: 'log_retention_purge_lock_total',
  help: 'Log retention purge distributed lock attempts, by result',
  labelNames: ['result'],
});

/** 0 = healthy or idle, 1 = degraded, 2 = unhealthy. Refreshed at scrape time. */
export const logRetentionHealthState = new client.Gauge({
  name: 'log_retention_health_state',
  help: 'Log retention purge health (0 = healthy/idle, 1 = degraded, 2 = unhealthy)',
});

export const logRetentionInProgress = new client.Gauge({
  name: 'log_retention_purge_in_progress',
  help: 'Whether a log retention purge is running in this process (1) or not (0)',
});

export const logRetentionConsecutiveFailures = new client.Gauge({
  name: 'log_retention_purge_consecutive_failures',
  help: 'Consecutive failed log retention purge runs in this process',
});

export const logRetentionLastSuccessTimestamp = new client.Gauge({
  name: 'log_retention_purge_last_success_timestamp_seconds',
  help: 'Unix time of the last successful log retention purge',
});

export const logRetentionLastRunTimestamp = new client.Gauge({
  name: 'log_retention_purge_last_run_timestamp_seconds',
  help: 'Unix time of the last finished log retention purge run (any outcome)',
});

const RUN_OUTCOMES = new Set(['success', 'failure', 'skipped']);
const RETRY_RESULTS = new Set(['scheduled', 'recovered', 'exhausted']);
const LOCK_RESULTS = new Set(['acquired', 'contended', 'error']);
/** Only tables this service purges may appear as a label value. */
const KNOWN_TABLES = new Set(['webhook_delivery_logs']);

export const HEALTH_STATE_VALUES = Object.freeze({
  idle: 0,
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
});

function readNumberEnv(name, fallback, env = process.env) {
  const raw = Number.parseFloat(env[name] ?? '');
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function resolveHealthOptions(options = {}, env = process.env) {
  return {
    maxConsecutiveFailures: Math.max(
      1,
      Math.trunc(
        options.maxConsecutiveFailures ??
          readNumberEnv('LOG_RETENTION_HEALTH_MAX_CONSECUTIVE_FAILURES', 3, env),
      ),
    ),
    // A daily job: allow one missed run plus slack before alerting.
    maxStalenessMs:
      options.maxStalenessMs ??
      readNumberEnv('LOG_RETENTION_HEALTH_MAX_STALENESS_MS', 50 * 60 * 60 * 1000, env),
    stuckAfterMs:
      options.stuckAfterMs ??
      readNumberEnv('LOG_RETENTION_HEALTH_STUCK_AFTER_MS', 15 * 60 * 1000, env),
  };
}

/**
 * Run-history health tracker. Constant memory: only the latest run state and
 * a failure streak are kept.
 */
export class LogRetentionHealthMonitor {
  constructor(options = {}, now = () => Date.now()) {
    this.options = resolveHealthOptions(options);
    this.now = now;
    this.reset();
  }

  reset() {
    this.runs = 0;
    this.inProgress = 0;
    this.runningSince = null;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastOutcome = null;
    this.lastDurationMs = null;
    this.lastDeletedRows = null;
    this.lastDurationExceeded = false;
    this.consecutiveFailures = 0;
    this.skipped = 0;
  }

  recordStart() {
    this.inProgress += 1;
    if (this.runningSince === null) this.runningSince = this.now();
  }

  /**
   * @param {{outcome:'success'|'failure'|'skipped', durationMs?:number, deletedRows?:number, durationExceeded?:boolean}} run
   */
  recordFinish({ outcome, durationMs = 0, deletedRows = 0, durationExceeded = false }) {
    // A skipped run (the lock is held elsewhere) never started here: it must
    // not touch the in-progress count, nor reset or extend the failure streak.
    if (outcome === 'skipped') {
      this.skipped += 1;
      return;
    }

    if (this.inProgress > 0) this.inProgress -= 1;
    if (this.inProgress === 0) this.runningSince = null;

    const time = this.now();
    this.runs += 1;
    this.lastRunAt = time;
    this.lastOutcome = outcome;
    this.lastDurationMs = durationMs;
    this.lastDurationExceeded = Boolean(durationExceeded);
    if (outcome === 'success') {
      this.lastSuccessAt = time;
      this.lastDeletedRows = deletedRows;
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
    }
  }

  snapshot() {
    const time = this.now();
    const { maxConsecutiveFailures, maxStalenessMs, stuckAfterMs } = this.options;
    const reasons = [];
    let status = this.runs === 0 && this.inProgress === 0 ? 'idle' : 'healthy';

    const escalate = (next, reason) => {
      reasons.push(reason);
      if (next === 'unhealthy' || status === 'idle' || status === 'healthy') status = next;
    };

    if (this.consecutiveFailures >= maxConsecutiveFailures) {
      escalate('unhealthy', 'consecutive_failures');
    }
    if (this.lastSuccessAt !== null && time - this.lastSuccessAt > maxStalenessMs) {
      escalate('unhealthy', 'last_success_stale');
    }
    if (this.lastOutcome === 'failure' && this.consecutiveFailures < maxConsecutiveFailures) {
      escalate('degraded', 'last_run_failed');
    }
    if (this.lastDurationExceeded) {
      escalate('degraded', 'duration_exceeded');
    }
    const runningForMs = this.runningSince === null ? null : time - this.runningSince;
    if (runningForMs !== null && runningForMs > stuckAfterMs) {
      escalate('degraded', 'run_overdue');
    }

    const iso = (t) => (t === null ? null : new Date(t).toISOString());
    return {
      status,
      reasons,
      runs: this.runs,
      skipped_runs: this.skipped,
      in_progress: this.inProgress > 0,
      running_for_ms: runningForMs,
      consecutive_failures: this.consecutiveFailures,
      last_outcome: this.lastOutcome,
      last_run_at: iso(this.lastRunAt),
      last_success_at: iso(this.lastSuccessAt),
      last_duration_ms: this.lastDurationMs,
      last_deleted_rows: this.lastDeletedRows,
      thresholds: {
        max_consecutive_failures: maxConsecutiveFailures,
        max_staleness_ms: maxStalenessMs,
        stuck_after_ms: stuckAfterMs,
      },
    };
  }
}

const healthMonitor = new LogRetentionHealthMonitor();

logRetentionHealthState.collect = function collectLogRetentionHealth() {
  const snap = healthMonitor.snapshot();
  this.set(HEALTH_STATE_VALUES[snap.status] ?? 0);
  logRetentionInProgress.set(snap.in_progress ? 1 : 0);
  logRetentionConsecutiveFailures.set(snap.consecutive_failures);
  if (healthMonitor.lastSuccessAt !== null) {
    logRetentionLastSuccessTimestamp.set(healthMonitor.lastSuccessAt / 1000);
  }
  if (healthMonitor.lastRunAt !== null) {
    logRetentionLastRunTimestamp.set(healthMonitor.lastRunAt / 1000);
  }
};

/** Current purge health, for /health endpoints. No log contents or ids. */
export function getLogRetentionHealth() {
  return healthMonitor.snapshot();
}

/** Test-only: clear run history. Counters are left intact. */
export function resetLogRetentionHealth() {
  healthMonitor.reset();
}

function safeRecord(fn) {
  try {
    fn();
  } catch (err) {
    logger.error({ err: err?.message }, 'Failed to record log retention telemetry');
  }
}

const safeTable = (table) => (KNOWN_TABLES.has(table) ? table : 'other');

export function recordLogRetentionRunStart() {
  safeRecord(() => healthMonitor.recordStart());
}

/**
 * @param {object} run
 * @param {'success'|'failure'|'skipped'} run.outcome
 * @param {number} [run.durationMs]
 * @param {number} [run.deletedRows]
 * @param {boolean} [run.durationExceeded]
 */
export function recordLogRetentionRunFinish(run) {
  const outcome = RUN_OUTCOMES.has(run?.outcome) ? run.outcome : 'failure';
  const durationMs =
    Number.isFinite(run?.durationMs) && run.durationMs > 0 ? run.durationMs : 0;
  const deletedRows =
    Number.isFinite(run?.deletedRows) && run.deletedRows > 0 ? Math.trunc(run.deletedRows) : 0;
  const durationExceeded = Boolean(run?.durationExceeded);
  safeRecord(() => {
    logRetentionRunsTotal.inc({ outcome });
    if (outcome !== 'skipped') {
      logRetentionRunDuration.observe({ outcome }, durationMs / 1000);
    }
    if (durationExceeded) logRetentionDurationExceededTotal.inc();
    healthMonitor.recordFinish({ outcome, durationMs, deletedRows, durationExceeded });
  });
}

/** @param {string} table @param {number} deletedRows */
export function recordLogRetentionBatch(table, deletedRows) {
  const label = { table: safeTable(table) };
  const rows = Number.isFinite(deletedRows) && deletedRows > 0 ? Math.trunc(deletedRows) : 0;
  safeRecord(() => {
    logRetentionBatchesTotal.inc(label);
    if (rows > 0) logRetentionDeletedRowsTotal.inc(label, rows);
  });
}

/** @param {'scheduled'|'recovered'|'exhausted'} result */
export function recordLogRetentionRetry(result) {
  const safe = RETRY_RESULTS.has(result) ? result : 'exhausted';
  safeRecord(() => logRetentionRetriesTotal.inc({ result: safe }));
}

/** @param {'acquired'|'contended'|'error'} result */
export function recordLogRetentionLock(result) {
  const safe = LOCK_RESULTS.has(result) ? result : 'error';
  safeRecord(() => logRetentionLockTotal.inc({ result: safe }));
}

/**
 * Push this registry to a Prometheus Pushgateway. Used by the standalone
 * purge script, which exits before any scrape could reach it.
 *
 * Only http(s) URLs are accepted. Failures are logged and swallowed: losing
 * a metrics push must never fail the purge.
 *
 * @param {string} url
 * @param {{jobName?:string, Pushgateway?:typeof client.Pushgateway}} [options]
 * @returns {Promise<boolean>} whether the push succeeded
 */
export async function pushLogRetentionMetrics(url, options = {}) {
  const { jobName = 'log_retention_purge', Pushgateway = client.Pushgateway } = options;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    logger.warn('Log retention: invalid Pushgateway URL, metrics not pushed');
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    logger.warn({ protocol: parsed.protocol }, 'Log retention: Pushgateway URL must be http(s)');
    return false;
  }
  try {
    // Make sure the scrape-time gauges carry the final state.
    logRetentionHealthState.collect();
    const gateway = new Pushgateway(parsed.toString(), {}, register);
    await gateway.pushAdd({ jobName });
    return true;
  } catch (err) {
    // Never log the URL itself: it may embed basic-auth credentials.
    logger.warn({ err: err?.message }, 'Log retention: Pushgateway push failed');
    return false;
  }
}

register.registerMetric(logRetentionRunsTotal);
register.registerMetric(logRetentionRunDuration);
register.registerMetric(logRetentionDeletedRowsTotal);
register.registerMetric(logRetentionBatchesTotal);
register.registerMetric(logRetentionDurationExceededTotal);
register.registerMetric(logRetentionRetriesTotal);
register.registerMetric(logRetentionLockTotal);
register.registerMetric(logRetentionHealthState);
register.registerMetric(logRetentionInProgress);
register.registerMetric(logRetentionConsecutiveFailures);
register.registerMetric(logRetentionLastSuccessTimestamp);
register.registerMetric(logRetentionLastRunTimestamp);

export { register as logRetentionRegister };
