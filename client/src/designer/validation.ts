/**
 * THE VALIDATION PANEL — the build's own floor checks, live, on the draft.
 *
 * Every red line here comes from `sim/selftest.ts`, imported, not reimplemented.
 * That is the whole point: `tools/level-designer.html` used to check enemy body
 * fit while the build did not, which made the browser tool stricter than
 * `pnpm test` — and a tool that disagrees with the suite is a tool nobody
 * believes. If it passes here it passes there, because it is the same function.
 *
 * The amber lines are the designer's own: things that are not build failures but
 * are almost always mistakes (a trigger with no actions, a robot line that has
 * stopped sounding like the robot, a corridor no machine can follow you down).
 */

import type { LevelData, TriggerAction } from '@shared/types';
import { TILE, TILES_X, TILES_Y } from '@shared/types';
import { buildSolid } from '../sim/floors';
import { levelToFloorDef } from '../sim/levelLoader';
import { ENEMY_R } from '../sim/internal';
import { isSolidTile, solidAtPx } from '../sim/physics';
import {
  checkChipClearance,
  checkCrateDistance,
  checkEntitiesInWalls,
  checkHostileFit,
  checkMapParse,
  checkRoutable,
  checkTriggerDefs,
  checkUniqueIds,
  spawnOf,
} from '../sim/selftest';
import { CUSTOM_LEVELS } from '../levels/index';
import { BUILTIN_COUNT } from './io';
import { ENTITY_KINDS, SFX_NAMES } from './palette';
import { DECOR_NAMES, LAMP_STYLE_NAMES, WALL_STYLE_NAMES } from './litAssets';
import { isSouthFace } from './litEdit';
import { el } from './ui';

export interface Focus {
  kind: 'entity' | 'trigger' | 'sound' | 'tile' | 'level' | 'decor' | 'light' | 'wet';
  id?: string;
  tx?: number;
  ty?: number;
  /** `wet` only — patches are addressed by slot. */
  index?: number;
}

export interface Finding {
  level: 'error' | 'warn';
  text: string;
  focus?: Focus;
}

const SLUG = /^[a-z0-9-]+$/;

/**
 * Selftest failures name their offender in single quotes ("entity 'mop1'
 * spawns inside a wall"). Pulling the id back out is what makes a finding
 * clickable without every check having to learn a new return type.
 */
function focusFor(level: LevelData, msg: string): Focus | undefined {
  const m = /'([^']+)'/.exec(msg);
  if (!m) return undefined;
  const id = m[1]!;
  if (level.entities.some((e) => e.id === id)) return { kind: 'entity', id };
  if (level.triggers.some((t) => t.id === id)) return { kind: 'trigger', id };
  if (level.sounds.some((s) => s.id === id)) return { kind: 'sound', id };
  if (level.decor?.some((d) => d.id === id)) return { kind: 'decor', id };
  if (level.lights?.some((l) => l.id === id)) return { kind: 'light', id };
  return undefined;
}

// ------------------------------------------------- enemy-body reachability
//
// A near-copy of the private fit field in sim/selftest.ts. `checkHostileFit`
// only walks the hostiles a level HAPPENS to contain, and the walkability law
// is about the room: a 1-tile passage is a bug on a floor with no machines on
// it yet, because the machine arrives in the next edit.

const SAMP = 4;
const FW = (TILES_X * TILE) / SAMP;
const FH = (TILES_Y * TILE) / SAMP;

function bodyFits(solid: boolean[][], x: number, y: number, r: number): boolean {
  for (let ty = Math.floor((y - r) / TILE); ty <= Math.floor((y + r) / TILE); ty++) {
    for (let tx = Math.floor((x - r) / TILE); tx <= Math.floor((x + r) / TILE); tx++) {
      if (!isSolidTile(solid, tx, ty)) continue;
      const nx = Math.max(tx * TILE, Math.min(x, tx * TILE + TILE));
      const ny = Math.max(ty * TILE, Math.min(y, ty * TILE + TILE));
      if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return false;
    }
  }
  return true;
}

