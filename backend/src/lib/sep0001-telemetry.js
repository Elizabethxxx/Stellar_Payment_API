import client from "prom-client";

/**
 * SEP-0001 Stellar Info Generator alert metrics and health telemetry
 * (issue #1458).
 *
 * Tracks every GET /.well-known/stellar.toml request:
 *
 *   - outcome counts and generation latency
 *   - published document size (SEP-0001 caps stellar.toml at 100 KB)
 *   - fields rejected by sanitization (issue #1457), e.g. a secret seed
 *     configured as SIGNING_KEY or an invalid merchant account
 *   - rolling-window health derived from the server-side error ratio
 *
 * Label values come from fixed, server-defined sets (never from request data
 * such as merchant_id), so clients cannot inflate series cardinality.
 *
 * The metrics live in their own registry; GET /metrics merges it with the
 * main registry.
 */

const register = new client.Registry();

register.setDefaultLabels({
  app: "stellar-payment-api",
});

/** success | invalid_request | not_found | lookup_error | generation_error */
export const SEP0001_OUTCOMES = Object.freeze([
  "success",
  "invalid_request",
  "not_found",
  "lookup_error",
  "generation_error",
]);

const SERVER_ERROR_OUTCOMES = new Set(["lookup_error", "generation_error"]);

export const SEP0001_REJECTION_FIELDS = Object.freeze([
  "STELLAR_NETWORK_PASSPHRASE",
  "TRANSFER_SERVER_URL",
  "FEDERATION_SERVER_URL",
  "DOCS_URL",
  "SIGNING_KEY",
  "recipient",
  "business_name",
  "email",
  "notification_email",
  "homepage",
  "logo_url",
]);

export const SEP0001_REJECTION_REASONS = Object.freeze([
  "invalid_url",
  "invalid_account",
  "secret_seed",
  "invalid_email",
  "invalid_type",
  "bidi_control",
  "truncated",
  "empty",
]);

export const sep0001RequestsTotal = new client.Counter({
  name: "sep0001_requests_total",
  help: "Total stellar.toml requests, by outcome",
  labelNames: ["outcome"],
});

