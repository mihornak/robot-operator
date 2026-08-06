# server — Hono API on :8790 (`PORT` env)

- Run: `pnpm dev` (tsx watch; loads `../.env`: `OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`, optional `ELEVENLABS_VOICE_ID`, `DATABASE_URL`, `PORT`).
- `POST /api/parse` ParseRequest → ParsedCommand (OpenRouter gemini-2.5-flash-lite, 1.8s deadline, keyword fallback `source:'local'` — never 500s for parseable input).
- `POST /api/say` SayRequest → SayResponse — the unprompted mouth (OpenRouter gemini-2.5-flash, 2.6s deadline, local line bank `source:'local'` on any miss). Speech and at most a proposal; never moves the robot.
- `POST /api/tts` `{text}` → audio/mpeg (eleven_flash_v2_5; disk cache `.cache/tts/`; 503 no key, 504 timeout).
- `POST /api/wishlist` WishlistRequest → WishlistResponse (Postgres upsert on `email`, table created on first use from `sql/001_wishlist.sql`). 400 only for a body that is not an email; a missing or broken `DATABASE_URL` degrades to `stored:false` + a JSONL line in `logs/wishlist-YYYYMMDD.jsonl` — never 500s, because a dead database must not trap a player behind the restart gate.
- `POST /api/log` LogBatch → 204 (JSONL to `logs/events-YYYYMMDD.jsonl`); `GET /api/health` → `{ok,llm,tts,db}`.
- `DATABASE_URL` is optional. TLS is skipped for `*.railway.internal` and localhost, and `rejectUnauthorized:false` everywhere else (managed-Postgres certs are not ours to verify).
- Serves `../client/dist` at `/` when built (dev uses the vite proxy).
