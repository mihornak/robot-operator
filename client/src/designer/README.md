# The level designer

`pnpm dev`, then <http://localhost:5173/designer.html> (Vite's port — 5174 if
something else already has 5173). Draw a floor, check it, play it, save it.

It is a third Vite entry beside `index.html` and `lab.html`. Nothing in
`client/src/` imports `client/src/designer/`, so the game does not know it
exists — but the designer imports the game: the real `initArt`, the real
`WorldView`, the real `render/lit/LitScene`, the real `sim/*`. **What you see on
the canvas is the game rendering your level**, not a second drawing routine that
is free to drift. `tools/level-designer.html` is superseded; leave it alone.

## Two renderers, and which one you get

A level that carries any LIT data — decor, lights, fixtures, water, a look, tile
dressing — draws through `render/lit`, exactly as the game will draw it. A level
that carries none draws through `WorldView`, exactly as it always did. Nothing
switches this by hand: it is `hasLit(level)`, and it is the same question
`levelToFloorDef` asks on the way to the sim.

`L` cycles **lit → flat (classic) → lightmap**. The flat view is not nostalgia:
once a room is properly dark it is the only way to see the walkability grid you
are painting. The lightmap view is the lab's own bisection tool — through a
multiply, "this light is wrong" and "this material is wrong" look identical.

The lit scene renders at IDENTITY into its own 480×270 target and the editor's
camera pans and zooms that one sprite. This is not a detail:
`LitScene.setCamera` bumps the lightmap's geometry version and re-bakes every
light in the room, so a designer dragging the view would re-bake forty lamps a
frame. Overlays are drawn OUTSIDE that target, in screen space — inside it they
would be graded, fogged and multiplied by the very darkness they exist to
navigate.

Structural edits (a prop, a lamp, a wall, tile dressing) go through a debounced
`setScene`, which tears the room down and builds it again. Everything else takes
a cheap path that is safe every frame: the LOOK sliders through `updateLook`, a
lamp being dragged through the lightmap's own per-light bake, a fixture through
`setFixture`, a lamp being switched through `setLightState`. A drag therefore
lights the room WHILE it is being dragged, and the rebuild behind it picks up
what the cheap path cannot express (the volumetric haze is built, not driven).

Levels are DATA. A saved level is `client/src/levels/<id>.level.ts` — one
`LevelData` object literal, no logic — and `sim/levelLoader.ts` turns it into the
same `FloorDef` the hand-written floors are.

How a level joins `FLOORS` is the `replaces` row in the level inspector, and it
is the difference between a sketch and a floor of the game:

- **blank (the default)** — APPENDED after the built-ins, reached with
  `?floor=N` (1-based). It can never enter the shipping run, which ends at
  `FLOORS_IN_RUN` cleared. Draw freely; nothing you do here can break the game.
