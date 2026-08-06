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
import type {
  ChipId,
  DirectiveKind,
  Entity,
  Order,
  ParseEntity,
  SimState,
  Standing,
} from '../../../shared/types';
import { defaultStanding } from '../../../shared/types';
import { BASE } from '../../../shared/content';
import { FLOORS, buildSolid } from './floors';
import {
  applyOrder,
  entityById,
  hostileInSight,
  isLiveHostile,
  kindWeight,
  nearestHostile as nearestHostileEntity,
  newScratch,
} from './internal';
import type { RobotScratch } from './internal';
import { stepEnemies, stepHazards } from './enemies';
import { stepProjectiles } from './projectiles';
import { stepMortars } from './mortar';
import { stepBoss } from './boss';
import { dist } from './physics';
import { proximityTriggers, stepRobot } from './robot';

export { entityById } from './internal';

/** How many floors exist. The dev `?floor=N` shortcut bounds itself on this, so
 *  adding a floor never needs a second edit in the director to be reachable. */
export const FLOOR_COUNT = FLOORS.length;

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
      dormant: true, // asleep in the floor-1 pile until the player actually speaks
      // Tier 1 and brain from the first second: nothing the player can SAY is
      // ever withheld. Upgrades widen what the robot notices (tier 2) and how
      // much it proposes on its own (ideas), never what it will listen to.
      tier: 1,
      chips: [],
      name: null,
      hasMemory: false,
      brain: true,
      ideas: false,
      standing: defaultStanding(),
      order: null,
      selfDriven: false,
      awaitingBriefing: true,
      mood: 'ok',
      sulkTicks: 0,
      carrying: null,
      scrap: 0,
      speed: BASE.speedPxS,
      damage: BASE.damage,
      shootCd: 0,
      rocketCd: 0,
      rockets: false,
      wallBumpTicks: 0,
    },
    entities: [],
    projectiles: [],
    mortars: [],
    nextId: 0,
    solid: [],
    events: [],
    frozen: false,
  };
  loadFloor(state, 0);
  return state;
}

/**
 * Load a floor: rebuild grid + entities, robot to elevator A, per-floor state
 * reset. hp/chips/tier/scrap/ideas persist, and so do the standing orders —
 * "avoid the machines" is how the player wants the robot PLAYED, not a note
 * about one room, and re-teaching it every floor is exactly the amnesia this
 * change exists to kill. Only the avoid-LIST is dropped, because entity ids
 * belong to the floor that spawned them. Without MEMORY the name still goes.
 */
export function loadFloor(state: SimState, floorIndex: number): void {
  const def = FLOORS[floorIndex];
  if (!def) throw new Error(`no floor index ${floorIndex}`);
  state.floorIndex = floorIndex;
  state.solid = buildSolid(def.map);
  state.entities = def.entities();
  state.projectiles = [];
  state.mortars = [];
  // Ids are only ever compared within a floor, so the counter restarts with it
  // — and a restart from tick 0 then produces byte-identical ids, which is what
  // keeps the determinism snapshot meaningful across a floor change.
  state.nextId = 0;
  state.events = [];

  const r = state.robot;
  const a = entityById(state, 'elevA');
  const b = entityById(state, 'elevB');
  const spawn = def.spawn ?? a?.pos ?? { x: 40, y: 136 };
  r.pos = { x: spawn.x, y: spawn.y };
  r.vel.x = 0;
  r.vel.y = 0;
  r.order = null;
  r.selfDriven = false;
  // A new floor is a new briefing. The robot holds at the doors and reports;
  // walking out of the lift already busy is how floor 2 started roaming.
  r.awaitingBriefing = true;
  r.standing.roam = false; // "do your own thing" was about THAT room, not forever
  r.carrying = null;
  r.mood = 'ok';
  r.sulkTicks = 0;
  r.wallBumpTicks = 0;
  r.shootCd = 0;
  r.rocketCd = 0;
  r.standing.avoidIds = []; // ids died with the old floor; the policy survives
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
    // After projectiles: a mortar's shell is decoration flying alongside it, so
    // the two must not resolve out of order or the boom precedes the arrival.
    // Before proximityTriggers: a robot killed by a blast this tick must not
    // also be allowed to step into the lift and end the floor from the grave.
    stepMortars(state, scratch);
    stepBoss(state, scratch);
  }
  proximityTriggers(state);
}

/**
 * Install a PLAYER order (clears the self-driven flag).
 *
 * A REAL order also ends the briefing hold — but clearing the order does not.
 * The director parks the robot with setOrder(null) right after a floor loads,
 * and letting that count as "being told something" silently cancelled the very
 * hold the floor change had just armed.
 */
