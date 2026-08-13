/**
 * THE DRAFT AND ITS HISTORY.
 *
 * One `LevelData` in memory, mutated through exactly one funnel (`run`), which
 * is what makes undo, autosave and the live validation/preview refresh a single
 * code path instead of three that drift.
 *
 * Undo is a COMMAND stack, not a snapshot stack. A 30×16 map plus its entities
 * is small enough that snapshots would work and lazy enough that they would be
 * wrong for the interesting case: painting a wall holds the mouse down for a
 * hundred frames, and a hundred whole-level copies per stroke is both memory and
 * a history nobody can step back through. A stroke is one command carrying the
 * tiles it changed and what they were before.
 */

import type {
  DecorPlacement,
  FixtureDef,
  LevelData,
  LevelEntityDef,
  LevelLook,
  LightPlacement,
  SoundEmitterDef,
  TileAuthoring,
  TileRect,
  TriggerDef,
  WetPatch,
} from '@shared/types';
import { TILES_X, TILES_Y } from '@shared/types';

export type Selection =
  | { kind: 'entity'; id: string }
  | { kind: 'trigger'; id: string }
  | { kind: 'sound'; id: string }
  | { kind: 'decor'; id: string }
  | { kind: 'light'; id: string }
  /** Wet patches have no id in the data — they are addressed by slot. */
  | { kind: 'wet'; index: number }
  | { kind: 'level' }
  | null;

/** Who asked for the change — the inspector skips rebuilding its own edits, so
 *  a field being typed into does not lose focus every keystroke. */
export type ChangeSource = 'user' | 'inspector';

export interface ChangeInfo {
  /** Geometry or the entity list moved: the preview must rebuild. */
  structural: boolean;
  /** The change was in the LIT half only — the sim view has nothing to redo. */
  lit: boolean;
  source: ChangeSource;
}

export interface Command {
  label: string;
  structural: boolean;
  /** Set on commands that only touch decor/lights/fixtures/water/look/tiles. */
  lit?: boolean;
  apply(level: LevelData): void;
  revert(level: LevelData): void;
}

export interface TileEdit {
  tx: number;
  ty: number;
  solid: boolean;
}

const LS_DRAFT = 'robot-designer-draft-v1';
const MAX_HISTORY = 200;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function emptyMap(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < TILES_Y; y++) {
    const edge = y === 0 || y === TILES_Y - 1;
    rows.push(edge ? '#'.repeat(TILES_X) : '#' + '.'.repeat(TILES_X - 2) + '#');
  }
  return rows;
}

/**
 * A new level that already passes the suite: four walls, both elevators on
 * opposite sides (the zigzag), and a spawn. An empty template that fails
 * validation on creation teaches the panel is noise.
 */
export function blankLevel(): LevelData {
  return {
    meta: { id: 'new-level', name: 'NEW LEVEL', order: 0 },
    map: emptyMap(),
    spawn: { tx: 2, ty: 8 },
    entities: [
      { id: 'elevA', kind: 'elevatorA', tx: 2, ty: 8 },
      { id: 'elevB', kind: 'elevatorB', tx: 27, ty: 8 },
    ],
    triggers: [],
    sounds: [],
  };
}

/** Rewrite one character of the ASCII map. */
function writeTile(level: LevelData, tx: number, ty: number, solid: boolean): void {
  const row = level.map[ty];
  if (row === undefined || tx < 0 || tx >= row.length) return;
  level.map[ty] = row.slice(0, tx) + (solid ? '#' : '.') + row.slice(tx + 1);
}

export function tileSolid(level: LevelData, tx: number, ty: number): boolean {
  return level.map[ty]?.[tx] === '#';
}

// ---------------------------------------------------------------- commands

/** One paint stroke, one command. `before` is captured against the live level. */
export function setTilesCmd(level: LevelData, edits: readonly TileEdit[]): Command | null {
  const changed = edits.filter(
    (e) =>
      e.tx >= 0 &&
      e.ty >= 0 &&
      e.tx < TILES_X &&
      e.ty < TILES_Y &&
      tileSolid(level, e.tx, e.ty) !== e.solid,
  );
  if (changed.length === 0) return null;
  const before = changed.map((e) => tileSolid(level, e.tx, e.ty));
  return {
    label: changed.length === 1 ? 'paint tile' : `paint ${changed.length} tiles`,
    structural: true,
    apply: (l) => changed.forEach((e) => writeTile(l, e.tx, e.ty, e.solid)),
    revert: (l) => changed.forEach((e, i) => writeTile(l, e.tx, e.ty, before[i]!)),
  };
}

