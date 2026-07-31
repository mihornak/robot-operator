/** Props & pickups. Neutral metals and drab greens; glows stay faint. */

import { FOE, FX, G, MAT, ROBOT } from './palette';
import type { Px } from './px';

/** scrap 8×6 — gear chunk + bolt; frame 1 glints. */
export function drawScrap(p: Px, frame: number): void {
  // broken gear (r2 disc + surviving teeth)
  p.disc(2, 3, 2, MAT.metal);
  p.p(2, 0, MAT.metal);
  p.p(0, 1, MAT.metal);
  p.p(4, 1, MAT.metal);
  p.p(5, 4, MAT.metal);
  p.p(2, 1, MAT.metalHi);
  p.p(1, 2, MAT.metalHi);
  p.p(3, 4, MAT.metalSh);
  p.p(2, 3, G.g1); // axle hole
  // hex bolt beside it
  p.r(6, 1, 2, 2, MAT.metal);
  p.p(6, 1, MAT.metalHi);
  p.vl(6, 3, 2, MAT.metalSh); // thread
  if (frame === 1) {
    // the glint that says SHINY
    p.p(2, 1, MAT.glint);
    p.p(1, 2, MAT.glint);
    p.p(7, 0, MAT.paperHi);
  }
}

/** crate 14×12 — military-ish chip case; open frame shows a faint warm glow. */
export function drawCrate(p: Px, frame: number): void {
  if (frame === 0) {
    // closed
    p.hl(2, 2, 10, MAT.drabHi);
    p.r(1, 3, 12, 7, MAT.drab);
    p.hl(2, 10, 10, MAT.drabSh);
    p.hl(1, 4, 12, MAT.drabSh); // lid seam
    p.vl(4, 2, 9, MAT.drabSh); // straps
    p.vl(9, 2, 9, MAT.drabSh);
    p.p(4, 6, MAT.metalHi); // latches
    p.p(9, 6, MAT.metalHi);
    p.p(6, 7, MAT.drabHi); // stencil tick
    p.p(7, 7, MAT.drabHi);
    p.p(2, 11, G.g2); // feet
    p.p(11, 11, G.g2);
  } else {
    // open: lid flipped up behind, dark interior, faint warm glow
    p.hl(3, 0, 8, MAT.drabHi);
    p.r(2, 1, 10, 2, MAT.drab);
    p.r(2, 3, 10, 4, G.g1); // interior
    p.r(4, 4, 6, 2, FX.glowWarm);
    p.p(6, 4, FX.glowWarmHi);
    p.p(7, 5, FX.glowWarmHi);
    p.r(1, 7, 12, 3, MAT.drab); // lower shell
    p.hl(2, 10, 10, MAT.drabSh);
    p.vl(4, 7, 3, MAT.drabSh);
    p.vl(9, 7, 3, MAT.drabSh);
    p.p(2, 11, G.g2);
    p.p(11, 11, G.g2);
  }
}

/** pedestal 18×8 — low charging plinth, 2-frame glow pulse. */
export function drawPedestal(p: Px, frame: number): void {
  p.hl(2, 2, 14, G.g6); // top surface
  p.hl(1, 3, 16, G.g5);
  p.r(1, 4, 16, 3, G.g4);
  p.hl(2, 7, 14, G.g2);
  // contact pads on the surface
  p.p(5, 2, G.g7);
  p.p(12, 2, G.g7);
  // charge strip on the front face — muted teal, pulsing
  if (frame === 0) {
    p.hl(4, 5, 10, FX.teal);
  } else {
    p.hl(4, 5, 10, FX.tealHi);
    p.p(3, 5, FX.teal);
    p.p(14, 5, FX.teal);
  }
}

/** fuse 6×10 — chunky cartridge fuse, amber window. */
export function drawFuse(p: Px, _frame: number): void {
  // metal caps
  p.r(0, 0, 6, 2, MAT.metal);
  p.hl(0, 0, 6, MAT.metalHi);
  p.r(0, 8, 6, 2, MAT.metal);
  p.hl(0, 9, 6, MAT.metalSh);
  // ceramic body
  p.r(1, 2, 4, 6, MAT.ceramic);
  p.vl(4, 2, 6, MAT.ceramicSh);
  // amber sight window
  p.box(1, 3, 4, 5, MAT.ceramicSh);
  p.r(2, 4, 2, 3, ROBOT.eye);
  p.p(2, 4, ROBOT.eyeCore);
  p.p(3, 6, '#a06e2e');
}

