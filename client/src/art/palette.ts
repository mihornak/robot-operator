/**
 * PALETTE LAW (shared/artManifest.ts): dark near-monochrome cold-gray world,
 * the ROBOT is the only saturated thing, enemies desaturated rust/olive,
 * amber #ffb000 reserved for OSD/glyphs. Every color in art comes from here.
 */

/** World grays, darkest→lightest, faint blue-green cast. */
export const G = {
  g0: '#101216', // wall top / deepest
  g1: '#14161a',
  g2: '#181b20', // floor base
  g3: '#1e2227',
  g4: '#23272d', // wall face base
  g5: '#2a2f36',
  g6: '#323841',
  g7: '#3a4048', // brightest structural gray
  g8: '#454c55', // rare edge highlight
} as const;

/** The robot — sole saturation on screen. */
export const ROBOT = {
  base: '#ff7a1a',
  hi: '#ffab52',
  shade: '#a34a0e',
  deep: '#6e3208',
  eye: '#ffc36b',
  eyeCore: '#fff3d6',
  tread: '#23252b',
  treadHi: '#34373e',
  treadLug: '#141519',
  socket: '#1b1d22', // dark lens housings / axles
} as const;

/** Enemies — rust/olive, murky. Dull red LED is the sole non-robot accent. */
export const FOE = {
  rust: '#5a4a3a',
  rustHi: '#6e5c48',
  rustSh: '#3f3428',
  olive: '#6b6b4f',
  oliveHi: '#7d7d60',
  oliveSh: '#4c4c38',
  maw: '#15171b',
  ledRed: '#9c3f32',
  ledRedDim: '#57281f',
  ledGreen: '#4d9b64',
  ledGreenDim: '#28513a',
} as const;

/** Neutral prop materials. */
export const MAT = {
  paper: '#b9bdc2',
  paperSh: '#8e939a',
  paperHi: '#dfe2e6',
  glint: '#e9eef2',
  metal: '#4a525c',
  metalHi: '#5d6671',
  metalSh: '#343a42',
  drab: '#3b3f35', // military crate
  drabHi: '#4c5143',
  drabSh: '#2a2d24',
  ceramic: '#7e786a',
  ceramicSh: '#5c574c',
  copper: '#8a6f42',
  copperDim: '#5c4a2c',
  wood: '#55483c', // desaturated mop handle
} as const;

/** FX. Blue-white sparks; warm tracer is robot-emitted (allowed). */
export const FX = {
  sparkCore: '#eaf6ff',
  spark: '#7fd4ff',
  sparkDim: '#3f6a80',
  boltCore: '#fff3d6',
  bolt: '#ffc36b',
  smoke1: '#3d434b',
  smoke2: '#4a515a',
  smoke3: '#5a626c',
  flash: '#cdd6dd', // boom flash — pale gray, never fire-colored
  glowWarm: '#6f5c33', // faint warm interior glow (crate)
  glowWarmHi: '#96793c',
  teal: '#3a5a55', // pedestal charge strip, muted
  tealHi: '#517d74',
} as const;

/** Glyphs only (OSD-adjacent). */
export const AMBER = '#ffb000';
