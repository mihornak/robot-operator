/**
 * World render: tilemap (rebuilt per floor), y-sorted entities, projectiles,
 * pooled fx. Reads sim state + last-tick events; writes nothing back.
 */

import { Container, Sprite, Texture } from 'pixi.js';
import type { ArtAtlas, Entity, RenderView, SimEvent } from '@shared/types';
import { TILE } from '@shared/types';
import { ART, type ArtName } from '@shared/artManifest';
import { makeRng } from '@shared/rng';
import { FxSystem } from './fx';
import { RobotView } from './robot';
import { anchorOf, frames, glowTex, hashStr, Interp, lerpColor, tex } from './util';

/** Contact-shadow footprint per grounded entity: [w, h, yOffset]. */
const SHADOW: Partial<Record<Entity['kind'], readonly [number, number, number]>> = {
  fusedPrinter: [20, 7, 8],
  printerInnocent: [15, 6, 6],
  crate: [18, 6, 8],
  fuse: [7, 3, 4],
};

const KIND_ART: Record<Entity['kind'], ArtName> = {
  scrap: 'scrap',
  crate: 'crate',
  cable: 'cable',
  fusedPrinter: 'fused_printer',
  printerInnocent: 'printer_innocent',
  mop: 'mop',
  fuse: 'fuse',
  fuseSocket: 'fuse_socket',
  elevatorA: 'elevator',
  elevatorB: 'elevator',
};

interface EntView {
  root: Container;
  body: Sprite;
  extra: Sprite | null; // pedestal / glow
  pool: Sprite | null; // radial light pool (pedestal teal / cable arc light)
  poolFlash: number; // cable: brief pool surge on each spark burst
  kind: Entity['kind'];
  phase: number; // stable per-id anim phase offset
  rng: () => number;
  interp: Interp | null; // enemies only
  motion: number; // fusedPrinter lurch phase (∝ distance moved)
  lastX: number;
  lastY: number;
  frameF: number; // elevator door frame, float
  spitMs: number; // fusedPrinter: spit-frame linger after paper_thrown
  flashMs: number;
  sparkT: number; // cable spark countdown
  seen: boolean;
}

export class WorldView {
  readonly container = new Container();
  readonly robot: RobotView;
  readonly fx: FxSystem;

  private tiles = new Container();
  private entLayer = new Container();
  private projLayer = new Container();
  private views = new Map<string, EntView>();
  private projs = new Map<string, { sp: Sprite; interp: Interp; phase: number; seen: boolean }>();
  private builtFloor = -1;
  private closing = new Set<string>(); // elevators told to shut by elevator_entered
  private elevBRamp = -1; // fuse_inserted glow ramp, -1 idle
  private t = 0;
  // shared light-pool / contact-shadow textures (created once, pooled per view)
  private shadowTex: Texture;
  private poolTealTex: Texture;
  private poolSparkTex: Texture;
  private robotShadow: Sprite;

  constructor(private art: ArtAtlas) {
    this.fx = new FxSystem(art);
    this.robot = new RobotView(art, this.fx);
    this.entLayer.sortableChildren = true;
    this.entLayer.addChild(this.robot.container);
    this.shadowTex = glowTex(32, 'rgba(0,0,0,0.85)');
    this.poolTealTex = glowTex(48, 'rgba(81,125,116,0.6)');
    this.poolSparkTex = glowTex(56, 'rgba(127,212,255,0.6)');
    this.robotShadow = new Sprite(this.shadowTex);
    this.robotShadow.anchor.set(0.5);
    this.robotShadow.scale.set(20 / 32, 8 / 32);
    this.robotShadow.alpha = 0.32;
    this.entLayer.addChild(this.robotShadow);
    this.container.addChild(this.tiles, this.entLayer, this.projLayer, this.fx.container);
  }

  // --------------------------------------------------------------- events

