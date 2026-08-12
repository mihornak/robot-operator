/**
 * THE SHOWCASE FLOOR — a hand-dressed derelict office bay, authored for one
 * purpose: to be looked at. It is not a playable floor and it obeys none of the
 * sim's walkability or pacing rules.
 *
 * Layout notes that matter to the LIGHTING, which is the actual subject here:
 *  - two enclosed alcoves (server room top-left, admin bay top-right) so there
 *    is geometry that light spills out of through a doorway
 *  - four free-standing pillar blocks in open floor, because a shadow only
 *    reads as a shadow when you can see all the way around the thing casting it
 *  - long clear sightlines down the middle, so a single lamp throws a shadow
 *    across half the room instead of dying against a wall two tiles away
 */

import { TILE } from '@shared/types';
import type { DecorName } from './decor';
import type { LightDef, Rect } from './lighting';
import { E } from './palette';

export const LAB_MAP: readonly string[] = [
  '##############################',
  '#............................#',
  '#..#######........########...#',
  '#..#.....#........#......#...#',
  '#..#.....#...............#...#',
  '#..###.###........########...#',
  '#............................#',
  '#............................#',
  '#.......####.......####......#',
  '#.......####.......####......#',
  '#............................#',
  '#............................#',
  '#....####..........####......#',
  '#....####..........####......#',
  '#............................#',
  '##############################',
];

export interface Placement {
  name: DecorName;
  /** Tile coords, fractional. Converted to px at build time. */
  tx: number;
  ty: number;
  flip?: boolean;
  /** Footprint that blocks light, in px, centred on the anchor. Omit for flat props. */
  foot?: [number, number];
  /** Wet-floor reflection under this prop. */
  reflect?: boolean;
  /** Draw above everything (ceiling fixtures). */
  ceiling?: boolean;
  /**
   * For ceiling lamps: the id of the light this fixture belongs to. It is what
   * lets the panel address one lamp at a time, and it keeps the SPRITE and the
   * LIGHT separable — swapping a fixture's style never touches the rig.
   */
  fixtureId?: string;
  /** Which control group owns this fixture. Defaults to 'ceiling'. */
  fixtureKind?: 'ceiling' | 'wall';
}

const px = (t: number): number => t * TILE + TILE / 2;

/**
 * Dressing. Order is irrelevant — the scene y-sorts. What matters is DENSITY:
 * an empty box with four nice props in it still reads as an empty box, so the
 * walls are lined and the open floor is littered. Roughly a prop every three
 * tiles along any wall, and nothing at all in the two main sightlines.
 */
