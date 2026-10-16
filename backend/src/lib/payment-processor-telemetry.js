/**
 * Payment Processor Telemetry: payload sanitization, strict validation
 * (issue #1477), alert metrics and health (issue #1478) and retry outcome
 * recording (issue #1479).
 *
 * Why sanitization matters
 * ------------------------
 * The processor used to pass `req.body.asset` straight into Prometheus
 * labels. A client could send a new random asset string on every request and
 * create an unbounded number of series (memory growth in this process and in
 * Prometheus), or inject arbitrary text into dashboards. Every recorder here:
 *
 *   - accepts only a plain object payload
 *   - checks `outcome` / `stage` / `operation` against a fixed allow-list
 *   - normalises `asset` to an upper-case Stellar asset code
 *     (^[A-Z0-9]{1,12}$); anything else becomes "invalid"
 *   - caps distinct asset labels (PAYMENT_PROCESSOR_TELEMETRY_MAX_ASSET_LABELS,
 *     default 50); later new codes are recorded as "other"
 *   - accepts durations only if finite, >= 0 and <= 1 hour
 *
 * A rejected payload is NOT written to the business series; it increments
 * `payment_processor_telemetry_rejected_total{metric, reason}` instead.
 * Recorders never throw: telemetry must never fail a payment request.
 *
 * Health
 * ------
 * A rolling window (default 5 min) of session, verification, refund and
 * retry outcomes yields healthy | degraded | unhealthy, exposed as gauges
 * (refreshed at scrape time) and via GET /health/payment-processor. Only
 * counts and ratios are kept: no payment ids, amounts, addresses or assets.
 */

import client from "prom-client";
import { logger } from "./logger.js";
import {
  paymentProcessorRegister,
  paymentProcessorSessionsTotal,
  paymentProcessorSessionDuration,
  paymentProcessorVerificationsTotal,
  paymentProcessorVerificationDuration,
  paymentProcessorStatusCacheHits,
  paymentProcessorStatusCacheMisses,
  paymentProcessorRefundsTotal,
  paymentProcessorListRequestsTotal,
} from "./payment-processor-metrics.js";

// ── Allow-lists (#1477) ──────────────────────────────────────────────────────

export const SESSION_OUTCOMES = Object.freeze([
  "created",
  "validation_failed",
  "persistence_failed",
  "sandbox_skipped",
]);

export const VERIFICATION_OUTCOMES = Object.freeze([
  "confirmed",
  "already_confirmed",
  "already_confirmed_concurrent",
  "pending_no_match",
  "signature_invalid",
  "underpayment",
  "overpayment",
  "tx_claim_conflict",
  "error",
]);

export const REFUND_STAGES = Object.freeze(["generate", "confirm"]);
export const REFUND_OUTCOMES = Object.freeze([
  "success",
  "rejected",
  "not_found",
  "failed_on_chain",
  "error",
]);

export const LIST_OUTCOMES = Object.freeze(["success", "pool_fallback", "error"]);
export const RETRY_OPERATIONS = Object.freeze(["status_lookup", "verify_lookup"]);
export const RETRY_RESULTS = Object.freeze(["scheduled", "recovered", "exhausted"]);

const REJECT_REASONS = Object.freeze([
  "invalid_payload",
  "invalid_outcome",
  "invalid_stage",
  "invalid_operation",
  "invalid_duration",
]);

const ASSET_CODE_RE = /^[A-Z0-9]{1,12}$/;
export const MAX_DURATION_SECONDS = 3600;

