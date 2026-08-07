/**
 * WebAudio engine. Buses: sfx / voice / ambient → master → destination.
 * Robot voice runs through a radio chain (bandpass + saturation + parallel
 * crush + compressor + gated static bed) to sell "robot over security feed".
 * SFX are lazy-loaded mp3s with synthesized fallbacks — never silent.
 */

import type { AudioEngine, SfxName } from '@shared/types';
import { FALLBACKS, Synth, brownBuffer, crackleBuffer, crushCurve, satCurve } from './synth';

const DUCK_LEVEL = 0.5; // -6dB on ambient while voice plays
const SFX_DUCK_LEVEL = 0.55; // -5dB on sfx while voice plays — dialogue is the game
const COMPRESSOR = { threshold: -24, knee: 12, ratio: 8, attack: 0.003, release: 0.15 };
/** Brick wall on the sfx sum only. Twenty mortars must fit under one master. */
const SFX_LIMITER = { threshold: -10, knee: 2, ratio: 20, attack: 0.002, release: 0.1 };

/**
 * Minimum ms between full-strength plays of the same sound. Inside the gap the
 * sound still plays, just quieter (see SFX_CROWD_GAIN) — a cluster of booms then
 * reads as ONE big boom with texture. Dropping them makes a firefight feel
 * broken; attenuating them makes it feel loud.
 *
 * Keyed off SfxName so a rename in `shared/types.ts` breaks the build here
 * rather than silently un-throttling a sound.
 */
const SFX_MIN_GAP: Partial<Record<SfxName, number>> = {
  boom_small: 45,
  boom_big: 70,
  boom_huge: 400,
  mortar_launch: 40,
  mortar_warn: 90,
  hit: 40,
  shoot: 30,
  zap: 90,
  paper: 50,
  bump: 60,
  enemy_die: 60,
};
const SFX_CROWD_GAIN = 0.45; // level for a repeat inside its gap

// Runaway guard, not a mixing tool: if more than CAP_STARTS sources start inside
// CAP_WINDOW_MS, the quietest ones are sacrificed so a bugged emitter can't
// choke the audio thread. In normal play this never engages.
const CAP_STARTS = 12;
const CAP_WINDOW_MS = 100;

const BLAST_FLOOR = 0.35;

/**
 * Distance falloff for blasts, 0.35..1. The floor is the point: the camera is
 * bolted to the ceiling of the room being shelled, so a hit across the arena
 * still has to read as happening *here*, just further away. Full strength
 * inside `fullRangePx`, fading to the floor over the two ranges beyond it.
 */
export function blastGain(distPx: number, fullRangePx = 80): number {
  if (!(distPx > 0)) return 1; // on top of us (or NaN) — no attenuation
  const range = Math.max(1, fullRangePx);
  const fade = Math.min(1, Math.max(0, distPx - range) / (range * 2));
  return BLAST_FLOOR + (1 - BLAST_FLOOR) * (1 - fade) ** 1.5;
}

export class WebAudioEngine implements AudioEngine {
  private ctx: AudioContext | null = null;
  private _ready = false;

  // graph nodes — all created in buildGraph(), only touched after a ctx guard
  private master!: GainNode;
  private sfxBus!: GainNode;
  private sfxDuck!: GainNode; // voice ducking target on the sfx side
  private sfxLimiter!: DynamicsCompressorNode; // sfx sum only — never the voice
  private voiceBus!: GainNode;
  private ambientLevel!: GainNode; // setHum target
  private ambientDuck!: GainNode; // voice ducking target
  private voiceIn!: GainNode; // radio chain entry
  private comp!: DynamicsCompressorNode;
  private crackleGate!: GainNode; // static bed, opens while voice plays
  private musicLevel!: GainNode; // the bed's own fade in/out
  private musicDuck!: GainNode; // voice ducking target on the music side

  private sfx = new Map<SfxName, AudioBuffer | 'loading' | 'missing'>();
  private voiceSrc: AudioBufferSourceNode | null = null;
  private voiceDone: (() => void) | null = null;
  private musicSrc: AudioBufferSourceNode | null = null;
  /** Decoded beds by url. A run is replayable and the boss is met once per
   *  run — refetching a megabyte on every retry is a stall on the one frame
   *  that must not have one. 'missing' is remembered too, so a build shipped
   *  without the track asks the network exactly once. */
  private music = new Map<string, AudioBuffer | 'missing'>();

