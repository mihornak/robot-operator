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

/**
 * debris_pile 44×30 — the heap of dead office machines the robot sleeps in.
 * Silhouette first: a low mound of broken shells with legible junk poking out
 * (monitor carcass, bent fan blade, coiled cable, a chair strut). Frames 1/2
 * shift the loose top layer a pixel — something is moving UNDER it. Frame 3 is
 * post-wake: the crown is caved in, a dark hole where the robot burst out.
 */
export function drawDebrisPile(p: Px, frame: number): void {
  const stir = frame === 1 ? -1 : frame === 2 ? 1 : 0;
  const burst = frame === 3;

  // base mound — two dithered slabs so it reads as MASS, not a wall
  p.r(3, 20, 38, 9, G.g2);
  p.hl(4, 19, 36, G.g3);
  p.r(6, 16, 32, 4, G.g3);
  p.checker(5, 18, 34, 2, G.g4, 1);
  p.hl(3, 29, 38, G.g1); // contact shadow line
  p.scatter(4, 21, 36, 7, G.g1, 0.16, 11); // grime + gaps between parts

  // dead monitor carcass, left — cracked screen, no light in it
  p.r(5, 11, 13, 10, G.g4);
  p.hl(5, 11, 13, G.g5);
  p.vl(5, 12, 9, G.g5);
  p.r(7, 13, 9, 6, G.g0); // screen glass
  p.p(9, 15, G.g3); // the crack
  p.p(10, 16, G.g3);
  p.p(11, 15, G.g3);
  p.p(12, 17, G.g2);
  p.hl(6, 20, 11, G.g2);

  // toppled printer shell, right — the fused-machine family, dead this time
  p.r(26, 13 + stir, 13, 8, MAT.drab);
  p.hl(26, 13 + stir, 13, MAT.drabHi);
  p.hl(27, 20 + stir, 11, MAT.drabSh);
  p.r(29, 15 + stir, 7, 2, G.g1); // paper slot, dark
  p.p(37, 15 + stir, FOE.ledRedDim); // one LED that never comes back on
  p.vl(31, 21 + stir, 2, MAT.metalSh); // torn feet

  // bent fan blade sticking out of the crown
  p.p(21, 9, MAT.metal);
  p.p(22, 8, MAT.metal);
  p.p(23, 8, MAT.metalHi);
  p.p(24, 9, MAT.metal);
  p.p(22, 10, MAT.metalSh);
  p.vl(23, 10, 4, MAT.metalSh); // hub shaft down into the pile

  // coiled cable spilling off the right slope
  p.p(38, 21, '#22262c');
  p.p(39, 22, '#22262c');
  p.p(40, 23, MAT.metalSh);
  p.p(39, 24, '#22262c');
  p.p(38, 25, '#22262c');
  p.p(37, 24, MAT.copperDim); // one bared strand

  // chair strut jammed in at an angle, left slope
  p.p(2, 25, MAT.metalSh);
  p.p(3, 24, MAT.metal);
  p.p(4, 23, MAT.metal);
  p.p(5, 22, MAT.metalHi);

  if (burst) {
    // the robot left through the top: caved crown, dark cavity, loose shards
    p.r(18, 12, 10, 7, G.g0);
    p.hl(18, 12, 10, G.g1);
    p.p(17, 13, G.g1);
    p.p(28, 13, G.g1);
    p.hl(19, 19, 8, G.g2); // rubble settled in the bottom of the hole
    p.p(16, 20, G.g4); // shards thrown clear
    p.p(29, 21, G.g4);
    p.p(31, 24, G.g3);
  } else {
    // intact crown: a slumped keyboard capping the heap
    p.r(17, 12 + stir, 12, 4, G.g4);
    p.hl(17, 12 + stir, 12, G.g6);
    for (let x = 18; x < 28; x += 2) p.p(x, 14 + stir, G.g2); // key rows
    p.hl(18, 16 + stir, 10, G.g2);
  }
}

