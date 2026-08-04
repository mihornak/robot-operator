/**
 * Sim-internal helpers, tuning constants, and robot scratch state.
 *
 * Robot scratch (i-frames, stun, once-per-order flags) has no home in the
 * shared RobotState contract, so it lives in a WeakMap keyed by SimState
 * (owned by sim/index.ts). This stays deterministic because scratch is a pure
 * function of the call sequence and is never serialized mid-run — a restart
 * always goes through initialState(), which starts from fresh scratch.
 */
import type { Entity, Order, SimEvent, SimEventType, SimState, Vec } from '../../../shared/types';
import { rngNext } from '../../../shared/rng';
import { dist, losBlocked } from './physics';

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

// BRAIN (smart execution) tuning.
/** Cover search: candidate tile centers within this range of the robot. */
export const HIDE_SEARCH_RADIUS = 110;
/** careful ("sneak") speed factor while executing goto/pickup. */
export const CAREFUL_SPEED = 0.75; // still outruns a 30px/s printer (55*0.75=41)
/** Sneaking is QUIET: enemies notice a careful robot at half range. */
export const SNEAK_AGGRO_FACTOR = 0.5;
/** careful: repulsion field range around live hostiles + cables (px past clearance). */
export const CAREFUL_REPULSE_RADIUS = 60;
/** avoidIds standing orders: wider repulsion field (px past clearance). */
export const AVOID_REPULSE_RADIUS = 70;
/** Repulsion weight at the hazard EDGE, falling linearly to 0 at the field range. */
export const REPULSE_WEIGHT = 1.2;
/** Hazard clearance (cable zap r=18, enemy contact r=18): full repulsion holds
 *  at the danger edge, not the entity center — careful never enters the zone. */
export const REPULSE_CLEAR = 18;
/** Tangential fraction of the repulsion: dead-ahead hazards are ORBITED, not
 *  jittered against (a pure radial field oscillates forever on the axis). */
export const REPULSE_SWIRL = 0.5;
/** hide lands ON the cover point (goto's 12px slop could leave LOS leaking). */
export const HIDE_ARRIVE = 6;

/** Route-cost radius around an avoided thing, in tiles. */
export const AVOID_PENALTY_TILES = 2;
/** Route cost at the centre of an avoided thing, in tile-steps. Deliberately
 *  larger than the whole map's diagonal: when a clean route exists at all, it
 *  wins, which is what makes "avoid the sparks" change the DOOR the robot
 *  picks and not merely how it wobbles on the way through. */
export const AVOID_PENALTY_COST = 60;

// Navigation (A* + string pull, sim/pathfind.ts).
/** Ticks between route refreshes. Cheap enough to re-plan constantly, which is
 *  what makes the robot recover instantly from shoves, knockback and doors. */
export const NAV_REPATH_TICKS = 20;
/** A waypoint is "reached" this close — smaller than the body, so corners are
 *  actually rounded rather than pivoted around at arm's length. */
export const NAV_WAYPOINT_ARRIVE = 5;
/** A moving target sliding this far invalidates the plan immediately. */
export const NAV_TARGET_DRIFT = 14;

// Initiative (the robot playing the game on its own).
/**
 * Ticks of standing still before the robot decides anything UNPROMPTED. The
 * player has to be able to finish a sentence, and a companion that bolts the
 * instant an order completes reads as a runaway rather than as a partner.
 * Danger and deliveries skip this — those reactions are supposed to be fast.
 */
export const INITIATIVE_SETTLE = 110;
/** Ticks of having genuinely nothing left to do before it asks the operator. */
export const IDLE_ASK_TICKS = 300;
/** Self-directed pickups only bother with loot practically underfoot. Wide
 *  radii turned every idle moment into a shopping trip across the room. */
export const GATHER_RADIUS = 75;
/** Below this range a robot under "avoid enemies" breaks off and backs away. */
export const RETREAT_TRIGGER = 110;
/** Hard cap on one retreat episode, so backing off can't become the whole game. */
export const RETREAT_TICKS = 240;

/**
 * RAGE budget, in ticks. RAGE hijacks an order that would disengage — but only
 * for this long, then it relents and the order runs. Without a cap the robot
 * fixates on a machine it cannot even reach and stops obeying anything, which
 * reads as a hung game rather than as a personality.
 * Refills whenever no hostile is in sight, so every fresh encounter gets one.
 */
export const RAGE_BUDGET_TICKS = 200; // ~3.3s of "no, ROBOT is busy"

/** explore: arrival slop at a point of interest before moving to the next. */
export const EXPLORE_ARRIVE = 16;
/** explore: minimum distance of a random wander leg when nothing is left to visit. */
export const EXPLORE_WANDER_MIN = 70;
/** explore: ticks of wall-shoving before the current leg is abandoned for another. */
export const EXPLORE_GIVEUP_TICKS = 90;

/**
 * Entity kinds the robot will walk over to look at, whether touring on the
 * player's order or on its own initiative. Hostiles and hazards are absent —
 * curiosity must never be a suicide order. So is elevator B: leaving the floor
 * is the operator's decision, and a robot that sightsees its way into the lift
 * ends the level nobody asked to end.
 */
