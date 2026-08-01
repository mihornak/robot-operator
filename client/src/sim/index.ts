/**
 * Deterministic game sim — public API. PURE TS: no pixi, no DOM, no async,
 * no Date/Math.random; all randomness advances state.rngState (shared
 * mulberry32) inside step().
 *
 * Robot scratch counters (i-frames, stun, once-per-order flags) live in a
 * module WeakMap keyed by SimState because the shared RobotState contract has
 * no scratch field. Deterministic: scratch is derived purely from the call
 * sequence, never serialized mid-run, and restart always goes through
 * initialState() (fresh state → fresh scratch).
 */
import type { ChipId, Entity, Order, ParseEntity, SimState } from '../../../shared/types';
import { BASE } from '../../../shared/content';
import { FLOORS, buildSolid } from './floors';
import { entityById, nearestHostile as nearestHostileEntity, newScratch } from './internal';
import type { RobotScratch } from './internal';
import { stepEnemies, stepHazards } from './enemies';
import { stepProjectiles } from './projectiles';
import { dist } from './physics';
import { proximityTriggers, stepRobot } from './robot';

export { entityById } from './internal';

/**
 * Nearest live hostile with its distance to the robot, for the director.
 * Returns a copy (read-only snapshot) so `dist` never leaks into sim state.
 */
export function nearestHostile(state: SimState): (Entity & { dist: number }) | null {
  const e = nearestHostileEntity(state);
  return e === null ? null : { ...e, dist: dist(state.robot.pos, e.pos) };
}

const scratchMap = new WeakMap<SimState, RobotScratch>();

function scratchOf(state: SimState): RobotScratch {
  let s = scratchMap.get(state);
  if (!s) {
    s = newScratch();
    scratchMap.set(state, s);
  }
  return s;
}

export function initialState(seed: number): SimState {
  const state: SimState = {
    seed,
    rngState: seed | 0,
    tick: 0,
    floorIndex: 0,
    robot: {
      pos: { x: 0, y: 0 },
      vel: { x: 0, y: 0 },
      facing: 0,
      headFacing: 0,
      hp: BASE.hp,
      maxHp: BASE.hp,
      alive: true,
      tier: 0,
      chips: [],
      name: null,
      hasMemory: false,
      brain: false,
      avoidIds: [],
      order: null,
      mood: 'ok',
      sulkTicks: 0,
      carrying: null,
      scrap: 0,
      speed: BASE.speedPxS,
      damage: BASE.damage,
      shootCd: 0,
      wallBumpTicks: 0,
    },
    entities: [],
    projectiles: [],
    solid: [],
    events: [],
    frozen: false,
  };
  loadFloor(state, 0);
  return state;
}

/**
 * Load a floor: rebuild grid + entities, robot to elevator A, per-floor state
 * reset. hp/chips/tier/scrap/brain/avoidIds persist; without MEMORY the name
 * does not. (avoidIds persisting across floors is deliberate — standing orders
 * outlive dead references; only initialState clears them.)
 */
export function loadFloor(state: SimState, floorIndex: number): void {
  const def = FLOORS[floorIndex];
  if (!def) throw new Error(`no floor index ${floorIndex}`);
  state.floorIndex = floorIndex;
  state.solid = buildSolid(def.map);
  state.entities = def.entities();
  state.projectiles = [];
  state.events = [];

  const r = state.robot;
  const a = entityById(state, 'elevA');
  const b = entityById(state, 'elevB');
  r.pos = a ? { x: a.pos.x, y: a.pos.y } : { x: 40, y: 136 };
  r.vel.x = 0;
  r.vel.y = 0;
  r.order = null;
  r.carrying = null;
  r.mood = 'ok';
  r.sulkTicks = 0;
  r.wallBumpTicks = 0;
  r.shootCd = 0;
  if (!r.hasMemory) r.name = null; // the forgetting gag
  if (b) {
    r.facing = Math.atan2(b.pos.y - r.pos.y, b.pos.x - r.pos.x);
    r.headFacing = r.facing;
  }
  scratchMap.set(state, newScratch());
}

/**
 * ONE fixed tick (1/60 s). Replaces state.events with this tick's events.
 * frozen: enemies/hazards/projectiles halt, robot still executes orders.
 * After robot_death the sim is inert until loadFloor/initialState.
 */
