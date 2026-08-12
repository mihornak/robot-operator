/**
 * Lab tileset. Same 16px grid and same 3/4 read as the shipping tiles, but
 * drawn against the lab ramp (cool navy-slate) and with more variants, because
 * a lit room shows tiling repetition that a dark one hides.
 *
 * Everything stays LOW VALUE on purpose — the brightest pixel here is L.v8. All
 * the brightness in this scene arrives from the lightmap, so a tile that is
 * already bright has nowhere to go when a lamp hits it.
 */

import type { Px } from '../art/px';
import { L, M, W } from './palette';

/**
 * FLOOR VARIANT INDEX — scene.ts picks by number, so this list is a contract:
 *  0,1,2 plain deck panels (three grime seeds; the common case must not repeat)
 *  3     panel seam + hairline crack
 *  4     drain grate
 *  5     lifted panel, subfloor showing
 *  6     hazard walkway stripe — laid in CONTIGUOUS ROWS, never scattered
 *  7     old stain / scuffed patch
 */
const FLOOR_VARIANTS = 8;
const WALL_VARIANTS = 4;

export const FLOOR_PLAIN = [0, 1, 2] as const;
export const FLOOR_STRIPE = 6;

export const LAB_TILE_FRAMES = {
  floor: FLOOR_VARIANTS,
  wallFace: WALL_VARIANTS,
} as const;

/**
 * Panel seam. Deliberately NOT a step on the ramp — a full step down turns a
 * 30×16 floor into visible graph paper, and the eye finds the grid before it
 * finds anything in the room. This sits between v2 and v3 so the joint is
 * legible up close and gone at a glance.
 */
const SEAM = '#2f3945';

export function drawLabFloor(p: Px, frame: number): void {
  p.r(0, 0, 16, 16, L.v3);
  // Top and left edges only. Both edges plus the bottom draws a box, and a grid
  // of boxes reads as graph paper — the tile has to imply a joint, not draw one.
  p.hl(0, 0, 16, SEAM);
  p.vl(0, 1, 15, SEAM);
  p.scatter(1, 1, 15, 14, L.v2, 0.07, 11 + frame * 7);
  p.scatter(1, 1, 15, 14, L.v4, 0.05, 31 + frame * 13);

  if (frame === 1) {
    p.scatter(2, 2, 12, 12, L.v4, 0.06, 77);
    p.p(11, 4, L.v5);
    p.p(4, 11, L.v2);
  } else if (frame === 2) {
    p.scatter(1, 1, 14, 13, L.v2, 0.09, 181);
    p.p(6, 9, L.v4);
    p.p(13, 6, L.v4);
  } else if (frame === 6) {
    // Hazard walkway. The band is SOLID across the full tile width so a row of
    // these joins into one continuous painted line.
    //
    // The wear density is the whole design here. At 55% the eroded edge rows
    // stop reading as erosion and start forming glyph shapes — the first build
    // of this tile spelled nonsense words across the floor. Low, single-pixel
    // bites read as paint that has been walked off; anything denser reads as
    // type.
    p.hl(0, 6, 16, W.hazardSh);
    p.hl(0, 7, 16, W.hazard);
    p.hl(0, 8, 16, W.hazard);
    p.hl(0, 9, 16, W.hazardSh);
    p.scatter(0, 6, 16, 1, L.v3, 0.2, 53);
    p.scatter(0, 9, 16, 1, L.v3, 0.24, 59);
    p.scatter(0, 7, 16, 2, L.v4, 0.07, 61);
    p.p(4, 8, L.v4);
    p.p(11, 7, L.v4);
  } else if (frame === 7) {
    // A stain. Large soft blobs are what break up a tiled floor at a distance —
    // per-pixel grime only ever reads as film noise.
    p.disc(6, 8, 5, L.v2);
    p.disc(11, 5, 3, L.v2);
    p.scatter(1, 2, 14, 12, L.v3, 0.4, 233);
    p.scatter(2, 4, 11, 9, L.v1, 0.12, 251);
  } else if (frame === 3) {
    p.vl(8, 1, 14, L.v2);
    p.p(4, 4, L.v4);
    p.p(12, 12, L.v4);
    // hairline crack wandering off the seam
    p.p(7, 6, L.v1);
    p.p(6, 7, L.v1);
    p.p(5, 7, L.v2);
    p.p(4, 8, L.v1);
    p.p(3, 9, L.v1);
    p.p(2, 9, L.v2);
    p.p(2, 10, L.v1);
  } else if (frame === 4) {
    // Drain grate, recessed. The rim is the only place a highlight is allowed —
    // it's the one bit of geometry standing proud of the deck.
    p.scatter(2, 2, 12, 12, L.v2, 0.16, 97);
    p.box(3, 3, 10, 10, L.v4);
    p.r(4, 4, 8, 8, L.v1);
    p.hl(4, 4, 8, L.v0);
    for (let x = 5; x <= 11; x += 2) p.vl(x, 5, 7, L.v0);
    p.p(4, 12, L.v6);
    p.p(11, 3, L.v5);
  } else if (frame === 5) {
    // Lifted deck panel — subfloor and a run of conduit showing through.
    p.r(2, 3, 12, 10, L.v1);
    p.hl(2, 3, 12, L.v0);
    p.vl(2, 3, 10, L.v0);
    p.hl(2, 12, 12, L.v4); // far lip catches light
    p.hl(3, 7, 10, M.d2); // conduit
    p.hl(3, 8, 10, M.d0);
    p.p(5, 6, M.d3);
    p.p(10, 6, M.d3);
    p.scatter(3, 4, 10, 8, L.v2, 0.2, 131);
  }
}

