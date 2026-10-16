# Log Retention & Archival Service

`src/lib/log-retention.js` purges operational webhook delivery logs
(`webhook_delivery_logs`) older than the retention window, in batches. Run it
with `npm run purge:webhook-logs` (see `scripts/purge-webhook-logs.js` and
`.github/workflows/webhook-log-retention.yml`).

> Compliance: confirm the table holds operational delivery telemetry only.
> Payment audit records may need longer retention by policy or regulation.

## Configuration

| Option | Environment variable | Default | Allowed |
|---|---|---|---|
| `retentionDays` | `LOG_RETENTION_DAYS` | 30 | 1-3650 |
| `batchSize` | `LOG_PURGE_BATCH_SIZE` | 1000 | 1-50000 |
| `maxDurationMs` | `LOG_PURGE_MAX_DURATION_MS` | 300000 | 1000-86400000 |
| `maxBatches` | `LOG_PURGE_MAX_BATCHES` | 100000 | 1-10000000 |

Explicit options win over environment variables. `logger` (an object with
`log` and `error`) may be passed instead of `console`.

## Strict validation and sanitization (#1472)

- Numbers must be plain base-10 integers in range. Values such as `30days`,
  `1e3`, `-5`, `0x10` or `1.5` are rejected with a
  `LogRetentionValidationError` naming the option or environment variable.
  Before this change `parseInt` silently turned `30days` into `30`.
- Unknown option keys (for example a typo like `retentiondays`) are rejected
  rather than silently falling back to the default retention.
- `pool` must expose `query()`. Everything is validated before the first
  query runs.
- Only allow-listed table/column pairs can be purged, and identifiers are
  checked against `^[a-z_][a-z0-9_]{0,62}$` before they reach SQL. The
  retention period and batch size are always bind parameters.
- Each batch's `rowCount` must be an integer between 0 and `batchSize`; a
  bad value stops the purge. `maxBatches` caps the loop so a misbehaving
  driver cannot spin forever.
- The returned summary is a frozen object with `tableName`, `retentionDays`,
  `batchSize`, `totalDeleted`, `durationMs` and `batches` only.
- `sanitizeLogMessage()` masks credentials (`scheme://user:pass@`,
  `password=`, `token=`, `Bearer ...`), strips control characters (log
  injection) and caps length. The purge script logs only the scrubbed message
  and the error's name/code, never the raw error object, which can echo the
  database connection string.
