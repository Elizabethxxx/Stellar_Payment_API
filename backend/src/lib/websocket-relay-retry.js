/**
 * websocket-relay-retry.js
 *
 * Automated retry with exponential backoff for the WebSocket Relay Service
 * (issue #1454).
 *
 * reconnectWithBackoff() in websocket-relay-recovery.js retries a connection
 * on every error. Relay deliveries need more care:
 *
 *   - Only transient failures are retried (network errors, timeouts, 408,
 *     429, 5xx). Validation, signature and auth failures and an OPEN circuit
 *     breaker fail immediately: retrying them cannot succeed, and retrying
 *     into an open breaker would defeat it.
 *   - Full-jitter backoff: delay(n) = random(0, min(maxDelayMs, baseDelayMs * 2^n)),
 *     so many relay instances never retry in lockstep.
 *   - A total time budget (maxElapsedMs) and an AbortSignal bound every call.
 *   - Messages that still fail are moved to the dead letter queue instead of
 *     being dropped, and can be redriven later.
 *   - Every retry and outcome is recorded in websocket-relay-telemetry.js.
 *
 * Logs never include message payloads, only the operation label, attempt
 * counts, delays and the error's code/status.
 */

import { logger } from "./logger.js";
import { recordRelayDelivery, recordRelayRetry } from "./websocket-relay-telemetry.js";

export const DEFAULT_RELAY_RETRY_OPTIONS = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 10_000,
  maxElapsedMs: 30_000,
});

const LIMITS = Object.freeze({
  maxAttempts: 10,
  maxDelayMs: 60_000,
  maxElapsedMs: 300_000,
});

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** WebSocket close codes worth retrying (1006 abnormal, 1011 server error, 1012 restart, 1013 try again later). */
const RETRYABLE_CLOSE_CODES = new Set([1006, 1011, 1012, 1013]);

export class RelayRetryAbortedError extends Error {
  constructor(message = "Relay retry aborted") {
    super(message);
    this.name = "RelayRetryAbortedError";
    this.retryable = false;
  }
}

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Resolve retry options. Precedence: explicit > environment > defaults.
 * Values are clamped so bad configuration can neither disable backoff nor
 * stall the relay.
 */
export function resolveRelayRetryOptions(options = {}, env = process.env) {
  const maxAttempts = clampInt(
    options.maxAttempts ?? env.RELAY_RETRY_MAX_ATTEMPTS,
    DEFAULT_RELAY_RETRY_OPTIONS.maxAttempts,
    1,
    LIMITS.maxAttempts,
  );
  const baseDelayMs = clampInt(
    options.baseDelayMs ?? env.RELAY_RETRY_BASE_DELAY_MS,
    DEFAULT_RELAY_RETRY_OPTIONS.baseDelayMs,
    0,
    LIMITS.maxDelayMs,
  );
  const maxDelayMs = clampInt(
    options.maxDelayMs ?? env.RELAY_RETRY_MAX_DELAY_MS,
    DEFAULT_RELAY_RETRY_OPTIONS.maxDelayMs,
    baseDelayMs,
    LIMITS.maxDelayMs,
  );
  const maxElapsedMs = clampInt(
    options.maxElapsedMs ?? env.RELAY_RETRY_MAX_ELAPSED_MS,
    DEFAULT_RELAY_RETRY_OPTIONS.maxElapsedMs,
    0,
    LIMITS.maxElapsedMs,
  );
  return Object.freeze({ maxAttempts, baseDelayMs, maxDelayMs, maxElapsedMs });
}

/**
 * Full-jitter backoff delay before retry number `retryIndex` (0 = first retry).
 *
 * @param {number} retryIndex
 * @param {{ baseDelayMs: number, maxDelayMs: number }} opts
 * @param {() => number} [random]
 */
