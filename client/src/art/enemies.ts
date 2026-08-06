/**
 * Fused machines — office tech gone feral. Desaturated rust/olive, murky.
 * Threatening AND funny; industrial body horror for appliances, never gore.
 */

import { FOE, G, MAT } from './palette';
import type { Px } from './px';

interface Pose {
  dy: number; // whole-body lurch offset
  bdx?: number; // whole-body x kick (spit recoil)
  pdx: number; // printer torso wobble
  pdy: number;
  hose: number; // hose keyframe 0..3
  jaw: 0 | 1 | 2; // closed | telegraph | spit
  chomp?: number; // teeth irregularity phase (jaw 0)
}

/** Hose keyframes — flailing vacuum hose off the right flank, big whip arc. */
const HOSE: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[20, 12], [21, 13], [21, 14], [21, 15], [20, 16]], // droop, tip curled under
  [[20, 11], [21, 10], [21, 9], [20, 8], [20, 7]], // rising
  [[20, 10], [21, 8], [20, 6], [19, 4], [19, 2]], // whipped high over the torso
  [[20, 13], [21, 14], [21, 15], [20, 16], [19, 17]], // slapped down hard, tip flung forward
];

/**
 * Crumpled-paper teeth for the closed jaw — [x, rowBelowSlit, color] per
 * chomp phase. Ragged and slightly different every frame so the mouth chews.
 */
const TEETH: ReadonlyArray<ReadonlyArray<readonly [number, number, string]>> = [
  [[7, 0, MAT.paper], [9, 0, MAT.paperSh], [11, 0, MAT.paper], [13, 0, MAT.paperSh], [15, 0, MAT.paper]],
  [[7, 0, MAT.paperSh], [10, 0, MAT.paper], [12, 0, MAT.paperSh], [14, 0, MAT.paper], [8, 1, MAT.paperSh]],
  [[8, 0, MAT.paper], [9, 0, MAT.paperHi], [11, 0, MAT.paperSh], [14, 0, MAT.paper], [15, 0, MAT.paperSh]],
  [[7, 0, MAT.paper], [10, 0, MAT.paperSh], [13, 0, MAT.paper], [15, 0, MAT.paperHi], [12, 1, MAT.paperSh]],
];

