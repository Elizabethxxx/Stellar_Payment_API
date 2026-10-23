import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  WebSocketRelayHealthMonitor,
  attachRelayHealthSource,
  getWebSocketRelayHealth,
  recordRelayDelivery,
  recordRelayRetry,
  resetWebSocketRelayHealth,
  safeLabel,
  websocketRelayTelemetryRegister,
} from "./websocket-relay-telemetry.js";
import { CircuitBreaker, DeadLetterQueue } from "./websocket-relay-recovery.js";

function make(overrides = {}) {
  let clock = 1_700_000_000_000;
  const monitor = new WebSocketRelayHealthMonitor(
    { windowMs: 60_000, bucketMs: 5_000, minSamples: 10, failureRatioThreshold: 0.1, dlqDegradedThreshold: 1, dlqUnhealthyThreshold: 50, ...overrides },
    () => clock,
  );
  return {
    monitor,
    advance(ms) {
      clock += ms;
    },
  };
}

const record = (monitor, outcome, times) => {
  for (let i = 0; i < times; i += 1) monitor.recordDelivery(outcome);
};

beforeEach(() => {
  resetWebSocketRelayHealth();
});

describe("WebSocketRelayHealthMonitor", () => {
  it("starts healthy with no data", () => {
    const { monitor } = make();
    expect(monitor.snapshot()).toMatchObject({ status: "healthy", reasons: [], deliveries: 0, failure_ratio: 0, circuit_state: "CLOSED", dlq_size: 0 });
  });

  it("goes unhealthy when the failure ratio crosses the threshold with enough samples", () => {
    const { monitor } = make();
    record(monitor, "delivered", 8);
    record(monitor, "dead_lettered", 2);
    const snap = monitor.snapshot();
    expect(snap.failure_ratio).toBe(0.2);
    expect(snap).toMatchObject({ status: "unhealthy", reasons: ["failure_ratio_exceeded"] });
  });

  it("ignores the ratio below minSamples", () => {
    const { monitor } = make();
    record(monitor, "failed", 3);
    expect(monitor.snapshot().status).toBe("healthy");
  });

  it("counts recovered deliveries as successes", () => {
    const { monitor } = make();
    record(monitor, "recovered", 20);
    expect(monitor.snapshot()).toMatchObject({ status: "healthy", recovered: 20, failure_ratio: 0 });
  });

  it("forgets data outside the rolling window", () => {
    const { monitor, advance } = make();
    record(monitor, "failed", 20);
    expect(monitor.snapshot().status).toBe("unhealthy");
    advance(61_000);
    expect(monitor.snapshot()).toMatchObject({ status: "healthy", deliveries: 0 });
  });

  it("reflects the live circuit breaker state", async () => {
    const { monitor } = make();
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1_000, now: () => 0 });
    monitor.attach({ circuitBreaker: breaker, dlq: new DeadLetterQueue() });
    await breaker.call(() => Promise.reject(new Error("down"))).catch(() => {});
    expect(monitor.snapshot()).toMatchObject({ status: "unhealthy", circuit_state: "OPEN", reasons: ["circuit_open"] });
  });

  it("degrades on a non-empty DLQ and fails on a large backlog", () => {
    const { monitor } = make();
    const dlq = new DeadLetterQueue();
    monitor.attach({ dlq });
    dlq.push({}, new Error("x"));
    expect(monitor.snapshot()).toMatchObject({ status: "degraded", reasons: ["dlq_not_empty"], dlq_size: 1 });
    for (let i = 0; i < 60; i += 1) dlq.push({}, new Error("x"));
    expect(monitor.snapshot()).toMatchObject({ status: "unhealthy", reasons: ["dlq_backlog"] });
  });

  it("degrades after retries were exhausted in the window", () => {
    const { monitor } = make();
    monitor.recordRetryExhausted();
    expect(monitor.snapshot()).toMatchObject({ status: "degraded", retries_exhausted: 1 });
  });

  it("survives a health source that throws", () => {
    const { monitor } = make();
    monitor.attach({ circuitBreaker: { getStatus: () => { throw new Error("boom"); } } });
    expect(monitor.snapshot().status).toBe("healthy");
  });

  it("keeps memory constant regardless of traffic", () => {
    const { monitor, advance } = make();
    for (let i = 0; i < 10_000; i += 1) {
      monitor.recordDelivery("delivered");
      advance(37);
    }
    expect(monitor.buckets).toHaveLength(12);
  });
});

describe("recording helpers", () => {
  it("restricts labels to known values", () => {
    expect(safeLabel("evil\nlabel", new Set(["a"]), "fallback")).toBe("fallback");
  });

  it("records deliveries and retries with bounded labels", async () => {
    recordRelayDelivery("delivered");
    recordRelayDelivery("<script>");
    recordRelayRetry("deliver", "scheduled", 250);
    recordRelayRetry("not-an-op", "nonsense");

    const text = await websocketRelayTelemetryRegister.metrics();
    expect(text).toMatch(/websocket_relay_deliveries_total\{[^}]*outcome="delivered"/);
    expect(text).toContain('outcome="failed"');
    expect(text).not.toContain("<script>");
    expect(text).toMatch(/websocket_relay_retries_total\{[^}]*operation="other",result="exhausted"/);
    expect(text).toContain("websocket_relay_retry_delay_seconds_bucket");
    expect(text).not.toContain("not-an-op");
  });

  it("refreshes health gauges at scrape time", async () => {
    const dlq = new DeadLetterQueue();
    dlq.push({}, new Error("x"));
    attachRelayHealthSource({ dlq, circuitBreaker: new CircuitBreaker() });

    const text = await websocketRelayTelemetryRegister.metrics();
    expect(text).toMatch(/websocket_relay_health_state\{[^}]*\} 1/);
    expect(text).toMatch(/websocket_relay_dlq_depth\{[^}]*\} 1/);
    expect(text).toMatch(/websocket_relay_circuit_open\{[^}]*\} 0/);
    expect(getWebSocketRelayHealth().status).toBe("degraded");
  });

  it("exposes no message content in the health snapshot", () => {
    const dlq = new DeadLetterQueue();
    dlq.push({ payment_id: "pay_secret_123" }, new Error("token=abc"));
    attachRelayHealthSource({ dlq });
    const body = JSON.stringify(getWebSocketRelayHealth());
    expect(body).not.toContain("pay_secret_123");
    expect(body).not.toContain("token=abc");
  });
});

describe("alert rules (issue #1453)", () => {
  it("only reference metrics the relay registries expose", async () => {
    const { relayMetricsRegister } = await import("./websocket-relay-metrics.js");
    const rules = readFileSync(new URL("../../docs/alerts/websocket-relay.rules.yml", import.meta.url), "utf8");
    const referenced = new Set(
      [...rules.matchAll(/\b((?:websocket_relay|relay)_[a-z0-9_]+)/g)].map(([, name]) =>
        name.replace(/_(bucket|sum|count)$/, ""),
      ),
    );
    const registered = new Set(
      [...websocketRelayTelemetryRegister.getMetricsAsArray(), ...relayMetricsRegister.getMetricsAsArray()].map(
        (metric) => metric.name,
      ),
    );
    expect(referenced.size).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(registered, `alert rule references unknown metric ${name}`).toContain(name);
    }
  });
});
