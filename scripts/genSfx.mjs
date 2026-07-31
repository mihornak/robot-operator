/**
 * Pregenerate SFX via ElevenLabs sound-generation for every SfxName in
 * shared/types.ts. Prompts tuned for the dark facility security-feed feel.
 * Idempotent, concurrency <=3, one retry. Some plans lack the SFX API — the
 * script then skips gracefully (client synth fallbacks cover it).
 *
 * Run: node --env-file=.env scripts/genSfx.mjs
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.elevenlabs.io/v1';
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error('ELEVENLABS_API_KEY missing — run with node --env-file=.env');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'client', 'public', 'assets', 'sfx');

/** name -> [prompt, duration_seconds]; must cover the SfxName union exactly. */
const SFX = {
  radio_on: ['short walkie-talkie radio click on, tight, dry', 0.5],
  radio_off: ['short walkie-talkie radio click off, brief static tail, tight', 0.5],
  static_burst: ['brief analog TV static burst, harsh white noise, 300ms', 0.5],
  servo: ['small servo motor whir, robot head turn, 250ms', 0.5],
  bump: ['small metal robot bumps into concrete wall, dull clank', 0.7],
  shoot: ['small retro sci-fi energy pistol pew, tight', 0.5],
  zap: ['electric spark zap crackle, short', 0.5],
  spark_loop: ['seamless loop electrical cable sparking intermittently', 3],
  elevator_ding: ['old industrial elevator arrival ding, slightly detuned', 1.5],
  doors: ['industrial elevator doors sliding shut, mechanical', 1.5],
  powerup: ['chunky retro power-up chime, warm, ascending', 1.2],
  powerdown: ['sad robot powering down, descending whine, motor stop', 1.8],
  boot: ['CRT monitor powering on, degauss thunk, electric bloom', 1.5],
  paper: ['wet crumpled paper ball thrown, soft impact', 0.6],
  hit: ['metallic impact on broken printer, plastic rattle', 0.6],
  enemy_die: ['small appliance exploding into parts, plastic clatter, puff', 1.2],
  scrap: ['small metal trinket pickup chime, bright, short', 0.6],
  spin: ['happy little robot spinning in place, servo whirr with wobble', 1.2],
  fuse_in: ['heavy electrical fuse slotting in, clunk, power hum rising', 1.5],
  title: ['ominous warm synth swell sting, short, cinematic', 3],
};

// guard: prompt map must match the SfxName union in shared/types.ts
const typesSrc = await readFile(path.join(ROOT, 'shared', 'types.ts'), 'utf8');
const unionSrc = typesSrc.match(/export type SfxName =([\s\S]*?);/)?.[1] ?? '';
const declared = [...unionSrc.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const missing = declared.filter((n) => !(n in SFX));
const extra = Object.keys(SFX).filter((n) => !declared.includes(n));
if (missing.length || extra.length) {
  console.error(`SfxName mismatch — missing prompts: [${missing}] extra prompts: [${extra}]`);
  process.exit(1);
}

async function gen(name, prompt, seconds) {
  const res = await fetch(`${API}/sound-generation`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: prompt, duration_seconds: seconds, prompt_influence: 0.4 }),
  });
  if (!res.ok) {
    const err = new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`suspiciously small response (${bytes.length} bytes)`);
  await writeFile(path.join(OUT_DIR, `${name}.mp3`), bytes);
  return bytes.length;
}

await mkdir(OUT_DIR, { recursive: true });
console.log(`SFX: ${declared.length} sounds -> ${path.relative(ROOT, OUT_DIR)}`);

const results = new Map();
let apiUnavailable = false; // plan lacks SFX API -> stop hammering, skip the rest
const queue = Object.entries(SFX);
async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const [name, [prompt, seconds]] = job;
    const file = path.join(OUT_DIR, `${name}.mp3`);
    const existing = await stat(file).catch(() => null);
    if (existing && existing.size > 0) {
      results.set(name, { bytes: existing.size, status: 'kept' });
      continue;
    }
    if (apiUnavailable) {
      results.set(name, { bytes: 0, status: 'skipped (SFX API unavailable)' });
      continue;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const bytes = await gen(name, prompt, seconds);
        results.set(name, { bytes, status: 'new' });
        console.log(`  ${name} ok (${bytes} bytes)`);
        break;
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          apiUnavailable = true;
          results.set(name, { bytes: 0, status: `skipped: ${String(e.message).slice(0, 80)}` });
          console.warn(`  ${name}: SFX API rejected (${e.status}) — skipping remaining SFX, client synth fallbacks cover it`);
          break;
        }
        if (attempt >= 2) {
          results.set(name, { bytes: 0, status: `FAILED: ${String(e.message ?? e).slice(0, 100)}` });
          console.error(`  ${name} FAILED after retry: ${e.message ?? e}`);
          break;
        }
        console.warn(`  ${name} retrying (${String(e.message ?? e).slice(0, 80)})`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}
await Promise.all(Array.from({ length: 3 }, worker));

console.log('\nname'.padEnd(16) + 'bytes'.padStart(9) + '  status');
let total = 0;
let ok = 0;
for (const name of declared) {
  const r = results.get(name) ?? { bytes: 0, status: 'MISSING' };
  total += r.bytes;
  if (r.bytes > 0) ok++;
  console.log(name.padEnd(15) + String(r.bytes).padStart(9) + `  ${r.status}`);
}
console.log(`\n${ok}/${declared.length} sfx, ${total} bytes total`);
if (ok < declared.length && !apiUnavailable) process.exit(1);
