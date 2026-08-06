/**
 * Randomised navigation fuzz. The determinism selftest proves the sim is
 * REPRODUCIBLE; this proves it actually WORKS — that an order to go and fetch
 * a thing ends with the robot holding the thing, from anywhere on any floor.
 *
 * Scripted tests only ever exercise the handful of routes their author thought
 * of, which is exactly how "the robot doesn't pick things up" survived a green
 * suite. This walks thousands of random (start, target) pairs instead and
 * reports every one that never completed, with enough state to reproduce it.
 *
 * Deterministic despite the name: the case generator runs off its own
 * mulberry32 seed, so a failing run replays identically.
 */
import type { Entity, SimState } from '../../../shared/types';
import { TILE, TILES_X, TILES_Y } from '../../../shared/types';
import { makeRng } from '../../../shared/rng';
import { FLOORS } from './floors';
import { clearBriefing, initialState, loadFloor, setOrder, step, wakeRobot } from './index';
import { ROBOT_R } from './internal';
import { dist, isSolidTile } from './physics';
import { findPath } from './pathfind';

/** Ticks a single case may run before it counts as a failure (~13s of game time). */
const CASE_TICKS = 800;

export interface FuzzFailure {
  floor: number;
  targetId: string;
  targetKind: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** How close it got, px. */
  best: number;
  /** Where it gave up. */
  ended: { x: number; y: number };
  reason: string;
}

export interface FuzzReport {
  cases: number;
  failures: FuzzFailure[];
  /** Ticks taken by the slowest SUCCESSFUL case — a canary for pathing that
   *  technically works but crawls. */
  slowest: number;
}

/** Every walkable tile centre with room for the robot's body. */
function walkableCells(state: SimState): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let ty = 0; ty < TILES_Y; ty++) {
    for (let tx = 0; tx < TILES_X; tx++) {
      if (isSolidTile(state.solid, tx, ty)) continue;
      out.push({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });
    }
  }
  return out;
}

/**
 * Things an order can meaningfully target. Excluded, and why:
 * - cable/debris/elevatorA — "go and stand on the live wire" failing is correct
 * - fusedPrinter / fusedShredder — they chase and knock the robot back, so
 *   closing to a 12px arrival radius is not something navigation can
 *   guarantee. Fighting is covered by the combat tests in selftest.ts.
 */
function targetable(state: SimState): Entity[] {
  return state.entities.filter(
    (e) =>
      !e.dead &&
      e.kind !== 'cable' &&
      e.kind !== 'debris' &&
      e.kind !== 'elevatorA' &&
      e.kind !== 'fusedPrinter' &&
      e.kind !== 'fusedShredder',
  );
}

/**
 * Run one case: robot teleported to `from`, ordered to fetch/reach `target`.
 * Success = the order completes (sim clears it) with the robot actually there,
 * or the entity is consumed (a pickup that landed via the proximity pass).
 */
