/**
 * THE LIT ASSET TABLES — what a freshly placed prop, lamp, fixture or look is.
 *
 * Every default in here was read off the graphics lab's own room
 * (`client/src/lab/level.ts`), which is the only place these numbers have ever
 * been judged by eye. A designer who drops a ceiling tube and gets a 40px
 * accent light learns that the tool is lying to them; a designer who drops one
 * and gets the lab's tube learns what a tube is.
 *
 * Thumbnails are drawn by the SAME drawer the renderer uses, straight onto a
 * canvas — no GPU readback, because a decor entry is already a 2D drawing
 * routine and `renderer.extract` would only be a slower way to ask it the same
 * question.
 */

import type {
  DecorName,
  DecorPlacement,
  FixtureDef,
  LevelLook,
  LightPlacement,
} from '@shared/types';
import { Px } from '../art/px';
import { DECOR, DECOR_NAMES, type DecorEntry } from '../render/lit/decor';
import { LAMP_STYLE_NAMES, WALL_STYLE_NAMES } from '../render/lit/fixtures';
import { E } from '../render/lit/palette';

export { DECOR_NAMES, LAMP_STYLE_NAMES, WALL_STYLE_NAMES };

/** The two props that are also light fittings. Placing one wires up a rig. */
export const CEILING_FIXTURE: DecorName = 'ceiling_lamp';
export const WALL_FIXTURE: DecorName = 'wall_lamp';

export const decorEntry = (name: DecorName): DecorEntry => DECOR[name] as DecorEntry;

/** Frame 0 of a prop, at native size, on its own canvas. */
export function decorThumb(name: DecorName): HTMLCanvasElement {
  const e = decorEntry(name);
  const canvas = document.createElement('canvas');
  canvas.width = e.w;
  canvas.height = e.h;
  const ctx = canvas.getContext('2d');
  if (ctx) e.draw(new Px(ctx, e.w, e.h), 0);
  return canvas;
}

// ------------------------------------------------------------------- decor

/**
 * Fractional placement, quarter tile. Fine enough to line a prop up against a
 * wall face, coarse enough that two of the same prop placed by hand actually
 * agree with each other. Alt in the tools bypasses it.
 */
export const DECOR_SNAP = 0.25;

export const snapTile = (v: number, snap = DECOR_SNAP): number =>
  Math.round(v / snap) * snap;

/**
 * A newly placed prop. `foot` is copied from the entry rather than left out:
 * the footprint is what makes a prop darken the floor it stands on, and a
 * designer who places a desk expects the desk to sit in the room, not hover in
 * it. Flat props (puddles, paper, floor strips) get none — they have nothing
 * to block.
 */
export function defaultDecor(name: DecorName, id: string, tx: number, ty: number): DecorPlacement {
  const e = decorEntry(name);
  const p: DecorPlacement = { id, name, tx, ty };
  const foot = FOOT_DEFAULTS[name];
  if (foot) p.foot = [...foot];
  if (name === CEILING_FIXTURE || name === WALL_FIXTURE) p.ceiling = true;
  if (name === WALL_FIXTURE) p.fixtureKind = 'wall';
  if (CEILING_PROPS.has(name)) p.ceiling = true;
  // Anything tall enough to have a top edge worth mirroring gets a reflection;
  // it only ever shows inside a wet patch, so an unreflected room costs nothing
  // and a wet one comes out right without a second pass over every prop.
  if (e.h >= 12 && !p.ceiling) p.reflect = true;
  return p;
}

/** Props that hang: they draw over everything and cast nothing. */
const CEILING_PROPS = new Set<DecorName>(['exit_sign', 'alarm_strobe']);

/**
 * Light-blocking footprints, px, as authored in the lab room. A prop missing
 * from this table is flat — rubble, paper, a puddle — and blocks nothing.
 */
const FOOT_DEFAULTS: Partial<Record<DecorName, readonly [number, number]>> = {
  desk: [24, 10],
  desk_toppled: [22, 10],
  filing_cabinet: [12, 6],
  shelf_unit: [28, 8],
  boxes: [16, 8],
  barrel: [11, 6],
  crate_stack: [18, 8],
  plant_dead: [10, 6],
  server_rack: [18, 8],
  terminal: [16, 6],
  vending: [16, 8],
  sparks_box: [10, 5],
  pipe_bank: [20, 8],
  locker_row: [24, 8],
  water_cooler: [8, 5],
  breaker_panel: [10, 4],
  floor_fan: [12, 5],
  coat_rack: [8, 4],
  trolley: [18, 6],
};

// ------------------------------------------------------------------ lights

export interface LightPreset {
  key: string;
  label: string;
  hint: string;
  make(id: string, tx: number, ty: number): LightPlacement;
}

/**
 * The five lights the lab room is actually built out of. Every one of them is a
 * real entry from `LAB_LIGHTS`, not a rounded-off version of one — "tube" is
 * `tube_b`, "accent" is a server rack LED.
 */
