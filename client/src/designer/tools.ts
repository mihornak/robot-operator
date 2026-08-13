/**
 * POINTER AND KEYBOARD — every way a room gets drawn.
 *
 * One rule runs through the whole file: a live drag must LOOK live and still
 * land in history as ONE entry. Both are achieved without a second mutation
 * path — a drag re-runs itself through the store by undoing the command it owns
 * and running a bigger one (`runLive`), so `DraftStore.run` stays the only place
 * the draft is ever written.
 */

import type {
  DecorName,
  EntityKind,
  LevelEntityDef,
  LightPlacement,
  SoundEmitterDef,
  TileAuthoring,
  TileRect,
  TriggerDef,
  WetPatch,
} from '@shared/types';
import { TILE, TILES_X, TILES_Y } from '@shared/types';
import { at } from '../sim/floors';
import type { Command, Clip } from './store';
import {
  addItemCmd,
  addLitCmd,
  addWetCmd,
  batchCmd,
  removeItemCmd,
  removeWetCmd,
  setSpawnCmd,
  setTileAuthCmd,
  setTilesCmd,
  tileSolid,
  updateItemCmd,
  updateLitCmd,
  updateWetCmd,
  type DraftStore,
  type TileEdit,
} from './store';
import { defaultEntityDef, kindInfo, TOOLS } from './palette';
import { DECOR_SNAP, LIGHT_PRESETS, decorEntry, snapTile } from './litAssets';
import { deleteDecor, deleteLight, moveDecor, placeDecor } from './litEdit';
import { handleAt, lightPos, type HandleId } from './litHandles';
import { typing } from './ui';

export type ToolId =
  | 'select'
  | 'brush'
  | 'rect'
  | 'fill'
  | 'eyedropper'
  | 'entity'
  | 'trigger'
  | 'sound'
  | 'spawn'
  | 'decor'
  | 'light'
  | 'wet'
  | 'variant';

export interface Camera {
  scale: number;
  x: number;
  y: number;
}

export interface ToolsOpts {
  store: DraftStore;
  canvas: HTMLCanvasElement;
  camera: Camera;
  status: (msg: string) => void;
  /** Editing input is dead while a playtest is running. */
  isPlaytest: () => boolean;
  playtestClick: (x: number, y: number, right: boolean) => void;
  /** Chrome that reflects tool/kind/grid state needs a repaint. */
  onChrome: () => void;
  /**
   * A light moved under the pointer. The lit preview takes this straight to the
   * lightmap, so a dragged lamp lights the room WHILE it is being dragged; the
   * debounced scene rebuild behind it does the rest.
   */
  litNudge?: (light: LightPlacement) => void;
}

/** What the pointer is currently doing. Overlays draw the pending shapes. */
export type DragKind =
  | 'none'
  | 'pan'
  | 'paint'
  | 'rect'
  | 'trigger'
  | 'marquee'
  | 'move'
  | 'wet'
  | 'handle'
  | 'variant';

const HIT_PX = 11;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;

const clampTx = (v: number): number => Math.max(0, Math.min(TILES_X - 1, v));
const clampTy = (v: number): number => Math.max(0, Math.min(TILES_Y - 1, v));

/** Two corners → a normalised, in-bounds tile rect. */
function rectOf(ax: number, ay: number, bx: number, by: number): TileRect {
  const tx = clampTx(Math.min(ax, bx));
  const ty = clampTy(Math.min(ay, by));
  const ex = clampTx(Math.max(ax, bx));
  const ey = clampTy(Math.max(ay, by));
  return { tx, ty, tw: ex - tx + 1, th: ey - ty + 1 };
}

export class Tools {
  tool: ToolId = 'select';
  kind: EntityKind = 'scrap';
  /** What the DECOR page has selected. */
  decor: DecorName = 'desk';
  /** Which entry of LIGHT_PRESETS the light tool drops. */
  lightPreset = 'tube';
  /** Floor variant index the tile painter writes. */
  variant = 4;
  /** What the wall tools paint. The eyedropper writes here. */
  paintSolid = true;
  showGrid = true;
  /** Tile under the cursor, or null when the pointer is off the room. */
  hover: { tx: number; ty: number } | null = null;
  /** Fractional tile under the cursor — what the lit tools place against. */
  hoverT: { tx: number; ty: number } | null = null;
  /** Live drag rect in tile space — the overlay draws it. */
  pending: { kind: DragKind; rect: TileRect } | null = null;
  /** Live wet-patch ellipse, same idea. */
  pendingWet: WetPatch | null = null;

