/**
 * Sim-internal helpers, tuning constants, and robot scratch state.
 *
 * Robot scratch (i-frames, stun, once-per-order flags) has no home in the
 * shared RobotState contract, so it lives in a WeakMap keyed by SimState
 * (owned by sim/index.ts). This stays deterministic because scratch is a pure
 * function of the call sequence and is never serialized mid-run — a restart
 * always goes through initialState(), which starts from fresh scratch.
 */
import type {
  Entity,
  EntityKind,
  Order,
  SimEvent,
  SimEventType,
  SimState,
  Vec,
} from '../../../shared/types';
import { rngNext } from '../../../shared/rng';
import { dist, losBlocked } from './physics';
// TYPE-ONLY, and it has to stay that way: threat.ts imports values from here,
// so a value import would close a module cycle. `import type` is erased.
import type { Threat } from './threat';

// ---------------------------------------------------------------- tuning

export const ROBOT_R = 7;
export const ENEMY_R = 9;
/** Boss body. Big enough that the arena has to be checked at r=13, not r=9. */
export const BOSS_R = 13;
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
/**
 * Where crate_reached fires — the ceremony trigger. Deliberately close.
 *
 * This was 70px, and in play the box opened while the robot was still most of
 * a tile away and clearly heading somewhere else, which reads as the crate
 * grabbing you rather than you reaching it. A reward you did not feel yourself
 * arrive at is a reward that happened TO the player. Still wider than
 * CRATE_REACH so driving past at speed counts, but you have to actually get
 * there.
 */
export const CRATE_NOTICE = 30;
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

// Bodies. Separation from hostiles that is ALWAYS on, directive or no
// directive. Without it there is zero local avoidance unless the player has
// said "avoid enemies", so a robot with a plain goto order drives straight
// through the middle of a mob — and the mob, having no separation of its own,
// is standing on one pixel waiting for it.
/** Body-separation field range past clearance. Deliberately tiny: 10px is far
 *  inside ATTACK_RANGE 90, so this stops the robot BURROWING into machines
 *  without moving where it chooses to stand and fight by a single pixel. */
export const BODY_REPULSE_RADIUS = 10;
/** Body-separation weight. Well under 1, so it never beats the unit seek — it
 *  is a shoulder, not a wall. "Avoid enemies" is what turns it into a wall. */
export const BODY_REPULSE_WEIGHT = 0.35;

// Cover search. See findCover: naively LOS-testing every candidate against
// every hostile is ~5k raycasts on a boss floor, so the search is two-phase.
/** Top N threats cover is taken from. Beyond three, the extra rays buy noise. */
export const COVER_TOP_K = 3;
/** Candidates this close to ANY live hostile are rejected before a single ray
 *  is cast. This is both the "must not hide INTO three others" rule and the
 *  thing that makes the rework cheaper than what it replaces. */
export const COVER_MIN_HOSTILE_DIST = 40;
/** How many phase-1 survivors get the expensive 5-ray coverBlocked confirm. */
export const COVER_CONFIRM = 4;
/** A held cover point is re-verified this often: a boss walks around a pillar,
 *  and cover that was true when the order started is a lie ten seconds later. */
export const COVER_RECHECK_TICKS = 30;

// Combat doctrine execution (Standing.spacing / focus / keepMoving).
/** `spacing: 'far'` holds a BAND, not a line. It straddles ATTACK_RANGE 90, so
 *  "keep back" is a place to stand and shoot from rather than a retreat — and a
 *  band rather than a target distance is what stops the robot pumping in and
 *  out across a single threshold as the machine drifts. */
export const STANDOFF_MIN = 70;
export const STANDOFF_MAX = 110;
/** Ticks of backing off while barely moving before "keep back" gives up and
 *  fights close. A cornered robot obeying a standoff rule to the letter just
 *  vibrates against the masonry while being eaten. */
export const STANDOFF_STUCK_TICKS = 20;
/** `spacing: 'close'` — in its face. Inside CONTACT_RANGE is suicide; this is
 *  one body-length outside it, which reads as menace and survives. */
export const CLOSE_RANGE = 35;
/** `keepMoving`: ticks per strafe direction. Side comes from a scratch counter,
 *  NEVER from roll(state) — a per-tick behaviour that consumes the seeded rng
 *  would make every other random draw in the sim depend on how long a fight
 *  lasted. */
export const STRAFE_FLIP_TICKS = 45;

// Threat ranking (sim/threat.ts). The multipliers live here with the rest of
// the tuning; the list, the cache and the selection live in threat.ts.
/** Something already coming for you outranks something that has not noticed. */
export const THREAT_AGGRO_MUL = 1.6;
/** Something mid-telegraph outranks both: the thing about to hit you IS the
 *  threat, however far away it happens to be standing. */
