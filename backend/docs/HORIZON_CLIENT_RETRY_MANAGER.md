# Horizon Client Retry Manager

Covers issues **#1439** (exponential backoff), **#1440** (concurrency control
and distributed locking) and **#1441** (integration and stress tests).

| File | Role |
|---|---|
| `src/lib/stellar/horizon-client/backoff.js` | Backoff policy, jitter, Retry-After parsing (#1439) |
| `src/lib/stellar/horizon-client/concurrency-limiter.js` | Per-process semaphore with a bounded queue (#1440) |
| `src/lib/stellar/horizon-client/retry-coordinator.js` | Cluster-wide retry slots and rate-limit cooldown over Redis (#1440) |
| `src/lib/stellar/horizon-client/retry-manager.js` | Runs operations with the above |
| `tests/integration/horizon-retry-manager.test.js` | Real SDK + HTTP Horizon stub (#1441) |
| `load-tests/horizon-retry-manager-stress.test.js` | Stress invariants (#1441) |

## Retry policy (#1439)

- Default: jittered exponential backoff, `delay(n) = random(0, min(maxDelayMs, baseDelayMs * multiplier^n))`.
- An explicit `retryDelays` array keeps the legacy fixed schedule.
- Retry-After is honoured; a hint above `maxRetryAfterMs` fails fast.
- `maxElapsedMs` bounds the whole operation, waits included.
- Only transient failures retry (408, 429, 5xx, network errors). Errors with `retryable: false` never retry.
- SDK transport errors without a `code` (for example `connect ECONNREFUSED`) are now recognised as retryable.

Every failure carries `attempts` and `retryStopReason`
(`not_retryable`, `exhausted`, `budget_exceeded`, `retry_after_too_long`, `retry_slots_exhausted`).

## Concurrency control (#1440)

- **Limiter**: at most `maxConcurrent` Horizon calls per process, `maxQueue` waiting; overflow and queue timeouts return 503 (`HORIZON_CLIENT_QUEUE_FULL`, `HORIZON_CLIENT_QUEUE_TIMEOUT`).
- **Retry slots**: `horizon:retry:slot:<hostHash>:<operation>:<i>`, acquired with `SET NX PX`, released by compare-and-delete. With no free slot the retry is skipped, so N instances cannot turn an outage into a retry storm.
- **Cooldown**: a 429/503 publishes `horizon:retry:cooldown:<hostHash>` (capped by `maxCooldownMs`); every instance waits it out before its next attempt.
- Fails open to an in-process implementation when Redis is missing or erroring. Enabled at startup by `configureHorizonRetryCoordination()` in `app.js`.
- Keys never contain caller input: the host is hashed and operation names are restricted to `[A-Za-z0-9_]`.

## Configuration

| Variable | Default |
|---|---|
| `HORIZON_RETRY_STRATEGY` | `exponential` |
| `HORIZON_RETRY_MAX_RETRIES` | `2` |
| `HORIZON_RETRY_BASE_DELAY_MS` | `150` |
| `HORIZON_RETRY_MAX_DELAY_MS` | `2000` |
| `HORIZON_RETRY_MULTIPLIER` | `3` |
| `HORIZON_RETRY_JITTER` | `full` (`full`, `equal`, `none`) |
| `HORIZON_RETRY_MAX_ELAPSED_MS` | `10000` |
| `HORIZON_RETRY_MAX_RETRY_AFTER_MS` | `5000` |
| `HORIZON_CLIENT_MAX_CONCURRENCY` | `64` |
| `HORIZON_CLIENT_MAX_QUEUE` | `1000` |
| `HORIZON_CLIENT_QUEUE_TIMEOUT_MS` | `10000` |
| `HORIZON_RETRY_MAX_CONCURRENT_RETRIES` | `32` |
| `HORIZON_RETRY_SLOT_LEASE_MS` | `30000` |
| `HORIZON_RETRY_MAX_COOLDOWN_MS` | `5000` |

All values are clamped to safe ranges; invalid values fall back to defaults.
