/**
 * Assembles every manifest entry into pixi Textures. Pure code drawing —
 * one offscreen canvas per frame, nearest-neighbor, no files, no fetches.
 */

import { Texture } from 'pixi.js';
import { ART, type ArtName } from '@shared/artManifest';
import type { ArtAtlas } from '@shared/types';
import { AMBER, G } from './palette';
import { Px, type Drawer } from './px';
import { drawFloor, drawTileShadow, drawWallFace, drawWallTop } from './tiles';
import {
  drawPartAntenna,
  drawPartPlate,
  drawRobotBody,
  drawRobotHead,
  drawRobotWheels,
} from './robot';
import {
  drawFusedPrinter,
  drawFusedPrinterSpit,
  drawMop,
  drawPrinterInnocent,
} from './enemies';
import {
  drawCable,
  drawCrate,
  drawElevator,
  drawFuse,
  drawFuseSocket,
  drawPedestal,
  drawScrap,
} from './props';
import {
  drawBolt,
  drawFxBoom,
  drawFxMuzzle,
  drawFxSmoke,
  drawFxSpark,
  drawPaper,
} from './fx';
import { glyphDrawer } from './glyphs';

export { HEAD_DIRS } from './robot';

const DRAWERS: Record<ArtName, Drawer> = {
  robot_body: drawRobotBody,
  robot_wheels: drawRobotWheels,
  robot_head: drawRobotHead,
  part_plate: drawPartPlate,
  part_antenna: drawPartAntenna,
  fused_printer: drawFusedPrinter,
  fused_printer_spit: drawFusedPrinterSpit,
  printer_innocent: drawPrinterInnocent,
  mop: drawMop,
  scrap: drawScrap,
  crate: drawCrate,
  pedestal: drawPedestal,
  fuse: drawFuse,
  fuse_socket: drawFuseSocket,
  cable: drawCable,
  elevator: drawElevator,
  tile_floor: drawFloor,
  tile_wall_face: drawWallFace,
  tile_wall_top: drawWallTop,
  tile_shadow: drawTileShadow,
  bolt: drawBolt,
  paper: drawPaper,
  fx_spark: drawFxSpark,
  fx_smoke: drawFxSmoke,
  fx_muzzle: drawFxMuzzle,
  fx_boom: drawFxBoom,
  glyph_MAGNET: glyphDrawer('MAGNET'),
  glyph_RAGE: glyphDrawer('RAGE'),
  glyph_SCARED: glyphDrawer('SCARED'),
  glyph_MEMORY: glyphDrawer('MEMORY'),
  glyph_ZAP: glyphDrawer('ZAP'),
  glyph_TOUGH: glyphDrawer('TOUGH'),
};

function drawFrame(name: ArtName, frame: number): HTMLCanvasElement {
  const { w, h } = ART[name];
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  DRAWERS[name](new Px(ctx, w, h), frame);
  return canvas;
}

/** ArtAtlas narrowed to actual pixi Textures. */
export interface PixiArtAtlas extends ArtAtlas {
  frames(name: ArtName): Texture[];
  tex(name: ArtName): Texture;
}

export async function initArt(): Promise<PixiArtAtlas> {
  const cache = new Map<ArtName, Texture[]>();
  for (const name of Object.keys(ART) as ArtName[]) {
    const list: Texture[] = [];
    for (let f = 0; f < ART[name].frames; f++) {
      const texture = Texture.from(drawFrame(name, f));
      texture.source.scaleMode = 'nearest';
      list.push(texture);
    }
    cache.set(name, list);
  }
  const get = (name: string): Texture[] => {
    const list = cache.get(name as ArtName);
    if (!list) throw new Error(`unknown art name: ${name}`);
    return list;
  };
  return {
    frames: (name) => get(name),
    tex: (name) => get(name)[0],
  };
}

/**
 * Labeled contact sheet of every sprite/frame at `scale`× — the art QA
 * surface for render/integration. Not part of the game scene graph.
 */
export function debugSheet(scale = 4): HTMLCanvasElement {
  const names = Object.keys(ART) as ArtName[];
  const pad = 8;
  const labelW = 190;
  const rowH = (n: ArtName) => Math.max(ART[n].h * scale, 14) + pad;
  const sheetW =
    labelW + pad + Math.max(...names.map((n) => ART[n].frames * (ART[n].w * scale + pad)));
  const sheetH = names.reduce((a, n) => a + rowH(n), pad);

  const canvas = document.createElement('canvas');
  canvas.width = sheetW;
  canvas.height = sheetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = G.g0;
  ctx.fillRect(0, 0, sheetW, sheetH);
  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';

  let y = pad;
  for (const name of names) {
    const e = ART[name];
    ctx.fillStyle = AMBER;
    ctx.fillText(`${name} ${e.w}x${e.h} f${e.frames}`, pad, y + 2);
    let x = labelW + pad;
    for (let f = 0; f < e.frames; f++) {
      // checker backdrop so transparency is visible
      const cell = new Px(ctx, sheetW, sheetH);
      for (let cy = 0; cy < e.h * scale; cy += 4)
        for (let cx = 0; cx < e.w * scale; cx += 4)
          cell.r(x + cx, y + cy, 4, 4, ((cx + cy) & 4) === 0 ? G.g1 : G.g2);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(drawFrame(name, f), x, y, e.w * scale, e.h * scale);
      ctx.strokeStyle = G.g5;
      ctx.strokeRect(x - 0.5, y - 0.5, e.w * scale + 1, e.h * scale + 1);
      x += e.w * scale + pad;
    }
    y += rowH(name);
  }
  return canvas;
}
