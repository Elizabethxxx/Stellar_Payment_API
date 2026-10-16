# Idempotency Key Manager

`src/lib/idempotency.js` makes `POST` requests with an `Idempotency-Key`
header safe to retry. The first 2xx response is cached in Redis for 24 hours
under `idempotency:<merchant>:<key>` together with a SHA-256 hash of the
request body. A later request with the same key and the same body replays the
cached response (`201`). The same key with a different body gets a `400`.

## Retry with exponential backoff (issue #1464)

Every Redis call the manager makes goes through `withIdempotencyRetry()`
(`src/lib/idempotency-retry.js`):

| Operation label | Call | On final failure |
|---|---|---|
| `get` | middleware cache read | Request proceeds without idempotency (fail-open, unchanged) |
| `set` | caching the response | Logged. Runs in the background and never delays the response. |
| `lookup` | `lookupIdempotentResponse()` (payment session handler) | Error propagates to the caller, unchanged |

```
delay(attempt) = min(baseDelayMs * 2^attempt, maxDelayMs) * (1 ± jitterRatio)
```

Retries stop at `maxRetries`, or when the next delay would push total elapsed
time past `totalBudgetMs`, so a Redis outage adds bounded latency.

Only transient errors are retried: socket closed or reset, connect timeouts,
`ECONNRESET`/`ETIMEDOUT`/..., and the server replies `LOADING`, `BUSY`,
`TRYAGAIN`, `READONLY`, `MASTERDOWN` and `CLUSTERDOWN`. A closed client
(`redis.js` disables reconnects), auth/permission/`WRONGTYPE` errors and
corrupt cache JSON fail immediately.

| Env var | Default | Bounds |
|---|---|---|
| `IDEMPOTENCY_REDIS_MAX_RETRIES` | 2 | 0–5 |
| `IDEMPOTENCY_REDIS_RETRY_BASE_MS` | 25 | 1–1000 |
| `IDEMPOTENCY_REDIS_RETRY_MAX_MS` | 250 | base–5000 |
| `IDEMPOTENCY_REDIS_RETRY_BUDGET_MS` | 500 | 0–2000 |

Jitter is fixed at ±20%.

## Metrics

Exposed on `GET /metrics`, from their own registry:

| Metric | Labels |
|---|---|
| `idempotency_redis_operations_total` | `operation` (`get`/`set`/`lookup`), `outcome` (`success`/`recovered`/`failed`/`non_retryable`) |
| `idempotency_redis_retries_total` | `operation` |
| `idempotency_redis_retry_delay_seconds` | `operation` |

A rising `outcome="failed"` rate for `get` means idempotency is currently
failing open, so duplicate payments are possible. Alert on it together with
Redis availability.

## Tests

```bash
npx vitest run src/lib/idempotency-retry.test.js src/lib/idempotency.test.js
```
