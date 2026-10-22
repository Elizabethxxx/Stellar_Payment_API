import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "./logger.js";
import {
  DEFAULT_RELAY_RETRY_OPTIONS,
  RelayRetryAbortedError,
  computeRelayBackoffDelay,
  deliverRelayMessage,
  isRetryableRelayError,
  redriveDeadLetters,
  resolveRelayRetryOptions,
  withRelayRetry,
} from "./websocket-relay-retry.js";
import { CircuitBreaker, DeadLetterQueue } from "./websocket-relay-recovery.js";
import {
  getWebSocketRelayHealth,
  resetWebSocketRelayHealth,
  websocketRelayTelemetryRegister,
} from "./websocket-relay-telemetry.js";

const netError = (code = "ECONNRESET") => Object.assign(new Error("socket hang up"), { code });
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

/** Instant, recorded sleeps and deterministic jitter (max of the window). */
function fastOptions(extra = {}) {
  const sleeps = [];
  return {
    sleeps,
    options: {
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      maxAttempts: 4,
      random: () => 0.999,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...extra,
    },
  };
}

async function metricValue(name, labels) {
  const metric = await websocketRelayTelemetryRegister.getSingleMetric(name).get();
  return metric.values
    .filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWebSocketRelayHealth();
});

describe("resolveRelayRetryOptions", () => {
  it("uses defaults", () => {
    expect(resolveRelayRetryOptions({}, {})).toEqual(DEFAULT_RELAY_RETRY_OPTIONS);
  });

  it("reads the environment and lets explicit options win", () => {
    const env = { RELAY_RETRY_MAX_ATTEMPTS: "3", RELAY_RETRY_BASE_DELAY_MS: "50", RELAY_RETRY_MAX_DELAY_MS: "500" };
    expect(resolveRelayRetryOptions({}, env)).toMatchObject({ maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 500 });
    expect(resolveRelayRetryOptions({ maxAttempts: 2 }, env).maxAttempts).toBe(2);
  });

  it("clamps hostile or broken values", () => {
    const resolved = resolveRelayRetryOptions(
      { maxAttempts: 1_000, baseDelayMs: -5, maxDelayMs: "abc", maxElapsedMs: 1e12 },
      {},
    );
    expect(resolved.maxAttempts).toBe(10);
    expect(resolved.baseDelayMs).toBe(0);
    expect(resolved.maxDelayMs).toBe(DEFAULT_RELAY_RETRY_OPTIONS.maxDelayMs);
    expect(resolved.maxElapsedMs).toBe(300_000);
  });

  it("never allows fewer than one attempt", () => {
    expect(resolveRelayRetryOptions({ maxAttempts: 0 }, {}).maxAttempts).toBe(1);
  });
});

describe("computeRelayBackoffDelay", () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 1_000 };

  it("doubles the ceiling per retry and caps it", () => {
    expect([0, 1, 2, 3, 4, 10].map((n) => computeRelayBackoffDelay(n, opts, () => 1))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
  });

  it("applies full jitter", () => {
    expect(computeRelayBackoffDelay(2, opts, () => 0)).toBe(0);
    expect(computeRelayBackoffDelay(2, opts, () => 0.5)).toBe(200);
  });

  it("tolerates bad random sources and indices", () => {
    expect(computeRelayBackoffDelay(1, opts, () => NaN)).toBe(0);
    expect(computeRelayBackoffDelay(1, opts, () => 7)).toBe(200);
    expect(computeRelayBackoffDelay(-4, opts, () => 1)).toBe(100);
    expect(computeRelayBackoffDelay(1e9, opts, () => 1)).toBe(1_000);
  });
});

describe("isRetryableRelayError", () => {
  it.each([
    ["network code", netError("ECONNREFUSED")],
    ["timeout message", new Error("request timed out")],
    ["503", httpError(503)],
    ["429", httpError(429)],
    ["abnormal close 1006", Object.assign(new Error("closed"), { closeCode: 1006 })],
    ["explicit retryable", Object.assign(new Error("x"), { retryable: true })],
  ])("retries %s", (_label, err) => {
    expect(isRetryableRelayError(err)).toBe(true);
  });

  it.each([
    ["open circuit", Object.assign(new Error("open"), { circuitOpen: true })],
    ["400 validation", httpError(400)],
    ["401 auth", httpError(401)],
    ["501", httpError(501)],
    ["policy close 1008", Object.assign(new Error("policy"), { closeCode: 1008 })],
    ["explicit non-retryable", Object.assign(netError(), { retryable: false })],
    ["plain bug", new TypeError("x is undefined")],
    ["non-object", "boom"],
  ])("does not retry %s", (_label, err) => {
    expect(isRetryableRelayError(err)).toBe(false);
  });
});

