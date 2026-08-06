/**
 * THE SHREDDER — the floor-6 boss (`fusedShredder`).
 *
 * An industrial cross-cut shredder bolted to a floor-scrubber chassis. Kept out
 * of enemies.ts because it is not a bigger printer: it never loses aggro, it
 * fights at RANGE through telegraphed mortars rather than by touching you, and
 * its phase is derived from hp every single tick so the fight and the feed can
 * never desync.
 *
 * The rhythm is deliberately the printer's rhythm made enormous. A printer
 * telegraphs for 18 ticks and spits one page; the shredder winds up for 24 and
 * throws five circles. A player who learned to read a printer already knows how
 * to read this — which is what makes the boss the exam rather than a new game.
 *
 * It also MAKES more of itself — one printer every five seconds for as long as
 * it lives, out of its own body, capped. That is the half of the fight the
 * mortars do not cover: circles are a question about where to stand, and adds
 * are a question about what to shoot, which is the only question the operator
 * answers by naming something out loud. See "the print run" below.
 *
 * THE CENTRAL TUNING FACT: every phase speed is below the robot's 55px/s.
 * Running is always a valid answer. That is not mercy — it is what makes
 * standing and fighting a DECISION instead of the only thing on offer.
 */
import type { Entity, SimState, Vec } from '../../../shared/types';
import { TILE } from '../../../shared/types';
import {
  BOSS_R,
  CONTACT_RANGE,
  ENEMY_R,
  KNOCKBACK_PX,
  ROBOT_R,
  aiOf,
  emit,
  isLiveHostile,
  roll,
  wakeMachine,
} from './internal';
import type { RobotScratch } from './internal';
import { DT, dist, dominantDir, isSolidTile, moveCircle, norm } from './physics';
import { MORTAR_MIN_FUSE, spawnMortar } from './mortar';
import { bossAdd } from './floors';
import { damageRobot } from './robot';

// ---------------------------------------------------------------- tuning

/**
 * Default hp. The FLOOR owns the real number (floors.ts) — this is the fallback
 * bossPhase() divides by when a spawn forgot maxHp.
 *
 * Was 24, and 24 was measured to be a non-fight: a robot arriving on floor 6
 * with ZAP (damage 2, 16-tick cooldown) emptied it in TWELVE bolts — 202 ticks,
 * 3.4 seconds, one volley fired, phase 3 crossed and won inside the same
 * breath. The three-phase structure existed in the code and never on the
 * screen. 96 is that number ×4 and it buys the phases back; see floors.ts,
 * which owns the hp the shredder actually spawns with and carries the
 * measurement.
 */
export const BOSS_HP = 96;

/**
 * Chassis speed by phase. Always under the robot's 55 — see the file header.
 * Phase 3's 36 is the charge: still outrunnable, but only if you commit to
 * running instead of trading shots, which is the lesson phase 3 is teaching.
 */
const BOSS_SPEED = [9, 18, 36];
/** Mortars per volley by phase. One circle teaches; five circles examine. */
const VOLLEY_SHOTS = [1, 3, 5];
/** Fuse by phase. Never below MORTAR_MIN_FUSE — spawnMortar clamps, but the
 *  numbers are written honestly here so a tuning pass can see the floor. */
const VOLLEY_FUSE = [100, 80, 65];
/**
 * VOLLEY TO VOLLEY, by phase (~2.5s / 2.3s / 2.2s). Note this is the whole
 * cycle, wind-up and firing pose included — see how ai.fireCd is set. Measuring
 * the cadence from the end of one animation to the start of the next made the
 * fight a third slower than the beat sheet asked for, and the drift was
 * invisible in the source because both numbers looked right on their own.
 */
const VOLLEY_CD = [150, 140, 132];
/**
 * Fuse stagger WITHIN a volley. Five circles that detonate on the same tick are
 * one loud bang; five that walk apart by 5 ticks are a drumroll you can hear
 * yourself running through, and each one is separately dodgeable.
 */