  private drag: DragKind = 'none';
  private spaceHeld = false;
  private anchor = { tx: 0, ty: 0 };
  private anchorF = { tx: 0, ty: 0 };
  private panFrom = { x: 0, y: 0, camX: 0, camY: 0 };
  private strokeEdits = new Map<string, TileEdit>();
  private strokeSolid = true;
  private moveId: string | null = null;
  private moveKind: 'entity' | 'sound' | 'trigger' | 'decor' | 'light' | 'wet' = 'entity';
  private moveIndex = 0;
  private moveFrom = { tx: 0, ty: 0 };
  private moveFromF = { tx: 0, ty: 0 };
  /** Where the dragged lit thing STARTED. Captured once, because a live drag
   *  re-runs against the pre-drag draft and must not chain its own deltas. */
  private litFrom: { tx: number; ty: number } | null = null;
  private wetFrom: { tx: number; ty: number } | null = null;
  private moved = false;
  /** Which handle of the selected light is being dragged. */
  private handle: HandleId | null = null;
  /** Variant-paint stroke: tile key → variant, or -1 for "clear this one". */
  private variantEdits = new Map<string, number>();
  /** True while the store's top undo entry is this drag's provisional command. */
  private live = false;

  constructor(private o: ToolsOpts) {
    const c = o.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onUp);
    c.addEventListener('pointerleave', () => {
      this.hover = null;
    });
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  setTool(t: ToolId): void {
    this.tool = t;
    this.o.status(`tool: ${t}`);
    this.o.onChrome();
  }

  setKind(k: EntityKind): void {
    this.kind = k;
    this.o.onChrome();
  }

  setDecor(name: DecorName): void {
    this.decor = name;
    this.o.onChrome();
  }

  setLightPreset(key: string): void {
    this.lightPreset = key;
    this.o.onChrome();
  }

  setVariant(v: number): void {
    this.variant = v;
    this.o.onChrome();
  }

  /** Centre the room in a viewport of this size, at the biggest whole-ish fit. */
  fit(w: number, h: number): void {
    const cam = this.o.camera;
    const s = Math.max(MIN_ZOOM, Math.min(w / (TILES_X * TILE), h / (TILES_Y * TILE)));
    cam.scale = s;
    cam.x = Math.round((w - TILES_X * TILE * s) / 2);
    cam.y = Math.round((h - TILES_Y * TILE * s) / 2);
  }

  /** Pointer capture is best-effort: a synthetic pointer (tests, some remote
   *  input stacks) has no active id to capture and throws rather than no-op. */
  private capture(id: number): void {
    try {
      this.o.canvas.setPointerCapture(id);
    } catch {
      /* nothing to capture — the drag still works, it just leaks off-canvas */
    }
  }

  private release(id: number): void {
    try {
      this.o.canvas.releasePointerCapture(id);
    } catch {
      /* pointer already gone */
    }
  }

  // ------------------------------------------------------------ coordinates

  /** Canvas event → feed px (the space the sim and the renderer both use). */
  private feedAt(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.o.canvas.getBoundingClientRect();
    const cam = this.o.camera;
    return {
      x: (e.clientX - r.left - cam.x) / cam.scale,
      y: (e.clientY - r.top - cam.y) / cam.scale,
    };
  }

  private tileAt(e: PointerEvent): { tx: number; ty: number } {
    const p = this.feedAt(e);
    return { tx: Math.floor(p.x / TILE), ty: Math.floor(p.y / TILE) };
  }

  /**
   * FRACTIONAL tile under the pointer, snapped to a quarter tile unless Alt is
   * held. Decor, lights and water all live in this space — the lab's room is
   * dressed on quarter tiles and a designer lining a prop up against a wall
   * face needs the same reach.
   */
  private tileAtF(e: PointerEvent | { clientX: number; clientY: number; altKey?: boolean }): {
    tx: number;
    ty: number;
  } {
    const p = this.feedAt(e as PointerEvent);
    const free = (e as PointerEvent).altKey === true;
    const raw = { tx: p.x / TILE, ty: p.y / TILE };
    return free
      ? { tx: Math.round(raw.tx * 100) / 100, ty: Math.round(raw.ty * 100) / 100 }
      : { tx: snapTile(raw.tx, DECOR_SNAP), ty: snapTile(raw.ty, DECOR_SNAP) };
  }

  // ------------------------------------------------------------ live commands

