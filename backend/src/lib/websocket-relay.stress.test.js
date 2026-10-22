/**
 * WebSocket Relay Service — stress suite (issue #1456).
 *
 * Exercises the relay primitives under concurrency and volume. Assertions
 * focus on correctness under load (exactly-once claiming, bounded memory,
 * fast-fail). Timing budgets are deliberately generous so CI noise does not
 * cause flakes; they exist to catch pathological (quadratic or blocking)
 * regressions, not to benchmark.
 */

import { describe, it, expect, vi } from "vitest";
import { createFakeRelayDb } from "../../tests/helpers/fake-relay-db.js";
import { enforceMessageSizeLimit, sanitizeRelayMessage } from "./websocket-relay-security.js";
import {
  CircuitBreaker,
  CircuitState,
  DeadLetterQueue,
  reconnectWithBackoff,
} from "./websocket-relay-recovery.js";
import {
  batchInsertEvents,
  dequeueNextEvent,
  markEventComplete,
} from "./websocket-relay-queries.js";

const STRESS_TIMEOUT_MS = 30_000;

function makeEvents(count, prefix = "pay") {
  return Array.from({ length: count }, (_, i) => ({
    payment_id: `${prefix}_${i}`,
    event_type: i % 2 ? "payment.confirmed" : "payment.failed",
    payload: { seq: i },
  }));
}

async function consumer(db, deliver) {
  const claimed = [];
  for (let event = await dequeueNextEvent(db); event; event = await dequeueNextEvent(db)) {
    claimed.push(event.id);
    await deliver(event);
    await markEventComplete(db, event.id);
  }
  return claimed;
}

describe("relay queue under concurrent consumers", () => {
  it(
    "50 consumers drain 2,000 events with every event claimed exactly once",
    async () => {
      const db = createFakeRelayDb({ latencyMs: 0 });
      for (let i = 0; i < 4; i += 1) {
        await batchInsertEvents(db, makeEvents(500, `batch${i}`));
      }
      const deliver = vi.fn(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });

      const perConsumer = await Promise.all(Array.from({ length: 50 }, () => consumer(db, deliver)));
      const claimed = perConsumer.flat();

      expect(claimed).toHaveLength(2000);
      expect(new Set(claimed).size).toBe(2000);
      expect(deliver).toHaveBeenCalledTimes(2000);
      expect(db.countBy("completed")).toBe(2000);
      expect(db.countBy("pending") + db.countBy("processing")).toBe(0);
      // Work is actually spread across consumers, not serialised on one.
      expect(perConsumer.filter((ids) => ids.length > 0).length).toBeGreaterThan(1);
    },
    STRESS_TIMEOUT_MS,
  );

  it(
    "interleaved async latency still never double-claims",
    async () => {
      const db = createFakeRelayDb({ latencyMs: 1 });
      await batchInsertEvents(db, makeEvents(200));

      const claimed = (await Promise.all(Array.from({ length: 20 }, () => consumer(db, async () => {})))).flat();

      expect(new Set(claimed).size).toBe(claimed.length);
      expect(claimed).toHaveLength(200);
    },
    STRESS_TIMEOUT_MS,
  );

  it("batch-inserts 1,000 events in a single parameterised statement", async () => {
    const db = createFakeRelayDb();
    const inserted = await batchInsertEvents(db, makeEvents(1000));
    expect(inserted).toHaveLength(1000);
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0].params).toHaveLength(4000);
    expect(db.statements[0].sql).toContain("$4000");
  });
});

