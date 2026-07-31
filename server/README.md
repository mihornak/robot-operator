# server — Hono API on :8790 (`PORT` env)

- Run: `pnpm dev` (tsx watch; loads `../.env`: `OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`, optional `ELEVENLABS_VOICE_ID`, `PORT`).
- `POST /api/parse` ParseRequest → ParsedCommand (OpenRouter gemini-2.5-flash-lite, 1.8s deadline, keyword fallback `source:'local'` — never 500s for parseable input).
- `POST /api/tts` `{text}` → audio/mpeg (eleven_flash_v2_5; disk cache `.cache/tts/`; 503 no key, 504 timeout).
- `POST /api/log` LogBatch → 204 (JSONL to `logs/events-YYYYMMDD.jsonl`); `GET /api/health` → `{ok,llm,tts}`.
- Serves `../client/dist` at `/` when built (dev uses the vite proxy).
