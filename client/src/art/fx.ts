/** Projectiles & effects. Sparks blue-white; boom is smoke+debris, no fire. */

import { FOE, FX, G, MAT, ROBOT } from './palette';
import { hash01, type Px } from './px';

/** bolt 6×3 — the robot's warm tracer, pointing E (render rotates). */
export function drawBolt(p: Px, frame: number): void {
  if (frame === 0) {
    p.p(0, 1, ROBOT.shade);
    p.hl(1, 1, 3, FX.bolt);
    p.hl(4, 1, 2, FX.boltCore);
    p.p(3, 0, ROBOT.shade);
    p.p(3, 2, ROBOT.shade);
  } else {
    p.hl(0, 1, 4, FX.bolt);
    p.hl(4, 1, 2, FX.boltCore);
    p.p(2, 0, ROBOT.shade);
    p.p(4, 2, ROBOT.shade);
  }
}

const PAPER_MAP = { p: MAT.paper, h: MAT.paperHi, s: MAT.paperSh };

/** paper 6×6 — crumpled wad tumbling, 3 rotations. */
const PAPER_FRAMES: readonly (readonly string[])[] = [
  [
    '......',
    '.ppp..',
    'phppp.',
    'ppspp.',
    '.pps..',
    '......',
  ],
  [
    '..pp..',
    '.pphp.',
    '.phpps',
    '..spp.',
    '...p..',
    '......',
  ],
  [
    '......',
    '..ppp.',
    '.pshpp',
    '.ppph.',
    '..pps.',
    '......',
  ],
];

export function drawPaper(p: Px, frame: number): void {
  p.bmp(0, 0, PAPER_FRAMES[frame], PAPER_MAP);
}

const SPARK_MAP = { C: FX.sparkCore, S: FX.spark, d: FX.sparkDim };

/** fx_spark 8×8 — blue-white 4-frame burst; hot 2px core on frames 0–1. */
const SPARK_FRAMES: readonly (readonly string[])[] = [
  [
    '........',
    '........',
    '...SS...',
    '..SCCS..',
    '...SS...',
    '........',
    '........',
    '........',
  ],
  [
    '........',
    '...S....',
    '...CC...',
    '.SCCCCS.',
    '...CC...',
    '...S....',
    '........',
    '........',
  ],
  [
    'S..S..S.',
    '.C...C..',
    '........',
    'S.....S.',
    '........',
    '.C...C..',
    'S..S..S.',
    '........',
  ],
  [
    '........',
    '.d...d..',
    '........',
    'd.....d.',
    '........',
    '.d...d..',
    '........',
    '........',
  ],
];

export function drawFxSpark(p: Px, frame: number): void {
  p.bmp(0, 0, SPARK_FRAMES[frame], SPARK_MAP);
}

/** fx_smoke 10×10 — soft gray puff: grow, hollow, dissipate. */
export function drawFxSmoke(p: Px, frame: number): void {
  if (frame === 0) {
    p.disc(5, 6, 2, FX.smoke2);
    p.p(4, 5, FX.smoke3);
    p.p(5, 4, FX.smoke3);
  } else if (frame === 1) {
    p.disc(5, 5, 3, FX.smoke2);
    p.disc(4, 4, 1, FX.smoke3);
    p.checker(3, 7, 5, 2, FX.smoke1);
  } else if (frame === 2) {
    p.disc(5, 4, 4, FX.smoke1);
    p.disc(4, 4, 2, FX.smoke2);
    p.p(6, 2, FX.smoke3);
    p.checker(1, 2, 8, 6, FX.smoke1, 1);
    p.hole(6, 7, 1);
  } else {
    // dissipating wisps, drifting up
    p.p(2, 2, FX.smoke2);
    p.p(3, 1, FX.smoke1);
    p.p(6, 1, FX.smoke2);
    p.p(7, 3, FX.smoke1);
    p.p(4, 4, FX.smoke1);
    p.p(8, 5, FX.smoke1);
    p.p(2, 6, FX.smoke1);
  }
}

const MUZZLE_MAP = { C: FX.boltCore, b: FX.bolt, o: ROBOT.base };

