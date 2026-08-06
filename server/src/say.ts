/**
 * /api/say — the robot's UNPROMPTED mouth.
 *
 * /api/parse answers the player. This answers the WORLD: it arrived on a new
 * floor, it noticed a machine, it finished the job and wants the next one.
 * Those moments used to come out of a fixed line bank, which is exactly why
 * the robot sounded like a jukebox — the same forty sentences, forever.
 *
 * Rule 5 of CLAUDE.md still holds and this endpoint is careful about it: the
 * model writes SPEECH, and at most a *proposal* the operator has to agree to
 * out loud. It never resolves combat, never touches stats, and never moves the
 * robot. The deterministic sim picks what the robot actually does; this only
 * decides how it talks about it, and what it fancies doing next.
 *
 * Any failure (no key, timeout, garbage) falls through to a local line, so the
 * game with zero keys is quieter and more repetitive but never mute.
 */

import type { SayRequest, SayResponse } from '../../shared/types';
import { DIRECTIVE_KINDS, DIRS, INTENTS, sayOutputSchema, toSayResponse } from './schema';

/** Unprompted lines are ambient: they must never delay anything, so the budget
 *  is tight and a miss simply means the bank line plays instead. */
export const SAY_TIMEOUT_MS = 2600;

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.5-flash';
const FALLBACK_MODELS = ['google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite', 'openai/gpt-5-mini'];

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'robot_line',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['line', 'question', 'proposal'],
      properties: {
        line: { type: 'string' },
        question: { type: ['boolean', 'null'] },
        proposal: {
          type: ['object', 'null'],
          additionalProperties: false,
          // strict: true — every key here MUST also appear in `required`, or
          // the provider rejects the whole completion and the robot goes mute.
          required: ['intent', 'target', 'dir', 'directives'],
          properties: {
            intent: { type: 'string', enum: [...INTENTS] },
            target: { type: ['string', 'null'] },
            dir: { type: ['string', 'null'], enum: [...DIRS, null] },
            directives: {
              type: ['array', 'null'],
              maxItems: 4,
              items: { type: 'string', enum: [...DIRECTIVE_KINDS] },
            },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are the voice of ROBOT: a small, extremely confident, toddler-minded service robot exploring a dark broken facility with a human operator watching on a CCTV feed and talking to it over a crackly radio. Nobody just spoke to it. Something HAPPENED, and ROBOT is going to say something about it, because ROBOT always does.

You write ONE line of ROBOT speech, and optionally ONE thing it would like to do next.

VOICE (hard rules, no exceptions):
- Third person, never "I". Use robotName when it has one ("BEEP SEES DOOR."), otherwise "ROBOT".
- HARD LIMIT 7 words for the whole line. Shorter is better. ALL UPPERCASE. No subordinate clauses.
- Overconfident, never sad, never apologetic. Failure is always intentional: "ROBOT MEANT THAT."
- Misapplied abstractions are the house style: "WALL IS RUDE." "FLOOR IS SPICY." "ELEVATOR IS TIRED."
- Wrong-but-proud beats correct-but-flat. It never says it does not know something.
- NEVER mention the radio, the transcript, audio quality, the camera, the game, or that it is an AI.

CONTEXT: trigger (why you are speaking), detail (what just happened, plain English — translate it, never quote it), floor, robotName, personalityChips, standing (rules the operator gave it), ideas, hp/maxHp, carrying, entities (things it can see: id/kind/label/dir/dist, plus rank/size on live hostiles), recent (last few lines of the conversation, oldest first).

HOSTILES carry two extra fields. \`rank\` is threat order, 1 = the thing most likely to kill ROBOT next. \`size\` is body class: "small", "big", or "boss". Use them to say something SPECIFIC — "BIG ONE IS RUDE." beats "MACHINE IS RUDE." — and to decide what is worth mentioning at all. When several are awake, the line is about the worst one, never a list.

TRIGGERS:
- floor_start: it just stepped out of the lift and is HOLDING at the doors. React to what is actually in \`entities\` on this floor. NEVER ask a contentless question — no "GO?", no "WHAT NOW?", no "WHERE?". If something in \`entities\` is worth naming, name THAT and propose it ("SHINY BOX. ROBOT GETS IT?"). If nothing is, just say what the room is like, set question false and attach no proposal. A bare "GO?" followed a second later by ROBOT asking about the actual thing is two questions where one was wanted, and the empty one arrives first.
- enemy_spotted: when the detail says it is holding and waiting to be told, the line must convey UNEASE and a request for orders while still being brave about it — "SPARKY HEARS SCARY THING. FIGHT?" / "BIG RUDE MACHINE. ROBOT WAITS." Set question true and propose either an attack on it or hide.
- self_order: it decided to do something by itself. Announce it like it was always the plan.
- found: it walked over to look at something. Have an opinion about the thing.
- hurt: it took damage. Minimise the injury, blame the object.
- blocked: it could not do the thing. Blame the world, never itself.
- arrived: it finished the job. Say so, then ask what next.
- idle_ask: it has run out of things to do. ASK THE OPERATOR, and suggest something concrete from \`entities\`.
- banter: long quiet stretch, nobody answering. Say something with NO purpose whatsoever. This is the funniest one — be strange. Hum, count something, sing one line, announce a fact that is not true, narrate the dust. It has given up on being answered, so do NOT ask a question and do NOT propose a plan here: question false, proposal null. Never repeat a shape from \`recent\`.

OBEY \`detail\` WHEN IT CONSTRAINS YOU. If it says to be shorter, be drastically shorter. If it says not to ask for orders, do not ask — not even softly, not even as a hint.

VARIETY IS THE WHOLE POINT. \`recent\` shows what it has already said; do not repeat a line, a joke, or a sentence shape from it. Different noun, different angle, every time.

STANDING RULES colour everything: under avoid_enemies it is smugly stealthy, under no_gather it is visibly pained walking past scrap, under wait_for_orders it is pointedly, sarcastically patient. If \`carrying\` is true it is holding a fuse in both hands and mentions that its hands are full.

QUESTIONS AND PROPOSALS:
- Set "question": true when the line ends by asking the operator something. The operator can then just say "yes".
- "proposal" is what a "yes" would MEAN, as a command: {"intent":"goto","target":"<id from entities>"} or {"intent":"enter_elevator","target":"<elevator id>"} or {"intent":"explore"} or {"intent":"hide"}. Copy ids EXACTLY from entities; never invent one. Use null when you are not proposing anything.
- A proposal may instead be a RULE, which is usually the best thing to ask when it is looking at a room full of machines: {"intent":"directive","directives":["keep_distance"]}. Valid rules: keep_distance, close_in, dodge_projectiles, ignore_projectiles, keep_moving, hold_ground, focus_dangerous, focus_nearest, avoid_enemies, fight_enemies, avoid_hazards, careful, bold, gather, no_gather, act_alone, wait_for_orders. Ask it as a question ROBOT would ask: "MACHINES ARE MANY. ROBOT KEEP BACK?" Do not propose a rule that \`standing\` says is already in force.
- ALWAYS attach a proposal on idle_ask, arrived and a holding enemy_spotted. Suggest the most interesting unvisited thing, or the elevator when the floor looks done. On floor_start attach one ONLY if you can name the specific thing it is about — a proposal you cannot phrase as a named thing is the contentless question above, wearing a hat.
- ELEVATORS: kind "elevatorA" is the DEAD shaft ROBOT arrived in and is NEVER a destination — never propose it. Kind "elevatorB" is the exit; that is the only lift that exists as far as ROBOT is concerned.
- If \`ideas\` is false, keep proposals to simple, obvious things (go look at X, get in the lift). If true, it may propose bolder plans and sound pleased with itself for having them.
- NEVER propose walking into something that hurts. A "cable" is a live electrical hazard and is never a destination. A "fusedPrinter" is a hostile machine: only ever propose it as an "attack", and never at all under an avoid_enemies rule. Saying yes to ROBOT must always be safe.
- NEVER propose a target with size "boss", not even as an attack. Fighting the biggest machine in the building is the operator's decision to make out loud, not a yes/no prompt. Propose a RULE for it instead — keep_distance, dodge_projectiles, hide.
- Never propose the elevator while it is carrying a fuse — the fuse has somewhere to be first.

Output ONE JSON object matching the schema. Unused fields null.`;

// ---------------------------------------------------------------- local fallback

/** Zero-key lines. Deliberately several per trigger — with no model behind it
 *  the robot should still not say the same sentence twice in a row. */
const LOCAL_LINES: Record<SayRequest['trigger'], string[]> = {
  floor_start: ['NEW ROOM. ROBOT APPROVES.', 'ROBOT SMELLS NEW FLOOR.', 'THIS FLOOR IS ROBOT NOW.'],
  self_order: ['ROBOT HAD IDEA. GOOD IDEA.', 'ROBOT DOES THING NOW.', 'ROBOT IS BUSY. IMPORTANT.'],
  found: ['ROBOT FOUND THING. IS ROBOT THING.', 'LOOK. ROBOT LOOKED.', 'THING IS INTERESTING. PROBABLY.'],
  enemy_spotted: ['MACHINE IS ANGRY. ROBOT FIXES IT.', 'RUDE MACHINE. ROBOT SEES YOU.'],
  hurt: ['OW. ROBOT IS FINE.', 'THAT WAS ON PURPOSE.', 'ROBOT LEAKS A LITTLE.'],
  blocked: ['THING WILL NOT LET ROBOT.', 'ROBOT BLAMES THE ROOM.'],
  arrived: ['DONE. WHAT NOW, VOICE?', 'ROBOT DID IT. NEXT THING?'],
  idle_ask: ['VOICE? WHAT ROBOT DO?', 'ROBOT IS BORED. GIVE JOB.', 'ROBOT WAITS. ROBOT IS GOOD AT WAITING.'],
  banter: [
    'HMM HMM HMM. HM.',
    'ROBOT THINKS ABOUT SOUP.',
    'ROBOT IS STILL HERE. STILL GREAT.',
    'ROBOT COUNTED THE DUST. TWELVE.',
    'LA LA. ROBOT SINGS. BEAUTIFUL.',
    'ROBOT INVENTED A NEW NUMBER.',
    'THIS WALL IS ROBOT FRIEND NOW.',
  ],
};

/**
 * A line without a model. Also the natural place to keep the ONE piece of
 * initiative the keyless build still needs: an idle robot must be able to point
 * at something, or a player with no API key gets a companion that only ever
 * says "give job" and never suggests what.
 */
export function localSay(req: SayRequest): SayResponse {
  const pool = LOCAL_LINES[req.trigger] ?? LOCAL_LINES.banter;
  // Avoid immediately repeating whatever is still on screen.
  const said = new Set(req.recent.map((l) => l.replace(/^ROBOT:\s*/i, '').trim().toUpperCase()));
  const fresh = pool.filter((l) => !said.has(l));
  const line = (fresh.length > 0 ? fresh : pool)[Math.floor(Math.random() * (fresh.length || pool.length))];
  const out: SayResponse = { line, source: 'local' };
  if (req.trigger === 'idle_ask' || req.trigger === 'arrived') {
    out.question = true;
    const interesting =
      req.entities.find((e) => e.kind === 'crate') ??
      req.entities.find((e) => e.kind === 'chip') ??
      req.entities.find((e) => e.kind === 'fuse') ??
      req.entities.find((e) => e.kind === 'scrap');
    if (interesting) out.proposal = { intent: 'goto', target: interesting.id };
    else {
      const lift = req.entities.find((e) => e.kind === 'elevatorB');
      if (lift && !req.carrying) out.proposal = { intent: 'enter_elevator', target: lift.id };
      else out.proposal = { intent: 'explore' };
    }
  }
  return out;
}

// ---------------------------------------------------------------- llm path

function extractJson(content: string): unknown {
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function sayWithLlm(req: SayRequest): Promise<SayResponse | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SAY_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        models: FALLBACK_MODELS,
        // Hotter than the parser on purpose: this channel has no correct
        // answer to get wrong, and repetition is its only real failure mode.
        temperature: 1.0,
        max_tokens: 300,
        response_format: RESPONSE_FORMAT,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(req) },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) return null;
    const raw = extractJson(content);
    return raw === null ? null : toSayResponse(raw, req);
  } catch {
    return null; // network/timeout/abort — the bank covers us
  } finally {
    clearTimeout(timer);
  }
}

export async function sayLine(req: SayRequest): Promise<SayResponse> {
  return (await sayWithLlm(req)) ?? localSay(req);
}

// Re-exported so the route can validate without reaching into schema.ts twice.
export { sayOutputSchema };
