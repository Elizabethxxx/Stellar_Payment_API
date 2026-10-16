import client from "prom-client";
import { logger } from "./logger.js";

/**
 * Automated retry with exponential backoff for the Idempotency Key Manager
 * (issue #1464).
 *
 * The idempotency middleware depends on Redis for two things: reading a
 * cached response (so a client retry is replayed instead of creating a
 * duplicate payment) and writing the response after the handler succeeds.
 * Before this change, a single transient Redis blip (connection reset,
 * failover READONLY, LOADING after restart) meant:
 *
 *   - read:  the request silently skipped idempotency (possible duplicate)
 *   - write: the response was never cached (the next retry duplicates)
 *
 * Every Redis call is now retried with capped exponential backoff and jitter:
 *
 *   delay(attempt) = min(baseDelayMs * 2^attempt, maxDelayMs) * (1 ± jitterRatio)
 *
 * Retries stop when maxRetries is reached or when the next delay would
 * exceed totalBudgetMs, so request latency stays bounded. Only transient
 * errors are retried. A closed client, auth/permission errors and corrupt
 * cache entries fail immediately, and the caller's existing fail-open
 * behaviour applies.
 */

const register = new client.Registry();

register.setDefaultLabels({
  app: "stellar-payment-api",
});

/** operation: get | set | lookup — outcome: success | recovered | failed | non_retryable */
export const idempotencyRedisOperationsTotal = new client.Counter({
  name: "idempotency_redis_operations_total",
  help: "Idempotency Key Manager Redis operations, by operation and final outcome",
  labelNames: ["operation", "outcome"],
});

export const idempotencyRedisRetriesTotal = new client.Counter({
  name: "idempotency_redis_retries_total",
  help: "Retries of idempotency Redis operations after a transient error",
  labelNames: ["operation"],
});

export const idempotencyRedisRetryDelaySeconds = new client.Histogram({
  name: "idempotency_redis_retry_delay_seconds",
  help: "Backoff delay applied before each idempotency Redis retry",
  labelNames: ["operation"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

register.registerMetric(idempotencyRedisOperationsTotal);
register.registerMetric(idempotencyRedisRetriesTotal);
register.registerMetric(idempotencyRedisRetryDelaySeconds);

export { register as idempotencyRegister };

const KNOWN_OPERATIONS = new Set(["get", "set", "lookup"]);

function readIntEnv(env, name, fallback, min, max) {
  const raw = Number.parseInt(String(env[name] ?? ""), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

/**
 * Resolve retry options from the environment, clamped to safe bounds.
 *
 *   IDEMPOTENCY_REDIS_MAX_RETRIES     default 2    (0-5)
 *   IDEMPOTENCY_REDIS_RETRY_BASE_MS   default 25   (1-1000)
 *   IDEMPOTENCY_REDIS_RETRY_MAX_MS    default 250  (base-5000)
 *   IDEMPOTENCY_REDIS_RETRY_BUDGET_MS default 500  (0-2000)
 */
export function resolveIdempotencyRetryOptions(env = process.env) {
  const baseDelayMs = readIntEnv(env, "IDEMPOTENCY_REDIS_RETRY_BASE_MS", 25, 1, 1000);
  return {
    maxRetries: readIntEnv(env, "IDEMPOTENCY_REDIS_MAX_RETRIES", 2, 0, 5),
    baseDelayMs,
    maxDelayMs: readIntEnv(env, "IDEMPOTENCY_REDIS_RETRY_MAX_MS", 250, baseDelayMs, 5000),
    totalBudgetMs: readIntEnv(env, "IDEMPOTENCY_REDIS_RETRY_BUDGET_MS", 500, 0, 2000),
    jitterRatio: 0.2,
  };
}

export const DEFAULT_IDEMPOTENCY_RETRY_OPTIONS = Object.freeze(resolveIdempotencyRetryOptions());

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
const RETRYABLE_ERROR_NAMES = new Set([
  "ConnectionTimeoutError",
  "SocketClosedUnexpectedlyError",
  "TimeoutError",
  "AbortError",
]);
// Redis server replies that mean "try again shortly".
const RETRYABLE_REPLY_PREFIXES = ["LOADING", "BUSY", "TRYAGAIN", "READONLY", "MASTERDOWN", "CLUSTERDOWN"];

/**
 * Transient errors only. A closed client never reopens within a request
 * (redis.js disables reconnects), and auth / type / parse errors will not
 * succeed on retry.
 */
export function isRetryableRedisError(err) {
  if (!err) return false;
  if (err.name === "ClientClosedError" || /client is closed/i.test(String(err.message))) return false;
  if (err instanceof SyntaxError) return false;
  if (RETRYABLE_CODES.has(err.code)) return true;
  if (RETRYABLE_ERROR_NAMES.has(err.name)) return true;
  const message = String(err.message ?? "");
  if (RETRYABLE_REPLY_PREFIXES.some((prefix) => message.startsWith(prefix))) return true;
  return /socket closed unexpectedly|connection (reset|lost)|timed? ?out/i.test(message);
}

/**
 * Backoff delay before retry number `attempt` (0-based).
 */
export function computeBackoffDelay(attempt, options = DEFAULT_IDEMPOTENCY_RETRY_OPTIONS, random = Math.random) {
  const { baseDelayMs, maxDelayMs, jitterRatio = 0 } = options;
  const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  const jitter = exponential * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

/**
 * Run a Redis operation with retry + exponential backoff.
 *
 * @template T
 * @param {"get"|"set"|"lookup"} operation  Metric label
 * @param {() => Promise<T>} fn
 * @param {object} [options]  Overrides for DEFAULT_IDEMPOTENCY_RETRY_OPTIONS,
 *   plus `sleep`, `now` and `random` for tests.
 * @returns {Promise<T>}
 * @throws The last error once retries are exhausted or the error is not retryable.
 */
export async function withIdempotencyRetry(operation, fn, options = {}) {
  const label = KNOWN_OPERATIONS.has(operation) ? operation : "get";
  const {
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    random = Math.random,
    ...overrides
  } = options;
  const config = { ...DEFAULT_IDEMPOTENCY_RETRY_OPTIONS, ...overrides };
  const startedAt = now();

  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await fn();
      idempotencyRedisOperationsTotal.inc({ operation: label, outcome: attempt === 0 ? "success" : "recovered" });
      return result;
    } catch (err) {
      if (!isRetryableRedisError(err)) {
        idempotencyRedisOperationsTotal.inc({ operation: label, outcome: "non_retryable" });
        throw err;
      }
      const delay = computeBackoffDelay(attempt, config, random);
      const elapsed = now() - startedAt;
      if (attempt >= config.maxRetries || elapsed + delay > config.totalBudgetMs) {
        idempotencyRedisOperationsTotal.inc({ operation: label, outcome: "failed" });
        logger.warn?.(
          { operation: label, attempts: attempt + 1, elapsedMs: elapsed, err: err?.message },
          "Idempotency Redis operation failed after retries",
        );
        throw err;
      }
      idempotencyRedisRetriesTotal.inc({ operation: label });
      idempotencyRedisRetryDelaySeconds.observe({ operation: label }, delay / 1000);
      logger.warn?.(
        { operation: label, attempt: attempt + 1, delayMs: delay, err: err?.message },
        "Idempotency Redis operation failed, retrying with backoff",
      );
      await sleep(delay);
    }
  }
}