type ListKey = 'entities' | 'triggers' | 'sounds';
type ListItem = LevelEntityDef | TriggerDef | SoundEmitterDef;

export function addItemCmd(key: ListKey, item: ListItem): Command {
  const copy = clone(item);
  return {
    label: `add ${key.slice(0, -1)}`,
    structural: key === 'entities',
    apply: (l) => {
      (l[key] as ListItem[]).push(clone(copy));
    },
    revert: (l) => {
      const list = l[key] as ListItem[];
      const i = list.findIndex((x) => x.id === copy.id);
      if (i >= 0) list.splice(i, 1);
    },
  };
}

export function removeItemCmd(level: LevelData, key: ListKey, id: string): Command | null {
  const list = level[key] as ListItem[];
  const index = list.findIndex((x) => x.id === id);
  if (index < 0) return null;
  const copy = clone(list[index]!);
  return {
    label: `delete ${key.slice(0, -1)}`,
    structural: key === 'entities',
    apply: (l) => {
      const at = (l[key] as ListItem[]).findIndex((x) => x.id === id);
      if (at >= 0) (l[key] as ListItem[]).splice(at, 1);
    },
    // Back into its ORIGINAL slot: entity order is floor spawn order, and
    // `matchEntity` breaks score ties on it (see sim/index.ts visibleEntities).
    revert: (l) => {
      (l[key] as ListItem[]).splice(index, 0, clone(copy));
    },
  };
}

/** Replace one item wholesale. Both halves are stored, so redo is free. */
export function updateItemCmd(
  level: LevelData,
  key: ListKey,
  id: string,
  patch: Partial<ListItem>,
  label = 'edit',
): Command | null {
  const list = level[key] as ListItem[];
  const index = list.findIndex((x) => x.id === id);
  if (index < 0) return null;
  const before = clone(list[index]!);
  const after = { ...clone(before), ...clone(patch) } as ListItem;
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  // `id` may itself be in the patch, so both halves look themselves up by the
  // id they expect to find rather than by index — a redo after other edits
  // must not write to whatever has since moved into slot `index`.
  const replace = (l: LevelData, findId: string, next: ListItem): void => {
    const arr = l[key] as ListItem[];
    const at = arr.findIndex((x) => x.id === findId);
    if (at >= 0) arr[at] = clone(next);
  };
  return {
    label,
    structural: key === 'entities',
    apply: (l) => replace(l, before.id, after),
    revert: (l) => replace(l, after.id, before),
  };
}

export function setSpawnCmd(level: LevelData, tx: number, ty: number): Command | null {
  const before = level.spawn ? { ...level.spawn } : undefined;
  if (before && before.tx === tx && before.ty === ty) return null;
  return {
    label: 'move spawn',
    structural: true,
    apply: (l) => {
      l.spawn = { tx, ty };
    },
    revert: (l) => {
      if (before) l.spawn = { ...before };
      else delete l.spawn;
    },
  };
}

export function setMetaCmd(level: LevelData, patch: Partial<LevelData['meta']>): Command | null {
  const before = clone(level.meta);
  const after = { ...before, ...patch };
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return {
    label: 'edit level',
    structural: false,
    apply: (l) => {
      l.meta = clone(after);
    },
    revert: (l) => {
      l.meta = clone(before);
    },
  };
}

// ------------------------------------------------------------ lit commands
//
// The lit lists are OPTIONAL on LevelData: a v1 level has no `decor` key at
// all, and it has to stay that way until something is placed. So every writer
// here creates the array on demand and every reverter removes it again when it
// empties — otherwise the first placed-then-undone prop leaves `"decor": []`
// behind in the saved file forever.

export type LitListKey = 'decor' | 'lights' | 'fixtures';
type LitItem = DecorPlacement | LightPlacement | FixtureDef;

const litList = <T>(level: LevelData, key: LitListKey | 'wetPatches'): T[] => {
  const l = level as unknown as Record<string, T[] | undefined>;
  l[key] ??= [];
  return l[key]!;
};

const pruneList = (level: LevelData, key: LitListKey | 'wetPatches'): void => {
  const l = level as unknown as Record<string, unknown[] | undefined>;
  if (l[key]?.length === 0) delete l[key];
};

