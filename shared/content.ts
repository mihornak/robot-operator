/** Chip definitions + floor metadata shared by sim (effects), director (script), parser (options). */

import type { ChipId, ModuleId } from './types';

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

/**
 * Everything that can be INSTALLED, as the install card reads it: the six chips
 * plus the two crate upgrades. One table, because "what does this thing say on
 * screen when I get it" should not be answerable in two different places.
 */
export const MODULES: Record<ModuleId, { name: string; blurb: string }> = {
  MAGNET: { name: 'MAGNET', blurb: CHIPS.MAGNET.blurb },
  RAGE: { name: 'RAGE', blurb: CHIPS.RAGE.blurb },
  SCARED: { name: 'SCARED', blurb: CHIPS.SCARED.blurb },
  MEMORY: { name: 'MEMORY', blurb: CHIPS.MEMORY.blurb },
  ZAP: { name: 'ZAP', blurb: CHIPS.ZAP.blurb },
  TOUGH: { name: 'TOUGH', blurb: CHIPS.TOUGH.blurb },
  EARS: { name: 'EARS', blurb: 'Hears further. Notices more.' },
  BRAIN: { name: 'BRAIN', blurb: 'Has ideas. Makes plans.' },
  ROCKET: { name: 'ROCKET', blurb: 'Big pew pew. Blows things up.' },
};

/**
 * Triads per floor (1-based floor number). ONE ceremony, and it lands early:
 * floor 2 is a quiet room whose only demand is a choice, which is the gentlest
 * possible place to teach that the crate is worth crossing a floor for and
 * that the operator's voice is what resolves it. Everything after is a chip
 * lying on the floor you can simply see and want (`kind: 'chip'` entities in
 * sim/floors.ts) — MEMORY on 3, ZAP on 4, MAGNET on 5.
 *
 * KEYED BY FLOOR NUMBER: this must move with the running order in
 * sim/floors.ts, or the ceremony crate sits on a floor with no ceremony.
 */
/**
 * EMPTY BY DESIGN. No floor currently offers a three-way choice: MEMORY is a
 * chip lying in the island pocket on floor 2, because a gag whose punchline the
 * player can accidentally trade away for a combat chip mostly does not land.
 *
 * The ceremony machinery is intact and unused — add a floor number here and put
 * a `triadCrate` on that floor and it runs again, card, voice selection and all.
 */
export const TRIADS: Record<number, ChipId[]> = {};

export const FLOOR_COUNT = 5;

/** Robot base stats (sim applies chip modifiers on top). */
export const BASE = {
  hp: 6,
  speedPxS: 55,
  damage: 1,
  shootCdTicks: 24, // 0.4s
  radioCooldownMs: 1500, // fiction: radio recharge; director enforces
} as const;
