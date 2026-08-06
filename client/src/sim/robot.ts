/**
 * Robot order execution + personality overrides. One call per tick.
 * Priority: sulk > stun > SCARED flee > MAGNET detour > RAGE > standing order.
 * Straight-line seeking with wall slide is deliberate — dumb pathing is the joke.
 */
import type { DamageChannel, Entity, Order, RobotState, SimState, Vec } from '../../../shared/types';
import { TILE, TILES_X, TILES_Y } from '../../../shared/types';
import { BASE } from '../../../shared/content';
import {
  ARRIVE_RADIUS,
  ATTACK_RANGE,
  AVOID_PENALTY_COST,
  AVOID_PENALTY_TILES,
  AVOID_REPULSE_RADIUS,
  BODY_REPULSE_RADIUS,
  BODY_REPULSE_WEIGHT,
  BOLT_SPEED,
  CABLE_STUN_TICKS,
  CAREFUL_REPULSE_RADIUS,
  CAREFUL_SPEED,
  CLOSE_RANGE,
  COVER_CONFIRM,
  COVER_MIN_HOSTILE_DIST,
  COVER_RECHECK_TICKS,
  COVER_TOP_K,
  CRATE_NOTICE,
  ELEVATOR_KEEPOUT,
  ELEV_REACH,
  EVADE_FAR_CAP,
  EVADE_MIN_LEG,
  EVADE_RADIUS,
  EVADE_REPICK_TICKS,
  EVADE_REVISIT_PENALTY,
  EVADE_REVISIT_RADIUS,
  EVADE_ZONE_PENALTY,
  EXPLORE_ARRIVE,
  EXPLORE_GIVEUP_TICKS,
  EXPLORE_KINDS,
  EXPLORE_WANDER_MIN,
  GATHER_RADIUS,
  HIDE_ARRIVE,
  HOSTILE_KINDS,
  HIDE_SEARCH_RADIUS,
  IDLE_ASK_TICKS,
  IFRAME_TICKS,
  INITIATIVE_SETTLE,
  MAGNET_RADIUS,
  NAV_REPATH_TICKS,
  NAV_TARGET_DRIFT,
  NAV_WAYPOINT_ARRIVE,
  PICKUP_RADIUS,
  RAGE_BUDGET_TICKS,
  REPULSE_CLEAR,
  REPULSE_WEIGHT,
  RETREAT_TRIGGER,
  ROBOT_R,
  SHOOT_CONE_COS,
  SHOOT_RANGE,
  SOCKET_REACH,
  STANDOFF_MAX,
  STANDOFF_MIN,
  STANDOFF_STUCK_TICKS,
  STRAFE_FLIP_TICKS,
  THREAT_RECALL_TICKS,
  WALL_BUMP_EVERY,
  ZONE_PENALTY_COST,
  ZONE_PENALTY_TILES,
  aiOf,
  applyOrder,
  clearNav,
  emit,
  entityById,
  isElevatorPowered,
  isLiveHostile,
  radiusOf,
  roll,
} from './internal';
import type { RobotScratch } from './internal';
import { addPenalty, findPath, markPenalty, newPenaltyGrid } from './pathfind';
import { zoneEpoch, zoneEscapeDir, zoneUnderfoot, zonesToRoute } from './mortar';
import { nearestThreatDist, pickTarget, refreshThreats, threatPull, threatsOf } from './threat';
import type { Threat } from './threat';
import { addRepulse } from './steering';
// Closes a cycle: projectiles.ts imports damageRobot from here. Safe, and
// deliberately so — both directions are hoisted function DECLARATIONS used only
// from inside function bodies at tick time, never read at module scope, so
// neither module can observe the other half-initialised. (Same shape as the
// enemies.ts → robot.ts edge that already exists.) Keep it that way: a top-level
// `const` read across this edge would be a live TDZ hazard.
import { fireRocket, rocketBlockedReason } from './projectiles';
import {
  DT,
  angleLerp,
  dirToVec,
  dist,
  isSolidTile,
  losBlocked,
  moveCircle,
  norm,
  solidAtPx,
} from './physics';

function easeHead(r: RobotState): void {
  r.headFacing = angleLerp(r.headFacing, r.facing, 0.15);
}

function halt(r: RobotState): void {
  r.vel.x = 0;
  r.vel.y = 0;
}

function shootCdMax(r: RobotState): number {
  return BASE.shootCdTicks - (r.chips.includes('ZAP') ? 8 : 0);
}

/** Set velocity toward dirUnit, update facing, move with wall slide. Returns px moved. */
function moveAndFace(state: SimState, dirUnit: Vec, speedScale = 1): number {
  const r = state.robot;
  r.vel.x = dirUnit.x * r.speed * speedScale;
  r.vel.y = dirUnit.y * r.speed * speedScale;
  if (Math.abs(r.vel.x) > 0.01 || Math.abs(r.vel.y) > 0.01) r.facing = Math.atan2(r.vel.y, r.vel.x);
  return moveCircle(state.solid, r.pos, r.vel.x * DT, r.vel.y * DT, ROBOT_R);
}

/** Probe distance for the wall check below: the body radius plus a step, so
 *  "clear" means clear for the CHASSIS rather than for its centre point. */
const PROBE_PX = ROBOT_R + 5;
/**
 * Headings tried by unstick(), radians off the wanted one. Nearest first, and
 * both signs at every step so the choice can never drift to one side. Stops at
 * ±90°: past a right angle the robot would be running back into the thing it
 * was told to leave, and a dodge that reverses into the circle is worse than a
 * dodge that scrapes along the wall.
 */
const UNSTICK_FAN: readonly number[] = (() => {
  const out = [0];
  for (let deg = 22.5; deg <= 90; deg += 22.5) {
    out.push((deg * Math.PI) / 180, (-deg * Math.PI) / 180);
  }
  return out;
})();

/**
 * The nearest heading to `dir` the body can actually take, or null when the
 * robot is genuinely walled in.
 *
 * Walls are the one obstacle steer() cannot see: repulsion only knows about
 * entities, and moveCircle resolves masonry AFTER the fact by sliding — which
 * inside a corner slides to zero on both axes. That is not hypothetical. A
 * mortar landing in the top-left of the boss arena told the robot to run
 * further into the corner; it vibrated against two walls for 64 ticks and ate
 * the blast, with the reflex firing correctly the entire time.
 *
 * A grid probe rather than a raycast: the question is only "is there masonry
 * one step that way", which is a handful of tile lookups on a path that runs
 * every tick a circle is underfoot.
 */
function unstick(state: SimState, dir: Vec): Vec | null {
  const r = state.robot;
  const base = Math.atan2(dir.y, dir.x);
  for (const off of UNSTICK_FAN) {
    const a = base + off;
    const c = { x: Math.cos(a), y: Math.sin(a) };
    if (!solidAtPx(state.solid, r.pos.x + c.x * PROBE_PX, r.pos.y + c.y * PROBE_PX)) return c;
  }
  return null;
}

/** Is this order (or the standing default) asking for quiet, slow movement? */
function isCareful(state: SimState, careful?: boolean): boolean {
  return careful === true || state.robot.standing.careful;
}

/**
 * Local steering: blend a desired unit direction with repulsion from the things
 * in the way. The route from A* handles walls; this handles the moving,
 * dangerous, wall-less stuff a static grid cannot know about. Normalized, so a
 * blend never slows the robot; a dead-cancel (cornered by two fields) yields
 * {0,0} and reads as a stall the bumpCheck give-up will clear.
 *
 * Two tiers, and the difference between them is the whole point:
 *
 * - What the STANDING ORDERS say to stay off — named avoid ids, hostiles under
 *   "avoid enemies", cables under "avoid hazards", both when moving carefully.
 *   Full REPULSE_WEIGHT: peak above 1, so it beats the unit seek and the robot
 *   genuinely cannot push through head-on. A rule, not a lean.
 * - BODIES, always, rule or no rule. This used to be gated behind a directive,
 *   and the early return meant a robot with a plain goto order had ZERO local
 *   avoidance and drove straight through the middle of a mob. BODY_REPULSE_* is
 *   deliberately tiny (10px past clearance, weight 0.35 — far inside
 *   ATTACK_RANGE 90), so it stops the robot burrowing into machines without
 *   moving where it chooses to stand and fight.
 *
 * `pushed` rather than an early return: with nothing near, `desired` comes back
 * byte-for-byte instead of being run through norm(). Renormalising an already
 * unit vector sixty times a second is free float drift, and the determinism
 * test is the thing that would find out.
 */
