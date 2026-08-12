/**
 * The lab scene graph and its per-frame update.
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
import { TILE } from '@shared/types';
import { Px } from '../art/px';
import { canvasTex, glowTex, hashStr } from '../render/util';
import type { PixiArtAtlas } from '../art';
import { DECOR, type DecorEntry, type DecorName } from './decor';
import { LightMap, scaleColor, type LightParams, type Rect } from './lighting';
import { LightmapFilter } from './filters';
import {
  drawLabFloor,
  drawLabTileShadow,
  drawLabWallFace,
  drawLabWallTop,
  FLOOR_STRIPE,
  LAB_TILE_FRAMES,
} from './labTiles';
import {
  LAB_DECOR,
  LAB_LIGHTS,
  LAB_MAP,
  wallOccluders,
  WET_PATCHES,
  type Placement,
} from './level';
import { P } from './params';
import {
  LAMP_STYLES,
  WALL_STYLES,
  type FixtureStyle,
  type LampStyle,
  type WallStyle,
} from './fixtures';
import { E, L } from './palette';

const VW = 480;
const VH = 270;

/**
 * Distance from an actor's origin down to the floor it stands on. The robot's
 * wheels sit at +5 and are 8px tall, the printer's hull bottoms out at the same
 * place — so both feet land here, and this is the number that puts an actor on
 * the same y-sort footing as a prop anchored at its ground contact.
 */
const ACTOR_FOOT = 9;

/** Rigs allocated per character. `spriteShadowCount` picks how many are used. */
const MAX_BODY_SHADOWS = 4;