  handleEvent(ev: SimEvent, view: RenderView): void {
    const rs = view.sim.robot;
    switch (ev.type) {
      case 'wall_bump':
        this.robot.onBump(rs);
        break;
      case 'shot_fired':
        this.robot.onShot(rs);
        break;
      case 'robot_damage':
        this.robot.onDamage(rs);
        if (ev.data?.source === 'cable') this.fx.spark(rs.pos.x, rs.pos.y, 7);
        break;
      case 'robot_death':
        this.fx.smoke(rs.pos.x, rs.pos.y - 8, 1.3);
        this.fx.spark(rs.pos.x, rs.pos.y - 4, 5);
        break;
      case 'enemy_hit': {
        const v = ev.id ? this.views.get(ev.id) : undefined;
        if (v) v.flashMs = 90;
        break;
      }
      case 'enemy_death': {
        const e = ev.id ? this.findEntity(view, ev.id) : undefined;
        if (e) {
          this.fx.boom(e.pos.x, e.pos.y - 4);
          this.fx.part(e.pos.x, e.pos.y - 6, tex(this.art, 'part_plate'), 0x6a6f76);
          this.fx.part(e.pos.x, e.pos.y - 6, tex(this.art, 'paper'), 0x8a8d90);
        }
        break;
      }
      case 'scrap_pickup':
        this.fx.glint(rs.pos.x, rs.pos.y - 6);
        break;
      case 'paper_thrown': {
        const v = ev.id ? this.views.get(ev.id) : undefined;
        if (v) v.spitMs = 150;
        break;
      }
      case 'fuse_inserted':
        this.elevBRamp = 0;
        break;
      case 'elevator_entered':
        if (ev.id) this.closing.add(ev.id);
        break;
      default:
        break;
    }
  }

  private findEntity(view: RenderView, id: string): Entity | undefined {
    return view.sim.entities.find((e) => e.id === id);
  }

  // ------------------------------------------------------------- per frame

  update(view: RenderView, dt: number): void {
    this.t += dt;
    const sim = view.sim;

    if (sim.floorIndex !== this.builtFloor) this.rebuildFloor(sim.solid, sim.floorIndex);
    if (this.elevBRamp >= 0) this.elevBRamp = Math.min(1, this.elevBRamp + dt);

    // entities: create/remove on diff
    for (const v of this.views.values()) v.seen = false;
    for (const e of sim.entities) {
      let v = this.views.get(e.id);
      if (!v) {
        v = this.createView(e);
        this.views.set(e.id, v);
        this.entLayer.addChild(v.root);
      }
      v.seen = true;
      this.updateEntity(e, v, view, dt);
    }
    for (const [id, v] of this.views) {
      if (!v.seen) {
        v.root.destroy({ children: true });
        this.views.delete(id);
      }
    }

    // projectiles
    for (const p of this.projs.values()) p.seen = false;
    for (const pr of sim.projectiles) {
      let p = this.projs.get(pr.id);
      if (!p) {
        const sp = new Sprite(tex(this.art, pr.kind === 'bolt' ? 'bolt' : 'paper'));
        sp.anchor.set(0.5);
        this.projLayer.addChild(sp);
        p = { sp, interp: new Interp(), phase: hashStr(pr.id) % 100, seen: true };
        this.projs.set(pr.id, p);
      }
      p.seen = true;
      p.interp.push(sim.tick, pr.pos.x, pr.pos.y);
      p.sp.position.set(p.interp.x(view.alpha), p.interp.y(view.alpha));
      const fs = frames(this.art, pr.kind === 'bolt' ? 'bolt' : 'paper');
      p.sp.texture = fs[Math.floor(this.t * (pr.kind === 'bolt' ? 20 : 12) + p.phase) % fs.length]!;
      p.sp.rotation =
        pr.kind === 'bolt' ? Math.atan2(pr.vel.y, pr.vel.x) : this.t * 9 + p.phase;
    }
    for (const [id, p] of this.projs) {
      if (!p.seen) {
        p.sp.destroy();
        this.projs.delete(id);
      }
    }

    this.robot.update(sim.robot, view.ui, sim.tick, view.alpha, dt);
    // contact shadow keeps the robot on the floor through hops and bumps
    this.robotShadow.position.set(this.robot.container.x, this.robot.container.y + 6);
    this.robotShadow.zIndex = this.robot.container.zIndex - 0.5;
    this.fx.update(dt);
  }

