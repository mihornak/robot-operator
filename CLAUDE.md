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
  `render/lit/` is the deferred-lighting renderer (lightmap, shadow volumes,
  decor, fixtures, grade). It is driven by plain data (`SceneDef`), so the same
  code serves the graphics lab, the designer preview and a lit level in game.
  Read `client/src/render/lit/README.md` before touching any of it.
- `client/src/art/` — code-drawn pixel textures (canvas → pixi textures) per `shared/artManifest.ts`, plus `sprites/` (build-time 3D bakes, see rule 10).
- `client/src/audio/` — WebAudio: sfx, voice playback (radio-processed), hum. iOS resume handling.
- `client/src/voice/` — CommandSource impls: WebSpeech (push-to-talk), LlmSpeech
  (records the press to 16 kHz WAV and lets the parse model listen — the ears
  for Safari/iOS, which ship no SpeechRecognition), Teletype. Exactly one mic
  source is chosen per browser; `?stt=llm` forces the recorded path.
- `client/src/designer/` — the level designer (`/designer.html`), a third Vite
  entry. Nothing in `client/src/` imports it; it imports the game, so what it
  draws is the real renderer. Read `client/src/designer/README.md`.
- `client/src/levels/` — designer-authored levels as data, one `LevelData` per
  `<id>.level.ts`, plus the partly generated registry `index.ts` (the
  `designer:` markers in it are the save endpoint's contract). `sim/floors.ts`
  loads them through `sim/levelLoader.ts` one of two ways. Without
  `meta.replaces` a level is APPENDED after the built-ins: reached with
  `?floor=N`, never part of the shipping run. With `meta.replaces: N` (1-based,
  the same number `?floor=N` takes) it STANDS IN for built-in floor N and is
  what the player plays — floor 1 today is `floor-1-copy.level.ts`. A slot that
  is out of range or claimed twice is a `pnpm test` failure, and the room
  contracts in `sim/selftest.ts` that read a replaced floor's built-in content
  skip with a printed note.
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
- `/designer.html` (`pnpm dev`, then <http://localhost:5173/designer.html>) —
  the level designer: draw a floor, dress and light it, check it, playtest it,
  save it. Save is `POST /__designer/save`, a dev-only Vite plugin that writes
  `client/src/levels/<id>.level.ts` and upserts the registry — so the button is
  absent from a built bundle, which has no server to answer it. Read
  `client/src/designer/README.md`.
  (`tools/level-designer.html`, the tiles-only predecessor, is superseded.)
- `/lab.html` (`pnpm dev`, then <http://localhost:5173/lab.html>) — the graphics
  lab: one hand-dressed room over `render/lit`, with ~100 tunables on live
  sliders. It is a tuning surface, not part of the game: nothing in
  `client/src/` imports `client/src/lab/` (imports flow lab → render/lit, never
  back), and it deliberately ignores the near-monochrome palette law so the
  question "what if the light did the work?" can be answered before anything is
  proposed for the shipping look. Read `client/src/render/lit/README.md` before
  touching the renderer — in particular the five rules it was debugged into,
  which are the ones any 2D lighting work here will hit — and
  `client/src/lab/README.md` for the panel.
- `pnpm sprites [name…]` — bake 3D models (asset-store `.glb`/`.fbx`/`.blend`)
  into pixel sprites via headless Blender. Jobs in `tools/sprites.json`, sources
  in gitignored `art-src/`, output PNGs in `client/src/art/sprites/`, manifest
  entries marked `src: 'png'`. Needs `brew install --cask blender`; without it
  the committed sprites still build and play. **No 3D reaches the browser** —
  no three.js, no runtime loader, no shippable model. See rule 10.
