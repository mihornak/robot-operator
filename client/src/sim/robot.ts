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
  AVOID_REPULSE_RADIUS,
  BOLT_SPEED,
  CABLE_STUN_TICKS,
  CAREFUL_REPULSE_RADIUS,
  CAREFUL_SPEED,
  CRATE_NOTICE,
  ELEV_REACH,
  HIDE_ARRIVE,
  HIDE_SEARCH_RADIUS,
  IFRAME_TICKS,
  MAGNET_RADIUS,
  PICKUP_RADIUS,
  REPULSE_CLEAR,
  REPULSE_SWIRL,
  REPULSE_WEIGHT,
  ROBOT_R,
  SHOOT_CONE_COS,
  SHOOT_RANGE,
  SIGHT,
  SOCKET_REACH,
  WALL_BUMP_EVERY,
  aiOf,
  emit,
  entityById,
  isElevatorPowered,
  nearestHostile,
} from './internal';
import type { RobotScratch } from './internal';
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

function seekPoint(state: SimState, target: Vec): number {
  const r = state.robot;
  return moveAndFace(state, norm({ x: target.x - r.pos.x, y: target.y - r.pos.y }));
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

/**
 * BRAIN steering: blend a desired unit direction with repulsion from standing
 * avoidIds (always) and, when careful, live hostiles + cables. Normalized —
 * full speed along the blend; a dead-cancel (cornered) yields {0,0} and the
 * bumpCheck give-up handles it like a wall.
 */
function steer(state: SimState, desired: Vec, careful: boolean): Vec {
  const r = state.robot;
  if (!careful && r.avoidIds.length === 0) return desired;
  const acc = { x: desired.x, y: desired.y };
  for (const e of state.entities) {
    if (e.dead) continue;
    if (r.avoidIds.includes(e.id)) addRepulse(r, e, AVOID_REPULSE_RADIUS, desired, acc);
    else if (careful && (e.kind === 'fusedPrinter' || e.kind === 'cable'))
      addRepulse(r, e, CAREFUL_REPULSE_RADIUS, desired, acc);
  }
  return norm(acc);
}

/** Order-execution seek (goto/pickup/enter/hide): steered + careful-scaled. */
function steerSeek(state: SimState, target: Vec, careful: boolean): number {
  const r = state.robot;
  const desired = norm({ x: target.x - r.pos.x, y: target.y - r.pos.y });
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

function fireBolt(state: SimState, aim: Vec): void {
  const r = state.robot;
  r.facing = Math.atan2(aim.y, aim.x);
  state.projectiles.push({
    id: `bolt_${state.tick}`,
    kind: 'bolt',
    pos: { x: r.pos.x + aim.x * 10, y: r.pos.y + aim.y * 10 },
    vel: { x: aim.x * BOLT_SPEED, y: aim.y * BOLT_SPEED },
  });
  emit(state, 'shot_fired');
  r.shootCd = shootCdMax(r);
}

/** Tier-0 auto-aim: nearest live hostile within a 30° cone of facing, else null. */
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

/** RAGE override: close to attack range and keep shooting. Never disengages. */
function engage(state: SimState, hostile: Entity): void {
  const r = state.robot;
  const d = dist(r.pos, hostile.pos);
  if (d > ATTACK_RANGE) {
    seekPoint(state, hostile.pos);
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
      const careful = order.careful === true;
      const moved = steerSeek(state, t.pos, careful);
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
      if (d <= ATTACK_RANGE) {
        halt(r);
        const aim = norm({ x: t.pos.x - r.pos.x, y: t.pos.y - r.pos.y });
        r.facing = Math.atan2(aim.y, aim.x);
        if (r.shootCd === 0) fireBolt(state, aim);
      } else {
        const moved = seekPoint(state, t.pos);
        bumpCheck(state, moved, r.speed * DT);
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
      if (d <= (t.kind === 'scrap' ? PICKUP_RADIUS : ARRIVE_RADIUS)) {
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
        } else if (t.kind === 'fuseSocket' && (r.carrying !== null || t.state === 'filled')) {
          // "pick up the socket" with fuse in hand = deliver; the proximity
          // pass does the insertion (SOCKET_REACH > ARRIVE_RADIUS) — success.
          emit(state, 'order_done', t.id);
        } else {
          emit(state, 'order_blocked', t.id, { reason: 'cant_carry' });
        }
        return;
      }
      const careful = order.careful === true;
      const moved = steerSeek(state, t.pos, careful);
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
      const moved = steerSeek(state, t.pos, false);
      bumpCheck(state, moved, r.speed * DT);
      return;
    }
    case 'hide': {
      // BRAIN: cover point computed once per order (setOrder clears it).
      scratch.hideTarget ??= findCover(state);
      const t = scratch.hideTarget;
      const d = dist(r.pos, t);
      if (d <= HIDE_ARRIVE) {
        halt(r);
        r.order = null;
        emit(state, 'order_done'); // no id — cover is a point, not an entity
        return;
      }
      const moved = steerSeek(state, t, false);
      bumpCheck(state, moved, Math.min(r.speed * DT, d));
      return;
    }
  }
}

export function stepRobot(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
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

  const hostile = nearestHostile(state);
  const hostileVisible = hostile !== null && dist(r.pos, hostile.pos) <= SIGHT;

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
      const moved = seekPoint(state, s.pos); // pickup itself lands via the proximity pass
      bumpCheck(state, moved, Math.min(r.speed * DT, d));
      if (r.wallBumpTicks >= WALL_BUMP_EVERY) {
        // shiny is behind a wall — give up (scrap stays detour-blacklisted)
        scratch.magnetTargetId = null;
        r.wallBumpTicks = 0;
      }
      easeHead(r);
      return;
    }
  }

  // RAGE: refuses to disengage from a visible hostile
  if (r.chips.includes('RAGE') && hostileVisible && order !== null && movesAway(state, order, hostile)) {
    if (!scratch.rageNotified) {
      scratch.rageNotified = true;
      emit(state, 'order_blocked', hostile.id, { reason: 'rage' });
    }
    engage(state, hostile);
    easeHead(r);
    return;
  }

  executeOrder(state, order, scratch);
  easeHead(r);
}

/**
 * Passive overlap triggers, run after all movement. Order-independent so
 * tier-0 driving into things works (beat 2: robot rolls into elevator B).
 */
export function proximityTriggers(state: SimState): void {
  const r = state.robot;
  if (!r.alive) return;
  for (const e of state.entities) {
    if (e.dead) continue;
    const d = dist(r.pos, e.pos);
    switch (e.kind) {
      case 'scrap':
        if (d <= PICKUP_RADIUS) collectScrap(state, e);
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
