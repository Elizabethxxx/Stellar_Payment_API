/**
 * websocket-relay-lock.js
 *
 * Distributed concurrency control for the WebSocket Relay Service
 * (issue #1455).
 *
 * Problem
 * -------
 * Several relay instances run side by side. Without coordination they can:
 *   - deliver the same relay event twice (two instances pick it up after a
 *     reconnect or a DLQ replay),
 *   - drain the dead letter queue concurrently and re-send every entry once
 *     per instance,
 *   - stampede the upstream on reconnect, because every caller inside one
 *     process starts its own reconnect loop.
 *
 * Solution
 * --------
 *   - Redis lease:  SET <key> <token> NX PX <ttl>  — atomic acquire across
 *     instances.
 *   - Owner-only release and renewal: compare-and-delete / compare-and-pexpire
 *     Lua scripts, so an instance can never release or extend a lease that
 *     expired and was re-acquired by someone else.
 *   - Heartbeat renewal while the critical section runs. If renewal fails the
 *     lease is treated as lost and the work is told to stop via AbortSignal,
 *     instead of silently continuing without mutual exclusion.
 *   - Bounded waiting with jittered polling (no unbounded spin, no herd).
 *   - In-process fallback when Redis is unavailable, so a single instance
 *     stays correct instead of failing open.
 *   - Single-flight: concurrent callers inside one process share one
 *     in-flight promise per key (used for reconnects).
 *
 * Keys are namespaced by an allow-listed scope and the caller-supplied
 * resource id is SHA-256 hashed, so it cannot inject Redis key separators or
 * create unbounded key sizes.
 */

import { createHash, randomUUID } from "node:crypto";
import { connectRedisClient } from "./redis.js";
import { logger } from "./logger.js";
import {
  relayLockAcquisitionsTotal,
  relayLockHoldDuration,
  relayLockLostTotal,
  relayLockWaitDuration,
} from "./websocket-relay-metrics.js";

export const DEFAULT_RELAY_LOCK_TTL_MS = 15_000;
const MIN_RELAY_LOCK_TTL_MS = 1_000;
const MAX_RELAY_LOCK_TTL_MS = 120_000;
const MAX_WAIT_MS = 30_000;
const DEFAULT_RETRY_INTERVAL_MS = 100;
const MAX_RESOURCE_LENGTH = 512;
const LOCK_KEY_PREFIX = "lock:ws-relay";

/** Scopes the relay is allowed to lock. Anything else is rejected. */
export const RelayLockScope = Object.freeze({
  EVENT: "event",
  DLQ_DRAIN: "dlq-drain",
  RECONNECT: "reconnect",
  CONNECTION: "connection",
});

const VALID_SCOPES = new Set(Object.values(RelayLockScope));

/** Error code for work rejected because another holder owns the lock. */
export const RELAY_LOCK_BUSY = "RELAY_LOCK_BUSY";
/** Error code raised to the critical section when its lease was lost. */
export const RELAY_LOCK_LOST = "RELAY_LOCK_LOST";

export const RELEASE_RELAY_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export const RENEW_RELAY_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

/** In-process fallback: key -> { token, expiresAt } */
const localLocks = new Map();

export function resolveRelayLockTtlMs(value, env = process.env) {
  const raw = Number(value ?? env.WS_RELAY_LOCK_TTL_MS);
  if (!Number.isFinite(raw)) return DEFAULT_RELAY_LOCK_TTL_MS;
  return Math.min(Math.max(Math.trunc(raw), MIN_RELAY_LOCK_TTL_MS), MAX_RELAY_LOCK_TTL_MS);
}

function resolveWaitMs(value) {
  const raw = Number(value ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.trunc(raw), MAX_WAIT_MS);
}

/**
 * Build an injection-safe lock key.
 *
 * @param {string} scope     One of RelayLockScope
 * @param {string} resource  Event id, connection id, upstream URL, ...
 */
export function buildRelayLockKey(scope, resource) {
  if (!VALID_SCOPES.has(scope)) {
    throw new TypeError(`Unknown relay lock scope: ${String(scope).slice(0, 32)}`);
  }
  if (typeof resource !== "string" || resource.trim() === "") {
    throw new TypeError("resource is required to build a relay lock key");
  }
  if (resource.length > MAX_RESOURCE_LENGTH) {
    throw new RangeError(`resource must be at most ${MAX_RESOURCE_LENGTH} characters`);
  }
  const digest = createHash("sha256").update(resource).digest("hex");
  return `${LOCK_KEY_PREFIX}:${scope}:${digest}`;
}

