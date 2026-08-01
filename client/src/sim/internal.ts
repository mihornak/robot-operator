/**
 * Sim-internal helpers, tuning constants, and robot scratch state.
 *
 * Robot scratch (i-frames, stun, once-per-order flags) has no home in the
 * shared RobotState contract, so it lives in a WeakMap keyed by SimState
 * (owned by sim/index.ts). This stays deterministic because scratch is a pure
 * function of the call sequence and is never serialized mid-run — a restart
 * always goes through initialState(), which starts from fresh scratch.
 */
import type { Entity, SimEvent, SimEventType, SimState } from '../../../shared/types';
import { rngNext } from '../../../shared/rng';
import { dist } from './physics';

// ---------------------------------------------------------------- tuning

export const ROBOT_R = 7;
export const ENEMY_R = 9;
/** Personality "can see the enemy" range (walls are ignored — the robot is dumb). */
export const SIGHT = 150;
export const AGGRO_RANGE = 120;
export const ATTACK_RANGE = 90;
/** Tier-0 shoot auto-aim: nearest hostile inside a 30° cone (cos of half-angle). */
export const SHOOT_CONE_COS = Math.cos((15 * Math.PI) / 180);
export const SHOOT_RANGE = 160;
export const BOLT_SPEED = 180;
export const PAPER_SPEED = 90;
export const ENEMY_SPEED = 30;
export const CONTACT_RANGE = 18;
export const KNOCKBACK_PX = 10;
export const IFRAME_TICKS = 60;
export const CABLE_RADIUS = 18;
export const CABLE_STUN_TICKS = 20;
export const MAGNET_RADIUS = 60;
export const PICKUP_RADIUS = 14;
export const CRATE_REACH = 24;
/** Wider crate proximity — crate_reached (ceremony trigger) fires at notice range. */
export const CRATE_NOTICE = 70;
export const ELEV_REACH = 20; // forgiving: driving past the shaft still counts
export const SOCKET_REACH = 18;
export const ARRIVE_RADIUS = 12;
export const BOLT_HIT_RADIUS = 10;
export const WALL_BUMP_EVERY = 45;
export const SPIT_TELEGRAPH_TICKS = 18;
export const LURCH_MOVE_TICKS = 30; // 0.5s lurch...
export const LURCH_PAUSE_TICKS = 18; // ...0.3s pause (menace rhythm)
export const SPIT_MIN_TICKS = 120; // +0..60 rng jitter ≈ spit every ~2.5s
export const SPIT_ANIM_TICKS = 8; // post-throw recoil pose (render shows 'spit')

// ---------------------------------------------------------------- scratch

export interface RobotScratch {
  /** i-frame ticks remaining after robot_damage. */
  iframes: number;
  /** Cable-zap stun ticks remaining (velocity zeroed). */
  stun: number;
  /** order_blocked reason 'rage' already emitted for the current order. */
  rageNotified: boolean;
  /** chip_flee already emitted for the current low-hp episode. */
  fleeEpisode: boolean;
  /** Scrap id MAGNET is detouring to; null when not detouring. */
  magnetTargetId: string | null;
  /** Px actually traveled under the CURRENT move order (distancePx nudges). */
  moveTraveledPx: number;
}

export function newScratch(): RobotScratch {
  return {
    iframes: 0,
    stun: 0,
    rageNotified: false,
    fleeEpisode: false,
    magnetTargetId: null,
    moveTraveledPx: 0,
  };
}

// ---------------------------------------------------------------- helpers

export function emit(
  state: SimState,
  type: SimEventType,
  id?: string,
  data?: Record<string, string | number>,
): void {
  const ev: SimEvent = { type };
  if (id !== undefined) ev.id = id;
  if (data !== undefined) ev.data = data;
  state.events.push(ev);
}

/** Advance the seeded rng and return [0,1). The ONLY randomness in the sim. */
export function roll(state: SimState): number {
  const r = rngNext(state.rngState);
  state.rngState = r.state;
  return r.value;
}

/** Per-entity ai scratch, created on demand. */
export function aiOf(e: Entity): Record<string, number> {
  return (e.ai ??= {});
}

export function entityById(state: SimState, id: string): Entity | null {
  for (const e of state.entities) if (e.id === id) return e;
  return null;
}

export function nearestHostile(state: SimState): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of state.entities) {
    if (e.kind !== 'fusedPrinter' || e.dead) continue;
    const d = dist(state.robot.pos, e.pos);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** Elevator B is powered unless the floor marked it 'dark' (floor 4 fuse gate; floors 2/5 triad gate — powerElevatorB lights it). */
export function isElevatorPowered(e: Entity): boolean {
  return e.state !== 'dark';
}
