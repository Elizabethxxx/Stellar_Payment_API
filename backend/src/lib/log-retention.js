/**
 * Log Retention & Archival Service.
 *
 * Purges operational webhook delivery logs older than the retention window,
 * in bounded batches.
 *
 * Strict validation and sanitization (issue #1472):
 *   - Every numeric setting (argument or environment variable) must be a
 *     plain positive integer within a safe range. "30days", "1e3", "-5",
 *     "0x10" and fractions are rejected instead of being silently coerced.
 *   - Unknown option keys are rejected, so a typo cannot silently fall back
 *     to the default retention.
 *   - SQL identifiers are checked against an allow-list before they are
 *     interpolated; values always go through bind parameters.
 *   - The driver's row counts are validated, and a hard batch cap stops a
 *     misbehaving driver from looping forever.
 *   - Log lines and returned errors are scrubbed of connection strings and
 *     credentials before they are written.
 */

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BATCHES = 100_000;

/** Inclusive bounds for each setting. */
const LIMITS = Object.freeze({
  retentionDays: { min: 1, max: 3650, env: "LOG_RETENTION_DAYS" },
  batchSize: { min: 1, max: 50_000, env: "LOG_PURGE_BATCH_SIZE" },
  maxDurationMs: { min: 1000, max: 24 * 60 * 60 * 1000, env: "LOG_PURGE_MAX_DURATION_MS" },
  maxBatches: { min: 1, max: 10_000_000, env: "LOG_PURGE_MAX_BATCHES" },
});

const ALLOWED_OPTIONS = new Set(["pool", "retentionDays", "batchSize", "maxDurationMs", "maxBatches", "logger"]);

const WEBHOOK_LOGS_TABLE = "webhook_delivery_logs";
const WEBHOOK_LOGS_TIMESTAMP_COLUMN = "timestamp";

/** Tables and columns this service is allowed to purge. */
const PURGEABLE_TARGETS = Object.freeze({
  [WEBHOOK_LOGS_TABLE]: new Set([WEBHOOK_LOGS_TIMESTAMP_COLUMN]),
});

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const STRICT_INTEGER_PATTERN = /^\d{1,15}$/;

export class LogRetentionValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "LogRetentionValidationError";
    this.field = field;
  }
}

/**
 * Parse a strictly positive integer setting.
 *
 * Backwards compatible with the old `(value, fallback)` form: an empty value
 * returns the fallback. Anything else must be a plain base-10 integer (or a
 * safe integer number) within `[min, max]`.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ name?: string, min?: number, max?: number }} [opts]
 * @returns {number}
 * @throws {LogRetentionValidationError}
 */
function parsePositiveInteger(value, fallback, { name = "value", min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === "") return fallback;

  let parsed;
  if (typeof value === "number") {
    parsed = Number.isSafeInteger(value) ? value : NaN;
  } else if (typeof value === "string" && STRICT_INTEGER_PATTERN.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    parsed = NaN;
  }

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new LogRetentionValidationError(
      `Expected positive integer value for ${name} but got: ${describeValue(value)}`,
      name,
    );
  }
  if (parsed < min || parsed > max) {
    throw new LogRetentionValidationError(
      `${name} must be between ${min} and ${max}, got ${parsed}`,
      name,
    );
  }
  return parsed;
}

/** Short, safe description of a rejected value for error messages. */
function describeValue(value) {
  if (typeof value === "string") {
    const printable = value.replace(/[^\x20-\x7e]/g, "?");
    return JSON.stringify(printable.length > 32 ? `${printable.slice(0, 32)}...` : printable);
  }
  if (typeof value === "number") return String(value);
  return `<${value === null ? "null" : typeof value}>`;
}

/**
 * Resolve one setting from an explicit option or its environment variable.
 * @param {keyof typeof LIMITS} key
 */
function resolveSetting(key, explicit, fallback, env = process.env) {
  const limit = LIMITS[key];
  const source = explicit !== undefined ? explicit : env[limit.env];
  const name = explicit !== undefined ? key : limit.env;
  return parsePositiveInteger(source, fallback, { name, min: limit.min, max: limit.max });
}

/**
 * Validate and normalise purge options.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ pool: { query: Function }, retentionDays: number, batchSize: number, maxDurationMs: number, maxBatches: number, logger: Console }}
 * @throws {LogRetentionValidationError}
 */
