/**
 * THE LIT PREVIEW — the shipping lit renderer, wired to the draft.
 *
 * Same contract as the rest of this tool: what is on the canvas is the GAME
 * drawing your level. `LitScene` is the class `render/index.ts` mounts for a lit
 * floor, given a `SceneDef` assembled from the draft, and the post chain around
 * it is the lab's minus the parts that belong to a display rather than to a
 * room (see `lens` below).
 *
 * Two rules run through this file.
 *
 * **The scene camera stays IDENTITY.** Every `setCamera` call bumps the
 * lightmap's geometry version and re-bakes every light in the room, so a
 * designer panning the view would re-bake forty lamps per frame. The scene
 * renders into its own 480×270 target and THAT is what the editor's camera pans
 * and zooms — `container` is a plain sprite as far as the camera is concerned.
 *
 * **Structure is debounced, everything else is not.** `setScene` tears the room
 * down and builds it again; it is the only correct answer to "a prop appeared"
 * and the wrong answer to every slider. Look changes go through `updateLook`,
 * a lamp being dragged goes through `nudgeLight`, a fixture style through
 * `setFixture` — all of which are safe to call every frame — and a debounced
 * rebuild follows behind to pick up whatever the cheap path cannot express.
 */

import { Container, Rectangle, RenderTexture, Sprite, type Renderer } from 'pixi.js';
import type { LevelData, LevelLook, LightPlacement } from '@shared/types';
import { TILE } from '@shared/types';
import type { PixiArtAtlas } from '../art/index';
import { GradeFilter } from '../render/lit/filters';
import { LitScene } from '../render/lit/scene';
import {
  resolveLook,
  type ActorState,
  type LightState,
  type ResolvedLook,
  type SceneDef,
} from '../render/lit/types';
import { hasLit } from './store';

const VW = 480;
const VH = 270;

/** L cycles these. `flat` hands the canvas back to the classic `WorldView`. */
export type PreviewMode = 'lit' | 'flat' | 'lightmap';

export const MODE_LABEL: Record<PreviewMode, string> = {
  lit: 'lit',
  flat: 'flat (classic)',
  lightmap: 'lightmap',
};

/** The draft as the renderer's data contract. Nothing here is authored twice. */
function sceneDefOf(level: LevelData): SceneDef {
  return {
    map: level.map,
    seed: level.meta.seed ?? 1,
    decor: level.decor ?? [],
    lights: level.lights ?? [],
    fixtures: level.fixtures ?? [],
    wetPatches: level.wetPatches ?? [],
    tiles: level.tiles,
    look: resolveLook(level.look),
  };
}

export interface LitPreviewOpts {
  renderer: Renderer;
  art: PixiArtAtlas;
  /** Rebuild failures are the designer's news to break, not a crash. */
  status: (msg: string) => void;
}

export class LitPreview {
  /** Goes inside the editor's camera frame. One sprite, whatever the room is. */
  readonly container = new Container();

  mode: PreviewMode = 'lit';
  /**
   * Lens effects — vignette, chroma, grain, scanlines — are OFF while editing.
   *
   * They belong to the display, not to the level: in the game the CRT stack
   * puts them there. Left on here they darken the corners of the room you are
   * trying to judge the ambient level of, and they put grain on top of the
   * pixel you are trying to line a prop up against. The LOOK panel can turn
   * them on to check a mood; nothing about the switch is ever saved.
   */
  lens = false;

  private scene: LitScene | null = null;
  private post = new Container();
  private grade = new GradeFilter(VW, VH);
  private rt: RenderTexture;
  private sprite: Sprite;
  private look: ResolvedLook = resolveLook();
  private timer = 0;
  private pending: LevelData | null = null;
  private t = 0;

  constructor(private o: LitPreviewOpts) {
    this.rt = RenderTexture.create({ width: VW, height: VH, antialias: false });
    this.rt.source.scaleMode = 'nearest';
    this.sprite = new Sprite(this.rt);
    this.container.addChild(this.sprite);
    this.post.filterArea = new Rectangle(0, 0, VW, VH);
    this.post.filters = [this.grade];
  }

  /** True when there is a room built and the mode wants it drawn. */
  get active(): boolean {
    return this.scene !== null && this.mode !== 'flat';
  }

  get built(): boolean {
    return this.scene !== null;
  }

  // ------------------------------------------------------------------ scene

  /**
   * The draft changed structurally. Debounced, because a paint stroke is a
   * hundred of these and a rebuild is the expensive call in the file — but the
   * FIRST build is immediate, so placing the first prop lights the room now
   * rather than in a fifth of a second.
   */
  setLevel(level: LevelData, immediate = false): void {
    if (!hasLit(level)) return;
    this.pending = level;
    clearTimeout(this.timer);
    if (immediate || !this.scene) {
      this.flush();
      return;
    }
    this.timer = window.setTimeout(() => this.flush(), 140);
  }

