/**
 * CEILING FIXTURE STYLES.
 *
 * A ceiling lamp is the hardest object in a top-down room to draw, because the
 * camera is looking at the one thing the projection cannot explain: something
 * hanging in the air between the camera and the floor. It has no ground
 * contact, no cast shadow, and it overlaps whatever walks under it. Draw it
 * with too much housing and it reads as an object lying ON the floor; draw it
 * with none and the light appears to come from nowhere.
 *
 * There is no single right answer, so this file offers five and the lab lets
 * you switch per fixture:
 *
 *   tube   the fluorescent batten — most literal, most housing, most confusing
 *   dome   an industrial reflector seen from below; round, so it reads as
 *          "above" rather than "on"
 *   panel  a flush recessed ceiling panel — no depth at all, so nothing about
 *          it competes with the floor
 *   bare   a bulb on a cord; almost no housing, the glow does the work
 *   none   no fixture at all, light with no visible source
 *
 * Every style keeps its own light: only the SPRITE changes, never the rig.
 */

import type { Drawer } from '../../art/px';
import type { Px } from '../../art/px';
import { E, L, M } from './palette';

const c = (n: number): string => '#' + n.toString(16).padStart(6, '0');

export interface FixtureStyle {
  w: number;
  h: number;
  draw: Drawer;
  glow: Drawer;
}

/** The original batten: channel, reflector flare, tube, one blackened end. */
const tube: FixtureStyle = {
  w: 20,
  h: 10,
  draw: (p: Px) => {
    p.r(2, 0, 16, 2, M.d1);
    p.hl(2, 0, 16, M.d2);
    p.r(0, 2, 20, 3, M.d2);
    p.hl(0, 2, 20, M.d3);
    p.hl(0, 4, 20, M.d0);
    p.r(0, 1, 2, 5, M.d3);
    p.r(18, 1, 2, 5, M.d3);
    p.r(2, 6, 16, 2, M.d4);
    p.hl(2, 6, 16, M.hi);
    p.hl(2, 8, 16, M.d1);
    p.r(14, 6, 4, 2, M.d2); // the end that has gone
    p.scatter(0, 2, 20, 3, M.d0, 0.1, 55);
  },
  glow: (p: Px) => {
    p.hl(2, 6, 12, c(E.keyCore));
    p.hl(2, 7, 12, c(E.key));
    p.hl(13, 6, 3, c(E.key));
    p.hl(1, 5, 18, 'rgba(255,183,116,0.30)');
    p.hl(1, 8, 18, 'rgba(255,183,116,0.45)');
    p.hl(2, 9, 16, 'rgba(255,183,116,0.20)');
  },
};

/**
 * Industrial reflector, seen from below. Round is the point: nothing on this
 * floor is round, so the shape alone says "this is not lying on the deck".
 */
const dome: FixtureStyle = {
  w: 18,
  h: 14,
  draw: (p: Px) => {
    p.vl(9, 0, 3, M.d1); // the drop rod it hangs on
    p.p(9, 0, M.d3);
    p.disc(9, 8, 7, M.d2); // shade, outer
    p.disc(9, 8, 6, M.d3);
    p.disc(9, 8, 4, M.d1); // the recess the lamp sits in
    p.hl(4, 4, 11, M.d4); // ceiling bounce on the top of the rim
    p.hl(3, 12, 13, M.d0); // underside of the rim, darkest
    p.p(2, 8, M.d0);
    p.p(16, 8, M.d0);
    p.disc(9, 8, 2, M.d5); // the lamp itself
    p.p(9, 7, M.hi);
    p.scatter(4, 3, 11, 4, M.d1, 0.14, 71); // dust on the shoulder
  },
  glow: (p: Px) => {
    p.disc(9, 8, 2, c(E.keyCore));
    p.disc(9, 8, 3, 'rgba(255,183,116,0.75)');
    p.disc(9, 8, 5, 'rgba(255,183,116,0.30)');
    p.disc(9, 8, 7, 'rgba(255,183,116,0.14)');
  },
};

/**
 * Flush recessed panel. Zero depth, so it cannot be misread as an object on the
 * floor — it is a hole in the ceiling with light behind it. The frame is one
 * pixel of dark and nothing else.
 */