/** Perceptual brightness of an 0xRRGGBB, 0..1. */
function luma(c: number): number {
  return (
    (((c >> 16) & 0xff) * 0.2126 + ((c >> 8) & 0xff) * 0.7152 + (c & 0xff) * 0.0722) / 255
  );
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

/** A moving thing: robot or enemy. Same lighting treatment as any prop. */
interface Actor {
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
  t: number;
  kind: 'robot' | 'printer';
  path: Array<[number, number]>;
  leg: number;
  /** Previous position — facing comes from actual motion while being dragged. */
  lastX: number;
  lastY: number;
  head?: Sprite;
  headRim?: Sprite;
  wheels?: Sprite;
  body?: Sprite;
  speed: number;
}

export class LabScene {
  readonly root = new Container();
  readonly lightmap: LightMap;

  private cams: Container[] = [];
  private tileLayer = new Container();
  private groundShade = new Container();
  private aoGround: Sprite | null = null;
  private propShadowGround: Sprite | null = null;
  private reflectLayer = new Container();
  private shadowLayer = new Container();
  private propLayer = new Container();
  private rimLayer = new Container();
  private emissiveLayer = new Container();
  private dustLayer = new Container();
  private volumeLayer = new Container();
  private litWorld = new Container();
  private glowLayer = new Container();
  private fogFlat = new Sprite(Texture.WHITE);
  private fogGrad: Sprite;
  private fogBias = -1;

  private lightFilter: LightmapFilter;

  private props: PropView[] = [];
  private actors: Actor[] = [];
  private volumes: Array<{ sp: Sprite; id: string; base: number }> = [];
  private dust: Array<{ sp: Sprite; vx: number; vy: number; life: number; age: number; ph: number }> = [];
  private dustPool: Sprite[] = [];
  private dustT = 0;

  /**
   * Per-fixture lamp settings, keyed by light id. The panel edits ONE entry at a
   * time (or all of them), which is why these cannot just live in `P`: `P` is a
   * flat bag with one `lampStyle` in it, and six lamps need six.
   */
  private fixtures = new Map<
    string,
    {
      view: PropView;
      kind: 'ceiling' | 'wall';
      style: string;
      scale: number;
      bodyAlpha: number;
      glow: number;
      /** Authored position from level.ts — every offset is relative to this. */
      baseX: number;
      baseY: number;
      mountY: number;
      lightX: number;
      lightY: number;
      spill: number;
      /** Authored radius of the wall-wash point, before `spill` scales it. */
      spillBase: number;
    }
  >();
  private lampTex = new Map<string, { body: Texture[]; glow: Texture[] }>();
  private lastFixtureTarget = 'all';
  private lastWallTarget = 'all';
  /** Set by main.ts — pushes renderer-side changes back into the widgets. */
  onParamsChanged: (() => void) | null = null;

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
  private seed = 1;
  private camX = 0;
  private camY = 0;
  private camScale = 1;
  private dragging: Actor | null = null;

  constructor(
    private renderer: Renderer,
    private art: PixiArtAtlas,
  ) {
    this.lightmap = new LightMap(renderer, VW, VH);
    this.lightFilter = new LightmapFilter(this.lightmap.texture, VW, VH);

    this.litWorld.filters = [this.lightFilter];
    this.litWorld.filterArea = new Rectangle(0, 0, VW, VH);

    const camA = new Container();
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
    camB.addChild(this.rimLayer, this.emissiveLayer, this.dustLayer);
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
    this.buildWetMask(camA);
    this.buildFloorMask(camA);
  }

  // ------------------------------------------------------------------ build

  /**
   * Soft alpha mask limiting reflections to the wet patches. Blurred so a
   * reflection fades in at the water's edge instead of being scissored off —
   * a hard-edged reflection reads as a bug, not as a puddle.
   */
  private buildWetMask(camA: Container): void {
    const rt = RenderTexture.create({ width: VW, height: VH, antialias: false });
    rt.source.scaleMode = 'linear';
    const root = new Container();
    const g = new Graphics();
    for (const w of WET_PATCHES) {
      g.ellipse(w.tx * TILE, w.ty * TILE, w.rx * TILE, w.ry * TILE);
    }
    g.fill({ color: 0xffffff, alpha: 1 });
    root.addChild(g);
    root.filters = [new BlurFilter({ strength: 6, quality: 3 })];
    root.filterArea = new Rectangle(0, 0, VW, VH);
    this.renderer.render({ container: root, target: rt, clear: true });
    root.destroy({ children: true });

    this.wetMask = new Sprite(rt);
    camA.addChild(this.wetMask);
    this.reflectLayer.mask = this.wetMask;
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
  private buildFloorMask(camA: Container): void {
    const rt = RenderTexture.create({ width: VW, height: VH, antialias: false });
    rt.source.scaleMode = 'nearest';
    const g = new Graphics();
    for (let y = 0; y < LAB_MAP.length; y++) {
      const row = LAB_MAP[y]!;
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== '#') g.rect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    g.fill({ color: 0xffffff, alpha: 1 });
    this.renderer.render({ container: g, target: rt, clear: true });
    g.destroy();

    this.floorMask = new Sprite(rt);
    camA.addChild(this.floorMask);
    this.shadowLayer.mask = this.floorMask;
  }

  private build(): void {
    this.buildTiles();
    this.buildProps();
    this.buildActors();
    for (const l of LAB_LIGHTS) this.lightmap.add({ ...l });
    this.buildVolumes();
    // Walls only. Props shadow the FLOOR — see groundShadowTexture.
    this.lightmap.setOccluders([...this.wallRects]);
  }

  private buildTiles(): void {
    const floor = texFromDrawer(TILE, TILE, LAB_TILE_FRAMES.floor, drawLabFloor);
    const face = texFromDrawer(TILE, TILE, LAB_TILE_FRAMES.wallFace, drawLabWallFace);
    const top = texFromDrawer(TILE, TILE, 1, drawLabWallTop);
    const shade = texFromDrawer(TILE, TILE, 1, drawLabTileShadow);
    const map = LAB_MAP;
    const solid = (x: number, y: number): boolean => (map[y]?.[x] ?? '#') === '#';

    // Deterministic variant pick — art must not boil between reseeds unless the
    // user actually asks for a reseed.
    const pick = (x: number, y: number, n: number, salt: number): number =>
      (hashStr(`${x}:${y}:${salt}:${this.seed}`) >>> 3) % n;

    // Painted walkways run along whole rows and down whole columns. Scattering
    // the stripe variant the way the grime variants are scattered turns a
    // painted lane into a field of yellow dashes — the single loudest wrong
    // note the first build had. A lane has to be a LINE.
    // ONE lane, horizontal, through the open middle band.
    //
    // It was a cross — a horizontal lane plus a vertical run meeting dead centre
    // — which quarters the frame around a patch of empty floor and puts a
    // crosshair on nothing. A single lane is a leading line: it starts under the
    // bright top-left cluster and runs out to the dim vending corner, which is
    // the diagonal the whole light rig is built on.
    const WALK_ROWS = new Set([7]);
    const WALK_COLS = new Set<number>();

    for (let y = 0; y < map.length; y++) {
      const row = map[y]!;
      for (let x = 0; x < row.length; x++) {
        let sp: Sprite;
        let wall = false;
        if (solid(x, y)) {
          wall = true;
          sp = new Sprite(
            !solid(x, y + 1) ? face[pick(x, y, face.length, 3)]! : top[0]!,
          );
        } else if ((WALK_ROWS.has(y) || WALK_COLS.has(x)) && pick(x, y, 100, 11) < 88) {
          sp = new Sprite(floor[FLOOR_STRIPE]!);
          // A vertical lane needs the band rotated, not a second tile drawn.
          if (!WALK_ROWS.has(y)) {
            sp.rotation = Math.PI / 2;
            sp.anchor.set(0, 1);
          }
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

    for (const pl of LAB_DECOR) {
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
      // They used to live in `rimLayer`/`emissiveLayer`, which are drawn above
      // everything — so a puddle's additive rim, or a terminal's lit screen,
      // painted straight through any character standing in front of it. The
      // robot looked semi-transparent, and the cause was never the robot.
      //
      // The cost of moving them in here is that the lightmap multiply now
      // applies to them too. That is survivable precisely because every
      // emissive prop in this level sits inside its own light pool (see
      // LAB_LIGHTS) — it is bright where it is bright — and a rim light only
      // exists where there is light to begin with.
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

      let shadow: Sprite | null = null;
      if (!pl.ceiling && pl.foot) {
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

      if (pl.foot) {
        this.propRects.push({
          x: x - pl.foot[0] / 2,
          y: y - pl.foot[1],
          w: pl.foot[0],
          h: pl.foot[1],
        });
      }

      if (pl.fixtureId) {
        const wall = pl.fixtureKind === 'wall';
        this.fixtures.set(pl.fixtureId, {
          view: null as unknown as PropView, // filled immediately below
          kind: wall ? 'wall' : 'ceiling',
          style: wall ? P.wallStyle : P.lampStyle,
          scale: wall ? P.wallScale : P.lampScale,
          bodyAlpha: wall ? P.wallBodyAlpha : P.lampBodyAlpha,
          glow: wall ? P.wallGlow : P.lampGlow,
          baseX: x,
          baseY: y,
          mountY: wall ? P.wallMountY : 0,
          lightX: wall ? P.wallLightX : 0,
          lightY: wall ? P.wallLightY : 0,
          spill: wall ? P.wallSpill : 1,
          spillBase: 0,
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
      if (pl.fixtureId) this.fixtures.get(pl.fixtureId)!.view = view;
    }
  }

  /**
   * The robot and two printers, driving fixed loops. Not a sim — the point is
   * to judge the game's actual hero sprite under this lighting, because a room
   * that looks great and makes the character look wrong is a failed room.
   */
  private buildActors(): void {
    const mk = (kind: Actor['kind'], path: Array<[number, number]>, speed: number): Actor => {
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
      const shadows: Actor['shadows'] = [];
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

      const a: Actor = {
        root,
        parts,
        rims,
        shadow,
        shadows,
        x: path[0]![0],
        y: path[0]![1],
        t: 0,
        kind,
        path,
        leg: 0,
        lastX: path[0]![0],
        lastY: path[0]![1],
        speed,
      };

      const addPart = (tex: Texture, y: number): Sprite => {
        const sp = new Sprite(tex);
        sp.anchor.set(0.5);
        sp.y = y;
        root.addChild(sp);
        parts.push(sp);
        const rim = new Sprite(tex);
        rim.anchor.set(0.5);
        rim.y = y;
        rim.blendMode = 'add';
        rimRoot.addChild(rim);
        rims.push(rim);
        // one silhouette twin per shadow rig, positioned relative to the FEET
        // rather than the body origin — the feet are what a shadow hinges on
        for (const sh of shadows) {
          const sil = new Sprite(tex);
          sil.anchor.set(0.5);
          sil.y = y - ACTOR_FOOT;
          sil.tint = 0x000000;
          sh.inner.addChild(sil);
          sh.parts.push(sil);
        }
        return sp;
      };

      if (kind === 'robot') {
        a.wheels = addPart(this.art.frames('robot_wheels')[0]!, 5);
        a.body = addPart(this.art.frames('robot_body')[0]!, -1);
        a.head = addPart(this.art.frames('robot_head')[0]!, -10);
        a.headRim = rims[2];
      } else {
        a.body = addPart(this.art.frames('fused_printer')[0]!, 0);
      }
      return a;
    };

    // Tile centre, not tile corner. The old paths used `TILE * n`, which is the
    // top-left of a tile, so every waypoint sat half a tile off from where it
    // reads in the map string — which is how they ended up driving through the
    // pillars in the first place.
    const at = (tx: number, ty: number): [number, number] => [
      tx * TILE + TILE / 2,
      ty * TILE + TILE / 2,
    ];

    this.actors.push(
      // Loop around the middle pillar, along the hazard lane and back. Every
      // segment is verified walkable below.
      mk('robot', [at(6.6, 6.9), at(17.0, 6.9), at(17.0, 10.4), at(6.6, 10.4)], 34),
      // Straight patrol across the open north band.
      mk('printer', [at(9.0, 6.0), at(15.0, 6.0)], 20),
      // Straight patrol down the open lane east of the lower pillar.
      mk('printer', [at(16.0, 10.4), at(16.0, 13.6)], 17),
    );

    if (import.meta.env.DEV) this.assertPathsWalkable();
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
    for (const a of this.actors) {
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

    for (const l of LAB_LIGHTS) {
      if (l.volumetric === false) continue;
      const isCone = l.kind === 'cone';
      if (!isCone && l.radius < 90) continue; // accents don't fill the air
      const sp = new Sprite(isCone ? coneHaze : domeHaze);
      sp.blendMode = 'add';
      sp.anchor.set(isCone ? 0 : 0.5, 0.5);
      sp.position.set(l.x, l.y);
      sp.rotation = l.dir ?? 0;
      sp.tint = l.color;
      this.volumeLayer.addChild(sp);
      this.volumes.push({ sp, id: l.id, base: isCone ? 1 : 0.55 });
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
   * Route the four lamp sliders to whichever fixture the panel is pointed at.
   *
   * Switching `fixtureTarget` LOADS that lamp's settings back into `P` and asks
   * the panel to resync, so the sliders always show the state of the thing you
   * are about to edit rather than whatever the last lamp was left on.
   */
  private applyFixtures(): void {
    // ceiling and wall fixtures each own a target + four controls
    const groups = [
      {
        kind: 'ceiling' as const,
        target: P.fixtureTarget,
        last: this.lastFixtureTarget,
        load: (f: { style: string; scale: number; bodyAlpha: number; glow: number }) => {
          P.lampStyle = f.style as LampStyle;
          P.lampScale = f.scale;
          P.lampBodyAlpha = f.bodyAlpha;
          P.lampGlow = f.glow;
        },
        store: () => ({
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
        load: (f: {
          style: string;
          scale: number;
          bodyAlpha: number;
          glow: number;
          mountY: number;
          lightX: number;
          lightY: number;
          spill: number;
        }) => {
          P.wallStyle = f.style as WallStyle;
          P.wallScale = f.scale;
          P.wallBodyAlpha = f.bodyAlpha;
          P.wallGlow = f.glow;
          P.wallMountY = f.mountY;
          P.wallLightX = f.lightX;
          P.wallLightY = f.lightY;
          P.wallSpill = f.spill;
        },
        store: () => ({
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
        const f = this.fixtures.get(g.target);
        // Switching target LOADS that fixture's settings, so the sliders always
        // show the state of the thing you are about to edit.
        if (f && f.kind === g.kind) {
          g.load(f);
          this.onParamsChanged?.();
        }
      } else {
        const next = g.store();
        for (const [id, f] of this.fixtures) {
          if (f.kind !== g.kind) continue;
          if (g.target !== 'all' && g.target !== id) continue;
          Object.assign(f, next);
        }
      }
    }

    for (const [id, f] of this.fixtures) {
      const { view, kind, style, scale, bodyAlpha, glow } = f;
      if (!view) continue;

      // The housing rides its wall face, and its LIGHT follows the housing —
      // that coupling is the point. Before this the sprite and the pool were
      // two independent authored positions, so moving one just made them
      // disagree.
      if (kind === 'wall') {
        view.root.y = f.baseY + f.mountY;
        view.y = view.root.y;
        // the cone that throws the pool, and the small point that lights the
        // fixture itself (see level.ts)
        const cone = this.lightmap.get(id);
        if (cone) {
          cone.x = f.baseX + f.lightX;
          cone.y = f.baseY + f.mountY + f.lightY;
        }
        const pt = this.lightmap.get(`${id}_pt`);
        if (pt) {
          pt.x = f.baseX + f.lightX;
          pt.y = f.baseY + f.mountY;
          if (f.spillBase === 0) f.spillBase = pt.radius;
          pt.radius = f.spillBase * f.spill;
        }
      }
      const tex = this.fixtureTextures(kind, style);
      if (view.body.texture !== tex.body[0]) {
        view.body.texture = tex.body[0]!;
        view.frames = tex.body;
        if (view.glow) {
          view.glow.texture = tex.glow[0]!;
          view.glowFrames = tex.glow;
        }
      }
      view.body.scale.set(scale);
      view.body.alpha = bodyAlpha;
      if (view.glow) {
        view.glow.scale.set(scale);
        view.glow.alpha = P.emissiveGain * glow;
      }
    }
  }

  // ------------------------------------------------------------- per frame

  private lightParams(): LightParams {
    return {
      ambientColor: P.ambientColor,
      ambientLevel: P.ambientLevel,
      gain: P.lightsOn ? P.lightGain : 0,
      radiusScale: P.lightRadiusScale,
      falloff: P.lightFalloff,
      flicker: P.lightFlicker,
      shadowsOn: P.shadowsOn && P.lmShadowVolumes,
      shadowAlpha: P.shadowAlpha,
      shadowSoftness: P.shadowSoftness,
      shadowLength: P.shadowLength,
      shadowBias: P.shadowBias,
      shadowFade: P.shadowFade,
      shadowNear: P.shadowNear,
      shadowBands: P.shadowBands,
      aoOn: P.aoOn && P.lmAo,
      aoStrength: P.aoStrength,
      aoRadius: P.aoRadius,
      showAmbient: P.lmAmbient,
      showLights: P.lmLights,
    };
  }

  update(dtRaw: number): void {
    const dt = P.paused ? 0 : dtRaw * P.timeScale;
    this.t += dt;
    const t = this.t;

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
    const camX = VW / 2 - (VW / 2) * z + ox;
    const camY = VH / 2 - (VH / 2) * z + oy;
    for (const c of this.cams) {
      c.position.set(camX, camY);
      c.scale.set(z);
    }
    this.lightmap.setCamera(camX, camY, z);
    this.camX = camX;
    this.camY = camY;
    this.camScale = z;

    // -------------------------------------------------------------- actors
    this.updateActors(dt);

    // -------------------------------------------------------------- lights
    const lp = this.lightParams();
    this.lightmap.update(t, lp);
    this.lightFilter.u.uParams[0] = P.lmSpill ? P.lightSpill : 0;

    // --------------------------------------------------------------- props
    for (const p of this.props) this.updateProp(p, t);
    // after updateProp, which would otherwise stomp the fixtures' glow alpha
    this.applyFixtures();
    for (const a of this.actors) this.updateActorLighting(a);

    // ---------------------------------------------------------- volumetrics
    for (const v of this.volumes) {
      const l = this.lightmap.get(v.id);
      if (!l) continue;
      v.sp.visible = P.volumeOn && P.lightsOn;
      if (!v.sp.visible) continue;
      // Haze breathes slightly out of step with the lamp so the air doesn't
      // look welded to the fixture.
      const breathe = 0.9 + 0.1 * Math.sin(t * 0.7 + l.phase);
      v.sp.alpha = P.volumeStrength * v.base * l.level * l.intensity * breathe;
      v.sp.tint = l.color;
      v.sp.position.set(l.x, l.y); // lights can move now; the haze goes with them
      const r = l.radius * P.lightRadiusScale * (l.scale ?? 1);
      if (l.kind === 'cone') {
        v.sp.width = r * P.volumeLength;
        v.sp.height = r * 2 * P.volumeWidth;
      } else {
        v.sp.width = r * 2 * P.volumeLength;
        v.sp.height = r * 2 * P.volumeWidth;
      }
    }

    // ----------------------------------------------------------------- dust
    this.updateDust(dt, t);

    // ------------------------------------------------------------------ fog
    const bias = Math.round(P.fogHeight * 50) / 50;
    if (bias !== this.fogBias) {
      this.fogBias = bias;
      this.fogGrad.texture.destroy(true);
      this.fogGrad.texture = fogTex(bias);
      this.fogGrad.width = VW;
      this.fogGrad.height = VH;
    }
    this.fogFlat.tint = P.fogColor;
    this.fogGrad.tint = P.fogColor;
    this.fogFlat.alpha = P.fogAmount * 0.35;
    this.fogGrad.alpha = P.fogAmount * 0.65;

    this.updateGroundShade();
    this.applyLayers();

    // ----------------------------------------------------------------- debug
    // The lightmap on its own is the only way to tell "this light is wrong"
    // from "this material is wrong" — they look identical through a multiply.
    this.debugMap.visible = P.showLightmap;
    this.debugOcc.visible = P.showOccluders;
    if (P.showOccluders && !this.debugOccBuilt) this.buildOccluderDebug();
    this.litWorld.visible = !P.showLightmap;
    this.glowLayer.visible = !P.showLightmap;
    this.fogFlat.visible = !P.showLightmap;
    this.fogGrad.visible = !P.showLightmap;
  }

  /**
   * One switch per draw pass.
   *
   * These exist because a visual artefact you cannot attribute to a layer is a
   * visual artefact you end up guessing about — and guessing costs more than
   * the switches do. Turn passes off one at a time until the artefact goes
   * away, and the culprit is whatever you just switched.
   *
   * Applied at the END of update(), so it overrides every per-frame decision
   * the systems above have just made about their own visibility.
   */
  private applyLayers(): void {
    this.tileLayer.visible = P.layerFloor;
    this.groundShade.visible = P.layerFloor;
    for (const w of this.wallSprites) w.visible = P.layerWalls;
    this.reflectLayer.visible = P.layerReflect;
    this.dustLayer.visible = P.layerDust;
    this.volumeLayer.visible = P.layerVolume;
    this.fogFlat.visible = P.layerFog;
    this.fogGrad.visible = P.layerFog;

    for (const p of this.props) {
      p.root.visible = P.layerProps;
      if (p.rim && !P.layerRim) p.rim.visible = false;
      if (p.glow && !P.layerEmissive) p.glow.visible = false;
      if (p.shadow && !P.layerPropShadows) p.shadow.visible = false;
    }

    for (const a of this.actors) {
      a.root.visible = P.layerCharacters;
      if (!P.layerContact) a.shadow.visible = false;
      for (const sh of a.shadows) if (!P.layerBodyShadows) sh.root.visible = false;
      if (!P.layerRim) for (const rim of a.rims) rim.visible = false;
    }

    const lit = P.layerLightmap && !P.showLightmap;
    if ((this.litWorld.filters as unknown[]).length !== (lit ? 1 : 0)) {
      this.litWorld.filters = lit ? [this.lightFilter] : [];
    }
    this.shadowLayer.mask = P.layerMasks ? this.floorMask : null;
    this.reflectLayer.mask = P.layerMasks ? this.wetMask : null;
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
    // Prop shadows and prop footprints, on the floor only and in one pass so
    // they share a blur.
    const wantVol = P.lmPropOccluders && P.lmShadowVolumes;
    const wantProp = P.shadowsOn && (wantVol || P.lmFootprints);
    if (wantProp) {
      const tex = this.lightmap.groundShadowTexture(
        this.propRects,
        this.lightParams(),
        wantVol ? 0.55 : 0,
        P.lmFootprints,
      );
      if (tex && !this.propShadowGround) {
        this.propShadowGround = new Sprite(tex);
        this.propShadowGround.blendMode = 'multiply';
        this.groundShade.addChild(this.propShadowGround);
      }
    }
    if (this.propShadowGround) {
      this.propShadowGround.visible = wantProp;
      this.propShadowGround.alpha = P.shadowAlpha * 0.8;
    }

    const aoTex = this.lightmap.aoTexture;
    if (aoTex && !this.aoGround) {
      this.aoGround = new Sprite(aoTex);
      this.aoGround.blendMode = 'multiply';
      this.groundShade.addChildAt(this.aoGround, 0);
    }
    if (this.aoGround) {
      this.aoGround.visible = P.aoOn && P.lmAo;
      this.aoGround.alpha = P.aoStrength;
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
    if (p.fps > 0) {
      const i = Math.floor((t + p.phase) * p.fps) % p.frames.length;
      p.body.texture = p.frames[i]!;
      if (p.rim) p.rim.texture = p.frames[i]!;
      if (p.reflect) p.reflect.texture = p.frames[i]!;
      if (p.glow && p.glowFrames) p.glow.texture = p.glowFrames[i]!;
    }

    const dom = this.lightmap.dominant(p.x, p.y - p.height * 0.5, P.lightRadiusScale);

    // ---- rim light: an additive copy nudged toward the light. On a 20px prop
    // one pixel of offset is the entire difference between "flat sticker" and
    // "object with a lit side", and it costs one sprite.
    if (p.rim) {
      if (!P.rimOn || !dom || !P.lightsOn) {
        p.rim.visible = false;
      } else {
        p.rim.visible = true;
        const dx = dom.l.x - p.x;
        const dy = dom.l.y - (p.y - p.height * 0.5);
        const len = Math.hypot(dx, dy) || 1;
        // local to the prop root now, so this is a pure offset
        p.rim.position.set((dx / len) * P.rimOffset, (dy / len) * P.rimOffset);
        p.rim.tint = dom.l.color;
        p.rim.alpha = P.rimStrength * dom.w * dom.l.level * 0.55;
      }
    }

    // ---- emissive face
    if (p.glow) {
      const near = this.nearestLight(p.x, p.y);
      p.glow.alpha = P.emissiveGain * (near ? 0.55 + 0.45 * near.level : 1);
      p.glow.visible = p.glow.alpha > 0.01;
    }

    // ---- projected shadow, away from the dominant light
    if (p.shadow) {
      if (!P.spriteShadowOn || !dom || !P.lightsOn) {
        p.shadow.visible = false;
      } else {
        p.shadow.visible = true;
        const dx = p.x - dom.l.x;
        const dy = p.y - dom.l.y;
        const len = Math.hypot(dx, dy) || 1;
        const stretch = 1 + (len / (dom.l.radius * P.lightRadiusScale)) * 1.6;
        const w = p.entry ? p.entry.w : 16;
        p.shadow.rotation = Math.atan2(dy, dx);
        p.shadow.width = w * 1.35 * stretch * P.spriteShadowLength;
        p.shadow.height = w * 1.15 * P.spriteShadowSquash;
        p.shadow.position.set(
          p.x + (dx / len) * p.shadow.width * 0.28,
          p.y + (dy / len) * p.shadow.width * 0.28 * 0.5,
        );
        p.shadow.alpha = P.spriteShadowAlpha * Math.min(1, dom.w * 2.2);
      }
    }

    // ---- wet-floor reflection: mirrored, squashed, and wobbling, so it reads
    // as water rather than as a sprite someone flipped.
    if (p.reflect) {
      p.reflect.visible = P.reflectOn;
      if (P.reflectOn) {
        const wob = Math.sin(t * 1.6 + p.phase) * 0.5 * P.reflectWobble;
        p.reflect.scale.set(
          (p.body.scale.x < 0 ? -1 : 1) * (1 + wob * 0.02),
          -P.reflectSquash,
        );
        p.reflect.position.set(p.x + wob, p.y + 1);
        p.reflect.alpha = P.reflectAlpha;
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

  private updateActors(dt: number): void {
    for (const a of this.actors) {
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
      a.root.position.set(Math.round(a.x), Math.round(a.y));
      // Sort by the FEET, not the centre.
      //
      // A prop's zIndex is its anchor, which is its ground contact. An actor's
      // origin is the middle of its body, so sorting on `a.y` claimed it stood
      // ~9px further back than it does, and every prop standing level with the
      // robot — or even slightly behind it — drew on top. That reads as the
      // character being under the furniture, and it is a sorting bug, not a
      // lighting one.
      a.root.zIndex = a.y + ACTOR_FOOT;

      if (a.kind === 'robot') {
        const wf = this.art.frames('robot_wheels');
        const bf = this.art.frames('robot_body');
        const hf = this.art.frames('robot_head');
        a.wheels!.texture = wf[Math.floor(a.t * 12) % wf.length]!;
        a.body!.texture = bf[Math.floor(a.t * 3) % bf.length]!;
        // head frames run E,SE,S,SW,W,NW,N,NE
        const ang = Math.atan2(dy, dx);
        const idx = ((Math.round((ang / (Math.PI * 2)) * 8) % 8) + 8) % 8;
        a.head!.texture = hf[idx]!;
        a.body!.y = -1 + (Math.sin(a.t * 7) > 0 ? 0 : 1);
        a.head!.y = -10 + (Math.sin(a.t * 7) > 0 ? 0 : 1);
      } else {
        const pf = this.art.frames('fused_printer');
        a.body!.texture = pf[Math.floor(a.t * 6) % pf.length]!;
        a.body!.scale.x = dx < 0 ? -1 : 1;
      }

    }
  }

  private updateActorLighting(a: Actor): void {
    const dom = this.lightmap.dominant(a.x, a.y - 8, P.lightRadiusScale);

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
    let lit = P.ambientLevel * luma(P.ambientColor);
    for (const c of this.lightmap.contributors(a.x, a.y - 8, P.lightRadiusScale, 4)) {
      lit += c.w * P.lightGain * luma(c.l.color);
    }
    lit *= 1 + P.lightSpill * 0.8; // the filter's spill term rides on top
    const k = P.charLightResponse;
    const comp = Math.max(0, Math.min(1, (1 + (lit - 1) * k) / Math.max(0.05, lit)));
    const body = scaleColor(P.charTint, comp);
    for (const part of a.parts) part.tint = body;
    for (let i = 0; i < a.rims.length; i++) {
      const rim = a.rims[i]!;
      const part = a.parts[i]!;
      rim.texture = part.texture;
      rim.y = part.y;
      rim.scale.x = part.scale.x;
      if (!P.rimOn || !dom || !P.lightsOn) {
        rim.visible = false;
        continue;
      }
      rim.visible = true;
      const dx = dom.l.x - a.x;
      const dy = dom.l.y - (a.y - 8);
      const len = Math.hypot(dx, dy) || 1;
      rim.x = (dx / len) * P.rimOffset;
      rim.y = part.y + (dy / len) * P.rimOffset;
      rim.tint = dom.l.color;
      rim.alpha = P.rimStrength * dom.w * dom.l.level * 0.6;
    }

    if (!P.spriteShadowOn || !dom || !P.lightsOn) {
      a.shadow.visible = false;
      for (const sh of a.shadows) sh.root.visible = false;
      return;
    }
    a.shadow.visible = true;

    // Where the shadow attaches to the body. The geometric answer is the very
    // bottom of the sprite, but the geometric answer looks wrong: the wheels are
    // already the darkest part of the robot, so a shadow starting under them
    // reads as detached. Sliding the hinge up into the body welds the two.
    const hinge = a.y + ACTOR_FOOT + P.spriteShadowFoot;
    const want = Math.max(1, Math.min(MAX_BODY_SHADOWS, Math.round(P.spriteShadowCount)));
    const lights = this.lightmap.contributors(a.x, a.y - 8, P.lightRadiusScale, want);
    // Each shadow is only as dark as the light it hides. Two equal lamps give
    // two half-strength shadows, because standing in either one's shadow still
    // leaves you lit by the other — which is exactly what makes a multi-lamp
    // room read as a multi-lamp room.
    let total = 0;
    for (const c of lights) total += c.w;
    if (total <= 0) total = 1;

    for (let s = 0; s < a.shadows.length; s++) {
      const sh = a.shadows[s]!;
      const c = lights[s];
      if (!c) {
        sh.root.visible = false;
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
      const stretch = Math.min(2.1, 1 + (len / (c.l.radius * P.lightRadiusScale)) * 0.85);

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
      const L = stretch * P.spriteShadowLength;
      const ax = dx / len;
      const ay = dy / len;
      sh.root.setFromMatrix(
        new Matrix(1, 0, -ax * L, -ay * L, a.x, hinge),
      );

      const soft = P.spriteShadowSoftness;
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
        const padY = (soft * 5 + 8) / Math.max(0.35, stretch * P.spriteShadowLength);
        sh.spacer.width = 26 + padX * 2;
        sh.spacer.height = 44 + padY * 2;
        sh.spacer.position.set(0, -16);
      }
      sh.alpha.alpha = P.spriteShadowAlpha * (c.w / total) ** 0.55;
      for (let i = 0; i < sh.parts.length; i++) {
        const sil = sh.parts[i]!;
        const part = a.parts[i]!;
        sil.texture = part.texture;
        sil.scale.x = part.scale.x;
        sil.y = part.y - ACTOR_FOOT - P.spriteShadowFoot;
      }
    }

    // The contact patch stays put and stays round: projected silhouettes detach
    // from the feet as they lengthen, and without this the character reads as
    // hovering a pixel above its own shadows.
    a.shadow.rotation = 0;
    a.shadow.width = 22 * P.spriteShadowSquash * 1.6;
    a.shadow.height = 9 * P.spriteShadowSquash * 1.6;
    a.shadow.position.set(a.x, hinge - 1);
    a.shadow.alpha = P.spriteShadowAlpha * Math.min(1, dom.w * 2.2) * 0.8;
  }



  /**
   * Dust lives only where light is. Motes floating through a black room are
   * invisible anyway, so spawning them anywhere else is pure cost.
   */
  private updateDust(dt: number, t: number): void {
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
        P.dustBrightness * 0.95 * Math.min(1, m.age / 0.8, (m.life - m.age) / 0.8);
    }

    const want = Math.round(70 * P.dustAmount);
    this.dustT -= dt;
    if (!P.volumeOn || this.dustT > 0 || this.dust.length >= want) return;
    this.dustT = 0.03;

    const lights = this.lightmap.lights.filter((l) => l.radius > 60 && l.level > 0.2);
    if (lights.length === 0) return;
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    const rnd = () => {
      this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
      return this.seed / 4294967296;
    };
    const l = lights[Math.floor(rnd() * lights.length)]!;
    const r = l.radius * P.lightRadiusScale * 0.85;
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

  // ------------------------------------------------------------------ drag

  /** Feed pixels (0..480, 0..270) to world pixels, undoing the camera. */
  private toWorld(feedX: number, feedY: number): { x: number; y: number } {
    return {
      x: (feedX - this.camX) / this.camScale,
      y: (feedY - this.camY) / this.camScale,
    };
  }

  /** Is there a character under this point? Robot wins ties — it is the one
   *  anyone actually wants to move. */
  pickActor(feedX: number, feedY: number): boolean {
    const { x, y } = this.toWorld(feedX, feedY);
    return this.findActor(x, y) !== null;
  }

  private findActor(x: number, y: number): Actor | null {
    const R2 = 15 * 15;
    let best: Actor | null = null;
    let bestD = R2;
    for (const a of this.actors) {
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
    const { x, y } = this.toWorld(feedX, feedY);
    this.dragging = this.findActor(x, y);
    return this.dragging !== null;
  }

  dragTo(feedX: number, feedY: number): void {
    if (!this.dragging) return;
    const { x, y } = this.toWorld(feedX, feedY);
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

  /** New tile variants and prop grime, same layout. */
  reseed(): void {
    this.seed = (Math.floor(performance.now()) % 100000) + 1;
    this.tileLayer.removeChildren().forEach((c) => c.destroy());
    for (const w of this.wallSprites) w.destroy();
    this.wallSprites.length = 0;
    this.buildTiles();
    this.lightmap.setOccluders([...this.wallRects, ...this.propRects]);
  }

  stats(): string {
    return `${this.lightmap.lights.length} lights · ${this.props.length} props · ${this.dust.length} motes`;
  }
}

/** Placeholder swatch, used by the loader before the atlas exists. */
export function bootBackdrop(): Graphics {
  return new Graphics().rect(0, 0, VW, VH).fill(L.v0);
}

export const LAB_ACCENT = E.accent;
export type { Placement };
