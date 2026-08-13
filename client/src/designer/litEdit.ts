/**
 * THE LIT EDITS THAT ARE MORE THAN ONE WRITE.
 *
 * A prop is one array push. A LAMP is three: the sprite, the light (two lights,
 * for a wall sconce), and the fixture's own authored state — and the three are
 * held together by one id. Every operation that would break that link lives
 * here, as a single command, so it is one undo step and there is exactly one
 * place that knows the shape of the link:
 *
 *     DecorPlacement.fixtureId  ==  LightPlacement.id  ==  FixtureDef.id
 *                                   (+ `<id>_pt` for a wall lamp's wall wash)
 *
 * Everything returns a `Command` for `DraftStore.run`; nothing here mutates the
 * draft itself. Tools and the inspector both go through these.
 */

import type { Command, DraftStore } from './store';
import type { DecorName, DecorPlacement, LevelData, LightPlacement } from '@shared/types';
import {
  addLitCmd,
  batchCmd,
  removeLitCmd,
  updateLitCmd,
} from './store';
import {
  CEILING_FIXTURE,
  PT_SUFFIX,
  WALL_FIXTURE,
  WALL_MOUNT_TY,
  defaultDecor,
  defaultFixture,
  fixtureLights,
} from './litAssets';

const isFixtureDecor = (name: DecorName): boolean =>
  name === CEILING_FIXTURE || name === WALL_FIXTURE;

const fixtureKindOf = (name: DecorName): 'ceiling' | 'wall' =>
  name === WALL_FIXTURE ? 'wall' : 'ceiling';

const solid = (level: LevelData, tx: number, ty: number): boolean =>
  level.map[ty]?.[tx] === '#';

/**
 * A wall tile with open floor under it — the only vertical surface this
 * projection actually draws, and therefore the only place a sconce can be seen.
 * README rule 2's neighbour: a lamp on any other wall is a lamp on a wall top.
 */
export function isSouthFace(level: LevelData, tx: number, ty: number): boolean {
  return solid(level, tx, ty) && !solid(level, tx, ty + 1);
}

/**
 * Where a wall lamp dropped near (tx, ty) should actually bolt itself.
 *
 * Wall lamps are placed by pointing at a wall, and a pointer lands on the wall
 * tile OR on the floor just under it depending on which pixel you hit. Both
 * mean the same thing to a designer, so both resolve to the face.
 */
export function snapWallFace(level: LevelData, tx: number, ty: number): { tx: number; ty: number } | null {
  const col = Math.floor(tx);
  for (const row of [Math.floor(ty), Math.floor(ty) - 1]) {
    if (isSouthFace(level, col, row)) return { tx: col + 0.5, ty: row + WALL_MOUNT_TY };
  }
  return null;
}

export interface Placement {
  cmd: Command;
  /** What to select once it lands. */
  id: string;
  /** Set when the placement wired up a lamp, for the status line. */
  fixtureId?: string;
}

/**
 * Place a prop. A lamp prop brings its whole rig with it — that is the point of
 * the DECOR page having lamps on it at all: a designer who wanted to place a
 * light, a sprite and a fixture record by hand and keep three ids in agreement
 * would place them wrong once and never trust the tool again.
 */
export function placeDecor(
  store: DraftStore,
  name: DecorName,
  tx: number,
  ty: number,
): Placement | null {
  const level = store.level;
  if (!isFixtureDecor(name)) {
    const id = store.freshId(name);
    return { cmd: addLitCmd('decor', defaultDecor(name, id, tx, ty), `place ${name}`), id };
  }

  const kind = fixtureKindOf(name);
  let px = tx;
  let py = ty;
  if (kind === 'wall') {
    const face = snapWallFace(level, tx, ty);
    // No face under the cursor: place it where it was asked for and let the
    // CHECKS panel say so. Refusing the click would just look broken.
    if (face) {
      px = face.tx;
      py = face.ty;
    }
  }
  const fixtureId = store.freshId(kind === 'wall' ? 'sconce' : 'tube');
  const decor: DecorPlacement = {
    ...defaultDecor(name, fixtureId + '_body', px, py),
    fixtureId,
    fixtureKind: kind,
    ceiling: true,
  };
  const parts: Array<Command | null> = [
    addLitCmd('decor', decor, `place ${name}`),
    addLitCmd('fixtures', defaultFixture(fixtureId, kind)),
  ];
  for (const light of fixtureLights(fixtureId, kind, px, py)) {
    parts.push(addLitCmd('lights', light));
  }
  const cmd = batchCmd(`place ${name}`, parts);
  return cmd ? { cmd, id: decor.id, fixtureId } : null;
}

/** Every light belonging to one fixture: the lamp and its wall wash. */
export function fixtureLightIds(level: LevelData, fixtureId: string): string[] {
  const want = new Set([fixtureId, fixtureId + PT_SUFFIX]);
  return (level.lights ?? []).filter((l) => want.has(l.id)).map((l) => l.id);
}

