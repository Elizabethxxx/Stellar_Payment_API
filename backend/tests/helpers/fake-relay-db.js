/**
 * In-memory stand-in for the `relay_events` table used by
 * src/lib/websocket-relay-queries.js (issue #1456).
 *
 * It interprets the exact statements the query helpers send, by shape:
 *   - multi-row INSERT ... RETURNING
 *   - dequeue CTE (FOR UPDATE SKIP LOCKED): oldest pending row -> processing.
 *     Each statement runs atomically, like a row lock, so concurrent
 *     consumers can never claim the same row.
 *   - UPDATE ... SET status = 'completed' | 'failed' WHERE status = 'processing'
 *   - SELECT ... ORDER BY created_at DESC LIMIT $1 OFFSET $2
 *
 * Options:
 *   latencyMs   artificial async latency per query (interleaves consumers)
 *   failNext(n, error)  make the next n queries reject
 */
export function createFakeRelayDb({ latencyMs = 0 } = {}) {
  const rows = [];
  const statements = [];
  let nextId = 1;
  let clock = 0;
  let failures = [];

  const pause = () =>
    latencyMs > 0 ? new Promise((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve();

  function insert(values) {
    const inserted = [];
    for (let i = 0; i < values.length; i += 4) {
      const row = {
        id: String(nextId++),
        payment_id: values[i],
        event_type: values[i + 1],
        payload: values[i + 2] == null ? null : JSON.parse(values[i + 2]),
        status: values[i + 3],
        error_message: null,
        created_at: new Date(Date.UTC(2026, 0, 1) + clock++).toISOString(),
        updated_at: null,
      };
      rows.push(row);
      inserted.push({
        id: row.id,
        payment_id: row.payment_id,
        event_type: row.event_type,
        status: row.status,
        created_at: row.created_at,
      });
    }
    return inserted;
  }

  function dequeue() {
    const next = rows
      .filter((r) => r.status === "pending")
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (!next) return [];
    next.status = "processing";
    const { id, payment_id, event_type, payload, created_at } = next;
    return [{ id, payment_id, event_type, payload, created_at }];
  }

  function transition(id, status, errorMessage) {
    const row = rows.find((r) => r.id === id && r.status === "processing");
    if (!row) return [];
    row.status = status;
    row.updated_at = new Date().toISOString();
    if (errorMessage !== undefined) row.error_message = errorMessage;
    return [{ ...row }];
  }

  async function query(sql, params = []) {
    statements.push({ sql, params });
    await pause();
    if (failures.length > 0) throw failures.shift();

    // Every statement is applied synchronously after the await, which is what
    // makes concurrent dequeues mutually exclusive (row-lock semantics).
    if (/INSERT INTO relay_events/.test(sql)) return { rows: insert(params) };
    if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: dequeue() };
    if (/SET status = 'completed'/.test(sql)) return { rows: transition(params[0], "completed") };
    if (/SET status = 'failed'/.test(sql)) return { rows: transition(params[0], "failed", params[1]) };
    if (/FROM relay_events\s+ORDER BY created_at DESC/.test(sql)) {
      const [limit, offset] = params;
      const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { rows: sorted.slice(offset, offset + limit).map((r) => ({ ...r })) };
    }
    throw new Error(`fake-relay-db: unsupported statement: ${sql.trim().slice(0, 60)}`);
  }

  return {
    query,
    rows,
    statements,
    countBy(status) {
      return rows.filter((r) => r.status === status).length;
    },
    failNext(count, error = new Error("connection terminated unexpectedly")) {
      failures = Array.from({ length: count }, () => error);
    },
  };
}
