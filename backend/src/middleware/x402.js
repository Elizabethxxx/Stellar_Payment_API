/**
 * x402 Payment Required middleware for PLUTO.
 *
 * Custom implementation using standard Stellar USDC transfers.
 * Works with any Stellar wallet — no Soroban contract account needed.
 *
 * Flow:
 *   1. Client hits protected endpoint → gets 402 with payment details
 *   2. Client sends USDC on Stellar with the provided memo
 *   3. Client calls POST /api/verify-x402 { tx_hash } → gets JWT
 *   4. Client retries with X-Payment-Token: <jwt> → gets access
 */

import { randomUUID, createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import client from "prom-client";
import { logger } from "../lib/logger.js";
import { connectRedisClient } from "../lib/redis.js";

const USDC_ISSUER =
  process.env.USDC_ISSUER ||
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** Valid pricing mode whitelist to prevent injection or bypass */
export const ALLOWED_PRICING_MODES = new Set([
  "x402",
  "subscription",
  "api-key",
  "free",
  "metered",
]);

/** Stellar public address regex (G followed by 55 base32 chars) */
export const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

/** Positive decimal amount regex (e.g. "0.01", "10", "1.5") */
export const POSITIVE_AMOUNT_REGEX = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Asset code regex (1-12 alphanumeric characters) */
export const ASSET_CODE_REGEX = /^[A-Za-z0-9]{1,12}$/;

/** Safe memo prefix regex (alphanumeric, underscore, hyphen) */
export const MEMO_PREFIX_REGEX = /^[A-Za-z0-9_-]+$/;

/** JWT format regex (three base64url segments) */
export const JWT_FORMAT_REGEX =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Maximum length for payment token to prevent ReDoS/buffer abuse */
export const MAX_TOKEN_LENGTH = 4096;

/** Maximum length for memo prefix */
export const MAX_MEMO_PREFIX_LENGTH = 20;

/** Default token cache TTL in seconds */
export const DEFAULT_TOKEN_CACHE_TTL_SEC = 300;

/** Default lock TTL in milliseconds */
export const DEFAULT_LOCK_TTL_MS = 10_000;

/** Compare-and-delete Lua script for atomic lock release */
export const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

// ---------------------------------------------------------------------------
// Prometheus Telemetry & Metrics
// ---------------------------------------------------------------------------

function getOrCreateMetric(Type, config) {
  const existing = client.register.getSingleMetric(config.name);
  if (existing) return existing;
  return new Type(config);
}

export const x402RequestsTotal = getOrCreateMetric(client.Counter, {
  name: "x402_requests_total",
  help: "Total number of requests handled by x402 middleware",
  labelNames: ["status", "mode", "asset"],
});

export const x402VerificationDuration = getOrCreateMetric(client.Histogram, {
  name: "x402_verification_duration_seconds",
  help: "Time spent verifying x402 payment tokens in seconds",
  labelNames: ["cache_status"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

export const x402CacheHitsTotal = getOrCreateMetric(client.Counter, {
  name: "x402_cache_hits_total",
  help: "Total number of x402 token cache hits",
  labelNames: ["cache_type"],
});

export const x402CacheMissesTotal = getOrCreateMetric(client.Counter, {
  name: "x402_cache_misses_total",
  help: "Total number of x402 token cache misses",
});

export const x402ActiveChallenges = getOrCreateMetric(client.Gauge, {
  name: "x402_active_challenges",
  help: "Current number of active x402 payment challenges generated",
});

export const x402DlqEnqueuedTotal = getOrCreateMetric(client.Counter, {
  name: "x402_dlq_enqueued_total",
  help: "Total number of failed x402 operations routed to Dead-Letter Queue",
  labelNames: ["operation_type"],
});

export const x402DlqRecoveredTotal = getOrCreateMetric(client.Counter, {
  name: "x402_dlq_recovered_total",
  help: "Total number of x402 Dead-Letter Queue operations successfully recovered",
  labelNames: ["operation_type"],
});

export const x402DlqExhaustedTotal = getOrCreateMetric(client.Counter, {
  name: "x402_dlq_exhausted_total",
  help: "Total number of x402 Dead-Letter Queue operations exhausted (poison pills)",
  labelNames: ["operation_type"],
});

export const x402DlqSize = getOrCreateMetric(client.Gauge, {
  name: "x402_dlq_size",
  help: "Current number of pending items in x402 Dead-Letter Queue",
});

export const x402LockAcquiredTotal = getOrCreateMetric(client.Counter, {
  name: "x402_lock_acquired_total",
  help: "Total number of x402 concurrency locks acquired",
  labelNames: ["lock_type"],
});

export const x402LockContentionTotal = getOrCreateMetric(client.Counter, {
  name: "x402_lock_contention_total",
  help: "Total number of x402 concurrency lock contention conflicts (409)",
  labelNames: ["asset"],
});

export const x402LockReleasedTotal = getOrCreateMetric(client.Counter, {
  name: "x402_lock_released_total",
  help: "Total number of x402 concurrency locks released",
  labelNames: ["lock_type"],
});

// ---------------------------------------------------------------------------
// Concurrency Control & Distributed Locking
// ---------------------------------------------------------------------------

/** In-process lock fallback map: key -> { token, expiresAt } */
const localLocks = new Map();

/**
 * Reset local lock map for testing.
 */
export function resetLocalLocksForTests() {
  localLocks.clear();
}

/**
 * Acquire a mutual-exclusion lock for an x402 transaction or token.
 *
 * @param {string} key - Lock identifier
 * @param {number} [ttlMs=10000] - Lock expiration in ms
 * @param {object} [opts]
 * @param {object} [opts.redisClient]
 * @returns {Promise<{ acquired: boolean, token: string|null }>}
 */
export async function acquireX402Lock(key, ttlMs = DEFAULT_LOCK_TTL_MS, opts = {}) {
  const lockKey = `lock:x402:${key}`;
  const token = randomUUID();
  const now = Date.now();

  // 1. Try Redis lock
  try {
    const redis = opts.redisClient || (await connectRedisClient());
    if (redis && redis.isOpen) {
      let result = null;
      if (typeof redis.sendCommand === "function") {
        result = await redis.sendCommand([
          "SET",
          lockKey,
          token,
          "NX",
          "PX",
          String(ttlMs),
        ]);
      } else {
        result = await redis.set(lockKey, token, { NX: true, PX: ttlMs });
      }

      if (result === "OK" || result === true) {
        x402LockAcquiredTotal.inc({ lock_type: "redis" });
        return { acquired: true, token };
      }
      return { acquired: false, token: null };
    }
  } catch (err) {
    logger?.debug?.({ err: err.message }, "x402: redis lock acquire failed, using local fallback");
  }

  // 2. In-process fallback lock
  const existing = localLocks.get(lockKey);
  if (existing && existing.expiresAt > now) {
    return { acquired: false, token: null };
  }

  localLocks.set(lockKey, { token, expiresAt: now + ttlMs });
  x402LockAcquiredTotal.inc({ lock_type: "memory" });
  return { acquired: true, token };
}

/**
 * Release a mutual-exclusion lock atomically.
 *
 * @param {string} key - Lock identifier
 * @param {string} token - Lock ownership token
 * @param {object} [opts]
 * @param {object} [opts.redisClient]
 * @returns {Promise<boolean>} True if released, false otherwise
 */
export async function releaseX402Lock(key, token, opts = {}) {
  if (!token) return false;
  const lockKey = `lock:x402:${key}`;
  let released = false;

  // 1. Try Redis compare-and-delete
  try {
    const redis = opts.redisClient || (await connectRedisClient());
    if (redis && redis.isOpen) {
      let res;
      if (typeof redis.sendCommand === "function") {
        res = await redis.sendCommand(["EVAL", RELEASE_LOCK_SCRIPT, "1", lockKey, token]);
      } else if (typeof redis.eval === "function") {
        res = await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [lockKey], arguments: [token] });
      }
      if (res === 1 || res === "1") {
        x402LockReleasedTotal.inc({ lock_type: "redis" });
        released = true;
      }
    }
  } catch (err) {
    logger?.debug?.({ err: err.message }, "x402: redis lock release failed");
  }

  // 2. Local fallback lock release
  const local = localLocks.get(lockKey);
  if (local && local.token === token) {
    localLocks.delete(lockKey);
    x402LockReleasedTotal.inc({ lock_type: "memory" });
    released = true;
  }

  return released;
}

/**
 * Run a callback protected by an atomic x402 lock.
 *
 * @param {string} key
 * @param {Function} fn
 * @param {object} [opts]
 * @returns {Promise<any>}
 */
export async function withX402Lock(key, fn, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const lock = await acquireX402Lock(key, ttlMs, opts);
  if (!lock.acquired) {
    const err = new Error("x402 transaction lock in progress");
    err.code = "X402_TRANSACTION_IN_PROGRESS";
    err.status = 409;
    throw err;
  }

  try {
    return await fn();
  } finally {
    await releaseX402Lock(key, lock.token, opts);
  }
}

// ---------------------------------------------------------------------------
// Dead-Letter Queue (DLQ) & Retry Logic
// ---------------------------------------------------------------------------

export const DEFAULT_DLQ_RETRY_OPTIONS = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 1000,
  maxDlqRetries: 5,
});