  // -------------------------------------------------------------- tilemap

  private rebuildFloor(solid: boolean[][], floorIndex: number): void {
    this.builtFloor = floorIndex;
    this.closing.clear();
    this.elevBRamp = -1;
    this.fx.clear();
    this.tiles.removeChildren().forEach((c) => c.destroy({ children: true }));
    for (const [, v] of this.views) v.root.destroy({ children: true });
    this.views.clear();

    const rng = makeRng(0x711e5 + floorIndex * 7919);
    const floorTex = frames(this.art, 'tile_floor');
    const faceTex = frames(this.art, 'tile_wall_face');
    const topTex = tex(this.art, 'tile_wall_top');
    const shadowTex = tex(this.art, 'tile_shadow');
    const at = (x: number, y: number): boolean => solid[y]?.[x] ?? true;

    // worn walkway: one mostly-open row leans on the painted-stripe variant so
    // its fragments join into a faded line across the room
    const openRows: number[] = [];
    for (let y = 0; y < solid.length; y++) {
      let n = 0;
      const row = solid[y]!;
      for (let x = 0; x < row.length; x++) if (!row[x]) n++;
      if (n >= 10) openRows.push(y);
    }
    const walkRow = openRows.length > 0 ? openRows[Math.floor(rng() * openRows.length)]! : -1;

    for (let y = 0; y < solid.length; y++) {
      const row = solid[y]!;
      for (let x = 0; x < row.length; x++) {
        let sp: Sprite;
        if (row[x]) {
          // south-facing solid cells show their wall face, the rest their top
          sp = new Sprite(!at(x, y + 1) ? faceTex[Math.floor(rng() * faceTex.length)] : topTex);
        } else {
          let fi: number;
          if (y === walkRow && rng() < 0.8) fi = 1; // stripe, worn through in spots
          else {
            const r = rng();
            fi = r < 0.62 ? 0 : r < 0.94 ? 2 : 3; // drain grates stay rare
          }
          sp = new Sprite(floorTex[fi]);
        }
        sp.position.set(x * TILE, y * TILE);
        this.tiles.addChild(sp);
        // contact shadow on walkable cells hugging a wall to the north
        if (!row[x] && at(x, y - 1)) {
          const sh = new Sprite(shadowTex);
          sh.position.set(x * TILE, y * TILE);
          this.tiles.addChild(sh);
        }
      }
    }
  }

  // ------------------------------------------------------------- entities

  private createView(e: Entity): EntView {
    const root = new Container();
    const name = KIND_ART[e.kind];
    const body = new Sprite(tex(this.art, name));
    const [ax, ay] = anchorOf(name);
    body.anchor.set(ax, ay);
    let extra: Sprite | null = null;
    let pool: Sprite | null = null;

    // contact shadow first — everything else stacks on top of it
    const shCfg = SHADOW[e.kind];
    if (shCfg) {
      const sh = new Sprite(this.shadowTex);
      sh.anchor.set(0.5);
      sh.scale.set(shCfg[0] / 32, shCfg[1] / 32);
      sh.y = shCfg[2];
      sh.alpha = 0.3;
      root.addChild(sh);
    }

    if (e.kind === 'crate') {
      // cool charging pool grounds the pedestal in the dark
      pool = new Sprite(this.poolTealTex);
      pool.anchor.set(0.5);
      pool.blendMode = 'add';
      pool.scale.set(1.05, 0.5);
      pool.y = 7;
      pool.alpha = 0.09;
      root.addChild(pool);
      extra = new Sprite(tex(this.art, 'pedestal'));
      extra.anchor.set(0.5, 0.5);
      extra.y = 4;
      body.y = -4;
      root.addChild(extra);
    } else if (e.kind === 'cable') {
      // blue-white arc light, flickered in updateEntity with the spark frames
      pool = new Sprite(this.poolSparkTex);
      pool.anchor.set(0.5);
      pool.blendMode = 'add';
      pool.scale.set(1, 0.55);
      pool.y = 1;
      pool.alpha = 0.06;
      root.addChild(pool);
    } else if (e.kind === 'elevatorB') {
      // warm floor pool spilling out of the lit shaft, pulses when powered
      extra = new Sprite(glowTex(48, 'rgba(255,195,107,0.55)'));
      extra.anchor.set(0.5);
      extra.blendMode = 'add';
      extra.y = 4;
      root.addChild(extra);
    }
    root.addChild(body);
    root.position.set(e.pos.x, e.pos.y);

    const isEnemy = e.kind === 'fusedPrinter';
    return {
      root,
      body,
      extra,
      pool,
      poolFlash: 0,
      kind: e.kind,
      phase: (hashStr(e.id) % 1000) / 100,
      rng: makeRng(hashStr(e.id)),
      interp: isEnemy ? new Interp() : null,
      motion: 0,
      lastX: e.pos.x,
      lastY: e.pos.y,
      frameF: e.kind === 'elevatorB' ? 3 : 0,
      spitMs: 0,
      flashMs: 0,
      sparkT: 1 + (hashStr(e.id) % 20) / 10,
      seen: true,
    };
  }