function steer(state: SimState, desired: Vec, careful: boolean): Vec {
  const r = state.robot;
  const st = r.standing;
  const dodgeFoes = careful || st.avoidEnemies;
  const dodgeHazards = careful || st.avoidHazards;
  // "Get in its face" and "stay off it" are the same instruction with opposite
  // signs; running both would leave the robot hovering at whatever range they
  // happen to cancel. The directive wins.
  const closing = st.spacing === 'close';
  const acc = { x: desired.x, y: desired.y };
  let pushed = false;
  for (const e of state.entities) {
    if (e.dead) continue;
    if (st.avoidIds.includes(e.id)) {
      if (addRepulse(r.pos, e.pos, REPULSE_CLEAR, AVOID_REPULSE_RADIUS, REPULSE_WEIGHT, desired, acc)) {
        pushed = true;
      }
    } else if (isLiveHostile(e)) {
      if (closing) continue;
      // A standing "avoid enemies" is a wider berth than mere caution, and mere
      // caution is a wider berth than merely not standing inside it.
      const radius = dodgeFoes
        ? st.avoidEnemies
          ? AVOID_REPULSE_RADIUS
          : CAREFUL_REPULSE_RADIUS
        : BODY_REPULSE_RADIUS;
      const weight = dodgeFoes ? REPULSE_WEIGHT : BODY_REPULSE_WEIGHT;
      // Body separation measures from the SKIN, so the boss's r=13 chassis
      // pushes further out than a printer's r=9 without a second constant.
      const clear = dodgeFoes ? REPULSE_CLEAR : radiusOf(e) + ROBOT_R;
      if (addRepulse(r.pos, e.pos, clear, radius, weight, desired, acc)) pushed = true;
    } else if (dodgeHazards && e.kind === 'cable') {
      if (addRepulse(r.pos, e.pos, REPULSE_CLEAR, CAREFUL_REPULSE_RADIUS, REPULSE_WEIGHT, desired, acc)) {
        pushed = true;
      }
    }
  }
  return pushed ? norm(acc) : desired;
}

/**
 * The extra route cost of the things the standing orders say to stay off, or
 * null when nothing is being avoided.
 *
 * This is the difference between a rule the robot obeys and a rule it merely
 * leans away from. Local repulsion can only push sideways within the corridor
 * A* already committed to; a floor whose whole lesson is "there are two doors,
 * one of them bites" needs the PLANNER to know. Cost is set well above any
 * plausible detour so the clean door always wins when a clean door exists —
 * and falls off with distance, so a passage the robot has no choice but to use
 * is hugged on its far side rather than treated as a wall.
 */
function routePenalty(state: SimState, scratch: RobotScratch, careful: boolean): Float64Array | null {
  const st = state.robot.standing;
  const dodgeHazards = careful || st.avoidHazards;
  const hazards: Vec[] = [];
  for (const e of state.entities) {
    if (e.dead) continue;
    if (st.avoidIds.includes(e.id)) hazards.push(e.pos);
    else if (dodgeHazards && e.kind === 'cable') hazards.push(e.pos);
    else if ((careful || st.avoidEnemies) && isLiveHostile(e)) hazards.push(e.pos);
  }
  // Blast zones are a SEPARATE mark: they are worse than a cable and they are
  // wider, so folding them into the same call would either undersell the circle
  // or overprice the sparks. Only zones with real fuse left — see
  // ZONE_ROUTE_MIN_FUSE: one about to detonate is a crater, not an obstacle,
  // and routing around it spends the exact second the robot needed to leave.
  const zones = isDodgingZones(state, careful) ? zonesToRoute(state) : [];
  if (hazards.length === 0 && zones.length === 0) return null;
  scratch.navPenalty ??= newPenaltyGrid();
  markPenalty(scratch.navPenalty, hazards, AVOID_PENALTY_TILES, AVOID_PENALTY_COST);
  // markPenalty fills from zero, so the zones have to be added on top rather
  // than in a second call that would wipe the first.
  if (zones.length > 0) {
    addPenalty(scratch.navPenalty, zones.map((m) => m.target), ZONE_PENALTY_TILES, ZONE_PENALTY_COST);
  }
  return scratch.navPenalty;
}

/** Does the robot route around telegraphed blast zones right now? Off by
 *  default — "avoid the red circles" has to visibly DO something, so it must
 *  not already be on — but moving carefully implies it, same as for cables.
 *  This gates ROUTING only. The point-blank reflex ignores it entirely. */
function isDodgingZones(state: SimState, careful: boolean): boolean {
  return careful || state.robot.standing.dodgeZones;
}

/**
 * Walk toward `target` along a planned route. THE movement primitive for every
 * order that goes somewhere.
 *
 * The route is re-planned on a short cooldown and whenever the destination
 * drifts, so chasing a moving printer and recovering from knockback both fall
 * out of the same code. Waypoints are consumed as they are reached; the last
 * leg aims at the real target position. Repulsion from `steer` rides on top of
 * the route direction, which is what lets "go to the elevator AND avoid the
 * machines" bend around a printer without abandoning the route.
 *
 * Returns px actually moved (drives bump detection).
 */
function navSeek(state: SimState, scratch: RobotScratch, target: Vec, careful: boolean): number {
  const r = state.robot;
  // The circles move faster than the repath clock. routePenalty is only rebuilt
  // when a plan is, i.e. every NAV_REPATH_TICKS = 20 — but a mortar can arm AND
  // detonate inside one of those windows, so a route baked against last
  // window's grid keeps carefully steering around a crater that is no longer
  // there, and walks straight through one that has appeared since. Invalidate
  // on the zone signature instead of waiting for the clock.
  //
  // Gated on the routing flag: a boss firing every two seconds would otherwise
  // thrash the nav of a robot that was explicitly told to ignore the circles.
  const dodging = isDodgingZones(state, careful);
  const needPlan =
    scratch.navGoal === null ||
    dist(scratch.navGoal, target) > NAV_TARGET_DRIFT ||
    scratch.navCooldown <= 0 ||
    scratch.navIndex >= scratch.navPath.length ||
    (dodging && scratch.zoneEpoch !== zoneEpoch(state));
  if (needPlan) {
    scratch.navPath = findPath(state.solid, r.pos, target, ROBOT_R, routePenalty(state, scratch, careful));
    scratch.navIndex = 0;
    scratch.navGoal = { x: target.x, y: target.y };
    scratch.navCooldown = NAV_REPATH_TICKS;
    scratch.navFailed = scratch.navPath.length === 0;
    scratch.zoneEpoch = zoneEpoch(state);
  } else {
    scratch.navCooldown--;
  }

  // Skip waypoints already reached (a fast tick can clear more than one).
  while (
    scratch.navIndex < scratch.navPath.length - 1 &&
    dist(r.pos, scratch.navPath[scratch.navIndex]) <= NAV_WAYPOINT_ARRIVE
  ) {
    scratch.navIndex++;
  }
  // No route: aim straight at it anyway. A robot shoving hopefully at a wall
  // is a readable failure; a robot standing still looks like a crashed game.
  const wp = scratch.navPath[scratch.navIndex] ?? target;
  const desired = norm({ x: wp.x - r.pos.x, y: wp.y - r.pos.y });
  return moveAndFace(state, steer(state, desired, careful), careful ? CAREFUL_SPEED : 1);
}

/** Bump-bump-bump for ~4s (long enough for the scripted gag), then give up. */
const WALL_STOP_TICKS = 240;

/** wall_bump comedy: throttled — first contact, then every WALL_BUMP_EVERY ticks. */
function bumpCheck(state: SimState, moved: number, expected: number): void {
  const r = state.robot;
  if (expected <= 0.001) return;
  if (moved < expected * 0.25) {
    r.wallBumpTicks++;
    if (r.wallBumpTicks === 1 || r.wallBumpTicks % WALL_BUMP_EVERY === 0) {
      emit(state, 'wall_bump', undefined, { ticks: r.wallBumpTicks });
    }
    if (r.wallBumpTicks >= WALL_STOP_TICKS && r.order) {
      halt(r);
      r.order = null;
      r.wallBumpTicks = 0;
      emit(state, 'order_blocked', undefined, { reason: 'wall' });
    }
  } else {
    r.wallBumpTicks = 0;
  }
}

/** Can the robot actually shoot this thing, or is there a wall in the way?
 *  Bolts collide with walls, so firing without this just feeds the wall. */
function canShoot(state: SimState, target: Vec): boolean {
  return !losBlocked(state.solid, state.robot.pos, target);
}

/** `face` false = fire without turning the body — snap-shots taken on the move,
 *  which is what makes the robot look like it can walk and fight at once. */
function fireBolt(state: SimState, aim: Vec, face = true): void {
  const r = state.robot;
  if (face) r.facing = Math.atan2(aim.y, aim.x);
  state.projectiles.push({
    id: `bolt_${state.nextId++}`,
    kind: 'bolt',
    pos: { x: r.pos.x + aim.x * 10, y: r.pos.y + aim.y * 10 },
    vel: { x: aim.x * BOLT_SPEED, y: aim.y * BOLT_SPEED },
  });
  emit(state, 'shot_fired');
  r.shootCd = shootCdMax(r);
}

/**
 * Which gun is actually in the robot's hands this tick.
 *
 * `standing.weapon` is a WISH, not a fact: the launcher does not exist until
 * the floor-6 crate installs it, and rocketBlockedReason owns every reason the
 * wish cannot be granted. Both of the ones that can happen fall back to bolts
 * SILENTLY and on purpose:
 *
 *  - 'no_rockets' — the player said "use the rockets" before finding any. A
 *    robot that answered that by standing there empty-handed would be the same
 *    broken control loop as one that acknowledges "keep back" and never moves.
 *  - 'too_close' — the SCARED / last-two-hp self-preservation guard. It is the
 *    character being consistent, not a refusal worth narrating.
 *
 * 'carrying' is deliberately not special-cased here. Every one of the four fire
 * paths already blocks on full hands, three of them with an order_blocked the
 * player can act on, so answering it a second time from inside the gun would
 * only produce a duplicate.
 */
function rocketsAllowed(state: SimState): boolean {
  return state.robot.standing.weapon === 'rocket' && rocketBlockedReason(state) === null;
}

