/**
 * THE EDITING LAYER — everything drawn on top of the real render that is not in
 * the game: grid, trigger regions, emitter radii, the spawn marker, selection.
 *
 * It lives INSIDE the camera-scaled frame, so a trigger rect sits on the tiles
 * it actually covers at every zoom. Amber #ffb000 is the UI colour (artManifest
 * palette law) and this is UI — it is the one place in a world render where
 * amber is allowed, and it is exactly why it reads as "not part of the room".
 *
 * Redrawn wholesale every frame. At 30×16 tiles that is a few hundred path ops
 * against a budget of 16ms, and a retained diff would be a second model of the
 * level to keep in sync.
 */

import { Container, Graphics, Text } from 'pixi.js';
import type { LevelData, TileRect, WetPatch } from '@shared/types';
import { TILE, TILES_X, TILES_Y } from '@shared/types';
import { at } from '../sim/floors';
import { decorEntry } from './litAssets';
import {
  dirHandle,
  isCone,
  lightDir,
  lightPos,
  lightSpread,
  radiusHandle,
  spreadHandles,
} from './litHandles';
import type { Selection } from './store';
import type { DragKind } from './tools';

const AMBER = 0xffb000;
const CYAN = 0x7fd4ff;
const GREEN = 0x36e0b0;
/** The lit half gets its own colour so it never reads as level geometry. */
const VIOLET = 0xb08cff;
const WATER = 0x4fd0e6;

/** Entities whose art anchors at the FEET, not the middle. Their handle says so. */
const FOOT_ANCHORED = new Set(['elevatorA', 'elevatorB', 'debris', 'chair']);

export interface OverlayState {
  level: LevelData;
  selection: Selection;
  region: TileRect | null;
  pending: { kind: DragKind; rect: TileRect } | null;
  /** Live wet-floor ellipse being dragged. */
  pendingWet: WetPatch | null;
  hover: { tx: number; ty: number } | null;
  showGrid: boolean;
  /** Playtest hides the whole layer — you are looking at the game now. */
  visible: boolean;
  /**
   * Draw the lit half at all. Off on a level with no lit data, so a classic
   * level's overlay looks exactly like it did before any of this existed.
   */
  lit: boolean;
}

export class DesignerOverlays {
  readonly container = new Container();
  private g = new Graphics();
  private labels = new Container();
  private pool: Text[] = [];
  private used = 0;

  constructor() {
    this.container.addChild(this.g, this.labels);
  }

  private label(text: string, x: number, y: number, color: number): void {
    let t = this.pool[this.used];
    if (!t) {
      t = new Text({
        text,
        style: { fontFamily: 'monospace', fontSize: 7, fill: color },
      });
      t.resolution = 2;
      this.pool.push(t);
      this.labels.addChild(t);
    }
    t.visible = true;
    t.text = text;
    t.style.fill = color;
    t.position.set(Math.round(x), Math.round(y));
    this.used++;
  }

