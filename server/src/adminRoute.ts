/**
 * The read side of the durable event store (analytics.ts) — everything the
 * `/admin` page shows, and nothing else. Every query here is a SELECT.
 *
 * Auth is one shared secret, on purpose (single-operator threat model): an
 * `ADMIN_TOKEN` compared with `timingSafeEqual`, and `Authorization: Bearer`
 * ONLY — never a query param, which would put the secret in every access log
 * and in Railway's log explorer. The two "off" states are deliberately
 * different: no token at all answers 501, so a deploy that forgot the variable
 * is closed rather than silently open, and a missing DATABASE_URL answers 503,
 * so the dashboard can say "no database" instead of drawing zeroes that look
 * like real, terrible numbers.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { Pool } from 'pg';
import type { AdminOverview, AdminSession, AdminSignup } from '../../shared/types';
import { getPool } from './wishlist';

/**
 * Per-session rollup over the window. `floor` is dug out of the two events that
 * carry one, and only when it looks like a number — `props` is client-supplied
 * JSON, so an unguarded `::int` is a 500 waiting for a bad build to ship.
 *
 * The gate pair is the only session↔signup link there is: the `wishlist` table
 * has no session column, and the address deliberately never enters telemetry.
 * `signed_up` therefore means "signed up ON THIS SESSION" — a returning player
 * who is satisfied from localStorage is never shown the gate again and emits
 * neither event, so they read as false here. That is the honest answer to the
 * question this column asks; "is this person on the list" is a different
 * question, and only the `wishlist` table can answer it.
 */
const PER_SESSION = `
  with ev as (
    select session, ts, type,
      case when type in ('death', 'floor_complete') and props->>'floor' ~ '^[0-9]{1,4}$'
           then (props->>'floor')::int end as floor
    from events
    where ts >= current_date - ($1::int - 1)
  ), per as (
    select session,
      min(ts) as first_seen,
      max(ts) as last_seen,
      max(floor) as max_floor,
      count(*) filter (where type = 'command') as commands,
      count(*) filter (where type = 'death') as deaths,
      bool_or(type = 'boot') as booted,
      bool_or(type in ('title_card', 'cliffhanger_reached')) as finished,
      -- "Was this player asked?" is the UNION, not the shown-event alone. A
      -- wishlist_submit can only come out of submit(), which is only reachable
      -- from an open gate, so a submit is PROOF the gate was shown. A submit
      -- with no shown means we lost the shown event to a closing tab — not that
      -- somebody signed up without being asked. Counting only the shown event
      -- would throw away information we know to be true, and would let the
      -- signup step exceed the step above it in the funnel.
      bool_or(type in ('wishlist_shown', 'wishlist_submit')) as gate_shown,
      bool_or(type = 'wishlist_submit') as signed_up
    from ev group by session
  )`;

/** Clamp a `?days=` / `?limit=` query param into a range the SQL can survive. */
function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Constant-time compare, length-checked first because lengths may differ. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** pg hands back bigint and numeric as strings — normalize at this edge, so no
 *  consumer ever has to wonder whether a count is a number or "3". */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Same, but "absent" stays absent: an average over an empty group is null. */
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Averages and ratios come out of pg with fifteen digits of false precision.
 *  Round here rather than hoping every consumer remembers to. */
function round(v: number | null, places: number): number | null {
  if (v == null) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/** timestamptz arrives as a Date; the contract says string. */
function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return v == null ? '' : String(v);
}

/** RFC4180-ish cell. */
function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A table nobody has written to yet does not exist — that is a legitimate
 *  empty dashboard, not a 500. Both tables are created lazily on first write. */
async function tableExists(db: Pool, name: string): Promise<boolean> {
  const res = await db.query<{ reg: string | null }>('SELECT to_regclass($1) AS reg', [name]);
  return res.rows[0]?.reg != null;
}

export interface AdminRouteDeps {
  /** The shared secret. Null → the whole surface answers 501. */
  adminToken: string | null;
}

