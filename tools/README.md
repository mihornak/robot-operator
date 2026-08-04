# Level designer

`level-designer.html` — draw a floor, check it is playable, paste it back.

Open it by double-clicking the file, or serve the folder if your browser is
strict about `file://`:

```
python3 -m http.server 8791 --directory tools
# then open localhost:8791/level-designer.html
```

It is a single self-contained page: no build, no server, no network, no fonts,
no assets. Same rule as the game itself (CLAUDE.md rule 1).

## Workflow

1. **LOAD** a preset to start from an existing floor, or **NEW** for a blank room.
2. Paint with tools `1 WALL` / `2 FLOOR`. Shift-drag fills a rectangle.
   Right-click erases to floor, or deletes the entity under the cursor.
3. Place things from the **Entities** palette. `3 SELECT` then click an entity to
   rename it, set its chip, set printer hp, or mark elevator B dark. `4 SPAWN`
   moves the robot's start tile (only floor 1 overrides this; every other floor
   starts at elevator A, and "Clear spawn override" puts it back).
4. Watch **Validation**. It has to say `PLAYABLE — ALL CHECKS PASS` before the
   floor is worth sending on. Rules are listed below.
5. Use **Route preview** (`5 ROUTE A` / `6 ROUTE B`, or the snap dropdowns) to
   draw the path the robot will actually walk — same A*, same corner-cutting ban,
   same string-pulling as the game. `ENEMY R=9` re-runs it at enemy width.
6. **COPY** the export box and paste it to the engineer, or straight into the
   `FLOORS` array in `client/src/sim/floors.ts`.

## Seeing that a two-route floor really has two routes

The route preview is the point. A floor with two ways round is only a choice if
both routes really exist. Two ways to check:

- **ALL ROUTES** (header toggle) ghosts the route from spawn to every entity at
  once, so a floor where everything funnels through one door is obvious.
- Set A and B to the two elevators, then temporarily wall up one door. If the
  route survives, that door was never load-bearing. Undo with <kbd>Ctrl/Cmd Z</kbd>.

**ENEMY FIT R9** shades every point a printer's body can physically stand. This
is the check that catches the classic mistake: the robot (r=7) fits through any
non-wall tile, so a 1-tile corridor looks fine and plays fine right up until the
printer that is supposed to chase you through it cannot fit. Passages an enemy
must use have to be ≥2 tiles wide — the walkability law at the top of `floors.ts`.

## What validation actually checks

Mirrors `client/src/sim/selftest.ts`, so a floor that passes here passes the build:

| Check | Level |
|---|---|
| map is exactly 30×16 | error |
| exactly one elevator A and one elevator B | error |
| elevators keep the ids `elevA` / `elevB` (the director looks them up by name) | error |
| ids unique, present, and plain identifiers | error / warn |
| nothing placed inside a wall | error |
| robot does not spawn inside a wall | error |
| every chip has robot clearance — the r=7, ±8px test from `chipsReachable()` | error |
| a route exists from spawn to every non-decor entity (`floorsRoutable()`; skips debris, cable, elevator A) | error |
| every fused printer's r=9 body fits where it spawns | error |
| every fused printer can reach the robot spawn at r=9 | error |
| every fused printer can reach elevator B at r=9 | warn |
| chip has no chip type set | error |
| entity carries a custom label (exports as a spread override) | warn |

Reachability is computed without the hazard-avoidance penalty the sim can pass to
`findPath`. That penalty changes which route the robot *prefers* ("avoid the
sparks"), never which places it *can* get to, so it does not affect these checks.

## Export format

The export box emits exactly the shape of the entries in `client/src/sim/floors.ts`
— the same builder helpers (`elevA`, `elevB`, `scrap`, `chip`, `crate`,
`triadCrate`, `brainCrate`, `printer`, `innocent`, `mop`, `fuse`, `socket`,
`cable`, `debris`) and the same `at(tx, ty)` coordinates. Paste it into the
`FLOORS` array with zero editing. Real output, floor 5:

```ts
  {
    map: [
      '##############################',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#...........######...........#',
      '#................#...........#',
      '#................#...........#',
      '#...........######...........#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '##############################',
    ],
    entities: () => [
      elevA(at(2, 8)),
      elevB(at(27, 8), true),
      triadCrate(at(14.5, 7.5)),
      scrap('scrap1', at(7, 3)),
      scrap('scrap2', at(22, 12)),
    ],
  },
```

Details worth knowing:

- Elevator A and B are emitted first; everything else keeps placement order.
- `spawn: at(tx, ty)` is emitted only when you set an explicit spawn.
- Crates map to a builder by id: `crate_BRAIN` → `brainCrate()`, `crate_triad` →
  `triadCrate()`, anything else → `crate(id, at, chip?)`. The **pinned crate ids**
  buttons in the inspector set those for you.
- Elevator B's DARK toggle emits `elevB(at(…), true)` — the exit that needs the
  fuse or the triad before it lights.
- Tile coordinates may be fractional (`at(14.5, 7.5)` centres a thing on a tile
  seam). Alt-drag or the tx/ty boxes give you half-tile steps.
- If you give an entity a label the builder would not produce, it exports as
  `{ ...scrap('scrap1', at(3, 4)), label: 'your text' }`. Valid TypeScript and
  still zero-edit, but off-convention — validation flags it.

## Import

The **Import** box takes a whole `FloorDef` object literal (comments and all),
an entities-only block, or just 16 bare lines of `#` and `.`. It is deliberately
forgiving and tells you what it could not read rather than failing silently —
wrong row count, wrong row width, unrecognised builder calls, duplicate ids.

**SELF-TEST** (header) round-trips all five presets through import → export →
import → export and checks the result is stable and validates clean. If you ever
suspect the tool is mangling something, press it first.

## Keys

| | |
|---|---|
| `1`…`6` | wall / floor / select / spawn / route A / route B |
| <kbd>Esc</kbd> | back to Select, clear selection |
| <kbd>Del</kbd> / <kbd>Backspace</kbd> | delete selected entity |
| arrows | nudge selected entity one tile (<kbd>Alt</kbd> = half tile) |
| <kbd>Ctrl/Cmd Z</kbd> | undo |
| right-click | erase to floor, or delete entity under cursor |

## Caveat

The bundled presets were transcribed mechanically from `client/src/sim/floors.ts`
and verified byte-identical to it, but they are a snapshot. If a floor has changed
since, paste the current `FloorDef` from `floors.ts` into the **Import** box
instead of trusting the preset.

The pinned entity ids the director depends on are listed in the tool itself
(**PINNED IDS** panel) and enforced by `client/src/sim/selftest.ts`. Renaming
`crate_EARS`, `fuse1`, `socket1` and friends fails the build.

After pasting a new floor into the repo, run `pnpm test` (typecheck + the
determinism selftest + the fuzz sweep). The fuzz sweep walks random routes across
the floor and catches anything unreachable that got past the eyeball.
