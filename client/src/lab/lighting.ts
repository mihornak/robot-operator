/**
 * Deferred 2D lighting with real shadow casting.
 *
 * Pipeline, once per frame:
 *   1. every dirty light bakes its own greyscale falloff texture, with shadow
 *      volumes from the occluder rects punched into it (cached — a light that
 *      hasn't moved never re-bakes, and flicker only changes the blit alpha)
 *   2. one compose pass builds the screen-space lightmap: ambient fill, every
 *      light blitted additively with its own colour, then AO multiplied over
 *   3. `LightmapFilter` multiplies the world by that texture
 *
 * Everything here works in WORLD space and is rendered through the same camera
 * transform as the world container, so the lightmap lands pixel-on-pixel.
 *
 * The five-draw shadow trick in `bake()` is worth reading the comment for.
 */

import {
  BlurFilter,
  Container,
  Graphics,
  Rectangle,
  Renderer,
  RenderTexture,
  Sprite,
  Texture,
} from 'pixi.js';
import { canvasTex } from '../render/util';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LightKind = 'point' | 'cone';

export interface LightDef {
  id: string;
  x: number;
  y: number;
  radius: number;
  color: number;
  intensity: number;
  kind?: LightKind;
  /** cone facing, radians (0 = +x). */
  dir?: number;
  /** cone half-angle, radians. */
  spread?: number;
  castShadow?: boolean;
  /** 0 = steady, 1 = a dying fluorescent tube. */
  flicker?: number;
  flickerHz?: number;
  /** Set false for lights that shouldn't spawn dust / volumetrics. */
  volumetric?: boolean;
  /** Multiplies the global radius slider — lets one lamp stay small. */
  scale?: number;
}

interface LiveLight extends LightDef {
  rt: RenderTexture;
  sprite: Sprite;
  /** last-baked signature; a mismatch forces a re-bake */
  sig: string;
  /** 0..1, flicker output for this frame */
  level: number;
  phase: number;
}

export interface LightParams {
  ambientColor: number;
  ambientLevel: number;
  gain: number;
  radiusScale: number;
  falloff: number;
  flicker: number;
  shadowsOn: boolean;
  shadowAlpha: number;
  shadowSoftness: number;
  shadowLength: number;
  shadowBias: number;
  shadowFade: number;
  shadowNear: number;
  shadowBands: number;
  aoOn: boolean;
  aoStrength: number;
  aoRadius: number;
  /** Bisection switches — see the Lightmap group in the panel. */
  showAmbient: boolean;
  showLights: boolean;
}

/** Scale an 0xRRGGBB by a 0..1 factor, staying in 8-bit. */
export function scaleColor(color: number, k: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * k));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * k));
  const b = Math.min(255, Math.round((color & 0xff) * k));
  return (r << 16) | (g << 8) | b;
}

/**
 * Greyscale radial falloff. `1 - (d)^p` shaped in the alpha channel: the RGB is
 * pure white so a tint at blit time is the light's colour, and premultiplied
 * alpha makes the additive blit come out exactly as the falloff curve.
 */
