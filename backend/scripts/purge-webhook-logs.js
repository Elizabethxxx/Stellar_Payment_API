import "dotenv/config";
import { pool, closePool } from "../src/lib/db.js";
import { purgeWebhookLogs, sanitizeLogMessage } from "../src/lib/log-retention.js";

async function run() {
  const startedAt = Date.now();
  try {
    // Takes the cross-instance purge lock (issue #1475): when the cron runs
    // on several hosts, exactly one purges and the others exit cleanly.
    const result = await runLogRetentionPurge({ pool });
    const elapsedMs = Date.now() - startedAt;
    if (result.skipped) {
      console.log(
        `[log-retention] Run skipped: table=${result.tableName} another purge holds the lock elapsed_ms=${elapsedMs}`,
      );
    } else {
      console.log(
        `[log-retention] Run succeeded: table=${result.tableName} deleted_rows=${result.totalDeleted} elapsed_ms=${elapsedMs}`,
      );
    }
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    // Driver errors can echo the connection string; log a scrubbed message
    // and the error name/code only, never the raw error object (#1472).
    console.error(
      `[ALERT][log-retention] Run failed after ${elapsedMs}ms: ${sanitizeLogMessage(error)}`,
      { name: error?.name, code: error?.code, field: error?.field },
    );
    process.exitCode = 1;
  } finally {
    // This process exits before any scrape could reach it, so push the run's
    // metrics (issue #1473) when a Pushgateway is configured.
    if (process.env.LOG_RETENTION_PUSHGATEWAY_URL) {
      await pushLogRetentionMetrics(process.env.LOG_RETENTION_PUSHGATEWAY_URL);
    }
    await closePool();
  }
}

await run();
