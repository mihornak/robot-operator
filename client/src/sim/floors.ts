/**
 * The five authored floors (GAME_SPEC §8 / FIRST_MINUTES beats).
 * ASCII maps: '#'=wall, '.'=floor, TILES_X × TILES_Y of TILE px.
 * Elevator A (spawn) and B (exit) sit on OPPOSITE sides — the zigzag.
 * Sides alternate per floor: ride up shaft B, arrive next floor at that side's A.
 * Entity ids here are PINNED — the director references them exactly.
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

const elevA = (pos: Vec): Entity => ({ id: 'elevA', kind: 'elevatorA', pos, label: 'elevator A', state: 'inert' });
const elevB = (pos: Vec, dark = false): Entity => ({
  id: 'elevB',
  kind: 'elevatorB',
  pos,
  label: 'elevator B',
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
const socket = (id: string, pos: Vec): Entity => ({ id, kind: 'fuseSocket', pos, label: 'fuse socket', state: 'empty' });

// ---------------------------------------------------------------- floors

export const FLOORS: FloorDef[] = [
  // Floor 1 (index 0) — L-shape zigzag lesson: A bottom-left, B top-right.
  {
    map: [
      '##############################',
      '################.............#',
      '################.............#',
      '################.............#',
      '################.............#',
      '################.............#',
      '################.............#',
      '################.............#',
      '################.............#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '##############################',
    ],
    entities: () => [elevA(at(2, 12)), elevB(at(27, 2)), scrap('scrap1', at(22, 11))],
  },

  // Floor 2 (index 1) — first triad, cable across the B approach. A right, B left.
  {
    map: [
      '##############################',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#......##..........##........#',
      '#......##..........##........#',
      '#............................#',
      '#............................#',
      '#............................#',
      '##############################',
    ],
    entities: () => [
      elevA(at(27, 8)),
      elevB(at(2, 8)),
      crate('crate_MAGNET', at(12, 4), 'MAGNET'),
      crate('crate_RAGE', at(15, 4), 'RAGE'),
      crate('crate_SCARED', at(18, 4), 'SCARED'),
      cable('cable1', at(7, 8)),
      scrap('scrap1', at(20, 13)),
    ],
  },

  // Floor 3 (index 2) — NEW EARS + first fused printer. A left, B right.
  {
    map: [
      '##############################',
      '#............................#',
      '#............................#',
      '#.........####...............#',
      '#.........####...............#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#..............####..........#',
      '#..............####..........#',
      '#............................#',
      '#............................#',
      '#............................#',
      '##############################',
    ],
    entities: () => [
      elevA(at(2, 8)),
      elevB(at(27, 8)),
      crate('crate_EARS', at(6, 8)),
      printer('printer1', at(16, 6), 3),
      innocent('printer_nice', at(26, 13)),
      cable('cable1', at(20, 8)),
      scrap('scrap1', at(7, 3)),
      scrap('scrap2', at(24, 8)),
    ],
  },

  // Floor 4 (index 3) — composition: printer + cable + fuse; elevB dark until fused. A right, B left.
  {
    map: [
      '##############################',
      '#............................#',
      '#............................#',
      '#............................#',
      '#........####................#',
      '#........####................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#.................####.......#',
      '#.................####.......#',
      '#............................#',
      '#............................#',
      '#............................#',
      '##############################',
    ],
    entities: () => [
      elevA(at(27, 8)),
      elevB(at(2, 8), true),
      socket('socket1', at(2, 6)),
      fuse('fuse1', at(24, 3)),
      printer('printer1', at(14, 8), 4),
      cable('cable1', at(8, 8)),
      mop('mop1', at(14, 12)),
      scrap('scrap1', at(20, 12)),
    ],
  },

  // Floor 5 (index 4) — second triad, victory lap, no enemies. A left, B right.
  {
    map: [
      '##############################',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#.....##..............##.....#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '##############################',
    ],
    entities: () => [
      elevA(at(2, 8)),
      elevB(at(27, 8)),
      crate('crate_MEMORY', at(12, 5), 'MEMORY'),
      crate('crate_ZAP', at(15, 5), 'ZAP'),
      crate('crate_TOUGH', at(18, 5), 'TOUGH'),
      scrap('scrap1', at(8, 12)),
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
