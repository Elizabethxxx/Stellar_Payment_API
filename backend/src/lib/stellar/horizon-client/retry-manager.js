/**
 * Horizon Client Retry Manager
 * 
 * Handles retry logic with exponential backoff and configurable delays.
 *
 * - Payload sanitization and strict validation (#1437): the retry schedule,
 *   operation name and callback are validated up front; context, Horizon URL
 *   and error text are sanitized before they reach logs or error messages.
 * - Alert metrics and health telemetry (#1438): retry exhaustion, consecutive
 *   failures, last-success timestamps and an aggregate health state are
 *   exported to Prometheus and available through getHealth().
 */

import { logger } from "../../logger.js";
import {
  horizonClientErrors,
  horizonClientOperations,
  horizonClientRetries,
  horizonClientLatency,
  horizonClientOperationDuration,
  horizonClientRetryAttemptDuration,
  horizonClientErrorRecovery,
  horizonClientConcurrentOperations,
  horizonClientDataValidationErrors,
  horizonClientRetryExhausted,
  horizonClientConsecutiveFailures,
  horizonClientLastSuccessTimestamp,
  horizonClientHealthState,
} from "../../metrics.js";
import { classifyError, handleError, isRetryableError } from "./error-handler.js";
import {
  sanitizeContext,
  sanitizeErrorDetail,
  sanitizeHorizonUrl,
  validateOperation,
  validateOperationName,
  validateRetryDelays,
} from "./sanitizer.js";

export const HealthStatus = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  UNHEALTHY: "unhealthy",
});

const HEALTH_STATE_VALUE = Object.freeze({
  [HealthStatus.HEALTHY]: 0,
  [HealthStatus.DEGRADED]: 1,
  [HealthStatus.UNHEALTHY]: 2,
});

export const DEFAULT_UNHEALTHY_AFTER_FAILURES = 5;
// Bound the per-operation health table; operation names are validated, but a
// caller generating names dynamically must not grow it without limit.
const MAX_TRACKED_OPERATIONS = 64;

function resolveUnhealthyThreshold(value) {
  const raw = Number(value ?? DEFAULT_UNHEALTHY_AFTER_FAILURES);
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_UNHEALTHY_AFTER_FAILURES;
  return Math.min(raw, 1_000);
}

/**
 * Retry manager class with configurable retry strategy
 */
export class RetryManager {
  /**
   * @param {number[]} retryDelays  Delay (ms) before each retry
   * @param {string} [metricsPrefix]
   * @param {object} [options]
   * @param {number} [options.unhealthyAfterFailures=5]  Consecutive failures before "unhealthy"
   * @param {() => number} [options.now]                 Injectable clock
   */
  constructor(retryDelays, metricsPrefix = "", options = {}) {
    this.retryDelays = validateRetryDelays(retryDelays);
    this.metricsPrefix = metricsPrefix;
    this.concurrentOperations = 0;
    this.unhealthyAfterFailures = resolveUnhealthyThreshold(options.unhealthyAfterFailures);
    this._now = typeof options.now === "function" ? options.now : () => Date.now();
    this.operationHealth = new Map();
  }

  /**
   * Execute operation with automatic retry logic
   */
  async executeWithRetry(operation, operationName, context = {}, horizonUrl) {
    this._validateRequest(operation, operationName);

    const safeContext = sanitizeContext(context);
    const safeUrl = sanitizeHorizonUrl(horizonUrl);
    const totalStartTime = Date.now();
    this.concurrentOperations++;
    horizonClientConcurrentOperations.inc();

    try {
      let lastError = null;

      for (let attempt = 0; attempt <= this.retryDelays.length; attempt += 1) {
        const attemptStartTime = Date.now();
        
        try {
          const result = await operation();
          
          // Record attempt duration
          const attemptDuration = (Date.now() - attemptStartTime) / 1000;
          horizonClientRetryAttemptDuration.observe(
            { operation: operationName, attempt: attempt + 1 },
            attemptDuration
          );
          
          this._recordSuccess(operationName, totalStartTime);
          this._markReachable(operationName, null);
          
          // If this was a retry (attempt > 0), record successful recovery
          if (attempt > 0) {
            horizonClientErrorRecovery.inc({
              operation: operationName,
              error_type: classifyError(lastError),
              recovery_attempt: attempt,
            });
          }
          
          return result;
        } catch (err) {
          lastError = err;
          
          // Record attempt duration even for failed attempts
          const attemptDuration = (Date.now() - attemptStartTime) / 1000;
          horizonClientRetryAttemptDuration.observe(
            { operation: operationName, attempt: attempt + 1 },
            attemptDuration
          );
          
          const retryable = isRetryableError(err);
          if (!retryable || attempt === this.retryDelays.length) {
            this._recordError(operationName, err);
            if (retryable) {
              // Every retry was spent on an infrastructure-level failure.
              horizonClientRetryExhausted.inc({
                operation: operationName,
                error_type: classifyError(err),
              });
              this._markFailure(operationName, err);
            } else {
              // Horizon answered (e.g. 404 / 400): the dependency is reachable.
              this._markReachable(operationName, err);
            }
            throw handleError(err, operationName, safeContext, safeUrl);
          }

          this._recordRetry(operationName);
          
          const delay = this.retryDelays[attempt];
          this._logRetry(operationName, attempt + 1, delay, err, safeContext);
          
          await this._sleep(delay);
        }
      }

      // Should not reach here, but for completeness
      throw handleError(lastError, operationName, safeContext, safeUrl);
    } finally {
      this.concurrentOperations--;
      horizonClientConcurrentOperations.dec();
      
      // Record total operation duration
      const totalDuration = (Date.now() - totalStartTime) / 1000;
      horizonClientOperationDuration.observe(
        { operation: operationName, phase: "total" },
        totalDuration
      );
    }
  }