/** fuse_socket 10×12 — wall box; empty dark / filled + lit. */
export function drawFuseSocket(p: Px, frame: number): void {
  // housing
  p.r(0, 0, 10, 12, G.g5);
  p.hl(0, 0, 10, G.g7);
  p.hl(0, 11, 10, G.g3);
  p.vl(0, 1, 10, G.g6);
  p.vl(9, 1, 10, G.g4);
  // recess
  p.r(2, 2, 6, 8, G.g1);
  p.hl(2, 2, 6, G.g0);
  if (frame === 0) {
    // empty: bare contacts, dead pip
    p.hl(4, 3, 2, MAT.metal);
    p.hl(4, 8, 2, MAT.metal);
    p.p(8, 10, '#3d2c0a'); // unpowered indicator
  } else {
    // filled: the fuse seated, window lit, box awake
    p.r(3, 2, 4, 1, MAT.metalHi);
    p.r(3, 3, 4, 1, MAT.metal);
    p.r(3, 4, 4, 4, MAT.ceramic);
    p.vl(6, 4, 4, MAT.ceramicSh);
    p.r(4, 5, 2, 2, ROBOT.eye);
    p.p(4, 5, ROBOT.eyeCore);
    p.p(3, 5, FX.glowWarm);
    p.p(6, 6, FX.glowWarm);
    p.r(3, 8, 4, 2, MAT.metal);
    p.hl(3, 9, 4, MAT.metalSh);
    p.p(8, 10, '#e09a12'); // powered indicator
  }
}

/** cable 32×10 — thick floor cable, broken mid-span; 4 arc-spark frames. */
export function drawCable(p: Px, frame: number): void {
  // snaking centerline (top y per column); gap at x15..16 where it burned through
  const ys = [
    5, 5, 4, 4, 4, 3, 3, 3, 4, 4, 5, 5, 5, 6, 6, // x0..14
    -1, -1, // gap
    6, 6, 5, 5, 5, 4, 4, 4, 4, 5, 5, 6, 6, 6, 5, // x17..31
  ];
  for (let x = 0; x < 32; x++) {
    const y = ys[x];
    if (y < 0) continue;
    p.p(x, y, MAT.metalSh); // rubber highlight
    p.p(x, y + 1, '#22262c'); // rubber body
    p.p(x, y + 2, G.g1); // contact shadow
  }
  // scorch soot around the burn-through — the floor remembers every arc
  p.p(13, 8, G.g1);
  p.p(14, 8, G.g0);
  p.p(15, 8, G.g1);
  p.p(16, 8, G.g0);
  p.p(17, 8, G.g1);
  p.p(18, 8, G.g1);
  p.p(14, 2, G.g1);
  p.p(17, 2, G.g1);
  // frayed copper ends
  p.p(14, 6, MAT.copper);
  p.p(17, 6, MAT.copper);
  p.p(15, 7, MAT.copperDim); // dangling strand
  // arc frames — sparks small, bright blue-white
  if (frame === 1) {
    p.p(15, 4, FX.spark);
    p.p(16, 5, FX.sparkCore);
  } else if (frame === 2) {
    p.p(15, 5, FX.sparkCore);
    p.p(16, 4, FX.sparkCore);
    p.p(14, 3, FX.spark);
    p.p(17, 3, FX.spark);
    p.p(15, 2, FX.spark);
    p.p(16, 7, FX.sparkDim);
    p.p(13, 2, FX.sparkDim); // big-arc frame throws a little wider
    p.p(18, 5, FX.sparkDim);
  } else if (frame === 3) {
    p.p(16, 3, FX.sparkDim);
    p.p(14, 6, FX.spark); // copper catches the arc
    p.p(15, 6, FX.sparkDim);
  }
}

/** elevator 26×30 — industrial doors: closed, 1/3, 2/3, open. */
export function drawElevator(p: Px, frame: number): void {
  // header
  p.r(0, 0, 26, 5, G.g5);
  p.hl(0, 0, 26, G.g6);
  p.hl(0, 4, 26, G.g3);
  p.r(9, 1, 8, 2, G.g2); // indicator recess — render tints the lit pip
  p.p(11, 2, G.g7);
  p.p(13, 2, G.g7);
  p.p(15, 2, G.g7);
  // dark interior behind the doors
  p.r(3, 5, 20, 23, '#0b0d10');
  p.scatter(4, 6, 18, 18, G.g1, 0.05, 5);
  p.hl(3, 26, 20, G.g1); // floor sliver
  p.hl(3, 27, 20, G.g2);
  // door leaves — remaining width per frame
  const dw = [10, 8, 5, 2][frame];
  // left leaf
  p.r(3, 5, dw, 23, G.g4);
  p.hl(3, 5, dw, G.g5);
  for (let x = 3 + 2; x < 3 + dw - 1; x += 3) p.vl(x, 6, 21, G.g3); // brushed panels
  p.vl(3 + dw - 1, 5, 23, G.g7); // leading edge
  p.hl(3, 26, dw, G.g3); // kick plate
  // right leaf (mirror)
  p.r(23 - dw, 5, dw, 23, G.g4);
  p.hl(23 - dw, 5, dw, G.g5);
  for (let x = 22 - 2; x > 23 - dw; x -= 3) p.vl(x, 6, 21, G.g3);
  p.vl(23 - dw, 5, 23, G.g7);
  p.hl(23 - dw, 26, dw, G.g3);
  // side posts
  p.r(0, 5, 3, 23, G.g5);
  p.vl(2, 5, 23, G.g6);
  p.vl(0, 5, 23, G.g4);
  p.r(23, 5, 3, 23, G.g5);
  p.vl(23, 5, 23, G.g6);
  p.vl(25, 5, 23, G.g4);
  // threshold
  p.r(0, 28, 26, 1, G.g4);
  p.hl(0, 29, 26, G.g2);
  for (let x = 1; x < 25; x += 3) p.p(x, 28, G.g6); // worn caution ticks
}