/** fx_muzzle 8×8 — 2-frame warm flash. */
const MUZZLE_FRAMES: readonly (readonly string[])[] = [
  [
    '........',
    '...b....',
    '..bCb...',
    '.bCCCb..',
    '..bCb...',
    '...b....',
    '........',
    '........',
  ],
  [
    '........',
    '...o....',
    '..o.o...',
    '.o...o..',
    '..o.o...',
    '...o....',
    '........',
    '........',
  ],
];

export function drawFxMuzzle(p: Px, frame: number): void {
  p.bmp(0, 0, MUZZLE_FRAMES[frame], MUZZLE_MAP);
}

/** Debris flecks for the boom — rust/olive shrapnel + paper/plastic, deterministic. */
const DEBRIS: ReadonlyArray<readonly [number, number, string]> = [
  [4, 4, FOE.rust],
  [15, 5, FOE.olive],
  [16, 14, FOE.rustSh],
  [5, 15, FOE.oliveSh],
  [10, 2, FOE.rust],
  [2, 10, FOE.oliveSh],
  [13, 16, MAT.paper],
  [7, 3, MAT.metalSh],
];

/** fx_boom 20×20 — enemy death pop: flash → smoke ring → dust. No fire. */
export function drawFxBoom(p: Px, frame: number): void {
  const cx = 10;
  const cy = 10;
  if (frame === 0) {
    p.disc(cx, cy, 3, FX.flash);
    p.disc(cx, cy, 1, '#eef2f5');
    p.p(cx, cy - 5, FX.flash);
    p.p(cx + 5, cy, FX.flash);
    p.p(cx - 5, cy + 1, FX.flash);
  } else if (frame === 1) {
    p.disc(cx, cy, 5, FX.smoke3);
    p.disc(cx - 1, cy - 1, 3, FX.smoke2);
    p.p(cx, cy, FX.flash);
    for (const [dx, dy, c] of DEBRIS) p.p(dx, dy, c);
  } else if (frame === 2) {
    p.disc(cx, cy, 7, FX.smoke1);
    p.disc(cx, cy, 6, FX.smoke2);
    p.hole(cx, cy, 4);
    // mottle the ring so it reads as churning smoke, not a donut
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.3;
      p.p(Math.round(cx + Math.cos(a) * 5.5), Math.round(cy + Math.sin(a) * 5.5), FX.smoke1);
    }
    p.p(3, 3, FOE.rust);
    p.p(17, 4, FOE.olive);
    p.p(16, 16, FOE.rustSh);
    p.p(2, 14, FOE.oliveSh);
    // paper scraps and dark plastic flung through the smoke
    p.p(18, 7, MAT.paper);
    p.p(1, 6, MAT.paperSh);
    p.p(12, 18, MAT.paper);
    p.p(6, 1, MAT.metalSh);
    p.p(15, 17, MAT.metalSh);
  } else if (frame === 3) {
    // broken ring of dots
    for (let i = 0; i < 16; i++) {
      if (i % 4 === 3) continue;
      const a = (i / 16) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * 7.5);
      const y = Math.round(cy + Math.sin(a) * 7.5);
      p.p(x, y, i % 2 === 0 ? FX.smoke2 : FX.smoke1);
    }
    p.p(1, 2, FOE.rustSh);
    p.p(18, 15, FOE.oliveSh);
    // debris flung wide
    p.p(0, 8, MAT.paperSh);
    p.p(19, 11, MAT.paper);
    p.p(10, 0, MAT.paperSh);
    p.p(4, 18, MAT.metalSh);
    p.p(16, 1, MAT.metalSh);
    p.p(19, 18, MAT.paperSh);
  } else {
    // last dust + scraps settling low
    p.p(4, 3, FX.smoke1);
    p.p(15, 2, FX.smoke1);
    p.p(18, 9, FX.smoke1);
    p.p(3, 12, FX.smoke1);
    p.p(9, 17, FX.smoke1);
    p.p(12, 6, FX.smoke2);
    p.p(6, 16, MAT.paperSh);
    p.p(13, 18, MAT.metalSh);
    p.p(17, 15, MAT.paperSh);
    p.p(2, 17, MAT.metalSh);
    p.p(10, 19, MAT.paperSh);
  }
}