function scopeFromKey(key) {
  return String(key).split(":")[2] ?? "unknown";
}

function acquireLocal(key, token, ttlMs, now = Date.now()) {
  const existing = localLocks.get(key);
  if (existing && existing.expiresAt > now) return false;
  localLocks.set(key, { token, expiresAt: now + ttlMs });
  return true;
}

function releaseLocal(key, token) {
  const existing = localLocks.get(key);
  if (existing && existing.token === token) {
    localLocks.delete(key);
    return true;
  }
  return false;
}

function renewLocal(key, token, ttlMs, now = Date.now()) {
  const existing = localLocks.get(key);
  if (!existing || existing.token !== token || existing.expiresAt <= now) return false;
  existing.expiresAt = now + ttlMs;
  return true;
}

async function resolveRedis(getRedis) {
  try {
    const client = await getRedis();
    // connectRedisClient() returns a no-op client (isOpen:false) when Redis is
    // unreachable. Its SET reports success for everyone, so it must not be
    // trusted as a distributed lock backend.
    if (!client || client.isOpen === false || typeof client.sendCommand !== "function") {
      return null;
    }
    return client;
  } catch (err) {
    logger.warn({ err: err?.message }, "WebSocket relay lock: Redis unavailable, using local lock");
    return null;
  }
}

function buildLease({ key, token, ttl, backend, client }) {
  const scope = scopeFromKey(key);
  return {
    key,
    token,
    backend,
    ttlMs: ttl,
    acquiredAt: Date.now(),
    async renew() {
      if (backend === "local") return renewLocal(key, token, ttl);
      try {
        const renewed = await client.sendCommand([
          "EVAL",
          RENEW_RELAY_LOCK_SCRIPT,
          "1",
          key,
          token,
          String(ttl),
        ]);
        return Number(renewed) === 1;
      } catch (err) {
        logger.error({ err: err?.message, scope }, "WebSocket relay lock renewal failed");
        return false;
      }
    },
    async release() {
      if (backend === "local") return releaseLocal(key, token);
      try {
        const released = await client.sendCommand(["EVAL", RELEASE_RELAY_LOCK_SCRIPT, "1", key, token]);
        if (Number(released) !== 1) {
          logger.warn({ scope, ttlMs: ttl }, "WebSocket relay lock expired before release");
          return false;
        }
        return true;
      } catch (err) {
        // The lease still expires via PX, so a failed release is not fatal.
        logger.error({ err: err?.message, scope }, "WebSocket relay lock release failed");
        return false;
      }
    },
  };
}

/**
 * Try once to acquire a relay lock.
 *
 * @param {string} key  From buildRelayLockKey()
 * @param {object} [options]
 * @param {number} [options.ttlMs]
 * @param {() => Promise<object>} [options.getRedis]  Injected for tests
 * @returns {Promise<null | { key, token, backend, ttlMs, acquiredAt, renew, release }>}
 *   `null` when another holder currently owns the lock.
 */
export async function tryAcquireRelayLock(key, { ttlMs, getRedis = connectRedisClient } = {}) {
  const ttl = resolveRelayLockTtlMs(ttlMs);
  const token = randomUUID();
  const scope = scopeFromKey(key);
  const client = await resolveRedis(getRedis);

  if (client) {
    try {
      const reply = await client.sendCommand(["SET", key, token, "NX", "PX", String(ttl)]);
      if (reply !== "OK") {
        relayLockAcquisitionsTotal.inc({ scope, result: "contended" });
        return null;
      }
      relayLockAcquisitionsTotal.inc({ scope, result: "acquired" });
      return buildLease({ key, token, ttl, backend: "redis", client });
    } catch (err) {
      relayLockAcquisitionsTotal.inc({ scope, result: "error" });
      logger.warn(
        { err: err?.message, scope },
        "WebSocket relay lock: Redis SET NX failed, falling back to local lock",
      );
    }
  }

  if (!acquireLocal(key, token, ttl)) {
    relayLockAcquisitionsTotal.inc({ scope, result: "contended" });
    return null;
  }
  relayLockAcquisitionsTotal.inc({ scope, result: "acquired" });
  return buildLease({ key, token, ttl, backend: "local" });
}