export const THREAT_TELEGRAPH_MUL = 1.4;

// `evade` order — keep moving through open ground, never stand still.
/** Ticks between destination re-picks. */
export const EVADE_REPICK_TICKS = 30;
/** Candidate tiles are drawn from this radius around the robot. */
export const EVADE_RADIUS = 120;
/** A leg shorter than this is not evasion, it is fidgeting. */
export const EVADE_MIN_LEG = 24;
/** Distance from a threat past which extra distance stops scoring. Without a
 *  cap the far corner of the map always wins and `evade` becomes `flee`. */
export const EVADE_FAR_CAP = 200;
/** Score subtracted for a candidate sitting inside a live blast zone. Large
 *  enough that no amount of distance makes standing in a red circle worth it. */
export const EVADE_ZONE_PENALTY = 400;
/** Score subtracted for a candidate near the point just vacated. This is the
 *  whole difference between evading and oscillating between two tiles. */
export const EVADE_REVISIT_PENALTY = 300;
/** How close counts as "the point just vacated". */
export const EVADE_REVISIT_RADIUS = 40;

/**
 * Route cost at the centre of a live blast zone, in tile-steps. Higher than
 * AVOID_PENALTY_COST because the two are not the same wager: brushing a cable
 * costs 1 hp and a stun, standing in a mortar costs 2 and does not care how
 * tough you are. When both are on the map the robot should take the sparks.
 */
export const ZONE_PENALTY_COST = 90;
/** Route-cost radius around a blast zone, in tiles. One wider than the cable
 *  ring: the circle itself is already ~1.6 tiles across before clearance. */
export const ZONE_PENALTY_TILES = 2;

/** Ticks before a threat_seen call-out may be repeated. It re-arms on a worse
 *  threat or a growing count, but a robot that re-reports the same room every
 *  two seconds is a nag, not a scout. */
export const THREAT_RECALL_TICKS = 600;

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
  'chair',
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
  /** Id of the worst threat the last threat_seen call-out was about; null when
   *  nothing has been called out for the current encounter. */
  threatCalledId: string | null;
  /** How many threats that call-out counted (a growing mob re-arms it). */
  threatCalledCount: number;
  /** state.tick of that call-out, for the repeat rate limit. */
  threatCalledTick: number;
  /** Ticks of having nothing to do before need_orders fires again. */
  idleAskCd: number;
  /** Ticks left in the current retreat episode. */
  retreatTicks: number;
  /**
   * Ranked live threats, worst first. Rebuilt at EXACTLY ONE point — the top of
   * stepRobot — and read by everything downstream. Never rebuild it lazily:
   * sim state mutates within a tick (the robot moves before the enemies do), so
   * "whichever behaviour asked first" would quietly become part of the
   * determinism contract, and reordering two `if`s would change the game.
   */
  threats: Threat[];
  /** state.tick the list above was built on (a debug/assert handle, and proof
   *  at a glance that nothing is reading a list from last tick). */
  threatTick: number;
  /** state.tick the held cover point was last re-verified. */
  hideCheckTick: number;
  /** Ticks of backing off under `spacing: 'far'` while going nowhere. Past
   *  STANDOFF_STUCK_TICKS the standoff rule gives up for this encounter. */
  standoffStuck: number;
  /** Monotonic strafe clock — the SIDE the robot strafes to is derived from
   *  this, not from the rng (see STRAFE_FLIP_TICKS). */
  strafeTicks: number;
  /** Where the `evade` order is currently heading; null = pick one. */
  evadePoint: Vec | null;
  /** state.tick that point was picked on. */
  evadeTick: number;
  /** The point evade just vacated — scored against, so it keeps moving. */
  evadePrev: Vec | null;
  /** zoneEpoch() the current route was planned against. A route planned when a
   *  different set of circles was on the floor was planned against a world that
   *  no longer exists — see navSeek. */
  zoneEpoch: number;
  /** Mortar ids the robot has already bailed out of, so `zone_dodge` fires once
   *  per circle rather than sixty times a second while it runs. */
  dodgedZoneIds: string[];
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
    threatCalledId: null,
    threatCalledCount: 0,
    threatCalledTick: -THREAT_RECALL_TICKS,
    idleAskCd: IDLE_ASK_TICKS,
    retreatTicks: 0,
    threats: [],
    threatTick: -1,
    hideCheckTick: 0,
    standoffStuck: 0,
    strafeTicks: 0,
    evadePoint: null,
    evadeTick: 0,
    evadePrev: null,
    zoneEpoch: 0,
    dodgedZoneIds: [],
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
  scratch.evadePoint = null; // ...and a fresh evade order picks a fresh leg
  scratch.evadePrev = null;
  scratch.standoffStuck = 0; // a new order deserves an honest try at the band
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