export const RETRYABLE_X402_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** In-memory fallback DLQ store: itemId -> DLQ entry */
const memoryDlq = new Map();

/** In-memory token cache fallback: hash -> { payload, expiresAt } */
const memoryTokenCache = new Map();

/**
 * Check if an error is considered transient and safe to retry.
 *
 * @param {Error|any} err
 * @returns {boolean}
 */
export function isRetryableX402Error(err) {
  if (!err) return false;
  if (err.isRetryable === true) return true;
  if (err.code && RETRYABLE_X402_ERROR_CODES.has(err.code)) return true;
  const msg = String(err.message || "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("redis connection") ||
    msg.includes("transient")
  );
}

/**
 * Execute an operation with exponential backoff and jitter.
 *
 * @param {Function} fn - Async operation to execute: (attempt) => Promise<any>
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.baseDelayMs=50]
 * @param {number} [opts.maxDelayMs=1000]
 * @returns {Promise<any>}
 */
export async function executeWithRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_DLQ_RETRY_OPTIONS.maxAttempts;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_DLQ_RETRY_OPTIONS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_DLQ_RETRY_OPTIONS.maxDelayMs;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isRetryableX402Error(err)) {
        throw err;
      }
      const expDelay = Math.min(
        maxDelayMs,
        baseDelayMs * Math.pow(2, attempt - 1)
      );
      const jitter = Math.random() * expDelay;
      await new Promise((resolve) => setTimeout(resolve, jitter));
    }
  }
  throw lastError;
}

