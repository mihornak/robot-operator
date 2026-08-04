/**
 * Grid pathfinding. Pure, allocation-light, and DETERMINISTIC — same grid +
 * same endpoints always yields the same waypoint list, on every machine, so it
 * can live inside the fixed-timestep sim without touching the seeded rng.
 *
 * A* over TILE-sized cells, 8-way, corner-cutting banned, plus a small penalty
 * for wall-hugging cells so routes run down the middle of a corridor instead
 * of scraping along it. The raw cell path is then string-pulled against a
 * radius-aware clearance test, which is what turns a staircase of tile centers
 * into the two or three long straight legs an RTS unit actually walks.
 *
 * NOTE: robot radius 7 < TILE/2 = 8, so any non-solid cell fits the robot at
 * its center. That invariant is what makes cell-level planning sound here.
 */
import type { Vec } from '../../../shared/types';
import { TILE, TILES_X, TILES_Y } from '../../../shared/types';
import { dist, isSolidTile } from './physics';

const N = TILES_X * TILES_Y;
const DIAG = Math.SQRT2;
/** Cells touching a wall cost a little more — routes drift off the plaster. */
const HUG_PENALTY = 0.35;
/** 8-way neighbour offsets, fixed order (determinism: equal-cost ties resolve
 *  by insertion order, so the order of this table IS part of the contract). */
const NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, DIAG],
  [1, -1, DIAG],
  [-1, 1, DIAG],
  [-1, -1, DIAG],
];

// Scratch arrays, reused across calls — pathfinding runs a few times a second
// and must not churn the heap. Never read across calls (all are stamped/reset).
const gScore = new Float64Array(N);
const fScore = new Float64Array(N);
const cameFrom = new Int32Array(N);
const visitStamp = new Int32Array(N);
const closed = new Uint8Array(N);
let stamp = 0;

// Binary min-heap of cell indices keyed by fScore.
const heap = new Int32Array(N + 1);
let heapLen = 0;

function heapPush(cell: number): void {
  let i = ++heapLen;
  heap[i] = cell;
  while (i > 1) {
    const parent = i >> 1;
    if (fScore[heap[parent]] <= fScore[heap[i]]) break;
    const t = heap[parent];
    heap[parent] = heap[i];
    heap[i] = t;
    i = parent;
  }
}

function heapPop(): number {
  const top = heap[1];
  heap[1] = heap[heapLen--];
  let i = 1;
  for (;;) {
    const l = i * 2;
    const r = l + 1;
    let best = i;
    if (l <= heapLen && fScore[heap[l]] < fScore[heap[best]]) best = l;
    if (r <= heapLen && fScore[heap[r]] < fScore[heap[best]]) best = r;
    if (best === i) break;
    const t = heap[best];
    heap[best] = heap[i];
    heap[i] = t;
    i = best;
  }
  return top;
}

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx + (DIAG - 1) * dy : dy + (DIAG - 1) * dx;
}

function wallAdjacent(solid: boolean[][], tx: number, ty: number): boolean {
  return (
    isSolidTile(solid, tx - 1, ty) ||
    isSolidTile(solid, tx + 1, ty) ||
    isSolidTile(solid, tx, ty - 1) ||
    isSolidTile(solid, tx, ty + 1)
  );
}

export function tileOf(p: Vec): { tx: number; ty: number } {
  return { tx: Math.floor(p.x / TILE), ty: Math.floor(p.y / TILE) };
}

function center(tx: number, ty: number): Vec {
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
}

/**
 * True when a circle of radius r can slide from a to b without clipping a wall.
 * Sampled at the body's leading edges rather than only its center — a center
 * ray squeezes through diagonal wall seams the robot's shoulders cannot.
 */
