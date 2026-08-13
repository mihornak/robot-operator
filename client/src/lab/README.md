# Graphics lab

A standalone page (`client/lab.html`) with one hand-dressed room and every
rendering knob on a slider. It exists to answer "what does this game look like
if the light does the work?" before any of it is proposed for the shipping
renderer.

    pnpm dev            # then open http://localhost:5173/lab.html

Nothing in `client/src/` imports this directory, so it cannot affect the game.
Imports flow one way — lab → `client/src/render/lit` — and never back. It ships
in the production build as a separate entry (`vite.config.ts`
`rollupOptions.input`) so the tuned look can be reviewed from a deployed URL.

**The renderer is not in here.** Everything that draws lives in
[`../render/lit/`](../render/lit/README.md): the pipeline, the lightmap, the
five rules the room was debugged into. Read that first — this directory is the
room, the sliders and the mouse.

| file | what |
|---|---|
| `level.ts` | the room: map, dressing, light rig, wet patches, hazard lane. Plain `LevelData` shapes. |
| `params.ts` | every tunable + slider schema + presets. The contract between UI and renderer. |
| `ui.ts` | the panel. Search, presets, A/B slots, copy-TS, localStorage. |
| `scene.ts` | the shell: builds a `SceneDef`, drives three characters, pushes `P` into `LitScene`. |
| `main.ts` | boot, post chain, letterbox, character dragging. |

`P` is a flat bag of a hundred values; `LitScene` wants three typed records.
`LabScene.pushParams` is where they meet, once a frame. The per-level keys go
through `updateLook`, the engine ones through `setEngine`, and the bisection
switches through `setDebug` — the lab is the one consumer allowed to move the
middle group, because it is where those numbers were tuned in the first place.

## Panel

`H` hide · `R` reset · `[` `]` cycle presets · `1` `2` capture into slot A / B ·
`\` flip between the two slots.

**Copy TS** is the one that closes the loop: it puts only the params that differ
from `DEFAULTS` on the clipboard, as pasteable TypeScript rounded to each
param's own step. Paste it into `DEFAULTS` in `params.ts` and the tuned look
becomes the new baseline. (Copy JSON dumps everything and is for archiving a
look, not for editing one.) The look half of `DEFAULTS` is mirrored by
`LOOK_DEFAULTS` / `ENGINE_DEFAULTS` in `render/lit/types.ts`, which is what a
level renders against — move both.

**A / B** exist because two lighting looks cannot be compared from memory —
capture, change, capture, then flip.

**Drag a character.** Grab the robot or an enemy with the mouse and drop it
anywhere — the fixed patrol loops are good for judging motion but useless for
"what does it look like THERE". Whoever is not being held keeps walking, and a
released character rejoins its loop at the nearest point. `Character → auto-walk`
stops the loops entirely; dragging still works.

There is no global key/fill/accent colour on the panel and there never was one
that worked: a light's colour is per-instance data on its `LightPlacement`,
which is what the renderer has always honoured. Recolour a look through ambient,
haze and the grade's lift/gain — or edit the rig in `level.ts`.

## Bisecting a visual artefact

`Layers` is one switch per draw pass; `Lightmap` is one switch per stage that
writes into the lightmap. Turn passes off one at a time until the artefact
disappears — the culprit is whatever you just switched. This is how all four
rules in the renderer's README were found, after several rounds of guessing
failed.

Neither group is persisted. A saved `layerWalls: false` would look exactly like
a rendering regression the next time the lab is opened, and a saved `paused`
looks exactly like a broken build.

Note the panel's search matches labels and keys, not group names — type
`footprints`, not `lightmap`.

## Fixtures

`Fixtures` (ceiling) and `Wall lights` each give you a target picker plus style,
size, housing opacity and lit-face; wall fixtures add mount height, light offset
and wall wash. Only the SPRITE changes — the light rig is never touched, so you
can strip every fixture to `none` and the room stays lit.

Picking a target loads that fixture's own settings back into the sliders, so you
are always editing what you are looking at. The sliders are one bag and the room
has fourteen fixtures; `LitScene` holds a `FixtureDef` per fixture and this
shell routes the bag to whichever one the picker is on.

Ceiling fixtures ship as `none` and the wall sconces carry the visible sourcing.
A ceiling lamp is the hardest object in a top-down room — hanging in the air,
no ground contact, no cast shadow, overlapping whatever walks under it — and the
honest answer turned out to be not drawing one. Wall fixtures have a surface the
camera can see, so they do the job instead. They mount only on SOUTH-FACING wall
faces; the left and right walls render as wall tops, so there is no face there to
mount on.
