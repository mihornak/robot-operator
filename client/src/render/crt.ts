/**
 * The CRT feed — the AAA look. Filter stack + reactive screen fx:
 * scanline/noise baseline, danger jitter, degrade flicker, glitch bursts,
 * static bursts (camera cuts), boot bloom, dead-cam static, roll band, shake.
 * All screen fx live on `fxLayer` (placed above OSD, below overlays).
 */

import { Container, Graphics, Rectangle, Sprite, Texture, TilingSprite } from 'pixi.js';
import { BulgePinchFilter, GlitchFilter } from 'pixi-filters';
import { VIEW_H, VIEW_W } from '@shared/types';
import { makeRng } from '@shared/rng';
import { canvasTex, clamp01, easeOutCubic, lerp, lerpColor } from './util';

export interface CrtFrame {
  /** World jitter+shake offset, logical px. */
  ox: number;
  oy: number;
  /** Drop this frame (degrade flicker) — caller skips app.render(). */
  skip: boolean;
}

const NOISE_SIZE = 1024;
const ROLL_H = 26;

export class CrtStack {
  readonly fxLayer = new Container();

  private bulge: BulgePinchFilter;
  private glitch: GlitchFilter;
  private rng = makeRng(0xc47fee);
  private t = 0;
  private scale = 1;
  private glitchFrames = 0;
  private staticMs = 0;
  private dead = false;
  private shakePx = 0;
  private shakeMs = 0;
  private shakeDur = 1;
  private rollWait = 5;
  private rollK = -1; // -1 idle, else 0..1 sweep progress
  private bootT = -1;

  private noiseTex: Texture;
  private noiseSp: Sprite;
  private rollSp: Sprite;
  private bootLine: Graphics;
  private bootGlow: Graphics;
  private grain: TilingSprite;
  private scanlines: TilingSprite;
  private vignette: Sprite;

