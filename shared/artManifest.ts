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
  printer_innocent: { frames: 2, w: 16, h: 12 }, // peaceful blinking LED
  mop: { frames: 1, w: 8, h: 18 },

  // --- props / pickups ---
  scrap: { frames: 2, w: 8, h: 6 }, // glint frame
  crate: { frames: 2, w: 14, h: 12 }, // closed / open
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

  // --- glyphs (OSD module strip; amber allowed here as they're UI-adjacent) ---
  glyph_MAGNET: { frames: 1, w: 8, h: 8 },
  glyph_RAGE: { frames: 1, w: 8, h: 8 },
  glyph_SCARED: { frames: 1, w: 8, h: 8 },
  glyph_MEMORY: { frames: 1, w: 8, h: 8 },
  glyph_ZAP: { frames: 1, w: 8, h: 8 },
  glyph_TOUGH: { frames: 1, w: 8, h: 8 },
} as const satisfies Record<string, ArtEntry>;

export type ArtName = keyof typeof ART;
