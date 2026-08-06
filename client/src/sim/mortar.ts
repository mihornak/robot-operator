/**
 * Telegraphed ground strikes — the red circles.
 *
 * A Mortar is spawned with its impact point and its fuse ALREADY DECIDED, so
 * the circle on screen and the damage that lands are the same two numbers
 * rather than two systems that agree most of the time. The arcing shell the
 * boss throws alongside it is a separate, purely decorative Projectile: it
 * flies over the walls and hits nothing. That is not laziness — it is why the
 * telegraph is exact. A simulated shell can be deflected, clipped by a pillar,
 * or despawned, and every one of those outcomes orphans a circle that has
 * already promised the player where it was going to land.
 *
 * The circle is the contract. Everything here exists to keep it honest.
 */
import type { Mortar, SimState, Vec } from '../../../shared/types';
import { TILE, TILES_X, TILES_Y } from '../../../shared/types';
import { BASE } from '../../../shared/content';
import { ROBOT_R, emit } from './internal';
import type { RobotScratch } from './internal';
import { DT, solidAtPx } from './physics';
import { explode } from './blast';

// ---------------------------------------------------------------- tuning

/** Blast radius of a boss mortar, px. See MORTAR_MIN_FUSE for why it is this. */
export const MORTAR_RADIUS = 26;
/** Damage at the core; halved at the rim (blast.ts owns the falloff). */
export const MORTAR_DAMAGE = 2;

/**
 * THE TUNING INVARIANT.
 *
 * A robot standing dead centre must be able to physically leave the circle in
 * the time the circle gives it. Distance to clear = radius + its own body;
 * distance it can cover = speed × DT × ticks. Break this and the telegraph is
 * a lie the player cannot act on however well they read it — the worst failure
 * available to this system, because it looks exactly like unfair difficulty.
 *
 * MORTAR_PANIC_TICKS is the reaction budget the sim guarantees: the window
 * between the point-blank reflex noticing the circle and the detonation. Every
 * fuse the boss uses must be at least this, and mortarInvariantOk() is checked
 * by the selftest rather than trusted to this comment.
 */
export const MORTAR_PANIC_TICKS = 40;
/** No mortar may ever be fired with a shorter fuse than the reflex needs. */
export const MORTAR_MIN_FUSE = MORTAR_PANIC_TICKS;

/**
 * Mortars with less fuse than this are NOT worth routing around. A circle 200ms
 * from going off is a crater, not an obstacle: detouring around it burns the
 * exact second the robot needed to be somewhere else, and the A* grid it would
 * be baked into refreshes every 20 ticks anyway. Below this the point-blank
 * reflex handles it, which is the right tool — local, instant, unconditional.
 */
export const ZONE_ROUTE_MIN_FUSE = 15;

/**
 * How close to a live circle the point-blank reflex panics. Slightly wider than
 * the blast so the robot leaves rather than tiptoes along the rim, where a
 * knockback or a body-block would put it back inside.
 */
export const ZONE_PANIC_PAD = 6;

/** True when the geometry still lets a cornered robot outrun its own circle. */
export function mortarInvariantOk(): boolean {
  return MORTAR_RADIUS + ROBOT_R <= BASE.speedPxS * DT * MORTAR_PANIC_TICKS;
}

// ---------------------------------------------------------------- spawning

/** The decorative shell that belongs to this mortar, so detonation can retire
 *  it. Same counter, two prefixes — no lookup table, no orphan. */
function shellIdFor(m: Mortar): string {
  return `shell_${m.id.slice('mortar_'.length)}`;
}

/**
 * Paint a circle and launch its (harmless) shell. `fuse` is clamped up to
 * MORTAR_MIN_FUSE: a caller that wants a faster shot is asking for a telegraph
 * the robot cannot answer, and quietly refusing is better than shipping a lie.
 *
 * The target is nudged out of walls, because a circle painted inside masonry is
 * a circle the player has to work out is not for them.
 */
export function spawnMortar(
  state: SimState,
  from: Vec,
  target: Vec,
  fuse: number,
  radius = MORTAR_RADIUS,
): Mortar {
  const n = state.nextId++;
  const safeFuse = Math.max(MORTAR_MIN_FUSE, Math.round(fuse));
  const t = clampToFloor(state, target);
  const m: Mortar = {
    id: `mortar_${n}`,
    target: t,
    from: { x: from.x, y: from.y },
    fuse: safeFuse,
    fuseMax: safeFuse,
    radius,
  };
  state.mortars.push(m);
  // The shell is timed to arrive exactly as the fuse expires — it is scenery
  // that has to agree with the clock, not a thing that decides anything.
  state.projectiles.push({
    id: `shell_${n}`,
    kind: 'shell',
    pos: { x: from.x, y: from.y },
    vel: { x: (t.x - from.x) / (safeFuse * DT), y: (t.y - from.y) / (safeFuse * DT) },
  });
  emit(state, 'mortar_launch', m.id, {
    radius: Math.round(radius),
    fuse: safeFuse,
    x: Math.round(t.x),
    y: Math.round(t.y),
  });
  return m;
}

/** Keep an impact point on the floor and out of walls. Falls back to nudging
 *  toward the map centre — every floor's middle is open by construction. */
