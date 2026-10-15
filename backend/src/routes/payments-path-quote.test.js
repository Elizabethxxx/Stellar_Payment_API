import { beforeEach, describe, expect, it, vi } from "vitest";
import createPaymentsRouter from "./payments.js";
import { resetExchangeRateCache } from "../lib/exchange-rate-cache.js";

const { findStrictReceivePaths, supabaseFrom } = vi.hoisted(() => ({
  findStrictReceivePaths: vi.fn(),
  supabaseFrom: vi.fn(),
}));

vi.mock("../lib/stellar.js", () => ({
    findStrictReceivePaths,
    findMatchingPayment: vi.fn(),
    findAnyRecentPayment: vi.fn(),
    createRefundTransaction: vi.fn(),
    getNetworkFeeStats: vi.fn(),
    isValidStellarPublicKey: vi.fn(() => true),
    validateMemo: vi.fn(() => ({ valid: true })),
    verifyTransactionSignature: vi.fn(),
}));

vi.mock("../lib/supabase.js", () => ({
  supabase: {
    from: supabaseFrom,
  },
}));

vi.mock("../lib/redis.js", () => ({
  connectRedisClient: vi.fn(() => Promise.resolve({})),
  getCachedPayment: vi.fn(),
  setCachedPayment: vi.fn(),
  invalidatePaymentCache: vi.fn(),
}));

function createSupabaseSelectMock(payment) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    is: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: payment, error: null })),
  };

  return chain;
}

function getPathPaymentQuoteRoute() {
  const router = createPaymentsRouter();
  return router.stack.find(
    (entry) => entry.route?.path === "/path-payment-quote/:id",
  ).route;
}

