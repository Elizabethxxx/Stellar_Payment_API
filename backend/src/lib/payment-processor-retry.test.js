import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  DEFAULT_PROCESSOR_RETRY_OPTIONS,
  resolveProcessorRetryOptions,
  retryProcessorRead,
} from "./payment-processor-retry.js";
import {
  getPaymentProcessorHealth,
  paymentProcessorRetriesTotal,
  resetPaymentProcessorTelemetry,
} from "./payment-processor-telemetry.js";

const fast = { sleep: async () => {}, baseDelayMs: 0 };
const ok = { data: { id: "p1", status: "pending" }, error: null };
const outage = { data: null, error: { message: "TypeError: fetch failed", code: "" } };

async function retries(operation, result) {
  const { values } = await paymentProcessorRetriesTotal.get();
  return (
    values.find((v) => v.labels.operation === operation && v.labels.result === result)?.value ?? 0
  );
}

beforeEach(() => {
  resetPaymentProcessorTelemetry();
  paymentProcessorRetriesTotal.reset();
});

describe("retryProcessorRead (#1479)", () => {
  it("runs the query once when it succeeds", async () => {
    const run = vi.fn(async () => ok);
    await expect(retryProcessorRead("status_lookup", run, fast)).resolves.toBe(ok);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await retries("status_lookup", "scheduled")).toBe(0);
  });

  it("retries a transient failure and records scheduled + recovered", async () => {
    const run = vi.fn().mockResolvedValueOnce(outage).mockResolvedValueOnce(ok);

    await expect(retryProcessorRead("verify_lookup", run, fast)).resolves.toBe(ok);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await retries("verify_lookup", "scheduled")).toBe(1);
    expect(await retries("verify_lookup", "recovered")).toBe(1);
    expect(getPaymentProcessorHealth().status).toBe("healthy");
  });

  it("returns the last error result when retries run out and degrades health", async () => {
    const run = vi.fn(async () => outage);

    const result = await retryProcessorRead("status_lookup", run, { ...fast, maxAttempts: 3 });
    expect(result.error).toMatchObject({ retryAttempts: 3 });
    expect(run).toHaveBeenCalledTimes(3);
    expect(await retries("status_lookup", "exhausted")).toBe(1);
    expect(getPaymentProcessorHealth()).toMatchObject({
      status: "degraded",
      reasons: ["retries_exhausted"],
    });
  });

  it.each([
    ["not found / PostgREST", { message: "JSON object requested", code: "PGRST116" }],
    ["invalid uuid", { message: "invalid input syntax for type uuid", code: "22P02" }],
    ["missing column", { message: "column deleted_at does not exist", code: "42703" }],
    ["permission", { message: "permission denied", code: "42501" }],
  ])("never retries a deterministic error (%s)", async (_name, error) => {
    const run = vi.fn(async () => ({ data: null, error }));
    const result = await retryProcessorRead("status_lookup", run, fast);
    expect(result.error).toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries thrown network errors and rethrows when exhausted", async () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const run = vi.fn().mockRejectedValue(err);
    await expect(retryProcessorRead("verify_lookup", run, { ...fast, maxAttempts: 2 })).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("drops an unknown operation label instead of recording it", async () => {
    const run = vi.fn().mockResolvedValueOnce(outage).mockResolvedValueOnce(ok);
    await retryProcessorRead("drop_table", run, fast);
    const { values } = await paymentProcessorRetriesTotal.get();
    expect(values.every((v) => ["status_lookup", "verify_lookup"].includes(v.labels.operation))).toBe(true);
  });
});

describe("resolveProcessorRetryOptions", () => {
  it("defaults to a small latency budget", () => {
    expect(resolveProcessorRetryOptions({}, {})).toEqual(DEFAULT_PROCESSOR_RETRY_OPTIONS);
  });

  it("reads PAYMENT_PROCESSOR_RETRY_* and clamps", () => {
    expect(
      resolveProcessorRetryOptions(
        {},
        {
          PAYMENT_PROCESSOR_RETRY_MAX_ATTEMPTS: "10",
          PAYMENT_PROCESSOR_RETRY_BASE_DELAY_MS: "20",
          PAYMENT_PROCESSOR_RETRY_MAX_DELAY_MS: "100000",
        },
      ),
    ).toEqual({ maxAttempts: 5, baseDelayMs: 20, maxDelayMs: 3000 });
  });
});
