/**
 * Determinism selftest: two scripted 600-tick runs from seed 42 must produce
 * bit-identical JSON state every tick. Also sanity-checks floor maps and the
 * pinned entity ids the director depends on.
 */
import type { SimState } from '../../../shared/types';
import { FLOORS, buildSolid } from './floors';
import {
  addAvoid,
  applyBrain,
  applyChip,
  applyDirectives,
  clearBriefing,
  initialState,
  loadFloor,
  setOrder,
  step,
  wakeRobot,
} from './index';
import { findPath } from './pathfind';
import { dist, solidAtPx } from './physics';
import { CRATE_NOTICE, ROBOT_R } from './internal';

const TICKS = 600;

/** Indexed by floor. Moves with the running order in floors.ts. */
const PINNED_IDS: string[][] = [
  ['elevA', 'elevB', 'pile1', 'pile2', 'scrap1'], // 1 opening
  ['elevA', 'elevB', 'chip_memory', 'scrap1', 'scrap2'], // 2 memory chip
  ['elevA', 'elevB', 'cable1', 'cable2', 'scrap1', 'scrap2'], // 3 movement
  ['elevA', 'elevB', 'crate_BRAIN', 'printer1', 'cable1', 'mop1'], // 4 gauntlet
  ['elevA', 'elevB', 'fuse1', 'socket1', 'printer1', 'printer2', 'printer3', 'printer_nice', 'cable1'], // 5 fuse run
];

/** Floor INDICES the behaviour tests reach for by name, so a reshuffle of the
 *  running order is a one-line edit here instead of a hunt through the file. */
const FLOOR_ISLAND_I = 1; // the island that blocks the straight A→B line
const FLOOR_MOVEMENT_I = 2; // two doors, one wired
const FLOOR_GAUNTLET_I = 3; // roaming printer, open colonnade
const FLOOR_MACHINE_I = 4; // three machines and the fuse run

/** Scripted order sequence — exercises movement, nudges, chips, combat, rng, floor load. */
function script(t: number, s: SimState): void {
  switch (t) {
    case 1:
      // The robot starts asleep in the floor-1 pile; nothing runs until the
      // player's voice wakes it. Every scripted run must do this first.
      wakeRobot(s);
      clearBriefing(s); // the scripted run stands in for a briefed operator
      setOrder(s, { kind: 'move', dir: 'right' });
      break;
    case 60:
      // nudge: must halt + emit order_done after ~20px, well before t=100
      setOrder(s, { kind: 'move', dir: 'down', distancePx: 20 });
      break;
    case 100:
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
      // The scripted run needs a floor with a printer, a cable and scrap2 on
      // it — that is the first-machine floor wherever it currently sits.
      loadFloor(s, FLOOR_MACHINE_I);
      setOrder(s, { kind: 'attack', targetId: 'printer1' });
      break;
    case 470:
      applyChip(s, 'RAGE');
      setOrder(s, { kind: 'move', dir: 'left' });
      break;
    case 520:
      setOrder(s, { kind: 'goto', targetId: 'elevB' });
      break;
    case 540:
      // hide picks cover (LOS raycast) and paths to it; avoid steers wide.
      applyBrain(s);
      addAvoid(s, 'cable1');
      setOrder(s, { kind: 'hide' });
      break;
    case 555:
      // Standing rules change how every later order is executed — they have to
      // be in the deterministic run, not just in the director.
      applyDirectives(s, ['avoid_enemies', 'careful']);
      setOrder(s, { kind: 'retreat' });
      break;
    case 570:
      applyDirectives(s, ['fight_enemies', 'no_gather']);
      setOrder(s, { kind: 'goto', targetId: 'fuse1', careful: true });
      break;
    case 585:
      // explore consumes the seeded rng on wander legs — the run must stay
      // bit-identical with it in the mix.
      setOrder(s, { kind: 'explore' });
      break;
  }
}

/**
 * Every floor must be WALKABLE end to end. Straight-line seeking used to hide
 * this: a robot that shoves at a wall for four seconds looks stuck either way.
 * With real routing, an unreachable exit is a soft-locked floor, so it is a
 * build failure now.
 */
