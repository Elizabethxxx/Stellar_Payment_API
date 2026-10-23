/**
 * In-memory stand-in for the parts of PostgreSQL the Log Retention & Archival
 * Service uses (issue #1476): the pg_indexes / pg_constraint safety checks,
 * the batched `DELETE ... FOR UPDATE SKIP LOCKED`, and session advisory
 * locks. Several pools can share one database, which simulates several API
 * instances / cron hosts purging the same table.
 *
 * It records enough to assert the service's invariants:
 *   - every deleted id (to prove nothing is deleted twice)
 *   - the peak number of concurrent advisory lock holders
 *   - open connections and held locks (to prove nothing leaks)
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function pgError(code, message = `simulated ${code}`) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * @param {object} [options]
 * @param {Array<{id:string, ageDays:number}>} [options.rows]
 * @param {boolean} [options.hasIndex]
 * @param {boolean} [options.hasForeignKey]
 * @param {number | (() => number)} [options.latencyMs]  per delete batch
 * @param {(kind:string, call:number) => Error | null} [options.fail]
 *   Return an error to make that query fail. kind: index | fk | delete | lock | unlock | connect
 */
export function createFakeLogRetentionDb(options = {}) {
  const {
    rows = [],
    hasIndex = true,
    hasForeignKey = false,
    latencyMs = 0,
    fail = () => null,
  } = options;

  const table = new Map(rows.map((r) => [String(r.id), r.ageDays]));
  const rowLocks = new Set();
  const advisoryLocks = new Map(); // key -> session id
  const calls = new Map();
  const deleted = [];
  const doubleDeletes = [];
  const stats = { maxLockHolders: 0, openConnections: 0, destroyedConnections: 0 };
  let nextSession = 1;

  const count = (kind) => {
    const n = (calls.get(kind) ?? 0) + 1;
    calls.set(kind, n);
    return n;
  };

  const maybeFail = (kind) => {
    const err = fail(kind, count(kind));
    if (err) throw err;
  };

  const delay = () => (typeof latencyMs === 'function' ? latencyMs() : latencyMs);

  async function run(session, sql, params = []) {
    if (/pg_indexes/.test(sql)) {
      maybeFail('index');
      return { rowCount: hasIndex ? 1 : 0, rows: hasIndex ? [{ '?column?': 1 }] : [] };
    }
    if (/pg_constraint/.test(sql)) {
      maybeFail('fk');
      return hasForeignKey
        ? { rowCount: 1, rows: [{ conname: 'fk_simulated' }] }
        : { rowCount: 0, rows: [] };
    }
    if (/pg_try_advisory_lock/.test(sql)) {
      maybeFail('lock');
      const key = params[0];
      const holder = advisoryLocks.get(key);
      if (holder !== undefined && holder !== session) {
        return { rowCount: 1, rows: [{ acquired: false }] };
      }
      advisoryLocks.set(key, session);
      stats.maxLockHolders = Math.max(stats.maxLockHolders, advisoryLocks.size);
      return { rowCount: 1, rows: [{ acquired: true }] };
    }
    if (/pg_advisory_unlock/.test(sql)) {
      maybeFail('unlock');
      const key = params[0];
      if (advisoryLocks.get(key) === session) {
        advisoryLocks.delete(key);
        return { rowCount: 1, rows: [{ released: true }] };
      }
      return { rowCount: 1, rows: [{ released: false }] };
    }
    if (/DELETE FROM/.test(sql)) {
      maybeFail('delete');
      if (!/FOR UPDATE SKIP LOCKED/.test(sql)) {
        throw new Error('fake db: delete batch must use FOR UPDATE SKIP LOCKED');
      }
      const [days, limit] = params;
      const batch = [...table.entries()]
        .filter(([id, age]) => age > days && !rowLocks.has(id))
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id]) => id);
      batch.forEach((id) => rowLocks.add(id));
      try {
        const ms = delay();
        if (ms > 0) await sleep(ms);
        for (const id of batch) {
          if (!table.has(id)) doubleDeletes.push(id);
          table.delete(id);
          deleted.push(id);
        }
      } finally {
        batch.forEach((id) => rowLocks.delete(id));
      }
      return { rowCount: batch.length, rows: batch.map((id) => ({ id })) };
    }
    throw new Error(`fake db: unexpected query: ${sql.slice(0, 60)}`);
  }

  /** Drop every advisory lock a session holds, as Postgres does on disconnect. */
  function dropSession(session) {
    for (const [key, holder] of advisoryLocks) {
      if (holder === session) advisoryLocks.delete(key);
    }
  }

  /** A pg-Pool-like object. Each pool is one "instance". */
  function createPool() {
    const poolSession = nextSession++;
    return {
      query: (sql, params) => run(poolSession, sql, params),
      connect: async () => {
        maybeFail('connect');
        const session = nextSession++;
        stats.openConnections += 1;
        let released = false;
        return {
          query: (sql, params) => run(session, sql, params),
          release: (err) => {
            if (released) throw new Error('fake db: client released twice');
            released = true;
            stats.openConnections -= 1;
            if (err) {
              stats.destroyedConnections += 1;
              dropSession(session);
            }
          },
        };
      },
    };
  }

  return {
    createPool,
    /** Hold the purge lock from an unrelated session (another host). */
    holdLock(key) {
      const session = nextSession++;
      advisoryLocks.set(key, session);
      return () => advisoryLocks.delete(key);
    },
    remainingIds: () => [...table.keys()],
    deleted,
    doubleDeletes,
    stats,
    heldLocks: () => [...advisoryLocks.keys()],
    callCount: (kind) => calls.get(kind) ?? 0,
  };
}

/** `count` rows aged `ageDays` (ids prefixed so tests can tell sets apart). */
export function makeRows(count, ageDays, prefix = 'row') {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, ageDays }));
}
