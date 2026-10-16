import { logger } from "./logger.js";
import {
  recordLogRetentionBatch,
  recordLogRetentionRunFinish,
  recordLogRetentionRunStart,
} from "./log-retention-telemetry.js";
import { withLogRetentionRetry } from "./log-retention-retry.js";
import {
  buildLogRetentionLockKey,
  withLogRetentionLock,
} from "./log-retention-lock.js";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000;

const WEBHOOK_LOGS_TABLE = "webhook_delivery_logs";
const WEBHOOK_LOGS_TIMESTAMP_COLUMN = "timestamp";

function parsePositiveInteger(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer value but got: ${value}`);
  }
  return parsed;
}

/**
 * Thrown when a pre-purge safety check fails. Never retried (issue #1474):
 * a purge that is unsafe to run must not be forced through by repetition.
 */
class LogRetentionSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "LogRetentionSafetyError";
    this.retryable = false;
  }
}

async function validatePurgeSafety({ pool, tableName, timestampColumn, retry = {} }) {
  const indexQuery = `
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = $1
      AND indexdef ILIKE '%' || $2 || '%'
    LIMIT 1
  `;
  const indexResult = await withLogRetentionRetry(
    () => pool.query(indexQuery, [tableName, timestampColumn]),
    { ...retry, label: "log-retention-index-check" },
  );
  if (indexResult.rowCount === 0) {
    throw new LogRetentionSafetyError(
      `Missing index for ${tableName}.${timestampColumn}; aborting purge to avoid sequential scans.`,
    );
  }

  const fkQuery = `
    SELECT conname
    FROM pg_constraint
    WHERE confrelid = to_regclass($1)
      AND contype = 'f'
    LIMIT 1
  `;
  const fkResult = await withLogRetentionRetry(
    () => pool.query(fkQuery, [tableName]),
    { ...retry, label: "log-retention-fk-check" },
  );
  if (fkResult.rowCount > 0) {
    throw new LogRetentionSafetyError(
      `Table ${tableName} is referenced by foreign keys (example: ${fkResult.rows[0].conname}); aborting purge.`,
    );
  }
}

async function purgeWebhookLogs({
  pool,
  retentionDays = parsePositiveInteger(
    process.env.LOG_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
  ),
  batchSize = parsePositiveInteger(
    process.env.LOG_PURGE_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
  ),
  maxDurationMs = parsePositiveInteger(
    process.env.LOG_PURGE_MAX_DURATION_MS,
    DEFAULT_MAX_DURATION_MS,
  ),
  // Retry tuning and test seams (issue #1474): maxAttempts, baseDelayMs,
  // maxDelayMs, sleep, random. Defaults come from LOG_PURGE_RETRY_* env vars.
  retry = {},
} = {}) {
  if (!pool) {
    throw new Error("A pg pool/client is required for purgeWebhookLogs.");
  }

  const startedAt = Date.now();
  const tableName = WEBHOOK_LOGS_TABLE;
  const timestampColumn = WEBHOOK_LOGS_TIMESTAMP_COLUMN;
  // Stop retrying once the run is past its time budget: a purge that keeps
  // failing should surface as a failed run, not hold the primary for hours.
  const retryOptions = {
    ...retry,
    shouldAbort: () => Date.now() - startedAt > maxDurationMs,
  };

  recordLogRetentionRunStart();
  let totalDeleted = 0;
  let batches = 0;
  try {
    await validatePurgeSafety({ pool, tableName, timestampColumn, retry: retryOptions });

    // Compliance warning: payment audit records may require longer retention by policy/regulation.
    // Confirm this table contains operational delivery telemetry only before enforcing 30-day retention.
    let deletedInBatch = 0;

    do {
      // SKIP LOCKED (issue #1475): rows another purge (or any writer) is
      // holding are left for a later batch instead of blocking on them, so
      // concurrent callers never wait on each other or delete a row twice.
      const deleteQuery = `
        WITH rows_to_delete AS (
          SELECT id
          FROM ${tableName}
          WHERE ${timestampColumn} < NOW() - make_interval(days => $1::int)
          ORDER BY ${timestampColumn} ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM ${tableName} t
        USING rows_to_delete d
        WHERE t.id = d.id
        RETURNING t.id
      `;

      // Each batch is idempotent ("delete old rows"), so retrying it after a
      // transient failure cannot delete anything that should be kept.
      const deleteResult = await withLogRetentionRetry(
        () => pool.query(deleteQuery, [retentionDays, batchSize]),
        { ...retryOptions, label: "log-retention-delete-batch" },
      );
      deletedInBatch = deleteResult.rowCount ?? 0;
      totalDeleted += deletedInBatch;
      batches += 1;
      recordLogRetentionBatch(tableName, deletedInBatch);
    } while (deletedInBatch > 0);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    recordLogRetentionRunFinish({
      outcome: "failure",
      durationMs,
      deletedRows: totalDeleted,
      durationExceeded: durationMs > maxDurationMs,
    });
    logger.error(
      {
        table: tableName,
        deletedRows: totalDeleted,
        batches,
        durationMs,
        attempts: err?.retryAttempts,
        code: err?.code,
        err: err?.message,
      },
      "Log retention purge failed",
    );
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  const durationSec = (durationMs / 1000).toFixed(2);
  const durationExceeded = durationMs > maxDurationMs;
  console.log(
    `[log-retention] Purge complete for ${tableName}: deleted_rows=${totalDeleted} duration_ms=${durationMs} duration_sec=${durationSec}`,
  );

  if (durationExceeded) {
    console.error(
      `[ALERT][log-retention] Purge exceeded max duration (${maxDurationMs}ms): actual=${durationMs}ms`,
    );
  }

  recordLogRetentionRunFinish({
    outcome: "success",
    durationMs,
    deletedRows: totalDeleted,
    durationExceeded,
  });

  return {
    tableName,
    retentionDays,
    batchSize,
    totalDeleted,
    durationMs,
  };
}

/**
 * Purge webhook delivery logs while holding the cross-instance purge lock
 * (issue #1475). Use this from schedulers and scripts; it is safe to call
 * from every instance at once: exactly one runs, the others are skipped.
 *
 * Accepts the same options as purgeWebhookLogs.
 *
 * @returns {Promise<
 *   | { skipped: true, reason: "locked", tableName: string }
 *   | (Awaited<ReturnType<typeof purgeWebhookLogs>> & { skipped: false })
 * >}
 */
async function runLogRetentionPurge(options = {}) {
  const { pool, retry = {} } = options;
  if (!pool) {
    throw new Error("A pg pool/client is required for runLogRetentionPurge.");
  }

  const tableName = WEBHOOK_LOGS_TABLE;
  const key = buildLogRetentionLockKey(tableName);
  const outcome = await withLogRetentionLock(
    pool,
    key,
    () => purgeWebhookLogs(options),
    retry,
  );

  if (outcome.skipped) {
    recordLogRetentionRunFinish({ outcome: "skipped" });
    logger.info(
      { table: tableName },
      "Log retention purge skipped: another run holds the lock",
    );
    return { skipped: true, reason: "locked", tableName };
  }

  return { ...outcome.result, skipped: false };
}

export {
  purgeWebhookLogs,
  runLogRetentionPurge,
  LogRetentionSafetyError,
  parsePositiveInteger,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_DURATION_MS,
};