// --------------------------------------------------------- ordnance booms
//
// THE SHREDDER lobs compacted bales of shredded documents, so this whole tier
// is grey-white and black: paper, toner, smoke. No fire-orange anywhere. The
// robot's #ff7a1a has to stay the only saturated thing on screen in exactly
// the frames where everything is exploding, and a blizzard of office paper is
// a far more distinctive silhouette than a fireball. Scale, light and shake
// carry the impact; hue never does.
//
// fx_boom (20px) stays the small tier for add-deaths. These are 36 and 72, and
// the jump has to be legible at a glance — hence the shared frame grammar
// (light → cloud → churning ring → torn ring → wisps → paper) played out over
// 6 and 8 frames respectively, so the big one lingers as well as sprawls.

/** Punch pixels back out — the rim-eating counterpart to Px.hole. */
function bite(p: Px, run: () => void): void {
  p.ctx.save();
  p.ctx.globalCompositeOperation = 'destination-out';
  run();
  p.ctx.restore();
}

/**
 * A churning smoke mass. The three value bands are deliberately NOT concentric
 * and the rim is gnawed by a deterministic scatter: a stack of centred discs
 * reads as a target, not as smoke. Offsets and raggedness do more work here
 * than the radii do.
 */
function churn(p: Px, cx: number, cy: number, rad: number, seed: number): void {
  p.disc(cx, cy, rad, FX.smoke1);
  p.disc(cx - Math.round(rad * 0.14), cy - Math.round(rad * 0.2), Math.round(rad * 0.72), FX.smoke2);
  p.disc(cx + Math.round(rad * 0.22), cy - Math.round(rad * 0.1), Math.round(rad * 0.34), FX.smoke3);
  // Chunky bites, not a per-pixel nibble: gnawing 1px at a time gives a
  // dithered fringe that reads as video noise. But the angles have to be
  // hashed rather than stepped — evenly spaced bites of even depth scallop the
  // silhouette into a cogwheel, which is the one shape smoke never makes.
  const n = Math.round(rad * 1.6);
  bite(p, () => {
    for (let i = 0; i < n; i++) {
      const a = hash01(i, seed, 23) * Math.PI * 2;
      const r = rad + 1 - hash01(i, seed, 22) * 4;
      const s = 1 + Math.round(hash01(i, seed, 25) * (rad > 20 ? 2 : 1));
      p.r(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), s, s, '#000');
    }
  });
}

/** Hollow the mass into a churning ring: an off-centre void with a chewed lip,
 *  then tufts thrown back across it so it never reads as a clean donut. */
function hollow(p: Px, cx: number, cy: number, inner: number, seed: number): void {
  p.hole(cx + 1, cy + 1, inner);
  bite(p, () => {
    for (let i = 0; i < inner * 5; i++) {
      if (hash01(i, seed, 41) < 0.55) continue;
      const a = (i / (inner * 5)) * Math.PI * 2;
      const r = inner + hash01(i, seed, 43) * 2;
      p.p(Math.round(cx + 1 + Math.cos(a) * r), Math.round(cy + 1 + Math.sin(a) * r), '#000');
    }
  });
  for (let i = 0; i < inner; i++) {
    const a = hash01(i, seed, 47) * Math.PI * 2;
    const r = hash01(i, seed, 53) * inner;
    p.p(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), FX.smoke1);
  }
}

/**
 * Shredded-document confetti — the signature of every Shredder detonation.
 * Cross-cut output is RIBBONS, so a fleck is always a 2px strip and never a
 * lone pixel. That one rule is the whole difference between "generic debris"
 * and "someone's quarterly report is airborne".
 */
function ribbon(p: Px, x: number, y: number, tone: number, turn: number): void {
  const c = tone < 0.34 ? MAT.paperHi : tone < 0.78 ? MAT.paper : MAT.paperSh;
  // Four attitudes of a 3px strip. A 1px dot is a spark and a 2px dash is a
  // spark that moved; it takes three pixels with a slant on them before the
  // eye calls it a piece of paper.
  if (turn < 0.42) p.hl(x - 1, y, 3, c); // flat to camera — the common case
  else if (turn < 0.62) p.vl(x, y - 1, 2, c); // edge-on, foreshortened
  else if (turn < 0.81) {
    p.p(x - 1, y + 1, c); // tumbling, one diagonal
    p.p(x, y, c);
    p.p(x + 1, y - 1, c);
  } else {
    p.p(x - 1, y - 1, c); // and the other
    p.p(x, y, c);
    p.p(x + 1, y + 1, c);
  }
}

