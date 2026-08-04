/**
 * Robot order execution + personality overrides. One call per tick.
 * Priority: sulk > stun > SCARED flee > MAGNET detour > RAGE > standing order.
 * Straight-line seeking with wall slide is deliberate — dumb pathing is the joke.
 */
import type { Entity, Order, RobotState, SimState, Vec } from '../../../shared/types';
import { TILE, TILES_X, TILES_Y } from '../../../shared/types';
import { BASE } from '../../../shared/content';
import {
  ARRIVE_RADIUS,
  ATTACK_RANGE,
  AVOID_PENALTY_COST,
  AVOID_PENALTY_TILES,
  AVOID_REPULSE_RADIUS,
  BOLT_SPEED,
  CABLE_STUN_TICKS,
  CAREFUL_REPULSE_RADIUS,
  CAREFUL_SPEED,
  CRATE_NOTICE,
  ELEVATOR_KEEPOUT,
  ELEV_REACH,
  EXPLORE_ARRIVE,
  EXPLORE_GIVEUP_TICKS,
  EXPLORE_KINDS,
  EXPLORE_WANDER_MIN,
  GATHER_RADIUS,
  HIDE_ARRIVE,
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
  REPULSE_SWIRL,
  REPULSE_WEIGHT,
  RETREAT_TRIGGER,
  ROBOT_R,
  SHOOT_CONE_COS,
  SHOOT_RANGE,
  SOCKET_REACH,
  WALL_BUMP_EVERY,
  aiOf,
  applyOrder,
  clearNav,
  emit,
  entityById,
  hostileInSight,
  isElevatorPowered,
  nearestHostile,
  roll,
} from './internal';
import type { RobotScratch } from './internal';
import { findPath, markPenalty, newPenaltyGrid } from './pathfind';
import { DT, angleLerp, dirToVec, dist, isSolidTile, losBlocked, moveCircle, norm } from './physics';

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

/** Add linear-falloff repulsion away from e into acc. Full REPULSE_WEIGHT at
 *  the danger edge (REPULSE_CLEAR from center), 0 at clear+radius: peak > 1
 *  beats the unit seek, so careful can never push through the zone head-on.
 *  A tangential swirl component (side picked deterministically toward where
 *  `desired` already leans) makes dead-ahead hazards get orbited — a pure
 *  radial field just oscillates on the approach axis forever. */
function addRepulse(r: RobotState, e: Entity, radius: number, desired: Vec, acc: Vec): void {
  const dEff = Math.max(0, dist(r.pos, e.pos) - REPULSE_CLEAR);
  if (dEff >= radius) return;
  const w = REPULSE_WEIGHT * (1 - dEff / radius);
  const away = norm({ x: r.pos.x - e.pos.x, y: r.pos.y - e.pos.y });
  const side = away.x * desired.y - away.y * desired.x >= 0 ? 1 : -1;
  acc.x += away.x * w - away.y * side * w * REPULSE_SWIRL;
  acc.y += away.y * w + away.x * side * w * REPULSE_SWIRL;
}

/** Is this order (or the standing default) asking for quiet, slow movement? */
function isCareful(state: SimState, careful?: boolean): boolean {
  return careful === true || state.robot.standing.careful;
}

/**
 * Local steering: blend a desired unit direction with repulsion from the things
 * the STANDING ORDERS say to stay off — named avoid ids, hostiles under "avoid
 * enemies", cables under "avoid hazards", both when moving carefully. The route
 * from A* handles walls; this handles the moving, dangerous, wall-less stuff a
 * static grid cannot know about. Normalized, so a blend never slows the robot;
 * a dead-cancel (cornered by two fields) yields {0,0} and reads as a stall the
 * bumpCheck give-up will clear.
 */
