import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  HEALTH_STATE_VALUES,
  MAX_DURATION_SECONDS,
  PaymentProcessorHealthMonitor,
  getPaymentProcessorHealth,
  paymentProcessorHealthState,
  paymentProcessorRetriesTotal,
  paymentProcessorTelemetryRejectedTotal,
  recordListRequestTelemetry,
  recordProcessorRetryTelemetry,
  recordRefundTelemetry,
  recordSessionTelemetry,
  recordStatusCacheTelemetry,
  recordVerificationTelemetry,
  resetPaymentProcessorTelemetry,
  sanitizeAssetLabel,
  sanitizeDurationSeconds,
} from "./payment-processor-telemetry.js";
import {
  paymentProcessorRegister,
  paymentProcessorSessionsTotal,
  paymentProcessorSessionDuration,
  paymentProcessorVerificationsTotal,
  paymentProcessorRefundsTotal,
  paymentProcessorListRequestsTotal,
  paymentProcessorStatusCacheHits,
  paymentProcessorStatusCacheMisses,
} from "./payment-processor-metrics.js";
import { logger } from "./logger.js";

async function value(metric, labels = {}) {
  const { values } = await metric.get();
  const hit = values.find(
    (v) =>
      !v.metricName?.endsWith("_bucket") &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return hit?.value ?? 0;
}

async function labelValues(metric, label) {
  const { values } = await metric.get();
  return [...new Set(values.map((v) => v.labels[label]).filter(Boolean))];
}

beforeEach(() => {
  resetPaymentProcessorTelemetry({ maxAssets: 50 });
  for (const m of [
    paymentProcessorSessionsTotal,
    paymentProcessorSessionDuration,
    paymentProcessorVerificationsTotal,
    paymentProcessorRefundsTotal,
    paymentProcessorListRequestsTotal,
    paymentProcessorStatusCacheHits,
    paymentProcessorStatusCacheMisses,
    paymentProcessorTelemetryRejectedTotal,
    paymentProcessorRetriesTotal,
  ]) {
    m.reset();
  }
  vi.mocked(logger.warn).mockClear();
});

describe("sanitizeAssetLabel (#1477)", () => {
  it.each([
    ["XLM", "XLM"],
    [" usdc ", "USDC"],
    ["native", "XLM"],
    ["ABCDEFGHIJKL", "ABCDEFGHIJKL"],
    [undefined, "unknown"],
    [null, "unknown"],
    ["", "unknown"],
    ["unknown", "unknown"],
    ["ABCDEFGHIJKLM", "invalid"],
    ['XLM"} evil{x="', "invalid"],
    ["US DC", "invalid"],
    ["usd-c", "invalid"],
    [42, "invalid"],
    [{ code: "XLM" }, "invalid"],
  ])("%p -> %s", (raw, expected) => {
    expect(sanitizeAssetLabel(raw)).toBe(expected);
  });

  it("caps distinct asset labels and maps the overflow to other", () => {
    resetPaymentProcessorTelemetry({ maxAssets: 2 });
    expect(sanitizeAssetLabel("AAA")).toBe("AAA");
    expect(sanitizeAssetLabel("BBB")).toBe("BBB");
    expect(sanitizeAssetLabel("CCC")).toBe("other");
    // Already-seen codes keep their own label.
    expect(sanitizeAssetLabel("aaa")).toBe("AAA");
  });
});

describe("sanitizeDurationSeconds", () => {
  it.each([
    [0, 0],
    [1.5, 1.5],
    [MAX_DURATION_SECONDS, MAX_DURATION_SECONDS],
    [-1, null],
    [MAX_DURATION_SECONDS + 1, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    ["1", null],
    [undefined, null],
  ])("%p -> %p", (raw, expected) => {
    expect(sanitizeDurationSeconds(raw)).toBe(expected);
  });
});

describe("recorders (#1477)", () => {
  it("records a valid session with a sanitised asset", async () => {
    expect(recordSessionTelemetry({ asset: "usdc", outcome: "created", durationSeconds: 0.2 })).toBe(true);
    expect(await value(paymentProcessorSessionsTotal, { asset: "USDC", outcome: "created" })).toBe(1);
    const text = await paymentProcessorRegister.metrics();
    expect(text).toMatch(
      /payment_processor_session_duration_seconds_count\{[^}]*asset="USDC"[^}]*outcome="created"[^}]*\} 1/,
    );
  });

  it("stops a client from minting a new series per request", async () => {
    resetPaymentProcessorTelemetry({ maxAssets: 3 });
    for (let i = 0; i < 500; i += 1) {
      recordSessionTelemetry({ asset: `A${i}`, outcome: "validation_failed", durationSeconds: 0.01 });
    }
    const assets = await labelValues(paymentProcessorSessionsTotal, "asset");
    expect(assets.length).toBeLessThanOrEqual(4);
    expect(assets).toContain("other");
  });

  it("rejects unknown outcomes without touching the business series", async () => {
    expect(recordSessionTelemetry({ asset: "XLM", outcome: "pwned" })).toBe(false);
    expect(recordVerificationTelemetry({ asset: "XLM", outcome: "made_up" })).toBe(false);
    expect(await labelValues(paymentProcessorSessionsTotal, "outcome")).toEqual([]);
    expect(await labelValues(paymentProcessorVerificationsTotal, "outcome")).toEqual([]);
    expect(
      await value(paymentProcessorTelemetryRejectedTotal, { metric: "sessions", reason: "invalid_outcome" }),
    ).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { metric: "sessions", reason: "invalid_outcome" },
      expect.any(String),
    );
  });

  it.each([null, undefined, "created", 42, ["created"]])("rejects a non-object payload %p", async (payload) => {
    expect(recordSessionTelemetry(payload)).toBe(false);
    expect(
      await value(paymentProcessorTelemetryRejectedTotal, { metric: "sessions", reason: "invalid_payload" }),
    ).toBe(1);
  });

  it("counts the event but drops an invalid duration", async () => {
    expect(
      recordVerificationTelemetry({ asset: "XLM", outcome: "confirmed", durationSeconds: -5 }),
    ).toBe(true);
    expect(await value(paymentProcessorVerificationsTotal, { asset: "XLM", outcome: "confirmed" })).toBe(1);
    expect(
      await value(paymentProcessorTelemetryRejectedTotal, {
        metric: "verification_duration",
        reason: "invalid_duration",
      }),
    ).toBe(1);
    const text = await paymentProcessorRegister.metrics();
    expect(text).not.toMatch(/payment_processor_verification_duration_seconds_count\{[^}]*\} 1/);
  });

  it("validates refund stage and outcome", async () => {
    expect(recordRefundTelemetry({ stage: "confirm", outcome: "failed_on_chain" })).toBe(true);
    expect(recordRefundTelemetry({ stage: "steal", outcome: "success" })).toBe(false);
    expect(recordRefundTelemetry({ stage: "generate", outcome: "weird" })).toBe(false);
    expect(await value(paymentProcessorRefundsTotal, { stage: "confirm", outcome: "failed_on_chain" })).toBe(1);
    expect(await labelValues(paymentProcessorRefundsTotal, "stage")).toEqual(["confirm"]);
  });

  it("validates list request outcomes", async () => {
    expect(recordListRequestTelemetry({ outcome: "pool_fallback" })).toBe(true);
    expect(recordListRequestTelemetry({ outcome: "nope" })).toBe(false);
    expect(await value(paymentProcessorListRequestsTotal, { outcome: "pool_fallback" })).toBe(1);
  });

  it("records status cache hits and misses, rejecting non-booleans", async () => {
    recordStatusCacheTelemetry(true);
    recordStatusCacheTelemetry(false);
    expect(recordStatusCacheTelemetry("yes")).toBe(false);
    expect(await value(paymentProcessorStatusCacheHits)).toBe(1);
    expect(await value(paymentProcessorStatusCacheMisses)).toBe(1);
  });

  it("validates retry operation and result", async () => {
    expect(recordProcessorRetryTelemetry({ operation: "status_lookup", result: "scheduled" })).toBe(true);
    expect(recordProcessorRetryTelemetry({ operation: "drop_table", result: "scheduled" })).toBe(false);
    expect(recordProcessorRetryTelemetry({ operation: "verify_lookup", result: "maybe" })).toBe(false);
    expect(await value(paymentProcessorRetriesTotal, { operation: "status_lookup", result: "scheduled" })).toBe(1);
    expect(await labelValues(paymentProcessorRetriesTotal, "operation")).toEqual(["status_lookup"]);
  });

  it("never throws even if a metric write fails", () => {
    const spy = vi.spyOn(paymentProcessorSessionsTotal, "inc").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => recordSessionTelemetry({ asset: "XLM", outcome: "created" })).not.toThrow();
    spy.mockRestore();
  });
});

