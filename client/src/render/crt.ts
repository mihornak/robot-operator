/**
 * The CRT feed — the AAA look. Filter stack + reactive screen fx:
 * scanline/noise baseline, danger jitter + nervous vignette pulse, degrade
 * flicker, glitch bursts with a torn feed slice, shaped static bursts (camera
 * cuts: flash → full static → dissolve + roll band), boot bloom with settle
 * tearing + brightness overshoot, dead-cam drifting static with "almost
 * signal" dips, idle micro-tears + auto-focus breathe, phosphor glow on the
 * robot. All screen fx live on `fxLayer` (placed above OSD, below overlays).
 */

import {
  Container,
  Graphics,
  Matrix,
  Rectangle,
  RenderTexture,
  Sprite,
  Texture,
  TilingSprite,
} from 'pixi.js';
import type { Renderer } from 'pixi.js';
import { BulgePinchFilter, GlitchFilter } from 'pixi-filters';
import { VIEW_H, VIEW_W } from '@shared/types';
import { makeRng } from '@shared/rng';
import { canvasTex, clamp01, easeOutCubic, glowTex, lerp, lerpColor } from './util';

export interface CrtFrame {
  /** World jitter+shake offset, logical px. */
  ox: number;
  oy: number;
  /** Drop this frame (degrade flicker) — caller skips app.render(). */
  skip: boolean;
  /** World scale (auto-focus breathe) — 1 except during a rare 300ms pulse. */
  zoom: number;
}

const NOISE_SIZE = 1024;
const ROLL_H = 26;
/** Tear band heights: [micro-tear, boot band, damage slice]. Fixed per sprite
 *  so texture frames never resize — only frame.y and sprite x/y move. */
const TEAR_H = [2, 9, 15] as const;
/** Vignette baseline < 1 leaves headroom for the danger pulse (×1.15). */
const VIG_BASE = 0.88;
// boot timeline (s): line expand → blowout overshoot → tear settle → normalize
const BOOT_A = 0.35;
const BOOT_B = 0.5;
const BOOT_C = 0.8;
const BOOT_END = 1.6;

export class CrtStack {
  readonly fxLayer = new Container();

  private bulge: BulgePinchFilter;
  private glitch: GlitchFilter;
  private rng = makeRng(0xc47fee);
  private t = 0;
  private scale = 1;
  private glitchFrames = 0;
  private staticMs = 0;
  private staticDur = 1;
  private flashFrames = 0;
  private dead = false;
  private shakePx = 0;
  private shakeMs = 0;
  private shakeDur = 1;
  private rollWait = 5;
  private rollK = -1; // -1 idle, else 0..1 sweep progress
  private bootT = -1;
  private bootSeedT = 0;
  private bootY = [0, 0, 0];
  private bootDx = [0, 0, 0];
  // feed snapshot for tear bands (attachFeed) — null = tears fail soft to off
  private renderer: Renderer | null = null;
  private feed: Container | null = null;
  private tearRT: RenderTexture | null = null;
  private tearTex: Texture[] = [];
  private tearSp: Sprite[] = [];
  private snapPending = false;
  private readonly ident = new Matrix();
  private sliceFrames = 0;
  private sliceY = 0;
  private sliceDx = 0;
  private microFrames = 0;
  private microWait = 12;
  private microY = 0;
  private microDx = 1;
  private dipMs = 0;
  private breatheT = -1;
  private breatheWait = 34;
  private nerv = 0; // smoothed 0..1 "camera is nervous" level
  private glowOn = false;
  private glowA = 0;
  private deadDrift = 0;
  private deadNY = 0;
  private deadYT = 0;
  private deadSigWait = 3;
  private deadSigMs = 0;
  private readonly out: CrtFrame = { ox: 0, oy: 0, skip: false, zoom: 1 };

  private noiseTex: Texture;
  private noiseSp: Sprite;
  private rollSp: Sprite;
  private cutRollSp: Sprite;
  private bootLine: Graphics;
  private bootGlow: Graphics;
  private flashSp: Graphics;
  private dipSp: Graphics;
  private glowSp: Sprite;
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

    // slow vertical roll: dark band sweeping down every ~7s. cutRollSp shares
    // the texture — it sweeps fast OVER the dissolving static on camera cuts.
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
    this.cutRollSp = new Sprite(rollTex);
    this.cutRollSp.width = VIEW_W;
    this.cutRollSp.height = ROLL_H * 2; // fatter, darker sweep for the cut
    this.cutRollSp.alpha = 0.9;
    this.cutRollSp.visible = false;
    this.fxLayer.addChild(this.cutRollSp);

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
    this.vignette.alpha = VIG_BASE;
    this.fxLayer.addChildAt(this.vignette, 2);

