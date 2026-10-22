import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/redis.js", () => ({
  connectRedisClient: vi.fn(async () => ({ isOpen: false })),
}));

import {
  validateX402Config,
  sanitizePricingMode,
  sanitizePaymentToken,
  generatePaymentMemo,
  x402Middleware,
  hashToken,
  getCachedToken,
  setCachedToken,
  resetX402CacheForTests,
  getX402Telemetry,
  executeWithRetry,
  enqueueDeadLetter,
  recoverDeadLetterQueue,
  getDeadLetterQueueStats,
  clearDeadLetterQueue,
  isRetryableX402Error,
  acquireX402Lock,
  releaseX402Lock,
  withX402Lock,
  resetLocalLocksForTests,
} from "./x402.js";
import { createFakeRedis } from "../../tests/helpers/fake-redis.js";

const VALID_STELLAR_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const JWT_SECRET = "test-secret-12345678901234567890";

function makeReq(headers = {}, query = {}) {
  return {
    headers: { ...headers },
    query: { ...query },
  };
}

function makeRes() {
  const listeners = {};
  const res = {
    _status: null,
    _json: null,
    on: vi.fn((event, handler) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
      return res;
    }),
    once: vi.fn((event, handler) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
      return res;
    }),
    emit: (event, ...args) => {
      const handlers = listeners[event] || [];
      for (const h of handlers) h(...args);
    },
  };
  res.status = vi.fn((code) => {
    res._status = code;
    return res;
  });
  res.json = vi.fn((body) => {
    res._json = body;
    return res;
  });
  return res;
}

