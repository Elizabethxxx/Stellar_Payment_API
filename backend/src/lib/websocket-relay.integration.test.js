/**
 * WebSocket Relay Service — integration suite (issue #1456).
 *
 * Wires the real relay modules together the way a relay worker does:
 *
 *   inbound frame -> origin/token checks -> size limit -> JSON parse
 *     -> sanitize -> batchInsertEvents -> dequeueNextEvent
 *     -> deliver through CircuitBreaker -> markEventComplete / markEventFailed
 *     -> DeadLetterQueue -> health snapshot + Prometheus metrics
 *
 * Only the database is faked (tests/helpers/fake-relay-db.js). It interprets
 * the exact SQL the query helpers emit.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { createFakeRelayDb } from "../../tests/helpers/fake-relay-db.js";
import {
  auditRelayEvent,
  enforceMessageSizeLimit,
  sanitizeRelayMessage,
  validateOrigin,
  verifyRelayToken,
} from "./websocket-relay-security.js";
import {
  CircuitBreaker,
  CircuitState,
  DeadLetterQueue,
  getRelayHealth,
  reconnectWithBackoff,
} from "./websocket-relay-recovery.js";
import {
  batchInsertEvents,
  dequeueNextEvent,
  getRecentEvents,
  markEventComplete,
  markEventFailed,
} from "./websocket-relay-queries.js";
import {
  relayDlqMessagesMovedTotal,
  relayDlqSize,
  relayEventsDequeuedTotal,
  relayEventsEnqueuedTotal,
  relayEventsFailedTotal,
  relayEventsProcessedTotal,
  relayMessagesReceivedTotal,
  relayMetricsRegister,
} from "./websocket-relay-metrics.js";

const SECRET = "relay-integration-secret";
const ALLOWED_ORIGINS = ["https://dashboard.example.com"];
const MAX_FRAME_BYTES = 4096;

async function metricValue(metric, labels = {}) {
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}

/**
 * Minimal relay worker composed from the production modules.
 */
function createRelay({ db, deliver, breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 }) }) {
  const dlq = new DeadLetterQueue();
  const audit = [];
  const emit = (line) => audit.push(JSON.parse(line));

  function authenticate({ origin, token }) {
    const originCheck = validateOrigin(origin, ALLOWED_ORIGINS);
    if (!originCheck.valid) {
      auditRelayEvent("connection.rejected", { reason: originCheck.reason }, { emit });
      return { ok: false, reason: originCheck.reason };
    }
    const tokenCheck = verifyRelayToken(token, SECRET);
    if (!tokenCheck.valid) {
      auditRelayEvent("connection.rejected", { reason: tokenCheck.reason }, { emit });
      return { ok: false, reason: tokenCheck.reason };
    }
    auditRelayEvent("connection.accepted", { sub: tokenCheck.payload.sub }, { emit });
    return { ok: true, claims: tokenCheck.payload };
  }

  async function ingest(frames) {
    const accepted = [];
    const rejected = [];
    for (const frame of frames) {
      try {
        enforceMessageSizeLimit(frame, MAX_FRAME_BYTES);
        const { sanitized } = sanitizeRelayMessage(JSON.parse(frame));
        relayMessagesReceivedTotal.inc({ type: "normal" });
        accepted.push(sanitized);
      } catch (err) {
        relayMessagesReceivedTotal.inc({ type: "error" });
        rejected.push(err.code ?? err.message);
      }
    }
    const events = accepted.map((m) => ({
      payment_id: m.payment_id,
      event_type: m.event_type,
      payload: m.payload,
    }));
    const inserted = await batchInsertEvents(db, events);
    for (const e of inserted) relayEventsEnqueuedTotal.inc({ event_type: e.event_type });
    return { inserted, rejected };
  }

  async function processOne() {
    const event = await dequeueNextEvent(db);
    if (!event) return null;
    relayEventsDequeuedTotal.inc();
    try {
      await breaker.call(() => deliver(event));
      await markEventComplete(db, event.id);
      relayEventsProcessedTotal.inc({ event_type: event.event_type });
      return { id: event.id, status: "completed" };
    } catch (err) {
      const reason = err.circuitOpen ? "circuit_open" : "delivery_failed";
      await markEventFailed(db, event.id, err.message);
      dlq.push(event, err, 1);
      relayEventsFailedTotal.inc({ event_type: event.event_type, reason });
      relayDlqMessagesMovedTotal.inc({ reason });
      relayDlqSize.set(dlq.size);
      return { id: event.id, status: "failed", reason };
    }
  }

  async function drain() {
    const results = [];
    for (let r = await processOne(); r; r = await processOne()) results.push(r);
    return results;
  }

  return { authenticate, ingest, processOne, drain, dlq, breaker, audit };
}

