/**
 * WebAudio engine. Buses: sfx / voice / ambient → master → destination.
 * Robot voice runs through a radio chain (bandpass + saturation + parallel
 * crush + compressor + gated static bed) to sell "robot over security feed".
 * SFX are lazy-loaded mp3s with synthesized fallbacks — never silent.
 */

import type { AudioEngine, SfxName } from '@shared/types';
import { FALLBACKS, Synth, brownBuffer, crackleBuffer, crushCurve, satCurve } from './synth';

const DUCK_LEVEL = 0.5; // -6dB on ambient while voice plays
const COMPRESSOR = { threshold: -24, knee: 12, ratio: 8, attack: 0.003, release: 0.15 };

export class WebAudioEngine implements AudioEngine {
  private ctx: AudioContext | null = null;
  private _ready = false;

  // graph nodes — all created in buildGraph(), only touched after a ctx guard
  private master!: GainNode;
  private sfxBus!: GainNode;
  private voiceBus!: GainNode;
  private ambientLevel!: GainNode; // setHum target
  private ambientDuck!: GainNode; // voice ducking target
  private voiceIn!: GainNode; // radio chain entry
  private comp!: DynamicsCompressorNode;
  private crackleGate!: GainNode; // static bed, opens while voice plays

  private sfx = new Map<SfxName, AudioBuffer | 'loading' | 'missing'>();
  private voiceSrc: AudioBufferSourceNode | null = null;
  private voiceDone: (() => void) | null = null;

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
    const cached = this.sfx.get(name);
    if (cached instanceof AudioBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = cached;
      src.playbackRate.value = opts?.rate ?? 1;
      const g = ctx.createGain();
      g.gain.value = opts?.volume ?? 1;
      src.connect(g).connect(this.sfxBus);
      src.start();
      return;
    }
    if (cached === undefined) this.loadSfx(name);
    FALLBACKS[name](new Synth(ctx, this.sfxBus, opts?.volume ?? 1));
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

  setHum(level: number): void {
    if (!this.ctx) return;
    const v = Math.max(0, Math.min(1, level));
    this.ambientLevel.gain.setTargetAtTime(v, this.ctx.currentTime, 0.2);
  }

  blip(kind: 'teletype' | 'osd' | 'warn'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = new Synth(ctx, this.sfxBus);
    if (kind === 'teletype') s.tone('square', 2400, 2200, 0.012, 0.08);
    else if (kind === 'osd') s.tone('sine', 1040, 1040, 0.05, 0.12);
    else {
      s.tone('square', 660, 660, 0.07, 0.15);
      s.tone('square', 440, 440, 0.09, 0.15, 0.09);
    }
  }

  // -------------------------------------------------------------- internals

  private requireCtx(): AudioContext {
    if (!this.ctx) throw new Error('audio not initialized');
    return this.ctx;
  }

  private buildGraph(ctx: AudioContext): void {
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 1.1;
    this.voiceBus.connect(this.master);

    // ambient: 50Hz mains hum + 100Hz harmonic + brown-noise room tone
    this.ambientLevel = ctx.createGain();
    this.ambientDuck = ctx.createGain();
    this.ambientLevel.connect(this.ambientDuck).connect(this.master);
    const hum50 = ctx.createOscillator();
    hum50.frequency.value = 50;
    const g50 = ctx.createGain();
    g50.gain.value = 0.015;
    hum50.connect(g50).connect(this.ambientLevel);
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
    this.crackleGate.gain.setTargetAtTime(on ? 1 : 0, t, on ? 0.02 : 0.08);
  }
}

export function createAudioEngine(): WebAudioEngine {
  return new WebAudioEngine();
}
