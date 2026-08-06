/**
 * ROBOT OPERATOR server — Hono on :PORT (default 8790).
 * /api/parse (OpenRouter + local fallback), /api/tts (ElevenLabs + disk
 * cache), /api/log (JSONL), /api/health, and ../client/dist static in prod.
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ParseRequest, SayRequest } from '../../shared/types';
import { registerAdminRoutes } from './adminRoute';
import { recordEvents } from './analytics';
import { parseUtterance } from './parse';
import { sayLine } from './say';
import { parseRequestSchema, sayRequestSchema, wishlistRequestSchema } from './schema';
import { synthesize } from './tts';
import { maskEmail, saveWishlist } from './wishlist';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGS_DIR = join(SERVER_DIR, 'logs');
const CLIENT_DIST = join(SERVER_DIR, '..', 'client', 'dist');

const app = new Hono();

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    llm: Boolean(process.env.OPENROUTER_API_KEY),
    tts: Boolean(process.env.ELEVENLABS_API_KEY),
    db: Boolean(process.env.DATABASE_URL),
    admin: Boolean(process.env.ADMIN_TOKEN),
  }),
);

app.post('/api/parse', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const parsed = parseRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad ParseRequest' }, 400);
  const req: ParseRequest = parsed.data;
  const t0 = Date.now();
  const cmd = await parseUtterance(req);
  console.log(`[parse] ${cmd.source} ${cmd.intent} ${Date.now() - t0}ms "${cmd.ack_line}"`);
  return c.json(cmd);
});

/** The robot talking because something happened, not because it was spoken to. */
app.post('/api/say', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const parsed = sayRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad SayRequest' }, 400);
  const req: SayRequest = parsed.data;
  const t0 = Date.now();
  const out = await sayLine(req);
  console.log(`[say] ${out.source} ${req.trigger} ${Date.now() - t0}ms "${out.line}"`);
  return c.json(out);
});

app.post('/api/tts', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const text =
    typeof body === 'object' && body !== null && typeof (body as { text?: unknown }).text === 'string'
      ? ((body as { text: string }).text).trim()
      : '';
  if (!text || text.length > 500) return c.json({ error: 'text required, ≤500 chars' }, 400);
  const result = await synthesize(text);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  c.header('Content-Type', 'audio/mpeg');
  c.header('Cache-Control', 'no-store');
  c.header('X-Tts-Cache', result.cached ? 'hit' : 'miss');
  return c.body(result.audio);
});

/** The email gate. 400 only for a body that is not an email — everything after
 *  that is best-effort, because a player is standing in front of this waiting
 *  to play again and a broken database is not their problem. */
app.post('/api/wishlist', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const parsed = wishlistRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad WishlistRequest' }, 400);
  const t0 = Date.now();
  const out = await saveWishlist(parsed.data, c.req.header('user-agent'));
  console.log(
    `[wishlist] ${maskEmail(parsed.data.email)} stored=${out.stored} already=${out.already} floor=${parsed.data.floor ?? '-'} ${Date.now() - t0}ms`,
  );
  return c.json(out);
});

/** Loose LogBatch mirror — event items unchecked, count capped. */
const logBatchSchema = z.object({
  session: z.string(),
  events: z.array(z.unknown()).max(200),
});
const LOG_MAX_BYTES = 64 * 1024;

app.post('/api/log', async (c) => {
  const raw = await c.req.text();
  if (raw.length > LOG_MAX_BYTES) return c.json({ error: 'body too large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const parsed = logBatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad LogBatch' }, 400);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  try {
    await mkdir(LOGS_DIR, { recursive: true });
    await appendFile(join(LOGS_DIR, `events-${day}.jsonl`), `${JSON.stringify(parsed.data)}\n`);
  } catch {
    /* telemetry must never fail the client */
  }
  // The durable copy. Not awaited, never throws, no-op without DATABASE_URL —
  // the 204 above this line is the client's whole contract and it holds even
  // with the database on fire.
  recordEvents(parsed.data.session, parsed.data.events);
  return c.body(null, 204);
});

// The read-only ops surface. Registered before the static catch-all, and closed
// (501) unless ADMIN_TOKEN is set — see adminRoute.ts.
registerAdminRoutes(app, { adminToken: process.env.ADMIN_TOKEN?.trim() || null });

/** The dashboard page itself. It lives outside `client/dist` because it is not
 *  part of the game bundle, and it carries no secret — the operator pastes the
 *  token into it, and every number behind it is gated by the API above. */
app.get(
  '/admin',
  serveStatic({ path: relative(process.cwd(), join(SERVER_DIR, 'public', 'admin.html')) }),
);

// Production: serve the built client. Dev uses the vite proxy instead.
if (existsSync(CLIENT_DIST)) {
  app.use('/*', serveStatic({ root: relative(process.cwd(), CLIENT_DIST) }));
}

const port = Number(process.env.PORT) || 8790;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `robot-operator server on :${info.port} (llm=${Boolean(process.env.OPENROUTER_API_KEY)} tts=${Boolean(process.env.ELEVENLABS_API_KEY)} static=${existsSync(CLIENT_DIST)})`,
  );
});
