import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  DEFAULT_SEP0001_RETRY_OPTIONS,
  MERCHANT_TOML_FIELDS,
  fetchMerchantForStellarToml,
  isTransientSep0001Error,
  resolveSep0001RetryOptions,
  sep0001LookupRetriesTotal,
} from "./sep0001-retry.js";
import { register } from "./metrics.js";

const MERCHANT = { id: "m-1", business_name: "Acme", recipient: "GABC" };
const fast = { sleep: async () => {}, baseDelayMs: 0 };

/** Supabase double: each from() call starts a new builder and takes the next result. */
function fakeSupabase(results) {
  const queue = [...results];
  const calls = [];
  const supabase = {
    from: vi.fn((table) => {
      const call = { table, ops: [] };
      calls.push(call);
      const builder = {
        select: (fields) => (call.ops.push(["select", fields]), builder),
        eq: (col, val) => (call.ops.push(["eq", col, val]), builder),
        is: (col, val) => (call.ops.push(["is", col, val]), builder),
        maybeSingle: async () => {
          const next = queue.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      };
      return builder;
    }),
  };
  return { supabase, calls };
}

async function retries(result) {
  const { values } = await sep0001LookupRetriesTotal.get();
  return values.find((v) => v.labels.result === result)?.value ?? 0;
}

describe("SEP-0001 merchant lookup retry (#1459)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries the merchant row once on success", async () => {
    const { supabase, calls } = fakeSupabase([{ data: MERCHANT, error: null }]);

    await expect(fetchMerchantForStellarToml(supabase, "m-1", fast)).resolves.toEqual({
      data: MERCHANT,
      error: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      table: "merchants",
      ops: [
        ["select", MERCHANT_TOML_FIELDS],
        ["eq", "id", "m-1"],
        ["is", "deleted_at", null],
      ],
    });
  });

  it("retries a transient failure with a fresh query and records recovery", async () => {
    const before = await retries("recovered");
    const { supabase, calls } = fakeSupabase([
      { data: null, error: { message: "TypeError: fetch failed", code: "" } },
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      { data: MERCHANT, error: null },
    ]);

    const result = await fetchMerchantForStellarToml(supabase, "m-1", fast);
    expect(result.data).toEqual(MERCHANT);
    expect(calls).toHaveLength(3);
    expect(await retries("recovered")).toBe(before + 1);
  });

  it("does not retry a deterministic error", async () => {
    const { supabase, calls } = fakeSupabase([
      { data: null, error: { message: "invalid input syntax for type uuid", code: "22P02" } },
    ]);

    const result = await fetchMerchantForStellarToml(supabase, "not-a-uuid", fast);
    expect(result.error.code).toBe("22P02");
    expect(calls).toHaveLength(1);
  });

  it("does not retry a missing merchant", async () => {
    const { supabase, calls } = fakeSupabase([{ data: null, error: null }]);
    await expect(fetchMerchantForStellarToml(supabase, "m-x", fast)).resolves.toEqual({
      data: null,
      error: null,
    });
    expect(calls).toHaveLength(1);
  });

  it("returns the last transient error after exhausting retries", async () => {
    const before = await retries("exhausted");
    const outage = { data: null, error: { message: "connection failure", code: "08006" } };
    const { supabase, calls } = fakeSupabase([outage, outage, outage]);

    const result = await fetchMerchantForStellarToml(supabase, "m-1", { ...fast, maxAttempts: 3 });
    expect(result.error).toMatchObject({ code: "08006", retryAttempts: 3 });
    expect(calls).toHaveLength(3);
    expect(await retries("exhausted")).toBe(before + 1);
  });

  it("exposes its counter on the main /metrics registry", async () => {
    expect(await register.metrics()).toContain("sep0001_merchant_lookup_retries_total");
  });
});

describe("resolveSep0001RetryOptions", () => {
  it("defaults to a small request-path budget", () => {
    expect(resolveSep0001RetryOptions({}, {})).toEqual(DEFAULT_SEP0001_RETRY_OPTIONS);
  });

  it("reads SEP0001_RETRY_* and clamps to 5 attempts / 5s", () => {
    expect(
      resolveSep0001RetryOptions(
        {},
        {
          SEP0001_RETRY_MAX_ATTEMPTS: "50",
          SEP0001_RETRY_BASE_DELAY_MS: "10",
          SEP0001_RETRY_MAX_DELAY_MS: "999999",
        },
      ),
    ).toEqual({ maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 5000 });
  });
});

describe("isTransientSep0001Error", () => {
  it.each([
    [{ code: "08006" }, true],
    [{ code: "57P01" }, true],
    [{ message: "TypeError: fetch failed" }, true],
    [{ status: 503 }, true],
    [{ code: "22P02" }, false],
    [{ code: "PGRST116" }, false],
    [{ status: 404 }, false],
    [null, false],
  ])("%j -> %s", (err, expected) => {
    expect(isTransientSep0001Error(err)).toBe(expected);
  });
});