/**
 * Ribbons riding an expanding front. Two things make this read as documents
 * rather than sparkle: the flecks arrive in GOUTS (a handful of directions the
 * bale actually tore along) instead of spread evenly around a ring, and angle,
 * tone and attitude are keyed to the fleck INDEX rather than its position — so
 * a given scrap keeps its identity as the front grows and travels outward
 * across frames instead of teleporting to a new spot on the circle.
 */
function ribbonFront(
  p: Px, cx: number, cy: number, rad: number, n: number, seed: number, drop = 0,
): void {
  const gouts = 5;
  for (let i = 0; i < n; i++) {
    const a = ((i % gouts) / gouts) * Math.PI * 2 + hash01(i, seed, 3) * 0.85;
    const r = rad * (0.55 + hash01(i, seed, 5) * 0.62);
    ribbon(
      p,
      Math.round(cx + Math.cos(a) * r),
      Math.round(cy + Math.sin(a) * r + drop),
      hash01(i, seed, 7),
      hash01(i, seed, 9),
    );
  }
}

/** Toner soot — the black half of the cloud. Paper is the bright note; without
 *  the dirty one the confetti reads as a parade, not a detonation. */
function sootFront(p: Px, cx: number, cy: number, rad: number, n: number, seed: number): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + hash01(i, seed, 13) * 0.9;
    const r = rad * (0.5 + hash01(i, seed, 15) * 0.6);
    p.p(
      Math.round(cx + Math.cos(a) * r),
      Math.round(cy + Math.sin(a) * r),
      hash01(i, seed, 17) < 0.5 ? G.g0 : G.g1,
    );
  }
}

/** Hull shrapnel — the only bits that came off the machine itself. Kept sparse
 *  on purpose: three rust flecks read as "a thing came apart", a dozen read as
 *  gravel and steal attention from the paper. */
function shrapnel(p: Px, cx: number, cy: number, rad: number, n: number, seed: number): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + hash01(i, seed, 61) * 1.2;
    const r = rad * (0.8 + hash01(i, seed, 63) * 0.3);
    p.p(
      Math.round(cx + Math.cos(a) * r),
      Math.round(cy + Math.sin(a) * r),
      hash01(i, seed, 67) < 0.6 ? FOE.rustSh : MAT.metalSh,
    );
  }
}

/** Sparse dust left hanging once the mass is spent. Tufts, never single pixels:
 *  a field of lone grey dots is indistinguishable from the CRT's own noise. */
function wisps(p: Px, cx: number, cy: number, rad: number, n: number, seed: number): void {
  for (let i = 0; i < n; i++) {
    const a = hash01(i, seed, 71) * Math.PI * 2;
    const r = rad * (0.25 + hash01(i, seed, 73) * 0.75);
    const x = Math.round(cx + Math.cos(a) * r);
    const y = Math.round(cy + Math.sin(a) * r - 1); // dust rises a touch as it thins
    const c = hash01(i, seed, 77) < 0.3 ? FX.smoke2 : FX.smoke1;
    p.r(x, y, hash01(i, seed, 79) < 0.45 ? 3 : 2, 2, c); // wider than tall — dust lies down
  }
}

/** A torn ring — the mass after it has blown itself apart. The gaps are the
 *  readable part, so they are large and irregular, and what survives between
 *  them is lumps of smoke rather than a dotted outline. */
function tornRing(p: Px, cx: number, cy: number, rad: number, seed: number): void {
  const n = Math.max(8, Math.round(rad * 0.8));
  for (let i = 0; i < n; i++) {
    if (hash01(i, seed, 81) < 0.34) continue;
    const a = (i / n) * Math.PI * 2;
    const r = rad + hash01(i, seed, 83) * 3 - 1.5;
    // rects, not discs: Px.disc at radius 2 is a plus sign, and a field of
    // plus signs reads as HUD chrome
    p.r(
      Math.round(cx + Math.cos(a) * r),
      Math.round(cy + Math.sin(a) * r),
      hash01(i, seed, 87) < 0.35 ? 3 : 2,
      2,
      hash01(i, seed, 85) < 0.35 ? FX.smoke2 : FX.smoke1,
    );
  }
}

