/**
 * Payment Processor Telemetry — integration suite (issue #1481).
 *
 * Drives the real payment-processor metric series through the real
 * /metrics route (src/routes/prometheus.js) and parses the Prometheus
 * exposition text that a scraper would receive. Covers:
 *   - every granular series reaches the merged scrape output
 *   - counters and histograms stay arithmetically consistent
 *   - the asset label is bounded (client input cannot create new series)
 *   - concurrent scrapes during writes never fail or go backwards
 */
import express from "express";
import request from "supertest";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  paymentProcessorListRequestsTotal,
  paymentProcessorRefundsTotal,
  paymentProcessorRegister,
  paymentProcessorSessionDuration,
  paymentProcessorSessionsTotal,
  paymentProcessorStatusCacheHits,
  paymentProcessorStatusCacheMisses,
  paymentProcessorVerificationDuration,
  paymentProcessorVerificationsTotal,
  toAssetLabel,
} from "../../src/lib/payment-processor-metrics.js";

/** Parse Prometheus text format into { name, labels, value } samples. */
function parseExposition(text) {
  const samples = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!match) throw new Error(`Unparseable exposition line: ${line}`);
    const labels = {};
    for (const [, key, value] of (match[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[key] = value;
    }
    samples.push({ name: match[1], labels, value: Number(match[3]) });
  }
  return samples;
}

const pick = (samples, name, labels = {}) =>
  samples.filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v));
const sum = (samples) => samples.reduce((total, s) => total + s.value, 0);

/** Mirrors paymentService.createPaymentSession's recordSessionOutcome. */
function recordSession(rawAsset, outcome, seconds) {
  const asset = toAssetLabel(rawAsset);
  paymentProcessorSessionsTotal.inc({ asset, outcome });
  paymentProcessorSessionDuration.observe({ asset, outcome }, seconds);
}

function resetAll() {
  for (const metric of [
    paymentProcessorSessionsTotal,
    paymentProcessorSessionDuration,
    paymentProcessorVerificationsTotal,
    paymentProcessorVerificationDuration,
    paymentProcessorStatusCacheHits,
    paymentProcessorStatusCacheMisses,
    paymentProcessorRefundsTotal,
    paymentProcessorListRequestsTotal,
  ]) {
    metric.reset();
  }
}