function getPathPaymentQuoteHandler() {
  return getPathPaymentQuoteRoute().stack.at(-1).handle;
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("GET /api/path-payment-quote/:id — authentication (issue #1309)", () => {
  it("is protected by requireApiKeyAuth, not left unauthenticated", () => {
    // This route sits outside the `/api/payments` prefix that app.js gates
    // with requireApiKeyAuth() at the mount level, so it needs its own
    // per-route auth middleware or it is reachable by anyone. Assert the
    // middleware stack actually contains an auth layer rather than relying
    // only on behavioral tests, so a future refactor that silently drops it
    // fails immediately here instead of shipping an unauthenticated route
    // again.
    const route = getPathPaymentQuoteRoute();
    const middlewareNames = route.stack.map((layer) => layer.name);

    expect(middlewareNames).toContain("requireApiKeyAuth");
  });
});

describe("GET /api/path-payment-quote/:id", () => {
  const paymentId = "9f927a2c-02d4-4f76-914c-62cf44d9525e";
  const sourceAccount =
    "GDESJRNS3IREXNSFMC35XM2CHEESOKAWQL2SXBK4AUIKNKCIYBMW4TDJ";

  beforeEach(() => {
    vi.clearAllMocks();
    resetExchangeRateCache();
  });

  it("returns an XLM quote for a USDC invoice", async () => {
    supabaseFrom.mockReturnValue(
      createSupabaseSelectMock({
        id: paymentId,
        amount: 25,
        asset: "USDC",
        asset_issuer: "GA5HBVNVS6P3QJ2ZGLMEACPSGFG3KDCAFTVHNJXWG22E5DVZTPSSAWQW",
        recipient: "GB6REFUNDTESTRECIPIENTQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
        status: "pending",
      }),
    );

    findStrictReceivePaths.mockResolvedValue({
      source_amount: "60.1250000",
      source_asset_code: "XLM",
      source_asset_issuer: null,
      destination_amount: "25",
      path: [],
    });

    const handler = getPathPaymentQuoteHandler();
    const res = createMockResponse();

    await handler(
      {
        params: { id: paymentId },
        query: {
          source_asset: "XLM",
          source_account: sourceAccount,
        },
        merchant: { id: "merchant-1" },
      },
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      source_asset: "XLM",
      source_amount: "60.1250000",
      send_max: "60.7262500",
      destination_asset: "USDC",
      destination_asset_issuer: "GA5HBVNVS6P3QJ2ZGLMEACPSGFG3KDCAFTVHNJXWG22E5DVZTPSSAWQW",
      destination_amount: "25",
      path: [],
      slippage: 0.01,
    });
    expect(findStrictReceivePaths).toHaveBeenCalledWith({
      sourceAccount,
      destAssetCode: "USDC",
      destAssetIssuer: "GA5HBVNVS6P3QJ2ZGLMEACPSGFG3KDCAFTVHNJXWG22E5DVZTPSSAWQW",
      destAmount: "25",
      sourceAssetCode: "XLM",
      sourceAssetIssuer: null,
    });
  });

  it("rejects a quote request when the source asset already matches the invoice asset", async () => {
    supabaseFrom.mockReturnValue(
      createSupabaseSelectMock({
        id: paymentId,
        amount: 10,
        asset: "XLM",
        asset_issuer: null,
        recipient: "GB6REFUNDTESTRECIPIENTQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
        status: "pending",
      }),
    );

    const handler = getPathPaymentQuoteHandler();
    const res = createMockResponse();

    await handler(
      {
        params: { id: paymentId },
        query: {
          source_asset: "XLM",
          source_account: sourceAccount,
        },
        merchant: { id: "merchant-1" },
      },
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("Use a direct payment");
    expect(findStrictReceivePaths).not.toHaveBeenCalled();
  });

  it("rejects quote requests for payments that are no longer pending", async () => {
    supabaseFrom.mockReturnValue(
      createSupabaseSelectMock({
        id: paymentId,
        amount: 10,
        asset: "USDC",
        asset_issuer: "GA5HBVNVS6P3QJ2ZGLMEACPSGFG3KDCAFTVHNJXWG22E5DVZTPSSAWQW",
        recipient: "GB6REFUNDTESTRECIPIENTQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
        status: "confirmed",
      }),
    );

    const handler = getPathPaymentQuoteHandler();
    const res = createMockResponse();

    await handler(
      {
        params: { id: paymentId },
        query: {
          source_asset: "XLM",
          source_account: sourceAccount,
        },
        merchant: { id: "merchant-1" },
      },
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "Path payment quote is only available for pending payments",
      status: "confirmed",
    });
    expect(findStrictReceivePaths).not.toHaveBeenCalled();
  });
});

