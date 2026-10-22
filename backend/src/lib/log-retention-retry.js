/**
 * Automated retry with exponential backoff for the Log Retention & Archival
 * Service (issue #1474).
 *
 * Every query the purge issues is safe to repeat: the safety checks are
 * read-only and each delete batch removes "rows older than the cutoff", so a
 * batch that is retried after a lost acknowledgement simply deletes nothing
 * or the next rows. Only transient database/network failures are retried:
 *
 *   40001 serialization_failure      40P01 deadlock_detected
 *   55P03 lock_not_available         57014 query_canceled (statement timeout)
 *   57P01/57P02/57P03 server restart 53300 too_many_connections
 *   08xxx connection exceptions      ECONNRESET / ETIMEDOUT / ... socket errors
 *
 * Safety-check rejections (missing index, foreign keys), syntax and
 * permission errors are never retried, so a purge that must not run cannot
 * be forced through by repetition.
 *
 * Delay schedule: full jitter
 *   delay(n) = random(0, min(maxDelayMs, baseDelayMs * 2^n))
 * Attempts and delays are clamped to hard ceilings so a misconfigured
 * environment cannot turn a failing purge into a load generator against
 * the primary database.
 */

import { logger } from './logger.js';
import { recordLogRetentionRetry } from './log-retention-telemetry.js';

export const DEFAULT_LOG_RETENTION_RETRY_OPTIONS = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
});

const MAX_ATTEMPTS_CEILING = 8;
const MAX_DELAY_CEILING_MS = 60_000;

const RETRYABLE_SQLSTATES = new Set([
  '40001',
  '40P01',
  '55P03',
  '57014',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryableLogRetentionError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.retryable === false) return false;
  if (err.retryable === true) return true;

  const code = typeof err.code === 'string' ? err.code : '';
  if (RETRYABLE_SQLSTATES.has(code)) return true;
  // Class 08: connection exceptions (08000, 08003, 08006, ...).
  if (/^08[0-9A-Z]{3}$/.test(code)) return true;
  if (RETRYABLE_NETWORK_CODES.has(code)) return true;
  // Any other SQLSTATE (syntax, permission, constraint, ...) is deterministic.
  if (/^[0-9A-Z]{5}$/.test(code)) return false;

  const message = typeof err.message === 'string' ? err.message : '';
  return /connection terminated|connection timeout|timeout exceeded when trying to connect|socket hang up/i.test(
    message,
  );
}

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export function resolveLogRetentionRetryOptions(options = {}, env = process.env) {
  const maxAttempts = clampInt(
    options.maxAttempts ?? env.LOG_PURGE_RETRY_MAX_ATTEMPTS,
    DEFAULT_LOG_RETENTION_RETRY_OPTIONS.maxAttempts,
    1,
    MAX_ATTEMPTS_CEILING,
  );
  const baseDelayMs = clampInt(
    options.baseDelayMs ?? env.LOG_PURGE_RETRY_BASE_DELAY_MS,
    DEFAULT_LOG_RETENTION_RETRY_OPTIONS.baseDelayMs,
    0,
    MAX_DELAY_CEILING_MS,
  );
  const maxDelayMs = clampInt(
    options.maxDelayMs ?? env.LOG_PURGE_RETRY_MAX_DELAY_MS,
    DEFAULT_LOG_RETENTION_RETRY_OPTIONS.maxDelayMs,
    baseDelayMs,
    MAX_DELAY_CEILING_MS,
  );
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

/**
 * @param {number} retryIndex 0 for the first retry
 * @param {{baseDelayMs:number, maxDelayMs:number}} opts
 * @param {() => number} [random]
 */
export function computeLogRetentionBackoffDelay(
  retryIndex,
  { baseDelayMs, maxDelayMs },
  random = Math.random,
) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** retryIndex);
  if (ceiling <= 0) return 0;
  return Math.floor(random() * ceiling);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation`, retrying transient failures with full-jitter exponential
 * backoff. The final error is rethrown with `retryAttempts` set.
 *
 * @template T
 * @param {(ctx:{attempt:number}) => Promise<T>} operation
 * @param {object} [options]
 * @param {string} [options.label]  Fixed, server-side step name for logs
 * @param {number} [options.maxAttempts]
 * @param {number} [options.baseDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {(err:unknown) => boolean} [options.shouldRetry]
 * @param {(ms:number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.random]
 * @param {() => boolean} [options.shouldAbort]  Stop retrying (e.g. deadline passed)
 * @returns {Promise<T>}
 */
export async function withLogRetentionRetry(operation, options = {}) {
  const {
    label = 'log-retention-query',
    shouldRetry = isRetryableLogRetentionError,
    sleep = defaultSleep,
    random = Math.random,
    shouldAbort = () => false,
  } = options;
  const resolved = resolveLogRetentionRetryOptions(options);

  let lastError;
  for (let attempt = 1; attempt <= resolved.maxAttempts; attempt += 1) {
    try {
      const result = await operation({ attempt });
      if (attempt > 1) recordLogRetentionRetry('recovered');
      return result;
    } catch (err) {
      lastError = err;
      const retryable = shouldRetry(err);
      const exhausted = attempt >= resolved.maxAttempts || (retryable && shouldAbort());

      if (!retryable || exhausted) {
        if (err && typeof err === 'object') err.retryAttempts = attempt;
        if (retryable && exhausted) {
          recordLogRetentionRetry('exhausted');
          logger.error(
            { label, attempts: attempt, err: err?.message, code: err?.code },
            'Log retention query failed after exhausting retries',
          );
        }
        throw err;
      }

      const delayMs = computeLogRetentionBackoffDelay(attempt - 1, resolved, random);
      logger.warn(
        {
          label,
          attempt,
          maxAttempts: resolved.maxAttempts,
          delayMs,
          err: err?.message,
          code: err?.code,
        },
        'Log retention query failed, retrying with backoff',
      );
      recordLogRetentionRetry('scheduled');
      await sleep(delayMs);
    }
  }

  throw lastError;
}
