/**
 * THE ASSET LIBRARY — tools down the left, and every placeable thing under them
 * with its REAL sprite as the thumbnail.
 *
 * The thumbnails come out of the same texture the game draws with, pulled back
 * to a canvas through `renderer.extract`. A hand-made icon set would be a second
 * picture of the world that is free to disagree with the first one, which is the
 * whole failure mode this designer exists to end.
 *
 * This module also owns the enum tables. Each is keyed `Record<Enum, …>`, so a
 * new EntityKind, SfxName or ChipId in shared/types.ts fails the build here
 * rather than silently going missing from the dropdowns.
 */

import type { Renderer } from 'pixi.js';
import { Sprite } from 'pixi.js';
import type { ChipId, DecorName, EntityKind, LevelEntityDef, SfxName } from '@shared/types';
import { TILE } from '@shared/types';
import type { ArtName } from '@shared/artManifest';
import type { PixiArtAtlas } from '../art/index';
import { Px } from '../art/px';
import { drawLitFloor } from '../render/lit/litTiles';
import {
  CEILING_FIXTURE,
  DECOR_NAMES,
  LIGHT_PRESETS,
  WALL_FIXTURE,
  decorThumb,
} from './litAssets';
import { el, mkBtn } from './ui';
import type { ToolId } from './tools';

interface KindInfo {
  /** Panel caption. */
  label: string;
  /** Id stem for a freshly placed one. */
  prefix: string;
  art: ArtName;
}

/**
 * Kind → art entry. A near-copy of `KIND_ART` in render/world.ts, which is
 * module-private there; the pairing is stable content, and the alternative was
 * widening the renderer's surface for a dev tool.
 */
const KINDS: Record<EntityKind, KindInfo> = {
  scrap: { label: 'scrap', prefix: 'scrap', art: 'scrap' },
  chip: { label: 'chip', prefix: 'chip', art: 'chip_item' },
  crate: { label: 'crate', prefix: 'crate', art: 'crate' },
  debris: { label: 'debris', prefix: 'pile', art: 'debris_pile' },
  cable: { label: 'cable', prefix: 'cable', art: 'cable' },
  fusedPrinter: { label: 'printer', prefix: 'printer', art: 'fused_printer' },
  fusedShredder: { label: 'SHREDDER', prefix: 'boss', art: 'fused_shredder' },
  printerInnocent: { label: 'nice printer', prefix: 'printer_nice', art: 'printer_innocent' },
  mop: { label: 'mop', prefix: 'mop', art: 'mop' },
  chair: { label: 'chair', prefix: 'chair', art: 'office_chair' },
  fuse: { label: 'fuse', prefix: 'fuse', art: 'fuse' },
  fuseSocket: { label: 'socket', prefix: 'socket', art: 'fuse_socket' },
  elevatorA: { label: 'elevator A', prefix: 'elevA', art: 'elevator' },
  elevatorB: { label: 'elevator B', prefix: 'elevB', art: 'elevator' },
};

export const ENTITY_KINDS = Object.keys(KINDS) as EntityKind[];
export const kindInfo = (kind: EntityKind): KindInfo => KINDS[kind];

const CHIPS: Record<ChipId, true> = {
  MAGNET: true,
  RAGE: true,
  SCARED: true,
  MEMORY: true,
  ZAP: true,
  TOUGH: true,
};
export const CHIP_IDS = Object.keys(CHIPS) as ChipId[];

const SFX: Record<SfxName, true> = {
  radio_on: true,
  radio_off: true,
  static_burst: true,
  servo: true,
  bump: true,
  shoot: true,
  zap: true,
  spark_loop: true,
  elevator_ding: true,
  doors: true,
  powerup: true,
  powerdown: true,
  boot: true,
  paper: true,
  hit: true,
  enemy_die: true,
  scrap: true,
  spin: true,
  fuse_in: true,
  title: true,
  mortar_launch: true,
  mortar_warn: true,
  boom_small: true,
  boom_big: true,
  boom_huge: true,
  rocket_fire: true,
  boss_roar: true,
  alarm: true,
};
export const SFX_NAMES = Object.keys(SFX) as SfxName[];

/**
 * A freshly placed thing. Only the fields the builders cannot infer are set:
 * everything else (label, hp, state) comes from the SAME builder the
 * hand-authored floors use, through `levelToFloorDef`.
 */
export function defaultEntityDef(kind: EntityKind, id: string, tx: number, ty: number): LevelEntityDef {
  const def: LevelEntityDef = { id, kind, tx, ty };
  if (kind === 'chip' || kind === 'crate') def.option = 'MEMORY';
  if (kind === 'fusedPrinter') def.hp = 3;
  return def;
}

// ------------------------------------------------------------------ panel

interface Tool {
  id: ToolId;
  label: string;
  key: string;
  hint: string;
}