/**
 * Wall face (south-facing). Variants: 0 plain panel + conduit, 1 vent grille,
 * 2 stencilled number + bolts, 3 damaged — panel torn off, framing behind.
 */
export function drawLabWallFace(p: Px, frame: number): void {
  p.r(0, 0, 16, 16, L.v5);
  p.hl(0, 0, 16, L.v8); // top edge catches the ceiling bounce
  p.hl(0, 1, 16, L.v6);
  p.hl(0, 13, 16, L.v4);
  p.hl(0, 14, 16, L.v2); // settles into its own contact shadow
  p.hl(0, 15, 16, L.v1);
  p.vl(0, 2, 11, L.v4);
  p.vl(15, 2, 11, L.v4);
  p.scatter(1, 2, 14, 11, L.v4, 0.06, 41 + frame * 17);
  p.scatter(1, 2, 14, 11, L.v6, 0.05, 61 + frame * 23);

  if (frame === 1) {
    // vent grille — framed slats, a whisper of depth
    p.box(2, 4, 10, 8, L.v4);
    p.r(3, 5, 8, 6, L.v2);
    p.hl(3, 5, 8, L.v1);
    p.hl(3, 6, 8, L.v6);
    p.hl(3, 7, 8, L.v1);
    p.hl(3, 8, 8, L.v6);
    p.hl(3, 9, 8, L.v1);
    p.p(13, 5, L.v6);
    p.p(13, 10, L.v6);
  } else if (frame === 2) {
    // stencilled bay number, dither-worn to barely-there, plus bolt heads
    p.p(3, 4, L.v7);
    p.p(4, 4, L.v7);
    p.p(4, 5, L.v7);
    p.p(4, 6, L.v7);
    p.p(4, 7, L.v7);
    p.p(3, 8, L.v7);
    p.p(4, 8, L.v7);
    p.p(5, 8, L.v7);
    p.p(7, 4, L.v7);
    p.p(8, 4, L.v7);
    p.p(9, 5, L.v7);
    p.p(8, 6, L.v7);
    p.p(7, 7, L.v7);
    p.p(7, 8, L.v7);
    p.p(8, 8, L.v7);
    p.p(9, 8, L.v7);
    p.scatter(3, 4, 7, 5, L.v5, 0.35, 211); // worn back into the paint
    p.p(13, 4, L.v7);
    p.p(13, 11, L.v7);
  } else if (frame === 3) {
    // Panel torn off. The one place the wall shows a warm material — the framing
    // behind it is old rusted steel, and it is the only rust on the wall runs.
    p.r(3, 3, 10, 9, L.v1);
    p.hl(3, 3, 10, L.v0);
    p.vl(3, 4, 8, L.v0);
    p.vl(6, 4, 8, W.rustSh);
    p.vl(7, 4, 8, W.rust);
    p.vl(10, 4, 8, W.rustSh);
    p.vl(11, 4, 8, W.rust);
    p.p(7, 6, W.rustHi);
    p.p(11, 9, W.rustHi);
    p.hl(3, 11, 10, L.v6); // the torn lip
    p.scatter(4, 4, 8, 7, L.v2, 0.18, 173);
  } else {
    // conduit run hugging the face; joins with neighbouring frame-0 faces
    p.hl(0, 9, 16, M.d3);
    p.hl(0, 10, 16, M.d1);
    p.vl(3, 8, 4, M.d4);
    p.vl(12, 8, 4, M.d4);
    p.p(2, 4, L.v6);
    p.p(13, 4, L.v6);
    p.p(2, 12, L.v3);
    p.p(13, 12, L.v3);
  }
}

/**
 * Wall top — the darkest surface in the room. It gets a girder run anyway,
 * because a large unbroken dark shape is the fastest way to make a lit room
 * look like a lit room with a hole in it. The relief is one step of the ramp;
 * you should read it as structure without ever looking at it directly.
 */
export function drawLabWallTop(p: Px, _frame: number): void {
  // Not the darkest value on the ramp. A block of near-black in the middle of a
  // lit floor reads as a HOLE, not as a solid standing in the way — and this
  // room is mostly free-standing pillars, so it would be full of holes. One
  // step up, with a girder run for relief, and the same block reads as mass.
  p.r(0, 0, 16, 16, L.v2);
  p.scatter(0, 0, 16, 16, L.v3, 0.1, 7);
  p.scatter(0, 0, 16, 16, L.v1, 0.1, 23);
  p.hl(0, 4, 16, L.v4); // girder, tiles into a continuous run
  p.hl(0, 5, 16, L.v0);
  p.hl(0, 12, 16, L.v4);
  p.hl(0, 13, 16, L.v0);
  p.p(3, 4, L.v5);
  p.p(11, 12, L.v5);
  p.p(7, 9, L.v1);
}

/** Soft contact shadow bleeding down from a wall onto the floor below it. */
export function drawLabTileShadow(p: Px, _frame: number): void {
  for (let y = 0; y < 16; y++) {
    const t = Math.max(0, 1 - y / 11);
    const a = 0.55 * t * t;
    if (a > 0.01) p.hl(0, y, 16, `rgba(0,0,0,${a.toFixed(3)})`);
  }
}
