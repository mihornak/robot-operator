/**
 * Projectile flight + hits: robot bolts vs machines, enemy paper vs robot,
 * robot ROCKETS vs everything including the robot, and the boss's decorative
 * shells vs nothing at all.
 */
import type { Projectile, SimState, Vec } from '../../../shared/types';
import { BOLT_HIT_RADIUS, ROBOT_R, aiOf, emit, isLiveHostile, roll, wakeMachine } from './internal';
import type { RobotScratch } from './internal';
import { DT, dist, solidAtPx } from './physics';
import { SHOOTABLE, explode } from './blast';
import { damageRobot } from './robot';

// ---------------------------------------------------------------- rocket tuning

/**
 * The launcher is the robot's second gun and its funniest one. Every number
 * below is picked so that the weapon is CHAOTIC rather than merely worse: it
 * is slower than the bolt, it scatters, it hurts everything nearby, and it is
 * still the right answer against a crowd.
 */
/** Slower than a bolt (180) on purpose — you can watch a rocket go wrong. */
export const ROCKET_SPEED = 150;
/** Its own clock, ~3.75× the bolt's 24. Sharing shootCd would make swapping
 *  guns a free reload, and "say rockets, say bolts, say rockets" is exactly the
 *  kind of thing a player discovers by accident and then does forever. */
export const ROCKET_CD = 90;
/** Aim scatter, radians. ±9° at 100px is ±16px — enough to miss a printer,
 *  not enough to make aiming pointless. One roll(state). */
export const ROCKET_SPREAD = (9 * Math.PI) / 180;
/** Muzzle velocity jitter, fraction. The second and last roll(state). */
export const ROCKET_SPEED_JITTER = 0.15;
export const ROCKET_BLAST_R = 30;
export const ROCKET_DAMAGE = 3;
/**
 * ARMING DISTANCE. A warhead that detonates this close to the robot shoves it
 * and does nothing else. Without this, firing at anything in contact is instant
 * self-immolation and the weapon is unusable rather than comedic — the robot
 * would learn, correctly, never to use its best toy.
 *
 * Implemented as distance from the robot AT DETONATION rather than distance
 * flown, which needs no per-projectile bookkeeping and is equivalent in
 * practice: a rocket outruns the robot 150 to 55, so the only way a detonation
 * happens within 28px of the robot is that it happened right where it was
 * fired — which is precisely the case this rule exists to cover.
 */
export const ROCKET_ARM_PX = 28;
/** Self-damage is halved and the shove is doubled. The knockback is the joke;
 *  the damage is the tax. Get that ratio backwards and the weapon stops being
 *  funny and starts being a mistake. */
export const ROCKET_SELF_SCALE = 0.5;
export const ROCKET_KNOCK_SCALE = 2;
/**
 * Under SCARED or on the last two hit points, the robot refuses to fire at
 * something this close. Not tidiness — a scared robot flinching from its own
 * rocket is the character being consistent, and it is the only thing standing
 * between the tax and an actual suicide.
 *
 * The number is derived, not chosen: a rocket's contact fuse trips one hit
 * radius SHORT of its target, and the blast reaches one robot radius past its
 * own. So the furthest target that can still hurt the shooter sits at
 * blast + robot + hit = 47px. Anything nearer than that is in the band, and the
 * measured spam test kills the robot in six shots at 40px without this.
 */
export const ROCKET_REFUSE_PX = ROCKET_BLAST_R + ROBOT_R + BOLT_HIT_RADIUS;

/**
 * Can the launcher fire right now? Returns the order_blocked reason when not,
 * so the caller emits it with the id it already has in hand.
 *
 * 'no_rockets' is not a refusal the player should ever hear as a complaint —
 * standing.weapon is a wish until the floor-6 crate makes it a fact, and the
 * caller falls back to bolts rather than standing there empty-handed.
 */
export function rocketBlockedReason(state: SimState): 'no_rockets' | 'carrying' | 'too_close' | null {
  const r = state.robot;
  if (!r.rockets) return 'no_rockets';
  if (r.carrying !== null) return 'carrying';
  if (r.chips.includes('SCARED') || r.hp <= 2) {
    for (const e of state.entities) {
      if (!isLiveHostile(e)) continue;
      if (dist(r.pos, e.pos) <= ROCKET_REFUSE_PX) return 'too_close';
    }
  }
  return null;
}

