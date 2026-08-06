/**
 * ONE area-of-effect resolver, two triggers: the boss's mortars and the robot's
 * rockets. Both land here.
 *
 * Keeping it single is not tidiness — it is the only way the red circle can be
 * honest. A mortar that resolved its own damage and a rocket that resolved its
 * own damage would drift the moment either was tuned, and the drift would show
 * up as "I was outside the circle and it still killed me", which is the one
 * failure this whole subsystem exists to avoid. Radius means the same thing to
 * everything that can explode, or it means nothing.
 *
 * Factions:
 *   'enemy'  — hurts the robot AND every non-boss shootable in range, sparing
 *              only the source. A boss that shreds its own adds is funny, and
 *              once the player has seen it happen they start baiting it, which
 *              turns a damage number into a tactic.
 *   'robot'  — hurts hostiles, furniture, and THE ROBOT. Self-damage is the
 *              tax on the funniest weapon in the game; see projectiles.ts for
 *              the two guard rails that keep it a joke rather than a suicide.
 */
import type { EntityKind, SimState, Vec } from '../../../shared/types';
import { ROBOT_R, aiOf, emit, radiusOf } from './internal';
import type { RobotScratch } from './internal';
import { dist, moveCircle, norm } from './physics';
import { damageRobot } from './robot';

/**
 * Everything a blast can chew on. Deliberately the same set bolts use — a mop
 * caught in a mortar is exactly as shreddable as a mop caught by a bolt, and
 * the day these two lists disagree is the day the chair becomes invincible to
 * one weapon for no reason anybody can see.
 */
export const SHOOTABLE: ReadonlySet<EntityKind> = new Set([
  'fusedPrinter',
  'fusedShredder',
  'printerInnocent',
  'mop',
  'chair',
]);

/**
 * Inside this fraction of the radius you eat the whole thing; outside it, half.
 * A single hard edge at `radius` is what the player is promised and what the
 * test checks — the falloff only decides how MUCH, never whether. Two bands
 * rather than a smooth curve because the player has to be able to learn it by
 * being hit twice, and "the middle is worse" is learnable.
 */
const CORE_FRACTION = 0.6;

/** Base shove out of a blast, px. The knockback IS the comedy; see rockets. */
const BLAST_KNOCK_PX = 14;

export interface BlastOpts {
  /** Multiplier on damage dealt to the ROBOT only (rockets halve their own). */
  selfScale?: number;
  /** Multiplier on the shove the robot takes (rockets double it). */
  knockScale?: number;
  /** False = the robot is shoved but takes NO damage. The rocket arming
   *  distance rides on this: a warhead that went off in your face has not
   *  travelled far enough to have armed, so it pushes you over instead. */
  armRobot?: boolean;
}

/** Damage at a given distance from the centre, or 0 when outside the radius. */
function falloff(d: number, radius: number, damage: number): number {
  if (d > radius) return 0;
  return d <= radius * CORE_FRACTION ? damage : Math.max(1, Math.round(damage / 2));
}

/**
 * Detonate at `pos`. Returns the number of things hit (the mortar_impact
 * payload, and what audio scales its boom by).
 *
 * `sourceId` is spared for enemy blasts. Bosses are spared from enemy blasts
 * outright — one shredder does not shred another, and there is only ever one.
 */
export function explode(
  state: SimState,
  scratch: RobotScratch,
  pos: Vec,
  radius: number,
  damage: number,
  faction: 'enemy' | 'robot',
  sourceId: string,
  opts?: BlastOpts,
): number {
  let hits = 0;
  const r = state.robot;

  // Entities first, so a blast that kills the robot still resolves what it
  // killed on the way — the death card and the boom should agree.
  for (const e of state.entities) {
    if (e.dead || e.hp === undefined || !SHOOTABLE.has(e.kind)) continue;
    if (faction === 'enemy') {
      if (e.id === sourceId) continue;
      if (e.kind === 'fusedShredder') continue; // the boss is immune to its own weather
    }
    // Body radius, not a point: a 13px boss clipped by the rim of a circle is
    // clipped by it. Anything else would make the big target the safe one.
    const d = dist(pos, e.pos);
    if (d > radius + radiusOf(e)) continue;
    const dmg = falloff(Math.max(0, d - radiusOf(e)), radius, damage);
    if (dmg <= 0) continue;
    e.hp -= dmg;
    // Your own ordnance announces you, exactly as a bolt does. Enemy blasts
    // deliberately do NOT: the boss shelling its own dormant printers must not
    // stand them up early and spend the phase-2 beat before it has been earned.
    if (faction === 'robot') aiOf(e).aggro = 1;
    emit(state, 'enemy_hit', e.id);
    hits++;
    if (e.hp <= 0) {
      e.hp = 0;
      e.dead = true;
      e.state = 'dead';
      emit(state, 'enemy_death', e.id);
    }
  }

  if (r.alive) {
    // Same rule as every other body: the robot is caught when its CIRCLE
    // overlaps the blast, not when its centre does. A toe inside the ring is
    // inside the ring — that is what the ring on screen is promising.
    const dEff = Math.max(0, dist(pos, r.pos) - ROBOT_R);
    if (dEff <= radius) {
      // The shove lands whether or not the damage does. i-frames are a mercy on
      // the health bar, not a force field: a robot standing in a detonation and
      // not moving an inch reads as the explosion having missed, which is a lie
      // told by an invisible cooldown. The push is also what saves it — being
      // thrown clear of the second circle is the good kind of luck.
      const off = norm({ x: r.pos.x - pos.x, y: r.pos.y - pos.y });
      // Dead centre has no "away". Pick one rather than silently not shoving —
      // a perfect hit must not be the one that looks like a miss.
      const away = off.x === 0 && off.y === 0 ? { x: 1, y: 0 } : off;
      const shove = BLAST_KNOCK_PX * (opts?.knockScale ?? 1) * (r.chips.includes('TOUGH') ? 0.5 : 1);
      moveCircle(state.solid, r.pos, away.x * shove, away.y * shove, ROBOT_R);
      if (opts?.armRobot !== false) {
        const dmg = Math.max(1, Math.round(falloff(dEff, radius, damage) * (opts?.selfScale ?? 1)));
        if (damageRobot(state, scratch, dmg, 'blast', 'blast')) hits++;
      }
    }
  }

  emit(state, 'mortar_impact', undefined, {
    radius: Math.round(radius),
    hit: hits,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
  });
  return hits;
}