/** 22×18: an office printer FUSED onto a canister vacuum. */
function drawFused(p: Px, pose: Pose): void {
  const { dy, pdx, pdy, jaw } = pose;
  const bdx = pose.bdx ?? 0;
  if (bdx !== 0) {
    p.ctx.save();
    p.ctx.translate(bdx, 0); // whole-body recoil kick
  }

  // casters
  p.r(4, 16 + dy, 3, 2, G.g3);
  p.r(15, 16 + dy, 3, 2, G.g3);
  p.hl(4, 17 + dy, 3, G.g1);
  p.hl(15, 17 + dy, 3, G.g1);

  // vacuum canister (the legs it stole)
  p.hl(4, 11 + dy, 14, FOE.oliveHi);
  p.r(2, 12 + dy, 18, 4, FOE.olive);
  p.hl(2, 13 + dy, 18, FOE.oliveSh); // body band
  p.hl(4, 16 + dy, 14, FOE.oliveSh);
  p.disc(6, 14 + dy, 1, FOE.oliveSh); // intake port
  p.p(6, 14 + dy, G.g1);

  // hose (draw under the torso so the root reads as attached)
  p.p(19, 12 + dy, FOE.oliveSh);
  const hose = HOSE[pose.hose];
  for (let i = 0; i < hose.length; i++) {
    const [hx, hy] = hose[i];
    const last = i === hose.length - 1;
    p.p(hx, hy + dy, last ? FOE.maw : i === 0 ? FOE.olive : FOE.oliveSh);
  }

  // printer torso, melted on crooked
  const px = pdx;
  const py = pdy + dy;
  p.hl(6 + px, 3 + py, 10, FOE.rustHi);
  p.r(5 + px, 4 + py, 12, 6, FOE.rust);
  p.vl(16 + px, 4 + py, 6, FOE.rustSh);
  p.hl(5 + px, 10 + py, 12, FOE.rustSh);
  // scorch decals (fixed, so frames don't boil)
  p.p(6 + px, 9 + py, FOE.rustSh);
  p.p(14 + px, 4 + py, FOE.rustSh);
  p.p(15 + px, 8 + py, FOE.rustSh);
  // top feed slot with paper still jammed in it
  p.hl(8 + px, 3 + py, 6, FOE.maw);
  p.p(9 + px, 2 + py, MAT.paper);
  p.p(10 + px, 1 + py, MAT.paperHi);
  p.p(11 + px, 2 + py, MAT.paperSh);
  p.p(12 + px, 2 + py, MAT.paper);
  // ONE cracked status LED — the eye. Dull red, tiny, off-center.
  p.r(6 + px, 5 + py, 4, 3, FOE.maw);
  p.p(7 + px, 6 + py, FOE.ledRed);
  p.p(8 + px, 6 + py, FOE.ledRedDim); // the cracked half

  // paper-tray jaw with crumpled-paper teeth
  if (jaw === 0) {
    p.hl(6 + px, 8 + py, 10, FOE.maw); // mouth slit
    p.hl(6 + px, 9 + py, 10, FOE.rustSh); // tray lip
    // ragged teeth — snaggles hang over the lip
    for (const [tx, ty, c] of TEETH[pose.chomp ?? 0]) p.p(tx + px, 8 + ty + py, c);
  } else if (jaw === 1) {
    // telegraph: jaw dropped wide, wad chambered
    p.r(6 + px, 7 + py, 10, 4, FOE.maw);
    p.p(7 + px, 7 + py, MAT.paper);
    p.p(10 + px, 7 + py, MAT.paperSh);
    p.p(13 + px, 7 + py, MAT.paper);
    p.p(15 + px, 7 + py, MAT.paperSh);
    p.p(8 + px, 10 + py, MAT.paperSh);
    p.p(11 + px, 10 + py, MAT.paper);
    p.p(14 + px, 10 + py, MAT.paperSh);
    p.r(10 + px, 8 + py, 4, 2, MAT.paper); // the wad, loaded
    p.p(10 + px, 8 + py, MAT.paperHi);
    p.p(13 + px, 9 + py, MAT.paperSh);
    p.hl(6 + px, 11 + py, 10, FOE.rustSh); // dropped tray lip
  } else {
    // spit: jaw slammed wide open over the canister, wad on the way out
    p.r(5 + px, 7 + py, 12, 5, FOE.maw);
    p.p(6 + px, 7 + py, MAT.paper);
    p.p(9 + px, 7 + py, MAT.paperSh);
    p.p(12 + px, 7 + py, MAT.paper);
    p.p(15 + px, 7 + py, MAT.paperSh);
    p.hl(5 + px, 12 + py, 12, FOE.rustSh); // tray as lower jaw, slammed down
    p.r(9 + px, 9 + py, 5, 2, MAT.paper); // wad bursting out the mouth edge
    p.p(9 + px, 9 + py, MAT.paperHi);
    p.p(10 + px, 10 + py, MAT.paperHi);
    p.p(14 + px, 10 + py, MAT.paperSh);
    p.p(16 + px, 10 + py, MAT.paperSh); // fleck already flying
  }

  if (bdx !== 0) p.ctx.restore();
}

/**
 * 4-frame lurch-roll cycle — 2px body hop with the torso squashing into the
 * canister at the peak and stretching on the slam (pdy runs against dy).
 */
const LURCH: readonly Pose[] = [
  { dy: 0, pdx: 0, pdy: 0, hose: 0, jaw: 0, chomp: 0 }, // settled
  { dy: -1, pdx: 0, pdy: 0, hose: 1, jaw: 0, chomp: 1 }, // rising
  { dy: -2, pdx: 1, pdy: 1, hose: 2, jaw: 0, chomp: 2 }, // peak — torso lags down (squash)
  { dy: 0, pdx: 1, pdy: -1, hose: 3, jaw: 0, chomp: 3 }, // slam — torso overshoots up (stretch)
];

export function drawFusedPrinter(p: Px, frame: number): void {
  drawFused(p, LURCH[frame]);
}

/** 2 frames: rear-back telegraph, then lunge-and-spit with a 1px recoil kick. */
const SPIT: readonly Pose[] = [
  { dy: 0, pdx: -1, pdy: -1, hose: 2, jaw: 1 },
  { dy: 0, bdx: -1, pdx: 1, pdy: 0, hose: 3, jaw: 2 },
];

export function drawFusedPrinterSpit(p: Px, frame: number): void {
  drawFused(p, SPIT[frame]);
}

/**
 * fused_shredder 34×26 — PLACEHOLDER for the floor-6 boss.
 *
 * One static frame, no character in it yet: a slab of a machine at the right
 * mass and in the right palette, so the arena, the shadow and the r=13 body can
 * be built against real pixels instead of a guess. Same rust/olive as its small
 * cousin (the palette law is not relaxed for the boss — nothing out-saturates
 * the robot), just far more of it. The maw is the one thing sketched in, since
 * it is what the finished sprite has to sell.
 */
