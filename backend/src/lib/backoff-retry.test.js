import { describe, it, expect, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { resolveBackoffOptions, retryWithBackoff, retrySupabaseRead } from "./backoff-retry.js";

const SPEC = {
  envPrefix: "TEST_RETRY",
  defaults: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
  maxAttemptsCeiling: 5,
  maxDelayCeilingMs: 5000,
};
const resolved = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };
const transient = (code = "ECONNRESET") => Object.assign(new Error(`transient ${code}`), { code });
const sleep = vi.fn(async () => {});

describe("resolveBackoffOptions", () => {
  it("falls back to defaults", () => {
    expect(resolveBackoffOptions({}, {}, SPEC)).toEqual(SPEC.defaults);
  });

  it("reads prefixed env vars and lets options win", () => {
    const env = {
      TEST_RETRY_MAX_ATTEMPTS: "4",
      TEST_RETRY_BASE_DELAY_MS: "20",
      TEST_RETRY_MAX_DELAY_MS: "200",
    };
    expect(resolveBackoffOptions({}, env, SPEC)).toEqual({
      maxAttempts: 4,
      baseDelayMs: 20,
      maxDelayMs: 200,
    });
    expect(resolveBackoffOptions({ maxAttempts: 2 }, env, SPEC).maxAttempts).toBe(2);
  });

  it("clamps to the ceilings and never lets maxDelay drop below baseDelay", () => {
    expect(
      resolveBackoffOptions({ maxAttempts: 99, baseDelayMs: -1, maxDelayMs: 1e9 }, {}, SPEC),
    ).toEqual({ maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 5000 });
    expect(resolveBackoffOptions({ baseDelayMs: 900, maxDelayMs: 10 }, {}, SPEC).maxDelayMs).toBe(
      900,
    );
    expect(resolveBackoffOptions({ maxAttempts: 0 }, {}, SPEC).maxAttempts).toBe(1);
  });

  it("ignores garbage values", () => {
    expect(resolveBackoffOptions({}, { TEST_RETRY_MAX_ATTEMPTS: "many" }, SPEC).maxAttempts).toBe(3);
  });
});

describe("retryWithBackoff", () => {
  it("returns the first success without sleeping", async () => {
    sleep.mockClear();
    const op = vi.fn(async () => 7);
    await expect(retryWithBackoff(op, { resolved, sleep })).resolves.toBe(7);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient errors with full-jitter delays and reports recovery", async () => {
    sleep.mockClear();
    const onRetry = vi.fn();
    const onRecovered = vi.fn();
    const op = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient("08006"))
      .mockResolvedValueOnce("ok");

    await expect(
      retryWithBackoff(op, { resolved, sleep, random: () => 0.5, onRetry, onRecovered }),
    ).resolves.toBe("ok");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([50, 100]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRecovered).toHaveBeenCalledWith({ attempts: 3 });
  });

  it("throws non-transient errors immediately", async () => {
    const err = Object.assign(new Error("bad id"), { code: "22P02" });
    const op = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(op, { resolved, sleep })).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
    expect(err.retryAttempts).toBe(1);
  });

  it("gives up after maxAttempts and reports exhaustion", async () => {
    const onExhausted = vi.fn();
    const op = vi.fn().mockRejectedValue(transient());
    await expect(retryWithBackoff(op, { resolved, sleep, onExhausted })).rejects.toMatchObject({
      retryAttempts: 3,
    });
    expect(op).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });
});

describe("retrySupabaseRead", () => {
  it("returns a successful result untouched", async () => {
    const run = vi.fn(async () => ({ data: { id: 1 }, error: null }));
    await expect(retrySupabaseRead(run, { resolved, sleep })).resolves.toEqual({
      data: { id: 1 },
      error: null,
    });
  });

  it("retries a transient { error } result until it clears", async () => {
    const onRecovered = vi.fn();
    const run = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: "TypeError: fetch failed", code: "" } })
      .mockResolvedValueOnce({ data: { id: 2 }, error: null });

    await expect(retrySupabaseRead(run, { resolved, sleep, onRecovered })).resolves.toEqual({
      data: { id: 2 },
      error: null,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it("returns a non-transient { error } result on the first attempt", async () => {
    const result = { data: null, error: { message: "invalid input syntax for type uuid", code: "22P02" } };
    const run = vi.fn(async () => result);
    await expect(retrySupabaseRead(run, { resolved, sleep })).resolves.toBe(result);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns the last { error } result when retries run out, annotated", async () => {
    const onExhausted = vi.fn();
    const run = vi.fn(async () => ({ data: null, error: { message: "upstream", code: "57P01" } }));

    const result = await retrySupabaseRead(run, { resolved, sleep, onExhausted });
    expect(result.error).toMatchObject({ code: "57P01", retryAttempts: 3 });
    expect(run).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown transient error and rethrows it when exhausted", async () => {
    const run = vi.fn().mockRejectedValue(transient("ETIMEDOUT"));
    await expect(retrySupabaseRead(run, { resolved, sleep })).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("uses a custom shouldRetry for result errors", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: "custom" } })
      .mockResolvedValueOnce({ data: 1, error: null });
    await expect(
      retrySupabaseRead(run, { resolved, sleep, shouldRetry: () => true }),
    ).resolves.toEqual({ data: 1, error: null });
  });
});
