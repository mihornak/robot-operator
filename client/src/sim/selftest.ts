/**
 * Determinism selftest: two scripted 600-tick runs from seed 42 must produce
 * bit-identical JSON state every tick. Also sanity-checks floor maps and the
 * pinned entity ids the director depends on.
 */
import type { Entity, SimState, Vec } from '../../../shared/types';
import { TILE, TILES_X, TILES_Y } from '../../../shared/types';
import { ALL_TALK_LINES, smallTalk } from '../../../shared/smallTalk';
import type { FloorDef } from './floors';
import { FLOORS, REPLACEMENT_ERRORS, buildSolid, isReplacedFloor } from './floors';
import {
  addAvoid,
  applyBrain,
  applyChip,
  applyDirectives,
  clearBriefing,
  initialState,
  loadFloor,
  setOrder,
  step,
  wakeRobot,
} from './index';
import { findPath } from './pathfind';
import { dist, isSolidTile, solidAtPx } from './physics';
import { CRATE_NOTICE, HOSTILE_KINDS, ROBOT_R, radiusOf, wakeMachine } from './internal';
import { MAX_ADDS, SPAWN_CLEAR_ROBOT, SPAWN_EVERY } from './boss';

const TICKS = 600;

/** Indexed by floor. Moves with the running order in floors.ts. */
const PINNED_IDS: string[][] = [
  ['elevA', 'elevB', 'pile1', 'pile2', 'scrap1'], // 1 opening
  ['elevA', 'elevB', 'chip_memory'], // 2 memory chip — deliberately nothing else
  ['elevA', 'elevB', 'cable1', 'cable2', 'scrap1', 'scrap2'], // 3 movement
  ['elevA', 'elevB', 'crate_BRAIN', 'printer1', 'cable1', 'mop1'], // 4 gauntlet
  ['elevA', 'elevB', 'fuse1', 'socket1', 'printer1', 'printer2', 'printer3', 'printer_nice', 'cable1'], // 5 fuse run
  // 6 boss arena. This row is not optional: runSelftest indexes PINNED_IDS by
  // floor, so a floor appended without one crashes the suite on undefined
  // rather than reporting anything a reader could act on.
  // The four corner printers are GONE: the shredder prints its own adds now
  // (`bossAdd` in floors.ts, SPAWN_EVERY in boss.ts), so there is nothing
  // authored here to pin. Their ids were `printer1`..`printer4`; the spawned
  // ones are `add_<n>` and belong to the fight, not to the floor.
  ['elevA', 'elevB', 'boss1', 'crate_ROCKET', 'chair1'],
];

/**
 * Ids `PINNED_IDS` has no row for — every designer level appended after the
 * built-ins. Those floors are authored in a browser, not pinned by hand, so
 * what is checked is the contract the director actually needs: the elevators
 * exist. Without this the suite crashes on `undefined` for any appended floor
 * instead of reporting something a reader could act on.
 *
 * A REPLACED slot (`meta.replaces`) takes the same derived treatment even
 * though PINNED_IDS has a row for it. The row describes the built-in that USED
 * to stand there — asserting `chip_memory` against a level someone drew in the
 * designer is asserting that the replacement is a copy of the thing it replaced,
 * which is the one thing it is guaranteed not to be.
 */
function pinnedFor(floorIndex: number, ents: readonly Entity[]): readonly string[] {
  const row = isReplacedFloor(floorIndex) ? undefined : PINNED_IDS[floorIndex];
  return (
    row ?? ents.filter((e) => e.kind === 'elevatorA' || e.kind === 'elevatorB').map((e) => e.id)
  );
}

/** Where the robot starts this floor — elevator A unless the floor says otherwise. */
export function spawnOf(def: FloorDef, ents: readonly Entity[]): Vec | null {
  return def.spawn ?? ents.find((e) => e.kind === 'elevatorA')?.pos ?? null;
}

