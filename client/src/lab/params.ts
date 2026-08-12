/**
 * GRAPHICS LAB — the single source of truth for every tunable.
 *
 * `P` is a plain mutable value bag the renderer reads every frame. `SCHEMA`
 * describes those same keys for the slider panel. Nothing here imports pixi or
 * the DOM, so both sides can depend on it.
 *
 * This directory deliberately ignores the repo's palette law (CLAUDE.md rules
 * about near-monochrome grays). It is a lab: the point is to find out what a
 * cinematic, fully-lit version of the room looks like before deciding what of
 * it earns a place in the shipping game. The self-contained bundle law still
 * holds — no CDN, no remote assets, everything code-drawn.
 */

import { LAMP_STYLE_NAMES, WALL_STYLE_NAMES } from './fixtures';

export type ParamKind = 'num' | 'bool' | 'color' | 'select';

export interface ParamSpec {
  key: keyof Params;
  kind: ParamKind;
  group: string;
  label: string;
  /** num only */
  min?: number;
  max?: number;
  step?: number;
  /** select only */
  options?: readonly string[];
  hint?: string;
}

export interface Params {
  // ---------------------------------------------------------------- ambient
  ambientLevel: number;
  ambientColor: number;
  ambientWarmBias: number;
  fogColor: number;
  fogAmount: number;
  fogHeight: number;

  // ----------------------------------------------------------------- lights
  lightsOn: boolean;
  lightGain: number;
  lightRadiusScale: number;
  lightFalloff: number;
  lightFlicker: number;
  keyColor: number;
  fillColor: number;
  accentColor: number;
  emissiveGain: number;
  lightSpill: number;

  // ---------------------------------------------------------------- shadows
  shadowsOn: boolean;
  shadowAlpha: number;
  shadowSoftness: number;
  shadowLength: number;
  shadowBias: number;
  shadowFade: number;
  shadowNear: number;
  /** How many steps the distance fade is built from. More = smoother ramp. */
  shadowBands: number;
  spriteShadowOn: boolean;
  spriteShadowAlpha: number;
  spriteShadowLength: number;
  /** How many lights each character casts a shadow from. */
  spriteShadowCount: number;
  /** Where the shadow hinges on the body, in px from the sprite origin. */
  spriteShadowFoot: number;
  spriteShadowSoftness: number;
  spriteShadowSquash: number;

  // --------------------------------------------------------------------- AO
  aoOn: boolean;
  aoStrength: number;
  aoRadius: number;

  // -------------------------------------------------------------- rim light
  rimOn: boolean;
  rimStrength: number;
  rimOffset: number;

  // -------------------------------------------------------------- character
  /**
   * How much of the world's lighting the CHARACTERS take. 1 = same response as
   * everything else; 0 = flat, unlit sprites at their painted values.
   */
  charLightResponse: number;
  charTint: number;
  /** Off = characters hold position; you can still drag them. */
  autoWalk: boolean;

  // ---------------------------------------------------------- ceiling lamps
  /** Which fixture the lamp controls below edit: 'all' or one lamp id. */
  fixtureTarget: string;
  lampStyle: string;
  lampScale: number;
  lampBodyAlpha: number;
  lampGlow: number;
  /** Same four controls again, for the wall-mounted fixtures. */
  wallTarget: string;
  wallStyle: string;
  wallScale: number;
  wallBodyAlpha: number;
  wallGlow: number;
  /** Where the housing sits on its 16px wall face, in px. Negative = higher. */
  wallMountY: number;
  /** Where this fixture's light sits relative to the housing, in px. */
  wallLightX: number;
  wallLightY: number;
  /** Size of the sconce's wall-wash — what lights the wall and nearby props. */
  wallSpill: number;

  // ------------------------------------------------------------ volumetrics
  volumeOn: boolean;
  volumeStrength: number;
  volumeWidth: number;
  volumeLength: number;
  dustAmount: number;
  dustBrightness: number;

  // ------------------------------------------------------------- reflection
  reflectOn: boolean;
  reflectAlpha: number;
  reflectSquash: number;
  reflectWobble: number;

  // ------------------------------------------------------------------ bloom
  bloomOn: boolean;
  bloomThreshold: number;
  bloomScale: number;
  bloomBrightness: number;
  bloomBlur: number;

  // ------------------------------------------------------------------ grade
  gradeOn: boolean;
  saturation: number;
  contrast: number;
  exposure: number;
  liftColor: number;
  liftAmount: number;
  gainColor: number;
  gainAmount: number;
  gamma: number;