export function setOrder(state: SimState, order: Order | null): void {
  if (order !== null) state.robot.awaitingBriefing = false;
  // Re-applying the order that is ALREADY running is not a no-op: applyOrder
  // wipes the nav path and resets the settle clock, so the robot stops for a
  // beat and re-plans a route it was happily following. That used to be a freak
  // event; with the parse fast-path the model's confirmation arrives a second
  // behind the local reading and says the same thing, so it would be routine —
  // and the player would see the robot hitch every single time it was right.
  if (order !== null && sameOrder(state.robot.order, order)) {
    // Ownership still transfers: an order the robot chose for itself becomes
    // the player's the moment they ask for it, which is what the OSD arrow and
    // the "finished the job" report both read off.
    state.robot.selfDriven = false;
    return;
  }
  applyOrder(state, scratchOf(state), order, false);
}

/** Same task, same parameters — the test behind the re-apply guard above.
 *  A nudge (`move` with distancePx) is deliberately never "the same": it is a
 *  RELATIVE order, and "left a bit… left a bit" is two nudges, not one. */
function sameOrder(a: Order | null, b: Order): boolean {
  if (a === null || a.kind !== b.kind) return false;
  switch (b.kind) {
    case 'move':
      if (b.distancePx !== undefined || (a as { distancePx?: number }).distancePx !== undefined) return false;
      return (a as { dir: string }).dir === b.dir;
    case 'goto':
    case 'pickup':
      return (
        (a as { targetId: string }).targetId === b.targetId &&
        ((a as { careful?: boolean }).careful ?? false) === (b.careful ?? false)
      );
    case 'attack':
    case 'enter':
      return (a as { targetId: string }).targetId === b.targetId;
    default:
      // stop / shoot / explore / hide / retreat / evade are deliberately NOT
      // guarded. They carry no fields, so a repeat is never an accident — it is
      // the player asking for a fresh answer ("hide" again because the first
      // piece of cover was rubbish), and applyOrder's scratch reset is exactly
      // what re-picks it.
      return false;
  }
}

/**
 * The order behind "RUN!". Which one depends on whether anything is chasing.
 *
 * The sim has two flight orders and the difference matters at exactly the
 * moment the operator panics:
 * - `retreat` backs away and KEEPS backing away until nothing can see the robot
 *   any more. It is the right answer while something is hunting it, and it ends
 *   on its own so a panicked shout does not cost the rest of the floor.
 * - `evade` never plants and never finishes. It is the right answer when
 *   nothing is chasing, because `retreat` with an empty threat list halts and
 *   reports "done" on its FIRST tick — the operator shouts "run!", the robot
 *   says it ran, and nothing moves. That fizzle is indistinguishable from the
 *   bug this whole thing exists to fix.
 *
 * Lives here rather than in the director so the choice is made where the threat
 * list is, and so the director's flee case stays one line it cannot get wrong.
 */
export function fleeOrder(state: SimState): Order {
  return hostileInSight(state) !== null ? { kind: 'retreat' } : { kind: 'evade' };
}

/** The player said something directive but gave no order (a standing rule, a
 *  yes, a plan). That still counts as being briefed. */
export function clearBriefing(state: SimState): void {
  state.robot.awaitingBriefing = false;
}

/**
 * Fold spoken directives into the standing orders. Each pair is exclusive, so
 * "fight everything" really does cancel an earlier "avoid the machines" —
 * accumulating contradictory policies is how a robot starts looking possessed.
 * Returns the resolved standing orders for the caller to display.
 */
export function applyDirectives(state: SimState, kinds: readonly DirectiveKind[]): Standing {
  const st = state.robot.standing;
  for (const k of kinds) {
    switch (k) {
      case 'avoid_enemies':
        st.avoidEnemies = true;
        st.fight = false;
        st.hunt = false;
        break;
      case 'fight_enemies':
        // "Fight everything" is the ONLY thing that sends the robot looking
        // for trouble. Plain `fight` is shooting back at what already found it.
        st.avoidEnemies = false;
        st.fight = true;
        st.hunt = true;
        break;
      case 'avoid_hazards':
        st.avoidHazards = true;
        break;
      case 'ignore_hazards':
        st.avoidHazards = false;
        break;
      case 'gather':
        st.gather = true;
        break;
      case 'no_gather':
        st.gather = false;
        break;
      case 'careful':
        st.careful = true;
        break;
      case 'bold':
        st.careful = false;
        break;
      case 'act_alone':
        st.autonomy = true;
        st.roam = true;
        break;
      case 'wait_for_orders':
        st.autonomy = false;
        st.roam = false;
        break;
      case 'keep_distance':
        // Deliberately does NOT touch `fight`. That is the whole difference
        // between "keep back" and "avoid enemies": one is how to fight, the
        // other is a refusal to. Collapsing them loses the mid-fight
        // readjustment the doctrine directives exist for.
        st.spacing = 'far';
        break;
      case 'close_in':
        // You cannot close on something you are routing around, so this
        // overrides the avoid rule outright rather than fighting it every tick.
        st.spacing = 'close';
        st.avoidEnemies = false;
        st.fight = true;
        break;
      case 'dodge_projectiles':
        st.dodgeZones = true;
        break;
      case 'ignore_projectiles':
        st.dodgeZones = false;
        break;
      case 'keep_moving':
        st.keepMoving = true;
        break;
      case 'hold_ground':
        st.keepMoving = false;
        break;
      case 'focus_dangerous':
        st.focus = 'dangerous';
        break;
      case 'focus_nearest':
        st.focus = 'nearest';
        break;
      case 'use_rockets':
        st.weapon = 'rocket';
        break;
      case 'use_bolts':
        st.weapon = 'bolt';
        break;
    }
  }
  return st;
}

