/**
 * Impact markers — THE red circle.
 *
 * The boss lobs arcing mortars; this layer draws where each one lands and how
 * long is left. It is a promise made to the player, so the geometry comes from
 * the sim record and nowhere else: the ring sits at exactly `Mortar.radius`,
 * the sweep at exactly `radius * fuse/fuseMax`. There is deliberately no
 * "visual radius", no fudge factor, no eased grow-in — the moment a render
 * constant touches the size, the picture starts lying about where it is safe
 * to stand, and every death after that is the game's fault.
 *
 * Read as four channels:
 *   1. outer dashed ring — WHERE. Full size instantly, never moves.
 *   2. dithered fill     — the patch of floor that is about to stop existing.
 *   3. sweep ring        — WHEN. Contracts to nothing: a cast bar, laid flat.
 *   4. final flash       — 6Hz, last 400ms. Move now.
 *
 * Layer position: BETWEEN the tilemap and entLayer. The robot and the boss
 * stand *in* the circle. A marker that occludes the robot destroys the exact
 * thing it exists to communicate.
 */

import { Container, Sprite, Texture } from 'pixi.js';
import type { Mortar } from '@shared/types';
import { TICK_HZ } from '@shared/types';
import { AMBER, AMBER_DIM, canvasTex, clamp01 } from './util';

// ------------------------------------------------------------------- palette

/**
 * PALETTE LAW (shared/artManifest.ts) says cold near-monochrome world, robot is
 * the only saturated thing, amber is the OSD's. Red is a third ink and it is
 * argued for, not smuggled in: `render/osd.ts` already burns `HOT = #ff4d3a` for
 * the REC dot, so on this monitor red *already* means "the camera is flagging a
 * live incident". A ground strike is exactly that. We are widening an existing
 * channel, not opening a new one.
 *
 * #c8352a has luma ≈79 — inside the world's structural gray band (its brightest
 * is #454c55 ≈76). The circle is separated from the world by HUE, not by value,
 * so the robot's #ff7a1a stays the brightest thing on the feed even while it is
 * standing in one. Amber is never touched.
 */
const RED = 0xc8352a;
const RED_HI = 0xe2564a; // sweep ring — a step brighter, still under the robot
const RED_FLASH = 0xff6a4d; // the "you have 400ms" red
const HOT = 0xff4d3a; // osd.ts REC-dot red, mirrored (it is module-private there)

interface Ink {
  ring: number;
  sweep: number;
  fill: number;
  /** The final-400ms flash alternates between these two. */
  flashA: number;
  flashB: number;
}

/** Red floor-paint: the circle is painted on the ground, in the fiction. */
const INK_RED: Ink = {
  ring: RED,
  sweep: RED_HI,
  fill: RED,
  flashA: RED,
  flashB: RED_FLASH,
};

/**
 * Amber overlay: the circle is the *camera's* prediction drawn onto the feed,
 * not paint on the floor. Keeps the world strictly monochrome and holds red
 * back for the panic beat, where it lands harder for having been withheld.
 */
const INK_AMBER: Ink = {
  ring: AMBER_DIM,
  sweep: AMBER,
  fill: AMBER_DIM,
  flashA: AMBER,
  flashB: HOT,
};

export type MarkerStyle = 'red' | 'amber';

/** `?mark=red|amber` — the A/B is a query flag so it can be judged in motion. */
const QUERY_STYLE: MarkerStyle | null = (() => {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('mark');
  return v === 'red' || v === 'amber' ? v : null;
})();

export const DEFAULT_MARKER_STYLE: MarkerStyle = QUERY_STYLE ?? 'red';

// ------------------------------------------------------------------ constants

/** Dash 8-on/4-off: reads as warning tape, and interferes with the scanline on
 *  purpose rather than by accident (a solid 1px ring shimmers as the CRT rolls). */
const DASH_ON = 8;
const DASH_OFF = 4;
/**
 * Lit dither pixels sit at 24% and cover half the disc → ~12% average. Two
 * overlapping markers run opposite parities, so they interleave into a SOLID
 * 24% wash instead of a doubled 48% blob: overlap reads as "more dangerous
 * here", never as a pink smear that has lost its edges.
 */