  // ------------------------------------------------------------------- lens
  vignette: number;
  vignetteSoft: number;
  chroma: number;
  grain: number;
  scanline: number;
  crtOn: boolean;
  crtCurve: number;

  // ----------------------------------------------------------------- camera
  cameraZoom: number;
  cameraDrift: number;
  cameraShake: number;

  // ----------------------------------------------------------------- layers
  /** Bisection switches. Every one of these is ON in a healthy frame. */
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
  /** Inside the lightmap: each stage of it, separately. */
  lmAmbient: boolean;
  lmLights: boolean;
  lmAo: boolean;
  lmShadowVolumes: boolean;
  lmPropOccluders: boolean;
  lmFootprints: boolean;
  lmSpill: boolean;

  // ------------------------------------------------------------------ debug
  showLightmap: boolean;
  showOccluders: boolean;
  timeScale: number;
  paused: boolean;
}

/**
 * Defaults = the tuned look, dialled in on the sliders and folded back here.
 * Change these, not the UI.
 *
 * Worth knowing before you "fix" anything that looks wrong in this block:
 *  - bloom is OFF. The emissive layer carries the glow on its own, and bloom on
 *    top of it was eating the pixel edges.
 *  - shadowSoftness is 0. Hard edges are the style; the distance FADE
 *    (shadowFade) does the work a blur was doing badly.
 *  - reflections are OFF. The wet-floor mask still works — turn `reflectOn` on
 *    to see it — it just isn't part of this look.
 *  - lightRadiusScale 0.55 with falloff 1.0: many small pools with a long
 *    linear ramp, rather than few big ones with a steep one.
 */
export const DEFAULTS: Params = {
  ambientLevel: 0.245,
  ambientColor: 0x518ae6,
  ambientWarmBias: 0.35,
  fogColor: 0x223349,
  fogAmount: 0.47,
  fogHeight: 1,
  lightsOn: true,
  lightGain: 1.2,
  lightRadiusScale: 0.55,
  lightFalloff: 1,
  lightFlicker: 0.22,
  keyColor: 0xffb774,
  fillColor: 0x5778ff,
  accentColor: 0x2ee89a,
  emissiveGain: 1.01,
  lightSpill: 0.6,
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
  autoWalk: true,

  fixtureTarget: 'all',
  lampStyle: 'none',
  lampScale: 1,
  lampBodyAlpha: 1,
  lampGlow: 1,
  wallTarget: 'all',
  wallStyle: 'sconce',
  wallScale: 1,
  wallBodyAlpha: 1,
  wallGlow: 1,
  wallMountY: -2.5,
  wallLightX: 0,
  wallLightY: -0.5,
  wallSpill: 1,

  volumeOn: true,
  volumeStrength: 0.3,
  volumeWidth: 1,
  volumeLength: 0.6,
  dustAmount: 1.2,
  dustBrightness: 0.6,
  reflectOn: false,
  reflectAlpha: 0.6,
  reflectSquash: 0.55,
  reflectWobble: 0.3,
  bloomOn: false,
  bloomThreshold: 0.44,
  bloomScale: 0.5,
  bloomBrightness: 1,
  bloomBlur: 7.5,
  gradeOn: true,
  saturation: 1.12,
  contrast: 1.18,
  exposure: 1.1,
  liftColor: 0x1b2a3e,
  liftAmount: 0.13,
  gainColor: 0xffd9b0,
  gainAmount: 0.14,
  gamma: 1,
  vignette: 0.5,
  vignetteSoft: 0.58,
  chroma: 1.99,
  grain: 0.045,
  scanline: 0.1,
  crtOn: true,
  crtCurve: 0.22,
  cameraZoom: 1,
  cameraDrift: 0,
  cameraShake: 0,
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
  timeScale: 1,
  paused: false,
};

/** Live values. Mutated by the UI, read by the renderer. */
export const P: Params = { ...DEFAULTS };

const n = (
  key: keyof Params,
  group: string,
  label: string,
  min: number,
  max: number,
  step: number,
  hint?: string,
): ParamSpec => ({ key, kind: 'num', group, label, min, max, step, hint });
const b = (key: keyof Params, group: string, label: string, hint?: string): ParamSpec => ({
  key,
  kind: 'bool',
  group,
  label,
  hint,
});
const c = (key: keyof Params, group: string, label: string, hint?: string): ParamSpec => ({
  key,
  kind: 'color',
  group,
  label,
  hint,
});

const sel = (
  key: keyof Params,
  group: string,
  label: string,
  options: readonly string[],
  hint?: string,
): ParamSpec => ({ key, kind: 'select', group, label, options, hint });

