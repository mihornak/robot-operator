/**
 * Determinism selftest: two scripted 600-tick runs from seed 42 must produce
 * bit-identical JSON state every tick. Also sanity-checks floor maps and the
 * pinned entity ids the director depends on.
 */
import type { SimState } from '../../../shared/types';
import { FLOORS, buildSolid } from './floors';
import { applyChip, initialState, loadFloor, setOrder, step } from './index';
import { solidAtPx } from './physics';

const TICKS = 600;

const PINNED_IDS: string[][] = [
  ['elevA', 'elevB', 'scrap1'],
  ['elevA', 'elevB', 'crate_MAGNET', 'crate_RAGE', 'crate_SCARED', 'cable1', 'scrap1'],
  ['elevA', 'elevB', 'crate_EARS', 'printer1', 'printer_nice', 'cable1', 'scrap1', 'scrap2'],
  ['elevA', 'elevB', 'printer1', 'cable1', 'fuse1', 'socket1', 'mop1', 'scrap1'],
  ['elevA', 'elevB', 'crate_MEMORY', 'crate_ZAP', 'crate_TOUGH', 'scrap1', 'scrap2'],
];

/** Scripted order sequence — exercises movement, chips, combat, rng, floor load. */
function script(t: number, s: SimState): void {
  switch (t) {
    case 1:
      setOrder(s, { kind: 'move', dir: 'right' });
      break;
    case 80:
      setOrder(s, { kind: 'move', dir: 'up' });
      break;
    case 140:
      applyChip(s, 'SCARED');
      break;
    case 150:
      s.robot.tier = 1;
      setOrder(s, { kind: 'goto', targetId: 'scrap1' });
      break;
    case 230:
      setOrder(s, { kind: 'shoot' });
      break;
    case 260:
      loadFloor(s, 2);
      setOrder(s, { kind: 'attack', targetId: 'printer1' });
      break;
    case 470:
      applyChip(s, 'RAGE');
      setOrder(s, { kind: 'move', dir: 'left' });
      break;
    case 520:
      setOrder(s, { kind: 'goto', targetId: 'elevB' });
      break;
  }
}

function snapshot(s: SimState): string {
  return JSON.stringify({
    t: s.tick,
    rng: s.rngState,
    robot: s.robot,
    entities: s.entities,
    projectiles: s.projectiles,
    events: s.events,
  });
}

function run(): { frames: string[]; events: number } {
  const s = initialState(42);
  const frames: string[] = [];
  let events = 0;
  for (let t = 1; t <= TICKS; t++) {
    script(t, s);
    step(s);
    events += s.events.length;
    frames.push(snapshot(s));
  }
  return { frames, events };
}

export function runSelftest(): string {
  // floor sanity: maps well-formed, pinned ids present, nothing spawns in a wall
  for (let i = 0; i < FLOORS.length; i++) {
    const solid = buildSolid(FLOORS[i].map);
    const ents = FLOORS[i].entities();
    const ids = new Set(ents.map((e) => e.id));
    for (const id of PINNED_IDS[i]) {
      if (!ids.has(id)) return `FAIL: floor index ${i} missing pinned entity '${id}'`;
    }
    for (const e of ents) {
      if (solidAtPx(solid, e.pos.x, e.pos.y)) {
        return `FAIL: floor index ${i} entity '${e.id}' spawns inside a wall`;
      }
    }
  }

  const a = run();
  const b = run();
  for (let i = 0; i < TICKS; i++) {
    if (a.frames[i] !== b.frames[i]) {
      return `FAIL: divergence at tick ${i + 1}\nA: ${a.frames[i]}\nB: ${b.frames[i]}`;
    }
  }
  if (a.events === 0) return 'FAIL: scripted run emitted zero events';
  return `PASS: ${TICKS} ticks deterministic (seed 42, ${a.events} events across run)`;
}
