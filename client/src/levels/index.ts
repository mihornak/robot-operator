/**
 * REGISTRY OF DESIGNER-AUTHORED LEVELS — partly generated, do not reformat.
 *
 * Levels are data: each `<id>.level.ts` beside this file exports one
 * `LevelData` object literal, and `sim/floors.ts` puts them into FLOORS through
 * `levelToFloorDef` — appended after the built-ins, or standing in for one of
 * them when the level carries `meta.replaces`.
 *
 * The designer's save endpoint (`POST /__designer/save`, implemented as a
 * dev-only Vite plugin in `client/vite.config.ts`) UPSERTS into this file: it
 * adds one import line between the import markers and one array entry between
 * the level markers, both keyed by the level id, and rewrites nothing else. The
 * markers are the contract — moving or renaming them breaks saving. Hand-edits
 * outside them survive.
 *
 * Import style is the extensionless relative form the rest of sim/ uses, so
 * this file loads unchanged under Vite AND under `node --experimental-strip-types`
 * (the selftest/fuzz runners add the `.ts` themselves).
 */
import type { LevelData } from '../../../shared/types';

// designer:imports:start
import { LEVEL as LEVEL_showcase } from './showcase.level';
import { LEVEL as LEVEL_floor_1_copy } from './floor-1-copy.level';
// designer:imports:end

export const CUSTOM_LEVELS: LevelData[] = [
  // designer:levels:start
  LEVEL_showcase,
  LEVEL_floor_1_copy,
  // designer:levels:end
];