/** Director-owned suppression of self-initiative (naming beat, ceremonies). */
export function setAutonomy(state: SimState, on: boolean): void {
  state.robot.standing.autonomy = on;
}

/** True when a hostile is in range AND in view — drives the director's HUD. */
export function canSeeHostile(state: SimState): boolean {
  return hostileInSight(state) !== null;
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

/** BRAIN crate (floor 4): the robot starts volunteering plans of its own. */
export function applyBrain(state: SimState): void {
  state.robot.brain = true;
  state.robot.ideas = true;
}

/** EARS crate (floor 3): sharper senses — wider sight, notices things sooner. */
export function applyEars(state: SimState): void {
  state.robot.tier = 2;
}

/**
 * The robot climbs out of the opening pile. One-way, idempotent: the director
 * calls it on the FIRST utterance that actually carried words, so a mic that
 * isn't working can never fake the relationship beat.
 */
export function wakeRobot(state: SimState): void {
  state.robot.dormant = false;
  for (const e of state.entities) if (e.kind === 'debris' && e.id === 'pile1') e.state = 'burst';
}

/** Standing avoid order: robot routes wide around this entity id from now on.
 *  Dedup'd; dies with the floor that spawned the id (see loadFloor). */
export function addAvoid(state: SimState, id: string): void {
  const ids = state.robot.standing.avoidIds;
  if (!ids.includes(id)) ids.push(id);
}

/**
 * What the robot is doing right now, in plain words. Feeds both the OSD
 * objective row and the parser context, so "what are you doing?" has a real
 * answer and the model can tell a new instruction from a repeat of the old one.
 */
export function describeOrder(state: SimState): string | null {
  const o = state.robot.order;
  if (!o) return null;
  const label = (id: string): string => entityById(state, id)?.label ?? 'thing';
  switch (o.kind) {
    case 'move':
      return `driving ${o.dir}`;
    case 'stop':
      return null;
    case 'shoot':
      return 'shooting';
    case 'goto':
      return `${o.careful ? 'sneaking' : 'going'} to the ${label(o.targetId)}`;
    case 'attack':
      return `fighting the ${label(o.targetId)}`;
    case 'pickup':
      return `fetching the ${label(o.targetId)}`;
    case 'enter':
      return 'getting in the elevator';
    case 'explore':
      return 'exploring';
    case 'hide':
      return 'hiding';
    case 'retreat':
      return 'backing away';
    case 'evade':
      return 'dodging';
  }
}

/** Body class as a WORD. "the big one" has to bind to something the model can
 *  read off one entity, rather than a number it has to compare across the list. */
function sizeOf(e: Entity): 'small' | 'big' | 'boss' {
  return e.kind === 'fusedShredder' ? 'boss' : 'small';
}

/**
 * Live entities with rough bearing + distance, for the LLM parse request.
 *
 * Live hostiles additionally carry `rank` (1 = the thing most likely to kill
 * the robot next) and `size`. Two fields rather than one float on purpose: the
 * model needs a WORD to bind "the big one" to, and the local matcher needs a
 * discrete selector it can sort on.
 *
 * The returned array is NOT reordered. `matchEntity` takes the first entity on
 * a score tie, and several behaviours — the dead-elevator tie-break above all —
 * depend on floor spawn order.
 */
export function visibleEntities(state: SimState): ParseEntity[] {
  const r = state.robot;
  const out: ParseEntity[] = [];
  // Threat score, worst first. kindWeight × proximity is the same shape the
  // robot's own targeting uses; it does not have to agree to the last decimal,
  // it has to agree about WHICH ONE, and the boss outweighs a printer 3:1 at
  // any distance either of them can shoot from.
  const scored: Array<{ id: string; score: number }> = [];
  for (const e of state.entities) {
    if (!isLiveHostile(e)) continue;
    const d = Math.hypot(e.pos.x - r.pos.x, e.pos.y - r.pos.y);
    scored.push({ id: e.id, score: (kindWeight(e) * 1000) / (d + 40) });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const rankById = new Map(scored.map((s, i) => [s.id, i + 1]));

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
    const ent: ParseEntity = {
      id: e.id,
      kind: e.kind,
      label: e.label,
      dir,
      dist: Math.round(Math.hypot(dx, dy)),
    };
    const rank = rankById.get(e.id);
    if (rank !== undefined) {
      ent.rank = rank;
      ent.size = sizeOf(e);
    }
    out.push(ent);
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
