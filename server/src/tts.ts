/**
 * /api/tts: ElevenLabs eleven_flash_v2_5 stream proxy with a disk cache at
 * server/.cache/tts/<sha1(voiceId+':'+text)>.mp3. Env is read per request —
 * the voicebank script writes ELEVENLABS_VOICE_ID into .env after boot.
 * NO audio tags, ever (CLAUDE.md rule 8).
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TTS_TIMEOUT_MS = 3000;
const MODEL_ID = 'eleven_flash_v2_5';
/** Placeholder — voicebank script writes the real id into ../.env. */
const DEFAULT_VOICE_ID = 'pFZP5JQG7iQjIQuC4Bku';
const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.75, style: 0.45 };

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'tts');

export type TtsResult =
  | { ok: true; audio: ArrayBuffer; cached: boolean }
  | { ok: false; status: 502 | 503 | 504; error: string };

/** Copy into a plain ArrayBuffer (Buffer views can sit on a shared pool). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export async function synthesize(text: string): Promise<TtsResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  if (!apiKey) return { ok: false, status: 503, error: 'ELEVENLABS_API_KEY missing' };

  const hash = createHash('sha1').update(`${voiceId}:${text}`).digest('hex');
  const file = join(CACHE_DIR, `${hash}.mp3`);
  if (existsSync(file)) {
    return { ok: true, audio: toArrayBuffer(await readFile(file)), cached: true };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: VOICE_SETTINGS }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, status: 502, error: `elevenlabs ${res.status} ${detail.slice(0, 200)}` };
    }
    const audio = await res.arrayBuffer();
    if (audio.byteLength === 0) return { ok: false, status: 502, error: 'empty audio' };
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, Buffer.from(audio));
    } catch {
      // cache write failure must not fail the request
    }
    return { ok: true, audio, cached: false };
  } catch (err) {
    if (ctrl.signal.aborted) return { ok: false, status: 504, error: 'tts timeout' };
    return { ok: false, status: 502, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}
