/**
 * The durable half of `/api/log`. The JSONL file on disk is still written and
 * still authoritative for a live tail; this is the copy that survives, because
 * Railway's filesystem does not outlive a redeploy and the question "did
 * anybody get past floor two" is asked weeks later.
 *
 * Everything here is fire-and-forget in the same spirit as wishlist.ts: nothing
 * is awaited in the request path, nothing throws, and a database that is absent,
 * down, or wrong costs the client exactly nothing — /api/log still answers 204.
 */

import type { Pool } from 'pg';
import { getPool } from './wishlist';

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  session TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL,
  props JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/** Session drill-down reads by session; the overview reads by type over a window. */
const INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS events_session_idx ON events (session)`,
  `CREATE INDEX IF NOT EXISTS events_type_ts_idx ON events (type, ts)`,
];

const SESSION_MAX = 64;
const TYPE_MAX = 64;
/** Zod already caps the batch at 200; this is the belt to that pair of braces. */
const BATCH_MAX = 200;
/** A `t` outside this is a clock that is wrong, not a moment — drop the row. */
const T_MIN = Date.UTC(2020, 0, 1);

let migrated: Promise<void> | null = null;
/** Logged once — a database that is down is down for every batch that follows. */
let warned = false;

function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  console.error('[events] database unavailable, disk log unaffected:', String(err));
}

/** Idempotent, once per process. A failure drops the promise so the next batch
 *  retries rather than caching the outage for the life of the deploy. */
function migrate(db: Pool): Promise<void> {
  if (!migrated) {
    migrated = (async () => {
      await db.query(TABLE_DDL);
      for (const ddl of INDEX_DDL) await db.query(ddl);
    })();
    migrated.catch(() => {
      migrated = null;
    });
  }
  return migrated;
}

/** One row on its way to the table, already checked. */
interface Row {
  ts: Date;
  type: string;
  props: string | null;
}

/** `{t, type, data?}` from client/src/net/api.ts — every field re-checked here,
 *  because /api/log validates the envelope and leaves the items unknown. */
function toRow(raw: unknown): Row | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { t, type, data } = raw as { t?: unknown; type?: unknown; data?: unknown };
  if (typeof type !== 'string' || !type) return null;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < T_MIN) return null;
  // A future timestamp is a client clock running fast, not a lie worth keeping:
  // clamp rather than drop, so the event still counts towards the session.
  const ts = new Date(Math.min(t, Date.now()));
  const isProps = typeof data === 'object' && data !== null && !Array.isArray(data);
  return { ts, type: type.slice(0, TYPE_MAX), props: isProps ? JSON.stringify(data) : null };
}

/**
 * Persist one batch of client events. Never awaited, never throws.
 *
 * The whole batch goes in as ONE multi-row INSERT — a loop of inserts would
 * hold a pooled connection for the length of a session's chatter, and there are
 * only four of them.
 */
export function recordEvents(session: string, events: unknown[]): void {
  const db = getPool();
  if (!db) return;
  try {
    const rows: Row[] = [];
    for (const raw of events.slice(0, BATCH_MAX)) {
      const row = toRow(raw);
      if (row) rows.push(row);
    }
    if (rows.length === 0) return;
    const key = session.slice(0, SESSION_MAX);
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(key, r.ts, r.type, r.props);
      return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
    });
    const sql = `INSERT INTO events (session, ts, type, props) VALUES ${tuples.join(', ')}`;
    void migrate(db)
      .then(() => db.query(sql, values))
      .then(() => undefined)
      .catch(warnOnce);
  } catch (err) {
    warnOnce(err);
  }
}