/** Is EITHER gun off cooldown? The two keep separate clocks by design
 *  (ROCKET_CD is ~3.75× the bolt's) and the robot carries both once the crate
 *  is open, so "may I shoot" is true whenever either one is up. */
function weaponReady(state: SimState): boolean {
  const r = state.robot;
  return r.shootCd === 0 || (rocketsAllowed(state) && r.rocketCd === 0);
}

/** Fire whatever is in hand. THE single fire point for every path that has
 *  decided to shoot — the `shoot` order, the `attack` order, RAGE's engage, and
 *  passive return fire — because "use the rockets" being true on three of them
 *  and false on the fourth is exactly the kind of half-obeyed order this whole
 *  pass exists to stamp out. */
function fireWeapon(state: SimState, aim: Vec, face = true): void {
  const r = state.robot;
  // BOTH guns, not one or the other. The launcher is a second barrel bolted on
  // by the crate, not a mode switch: a reward that takes your old gun away is a
  // reward that made you weaker between rockets, and a 90-tick weapon standing
  // in for a 24-tick one leaves the robot silent for two thirds of a fight.
  // Separate clocks, so they simply overlap when both happen to be up.
  // Both cooldowns are read BEFORE either shot: fireBolt stamps shootCd on the
  // way out, so asking afterwards answers about the shot just taken.
  const bolt = r.shootCd === 0;
  const rocket = rocketsAllowed(state) && r.rocketCd === 0;
  if (bolt) fireBolt(state, aim, face);
  // The bolt aims true and the rocket scatters, so when both go on one tick the
  // BOLT owns the body facing — otherwise the robot visibly points at wherever
  // the rocket wandered off to instead of at what it is shooting.
  if (rocket) fireRocket(state, aim, face && !bolt);
}

/** Tier-0 auto-aim: nearest live hostile within a 30° cone of facing AND in
 *  clear line of fire, else null (the caller then shoots straight ahead). */
function coneTarget(state: SimState): Vec | null {
  const r = state.robot;
  const fx = Math.cos(r.facing);
  const fy = Math.sin(r.facing);
  let best: Vec | null = null;
  let bestD = SHOOT_RANGE;
  for (const e of state.entities) {
    if (!isLiveHostile(e)) continue;
    const d = dist(r.pos, e.pos);
    if (d > bestD || d < 1) continue;
    const to = norm({ x: e.pos.x - r.pos.x, y: e.pos.y - r.pos.y });
    if (to.x * fx + to.y * fy < SHOOT_CONE_COS) continue;
    if (!canShoot(state, e.pos)) continue;
    bestD = d;
    best = to;
  }
  return best;
}

/** Cover must hold across the whole HIDE_ARRIVE landing slop, not just at the
 *  exact center — a ray that merely grazes a wall corner is not hiding. */
function coverBlocked(solid: boolean[][], c: Vec, hostile: Vec): boolean {
  return (
    losBlocked(solid, c, hostile) &&
    losBlocked(solid, { x: c.x - HIDE_ARRIVE, y: c.y }, hostile) &&
    losBlocked(solid, { x: c.x + HIDE_ARRIVE, y: c.y }, hostile) &&
    losBlocked(solid, { x: c.x, y: c.y - HIDE_ARRIVE }, hostile) &&
    losBlocked(solid, { x: c.x, y: c.y + HIDE_ARRIVE }, hostile)
  );
}

/** Cover must break LOS to every one of the top threats, not just to the worst.
 *  Hiding from the boss behind a pillar its two escorts can see around is not
 *  hiding, it is choosing which thing shoots you. */
function coverHolds(state: SimState, c: Vec, threats: readonly Threat[], k: number): boolean {
  for (let i = 0; i < k; i++) {
    if (!coverBlocked(state.solid, c, threats[i].e.pos)) return false;
  }
  return true;
}

/** Is this point inside a live telegraphed blast zone? Free on floors 1–5,
 *  where state.mortars is always empty. */
function inBlastZone(state: SimState, c: Vec): boolean {
  for (const m of state.mortars) {
    if (dist(c, m.target) <= m.radius) return true;
  }
  return false;
}

/** Any live hostile closer than `d` to this point — the pre-prune, and no
 *  raycasts involved. Dormant machines are scenery and do not count. */
function crowded(state: SimState, c: Vec, d: number): boolean {
  for (const e of state.entities) {
    if (!isLiveHostile(e)) continue;
    if (dist(c, e.pos) < d) return true;
  }
  return false;
}

/**
 * BRAIN hide: pick a cover point. Candidates are walkable tile centers within
 * HIDE_SEARCH_RADIUS (tile non-solid ⇒ r=7 circle fits: 7 < TILE/2). With live
 * threats: nearest candidate that breaks LOS to all of the top few; if none
 * does, the candidate deepest out of the threat field — the robot BELIEVES it
 * is hidden. Nothing in sight: nearest candidate hugging a wall (a nook).
 * Fixed y→x scan order + strict comparisons keep the pick deterministic, and
 * there is no rng anywhere in here.
 *
 * COST, which is the reason this is shaped the way it is. The old version cast
 * the full 5-ray coverBlocked at every one of ~110 candidates against a single
 * hostile. Multiplying that by N enemies is 5k+ raycasts inside one tick. So:
 *
 *   1. only the top COVER_TOP_K threats are hidden from;
 *   2. a cheap pre-prune runs BEFORE any ray — reject anything within
 *      COVER_MIN_HOSTILE_DIST of a live hostile, or inside a blast zone. That
 *      is the "do not hide INTO three others" rule, and because it shrinks the
 *      candidate set it more than pays for itself;
 *   3. phase 1 casts ONE centre ray per survivor per threat; phase 2 spends the
 *      expensive 5-ray confirm on only the COVER_CONFIRM nearest survivors.
 *
 * Net result is fewer rays than the single-enemy version it replaces.
 */
function findCover(state: SimState, threats: readonly Threat[]): Vec {
  const r = state.robot;
  const k = Math.min(COVER_TOP_K, threats.length);
  const minTx = Math.max(0, Math.floor((r.pos.x - HIDE_SEARCH_RADIUS) / TILE));
  const maxTx = Math.min(TILES_X - 1, Math.floor((r.pos.x + HIDE_SEARCH_RADIUS) / TILE));
  const minTy = Math.max(0, Math.floor((r.pos.y - HIDE_SEARCH_RADIUS) / TILE));
  const maxTy = Math.min(TILES_Y - 1, Math.floor((r.pos.y + HIDE_SEARCH_RADIUS) / TILE));

  let best: Vec | null = null; // no threats: nearest nook
  let bestD = Infinity;
  let far: Vec | null = null; // fallback: deepest out of the threat field
  let farScore = -1;
  const shortlist: Array<{ c: Vec; d: number }> = [];

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (isSolidTile(state.solid, tx, ty)) continue;
      const c: Vec = { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
      const dRobot = dist(r.pos, c);
      if (dRobot > HIDE_SEARCH_RADIUS) continue;
      if (k === 0) {
        const nook =
          isSolidTile(state.solid, tx - 1, ty) ||
          isSolidTile(state.solid, tx + 1, ty) ||
          isSolidTile(state.solid, tx, ty - 1) ||
          isSolidTile(state.solid, tx, ty + 1);
        if (nook && dRobot < bestD) {
          bestD = dRobot;
          best = c;
        }
        continue;
      }
      if (crowded(state, c, COVER_MIN_HOSTILE_DIST)) continue;
      if (inBlastZone(state, c)) continue;
      // The fallback score is pure distance and costs no rays, so it is
      // computed first and separately — otherwise the early-out below would
      // have to choose between being cheap and leaving `far` half-summed.
      // Weighted so "away" means away from the BOSS, not away from the average
      // of the boss and the two printers standing behind it.
      let fieldScore = 0;
      for (let i = 0; i < k; i++) fieldScore += dist(c, threats[i].e.pos) * (threats[i].score + 0.05);
      if (fieldScore > farScore) {
        farScore = fieldScore;
        far = c;
      }
      // Cover has to break LOS to ALL of the top k, so the first threat that
      // can still see this candidate settles it — every further ray for this
      // candidate is a question whose answer cannot change the outcome. Most
      // candidates fail on the worst threat, which is why this is most of the
      // saving at three hostiles rather than a rounding error.
      let blocked = true;
      for (let i = 0; i < k; i++) {
        if (!losBlocked(state.solid, c, threats[i].e.pos)) {
          blocked = false;
          break;
        }
      }
      if (blocked) shortlist.push({ c, d: dRobot });
    }
  }

  if (k === 0) return best ?? { x: r.pos.x, y: r.pos.y };
  // Stable sort over a fixed scan order: equal distances keep y→x order.
  shortlist.sort((a, b) => a.d - b.d);
  const confirm = Math.min(COVER_CONFIRM, shortlist.length);
  for (let i = 0; i < confirm; i++) {
    if (coverHolds(state, shortlist[i].c, threats, k)) return shortlist[i].c;
  }
  return far ?? { x: r.pos.x, y: r.pos.y };
}

/**
 * Is the cover point the robot is already walking to (or sitting on) still
 * cover? One centre ray per top threat — cheap enough to run every
 * COVER_RECHECK_TICKS, which it has to be: a boss walks around your pillar, and
 * a hide order that committed to a point ten seconds ago is a robot standing in
 * the open believing otherwise.
 */