  update(s: OverlayState): void {
    const g = this.g;
    g.clear();
    this.used = 0;
    this.container.visible = s.visible;
    if (!s.visible) {
      for (const t of this.pool) t.visible = false;
      return;
    }

    if (s.showGrid) {
      for (let x = 0; x <= TILES_X; x++) {
        g.moveTo(x * TILE, 0).lineTo(x * TILE, TILES_Y * TILE);
      }
      for (let y = 0; y <= TILES_Y; y++) {
        g.moveTo(0, y * TILE).lineTo(TILES_X * TILE, y * TILE);
      }
      g.stroke({ width: 1, color: 0xffffff, alpha: 0.07 });
      // The room's own edge, so the 14px of slack under the last tile row is
      // visibly NOT part of the map.
      g.rect(0, 0, TILES_X * TILE, TILES_Y * TILE).stroke({ width: 1, color: AMBER, alpha: 0.3 });
    }

    // ------------------------------------------------------------- triggers
    for (const t of s.level.triggers) {
      const r = t.rect;
      const sel = s.selection?.kind === 'trigger' && s.selection.id === t.id;
      g.rect(r.tx * TILE, r.ty * TILE, r.tw * TILE, r.th * TILE).fill({
        color: AMBER,
        alpha: sel ? 0.22 : 0.12,
      });
      g.rect(r.tx * TILE, r.ty * TILE, r.tw * TILE, r.th * TILE).stroke({
        width: 1,
        color: AMBER,
        alpha: sel ? 1 : 0.55,
      });
      this.label(
        `${t.id} ${t.when}${t.once === false ? ' ∞' : ''}`,
        r.tx * TILE + 2,
        r.ty * TILE + 1,
        AMBER,
      );
    }

    // --------------------------------------------------------------- sounds
    for (const e of s.level.sounds) {
      const sel = s.selection?.kind === 'sound' && s.selection.id === e.id;
      g.circle(e.pos.x, e.pos.y, Math.max(1, e.radiusPx)).stroke({
        width: 1,
        color: CYAN,
        alpha: sel ? 0.9 : 0.4,
      });
      if (sel) {
        g.circle(e.pos.x, e.pos.y, Math.max(1, e.radiusPx)).fill({ color: CYAN, alpha: 0.06 });
      }
      g.circle(e.pos.x, e.pos.y, 2.5).fill({ color: CYAN, alpha: 0.95 });
      this.label(`${e.id} ${e.sound}`, e.pos.x + 4, e.pos.y - 4, CYAN);
    }

    // ---------------------------------------------------------------- spawn
    const spawn = s.level.spawn ?? { tx: 0, ty: 0 };
    if (s.level.spawn) {
      const p = at(spawn.tx, spawn.ty);
      g.moveTo(p.x - 7, p.y).lineTo(p.x + 7, p.y);
      g.moveTo(p.x, p.y - 7).lineTo(p.x, p.y + 7);
      g.stroke({ width: 1, color: GREEN, alpha: 0.9 });
      g.circle(p.x, p.y, 7).stroke({ width: 1, color: GREEN, alpha: 0.55 });
      this.label('spawn', p.x + 8, p.y - 3, GREEN);
    }

    // ------------------------------------------------------------- entities
    for (const e of s.level.entities) {
      const p = at(e.tx, e.ty);
      const sel = s.selection?.kind === 'entity' && s.selection.id === e.id;
      if (FOOT_ANCHORED.has(e.kind)) {
        // The sprite's anchor is its GROUND CONTACT, so its pixels hang above
        // the point being edited. Without this tick, an elevator looks a tile
        // higher than the tile it is actually on.
        g.moveTo(p.x - 5, p.y).lineTo(p.x + 5, p.y);
        g.stroke({ width: 1, color: AMBER, alpha: sel ? 0.9 : 0.35 });
      }
      if (!sel) continue;
      g.rect(p.x - 9, p.y - 9, 18, 18).stroke({ width: 1, color: AMBER, alpha: 0.95 });
      this.label(e.id, p.x - 8, p.y - 18, AMBER);
    }

    if (s.lit) this.drawLit(s);

    // ------------------------------------------------------- region / drag
    if (s.region) {
      const r = s.region;
      g.rect(r.tx * TILE, r.ty * TILE, r.tw * TILE, r.th * TILE).fill({ color: 0xffffff, alpha: 0.06 });
      g.rect(r.tx * TILE, r.ty * TILE, r.tw * TILE, r.th * TILE).stroke({
        width: 1,
        color: 0xffffff,
        alpha: 0.5,
      });
    }
    if (s.pendingWet) {
      const w = s.pendingWet;
      g.ellipse(w.tx * TILE, w.ty * TILE, w.rx * TILE, w.ry * TILE).fill({ color: WATER, alpha: 0.16 });
      g.ellipse(w.tx * TILE, w.ty * TILE, w.rx * TILE, w.ry * TILE).stroke({ width: 1, color: WATER, alpha: 0.9 });
    }
    if (s.pending) {
      const r = s.pending.rect;
      const color = s.pending.kind === 'trigger' ? AMBER : 0xffffff;
      g.rect(r.tx * TILE, r.ty * TILE, r.tw * TILE, r.th * TILE).fill({ color, alpha: 0.14 });
      g.rect(r.tx * TILE, r.ty * TILE, r.tw * TILE, r.th * TILE).stroke({ width: 1, color, alpha: 0.8 });
    }
    if (s.hover) {
      g.rect(s.hover.tx * TILE, s.hover.ty * TILE, TILE, TILE).stroke({
        width: 1,
        color: AMBER,
        alpha: 0.5,
      });
    }

    for (let i = this.used; i < this.pool.length; i++) this.pool[i]!.visible = false;
  }