describe("x402 Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetX402CacheForTests();
    resetLocalLocksForTests();
    process.env.X402_JWT_SECRET = JWT_SECRET;
  });

  // -------------------------------------------------------------------------
  // Issue #1626: Input Validation and Sanitization
  // -------------------------------------------------------------------------
  describe("Input Validation and Sanitization (Issue #1626)", () => {
    describe("validateX402Config", () => {
      it("accepts valid configuration and sanitizes fields", () => {
        const valid = validateX402Config({
          amount: " 0.50 ",
          recipient: ` ${VALID_STELLAR_KEY} `,
          asset: " usdc ",
          memo_prefix: " test_prefix ",
          plutoVerifyUrl: " https://api.pluto.internal/verify-x402 ",
          enforceByDefault: true,
        });

        expect(valid.amount).toBe("0.50");
        expect(valid.recipient).toBe(VALID_STELLAR_KEY);
        expect(valid.asset).toBe("USDC");
        expect(valid.memo_prefix).toBe("test_prefix");
        expect(valid.plutoVerifyUrl).toBe("https://api.pluto.internal/verify-x402");
        expect(valid.enforceByDefault).toBe(true);
      });

      it("rejects non-object or null config", () => {
        expect(() => validateX402Config(null)).toThrow(TypeError);
        expect(() => validateX402Config("invalid")).toThrow(TypeError);
      });

      it("rejects invalid amounts", () => {
        expect(() => validateX402Config({ amount: "-1", recipient: VALID_STELLAR_KEY })).toThrow(/positive numeric value/);
        expect(() => validateX402Config({ amount: "0", recipient: VALID_STELLAR_KEY })).toThrow(/positive numeric value/);
        expect(() => validateX402Config({ amount: "abc", recipient: VALID_STELLAR_KEY })).toThrow(/positive numeric value/);
        expect(() => validateX402Config({ amount: null, recipient: VALID_STELLAR_KEY })).toThrow(TypeError);
      });

      it("rejects invalid Stellar addresses", () => {
        expect(() => validateX402Config({ amount: "1.0", recipient: "invalid_key" })).toThrow(/valid Stellar public key/);
        expect(() => validateX402Config({ amount: "1.0", recipient: "SBB..." })).toThrow(/valid Stellar public key/);
        expect(() => validateX402Config({ amount: "1.0", recipient: "" })).toThrow(/valid Stellar public key/);
      });

      it("rejects invalid asset codes", () => {
        expect(() => validateX402Config({ amount: "1.0", recipient: VALID_STELLAR_KEY, asset: "TOOLONGOFANASSETCODE123" })).toThrow(/1-12 alphanumeric characters/);
        expect(() => validateX402Config({ amount: "1.0", recipient: VALID_STELLAR_KEY, asset: "USDC$$" })).toThrow(/1-12 alphanumeric characters/);
      });

      it("rejects invalid URLs", () => {
        expect(() => validateX402Config({
          amount: "1.0",
          recipient: VALID_STELLAR_KEY,
          plutoVerifyUrl: "javascript:alert(1)",
        })).toThrow(/valid HTTP\/HTTPS URL/);
      });

      it("rejects invalid memo prefixes", () => {
        expect(() => validateX402Config({
          amount: "1.0",
          recipient: VALID_STELLAR_KEY,
          memo_prefix: "this_memo_prefix_is_way_too_long_for_stellar",
        })).toThrow(/memo_prefix must be 1-20/);
        expect(() => validateX402Config({
          amount: "1.0",
          recipient: VALID_STELLAR_KEY,
          memo_prefix: "prefix with spaces!",
        })).toThrow(/memo_prefix must be 1-20/);
      });
    });

    describe("sanitizePricingMode", () => {
      it("accepts allowed pricing modes and normalizes them", () => {
        expect(sanitizePricingMode("X402")).toBe("x402");
        expect(sanitizePricingMode(" subscription ")).toBe("subscription");
        expect(sanitizePricingMode("API-KEY")).toBe("api-key");
      });

      it("rejects unauthorized or injection modes", () => {
        expect(sanitizePricingMode("admin' OR 1=1--")).toBeNull();
        expect(sanitizePricingMode("<script>alert(1)</script>")).toBeNull();
        expect(sanitizePricingMode(123)).toBeNull();
        expect(sanitizePricingMode(null)).toBeNull();
      });
    });

    describe("sanitizePaymentToken", () => {
      it("accepts valid JWT token string", () => {
        const validJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        expect(sanitizePaymentToken(`  ${validJwt}  `)).toBe(validJwt);
      });

      it("rejects malformed tokens", () => {
        expect(sanitizePaymentToken("invalid-token-no-dots")).toBeNull();
        expect(sanitizePaymentToken("one.two")).toBeNull();
        expect(sanitizePaymentToken("one.two.three.four")).toBeNull();
        expect(sanitizePaymentToken("")).toBeNull();
        expect(sanitizePaymentToken(null)).toBeNull();
      });

      it("rejects oversized tokens to prevent buffer attacks", () => {
        const hugeToken = "a".repeat(5000) + ".b.c";
        expect(sanitizePaymentToken(hugeToken)).toBeNull();
      });
    });

    describe("generatePaymentMemo", () => {
      it("generates memo strictly within 28-byte Stellar limit", () => {
        const memo = generatePaymentMemo("x402_test", "1234567890abcdef1234567890");
        expect(Buffer.byteLength(memo, "utf8")).toBeLessThanOrEqual(28);
        expect(memo.startsWith("x402_test-")).toBe(true);
      });

      it("sanitizes unsafe characters in memo prefix", () => {
        const memo = generatePaymentMemo("unsafe$$prefix!!", "12345678");
        expect(Buffer.byteLength(memo, "utf8")).toBeLessThanOrEqual(28);
        expect(memo).toMatch(/^[A-Za-z0-9_-]+$/);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Issue #1627: Distributed Redis Caching and Throughput Telemetry
  // -------------------------------------------------------------------------
  describe("Distributed Redis Caching and Throughput Telemetry (Issue #1627)", () => {
    it("hashes tokens into a consistent hex string", () => {
      const token1 = "token.part.one";
      const token2 = "token.part.two";
      expect(hashToken(token1)).toBe(hashToken(token1));
      expect(hashToken(token1)).not.toBe(hashToken(token2));
      expect(hashToken(token1)).toHaveLength(64);
    });

    it("stores and retrieves verified tokens from Redis cache", async () => {
      const fakeRedis = createFakeRedis();
      const token = jwt.sign({ tx_hash: "hash-redis", amount: "0.01" }, JWT_SECRET);
      const payload = { tx_hash: "hash-redis", amount: "0.01", exp: Math.floor(Date.now() / 1000) + 120 };

      // Initial get should be a miss
      const miss = await getCachedToken(token, { redisClient: fakeRedis });
      expect(miss).toBeNull();

      // Store in Redis
      await setCachedToken(token, payload, { redisClient: fakeRedis });

      // Next get should hit Redis
      const hit = await getCachedToken(token, { redisClient: fakeRedis });
      expect(hit).toEqual(payload);
    });

    it("falls back gracefully to in-memory cache when Redis is unavailable", async () => {
      const token = jwt.sign({ tx_hash: "hash-memory", amount: "0.05" }, JWT_SECRET);
      const payload = { tx_hash: "hash-memory", amount: "0.05", exp: Math.floor(Date.now() / 1000) + 60 };

      // With no Redis client, set in memory
      await setCachedToken(token, payload, { redisClient: null });
      expect(getX402Telemetry().inMemoryCacheSize).toBe(1);

      // Retrieve from memory
      const cached = await getCachedToken(token, { redisClient: null });
      expect(cached).toEqual(payload);
    });

    it("evicts expired tokens from memory cache", async () => {
      const token = jwt.sign({ tx_hash: "hash-expired" }, JWT_SECRET);
      const expiredPayload = { tx_hash: "hash-expired", exp: Math.floor(Date.now() / 1000) - 10 };

      await setCachedToken(token, expiredPayload, { redisClient: null, ttlSec: -10 });
      const cached = await getCachedToken(token, { redisClient: null });
      expect(cached).toBeNull();
    });

    it("uses cached token in middleware without invoking jwt.verify repeatedly", async () => {
      const fakeRedis = createFakeRedis();
      const token = jwt.sign({ tx_hash: "hash-middleware-cache", user: "agent-01" }, JWT_SECRET);

      const middleware = x402Middleware({
        amount: "0.01",
        recipient: VALID_STELLAR_KEY,
        redisClient: fakeRedis,
      });

      const spyJwtVerify = vi.spyOn(jwt, "verify");

      // First request: Cache miss -> verify called
      const req1 = makeReq({ "x-payment-token": token });
      const res1 = makeRes();
      const next1 = vi.fn();
      await middleware(req1, res1, next1);

      expect(next1).toHaveBeenCalledTimes(1);
      expect(spyJwtVerify).toHaveBeenCalledTimes(1);
      res1.emit("finish");

      // Second request: Cache hit -> jwt.verify skipped!
      const req2 = makeReq({ "x-payment-token": token });
      const res2 = makeRes();
      const next2 = vi.fn();
      await middleware(req2, res2, next2);

      expect(next2).toHaveBeenCalledTimes(1);
      expect(spyJwtVerify).toHaveBeenCalledTimes(1); // Still 1!
      expect(req2.x402.tx_hash).toBe("hash-middleware-cache");
      res2.emit("finish");

      spyJwtVerify.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Issue #1628: Automated Dead-Letter Queue Recovery and Retry Logic
  // -------------------------------------------------------------------------
  describe("Dead-Letter Queue Recovery and Retry Logic (Issue #1628)", () => {
    describe("isRetryableX402Error", () => {
      it("identifies transient errors correctly", () => {
        expect(isRetryableX402Error(new Error("ETIMEDOUT: connection timed out"))).toBe(true);
        expect(isRetryableX402Error({ code: "ECONNRESET" })).toBe(true);
        expect(isRetryableX402Error(new Error("redis connection failure"))).toBe(true);
        expect(isRetryableX402Error(new Error("Invalid token signature"))).toBe(false);
      });
    });

    describe("executeWithRetry", () => {
      it("succeeds on first attempt without retrying", async () => {
        const fn = vi.fn(async () => "success");
        const res = await executeWithRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
        expect(res).toBe("success");
        expect(fn).toHaveBeenCalledTimes(1);
      });

      it("retries on transient errors and succeeds when transient error clears", async () => {
        let attempts = 0;
        const fn = vi.fn(async () => {
          attempts++;
          if (attempts < 2) {
            const err = new Error("network timeout");
            err.code = "ETIMEDOUT";
            throw err;
          }
          return "recovered";
        });

        const res = await executeWithRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
        expect(res).toBe("recovered");
        expect(fn).toHaveBeenCalledTimes(2);
      });

      it("does not retry non-retryable errors", async () => {
        const fn = vi.fn(async () => {
          throw new TypeError("Unrecoverable type error");
        });

        await expect(executeWithRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow(TypeError);
        expect(fn).toHaveBeenCalledTimes(1);
      });
    });

    describe("enqueueDeadLetter and recoverDeadLetterQueue", () => {
      it("enqueues failed items to DLQ with initial pending status", async () => {
        const id = await enqueueDeadLetter({
          operationType: "test_op",
          payload: { orderId: "123" },
          error: new Error("Redis connection dropped"),
        });

        expect(id).toBeDefined();
        const stats = getDeadLetterQueueStats();
        expect(stats.total).toBe(1);
        expect(stats.pending).toBe(1);
      });

      it("recovers eligible pending items via recoverDeadLetterQueue", async () => {
        await enqueueDeadLetter({
          operationType: "payment_reconcile",
          payload: { paymentId: "pay-1" },
          error: new Error("temporary network issue"),
        }, { baseDelayMs: -10 }); // eligible immediately

        const recoveryHandler = vi.fn(async (entry) => {
          expect(entry.payload.paymentId).toBe("pay-1");
        });

        const result = await recoverDeadLetterQueue({ handler: recoveryHandler });
        expect(result.recovered).toBe(1);
        expect(recoveryHandler).toHaveBeenCalledTimes(1);

        const stats = getDeadLetterQueueStats();
        expect(stats.total).toBe(0);
        expect(stats.pending).toBe(0);
      });

      it("marks items as exhausted poison pills after exceeding max attempts", async () => {
        await enqueueDeadLetter({
          operationType: "failing_op",
          payload: { data: "test" },
          error: new Error("persistent error"),
        }, { baseDelayMs: -10 });

        const failingHandler = vi.fn(async () => {
          throw new Error("still failing");
        });

        for (let i = 0; i < 5; i++) {
          await recoverDeadLetterQueue({ handler: failingHandler, maxDlqRetries: 3 });
        }

        const stats = getDeadLetterQueueStats();
        expect(stats.exhausted).toBe(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Issue #1629: Concurrency Control and Atomic Transaction Handling
  // -------------------------------------------------------------------------
  describe("Concurrency Control and Atomic Transaction Handling (Issue #1629)", () => {
    it("acquires and releases distributed lock in Redis", async () => {
      const fakeRedis = createFakeRedis();
      const lockKey = "tx-sample-01";

      const first = await acquireX402Lock(lockKey, 5000, { redisClient: fakeRedis });
      expect(first.acquired).toBe(true);
      expect(first.token).toBeDefined();

      // Second acquire with same key must fail (mutual exclusion)
      const second = await acquireX402Lock(lockKey, 5000, { redisClient: fakeRedis });
      expect(second.acquired).toBe(false);

      // Release with correct token
      const released = await releaseX402Lock(lockKey, first.token, { redisClient: fakeRedis });
      expect(released).toBe(true);

      // Can now be acquired again
      const third = await acquireX402Lock(lockKey, 5000, { redisClient: fakeRedis });
      expect(third.acquired).toBe(true);
    });

    it("prevents releasing a lock with a mismatched token", async () => {
      const fakeRedis = createFakeRedis();
      const lockKey = "tx-sample-02";

      const lock = await acquireX402Lock(lockKey, 5000, { redisClient: fakeRedis });
      expect(lock.acquired).toBe(true);

      const wrongRelease = await releaseX402Lock(lockKey, "wrong-token", { redisClient: fakeRedis });
      expect(wrongRelease).toBe(false);
    });

    it("falls back to in-process locking when Redis is unavailable", async () => {
      const lockKey = "local-lock-01";

      const first = await acquireX402Lock(lockKey, 5000, { redisClient: null });
      expect(first.acquired).toBe(true);

      const second = await acquireX402Lock(lockKey, 5000, { redisClient: null });
      expect(second.acquired).toBe(false);

      const released = await releaseX402Lock(lockKey, first.token, { redisClient: null });
      expect(released).toBe(true);

      const third = await acquireX402Lock(lockKey, 5000, { redisClient: null });
      expect(third.acquired).toBe(true);
    });

    it("withX402Lock runs callback and automatically releases lock", async () => {
      const fakeRedis = createFakeRedis();
      let ran = false;

      await withX402Lock("atomic-op", async () => {
        ran = true;
      }, { redisClient: fakeRedis });

      expect(ran).toBe(true);

      // Lock should have been released
      const reacquire = await acquireX402Lock("atomic-op", 5000, { redisClient: fakeRedis });
      expect(reacquire.acquired).toBe(true);
    });

    it("rejects concurrent middleware requests for same token with 409 Conflict", async () => {
      const fakeRedis = createFakeRedis();
      const token = jwt.sign({ tx_hash: "concurrency-tx-1" }, JWT_SECRET);

      const middleware = x402Middleware({
        amount: "0.01",
        recipient: VALID_STELLAR_KEY,
        redisClient: fakeRedis,
        enableConcurrencyControl: true,
      });

      // Request 1 arrives and is in-flight (has not emitted "finish" or "close")
      const req1 = makeReq({ "x-payment-token": token });
      const res1 = makeRes();
      const next1 = vi.fn();
      await middleware(req1, res1, next1);
      expect(next1).toHaveBeenCalledTimes(1);

      // Request 2 arrives concurrently with identical token while req1 is still active
      const req2 = makeReq({ "x-payment-token": token });
      const res2 = makeRes();
      const next2 = vi.fn();
      await middleware(req2, res2, next2);

      expect(next2).not.toHaveBeenCalled();
      expect(res2.status).toHaveBeenCalledWith(409);
      expect(res2._json.code).toBe("X402_TRANSACTION_IN_PROGRESS");

      // Once Request 1 finishes, subsequent requests can be processed
      res1.emit("finish");

      const req3 = makeReq({ "x-payment-token": token });
      const res3 = makeRes();
      const next3 = vi.fn();
      await middleware(req3, res3, next3);
      expect(next3).toHaveBeenCalledTimes(1);
      res3.emit("finish");
    });
  });
});
