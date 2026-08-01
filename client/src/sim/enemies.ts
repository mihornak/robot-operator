/**
 * Enemy AI (fusedPrinter) + hazards (cable). All frozen-gated by the caller.
 * Printer: idles until the robot is close or it gets shot, then lurch-chases
 * (move/pause menace rhythm) and periodically telegraphs + spits paper.
 */
import type { SimState, Vec } from '../../../shared/types';
import {
  AGGRO_RANGE,
  SNEAK_AGGRO_FACTOR,
  CABLE_RADIUS,
  CONTACT_RANGE,
  ENEMY_R,
  ENEMY_SPEED,
  KNOCKBACK_PX,
  LURCH_MOVE_TICKS,
  LURCH_PAUSE_TICKS,
  PAPER_SPEED,
  ROBOT_R,
  SPIT_ANIM_TICKS,
  SPIT_MIN_TICKS,
  SPIT_TELEGRAPH_TICKS,
  aiOf,
  emit,
  roll,
} from './internal';
import type { RobotScratch } from './internal';
import { DT, dist, dominantDir, moveCircle, norm } from './physics';
import { damageRobot } from './robot';

export function stepEnemies(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
  for (const e of state.entities) {
    if (e.kind !== 'fusedPrinter' || e.dead) continue;
    const ai = aiOf(e);
    const toRobot: Vec = { x: r.pos.x - e.pos.x, y: r.pos.y - e.pos.y };
    const d = Math.hypot(toRobot.x, toRobot.y);

    // Sneaking (careful order, + a ~6s linger after it completes) is QUIET —
    // half notice range. Payoff of "sneak to X": don't wake the machine.
    const quiet =
      scratch.sneakLingerTicks > 0 ||
      (r.order !== null && (r.order.kind === 'goto' || r.order.kind === 'pickup') && r.order.careful === true);
    const notice = quiet ? AGGRO_RANGE * SNEAK_AGGRO_FACTOR : AGGRO_RANGE;
    if (!ai.aggro && r.alive && d <= notice) ai.aggro = 1; // getting shot also sets aggro (projectiles.ts)
    if (ai.aggro && !ai.spotted) {
      ai.spotted = 1;
      emit(state, 'enemy_spotted', e.id);
    }
    if (!ai.aggro) {
      e.state = 'idle';
      continue;
    }
    if (!r.alive) {
      e.state = 'pause';
      continue;
    }

    e.facing = dominantDir(toRobot);

    if (!ai.init) {
      ai.init = 1;
      ai.moving = 1;
      ai.phaseT = LURCH_MOVE_TICKS;
      ai.spitIn = SPIT_MIN_TICKS + Math.floor(roll(state) * 60);
    }

    // spit: telegraph stands still, then looses a paper at the robot
    if (ai.tel > 0) {
      ai.tel--;
      e.state = 'spit_tel';
      if (ai.tel === 0) {
        const aim = d > 0.001 ? { x: toRobot.x / d, y: toRobot.y / d } : { x: 1, y: 0 };
        state.projectiles.push({
          id: `paper_${e.id}_${state.tick}`,
          kind: 'paper',
          pos: { x: e.pos.x + aim.x * 12, y: e.pos.y + aim.y * 12 },
          vel: { x: aim.x * PAPER_SPEED, y: aim.y * PAPER_SPEED },
        });
        emit(state, 'paper_thrown', e.id);
        ai.spitIn = SPIT_MIN_TICKS + Math.floor(roll(state) * 60);
        e.state = 'spit'; // render contract: real spit pose after the throw
        ai.spitAnim = SPIT_ANIM_TICKS - 1; // throw tick counts as the first
      }
      continue;
    }
    // post-throw recoil: hold the spit pose, then resume chase/pause
    if (ai.spitAnim > 0) {
      ai.spitAnim--;
      e.state = 'spit';
      continue;
    }
    ai.spitIn--;
    if (ai.spitIn <= 0) {
      ai.tel = SPIT_TELEGRAPH_TICKS;
      continue;
    }

    // lurch-chase rhythm
    if (ai.moving === 1) {
      e.state = 'chase';
      const aim = norm(toRobot);
      moveCircle(state.solid, e.pos, aim.x * ENEMY_SPEED * DT, aim.y * ENEMY_SPEED * DT, ENEMY_R);
      ai.phaseT--;
      if (ai.phaseT <= 0) {
        ai.moving = 0;
        ai.phaseT = LURCH_PAUSE_TICKS + Math.floor(roll(state) * 6);
      }
    } else {
      e.state = 'pause';
      ai.phaseT--;
      if (ai.phaseT <= 0) {
        ai.moving = 1;
        ai.phaseT = LURCH_MOVE_TICKS;
      }
    }

    // contact damage + knockback (i-frames gate both; TOUGH halves the shove)
    if (dist(e.pos, r.pos) <= CONTACT_RANGE) {
      const push = norm({ x: r.pos.x - e.pos.x, y: r.pos.y - e.pos.y });
      if (damageRobot(state, scratch, 1, 'enemy')) {
        const kb = r.chips.includes('TOUGH') ? KNOCKBACK_PX / 2 : KNOCKBACK_PX;
        moveCircle(state.solid, r.pos, push.x * kb, push.y * kb, ROBOT_R);
      }
    }
  }
}

export function stepHazards(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
  if (!r.alive) return;
  for (const e of state.entities) {
    if (e.kind !== 'cable' || e.dead) continue;
    if (dist(e.pos, r.pos) <= CABLE_RADIUS) {
      // damageRobot applies the 20-tick zap stun for source 'cable'
      damageRobot(state, scratch, 1, 'cable', { hazard: 'zap' });
    }
  }
}
