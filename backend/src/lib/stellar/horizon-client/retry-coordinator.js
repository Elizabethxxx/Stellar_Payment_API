/**
 * Horizon Retry Coordinator - distributed concurrency control (issue #1440)
 *
 * Problem
 * -------
 * Every API instance runs its own Retry Manager. When Horizon degrades (5xx,
 * timeouts) or throttles (429), every pending call on every instance retries
 * on its own schedule. N instances x M callers turn one Horizon hiccup into a
 * retry storm that keeps Horizon throttling us.
 *
 * Solution
 * --------
 * Two shared primitives, both keyed per Horizon host and per operation:
 *
 *   1. Retry slots (distributed semaphore)
 *      `<prefix>slot:<host>:<operation>:<i>` for i in [0, maxConcurrentRetries)
 *      A caller may only retry while holding a slot. Acquire is
 *      SET <slot> <token> NX PX <lease>; release is a compare-and-delete Lua
 *      script, so a caller can never free a slot that expired and was taken by
 *      someone else. When every slot is busy the retry is skipped and the
 *      original error is returned - load shedding instead of amplification.
 *
 *   2. Rate-limit cooldown
 *      `<prefix>cooldown:<host>` holds the epoch (ms) until which Horizon asked
 *      us to back off (Retry-After on a 429). Every instance waits it out
 *      before its next attempt instead of each discovering the 429 itself.
 *
 * Failure policy: FAIL OPEN to an in-process implementation of the same two
 * primitives. Horizon reads are idempotent, so losing cross-instance
 * coordination only costs efficiency, never correctness. A no-op/closed Redis
 * client (connectRedisClient() returns one when Redis is down) is treated as
 * "no Redis", because its SET would report success to every caller.
 *
 * Keys never contain caller input: the host is SHA-256 hashed and the
 * operation name is restricted to [A-Za-z0-9_] (anything else becomes
 * "unknown"), so keys cannot be injected or grow without bound.
 */

