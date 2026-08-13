/**
 * The LIT render path: a floor whose level authored lights, dressing and a look
 * is drawn by `render/lit` instead of by the tilemap and entity views in
 * world.ts. One of the two is mounted at a time — see render/index.ts.
 *
 * What this class is: the adapter between a running sim and `LitScene`, which
 * knows nothing about entities, floors or events. It owns the same three
 * subsystems the classic path owns and does not reimplement them — `FxSystem`,
 * `MarkerLayer`, `ProjectileLayer` and `RobotView` are the very same classes,
 * inserted into the lit scene at the layers their content belongs to.
 *
 * Two things about the composition are load-bearing:
 *
 *  1. The lit scene renders to its OWN 480×270 target at identity, and what
 *     goes into the world container is that target's sprite. The lightmap
 *     multiply and the grade are screen-space filters: running them inside a
 *     container the CRT stack is jittering and zooming would sample the
 *     lightmap at the wrong scale and put the grade's arithmetic on a moving
 *     grid. Same reason the graphics lab does it — see render/lit/README.md.
 *  2. The grade runs; the lens does not. `GradeFilter` carries vignette,
 *     chroma, grain and scanlines as well as the tone curve, and the game
 *     already owns all four in `CrtStack`, which is THE terminal look. The
 *     level's authored tone/lift/gain is the half that is the level's to say.
 */

import {
  Container,
  Rectangle,
  RenderTexture,
  Sprite,
  type Renderer,
  type Texture,
} from 'pixi.js';
import type { Entity, LevelLit, RenderView, SimEvent } from '@shared/types';
import { VIEW_H, VIEW_W } from '@shared/types';
import type { ArtName } from '@shared/artManifest';
import { makeRng } from '@shared/rng';
import type { PixiArtAtlas } from '../art';
import { eventFx } from './eventFx';
import { FxSystem } from './fx';
import { GradeFilter } from './lit/filters';
import { ACTOR_FOOT, LitScene } from './lit/scene';
import {
  resolveLook,
  type ActorPart,
  type ActorState,
  type LightState,
  type SceneDef,
} from './lit/types';
import { MarkerLayer } from './markers';
import { updatePile } from './pile';
import { ProjectileLayer } from './projectiles';
import { RobotView } from './robot';
import { actorPlacement, ellipseGlow, frames, hashStr, Interp } from './util';
import { CHIP_SCALE, CRATE_SCALE, CRATE_SCALE_PLAIN, KIND_ART } from './world';

/** The walkability grid as the map string `LitScene` builds tiles from.
 *  Derived from the SIM's grid rather than the level's, so a door a trigger
 *  opened is open here too. */
export function mapFromSolid(solid: readonly boolean[][]): string[] {
  return solid.map((row) => row.map((s) => (s ? '#' : '.')).join(''));
}

/** A level's lit bag → the renderer's scene contract. The only place defaults
 *  and tile→px conventions are applied; the sim carries the bag untouched. */
export function sceneDefFromLit(lit: LevelLit, solid: readonly boolean[][]): SceneDef {
  return {
    map: mapFromSolid(solid),
    // Dressing has to be stable across reloads, and a level that never picked a
    // seed still gets the same room twice.
    seed: lit.seed ?? 1,
    decor: lit.decor ?? [],
    lights: lit.lights ?? [],
    fixtures: lit.fixtures ?? [],
    wetPatches: lit.wetPatches ?? [],
    tiles: lit.tiles,
    look: resolveLook(lit.look),
  };
}

/** Per-entity animation clocks. The lit path draws one sprite per entity, so
 *  this is all the state it needs — no pools, halos or pedestals: on a lit
 *  floor the fake light those faked is real. */
interface EntAnim {
  phase: number;
  /** Enemies interpolate between ticks; everything else stands still. */
  interp: Interp | null;
  /** fusedPrinter lurch phase, ∝ distance moved. */
  motion: number;
  lastX: number;
  lastY: number;
  /** Elevator door frame, float. */
  frameF: number;
  /** Spit-frame linger after paper_thrown — the sim has no 'spit' state. */
  spitMs: number;
  /** Hit-flash timer. A landed shot has to be visible on the thing that took
   *  it, not only in the sparks coming off it. */
  flashMs: number;
  /** Death fade, 1 → 0. A body that vanishes between two frames reads as a
   *  dropped frame; the classic path fades at this same rate. */
  fade: number;
  /** Presentation jitter, seeded per entity. Never the sim's rng. */
  rng: () => number;
  /** Debris heap: glint countdown, wake one-shot, ember. See render/pile.ts. */
  sparkT: number;
  seenBurst: boolean;
  ember: number;
}

