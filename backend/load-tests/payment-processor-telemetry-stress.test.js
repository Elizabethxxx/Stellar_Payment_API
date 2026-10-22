/**
 * Payment Processor Telemetry — stress suite (issue #1481).
 *
 * Pushes the payment-processor metric series far past normal volume and
 * checks the invariants monitoring relies on:
 *   - no lost increments under heavy concurrent writes
 *   - series cardinality stays bounded under adversarial asset values
 *   - histogram sums and counts stay exact at volume
 *   - scrape latency stays bounded while writes continue
 *
 * Run with: npm run test:load -- payment-processor-telemetry
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  paymentProcessorRefundsTotal,
  paymentProcessorRegister,
  paymentProcessorSessionDuration,
  paymentProcessorSessionsTotal,
  paymentProcessorVerificationDuration,
  paymentProcessorVerificationsTotal,
  toAssetLabel,
} from "../src/lib/payment-processor-metrics.js";

const SESSION_OUTCOMES = ["created", "validation_failed", "persistence_failed", "sandbox_skipped"];
const VERIFY_OUTCOMES = [
  "confirmed",
  "already_confirmed",
  "pending_no_match",
  "signature_invalid",
  "underpayment",
  "overpayment",
  "tx_claim_conflict",
  "error",
];

/** Seeded PRNG so runs are reproducible. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

async function seriesCount(metric) {
  return (await metric.get()).values.length;
}

async function total(metric, filter = () => true) {
  return (await metric.get()).values.filter((v) => filter(v.labels)).reduce((s, v) => s + v.value, 0);
}

describe("Payment Processor Telemetry — stress (#1481)", () => {
  beforeEach(() => {
    paymentProcessorSessionsTotal.reset();
    paymentProcessorSessionDuration.reset();
    paymentProcessorVerificationsTotal.reset();
    paymentProcessorVerificationDuration.reset();
    paymentProcessorRefundsTotal.reset();
  });

  it("loses no increments across 100 concurrent workers x 1,000 events", async () => {
    const random = mulberry32(1481);
    const expected = new Map();

    await Promise.all(
      Array.from({ length: 100 }, async () => {
        for (let i = 0; i < 1_000; i += 1) {
          const outcome = SESSION_OUTCOMES[Math.floor(random() * SESSION_OUTCOMES.length)];
          paymentProcessorSessionsTotal.inc({ asset: "XLM", outcome });
          expected.set(outcome, (expected.get(outcome) ?? 0) + 1);
          if (i % 250 === 0) await yieldToLoop();
        }
      }),
    );

    expect(await total(paymentProcessorSessionsTotal)).toBe(100_000);
    for (const [outcome, count] of expected) {
      expect(await total(paymentProcessorSessionsTotal, (l) => l.outcome === outcome)).toBe(count);
    }
  });

  it("keeps cardinality bounded under 50,000 adversarial asset values", async () => {
    const random = mulberry32(7);
    for (let i = 0; i < 50_000; i += 1) {
      const raw = `${Math.floor(random() * 1e12).toString(36)}-${i}`; // always invalid (contains "-")
      const asset = toAssetLabel(i % 10 === 0 ? "XLM" : raw);
      paymentProcessorSessionsTotal.inc({ asset, outcome: "validation_failed" });
    }

    // XLM + invalid, one outcome each: two series, not 50,000.
    expect(await seriesCount(paymentProcessorSessionsTotal)).toBe(2);
    expect(await total(paymentProcessorSessionsTotal)).toBe(50_000);
  });

  it("caps the label space at assets x outcomes even with every valid code", async () => {
    const codes = ["XLM", "USDC", "EURC", "BTC", "ETH", "AQUA", "YXLM", "SHX"];
    for (let i = 0; i < 20_000; i += 1) {
      const outcome = VERIFY_OUTCOMES[i % VERIFY_OUTCOMES.length];
      paymentProcessorVerificationsTotal.inc({ asset: toAssetLabel(codes[i % codes.length]), outcome });
    }
    expect(await seriesCount(paymentProcessorVerificationsTotal)).toBeLessThanOrEqual(codes.length * VERIFY_OUTCOMES.length);
  });

  it("keeps histogram count and sum exact at volume", async () => {
    const random = mulberry32(99);
    let expectedSum = 0;
    const n = 100_000;
    for (let i = 0; i < n; i += 1) {
      const seconds = Math.round(random() * 10_000) / 1_000; // millisecond resolution, 0-10s
      expectedSum += seconds;
      paymentProcessorVerificationDuration.observe({ asset: "XLM", outcome: "confirmed" }, seconds);
    }

    const { values } = await paymentProcessorVerificationDuration.get();
    const count = values.find((v) => v.metricName === "payment_processor_verification_duration_seconds_count").value;
    const sum = values.find((v) => v.metricName === "payment_processor_verification_duration_seconds_sum").value;
    const inf = values.find((v) => v.metricName.endsWith("_bucket") && v.labels.le === "+Inf").value;
    expect(count).toBe(n);
    expect(inf).toBe(n);
    expect(sum).toBeCloseTo(expectedSum, 3);
  });

  it("serves scrapes quickly while writes continue", async () => {
    for (const outcome of SESSION_OUTCOMES) {
      paymentProcessorSessionDuration.observe({ asset: "XLM", outcome }, 0.01);
    }

    let writing = true;
    const writer = (async () => {
      let i = 0;
      while (writing) {
        paymentProcessorRefundsTotal.inc({ stage: i % 2 ? "generate" : "confirm", outcome: "success" });
        i += 1;
        if (i % 500 === 0) await yieldToLoop();
      }
    })();

    const latencies = [];
    for (let i = 0; i < 50; i += 1) {
      const started = performance.now();
      const text = await paymentProcessorRegister.metrics();
      latencies.push(performance.now() - started);
      expect(text).toContain("payment_processor_refunds_total");
      await yieldToLoop();
    }
    writing = false;
    await writer;

    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    console.log(`[telemetry-stress] scrape p95=${p95.toFixed(2)}ms max=${latencies.at(-1).toFixed(2)}ms`);
    expect(p95).toBeLessThan(100);
  });
});
