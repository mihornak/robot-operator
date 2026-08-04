/**
 * Enemy AI (fusedPrinter) + hazards (cable). All frozen-gated by the caller.
 * Printer: idles and sweeps its head until it SEES the robot (or gets shot),
 * then lurch-chases (move/pause menace rhythm) and periodically telegraphs +
 * spits paper. Losing sight does not switch it off — it hunts the last place
 * it saw the robot for a few seconds first.
 */
import type { Dir, SimState, Vec } from '../../../shared/types';
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
import { DT, dirToVec, dist, dominantDir, losBlocked, moveCircle, norm } from './physics';
import { damageRobot } from './robot';

/**
 * Notice cone, as cos of the half-angle. ±100° is deliberately generous: the
 * cone exists so that coming at a machine from behind is worth something, not
 * so the floor becomes a stealth puzzle whose rules the player cannot see (the
 * sprite only mirrors left/right, so facing is barely legible on the feed).
 */
const NOTICE_CONE_COS = Math.cos((100 * Math.PI) / 180);
/** Behind the cone it only HEARS: half the notice range. Still short enough
 *  that a sneak from the rear pays, long enough that strolling into contact
 *  from behind never goes unpunished. */
const REAR_NOTICE_FACTOR = 0.5;
/** Once hunting it keeps the robot while it can still see it out to here.
 *  A machine that forgets the moment you back off one step is not menacing;
 *  one with no leash at all follows you across an empty hall forever. */
const HUNT_SIGHT = 220;
/** Ticks of pursuing the last known position after sight breaks. 3s: cover
 *  really works, but it is not an off-switch you flick behind a pillar. */
const MEMORY_TICKS = 180;
/** Ticks fully calm before enemy_spotted may fire again. Without it, a robot
 *  dancing on the edge of cover machine-guns the director with call-outs. */
const RENOTICE_CALM_TICKS = 150;
/** Idle head sweep: ticks per facing, + up to SCAN_JITTER of seeded jitter.
 *  A machine frozen mid-stare forever would give every floor a permanent,
 *  invisible blind side — learnable only by dying in it. */
const SCAN_DWELL = 130;
const SCAN_JITTER = 90;
const SCAN_ORDER: readonly Dir[] = ['down', 'right', 'up', 'left'];

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
      r.standing.careful || // a standing "move carefully" is quiet all the time
      (r.order !== null && (r.order.kind === 'goto' || r.order.kind === 'pickup') && r.order.careful === true);
    const notice = quiet ? AGGRO_RANGE * SNEAK_AGGRO_FACTOR : AGGRO_RANGE;

    // LINE OF SIGHT gates everything. Distance-only aggro meant the floor-3
    // printer woke the instant the robot stepped off the lift two rooms away,
    // which deleted route choice, cover and stealth in one go: there was no
    // way to play the floor, only a machine that always knew. Walls hide the
    // robot now. Getting shot still wakes it (projectiles.ts sets ai.aggro).
    const sees = r.alive && !losBlocked(state.solid, e.pos, r.pos);

    if (!ai.aggro && sees) {
      const f = dirToVec(e.facing ?? 'down');
      const ahead = d > 0.001 && (toRobot.x * f.x + toRobot.y * f.y) / d >= NOTICE_CONE_COS;
      if (d <= (ahead ? notice : notice * REAR_NOTICE_FACTOR)) ai.aggro = 1;
    }

    // A fresh hunt seeds the memory — whether it started from the cone above or
    // from a bolt in the back, which sets ai.aggro directly and would otherwise
    // be forgotten on the very next tick if the shooter was out of sight.
    if (ai.aggro && !ai.hunting) {
      ai.hunting = 1;
      ai.mem = MEMORY_TICKS;
      ai.lkx = r.pos.x;
      ai.lky = r.pos.y;
      ai.calm = 0;
    }
    if (ai.hunting) {
      if (sees && d <= HUNT_SIGHT) {
        ai.mem = MEMORY_TICKS; // eyes on: memory stays topped up
        ai.lkx = r.pos.x;
        ai.lky = r.pos.y;
      } else if (--ai.mem <= 0) {
        ai.aggro = 0; // lost it — the floor goes quiet again
        ai.hunting = 0;
        ai.init = 0; // next hunt re-rolls its lurch/spit rhythm
      }
    }

    if (ai.aggro && !ai.spotted) {
      ai.spotted = 1;
      emit(state, 'enemy_spotted', e.id);
    }
    if (!ai.aggro) {
      e.state = 'idle';
      // Re-arm the call-out only after it has genuinely lost the plot, so a
      // successful hide followed by a blown one is announced, and jitter isn't.
      if (ai.calm > RENOTICE_CALM_TICKS) ai.spotted = 0;
      else ai.calm = ai.calm >= 1 ? ai.calm + 1 : 1;
      // Idle head sweep, so the blind arc drifts instead of being nailed to the
      // floor layout. Costs one seeded roll every couple of seconds.
      if (ai.scanT >= 1) ai.scanT--;
      else {
        ai.scanT = SCAN_DWELL + Math.floor(roll(state) * SCAN_JITTER);
        ai.scanI = (ai.scanI >= 0 ? ai.scanI + 1 : 0) % SCAN_ORDER.length;
        e.facing = SCAN_ORDER[ai.scanI];
      }
      continue;
    }
    if (!r.alive) {
      e.state = 'pause';
      continue;
    }

    // Hunt target: the robot while it is visible, otherwise the last place it
    // was seen. Ducking behind cover buys ground and time, not teleportation.
    const target: Vec = sees ? r.pos : { x: ai.lkx, y: ai.lky };
    const toTarget: Vec = { x: target.x - e.pos.x, y: target.y - e.pos.y };
    e.facing = dominantDir(toTarget);

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
    if (ai.spitIn > 0) ai.spitIn--;
    // Only wind up a throw at something it can actually see. A blind machine
    // firing paper through masonry is both silly and unanswerable; holding the
    // cooldown at 0 means it fires the instant the robot leans back out.
    if (ai.spitIn <= 0 && sees) {
      ai.tel = SPIT_TELEGRAPH_TICKS;
      continue;
    }

    // lurch-chase rhythm
    if (ai.moving === 1) {
      e.state = 'chase';
      const aim = norm(toTarget);
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
