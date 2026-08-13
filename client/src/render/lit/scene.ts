/**
 * The lit scene graph and its per-frame update.
 *
 * Layer order, outermost first — the order IS the lighting model:
 *
 *   litWorld   tiles, reflections, sprite shadows, props   × lightmap  (multiply)
 *   glowLayer  rim lights, emissive faces, dust            + on top    (additive)
 *   volume     light shafts                                + on top    (additive)
 *   fog        flat + gradient haze                        + on top    (additive)
 *
 * Anything additive is deliberately OUTSIDE the multiply: a lamp face that gets
 * multiplied by its own lightmap goes grey the moment ambient drops, which is
 * the single most common way a 2D lighting rig ends up looking wrong.
 *
 * The camera here is IDENTITY unless someone calls `setCamera` — pan and zoom
 * belong on the composed output sprite, not in here. Moving this camera bumps
 * the lightmap's geometry version, which re-bakes every light; a designer
 * dragging the view would re-bake forty of them per frame. The graphics lab
 * uses it for idle drift and shake, which move by pixels and rarely.
 *
 * Read README.md in this directory before changing anything about where a pass
 * draws. Four of the rules in it each cost a debugging session.
 */

import {
  AlphaFilter,
  BlurFilter,
  Container,
  Matrix,
  Graphics,
  Rectangle,
  Renderer,
  RenderTexture,
  Sprite,
  Texture,
} from 'pixi.js';
import type { FixtureDef, LevelLook, LightPlacement } from '@shared/types';
import { TILE } from '@shared/types';
import { Px } from '../../art/px';
import type { PixiArtAtlas } from '../../art';
import { canvasTex, glowTex, hashStr } from '../util';
import { DECOR, type DecorEntry, type DecorName } from './decor';
import { LightMap, scaleColor, type LightDef, type LightParams, type Rect } from './lighting';
import { LightmapFilter } from './filters';
import {
  drawLitFloor,
  drawLitTileShadow,
  drawLitWallFace,
  drawLitWallTop,
  FLOOR_STRIPE,
  LIT_TILE_FRAMES,
} from './litTiles';
import {
  DEBUG_DEFAULTS,
  ENGINE_DEFAULTS,
  type ActorState,
  type EngineLook,
  type LightState,
  type LitDebug,
  type ResolvedLook,
  type SceneDef,
} from './types';
import {
  LAMP_STYLES,
  WALL_STYLES,
  type FixtureStyle,
} from './fixtures';

const VW = 480;
const VH = 270;

/**
 * Distance from an actor's origin down to the floor it stands on. The robot's
 * wheels sit at +5 and are 8px tall, the printer's hull bottoms out at the same
 * place — so both feet land here, and this is the number that puts an actor on
 * the same y-sort footing as a prop anchored at its ground contact.
 */
export const ACTOR_FOOT = 9;

/** Rigs allocated per character. `spriteShadowCount` picks how many are used. */
const MAX_BODY_SHADOWS = 4;

/** Per-channel product of two 0xRRGGBB tints — how a caller's tint rides on top
 *  of the light response instead of replacing it. */
