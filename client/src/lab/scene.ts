/**
 * The lab's shell around `render/lit`.
 *
 * Everything that draws lives in `LitScene` now. What is left here is the part
 * that is only ever true of the lab: one hard-coded room, three characters on
 * fixed patrol loops you can grab with the mouse, a camera that drifts, and the
 * per-frame push of `P` — a hundred sliders — into the renderer's look, engine
 * and debug state.
 *
 * The sliders are the reason this shell exists at all. A level carries a
 * `LevelLook`; the lab carries that plus every ENGINE number and every
 * bisection switch, because it is the place those were tuned. Nothing outside
 * `client/src/lab/` may import this file — imports flow lab → render/lit and
 * never back.
 */

import type { Renderer } from 'pixi.js';
import type { FixtureDef } from '@shared/types';
import { TILE } from '@shared/types';
import type { PixiArtAtlas } from '../art';
import { LitScene } from '../render/lit/scene';
import {
  resolveLook,
  type ActorPart,
  type ActorState,
  type EngineLook,
  type LitDebug,
  type SceneDef,
} from '../render/lit/types';
import type { LampStyle, WallStyle } from '../render/lit/fixtures';
import { LAB_DECOR, LAB_LIGHTS, LAB_MAP, LAB_SEED, LAB_TILES, WET_PATCHES } from './level';
import { P } from './params';

const VW = 480;
const VH = 270;

/** One patrolling character. The lab's stand-in for a sim entity. */
interface Walker {
  id: string;
  kind: 'robot' | 'printer';
  x: number;
  y: number;
  /** Animation clock, seconds. */
  t: number;
  path: Array<[number, number]>;
  leg: number;
  /** Previous position — facing comes from actual motion while being dragged. */
  lastX: number;
  lastY: number;
  speed: number;
  /** Heading this frame, for head frames and printer flip. */
  dx: number;
  dy: number;
}

/** Tile centre, not tile corner — a waypoint at `TILE * n` sits half a tile off
 *  from where it reads in the map string, which is how the old paths ended up
 *  driving through the pillars. */
const at = (tx: number, ty: number): [number, number] => [
  tx * TILE + TILE / 2,
  ty * TILE + TILE / 2,
];

/** The lab's room, as the renderer's data contract. */
function labSceneDef(): SceneDef {
  return {
    map: LAB_MAP,
    seed: LAB_SEED,
    decor: LAB_DECOR,
    lights: LAB_LIGHTS,
    fixtures: labFixtures(),
    wetPatches: WET_PATCHES,
    tiles: LAB_TILES,
    look: resolveLook(),
  };
}

/**
 * Seed every fixture from the flat slider bag. `P` has ONE `lampStyle` in it and
 * the room has six lamps, so this is the moment the two shapes meet: after this
 * each fixture owns its own copy and the panel edits them one at a time.
 */
function labFixtures(): FixtureDef[] {
  const out: FixtureDef[] = [];
  for (const d of LAB_DECOR) {
    if (!d.fixtureId) continue;
    out.push(
      d.fixtureKind === 'wall'
        ? {
            id: d.fixtureId,
            kind: 'wall',
            style: P.wallStyle,
            scale: P.wallScale,
            bodyAlpha: P.wallBodyAlpha,
            glow: P.wallGlow,
            mountY: P.wallMountY,
            lightX: P.wallLightX,
            lightY: P.wallLightY,
            spill: P.wallSpill,
          }
        : {
            id: d.fixtureId,
            kind: 'ceiling',
            style: P.lampStyle,
            scale: P.lampScale,
            bodyAlpha: P.lampBodyAlpha,
            glow: P.lampGlow,
          },
    );
  }
  return out;
}

export class LabScene {
  readonly lit: LitScene;

  private walkers: Walker[] = [];
  private dragging: Walker | null = null;
  private t = 0;
  private lastFixtureTarget = 'all';
  private lastWallTarget = 'all';

