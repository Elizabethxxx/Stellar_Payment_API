# Horizon Client Retry Manager

`src/lib/stellar/horizon-client/retry-manager.js` wraps every Horizon call made
by `HorizonClient` (`loadAccount`, `fetchPayments`, `fetchTransaction`,
`findStrictReceivePaths`, `getFeeStats`) with retries, error mapping, metrics
and health tracking.

## Payload sanitization and strict validation (issue #1437)

Implemented in `src/lib/stellar/horizon-client/sanitizer.js`.

| Input | Rule | On failure |
|-------|------|------------|
| `retryDelays` (constructor) | Array of at most 10 integers, each 0–60000 ms. Stored as a frozen copy. | `TypeError`, `code: HORIZON_CLIENT_VALIDATION_ERROR`, `validationType: "retry_delays"` |
| `operationName` | `/^[A-Za-z][A-Za-z0-9_]{0,63}$/` (it becomes a Prometheus label) | Same error, `validationType: "operation_name"`. The operation is never called. |
| `operation` | Must be a function | Same error, `validationType: "operation"` |
| `context` | Plain objects only. Keys must match `/^[A-Za-z0-9_.-]{1,64}$/`. `__proto__`/`constructor`/`prototype` are dropped. Max 16 keys. | Invalid keys are dropped silently. |
| context values | Stringified (objects as JSON). Control characters stripped. Stellar secret seeds (`S…`, 56 chars) and `Bearer`/`Basic` credentials redacted. Truncated to 256 chars. Values under keys matching `secret|seed|password|passphrase|token|private|signature|authorization|api_key|mnemonic|cookie` are replaced with `[REDACTED]`. | — |
| Horizon URL in errors and logs | Only `scheme://host[:port]/path` is kept. Credentials, query string and fragment are removed. | `[invalid-horizon-url]` |
| Horizon error `detail` / network error text | Same string rules, capped at 512 chars | — |

Validation failures increment
`horizon_client_data_validation_errors_total{operation, validation_type}`.
The `operation` label is `invalid` when the name itself was rejected.

## Alert metrics and health telemetry (issue #1438)

| Metric | Type | Meaning |
|--------|------|---------|
| `horizon_client_retry_exhausted_total{operation,error_type}` | Counter | Calls that failed with a retryable error after every retry |
| `horizon_client_consecutive_failures{operation}` | Gauge | Consecutive exhausted failures. Reset by a success or by a non-retryable Horizon response (404/400 means Horizon is reachable). |
| `horizon_client_last_success_timestamp_seconds{operation}` | Gauge | Unix time of the last success |
| `horizon_client_health_state` | Gauge | `0` healthy, `1` degraded (any operation has ≥1 consecutive failure), `2` unhealthy (≥ `unhealthyAfterFailures`, default 5) |

`HorizonClient#getHealth()` returns the same data as JSON, plus the result of
the last `isReachable()` probe. A failed probe downgrades an otherwise healthy
client to `degraded`:

```json
{
  "status": "degraded",
  "unhealthyAfterFailures": 5,
  "concurrentOperations": 0,
  "operations": {
    "loadAccount": {
      "status": "degraded",
      "consecutiveFailures": 2,
      "totalSuccesses": 120,
      "totalFailures": 2,
      "lastSuccessAt": "2026-10-16T10:00:00.000Z",
      "lastFailureAt": "2026-10-16T10:05:00.000Z",
      "lastErrorType": "network_error"
    }
  },
  "lastHealthCheck": { "reachable": false, "durationMs": 2001, "errorType": "timeout", "checkedAt": "2026-10-16T10:05:01.000Z" }
}
```

Configure the threshold with `new HorizonClient(url, passphrase, { unhealthyAfterFailures: 3 })`.
The per-operation table is capped at 64 entries.

Alerting rules: `docs/alerts/horizon-client-retry-manager.rules.yml`.

## Tests

```bash
npx vitest run src/lib/stellar/horizon-client src/lib/stellar/horizon-client.test.js
```
