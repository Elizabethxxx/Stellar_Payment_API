/**
 * websocket-relay-telemetry.js
 *
 * Prometheus alert metrics and health telemetry for the WebSocket Relay
 * Service (issue #1453).
 *
 * websocket-relay-metrics.js (#1083) exposes raw relay counters. This module
 * adds what alerting needs on top of them:
 *
 *   - Delivery and retry outcome counters with a fixed label set
 *   - A rolling-window health monitor (constant memory) that derives
 *     healthy / degraded / unhealthy from the delivery failure ratio, retry
 *     exhaustion, the circuit breaker state and the dead letter queue depth
 *   - Scrape-time gauges for that health, so alerts decay when traffic stops
 *   - getWebSocketRelayHealth() for GET /health/websocket-relay
 *
 * Labels are never taken from message content, payment ids, origins or error
 * messages, so relay traffic cannot inflate cardinality or leak data into
 * metrics. The metrics live in their own registry; /metrics merges it.
 */

import client from "prom-client";
import { logger } from "./logger.js";

const register = new client.Registry();

register.setDefaultLabels({
  app: "stellar-payment-api",
  module: "websocket-relay",
});

/** outcome: delivered | recovered | dead_lettered | failed */
export const websocketRelayDeliveriesTotal = new client.Counter({
  name: "websocket_relay_deliveries_total",
  help: "Relay message deliveries by final outcome (recovered = delivered after at least one retry)",
  labelNames: ["outcome"],
});

/** result: scheduled | recovered | exhausted | aborted */
export const websocketRelayRetriesTotal = new client.Counter({
  name: "websocket_relay_retries_total",
  help: "Relay retries with exponential backoff, by result",
  labelNames: ["operation", "result"],
});