describe("PaymentProcessorHealthMonitor (#1478)", () => {
  function monitor() {
    let t = 1_700_000_000_000;
    const m = new PaymentProcessorHealthMonitor(
      { windowMs: 60_000, bucketMs: 1_000, minSamples: 10, degradedRatio: 0.05, unhealthyRatio: 0.2 },
      () => t,
    );
    return { m, advance: (ms) => (t += ms) };
  }

  it("is healthy with no traffic and below min samples", () => {
    const { m } = monitor();
    expect(m.snapshot().status).toBe("healthy");
    for (let i = 0; i < 5; i += 1) m.recordSession("persistence_failed");
    expect(m.snapshot().status).toBe("healthy");
  });

  it("degrades and then becomes unhealthy as session persistence fails", () => {
    const { m } = monitor();
    for (let i = 0; i < 18; i += 1) m.recordSession("created");
    for (let i = 0; i < 2; i += 1) m.recordSession("persistence_failed");
    expect(m.snapshot()).toMatchObject({ status: "degraded", reasons: ["session_failure_ratio"] });
    for (let i = 0; i < 10; i += 1) m.recordSession("persistence_failed");
    expect(m.snapshot()).toMatchObject({
      status: "unhealthy",
      reasons: ["session_failure_ratio_critical"],
    });
  });

  it("does not count client validation failures as processor errors", () => {
    const { m } = monitor();
    for (let i = 0; i < 50; i += 1) m.recordSession("validation_failed");
    m.recordSession("created");
    expect(m.snapshot()).toMatchObject({ status: "healthy", sessions: 1, session_failures: 0 });
  });

  it("tracks verification and refund error ratios", () => {
    const { m } = monitor();
    for (let i = 0; i < 10; i += 1) m.recordVerification(i < 3 ? "error" : "confirmed");
    for (let i = 0; i < 10; i += 1) m.recordRefund(i < 1 ? "failed_on_chain" : "success");
    const snap = m.snapshot();
    expect(snap.verification_error_ratio).toBe(0.3);
    expect(snap.refund_error_ratio).toBe(0.1);
    expect(snap.status).toBe("unhealthy");
    expect(snap.reasons).toEqual(["verification_error_ratio_critical", "refund_error_ratio"]);
  });

  it("degrades on telemetry rejections and exhausted retries", () => {
    const { m } = monitor();
    for (let i = 0; i < 9; i += 1) m.recordEvent();
    m.recordRejected();
    expect(m.snapshot().reasons).toContain("telemetry_rejections");
    const { m: m2 } = monitor();
    m2.recordRetryExhausted();
    expect(m2.snapshot()).toMatchObject({ status: "degraded", reasons: ["retries_exhausted"] });
  });

  it("forgets old buckets once they leave the window", () => {
    const { m, advance } = monitor();
    for (let i = 0; i < 20; i += 1) m.recordSession("persistence_failed");
    expect(m.snapshot().status).toBe("unhealthy");
    advance(61_000);
    expect(m.snapshot()).toMatchObject({ status: "healthy", sessions: 0 });
  });

  it("exposes only counts and ratios", () => {
    const { m } = monitor();
    m.recordSession("created");
    const snap = m.snapshot();
    expect(JSON.stringify(snap)).not.toMatch(/XLM|USDC|G[A-Z2-7]{55}/);
  });
});

