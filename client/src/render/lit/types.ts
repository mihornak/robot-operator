/**
 * The render-side contract for a lit scene, and the numbers a level does not
 * have to carry.
 *
 * Three tiers, and the split is the whole point of this file:
 *
 *   SceneDef     WHAT is in the room — map, dressing, lights, fixtures, water.
 *                Comes from a level (or from the lab's hand-written constants).
 *   LevelLook    HOW the room is lit — ambience, fog, gain, grade. Per level,
 *                every key optional over LOOK_DEFAULTS.
 *   EngineLook   how the RENDERER behaves — shadow shape, AO, rim, sprite
 *                shadows, bloom, lens. NOT per level: these were tuned once, on
 *                sliders, and a level that disagreed with them would be a level
 *                that looks like it came out of a different game.
 *
 * The graphics lab is the one consumer that overrides EngineLook live — that is
 * what it is for. Nothing else should.
 */

import type {
  DecorPlacement,
  FixtureDef,
  LevelLook,
  LightPlacement,
  TileAuthoring,
  WetPatch,
} from '@shared/types';

/** Everything `LitScene` needs to build a room. */
export interface SceneDef {
  /** TILES_Y rows × TILES_X chars, '#' solid. Same grid as LevelData.map. */
  map: readonly string[];
  /** Tile variants and dust. Same seed = same dressing, every time. */
  seed: number;
  decor: readonly DecorPlacement[];
  lights: readonly LightPlacement[];
  fixtures: readonly FixtureDef[];
  wetPatches: readonly WetPatch[];
  /** Already resolved — see `resolveLook`. */
  look: ResolvedLook;
  tiles?: TileAuthoring;
}

export type ResolvedLook = Required<LevelLook>;

/**
 * The baseline look: the tuned values the graphics lab was dialled in to, and
 * what a level renders as before it disagrees with anything.
 *
 * Worth knowing before you "fix" anything here:
 *  - reflections are OFF. The wet-floor mask still works — turn `reflectOn` on
 *    to see it — it just isn't part of this look.
 *  - lightRadiusScale 0.55 with falloff 1.0: many small pools with a long
 *    linear ramp, rather than few big ones with a steep one.
 */
export const LOOK_DEFAULTS: ResolvedLook = {
  ambientLevel: 0.245,
  ambientColor: 0x518ae6,
  fogColor: 0x223349,
  fogAmount: 0.47,
  fogHeight: 1,
  lightGain: 1.2,
  lightRadiusScale: 0.55,
  lightFalloff: 1,
  lightFlicker: 0.22,
  lightSpill: 0.6,
  volumeStrength: 0.3,
  volumeWidth: 1,
  volumeLength: 0.6,
  dustAmount: 1.2,
  dustBrightness: 0.6,
  reflectOn: false,
  reflectAlpha: 0.6,
  reflectSquash: 0.55,
  reflectWobble: 0.3,
  exposure: 1.1,
  contrast: 1.18,
  saturation: 1.12,
  gamma: 1,
  liftColor: 0x1b2a3e,
  liftAmount: 0.13,
  gainColor: 0xffd9b0,
  gainAmount: 0.14,
};

export function resolveLook(look?: LevelLook): ResolvedLook {
  return { ...LOOK_DEFAULTS, ...look };
}

/** Only the keys that actually moved. What the designer and the lab serialise. */
export function lookPatch(look: ResolvedLook): LevelLook {
  const out: Record<string, number | boolean> = {};
  for (const [k, v] of Object.entries(look)) {
    if (v !== (LOOK_DEFAULTS as Record<string, number | boolean>)[k]) out[k] = v;
  }
  return out as LevelLook;
}

/**
 * How the renderer behaves, independent of which room it is drawing.
 *
 * `bloom*` and the lens block are consumed by the POST chain rather than by
 * LitScene itself — they live here because they are the same kind of number and
 * the same tuning session produced them, and a caller assembling a post chain
 * should not have to go looking for where the other half went.
 */