  /**
   * Strictly validate the request before any work or metrics happen.
   * @private
   */
  _validateRequest(operation, operationName) {
    try {
      validateOperationName(operationName);
      validateOperation(operation);
    } catch (err) {
      const label = typeof operationName === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(operationName)
        ? operationName
        : "invalid";
      horizonClientDataValidationErrors.inc({
        operation: label,
        validation_type: err.validationType ?? "unknown",
      });
      logger.error(
        { operation: label, validationType: err.validationType },
        "Horizon client: rejected invalid retry request"
      );
      throw err;
    }
  }

  /**
   * Record successful operation metrics
   * @private
   */
  _recordSuccess(operationName, startTime) {
    horizonClientOperations.inc({ 
      operation: operationName, 
      result: "success" 
    });
    horizonClientLatency.observe({ 
      operation: operationName, 
      result: "success" 
    }, (Date.now() - startTime) / 1000);
  }

  /**
   * Record error metrics
   * @private
   */
  _recordError(operationName, err) {
    horizonClientOperations.inc({ 
      operation: operationName, 
      result: "error" 
    });
    horizonClientErrors.inc({ 
      operation: operationName, 
      error_type: classifyError(err) 
    });
  }

  /**
   * Record retry metrics
   * @private
   */
  _recordRetry(operationName) {
    horizonClientRetries.inc({ operation: operationName });
  }

  /**
   * Get (or create) the health entry for an operation.
   * @private
   */
  _healthEntry(operationName) {
    let entry = this.operationHealth.get(operationName);
    if (!entry) {
      if (this.operationHealth.size >= MAX_TRACKED_OPERATIONS) {
        return null;
      }
      entry = {
        consecutiveFailures: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastErrorType: null,
      };
      this.operationHealth.set(operationName, entry);
    }
    return entry;
  }

  /**
   * Horizon responded (success or a non-retryable client error).
   * @private
   */
  _markReachable(operationName, err) {
    const entry = this._healthEntry(operationName);
    if (!entry) return;
    const now = this._now();
    entry.consecutiveFailures = 0;
    if (err) {
      entry.lastErrorType = classifyError(err);
    } else {
      entry.totalSuccesses += 1;
      entry.lastSuccessAt = now;
      horizonClientLastSuccessTimestamp.set({ operation: operationName }, Math.floor(now / 1000));
    }
    horizonClientConsecutiveFailures.set({ operation: operationName }, 0);
    this._publishHealthState();
  }

  /**
   * Horizon was unreachable / failing after all retries.
   * @private
   */
  _markFailure(operationName, err) {
    const entry = this._healthEntry(operationName);
    if (!entry) return;
    entry.consecutiveFailures += 1;
    entry.totalFailures += 1;
    entry.lastFailureAt = this._now();
    entry.lastErrorType = classifyError(err);
    horizonClientConsecutiveFailures.set({ operation: operationName }, entry.consecutiveFailures);
    this._publishHealthState();
    if (entry.consecutiveFailures === this.unhealthyAfterFailures) {
      logger.error(
        {
          operation: operationName,
          consecutiveFailures: entry.consecutiveFailures,
          errorType: entry.lastErrorType,
        },
        "Horizon client: operation is unhealthy after consecutive failures"
      );
    }
  }

  /** @private */
  _statusFor(entry) {
    if (entry.consecutiveFailures === 0) return HealthStatus.HEALTHY;
    if (entry.consecutiveFailures >= this.unhealthyAfterFailures) return HealthStatus.UNHEALTHY;
    return HealthStatus.DEGRADED;
  }

  /** @private */
  _publishHealthState() {
    horizonClientHealthState.set(HEALTH_STATE_VALUE[this.getHealth().status]);
  }

  /**
   * Health telemetry snapshot for health endpoints and alert context.
   *
   * @returns {{ status: string, unhealthyAfterFailures: number, concurrentOperations: number,
   *   operations: Record<string, object> }}
   */
  getHealth() {
    const operations = {};
    let worst = HealthStatus.HEALTHY;
    for (const [name, entry] of this.operationHealth) {
      const status = this._statusFor(entry);
      if (HEALTH_STATE_VALUE[status] > HEALTH_STATE_VALUE[worst]) worst = status;
      operations[name] = {
        status,
        consecutiveFailures: entry.consecutiveFailures,
        totalSuccesses: entry.totalSuccesses,
        totalFailures: entry.totalFailures,
        lastSuccessAt: entry.lastSuccessAt ? new Date(entry.lastSuccessAt).toISOString() : null,
        lastFailureAt: entry.lastFailureAt ? new Date(entry.lastFailureAt).toISOString() : null,
        lastErrorType: entry.lastErrorType,
      };
    }
    return {
      status: worst,
      unhealthyAfterFailures: this.unhealthyAfterFailures,
      concurrentOperations: this.concurrentOperations,
      operations,
    };
  }

  /**
   * Log retry attempt
   * @private
   */
  _logRetry(operationName, attempt, delayMs, error, context) {
    logger.warn(
      { 
        operation: operationName, 
        attempt, 
        delayMs,
        error: sanitizeErrorDetail(error?.message),
        ...sanitizeContext(context),
      },
      "Horizon client: retrying operation after error"
    );
  }

  /**
   * Sleep helper
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get retry configuration
   */
  getConfig() {
    return {
      retryDelays: this.retryDelays,
      maxAttempts: this.retryDelays.length + 1,
      currentConcurrentOperations: this.concurrentOperations,
    };
  }
}

/**
 * Create a retry manager with default configuration
 */
export function createRetryManager(retryDelays, options) {
  return new RetryManager(retryDelays, "", options);
}