describe("shared health + scrape-time gauges (#1478)", () => {
  it("feeds getPaymentProcessorHealth from the recorders", () => {
    recordVerificationTelemetry({ asset: "XLM", outcome: "error" });
    recordRefundTelemetry({ stage: "confirm", outcome: "success" });
    expect(getPaymentProcessorHealth()).toMatchObject({ verifications: 1, verification_errors: 1, refunds: 1 });
  });

  it("refreshes health gauges when /metrics is scraped", async () => {
    for (let i = 0; i < 25; i += 1) recordSessionTelemetry({ asset: "XLM", outcome: "persistence_failed" });
    const text = await paymentProcessorRegister.metrics();
    expect(text).toMatch(/payment_processor_health_state\{[^}]*\} 2/);
    expect(text).toMatch(/payment_processor_session_failure_ratio\{[^}]*\} 1/);
    expect(await value(paymentProcessorHealthState)).toBe(HEALTH_STATE_VALUES.unhealthy);
  });

  it("registers the new series on the processor registry", async () => {
    const text = await paymentProcessorRegister.metrics();
    for (const name of [
      "payment_processor_telemetry_rejected_total",
      "payment_processor_retries_total",
      "payment_processor_health_state",
      "payment_processor_session_failure_ratio",
      "payment_processor_verification_error_ratio",
      "payment_processor_refund_error_ratio",
      "payment_processor_telemetry_rejection_ratio",
    ]) {
      expect(text).toContain(`# TYPE ${name}`);
    }
  });
});
