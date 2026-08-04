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
  length: number;
  0: RecAlternativeLike;
  [i: number]: RecAlternativeLike;
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

/** A final transcript chunk + when it arrived (performance.now()).
 *  `alts` holds the runner-up hypotheses for the same audio, best-first. */
interface Chunk {
  text: string;
  alts: string[];
  t: number;
}

/** How the mic is doing, for the director's troubleshooting card. */
export type MicPermission = 'unknown' | 'granted' | 'denied';

export interface MicDiagnosis {
  /** Peak RMS observed during the last press (0 = literally no audio reached us). */
  peakRms: number;
  permission: MicPermission;
  /** Last recognition error string ('' if none). */
  lastError: string;
  /** A recognition session is currently live. */
  hot: boolean;
  /** Recognition has produced real words at least once this session. */
  everHeardWords: boolean;
}

/** Below this peak RMS across a whole press, no usable audio arrived at all. */
export const SILENT_RMS = 0.008;

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
  /** Live RMS, 0..1-ish, sampled by the meter — drives the on-screen VU. */
  level = 0;
  private permissionState: MicPermission = 'unknown';
  private everHeardWords = false;
  /** Runner-up hypotheses collected by the last stop(), best-first. */
  private lastAlternatives: string[] = [];

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

  /** Runner-up STT hypotheses for the utterance stop() just returned. */
  get alternatives(): string[] {
    return this.lastAlternatives;
  }

  /** Everything the director needs to tell the player what is actually wrong. */
  diagnose(): MicDiagnosis {
    return {
      peakRms: this.peakRms,
      permission: this.ctor === null ? 'denied' : this.permissionState,
      lastError: this.lastError,
      hot: this.hot !== null,
      everHeardWords: this.everHeardWords,
    };
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
      this.permissionState = 'granted';
    } catch {
      this.permissionState = 'denied';
      this._available = false; // mic denied — director falls back to teletype
      return;
    }
    this.ensureHot();
    void this.ensureMeter(); // live input level from boot, before any press
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
    void this.ensureMeter();
  }

  async stop(): Promise<Utterance | null> {
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

    const windowed = this.finalChunks.filter((c) => inWindow(c.t));
    let text = windowed.map((c) => c.text).join(' ').trim();
    // Runner-up readings of the same audio. With one chunk we can offer the
    // engine's own alternatives; with several, joining them per rank is the
    // honest approximation. The server treats these as hints, not truth.
    let alts: string[] = [];
    if (windowed.length === 1) {
      alts = windowed[0]!.alts.slice();
    } else if (windowed.length > 1) {
      const depth = Math.max(...windowed.map((c) => c.alts.length));
      for (let i = 0; i < depth; i++) {
        const joined = windowed.map((c) => c.alts[i] ?? c.text).join(' ').trim();
        if (joined) alts.push(joined);
      }
    }
    if (!text && this.interim.trim() && inWindow(this.interimAt)) {
      text = this.interim.trim();
      alts = [];
    }
    this.lastAlternatives = alts.filter((a) => a && a !== text).slice(0, 3);
    // Chunks consumed by this press never leak into the next one.
    this.finalChunks = this.finalChunks.filter((c) => c.t > releaseAt);
    if (!text) return null;
    this.everHeardWords = true;
    return { text, shouted: this.peakRms >= SHOUT_RMS, source: 'speech' };
  }

  // ------------------------------------------------------------ hot session

  private ensureHot(): void {
    if (!this.ctor || !this._available || this.hot) return;
    const rec = new this.ctor();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    // Ask for runner-ups. Browser STT mishears small function words constantly
    // ("go TO steps right" for "go TWO steps right") and the alternatives list
    // usually contains the reading the player meant — the LLM picks.
    rec.maxAlternatives = 3;
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
            const alts: string[] = [];
            for (let k = 1; k < (r.length ?? 1); k++) {
              const a = r[k]?.transcript?.trim();
              if (a) alts.push(a);
            }
            this.finalChunks.push({ text: alt.transcript.trim(), alts, t: now });
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
        this.permissionState = 'denied';
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

  /**
   * The loudness meter runs CONTINUOUSLY from warmup on, not just while the key
   * is held. The hot recognition session already holds the mic open, so this is
   * free — and it buys two things worth much more than the shout flag: a real
   * VU meter instead of a faked one, and a live signal readout on the mic
   * troubleshooting card that goes green the instant the player fixes their
   * input device. Diagnosing a dead mic requires seeing it come alive.
   */
  private async ensureMeter(): Promise<void> {
    if (this.meterTimer !== null) return;
    const token = ++this.meterToken;
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      const tracks = this.stream?.getAudioTracks() ?? [];
      if (!this.stream || tracks.every((t) => t.readyState === 'ended')) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.stream = stream; // cache even when superseded — next press reuses it
        this.permissionState = 'granted';
        if (token !== this.meterToken) return;
      }
      if (!this.ac) this.ac = new AudioContext();
      if (this.ac.state !== 'running') void this.ac.resume().catch(() => {});
      this.srcNode?.disconnect();
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
        // display level is compressed: speech RMS lives around 0.05–0.3
        this.level = Math.min(1, rms * 4);
        if (this.pressAt >= 0 && rms > this.peakRms) this.peakRms = rms;
      }, METER_INTERVAL_MS);
    } catch {
      this.permissionState = 'denied';
      /* meter is best-effort — shouted stays false */
    }
  }

  /** Release the analyser (nothing else calls this today; kept for teardown). */
  stopMeter(): void {
    this.meterToken++;
    if (this.meterTimer !== null) {
      window.clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
    this.srcNode?.disconnect();
    this.srcNode = null;
    this.level = 0;
    // stream tracks intentionally NOT stopped — kept cached for the next press
  }
}
