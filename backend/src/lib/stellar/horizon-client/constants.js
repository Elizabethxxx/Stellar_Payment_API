/**
 * Horizon Client Constants
 * 
 * Centralized configuration constants for the Horizon Client
 */

export const DEFAULT_RETRY_DELAYS_MS = Object.freeze([150, 500]);
export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

/**
 * Backoff policy defaults (issue #1439). See backoff.js.
 * The default strategy keeps the legacy attempt count (initial + 2 retries)
 * but spreads retries with jittered exponential delays.
 */
export const BACKOFF_STRATEGIES = Object.freeze({
  EXPONENTIAL: "exponential",
  FIXED: "fixed",
});

export const BACKOFF_JITTER_MODES = Object.freeze({
  FULL: "full",
  EQUAL: "equal",
  NONE: "none",
});

export const DEFAULT_BACKOFF_OPTIONS = Object.freeze({
  strategy: BACKOFF_STRATEGIES.EXPONENTIAL,
  maxRetries: DEFAULT_RETRY_DELAYS_MS.length,
  baseDelayMs: 150,
  maxDelayMs: 2_000,
  multiplier: 3,
  jitter: BACKOFF_JITTER_MODES.FULL,
  /** Total time budget for one operation including all waits. */
  maxElapsedMs: 10_000,
  /** A Retry-After hint longer than this fails fast instead of waiting. */
  maxRetryAfterMs: 5_000,
  fixedDelays: DEFAULT_RETRY_DELAYS_MS,
});

/** Hard ceilings applied to any configured value. */
export const BACKOFF_LIMITS = Object.freeze({
  maxRetries: 10,
  maxDelayMs: 30_000,
  maxMultiplier: 10,
  maxElapsedMs: 120_000,
});

/**
 * Concurrency control defaults (issue #1440). See concurrency-limiter.js and
 * retry-coordinator.js.
 */
export const DEFAULT_CONCURRENCY_OPTIONS = Object.freeze({
  /** Operations allowed to run against Horizon at once, per process. */
  maxConcurrent: 64,
  /** Operations allowed to wait for a slot before new ones are rejected. */
  maxQueue: 1_000,
  /** How long a queued operation waits before it is rejected. */
  queueTimeoutMs: 10_000,
});

export const DEFAULT_RETRY_COORDINATION_OPTIONS = Object.freeze({
  /** Retries allowed in flight at once per operation, across all instances. */
  maxConcurrentRetries: 32,
  /** Safety lease on a retry slot; released explicitly long before this. */
  retrySlotLeaseMs: 30_000,
  /** Longest shared rate-limit cooldown any instance may publish. */
  maxCooldownMs: 5_000,
  keyPrefix: "horizon:retry:",
});

export const CONCURRENCY_LIMITS = Object.freeze({
  maxConcurrent: 1_024,
  maxQueue: 100_000,
  queueTimeoutMs: 120_000,
  maxConcurrentRetries: 1_024,
  retrySlotLeaseMs: 120_000,
  maxCooldownMs: 60_000,
});

/** Error codes attached to errors raised by the Retry Manager itself. */
export const RETRY_MANAGER_ERROR_CODES = Object.freeze({
  QUEUE_FULL: "HORIZON_CLIENT_QUEUE_FULL",
  QUEUE_TIMEOUT: "HORIZON_CLIENT_QUEUE_TIMEOUT",
});

export const RETRYABLE_ERROR_CODES = Object.freeze([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export const RETRYABLE_ERROR_STATUS_CODES = Object.freeze([408, 429]);

export const RETRYABLE_MESSAGE_PATTERNS = Object.freeze([
  "timeout",
  "temporar",
  "network",
  "socket",
  "fetch failed",
]);

export const ERROR_CLASSIFICATION = Object.freeze({
  RATE_LIMIT: "rate_limit",
  NOT_FOUND: "not_found",
  SERVER_ERROR: "server_error",
  CLIENT_ERROR: "client_error",
  NETWORK_ERROR: "network_error",
  TIMEOUT: "timeout",
  UNKNOWN: "unknown",
});

export const ERROR_STATUS_MAPPING = Object.freeze({
  [ERROR_CLASSIFICATION.RATE_LIMIT]: 429,
  [ERROR_CLASSIFICATION.NOT_FOUND]: 404,
  [ERROR_CLASSIFICATION.SERVER_ERROR]: 502,
  [ERROR_CLASSIFICATION.NETWORK_ERROR]: 502,
  [ERROR_CLASSIFICATION.TIMEOUT]: 502,
});

export const HTTP_STATUS_RANGES = Object.freeze({
  SUCCESS: [200, 299],
  REDIRECT: [300, 399],
  CLIENT_ERROR: [400, 499],
  SERVER_ERROR: [500, 599],
});