const VOLLEY_FUSE_STEP = 5;
/**
 * Wind-up before every volley. The tell has to precede the circle, not
 * accompany it — audio and render both hang off `state === 'wind'`, and a boss
 * that paints its circles on the same tick it decides to has no readable
 * intent, only outcomes.
 */
const WIND_TICKS = 24;
/** Ticks the firing pose is held after a volley, so the throw is a motion. */
const FIRE_TICKS = 10;

/**
 * Impact scatter, px. Without it a stationary robot is hit dead centre every
 * single time, which turns "stand still and eat it" into a deterministic death
 * rather than a bad choice. ±8 is under the blast radius: standing still is
 * still wrong, just not arithmetically certain.
 */
const SCATTER_PX = 8;

/**
 * Phase 3 leads the robot's velocity — it aims where you are GOING. This is the
 * mechanic that teaches kiting, because the counter is to change direction
 * rather than to move faster. Fractional rather than perfect: a boss with a
 * perfect solution to your velocity is not a boss, it is arithmetic.
 */
const LEAD_FRACTION = 0.75;

// ------------------------------------------------------------ the print run
//
// The shredder MAKES adds. It used to stand four pre-placed printers up on the
// phase-2 frame and then never produce another for the rest of the fight, which
// made the room's pressure a step function with exactly one step in it: survive
// the wave, and the back half of the fight was quieter than the front. At ×4 hp
// that back half is most of the fight.
//
// One every five seconds, out of the boss's own body, for as long as it lives.
// It is a tax on hesitation with a visible source — the answer to "where do
// they keep coming from" is standing in the middle of the room, and the answer
// to "how do I make it stop" is the same thing the floor already wanted.

/**
 * Ticks between prints, BY PHASE. All 300 (5s) — the flat cadence is what was
 * asked for and it is the one a player can actually feel and count against.
 *
 * The ramp is written as an array rather than a constant because [300, 240,
 * 200] is the obvious next tuning pass and it should be a one-line edit: the
 * fight already escalates on three other axes (speed, volley size, leading),
 * and a fourth may be one too many. Measure before reaching for it.
 */
export const SPAWN_EVERY = [300, 300, 300];
/**
 * Hard cap on CONCURRENT adds. Not a nicety — 96 hp is roughly a 45-second
 * fight, and uncapped 5-second prints put twenty machines in a room built for a
 * duel: unreadable, unsurvivable, and past ~25 entities the per-tick separation
 * pass starts costing real time.
 *
 * Five is the number where "leave them, shoot the big one" is still playable
 * advice and "clear them first" is still a losing one, which is the decision
 * the adds exist to pose.
 */
export const MAX_ADDS = 5;
// A beat that lands while already at the cap is DROPPED, never banked. Adds
// must not be able to queue up behind the cap and then arrive together as one
// wave the moment the player finally earns a kill.
/** Where a new add appears, px from the boss centre. Boss body 13 + add body 9
 *  = 22, so 44 is a full body-width of daylight — it walks out, it doesn't
 *  materialise wedged into its parent and get shoved free by separateHostiles. */
const SPAWN_RING = 44;
/** Each rejected candidate steps one ring further out. A boss backed into a
 *  stanchion has no clear arc at 44 and plenty at 80. */
const SPAWN_RING_STEP = 12;
/** Candidate arcs tried per print before the beat is dropped. */
const SPAWN_TRIES = 8;
/**
 * The golden angle. Successive prints land ~137° apart, so the boss is
 * surrounded rather than followed by a conga line down one bearing — and it
 * never repeats a bearing for hundreds of spawns.
 *
 * DERIVED FROM A COUNTER, NOT FROM roll(state), and that is deliberate: the
 * mortar scatter is the only consumer of the rng in this file, and a spawner
 * that also drew from it would make every circle's landing point a function of
 * how many machines happened to have fit in a wall three seconds earlier. The
 * fight would still be deterministic and it would be untunable.
 */