export interface EngineLook {
  lightsOn: boolean;
  emissiveGain: number;
  /** Light shafts and the dust that drifts through them. */
  volumeOn: boolean;

  // ---- shadow volumes (walls, in the lightmap)
  shadowsOn: boolean;
  shadowAlpha: number;
  shadowSoftness: number;
  shadowLength: number;
  shadowBias: number;
  shadowFade: number;
  shadowNear: number;
  /** Steps the distance fade is built from. More = smoother ramp. */
  shadowBands: number;

  // ---- projected sprite shadows (props and bodies, on the floor)
  spriteShadowOn: boolean;
  spriteShadowAlpha: number;
  spriteShadowLength: number;
  /** How many lights each character casts a shadow from. Capped at 4. */
  spriteShadowCount: number;
  /** Where the shadow hinges on the body, px from the sprite origin. */
  spriteShadowFoot: number;
  spriteShadowSoftness: number;
  spriteShadowSquash: number;

  aoOn: boolean;
  aoStrength: number;
  aoRadius: number;

  rimOn: boolean;
  rimStrength: number;
  rimOffset: number;

  /** How much of the world's lighting the CHARACTERS take. 1 = same response as
   *  everything else; 0 = flat, unlit sprites at their painted values. */
  charLightResponse: number;
  charTint: number;

  // ---- post chain (not read by LitScene; see the note above)
  bloomOn: boolean;
  bloomThreshold: number;
  bloomScale: number;
  bloomBrightness: number;
  bloomBlur: number;
  vignette: number;
  vignetteSoft: number;
  chroma: number;
  grain: number;
  scanline: number;
  crtOn: boolean;
  crtCurve: number;
}

/**
 * Bloom is OFF: the emissive layer carries the glow on its own, and bloom on top
 * of it was eating the pixel edges. `shadowSoftness` is 0 for the same kind of
 * reason — hard edges are the style, and the distance FADE does the work a blur
 * was doing badly.
 */
export const ENGINE_DEFAULTS: EngineLook = {
  lightsOn: true,
  emissiveGain: 1.01,
  volumeOn: true,
  shadowsOn: true,
  shadowAlpha: 0.42,
  shadowSoftness: 0,
  shadowLength: 1,
  shadowBias: 1.5,
  shadowFade: 0.62,
  shadowNear: 0.3,
  shadowBands: 5,
  spriteShadowOn: true,
  spriteShadowAlpha: 0.6,
  spriteShadowLength: 1,
  spriteShadowCount: 3,
  spriteShadowFoot: -2,
  spriteShadowSoftness: 1.2,
  spriteShadowSquash: 0.42,
  aoOn: true,
  aoStrength: 0.35,
  aoRadius: 0.5,
  rimOn: true,
  rimStrength: 0.4,
  rimOffset: 0,
  charLightResponse: 0.48,
  charTint: 0xf5eccc,
  bloomOn: false,
  bloomThreshold: 0.44,
  bloomScale: 0.5,
  bloomBrightness: 1,
  bloomBlur: 7.5,
  vignette: 0.5,
  vignetteSoft: 0.58,
  chroma: 1.99,
  grain: 0.045,
  scanline: 0.1,
  crtOn: true,
  crtCurve: 0.22,
};

/**
 * One switch per draw pass, and one per stage that writes into the lightmap.
 *
 * These exist because a visual artefact you cannot attribute to a layer is a
 * visual artefact you end up guessing about — and guessing costs more than the
 * switches do. Every one of them is ON in a healthy frame; the graphics lab
 * turns them off one at a time, which is how all four rules in README.md were
 * found after several rounds of guessing had failed.
 */