export const sep0001GenerationDuration = new client.Histogram({
  name: "sep0001_generation_duration_seconds",
  help: "Time to serve a stellar.toml request (lookup + generation), by outcome",
  labelNames: ["outcome"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

export const sep0001DocumentSizeBytes = new client.Histogram({
  name: "sep0001_document_size_bytes",
  help: "Size of published stellar.toml documents in bytes",
  buckets: [256, 512, 1024, 2048, 4096, 16384, 65536, 102400],
});

export const sep0001RejectedFieldsTotal = new client.Counter({
  name: "sep0001_rejected_fields_total",
  help: "stellar.toml fields omitted or altered by sanitization, by field and reason",
  labelNames: ["field", "reason"],
});

export const sep0001HealthState = new client.Gauge({
  name: "sep0001_health_state",
  help: "SEP-0001 generator health (0=healthy, 1=degraded, 2=unhealthy)",
});

export const sep0001ErrorRatio = new client.Gauge({
  name: "sep0001_error_ratio",
  help: "Rolling-window ratio of server-side errors to stellar.toml requests",
});

export const sep0001LastSuccessTimestamp = new client.Gauge({
  name: "sep0001_last_success_timestamp_seconds",
  help: "Unix time of the last successfully served stellar.toml",
});

register.registerMetric(sep0001RequestsTotal);
register.registerMetric(sep0001GenerationDuration);
register.registerMetric(sep0001DocumentSizeBytes);
register.registerMetric(sep0001RejectedFieldsTotal);
register.registerMetric(sep0001HealthState);
register.registerMetric(sep0001ErrorRatio);
register.registerMetric(sep0001LastSuccessTimestamp);

export { register as sep0001Register };

const HEALTH_STATE_VALUES = { healthy: 0, degraded: 1, unhealthy: 2 };

function readNumberEnv(name, fallback) {
  const raw = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export const DEFAULT_SEP0001_HEALTH_OPTIONS = Object.freeze({
  windowMs: readNumberEnv("SEP0001_HEALTH_WINDOW_MS", 300_000),
  bucketMs: 5_000,
  minSamples: readNumberEnv("SEP0001_HEALTH_MIN_SAMPLES", 10),
  degradedErrorRatio: readNumberEnv("SEP0001_DEGRADED_ERROR_RATIO", 0.05),
  unhealthyErrorRatio: readNumberEnv("SEP0001_UNHEALTHY_ERROR_RATIO", 0.25),
  sensitiveRejectionThreshold: readNumberEnv("SEP0001_SENSITIVE_REJECTION_THRESHOLD", 1),
});

/**
 * Rolling-window health monitor. Fixed-size bucket ring, so memory is
 * constant regardless of traffic.
 *
 *   unhealthy: error ratio >= unhealthyErrorRatio (with >= minSamples)
 *   degraded:  error ratio >= degradedErrorRatio  (with >= minSamples), or a
 *              secret seed was refused as SIGNING_KEY inside the window
 */
export class Sep0001HealthMonitor {
  constructor(options = {}, now = () => Date.now()) {
    this.options = { ...DEFAULT_SEP0001_HEALTH_OPTIONS, ...options };
    this.now = now;
    this.bucketCount = Math.max(1, Math.ceil(this.options.windowMs / this.options.bucketMs));
    this.reset();
  }

  reset() {
    this.buckets = Array.from({ length: this.bucketCount }, () => this._emptyBucket(-1));
    this.lastSuccessAt = null;
    this.lastErrorAt = null;
  }

  _emptyBucket(slot) {
    const bucket = { slot, sensitiveRejections: 0 };
    for (const outcome of SEP0001_OUTCOMES) bucket[outcome] = 0;
    return bucket;
  }

  _bucketFor(time) {
    const slot = Math.floor(time / this.options.bucketMs);
    const index = slot % this.bucketCount;
    if (this.buckets[index].slot !== slot) this.buckets[index] = this._emptyBucket(slot);
    return this.buckets[index];
  }

  record(outcome, { sensitiveRejection = false } = {}) {
    const time = this.now();
    const bucket = this._bucketFor(time);
    if (SEP0001_OUTCOMES.includes(outcome)) bucket[outcome] += 1;
    if (sensitiveRejection) bucket.sensitiveRejections += 1;
    if (outcome === "success") this.lastSuccessAt = time;
    if (SERVER_ERROR_OUTCOMES.has(outcome)) this.lastErrorAt = time;
  }

  snapshot() {
    const time = this.now();
    const currentSlot = Math.floor(time / this.options.bucketMs);
    const oldestSlot = currentSlot - this.bucketCount + 1;
    const counts = { sensitive_rejections: 0 };
    for (const outcome of SEP0001_OUTCOMES) counts[outcome] = 0;

    for (const bucket of this.buckets) {
      if (bucket.slot < oldestSlot || bucket.slot > currentSlot) continue;
      for (const outcome of SEP0001_OUTCOMES) counts[outcome] += bucket[outcome];
      counts.sensitive_rejections += bucket.sensitiveRejections;
    }

    const total = SEP0001_OUTCOMES.reduce((sum, outcome) => sum + counts[outcome], 0);
    const errors = counts.lookup_error + counts.generation_error;
    const errorRatio = total > 0 ? errors / total : 0;
    const {
      minSamples,
      degradedErrorRatio,
      unhealthyErrorRatio,
      sensitiveRejectionThreshold,
    } = this.options;

    const reasons = [];
    let status = "healthy";
    if (total >= minSamples && errorRatio >= unhealthyErrorRatio) {
      status = "unhealthy";
      reasons.push("error_ratio_exceeded");
    } else if (total >= minSamples && errorRatio >= degradedErrorRatio) {
      status = "degraded";
      reasons.push("error_ratio_elevated");
    }
    if (sensitiveRejectionThreshold > 0 && counts.sensitive_rejections >= sensitiveRejectionThreshold) {
      if (status === "healthy") status = "degraded";
      reasons.push("secret_signing_key_refused");
    }

    return {
      status,
      reasons,
      window_ms: this.bucketCount * this.options.bucketMs,
      total,
      ...counts,
      error_ratio: Number(errorRatio.toFixed(4)),
      last_success_at: this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
      last_error_at: this.lastErrorAt === null ? null : new Date(this.lastErrorAt).toISOString(),
      thresholds: {
        min_samples: minSamples,
        degraded_error_ratio: degradedErrorRatio,
        unhealthy_error_ratio: unhealthyErrorRatio,
        sensitive_rejections: sensitiveRejectionThreshold,
      },
    };
  }
}

const healthMonitor = new Sep0001HealthMonitor();

// Refresh rolling-window gauges at scrape time so they decay when idle.
sep0001HealthState.collect = function collectHealthState() {
  const snap = healthMonitor.snapshot();
  this.set(HEALTH_STATE_VALUES[snap.status]);
  sep0001ErrorRatio.set(snap.error_ratio);
};

/**
 * Record one stellar.toml request.
 *
 * @param {object} params
 * @param {string} params.outcome            One of SEP0001_OUTCOMES
 * @param {number} params.durationSeconds
 * @param {number} [params.documentBytes]    Size of the served document (success only)
 * @param {Array<{field:string, reason:string}>} [params.rejections]
 */
export function recordSep0001Request({ outcome, durationSeconds, documentBytes, rejections = [] }) {
  const label = SEP0001_OUTCOMES.includes(outcome) ? outcome : "generation_error";
  sep0001RequestsTotal.inc({ outcome: label });
  if (Number.isFinite(durationSeconds) && durationSeconds >= 0) {
    sep0001GenerationDuration.observe({ outcome: label }, durationSeconds);
  }
  if (label === "success") {
    if (Number.isFinite(documentBytes)) sep0001DocumentSizeBytes.observe(documentBytes);
    sep0001LastSuccessTimestamp.set(Date.now() / 1000);
  }

  let sensitiveRejection = false;
  for (const { field, reason } of rejections) {
    sep0001RejectedFieldsTotal.inc({
      field: SEP0001_REJECTION_FIELDS.includes(field) ? field : "other",
      reason: SEP0001_REJECTION_REASONS.includes(reason) ? reason : "other",
    });
    if (field === "SIGNING_KEY" && reason === "secret_seed") sensitiveRejection = true;
  }

  healthMonitor.record(label, { sensitiveRejection });
}

/** Current generator health, for /health endpoints. */
export function getSep0001Health() {
  return healthMonitor.snapshot();
}

/** Test-only: clear the rolling health window. */
export function resetSep0001Health() {
  healthMonitor.reset();
}