export const LIGHT_PRESETS: LightPreset[] = [
  {
    key: 'tube',
    label: 'tube',
    hint: 'ceiling key — big, warm, casts shadows',
    make: (id, tx, ty) => ({
      id,
      tx,
      ty,
      radius: 150,
      color: E.key,
      intensity: 1.2,
      castShadow: true,
    }),
  },
  {
    key: 'fill',
    label: 'fill',
    hint: 'cold alcove tube — separates a side room from the bay',
    make: (id, tx, ty) => ({
      id,
      tx,
      ty,
      radius: 94,
      color: E.fill,
      intensity: 1.05,
      castShadow: true,
    }),
  },
  {
    key: 'cone',
    label: 'cone',
    hint: 'raking floor wash — drag the handle to aim it',
    make: (id, tx, ty) => ({
      id,
      tx,
      ty,
      radius: 124,
      color: E.key,
      intensity: 0.5,
      kind: 'cone',
      dir: Math.PI / 2,
      spread: 0.75,
      castShadow: true,
    }),
  },
  {
    key: 'accent',
    label: 'accent',
    hint: 'powered technology — cheap, no shadow pass',
    make: (id, tx, ty) => ({
      id,
      tx,
      ty,
      radius: 34,
      color: E.accent,
      intensity: 0.7,
      castShadow: false,
      flicker: 0.4,
      flickerHz: 15,
    }),
  },
  {
    key: 'strobe',
    label: 'strobe',
    hint: 'alarm hazard — hard flicker, no shadows',
    make: (id, tx, ty) => ({
      id,
      tx,
      ty,
      radius: 66,
      color: E.hazard,
      intensity: 0.9,
      castShadow: false,
      flicker: 1.6,
      flickerHz: 3.2,
    }),
  },
];

/** The emissive ramp, as one-click swatches. Names are the palette's own. */
export const LIGHT_COLORS: ReadonlyArray<{ name: string; value: number }> = [
  { name: 'key', value: E.key },
  { name: 'keyCore', value: E.keyCore },
  { name: 'fill', value: E.fill },
  { name: 'fillCore', value: E.fillCore },
  { name: 'accent', value: E.accent },
  { name: 'accentCore', value: E.accentCore },
  { name: 'hazard', value: E.hazard },
  { name: 'hazardCore', value: E.hazardCore },
  { name: 'screen', value: E.screen },
  { name: 'screenDim', value: E.screenDim },
];

// ---------------------------------------------------------------- fixtures

/**
 * The light a lamp PROP comes with, and the offsets between the two.
 *
 * A ceiling tube's light sits where the housing does. A wall sconce is three
 * things at once: the housing on the wall face, a cone below it throwing the
 * pool, and a small round wall wash (`<id>_pt`) that lights the housing and the
 * wall it is bolted to — README rule 2. All three are authored here so that
 * placing one prop produces a lamp that works, rather than a sprite in the dark.
 */
/** Suffix of the wall-wash companion. `setLightState` drives both as one lamp. */
export const PT_SUFFIX = '_pt';

/**
 * Both of a wall lamp's lights start ON the housing, because that is where the
 * renderer puts them anyway: `applyFixtures` re-derives a wall fixture's light
 * positions from the decor placement plus the fixture's own `mountY`/`lightX`/
 * `lightY` every frame. Authoring them anywhere else would produce data that
 * disagrees with the picture — the overlays would draw the ring in one place
 * and the pool would land in another.
 */
export function fixtureLights(id: string, kind: 'ceiling' | 'wall', tx: number, ty: number): LightPlacement[] {
  if (kind === 'ceiling') {
    return [{ id, tx, ty, radius: 150, color: E.key, intensity: 1.2, castShadow: true }];
  }
  return [
    {
      id,
      tx,
      ty,
      radius: 62,
      color: E.key,
      intensity: 0.5,
      kind: 'cone',
      dir: Math.PI / 2,
      spread: 0.85,
      castShadow: false,
    },
    {
      id: id + PT_SUFFIX,
      tx,
      ty,
      radius: 48,
      color: E.key,
      intensity: 0.55,
      castShadow: false,
      volumetric: false,
    },
  ];
}

export function defaultFixture(id: string, kind: 'ceiling' | 'wall'): FixtureDef {
  return kind === 'wall'
    ? { id, kind, style: 'sconce', scale: 1, bodyAlpha: 1, glow: 1, mountY: 0, lightX: 0, lightY: 0, spill: 1 }
    : { id, kind, style: 'tube', scale: 1, bodyAlpha: 1, glow: 1 };
}

/** Wall lamps mount half a tile down their wall face, like every one in the lab. */
export const WALL_MOUNT_TY = 0.62;

// -------------------------------------------------------------------- look

/**
 * Level looks, ported from the lab's presets.
 *
 * Only the LEVEL half survives the port: the lab's presets also move bloom,
 * vignette, chroma and grain, which are `EngineLook` — the renderer's own
 * numbers, deliberately not per level (see render/lit/types.ts). A preset that
 * quietly retuned the engine would make one level look like it came out of a
 * different game.
 */
