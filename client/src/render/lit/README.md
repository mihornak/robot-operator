# The lit renderer

A deferred 2D lighting stack: real shadow casting, code-drawn decor, swappable
light fixtures, wet floors, volumetrics and a one-pass grade. `LitScene` takes a
`SceneDef` — a room's map, dressing, light rig and look, all plain data — and
draws it. Nothing in here knows where that data came from, which is what lets
the same code serve the graphics lab (`client/src/lab/`, hand-written
constants), the level designer's preview, and an authored level in game.

## What it deliberately breaks

The classic renderer's palette law: near-monochrome cold-gray, robot is the only
saturated thing. This one ignores it. `palette.ts` is a separate ramp with real
colour and real albedo values, and a room is lit in warm key / cool fill / cyan
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

The scene's own camera is IDENTITY and should stay there. Every `setCamera` call
bumps the lightmap's geometry version, which re-bakes every light in the room —
pan and zoom belong on the composed output sprite, not in here. The lab uses it
for idle drift and shake, which move by pixels and rarely.

## Five rules this renderer was debugged into

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
in shadow. `setOccluders` therefore takes WALLS ONLY, everywhere, including
after a reseed.

**2. A light shaped to hit the floor misses everything on it.** A sconce's cone
lights a wedge of deck and nothing else, so the wall it is bolted to and the
props beside it stayed black. Every wall fixture carries a small round
*wall wash* alongside its cone for exactly this — the `<id>_pt` light, whose
radius is the fixture's `spill`.

**3. Nothing may touch the edge of its own filter texture.** Pixi's blur samples
with edge clamping, so content reaching the border smears out to that border —
a faint dark rectangle, invisible on dark floor and obvious over anything lit.
`BlurFilter.padding` cannot fix it (pixi recomputes it from `strength`). The
character shadows carry a zero-alpha spacer sprite to inflate their bounds;
the ground pass gets away with it because its background is white, and clamping
white is a no-op.

The same rule has a second half, learned later: **what a filter MEASURES matters
as much as what it draws.** An invisible child still reaches the bounds the
filter system reads, so a spare body-shadow rig — one allocated but with no
light behind it this frame — sitting untransformed at the world origin dragged
the whole shadow layer's extent into the corner of the room and moved every
blurred edge in it. Spare rigs are parked on top of the strongest live one,
where their bounds are a subset of one already there. Un-parenting them instead
is tempting and wrong: re-appending reorders the layer, and a reordered stack of
alpha blits rounds differently in the last bit.

**4. Overlapping shadow quads can only be drawn at alpha 1.** Any partial alpha
double-blends along every seam. Partial darkness is therefore built out of
full-strength stencils interleaved with additive light passes — see `bake()`.
The alphas sum to 1, which keeps lit floor at exactly the falloff curve however
many bands the distance-fade uses.

**5. A mask texture is repainted, never replaced.** `markTilesDirty` rebuilds
the floor mask, and building a fresh `Sprite` over a destroyed one crashed the
very next frame inside pixi's alpha-mask pipe: it caches a bind group per masked
container, and the texture in that cache had just been freed. `maskTexture`
therefore creates each mask once and redraws into it. Same family as rule 3 —
the renderer holds references you did not write down.

## Files

| file | what |
|---|---|
| `types.ts` | `SceneDef`, `LevelLook` defaults, engine defaults, debug switches, the actor contract. |
| `palette.ts` | the ramp. Albedo values, not display values — see the comment. |
| `litTiles.ts` | floor / wall / ceiling tiles. The floor variant indices are a contract. |
| `decor.ts` | 33 code-drawn props, a third of them emissive. Names live in `shared/types.ts`. |
| `fixtures.ts` | swappable ceiling and wall light fixtures, 5 styles each. |
| `lighting.ts` | lightmap, shadow volumes, AO, prop ground shadows. |
| `filters.ts` | lightmap multiply + the one-pass grade/lens shader. |
| `scene.ts` | `LitScene`: the scene graph, the per-frame update, the actor rig. |

The game mounts all of this through `client/src/render/litWorld.ts`, which is
the adapter from a running sim — entities, robot, events — to `SceneDef` and
`updateActors`. It composes into its own 480×270 target and hands the CRT stack
a sprite, so the grade runs here and the glass still belongs to `render/crt.ts`.

## Three tiers of tuning, and why

`SceneDef.look` (a resolved `LevelLook`) is what a LEVEL owns: ambience, fog,
gain, volumetrics, wet floor, grade. `EngineLook` is what the RENDERER owns:
shadow shape, AO, rim, sprite shadows, bloom, lens. The split is not arbitrary —
a level that disagreed with the engine numbers would be a level that looks like
it came out of a different game. `LitDebug` is one switch per draw pass, for
bisecting an artefact; none of it is ever persisted, because a saved
`layerWalls: false` looks exactly like a rendering regression the next time the
page is opened.

## Bisecting a visual artefact

Turn passes off one at a time until the artefact disappears — the culprit is
whatever you just switched. This is how the first four rules above were
found, after several rounds of guessing failed. The graphics lab exposes every one of these
switches on the panel; see `client/src/lab/README.md`.

One caveat if you are comparing screenshots: the blurred bottom edge of the
character sprite-shadows is not bit-reproducible across browser contexts. Two
tabs running the same build differ there by about thirty pixels at one to three
units of one channel, on a single scanline. That is the noise floor of any
pixel comparison of this renderer, and it is not a regression.
