/** World tiles. The world is DIM — contrast between shades stays whisper-low. */

import { G } from './palette';
import type { Px } from './px';

/** Worn walkway paint — cold gray-blue, whisper contrast (never yellow). */
const PAINT = '#2f3844';
const PAINT_DIM = '#262d37';

/**
 * tile_floor, 4 variants:
 *  0 plain panel (common), 1 worn walkway-stripe fragment (world.ts lays these
 *  along one row so they join into a faded line), 2 sub-panel seam + hairline
 *  crack, 3 drain grate (rare). Grid stays readable — everything whisper-low.
 */
export function drawFloor(p: Px, frame: number): void {
  p.r(0, 0, 16, 16, G.g2);
  // panel seam along top+left — tiles into a faint grid at 1x
  p.hl(0, 0, 16, G.g1);
  p.vl(0, 1, 15, G.g1);
  // two whisper-quiet grime tones, different scatter per variant
  p.scatter(1, 1, 15, 15, G.g1, 0.07, 11 + frame * 7);
  p.scatter(1, 1, 15, 15, G.g3, 0.05, 31 + frame * 13);
  if (frame === 1) {
    // walkway stripe fragment — fixed y so neighbors join into a painted line,
    // then flaked back to the deck so it reads as decades old
    p.hl(0, 7, 16, PAINT);
    p.hl(0, 8, 16, PAINT_DIM);
    p.scatter(0, 7, 16, 2, G.g2, 0.38, 53);
    p.hl(4, 10, 4, G.g3); // drag scuff alongside
  } else if (frame === 2) {
    // sub-panel seam + rivet dots
    p.vl(8, 1, 15, G.g1);
    p.p(4, 4, G.g3);
    p.p(12, 12, G.g3);
    // hairline crack wandering off the seam
    p.p(7, 6, G.g1);
    p.p(6, 7, G.g1);
    p.p(5, 7, G.g3);
    p.p(4, 8, G.g1);
    p.p(3, 9, G.g1);
    p.p(2, 9, G.g3);
  } else if (frame === 3) {
    // drain grate, recessed, damp ring bleeding out around it
    p.scatter(2, 2, 12, 12, G.g1, 0.14, 97);
    p.box(3, 3, 10, 10, G.g3); // rim
    p.r(4, 4, 8, 8, G.g1); // recess
    p.hl(4, 4, 8, G.g0); // inner shadow at top
    for (let x = 5; x <= 11; x += 2) p.vl(x, 5, 7, G.g0); // slots
    p.p(4, 12, G.g4); // worn rim corner catches the light
  }
}

/** tile_wall_face, 2 variants: south-facing face, top highlight line. */
export function drawWallFace(p: Px, frame: number): void {
  p.r(0, 0, 16, 16, G.g4);
  p.hl(0, 0, 16, G.g7); // light catches the top edge
  p.hl(0, 1, 16, G.g5);
  p.hl(0, 14, 16, G.g3); // settles into its own shadow
  p.hl(0, 15, 16, G.g1);
  // vertical panel seams
  p.vl(0, 2, 12, G.g3);
  p.vl(8, 2, 12, G.g3);
  p.vl(15, 2, 12, G.g3);
  p.scatter(1, 2, 14, 12, G.g3, 0.05, 41 + frame * 17);
  p.scatter(1, 2, 14, 12, G.g5, 0.05, 61 + frame * 23);
  if (frame === 1) {
    // vent grille — framed slats with a whisper of depth
    p.box(2, 4, 8, 7, G.g3);
    p.r(3, 5, 6, 5, G.g2);
    p.hl(3, 5, 6, G.g1);
    p.hl(3, 6, 6, G.g5); // slat lip catching the top light
    p.hl(3, 7, 6, G.g1);
    p.hl(3, 8, 6, G.g5);
    p.hl(3, 9, 6, G.g1);
    // faded stencil digit, dither-worn to barely-there
    p.p(12, 4, G.g6);
    p.p(13, 4, G.g5);
    p.p(13, 5, G.g6);
    p.p(12, 6, G.g5);
    p.p(13, 7, G.g6);
    p.p(11, 8, G.g5);
    p.p(12, 8, G.g6);
    // scuff
    p.p(12, 11, G.g2);
    p.p(13, 11, G.g2);
  } else {
    // hazard-worn bolt heads
    p.p(2, 4, G.g6);
    p.p(13, 4, G.g6);
    // conduit run — thin pipe hugging the face, tiny brackets; joins up with
    // neighboring frame-0 faces into longer runs
    p.hl(0, 10, 16, G.g5);
    p.hl(0, 11, 16, G.g2); // underside shadow
    p.vl(3, 9, 3, G.g6); // brackets
    p.vl(12, 9, 3, G.g6);
    p.p(2, 12, G.g2);
    p.p(13, 12, G.g2);
  }
}

/** tile_wall_top: darkest thing in the world. */
export function drawWallTop(p: Px, _frame: number): void {
  p.r(0, 0, 16, 16, G.g0);
  p.scatter(0, 0, 16, 16, G.g1, 0.08, 7);
}

/** tile_shadow: soft alpha gradient, strongest at top (contact under walls). */
export function drawTileShadow(p: Px, _frame: number): void {
  for (let y = 0; y < 16; y++) {
    const t = Math.max(0, 1 - y / 10);
    const a = 0.42 * t * t;
    if (a > 0.01) p.hl(0, y, 16, `rgba(0,0,0,${a.toFixed(3)})`);
  }
}
