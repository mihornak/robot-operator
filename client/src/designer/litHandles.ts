/**
 * WHERE A LIGHT'S DRAG HANDLES ARE.
 *
 * Pure geometry, shared by the tools (which hit-test them) and the overlays
 * (which draw them). Two files computing handle positions from the same light
 * is two files that eventually disagree by three pixels, and a handle you can
 * see but not grab is worse than no handle.
 */

import type { LightPlacement } from '@shared/types';
import { TILE } from '@shared/types';

/** Grab radius in world px. Screen-space at 100%; generous on purpose. */
export const HANDLE_R = 4;

export type HandleId = 'body' | 'radius' | 'dir' | 'spreadA' | 'spreadB';

export interface Pt {
  x: number;
  y: number;
}

/** Lights sit at tile CENTRES — px = t * TILE + TILE/2. */
export const lightPos = (l: LightPlacement): Pt => ({
  x: l.tx * TILE + TILE / 2,
  y: l.ty * TILE + TILE / 2,
});

export const lightDir = (l: LightPlacement): number => l.dir ?? 0;
export const lightSpread = (l: LightPlacement): number => l.spread ?? 0.6;
export const isCone = (l: LightPlacement): boolean => l.kind === 'cone';

/** Out along the aim, at the authored radius: drag it to resize the pool. */
export function radiusHandle(l: LightPlacement): Pt {
  const p = lightPos(l);
  const a = isCone(l) ? lightDir(l) : 0;
  return { x: p.x + Math.cos(a) * l.radius, y: p.y + Math.sin(a) * l.radius };
}

/** Cones only: the aim handle, and the two edges of the wedge. */
export function dirHandle(l: LightPlacement): Pt | null {
  if (!isCone(l)) return null;
  const p = lightPos(l);
  const a = lightDir(l);
  const d = l.radius * 0.62;
  return { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d };
}

export function spreadHandles(l: LightPlacement): [Pt, Pt] | null {
  if (!isCone(l)) return null;
  const p = lightPos(l);
  const a = lightDir(l);
  const s = lightSpread(l);
  const d = l.radius * 0.62;
  return [
    { x: p.x + Math.cos(a - s) * d, y: p.y + Math.sin(a - s) * d },
    { x: p.x + Math.cos(a + s) * d, y: p.y + Math.sin(a + s) * d },
  ];
}

/**
 * Which handle is under the pointer, if any.
 *
 * Order matters: the handles win over the body, and the body wins over the
 * ring, because the ring is a whole circle and would otherwise swallow clicks
 * anywhere near it.
 */
export function handleAt(l: LightPlacement, x: number, y: number, tol = HANDLE_R): HandleId | null {
  const near = (p: Pt): boolean => Math.hypot(p.x - x, p.y - y) <= tol;
  const dir = dirHandle(l);
  if (dir && near(dir)) return 'dir';
  const spread = spreadHandles(l);
  if (spread) {
    if (near(spread[0])) return 'spreadA';
    if (near(spread[1])) return 'spreadB';
  }
  if (near(radiusHandle(l))) return 'radius';
  const p = lightPos(l);
  if (near(p) || Math.hypot(p.x - x, p.y - y) <= 6) return 'body';
  // Anywhere ON the ring resizes it — a 150px pool's handle can be off screen.
  if (Math.abs(Math.hypot(p.x - x, p.y - y) - l.radius) <= tol) return 'radius';
  return null;
}