function coverStillHolds(state: SimState, c: Vec, threats: readonly Threat[]): boolean {
  const k = Math.min(COVER_TOP_K, threats.length);
  for (let i = 0; i < k; i++) {
    if (!losBlocked(state.solid, c, threats[i].e.pos)) return false;
  }
  return true;
}

/** Cover held by the current hide/retreat order, re-verified on a slow clock.
 *  Returns the point to walk to, picking a fresh one when the old one lapsed. */
function heldCover(state: SimState, scratch: RobotScratch, threats: readonly Threat[]): Vec {
  const held = scratch.hideTarget;
  if (held !== null && state.tick - scratch.hideCheckTick >= COVER_RECHECK_TICKS) {
    scratch.hideCheckTick = state.tick;
    if (!coverStillHolds(state, held, threats)) {
      scratch.hideTarget = null; // it moved; find somewhere that is still a wall
      clearNav(scratch);
    }
  }
  if (scratch.hideTarget === null) {
    scratch.hideTarget = findCover(state, threats);
    scratch.hideCheckTick = state.tick;
  }
  return scratch.hideTarget;
}

/**
 * Would executing this order move the robot away from the THREAT FIELD?
 * (the RAGE check)
 *
 * Field-aware rather than one-enemy: backing out of a room with three machines
 * in it is disengaging even when it happens to walk you nearer the one printer
 * off to the side. threatPull is deliberately un-normalised, because only the
 * SIGN of this dot product is ever used and scaling by positive weights cannot
 * change a sign — which is what keeps the single-hostile case bit-identical to
 * the arithmetic this replaced.
 */
function movesAway(state: SimState, order: Order, threats: readonly Threat[]): boolean {
  const r = state.robot;
  let intent: Vec | null = null;
  if (order.kind === 'move') intent = dirToVec(order.dir);
  else if (order.kind === 'attack') {
    // Attacking any live hostile IS engaging; wasting shots on a decoy is not.
    // NOTE the shape: this is a NEGATED test, and `!isLiveHostile(t)` is not a
    // drop-in for it. A DEAD target must answer "no, that isn't disengaging"
    // (the order is over anyway) — isLiveHostile says false for a corpse, which
    // would flip it to "yes, disengaging" and hand RAGE a fight it already won.
    const t = entityById(state, order.targetId);
    return t !== null && !t.dead && !HOSTILE_KINDS.has(t.kind);
  } else if (order.kind === 'goto' || order.kind === 'enter' || order.kind === 'pickup') {
    const t = entityById(state, order.targetId);
    if (t) intent = norm({ x: t.pos.x - r.pos.x, y: t.pos.y - r.pos.y });
  }
  if (!intent) return false;
  const to = threatPull(threats, r.pos, COVER_TOP_K);
  return intent.x * to.x + intent.y * to.y < 0;
}

/** Where the doctrine wants the robot standing relative to what it is fighting.
 *  'auto' is exactly what the robot did before any of this existed. */
type Stance = 'advance' | 'hold' | 'back';

function stanceFor(state: SimState, scratch: RobotScratch, d: number, clear: boolean): Stance {
  // No shot means no argument about range: get where the shot exists. Bolts
  // stop at walls, so standing in the band emptying the magazine into masonry
  // is the stall this used to be.
  if (!clear) return 'advance';
  const sp = state.robot.standing.spacing;
  if (sp === 'close') return d > CLOSE_RANGE ? 'advance' : 'hold';
  if (sp === 'far') {
    if (scratch.standoffStuck >= STANDOFF_STUCK_TICKS) {
      // SUSPENDED, NOT SURRENDERED — and the difference was a live bug.
      //
      // This used to be `&& standoffStuck < STANDOFF_STUCK_TICKS` on the branch
      // above, i.e. a latch. backOff zeroes the counter on any tick that
      // actually moved, so the latch looked self-clearing — but the moment it
      // trips, stanceFor stops returning 'back', backOff is never called again,
      // and there is no other writer. The only reset left is stepRobot's
      // "nothing in sight", which on floors 1-5 hides it (the machine wanders
      // off) and in the boss arena never happens at all: something is visible
      // from the doors to the credits. So a third of a second of scraping a
      // wall retired "keep back" for the whole fight, silently, with the OSD
      // chip still lit. Measured before this line existed: 23 of the last 600
      // ticks of a boss fight anywhere in the band.
      //
      // Bleeding it down instead makes it a cooldown. The robot fights at the
      // default range while it is pinned and keeps testing the band, so the
      // rule comes back the instant whatever was behind it moves.
      scratch.standoffStuck--;
    } else {
      // A BAND, not a line — see STANDOFF_MIN/MAX.
      if (d > STANDOFF_MAX) return 'advance';
      if (d < STANDOFF_MIN) return 'back';
      return 'hold';
    }
  }
  return d > ATTACK_RANGE ? 'advance' : 'hold';
}

/** Give ground while keeping the gun on the target. Tracks how well that is
 *  going: a robot obeying "keep back" with a wall behind it just vibrates
 *  against the masonry while being eaten, so the failure has to be counted. */
function backOff(state: SimState, scratch: RobotScratch, target: Vec): void {
  const r = state.robot;
  const away = norm({ x: r.pos.x - target.x, y: r.pos.y - target.y });
  // Round the retreat off the masonry first. Straight back is only the right
  // way out in open ground; with a wall behind, pressing into it is how "keep
  // back" spent its whole stuck budget in a third of a second without ever
  // trying the two directions that were free. Sliding along the wall AWAY from
  // the machine is what a person would do, and it keeps the gun on it either
  // way — the give-up below is then reserved for a genuine dead end.
  const moved = moveAndFace(state, steer(state, unstick(state, away) ?? away, false));
  r.facing = Math.atan2(target.y - r.pos.y, target.x - r.pos.x);
  if (moved < r.speed * DT * 0.25) scratch.standoffStuck++;
  else scratch.standoffStuck = 0;
}

/** `keepMoving`: circle the target instead of planting. The body keeps facing
 *  the target — the gun is on it the whole time, which is the entire look.
 *  The side comes off a scratch clock, NEVER off roll(state): a per-tick
 *  behaviour that consumed the seeded rng would make every other random draw in
 *  the sim depend on how long the player let a fight run. */
function strafe(state: SimState, scratch: RobotScratch, target: Vec): void {
  const r = state.robot;
  scratch.strafeTicks++;
  const side = Math.floor(scratch.strafeTicks / STRAFE_FLIP_TICKS) % 2 === 0 ? 1 : -1;
  const to = norm({ x: target.x - r.pos.x, y: target.y - r.pos.y });
  const dir = steer(state, { x: -to.y * side, y: to.x * side }, false);
  r.vel.x = dir.x * r.speed;
  r.vel.y = dir.y * r.speed;
  moveCircle(state.solid, r.pos, r.vel.x * DT, r.vel.y * DT, ROBOT_R);
  r.facing = Math.atan2(to.y, to.x);
}

/** Hold position on target under the current doctrine: plant, strafe, or give
 *  ground. Everything that has decided to shoot something routes through here,
 *  so "keep back" and "never stop moving" apply to ordered attacks and to the
 *  robot's own rage identically. */
function holdOn(state: SimState, scratch: RobotScratch, target: Vec, stance: Stance): void {
  const r = state.robot;
  if (stance === 'back') backOff(state, scratch, target);
  else if (r.standing.keepMoving) strafe(state, scratch, target);
  else halt(r);
}

/**
 * Keep the doctrine's fighting distance while the robot is not going anywhere
 * else. THE fix for "keep your distance" being a chip on the OSD and nothing
 * else in the world.
 *
 * stanceFor used to be reachable from exactly two places: the `attack` order
 * and RAGE's engage(). Every OTHER way of being in a fight ends in halt() —
 * `shoot` plants, and a null order plants — and those are the states the boss
 * fight is actually made of. The robot calls out the shredder, holds for
 * instructions, and returns fire from wherever it happened to be standing. So
 * the player said "keep back", the parser set spacing, the robot said "ROBOT
 * STAYS BACK. SHOOTS FROM FAR", and there was no code path anywhere that could
 * have moved it one pixel. An order acknowledged and then ignored is worse than
 * one refused: it is the control loop lying.
 *
 * Every threat in the list is LOS-clear by construction (refreshThreats casts
 * the ray before it admits one), so `clear` is never in question here — only
 * the range is. That is also why the advance leg is a straight seek rather than
 * navSeek: the robot can SEE the place it is walking to, the leg is a few tens
 * of px, and borrowing the nav scratch would strand whatever order is parked.
 *
 * Returns true when it took the tick, so the caller does not also halt.
 */
function holdSpacing(state: SimState, scratch: RobotScratch): boolean {
  const r = state.robot;
  if (r.standing.spacing === 'auto') return false;
  const pick = pickTarget(threatsOf(scratch), r.standing.focus);
  if (pick === null) return false;
  const p = pick.e.pos;
  const stance = stanceFor(state, scratch, dist(r.pos, p), true);
  if (stance === 'advance') {
    moveAndFace(state, steer(state, norm({ x: p.x - r.pos.x, y: p.y - r.pos.y }), false));
  } else {
    holdOn(state, scratch, p, stance);
  }
  // Face what it is holding a range on, whichever leg ran. Standing off from a
  // machine while looking the other way is not a standoff, it is a blind spot.
  r.facing = Math.atan2(p.y - r.pos.y, p.x - r.pos.x);
  return true;
}

