/**
 * The five authored floors (GAME_SPEC §8 / FIRST_MINUTES beats).
 * ASCII maps: '#'=wall, '.'=floor, TILES_X × TILES_Y of TILE px.
 * Elevator A (spawn) and B (exit) sit on OPPOSITE sides — the zigzag.
 * Sides alternate per floor: ride up shaft B, arrive next floor at that side's A.
 * Entity ids here are PINNED — the director references them exactly.
 * Walkability law: robot r=7, enemy r=9 — every passage is ≥2 tiles wide.
 */
import type {
  ChipId,
  Entity,
  LevelData,
  LevelLit,
  LevelMeta,
  SoundEmitterDef,
  TriggerDef,
  Vec,
} from '../../../shared/types';
import { TILE, TILES_X, TILES_Y } from '../../../shared/types';
import { CUSTOM_LEVELS } from '../levels/index';
import { levelToFloorDef } from './levelLoader';

export interface FloorDef {
  map: string[];
  /** Fresh entity copies per load — loadFloor must never share objects across loads. */
  entities: () => Entity[];
  /** Where the robot appears. Defaults to elevator A (it rode up the shaft);
   *  floor 1 overrides it to center screen, asleep inside the debris pile. */
  spawn?: Vec;
  /** Authored region triggers (designer levels). loadFloor copies these into
   *  state.triggers; the built-in floors carry none. */
  triggers?: TriggerDef[];
  /** Positional ambience. Pass-through: the sim never reads it — see
   *  client/src/audio/emitters.ts. */
  sounds?: SoundEmitterDef[];
  /** Present on floors converted from a LevelData; absent on the built-ins. */
  meta?: LevelMeta;
  /**
   * Authored lighting, dressing and look. Pure pass-through: the sim never
   * reads a byte of it and nothing here is resolved against a default — that
   * happens in `client/src/render/lit`. A floor without it renders on the
   * classic path.
   */
  lit?: LevelLit;
}

/** Tile coords → the px centre of that tile. Exported for levelLoader. */
export const at = (tx: number, ty: number): Vec => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });

// ---------------------------------------------------------------- builders
//
// Exported so `levelLoader.ts` can build a designer level's entities through
// exactly the same code the hand-authored floors use. A second table of
// defaults would be a second place for "what a printer is" to drift.

export const elevA = (pos: Vec): Entity => ({ id: 'elevA', kind: 'elevatorA', pos, label: 'dead elevator behind robot', state: 'inert' });
export const elevB = (pos: Vec, dark = false): Entity => ({
  id: 'elevB',
  kind: 'elevatorB',
  pos,
  label: 'elevator', // THE elevator — the exit; A is labeled dead
  state: dark ? 'dark' : 'lit',
});
export const scrap = (id: string, pos: Vec): Entity => ({ id, kind: 'scrap', pos, label: 'scrap' });
/** A loose personality chip lying on the floor — the early-game reward. */
export const chip = (id: string, pos: Vec, option: ChipId): Entity => ({
  id,
  kind: 'chip',
  pos,
  option,
  label: `${option.toLowerCase()} chip`,
  state: 'loose',
});
/** Heap of dead machines. Decorative and non-blocking (no tiles are solid under
 *  it) — the robot must be able to drive back out over its own bed. */
export const debris = (id: string, pos: Vec): Entity => ({
  id,
  kind: 'debris',
  pos,
  label: 'pile of broken machines',
  state: 'settled',
});
export const cable = (id: string, pos: Vec): Entity => ({ id, kind: 'cable', pos, label: 'sparking cable', state: 'spark' });
/** option undefined = the fixed tier-1 controller crate ('starter crate'). */
export const crate = (id: string, pos: Vec, option?: ChipId): Entity => ({
  id,
  kind: 'crate',
  pos,
  option,
  label: option ? `${option.toLowerCase()} crate` : 'starter crate',
  state: 'closed',
});
/** The BRAIN upgrade crate (floor 4) — optionless like crate_EARS; the
 *  director runs its auto-ceremony on crate_reached. */
export const brainCrate = (pos: Vec): Entity => ({
  id: 'crate_BRAIN',
  kind: 'crate',
  pos,
  label: 'brain crate',
  state: 'closed',
});
/** The ceremony triad: ONE shiny crate per ceremony floor (2 & 5). The three
 *  chips are offered on the ceremony card, not as separate crates. */
