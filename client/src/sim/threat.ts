/**
 * Who is trying to kill the robot, ranked — the one list the whole combat layer
 * reads.
 *
 * Before this file there was `hostileInSight()`, which LOS-tested the single
 * NEAREST hostile. SCARED, RAGE, return fire, cover, retreat, the threat
 * call-out and the robot's own initiative all hung off that one call, so the
 * combat layer was, in every branch, written for exactly one enemy. Two printers
 * and a boss produced a robot reacting to whichever body happened to be a pixel
 * closer.
 *
 * The list replaces that with a ranking. It is built ONCE per tick, at the top
 * of stepRobot, and cached in scratch — see refreshThreats for why "once, there,
 * never lazily" is load-bearing rather than tidy.
 */
import type { Entity, SimState, Standing } from '../../../shared/types';
import {
  isLiveHostile,
  kindWeight,
  sightOf,
  threatScore,
} from './internal';
import type { RobotScratch } from './internal';
import { dist, losBlocked } from './physics';

export interface Threat {
  e: Entity;
  /** Distance from the robot when the list was built, px. */
  d: number;
  /** threatScore: kindWeight × proximity × aggro × telegraph. Higher is worse. */
  score: number;
  /** Already coming for us. The gate on returning fire lives on this, and
   *  shooting a machine that has not noticed you is the "guns blazing" bug. */
  aggro: boolean;
}

/**
 * Rebuild the ranked threat list into `scratch`.
 *
 * CALL THIS FROM EXACTLY ONE PLACE — the top of stepRobot, before any
 * behaviour runs. Not lazily, not on first read.
 *
 * The reason is determinism, and it is not theoretical: sim state mutates
 * within a tick. stepRobot moves the robot; stepEnemies then moves the
 * machines. A list built on demand would be a list built at whatever moment the
 * first behaviour that wanted it happened to run, so the ORDER OF THE `if`
 * STATEMENTS in stepRobot would silently become part of the determinism
 * contract. Swapping two unrelated branches would change the game, and the
 * selftest would catch it as a divergence with no obvious cause.
 *
 * Ordering is worst-first, ties broken by distance and then by position in
 * state.entities (Array#sort is stable per spec, and the list is built in
 * entity order). Never by id string: id ordering is an artefact of how a floor
 * was typed out.
 */
export function refreshThreats(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
  const sight = sightOf(state);
  const out: Threat[] = [];
  for (const e of state.entities) {
    // Kind, corpse and dormant-as-scenery in one test, then range — everything
    // cheap happens BEFORE the raycast, which is the only expensive part of
    // this loop and the reason ranking N enemies costs about what ranking one
    // used to.
    if (!isLiveHostile(e)) continue;
    const d = dist(r.pos, e.pos);
    if (d > sight) continue;
    if (losBlocked(state.solid, r.pos, e.pos)) continue;
    out.push({ e, d, score: threatScore(e, d, sight), aggro: e.ai?.aggro === 1 });
  }
  out.sort((a, b) => b.score - a.score || a.d - b.d);
  scratch.threats = out;
  scratch.threatTick = state.tick;
}

/** This tick's ranked threats, worst first. Empty when the floor is quiet. */
export function threatsOf(scratch: RobotScratch): readonly Threat[] {
  return scratch.threats;
}

/**
 * Which one to point the gun at, under the player's focus doctrine.
 *
 * - `auto`   — the worst by blended score. Identical to the old "nearest" when
 *              there is one hostile, which is most of the game.
 * - `dangerous` ("BIG FIRST") — biggest kindWeight regardless of who is closer.
 *              The boss dies first even while its adds are chewing on you; that
 *              is the player's call to make and the point of saying it.
 * - `nearest` ("NEAR FIRST") — strictly closest. Triage, not strategy.
 *
 * `filter` is how a caller says "…that I can actually hit from here". Returns
 * null when nothing passes it, and callers must handle that rather than
 * defaulting to shooting a wall.
 */
export function pickTarget(
  threats: readonly Threat[],
  focus: Standing['focus'],
  filter?: (t: Threat) => boolean,
): Threat | null {
  let best: Threat | null = null;
  for (const t of threats) {
    if (filter && !filter(t)) continue;
    if (best === null) {
      best = t;
      continue;
    }
    // Strict comparisons only, over a list that is already in a fixed order, so
    // every tie falls through to "the one the ranking already put first".
    if (focus === 'nearest') {
      if (t.d < best.d) best = t;
    } else if (focus === 'dangerous') {
      const kw = kindWeight(t.e);
      const kb = kindWeight(best.e);
      if (kw > kb || (kw === kb && t.score > best.score)) best = t;
    }
    // 'auto': the list is already sorted worst-first, so the first survivor wins.
  }
  return best;
}

/**
 * Aggregate pull toward the threat field, un-normalised: Σ score × (threat −
 * robot) over the top `k`.
 *
 * Deliberately NOT normalised. Every caller only wants a DIRECTION or the SIGN
 * of a dot product, and skipping the norm is what keeps the one-threat case
 * numerically identical to the single-hostile arithmetic this replaced —
 * scaling a vector by a positive weight cannot change the sign of a dot
 * product, but re-normalising it can change its low bits.
 */
export function threatPull(
  threats: readonly Threat[],
  from: { x: number; y: number },
  k: number,
): { x: number; y: number } {
  const acc = { x: 0, y: 0 };
  const n = Math.min(k, threats.length);
  for (let i = 0; i < n; i++) {
    const t = threats[i];
    // Score can legitimately be 0 (a hostile sitting exactly at sight range),
    // and a zero-weight threat is a threat the field forgets about. The floor
    // keeps every live body in the sum without letting it dominate.
    const w = t.score + 0.05;
    acc.x += (t.e.pos.x - from.x) * w;
    acc.y += (t.e.pos.y - from.y) * w;
  }
  return acc;
}

/** Closest of the ranked threats, px. Infinity when there are none. The
 *  "something is about to touch me" question, which is a different question
 *  from "what is the worst thing in the room". */
export function nearestThreatDist(threats: readonly Threat[]): number {
  let d = Infinity;
  for (const t of threats) if (t.d < d) d = t.d;
  return d;
}
