# Deploying ROBOT OPERATOR to Railway

This deploys the whole game as **one Railway service**. The Node server (Hono)
serves the API *and* the built client bundle from the same origin, so there is
no CORS to configure, no second service, and no static host to keep in sync.
A Postgres database is a second service, but it is optional — read on.

Budget about ten minutes for a first deploy, most of it waiting for the build.

---

## Before you start

You need:

- A GitHub repo containing this code, pushed to a branch (Railway deploys
  a branch, and by default it will keep deploying every push to it).
- A Railway account. You are logged in as **mihornak@gmail.com**, whose only
  workspace is **Miro's Projects** (personal). That is where the project will
  land unless you pick another.

You do **not** need any API keys. This matters and is worth stating plainly:
the game is fully playable with zero keys. Without `OPENROUTER_API_KEY` the
server falls back to a local intent parser, so typed and spoken commands still
work. Without `ELEVENLABS_API_KEY` the robot speaks in captions instead of
audio. Keys buy fidelity, not access. Deploy first, add keys later.

---

## 1. Create the project from the GitHub repo

1. Go to <https://railway.com/new>.
2. Choose **Deploy from GitHub repo**.
3. If this is your first Railway project, you will be asked to install the
   Railway GitHub App and grant it access. Grant it access to this repository
   (you can choose "Only select repositories").
4. Pick the repo from the list. Railway creates the project and immediately
   starts a first deploy.

That first deploy will probably **succeed but be useless**, because no
variables are set yet and — more importantly — you have not added the
database. Do not panic if it looks odd; you are going to redeploy at the end
anyway. If you want to be tidy, you can let it finish and ignore it.

The service will be named after the repo (`robot-operator`). Everything below
happens on the project canvas — the grid view with your service tiles on it.

### What Railway will do, and why you do not have to configure it

`railway.json` at the repo root already pins the build. Railway reads it on
every deploy and it overrides anything set in the dashboard:

| Setting | Value | Why |
|---|---|---|
| Builder | `RAILPACK` | Railway's current builder. Nixpacks is the previous generation and is no longer the documented default; Railpack handles pnpm workspaces natively. |
| Build command | `pnpm run build` | Root script → `pnpm --filter client build` → `vite build` → `client/dist/`. |
| Start command | `pnpm run start` | Root script → `pnpm --filter server start` → `tsx src/index.ts`. |
| Healthcheck path | `/api/health` | Deploy is not promoted until this returns 200. |
| Healthcheck timeout | 120s | The server boots in about a second; 120s is slack, not a target. |
| Restart policy | `ON_FAILURE`, max 10 | A crash restarts; a clean exit does not loop. |

Node is pinned to **24** by the `.node-version` file at the repo root. That
version is not arbitrary: the server's start script uses
`node --env-file-if-exists`, which needs Node ≥ 22.9, and `pnpm test` uses
`node --experimental-strip-types`, which is only unflagged from Node 22.18
onward. Node 24 is the current LTS and matches the version this was developed
on, so 24 it is. There is no `nixpacks.toml` and you should not need one —
Railpack detects pnpm from `pnpm-lock.yaml` and installs the workspace itself.

One deliberate choice: **`tsx` is a runtime dependency, not a dev one.** The
server is never compiled — `pnpm start` runs `tsx src/index.ts` directly, so
`tsx` is as load-bearing in production as Hono is. It sits in
`server/package.json` under `dependencies` for exactly that reason. Railpack
only prunes dev dependencies when you opt in via `RAILPACK_PRUNE_DEPS`, so this
would survive either way — but depending on a builder's default to keep a
runtime dependency alive is the kind of thing that breaks quietly a year later.

---

## 2. Add the Postgres database

The database backs one thing: the wishlist email capture on the end-of-run
card. The app degrades gracefully without it — signups get appended to a JSONL
file and the player still sees success — but on Railway that file sits on
ephemeral disk and is **wiped on every redeploy**. If you want to keep the
emails, add the database.

1. On the project canvas, click **+ Create** (top right) — or just press
   `Cmd/Ctrl + K` and type "postgres".
2. Choose **Database** → **Add PostgreSQL**.
3. A `Postgres` service tile appears and provisions itself in a few seconds.

There is no migration step. The server creates the `wishlist` table on its
first write (`CREATE TABLE IF NOT EXISTS`), so there is nothing to run by hand.

---

## 3. Wire up the variables

Click your **robot-operator** service tile (not the Postgres one), then open
the **Variables** tab.

⚠️ Railway may offer to import variables it found in the repo's `.env.example`.
**Decline it**, or at least do not accept it blindly — that file is
documentation, and importing it wholesale sets empty keys you do not want.
Add the variables by hand as below.

### DATABASE_URL — the one that matters