export const EXPLORE_KINDS: ReadonlySet<string> = new Set([
  'chip',
  'crate',
  'fuse',
  'fuseSocket',
  'scrap',
  'printerInnocent',
  'mop',
  'debris',
]);

/** Wander legs keep this far clear of elevator B for the same reason. */
export const ELEVATOR_KEEPOUT = 48;

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
  /** Cover point the CURRENT hide order seeks; computed on the order's first tick. */
  hideTarget: Vec | null;
  /** RAGE override ticks left for this encounter; refills when nothing is in sight. */
  rageTicks: number;
  /** explore: entity currently being walked to, or null when on a wander leg. */
  exploreTargetId: string | null;
  /** explore: destination point of the current leg. */
  explorePoint: Vec | null;
  /** explore: ids already visited this floor, so the tour keeps moving on. */
  exploreSeen: string[];
  /** Quiet-posture ticks after a careful order completes — stealth doesn't
   *  evaporate the instant the robot arrives and loiters in enemy territory. */
  sneakLingerTicks: number;
  /** Planned route (px waypoints, start excluded) for the current destination. */
  navPath: Vec[];
  /** Index of the waypoint currently being walked to. */
  navIndex: number;
  /** Destination the current plan was made for; null = no plan. */
  navGoal: Vec | null;
  /** Ticks until the route may be re-planned. */
  navCooldown: number;
  /** Last plan found no route at all (caller reports it instead of shoving). */
  navFailed: boolean;
  /** Reusable per-cell route-cost grid for avoided things; null until needed. */
  navPenalty: Float64Array | null;
  /** Ticks the robot has been standing around with no order at all. */
  idleTicks: number;
  /** threat_seen already called for the hostile currently in view. */
  threatCalled: boolean;
  /** Ticks of having nothing to do before need_orders fires again. */
  idleAskCd: number;
  /** Ticks left in the current retreat episode. */
  retreatTicks: number;
}

export function newScratch(): RobotScratch {
  return {
    iframes: 0,
    stun: 0,
    rageNotified: false,
    fleeEpisode: false,
    magnetTargetId: null,
    moveTraveledPx: 0,
    hideTarget: null,
    rageTicks: RAGE_BUDGET_TICKS,
    exploreTargetId: null,
    explorePoint: null,
    exploreSeen: [],
    sneakLingerTicks: 0,
    navPath: [],
    navIndex: 0,
    navGoal: null,
    navCooldown: 0,
    navFailed: false,
    navPenalty: null,
    idleTicks: 0,
    threatCalled: false,
    idleAskCd: IDLE_ASK_TICKS,
    retreatTicks: 0,
  };
}

/** Drop the current route. Any change of destination must go through this. */
export function clearNav(scratch: RobotScratch): void {
  scratch.navPath = [];
  scratch.navIndex = 0;
  scratch.navGoal = null;
  scratch.navCooldown = 0;
  scratch.navFailed = false;
}

/**
 * Install an order and reset every per-order counter. THE single entry point,
 * shared by the director (player orders) and the robot's own initiative — two
 * code paths writing `robot.order` with different resets is how stale nudge
 * distances and stale routes leak between tasks.
 */
export function applyOrder(
  state: SimState,
  scratch: RobotScratch,
  order: Order | null,
  selfDriven: boolean,
): void {
  const r = state.robot;
  r.order = order;
  r.selfDriven = order !== null && selfDriven;
  r.wallBumpTicks = 0;
  scratch.rageNotified = false;
  scratch.magnetTargetId = null; // a fresh order outranks the shiny detour
  scratch.moveTraveledPx = 0; // nudge distance counts from the fresh order
  scratch.hideTarget = null; // a fresh hide/retreat order picks cover anew
  scratch.explorePoint = null; // a fresh explore order starts a fresh leg
  scratch.exploreTargetId = null;
  scratch.retreatTicks = RETREAT_TICKS;
  scratch.idleTicks = 0; // anything happening restarts the settle clock
  clearNav(scratch);
  if (order === null) {
    r.vel.x = 0;
    r.vel.y = 0;
  }
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

/** How far the robot notices things. The floor-3 EARS crate (tier 2) widens it. */
export function sightOf(state: SimState): number {
  return state.robot.tier >= 2 ? SIGHT + 70 : SIGHT;
}

/** Nearest hostile the robot can actually SEE — in range and not behind a
 *  wall. Personality chips firing on a machine in the next room is where the
 *  old behaviour used to lock up, so every reaction goes through this. */
export function hostileInSight(state: SimState): Entity | null {
  const e = nearestHostile(state);
  if (e === null) return null;
  if (dist(state.robot.pos, e.pos) > sightOf(state)) return null;
  return losBlocked(state.solid, state.robot.pos, e.pos) ? null : e;
}

/** Elevator B is powered unless the floor marked it 'dark' (floor 4 fuse gate; floors 2/5 triad gate — powerElevatorB lights it). */
export function isElevatorPowered(e: Entity): boolean {
  return e.state !== 'dark';
}