export interface LitDebug {
  layerFloor: boolean;
  layerWalls: boolean;
  layerProps: boolean;
  layerCharacters: boolean;
  layerPropShadows: boolean;
  layerBodyShadows: boolean;
  layerContact: boolean;
  layerReflect: boolean;
  layerRim: boolean;
  layerEmissive: boolean;
  layerDust: boolean;
  layerVolume: boolean;
  layerFog: boolean;
  layerLightmap: boolean;
  layerMasks: boolean;
  lmAmbient: boolean;
  lmLights: boolean;
  lmAo: boolean;
  lmShadowVolumes: boolean;
  lmPropOccluders: boolean;
  lmFootprints: boolean;
  lmSpill: boolean;
  /** Draw the raw lightmap instead of the world. The only way to tell "this
   *  light is wrong" from "this material is wrong" — through a multiply they
   *  look identical. */
  showLightmap: boolean;
  showOccluders: boolean;
}

export const DEBUG_DEFAULTS: LitDebug = {
  layerFloor: true,
  layerWalls: true,
  layerProps: true,
  layerCharacters: true,
  layerPropShadows: true,
  layerBodyShadows: true,
  layerContact: true,
  layerReflect: true,
  layerRim: true,
  layerEmissive: true,
  layerDust: true,
  layerVolume: true,
  layerFog: true,
  layerLightmap: true,
  layerMasks: true,
  lmAmbient: true,
  lmLights: true,
  lmAo: true,
  lmShadowVolumes: true,
  lmPropOccluders: true,
  lmFootprints: true,
  lmSpill: true,
  showLightmap: false,
  showOccluders: false,
};

// ------------------------------------------------------------------- actors

/**
 * One layer of a moving body. A robot is wheels + hull + head, each animating on
 * its own clock; a printer is one sprite. The caller picks the frames — LitScene
 * only lights what it is handed.
 */
export interface ActorPart {
  /** A pixi Texture. Typed loosely so this module stays importable from data. */
  texture: unknown;
  /** Offset from the actor's origin, px. Negative is up. */
  y: number;
  /** Sideways offset from the actor's origin, px. Default 0 — a part only needs
   *  it when the body leans, which is a thing the game's robot does and the
   *  lab's stand-in does not. */
  x?: number;
  /** Mirror horizontally. */
  flip?: boolean;
  /** Uniform scale. The game upscales a few sprites past their manifest size
   *  (the crate is THE pickup); the shadow and the rim follow it. */
  scale?: number;
  /**
   * Multiplied INTO the light response, not instead of it — a hit flash has to
   * still be a hit flash in an unlit corner, and a looted crate has to still
   * take the room's light while it greys out.
   */
  tint?: number;
  /**
   * Draw additively — this layer is LIGHT, not surface. It also stops casting
   * and stops taking a rim, which is what makes an ember leaking out of a
   * debris heap read as a glow rather than as a second body.
   */
  additive?: boolean;
  /** Per-layer opacity, default 1. What a breathing ember modulates. */
  alpha?: number;
}

export interface ActorState {
  /** Stable across frames — it is what keys the shadow rig. */
  id: string;
  /** World px. The origin is the middle of the body, NOT its feet. */
  x: number;
  y: number;
  parts: ActorPart[];
  /**
   * Distance from the origin down to the floor. Defaults to ACTOR_FOOT (9),
   * which is where the robot's wheels and the printer's hull both bottom out.
   */
  foot?: number;
  /**
   * Y-sort key. Defaults to `y + foot` — the FEET, which is where a standing
   * body meets the room. A thing lying flat on the deck has no feet and belongs
   * under everything standing on it, which is what this is for.
   */
  z?: number;
  /** Whole-body fade, shadows included. Default 1. A body that dies by
   *  vanishing between two frames reads as a dropped frame, not as a death. */
  alpha?: number;
  /** Body tilt, radians — the death slump. */
  rotation?: number;
  /** Body squash about the origin, default 1 — the bump recoil. */
  scaleX?: number;
  scaleY?: number;
  /** Does this body cast? Default true. A cable lying on the floor casting a
   *  silhouette is a cable that looks like it is hovering. */
  shadow?: boolean;
}

/** What a `light` trigger action, or a designer inspector, can change live. */
export interface LightState {
  on?: boolean;
  intensity?: number;
}