export function computeRelayBackoffDelay(retryIndex, { baseDelayMs, maxDelayMs }, random = Math.random) {
  const index = Math.min(Math.max(Math.trunc(Number(retryIndex) || 0), 0), 30);
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** index);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return 0;
  const r = Math.min(Math.max(Number(random()) || 0, 0), 1);
  return Math.floor(r * ceiling);
}

function getStatus(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  return typeof status === "number" ? status : null;
}

/**
 * Whether a relay failure is transient and worth retrying.
 * @param {unknown} err
 */
export function isRetryableRelayError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.circuitOpen === true) return false;
  if (err.retryable === false) return false;
  if (err.retryable === true) return true;

  const status = getStatus(err);
  if (status !== null) {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status !== 501) return true;
    if (status >= 400) return false;
  }

  if (typeof err.closeCode === "number") return RETRYABLE_CLOSE_CODES.has(err.closeCode);
  if (RETRYABLE_NETWORK_CODES.has(err.code)) return true;

  const message = typeof err.message === "string" ? err.message : "";
  return /timed? ?out|socket hang up|network error|connection (reset|closed)/i.test(message);
}

function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RelayRetryAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort() {
      clearTimeout(timer);
      reject(new RelayRetryAbortedError());
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function errorFields(err) {
  return {
    err: typeof err?.message === "string" ? err.message.slice(0, 200) : undefined,
    code: err?.code,
    status: getStatus(err) ?? undefined,
    closeCode: err?.closeCode,
  };
}

/**
 * Run `operation` with automated retries and full-jitter exponential backoff.
 *
 * @template T
 * @param {(ctx: { attempt: number, signal?: AbortSignal }) => Promise<T>} operation
 * @param {object} [options]
 * @param {'deliver'|'reconnect'|'redrive'|'other'} [options.operation='other'] telemetry label
 * @param {number} [options.maxAttempts]
 * @param {number} [options.baseDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {number} [options.maxElapsedMs] total budget including waits
 * @param {AbortSignal} [options.signal]
 * @param {(err: unknown) => boolean} [options.shouldRetry]
 * @param {(info: { attempt: number, delayMs: number, error: unknown }) => void} [options.onRetry]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep] injectable for tests
 * @param {() => number} [options.random] injectable for tests
 * @param {() => number} [options.now] injectable for tests
 * @returns {Promise<{ value: T, attempts: number }>}
 * @throws the last error, with `retryAttempts` set
 */
export async function withRelayRetry(operation, options = {}) {
  const {
    operation: label = "other",
    signal,
    shouldRetry = isRetryableRelayError,
    onRetry,
    sleep = sleepWithSignal,
    random = Math.random,
    now = Date.now,
  } = options;
  const resolved = resolveRelayRetryOptions(options);
  const deadline = now() + resolved.maxElapsedMs;

  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) {
      recordRelayRetry(label, "aborted");
      throw Object.assign(new RelayRetryAbortedError(), { retryAttempts: attempt - 1 });
    }

    try {
      const value = await operation({ attempt, signal });
      if (attempt > 1) recordRelayRetry(label, "recovered");
      return { value, attempts: attempt };
    } catch (err) {
      const retryable = !(err instanceof RelayRetryAbortedError) && shouldRetry(err);
      const delayMs = computeRelayBackoffDelay(attempt - 1, resolved, random);
      const outOfAttempts = attempt >= resolved.maxAttempts;
      const outOfTime = now() + delayMs > deadline;

      if (!retryable || outOfAttempts || outOfTime) {
        if (err && typeof err === "object") err.retryAttempts = attempt;
        if (retryable) {
          recordRelayRetry(label, "exhausted");
          logger.error(
            { operation: label, attempts: attempt, reason: outOfAttempts ? "max_attempts" : "time_budget", ...errorFields(err) },
            "WebSocket relay operation failed after exhausting retries",
          );
        }
        throw err;
      }

      recordRelayRetry(label, "scheduled", delayMs);
      logger.warn(
        { operation: label, attempt, maxAttempts: resolved.maxAttempts, delayMs, ...errorFields(err) },
        "WebSocket relay operation failed, retrying with backoff",
      );
      try {
        onRetry?.({ attempt, delayMs, error: err });
      } catch {
        // An observer must never break the retry loop.
      }

      try {
        await sleep(delayMs, signal);
      } catch (sleepErr) {
        recordRelayRetry(label, "aborted");
        throw Object.assign(
          sleepErr instanceof Error ? sleepErr : new RelayRetryAbortedError(),
          { retryAttempts: attempt },
        );
      }
    }
  }
}

