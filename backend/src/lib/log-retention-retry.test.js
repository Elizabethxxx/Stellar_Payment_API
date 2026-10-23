import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  DEFAULT_LOG_RETENTION_RETRY_OPTIONS,
  computeLogRetentionBackoffDelay,
  isRetryableLogRetentionError,
  resolveLogRetentionRetryOptions,
  withLogRetentionRetry,
} from "./log-retention-retry.js";
import { logRetentionRetriesTotal } from "./log-retention-telemetry.js";
import { logger } from "./logger.js";

const pgError = (code, message = `pg ${code}`) => Object.assign(new Error(message), { code });

async function retryCount(result) {
  const { values } = await logRetentionRetriesTotal.get();
  return values.find((v) => v.labels.result === result)?.value ?? 0;
}

describe("isRetryableLogRetentionError (#1474)", () => {
  it.each(["40001", "40P01", "55P03", "57014", "57P01", "57P02", "57P03", "53300"])(
    "retries transient SQLSTATE %s",
    (code) => {
      expect(isRetryableLogRetentionError(pgError(code))).toBe(true);
    },
  );

  it.each(["08000", "08003", "08006", "08P01"])("retries connection exception %s", (code) => {
    expect(isRetryableLogRetentionError(pgError(code))).toBe(true);
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"])("retries socket error %s", (code) => {
    expect(isRetryableLogRetentionError(pgError(code))).toBe(true);
  });

  it.each(["42601", "42501", "23503", "42P01", "22P02"])(
    "never retries deterministic SQLSTATE %s",
    (code) => {
      expect(isRetryableLogRetentionError(pgError(code))).toBe(false);
    },
  );

  it("retries pg-pool connection messages without a code", () => {
    expect(isRetryableLogRetentionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(
      isRetryableLogRetentionError(new Error("timeout exceeded when trying to connect")),
    ).toBe(true);
  });

  it("honours an explicit retryable flag either way", () => {
    expect(isRetryableLogRetentionError(Object.assign(pgError("40001"), { retryable: false }))).toBe(
      false,
    );
    expect(isRetryableLogRetentionError(Object.assign(new Error("x"), { retryable: true }))).toBe(true);
  });

  it.each([null, undefined, "boom", 42, new Error("Missing index for table")])(
    "does not retry %p",
    (err) => {
      expect(isRetryableLogRetentionError(err)).toBe(false);
    },
  );
});

describe("resolveLogRetentionRetryOptions", () => {
  it("uses defaults", () => {
    expect(resolveLogRetentionRetryOptions({}, {})).toEqual(DEFAULT_LOG_RETENTION_RETRY_OPTIONS);
  });

  it("reads env vars", () => {
    expect(
      resolveLogRetentionRetryOptions(
        {},
        {
          LOG_PURGE_RETRY_MAX_ATTEMPTS: "6",
          LOG_PURGE_RETRY_BASE_DELAY_MS: "10",
          LOG_PURGE_RETRY_MAX_DELAY_MS: "100",
        },
      ),
    ).toEqual({ maxAttempts: 6, baseDelayMs: 10, maxDelayMs: 100 });
  });

  it("lets explicit options win over env", () => {
    expect(
      resolveLogRetentionRetryOptions({ maxAttempts: 2 }, { LOG_PURGE_RETRY_MAX_ATTEMPTS: "6" })
        .maxAttempts,
    ).toBe(2);
  });

  it("clamps to safe ceilings and floors", () => {
    expect(
      resolveLogRetentionRetryOptions(
        { maxAttempts: 1000, baseDelayMs: -5, maxDelayMs: 10_000_000 },
        {},
      ),
    ).toEqual({ maxAttempts: 8, baseDelayMs: 0, maxDelayMs: 60_000 });
    expect(resolveLogRetentionRetryOptions({ maxAttempts: 0 }, {}).maxAttempts).toBe(1);
  });

  it("never lets maxDelay drop below baseDelay", () => {
    expect(resolveLogRetentionRetryOptions({ baseDelayMs: 500, maxDelayMs: 100 }, {})).toMatchObject({
      baseDelayMs: 500,
      maxDelayMs: 500,
    });
  });

  it("ignores non-numeric env values", () => {
    expect(
      resolveLogRetentionRetryOptions({}, { LOG_PURGE_RETRY_MAX_ATTEMPTS: "lots" }).maxAttempts,
    ).toBe(DEFAULT_LOG_RETENTION_RETRY_OPTIONS.maxAttempts);
  });
});

describe("computeLogRetentionBackoffDelay", () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 1000 };

  it("grows the ceiling exponentially and caps it", () => {
    const top = () => 0.999999;
    expect(computeLogRetentionBackoffDelay(0, opts, top)).toBe(99);
    expect(computeLogRetentionBackoffDelay(1, opts, top)).toBe(199);
    expect(computeLogRetentionBackoffDelay(2, opts, top)).toBe(399);
    expect(computeLogRetentionBackoffDelay(10, opts, top)).toBe(999);
  });

  it("applies full jitter", () => {
    expect(computeLogRetentionBackoffDelay(3, opts, () => 0)).toBe(0);
    expect(computeLogRetentionBackoffDelay(3, opts, () => 0.5)).toBe(400);
  });

  it("returns 0 with a zero base delay", () => {
    expect(computeLogRetentionBackoffDelay(4, { baseDelayMs: 0, maxDelayMs: 0 })).toBe(0);
  });
});