/**
 * Enqueue a failed operation into the Dead-Letter Queue.
 *
 * @param {object} item
 * @param {string} item.operationType
 * @param {any} item.payload
 * @param {Error|any} item.error
 * @param {object} [opts]
 * @param {object} [opts.redisClient]
 * @returns {Promise<string>} Dead letter item ID
 */
export async function enqueueDeadLetter(item, opts = {}) {
  const id = item.id || randomUUID();
  const now = Date.now();
  const entry = {
    id,
    operationType: item.operationType || "generic_x402_operation",
    payload: item.payload,
    error: {
      message: item.error?.message || String(item.error),
      code: item.error?.code,
    },
    attempts: 1,
    status: "pending",
    firstFailedAt: now,
    lastFailedAt: now,
    nextRetryAt: now + (opts.baseDelayMs || 500),
  };

  // 1. In-memory store
  memoryDlq.set(id, entry);

  // 2. Redis store if available
  try {
    const redis = opts.redisClient || (await connectRedisClient());
    if (redis && redis.isOpen) {
      await redis.set(`x402:dlq:${id}`, JSON.stringify(entry), { EX: 86400 });
    }
  } catch (err) {
    logger?.debug?.({ err: err.message }, "x402: redis dlq set error, stored in-memory");
  }

  x402DlqEnqueuedTotal.inc({ operation_type: entry.operationType });
  x402DlqSize.set(memoryDlq.size);

  logger?.warn?.(
    { dlqId: id, operationType: entry.operationType, err: entry.error.message },
    "x402: operation routed to dead-letter queue"
  );

  return id;
}

/**
 * Recover pending items from the Dead-Letter Queue.
 *
 * @param {object} opts
 * @param {Function} opts.handler - (entry) => Promise<boolean|void>
 * @param {object} [opts.redisClient]
 * @param {number} [opts.maxBatchSize=10]
 * @param {number} [opts.maxDlqRetries=5]
 * @returns {Promise<{ recovered: number, failed: number, exhausted: number }>}
 */