  constructor(private target: Container) {
    // CRTFilter is BANNED here: its shader samples outside the filter texture
    // (garbage triangles/wedges). Scanlines/noise/vignette are plain sprites —
    // fully controllable, artifact-free. BulgePinch supplies the barrel warp.
    this.bulge = new BulgePinchFilter({ center: { x: 0.5, y: 0.5 }, radius: 400, strength: 0.055 });
    this.glitch = new GlitchFilter({ slices: 6, offset: 6, fillMode: 2, average: false });
    target.filters = [this.bulge];

    // full-screen white-noise overlay; frame rect is re-randomized per tick
    const base = canvasTex(NOISE_SIZE, NOISE_SIZE, (ctx) => {
      const img = ctx.createImageData(NOISE_SIZE, NOISE_SIZE);
      const d = img.data;
      const nrng = makeRng(0x570a71c);
      for (let i = 0; i < d.length; i += 4) {
        const v = 40 + Math.floor(nrng() * 215);
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v + 6;
        d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
    this.noiseTex = new Texture({ source: base.source, frame: new Rectangle(0, 0, VIEW_W, VIEW_H) });
    this.noiseSp = new Sprite(this.noiseTex);
    this.noiseSp.visible = false;
    this.fxLayer.addChild(this.noiseSp);

    // slow vertical roll: dark band sweeping down every ~7s
    const rollTex = canvasTex(1, ROLL_H, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, ROLL_H);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.4)');
      g.addColorStop(0.92, 'rgba(0,0,0,0.1)');
      g.addColorStop(0.96, 'rgba(255,255,255,0.07)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1, ROLL_H);
    });
    rollTex.source.scaleMode = 'linear';
    this.rollSp = new Sprite(rollTex);
    this.rollSp.width = VIEW_W;
    this.rollSp.height = ROLL_H;
    this.rollSp.visible = false;
    this.fxLayer.addChild(this.rollSp);

    // film grain: subtle additive noise, tile offset re-randomized per frame
    this.grain = new TilingSprite({ texture: base, width: VIEW_W, height: VIEW_H });
    this.grain.blendMode = 'add';
    this.grain.alpha = 0.045;
    this.fxLayer.addChildAt(this.grain, 0);

    // scanlines: 1×3 dark-line pattern over the whole feed
    const lineTex = canvasTex(2, 3, (ctx) => {
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.fillRect(0, 0, 2, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(0, 1, 2, 1);
    });
    this.scanlines = new TilingSprite({ texture: lineTex, width: VIEW_W, height: VIEW_H });
    this.scanlines.alpha = 0.85;
    this.fxLayer.addChildAt(this.scanlines, 1);

    // vignette: radial gradient, dark curved-glass corners
    const vigTex = canvasTex(VIEW_W, VIEW_H, (ctx) => {
      const g = ctx.createRadialGradient(
        VIEW_W / 2,
        VIEW_H / 2,
        VIEW_H * 0.42,
        VIEW_W / 2,
        VIEW_H / 2,
        VIEW_W * 0.62,
      );
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.65, 'rgba(0,0,0,0.28)');
      g.addColorStop(1, 'rgba(0,0,0,0.62)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    });
    vigTex.source.scaleMode = 'linear';
    this.vignette = new Sprite(vigTex);
    this.fxLayer.addChildAt(this.vignette, 2);

    // classic CRT power-on: horizontal line expands vertically + bloom flash
    this.bootLine = new Graphics().rect(0, -1, VIEW_W, 2).fill(0xffffff);
    this.bootLine.position.set(0, VIEW_H / 2);
    this.bootLine.blendMode = 'add';
    this.bootLine.visible = false;
    this.bootGlow = new Graphics().rect(0, 0, VIEW_W, VIEW_H).fill(0xf4f7ff);
    this.bootGlow.blendMode = 'add';
    this.bootGlow.visible = false;
    this.fxLayer.addChild(this.bootLine, this.bootGlow);
  }

  /** Integer zoom factor changed — filters capture screen-space bounds, so
   *  px-unit params scale with s. NEVER set filter.resolution: with the pinned
   *  filterArea it breaks the filter quad (garbage triangle artifacts). */
  setScale(s: number): void {
    this.scale = s;
    this.bulge.center = { x: 0.5, y: 0.5 };
    this.bulge.radius = 340 * s;
    this.glitch.red = { x: s, y: 0 };
    this.glitch.blue = { x: -s, y: 0 };
    this.glitch.offset = 4 * s;
  }

  // ------------------------------------------------------------- RenderFx

  bootFlash(): void {
    this.bootT = 0;
  }

  staticBurst(ms: number): void {
    this.staticMs = Math.max(this.staticMs, ms);
  }

  glitchFrame(): void {
    this.glitchFrames = 2;
    this.glitch.seed = this.rng() * 1000;
    this.glitch.refresh();
  }

  deadCam(on: boolean): void {
    this.dead = on;
  }

  shake(px: number, ms: number): void {
    this.shakePx = px;
    this.shakeMs = ms;
    this.shakeDur = Math.max(1, ms);
  }

  // ------------------------------------------------------------- per frame

  update(dt: number, danger: number, degrade: number): CrtFrame {
    const rng = this.rng;
    this.t += dt;

    // baseline animation + reactive feed
    this.grain.tilePosition.set(Math.floor(rng() * 900), Math.floor(rng() * 900));
    this.grain.alpha = clamp01(0.045 + danger * 0.05 + degrade * 0.16);
    this.scanlines.alpha = 0.85 + degrade * 0.15;
    // scanlines drift down one sub-pixel per second — sells the refresh
    this.scanlines.tilePosition.y = (this.t * 3) % 3;

    // danger jitter: tiny world offset, applied only on some frames
    let ox = 0;
    let oy = 0;
    if (rng() < 0.12 + 0.55 * danger) {
      const amp = lerp(1, 2.5, clamp01(danger));
      ox += (rng() * 2 - 1) * amp;
      oy += (rng() * 2 - 1) * amp * 0.5;
    }

    if (this.shakeMs > 0) {
      this.shakeMs -= dt * 1000;
      const k = this.shakePx * Math.max(0, this.shakeMs / this.shakeDur);
      ox += (rng() * 2 - 1) * k;
      oy += (rng() * 2 - 1) * k;
    }

    // transient glitch burst
    if (this.glitchFrames > 0) {
      this.glitchFrames--;
      if (this.target.filters !== null && (this.target.filters as unknown[]).length !== 2) {
        this.target.filters = [this.glitch, this.bulge];
      }
    } else if (this.target.filters !== null && (this.target.filters as unknown[]).length !== 1) {
      this.target.filters = [this.bulge];
    }

    // static overlay: burst (camera cut) or dead cam loop
    if (this.staticMs > 0) this.staticMs -= dt * 1000;
    const showStatic = this.staticMs > 0 || this.dead;
    this.noiseSp.visible = showStatic;
    if (showStatic) {
      this.noiseTex.frame.x = Math.floor(rng() * (NOISE_SIZE - VIEW_W));
      this.noiseTex.frame.y = Math.floor(rng() * (NOISE_SIZE - VIEW_H));
      this.noiseTex.updateUvs();
      this.noiseSp.scale.x = rng() < 0.5 ? 1 : -1;
      this.noiseSp.x = this.noiseSp.scale.x < 0 ? VIEW_W : 0;
      // dead cam pumps brightness slowly; bursts are full blast
      this.noiseSp.tint = this.dead
        ? lerpColor(0xa9adb6, 0xf2f4fa, 0.5 + 0.5 * Math.sin(this.t * 2.6))
        : 0xffffff;
    }

    // periodic slow vertical roll
    if (this.rollK < 0) {
      this.rollWait -= dt;
      if (this.rollWait <= 0) {
        this.rollK = 0;
        this.rollWait = 6 + rng() * 3;
      }
    } else {
      this.rollK += dt / 1.15;
      this.rollSp.y = -ROLL_H + this.rollK * (VIEW_H + 2 * ROLL_H);
      if (this.rollK >= 1) this.rollK = -1;
    }
    this.rollSp.visible = this.rollK >= 0 && !showStatic;

    // boot bloom
    if (this.bootT >= 0) {
      this.bootT += dt;
      const T = this.bootT;
      if (T < 0.3) {
        const k = easeOutCubic(T / 0.3);
        this.bootLine.visible = true;
        this.bootLine.alpha = 1;
        this.bootLine.scale.y = 1 + k * (VIEW_H / 2 - 1);
        this.bootGlow.visible = true;
        this.bootGlow.alpha = 0.3 * k;
      } else if (T < 0.75) {
        const k = (T - 0.3) / 0.45;
        this.bootLine.alpha = Math.max(0, 1 - k * 2.5);
        this.bootLine.visible = this.bootLine.alpha > 0.01;
        this.bootGlow.alpha = 0.85 * (1 - k) ** 1.5;
      } else {
        this.bootLine.visible = false;
        this.bootGlow.visible = false;
        this.bootT = -1;
      }
    }

    // rare dropped-frame flicker at high degrade
    const skip = !this.dead && degrade > 0.55 && rng() < (degrade - 0.55) * 0.09;
    return { ox, oy, skip };
  }
}
