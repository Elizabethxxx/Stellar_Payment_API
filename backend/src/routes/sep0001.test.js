import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockMaybeSingle } = vi.hoisted(() => {
  // Keep route-level retries instant.
  process.env.SEP0001_RETRY_BASE_DELAY_MS = "0";
  process.env.SEP0001_RETRY_MAX_DELAY_MS = "0";
  process.env.SEP0001_RETRY_MAX_ATTEMPTS = "3";
  return { mockMaybeSingle: vi.fn() };
});

vi.mock("../lib/supabase.js", () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    maybeSingle: mockMaybeSingle,
  };
  return { supabase: { from: () => builder } };
});

vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import sep0001Router from "./sep0001.js";

const MERCHANT = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  business_name: "Acme",
  email: "a@acme.test",
  notification_email: null,
  recipient: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2BRUY4DQAT2B",
  branding_config: null,
};

function app() {
  const a = express();
  a.use("/", sep0001Router);
  return a;
}

const get = () => request(app()).get(`/.well-known/stellar.toml?merchant_id=${MERCHANT.id}`);

describe("GET /.well-known/stellar.toml retry (#1459)", () => {
  beforeEach(() => mockMaybeSingle.mockReset());

  it("serves stellar.toml after a transient lookup failure", async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: { message: "TypeError: fetch failed", code: "" } })
      .mockResolvedValueOnce({ data: MERCHANT, error: null });

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.text).toContain("NETWORK_PASSPHRASE");
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it("answers 503 with Retry-After and no-store when the outage outlasts retries", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "connection failure", code: "08006" } });

    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ error: "Merchant lookup temporarily unavailable" });
    expect(mockMaybeSingle).toHaveBeenCalledTimes(3);
  });

  it("keeps 500 for deterministic lookup errors, without retrying", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "bad uuid", code: "22P02" } });

    const res = await get();
    expect(res.status).toBe(500);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ error: "Failed to fetch merchant" });
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it("keeps 404 for an unknown merchant", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await get();
    expect(res.status).toBe(404);
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it("keeps 400 when no merchant id is given", async () => {
    const res = await request(app()).get("/.well-known/stellar.toml");
    expect(res.status).toBe(400);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it("never leaks the database error text to the client", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: "password authentication failed for user admin", code: "08006" },
    });
    const res = await get();
    expect(JSON.stringify(res.body)).not.toMatch(/password|admin/);
  });
});