/** fx_burst 36×36 — the medium tier: rocket impacts and mortar detonations.
 *  Frames 4–5 are the point of the whole thing: the smoke is gone and the
 *  ribbons are still up. Heavy debris drops, documents linger. */
export function drawFxBurst(p: Px, frame: number): void {
  const cx = 18;
  const cy = 18;
  const S = 0x8a17; // one seed for the effect — flecks stay coherent frame to frame

  if (frame === 0) {
    // Light, and only light. An explosion whose first frame is already smoke
    // has no detonation in it — the eye needs one frame of pure value.
    p.hl(cx - 12, cy, 25, FX.flash); // shock leaving on the axes before the
    p.vl(cx, cy - 11, 23, FX.flash); // cloud has caught up with it
    for (let i = 1; i <= 6; i++) {
      const c = i > 4 ? FX.smoke3 : FX.flash;
      p.p(cx - i, cy - i, c);
      p.p(cx + i, cy - i, c);
      p.p(cx - i, cy + i, c);
      p.p(cx + i, cy + i, c);
    }
    p.disc(cx, cy, 5, FX.flash);
    p.disc(cx, cy, 2, '#eef2f5');
  } else if (frame === 1) {
    churn(p, cx, cy, 11, S);
    p.disc(cx, cy, 4, FX.flash); // core still burning through the cloud
    p.disc(cx, cy, 1, '#eef2f5');
    sootFront(p, cx, cy, 9, 9, S);
    ribbonFront(p, cx, cy, 11, 10, S);
    shrapnel(p, cx, cy, 13, 3, S);
  } else if (frame === 2) {
    churn(p, cx, cy, 15, S);
    hollow(p, cx, cy, 6, S);
    sootFront(p, cx, cy, 13, 10, S);
    ribbonFront(p, cx, cy, 15, 12, S);
    shrapnel(p, cx, cy, 16, 4, S);
  } else if (frame === 3) {
    tornRing(p, cx, cy, 16, S);
    wisps(p, cx, cy, 10, 6, S);
    sootFront(p, cx, cy, 15, 7, S);
    ribbonFront(p, cx, cy, 17, 12, S, 1);
  } else if (frame === 4) {
    wisps(p, cx, cy, 15, 9, S);
    sootFront(p, cx, cy, 16, 4, S);
    ribbonFront(p, cx, cy, 14, 11, S, 3); // ribbons start to sag
  } else {
    // Paper only. Four dust motes so the frame isn't clinically empty, then
    // eleven ribbons still coming down through nothing. The radius pulls IN as
    // the drop grows — flung past the sprite edge, a scrap is just clipped
    // away, and it is these last frames that can least afford to lose any.
    wisps(p, cx, cy, 12, 4, S);
    ribbonFront(p, cx, cy, 12, 11, S, 5);
  }
}

/** fx_blast 72×72 — boss death, nothing else. Same grammar as fx_burst over
 *  eight frames so it sprawls AND lasts. Frames 0–1 push the core to white:
 *  that is a value concession, which the palette law permits — a hue one would
 *  not be. */
