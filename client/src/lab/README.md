# Graphics lab

A second page (`client/lab.html`) with one hand-dressed room and every rendering
knob on a slider. It exists to answer "what does this game look like if the
light does the work?" before any of it is proposed for the shipping renderer.

    pnpm dev            # then open http://localhost:5173/lab.html

Nothing in `client/src/` imports this directory, so it cannot affect the game.
It ships in the production build as a separate entry (`vite.config.ts`
`rollupOptions.input`) so the tuned look can be reviewed from a deployed URL.

## What it deliberately breaks

`CLAUDE.md` rule: near-monochrome cold-gray palette, robot is the only saturated
thing. The lab ignores it. `lab/palette.ts` is a separate ramp with real colour
and real albedo values, and the room is lit in warm key / cool fill / cyan
accent. Everything else — bundle law, PixiJS v8 API, no runtime 3D — still
holds: no CDN, no remote assets, every pixel code-drawn.

## Pipeline

    litWorld   floor tiles                                    ×  lightmap
               ground shading  (AO · prop shadows · footprints)
               wet reflections
               shadows         (character silhouettes · contact patches)
               props · WALLS · characters   — one y-sorted layer
                 └ rim light + emissive faces ride inside each object
    volume     light shafts                                   +  additive
    fog        flat + gradient haze                           +  additive
    post       bloom → grade/lens → optional CRT              at 480×270

The post chain runs into an offscreen 480×270 target and the finished image is
upscaled. That is load-bearing: filters on a scaled container run in screen
space, which silently breaks the lightmap alignment and puts grain and
scanlines at monitor resolution.

`lighting.ts` bakes one texture per light with 2D shadow volumes punched into
it, cached until the light or a shadow parameter changes; flicker only changes
the blit alpha, so it is free.

## Four rules this room was debugged into

Each of these cost a session to find. They are all the same mistake in different
clothes: **the lightmap is sampled per screen pixel, and a sprite's pixels sit
above the ground position they belong to.**

**1. Ground shading goes on the ground, not in the light.** Ambient occlusion,
prop shadow volumes and occluder footprints are all *floor contact* effects.
Composed into the lightmap they darken everything standing in the room — and a
prop's foot rect is a hard rectangle slightly larger than its base, so a
character walking in front of a desk wore a translucent black box. They now draw
onto the tiles, beneath everything that stands up. Wall shadow volumes stay in
the lightmap: walls run floor to ceiling, so a body in a wall's shadow really is
in shadow.

**2. A light shaped to hit the floor misses everything on it.** A sconce's cone
lights a wedge of deck and nothing else, so the wall it is bolted to and the
props beside it stayed black. Every wall fixture carries a small round
*wall wash* alongside its cone for exactly this.

**3. Nothing may touch the edge of its own filter texture.** Pixi's blur samples
with edge clamping, so content reaching the border smears out to that border —
a faint dark rectangle, invisible on dark floor and obvious over anything lit.
`BlurFilter.padding` cannot fix it (pixi recomputes it from `strength`). The
character shadows carry a zero-alpha spacer sprite to inflate their bounds;
the ground pass gets away with it because its background is white, and clamping
white is a no-op.

**4. Overlapping shadow quads can only be drawn at alpha 1.** Any partial alpha
double-blends along every seam. Partial darkness is therefore built out of
full-strength stencils interleaved with additive light passes — see `bake()`.
The alphas sum to 1, which keeps lit floor at exactly the falloff curve however
many bands the distance-fade uses.

## Files

| file | what |
|---|---|
| `params.ts` | every tunable + slider schema + presets. The contract between UI and renderer. |
| `ui.ts` | the panel. Search, presets, A/B slots, copy-TS, localStorage. |
| `palette.ts` | lab ramp. Albedo values, not display values — see the comment. |
| `labTiles.ts` | floor / wall / ceiling tiles. |
| `decor.ts` | 33 code-drawn props, a third of them emissive. |
| `fixtures.ts` | swappable ceiling and wall light fixtures, 5 styles each. |
| `level.ts` | the room: map, dressing, light rig, wet patches. |
| `lighting.ts` | lightmap, shadow volumes, AO, prop ground shadows. |
| `filters.ts` | lightmap multiply + the one-pass grade/lens shader. |
| `scene.ts` | the scene graph and per-frame update. |
| `main.ts` | boot, post chain, letterbox, character dragging. |

## Panel

`H` hide · `R` reset · `[` `]` cycle presets · `1` `2` capture into slot A / B ·
`\` flip between the two slots.

**Copy TS** is the one that closes the loop: it puts only the params that differ
from `DEFAULTS` on the clipboard, as pasteable TypeScript rounded to each
param's own step. Paste it into `DEFAULTS` in `params.ts` and the tuned look
becomes the new baseline. (Copy JSON dumps everything and is for archiving a
look, not for editing one.)

**A / B** exist because two lighting looks cannot be compared from memory —
capture, change, capture, then flip.

**Drag a character.** Grab the robot or an enemy with the mouse and drop it
anywhere — the fixed patrol loops are good for judging motion but useless for
"what does it look like THERE". Whoever is not being held keeps walking, and a
released character rejoins its loop at the nearest point. `Character → auto-walk`
stops the loops entirely; dragging still works.

## Bisecting a visual artefact

`Layers` is one switch per draw pass; `Lightmap` is one switch per stage that
writes into the lightmap. Turn passes off one at a time until the artefact
disappears — the culprit is whatever you just switched. This is how all four
rules above were found, after several rounds of guessing failed.

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
are always editing what you are looking at.

Ceiling fixtures ship as `none` and the wall sconces carry the visible sourcing.
A ceiling lamp is the hardest object in a top-down room — hanging in the air,
no ground contact, no cast shadow, overlapping whatever walks under it — and the
honest answer turned out to be not drawing one. Wall fixtures have a surface the
camera can see, so they do the job instead. They mount only on SOUTH-FACING wall
faces; the left and right walls render as wall tops, so there is no face there to
mount on.