function floorsRoutable(): string | null {
  for (let i = 0; i < FLOORS.length; i++) {
    const def = FLOORS[i];
    const solid = buildSolid(def.map);
    const ents = def.entities();
    const spawn = def.spawn ?? ents.find((e) => e.id === 'elevA')!.pos;
    for (const e of ents) {
      // Decor and hazards may sit anywhere; anything the robot is expected to
      // reach must have a route from where it starts the floor.
      if (e.kind === 'debris' || e.kind === 'cable' || e.kind === 'elevatorA') continue;
      if (findPath(solid, spawn, e.pos, ROBOT_R).length === 0) {
        return `FAIL: floor index ${i} has no route from spawn to '${e.id}'`;
      }
    }
  }
  return null;
}

/**
 * A floor whose only chip can't be walked into is a dead reward. Verify each
 * chip sits on open floor with room for the robot's r=7 body around it.
 */
function chipsReachable(): string | null {
  for (let i = 0; i < FLOORS.length; i++) {
    const solid = buildSolid(FLOORS[i].map);
    for (const e of FLOORS[i].entities()) {
      if (e.kind !== 'chip') continue;
      for (const [dx, dy] of [[0, 0], [-8, 0], [8, 0], [0, -8], [0, 8]] as const) {
        if (solidAtPx(solid, e.pos.x + dx, e.pos.y + dy)) {
          return `FAIL: floor index ${i} chip '${e.id}' has no clearance at (${dx},${dy})`;
        }
      }
    }
  }
  return null;
}

/**
 * The headline claim: ordered somewhere on the far side of an obstacle, the
 * robot ARRIVES. The island floor's centre island sits squarely across the
 * straight line from elevator A to elevator B, so the old "seek and slide
 * along the wall" robot parked against it forever. If this ever regresses, the game is
 * back to being a car that steers into masonry.
 */
function routesAroundObstacles(): string | null {
  const s = initialState(11);
  wakeRobot(s);
  loadFloor(s, FLOOR_ISLAND_I);
  const goal = s.entities.find((e) => e.id === 'elevB')!;
  // Cut the power: a lit exit ends the floor at ELEV_REACH, which is further
  // out than the arrival radius this measures. We want the walk, not the ride.
  goal.state = 'dark';
  setOrder(s, { kind: 'goto', targetId: goal.id });
  for (let t = 0; t < 900; t++) {
    step(s);
    if (dist(s.robot.pos, goal.pos) <= 16) {
      return null;
    }
  }
  return `FAIL: robot never reached elevB around the island (stopped at ${Math.round(s.robot.pos.x)},${Math.round(s.robot.pos.y)}, ${Math.round(dist(s.robot.pos, goal.pos))}px short)`;
}

/**
 * Initiative has THREE settings and the middle one is the default. Left alone,
 * the robot stays where it is and ASKS — it does not run the level for you.
 * Only a spoken "do your own thing" sends it wandering, and "wait for me"
 * shuts even the asking up. Getting this ladder wrong in either direction is
 * what makes the robot feel either dead or out of control.
 */
function actsOnItsOwn(): string | null {
  // Default: reactive only. It must not wander off — but it must speak up.
  const quiet = initialState(23);
  wakeRobot(quiet);
  const quietStart = { x: quiet.robot.pos.x, y: quiet.robot.pos.y };
  let asked = false;
  for (let t = 0; t < 600; t++) {
    step(quiet);
    if (quiet.events.some((e) => e.type === 'need_orders')) asked = true;
  }
  if (dist(quiet.robot.pos, quietStart) > 24) {
    return 'FAIL: robot wandered off unprompted with roam off';
  }
  if (!asked) return 'FAIL: idle robot never asked the operator for a job';

  // "do your own thing": now it goes looking, and marks the order as its own.
  const free = initialState(23);
  wakeRobot(free);
  applyDirectives(free, ['act_alone']);
  clearBriefing(free);
  const freeStart = { x: free.robot.pos.x, y: free.robot.pos.y };
  let announced = false;
  for (let t = 0; t < 400; t++) {
    step(free);
    if (free.events.some((e) => e.type === 'self_order')) announced = true;
  }
  if (!announced) return 'FAIL: roaming robot never chose a task of its own (no self_order)';
  if (!free.robot.selfDriven) return 'FAIL: robot acted but never marked the order self-driven';
  if (dist(free.robot.pos, freeStart) < 8) return 'FAIL: roaming robot never went anywhere';

  // "wait for me": no wandering AND no nagging.
  const held = initialState(23);
  wakeRobot(held);
  applyDirectives(held, ['wait_for_orders']);
  const heldStart = { x: held.robot.pos.x, y: held.robot.pos.y };
  for (let t = 0; t < 600; t++) {
    step(held);
    if (held.events.some((e) => e.type === 'need_orders')) {
      return 'FAIL: robot asked for orders under a standing "wait for orders" rule';
    }
  }
  if (dist(held.robot.pos, heldStart) > 1) {
    return 'FAIL: robot moved under a standing "wait for orders" rule';
  }
  return null;
}

