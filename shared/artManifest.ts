/**
 * Every texture in the game, by name. `client/src/art` implements each as
 * code-drawn pixel art; `client/src/render` consumes by name. Sizes in px.
 *
 * PALETTE LAW: the world is dark near-monochrome (cold grays #14161a..#3a4048,
 * faint blue-green cast). The ROBOT is the only saturated thing on screen
 * (safety-orange body #ff7a1a, warm amber eye #ffc36b, cyan accents allowed on
 * FX it emits). Amber #ffb000 is reserved for OSD/UI, drawn by render, not art.
 * Enemies get desaturated rust/olive — menacing, never colorful.
 */

export interface ArtEntry {
  /** Frame count (animations loop unless render decides otherwise). */
  frames: number;
  w: number;
  h: number;
  /** Anchor 0..1; default [0.5, 0.5]. */
  anchor?: [number, number];
  /**
   * Where the pixels come from. Default 'code' — a drawer in `client/src/art`.
   *
   * 'png' entries are pre-rendered at BUILD time from a 3D model by
   * `tools/render-sprite.py` (Blender, headless) and live in
   * `client/src/art/sprites/`. The bundle law is untouched: the model stays in
   * gitignored `art-src/`, only the finished pixels ship, and at these sizes
   * Vite inlines the PNG as a data URI. Single-frame only for now — a frame
   * count means an animation, which means a strip, which the pipeline doesn't
   * cut yet.
   */
  src?: 'code' | 'png';
}

export const ART = {
  // --- robot (composed: wheels under body under head; head drawn for 8 dirs) ---
  robot_body: { frames: 2, w: 18, h: 14 }, // idle bob; saturated orange chassis
  robot_wheels: { frames: 4, w: 18, h: 8 }, // tread roll cycle
  /** Head per direction: frames = 8, order E,SE,S,SW,W,NW,N,NE. Dome + eye light. */
  robot_head: { frames: 8, w: 12, h: 10 },
  /** Broken-off parts that fly on damage. */
  part_plate: { frames: 1, w: 6, h: 5 },
  part_antenna: { frames: 1, w: 3, h: 7 },

  // --- enemies ---
  /** Printer melted onto a vacuum. 4-frame lurch-roll, papers jammed in teeth. */
  fused_printer: { frames: 4, w: 22, h: 18 },
  fused_printer_spit: { frames: 2, w: 22, h: 18 }, // attack telegraph + spit
  /** The floor-6 boss. PLACEHOLDER: a single blocky silhouette that reads as
   *  "much bigger machine" at the right size and palette, so layout, shadow and
   *  collision can be tuned against real pixels. The real thing is a character
   *  — its maw has to read as a face at 34px — and is hand-drawn over ~9 frames. */
  fused_shredder: { frames: 1, w: 34, h: 26 },
  printer_innocent: { frames: 2, w: 16, h: 12 }, // peaceful blinking LED
  mop: { frames: 1, w: 8, h: 18 },
  /**
   * Office chair — the first prop rendered from a 3D model instead of drawn.
   * Same job as the mop: furniture the robot can misidentify, and proof the
   * asset-store pipeline lands in the room's projection and palette. Anchor is
   * the measured ground contact (its castors), not the sprite's middle.
   */
  office_chair: { frames: 1, w: 16, h: 20, anchor: [0.5, 0.8], src: 'png' },

  // --- props / pickups ---
  scrap: { frames: 2, w: 8, h: 6 }, // glint frame
  /** The opening heap of dead machines the robot sleeps inside. Frames:
   *  0 settled, 1/2 stir (it shifts while something moves under it),
   *  3 burst open (after the wake — a hole where the robot came out). */
  debris_pile: { frames: 4, w: 44, h: 30, anchor: [0.5, 0.78] },
  /** A loose personality chip on the floor. 4-frame glint pulse — small, but
   *  it must say PICK ME UP from across the room. */
  chip_item: { frames: 4, w: 10, h: 8 },
  crate: { frames: 2, w: 14, h: 12 }, // closed / open
  /** THE shiny triad pickup — one per ceremony floor. 4-frame beacon pulse:
   *  latched case, warm inner light leaking through the seams. Must read as
   *  "the important thing" from across a dark room. */
  crate_triad: { frames: 4, w: 16, h: 14 },
  pedestal: { frames: 2, w: 18, h: 8 }, // charging glow pulse
  fuse: { frames: 1, w: 6, h: 10 },
  fuse_socket: { frames: 2, w: 10, h: 12 }, // empty / filled+lit
  cable: { frames: 4, w: 32, h: 10 }, // sparking floor cable, arc frames
  elevator: { frames: 4, w: 26, h: 30, anchor: [0.5, 0.85] }, // doors: closed,1/3,2/3,open — reuse for A and B; render tints the lit one

  // --- tiles (render builds the tilemap from these) ---
  tile_floor: { frames: 4, w: 16, h: 16 }, // subtle variants, grime
  tile_wall_face: { frames: 2, w: 16, h: 16 }, // south-facing wall face
  tile_wall_top: { frames: 1, w: 16, h: 16 },
  tile_shadow: { frames: 1, w: 16, h: 16 }, // soft contact shadow under walls

  // --- projectiles & fx ---
  bolt: { frames: 2, w: 6, h: 3 }, // robot shot, warm tracer
  paper: { frames: 3, w: 6, h: 6 }, // tumbling crumpled paper
  fx_spark: { frames: 4, w: 8, h: 8 },
  fx_smoke: { frames: 4, w: 10, h: 10 },
  fx_muzzle: { frames: 2, w: 8, h: 8 },
  fx_boom: { frames: 5, w: 20, h: 20 }, // enemy death pop (smoke+parts, not fire)
  /**
   * The explosion ladder. One 20px pop cannot carry a boss fight, and three
   * tiers only work if they are unmistakably different SIZES — so `fx_boom`
   * stays exactly as it is for add deaths and these sit above it.
   *
   * Still no fire, and now for a reason rather than a rule: the boss is a paper
   * shredder, so its detonations are shredded document and toner — grey-white
   * and black. Orange would also put a second saturated thing on screen in
   * precisely the frames where the robot has to stay the eye's anchor.
   */
  fx_burst: { frames: 6, w: 36, h: 36 }, // rocket impact / mortar detonation
  fx_blast: { frames: 8, w: 72, h: 72 }, // boss death only
  fx_shock: { frames: 4, w: 64, h: 16 }, // ground shockwave ring, flattened to the projection

  // --- glyphs (OSD module strip; amber allowed here as they're UI-adjacent) ---
  glyph_MAGNET: { frames: 1, w: 8, h: 8 },
  glyph_RAGE: { frames: 1, w: 8, h: 8 },
  glyph_SCARED: { frames: 1, w: 8, h: 8 },
  glyph_MEMORY: { frames: 1, w: 8, h: 8 },
  glyph_ZAP: { frames: 1, w: 8, h: 8 },
  glyph_TOUGH: { frames: 1, w: 8, h: 8 },
  /** Crate upgrades — same strip, same 8×8 grid as the chips. */
  glyph_EARS: { frames: 1, w: 8, h: 8 },
  glyph_BRAIN: { frames: 1, w: 8, h: 8 },
  glyph_ROCKET: { frames: 1, w: 8, h: 8 },
} as const satisfies Record<string, ArtEntry>;

export type ArtName = keyof typeof ART;