/**
 * chip_item 10×8 — a loose personality chip on the floor. Dark ceramic body,
 * gold legs, and a warm core that pulses across the 4 frames (dim → PEAK →
 * afterglow) with a travelling glint on the peak. Small and drab except for
 * that core: the eye should catch it the way it catches scrap, but harder.
 */
export function drawChipItem(p: Px, frame: number): void {
  const lvl = [0, 1, 3, 2][frame];
  const core = [FX.glowWarm, FX.glowWarmHi, ROBOT.eye, ROBOT.eyeCore][lvl];
  const rim = [G.g3, FX.glowWarm, FX.glowWarmHi, ROBOT.eye][lvl];

  // gold legs down both flanks, under the body
  for (let y = 3; y <= 5; y += 2) {
    p.p(0, y, MAT.copper);
    p.p(9, y, MAT.copper);
  }
  p.p(0, 4, MAT.copperDim);
  p.p(9, 4, MAT.copperDim);

  // ceramic package
  p.r(1, 2, 8, 5, '#2b2f36');
  p.hl(1, 2, 8, '#3a3f47');
  p.hl(2, 6, 6, G.g1);
  p.vl(1, 3, 3, '#343941');

  // etched die window, lit from inside
  p.r(3, 3, 4, 3, G.g0);
  p.hl(3, 4, 4, rim);
  p.p(4, 4, core);
  p.p(5, 4, core);
  p.p(4, 3, rim);

  // pin-1 notch + a stencil tick, so it reads as a REAL part at 1x
  p.p(2, 3, MAT.metalHi);
  p.p(7, 5, G.g4);

  if (lvl >= 2) {
    // peak bloom: light escapes the package and spills onto the floor
    p.p(2, 4, FX.glowWarmHi);
    p.p(7, 4, FX.glowWarmHi);
    if (lvl === 3) {
      p.hl(3, 7, 4, FX.glowWarm); // floor spill under the die
      p.p(5, 3, ROBOT.eyeCore); // travelling glint on the glass
      p.p(1, 4, FX.glowWarm);
      p.p(8, 4, FX.glowWarm);
    }
  }
}

/**
 * crate 14×12 — the upgrade pickup, and the single most important object on
 * any floor. This is the art the player hunts for on floors 3 and 4, and it
 * has failed the "can you see it" test twice: first as a small drab lump in a
 * 12×8 island of the frame, then filling the frame but still drawn in MAT.drab,
 * which is within a hair of the floor tiles once the CRT darkens and vignettes
 * the feed — it read as a dark rectangle indistinguishable from a door prop.
 *
 * So this frame is built on VALUE, not detail. The shell is MAT.drabHi, every
 * structural line is steel (lighter than anything on the floor), and the lid
 * seam is full-strength ROBOT.eye with a white-hot core — the same beacon
 * language crate_triad uses at the peak of its pulse, held permanently, because
 * a 2-frame entry has no pulse of its own. The manifest pins the frame at
 * 14×12; size is bought in render/world.ts, which also hangs the breathing
 * halo and floor pool on it. The two halves are designed together.
 */
