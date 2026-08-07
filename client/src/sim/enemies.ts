/**
 * Enemy AI (fusedPrinter) + hazards (cable). All frozen-gated by the caller.
 * Printer: idles and sweeps its head until it SEES the robot (or gets shot),
 * then lurch-chases (move/pause menace rhythm) and periodically telegraphs +
 * spits paper. Losing sight does not switch it off — it hunts the last place
 * it saw the robot for a few seconds first.
 */
import type { Dir, Entity, SimState, Vec } from '../../../shared/types';
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
  movingQuietly,
  isLiveHostile,
  kindWeight,
  radiusOf,
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
/**
 * Once hunting it keeps the robot while it can still see it out to here.
 * A machine that forgets the moment you back off one step is not menacing;
 * one with no leash at all follows you across an empty hall forever.
 *
 * THIS LEASH ONLY APPLIES TO A MACHINE THAT NOTICED YOU ITSELF. See ai.called.
 */
const HUNT_SIGHT = 220;
/** Ticks of pursuing the last known position after sight breaks. 3s: cover
 *  really works, but it is not an off-switch you flick behind a pillar. */
const MEMORY_TICKS = 180;
/** How close to the last known position counts as having got there. Only a
 *  called machine ever asks — see the leash in stepEnemies. */
const LAST_KNOWN_ARRIVE = 12;
/** Ticks fully calm before enemy_spotted may fire again. Without it, a robot
 *  dancing on the edge of cover machine-guns the director with call-outs. */
const RENOTICE_CALM_TICKS = 150;
/** Idle head sweep: ticks per facing, + up to SCAN_JITTER of seeded jitter.
 *  A machine frozen mid-stare forever would give every floor a permanent,
 *  invisible blind side — learnable only by dying in it. */
const SCAN_DWELL = 130;
const SCAN_JITTER = 90;
const SCAN_ORDER: readonly Dir[] = ['down', 'right', 'up', 'left'];

/**
 * Max px a body may be shoved by its neighbours in one tick. Small on purpose:
 * separation is a crowd behaviour, not a physics engine. Anything strong enough
 * to resolve a pile-up in a single frame is also strong enough to fling a
 * printer through a doorway it was never going to fit through.
 */
const SEPARATE_PUSH = 1.2;

/**
 * Keep bodies out of each other. Without this a mob collapses to a single pixel
 * — moveCircle only resolves against TILES, so three printers chasing the same
 * robot end up perfectly stacked, look like one printer, and deal three times
 * the contact damage from a footprint the player cannot read.
 *
 * TWO things here are load-bearing and both are easy to get wrong:
 *
 * 1. Positions come from a SNAPSHOT taken once, before anything moves. Reading
 *    live positions makes the forces asymmetric — the first body in the array
 *    is pushed by everyone's old position, the last by everyone's new one — so
 *    the crowd forms a conga line and its shape depends on insertion order,
 *    which is to say on which floor file happened to list them first.
 * 2. Heavier things push harder and move less (kindWeight). The boss walking
 *    through its own adds should scatter them; the adds should not be able to
 *    bump the boss off its line, or four printers become a shield.
 */
function separateHostiles(state: SimState): void {
  const live: Entity[] = [];
  for (const e of state.entities) if (isLiveHostile(e)) live.push(e);
  if (live.length < 2) return;
  const snap = live.map((e) => ({ x: e.pos.x, y: e.pos.y }));
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    const wa = Math.max(1, kindWeight(a));
    let px = 0;
    let py = 0;
    for (let j = 0; j < live.length; j++) {
      if (i === j) continue;
      const b = live[j];
      let dx = snap[i].x - snap[j].x;
      let dy = snap[i].y - snap[j].y;
      let d = Math.hypot(dx, dy);
      const want = radiusOf(a) + radiusOf(b);
      if (d >= want) continue;
      if (d < 0.001) {
        // Perfectly stacked: there is no gradient to follow, so pick a side by
        // array index. Deterministic, opposite for the two bodies involved, and
        // one tick later the real gradient takes over.
        dx = i < j ? -1 : 1;
        dy = 0;
        d = 1;
      }
      const overlap = (want - d) / want;
      // Mass split: each body takes the share of the correction proportional to
      // the OTHER one's weight, so the pair separates by the same total amount
      // however lopsided they are.
      const share = (2 * Math.max(1, kindWeight(b))) / (wa + Math.max(1, kindWeight(b)));
      px += (dx / d) * overlap * share;
      py += (dy / d) * overlap * share;
    }
    if (px === 0 && py === 0) continue;
    const l = Math.hypot(px, py);
    const k = (SEPARATE_PUSH * Math.min(1, l)) / l;
    moveCircle(state.solid, a.pos, px * k, py * k, radiusOf(a));
  }
}