import { createHash, randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import {
  CONCURRENCY_LIMITS,
  DEFAULT_RETRY_COORDINATION_OPTIONS,
} from "./constants.js";

/** Compare-and-delete: only the token holder may release the slot. */
export const RELEASE_SLOT_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const OPERATION_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export function resolveCoordinationOptions(options = {}, env = process.env) {
  return Object.freeze({
    maxConcurrentRetries: clampInt(
      options.maxConcurrentRetries ?? env.HORIZON_RETRY_MAX_CONCURRENT_RETRIES,
      DEFAULT_RETRY_COORDINATION_OPTIONS.maxConcurrentRetries,
      1,
      CONCURRENCY_LIMITS.maxConcurrentRetries,
    ),
    retrySlotLeaseMs: clampInt(
      options.retrySlotLeaseMs ?? env.HORIZON_RETRY_SLOT_LEASE_MS,
      DEFAULT_RETRY_COORDINATION_OPTIONS.retrySlotLeaseMs,
      1_000,
      CONCURRENCY_LIMITS.retrySlotLeaseMs,
    ),
    maxCooldownMs: clampInt(
      options.maxCooldownMs ?? env.HORIZON_RETRY_MAX_COOLDOWN_MS,
      DEFAULT_RETRY_COORDINATION_OPTIONS.maxCooldownMs,
      0,
      CONCURRENCY_LIMITS.maxCooldownMs,
    ),
    keyPrefix:
      typeof options.keyPrefix === "string" && /^[A-Za-z0-9:_-]{1,64}$/.test(options.keyPrefix)
        ? options.keyPrefix
        : DEFAULT_RETRY_COORDINATION_OPTIONS.keyPrefix,
  });
}

/** Restrict operation names to a safe, bounded alphabet. */
export function sanitizeOperationName(operation) {
  return typeof operation === "string" && OPERATION_NAME_PATTERN.test(operation)
    ? operation
    : "unknown";
}

/** Stable, injection-safe identifier for a Horizon host. */
export function hashHorizonScope(horizonUrl) {
  return createHash("sha256")
    .update(String(horizonUrl ?? "default"))
    .digest("hex")
    .slice(0, 16);
}

function isUsableRedis(client) {
  return Boolean(client) && client.isOpen !== false && typeof client.sendCommand === "function";
}

/**
 * Process-wide Redis client used by coordinators that were not given one
 * explicitly. The shared HorizonClient is created at import time, before
 * Redis is connected, so it resolves the client lazily through this slot.
 */
let sharedRedisClient = null;

/**
 * Enable cross-instance Horizon retry coordination. Call once at startup with
 * a connected Redis client; a missing or closed client keeps every
 * coordinator on its in-process fallback.
 *
 * @param {{ redisClient?: object|null }} [opts]
 * @returns {boolean} whether distributed coordination is active
 */
export function configureHorizonRetryCoordination({ redisClient = null } = {}) {
  sharedRedisClient = isUsableRedis(redisClient) ? redisClient : null;
  if (sharedRedisClient) {
    logger.info("Horizon retry manager distributed coordination enabled");
  }
  return Boolean(sharedRedisClient);
}

/** Disable cross-instance coordination (test isolation / shutdown). */
export function resetHorizonRetryCoordination() {
  sharedRedisClient = null;
}

export class HorizonRetryCoordinator {
  /**
   * @param {object} [options]
   * @param {object|null} [options.redisClient] node-redis client exposing sendCommand
   * @param {string} [options.horizonUrl] scopes keys per Horizon host
   * @param {number} [options.maxConcurrentRetries]
   * @param {number} [options.retrySlotLeaseMs]
   * @param {number} [options.maxCooldownMs]
   * @param {string} [options.keyPrefix]
   * @param {() => number} [options.now] injectable clock for tests
   */
  constructor({ redisClient, horizonUrl = "default", now = Date.now, ...options } = {}) {
    const resolved = resolveCoordinationOptions(options);
    this.maxConcurrentRetries = resolved.maxConcurrentRetries;
    this.retrySlotLeaseMs = resolved.retrySlotLeaseMs;
    this.maxCooldownMs = resolved.maxCooldownMs;
    this.scope = hashHorizonScope(horizonUrl);
    this.slotPrefix = `${resolved.keyPrefix}slot:${this.scope}:`;
    this.cooldownKey = `${resolved.keyPrefix}cooldown:${this.scope}`;
    // `undefined` means "use the process-wide client"; `null` forces local.
    this.explicitRedis = redisClient;
    this.now = now;

    /** In-process fallback state. */
    this.localSlots = new Map(); // operation -> Set<token>
    this.localCooldownUntil = 0;
    this.stats = { granted: 0, denied: 0, fallbacks: 0 };
  }

  /** The Redis client to coordinate through, or null for local mode. */
  get redis() {
    const client = this.explicitRedis === undefined ? sharedRedisClient : this.explicitRedis;
    return isUsableRedis(client) ? client : null;
  }

  /** "redis" when cross-instance coordination is active, else "local". */
  get backend() {
    return this.redis ? "redis" : "local";
  }

  _fallback(err, action) {
    this.stats.fallbacks += 1;
    logger.warn(
      { err: err?.message, action },
      "Horizon retry coordination: Redis unavailable, using in-process fallback",
    );
  }

  /* ------------------------------------------------------------------ */
  /* Retry slots                                                         */
  /* ------------------------------------------------------------------ */

  _acquireLocalSlot(operation) {
    let held = this.localSlots.get(operation);
    if (!held) {
      held = new Set();
      this.localSlots.set(operation, held);
    }
    if (held.size >= this.maxConcurrentRetries) return null;
    const token = randomUUID();
    held.add(token);
    return {
      backend: "local",
      release: async () => {
        const removed = held.delete(token);
        if (held.size === 0) this.localSlots.delete(operation);
        return removed;
      },
    };
  }

  /**
   * Try to reserve the right to retry `operation` once, without waiting.
   *
   * @param {string} operation
   * @param {object} [opts]
   * @param {number} [opts.leaseMs] safety TTL for the slot
   * @returns {Promise<null | { backend: "redis"|"local", release: () => Promise<boolean> }>}
   *   null when every retry slot is taken
   */
  async acquireRetrySlot(operation, { leaseMs } = {}) {
    const op = sanitizeOperationName(operation);
    const lease = clampInt(leaseMs, this.retrySlotLeaseMs, 1_000, CONCURRENCY_LIMITS.retrySlotLeaseMs);

    const redis = this.redis;
    if (redis) {
      try {
        const token = randomUUID();
        // Start at a random slot so callers do not all contend on slot 0.
        const offset = Math.floor(Math.random() * this.maxConcurrentRetries);
        for (let i = 0; i < this.maxConcurrentRetries; i += 1) {
          const key = `${this.slotPrefix}${op}:${(offset + i) % this.maxConcurrentRetries}`;
          const reply = await redis.sendCommand(["SET", key, token, "NX", "PX", String(lease)]);
          if (reply === "OK") {
            this.stats.granted += 1;
            return {
              backend: "redis",
              release: async () => {
                try {
                  const released = await redis.sendCommand([
                    "EVAL", RELEASE_SLOT_SCRIPT, "1", key, token,
                  ]);
                  return Number(released) === 1;
                } catch (err) {
                  // The PX lease frees the slot on its own.
                  logger.warn({ err: err?.message }, "Horizon retry slot release failed");
                  return false;
                }
              },
            };
          }
        }
        this.stats.denied += 1;
        return null;
      } catch (err) {
        this._fallback(err, "acquire_retry_slot");
      }
    }

    const slot = this._acquireLocalSlot(op);
    this.stats[slot ? "granted" : "denied"] += 1;
    return slot;
  }

  /* ------------------------------------------------------------------ */
  /* Rate-limit cooldown                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Publish a cooldown so every instance waits before its next attempt.
   * Only ever extends an existing cooldown, and is capped at maxCooldownMs so
   * a hostile or broken Retry-After cannot stall the cluster.
   *
   * @param {number} durationMs
   * @returns {Promise<number>} the cooldown actually applied (ms)
   */
  async recordCooldown(durationMs) {
    const ms = clampInt(durationMs, 0, 0, this.maxCooldownMs);
    if (ms <= 0) return 0;
    const until = this.now() + ms;
    this.localCooldownUntil = Math.max(this.localCooldownUntil, until);

    const redis = this.redis;
    if (redis) {
      try {
        const current = Number(await redis.sendCommand(["GET", this.cooldownKey]));
        if (!Number.isFinite(current) || current < until) {
          await redis.sendCommand(["SET", this.cooldownKey, String(until), "PX", String(ms)]);
        }
      } catch (err) {
        this._fallback(err, "record_cooldown");
      }
    }
    return ms;
  }

  /**
   * Remaining cooldown in ms (0 when none). Never larger than maxCooldownMs,
   * even if Redis holds a corrupted or far-future value.
   */
  async getCooldownRemainingMs() {
    let until = this.localCooldownUntil;

    const redis = this.redis;
    if (redis) {
      try {
        const raw = await redis.sendCommand(["GET", this.cooldownKey]);
        const shared = Number(raw);
        if (raw !== null && raw !== undefined && Number.isFinite(shared)) {
          until = Math.max(until, shared);
        }
      } catch (err) {
        this._fallback(err, "read_cooldown");
      }
    }

    const remaining = until - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return 0;
    return Math.min(Math.ceil(remaining), this.maxCooldownMs);
  }

  getConfig() {
    return {
      backend: this.backend,
      maxConcurrentRetries: this.maxConcurrentRetries,
      retrySlotLeaseMs: this.retrySlotLeaseMs,
      maxCooldownMs: this.maxCooldownMs,
      stats: { ...this.stats },
    };
  }
}