export const LAB_DECOR: readonly Placement[] = [
  // --- north wall run ---
  { name: 'shelf_unit', tx: 4.2, ty: 1.35, foot: [28, 8], reflect: true },
  { name: 'server_rack', tx: 7.5, ty: 1.4, foot: [18, 8], reflect: true },
  { name: 'server_rack', tx: 9.0, ty: 1.4, foot: [18, 8], reflect: true },
  { name: 'terminal', tx: 11.2, ty: 1.4, foot: [16, 6] },
  { name: 'desk', tx: 13.8, ty: 1.45, foot: [24, 10], reflect: true },
  { name: 'chair_wreck', tx: 13.6, ty: 2.2 },
  { name: 'filing_cabinet', tx: 16.4, ty: 1.4, foot: [12, 6] },
  { name: 'boxes', tx: 22.6, ty: 1.4, foot: [16, 8] },
  { name: 'crate_stack', tx: 24.2, ty: 1.45, foot: [18, 8] },
  { name: 'exit_sign', tx: 26.5, ty: 1.05, ceiling: true },

  // --- server room (top-left alcove) ---
  { name: 'server_rack', tx: 4.8, ty: 3.7, foot: [18, 8], reflect: true },
  { name: 'server_rack', tx: 6.1, ty: 3.7, foot: [18, 8], reflect: true },
  { name: 'server_rack', tx: 7.4, ty: 3.7, foot: [18, 8], reflect: true },
  { name: 'floor_strip', tx: 6.1, ty: 4.7 },
  { name: 'cable_coil', tx: 4.6, ty: 4.6 },

  // --- admin bay (top-right alcove) ---
  { name: 'desk', tx: 20.2, ty: 3.6, foot: [24, 10], reflect: true },
  { name: 'terminal', tx: 20.4, ty: 3.1, foot: [16, 6] },
  { name: 'chair_wreck', tx: 21.6, ty: 4.3 },
  { name: 'filing_cabinet', tx: 23.3, ty: 3.7, foot: [12, 6] },
  { name: 'paper_scatter', tx: 22.2, ty: 4.6 },

  // --- middle band, the long sightline: only FLAT props here ---
  { name: 'pallet', tx: 2.6, ty: 6.6 },
  { name: 'barrel', tx: 2.3, ty: 7.6, foot: [11, 6], reflect: true },
  { name: 'barrel', tx: 3.4, ty: 7.8, foot: [11, 6], reflect: true },
  { name: 'rubble', tx: 12.6, ty: 6.5 },
  { name: 'ceiling_tile', tx: 14.2, ty: 7.2 },
  { name: 'puddle', tx: 17.4, ty: 7.4 },
  { name: 'cable_coil', tx: 10.2, ty: 7.6 },
  { name: 'paper_scatter', tx: 20.6, ty: 6.4 },
  { name: 'plant_dead', tx: 26.4, ty: 6.6, foot: [10, 6], reflect: true },
  { name: 'vending', tx: 27.0, ty: 4.9, foot: [16, 8], reflect: true },

  // --- pillar row (y 8..9) ---
  { name: 'boxes', tx: 3.2, ty: 9.5, foot: [16, 8] },
  { name: 'crate_stack', tx: 5.0, ty: 8.6, foot: [18, 8], reflect: true },
  { name: 'desk_toppled', tx: 15.4, ty: 9.6, foot: [22, 10] },
  { name: 'barrel', tx: 24.8, ty: 8.5, foot: [11, 6], reflect: true },
  { name: 'pipe_run', tx: 27.0, ty: 9.7 },
  { name: 'rubble', tx: 12.4, ty: 9.3 },

  // --- lower open band ---
  { name: 'desk', tx: 8.3, ty: 11.4, foot: [24, 10], reflect: true },
  { name: 'chair_wreck', tx: 9.6, ty: 11.7 },
  { name: 'puddle', tx: 14.2, ty: 11.2 },
  { name: 'sparks_box', tx: 19.6, ty: 10.7, foot: [10, 5] },
  { name: 'alarm_strobe', tx: 28.3, ty: 10.6, ceiling: true },
  { name: 'terminal', tx: 24.4, ty: 11.3, foot: [16, 6] },

  // --- south wall run ---
  { name: 'shelf_unit', tx: 2.6, ty: 14.5, foot: [28, 8], reflect: true },
  { name: 'rubble', tx: 6.8, ty: 14.6 },
  { name: 'paper_scatter', tx: 8.0, ty: 14.3 },
  { name: 'pallet', tx: 11.6, ty: 14.7 },
  { name: 'boxes', tx: 13.2, ty: 13.6, foot: [16, 8] },
  { name: 'plant_dead', tx: 17.4, ty: 14.5, foot: [10, 6], reflect: true },
  { name: 'crate_stack', tx: 24.6, ty: 14.4, foot: [18, 8], reflect: true },
  { name: 'floor_strip', tx: 20.4, ty: 14.6 },
  { name: 'cable_coil', tx: 22.2, ty: 14.7 },

  // --- the dark bottom-left ---
  // Same treatment as the right third, for the same reason: the light rebalance
  // turned this quadrant into a rest for the eye, and a rest still needs an
  // edge in it. Tall shapes against the west wall, no light added.
  { name: 'pipe_bank', tx: 1.7, ty: 12.6, foot: [20, 8] },
  { name: 'locker_row', tx: 5.8, ty: 14.6, foot: [24, 8] },
  // The only soft mass in the level, and the only outline in it that isn't a
  // rectangle — which is exactly why it goes in the quadrant made of boxes.
  { name: 'coat_rack', tx: 2.4, ty: 10.9, foot: [8, 4] },
  { name: 'trolley', tx: 5.2, ty: 11.6, foot: [18, 6] },
  { name: 'floor_strip', tx: 3.4, ty: 13.9 },

  // --- the dark right third ---
  // The advisor's note on this corner was that the DIMNESS is correct — a frame
  // needs somewhere for the eye to rest — and that what it actually lacked was
  // a readable silhouette. So: tall shapes, no extra key light. A dark corner
  // with an outline in it is composition; a dark corner with nothing in it is
  // an unfinished level.
  { name: 'pipe_bank', tx: 27.6, ty: 8.9, foot: [22, 8] },
  { name: 'breaker_panel', tx: 28.4, ty: 5.7, foot: [10, 4] },
  { name: 'locker_row', tx: 25.2, ty: 13.9, foot: [24, 8], reflect: true },
  { name: 'water_cooler', tx: 23.2, ty: 11.1, foot: [8, 5] },
  { name: 'floor_fan', tx: 27.2, ty: 11.7, foot: [12, 5] },
  // and one on the south pillar face, mid-frame, so the bottom band has a
  // horizontal to read against all the verticals
  { name: 'whiteboard', tx: 20.6, ty: 13.9 },

  // --- wall-mounted fixtures ---
  //
  // With the ceiling fixtures switched off, these are the only visible source
  // of light in the room, so there are enough of them to explain it.
  //
  // Every one sits on a SOUTH-FACING wall face — a solid tile with open floor
  // below it, which is the only vertical surface this projection actually
  // draws. The left and right walls render as wall TOPS (their southern
  // neighbour is also solid), which is why the old lamp on the west wall never
  // read: there was no face under it to mount on.
  { name: 'wall_lamp', tx: 19.4, ty: 5.62, ceiling: true, fixtureId: 'wall_admin_1', fixtureKind: 'wall' },
  { name: 'wall_lamp', tx: 22.0, ty: 5.62, ceiling: true, fixtureId: 'wall_admin_2', fixtureKind: 'wall' },
  { name: 'wall_lamp', tx: 24.6, ty: 5.62, ceiling: true, fixtureId: 'wall_admin_3', fixtureKind: 'wall' },
  { name: 'wall_lamp', tx: 4.3, ty: 5.62, ceiling: true, fixtureId: 'wall_server_1', fixtureKind: 'wall' },
  { name: 'wall_lamp', tx: 8.4, ty: 5.62, ceiling: true, fixtureId: 'wall_server_2', fixtureKind: 'wall' },
  { name: 'wall_lamp', tx: 9.5, ty: 9.62, ceiling: true, fixtureId: 'wall_pillar_1', fixtureKind: 'wall' },
  { name: 'wall_lamp', tx: 20.5, ty: 9.62, ceiling: true, fixtureId: 'wall_pillar_2', fixtureKind: 'wall' },
  { name: 'wall_lamp', tx: 6.5, ty: 13.62, ceiling: true, fixtureId: 'wall_pillar_3', fixtureKind: 'wall' },

  // --- ceiling fixtures, drawn over everything ---
  { name: 'ceiling_lamp', tx: 6.5, ty: 6.5, ceiling: true, fixtureId: 'tube_a' },
  { name: 'ceiling_lamp', tx: 16.5, ty: 6.5, ceiling: true, fixtureId: 'tube_b' },
  { name: 'ceiling_lamp', tx: 25.5, ty: 6.5, ceiling: true, fixtureId: 'tube_c' },
  { name: 'ceiling_lamp', tx: 13.5, ty: 12.5, ceiling: true, fixtureId: 'tube_d' },
  { name: 'ceiling_lamp', tx: 6.1, ty: 3.4, ceiling: true, fixtureId: 'tube_server' },
  { name: 'ceiling_lamp', tx: 21.5, ty: 3.4, ceiling: true, fixtureId: 'tube_admin' },
];

