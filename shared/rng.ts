/** Deterministic rng. Sim owns rngState in SimState; call next(state) style. */

/** mulberry32 step: returns [0,1) float and the advanced state. */
export function rngNext(state: number): { value: number; state: number } {
  let a = (state + 0x6d2b79f5) | 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: a };
}

/** Convenience for non-sim (presentation-only) randomness — do NOT use in sim. */
export function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    const r = rngNext(s);
    s = r.state;
    return r.value;
  };
}