  private updateEntity(e: Entity, v: EntView, view: RenderView, dt: number): void {
    const sim = view.sim;
    const t = this.t;

    // position (enemies interpolate)
    let x = e.pos.x;
    let y = e.pos.y;
    if (v.interp) {
      v.interp.push(sim.tick, e.pos.x, e.pos.y);
      x = v.interp.x(view.alpha);
      y = v.interp.y(view.alpha);
    }
    v.root.position.set(x, y);
    const entry = ART[KIND_ART[e.kind]];
    const [, ay] = anchorOf(KIND_ART[e.kind]);
    v.root.zIndex = e.kind === 'cable' ? y - 100 : y + entry.h * (1 - ay); // cables lie flat on the floor

    // dead fade-out
    if (e.dead && e.kind !== 'crate' && e.kind !== 'fuseSocket') {
      v.root.alpha = Math.max(0, v.root.alpha - dt * 2.5);
      v.root.visible = v.root.alpha > 0.01;
      return;
    }

    // hit flash
    v.flashMs = Math.max(0, v.flashMs - dt * 1000);
    v.body.tint = v.flashMs > 0 ? 0xff7070 : 0xffffff;

    switch (e.kind) {
      case 'scrap': {
        const fs = frames(this.art, 'scrap');
        v.body.texture = fs[(t + v.phase) % 1.6 < 0.12 ? 1 : 0]!;
        // occasional star-glint floats off it — SHINY pulls the eye
        v.sparkT -= dt;
        if (v.sparkT <= 0) {
          v.sparkT = 2.4 + v.rng() * 1.6;
          this.fx.spawn({
            x: x + (v.rng() - 0.5) * 5,
            y: y - 6 - v.rng() * 3,
            tex: frames(this.art, 'fx_spark'),
            fps: 10,
            life: 0.4,
            vy: -12,
            fade: true,
            loop: true,
            blend: 'add',
            scale: 0.6,
          });
        }
        break;
      }
      case 'crate': {
        const fs = frames(this.art, 'crate');
        const open = e.state === 'open';
        v.body.texture = fs[open ? 1 : 0]!;
        const ped = frames(this.art, 'pedestal');
        if (e.dead && !open) {
          // unchosen sibling: stays shut, powered down
          v.body.tint = 0x8a8f96;
          if (v.extra) {
            v.extra.texture = ped[0]!;
            v.extra.tint = 0x8a8f96;
          }
        } else if (v.extra) {
          v.extra.texture = ped[Math.floor((t + v.phase) * 1.6) % ped.length]!;
        }
        if (v.pool) {
          if (e.dead && e.state !== 'open') v.pool.visible = false; // unchosen sibling powers down
          else v.pool.alpha = 0.06 + 0.05 * (0.5 + 0.5 * Math.sin((t + v.phase) * 5));
        }
        break;
      }
      case 'cable': {
        const fs = frames(this.art, 'cable');
        const fi = Math.floor((t + v.phase) * 8) % fs.length;
        v.body.texture = fs[fi]!;
        v.poolFlash = Math.max(0, v.poolFlash - dt * 3);
        v.sparkT -= dt;
        if (v.sparkT <= 0) {
          v.sparkT = 1.2 + v.rng() * 1.6;
          this.fx.spark(x + (v.rng() - 0.5) * 24, y, 2);
          v.poolFlash = 1; // danger telegraph: pool surges so it reads room-wide
        }
        if (v.pool) {
          // arc light flickers loosely with the spark frames (frame 2 = big arc)
          const arc = fi === 2 ? 1 : fi > 0 ? 0.45 : 0;
          v.pool.alpha = (0.05 + 0.09 * arc + 0.2 * v.poolFlash) * (0.85 + 0.3 * v.rng());
        }
        break;
      }
      case 'fusedPrinter': {
        const moved = Math.hypot(x - v.lastX, y - v.lastY);
        v.motion += moved * 0.28; // lurch cycle synced to its motion
        v.spitMs = Math.max(0, v.spitMs - dt * 1000);
        // sim never has a 'spit' state — release is the paper_thrown event,
        // so the spit frame lingers on a render-side timer (spitMs)
        if (v.spitMs > 0 || e.state === 'spit_tel') {
          const fs = frames(this.art, 'fused_printer_spit');
          v.body.texture = fs[v.spitMs > 0 ? 1 : 0]!;
        } else {
          const fs = frames(this.art, 'fused_printer');
          v.body.texture = fs[Math.floor(v.motion) % fs.length]!;
        }
        v.body.scale.x = e.facing === 'left' ? -1 : 1;
        break;
      }
      case 'printerInnocent': {
        const fs = frames(this.art, 'printer_innocent');
        v.body.texture = fs[(t + v.phase) % 2.4 < 0.18 ? 1 : 0]!; // peaceful LED blink
        break;
      }
      case 'fuse':
        v.root.visible = sim.robot.carrying !== e.id; // carried fuse rides the robot
        break;
      case 'fuseSocket': {
        const fs = frames(this.art, 'fuse_socket');
        const filled = e.state === 'filled' || this.elevBRamp >= 0;
        v.body.texture = fs[filled ? 1 : 0]!;
        break;
      }
      case 'elevatorA':
      case 'elevatorB':
        this.updateElevator(e, v, dt, t);
        break;
      case 'mop':
        break;
    }

    v.lastX = x;
    v.lastY = y;
  }