/** Register the admin API. Safe to call unconditionally — gated by `adminToken`. */
export function registerAdminRoutes(app: Hono, deps: AdminRouteDeps): void {
  const { adminToken } = deps;

  // ── auth gate ──────────────────────────────────────────────────────────────
  app.use('/api/admin/*', async (c, next) => {
    if (!adminToken) return c.json({ error: 'admin api not configured' }, 501);
    const header = c.req.header('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    // One answer for missing and for wrong: which of the two it was is not the
    // caller's business, and saying costs nothing to defend against.
    if (!provided || !tokenMatches(provided, adminToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  /** Resolve the pool once per request and turn any query failure into JSON. */
  const route =
    (fn: (c: Context, db: Pool) => Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      const db = getPool();
      if (!db) return c.json({ error: 'no database' }, 503);
      try {
        return await fn(c, db);
      } catch (err) {
        console.error('[admin] query failed:', String(err));
        return c.json({ error: 'query failed' }, 500);
      }
    };

  // ── GET /api/admin/overview?days=30 → AdminOverview ────────────────────────
  app.get(
    '/api/admin/overview',
    route(async (c, db) => {
      const days = clampInt(c.req.query('days'), 1, 365, 30);
      const hasEvents = await tableExists(db, 'public.events');
      const hasWishlist = await tableExists(db, 'public.wishlist');

      const totals = hasEvents
        ? (
            await db.query<Record<string, unknown>>(
              `${PER_SESSION}
               select count(*) as sessions,
                 count(*) filter (where booted) as booted,
                 count(*) filter (where commands > 0) as played,
                 count(*) filter (where deaths > 0) as died,
                 count(*) filter (where finished) as finished,
                 -- Two nested sets, and only two: every session that submitted
                 -- is inside the set that was asked (see the union above), so
                 -- submitted/asked cannot exceed 1 and the funnel cannot widen.
                 count(*) filter (where gate_shown) as gate_shown,
                 count(*) filter (where signed_up) as gate_submitted,
                 avg(max_floor) as avg_floor,
                 percentile_cont(0.5) within group (order by max_floor) as median_floor
               from per`,
              [days],
            )
          ).rows[0]
        : undefined;

      // Depth, mean and median all read the same population — the sessions that
      // got far enough to log a floor at all — so the histogram and the two
      // headline numbers above it can never disagree.
      const depth = hasEvents
        ? (
            await db.query<Record<string, unknown>>(
              `${PER_SESSION}
               select max_floor as floor, count(*) as sessions
               from per where max_floor is not null group by 1 order by 1`,
              [days],
            )
          ).rows
        : [];

      const daily = hasEvents
        ? (
            await db.query<Record<string, unknown>>(
              `with d as (
                 select generate_series(current_date - ($1::int - 1), current_date, '1 day')::date as day
               )
               select to_char(d.day, 'YYYY-MM-DD') as day,
                 (select count(distinct session) from events e where e.ts::date = d.day) as sessions,
                 (select count(distinct session) from events e
                    where e.ts::date = d.day and e.type = 'command') as played,
                 (select count(distinct session) from events e
                    where e.ts::date = d.day and e.type = 'wishlist_submit') as signups
               from d order by d.day`,
              [days],
            )
          ).rows
        : [];

      // The funnel is events, session-scoped, all of it. `addressesStored` is
      // the one number here read from the wishlist table, and it sits in its own
      // field precisely so the two can be compared: the gate logs its event
      // BEFORE the fail-soft POST, so `signups` above `addressesStored` is the
      // delivery gap — addresses a player really typed that never reached
      // Postgres. Showing that gap is the point; averaging it away would hide
      // the only failure mode the player cannot see and we cannot undo.
      const stored = hasWishlist
        ? (await db.query<Record<string, unknown>>(`select count(*) as n from wishlist`)).rows[0]
        : undefined;

      const allTime = hasEvents
        ? (
            await db.query<Record<string, unknown>>(
              `select count(distinct session) as all_time from events where type = 'wishlist_submit'`,
            )
          ).rows[0]
        : undefined;

      // Conversion is measured strictly between the gate events: a returning
      // player is satisfied from localStorage and never sees the form, so
      // scoring against every session that ended a run would quietly punish the
      // game for people it never asked.
      const asked = num(totals?.gate_shown);
      const submitted = num(totals?.gate_submitted);
      const out: AdminOverview = {
        days,
        sessions: num(totals?.sessions),
        booted: num(totals?.booted),
        played: num(totals?.played),
        died: num(totals?.died),
        finished: num(totals?.finished),
        depth: depth.map((r) => ({ floor: num(r.floor), sessions: num(r.sessions) })),
        avgFloor: round(numOrNull(totals?.avg_floor), 2),
        medianFloor: numOrNull(totals?.median_floor),
        // The denominator conversionPct divides by, exposed so the funnel can
        // draw the step rather than inferring it.
        sawGate: asked,
        // Sessions that submitted the gate: inside the window, then all-time.
        // Both events, so the pair is monotonic and reads as a pair.
        signups: submitted,
        signupsAllTime: num(allTime?.all_time),
        addressesStored: num(stored?.n),
        conversionPct: asked > 0 ? round((submitted / asked) * 100, 1) : null,
        daily: daily.map((r) => ({
          day: String(r.day),
          sessions: num(r.sessions),
          played: num(r.played),
          signups: num(r.signups),
        })),
      };
      return c.json(out);
    }),
  );

  // ── GET /api/admin/sessions?limit=50 → AdminSession[] ──────────────────────
  app.get(
    '/api/admin/sessions',
    route(async (c, db) => {
      const limit = clampInt(c.req.query('limit'), 1, 1000, 50);
      if (!(await tableExists(db, 'public.events'))) return c.json([] satisfies AdminSession[]);
      // The window is deliberately wide here: this is the drill-down, and a
      // session from six weeks ago is exactly the one worth reading.
      const rows = (
        await db.query<Record<string, unknown>>(
          `${PER_SESSION}
           select * from per order by last_seen desc limit $2`,
          [365, limit],
        )
      ).rows;
      const out: AdminSession[] = rows.map((r) => ({
        session: String(r.session),
        firstSeen: iso(r.first_seen),
        lastSeen: iso(r.last_seen),
        maxFloor: numOrNull(r.max_floor),
        commands: num(r.commands),
        deaths: num(r.deaths),
        signedUp: r.signed_up === true,
      }));
      return c.json(out);
    }),
  );

  // ── GET /api/admin/wishlist?limit=200 → AdminSignup[] ──────────────────────
  app.get(
    '/api/admin/wishlist',
    route(async (c, db) => {
      const limit = clampInt(c.req.query('limit'), 1, 1000, 200);
      if (!(await tableExists(db, 'public.wishlist'))) return c.json([] satisfies AdminSignup[]);
      const rows = (
        await db.query<Record<string, unknown>>(
          `select email, floor, robot_name, created_at from wishlist
           order by created_at desc limit $1`,
          [limit],
        )
      ).rows;
      const out: AdminSignup[] = rows.map((r) => ({
        email: String(r.email),
        floor: numOrNull(r.floor),
        robotName: (r.robot_name as string | null) ?? null,
        createdAt: iso(r.created_at),
      }));
      return c.json(out);
    }),
  );

  // ── GET /api/admin/wishlist.csv ────────────────────────────────────────────
  // The whole list, unpaginated — this is the file you hand to a mail tool.
  app.get(
    '/api/admin/wishlist.csv',
    route(async (c, db) => {
      const header = 'email,floor,robot_name,created_at';
      const rows = (await tableExists(db, 'public.wishlist'))
        ? (
            await db.query<Record<string, unknown>>(
              `select email, floor, robot_name, created_at from wishlist order by created_at desc`,
            )
          ).rows
        : [];
      const body = rows
        .map((r) => [r.email, r.floor, r.robot_name, r.created_at].map(csvCell).join(','))
        .join('\n');
      return c.text(`${header}\n${body}${body ? '\n' : ''}`, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="robot-operator-wishlist.csv"',
      });
    }),
  );
}