export function drawCrate(p: Px, frame: number): void {
  if (frame === 0) {
    // --- closed: a steel-banded case with the light on inside ---
    // Value first. MAT.drab (#3b3f35) sits within a hair of the floor tiles
    // (#181b20..#23272d) once the CRT darkens and vignettes the feed, which is
    // why the old crate read as a dark rectangle. The shell is a full step up
    // now and every structural line is STEEL, which is lighter still.
    p.r(0, 1, 14, 10, MAT.drabHi);
    p.hl(1, 0, 12, MAT.metalHi); // steel top rim — the brightest edge
    p.vl(0, 1, 10, MAT.metal); // steel flanks carry the silhouette down both
    p.vl(13, 1, 10, MAT.metalSh); // sides; right one shaded so it reads round
    p.hl(1, 10, 12, MAT.metal); // steel skid band along the bottom
    p.hl(2, 11, 10, G.g1); // contact shadow keeps it ON the floor

    p.hl(1, 3, 12, MAT.drab); // lid underside shade, so the lid reads separate
    // brushed steel panel across the lid + the specular hit on it: SHINY
    p.hl(4, 2, 6, MAT.ceramic);
    p.p(6, 2, MAT.paperHi);
    p.p(7, 2, MAT.glint);

    // THE SEAM. Same beacon language as crate_triad at its peak: the whole
    // line is ROBOT.eye, not the dim FX.glowWarmHi, with a white-hot core and
    // the light washing down onto the front face below it.
    p.hl(0, 4, 14, ROBOT.eye);
    p.r(5, 4, 4, 1, ROBOT.eyeCore);
    p.hl(1, 5, 12, FX.glowWarmHi);
    p.p(0, 5, FX.glowWarm); // and spilling past the shell on both flanks
    p.p(13, 5, FX.glowWarm);

    // latches clamping across the seam, interrupting the leak
    p.vl(3, 3, 3, MAT.metal);
    p.p(3, 3, MAT.metalHi);
    p.vl(10, 3, 3, MAT.metal);
    p.p(10, 3, MAT.metalHi);

    // keyhole recess + flank vents, all lit from within
    p.r(6, 6, 3, 3, G.g1);
    p.p(7, 6, ROBOT.eyeCore);
    p.p(6, 7, FX.glowWarmHi);
    p.p(7, 7, ROBOT.eye);
    p.hl(1, 7, 2, ROBOT.eye);
    p.hl(11, 7, 2, ROBOT.eye);

    p.p(4, 9, MAT.ceramicSh); // stencil ticks
    p.p(5, 9, MAT.ceramicSh);
    p.p(9, 9, MAT.ceramicSh);

    // steel corner brackets: four hard bright corners hold the shape together
    // once the vignette has eaten the middle of the feed
    p.r(0, 0, 2, 2, MAT.metal);
    p.r(12, 0, 2, 2, MAT.metal);
    p.p(0, 0, MAT.metalHi);
    p.p(13, 0, MAT.metalHi);
    p.r(0, 9, 2, 2, MAT.metalHi);
    p.r(12, 9, 2, 2, MAT.metalHi);
    p.p(3, 11, FX.glowWarm); // vent light pooling on the floor at its feet
    p.p(10, 11, FX.glowWarm);
    p.p(1, 11, MAT.metalSh); // feet
    p.p(12, 11, MAT.metalSh);
  } else {
    // --- open: lid thrown back, interior dark and EMPTY. A looted crate has
    // to read as SPENT at a glance, so nothing in here glows any more (render
    // kills its halo and floor pool to match). ---
    p.r(0, 3, 14, 8, MAT.drab); // lower shell
    p.hl(2, 0, 10, MAT.metalHi); // lid rim, standing up behind the shell
    p.r(1, 1, 12, 2, MAT.drab);
    p.hl(2, 1, 10, MAT.drabHi);
    p.vl(0, 3, 8, MAT.drabHi);
    p.vl(13, 3, 8, MAT.drabSh);
    p.hl(1, 10, 12, MAT.drabSh);
    p.hl(2, 11, 10, G.g1);
    p.r(1, 4, 12, 5, G.g0); // cavity
    p.hl(2, 4, 10, G.g1); // its rim catches a little light
    p.r(4, 6, 6, 2, G.g2); // foam cutout the chip used to sit in
    p.p(4, 6, G.g3);
    p.p(9, 7, G.g1);
    p.r(0, 3, 2, 1, MAT.metal); // same corner brackets as the closed frame
    p.r(12, 3, 2, 1, MAT.metal);
    p.r(0, 9, 2, 2, MAT.metal);
    p.r(12, 9, 2, 2, MAT.metal);
    p.p(0, 9, MAT.metalHi);
    p.p(13, 9, MAT.metalHi);
    p.p(1, 11, G.g2);
    p.p(12, 11, G.g2);
  }
}

