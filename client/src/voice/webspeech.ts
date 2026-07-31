/**
 * Push-to-talk CommandSource on the Web Speech API. A fresh recognition is
 * created per press (Chrome's recognizer goes stale across sessions); the mic
 * stream is cached between presses so the permission prompt fires once.
 * Loudness (shouted flag) is measured locally via AnalyserNode RMS.
 */

import type { CommandSource, Utterance } from '@shared/types';

const STOP_WAIT_MS = 1200; // max wait for final results after keyup
const SHOUT_RMS = 0.22; // peak RMS above this = shouted
const METER_INTERVAL_MS = 50;

// Web Speech recognition is not in TS's DOM lib — minimal structural decls.
interface RecAlternativeLike {
  transcript: string;
}
interface RecResultLike {
  isFinal: boolean;
  0: RecAlternativeLike;
}
interface RecEventLike {
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

/**
 * Per-press capture state. Handlers close over the session they were created
 * for and stop() drains only the session it captured — a re-press mid-stop can
 * never cross wires with the previous press.
 */
interface RecSession {
  rec: RecognitionLike;
  finals: string[];
  interim: string;
  ended: boolean;
  resolvers: Array<() => void>;
  peakRms: number;
}

export class WebSpeechSource implements CommandSource {
  private ctor = detectCtor();
  private _available = this.ctor !== null;
  private session: RecSession | null = null;
  private utterCb: ((u: Utterance) => void) | null = null;

  /** Debug taps (dev overlay): live transcript of the current/last session + last error. */
  liveTranscript = '';
  lastError = '';

  // loudness meter (analysis only — recognition uses its own capture)
  private ac: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterTimer: number | null = null;
  /** Bumped by every startMeter/stopMeter — stale async meter setups bail. */
  private meterToken = 0;

  get available(): boolean {
    return this._available;
  }

  /**
   * Pre-warm mic permission + stream during boot (user gesture context) so the
   * permission prompt doesn't eat the player's first push-to-talk.
   */
  async warmup(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      if (!this.stream || this.stream.getAudioTracks().every((t) => t.readyState === 'ended')) {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch {
      this._available = false; // mic denied — director falls back to teletype
    }
  }

  onUtterance(cb: (u: Utterance) => void): void {
    this.utterCb = cb; // PTT resolves via stop(); kept for interface parity
  }

  start(): void {
    if (!this.ctor || !this._available) return;
    this.discardSession();
    this.liveTranscript = '';
    this.lastError = '';

    const rec = new this.ctor();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    // NOTE: deliberately NOT setting Chrome 139+'s processLocally — with the
    // property present but the on-device model not installed, recognition
    // fails silently every session ("VOICE IS MUMBLY" forever). Cloud
    // recognition works everywhere the API exists.
    const session: RecSession = {
      rec,
      finals: [],
      interim: '',
      ended: false,
      resolvers: [],
      peakRms: 0,
    };
    rec.onresult = (ev) => {
      const finals: string[] = [];
      let interim = '';
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        const alt = r?.[0];
        if (!alt) continue;
        if (r.isFinal) finals.push(alt.transcript);
        else interim += alt.transcript;
      }
      session.finals = finals;
      session.interim = interim;
      this.liveTranscript = [...finals, interim].join(' ').trim();
    };
    rec.onerror = (ev) => {
      // no-speech/aborted just end with empty results; permission kill is final
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this._available = false;
      }
      this.lastError = ev.error;
      if (import.meta.env.DEV) console.warn('[speech] recognition error:', ev.error);
    };
    rec.onend = () => {
      session.ended = true;
      const resolvers = session.resolvers;
      session.resolvers = [];
      for (const r of resolvers) r();
    };
    this.session = session;
    try {
      rec.start();
    } catch {
      /* already started */
    }
    void this.startMeter(session);
  }

  async stop(): Promise<Utterance | null> {
    this.stopMeter();
    const session = this.session;
    if (!session) return null;
    this.session = null;
    try {
      session.rec.stop();
    } catch {
      /* never started */
    }
    if (!session.ended) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, STOP_WAIT_MS);
        session.resolvers.push(() => {
          window.clearTimeout(timer);
          resolve();
        });
      });
    }
    session.resolvers = [];
    session.rec.onresult = null;
    session.rec.onerror = null;
    session.rec.onend = null;
    try {
      session.rec.abort();
    } catch {
      /* already dead */
    }
    const text = session.finals.join(' ').trim() || session.interim.trim();
    if (!text) return null;
    const u: Utterance = { text, shouted: session.peakRms >= SHOUT_RMS, source: 'speech' };
    return u;
  }

  // -------------------------------------------------------------- loudness

  private async startMeter(session: RecSession): Promise<void> {
    const token = ++this.meterToken;
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      const tracks = this.stream?.getAudioTracks() ?? [];
      if (!this.stream || tracks.every((t) => t.readyState === 'ended')) {
        // cached between presses — permission prompt only on the first PTT
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.stream = stream; // cache even when superseded — next press reuses it
        if (token !== this.meterToken) return; // newer session / stopMeter won
      }
      if (!this.ac) this.ac = new AudioContext();
      if (this.ac.state !== 'running') void this.ac.resume().catch(() => {});
      this.srcNode = this.ac.createMediaStreamSource(this.stream);
      const analyser = this.ac.createAnalyser();
      analyser.fftSize = 1024;
      this.srcNode.connect(analyser);
      this.analyser = analyser;
      const data = new Float32Array(analyser.fftSize);
      if (this.meterTimer !== null) window.clearInterval(this.meterTimer);
      this.meterTimer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        if (rms > session.peakRms) session.peakRms = rms;
      }, METER_INTERVAL_MS);
    } catch {
      /* meter is best-effort — shouted stays false */
    }
  }

  private stopMeter(): void {
    this.meterToken++; // any in-flight startMeter bails after its await
    if (this.meterTimer !== null) {
      window.clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
    this.srcNode?.disconnect();
    this.srcNode = null;
    this.analyser = null;
    // stream tracks intentionally NOT stopped — kept cached for the next press
  }

  private discardSession(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.rec.onresult = null;
    session.rec.onerror = null;
    session.rec.onend = null;
    try {
      session.rec.abort();
    } catch {
      /* fine */
    }
  }
}