function mulColor(a: number, b: number): number {
  const r = (((a >> 16) & 0xff) * ((b >> 16) & 0xff)) / 255;
  const g = (((a >> 8) & 0xff) * ((b >> 8) & 0xff)) / 255;
  const bl = ((a & 0xff) * (b & 0xff)) / 255;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

/** Perceptual brightness of an 0xRRGGBB, 0..1. */
function luma(c: number): number {
  return (
    (((c >> 16) & 0xff) * 0.2126 + ((c >> 8) & 0xff) * 0.7152 + (c & 0xff) * 0.0722) / 255
  );
}

/** Wall occluders, merged into horizontal runs so the shadow pass has fewer rects. */
export function wallOccluders(map: readonly string[]): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y < map.length; y++) {
    const row = map[y]!;
    let run = -1;
    for (let x = 0; x <= row.length; x++) {
      const solid = row[x] === '#';
      if (solid && run < 0) run = x;
      if (!solid && run >= 0) {
        out.push({ x: run * TILE, y: y * TILE, w: (x - run) * TILE, h: TILE });
        run = -1;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ helpers

function texFromDrawer(
  w: number,
  h: number,
  frames: number,
  draw: (p: Px, frame: number) => void,
): Texture[] {
  const out: Texture[] = [];
  for (let f = 0; f < frames; f++) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    draw(new Px(ctx, w, h), f);
    const t = Texture.from(canvas);
    t.source.scaleMode = 'nearest';
    out.push(t);
  }
  return out;
}

/** Vertical haze gradient — `bias` 0 = flat wash, 1 = pools at the floor. */
function fogTex(bias: number): Texture {
  const t = canvasTex(4, 64, (ctx) => {
    for (let y = 0; y < 64; y++) {
      const v = 1 - bias + bias * (y / 63) ** 1.6;
      ctx.fillStyle = `rgba(255,255,255,${v.toFixed(3)})`;
      ctx.fillRect(0, y, 4, 1);
    }
  });
  t.source.scaleMode = 'linear';
  return t;
}

/** Soft blob used for every projected sprite shadow. */
function blobTex(): Texture {
  return glowTex(64, 'rgba(0,0,0,1)');
}

/**
 * Make `to` occupy exactly the same space as `from`, down to the bounds spacer.
 * Used to park the body-shadow rigs that this frame has no light for — see the
 * comment at the call site.
 */
function copyShadowGeometry(
  from: ActorView['shadows'][number],
  to: ActorView['shadows'][number],
): void {
  to.root.setFromMatrix(from.root.localTransform);
  to.spacer.visible = from.spacer.visible;
  to.spacer.width = from.spacer.width;
  to.spacer.height = from.spacer.height;
  to.spacer.position.copyFrom(from.spacer.position);
  for (let i = 0; i < to.parts.length; i++) {
    const src = from.parts[i];
    const dst = to.parts[i]!;
    if (!src) continue;
    dst.texture = src.texture;
    dst.scale.copyFrom(src.scale);
    dst.x = src.x;
    dst.y = src.y;
  }
}

/** A light's authored tile position in px. Lights sit at tile CENTRES. */
const lightPx = (t: number): number => t * TILE + TILE / 2;

/**
 * Tile-space placement → the px-space definition the lightmap bakes.
 *
 * Optional keys are COPIED ONLY WHEN SET. `LightMap.add` spreads the def over
 * its own defaults, so handing it `kind: undefined` would overwrite `'point'`
 * with nothing — the kind of bug that shows up as one lamp in forty behaving
 * differently.
 */
function toLightDef(p: LightPlacement): LightDef {
  const d: LightDef = {
    id: p.id,
    x: lightPx(p.tx),
    y: lightPx(p.ty),
    radius: p.radius,
    color: p.color,
    intensity: p.intensity,
  };
  if (p.kind !== undefined) d.kind = p.kind;
  if (p.dir !== undefined) d.dir = p.dir;
  if (p.spread !== undefined) d.spread = p.spread;
  if (p.castShadow !== undefined) d.castShadow = p.castShadow;
  if (p.flicker !== undefined) d.flicker = p.flicker;
  if (p.flickerHz !== undefined) d.flickerHz = p.flickerHz;
  if (p.volumetric !== undefined) d.volumetric = p.volumetric;
  if (p.scale !== undefined) d.scale = p.scale;
  return d;
}

// -------------------------------------------------------------- prop views

interface PropView {
  root: Container;
  body: Sprite;
  rim: Sprite | null;
  glow: Sprite | null;
  shadow: Sprite | null;
  reflect: Sprite | null;
  frames: Texture[];
  glowFrames: Texture[] | null;
  fps: number;
  phase: number;
  /** ground position in world px */
  x: number;
  y: number;
  /** how tall the thing stands — drives shadow length */
  height: number;
  /** anchor Y of the body, needed to place the mirrored reflection */
  anchorY: number;
  entry: DecorEntry | null;
}

/** A moving thing: the robot, an enemy. Same lighting treatment as any prop. */
interface ActorView {
  root: Container;
  parts: Sprite[];
  rims: Sprite[];
  /** Small contact ellipse right under the feet — grounds the body. */
  shadow: Sprite;
  /** One projected silhouette per contributing light. */
  shadows: Array<{
    root: Container;
    inner: Container;
    parts: Sprite[];
    alpha: AlphaFilter;
    blur: BlurFilter;
    /** Invisible bounds spacer — see the comment where it is sized. */
    spacer: Sprite;
    /** last softness the filter stack was built for; avoids reassigning per frame */
    soft: number;
  }>;
  x: number;
  y: number;
  foot: number;
  /** Per-part tint from the caller, multiplied into the light response. */
  tints: number[];
  /** Which parts are LIGHT rather than surface: no rim, no silhouette. */
  emissive: boolean[];
  /** Whole-body fade. The shadows live outside `root`, so they need it by hand. */
  alpha: number;
  /** Does it cast? Flat things on the deck do not. */
  casts: boolean;
}

/** Runtime half of a FixtureDef: the sprite it drives and where it is bolted. */
interface FixtureView {
  def: FixtureDef;
  view: PropView | null;
  /** Authored position of the housing — every offset is relative to this. */
  baseX: number;
  baseY: number;
  /** Authored radius of the wall-wash point, before `spill` scales it. */
  spillBase: number;
}

export class LitScene {
  readonly root = new Container();
  readonly lightmap: LightMap;

  private def: SceneDef;
  private look: ResolvedLook;
  private engine: EngineLook = { ...ENGINE_DEFAULTS };
  private debug: LitDebug = { ...DEBUG_DEFAULTS };

  private cams: Container[] = [];
  private camA = new Container();
  private tileLayer = new Container();
  private groundShade = new Container();
  private aoGround: Sprite | null = null;
  private propShadowGround: Sprite | null = null;
  private reflectLayer = new Container();
  private shadowLayer = new Container();
  /** The y-sorted layer: tiles that stand up, props, characters. */
  readonly propLayer = new Container();
  private dustLayer = new Container();
  private volumeLayer = new Container();
  private litWorld = new Container();
  private glowLayer = new Container();
  private fogFlat = new Sprite(Texture.WHITE);
  private fogGrad: Sprite;
  private fogBias = -1;

  private lightFilter: LightmapFilter;

  private props: PropView[] = [];
  private actors = new Map<string, ActorView>();
  private volumes: Array<{ sp: Sprite; id: string; base: number }> = [];
  private dust: Array<{ sp: Sprite; vx: number; vy: number; life: number; age: number; ph: number }> = [];
  private dustPool: Sprite[] = [];
  private dustT = 0;
  /** Motes have their own stream. Sharing the tile seed made the room's
   *  dressing depend on how long the page had been open. */
  private dustSeed = 1;

  private fixtures = new Map<string, FixtureView>();
  private lampTex = new Map<string, { body: Texture[]; glow: Texture[] }>();

  /** Authored intensity per light, so `setLightState` can restore it. */
  private lightBase = new Map<string, number>();
  private lightOff = new Set<string>();

  private wetMask: Sprite | null = null;
  private floorMask: Sprite | null = null;

  private debugMap: Sprite;
  private debugOcc = new Container();
  private debugOccBuilt = false;

  private blob = blobTex();
  private wallRects: Rect[] = [];
  /** Solid tiles live in the sorted layer, not the flat one — see buildTiles. */
  private wallSprites: Sprite[] = [];
  private propRects: Rect[] = [];
  private t = 0;
  private tileSeed = 1;
  private camX = 0;
  private camY = 0;
  private camScale = 1;

  constructor(
    private renderer: Renderer,
    private art: PixiArtAtlas,
    def: SceneDef,
  ) {
    this.def = def;
    this.look = def.look;
    this.tileSeed = def.seed;
    this.dustSeed = def.seed;

    this.lightmap = new LightMap(renderer, VW, VH);
    this.lightFilter = new LightmapFilter(this.lightmap.texture, VW, VH);

    this.litWorld.filters = [this.lightFilter];
    this.litWorld.filterArea = new Rectangle(0, 0, VW, VH);

    const camA = this.camA;
    const camB = new Container();
    const camC = new Container();
    this.cams = [camA, camB, camC];

    this.propLayer.sortableChildren = true;
    // groundShade sits directly on the tiles and NOTHING that stands up is
    // below it — see updateGroundShade for why that matters.
    camA.addChild(
      this.tileLayer,
      this.groundShade,
      this.reflectLayer,
      this.shadowLayer,
      this.propLayer,
    );
    camB.addChild(this.dustLayer);
    camC.addChild(this.volumeLayer);

    this.litWorld.addChild(camA);
    this.glowLayer.addChild(camB);

    this.fogFlat.width = VW;
    this.fogFlat.height = VH;
    this.fogFlat.blendMode = 'add';
    this.fogGrad = new Sprite(fogTex(0.5));
    this.fogGrad.width = VW;
    this.fogGrad.height = VH;
    this.fogGrad.blendMode = 'add';

    const volRoot = new Container();
    volRoot.addChild(camC);

    this.debugMap = new Sprite(this.lightmap.texture);
    this.debugMap.visible = false;
    this.debugOcc.visible = false;
    camC.addChild(this.debugOcc);

    this.root.addChild(
      this.litWorld,
      this.glowLayer,
      volRoot,
      this.fogFlat,
      this.fogGrad,
      this.debugMap,
    );

    this.build();
  }

  // -------------------------------------------------------------- public API

  /**
   * Swap the room wholesale: new map, dressing, rig, water, look. Everything is
   * torn down and rebuilt, so this is the expensive one — a designer should
   * debounce it and reach for `updateLook` / `setLightState` / `setFixture` for
   * anything that is not structural.
   */
  setScene(def: SceneDef): void {
    this.teardown();
    this.def = def;
    this.look = def.look;
    this.tileSeed = def.seed;
    this.dustSeed = def.seed;
    this.build();
  }

  /** Cheap: a look change never rebuilds geometry. Safe to call every frame. */
  updateLook(patch: Partial<LevelLook>): void {
    Object.assign(this.look, patch);
  }

  /** Renderer behaviour, not level content. The graphics lab is the one caller
   *  that should ever move these. */
  setEngine(patch: Partial<EngineLook>): void {
    Object.assign(this.engine, patch);
  }

  /** Per-pass bisection switches. Never persisted anywhere: a saved
   *  `layerWalls: false` looks exactly like a rendering regression. */
  setDebug(patch: Partial<LitDebug>): void {
    Object.assign(this.debug, patch);
  }

  get lookState(): Readonly<ResolvedLook> {
    return this.look;
  }

  /**
   * Turn a light off, or override its intensity. The `_pt` companion a wall
   * sconce carries goes with it — they are one lamp as far as anyone looking at
   * the room is concerned.
   */
  setLightState(id: string, state: LightState): void {
    for (const key of [id, `${id}_pt`]) {
      if (!this.lightmap.get(key)) continue;
      if (state.intensity !== undefined) this.lightBase.set(key, state.intensity);
      if (state.on !== undefined) {
        if (state.on) this.lightOff.delete(key);
        else this.lightOff.add(key);
      }
      this.applyLightState(key);
    }
  }

  /** The fixture SPRITE, never its light. Swapping a style leaves the room lit. */
  setFixture(id: string, patch: Partial<FixtureDef>): void {
    const f = this.fixtures.get(id);
    if (f) Object.assign(f.def, patch);
  }

  getFixture(id: string): Readonly<FixtureDef> | undefined {
    return this.fixtures.get(id)?.def;
  }

  fixtureIds(kind?: 'ceiling' | 'wall'): string[] {
    const out: string[] = [];
    for (const [id, f] of this.fixtures) if (!kind || f.def.kind === kind) out.push(id);
    return out;
  }

  /**
   * The walkability grid was rewritten (a door opened). Rebuild the tiles, the
   * wall occluders and the floor mask, and re-bake — every one of those is
   * derived from the map, and a door that opens into a wall's shadow is a door
   * that did not open.
   */
  markTilesDirty(map?: readonly string[]): void {
    if (map) this.def = { ...this.def, map };
    this.rebuildTiles();
    this.buildFloorMask();
    this.debugOccBuilt = false;
    this.debugOcc.removeChildren().forEach((c) => c.destroy());
  }

  /** New tile variants, same layout. */
  reseed(seed: number): void {
    this.tileSeed = seed;
    this.rebuildTiles();
  }

  /**
   * Pan/zoom the world. Identity by default and it should usually stay there:
   * every call bumps the lightmap's geometry version, which re-bakes every
   * light in the room.
   */
  setCamera(x: number, y: number, scale: number): void {
    for (const c of this.cams) {
      c.position.set(x, y);
      c.scale.set(scale);
    }
    this.lightmap.setCamera(x, y, scale);
    this.camX = x;
    this.camY = y;
    this.camScale = scale;
  }

  /** Feed pixels (0..480, 0..270) to world pixels, undoing the camera. */
  toWorld(feedX: number, feedY: number): { x: number; y: number } {
    return {
      x: (feedX - this.camX) / this.camScale,
      y: (feedY - this.camY) / this.camScale,
    };
  }

  /**
   * Hand over the moving bodies for this frame: position, frames, facing. Rigs
   * are created and destroyed to match the ids, so a caller can hand over sim
   * entities that come and go without telling this class anything about them.
   *
   * Call BEFORE `update` — the lighting response runs inside it, once the
   * lightmap for the frame exists.
   */
  updateActors(states: readonly ActorState[]): void {
    const live = new Set<string>();
    for (const s of states) {
      live.add(s.id);
      let v = this.actors.get(s.id);
      if (!v || v.parts.length !== s.parts.length) {
        if (v) this.destroyActor(v);
        v = this.buildActor(s);
        this.actors.set(s.id, v);
      }
      this.applyActorState(v, s);
    }
    for (const [id, v] of this.actors) {
      if (live.has(id)) continue;
      this.destroyActor(v);
      this.actors.delete(id);
    }
  }

  stats(): string {
    return `${this.lightmap.lights.length} lights · ${this.props.length} props · ${this.dust.length} motes`;
  }

  // ------------------------------------------------------------------ build

  private build(): void {
    this.buildTiles();
    this.buildProps();
    for (const l of this.def.lights) {
      this.lightmap.add(toLightDef(l));
      this.lightBase.set(l.id, l.intensity);
    }
    this.buildVolumes();
    // Walls only. Props shadow the FLOOR — see groundShadowTexture.
    this.lightmap.setOccluders([...this.wallRects]);
    this.buildWetMask();
    this.buildFloorMask();
  }

  private teardown(): void {
    for (const v of this.actors.values()) this.destroyActor(v);
    this.actors.clear();
    this.tileLayer.removeChildren().forEach((c) => c.destroy());
    for (const w of this.wallSprites) w.destroy();
    this.wallSprites.length = 0;
    for (const p of this.props) {
      p.root.destroy({ children: true });
      p.shadow?.destroy();
      p.reflect?.destroy();
    }
    this.props.length = 0;
    this.propRects.length = 0;
    this.fixtures.clear();
    this.volumeLayer.removeChildren().forEach((c) => c.destroy());
    this.volumes.length = 0;
    for (const m of this.dust) m.sp.destroy();
    this.dust.length = 0;
    for (const sp of this.dustPool) sp.destroy();
    this.dustPool.length = 0;
    this.lightmap.clearLights();
    this.lightBase.clear();
    this.lightOff.clear();
    this.groundShade.removeChildren().forEach((c) => c.destroy());
    this.aoGround = null;
    this.propShadowGround = null;
    this.debugOcc.removeChildren().forEach((c) => c.destroy());
    this.debugOccBuilt = false;
  }

  /**
   * Soft alpha mask limiting reflections to the wet patches. Blurred so a
   * reflection fades in at the water's edge instead of being scissored off —
   * a hard-edged reflection reads as a bug, not as a puddle.
   */
  private buildWetMask(): void {
    // The mask SPRITE and its texture are made once and repainted, never
    // replaced — see the note on `maskTexture`.
    const rt = this.maskTexture('wet', 'linear');
    const root = new Container();
    const g = new Graphics();
    for (const w of this.def.wetPatches) {
      g.ellipse(w.tx * TILE, w.ty * TILE, w.rx * TILE, w.ry * TILE);
    }
    g.fill({ color: 0xffffff, alpha: 1 });
    root.addChild(g);
    root.filters = [new BlurFilter({ strength: 6, quality: 3 })];
    root.filterArea = new Rectangle(0, 0, VW, VH);
    this.renderer.render({ container: root, target: rt, clear: true });
    root.destroy({ children: true });
  }

  /**
   * The render texture behind one of the two masks, created on first use and
   * REPAINTED afterwards.
   *
   * Both masks are rebuilt when the room changes — a door opening calls
   * `markTilesDirty`, which redraws the floor mask. Building a fresh Sprite and
   * destroying the old one there crashes the next frame inside pixi's alpha
   * mask pipe: it caches a bind group per masked container, and the texture it
   * cached has just been destroyed. Repainting the same texture never
   * invalidates anything, and it allocates nothing per door.
   */
  private maskTexture(which: 'wet' | 'floor', scaleMode: 'linear' | 'nearest'): RenderTexture {
    const held = which === 'wet' ? this.wetMask : this.floorMask;
    if (held) return held.texture as RenderTexture;
    const rt = RenderTexture.create({ width: VW, height: VH, antialias: false });
    rt.source.scaleMode = scaleMode;
    const sp = new Sprite(rt);
    this.camA.addChild(sp);
    if (which === 'wet') {
      this.wetMask = sp;
      this.reflectLayer.mask = sp;
    } else {
      this.floorMask = sp;
      this.shadowLayer.mask = sp;
    }
    return rt;
  }

  /**
   * Mask limiting every projected shadow to the FLOOR.
   *
   * Shadows live in their own layer under the props, which already stops them
   * painting over furniture — but the walls and the pillar blocks are TILES, in
   * a layer below that, so a silhouette happily climbed straight up a pillar and
   * across a wall top. A shadow on a surface the light cannot reach past is the
   * kind of wrong that reads instantly even if you cannot name it.
   *
   * Hard-edged on purpose: a shadow meeting the base of a wall stops dead. A
   * blurred boundary would look like the shadow was bleeding through it.
   */
  private buildFloorMask(): void {
    const rt = this.maskTexture('floor', 'nearest');
    const g = new Graphics();
    const map = this.def.map;
    for (let y = 0; y < map.length; y++) {
      const row = map[y]!;
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== '#') g.rect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    g.fill({ color: 0xffffff, alpha: 1 });
    this.renderer.render({ container: g, target: rt, clear: true });
    g.destroy();
  }

  /** Tiles again from the current map and seed, and re-bake what depends on them. */
  private rebuildTiles(): void {
    this.tileLayer.removeChildren().forEach((c) => c.destroy());
    for (const w of this.wallSprites) w.destroy();
    this.wallSprites.length = 0;
    this.buildTiles();
    this.lightmap.setOccluders([...this.wallRects]);
  }

  private buildTiles(): void {
    const floor = texFromDrawer(TILE, TILE, LIT_TILE_FRAMES.floor, drawLitFloor);
    const face = texFromDrawer(TILE, TILE, LIT_TILE_FRAMES.wallFace, drawLitWallFace);
    const top = texFromDrawer(TILE, TILE, 1, drawLitWallTop);
    const shade = texFromDrawer(TILE, TILE, 1, drawLitTileShadow);
    const map = this.def.map;
    const solid = (x: number, y: number): boolean => (map[y]?.[x] ?? '#') === '#';

    // Deterministic variant pick — art must not boil between reseeds unless the
    // user actually asks for a reseed.
    const pick = (x: number, y: number, n: number, salt: number): number =>
      (hashStr(`${x}:${y}:${salt}:${this.tileSeed}`) >>> 3) % n;

    // Painted walkways run along whole rows. Scattering the stripe variant the
    // way the grime variants are scattered turns a painted lane into a field of
    // yellow dashes — the single loudest wrong note the first build had. A lane
    // has to be a LINE, which is why it is authored per ROW.
    const walkRows = new Set(this.def.tiles?.walkRows ?? []);
    const forced = new Map<string, number>();
    for (const o of this.def.tiles?.overrides ?? []) forced.set(`${o.tx},${o.ty}`, o.variant);

    for (let y = 0; y < map.length; y++) {
      const row = map[y]!;
      for (let x = 0; x < row.length; x++) {
        let sp: Sprite;
        let wall = false;
        const override = forced.get(`${x},${y}`);
        if (solid(x, y)) {
          wall = true;
          sp = new Sprite(
            !solid(x, y + 1) ? face[pick(x, y, face.length, 3)]! : top[0]!,
          );
        } else if (override !== undefined) {
          sp = new Sprite(floor[override % floor.length]!);
        } else if (walkRows.has(y) && pick(x, y, 100, 11) < 88) {
          sp = new Sprite(floor[FLOOR_STRIPE]!);
        } else {
          // Weighted: plain panels dominate, grates and lifted panels stay rare
          // enough that finding one is a small event.
          const r = pick(x, y, 100, 7);
          const fi =
            r < 26 ? 0 : r < 50 ? 1 : r < 70 ? 2 : r < 82 ? 7 : r < 91 ? 3 : r < 97 ? 4 : 5;
          sp = new Sprite(floor[fi]!);
        }
        sp.position.set(x * TILE, y * TILE);
        if (wall) {
          /**
           * Solid tiles go in the SORTED layer, keyed to their bottom edge.
           *
           * They used to sit in the flat tile layer under everything, which
           * meant a wall could never occlude anything — walk a character into a
           * doorway and the wall it is standing behind renders behind IT. A
           * wall is a solid object in the room, not a backdrop, so it sorts
           * like one: anything whose feet are above this tile's bottom edge is
           * behind it, anything below is in front.
           */
          sp.zIndex = (y + 1) * TILE;
          this.propLayer.addChild(sp);
          this.wallSprites.push(sp);
        } else {
          this.tileLayer.addChild(sp);
        }
        if (!solid(x, y) && solid(x, y - 1)) {
          const sh = new Sprite(shade[0]!);
          sh.position.set(x * TILE, y * TILE);
          this.tileLayer.addChild(sh);
        }
      }
    }
    this.wallRects = wallOccluders(map);
  }

  private buildProps(): void {
    const cache = new Map<DecorName, { body: Texture[]; glow: Texture[] | null }>();
    const texFor = (name: DecorName) => {
      let c = cache.get(name);
      if (!c) {
        // `DECOR` is `as const`, so entries without a `glow` key have no such
        // property to read — widen to the interface before asking.
        const e = DECOR[name] as DecorEntry;
        c = {
          body: texFromDrawer(e.w, e.h, e.frames, e.draw),
          glow: e.glow ? texFromDrawer(e.w, e.h, e.frames, e.glow) : null,
        };
        cache.set(name, c);
      }
      return c;
    };
    const fixtureDefs = new Map(this.def.fixtures.map((f) => [f.id, f]));

    for (const pl of this.def.decor) {
      const entry = DECOR[pl.name] as DecorEntry | undefined;
      if (!entry) continue;
      const { body: bodyTex, glow: glowTexes } = texFor(pl.name);
      const [ax, ay] = entry.anchor ?? [0.5, 0.5];
      const x = pl.tx * TILE;
      const y = pl.ty * TILE;

      const root = new Container();
      root.position.set(x, y);
      const body = new Sprite(bodyTex[0]!);
      body.anchor.set(ax, ay);
      if (pl.flip) body.scale.x = -1;
      root.addChild(body);
      if (pl.fixtureKind === 'wall') {
        /**
         * A wall lamp sorts with the WALL it is bolted to, not with the ceiling.
         *
         * It shares the ceiling flag for its other behaviours — no rim, no cast
         * shadow — but taking the ceiling z with it put the fixture in front of
         * everything, so a character walking past a sconce passed BEHIND a lamp
         * mounted at knee height on the far wall.
         *
         * Half a pixel above its wall tile's own key puts it on the wall and
         * still behind anything whose feet are further down the screen.
         */
        root.zIndex = (Math.floor(y / TILE) + 1) * TILE + 0.5;
      } else {
        root.zIndex = pl.ceiling ? 10_000 + y : y;
      }
      this.propLayer.addChild(root);

      // Rim and glow are CHILDREN of the prop, not members of a layer stacked
      // over the whole world.
      //
      // They used to live in a rim/emissive layer drawn above everything — so a
      // puddle's additive rim, or a terminal's lit screen, painted straight
      // through any character standing in front of it. The robot looked
      // semi-transparent, and the cause was never the robot.
      //
      // The cost of moving them in here is that the lightmap multiply now
      // applies to them too. That is survivable precisely because every
      // emissive prop is authored to sit inside its own light pool — it is
      // bright where it is bright — and a rim light only exists where there is
      // light to begin with.
      let rim: Sprite | null = null;
      if (!pl.ceiling) {
        rim = new Sprite(bodyTex[0]!);
        rim.anchor.set(ax, ay);
        rim.blendMode = 'add';
        if (pl.flip) rim.scale.x = -1;
        root.addChild(rim);
      }

      let glow: Sprite | null = null;
      if (glowTexes) {
        glow = new Sprite(glowTexes[0]!);
        glow.anchor.set(ax, ay);
        glow.blendMode = 'add';
        if (pl.flip) glow.scale.x = -1;
        root.addChild(glow);
      }

      const foot = pl.foot;
      let shadow: Sprite | null = null;
      if (!pl.ceiling && foot) {
        shadow = new Sprite(this.blob);
        shadow.anchor.set(0.5, 0.5);
        shadow.tint = 0x000000;
        this.shadowLayer.addChild(shadow);
      }

      let reflect: Sprite | null = null;
      if (pl.reflect) {
        reflect = new Sprite(bodyTex[0]!);
        reflect.anchor.set(ax, 1 - ay);
        reflect.scale.set(pl.flip ? -1 : 1, -1);
        reflect.position.set(x, y);
        this.reflectLayer.addChild(reflect);
      }

      if (foot) {
        this.propRects.push({
          x: x - foot[0] / 2,
          y: y - foot[1],
          w: foot[0],
          h: foot[1],
        });
      }

      const view: PropView = {
        root,
        body,
        rim,
        glow,
        shadow,
        reflect,
        frames: bodyTex,
        glowFrames: glowTexes,
        fps: entry.frames > 1 ? 6 : 0,
        phase: (hashStr(`${pl.name}${pl.tx}${pl.ty}`) % 1000) / 100,
        x,
        y,
        height: entry.h * ay,
        anchorY: ay,
        entry,
      };
      this.props.push(view);

      if (pl.fixtureId) {
        const kind = pl.fixtureKind === 'wall' ? 'wall' : 'ceiling';
        const authored = fixtureDefs.get(pl.fixtureId);
        this.fixtures.set(pl.fixtureId, {
          def: { id: pl.fixtureId, kind, style: 'none', ...authored },
          view,
          baseX: x,
          baseY: y,
          spillBase: 0,
        });
      }
    }
  }

  /**
   * Volumetric shafts. A cone light gets a matching cone of haze; a ceiling tube
   * gets a soft dome. Both are additive and both are OUTSIDE the lightmap, which
   * is what makes them read as light in the air rather than light on the floor.
   */
  private buildVolumes(): void {
    const coneHaze = canvasTex(96, 96, (ctx) => {
      const img = ctx.createImageData(96, 96);
      const cy = 47.5;
      for (let y = 0; y < 96; y++) {
        for (let x = 0; x < 96; x++) {
          const d = Math.hypot(x, y - cy) / 95;
          const a = Math.abs(Math.atan2(y - cy, x));
          const ang = Math.max(0, 1 - a / 0.55);
          const v = d >= 1 ? 0 : (1 - d) ** 1.6 * ang ** 2 * 0.9;
          const i = (y * 96 + x) * 4;
          img.data[i] = 255;
          img.data[i + 1] = 255;
          img.data[i + 2] = 255;
          img.data[i + 3] = Math.round(v * 255);
        }
      }
      ctx.putImageData(img, 0, 0);
    });
    coneHaze.source.scaleMode = 'linear';
    const domeHaze = glowTex(128, 'rgba(255,255,255,0.55)');

    for (const p of this.def.lights) {
      if (p.volumetric === false) continue;
      const isCone = p.kind === 'cone';
      if (!isCone && p.radius < 90) continue; // accents don't fill the air
      const sp = new Sprite(isCone ? coneHaze : domeHaze);
      sp.blendMode = 'add';
      sp.anchor.set(isCone ? 0 : 0.5, 0.5);
      sp.position.set(lightPx(p.tx), lightPx(p.ty));
      sp.rotation = p.dir ?? 0;
      sp.tint = p.color;
      this.volumeLayer.addChild(sp);
      this.volumes.push({ sp, id: p.id, base: isCone ? 1 : 0.55 });
    }
  }

  /** Textures for one fixture style, built on first use. */
  private fixtureTextures(
    kind: 'ceiling' | 'wall',
    style: string,
  ): { body: Texture[]; glow: Texture[] } {
    const key = `${kind}:${style}`;
    let t = this.lampTex.get(key);
    if (!t) {
      const table = (kind === 'wall' ? WALL_STYLES : LAMP_STYLES) as Record<
        string,
        FixtureStyle
      >;
      const f = table[style] ?? table.none!;
      t = {
        body: texFromDrawer(f.w, f.h, 1, f.draw),
        glow: texFromDrawer(f.w, f.h, 1, f.glow),
      };
      this.lampTex.set(key, t);
    }
    return t;
  }

  /**
   * Put each fixture's authored state onto its sprite, and its sprite's position
   * onto its light.
   *
   * The housing rides its wall face, and its LIGHT follows the housing — that
   * coupling is the point. Before it the sprite and the pool were two
   * independent authored positions, so moving one just made them disagree.
   */
  private applyFixtures(): void {
    for (const [id, f] of this.fixtures) {
      const { view } = f;
      if (!view) continue;
      const d = f.def;
      const scale = d.scale ?? 1;

      if (d.kind === 'wall') {
        const mountY = d.mountY ?? 0;
        view.root.y = f.baseY + mountY;
        view.y = view.root.y;
        // the cone that throws the pool, and the small point that lights the
        // fixture itself
        const cone = this.lightmap.get(id);
        if (cone) {
          cone.x = f.baseX + (d.lightX ?? 0);
          cone.y = f.baseY + mountY + (d.lightY ?? 0);
        }
        const pt = this.lightmap.get(`${id}_pt`);
        if (pt) {
          pt.x = f.baseX + (d.lightX ?? 0);
          pt.y = f.baseY + mountY;
          if (f.spillBase === 0) f.spillBase = pt.radius;
          pt.radius = f.spillBase * (d.spill ?? 1);
        }
      }
      const tex = this.fixtureTextures(d.kind, d.style);
      if (view.body.texture !== tex.body[0]) {
        view.body.texture = tex.body[0]!;
        view.frames = tex.body;
        if (view.glow) {
          view.glow.texture = tex.glow[0]!;
          view.glowFrames = tex.glow;
        }
      }
      view.body.scale.set(scale);
      view.body.alpha = d.bodyAlpha ?? 1;
      if (view.glow) {
        view.glow.scale.set(scale);
        // A killed lamp does not keep its own lit face on.
        const on = this.lightOff.has(id) ? 0 : 1;
        view.glow.alpha = this.engine.emissiveGain * (d.glow ?? 1) * on;
      }
    }
  }

  private applyLightState(id: string): void {
    const l = this.lightmap.get(id);
    if (!l) return;
    l.intensity = this.lightOff.has(id) ? 0 : (this.lightBase.get(id) ?? l.intensity);
  }

  // ------------------------------------------------------------- per frame

  private lightParams(): LightParams {
    const e = this.engine;
    const d = this.debug;
    return {
      ambientColor: this.look.ambientColor,
      ambientLevel: this.look.ambientLevel,
      gain: e.lightsOn ? this.look.lightGain : 0,
      radiusScale: this.look.lightRadiusScale,
      falloff: this.look.lightFalloff,
      flicker: this.look.lightFlicker,
      shadowsOn: e.shadowsOn && d.lmShadowVolumes,
      shadowAlpha: e.shadowAlpha,
      shadowSoftness: e.shadowSoftness,
      shadowLength: e.shadowLength,
      shadowBias: e.shadowBias,
      shadowFade: e.shadowFade,
      shadowNear: e.shadowNear,
      shadowBands: e.shadowBands,
      aoOn: e.aoOn && d.lmAo,
      aoStrength: e.aoStrength,
      aoRadius: e.aoRadius,
      showAmbient: d.lmAmbient,
      showLights: d.lmLights,
    };
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const look = this.look;
    const debug = this.debug;

    // -------------------------------------------------------------- lights
    const lp = this.lightParams();
    this.lightmap.update(t, lp);
    this.lightFilter.u.uParams[0] = debug.lmSpill ? look.lightSpill : 0;

    // --------------------------------------------------------------- props
    for (const p of this.props) this.updateProp(p, t);
    // after updateProp, which would otherwise stomp the fixtures' glow alpha
    this.applyFixtures();
    for (const a of this.actors.values()) this.updateActorLighting(a);

    // ---------------------------------------------------------- volumetrics
    for (const v of this.volumes) {
      const l = this.lightmap.get(v.id);
      if (!l) continue;
      v.sp.visible = this.engine.volumeOn && this.engine.lightsOn;
      if (!v.sp.visible) continue;
      // Haze breathes slightly out of step with the lamp so the air doesn't
      // look welded to the fixture.
      const breathe = 0.9 + 0.1 * Math.sin(t * 0.7 + l.phase);
      v.sp.alpha = look.volumeStrength * v.base * l.level * l.intensity * breathe;
      v.sp.tint = l.color;
      v.sp.position.set(l.x, l.y); // lights can move now; the haze goes with them
      const r = l.radius * look.lightRadiusScale * (l.scale ?? 1);
      if (l.kind === 'cone') {
        v.sp.width = r * look.volumeLength;
        v.sp.height = r * 2 * look.volumeWidth;
      } else {
        v.sp.width = r * 2 * look.volumeLength;
        v.sp.height = r * 2 * look.volumeWidth;
      }
    }

    // ----------------------------------------------------------------- dust
    this.updateDust(dt, t);

    // ------------------------------------------------------------------ fog
    const bias = Math.round(look.fogHeight * 50) / 50;
    if (bias !== this.fogBias) {
      this.fogBias = bias;
      this.fogGrad.texture.destroy(true);
      this.fogGrad.texture = fogTex(bias);
      this.fogGrad.width = VW;
      this.fogGrad.height = VH;
    }
    this.fogFlat.tint = look.fogColor;
    this.fogGrad.tint = look.fogColor;
    this.fogFlat.alpha = look.fogAmount * 0.35;
    this.fogGrad.alpha = look.fogAmount * 0.65;

    this.updateGroundShade();
    this.applyLayers();

    // ----------------------------------------------------------------- debug
    this.debugMap.visible = debug.showLightmap;
    this.debugOcc.visible = debug.showOccluders;
    if (debug.showOccluders && !this.debugOccBuilt) this.buildOccluderDebug();
    this.litWorld.visible = !debug.showLightmap;
    this.glowLayer.visible = !debug.showLightmap;
    this.fogFlat.visible = !debug.showLightmap;
    this.fogGrad.visible = !debug.showLightmap;
  }

  /**
   * One switch per draw pass.
   *
   * Applied at the END of update(), so it overrides every per-frame decision
   * the systems above have just made about their own visibility.
   */
  private applyLayers(): void {
    const d = this.debug;
    this.tileLayer.visible = d.layerFloor;
    this.groundShade.visible = d.layerFloor;
    for (const w of this.wallSprites) w.visible = d.layerWalls;
    this.reflectLayer.visible = d.layerReflect;
    this.dustLayer.visible = d.layerDust;
    this.volumeLayer.visible = d.layerVolume;
    this.fogFlat.visible = d.layerFog;
    this.fogGrad.visible = d.layerFog;

    for (const p of this.props) {
      p.root.visible = d.layerProps;
      if (p.rim && !d.layerRim) p.rim.visible = false;
      if (p.glow && !d.layerEmissive) p.glow.visible = false;
      if (p.shadow && !d.layerPropShadows) p.shadow.visible = false;
    }

    for (const a of this.actors.values()) {
      a.root.visible = d.layerCharacters;
      if (!d.layerContact) a.shadow.visible = false;
      for (const sh of a.shadows) if (!d.layerBodyShadows) sh.root.visible = false;
      if (!d.layerRim) for (const rim of a.rims) rim.visible = false;
    }

    const lit = d.layerLightmap && !d.showLightmap;
    if ((this.litWorld.filters as unknown[]).length !== (lit ? 1 : 0)) {
      this.litWorld.filters = lit ? [this.lightFilter] : [];
    }
    this.shadowLayer.mask = d.layerMasks ? this.floorMask : null;
    this.reflectLayer.mask = d.layerMasks ? this.wetMask : null;
  }

  /**
   * Contact darkening on the FLOOR — ambient occlusion and the dark patch under
   * each occluder's footprint.
   *
   * Both of these used to be composed into the lightmap, which meant they
   * darkened everything standing in the room, not just the ground. A prop's
   * foot rect is a hard axis-aligned rectangle slightly larger than its visible
   * base, so a character walking in front of a desk picked up a translucent
   * black box the exact shape of that rect — the artefact that took a
   * layer-by-layer bisect to pin down.
   *
   * They belong here instead: drawn straight onto the tiles, under everything
   * that stands up. The floor still darkens under the furniture, and a
   * character standing on that spot is lit by clean light. Wall shadow volumes
   * stay in the lightmap, because a body standing in a wall's shadow genuinely
   * IS in shadow.
   */
  private updateGroundShade(): void {
    const e = this.engine;
    const d = this.debug;
    // Prop shadows and prop footprints, on the floor only and in one pass so
    // they share a blur.
    const wantVol = d.lmPropOccluders && d.lmShadowVolumes;
    const wantProp = e.shadowsOn && (wantVol || d.lmFootprints);
    if (wantProp) {
      const tex = this.lightmap.groundShadowTexture(
        this.propRects,
        this.lightParams(),
        wantVol ? 0.55 : 0,
        d.lmFootprints,
      );
      if (tex && !this.propShadowGround) {
        this.propShadowGround = new Sprite(tex);
        this.propShadowGround.blendMode = 'multiply';
        this.groundShade.addChild(this.propShadowGround);
      }
    }
    if (this.propShadowGround) {
      this.propShadowGround.visible = wantProp;
      this.propShadowGround.alpha = e.shadowAlpha * 0.8;
    }

    const aoTex = this.lightmap.aoTexture;
    if (aoTex && !this.aoGround) {
      this.aoGround = new Sprite(aoTex);
      this.aoGround.blendMode = 'multiply';
      this.groundShade.addChildAt(this.aoGround, 0);
    }
    if (this.aoGround) {
      this.aoGround.visible = e.aoOn && d.lmAo;
      this.aoGround.alpha = e.aoStrength;
    }
  }

  private buildOccluderDebug(): void {
    this.debugOccBuilt = true;
    const g = new Graphics();
    for (const r of this.wallRects) g.rect(r.x, r.y, r.w, r.h);
    g.stroke({ color: 0x36e0b0, width: 1, alpha: 0.9 });
    for (const r of this.propRects) g.rect(r.x, r.y, r.w, r.h);
    g.stroke({ color: 0xff5b3c, width: 1, alpha: 0.9 });
    this.debugOcc.addChild(g);
  }

  private updateProp(p: PropView, t: number): void {
    const e = this.engine;
    const look = this.look;
    if (p.fps > 0) {
      const i = Math.floor((t + p.phase) * p.fps) % p.frames.length;
      p.body.texture = p.frames[i]!;
      if (p.rim) p.rim.texture = p.frames[i]!;
      if (p.reflect) p.reflect.texture = p.frames[i]!;
      if (p.glow && p.glowFrames) p.glow.texture = p.glowFrames[i]!;
    }

    const dom = this.lightmap.dominant(p.x, p.y - p.height * 0.5, look.lightRadiusScale);

    // ---- rim light: an additive copy nudged toward the light. On a 20px prop
    // one pixel of offset is the entire difference between "flat sticker" and
    // "object with a lit side", and it costs one sprite.
    if (p.rim) {
      if (!e.rimOn || !dom || !e.lightsOn) {
        p.rim.visible = false;
      } else {
        p.rim.visible = true;
        const dx = dom.l.x - p.x;
        const dy = dom.l.y - (p.y - p.height * 0.5);
        const len = Math.hypot(dx, dy) || 1;
        // local to the prop root now, so this is a pure offset
        p.rim.position.set((dx / len) * e.rimOffset, (dy / len) * e.rimOffset);
        p.rim.tint = dom.l.color;
        p.rim.alpha = e.rimStrength * dom.w * dom.l.level * 0.55;
      }
    }

    // ---- emissive face
    if (p.glow) {
      const near = this.nearestLight(p.x, p.y);
      p.glow.alpha = e.emissiveGain * (near ? 0.55 + 0.45 * near.level : 1);
      p.glow.visible = p.glow.alpha > 0.01;
    }

    // ---- projected shadow, away from the dominant light
    if (p.shadow) {
      if (!e.spriteShadowOn || !dom || !e.lightsOn) {
        p.shadow.visible = false;
      } else {
        p.shadow.visible = true;
        const dx = p.x - dom.l.x;
        const dy = p.y - dom.l.y;
        const len = Math.hypot(dx, dy) || 1;
        const stretch = 1 + (len / (dom.l.radius * look.lightRadiusScale)) * 1.6;
        const w = p.entry ? p.entry.w : 16;
        p.shadow.rotation = Math.atan2(dy, dx);
        p.shadow.width = w * 1.35 * stretch * e.spriteShadowLength;
        p.shadow.height = w * 1.15 * e.spriteShadowSquash;
        p.shadow.position.set(
          p.x + (dx / len) * p.shadow.width * 0.28,
          p.y + (dy / len) * p.shadow.width * 0.28 * 0.5,
        );
        p.shadow.alpha = e.spriteShadowAlpha * Math.min(1, dom.w * 2.2);
      }
    }

    // ---- wet-floor reflection: mirrored, squashed, and wobbling, so it reads
    // as water rather than as a sprite someone flipped.
    if (p.reflect) {
      p.reflect.visible = look.reflectOn;
      if (look.reflectOn) {
        const wob = Math.sin(t * 1.6 + p.phase) * 0.5 * look.reflectWobble;
        p.reflect.scale.set(
          (p.body.scale.x < 0 ? -1 : 1) * (1 + wob * 0.02),
          -look.reflectSquash,
        );
        p.reflect.position.set(p.x + wob, p.y + 1);
        p.reflect.alpha = look.reflectAlpha;
        p.reflect.tint = scaleColor(0xffffff, 0.75);
      }
    }
  }

  private nearestLight(x: number, y: number) {
    let best = null as ReturnType<LightMap['get']> | null;
    let bd = 26 * 26;
    for (const l of this.lightmap.lights) {
      const d = (l.x - x) ** 2 + (l.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    return best;
  }

  // ----------------------------------------------------------------- actors

  private buildActor(s: ActorState): ActorView {
    const root = new Container();
    const parts: Sprite[] = [];
    const rims: Sprite[] = [];
    // rims ride inside the actor, for the same reason props' do
    const rimRoot = new Container();
    this.propLayer.addChild(root);
    root.addChild(rimRoot);

    const shadow = new Sprite(this.blob);
    shadow.anchor.set(0.5);
    shadow.tint = 0x000000;
    this.shadowLayer.addChild(shadow);

    // The silhouette. Its parts are drawn at full black and the whole thing
    // is faded by an AlphaFilter rather than per-sprite alpha — three
    // overlapping semi-transparent black sprites double-darken where the head
    // crosses the body, and the seams read as a shadow with a seam in it. The
    // filter flattens them to one image first, then fades that.
    const shadows: ActorView['shadows'] = [];
    for (let i = 0; i < MAX_BODY_SHADOWS; i++) {
      const sroot = new Container();
      const sinner = new Container();
      const salpha = new AlphaFilter({ alpha: 1 });
      // Blur runs AFTER the shear, in screen space, so softness stays even
      // along the whole silhouette instead of stretching with it.
      const sblur = new BlurFilter({ strength: 1, quality: 2 });
      sinner.filters = [salpha];
      sroot.addChild(sinner);
      sroot.visible = false;
      // On the actor, not at the origin: a rig that never gets a light still
      // gets measured, and one parked in the corner of the room drags the whole
      // layer's bounds with it.
      sroot.position.set(s.x, s.y);
      this.shadowLayer.addChild(sroot);
      // Zero-alpha, purely to inflate the container's bounds. Pixi's blur
      // samples with edge CLAMPING, so a silhouette touching the border of
      // its own filter texture smears black out to that border — the faint
      // dark rectangle around the character, invisible on dark floor and
      // obvious the moment it crosses something lit. BlurFilter.padding
      // cannot fix it: pixi recomputes that from `strength`, clobbering
      // anything set by hand. Giving the content empty margin to bleed into
      // does fix it, because bounds are geometric and ignore alpha.
      const spacer = new Sprite(Texture.WHITE);
      spacer.anchor.set(0.5);
      spacer.alpha = 0;
      sinner.addChild(spacer);
      shadows.push({
        root: sroot,
        inner: sinner,
        parts: [],
        alpha: salpha,
        blur: sblur,
        spacer,
        soft: 0,
      });
    }

    const foot = s.foot ?? ACTOR_FOOT;
    for (const part of s.parts) {
      const tex = part.texture as Texture;
      const sp = new Sprite(tex);
      sp.anchor.set(0.5);
      sp.y = part.y;
      root.addChild(sp);
      parts.push(sp);
      const rim = new Sprite(tex);
      rim.anchor.set(0.5);
      rim.y = part.y;
      rim.blendMode = 'add';
      rimRoot.addChild(rim);
      rims.push(rim);
      // one silhouette twin per shadow rig, positioned relative to the FEET
      // rather than the body origin — the feet are what a shadow hinges on
      for (const sh of shadows) {
        const sil = new Sprite(tex);
        sil.anchor.set(0.5);
        sil.y = part.y - foot;
        sil.tint = 0x000000;
        sh.inner.addChild(sil);
        sh.parts.push(sil);
      }
    }

    return {
      root,
      parts,
      rims,
      shadow,
      shadows,
      x: s.x,
      y: s.y,
      foot,
      tints: parts.map(() => 0xffffff),
      emissive: parts.map(() => false),
      alpha: 1,
      casts: true,
    };
  }

  private destroyActor(a: ActorView): void {
    a.root.destroy({ children: true });
    a.shadow.destroy();
    for (const sh of a.shadows) sh.root.destroy({ children: true });
  }

  private applyActorState(a: ActorView, s: ActorState): void {
    a.x = s.x;
    a.y = s.y;
    a.foot = s.foot ?? ACTOR_FOOT;
    a.alpha = s.alpha ?? 1;
    a.casts = s.shadow ?? true;
    a.root.position.set(Math.round(s.x), Math.round(s.y));
    a.root.alpha = a.alpha;
    a.root.rotation = s.rotation ?? 0;
    a.root.scale.set(s.scaleX ?? 1, s.scaleY ?? 1);
    // Sort by the FEET, not the centre.
    //
    // A prop's zIndex is its anchor, which is its ground contact. An actor's
    // origin is the middle of its body, so sorting on `y` claimed it stood
    // ~9px further back than it does, and every prop standing level with the
    // robot — or even slightly behind it — drew on top. That reads as the
    // character being under the furniture, and it is a sorting bug, not a
    // lighting one.
    a.root.zIndex = s.z ?? s.y + a.foot;
    for (let i = 0; i < a.parts.length; i++) {
      const part = s.parts[i]!;
      const sp = a.parts[i]!;
      const k = part.scale ?? 1;
      sp.texture = part.texture as Texture;
      sp.y = part.y;
      sp.x = part.x ?? 0;
      sp.scale.set(part.flip ? -k : k, k);
      sp.alpha = part.alpha ?? 1;
      sp.blendMode = part.additive ? 'add' : 'normal';
      a.tints[i] = part.tint ?? 0xffffff;
      a.emissive[i] = part.additive === true;
    }
  }

  private updateActorLighting(a: ActorView): void {
    const e = this.engine;
    const look = this.look;
    const dom = this.lightmap.dominant(a.x, a.y - 8, look.lightRadiusScale);

    /**
     * Give the characters their own light response.
     *
     * They sit in the same multiply as the floor, and under a lamp the product
     * plus the colour-spill term drives the robot's already-bright orange
     * straight to white. The floor does not have that problem — it is a dark,
     * desaturated albedo, so the same lighting flatters it.
     *
     * Rather than tune the whole rig around one sprite, estimate the light
     * landing here and pre-darken the body by the inverse, scaled by the
     * response knob. At 1 nothing changes; at 0 the character renders at its
     * painted values no matter how hard the light hits it. Tint can only
     * darken, so this does nothing in the shadows — which is where the
     * characters read correctly already.
     */
    let lit = look.ambientLevel * luma(look.ambientColor);
    for (const c of this.lightmap.contributors(a.x, a.y - 8, look.lightRadiusScale, 4)) {
      lit += c.w * look.lightGain * luma(c.l.color);
    }
    lit *= 1 + look.lightSpill * 0.8; // the filter's spill term rides on top
    const k = e.charLightResponse;
    const comp = Math.max(0, Math.min(1, (1 + (lit - 1) * k) / Math.max(0.05, lit)));
    const body = scaleColor(e.charTint, comp);
    // The caller's tint rides ON the light response, so a hit flash still reads
    // as red in a dark corner and a looted crate still greys out under a lamp.
    // An emissive layer is exempt: pre-darkening a light by the light landing
    // on it is the mistake this whole file is arranged to avoid.
    for (let i = 0; i < a.parts.length; i++) {
      const t = a.tints[i] ?? 0xffffff;
      if (a.emissive[i]) a.parts[i]!.tint = t;
      else a.parts[i]!.tint = t === 0xffffff ? body : mulColor(body, t);
    }
    for (let i = 0; i < a.rims.length; i++) {
      const rim = a.rims[i]!;
      const part = a.parts[i]!;
      rim.texture = part.texture;
      rim.x = part.x;
      rim.y = part.y;
      rim.scale.copyFrom(part.scale);
      if (!e.rimOn || !dom || !e.lightsOn || a.emissive[i]) {
        rim.visible = false;
        continue;
      }
      rim.visible = true;
      const dx = dom.l.x - a.x;
      const dy = dom.l.y - (a.y - 8);
      const len = Math.hypot(dx, dy) || 1;
      rim.x = part.x + (dx / len) * e.rimOffset;
      rim.y = part.y + (dy / len) * e.rimOffset;
      rim.tint = dom.l.color;
      rim.alpha = e.rimStrength * dom.w * dom.l.level * 0.6;
    }

    if (!e.spriteShadowOn || !dom || !e.lightsOn || !a.casts || a.alpha <= 0.01) {
      a.shadow.visible = false;
      for (const sh of a.shadows) sh.root.visible = false;
      return;
    }
    a.shadow.visible = true;

    // Where the shadow attaches to the body. The geometric answer is the very
    // bottom of the sprite, but the geometric answer looks wrong: the wheels are
    // already the darkest part of the robot, so a shadow starting under them
    // reads as detached. Sliding the hinge up into the body welds the two.
    const hinge = a.y + a.foot + e.spriteShadowFoot;
    const want = Math.max(1, Math.min(MAX_BODY_SHADOWS, Math.round(e.spriteShadowCount)));
    const lights = this.lightmap.contributors(a.x, a.y - 8, look.lightRadiusScale, want);
    // Each shadow is only as dark as the light it hides. Two equal lamps give
    // two half-strength shadows, because standing in either one's shadow still
    // leaves you lit by the other — which is exactly what makes a multi-lamp
    // room read as a multi-lamp room.
    let total = 0;
    for (const c of lights) total += c.w;
    if (total <= 0) total = 1;

    /** The strongest rig, which every spare one is parked on top of. See below. */
    let park: ActorView['shadows'][number] | null = null;

    for (let s = 0; s < a.shadows.length; s++) {
      const sh = a.shadows[s]!;
      const c = lights[s];
      if (!c) {
        /**
         * A rig with no light behind it draws nothing — and must MEASURE
         * nothing either.
         *
         * `visible = false` only stops it drawing. A spare rig has never had a
         * shear applied, so left alone it sits at the world ORIGIN holding a
         * full-size silhouette, and an invisible child still reaches the bounds
         * the filter system reads: the shadow layer's extent gets dragged into
         * the corner of the room and every blurred edge in it moves. Rule 3's
         * family — what a filter measures matters as much as what it draws.
         *
         * So park it exactly on top of the strongest rig, where its bounds are
         * a subset of one already there. Unparenting it would also work and is
         * tempting; re-appending it later reorders the layer, and a reordered
         * stack of alpha blits rounds differently in the last bit.
         */
        sh.root.visible = false;
        if (park) copyShadowGeometry(park, sh);
        continue;
      }
      sh.root.visible = true;

      const dx = a.x - c.l.x;
      const dy = a.y - c.l.y;
      const len = Math.hypot(dx, dy) || 1;
      // Clamped, and clamped hard. Length is proportional to how far the caster
      // stands from its light, which is physically right and visually useless
      // past about 2x: the silhouette smears into a streak and stops reading as
      // the character, which is the entire reason for projecting it.
      const stretch = Math.min(2.1, 1 + (len / (c.l.radius * look.lightRadiusScale)) * 0.85);

      /**
       * Lay the silhouette down on the floor — by SHEARING it, not rotating it.
       *
       * Rotating the sprite turns its horizontal axis with the light, so the
       * shadow reads as a second, tilted copy of the character that happens to
       * be dark. A real cast shadow keeps its horizontal axis parallel to the
       * ground plane and leans: only the HEIGHT of a point gets displaced.
       *
       * So build the transform by hand. A point `h` above the feet lands at
       * `feet + away * h * length`, while the sprite's x extent maps to itself:
       *
       *     X = x  +  (-ax * L) * y
       *     Y = 0  +  (-ay * L) * y        (sprite y grows downward, hence -)
       *
       * which is exactly the 2x2 matrix below. Head 19px up projects 19*L out
       * along `away`; the body's width stays the body's width; nothing spins.
       */
      const L = stretch * e.spriteShadowLength;
      const ax = dx / len;
      const ay = dy / len;
      sh.root.setFromMatrix(
        new Matrix(1, 0, -ax * L, -ay * L, a.x, hinge),
      );

      const soft = e.spriteShadowSoftness;
      const on = soft > 0.05;
      if (soft !== sh.soft) {
        sh.soft = soft;
        sh.blur.strength = Math.max(0.1, soft);
        sh.inner.filters = on ? [sh.blur, sh.alpha] : [sh.alpha];
      }
      // Margin in LOCAL space, so it has to survive the shear's vertical scale.
      sh.spacer.visible = on;
      if (on) {
        const padX = soft * 5 + 8;
        const padY = (soft * 5 + 8) / Math.max(0.35, stretch * e.spriteShadowLength);
        sh.spacer.width = 26 + padX * 2;
        sh.spacer.height = 44 + padY * 2;
        sh.spacer.position.set(0, -16);
      }
      sh.alpha.alpha = e.spriteShadowAlpha * (c.w / total) ** 0.55 * a.alpha;
      for (let i = 0; i < sh.parts.length; i++) {
        const sil = sh.parts[i]!;
        const part = a.parts[i]!;
        // A glow casts nothing. `visible = false` would not do: an invisible
        // child still reaches the bounds the blur measures (README rule 3), so
        // the silhouette is emptied instead — its bounds collapse to a point
        // already inside the body.
        sil.texture = a.emissive[i] ? Texture.EMPTY : (part.texture as Texture);
        sil.scale.copyFrom(part.scale);
        sil.x = part.x;
        sil.y = part.y - a.foot - e.spriteShadowFoot;
      }
      park ??= sh;
    }

    // The contact patch stays put and stays round: projected silhouettes detach
    // from the feet as they lengthen, and without this the character reads as
    // hovering a pixel above its own shadows.
    a.shadow.rotation = 0;
    a.shadow.width = 22 * e.spriteShadowSquash * 1.6;
    a.shadow.height = 9 * e.spriteShadowSquash * 1.6;
    a.shadow.position.set(a.x, hinge - 1);
    a.shadow.alpha = e.spriteShadowAlpha * Math.min(1, dom.w * 2.2) * 0.8 * a.alpha;
  }

  /**
   * Dust lives only where light is. Motes floating through a black room are
   * invisible anyway, so spawning them anywhere else is pure cost.
   */
  private updateDust(dt: number, t: number): void {
    const look = this.look;
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const m = this.dust[i]!;
      m.age += dt;
      if (m.age >= m.life) {
        m.sp.visible = false;
        this.dustPool.push(m.sp);
        this.dust.splice(i, 1);
        continue;
      }
      m.sp.x += (m.vx + Math.sin(t * 1.1 + m.ph) * 2.6) * dt;
      m.sp.y += m.vy * dt;
      m.sp.alpha =
        look.dustBrightness * 0.95 * Math.min(1, m.age / 0.8, (m.life - m.age) / 0.8);
    }

    const want = Math.round(70 * look.dustAmount);
    this.dustT -= dt;
    if (!this.engine.volumeOn || this.dustT > 0 || this.dust.length >= want) return;
    this.dustT = 0.03;

    const lights = this.lightmap.lights.filter((l) => l.radius > 60 && l.level > 0.2);
    if (lights.length === 0) return;
    this.dustSeed = (this.dustSeed * 1664525 + 1013904223) >>> 0;
    const rnd = () => {
      this.dustSeed = (this.dustSeed * 1664525 + 1013904223) >>> 0;
      return this.dustSeed / 4294967296;
    };
    const l = lights[Math.floor(rnd() * lights.length)]!;
    const r = l.radius * look.lightRadiusScale * 0.85;
    const sp = this.dustPool.pop() ?? this.makeMote();
    sp.visible = true;
    sp.alpha = 0;
    sp.tint = l.color;
    sp.position.set(l.x + (rnd() * 2 - 1) * r, l.y + (rnd() * 2 - 1) * r * 0.7);
    this.dust.push({
      sp,
      vx: (rnd() - 0.5) * 7,
      vy: -(2 + rnd() * 5),
      life: 2.4 + rnd() * 2.6,
      age: 0,
      ph: rnd() * 6.283,
    });
  }

  private makeMote(): Sprite {
    const sp = new Sprite(Texture.WHITE);
    sp.width = 1;
    sp.height = 1;
    sp.blendMode = 'add';
    this.dustLayer.addChild(sp);
    return sp;
  }

  destroy(): void {
    this.teardown();
    this.wetMask?.destroy(true);
    this.floorMask?.destroy(true);
    this.lightmap.destroy();
    this.root.destroy({ children: true });
  }
}
