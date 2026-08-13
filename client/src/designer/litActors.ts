/**
 * SIM BODIES → LIT ACTORS.
 *
 * On a lit floor the classic `WorldView` is not mounted, so every entity the
 * player can see has to reach `LitScene.updateActors` — the adapter that gives
 * a sprite the room's lighting, a rim, a contact patch and a projected shadow.
 *
 * The anchor and foot conversions this needs are `actorPlacement` in
 * `render/util.ts`, shared with the game's own adapter (`render/litWorld.ts`)
 * so the two cannot drift; the per-kind upscales come from `render/world.ts`
 * for the same reason. What is left here — which entity draws as what, and
 * which frame it is on — is genuinely the designer's, because the editing view
 * has no sim clock, no interpolation and no combat state to animate from.
 */

import type { Entity, RobotState } from '@shared/types';
import type { ArtName } from '@shared/artManifest';
import type { PixiArtAtlas } from '../art/index';
import type { ActorPart, ActorState } from '../render/lit/types';
import { actorPlacement } from '../render/util';
import { CHIP_SCALE, CRATE_SCALE, CRATE_SCALE_PLAIN } from '../render/world';
import { kindInfo } from './palette';

/** The pickups are deliberately big; same numbers the game draws them at. */
const SCALE: Partial<Record<Entity['kind'], number>> = {
  crate: CRATE_SCALE_PLAIN,
  chip: CHIP_SCALE,
};

/** One entity as a single-part actor. */
export function entityActor(art: PixiArtAtlas, e: Entity, t: number): ActorState | null {
  if (e.dead) return null;
  const triad = e.id === 'crate_triad';
  const name: ArtName = triad ? 'crate_triad' : kindInfo(e.kind).art;
  const list = art.frames(name);
  if (list.length === 0) return null;
  const k = triad ? CRATE_SCALE : (SCALE[e.kind] ?? 1);
  // Elevators animate their doors from sim state, not from a clock; everything
  // else that has frames just idles through them.
  const frame =
    e.kind === 'elevatorA' || e.kind === 'elevatorB'
      ? 0
      : Math.floor(t * 6) % list.length;
  const place = actorPlacement(name, k);
  const part: ActorPart = {
    texture: list[frame]!,
    y: place.y,
  };
  if (k !== 1) part.scale = k;
  return {
    id: e.id,
    x: e.pos.x,
    y: e.pos.y,
    parts: [part],
    foot: place.foot,
  };
}

/** robot_head frame order is E,SE,S,SW,W,NW,N,NE — same as the lab reads it. */
function headIndex(facing: number): number {
  return ((Math.round((facing / (Math.PI * 2)) * 8) % 8) + 8) % 8;
}

/**
 * The robot, as its three animating layers. Offsets match the lab's rig, which
 * is where they were judged against this lighting — wheels low, body on the
 * origin, head up top with a one-pixel bob shared by both.
 */
export function robotActor(art: PixiArtAtlas, r: RobotState, t: number): ActorState {
  const wheels = art.frames('robot_wheels');
  const body = art.frames('robot_body');
  const head = art.frames('robot_head');
  const bob = Math.sin(t * 7) > 0 ? 0 : 1;
  return {
    id: '__robot',
    x: r.pos.x,
    y: r.pos.y,
    parts: [
      { texture: wheels[Math.floor(t * 12) % wheels.length]!, y: 5 },
      { texture: body[Math.floor(t * 3) % body.length]!, y: -1 + bob },
      { texture: head[headIndex(r.headFacing)]!, y: -10 + bob },
    ],
  };
}

/** Everything currently standing in the room. */
export function actorStates(
  art: PixiArtAtlas,
  entities: readonly Entity[],
  robot: RobotState | null,
  t: number,
): ActorState[] {
  const out: ActorState[] = [];
  for (const e of entities) {
    const a = entityActor(art, e, t);
    if (a) out.push(a);
  }
  if (robot && robot.alive && !robot.dormant) out.push(robotActor(art, robot, t));
  return out;
}
