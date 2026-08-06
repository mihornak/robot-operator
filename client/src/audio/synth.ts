/**
 * Tiny WebAudio synth DSL + the per-SfxName synthesized fallbacks.
 * The game must NEVER be silent: if an sfx mp3 is missing, `FALLBACKS[name]`
 * plays a primitive-built approximation instead (self-contained bundle law).
 */

import type { SfxName } from '@shared/types';

// ---------------------------------------------------------------- buffers

const whiteCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** 1s of white noise, cached per context. */
export function whiteBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = whiteCache.get(ctx);
  if (buf) return buf;
  buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  whiteCache.set(ctx, buf);
  return buf;
}

/** 4s brown-noise loop (room tone). */
export function brownBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = last * 3.5;
  }
  return buf;
}

/** 2s radio-static loop: low hiss with sparse pops (voice bed). */
export function crackleBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const pop = Math.random() < 0.0008 ? (Math.random() * 2 - 1) * 0.9 : 0;
    d[i] = (Math.random() * 2 - 1) * 0.12 + pop;
  }
  return buf;
}

// ---------------------------------------------------------------- curves

/** Mild saturation for the voice radio chain. */
export function satCurve(): Float32Array<ArrayBuffer> {
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) c[i] = Math.tanh(3 * ((i / (c.length - 1)) * 2 - 1));
  return c;
}

/** Amplitude quantization — the bitcrush-ish parallel layer (no ScriptProcessor). */
export function crushCurve(steps = 12): Float32Array<ArrayBuffer> {
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) c[i] = Math.round(((i / (c.length - 1)) * 2 - 1) * steps) / steps;
  return c;
}

// ---------------------------------------------------------------- synth DSL

/** One-shot scheduler: every call is fire-and-forget onto `out`. */
export class Synth {
  constructor(
    private ctx: BaseAudioContext,
    private out: AudioNode,
    private vol = 1,
  ) {}

  private env(node: AudioNode, dur: number, vol: number, at: number): void {
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime + at;
    const attack = Math.min(0.005, dur / 4);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol * this.vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g).connect(this.out);
  }

  /** Oscillator, freq swept f0→f1 over dur. `wob` = [lfoHz, depthHz] vibrato. */
  tone(
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    vol: number,
    at = 0,
    wob?: [number, number],
  ): void {
    const t = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(f0, 1), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    if (wob) {
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = wob[0];
      const lg = this.ctx.createGain();
      lg.gain.value = wob[1];
      lfo.connect(lg);
      lg.connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.02);
    }
    this.env(o, dur, vol, at);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** White-noise burst through an optional biquad. */
  noise(dur: number, vol: number, filter?: BiquadFilterType, freq = 1000, q = 1, at = 0): void {
    const t = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource();
    src.buffer = whiteBuffer(this.ctx);
    src.loop = true;
    let node: AudioNode = src;
    if (filter) {
      const f = this.ctx.createBiquadFilter();
      f.type = filter;
      f.frequency.value = freq;
      f.Q.value = q;
      src.connect(f);
      node = f;
    }
    this.env(node, dur, vol, at);
    src.start(t);
    src.stop(t + dur + 0.02);
  }
}

// ---------------------------------------------------------------- fallbacks