export function step(state: SimState): void {
  state.events = [];
  if (!state.robot.alive) return;
  state.tick++;
  const scratch = scratchOf(state);
  stepRobot(state, scratch);
  if (!state.frozen) {
    stepEnemies(state, scratch);
    stepHazards(state, scratch);
    stepProjectiles(state, scratch);
  }
  proximityTriggers(state);
}

export function setOrder(state: SimState, order: Order | null): void {
  const r = state.robot;
  r.order = order;
  r.wallBumpTicks = 0;
  const scratch = scratchOf(state);
  scratch.rageNotified = false;
  scratch.magnetTargetId = null; // a fresh order outranks the shiny detour
  scratch.moveTraveledPx = 0; // nudge distance counts from the fresh order
  scratch.hideTarget = null; // a fresh hide order picks cover anew
  if (order === null) {
    r.vel.x = 0;
    r.vel.y = 0;
  }
}

/** Install a chip: stat effects here, behavior effects read from robot.chips. */
export function applyChip(state: SimState, chip: ChipId): void {
  const r = state.robot;
  if (r.chips.includes(chip)) return;
  r.chips.push(chip);
  switch (chip) {
    case 'RAGE':
      r.damage *= 1.5;
      break;
    case 'SCARED':
      r.speed *= 1.3;
      break;
    case 'ZAP':
      r.damage += 1; // shoot cooldown -8 is derived from chips in robot.ts
      break;
    case 'TOUGH':
      r.maxHp += 3;
      r.hp = Math.min(r.maxHp, r.hp + 3);
      break;
    case 'MEMORY':
      r.hasMemory = true;
      break;
    case 'MAGNET':
      break; // behavior-only (scrap detour)
  }
}

/** Install the BRAIN upgrade (floor 4 crate): hide/avoid/careful/then unlocked. */
export function applyBrain(state: SimState): void {
  state.robot.brain = true;
}

/** Standing avoid order (BRAIN): robot routes wide around this entity id from
 *  now on. Dedup'd; persists across floors, cleared only by initialState. */
export function addAvoid(state: SimState, id: string): void {
  const r = state.robot;
  if (!r.avoidIds.includes(id)) r.avoidIds.push(id);
}

/** Live entities with rough bearing + distance, for the LLM parse request. */
export function visibleEntities(state: SimState): ParseEntity[] {
  const r = state.robot;
  const out: ParseEntity[] = [];
  for (const e of state.entities) {
    if (e.dead) continue;
    const dx = e.pos.x - r.pos.x;
    const dy = e.pos.y - r.pos.y;
    const dir =
      Math.abs(dx) >= Math.abs(dy)
        ? dx < 0
          ? 'left of robot'
          : 'right of robot'
        : dy < 0
          ? 'above robot'
          : 'below robot';
    out.push({ id: e.id, kind: e.kind, label: e.label, dir, dist: Math.round(Math.hypot(dx, dy)) });
  }
  return out;
}

/** Director resolved a crate: it opens in place. Triads are ONE shiny crate
 *  ('crate_triad', floors 2 & 5) whose three chips live on the ceremony card,
 *  so there are no longer option-bearing siblings to kill — the branch stays
 *  (harmless) for any future multi-crate floor. The optionless crate_EARS
 *  never dies as a bystander — only when it IS the choice. */
export function openCrate(state: SimState, crateId: string): void {
  for (const e of state.entities) {
    if (e.kind !== 'crate' || e.dead) continue;
    if (e.id === crateId) {
      e.dead = true;
      e.state = 'open';
    } else if (e.option != null && e.id.startsWith('crate_')) {
      e.dead = true;
    }
  }
}

/** Director hook (resolveCeremony / debug): light elevator B so entry unblocks. */
export function powerElevatorB(state: SimState): void {
  for (const e of state.entities) if (e.kind === 'elevatorB') e.state = 'lit';
}

/** Director hook: robot ignores orders for `ticks` (insult sulk). */
export function sulk(state: SimState, ticks: number): void {
  const r = state.robot;
  r.sulkTicks = ticks;
  r.mood = 'sulk';
  r.vel.x = 0;
  r.vel.y = 0;
}
