# WebSocket Relay Service

Covers issues **#1454** (automated retry with exponential backoff) and
**#1453** (Prometheus alert metrics and health telemetry).

## 1. Layout

| File | Role |
|---|---|
| `src/lib/websocket-relay-security.js` | Origin, size, JWT and message-shape checks |
| `src/lib/websocket-relay-recovery.js` | Circuit breaker, dead letter queue, `reconnectWithBackoff` |
| `src/lib/websocket-relay-retry.js` | Retry policy, `deliverRelayMessage`, `redriveDeadLetters` (#1454) |
| `src/lib/websocket-relay-metrics.js` | Granular relay counters (#1083) |
| `src/lib/websocket-relay-telemetry.js` | Alert metrics and rolling-window health (#1453) |
| `docs/alerts/websocket-relay.rules.yml` | Prometheus alert rules |

## 2. Retry with exponential backoff (#1454)

```js
import { deliverRelayMessage, redriveDeadLetters, withRelayRetry } from "./lib/websocket-relay-retry.js";
import { CircuitBreaker, DeadLetterQueue } from "./lib/websocket-relay-recovery.js";
import { attachRelayHealthSource } from "./lib/websocket-relay-telemetry.js";

const circuitBreaker = new CircuitBreaker();
const dlq = new DeadLetterQueue();
attachRelayHealthSource({ circuitBreaker, dlq });

// Deliver, retrying transient failures, dead-lettering what still fails.
await deliverRelayMessage(message, (msg) => socket.sendAsync(msg), { circuitBreaker, dlq });

// Reconnect with the same policy.
await withRelayRetry(() => connect(), { operation: "reconnect", signal });

// Later, once the downstream recovers:
await redriveDeadLetters(dlq, (msg) => socket.sendAsync(msg), { limit: 100 });
```

- **Delay:** full jitter, `random(0, min(maxDelayMs, baseDelayMs * 2^n))`.
- **Retried:** network error codes (`ECONNRESET`, `ETIMEDOUT`, ...), timeouts,
  HTTP 408/429/5xx (not 501), WebSocket close codes 1006/1011/1012/1013, and
  errors flagged `retryable: true`.
- **Not retried:** an OPEN circuit breaker (`circuitOpen`), other 4xx
  (validation, signature, auth), policy close codes, `retryable: false`,
  and programming errors. These fail or dead-letter immediately.
- **Bounds:** `maxAttempts`, a total `maxElapsedMs` budget including waits,
  and an optional `AbortSignal`.
- **Failures** carry `retryAttempts`. With a `dlq`, `deliverRelayMessage`
  dead-letters the message (with the total retry count) instead of throwing.
- **Logs** contain the operation label, attempt counts, delay and the
  error's code/status/close code, with the message truncated to 200
  characters. Payloads are never logged.

| Variable | Default | Range |
|---|---|---|
| `RELAY_RETRY_MAX_ATTEMPTS` | `5` | 1-10 |
| `RELAY_RETRY_BASE_DELAY_MS` | `250` | 0-60000 |
| `RELAY_RETRY_MAX_DELAY_MS` | `10000` | base-60000 |
| `RELAY_RETRY_MAX_ELAPSED_MS` | `30000` | 0-300000 |

`reconnectWithBackoff` in `websocket-relay-recovery.js` is unchanged.

## 3. Alert metrics and health (#1453)

Exposed on `GET /metrics` (merged from their own registry, together with the
existing `relay_*` series, which were not previously scraped).

| Metric | Type | Labels |
|---|---|---|
| `websocket_relay_deliveries_total` | counter | `outcome`: delivered, recovered, dead_lettered, failed |
| `websocket_relay_retries_total` | counter | `operation`: deliver, reconnect, redrive, other; `result`: scheduled, recovered, exhausted, aborted |
| `websocket_relay_retry_delay_seconds` | histogram | `operation` |
| `websocket_relay_health_state` | gauge | 0 healthy, 1 degraded, 2 unhealthy |
| `websocket_relay_delivery_failure_ratio` | gauge | rolling window |
| `websocket_relay_dlq_depth` | gauge | live DLQ size |
| `websocket_relay_circuit_open` | gauge | 1 OPEN, 0.5 HALF_OPEN, 0 CLOSED |
| `websocket_relay_last_delivery_timestamp_seconds` | gauge | |

Gauges are computed at scrape time from a fixed ring of 5-second buckets, so
they decay when traffic stops and memory stays constant.

`GET /health/websocket-relay` returns the snapshot (no payloads or payment
ids). Status rules:

| Status | When |
|---|---|
| unhealthy (HTTP 503) | circuit OPEN, failure ratio >= `RELAY_FAILURE_RATIO_THRESHOLD` (default 0.1) with at least `RELAY_HEALTH_MIN_SAMPLES` (20) deliveries, or DLQ >= `RELAY_DLQ_UNHEALTHY_THRESHOLD` (100) |
| degraded (HTTP 200) | circuit HALF_OPEN, DLQ >= `RELAY_DLQ_DEGRADED_THRESHOLD` (1), or retries exhausted in the window |
| healthy | otherwise |

The window is `RELAY_HEALTH_WINDOW_MS` (default 5 minutes). `GET /health`
also reports `services.websocket_relay` (informational; it does not change
the overall status code).

## 4. Security notes

- Label values come from fixed server-side sets; message fields, origins,
  payment ids and error text never become labels.
- The health snapshot and logs contain counts, states and error codes only.
- An OPEN breaker is never retried, so retries cannot defeat it.
- Retry configuration is clamped, so a misconfigured environment cannot
  disable backoff or make a delivery wait for minutes.