  /**
   * The lit half: water, dressing, lamps and the links between them.
   *
   * All of it is screen-space chrome drawn OUTSIDE the lit render target — the
   * lit scene composes at 480×270 and is then panned and zoomed as one sprite,
   * so anything drawn into it would be baked into the picture, get graded, get
   * fogged, and be unreadable in exactly the dark room it exists to navigate.
   */
  private drawLit(s: OverlayState): void {
    const g = this.g;
    const sel = s.selection;

    // ------------------------------------------------------------- water
    (s.level.wetPatches ?? []).forEach((w, i) => {
      const on = sel?.kind === 'wet' && sel.index === i;
      const cx = w.tx * TILE;
      const cy = w.ty * TILE;
      g.ellipse(cx, cy, w.rx * TILE, w.ry * TILE).stroke({
        width: 1,
        color: WATER,
        alpha: on ? 0.95 : 0.4,
      });
      if (on) {
        g.ellipse(cx, cy, w.rx * TILE, w.ry * TILE).fill({ color: WATER, alpha: 0.1 });
        this.label(`wet ${w.rx.toFixed(1)}×${w.ry.toFixed(1)}`, cx + 3, cy - 5, WATER);
      }
    });

    // ------------------------------------------------ floor variant hints
    //
    // A dot per painted tile. The variant is VISIBLE in the lit preview, so
    // the overlay only has to say "somebody chose this one" — a full glyph
    // would fight the tile it is annotating.
    for (const o of s.level.tiles?.overrides ?? []) {
      g.rect(o.tx * TILE + TILE - 4, o.ty * TILE + 1, 3, 3).fill({ color: VIOLET, alpha: 0.8 });
    }
    for (const row of s.level.tiles?.walkRows ?? []) {
      g.rect(0, row * TILE, TILES_X * TILE, TILE).stroke({ width: 1, color: VIOLET, alpha: 0.18 });
    }

    // ------------------------------------------------------------- decor
    for (const d of s.level.decor ?? []) {
      const on = sel?.kind === 'decor' && sel.id === d.id;
      const entry = decorEntry(d.name);
      const [ax, ay] = entry.anchor ?? [0.5, 0.5];
      const x = d.tx * TILE;
      const y = d.ty * TILE;
      if (on) {
        g.rect(x - ax * entry.w, y - ay * entry.h, entry.w, entry.h).stroke({
          width: 1,
          color: VIOLET,
          alpha: 0.95,
        });
        this.label(d.id, x - ax * entry.w, y - ay * entry.h - 8, VIOLET);
      }
      // The anchor tick, always: a prop's anchor is its GROUND CONTACT and it
      // is the only part of a sprite whose position is the number you edit.
      g.rect(x - 1, y - 1, 2, 2).fill({ color: VIOLET, alpha: on ? 1 : 0.35 });
      if (d.foot && on) {
        g.rect(x - d.foot[0] / 2, y - d.foot[1], d.foot[0], d.foot[1]).stroke({
          width: 1,
          color: VIOLET,
          alpha: 0.45,
        });
      }
    }

    // ------------------------------------------------------------ lights
    for (const l of s.level.lights ?? []) {
      const on = sel?.kind === 'light' && sel.id === l.id;
      const p = lightPos(l);
      const colour = l.color;
      const wedge = isCone(l);
      if (wedge) {
        const a = lightDir(l);
        const sp = lightSpread(l);
        g.moveTo(p.x, p.y)
          .arc(p.x, p.y, l.radius, a - sp, a + sp)
          .lineTo(p.x, p.y)
          .stroke({ width: 1, color: colour, alpha: on ? 0.9 : 0.3 });
        if (on) {
          g.moveTo(p.x, p.y)
            .arc(p.x, p.y, l.radius, a - sp, a + sp)
            .lineTo(p.x, p.y)
            .fill({ color: colour, alpha: 0.07 });
        }
      } else {
        g.circle(p.x, p.y, l.radius).stroke({ width: 1, color: colour, alpha: on ? 0.9 : 0.28 });
      }
      // The lamp itself: a filled dot, ringed when it casts.
      g.circle(p.x, p.y, 2.5).fill({ color: colour, alpha: 0.95 });
      if (l.castShadow !== false) {
        g.circle(p.x, p.y, 4.5).stroke({ width: 1, color: colour, alpha: 0.7 });
      }
      if (on) {
        this.label(`${l.id} r${Math.round(l.radius)}`, p.x + 6, p.y - 4, colour);
        this.drawHandles(l, colour);
      }
    }

    // ------------------------------------------------------ fixture links
    //
    // A lamp is three records held together by one id, and the one thing a
    // designer cannot see in the room is whether the light they are dragging
    // still belongs to the sprite above it.
    for (const d of s.level.decor ?? []) {
      if (!d.fixtureId) continue;
      const light = (s.level.lights ?? []).find((l) => l.id === d.fixtureId);
      const linked =
        sel?.kind === 'decor' ? sel.id === d.id : sel?.kind === 'light' ? sel.id.startsWith(d.fixtureId) : false;
      if (!light) {
        // Broken link: the CHECKS panel says so, but it has to be visible here.
        g.circle(d.tx * TILE, d.ty * TILE, 5).stroke({ width: 1, color: 0xff7b72, alpha: 0.9 });
        continue;
      }
      if (!linked) continue;
      const p = lightPos(light);
      g.moveTo(d.tx * TILE, d.ty * TILE).lineTo(p.x, p.y).stroke({
        width: 1,
        color: VIOLET,
        alpha: 0.7,
      });
    }
  }

  /** The grab points of the selected light. Geometry from litHandles.ts. */
  private drawHandles(l: Parameters<typeof lightPos>[0], colour: number): void {
    const g = this.g;
    const dot = (p: { x: number; y: number }, fill: number): void => {
      g.circle(p.x, p.y, 2.5).fill({ color: fill, alpha: 1 });
      g.circle(p.x, p.y, 2.5).stroke({ width: 1, color: 0x05070a, alpha: 0.8 });
    };
    dot(radiusHandle(l), 0xffffff);
    const dir = dirHandle(l);
    if (dir) dot(dir, colour);
    const spread = spreadHandles(l);
    if (spread) {
      dot(spread[0], AMBER);
      dot(spread[1], AMBER);
    }
  }
}
