import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_RETENTION_DAYS,
  LogRetentionValidationError,
  assertPurgeTarget,
  parsePositiveInteger,
  purgeWebhookLogs,
  sanitizeLogMessage,
  validatePurgeOptions,
} from "./log-retention.js";

/** A pool whose safety checks pass and whose deletes return the given counts. */
function poolWithDeletes(...counts) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
    .mockResolvedValueOnce({ rowCount: 0, rows: [] });
  for (const count of counts) {
    query.mockResolvedValueOnce({ rowCount: count, rows: [] });
  }
  return { query };
}

const quietLogger = () => ({ log: vi.fn(), error: vi.fn() });

describe("parsePositiveInteger (issue #1472)", () => {
  it.each([
    ["30", 30],
    [" 7 ", 7],
    [45, 45],
  ])("accepts %j", (value, expected) => {
    expect(parsePositiveInteger(value, 1)).toBe(expected);
  });

  it.each([undefined, null, ""])("returns the fallback for %j", (value) => {
    expect(parsePositiveInteger(value, 12)).toBe(12);
  });

  it.each(["30days", "1e3", "-5", "0", "0x10", "1.5", "  ", "9".repeat(20), 1.5, -1, 0, NaN, Infinity, true, {}, []])(
    "rejects %j instead of coercing it",
    (value) => {
      expect(() => parsePositiveInteger(value, 1, { name: "LOG_RETENTION_DAYS" })).toThrow(LogRetentionValidationError);
    },
  );

  it("enforces bounds and names the setting", () => {
    expect(() => parsePositiveInteger("4000", 1, { name: "retentionDays", min: 1, max: 3650 })).toThrow(
      "retentionDays must be between 1 and 3650, got 4000",
    );
  });

  it("does not echo control characters or long input back", () => {
    let message = "";
    try {
      parsePositiveInteger(`12\n[ALERT] forged log line ${"x".repeat(100)}`, 1, { name: "x" });
    } catch (err) {
      message = err.message;
    }
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThan(120);
  });
});

