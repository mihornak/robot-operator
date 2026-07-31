/** OSD module glyphs — 8×8 crisp 1px icons, amber on transparent. */

import type { ChipId } from '@shared/types';
import { AMBER } from './palette';
import type { Drawer, Px } from './px';

const GLYPHS: Record<ChipId, readonly string[]> = {
  MAGNET: [
    '..XXXX..',
    '.XXXXXX.',
    '.XX..XX.',
    '.XX..XX.',
    '.XX..XX.',
    '........',
    '.X....X.',
    '........',
  ],
  RAGE: [
    'X..X..X.',
    '.X.X.X..',
    '..XXX...',
    'XXX.XXX.',
    '..XXX...',
    '.X.X.X..',
    'X..X..X.',
    '........',
  ],
  SCARED: [
    '...XX...',
    '...XX...',
    '...XX...',
    '...XX...',
    '...XX...',
    '........',
    '...XX...',
    '........',
  ],
  MEMORY: [
    '..X..X..',
    '.XXXXXX.',
    'XX....XX',
    '.X.XX.X.',
    '.X.XX.X.',
    'XX....XX',
    '.XXXXXX.',
    '..X..X..',
  ],
  ZAP: [
    '...XXX..',
    '..XXX...',
    '.XXX....',
    '.XXXXX..',
    '...XX...',
    '..XX....',
    '.X......',
    '........',
  ],
  TOUGH: [
    '.XXXXXX.',
    '.X....X.',
    '.X.XX.X.',
    '.X.XX.X.',
    '..X..X..',
    '...XX...',
    '........',
    '........',
  ],
};

export function glyphDrawer(id: ChipId): Drawer {
  return (p: Px, _frame: number) => p.bmp(0, 0, GLYPHS[id], { X: AMBER });
}
