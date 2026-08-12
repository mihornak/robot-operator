/**
 * LAB PALETTE — deliberately not the shipping palette law.
 *
 * The shipping world is near-monochrome cold gray on purpose. This lab asks a
 * different question: what does the same room look like when the *material* is
 * still restrained but the *light* does the coloring? So the ramp keeps a tight
 * value structure (nothing here is bright — the brightest surface tone is still
 * only ~55% luma) and all the saturation arrives from the lightmap.
 *
 * Rule of thumb used throughout: surfaces are cool and desaturated, LIGHT is
 * warm and saturated, and exactly one accent hue (cyan-green) marks "powered
 * technology". Rust-orange is the only warm *material*, and it is rare.
 */

/**
 * Structural ramp, darkest→lightest. Cool navy-slate, not neutral gray.
 *
 * These are ALBEDO values, and that is the whole reason they look too bright
 * when you open this file. The lightmap multiplies them, so a surface painted
 * at the value you want to SEE ends up at value² once any light touches it —
 * a 0.14 floor under a 0.3 light pool lands at 0.04, which is black. Paint
 * materials at their real reflectance and let the light do the darkening.
 */
export const L = {
  v0: '#10141b', // void / deepest shadow
  v1: '#1c2430', // wall top
  v2: '#28313e',
  v3: '#37424e', // floor base
  v4: '#46525e',
  v5: '#55616d', // wall face base
  v6: '#64707c',
  v7: '#77828e',
  v8: '#8e99a4', // edge highlight
  v9: '#adb6c0', // rare specular lip
} as const;

/** Metals — colder and a touch greener than the structure, so they separate. */
export const M = {
  d0: '#232c36',
  d1: '#38434f',
  d2: '#4d5a68',
  d3: '#667584',
  d4: '#8695a3',
  d5: '#a6b4c0',
  hi: '#cfd9e2',
} as const;

/** The one warm material: rust, old copper, worn hazard paint. */
export const W = {
  rust: '#8a5334',
  rustHi: '#bd7a48',
  rustSh: '#5a3220',
  copper: '#b3853f',
  copperHi: '#e0ac5c',
  // Safety yellow, but pulled a long way off pure: the lane runs the length of
  // the room and full-chroma yellow under a warm lamp turns the floor into the
  // brightest, most saturated thing on screen, which is the robot's job.
  hazard: '#a8904d',
  hazardSh: '#6e5c2f',
  cardboard: '#8a7150',
  cardboardHi: '#ab8f66',
} as const;

/** Emissive colors. These are what the lightmap paints with. */
export const E = {
  /** key: sodium / incandescent ceiling tube */
  key: 0xffb774,
  keyCore: 0xfff0d2,
  /** fill: cold moonlight / window / server-room blue */
  fill: 0x4f8fd6,
  fillCore: 0xcfe6ff,
  /**
   * accent: powered technology, terminals, status LEDs.
   *
   * Pushed green, away from `fill` and `screen`. Under the grade's saturation
   * boost a #4f8fd6 fill, a #64c8ff screen and a #36e0b0 accent collapse into
   * one cyan family, and once every light in the room is the same blue,
   * "powered technology" stops being a signal and becomes the wallpaper.
   */
  accent: 0x2ee89a,
  accentCore: 0xd6fff2,
  /** hazard: alarm strobes, warning panels */
  hazard: 0xff5b3c,
  hazardCore: 0xffd3b0,
  /** screens — pushed bluer for the same reason `accent` was pushed greener */
  screen: 0x7ad0ff,
  screenDim: 0x1d5a7a,
} as const;

/** Organic / soft materials — the room had people in it once. */
export const S = {
  plant: '#4f8256',
  plantHi: '#6ea36a',
  plantSh: '#345c39',
  paper: '#b4bec9',
  paperHi: '#dde5ec',
  paperSh: '#8792a0',
  fabric: '#4a5064',
  fabricHi: '#626a80',
  dirt: '#3a3629',
} as const;

/** Hex string → 0xRRGGBB. */
export const hex = (s: string): number => parseInt(s.slice(1), 16);