const SPAWN_TURN = Math.PI * (3 - Math.sqrt(5));
/** Extra turn per retry within one print, so the eight candidates fan out
 *  instead of creeping around the same bearing. */
const SPAWN_TRY_TURN = 0.9;
/**
 * No add may appear closer than this to the robot. A machine that materialises
 * inside contact range is a hit the player had no way to avoid, and the whole
 * contract of this floor is that everything is telegraphed.
 */
export const SPAWN_CLEAR_ROBOT = 72;

/** Contact damage reach, scaled for a 13px body rather than a 9px one. */
const BOSS_CONTACT = CONTACT_RANGE + BOSS_R - ENEMY_R;

/** The idle stretch between volleys, so wind-up + firing pose fit INSIDE the
 *  advertised cadence rather than being added on top of it. */
const restFor = (phase: 1 | 2 | 3): number =>
  Math.max(1, VOLLEY_CD[phase - 1] - WIND_TICKS - FIRE_TICKS);

// ---------------------------------------------------------------- phase

/**
 * Phase 1/2/3 DERIVED from hp, every tick, from nothing else.
 *
 * Stored phase state is how a boss ends up in its phase-3 pose firing phase-1
 * volleys after a heal, a rollback, or a debug command — three bugs that all
 * look like "the boss is broken" and none of which can happen if the number is
 * recomputed. `ai.phaseSeen` exists ONLY so the event fires once per crossing.
 */
export function bossPhase(e: Entity): 1 | 2 | 3 {
  const max = e.maxHp ?? BOSS_HP;
  const f = (e.hp ?? 0) / max;
  if (f > 0.66) return 1;
  if (f > 0.33) return 2;
  return 3;
}

// ---------------------------------------------------------------- step