    // phosphor glow: warm additive halo riding the robot — the one bright
    // thing on the feed blooms slightly on the glass. Above vignette (bloom
    // punches through the glass shading), below static (dead cam hides it).
    this.glowSp = new Sprite(glowTex(64, 'rgba(255,196,130,0.85)'));
    this.glowSp.anchor.set(0.5);
    this.glowSp.blendMode = 'add';
    this.glowSp.alpha = 0;
    this.glowSp.visible = false;
    this.fxLayer.addChildAt(this.glowSp, 3);

    // classic CRT power-on: horizontal line expands vertically + bloom flash
    this.bootLine = new Graphics().rect(0, -1, VIEW_W, 2).fill(0xffffff);
    this.bootLine.position.set(0, VIEW_H / 2);
    this.bootLine.blendMode = 'add';
    this.bootLine.visible = false;
    this.bootGlow = new Graphics().rect(0, 0, VIEW_W, VIEW_H).fill(0xf4f7ff);
    this.bootGlow.blendMode = 'add';
    this.bootGlow.visible = false;
    this.fxLayer.addChild(this.bootLine, this.bootGlow);

    // idle brightness dip (rides the micro-tear) + 1-frame cut flash, topmost
    this.dipSp = new Graphics().rect(0, 0, VIEW_W, VIEW_H).fill(0x000000);
    this.dipSp.visible = false;
    this.flashSp = new Graphics().rect(0, 0, VIEW_W, VIEW_H).fill(0xffffff);
    this.flashSp.blendMode = 'add';
    this.flashSp.alpha = 0.55;
    this.flashSp.visible = false;
    this.fxLayer.addChild(this.dipSp, this.flashSp);
  }

  /**
   * Wire the feed snapshot used by tear bands: on tear frames the WORLD (not
   * the OSD — that's burned in by the monitor) is rendered once into a
   * RenderTexture and 1–3 slice sprites show offset bands of it. Never
   * attached → all tears fail soft to off.
   */
  attachFeed(renderer: Renderer, feed: Container): void {
    this.renderer = renderer;
    this.feed = feed;
    this.tearRT = RenderTexture.create({ width: VIEW_W, height: VIEW_H });
    for (const h of TEAR_H) {
      const t = new Texture({
        source: this.tearRT.source,
        frame: new Rectangle(0, 0, VIEW_W, h),
      });
      const sp = new Sprite(t);
      sp.visible = false;
      this.tearTex.push(t);
      this.tearSp.push(sp);
      this.fxLayer.addChildAt(sp, 1); // above grain, below scanlines
    }
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
    this.bootSeedT = 0;
  }

  staticBurst(ms: number): void {
    this.staticMs = Math.max(this.staticMs, ms);
    this.staticDur = this.staticMs;
    this.flashFrames = 1; // 1-frame white pop right at the cut
  }

  glitchFrame(): void {
    this.glitchFrames = 2;
    this.glitch.seed = this.rng() * 1000;
    this.glitch.refresh();
    // one displaced horizontal slice of the feed rides the burst for 2 frames
    this.sliceFrames = 2;
    this.sliceY = 14 + Math.floor(this.rng() * (VIEW_H - 44));
    this.sliceDx = (this.rng() < 0.5 ? -1 : 1) * (4 + this.rng() * 5);
  }

  deadCam(on: boolean): void {
    this.dead = on;
    if (on) {
      this.deadDrift = this.rng() * 300;
      this.deadYT = 0;
      this.deadSigWait = 2 + this.rng() * 2;
      this.deadSigMs = 0;
    }
  }

  shake(px: number, ms: number): void {
    this.shakePx = px;
    this.shakeMs = ms;
    this.shakeDur = Math.max(1, ms);
  }

  /** Robot screen position + liveness for the phosphor glow (render/index). */
  setGlow(x: number, y: number, on: boolean): void {
    this.glowSp.position.set(x, y);
    this.glowOn = on;
  }

  // ------------------------------------------------------------- helpers

  /** Show tear band `i` as the feed slice at `y`, displaced `dx` px. */
  private setBand(i: number, y: number, dx: number): void {
    const t = this.tearTex[i];
    const sp = this.tearSp[i];
    if (!t || !sp) return;
    const cy = Math.max(0, Math.min(Math.floor(y), VIEW_H - TEAR_H[i]!));
    t.frame.y = cy;
    t.updateUvs();
    sp.y = cy;
    sp.x = dx;
    sp.visible = true;
    this.snapPending = true;
  }

  private snapFeed(): void {
    if (!this.renderer || !this.feed || !this.tearRT) return;
    // identity transform: ignore the world's jitter/breathe for the snapshot
    this.renderer.render({
      container: this.feed,
      target: this.tearRT,
      clear: true,
      transform: this.ident,
    });
  }

  // ------------------------------------------------------------- per frame

  update(dt: number, danger: number, degrade: number): CrtFrame {
    const rng = this.rng;
    this.t += dt;

    // nervous camera: smoothed pulse level, engages above danger 0.4
    const nervTarget = danger > 0.4 ? clamp01((danger - 0.4) / 0.35) : 0;
    this.nerv = lerp(this.nerv, nervTarget, Math.min(1, dt * 2.5));

    // baseline animation + reactive feed
    this.grain.tilePosition.set(Math.floor(rng() * 900), Math.floor(rng() * 900));
    this.grain.alpha = clamp01(0.045 + danger * 0.05 + degrade * 0.16 + this.nerv * 0.02);
    this.scanlines.alpha = 0.85 + degrade * 0.15;
    // scanlines drift down one sub-pixel per second — sells the refresh
    this.scanlines.tilePosition.y = (this.t * 3) % 3;

    // vignette breathes 1.0→1.15× at 1.2Hz when the camera is nervous —
    // a slow worried pulse, never a flash
    const puls = 0.5 * (1 + Math.sin(this.t * (Math.PI * 2 * 1.2)));
    this.vignette.alpha = Math.min(1, VIG_BASE * (1 + 0.15 * this.nerv * puls));

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

    // tear bands: hidden by default, each effect below re-shows what it needs
    for (const sp of this.tearSp) sp.visible = false;

    // static overlay: shaped burst (camera cut) or dead cam loop
    if (this.staticMs > 0) this.staticMs -= dt * 1000;
    const showStatic = this.staticMs > 0 || this.dead;
    this.noiseSp.visible = showStatic;
    let cutRollOn = false;
    if (this.dead) {
      // dead cam: static drifts slowly sideways — the monitor hunting for a
      // feed — with occasional half-second "almost-signal" darkenings
      this.deadDrift += dt * 24;
      this.deadYT -= dt;
      if (this.deadYT <= 0) {
        this.deadNY = Math.floor(rng() * (NOISE_SIZE - VIEW_H));
        this.deadYT = 0.35 + rng() * 0.4;
      }
      this.noiseTex.frame.x = Math.floor(this.deadDrift) % (NOISE_SIZE - VIEW_W);
      this.noiseTex.frame.y = this.deadNY;
      this.noiseTex.updateUvs();
      this.noiseSp.scale.x = 1;
      this.noiseSp.x = 0;
      this.deadSigWait -= dt;
      if (this.deadSigWait <= 0 && this.deadSigMs <= 0) {
        this.deadSigMs = 500;
        this.deadSigWait = 2.6 + rng() * 3.5;
      }
      let sig = 0;
      if (this.deadSigMs > 0) {
        this.deadSigMs -= dt * 1000;
        sig = Math.sin(Math.PI * clamp01(1 - this.deadSigMs / 500));
      }
      const pump = lerpColor(0xa9adb6, 0xf2f4fa, 0.5 + 0.5 * Math.sin(this.t * 2.6));
      this.noiseSp.tint = lerpColor(pump, 0x2f333b, sig * 0.8);
      this.noiseSp.alpha = 1 - sig * 0.22;
    } else if (showStatic) {
      // camera cut, shaped: ~80ms full blast, then static dissolves while one
      // dark roll band sweeps the frame, then clean
      this.noiseTex.frame.x = Math.floor(rng() * (NOISE_SIZE - VIEW_W));
      this.noiseTex.frame.y = Math.floor(rng() * (NOISE_SIZE - VIEW_H));
      this.noiseTex.updateUvs();
      this.noiseSp.scale.x = rng() < 0.5 ? 1 : -1;
      this.noiseSp.x = this.noiseSp.scale.x < 0 ? VIEW_W : 0;
      this.noiseSp.tint = 0xffffff;
      const elapsed = this.staticDur - this.staticMs;
      const dissolve = Math.min(180, this.staticDur * 0.6);
      const full = this.staticDur - dissolve;
      if (elapsed <= full) {
        this.noiseSp.alpha = 1;
      } else {
        const k = clamp01((elapsed - full) / dissolve);
        this.noiseSp.alpha = 1 - k * k;
        cutRollOn = true;
        this.cutRollSp.y = -ROLL_H * 2 + k * (VIEW_H + 4 * ROLL_H);
      }
    }
    this.cutRollSp.visible = cutRollOn;

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

    // boot: line expand → blowout overshoot → 300ms of tearing settling into
    // the feed → brightness normalizes. ~1.6s total.
    if (this.bootT >= 0) {
      this.bootT += dt;
      const T = this.bootT;
      if (T < BOOT_A) {
        const k = easeOutCubic(T / BOOT_A);
        this.bootLine.visible = true;
        this.bootLine.alpha = 1;
        this.bootLine.scale.y = 1 + k * (VIEW_H / 2 - 1);
        this.bootGlow.visible = true;
        this.bootGlow.alpha = 0.3 * k;
      } else if (T < BOOT_B) {
        // brightness overshoot: the tube blows out white as the line dies
        const k = (T - BOOT_A) / (BOOT_B - BOOT_A);
        this.bootLine.scale.y = VIEW_H / 2;
        this.bootLine.alpha = Math.max(0, 1 - k * 1.4);
        this.bootLine.visible = this.bootLine.alpha > 0.01;
        this.bootGlow.alpha = 0.3 + 0.55 * k;
      } else if (T < BOOT_C) {
        // horizontal tearing: 3 offset slice bands, amplitude settling to 0
        this.bootLine.visible = false;
        const k = (T - BOOT_B) / (BOOT_C - BOOT_B);
        this.bootGlow.alpha = 0.14 + 0.71 * (1 - k) ** 1.6;
        this.bootSeedT -= dt;
        if (this.bootSeedT <= 0) {
          this.bootSeedT = 0.045;
          const amp = lerp(11, 2, k);
          for (let i = 0; i < 3; i++) {
            this.bootY[i] = rng() * VIEW_H;
            this.bootDx[i] = (rng() * 2 - 1) * amp;
          }
        }
        for (let i = 0; i < 3; i++) this.setBand(i, this.bootY[i]!, this.bootDx[i]!);
      } else if (T < BOOT_END) {
        // normalize: overshoot bleeds off with a faint flicker wobble
        const k = (T - BOOT_C) / (BOOT_END - BOOT_C);
        this.bootGlow.alpha = Math.max(0, 0.14 * (1 - k) ** 1.3 + 0.015 * Math.sin(T * 43) * (1 - k));
      } else {
        this.bootLine.visible = false;
        this.bootGlow.visible = false;
        this.bootT = -1;
      }
    }

    // damage: one displaced feed slice synced with the GlitchFilter burst
    if (this.sliceFrames > 0) {
      this.sliceFrames--;
      this.setBand(2, this.sliceY, this.sliceDx);
    }

    // idle life: every ~20s a single-frame 1px micro-tear + tiny brightness
    // dip; every ~45s the lens "breathes" — a 300ms 0.5% focus pulse
    this.microWait -= dt;
    if (this.microWait <= 0 && !showStatic && this.bootT < 0) {
      this.microWait = 14 + rng() * 13;
      this.microFrames = 1;
      this.microY = rng() * (VIEW_H - 4);
      this.microDx = rng() < 0.5 ? -1 : 1;
      this.dipMs = 110;
    }
    if (this.microFrames > 0) {
      this.microFrames--;
      this.setBand(0, this.microY, this.microDx);
    }
    if (this.dipMs > 0) {
      this.dipMs -= dt * 1000;
      this.dipSp.visible = true;
      this.dipSp.alpha = 0.07 * clamp01(this.dipMs / 110);
    } else {
      this.dipSp.visible = false;
    }

    let zoom = 1;
    this.breatheWait -= dt;
    if (this.breatheT < 0 && this.breatheWait <= 0 && !showStatic && this.bootT < 0) {
      this.breatheT = 0;
      this.breatheWait = 38 + rng() * 26;
    }
    if (this.breatheT >= 0) {
      this.breatheT += dt;
      const k = this.breatheT / 0.3;
      if (k >= 1) this.breatheT = -1;
      else zoom = 1 + 0.005 * Math.sin(Math.PI * k);
    }

    // one snapshot serves every band shown this frame
    if (this.snapPending) {
      this.snapPending = false;
      this.snapFeed();
    }

    // phosphor glow eases in/out with robot liveness, tiny warm shimmer
    this.glowA = lerp(this.glowA, this.glowOn ? 1 : 0, Math.min(1, dt * 6));
    const g = this.glowA * (0.06 + 0.008 * Math.sin(this.t * 5.3));
    this.glowSp.alpha = g;
    this.glowSp.visible = g > 0.004;

    // 1-frame white pop at a camera cut, above everything
    this.flashSp.visible = this.flashFrames > 0;
    if (this.flashFrames > 0) this.flashFrames--;

    // rare dropped-frame flicker at high degrade
    const skip = !this.dead && degrade > 0.55 && rng() < (degrade - 0.55) * 0.09;
    const out = this.out;
    out.ox = ox;
    out.oy = oy;
    out.skip = skip;
    out.zoom = zoom;
    return out;
  }
}