export const TOOLS: Tool[] = [
  { id: 'select', label: 'V select', key: 'v', hint: 'select / move / marquee (V)' },
  { id: 'brush', label: 'B brush', key: 'b', hint: 'paint walls; right-drag or Alt erases (B)' },
  { id: 'rect', label: 'R rect', key: 'r', hint: 'wall rectangle (R)' },
  { id: 'fill', label: 'G fill', key: 'g', hint: 'flood fill (G)' },
  { id: 'eyedropper', label: 'I pick', key: 'i', hint: 'sample a tile into the brush (I)' },
  { id: 'entity', label: 'E entity', key: 'e', hint: 'place the selected asset (E)' },
  { id: 'trigger', label: 'T trigger', key: 't', hint: 'drag a trigger region (T)' },
  { id: 'sound', label: 'N sound', key: 'n', hint: 'drop a sound emitter (N)' },
  { id: 'spawn', label: 'S spawn', key: 's', hint: 'set the robot start tile (S)' },
  { id: 'decor', label: 'D decor', key: 'd', hint: 'place the selected prop, ¼-tile snap; Alt = free (D)' },
  { id: 'light', label: 'K light', key: 'k', hint: 'place a light — L is the preview toggle (K)' },
  { id: 'wet', label: 'W water', key: 'w', hint: 'drag a wet-floor ellipse (W)' },
  { id: 'variant', label: 'Y tiles', key: 'y', hint: 'paint floor variants; Alt clears (Y)' },
];

export interface PaletteOpts {
  renderer: Renderer;
  art: PixiArtAtlas;
  getTool: () => ToolId;
  getKind: () => EntityKind;
  setTool: (t: ToolId) => void;
  setKind: (k: EntityKind) => void;
  getDecor: () => DecorName;
  setDecor: (n: DecorName) => void;
  getLight: () => string;
  setLight: (key: string) => void;
  getVariant: () => number;
  setVariant: (v: number) => void;
}

export interface Palette {
  /** Repaint the active-state highlights. */
  sync(): void;
  /** Jump to the page that owns a tool — placing a prop should show the props. */
  showFor(tool: ToolId): void;
}

/**
 * The floor variant contract, from render/lit/litTiles.ts. Indices are DATA:
 * a saved override is a number, so renaming one here is free and renumbering
 * one silently redresses every level that used it.
 */
export const TILE_VARIANTS: ReadonlyArray<{ index: number; label: string }> = [
  { index: 0, label: 'panel A' },
  { index: 1, label: 'panel B' },
  { index: 2, label: 'panel C' },
  { index: 3, label: 'crack' },
  { index: 4, label: 'grate' },
  { index: 5, label: 'lifted' },
  { index: 6, label: 'hazard' },
  { index: 7, label: 'stain' },
];

/** One sprite frame, pulled back out of the GPU at native size. */
function thumb(renderer: Renderer, art: PixiArtAtlas, name: ArtName): HTMLElement {
  try {
    const sprite = new Sprite(art.tex(name));
    const canvas = renderer.extract.canvas(sprite) as HTMLCanvasElement;
    sprite.destroy();
    if (canvas.width > 0) return canvas;
  } catch {
    // WebGL readback can fail (lost context, headless); a label-only tile is
    // still a usable palette, so this is never fatal.
  }
  return el('div', 'rd-swatch');
}

type PageId = 'entities' | 'decor' | 'lights';

/** Which page a tool belongs to, so picking a tool shows what it places. */
const TOOL_PAGE: Partial<Record<ToolId, PageId>> = {
  entity: 'entities',
  decor: 'decor',
  light: 'lights',
  wet: 'lights',
  variant: 'lights',
};

