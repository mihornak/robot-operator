/**
 * LAB DECOR — the room's furniture, drawn in the lab palette.
 *
 * Everything here is deliberately UNDERLIT. The scene's brightness arrives from
 * the lightmap pass, so a prop that already looks lit will blow out the moment
 * a lamp lands on it. Value ceiling is L.v9 / M.hi and nothing reaches it over
 * more than a few pixels.
 *
 * Projection matches the world: wall faces are visible on the south side, so we
 * see the TOP of a prop and a slice of its FRONT. Light comes from above and a
 * little in front — top plane lightest, front face mid, and the bottom row of a
 * standing object is always the darkest thing in it. That last rule is what
 * plants an object on the floor; skip it and everything floats.
 */

import type { Drawer, Px } from '../art/px';
import { E, L, M, S, W } from './palette';

/** Emissive constants are numbers (the lightmap wants them that way). */
const c = (n: number): string => '#' + n.toString(16).padStart(6, '0');

/**
 * Contact shadow. Alpha rather than a palette tone — it has to darken whatever
 * floor tile it happens to land on, including a puddle.
 */
const SH = 'rgba(6,10,18,0.50)';
const SH_SOFT = 'rgba(6,10,18,0.24)';

function contact(p: Px, x: number, y: number, w: number, h = 2): void {
  p.r(x, y, w, h, SH_SOFT);
  p.hl(x, y, w, SH); // hardest exactly where the object meets the floor
}

export interface DecorEntry {
  w: number;
  h: number;
  frames: number;
  /** Default [0.5, 0.5]; standing props anchor at their GROUND CONTACT point. */
  anchor?: readonly [number, number];
  draw: Drawer;
  /** Optional additive emissive mask: only the parts that glow, on transparent. */
  glow?: Drawer;
}

