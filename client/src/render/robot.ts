/**
 * The robot — wheels + body + 8-dir head, the only saturated thing on screen.
 * Data-driven micro-tweens: bob, tread roll, travel lean (underdamped spring —
 * overshoot wobble on stop for free), chassis rumble, turn-anticipation squash,
 * idle micro-glances, eased camera ack (fast in / slow out), staggered damage
 * drama, powerup ceremony (head 360 + hop + spark ring), powerdown tragedy.
 */

import { Container, Sprite, type Texture } from 'pixi.js';
import type { ArtAtlas, ChipId, RobotState, UiState } from '@shared/types';
import { makeRng } from '@shared/rng';
import type { FxSystem } from './fx';
import { canvasTex, frames, Interp, lerp, tex } from './util';

/** robot_head frame order E,SE,S,SW,W,NW,N,NE (screen y-down: +45° = SE). */
const HEAD_E = 0;
const HEAD_S = 2;
const HEAD_W = 4;

function headIndex(rad: number): number {
  return ((Math.round(rad / (Math.PI / 4)) % 8) + 8) % 8;
}

/** Shortest signed arc between two head indices, in [-4, 4). */
function headArc(d: number): number {
  return ((((d % 8) + 12) % 8) - 4);
}

/** Overshoots past 1 (~1.1) then settles — the slump "bounce". */
function easeOutBack(t: number): number {
  const c = 1.7;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

/** Per-chip shoulder nubs — code-drawn HERE (render-owned, not art manifest).
 *  Dull accents only; the amber ZAP tip is the sole hot pixel. */
const NUBS: Record<ChipId, { x: number; w: number; h: number; draw: (ctx: CanvasRenderingContext2D) => void }> = {
  MAGNET: { x: -7, w: 4, h: 3, draw: (c) => { c.fillStyle = '#c9ced6'; c.fillRect(0, 0, 4, 1); c.fillRect(0, 1, 1, 2); c.fillRect(3, 1, 1, 2); } }, // pale horseshoe
  RAGE: { x: -4, w: 3, h: 4, draw: (c) => { c.fillStyle = '#a03428'; c.fillRect(2, 0, 1, 4); c.fillRect(1, 1, 1, 3); c.fillRect(0, 3, 1, 1); } }, // dull-red fin
  SCARED: { x: -1, w: 3, h: 4, draw: (c) => { c.fillStyle = '#7a7d3a'; c.fillRect(1, 0, 1, 1); c.fillRect(0, 1, 3, 2); c.fillRect(1, 3, 1, 1); } }, // olive drop
  MEMORY: { x: 2, w: 3, h: 3, draw: (c) => { c.fillStyle = '#3aa89e'; c.fillRect(0, 0, 3, 3); c.fillStyle = '#1e6f68'; c.fillRect(1, 1, 1, 1); } }, // teal chip
  ZAP: { x: 5, w: 1, h: 4, draw: (c) => { c.fillStyle = '#8b9098'; c.fillRect(0, 1, 1, 3); c.fillStyle = '#ffb000'; c.fillRect(0, 0, 1, 1); } }, // antenna, amber tip
  TOUGH: { x: 7, w: 4, h: 2, draw: (c) => { c.fillStyle = '#9aa2ac'; c.fillRect(0, 0, 4, 1); c.fillStyle = '#6b727c'; c.fillRect(0, 1, 4, 1); } }, // plate edge
};

const SPIN_S = 1.1; // idle-spin duration: 8 head frames + wobble

// travel-lean spring (underdamped ⇒ stop-overshoot wobble comes for free)
const LEAN_K = 1600; // ω ≈ 40 rad/s
const LEAN_D = 28; // ζ ≈ 0.35 → ~2 visible overshoots, dies in ~3 frames

// head swivel rates, frames/s
const HEAD_RATE = 24; // normal servo turn
const HEAD_RATE_CAM = 34; // "did you say something?" — snaps to camera
const HEAD_RATE_RETURN = 6.5; // …then drifts lazily back

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
  private puffStage = 0; // death: two scripted puffs, then slow loop
  private twitchT = 0; // death: one last head twitch
  private twitched = false;
  private dmgT = -1; // staggered damage drama clock
  private dmgStage = 0;
  private partToggle = false;
  private prevMood: RobotState['mood'] = 'ok';
  private wasAlive = true;
  private nubs = new Container();
  private nubSp = new Map<ChipId, Sprite>();
  private spinT = -1;
  private lastCaption = '';
  private prevChips = 0;
  // travel lean springs (px)
  private leanX = 0;
  private leanVX = 0;
  private leanY = 0;
  private leanVY = 0;
  // head float index 0..8 (wraps) — render-side ease over sim headFacing
  private headF = HEAD_S;
  private camAckPrev = false;
  private returnT = 0; // slow-return window after camera ack expires
  private anticT = 0; // turn-anticipation squash timer
  private prevFacingIdx = HEAD_S;
  // idle micro-glances
  private idleT = 0;
  private glanceCd = 2.2;
  private glanceT = 0;
  private glanceOff = 0;

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
    this.container.addChild(this.wheels, this.body, this.nubs, this.head, this.fuseSp);
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
    // Staggered so it reads: flash + knockback NOW, part pops at +70ms,
    // sparks at +120ms (see update()).
    this.flashMs = 60;
    this.recoilX = -Math.cos(rs.facing) * 2.2;
    this.recoilY = -Math.sin(rs.facing) * 2.2;
    this.dmgT = 0;
    this.dmgStage = 0;
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

    // travel lean: underdamped spring chases the motion direction — leans INTO
    // travel while moving, overshoot-wobbles around 0 on stop (the settle).
    let ltx = 0;
    let lty = 0;
    if (moving) {
      const inv = 1 / speed;
      ltx = rs.vel.x * inv * 1.6;
      lty = rs.vel.y * inv * 0.8;
    }
    const sdt = Math.min(dt, 1 / 30); // spring stability under frame spikes
    this.leanVX += (ltx - this.leanX) * LEAN_K * sdt;
    this.leanVX -= this.leanVX * Math.min(1, LEAN_D * sdt);
    this.leanX += this.leanVX * sdt;
    this.leanVY += (lty - this.leanY) * LEAN_K * sdt;
    this.leanVY -= this.leanVY * Math.min(1, LEAN_D * sdt);
    this.leanY += this.leanVY * sdt;

    // tiny chassis rumble while rolling, synced to tread phase
    const rumble = moving ? Math.sin(this.wheelPhase * 5.7) * 0.45 : 0;

    // idle bob
    const bob = !moving && rs.alive ? Math.sin(this.t * 4) * 0.5 : 0;
    this.body.texture = this.bodyTex[Math.floor(this.t * 2) % this.bodyTex.length]!;
    this.body.y = -1 + bob + rumble;

    // ---- head: eased float index — camera ack wins, then sulk, then sim ----
    const camAck = ui.headToCameraMs > 0 && rs.alive;
    if (!camAck && this.camAckPrev) this.returnT = 0.55; // slow drift back
    this.camAckPrev = camAck;
    this.returnT = Math.max(0, this.returnT - dt);

    // idle micro-glances: after 2s still, occasional small random looks
    if (moving || !rs.alive || camAck) {
      this.idleT = 0;
      this.glanceT = 0;
      this.glanceOff = 0;
    } else {
      this.idleT += dt;
      if (this.glanceT > 0) {
        this.glanceT -= dt;
        if (this.glanceT <= 0) this.glanceOff = 0;
      } else if (this.idleT > 2) {
        this.glanceCd -= dt;
        if (this.glanceCd <= 0) {
          this.glanceCd = 1.8 + this.rng() * 2.6;
          this.glanceOff = (this.rng() < 0.5 ? -1 : 1) * (this.rng() < 0.25 ? 2 : 1);
          this.glanceT = 0.28 + this.rng() * 0.4;
        }
      }
    }

    let hTarget: number;
    if (camAck) hTarget = HEAD_S;
    else if (rs.mood === 'sulk') hTarget = Math.cos(rs.facing) >= 0 ? HEAD_W : HEAD_E;
    else hTarget = (headIndex(rs.headFacing) + this.glanceOff + 8) % 8;

    // turn snap: >90° body-facing flip → 2-frame anticipation squash first
    const facIdx = headIndex(rs.facing);
    if (rs.alive && Math.abs(headArc(facIdx - this.prevFacingIdx)) > 2 && this.anticT <= 0 && this.spinT < 0) {
      this.anticT = 0.055;
    }
    this.prevFacingIdx = facIdx;

    let headSquash = 0;
    if (!rs.alive) {
      // dead: head frozen where it was (twitch handled below)
    } else if (this.anticT > 0) {
      this.anticT -= dt; // hold frame, wind up
      headSquash = 1;
    } else {
      const d = headArc(hTarget - this.headF);
      const rate = camAck ? HEAD_RATE_CAM : this.returnT > 0 ? HEAD_RATE_RETURN : HEAD_RATE;
      const step = rate * dt;
      this.headF = Math.abs(d) <= step ? hTarget : (this.headF + Math.sign(d) * step + 8) % 8;
    }
    let hIdx = Math.round(this.headF) % 8;

    // powerup ceremony: chip installed → head 360 + hop + spark ring
    if (rs.chips.length > this.prevChips && rs.alive) {
      this.spinT = 0;
      this.hop = 1;
      this.sparkRing(ix, iy - 8);
    }
    this.prevChips = rs.chips.length;

    // Idle spin — no sim event exists for it, so the idle_spin caption
    // ("ROBOT SPINS…", see shared/voiceLines.ts) is the pragmatic trigger.
    if (ui.caption !== this.lastCaption) {
      this.lastCaption = ui.caption;
      if (rs.alive && ui.caption.startsWith('ROBOT SPINS')) this.spinT = 0;
    }
    let wobble = 0;
    if (this.spinT >= 0) {
      this.spinT += dt;
      const k = this.spinT / SPIN_S;
      if (k >= 1) this.spinT = -1;
      else {
        hIdx = (hIdx + Math.floor(k * 8)) % 8; // one full revolution
        wobble = Math.sin(k * Math.PI * 4) * 0.7;
      }
    }

    // death: one last head twitch at +1.2s
    if (this.twitchT > 0) {
      this.twitchT -= dt;
      hIdx = (hIdx + 1) % 8;
    }

    this.head.texture = this.headTex[hIdx]!;
    this.head.scale.set(1 + headSquash * 0.12, 1 - headSquash * 0.2); // servo wind-up
    this.head.x = this.leanX * 1.3;
    this.head.y = -10 + bob * 0.7 + rumble * 0.4 + this.leanY * 0.6;
    this.body.x = wobble + this.leanX;

    // chip nubs ride the shoulder line, bobbing with the body
    for (const sp of this.nubSp.values()) sp.visible = false; // restart drops chips
    for (const chip of rs.chips) {
      let sp = this.nubSp.get(chip);
      if (!sp) {
        const n = NUBS[chip];
        sp = new Sprite(canvasTex(n.w, n.h, n.draw));
        sp.anchor.set(0.5, 1);
        sp.x = n.x;
        this.nubs.addChild(sp);
        this.nubSp.set(chip, sp);
      }
      sp.visible = true;
    }
    this.nubs.position.set(this.body.x, this.body.y - 6);

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

    // staggered damage drama: flash hit at event, part pop at +70ms, sparks +120ms
    if (this.dmgT >= 0) {
      this.dmgT += dt;
      if (this.dmgStage === 0 && this.dmgT >= 0.07) {
        this.dmgStage = 1;
        this.partToggle = !this.partToggle;
        this.fx.part(ix, iy - 8, tex(this.art, this.partToggle ? 'part_plate' : 'part_antenna'));
      } else if (this.dmgStage === 1 && this.dmgT >= 0.12) {
        this.dmgT = -1;
        this.fx.spark(ix, iy - 4, 4);
      }
    }

    // death: powerdown — slow eye fade, slump-bounce, two puffs → smoke loop
    let slump = 0;
    if (!rs.alive) {
      if (this.deathT < 0) {
        this.deathT = 0;
        this.puffStage = 0;
        this.twitched = false;
      }
      this.deathT += dt;
      const k = Math.min(1, this.deathT / 0.6); // 600ms eye-light fade
      slump = 3 * easeOutBack(k); // drops 3px, overshoots, settles
      const fade = Math.floor(lerp(0xff, 0x55, k));
      this.head.tint = (fade << 16) | (fade << 8) | Math.min(0xff, Math.floor(fade * 1.1));
      this.body.tint = (Math.floor(lerp(0xff, 0x88, k)) << 16) | (0x5a << 8) | 0x28;
      this.container.rotation = 0.06 * k;
      if (this.puffStage === 0 && this.deathT >= 0.22) {
        this.puffStage = 1;
        this.fx.smoke(ix - 2, iy - 10, 0.9);
      } else if (this.puffStage === 1 && this.deathT >= 0.5) {
        this.puffStage = 2;
        this.smokeT = 1.0;
        this.fx.smoke(ix + 2, iy - 11, 1.1);
      } else if (this.puffStage === 2) {
        this.smokeT -= dt;
        if (this.smokeT <= 0) {
          this.smokeT = 1.2 + this.rng() * 0.7;
          this.fx.smoke(ix + (this.rng() - 0.5) * 6, iy - 10, 0.65);
        }
      }
      if (!this.twitched && this.deathT >= 1.2) {
        this.twitched = true;
        this.twitchT = 0.13; // the little tragedy's last beat
      }
    } else {
      this.container.rotation = lerp(this.container.rotation, leanTarget, Math.min(1, dt * 10));
    }

    // carry pose: fuse bobs out of phase with the body — visible weight
    this.fuseSp.visible = rs.carrying !== null && rs.alive;
    if (this.fuseSp.visible) {
      this.fuseSp.x = this.leanX * 1.5; // weight swings into the motion
      this.fuseSp.y = -17 + (moving
        ? Math.sin(this.wheelPhase * 2.8) * 0.5
        : Math.sin(this.t * 4 - 1.25) * 0.6);
    }

    this.container.position.set(ix + this.recoilX, iy + this.recoilY + hopY + slump);
    this.container.zIndex = iy + 7;
  }

  /** Even ring of sparks bursting outward (chip-install ceremony). */
  private sparkRing(x: number, y: number): void {
    const t = frames(this.art, 'fx_spark');
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      this.fx.spawn({
        x: x + Math.cos(a) * 4,
        y: y + Math.sin(a) * 3,
        tex: t,
        fps: 14,
        life: 0.38 + this.rng() * 0.12,
        vx: Math.cos(a) * 55,
        vy: Math.sin(a) * 38 - 12,
        grav: 40,
        fade: true,
        blend: 'add',
      });
    }
  }

  private resetLook(): void {
    this.deathT = -1;
    this.smokeT = 0;
    this.puffStage = 0;
    this.twitchT = 0;
    this.twitched = false;
    this.dmgT = -1;
    this.spinT = -1;
    this.anticT = 0;
    this.returnT = 0;
    this.headF = HEAD_S;
    this.idleT = 0;
    this.glanceT = 0;
    this.glanceOff = 0;
    this.leanX = this.leanVX = 0;
    this.leanY = this.leanVY = 0;
    this.head.tint = 0xffffff;
    this.body.tint = 0xffffff;
    this.head.scale.set(1);
    this.container.rotation = 0;
  }
}