export async function recoverDeadLetterQueue(opts = {}) {
  const {
    handler,
    redisClient = null,
    maxBatchSize = 10,
    maxDlqRetries = DEFAULT_DLQ_RETRY_OPTIONS.maxDlqRetries,
  } = opts;

  let recovered = 0;
  let failed = 0;
  let exhausted = 0;
  const now = Date.now();

  const entriesToProcess = [];
  for (const entry of memoryDlq.values()) {
    if (entry.status === "pending" && entry.nextRetryAt <= now) {
      entriesToProcess.push(entry);
      if (entriesToProcess.length >= maxBatchSize) break;
    }
  }

  for (const entry of entriesToProcess) {
    try {
      if (handler) {
        await handler(entry);
      }
      // Successful recovery
      entry.status = "recovered";
      memoryDlq.delete(entry.id);

      try {
        const redis = redisClient || (await connectRedisClient());
        if (redis && redis.isOpen) {
          await redis.del(`x402:dlq:${entry.id}`);
        }
      } catch {}

      x402DlqRecoveredTotal.inc({ operation_type: entry.operationType });
      recovered++;
      logger?.info?.({ dlqId: entry.id }, "x402: dlq entry recovered successfully");
    } catch (err) {
      entry.attempts++;
      entry.lastFailedAt = Date.now();
      entry.error = { message: err.message, code: err.code };

      if (entry.attempts >= maxDlqRetries) {
        entry.status = "exhausted";
        x402DlqExhaustedTotal.inc({ operation_type: entry.operationType });
        exhausted++;
        logger?.error?.(
          { dlqId: entry.id, attempts: entry.attempts },
          "x402: dlq entry exceeded max retries, marked as exhausted poison pill"
        );
      } else {
        // Back off exponentially for next recovery
        const backoffMs = Math.min(60000, 1000 * Math.pow(2, entry.attempts));
        entry.nextRetryAt = Date.now() + backoffMs;
        failed++;
      }
    }
  }

  x402DlqSize.set(memoryDlq.size);
  return { recovered, failed, exhausted };
}

/**
 * Get current stats of Dead-Letter Queue.
 *
 * @returns {object}
 */
export function getDeadLetterQueueStats() {
  let pending = 0;
  let exhausted = 0;
  for (const entry of memoryDlq.values()) {
    if (entry.status === "pending") pending++;
    if (entry.status === "exhausted") exhausted++;
  }
  return {
    total: memoryDlq.size,
    pending,
    exhausted,
  };
}

/**
 * Clear the Dead-Letter Queue (for tests or manual cleanup).
 */
export function clearDeadLetterQueue() {
  memoryDlq.clear();
  x402DlqSize.set(0);
}

/**
 * Reset caches, DLQ, locks, and metrics for testing.
 */
export function resetX402CacheForTests() {
  memoryTokenCache.clear();
  clearDeadLetterQueue();
  resetLocalLocksForTests();
}

/**
 * Get internal telemetry summary for diagnostics.
 */
export function getX402Telemetry() {
  return {
    inMemoryCacheSize: memoryTokenCache.size,
    dlqStats: getDeadLetterQueueStats(),
    localLocksCount: localLocks.size,
  };
}

/**
 * Generate a SHA-256 hash for a token to safely use as a cache/lock key.
 *
 * @param {string} token
 * @returns {string} Hex hash string
 */
export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Retrieve cached token payload from Redis or in-memory fallback.
 *
 * @param {string} token
 * @param {object} [opts]
 * @param {object} [opts.redisClient]
 * @returns {Promise<object|null>} Cached payload or null
 */
export async function getCachedToken(token, opts = {}) {
  const tokenHash = hashToken(token);
  const cacheKey = `x402:token_cache:${tokenHash}`;

  // 1. Try Redis cache if client available
  try {
    const redis = opts.redisClient || (await connectRedisClient());
    if (redis && redis.isOpen) {
      const raw = await redis.get(cacheKey);
      if (raw) {
        x402CacheHitsTotal.inc({ cache_type: "redis" });
        return JSON.parse(raw);
      }
    }
  } catch (err) {
    logger?.debug?.({ err: err.message }, "x402: redis get error, falling back to memory cache");
  }

  // 2. Check in-memory fallback cache
  const local = memoryTokenCache.get(tokenHash);
  if (local) {
    if (local.expiresAt > Date.now()) {
      x402CacheHitsTotal.inc({ cache_type: "memory" });
      return local.payload;
    }
    memoryTokenCache.delete(tokenHash);
  }

  x402CacheMissesTotal.inc();
  return null;
}

