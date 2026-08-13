/** Render-local helpers. Presentation only — never writes to sim/ui. */

import { Texture } from 'pixi.js';
import type { ArtAtlas } from '@shared/types';
import { ART, type ArtEntry, type ArtName } from '@shared/artManifest';

export const AMBER = 0xffb000;
export const AMBER_DIM = 0xb87f00;
/** Font stacks — FontFace-loaded in init; monospace/cursive are the zero-font fallback. */
export const VT323 = ['VT323', 'monospace'];
export const CAVEAT = ['Caveat', 'cursive'];

/**
 * Is the player's primary input a finger? Decides whether the prompts say
 * [SPACE] or TAP — telling a phone to press space is telling it nothing.
 * Seeded from the media query, then latched true the first time a real touch
 * lands: a hybrid laptop reads as keyboard until a finger says otherwise.
 */
let touchUi =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: none) and (pointer: coarse)').matches;

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') touchUi = true;
    },
    { capture: true, passive: true },
  );
}

export const isTouchUi = (): boolean => touchUi;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/** Per-channel color lerp for tint pulses. */
export function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (
    (Math.round(lerp(ar, br, t)) << 16) |
    (Math.round(lerp(ag, bg, t)) << 8) |
    Math.round(lerp(ab, bb, t))
  );
}

/** ArtAtlas is pixi-free in shared/ — render is where the cast to Texture happens. */
export const tex = (art: ArtAtlas, name: ArtName): Texture => art.tex(name) as Texture;
export const frames = (art: ArtAtlas, name: ArtName): Texture[] =>
  art.frames(name) as Texture[];
export const anchorOf = (name: ArtName): [number, number] =>
  (ART[name] as ArtEntry).anchor ?? [0.5, 0.5];

/**
 * Where a lit actor's sprite sits, for art drawn at `name` and scaled by `scale`.
 *
 * Two conversions, and both show up as furniture floating an inch off the deck
 * when they are wrong:
 *
 *  - **y.** A lit `ActorPart` is always centred and offset by `y`; the art
 *    manifest anchors a sprite wherever it was drawn to sit. A sprite anchored
 *    at `ay` covers the same pixels as a centred one offset by `h * (0.5 - ay)`.
 *  - **foot.** The drop from the origin to the floor — what the projected
 *    shadow hinges on and what the y-sort keys off. For a body standing on the
 *    bottom edge of its own sprite, `h * (1 - ay)`.
 *
 * Both `render/litWorld.ts` (the game) and `designer/litActors.ts` (the editing
 * view) turn sim bodies into actors, and these two numbers are the whole of the
 * conversion. They live here so the two callers cannot drift apart.
 */
export function actorPlacement(name: ArtName, scale = 1): { y: number; foot: number } {
  const h = ART[name].h;
  const ay = anchorOf(name)[1];
  return { y: h * scale * (0.5 - ay), foot: h * scale * (1 - ay) };
}

/** djb2 — stable per-entity phase seeds for presentation rng. */
export function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * Tick-to-tick position interpolation. Sim exposes only the current tick, so
 * render tracks the previous one itself; big jumps (spawn/floor change) snap.
 */
export class Interp {
  private px = 0;
  private py = 0;
  private cx = 0;
  private cy = 0;
  private tick = -1;

  push(tick: number, x: number, y: number): void {
    if (tick !== this.tick) {
      if (this.tick < 0 || Math.abs(x - this.cx) + Math.abs(y - this.cy) > 48) {
        this.px = x;
        this.py = y;
      } else {
        this.px = this.cx;
        this.py = this.cy;
      }
      this.tick = tick;
    }
    this.cx = x;
    this.cy = y;
  }

  x(alpha: number): number {
    return lerp(this.px, this.cx, alpha);
  }

  y(alpha: number): number {
    return lerp(this.py, this.cy, alpha);
  }
}

/** Code-drawn helper textures owned by render (noise, glows, scanlines, bands). */
export function canvasTex(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): Texture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) draw(ctx);
  const t = Texture.from(c);
  t.source.scaleMode = 'nearest';
  return t;
}

/**
 * Soft glow squashed into an ellipse, baked at the size it will be drawn.
 *
 * The classic path gets this shape by scaling a round glow non-uniformly, which
 * a lit actor part cannot do — its scale is one number, because a part that
 * could stretch could also disagree with the silhouette projected from it.
 */
export function ellipseGlow(w: number, h: number, color: string): Texture {
  const t = canvasTex(w, h, (ctx) => {
    ctx.translate(w / 2, h / 2);
    ctx.scale(1, h / w);
    const g = ctx.createRadialGradient(0, 0, 1, 0, 0, w / 2);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
    ctx.fill();
  });
  t.source.scaleMode = 'linear'; // gradients band badly under nearest
  return t;
}

/** Soft radial glow texture (for elevator/socket warm light). */
export function glowTex(size: number, color: string): Texture {
  const t = canvasTex(size, size, (ctx) => {
    const g = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  });
  t.source.scaleMode = 'linear'; // gradients band badly under nearest
  return t;
}
