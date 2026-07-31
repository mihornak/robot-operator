/**
 * Robot order execution + personality overrides. One call per tick.
 * Priority: sulk > stun > SCARED flee > MAGNET detour > RAGE > standing order.
 * Straight-line seeking with wall slide is deliberate — dumb pathing is the joke.
 */
import type { Entity, Order, RobotState, SimState, Vec } from '../../../shared/types';
import { BASE } from '../../../shared/content';
import {
  ARRIVE_RADIUS,
  ATTACK_RANGE,
  BOLT_SPEED,
  CABLE_STUN_TICKS,
  CRATE_REACH,
  ELEV_REACH,
  IFRAME_TICKS,
  MAGNET_RADIUS,
  PICKUP_RADIUS,
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
import { DT, angleLerp, dirToVec, dist, moveCircle, norm } from './physics';

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
function moveAndFace(state: SimState, dirUnit: Vec): number {
  const r = state.robot;
  r.vel.x = dirUnit.x * r.speed;
  r.vel.y = dirUnit.y * r.speed;
  if (Math.abs(r.vel.x) > 0.01 || Math.abs(r.vel.y) > 0.01) r.facing = Math.atan2(r.vel.y, r.vel.x);
  return moveCircle(state.solid, r.pos, r.vel.x * DT, r.vel.y * DT, ROBOT_R);
}

function seekPoint(state: SimState, target: Vec): number {
  const r = state.robot;
  return moveAndFace(state, norm({ x: target.x - r.pos.x, y: target.y - r.pos.y }));
}

/** wall_bump comedy: throttled — first contact, then every WALL_BUMP_EVERY ticks. */
function bumpCheck(state: SimState, moved: number, expected: number): void {
  const r = state.robot;
  if (expected <= 0.001) return;
  if (moved < expected * 0.25) {
    r.wallBumpTicks++;
    if (r.wallBumpTicks === 1 || r.wallBumpTicks % WALL_BUMP_EVERY === 0) {
      emit(state, 'wall_bump', undefined, { ticks: r.wallBumpTicks });
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

/** Would executing this order move the robot away from the hostile? (RAGE check) */
function movesAway(state: SimState, order: Order, hostile: Entity): boolean {
  const r = state.robot;
  let intent: Vec | null = null;
  if (order.kind === 'move') intent = dirToVec(order.dir);
  else if (order.kind === 'goto' || order.kind === 'enter' || order.kind === 'pickup') {
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

function executeOrder(state: SimState, order: Order | null): void {
  const r = state.robot;
  if (order === null) {
    halt(r);
    return;
  }
  switch (order.kind) {
    case 'move': {
      const moved = moveAndFace(state, dirToVec(order.dir));
      bumpCheck(state, moved, r.speed * DT);
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
      const moved = seekPoint(state, t.pos);
      bumpCheck(state, moved, Math.min(r.speed * DT, d));
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
        } else {
          emit(state, 'order_blocked', t.id, { reason: 'cant_carry' });
        }
        return;
      }
      const moved = seekPoint(state, t.pos);
      bumpCheck(state, moved, r.speed * DT);
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
      if (d <= ELEV_REACH + 4) {
        halt(r);
        r.order = null;
        if (t.kind === 'elevatorA') emit(state, 'order_blocked', t.id, { reason: 'tired' });
        else if (!isElevatorPowered(t)) emit(state, 'order_blocked', t.id, { reason: 'no_power' });
        // powered elevB: the proximity pass emits elevator_entered
        return;
      }
      const moved = seekPoint(state, t.pos);
      bumpCheck(state, moved, r.speed * DT);
      return;
    }
  }
}

export function stepRobot(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
  if (scratch.iframes > 0) scratch.iframes--;
  if (r.shootCd > 0) r.shootCd--;

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
    order !== null &&
    (order.kind === 'move' || order.kind === 'goto')
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
      seekPoint(state, s.pos); // pickup itself lands via the proximity pass
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

  executeOrder(state, order);
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
        if (d <= CRATE_REACH && !aiOf(e).reached) {
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
        if (isElevatorPowered(e) && d <= ELEV_REACH && !aiOf(e).entered) {
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