function steer(state: SimState, desired: Vec, careful: boolean): Vec {
  const r = state.robot;
  const st = r.standing;
  const dodgeFoes = careful || st.avoidEnemies;
  const dodgeHazards = careful || st.avoidHazards;
  if (!dodgeFoes && !dodgeHazards && st.avoidIds.length === 0) return desired;
  const acc = { x: desired.x, y: desired.y };
  for (const e of state.entities) {
    if (e.dead) continue;
    if (st.avoidIds.includes(e.id)) addRepulse(r, e, AVOID_REPULSE_RADIUS, desired, acc);
    else if (dodgeFoes && e.kind === 'fusedPrinter') {
      // A standing "avoid enemies" is a wider berth than mere caution.
      addRepulse(r, e, st.avoidEnemies ? AVOID_REPULSE_RADIUS : CAREFUL_REPULSE_RADIUS, desired, acc);
    } else if (dodgeHazards && e.kind === 'cable') {
      addRepulse(r, e, CAREFUL_REPULSE_RADIUS, desired, acc);
    }
  }
  return norm(acc);
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
    else if ((careful || st.avoidEnemies) && e.kind === 'fusedPrinter') hazards.push(e.pos);
  }
  if (hazards.length === 0) return null;
  scratch.navPenalty ??= newPenaltyGrid();
  markPenalty(scratch.navPenalty, hazards, AVOID_PENALTY_TILES, AVOID_PENALTY_COST);
  return scratch.navPenalty;
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
  const needPlan =
    scratch.navGoal === null ||
    dist(scratch.navGoal, target) > NAV_TARGET_DRIFT ||
    scratch.navCooldown <= 0 ||
    scratch.navIndex >= scratch.navPath.length;
  if (needPlan) {
    scratch.navPath = findPath(state.solid, r.pos, target, ROBOT_R, routePenalty(state, scratch, careful));
    scratch.navIndex = 0;
    scratch.navGoal = { x: target.x, y: target.y };
    scratch.navCooldown = NAV_REPATH_TICKS;
    scratch.navFailed = scratch.navPath.length === 0;
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
    id: `bolt_${state.tick}`,
    kind: 'bolt',
    pos: { x: r.pos.x + aim.x * 10, y: r.pos.y + aim.y * 10 },
    vel: { x: aim.x * BOLT_SPEED, y: aim.y * BOLT_SPEED },
  });
  emit(state, 'shot_fired');
  r.shootCd = shootCdMax(r);
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
    if (e.kind !== 'fusedPrinter' || e.dead) continue;
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

/**
 * BRAIN hide: pick a cover point. Candidates are walkable tile centers within
 * HIDE_SEARCH_RADIUS (tile non-solid ⇒ r=7 circle fits: 7 < TILE/2). With a
 * live hostile: nearest candidate whose LOS to it is wall-blocked; if none
 * breaks LOS, the candidate farthest from the hostile — the robot BELIEVES it
 * is hidden. No hostile: nearest candidate hugging a wall (a nook).
 * Fixed y→x scan order + strict comparisons keep the pick deterministic.
 */
function findCover(state: SimState): Vec {
  const r = state.robot;
  const hostile = nearestHostile(state);
  const minTx = Math.max(0, Math.floor((r.pos.x - HIDE_SEARCH_RADIUS) / TILE));
  const maxTx = Math.min(TILES_X - 1, Math.floor((r.pos.x + HIDE_SEARCH_RADIUS) / TILE));
  const minTy = Math.max(0, Math.floor((r.pos.y - HIDE_SEARCH_RADIUS) / TILE));
  const maxTy = Math.min(TILES_Y - 1, Math.floor((r.pos.y + HIDE_SEARCH_RADIUS) / TILE));

  let best: Vec | null = null; // hostile: nearest LOS-breaker | none: nearest nook
  let bestD = Infinity;
  let far: Vec | null = null; // hostile fallback: farthest from it
  let farD = -1;
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (isSolidTile(state.solid, tx, ty)) continue;
      const c: Vec = { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
      const dRobot = dist(r.pos, c);
      if (dRobot > HIDE_SEARCH_RADIUS) continue;
      if (hostile) {
        if (coverBlocked(state.solid, c, hostile.pos)) {
          if (dRobot < bestD) {
            bestD = dRobot;
            best = c;
          }
        } else {
          const dHostile = dist(c, hostile.pos);
          if (dHostile > farD) {
            farD = dHostile;
            far = c;
          }
        }
      } else {
        const nook =
          isSolidTile(state.solid, tx - 1, ty) ||
          isSolidTile(state.solid, tx + 1, ty) ||
          isSolidTile(state.solid, tx, ty - 1) ||
          isSolidTile(state.solid, tx, ty + 1);
        if (nook && dRobot < bestD) {
          bestD = dRobot;
          best = c;
        }
      }
    }
  }
  return best ?? far ?? { x: r.pos.x, y: r.pos.y };
}