/** The ASCII map parses into a grid at all. Returns the parse error as text. */
export function checkMapParse(map: string[]): string | null {
  try {
    buildSolid(map);
    return null;
  } catch (err) {
    return `map is malformed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function checkEntitiesInWalls(solid: boolean[][], ents: readonly Entity[]): string | null {
  for (const e of ents) {
    if (solidAtPx(solid, e.pos.x, e.pos.y)) return `entity '${e.id}' spawns inside a wall`;
  }
  return null;
}

/** Ids are how the director, the parser and every order name a thing. Two
 *  entities sharing one means half the floor is addressing the other. */
export function checkUniqueIds(ents: readonly Entity[]): string | null {
  const ids = new Set<string>();
  for (const e of ents) {
    if (ids.has(e.id)) return `two entities share the id '${e.id}'`;
    ids.add(e.id);
  }
  return null;
}

/**
 * Authored triggers point at things that exist and cover ground that exists.
 * A trigger whose rect is off the map or whose `wake` names a deleted machine
 * is not an error at runtime — it is a beat that silently never happens.
 */
export function checkTriggerDefs(def: FloorDef, ents: readonly Entity[]): string | null {
  const ids = new Set(ents.map((e) => e.id));
  const lightIds = new Set((def.lit?.lights ?? []).map((l) => l.id));
  const seen = new Set<string>();
  for (const t of def.triggers ?? []) {
    if (seen.has(t.id)) return `two triggers share the id '${t.id}'`;
    seen.add(t.id);
    const { tx, ty, tw, th } = t.rect;
    if (tw <= 0 || th <= 0) return `trigger '${t.id}' has an empty rect`;
    if (tx < 0 || ty < 0 || tx + tw > TILES_X || ty + th > TILES_Y) {
      return `trigger '${t.id}' has a rect outside the map`;
    }
    for (const a of t.actions) {
      if ((a.type === 'wake' || a.type === 'power') && !ids.has(a.target)) {
        return `trigger '${t.id}' ${a.type}s '${a.target}', which is not on this floor`;
      }
      if (a.type === 'light' && !lightIds.has(a.target)) {
        return `trigger '${t.id}' drives light '${a.target}', which is not on this floor`;
      }
      if (a.type === 'setTiles') {
        for (const c of a.tiles) {
          if (c.tx < 0 || c.ty < 0 || c.tx >= TILES_X || c.ty >= TILES_Y) {
            return `trigger '${t.id}' sets a tile outside the map`;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Every per-floor check, in the order that gives the most useful first failure.
 * The designer's validation panel calls the pieces individually; the suite
 * calls this. One implementation either way — a browser tool stricter (or
 * laxer) than the build is a tool that lies.
 */
export function checkFloor(def: FloorDef): string | null {
  const parseFail = checkMapParse(def.map);
  if (parseFail) return parseFail;
  const solid = buildSolid(def.map);
  const ents = def.entities();
  const spawn = spawnOf(def, ents);
  if (!spawn) return 'has no spawn point';
  if (solidAtPx(solid, spawn.x, spawn.y)) return 'spawns the robot inside a wall';
  return (
    checkEntitiesInWalls(solid, ents) ??
    checkUniqueIds(ents) ??
    checkChipClearance(solid, ents) ??
    checkRoutable(solid, spawn, ents) ??
    checkHostileFit(solid, spawn, ents) ??
    checkCrateDistance(spawn, ents) ??
    checkTriggerDefs(def, ents)
  );
}

/** Floor INDICES the behaviour tests reach for by name, so a reshuffle of the
 *  running order is a one-line edit here instead of a hunt through the file.
 *  The boss floor is appended at index 5, which is why these all still hold. */
const FLOOR_ISLAND_I = 1; // the island that blocks the straight A→B line
const FLOOR_MOVEMENT_I = 2; // two doors, one wired
const FLOOR_GAUNTLET_I = 3; // roaming printer, open colonnade
const FLOOR_MACHINE_I = 4; // three machines and the fuse run
const FLOOR_BOSS_I = 5; // the shredder arena
/** Floors the shipping run actually plays. Index 5 is the trailer-only boss
 *  arena, reached by `?floor=6` and never by clearing floor 5. */
const AUTHORED_FLOORS = 5;

/** Scripted order sequence — exercises movement, nudges, chips, combat, rng, floor load. */
function script(t: number, s: SimState): void {
  switch (t) {
    case 1:
      // The robot starts asleep in the floor-1 pile; nothing runs until the
      // player's voice wakes it. Every scripted run must do this first.
      wakeRobot(s);
      clearBriefing(s); // the scripted run stands in for a briefed operator
      setOrder(s, { kind: 'move', dir: 'right' });
      break;
    case 60:
      // nudge: must halt + emit order_done after ~20px, well before t=100
      setOrder(s, { kind: 'move', dir: 'down', distancePx: 20 });
      break;
    case 100:
      setOrder(s, { kind: 'move', dir: 'up' });
      break;
    case 140:
      applyChip(s, 'SCARED');
      break;
    case 150:
      s.robot.tier = 1;
      setOrder(s, { kind: 'goto', targetId: 'scrap1' });
      break;
    case 230:
      setOrder(s, { kind: 'shoot' });
      break;
    case 260:
      // The scripted run needs a floor with a printer, a cable and scrap2 on
      // it — that is the first-machine floor wherever it currently sits.
      loadFloor(s, FLOOR_MACHINE_I);
      setOrder(s, { kind: 'attack', targetId: 'printer1' });
      break;
    case 470:
      applyChip(s, 'RAGE');
      setOrder(s, { kind: 'move', dir: 'left' });
      break;
    case 520:
      setOrder(s, { kind: 'goto', targetId: 'elevB' });
      break;
    case 540:
      // hide picks cover (LOS raycast) and paths to it; avoid steers wide.
      applyBrain(s);
      addAvoid(s, 'cable1');
      setOrder(s, { kind: 'hide' });
      break;
    case 555:
      // Standing rules change how every later order is executed — they have to
      // be in the deterministic run, not just in the director.
      applyDirectives(s, ['avoid_enemies', 'careful']);
      setOrder(s, { kind: 'retreat' });
      break;
    case 570:
      applyDirectives(s, ['fight_enemies', 'no_gather']);
      setOrder(s, { kind: 'goto', targetId: 'fuse1', careful: true });
      break;
    case 585:
      // explore consumes the seeded rng on wander legs — the run must stay
      // bit-identical with it in the mix.
      setOrder(s, { kind: 'explore' });
      break;
  }
}

/**
 * Every floor must be WALKABLE end to end. Straight-line seeking used to hide
 * this: a robot that shoves at a wall for four seconds looks stuck either way.
 * With real routing, an unreachable exit is a soft-locked floor, so it is a
 * build failure now.
 */
export function checkRoutable(
  solid: boolean[][],
  spawn: Vec,
  ents: readonly Entity[],
): string | null {
  for (const e of ents) {
    // Decor and hazards may sit anywhere; anything the robot is expected to
    // reach must have a route from where it starts the floor.
    if (e.kind === 'debris' || e.kind === 'cable' || e.kind === 'elevatorA') continue;
    if (findPath(solid, spawn, e.pos, ROBOT_R).length === 0) {
      return `has no route from spawn to '${e.id}'`;
    }
  }
  return null;
}

/**
 * A floor whose only chip can't be walked into is a dead reward. Verify each
 * chip sits on open floor with room for the robot's r=7 body around it.
 */
export function checkChipClearance(solid: boolean[][], ents: readonly Entity[]): string | null {
  for (const e of ents) {
    if (e.kind !== 'chip') continue;
    for (const [dx, dy] of [[0, 0], [-8, 0], [8, 0], [0, -8], [0, 8]] as const) {
      if (solidAtPx(solid, e.pos.x + dx, e.pos.y + dy)) {
        return `chip '${e.id}' has no clearance at (${dx},${dy})`;
      }
    }
  }
  return null;
}

/**
 * The headline claim: ordered somewhere on the far side of an obstacle, the
 * robot ARRIVES. The island floor's centre island sits squarely across the
 * straight line from elevator A to elevator B, so the old "seek and slide
 * along the wall" robot parked against it forever. If this ever regresses, the game is
 * back to being a car that steers into masonry.
 */
function routesAroundObstacles(): string | null {
  const s = initialState(11);
  wakeRobot(s);
  loadFloor(s, FLOOR_ISLAND_I);
  const goal = s.entities.find((e) => e.id === 'elevB')!;
  // Cut the power: a lit exit ends the floor at ELEV_REACH, which is further
  // out than the arrival radius this measures. We want the walk, not the ride.
  goal.state = 'dark';
  setOrder(s, { kind: 'goto', targetId: goal.id });
  for (let t = 0; t < 900; t++) {
    step(s);
    if (dist(s.robot.pos, goal.pos) <= 16) {
      return null;
    }
  }
  return `FAIL: robot never reached elevB around the island (stopped at ${Math.round(s.robot.pos.x)},${Math.round(s.robot.pos.y)}, ${Math.round(dist(s.robot.pos, goal.pos))}px short)`;
}

/**
 * Initiative has THREE settings and the middle one is the default. Left alone,
 * the robot stays where it is and ASKS — it does not run the level for you.
 * Only a spoken "do your own thing" sends it wandering, and "wait for me"
 * shuts even the asking up. Getting this ladder wrong in either direction is
 * what makes the robot feel either dead or out of control.
 */
function actsOnItsOwn(): string | null {
  // Default: reactive only. It must not wander off — but it must speak up.
  const quiet = initialState(23);
  wakeRobot(quiet);
  const quietStart = { x: quiet.robot.pos.x, y: quiet.robot.pos.y };
  let asked = false;
  for (let t = 0; t < 600; t++) {
    step(quiet);
    if (quiet.events.some((e) => e.type === 'need_orders')) asked = true;
  }
  if (dist(quiet.robot.pos, quietStart) > 24) {
    return 'FAIL: robot wandered off unprompted with roam off';
  }
  if (!asked) return 'FAIL: idle robot never asked the operator for a job';

  // "do your own thing": now it goes looking, and marks the order as its own.
  const free = initialState(23);
  wakeRobot(free);
  applyDirectives(free, ['act_alone']);
  clearBriefing(free);
  const freeStart = { x: free.robot.pos.x, y: free.robot.pos.y };
  let announced = false;
  for (let t = 0; t < 400; t++) {
    step(free);
    if (free.events.some((e) => e.type === 'self_order')) announced = true;
  }
  if (!announced) return 'FAIL: roaming robot never chose a task of its own (no self_order)';
  if (!free.robot.selfDriven) return 'FAIL: robot acted but never marked the order self-driven';
  if (dist(free.robot.pos, freeStart) < 8) return 'FAIL: roaming robot never went anywhere';

  // "wait for me": no wandering AND no nagging.
  const held = initialState(23);
  wakeRobot(held);
  applyDirectives(held, ['wait_for_orders']);
  const heldStart = { x: held.robot.pos.x, y: held.robot.pos.y };
  for (let t = 0; t < 600; t++) {
    step(held);
    if (held.events.some((e) => e.type === 'need_orders')) {
      return 'FAIL: robot asked for orders under a standing "wait for orders" rule';
    }
  }
  if (dist(held.robot.pos, heldStart) > 1) {
    return 'FAIL: robot moved under a standing "wait for orders" rule';
  }
  return null;
}

/**
 * Every floor opens on a briefing. Even a robot that has been told to roam
 * holds at the doors of a NEW floor until it is spoken to — walking out of the
 * lift already busy is how floor 2 used to start wandering off on its own.
 */
function holdsAtEveryFloor(): string | null {
  const s = initialState(31);
  wakeRobot(s);
  applyDirectives(s, ['act_alone']);
  clearBriefing(s);
  loadFloor(s, 1); // rode the lift up: new floor, new briefing
  if (!s.robot.awaitingBriefing) return 'FAIL: new floor did not re-arm the briefing hold';
  // The director parks the robot immediately after a floor loads. Clearing an
  // order is not being briefed, and must not cancel the hold it just armed.
  setOrder(s, null);
  if (!s.robot.awaitingBriefing) return 'FAIL: setOrder(null) cancelled the briefing hold';
  if (s.robot.standing.roam) return 'FAIL: "do your own thing" leaked across a floor change';
  const start = { x: s.robot.pos.x, y: s.robot.pos.y };
  for (let t = 0; t < 600; t++) step(s);
  if (dist(s.robot.pos, start) > 4) return 'FAIL: robot left the lift doors before being briefed';
  // ...and one word from the operator releases it.
  applyDirectives(s, ['act_alone']);
  clearBriefing(s);
  for (let t = 0; t < 400; t++) step(s);
  if (dist(s.robot.pos, start) < 8) return 'FAIL: robot stayed frozen after being briefed';
  return null;
}

/**
 * Seeing a machine is a REPORT, not a charge. The robot calls it out and holds
 * for instructions; only an explicit "fight everything" sends it in. This is
 * the difference between a companion and a runaway.
 */
function reportsThreatsInsteadOfCharging(): string | null {
  const s = initialState(37);
  wakeRobot(s);
  loadFloor(s, FLOOR_GAUNTLET_I); // a roaming printer in an open colonnade
  clearBriefing(s);
  const printer = s.entities.find((e) => e.id === 'printer1')!;
  // Place it in clear view but OUTSIDE the printer's notice range, so the
  // machine stays idle: this measures what the robot decides unprovoked, not
  // whether it defends itself (it does, and that is a different test).
  s.robot.pos = { x: printer.pos.x + 125, y: printer.pos.y };
  let called = false;
  for (let t = 0; t < 60; t++) {
    step(s);
    if (s.events.some((e) => e.type === 'threat_seen')) called = true;
    if (s.robot.order?.kind === 'attack') {
      return 'FAIL: robot charged a machine unprompted (should hold and report)';
    }
  }
  if (!called) return 'FAIL: robot never reported the machine it could plainly see';

  // "Fight everything" — NOW it goes.
  applyDirectives(s, ['fight_enemies']);
  let engaged = false;
  for (let t = 0; t < 90; t++) {
    step(s);
    if (s.robot.order?.kind === 'attack') engaged = true;
  }
  if (!engaged) return 'FAIL: robot would not engage even after "fight everything"';

  // Restraint is not pacifism. Something that comes for it gets shot, with no
  // order and no directive — a robot that politely dies while waiting to be
  // told it may defend itself is worse than one that charges.
  const jumped = initialState(41);
  wakeRobot(jumped);
  loadFloor(jumped, FLOOR_MACHINE_I);
  clearBriefing(jumped);
  const attacker = jumped.entities.find((e) => e.id === 'printer1')!;
  const hp0 = attacker.hp!;
  jumped.robot.pos = { x: attacker.pos.x, y: attacker.pos.y + 34 }; // well inside its notice range
  for (let t = 0; t < 120; t++) step(jumped);
  if ((attacker.hp ?? 0) >= hp0 && !attacker.dead) {
    return 'FAIL: robot never shot back at a machine that came for it';
  }
  if (jumped.robot.order?.kind === 'attack') {
    return 'FAIL: returning fire escalated into a self-ordered attack';
  }
  return null;
}

/**
 * A crate is the reason to cross a floor, and it opens by PROXIMITY at
 * CRATE_NOTICE. Park one within that radius of the spawn and the ceremony
 * fires on the first tick: the player is handed the upgrade before they have
 * looked at the room, and never sees the box closed at all. Every crate has to
 * be somewhere you walk to.
 */
export function checkCrateDistance(spawn: Vec, ents: readonly Entity[]): string | null {
  const MIN = CRATE_NOTICE + 40; // notice radius plus a real walk
  for (const e of ents) {
    if (e.kind !== 'crate') continue;
    const d = dist(spawn, e.pos);
    if (d < MIN) {
      return `crate '${e.id}' is ${Math.round(d)}px from spawn — it opens itself before the player sees it (want ≥${MIN})`;
    }
  }
  return null;
}

// ------------------------------------------------- enemy body fit (r=9, r=13)
//
// `floorsRoutable` above walks the floor at ROBOT_R, and the robot is a special
// case: r=7 < TILE/2, so it fits in ANY non-wall tile. Enemies do not. A 1-tile
// passage reads fine, routes fine and plays fine right up to the moment the
// machine that is supposed to chase you through it cannot follow.
//
// tools/level-designer.html has checked this since the day it was written; the
// BUILD never has, which left the browser tool stricter than the suite. Floor 6
// is the first floor carrying a body wider than r=9, so the gap stops being
// theoretical exactly now.
//
// Sampled on a 4px grid rather than per tile, because a body far wider than a
// tile stands BETWEEN tile centres far more often than on one — the boss's only
// way through a 3-tile lane is up the middle of it.

const FIT_SAMP = 4;
const FIT_W = (TILES_X * TILE) / FIT_SAMP;
const FIT_H = (TILES_Y * TILE) / FIT_SAMP;

function circleTileOverlap(cx: number, cy: number, r: number, tx: number, ty: number): boolean {
  const nx = Math.max(tx * TILE, Math.min(cx, tx * TILE + TILE));
  const ny = Math.max(ty * TILE, Math.min(cy, ty * TILE + TILE));
  return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
}

/** True when a body of radius r can STAND at (x,y) without overlapping a wall. */
function bodyFits(solid: boolean[][], x: number, y: number, r: number): boolean {
  for (let ty = Math.floor((y - r) / TILE); ty <= Math.floor((y + r) / TILE); ty++) {
    for (let tx = Math.floor((x - r) / TILE); tx <= Math.floor((x + r) / TILE); tx++) {
      if (!isSolidTile(solid, tx, ty)) continue;
      if (circleTileOverlap(x, y, r, tx, ty)) return false;
    }
  }
  return true;
}

/** Every 4px sample a body of radius r can stand on. */
function fitField(solid: boolean[][], r: number): Uint8Array {
  const fit = new Uint8Array(FIT_W * FIT_H);
  for (let j = 0; j < FIT_H; j++) {
    for (let i = 0; i < FIT_W; i++) {
      const x = i * FIT_SAMP + FIT_SAMP / 2;
      const y = j * FIT_SAMP + FIT_SAMP / 2;
      fit[j * FIT_W + i] = bodyFits(solid, x, y, r) ? 1 : 0;
    }
  }
  return fit;
}

/** Flood fill of the standable samples reachable from `from`; null = wedged. */
function fitReach(fit: Uint8Array, from: Vec): Uint8Array | null {
  const ci = Math.min(FIT_W - 1, Math.max(0, Math.round((from.x - FIT_SAMP / 2) / FIT_SAMP)));
  const cj = Math.min(FIT_H - 1, Math.max(0, Math.round((from.y - FIT_SAMP / 2) / FIT_SAMP)));
  if (fit[cj * FIT_W + ci] !== 1) return null;
  const seen = new Uint8Array(FIT_W * FIT_H);
  const queue = new Int32Array(FIT_W * FIT_H);
  let head = 0;
  let tail = 0;
  const start = cj * FIT_W + ci;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const cur = queue[head++];
    const i = cur % FIT_W;
    const j = (cur - i) / FIT_W;
    for (const n of [
      i > 0 ? cur - 1 : -1,
      i < FIT_W - 1 ? cur + 1 : -1,
      j > 0 ? cur - FIT_W : -1,
      j < FIT_H - 1 ? cur + FIT_W : -1,
    ]) {
      if (n < 0 || seen[n] === 1 || fit[n] === 0) continue;
      seen[n] = 1;
      queue[tail++] = n;
    }
  }
  return seen;
}

/** Did the flood fill get a body within ~1.5 tiles of `to`? Elevators and the
 *  spawn tile are places to CONTEST, not places a wide body has to stand on. */
function fitReaches(seen: Uint8Array, to: Vec): boolean {
  const ci = Math.round((to.x - FIT_SAMP / 2) / FIT_SAMP);
  const cj = Math.round((to.y - FIT_SAMP / 2) / FIT_SAMP);
  const span = 6; // 6 samples = 24px = 1.5 tiles
  for (let dj = -span; dj <= span; dj++) {
    for (let di = -span; di <= span; di++) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= FIT_W || j >= FIT_H) continue;
      if (seen[j * FIT_W + i]) return true;
    }
  }
  return false;
}

/**
 * Every hostile must physically fit where it spawns, and be able to come at the
 * robot and contest the exit — at ITS OWN width, not the robot's. A machine
 * that cannot reach the spawn is a machine the floor can never send at you; one
 * that cannot reach elevator B can be walked away from forever.
 *
 * Runs on every floor, at whatever radius each kind actually has, so the boss
 * arena is checked at r=13 without the earlier floors needing a special case.
 */
export function checkHostileFit(
  solid: boolean[][],
  spawn: Vec,
  ents: readonly Entity[],
): string | null {
  const exit = ents.find((e) => e.kind === 'elevatorB')?.pos ?? null;
  // One field per radius per floor — 30×16 tiles at 4px is nothing, and two
  // bodies of the same width share the same answer.
  const fields = new Map<number, Uint8Array>();
  for (const e of ents) {
    if (!HOSTILE_KINDS.has(e.kind)) continue;
    const r = radiusOf(e);
    let fit = fields.get(r);
    if (!fit) {
      fit = fitField(solid, r);
      fields.set(r, fit);
    }
    if (!bodyFits(solid, e.pos.x, e.pos.y, r)) {
      return `'${e.id}' is wedged — an r=${r} body does not fit where it spawns`;
    }
    const seen = fitReach(fit, e.pos);
    if (!seen) return `'${e.id}' has nowhere to stand at r=${r}`;
    if (!fitReaches(seen, spawn)) {
      return `'${e.id}' cannot reach the robot spawn at r=${r} — a passage on the way is too narrow for its body`;
    }
    if (exit && !fitReaches(seen, exit)) {
      return `'${e.id}' cannot reach elevator B at r=${r} — it can never contest the way out`;
    }
  }
  return null;
}

/**
 * The boss floor must not touch the run it was appended to. Nothing before it
 * may grow a shredder or a mortar, however the boss stream later wires those
 * up: `?floor=6` is a side door, not a sixth act.
 *
 * Cheap insurance, and it fails loudly the first time a boss system starts
 * spawning off a tick counter instead of off the floor it is standing on.
 */
function bossFloorDoesNotLeak(): string | null {
  for (let i = 0; i < AUTHORED_FLOORS; i++) {
    const s = initialState(97 + i);
    wakeRobot(s);
    loadFloor(s, i);
    clearBriefing(s);
    for (let t = 0; t < 600; t++) {
      step(s);
      if (s.mortars.length !== 0) {
        return `FAIL: floor index ${i} spawned a mortar at tick ${t} — the boss floor is leaking into the authored run`;
      }
      if (s.entities.some((e) => e.kind === 'fusedShredder')) {
        return `FAIL: floor index ${i} grew a fusedShredder at tick ${t} — the boss floor is leaking into the authored run`;
      }
    }
  }
  return null;
}

/**
 * Floor 2 is the movement lesson and it only teaches if BOTH halves are true:
 * left alone the robot takes the wired door and gets bitten, and a standing
 * "avoid the sparks" makes it take the clean one instead. If the rule cannot
 * change which door it picks, the floor is just a corridor with a tax on it.
 */
function floorTwoTeachesRouteChoice(): string | null {
  const run = (avoidHazards: boolean): { hurt: boolean; arrived: boolean } => {
    const s = initialState(53);
    wakeRobot(s);
    loadFloor(s, FLOOR_MOVEMENT_I);
    clearBriefing(s);
    s.robot.standing.autonomy = false;
    s.robot.standing.avoidHazards = avoidHazards;
    const exit = s.entities.find((e) => e.id === 'elevB')!;
    exit.state = 'dark'; // measure the walk, not the floor ending mid-walk
    setOrder(s, { kind: 'goto', targetId: 'elevB' });
    let hurt = false;
    for (let t = 0; t < 1400; t++) {
      step(s);
      if (s.events.some((e) => e.type === 'robot_damage')) hurt = true;
      if (s.robot.order === null) break;
    }
    return { hurt, arrived: dist(s.robot.pos, exit.pos) <= 20 };
  };

  const careless = run(false);
  if (!careless.arrived) return 'FAIL: the movement floor — robot could not reach the exit at all';
  if (!careless.hurt) {
    return 'FAIL: the movement floor — the default route no longer costs anything, so the floor teaches nothing';
  }
  const careful = run(true);
  if (!careful.arrived) return 'FAIL: the movement floor — "avoid the sparks" left the robot unable to reach the exit';
  if (careful.hurt) {
    return 'FAIL: the movement floor — "avoid the sparks" did not change which door the robot took';
  }
  return null;
}

/**
 * The shredder makes its own adds, and every one of the four ways that can go
 * wrong is silent at runtime.
 *
 * Spawning is the one thing in this sim that writes to `state.entities` from
 * inside a loop over `state.entities`, at a position it computed rather than
 * one an author checked, for a machine that has to be awake to matter. A
 * spawner that quietly puts printers inside walls, or on top of the robot, or
 * uncapped, or asleep, still ticks along at 60Hz looking fine.
 *
 * The boss is held at full hp so this measures the SPAWNER and not the robot's
 * damage output, and the robot is parked and made immortal so the window is a
 * fixed number of print beats rather than however long it survived.
 */
/**
 * THE BOSS STARTS THE FIGHT. It shipped able to be woken by exactly one thing —
 * a bolt landing in it — so an operator who walked into the arena without
 * shooting got a boss that watched them, and the exam was opt-in.
 *
 * Two halves, and the second is the one that will rot: it must be asleep when
 * the doors open (the arena's first beat is a still room), and awake once the
 * robot has crossed the floor. A single assertion on either side passes for
 * both a boss that never wakes and a boss that is awake on arrival.
 */
function bossWakesOnApproach(): string | null {
  const s = initialState(99);
  loadFloor(s, FLOOR_BOSS_I);
  wakeRobot(s);
  clearBriefing(s);
  const boss = s.entities.find((e) => e.kind === 'fusedShredder');
  if (!boss) return 'FAIL: the boss floor has no shredder';
  if (boss.state !== 'dormant') {
    return 'FAIL: the shredder is awake before the robot has taken a step — the arena opens on a still room';
  }
  // Walk in. No attack order anywhere: this is the whole point.
  setOrder(s, { kind: 'goto', targetId: 'elevB' });
  let wokeAt = -1;
  let wakeEvents = 0;
  for (let t = 0; t < 900; t++) {
    step(s);
    for (const ev of s.events) if (ev.type === 'boss_wake') wakeEvents++;
    if (wokeAt < 0 && boss.state !== 'dormant') wokeAt = t;
  }
  if (wokeAt < 0) {
    return `FAIL: the shredder never woke — the robot crossed the arena to ${Math.round(dist(s.robot.pos, boss.pos))}px and it was still scenery`;
  }
  // Exactly one: the director hangs the roar and the music on this event, and a
  // repeat would retrigger both every tick the boss spends near the robot.
  if (wakeEvents !== 1) return `FAIL: boss_wake fired ${wakeEvents} times, expected exactly 1`;
  return null;
}

function bossPrintsItsOwnAdds(): string | null {
  const s = initialState(1234);
  loadFloor(s, FLOOR_BOSS_I);
  wakeRobot(s);
  clearBriefing(s);
  const boss = s.entities.find((e) => e.id === 'boss1');
  if (!boss) return 'FAIL: the boss floor has no boss1';
  wakeMachine(boss);
  s.robot.standing.autonomy = false; // parked: this is not a fight test
  setOrder(s, null);

  const BEATS = 8;
  const window = SPAWN_EVERY[0] * BEATS;
  const born = new Set<string>();
  let peak = 0;
  let paper = 0;
  for (let t = 0; t < window; t++) {
    boss.hp = boss.maxHp ?? 0; // immortal, so the fight never leaves phase 1
    s.robot.hp = s.robot.maxHp; // ...and so does the robot
    const before = new Set(s.entities.map((e) => e.id));
    step(s);
    for (const e of s.entities) {
      if (before.has(e.id) || e.id === 'boss1') continue;
      if (born.has(e.id)) return `FAIL: the boss printed a duplicate id '${e.id}'`;
      born.add(e.id);
      if (!bodyFits(s.solid, e.pos.x, e.pos.y, radiusOf(e))) {
        return `FAIL: the boss printed '${e.id}' inside a wall at ${Math.round(e.pos.x)},${Math.round(e.pos.y)}`;
      }
      if (dist(e.pos, s.robot.pos) < SPAWN_CLEAR_ROBOT) {
        return `FAIL: the boss printed '${e.id}' ${Math.round(dist(e.pos, s.robot.pos))}px from the robot — an add that materialises inside contact range is an unavoidable hit`;
      }
      if (e.state === 'dormant') {
        return `FAIL: the boss printed '${e.id}' asleep — an add the player has to wake for it is scenery`;
      }
    }
    let live = 0;
    for (const e of s.entities) if (!e.dead && HOSTILE_KINDS.has(e.kind) && e.id !== 'boss1') live++;
    if (live > peak) peak = live;
    for (const ev of s.events) if (ev.type === 'paper_thrown' && ev.id !== 'boss1') paper++;
  }

  if (born.size < 4) {
    return `FAIL: the boss printed only ${born.size} adds in ${BEATS} beats — the tide the floor is built around is not arriving`;
  }
  if (peak > MAX_ADDS) {
    return `FAIL: ${peak} concurrent adds, cap is ${MAX_ADDS} — an uncapped spawner is an unplayable swarm`;
  }
  if (paper === 0) {
    return 'FAIL: the printed adds never attacked — they spawn awake and aggroed, so a silent one means the wake path is broken';
  }
  return null;
}

function snapshot(s: SimState): string {
  return JSON.stringify({
    t: s.tick,
    rng: s.rngState,
    robot: s.robot,
    entities: s.entities,
    projectiles: s.projectiles,
    events: s.events,
  });
}

function run(): { frames: string[]; events: number } {
  const s = initialState(42);
  const frames: string[] = [];
  let events = 0;
  for (let t = 1; t <= TICKS; t++) {
    script(t, s);
    step(s);
    events += s.events.length;
    frames.push(snapshot(s));
  }
  return { frames, events };
}

/**
 * The conversation bank still sounds like the robot.
 *
 * Talking at length is the one feature whose whole risk is voice drift: the
 * temptation while writing warm replies is to let one sentence run long, and a
 * single subordinate clause is enough for the robot to stop being a toddler and
 * start being a chatbot. So the bank is checked mechanically, per sentence,
 * against the same cap an ack lives under (CLAUDE.md rule 7).
 */
function talkStaysToddler(): string | null {
  for (const line of ALL_TALK_LINES) {
    // Entries may hold two short sentences; the cap is PER sentence.
    for (const s of line.split(/(?<=[.!?])\s+/)) {
      const words = s.replace(/[^A-Z0-9\s{}]/gi, ' ').split(/\s+/).filter(Boolean);
      if (words.length === 0) return `FAIL: empty small-talk sentence in "${line}"`;
      if (words.length > 7) return `FAIL: small-talk sentence over 7 words: "${s}"`;
      if (/[,;:]| because | which | while | when /i.test(s)) {
        return `FAIL: small-talk sentence has a subordinate clause: "${s}"`;
      }
      if (s !== s.toUpperCase()) return `FAIL: small-talk sentence not uppercase: "${s}"`;
    }
  }
  // The two gates that make the feature safe: a topic answers, and a hostile in
  // the room turns any topic into a deflection instead.
  const ctx = { name: 'BEEP', recent: [] as string[], calm: true };
  const warm = smallTalk('how are you', ctx);
  if (!warm.matched || warm.lines.length < 2) return 'FAIL: "how are you" is not answered as conversation';
  const busy = smallTalk('how are you', { ...ctx, calm: false });
  if (busy.lines.some((l) => warm.lines.includes(l))) {
    return 'FAIL: robot chats normally with a hostile awake';
  }
  return null;
}

/**
 * THE CONTRACT AUDIT.
 *
 * Half the behaviour tests above are pinned to a floor INDEX because they are
 * really tests of a ROOM: the island that blocks the straight line, the two
 * doors of which one bites, the machine that must be reported rather than
 * charged, the shredder. Replace that room with a level someone drew in the
 * designer and the assertion stops describing anything — it does not become
 * false, it becomes meaningless, and the difference matters because a suite
 * that fails for a reason nobody can act on is a suite people start ignoring.
 *
 * So a contract whose floor has been replaced is SKIPPED and says so, once, in
 * the line `pnpm selftest` prints. The contracts that test the ROBOT rather
 * than the room (initiative, the briefing hold, the boss floor not leaking,
 * determinism itself) keep running on whatever floor is standing there — that
 * is the point of them, and a replacement that breaks one has broken the game.
 */
function auditContracts(notes: string[]): string | null {
  const onFloors = (
    what: string,
    floors: readonly number[],
    fn: () => string | null,
  ): string | null => {
    const gone = floors.filter(isReplacedFloor);
    if (gone.length > 0) {
      notes.push(
        `note: skipped "${what}" — floor ${gone.map((i) => i + 1).join(' and ')} ` +
          `${gone.length > 1 ? 'have' : 'has'} been replaced by a designer level, ` +
          'so the built-in content this contract reads is not in the run',
      );
      return null;
    }
    return fn();
  };

  return (
    onFloors('routing round an obstacle', [FLOOR_ISLAND_I], routesAroundObstacles) ??
    onFloors('the movement floor teaches route choice', [FLOOR_MOVEMENT_I], floorTwoTeachesRouteChoice) ??
    onFloors(
      'threats are reported, not charged',
      [FLOOR_GAUNTLET_I, FLOOR_MACHINE_I],
      reportsThreatsInsteadOfCharging,
    ) ??
    onFloors('the boss wakes on approach', [FLOOR_BOSS_I], bossWakesOnApproach) ??
    onFloors('the boss prints its own adds', [FLOOR_BOSS_I], bossPrintsItsOwnAdds)
  );
}

export function runSelftest(): string {
  const notes: string[] = [];
  // A level claiming a slot that is not there, or one two levels claim, is a
  // build failure — floors.ts cannot throw (it would black out the designer
  // the mistake has to be fixed in), so it records and this reports.
  if (REPLACEMENT_ERRORS.length > 0) {
    return `FAIL: bad meta.replaces —\n  ${REPLACEMENT_ERRORS.join('\n  ')}`;
  }

  // Floor sanity, every floor including any appended designer level: maps
  // well-formed, pinned ids present, nothing in a wall, everything reachable.
  for (let i = 0; i < FLOORS.length; i++) {
    const ents = FLOORS[i].entities();
    const ids = new Set(ents.map((e) => e.id));
    for (const id of pinnedFor(i, ents)) {
      if (!ids.has(id)) return `FAIL: floor index ${i} missing pinned entity '${id}'`;
    }
    const fail = checkFloor(FLOORS[i]);
    if (fail) return `FAIL: floor index ${i} ${fail}`;
  }
  // Robot contracts: these read a floor but not its contents, so they run on
  // whatever is standing in the slot — including a replacement.
  const initFail = actsOnItsOwn();
  if (initFail) return initFail;
  const holdFail = holdsAtEveryFloor();
  if (holdFail) return holdFail;
  const leakFail = bossFloorDoesNotLeak();
  if (leakFail) return leakFail;
  // Room contracts: skipped, with a note, where the room has been replaced.
  const contractFail = auditContracts(notes);
  if (contractFail) return contractFail;
  const talkFail = talkStaysToddler();
  if (talkFail) return talkFail;

  // The opening beat only works if the robot really is inert until woken.
  const sleeping = initialState(7);
  setOrder(sleeping, { kind: 'move', dir: 'right' });
  const x0 = sleeping.robot.pos.x;
  for (let t = 0; t < 60; t++) step(sleeping);
  if (sleeping.robot.pos.x !== x0) return 'FAIL: dormant robot moved before wakeRobot()';
  wakeRobot(sleeping);
  for (let t = 0; t < 60; t++) step(sleeping);
  if (sleeping.robot.pos.x === x0) return 'FAIL: robot did not move after wakeRobot()';

  const a = run();
  const b = run();
  for (let i = 0; i < TICKS; i++) {
    if (a.frames[i] !== b.frames[i]) {
      return `FAIL: divergence at tick ${i + 1}\nA: ${a.frames[i]}\nB: ${b.frames[i]}`;
    }
  }
  if (a.events === 0) return 'FAIL: scripted run emitted zero events';
  // Notes ride AFTER the verdict: selftest-run.ts decides pass/fail on the
  // first word, and a skipped contract is news, not a failure.
  return [
    `PASS: ${TICKS} ticks deterministic (seed 42, ${a.events} events across run)`,
    ...notes,
  ].join('\n');
}