/**
 * RAGE override: close to attack range and keep shooting — but only at things
 * it can actually hit. With a wall between them it advances instead of standing
 * still emptying its magazine into masonry (which looked, correctly, like a
 * frozen game). Time-boxed by the caller's RAGE budget.
 *
 * Picks its own target from the field under the player's focus doctrine,
 * preferring something it has a shot at; with nothing shootable it advances on
 * the worst one, which is how it gets a shot.
 */
function engage(state: SimState, scratch: RobotScratch, threats: readonly Threat[]): void {
  const r = state.robot;
  const pick =
    pickTarget(threats, r.standing.focus, (t) => canShoot(state, t.e.pos)) ??
    pickTarget(threats, r.standing.focus);
  if (pick === null) return;
  const hostile = pick.e;
  const d = dist(r.pos, hostile.pos);
  const clear = canShoot(state, hostile.pos);
  const stance = stanceFor(state, scratch, d, clear);
  if (stance === 'advance') {
    // No bumpCheck here on purpose: the give-up timer belongs to the player's
    // order, and rage must not spend it. The RAGE budget bounds this instead.
    navSeek(state, scratch, hostile.pos, false);
    return;
  }
  holdOn(state, scratch, hostile.pos, stance);
  if (r.carrying !== null) return; // rage with full hands: just looms
  if (weaponReady(state)) fireWeapon(state, norm({ x: hostile.pos.x - r.pos.x, y: hostile.pos.y - r.pos.y }));
}

function collectScrap(state: SimState, e: Entity): void {
  e.dead = true;
  state.robot.scrap++;
  emit(state, 'scrap_pickup', e.id);
}

/** Loose floor chip collected. The director owns installing it (applyChip) —
 *  sim only reports that the thing was picked up. */
function collectChip(state: SimState, e: Entity): void {
  e.dead = true;
  emit(state, 'chip_pickup', e.id, e.option ? { chip: e.option } : undefined);
}

/**
 * explore: choose the next leg. Nearest unvisited point of interest, else a
 * random far walkable tile (the robot "looks around"). Deterministic — the
 * scan order is fixed and the wander roll goes through the seeded sim rng.
 */
function pickExploreLeg(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of state.entities) {
    if (e.dead || !EXPLORE_KINDS.has(e.kind)) continue;
    if (scratch.exploreSeen.includes(e.id)) continue;
    const d = dist(r.pos, e.pos);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (best) {
    scratch.exploreTargetId = best.id;
    scratch.explorePoint = { x: best.pos.x, y: best.pos.y };
    return;
  }
  // Nothing new to look at: wander. Rejection-sample a far walkable tile that
  // isn't loitering by the exit (a wander leg must not end the floor).
  scratch.exploreTargetId = null;
  const exit = state.entities.find((e) => e.kind === 'elevatorB' && !e.dead);
  for (let i = 0; i < 24; i++) {
    const tx = Math.floor(roll(state) * TILES_X);
    const ty = Math.floor(roll(state) * TILES_Y);
    if (isSolidTile(state.solid, tx, ty)) continue;
    const c: Vec = { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
    if (dist(r.pos, c) < EXPLORE_WANDER_MIN) continue;
    if (exit && dist(c, exit.pos) < ELEVATOR_KEEPOUT) continue;
    scratch.explorePoint = c;
    return;
  }
  scratch.explorePoint = null; // boxed in — the order idles rather than jitters
}

/**
 * `evade`: pick the next patch of open ground to be standing on.
 *
 * Scores every walkable tile centre in EVADE_RADIUS by how deep out of the
 * threat field it is, minus a flat penalty for sitting in a live blast zone,
 * minus a penalty for being where the robot just was. Without that last term
 * the top two candidates trade places forever and "keep moving" becomes a robot
 * twitching between two tiles.
 *
 * NO findPath. This runs on a 30-tick clock inside stepRobot, and findPath keeps
 * module-global scratch arrays — it is not reentrant, and only navSeek is
 * allowed to call it. Distance is uncapped nowhere either: EVADE_FAR_CAP stops
 * the far corner of the map winning every time, which is the difference between
 * evading and fleeing.
 *
 * Rays are spent on the SHORTLIST only, the same two-phase shape findCover uses.
 * The scan itself casts none — that would be ~200 raycasts twice a second — but
 * the winner does get one, because the leg is walked in a straight line and a
 * point on the far side of a stanchion is a leg the robot shoves at for its
 * whole 30-tick lease. Three rays per re-pick, twice a second, is nothing; a
 * robot grinding its face on a pillar while "dodging" is everything.
 */
const EVADE_CONFIRM = 3;

function pickEvadePoint(state: SimState, scratch: RobotScratch, threats: readonly Threat[]): void {
  const r = state.robot;
  const minTx = Math.max(0, Math.floor((r.pos.x - EVADE_RADIUS) / TILE));
  const maxTx = Math.min(TILES_X - 1, Math.floor((r.pos.x + EVADE_RADIUS) / TILE));
  const minTy = Math.max(0, Math.floor((r.pos.y - EVADE_RADIUS) / TILE));
  const maxTy = Math.min(TILES_Y - 1, Math.floor((r.pos.y + EVADE_RADIUS) / TILE));
  const k = Math.min(COVER_TOP_K, threats.length);
  // Top few by score, best first. Insertion with a strict > keeps the fixed
  // y→x scan order on ties, so the shortlist is as deterministic as the single
  // `best` it replaces — and identical to it whenever the winner has LOS.
  const top: Array<{ c: Vec; score: number }> = [];
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (isSolidTile(state.solid, tx, ty)) continue;
      const c: Vec = { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
      const dRobot = dist(r.pos, c);
      if (dRobot > EVADE_RADIUS || dRobot < EVADE_MIN_LEG) continue;
      let score = 0;
      for (let i = 0; i < k; i++) {
        const t = threats[i];
        score += Math.min(dist(c, t.e.pos), EVADE_FAR_CAP) * (t.score + 0.05);
      }
      if (inBlastZone(state, c)) score -= EVADE_ZONE_PENALTY;
      if (scratch.evadePrev !== null && dist(c, scratch.evadePrev) < EVADE_REVISIT_RADIUS) {
        score -= EVADE_REVISIT_PENALTY;
      }
      if (top.length === EVADE_CONFIRM && score <= top[EVADE_CONFIRM - 1].score) continue;
      let i = top.length;
      while (i > 0 && score > top[i - 1].score) i--;
      top.splice(i, 0, { c, score });
      if (top.length > EVADE_CONFIRM) top.pop();
    }
  }
  scratch.evadePrev = { x: r.pos.x, y: r.pos.y };
  scratch.evadeTick = state.tick;
  for (const t of top) {
    if (!losBlocked(state.solid, r.pos, t.c)) {
      scratch.evadePoint = t.c;
      return;
    }
  }
  // Everything worth going to is behind masonry: take the best anyway and let
  // the wall slide do what it can. A leg that then genuinely goes nowhere is
  // dropped on the spot by the caller rather than shoved at for a full lease.
  scratch.evadePoint = top.length > 0 ? top[0].c : null;
}