export function createPalette(host: HTMLElement, opts: PaletteOpts): Palette {
  host.appendChild(el('div', 'rd-secthead', 'tools'));
  const toolGrid = el('div', 'rd-tools');
  const toolBtns = new Map<ToolId, HTMLButtonElement>();
  for (const t of TOOLS) {
    const b = mkBtn(t.label, t.hint);
    b.addEventListener('click', () => opts.setTool(t.id));
    toolGrid.appendChild(b);
    toolBtns.set(t.id, b);
  }
  host.appendChild(toolGrid);

  // ------------------------------------------------------------------ pages
  let page: PageId = 'entities';
  const pageBar = el('div', 'rd-pages');
  const pageBtns = new Map<PageId, HTMLElement>();
  const pageBodies = new Map<PageId, HTMLElement>();
  const addPage = (id: PageId, label: string): HTMLElement => {
    const tab = el('button', 'rd-page', label);
    tab.addEventListener('click', () => setPage(id));
    pageBar.appendChild(tab);
    pageBtns.set(id, tab);
    const body = el('div', 'rd-pagebody');
    pageBodies.set(id, body);
    return body;
  };
  host.appendChild(pageBar);
  const entPage = addPage('entities', 'ENTITIES');
  const decorPage = addPage('decor', 'DECOR');
  const lightPage = addPage('lights', 'LIGHTS');
  host.append(entPage, decorPage, lightPage);

  function setPage(id: PageId): void {
    page = id;
    for (const [key, body] of pageBodies) body.classList.toggle('rd-hidden', key !== id);
    for (const [key, tab] of pageBtns) tab.classList.toggle('rd-on', key === id);
  }

  // --------------------------------------------------------------- entities
  entPage.appendChild(el('div', 'rd-secthead', 'assets — 1..9 picks'));
  const grid = el('div', 'rd-assets');
  const tiles = new Map<EntityKind, HTMLElement>();
  ENTITY_KINDS.forEach((kind) => {
    const info = KINDS[kind];
    const tile = el('div', 'rd-asset');
    tile.title = `${info.label} — click to place with E`;
    tile.append(thumb(opts.renderer, opts.art, info.art), el('span', undefined, info.label));
    tile.addEventListener('click', () => {
      opts.setKind(kind);
      opts.setTool('entity');
    });
    grid.appendChild(tile);
    tiles.set(kind, tile);
  });
  entPage.appendChild(grid);

  // ------------------------------------------------------------------ decor
  //
  // Thumbnails come from the decor drawer table itself — the same function that
  // paints the prop into the room paints it into this tile, at native size.
  decorPage.appendChild(el('div', 'rd-secthead', 'props — click, then D places'));
  const decorGrid = el('div', 'rd-decor');
  const decorTiles = new Map<DecorName, HTMLElement>();
  for (const name of DECOR_NAMES) {
    const tile = el('div', 'rd-asset');
    const fixture = name === CEILING_FIXTURE || name === WALL_FIXTURE;
    tile.title = fixture
      ? `${name} — places the prop, its light and its fixture as one lamp`
      : name;
    tile.append(decorThumb(name), el('span', undefined, name.replace(/_/g, ' ')));
    tile.addEventListener('click', () => {
      opts.setDecor(name);
      opts.setTool('decor');
    });
    decorGrid.appendChild(tile);
    decorTiles.set(name, tile);
  }
  decorPage.appendChild(decorGrid);
  decorPage.appendChild(
    el(
      'div',
      'rd-note',
      'ceiling lamp and wall lamp arrive wired: prop + light + fixture, one id. A wall lamp wants a south-facing wall face.',
    ),
  );

  // ----------------------------------------------------------------- lights
  lightPage.appendChild(el('div', 'rd-secthead', 'lights — click, then K places'));
  const lightGrid = el('div', 'rd-assets');
  const lightTiles = new Map<string, HTMLElement>();
  for (const preset of LIGHT_PRESETS) {
    const tile = el('div', 'rd-asset');
    tile.title = preset.hint;
    const sw = el('div', 'rd-swatch');
    const probe = preset.make('probe', 0, 0);
    sw.style.background = '#' + probe.color.toString(16).padStart(6, '0');
    sw.style.borderRadius = probe.kind === 'cone' ? '2px 12px 12px 2px' : '50%';
    tile.append(sw, el('span', undefined, preset.label));
    tile.addEventListener('click', () => {
      opts.setLight(preset.key);
      opts.setTool('light');
    });
    lightGrid.appendChild(tile);
    lightTiles.set(preset.key, tile);
  }
  lightPage.appendChild(lightGrid);

  lightPage.appendChild(el('div', 'rd-secthead', 'floor variants — Y paints'));
  const varGrid = el('div', 'rd-assets');
  const varTiles = new Map<number, HTMLElement>();
  for (const v of TILE_VARIANTS) {
    const tile = el('div', 'rd-asset');
    tile.title = `variant ${v.index} — ${v.label}`;
    tile.append(tileVariantThumb(v.index), el('span', undefined, v.label));
    tile.addEventListener('click', () => {
      opts.setVariant(v.index);
      opts.setTool('variant');
    });
    varGrid.appendChild(tile);
    varTiles.set(v.index, tile);
  }
  lightPage.appendChild(varGrid);
  lightPage.appendChild(
    el('div', 'rd-note', 'W drags a wet-floor ellipse. Hazard lanes are whole rows — LOOK tab.'),
  );

  setPage('entities');

  function sync(): void {
    const tool = opts.getTool();
    for (const [id, btn] of toolBtns) btn.classList.toggle('rd-on', id === tool);
    const kind = opts.getKind();
    for (const [k, tile] of tiles) tile.classList.toggle('rd-on', k === kind);
    const decor = opts.getDecor();
    for (const [n, tile] of decorTiles) tile.classList.toggle('rd-on', n === decor);
    const light = opts.getLight();
    for (const [k, tile] of lightTiles) tile.classList.toggle('rd-on', k === light);
    const variant = opts.getVariant();
    for (const [v, tile] of varTiles) tile.classList.toggle('rd-on', v === variant);
  }
  sync();
  return {
    sync,
    showFor(tool) {
      const target = TOOL_PAGE[tool];
      if (target && target !== page) setPage(target);
    },
  };
}

/** One floor tile, drawn by the renderer's own tile drawer. */
function tileVariantThumb(index: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d');
  if (ctx) drawLitFloor(new Px(ctx, TILE, TILE), index);
  return canvas;
}
