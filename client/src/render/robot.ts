/**
 * The robot — wheels + body + 8-dir head, the only saturated thing on screen.
 * Data-driven micro-tweens: bob, tread roll, bump squash, sulk hop, flee lean,
 * damage parts, powerdown slump.
 */

import { Container, Sprite, type Texture } from 'pixi.js';
import type { ArtAtlas, RobotState, UiState } from '@shared/types';
import { makeRng } from '@shared/rng';
import type { FxSystem } from './fx';
import { frames, Interp, lerp, tex } from './util';

/** robot_head frame order E,SE,S,SW,W,NW,N,NE (screen y-down: +45° = SE). */
const HEAD_E = 0;
const HEAD_S = 2;
const HEAD_W = 4;

function headIndex(rad: number): number {
  return ((Math.round(rad / (Math.PI / 4)) % 8) + 8) % 8;
}

export class RobotView {
  readonly container = new Container();
  private wheels: Sprite;
  private body: Sprite;
  private head: Sprite;
  private fuseSp: Sprite;
  private headTex: Texture[];
  private wheelTex: Texture[];
  private bodyTex: Texture[];

  private interp = new Interp();
  private rng = makeRng(0x0b07);
  private t = 0;
  private wheelPhase = 0;
  private squash = 0; // 1 → fresh bump, decays
  private recoilX = 0;
  private recoilY = 0;
  private hop = 0;
  private flashMs = 0;
  private deathT = -1;
  private smokeT = 0;
  private partToggle = false;
  private prevMood: RobotState['mood'] = 'ok';
  private wasAlive = true;

  constructor(private art: ArtAtlas, private fx: FxSystem) {
    this.wheelTex = frames(art, 'robot_wheels');
    this.bodyTex = frames(art, 'robot_body');
    this.headTex = frames(art, 'robot_head');
    this.wheels = new Sprite(this.wheelTex[0]);
    this.body = new Sprite(this.bodyTex[0]);
    this.head = new Sprite(this.headTex[HEAD_S]);
    this.fuseSp = new Sprite(tex(art, 'fuse'));
    for (const s of [this.wheels, this.body, this.head, this.fuseSp]) s.anchor.set(0.5);
    this.wheels.y = 5;
    this.body.y = -1;
    this.head.y = -10;
    this.fuseSp.y = -17;
    this.fuseSp.visible = false;
    this.container.addChild(this.wheels, this.body, this.head, this.fuseSp);
  }

  // --------------------------------------------------------------- events

  onBump(rs: RobotState): void {
    this.squash = 1;
    this.recoilX = -Math.cos(rs.facing) * 1.5;
    this.recoilY = -Math.sin(rs.facing) * 1.5;
    this.fx.dust(rs.pos.x + Math.cos(rs.facing) * 10, rs.pos.y + Math.sin(rs.facing) * 8);
  }

  onShot(rs: RobotState): void {
    this.fx.muzzle(rs.pos.x, rs.pos.y - 4, rs.facing);
  }

  onDamage(rs: RobotState): void {
    this.flashMs = 90;
    this.partToggle = !this.partToggle;
    const part = tex(this.art, this.partToggle ? 'part_plate' : 'part_antenna');
    this.fx.part(rs.pos.x, rs.pos.y - 8, part);
    this.fx.spark(rs.pos.x, rs.pos.y - 4, 3);
  }

  // ------------------------------------------------------------- per frame

  update(rs: RobotState, ui: UiState, tick: number, alpha: number, dt: number): void {
    this.t += dt;
    this.interp.push(tick, rs.pos.x, rs.pos.y);
    const ix = this.interp.x(alpha);
    const iy = this.interp.y(alpha);

    // restart detection: back from the dead → reset the powerdown look
    if (rs.alive && !this.wasAlive) this.resetLook();
    this.wasAlive = rs.alive;

    const speed = Math.hypot(rs.vel.x, rs.vel.y);
    const moving = speed > 0.01 && rs.alive;
    const fleeing = rs.mood === 'fleeing';

    // treads: rate ∝ speed
    if (moving) this.wheelPhase += (rs.speed * (fleeing ? 1.5 : 1)) * dt * 0.12;
    this.wheels.texture = this.wheelTex[Math.floor(this.wheelPhase) % this.wheelTex.length]!;

    // idle bob
    const bob = !moving && rs.alive ? Math.sin(this.t * 4) * 0.5 : 0;
    this.body.texture = this.bodyTex[Math.floor(this.t * 2) % this.bodyTex.length]!;
    this.body.y = -1 + bob;

    // head: camera ack wins, then sulk-away, then sim headFacing
    let hIdx: number;
    if (ui.headToCameraMs > 0) hIdx = HEAD_S;
    else if (rs.mood === 'sulk') hIdx = Math.cos(rs.facing) >= 0 ? HEAD_W : HEAD_E;
    else hIdx = headIndex(rs.headFacing);
    this.head.texture = this.headTex[hIdx]!;
    this.head.y = -10 + bob * 0.7;

    // sulk 'hmph' hop on mood entry
    if (rs.mood === 'sulk' && this.prevMood !== 'sulk') this.hop = 1;
    this.prevMood = rs.mood;
    this.hop = Math.max(0, this.hop - dt * 6);
    const hopY = -Math.sin(this.hop * Math.PI) * 2;

    // bump squash decay
    this.squash = Math.max(0, this.squash - dt * 8);
    this.recoilX *= Math.max(0, 1 - dt * 12);
    this.recoilY *= Math.max(0, 1 - dt * 12);
    this.container.scale.set(1 + this.squash * 0.12, 1 - this.squash * 0.12);

    // flee lean
    const leanTarget = fleeing && moving ? Math.sign(rs.vel.x || 1) * 0.12 : 0;

    // damage flash (cheap bloom: additive blend for a few frames)
    this.flashMs = Math.max(0, this.flashMs - dt * 1000);
    const blend = this.flashMs > 0 ? 'add' : 'normal';
    this.body.blendMode = blend;
    this.head.blendMode = blend;

    // death: powerdown — eye fades, slump, smoke loop
    let slump = 0;
    if (!rs.alive) {
      if (this.deathT < 0) this.deathT = 0;
      this.deathT += dt;
      const k = Math.min(1, this.deathT / 0.7);
      slump = 2 * k;
      const fade = Math.floor(lerp(0xff, 0x55, k));
      this.head.tint = (fade << 16) | (fade << 8) | Math.min(0xff, Math.floor(fade * 1.1));
      this.body.tint = (Math.floor(lerp(0xff, 0x88, k)) << 16) | (0x5a << 8) | 0x28;
      this.container.rotation = 0.06 * k;
      this.smokeT -= dt;
      if (this.smokeT <= 0) {
        this.smokeT = 0.6 + this.rng() * 0.4;
        this.fx.smoke(ix + (this.rng() - 0.5) * 6, iy - 10, 0.8);
      }
    } else {
      this.container.rotation = lerp(this.container.rotation, leanTarget, Math.min(1, dt * 10));
    }

    this.fuseSp.visible = rs.carrying !== null && rs.alive;

    this.container.position.set(ix + this.recoilX, iy + this.recoilY + hopY + slump);
    this.container.zIndex = iy + 7;
  }

  private resetLook(): void {
    this.deathT = -1;
    this.head.tint = 0xffffff;
    this.body.tint = 0xffffff;
    this.container.rotation = 0;
  }
}