const FILL_ALPHA = 0.24;
/** Sweep radii are quantised — a baked texture per step, no per-frame geometry. */
const SWEEP_STEPS = 16;
/** Runaway guard. The fight peaks at 5 live mortars; 8 is headroom, not a budget. */
const MAX_MARKERS = 8;
/** Panic window, in ticks — the only clock this file takes from the sim. */
const FLASH_TICKS = Math.round(0.4 * TICK_HZ);
/** Full colour cycles per second during the panic window. */
const FLASH_HZ = 6;

// ----------------------------------------------------------------- rasterizer

/**
 * Everything is baked WHITE and coloured by `tint`, so the flash, the two
 * variants and the sweep's brighter ink are all free — one texture set per
 * distinct blast radius serves every mortar in the game.
 */

/** Hard 1px pixel circle. `gapPx <= 0` bakes a solid ring. */
function ringTex(r: number, onPx: number, gapPx: number): Texture {
  const size = 2 * r + 1;
  return canvasTex(size, size, (ctx) => {
    ctx.fillStyle = '#fff';
    if (r <= 0) {
      ctx.fillRect(0, 0, 1, 1);
      return;
    }
    // 0.5px angular sampling — dense enough that the plotted circle is
    // 8-connected (no diagonal holes) at every radius we bake.
    const steps = Math.ceil(4 * Math.PI * r);
    const period = onPx + gapPx;
    for (let i = 0; i < steps; i++) {
      const th = (i / steps) * Math.PI * 2;
      // dash phase runs on ARC LENGTH, so the tape looks the same on a small
      // circle and a large one instead of stretching with the radius
      if (gapPx > 0 && ((r * th) % period) >= onPx) continue;
      ctx.fillRect(Math.round(r + Math.cos(th) * r), Math.round(r + Math.sin(th) * r), 1, 1);
    }
  });
}

/** 50% checkerboard disc. `parity` flips the phase (see MarkerView.parity). */
function fillTex(r: number, parity: number): Texture {
  const size = 2 * r + 1;
  return canvasTex(size, size, (ctx) => {
    ctx.fillStyle = '#fff';
    for (let dy = -r; dy <= r; dy++) {
      const span = Math.floor(Math.sqrt(r * r - dy * dy) + 0.5);
      for (let dx = -span; dx <= span; dx++) {
        if (((dx + dy + parity) & 1) !== 0) continue;
        ctx.fillRect(r + dx, r + dy, 1, 1);
      }
    }
  });
}

interface Kit {
  ring: Texture;
  fill: [Texture, Texture];
  sweep: Texture[];
  sweepR: number[];
}

/** Module-level so two layers (or a floor rebuild) never re-bake the same radius. */
const KITS = new Map<number, Kit>();

function kitFor(radius: number): Kit {
  const r = Math.max(1, Math.round(radius));
  let k = KITS.get(r);
  if (k) return k;
  const sweep: Texture[] = [];
  const sweepR: number[] = [];
  for (let i = 1; i <= SWEEP_STEPS; i++) {
    const sr = Math.round((r * i) / SWEEP_STEPS);
    sweepR.push(sr);
    sweep.push(ringTex(sr, 1, 0)); // solid: the inner ring is the loud one
  }
  k = { ring: ringTex(r, DASH_ON, DASH_OFF), fill: [fillTex(r, 0), fillTex(r, 1)], sweep, sweepR };
  KITS.set(r, k);
  return k;
}

// --------------------------------------------------------------------- layer

interface MarkerView {
  root: Container;
  fill: Sprite;
  ring: Sprite;
  sweep: Sprite;
  kit: Kit;
  r: number;
  /** World-space dither phase (0/1), fixed for this marker's life. */
  parity: number;
  seen: boolean;
}

export class MarkerLayer {
  readonly container = new Container();

  private ink: Ink;
  private views = new Map<string, MarkerView>();
  private pool: MarkerView[] = [];
  private t = 0;
  /** Monotonic, NOT the array index: a marker's dither phase must not flip
   *  when an earlier mortar detonates and the array shifts under it. */
  private born = 0;

  constructor(style: MarkerStyle = DEFAULT_MARKER_STYLE) {
    this.ink = style === 'amber' ? INK_AMBER : INK_RED;
  }