export const LOOK_PRESETS: Record<string, LevelLook> = {
  Nightshift: {
    ambientLevel: 0.1,
    ambientColor: 0x1d2a44,
    fogColor: 0x16223a,
    fogAmount: 0.3,
    lightGain: 1.25,
    lightFalloff: 2.3,
    saturation: 1.25,
  },
  Blackout: {
    ambientLevel: 0.04,
    ambientColor: 0x101a2c,
    lightGain: 1.5,
    lightFlicker: 1.4,
    lightFalloff: 2.6,
    fogAmount: 0.12,
  },
  Hazmat: {
    ambientLevel: 0.14,
    ambientColor: 0x1d3a30,
    fogColor: 0x1c4438,
    fogAmount: 0.34,
    saturation: 1.35,
  },
  'Alarm red': {
    ambientLevel: 0.08,
    ambientColor: 0x2a1418,
    fogColor: 0x3a1218,
    fogAmount: 0.3,
    lightFlicker: 1.0,
    saturation: 1.2,
    contrast: 1.2,
  },
};

/** Which control a look key gets, and over what range. */
export interface LookField {
  key: keyof LevelLook;
  label: string;
  kind: 'slider' | 'color' | 'bool';
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}

export interface LookGroup {
  title: string;
  fields: LookField[];
}

/** Every `LevelLook` key, grouped the way the lab groups them. */
export const LOOK_GROUPS: LookGroup[] = [
  {
    title: 'ambient',
    fields: [
      { key: 'ambientLevel', label: 'level', kind: 'slider', min: 0, max: 1, step: 0.005, hint: 'the black point of the room' },
      { key: 'ambientColor', label: 'colour', kind: 'color' },
    ],
  },
  {
    title: 'fog',
    fields: [
      { key: 'fogColor', label: 'colour', kind: 'color' },
      { key: 'fogAmount', label: 'amount', kind: 'slider', min: 0, max: 1.5, step: 0.01 },
      { key: 'fogHeight', label: 'height bias', kind: 'slider', min: 0, max: 1, step: 0.02, hint: '0 = flat wash, 1 = pools on the floor' },
    ],
  },
  {
    title: 'lights',
    fields: [
      { key: 'lightGain', label: 'gain', kind: 'slider', min: 0, max: 3, step: 0.01 },
      { key: 'lightRadiusScale', label: 'radius ×', kind: 'slider', min: 0.2, max: 2, step: 0.01 },
      { key: 'lightFalloff', label: 'falloff', kind: 'slider', min: 0.5, max: 4, step: 0.05 },
      { key: 'lightFlicker', label: 'flicker ×', kind: 'slider', min: 0, max: 2, step: 0.02 },
      { key: 'lightSpill', label: 'spill', kind: 'slider', min: 0, max: 2, step: 0.02, hint: 'how far a pool bleeds past its own falloff' },
    ],
  },
  {
    title: 'volumetrics',
    fields: [
      { key: 'volumeStrength', label: 'strength', kind: 'slider', min: 0, max: 1.5, step: 0.01 },
      { key: 'volumeWidth', label: 'width', kind: 'slider', min: 0.2, max: 2, step: 0.02 },
      { key: 'volumeLength', label: 'length', kind: 'slider', min: 0.2, max: 2, step: 0.02 },
      { key: 'dustAmount', label: 'dust', kind: 'slider', min: 0, max: 4, step: 0.05 },
      { key: 'dustBrightness', label: 'dust glow', kind: 'slider', min: 0, max: 2, step: 0.02 },
    ],
  },
  {
    title: 'wet floor',
    fields: [
      { key: 'reflectOn', label: 'reflections', kind: 'bool', hint: 'off in the engine default — the mask still works' },
      { key: 'reflectAlpha', label: 'strength', kind: 'slider', min: 0, max: 1, step: 0.02 },
      { key: 'reflectSquash', label: 'squash', kind: 'slider', min: 0.1, max: 1, step: 0.01 },
      { key: 'reflectWobble', label: 'wobble', kind: 'slider', min: 0, max: 2, step: 0.02 },
    ],
  },
  {
    title: 'grade',
    fields: [
      { key: 'exposure', label: 'exposure', kind: 'slider', min: 0.2, max: 2.5, step: 0.01 },
      { key: 'contrast', label: 'contrast', kind: 'slider', min: 0.5, max: 2, step: 0.01 },
      { key: 'saturation', label: 'saturation', kind: 'slider', min: 0, max: 2, step: 0.01 },
      { key: 'gamma', label: 'gamma', kind: 'slider', min: 0.5, max: 2, step: 0.01 },
      { key: 'liftColor', label: 'lift', kind: 'color' },
      { key: 'liftAmount', label: 'lift amt', kind: 'slider', min: 0, max: 1, step: 0.01 },
      { key: 'gainColor', label: 'gain', kind: 'color' },
      { key: 'gainAmount', label: 'gain amt', kind: 'slider', min: 0, max: 1, step: 0.01 },
    ],
  },
];