function executeOrder(state: SimState, order: Order | null, scratch: RobotScratch): void {
  const r = state.robot;
  if (order === null) {
    // Nothing to do is still a place to stand. This is the single most common
    // state of the boss fight — threat called out, operator thinking — and it
    // is where "keep back" has to bite or it does not exist.
    if (!holdSpacing(state, scratch)) halt(r);
    return;
  }
  switch (order.kind) {
    case 'move': {
      const moved = moveAndFace(state, steer(state, dirToVec(order.dir), false));
      bumpCheck(state, moved, r.speed * DT);
      // Nudge ("a bit" / "one step"): stop after distancePx of ACTUAL travel.
      // Wall bumps still interrupt via bumpCheck above (order may be cleared).
      if (order.distancePx !== undefined && r.order === order) {
        scratch.moveTraveledPx += moved;
        if (scratch.moveTraveledPx >= order.distancePx) {
          halt(r);
          r.order = null;
          emit(state, 'order_done');
        }
      }
      return;
    }
    case 'stop': {
      halt(r);
      r.order = null;
      return;
    }
    case 'shoot': {
      // `shoot` is an order about the GUN, not about the feet, so the doctrine
      // still owns where the feet are. Planting is only the right answer when
      // nobody said otherwise; holdSpacing sets facing to whatever it is holding
      // a range on, which is what coneTarget below then finds.
      if (!holdSpacing(state, scratch)) halt(r);
      if (r.carrying !== null) {
        emit(state, 'order_blocked', r.carrying, { reason: 'carrying' });
        r.order = null;
        return;
      }
      if (weaponReady(state)) {
        const aim = coneTarget(state) ?? { x: Math.cos(r.facing), y: Math.sin(r.facing) };
        fireWeapon(state, aim);
      }
      return;
    }
    case 'goto': {
      const t = entityById(state, order.targetId);
      if (!t) {
        emit(state, 'order_blocked', order.targetId, { reason: 'gone' });
        r.order = null;
        halt(r);
        return;
      }
      const d = dist(r.pos, t.pos);
      if (t.dead || d <= ARRIVE_RADIUS) {
        emit(state, 'order_done', t.id);
        r.order = null;
        halt(r);
        return;
      }
      const careful = isCareful(state, order.careful);
      const moved = navSeek(state, scratch, t.pos, careful);
      if (unreachable(state, scratch, t.id)) return;
      bumpCheck(state, moved, Math.min(r.speed * (careful ? CAREFUL_SPEED : 1) * DT, d));
      return;
    }
    case 'attack': {
      const t = entityById(state, order.targetId);
      if (!t || t.dead) {
        // target already down = job done, as far as robot is concerned
        emit(state, 'order_done', order.targetId);
        r.order = null;
        halt(r);
        return;
      }
      if (t.hp === undefined) {
        // no hp = nothing to shoot at (crate, elevator, socket…)
        emit(state, 'order_blocked', t.id, { reason: 'cant_hurt' });
        r.order = null;
        halt(r);
        return;
      }
      if (r.carrying !== null) {
        emit(state, 'order_blocked', t.id, { reason: 'carrying' });
        r.order = null;
        return;
      }
      const d = dist(r.pos, t.pos);
      // Where to stand is the DOCTRINE's call ("keep back", "get in its face",
      // "never stop moving"), and it is a mid-fight readjustment: it changes
      // how this order runs without cancelling it. Default 'auto' is the
      // original rule — in range with a clear shot, plant and fire.
      // In range but behind a wall: close the distance instead of shooting the
      // wall. Bolts stop at walls, so the old behaviour was an infinite stall.
      const stance = stanceFor(state, scratch, d, canShoot(state, t.pos));
      if (stance !== 'advance') {
        holdOn(state, scratch, t.pos, stance);
        const aim = norm({ x: t.pos.x - r.pos.x, y: t.pos.y - r.pos.y });
        r.facing = Math.atan2(aim.y, aim.x);
        if (weaponReady(state)) fireWeapon(state, aim);
      } else {
        const moved = navSeek(state, scratch, t.pos, false);
        bumpCheck(state, moved, Math.min(r.speed * DT, d));
      }
      return;
    }
    case 'pickup': {
      const t = entityById(state, order.targetId);
      if (!t) {
        emit(state, 'order_blocked', order.targetId, { reason: 'gone' });
        r.order = null;
        halt(r);
        return;
      }
      if (t.dead) {
        // collected en route (proximity/magnet) — that still counts
        emit(state, 'order_done', t.id);
        r.order = null;
        halt(r);
        return;
      }
      const d = dist(r.pos, t.pos);
      if (d <= (t.kind === 'scrap' || t.kind === 'chip' ? PICKUP_RADIUS : ARRIVE_RADIUS)) {
        halt(r);
        r.order = null;
        if (t.kind === 'fuse') {
          t.dead = true;
          t.state = 'carried';
          r.carrying = t.id;
          emit(state, 'fuse_pickup', t.id);
          emit(state, 'order_done', t.id);
        } else if (t.kind === 'scrap') {
          collectScrap(state, t);
          emit(state, 'order_done', t.id);
        } else if (t.kind === 'chip') {
          collectChip(state, t);
          emit(state, 'order_done', t.id);
        } else if (t.kind === 'fuseSocket' && (r.carrying !== null || t.state === 'filled')) {
          // "pick up the socket" with fuse in hand = deliver; the proximity
          // pass does the insertion (SOCKET_REACH > ARRIVE_RADIUS) — success.
          emit(state, 'order_done', t.id);
        } else {
          // Not carryable — but the robot DID what was asked as far as the
          // player is concerned: it went to the thing. "Pick up the crate" is
          // the most natural way to say "open the crate", and answering the
          // single most important object on the floor with a flat refusal is
          // how the game earned "he does not pick things up". Arriving is the
          // interaction: the proximity pass fires crate_reached from here.
          emit(state, 'order_done', t.id, { carried: 0 });
        }
        return;
      }
      const careful = isCareful(state, order.careful);
      const moved = navSeek(state, scratch, t.pos, careful);
      if (unreachable(state, scratch, t.id)) return;
      bumpCheck(state, moved, r.speed * (careful ? CAREFUL_SPEED : 1) * DT);
      return;
    }
    case 'enter': {
      const t = entityById(state, order.targetId);
      if (!t || (t.kind !== 'elevatorA' && t.kind !== 'elevatorB')) {
        emit(state, 'order_blocked', order.targetId, { reason: 'gone' });
        r.order = null;
        halt(r);
        return;
      }
      const d = dist(r.pos, t.pos);
      // Stop INSIDE the entry radius (proximity pass fires at ELEV_REACH) —
      // stopping outside it would strand the robot at the door forever.
      if (d <= ELEV_REACH - 6) {
        halt(r);
        r.order = null;
        if (t.kind === 'elevatorA') emit(state, 'order_blocked', t.id, { reason: 'tired' });
        else if (!isElevatorPowered(t)) emit(state, 'order_blocked', t.id, { reason: 'no_power' });
        // powered elevB: the proximity pass emits elevator_entered
        return;
      }
      const moved = navSeek(state, scratch, t.pos, isCareful(state));
      if (unreachable(state, scratch, t.id)) return;
      bumpCheck(state, moved, r.speed * DT);
      return;
    }
    case 'explore': {
      // Standing tour: walk to the next interesting thing, announce it, repeat.
      // Never self-terminates — only a new order or 'stop' ends it.
      if (scratch.explorePoint === null) pickExploreLeg(state, scratch);
      const point = scratch.explorePoint;
      if (point === null) {
        halt(r);
        return;
      }
      const d = dist(r.pos, point);
      if (d <= EXPLORE_ARRIVE) {
        const id = scratch.exploreTargetId;
        if (id !== null && !scratch.exploreSeen.includes(id)) scratch.exploreSeen.push(id);
        emit(state, 'explore_found', id ?? undefined);
        scratch.explorePoint = null;
        scratch.exploreTargetId = null;
        halt(r);
        return;
      }
      const moved = navSeek(state, scratch, point, isCareful(state));
      bumpCheck(state, moved, Math.min(r.speed * DT, d));
      // A leg with no route (or one the body can't shove through) is dropped
      // for another rather than ending the tour — a stuck leg must never be
      // able to strand a standing order.
      if (scratch.navFailed || r.wallBumpTicks >= EXPLORE_GIVEUP_TICKS) {
        const id = scratch.exploreTargetId;
        if (id !== null && !scratch.exploreSeen.includes(id)) scratch.exploreSeen.push(id);
        scratch.explorePoint = null;
        scratch.exploreTargetId = null;
        clearNav(scratch);
        r.wallBumpTicks = 0;
      }
      return;
    }
    case 'hide': {
      // Cover point computed on the order's first tick (applyOrder clears it)
      // and re-verified on a slow clock — the thing it is hiding from moves.
      const t = heldCover(state, scratch, threatsOf(scratch));
      const d = dist(r.pos, t);
      if (d <= HIDE_ARRIVE) {
        halt(r);
        r.order = null;
        emit(state, 'order_done'); // no id — cover is a point, not an entity
        return;
      }
      const moved = navSeek(state, scratch, t, false);
      bumpCheck(state, moved, Math.min(r.speed * DT, d));
      return;
    }
    case 'retreat': {
      // Back away and KEEP backing away while ANYTHING is still looking at
      // us — one hop of cover is a hiding place, a retreat is a decision to
      // leave. Ends when the room is clear or the clock runs out; "clear" is
      // the whole list, so breaking LOS to the boss while two printers still
      // have eyes on is not a retreat that finished.
      const live = threatsOf(scratch);
      if (live.length === 0 || scratch.retreatTicks <= 0) {
        halt(r);
        r.order = null;
        emit(state, 'order_done');
        return;
      }
      scratch.retreatTicks--;
      const t = heldCover(state, scratch, live);
      const d = dist(r.pos, t);
      if (d <= HIDE_ARRIVE) {
        // Arrived, still seen: pick a new spot rather than standing in the open.
        scratch.hideTarget = null;
        clearNav(scratch);
        halt(r);
        return;
      }
      const moved = navSeek(state, scratch, t, false);
      bumpCheck(state, moved, Math.min(r.speed * DT, d));
      return;
    }
    case 'evade': {
      // A standing order like `explore`: it NEVER self-terminates. "Keep moving
      // and don't get hit" is a posture the player leaves running and cancels
      // by saying something else, not an errand that completes.
      if (
        scratch.evadePoint === null ||
        state.tick - scratch.evadeTick >= EVADE_REPICK_TICKS ||
        dist(r.pos, scratch.evadePoint) <= EVADE_MIN_LEG / 2
      ) {
        pickEvadePoint(state, scratch, threatsOf(scratch));
      }
      const point = scratch.evadePoint;
      if (point === null) {
        // Boxed in with nowhere better to be. Standing still is honest; an
        // unhandled case would coast on last tick's velocity and read as a bug.
        halt(r);
        return;
      }
      // Straight-line seek plus steering, deliberately: legs are short, they
      // are re-picked twice a second, and A* is neither reentrant here nor
      // worth the cost for a 120px hop.
      const step = moveAndFace(state, steer(state, norm({ x: point.x - r.pos.x, y: point.y - r.pos.y }), false));
      // A leg going nowhere is abandoned on the tick it fails, not at the end
      // of its lease — half a second of standing still is the one thing `evade`
      // is not allowed to do. `evadePrev` becomes the point that DIDN'T work
      // rather than the spot underfoot, so the re-pick is scored away from it
      // (EVADE_REVISIT_PENALTY) and cannot simply choose it again.
      if (step < r.speed * DT * 0.25) {
        scratch.evadePrev = point;
        scratch.evadePoint = null;
      }
      return;
    }
  }
}