/**
 * The lighting rig, built around ONE diagonal.
 *
 * The room gets a bright corner (top-left: tube_a, the server-room fill and the
 * raking cone — the best hundred pixels in the frame), a hero over the middle
 * (tube_b), and a dark corner at the right where the vending machine is the only
 * thing that reads. Everything off that line is deliberately held 30-60% down.
 *
 * The failure mode this replaces: seven tubes at polite, similar intensities,
 * which is a ceiling grid — accurate to a real office and worthless as a shot.
 * Ten medium corners is not art direction. A bright one, a dark one, and a line
 * between them is.
 *
 * Only the big ones cast; a status LED throwing a room-length shadow looks
 * absurd and costs a full-screen bake.
 */
export const LAB_LIGHTS: readonly LightDef[] = [
  // --- key: the ceiling tubes ---
  // Five, not seven, and each one stronger. Seven overlapping pools at polite
  // intensities is a uniformly lit room with slightly brighter spots in it —
  // which is exactly what a ceiling grid looks like in an office, and exactly
  // what nobody puts on a key-art screenshot. Fewer, hotter, further apart.
  { id: 'tube_a', x: px(6.5), y: px(6.5), radius: 152, color: E.key, intensity: 1.25, castShadow: true, flicker: 0.15, flickerHz: 7 },
  { id: 'tube_b', x: px(16.5), y: px(6.5), radius: 170, color: E.key, intensity: 1.7, castShadow: true },
  { id: 'tube_c', x: px(25.5), y: px(6.5), radius: 118, color: E.key, intensity: 0.45, castShadow: true, flicker: 0.9, flickerHz: 11 },
  { id: 'tube_d', x: px(13.5), y: px(12.5), radius: 140, color: E.key, intensity: 0.62, castShadow: true },
  // alcove tubes — colder, so the rooms read as separate spaces from the bay
  { id: 'tube_server', x: px(6.1), y: px(3.4), radius: 92, color: E.fill, intensity: 1.15, castShadow: true },
  { id: 'tube_admin', x: px(21.5), y: px(3.4), radius: 96, color: E.key, intensity: 0.6, castShadow: true },

  // --- cone wall lamps, raking the floor ---
  { id: 'cone_a', x: px(6.5), y: px(5.9), radius: 128, color: E.key, intensity: 0.5, kind: 'cone', dir: Math.PI / 2, spread: 0.75, castShadow: true },
  { id: 'cone_b', x: px(20.5), y: px(5.9), radius: 120, color: E.fillCore, intensity: 0.25, kind: 'cone', dir: Math.PI / 2, spread: 0.8, castShadow: true },
  // Re-aimed down the diagonal rather than straight across. The bottom-left
  // went fully black once tube_d dropped and tube_e was deleted, and the fix
  // for a dark corner is never fill — fill just makes it a grey corner. A cone
  // raking it at a grazing angle catches the TOPS of the pipe bank, the lockers
  // and the coat rack and leaves the floor dark, which is the whole point: you
  // get silhouettes back without spending the black point on them.
  { id: 'cone_c', x: px(1.4), y: px(10.6), radius: 132, color: E.key, intensity: 0.5, kind: 'cone', dir: 0.72, spread: 0.62, castShadow: true },

  // --- wall sconces ---
  // One per fixture, cones aimed straight down the wall so the pool lands in
  // front of the housing. Small radius and modest intensity: eight of these
  // plus the ceiling rig would flatten the room, and the ceiling rig is still
  // there — only its SPRITES are switched off.
  { id: 'wall_admin_1', x: px(19.4), y: px(5.9), radius: 62, color: E.key, intensity: 0.5, kind: 'cone', dir: Math.PI / 2, spread: 0.85, castShadow: false },
  { id: 'wall_admin_2', x: px(22.0), y: px(5.9), radius: 62, color: E.key, intensity: 0.5, kind: 'cone', dir: Math.PI / 2, spread: 0.85, castShadow: false },
  { id: 'wall_admin_3', x: px(24.6), y: px(5.9), radius: 58, color: E.key, intensity: 0.42, kind: 'cone', dir: Math.PI / 2, spread: 0.85, castShadow: false, flicker: 0.5, flickerHz: 13 },
  { id: 'wall_server_1', x: px(4.3), y: px(5.9), radius: 58, color: E.fill, intensity: 0.45, kind: 'cone', dir: Math.PI / 2, spread: 0.85, castShadow: false },
  { id: 'wall_server_2', x: px(8.4), y: px(5.9), radius: 58, color: E.fill, intensity: 0.45, kind: 'cone', dir: Math.PI / 2, spread: 0.85, castShadow: false },
  { id: 'wall_pillar_1', x: px(9.5), y: px(9.9), radius: 66, color: E.key, intensity: 0.5, kind: 'cone', dir: Math.PI / 2, spread: 0.85, castShadow: false },
  { id: 'wall_pillar_2', x: px(20.5), y: px(9.9), radius: 66, color: E.key, intensity: 0.5, kind: 'cone', dir: Math.PI / 2, spread: 0.85, castShadow: false },
  { id: 'wall_pillar_3', x: px(6.5), y: px(13.9), radius: 60, color: E.key, intensity: 0.45, kind: 'cone', dir: Math.PI / 2, spread: 0.85, castShadow: false },

  // A sconce's own cone starts BELOW it and points away, so the housing sits
  // outside its own light and gets multiplied down to nothing. These co-located
  // points fix that — and they do a second job that turned out to matter more:
  // a cone lights the FLOOR and nothing else, so with only cones the wall a
  // lamp is bolted to, and any prop standing beside it, stayed black while the
  // floor in front blazed. Radius here is what washes the wall. Tunable per
  // fixture as `wall spill`.
  { id: 'wall_admin_1_pt', x: px(19.4), y: px(5.7), radius: 48, color: E.key, intensity: 0.55, castShadow: false, volumetric: false },
  { id: 'wall_admin_2_pt', x: px(22.0), y: px(5.7), radius: 48, color: E.key, intensity: 0.55, castShadow: false, volumetric: false },
  { id: 'wall_admin_3_pt', x: px(24.6), y: px(5.7), radius: 44, color: E.key, intensity: 0.45, castShadow: false, volumetric: false, flicker: 0.5, flickerHz: 13 },
  { id: 'wall_server_1_pt', x: px(4.3), y: px(5.7), radius: 44, color: E.fill, intensity: 0.5, castShadow: false, volumetric: false },
  { id: 'wall_server_2_pt', x: px(8.4), y: px(5.7), radius: 44, color: E.fill, intensity: 0.5, castShadow: false, volumetric: false },
  { id: 'wall_pillar_1_pt', x: px(9.5), y: px(9.7), radius: 48, color: E.key, intensity: 0.55, castShadow: false, volumetric: false },
  { id: 'wall_pillar_2_pt', x: px(20.5), y: px(9.7), radius: 48, color: E.key, intensity: 0.55, castShadow: false, volumetric: false },
  { id: 'wall_pillar_3_pt', x: px(6.5), y: px(13.7), radius: 44, color: E.key, intensity: 0.5, castShadow: false, volumetric: false },

  // --- accents: cheap, no shadow pass ---
  { id: 'rack_1', x: px(7.5), y: px(1.6), radius: 34, color: E.accent, intensity: 0.7, castShadow: false, flicker: 0.5, flickerHz: 14 },
  { id: 'rack_2', x: px(9.0), y: px(1.6), radius: 34, color: E.accent, intensity: 0.7, castShadow: false, flicker: 0.4, flickerHz: 17 },
  { id: 'rack_3', x: px(4.8), y: px(3.9), radius: 32, color: E.accent, intensity: 0.8, castShadow: false, flicker: 0.5, flickerHz: 13 },
  { id: 'rack_4', x: px(6.1), y: px(3.9), radius: 32, color: E.accent, intensity: 0.8, castShadow: false, flicker: 0.35, flickerHz: 19 },
  { id: 'rack_5', x: px(7.4), y: px(3.9), radius: 32, color: E.accent, intensity: 0.8, castShadow: false, flicker: 0.6, flickerHz: 11 },
  { id: 'term_1', x: px(11.2), y: px(1.5), radius: 40, color: E.screen, intensity: 0.6, castShadow: false, flicker: 0.2, flickerHz: 24 },
  { id: 'term_2', x: px(20.4), y: px(3.2), radius: 40, color: E.screen, intensity: 0.6, castShadow: false, flicker: 0.2, flickerHz: 21 },
  { id: 'term_3', x: px(24.4), y: px(11.4), radius: 40, color: E.screen, intensity: 0.55, castShadow: false, flicker: 0.25, flickerHz: 26 },
  { id: 'vend', x: px(27.0), y: px(5.2), radius: 68, color: E.fill, intensity: 1.0, castShadow: true, flicker: 0.15, flickerHz: 6 },
  { id: 'exit', x: px(26.5), y: px(1.2), radius: 36, color: E.accent, intensity: 0.6, castShadow: false },
  { id: 'strobe', x: px(28.3), y: px(10.7), radius: 66, color: E.hazard, intensity: 0.9, castShadow: false, flicker: 1.6, flickerHz: 3.2 },
  { id: 'sparks', x: px(19.6), y: px(10.6), radius: 58, color: E.fillCore, intensity: 0.8, castShadow: false, flicker: 1.8, flickerHz: 22 },
  { id: 'strip_1', x: px(6.1), y: px(4.8), radius: 34, color: E.accent, intensity: 0.5, castShadow: false },
  { id: 'strip_2', x: px(20.4), y: px(14.7), radius: 34, color: E.accent, intensity: 0.5, castShadow: false },
  { id: 'strip_3', x: px(3.4), y: px(14.0), radius: 38, color: E.accent, intensity: 0.55, castShadow: false },
  // The breaker panel is the one emissive prop with no light of its own, which
  // stopped mattering the moment emissives moved inside the lightmap multiply.
  { id: 'breaker', x: px(28.4), y: px(5.4), radius: 30, color: E.accent, intensity: 0.5, castShadow: false, flicker: 0.6, flickerHz: 15 },
];