/**
 * Store verified token payload in Redis and in-memory cache with retry and DLQ resilience.
 *
 * @param {string} token
 * @param {object} payload
 * @param {object} [opts]
 * @param {object} [opts.redisClient]
 * @param {number} [opts.ttlSec]
 */
export async function setCachedToken(token, payload, opts = {}) {
  const tokenHash = hashToken(token);
  const cacheKey = `x402:token_cache:${tokenHash}`;

  let ttl = opts.ttlSec || DEFAULT_TOKEN_CACHE_TTL_SEC;
  if (payload?.exp && typeof payload.exp === "number") {
    const remaining = payload.exp - Math.floor(Date.now() / 1000);
    ttl = Math.max(1, Math.min(remaining, ttl));
  }

  // Set in in-memory fallback cache immediately
  memoryTokenCache.set(tokenHash, {
    payload,
    expiresAt: Date.now() + ttl * 1000,
  });

  // Set in Redis with retry and DLQ fallback
  try {
    await executeWithRetry(async () => {
      const redis = opts.redisClient || (await connectRedisClient());
      if (redis && redis.isOpen) {
        await redis.set(cacheKey, JSON.stringify(payload), { EX: ttl });
      }
    }, { maxAttempts: 2, baseDelayMs: 20 });
  } catch (err) {
    logger?.debug?.({ err: err.message }, "x402: redis set failed after retries, routing to DLQ");
    await enqueueDeadLetter({
      operationType: "cache_token_set",
      payload: { tokenHash, ttl },
      error: err,
    }, opts);
  }
}

/**
 * Validate and sanitize x402 middleware configuration.
 *
 * @param {object} config
 * @returns {object} Sanitized configuration
 */
export function validateX402Config(config) {
  if (!config || typeof config !== "object") {
    throw new TypeError("x402 configuration must be a non-null object");
  }

  const {
    amount,
    recipient,
    asset = "USDC",
    plutoVerifyUrl = `${process.env.PAYMENT_LINK_BASE?.replace(":3000", ":4000") || "http://localhost:4000"}/api/verify-x402`,
    memo_prefix = "x402",
    enforceByDefault = false,
    redisClient = null,
    cacheTtlSec = DEFAULT_TOKEN_CACHE_TTL_SEC,
    dlqOptions = null,
    enableConcurrencyControl = true,
    lockTtlMs = DEFAULT_LOCK_TTL_MS,
  } = config;

  // Validate amount
  if (amount == null || typeof amount !== "string" && typeof amount !== "number") {
    throw new TypeError("x402 config: amount is required and must be a string or number");
  }
  const cleanAmount = String(amount).trim();
  if (
    !POSITIVE_AMOUNT_REGEX.test(cleanAmount) ||
    Number.parseFloat(cleanAmount) <= 0
  ) {
    throw new Error(
      `x402 config: amount must be a positive numeric value, received "${amount}"`
    );
  }

  // Validate recipient
  if (typeof recipient !== "string") {
    throw new TypeError("x402 config: recipient is required and must be a Stellar address string");
  }
  const cleanRecipient = recipient.trim();
  if (!STELLAR_ADDRESS_REGEX.test(cleanRecipient)) {
    throw new Error(
      `x402 config: recipient must be a valid Stellar public key (56 characters starting with G), received "${recipient}"`
    );
  }

  // Validate asset
  if (typeof asset !== "string") {
    throw new TypeError("x402 config: asset must be a string");
  }
  const cleanAsset = asset.trim().toUpperCase();
  if (!ASSET_CODE_REGEX.test(cleanAsset)) {
    throw new Error(
      `x402 config: asset must be 1-12 alphanumeric characters, received "${asset}"`
    );
  }

  // Validate plutoVerifyUrl
  if (typeof plutoVerifyUrl !== "string") {
    throw new TypeError("x402 config: plutoVerifyUrl must be a string URL");
  }
  const cleanVerifyUrl = plutoVerifyUrl.trim();
  try {
    const parsed = new URL(cleanVerifyUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Protocol must be http: or https:");
    }
  } catch (err) {
    throw new Error(
      `x402 config: plutoVerifyUrl must be a valid HTTP/HTTPS URL, received "${plutoVerifyUrl}": ${err.message}`
    );
  }

  // Validate memo_prefix
  if (typeof memo_prefix !== "string") {
    throw new TypeError("x402 config: memo_prefix must be a string");
  }
  const cleanMemoPrefix = memo_prefix.trim();
  if (
    !MEMO_PREFIX_REGEX.test(cleanMemoPrefix) ||
    cleanMemoPrefix.length > MAX_MEMO_PREFIX_LENGTH
  ) {
    throw new Error(
      `x402 config: memo_prefix must be 1-${MAX_MEMO_PREFIX_LENGTH} alphanumeric, hyphen, or underscore characters, received "${memo_prefix}"`
    );
  }

  return {
    amount: cleanAmount,
    recipient: cleanRecipient,
    asset: cleanAsset,
    plutoVerifyUrl: cleanVerifyUrl,
    memo_prefix: cleanMemoPrefix,
    enforceByDefault: Boolean(enforceByDefault),
    redisClient,
    cacheTtlSec: Number.isFinite(cacheTtlSec) && cacheTtlSec > 0 ? cacheTtlSec : DEFAULT_TOKEN_CACHE_TTL_SEC,
    dlqOptions: dlqOptions || DEFAULT_DLQ_RETRY_OPTIONS,
    enableConcurrencyControl: Boolean(enableConcurrencyControl),
    lockTtlMs: Number.isFinite(lockTtlMs) && lockTtlMs > 0 ? lockTtlMs : DEFAULT_LOCK_TTL_MS,
  };
}