export const triadCrate = (pos: Vec): Entity => ({
  id: 'crate_triad',
  kind: 'crate',
  pos,
  label: 'shiny crate',
  state: 'closed',
});
export const printer = (id: string, pos: Vec, hp: number): Entity => ({
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
export const innocent = (id: string, pos: Vec): Entity => ({
  id,
  kind: 'printerInnocent',
  pos,
  hp: 2,
  maxHp: 2,
  label: 'nice printer',
  state: 'idle',
});
export const mop = (id: string, pos: Vec): Entity => ({ id, kind: 'mop', pos, hp: 1, maxHp: 1, label: 'mop' });
/** Office chair. Furniture the staff left behind — mop rules: harmless, named,
 *  shootable, and worth walking over to look at. Its sprite is the one baked
 *  from a 3D model (`tools/sprites.json`) rather than drawn by hand. */
export const chair = (id: string, pos: Vec): Entity => ({ id, kind: 'chair', pos, hp: 1, maxHp: 1, label: 'office chair' });
export const fuse = (id: string, pos: Vec): Entity => ({ id, kind: 'fuse', pos, label: 'fuse' });
// Label must NOT contain "fuse" — "grab the fuse" would mis-target the socket.
export const socket = (id: string, pos: Vec): Entity => ({ id, kind: 'fuseSocket', pos, label: 'power socket', state: 'empty' });

/**
 * Boss hull. Long enough for the fight to have phases, short enough that the
 * last floor stays a set-piece and never becomes a grind.
 *
 * 96, up from 24, and the reason is the one number that made the fight not a
 * fight: a robot arriving here with ZAP (damage 2, 16-tick cooldown) empties 24
 * hp in TWELVE bolts — 202 ticks, 3.4 seconds, phase 1 through phase 3 crossed
 * inside a single held breath. The three-phase structure existed in the source
 * and never once on the screen. At 96 the same robot needs ~13 seconds of
 * uninterrupted fire, which is 25–40 seconds once the mortars make it stop
 * firing and move, and every phase is something the player lives through
 * instead of a line in a changelog.
 *
 * bossPhase() divides by maxHp, so the thresholds ride this number for free:
 * phase 1 is hp 64–96, phase 2 is 32–63, phase 3 is 31 down. Nothing else needs
 * touching to move it again.
 */
const BOSS_HP = 96;
/**
 * THE SHREDDER — a cross-cut shredder fused onto a floor-scrubber chassis.
 * Starts 'dormant', which is not a costume: isLiveHostile excludes it, so
 * until something stands it up the boss is scenery in every scan the sim runs.
 *
 * The label must stay phonetically clear of "printer". Both parsers map
 * machine/enemy/monster/thing/baddie → fusedPrinter through KIND_SYNONYMS, so a
 * boss with "printer" anywhere in its name is a boss the operator cannot name.
 */
export const shredder = (id: string, pos: Vec): Entity => ({
  id,
  kind: 'fusedShredder',
  pos,
  hp: BOSS_HP,
  maxHp: BOSS_HP,
  label: 'shredder',
  state: 'dormant',
  facing: 'left',
  ai: {},
});
/**
 * An add, built by the SHREDDER mid-fight rather than laid out by this file.
 *
 * The four printers that used to be propped against the corners were a lie the
 * player only fell for once: dead scenery on arrival, all four standing up on
 * one frame at phase two, and then never any more of them for the rest of the
 * fight. The room's pressure was a step function with exactly one step in it.
 * The boss now prints one every five seconds (`SPAWN_EVERY` in boss.ts) out of
 * its own body, which is both a threat that grows while you dither and a thing
 * the player can SEE the source of — the answer to "where do they keep coming
 * from" is standing in the middle of the room taking bolts.
 *
 * Exported because boss.ts is the only caller: the floor still owns what an add
 * IS (kind, label, hp), the boss owns when and where one appears.
 *
 * hp 3, unchanged from the propped-up version. An add is a nuisance to be
 * shoved through or ignored, not a second boss — the whole reason the operator
 * gets to say "LEAVE THEM, SHOOT THE BIG ONE" and be right.
 */
export const bossAdd = (id: string, pos: Vec): Entity => printer(id, pos, 3);
/** The one upgrade on the boss floor — and the reason to cross the room while
 *  something is dropping mortars on it. */
export const rocketCrate = (pos: Vec): Entity => ({
  id: 'crate_ROCKET',
  kind: 'crate',
  pos,
  label: 'rocket crate',
  state: 'closed',
});

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
    // Off the A→B line, close enough to the pile to be in frame with it. One
    // piece of furniture in a room full of dead machines says "people worked
    // here" louder than another heap does — and gives the robot something to
    // misidentify on the floor where it has no enemies to misidentify instead.
    chair('chair1', at(11, 6)),
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
    // NO SCRAP. There was a piece in each far corner, and between the pickup
    // barks, the gather self-orders and the explore callouts they buried the
    // one line this floor exists to deliver. A floor with a single idea should
    // contain a single thing worth remarking on.
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
 * THE SHREDDER. A right, B left and DARK, and the thing that ate this floor
 * parked in the middle of the only straight line between them.
 *
 * The doors open on a room that is not doing anything. A slumped hulk in the
 * centre, a pile of scrap, somebody's office chair. The operator's first job is
 * to be wrong about all of it, and the robot will help: the shredder spawns
 * 'dormant', which is scenery by contract, so it reports junk because junk is
 * what it is looking at.
 *
 * Then the hulk stands up, and the job turns into triage one sentence at a
 * time. "GO TO THE LIFT" gets answered by the lift — elevator B is dark until
 * the shredder stops moving, and the robot says so. So the fight is not a rule
 * the game imposes; it is the only door left. What is left to say is WHERE TO
 * STAND. The mortars paint their circles on the ground before they land, which
 * makes "MOVE" and "GET BEHIND SOMETHING" the whole vocabulary of phase one —
 * and the six stanchions are STAGGERED, not gridded like floor 1, so "behind
 * something" is a judgement about which diagonal rather than a thing the
 * operator reads off the map once and reuses.
 *
 * Both outer lanes run unbroken end to end and the robot outruns the boss, so
 * "JUST RUN" is always a real answer. That is deliberate. It is what makes
 * standing and fighting a decision the operator makes instead of one the room
 * makes for them. The rocket crate sits down in the bottom lane, far enough
 * from the doors that going to get it is a trip taken under fire.
 *
 * Then it starts printing. One add every five seconds, out of the shredder's
 * own body, capped so the room stays readable — and that is what turns the
 * middle of the fight into a triage problem. The operator stops picking cover
 * and starts picking TARGETS: "SHOOT THE BIG ONE", "LEAVE THEM, KEEP MOVING".
 * The adds are a tax on hesitation and they never stop coming, so the answer to
 * them is never "clear the room", it is "kill the thing making them".
 * Killing the shredder lights elevator B — and because the director ends the
 * run at five floors cleared, stepping into it fires the cliffhanger. The
 * trailer finishes on the doors closing.
 *
 * Trailer-only: appended after the authored five and reached by `?floor=6`, so
 * the shipping run is untouched by everything above.
 */
const FLOOR_BOSS: FloorDef = {
  map: [
    '##############################',
    '#............................#',
    '#............................#',
    '#............................#',
    '#....##.....##........##.....#',
    '#....##.....##........##.....#',
    '#............................#',
    '#............................#',
    '#............................#',
    '#............................#',
    '#.......##......##......##...#',
    '#.......##......##......##...#',
    '#............................#',
    '#............................#',
    '#............................#',
    '##############################',
  ],
  entities: () => [
    // Both doors sit on the centre line of the plaza, which is what puts the
    // boss literally between the robot and the exit rather than merely near it.
    elevA(at(27, 7.5)),
    elevB(at(2, 7.5), true), // dark until the shredder stops moving
    shredder('boss1', at(15, 7.5)),
    // Bottom lane, well off the A→B line: reaching it is a trip, and a trip is
    // the only kind of errand worth giving during a fight.
    rocketCrate(at(20, 13)),
    // NO ADDS ARE AUTHORED HERE. The shredder prints its own, one every five
    // seconds, out of its own body — see `bossAdd` above and SPAWN_EVERY in
    // boss.ts. Four printers propped in the corners meant the room's pressure
    // was fixed the moment the doors opened; a boss that keeps making more
    // means dithering costs something and killing it is the only way to stop
    // the tide. It also puts the source on screen: they come out of the thing
    // you are supposed to be shooting.
    // Dressing. The chair is the one thing in here that a person sat in, and
    // it is parked where the robot will drive past it on the way to elevator B.
    chair('chair1', at(10, 9)),
    debris('pile1', at(12, 9)),
    debris('pile2', at(19, 6)),
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
 *
 * The boss floor is APPENDED, never inserted. The director ends the run at
 * five floors cleared, so index 5 is off the end of the authored arc by
 * construction: it is reachable only by `?floor=6`, and nothing before it
 * changes because it exists.
 */
export const BUILTIN_FLOORS: readonly FloorDef[] = [
  FLOOR_OPENING, // 1 — wake up
  FLOOR_MEMORY, // 2 — the memory chip, out round the island
  FLOOR_MOVEMENT, // 3 — two doors, one bites
  FLOOR_GAUNTLET, // 4 — fuse, socket, and the first real fight
  FLOOR_FIRST_MACHINE, // 5 — sharper ears, and a machine to use them on
  FLOOR_BOSS, // 6 — the shredder; trailer-only, off the end of the run
];

// ------------------------------------------------------- custom levels in
//
// A designer level joins FLOORS one of two ways, and the difference is whether
// the shipping run can ever see it.
//
// APPEND (no `meta.replaces`) is the safe default and the old behaviour: the
// director ends the run at FLOORS_IN_RUN cleared, so a level added off the end
// is reachable only by `?floor=N` and nothing before it changes.
//
// REPLACE (`meta.replaces: N`, 1-based) puts the level IN the run, standing
// where BUILTIN_FLOORS[N-1] stood. That is the whole point — a floor drawn in
// the designer becoming the floor the player actually plays — and it is also
// why the guard below exists: everything keyed by floor NUMBER (the director's
// ceremonies, `TRIADS` in shared/content.ts, `PINNED_IDS` in sim/selftest.ts)
// keeps pointing at the slot, not at the room that used to fill it.

const sortedCustoms = [...CUSTOM_LEVELS].sort((a, b) => a.meta.order - b.meta.order);

/**
 * Levels that failed the `replaces` guard, as sentences a reader can act on.
 *
 * NOT a throw. This module is imported by the game, the designer and the test
 * suite alike, and a module-init exception in a level file's metadata is a
 * black screen everywhere at once — including in the designer, which is where
 * the mistake would have to be fixed. So a bad `replaces` falls back to the
 * behaviour that cannot hurt anything (append), and `runSelftest` turns this
 * list into a build failure.
 */
export const REPLACEMENT_ERRORS: string[] = [];

/**
 * 0-based slot (floor N-1) → the level standing in it. Levels that fail the
 * guard are simply absent, which is what makes them fall through to the append
 * list below without a second decision anywhere.
 */
const replacementFor = ((): ReadonlyMap<number, LevelData> => {
  const out = new Map<number, LevelData>();
  for (const lv of sortedCustoms) {
    const n = lv.meta.replaces;
    if (n === undefined) continue;
    if (!Number.isInteger(n) || n < 1 || n > BUILTIN_FLOORS.length) {
      REPLACEMENT_ERRORS.push(
        `level '${lv.meta.id}' replaces floor ${n}, which is not a built-in floor (want 1..${BUILTIN_FLOORS.length}) — it was appended instead`,
      );
      continue;
    }
    const first = out.get(n - 1);
    if (first) {
      REPLACEMENT_ERRORS.push(
        `levels '${first.meta.id}' and '${lv.meta.id}' both replace floor ${n} — '${lv.meta.id}' was appended instead`,
      );
      continue;
    }
    out.set(n - 1, lv);
  }
  return out;
})();

/** True when floor index `i` is a designer level standing in a built-in's slot. */
export const isReplacedFloor = (i: number): boolean => replacementFor.has(i);

/**
 * The running order: every built-in slot (filled by its replacement where one
 * claimed it), then every level that did not claim a slot, in `meta.order`.
 */
export const FLOORS: FloorDef[] = [
  ...BUILTIN_FLOORS.map((def, i) => {
    const lv = replacementFor.get(i);
    return lv ? levelToFloorDef(lv) : def;
  }),
  ...sortedCustoms
    .filter((lv) => replacementFor.get((lv.meta.replaces ?? 0) - 1) !== lv)
    .map(levelToFloorDef),
];

/** Parse an ASCII map into the walkability grid. Throws on malformed maps. */
export function buildSolid(map: string[]): boolean[][] {
  if (map.length !== TILES_Y) throw new Error(`map has ${map.length} rows, want ${TILES_Y}`);
  return map.map((row, y) => {
    if (row.length !== TILES_X) throw new Error(`map row ${y} has ${row.length} cols, want ${TILES_X}`);
    return [...row].map((c) => c === '#');
  });
}
