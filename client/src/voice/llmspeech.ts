/**
 * Push-to-talk CommandSource that does no recognition at all: it records the
 * press and hands the audio to the parse model (see AudioClip in shared/types).
 *
 * WHY IT EXISTS: Safari has no SpeechRecognition, and on iOS every browser is
 * Safari. Without this, a phone can hold the screen and be heard by nothing —
 * the mic-fault card, forever. WebSpeechSource stays the default wherever it
 * exists: it is free, local, and instant. This is the fallback, and it is
 * chosen per-browser in the director, never both at once.
 *
 * THE CAPTURE IS RAW PCM, NOT MediaRecorder. MediaRecorder gives webm/opus on
 * Chrome and mp4/aac on Safari; the upstream takes wav/mp3. Rather than carry
 * a codec, we pull Float32 frames straight off the graph, downsample to 16 kHz
 * mono and write a RIFF header by hand — the same 40 lines on every browser,
 * and no bytes on the wire that the model cannot read.
 *
 * Loudness (the `shouted` flag) is measured here from the same frames, so it
 * costs nothing extra and matches WebSpeechSource's behaviour.
 */

import type { AudioClip, Utterance } from '@shared/types';
import type { MicCommandSource, MicDiagnosis, MicPermission } from './webspeech';

/** Everything upstream wants 16 kHz mono; speech carries nothing above 8 kHz. */
const TARGET_HZ = 16000;
/**
 * Hard cap on one press. 12s of 16 kHz mono PCM is ~384 KB of WAV, ~512 KB of
 * base64 — already a long upload on a phone. A player leaning on the screen
 * must not be able to queue a megabyte.
 */
const MAX_MS = 12000;
/** Below this we did not record speech, we recorded a quiet room. */
const SILENT_RMS = 0.008;
const SHOUT_RMS = 0.22;
/** ScriptProcessor buffer: 4096 frames ≈ 85ms at 48 kHz. Bigger = fewer callbacks. */
const BUFFER_FRAMES = 4096;

/** Float32 −1..1 → 16-bit PCM in a RIFF/WAVE container. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Box-average decimation. Speech at 16 kHz needs no fancier filter, and an
 *  average is a low-pass — plain index-picking would alias hiss into the band. */
function downsample(chunks: Float32Array[], from: number, to: number): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const flat = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    flat.set(c, at);
    at += c.length;
  }
  if (from <= to) return flat;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(flat.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(flat.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += flat[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

function toBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  // Chunked: String.fromCharCode(...arr) blows the argument limit around 100KB
  // and a 12s clip is four times that.
  let s = '';
  for (let i = 0; i < arr.length; i += 0x8000) {
    s += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export class LlmSpeechSource implements MicCommandSource {
  private _available = true;
  private utterCb: ((u: Utterance) => void) | null = null;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private proc: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;

  private recording = false;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private peakRms = 0;
  private permissionState: MicPermission = 'unknown';
  /** Live RMS 0..1-ish for the on-screen VU — same contract as WebSpeechSource. */
  level = 0;
  lastError = '';

  get available(): boolean {
    return this._available;
  }

  /** Always empty: runner-up hypotheses are a property of a local recognizer,
   *  and this source deliberately has none. The model hears the audio itself. */
  get alternatives(): string[] {
    return [];
  }

  /** The director's mic-fault card speaks this dialect; answer in it. */
  diagnose(): MicDiagnosis {
    return {
      peakRms: this.peakRms,
      permission: this.permissionState,
      lastError: this.lastError,
      hot: this.proc !== null,
      everHeardWords: false, // no local recognition — only the server knows
    };
  }

  /** Take the mic during the boot gesture so the first press is not spent on a
   *  permission dialog. iOS also requires a gesture to start an AudioContext. */
  async warmup(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        this._available = false;
        return;
      }
      if (!this.stream || this.stream.getAudioTracks().every((t) => t.readyState === 'ended')) {
        this.stream = await navigator.mediaDevices.getUserMedia({
          // The radio is mono and close-mic'd; let the browser clean it up.
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      }
      this.permissionState = 'granted';
      this.ensureGraph();
    } catch (e) {
      this.permissionState = 'denied';
      this.lastError = String((e as Error)?.name ?? e);
      this._available = false; // director falls back to the teletype
    }
  }

  onUtterance(cb: (u: Utterance) => void): void {
    this.utterCb = cb; // PTT resolves through stop(); kept for interface parity
  }

  start(): void {
    if (!this._available) return;
    this.chunks = [];
    this.peakRms = 0;
    this.startedAt = performance.now();
    this.recording = true;
    // warmup() normally did this during boot; a denied-then-granted mic or a
    // context the OS suspended lands here instead.
    if (!this.proc) void this.warmup();
    void this.ctx?.resume().catch(() => {});
  }

  async stop(): Promise<Utterance | null> {
    if (!this.recording) return null;
    this.recording = false;
    const ms = performance.now() - this.startedAt;
    const chunks = this.chunks;
    this.chunks = [];
    this.level = 0;

    // Nothing reached us, or the press was a twitch: an empty press, and the
    // director's diagnosis (peakRms) decides what to say about it. Never spend
    // an upload on silence.
    if (!chunks.length || ms < 220 || this.peakRms < SILENT_RMS) return null;

    const rate = this.ctx?.sampleRate ?? 48000;
    const pcm = downsample(chunks, rate, TARGET_HZ);
    if (pcm.length < TARGET_HZ * 0.15) return null;

    const audio: AudioClip = {
      data: toBase64(encodeWav(pcm, TARGET_HZ)),
      format: 'wav',
      ms: Math.round(Math.min(ms, MAX_MS)),
    };
    // text stays empty on purpose: this source cannot read, only record. The
    // words come back from the parse model as ParsedCommand.heard.
    return { text: '', shouted: this.peakRms >= SHOUT_RMS, source: 'speech', audio };
  }

  private ensureGraph(): void {
    if (this.proc || !this.stream) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this._available = false;
      return;
    }
    const ctx = this.ctx ?? new Ctor();
    this.ctx = ctx;
    this.srcNode = ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated in favour of AudioWorklet, and it is still
    // the only capture node that needs no second file: a worklet must be loaded
    // from a URL, and this bundle does not fetch anything at runtime (rule 1).
    // A blob-URL worklet would dodge that, at the cost of a second code path
    // for a node that every current browser still ships.
    this.proc = ctx.createScriptProcessor(BUFFER_FRAMES, 1, 1);
    this.proc.onaudioprocess = (ev) => this.onFrames(ev.inputBuffer.getChannelData(0));
    this.srcNode.connect(this.proc);
    // A ScriptProcessor only runs while connected to the destination, so it
    // goes through a silent gain — the mic must never reach the speakers.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.proc.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  private onFrames(input: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!;
    const rms = Math.sqrt(sum / input.length);
    this.level = this.recording ? rms : 0;
    if (!this.recording) return;
    if (rms > this.peakRms) this.peakRms = rms;
    const recorded = this.chunks.reduce((n, c) => n + c.length, 0);
    const cap = ((this.ctx?.sampleRate ?? 48000) * MAX_MS) / 1000;
    if (recorded >= cap) return; // long press: keep listening, stop hoarding
    this.chunks.push(new Float32Array(input)); // copy — the buffer is reused
  }
}