/**
 * Sanitize pricing mode string against whitelist and control characters.
 *
 * @param {unknown} mode
 * @returns {string|null} Sanitized mode or null if invalid/unrecognized
 */
export function sanitizePricingMode(mode) {
  if (typeof mode !== "string") return null;
  const cleaned = mode.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return ALLOWED_PRICING_MODES.has(cleaned) ? cleaned : null;
}

/**
 * Sanitize and validate payment token string.
 *
 * @param {unknown} token
 * @returns {string|null} Trimmed token if format is valid, null otherwise
 */
export function sanitizePaymentToken(token) {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  if (!JWT_FORMAT_REGEX.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Generate a bounded Stellar memo conforming to the 28-byte UTF-8 limit.
 *
 * @param {string} prefix
 * @param {string} requestId
 * @returns {string} Safe Stellar memo string
 */
export function generatePaymentMemo(prefix, requestId) {
  const separator = "-";
  const maxMemoBytes = 28;
  const minIdBytes = 4;

  let memoPrefix = String(prefix || "x402").replace(/[^A-Za-z0-9_-]/g, "");
  if (!memoPrefix) memoPrefix = "x402";

  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const maxPrefixBytes = Math.max(1, maxMemoBytes - separatorBytes - minIdBytes);

  while (Buffer.byteLength(memoPrefix, "utf8") > maxPrefixBytes) {
    memoPrefix = memoPrefix.slice(0, -1);
  }

  const prefixBytes = Buffer.byteLength(memoPrefix, "utf8");
  const maxIdBytes = Math.max(minIdBytes, maxMemoBytes - prefixBytes - separatorBytes);
  const cleanId = String(requestId).replace(/[^A-Za-z0-9]/g, "");
  const idPart = cleanId.slice(0, maxIdBytes);

  return `${memoPrefix}${separator}${idPart}`;
}

/**
 * Create x402 middleware with comprehensive input validation, distributed Redis caching,
 * throughput telemetry, automated DLQ recovery, and atomic concurrency control.
 *
 * @param {object} config
 * @param {string} config.amount          - USDC amount required (e.g. "0.01")
 * @param {string} config.recipient       - Provider's Stellar address (G...)
 * @param {string} [config.asset]         - Asset code, defaults to "USDC"
 * @param {string} [config.plutoVerifyUrl] - URL of /api/verify-x402
 * @param {string} [config.memo_prefix]   - Memo prefix, defaults to "x402"
 * @param {boolean} [config.enforceByDefault] - If true, always challenge when token is absent
 * @param {object} [config.redisClient]   - Injected Redis client
 * @param {number} [config.cacheTtlSec]   - TTL for cached tokens in seconds
 * @param {object} [config.dlqOptions]    - DLQ retry and recovery configuration
 * @param {boolean} [config.enableConcurrencyControl=true] - Enable distributed concurrency lock
 * @param {number} [config.lockTtlMs=10000] - Lock TTL in ms
 */
export function x402Middleware(config) {
  const validatedConfig = validateX402Config(config);
  const {
    amount,
    recipient,
    asset,
    plutoVerifyUrl,
    memo_prefix,
    enforceByDefault,
    redisClient,
    cacheTtlSec,
    enableConcurrencyControl,
    lockTtlMs,
  } = validatedConfig;

  const jwtSecret = process.env.X402_JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("X402_JWT_SECRET env variable is required for x402 middleware");
  }

  return async function requirePayment(req, res, next) {
    const startTime = process.hrtime.bigint();

    // 1. Sanitize payment token
    const rawToken = req.headers["x-payment-token"];
    let token = null;

    if (rawToken !== undefined) {
      token = sanitizePaymentToken(rawToken);
      if (rawToken && !token) {
        logger?.warn?.(
          { rawTokenSnippet: String(rawToken).slice(0, 16) },
          "x402: malformed or oversized X-Payment-Token rejected during sanitization"
        );
      }
    }

    // 2. Sanitize and validate pricing mode from header and query
    const modeHeader = sanitizePricingMode(req.headers["x-pluto-pricing-mode"]);
    const modeQuery = sanitizePricingMode(req.query?.pricing_mode);
    const resolvedMode = modeHeader || modeQuery || "default";
    const requestedX402 = resolvedMode === "x402";

    // 3. Process sanitized payment token with concurrency control & distributed caching
    if (token) {
      let lockResult = null;
      const tokenHash = hashToken(token);

      // Concurrency lock to prevent simultaneous execution with the same token
      if (enableConcurrencyControl) {
        lockResult = await acquireX402Lock(tokenHash, lockTtlMs, { redisClient });
        if (!lockResult.acquired) {
          x402LockContentionTotal.inc({ asset });
          return res.status(409).json({
            error: "x402 transaction in progress",
            code: "X402_TRANSACTION_IN_PROGRESS",
            retryAfter: 1,
          });
        }

        // Ensure lock release on response completion or abort
        let released = false;
        const releaseLockOnce = () => {
          if (released) return;
          released = true;
          releaseX402Lock(tokenHash, lockResult.token, { redisClient }).catch(() => {});
        };
        res.once("finish", releaseLockOnce);
        res.once("close", releaseLockOnce);
      }

      // Check cache first
      let cachedPayload = null;
      try {
        cachedPayload = await getCachedToken(token, { redisClient });
      } catch (err) {
        logger?.debug?.({ err: err.message }, "x402: cache lookup error");
      }

      if (cachedPayload) {
        const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
        x402VerificationDuration.observe({ cache_status: "hit" }, durationSec);
        x402RequestsTotal.inc({ status: "verified_cache", mode: resolvedMode, asset });

        req.x402 = cachedPayload;
        return next();
      }

      // Fresh verification on cache miss
      try {
        const payload = jwt.verify(token, jwtSecret);
        await setCachedToken(token, payload, { redisClient, ttlSec: cacheTtlSec });

        const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
        x402VerificationDuration.observe({ cache_status: "miss" }, durationSec);
        x402RequestsTotal.inc({ status: "verified_fresh", mode: resolvedMode, asset });

        req.x402 = payload;
        return next();
      } catch (err) {
        logger?.debug?.(
          { err: err.message },
          "x402: payment token verification failed or expired"
        );
        x402RequestsTotal.inc({ status: "invalid_token", mode: resolvedMode, asset });
        // Token invalid or expired — fall through to 402 challenge
      }
    }

    // Dual-mode behavior:
    // - Subscription/API-key mode: pass through
    // - x402 mode: challenge with 402
    if (!enforceByDefault && !requestedX402) {
      x402RequestsTotal.inc({ status: "passed_through", mode: resolvedMode, asset });
      return next();
    }

    // 4. Generate sanitized memo and challenge
    const requestId = randomUUID().replace(/-/g, "");
    const memo = generatePaymentMemo(memo_prefix, requestId);

    x402ActiveChallenges.inc();
    x402RequestsTotal.inc({ status: "challenged", mode: resolvedMode, asset });

    return res.status(402).json({
      x402: true,
      error: "Payment required",
      amount,
      asset,
      network: "stellar-testnet",
      recipient,
      asset_issuer: USDC_ISSUER,
      memo,
      verify_url: plutoVerifyUrl,
      instructions: `Send exactly ${amount} ${asset} to ${recipient} with memo "${memo}", then POST { tx_hash, expected_amount, expected_recipient, memo } to ${plutoVerifyUrl} to receive an access token, then retry this request with header X-Payment-Token: <token>`,
    });
  };
}