  /** Apply a pending rebuild now — before a playtest starts, or on a save. */
  flush(): void {
    clearTimeout(this.timer);
    const level = this.pending;
    if (!level) return;
    this.pending = null;
    const def = sceneDefOf(level);
    this.look = def.look;
    try {
      if (!this.scene) {
        this.scene = new LitScene(this.o.renderer, this.o.art, def);
        this.post.addChild(this.scene.root);
      } else {
        this.scene.setScene(def);
      }
      this.applyMode();
    } catch (err) {
      this.o.status(`lit preview failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The map was rewritten without the dressing moving — a door, a paint stroke. */
  markTilesDirty(map: readonly string[]): void {
    this.scene?.markTilesDirty(map);
  }

  reseed(seed: number): void {
    this.scene?.reseed(seed);
  }

  // ------------------------------------------------------------ cheap paths

  /** Live, every frame if it likes. A look change never rebuilds geometry. */
  updateLook(look: LevelLook | undefined): void {
    this.look = resolveLook(look);
    this.scene?.updateLook(this.look);
  }

  /**
   * One light moved, or one of its numbers did — live, without a rebuild.
   *
   * The lightmap re-bakes a light whose position, radius or scale changed all
   * by itself (they are in its per-light signature). Cone geometry and shadow
   * casting are not, so those force the whole rig to re-bake; that is still an
   * order of magnitude cheaper than tearing the room down, and the debounced
   * `setScene` behind it is what finally moves the volumetric haze, which is
   * built rather than driven.
   */
  nudgeLight(p: LightPlacement): void {
    const map = this.scene?.lightmap;
    const l = map?.get(p.id);
    if (!map || !l) return;
    const shape =
      l.kind !== (p.kind ?? 'point') ||
      l.dir !== (p.dir ?? 0) ||
      l.spread !== (p.spread ?? l.spread) ||
      l.castShadow !== (p.castShadow ?? true);
    l.x = p.tx * TILE + TILE / 2;
    l.y = p.ty * TILE + TILE / 2;
    l.radius = p.radius;
    l.color = p.color;
    l.intensity = p.intensity;
    l.kind = p.kind ?? 'point';
    if (p.dir !== undefined) l.dir = p.dir;
    if (p.spread !== undefined) l.spread = p.spread;
    l.castShadow = p.castShadow ?? true;
    l.flicker = p.flicker ?? 0;
    l.flickerHz = p.flickerHz ?? 8;
    l.scale = p.scale ?? 1;
    if (shape) map.invalidate();
  }

  /** A trigger's `light` action, or the inspector's on/off toggle. */
  setLightState(id: string, state: LightState): void {
    this.scene?.setLightState(id, state);
  }

  setFixture(id: string, patch: Parameters<LitScene['setFixture']>[1]): void {
    this.scene?.setFixture(id, patch);
  }

  /** Static poses in edit mode, the stepped sim in playtest. */
  setActors(states: readonly ActorState[]): void {
    this.scene?.updateActors(states);
  }

  // -------------------------------------------------------------- per frame

  setMode(mode: PreviewMode): void {
    this.mode = mode;
    this.applyMode();
  }

  private applyMode(): void {
    this.container.visible = this.active;
    this.scene?.setDebug({ showLightmap: this.mode === 'lightmap' });
  }

  update(dt: number): void {
    if (!this.scene || !this.active) return;
    this.t += dt;
    this.scene.update(dt);
    this.pushGrade();
    this.o.renderer.render({ container: this.post, target: this.rt, clear: true });
  }

  /** The one-pass grade, straight off the level's own look. */
  private pushGrade(): void {
    const k = this.look;
    const u = this.grade.u;
    u.uTone[0] = k.exposure;
    u.uTone[1] = k.contrast;
    u.uTone[2] = k.saturation;
    u.uTone[3] = k.gamma;
    u.uLift[0] = ((k.liftColor >> 16) & 0xff) / 255;
    u.uLift[1] = ((k.liftColor >> 8) & 0xff) / 255;
    u.uLift[2] = (k.liftColor & 0xff) / 255;
    u.uLift[3] = k.liftAmount;
    u.uGain[0] = ((k.gainColor >> 16) & 0xff) / 255;
    u.uGain[1] = ((k.gainColor >> 8) & 0xff) / 255;
    u.uGain[2] = (k.gainColor & 0xff) / 255;
    u.uGain[3] = k.gainAmount;
    const lens = this.lens ? 1 : 0;
    u.uLens[0] = 0.5 * lens;
    u.uLens[1] = 0.58;
    u.uLens[2] = 1.99 * lens;
    u.uLens[3] = 0.045 * lens;
    u.uMisc[0] = 0.1 * lens;
    u.uMisc[1] = this.t;
    u.uMisc[2] = 1;
  }

  stats(): string {
    return this.scene?.stats() ?? 'no lit data';
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.scene?.destroy();
    this.scene = null;
    this.sprite.destroy();
    this.rt.destroy(true);
  }
}