export const websocketRelayRetryDelay = new client.Histogram({
  name: "websocket_relay_retry_delay_seconds",
  help: "Backoff delay scheduled before a relay retry",
  labelNames: ["operation"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

/** health_state: 0 = healthy, 1 = degraded, 2 = unhealthy */
export const websocketRelayHealthState = new client.Gauge({
  name: "websocket_relay_health_state",
  help: "WebSocket relay health (0 = healthy, 1 = degraded, 2 = unhealthy)",
});

export const websocketRelayFailureRatio = new client.Gauge({
  name: "websocket_relay_delivery_failure_ratio",
  help: "Share of relay deliveries that failed or were dead-lettered over the rolling window",
});

export const websocketRelayDlqDepth = new client.Gauge({
  name: "websocket_relay_dlq_depth",
  help: "Messages currently in the relay dead letter queue",
});

export const websocketRelayCircuitOpen = new client.Gauge({
  name: "websocket_relay_circuit_open",
  help: "1 while the relay circuit breaker is OPEN, 0.5 while HALF_OPEN, otherwise 0",
});

export const websocketRelayLastDeliveryTimestamp = new client.Gauge({
  name: "websocket_relay_last_delivery_timestamp_seconds",
  help: "Unix time of the most recent successful relay delivery",
});

const DELIVERY_OUTCOMES = new Set(["delivered", "recovered", "dead_lettered", "failed"]);
const RETRY_RESULTS = new Set(["scheduled", "recovered", "exhausted", "aborted"]);
const OPERATIONS = new Set(["deliver", "reconnect", "redrive", "other"]);

export const HEALTH_STATE_VALUES = Object.freeze({ healthy: 0, degraded: 1, unhealthy: 2 });

function readNumberEnv(name, fallback) {
  const raw = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export const DEFAULT_RELAY_HEALTH_OPTIONS = Object.freeze({
  windowMs: readNumberEnv("RELAY_HEALTH_WINDOW_MS", 300_000),
  bucketMs: 5_000,
  minSamples: readNumberEnv("RELAY_HEALTH_MIN_SAMPLES", 20),
  failureRatioThreshold: readNumberEnv("RELAY_FAILURE_RATIO_THRESHOLD", 0.1),
  dlqDegradedThreshold: readNumberEnv("RELAY_DLQ_DEGRADED_THRESHOLD", 1),
  dlqUnhealthyThreshold: readNumberEnv("RELAY_DLQ_UNHEALTHY_THRESHOLD", 100),
});

function emptyBucket() {
  return { slot: -1, delivered: 0, recovered: 0, deadLettered: 0, failed: 0, exhausted: 0 };
}

/** Restrict a label value to a known set. */
export function safeLabel(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

/**
 * Rolling-window relay health. Counts live in a fixed ring of time buckets,
 * so memory is constant regardless of traffic. Circuit breaker state and DLQ
 * depth are read live from whatever source was attached.
 */
export class WebSocketRelayHealthMonitor {
  constructor(options = {}, now = () => Date.now()) {
    this.options = { ...DEFAULT_RELAY_HEALTH_OPTIONS, ...options };
    this.now = now;
    this.bucketCount = Math.max(1, Math.ceil(this.options.windowMs / this.options.bucketMs));
    this.source = null;
    this.reset();
  }

  reset() {
    this.buckets = Array.from({ length: this.bucketCount }, () => emptyBucket());
    this.lastDeliveryAt = null;
  }

  /**
   * Attach the relay's circuit breaker and dead letter queue so health
   * reflects their live state. Pass null to detach.
   *
   * @param {{ circuitBreaker?: { getStatus(): { state: string } }, dlq?: { size: number } } | null} source
   */
  attach(source) {
    this.source = source ?? null;
  }

  _bucketFor(time) {
    const slot = Math.floor(time / this.options.bucketMs);
    const bucket = this.buckets[slot % this.bucketCount];
    if (bucket.slot !== slot) Object.assign(bucket, emptyBucket(), { slot });
    return bucket;
  }

  /** @param {'delivered'|'recovered'|'dead_lettered'|'failed'} outcome */
  recordDelivery(outcome) {
    const time = this.now();
    const bucket = this._bucketFor(time);
    if (outcome === "delivered") bucket.delivered += 1;
    else if (outcome === "recovered") bucket.recovered += 1;
    else if (outcome === "dead_lettered") bucket.deadLettered += 1;
    else bucket.failed += 1;
    if (outcome === "delivered" || outcome === "recovered") this.lastDeliveryAt = time;
  }

  recordRetryExhausted() {
    this._bucketFor(this.now()).exhausted += 1;
  }

  _liveState() {
    let circuitState = "CLOSED";
    let dlqSize = 0;
    try {
      const status = this.source?.circuitBreaker?.getStatus?.();
      if (status && typeof status.state === "string") circuitState = status.state;
      const size = Number(this.source?.dlq?.size ?? 0);
      dlqSize = Number.isFinite(size) && size > 0 ? size : 0;
    } catch (err) {
      logger.warn({ err: err?.message }, "WebSocket relay health source could not be read");
    }
    return { circuitState, dlqSize };
  }

  snapshot() {
    const time = this.now();
    const currentSlot = Math.floor(time / this.options.bucketMs);
    const oldestSlot = currentSlot - this.bucketCount + 1;
    const counts = emptyBucket();
    for (const bucket of this.buckets) {
      if (bucket.slot < oldestSlot || bucket.slot > currentSlot) continue;
      counts.delivered += bucket.delivered;
      counts.recovered += bucket.recovered;
      counts.deadLettered += bucket.deadLettered;
      counts.failed += bucket.failed;
      counts.exhausted += bucket.exhausted;
    }

    const deliveries = counts.delivered + counts.recovered + counts.deadLettered + counts.failed;
    const failures = counts.deadLettered + counts.failed;
    const failureRatio = deliveries > 0 ? failures / deliveries : 0;
    const { circuitState, dlqSize } = this._liveState();
    const { minSamples, failureRatioThreshold, dlqDegradedThreshold, dlqUnhealthyThreshold } = this.options;

    const reasons = [];
    let status = "healthy";
    const degrade = (reason) => {
      if (status === "healthy") status = "degraded";
      reasons.push(reason);
    };
    const fail = (reason) => {
      status = "unhealthy";
      reasons.push(reason);
    };

    if (circuitState === "OPEN") fail("circuit_open");
    else if (circuitState === "HALF_OPEN") degrade("circuit_half_open");
    if (deliveries >= minSamples && failureRatio >= failureRatioThreshold) fail("failure_ratio_exceeded");
    if (dlqUnhealthyThreshold > 0 && dlqSize >= dlqUnhealthyThreshold) fail("dlq_backlog");
    else if (dlqDegradedThreshold > 0 && dlqSize >= dlqDegradedThreshold) degrade("dlq_not_empty");
    if (counts.exhausted > 0) degrade("retries_exhausted");

    return {
      status,
      reasons,
      window_ms: this.bucketCount * this.options.bucketMs,
      deliveries,
      delivered: counts.delivered,
      recovered: counts.recovered,
      dead_lettered: counts.deadLettered,
      failed: counts.failed,
      retries_exhausted: counts.exhausted,
      failure_ratio: Number(failureRatio.toFixed(4)),
      circuit_state: circuitState,
      dlq_size: dlqSize,
      last_delivery_at: this.lastDeliveryAt === null ? null : new Date(this.lastDeliveryAt).toISOString(),
      thresholds: {
        min_samples: minSamples,
        failure_ratio: failureRatioThreshold,
        dlq_degraded: dlqDegradedThreshold,
        dlq_unhealthy: dlqUnhealthyThreshold,
      },
    };
  }
}

const healthMonitor = new WebSocketRelayHealthMonitor();

websocketRelayHealthState.collect = function collectRelayHealth() {
  const snap = healthMonitor.snapshot();
  this.set(HEALTH_STATE_VALUES[snap.status] ?? 0);
  websocketRelayFailureRatio.set(snap.failure_ratio);
  websocketRelayDlqDepth.set(snap.dlq_size);
  websocketRelayCircuitOpen.set(snap.circuit_state === "OPEN" ? 1 : snap.circuit_state === "HALF_OPEN" ? 0.5 : 0);
  if (healthMonitor.lastDeliveryAt !== null) {
    websocketRelayLastDeliveryTimestamp.set(healthMonitor.lastDeliveryAt / 1000);
  }
};

function safeRecord(fn) {
  try {
    fn();
  } catch (err) {
    logger.error({ err: err?.message }, "Failed to record WebSocket relay telemetry");
  }
}

/** @param {'delivered'|'recovered'|'dead_lettered'|'failed'} outcome */
export function recordRelayDelivery(outcome) {
  const safe = safeLabel(outcome, DELIVERY_OUTCOMES, "failed");
  safeRecord(() => {
    websocketRelayDeliveriesTotal.inc({ outcome: safe });
    healthMonitor.recordDelivery(safe);
  });
}

/**
 * @param {'deliver'|'reconnect'|'redrive'|'other'} operation
 * @param {'scheduled'|'recovered'|'exhausted'|'aborted'} result
 * @param {number} [delayMs] backoff delay, for `scheduled`
 */
export function recordRelayRetry(operation, result, delayMs) {
  const op = safeLabel(operation, OPERATIONS, "other");
  const safe = safeLabel(result, RETRY_RESULTS, "exhausted");
  safeRecord(() => {
    websocketRelayRetriesTotal.inc({ operation: op, result: safe });
    if (safe === "scheduled" && Number.isFinite(delayMs) && delayMs >= 0) {
      websocketRelayRetryDelay.observe({ operation: op }, delayMs / 1000);
    }
    if (safe === "exhausted") healthMonitor.recordRetryExhausted();
  });
}

/** Attach the relay's circuit breaker and DLQ to the health snapshot. */
export function attachRelayHealthSource(source) {
  healthMonitor.attach(source);
}

/** Current relay health for /health endpoints. Contains no message data. */
export function getWebSocketRelayHealth() {
  return healthMonitor.snapshot();
}

/** Test-only: clear the rolling window and detach any source. Counters are left intact. */
export function resetWebSocketRelayHealth() {
  healthMonitor.reset();
  healthMonitor.attach(null);
}

register.registerMetric(websocketRelayDeliveriesTotal);
register.registerMetric(websocketRelayRetriesTotal);
register.registerMetric(websocketRelayRetryDelay);
register.registerMetric(websocketRelayHealthState);
register.registerMetric(websocketRelayFailureRatio);
register.registerMetric(websocketRelayDlqDepth);
register.registerMetric(websocketRelayCircuitOpen);
register.registerMetric(websocketRelayLastDeliveryTimestamp);

export { register as websocketRelayTelemetryRegister };