/** crate_triad 16×14 — THE ceremony case. Latched drab supply shell; warm
 *  amber-white light leaks through the lid seam, keyhole and vents. 4-frame
 *  beacon pulse: dim → rising → PEAK (1px halo bloom) → afterglow (smaller
 *  bloom). The shell never brightens — only its light does (palette law:
 *  the leak is a beacon warmth like the OSD; body stays desaturated). */
export function drawCrateTriad(p: Px, frame: number): void {
  const lvl = [0, 1, 3, 2][frame]; // intensity: dim, rising, PEAK, afterglow
  const seam = [FX.glowWarm, FX.glowWarmHi, ROBOT.eye, ROBOT.eye][lvl];
  const core = [FX.glowWarmHi, ROBOT.eye, ROBOT.eyeCore, ROBOT.eyeCore][lvl];

  // drab shell — steel rim + corner brackets match drawCrate, so the ceremony
  // case reads as the same family of object, just the loud member of it
  p.hl(3, 0, 10, MAT.metalHi); // lid top edge
  p.r(2, 1, 12, 3, MAT.drab); // lid
  p.vl(2, 1, 3, MAT.drabHi);
  p.vl(13, 1, 3, MAT.drabSh);
  p.r(1, 5, 14, 7, MAT.drab); // lower shell
  p.vl(1, 5, 7, MAT.drabHi);
  p.vl(14, 5, 7, MAT.drabSh);
  p.hl(2, 11, 12, MAT.drabSh);
  p.hl(3, 12, 10, G.g2); // underside
  p.p(2, 13, G.g2); // feet
  p.p(13, 13, G.g2);
  p.p(5, 10, MAT.drabHi); // stencil ticks
  p.p(6, 10, MAT.drabHi);
  p.p(9, 10, MAT.drabHi);

  // light leaking through the lid seam
  p.hl(2, 4, 12, seam);
  p.p(7, 4, core); // hottest at center
  p.p(8, 4, core);
  // latches clamp across the seam and interrupt the leak
  p.vl(4, 3, 3, MAT.metal);
  p.p(4, 3, MAT.metalHi);
  p.vl(11, 3, 3, MAT.metal);
  p.p(11, 3, MAT.metalHi);

  // keyhole + vents on the front face, lit from inside
  p.r(6, 6, 3, 3, G.g1); // keyhole recess
  p.p(7, 6, core);
  p.p(7, 7, seam);
  p.hl(3, 8, 2, seam); // vent slots
  p.hl(11, 8, 2, seam);

  p.r(2, 1, 2, 1, MAT.metal); // corner brackets
  p.r(12, 1, 2, 1, MAT.metal);
  p.r(1, 10, 2, 2, MAT.metal);
  p.r(13, 10, 2, 2, MAT.metal);
  p.p(1, 10, MAT.metalHi);
  p.p(14, 10, MAT.metalHi);

  // 1px halo bloom on the peak frames
  if (lvl >= 2) {
    const halo = lvl === 3 ? FX.glowWarmHi : FX.glowWarm;
    p.p(1, 4, halo); // seam light escaping past the shell
    p.p(14, 4, halo);
    if (lvl === 3) {
      p.p(0, 4, FX.glowWarm); // outer halo, dimmest
      p.p(15, 4, FX.glowWarm);
      p.p(2, 4, core); // seam ends flare
      p.p(13, 4, core);
      p.hl(6, 13, 4, FX.glowWarm); // spill onto the floor under the keyhole
    }
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
    p.p(8, 5, FX.sparkCore); // white-hot charge pips — the pulse must
    p.p(9, 5, FX.sparkCore); // survive 1x + vignette
    p.hl(4, 6, 10, G.g1); // dark groove under the lit strip: contrast
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
  p.p(3, 5, ROBOT.eyeCore); // glass glint — window must read lit at 1x
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
