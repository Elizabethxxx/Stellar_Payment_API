# WebSocket Relay: distributed concurrency control

Issue #1455. Module: `src/lib/websocket-relay-lock.js`.

## What it protects

| Scope (`RelayLockScope`) | Resource | Prevents |
|--------------------------|----------|----------|
| `event` | relay event / payment id | Two instances delivering the same event |
| `dlq-drain` | queue name | Concurrent DLQ replays re-sending every entry once per instance |
| `reconnect` | upstream URL | Reconnect stampedes across instances |
| `connection` | connection id | Concurrent mutation of one connection's state |

Inside one process, `createSingleFlight()` makes concurrent callers share a
single in-flight promise per key. Use it for reconnect loops so that many
sockets seeing the same upstream drop start only one reconnect.

`CircuitBreaker` in `websocket-relay-recovery.js` now admits exactly **one**
probe while `HALF_OPEN`. Concurrent callers are rejected with
`err.circuitOpen = true` and counted in
`relay_circuit_breaker_probe_rejected_total`. Before this change every
concurrent caller was let through to the recovering upstream.

## Usage

```js
import { withRelayLock, RelayLockScope } from "./websocket-relay-lock.js";

await withRelayLock(RelayLockScope.DLQ_DRAIN, "default", async ({ signal }) => {
  while (!signal.aborted && dlq.size > 0) {
    await deliver(dlq.shift());
  }
}, { ttlMs: 15_000, waitMs: 0 });
```

- `withRelayLock` throws a `409` error with `code: "RELAY_LOCK_BUSY"` (`retryable: true`) when another holder owns the lock after `waitMs` (default `0`, max 30 s, polled with ±25% jitter).
- The lease is renewed every `ttl/3`. If a renewal fails, `signal` is aborted with `code: "RELAY_LOCK_LOST"`. Long-running work must check `signal.aborted` between units of work.
- The lock is always released in `finally`, including when the work throws.

## Safety properties

- **Atomic acquire:** `SET key token NX PX ttl`.
- **Owner-only release and renew:** compare-and-delete and compare-and-pexpire Lua scripts check the random per-lease token. A worker whose lease expired can neither delete nor revive a lock that someone else now holds.
- **Key hygiene:** the scope must be in an allow-list. The resource is SHA-256 hashed (`lock:ws-relay:<scope>:<sha256>`), so it cannot inject key separators or CRLF, and its length is capped at 512 characters.
- **TTL bounds:** `WS_RELAY_LOCK_TTL_MS` (default 15000) is clamped to 1 s–120 s.
- **Degraded mode:** if Redis is down, or is the no-op client from `redis.js`, locks fall back to an in-process table. A single instance stays correct, and a warning is logged. Cross-instance exclusion returns when Redis does.

## Metrics

All on the relay registry (`relayMetricsRegister`):

| Metric | Labels |
|--------|--------|
| `relay_lock_acquisitions_total` | `scope`, `result` = `acquired` / `contended` / `error` |
| `relay_lock_wait_duration_seconds` | `scope` |
| `relay_lock_hold_duration_seconds` | `scope` |
| `relay_lock_lost_total` | `scope` |
| `relay_circuit_breaker_probe_rejected_total` | — |

Alerting rules: `docs/alerts/websocket-relay-locking.rules.yml`.

## Configuration

| Env var | Default | Notes |
|---------|---------|-------|
| `WS_RELAY_LOCK_TTL_MS` | `15000` | Clamped to 1000–120000 |
| `REDIS_URL` | — | Shared with the rest of the API |

## Tests

```bash
npx vitest run src/lib/websocket-relay-lock.test.js src/lib/websocket-relay-recovery.test.js
```
