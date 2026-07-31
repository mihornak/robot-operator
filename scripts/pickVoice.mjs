/**
 * Find THE voice for the robot: confident toddler, third person, overconfident.
 * Lists owned/premade voices + searches the shared library, shortlists by
 * label fit, synths a sample per candidate to scripts/voice-samples/, then
 * writes the winner's id as ELEVENLABS_VOICE_ID into .env.
 *
 * Run: node --env-file=.env scripts/pickVoice.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.elevenlabs.io/v1';
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error('ELEVENLABS_API_KEY missing — run with node --env-file=.env');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES_DIR = path.join(ROOT, 'scripts', 'voice-samples');
const SAMPLE_TEXT = 'Robot has no name. Voice gives name? … Wall is rude.';
const MODEL = 'eleven_flash_v2_5';
const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.75, style: 0.45 };

async function api(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

// ---- scoring: childlike > young male > neutral bright; NOT deep, NOT sultry
const GOOD = [
  [/child|kid|toddler|little/i, 5],
  [/cartoon|animation|character/i, 3],
  [/young/i, 3],
  [/cute|playful|cheeky|energetic|bright|whimsical|quirky|fun/i, 2],
  [/robot/i, 1],
];
const BAD = [
  [/deep/i, -5],
  [/sultry|seductive|sexy|husky/i, -6],
  [/\bold\b|elderly|mature|middle[- ]?aged/i, -3],
  [/raspy|gravel|gruff|intense|rough|fierce/i, -2],
  [/meditat|calm|soothing|asmr/i, -2],
];

function score(v) {
  const blob = [v.name, v.age, v.gender, v.use_case, v.descriptive, v.description, v.accent]
    .filter(Boolean)
    .join(' ');
  let s = 0;
  for (const [re, pts] of [...GOOD, ...BAD]) if (re.test(blob)) s += pts;
  if (v.descriptive === 'cute') s += 4; // label-level childlike signal
  if (v.category === 'premade' || v.owned) s += 1; // usable without /voices/add
  if (v.gender === 'male' && /young|child/i.test(blob)) s += 1;
  return s;
}

// ---- gather candidates
console.log('Fetching owned/premade voices…');
const own = (await (await api('/voices')).json()).voices.map((v) => ({
  voice_id: v.voice_id,
  name: v.name,
  category: v.category,
  owned: true,
  preview_url: v.preview_url,
  ...v.labels, // accent, description, age, gender, use_case
}));

const SEARCHES = ['child', 'boy', 'young', 'cartoon', 'robot', 'cute'];
const shared = new Map();
for (const q of SEARCHES) {
  console.log(`Searching shared library: "${q}"…`);
  const j = await (await api(`/shared-voices?page_size=100&search=${encodeURIComponent(q)}`)).json();
  for (const v of j.voices ?? []) {
    if (v.language && !/^en/i.test(v.language)) continue;
    if (v.free_users_allowed === false) continue;
    shared.set(v.voice_id, {
      voice_id: v.voice_id,
      name: v.name,
      category: 'shared',
      owned: false,
      public_owner_id: v.public_owner_id,
      preview_url: v.preview_url,
      accent: v.accent,
      description: v.description,
      descriptive: v.descriptive,
      age: v.age,
      gender: v.gender,
      use_case: v.use_case,
      cloned_by_count: v.cloned_by_count ?? 0,
    });
  }
}

const all = [...own, ...shared.values()].map((v) => ({ ...v, score: score(v) }));
all.sort((a, b) => b.score - a.score || (b.cloned_by_count ?? 0) - (a.cloned_by_count ?? 0));

const shortlist = [];
for (const v of all) {
  if (shortlist.length >= 6) break;
  if (v.score < 3) break;
  // keep the shortlist mixed: at most 3 shared entries (API key may lack library-add permission)
  if (!v.owned && shortlist.filter((c) => !c.owned).length >= 3) continue;
  shortlist.push(v);
}
if (shortlist.length < 4) shortlist.push(...all.filter((v) => !shortlist.includes(v)).slice(0, 4 - shortlist.length));

console.log('\n=== SHORTLIST ===');
for (const v of shortlist) {
  console.log(
    `  [${String(v.score).padStart(2)}] ${v.name.padEnd(22)} ${v.owned ? v.category : 'shared'}  age=${v.age ?? '?'} gender=${v.gender ?? '?'} use=${v.use_case ?? '?'} desc=${(v.descriptive ?? v.description ?? '').slice(0, 60)}`,
  );
}

// ---- sample each candidate
await mkdir(SAMPLES_DIR, { recursive: true });
for (const v of shortlist) {
  const safe = v.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const file = path.join(SAMPLES_DIR, `${safe}.mp3`);
  try {
    let bytes;
    if (v.owned) {
      const res = await api(`/text-to-speech/${v.voice_id}?output_format=mp3_44100_128`, {
        method: 'POST',
        body: JSON.stringify({ text: SAMPLE_TEXT, model_id: MODEL, voice_settings: VOICE_SETTINGS }),
      });
      bytes = Buffer.from(await res.arrayBuffer());
      v.sample = 'synth';
    } else {
      // shared voices can't be TTS'd before /voices/add — use library preview
      const res = await fetch(v.preview_url);
      if (!res.ok) throw new Error(`preview fetch ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
      v.sample = 'preview';
    }
    await writeFile(file, bytes);
    console.log(`  sample (${v.sample}) -> ${path.relative(ROOT, file)} (${bytes.length} bytes)`);
  } catch (e) {
    v.sampleError = String(e.message ?? e);
    console.log(`  sample FAILED for ${v.name}: ${v.sampleError}`);
  }
}

// ---- pick: best metadata fit; prefer premade/owned when it is a good fit
const usable = shortlist.filter((v) => !v.sampleError);
const bestOwned = usable.find((v) => v.owned);
const best = usable[0];
let winner = best;
if (bestOwned && (bestOwned === best || bestOwned.score >= Math.max(4, best.score - 2))) winner = bestOwned;
if (!winner) {
  console.error('No usable candidate found.');
  process.exit(1);
}

// shared winner must be added to the account before TTS works; keys without
// the add_voice_from_voice_library permission fall back to the best owned voice
if (!winner.owned) {
  console.log(`Adding shared voice "${winner.name}" to account…`);
  try {
    await api(`/voices/add/${winner.public_owner_id}/${winner.voice_id}`, {
      method: 'POST',
      body: JSON.stringify({ new_name: winner.name }),
    });
  } catch (e) {
    console.log(`  add failed (${String(e.message ?? e).slice(0, 120)}…)`);
    if (!bestOwned) {
      console.error('No owned fallback available.');
      process.exit(1);
    }
    console.log(`  falling back to best owned voice: ${bestOwned.name}`);
    winner = bestOwned;
  }
}

// ---- write ELEVENLABS_VOICE_ID into .env, preserving other lines
const envPath = path.join(ROOT, '.env');
let env = await readFile(envPath, 'utf8');
if (/^ELEVENLABS_VOICE_ID=.*$/m.test(env)) {
  env = env.replace(/^ELEVENLABS_VOICE_ID=.*$/m, `ELEVENLABS_VOICE_ID=${winner.voice_id}`);
} else {
  if (!env.endsWith('\n')) env += '\n';
  env += `ELEVENLABS_VOICE_ID=${winner.voice_id}\n`;
}
await writeFile(envPath, env);

console.log('\n=== CHOICE ===');
console.log(`voice: ${winner.name} (${winner.voice_id}) [${winner.owned ? winner.category : 'shared, added'}]`);
console.log(`score: ${winner.score}  age=${winner.age ?? '?'} gender=${winner.gender ?? '?'} use=${winner.use_case ?? '?'}`);
console.log(`reasoning: highest label fit for childlike/cartoon among ${all.length} candidates; ` +
  (winner.owned ? 'owned/premade so usable without library add.' : 'no good owned option, added from shared library.'));
console.log(`ELEVENLABS_VOICE_ID written to .env`);