describe("GET /api/path-payment-quote/:id — quote cache (issue #1045)", () => {
  const paymentId = "9f927a2c-02d4-4f76-914c-62cf44d9525e";
  const sourceAccount =
    "GDESJRNS3IREXNSFMC35XM2CHEESOKAWQL2SXBK4AUIKNKCIYBMW4TDJ";

  beforeEach(() => {
    vi.clearAllMocks();
    resetExchangeRateCache();
    supabaseFrom.mockReturnValue(
      createSupabaseSelectMock({
        id: paymentId,
        amount: 25,
        asset: "USDC",
        asset_issuer: "GA5HBVNVS6P3QJ2ZGLMEACPSGFG3KDCAFTVHNJXWG22E5DVZTPSSAWQW",
        recipient: "GB6REFUNDTESTRECIPIENTQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
        status: "pending",
      }),
    );
    findStrictReceivePaths.mockResolvedValue({
      source_amount: "60.1250000",
      source_asset_code: "XLM",
      source_asset_issuer: null,
      destination_amount: "25",
      path: [],
    });
  });

  async function requestQuote(handler, res) {
    await handler(
      {
        params: { id: paymentId },
        query: {
          source_asset: "XLM",
          source_account: sourceAccount,
        },
        merchant: { id: "merchant-1" },
      },
      res,
      vi.fn(),
    );
  }

  it("serves identical quote requests from cache without re-querying Horizon", async () => {
    const firstRes = createMockResponse();
    await requestQuote(getPathPaymentQuoteHandler(), firstRes);
    expect(firstRes.statusCode).toBe(200);
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);

    const secondRes = createMockResponse();
    await requestQuote(getPathPaymentQuoteHandler(), secondRes);

    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.body).toEqual(firstRes.body);
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);
  });

  it("keeps different source assets in separate cache entries", async () => {
    await requestQuote(getPathPaymentQuoteHandler(), createMockResponse());
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);

    const handler = getPathPaymentQuoteHandler();
    const res = createMockResponse();
    await handler(
      {
        params: { id: paymentId },
        query: {
          source_asset: "EUR",
          source_asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          source_account: sourceAccount,
        },
        merchant: { id: "merchant-1" },
      },
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.source_asset).toBe("XLM");
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(2);
  });

  it("stops serving cached quotes once the payment is no longer pending", async () => {
    await requestQuote(getPathPaymentQuoteHandler(), createMockResponse());
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);

    supabaseFrom.mockReturnValue(
      createSupabaseSelectMock({
        id: paymentId,
        amount: 25,
        asset: "USDC",
        asset_issuer: "GA5HBVNVS6P3QJ2ZGLMEACPSGFG3KDCAFTVHNJXWG22E5DVZTPSSAWQW",
        recipient: "GB6REFUNDTESTRECIPIENTQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
        status: "confirmed",
      }),
    );

    const res = createMockResponse();
    await requestQuote(getPathPaymentQuoteHandler(), res);

    expect(res.statusCode).toBe(409);
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);
  });

  it("does not cache the 404 response when no path is found", async () => {
    findStrictReceivePaths.mockResolvedValue(null);

    const firstRes = createMockResponse();
    await requestQuote(getPathPaymentQuoteHandler(), firstRes);
    expect(firstRes.statusCode).toBe(404);
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);

    findStrictReceivePaths.mockResolvedValue({
      source_amount: "60.1250000",
      source_asset_code: "XLM",
      source_asset_issuer: null,
      destination_amount: "25",
      path: [],
    });

    const secondRes = createMockResponse();
    await requestQuote(getPathPaymentQuoteHandler(), secondRes);

    expect(secondRes.statusCode).toBe(200);
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/path-payment-quote/:id — payload validation (issue #1442)", () => {
  const paymentId = "9f927a2c-02d4-4f76-914c-62cf44d9525e";

  beforeEach(() => {
    vi.clearAllMocks();
    resetExchangeRateCache();
    supabaseFrom.mockReturnValue(
      createSupabaseSelectMock({
        id: paymentId,
        amount: 25,
        asset: "USDC",
        asset_issuer: "GA5HBVNVS6P3QJ2ZGLMEACPSGFG3KDCAFTVHNJXWG22E5DVZTPSSAWQW",
        recipient: "GA5HBVNVS6P3QJ2ZGLMEACPSGFG3KDCAFTVHNJXWG22E5DVZTPSSAWQW",
        status: "pending",
      }),
    );
  });

  it("rejects a credit source asset without an issuer with 400 before querying Horizon", async () => {
    const res = createMockResponse();
    const next = vi.fn();
    await getPathPaymentQuoteHandler()(
      {
        params: { id: paymentId },
        query: { source_asset: "EUR" },
        merchant: { id: "merchant-1" },
      },
      res,
      next,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ field: "sourceAssetIssuer" });
    expect(findStrictReceivePaths).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an issuer with a bad checksum", async () => {
    const res = createMockResponse();
    await getPathPaymentQuoteHandler()(
      {
        params: { id: paymentId },
        query: {
          source_asset: "EUR",
          source_asset_issuer: "GA5HBVNVS6P3QJ2ZGLMEACPSGFG3KDCAFTVHNJXWG22E5DVZTPSSAWQA",
        },
        merchant: { id: "merchant-1" },
      },
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(400);
    expect(findStrictReceivePaths).not.toHaveBeenCalled();
  });
});