Click **+ New Variable** and enter:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
```

That `${{Service.VAR}}` form is Railway's reference-variable syntax; it is
resolved at deploy time so the credentials never get copied into your service
config. `Postgres` must match the database service's name exactly, capital P
included. If you renamed the service, use the new name. The value field has an
autocomplete dropdown — start typing `${{` and let it fill the rest in, which
removes any chance of a typo.

This resolves to the **private** network URL (`postgres.railway.internal`),
which is what you want: it is free, it does not leave Railway's network, and
the server already knows to speak plaintext to `.railway.internal` hosts and
TLS to everything else.

### The optional API keys

Add these two only if you have them. Both are safe to add later.

```
OPENROUTER_API_KEY = sk-or-v1-...
ELEVENLABS_API_KEY = sk_...
```

If you have run `scripts/pickVoice.mjs` and cast a specific voice, also add:

```
ELEVENLABS_VOICE_ID = <the voice id from your local .env>
```

Consider clicking the 3-dot menu next to each key and choosing **Seal**. A
sealed value is still handed to the deploy but can never be read back out of
the UI or API. Note the trade-off before you do it: sealing is irreversible,
and sealed variables are not copied into PR environments or duplicated
services.

### Do NOT set PORT

Railway injects `PORT` itself, and it uses that same value when running the
healthcheck. The server already reads `process.env.PORT`. If you hardcode
`PORT=8790`, the app will listen on 8790, Railway will healthcheck a different
port, and the deploy will fail with "service unavailable" while the logs
cheerfully show a running server. This is the single most common way to lose
twenty minutes here.

### Apply the changes

Variable edits do not take effect immediately — they pile up as **staged
changes**. Click the **Deploy** button that appears at the top of the canvas
(it will say something like "Apply 1 change") to trigger a redeploy with the
new values.

---

## 4. Give it a public domain

1. Click the **robot-operator** service.
2. Open **Settings** → scroll to **Networking** → **Public Networking**.
3. Click **Generate Domain**.
4. When it asks which port to expose, leave the detected value alone if it
   offers one — the server listens on the injected `PORT`.

You get a `something.up.railway.app` URL with a working TLS certificate within
seconds. Do *not* generate a domain for the Postgres service; it should stay
private.

---

## 5. Verify it worked

Replace `<your-domain>` with the domain from the previous step.

**The health endpoint** — this is the fastest signal, and it tells you exactly
which optional features are live:

```bash
curl https://<your-domain>/api/health
```

Expect:

```json
{"ok":true,"llm":true,"tts":true,"db":true}
```

Read it like a checklist:

- `ok: true` — the server is up. This field is always `true` if you get a
  response at all.
- `llm` — `true` when `OPENROUTER_API_KEY` is set. `false` means the local
  fallback parser is doing the work. Not a failure, just a downgrade.
- `tts` — `true` when `ELEVENLABS_API_KEY` is set. `false` means captions only.
- `db` — `true` when `DATABASE_URL` is set. `false` means wishlist signups go
  to ephemeral disk. If you added Postgres and this is `false`, your reference
  variable did not resolve — check the service name in `${{Postgres.DATABASE_URL}}`.

**The game itself:**

```bash
curl -sI https://<your-domain>/
```

Expect `HTTP/2 200` and `content-type: text/html`. Then open the domain in a
browser and confirm the game actually boots — a 200 on `/` only proves the
static handler found `index.html`, not that the bundle loaded.

**The wishlist round-trip**, if you added the database:

```bash
curl -X POST https://<your-domain>/api/wishlist \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
```

Expect `{"ok":true,...,"stored":true}`. `stored:false` means it fell back to
disk — the endpoint deliberately never reports failure to the player, so
`stored` is the field that tells you the truth.

---

## When a build fails

Open the service, click the failing deployment, and read the **Build Logs**
tab. Deploy-time crashes are in **Deploy Logs** instead — they are separate
tabs and looking at the wrong one is a classic time sink.

The failures you are actually likely to hit, in rough order of likelihood:

**`tsx: not found` or `Cannot find module 'tsx'` on start.** The install step
did not produce `tsx`. It is declared under `dependencies`, so this should not
happen — check that the install actually ran against the workspace root and
that nobody moved `tsx` back into `devDependencies`.

**Healthcheck failed / "service unavailable" while the logs show a healthy
server.** You set `PORT` as a service variable. Delete it and redeploy.

**`ERR_PNPM_OUTDATED_LOCKFILE`.** Someone changed a `package.json` without
committing the regenerated `pnpm-lock.yaml`. Run `pnpm install` locally, commit
the lockfile, push. Do not "fix" this by loosening the install command; the
frozen lockfile is what makes the deploy reproducible.

**The build succeeds but every route returns the client, or `/api/*` 404s.**
Railpack has a static-site mode that can hijack a Vite project and serve it
without ever starting Node. The explicit `startCommand` in `railway.json`
disables that, so this should not happen — but if it does, set
`RAILPACK_NO_SPA=1` as a service variable to force it off.

**Build succeeds, page loads blank, console shows 404s for `/assets/*.js`.**
The client build did not land where the server looks for it. The server resolves
`client/dist` from its own file location, not from the working directory, so the
only real failure mode is the build not having run at all — confirm the build
logs show `vite build` writing to `dist/`, and that the boot line in the deploy
logs ends with `static=true` rather than `static=false`.

**Out of memory during build.** The Vite build is small (about 2 seconds and
~530 kB of JS locally), so this would be surprising. If it happens, it is
almost certainly the install step, not the build — check whether something new
pulled in a heavy dependency.

To reproduce any of this locally before blaming Railway, the exact production
path is two commands from the repo root:

```bash
pnpm build
PORT=8899 pnpm start
```

Then `curl http://localhost:8899/api/health`. This has been verified to work
and is the same code path Railway runs.

---

## After the first deploy

Every push to the deployed branch triggers a new build automatically. If you
want to stop that, it is under the service's **Settings** → **Source**.

Two things worth knowing later:

- **The `server/logs/` directory is ephemeral.** Gameplay telemetry
  (`/api/log`) and the no-database wishlist fallback both write there, and both
  vanish on redeploy. If you ever need those to survive, attach a Railway
  volume — but note that a service with a volume attached cannot do zero-downtime
  deploys.
- **The TTS disk cache is ephemeral too.** The server caches synthesised audio
  under `server/.cache/`, so the first player after each deploy re-pays the
  ElevenLabs cost for every line. Harmless, but it shows up on the bill if you
  redeploy constantly during a demo.
