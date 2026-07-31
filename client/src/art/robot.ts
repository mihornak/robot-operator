/**
 * The robot — the ONLY saturated thing on screen. R2D2 silhouette, safety
 * orange, warm amber eye. Composed by render: wheels under body under head.
 */

import { ROBOT as B } from './palette';
import type { Px } from './px';

/** Head frame order per manifest: E,SE,S,SW,W,NW,N,NE. */
export const HEAD_DIRS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] as const;

/** robot_body 18×14, 2-frame idle bob (frame 1 sits 1px lower). */
export function drawRobotBody(p: Px, frame: number): void {
  const dy = frame; // bob
  // rounded chassis silhouette
  p.hl(4, 1 + dy, 10, B.hi); // top cap catches light
  p.hl(2, 2 + dy, 14, B.base);
  p.r(1, 3 + dy, 16, 7, B.base); // widest band y3..9
  p.hl(2, 10 + dy, 14, B.base);
  p.hl(3, 11 + dy, 12, B.shade);
  p.hl(5, 12 + dy, 8, B.deep); // skirt into the wheels
  // shading: light from top-left
  p.hl(2, 2 + dy, 7, B.hi);
  p.vl(1, 3 + dy, 4, B.hi);
  p.vl(16, 3 + dy, 7, B.shade);
  p.p(15, 2 + dy, B.shade);
  p.hl(10, 10 + dy, 6, B.shade);
  // panel seam across the belly
  p.hl(2, 7 + dy, 14, B.shade);
  // service hatch, upper right, with a tiny amber status pip
  p.box(11, 3 + dy, 4, 3, B.shade);
  p.p(12, 4 + dy, B.eye);
  // front vents below the seam
  p.vl(4, 8 + dy, 2, B.shade);
  p.vl(6, 8 + dy, 2, B.shade);
}

/** robot_wheels 18×8, 4-frame tread roll (lugs scroll 1px/frame, spacing 4). */
export function drawRobotWheels(p: Px, frame: number): void {
  for (const bx of [1, 10]) {
    // rounded tread block, 7 wide
    p.hl(bx + 1, 1, 5, B.treadHi);
    p.r(bx, 2, 7, 4, B.tread);
    p.hl(bx + 1, 6, 5, B.treadLug); // ground contact
    // scrolling tread lugs
    for (let gx = bx; gx < bx + 7; gx++) {
      if ((((gx - frame) % 4) + 4) % 4 === 0) p.vl(gx, 2, 4, B.treadLug);
    }
    p.p(bx, 2, B.treadHi); // corner glint
  }
  // center axle in the gap
  p.r(8, 3, 2, 2, B.socket);
}

/** Socket/eye placement per dir index; null = back of head (N-ish). */
const EYE: Array<{ sx: number; sy: number; ex: number } | null> = [
  { sx: 8, sy: 4, ex: 10 }, // E — lens wraps the dome edge
  { sx: 6, sy: 5, ex: 8 }, // SE — sits low, looking into the room
  { sx: 4, sy: 5, ex: 5 }, // S — front, centered: the face
  { sx: 2, sy: 5, ex: 2 }, // SW
  { sx: 0, sy: 4, ex: 0 }, // W
  null, // NW
  null, // N
  null, // NE
];

/** robot_head 12×10, 8 dirs (E,SE,S,SW,W,NW,N,NE). Eye placement sells it. */
export function drawRobotHead(p: Px, frame: number): void {
  // dome
  p.hl(4, 0, 4, B.hi);
  p.hl(2, 1, 8, B.base);
  p.hl(1, 2, 10, B.base);
  p.r(0, 3, 12, 6, B.base);
  p.hl(1, 9, 10, B.deep); // neck rim
  // light from top-left
  p.hl(2, 1, 3, B.hi);
  p.p(1, 2, B.hi);
  p.p(2, 2, B.hi);
  p.p(0, 3, B.hi);
  p.p(0, 4, B.hi);
  // right/bottom shade
  p.vl(11, 3, 5, B.shade);
  p.p(10, 2, B.shade);
  p.hl(0, 8, 12, B.shade);
  // antenna nub
  p.p(8, 0, B.shade);

  const e = EYE[frame];
  if (e) {
    // dark lens housing + warm amber eye with a hot core
    p.r(e.sx, e.sy, 4, 3, B.socket);
    p.r(e.ex, e.sy + 1, 2, 2, B.eye);
    p.p(e.ex + (frame <= 2 ? 1 : 0), e.sy + 1, B.eyeCore); // core leads the look
  } else if (frame === 5) {
    // NW: turned away, eye sliver peeking at the far left edge
    p.vl(7, 1, 8, B.shade);
    p.r(0, 4, 2, 2, B.socket);
    p.p(0, 4, B.eye);
  } else if (frame === 6) {
    // N: full back of head — seam + access panel
    p.vl(5, 1, 8, B.shade);
    p.r(4, 4, 4, 3, B.shade);
    p.p(5, 5, B.deep);
    p.p(6, 5, B.deep);
  } else {
    // NE: mirror of NW
    p.vl(4, 1, 8, B.shade);
    p.r(10, 4, 2, 2, B.socket);
    p.p(11, 4, B.eye);
  }
}

/** part_plate 6×5 — orange armor chip that flies off on damage. */
export function drawPartPlate(p: Px, _frame: number): void {
  p.hl(1, 0, 4, B.hi);
  p.r(0, 1, 6, 2, B.base);
  p.hl(0, 3, 6, B.shade);
  p.hl(1, 4, 4, B.deep);
  p.p(2, 2, B.socket); // rivet hole
}

/** part_antenna 3×7 — snapped antenna, amber bead tip. */
export function drawPartAntenna(p: Px, _frame: number): void {
  p.vl(1, 1, 5, B.treadHi);
  p.p(1, 0, B.eye);
  p.hl(0, 6, 3, B.shade); // torn mount
}