/**
 * Deliver one relay message with retries, through the circuit breaker when
 * one is given, dead-lettering it when every attempt fails.
 *
 * @param {unknown} message
 * @param {(message: unknown, ctx: { attempt: number }) => Promise<unknown>} send
 * @param {object} [options] retry options plus:
 * @param {{ call: (fn: () => Promise<unknown>) => Promise<unknown> }} [options.circuitBreaker]
 * @param {{ push: (message: unknown, error: unknown, retryCount: number) => void }} [options.dlq]
 * @param {number} [options.previousAttempts=0] attempts already spent (redrive)
 * @returns {Promise<{ delivered: true, attempts: number, value: unknown } | { delivered: false, attempts: number, deadLettered: true, error: unknown }>}
 * @throws the delivery error when no `dlq` is given
 */
export async function deliverRelayMessage(message, send, options = {}) {
  if (typeof send !== "function") {
    throw new TypeError("deliverRelayMessage requires a send function");
  }
  const { circuitBreaker, dlq, previousAttempts = 0, operation = "deliver", ...retryOptions } = options;

  try {
    const { value, attempts } = await withRelayRetry(
      (ctx) => (circuitBreaker ? circuitBreaker.call(() => send(message, ctx)) : send(message, ctx)),
      { ...retryOptions, operation },
    );
    recordRelayDelivery(attempts > 1 ? "recovered" : "delivered");
    return { delivered: true, attempts, value };
  } catch (error) {
    const attempts = typeof error?.retryAttempts === "number" ? error.retryAttempts : 1;
    if (!dlq) {
      recordRelayDelivery("failed");
      throw error;
    }
    dlq.push(message, error, previousAttempts + attempts);
    recordRelayDelivery("dead_lettered");
    logger.warn(
      { operation, attempts: previousAttempts + attempts, circuitOpen: error?.circuitOpen === true, ...errorFields(error) },
      "WebSocket relay message moved to dead letter queue",
    );
    return { delivered: false, attempts, deadLettered: true, error };
  }
}

/**
 * Re-attempt up to `limit` dead-lettered messages, oldest first. Messages
 * that fail again go back on the queue with their retry count increased.
 *
 * @param {{ shift: () => any, push: Function, size: number }} dlq
 * @param {(message: unknown, ctx: { attempt: number }) => Promise<unknown>} send
 * @param {object} [options] deliverRelayMessage options plus `limit` (default 50)
 * @returns {Promise<{ redelivered: number, failed: number }>}
 */
export async function redriveDeadLetters(dlq, send, options = {}) {
  if (!dlq || typeof dlq.shift !== "function") {
    throw new TypeError("redriveDeadLetters requires a dead letter queue");
  }
  const { limit = 50, ...deliverOptions } = options;
  const max = clampInt(limit, 50, 0, 10_000);
  let redelivered = 0;
  let failed = 0;

  // Snapshot the count first so entries re-queued by this run are not retried again.
  const toProcess = Math.min(max, dlq.size);
  for (let i = 0; i < toProcess; i += 1) {
    const entry = dlq.shift();
    if (!entry) break;
    const result = await deliverRelayMessage(entry.message, send, {
      ...deliverOptions,
      operation: "redrive",
      dlq,
      previousAttempts: Number(entry.retryCount) || 0,
    });
    if (result.delivered) redelivered += 1;
    else failed += 1;
  }
  return { redelivered, failed };
}