describe("withLogRetentionRetry", () => {
  const sleep = vi.fn(async () => {});

  beforeEach(() => {
    sleep.mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it("returns the first successful result without sleeping", async () => {
    const op = vi.fn(async () => "ok");
    await expect(withLogRetentionRetry(op, { sleep })).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient failures with backoff and records recovery", async () => {
    const before = await retryCount("recovered");
    const scheduledBefore = await retryCount("scheduled");
    const op = vi
      .fn()
      .mockRejectedValueOnce(pgError("40P01"))
      .mockRejectedValueOnce(pgError("ECONNRESET"))
      .mockResolvedValueOnce("done");

    const result = await withLogRetentionRetry(op, {
      sleep,
      random: () => 0.5,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      maxAttempts: 4,
    });

    expect(result).toBe("done");
    expect(op).toHaveBeenCalledTimes(3);
    expect(op.mock.calls.map(([ctx]) => ctx.attempt)).toEqual([1, 2, 3]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([50, 100]);
    expect(await retryCount("recovered")).toBe(before + 1);
    expect(await retryCount("scheduled")).toBe(scheduledBefore + 2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("throws a non-retryable error immediately", async () => {
    const err = pgError("42501", "permission denied");
    const op = vi.fn().mockRejectedValue(err);

    await expect(withLogRetentionRetry(op, { sleep })).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(err.retryAttempts).toBe(1);
  });

  it("gives up after maxAttempts and records exhaustion", async () => {
    const before = await retryCount("exhausted");
    const op = vi.fn().mockRejectedValue(pgError("40001"));

    await expect(
      withLogRetentionRetry(op, { sleep, maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toMatchObject({ code: "40001", retryAttempts: 3 });
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(await retryCount("exhausted")).toBe(before + 1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when shouldAbort says the budget is spent", async () => {
    const op = vi.fn().mockRejectedValue(pgError("57014"));

    await expect(
      withLogRetentionRetry(op, { sleep, maxAttempts: 5, shouldAbort: () => true }),
    ).rejects.toMatchObject({ retryAttempts: 1 });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("supports a custom shouldRetry predicate", async () => {
    const op = vi.fn().mockRejectedValueOnce(new Error("custom")).mockResolvedValueOnce(1);
    await expect(
      withLogRetentionRetry(op, { sleep, shouldRetry: () => true, baseDelayMs: 0 }),
    ).resolves.toBe(1);
  });

  it("logs only the fixed label, code and message, never query parameters", async () => {
    const op = vi.fn().mockRejectedValueOnce(pgError("40001")).mockResolvedValueOnce(1);
    await withLogRetentionRetry(op, { sleep, label: "log-retention-delete-batch" });
    const [fields] = vi.mocked(logger.warn).mock.calls[0];
    expect(Object.keys(fields).sort()).toEqual(
      ["attempt", "code", "delayMs", "err", "label", "maxAttempts"].sort(),
    );
    expect(fields.label).toBe("log-retention-delete-batch");
  });
});
