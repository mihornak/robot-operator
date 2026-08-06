/** Tiny pooled particle system for world FX (sparks, smoke, booms, flying parts). */

import { Container, Sprite, Texture } from 'pixi.js';
import type { ArtAtlas } from '@shared/types';
import { makeRng } from '@shared/rng';
import { frames, glowTex, tex } from './util';

interface Particle {
  sp: Sprite;
  tex: Texture[];
  fps: number;
  life: number;
  age: number;
  vx: number;
  vy: number;
  grav: number;
  spin: number;
  fade: boolean;
  fadePow: number;
  loop: boolean;
  baseAlpha: number;
}

/** A spawn owed to a later frame — see FxSystem.after(). */
interface Delayed {
  t: number;
  run: () => void;
}

interface SpawnOpts {
  x: number;
  y: number;
  tex: Texture[];
  fps?: number;
  life?: number;
  vx?: number;
  vy?: number;
  grav?: number;
  spin?: number;
  fade?: boolean;
  /** Fade curve exponent. 1 = linear (smoke); >1 snaps dark fast (light). */
  fadePow?: number;
  loop?: boolean;
  tint?: number;
  scale?: number;
  alpha?: number;
  blend?: 'normal' | 'add';
}

export class FxSystem {
  readonly container = new Container();
  private pool: Sprite[] = [];
  private live: Particle[] = [];
  private pending: Delayed[] = [];
  private rng = makeRng(0x5eedf1);
  /** Warm-white bloom for detonation light. Same code-drawn radial gradient the
   *  world uses for its crate/elevator pools — an explosion has to LIGHT the
   *  room, or it reads as a sticker pasted over a dark one. */
  private flashTex = glowTex(64, 'rgba(230,236,244,0.95)');

  constructor(private art: ArtAtlas) {}

  spawn(o: SpawnOpts): void {
    const sp = this.pool.pop() ?? new Sprite();
    sp.anchor.set(0.5);
    sp.texture = o.tex[0]!;
    sp.position.set(o.x, o.y);
    sp.rotation = 0;
    sp.scale.set(o.scale ?? 1);
    sp.tint = o.tint ?? 0xffffff;
    sp.alpha = o.alpha ?? 1;
    sp.blendMode = o.blend ?? 'normal';
    sp.visible = true;
    if (!sp.parent) this.container.addChild(sp);
    const fps = o.fps ?? 12;
    this.live.push({
      sp,
      tex: o.tex,
      fps,
      life: o.life ?? o.tex.length / fps,
      age: 0,
      vx: o.vx ?? 0,
      vy: o.vy ?? 0,
      grav: o.grav ?? 0,
      spin: o.spin ?? 0,
      fade: o.fade ?? false,
      fadePow: o.fadePow ?? 1,
      loop: o.loop ?? false,
      baseAlpha: o.alpha ?? 1,
    });
  }

  /**
   * Owe a spawn to a later frame. Same frame-driven stagger robot.ts uses for
   * its damage theatre (flash now, part at +70ms, sparks at +120ms) — never
   * setTimeout, so secondaries ride the render clock: a backgrounded tab can't
   * dump a boss's whole death into one frame, and clear() drops what is owed
   * instead of firing it into a floor that no longer exists.
   */
  private after(ms: number, run: () => void): void {
    this.pending.push({ t: ms / 1000, run });
  }

  /** Recycle every live particle (floor rebuild — old-floor fx must not linger). */
  clear(): void {
    for (const p of this.live) {
      p.sp.visible = false;
      this.pool.push(p.sp);
    }
    this.live.length = 0;
    this.pending.length = 0;
  }

