# WebSocket Relay Service: integration and stress tests

Issue #1456.

| Suite | File | What it proves |
|---|---|---|
| Integration | `src/lib/websocket-relay.integration.test.js` | The real security, query, recovery and metrics modules wired as a relay worker: handshake (origin allow-list, HS256-pinned JWT, `alg: none`/expired/wrong-secret rejection), frame size limit, unknown/prototype-polluting field stripping, parameterised batch insert, FIFO dequeue, delivery through the circuit breaker, `markEventComplete`/`markEventFailed`, dead-lettering, HALF_OPEN recovery and DLQ replay, DB failure wrapping, pagination clamps, reconnect backoff, and audit log integrity |
| Stress | `src/lib/websocket-relay.stress.test.js` | 50 concurrent consumers drain 2,000 events with every event claimed exactly once; interleaved async latency never double-claims; a 1,000-row single-statement insert; 10,000 frames sanitized; oversized-frame floods; byte-accurate size checks for multi-byte text; 1,000 concurrent fast-fails on an open circuit; 10,000 mixed breaker outcomes; a 10,000-entry DLQ in FIFO order; 200 concurrent reconnect loops staying under the delay cap |

Only Postgres is faked. `tests/helpers/fake-relay-db.js` interprets the exact
SQL emitted by `websocket-relay-queries.js`. Each statement applies
atomically, mirroring `FOR UPDATE SKIP LOCKED` row locking, so the
exactly-once assertions test the claiming logic rather than the fake.

Timing assertions in the stress suite are deliberately loose. They catch
pathological regressions (quadratic or blocking behaviour), not small slowdowns.

## Finding fixed

`auditRelayEvent()` spread caller metadata **after** the fixed fields, so
metadata containing `audit`, `ts` or `event` (for example values echoed from
a client) could overwrite them and forge an audit line. Metadata is now
spread first.

## Running

```bash
npx vitest run src/lib/websocket-relay
```
