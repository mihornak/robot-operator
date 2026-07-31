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

interface AudioWithUrl extends AudioEngine {
  playVoiceUrl?(url: string): Promise<void>;
}

export class SpeechQueue {
  private queue: SpeechItem[] = [];
  private speaking = false;
  private currentCaption = '';
  private captionUntil = 0;

  constructor(
    private audio: AudioWithUrl,
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
    this.queue = [];
    this.audio.stopVoice();
    this.speaking = false;
    this.captionUntil = 0;
    this.currentCaption = '';
  }

  private async pump(): Promise<void> {
    if (this.speaking) return;
    const item = this.queue.shift();
    if (!item) return;
    this.speaking = true;

    const text = item.bankId ? (BANK_BY_ID[item.bankId]?.text ?? '') : (item.text ?? '');
    const caption = text.toUpperCase();
    this.currentCaption = caption;
    this.onLineStart?.(caption);

    const captionMs = 700 + text.length * 55;
    let played = false;
    try {
      if (!MUTE && item.bankId && this.audio.playVoiceUrl) {
        await this.audio.playVoiceUrl(`./assets/voice/${item.bankId}.mp3`);
        played = true;
      }
    } catch {
      /* fall through to realtime */
    }
    if (!MUTE && !played && text) {
      try {
        const bytes = await apiTts(text, item.bankId);
        await this.audio.playVoiceBytes(bytes);
        played = true;
      } catch {
        /* caption-only */
      }
    }
    if (!played) {
      await new Promise((r) => setTimeout(r, captionMs));
    }
    this.captionUntil = performance.now() + 350;
    if (item.gapMs) await new Promise((r) => setTimeout(r, item.gapMs));
    this.speaking = false;
    void this.pump();
  }
}