export function stepBoss(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
  // Length captured up front for the same reason enemies.ts does it: anything
  // this loop appends must not also take a turn on the tick it appeared.
  for (let i = 0, n = state.entities.length; i < n; i++) {
    const e = state.entities[i];
    if (e.kind !== 'fusedShredder' || !isLiveHostile(e)) continue;
    const ai = aiOf(e);

    // It never loses aggro. A boss that forgets you the moment you step behind
    // a pillar is not a boss — it is a large printer with a memory leak, and
    // hiding would beat the fight outright.
    ai.aggro = 1;
    ai.hunting = 1;

    const phase = bossPhase(e);
    if (ai.phaseSeen !== phase) {
      const prev = ai.phaseSeen > 0 ? ai.phaseSeen : 0;
      ai.phaseSeen = phase;
      emit(state, 'boss_phase', e.id, { phase });
      // A phase change interrupts whatever it was doing. The new cadence starts
      // from the roar, not from the leftovers of the old one.
      ai.wind = 0;
      ai.fireT = 0;
      ai.volley = 0;
      ai.fireCd = Math.round(restFor(phase) / 2); // the roar buys you half a beat
      // ...and every ESCALATION prints on the roar itself, so the phase change
      // is a thing that happens in the room and not only in the hp bar. The
      // first sighting (prev 0) deliberately does not: the doors opening on a
      // boss that immediately makes a friend gives the operator nothing to be
      // wrong about, and being wrong about this room is the first beat it has.
      ai.spawnCd = prev === 0 ? SPAWN_EVERY[phase - 1] : 0;
    }

    if (!r.alive) {
      e.state = 'pause';
      continue;
    }

    // --- the print run ----------------------------------------------------
    // The metronome runs whether or not there is room for the result: at the
    // cap the beat is dropped, so a fight the player is winning never repays
    // them with a wave. Appending to state.entities mid-tick is safe by
    // contract — both this loop and stepEnemies capture their length up front,
    // so a machine printed this tick takes its first turn on the next one.
    if (ai.spawnCd > 0) ai.spawnCd--;
    else {
      ai.spawnCd = SPAWN_EVERY[phase - 1];
      if (countAdds(state) < MAX_ADDS) spawnAdd(state, e);
    }

    const toRobot: Vec = { x: r.pos.x - e.pos.x, y: r.pos.y - e.pos.y };
    e.facing = dominantDir(toRobot);

    // --- the volley clock -------------------------------------------------
    // wind → fire → recover → count down → wind. One state machine, and the
    // pose the render reads is the same variable the sim branches on.
    if (ai.wind > 0) {
      ai.wind--;
      e.state = 'wind';
      // It plants to throw. A boss that walks while winding up gives the player
      // two problems at once and neither of them is readable.
      if (ai.wind === 0) {
        fireVolley(state, e, phase);
        ai.fireT = FIRE_TICKS;
        ai.fireCd = restFor(phase);
        e.state = 'fire';
      }
      continue;
    }
    if (ai.fireT > 0) {
      ai.fireT--;
      e.state = 'fire';
      continue;
    }
    if (ai.fireCd > 0) ai.fireCd--;
    else {
      ai.wind = WIND_TICKS;
      e.state = 'wind';
      continue;
    }

    // --- the walk ---------------------------------------------------------
    // No lurch-pause rhythm: the printer's stop-start is menace at walking
    // pace, and on something this size it reads as a stall. The shredder just
    // comes, slowly, and the drama lives in the volley clock instead.
    e.state = 'chase';
    const aim = norm(toRobot);
    const speed = BOSS_SPEED[phase - 1];
    moveCircle(state.solid, e.pos, aim.x * speed * DT, aim.y * speed * DT, BOSS_R);

    // --- contact ----------------------------------------------------------
    // Touching it is bad but survivable; the mortars are the fight. The shove
    // is doubled because being hit by a floor scrubber the size of a desk
    // should move you, and being thrown clear is often the mercy.
    if (dist(e.pos, r.pos) <= BOSS_CONTACT) {
      const push = norm({ x: r.pos.x - e.pos.x, y: r.pos.y - e.pos.y });
      if (damageRobot(state, scratch, 1, 'shredder', 'contact')) {
        const kb = (r.chips.includes('TOUGH') ? KNOCKBACK_PX / 2 : KNOCKBACK_PX) * 2;
        moveCircle(state.solid, r.pos, push.x * kb, push.y * kb, ROBOT_R);
      }
    }
  }
}

// ---------------------------------------------------------------- adds

/** Live hostiles that are not the boss. The cap counts BODIES in the room, not
 *  prints made — anything a floor authored by hand counts against it too, so a
 *  future arena with sleepers in the corners cannot be doubled up on. */
function countAdds(state: SimState): number {
  let n = 0;
  for (const e of state.entities) if (isLiveHostile(e) && e.kind !== 'fusedShredder') n++;
  return n;
}

/**
 * Would an r-radius body at `p` be clear of the walls?
 *
 * Deliberately CONSERVATIVE: it rejects a spot if any tile in the body's
 * bounding box is solid, where the real collision test (moveCircle) only cares
 * about tiles the circle actually overlaps. That refuses a handful of legal
 * spots tucked into wall corners, which costs nothing — there are eight
 * candidates per print and an arena full of open floor — and in exchange it
 * cannot ever wedge a machine into masonry, where it would spend the fight
 * grinding against a wall it can see the robot through.
 */
function bodyClear(solid: boolean[][], p: Vec, r: number): boolean {
  const minTx = Math.floor((p.x - r) / TILE);
  const maxTx = Math.floor((p.x + r) / TILE);
  const minTy = Math.floor((p.y - r) / TILE);
  const maxTy = Math.floor((p.y + r) / TILE);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (isSolidTile(solid, tx, ty)) return false;
    }
  }
  return true;
}

