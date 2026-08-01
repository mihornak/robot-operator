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

export const FLOORS: FloorDef[] = [
  // Floor 1 (index 0) — the zigzag lesson: A bottom-left, B top-right.
  // L-shape kept; a support-pillar colonnade slaloms the bottom arm and a
  // 3-wide alcove (scrap inside) rewards poking off the main line.
  {
    map: [
      '##############################',
      '#################...........##',
      '#################...........##',
      '#################...........##',
      '#################...........##',
      '#################...........##',
      '####...##########...........##',
      '####...##########...........##',
      '####...##########...........##',
      '#............................#',
      '#............................#',
      '#.........##....##...........#',
      '#.........##....##...........#',
      '#............................#',
      '#............................#',
      '##############################',
    ],
    entities: () => [elevA(at(2, 12)), elevB(at(27, 2)), scrap('scrap1', at(5, 7))],
  },

  // Floor 2 (index 1) — first triad. A right, B left. Offset rooms: a small
  // antechamber (right), doorway into the main hall, shiny crate in a top
  // niche (pedestal dressing is render's job), stub walls funnel the B
  // approach through a gate the cable guards — hug the top of the gate or fry.
  // elevB dark until the triad resolves (director calls powerElevatorB).
  {
    map: [
      '##############################',
      '########.....#################',
      '########.....#################',
      '#...##..............##########',
      '#...##..............##########',
      '#...##..............#........#',
      '#...................#........#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#...##..............#........#',
      '#...##..............#........#',
      '#...##..............##########',
      '#...##..............##########',
      '#...##..............##########',
      '##############################',
    ],
    entities: () => [
      elevA(at(27, 8)),
      elevB(at(2, 8), true),
      triadCrate(at(10, 1)), // in the niche, off the A→B line — the dark elevator forces the detour
      cable('cable1', at(4, 8)),
      scrap('scrap1', at(16, 12)),
    ],
  },

  // Floor 3 (index 2) — NEW EARS + first fused printer. A left, B right.
  // Two lanes: a thin wall splits corridor (top, elevators + EARS crate at the
  // entry) from the open bay (bottom, printer turf). One 3-wide gap connects
  // them — the innocent printer sits in view straight through it.
  {
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
      elevB(at(27, 3)),
      crate('crate_EARS', at(5, 3)), // right at the entry lane
      printer('printer1', at(9, 10), 3),
      innocent('printer_nice', at(15, 12)), // framed by the gap, seen from the corridor
      cable('cable1', at(21, 10)),
      scrap('scrap1', at(11, 3)),
      scrap('scrap2', at(25, 12)), // bait: straight line from the gap crosses the cable
    ],
  },

  // Floor 4 (index 3) — the gauntlet. A right, B left (dark until fused).
  // Two pillar colonnades + a center cover block carve three lanes between
  // fuse (top-right) and socket (left). Cable blocks the middle cut through
  // the left colonnade — route choice matters, printer roams mid-right.
  {
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
      elevB(at(2, 8), true),
      socket('socket1', at(2, 5)),
      fuse('fuse1', at(25, 3)),
      printer('printer1', at(19, 7), 4),
      cable('cable1', at(8, 7)), // middle cut of the left colonnade — squeeze low or detour
      mop('mop1', at(14, 12)),
      scrap('scrap1', at(23, 12)),
    ],
  },

  // Floor 5 (index 4) — second triad, victory lap, no enemies. A left, B right.
  // Wide hall, center island (C-shaped pedestal open toward A) with the shiny
  // crate ON it — render spot-lights it. The island blocks the straight A→B
  // line, so the floor plays as a lap; scraps dot the lap path.
  // elevB dark until the triad resolves (powerElevatorB), same as floor 2.
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
      triadCrate(at(14.5, 7.5)), // dead center of the island pocket (240,128)
      scrap('scrap1', at(7, 3)),
      scrap('scrap2', at(22, 12)),
    ],
  },
];

/** Parse an ASCII map into the walkability grid. Throws on malformed maps. */
export function buildSolid(map: string[]): boolean[][] {
  if (map.length !== TILES_Y) throw new Error(`map has ${map.length} rows, want ${TILES_Y}`);
  return map.map((row, y) => {
    if (row.length !== TILES_X) throw new Error(`map row ${y} has ${row.length} cols, want ${TILES_X}`);
    return [...row].map((c) => c === '#');
  });
}