  /** Floor rebuild — nothing from the old floor may survive the cut. */
  clear(): void {
    for (const v of this.views.values()) this.release(v);
    this.views.clear();
  }

  update(mortars: readonly Mortar[], dt: number): void {
    this.t += dt;
    for (const v of this.views.values()) v.seen = false;

    const n = Math.min(mortars.length, MAX_MARKERS);
    for (let i = 0; i < n; i++) {
      const m = mortars[i]!;
      let v = this.views.get(m.id);
      if (!v || v.r !== Math.max(1, Math.round(m.radius))) {
        if (v) this.release(v);
        v = this.acquire(m);
        this.views.set(m.id, v);
      }
      v.seen = true;
      this.apply(m, v);
    }

    for (const [id, v] of this.views) {
      if (!v.seen) {
        this.release(v);
        this.views.delete(id);
      }
    }
  }

  // ------------------------------------------------------------------ internals

  private acquire(m: Mortar): MarkerView {
    const kit = kitFor(m.radius);
    const r = Math.max(1, Math.round(m.radius));
    let v = this.pool.pop();
    if (!v) {
      const root = new Container();
      // Rings NEVER blend. Additive reds sum into a pink blob the moment two
      // markers touch; at normal blend + full alpha they cross like a Venn
      // diagram and stay countable, which is the only way overlap stays legible.
      const fill = new Sprite();
      fill.alpha = FILL_ALPHA;
      const ring = new Sprite();
      const sweep = new Sprite();
      root.addChild(fill, ring, sweep); // rings on top of their own fill
      this.container.addChild(root);
      v = { root, fill, ring, sweep, kit, r, parity: 0, seen: true };
    }
    v.kit = kit;
    v.r = r;
    v.parity = this.born++ & 1;
    v.root.visible = true;
    v.fill.texture = kit.fill[0]!;
    v.ring.texture = kit.ring;
    // anchor 0 + integer position keeps every baked pixel on the world grid;
    // a 0.5 anchor on an odd texture would land the dither half a pixel off and
    // it would crawl under the CRT downsample
    v.fill.position.set(-r, -r);
    v.ring.position.set(-r, -r);
    return v;
  }

  private release(v: MarkerView): void {
    v.root.visible = false;
    this.pool.push(v);
  }

  private apply(m: Mortar, v: MarkerView): void {
    // Centre snaps to the pixel grid (≤0.5px) because the art is 1px-hard —
    // this is rasterisation, not a fudge: the RADIUS is untouched.
    const cx = Math.round(m.target.x);
    const cy = Math.round(m.target.y);
    v.root.position.set(cx, cy);

    const t = clamp01(m.fuseMax > 0 ? m.fuse / m.fuseMax : 0);
    const hot = m.fuse <= FLASH_TICKS;
    // One global flash clock, so overlapping markers blink together and their
    // complementary dither phases stay complementary through the panic beat.
    const beat = hot && (Math.floor(this.t * FLASH_HZ * 2) & 1) === 1;
    const ink = this.ink;
    const flash = beat ? ink.flashB : ink.flashA;

    v.ring.tint = hot ? flash : ink.ring;
    v.sweep.tint = hot ? flash : ink.sweep;
    v.fill.tint = hot ? flash : ink.fill;

    // Baked parity is chosen so the LIT pixels land on world parity `v.parity`
    // regardless of where the circle sits: texel (i,j) is world (cx-r+i, cy-r+j),
    // and 2r is even, so the centre's own parity has to be cancelled out here.
    // The flash flips it, which makes the fill shimmer instead of merely blink.
    const par = (v.parity + cx + cy + (beat ? 1 : 0)) & 1;
    v.fill.texture = v.kit.fill[par]!;

    // WHEN: radius * fuse/fuseMax, quantised to a baked step. Never eased.
    const si = Math.min(SWEEP_STEPS - 1, Math.max(0, Math.ceil(t * SWEEP_STEPS) - 1));
    const sr = v.kit.sweepR[si]!;
    v.sweep.texture = v.kit.sweep[si]!;
    v.sweep.position.set(-sr, -sr);
  }
}
