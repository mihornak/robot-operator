/**
 * The debris heap with something alive in it.
 *
 * FIRST_MINUTES treats the seconds before the wake as load-bearing: a room of
 * dead junk, and one heap that breathes, leaks a warm ember and shudders when
 * the thing inside moves. It is the whole reason the player leans in before the
 * robot has done anything.
 *
 * The behaviour lives here rather than in either renderer because both of them
 * need exactly it and neither owns it: the classic path applies the result to
 * pooled sprites, the lit path hands it over as actor parts. What is shared is
 * the DECISION — which frame, how far it shudders, how bright the ember, and
 * when a glint escapes — and the timings in it were tuned once, against the
 * director's `ui.pileStir` pulse.
 */

import type { ArtAtlas } from '@shared/types';
import type { FxSystem } from './fx';
import { frames, tex } from './util';

/**
 * The mutable half. Both renderers keep one of these per heap; `WorldView`'s
 * per-entity view satisfies it structurally, which is why this is a bag of
 * three fields and not a class.
 */
export interface PileState {
  /** Countdown to the next escaping glint, seconds. */
  sparkT: number;
  /** The one-shot wake explosion has already been thrown. */
  seenBurst: boolean;
  /** Ember brightness, 0..1. It DECAYS from wherever it was, so it is state. */
  ember: number;
}

export interface PileLook {
  /** Index into the `debris_pile` frames: settled / stir left / stir right / burst. */
  frame: number;
  /** Sideways shudder offset in px, to add to the heap's own x. */
  dx: number;
  /** Ember brightness, 0..1. Also written back into `state`. */
  ember: number;
}

/** THE heap — the only one with a robot inside it. Every other pile on the
 *  floor is scenery and must stay perfectly still: `ui.pileStir` is one number
 *  for the whole feed, and applying it to every heap reads as an earthquake. */
const HERO_ID = 'pile1';

export interface PileArgs {
  fx: FxSystem;
  art: ArtAtlas;
  state: PileState;
  /** Presentation rng, seeded per entity — jitter only, never sim. */
  rng: () => number;
  id: string;
  /** Heap position in world px. */
  x: number;
  y: number;
  /** Sim state 'burst' — the heap has caved in. */
  burst: boolean;
  /** `ui.pileStir`, the director's 1→0 pulse when the thing inside moves. */
  stir: number;
  /** Render clock, seconds. */
  t: number;
  dt: number;
}

export function updatePile(o: PileArgs): PileLook {
  const { fx, art, state, x, y, t, dt } = o;
  const hero = o.id === HERO_ID;

  if (o.burst) {
    if (!state.seenBurst) {
      state.seenBurst = true;
      fx.smoke(x, y - 10, 1.2);
      for (let i = 0; i < 7; i++) {
        const a = -Math.PI / 2 + (i / 6 - 0.5) * 2.1;
        fx.spawn({
          x,
          y: y - 12,
          tex: frames(art, 'fx_spark'),
          fps: 12,
          life: 0.5,
          vx: Math.cos(a) * 70,
          vy: Math.sin(a) * 60,
          grav: 190,
          fade: true,
          blend: 'add',
          scale: 0.7,
        });
        fx.part(x, y - 12, tex(art, i % 2 ? 'part_plate' : 'part_antenna'), 0x6a6f76);
      }
    }
    state.ember = Math.max(0, state.ember - dt * 0.9);
    return { frame: 3, dx: 0, ember: state.ember };
  }

  const stir = hero ? o.stir : 0;
  const moving = stir > 0.05;
  const frame = moving ? (Math.floor(t * 14) % 2 === 0 ? 1 : 2) : 0;
  const dx = moving ? Math.sin(t * 46) * 1.4 * stir : 0;
  // Slow ember breath, brighter for a moment on every stir.
  if (hero) state.ember = 0.05 + 0.05 * (0.5 + 0.5 * Math.sin(t * 1.9)) + 0.22 * stir;

  // A lone glint escaping the heap every few seconds — "something lives".
  if (hero) {
    state.sparkT -= dt;
    if (state.sparkT <= 0) {
      state.sparkT = 2.2 + o.rng() * 2.4;
      fx.spawn({
        x: x + (o.rng() - 0.5) * 8,
        y: y - 10,
        tex: frames(art, 'fx_spark'),
        fps: 8,
        life: 0.5,
        vy: -9,
        fade: true,
        loop: true,
        blend: 'add',
        scale: 0.5,
        tint: 0xffc36b,
      });
    }
  }

  return { frame, dx, ember: state.ember };
}
