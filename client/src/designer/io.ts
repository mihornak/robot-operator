/**
 * LOADING, SAVING, AND THE ESCAPE HATCH.
 *
 * Saving writes a source file through the dev-only Vite plugin
 * (`POST /__designer/save`). That endpoint cannot exist in a built bundle —
 * rule 1 — so everything here degrades: the level list falls back to the levels
 * compiled into the bundle, and `Copy TS` emits the exact same file content the
 * server would have written, for pasting by hand.
 *
 * `levelSource` is deliberately a duplicate of the plugin's own emitter. Two
 * copies of a five-line template is the cheap half of the trade; the expensive
 * half would be the browser importing a Node plugin module to get it.
 */

import type { Entity, LevelData, LevelEntityDef } from '@shared/types';
import { TILE, TILES_X, TILES_Y } from '@shared/types';
import type { FloorDef } from '../sim/floors';
import { BUILTIN_FLOORS } from '../sim/floors';
import { CUSTOM_LEVELS } from '../levels/index';
import { blankLevel } from './store';

/**
 * How many hand-authored floors there are.
 *
 * Read off BUILTIN_FLOORS rather than off `FLOORS.length - CUSTOM_LEVELS.length`,
 * which stopped being the same number the day a level could REPLACE a built-in:
 * a replacing level occupies a slot instead of adding one, so the subtraction
 * undercounts by one per replacement and the list loses its last floor.
 */
export const BUILTIN_COUNT = BUILTIN_FLOORS.length;

export interface LevelChoice {
  key: string;
  label: string;
  /** Built-ins are TS builders — read-only here; "Duplicate" makes them yours. */
  builtin: boolean;
}

export function levelChoices(): LevelChoice[] {
  const out: LevelChoice[] = [];
  for (let i = 0; i < BUILTIN_COUNT; i++) {
    out.push({ key: `builtin:${i}`, label: `built-in · floor ${i + 1}`, builtin: true });
  }
  for (const lv of [...CUSTOM_LEVELS].sort((a, b) => a.meta.order - b.meta.order)) {
    out.push({ key: `custom:${lv.meta.id}`, label: `${lv.meta.name} (${lv.meta.id})`, builtin: false });
  }
  return out;
}

const px2tile = (v: number): number => Math.round(v / TILE - 0.5);

/** One live entity back into the data that would have produced it. */
function defOf(e: Entity): LevelEntityDef {
  const def: LevelEntityDef = {
    id: e.id,
    kind: e.kind,
    tx: Math.max(0, Math.min(TILES_X - 1, px2tile(e.pos.x))),
    ty: Math.max(0, Math.min(TILES_Y - 1, px2tile(e.pos.y))),
    // Always written: a duplicate that silently re-derives its labels from the
    // builders would quietly change what the player can say to it.
    label: e.label,
  };
  if (e.option !== undefined) def.option = e.option;
  if (e.hp !== undefined) def.hp = e.hp;
  if (e.state === 'dormant') def.dormant = true;
  if (e.kind === 'elevatorB' && e.state === 'dark') def.dark = true;
  return def;
}

/**
 * A built-in floor as editable data. Lossy by construction: the built-ins place
 * entities on half-tiles (`at(15, 7.5)`) and levels are tile-addressed, so a
 * duplicate can land a pixel or eight off. It is a starting point, not a port.
 */
export function floorToLevel(def: FloorDef, index: number): LevelData {
  const ents = def.entities();
  const level: LevelData = {
    meta: {
      id: def.meta?.id ?? `floor-${index + 1}-copy`,
      name: def.meta?.name ?? `FLOOR ${index + 1} COPY`,
      order: def.meta?.order ?? index,
    },
    map: [...def.map],
    entities: ents.map(defOf),
    triggers: def.triggers ? JSON.parse(JSON.stringify(def.triggers)) : [],
    sounds: def.sounds ? JSON.parse(JSON.stringify(def.sounds)) : [],
  };
  if (def.spawn) level.spawn = { tx: px2tile(def.spawn.x), ty: px2tile(def.spawn.y) };
  // A built-in that carries lit data (none do today — the hand-authored floors
  // are classic) unpacks straight back into the level fields it came from.
  const lit = def.lit;
  if (lit) {
    if (lit.seed !== undefined) level.meta.seed = lit.seed;
    if (lit.decor) level.decor = JSON.parse(JSON.stringify(lit.decor)) as LevelData['decor'];
    if (lit.lights) level.lights = JSON.parse(JSON.stringify(lit.lights)) as LevelData['lights'];
    if (lit.fixtures) level.fixtures = JSON.parse(JSON.stringify(lit.fixtures)) as LevelData['fixtures'];
    if (lit.wetPatches) level.wetPatches = JSON.parse(JSON.stringify(lit.wetPatches)) as LevelData['wetPatches'];
    if (lit.look) level.look = { ...lit.look };
    if (lit.tiles) level.tiles = JSON.parse(JSON.stringify(lit.tiles)) as LevelData['tiles'];
  }
  return level;
}

