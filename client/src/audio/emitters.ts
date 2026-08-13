/**
 * Positional sound emitters — a sound that belongs to a PLACE.
 *
 * Deliberately not sim: the sim owns nothing that can make noise, and a
 * distance fade recomputed at 60Hz has no business inside a deterministic tick.
 * The director calls updateEmitters once per frame with the current floor's
 * `sounds` and the robot's position, and this module holds the live loop
 * handles keyed by emitter id.
 *
 * NEVER speaks. Emitters are ambience — the robot's voice is the speech queue's
 * job, and nothing here may reach TTS.
 */
import type { AudioEngine, LoopHandle, SoundEmitterDef, Vec } from '@shared/types';

/** Live loops, keyed by emitter id. Created lazily on first audible frame. */
const loops = new Map<string, LoopHandle>();
/** One-shot emitters the robot is currently INSIDE — they re-arm on the way out. */
const armed = new Set<string>();

/** Linear falloff: full volume at the centre, silent at radiusPx. */
function gainAt(def: SoundEmitterDef, robot: Vec): number {
  const d = Math.hypot(robot.x - def.pos.x, robot.y - def.pos.y);
  const r = Math.max(1, def.radiusPx);
  return Math.max(0, 1 - d / r) * (def.volume ?? 1);
}

export function updateEmitters(
  audio: AudioEngine,
  defs: readonly SoundEmitterDef[],
  robot: Vec,
): void {
  if (defs.length === 0 && loops.size === 0 && armed.size === 0) return;
  const live = new Set<string>();
  for (const def of defs) {
    live.add(def.id);
    const gain = gainAt(def, robot);
    if (def.loop === false) {
      // One-shot: fires on the way IN, and cannot fire again until the robot
      // has left the radius. Without the re-arm, a robot loitering on the edge
      // machine-guns the sound every frame it wobbles across the boundary.
      if (gain > 0 && !armed.has(def.id)) {
        armed.add(def.id);
        audio.playSfx(def.sound, { volume: gain });
      } else if (gain <= 0) {
        armed.delete(def.id);
      }
      continue;
    }
    let handle = loops.get(def.id);
    if (!handle) {
      // Started on the first frame it would be audible, not on floor load: an
      // emitter across the room is a source node doing nothing but costing.
      if (gain <= 0) continue;
      handle = audio.startLoop(def.sound);
      loops.set(def.id, handle);
    }
    handle.setGain(gain);
  }
  // Emitters that vanished with a floor change the director did not announce.
  for (const [id, handle] of loops) {
    if (live.has(id)) continue;
    handle.stop();
    loops.delete(id);
  }
  for (const id of armed) if (!live.has(id)) armed.delete(id);
}

/** Floor change, death, restart — anything that ends the room these belong to. */
export function stopAllEmitters(): void {
  for (const handle of loops.values()) handle.stop();
  loops.clear();
  armed.clear();
}