/** Exhaustive: one synth per SfxName so a missing file is never silence. */
export const FALLBACKS: Record<SfxName, (s: Synth) => void> = {
  radio_on: (s) => s.noise(0.03, 0.5, 'highpass', 1500),
  radio_off: (s) => s.noise(0.025, 0.4, 'highpass', 1000),
  static_burst: (s) => s.noise(0.25, 0.35, 'bandpass', 2500, 0.5),
  servo: (s) => s.tone('sawtooth', 700, 1800, 0.09, 0.1),
  bump: (s) => s.tone('sine', 95, 40, 0.13, 0.5),
  shoot: (s) => s.tone('square', 950, 220, 0.12, 0.18),
  zap: (s) => s.noise(0.15, 0.35, 'bandpass', 3200, 3),
  spark_loop: (s) => s.noise(0.35, 0.12, 'highpass', 2500, 0.8),
  elevator_ding: (s) => {
    s.tone('sine', 880, 880, 0.35, 0.22);
    s.tone('sine', 1319, 1319, 0.45, 0.16, 0.14);
  },
  doors: (s) => s.noise(0.45, 0.28, 'lowpass', 500, 0.7),
  powerup: (s) => {
    s.tone('square', 523, 523, 0.09, 0.14);
    s.tone('square', 659, 659, 0.09, 0.14, 0.09);
    s.tone('square', 784, 784, 0.16, 0.14, 0.18);
  },
  powerdown: (s) => s.tone('sawtooth', 500, 50, 0.6, 0.22),
  boot: (s) => {
    s.tone('sine', 55, 38, 0.18, 0.55);
    s.tone('sawtooth', 90, 760, 0.8, 0.08, 0.12);
  },
  paper: (s) => s.noise(0.09, 0.2, 'bandpass', 1300, 1.2),
  hit: (s) => s.tone('triangle', 240, 110, 0.1, 0.32),
  enemy_die: (s) => {
    s.tone('sawtooth', 480, 45, 0.4, 0.26);
    s.noise(0.35, 0.22, 'lowpass', 1400, 0.7, 0.08);
  },
  scrap: (s) => {
    s.tone('sine', 1245, 1245, 0.08, 0.18);
    s.tone('sine', 1865, 1865, 0.16, 0.16, 0.07);
  },
  spin: (s) => s.tone('sawtooth', 340, 420, 0.55, 0.09, 0, [7, 45]),
  fuse_in: (s) => {
    s.tone('square', 130, 70, 0.09, 0.35);
    s.tone('sine', 90, 240, 0.55, 0.1, 0.1);
  },
  title: (s) => {
    s.tone('sine', 55, 110, 1.3, 0.28);
    s.tone('sine', 110, 221, 1.3, 0.12, 0.05);
  },
  // Ordnance. The shredder throws paper and toner, so the whole ladder is dry
  // and grey — lowpassed noise over a descending body, never a fire whoosh.
  mortar_launch: (s) => {
    s.tone('sine', 150, 60, 0.14, 0.4); // hollow tube thump
    s.tone('sine', 300, 900, 0.5, 0.07, 0.06); // shell winding up and away
  },
  mortar_warn: (s) => {
    s.tone('square', 1400, 1400, 0.06, 0.16);
    s.tone('square', 1400, 1400, 0.06, 0.16, 0.12);
  },
  boom_small: (s) => {
    s.tone('sine', 180, 40, 0.28, 0.3);
    s.noise(0.22, 0.24, 'lowpass', 1100, 0.7);
  },
  boom_big: (s) => {
    s.tone('sine', 130, 28, 0.5, 0.4);
    s.noise(0.45, 0.3, 'lowpass', 800, 0.7);
    s.noise(0.3, 0.14, 'highpass', 2600, 0.6, 0.02); // paper shrapnel
  },
  boom_huge: (s) => {
    s.tone('sine', 95, 22, 0.9, 0.5);
    s.noise(0.8, 0.34, 'lowpass', 600, 0.8);
    s.noise(0.6, 0.16, 'bandpass', 1800, 0.5, 0.05);
    s.tone('sawtooth', 300, 30, 0.7, 0.12, 0.1); // the machine coming apart
  },
  rocket_fire: (s) => {
    s.noise(0.3, 0.28, 'highpass', 900, 0.6);
    s.tone('sawtooth', 700, 160, 0.26, 0.16);
  },
  boss_roar: (s) => {
    s.tone('sawtooth', 90, 55, 1.1, 0.34, 0, [11, 18]);
    s.tone('sawtooth', 134, 82, 1.1, 0.18, 0.02, [7, 12]); // detuned twin
    s.noise(0.9, 0.12, 'lowpass', 700, 0.8, 0.05);
  },
  alarm: (s) => {
    s.tone('square', 620, 620, 0.32, 0.14);
    s.tone('square', 460, 460, 0.32, 0.14, 0.34);
  },
};