export function stepEnemies(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
  // Length captured up front: the boss pushes its adds into `state.entities`
  // mid-tick, and `for…of` WOULD visit them on the same tick — a printer that
  // stands up and immediately takes a full turn, before it has been rendered.
  for (let i = 0, n = state.entities.length; i < n; i++) {
    const e = state.entities[i];
    // Covers the kind test, the corpse test, and dormant-as-scenery in one.
    if (!isLiveHostile(e)) continue;
    // THE KIND DISPATCH. Everything below this line is printer behaviour —
    // notice cone, lurch-chase, paper spit. Without this line a shredder would
    // inherit all of it the moment one woke up: a boss that scans idly, forgets
    // you behind a pillar and throws A4 at you. stepBoss owns them instead.
    if (e.kind === 'fusedShredder') continue;
    const ai = aiOf(e);
    const toRobot: Vec = { x: r.pos.x - e.pos.x, y: r.pos.y - e.pos.y };
    const d = Math.hypot(toRobot.x, toRobot.y);

    // Sneaking (careful order, + a ~6s linger after it completes) is QUIET —
    // half notice range. Payoff of "sneak to X": don't wake the machine.
    const notice = movingQuietly(state, scratch) ? AGGRO_RANGE * SNEAK_AGGRO_FACTOR : AGGRO_RANGE;

    // LINE OF SIGHT gates everything. Distance-only aggro meant the floor-3
    // printer woke the instant the robot stepped off the lift two rooms away,
    // which deleted route choice, cover and stealth in one go: there was no
    // way to play the floor, only a machine that always knew. Walls hide the
    // robot now. Getting shot still wakes it (projectiles.ts sets ai.aggro).
    const sees = r.alive && !losBlocked(state.solid, e.pos, r.pos);

    let noticed = false;
    if (!ai.aggro && sees) {
      const f = dirToVec(e.facing ?? 'down');
      const ahead = d > 0.001 && (toRobot.x * f.x + toRobot.y * f.y) / d >= NOTICE_CONE_COS;
      if (d <= (ahead ? notice : notice * REAR_NOTICE_FACTOR)) {
        ai.aggro = 1;
        noticed = true;
      }
    }

    // A fresh hunt seeds the memory — whether it started from the cone above or
    // from a bolt in the back, which sets ai.aggro directly and would otherwise
    // be forgotten on the very next tick if the shooter was out of sight.
    if (ai.aggro && !ai.hunting) {
      ai.hunting = 1;
      // Aggro this machine did not set for ITSELF was set FOR it: wakeMachine,
      // from the boss's phase-two call or from a bolt landing in its back. That
      // is a machine that has been TOLD where you are, and it is a different
      // animal from one that happened to look your way — see the leash below.
      ai.called = noticed ? 0 : 1;
      ai.mem = MEMORY_TICKS;
      ai.lkx = r.pos.x;
      ai.lky = r.pos.y;
      ai.calm = 0;
    }
    if (ai.hunting) {
      // THE LEASH. A called machine does not have one — and that is the whole
      // of the "small printers never attack" bug.
      //
      // Two clocks used to be able to switch a hunting machine off: HUNT_SIGHT
      // 220px, and MEMORY_TICKS once the ray broke. Both are tuned for a ROOM.
      // The boss arena is 480×256 with stanchions down the middle, and the adds
      // are printed out of the boss in the centre of it, so an add pointed at a
      // robot two lanes away is out of leash range on the tick it is born, and
      // the first pillar between them starts a three-second countdown it cannot
      // survive — 180 ticks of a 18.75px/s lurch is FIFTY-SIX PIXELS, nowhere
      // near the last place it saw anything. So it reverted to `idle`, which is
      // not merely calm: it stops moving entirely, and re-arms only inside
      // AGGRO_RANGE 120 with the robot in its notice cone. Nothing in that
      // fight brings the robot there. Measured on the boss floor: of the adds
      // still alive after 40 seconds, ZERO were still hunting.
      //
      // So: a machine that noticed you itself keeps both clocks, exactly as
      // before — walk away or duck behind something and it loses interest. A
      // machine that was TOLD (printed by the boss, or shot in the back) keeps
      // coming. Cover still buys you everything it should, because the thing
      // has to physically walk to where you were and then to where you are, at
      // a third of your speed. It just no longer switches itself off and stands
      // in an empty room being scenery.
      if (sees && (ai.called === 1 || d <= HUNT_SIGHT)) {
        ai.mem = MEMORY_TICKS; // eyes on: memory stays topped up
        ai.lkx = r.pos.x;
        ai.lky = r.pos.y;
      } else if (ai.called === 1) {
        // Blind, and it does not time out. It walks to where you were; if it
        // gets there and you are not, it picks the trail up rather than
        // stopping on the spot with the job half done.
        if (Math.hypot(ai.lkx - e.pos.x, ai.lky - e.pos.y) <= LAST_KNOWN_ARRIVE) {
          ai.lkx = r.pos.x;
          ai.lky = r.pos.y;
        }
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
          id: `paper_${state.nextId++}`,
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
      if (damageRobot(state, scratch, 1, 'enemy', 'contact')) {
        const kb = r.chips.includes('TOUGH') ? KNOCKBACK_PX / 2 : KNOCKBACK_PX;
        moveCircle(state.solid, r.pos, push.x * kb, push.y * kb, ROBOT_R);
      }
    }
  }
  // After every body has taken its own turn, never during: a crowd correction
  // applied mid-loop would be an input to the moves still to come.
  separateHostiles(state);
}

export function stepHazards(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
  if (!r.alive) return;
  for (const e of state.entities) {
    if (e.kind !== 'cable' || e.dead) continue;
    if (dist(e.pos, r.pos) <= CABLE_RADIUS) {
      // damageRobot applies the 20-tick zap stun for source 'cable'
      damageRobot(state, scratch, 1, 'cable', 'hazard', { hazard: 'zap' });
    }
  }
}