  /** Set by main.ts — pushes renderer-side changes back into the widgets. */
  onParamsChanged: (() => void) | null = null;

  constructor(
    renderer: Renderer,
    private art: PixiArtAtlas,
  ) {
    this.lit = new LitScene(renderer, art, labSceneDef());
    this.buildWalkers();
    if (import.meta.env.DEV) this.assertPathsWalkable();
  }

  /** The display object main.ts hangs its post chain on. */
  get root() {
    return this.lit.root;
  }

  // ------------------------------------------------------------- characters

  /**
   * The robot and two printers, driving fixed loops. Not a sim — the point is
   * to judge the game's actual hero sprite under this lighting, because a room
   * that looks great and makes the character look wrong is a failed room.
   */
  private buildWalkers(): void {
    const mk = (
      id: string,
      kind: Walker['kind'],
      path: Array<[number, number]>,
      speed: number,
    ): Walker => ({
      id,
      kind,
      x: path[0]![0],
      y: path[0]![1],
      t: 0,
      path,
      leg: 0,
      lastX: path[0]![0],
      lastY: path[0]![1],
      speed,
      dx: 1,
      dy: 0,
    });

    this.walkers = [
      // Loop around the middle pillar, along the hazard lane and back. Every
      // segment is verified walkable below.
      mk('robot', 'robot', [at(6.6, 6.9), at(17.0, 6.9), at(17.0, 10.4), at(6.6, 10.4)], 34),
      // Straight patrol across the open north band.
      mk('printer_a', 'printer', [at(9.0, 6.0), at(15.0, 6.0)], 20),
      // Straight patrol down the open lane east of the lower pillar.
      mk('printer_b', 'printer', [at(16.0, 10.4), at(16.0, 13.6)], 17),
    ];
  }