describe("validatePurgeOptions", () => {
  it("applies defaults and environment variables", () => {
    const pool = { query: vi.fn() };
    expect(validatePurgeOptions({ pool }, {})).toMatchObject({
      retentionDays: DEFAULT_RETENTION_DAYS,
      batchSize: DEFAULT_BATCH_SIZE,
    });
    expect(validatePurgeOptions({ pool }, { LOG_RETENTION_DAYS: "90", LOG_PURGE_BATCH_SIZE: "500" })).toMatchObject({
      retentionDays: 90,
      batchSize: 500,
    });
  });

  it("lets explicit options override the environment", () => {
    const opts = validatePurgeOptions({ pool: { query: vi.fn() }, retentionDays: 14 }, { LOG_RETENTION_DAYS: "90" });
    expect(opts.retentionDays).toBe(14);
  });

  it("names the environment variable that is invalid", () => {
    expect(() => validatePurgeOptions({ pool: { query: vi.fn() } }, { LOG_PURGE_BATCH_SIZE: "lots" })).toThrow(
      /LOG_PURGE_BATCH_SIZE/,
    );
  });

  it.each([
    [{ retentionDays: 0 }, "retentionDays"],
    [{ retentionDays: 5000 }, "retentionDays"],
    [{ batchSize: 100_000 }, "batchSize"],
    [{ maxDurationMs: 10 }, "maxDurationMs"],
    [{ maxBatches: -1 }, "maxBatches"],
  ])("rejects out-of-range option %j", (extra, field) => {
    let caught;
    try {
      validatePurgeOptions({ pool: { query: vi.fn() }, ...extra }, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LogRetentionValidationError);
    expect(caught.field).toBe(field);
  });

  it("rejects unknown option keys", () => {
    expect(() => validatePurgeOptions({ pool: { query: vi.fn() }, retentiondays: 7 }, {})).toThrow(/Unknown purgeWebhookLogs option/);
  });

  it("rejects non-object options and invalid pools or loggers", () => {
    expect(() => validatePurgeOptions(null, {})).toThrow(LogRetentionValidationError);
    expect(() => validatePurgeOptions([], {})).toThrow(LogRetentionValidationError);
    expect(() => validatePurgeOptions({}, {})).toThrow("A pg pool/client is required for purgeWebhookLogs.");
    expect(() => validatePurgeOptions({ pool: {} }, {})).toThrow(/query\(\) function/);
    expect(() => validatePurgeOptions({ pool: { query: vi.fn() }, logger: {} }, {})).toThrow(/logger/);
  });
});

describe("assertPurgeTarget", () => {
  it("allows the webhook log table", () => {
    expect(() => assertPurgeTarget("webhook_delivery_logs", "timestamp")).not.toThrow();
  });

  it.each([
    ["payments", "created_at"],
    ["webhook_delivery_logs", "id"],
    ["webhook_delivery_logs; DROP TABLE payments", "timestamp"],
    ['"webhook_delivery_logs"', "timestamp"],
  ])("rejects %s.%s", (table, column) => {
    expect(() => assertPurgeTarget(table, column)).toThrow(LogRetentionValidationError);
  });
});

describe("sanitizeLogMessage", () => {
  it("masks credentials in connection strings and key/value pairs", () => {
    const text = sanitizeLogMessage(
      'connect failed for postgresql://admin:hunter2@db.internal:5432/app password=hunter2 token: "abc" Bearer eyJhbGci.x.y',
    );
    expect(text).toContain("postgresql://***:***@db.internal:5432/app");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abc");
    expect(text).not.toContain("eyJhbGci");
  });

  it("strips control characters and caps length", () => {
    expect(sanitizeLogMessage("line1\nline2\r\u0000")).toBe("line1 line2");
    expect(sanitizeLogMessage("x".repeat(2000)).length).toBe(503);
  });

  it("accepts errors and other values", () => {
    expect(sanitizeLogMessage(new Error("boom"))).toBe("boom");
    expect(sanitizeLogMessage(42)).toBe("42");
  });
});

describe("purgeWebhookLogs strict behaviour", () => {
  it("passes validated values only as bind parameters", async () => {
    const pool = poolWithDeletes(0);
    await purgeWebhookLogs({ pool, retentionDays: 7, batchSize: 10, logger: quietLogger() });
    const [sql, params] = pool.query.mock.calls[2];
    expect(params).toEqual([7, 10]);
    expect(sql).not.toContain("7");
  });

  it("returns a frozen summary with only known fields", async () => {
    const result = await purgeWebhookLogs({ pool: poolWithDeletes(3, 0), batchSize: 5, logger: quietLogger() });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(
      ["batchSize", "batches", "durationMs", "retentionDays", "tableName", "totalDeleted"].sort(),
    );
    expect(result).toMatchObject({ totalDeleted: 3, batches: 2 });
  });

  it.each([
    ["a row count above the batch size", 11],
    ["a negative row count", -1],
    ["a non-numeric row count", "5"],
  ])("aborts on %s from the driver", async (_label, count) => {
    await expect(
      purgeWebhookLogs({ pool: poolWithDeletes(count), batchSize: 10, logger: quietLogger() }),
    ).rejects.toThrow(/Unexpected rowCount/);
  });

  it("stops at maxBatches instead of looping forever", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await expect(
      purgeWebhookLogs({ pool: { query }, batchSize: 1, maxBatches: 3, logger: quietLogger() }),
    ).rejects.toThrow(/stopped after 3 batches \(3 rows deleted\)/);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("validates options before touching the database", async () => {
    const query = vi.fn();
    await expect(purgeWebhookLogs({ pool: { query }, retentionDays: "30; DROP TABLE x" })).rejects.toThrow(
      LogRetentionValidationError,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("scrubs the foreign-key constraint name from the error", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ conname: "fk\nforged" }] });
    await expect(purgeWebhookLogs({ pool: { query }, logger: quietLogger() })).rejects.toThrow(
      "referenced by foreign keys (example: fk forged)",
    );
  });

  it("writes summary and alert lines through the injected logger", async () => {
    const logger = quietLogger();
    await purgeWebhookLogs({ pool: poolWithDeletes(0), logger });
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("[log-retention] Purge complete for webhook_delivery_logs"));
  });
});