- **a number 1..6** — the level STANDS IN for that built-in floor. It is what
  the player plays, it boots the run if you take slot 1, and everything keyed to
  the floor NUMBER (the director's ceremonies, the chip triads) keeps pointing
  at the slot rather than at the room that used to fill it. Floor 1 is currently
  a level, not a built-in: `floor-1-copy.level.ts`.

A slot out of range, or one two levels claim, is a `pnpm test` failure — CHECKS
flags both while the level is still on screen. Taking the boss slot is a warning
rather than an error: the shredder, its music and the cliffhanger are keyed to
that floor and a level standing there inherits all of it with nothing to hang it
on.

## Shortcuts

| Key | Does |
| --- | --- |
| `V` | select — click a thing, drag to move it, drag empty floor for a region |
| `B` | wall brush (drag paints; right-drag or Alt paints the opposite) |
| `R` | wall rectangle |
| `G` | flood fill |
| `I` | eyedropper — samples a tile into the brush, then switches to `B` |
| `E` | place the selected asset |
| `T` | drag a trigger region |
| `N` | drop a sound emitter |
| `S` | set the robot spawn tile |
| `D` | place the selected prop — ¼-tile snap, hold `Alt` for free placement |
| `K` | place a light (`L` is taken by the preview toggle) |
| `W` | drag a wet-floor ellipse |
| `Y` | paint floor variants; `Alt` clears one |
| `1`–`9` | pick an asset (scrap, chip, crate, debris, cable, printer, mop, chair, fuse) |
| `F` | flip what the wall tools paint (wall ↔ floor) |
| `X` | grid on/off |
| `L` | preview: lit → flat (classic) → lightmap |
| `P` | playtest — press again or `Esc` to return |
| `Esc` | leave playtest, else clear the selection and region |
| `Del` / `Backspace` | delete the selection, or clear the region's tiles + entities |
| `Ctrl`+`Z` / `Ctrl`+`Y` | undo / redo |
| `Ctrl`+`C` / `Ctrl`+`V` | copy the region (tiles + entities) / paste at the cursor |
| `Ctrl`+`S` | save |
| wheel | zoom around the cursor |
| space-drag, middle-drag | pan |

Undo is a command stack, not snapshots. A drag re-runs itself through the store
(undo the provisional command, run a bigger one), so a hundred-tile brush stroke
is exactly ONE history entry and there is still only one place the draft is ever
written — `DraftStore.run`.

The draft autosaves to `localStorage` on every edit and is restored on load.
`forget draft` in the toolbar clears it.

## The save pipeline

1. **Save** `POST /__designer/save { level }` → a dev-only Vite plugin in
   `client/vite.config.ts` (`apply: 'serve'`) validates the slug and the 16×30
   map, writes `client/src/levels/<id>.level.ts`, and upserts one import line and
   one array entry into `client/src/levels/index.ts` between its
   `// designer:*` markers. Writing a source file makes Vite reload the page —
   the autosaved draft comes straight back, so this costs you nothing.
2. **Copy TS** puts the *byte-identical* file content on the clipboard. This is
   the fallback and it always works: paste it into `client/src/levels/` and add
   the two registry lines by hand.
3. In a **built bundle** there is no `/__designer/save` (rule 1: nothing that
   writes source may exist in the shipped bundle). The Save button detects that
   `GET /__designer/levels` does not answer and hides itself; Copy TS remains.

Built-in floors are TS builders and stay that way. Selecting one from the
dropdown loads a **copy** under its own id (`floor-6-copy`), so saving can never
overwrite `floors.ts`. The copy is lossy in one way worth knowing: built-ins
place entities on half tiles (`at(15, 7.5)`) and levels are tile-addressed, so a
duplicated entity can land up to half a tile off.

## Authoring a lit room

The left palette has three pages. **ENTITIES** is the v1 asset list. **DECOR** is
all 33 props from `render/lit/decor.ts`, thumbnailed by the same drawer that
paints them into the room — no icon set that is free to disagree with the game.
**LIGHTS** is five presets lifted straight out of the graphics lab's own rig
(tube, fill, cone, accent, strobe) plus the eight floor variants.

**A lamp is three records with one id.** `DecorPlacement.fixtureId` ==
`LightPlacement.id` == `FixtureDef.id`, and a wall lamp adds a fourth thing: the
`<id>_pt` wall wash that lights the fixture and the wall behind it (rule 2 in
`render/lit/README.md` — a cone lights the floor and nothing else). Placing a
`ceiling lamp` or a `wall lamp` from the DECOR page creates all of it wired, a
wall lamp snaps itself to the wall face under the cursor, and moving, renaming or
deleting any part of it moves, renames or deletes the rest as ONE undo entry.
That is what `litEdit.ts` is for, and it is the only place that knows the shape
of the link.

A selected light carries its handles in the room: drag the ring to resize the
pool, the dot on the aim to turn a cone, the two edge dots to open or close it.
The handles work whatever tool is active — aiming a lamp should not depend on
which button was last pressed.

**Wall mounts only work on a south-facing wall face** — a solid tile with open
floor under it. Every other wall in this projection renders as a wall TOP, and a
sconce bolted to one is a sprite lying on a ceiling. CHECKS says so in red.

**The LOOK tab is what a LEVEL owns**: ambience, fog, light gain, volumetrics,
wet floor, grade — plus the tile dressing (seed, hazard lanes, the count of
painted variants). Every control writes `level.look`, and only the keys that
actually moved are saved: `lookPatch` in `render/lit/types.ts` does that
reduction and is the ONLY serializer, so retuning the engine retunes every level
that never disagreed. The four presets are the lab's, minus the half of each one
that moved ENGINE numbers (bloom, vignette, chroma, grain) — those are the
renderer's, deliberately not per level. The `lens` toggle is preview-only and is
never saved: in the game the CRT stack puts those there, and while editing they
put grain over the pixel you are lining a prop up against.

**Triggers gained a `light` action** — target, on/off, optional intensity. It is
presentation, like `say`: it rides `trigger_fired` out to the director and the
renderer calls `setLightState`. The inspector's `fire it` button applies it to
the preview so you can watch the beat without wiring a playtest.

## How validation maps to the selftest

The CHECKS tab imports the checks from `client/src/sim/selftest.ts` and runs them
on the draft. It does not reimplement them — that is the whole point. If a level
is green here it is green under `pnpm test`, because it is the same function.

| Panel line | Comes from |
| --- | --- |
| malformed map | `checkMapParse` |
| entity spawns inside a wall | `checkEntitiesInWalls` |
| two entities share an id | `checkUniqueIds` |
| chip has no clearance | `checkChipClearance` |
| no route from spawn to X | `checkRoutable` (`findPath` at `ROBOT_R`) |
| wedged / cannot reach the spawn / cannot reach elevator B | `checkHostileFit` (each hostile at its own radius) |
| crate opens itself before the player sees it | `checkCrateDistance` |
| trigger rect off the map, wakes something that is not here | `checkTriggerDefs` |
| spawn point missing or in a wall | `spawnOf` + `solidAtPx` |

Amber warnings are the designer's own and are **not** build failures:

- **walkability law** — an `ENEMY_R = 9` fit field flooded from the spawn; any
  open tile no machine body can reach is a 1-tile passage. `checkHostileFit`
  only walks the hostiles a level happens to contain today; this is about the
  room, because the machine arrives in the next edit.
- **toddler-speak** — a `say` action over 7 words, with a comma or a clause, in
  the first person, or not upper case (CLAUDE.md rule 7).
- trigger with no actions, emitter with no radius, missing elevator, unknown
  sound name.

The lit half adds its own, and they are all the same class of problem: something
that will not LOOK like what it was authored to look like, and that is invisible
until the room is dark.

- **wall lamp not on a south-facing face** (error) — see above.
- **a broken three-way link** (error): decor claiming a fixture that has no
  `FixtureDef`, a fixture with no light, a fixture whose mount disagrees with its
  prop. The overlay also rings a broken lamp in red, in the room.
- **shadow-caster count over 12** (warning) — each one is a full-screen bake and
  the lab's whole room runs about ten.
- unknown prop name, unknown fixture style, duplicate lit id, a light with no
  radius or zero intensity, a cone with no aim, a wet patch off the map or with
  no size, a floor variant outside the 0-7 contract or under a wall, a hazard
  lane off the map.

A `light` action aimed at a light this level does not have is caught by
`checkTriggerDefs` in the SUITE, not here — the panel runs that function, and a
second line saying the same thing is how a checks panel stops being read.

Save refuses while any red line is up.

## Playtest

`P` builds a `FloorDef` from the draft, parks it in a scratch slot at the end of
`FLOORS`, and calls the real `initialState` / `loadFloor` / `step` at 60 Hz on
the ticker. The robot starts awake and briefed — you are testing the room, not
the floor-1 wake beat. Click a machine to attack it, a pickup to fetch it,
anything else to go to it, and bare floor to walk there (a marker entity is
dropped because `goto` needs a target entity; it is removed on arrival). Sound
emitters run through a designer-owned `AudioEngine`, fail-soft to silence.
**Nothing here ever calls TTS.** `Esc` returns to editing with the draft
untouched — including the lit scene, which a playtest may have left with a door
open and half the lamps killed.

A lit level playtests LIT: sim entities and the robot reach `LitScene` through
`updateActors` every stepped frame, so the bodies take the room's lighting, a
rim and a projected shadow. Of the presentation actions a trigger hands out,
this consumes two: `light` (→ `setLightState`, because the alarm beat IS a
lighting beat and watching it happen is the reason to press P) and `say` (→ the
caption line). `sfx`, `hum` and `shake` stay dropped — they belong to the game's
mixer and camera rig, and faking them here would be a second implementation of a
beat the designer cannot tune anyway. A `setTiles` door rebuilds the lit tiles
and occluders off the sim's own grid.

## Files

| File | Owns |
| --- | --- |
| `main.ts` | boot, layout, the frame camera, the render loop, the toolbar |
| `store.ts` | the draft, the command stack, autosave |
| `tools.ts` | pointer and keyboard, every drawing tool, copy/paste, the camera |
| `palette.ts` | the enum tables and the three asset pages |
| `inspector.ts` | the properties panel, including the trigger action editor |
| `look.ts` | the LOOK tab: every `LevelLook` key, the presets, tile dressing |
| `overlays.ts` | grid, trigger rects, emitter radii, spawn, selection, and the lit half |
| `validation.ts` | the selftest checks + the designer's own warnings |
| `playtest.ts` | the draft as a running game |
| `io.ts` | level list, load, save, Copy TS, import from paste |
| `ui.ts` | the widget kit and the page CSS |
| `litPreview.ts` | `LitScene` + the post chain, the debounce, the cheap paths |
| `litAssets.ts` | decor thumbnails and defaults, light presets, look presets |
| `litEdit.ts` | the multi-record edits: place / delete / move / rename a lamp |
| `litHandles.ts` | where a light's drag handles are (tools hit-test, overlays draw) |
| `litActors.ts` | sim entities → `ActorState` for the lit playtest |

Three tables here are deliberate near-copies rather than imports: kind → art name
(private in `render/world.ts`), the enum lists for `SfxName` / `EntityKind` /
`ChipId`, and the anchor/foot conversion in `litActors.ts` that the game
renderer also has to do. The first two are written as `Record<Enum, …>`, so
adding a member in `shared/types.ts` fails the build here rather than quietly
going missing from a dropdown. The third is four lines of arithmetic that must
not diverge — when `render/index.ts` settles on its own actor adapter, this
should become a call to that one.

## Serialization

`io.ts` writes the level through `cleanLevel`, which drops empty lit arrays and
lit keys the level never authored. That is load-bearing rather than tidy:
`levelToFloorDef` decides a level is lit by asking whether any of it is
non-empty, so a file carrying `"decor": []` is a file that claims to be a lit
level and renders as a black room. The store prunes as it goes and `cleanLevel`
is the second belt; between them, save → reload → load round-trips byte for
byte. Import accepts v1 files unchanged and never defaults the lit keys in —
their ABSENCE is what keeps an old level on the classic path.
