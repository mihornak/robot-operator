/** Thin API client. Every call fail-softs — the game must run with the server down. */

import type { LogBatch, ParseRequest, ParsedCommand, SayRequest, SayResponse } from '@shared/types';

const PARSE_TIMEOUT_MS = 2500; // ack contract: ≤1.5s target, hard stop at 2.5
const TTS_TIMEOUT_MS = 3500;
/** Unprompted speech is ambient — it may never make the game wait. */
const SAY_TIMEOUT_MS = 3000;

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

/** Throws on any failure — caller falls back to the local parser. */
export async function apiParse(req: ParseRequest): Promise<ParsedCommand> {
  return withTimeout(PARSE_TIMEOUT_MS, async (signal) => {
    const res = await fetch('./api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok) throw new Error(`parse ${res.status}`);
    return (await res.json()) as ParsedCommand;
  });
}

/** The robot's unprompted line for a world event. Throws — caller uses the bank. */
export async function apiSay(req: SayRequest): Promise<SayResponse> {
  return withTimeout(SAY_TIMEOUT_MS, async (signal) => {
    const res = await fetch('./api/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok) throw new Error(`say ${res.status}`);
    return (await res.json()) as SayResponse;
  });
}

/** Throws on any failure — caller falls back to bank line / caption-only. */
export async function apiTts(text: string, id?: string): Promise<ArrayBuffer> {
  return withTimeout(TTS_TIMEOUT_MS, async (signal) => {
    const res = await fetch('./api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, id }),
      signal,
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    return await res.arrayBuffer();
  });
}

// ---------------------------------------------------------------- logging

const session = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
let queue: LogBatch['events'] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

export function logEvent(type: string, data?: Record<string, unknown>): void {
  queue.push({ t: Date.now(), type, ...(data ? { data } : {}) });
  if (!flushTimer) flushTimer = setInterval(flushLogs, 5000);
}

export function flushLogs(): void {
  if (queue.length === 0) return;
  const batch: LogBatch = { session, events: queue };
  queue = [];
  // sendBeacon survives tab close; fetch keepalive as fallback; failures are silent.
  try {
    const blob = new Blob([JSON.stringify(batch)], { type: 'application/json' });
    if (!navigator.sendBeacon?.('./api/log', blob)) {
      void fetch('./api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    /* instrumentation must never break the game */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushLogs);
}