/**
 * Every floor opens on a briefing. Even a robot that has been told to roam
 * holds at the doors of a NEW floor until it is spoken to — walking out of the
 * lift already busy is how floor 2 used to start wandering off on its own.
 */
function holdsAtEveryFloor(): string | null {
  const s = initialState(31);
  wakeRobot(s);
  applyDirectives(s, ['act_alone']);
  clearBriefing(s);
  loadFloor(s, 1); // rode the lift up: new floor, new briefing
  if (!s.robot.awaitingBriefing) return 'FAIL: new floor did not re-arm the briefing hold';
  // The director parks the robot immediately after a floor loads. Clearing an
  // order is not being briefed, and must not cancel the hold it just armed.
  setOrder(s, null);
  if (!s.robot.awaitingBriefing) return 'FAIL: setOrder(null) cancelled the briefing hold';
  if (s.robot.standing.roam) return 'FAIL: "do your own thing" leaked across a floor change';
  const start = { x: s.robot.pos.x, y: s.robot.pos.y };
  for (let t = 0; t < 600; t++) step(s);
  if (dist(s.robot.pos, start) > 4) return 'FAIL: robot left the lift doors before being briefed';
  // ...and one word from the operator releases it.
  applyDirectives(s, ['act_alone']);
  clearBriefing(s);
  for (let t = 0; t < 400; t++) step(s);
  if (dist(s.robot.pos, start) < 8) return 'FAIL: robot stayed frozen after being briefed';
  return null;
}

/**
 * Seeing a machine is a REPORT, not a charge. The robot calls it out and holds
 * for instructions; only an explicit "fight everything" sends it in. This is
 * the difference between a companion and a runaway.
 */
function reportsThreatsInsteadOfCharging(): string | null {
  const s = initialState(37);
  wakeRobot(s);
  loadFloor(s, FLOOR_GAUNTLET_I); // a roaming printer in an open colonnade
  clearBriefing(s);
  const printer = s.entities.find((e) => e.id === 'printer1')!;
  // Place it in clear view but OUTSIDE the printer's notice range, so the
  // machine stays idle: this measures what the robot decides unprovoked, not
  // whether it defends itself (it does, and that is a different test).
  s.robot.pos = { x: printer.pos.x + 125, y: printer.pos.y };
  let called = false;
  for (let t = 0; t < 60; t++) {
    step(s);
    if (s.events.some((e) => e.type === 'threat_seen')) called = true;
    if (s.robot.order?.kind === 'attack') {
      return 'FAIL: robot charged a machine unprompted (should hold and report)';
    }
  }
  if (!called) return 'FAIL: robot never reported the machine it could plainly see';

  // "Fight everything" — NOW it goes.
  applyDirectives(s, ['fight_enemies']);
  let engaged = false;
  for (let t = 0; t < 90; t++) {
    step(s);
    if (s.robot.order?.kind === 'attack') engaged = true;
  }
  if (!engaged) return 'FAIL: robot would not engage even after "fight everything"';

  // Restraint is not pacifism. Something that comes for it gets shot, with no
  // order and no directive — a robot that politely dies while waiting to be
  // told it may defend itself is worse than one that charges.
  const jumped = initialState(41);
  wakeRobot(jumped);
  loadFloor(jumped, FLOOR_MACHINE_I);
  clearBriefing(jumped);
  const attacker = jumped.entities.find((e) => e.id === 'printer1')!;
  const hp0 = attacker.hp!;
  jumped.robot.pos = { x: attacker.pos.x, y: attacker.pos.y + 34 }; // well inside its notice range
  for (let t = 0; t < 120; t++) step(jumped);
  if ((attacker.hp ?? 0) >= hp0 && !attacker.dead) {
    return 'FAIL: robot never shot back at a machine that came for it';
  }
  if (jumped.robot.order?.kind === 'attack') {
    return 'FAIL: returning fire escalated into a self-ordered attack';
  }
  return null;
}

