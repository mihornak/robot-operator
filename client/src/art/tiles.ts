/** World tiles. The world is DIM — contrast between shades stays whisper-low. */

import { G } from './palette';
import type { Px } from './px';

/** tile_floor, 4 variants: dark panels, subtle grime/panel-line variation. */
export function drawFloor(p: Px, frame: number): void {
  p.r(0, 0, 16, 16, G.g2);
  // panel seam along top+left — tiles into a faint grid at 1x
  p.hl(0, 0, 16, G.g1);
  p.vl(0, 1, 15, G.g1);
  // two whisper-quiet grime tones, different scatter per variant
  p.scatter(1, 1, 15, 15, G.g1, 0.07, 11 + frame * 7);
  p.scatter(1, 1, 15, 15, G.g3, 0.05, 31 + frame * 13);
  if (frame === 1) {
    // hairline scratch
    p.hl(4, 9, 5, G.g3);
    p.p(9, 10, G.g3);
  } else if (frame === 2) {
    // sub-panel seam + rivet dots
    p.vl(8, 1, 15, G.g1);
    p.p(4, 4, G.g3);
    p.p(12, 12, G.g3);
  } else if (frame === 3) {
    // old stain blob
    p.disc(10, 6, 2, G.g1);
    p.scatter(7, 3, 7, 7, G.g1, 0.2, 97);
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
    // vent slots + a scuff
    p.hl(3, 5, 6, G.g2);
    p.hl(3, 7, 6, G.g2);
    p.hl(3, 9, 6, G.g2);
    p.p(12, 11, G.g2);
    p.p(13, 11, G.g2);
  } else {
    // hazard-worn bolt heads
    p.p(2, 4, G.g6);
    p.p(13, 4, G.g6);
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