/**
 * Every ceiling fixture, by the id of the light it belongs to, plus 'all'.
 * Kept in sync with LAB_DECOR by hand — the lab has seven of them and they
 * change about once a session.
 */
export const FIXTURE_TARGETS = [
  'all',
  'tube_a',
  'tube_b',
  'tube_c',
  'tube_d',
  'tube_server',
  'tube_admin',
] as const;

/** Wall-mounted fixtures, by the id of the light each one carries. */
export const WALL_TARGETS = [
  'all',
  'wall_admin_1',
  'wall_admin_2',
  'wall_admin_3',
  'wall_server_1',
  'wall_server_2',
  'wall_pillar_1',
  'wall_pillar_2',
  'wall_pillar_3',
] as const;

export const SCHEMA: readonly ParamSpec[] = [
  // ambient
  n('ambientLevel', 'Ambient', 'ambient level', 0, 1, 0.005, 'how lit the unlit world is'),
  c('ambientColor', 'Ambient', 'ambient color', 'color of everything shadowed'),
  n('ambientWarmBias', 'Ambient', 'warm bias', 0, 1, 0.01, 'pulls ambient toward the key hue'),
  c('fogColor', 'Ambient', 'haze color'),
  n('fogAmount', 'Ambient', 'haze amount', 0, 1, 0.01, 'flat atmospheric wash over the room'),
  n('fogHeight', 'Ambient', 'haze gradient', 0, 1, 0.01, '0 = flat, 1 = pools at the bottom'),

  // lights
  b('lightsOn', 'Lights', 'lights enabled'),
  n('lightGain', 'Lights', 'master gain', 0, 3, 0.01),
  n('lightRadiusScale', 'Lights', 'radius scale', 0.2, 3, 0.01),
  n('lightFalloff', 'Lights', 'falloff exponent', 0.5, 4, 0.05, 'higher = tighter pools'),
  n('lightFlicker', 'Lights', 'flicker', 0, 2, 0.01),
  c('keyColor', 'Lights', 'key (warm)'),
  c('fillColor', 'Lights', 'fill (cool)'),
  c('accentColor', 'Lights', 'accent'),
  n('emissiveGain', 'Lights', 'emissive gain', 0, 3, 0.01, 'brightness of glowing sprites'),
  n('lightSpill', 'Lights', 'colour spill', 0, 1.5, 0.01, 'how much a light tints a surface that has no such colour of its own'),

  // shadows
  b('shadowsOn', 'Shadows', 'cast shadows'),
  n('shadowAlpha', 'Shadows', 'darkness', 0, 1, 0.01),
  n('shadowSoftness', 'Shadows', 'softness (px)', 0, 8, 0.1),
  n('shadowLength', 'Shadows', 'length', 0.2, 3, 0.01),
  n('shadowBias', 'Shadows', 'contact bias (px)', 0, 6, 0.1, 'pulls shadows off the caster'),
  n('shadowFade', 'Shadows', 'distance fade', 0, 1, 0.01, 'how much a shadow fades along its length; 1 = fades to nothing at the tip'),
  n('shadowBands', 'Shadows', 'fade steps', 2, 8, 1, 'steps the fade is built from; more is smoother and costs a little more bake'),
  n('shadowNear', 'Shadows', 'contact length', 0.05, 1, 0.01, 'fraction of the shadow that stays at full darkness'),
  b('spriteShadowOn', 'Shadows', 'sprite shadows'),
  n('spriteShadowAlpha', 'Shadows', 'sprite darkness', 0, 1, 0.01),
  n('spriteShadowLength', 'Shadows', 'sprite length', 0, 3, 0.01),
  n('spriteShadowCount', 'Shadows', 'shadows per body', 1, 4, 1, 'how many light sources a character casts from'),
  n('spriteShadowFoot', 'Shadows', 'sprite hinge y', -10, 8, 0.5, 'where the shadow attaches to the body; negative is higher'),
  n('spriteShadowSoftness', 'Shadows', 'sprite softness', 0, 6, 0.1),
  n('spriteShadowSquash', 'Shadows', 'sprite squash', 0.1, 1, 0.01),

  // AO
  b('aoOn', 'Occlusion', 'ambient occlusion'),
  n('aoStrength', 'Occlusion', 'strength', 0, 1.5, 0.01),
  n('aoRadius', 'Occlusion', 'radius (px)', 0.5, 12, 0.1),

  // rim
  b('rimOn', 'Rim light', 'rim light'),
  n('rimStrength', 'Rim light', 'strength', 0, 1.5, 0.01),
  n('rimOffset', 'Rim light', 'offset (px)', 0, 3, 0.05),

  // character
  n('charLightResponse', 'Character', 'light response', 0, 1.5, 0.01, 'how much the lightmap brightens the robot and enemies; the floor is unaffected'),
  c('charTint', 'Character', 'body tint', 'multiplies the character sprites, after light response'),
  b('autoWalk', 'Character', 'auto-walk', 'off = they stand still; drag them anywhere either way'),

  // ceiling lamps
  sel('fixtureTarget', 'Fixtures', 'editing', FIXTURE_TARGETS, 'which lamp the controls below apply to'),
  sel('lampStyle', 'Fixtures', 'style', LAMP_STYLE_NAMES, 'the fixture sprite; the light itself never changes'),
  n('lampScale', 'Fixtures', 'size', 0.4, 3, 0.05),
  n('lampBodyAlpha', 'Fixtures', 'housing opacity', 0, 1, 0.01, 'fade the fixture body out without touching its light'),
  n('lampGlow', 'Fixtures', 'lit face', 0, 3, 0.01),
  sel('wallTarget', 'Wall lights', 'editing', WALL_TARGETS, 'which wall lamp the controls below apply to'),
  sel('wallStyle', 'Wall lights', 'style', WALL_STYLE_NAMES),
  n('wallScale', 'Wall lights', 'size', 0.4, 3, 0.05),
  n('wallBodyAlpha', 'Wall lights', 'housing opacity', 0, 1, 0.01),
  n('wallGlow', 'Wall lights', 'lit face', 0, 3, 0.01),
  n('wallMountY', 'Wall lights', 'mount height', -14, 10, 0.5, 'where the housing sits on the wall face; negative is higher'),
  n('wallLightX', 'Wall lights', 'light offset x', -24, 24, 0.5),
  n('wallLightY', 'Wall lights', 'light offset y', -16, 32, 0.5, 'how far below the housing its pool starts'),
  n('wallSpill', 'Wall lights', 'wall wash', 0, 3, 0.05, 'how far the sconce lights its own wall and the props beside it'),

  // volumetrics
  b('volumeOn', 'Volumetrics', 'light shafts'),
  n('volumeStrength', 'Volumetrics', 'strength', 0, 1.5, 0.01),
  n('volumeWidth', 'Volumetrics', 'cone width', 0.3, 2.5, 0.01),
  n('volumeLength', 'Volumetrics', 'cone length', 0.3, 2.5, 0.01),
  n('dustAmount', 'Volumetrics', 'dust density', 0, 3, 0.01),
  n('dustBrightness', 'Volumetrics', 'dust brightness', 0, 1.5, 0.01),

  // reflections
  b('reflectOn', 'Wet floor', 'reflections'),
  n('reflectAlpha', 'Wet floor', 'strength', 0, 1, 0.01),
  n('reflectSquash', 'Wet floor', 'squash', 0.1, 1, 0.01),
  n('reflectWobble', 'Wet floor', 'wobble', 0, 2, 0.01),

  // bloom
  b('bloomOn', 'Bloom', 'bloom'),
  n('bloomThreshold', 'Bloom', 'threshold', 0, 1, 0.01),
  n('bloomScale', 'Bloom', 'scale', 0, 3, 0.01),
  n('bloomBrightness', 'Bloom', 'brightness', 0, 2, 0.01),
  n('bloomBlur', 'Bloom', 'blur', 0, 16, 0.5),

  // grade
  b('gradeOn', 'Grade', 'color grade'),
  n('exposure', 'Grade', 'exposure', 0.2, 2.5, 0.01),
  n('contrast', 'Grade', 'contrast', 0.4, 2, 0.01),
  n('saturation', 'Grade', 'saturation', 0, 2.5, 0.01),
  n('gamma', 'Grade', 'gamma', 0.4, 2.2, 0.01),
  c('liftColor', 'Grade', 'shadow tint'),
  n('liftAmount', 'Grade', 'shadow tint amt', 0, 1, 0.01),
  c('gainColor', 'Grade', 'highlight tint'),
  n('gainAmount', 'Grade', 'highlight tint amt', 0, 1, 0.01),

  // lens
  n('vignette', 'Lens', 'vignette', 0, 1.5, 0.01),
  n('vignetteSoft', 'Lens', 'vignette softness', 0.05, 1, 0.01),
  n('chroma', 'Lens', 'chromatic aberration', 0, 3, 0.01),
  n('grain', 'Lens', 'film grain', 0, 0.4, 0.005),
  n('scanline', 'Lens', 'scanlines', 0, 0.5, 0.005),
  b('crtOn', 'Lens', 'CRT curve'),
  n('crtCurve', 'Lens', 'curve amount', 0, 1, 0.01),

  // camera
  n('cameraZoom', 'Camera', 'zoom', 0.6, 2.5, 0.01),
  n('cameraDrift', 'Camera', 'idle drift', 0, 2, 0.01),
  n('cameraShake', 'Camera', 'shake', 0, 4, 0.01),

  // layers — one switch per draw pass, for bisecting a visual artefact
  b('layerFloor', 'Layers', 'floor tiles'),
  b('layerWalls', 'Layers', 'wall tiles'),
  b('layerProps', 'Layers', 'props'),
  b('layerCharacters', 'Layers', 'characters'),
  b('layerBodyShadows', 'Layers', 'character shadows'),
  b('layerContact', 'Layers', 'contact patches'),
  b('layerPropShadows', 'Layers', 'prop shadows'),
  b('layerReflect', 'Layers', 'reflections'),
  b('layerRim', 'Layers', 'rim light'),
  b('layerEmissive', 'Layers', 'emissive faces'),
  b('layerDust', 'Layers', 'dust'),
  b('layerVolume', 'Layers', 'light shafts'),
  b('layerFog', 'Layers', 'haze'),
  b('layerLightmap', 'Layers', 'lightmap multiply'),
  b('layerMasks', 'Layers', 'floor / wet masks'),

  // inside the lightmap — every stage that writes into it
  b('lmAmbient', 'Lightmap', 'ambient fill'),
  b('lmLights', 'Lightmap', 'light blits'),
  b('lmAo', 'Lightmap', 'ambient occlusion pass', 'contact darkening on the floor only'),
  b('lmShadowVolumes', 'Lightmap', 'shadow volumes'),
  b('lmPropOccluders', 'Lightmap', 'props occlude light', 'off = only walls block light'),
  b('lmFootprints', 'Lightmap', 'occluder footprints', 'dark patch on the floor under each prop; floor only'),
  b('lmSpill', 'Lightmap', 'colour spill term'),

  // debug
  b('showLightmap', 'Debug', 'show lightmap'),
  b('showOccluders', 'Debug', 'show occluders'),
  n('timeScale', 'Debug', 'time scale', 0, 3, 0.01),
  b('paused', 'Debug', 'pause'),
];

