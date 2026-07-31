/**
 * Pregenerate the robot voice bank from shared/voiceLines.ts.
 * Idempotent (skips existing mp3s), concurrency <=4, one retry per line.
 * Writes client/public/assets/voice/<id>.mp3 + manifest.json.
 *
 * Run: node --env-file=.env scripts/genVoiceBank.mjs
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.elevenlabs.io/v1';
const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
if (!KEY || !VOICE_ID) {
  console.error('Need ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env (run scripts/pickVoice.mjs first).');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'client', 'public', 'assets', 'voice');
const MODEL = 'eleven_flash_v2_5';
const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.75, style: 0.45 };

// ---- load the bank: node >=22.6 strips types, voiceLines.ts is type-only-import safe
async function loadBank() {
  const url = new URL('../shared/voiceLines.ts', import.meta.url);
  try {
    const mod = await import(url.href);
    if (Array.isArray(mod.VOICE_BANK)) return mod.VOICE_BANK;
    throw new Error('VOICE_BANK export missing');
  } catch (e) {
    console.warn(`TS import failed (${String(e.message ?? e).slice(0, 80)}), regex-parsing instead`);
    const src = await readFile(fileURLToPath(url), 'utf8');
    const lines = [...src.matchAll(/\{\s*id:\s*'([^']+)',\s*text:\s*'((?:[^'\\]|\\.)*)'\s*\}/g)].map(
      (m) => ({ id: m[1], text: m[2].replace(/\\'/g, "'") }),
    );
    if (!lines.length) throw new Error('regex fallback found no bank lines');
    return lines;
  }
}

async function synth(line) {
  const res = await fetch(`${API}/text-to-speech/${VOICE_ID}/stream?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: line.text, model_id: MODEL, voice_settings: VOICE_SETTINGS }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`suspiciously small response (${bytes.length} bytes)`);
  await writeFile(path.join(OUT_DIR, `${line.id}.mp3`), bytes);
  return bytes.length;
}

const bank = await loadBank();
await mkdir(OUT_DIR, { recursive: true });
console.log(`Bank: ${bank.length} lines -> ${path.relative(ROOT, OUT_DIR)} (voice ${VOICE_ID})`);

const results = new Map(); // id -> { bytes, status }
const queue = [...bank];
async function worker() {
  for (let line = queue.shift(); line; line = queue.shift()) {
    const file = path.join(OUT_DIR, `${line.id}.mp3`);
    const existing = await stat(file).catch(() => null);
    if (existing && existing.size > 0) {
      results.set(line.id, { bytes: existing.size, status: 'kept' });
      continue;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const bytes = await synth(line);
        results.set(line.id, { bytes, status: 'new' });
        console.log(`  ${line.id} ok (${bytes} bytes)`);
        break;
      } catch (e) {
        if (attempt >= 2) {
          results.set(line.id, { bytes: 0, status: `FAILED: ${String(e.message ?? e).slice(0, 100)}` });
          console.error(`  ${line.id} FAILED after retry: ${e.message ?? e}`);
          break;
        }
        console.warn(`  ${line.id} retrying (${String(e.message ?? e).slice(0, 80)})`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));

console.log('\nid'.padEnd(22) + 'bytes'.padStart(9) + '  status');
let total = 0;
let failed = 0;
for (const { id } of bank) {
  const r = results.get(id) ?? { bytes: 0, status: 'MISSING' };
  total += r.bytes;
  if (!r.bytes) failed++;
  console.log(id.padEnd(21) + String(r.bytes).padStart(9) + `  ${r.status}`);
}
console.log(`\n${bank.length - failed}/${bank.length} lines, ${total} bytes total`);

const ok = bank.filter(({ id }) => (results.get(id)?.bytes ?? 0) > 0).map(({ id }) => id);
await writeFile(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify({ voiceId: VOICE_ID, lines: ok }, null, 2) + '\n',
);
console.log(`manifest.json written (${ok.length} lines)`);
if (failed) process.exit(1);
