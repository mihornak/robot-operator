/**
 * Pure geometry + tile-grid collision. Pixel space, y grows down.
 * NOTE: sim files import shared/ via relative paths (not @shared) so the
 * determinism selftest can run under plain node type-stripping.
 */
import type { Dir, Vec } from '../../../shared/types';
import { TICK_HZ, TILE, TILES_X, TILES_Y } from '../../../shared/types';

export const DT = 1 / TICK_HZ;
const EPS = 0.01;

export function dirToVec(dir: Dir): Vec {
  switch (dir) {
    case 'up':
      return { x: 0, y: -1 };
    case 'down':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
  }
}

export function dominantDir(v: Vec): Dir {
  if (Math.abs(v.x) >= Math.abs(v.y)) return v.x >= 0 ? 'right' : 'left';
  return v.y >= 0 ? 'down' : 'up';
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function norm(v: Vec): Vec {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-6 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

/** Shortest-arc angle interpolation (head easing). */
export function angleLerp(from: number, to: number, t: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return from + d * t;
}

export function isSolidTile(solid: boolean[][], tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= TILES_X || ty >= TILES_Y) return true;
  return solid[ty][tx];
}

export function solidAtPx(solid: boolean[][], x: number, y: number): boolean {
  return isSolidTile(solid, Math.floor(x / TILE), Math.floor(y / TILE));
}

function circleRectOverlap(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function slideAxis(solid: boolean[][], pos: Vec, delta: number, r: number, isX: boolean): void {
  if (delta === 0) return;
  let next = (isX ? pos.x : pos.y) + delta;
  const cx = isX ? next : pos.x;
  const cy = isX ? pos.y : next;
  const minTx = Math.floor((cx - r) / TILE);
  const maxTx = Math.floor((cx + r) / TILE);
  const minTy = Math.floor((cy - r) / TILE);
  const maxTy = Math.floor((cy + r) / TILE);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!isSolidTile(solid, tx, ty)) continue;
      if (!circleRectOverlap(cx, cy, r, tx * TILE, ty * TILE, TILE, TILE)) continue;
      if (isX) {
        next = delta > 0 ? Math.min(next, tx * TILE - r - EPS) : Math.max(next, (tx + 1) * TILE + r + EPS);
      } else {
        next = delta > 0 ? Math.min(next, ty * TILE - r - EPS) : Math.max(next, (ty + 1) * TILE + r + EPS);
      }
    }
  }
  if (isX) pos.x = next;
  else pos.y = next;
}

/**
 * Axis-separated circle-vs-tile-grid move with wall slide.
 * Mutates pos; returns the distance actually moved (drives wall-bump detection).
 */
export function moveCircle(solid: boolean[][], pos: Vec, dx: number, dy: number, r: number): number {
  const x0 = pos.x;
  const y0 = pos.y;
  slideAxis(solid, pos, dx, r, true);
  slideAxis(solid, pos, dy, r, false);
  return Math.hypot(pos.x - x0, pos.y - y0);
}