export const DECOR = {
  // ── structure / clutter ────────────────────────────────────────────────────

  desk: {
    w: 26,
    h: 20,
    frames: 1,
    anchor: [0.5, 0.9],
    draw: (p: Px) => {
      contact(p, 1, 17, 24, 3);
      // top slab — the only plane the ceiling hits square on
      p.r(1, 2, 24, 6, M.d3);
      p.hl(1, 2, 24, M.d4);
      p.scatter(2, 3, 22, 5, M.d2, 0.13, 17); // scuffs, mug rings, old tape
      p.hl(4, 4, 6, M.d4); // one patch somebody kept wiping clean
      p.hl(0, 8, 26, M.d4); // front lip: laminate edge, catches a hard line
      p.hl(0, 9, 26, M.d0); // and drops a hard shade under itself
      // kneehole kept dark so the desk reads HOLLOW, not as a solid block
      p.r(1, 10, 11, 6, L.v1);
      p.hl(1, 10, 11, L.v0);
      p.vl(1, 10, 6, M.d2); // left end panel, edge-on
      // drawer pedestal, right
      p.r(12, 10, 13, 7, M.d2);
      p.vl(12, 10, 7, M.d0); // seam against the kneehole
      p.hl(13, 10, 12, M.d3);
      p.hl(13, 13, 12, M.d0); // drawer split
      p.hl(13, 14, 12, M.d3);
      p.r(16, 11, 5, 1, M.d4); // pulls
      p.r(16, 15, 5, 1, M.d4);
      p.scatter(13, 11, 12, 6, M.d1, 0.07, 29);
      p.hl(1, 16, 24, M.d0); // darkest row = the floor line
      p.r(1, 16, 2, 2, M.d1); // feet
      p.r(22, 16, 2, 2, M.d1);
    },
  },

  desk_toppled: {
    w: 24,
    h: 18,
    frames: 1,
    anchor: [0.5, 0.94],
    draw: (p: Px) => {
      contact(p, 1, 15, 21, 3);
      // the top is a wall now, and we get its UNDERSIDE — raw board, flatter
      // and dirtier than the surface anyone ever saw
      p.r(3, 3, 13, 13, M.d2);
      p.hl(3, 3, 13, M.d3);
      p.scatter(4, 5, 11, 10, M.d1, 0.13, 23);
      p.hl(4, 15, 12, M.d0);
      // the laminate front lip, now standing on end — the single line that says
      // "this was a desk top" rather than "this is a panel"
      p.vl(2, 3, 13, M.d4);
      p.p(2, 2, M.d5);
      // pedestal on its side; the top drawer slid out under its own weight
      p.r(5, 5, 9, 4, M.d1);
      p.hl(5, 5, 9, M.d3);
      p.r(6, 10, 8, 3, M.d3);
      p.hl(6, 10, 8, M.d4);
      p.hl(7, 12, 6, M.d0);
      p.r(9, 11, 3, 1, M.d4);
      // legs in the air, and AIR AROUND THEM. A solid block on this end just
      // makes the desk longer; the see-through frame is what topples it.
      p.hl(16, 4, 7, M.d4);
      p.hl(16, 5, 7, M.d2);
      p.hl(16, 13, 7, M.d4);
      p.hl(16, 14, 7, M.d2);
      p.vl(21, 5, 9, M.d2); // crossbar
      p.vl(22, 5, 9, M.d0);
      p.p(22, 4, M.d3);
      p.p(22, 13, M.d3);
      // paper that came out of the drawer on the way down
      p.hl(1, 16, 4, S.paper);
      p.p(0, 17, S.paperSh);
      p.hl(6, 17, 4, S.paperSh);
    },
  },

  chair_wreck: {
    w: 14,
    h: 14,
    frames: 1,
    anchor: [0.5, 0.93],
    draw: (p: Px) => {
      contact(p, 1, 11, 11, 3);
      // Backrest, knocked back off its stop. The stepped left edge IS the tilt —
      // it is the only rotation a sprite this size can express.
      p.r(1, 0, 7, 2, S.fabricHi);
      p.r(2, 2, 7, 2, S.fabricHi);
      p.hl(1, 0, 7, M.d4);
      p.hl(2, 3, 7, S.fabric);
      p.scatter(2, 1, 5, 2, L.v2, 0.18, 43); // worn through in patches
      p.p(9, 4, M.d4); // the strut down to the seat, bent
      p.p(9, 5, M.d3);
      // Seat: the biggest plane in the sprite, because we are looking DOWN at
      // it. Upholstery runs on fabricHi — S.fabric sits so close to the floor
      // tone that the masses stop existing and the chair becomes loose struts.
      p.r(1, 6, 11, 3, S.fabricHi);
      p.hl(1, 6, 11, M.d4);
      p.hl(2, 8, 10, S.fabric);
      p.hl(1, 9, 11, L.v0);
      p.p(10, 6, L.v2); // foam torn out of the corner
      p.p(11, 6, L.v2);
      p.scatter(2, 6, 8, 2, L.v2, 0.14, 44);
      // gas column, snapped short
      p.vl(6, 9, 2, M.d4);
      p.vl(7, 9, 2, M.d2);
      // Base spokes at three different lengths. A symmetrical star reads as a
      // table; a wreck has to look like it landed wrong.
      p.hl(2, 11, 9, M.d3);
      p.p(1, 12, M.d3);
      p.p(11, 12, M.d3);
      p.r(1, 12, 2, 2, M.d2); // castors still on
      p.r(10, 12, 2, 2, M.d2);
      p.p(2, 13, M.d0);
      p.p(11, 13, M.d0);
      p.p(12, 11, M.d0); // bare stub where the fourth tore out
      // and the castor itself, come to rest clear of the wreck
      p.r(12, 12, 2, 2, M.d3);
      p.p(12, 12, M.d5);
      p.hl(12, 13, 2, M.d0);
    },
  },

  filing_cabinet: {
    w: 14,
    h: 22,
    frames: 1,
    anchor: [0.5, 0.91],
    draw: (p: Px) => {
      contact(p, 1, 19, 12, 3);
      p.r(1, 1, 12, 2, M.d3); // top plate
      p.hl(1, 1, 12, M.d4);
      p.r(1, 3, 12, 16, M.d2);
      p.vl(1, 3, 16, M.d3);
      p.vl(12, 3, 16, M.d0);
      // top drawer, shut
      p.hl(2, 4, 10, M.d3);
      p.hl(2, 8, 10, M.d0);
      p.r(5, 6, 4, 1, M.d4);
      // middle drawer hanging open: its face juts a pixel proud of the shell on
      // both sides, which is the whole read at 1x
      p.r(0, 9, 14, 5, M.d3);
      p.hl(0, 9, 14, M.d4);
      p.r(1, 10, 12, 3, L.v0); // the cavity behind it
      p.hl(2, 10, 8, S.paper); // folder tabs, standing proud
      p.hl(3, 11, 5, S.paperSh);
      p.p(9, 11, S.paperSh);
      p.hl(0, 14, 14, L.v0); // shadow the open drawer throws downward
      // bottom drawer
      p.hl(2, 15, 10, M.d2);
      p.r(5, 17, 4, 1, M.d3);
      // rust weeping down from the drawer seams — gravity, not noise
      p.scatter(2, 15, 10, 4, W.rust, 0.07, 41);
      p.vl(11, 15, 3, W.rustSh);
      p.hl(1, 18, 12, M.d0); // floor line
    },
  },

  shelf_unit: {
    w: 30,
    h: 24,
    frames: 1,
    anchor: [0.5, 0.94],
    draw: (p: Px) => {
      contact(p, 0, 21, 30, 3);
      // Back panel first. An EMPTY bay has to show something dark behind it —
      // that hole is the whole reason the loaded bays read as loaded.
      p.r(2, 1, 26, 20, L.v1);
      p.scatter(2, 1, 26, 20, L.v0, 0.12, 71);
      // one cross-brace behind everything: the detail that says rack, not shelf
      for (let i = 0; i < 17; i++) p.p(9 + i, 19 - i, L.v2);
      // uprights: slotted angle, so each one is two values wide
      p.vl(0, 0, 22, M.d1);
      p.vl(1, 0, 22, M.d3);
      p.vl(28, 0, 22, M.d2);
      p.vl(29, 0, 22, M.d0);
      for (let y = 3; y < 21; y += 4) {
        p.p(1, y, M.d0); // the slot punchings
        p.p(28, y, M.d0);
      }
      // Decks step DOWN in value as they descend — less light reaches each one,
      // and four identical full-width M.d4 lips is precisely what turned this
      // prop into a row of teeth at 1x.
      const lip = [M.d3, M.d2, M.d2, M.d1];
      [1, 9, 16, 21].forEach((y, i) => {
        p.hl(1, y, 28, lip[i]);
        p.hl(1, y + 1, 28, M.d0);
      });
      // TOP BAY: one big carton, left. Its lid is the only cardboardHi in the
      // prop — repeat that highlight on every object and they merge into a wall.
      p.r(3, 3, 11, 6, W.cardboard);
      p.hl(3, 3, 11, W.cardboardHi);
      p.vl(13, 3, 6, S.dirt);
      p.vl(8, 4, 5, W.cardboardHi); // tape seam
      p.hl(3, 8, 11, S.dirt);
      p.scatter(4, 5, 9, 3, S.dirt, 0.08, 63);
      // MIDDLE BAY: a steel case — wide, low, and a full hue away from cardboard
      p.r(3, 11, 13, 5, M.d2);
      p.hl(3, 11, 13, M.d3);
      p.hl(4, 15, 12, M.d0);
      p.r(7, 13, 5, 1, M.d0); // handle recess
      p.p(6, 13, M.d4); // latches — the only bright pixels on it
      p.p(12, 13, M.d4);
      // BOTTOM BAY: a dark crate, pushed right. Nothing on this rack lines up
      // with anything else; three left-aligned objects read as one column.
      p.r(17, 17, 10, 4, L.v3);
      p.hl(17, 17, 10, L.v4);
      p.vl(26, 17, 4, L.v1);
      p.hl(18, 20, 8, L.v0);
      p.p(21, 18, L.v1); // stencil ticks
      p.p(22, 18, L.v1);
      p.scatter(2, 17, 26, 4, M.d0, 0.08, 72);
      p.r(0, 21, 2, 3, M.d1); // feet
      p.r(28, 21, 2, 3, M.d1);
    },
  },

  boxes: {
    w: 18,
    h: 14,
    frames: 1,
    anchor: [0.5, 0.93],
    draw: (p: Px) => {
      contact(p, 0, 12, 17, 2);
      // Lower box: older, damper, and standing in the upper one's shade, so it
      // gets NO bright lid lip. Two cartons wearing the same highlight at the
      // same value stop being two objects.
      p.r(0, 6, 16, 7, W.cardboard);
      p.hl(0, 6, 16, W.cardboard);
      p.vl(15, 6, 7, S.dirt);
      p.vl(7, 7, 6, W.cardboard); // tape seam down the front
      p.hl(0, 9, 15, S.dirt); // flap line
      p.r(2, 10, 4, 1, S.paperSh); // shipping label
      p.scatter(0, 10, 15, 3, S.dirt, 0.12, 7); // damp wicked up from the floor
      p.hl(0, 12, 16, S.dirt);
      // upper box, offset — a square stack reads as one block, an offset one
      // reads as two objects. This is the one that owns the lid highlight.
      p.r(3, 0, 11, 6, W.cardboardHi);
      p.hl(3, 0, 11, W.cardboardHi);
      p.hl(3, 2, 11, W.cardboard);
      p.vl(13, 0, 6, S.dirt);
      p.vl(8, 1, 5, W.cardboardHi); // tape
      p.hl(3, 5, 11, S.dirt); // its own shade landing on the box below
      p.p(2, 3, W.cardboard); // a crushed corner, folded out
      p.p(2, 4, S.dirt);
    },
  },

  pallet: {
    w: 22,
    h: 10,
    frames: 1,
    draw: (p: Px) => {
      p.r(0, 0, 22, 8, S.dirt); // the dark between the boards
      for (const y of [0, 3, 6]) {
        p.hl(0, y, 22, W.cardboardHi); // deck board, lit top
        p.hl(0, y + 1, 22, W.cardboard);
      }
      // nail heads at the stringer lines — three columns, evenly spaced
      for (const x of [2, 10, 19]) {
        p.p(x, 0, M.d3);
        p.p(x, 3, M.d3);
        p.p(x, 6, M.d3);
      }
      // stringer front face along the near edge, then the floor line
      p.hl(0, 8, 22, W.cardboard);
      p.hl(0, 9, 22, S.dirt);
      p.r(6, 8, 3, 2, L.v1); // fork notches
      p.r(14, 8, 3, 2, L.v1);
      // one splintered corner, because every pallet has one
      p.p(21, 1, S.dirt);
      p.p(20, 2, S.dirt);
      p.p(21, 0, S.dirt);
      p.scatter(0, 0, 22, 8, S.dirt, 0.08, 19);
    },
  },

  barrel: {
    w: 12,
    h: 18,
    frames: 1,
    anchor: [0.5, 0.94],
    draw: (p: Px) => {
      contact(p, 0, 16, 12, 2);
      // lid, foreshortened into three rows — a full ellipse at this size just
      // reads as a lighter rectangle anyway
      p.hl(3, 0, 6, M.d5);
      p.hl(2, 1, 8, M.d4);
      p.hl(1, 2, 10, M.d3);
      p.p(7, 1, M.d1); // bung
      // body
      p.r(1, 3, 10, 13, M.d2);
      p.vl(1, 3, 13, M.d3); // lit flank
      p.vl(10, 3, 13, M.d0);
      // rolling ribs
      for (const y of [6, 12]) {
        p.hl(1, y, 10, M.d3);
        p.hl(1, y + 1, 10, M.d0);
      }
      // rust runs DOWNWARD from the rim and pools at the ribs
      p.vl(3, 3, 4, W.rust);
      p.vl(8, 7, 6, W.rustSh);
      p.p(3, 6, W.rustHi);
      p.p(8, 12, W.rustHi);
      p.scatter(2, 3, 8, 12, W.rust, 0.09, 91);
      p.scatter(2, 11, 8, 5, W.rustSh, 0.14, 92);
      p.hl(1, 16, 10, M.d0); // floor line
    },
  },

  rubble: {
    w: 20,
    h: 8,
    frames: 1,
    draw: (p: Px) => {
      p.r(1, 5, 18, 2, SH_SOFT);
      // concrete: angular, cool, hard top plane and a black right face
      p.r(2, 2, 5, 3, L.v4);
      p.hl(2, 2, 5, L.v6);
      p.vl(6, 2, 3, L.v1);
      p.r(8, 1, 4, 4, L.v5);
      p.hl(8, 1, 4, L.v7);
      p.vl(11, 1, 4, L.v1);
      p.r(4, 4, 4, 2, L.v3);
      p.hl(4, 4, 4, L.v5);
      // ceiling-tile shards: paler, flatter, snapped along straight lines
      p.r(12, 3, 6, 2, S.paperSh);
      p.hl(12, 3, 6, S.paper);
      p.p(18, 4, S.paperSh);
      p.r(0, 4, 3, 1, S.paperSh);
      // the dust that came down with it
      p.scatter(0, 1, 20, 6, L.v4, 0.1, 5);
      p.scatter(0, 5, 20, 3, S.dirt, 0.14, 6);
      p.hl(3, 7, 13, SH_SOFT);
    },
  },

  ceiling_tile: {
    w: 14,
    h: 10,
    frames: 1,
    draw: (p: Px) => {
      p.r(1, 8, 12, 2, SH_SOFT);
      p.r(0, 1, 14, 8, S.paperSh);
      p.r(0, 1, 14, 3, S.paper); // the half still turned toward the ceiling
      p.box(0, 1, 14, 8, L.v3); // the T-bar edge rebate
      p.scatter(1, 2, 12, 6, S.paper, 0.14, 13); // mineral-fibre speckle
      p.r(8, 5, 3, 2, S.dirt); // the water stain that pushed it out of the grid
      p.p(7, 6, S.dirt);
      p.p(11, 5, W.rustSh);
      p.hl(0, 8, 14, L.v1);
      p.hole(12, 2, 1); // corner snapped off on landing, along the grain
      p.hole(13, 1, 0);
      p.hole(13, 3, 0);
      p.p(11, 3, L.v2); // the fresh break, unfaced and lighter than the surface
      p.p(12, 4, L.v2);
    },
  },

  pipe_run: {
    w: 32,
    h: 8,
    frames: 1,
    draw: (p: Px) => {
      // a cylinder is four values and nothing else: rim, lit, body, shadow
      p.hl(0, 2, 32, M.d4);
      p.hl(0, 3, 32, M.d3);
      p.hl(0, 4, 32, M.d2);
      p.hl(0, 5, 32, M.d0);
      // brackets straddling the run
      for (const x of [4, 15, 26]) {
        p.vl(x, 1, 6, M.d3);
        p.vl(x + 1, 1, 6, M.d1);
        p.p(x, 1, M.d5);
        p.p(x, 6, M.d0);
      }
      // flanged joint — two collars, so the run reads as jointed pipe not a bar
      p.vl(20, 1, 6, M.d4);
      p.vl(21, 1, 6, M.d2);
      p.p(20, 1, M.d5);
      // it sweats at the bracket, and the stain runs down the wall below
      p.scatter(14, 2, 6, 4, W.rust, 0.24, 77);
      p.p(16, 6, W.rustSh);
      p.p(16, 7, W.rustSh);
      p.p(17, 7, W.rustSh);
      p.scatter(0, 3, 32, 3, M.d1, 0.06, 78);
    },
  },

  crate_stack: {
    w: 20,
    h: 22,
    frames: 1,
    anchor: [0.5, 0.93],
    draw: (p: Px) => {
      contact(p, 1, 19, 18, 3);
      // Lower crate sits in the upper one's shadow, so it runs a full step
      // darker. Two crates at the same value with the same bright rim is the
      // shelf_unit teeth problem in miniature.
      p.r(1, 11, 18, 8, L.v3);
      p.hl(1, 11, 18, L.v5); // rim
      p.vl(1, 11, 8, L.v4);
      p.vl(18, 11, 8, L.v1);
      // Moulded lattice as 2px slots, not a 1px checker: a single-pixel dither
      // at 480×270 shimmers, and slots are what the mould actually leaves.
      for (let x = 3; x < 17; x += 3) p.r(x, 13, 2, 4, L.v2);
      p.r(8, 14, 4, 1, L.v0); // handle cutout
      p.hl(1, 18, 18, L.v0); // floor line
      // upper crate turned 90° — a stack of identical boxes reads as one prism
      p.r(2, 2, 16, 8, L.v5);
      p.hl(2, 2, 16, L.v7);
      p.vl(2, 2, 8, L.v6);
      p.vl(17, 2, 8, L.v2);
      for (let x = 4; x < 16; x += 3) p.r(x, 4, 2, 4, L.v3);
      p.r(8, 5, 4, 1, L.v0);
      p.hl(2, 9, 16, L.v1);
      p.hl(2, 10, 16, L.v0); // its shadow on the crate below
      p.p(2, 2, L.v3); // one corner is cracked and has lost its rim
      p.p(3, 2, L.v3);
      p.scatter(2, 12, 16, 6, L.v2, 0.07, 33);
    },
  },

  plant_dead: {
    w: 12,
    h: 20,
    frames: 1,
    anchor: [0.5, 0.95],
    draw: (p: Px) => {
      contact(p, 1, 18, 10, 2);
      // pot — terracotta is the one place warm material belongs indoors
      p.hl(2, 10, 8, W.rustHi); // rim, catching the ceiling
      p.hl(3, 11, 6, S.dirt); // soil, cracked and dry
      p.scatter(3, 11, 6, 1, L.v1, 0.35, 51);
      p.r(2, 12, 8, 6, W.rust);
      p.vl(2, 12, 6, W.rustHi);
      p.vl(9, 12, 6, W.rustSh);
      p.hl(3, 17, 6, W.rustSh);
      p.hl(3, 18, 6, L.v0); // floor line
      // stems. Nothing in a dead plant travels upward for long — every line
      // turns over and falls, and that arc is the whole silhouette.
      p.vl(6, 8, 3, S.plantSh);
      p.p(6, 7, S.plant);
      p.p(5, 6, S.plant);
      p.p(4, 5, S.plantSh);
      p.p(3, 6, S.plantSh);
      p.p(2, 7, S.plantSh);
      p.p(1, 9, S.plantSh); // this frond hangs past the rim
      p.p(7, 6, S.plant);
      p.p(8, 5, S.plantHi);
      p.p(9, 6, S.plantSh);
      p.p(10, 8, S.plantSh);
      p.p(10, 9, S.plantSh);
      p.p(6, 4, S.plantSh); // the last upright shoot, already browning
      p.p(6, 3, W.rustSh);
      // shed leaves on the floor
      p.p(0, 18, S.plantSh);
      p.p(11, 19, S.plantSh);
      p.p(2, 19, W.rustSh);
    },
  },

  puddle: {
    w: 28,
    h: 12,
    frames: 1,
    draw: (p: Px) => {
      // Built from stacked spans rather than a disc: a puddle that is an ellipse
      // reads as a shadow. The reflection pass draws on top of this, so the body
      // stays low-alpha dark — it must darken the floor, not replace it.
      const wet = 'rgba(9,15,26,0.55)';
      const deep = 'rgba(5,9,18,0.72)';
      p.hl(7, 0, 13, wet);
      p.hl(4, 1, 19, wet);
      p.hl(2, 2, 23, deep);
      p.hl(0, 3, 27, deep);
      p.hl(0, 4, 28, deep);
      p.hl(0, 5, 27, deep);
      p.hl(1, 6, 26, deep);
      p.hl(2, 7, 24, wet);
      p.hl(4, 8, 20, wet);
      p.hl(7, 9, 14, wet);
      p.hl(11, 10, 7, wet);
      // meniscus: only the far rim faces the ceiling, so only it lights up
      p.hl(9, 0, 5, L.v4);
      p.p(6, 1, L.v3);
      p.p(20, 1, L.v3);
      p.p(2, 3, L.v3);
      p.p(25, 4, L.v3);
      p.p(9, 9, L.v2);
      p.p(19, 9, L.v2);
      p.hole(16, 5, 1); // a dry island where the floor is proud
      p.scatter(3, 2, 22, 6, 'rgba(20,32,50,0.5)', 0.05, 87); // silt
    },
  },

  cable_coil: {
    w: 16,
    h: 8,
    frames: 1,
    draw: (p: Px) => {
      p.r(2, 6, 12, 2, SH_SOFT);
      // Big loop, punched hollow. A filled disc reads as a lid, and rubber this
      // close to the floor tone vanishes — so the coil runs a full three values
      // top to bottom even though it is barely three pixels thick.
      p.disc(5, 4, 3, M.d2);
      p.hole(5, 4, 1);
      p.hl(3, 1, 5, M.d4);
      p.p(2, 3, M.d3);
      p.hl(3, 7, 5, M.d0);
      // smaller loop resting against it
      p.disc(11, 4, 2, M.d2);
      p.hole(11, 4, 0);
      p.hl(10, 2, 3, M.d4);
      p.hl(10, 6, 3, M.d0);
      // tail running out to the right, insulation stripped off the end
      p.p(14, 5, M.d2);
      p.p(15, 5, M.d1);
      p.p(15, 4, W.copper);
      p.p(0, 4, M.d2); // and a short stub the other way
      p.p(1, 3, M.d3);
    },
  },

  paper_scatter: {
    w: 20,
    h: 10,
    frames: 1,
    draw: (p: Px) => {
      // Each sheet is a lit face plus one dark near-edge. Without that edge a
      // pile of paper is a white blob; with it you can count the sheets.
      p.r(0, 2, 8, 4, S.paperSh);
      p.hl(0, 2, 8, S.paper);
      p.hl(0, 5, 8, L.v2);
      p.r(5, 5, 9, 3, S.paper);
      p.hl(5, 5, 9, S.paper);
      p.hl(5, 7, 9, L.v2);
      p.r(12, 1, 7, 4, S.paperSh);
      p.hl(12, 1, 7, S.paper);
      p.hl(12, 4, 7, L.v2);
      p.r(15, 6, 5, 2, S.paperSh);
      p.hl(15, 8, 5, L.v2);
      // print: one pixel a line, enough to read as documents at 1x
      p.hl(1, 3, 5, S.paperSh);
      p.hl(1, 4, 3, S.paperSh);
      p.hl(7, 6, 6, S.paperSh);
      p.hl(13, 2, 4, S.paperSh);
      p.hl(13, 3, 5, S.paperSh);
      // one corner curled up off the floor, catching a hard highlight
      p.p(19, 1, S.paper);
      p.p(19, 0, S.paperSh);
      p.scatter(0, 2, 20, 7, S.dirt, 0.05, 101); // bootprints
    },
  },

  // ── emissive ───────────────────────────────────────────────────────────────

  ceiling_lamp: {
    w: 20,
    h: 10,
    frames: 1,
    draw: (p: Px) => {
      // seen from just below: a sliver of the channel top, then the reflector
      p.r(2, 0, 16, 2, M.d1);
      p.hl(2, 0, 16, M.d2);
      p.r(0, 2, 20, 3, M.d2); // reflector flare
      p.hl(0, 2, 20, M.d3);
      p.hl(0, 4, 20, M.d0); // its underside, the darkest part of the fixture
      p.r(0, 1, 2, 5, M.d3); // end caps
      p.r(18, 1, 2, 5, M.d3);
      p.p(0, 1, M.d4);
      p.p(19, 1, M.d4);
      // the tube itself. Even lit, a tube has a body — it gets a hard rim or it
      // dissolves into its own glow.
      p.r(2, 6, 16, 2, M.d4);
      p.hl(2, 6, 16, M.hi);
      p.hl(2, 8, 16, M.d1);
      // one end blackened: this is why the room flickers
      p.r(14, 6, 4, 2, M.d2);
      p.p(17, 6, M.d1);
      p.p(16, 7, M.d0);
      p.scatter(0, 2, 20, 3, M.d0, 0.1, 55); // dust on top of the reflector
    },
    glow: (p: Px) => {
      p.hl(2, 6, 12, c(E.keyCore));
      p.hl(2, 7, 12, c(E.key));
      p.hl(13, 6, 3, c(E.key)); // the dying end still limps along
      // Falloff in ALPHA, not in a checker. A 50% dither of a full-brightness
      // emissive is a row of individually-blooming pixels, and at 480×270 that
      // reads as teeth — the fixture ends up looking like it bites.
      p.hl(1, 5, 18, 'rgba(255,183,116,0.30)');
      p.hl(1, 8, 18, 'rgba(255,183,116,0.45)');
      p.hl(2, 9, 16, 'rgba(255,183,116,0.20)');
    },
  },

  wall_lamp: {
    w: 10,
    h: 14,
    frames: 1,
    draw: (p: Px) => {
      p.r(4, 0, 2, 3, M.d2); // stem out of the wall
      p.r(2, 2, 6, 2, M.d3);
      p.hl(2, 2, 6, M.d4);
      p.r(1, 4, 8, 2, M.d2); // hood
      p.hl(1, 4, 8, M.d3);
      p.hl(1, 5, 8, M.d0);
      p.disc(4, 8, 2, M.d5); // bulb
      p.p(4, 7, M.hi);
      // cage: bars first, then the two hoops over them, so the hoops read on top
      p.vl(1, 6, 6, M.d3);
      p.vl(4, 6, 6, M.d1);
      p.vl(7, 6, 6, M.d3);
      p.hl(1, 6, 7, M.d4);
      p.hl(1, 11, 7, M.d1);
      p.hl(2, 9, 5, M.d3);
      p.r(3, 12, 4, 1, M.d0); // bottom cap, darkest
      p.p(0, 5, M.d1);
      p.p(9, 5, M.d1);
    },
    glow: (p: Px) => {
      p.disc(4, 8, 2, c(E.key));
      p.p(4, 8, c(E.keyCore));
      p.p(4, 7, c(E.keyCore));
      p.r(2, 6, 5, 6, 'rgba(255,183,116,0.34)'); // bleed inside the cage
      p.p(0, 8, 'rgba(255,183,116,0.55)'); // what gets past it, out the open sides
      p.p(9, 8, 'rgba(255,183,116,0.55)');
      p.hl(3, 12, 4, 'rgba(255,183,116,0.5)'); // and the pool it throws down the wall
      // The bars are IN FRONT of the bulb, so punch them back out of the glow.
      // Skip this and the cage disappears the instant the lamp is lit.
      for (const x of [1, 4, 7]) for (let y = 6; y < 12; y++) p.hole(x, y, 0);
    },
  },

  server_rack: {
    w: 20,
    h: 28,
    frames: 4,
    anchor: [0.5, 0.96],
    draw: (p: Px, frame: number) => {
      contact(p, 1, 25, 18, 3);
      p.r(1, 1, 18, 24, M.d1);
      p.hl(1, 1, 18, M.d3); // top plate
      p.hl(1, 2, 18, M.d2);
      p.vl(1, 2, 23, M.d2);
      p.vl(18, 2, 23, M.d0);
      // mesh door: a 50% checker over a black recess is the only thing that
      // reads as perforated steel at this size
      p.r(3, 4, 14, 19, L.v0);
      p.checker(3, 4, 14, 19, M.d2, 0);
      p.box(2, 3, 16, 21, M.d3);
      p.vl(16, 11, 5, M.d4); // handle
      for (let y = 6; y < 23; y += 4) p.hl(4, y, 12, M.d0); // blade seams behind
      // LED column. The opaque pass only shows them as dim pips — the glow mask
      // does the actual work, so the rack still reads with the lightmap off.
      const pat = [0b101101, 0b011011, 0b110110, 0b010101][frame & 3];
      for (let i = 0; i < 6; i++) {
        p.p(15, 6 + i * 3, (pat >> i) & 1 ? M.d5 : M.d1);
      }
      p.hl(1, 24, 18, M.d0); // floor line
      p.r(1, 24, 2, 2, M.d1);
      p.r(17, 24, 2, 2, M.d1);
    },
    glow: (p: Px, frame: number) => {
      const pat = [0b101101, 0b011011, 0b110110, 0b010101][frame & 3];
      for (let i = 0; i < 6; i++) {
        if (!((pat >> i) & 1)) continue;
        const y = 6 + i * 3;
        p.p(15, y, c(E.accentCore));
        p.p(14, y, c(E.accent));
        p.p(16, y, c(E.accent));
      }
      // The blades behind the mesh bleed, the mesh itself does not. Strength
      // lives in ALPHA and alternates per frame, so the cabinet breathes
      // without any pixel ever reaching full emissive and blooming.
      for (let y = 6; y < 23; y += 4) {
        p.hl(4, y, 12, frame & 1 ? 'rgba(79,143,214,0.34)' : 'rgba(79,143,214,0.18)');
      }
      p.r(3, 4, 14, 19, 'rgba(29,90,122,0.30)'); // the cabinet's general leak
    },
  },

  /**
   * The old 16×16 gave the glass ten of its fourteen usable columns, so once
   * lit there was nothing left of the machine — three of these around the room
   * read as blue bars, indistinguishable from floor_strip and from the rack's
   * LED column. The fix is proportion, not detail: at 18×18 the HOUSING is the
   * silhouette and the screen is a small inset inside it, so what glows is a
   * screen in a box rather than a box-sized screen.
   */
  terminal: {
    w: 18,
    h: 18,
    frames: 2,
    anchor: [0.5, 0.94],
    draw: (p: Px, frame: number) => {
      contact(p, 3, 15, 12, 3);
      // Top face, as a trapezoid narrowing toward the back. We look DOWN at
      // this the same as everything else in the room, and the taper is what
      // makes it a deep CRT instead of a flat panel.
      p.hl(4, 0, 10, M.d2);
      p.hl(3, 1, 12, M.d4);
      p.hl(2, 2, 14, M.d3);
      p.r(1, 3, 16, 10, M.d2); // front face
      p.vl(1, 3, 10, M.d3); // lit flank
      p.vl(16, 3, 10, M.d0);
      p.hl(1, 12, 16, M.d0); // under-edge of the housing
      p.hl(2, 3, 14, M.d3); // brow above the bezel
      // bezel recess, then the glass inset well inside it
      p.r(4, 4, 10, 7, M.d1);
      p.r(5, 5, 8, 5, L.v0);
      p.p(5, 5, L.v1); // the tube is curved: it loses the image at the corners
      p.p(12, 5, L.v1);
      p.p(5, 9, L.v1);
      p.p(12, 9, L.v1);
      // content in the opaque pass too, or the terminal is a dead box whenever
      // the lightmap is off
      p.hl(6, 6 + frame, 4, M.d3);
      p.hl(6, 8 - frame, 6, M.d2);
      // control strip under the bezel: the detail that says "machine"
      p.r(4, 11, 2, 1, M.d3);
      p.p(8, 11, M.d4); // power lamp housing
      for (let x = 11; x < 15; x += 2) p.p(x, 11, M.d1); // vent slots
      p.scatter(2, 3, 14, 1, M.d0, 0.2, 66); // dust on the brow
      // stand: neck, then a splayed foot that plants it
      p.r(8, 13, 3, 2, M.d1);
      p.vl(8, 13, 2, M.d2);
      p.hl(5, 15, 9, M.d3);
      p.hl(4, 16, 11, M.d1);
      p.hl(4, 17, 11, M.d0); // darkest row
    },
    glow: (p: Px, frame: number) => {
      // Small and BRIGHT, not large and dim — that difference is the whole gap
      // between reading as a lit screen and reading as a lit panel.
      p.r(5, 5, 8, 5, c(E.screenDim));
      for (let y = 5 + (frame & 1); y < 10; y += 2) p.hl(5, y, 8, c(E.screen));
      p.hl(6, 6 + frame, 4, c(E.fillCore)); // the cursor line, white-hot
      // the curved corners stay unlit, same as the opaque pass
      p.hole(5, 5, 0);
      p.hole(12, 5, 0);
      p.hole(5, 9, 0);
      p.hole(12, 9, 0);
      // bezel bleed: two tight alpha rings. Any wider and the housing starts
      // glowing too, which is what made the old one a bar.
      p.box(4, 4, 10, 7, 'rgba(100,200,255,0.30)');
      p.box(3, 3, 12, 9, 'rgba(100,200,255,0.14)');
    },
  },

  vending: {
    w: 18,
    h: 26,
    frames: 1,
    anchor: [0.5, 0.96],
    draw: (p: Px) => {
      contact(p, 1, 23, 16, 3);
      p.r(1, 1, 16, 22, M.d1);
      p.hl(1, 1, 16, M.d3);
      p.vl(1, 1, 22, M.d2);
      p.vl(16, 1, 22, M.d0);
      // lit window
      p.r(3, 3, 9, 14, L.v2);
      p.box(2, 2, 11, 16, M.d3);
      // spirals with product on them; two lanes already cleared out
      for (let i = 0; i < 4; i++) {
        const y = 4 + i * 3;
        p.hl(4, y + 2, 7, M.d2); // the spiral, edge-on
        if (i === 1) continue; // sold out
        p.r(4, y, 2, 2, i === 3 ? W.hazard : W.cardboard);
        p.r(7, y, 2, 2, i === 0 ? S.plant : W.rust);
        if (i !== 2) p.r(10, y, 2, 2, W.cardboard);
      }
      // keypad + coin mech, right column
      p.r(13, 3, 3, 6, M.d2);
      p.hl(13, 3, 3, M.d3);
      for (let y = 4; y < 9; y += 2) {
        p.p(13, y, M.d4);
        p.p(15, y, M.d4);
      }
      p.r(13, 10, 3, 1, L.v0); // coin slot
      p.r(13, 13, 3, 3, M.d2); // return cup
      p.hl(13, 15, 3, L.v0);
      // delivery flap, and the floor line under it
      p.r(3, 18, 11, 4, L.v0);
      p.hl(3, 18, 11, M.d2);
      p.hl(4, 21, 9, M.d1);
      p.hl(1, 22, 16, M.d0);
      p.scatter(2, 18, 14, 4, M.d0, 0.1, 88);
    },
    glow: (p: Px) => {
      // The tube is at the TOP of the cabinet, so the panel falls off downward
      // in alpha steps. Full-strength fill all the way down drowns the product
      // lanes, which are the only thing saying "vending" rather than "locker".
      p.hl(3, 3, 9, c(E.fillCore));
      p.r(3, 4, 9, 3, c(E.fill));
      p.r(3, 7, 9, 4, 'rgba(79,143,214,0.55)');
      p.r(3, 11, 9, 3, 'rgba(79,143,214,0.34)');
      p.r(3, 14, 9, 3, 'rgba(79,143,214,0.20)');
      p.p(13, 10, c(E.accent)); // coin slot pip
    },
  },

  exit_sign: {
    w: 14,
    h: 8,
    frames: 1,
    draw: (p: Px) => {
      p.r(0, 0, 14, 2, M.d2); // housing top
      p.hl(0, 0, 14, M.d3);
      p.r(0, 2, 14, 5, L.v1); // the face, dark until the glow pass
      p.hl(0, 7, 14, M.d0);
      p.p(0, 2, M.d1);
      p.p(13, 2, M.d1);
      // EXIT, 3px tall — the only lettering anywhere in the lab, so it has to
      // survive at 1x without antialiasing to lean on
      p.bmp(
        0,
        3,
        ['### #.# # ###', '##.  #  #  # ', '### #.# # .# '],
        { '#': M.d4 },
      );
      p.p(6, 1, M.d1); // stem up to the ceiling
      p.p(7, 1, M.d1);
    },
    glow: (p: Px) => {
      // Wash and halo FIRST, letters last. The other order buries the lettering
      // under its own backlight and the sign becomes a red brick. The wash is
      // alpha, not a sparse spray — scattered full-strength emissive pixels
      // bloom individually and the face grows teeth.
      p.r(0, 2, 14, 5, 'rgba(255,91,60,0.30)');
      p.hl(0, 7, 14, 'rgba(255,91,60,0.25)');
      p.bmp(
        0,
        3,
        ['### #.# # ###', '##.  #  #  # ', '### #.# # .# '],
        { '#': c(E.hazardCore) },
      );
    },
  },

  alarm_strobe: {
    w: 8,
    h: 10,
    frames: 4,
    draw: (p: Px, frame: number) => {
      p.r(3, 8, 2, 2, M.d2); // bracket
      p.hl(3, 9, 2, M.d0);
      p.r(1, 6, 6, 2, M.d3); // base plate
      p.hl(1, 6, 6, M.d4);
      p.hl(1, 7, 6, M.d0);
      p.disc(3, 4, 3, W.rust); // dome
      p.hl(2, 1, 3, W.rustHi); // its top always takes the ceiling light
      p.vl(3, 1, 6, W.rustSh); // cage rib over the glass
      p.vl(1, 3, 3, W.rustSh);
      // the lamp inside rotates, so the hot side of the glass walks around
      const hx = [1, 3, 5, 3][frame & 3];
      const hy = [4, 2, 4, 6][frame & 3];
      p.p(hx, hy, W.rustHi);
      p.p(6, 3, W.rustSh);
    },
    glow: (p: Px, frame: number) => {
      // one dead beat in four. A beacon that never goes out is a lamp.
      const lvl = [3, 2, 0, 1][frame & 3];
      if (lvl === 0) return;
      const hx = [1, 3, 5, 3][frame & 3];
      const hy = [4, 2, 4, 6][frame & 3];
      p.disc(3, 4, 2, c(E.hazard));
      p.p(hx, hy, c(E.hazardCore));
      if (lvl >= 2) {
        p.disc(3, 4, 3, c(E.hazard));
        p.p(3, 4, c(E.hazardCore));
      }
      if (lvl === 3) {
        // The flash throws past the dome, as two alpha shells. A sparse spray
        // of full-strength emissive blooms pixel by pixel and the beacon ends
        // up spiky instead of bright.
        p.disc(3, 4, 3, 'rgba(255,91,60,0.45)');
        p.r(0, 1, 8, 7, 'rgba(255,91,60,0.22)');
        p.p(0, 4, 'rgba(255,91,60,0.5)'); // and the wedge out the open sides
        p.p(7, 4, 'rgba(255,91,60,0.5)');
      }
    },
  },

  floor_strip: {
    w: 24,
    h: 4,
    frames: 2,
    draw: (p: Px) => {
      p.r(0, 0, 24, 4, L.v2); // recess
      p.hl(0, 0, 24, L.v3); // far lip faces the ceiling
      p.hl(0, 3, 24, L.v0); // near lip is in its own shadow
      p.r(1, 1, 22, 2, L.v1);
      for (let x = 1; x < 23; x += 4) {
        p.r(x, 1, 3, 2, M.d3); // lens modules, dashed
        if (x + 3 < 23) p.p(x + 3, 1, L.v0); // the gap between them
      }
      p.scatter(1, 1, 22, 2, M.d1, 0.08, 99); // grit in the channel
    },
    glow: (p: Px, frame: number) => {
      // alternating modules chase, so the strip points somewhere
      for (let x = 1, i = 0; x < 23; x += 4, i++) {
        if ((i + frame) & 1) {
          p.r(x, 1, 3, 2, c(E.accent));
          p.hl(x, 1, 3, c(E.accentCore));
        } else {
          p.r(x, 1, 3, 2, c(E.screenDim));
        }
      }
    },
  },

  sparks_box: {
    w: 12,
    h: 14,
    frames: 4,
    draw: (p: Px) => {
      p.r(4, 0, 3, 2, M.d2); // conduit coming down into it
      p.vl(4, 0, 2, M.d3);
      p.r(1, 2, 9, 10, M.d2); // box body
      p.hl(1, 2, 9, M.d3);
      p.vl(1, 2, 10, M.d3);
      p.vl(9, 2, 10, M.d0);
      p.hl(1, 11, 9, M.d0);
      // lid torn off its hinge and hanging open to the right
      p.r(10, 3, 2, 7, M.d3);
      p.hl(10, 3, 2, M.d4);
      p.p(11, 10, M.d0);
      p.p(10, 2, M.d1);
      // interior: scorched cavity with the conductors bared across it
      p.r(2, 4, 7, 6, L.v0);
      p.scatter(2, 4, 7, 6, M.d0, 0.3, 61);
      p.p(3, 5, W.copper); // terminal screws
      p.p(7, 5, W.copper);
      p.vl(3, 6, 3, M.d1);
      p.vl(7, 6, 2, M.d1);
      p.p(3, 9, W.copperHi); // the two strands the arc jumps between
      p.p(7, 8, W.copperHi);
      // soot fanning up the wall — the box has been doing this for a while
      p.scatter(1, 0, 10, 3, L.v0, 0.28, 62);
      p.scatter(2, 12, 7, 2, L.v0, 0.2, 63);
    },
    glow: (p: Px, frame: number) => {
      if (frame === 2) return; // the dark beat between strikes
      p.p(5, 7, c(E.fillCore)); // the arc root, always in the same gap
      p.p(4, 8, c(E.fill));
      p.p(6, 6, c(E.fill));
      if (frame === 1) {
        // the big strike: it lights the whole cavity and throws clear of the box
        p.r(3, 5, 5, 4, c(E.fill));
        p.p(5, 6, c(E.fillCore));
        p.p(4, 7, c(E.fillCore));
        p.p(3, 9, c(E.fillCore));
        p.p(7, 8, c(E.fillCore));
        p.r(2, 4, 7, 6, 'rgba(79,143,214,0.5)'); // the cavity lights, not the box
        p.p(1, 11, c(E.fill)); // sparks already falling out of the box
        p.p(8, 12, c(E.fill));
        p.p(10, 6, c(E.fill));
      } else if (frame === 3) {
        p.p(5, 6, c(E.fill)); // afterglow: the copper stays hot
        p.p(3, 9, c(E.fill));
        p.p(2, 12, c(E.fill));
      }
    },
  },

  // ── the dim end of the room ────────────────────────────────────────────────

  pipe_bank: {
    w: 28,
    h: 26,
    frames: 1,
    anchor: [0.5, 0.96],
    draw: (p: Px) => {
      contact(p, 1, 23, 26, 3);
      // Five bores, not five copies. A bundle of identical pipes reads as a
      // fence; the varied widths are what make it read as plumbing.
      const bores: readonly (readonly [number, number])[] = [
        [1, 5],
        [7, 4],
        [12, 6],
        [19, 4],
        [24, 4],
      ];
      for (const [x, w] of bores) {
        // a vertical cylinder is four columns: dark edge, specular strip left
        // of centre, body, dark edge. Nothing else is needed at this width.
        p.r(x, 0, w, 24, M.d2);
        p.vl(x, 0, 24, M.d0);
        p.vl(x + 1, 0, 24, M.d4);
        p.vl(x + w - 1, 0, 24, M.d0);
        p.hl(x, 23, w, M.d0); // where it goes into the floor
      }
      // TWO straps, not three, and neither at the very top: every horizontal
      // bar spent across this sprite is a rung, and enough rungs turn a pipe
      // bundle into a ladder. Kept at M.d2 with only the bolt heads bright.
      for (const y of [6, 17]) {
        p.hl(0, y, 28, M.d2);
        p.hl(0, y + 1, 28, M.d0);
        for (const [x] of bores) p.p(x + 1, y, M.d3);
      }
      // the fat pipe carries a flanged valve — one point of interest stops the
      // bundle from being wallpaper
      p.hl(11, 8, 8, M.d3);
      p.hl(11, 9, 8, M.d1);
      p.hl(11, 15, 8, M.d3);
      p.hl(11, 16, 8, M.d1);
      p.r(12, 10, 6, 5, M.d3);
      p.vl(13, 10, 5, M.d4);
      p.vl(17, 10, 5, M.d0);
      p.hl(12, 14, 6, M.d0);
      // lagging torn off the left pipe — the one soft material up there
      p.r(1, 9, 5, 6, L.v3);
      p.hl(1, 9, 5, L.v5);
      p.hl(1, 14, 5, L.v0);
      p.scatter(2, 10, 3, 4, L.v2, 0.25, 205);
      // Rust weeps DOWN from under a strap, never up — so it goes in as three
      // deliberate streaks plus one thin band, not a field of orange speckle
      // sprayed across the whole bundle.
      for (const y of [7, 18]) p.scatter(0, y, 28, 1, W.rust, 0.14, 200 + y);
      p.vl(8, 8, 5, W.rustSh);
      p.vl(20, 19, 4, W.rustSh);
      p.vl(25, 8, 6, W.rustSh);
      p.p(8, 7, W.rustHi);
      p.p(25, 7, W.rustHi);
    },
  },

  locker_row: {
    w: 26,
    h: 24,
    frames: 1,
    anchor: [0.5, 0.94],
    draw: (p: Px) => {
      contact(p, 0, 21, 26, 3);
      // sloped top cap — a flat top on a bank this wide reads as a fridge
      p.hl(1, 0, 24, M.d3);
      p.hl(1, 1, 24, M.d4);
      p.hl(1, 2, 24, M.d2);
      p.r(1, 3, 24, 19, M.d1); // carcass
      p.vl(0, 3, 19, M.d2);
      p.vl(25, 3, 19, M.d0);
      p.hl(1, 21, 24, M.d0); // floor line
      for (const x of [1, 9]) {
        p.r(x, 3, 8, 18, M.d2); // door face
        p.vl(x, 3, 18, M.d3); // hinge edge takes the light
        p.vl(x + 7, 3, 18, M.d0); // shut line
        for (let k = 0; k < 3; k++) p.hl(x + 2, 5 + k * 2, 4, M.d0); // vents
        p.vl(x + 6, 11, 4, M.d4); // latch
        p.p(x + 6, 11, M.d5);
        p.r(x + 2, 17, 3, 1, M.d0); // number plate
        p.p(x + 2, 17, M.d4);
      }
      // The open bay has to be the DARKEST thing in the sprite. One notch off
      // and it reads as a third door in a slightly different grey.
      p.r(17, 3, 8, 18, L.v0);
      p.hl(17, 3, 8, M.d0);
      p.vl(17, 3, 18, M.d1); // the frame, now seen edge-on
      p.hl(18, 9, 6, M.d1); // hat shelf
      p.hl(18, 10, 6, L.v0);
      p.p(20, 10, M.d3); // the hook
      p.r(19, 11, 3, 6, S.fabric); // and what is still hanging on it
      p.hl(19, 11, 3, S.fabricHi);
      p.hl(18, 20, 6, L.v1); // its floor, catching a sliver
      // the door itself, swung open toward us — edge-on, so it is a thin panel
      p.r(24, 5, 2, 15, M.d3);
      p.vl(24, 5, 15, M.d4);
      p.vl(25, 5, 15, M.d1);
      p.hl(24, 19, 2, M.d0);
      // dents and rust along the kick line, where feet have been
      p.scatter(1, 18, 24, 3, W.rustSh, 0.08, 211);
      p.p(11, 14, M.d0);
      p.p(12, 15, M.d0);
    },
  },

  water_cooler: {
    w: 10,
    h: 20,
    frames: 1,
    anchor: [0.5, 0.95],
    draw: (p: Px) => {
      contact(p, 1, 17, 8, 3);
      // Translucency is a value INVERSION: the rim is darker than the middle,
      // the opposite of every opaque prop here. That flip is the only thing
      // that reads as "you can see through this" at ten pixels wide.
      // The shoulder tapering into a neck is the silhouette — a straight-sided
      // bottle is just a box, and a box on a box is a filing cabinet.
      p.r(3, 0, 4, 2, L.v1);
      p.r(2, 2, 6, 7, L.v1); // air above the waterline: nearly black
      p.vl(2, 2, 7, L.v4);
      p.vl(7, 2, 7, L.v0);
      p.hl(3, 0, 4, L.v3);
      p.r(2, 4, 6, 5, L.v6); // water: lighter core...
      p.vl(2, 4, 5, L.v4); // ...held inside a darker rim
      p.vl(7, 4, 5, L.v3);
      p.hl(2, 4, 6, L.v8); // the waterline, the one hard bright edge
      p.p(3, 1, L.v4); // specular running down the shoulder
      p.p(3, 6, L.v8);
      p.p(6, 7, L.v4);
      p.r(4, 9, 2, 2, M.d1); // neck, inverted into the cooler
      p.r(1, 11, 8, 7, M.d2); // cabinet
      p.hl(1, 11, 8, M.d4); // top deck, where the bottle sits
      p.vl(1, 11, 7, M.d3);
      p.vl(8, 11, 7, M.d0);
      p.hl(1, 17, 8, M.d0); // floor line
      p.r(3, 13, 1, 2, M.d4); // taps
      p.r(6, 13, 1, 2, M.d4);
      p.p(3, 13, L.v6);
      p.p(6, 13, W.rustHi); // the hot tap: the only warm pixel on the prop
      p.hl(2, 15, 6, M.d1); // drip tray, permanently stained
      p.hl(2, 16, 6, M.d0);
      p.scatter(2, 15, 6, 2, W.rustSh, 0.2, 221);
      p.p(2, 18, M.d0); // feet
      p.p(7, 18, M.d0);
    },
  },

  whiteboard: {
    w: 22,
    h: 16,
    frames: 1,
    draw: (p: Px) => {
      p.r(0, 0, 22, 15, M.d2); // frame
      p.hl(0, 0, 22, M.d4);
      p.hl(0, 14, 22, M.d0);
      p.vl(0, 0, 15, M.d3);
      p.vl(21, 0, 15, M.d0);
      // This has to be the lightest surface in the room without touching the
      // ceiling value, so the board runs on L.v7 and only the top band — where
      // the ceiling light actually lands — gets L.v8.
      p.r(1, 1, 20, 11, L.v7);
      p.r(1, 1, 20, 3, L.v8);
      p.hl(1, 11, 20, L.v5); // the bottom falls into its own shade
      // Wiped marker never leaves, it only loses contrast. Broad smears one
      // step down, then the couple of strokes somebody missed.
      p.hl(3, 3, 9, L.v6);
      p.hl(3, 4, 11, L.v6);
      p.hl(4, 5, 7, L.v6);
      p.hl(12, 6, 7, L.v6);
      p.hl(13, 7, 5, L.v6);
      p.scatter(2, 2, 18, 9, L.v6, 0.1, 231);
      p.hl(4, 8, 5, L.v4);
      p.p(9, 8, L.v4);
      p.hl(14, 3, 4, L.v4);
      p.p(14, 4, L.v4);
      p.p(17, 4, L.v4);
      p.hl(1, 12, 20, M.d3); // pen tray
      p.hl(1, 13, 20, M.d1);
      p.hl(3, 12, 3, W.rust); // a dead marker
      p.p(3, 12, W.rustHi);
      p.hl(14, 12, 4, M.d1); // the eraser, felt side down
      p.p(14, 12, M.d4);
      p.hl(1, 15, 20, 'rgba(6,10,18,0.35)'); // what it throws on the wall
    },
  },

  breaker_panel: {
    w: 14,
    h: 18,
    frames: 3,
    draw: (p: Px, frame: number) => {
      p.r(0, 0, 11, 18, M.d2);
      p.hl(0, 0, 11, M.d4);
      p.vl(0, 0, 18, M.d3);
      p.hl(0, 17, 11, M.d0);
      p.r(3, 0, 3, 1, M.d1); // conduit entering the top
      p.r(1, 2, 9, 14, L.v0); // the recess, open to us
      p.hl(1, 2, 9, M.d0);
      for (let i = 0; i < 4; i++) {
        const y = 3 + i * 3;
        p.r(2, y, 3, 2, M.d3);
        p.hl(2, y, 3, M.d4);
        // one toggle thrown the other way: the breaker that keeps tripping,
        // and the reason a red pip sits beside it in the glow
        p.p(i === 2 ? 4 : 2, y + 1, M.d0);
      }
      p.vl(6, 3, 11, M.d0); // busbar channel
      const pat = [0b1101, 0b0111, 0b1110][frame % 3];
      for (let i = 0; i < 4; i++) p.p(7, 4 + i * 3, (pat >> i) & 1 ? M.d5 : M.d1);
      p.r(8, 4, 2, 7, S.paperSh); // legend card, half torn
      p.hl(8, 4, 2, S.paper);
      p.scatter(8, 5, 2, 6, L.v2, 0.3, 241);
      p.p(9, 10, L.v1);
      // door ajar, swung right: a thin panel plus the inner face of it
      p.r(11, 1, 3, 15, M.d1);
      p.vl(11, 1, 15, M.d3);
      p.vl(13, 1, 15, M.d0);
      p.hl(11, 1, 3, M.d3);
      p.hl(11, 15, 3, M.d0);
      p.r(12, 6, 1, 3, M.d0); // latch, on the inside
    },
    glow: (p: Px, frame: number) => {
      const pat = [0b1101, 0b0111, 0b1110][frame % 3];
      for (let i = 0; i < 4; i++) {
        if (!((pat >> i) & 1)) continue;
        const y = 4 + i * 3;
        const trip = i === 2; // the tripped breaker is red and never goes out
        p.p(7, y, c(trip ? E.hazardCore : E.accentCore));
        p.p(6, y, c(trip ? E.hazard : E.accent));
        p.p(8, y, c(trip ? E.hazard : E.accent));
        const bleed = trip ? 'rgba(255,91,60,0.28)' : 'rgba(54,224,176,0.28)';
        p.hl(6, y - 1, 3, bleed);
        p.hl(6, y + 1, 3, bleed);
      }
    },
  },

  floor_fan: {
    w: 16,
    h: 16,
    frames: 4,
    anchor: [0.5, 0.94],
    draw: (p: Px, frame: number) => {
      contact(p, 3, 13, 10, 3);
      const cx = 8;
      const cy = 6;
      p.disc(cx, cy, 5, L.v0); // blades read against this, not against the floor
      // Four blades, so the shape repeats every 90° and the four frames step
      // 22.5° — one full visual turn per loop with no snap back to the start.
      for (let k = 0; k < 4; k++) {
        const a = ((k * 90 + frame * 22.5) * Math.PI) / 180;
        for (let r = 2; r <= 5; r++) {
          p.p(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), r > 3 ? M.d3 : M.d2);
          // trailing edge a value behind: this is what makes it look SWEPT
          const t = a - 0.45;
          p.p(Math.round(cx + Math.cos(t) * r), Math.round(cy + Math.sin(t) * r), M.d1);
        }
      }
      p.disc(cx, cy, 1, M.d4); // hub
      p.p(cx, cy - 1, M.d5);
      // Cage rings plotted by radius rather than drawn as discs — a disc would
      // erase the blades sitting behind it.
      for (let y = -6; y <= 6; y++) {
        for (let x = -6; x <= 6; x++) {
          const d = Math.round(Math.hypot(x, y));
          if (d === 6) p.p(cx + x, cy + y, y < 0 ? M.d4 : M.d1);
          else if (d === 4) p.p(cx + x, cy + y, y < 0 ? M.d2 : M.d0);
        }
      }
      p.p(2, 6, M.d2); // pivot bolts, where it tilts
      p.p(14, 6, M.d2);
      p.vl(7, 12, 2, M.d2); // neck
      p.vl(8, 12, 2, M.d0);
      p.hl(4, 13, 9, M.d3); // splayed foot, widest at the front
      p.hl(3, 14, 11, M.d2);
      p.hl(3, 15, 11, M.d0);
      p.p(13, 14, M.d1); // its cable, trailing off
      p.p(14, 15, M.d1);
      p.p(15, 15, M.d0);
    },
  },

  // ── the dark bottom-left: read as SILHOUETTE, interior detail is a bonus ────

  coat_rack: {
    w: 12,
    h: 24,
    frames: 1,
    anchor: [0.5, 0.96],
    draw: (p: Px) => {
      contact(p, 1, 21, 10, 3);
      // The pole is BENT — it steps a pixel at the kink. A straight pole in a
      // room made of straight lines is furniture; a kinked one is wreckage,
      // and the step survives even when the whole prop is one flat tone.
      p.vl(4, 1, 7, M.d3);
      p.vl(5, 1, 7, M.d1);
      p.vl(5, 8, 12, M.d3);
      p.vl(6, 8, 12, M.d1);
      p.p(4, 0, M.d4); // finial
      p.p(5, 0, M.d4);
      p.p(3, 1, M.d3); // hooks, two out one way and one the other
      p.p(2, 2, M.d2);
      p.p(6, 1, M.d3);
      p.p(7, 2, M.d2);
      p.p(3, 4, M.d2);
      // THE COAT. Every other object in this room is a hard rectangle, so this
      // one mass gets an irregular edge and not a single straight line — it is
      // the only soft silhouette in the level and it has to carry the corner.
      p.r(6, 4, 3, 2, S.fabric); // collar, thrown over the hook
      p.r(5, 6, 6, 3, S.fabric); // shoulders — the widest point, high up
      p.r(4, 9, 7, 4, S.fabric); // the body billows out past the pole on BOTH
      p.r(5, 13, 6, 3, S.fabric); // sides, so it is a mass and not a stripe
      p.r(6, 16, 4, 2, S.fabric);
      p.p(4, 8, S.fabric); // irregular edge: no two rows end on the same column
      p.p(11, 10, S.fabric);
      p.p(3, 11, S.fabric);
      p.p(11, 14, S.fabric);
      p.p(6, 18, S.fabric); // and a hem that hangs unevenly
      p.p(9, 18, S.fabric);
      p.hl(6, 4, 3, S.fabricHi); // light lands on the collar and the outer fold
      p.hl(5, 6, 5, S.fabricHi);
      p.vl(4, 9, 3, S.fabricHi);
      p.p(3, 11, S.fabricHi);
      p.hl(5, 15, 5, L.v1); // and dies well before the hem
      p.hl(6, 17, 4, L.v0);
      p.scatter(4, 7, 7, 9, L.v2, 0.12, 301); // wear in the cloth
      // three legs, splayed at different lengths
      p.hl(3, 20, 6, M.d2);
      p.p(2, 21, M.d2);
      p.p(9, 21, M.d2);
      p.hl(1, 22, 3, M.d1);
      p.hl(4, 22, 4, M.d1);
      p.hl(8, 22, 3, M.d1);
      p.hl(1, 23, 3, M.d0); // feet are the darkest thing in it: that plants it
      p.hl(4, 23, 4, M.d0);
      p.hl(8, 23, 3, M.d0);
    },
  },

  trolley: {
    w: 22,
    h: 18,
    frames: 1,
    anchor: [0.5, 0.94],
    draw: (p: Px) => {
      contact(p, 2, 15, 18, 3);
      // The push handle is the whole silhouette argument — two decks alone read
      // as a table. So it stands a third of the sprite tall with real AIR
      // inside the loop; a solid bracket just thickens the corner of the deck.
      p.hl(0, 0, 7, M.d4); // grip
      p.hl(0, 1, 7, M.d2);
      p.vl(0, 2, 4, M.d3); // stiles down to the deck
      p.vl(1, 2, 4, M.d1);
      p.vl(5, 2, 4, M.d3);
      p.vl(6, 2, 4, M.d1);
      // a tray of mail — the reason it is a trolley and not a shelf on wheels
      p.r(8, 3, 6, 3, S.paperSh);
      p.hl(8, 3, 6, S.paper);
      p.hl(8, 5, 6, L.v2);
      p.p(10, 4, S.paper);
      p.p(12, 4, S.paperSh);
      // a small crate beside it, a full step darker so the two do not merge
      p.r(14, 2, 5, 4, L.v3);
      p.hl(14, 2, 5, L.v5);
      p.vl(18, 2, 4, L.v1);
      p.hl(14, 5, 5, L.v0);
      // top deck
      p.r(2, 6, 19, 2, M.d2);
      p.hl(2, 6, 19, M.d4); // the plane we look down on
      p.hl(2, 8, 19, M.d0); // and the dark under-edge that gives it thickness
      p.vl(3, 8, 5, M.d2); // uprights
      p.vl(19, 8, 5, M.d2);
      // a carton on the lower deck, shoved to one end
      p.r(12, 8, 7, 4, W.cardboard);
      p.hl(12, 8, 7, W.cardboardHi);
      p.vl(18, 8, 4, S.dirt);
      p.hl(12, 11, 7, S.dirt);
      // lower deck, dimmer: less light reaches it
      p.r(3, 12, 17, 2, M.d1);
      p.hl(3, 12, 17, M.d3);
      p.hl(3, 14, 17, M.d0);
      // Castors. The left one is turned across the axle, so it reads as a bar
      // instead of a disc — one asymmetry, and the cart stops looking like a
      // diagram of a cart.
      p.vl(4, 14, 2, M.d1);
      p.r(3, 16, 3, 1, M.d2);
      p.p(3, 17, M.d0);
      p.p(5, 17, M.d0);
      for (const x of [11, 18]) {
        p.vl(x, 14, 2, M.d1);
        p.disc(x, 16, 1, M.d2);
        p.p(x, 15, M.d3);
        p.p(x, 17, M.d0);
      }
      p.scatter(3, 12, 17, 2, W.rustSh, 0.07, 311); // rust along the lower deck
    },
  },
} as const satisfies Record<string, DecorEntry>;

export type DecorName = keyof typeof DECOR;