/**
 * Launch one rocket along `aim`. EXACTLY TWO roll(state) draws, always, in this
 * order — spread then speed. A weapon whose rng draw count depends on what it
 * hit would desync every downstream random decision in the run, and the failure
 * would surface a hundred ticks later as an enemy that scanned the wrong way.
 *
 * Caller owns the cooldown check and the order_blocked emit (see
 * rocketBlockedReason); this only fires.
 */
export function fireRocket(state: SimState, aim: Vec, face = true): void {
  const r = state.robot;
  const base = Math.atan2(aim.y, aim.x);
  const a = base + (roll(state) * 2 - 1) * ROCKET_SPREAD;
  const speed = ROCKET_SPEED * (1 + (roll(state) * 2 - 1) * ROCKET_SPEED_JITTER);
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  if (face) r.facing = a;
  state.projectiles.push({
    id: `rocket_${state.nextId++}`,
    kind: 'rocket',
    // Muzzle sits outside the body: a rocket that spawns on top of the robot
    // would arm-check against its own launch point and read as a dud.
    pos: { x: r.pos.x + ux * 12, y: r.pos.y + uy * 12 },
    vel: { x: ux * speed, y: uy * speed },
  });
  emit(state, 'shot_fired', undefined, { weapon: 'rocket' });
  r.rocketCd = ROCKET_CD;
}

/** Rocket detonation: one blast, robot included, with both guard rails on. */
function detonate(state: SimState, scratch: RobotScratch, p: Projectile): void {
  const armed = dist(p.pos, state.robot.pos) >= ROCKET_ARM_PX;
  explode(state, scratch, p.pos, ROCKET_BLAST_R, ROCKET_DAMAGE, 'robot', 'robot', {
    selfScale: ROCKET_SELF_SCALE,
    knockScale: ROCKET_KNOCK_SCALE,
    armRobot: armed,
  });
}

export function stepProjectiles(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
  const keep: Projectile[] = [];
  for (const p of state.projectiles) {
    p.pos.x += p.vel.x * DT;
    p.pos.y += p.vel.y * DT;

    // The boss's shell is scenery flying ABOVE the room: no walls, no hits, no
    // early exit from this loop into the O(projectiles × entities) test below.
    // mortar.ts retires it on the tick its circle goes off, which is the only
    // moment it is allowed to stop existing.
    if (p.kind === 'shell') {
      keep.push(p);
      continue;
    }

    if (solidAtPx(state.solid, p.pos.x, p.pos.y)) {
      // A rocket that hits masonry still goes off. It is the whole reason
      // "shoot the wall" is a thing the player will do on purpose.
      if (p.kind === 'rocket') detonate(state, scratch, p);
      continue;
    }

    if (p.kind === 'bolt') {
      let hit = false;
      for (const e of state.entities) {
        if (e.dead || e.hp === undefined || !SHOOTABLE.has(e.kind)) continue;
        if (dist(p.pos, e.pos) > BOLT_HIT_RADIUS) continue;
        e.hp -= r.damage;
        // Shooting a sleeping machine wakes it — and `wakeMachine`, not a bare
        // aggro flag, because 'dormant' is what isLiveHostile tests. Setting
        // aggro alone leaves the thing scenery: not a threat, not steered
        // around, and skipped by stepBoss. The robot could then walk up and
        // execute a sleeping boss which never once fought back.
        wakeMachine(e);
        emit(state, 'enemy_hit', e.id);
        if (e.hp <= 0) {
          e.hp = 0;
          e.dead = true;
          e.state = 'dead';
          emit(state, 'enemy_death', e.id);
        }
        hit = true;
        break;
      }
      if (hit) continue;
    } else if (p.kind === 'rocket') {
      // Contact fuse. No direct-hit bonus: the blast is already resolving
      // against the thing it touched, and two damage numbers for one impact is
      // how a weapon quietly becomes twice as strong as its tuning says.
      let hit = false;
      for (const e of state.entities) {
        if (e.dead || e.hp === undefined || !SHOOTABLE.has(e.kind)) continue;
        if (dist(p.pos, e.pos) > BOLT_HIT_RADIUS) continue;
        hit = true;
        break;
      }
      if (hit) {
        detonate(state, scratch, p);
        continue;
      }
    } else if (r.alive && dist(p.pos, r.pos) <= ROBOT_R + 3) {
      damageRobot(state, scratch, 1, 'paper', 'projectile');
      continue; // paper crumples even on an i-framed robot
    }
    keep.push(p);
  }
  state.projectiles = keep;
}