function validatePurgeOptions(options, env = process.env) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new LogRetentionValidationError("purgeWebhookLogs options must be an object", "options");
  }
  const unknown = Object.keys(options).filter((key) => !ALLOWED_OPTIONS.has(key));
  if (unknown.length > 0) {
    throw new LogRetentionValidationError(
      `Unknown purgeWebhookLogs option(s): ${unknown.map((k) => describeValue(k)).join(", ")}`,
      unknown[0],
    );
  }

  const { pool } = options;
  if (!pool) {
    throw new Error("A pg pool/client is required for purgeWebhookLogs.");
  }
  if (typeof pool.query !== "function") {
    throw new LogRetentionValidationError("pool must expose a query() function", "pool");
  }

  const logger = options.logger ?? console;
  if (typeof logger.log !== "function" || typeof logger.error !== "function") {
    throw new LogRetentionValidationError("logger must expose log() and error()", "logger");
  }

  return {
    pool,
    logger,
    retentionDays: resolveSetting("retentionDays", options.retentionDays, DEFAULT_RETENTION_DAYS, env),
    batchSize: resolveSetting("batchSize", options.batchSize, DEFAULT_BATCH_SIZE, env),
    maxDurationMs: resolveSetting("maxDurationMs", options.maxDurationMs, DEFAULT_MAX_DURATION_MS, env),
    maxBatches: resolveSetting("maxBatches", options.maxBatches, DEFAULT_MAX_BATCHES, env),
  };
}

/**
 * Allow-list check for an identifier that will be interpolated into SQL.
 * @throws {LogRetentionValidationError}
 */
function assertPurgeTarget(tableName, timestampColumn) {
  if (!IDENTIFIER_PATTERN.test(tableName) || !IDENTIFIER_PATTERN.test(timestampColumn)) {
    throw new LogRetentionValidationError("Purge target contains an invalid SQL identifier", "tableName");
  }
  if (!PURGEABLE_TARGETS[tableName]?.has(timestampColumn)) {
    throw new LogRetentionValidationError(
      `${tableName}.${timestampColumn} is not an allowed purge target`,
      "tableName",
    );
  }
}

const SECRET_PATTERNS = [
  // postgres://user:password@host/db and similar URLs with credentials
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1***:***@"],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=***"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer ***"],
];

/**
 * Scrub credentials from a message before it is logged. Also strips control
 * characters (log injection) and caps the length.
 *
 * @param {unknown} message
 * @returns {string}
 */
function sanitizeLogMessage(message) {
  let text = typeof message === "string" ? message : message instanceof Error ? message.message : String(message);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

/** Validate a driver result's row count. */
function readRowCount(result, batchSize) {
  const count = result?.rowCount ?? 0;
  if (!Number.isSafeInteger(count) || count < 0 || count > batchSize) {
    throw new LogRetentionValidationError(
      `Unexpected rowCount from database driver: ${describeValue(count)}`,
      "rowCount",
    );
  }
  return count;
}

async function validatePurgeSafety({ pool, tableName, timestampColumn }) {
  assertPurgeTarget(tableName, timestampColumn);

  const indexQuery = `
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = $1
      AND indexdef ILIKE '%' || $2 || '%'
    LIMIT 1
  `;
  const indexResult = await pool.query(indexQuery, [tableName, timestampColumn]);
  if (!indexResult || indexResult.rowCount === 0) {
    throw new Error(
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
  const fkResult = await pool.query(fkQuery, [tableName]);
  if (fkResult?.rowCount > 0) {
    const constraint = String(fkResult.rows?.[0]?.conname ?? "unknown");
    throw new Error(
      `Table ${tableName} is referenced by foreign keys (example: ${sanitizeLogMessage(constraint)}); aborting purge.`,
    );
  }
}

async function purgeWebhookLogs(options = {}) {
  const { pool, logger, retentionDays, batchSize, maxDurationMs, maxBatches } = validatePurgeOptions(options);

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
  let deletedInBatch = 0;
  let batches = 0;

  do {
    if (batches >= maxBatches) {
      throw new LogRetentionValidationError(
        `Purge stopped after ${maxBatches} batches (${totalDeleted} rows deleted); raise LOG_PURGE_MAX_BATCHES if this is expected.`,
        "maxBatches",
      );
    }

    const deleteQuery = `
      WITH rows_to_delete AS (
        SELECT id
        FROM ${tableName}
        WHERE ${timestampColumn} < NOW() - make_interval(days => $1::int)
        ORDER BY ${timestampColumn} ASC
        LIMIT $2
      )
      DELETE FROM ${tableName} t
      USING rows_to_delete d
      WHERE t.id = d.id
      RETURNING t.id
    `;

    const deleteResult = await pool.query(deleteQuery, [retentionDays, batchSize]);
    deletedInBatch = readRowCount(deleteResult, batchSize);
    totalDeleted += deletedInBatch;
    batches += 1;
  } while (deletedInBatch > 0);

  const durationMs = Date.now() - startedAt;
  const durationSec = (durationMs / 1000).toFixed(2);
  logger.log(
    `[log-retention] Purge complete for ${tableName}: deleted_rows=${totalDeleted} duration_ms=${durationMs} duration_sec=${durationSec}`,
  );

  if (durationMs > maxDurationMs) {
    logger.error(
      `[ALERT][log-retention] Purge exceeded max duration (${maxDurationMs}ms): actual=${durationMs}ms`,
    );
  }

  // Only known, non-sensitive fields are returned.
  return Object.freeze({
    tableName,
    retentionDays,
    batchSize,
    totalDeleted,
    durationMs,
    batches,
  });
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
  validatePurgeOptions,
  sanitizeLogMessage,
  assertPurgeTarget,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MAX_BATCHES,
};
