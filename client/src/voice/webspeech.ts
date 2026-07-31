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

export class WebSpeechSource implements CommandSource {
  private ctor = detectCtor();
  private _available = this.ctor !== null;
  private rec: RecognitionLike | null = null;
  private finals: string[] = [];
  private interim = '';
  private ended = false;
  private endResolvers: Array<() => void> = [];
  private utterCb: ((u: Utterance) => void) | null = null;

  // loudness meter (analysis only — recognition uses its own capture)
  private ac: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterTimer: number | null = null;
  private peakRms = 0;

  get available(): boolean {
    return this._available;
  }

  onUtterance(cb: (u: Utterance) => void): void {
    this.utterCb = cb; // PTT resolves via stop(); kept for interface parity
  }

  start(): void {
    if (!this.ctor || !this._available) return;
    this.discardRec();
    this.finals = [];
    this.interim = '';
    this.ended = false;
    this.peakRms = 0;

    const rec = new this.ctor();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    try {
      // Chrome 139+ on-device recognition — best-effort, absent elsewhere
      if ('processLocally' in rec) {
        const r = rec as unknown as Record<string, unknown>;
        r.processLocally = true;
        r.mode = 'command';
        r.quality = 'command';
      }
    } catch {
      /* optional API */
    }
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
      this.finals = finals;
      this.interim = interim;
    };
    rec.onerror = (ev) => {
      // no-speech/aborted just end with empty results; permission kill is final
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this._available = false;
      }
    };
    rec.onend = () => {
      this.ended = true;
      const resolvers = this.endResolvers;
      this.endResolvers = [];
      for (const r of resolvers) r();
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      /* already started */
    }
    void this.startMeter();
  }

  async stop(): Promise<Utterance | null> {
    this.stopMeter();
    const rec = this.rec;
    if (!rec) return null;
    this.rec = null;
    try {
      rec.stop();
    } catch {
      /* never started */
    }
    if (!this.ended) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, STOP_WAIT_MS);
        this.endResolvers.push(() => {
          window.clearTimeout(timer);
          resolve();
        });
      });
    }
    this.endResolvers = [];
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.abort();
    } catch {
      /* already dead */
    }
    const text = this.finals.join(' ').trim() || this.interim.trim();
    if (!text) return null;
    const u: Utterance = { text, shouted: this.peakRms >= SHOUT_RMS, source: 'speech' };
    return u;
  }

  // -------------------------------------------------------------- loudness

  private async startMeter(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      const tracks = this.stream?.getAudioTracks() ?? [];
      if (!this.stream || tracks.every((t) => t.readyState === 'ended')) {
        // cached between presses — permission prompt only on the first PTT
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (!this.ac) this.ac = new AudioContext();
      if (this.ac.state !== 'running') void this.ac.resume().catch(() => {});
      this.srcNode = this.ac.createMediaStreamSource(this.stream);
      this.analyser = this.ac.createAnalyser();
      this.analyser.fftSize = 1024;
      this.srcNode.connect(this.analyser);
      const data = new Float32Array(this.analyser.fftSize);
      this.meterTimer = window.setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        if (rms > this.peakRms) this.peakRms = rms;
      }, METER_INTERVAL_MS);
    } catch {
      /* meter is best-effort — shouted stays false */
    }
  }

  private stopMeter(): void {
    if (this.meterTimer !== null) {
      window.clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
    this.srcNode?.disconnect();
    this.srcNode = null;
    this.analyser = null;
    // stream tracks intentionally NOT stopped — kept cached for the next press
  }

  private discardRec(): void {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.abort();
    } catch {
      /* fine */
    }
  }
}
