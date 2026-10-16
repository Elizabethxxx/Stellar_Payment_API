/**
 * Idempotency Key Manager middleware with Redis retry/backoff (#1464).
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { redis: null } }));

vi.mock("./redis.js", () => ({
  getRedisClient: vi.fn(() => state.redis),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Make backoff instant so tests do not wait on real timers.
vi.mock("./idempotency-retry.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    withIdempotencyRetry: (operation, fn, options = {}) =>
      actual.withIdempotencyRetry(operation, fn, { sleep: async () => {}, ...options }),
  };
});

import {
  buildIdempotencyRedisKey,
  hashIdempotencyPayload,
  idempotencyMiddleware,
  lookupIdempotentResponse,
} from "./idempotency.js";
import { idempotencyRedisOperationsTotal, idempotencyRegister } from "./idempotency-retry.js";

const MERCHANT_ID = "merchant-1";

function transient() {
  const err = new Error("Socket closed unexpectedly");
  err.name = "SocketClosedUnexpectedlyError";
  return err;
}

function createRedis() {
  const store = new Map();
  return {
    store,
    get: vi.fn(async (key) => store.get(key) ?? null),
    set: vi.fn(async (key, value) => {
      store.set(key, value);
      return "OK";
    }),
  };
}

function createApp(handler = vi.fn((req, res) => res.status(201).json({ id: "pay_1", n: Math.random() }))) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.merchant = { id: MERCHANT_ID };
    next();
  });
  app.post("/api/payments", idempotencyMiddleware, handler);
  return { app, handler };
}

async function outcome(operation, result) {
  const { values } = await idempotencyRedisOperationsTotal.get();
  return values.find((v) => v.labels.operation === operation && v.labels.outcome === result)?.value ?? 0;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  state.redis = createRedis();
  idempotencyRegister.resetMetrics();
});

describe("idempotencyMiddleware with Redis retries", () => {
  it("caches the first response and replays it for the same key", async () => {
    const { app, handler } = createApp();
    const first = await request(app).post("/api/payments").set("Idempotency-Key", "k1").send({ amount: 1 });
    await flush();
    const second = await request(app).post("/api/payments").set("Idempotency-Key", "k1").send({ amount: 1 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("retries a transient read failure and still replays the cached response", async () => {
    const { app, handler } = createApp();
    await request(app).post("/api/payments").set("Idempotency-Key", "k2").send({ amount: 1 });
    await flush();

    state.redis.get.mockRejectedValueOnce(transient());
    const replay = await request(app).post("/api/payments").set("Idempotency-Key", "k2").send({ amount: 1 });

    expect(replay.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1); // no duplicate payment
    expect(await outcome("get", "recovered")).toBe(1);
  });

  it("retries a transient write failure so the response is still cached", async () => {
    const { app, handler } = createApp();
    state.redis.set.mockRejectedValueOnce(transient());

    await request(app).post("/api/payments").set("Idempotency-Key", "k3").send({ amount: 1 });
    await flush();
    await request(app).post("/api/payments").set("Idempotency-Key", "k3").send({ amount: 1 });

    expect(state.redis.set).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await outcome("set", "recovered")).toBe(1);
  });

  it("fails open (unchanged behaviour) when Redis stays down after retries", async () => {
    const { app, handler } = createApp();
    state.redis.get.mockRejectedValue(transient());

    const res = await request(app).post("/api/payments").set("Idempotency-Key", "k4").send({ amount: 1 });

    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(state.redis.get).toHaveBeenCalledTimes(3); // default: 1 + 2 retries
    expect(await outcome("get", "failed")).toBe(1);
  });

  it("does not retry a closed client", async () => {
    const { app } = createApp();
    state.redis.get.mockRejectedValue(Object.assign(new Error("The client is closed"), { name: "ClientClosedError" }));

    const res = await request(app).post("/api/payments").set("Idempotency-Key", "k5").send({ amount: 1 });

    expect(res.status).toBe(201);
    expect(state.redis.get).toHaveBeenCalledTimes(1);
  });

  it("still rejects a reused key with a different payload", async () => {
    const { app } = createApp();
    await request(app).post("/api/payments").set("Idempotency-Key", "k6").send({ amount: 1 });
    await flush();
    const res = await request(app).post("/api/payments").set("Idempotency-Key", "k6").send({ amount: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different request payload/);
  });

  it("does not touch Redis for requests without an Idempotency-Key", async () => {
    const { app } = createApp();
    await request(app).post("/api/payments").send({ amount: 1 });
    expect(state.redis.get).not.toHaveBeenCalled();
  });
});

describe("lookupIdempotentResponse with retries", () => {
  const payloadHash = hashIdempotencyPayload({ amount: 1 });
  const key = buildIdempotencyRedisKey(MERCHANT_ID, "k7");

  it("recovers from a transient error and returns the hit", async () => {
    state.redis.store.set(key, JSON.stringify({ hash: payloadHash, response: { id: "pay_7" } }));
    state.redis.get.mockRejectedValueOnce(transient());

    await expect(
      lookupIdempotentResponse({ redisClient: state.redis, merchantId: MERCHANT_ID, idempotencyKey: "k7", payloadHash }),
    ).resolves.toEqual({ status: "hit", response: { id: "pay_7" } });
    expect(await outcome("lookup", "recovered")).toBe(1);
  });

  it("propagates the error once retries are exhausted", async () => {
    state.redis.get.mockRejectedValue(transient());
    await expect(
      lookupIdempotentResponse({
        redisClient: state.redis,
        merchantId: MERCHANT_ID,
        idempotencyKey: "k7",
        payloadHash,
        retryOptions: { maxRetries: 1 },
      }),
    ).rejects.toThrow("Socket closed unexpectedly");
    expect(state.redis.get).toHaveBeenCalledTimes(2);
  });

  it("returns null without calling Redis when inputs are missing", async () => {
    await expect(lookupIdempotentResponse({ redisClient: state.redis, merchantId: MERCHANT_ID })).resolves.toBeNull();
    expect(state.redis.get).not.toHaveBeenCalled();
  });
});