/**
 * The planner found no route at all. Say so and drop the order rather than
 * grinding into masonry for four seconds — "ROBOT CANNOT GET THERE" is an
 * answer; silent shoving is the bug the player reads as a broken robot.
 */
function unreachable(state: SimState, scratch: RobotScratch, targetId: string): boolean {
  if (!scratch.navFailed) return false;
  const r = state.robot;
  halt(r);
  r.order = null;
  clearNav(scratch);
  emit(state, 'path_failed', targetId);
  return true;
}

export function stepRobot(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
  // Asleep in the pile: no orders, no personality, no physics. The only thing
  // that can end this is wakeRobot(), and only the player's voice calls that.
  if (r.dormant) {
    halt(r);
    return;
  }
  if (scratch.iframes > 0) scratch.iframes--;
  if (r.shootCd > 0) r.shootCd--;
  // The launcher's own clock. Nothing decremented this before, so a robot that
  // fired one rocket had rocketCd stuck at 90 for the rest of the run and could
  // never fire a second — the weapon was a single-shot by accident.
  if (r.rocketCd > 0) r.rocketCd--;
  // Quiet posture: refreshed while a careful order runs, lingers ~6s after it
  // completes so arriving somewhere sneakily doesn't instantly blow cover.
  const carefulNow =
    r.order !== null && (r.order.kind === 'goto' || r.order.kind === 'pickup') && r.order.careful === true;
  if (carefulNow) scratch.sneakLingerTicks = 360;
  else if (scratch.sneakLingerTicks > 0) scratch.sneakLingerTicks--;

  if (r.sulkTicks > 0) {
    r.sulkTicks--;
    r.mood = 'sulk';
    halt(r);
    if (r.sulkTicks === 0) r.mood = 'ok';
    easeHead(r);
    return;
  }

  if (scratch.stun > 0) {
    scratch.stun--;
    halt(r);
    easeHead(r);
    return;
  }

  // THE threat list for this tick, built HERE and nowhere else. Everything
  // below — SCARED, RAGE, return fire, cover, initiative — reads this one
  // snapshot, so no two behaviours can disagree about what is in the room, and
  // reordering the branches below cannot change the game. See refreshThreats.
  refreshThreats(state, scratch);
  const threats = threatsOf(scratch);
  const worst = threats.length > 0 ? threats[0] : null;
  const hostileVisible = worst !== null;
  if (!hostileVisible) {
    scratch.rageTicks = RAGE_BUDGET_TICKS; // fresh budget per encounter
    scratch.threatCalledId = null; // next machine gets its own warning
    scratch.standoffStuck = 0; // and an honest try at holding the band
  }

  // GET OUT OF THE CIRCLE. Top-priority reflex, above every order and every
  // chip, and it does NOT consult standing.dodgeZones — that flag gates
  // ROUTING. "The robot stood in the red circle and died" is a bug, not comedy,
  // and it must never be the price of not having guessed a magic phrase.
  //
  // It has to be a hard branch here rather than another term inside steer(),
  // because steer() only exists on paths that MOVE. Every halt() branch below
  // this line — attack-in-range, `shoot`, engage-in-range, hide-arrived,
  // retreat-arrived, and a null order — stands perfectly still, so a robot
  // planted to take a shot would eat the mortar with no steering involved at
  // all. That is the exact case the boss fight is made of.
  const blast = zoneUnderfoot(state, r.pos);
  if (blast !== null) {
    const escape = zoneEscapeDir(state, r.pos);
    if (escape !== null) {
      // Once per circle, not sixty times a second while it runs for its life.
      if (!scratch.dodgedZoneIds.includes(blast.id)) {
        scratch.dodgedZoneIds.push(blast.id);
        emit(state, 'zone_dodge', blast.id, { fuse: blast.fuse });
      }
      // Round the escape heading off the masonry before committing to it. The
      // circle says which way is AWAY; only the grid knows which of those ways
      // is a floor. Cornered with nothing clear at all, take the raw heading —
      // scraping a wall is the honest picture of being cornered, and it is
      // still what steer() would have done.
      moveAndFace(state, steer(state, unstick(state, escape) ?? escape, false));
      easeHead(r);
      return;
    }
  }
  // Ids of circles that have already gone off can never match again, and the
  // list is the only thing here that grows without bound.
  if (state.mortars.length === 0 && scratch.dodgedZoneIds.length > 0) scratch.dodgedZoneIds = [];

  // SCARED: below half hp it flees, orders be damned. Down the gradient of the
  // whole field, not away from one body: fleeing "away from the printer" into
  // the two behind it is how a scared robot used to run itself into a corner.
  // Through steer(), so it cannot reverse into a wall or a second machine.
  if (r.chips.includes('SCARED') && hostileVisible && r.hp < r.maxHp * 0.5) {
    r.mood = 'fleeing';
    if (!scratch.fleeEpisode) {
      scratch.fleeEpisode = true;
      emit(state, 'chip_flee', worst.e.id);
    }
    const pull = threatPull(threats, r.pos, COVER_TOP_K);
    const away = norm({ x: -pull.x, y: -pull.y });
    moveAndFace(state, steer(state, away, false));
    easeHead(r);
    return;
  }
  if (r.mood === 'fleeing') r.mood = 'ok';
  if (!hostileVisible) scratch.fleeEpisode = false;

  // MAGNET: shiny nearby during a move/goto → detour first
  if (scratch.magnetTargetId !== null) {
    const s = entityById(state, scratch.magnetTargetId);
    if (!s || s.dead) scratch.magnetTargetId = null;
  }
  const order = r.order;
  if (
    scratch.magnetTargetId === null &&
    r.chips.includes('MAGNET') &&
    !state.frozen && // no shiny-chasing mid-ceremony
    (order === null || order.kind === 'move' || order.kind === 'goto' || order.kind === 'attack')
  ) {
    let best: Entity | null = null;
    let bestD = MAGNET_RADIUS;
    for (const e of state.entities) {
      if (e.kind !== 'scrap' || e.dead || aiOf(e).detoured) continue;
      const d = dist(r.pos, e.pos);
      if (d <= bestD) {
        bestD = d;
        best = e;
      }
    }
    if (best) {
      aiOf(best).detoured = 1; // once per scrap
      scratch.magnetTargetId = best.id;
      emit(state, 'chip_detour', best.id);
    }
  }
  if (scratch.magnetTargetId !== null) {
    const s = entityById(state, scratch.magnetTargetId);
    if (s) {
      const d = dist(r.pos, s.pos);
      const moved = navSeek(state, scratch, s.pos, false); // the pickup lands via the proximity pass
      bumpCheck(state, moved, Math.min(r.speed * DT, d));
      if (scratch.navFailed || r.wallBumpTicks >= WALL_BUMP_EVERY) {
        // shiny is unreachable — give up (scrap stays detour-blacklisted)
        scratch.magnetTargetId = null;
        clearNav(scratch);
        r.wallBumpTicks = 0;
      }
      easeHead(r);
      return;
    }
  }

  // RAGE: refuses to disengage from a visible hostile — for a few seconds.
  // The budget is the whole point: an unbounded refusal reads as a hung game,
  // a bounded one reads as a robot with a temper that eventually listens.
  if (r.chips.includes('RAGE') && hostileVisible && order !== null && movesAway(state, order, threats)) {
    if (scratch.rageTicks > 0) {
      scratch.rageTicks--;
      if (!scratch.rageNotified) {
        scratch.rageNotified = true;
        emit(state, 'order_blocked', worst.e.id, { reason: 'rage' });
      }
      if (scratch.rageTicks === 0) emit(state, 'order_blocked', worst.e.id, { reason: 'rage_relent' });
      engage(state, scratch, threats);
      easeHead(r);
      return;
    }
    // Budget spent — the order runs, and it stays runnable until the machine
    // leaves sight (which is what refills the budget).
  }

  // Return fire WITHOUT dropping the task, and ONLY at something already
  // coming for us (t.aggro) unless we were told to hunt. A robot escorted to
  // the elevator that plinks at the printer chasing it reads as a competent
  // little soldier; one that opens up on a machine minding its own business
  // across the room is the "guns blazing" problem. The body keeps walking —
  // only the bolt turns.
  //
  // Over the whole list now, under the focus doctrine, but the aggro gate is
  // UNCHANGED and must stay that way: it is what separates self-defence from a
  // rampage, and turning it into "anything hostile within range" would quietly
  // make every escort mission a firefight.
  if (r.standing.fight && !r.standing.avoidEnemies && r.carrying === null && weaponReady(state)) {
    const shootAt = pickTarget(
      threats,
      r.standing.focus,
      (t) => (r.standing.hunt || t.aggro) && t.d <= SHOOT_RANGE && canShoot(state, t.e.pos),
    );
    if (shootAt !== null) {
      const p = shootAt.e.pos;
      fireWeapon(state, norm({ x: p.x - r.pos.x, y: p.y - r.pos.y }), order === null);
    }
  }

  // Nothing to do and allowed to think for itself: pick the next task.
  if (order === null && r.standing.autonomy && !state.frozen) {
    chooseInitiative(state, scratch, threats);
  }

  executeOrder(state, r.order, scratch);
  easeHead(r);
}

