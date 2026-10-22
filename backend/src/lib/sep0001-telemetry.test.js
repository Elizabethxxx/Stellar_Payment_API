/**
 * SEP-0001 alert metrics and health telemetry (#1458).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  Sep0001HealthMonitor,
  getSep0001Health,
  recordSep0001Request,
  resetSep0001Health,
  sep0001DocumentSizeBytes,
  sep0001GenerationDuration,
  sep0001LastSuccessTimestamp,
  sep0001Register,
  sep0001RejectedFieldsTotal,
  sep0001RequestsTotal,
} from "./sep0001-telemetry.js";

async function value(metric, labels = {}) {
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}

beforeEach(() => {
  sep0001Register.resetMetrics();
  resetSep0001Health();
});

describe("recordSep0001Request", () => {
  it("counts outcomes, latency, size and last success", async () => {
    const before = Date.now() / 1000;
    recordSep0001Request({ outcome: "success", durationSeconds: 0.004, documentBytes: 512 });
    recordSep0001Request({ outcome: "not_found", durationSeconds: 0.002 });

    expect(await value(sep0001RequestsTotal, { outcome: "success" })).toBe(1);
    expect(await value(sep0001RequestsTotal, { outcome: "not_found" })).toBe(1);
    const { values } = await sep0001GenerationDuration.get();
    expect(values.find((v) => v.metricName.endsWith("_count") && v.labels.outcome === "success").value).toBe(1);
    const size = await sep0001DocumentSizeBytes.get();
    expect(size.values.find((v) => v.metricName.endsWith("_sum")).value).toBe(512);
    expect(await value(sep0001LastSuccessTimestamp)).toBeGreaterThanOrEqual(before);
  });

  it("maps unknown outcomes, fields and reasons to bounded labels", async () => {
    recordSep0001Request({
      outcome: "merchant-1234",
      durationSeconds: 0.001,
      rejections: [
        { field: "x-injected-label", reason: "anything" },
        { field: "email", reason: "invalid_email" },
      ],
    });
    expect(await value(sep0001RequestsTotal, { outcome: "generation_error" })).toBe(1);
    expect(await value(sep0001RejectedFieldsTotal, { field: "other", reason: "other" })).toBe(1);
    expect(await value(sep0001RejectedFieldsTotal, { field: "email", reason: "invalid_email" })).toBe(1);
  });

  it("ignores invalid durations instead of throwing", () => {
    expect(() => recordSep0001Request({ outcome: "success", durationSeconds: Number.NaN })).not.toThrow();
    expect(() => recordSep0001Request({ outcome: "success", durationSeconds: -1 })).not.toThrow();
  });

  it("feeds the module health monitor", () => {
    recordSep0001Request({ outcome: "success", durationSeconds: 0 });
    expect(getSep0001Health()).toMatchObject({ status: "healthy", total: 1, success: 1 });
  });

  it("degrades health when a secret seed is refused as SIGNING_KEY", () => {
    recordSep0001Request({
      outcome: "success",
      durationSeconds: 0,
      rejections: [{ field: "SIGNING_KEY", reason: "secret_seed" }],
    });
    expect(getSep0001Health()).toMatchObject({
      status: "degraded",
      reasons: ["secret_signing_key_refused"],
      sensitive_rejections: 1,
    });
  });

  it("exposes health state and error ratio through the registry at scrape time", async () => {
    for (let i = 0; i < 10; i += 1) {
      recordSep0001Request({ outcome: i < 5 ? "lookup_error" : "success", durationSeconds: 0 });
    }
    const text = await sep0001Register.metrics();
    expect(text).toMatch(/sep0001_health_state\{[^}]*\} 2/);
    expect(text).toMatch(/sep0001_error_ratio\{[^}]*\} 0\.5/);
  });
});

describe("Sep0001HealthMonitor", () => {
  const options = {
    windowMs: 60_000,
    bucketMs: 1_000,
    minSamples: 10,
    degradedErrorRatio: 0.05,
    unhealthyErrorRatio: 0.25,
    sensitiveRejectionThreshold: 1,
  };

  function monitorAt(start = 1_700_000_000_000) {
    let now = start;
    const monitor = new Sep0001HealthMonitor(options, () => now);
    return { monitor, advance: (ms) => (now += ms) };
  }

  it("stays healthy below minSamples even when every request fails", () => {
    const { monitor } = monitorAt();
    for (let i = 0; i < 9; i += 1) monitor.record("generation_error");
    expect(monitor.snapshot()).toMatchObject({ status: "healthy", total: 9, error_ratio: 1 });
  });

  it("is degraded between the two error thresholds", () => {
    const { monitor } = monitorAt();
    for (let i = 0; i < 18; i += 1) monitor.record("success");
    monitor.record("lookup_error");
    monitor.record("lookup_error");
    expect(monitor.snapshot()).toMatchObject({ status: "degraded", reasons: ["error_ratio_elevated"], error_ratio: 0.1 });
  });

  it("is unhealthy at or above the unhealthy threshold", () => {
    const { monitor } = monitorAt();
    for (let i = 0; i < 6; i += 1) monitor.record("success");
    for (let i = 0; i < 4; i += 1) monitor.record("generation_error");
    expect(monitor.snapshot()).toMatchObject({ status: "unhealthy", reasons: ["error_ratio_exceeded"] });
  });

  it("does not count client errors (400/404) as server errors", () => {
    const { monitor } = monitorAt();
    for (let i = 0; i < 20; i += 1) monitor.record(i % 2 ? "invalid_request" : "not_found");
    expect(monitor.snapshot()).toMatchObject({ status: "healthy", error_ratio: 0, invalid_request: 10, not_found: 10 });
  });

  it("recovers once errors age out of the rolling window", () => {
    const { monitor, advance } = monitorAt();
    for (let i = 0; i < 20; i += 1) monitor.record("lookup_error");
    expect(monitor.snapshot().status).toBe("unhealthy");
    advance(61_000);
    expect(monitor.snapshot()).toMatchObject({ status: "healthy", total: 0 });
    expect(monitor.snapshot().last_error_at).not.toBeNull();
  });

  it("uses constant memory regardless of traffic", () => {
    const { monitor, advance } = monitorAt();
    for (let i = 0; i < 5_000; i += 1) {
      monitor.record("success");
      advance(50);
    }
    expect(monitor.buckets).toHaveLength(60);
  });
});
