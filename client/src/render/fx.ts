/** Tiny pooled particle system for world FX (sparks, smoke, booms, flying parts). */

import { Container, Sprite, Texture } from 'pixi.js';
import type { ArtAtlas } from '@shared/types';
import { makeRng } from '@shared/rng';
import { frames } from './util';

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
  loop: boolean;
  baseAlpha: number;
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
  private rng = makeRng(0x5eedf1);

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
      loop: o.loop ?? false,
      baseAlpha: o.alpha ?? 1,
    });
  }

  update(dt: number): void {
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
      if (p.fade) p.sp.alpha = p.baseAlpha * (1 - p.age / p.life);
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
}