/** Does this draft render through render/lit at all? */
export function hasLit(level: LevelData): boolean {
  return (
    (level.decor?.length ?? 0) > 0 ||
    (level.lights?.length ?? 0) > 0 ||
    (level.fixtures?.length ?? 0) > 0 ||
    (level.wetPatches?.length ?? 0) > 0 ||
    level.look !== undefined ||
    level.tiles !== undefined
  );
}

export function addLitCmd(key: LitListKey, item: LitItem, label = `add ${key}`): Command {
  const copy = clone(item);
  return {
    label,
    structural: true,
    lit: true,
    apply: (l) => {
      litList<LitItem>(l, key).push(clone(copy));
    },
    revert: (l) => {
      const list = litList<LitItem>(l, key);
      const i = list.findIndex((x) => x.id === copy.id);
      if (i >= 0) list.splice(i, 1);
      pruneList(l, key);
    },
  };
}

export function removeLitCmd(level: LevelData, key: LitListKey, id: string): Command | null {
  const list = litList<LitItem>(level, key);
  const index = list.findIndex((x) => x.id === id);
  if (index < 0) return null;
  const copy = clone(list[index]!);
  return {
    label: `delete ${key}`,
    structural: true,
    lit: true,
    apply: (l) => {
      const arr = litList<LitItem>(l, key);
      const at = arr.findIndex((x) => x.id === id);
      if (at >= 0) arr.splice(at, 1);
      pruneList(l, key);
    },
    revert: (l) => {
      litList<LitItem>(l, key).splice(index, 0, clone(copy));
    },
  };
}

export function updateLitCmd(
  level: LevelData,
  key: LitListKey,
  id: string,
  patch: Partial<LitItem>,
  label = 'edit',
): Command | null {
  const list = litList<LitItem>(level, key);
  const index = list.findIndex((x) => x.id === id);
  if (index < 0) return null;
  const before = clone(list[index]!);
  const after = { ...clone(before), ...clone(patch) } as LitItem;
  // An explicit `undefined` in the patch means "drop this key" — a decor
  // placement that goes back to its entry's own footprint must not save
  // `"foot": undefined`, which JSON would render as a missing key anyway but
  // which would compare unequal on every round-trip check.
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (after as unknown as Record<string, unknown>)[k];
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  const replace = (l: LevelData, findId: string, next: LitItem): void => {
    const arr = litList<LitItem>(l, key);
    const at = arr.findIndex((x) => x.id === findId);
    if (at >= 0) arr[at] = clone(next);
  };
  return {
    label,
    structural: true,
    lit: true,
    apply: (l) => replace(l, before.id, after),
    revert: (l) => replace(l, after.id, before),
  };
}

export function addWetCmd(patch: WetPatch): Command {
  const copy = { ...patch };
  return {
    label: 'add wet patch',
    structural: true,
    lit: true,
    apply: (l) => {
      litList<WetPatch>(l, 'wetPatches').push({ ...copy });
    },
    revert: (l) => {
      litList<WetPatch>(l, 'wetPatches').pop();
      pruneList(l, 'wetPatches');
    },
  };
}

export function removeWetCmd(level: LevelData, index: number): Command | null {
  const before = level.wetPatches?.[index];
  if (!before) return null;
  const copy = { ...before };
  return {
    label: 'delete wet patch',
    structural: true,
    lit: true,
    apply: (l) => {
      litList<WetPatch>(l, 'wetPatches').splice(index, 1);
      pruneList(l, 'wetPatches');
    },
    revert: (l) => {
      litList<WetPatch>(l, 'wetPatches').splice(index, 0, { ...copy });
    },
  };
}

export function updateWetCmd(
  level: LevelData,
  index: number,
  patch: Partial<WetPatch>,
  label = 'edit wet patch',
): Command | null {
  const before = level.wetPatches?.[index];
  if (!before) return null;
  const from = { ...before };
  const to = { ...from, ...patch };
  if (JSON.stringify(from) === JSON.stringify(to)) return null;
  return {
    label,
    structural: true,
    lit: true,
    apply: (l) => {
      const list = litList<WetPatch>(l, 'wetPatches');
      if (list[index]) list[index] = { ...to };
    },
    revert: (l) => {
      const list = litList<WetPatch>(l, 'wetPatches');
      if (list[index]) list[index] = { ...from };
    },
  };
}

/**
 * A look edit. NOT structural: the renderer takes a look change through
 * `updateLook`, which never rebuilds geometry — that is the whole reason the
 * split exists, and routing a slider through a scene rebuild would make the
 * panel unusable.
 */
