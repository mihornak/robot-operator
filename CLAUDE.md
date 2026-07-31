# ROBOT OPERATOR — repo rules (non-negotiable)

Read `GAME_SPEC.md` (systems) and `FIRST_MINUTES.md` (feel; wins on feel).

## Hard rules

1. **Self-contained bundle law:** no runtime CDN, no remote wasm, no dynamic-import-from-URL, no external fonts/assets. Vite `base: './'`, relative paths only. Everything ships in the bundle or `public/`.
2. **PixiJS v8 API only** — LLM corpus is v7; do NOT write v7:
   - `const app = new Application(); await app.init({...})` — NEVER `new Application(opts)`
   - `app.canvas` — NEVER `app.view`
   - `texture.source.scaleMode = 'nearest'` / `TextureStyle` — not v7 SCALE_MODES
   - Filters from `pixi-filters` v6 (CRTFilter, GlitchFilter, BulgePinchFilter).
3. **`client/src/sim/` is pure:** never imports pixi, DOM, or anything async. Fixed-timestep, deterministic from seed (`mulberry32` in `shared/`). All randomness through the seeded rng in state. `render/` reads sim state, writes NOTHING back.
4. **Voice is a `CommandSource` interface** (`shared/types.ts`). Any feature that assumes a mic exists is a bug. Text teletype path must always work.
5. **The LLM interprets INPUT only.** It never adjudicates outcomes, touches stats, or acts in the combat loop. Deterministic engine executes intents.
6. **Raw transcript is never shown anywhere.** The robot repeats back in its own words.
7. **Toddler-speak bible** for every robot line: third person ("ROBOT…", never "I"), ≤7 words, no subordinate clauses, overconfident never sad, misapplied abstractions ("WALL IS RUDE").
8. **TTS:** `eleven_flash_v2_5` only, NO audio tags, ever. Fail-soft chain: realtime → bank generic → caption-only. Zero keys = fully playable with captions.
9. All cross-subsystem contracts live in `shared/types.ts` + `shared/artManifest.ts`. Do not invent parallel types; extend there.

## Layout

- `shared/` — types, intents, art manifest, rng. Imported by client (alias `@shared`) and server (relative).
- `client/src/sim/` — deterministic sim: state, step, floors, robot behavior tree.
- `client/src/render/` — PixiJS v8 only: stage, tilemap, sprites, CRT stack, OSD.
- `client/src/art/` — code-drawn pixel textures (canvas → pixi textures) per `shared/artManifest.ts`.
- `client/src/audio/` — WebAudio: sfx, voice playback (radio-processed), hum. iOS resume handling.
- `client/src/voice/` — CommandSource impls: WebSpeech (push-to-talk), Teletype.
- `client/src/net/` — `/api/parse`, `/api/tts`, `/api/log` client.
- `client/src/game/` — director: beats, script, ceremonies, death card. The only place that wires subsystems.
- `server/` — Hono: `/api/parse` (OpenRouter), `/api/tts` (ElevenLabs proxy + disk cache), `/api/log`, serves `client/dist` in prod.
- `scripts/` — voice-bank + SFX pregeneration (needs `.env` keys).

## Commands

- `pnpm install` (workspace root)
- `pnpm dev` — server :8790 + vite :5173 (proxy `/api` → 8790)
- `pnpm build` then `pnpm start` — production, server serves static
- `pnpm check` — tsc across packages