export class LitWorldView {
  /** What the world container shows: the composed 480×270 feed. */
  readonly container = new Container();
  readonly fx: FxSystem;
  readonly markers = new MarkerLayer();
  readonly robot: RobotView;

  private scene: LitScene;
  private projectiles: ProjectileLayer;
  private post = new Container();
  private rt: RenderTexture;
  private grade = new GradeFilter(VIEW_W, VIEW_H);
  private anims = new Map<string, EntAnim>();
  private closing = new Set<string>();
  private emberTex: Texture;
  private t = 0;

  constructor(
    private renderer: Renderer,
    private art: PixiArtAtlas,
    lit: LevelLit,
    solid: readonly boolean[][],
  ) {
    this.scene = new LitScene(renderer, art, sceneDefFromLit(lit, solid));
    this.fx = new FxSystem(art);
    this.robot = new RobotView(art, this.fx);
    this.projectiles = new ProjectileLayer(art);
    // Squashed to the classic pool's proportions (a 48px glow at 0.7 × 0.45),
    // baked into the texture because an actor part scales uniformly.
    this.emberTex = ellipseGlow(34, 22, 'rgba(255,195,107,0.55)');

    // Markers, projectiles and fx all go ABOVE the lightmap multiply, in that
    // order. Every one of them is light rather than surface — a mortar warning
    // circle, a bolt, an explosion — and a warning circle that the room's own
    // darkness can multiply away is a warning nobody gets.
    this.scene.root.addChild(
      this.markers.container,
      this.projectiles.container,
      this.fx.container,
    );

    this.post.addChild(this.scene.root);
    this.post.filterArea = new Rectangle(0, 0, VIEW_W, VIEW_H);
    this.post.filters = [this.grade];
    this.rt = RenderTexture.create({ width: VIEW_W, height: VIEW_H, antialias: false });
    this.rt.source.scaleMode = 'nearest';
    this.container.addChild(new Sprite(this.rt));
  }

  /** The `light` trigger action. Unknown ids are ignored inside LitScene. */
  setLight(id: string, state: LightState): void {
    this.scene.setLightState(id, state);
  }

  stats(): string {
    return this.scene.stats();
  }

  // --------------------------------------------------------------- events

