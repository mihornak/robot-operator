/**
 * The robot's mouth: serial voice queue with the fail-soft chain
 * bank mp3 → realtime TTS → caption-only. Captions always shown.
 */

import { BANK_BY_ID } from '@shared/voiceLines';
import type { AudioEngine } from '@shared/types';
import { apiTts } from '../net/api';

export type SpeechPriority = 'beat' | 'ack' | 'bark' | 'idle';

/** ?mute=1 — captions only, zero TTS API calls (automated tests, credit thrift). */
const MUTE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('mute');

export interface SpeechItem {
  /** Bank line id — resolves text + pregenerated mp3. */
  bankId?: string;
  /** Dynamic text (name lines, LLM acks). Realtime TTS → caption-only. */
  text?: string;
  priority: SpeechPriority;
  /** Pause after the line, ms. */
  gapMs?: number;
}

export class SpeechQueue {
  private queue: SpeechItem[] = [];
  private speaking = false;
  private currentCaption = '';
  private captionUntil = 0;
  /** Priority of the line currently being voiced (null when silent). */
  private currentPriority: SpeechPriority | null = null;
  /** Bumped by clear() — a pump from an older epoch must never touch state again. */
  private epoch = 0;

  constructor(
    private audio: AudioEngine,
    private onLineStart?: (text: string) => void,
  ) {}

  get caption(): string {
    if (this.speaking || performance.now() < this.captionUntil) return this.currentCaption;
    return '';
  }

  get busy(): boolean {
    return this.speaking || this.queue.length > 0;
  }

  /** Barks/idles are dropped rather than queued behind other speech. */
  say(item: SpeechItem): void {
    if ((item.priority === 'bark' || item.priority === 'idle') && this.busy) return;
    if (item.priority === 'ack') {
      // Acks preempt queued barks/idles but never queued beats.
      this.queue = this.queue.filter((q) => q.priority === 'beat' || q.priority === 'ack');
    }
    this.queue.push(item);
    if (
      item.priority === 'ack' &&
      this.speaking &&
      (this.currentPriority === 'bark' || this.currentPriority === 'idle')
    ) {
      // Cut the playing bark/idle so the ack lands now: stopping resolves the
      // playVoice* promise, the in-flight pump finishes and picks up the ack.
      this.audio.stopVoice();
    }
    void this.pump();
  }

  sayBank(bankId: string, priority: SpeechPriority = 'beat', gapMs?: number): void {
    this.say({ bankId, priority, ...(gapMs !== undefined ? { gapMs } : {}) });
  }

  sayText(text: string, priority: SpeechPriority = 'beat', gapMs?: number): void {
    this.say({ text, priority, ...(gapMs !== undefined ? { gapMs } : {}) });
  }

  /** Cut everything (death, phase changes). */
  clear(): void {
    this.epoch++;
    this.queue = [];
    this.audio.stopVoice();
    this.speaking = false;
    this.currentPriority = null;
    this.captionUntil = 0;
    this.currentCaption = '';
  }

  private async pump(): Promise<void> {
    if (this.speaking) return;
    const item = this.queue.shift();
    if (!item) return;
    const epoch = this.epoch;
    this.speaking = true;
    this.currentPriority = item.priority;

    const text = item.bankId ? (BANK_BY_ID[item.bankId]?.text ?? '') : (item.text ?? '');
    const caption = text.toUpperCase();
    this.currentCaption = caption;
    this.onLineStart?.(caption);

    const captionMs = 700 + text.length * 55;
    let played = false;
    try {
      if (!MUTE && item.bankId) {
        await this.audio.playVoiceUrl(`./assets/voice/${item.bankId}.mp3`);
        played = true;
      }
    } catch {
      /* fall through to realtime */
    }
    if (epoch !== this.epoch) return; // clear()ed mid-line; a newer pump owns the mouth
    if (!MUTE && !played && text) {
      try {
        const bytes = await apiTts(text, item.bankId);
        if (epoch !== this.epoch) return;
        await this.audio.playVoiceBytes(bytes);
        played = true;
      } catch {
        /* caption-only */
      }
      if (epoch !== this.epoch) return;
    }
    if (!played) {
      await new Promise((r) => setTimeout(r, captionMs));
      if (epoch !== this.epoch) return;
    }
    this.captionUntil = performance.now() + 350;
    if (item.gapMs) {
      await new Promise((r) => setTimeout(r, item.gapMs));
      if (epoch !== this.epoch) return;
    }
    this.speaking = false;
    this.currentPriority = null;
    void this.pump();
  }
}
