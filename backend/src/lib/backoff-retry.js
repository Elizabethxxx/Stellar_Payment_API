/**
 * Shared full-jitter exponential backoff for idempotent reads (issues #1459,
 * #1479).
 *
 * Used by the SEP-0001 Stellar Info Generator (merchant lookup) and the
 * Payment Processor (status / verification lookups). Both retry ONLY
 * transient failures, classified by the same rules as the payment session
 * writer (`isRetryableSessionError`): network errors, 408/429/5xx and
 * connection-class Postgres errors. Validation, auth, not-found and
 * constraint errors are never retried, so a retry can never turn a rejected
 * request into an accepted one.
 *
 *   delay(n) = random(0, min(maxDelayMs, baseDelayMs * 2^n))
 *
 * Attempts and delays are clamped to per-caller ceilings so env/config can
 * never make an HTTP request hang.
 */

import { logger as defaultLogger } from "./logger.js";
import { computeBackoffDelay, isRetryableSessionError } from "./payment-session-retry.js";

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Resolve retry options from explicit options, then `<envPrefix>_MAX_ATTEMPTS`
 * / `_BASE_DELAY_MS` / `_MAX_DELAY_MS`, then defaults, clamped to ceilings.
 *
 * @param {object} options
 * @param {Record<string,string|undefined>} env
 * @param {{envPrefix:string, defaults:{maxAttempts:number, baseDelayMs:number, maxDelayMs:number}, maxAttemptsCeiling:number, maxDelayCeilingMs:number}} spec
 */
export function resolveBackoffOptions(options = {}, env = process.env, spec) {
  const { envPrefix, defaults, maxAttemptsCeiling, maxDelayCeilingMs } = spec;
  const maxAttempts = clampInt(
    options.maxAttempts ?? env[`${envPrefix}_MAX_ATTEMPTS`],
    defaults.maxAttempts,
    1,
    maxAttemptsCeiling,
  );
  const baseDelayMs = clampInt(
    options.baseDelayMs ?? env[`${envPrefix}_BASE_DELAY_MS`],
    defaults.baseDelayMs,
    0,
    maxDelayCeilingMs,
  );
  const maxDelayMs = clampInt(
    options.maxDelayMs ?? env[`${envPrefix}_MAX_DELAY_MS`],
    defaults.maxDelayMs,
    baseDelayMs,
    maxDelayCeilingMs,
  );
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation`, retrying transient failures with full-jitter backoff.
 * The final error is rethrown annotated with `retryAttempts`.
 *
 * @template T
 * @param {(ctx:{attempt:number}) => Promise<T>} operation
 * @param {object} options
 * @param {{maxAttempts:number, baseDelayMs:number, maxDelayMs:number}} options.resolved
 * @param {string} [options.label]  Fixed, server-side operation name
 * @param {(err:unknown) => boolean} [options.shouldRetry]
 * @param {(ms:number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.random]
 * @param {(info:{attempt:number, delayMs:number, error:unknown}) => void} [options.onRetry]
 * @param {(info:{attempts:number}) => void} [options.onRecovered]
 * @param {(info:{attempts:number, error:unknown}) => void} [options.onExhausted]
 * @param {object} [options.context]  Extra, non-sensitive log fields
 * @param {object} [options.logger]
 * @returns {Promise<T>}
 */
export async function retryWithBackoff(operation, options) {
  const {
    resolved,
    label = "operation",
    shouldRetry = isRetryableSessionError,
    sleep = defaultSleep,
    random = Math.random,
    onRetry,
    onRecovered,
    onExhausted,
    context = {},
    logger = defaultLogger,
  } = options;

  let lastError;
  for (let attempt = 1; attempt <= resolved.maxAttempts; attempt += 1) {
    try {
      const result = await operation({ attempt });
      if (attempt > 1) onRecovered?.({ attempts: attempt });
      return result;
    } catch (err) {
      lastError = err;
      const retryable = shouldRetry(err);
      const exhausted = attempt >= resolved.maxAttempts;

      if (!retryable || exhausted) {
        if (err && typeof err === "object") err.retryAttempts = attempt;
        if (retryable && exhausted) {
          onExhausted?.({ attempts: attempt, error: err });
          logger.error(
            { ...context, label, attempts: attempt, err: err?.message, code: err?.code },
            "Operation failed after exhausting retries",
          );
        }
        throw err;
      }

      const delayMs = computeBackoffDelay(attempt - 1, resolved, random);
      logger.warn(
        {
          ...context,
          label,
          attempt,
          maxAttempts: resolved.maxAttempts,
          delayMs,
          err: err?.message,
          code: err?.code,
        },
        "Operation failed, retrying with backoff",
      );
      onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/** Internal carrier so a Supabase `{ error }` result can drive the retry loop. */
class RetryableResultError extends Error {
  constructor(result) {
    super(result?.error?.message ?? "retryable result error");
    this.name = "RetryableResultError";
    this.result = result;
    this.code = result?.error?.code;
  }
}

/**
 * Retry a Supabase-style read that reports failures as `{ data, error }`
 * instead of throwing. `runQuery` must build a NEW query on every call
 * (PostgREST builders are single-use).
 *
 * Transient `error`s are retried; when retries run out, or the error is not
 * transient, the last `{ data, error }` result is returned unchanged so the
 * caller's existing error handling and status codes still apply. Thrown
 * transient errors are retried and rethrown when exhausted.
 *
 * @template R
 * @param {() => Promise<R & {error?: unknown}>} runQuery
 * @param {Parameters<typeof retryWithBackoff>[1]} options
 * @returns {Promise<R>}
 */
export async function retrySupabaseRead(runQuery, options) {
  const shouldRetry = options.shouldRetry ?? isRetryableSessionError;
  try {
    return await retryWithBackoff(
      async (ctx) => {
        const result = await runQuery(ctx);
        if (result?.error && shouldRetry(result.error)) {
          throw new RetryableResultError(result);
        }
        return result;
      },
      {
        ...options,
        shouldRetry: (err) => err instanceof RetryableResultError || shouldRetry(err),
      },
    );
  } catch (err) {
    if (err instanceof RetryableResultError) {
      if (err.result?.error && typeof err.result.error === "object") {
        err.result.error.retryAttempts = err.retryAttempts;
      }
      return err.result;
    }
    throw err;
  }
}