  update(dt: number): void {
    // Owed spawns first, so a secondary that comes due this frame gets its full
    // first frame of animation rather than starting one tick stale. Iterating
    // downward is what makes it safe for run() to schedule further spawns.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const d = this.pending[i]!;
      d.t -= dt;
      if (d.t <= 0) {
        this.pending.splice(i, 1);
        d.run();
      }
    }
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i]!;
      p.age += dt;
      if (p.age >= p.life) {
        p.sp.visible = false;
        this.pool.push(p.sp);
        this.live.splice(i, 1);
        continue;
      }
      p.vy += p.grav * dt;
      p.sp.x += p.vx * dt;
      p.sp.y += p.vy * dt;
      p.sp.rotation += p.spin * dt;
      const f = p.age * p.fps;
      const idx = p.loop ? Math.floor(f) % p.tex.length : Math.min(p.tex.length - 1, Math.floor(f));
      p.sp.texture = p.tex[idx]!;
      if (p.fade) p.sp.alpha = p.baseAlpha * (1 - p.age / p.life) ** p.fadePow;
    }
  }

  // ------------------------------------------------------------- presets

  spark(x: number, y: number, n = 4): void {
    const t = frames(this.art, 'fx_spark');
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2;
      const s = 25 + this.rng() * 45;
      this.spawn({
        x, y,
        tex: t,
        fps: 14,
        life: 0.25 + this.rng() * 0.15,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 15,
        grav: 90,
        fade: true,
        blend: 'add',
      });
    }
  }

  smoke(x: number, y: number, scale = 1): void {
    this.spawn({
      x: x + (this.rng() - 0.5) * 4,
      y,
      tex: frames(this.art, 'fx_smoke'),
      fps: 6,
      vy: -9,
      fade: true,
      scale,
      alpha: 0.8,
    });
  }

  dust(x: number, y: number): void {
    this.spawn({
      x, y,
      tex: frames(this.art, 'fx_smoke'),
      fps: 10,
      vy: -4,
      fade: true,
      scale: 0.55,
      alpha: 0.45,
    });
  }

  muzzle(x: number, y: number, rad: number): void {
    this.spawn({
      x: x + Math.cos(rad) * 11,
      y: y + Math.sin(rad) * 11,
      tex: frames(this.art, 'fx_muzzle'),
      fps: 22,
      blend: 'add',
    });
  }

  boom(x: number, y: number): void {
    this.spawn({ x, y, tex: frames(this.art, 'fx_boom'), fps: 14 });
    this.smoke(x, y - 3, 1.2);
  }

  /** Scrap-pickup glint: sparkle floats up and fades. */
  glint(x: number, y: number): void {
    this.spawn({
      x,
      y: y - 4,
      tex: frames(this.art, 'fx_spark'),
      fps: 8,
      life: 0.55,
      vy: -22,
      fade: true,
      loop: true,
      blend: 'add',
    });
  }

  /** Broken-off part flying with a gravity-ish arc (robot damage, enemy death). */
  part(x: number, y: number, texture: Texture, tint = 0xffffff): void {
    this.spawn({
      x, y,
      tex: [texture],
      life: 0.9,
      vx: (this.rng() - 0.5) * 70,
      vy: -60 - this.rng() * 40,
      grav: 240,
      spin: (this.rng() - 0.5) * 14,
      fade: true,
      tint,
    });
  }

  // ------------------------------------------------------- explosion ladder
  //
  // Three named tiers, because the one thing that ruins an escalation is a
  // caller reaching for the wrong size. `boom` stays the small one (add
  // deaths); these are impact / detonation / boss death and nothing else.
  //
  // THE SHREDDER's ordnance is compacted bales of shredded documents, so every
  // tier below is grey-white and black. Impact comes from scale, light, shake
  // and the pause afterwards — never from hue. Nothing here is fire-coloured,
  // so the robot's orange stays the eye's anchor in exactly the frames where
  // everything is coming apart.

  /**
   * Detonation light. A pooled additive bloom at full alpha for one frame, then
   * a squared decay so it snaps dark instead of dissolving. This is what makes
   * an explosion happen INSIDE a dark room rather than on top of one — the
   * sprite is the event, this is the room reacting to it.
   */
  flashPool(x: number, y: number, radius: number, ms: number): void {
    this.spawn({
      x, y,
      tex: [this.flashTex],
      life: ms / 1000,
      scale: radius / 32, // glowTex is 64px across
      fade: true,
      fadePow: 2.2,
      blend: 'add',
    });
  }

  /** The ground ring. Flat and wide, read in the game's 45° projection, sat a
   *  few px below the burst so the blast touches the floor. */
  private shock(x: number, y: number, scale = 1): void {
    this.spawn({
      x,
      y: y + 4,
      tex: frames(this.art, 'fx_shock'),
      fps: 15,
      fade: true,
      fadePow: 1.6,
      alpha: 0.9,
      scale,
      blend: 'add',
    });
  }

  /** Hull scrap and paper wads, tinted to the greys world.ts already uses on
   *  enemy_death so every tier of explosion sheds the same material. */
  private debris(x: number, y: number, i: number): void {
    const paper = i % 2 === 1;
    this.part(x, y, tex(this.art, paper ? 'paper' : 'part_plate'), paper ? 0x8a8d90 : 0x6a6f76);
  }

  /**
   * Shredded-document confetti. Low gravity and a long life on purpose: the
   * scraps are still coming down after the smoke has gone. That lag is the
   * whole tell of a paper detonation — heavy debris drops, documents linger —
   * and it is also what keeps the screen busy through the quiet beat after a
   * big hit.
   */
  private confetti(x: number, y: number, n: number): void {
    const t = frames(this.art, 'paper');
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2;
      const s = 28 + this.rng() * 72;
      this.spawn({
        x: x + (this.rng() - 0.5) * 6,
        y: y - 4,
        tex: t,
        fps: 5 + this.rng() * 7,
        loop: true, // it tumbles the whole way down
        life: 1.1 + this.rng() * 1.0,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s * 0.55 - 46,
        grav: 52,
        spin: (this.rng() - 0.5) * 9,
        fade: true,
        fadePow: 0.5, // stays legible almost to the end, then goes
        scale: 0.5 + this.rng() * 0.5,
        tint: 0x9aa0a6,
      });
    }
  }

  /** Tier 1 — rocket impact. Reads as "something hit HERE", not "the room ended". */
  burstSmall(x: number, y: number): void {
    this.spawn({
      x, y,
      tex: frames(this.art, 'fx_burst'),
      fps: 16,
      life: 0.55, // outlives its 6 frames so the paper-fall frame holds
      scale: 0.7,
    });
    this.flashPool(x, y, 30, 120);
    this.spark(x, y, 6);
    for (let i = 0; i < 2; i++) this.debris(x, y - 3, i);
    this.smoke(x, y - 4, 1.0);
  }

  /** Tier 2 — mortar detonation. Full-size burst, a ring on the floor, and the
   *  first appearance of the confetti: this is where the boss's ammunition
   *  becomes legible as PAPER. */
  burstMed(x: number, y: number): void {
    this.spawn({
      x, y,
      tex: frames(this.art, 'fx_burst'),
      fps: 14,
      life: 0.75,
    });
    this.shock(x, y);
    this.flashPool(x, y, 56, 190);
    this.spark(x, y, 10);
    for (let i = 0; i < 3; i++) this.debris(x, y - 4, i);
    this.smoke(x - 3, y - 5, 1.35);
    this.smoke(x + 4, y - 9, 1.1);
    this.confetti(x, y, 9);
  }

  /** Tier 3 — boss death, and nothing else ever. The blast is 72px (four and a
   *  half tiles) and the secondaries keep going off for another half second, so
   *  the kill lands as a sequence rather than a single pop. */
  burstHuge(x: number, y: number): void {
    this.spawn({
      x, y,
      tex: frames(this.art, 'fx_blast'),
      fps: 10,
      life: 1.5, // holds on the final paper-snow frame long after the smoke
    });
    this.shock(x, y, 1.35);
    this.flashPool(x, y, 118, 260);
    this.spark(x, y, 24);
    for (let i = 0; i < 10; i++) this.debris(x, y - 6, i);
    this.smoke(x - 6, y - 6, 1.6);
    this.smoke(x + 7, y - 11, 1.4);
    this.smoke(x, y - 16, 1.2);
    this.confetti(x, y, 22);

    // Secondaries walk outward and off-centre — a machine coming apart one
    // compartment at a time, not one explosion stuttering.
    const ANG = [0.6, 3.4, 1.9];
    [120, 260, 420].forEach((ms, i) => {
      const d = 12 + i * 7;
      const sx = x + Math.cos(ANG[i]!) * d;
      const sy = y + Math.sin(ANG[i]!) * d * 0.6 - i * 3;
      this.after(ms, () => {
        this.spawn({
          x: sx, y: sy,
          tex: frames(this.art, 'fx_burst'),
          fps: 15,
          life: 0.6,
          scale: 0.85 - i * 0.12,
        });
        this.flashPool(sx, sy, 44 - i * 8, 150);
        this.spark(sx, sy, 6);
        this.confetti(sx, sy, 5);
        this.smoke(sx, sy - 5, 1.1);
      });
    });
  }
}