export function clearPath(solid: boolean[][], a: Vec, b: Vec, r: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    const t = tileOf(a);
    return !isSolidTile(solid, t.tx, t.ty);
  }
  const nx = (-dy / len) * r;
  const ny = (dx / len) * r;
  // Step at half a body width so nothing thinner than the robot is skipped.
  const steps = Math.max(2, Math.ceil(len / (r * 0.9)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = a.x + dx * t;
    const cy = a.y + dy * t;
    for (const [ox, oy] of [
      [0, 0],
      [nx, ny],
      [-nx, -ny],
    ] as const) {
      if (isSolidTile(solid, Math.floor((cx + ox) / TILE), Math.floor((cy + oy) / TILE))) return false;
    }
  }
  return true;
}

/** Does the straight shot a→b clip any cell we are paying to stay out of? */
function lineIsPenalised(a: Vec, b: Vec, penalty: Float64Array): boolean {
  const steps = Math.max(2, Math.ceil(dist(a, b) / (TILE / 2)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const tx = Math.floor((a.x + (b.x - a.x) * t) / TILE);
    const ty = Math.floor((a.y + (b.y - a.y) * t) / TILE);
    if (tx < 0 || ty < 0 || tx >= TILES_X || ty >= TILES_Y) continue;
    if (penalty[ty * TILES_X + tx] > 0) return true;
  }
  return false;
}

/**
 * Build (into `out`) the extra per-cell cost of walking near the things the
 * standing orders say to stay off. `cost` is in units of tile-steps, so a value
 * well above the length of the detour is what buys a genuinely different route
 * rather than a shrug.
 */
export function markPenalty(out: Float64Array, hazards: readonly Vec[], radiusTiles: number, cost: number): void {
  out.fill(0);
  for (const h of hazards) {
    const cx = Math.floor(h.x / TILE);
    const cy = Math.floor(h.y / TILE);
    for (let ty = cy - radiusTiles; ty <= cy + radiusTiles; ty++) {
      for (let tx = cx - radiusTiles; tx <= cx + radiusTiles; tx++) {
        if (tx < 0 || ty < 0 || tx >= TILES_X || ty >= TILES_Y) continue;
        // Falls off with distance so the robot hugs the far side of a passage
        // it has no choice but to use, instead of treating it as solid.
        const ring = Math.max(Math.abs(tx - cx), Math.abs(ty - cy));
        const add = cost * (1 - ring / (radiusTiles + 1));
        const i = ty * TILES_X + tx;
        if (add > out[i]) out[i] = add;
      }
    }
  }
}

/** A scratch penalty grid for callers to fill via markPenalty. */
export function newPenaltyGrid(): Float64Array {
  return new Float64Array(N);
}

/**
 * Nearest walkable cell to p, spiralling outward. Targets legitimately sit
 * inside walls (a crate pushed against masonry, an elevator shaft), and a
 * planner that gives up on those makes the robot look broken rather than the
 * level look wrong.
 */
function nearestWalkable(solid: boolean[][], p: Vec): { tx: number; ty: number } | null {
  const { tx, ty } = tileOf(p);
  if (!isSolidTile(solid, tx, ty)) return { tx, ty };
  for (let ring = 1; ring <= 4; ring++) {
    let best: { tx: number; ty: number } | null = null;
    let bestD = Infinity;
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const nx = tx + dx;
        const ny = ty + dy;
        if (isSolidTile(solid, nx, ny)) continue;
        const c = center(nx, ny);
        const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
        // Strict < with a fixed scan order keeps the pick deterministic.
        if (d < bestD) {
          bestD = d;
          best = { tx: nx, ty: ny };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Waypoints from `from` to `to`, EXCLUDING the start, in px. Empty array when
 * no route exists (caller decides whether to shove hopefully in a straight
 * line or report the failure). The last waypoint is the exact target position
 * whenever the body can reach it from the previous corner.
 */
export function findPath(
  solid: boolean[][],
  from: Vec,
  to: Vec,
  radius: number,
  /** Optional per-cell extra cost (index ty*TILES_X+tx). This is what makes
   *  "avoid the sparks" a ROUTE decision rather than a nudge: local repulsion
   *  can only shove the robot sideways inside the corridor it already chose,
   *  so a floor built around two doors needs the planner itself to prefer the
   *  clean one. Null = plain shortest path. */
  penalty?: Float64Array | null,
): Vec[] {
  // Trivial case first: most orders are across an open room, and paying for A*
  // to rediscover "walk straight at it" every few ticks is pure waste. Skipped
  // when the straight line runs through cells we are being paid to avoid.
  if (clearPath(solid, from, to, radius) && !(penalty && lineIsPenalised(from, to, penalty))) {
    return [{ x: to.x, y: to.y }];
  }

  const start = nearestWalkable(solid, from);
  const goal = nearestWalkable(solid, to);
  if (!start || !goal) return [];
  const startIdx = start.ty * TILES_X + start.tx;
  const goalIdx = goal.ty * TILES_X + goal.tx;
  if (startIdx === goalIdx) return [{ x: to.x, y: to.y }];

  stamp++;
  heapLen = 0;
  gScore[startIdx] = 0;
  fScore[startIdx] = octile(start.tx, start.ty, goal.tx, goal.ty);
  cameFrom[startIdx] = -1;
  visitStamp[startIdx] = stamp;
  closed[startIdx] = 0;
  heapPush(startIdx);

  let found = false;
  // Bounded by cell count times the branching factor — a cell can be re-pushed
  // when a cheaper route to it turns up (lazy deletion, no decrease-key).
  for (let guard = 0; guard < N * 8 && heapLen > 0; guard++) {
    const cur = heapPop();
    if (closed[cur] === 1 && visitStamp[cur] === stamp) continue;
    closed[cur] = 1;
    if (cur === goalIdx) {
      found = true;
      break;
    }
    const cx = cur % TILES_X;
    const cy = (cur - cx) / TILES_X;
    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (isSolidTile(solid, nx, ny)) continue;
      // No cutting corners: a diagonal needs BOTH orthogonal cells open, or the
      // robot's shoulders clip the pillar it is squeezing past.
      if (dx !== 0 && dy !== 0 && (isSolidTile(solid, cx + dx, cy) || isSolidTile(solid, cx, cy + dy))) {
        continue;
      }
      const nIdx = ny * TILES_X + nx;
      if (visitStamp[nIdx] === stamp && closed[nIdx] === 1) continue;
      const step =
        cost + (wallAdjacent(solid, nx, ny) ? HUG_PENALTY : 0) + (penalty ? penalty[nIdx] : 0);
      const tentative = gScore[cur] + step;
      if (visitStamp[nIdx] === stamp && tentative >= gScore[nIdx]) continue;
      visitStamp[nIdx] = stamp;
      closed[nIdx] = 0;
      gScore[nIdx] = tentative;
      fScore[nIdx] = tentative + octile(nx, ny, goal.tx, goal.ty);
      cameFrom[nIdx] = cur;
      heapPush(nIdx);
    }
  }
  if (!found) return [];

  // Walk the parent chain back, then flip: raw cell centers, start first.
  const raw: Vec[] = [];
  for (let cur = goalIdx; cur !== -1; cur = cameFrom[cur]) {
    const tx = cur % TILES_X;
    raw.push(center(tx, (cur - tx) / TILES_X));
    if (raw.length > N) break; // paranoia: a cycle would hang the frame
  }
  raw.reverse();
  raw[0] = { x: from.x, y: from.y };
  // Land on the real target, not the middle of its cell, when the body fits.
  const lastCell = raw[raw.length - 1];
  if (clearPath(solid, lastCell, to, radius)) raw.push({ x: to.x, y: to.y });

  // String pull: keep only the corners the body actually has to turn at.
  const out: Vec[] = [];
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !clearPath(solid, raw[i], raw[j], radius)) j--;
    out.push(raw[j]);
    i = j;
  }
  return out;
}
