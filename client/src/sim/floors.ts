/**
 * The five authored floors (GAME_SPEC §8 / FIRST_MINUTES beats).
 * ASCII maps: '#'=wall, '.'=floor, TILES_X × TILES_Y of TILE px.
 * Elevator A (spawn) and B (exit) sit on OPPOSITE sides — the zigzag.
 * Sides alternate per floor: ride up shaft B, arrive next floor at that side's A.
 * Entity ids here are PINNED — the director references them exactly.
 * Walkability law: robot r=7, enemy r=9 — every passage is ≥2 tiles wide.
 */
import type { ChipId, Entity, Vec } from '../../../shared/types';
import { TILE, TILES_X, TILES_Y } from '../../../shared/types';

export interface FloorDef {
  map: string[];
  /** Fresh entity copies per load — loadFloor must never share objects across loads. */
  entities: () => Entity[];
  /** Where the robot appears. Defaults to elevator A (it rode up the shaft);
   *  floor 1 overrides it to center screen, asleep inside the debris pile. */
  spawn?: Vec;
}

const at = (tx: number, ty: number): Vec => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });

// ---------------------------------------------------------------- builders

const elevA = (pos: Vec): Entity => ({ id: 'elevA', kind: 'elevatorA', pos, label: 'dead elevator behind robot', state: 'inert' });
const elevB = (pos: Vec, dark = false): Entity => ({
  id: 'elevB',
  kind: 'elevatorB',
  pos,
  label: 'elevator', // THE elevator — the exit; A is labeled dead
  state: dark ? 'dark' : 'lit',
});
const scrap = (id: string, pos: Vec): Entity => ({ id, kind: 'scrap', pos, label: 'scrap' });
/** A loose personality chip lying on the floor — the early-game reward. */
const chip = (id: string, pos: Vec, option: ChipId): Entity => ({
  id,
  kind: 'chip',
  pos,
  option,
  label: `${option.toLowerCase()} chip`,
  state: 'loose',
});
/** Heap of dead machines. Decorative and non-blocking (no tiles are solid under
 *  it) — the robot must be able to drive back out over its own bed. */
const debris = (id: string, pos: Vec): Entity => ({
  id,
  kind: 'debris',
  pos,
  label: 'pile of broken machines',
  state: 'settled',
});
const cable = (id: string, pos: Vec): Entity => ({ id, kind: 'cable', pos, label: 'sparking cable', state: 'spark' });
/** option undefined = the fixed tier-1 controller crate ('starter crate'). */
const crate = (id: string, pos: Vec, option?: ChipId): Entity => ({
  id,
  kind: 'crate',
  pos,
  option,
  label: option ? `${option.toLowerCase()} crate` : 'starter crate',
  state: 'closed',
});
/** The BRAIN upgrade crate (floor 4) — optionless like crate_EARS; the
 *  director runs its auto-ceremony on crate_reached. */
const brainCrate = (pos: Vec): Entity => ({
  id: 'crate_BRAIN',
  kind: 'crate',
  pos,
  label: 'brain crate',
  state: 'closed',
});
/** The ceremony triad: ONE shiny crate per ceremony floor (2 & 5). The three
 *  chips are offered on the ceremony card, not as separate crates. */
const triadCrate = (pos: Vec): Entity => ({
  id: 'crate_triad',
  kind: 'crate',
  pos,
  label: 'shiny crate',
  state: 'closed',
});
const printer = (id: string, pos: Vec, hp: number): Entity => ({
  id,
  kind: 'fusedPrinter',
  pos,
  hp,
  maxHp: hp,
  label: 'printer',
  state: 'idle',
  facing: 'down',
  ai: {},
});
/** Harmless decoys get hp so wrong-target shots land (enemy_hit/enemy_death comedy). */
const innocent = (id: string, pos: Vec): Entity => ({
  id,
  kind: 'printerInnocent',
  pos,
  hp: 2,
  maxHp: 2,
  label: 'nice printer',
  state: 'idle',
});
const mop = (id: string, pos: Vec): Entity => ({ id, kind: 'mop', pos, hp: 1, maxHp: 1, label: 'mop' });
const fuse = (id: string, pos: Vec): Entity => ({ id, kind: 'fuse', pos, label: 'fuse' });
// Label must NOT contain "fuse" — "grab the fuse" would mis-target the socket.
const socket = (id: string, pos: Vec): Entity => ({ id, kind: 'fuseSocket', pos, label: 'power socket', state: 'empty' });

// ---------------------------------------------------------------- floors

// Each floor is a named const, and FLOORS at the bottom of the file is the
// ORDER. Keeping the two apart means the running order can be changed without
// touching a single room — and, more usefully, without the comments quietly
// coming to describe a floor that has moved.