  private lastPlayed = new Map<string, number>(); // SFX_MIN_GAP bookkeeping, ms on the audio clock
  private starts: { t: number; vol: number }[] = []; // CAP_WINDOW_MS ring of recent starts

  get ready(): boolean {
    return this._ready;
  }

  /** Must be called from a user gesture (space press). Starts hum + prefetch. */
  async init(): Promise<void> {
    if (this.ctx) {
      await this.unlock();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.buildGraph(ctx);
    this.installResumeHandlers(ctx);
    for (const name of Object.keys(FALLBACKS) as SfxName[]) this.loadSfx(name);
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    this._ready = true;
  }

  /** Resume after iOS/visibility suspend. Alias used by the director on gestures. */
  async unlock(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
  }

  playSfx(name: SfxName, opts?: { volume?: number; rate?: number }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime * 1000; // audio clock: keeps running when the tab throttles

    // Repeats inside the name's gap are *coalesced*, not dropped: quieter, and
    // without the sweetener layer, so five booms in three frames stack into one
    // fat boom instead of five clipped ones.
    let volume = opts?.volume ?? 1;
    const gap = SFX_MIN_GAP[name];
    let crowded = false;
    if (gap !== undefined) {
      crowded = now - (this.lastPlayed.get(name) ?? -Infinity) < gap;
      this.lastPlayed.set(name, now);
      if (crowded) volume *= SFX_CROWD_GAIN;
    }
    if (!this.admit(now, volume)) return;

    if (!crowded) this.sweeten(name, volume);
    const cached = this.sfx.get(name);
    if (cached instanceof AudioBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = cached;
      src.playbackRate.value = opts?.rate ?? 1;
      const g = ctx.createGain();
      g.gain.value = volume;
      src.connect(g).connect(this.sfxBus);
      src.start();
      return;
    }
    if (cached === undefined) this.loadSfx(name);
    FALLBACKS[name](new Synth(ctx, this.sfxBus, volume));
  }

  /** Rejects on decode failure — director falls back to caption-only. */
  async playVoiceBytes(bytes: ArrayBuffer): Promise<void> {
    const ctx = this.requireCtx();
    // decodeAudioData detaches its input; copy so callers can reuse the bytes
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    await this.playVoiceBuffer(buf);
  }

  /** Bank-line playback. Throws on 404 — director falls back. */
  async playVoiceUrl(url: string): Promise<void> {
    const ctx = this.requireCtx();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`voice ${res.status}`);
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    await this.playVoiceBuffer(buf);
  }

  /** Cancels current voice line (interrupts allowed); pending promise resolves. */
  stopVoice(): void {
    const src = this.voiceSrc;
    const done = this.voiceDone;
    this.voiceSrc = null;
    this.voiceDone = null;
    if (!src) return;
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
    this.duck(false);
    done?.();
  }