describe("relay ingress under volume", () => {
  it(
    "sanitizes and size-checks 10,000 frames quickly and deterministically",
    () => {
      const frames = Array.from({ length: 10_000 }, (_, i) =>
        JSON.stringify({
          type: "payment.event",
          payment_id: `pay_${i}`,
          event_type: "payment.confirmed",
          payload: { seq: i },
          injected: "<script>",
          __proto__: { polluted: true },
        }),
      );

      const start = performance.now();
      let warnings = 0;
      for (const raw of frames) {
        enforceMessageSizeLimit(raw, 65_536);
        const { sanitized, warnings: w } = sanitizeRelayMessage(JSON.parse(raw));
        expect(sanitized).not.toHaveProperty("injected");
        warnings += w.length;
      }
      const elapsed = performance.now() - start;

      expect(warnings).toBe(10_000);
      expect({}.polluted).toBeUndefined();
      expect(elapsed).toBeLessThan(5_000);
    },
    STRESS_TIMEOUT_MS,
  );

  it("rejects a flood of oversized frames without buffering them", () => {
    const big = Buffer.alloc(65_537, 0x61);
    let rejected = 0;
    for (let i = 0; i < 1_000; i += 1) {
      try {
        enforceMessageSizeLimit(big);
      } catch (err) {
        if (err.code === "MESSAGE_TOO_LARGE") rejected += 1;
      }
    }
    expect(rejected).toBe(1_000);
  });

  it("measures multi-byte frames in bytes, not characters", () => {
    const emoji = "\u{1F4B8}".repeat(20_000); // 4 bytes each = 80,000 bytes, 40,000 UTF-16 units
    expect(() => enforceMessageSizeLimit(emoji)).toThrow(/exceeds limit/);
  });
});

describe("circuit breaker under load", () => {
  it(
    "fast-fails 1,000 concurrent calls once open without touching the dependency",
    async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 60_000 });
      const failing = vi.fn().mockRejectedValue(new Error("upstream down"));
      for (let i = 0; i < 5; i += 1) await breaker.call(failing).catch(() => {});
      expect(breaker.state).toBe(CircuitState.OPEN);

      const dependency = vi.fn();
      const results = await Promise.allSettled(
        Array.from({ length: 1_000 }, () => breaker.call(dependency)),
      );

      expect(dependency).not.toHaveBeenCalled();
      expect(results.every((r) => r.status === "rejected" && r.reason.circuitOpen === true)).toBe(true);
    },
    STRESS_TIMEOUT_MS,
  );

  it(
    "keeps counting correctly across 10,000 mixed outcomes",
    async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 0 });
      let successes = 0;
      for (let i = 0; i < 10_000; i += 1) {
        const fail = i % 3 === 0;
        await breaker
          .call(() => (fail ? Promise.reject(new Error("x")) : Promise.resolve(i)))
          .then(() => (successes += 1))
          .catch(() => {});
      }
      // A failure is always followed by successes, so the breaker never trips.
      expect(breaker.state).toBe(CircuitState.CLOSED);
      expect(successes).toBe(6_666);
    },
    STRESS_TIMEOUT_MS,
  );
});

describe("dead letter queue and reconnects at scale", () => {
  it("holds and drains 10,000 entries in FIFO order", () => {
    const dlq = new DeadLetterQueue();
    for (let i = 0; i < 10_000; i += 1) dlq.push({ seq: i }, new Error(`e${i}`), i % 5);
    expect(dlq.size).toBe(10_000);

    let expected = 0;
    for (let entry = dlq.shift(); entry; entry = dlq.shift()) {
      expect(entry.message.seq).toBe(expected);
      expected += 1;
    }
    expect(expected).toBe(10_000);
    expect(dlq.size).toBe(0);
  });

  it("does not leak caller mutations into stored entries via getAll()", () => {
    const dlq = new DeadLetterQueue();
    dlq.push({ seq: 1 }, "plain string error");
    const snapshot = dlq.getAll();
    snapshot.length = 0;
    expect(dlq.size).toBe(1);
    expect(dlq.getAll()[0].errorMessage).toBe("plain string error");
  });

  it(
    "200 concurrent reconnect loops stay within the delay cap",
    async () => {
      const maxObserved = [];
      await Promise.all(
        Array.from({ length: 200 }, async () => {
          let attempts = 0;
          const delays = [];
          await reconnectWithBackoff(
            async () => {
              attempts += 1;
              if (attempts < 6) throw new Error("refused");
              return "ok";
            },
            { maxRetries: 10, baseDelayMs: 50, maxDelayMs: 400, sleep: async (ms) => delays.push(ms) },
          );
          maxObserved.push(Math.max(...delays));
        }),
      );
      expect(maxObserved).toHaveLength(200);
      expect(Math.max(...maxObserved)).toBeLessThanOrEqual(440); // 400 cap + 10% jitter
      // Jitter spreads retries: the 200 loops do not all pick the same delay.
      expect(new Set(maxObserved).size).toBeGreaterThan(1);
    },
    STRESS_TIMEOUT_MS,
  );
});