  handleEvent(ev: SimEvent, view: RenderView): void {
    eventFx(this.fx, this.art, this.robot, ev, view);
    switch (ev.type) {
      case 'enemy_hit': {
        const a = ev.id ? this.anims.get(ev.id) : undefined;
        if (a) a.flashMs = 90;
        break;
      }
      case 'paper_thrown': {
        const a = ev.id ? this.anims.get(ev.id) : undefined;
        if (a) a.spitMs = 150;
        break;
      }
      case 'elevator_entered':
        if (ev.id) this.closing.add(ev.id);
        break;
      case 'tiles_changed':
        // A door opened. Tiles, wall occluders and the floor mask all come off
        // the grid, so all three are rebuilt and every light re-bakes — a door
        // that opens into a wall's shadow is a door that did not open.
        this.scene.markTilesDirty(mapFromSolid(view.sim.solid));
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------- per frame

  update(view: RenderView, dt: number): void {
    this.t += dt;
    const sim = view.sim;

    this.robot.update(sim.robot, view.ui, sim.tick, view.alpha, dt);
    this.markers.update(sim.mortars, dt);
    this.projectiles.update(sim, view.alpha, this.t);
    this.fx.update(dt);

    const states: ActorState[] = [];
    const live = new Set<string>();
    for (const e of sim.entities) {
      live.add(e.id);
      const s = this.actorFor(e, view, dt);
      if (s) states.push(s);
    }
    for (const id of this.anims.keys()) if (!live.has(id)) this.anims.delete(id);

    const rig = this.robot.rig();
    // A robot buried in the pile is not in the room yet — and an actor with no
    // parts would still claim a shadow rig.
    if (rig.visible && rig.parts.length > 0) {
      states.push({
        id: 'robot',
        x: rig.x,
        y: rig.y,
        parts: rig.parts,
        foot: ACTOR_FOOT,
        rotation: rig.rotation,
        scaleX: rig.scaleX,
        scaleY: rig.scaleY,
      });
    }

    // Actors first, always: the lighting response for a body runs inside
    // update(), against the lightmap this frame is about to be drawn with.
    this.scene.updateActors(states);
    this.scene.update(dt);
  }

  /**
   * Draw the room into its own target. Must run before the frame is presented
   * and before the CRT stack snapshots the feed for its tear bands.
   */
  compose(nowSeconds: number): void {
    const look = this.scene.lookState;
    const u = this.grade.u;
    u.uTone[0] = look.exposure;
    u.uTone[1] = look.contrast;
    u.uTone[2] = look.saturation;
    u.uTone[3] = look.gamma;
    u.uLift[0] = ((look.liftColor >> 16) & 0xff) / 255;
    u.uLift[1] = ((look.liftColor >> 8) & 0xff) / 255;
    u.uLift[2] = (look.liftColor & 0xff) / 255;
    u.uLift[3] = look.liftAmount;
    u.uGain[0] = ((look.gainColor >> 16) & 0xff) / 255;
    u.uGain[1] = ((look.gainColor >> 8) & 0xff) / 255;
    u.uGain[2] = (look.gainColor & 0xff) / 255;
    u.uGain[3] = look.gainAmount;
    // Lens and scanlines stay at zero — CrtStack is the glass in this build.
    u.uMisc[1] = nowSeconds;
    u.uMisc[2] = 1;
    this.renderer.render({ container: this.post, target: this.rt, clear: true });
  }

  // ---------------------------------------------------------------- actors

  private animFor(e: Entity): EntAnim {
    let a = this.anims.get(e.id);
    if (!a) {
      a = {
        phase: (hashStr(e.id) % 1000) / 100,
        interp: e.kind === 'fusedPrinter' ? new Interp() : null,
        motion: 0,
        lastX: e.pos.x,
        lastY: e.pos.y,
        frameF: e.kind === 'elevatorB' ? 3 : 0,
        spitMs: 0,
        flashMs: 0,
        fade: 1,
        rng: makeRng(hashStr(e.id)),
        sparkT: 2.2,
        seenBurst: e.kind === 'debris' && e.state === 'burst',
        ember: 0,
      };
      this.anims.set(e.id, a);
    }
    return a;
  }

  /**
   * One entity as a lit actor: which frame, how big, and how far its origin
   * sits above the floor. `foot` is doing two jobs — it is the y-sort key
   * (feet, not centre) and the hinge the projected shadow leans away from — so
   * it is derived from the art's own anchor rather than guessed per kind.
   */
  private actorFor(e: Entity, view: RenderView, dt: number): ActorState | null {
    const sim = view.sim;
    // The carried fuse rides the robot's own rig.
    if (e.kind === 'fuse' && sim.robot.carrying === e.id) return null;

    const a = this.animFor(e);
    const t = this.t;

    // Spent crates and sockets stay as scenery. Everything else that dies fades
    // out over ~0.4s and then leaves — the same rate as the classic path, and
    // long enough that the death fx and the body agree about when it happened.
    if (e.dead && e.kind !== 'crate' && e.kind !== 'fuseSocket') {
      a.fade = Math.max(0, a.fade - dt * 2.5);
      if (a.fade <= 0.01) return null;
    }
    let x = e.pos.x;
    let y = e.pos.y;
    if (a.interp) {
      a.interp.push(sim.tick, e.pos.x, e.pos.y);
      x = a.interp.x(view.alpha);
      y = a.interp.y(view.alpha);
    }

    let name: ArtName = e.id === 'crate_triad' ? 'crate_triad' : KIND_ART[e.kind];
    let fi = 0;
    let flip = false;
    let scale = 1;
    let bob = 0;
    let tint = 0xffffff;
    /** Sort key override — flat things on the deck. */
    let z: number | undefined;
    let casts = true;
    /** Sideways shudder, px — the heap with something moving inside it. */
    let dx = 0;
    /** Warm glow leaking out of that heap, 0..1. */
    let ember = 0;

    switch (e.kind) {
      case 'scrap':
        fi = (t + a.phase) % 1.6 < 0.12 ? 1 : 0;
        break;
      case 'chip': {
        const cyc = ((t + a.phase) * 0.9) % 1;
        fi = Math.floor(cyc * 4);
        scale = CHIP_SCALE;
        // The bob is what makes a 7px object read as loot rather than as floor
        // texture. Its light now comes from the room, so the pool and the halo
        // the classic path draws are gone.
        bob = -1.5 - 1.5 * (0.5 + 0.5 * Math.sin(cyc * Math.PI * 2));
        break;
      }
      case 'crate': {
        const triad = e.id === 'crate_triad';
        const open = e.state === 'open';
        const spent = open || e.dead === true;
        scale = triad ? CRATE_SCALE : CRATE_SCALE_PLAIN;
        const cyc = ((t + a.phase) * 0.8) % 1;
        fi = triad ? (spent ? 0 : Math.floor(cyc * 4)) : open ? 1 : 0;
        if (!spent) bob = Math.round(Math.sin((t + a.phase) * 2.1) * 1.2);
        // A looted crate stops advertising itself, or the player walks back to
        // it all game. Same grey the classic path uses.
        else tint = 0x8a8f96;
        break;
      }
      case 'cable':
        fi = Math.floor((t + a.phase) * 8);
        // A cable LIES on the deck. Sorting it by its own y let the robot pass
        // behind a thing it is driving over, and a flat strip casting a
        // silhouette reads as a strip hovering above the floor.
        z = y - 100;
        casts = false;
        break;
      case 'debris': {
        // The heap that breathes before the robot comes out of it. Shared with
        // the classic path — see render/pile.ts.
        const r = updatePile({
          fx: this.fx,
          art: this.art,
          state: a,
          rng: a.rng,
          id: e.id,
          x,
          y,
          burst: e.state === 'burst',
          stir: view.ui.pileStir,
          t,
          dt,
        });
        fi = r.frame;
        dx = r.dx;
        ember = r.ember;
        break;
      }
      case 'fusedPrinter': {
        a.motion += Math.hypot(x - a.lastX, y - a.lastY) * 0.28;
        a.spitMs = Math.max(0, a.spitMs - dt * 1000);
        if (a.spitMs > 0 || e.state === 'spit_tel') {
          name = 'fused_printer_spit';
          fi = a.spitMs > 0 ? 1 : 0;
        } else {
          fi = Math.floor(a.motion);
        }
        flip = e.facing === 'left';
        break;
      }
      case 'printerInnocent':
        fi = (t + a.phase) % 2.4 < 0.18 ? 1 : 0; // peaceful LED blink
        break;
      case 'fuseSocket':
        fi = e.state === 'filled' ? 1 : 0;
        break;
      case 'elevatorA':
      case 'elevatorB': {
        // Doors: closed→open is frame 0→3. A stays shut; B stands open until
        // the robot steps in and elevator_entered puts it in `closing`.
        const target = e.kind === 'elevatorA' || this.closing.has(e.id) ? 0 : 3;
        const d = target - a.frameF;
        const step = 10 * dt;
        a.frameF = Math.abs(d) <= step ? target : a.frameF + Math.sign(d) * step;
        fi = Math.round(a.frameF);
        // The lit shaft is the GOAL and the dead one is not; the difference has
        // to survive a room where both are in shadow.
        if (e.kind === 'elevatorA') tint = 0x878c94;
        else if (e.state !== 'lit') tint = 0x70747c;
        break;
      }
      default:
        break; // furniture. It sits there.
    }

    a.lastX = x;
    a.lastY = y;

    // The hit flash wins over any state tint: it is the newest news about this
    // body, and it lasts 90ms.
    a.flashMs = Math.max(0, a.flashMs - dt * 1000);
    if (a.flashMs > 0) tint = 0xff7070;

    const fs = frames(this.art, name);
    // Actor parts are centre-anchored; the art's anchor is wherever the sprite
    // was drawn to sit. This is the same placement the classic path gets from
    // anchoring the sprite directly.
    const place = actorPlacement(name, scale);
    const parts: ActorPart[] = [
      {
        texture: fs[((fi % fs.length) + fs.length) % fs.length]!,
        y: place.y + bob,
        scale,
        flip,
        tint,
      },
    ];
    // The ember rides IN FRONT of the heap, additive, so it reads as light
    // leaking out of the junk rather than as a lamp standing behind it. Every
    // debris pile carries one and the scenery ones simply sit at zero: a part
    // list that changes length rebuilds the whole rig.
    if (e.kind === 'debris') {
      parts.push({ texture: this.emberTex, y: -6, alpha: ember, additive: true });
    }
    const state: ActorState = { id: e.id, x: x + dx, y, parts, foot: place.foot };
    if (z !== undefined) state.z = z;
    if (!casts) state.shadow = false;
    if (a.fade < 1) state.alpha = a.fade;
    return state;
  }

  destroy(): void {
    this.fx.clear();
    this.markers.clear();
    this.projectiles.clear();
    // The sprite showing the target goes first — destroying a texture that a
    // live sprite still holds is how a floor change turns into a black frame.
    this.container.destroy({ children: true });
    this.rt.destroy(true);
    this.scene.destroy();
    this.post.destroy();
  }
}