export function levelFor(key: string): LevelData | null {
  if (key.startsWith('builtin:')) {
    // The BUILT-IN, never `FLOORS[i]` — a slot a level has replaced holds that
    // level, and "built-in · floor 1" offering a copy of the custom level
    // standing in floor 1 is a duplicate button that duplicates the wrong room.
    const i = Number(key.slice(8));
    const def = BUILTIN_FLOORS[i];
    return def ? floorToLevel(def, i) : null;
  }
  const id = key.slice(7);
  const found = CUSTOM_LEVELS.find((l) => l.meta.id === id);
  return found ? (JSON.parse(JSON.stringify(found)) as LevelData) : null;
}

export function newLevel(): LevelData {
  return blankLevel();
}

/**
 * The draft as it should be WRITTEN: no empty lit arrays, no lit keys the level
 * never authored.
 *
 * The lit half is optional all the way down (`levelToFloorDef` decides a level
 * is lit by asking whether any of it is non-empty), so a level that had a prop
 * placed and then undone must not save `"decor": []` — that is a file that
 * claims to be a lit level and renders as a black room. The store prunes as it
 * goes; this is the belt to that pair of braces, and it is also what makes a
 * save/load round-trip byte-identical.
 */
export function cleanLevel(level: LevelData): LevelData {
  const out: LevelData = {
    meta: { ...level.meta },
    map: [...level.map],
    entities: level.entities,
    triggers: level.triggers,
    sounds: level.sounds,
  };
  if (level.spawn) out.spawn = { ...level.spawn };
  if (out.meta.seed === undefined) delete out.meta.seed;
  // Blank in the inspector means "append", and append is the ABSENCE of the
  // key — a level carrying `"replaces": null` is a level claiming slot -1.
  if (out.meta.replaces === undefined || out.meta.replaces === null) delete out.meta.replaces;
  if (level.decor?.length) out.decor = level.decor;
  if (level.lights?.length) out.lights = level.lights;
  if (level.fixtures?.length) out.fixtures = level.fixtures;
  if (level.wetPatches?.length) out.wetPatches = level.wetPatches;
  if (level.look && Object.keys(level.look).length > 0) out.look = level.look;
  if (level.tiles && (level.tiles.walkRows?.length || level.tiles.overrides?.length)) {
    out.tiles = level.tiles;
  }
  return out;
}

/** Byte-for-byte what `POST /__designer/save` writes to disk. */
export function levelSource(level: LevelData): string {
  return `/**
 * GENERATED by the level designer (/designer.html). Edit it there and save —
 * a hand edit here survives, but the designer overwrites the whole file.
 */
import type { LevelData } from '../../../shared/types';

export const LEVEL: LevelData = ${JSON.stringify(cleanLevel(level), null, 2)};
`;
}

/**
 * A pasted `.level.ts` file or a bare JSON object. The generated file is
 * `JSON.stringify` output with a header, so slicing to the outermost braces and
 * parsing as JSON reads both without an eval.
 */
export function parseLevelSource(text: string): { level: LevelData } | { error: string } {
  const end = text.lastIndexOf('}');
  if (end < 0) return { error: 'no object literal found' };
  // The first `{` in a .level.ts file belongs to `import type { LevelData }`,
  // not to the level — so the assignment is tried first, and the bare-JSON
  // case (no `=` anywhere) falls back to the first brace.
  const starts: number[] = [];
  const assign = /=\s*\{/.exec(text);
  if (assign) starts.push(assign.index + assign[0].length - 1);
  const first = text.indexOf('{');
  if (first >= 0 && !starts.includes(first)) starts.push(first);
  if (starts.length === 0) return { error: 'no object literal found' };

  let value: unknown;
  let lastErr = 'no object literal found';
  for (const start of starts) {
    if (start >= end) continue;
    try {
      value = JSON.parse(text.slice(start, end + 1));
      lastErr = '';
      break;
    } catch (err) {
      lastErr = `not parseable as JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (lastErr) return { error: lastErr };
  const level = value as LevelData;
  if (!level || typeof level !== 'object' || !level.meta || typeof level.meta.id !== 'string') {
    return { error: 'no meta.id — this is not a LevelData' };
  }
  if (!Array.isArray(level.map) || level.map.length !== TILES_Y) {
    return { error: `map must have exactly ${TILES_Y} rows` };
  }
  level.entities ??= [];
  level.triggers ??= [];
  level.sounds ??= [];
  // The lit half stays ABSENT when it is absent. A v1 level (no decor, no
  // lights, no look) has to keep rendering on the classic path, and defaulting
  // these to `[]` here would quietly promote every old level to a lit one with
  // nothing in it — which is a black room.
  return { level };
}

/** Custom level ids on disk, or null when there is no dev server behind us. */
export async function listCustomIds(): Promise<string[] | null> {
  try {
    const res = await fetch('/__designer/levels');
    if (!res.ok) return null;
    const body = (await res.json()) as { ids?: string[] };
    return body.ids ?? [];
  } catch {
    return null;
  }
}

export async function saveLevel(level: LevelData): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/__designer/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: cleanLevel(level) }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