/** Delete a prop, and — if it is a lamp — the rig that came with it. */
export function deleteDecor(store: DraftStore, id: string): Command | null {
  const level = store.level;
  const d = store.decor(id);
  if (!d) return null;
  const parts: Array<Command | null> = [removeLitCmd(level, 'decor', id)];
  if (d.fixtureId) {
    parts.push(removeLitCmd(level, 'fixtures', d.fixtureId));
    for (const lid of fixtureLightIds(level, d.fixtureId)) {
      parts.push(removeLitCmd(level, 'lights', lid));
    }
  }
  return batchCmd(`delete ${d.name}`, parts);
}

/**
 * Delete a light. A wall lamp's cone takes its wall wash with it: they are one
 * lamp to anyone looking at the room, and leaving a `_pt` behind produces a
 * patch of lit wall with no visible source.
 */
export function deleteLight(store: DraftStore, id: string): Command | null {
  const level = store.level;
  const parts: Array<Command | null> = [removeLitCmd(level, 'lights', id)];
  if (!id.endsWith(PT_SUFFIX)) {
    const pt = (level.lights ?? []).find((l) => l.id === id + PT_SUFFIX);
    if (pt) parts.push(removeLitCmd(level, 'lights', pt.id));
  }
  return batchCmd('delete light', parts);
}

/** Move a prop, dragging any lights bolted to it along by the same delta. */
export function moveDecor(store: DraftStore, id: string, tx: number, ty: number): Command | null {
  const level = store.level;
  const d = store.decor(id);
  if (!d) return null;
  const dx = tx - d.tx;
  const dy = ty - d.ty;
  const parts: Array<Command | null> = [
    updateLitCmd(level, 'decor', id, { tx, ty }, 'move decor'),
  ];
  if (d.fixtureId) {
    for (const lid of fixtureLightIds(level, d.fixtureId)) {
      const l = store.light(lid);
      if (l) parts.push(updateLitCmd(level, 'lights', lid, { tx: l.tx + dx, ty: l.ty + dy }, 'move decor'));
    }
  }
  return batchCmd('move decor', parts);
}

/**
 * Rename a fixture across all three of its homes at once.
 *
 * A half-renamed fixture is the worst state this data has: the prop still
 * draws, the light still burns, and the fixture panel silently edits nothing,
 * because `LitScene` looks its fixtures up by the id the DECOR carries.
 */
export function renameFixture(store: DraftStore, oldId: string, newId: string): Command | null {
  const level = store.level;
  const next = newId.trim();
  if (!next || next === oldId) return null;
  const parts: Array<Command | null> = [];
  for (const d of level.decor ?? []) {
    if (d.fixtureId === oldId) parts.push(updateLitCmd(level, 'decor', d.id, { fixtureId: next }, 'rename fixture'));
  }
  if (store.fixture(oldId)) {
    parts.push(updateLitCmd(level, 'fixtures', oldId, { id: next }, 'rename fixture'));
  }
  for (const lid of fixtureLightIds(level, oldId)) {
    const renamed = lid.endsWith(PT_SUFFIX) ? next + PT_SUFFIX : next;
    parts.push(updateLitCmd(level, 'lights', lid, { id: renamed }, 'rename fixture'));
  }
  // A trigger aiming at this lamp has to follow it, or the level saves with a
  // `light` action pointed at an id that no longer exists.
  for (const t of level.triggers) {
    if (!t.actions.some((a) => a.type === 'light' && a.target === oldId)) continue;
    const actions = t.actions.map((a) =>
      a.type === 'light' && a.target === oldId ? { ...a, target: next } : a,
    );
    parts.push({
      label: 'retarget light action',
      structural: false,
      apply: (l) => {
        const trig = l.triggers.find((x) => x.id === t.id);
        if (trig) trig.actions = JSON.parse(JSON.stringify(actions)) as typeof actions;
      },
      revert: (l) => {
        const trig = l.triggers.find((x) => x.id === t.id);
        if (trig) trig.actions = JSON.parse(JSON.stringify(t.actions)) as typeof actions;
      },
    });
  }
  return batchCmd('rename fixture', parts);
}

/** Rename a bare light, keeping any trigger pointed at it. */
export function renameLight(store: DraftStore, oldId: string, newId: string): Command | null {
  const level = store.level;
  const next = newId.trim();
  if (!next || next === oldId) return null;
  const d = (level.decor ?? []).find((x) => x.fixtureId === oldId);
  if (d) return renameFixture(store, oldId, next);
  return updateLitCmd(level, 'lights', oldId, { id: next }, 'rename light');
}

/** The lights a trigger can address. Wall washes are driven by their own lamp. */
export function targetableLights(level: LevelData): LightPlacement[] {
  return (level.lights ?? []).filter((l) => !l.id.endsWith(PT_SUFFIX));
}