/**
 * Acquire a relay lock, waiting up to `waitMs` with jittered polling.
 *
 * @returns {Promise<object|null>} The lease, or null when still busy after waitMs.
 */
export async function acquireRelayLock(
  key,
  {
    waitMs,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    ...options
  } = {},
) {
  const budget = resolveWaitMs(waitMs);
  const interval = Math.max(10, Math.trunc(Number(retryIntervalMs) || DEFAULT_RETRY_INTERVAL_MS));
  const startedAt = now();
  const scope = scopeFromKey(key);

  for (;;) {
    const lease = await tryAcquireRelayLock(key, options);
    const elapsed = now() - startedAt;
    if (lease || elapsed >= budget) {
      relayLockWaitDuration.observe({ scope }, elapsed / 1000);
      return lease;
    }
    // ±25% jitter so waiting instances do not retry in lockstep.
    const jittered = Math.round(interval * (0.75 + Math.random() * 0.5));
    await sleep(Math.min(jittered, Math.max(0, budget - elapsed)));
  }
}

export function createRelayLockBusyError(scope) {
  const error = new Error(`WebSocket relay ${scope} is already being processed by another worker.`);
  error.status = 409;
  error.code = RELAY_LOCK_BUSY;
  error.retryable = true;
  return error;
}

function createRelayLockLostError(scope) {
  const error = new Error(`WebSocket relay ${scope} lock was lost before the work completed.`);
  error.code = RELAY_LOCK_LOST;
  error.retryable = true;
  return error;
}

/**
 * Run `fn` while holding the relay lock for (scope, resource).
 *
 * The lease is renewed every `renewIntervalMs` (default ttl/3). If a renewal
 * fails, the AbortSignal passed to `fn` is aborted with a RELAY_LOCK_LOST
 * error; long-running work (e.g. a DLQ drain) must check `signal.aborted`
 * between units of work.
 *
 * @template T
 * @param {string} scope     One of RelayLockScope
 * @param {string} resource
 * @param {(ctx: { lease: object, signal: AbortSignal }) => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.ttlMs]
 * @param {number} [options.waitMs=0]       How long to wait for a busy lock
 * @param {number} [options.renewIntervalMs]
 * @returns {Promise<T>}
 * @throws 409 error (code RELAY_LOCK_BUSY) when the lock stays held
 */
export async function withRelayLock(scope, resource, fn, options = {}) {
  if (typeof fn !== "function") {
    throw new TypeError("withRelayLock requires a function to run");
  }
  const key = buildRelayLockKey(scope, resource);
  const lease = await acquireRelayLock(key, options);
  if (!lease) {
    logger.warn({ scope }, "WebSocket relay work rejected: lock held by another worker");
    throw createRelayLockBusyError(scope);
  }

  const controller = new AbortController();
  const renewEvery = Math.max(
    250,
    Math.trunc(Number(options.renewIntervalMs) || lease.ttlMs / 3),
  );
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    try {
      const ok = await lease.renew();
      if (!ok && !controller.signal.aborted) {
        relayLockLostTotal.inc({ scope });
        logger.error({ scope, backend: lease.backend }, "WebSocket relay lock lost during work");
        controller.abort(createRelayLockLostError(scope));
      }
    } finally {
      renewing = false;
    }
  }, renewEvery);
  timer.unref?.();

  try {
    return await fn({ lease, signal: controller.signal });
  } finally {
    clearInterval(timer);
    const heldMs = Date.now() - lease.acquiredAt;
    relayLockHoldDuration.observe({ scope }, heldMs / 1000);
    await lease.release();
    logger.debug?.({ scope, backend: lease.backend, heldMs }, "WebSocket relay lock released");
  }
}

/**
 * In-process single-flight: concurrent calls with the same key share one
 * in-flight promise. Used so that many sockets noticing the same upstream
 * drop trigger exactly one reconnect loop per process.
 */
export function createSingleFlight() {
  const inFlight = new Map();
  return {
    run(key, fn) {
      if (inFlight.has(key)) return inFlight.get(key);
      const promise = Promise.resolve()
        .then(fn)
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },
    has(key) {
      return inFlight.has(key);
    },
    get size() {
      return inFlight.size;
    },
  };
}

/** Test helper: clear the in-process fallback lock table. */
export function resetLocalRelayLocksForTests() {
  localLocks.clear();
}