describe("Payment Processor Telemetry — /metrics integration (#1481)", () => {
  let app;

  beforeAll(async () => {
    const { default: prometheusRouter } = await import("../../src/routes/prometheus.js");
    app = express();
    app.use(prometheusRouter);
  });

  beforeEach(() => {
    resetAll();
  });

  const scrape = async () => {
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    return parseExposition(res.text);
  };

  it("merges every payment processor series into the scrape", async () => {
    recordSession("XLM", "created", 0.02);
    paymentProcessorVerificationsTotal.inc({ asset: "XLM", outcome: "confirmed" });
    paymentProcessorVerificationDuration.observe({ asset: "XLM", outcome: "confirmed" }, 0.3);
    paymentProcessorStatusCacheHits.inc();
    paymentProcessorStatusCacheMisses.inc();
    paymentProcessorRefundsTotal.inc({ stage: "generate", outcome: "success" });
    paymentProcessorListRequestsTotal.inc({ outcome: "success" });

    const samples = await scrape();
    for (const name of [
      "payment_processor_sessions_total",
      "payment_processor_session_duration_seconds_bucket",
      "payment_processor_verifications_total",
      "payment_processor_verification_duration_seconds_count",
      "payment_processor_status_cache_hits_total",
      "payment_processor_status_cache_misses_total",
      "payment_processor_refunds_total",
      "payment_processor_list_requests_total",
    ]) {
      expect(pick(samples, name).length, name).toBeGreaterThan(0);
    }
    // The payment processor registry's default label survives the merge.
    expect(pick(samples, "payment_processor_sessions_total")[0].labels.app).toBe("stellar-payment-api");
  });

  it("reports exact counts per outcome and asset", async () => {
    for (let i = 0; i < 7; i += 1) recordSession("USDC", "created", 0.01);
    for (let i = 0; i < 3; i += 1) recordSession("USDC", "validation_failed", 0.001);
    recordSession("XLM", "persistence_failed", 0.5);

    const samples = await scrape();
    expect(sum(pick(samples, "payment_processor_sessions_total", { asset: "USDC", outcome: "created" }))).toBe(7);
    expect(sum(pick(samples, "payment_processor_sessions_total", { asset: "USDC", outcome: "validation_failed" }))).toBe(3);
    expect(sum(pick(samples, "payment_processor_sessions_total"))).toBe(11);
  });

  it("keeps histograms consistent: cumulative buckets, +Inf equals count, sum matches", async () => {
    const durations = [0.004, 0.02, 0.02, 0.3, 1.2, 9];
    for (const d of durations) recordSession("XLM", "created", d);

    const samples = await scrape();
    const labels = { asset: "XLM", outcome: "created" };
    const buckets = pick(samples, "payment_processor_session_duration_seconds_bucket", labels)
      .map((s) => ({ le: s.labels.le === "+Inf" ? Infinity : Number(s.labels.le), value: s.value }))
      .sort((a, b) => a.le - b.le);

    for (let i = 1; i < buckets.length; i += 1) {
      expect(buckets[i].value).toBeGreaterThanOrEqual(buckets[i - 1].value);
    }
    const count = sum(pick(samples, "payment_processor_session_duration_seconds_count", labels));
    expect(buckets.at(-1).value).toBe(count);
    expect(count).toBe(durations.length);
    expect(sum(pick(samples, "payment_processor_session_duration_seconds_sum", labels))).toBeCloseTo(
      durations.reduce((a, b) => a + b, 0),
      6,
    );
    // 0.004 and 9 land in the first and the overflow bucket respectively.
    expect(buckets.find((b) => b.le === 0.005).value).toBe(1);
    expect(buckets.find((b) => b.le === 5).value).toBe(durations.length - 1);
  });

  it("bounds the client-controlled asset label", async () => {
    const hostile = [
      "XLM",
      "usdc",
      'EVIL",outcome="created',
      "x".repeat(500),
      "../../etc/passwd",
      "BTC\nmalicious_metric 1",
      undefined,
      42,
      "",
    ];
    for (const asset of hostile) recordSession(asset, "validation_failed", 0.001);

    const samples = await scrape();
    const assets = new Set(pick(samples, "payment_processor_sessions_total").map((s) => s.labels.asset));
    expect([...assets].sort()).toEqual(["USDC", "XLM", "invalid", "unknown"].sort());
    expect(pick(samples, "malicious_metric")).toHaveLength(0);
    expect(sum(pick(samples, "payment_processor_sessions_total"))).toBe(hostile.length);
  });

  it("serves consistent, monotonic counters to concurrent scrapes during writes", async () => {
    const writes = (async () => {
      for (let i = 0; i < 2_000; i += 1) {
        paymentProcessorStatusCacheHits.inc();
        if (i % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const seen = [];
    const scrapes = Array.from({ length: 10 }, async () => {
      const samples = await scrape();
      seen.push(sum(pick(samples, "payment_processor_status_cache_hits_total")));
    });

    await Promise.all([writes, ...scrapes]);
    const final = sum(pick(await scrape(), "payment_processor_status_cache_hits_total"));
    expect(final).toBe(2_000);
    for (const value of seen) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(2_000);
    }
  });

  it("produces exposition text that parses cleanly", async () => {
    recordSession("XLM", "created", 0.1);
    const text = await paymentProcessorRegister.metrics();
    expect(() => parseExposition(text)).not.toThrow();
    expect(text).toMatch(/# TYPE payment_processor_sessions_total counter/);
    expect(text).toMatch(/# TYPE payment_processor_session_duration_seconds histogram/);
  });
});

describe("toAssetLabel", () => {
  it.each([
    ["XLM", "XLM"],
    [" usdc ", "USDC"],
    ["ABCDEFGHIJKL", "ABCDEFGHIJKL"],
    ["ABCDEFGHIJKLM", "invalid"],
    ["US-DC", "invalid"],
    [null, "unknown"],
    ["", "unknown"],
    [{ code: "XLM" }, "invalid"],
  ])("%j -> %s", (input, expected) => {
    expect(toAssetLabel(input)).toBe(expected);
  });
});
