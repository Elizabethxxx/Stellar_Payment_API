/**
 * Payment Processor Telemetry + SEP-0001 retry — HTTP integration
 * (issues #1459, #1477, #1478, #1479).
 *
 * Runs the real Express app. Only the edges are mocked (Supabase, Horizon,
 * Redis), as in tests/integration/health.test.js.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

const { mockMaybeSingle } = vi.hoisted(() => {
  process.env.SUPABASE_URL ||= "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
  process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
  process.env.SEP0001_RETRY_BASE_DELAY_MS = "0";
  process.env.SEP0001_RETRY_MAX_DELAY_MS = "0";
  return { mockMaybeSingle: vi.fn() };
});

vi.mock("../../src/lib/stellar.js", () => ({
  findMatchingPayment: vi.fn(),
  findAnyRecentPayment: vi.fn(),
  findStrictReceivePaths: vi.fn(),
  getNetworkFeeStats: vi.fn(),
  isHorizonReachable: vi.fn(async () => true),
  isValidAssetCode: vi.fn(() => true),
  isValidStellarAccountId: vi.fn(() => true),
  isValidStellarPublicKey: vi.fn(() => true),
  validateMemo: vi.fn(() => ({ valid: true })),
  verifyTransactionSignature: vi.fn(),
  withHorizonRetry: vi.fn(),
}));

vi.mock("../../src/lib/supabase.js", () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    limit: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: mockMaybeSingle,
  };
  return { supabase: { from: () => builder } };
});

import { createApp } from "../../src/app.js";
import { closePool } from "../../src/lib/db.js";
import {
  recordProcessorRetryTelemetry,
  recordSessionTelemetry,
  recordVerificationTelemetry,
  resetPaymentProcessorTelemetry,
} from "../../src/lib/payment-processor-telemetry.js";

const mockRedisClient = {
  ping: vi.fn().mockResolvedValue("PONG"),
  on: vi.fn(),
  sendCommand: vi.fn().mockResolvedValue("mocked_hash"),
};

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("Payment Processor Telemetry over HTTP (#1477, #1478, #1479)", () => {
  let app;

  beforeAll(async () => {
    ({ app } = await createApp({ redisClient: mockRedisClient }));
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(() => {
    resetPaymentProcessorTelemetry();
    mockMaybeSingle.mockReset();
  });

  it("GET /health/payment-processor is healthy with no traffic", async () => {
    const res = await request(app).get("/health/payment-processor");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "healthy", sessions: 0, verifications: 0 });
  });

  it("GET /health/payment-processor returns 503 when persistence keeps failing", async () => {
    for (let i = 0; i < 25; i += 1) {
      recordSessionTelemetry({ asset: "XLM", outcome: "persistence_failed", durationSeconds: 0.01 });
    }
    const res = await request(app).get("/health/payment-processor");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "unhealthy",
      reasons: ["session_failure_ratio_critical"],
    });
    expect(JSON.stringify(res.body)).not.toContain("XLM");
  });

  it("GET /health lists payment_processor without changing the overall status", async () => {
    for (let i = 0; i < 25; i += 1) recordVerificationTelemetry({ asset: "XLM", outcome: "error" });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.services.payment_processor).toBe("unhealthy");
  });

  it("GET /metrics exposes sanitised labels and the new alert series", async () => {
    recordSessionTelemetry({ asset: 'x"} injected{y="', outcome: "created", durationSeconds: 0.1 });
    recordSessionTelemetry({ asset: "usdc", outcome: "created", durationSeconds: 0.1 });
    recordSessionTelemetry({ asset: "XLM", outcome: "not_an_outcome" });
    recordProcessorRetryTelemetry({ operation: "status_lookup", result: "recovered" });

    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/payment_processor_sessions_total\{[^}]*asset="invalid"[^}]*\} \d+/);
    expect(res.text).toMatch(/payment_processor_sessions_total\{[^}]*asset="USDC"[^}]*\} \d+/);
    expect(res.text).not.toContain("injected");
    expect(res.text).not.toContain('outcome="not_an_outcome"');
    expect(res.text).toMatch(
      /payment_processor_telemetry_rejected_total\{[^}]*metric="sessions"[^}]*reason="invalid_outcome"[^}]*\} \d+/,
    );
    expect(res.text).toMatch(/payment_processor_retries_total\{[^}]*operation="status_lookup"[^}]*\} \d+/);
    expect(res.text).toContain("payment_processor_health_state");
    expect(res.text).toContain("sep0001_merchant_lookup_retries_total");
  });
});

describe("SEP-0001 stellar.toml through the app (#1459)", () => {
  let app;

  beforeAll(async () => {
    ({ app } = await createApp({ redisClient: mockRedisClient }));
  });

  beforeEach(() => mockMaybeSingle.mockReset());

  it("recovers from a transient merchant lookup failure", async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: { message: "TypeError: fetch failed", code: "" } })
      .mockResolvedValueOnce({
        data: { id: MERCHANT_ID, business_name: "Acme", recipient: null, branding_config: null },
        error: null,
      });

    const res = await request(app).get(`/.well-known/stellar.toml?merchant_id=${MERCHANT_ID}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('name = "Acme"');
  });

  it("returns 503 + Retry-After when the lookup stays down", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "down", code: "57P01" } });

    const res = await request(app).get(`/.well-known/stellar.toml?merchant_id=${MERCHANT_ID}`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.headers["cache-control"]).toBe("no-store");

    const metrics = await request(app).get("/metrics");
    expect(metrics.text).toMatch(
      /sep0001_merchant_lookup_retries_total\{[^}]*result="exhausted"[^}]*\} [1-9]/,
    );
  });
});
