/**
 * Local steering primitives — the "push away from that" half of movement.
 *
 * Routing (sim/pathfind.ts) knows about walls and nothing else: it plans over a
 * static grid, once every NAV_REPATH_TICKS. Everything that MOVES — machines,
 * the boss, a robot's own squadmates — has to be handled here, on top of the
 * route, every tick.
 *
 * Lifted out of robot.ts unchanged (identical arithmetic, identical operand
 * order, so a run that touches no new field is float-identical to before) and
 * parameterised, because the enemy AI needs the same field for enemy-vs-enemy
 * separation. A mob with no separation collapses to a single pixel, which is
 * the real reason a swarm currently reads as one very loud printer.
 */
import type { Vec } from '../../../shared/types';
import { REPULSE_SWIRL } from './internal';
import { dist, norm } from './physics';

/**
 * Add linear-falloff repulsion away from `atPos` into `acc`. Full `weight` at
 * the danger edge (`clear` px from centre), 0 at clear+radius: a peak above 1
 * beats the unit seek, so a field the caller means as a wall really is one.
 *
 * The tangential swirl component (side picked deterministically toward where
 * `desired` already leans) makes dead-ahead hazards get ORBITED — a pure radial
 * field between two bodies just oscillates on the approach axis forever, which
 * on screen is a robot vibrating at arm's length from a printer.
 *
 * Returns whether a term was actually added, so callers can leave an unpushed
 * `desired` completely untouched instead of running it through norm() for
 * nothing (see steer(): renormalising an already-unit vector every tick buys
 * float drift at no benefit).
 */
export function addRepulse(
  fromPos: Vec,
  atPos: Vec,
  clear: number,
  radius: number,
  weight: number,
  desired: Vec,
  acc: Vec,
): boolean {
  const dEff = Math.max(0, dist(fromPos, atPos) - clear);
  if (dEff >= radius) return false;
  const w = weight * (1 - dEff / radius);
  const away = norm({ x: fromPos.x - atPos.x, y: fromPos.y - atPos.y });
  const side = away.x * desired.y - away.y * desired.x >= 0 ? 1 : -1;
  acc.x += away.x * w - away.y * side * w * REPULSE_SWIRL;
  acc.y += away.y * w + away.x * side * w * REPULSE_SWIRL;
  return true;
}

/**
 * Blend `desired` with repulsion from a list of body positions and re-normalise.
 * The generic form of what the robot does to hostiles, for whoever needs bodies
 * to stop occupying the same point — the enemy AI above all.
 *
 * `others` should be a POSITION SNAPSHOT taken before anything in the group has
 * moved this tick, not live entity positions: reading positions as they mutate
 * makes A's push on B differ from B's push on A, and the whole flock's shape
 * becomes a function of array insertion order.
 *
 * Returns `desired` itself, unmodified, when nothing was near enough to push.
 */
export function separation(
  self: Vec,
  others: readonly Vec[],
  clear: number,
  radius: number,
  weight: number,
  desired: Vec,
): Vec {
  const acc = { x: desired.x, y: desired.y };
  let pushed = false;
  for (const o of others) {
    if (addRepulse(self, o, clear, radius, weight, desired, acc)) pushed = true;
  }
  return pushed ? norm(acc) : desired;
}