export function setLookCmd(level: LevelData, patch: LevelLook, label = 'edit look'): Command | null {
  const before = level.look ? clone(level.look) : undefined;
  const after = { ...(before ?? {}), ...patch } as LevelLook;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (after as unknown as Record<string, unknown>)[k];
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return {
    label,
    structural: false,
    lit: true,
    apply: (l) => {
      l.look = clone(after);
    },
    revert: (l) => {
      if (before) l.look = clone(before);
      else delete l.look;
    },
  };
}

/** Replace the whole look — presets and "engine defaults" both land here. */
export function replaceLookCmd(level: LevelData, next: LevelLook | undefined, label: string): Command | null {
  const before = level.look ? clone(level.look) : undefined;
  if (JSON.stringify(before) === JSON.stringify(next)) return null;
  const after = next ? clone(next) : undefined;
  return {
    label,
    structural: false,
    lit: true,
    apply: (l) => {
      if (after) l.look = clone(after);
      else delete l.look;
    },
    revert: (l) => {
      if (before) l.look = clone(before);
      else delete l.look;
    },
  };
}

/** Tile dressing: hazard lanes and forced floor variants. */
export function setTileAuthCmd(
  level: LevelData,
  next: TileAuthoring | undefined,
  label = 'edit tile dressing',
): Command | null {
  const before = level.tiles ? clone(level.tiles) : undefined;
  const after = next && (next.walkRows?.length || next.overrides?.length) ? clone(next) : undefined;
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return {
    label,
    structural: true,
    lit: true,
    apply: (l) => {
      if (after) l.tiles = clone(after);
      else delete l.tiles;
    },
    revert: (l) => {
      if (before) l.tiles = clone(before);
      else delete l.tiles;
    },
  };
}

/** Several edits that must undo as one — a paste, a region delete. */
export function batchCmd(label: string, parts: readonly (Command | null)[]): Command | null {
  const list = parts.filter((c): c is Command => c !== null);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0]!;
  return {
    label,
    structural: list.some((c) => c.structural),
    // Only a batch made ENTIRELY of lit edits is a lit edit: one tile paint in
    // the mix and the sim view has to be rebuilt too.
    lit: list.every((c) => c.lit === true),
    apply: (l) => list.forEach((c) => c.apply(l)),
    revert: (l) => [...list].reverse().forEach((c) => c.revert(l)),
  };
}

/** Replace the whole draft (load / import / new). One history entry. */
export function loadLevelCmd(level: LevelData, next: LevelData): Command {
  const before = clone(level);
  const after = clone(next);
  const put = (l: LevelData, src: LevelData): void => {
    l.meta = clone(src.meta);
    l.map = [...src.map];
    if (src.spawn) l.spawn = { ...src.spawn };
    else delete l.spawn;
    l.entities = clone(src.entities);
    l.triggers = clone(src.triggers);
    l.sounds = clone(src.sounds);
    // The lit half is optional and its ABSENCE is meaningful — a v1 level has
    // no `look` key and must not inherit the one the previous draft had open.
    for (const key of ['decor', 'lights', 'fixtures', 'wetPatches', 'look', 'tiles'] as const) {
      const v = src[key];
      if (v === undefined) delete l[key];
      else (l as unknown as Record<string, unknown>)[key] = clone(v);
    }
  };
  return {
    label: 'load level',
    structural: true,
    apply: (l) => put(l, after),
    revert: (l) => put(l, before),
  };
}

// ------------------------------------------------------------------- store

export interface Clip {
  rect: TileRect;
  tiles: boolean[][];
  entities: LevelEntityDef[];
}

export class DraftStore {
  level: LevelData;
  selection: Selection = null;
  /** Marquee region — what Ctrl+C copies and Del clears. */
  region: TileRect | null = null;
  clipboard: Clip | null = null;

  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners: Array<(info: ChangeInfo) => void> = [];
  private selListeners: Array<() => void> = [];
  private saveTimer = 0;

  constructor(level?: LevelData) {
    this.level = level ? clone(level) : blankLevel();
  }

  on(cb: (info: ChangeInfo) => void): void {
    this.listeners.push(cb);
  }

  onSelection(cb: () => void): void {
    this.selListeners.push(cb);
  }