// ---------------------------------------------------------------- initiative

/** Install a task the robot chose for itself and announce it. */
function selfOrder(
  state: SimState,
  scratch: RobotScratch,
  order: Order,
  what: string,
  label: string,
): void {
  applyOrder(state, scratch, order, true); // also resets the settle clock
  scratch.idleAskCd = IDLE_ASK_TICKS;
  emit(state, 'self_order', 'targetId' in order ? order.targetId : undefined, { what, label });
}

/** Nearest loot worth a self-directed detour, or null. */
function nearestLoot(state: SimState): Entity | null {
  const r = state.robot;
  let best: Entity | null = null;
  let bestD = GATHER_RADIUS;
  for (const e of state.entities) {
    if (e.dead || (e.kind !== 'scrap' && e.kind !== 'chip')) continue;
    const d = dist(r.pos, e.pos);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/**
 * May the robot call out what it can see?
 *
 * First sighting of an encounter is always free — that call-out IS the hand-off
 * to the operator, and delaying it would be delaying the decision the game is
 * made of. After that it re-arms only when the situation genuinely got worse
 * (a nastier thing became the worst thing, or more of them arrived), and even
 * then not more than once per THREAT_RECALL_TICKS. A robot that re-reads the
 * room every two seconds is a nag; one that reports the boss standing up
 * halfway through a printer fight is a scout.
 */
function shouldCallThreat(
  state: SimState,
  scratch: RobotScratch,
  threats: readonly Threat[],
): boolean {
  if (scratch.threatCalledId === null) return true;
  if (state.tick - scratch.threatCalledTick < THREAT_RECALL_TICKS) return false;
  return threats[0].e.id !== scratch.threatCalledId || threats.length > scratch.threatCalledCount;
}

/** Nearest thing on the floor it hasn't gone and looked at yet, or null. */
function nextSight(state: SimState, scratch: RobotScratch): Entity | null {
  const r = state.robot;
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of state.entities) {
    if (e.dead || !EXPLORE_KINDS.has(e.kind)) continue;
    if (scratch.exploreSeen.includes(e.id)) continue;
    const d = dist(r.pos, e.pos);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/**
 * What the robot does when nobody is telling it anything. Deliberately modest:
 * a companion that reacts, not one that runs the level for you.
 *
 * URGENT — no settle delay, and they run even while it waits to be briefed,
 * because standing politely still while something eats you is not restraint:
 *   1. hands full → finish the delivery
 *   2. a machine in view → back off if told to avoid, charge ONLY if told to
 *      hunt, otherwise CALL IT OUT and hold for instructions
 *
 * UNPROMPTED — suppressed entirely until the floor has been briefed, and then
 * only after INITIATIVE_SETTLE ticks of genuine standing about, so the robot
 * never bolts mid-conversation:
 *   3. loot practically underfoot → take it
 *   4. ONLY under a spoken "do your own thing" (roam): go look at something
 *      on this floor it hasn't seen
 *
 * ASKING is always allowed — it is speech, not action:
 *   5. nothing it may do unasked → ask the operator, with a proposal attached
 *
 * The elevator is never on this list: ending the floor is the player's call.
 */
function chooseInitiative(state: SimState, scratch: RobotScratch, threats: readonly Threat[]): void {
  const r = state.robot;
  const st = r.standing;

  if (r.carrying !== null) {
    const socket = state.entities.find(
      (e) => e.kind === 'fuseSocket' && e.state !== 'filled' && !e.dead,
    );
    if (socket) {
      selfOrder(state, scratch, { kind: 'goto', targetId: socket.id }, 'deliver', socket.label);
      return;
    }
  }

  if (threats.length > 0) {
    const worst = threats[0];
    // "Something is about to touch me" is a question about the NEAREST body,
    // which is not the same question as "what is the worst thing in the room".
    const closing = nearestThreatDist(threats) <= RETREAT_TRIGGER;
    if (st.avoidEnemies || !st.fight) {
      if (closing) {
        selfOrder(state, scratch, { kind: 'retreat' }, 'retreat', worst.e.label);
        return;
      }
    } else if (st.hunt) {
      // Only under an explicit "fight everything" does it go and start one —
      // and which one is the player's doctrine, not the robot's guess.
      const pick = pickTarget(threats, st.focus) ?? worst;
      selfOrder(state, scratch, { kind: 'attack', targetId: pick.e.id }, 'fight', pick.e.label);
      return;
    } else if (shouldCallThreat(state, scratch, threats)) {
      // Default posture: it has seen something and it does NOT charge. It says
      // so and holds, because deciding whether this is a fight is the
      // operator's job — that decision IS the game.
      scratch.threatCalledId = worst.e.id;
      scratch.threatCalledCount = threats.length;
      scratch.threatCalledTick = state.tick;
      emit(state, 'threat_seen', worst.e.id, {
        dist: Math.round(worst.d),
        count: threats.length,
        worst: worst.e.label,
        boss: threats.some((t) => t.e.kind === 'fusedShredder') ? 1 : 0,
      });
      return;
    }
    if (!st.hunt) return; // holding position, watching it, waiting to be told
  }

  // Everything below here is the robot amusing itself. It has to have been
  // briefed on this floor, and it has to have stood still for a moment first.
  if (!r.awaitingBriefing) {
    if (scratch.idleTicks < INITIATIVE_SETTLE) {
      scratch.idleTicks++;
      return;
    }
    if (st.gather) {
      const loot = nearestLoot(state);
      if (loot) {
        selfOrder(state, scratch, { kind: 'pickup', targetId: loot.id }, 'gather', loot.label);
        return;
      }
    }
    if (st.roam) {
      const sight = nextSight(state, scratch);
      if (sight) {
        // Marked seen on DEPARTURE, not arrival: a spot it cannot reach must
        // not become an errand it re-picks forever.
        scratch.exploreSeen.push(sight.id);
        selfOrder(state, scratch, { kind: 'goto', targetId: sight.id }, 'look', sight.label);
        return;
      }
    }
  }

  // Nothing it is allowed to do unasked. Ask — on a timer, so it is a
  // question rather than a nag.
  if (scratch.idleAskCd > 0) {
    scratch.idleAskCd--;
    return;
  }
  scratch.idleAskCd = IDLE_ASK_TICKS;
  emit(state, 'need_orders');
}

/**
 * Passive overlap triggers, run after all movement. Order-independent so
 * tier-0 driving into things works (beat 2: robot rolls into elevator B).
 */
export function proximityTriggers(state: SimState): void {
  const r = state.robot;
  if (!r.alive || r.dormant) return;
  for (const e of state.entities) {
    if (e.dead) continue;
    const d = dist(r.pos, e.pos);
    switch (e.kind) {
      case 'scrap':
        if (d <= PICKUP_RADIUS) collectScrap(state, e);
        break;
      case 'chip':
        // Driving over a chip picks it up. Tier 0 has no word for "chip", so
        // proximity is the only way it can ever be had on floor 2.
        if (d <= PICKUP_RADIUS) collectChip(state, e);
        break;
      case 'crate':
        // frozen-gated: no new ceremony triggers while one is running
        if (!state.frozen && d <= CRATE_NOTICE && !aiOf(e).reached) {
          aiOf(e).reached = 1; // once per crate
          emit(state, 'crate_reached', e.id);
        }
        break;
      case 'fuseSocket':
        if (r.carrying !== null && e.state !== 'filled' && d <= SOCKET_REACH) {
          const carried = entityById(state, r.carrying);
          if (carried) carried.state = 'inserted';
          r.carrying = null;
          e.state = 'filled';
          for (const b of state.entities) if (b.kind === 'elevatorB') b.state = 'lit';
          emit(state, 'fuse_inserted', e.id);
        }
        break;
      case 'elevatorB':
        // frozen-gated: no floor exit mid-ceremony
        if (!state.frozen && isElevatorPowered(e) && d <= ELEV_REACH && !aiOf(e).entered) {
          aiOf(e).entered = 1;
          halt(r);
          r.order = null;
          emit(state, 'elevator_entered', e.id);
        }
        break;
      default:
        break;
    }
  }
}

/**
 * Central damage sink. Returns true when damage actually applied (not i-framed).
 *
 * `channel` is threaded through but not yet acted on: there is still ONE global
 * i-frame budget, so behaviour is unchanged. It exists now so the phase that
 * gives contact/projectile/blast/hazard their own budgets — the change that
 * makes a swarm dangerous — does not also have to touch every call site.
 */
export function damageRobot(
  state: SimState,
  scratch: RobotScratch,
  amount: number,
  source: string,
  channel: DamageChannel,
  extra?: Record<string, string | number>,
): boolean {
  const r = state.robot;
  if (!r.alive || scratch.iframes > 0) return false;
  r.hp -= amount;
  scratch.iframes = IFRAME_TICKS;
  emit(state, 'robot_damage', undefined, { source, ...extra });
  if (source === 'cable') scratch.stun = CABLE_STUN_TICKS;
  if (r.hp <= 0) {
    r.hp = 0;
    r.alive = false;
    r.order = null;
    halt(r);
    emit(state, 'robot_death', undefined, { cause: source });
  }
  return true;
}
