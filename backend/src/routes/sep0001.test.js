/**
 * GET /.well-known/stellar.toml — strict request validation (#1457) and
 * alert metrics / health telemetry (#1458).
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: { result: { data: null, error: null }, throws: null, lastId: null },
}));

vi.mock("../lib/supabase.js", () => {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((_col, id) => {
      state.lastId = id;
      return builder;
    }),
    is: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => {
      if (state.throws) throw state.throws;
      return state.result;
    }),
  };
  return { supabase: { from: vi.fn(() => builder) } };
});

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import sep0001Router, { resolveMerchantId } from "./sep0001.js";
import {
  getSep0001Health,
  resetSep0001Health,
  sep0001Register,
  sep0001RejectedFieldsTotal,
  sep0001RequestsTotal,
} from "../lib/sep0001-telemetry.js";

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const MERCHANT = {
  id: MERCHANT_ID,
  business_name: "Acme",
  email: "ops@acme.example",
  notification_email: "help@acme.example",
  recipient: "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57",
  branding_config: { homepage: "https://acme.example" },
};
const SECRET_SEED = "SAFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQX44I";

const ENV_KEYS = ["STELLAR_NETWORK_PASSPHRASE", "API_BASE_URL", "TRANSFER_SERVER_URL", "SIGNING_KEY", "DOCS_URL", "FEDERATION_SERVER_URL"];
const savedEnv = {};

function createApp({ merchant } = {}) {
  const app = express();
  if (merchant) {
    app.use((req, _res, next) => {
      req.merchant = merchant;
      next();
    });
  }
  app.use(sep0001Router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: "internal" }));
  return app;
}

async function count(outcome) {
  const { values } = await sep0001RequestsTotal.get();
  return values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.API_BASE_URL = "https://api.example.com";
  state.result = { data: MERCHANT, error: null };
  state.throws = null;
  state.lastId = null;
  sep0001Register.resetMetrics();
  resetSep0001Health();
});

describe("resolveMerchantId", () => {
  it.each([
    [{ query: { merchant_id: MERCHANT_ID } }, { merchantId: MERCHANT_ID }],
    [{ query: {}, merchant: { id: MERCHANT_ID } }, { merchantId: MERCHANT_ID }],
    [{ query: {} }, { error: "merchant_id required" }],
    [{ query: { merchant_id: [MERCHANT_ID, MERCHANT_ID] } }, { error: "merchant_id must be a single value" }],
    [{ query: { merchant_id: { $ne: null } } }, { error: "merchant_id must be a single value" }],
    [{ query: { merchant_id: "1 OR 1=1" } }, { error: "merchant_id must be a valid UUID" }],
  ])("resolves %j", (req, expected) => {
    expect(resolveMerchantId(req)).toEqual(expected);
  });
});

describe("GET /.well-known/stellar.toml", () => {
  it("serves a sanitized stellar.toml with SEP-0001 headers and records success", async () => {
    const res = await request(createApp()).get(`/.well-known/stellar.toml?merchant_id=${MERCHANT_ID}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(res.text).toContain('TRANSFER_SERVER = "https://api.example.com/api"');
    expect(state.lastId).toBe(MERCHANT_ID);
    expect(await count("success")).toBe(1);
    expect(getSep0001Health()).toMatchObject({ status: "healthy", success: 1 });
  });

  it("uses the authenticated merchant when merchant_id is omitted", async () => {
    const res = await request(createApp({ merchant: { id: MERCHANT_ID } })).get("/.well-known/stellar.toml");
    expect(res.status).toBe(200);
    expect(state.lastId).toBe(MERCHANT_ID);
  });

  it.each([
    ["missing", "/.well-known/stellar.toml", "merchant_id required"],
    ["non-UUID", "/.well-known/stellar.toml?merchant_id=abc'%3B--", "merchant_id must be a valid UUID"],
    ["repeated", `/.well-known/stellar.toml?merchant_id=${MERCHANT_ID}&merchant_id=${MERCHANT_ID}`, "merchant_id must be a single value"],
  ])("rejects a %s merchant_id with 400 without querying the database", async (_label, url, error) => {
    const res = await request(createApp()).get(url);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(await count("invalid_request")).toBe(1);
  });

  it("returns 404 for an unknown merchant", async () => {
    state.result = { data: null, error: null };
    const res = await request(createApp()).get(`/.well-known/stellar.toml?merchant_id=${MERCHANT_ID}`);
    expect(res.status).toBe(404);
    expect(await count("not_found")).toBe(1);
  });

  it("returns 500 and records a lookup error when the database fails", async () => {
    state.result = { data: null, error: { message: "connection refused" } };
    const res = await request(createApp()).get(`/.well-known/stellar.toml?merchant_id=${MERCHANT_ID}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch merchant" });
    expect(await count("lookup_error")).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: MERCHANT_ID, err: "connection refused" }),
      "SEP-0001: failed to fetch merchant",
    );
  });

  it("returns a generic 500 for invalid server configuration without leaking it", async () => {
    process.env.TRANSFER_SERVER_URL = "http://internal-host:8080/api";
    const res = await request(createApp()).get(`/.well-known/stellar.toml?merchant_id=${MERCHANT_ID}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to generate valid stellar.toml" });
    expect(JSON.stringify(res.body)).not.toContain("internal-host");
    expect(await count("generation_error")).toBe(1);
  });

  it("passes unexpected errors to the error handler and records them", async () => {
    state.throws = new Error("boom");
    const res = await request(createApp()).get(`/.well-known/stellar.toml?merchant_id=${MERCHANT_ID}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal" });
    expect(await count("generation_error")).toBe(1);
  });

  it("refuses to publish a secret seed, logs it without the value and degrades health", async () => {
    process.env.SIGNING_KEY = SECRET_SEED;
    const res = await request(createApp()).get(`/.well-known/stellar.toml?merchant_id=${MERCHANT_ID}`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SECRET_SEED);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(SECRET_SEED);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET_SEED);
    const { values } = await sep0001RejectedFieldsTotal.get();
    expect(values).toContainEqual(
      expect.objectContaining({ labels: { field: "SIGNING_KEY", reason: "secret_seed" }, value: 1 }),
    );
    expect(getSep0001Health().status).toBe("degraded");
  });

  it("omits invalid merchant fields and records them", async () => {
    state.result = {
      data: { ...MERCHANT, recipient: "not-a-key", branding_config: { homepage: "javascript:alert(1)" } },
      error: null,
    };
    const res = await request(createApp()).get(`/.well-known/stellar.toml?merchant_id=${MERCHANT_ID}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("ACCOUNTS");
    expect(res.text).not.toContain("javascript:");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        rejections: [
          { field: "recipient", reason: "invalid_account" },
          { field: "homepage", reason: "invalid_url" },
        ],
      }),
      "SEP-0001: fields omitted or altered by sanitization",
    );
  });

  it("turns unhealthy when most requests hit server errors", async () => {
    state.result = { data: null, error: { message: "down" } };
    const app = createApp();
    for (let i = 0; i < 10; i += 1) {
      await request(app).get(`/.well-known/stellar.toml?merchant_id=${MERCHANT_ID}`);
    }
    expect(getSep0001Health()).toMatchObject({ status: "unhealthy", lookup_error: 10 });
  });
});
