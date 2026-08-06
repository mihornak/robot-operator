/**
 * The `src: 'png'` half of the manifest: sprites pre-rendered from 3D models by
 * `tools/render-sprite.py` at build time. See `tools/sprites.json` for the jobs.
 *
 * Static imports, not fetches. Vite resolves each to a data URI at these sizes
 * (well under its 4KB inline limit), so the "no runtime fetches, no external
 * assets" law in CLAUDE.md holds exactly as it does for the code-drawn art —
 * these decode from a string in the bundle, same as the canvases next door.
 */

import type { ArtName } from '@shared/artManifest';
import officeChair from './sprites/office_chair.png';

/** Every manifest entry with `src: 'png'` must appear here or initArt throws. */
export const SPRITE_URLS: Partial<Record<ArtName, string>> = {
  office_chair: officeChair,
};

/** Decoded and ready to hand to `Texture.from` — the one async step in art. */
export async function loadSprite(name: ArtName): Promise<HTMLImageElement> {
  const url = SPRITE_URLS[name];
  if (!url) throw new Error(`art ${name} is src:'png' but has no entry in sprites.ts`);
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}
