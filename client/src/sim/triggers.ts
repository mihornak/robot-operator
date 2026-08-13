/**
 * Authored region triggers — the designer's half of the sim.
 *
 * A trigger is a tile-space rect the ROBOT CENTRE crosses. Everything that
 * changes the world (wake, spawn, setTiles, power) happens here, inside the
 * deterministic tick, so a replay from the same seed opens the same doors.
 * Everything that is presentation (say, sfx, hum, shake) is refused and handed
 * to the director on the `trigger_fired` event: a sim that could speak would be
 * a sim that needs an audio context.
 */
import type { SimState, TriggerAction, TriggerDef } from '../../../shared/types';
import { TILE } from '../../../shared/types';
import { emit, entityById, wakeMachine } from './internal';
import { entityFromDef } from './levelLoader';

function insideRect(state: SimState, def: TriggerDef): boolean {
  const { tx, ty, tw, th } = def.rect;
  const p = state.robot.pos;
  return (
    p.x >= tx * TILE && p.x < (tx + tw) * TILE && p.y >= ty * TILE && p.y < (ty + th) * TILE
  );
}

/**
 * Run the world half of `def` and return whatever the director has to perform.
 * Order is the authored order: a trigger that opens a door and then says
 * something must not have the line arrive first.
 */
function fire(state: SimState, def: TriggerDef): TriggerAction[] {
  const presentation: TriggerAction[] = [];
  for (const a of def.actions) {
    switch (a.type) {
      case 'wake': {
        const e = entityById(state, a.target);
        if (e) wakeMachine(e);
        break;
      }
      case 'spawn':
        state.entities.push(entityFromDef(a.entity));
        break;
      case 'setTiles': {
        let changed = false;
        for (const t of a.tiles) {
          const row = state.solid[t.ty];
          if (!row || t.tx < 0 || t.tx >= row.length) continue;
          if (row[t.tx] === t.solid) continue;
          row[t.tx] = t.solid;
          changed = true;
        }
        // Render rebuilds the tilemap off this, and every live route was planned
        // against the old grid — a door that opens silently is a door the robot
        // keeps walking around.
        if (changed) emit(state, 'tiles_changed', def.id);
        break;
      }
      case 'power': {
        const e = entityById(state, a.target);
        if (e) e.state = a.on ? 'lit' : 'dark';
        break;
      }
      default:
        presentation.push(a);
        break;
    }
  }
  return presentation;
}

/**
 * One step phase. Edge-detected per trigger: `inside` is only updated on ticks
 * this runs at all, so a rect crossed during a ceremony fires when the world
 * thaws rather than being lost.
 */
export function levelTriggers(state: SimState): void {
  if (state.triggers.length === 0) return;
  const r = state.robot;
  // Same gating as proximityTriggers: a sleeping robot has not gone anywhere,
  // and a frozen world must not start new beats on top of the one running.
  if (!r.alive || r.dormant || state.frozen) return;
  for (const t of state.triggers) {
    const was = t.inside;
    t.inside = insideRect(state, t.def);
    const crossed = t.def.when === 'enter' ? t.inside && !was : !t.inside && was;
    if (!crossed) continue;
    if (t.fired && (t.def.once ?? true)) continue;
    t.fired = true;
    emit(state, 'trigger_fired', t.def.id, undefined, fire(state, t.def));
  }
}
