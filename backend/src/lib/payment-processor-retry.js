/**
 * Automated retry with exponential backoff for Payment Processor reads
 * (issue #1479), recorded through Payment Processor Telemetry.
 *
 * The status poll (`GET /api/payment-status/:id`) and the verification
 * lookup (`POST /api/verify-payment/:id`) start with a single Supabase read.
 * A dropped connection or a 5xx used to fail the request outright, and the
 * failure was invisible in the processor metrics. Both reads are idempotent,
 * so they are now retried:
 *
 *   - Retried: network errors, 408/429/5xx, connection-class Postgres errors
 *     (shared classifier `isRetryableSessionError`).
 *   - Never retried: not-found, invalid ids, PostgREST/client errors, and
 *     every write. Status updates and tx claims are NOT wrapped: retrying a
 *     write is the job of the code that owns its idempotency.
 *   - Delay: full jitter, random(0, min(maxDelay, base * 2^n)).
 *   - Budget: PAYMENT_PROCESSOR_RETRY_MAX_ATTEMPTS (default 3, max 5),
 *     PAYMENT_PROCESSOR_RETRY_BASE_DELAY_MS (default 50),
 *     PAYMENT_PROCESSOR_RETRY_MAX_DELAY_MS (default 500, max 3000).
 *     Small on purpose: these are latency-sensitive request paths.
 *
 * Every retry outcome goes to `payment_processor_retries_total{operation,
 * result}`; exhausted retries also degrade processor health.
 */

import { resolveBackoffOptions, retrySupabaseRead } from "./backoff-retry.js";
import { recordProcessorRetryTelemetry } from "./payment-processor-telemetry.js";

export const DEFAULT_PROCESSOR_RETRY_OPTIONS = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 500,
});

const SPEC = Object.freeze({
  envPrefix: "PAYMENT_PROCESSOR_RETRY",
  defaults: DEFAULT_PROCESSOR_RETRY_OPTIONS,
  maxAttemptsCeiling: 5,
  maxDelayCeilingMs: 3000,
});

/** @param {object} [options] @param {Record<string,string|undefined>} [env] */
export function resolveProcessorRetryOptions(options = {}, env = process.env) {
  return resolveBackoffOptions(options, env, SPEC);
}

/**
 * Retry an idempotent Supabase read made by the payment processor.
 *
 * @template R
 * @param {"status_lookup"|"verify_lookup"} operation  Fixed telemetry label
 * @param {() => Promise<R>} runQuery  Must build a NEW query on each call
 * @param {object} [options] maxAttempts, baseDelayMs, maxDelayMs, sleep, random, shouldRetry
 * @returns {Promise<R>} the final `{ data, error }` result
 */
export function retryProcessorRead(operation, runQuery, options = {}) {
  const { sleep, random, shouldRetry } = options;
  const record = (result) => recordProcessorRetryTelemetry({ operation, result });
  return retrySupabaseRead(runQuery, {
    resolved: resolveProcessorRetryOptions(options),
    label: `payment-processor-${operation}`,
    sleep,
    random,
    ...(shouldRetry ? { shouldRetry } : {}),
    onRetry: () => record("scheduled"),
    onRecovered: () => record("recovered"),
    onExhausted: () => record("exhausted"),
  });
}