  private updateElevator(e: Entity, v: EntView, dt: number, t: number): void {
    const fs = frames(this.art, 'elevator');
    // door frames closed→open = 0→3. A ('inert') stays shut; B ('dark'|'lit')
    // stands open until elevator_entered puts it in `closing`.
    const target = e.kind === 'elevatorA' || this.closing.has(e.id) ? 0 : 3;
    const d = target - v.frameF;
    const step = 10 * dt;
    v.frameF = Math.abs(d) <= step ? target : v.frameF + Math.sign(d) * step;
    v.body.texture = fs[Math.max(0, Math.min(fs.length - 1, Math.round(v.frameF)))]!;

    if (e.kind === 'elevatorA') {
      v.body.tint = 0x878c94; // inert spawn shaft
      return;
    }
    const powered = e.state === 'lit' || this.elevBRamp >= 0;
    const ramp = this.elevBRamp >= 0 ? this.elevBRamp : 1;
    const pulse = 0.5 + 0.5 * Math.sin(t * 3 + v.phase);
    if (v.extra) {
      // The lit shaft is the GOAL — it must read across the dark room.
      v.extra.visible = powered;
      v.extra.alpha = (0.28 + 0.16 * pulse) * ramp;
      const s = 1 + 0.06 * pulse;
      v.extra.scale.set(s * 1.4, s * 0.65); // elliptical pool at the threshold
    }
    v.body.tint = powered
      ? lerpColor(0xffffff, 0xffdfae, 0.35 * pulse * ramp)
      : 0x70747c;
  }
}