/**
 * Every kind that is a THREAT. One set, because the alternative is nine
 * copy-pasted `kind === 'fusedPrinter'` tests, and a second hostile added by
 * editing eight of them is a boss that is invisible to auto-aim on one line and
 * immune to RAGE on another — each miss silent, each in a different file.
 */
export const HOSTILE_KINDS: ReadonlySet<EntityKind> = new Set(['fusedPrinter', 'fusedShredder']);

/**
 * A machine that has not been woken yet is scenery: not a threat, not a target,
 * not something to route around. Cleared by wakeMachine(). Every scan that used
 * to ask "is this a live printer?" asks this instead.
 */
export const isLiveHostile = (e: Entity): boolean =>
  HOSTILE_KINDS.has(e.kind) && !e.dead && e.state !== 'dormant';

/** Stand a dormant machine up. Idempotent; also sets aggro, because a machine
 *  woken by a script or a boss phase is awake AND already looking for you. */
export function wakeMachine(e: Entity): void {
  if (e.state === 'dormant') e.state = 'idle';
  aiOf(e).aggro = 1;
}

/** Body radius by kind — the boss is genuinely bigger, not a scaled sprite. */
export function radiusOf(e: Entity): number {
  return e.kind === 'fusedShredder' ? BOSS_R : ENEMY_R;
}

/** How much this thing counts when ranking threats. 0 = not a threat at all. */
export function kindWeight(e: Entity): number {
  if (e.kind === 'fusedShredder') return 3;
  if (e.kind === 'fusedPrinter') return 1;
  return 0;
}

/**
 * How bad `e` is, right now, from `d` px away. Higher is worse.
 *
 * Lives here beside kindWeight because it is the same family of tuning — the
 * LIST, the per-tick cache and the target selection are sim/threat.ts's job.
 * Kept out of threat.ts specifically so hostileInSight below can rank without
 * importing it, i.e. without a module cycle.
 *
 * The telegraph term is the one that matters: a machine winding up a throw from
 * across the room is a bigger problem than one ambling toward you, and a robot
 * that ranks purely on proximity will always be looking the wrong way.
 */
export function threatScore(e: Entity, d: number, sight: number): number {
  const proximity = 1 - Math.min(d, sight) / sight;
  const ai = e.ai; // read, never aiOf(): ranking must not mutate the entity
  const aggroMul = ai?.aggro === 1 ? THREAT_AGGRO_MUL : 1;
  const telMul = (ai?.tel ?? 0) > 0 || (ai?.wind ?? 0) > 0 ? THREAT_TELEGRAPH_MUL : 1;
  return kindWeight(e) * proximity * aggroMul * telMul;
}

export function nearestHostile(state: SimState): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of state.entities) {
    if (!isLiveHostile(e)) continue;
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

/**
 * The WORST hostile the robot can actually see — in range and not behind a
 * wall. Personality chips firing on a machine in the next room is where the old
 * behaviour used to lock up, so every reaction goes through this.
 *
 * SEMANTIC CHANGE, and it is deliberate: this used to LOS-test the single
 * NEAREST hostile and return it, which meant the whole combat layer — SCARED,
 * RAGE, return fire, cover, retreat, the threat call-out — was written for
 * exactly one enemy, and a printer standing one pixel closer than the boss made
 * the boss invisible to all of it. It now ranks by threatScore. With one
 * hostile on the floor the two are identical, which is why floors 1–5 barely
 * notice; with a mob, "the nearest one" was never the right answer.
 *
 * This is the UNCACHED form, for callers outside the tick (the director asking
 * whether to light the HUD). Inside stepRobot, read sim/threat.ts's list — it
 * is built once per tick and ranks the same way.
 */
export function hostileInSight(state: SimState): Entity | null {
  const r = state.robot;
  const sight = sightOf(state);
  let best: Entity | null = null;
  let bestScore = -1;
  let bestD = Infinity;
  for (const e of state.entities) {
    if (!isLiveHostile(e)) continue;
    const d = dist(r.pos, e.pos);
    // Range and kind first: the raycast is the expensive part of this loop and
    // most candidates are excluded without one.
    if (d > sight) continue;
    if (losBlocked(state.solid, r.pos, e.pos)) continue;
    const score = threatScore(e, d, sight);
    // Strict > with a fixed scan order: ties resolve to the nearer one, then to
    // whichever came first in state.entities. Never to an id string — id order
    // is a floor-authoring accident, not a decision anyone made.
    if (score > bestScore || (score === bestScore && d < bestD)) {
      bestScore = score;
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