/** Open tiles no r=9 body can reach from the spawn side of the room. */
function narrowTiles(solid: boolean[][], from: { x: number; y: number }): Array<{ tx: number; ty: number }> {
  const fit = new Uint8Array(FW * FH);
  for (let j = 0; j < FH; j++) {
    for (let i = 0; i < FW; i++) {
      fit[j * FW + i] = bodyFits(solid, i * SAMP + SAMP / 2, j * SAMP + SAMP / 2, ENEMY_R) ? 1 : 0;
    }
  }
  // Flood from the standable sample nearest the spawn: the spawn tile itself is
  // often a doorway a wide body cannot stand in, and that is not the bug.
  let start = -1;
  let bestD = Infinity;
  for (let j = 0; j < FH; j++) {
    for (let i = 0; i < FW; i++) {
      if (fit[j * FW + i] !== 1) continue;
      const d = (i * SAMP - from.x) ** 2 + (j * SAMP - from.y) ** 2;
      if (d < bestD) {
        bestD = d;
        start = j * FW + i;
      }
    }
  }
  if (start < 0) return [];
  const seen = new Uint8Array(FW * FH);
  const queue = new Int32Array(FW * FH);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const cur = queue[head++]!;
    const i = cur % FW;
    const j = (cur - i) / FW;
    for (const n of [
      i > 0 ? cur - 1 : -1,
      i < FW - 1 ? cur + 1 : -1,
      j > 0 ? cur - FW : -1,
      j < FH - 1 ? cur + FW : -1,
    ]) {
      if (n < 0 || seen[n] === 1 || fit[n] === 0) continue;
      seen[n] = 1;
      queue[tail++] = n;
    }
  }
  const bad: Array<{ tx: number; ty: number }> = [];
  const per = TILE / SAMP;
  for (let ty = 0; ty < TILES_Y; ty++) {
    for (let tx = 0; tx < TILES_X; tx++) {
      if (isSolidTile(solid, tx, ty)) continue;
      let ok = false;
      for (let j = ty * per; j < (ty + 1) * per && !ok; j++) {
        for (let i = tx * per; i < (tx + 1) * per; i++) {
          if (seen[j * FW + i]) {
            ok = true;
            break;
          }
        }
      }
      if (!ok) bad.push({ tx, ty });
    }
  }
  return bad;
}

// ------------------------------------------------------------- toddler-speak

