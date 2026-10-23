/**
 * Distributed concurrency control for the Log Retention & Archival Service
 * (issue #1475).
 *
 * Problem
 * -------
 * The webhook log purge can be started from several places at once: the
 * `npm run purge:webhook-logs` cron on more than one host, the optional
 * in-server schedule on every API instance (LOG_RETENTION_PURGE_CRON), or an
 * operator running it by hand. Concurrent purges race on the same rows, hold
 * row locks against each other, multiply load on the primary and make the
 * duration alert fire for the wrong reason.
 *
 * Solution
 * --------
 * 1. In-process single flight: a second call on the same pool while one is
 *    running is skipped without touching the database.
 * 2. Cross-instance: a PostgreSQL session advisory lock,
 *    `pg_try_advisory_lock(hashtext(<key>))`, taken on a dedicated pooled
 *    connection. It never waits: a contended lock means another instance is
 *    already purging, so this run is skipped (not failed).
 *    Postgres releases a session lock automatically when the connection
 *    closes, so a crashed or killed purge can never leave the lock stuck.
 * 3. The delete batches also use `FOR UPDATE SKIP LOCKED` (log-retention.js),
 *    so even an unlocked caller never blocks on, or double-deletes, rows a
 *    running purge already holds.
 *
 * The lock key is a fixed server-side constant per table, never input.
 */

import { logger } from './logger.js';
import { recordLogRetentionLock } from './log-retention-telemetry.js';
import { withLogRetentionRetry } from './log-retention-retry.js';

export const LOG_RETENTION_LOCK_PREFIX = 'stellar-payment-api:log-retention';

const ACQUIRE_SQL = 'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired';
const RELEASE_SQL = 'SELECT pg_advisory_unlock(hashtext($1)) AS released';

/**
 * pool -> keys held (or being acquired) by a run in this process. Keyed by
 * pool so two pools in one process (as in the multi-instance stress tests)
 * behave like two instances and contend on the database lock instead.
 */
let inProcess = new WeakMap();

function heldKeys(pool) {
  let keys = inProcess.get(pool);
  if (!keys) {
    keys = new Set();
    inProcess.set(pool, keys);
  }
  return keys;
}

/** @param {string} tableName */
export function buildLogRetentionLockKey(tableName) {
  if (!tableName || typeof tableName !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(tableName)) {
    throw new TypeError('tableName must be a plain lower-case SQL identifier');
  }
  return `${LOG_RETENTION_LOCK_PREFIX}:${tableName}`;
}

/** Test-only: forget in-process holders. */
export function resetLogRetentionLocks() {
  inProcess = new WeakMap();
}

/**
 * Try to take the purge lock without waiting.
 *
 * @param {object} pool  pg Pool (uses pool.connect()) or a single client
 * @param {string} key   From buildLogRetentionLockKey()
 * @param {object} [retryOptions]  Passed to withLogRetentionRetry
 * @returns {Promise<null | {key:string, release:() => Promise<boolean>}>}
 *   `null` when another run (this process or another instance) holds it.
 */
export async function acquireLogRetentionLock(pool, key, retryOptions = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('A pg pool/client is required to acquire the log retention lock.');
  }

  const held = heldKeys(pool);
  if (held.has(key)) {
    recordLogRetentionLock('contended');
    return null;
  }
  held.add(key);

  let client = null;
  let ownsClient = false;
  try {
    if (typeof pool.connect === 'function') {
      client = await withLogRetentionRetry(() => pool.connect(), {
        ...retryOptions,
        label: 'log-retention-lock-connect',
      });
      ownsClient = true;
    } else {
      client = pool;
    }

    const result = await withLogRetentionRetry(() => client.query(ACQUIRE_SQL, [key]), {
      ...retryOptions,
      label: 'log-retention-lock-acquire',
    });
    const acquired = result?.rows?.[0]?.acquired === true;

    if (!acquired) {
      recordLogRetentionLock('contended');
      if (ownsClient) client.release();
      held.delete(key);
      return null;
    }

    recordLogRetentionLock('acquired');
    let released = false;
    return {
      key,
      release: async () => {
        if (released) return false;
        released = true;
        try {
          const res = await client.query(RELEASE_SQL, [key]);
          const ok = res?.rows?.[0]?.released === true;
          if (!ok) {
            logger.warn({ key }, 'Log retention lock was not held at release');
          }
          if (ownsClient) client.release();
          return ok;
        } catch (err) {
          // Destroy the connection instead of returning it to the pool: the
          // server then drops the session lock with it.
          logger.error({ err: err?.message, key }, 'Log retention lock release failed');
          if (ownsClient) client.release(err instanceof Error ? err : true);
          return false;
        } finally {
          held.delete(key);
        }
      },
    };
  } catch (err) {
    recordLogRetentionLock('error');
    if (ownsClient && client) client.release(err instanceof Error ? err : true);
    held.delete(key);
    throw err;
  }
}

/**
 * Run `fn` while holding the purge lock. Returns `{ skipped: true }` without
 * calling `fn` when the lock is held elsewhere.
 *
 * @template T
 * @param {object} pool
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @param {object} [retryOptions]
 * @returns {Promise<{skipped:true} | {skipped:false, result:T}>}
 */
export async function withLogRetentionLock(pool, key, fn, retryOptions = {}) {
  const lock = await acquireLogRetentionLock(pool, key, retryOptions);
  if (!lock) return { skipped: true };
  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    await lock.release();
  }
}
