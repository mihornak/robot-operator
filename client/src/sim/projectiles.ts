/** Projectile flight + hits: robot bolts vs machines, enemy paper vs robot. */
import type { EntityKind, Projectile, SimState } from '../../../shared/types';
import { BOLT_HIT_RADIUS, ROBOT_R, aiOf, emit } from './internal';
import type { RobotScratch } from './internal';
import { DT, dist, solidAtPx } from './physics';
import { damageRobot } from './robot';

/** Bolts land on anything with hp — including the mop (wrong-target comedy). */
const SHOOTABLE: ReadonlySet<EntityKind> = new Set(['fusedPrinter', 'printerInnocent', 'mop']);

export function stepProjectiles(state: SimState, scratch: RobotScratch): void {
  const r = state.robot;
  const keep: Projectile[] = [];
  for (const p of state.projectiles) {
    p.pos.x += p.vel.x * DT;
    p.pos.y += p.vel.y * DT;
    if (solidAtPx(state.solid, p.pos.x, p.pos.y)) continue; // despawn on wall

    if (p.kind === 'bolt') {
      let hit = false;
      for (const e of state.entities) {
        if (e.dead || e.hp === undefined || !SHOOTABLE.has(e.kind)) continue;
        if (dist(p.pos, e.pos) > BOLT_HIT_RADIUS) continue;
        e.hp -= r.damage;
        aiOf(e).aggro = 1; // shooting a sleeping printer wakes it
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
    } else if (r.alive && dist(p.pos, r.pos) <= ROBOT_R + 3) {
      damageRobot(state, scratch, 1, 'paper');
      continue; // paper crumples even on an i-framed robot
    }
    keep.push(p);
  }
  state.projectiles = keep;
}
