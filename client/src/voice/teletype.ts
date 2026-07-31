/**
 * Teletype CommandSource — the zero-mic path that must ALWAYS work.
 * The director routes keydowns through handleKey() and owns activation policy
 * (setActive) + mirrors value → ui.teletype via onChange. A self-managed
 * global capture listener is available opt-in for standalone use.
 */

import type { CommandSource, Utterance } from '@shared/types';

const MAX_LEN = 120;

export class TeletypeSource implements CommandSource {
  readonly available = true;
  private _value = '';
  private _active = false;
  private utterCb: ((u: Utterance) => void) | null = null;
  private changeCbs: Array<(value: string, active: boolean) => void> = [];

  /** globalCapture: own the window keydown stream instead of director routing. */
  constructor(private globalCapture = false) {}

  get value(): string {
    return this._value;
  }

  get active(): boolean {
    return this._active;
  }

  /** Director decides when the teletype line is live. */
  setActive(on: boolean): void {
    if (on === this._active) return;
    this._active = on;
    if (this.globalCapture) {
      if (on) window.addEventListener('keydown', this.onKeydown, true);
      else window.removeEventListener('keydown', this.onKeydown, true);
    }
    if (!on) this._value = '';
    this.emitChange();
  }

  /**
   * Process one keydown; true = consumed (typed spaces never reach PTT).
   * Caller is expected to preventDefault when consumed.
   */
  handleKey(ev: KeyboardEvent): boolean {
    if (!this._active || ev.metaKey || ev.ctrlKey || ev.altKey) return false;
    if (ev.key === 'Enter') {
      const text = this._value.trim();
      this._value = '';
      this.emitChange();
      if (text) this.utterCb?.({ text, shouted: false, source: 'typed' });
      return true;
    }
    if (ev.key === 'Backspace') {
      this._value = this._value.slice(0, -1);
      this.emitChange();
      return true;
    }
    if (ev.key === ' ' && this._value === '') return false; // space stays PTT until a buffer exists
    if (ev.key.length === 1) {
      if (this._value.length < MAX_LEN) this._value += ev.key;
      this.emitChange();
      return true;
    }
    return false;
  }

  /** Fires on every value/active mutation — director mirrors into UiState. */
  onChange(cb: (value: string, active: boolean) => void): void {
    this.changeCbs.push(cb);
  }

  onUtterance(cb: (u: Utterance) => void): void {
    this.utterCb = cb;
  }

  /** Teletype completes on its own (Enter) — PTT lifecycle is a no-op. */
  start(): void {}

  stop(): Promise<Utterance | null> {
    return Promise.resolve(null);
  }

  // -------------------------------------------------------------- internals

  private onKeydown = (ev: KeyboardEvent): void => {
    if (this.handleKey(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };

  private emitChange(): void {
    for (const cb of this.changeCbs) cb(this._value, this._active);
  }
}
