/** Chip definitions + floor metadata shared by sim (effects), director (script), parser (options). */

import type { ChipId } from './types';

export interface ChipDef {
  id: ChipId;
  /** Spoken/read name — one word, phonetically distinct (naming law). */
  spoken: string;
  /** What the crate-read ceremony bank line is called. */
  crateLineId: string;
  installLineId: string;
  blurb: string; // options-card line — MUST fit 2 short lines
}

export const CHIPS: Record<ChipId, ChipDef> = {
  MAGNET: {
    id: 'MAGNET',
    spoken: 'magnet',
    crateLineId: 'crate_magnet',
    installLineId: 'install_magnet',
    blurb: 'Loves shiny. Detours for scrap.',
  },
  RAGE: {
    id: 'RAGE',
    spoken: 'rage',
    crateLineId: 'crate_rage',
    installLineId: 'install_rage',
    blurb: 'Hits harder. Never backs down.',
  },
  SCARED: {
    id: 'SCARED',
    spoken: 'scared',
    crateLineId: 'crate_scared',
    installLineId: 'install_scared',
    blurb: 'Faster. Runs at half health.',
  },
  MEMORY: {
    id: 'MEMORY',
    spoken: 'memory',
    crateLineId: 'crate_memory',
    installLineId: 'install_memory',
    blurb: 'Remembers. Keeps his name.',
  },
  ZAP: {
    id: 'ZAP',
    spoken: 'zap',
    crateLineId: 'crate_zap',
    installLineId: 'install_zap',
    blurb: 'Bigger pew pew, faster.',
  },
  TOUGH: {
    id: 'TOUGH',
    spoken: 'tough',
    crateLineId: 'crate_tough',
    installLineId: 'install_tough',
    blurb: 'More health. Shrugs off hits.',
  },
};

/** Triads per floor (1-based floor number). */
export const TRIADS: Record<number, ChipId[]> = {
  2: ['MAGNET', 'RAGE', 'SCARED'],
  5: ['MEMORY', 'ZAP', 'TOUGH'],
};

export const FLOOR_COUNT = 5;

/** Robot base stats (sim applies chip modifiers on top). */
export const BASE = {
  hp: 6,
  speedPxS: 55,
  damage: 1,
  shootCdTicks: 24, // 0.4s
  radioCooldownMs: 1500, // fiction: radio recharge; director enforces
} as const;