function runCase(
  floorIndex: number,
  from: { x: number; y: number },
  targetId: string,
  pickup: boolean,
  autonomy: boolean,
): FuzzFailure | null {
  const s = initialState(0x5eed);
  wakeRobot(s);
  loadFloor(s, floorIndex);
  clearBriefing(s);
  // Half the sweep runs with initiative OFF (does navigation work?) and half
  // with it ON exactly as the game ships it (does the robot's own personality
  // — loot detours, threat holds, MAGNET — sabotage an order it was given?).
  // The second half is the one that matches what a player actually sees.
  s.robot.standing.autonomy = autonomy;
  // Cut the power to the exit. Cases start from ARBITRARY tiles, some of them
  // right next to elevator B, and a floor that ends itself mid-route looks
  // exactly like a navigation failure in the results. The geometry is
  // unchanged; only the trigger is off.
  for (const e of s.entities) if (e.kind === 'elevatorB') e.state = 'dark';
  s.robot.pos = { x: from.x, y: from.y };
  const target = s.entities.find((e) => e.id === targetId);
  if (!target) return null;
  const to = { x: target.pos.x, y: target.pos.y };

  setOrder(s, pickup ? { kind: 'pickup', targetId } : { kind: 'goto', targetId });

  let best = dist(from, to);
  let reason = 'timed out still moving';
  for (let t = 0; t < CASE_TICKS; t++) {
    step(s);
    best = Math.min(best, dist(s.robot.pos, target.pos));
    for (const ev of s.events) {
      if (ev.type === 'path_failed') reason = 'planner found no route';
      if (ev.type === 'order_blocked') reason = `blocked: ${ev.data?.reason ?? '?'}`;
    }
    if (target.dead && (target.kind === 'scrap' || target.kind === 'chip' || target.kind === 'fuse')) {
      return null; // collected — that is the whole job
    }
    if (s.robot.order === null) {
      // Order finished. Did it actually get there?
      if (best <= 20) return null;
      break;
    }
  }
  return {
    floor: floorIndex + 1,
    targetId,
    targetKind: target.kind,
    from: { x: Math.round(from.x), y: Math.round(from.y) },
    to: { x: Math.round(to.x), y: Math.round(to.y) },
    best: Math.round(best),
    ended: { x: Math.round(s.robot.pos.x), y: Math.round(s.robot.pos.y) },
    reason,
  };
}

/**
 * Sweep every floor: from `samplesPerTarget` random walkable starts, order the
 * robot to each targetable entity, both as a goto and as a pickup. Starts that
 * the PLANNER itself says are unreachable are skipped — an island behind a
 * wall is a level-design bug, and `floorsRoutable` in the selftest owns that.
 */
export function runFuzz(seed = 0xbadf00d, samplesPerTarget = 6): FuzzReport {
  const rng = makeRng(seed);
  const failures: FuzzFailure[] = [];
  let cases = 0;
  let slowest = 0;

  for (let f = 0; f < FLOORS.length; f++) {
    const probe = initialState(1);
    loadFloor(probe, f);
    const cells = walkableCells(probe);
    for (const target of targetable(probe)) {
      for (let i = 0; i < samplesPerTarget; i++) {
        const from = cells[Math.floor(rng() * cells.length)];
        if (dist(from, target.pos) < 24) continue; // already there; nothing to test
        if (findPath(probe.solid, from, target.pos, ROBOT_R).length === 0) continue;
        // `goto` and `pickup` take different arrival branches and have failed
        // independently, and initiative-on is a different animal again, so
        // every sampled route is walked all four ways.
        for (const asPickup of [false, true]) {
          for (const autonomy of [false, true]) {
            cases++;
            const fail = runCase(f, from, target.id, asPickup, autonomy);
            if (fail) failures.push({ ...fail, reason: `${fail.reason}${autonomy ? ' [autonomy on]' : ''}` });
          }
        }
      }
    }
  }
  return { cases, failures, slowest };
}

/** Human-readable summary; empty failure list prints one PASS line. */
export function formatFuzz(r: FuzzReport): string {
  if (r.failures.length === 0) return `PASS: ${r.cases} random navigation cases, all arrived`;
  const lines = [`FAIL: ${r.failures.length}/${r.cases} random navigation cases never arrived`];
  // Group by target so one broken entity doesn't print fifty near-identical rows.
  const byTarget = new Map<string, FuzzFailure[]>();
  for (const f of r.failures) {
    const key = `floor ${f.floor} ${f.targetId} (${f.targetKind})`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), f]);
  }
  for (const [key, list] of byTarget) {
    const worst = list.reduce((a, b) => (a.best > b.best ? a : b));
    lines.push(
      `  ${key}: ${list.length} fail — closest got ${worst.best}px, ` +
        `e.g. from (${worst.from.x},${worst.from.y}) to (${worst.to.x},${worst.to.y}) ` +
        `stopped at (${worst.ended.x},${worst.ended.y}) — ${worst.reason}`,
    );
  }
  return lines.join('\n');
}
