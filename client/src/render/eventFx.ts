/**
 * What a sim event LOOKS like — the sparks, the parts, the smoke.
 *
 * Lifted out of WorldView when the lit renderer arrived, because the two
 * pipelines disagree about everything except this: a boss dying throws the same
 * plating whether the room it dies in is lit by a lightmap or by a flat tile
 * atlas. What stayed behind in each caller is the part that touches its own
 * view state (hit tints, door timers, tilemap rebuilds) — that has no shared
 * shape to it.
 */

import type { ArtAtlas, Entity, RenderView, SimEvent } from '@shared/types';
import type { FxSystem } from './fx';
import type { RobotView } from './robot';
import { tex } from './util';

function findEntity(view: RenderView, id: string): Entity | undefined {
  return view.sim.entities.find((e) => e.id === id);
}

export function eventFx(
  fx: FxSystem,
  art: ArtAtlas,
  robot: RobotView,
  ev: SimEvent,
  view: RenderView,
): void {
  const rs = view.sim.robot;
  switch (ev.type) {
    case 'wall_bump':
      robot.onBump(rs);
      break;
    case 'shot_fired':
      robot.onShot(rs);
      break;
    case 'robot_damage':
      robot.onDamage(rs);
      if (ev.data?.source === 'cable') fx.spark(rs.pos.x, rs.pos.y, 7);
      break;
    case 'robot_death':
      fx.smoke(rs.pos.x, rs.pos.y - 8, 1.3);
      fx.spark(rs.pos.x, rs.pos.y - 4, 5);
      break;
    case 'enemy_hit': {
      // A tint alone gave a hit no WEIGHT: on a 34px boss that soaks dozens of
      // them you could not tell a landed shot from a miss, which made the
      // whole fight read as unresponsive. Sparks off the plating say "that
      // connected" without pretending a bolt is an explosion.
      const e = ev.id ? findEntity(view, ev.id) : undefined;
      if (!e) break;
      const big = e.kind === 'fusedShredder';
      fx.spark(e.pos.x, e.pos.y - 2, big ? 6 : 3);
      if (big) {
        // Only the boss sheds parts per hit. On a printer that dies in three
        // shots it would look like it was already coming apart.
        fx.part(e.pos.x, e.pos.y - 4, tex(art, 'part_plate'), 0x6a6f76);
        fx.flashPool(e.pos.x, e.pos.y - 2, 26, 70);
      }
      break;
    }
    // Every AoE detonation — boss mortar AND robot rocket. `explode()` emits
    // one of these with the impact point, so the visual lands exactly where
    // the damage did rather than where a sprite happened to be.
    case 'mortar_impact': {
      const x = Number(ev.data?.x ?? 0);
      const y = Number(ev.data?.y ?? 0);
      fx.burstMed(x, y);
      fx.flashPool(x, y, 90, 200);
      break;
    }
    case 'enemy_death': {
      const e = ev.id ? findEntity(view, ev.id) : undefined;
      if (!e) break;
      if (e.kind === 'fusedShredder') {
        // The one and only burstHuge in the game. A boss that dies with the
        // same pop as the printers it was printing is a boss that was never
        // worth the fight.
        fx.burstHuge(e.pos.x, e.pos.y - 6);
        for (let i = 0; i < 8; i++) {
          fx.part(e.pos.x, e.pos.y - 8, tex(art, 'part_plate'), 0x6a6f76);
          fx.part(e.pos.x, e.pos.y - 6, tex(art, 'paper'), 0x8a8d90);
        }
      } else {
        fx.boom(e.pos.x, e.pos.y - 4);
        fx.part(e.pos.x, e.pos.y - 6, tex(art, 'part_plate'), 0x6a6f76);
        fx.part(e.pos.x, e.pos.y - 6, tex(art, 'paper'), 0x8a8d90);
      }
      break;
    }
    case 'scrap_pickup':
      fx.glint(rs.pos.x, rs.pos.y - 6);
      break;
    case 'chip_pickup':
      // bigger than a scrap glint — this one changes who the robot IS
      fx.glint(rs.pos.x, rs.pos.y - 6);
      fx.spark(rs.pos.x, rs.pos.y - 4, 6);
      break;
    default:
      break;
  }
}
