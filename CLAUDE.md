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
10. **3D is a build-time tool, never a runtime one.** Bought models (Fab, Unity
    Asset Store, Superhive) are welcome as *sources* — `pnpm sprites` bakes them
    to pixels through headless Blender at a fixed 45° ortho projection and the
    world palette. What ships is a PNG, indistinguishable from the hand-drawn
    art beside it. Three reasons, in order: the fixed camera can't use a live
    renderer, three.js + a glTF loader would break the pixel-art lock and the
    bundle budget, and asset licences let you ship a model inside a product —
    a web build hands players the `.glb` itself. Sources stay in `art-src/`,
    gitignored, off the wire.

## Layout

- `shared/` — types, intents, art manifest, rng. Imported by client (alias `@shared`) and server (relative).
- `client/src/sim/` — deterministic sim: state, step, floors, robot behavior tree.
- `client/src/render/` — PixiJS v8 only: stage, tilemap, sprites, CRT stack, OSD.
- `client/src/art/` — code-drawn pixel textures (canvas → pixi textures) per `shared/artManifest.ts`, plus `sprites/` (build-time 3D bakes, see rule 10).
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
- `pnpm selftest` — sim determinism + floor sanity + behaviour contracts
- `pnpm fuzz [seed] [samples]` — randomised navigation sweep: every floor, random
  start tiles, every targetable entity, goto/pickup × initiative on/off. Scripted
  tests only cover routes their author imagined; this is what catches "the robot
  won't fetch things".
- `pnpm test` — check + selftest + fuzz. Run before calling anything done.
- `tools/level-designer.html` — draw floors in a browser, paste the exported
  `FloorDef` into `client/src/sim/floors.ts`.
- `pnpm sprites [name…]` — bake 3D models (asset-store `.glb`/`.fbx`/`.blend`)
  into pixel sprites via headless Blender. Jobs in `tools/sprites.json`, sources
  in gitignored `art-src/`, output PNGs in `client/src/art/sprites/`, manifest
  entries marked `src: 'png'`. Needs `brew install --cask blender`; without it
  the committed sprites still build and play. **No 3D reaches the browser** —
  no three.js, no runtime loader, no shippable model. See rule 10.