  /**
   * Run a command that REPLACES the one this drag ran a moment ago. The thunk
   * is evaluated after the undo so its "before" half is captured against the
   * pre-drag draft — a stroke that grows must not chain a hundred deltas.
   */
  private runLive(make: () => Command | null): void {
    if (this.live) {
      this.o.store.undo();
      this.live = false;
    }
    const cmd = make();
    if (cmd) {
      this.o.store.run(cmd);
      this.live = true;
    }
  }

  // ------------------------------------------------------------ hit testing

  private pick(px: number, py: number): void {
    const s = this.o.store;
    // Lights first: their icon is small and it is usually sitting on top of the
    // prop it belongs to, so anything that outranked it could never be grabbed.
    let bestLight: { id: string; d: number } | null = null;
    for (const l of s.level.lights ?? []) {
      const p = lightPos(l);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d <= 7 && (!bestLight || d < bestLight.d)) bestLight = { id: l.id, d };
    }
    if (bestLight) {
      s.select({ kind: 'light', id: bestLight.id });
      return;
    }
    let best: { id: string; d: number } | null = null;
    for (const e of s.level.entities) {
      const p = at(e.tx, e.ty);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d <= HIT_PX && (!best || d < best.d)) best = { id: e.id, d };
    }
    if (best) {
      s.select({ kind: 'entity', id: best.id });
      return;
    }
    // Decor is picked by its drawn RECT rather than by distance: the props run
    // from a 6px cable coil to a 44px shelf unit, and one radius cannot serve
    // both without either being unclickable or swallowing its neighbours.
    let bestDecor: { id: string; area: number } | null = null;
    for (const d of s.level.decor ?? []) {
      const entry = decorEntry(d.name);
      const [ax, ay] = entry.anchor ?? [0.5, 0.5];
      const x = d.tx * TILE - ax * entry.w;
      const y = d.ty * TILE - ay * entry.h;
      if (px < x || py < y || px > x + entry.w || py > y + entry.h) continue;
      const area = entry.w * entry.h;
      // Smallest hit wins — a coil on a desk is on TOP of the desk.
      if (!bestDecor || area < bestDecor.area) bestDecor = { id: d.id, area };
    }
    if (bestDecor) {
      s.select({ kind: 'decor', id: bestDecor.id });
      return;
    }
    const wet = s.level.wetPatches ?? [];
    for (let i = wet.length - 1; i >= 0; i--) {
      const w = wet[i]!;
      const dx = (px - w.tx * TILE) / Math.max(1, w.rx * TILE);
      const dy = (py - w.ty * TILE) / Math.max(1, w.ry * TILE);
      if (dx * dx + dy * dy <= 1) {
        s.select({ kind: 'wet', index: i });
        return;
      }
    }
    for (const snd of s.level.sounds) {
      if (Math.hypot(snd.pos.x - px, snd.pos.y - py) <= HIT_PX) {
        s.select({ kind: 'sound', id: snd.id });
        return;
      }
    }
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    for (const t of s.level.triggers) {
      const r = t.rect;
      if (tx >= r.tx && tx < r.tx + r.tw && ty >= r.ty && ty < r.ty + r.th) {
        s.select({ kind: 'trigger', id: t.id });
        return;
      }
    }
    s.select(null);
  }

  // --------------------------------------------------------------- pointer

  private onDown = (e: PointerEvent): void => {
    this.o.canvas.focus?.();
    const p = this.feedAt(e);
    if (this.o.isPlaytest()) {
      this.o.playtestClick(p.x, p.y, e.button === 2);
      return;
    }
    // Pan wins over every tool: space-drag and the middle button are how you
    // get around a room zoomed in past the viewport.
    if (e.button === 1 || this.spaceHeld) {
      this.drag = 'pan';
      const cam = this.o.camera;
      this.panFrom = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y };
      this.capture(e.pointerId);
      e.preventDefault();
      return;
    }
    const t = this.tileAt(e);
    const tf = this.tileAtF(e);
    this.anchor = t;
    this.anchorF = tf;
    this.capture(e.pointerId);
    e.preventDefault();
    const erase = e.button === 2 || e.altKey;

    // A selected light owns its handles wherever the pointer is: aiming a cone
    // must not depend on which tool happens to be active.
    const sel = this.o.store.selection;
    if (sel?.kind === 'light' && e.button === 0) {
      const light = this.o.store.light(sel.id);
      const hit = light ? handleAt(light, p.x, p.y) : null;
      if (hit && hit !== 'body') {
        this.drag = 'handle';
        this.handle = hit;
        return;
      }
    }

    switch (this.tool) {
      case 'brush': {
        this.drag = 'paint';
        this.strokeSolid = erase ? !this.paintSolid : this.paintSolid;
        this.strokeEdits.clear();
        this.stroke(t.tx, t.ty);
        break;
      }
      case 'rect':
        this.drag = 'rect';
        this.strokeSolid = erase ? !this.paintSolid : this.paintSolid;
        this.pending = { kind: 'rect', rect: rectOf(t.tx, t.ty, t.tx, t.ty) };
        break;
      case 'fill':
        this.fill(t.tx, t.ty, erase ? !this.paintSolid : this.paintSolid);
        break;
      case 'eyedropper':
        this.paintSolid = tileSolid(this.o.store.level, t.tx, t.ty);
        this.setTool('brush');
        this.o.status(`brush: ${this.paintSolid ? 'wall' : 'floor'}`);
        break;
      case 'entity':
        this.placeEntity(t.tx, t.ty);
        break;
      case 'sound':
        this.placeSound(t.tx, t.ty);
        break;
      case 'spawn':
        this.o.store.run(setSpawnCmd(this.o.store.level, t.tx, t.ty));
        this.o.status(`spawn → ${t.tx},${t.ty}`);
        break;
      case 'trigger':
        this.drag = 'trigger';
        this.pending = { kind: 'trigger', rect: rectOf(t.tx, t.ty, t.tx, t.ty) };
        break;
      case 'decor':
        this.placeDecor(tf.tx, tf.ty);
        break;
      case 'light':
        this.placeLight(tf.tx, tf.ty);
        break;
      case 'wet':
        this.drag = 'wet';
        this.pendingWet = { tx: tf.tx, ty: tf.ty, rx: 0.5, ry: 0.5 };
        break;
      case 'variant':
        this.drag = 'variant';
        this.variantEdits.clear();
        this.paintVariant(t.tx, t.ty, erase);
        break;
      case 'select': {
        this.pick(p.x, p.y);
        const picked = this.o.store.selection;
        if (picked && picked.kind !== 'level') {
          this.drag = 'move';
          this.moveKind = picked.kind;
          this.moveId = picked.kind === 'wet' ? null : picked.id;
          this.moveIndex = picked.kind === 'wet' ? picked.index : 0;
          this.moved = false;
          this.moveFrom = t;
          this.moveFromF = tf;
          this.litFrom = null;
          this.wetFrom = null;
        } else {
          this.drag = 'marquee';
          this.pending = { kind: 'marquee', rect: rectOf(t.tx, t.ty, t.tx, t.ty) };
        }
        break;
      }
    }
  };

  private onMove = (e: PointerEvent): void => {
    const t = this.tileAt(e);
    const tf = this.tileAtF(e);
    this.hover = t.tx >= 0 && t.ty >= 0 && t.tx < TILES_X && t.ty < TILES_Y ? t : null;
    this.hoverT = this.hover ? tf : null;
    if (this.drag === 'none') return;
    switch (this.drag) {
      case 'pan': {
        // Whole pixels only. The frame is positioned from these numbers and
        // hit-tested with them: a rounded position against an unrounded
        // inverse is a half-pixel disagreement about which tile you clicked.
        const cam = this.o.camera;
        cam.x = Math.round(this.panFrom.camX + (e.clientX - this.panFrom.x));
        cam.y = Math.round(this.panFrom.camY + (e.clientY - this.panFrom.y));
        break;
      }
      case 'paint':
        // Interpolated: at 8px/frame a raw sample leaves a dotted line.
        this.strokeLine(this.anchor.tx, this.anchor.ty, t.tx, t.ty);
        this.anchor = t;
        break;
      case 'rect':
      case 'trigger':
      case 'marquee':
        this.pending = {
          kind: this.drag,
          rect: rectOf(this.anchor.tx, this.anchor.ty, t.tx, t.ty),
        };
        break;
      case 'move':
        this.moveSelection(t.tx, t.ty, tf);
        break;
      case 'wet': {
        const a = this.anchorF;
        this.pendingWet = {
          tx: a.tx,
          ty: a.ty,
          rx: Math.max(0.3, Math.abs(tf.tx - a.tx)),
          ry: Math.max(0.3, Math.abs(tf.ty - a.ty)),
        };
        break;
      }
      case 'handle':
        this.dragHandle(this.feedAt(e));
        break;
      case 'variant':
        this.paintVariant(t.tx, t.ty, e.altKey);
        break;
    }
  };

  private onUp = (e: PointerEvent): void => {
    const drag = this.drag;
    const rect = this.pending?.rect ?? null;
    const wet = this.pendingWet;
    this.drag = 'none';
    this.pending = null;
    this.pendingWet = null;
    this.handle = null;
    this.live = false;
    this.strokeEdits.clear();
    this.variantEdits.clear();
    this.release(e.pointerId);
    if (drag === 'wet' && wet) {
      const index = (this.o.store.level.wetPatches ?? []).length;
      this.o.store.run(addWetCmd(wet));
      this.o.store.select({ kind: 'wet', index });
      this.o.status(`wet patch ${wet.rx.toFixed(1)}×${wet.ry.toFixed(1)} tiles`);
      return;
    }
    if (!rect) return;
    if (drag === 'rect') {
      const edits: TileEdit[] = [];
      for (let y = rect.ty; y < rect.ty + rect.th; y++) {
        for (let x = rect.tx; x < rect.tx + rect.tw; x++) edits.push({ tx: x, ty: y, solid: this.strokeSolid });
      }
      this.o.store.run(setTilesCmd(this.o.store.level, edits));
    } else if (drag === 'trigger') {
      const id = this.o.store.freshId('trig');
      const def: TriggerDef = { id, rect, when: 'enter', once: true, actions: [] };
      this.o.store.run(addItemCmd('triggers', def));
      this.o.store.select({ kind: 'trigger', id });
      this.o.status(`trigger ${id} — add actions in the inspector`);
    } else if (drag === 'marquee') {
      const empty = rect.tw === 1 && rect.th === 1;
      this.o.store.setRegion(empty ? null : rect);
      if (!empty) this.o.status(`region ${rect.tw}×${rect.th} — Ctrl+C copies, Del clears`);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const cam = this.o.camera;
    const r = this.o.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const before = { x: (mx - cam.x) / cam.scale, y: (my - cam.y) / cam.scale };
    const factor = Math.exp(-e.deltaY * 0.0015);
    cam.scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.scale * factor));
    // Anchor the zoom on the cursor: the tile under the pointer stays put.
    cam.x = Math.round(mx - before.x * cam.scale);
    cam.y = Math.round(my - before.y * cam.scale);
  };

  // ----------------------------------------------------------------- edits

  private stroke(tx: number, ty: number): void {
    if (tx < 0 || ty < 0 || tx >= TILES_X || ty >= TILES_Y) return;
    this.strokeEdits.set(`${tx},${ty}`, { tx, ty, solid: this.strokeSolid });
    const edits = [...this.strokeEdits.values()];
    this.runLive(() => setTilesCmd(this.o.store.level, edits));
  }

  private strokeLine(x0: number, y0: number, x1: number, y1: number): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    if (steps === 0) {
      this.stroke(x1, y1);
      return;
    }
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      this.stroke(Math.round(x0 + (x1 - x0) * f), Math.round(y0 + (y1 - y0) * f));
    }
  }

  private fill(tx: number, ty: number, solid: boolean): void {
    const level = this.o.store.level;
    const from = tileSolid(level, tx, ty);
    if (from === solid) return;
    const seen = new Set<string>();
    const queue = [{ tx, ty }];
    const edits: TileEdit[] = [];
    while (queue.length > 0) {
      const c = queue.pop()!;
      const key = `${c.tx},${c.ty}`;
      if (seen.has(key)) continue;
      if (c.tx < 0 || c.ty < 0 || c.tx >= TILES_X || c.ty >= TILES_Y) continue;
      if (tileSolid(level, c.tx, c.ty) !== from) continue;
      seen.add(key);
      edits.push({ tx: c.tx, ty: c.ty, solid });
      queue.push({ tx: c.tx + 1, ty: c.ty }, { tx: c.tx - 1, ty: c.ty }, { tx: c.tx, ty: c.ty + 1 }, { tx: c.tx, ty: c.ty - 1 });
    }
    this.o.store.run(setTilesCmd(level, edits));
    this.o.status(`filled ${edits.length} tiles`);
  }

  private placeEntity(tx: number, ty: number): void {
    const s = this.o.store;
    const info = kindInfo(this.kind);
    // The elevators are pinned ids the director addresses by name, so a second
    // one has to be a different id — but the FIRST one placed should be `elevA`.
    const id = s.freshId(info.prefix);
    const def = defaultEntityDef(this.kind, id, tx, ty);
    s.run(addItemCmd('entities', def));
    s.select({ kind: 'entity', id });
    this.o.status(`placed ${this.kind} '${id}'`);
  }

  // ------------------------------------------------------------- lit edits

  private placeDecor(tx: number, ty: number): void {
    const s = this.o.store;
    const placed = placeDecor(s, this.decor, tx, ty);
    if (!placed) return;
    s.run(placed.cmd);
    s.select({ kind: 'decor', id: placed.id });
    this.o.status(
      placed.fixtureId
        ? `placed ${this.decor} — lamp '${placed.fixtureId}' wired (prop + light + fixture)`
        : `placed ${this.decor}`,
    );
  }

  private placeLight(tx: number, ty: number): void {
    const s = this.o.store;
    const preset = LIGHT_PRESETS.find((p) => p.key === this.lightPreset) ?? LIGHT_PRESETS[0]!;
    const id = s.freshId(preset.key);
    s.run(addLitCmd('lights', preset.make(id, tx, ty), `place ${preset.key} light`));
    s.select({ kind: 'light', id });
    this.o.status(`placed ${preset.key} light '${id}' — drag its ring or handles`);
  }

  /**
   * One handle of the selected light, live. Each drag re-runs itself through
   * the store like every other drag, and every frame also pokes the running
   * lightmap so the pool follows the pointer instead of the debounce.
   */
  private dragHandle(p: { x: number; y: number }): void {
    const s = this.o.store;
    const sel = s.selection;
    if (sel?.kind !== 'light' || !this.handle) return;
    const light = s.light(sel.id);
    if (!light) return;
    const c = lightPos(light);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const patch: Partial<LightPlacement> = {};
    if (this.handle === 'radius') {
      patch.radius = Math.max(8, Math.round(Math.hypot(dx, dy)));
    } else if (this.handle === 'dir') {
      patch.dir = Math.round(Math.atan2(dy, dx) * 100) / 100;
    } else {
      const edge = Math.atan2(dy, dx);
      let delta = Math.abs(((edge - (light.dir ?? 0) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      delta = Math.max(0.08, Math.min(1.5, delta));
      patch.spread = Math.round(delta * 100) / 100;
    }
    this.runLive(() => updateLitCmd(s.level, 'lights', sel.id, patch, 'aim light'));
    const next = s.light(sel.id);
    if (next) this.o.litNudge?.(next);
    this.o.status(
      this.handle === 'radius'
        ? `radius ${patch.radius}px`
        : this.handle === 'dir'
          ? `aim ${Math.round(((patch.dir ?? 0) * 180) / Math.PI)}°`
          : `spread ±${Math.round(((patch.spread ?? 0) * 180) / Math.PI)}°`,
    );
  }

  /**
   * Paint one floor variant. The overrides list is rewritten wholesale each
   * stroke rather than patched, because `TileAuthoring` is one object on the
   * level and a per-tile command would be a hundred undo entries per drag.
   */
  private paintVariant(tx: number, ty: number, clear: boolean): void {
    if (tx < 0 || ty < 0 || tx >= TILES_X || ty >= TILES_Y) return;
    const s = this.o.store;
    if (tileSolid(s.level, tx, ty)) return; // a variant is a FLOOR tile
    this.variantEdits.set(`${tx},${ty}`, clear ? -1 : this.variant);
    const base = (s.level.tiles?.overrides ?? []).filter(
      (o) => !this.variantEdits.has(`${o.tx},${o.ty}`),
    );
    const painted = [...this.variantEdits.entries()]
      .filter(([, v]) => v >= 0)
      .map(([key, variant]) => {
        const [x, y] = key.split(',').map(Number);
        return { tx: x!, ty: y!, variant };
      });
    const next: TileAuthoring = { ...s.level.tiles, overrides: [...base, ...painted] };
    if (next.overrides?.length === 0) delete next.overrides;
    this.runLive(() => setTileAuthCmd(s.level, next, 'paint floor variants'));
  }

  private placeSound(tx: number, ty: number): void {
    const s = this.o.store;
    const id = s.freshId('amb');
    const def: SoundEmitterDef = {
      id,
      pos: at(tx, ty),
      sound: 'spark_loop',
      radiusPx: 90,
      loop: true,
      volume: 1,
    };
    s.run(addItemCmd('sounds', def));
    s.select({ kind: 'sound', id });
  }

  private moveSelection(tx: number, ty: number, tf: { tx: number; ty: number }): void {
    const s = this.o.store;
    // The lit things live in fractional tile space and move with the pointer,
    // not with the tile grid — a prop that could only sit on whole tiles would
    // undo the whole point of the ¼-tile snap.
    const dfx = tf.tx - this.moveFromF.tx;
    const dfy = tf.ty - this.moveFromF.ty;
    if (this.moveKind === 'wet') {
      const w = s.level.wetPatches?.[this.moveIndex];
      if (!w || (dfx === 0 && dfy === 0 && !this.moved)) return;
      this.moved = true;
      const from = this.wetFrom ?? { tx: w.tx, ty: w.ty };
      this.wetFrom = from;
      this.runLive(() =>
        updateWetCmd(s.level, this.moveIndex, { tx: from.tx + dfx, ty: from.ty + dfy }, 'move wet patch'),
      );
      return;
    }
    const id = this.moveId;
    if (id === null) return;
    if (this.moveKind === 'decor' || this.moveKind === 'light') {
      if (dfx === 0 && dfy === 0 && !this.moved) return;
      this.moved = true;
      const origin = this.litFrom ?? this.litOriginOf(id);
      if (!origin) return;
      this.litFrom = origin;
      const nx = Math.round((origin.tx + dfx) * 100) / 100;
      const ny = Math.round((origin.ty + dfy) * 100) / 100;
      if (this.moveKind === 'decor') {
        this.runLive(() => moveDecor(s, id, nx, ny));
        const d = s.decor(id);
        // A lamp's own lights moved with it; push each one at the lightmap.
        if (d?.fixtureId) {
          for (const l of s.level.lights ?? []) {
            if (l.id === d.fixtureId || l.id.startsWith(d.fixtureId + '_')) this.o.litNudge?.(l);
          }
        }
      } else {
        this.runLive(() => updateLitCmd(s.level, 'lights', id, { tx: nx, ty: ny }, 'move light'));
        const l = s.light(id);
        if (l) this.o.litNudge?.(l);
      }
      return;
    }
    if (tx === this.moveFrom.tx && ty === this.moveFrom.ty && !this.moved) return;
    this.moved = true;
    const dtx = tx - this.moveFrom.tx;
    const dty = ty - this.moveFrom.ty;
    if (this.moveKind === 'entity') {
      this.runLive(() => updateItemCmd(s.level, 'entities', id, { tx, ty }, 'move entity'));
    } else if (this.moveKind === 'sound') {
      this.runLive(() => updateItemCmd(s.level, 'sounds', id, { pos: at(tx, ty) }, 'move emitter'));
    } else {
      const t = s.trigger(id);
      if (!t) return;
      const r = t.rect;
      this.runLive(() =>
        updateItemCmd(
          s.level,
          'triggers',
          id,
          {
            rect: {
              tx: clampTx(r.tx + dtx),
              ty: clampTy(r.ty + dty),
              tw: r.tw,
              th: r.th,
            },
          },
          'move trigger',
        ),
      );
    }
  }

  // -------------------------------------------------------- copy and paste

  private copyRegion(): void {
    const s = this.o.store;
    const r = s.region;
    if (!r) {
      this.o.status('nothing selected — drag a region with V first');
      return;
    }
    const tiles: boolean[][] = [];
    for (let y = 0; y < r.th; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < r.tw; x++) row.push(tileSolid(s.level, r.tx + x, r.ty + y));
      tiles.push(row);
    }
    const entities = s.level.entities
      .filter((e) => e.tx >= r.tx && e.tx < r.tx + r.tw && e.ty >= r.ty && e.ty < r.ty + r.th)
      .map((e) => ({ ...e, tx: e.tx - r.tx, ty: e.ty - r.ty }));
    s.clipboard = { rect: r, tiles, entities };
    this.o.status(`copied ${r.tw}×${r.th} tiles + ${entities.length} entities`);
  }

  private pasteRegion(): void {
    const s = this.o.store;
    const clip: Clip | null = s.clipboard;
    if (!clip) return;
    const anchor = this.hover ?? { tx: clip.rect.tx, ty: clip.rect.ty };
    const edits: TileEdit[] = [];
    clip.tiles.forEach((row, y) =>
      row.forEach((solid, x) => edits.push({ tx: anchor.tx + x, ty: anchor.ty + y, solid })),
    );
    const parts: (Command | null)[] = [setTilesCmd(s.level, edits)];
    for (const e of clip.entities) {
      const tx = anchor.tx + e.tx;
      const ty = anchor.ty + e.ty;
      if (tx >= TILES_X || ty >= TILES_Y) continue;
      const def: LevelEntityDef = { ...e, id: s.freshId(kindInfo(e.kind).prefix), tx, ty };
      parts.push(addItemCmd('entities', def));
    }
    s.run(batchCmd('paste', parts));
    this.o.status(`pasted at ${anchor.tx},${anchor.ty}`);
  }

  /** Where a decor placement or a light currently sits, in fractional tiles. */
  private litOriginOf(id: string): { tx: number; ty: number } | null {
    const s = this.o.store;
    const thing = this.moveKind === 'decor' ? s.decor(id) : s.light(id);
    return thing ? { tx: thing.tx, ty: thing.ty } : null;
  }

  /** Public: the inspector's Delete button routes here so undo stays one path. */
  deleteSelection(): void {
    const s = this.o.store;
    const sel = s.selection;
    if (sel?.kind === 'decor') {
      s.run(deleteDecor(s, sel.id));
      s.select(null);
      this.o.status(`deleted ${sel.id}`);
      return;
    }
    if (sel?.kind === 'light') {
      s.run(deleteLight(s, sel.id));
      s.select(null);
      this.o.status(`deleted light ${sel.id}`);
      return;
    }
    if (sel?.kind === 'wet') {
      s.run(removeWetCmd(s.level, sel.index));
      s.select(null);
      this.o.status('deleted wet patch');
      return;
    }
    if (sel && sel.kind !== 'level') {
      const key = sel.kind === 'entity' ? 'entities' : sel.kind === 'trigger' ? 'triggers' : 'sounds';
      s.run(removeItemCmd(s.level, key, sel.id));
      s.select(null);
      this.o.status(`deleted ${sel.id}`);
      return;
    }
    const r = s.region;
    if (!r) return;
    const edits: TileEdit[] = [];
    for (let y = r.ty; y < r.ty + r.th; y++) {
      for (let x = r.tx; x < r.tx + r.tw; x++) edits.push({ tx: x, ty: y, solid: false });
    }
    const parts: (Command | null)[] = [setTilesCmd(s.level, edits)];
    for (const e of s.level.entities) {
      if (e.tx >= r.tx && e.tx < r.tx + r.tw && e.ty >= r.ty && e.ty < r.ty + r.th) {
        parts.push(removeItemCmd(s.level, 'entities', e.id));
      }
    }
    s.run(batchCmd('clear region', parts));
    this.o.status('region cleared');
  }

  // -------------------------------------------------------------- keyboard

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') this.spaceHeld = false;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (typing(e.target)) return;
    if (this.o.isPlaytest()) return;
    if (e.code === 'Space') {
      this.spaceHeld = true;
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') {
        const label = e.shiftKey ? this.o.store.redo() : this.o.store.undo();
        this.o.status(label ? `${e.shiftKey ? 'redo' : 'undo'} ${label}` : 'nothing to undo');
        e.preventDefault();
      } else if (k === 'y') {
        const label = this.o.store.redo();
        this.o.status(label ? `redo ${label}` : 'nothing to redo');
        e.preventDefault();
      } else if (k === 'c') {
        this.copyRegion();
        e.preventDefault();
      } else if (k === 'v') {
        this.pasteRegion();
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelection();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      this.o.store.select(null);
      this.o.store.setRegion(null);
      return;
    }
    if (e.key >= '1' && e.key <= '9') {
      const kinds = KIND_HOTKEYS;
      const kind = kinds[Number(e.key) - 1];
      if (kind) {
        this.setKind(kind);
        this.setTool('entity');
      }
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'x') {
      this.showGrid = !this.showGrid;
      this.o.status(`grid ${this.showGrid ? 'on' : 'off'}`);
      this.o.onChrome();
      return;
    }
    if (key === 'f') {
      // Wall/floor flip for the paint tools — faster than reaching for Alt.
      this.paintSolid = !this.paintSolid;
      this.o.status(`brush: ${this.paintSolid ? 'wall' : 'floor'}`);
      this.o.onChrome();
      return;
    }
    const tool = TOOLS.find((t) => t.key === key);
    if (tool) this.setTool(tool.id);
  };
}

/** 1..9 — the nine things a room actually gets built out of. */
const KIND_HOTKEYS: EntityKind[] = [
  'scrap',
  'chip',
  'crate',
  'debris',
  'cable',
  'fusedPrinter',
  'mop',
  'chair',
  'fuse',
];