export const GROUPS: readonly string[] = [
  ...new Set(SCHEMA.map((s) => s.group)),
];

/** Named looks the panel can jump to. Partial — unset keys keep DEFAULTS. */
export const PRESETS: Record<string, Partial<Params>> = {
  Default: {},
  'Flat (old look)': {
    ambientLevel: 0.85,
    ambientColor: 0xffffff,
    ambientWarmBias: 0,
    fogAmount: 0,
    lightGain: 0.25,
    shadowsOn: false,
    spriteShadowOn: false,
    aoOn: false,
    rimOn: false,
    volumeOn: false,
    reflectOn: false,
    bloomOn: false,
    gradeOn: false,
    vignette: 0.1,
    chroma: 0,
    grain: 0.02,
  },
  Nightshift: {
    ambientLevel: 0.1,
    ambientColor: 0x1d2a44,
    fogColor: 0x16223a,
    fogAmount: 0.3,
    keyColor: 0xffa24d,
    fillColor: 0x3f7ccc,
    lightGain: 1.25,
    lightFalloff: 2.3,
    bloomScale: 1.15,
    saturation: 1.25,
    vignette: 0.6,
  },
  Blackout: {
    ambientLevel: 0.04,
    ambientColor: 0x101a2c,
    lightGain: 1.5,
    lightFlicker: 1.4,
    lightFalloff: 2.6,
    fogAmount: 0.12,
    bloomScale: 1.3,
    vignette: 0.8,
    chroma: 1.1,
    grain: 0.11,
  },
  Hazmat: {
    ambientLevel: 0.14,
    ambientColor: 0x1d3a30,
    fogColor: 0x1c4438,
    fogAmount: 0.34,
    keyColor: 0xd8ff7a,
    fillColor: 0x2ad0a0,
    accentColor: 0xff5b3c,
    saturation: 1.35,
    bloomScale: 1.1,
  },
  'Alarm red': {
    ambientLevel: 0.08,
    ambientColor: 0x2a1418,
    fogColor: 0x3a1218,
    fogAmount: 0.3,
    keyColor: 0xff4a3a,
    fillColor: 0x8a2230,
    accentColor: 0xffd08a,
    lightFlicker: 1.0,
    saturation: 1.2,
    contrast: 1.2,
    vignette: 0.7,
  },
};