function readNumberEnv(name, fallback, env = process.env) {
  const raw = Number.parseFloat(env[name] ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

let maxAssetLabels = Math.max(
  1,
  Math.trunc(readNumberEnv("PAYMENT_PROCESSOR_TELEMETRY_MAX_ASSET_LABELS", 50)),
);
const seenAssets = new Set();

// ── New series (#1477, #1478, #1479) ────────────────────────────────────────

export const paymentProcessorTelemetryRejectedTotal = new client.Counter({
  name: "payment_processor_telemetry_rejected_total",
  help: "Payment processor telemetry payloads rejected by strict validation, by metric and reason",
  labelNames: ["metric", "reason"],
  registers: [],
});

export const paymentProcessorRetriesTotal = new client.Counter({
  name: "payment_processor_retries_total",
  help: "Payment processor read retries with exponential backoff, by operation and result",
  labelNames: ["operation", "result"],
  registers: [],
});

/** 0 = healthy, 1 = degraded, 2 = unhealthy. Refreshed at scrape time. */
export const paymentProcessorHealthState = new client.Gauge({
  name: "payment_processor_health_state",
  help: "Payment processor health (0 = healthy, 1 = degraded, 2 = unhealthy)",
  registers: [],
});

export const paymentProcessorSessionFailureRatio = new client.Gauge({
  name: "payment_processor_session_failure_ratio",
  help: "Share of session creations that failed to persist over the rolling window",
  registers: [],
});

export const paymentProcessorVerificationErrorRatio = new client.Gauge({
  name: "payment_processor_verification_error_ratio",
  help: "Share of verification attempts that ended in an internal error over the rolling window",
  registers: [],
});

export const paymentProcessorRefundErrorRatio = new client.Gauge({
  name: "payment_processor_refund_error_ratio",
  help: "Share of refund operations that errored or failed on chain over the rolling window",
  registers: [],
});

export const paymentProcessorTelemetryRejectionRatio = new client.Gauge({
  name: "payment_processor_telemetry_rejection_ratio",
  help: "Share of telemetry payloads rejected by validation over the rolling window",
  registers: [],
});

export const HEALTH_STATE_VALUES = Object.freeze({ healthy: 0, degraded: 1, unhealthy: 2 });

// ── Health monitor (#1478) ───────────────────────────────────────────────────

export function resolveProcessorHealthOptions(options = {}, env = process.env) {
  return {
    windowMs: options.windowMs ?? readNumberEnv("PAYMENT_PROCESSOR_HEALTH_WINDOW_MS", 300_000, env),
    bucketMs: options.bucketMs ?? 5_000,
    minSamples: options.minSamples ?? readNumberEnv("PAYMENT_PROCESSOR_HEALTH_MIN_SAMPLES", 20, env),
    degradedRatio:
      options.degradedRatio ?? readNumberEnv("PAYMENT_PROCESSOR_DEGRADED_ERROR_RATIO", 0.05, env),
    unhealthyRatio:
      options.unhealthyRatio ?? readNumberEnv("PAYMENT_PROCESSOR_UNHEALTHY_ERROR_RATIO", 0.2, env),
  };
}

function emptyBucket() {
  return {
    slot: -1,
    sessions: 0,
    sessionFailures: 0,
    verifications: 0,
    verificationErrors: 0,
    refunds: 0,
    refundErrors: 0,
    events: 0,
    rejected: 0,
    retriesExhausted: 0,
  };
}

/** Fixed ring of time buckets: memory is constant regardless of traffic. */
export class PaymentProcessorHealthMonitor {
  constructor(options = {}, now = () => Date.now()) {
    this.options = resolveProcessorHealthOptions(options);
    this.now = now;
    this.bucketCount = Math.max(1, Math.ceil(this.options.windowMs / this.options.bucketMs));
    this.reset();
  }

  reset() {
    this.buckets = Array.from({ length: this.bucketCount }, () => emptyBucket());
  }

  _bucket() {
    const slot = Math.floor(this.now() / this.options.bucketMs);
    const bucket = this.buckets[slot % this.bucketCount];
    if (bucket.slot !== slot) Object.assign(bucket, emptyBucket(), { slot });
    return bucket;
  }

  recordSession(outcome) {
    const b = this._bucket();
    b.events += 1;
    if (outcome === "validation_failed" || outcome === "sandbox_skipped") return;
    b.sessions += 1;
    if (outcome === "persistence_failed") b.sessionFailures += 1;
  }

  recordVerification(outcome) {
    const b = this._bucket();
    b.events += 1;
    b.verifications += 1;
    if (outcome === "error") b.verificationErrors += 1;
  }

  recordRefund(outcome) {
    const b = this._bucket();
    b.events += 1;
    b.refunds += 1;
    if (outcome === "error" || outcome === "failed_on_chain") b.refundErrors += 1;
  }

  recordEvent() {
    this._bucket().events += 1;
  }

  recordRejected() {
    const b = this._bucket();
    b.events += 1;
    b.rejected += 1;
  }

  recordRetryExhausted() {
    this._bucket().retriesExhausted += 1;
  }

  snapshot() {
    const currentSlot = Math.floor(this.now() / this.options.bucketMs);
    const oldestSlot = currentSlot - this.bucketCount + 1;
    const c = emptyBucket();
    for (const b of this.buckets) {
      if (b.slot < oldestSlot || b.slot > currentSlot) continue;
      for (const key of Object.keys(c)) if (key !== "slot") c[key] += b[key];
    }

    const ratio = (num, den) => (den > 0 ? num / den : 0);
    const sessionFailureRatio = ratio(c.sessionFailures, c.sessions);
    const verificationErrorRatio = ratio(c.verificationErrors, c.verifications);
    const refundErrorRatio = ratio(c.refundErrors, c.refunds);
    const rejectionRatio = ratio(c.rejected, c.events);
    const { minSamples, degradedRatio, unhealthyRatio } = this.options;

    const reasons = [];
    let status = "healthy";
    const check = (value, samples, reason) => {
      if (samples < minSamples) return;
      if (value >= unhealthyRatio) {
        status = "unhealthy";
        reasons.push(`${reason}_critical`);
      } else if (value >= degradedRatio) {
        if (status === "healthy") status = "degraded";
        reasons.push(reason);
      }
    };
    check(sessionFailureRatio, c.sessions, "session_failure_ratio");
    check(verificationErrorRatio, c.verifications, "verification_error_ratio");
    check(refundErrorRatio, c.refunds, "refund_error_ratio");
    if (c.events >= minSamples && rejectionRatio >= degradedRatio) {
      if (status === "healthy") status = "degraded";
      reasons.push("telemetry_rejections");
    }
    if (c.retriesExhausted > 0) {
      if (status === "healthy") status = "degraded";
      reasons.push("retries_exhausted");
    }

    const r4 = (n) => Number(n.toFixed(4));
    return {
      status,
      reasons,
      window_ms: this.bucketCount * this.options.bucketMs,
      sessions: c.sessions,
      session_failures: c.sessionFailures,
      verifications: c.verifications,
      verification_errors: c.verificationErrors,
      refunds: c.refunds,
      refund_errors: c.refundErrors,
      telemetry_events: c.events,
      telemetry_rejected: c.rejected,
      retries_exhausted: c.retriesExhausted,
      session_failure_ratio: r4(sessionFailureRatio),
      verification_error_ratio: r4(verificationErrorRatio),
      refund_error_ratio: r4(refundErrorRatio),
      telemetry_rejection_ratio: r4(rejectionRatio),
      thresholds: {
        min_samples: minSamples,
        degraded_ratio: degradedRatio,
        unhealthy_ratio: unhealthyRatio,
      },
    };
  }
}

const healthMonitor = new PaymentProcessorHealthMonitor();

paymentProcessorHealthState.collect = function collectPaymentProcessorHealth() {
  const snap = healthMonitor.snapshot();
  this.set(HEALTH_STATE_VALUES[snap.status] ?? 0);
  paymentProcessorSessionFailureRatio.set(snap.session_failure_ratio);
  paymentProcessorVerificationErrorRatio.set(snap.verification_error_ratio);
  paymentProcessorRefundErrorRatio.set(snap.refund_error_ratio);
  paymentProcessorTelemetryRejectionRatio.set(snap.telemetry_rejection_ratio);
};

/** Current processor health for /health endpoints. Counts and ratios only. */
export function getPaymentProcessorHealth() {
  return healthMonitor.snapshot();
}

/** Test-only: clear the rolling window and the asset label set. Counters are kept. */
export function resetPaymentProcessorTelemetry({ maxAssets } = {}) {
  healthMonitor.reset();
  seenAssets.clear();
  if (maxAssets !== undefined) maxAssetLabels = Math.max(1, Math.trunc(maxAssets));
}

// ── Sanitization (#1477) ─────────────────────────────────────────────────────

/**
 * Normalise a client-supplied asset into a bounded label value.
 * @param {unknown} raw
 * @returns {string} an asset code, "unknown", "invalid" or "other"
 */
export function sanitizeAssetLabel(raw) {
  if (raw === undefined || raw === null || raw === "") return "unknown";
  if (typeof raw !== "string") return "invalid";
  // Callers use the literal "unknown" when no asset context exists.
  if (raw === "unknown") return "unknown";
  const code = raw.trim().toUpperCase();
  if (code === "NATIVE") return "XLM";
  if (!ASSET_CODE_RE.test(code)) return "invalid";
  if (seenAssets.has(code)) return code;
  if (seenAssets.size >= maxAssetLabels) return "other";
  seenAssets.add(code);
  return code;
}

/**
 * @param {unknown} value seconds
 * @returns {number | null} null when the value must not be observed
 */
export function sanitizeDurationSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > MAX_DURATION_SECONDS) return null;
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reject(metric, reason) {
  const safeReason = REJECT_REASONS.includes(reason) ? reason : "invalid_payload";
  safeRecord(() => {
    paymentProcessorTelemetryRejectedTotal.inc({ metric, reason: safeReason });
    healthMonitor.recordRejected();
  });
  logger.warn({ metric, reason: safeReason }, "Payment processor telemetry payload rejected");
  return false;
}

function safeRecord(fn) {
  try {
    fn();
  } catch (err) {
    logger.error({ err: err?.message }, "Failed to record payment processor telemetry");
  }
}

// ── Recorders ────────────────────────────────────────────────────────────────

/**
 * @param {{asset?: unknown, outcome: string, durationSeconds?: number}} payload
 * @returns {boolean} whether the payload was accepted
 */
export function recordSessionTelemetry(payload) {
  if (!isPlainObject(payload)) return reject("sessions", "invalid_payload");
  if (!SESSION_OUTCOMES.includes(payload.outcome)) return reject("sessions", "invalid_outcome");
  const labels = { asset: sanitizeAssetLabel(payload.asset), outcome: payload.outcome };
  const duration = sanitizeDurationSeconds(payload.durationSeconds);
  safeRecord(() => {
    paymentProcessorSessionsTotal.inc(labels);
    if (duration !== null) paymentProcessorSessionDuration.observe(labels, duration);
    healthMonitor.recordSession(labels.outcome);
  });
  if (payload.durationSeconds !== undefined && duration === null) {
    reject("session_duration", "invalid_duration");
  }
  return true;
}

/**
 * @param {{asset?: unknown, outcome: string, durationSeconds?: number}} payload
 * @returns {boolean}
 */
export function recordVerificationTelemetry(payload) {
  if (!isPlainObject(payload)) return reject("verifications", "invalid_payload");
  if (!VERIFICATION_OUTCOMES.includes(payload.outcome)) {
    return reject("verifications", "invalid_outcome");
  }
  const labels = { asset: sanitizeAssetLabel(payload.asset), outcome: payload.outcome };
  const duration = sanitizeDurationSeconds(payload.durationSeconds);
  safeRecord(() => {
    paymentProcessorVerificationsTotal.inc(labels);
    if (duration !== null) paymentProcessorVerificationDuration.observe(labels, duration);
    healthMonitor.recordVerification(labels.outcome);
  });
  if (payload.durationSeconds !== undefined && duration === null) {
    reject("verification_duration", "invalid_duration");
  }
  return true;
}

/**
 * @param {{stage: string, outcome: string}} payload
 * @returns {boolean}
 */
export function recordRefundTelemetry(payload) {
  if (!isPlainObject(payload)) return reject("refunds", "invalid_payload");
  if (!REFUND_STAGES.includes(payload.stage)) return reject("refunds", "invalid_stage");
  if (!REFUND_OUTCOMES.includes(payload.outcome)) return reject("refunds", "invalid_outcome");
  safeRecord(() => {
    paymentProcessorRefundsTotal.inc({ stage: payload.stage, outcome: payload.outcome });
    healthMonitor.recordRefund(payload.outcome);
  });
  return true;
}

/** @param {{outcome: string}} payload @returns {boolean} */
export function recordListRequestTelemetry(payload) {
  if (!isPlainObject(payload)) return reject("list_requests", "invalid_payload");
  if (!LIST_OUTCOMES.includes(payload.outcome)) return reject("list_requests", "invalid_outcome");
  safeRecord(() => {
    paymentProcessorListRequestsTotal.inc({ outcome: payload.outcome });
    healthMonitor.recordEvent();
  });
  return true;
}

/** @param {boolean} hit @returns {boolean} */
export function recordStatusCacheTelemetry(hit) {
  if (typeof hit !== "boolean") return reject("status_cache", "invalid_payload");
  safeRecord(() => {
    (hit ? paymentProcessorStatusCacheHits : paymentProcessorStatusCacheMisses).inc();
    healthMonitor.recordEvent();
  });
  return true;
}

/**
 * @param {{operation: string, result: string}} payload
 * @returns {boolean}
 */
export function recordProcessorRetryTelemetry(payload) {
  if (!isPlainObject(payload)) return reject("retries", "invalid_payload");
  if (!RETRY_OPERATIONS.includes(payload.operation)) return reject("retries", "invalid_operation");
  if (!RETRY_RESULTS.includes(payload.result)) return reject("retries", "invalid_outcome");
  safeRecord(() => {
    paymentProcessorRetriesTotal.inc({ operation: payload.operation, result: payload.result });
    if (payload.result === "exhausted") healthMonitor.recordRetryExhausted();
  });
  return true;
}

paymentProcessorRegister.registerMetric(paymentProcessorTelemetryRejectedTotal);
paymentProcessorRegister.registerMetric(paymentProcessorRetriesTotal);
paymentProcessorRegister.registerMetric(paymentProcessorHealthState);
paymentProcessorRegister.registerMetric(paymentProcessorSessionFailureRatio);
paymentProcessorRegister.registerMetric(paymentProcessorVerificationErrorRatio);
paymentProcessorRegister.registerMetric(paymentProcessorRefundErrorRatio);
paymentProcessorRegister.registerMetric(paymentProcessorTelemetryRejectionRatio);