/**
 * Print one add. Returns false when no legal spot was found, in which case the
 * beat is simply lost — this is called once every SPAWN_EVERY ticks and the
 * next one is five seconds away.
 *
 * The position is a function of a COUNTER (`ai.spawnN`) and nothing else: a
 * golden-angle arc around the boss, stepped outward on each rejection. No
 * roll(state), for the reason SPAWN_TURN spells out, and no findPath — that
 * module keeps global scratch and is emphatically not reentrant, so calling it
 * from inside a spawn that happens inside the entity loop would corrupt
 * whatever route the robot was mid-plan on.
 *
 * Three rejections, all of which matter:
 *  - walls, or the add is born grinding into masonry;
 *  - within SPAWN_CLEAR_ROBOT of the robot, or it is an unavoidable hit;
 *  - inside another live body, because separateHostiles resolves overlap by
 *    shoving, and a machine shoved out of its parent on frame one reads as a
 *    physics bug rather than as a machine.
 */
function spawnAdd(state: SimState, boss: Entity): boolean {
  const bai = aiOf(boss);
  // Increments even on failure: ids stay unique for the whole floor, and a
  // bearing that had no room does not get retried unchanged five seconds later.
  const n = (bai.spawnN >= 1 ? bai.spawnN : 0) + 1;
  bai.spawnN = n;
  for (let k = 0; k < SPAWN_TRIES; k++) {
    const a = n * SPAWN_TURN + k * SPAWN_TRY_TURN;
    const rad = SPAWN_RING + k * SPAWN_RING_STEP;
    const p: Vec = { x: boss.pos.x + Math.cos(a) * rad, y: boss.pos.y + Math.sin(a) * rad };
    if (!bodyClear(state.solid, p, ENEMY_R)) continue;
    if (dist(p, state.robot.pos) < SPAWN_CLEAR_ROBOT) continue;
    let crowded = false;
    for (const o of state.entities) {
      if (o === boss || !isLiveHostile(o)) continue;
      if (dist(p, o.pos) < ENEMY_R * 2) {
        crowded = true;
        break;
      }
    }
    if (crowded) continue;

    const add = bossAdd(`add_${n}`, p);
    // AWAKE, and already looking for you. An add that spawns idle would spend
    // its notice cone deciding whether the thing shooting at the boss it just
    // came out of is worth its attention.
    wakeMachine(add);
    // Pre-set so stepEnemies does not fire its own enemy_spotted for every
    // print. One call-out for the first machine off the line is the beat
    // ("IT MAKES MORE OF THEM"); one every five seconds is a nag, and the
    // director's threat call-out already re-arms on a growing count.
    aiOf(add).spotted = 1;
    state.entities.push(add);
    if (n === 1) emit(state, 'enemy_spotted', add.id);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- volley

/**
 * Throw one volley. Two roll(state) draws per shell (x and y scatter) and not
 * one more, so the rng stream advances by a count derived only from the phase.
 *
 * Aim is the robot's CURRENT position in phases 1–2. Leading a 0.9px/tick robot
 * behind a 1.5-second telegraph would be unanswerable: the player would watch
 * the circle appear exactly where they were about to be with no way to have
 * known. Phase 3 earns the lead by having taught the circle twice already.
 */
function fireVolley(state: SimState, e: Entity, phase: 1 | 2 | 3): void {
  const r = state.robot;
  const shots = VOLLEY_SHOTS[phase - 1];
  const baseFuse = Math.max(MORTAR_MIN_FUSE, VOLLEY_FUSE[phase - 1]);
  for (let s = 0; s < shots; s++) {
    const fuse = baseFuse + s * VOLLEY_FUSE_STEP;
    const lead = phase === 3 ? LEAD_FRACTION * fuse * DT : 0;
    const target: Vec = {
      x: r.pos.x + r.vel.x * lead + (roll(state) * 2 - 1) * SCATTER_PX,
      y: r.pos.y + r.vel.y * lead + (roll(state) * 2 - 1) * SCATTER_PX,
    };
    spawnMortar(state, e.pos, target, fuse);
  }
}