/**
 * THE OPENING. A symmetric storage hall, four support pillars framing a wide
 * centre plaza, and the robot dead centre asleep in a heap of broken machines.
 * The whole floor exists to put ONE silhouette in the middle of the feed and
 * let the player wonder what it is.
 *
 * Elevators sit directly below and above the pile, so the first thing the
 * player ever does is a straight, unambiguous run. The extra debris heaps are
 * dressing: the room has been dying for a long time, and the thing that woke
 * up was lying in the middle of it.
 */
const FLOOR_OPENING: FloorDef = {
  map: [
    '##############################',
    '#............................#',
    '#...####..............####...#',
    '#...####..............####...#',
    '#............................#',
    '#............................#',
    '#............................#',
    '#............................#',
    '#............................#',
    '#............................#',
    '#............................#',
    '#...####..............####...#',
    '#...####..............####...#',
    '#............................#',
    '#............................#',
    '##############################',
  ],
  // Robot spawns INSIDE pile1 (same point) — see `spawn` below.
  entities: () => [
    elevA(at(15, 14)),
    elevB(at(15, 3)),
    debris('pile1', at(15, 8)),
    debris('pile2', at(6, 14)),
    scrap('scrap1', at(24, 5)),
    scrap('scrap2', at(7, 6)),
    debris('pile3', at(10, 12)),
    debris('pile4', at(23, 13)),
    debris('pile5', at(19, 10)),
    debris('pile6', at(28, 8)),
    debris('pile7', at(28, 14)),
    debris('pile8', at(2, 7)),
  ],
  spawn: at(15, 8),
};

/**
 * THE MEMORY CHIP. Wide hall, centre island (C-shaped pocket open toward A)
 * with the chip sitting in it. The island blocks the straight A→B line, so the
 * floor plays as a lap: the chip is not on your way, you have to go round for
 * it, and that walk is the whole floor.
 *
 * No crate and no choice. MEMORY is the cure for the forgetting gag that fires
 * on arrival here, and a gag whose punchline the player can accidentally trade
 * away for a combat chip is a gag that mostly does not land. The exit is lit
 * the whole time — the chip is wanted, not enforced.
 */
const FLOOR_MEMORY: FloorDef = {
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
    elevB(at(27, 8)), // lit: nothing on this floor is a gate
    // Dead centre of the island pocket, on the row seam: the pocket is only two
    // rows deep, so a chip parked on either row has a wall within the robot's
    // body radius and cannot be driven onto.
    chip('chip_memory', at(14, 7.5), 'MEMORY'), // a lap round the island, not a detour
    scrap('scrap1', at(7, 3)),
    scrap('scrap2', at(22, 12)),
  ],
};

/**
 * THE MOVEMENT LESSON, and the forgetting gag on top.
 * A right, B left, and one unbroken wall between them with exactly TWO doors.
 *
 * The whole floor is a single sentence: "there are two ways round, and one of
 * them hurts." The LOW door (y=10..11) is the nearer one, so a robot left to
 * its own devices picks it — and walks straight through two live cables. The
 * HIGH door (y=4..5) is a longer walk and completely clean. Nothing here can
 * kill: it costs a point or two of hull and teaches, in the cheapest possible
 * classroom, that the operator is allowed to say WHICH WAY.
 *
 * The lesson has two correct answers, which is the point: "go round the top"
 * routes it by hand, and "avoid the sparks" sets a standing rule that makes
 * the planner itself prefer the clean door from then on.
 *
 * No upgrade lives here. The reward for this floor is knowing the trick, and
 * the only things on the ground are the two scraps that make the choice have
 * stakes: one in the wired corridor to price greed, one on the patient route
 * so the safe road is not simply the boring one.
 */
const FLOOR_MOVEMENT: FloorDef = {
  map: [
      '##############################',
      '#............##..............#',
      '#............##..............#',
      '#............##..............#',
      '#............................#', // HIGH door — the long way, and clean
      '#............................#',
      '#............##..............#',
      '#............##..............#',
      '#............##..............#',
      '#............##..............#',
      '#............................#', // LOW door — nearer, and wired
      '#............................#',
      '#............##..............#',
      '#............##..............#',
      '#............##..............#',
      '##############################',
    ],
    entities: () => [
      elevA(at(27, 8)),
      elevB(at(2, 8)),
      // Both cables sit IN the low door, so taking it is a decision with a
      // cost rather than a dice roll about which tile you clipped.
      cable('cable1', at(13, 10)),
      cable('cable2', at(14, 11)),
      scrap('scrap1', at(16, 11)), // greed bait, in the wired corridor
      scrap('scrap2', at(17, 4)), // and a smaller one for the patient route
      debris('pile2', at(24, 13)), // dressing: the room has been dying a while
    ],
};

/**
 * THE FUSE RUN. A left, B right, B dark until the fuse is in.
 *
 * A thin wall splits the safe top corridor (both elevators, the socket) from
 * the open bay below (three machines). ONE 3-wide gap connects them, and the
 * fuse is in the far bottom-right corner — so the floor is a there-and-back
 * through machine turf, twice past the gap, and the carry leg is done with the
 * gun disabled. There is nothing else to pick up: every decision here is about
 * the route and the fight, not about loot.
 *
 * This is the last floor, and the first time the player is asked to hold two
 * things at once — which is why the errand moved here from floor 4.
 */
