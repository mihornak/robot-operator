/**
 * LevelData (drawn in the designer) → FloorDef (what the sim loads).
 *
 * Pure and synchronous, like everything else under sim/. Every entity is built
 * through the SAME builders floors.ts uses for the hand-authored floors, so a
 * designer-placed printer and a written-by-hand printer are the same object
 * down to the label — there is no second set of defaults to drift.
 *
 * The builder lookup is a switch inside the function rather than a module-level
 * table on purpose: floors.ts imports this module and this module imports
 * floors.ts, so anything touching those bindings at module-init time would read
 * them mid-initialisation.
 */
import type { Entity, LevelData, LevelEntityDef, LevelLit } from '../../../shared/types';
import type { FloorDef } from './floors';
import {
  at,
  brainCrate,
  cable,
  chair,
  chip,
  crate,
  debris,
  elevA,
  elevB,
  fuse,
  innocent,
  mop,
  printer,
  rocketCrate,
  scrap,
  shredder,
  socket,
  triadCrate,
} from './floors';

/** Printer hp when the level does not say. Matches floors 4/5. */
const DEFAULT_PRINTER_HP = 3;

/**
 * Build one placed thing. The three id-specific crates (BRAIN, ROCKET, triad)
 * are matched by id because the DIRECTOR dispatches its ceremonies on that id —
 * a designer level that places `crate_BRAIN` gets the brain ceremony, and its
 * label has to agree with the box the player is about to open.
 */
export function entityFromDef(def: LevelEntityDef): Entity {
  const pos = at(def.tx, def.ty);
  let e: Entity;
  switch (def.kind) {
    case 'elevatorA':
      e = elevA(pos);
      break;
    case 'elevatorB':
      e = elevB(pos, def.dark ?? false);
      break;
    case 'scrap':
      e = scrap(def.id, pos);
      break;
    case 'chip':
      e = chip(def.id, pos, def.option ?? 'MEMORY');
      break;
    case 'crate':
      e =
        def.id === 'crate_BRAIN'
          ? brainCrate(pos)
          : def.id === 'crate_ROCKET'
            ? rocketCrate(pos)
            : def.id === 'crate_triad'
              ? triadCrate(pos)
              : crate(def.id, pos, def.option);
      break;
    case 'debris':
      e = debris(def.id, pos);
      break;
    case 'cable':
      e = cable(def.id, pos);
      break;
    case 'fusedPrinter':
      e = printer(def.id, pos, def.hp ?? DEFAULT_PRINTER_HP);
      break;
    case 'fusedShredder':
      e = shredder(def.id, pos);
      break;
    case 'printerInnocent':
      e = innocent(def.id, pos);
      break;
    case 'mop':
      e = mop(def.id, pos);
      break;
    case 'chair':
      e = chair(def.id, pos);
      break;
    case 'fuse':
      e = fuse(def.id, pos);
      break;
    case 'fuseSocket':
      e = socket(def.id, pos);
      break;
  }
  // The elevator builders pin their own ids (elevA/elevB) because the director
  // and the selftest reference them by name; a level may still rename them.
  e.id = def.id;
  if (def.label !== undefined) e.label = def.label;
  if (def.hp !== undefined) {
    e.hp = def.hp;
    e.maxHp = def.hp;
  }
  // Dormant is a STATE, not a costume: isLiveHostile excludes it, so an ambush
  // placed this way is scenery until a trigger stands it up.
  if (def.dormant === true) e.state = 'dormant';
  return e;
}

export function levelToFloorDef(level: LevelData): FloorDef {
  const def: FloorDef = {
    map: level.map,
    // A fresh copy per load: loadFloor must never hand the sim objects that
    // survive a floor change (see FloorDef.entities).
    entities: () => level.entities.map(entityFromDef),
    meta: level.meta,
  };
  if (level.spawn) def.spawn = at(level.spawn.tx, level.spawn.ty);
  if (level.triggers.length > 0) def.triggers = level.triggers;
  if (level.sounds.length > 0) def.sounds = level.sounds;
  const lit = litOf(level);
  if (lit) def.lit = lit;
  return def;
}

/**
 * The lit fields, gathered into one bag, or null if the level authored none.
 *
 * NOTHING is resolved here — no defaults, no tile→px conversion, no look merge.
 * This module is inside `sim/`, and the moment it knew what a default light
 * radius was, the sim would depend on the renderer. It carries the data across
 * and the renderer decides what it means.
 */
function litOf(level: LevelData): LevelLit | null {
  const lit: LevelLit = {};
  let any = false;
  if (level.lights?.length) {
    lit.lights = level.lights;
    any = true;
  }
  if (level.decor?.length) {
    lit.decor = level.decor;
    any = true;
  }
  if (level.fixtures?.length) {
    lit.fixtures = level.fixtures;
    any = true;
  }
  if (level.wetPatches?.length) {
    lit.wetPatches = level.wetPatches;
    any = true;
  }
  if (level.look) {
    lit.look = level.look;
    any = true;
  }
  if (level.tiles) {
    lit.tiles = level.tiles;
    any = true;
  }
  // The seed travels with the rest but never justifies the bag on its own —
  // a seed with nothing to dress is a number for no one.
  if (any && level.meta.seed !== undefined) lit.seed = level.meta.seed;
  return any ? lit : null;
}
