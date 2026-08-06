/**
 * /api/wishlist storage — Postgres when `DATABASE_URL` is set, a JSONL line on
 * disk when it is not, and a JSONL line on disk again when the database is
 * there but broken. The gate stands between a finished run and the next one,
 * so a dead backend must cost the player nothing: every path returns ok.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool, PoolConfig } from 'pg';
import type { WishlistRequest, WishlistResponse } from '../../shared/types';

const LOGS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS wishlist (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  floor INTEGER,
  robot_name TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/** A re-submit updates the run, but COALESCE keeps what it does not carry: the
 *  player who never named the robot on their second run sends no robotName,
 *  and the name captured on the first run must not be erased by that silence. */
const INSERT_SQL = `INSERT INTO wishlist (email, floor, robot_name, user_agent)
VALUES ($1, $2, $3, $4)
ON CONFLICT (email) DO UPDATE SET
  floor = COALESCE(EXCLUDED.floor, wishlist.floor),
  robot_name = COALESCE(EXCLUDED.robot_name, wishlist.robot_name)
RETURNING (xmax = 0) AS inserted`;

const USER_AGENT_MAX = 300;

let pool: Pool | null = null;
let migrated: Promise<void> | null = null;
/** DB errors are logged once — a database that is down is down every request. */
let warned = false;

/** Railway's private network and localhost speak plaintext; anything else is
 *  a public proxy hostname, where TLS is mandatory and the cert is not ours. */
function needsTls(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host.endsWith('.railway.internal')) return false;
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
}

/** The one pool in the process. Railway's free Postgres has a low connection
 *  cap, so analytics.ts and adminRoute.ts borrow this rather than open their own. */
export function getPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    const config: PoolConfig = {
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    };
    if (needsTls(url)) config.ssl = { rejectUnauthorized: false };
    pool = new pg.Pool(config);
    // An idle client dropped by the network emits 'error' on the POOL, and an
    // unhandled one takes the whole process down with it. Swallow it here.
    pool.on('error', (err) => console.error('[wishlist] idle client', String(err)));
  }
  return pool;
}

/** Idempotent, once per process — concurrent requests await the same promise. */
function migrate(db: Pool): Promise<void> {
  if (!migrated) {
    migrated = db.query(TABLE_DDL).then(() => undefined);
    // A failed migration must be retryable: drop the promise so the next
    // request tries again rather than caching the outage forever.
    migrated.catch(() => {
      migrated = null;
    });
  }
  return migrated;
}

/** `a***@example.com` — enough to debug a signup, never the address itself. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** The no-database path: keep the signup somewhere a human can still find it. */
async function logToDisk(req: WishlistRequest, userAgent: string, why: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const line = JSON.stringify({ ts: new Date().toISOString(), why, ...req, userAgent });
  try {
    await mkdir(LOGS_DIR, { recursive: true });
    await appendFile(join(LOGS_DIR, `wishlist-${day}.jsonl`), `${line}\n`);
  } catch {
    /* the fallback for the fallback is the console line the route prints */
  }
}

/**
 * Store one signup. Never throws, never reports failure to the player: a
 * database problem downgrades to `stored: false` and a line on disk.
 */
export async function saveWishlist(
  req: WishlistRequest,
  userAgent: string | undefined,
): Promise<WishlistResponse> {
  const ua = (userAgent ?? '').slice(0, USER_AGENT_MAX);
  const db = getPool();
  if (!db) {
    await logToDisk(req, ua, 'no-database-url');
    return { ok: true, already: false, stored: false };
  }
  try {
    await migrate(db);
    const res = await db.query<{ inserted: boolean }>(INSERT_SQL, [
      req.email,
      req.floor ?? null,
      req.robotName ?? null,
      ua || null,
    ]);
    return { ok: true, already: res.rows[0]?.inserted === false, stored: true };
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error('[wishlist] database unavailable, falling back to disk:', String(err));
    }
    await logToDisk(req, ua, 'db-error');
    return { ok: true, already: false, stored: false };
  }
}