/**
 * A crate is the reason to cross a floor, and it opens by PROXIMITY at
 * CRATE_NOTICE. Park one within that radius of the spawn and the ceremony
 * fires on the first tick: the player is handed the upgrade before they have
 * looked at the room, and never sees the box closed at all. Every crate has to
 * be somewhere you walk to.
 */
function cratesAreSomewhereToWalkTo(): string | null {
  const MIN = CRATE_NOTICE + 40; // notice radius plus a real walk
  for (let i = 0; i < FLOORS.length; i++) {
    const def = FLOORS[i];
    const ents = def.entities();
    const spawn = def.spawn ?? ents.find((e) => e.id === 'elevA')!.pos;
    for (const e of ents) {
      if (e.kind !== 'crate') continue;
      const d = dist(spawn, e.pos);
      if (d < MIN) {
        return `FAIL: floor index ${i} crate '${e.id}' is ${Math.round(d)}px from spawn — it opens itself before the player sees it (want ≥${MIN})`;
      }
    }
  }
  return null;
}

/**
 * Floor 2 is the movement lesson and it only teaches if BOTH halves are true:
 * left alone the robot takes the wired door and gets bitten, and a standing
 * "avoid the sparks" makes it take the clean one instead. If the rule cannot
 * change which door it picks, the floor is just a corridor with a tax on it.
 */
function floorTwoTeachesRouteChoice(): string | null {
  const run = (avoidHazards: boolean): { hurt: boolean; arrived: boolean } => {
    const s = initialState(53);
    wakeRobot(s);
    loadFloor(s, FLOOR_MOVEMENT_I);
    clearBriefing(s);
    s.robot.standing.autonomy = false;
    s.robot.standing.avoidHazards = avoidHazards;
    const exit = s.entities.find((e) => e.id === 'elevB')!;
    exit.state = 'dark'; // measure the walk, not the floor ending mid-walk
    setOrder(s, { kind: 'goto', targetId: 'elevB' });
    let hurt = false;
    for (let t = 0; t < 1400; t++) {
      step(s);
      if (s.events.some((e) => e.type === 'robot_damage')) hurt = true;
      if (s.robot.order === null) break;
    }
    return { hurt, arrived: dist(s.robot.pos, exit.pos) <= 20 };
  };

  const careless = run(false);
  if (!careless.arrived) return 'FAIL: the movement floor — robot could not reach the exit at all';
  if (!careless.hurt) {
    return 'FAIL: the movement floor — the default route no longer costs anything, so the floor teaches nothing';
  }
  const careful = run(true);
  if (!careful.arrived) return 'FAIL: the movement floor — "avoid the sparks" left the robot unable to reach the exit';
  if (careful.hurt) {
    return 'FAIL: the movement floor — "avoid the sparks" did not change which door the robot took';
  }
  return null;
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
    const spawn = FLOORS[i].spawn ?? ents.find((e) => e.id === 'elevA')?.pos;
    if (!spawn) return `FAIL: floor index ${i} has no spawn point`;
    if (solidAtPx(solid, spawn.x, spawn.y)) {
      return `FAIL: floor index ${i} spawns the robot inside a wall`;
    }
  }
  const chipFail = chipsReachable();
  if (chipFail) return chipFail;
  const routeFail = floorsRoutable();
  if (routeFail) return routeFail;
  const navFail = routesAroundObstacles();
  if (navFail) return navFail;
  const initFail = actsOnItsOwn();
  if (initFail) return initFail;
  const holdFail = holdsAtEveryFloor();
  if (holdFail) return holdFail;
  const threatFail = reportsThreatsInsteadOfCharging();
  if (threatFail) return threatFail;
  const crateFail = cratesAreSomewhereToWalkTo();
  if (crateFail) return crateFail;
  const lessonFail = floorTwoTeachesRouteChoice();
  if (lessonFail) return lessonFail;

  // The opening beat only works if the robot really is inert until woken.
  const sleeping = initialState(7);
  setOrder(sleeping, { kind: 'move', dir: 'right' });
  const x0 = sleeping.robot.pos.x;
  for (let t = 0; t < 60; t++) step(sleeping);
  if (sleeping.robot.pos.x !== x0) return 'FAIL: dormant robot moved before wakeRobot()';
  wakeRobot(sleeping);
  for (let t = 0; t < 60; t++) step(sleeping);
  if (sleeping.robot.pos.x === x0) return 'FAIL: robot did not move after wakeRobot()';

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