  /**
   * Walk every actor segment at sub-tile steps and complain about any that
   * clips solid geometry.
   *
   * These paths are authored by hand against an ASCII map, which is exactly the
   * kind of thing that silently rots the next time a wall moves — and a robot
   * gliding through a pillar destroys the illusion faster than any lighting bug
   * can build it. Cheap to check once at build, so check it.
   */
  private assertPathsWalkable(): void {
    const solid = (x: number, y: number): boolean =>
      (LAB_MAP[Math.floor(y / TILE)]?.[Math.floor(x / TILE)] ?? '#') === '#';
    for (const a of this.walkers) {
      const r = a.kind === 'robot' ? 9 : 11;
      for (let i = 0; i < a.path.length; i++) {
        const [x0, y0] = a.path[i]!;
        const [x1, y1] = a.path[(i + 1) % a.path.length]!;
        const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4);
        for (let s = 0; s <= steps; s++) {
          const x = x0 + ((x1 - x0) * s) / steps;
          const y = y0 + ((y1 - y0) * s) / steps;
          // sample the body's own box, not just its centre
          if (
            solid(x - r, y - r) || solid(x + r, y - r) ||
            solid(x - r, y + r) || solid(x + r, y + r)
          ) {
            console.warn(
              `[lab] ${a.kind} path leg ${i} clips a wall near ${Math.round(x)},${Math.round(y)}`,
            );
            break;
          }
        }
      }
    }
  }

  private stepWalkers(dt: number): void {
    for (const a of this.walkers) {
      const held = this.dragging === a;
      const to = a.path[(a.leg + 1) % a.path.length]!;
      let dx = to[0] - a.x;
      let dy = to[1] - a.y;
      if (held || !P.autoWalk) {
        // A held character faces where it is actually being moved, not where
        // its abandoned waypoint happens to be.
        dx = a.x - a.lastX;
        dy = a.y - a.lastY;
        if (Math.hypot(dx, dy) < 0.01) {
          dx = to[0] - a.x;
          dy = to[1] - a.y;
        }
      } else {
        const d = Math.hypot(dx, dy);
        if (d < 1.5) {
          a.leg = (a.leg + 1) % a.path.length;
        } else {
          a.x += (dx / d) * a.speed * dt;
          a.y += (dy / d) * a.speed * dt;
        }
      }
      a.lastX = a.x;
      a.lastY = a.y;
      a.t += dt;
      a.dx = dx;
      a.dy = dy;
    }
  }

  /** Current frames for one walker, in the layer order the rig expects. */
  private partsOf(a: Walker): ActorPart[] {
    if (a.kind === 'robot') {
      const wf = this.art.frames('robot_wheels');
      const bf = this.art.frames('robot_body');
      const hf = this.art.frames('robot_head');
      // head frames run E,SE,S,SW,W,NW,N,NE
      const ang = Math.atan2(a.dy, a.dx);
      const idx = ((Math.round((ang / (Math.PI * 2)) * 8) % 8) + 8) % 8;
      const bob = Math.sin(a.t * 7) > 0 ? 0 : 1;
      return [
        { texture: wf[Math.floor(a.t * 12) % wf.length]!, y: 5 },
        { texture: bf[Math.floor(a.t * 3) % bf.length]!, y: -1 + bob },
        { texture: hf[idx]!, y: -10 + bob },
      ];
    }
    const pf = this.art.frames('fused_printer');
    return [{ texture: pf[Math.floor(a.t * 6) % pf.length]!, y: 0, flip: a.dx < 0 }];
  }

  private actorStates(): ActorState[] {
    return this.walkers.map((a) => ({
      id: a.id,
      x: a.x,
      y: a.y,
      parts: this.partsOf(a),
    }));
  }

  // ---------------------------------------------------------------- params

  /**
   * `P` is a flat bag the panel mutates in place; the renderer wants three
   * typed records. Pushed whole every frame rather than diffed — it is a few
   * dozen field writes against a full deferred lighting pass.
   */
  private pushParams(): void {
    this.lit.updateLook({
      ambientLevel: P.ambientLevel,
      ambientColor: P.ambientColor,
      fogColor: P.fogColor,
      fogAmount: P.fogAmount,
      fogHeight: P.fogHeight,
      lightGain: P.lightGain,
      lightRadiusScale: P.lightRadiusScale,
      lightFalloff: P.lightFalloff,
      lightFlicker: P.lightFlicker,
      lightSpill: P.lightSpill,
      volumeStrength: P.volumeStrength,
      volumeWidth: P.volumeWidth,
      volumeLength: P.volumeLength,
      dustAmount: P.dustAmount,
      dustBrightness: P.dustBrightness,
      reflectOn: P.reflectOn,
      reflectAlpha: P.reflectAlpha,
      reflectSquash: P.reflectSquash,
      reflectWobble: P.reflectWobble,
      exposure: P.exposure,
      contrast: P.contrast,
      saturation: P.saturation,
      gamma: P.gamma,
      liftColor: P.liftColor,
      liftAmount: P.liftAmount,
      gainColor: P.gainColor,
      gainAmount: P.gainAmount,
    });

    const engine: EngineLook = {
      lightsOn: P.lightsOn,
      emissiveGain: P.emissiveGain,
      volumeOn: P.volumeOn,
      shadowsOn: P.shadowsOn,
      shadowAlpha: P.shadowAlpha,
      shadowSoftness: P.shadowSoftness,
      shadowLength: P.shadowLength,
      shadowBias: P.shadowBias,
      shadowFade: P.shadowFade,
      shadowNear: P.shadowNear,
      shadowBands: P.shadowBands,
      spriteShadowOn: P.spriteShadowOn,
      spriteShadowAlpha: P.spriteShadowAlpha,
      spriteShadowLength: P.spriteShadowLength,
      spriteShadowCount: P.spriteShadowCount,
      spriteShadowFoot: P.spriteShadowFoot,
      spriteShadowSoftness: P.spriteShadowSoftness,
      spriteShadowSquash: P.spriteShadowSquash,
      aoOn: P.aoOn,
      aoStrength: P.aoStrength,
      aoRadius: P.aoRadius,
      rimOn: P.rimOn,
      rimStrength: P.rimStrength,
      rimOffset: P.rimOffset,
      charLightResponse: P.charLightResponse,
      charTint: P.charTint,
      bloomOn: P.bloomOn,
      bloomThreshold: P.bloomThreshold,
      bloomScale: P.bloomScale,
      bloomBrightness: P.bloomBrightness,
      bloomBlur: P.bloomBlur,
      vignette: P.vignette,
      vignetteSoft: P.vignetteSoft,
      chroma: P.chroma,
      grain: P.grain,
      scanline: P.scanline,
      crtOn: P.crtOn,
      crtCurve: P.crtCurve,
    };
    this.lit.setEngine(engine);

    const debug: LitDebug = {
      layerFloor: P.layerFloor,
      layerWalls: P.layerWalls,
      layerProps: P.layerProps,
      layerCharacters: P.layerCharacters,
      layerPropShadows: P.layerPropShadows,
      layerBodyShadows: P.layerBodyShadows,
      layerContact: P.layerContact,
      layerReflect: P.layerReflect,
      layerRim: P.layerRim,
      layerEmissive: P.layerEmissive,
      layerDust: P.layerDust,
      layerVolume: P.layerVolume,
      layerFog: P.layerFog,
      layerLightmap: P.layerLightmap,
      layerMasks: P.layerMasks,
      lmAmbient: P.lmAmbient,
      lmLights: P.lmLights,
      lmAo: P.lmAo,
      lmShadowVolumes: P.lmShadowVolumes,
      lmPropOccluders: P.lmPropOccluders,
      lmFootprints: P.lmFootprints,
      lmSpill: P.lmSpill,
      showLightmap: P.showLightmap,
      showOccluders: P.showOccluders,
    };
    this.lit.setDebug(debug);
  }

  /**
   * Route the four lamp sliders to whichever fixture the panel is pointed at.
   *
   * Switching `fixtureTarget` LOADS that lamp's settings back into `P` and asks
   * the panel to resync, so the sliders always show the state of the thing you
   * are about to edit rather than whatever the last lamp was left on.
   */
  private applyFixtureTargets(): void {
    // ceiling and wall fixtures each own a target + their own controls
    const groups = [
      {
        kind: 'ceiling' as const,
        target: P.fixtureTarget,
        last: this.lastFixtureTarget,
        load: (f: Readonly<FixtureDef>) => {
          P.lampStyle = f.style as LampStyle;
          P.lampScale = f.scale ?? 1;
          P.lampBodyAlpha = f.bodyAlpha ?? 1;
          P.lampGlow = f.glow ?? 1;
        },
        store: (): Partial<FixtureDef> => ({
          style: P.lampStyle,
          scale: P.lampScale,
          bodyAlpha: P.lampBodyAlpha,
          glow: P.lampGlow,
        }),
        setLast: (v: string) => (this.lastFixtureTarget = v),
      },
      {
        kind: 'wall' as const,
        target: P.wallTarget,
        last: this.lastWallTarget,
        load: (f: Readonly<FixtureDef>) => {
          P.wallStyle = f.style as WallStyle;
          P.wallScale = f.scale ?? 1;
          P.wallBodyAlpha = f.bodyAlpha ?? 1;
          P.wallGlow = f.glow ?? 1;
          P.wallMountY = f.mountY ?? 0;
          P.wallLightX = f.lightX ?? 0;
          P.wallLightY = f.lightY ?? 0;
          P.wallSpill = f.spill ?? 1;
        },
        store: (): Partial<FixtureDef> => ({
          style: P.wallStyle,
          scale: P.wallScale,
          bodyAlpha: P.wallBodyAlpha,
          glow: P.wallGlow,
          mountY: P.wallMountY,
          lightX: P.wallLightX,
          lightY: P.wallLightY,
          spill: P.wallSpill,
        }),
        setLast: (v: string) => (this.lastWallTarget = v),
      },
    ];

    for (const g of groups) {
      if (g.target !== g.last) {
        g.setLast(g.target);
        const f = this.lit.getFixture(g.target);
        // Switching target LOADS that fixture's settings, so the sliders always
        // show the state of the thing you are about to edit.
        if (f && f.kind === g.kind) {
          g.load(f);
          this.onParamsChanged?.();
        }
      } else {
        const next = g.store();
        for (const id of this.lit.fixtureIds(g.kind)) {
          if (g.target !== 'all' && g.target !== id) continue;
          this.lit.setFixture(id, next);
        }
      }
    }
  }

  // -------------------------------------------------------------- per frame

  update(dtRaw: number): void {
    const dt = P.paused ? 0 : dtRaw * P.timeScale;
    this.t += dt;
    const t = this.t;

    this.pushParams();
    this.applyFixtureTargets();

    // ------------------------------------------------------------- camera
    const drift = P.cameraDrift;
    const shake = P.cameraShake;
    const ox =
      Math.sin(t * 0.23) * 3.5 * drift +
      (shake > 0 ? (Math.sin(t * 61.7) + Math.sin(t * 43.1)) * shake : 0);
    const oy =
      Math.cos(t * 0.17) * 2.2 * drift +
      (shake > 0 ? (Math.sin(t * 55.3) + Math.sin(t * 71.9)) * shake * 0.7 : 0);
    const z = P.cameraZoom;
    this.lit.setCamera(VW / 2 - (VW / 2) * z + ox, VH / 2 - (VH / 2) * z + oy, z);

    this.stepWalkers(dt);
    this.lit.updateActors(this.actorStates());
    this.lit.update(dt);
  }

  // ------------------------------------------------------------------ drag

  /** Is there a character under this point? Robot wins ties — it is the one
   *  anyone actually wants to move. */
  pickActor(feedX: number, feedY: number): boolean {
    const { x, y } = this.lit.toWorld(feedX, feedY);
    return this.findWalker(x, y) !== null;
  }

  private findWalker(x: number, y: number): Walker | null {
    const R2 = 15 * 15;
    let best: Walker | null = null;
    let bestD = R2;
    for (const a of this.walkers) {
      // measured against the middle of the body, not the origin
      const d = (a.x - x) ** 2 + (a.y - 4 - y) ** 2;
      if (d > R2) continue;
      // the robot outranks an enemy it happens to be standing on
      const wins = a.kind === 'robot' && best?.kind !== 'robot' ? true : d < bestD;
      if (wins) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  beginDrag(feedX: number, feedY: number): boolean {
    const { x, y } = this.lit.toWorld(feedX, feedY);
    this.dragging = this.findWalker(x, y);
    return this.dragging !== null;
  }

  dragTo(feedX: number, feedY: number): void {
    if (!this.dragging) return;
    const { x, y } = this.lit.toWorld(feedX, feedY);
    // Clamped to the room so a character cannot be lost outside the walls.
    this.dragging.x = Math.max(TILE, Math.min(VW - TILE, x));
    this.dragging.y = Math.max(TILE, Math.min(TILE * (LAB_MAP.length - 1), y));
  }

  /** Released: hand the character back to the nearest point on its own loop, so
   *  auto-walk resumes without a march back across the whole room. */
  endDrag(): void {
    const a = this.dragging;
    this.dragging = null;
    if (!a) return;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < a.path.length; i++) {
      const d = (a.path[i]![0] - a.x) ** 2 + (a.path[i]![1] - a.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    a.leg = best;
  }

  /** New tile variants and grime, same layout. */
  reseed(): void {
    this.lit.reseed((Math.floor(performance.now()) % 100000) + 1);
  }

  stats(): string {
    return this.lit.stats();
  }
}