/** CLAUDE.md rule 7, mechanically: third person, ≤7 words, no clauses. */
function sayProblem(line: string): string | null {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'is empty';
  if (words.length > 7) return `is ${words.length} words — the cap is 7`;
  if (/[,;:]| because | which | while | when /i.test(line)) return 'has a subordinate clause';
  if (/\b(I|I'M|IM|MY|ME)\b/i.test(line)) return 'speaks in the first person — the robot says "ROBOT"';
  if (line !== line.toUpperCase()) return 'is not upper case';
  return null;
}

// ----------------------------------------------------------------- the run

export function validate(level: LevelData): Finding[] {
  const out: Finding[] = [];
  const push = (lvl: 'error' | 'warn', text: string, focus?: Focus): void => {
    out.push({ level: lvl, text, focus });
  };

  if (!SLUG.test(level.meta.id)) {
    push('error', `level id '${level.meta.id}' is not a slug [a-z0-9-]`, { kind: 'level' });
  }
  if (level.meta.name.trim().length === 0) push('warn', 'level has no name', { kind: 'level' });

  // `replaces` puts the level IN the run. Both of these are things floors.ts
  // will refuse at build time; catching them here means finding out while the
  // level is on screen rather than at the next `pnpm test`.
  const rep = level.meta.replaces;
  if (rep !== undefined) {
    if (!Number.isInteger(rep) || rep < 1 || rep > BUILTIN_COUNT) {
      push(
        'error',
        `replaces floor ${rep}, which is not a built-in floor (want 1..${BUILTIN_COUNT}) — the level will be appended instead and the build will fail`,
        { kind: 'level' },
      );
    } else if (CUSTOM_LEVELS.some((l) => l.meta.id !== level.meta.id && l.meta.replaces === rep)) {
      push(
        'error',
        `floor ${rep} is already claimed by another level — two levels cannot stand in the same slot`,
        { kind: 'level' },
      );
    } else if (rep === BUILTIN_COUNT) {
      // The boss arena is the run's last room and the only floor the director
      // scores as a set-piece: the shredder, its music, the cliffhanger on the
      // doors. A level standing there inherits all of that with nothing to
      // hang it on.
      push(
        'warn',
        `replaces floor ${rep}, the boss arena — the shredder, its music and the cliffhanger are keyed to that slot and this level has none of them`,
        { kind: 'level' },
      );
    }
  }

  const parseFail = checkMapParse(level.map);
  if (parseFail) {
    push('error', parseFail);
    return out; // nothing below this can run on a map that will not parse
  }

  const solid = buildSolid(level.map);
  const def = levelToFloorDef(level);
  const ents = def.entities();
  const spawn = spawnOf(def, ents);
  if (!spawn) {
    push('error', 'no spawn point and no elevator A to fall back on', { kind: 'level' });
    return out;
  }
  if (solidAtPx(solid, spawn.x, spawn.y)) {
    push('error', 'the robot spawns inside a wall', { kind: 'level' });
  }

  // The build's own checks, each reported rather than short-circuited: a level
  // with three problems should show three lines, not one and then two more
  // rounds of "fix, save, discover the next one".
  const suite: Array<[string, string | null]> = [
    ['entities in walls', checkEntitiesInWalls(solid, ents)],
    ['unique ids', checkUniqueIds(ents)],
    ['chip clearance', checkChipClearance(solid, ents)],
    ['routable', checkRoutable(solid, spawn, ents)],
    ['hostile fit', checkHostileFit(solid, spawn, ents)],
    ['crate distance', checkCrateDistance(spawn, ents)],
    ['trigger defs', checkTriggerDefs(def, ents)],
  ];
  for (const [, msg] of suite) {
    if (msg) push('error', msg, focusFor(level, msg));
  }

  // ------------------------------------------------------- designer's own
  const ids = new Set<string>();
  for (const e of level.entities) {
    if (!ENTITY_KINDS.includes(e.kind)) push('error', `entity '${e.id}' has unknown kind '${e.kind}'`, { kind: 'entity', id: e.id });
    if (e.tx < 0 || e.ty < 0 || e.tx >= TILES_X || e.ty >= TILES_Y) {
      push('error', `entity '${e.id}' is off the map`, { kind: 'entity', id: e.id });
    }
    if (ids.has(e.id)) push('error', `duplicate id '${e.id}'`, { kind: 'entity', id: e.id });
    ids.add(e.id);
  }
  for (const s of level.sounds) {
    if (ids.has(s.id)) push('error', `duplicate id '${s.id}'`, { kind: 'sound', id: s.id });
    ids.add(s.id);
    if (!SFX_NAMES.includes(s.sound)) {
      push('error', `emitter '${s.id}' plays unknown sound '${s.sound}'`, { kind: 'sound', id: s.id });
    }
    if (s.radiusPx <= 0) push('warn', `emitter '${s.id}' has no radius — it is silent`, { kind: 'sound', id: s.id });
  }
  for (const t of level.triggers) {
    if (t.actions.length === 0) {
      push('warn', `trigger '${t.id}' does nothing`, { kind: 'trigger', id: t.id });
    }
    for (const a of t.actions) checkAction(a, t.id, level, push);
  }

  if (!level.entities.some((e) => e.kind === 'elevatorB')) {
    push('warn', 'no elevator B — the floor has no exit', { kind: 'level' });
  }
  if (!level.entities.some((e) => e.kind === 'elevatorA')) {
    push('warn', 'no elevator A — the robot arrives from nowhere', { kind: 'level' });
  }

  checkLit(level, push);

  const narrow = narrowTiles(solid, spawn);
  if (narrow.length > 0) {
    const first = narrow[0]!;
    push(
      'warn',
      `walkability law: ${narrow.length} floor tile${narrow.length === 1 ? '' : 's'} an r=${ENEMY_R} machine cannot reach (first at ${first.tx},${first.ty}) — passages must be ≥2 tiles wide`,
      { kind: 'tile', tx: first.tx, ty: first.ty },
    );
  }
  return out;
}

// ------------------------------------------------------------ the lit half
//
// None of these are build failures in the sense the selftest means — a level
// with a sconce on a wall top still loads and still plays. They are all the
// same class of problem: something that will not LOOK like what it was authored
// to look like, and that is invisible until the room is dark.

/** Shadow-casting lights each cost a full-screen bake. The lab runs ~10. */
const CASTER_WARN = 12;

function checkLit(
  level: LevelData,
  push: (lvl: 'error' | 'warn', text: string, focus?: Focus) => void,
): void {
  const decor = level.decor ?? [];
  const lights = level.lights ?? [];
  const fixtures = level.fixtures ?? [];
  const wet = level.wetPatches ?? [];
  const solidAt = (tx: number, ty: number): boolean => level.map[ty]?.[tx] === '#';

  const lightIds = new Set(lights.map((l) => l.id));
  const fixtureIds = new Set(fixtures.map((f) => f.id));
  const seen = new Set<string>();

  for (const d of decor) {
    if (!DECOR_NAMES.includes(d.name)) {
      push('error', `decor '${d.id}' is an unknown prop '${d.name}'`, { kind: 'decor', id: d.id });
    }
    if (seen.has(d.id)) push('error', `duplicate decor id '${d.id}'`, { kind: 'decor', id: d.id });
    seen.add(d.id);
    if (d.tx < 0 || d.ty < 0 || d.tx > TILES_X || d.ty > TILES_Y) {
      push('warn', `decor '${d.id}' is off the map`, { kind: 'decor', id: d.id });
    }
    if (!d.fixtureId) continue;

    // ---- the three-way link
    if (!fixtureIds.has(d.fixtureId)) {
      push('error', `decor '${d.id}' claims fixture '${d.fixtureId}', which has no FixtureDef`, {
        kind: 'decor',
        id: d.id,
      });
    }
    if (!lightIds.has(d.fixtureId)) {
      push('error', `fixture '${d.fixtureId}' has no light — the lamp draws but nothing lights`, {
        kind: 'decor',
        id: d.id,
      });
    }
    if (d.fixtureKind !== 'wall') continue;

    /**
     * Wall mounts only work on a SOUTH-facing face: a solid tile with open
     * floor under it. Every other wall renders as a wall TOP in this
     * projection, and a sconce bolted to one is a sprite lying on a ceiling.
     * README rule 2's neighbour, and the single most common way to author a
     * lamp that does not exist.
     */
    // The same test the placement tool snaps to, imported rather than
    // restated: a rule the tool and the checker disagree about is a rule that
    // lets you place a lamp the panel then calls an error.
    const col = Math.floor(d.tx);
    const row = Math.floor(d.ty);
    if (!isSouthFace(level, col, row) && !isSouthFace(level, col, row - 1)) {
      push(
        'error',
        `wall lamp '${d.id}' is not on a south-facing wall face — a wall tile with open floor under it`,
        { kind: 'decor', id: d.id },
      );
    }
  }

  let casters = 0;
  for (const l of lights) {
    if (seen.has(l.id)) push('error', `duplicate light id '${l.id}'`, { kind: 'light', id: l.id });
    seen.add(l.id);
    if (l.radius <= 0) push('warn', `light '${l.id}' has no radius`, { kind: 'light', id: l.id });
    if (l.intensity <= 0) {
      push('warn', `light '${l.id}' has zero intensity — it is off`, { kind: 'light', id: l.id });
    }
    if (l.castShadow !== false) casters++;
    if (l.kind === 'cone' && l.dir === undefined) {
      push('warn', `cone '${l.id}' has no aim — it points right`, { kind: 'light', id: l.id });
    }
  }
  if (casters > CASTER_WARN) {
    push(
      'warn',
      `${casters} shadow-casting lights — each is a full-screen bake, and the lab holds ~10. Turn castShadow off on the accents`,
      { kind: 'level' },
    );
  }

  for (const f of fixtures) {
    const owner = decor.find((d) => d.fixtureId === f.id);
    if (!owner) {
      push('warn', `fixture '${f.id}' has no decor pointing at it — nothing draws it`, { kind: 'level' });
      // `fixtureKind` DEFAULTS to 'ceiling' (see DecorPlacement, and the same
      // fallback in render/lit/scene.ts). The placement tool always writes the
      // field, so a hand-authored ceiling lamp that leaves it out was the one
      // way to earn "is a ceiling mount but its prop says ceiling".
    } else if ((owner.fixtureKind ?? 'ceiling') !== f.kind) {
      push('error', `fixture '${f.id}' is a ${f.kind} mount but its prop says ${owner.fixtureKind}`, {
        kind: 'decor',
        id: owner.id,
      });
    }
    const names = f.kind === 'wall' ? WALL_STYLE_NAMES : LAMP_STYLE_NAMES;
    if (!(names as readonly string[]).includes(f.style)) {
      push('error', `fixture '${f.id}' has unknown style '${f.style}'`, { kind: 'level' });
    }
  }

  wet.forEach((w, i) => {
    const inside = w.tx >= 0 && w.ty >= 0 && w.tx <= TILES_X && w.ty <= TILES_Y;
    if (!inside) push('warn', `wet patch ${i + 1} is off the map`, { kind: 'wet', index: i });
    if (w.rx <= 0 || w.ry <= 0) {
      push('warn', `wet patch ${i + 1} has no size`, { kind: 'wet', index: i });
    }
  });

  for (const o of level.tiles?.overrides ?? []) {
    if (o.tx < 0 || o.ty < 0 || o.tx >= TILES_X || o.ty >= TILES_Y) {
      push('error', `floor variant override at ${o.tx},${o.ty} is off the map`, { kind: 'level' });
    } else if (solidAt(o.tx, o.ty)) {
      push('warn', `floor variant at ${o.tx},${o.ty} is under a wall`, {
        kind: 'tile',
        tx: o.tx,
        ty: o.ty,
      });
    }
    if (o.variant < 0 || o.variant > 7 || !Number.isInteger(o.variant)) {
      push('error', `floor variant ${o.variant} at ${o.tx},${o.ty} is outside the 0-7 contract`, {
        kind: 'tile',
        tx: o.tx,
        ty: o.ty,
      });
    }
  }
  for (const row of level.tiles?.walkRows ?? []) {
    if (row < 0 || row >= TILES_Y) push('error', `hazard lane row ${row} is off the map`, { kind: 'level' });
  }
}

function checkAction(
  a: TriggerAction,
  trigId: string,
  level: LevelData,
  push: (lvl: 'error' | 'warn', text: string, focus?: Focus) => void,
): void {
  const focus: Focus = { kind: 'trigger', id: trigId };
  switch (a.type) {
    case 'say': {
      const bad = sayProblem(a.line);
      if (bad) push('warn', `trigger '${trigId}' says a line that ${bad}`, focus);
      break;
    }
    case 'sfx':
      if (!SFX_NAMES.includes(a.sound)) {
        push('error', `trigger '${trigId}' plays unknown sound '${a.sound}'`, focus);
      }
      break;
    case 'spawn':
      if (level.entities.some((e) => e.id === a.entity.id)) {
        push('error', `trigger '${trigId}' spawns '${a.entity.id}', which is already on the floor`, focus);
      }
      break;
    case 'setTiles':
      if (a.tiles.length === 0) push('warn', `trigger '${trigId}' sets no tiles`, focus);
      break;
    // A `light` action pointed at a light this level does not have is already
    // a red line: `checkTriggerDefs` in sim/selftest.ts checks it, this panel
    // runs that function, and the empty target fails the same test. A second
    // line here would say the same thing twice — which is how a checks panel
    // stops being read.
    default:
      break;
  }
}

// ------------------------------------------------------------------- panel

export interface PanelOpts {
  onFocus: (focus: Focus) => void;
  onSummary: (errors: number, warns: number) => void;
}

/** Debounced live panel. Findings are clickable — a click selects the offender. */
export class ValidationPanel {
  readonly root = el('div', 'rd-pane rd-hidden');
  private timer = 0;
  private last: Finding[] = [];

  constructor(private opts: PanelOpts) {}

  get findings(): readonly Finding[] {
    return this.last;
  }

  schedule(level: LevelData): void {
    clearTimeout(this.timer);
    // 220ms: long enough that a paint stroke validates once, short enough that
    // it still feels like the panel is watching you draw.
    this.timer = window.setTimeout(() => this.run(level), 220);
  }

  run(level: LevelData): void {
    let findings: Finding[];
    try {
      findings = validate(level);
    } catch (err) {
      findings = [{ level: 'error', text: `validation crashed: ${String(err)}` }];
    }
    this.last = findings;
    this.paint(findings);
    this.opts.onSummary(
      findings.filter((f) => f.level === 'error').length,
      findings.filter((f) => f.level === 'warn').length,
    );
  }

  private paint(findings: readonly Finding[]): void {
    this.root.replaceChildren();
    if (findings.length === 0) {
      this.root.appendChild(el('div', 'rd-pass', '✓ level passes every build check'));
      return;
    }
    for (const f of findings) {
      const row = el('div', `rd-find ${f.level === 'error' ? 'rd-err' : 'rd-warn'}`);
      row.append(el('span', 'rd-dot'), el('span', undefined, f.text));
      if (f.focus) {
        row.title = 'click to select';
        row.addEventListener('click', () => this.opts.onFocus(f.focus!));
      }
      this.root.appendChild(row);
    }
  }
}