const panel: FixtureStyle = {
  w: 24,
  h: 12,
  draw: (p: Px) => {
    p.box(0, 0, 24, 12, L.v1);
    p.r(1, 1, 22, 10, M.d3);
    p.hl(1, 1, 22, M.d4);
    p.hl(1, 10, 22, M.d1);
    // diffuser grid — two bars, enough to say "there is a panel here"
    p.hl(1, 4, 22, M.d1);
    p.hl(1, 7, 22, M.d1);
    p.scatter(1, 1, 22, 10, M.d2, 0.1, 93);
    p.p(1, 1, M.d5);
    p.p(22, 1, M.d5);
  },
  glow: (p: Px) => {
    p.r(1, 1, 22, 10, 'rgba(255,220,180,0.72)');
    p.hl(1, 2, 22, c(E.keyCore));
    p.hl(1, 8, 22, c(E.key));
    p.hl(0, 0, 24, 'rgba(255,183,116,0.22)');
    p.hl(0, 11, 24, 'rgba(255,183,116,0.30)');
  },
};

/** A bulb on a cord. Nearly no housing — the light is the object. */
const bare: FixtureStyle = {
  w: 8,
  h: 14,
  draw: (p: Px) => {
    p.vl(4, 0, 6, M.d1);
    p.p(4, 0, M.d3);
    p.r(3, 6, 3, 2, M.d3); // the lampholder
    p.hl(3, 6, 3, M.d4);
    p.disc(4, 10, 2, M.d5); // the bulb
    p.p(4, 9, M.hi);
    p.p(3, 11, M.d3);
  },
  glow: (p: Px) => {
    p.disc(4, 10, 2, c(E.keyCore));
    p.disc(4, 10, 3, 'rgba(255,183,116,0.5)');
    p.p(4, 8, 'rgba(255,183,116,0.6)');
  },
};

/** No fixture. The room is lit and you never find out how. */
const none: FixtureStyle = {
  w: 2,
  h: 2,
  draw: () => {},
  glow: () => {},
};

export const LAMP_STYLES = { tube, dome, panel, bare, none } as const;
export type LampStyle = keyof typeof LAMP_STYLES;
export const LAMP_STYLE_NAMES = Object.keys(LAMP_STYLES) as LampStyle[];

// --------------------------------------------------------------- wall lights

/**
 * WALL FIXTURE STYLES.
 *
 * These have the opposite problem to the ceiling ones, and it is a much easier
 * problem: a wall lamp is mounted on a surface the camera can actually see, so
 * it has a plane to sit on and a shadow direction that makes sense. Which is
 * why, with the ceiling fixtures switched off, these are what has to carry the
 * "where is this light coming from" job for the whole room.
 *
 * All of them mount on a SOUTH-FACING wall face (a solid tile with open floor
 * below it) — that 16px band is the only vertical surface this projection
 * shows. Anchored near the bottom of that band so the housing sits on the wall
 * and its spill falls onto the floor in front.
 */
const sconce: FixtureStyle = {
  w: 12,
  h: 12,
  draw: (p: Px) => {
    p.r(5, 0, 2, 3, M.d2); // mounting plate against the wall
    p.hl(5, 0, 2, M.d3);
    p.r(1, 3, 10, 2, M.d3); // the hood, wide so it throws a wide pool
    p.hl(1, 3, 10, M.d4);
    p.hl(1, 4, 10, M.d0);
    p.r(2, 5, 8, 3, M.d1); // the recess under it
    p.r(3, 6, 6, 2, M.d4); // lamp
    p.hl(3, 6, 6, M.hi);
    p.hl(2, 8, 8, M.d0); // lip shadow
    p.p(1, 5, M.d2);
    p.p(10, 5, M.d2);
  },
  glow: (p: Px) => {
    p.r(3, 6, 6, 2, c(E.keyCore));
    p.hl(2, 5, 8, 'rgba(255,183,116,0.45)');
    p.hl(2, 8, 8, 'rgba(255,183,116,0.55)');
    p.hl(1, 9, 10, 'rgba(255,183,116,0.32)');
    p.hl(0, 10, 12, 'rgba(255,183,116,0.16)');
  },
};