describe("withRelayRetry", () => {
  it("returns the first successful result without sleeping", async () => {
    const { options, sleeps } = fastOptions();
    const op = vi.fn().mockResolvedValue("ok");
    await expect(withRelayRetry(op, options)).resolves.toEqual({ value: "ok", attempts: 1 });
    expect(sleeps).toEqual([]);
  });

  it("retries transient failures with exponential backoff and records recovery", async () => {
    const { options, sleeps } = fastOptions({ operation: "reconnect" });
    const op = vi.fn().mockRejectedValueOnce(netError()).mockRejectedValueOnce(httpError(502)).mockResolvedValue("ok");

    const result = await withRelayRetry(op, options);

    expect(result).toEqual({ value: "ok", attempts: 3 });
    expect(sleeps).toEqual([99, 199]);
    expect(op).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2 }));
    expect(await metricValue("websocket_relay_retries_total", { operation: "reconnect", result: "scheduled" })).toBeGreaterThanOrEqual(2);
    expect(await metricValue("websocket_relay_retries_total", { operation: "reconnect", result: "recovered" })).toBeGreaterThanOrEqual(1);
  });

  it("stops after maxAttempts and marks the error", async () => {
    const { options } = fastOptions({ maxAttempts: 3 });
    const op = vi.fn().mockRejectedValue(netError());

    const err = await withRelayRetry(op, options).catch((e) => e);

    expect(op).toHaveBeenCalledTimes(3);
    expect(err.retryAttempts).toBe(3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 3, reason: "max_attempts" }),
      "WebSocket relay operation failed after exhausting retries",
    );
    expect(getWebSocketRelayHealth().retries_exhausted).toBe(1);
  });

  it("does not retry non-retryable errors", async () => {
    const { options, sleeps } = fastOptions();
    const op = vi.fn().mockRejectedValue(httpError(400));
    const err = await withRelayRetry(op, options).catch((e) => e);
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(err.retryAttempts).toBe(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("respects the total time budget", async () => {
    let clock = 0;
    const { options } = fastOptions({
      maxAttempts: 10,
      maxElapsedMs: 250,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const op = vi.fn().mockRejectedValue(netError());

    const err = await withRelayRetry(op, options).catch((e) => e);

    // 99 + 199 = 298 > 250, so only the first wait fits.
    expect(op).toHaveBeenCalledTimes(2);
    expect(err.retryAttempts).toBe(2);
  });

  it("aborts before the first attempt when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const op = vi.fn();
    await expect(withRelayRetry(op, { signal: controller.signal })).rejects.toBeInstanceOf(RelayRetryAbortedError);
    expect(op).not.toHaveBeenCalled();
  });

  it("aborts during a backoff wait", async () => {
    const controller = new AbortController();
    const op = vi.fn().mockRejectedValue(netError());
    const pending = withRelayRetry(op, { signal: controller.signal, baseDelayMs: 10_000, maxDelayMs: 10_000, random: () => 1 });
    await vi.waitFor(() => expect(op).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RelayRetryAbortedError);
  });

  it("keeps message content out of the logs", async () => {
    const { options } = fastOptions({ maxAttempts: 2 });
    const secret = "payment_id=pay_123 token=abc";
    const op = vi.fn().mockRejectedValue(Object.assign(new Error("x".repeat(500)), { code: "ECONNRESET" }));
    await withRelayRetry(op, { ...options, operation: "deliver" }).catch(() => {});
    const logged = JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toContain(secret);
    for (const [fields] of logger.warn.mock.calls) {
      expect(fields.err.length).toBeLessThanOrEqual(200);
    }
  });

  it("ignores a throwing onRetry observer", async () => {
    const { options } = fastOptions({ onRetry: () => { throw new Error("observer"); } });
    const op = vi.fn().mockRejectedValueOnce(netError()).mockResolvedValue("ok");
    await expect(withRelayRetry(op, options)).resolves.toMatchObject({ value: "ok" });
  });
});

describe("deliverRelayMessage", () => {
  const message = { type: "event", payment_id: "pay_1", event_type: "payment.confirmed" };

  it("delivers and counts a first-attempt success", async () => {
    const { options } = fastOptions();
    const send = vi.fn().mockResolvedValue("ack");
    const result = await deliverRelayMessage(message, send, options);
    expect(result).toEqual({ delivered: true, attempts: 1, value: "ack" });
    expect(send).toHaveBeenCalledWith(message, expect.objectContaining({ attempt: 1 }));
    expect(getWebSocketRelayHealth().delivered).toBe(1);
  });

  it("counts a delivery after retries as recovered", async () => {
    const { options } = fastOptions();
    const send = vi.fn().mockRejectedValueOnce(netError()).mockResolvedValue("ack");
    await deliverRelayMessage(message, send, options);
    expect(getWebSocketRelayHealth().recovered).toBe(1);
  });

  it("dead-letters a message after exhausting retries", async () => {
    const { options } = fastOptions({ maxAttempts: 3 });
    const dlq = new DeadLetterQueue();
    const send = vi.fn().mockRejectedValue(netError());

    const result = await deliverRelayMessage(message, send, { ...options, dlq });

    expect(result).toMatchObject({ delivered: false, deadLettered: true, attempts: 3 });
    expect(dlq.size).toBe(1);
    expect(dlq.getAll()[0]).toMatchObject({ message, retryCount: 3, errorMessage: "socket hang up" });
    expect(getWebSocketRelayHealth().dead_lettered).toBe(1);
  });

  it("throws when there is no DLQ", async () => {
    const { options } = fastOptions({ maxAttempts: 2 });
    await expect(deliverRelayMessage(message, vi.fn().mockRejectedValue(netError()), options)).rejects.toThrow("socket hang up");
    expect(getWebSocketRelayHealth().failed).toBe(1);
  });

  it("does not retry into an open circuit breaker", async () => {
    const { options, sleeps } = fastOptions();
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const dlq = new DeadLetterQueue();
    const send = vi.fn().mockRejectedValue(httpError(503));

    // First message trips the breaker on its first failure, then the retry
    // hits the OPEN breaker and stops immediately.
    const result = await deliverRelayMessage(message, send, { ...options, circuitBreaker: breaker, dlq });

    expect(breaker.state).toBe("OPEN");
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(1);
    expect(result.error.circuitOpen).toBe(true);
    expect(dlq.size).toBe(1);
  });

  it("validates its arguments", async () => {
    await expect(deliverRelayMessage(message, null)).rejects.toThrow(TypeError);
  });
});

describe("redriveDeadLetters", () => {
  it("redelivers queued messages and re-queues the ones that still fail", async () => {
    const { options } = fastOptions({ maxAttempts: 2 });
    const dlq = new DeadLetterQueue();
    dlq.push({ id: 1 }, new Error("old"), 3);
    dlq.push({ id: 2 }, new Error("old"), 1);
    const send = vi.fn(async (msg) => {
      if (msg.id === 2) throw netError();
      return "ack";
    });

    const result = await redriveDeadLetters(dlq, send, options);

    expect(result).toEqual({ redelivered: 1, failed: 1 });
    expect(dlq.size).toBe(1);
    expect(dlq.getAll()[0]).toMatchObject({ message: { id: 2 }, retryCount: 3 });
  });

  it("processes at most `limit` entries and never re-processes re-queued ones", async () => {
    const { options } = fastOptions({ maxAttempts: 1 });
    const dlq = new DeadLetterQueue();
    for (let i = 0; i < 5; i += 1) dlq.push({ id: i }, new Error("old"));
    const send = vi.fn().mockRejectedValue(netError());

    const result = await redriveDeadLetters(dlq, send, { ...options, limit: 3 });

    expect(send).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ redelivered: 0, failed: 3 });
    expect(dlq.size).toBe(5);
  });

  it("requires a queue", async () => {
    await expect(redriveDeadLetters(null, vi.fn())).rejects.toThrow(TypeError);
  });
});
