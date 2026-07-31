/**
 * Push-to-talk CommandSource on the Web Speech API.
 *
 * HOT-MIC ARCHITECTURE: one continuous recognition session runs from warmup()
 * on (auto-restarted when the browser ends it). A PTT press is just a TIME
 * WINDOW — stop() collects the result chunks that ARRIVED inside
 * [press-300ms, release+900ms]. This kills the ~300ms cold-start clipping of
 * per-press recognition: the recognizer is already warm when the key goes down.
 * Results outside a window are discarded, so PTT semantics (no crosstalk
 * pickup between presses) are preserved.
 *
 * Loudness (shouted flag) is measured locally via AnalyserNode RMS.
 */

import type { CommandSource, Utterance } from '@shared/types';

const PRE_ROLL_MS = 300; // speech often starts a beat before the key
const TAIL_MS = 900; // wait after release for the final chunk to land
const SHOUT_RMS = 0.22;
const METER_INTERVAL_MS = 50;
const RESTART_DELAY_MS = 250;

// Web Speech recognition is not in TS's DOM lib — minimal structural decls.
interface RecAlternativeLike {
  transcript: string;
}
interface RecResultLike {
  isFinal: boolean;
  0: RecAlternativeLike;
}
interface RecEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: RecResultLike };
}
interface RecErrorLike {
  error: string;
}
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((ev: RecEventLike) => void) | null;
  onerror: ((ev: RecErrorLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

function detectCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (
    (w.SpeechRecognition as RecognitionCtor | undefined) ??
    (w.webkitSpeechRecognition as RecognitionCtor | undefined) ??
    null
  );
}

/** A final transcript chunk + when it arrived (performance.now()). */
interface Chunk {
  text: string;
  t: number;
}

export class WebSpeechSource implements CommandSource {
  private ctor = detectCtor();
  private _available = this.ctor !== null;
  private utterCb: ((u: Utterance) => void) | null = null;

  // hot session
  private hot: RecognitionLike | null = null;
  private finalChunks: Chunk[] = [];
  private interim = '';
  private interimAt = 0;
  private seenFinals = 0;
  private restartTimer: number | null = null;

  // current press window
  private pressAt = -1;
  private peakRms = 0;

  // loudness meter (analysis only — recognition uses its own capture)
  private ac: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private meterTimer: number | null = null;
  private meterToken = 0;

  /** Debug taps (dev overlay): live transcript + last error. */
  liveTranscript = '';
  lastError = '';

  get available(): boolean {
    return this._available;
  }

  /**
   * Pre-warm mic permission + stream AND the hot recognition session during
   * boot (user-gesture context) so neither eats the player's first press.
   */
  async warmup(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      if (!this.stream || this.stream.getAudioTracks().every((t) => t.readyState === 'ended')) {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch {
      this._available = false; // mic denied — director falls back to teletype
      return;
    }
    this.ensureHot();
  }

  onUtterance(cb: (u: Utterance) => void): void {
    this.utterCb = cb; // PTT resolves via stop(); kept for interface parity
  }

  start(): void {
    if (!this._available) return;
    this.pressAt = performance.now();
    this.peakRms = 0;
    this.liveTranscript = '';
    this.lastError = '';
    this.ensureHot();
    void this.startMeter();
  }

  async stop(): Promise<Utterance | null> {
    this.stopMeter();
    if (this.pressAt < 0) return null;
    const pressAt = this.pressAt;
    this.pressAt = -1;
    const releaseAt = performance.now();
    const windowStart = pressAt - PRE_ROLL_MS;
    const inWindow = (t: number) => t >= windowStart && t <= releaseAt + TAIL_MS;

    // Wait for the trailing final chunk: resolve early when one lands after
    // release, else give up after TAIL_MS. The hot session keeps running.
    const already = this.finalChunks.some((c) => c.t > releaseAt - 50);
    if (!already) {
      await new Promise<void>((resolve) => {
        const startCount = this.finalChunks.length;
        const timer = window.setInterval(() => {
          const done =
            this.finalChunks.length > startCount || performance.now() - releaseAt > TAIL_MS;
          if (done) {
            window.clearInterval(timer);
            resolve();
          }
        }, 60);
      });
    }

    const finals = this.finalChunks.filter((c) => inWindow(c.t)).map((c) => c.text);
    let text = finals.join(' ').trim();
    if (!text && this.interim.trim() && inWindow(this.interimAt)) {
      text = this.interim.trim();
    }
    // Chunks consumed by this press never leak into the next one.
    this.finalChunks = this.finalChunks.filter((c) => c.t > releaseAt);
    if (!text) return null;
    return { text, shouted: this.peakRms >= SHOUT_RMS, source: 'speech' };
  }

  // ------------------------------------------------------------ hot session

  private ensureHot(): void {
    if (!this.ctor || !this._available || this.hot) return;
    const rec = new this.ctor();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    // NOTE: deliberately NOT setting Chrome 139+'s processLocally — with the
    // property present but the on-device model not installed, recognition
    // fails silently every session. Cloud recognition works everywhere.
    this.seenFinals = 0;
    rec.onresult = (ev) => {
      const now = performance.now();
      let interim = '';
      let finals = 0;
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        const alt = r?.[0];
        if (!alt) continue;
        if (r.isFinal) {
          finals++;
          if (finals > this.seenFinals) {
            this.finalChunks.push({ text: alt.transcript.trim(), t: now });
            this.seenFinals = finals;
          }
        } else {
          interim += alt.transcript;
        }
      }
      this.interim = interim;
      if (interim.trim()) this.interimAt = now;
      this.liveTranscript = [
        ...this.finalChunks.slice(-3).map((c) => c.text),
        interim.trim(),
      ]
        .filter(Boolean)
        .join(' ');
      // Keep memory bounded — only recent chunks can ever match a window.
      if (this.finalChunks.length > 24) this.finalChunks.splice(0, this.finalChunks.length - 24);
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this._available = false;
      }
      this.lastError = ev.error;
      if (import.meta.env.DEV && ev.error !== 'no-speech') {
        console.warn('[speech] recognition error:', ev.error);
      }
    };
    rec.onend = () => {
      // Browser ends continuous sessions on silence/timeouts — relight it.
      this.hot = null;
      this.seenFinals = 0;
      this.interim = '';
      if (this._available && this.restartTimer === null) {
        this.restartTimer = window.setTimeout(() => {
          this.restartTimer = null;
          this.ensureHot();
        }, RESTART_DELAY_MS);
      }
    };
    this.hot = rec;
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }

  // -------------------------------------------------------------- loudness

  private async startMeter(): Promise<void> {
    const token = ++this.meterToken;
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      const tracks = this.stream?.getAudioTracks() ?? [];
      if (!this.stream || tracks.every((t) => t.readyState === 'ended')) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.stream = stream; // cache even when superseded — next press reuses it
        if (token !== this.meterToken) return;
      }
      if (!this.ac) this.ac = new AudioContext();
      if (this.ac.state !== 'running') void this.ac.resume().catch(() => {});
      this.srcNode = this.ac.createMediaStreamSource(this.stream);
      const analyser = this.ac.createAnalyser();
      analyser.fftSize = 1024;
      this.srcNode.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      if (this.meterTimer !== null) window.clearInterval(this.meterTimer);
      this.meterTimer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
        const rms = Math.sqrt(sum / data.length);
        if (rms > this.peakRms) this.peakRms = rms;
      }, METER_INTERVAL_MS);
    } catch {
      /* meter is best-effort — shouted stays false */
    }
  }

  private stopMeter(): void {
    this.meterToken++;
    if (this.meterTimer !== null) {
      window.clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
    this.srcNode?.disconnect();
    this.srcNode = null;
    // stream tracks intentionally NOT stopped — kept cached for the next press
  }
}