/** Linear strip on the wall — the long, calm one. Reads at a glance. */
const strip: FixtureStyle = {
  w: 22,
  h: 8,
  draw: (p: Px) => {
    p.r(1, 1, 20, 2, M.d2);
    p.hl(1, 1, 20, M.d3);
    p.r(0, 3, 22, 2, M.d4); // the lit face
    p.hl(0, 3, 22, M.hi);
    p.hl(0, 5, 22, M.d0);
    p.r(0, 2, 2, 3, M.d3); // end caps
    p.r(20, 2, 2, 3, M.d3);
    p.scatter(1, 1, 20, 2, M.d1, 0.12, 37);
  },
  glow: (p: Px) => {
    p.hl(1, 3, 20, c(E.keyCore));
    p.hl(1, 4, 20, c(E.key));
    p.hl(0, 2, 22, 'rgba(255,183,116,0.34)');
    p.hl(0, 6, 22, 'rgba(255,183,116,0.42)');
    p.hl(1, 7, 20, 'rgba(255,183,116,0.18)');
  },
};

/** Bracket floodlight, angled down at the floor. The aggressive one. */
const flood: FixtureStyle = {
  w: 12,
  h: 12,
  draw: (p: Px) => {
    p.r(0, 1, 3, 5, M.d2); // wall bracket
    p.hl(0, 1, 3, M.d3);
    p.p(3, 3, M.d1); // the pivot
    p.r(3, 2, 8, 6, M.d3); // housing, canted
    p.hl(3, 2, 8, M.d4);
    p.vl(3, 2, 6, M.d1);
    p.r(4, 4, 6, 3, M.d1); // the recess
    p.r(5, 5, 4, 2, M.d5); // lamp
    p.p(5, 5, M.hi);
    p.hl(4, 8, 7, M.d0); // hard lip shadow under the barn door
    p.p(11, 3, M.d2);
    p.p(11, 7, M.d2);
  },
  glow: (p: Px) => {
    p.r(5, 5, 4, 2, c(E.keyCore));
    p.r(4, 4, 6, 4, 'rgba(255,183,116,0.42)');
    p.hl(4, 9, 7, 'rgba(255,183,116,0.34)');
    p.hl(3, 10, 8, 'rgba(255,183,116,0.16)');
  },
};

/** The caged bulkhead — the one that was already in the room. */
const caged: FixtureStyle = {
  w: 10,
  h: 14,
  draw: (p: Px) => {
    p.r(4, 0, 2, 3, M.d2);
    p.r(2, 2, 6, 2, M.d3);
    p.hl(2, 2, 6, M.d4);
    p.r(1, 4, 8, 2, M.d2);
    p.hl(1, 4, 8, M.d3);
    p.hl(1, 5, 8, M.d0);
    p.disc(4, 8, 2, M.d5);
    p.p(4, 7, M.hi);
    p.vl(1, 6, 6, M.d3);
    p.vl(4, 6, 6, M.d1);
    p.vl(7, 6, 6, M.d3);
    p.hl(1, 6, 7, M.d4);
    p.hl(1, 11, 7, M.d1);
    p.r(3, 12, 4, 1, M.d0);
  },
  glow: (p: Px) => {
    p.disc(4, 8, 2, c(E.key));
    p.p(4, 8, c(E.keyCore));
    p.r(2, 6, 5, 6, 'rgba(255,183,116,0.34)');
    p.p(0, 8, 'rgba(255,183,116,0.55)');
    p.p(9, 8, 'rgba(255,183,116,0.55)');
    p.hl(3, 12, 4, 'rgba(255,183,116,0.5)');
    // Bars sit IN FRONT of the bulb, so punch them back out of the glow mask.
    // Only the glow is unlit there; the body art is a separate texture.
    for (const x of [1, 4, 7]) for (let y = 6; y < 12; y++) p.hole(x, y, 0);
  },
};

export const WALL_STYLES = { sconce, strip, flood, caged, none } as const;
export type WallStyle = keyof typeof WALL_STYLES;
export const WALL_STYLE_NAMES = Object.keys(WALL_STYLES) as WallStyle[];
