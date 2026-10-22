import "dotenv/config";
import { pool, closePool } from "../src/lib/db.js";
import { purgeWebhookLogs, sanitizeLogMessage } from "../src/lib/log-retention.js";

async function run() {
  const startedAt = Date.now();
  try {
    const result = await purgeWebhookLogs({ pool });
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[log-retention] Run succeeded: table=${result.tableName} deleted_rows=${result.totalDeleted} elapsed_ms=${elapsedMs}`,
    );
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
    await closePool();
  }
}

await run();