  /**
   * Looping music bed. Fail-soft by contract: a 404, a decode failure or a
   * suspended context all resolve FALSE and play nothing. The boss fight is
   * carried by the roar, the mortars and the adds — the music is the layer on
   * top of that, never the thing holding it up.
   */
  async playMusic(url: string, opts?: { volume?: number; fadeMs?: number }): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx) return false;
    const buf = await this.loadMusic(url);
    if (buf === 'missing') return false;
    this.stopMusic(0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.musicLevel);
    this.musicSrc = src;
    const vol = opts?.volume ?? 0.5;
    const fade = (opts?.fadeMs ?? 900) / 1000;
    const t = ctx.currentTime;
    // Ramp from wherever it actually is: a stop still fading out when the next
    // start lands must not jump to zero and click.
    this.musicLevel.gain.cancelScheduledValues(t);
    this.musicLevel.gain.setValueAtTime(this.musicLevel.gain.value, t);
    this.musicLevel.gain.linearRampToValueAtTime(vol, t + Math.max(0.01, fade));
    src.start();
    return true;
  }

  async prefetchMusic(url: string): Promise<void> {
    // No context yet (the player has not pressed anything, or the tab was
    // hidden through boot and autoplay policy blocked init): decoding is
    // impossible, but the DOWNLOAD is not. Warm the HTTP cache so the later
    // decode is local. Without this the prefetch is a silent no-op forever —
    // it only ever runs once, and it would have run at the wrong moment.
    if (!this.ctx) {
      await fetch(url).catch(() => {});
      return;
    }
    await this.loadMusic(url);
  }

  /** Fetch + decode once, remembering the answer — including 'missing', so a
   *  build without the track asks the network exactly once. */
  private async loadMusic(url: string): Promise<AudioBuffer | 'missing'> {
    const ctx = this.ctx;
    if (!ctx) return 'missing';
    const cached = this.music.get(url);
    if (cached !== undefined) return cached;
    let buf: AudioBuffer | 'missing';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`music ${res.status}`);
      buf = await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      buf = 'missing';
    }
    this.music.set(url, buf);
    return buf;
  }

  stopMusic(fadeMs = 700): void {
    const ctx = this.ctx;
    const src = this.musicSrc;
    if (!ctx || !src) return;
    this.musicSrc = null;
    const t = ctx.currentTime;
    const fade = Math.max(0, fadeMs) / 1000;
    this.musicLevel.gain.cancelScheduledValues(t);
    this.musicLevel.gain.setValueAtTime(this.musicLevel.gain.value, t);
    this.musicLevel.gain.linearRampToValueAtTime(0, t + Math.max(0.01, fade));
    // Stop AFTER the ramp, not on it: a source stopped mid-fade is a click.
    try {
      src.stop(t + fade + 0.05);
    } catch {
      /* already stopped */
    }
  }

  setHum(level: number): void {
    if (!this.ctx) return;
    const v = Math.max(0, Math.min(1, level));
    this.ambientLevel.gain.setTargetAtTime(v, this.ctx.currentTime, 0.2);
  }

  /** 'type' = near-subliminal caption-typewriter tick, far softer than 'teletype'. */
  blip(kind: 'teletype' | 'osd' | 'warn' | 'type'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = new Synth(ctx, this.sfxBus);
    if (kind === 'type') s.noise(0.004, 0.03, 'highpass', 5000);
    else if (kind === 'teletype') s.tone('square', 2400, 2200, 0.012, 0.08);
    else if (kind === 'osd') s.tone('sine', 1040, 1040, 0.05, 0.12);
    else {
      s.tone('square', 660, 660, 0.07, 0.15);
      s.tone('square', 440, 440, 0.09, 0.15, 0.09);
    }
  }

  // -------------------------------------------------------------- internals

  /**
   * Global start cap. Records the start and returns false only when the window
   * is already saturated AND this sound is the quietest thing in it — the one
   * nobody would miss. A genuinely loud event (the boss's mortar) still gets in
   * and evicts a whisper. UI blips deliberately skip this: a dropped teletype
   * tick reads as a bug, and they are never what saturates the window.
   */
  private admit(now: number, vol: number): boolean {
    while (this.starts.length && now - this.starts[0].t > CAP_WINDOW_MS) this.starts.shift();
    if (this.starts.length >= CAP_STARTS) {
      let quietest = 0;
      for (let i = 1; i < this.starts.length; i++) {
        if (this.starts[i].vol < this.starts[quietest].vol) quietest = i;
      }
      if (vol <= this.starts[quietest].vol) return false;
      this.starts.splice(quietest, 1);
    }
    this.starts.push({ t: now, vol });
    return true;
  }

  /** Synth layers under file-based sfx — never replaces them, only thickens. */
  private sweeten(name: SfxName, volume: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (name === 'powerup') {
      // soft sub-thump under the arpeggio — power physically arriving
      new Synth(ctx, this.sfxBus, volume).tone('sine', 68, 32, 0.32, 0.4, 0.02);
    } else if (name === 'bump' && Math.random() < 0.6) {
      // loose-panel rattle: 3 fast filtered noise taps (cosmetic, non-sim random)
      const s = new Synth(ctx, this.sfxBus, volume);
      const f = 1700 + Math.random() * 900;
      s.noise(0.018, 0.1, 'bandpass', f, 2.5, 0.02);
      s.noise(0.016, 0.07, 'bandpass', f * 1.13, 2.5, 0.055);
      s.noise(0.014, 0.05, 'bandpass', f * 0.9, 2.5, 0.085);
    }
  }

  private requireCtx(): AudioContext {
    if (!this.ctx) throw new Error('audio not initialized');
    return this.ctx;
  }

  private buildGraph(ctx: AudioContext): void {
    this.master = ctx.createGain();
    this.master.gain.value = 0.8; // headroom for the sfx limiter to work into
    this.master.connect(ctx.destination);

    // sfx bus → voice duck → surveillance-speaker shelf (-3dB @ 6k) → limiter → master,
    // plus a convolver-free 60ms slap-back "room" at very low mix.
    // The duck sits first so the limiter sees an already-quieter signal under
    // dialogue and stops clamping down on the sfx we just made room for.
    this.sfxBus = ctx.createGain();
    this.sfxDuck = ctx.createGain();
    const sfxShelf = ctx.createBiquadFilter();
    sfxShelf.type = 'highshelf';
    sfxShelf.frequency.value = 6000;
    sfxShelf.gain.value = -3;
    // Brick wall across the whole sfx sum: twenty simultaneous explosions used to
    // add straight into master and clip. The VOICE never passes through here —
    // it has its own compressor in the radio chain, and it is the one signal that
    // must not be squashed by gunfire.
    this.sfxLimiter = ctx.createDynamicsCompressor();
    this.sfxLimiter.threshold.value = SFX_LIMITER.threshold;
    this.sfxLimiter.knee.value = SFX_LIMITER.knee;
    this.sfxLimiter.ratio.value = SFX_LIMITER.ratio;
    this.sfxLimiter.attack.value = SFX_LIMITER.attack;
    this.sfxLimiter.release.value = SFX_LIMITER.release;
    this.sfxBus.connect(this.sfxDuck).connect(sfxShelf);
    sfxShelf.connect(this.sfxLimiter).connect(this.master);
    const slap = ctx.createDelay(0.12);
    slap.delayTime.value = 0.06;
    const slapDamp = ctx.createBiquadFilter();
    slapDamp.type = 'lowpass';
    slapDamp.frequency.value = 3200;
    const slapFb = ctx.createGain();
    slapFb.gain.value = 0.25;
    const slapWet = ctx.createGain();
    slapWet.gain.value = 0.07;
    // Send tapped PRE-limiter and returned past it: fed post-limiter the room
    // tone would breathe in and out with every explosion, and the walls of the
    // arena would sound like they were moving.
    sfxShelf.connect(slap);
    slap.connect(slapDamp).connect(slapFb).connect(slap);
    slap.connect(slapWet).connect(this.master);

    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 1.1;
    this.voiceBus.connect(this.master);

    // music bed → its own fade → voice duck → master. Deliberately NOT through
    // the sfx limiter: a sustained bed sitting in the limiter's detector would
    // pump the whole firefight in time with the drums.
    this.musicLevel = ctx.createGain();
    this.musicLevel.gain.value = 0;
    this.musicDuck = ctx.createGain();
    this.musicLevel.connect(this.musicDuck).connect(this.master);

    // ambient: 50Hz mains hum + 100Hz harmonic + brown-noise room tone
    this.ambientLevel = ctx.createGain();
    this.ambientDuck = ctx.createGain();
    this.ambientLevel.connect(this.ambientDuck).connect(this.master);
    const hum50 = ctx.createOscillator();
    hum50.frequency.value = 50;
    const g50 = ctx.createGain();
    g50.gain.value = 0.015;
    hum50.connect(g50).connect(this.ambientLevel);
    // very slow ±2 cent drift so long sessions never feel sterile
    const drift = ctx.createOscillator();
    drift.frequency.value = 0.05; // one wander every ~20s
    const driftDepth = ctx.createGain();
    driftDepth.gain.value = 2; // cents
    drift.connect(driftDepth).connect(hum50.detune);
    drift.start();
    const hum100 = ctx.createOscillator();
    hum100.frequency.value = 100;
    const g100 = ctx.createGain();
    g100.gain.value = 0.006;
    hum100.connect(g100).connect(this.ambientLevel);
    const room = ctx.createBufferSource();
    room.buffer = brownBuffer(ctx);
    room.loop = true;
    const roomLp = ctx.createBiquadFilter();
    roomLp.type = 'lowpass';
    roomLp.frequency.value = 400;
    const gRoom = ctx.createGain();
    gRoom.gain.value = 0.025;
    room.connect(roomLp).connect(gRoom).connect(this.ambientLevel);
    hum50.start();
    hum100.start();
    room.start();

    // voice radio chain: hp 300 → lp 3400 → soft sat ∥ crush layer → comp
    this.voiceIn = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    const sat = ctx.createWaveShaper();
    sat.curve = satCurve();
    const crush = ctx.createWaveShaper();
    crush.curve = crushCurve();
    const crushGain = ctx.createGain();
    crushGain.gain.value = 0.18;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = COMPRESSOR.threshold;
    this.comp.knee.value = COMPRESSOR.knee;
    this.comp.ratio.value = COMPRESSOR.ratio;
    this.comp.attack.value = COMPRESSOR.attack;
    this.comp.release.value = COMPRESSOR.release;
    this.voiceIn.connect(hp).connect(lp);
    lp.connect(sat).connect(this.comp);
    lp.connect(crush).connect(crushGain).connect(this.comp);
    this.comp.connect(this.voiceBus);

    // radio static bed — gate opens only while a voice line plays
    const crackle = ctx.createBufferSource();
    crackle.buffer = crackleBuffer(ctx);
    crackle.loop = true;
    const crackleLvl = ctx.createGain();
    crackleLvl.gain.value = 0.05;
    this.crackleGate = ctx.createGain();
    this.crackleGate.gain.value = 0;
    crackle.connect(crackleLvl).connect(this.crackleGate).connect(this.comp);
    crackle.start();
  }

  private installResumeHandlers(ctx: AudioContext): void {
    const tryResume = (): void => {
      // iOS reports 'interrupted' (not in the TS union) — compare to 'running'
      if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', tryResume, { capture: true });
    window.addEventListener('keydown', tryResume, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tryResume();
    });
    ctx.onstatechange = () => {
      if (!document.hidden) tryResume();
    };
  }

  private loadSfx(name: SfxName): void {
    if (this.sfx.has(name)) return;
    this.sfx.set(name, 'loading');
    fetch(`./assets/sfx/${name}.mp3`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`sfx ${res.status}`);
        const buf = await this.requireCtx().decodeAudioData(await res.arrayBuffer());
        this.sfx.set(name, buf);
      })
      .catch(() => this.sfx.set(name, 'missing')); // synth fallback from here on
  }

  private playVoiceBuffer(buf: AudioBuffer): Promise<void> {
    const ctx = this.requireCtx();
    this.stopVoice();
    return new Promise<void>((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.voiceIn);
      this.voiceSrc = src;
      this.voiceDone = resolve;
      this.duck(true);
      src.onended = () => {
        if (this.voiceSrc === src) {
          this.voiceSrc = null;
          this.voiceDone = null;
          this.duck(false);
        }
        resolve();
      };
      src.start();
    });
  }

  private duck(on: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.ambientDuck.gain.setTargetAtTime(on ? DUCK_LEVEL : 1, t, on ? 0.05 : 0.25);
    // Same fast-down/slow-up shape as the ambient duck: the firefight gets out of
    // the way of the line quickly, then swells back without an audible edge.
    this.sfxDuck.gain.setTargetAtTime(on ? SFX_DUCK_LEVEL : 1, t, on ? 0.05 : 0.25);
    // The robot talking is the whole game; a bed loud enough to sit over it
    // would be a bed that costs the player the thing they came for.
    this.musicDuck.gain.setTargetAtTime(on ? DUCK_LEVEL : 1, t, on ? 0.05 : 0.25);
    this.crackleGate.gain.setTargetAtTime(on ? 1 : 0, t, on ? 0.02 : 0.08);
  }
}

export function createAudioEngine(): WebAudioEngine {
  return new WebAudioEngine();
}
