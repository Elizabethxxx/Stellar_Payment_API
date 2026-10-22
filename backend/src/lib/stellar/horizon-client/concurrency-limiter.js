/**
 * Horizon Client Concurrency Limiter (issue #1440)
 *
 * A per-process counting semaphore with a bounded FIFO wait queue.
 *
 * Without it every caller hits Horizon at once. During a Horizon slowdown the
 * number of open sockets and pending promises grows without bound, and when
 * Horizon starts answering 429 every one of those callers retries at once.
 *
 * Behaviour
 *   - Up to `maxConcurrent` operations run at the same time.
 *   - Up to `maxQueue` more wait in FIFO order.
 *   - Anything beyond that is rejected immediately with a 503
 *     (HORIZON_CLIENT_QUEUE_FULL) - load shedding instead of collapse.
 *   - A queued operation that waits longer than `queueTimeoutMs` is rejected
 *     with a 503 (HORIZON_CLIENT_QUEUE_TIMEOUT) and removed from the queue.
 *   - release() is idempotent, so a double release can never inflate the
 *     number of available slots.
 */

import {
  CONCURRENCY_LIMITS,
  DEFAULT_CONCURRENCY_OPTIONS,
  RETRY_MANAGER_ERROR_CODES,
} from "./constants.js";

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Resolve limiter options. Precedence: explicit > environment > defaults.
 */
export function resolveConcurrencyOptions(options = {}, env = process.env) {
  return Object.freeze({
    maxConcurrent: clampInt(
      options.maxConcurrent ?? env.HORIZON_CLIENT_MAX_CONCURRENCY,
      DEFAULT_CONCURRENCY_OPTIONS.maxConcurrent,
      1,
      CONCURRENCY_LIMITS.maxConcurrent,
    ),
    maxQueue: clampInt(
      options.maxQueue ?? env.HORIZON_CLIENT_MAX_QUEUE,
      DEFAULT_CONCURRENCY_OPTIONS.maxQueue,
      0,
      CONCURRENCY_LIMITS.maxQueue,
    ),
    queueTimeoutMs: clampInt(
      options.queueTimeoutMs ?? env.HORIZON_CLIENT_QUEUE_TIMEOUT_MS,
      DEFAULT_CONCURRENCY_OPTIONS.queueTimeoutMs,
      0,
      CONCURRENCY_LIMITS.queueTimeoutMs,
    ),
  });
}

/**
 * Build the error returned when the limiter sheds load.
 *
 * @param {string} code one of RETRY_MANAGER_ERROR_CODES
 * @param {string} operation
 */
export function createBackpressureError(code, operation) {
  const message =
    code === RETRY_MANAGER_ERROR_CODES.QUEUE_TIMEOUT
      ? "Horizon client is saturated: timed out waiting for a free request slot."
      : "Horizon client is saturated: too many pending requests.";
  const error = new Error(message);
  error.status = 503;
  error.code = code;
  error.operation = operation;
  // Retrying locally would only add to the queue we just rejected from.
  error.retryable = false;
  return error;
}

export class ConcurrencyLimiter {
  /**
   * @param {object} [options] see resolveConcurrencyOptions
   */
  constructor(options = {}) {
    const resolved = resolveConcurrencyOptions(options);
    this.maxConcurrent = resolved.maxConcurrent;
    this.maxQueue = resolved.maxQueue;
    this.queueTimeoutMs = resolved.queueTimeoutMs;
    this.active = 0;
    /** @type {Array<{resolve: Function, reject: Function, timer: any, operation: string}>} */
    this.queue = [];
    this.onQueueChange = typeof options.onQueueChange === "function" ? options.onQueueChange : null;
  }

  get pending() {
    return this.queue.length;
  }

  _notifyQueue() {
    try {
      this.onQueueChange?.(this.queue.length);
    } catch {
      // Observability must never break the request path.
    }
  }

  _makeRelease() {
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      this._releaseSlot();
      return true;
    };
  }

  _releaseSlot() {
    const next = this.queue.shift();
    if (next) {
      // Hand the slot straight to the next waiter; `active` stays the same.
      clearTimeout(next.timer);
      this._notifyQueue();
      next.resolve(this._makeRelease());
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  /**
   * Wait for a slot.
   *
   * @param {string} [operation] used in rejection errors
   * @returns {Promise<() => boolean>} release function (idempotent)
   * @throws 503 error with code HORIZON_CLIENT_QUEUE_FULL / HORIZON_CLIENT_QUEUE_TIMEOUT
   */
  acquire(operation = "unknown") {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this._makeRelease());
    }

    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(
        createBackpressureError(RETRY_MANAGER_ERROR_CODES.QUEUE_FULL, operation),
      );
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, operation };
      if (this.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) {
            this.queue.splice(index, 1);
            this._notifyQueue();
          }
          reject(createBackpressureError(RETRY_MANAGER_ERROR_CODES.QUEUE_TIMEOUT, operation));
        }, this.queueTimeoutMs);
        waiter.timer.unref?.();
      }
      this.queue.push(waiter);
      this._notifyQueue();
    });
  }

  /**
   * Run `fn` while holding a slot.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @param {string} [operation]
   * @returns {Promise<T>}
   */
  async run(fn, operation) {
    const release = await this.acquire(operation);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  getStats() {
    return {
      active: this.active,
      pending: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
      queueTimeoutMs: this.queueTimeoutMs,
    };
  }
}
