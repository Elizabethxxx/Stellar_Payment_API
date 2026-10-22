/**
 * Idempotency Key Manager — retry with exponential backoff (#1464).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "./logger.js";
import {
  computeBackoffDelay,
  idempotencyRedisOperationsTotal,
  idempotencyRedisRetriesTotal,
  idempotencyRegister,
  isRetryableRedisError,
  resolveIdempotencyRetryOptions,
  withIdempotencyRetry,
} from "./idempotency-retry.js";

const OPTIONS = { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 40, totalBudgetMs: 1_000, jitterRatio: 0 };

function transient(message = "Socket closed unexpectedly") {
  const err = new Error(message);
  err.name = "SocketClosedUnexpectedlyError";
  return err;
}

async function value(metric, labels) {
  const { values } = await metric.get();
  return values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value ?? 0;
}

function harness(overrides = {}) {
  let clock = 0;
  const sleeps = [];
  return {
    sleeps,
    options: {
      ...OPTIONS,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      random: () => 0.5,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  idempotencyRegister.resetMetrics();
});

describe("computeBackoffDelay", () => {
  it("doubles from the base delay and caps at maxDelayMs", () => {
    expect([0, 1, 2, 3, 4].map((a) => computeBackoffDelay(a, OPTIONS))).toEqual([10, 20, 40, 40, 40]);
  });

  it("applies symmetric jitter within ±jitterRatio", () => {
    const opts = { ...OPTIONS, jitterRatio: 0.2 };
    expect(computeBackoffDelay(1, opts, () => 0)).toBe(16);
    expect(computeBackoffDelay(1, opts, () => 1)).toBe(24);
    expect(computeBackoffDelay(1, opts, () => 0.5)).toBe(20);
  });

  it("never returns a negative delay", () => {
    expect(computeBackoffDelay(0, { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 5 }, () => 0)).toBe(0);
  });
});

describe("isRetryableRedisError", () => {
  it.each([
    ["socket closed", transient()],
    ["connection timeout", Object.assign(new Error("Connection timeout"), { name: "ConnectionTimeoutError" })],
    ["ECONNRESET", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["LOADING reply", new Error("LOADING Redis is loading the dataset in memory")],
    ["READONLY failover", new Error("READONLY You can't write against a read only replica.")],
    ["TRYAGAIN", new Error("TRYAGAIN Multiple keys request during rehashing of slot")],
  ])("retries %s", (_label, err) => {
    expect(isRetryableRedisError(err)).toBe(true);
  });

  it.each([
    ["closed client", Object.assign(new Error("The client is closed"), { name: "ClientClosedError" })],
    ["auth error", new Error("NOAUTH Authentication required.")],
    ["wrong type", new Error("WRONGTYPE Operation against a key holding the wrong kind of value")],
    ["corrupt cache JSON", new SyntaxError("Unexpected token } in JSON")],
    ["null", null],
  ])("does not retry %s", (_label, err) => {
    expect(isRetryableRedisError(err)).toBe(false);
  });
});

describe("resolveIdempotencyRetryOptions", () => {
  it("uses defaults and clamps env overrides to safe bounds", () => {
    expect(resolveIdempotencyRetryOptions({})).toEqual({
      maxRetries: 2,
      baseDelayMs: 25,
      maxDelayMs: 250,
      totalBudgetMs: 500,
      jitterRatio: 0.2,
    });
    expect(
      resolveIdempotencyRetryOptions({
        IDEMPOTENCY_REDIS_MAX_RETRIES: "99",
        IDEMPOTENCY_REDIS_RETRY_BASE_MS: "0",
        IDEMPOTENCY_REDIS_RETRY_MAX_MS: "999999",
        IDEMPOTENCY_REDIS_RETRY_BUDGET_MS: "-5",
      }),
    ).toEqual({ maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5000, totalBudgetMs: 0, jitterRatio: 0.2 });
    expect(resolveIdempotencyRetryOptions({ IDEMPOTENCY_REDIS_MAX_RETRIES: "abc" }).maxRetries).toBe(2);
  });

  it("never lets maxDelayMs fall below the base delay", () => {
    expect(
      resolveIdempotencyRetryOptions({ IDEMPOTENCY_REDIS_RETRY_BASE_MS: "100", IDEMPOTENCY_REDIS_RETRY_MAX_MS: "10" })
        .maxDelayMs,
    ).toBe(100);
  });
});

describe("withIdempotencyRetry", () => {
  it("returns immediately on success without sleeping", async () => {
    const { options, sleeps } = harness();
    await expect(withIdempotencyRetry("get", async () => "cached", options)).resolves.toBe("cached");
    expect(sleeps).toEqual([]);
    expect(await value(idempotencyRedisOperationsTotal, { operation: "get", outcome: "success" })).toBe(1);
  });

  it("recovers from transient errors with exponential backoff", async () => {
    const { options, sleeps } = harness();
    const fn = vi.fn().mockRejectedValueOnce(transient()).mockRejectedValueOnce(transient()).mockResolvedValue("ok");

    await expect(withIdempotencyRetry("set", fn, options)).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]);
    expect(await value(idempotencyRedisRetriesTotal, { operation: "set" })).toBe(2);
    expect(await value(idempotencyRedisOperationsTotal, { operation: "set", outcome: "recovered" })).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and rethrows the last error", async () => {
    const { options, sleeps } = harness();
    const fn = vi.fn().mockRejectedValue(transient("still down"));

    await expect(withIdempotencyRetry("lookup", fn, options)).rejects.toThrow("still down");

    expect(fn).toHaveBeenCalledTimes(4); // 1 + 3 retries
    expect(sleeps).toEqual([10, 20, 40]);
    expect(await value(idempotencyRedisOperationsTotal, { operation: "lookup", outcome: "failed" })).toBe(1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "lookup", attempts: 4 }),
      "Idempotency Redis operation failed after retries",
    );
  });

  it("stops early when the next delay would exceed the latency budget", async () => {
    const { options, sleeps } = harness({ totalBudgetMs: 25 });
    const fn = vi.fn().mockRejectedValue(transient());

    await expect(withIdempotencyRetry("get", fn, options)).rejects.toThrow();

    expect(sleeps).toEqual([10]); // 10 + 20 > 25
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors", async () => {
    const { options, sleeps } = harness();
    const closed = Object.assign(new Error("The client is closed"), { name: "ClientClosedError" });
    const fn = vi.fn().mockRejectedValue(closed);

    await expect(withIdempotencyRetry("get", fn, options)).rejects.toBe(closed);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(await value(idempotencyRedisOperationsTotal, { operation: "get", outcome: "non_retryable" })).toBe(1);
  });

  it("with maxRetries 0 behaves like a single attempt", async () => {
    const { options } = harness({ maxRetries: 0 });
    const fn = vi.fn().mockRejectedValue(transient());
    await expect(withIdempotencyRetry("get", fn, options)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("labels unknown operations with a bounded value", async () => {
    const { options } = harness();
    await withIdempotencyRetry("merchant-123:key", async () => 1, options);
    expect(await value(idempotencyRedisOperationsTotal, { operation: "get", outcome: "success" })).toBe(1);
  });
});