const FLOOR_FIRST_MACHINE: FloorDef = {
  map: [
      '##############################',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '##############...#############',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '##############################',
    ],
    entities: () => [
      elevA(at(2, 3)),
      elevB(at(27, 3), true), // dark until the fuse is seated
      socket('socket1', at(22, 2)), // up in the safe corridor — the carry leg is long
      fuse('fuse1', at(26, 13)), // far bottom-right: the whole floor is the trip there
      // Three machines, spread so no single lane is free: printer1 holds the
      // left bay, printer2 the middle approach out of the gap, printer3 the
      // corner the fuse sits in. The return trip cannot be run clean — it has
      // to be fought, avoided or sneaked.
      //
      // They are kept well apart from each other AND from the decoy on purpose.
      // A machine parked beside the innocent printer makes the wrong-target gag
      // physically unreachable: contact knockback holds the robot ~30px off it
      // forever, which the nav fuzz correctly reported as a floor you cannot
      // finish walking around.
      printer('printer1', at(9, 10), 3),
      printer('printer2', at(20, 7), 3),
      printer('printer3', at(25, 11), 3),
      innocent('printer_nice', at(15, 12)), // framed by the gap: the wrong-target gag
      cable('cable1', at(21, 10)), // straight line from the gap to the fuse crosses it
    ],
};

/**
 * THE GAUNTLET. A right, B left, and the exit is open the whole time.
 *
 * Two pillar colonnades and a centre cover block carve three lanes across the
 * room; a cable blocks the middle cut through the left colonnade, so route
 * choice matters and the printer roams mid-right. The ONLY thing worth having
 * is the crate — nothing else on the floor is a reward, so the question is
 * simply whether it is worth walking past a machine to reach it.
 *
 * The fuse-and-socket errand used to gate this floor and it arrived far too
 * early: a carry that disables the gun, on the first floor with a real fight,
 * on top of learning the crate. It now lives on floor 5, where the player has
 * met a machine and can be asked to do two things at once.
 */
const FLOOR_GAUNTLET: FloorDef = {
  map: [
      '##############################',
      '#............................#',
      '#............................#',
      '#............................#',
      '#.......##..........##.......#',
      '#.......##..........##.......#',
      '#............................#',
      '#.............##.............#',
      '#.............##.............#',
      '#............................#',
      '#.......##..........##.......#',
      '#.......##..........##.......#',
      '#............................#',
      '#............................#',
      '#............................#',
      '##############################',
    ],
    entities: () => [
      elevA(at(27, 8)),
      elevB(at(2, 8)), // lit: the way out is never the puzzle on this floor
      // Far side of the room from spawn (elevA is right, x=27): the crate is a
      // TRIP, not a detour — up the A lane, across the machine's patrol, and
      // out over the top of the left colonnade. Parked at x=22 it was four
      // tiles from the doors and the whole gauntlet went unplayed.
      brainCrate(at(11, 2)),
      printer('printer1', at(19, 7), 4),
      cable('cable1', at(8, 7)), // middle cut of the left colonnade — squeeze low or detour
      mop('mop1', at(14, 12)), // not a reward: a thing to mistake for one
    ],
};

/**
 * THE RUNNING ORDER. Index 0 is floor 1.
 *
 * The ramp is deliberately gentle at the front: wake up, then a room whose
 * only demand is a choice of chip, then the two-door movement lesson, and only
 * then anything that fights back. Everything the player is taught arrives
 * before the floor that tests it.
 *
 * Anything keyed by FLOOR NUMBER lives elsewhere and has to move with this:
 * `TRIADS` in shared/content.ts (the ceremony floor), and `PINNED_IDS` in
 * sim/selftest.ts (indexed by floor). The selftest checks both.
 */
export const FLOORS: FloorDef[] = [
  FLOOR_OPENING, // 1 — wake up
  FLOOR_MEMORY, // 2 — the memory chip, out round the island
  FLOOR_MOVEMENT, // 3 — two doors, one bites
  FLOOR_GAUNTLET, // 4 — fuse, socket, and the first real fight
  FLOOR_FIRST_MACHINE, // 5 — sharper ears, and a machine to use them on
];

/** Parse an ASCII map into the walkability grid. Throws on malformed maps. */
export function buildSolid(map: string[]): boolean[][] {
  if (map.length !== TILES_Y) throw new Error(`map has ${map.length} rows, want ${TILES_Y}`);
  return map.map((row, y) => {
    if (row.length !== TILES_X) throw new Error(`map row ${y} has ${row.length} cols, want ${TILES_X}`);
    return [...row].map((c) => c === '#');
  });
}
