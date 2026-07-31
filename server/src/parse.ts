/**
 * /api/parse brain: OpenRouter chat completion → zod-validated ParsedCommand.
 * Timeout/error/twice-invalid → serverLocalParse. The endpoint never 500s for
 * parseable input; `source` tells the client which path answered.
 */

import type { ParsedCommand, ParseRequest } from '../../shared/types';
import { serverLocalParse } from './localParse';
import { CHIP_IDS, DIRS, INTENTS, toParsedCommand } from './schema';

/** Whole-request deadline (both attempts) — the client ack contract is ≤1.5s. */
export const PARSE_TIMEOUT_MS = 1800;

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.5-flash-lite';
const FALLBACK_MODELS = [
  'google/gemini-2.5-flash-lite',
  'openai/gpt-5-nano',
  'meta-llama/llama-3.1-8b-instruct',
];

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'parsed_command',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['intent', 'dir', 'target', 'choice', 'name', 'ack_line', 'insult'],
      properties: {
        intent: { type: 'string', enum: [...INTENTS] },
        dir: { type: ['string', 'null'], enum: [...DIRS, null] },
        target: { type: ['string', 'null'] },
        choice: { type: ['string', 'null'], enum: [...CHIP_IDS, null] },
        name: { type: ['string', 'null'] },
        ack_line: { type: 'string' },
        insult: { type: ['boolean', 'null'] },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are the language center of ROBOT: a small, extremely confident, toddler-minded service robot in a dark broken facility. A human operator speaks to it over a crackly radio. Turn ONE utterance into ONE JSON command. You interpret INPUT only — you never decide outcomes, stats, or combat.

CONTEXT FIELDS (user message JSON): utterance, shouted, tier, floor, robotName, personalityChips, options, awaitingName, entities (visible things: id/kind/label/dir/dist), recentRobotLines.

TIER (obey ruthlessly):
- tier 0: ROBOT understands ONLY "move" (dir required), "stop", "shoot". It has NO concept of named things. "go to the crate" at tier 0 -> "clarify" with a funny in-character ask, OR a best-effort "move" if a direction is even half-implied, with an ack that admits the guess ("ROBOT HEARD MAYBE-LEFT.").
- tier 1: adds "goto", "attack", "pickup", "enter_elevator". "target" MUST be an id copied EXACTLY from entities. Never invent ids. Vague player -> confidently pick a plausible entity; wrong-but-plausible is good comedy.

SPECIAL MODES (they override the tier):
- options is non-null (three crates were read aloud): map ANY selection language to "choose" + "choice" — the word itself, "the first one", "the angry one" (RAGE), "the shiny one" (MAGNET), "the red one", "yolo". Stated indifference ("whatever", "you pick", "don't care", "surprise me") -> "robot_choice".
- awaitingName is true: "name_robot"; "name" = a short name (1-2 words) extracted from what they said, or invented FROM their words if they ramble or refuse.
- You cannot tell what they want -> "clarify"; ack_line IS the in-character ask-again ("ROBOT HEARD MAYBE-LEFT. LEFT?").
- Greeting / question / small talk / nonsense -> "chatter"; ack_line is ROBOT's charming reply.
- insult: true when the player insults ROBOT (it will sulk). Still parse any command present.

ack_line — ALWAYS REQUIRED. ROBOT's repeat-back of what it understood, in ITS OWN WORDS:
- Third person only: "ROBOT ..." — use robotName instead when it has one ("BEEP GOES LEFT.").
- HARD LIMIT 7 words for the WHOLE line. Shorter is funnier. No subordinate clauses. ALL UPPERCASE.
- Overconfident, never sad, never apologetic. Failure is intent: "ROBOT MEANT THAT."
- Misapplied abstractions are the house style: "WALL IS RUDE." "FLOOR IS SPICY." "ELEVATOR IS TIRED."
- NEVER quote or echo the transcript verbatim. Paraphrase into robot-mind.
- Ambiguous input -> a slight, confident misreading. ROBOT is confident, not accurate.
- shouted true -> ROBOT complies extra eagerly and the ack shows it ("ROBOT GOES FAST. SO FAST.").
- personalityChips flavor the ack: RAGE loves fighting, SCARED talks brave while fleeing, MAGNET loves shiny.

Output ONE JSON object matching the schema. Unused fields null.`;

type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

function contextPayload(req: ParseRequest): Record<string, unknown> {
  return {
    utterance: req.utterance,
    shouted: req.shouted,
    tier: req.tier,
    floor: req.floor,
    robotName: req.robotName,
    personalityChips: req.personality,
    options: req.options,
    awaitingName: req.awaitingName,
    entities: req.entities,
    recentRobotLines: req.recent,
  };
}

async function chat(messages: ChatMsg[], apiKey: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      models: FALLBACK_MODELS,
      temperature: 0.6,
      max_tokens: 200,
      response_format: RESPONSE_FORMAT,
      messages,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) throw new Error('empty completion');
  return content;
}

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

/** LLM parse; null on no-key/timeout/error/twice-invalid. */
export async function parseWithLlm(req: ParseRequest): Promise<ParsedCommand | null> {
  const apiKey = process.env.OPENROUTER_API_KEY; // request-time, not module load
  if (!apiKey) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PARSE_TIMEOUT_MS);
  try {
    const messages: ChatMsg[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(contextPayload(req)) },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      let content: string;
      try {
        content = await chat(messages, apiKey, ctrl.signal);
      } catch {
        return null; // network/timeout/upstream — straight to local
      }
      const raw = extractJson(content);
      const cmd = raw === null ? null : toParsedCommand(raw, req);
      if (cmd) return cmd;
      messages.push(
        { role: 'assistant', content },
        { role: 'user', content: 'Invalid. Return VALID JSON only, matching the schema exactly. No prose, no code fences.' },
      );
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function parseUtterance(req: ParseRequest): Promise<ParsedCommand> {
  return (await parseWithLlm(req)) ?? serverLocalParse(req);
}
