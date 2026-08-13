/**
 * Bolts and paper in flight. Pooled by sim id, interpolated between ticks.
 *
 * Its own layer because both render paths need exactly this and nothing around
 * it: on a lit floor the sprites go ABOVE the lightmap multiply (a bolt is a
 * light source, not a surface), on a classic floor they sit over the tilemap.
 */

import { Container, Sprite } from 'pixi.js';
import type { ArtAtlas, SimState } from '@shared/types';
import { frames, hashStr, Interp, tex } from './util';

interface ProjView {
  sp: Sprite;
  interp: Interp;
  phase: number;
  seen: boolean;
}

export class ProjectileLayer {
  readonly container = new Container();
  private views = new Map<string, ProjView>();

  constructor(private art: ArtAtlas) {}

  clear(): void {
    for (const p of this.views.values()) p.sp.destroy();
    this.views.clear();
  }

  update(sim: SimState, alpha: number, t: number): void {
    for (const p of this.views.values()) p.seen = false;
    for (const pr of sim.projectiles) {
      const name = pr.kind === 'bolt' ? 'bolt' : 'paper';
      let p = this.views.get(pr.id);
      if (!p) {
        const sp = new Sprite(tex(this.art, name));
        sp.anchor.set(0.5);
        this.container.addChild(sp);
        p = { sp, interp: new Interp(), phase: hashStr(pr.id) % 100, seen: true };
        this.views.set(pr.id, p);
      }
      p.seen = true;
      p.interp.push(sim.tick, pr.pos.x, pr.pos.y);
      p.sp.position.set(p.interp.x(alpha), p.interp.y(alpha));
      const fs = frames(this.art, name);
      p.sp.texture = fs[Math.floor(t * (pr.kind === 'bolt' ? 20 : 12) + p.phase) % fs.length]!;
      p.sp.rotation =
        pr.kind === 'bolt' ? Math.atan2(pr.vel.y, pr.vel.x) : t * 9 + p.phase;
    }
    for (const [id, p] of this.views) {
      if (!p.seen) {
        p.sp.destroy();
        this.views.delete(id);
      }
    }
  }
}
