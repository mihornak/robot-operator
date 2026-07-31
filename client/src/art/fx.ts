/** Projectiles & effects. Sparks blue-white; boom is smoke+debris, no fire. */

import { FOE, FX, MAT, ROBOT } from './palette';
import type { Px } from './px';

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

/** fx_spark 8×8 — blue-white 4-frame burst. */
const SPARK_FRAMES: readonly (readonly string[])[] = [
  [
    '........',
    '........',
    '...S....',
    '..SCS...',
    '...S....',
    '........',
    '........',
    '........',
  ],
  [
    '........',
    '...S....',
    '...C....',
    '.SCCCS..',
    '...C....',
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

/** Debris flecks for the boom — rust/olive shrapnel, deterministic. */
const DEBRIS: ReadonlyArray<readonly [number, number, string]> = [
  [4, 4, FOE.rust],
  [15, 5, FOE.olive],
  [16, 14, FOE.rustSh],
  [5, 15, FOE.oliveSh],
  [10, 2, FOE.rust],
  [2, 10, FOE.oliveSh],
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
  } else {
    // last dust
    p.p(4, 3, FX.smoke1);
    p.p(15, 2, FX.smoke1);
    p.p(18, 9, FX.smoke1);
    p.p(3, 12, FX.smoke1);
    p.p(9, 17, FX.smoke1);
    p.p(12, 6, FX.smoke2);
  }
}