/** Hand-built `alg: none` JWT (jsonwebtoken refuses to sign one). */
function unsignedToken(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

const frame = (overrides = {}) =>
  JSON.stringify({
    type: "payment.event",
    payment_id: "pay_1",
    event_type: "payment.confirmed",
    payload: { amount: "10" },
    ...overrides,
  });

beforeEach(() => {
  relayMetricsRegister.resetMetrics();
});

describe("relay connection handshake", () => {
  it("accepts a whitelisted origin with a valid HS256 token", () => {
    const relay = createRelay({ db: createFakeRelayDb(), deliver: vi.fn() });
    const token = jwt.sign({ sub: "merchant_1" }, SECRET, { algorithm: "HS256", expiresIn: "1m" });
    const result = relay.authenticate({ origin: ALLOWED_ORIGINS[0], token });
    expect(result).toMatchObject({ ok: true, claims: { sub: "merchant_1" } });
    expect(relay.audit.at(-1)).toMatchObject({ audit: true, event: "connection.accepted", sub: "merchant_1" });
  });

  it.each([
    ["unknown origin", { origin: "https://evil.example.com" }],
    ["missing origin", { origin: "" }],
    ["origin differing only by case", { origin: "https://Dashboard.example.com" }],
  ])("rejects %s before looking at the token", (_label, { origin }) => {
    const relay = createRelay({ db: createFakeRelayDb(), deliver: vi.fn() });
    const token = jwt.sign({ sub: "m" }, SECRET);
    expect(relay.authenticate({ origin, token }).ok).toBe(false);
    expect(relay.audit.at(-1).event).toBe("connection.rejected");
  });

  it.each([
    ["wrong secret", () => jwt.sign({ sub: "m" }, "other-secret")],
    ["expired token", () => jwt.sign({ sub: "m", exp: Math.floor(Date.now() / 1000) - 10 }, SECRET)],
    ["alg=none token", () => unsignedToken({ sub: "m" })],
    ["HS512 token (algorithm pinned to HS256)", () => jwt.sign({ sub: "m" }, SECRET, { algorithm: "HS512" })],
    ["garbage", () => "not.a.jwt"],
  ])("rejects a %s", (_label, makeToken) => {
    const relay = createRelay({ db: createFakeRelayDb(), deliver: vi.fn() });
    const result = relay.authenticate({ origin: ALLOWED_ORIGINS[0], token: makeToken() });
    expect(result.ok).toBe(false);
  });

  it("audit entries cannot be forged through metadata", () => {
    const lines = [];
    auditRelayEvent(
      "connection.rejected",
      { audit: false, event: "connection.accepted", ts: "1970-01-01T00:00:00Z", reason: "x" },
      { emit: (l) => lines.push(JSON.parse(l)) },
    );
    expect(lines[0]).toMatchObject({ audit: true, event: "connection.rejected", reason: "x" });
    expect(lines[0].ts).not.toBe("1970-01-01T00:00:00Z");
  });
});

describe("relay message pipeline", () => {
  it("ingests, dequeues, delivers and completes events end to end", async () => {
    const db = createFakeRelayDb();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const relay = createRelay({ db, deliver });

    const { inserted, rejected } = await relay.ingest([
      frame({ payment_id: "pay_1" }),
      frame({ payment_id: "pay_2", event_type: "payment.failed" }),
    ]);
    expect(inserted).toHaveLength(2);
    expect(rejected).toEqual([]);

    const results = await relay.drain();
    expect(results.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(deliver.mock.calls.map(([e]) => e.payment_id)).toEqual(["pay_1", "pay_2"]); // FIFO
    expect(db.countBy("completed")).toBe(2);
    expect(await metricValue(relayEventsEnqueuedTotal)).toBe(2);
    expect(await metricValue(relayEventsProcessedTotal)).toBe(2);
    expect(getRelayHealth({ circuitBreaker: relay.breaker, dlq: relay.dlq }).status).toBe("healthy");
  });

  it("strips unknown and prototype-polluting fields before persisting", async () => {
    const db = createFakeRelayDb();
    const relay = createRelay({ db, deliver: vi.fn() });
    const raw = '{"type":"payment.event","payment_id":"pay_9","event_type":"x","__proto__":{"admin":true},"sql":"DROP TABLE"}';

    await relay.ingest([raw]);

    const stored = db.rows[0];
    expect(stored.payment_id).toBe("pay_9");
    expect(stored).not.toHaveProperty("sql");
    expect({}.admin).toBeUndefined();
    const insert = db.statements.find((s) => /INSERT/.test(s.sql));
    expect(insert.params).not.toContain("DROP TABLE");
    expect(insert.sql).not.toContain("DROP TABLE"); // values are parameterised
  });

  it("rejects oversized, malformed and typeless frames without touching the database", async () => {
    const db = createFakeRelayDb();
    const relay = createRelay({ db, deliver: vi.fn() });
    const { inserted, rejected } = await relay.ingest([
      "x".repeat(MAX_FRAME_BYTES + 1),
      "{not json",
      JSON.stringify({ payment_id: "p" }),
      JSON.stringify([1, 2]),
    ]);
    expect(inserted).toEqual([]);
    expect(rejected[0]).toBe("MESSAGE_TOO_LARGE");
    expect(rejected).toHaveLength(4);
    expect(db.statements).toHaveLength(0);
    expect(await metricValue(relayMessagesReceivedTotal, { type: "error" })).toBe(4);
  });

  it("rejects the whole batch when a frame lacks payment_id (validated before SQL)", async () => {
    const db = createFakeRelayDb();
    const relay = createRelay({ db, deliver: vi.fn() });
    await expect(relay.ingest([frame(), frame({ payment_id: "  " })])).rejects.toThrow(
      /Invalid events for batch insert/,
    );
    expect(db.rows).toHaveLength(0);
  });

  it("marks failed deliveries, dead-letters them and opens the circuit", async () => {
    const db = createFakeRelayDb();
    const deliver = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const relay = createRelay({ db, deliver });
    await relay.ingest(Array.from({ length: 5 }, (_, i) => frame({ payment_id: `pay_${i}` })));

    const results = await relay.drain();

    expect(deliver).toHaveBeenCalledTimes(3); // threshold reached, then fast-fail
    expect(results.map((r) => r.reason)).toEqual([
      "delivery_failed",
      "delivery_failed",
      "delivery_failed",
      "circuit_open",
      "circuit_open",
    ]);
    expect(relay.breaker.state).toBe(CircuitState.OPEN);
    expect(db.countBy("failed")).toBe(5);
    expect(db.rows[0].error_message).toBe("socket hang up");
    expect(relay.dlq.size).toBe(5);
    expect(await metricValue(relayDlqSize)).toBe(5);
    expect(await metricValue(relayDlqMessagesMovedTotal, { reason: "circuit_open" })).toBe(2);
    expect(getRelayHealth({ circuitBreaker: relay.breaker, dlq: relay.dlq })).toMatchObject({
      status: "degraded",
      circuitState: "OPEN",
      dlqSize: 5,
      lastError: "socket hang up",
    });
  });

  it("recovers through HALF_OPEN and replays the dead letter queue", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: () => now });
    const db = createFakeRelayDb();
    const deliver = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    const relay = createRelay({ db, deliver, breaker });
    await relay.ingest([frame({ payment_id: "a" }), frame({ payment_id: "b" })]);

    await relay.drain();
    expect(relay.dlq.size).toBe(2);

    now += 1000;
    const replayed = [];
    for (let entry = relay.dlq.shift(); entry; entry = relay.dlq.shift()) {
      await breaker.call(() => deliver(entry.message));
      replayed.push(entry.message.payment_id);
    }
    expect(replayed).toEqual(["a", "b"]);
    expect(breaker.state).toBe(CircuitState.CLOSED);
    expect(getRelayHealth({ circuitBreaker: breaker, dlq: relay.dlq }).status).toBe("healthy");
  });

  it("does not complete an event twice", async () => {
    const db = createFakeRelayDb();
    const relay = createRelay({ db, deliver: vi.fn() });
    await relay.ingest([frame()]);
    const [{ id }] = await relay.drain();

    await expect(markEventComplete(db, id)).resolves.toBeNull();
    await expect(markEventFailed(db, id, "late failure")).resolves.toBeNull();
    expect(db.rows[0].status).toBe("completed");
  });

  it("wraps database failures with context and keeps the event pending", async () => {
    const db = createFakeRelayDb();
    const relay = createRelay({ db, deliver: vi.fn() });
    await relay.ingest([frame()]);
    db.failNext(1);

    await expect(relay.processOne()).rejects.toThrow(/Failed to dequeue relay event: connection terminated/);
    expect(db.countBy("pending")).toBe(1);
    await expect(relay.processOne()).resolves.toMatchObject({ status: "completed" });
  });

  it("pages recent events newest first with clamped limits", async () => {
    const db = createFakeRelayDb();
    const relay = createRelay({ db, deliver: vi.fn() });
    await relay.ingest(Array.from({ length: 5 }, (_, i) => frame({ payment_id: `p${i}` })));

    const page = await getRecentEvents(db, 2, 1);
    expect(page.map((r) => r.payment_id)).toEqual(["p3", "p2"]);
    expect(await getRecentEvents(db, -5, -1)).toHaveLength(1); // limit clamped to 1, offset to 0
    const last = db.statements.at(-1);
    expect(last.params).toEqual([1, 0]);
  });
});

describe("relay reconnection", () => {
  it("reconnects after transient failures with growing, capped delays", async () => {
    const delays = [];
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue("socket");

    await expect(
      reconnectWithBackoff(connect, {
        maxRetries: 5,
        baseDelayMs: 100,
        maxDelayMs: 250,
        sleep: async (ms) => delays.push(ms),
      }),
    ).resolves.toBe("socket");

    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(90);
    expect(delays[0]).toBeLessThanOrEqual(110);
    expect(delays[1]).toBeGreaterThanOrEqual(180);
    expect(delays[2]).toBeLessThanOrEqual(275); // capped at 250 +10% jitter
  });

  it("surfaces the last error when every attempt fails", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("host unreachable"));
    await expect(
      reconnectWithBackoff(connect, { maxRetries: 2, sleep: async () => {} }),
    ).rejects.toThrow("host unreachable");
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
