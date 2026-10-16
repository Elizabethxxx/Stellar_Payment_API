# Log Retention & Archival Service

Purges old rows from `webhook_delivery_logs` in small batches
(`npm run purge:webhook-logs`, `src/lib/log-retention.js`).

Covers issues **#1473** (Prometheus alert metrics and health telemetry),
**#1474** (automated retry with exponential backoff),
**#1475** (distributed concurrency control and locking) and
**#1476** (integration and stress test suite).

---

## 1. Layout

| File | Role |
|---|---|
| `src/lib/log-retention.js` | `purgeWebhookLogs()` (safety checks + batched delete) and `runLogRetentionPurge()` (the same, under the purge lock) |
| `src/lib/log-retention-telemetry.js` | Alert metrics, run-history health, separate registry, Pushgateway push (#1473) |
| `src/lib/log-retention-retry.js` | Full-jitter exponential backoff for transient database errors (#1474) |
| `src/lib/log-retention-lock.js` | In-process single flight + Postgres advisory lock (#1475) |
| `scripts/purge-webhook-logs.js` | Cron entry point; uses `runLogRetentionPurge()` |
| `docs/alerts/log-retention.rules.yml` | Prometheus alert rules |

```
runLogRetentionPurge({ pool })
  ├─ in-process: already running here? ──────────────▶ skipped
  ├─ pg_try_advisory_lock(hashtext(key)) on its own
  │  pooled connection ── false ─────────────────────▶ skipped (another instance)
  └─ purgeWebhookLogs()
       ├─ index check, FK check                  (retried if transient)
       ├─ loop: DELETE ... LIMIT n FOR UPDATE SKIP LOCKED  (each batch retried)
       └─ telemetry: batches, rows, duration, outcome
     pg_advisory_unlock, connection returned to the pool
```

## 2. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LOG_RETENTION_DAYS` | `30` | Rows older than this are deleted |
| `LOG_PURGE_BATCH_SIZE` | `1000` | Rows per delete batch |
| `LOG_PURGE_MAX_DURATION_MS` | `300000` | Time budget; overrunning raises the duration alert, and no retry starts after it |
| `LOG_PURGE_RETRY_MAX_ATTEMPTS` | `4` | Attempts per query, clamped to 1-8 |
| `LOG_PURGE_RETRY_BASE_DELAY_MS` | `250` | First backoff ceiling, clamped to 0-60000 |
| `LOG_PURGE_RETRY_MAX_DELAY_MS` | `5000` | Backoff cap, clamped to base-60000 |
| `LOG_RETENTION_PURGE_CRON` | unset | Also run the purge inside the API on this cron schedule (for example `30 3 * * *`). Safe on every instance |
| `LOG_RETENTION_PUSHGATEWAY_URL` | unset | Pushgateway (http/https) the cron script pushes its metrics to |
| `LOG_RETENTION_HEALTH_MAX_CONSECUTIVE_FAILURES` | `3` | Failure streak that makes health `unhealthy` |
| `LOG_RETENTION_HEALTH_MAX_STALENESS_MS` | `180000000` (50 h) | No success for this long makes health `unhealthy` |
| `LOG_RETENTION_HEALTH_STUCK_AFTER_MS` | `900000` (15 min) | A run in progress this long makes health `degraded` |

## 3. Metrics (#1473)

All in `logRetentionRegister`, merged into `GET /metrics`. Labels come from
fixed sets; no row ids, log contents or error messages ever become labels.

| Metric | Type | Labels |
|---|---|---|
| `log_retention_purge_runs_total` | counter | `outcome`: success, failure, skipped |
| `log_retention_purge_duration_seconds` | histogram | `outcome` |
| `log_retention_purge_deleted_rows_total` | counter | `table` |
| `log_retention_purge_batches_total` | counter | `table` |
| `log_retention_purge_duration_exceeded_total` | counter | |
| `log_retention_purge_retries_total` | counter | `result`: scheduled, recovered, exhausted |
| `log_retention_purge_lock_total` | counter | `result`: acquired, contended, error |
| `log_retention_health_state` | gauge | 0 healthy/idle, 1 degraded, 2 unhealthy |
| `log_retention_purge_in_progress` | gauge | |
| `log_retention_purge_consecutive_failures` | gauge | |
| `log_retention_purge_last_success_timestamp_seconds` | gauge | |
| `log_retention_purge_last_run_timestamp_seconds` | gauge | |

## 4. Health (#1473)

`GET /health/log-retention` returns the run history of this process and a
status. It answers 503 only when `unhealthy`. `GET /health` reports the
status under `services.log_retention` for information only.

| Status | When |
|---|---|
| `idle` | No purge has run in this process (normal for API instances when the purge runs as a cron script) |
| `healthy` | Last run succeeded within budget |
| `degraded` | Last run failed (below the streak limit), overran `LOG_PURGE_MAX_DURATION_MS`, or a run is overdue |
| `unhealthy` | `consecutive_failures` reached the limit, or the last success is older than the staleness limit |

A run skipped because another instance holds the lock is counted in
`skipped_runs`; it neither resets nor extends the failure streak.

## 5. Retry (#1474)

Each query (index check, FK check, every delete batch, lock connect and
acquire) runs through `withLogRetentionRetry()`:

- Retried: SQLSTATE `40001`, `40P01`, `55P03`, `57014`, `57P01`-`57P03`,
  `53300`, any class `08` connection error, and socket errors
  (`ECONNRESET`, `ETIMEDOUT`, ...).
- Never retried: safety-check failures (`LogRetentionSafetyError`: missing
  timestamp index, referencing foreign keys), and any other SQLSTATE
  (syntax, permission, constraint).
- Delay: `random(0, min(maxDelay, base * 2^n))` (full jitter), so instances
  that failed together do not retry together.
- Retrying stops once the run is past `LOG_PURGE_MAX_DURATION_MS`.

Retrying a delete batch is safe: the statement deletes "rows older than the
cutoff", so a batch whose acknowledgement was lost deletes nothing new or the
next oldest rows, never a row inside the retention window.

## 6. Concurrency (#1475)

- A second call in the same process while a purge runs returns
  `{ skipped: true, reason: "locked" }` without touching the database.
- Across instances, `pg_try_advisory_lock(hashtext('stellar-payment-api:log-retention:webhook_delivery_logs'))`
  is taken on a dedicated connection and never waits. If the holder crashes,
  Postgres drops the lock with its connection, so it cannot get stuck.
- If releasing the lock fails, the connection is destroyed instead of
  returned to the pool, which also drops the lock.
- Delete batches use `FOR UPDATE SKIP LOCKED`, so even callers that bypass
  the lock (direct `purgeWebhookLogs()`) never block on or double-delete rows.

`purgeWebhookLogs()` keeps its original signature and behaviour (no lock) for
existing callers; schedulers should use `runLogRetentionPurge()`.

## 7. Tests (#1476)

| Suite | Command |
|---|---|
| Unit: purge, telemetry, retry, lock | `npx vitest run src/lib/log-retention` |
| Integration: lock + retry + telemetry over an in-memory Postgres double, plus `/metrics` and `/health/log-retention` | `npx vitest run tests/integration/log-retention.test.js` |
| Stress: many concurrent instances, injected transient failures and latency | `npm run test:load -- log-retention-stress` |

The stress suite checks that every expired row is deleted exactly once, no
row inside the retention window is touched, at most one instance holds the
lock at any time, no lock or in-process guard leaks, and the run counters add
up to the number of attempts.

## 8. Security notes

- Table, column and lock key are server-side constants; only the retention
  days and batch size reach SQL, and only as bind parameters.
- The Pushgateway URL must be http(s) and is never logged (it may carry
  credentials).
- Health and metrics expose counts and timestamps only.
- The safety checks (timestamp index present, no referencing foreign keys)
  still run first and fail closed.