function radialTex(size: number, falloff: number): Texture {
  const t = canvasTex(size, size, (ctx) => {
    const img = ctx.createImageData(size, size);
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - c, y - c) / c;
        const v = d >= 1 ? 0 : (1 - d) ** falloff;
        const i = (y * size + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(v * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  t.source.scaleMode = 'linear';
  return t;
}

/** Cone falloff, pointing +x, apex at the left-centre of the texture. */
function coneTex(size: number, falloff: number, spread: number): Texture {
  const t = canvasTex(size, size, (ctx) => {
    const img = ctx.createImageData(size, size);
    const cy = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x;
        const dy = y - cy;
        const d = Math.hypot(dx, dy) / (size - 1);
        const a = Math.abs(Math.atan2(dy, dx));
        // soft angular edge — a hard one reads as a triangle sprite, not light
        const ang = 1 - Math.min(1, Math.max(0, (a - spread * 0.55) / (spread * 0.55 + 0.001)));
        const v = d >= 1 ? 0 : (1 - d) ** falloff * ang * ang;
        const i = (y * size + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(Math.max(0, v) * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  t.source.scaleMode = 'linear';
  return t;
}

const RADIAL_SIZE = 192;
const CONE_SIZE = 192;

export class LightMap {
  readonly texture: RenderTexture;
  readonly lights: LiveLight[] = [];

  /** Solid geometry that stops light. Walls plus prop footprints. */
  private occluders: Rect[] = [];

  private renderer: Renderer;
  private w: number;
  private h: number;

  // compose scene
  private composeRoot = new Container();
  private ambient = new Sprite(Texture.WHITE);
  private lightRoot = new Container();

  // bake scene (reused for every light) — see bake() for what the five children
  // are and why there are five of them
  private bakeRoot = new Container();
  private bakeCam = new Container();
  /** Falloff sprites and shadow stencils, interleaved. See bake(). */
  private bakeSprites: Sprite[] = [];
  private bakeStencils: Graphics[] = [];
  private bakeBlur = new BlurFilter({ strength: 2, quality: 3 });

  private radialCache = new Map<string, Texture>();
  private coneCache = new Map<string, Texture>();

  /** Bumped whenever a param that affects baked geometry changes. */
  private geomVersion = 0;
  private aoVersion = -1;
  private groundRt: RenderTexture | null = null;
  private groundSig = '';
  private aoRt: RenderTexture | null = null;

  private camX = 0;
  private camY = 0;
  private camScale = 1;

  constructor(renderer: Renderer, width: number, height: number) {
    this.renderer = renderer;
    this.w = width;
    this.h = height;
    this.texture = RenderTexture.create({ width, height, antialias: false });
    this.texture.source.scaleMode = 'nearest';

    this.ambient.width = width;
    this.ambient.height = height;
    this.composeRoot.addChild(this.ambient, this.lightRoot);

    this.bakeRoot.addChild(this.bakeCam);
  }

  // ------------------------------------------------------------------ setup

  setCamera(x: number, y: number, scale: number): void {
    if (x === this.camX && y === this.camY && scale === this.camScale) return;
    this.camX = x;
    this.camY = y;
    this.camScale = scale;
    this.geomVersion++;
  }

  setOccluders(rects: Rect[]): void {
    this.occluders = rects;
    this.geomVersion++;
    this.aoVersion = -1;
  }

  add(def: LightDef): void {
    const rt = RenderTexture.create({ width: this.w, height: this.h, antialias: false });
    rt.source.scaleMode = 'nearest';
    const sprite = new Sprite(rt);
    sprite.blendMode = 'add';
    this.lightRoot.addChild(sprite);
    this.lights.push({
      castShadow: true,
      flicker: 0,
      flickerHz: 8,
      kind: 'point',
      volumetric: true,
      scale: 1,
      ...def,
      rt,
      sprite,
      sig: '',
      level: 1,
      phase: (this.lights.length * 2.399) % 6.283,
    });
  }

  get(id: string): LiveLight | undefined {
    return this.lights.find((l) => l.id === id);
  }

  /** Force every light to re-bake — call after moving lights or props. */
  invalidate(): void {
    this.geomVersion++;
  }

  // ----------------------------------------------------------------- shadow

  /**
   * Shadow volumes for one light. Each occluder contributes a quad per edge the
   * light can see, extruded away from the light past its own radius. Only the
   * silhouette edges matter, so at most two of four per rect ever draw.
   */
  private buildShadows(
    l: LiveLight,
    p: LightParams,
    radius: number,
    g: Graphics,
    reach: number,
    rects: Rect[] = this.occluders,
    color = 0x000000,
  ): void {
    g.clear();
    if (!p.shadowsOn) return;
    const far = radius * 2.2 * p.shadowLength * reach;
    const bias = p.shadowBias;

    for (const o of rects) {
      const x0 = o.x - bias;
      const y0 = o.y - bias;
      const x1 = o.x + o.w + bias;
      const y1 = o.y + o.h + bias;
      // a light inside its own occluder would cast the room into shadow
      if (l.x > x0 && l.x < x1 && l.y > y0 && l.y < y1) continue;
      // cheap reject: rects entirely outside the light's reach cast nothing
      const nx = Math.max(x0, Math.min(l.x, x1));
      const ny = Math.max(y0, Math.min(l.y, y1));
      if ((nx - l.x) ** 2 + (ny - l.y) ** 2 > radius * radius) continue;

      const edges: Array<[number, number, number, number]> = [];
      if (l.y < y0) edges.push([x0, y0, x1, y0]);
      if (l.y > y1) edges.push([x0, y1, x1, y1]);
      if (l.x < x0) edges.push([x0, y0, x0, y1]);
      if (l.x > x1) edges.push([x1, y0, x1, y1]);

      for (const [ax, ay, bx, by] of edges) {
        const adx = ax - l.x;
        const ady = ay - l.y;
        const bdx = bx - l.x;
        const bdy = by - l.y;
        const al = Math.hypot(adx, ady) || 1;
        const bl = Math.hypot(bdx, bdy) || 1;
        g.poly([
          ax,
          ay,
          bx,
          by,
          bx + (bdx / bl) * far,
          by + (bdy / bl) * far,
          ax + (adx / al) * far,
          ay + (ady / al) * far,
        ]);
      }
    }
    g.fill({ color, alpha: 1 });
  }

  private radial(falloff: number): Texture {
    const key = falloff.toFixed(2);
    let t = this.radialCache.get(key);
    if (!t) {
      t = radialTex(RADIAL_SIZE, falloff);
      this.radialCache.set(key, t);
    }
    return t;
  }

  private cone(falloff: number, spread: number): Texture {
    const key = `${falloff.toFixed(2)}:${spread.toFixed(2)}`;
    let t = this.coneCache.get(key);
    if (!t) {
      t = coneTex(CONE_SIZE, falloff, spread);
      this.coneCache.set(key, t);
    }
    return t;
  }

  /**
   * Bake one light into its own texture.
   *
   * FIVE draws, and the order is the whole trick.
   *
   * Shadow quads overlap each other constantly, so they can only ever be drawn
   * at alpha 1 — any partial alpha double-blends along every seam and the
   * shadow comes out veined. So partial darkness has to be built out of
   * full-strength stencils and additive light passes instead:
   *
   *   1. falloff at A            (normal)
   *   2. FAR shadow stencil      (black, alpha 1)   → everything shadowed = 0
   *   3. falloff at B            (add)              → all shadow = B
   *   4. NEAR shadow stencil     (black, alpha 1)   → contact zone back to 0
   *   5. falloff at C            (add)              → contact = C, far = B+C
   *
   * With A+B+C = 1 the lit floor is exactly the falloff curve, the contact zone
   * sits at C and the far reaches at B+C. Choosing C < B+C is the point: real
   * shadows are dark and sharp where the object meets the floor and wash out
   * with distance, and at 480×270 that ramp is worth far more than a true
   * penumbra — which would need the light sampled as an area, i.e. a render
   * target per sample, to buy about one pixel of edge softness.
   */
  private bake(l: LiveLight, p: LightParams): void {
    const radius = l.radius * p.radiusScale * (l.scale ?? 1);
    const sh = p.shadowsOn ? p.shadowAlpha : 0;
    const near = p.shadowNear;
    const bands = Math.max(2, Math.min(8, Math.round(p.shadowBands)));

    const tex =
      l.kind === 'cone'
        ? this.cone(p.falloff, l.spread ?? 0.6)
        : this.radial(p.falloff);

    // Grow the pools to `bands + 1` falloff sprites and `bands` stencils.
    while (this.bakeSprites.length < bands + 1) {
      const sp = new Sprite();
      sp.blendMode = this.bakeSprites.length === 0 ? 'normal' : 'add';
      this.bakeSprites.push(sp);
    }
    while (this.bakeStencils.length < bands) this.bakeStencils.push(new Graphics());

    /**
     * Target LIGHT level for each band, far end first.
     *
     * `t` runs 0 at the contact end to 1 at the tip, and the shadow lightens
     * along it by `shadowFade` — so at 1 the shadow fades out entirely instead
     * of stopping dead at its own length, which is the tell that a shadow is a
     * polygon rather than an absence of light.
     */
    const level: number[] = [];
    for (let i = 0; i < bands; i++) {
      const r = 1 - (i / (bands - 1)) * (1 - near); // r0 = 1 (tip) … last = near
      const t = 1 - near > 1e-4 ? (r - near) / (1 - near) : 0;
      level.push(1 - sh * (1 - p.shadowFade * t));
    }

    /**
     * Interleave: falloff, stencil, falloff, stencil, … falloff.
     *
     * Shadow quads overlap constantly, so a stencil can only ever be drawn at
     * alpha 1 — partial alpha double-blends along every seam and the shadow
     * comes out veined. Partial darkness is therefore built out of full-strength
     * stencils and additive light passes: each stencil blacks out everything
     * inside its reach, and the next additive pass puts back exactly the light
     * that band is supposed to keep. The reaches shrink, so the amounts
     * accumulate toward the caster and the ramp comes out smooth.
     *
     * The alphas sum to 1, which is what keeps LIT floor at exactly the falloff
     * curve no matter how many bands there are.
     */
    this.bakeCam.removeChildren();
    const shape = (sp: Sprite, alpha: number): void => {
      sp.texture = tex;
      sp.alpha = alpha;
      if (l.kind === 'cone') {
        sp.anchor.set(0, 0.5);
        sp.rotation = l.dir ?? 0;
        sp.width = radius;
        sp.height = radius * 2;
      } else {
        sp.anchor.set(0.5);
        sp.rotation = 0;
        sp.width = radius * 2;
        sp.height = radius * 2;
      }
      sp.position.set(l.x, l.y);
      this.bakeCam.addChild(sp);
    };

    shape(this.bakeSprites[0]!, 1 - level[0]!);
    for (let i = 0; i < bands; i++) {
      const g = this.bakeStencils[i]!;
      const reach = 1 - (i / (bands - 1)) * (1 - near);
      this.buildShadows(l, p, radius, g, reach);
      this.bakeCam.addChild(g);
      const add = i === bands - 1 ? level[i]! : level[i]! - level[i + 1]!;
      shape(this.bakeSprites[i + 1]!, Math.max(0, add));
    }

    this.bakeCam.position.set(this.camX, this.camY);
    this.bakeCam.scale.set(this.camScale);

    if (p.shadowSoftness > 0.05) {
      this.bakeBlur.strength = p.shadowSoftness;
      this.bakeRoot.filters = [this.bakeBlur];
      this.bakeRoot.filterArea = new Rectangle(0, 0, this.w, this.h);
    } else {
      this.bakeRoot.filters = [];
    }

    this.renderer.render({ container: this.bakeRoot, target: l.rt, clear: true });
  }

  // --------------------------------------------------------------------- AO

  /**
   * Shadows cast by PROPS, as a floor-only multiply mask.
   *
   * These cannot live in the lightmap. The lightmap is the light reaching every
   * surface in the room, and a desk only blocks light at knee height — stand a
   * character in front of a desk and the desk's floor-shadow was darkening its
   * head. Walls are different, and stay in the lightmap: they run floor to
   * ceiling, so a body standing in a wall's shadow really is in shadow.
   *
   * Drawn as a union rather than accumulated per light: overlapping quads at
   * partial alpha double-darken along every seam, and one bake beats one per
   * light. The price of a union is that a prop throws a shadow away from EVERY
   * lamp at once, which is why `reach` is short here — a filing cabinet is
   * knee-high, its shadow is a pool around its base, and at that length the
   * union reads as contact darkening rather than as a searchlight fan. This is
   * a floor decal; it does not need to be radiometrically honest, it needs to
   * make the furniture look like it is sitting in the room.
   */
  groundShadowTexture(
    rects: Rect[],
    p: LightParams,
    reach = 1,
    footprints = true,
  ): RenderTexture | null {
    if (!p.shadowsOn || rects.length === 0) return null;
    const sig = [
      this.geomVersion,
      p.radiusScale,
      p.shadowLength,
      p.shadowBias,
      rects.length,
      reach,
      footprints ? 1 : 0,
      p.shadowSoftness,
      p.shadowFade,
      p.shadowNear,
      p.shadowBands,
      this.lights.map((l) => `${l.x.toFixed(0)},${l.y.toFixed(0)}`).join('|'),
    ].join(',');
    if (sig === this.groundSig && this.groundRt) return this.groundRt;
    this.groundSig = sig;

    if (!this.groundRt) {
      this.groundRt = RenderTexture.create({ width: this.w, height: this.h, antialias: false });
      this.groundRt.source.scaleMode = 'nearest';
    }
    const root = new Container();
    const cam = new Container();
    const bg = new Sprite(Texture.WHITE);
    bg.width = this.w;
    bg.height = this.h;

    // ONE shadow per prop, from the light that dominates where that prop
    // stands — not the union over every lamp. The union made each piece of
    // furniture throw a wedge in eight directions at once, which across a room
    // this dressed turns the floor into a starburst. Picking a dominant light
    // also makes this agree with the prop's own directional blob shadow.
    //
    // Dominance is weighed on INTENSITY alone, never the flickering level, or
    // the whole mask would re-bake every frame that a dying tube stutters.
    for (const o of rects) {
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      let best: LiveLight | null = null;
      let bestW = 0;
      for (const l of this.lights) {
        if (!l.castShadow) continue;
        const r = l.radius * p.radiusScale * (l.scale ?? 1);
        const d = Math.hypot(cx - l.x, cy - l.y);
        if (d >= r) continue;
        const wgt = (1 - d / r) * l.intensity;
        if (wgt > bestW) {
          bestW = wgt;
          best = l;
        }
      }
      // Same banded taper as the lightmap's shadows, but as opaque greys on a
      // white background rather than additive light: each band is drawn
      // longest-first and painted over by the next shorter, darker one, so
      // overlapping quads overwrite instead of compounding.
      const tmp = new Graphics();
      if (best) {
        const bands = Math.max(2, Math.min(8, Math.round(p.shadowBands)));
        const rad = best.radius * p.radiusScale * (best.scale ?? 1);
        for (let i = 0; i < bands; i++) {
          const band = new Graphics();
          // i = 0 is the longest reach and gets overpainted by every shorter,
          // darker band after it — so `near` runs 0 at the tip to 1 at the
          // caster, and the fill goes white→black along it.
          const frac = 1 - (i / (bands - 1)) * (1 - p.shadowNear);
          const nearness = i / (bands - 1);
          const strength = 1 - p.shadowFade * (1 - nearness);
          const grey = Math.max(0, Math.min(1, 1 - strength));
          // The COLOUR carries the level, not a tint: tinting a black fill
          // leaves it black, since tint multiplies.
          this.buildShadows(best, p, rad, band, reach * frac, [o], scaleColor(0xffffff, grey));
          cam.addChild(band);
        }
      }
      // The prop's own footprint rides in the SAME pass, so it shares the blur
      // below instead of being a separately-drawn hard rectangle sitting under
      // a soft shadow — which is what it looked like when they were two layers.
      if (footprints) {
        tmp.rect(o.x, o.y, o.w, o.h);
        tmp.fill({ color: 0x000000, alpha: 1 });
        cam.addChild(tmp);
      }
    }

    cam.position.set(this.camX, this.camY);
    cam.scale.set(this.camScale);
    root.addChild(bg, cam);
    // Same softness knob as the lightmap's own shadows. Safe to blur here
    // because the WHITE background covers the whole target: pixi's blur clamps
    // at the texture edge, and clamping white is a no-op. (Blurring a tight
    // Graphics instead would smear black out to its bounds — the exact bug that
    // took a bisect to find on the character shadows.)
    if (p.shadowSoftness > 0.05) {
      root.filters = [new BlurFilter({ strength: p.shadowSoftness, quality: 3 })];
      root.filterArea = new Rectangle(0, 0, this.w, this.h);
    }
    this.renderer.render({ container: root, target: this.groundRt, clear: true });
    root.destroy({ children: true });
    return this.groundRt;
  }

  /** The baked AO mask. Dark near occluders, white elsewhere; null until baked. */
  get aoTexture(): RenderTexture | null {
    return this.aoRt;
  }

  /**
   * Screen-space AO for static geometry: occluders drawn black on white, blurred,
   * then multiplied over the finished lightmap. Baked once per geometry change —
   * walls do not move, and this is a full-screen blur.
   */
  private bakeAo(p: LightParams): void {
    if (!this.aoRt) {
      this.aoRt = RenderTexture.create({ width: this.w, height: this.h, antialias: false });
      this.aoRt.source.scaleMode = 'linear';
    }
    const root = new Container();
    const cam = new Container();
    const bg = new Sprite(Texture.WHITE);
    bg.width = this.w;
    bg.height = this.h;
    const g = new Graphics();
    for (const o of this.occluders) g.rect(o.x, o.y, o.w, o.h);
    g.fill({ color: 0x000000, alpha: 1 });
    cam.addChild(g);
    cam.position.set(this.camX, this.camY);
    cam.scale.set(this.camScale);
    root.addChild(bg, cam);
    root.filters = [new BlurFilter({ strength: p.aoRadius, quality: 4 })];
    root.filterArea = new Rectangle(0, 0, this.w, this.h);
    this.renderer.render({ container: root, target: this.aoRt, clear: true });
    root.destroy({ children: true });
  }

  // ------------------------------------------------------------- per frame

  update(t: number, p: LightParams): void {
    const sig = [
      this.geomVersion,
      p.falloff,
      p.radiusScale,
      p.shadowsOn ? 1 : 0,
      p.shadowAlpha,
      p.shadowSoftness,
      p.shadowLength,
      p.shadowBias,
      p.shadowFade,
      p.shadowNear,
      p.shadowBands,
    ].join(',');

    for (const l of this.lights) {
      const s = `${sig}|${l.x.toFixed(1)},${l.y.toFixed(1)},${l.radius},${l.scale ?? 1}`;
      if (l.sig !== s) {
        l.sig = s;
        this.bake(l, p);
      }
      // Fluorescents don't dim smoothly, they stutter — two detuned sines plus a
      // rare hard dropout reads far more like a failing tube than noise does.
      const f = (l.flicker ?? 0) * p.flicker;
      if (f > 0.001) {
        const hz = l.flickerHz ?? 8;
        const a = Math.sin(t * hz + l.phase);
        const b = Math.sin(t * hz * 2.7 + l.phase * 1.7);
        const drop = Math.sin(t * 0.9 + l.phase) > 0.985 ? 0.35 : 1;
        l.level = Math.max(0, (1 - f * 0.45 + f * 0.45 * (a * 0.6 + b * 0.4)) * drop);
      } else {
        l.level = 1;
      }
      l.sprite.tint = l.color;
      l.sprite.alpha = Math.max(0, Math.min(4, l.intensity * l.level * p.gain));
      l.sprite.visible = l.sprite.alpha > 0.002;
    }

    this.ambient.tint = scaleColor(p.ambientColor, p.ambientLevel);
    this.ambient.visible = p.showAmbient;
    this.lightRoot.visible = p.showLights;

    if (p.aoOn) {
      const av = this.geomVersion * 1000 + Math.round(p.aoRadius * 10);
      if (av !== this.aoVersion) {
        this.aoVersion = av;
        this.bakeAo(p);
      }
    }

    this.renderer.render({ container: this.composeRoot, target: this.texture, clear: true });
  }

  /**
   * Which light dominates at a point, and how hard. Drives per-sprite rim light
   * and the direction a prop's shadow falls — one shadow per prop, from the
   * light that actually matters there, is the cheap version of many shadows and
   * reads almost the same at this resolution.
   */
  dominant(x: number, y: number, radiusScale: number): { l: LiveLight; w: number } | null {
    let best: LiveLight | null = null;
    let bestW = 0;
    for (const l of this.lights) {
      const r = l.radius * radiusScale * (l.scale ?? 1);
      const d = Math.hypot(x - l.x, y - l.y);
      if (d >= r) continue;
      const w = (1 - d / r) * l.intensity * l.level;
      if (w > bestW) {
        bestW = w;
        best = l;
      }
    }
    return best ? { l: best, w: bestW } : null;
  }

  /**
   * The strongest lights at a point, best first.
   *
   * One shadow per caster is a lie the eye catches immediately in a room with
   * this many sources: a character standing between two lamps has two shadows,
   * at different angles and different darknesses, and drawing only the stronger
   * one makes the second lamp look like it is not really there.
   */
  contributors(
    x: number,
    y: number,
    radiusScale: number,
    max: number,
  ): Array<{ l: LiveLight; w: number }> {
    const out: Array<{ l: LiveLight; w: number }> = [];
    for (const l of this.lights) {
      const r = l.radius * radiusScale * (l.scale ?? 1);
      const d = Math.hypot(x - l.x, y - l.y);
      if (d >= r) continue;
      const w = (1 - d / r) * l.intensity * l.level;
      if (w > 0.01) out.push({ l, w });
    }
    out.sort((a, b) => b.w - a.w);
    return out.slice(0, max);
  }

  destroy(): void {
    for (const l of this.lights) l.rt.destroy(true);
    this.texture.destroy(true);
    this.aoRt?.destroy(true);
    this.composeRoot.destroy({ children: true });
    this.bakeRoot.destroy({ children: true });
  }
}