function clampToFloor(state: SimState, p: Vec): Vec {
  const x = Math.min(Math.max(p.x, TILE), TILES_X * TILE - TILE);
  const y = Math.min(Math.max(p.y, TILE), TILES_Y * TILE - TILE);
  if (!solidAtPx(state.solid, x, y)) return { x, y };
  const cx = (TILES_X * TILE) / 2;
  const cy = (TILES_Y * TILE) / 2;
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    const nx = x + (cx - x) * t;
    const ny = y + (cy - y) * t;
    if (!solidAtPx(state.solid, nx, ny)) return { x: nx, y: ny };
  }
  return { x: cx, y: cy };
}

// ---------------------------------------------------------------- step

export function stepMortars(state: SimState, scratch: RobotScratch): void {
  if (state.mortars.length === 0) return;
  const keep: Mortar[] = [];
  for (const m of state.mortars) {
    m.fuse--;
    if (m.fuse > 0) {
      keep.push(m);
      continue;
    }
    // Retire the decoration in the same breath as the boom, so the shell can
    // never be seen sailing on past its own crater.
    const shell = shellIdFor(m);
    state.projectiles = state.projectiles.filter((p) => p.id !== shell);
    // faction 'enemy' with no source: the boss-immunity rule in blast.ts
    // already spares the shooter, and it is the only thing that fires these.
    explode(state, scratch, m.target, m.radius, MORTAR_DAMAGE, 'enemy', '');
  }
  state.mortars = keep;
}

// ---------------------------------------------------------------- queries
//
// Navigation and the panic reflex live in robot.ts/steering, so what they need
// from this subsystem is exported as pure questions rather than as state they
// have to understand. A caller that only ever asks "am I standing in one" can
// never accidentally depend on how the fuse is stored.

/**
 * A cheap signature of the live zone set that changes whenever a mortar is
 * added or removed. A route planned against a world with a different signature
 * was planned against a world that no longer exists — a stale penalty grid is
 * how the robot ends up steering around a crater that went off two seconds ago.
 *
 * Derived rather than stored on purpose: a counter kept in SimState is one more
 * thing that can be forgotten on a code path, and this cannot desync from the
 * list it describes because it IS the list.
 */
export function zoneEpoch(state: SimState): number {
  let sig = state.mortars.length * 1_000_003;
  for (const m of state.mortars) {
    if (m.fuse < ZONE_ROUTE_MIN_FUSE) continue;
    sig = (sig + m.fuseMax * 7919 + Math.round(m.target.x) * 31 + Math.round(m.target.y)) | 0;
  }
  return sig;
}

/** The circles worth planning a route around — see ZONE_ROUTE_MIN_FUSE. */
export function zonesToRoute(state: SimState): Mortar[] {
  return state.mortars.filter((m) => m.fuse >= ZONE_ROUTE_MIN_FUSE);
}

/**
 * The most urgent live circle `pos` is standing in, or null. Urgency is the
 * shortest fuse: with two circles overlapping, the one about to go off is the
 * one worth running from, and running from the other first gets you killed by
 * being right in the wrong order.
 */
export function zoneUnderfoot(state: SimState, pos: Vec, pad = ZONE_PANIC_PAD): Mortar | null {
  let worst: Mortar | null = null;
  for (const m of state.mortars) {
    const dx = pos.x - m.target.x;
    const dy = pos.y - m.target.y;
    if (Math.hypot(dx, dy) > m.radius + ROBOT_R + pad) continue;
    if (worst === null || m.fuse < worst.fuse) worst = m;
  }
  return worst;
}

/**
 * Which way to run. Straight out from the circle the robot is standing in,
 * biased away from every OTHER live circle so the reflex cannot dive out of one
 * and into the next — the single most demoralising thing a dodge can do.
 * Returns a unit vector, or null when nothing is underfoot.
 */
export function zoneEscapeDir(state: SimState, pos: Vec): Vec | null {
  const m = zoneUnderfoot(state, pos);
  if (m === null) return null;
  let ax = pos.x - m.target.x;
  let ay = pos.y - m.target.y;
  if (Math.hypot(ax, ay) < 0.001) {
    // Dead centre: no gradient to follow. Leave along the shell's own line of
    // flight — whatever is behind the boss is at least not where it is aiming.
    ax = m.target.x - m.from.x;
    ay = m.target.y - m.from.y;
    if (Math.hypot(ax, ay) < 0.001) ax = 1;
  }
  let l = Math.hypot(ax, ay);
  ax /= l;
  ay /= l;
  for (const o of state.mortars) {
    if (o === m) continue;
    const ox = pos.x - o.target.x;
    const oy = pos.y - o.target.y;
    const d = Math.hypot(ox, oy);
    if (d > o.radius * 2 || d < 0.001) continue;
    // Weighted by how close the other circle is: a distant one barely bends the
    // escape, one you are about to run into bends it hard.
    const w = 1 - d / (o.radius * 2);
    ax += (ox / d) * w;
    ay += (oy / d) * w;
  }
  l = Math.hypot(ax, ay);
  return l < 0.001 ? { x: 1, y: 0 } : { x: ax / l, y: ay / l };
}