export function drawFxBlast(p: Px, frame: number): void {
  const cx = 36;
  const cy = 36;
  const S = 0xb103;

  if (frame === 0) {
    // The whole frame is lit. Lances run the full width — at this size the
    // star has to leave the sprite or the blast reads as merely large.
    p.hl(0, cy, 72, FX.flash);
    p.vl(cx, 0, 72, FX.flash);
    for (let i = 1; i <= 26; i++) {
      const c = i > 20 ? FX.smoke2 : i > 13 ? FX.smoke3 : FX.flash;
      p.p(cx - i, cy - i, c);
      p.p(cx + i, cy - i, c);
      p.p(cx - i, cy + i, c);
      p.p(cx + i, cy + i, c);
    }
    p.disc(cx, cy, 20, FX.flash);
    p.disc(cx, cy, 14, '#eef2f5');
    p.disc(cx, cy, 8, '#ffffff');
  } else if (frame === 1) {
    churn(p, cx, cy, 26, S);
    p.disc(cx, cy, 18, FX.flash);
    p.disc(cx, cy, 10, '#eef2f5');
    p.disc(cx, cy, 5, '#ffffff');
    sootFront(p, cx, cy, 22, 16, S);
    ribbonFront(p, cx, cy, 25, 20, S);
    shrapnel(p, cx, cy, 28, 6, S);
  } else if (frame === 2) {
    churn(p, cx, cy, 32, S);
    p.disc(cx - 1, cy, 9, FX.flash); // the last of the core, seen through smoke
    p.disc(cx - 1, cy, 3, '#eef2f5');
    sootFront(p, cx, cy, 28, 18, S);
    ribbonFront(p, cx, cy, 30, 22, S);
    shrapnel(p, cx, cy, 33, 7, S);
  } else if (frame === 3) {
    churn(p, cx, cy, 34, S);
    hollow(p, cx, cy, 13, S);
    sootFront(p, cx, cy, 31, 18, S);
    ribbonFront(p, cx, cy, 33, 24, S);
    shrapnel(p, cx, cy, 34, 8, S);
  } else if (frame === 4) {
    tornRing(p, cx, cy, 33, S);
    tornRing(p, cx - 2, cy + 1, 27, S ^ 0x11);
    wisps(p, cx, cy, 22, 14, S);
    sootFront(p, cx, cy, 30, 14, S);
    ribbonFront(p, cx, cy, 34, 24, S, 1);
  } else if (frame === 5) {
    tornRing(p, cx, cy, 34, S ^ 0x22);
    wisps(p, cx, cy, 28, 16, S);
    sootFront(p, cx, cy, 30, 9, S);
    ribbonFront(p, cx, cy, 33, 22, S, 4);
  } else if (frame === 6) {
    wisps(p, cx, cy, 30, 14, S ^ 0x33);
    sootFront(p, cx, cy, 28, 5, S);
    ribbonFront(p, cx, cy, 28, 21, S, 8);
  } else {
    // The punchline. Nothing left of the machine, nothing left of the smoke —
    // just the contents of its hopper coming down over an empty frame. The
    // radius pulls IN as the drop grows: a scrap flung past the sprite edge is
    // simply clipped away, and this frame can least afford to lose any.
    wisps(p, cx, cy, 24, 6, S ^ 0x44);
    ribbonFront(p, cx, cy, 24, 20, S, 13);
    ribbonFront(p, cx, cy, 14, 8, S ^ 0x55, 17);
  }
}

/** fx_shock 64×16 — the ground ring, drawn in the game's 45° projection: the
 *  circle the blast scribes on the floor, foreshortened to roughly 4:1. Flat
 *  and wide is what puts the detonation ON the floor instead of hovering over
 *  it. The near (lower) arc is a value brighter than the far one, because the
 *  light is coming off the ground toward the camera. */
export function drawFxShock(p: Px, frame: number): void {
  const cx = 32;
  const cy = 8;
  const rx = [13, 21, 27, 31][frame]!;
  const ry = [3.2, 5.2, 6.6, 7.4][frame]!;
  const near = [FX.flash, FX.flash, FX.smoke3, FX.smoke2][frame]!;
  const far = [FX.smoke3, FX.smoke3, FX.smoke2, FX.smoke1][frame]!;
  const steps = Math.ceil(rx * 8);

  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const sy = Math.sin(a);
    const x = Math.round(cx + Math.cos(a) * rx);
    const y = Math.round(cy + sy * ry);
    p.p(x, y, sy > 0 ? near : far);
    // the front is 2px thick while it is still fast, 1px once it has spent
    if (frame < 2) p.p(x, y + (sy > 0 ? -1 : 1), far);
  }

  // dust dragged along inside the ring, and ribbons riding the front out
  const S = 0x37c1;
  wisps(p, cx, cy, Math.round(rx * 0.55), frame < 3 ? 7 : 4, S);
  if (frame >= 1 && frame <= 2) {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + hash01(i, S, 3) * 0.8;
      ribbon(
        p,
        Math.round(cx + Math.cos(a) * rx * 0.92),
        Math.round(cy + Math.sin(a) * ry * 0.9),
        hash01(i, S, 7),
        0.2, // seen from this angle they are all lying flat on the floor
      );
    }
  }
}
