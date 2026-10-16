# Payment Processor

Architecture, granular metrics, and testing guide for the Payment Processor
module (`src/routes/payments.js` + `src/services/paymentService.js`).

Covers issues **#1086** (end-to-end testing), **#1087** (legacy refactor),
**#1088** (granular metrics), **#1089** (load testing), and Payment Processor
Telemetry: **#1477** (payload sanitization and strict validation), **#1478**
(alert metrics and health) and **#1479** (retry with exponential backoff).

---

## 1. Architecture after refactor (#1087)

```
HTTP request
  │
  ├─ requireApiKeyAuth            x-api-key → merchant lookup (queryWithRetry)
  ├─ rate limiters                create / verify / path-quote budgets
  ├─ zod validation               paymentSessionZodSchema / paymentZodSchema
  ├─ sanitizeMetadataMiddleware   drops unsafe metadata keys
  │
  └─ routes/payments.js           transport layer (HTTP responses, counters)
       │
       ├─ lib/payment-session-rules.js    ← shared business rules (NEW)
       ├─ lib/supabase-client.js          ← shared lazy Supabase accessor (NEW)
       ├─ lib/payment-processor-metrics.js← granular metrics (NEW)
       │
       └─ services/paymentService.js      service layer (pool-first, Supabase fallback)
```

### Shared session rules (`lib/payment-session-rules.js`)

Pure functions with no I/O — previously duplicated across route and service
with drift risk:

| Function | Rule |
|---|---|
| `resolveAndValidateIssuer` | non-native assets require an issuer; issuer must be a valid `G…` key |
| `validatePerAssetLimits`   | merchant-configured per-asset `min`/`max`, delta rounded to 7 dp |
| `validateAllowedIssuers`   | merchant allowlist enforcement when configured |

Rule order is identical in both layers: **issuer presence → issuer format →
per-asset limits → allowlist**. Callers map rejections to their own transport
(HTTP 400 JSON vs thrown `err.status = 400`).

---

## 2. Granular metrics (#1088)

Exposed on `GET /metrics` (merged into the core registry output).

| Series | Type | Labels | Answers |
|---|---|---|---|
| `payment_processor_sessions_total` | counter | `asset`, `outcome` | created / validation_failed / persistence_failed split |
| `payment_processor_session_duration_seconds` | histogram | `asset`, `outcome` | how long creation attempts take per outcome |
| `payment_processor_verifications_total` | counter | `asset`, `outcome` | confirmed, already_confirmed, pending_no_match, signature_invalid, underpayment, overpayment, tx_claim_conflict, error |
| `payment_processor_verification_duration_seconds` | histogram | `asset`, `outcome` | verification latency per outcome |
| `payment_processor_status_cache_hits_total` | counter | – | status-poll cache effectiveness |
| `payment_processor_status_cache_misses_total` | counter | – | ” |
| `payment_processor_refunds_total` | counter | `stage`, `outcome` | generate/confirm funnel incl. rejections |
| `payment_processor_list_requests_total` | counter | `outcome` | list endpoint health incl. pool fallback |

Useful queries:

```promql
sum(rate(payment_processor_sessions_total{outcome="validation_failed"}[5m]))
  by (asset)
histogram_quantile(0.95,
  sum(rate(payment_processor_verification_duration_seconds_bucket[5m])) by (le))
sum(rate(payment_processor_status_cache_hits_total[5m]))
 /
(sum(rate(payment_processor_status_cache_hits_total[5m]))
  + sum(rate(payment_processor_status_cache_misses_total[5m])))
```

---

## 3. End-to-end suite (#1086)

`tests/e2e/payment-processor.e2e.test.js` — full HTTP stack via supertest;
Supabase / Postgres pool / Redis / Horizon / webhooks / email are mocked.
~30 scenarios: auth, metadata sanitization, session validation matrix,
status caching semantics, the complete verification lifecycle (incl.
underpayment/overpayment/claim races), refund funnel, `/metrics` exposure,
rate limiting.

```bash
npx vitest run tests/e2e/payment-processor.e2e.test.js
```

---

## 4. Load testing (#1089)

`load-tests/payment-processor-load.test.js` — autocannon against a real
`listen()` server with mocked boundaries.

| Scenario | Profile | Pass criteria |
|---|---|---|
| Session-creation throughput | 10s × 10 conns | zero errors/timeouts |
| Status-poll storm | 10s × 20 conns | zero timeouts, 2xx served |
| Mixed poll+verify workload | 8s × 8 conns | zero timeouts (429s allowed) |
| Rate-limit budget | 120 fixed requests × 1 conn | ≥1 429, zero timeouts |
| Connection burst | 10s × 50 conns | zero timeouts |

```bash
npm run test:load -- payment-processor
```

Include the printed percentile tables in PRs touching the processor.

---

## 5. Security notes

- API keys are hashed for rate-limit bucketing (`getCreatePaymentRateLimitKey`)
- Metadata keys must match `^[a-zA-Z0-9_-]{1,64}$`; unsafe keys never reach SQL
- Refunds require a confirmed payment and are single-use (`refund_status`)
- Verification uses a DB-level conditional update so a `tx_hash` can only be
  claimed once even under concurrent confirmation attempts
- Signature verification failure keeps payments pending (fail-closed)

---

## 6. Payment Processor Telemetry (#1477, #1478, #1479)