/**
 * WET FLOOR. Reflections used to be drawn under every prop that asked for one,
 * everywhere, which is the tell of a graphics demo: a whole floor cannot be a
 * mirror, and when it is, nothing on it reads as wet. These ellipses (tile
 * coords, tile radii) are the only places the deck holds water — the reflection
 * layer is masked to them, so a prop reflects only if it happens to stand in
 * one. Placed where a ceiling has failed and where the drains are.
 */
export const WET_PATCHES: ReadonlyArray<{ tx: number; ty: number; rx: number; ry: number }> = [
  { tx: 17.4, ty: 7.4, rx: 2.6, ry: 1.3 }, // the two authored puddles, widened
  { tx: 14.2, ty: 11.2, rx: 2.8, ry: 1.4 },
  { tx: 3.0, ty: 7.9, rx: 2.4, ry: 1.5 }, // under the barrels — something leaked
  { tx: 26.6, ty: 6.9, rx: 2.2, ry: 1.4 }, // the dead plant was over-watered once
  { tx: 6.1, ty: 4.4, rx: 3.0, ry: 1.1 }, // server room, along the racks
  { tx: 24.6, ty: 14.2, rx: 2.4, ry: 1.2 },
  { tx: 8.3, ty: 11.8, rx: 2.6, ry: 1.2 },
];

/** Wall occluders, merged into horizontal runs so the shadow pass has fewer rects. */
export function wallOccluders(map: readonly string[]): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y < map.length; y++) {
    const row = map[y]!;
    let run = -1;
    for (let x = 0; x <= row.length; x++) {
      const solid = row[x] === '#';
      if (solid && run < 0) run = x;
      if (!solid && run >= 0) {
        out.push({ x: run * TILE, y: y * TILE, w: (x - run) * TILE, h: TILE });
        run = -1;
      }
    }
  }
  return out;
}
