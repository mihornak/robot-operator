/** Chip definitions + floor metadata shared by sim (effects), director (script), parser (options). */

import type { ChipId } from './types';

export interface ChipDef {
  id: ChipId;
  /** Spoken/read name — one word, phonetically distinct (naming law). */
  spoken: string;
  /** What the crate-read ceremony bank line is called. */
  crateLineId: string;
  installLineId: string;
  blurb: string; // for logs/death card only, never UI text walls
}

export const CHIPS: Record<ChipId, ChipDef> = {
  MAGNET: {
    id: 'MAGNET',
    spoken: 'magnet',
    crateLineId: 'crate_magnet',
    installLineId: 'install_magnet',
    blurb: 'Scrap magnet; detours to loot mid-combat.',
  },
  RAGE: {
    id: 'RAGE',
    spoken: 'rage',
    crateLineId: 'crate_rage',
    installLineId: 'install_rage',
    blurb: '+50% damage; will not disengage from a visible enemy.',
  },
  SCARED: {
    id: 'SCARED',
    spoken: 'scared',
    crateLineId: 'crate_scared',
    installLineId: 'install_scared',
    blurb: '+30% speed; auto-flees below 50% HP regardless of orders.',
  },
  MEMORY: {
    id: 'MEMORY',
    spoken: 'memory',
    crateLineId: 'crate_memory',
    installLineId: 'install_memory',
    blurb: 'Keeps his name across floors. The emotional pick.',
  },
  ZAP: {
    id: 'ZAP',
    spoken: 'zap',
    crateLineId: 'crate_zap',
    installLineId: 'install_zap',
    blurb: '+damage, faster shots.',
  },
  TOUGH: {
    id: 'TOUGH',
    spoken: 'tough',
    crateLineId: 'crate_tough',
    installLineId: 'install_tough',
    blurb: '+50% max HP, knockback resist.',
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