| File | Role |
|---|---|
| `src/lib/payment-processor-telemetry.js` | Sanitising, validating recorders; rolling-window health; new series |
| `src/lib/payment-processor-retry.js` | Retried idempotent reads (status / verification lookup) |
| `src/lib/backoff-retry.js` | Shared full-jitter backoff used by the processor and SEP-0001 |
| `docs/alerts/payment-processor.rules.yml` | Prometheus alert rules |

### 6.1 Payload sanitization and strict validation (#1477)

`routes/payments.js` and `services/paymentService.js` no longer call the
`payment_processor_*` metric objects directly. They call the recorders
(`recordSessionTelemetry`, `recordVerificationTelemetry`,
`recordRefundTelemetry`, `recordListRequestTelemetry`,
`recordStatusCacheTelemetry`, `recordProcessorRetryTelemetry`), which:

| Input | Rule | Otherwise |
|---|---|---|
| payload | plain object | rejected (`invalid_payload`) |
| `outcome` / `stage` / `operation` | fixed allow-list per series | rejected (`invalid_outcome` / `invalid_stage` / `invalid_operation`) |
| `asset` | trimmed, upper-cased, `^[A-Z0-9]{1,12}$`; `native` becomes `XLM` | label `invalid`; missing becomes `unknown` |
| distinct assets | at most `PAYMENT_PROCESSOR_TELEMETRY_MAX_ASSET_LABELS` (default 50) | label `other` |
| duration | finite, `0` to `3600` seconds | count still recorded, observation dropped, `invalid_duration` |

Before this, `req.body.asset` went straight into a label, so a client could
create a new Prometheus series on every request. Rejected payloads are never
written to the business series; they increment
`payment_processor_telemetry_rejected_total{metric, reason}` and log one
warning with the metric and reason only. Recorders never throw.

Allow-lists:

- sessions: created, validation_failed, persistence_failed, sandbox_skipped
- verifications: confirmed, already_confirmed, already_confirmed_concurrent,
  pending_no_match, signature_invalid, underpayment, overpayment,
  tx_claim_conflict, error
- refunds: stage generate or confirm; outcome success, rejected, not_found,
  failed_on_chain, error
- list requests: success, pool_fallback, error

### 6.2 Alert metrics and health (#1478)

| Series | Type | Notes |
|---|---|---|
| `payment_processor_health_state` | gauge | 0 healthy, 1 degraded, 2 unhealthy; refreshed at scrape |
| `payment_processor_session_failure_ratio` | gauge | persistence_failed / (created + persistence_failed) |
| `payment_processor_verification_error_ratio` | gauge | error / all verifications |
| `payment_processor_refund_error_ratio` | gauge | (error + failed_on_chain) / all refund operations |
| `payment_processor_telemetry_rejection_ratio` | gauge | rejected / all telemetry events |
| `payment_processor_telemetry_rejected_total` | counter | `metric`, `reason` |
| `payment_processor_retries_total` | counter | `operation`, `result` (see 6.3) |

Health uses a rolling window (`PAYMENT_PROCESSOR_HEALTH_WINDOW_MS`, default
5 min) and needs `PAYMENT_PROCESSOR_HEALTH_MIN_SAMPLES` (default 20) before a
ratio counts:

- `unhealthy`: any error ratio >= `PAYMENT_PROCESSOR_UNHEALTHY_ERROR_RATIO` (0.2)
- `degraded`: any error ratio >= `PAYMENT_PROCESSOR_DEGRADED_ERROR_RATIO`
  (0.05), telemetry rejections at that ratio, or any exhausted read retry
- `healthy`: otherwise

Validation failures (bad client input) do not count as processor errors.

`GET /health/payment-processor` returns the snapshot (503 only when
unhealthy). `GET /health` lists `services.payment_processor` for information
only. The body holds counts and ratios, never payment ids, amounts, addresses
or asset codes.

### 6.3 Retry with exponential backoff (#1479)

The first Supabase read of the status poll and of verification
(`status_lookup`, `verify_lookup`, in both the route and the service) is
retried with full jitter, `random(0, min(max, base * 2^n))`:

| Variable | Default | Clamp |
|---|---|---|
| `PAYMENT_PROCESSOR_RETRY_MAX_ATTEMPTS` | 3 | 1-5 |
| `PAYMENT_PROCESSOR_RETRY_BASE_DELAY_MS` | 50 | 0-3000 |
| `PAYMENT_PROCESSOR_RETRY_MAX_DELAY_MS` | 500 | base-3000 |

- Retried: network errors, 408/429/5xx, connection-class Postgres errors
  (shared `isRetryableSessionError`).
- Not retried: not-found, invalid ids, missing columns (the status route still
  falls through its schema-tolerant query shapes), PostgREST client errors.
- Writes (status transitions, tx claims, refunds) are never wrapped.
- Each query is rebuilt per attempt (PostgREST builders are single-use).
- After the last attempt the final `{ data, error }` is returned unchanged, so
  response codes are as before.

`payment_processor_retries_total{operation, result}` records `scheduled`,
`recovered` and `exhausted`; exhausted retries also degrade health.

### 6.4 Tests

```bash
npx vitest run src/lib/payment-processor-telemetry.test.js src/lib/payment-processor-retry.test.js src/lib/backoff-retry.test.js
npx vitest run tests/integration/payment-processor-telemetry.test.js tests/e2e/payment-processor.e2e.test.js
```