export function drawFusedShredder(p: Px, _frame: number): void {
  // treads — a shredder this size does not roll on casters
  p.r(3, 23, 28, 3, G.g2);
  p.hl(3, 25, 28, G.g1);
  for (let x = 5; x < 30; x += 4) p.vl(x, 23, 3, G.g1);

  // lower housing: the wide olive chassis it was fused onto
  p.hl(2, 15, 30, FOE.oliveHi);
  p.r(1, 16, 32, 7, FOE.olive);
  p.hl(1, 18, 32, FOE.oliveSh);
  p.hl(2, 22, 30, FOE.oliveSh);
  p.vl(0, 17, 5, FOE.oliveSh);
  p.vl(33, 17, 5, FOE.oliveSh);

  // upper hopper, rust — narrower, so the silhouette steps rather than boxes
  p.r(4, 3, 26, 12, FOE.rust);
  p.hl(4, 3, 26, FOE.rustHi);
  p.hl(4, 14, 26, FOE.rustSh);
  p.vl(4, 4, 10, FOE.rustHi);
  p.vl(29, 4, 10, FOE.rustSh);
  // intake lip along the top — where the paper goes in
  p.r(8, 1, 18, 2, G.g3);
  p.hl(8, 1, 18, G.g4);

  // the maw: a wide dark slit with ragged paper caught in it
  p.r(8, 9, 18, 4, FOE.maw);
  p.hl(8, 8, 18, G.g1);
  for (const [x, c] of [
    [9, MAT.paper], [12, MAT.paperSh], [15, MAT.paper], [18, MAT.paperSh], [21, MAT.paper], [24, MAT.paperSh],
  ] as ReadonlyArray<readonly [number, string]>) {
    p.p(x, 9, c);
    p.p(x + 1, 10, c);
  }

  // two red eyes above the maw — the only warm ink on it
  p.p(10, 6, FOE.ledRed);
  p.p(23, 6, FOE.ledRed);
  p.p(11, 6, FOE.ledRedDim);
  p.p(24, 6, FOE.ledRedDim);
}

/** printer_innocent 16×12 — clean, tidy, gently blinking. Harmless. Honest. */
export function drawPrinterInnocent(p: Px, frame: number): void {
  // feet
  p.p(2, 11, G.g2);
  p.p(13, 11, G.g2);
  // body — a touch lighter than the walls: it is CLEAN
  p.hl(2, 4, 12, G.g7);
  p.r(1, 5, 14, 5, G.g6);
  p.hl(2, 10, 12, G.g4);
  p.vl(14, 5, 5, G.g5);
  p.vl(1, 5, 3, G.g7);
  // neat paper stack up top — tray wiggles 1px on the blink frame: alive, harmless
  const tw = frame === 1 ? 1 : 0;
  p.r(4 + tw, 1, 8, 2, MAT.paper);
  p.hl(4 + tw, 1, 8, MAT.paperHi);
  p.hl(3, 3, 10, G.g2); // feed slot
  // output slot on the front
  p.hl(3, 8, 10, G.g4);
  // control buttons + the gentle green standby LED (2-frame blink)
  p.p(3, 6, G.g4);
  p.p(5, 6, G.g4);
  p.p(12, 6, frame === 0 ? FOE.ledGreen : FOE.ledGreenDim);
}

/** mop 8×18 — harmless prop; wrong-target comedy fodder. */
export function drawMop(p: Px, _frame: number): void {
  // leaning handle
  const stem: ReadonlyArray<readonly [number, number]> = [
    [5, 0], [5, 1], [5, 2], [4, 3], [4, 4], [4, 5], [4, 6], [3, 7], [3, 8], [3, 9],
  ];
  for (const [x, y] of stem) p.p(x, y, MAT.wood);
  p.p(5, 0, MAT.metalHi); // cap
  // clamp collar
  p.r(1, 10, 5, 2, MAT.metalSh);
  p.hl(1, 10, 5, MAT.metal);
  // strands, slightly splayed
  p.vl(1, 12, 5, MAT.paperSh);
  p.vl(2, 12, 6, G.g7);
  p.vl(3, 12, 5, MAT.paperSh);
  p.vl(4, 12, 6, MAT.paperSh);
  p.vl(5, 12, 5, G.g7);
  p.vl(6, 12, 4, MAT.paperSh);
  p.p(0, 16, MAT.paperSh);
  p.p(6, 16, G.g7);
  p.p(1, 17, G.g7);
}