/** Would executing this order move the robot away from the hostile? (RAGE check) */
function movesAway(state: SimState, order: Order, hostile: Entity): boolean {
  const r = state.robot;
  let intent: Vec | null = null;
  if (order.kind === 'move') intent = dirToVec(order.dir);
  else if (order.kind === 'attack') {
    // Attacking any live hostile IS engaging; wasting shots on a decoy is not.
    const t = entityById(state, order.targetId);
    return t !== null && !t.dead && t.kind !== 'fusedPrinter';
  } else if (order.kind === 'goto' || order.kind === 'enter' || order.kind === 'pickup') {
    const t = entityById(state, order.targetId);
    if (t) intent = norm({ x: t.pos.x - r.pos.x, y: t.pos.y - r.pos.y });
  }
  if (!intent) return false;
  const to = norm({ x: hostile.pos.x - r.pos.x, y: hostile.pos.y - r.pos.y });
  return intent.x * to.x + intent.y * to.y < 0;
}

/**
 * RAGE override: close to attack range and keep shooting — but only at things
 * it can actually hit. With a wall between them it advances instead of standing
 * still emptying its magazine into masonry (which looked, correctly, like a
 * frozen game). Time-boxed by the caller's RAGE budget.
 */
function engage(state: SimState, scratch: RobotScratch, hostile: Entity): void {
  const r = state.robot;
  const d = dist(r.pos, hostile.pos);
  const clear = canShoot(state, hostile.pos);
  if (d > ATTACK_RANGE || !clear) {
    // No bumpCheck here on purpose: the give-up timer belongs to the player's
    // order, and rage must not spend it. The RAGE budget bounds this instead.
    navSeek(state, scratch, hostile.pos, false);
    return;
  }
  halt(r);
  if (r.carrying !== null) return; // rage with full hands: just looms
  if (r.shootCd === 0) fireBolt(state, norm({ x: hostile.pos.x - r.pos.x, y: hostile.pos.y - r.pos.y }));
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

function executeOrder(state: SimState, order: Order | null, scratch: RobotScratch): void {
  const r = state.robot;
  if (order === null) {
    halt(r);
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
      halt(r);
      if (r.carrying !== null) {
        emit(state, 'order_blocked', r.carrying, { reason: 'carrying' });
        r.order = null;
        return;
      }
      if (r.shootCd === 0) {
        const aim = coneTarget(state) ?? { x: Math.cos(r.facing), y: Math.sin(r.facing) };
        fireBolt(state, aim);
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
      // In range but behind a wall: close the distance instead of shooting the
      // wall. Bolts stop at walls, so the old behaviour was an infinite stall.
      if (d <= ATTACK_RANGE && canShoot(state, t.pos)) {
        halt(r);
        const aim = norm({ x: t.pos.x - r.pos.x, y: t.pos.y - r.pos.y });
        r.facing = Math.atan2(aim.y, aim.x);
        if (r.shootCd === 0) fireBolt(state, aim);
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
      // Cover point computed once per order (applyOrder clears it).
      scratch.hideTarget ??= findCover(state);
      const t = scratch.hideTarget;
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
      // Back away and KEEP backing away while the thing is still looking at
      // us — one hop of cover is a hiding place, a retreat is a decision to
      // leave. Ends when the hostile is out of sight or the clock runs out.
      const hostile = hostileInSight(state);
      if (hostile === null || scratch.retreatTicks <= 0) {
        halt(r);
        r.order = null;
        emit(state, 'order_done');
        return;
      }
      scratch.retreatTicks--;
      scratch.hideTarget ??= findCover(state);
      const t = scratch.hideTarget;
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

  const hostile = hostileInSight(state);
  const hostileVisible = hostile !== null;
  if (!hostileVisible) {
    scratch.rageTicks = RAGE_BUDGET_TICKS; // fresh budget per encounter
    scratch.threatCalled = false; // next machine gets its own warning
  }

  // SCARED: below half hp it flees, orders be damned
  if (r.chips.includes('SCARED') && hostileVisible && r.hp < r.maxHp * 0.5) {
    r.mood = 'fleeing';
    if (!scratch.fleeEpisode) {
      scratch.fleeEpisode = true;
      emit(state, 'chip_flee', hostile.id);
    }
    moveAndFace(state, norm({ x: r.pos.x - hostile.pos.x, y: r.pos.y - hostile.pos.y }));
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
  if (r.chips.includes('RAGE') && hostileVisible && order !== null && movesAway(state, order, hostile)) {
    if (scratch.rageTicks > 0) {
      scratch.rageTicks--;
      if (!scratch.rageNotified) {
        scratch.rageNotified = true;
        emit(state, 'order_blocked', hostile.id, { reason: 'rage' });
      }
      if (scratch.rageTicks === 0) emit(state, 'order_blocked', hostile.id, { reason: 'rage_relent' });
      engage(state, scratch, hostile);
      easeHead(r);
      return;
    }
    // Budget spent — the order runs, and it stays runnable until the machine
    // leaves sight (which is what refills the budget).
  }

  // Return fire WITHOUT dropping the task, and ONLY at something already
  // coming for us (ai.aggro) unless we were told to hunt. A robot escorted to
  // the elevator that plinks at the printer chasing it reads as a competent
  // little soldier; one that opens up on a machine minding its own business
  // across the room is the "guns blazing" problem. The body keeps walking —
  // only the bolt turns.
  if (
    r.standing.fight &&
    !r.standing.avoidEnemies &&
    hostileVisible &&
    (r.standing.hunt || aiOf(hostile).aggro === 1) &&
    r.carrying === null &&
    r.shootCd === 0 &&
    dist(r.pos, hostile.pos) <= SHOOT_RANGE &&
    canShoot(state, hostile.pos)
  ) {
    fireBolt(state, norm({ x: hostile.pos.x - r.pos.x, y: hostile.pos.y - r.pos.y }), order === null);
  }

  // Nothing to do and allowed to think for itself: pick the next task.
  if (order === null && r.standing.autonomy && !state.frozen) {
    chooseInitiative(state, scratch, hostile);
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
function chooseInitiative(state: SimState, scratch: RobotScratch, hostile: Entity | null): void {
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

  if (hostile !== null) {
    const closing = dist(r.pos, hostile.pos) <= RETREAT_TRIGGER;
    if (st.avoidEnemies || !st.fight) {
      if (closing) {
        selfOrder(state, scratch, { kind: 'retreat' }, 'retreat', hostile.label);
        return;
      }
    } else if (st.hunt) {
      // Only under an explicit "fight everything" does it go and start one.
      selfOrder(state, scratch, { kind: 'attack', targetId: hostile.id }, 'fight', hostile.label);
      return;
    } else if (!scratch.threatCalled) {
      // Default posture: it has seen something and it does NOT charge. It says
      // so and holds, because deciding whether this is a fight is the
      // operator's job — that decision IS the game.
      scratch.threatCalled = true;
      emit(state, 'threat_seen', hostile.id, { dist: Math.round(dist(r.pos, hostile.pos)) });
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

/** Central damage sink. Returns true when damage actually applied (not i-framed). */
export function damageRobot(
  state: SimState,
  scratch: RobotScratch,
  amount: number,
  source: string,
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