  /** THE funnel. Everything that edits the draft goes through here. */
  run(cmd: Command | null, source: ChangeSource = 'user'): void {
    if (!cmd) return;
    cmd.apply(this.level);
    this.undoStack.push(cmd);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.changed({ structural: cmd.structural, lit: cmd.lit === true, source });
  }

  undo(): string | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.revert(this.level);
    this.redoStack.push(cmd);
    this.pruneSelection();
    this.changed({ structural: cmd.structural, lit: cmd.lit === true, source: 'user' });
    return cmd.label;
  }

  redo(): string | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.apply(this.level);
    this.undoStack.push(cmd);
    this.pruneSelection();
    this.changed({ structural: cmd.structural, lit: cmd.lit === true, source: 'user' });
    return cmd.label;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** History belongs to the level that was open — a load starts fresh. */
  resetHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  select(sel: Selection): void {
    const same = JSON.stringify(sel) === JSON.stringify(this.selection);
    if (same) return;
    this.selection = sel;
    for (const cb of this.selListeners) cb();
  }

  setRegion(rect: TileRect | null): void {
    this.region = rect;
    for (const cb of this.selListeners) cb();
  }

  entity(id: string): LevelEntityDef | undefined {
    return this.level.entities.find((e) => e.id === id);
  }

  trigger(id: string): TriggerDef | undefined {
    return this.level.triggers.find((t) => t.id === id);
  }

  sound(id: string): SoundEmitterDef | undefined {
    return this.level.sounds.find((s) => s.id === id);
  }

  decor(id: string): DecorPlacement | undefined {
    return this.level.decor?.find((d) => d.id === id);
  }

  light(id: string): LightPlacement | undefined {
    return this.level.lights?.find((l) => l.id === id);
  }

  fixture(id: string): FixtureDef | undefined {
    return this.level.fixtures?.find((f) => f.id === id);
  }

  /**
   * Unique id with a kind-ish prefix: `printer`, `printer2`, `printer3`…
   *
   * The pool spans EVERY named thing in the level, lit half included: a decor
   * placement and an entity that shared an id would make the trigger editor's
   * target dropdowns ambiguous, and a light sharing a name with its own
   * fixture is the one collision that is deliberate (see the fixture tools).
   */
  freshId(prefix: string): string {
    const taken = new Set<string>([
      ...this.level.entities.map((e) => e.id),
      ...this.level.triggers.map((t) => t.id),
      ...this.level.sounds.map((s) => s.id),
      ...(this.level.decor ?? []).map((d) => d.id),
      ...(this.level.lights ?? []).map((l) => l.id),
      ...(this.level.fixtures ?? []).map((f) => f.id),
    ]);
    if (!taken.has(prefix)) return prefix;
    for (let n = 2; ; n++) {
      const id = `${prefix}${n}`;
      if (!taken.has(id)) return id;
    }
  }

  /** An undo that deleted the selected thing must not leave a ghost selected. */
  private pruneSelection(): void {
    const s = this.selection;
    if (!s || s.kind === 'level') return;
    let alive: unknown;
    switch (s.kind) {
      case 'entity':
        alive = this.entity(s.id);
        break;
      case 'trigger':
        alive = this.trigger(s.id);
        break;
      case 'sound':
        alive = this.sound(s.id);
        break;
      case 'decor':
        alive = this.decor(s.id);
        break;
      case 'light':
        alive = this.light(s.id);
        break;
      case 'wet':
        alive = this.level.wetPatches?.[s.index];
        break;
    }
    if (!alive) this.select(null);
  }

  private changed(info: ChangeInfo): void {
    for (const cb of this.listeners) cb(info);
    this.queueSave();
  }

  private queueSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(LS_DRAFT, JSON.stringify(this.level));
      } catch {
        /* private mode / quota — the designer still works, it just forgets. */
      }
    }, 400);
  }
}

/** The draft the last session left behind, or null. Shape-checked, not trusted. */
export function restoreDraft(): LevelData | null {
  try {
    const raw = localStorage.getItem(LS_DRAFT);
    if (!raw) return null;
    const v = JSON.parse(raw) as LevelData;
    if (!v || typeof v !== 'object') return null;
    if (!v.meta || typeof v.meta.id !== 'string') return null;
    if (!Array.isArray(v.map) || v.map.length !== TILES_Y) return null;
    if (!Array.isArray(v.entities) || !Array.isArray(v.triggers) || !Array.isArray(v.sounds)) {
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(LS_DRAFT);
  } catch {
    /* nothing to clear */
  }
}
