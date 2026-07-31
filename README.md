# ROBOT OPERATOR — 5-floor teaser

You're the operator in the basement. Security cameras, one surviving service robot,
a sticky note: *"IF BROKEN: turn the main computer OFF and ON. It's on floor 15. — M."*
Hold **SPACE** and talk. That's the whole interface.

## Run

```sh
pnpm install
pnpm dev          # server :8790 + client :5173 → open http://localhost:5173
```

Best in **Chrome** (Web Speech push-to-talk). No mic / other browser: just type — the
teletype line is always there. With no API keys in `.env` the game still runs
(local parser + captions).

## Production / share

```sh
pnpm build && pnpm start   # serves the built client on :8790
```

`.env` (repo root): `OPENROUTER_API_KEY` (command parsing), `ELEVENLABS_API_KEY`
(+ `ELEVENLABS_VOICE_ID`) for the robot's voice. Regenerate the voice bank / SFX:

```sh
node --env-file=.env scripts/genVoiceBank.mjs
node --env-file=.env scripts/genSfx.mjs
```

Design docs: `GAME_SPEC.md` (systems), `FIRST_MINUTES.md` (feel), `CONCEPT.md` (why).
