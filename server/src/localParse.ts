/**
 * Fail-soft keyword parser (source:'local'). The LLM path is the real game;
 * this keeps /api/parse answering when keys are missing, the model times out,
 * or it returns garbage twice. Same heuristics family as the client fallback.
 * Every ack obeys the toddler-speak bible: third person, ≤7 words, UPPERCASE.
 */

import { CHIPS } from '../../shared/content';
import type { ChipId, Dir, ParsedCommand, ParseEntity, ParseRequest } from '../../shared/types';

const DIR_WORDS: Record<string, Dir> = {
  left: 'left',
  west: 'left',
  right: 'right',
  east: 'right',
  up: 'up',
  north: 'up',
  forward: 'up',
  forwards: 'up',
  ahead: 'up',
  down: 'down',
  south: 'down',
  back: 'down',
  backward: 'down',
  backwards: 'down',
};

const STOP_WORDS = ['stop', 'halt', 'wait', 'freeze', 'stay', 'whoa', 'woah', 'brake'];
const SHOOT_WORDS = ['shoot', 'fire', 'pew', 'blast', 'attack', 'kill'];
const ATTACK_VERBS = ['attack', 'kill', 'shoot', 'fire', 'destroy', 'fight', 'smash', 'blast', 'zap'];
const PICKUP_VERBS = ['pick', 'grab', 'take', 'get', 'fetch', 'collect', 'carry'];
const GOTO_VERBS = ['go', 'goto', 'walk', 'drive', 'move', 'head', 'roll', 'come', 'approach', 'find'];
const ENTER_WORDS = ['enter', 'elevator', 'lift', 'exit', 'leave', 'ride'];
const INSULT_WORDS = [
  'stupid', 'dumb', 'idiot', 'useless', 'trash', 'garbage', 'worst',
  'suck', 'sucks', 'hate', 'terrible', 'awful', 'bad',
];
const INDIFFERENT = [
  'whatever', 'dont care', 'any', 'anything', 'you pick', 'you choose',
  'you decide', 'surprise', 'yolo', 'dunno', 'idk', 'either', 'random', 'shrug',
];
const GREETINGS = ['hello', 'hi', 'hey', 'yo', 'howdy', 'sup'];
const PRAISE = ['good', 'nice', 'great', 'awesome', 'amazing', 'love', 'best'];
const QUESTION_WORDS = ['what', 'who', 'where', 'why', 'how'];

/** Descriptor → chip, for "the angry one" style picks. */
const CHIP_HINTS: Record<ChipId, string[]> = {
  MAGNET: ['magnet', 'shiny', 'loot', 'money', 'greedy', 'hoarder'],
  RAGE: ['rage', 'angry', 'mad', 'mean', 'red', 'spicy'],
  SCARED: ['scared', 'coward', 'chicken', 'runner', 'fast'],
  MEMORY: ['memory', 'remember', 'remembers', 'brain'],
  ZAP: ['zap', 'pew', 'gun', 'damage', 'firepower'],
  TOUGH: ['tough', 'strong', 'tank', 'armor', 'hard'],
};

/** Position words → triad slot ('one' deliberately absent: "the right one" must hit 'right'). */
const ORDINALS: Array<{ words: string[]; index: number }> = [
  { words: ['first', '1', 'left'], index: 0 },
  { words: ['second', 'middle', '2'], index: 1 },
  { words: ['third', 'last', '3', 'right'], index: 2 },
];

const NAME_FILLER = new Set([
  'name', 'is', 'him', 'her', 'it', 'call', 'called', 'you', 'your', 'are',
  'the', 'a', 'an', 'will', 'be', 'shall', 'lets', 'let', 'we', 'i', 'want',
  'to', 'ok', 'okay', 'um', 'uh', 'please', 'now', 'my', 'his',
]);
const NAME_REFUSE = ['no', 'nope', 'nothing', 'dont', 'whatever', 'skip', 'none', 'idk', 'dunno'];

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function has(toks: string[], words: string[]): boolean {
  return toks.some((t) => words.includes(t));
}

function matchEntity(toks: string[], entities: ParseEntity[]): ParseEntity | null {
  let best: ParseEntity | null = null;
  let bestScore = 0;
  for (const e of entities) {
    const labelToks = norm(e.label)
      .split(' ')
      .filter((t) => t && !['the', 'a', 'an'].includes(t));
    let score = 0;
    for (const lt of labelToks) {
      const singular = lt.endsWith('s') ? lt.slice(0, -1) : null;
      if (toks.includes(lt) || toks.includes(`${lt}s`) || (singular && toks.includes(singular))) {
        score += 1;
      }
    }
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

/** Last meaningful label word, for acks ("the angry crate" → CRATE). */
function labelWord(e: ParseEntity): string {
  const words = norm(e.label)
    .split(' ')
    .filter((t) => t && !['the', 'a', 'an'].includes(t));
  return (words[words.length - 1] ?? e.kind).toUpperCase();
}

function parseName(toks: string[]): ParsedCommand {
  const candidates = toks.filter((t) => !NAME_FILLER.has(t));
  const refused =
    candidates.length === 0 ||
    (candidates.length <= 2 && candidates.every((t) => NAME_REFUSE.includes(t)));
  if (refused) {
    return { intent: 'name_robot', name: 'Robot', ack_line: 'ROBOT NAMES ROBOT: ROBOT.' };
  }
  const raw = candidates[candidates.length - 1];
  const name = raw.charAt(0).toUpperCase() + raw.slice(1);
  const up = name.toUpperCase();
  return { intent: 'name_robot', name, ack_line: `ROBOT IS ${up}. ${up} IS GOOD.` };
}

function parseTriad(text: string, toks: string[], options: ChipId[], name: string): ParsedCommand {
  if (INDIFFERENT.some((p) => text.includes(p))) {
    return { intent: 'robot_choice', ack_line: `${name} PICKS. ${name} HAS TASTE.` };
  }
  const choose = (choice: ChipId): ParsedCommand => ({
    intent: 'choose',
    choice,
    ack_line: `${name} TAKES ${CHIPS[choice].spoken.toUpperCase()}. GOOD CRATE.`,
  });
  // Naming law fast path: the exact spoken word wins.
  for (const opt of options) if (toks.includes(CHIPS[opt].spoken)) return choose(opt);
  for (const opt of options) if (has(toks, CHIP_HINTS[opt])) return choose(opt);
  for (const ord of ORDINALS) {
    const picked = options[ord.index];
    if (picked && has(toks, ord.words)) return choose(picked);
  }
  return { intent: 'clarify', ack_line: `${name} READS AGAIN. LISTEN BETTER.` };
}

export function serverLocalParse(req: ParseRequest): ParsedCommand {
  const text = norm(req.utterance);
  const toks = text.split(' ').filter(Boolean);
  const name = (req.robotName ?? 'ROBOT').toUpperCase();
  const insult = has(toks, INSULT_WORDS);
  const done = (cmd: ParsedCommand): ParsedCommand => {
    if (insult) cmd.insult = true;
    cmd.source = 'local';
    return cmd;
  };

  if (req.awaitingName) return done(parseName(toks));
  if (req.options && req.options.length > 0) return done(parseTriad(text, toks, req.options, name));

  if (has(toks, STOP_WORDS)) {
    return done({ intent: 'stop', ack_line: `${name} STOPS. STOPPING IS EASY.` });
  }

  const dir = toks.map((t) => DIR_WORDS[t]).find((d): d is Dir => Boolean(d));
  if (dir) {
    const tail = req.shouted ? 'FAST FAST.' : 'ZOOM.';
    return done({ intent: 'move', dir, ack_line: `${name} GOES ${dir.toUpperCase()}. ${tail}` });
  }

  if (req.tier >= 1) {
    if (has(toks, ENTER_WORDS)) {
      const elev =
        req.entities.find((e) => e.kind === 'elevatorB') ??
        req.entities.find((e) => e.label.toLowerCase().includes('elevator'));
      if (elev) {
        return done({
          intent: 'enter_elevator',
          target: elev.id,
          ack_line: `${name} RIDES ELEVATOR. UP IS GOOD.`,
        });
      }
    }
    const target = matchEntity(toks, req.entities);
    if (target) {
      const word = labelWord(target);
      if (has(toks, ATTACK_VERBS)) {
        return done({ intent: 'attack', target: target.id, ack_line: `${name} FIGHTS ${word}. PEW PEW.` });
      }
      if (has(toks, PICKUP_VERBS)) {
        return done({ intent: 'pickup', target: target.id, ack_line: `${name} GRABS ${word}. YES.` });
      }
      return done({ intent: 'goto', target: target.id, ack_line: `${name} GOES TO ${word}. ZOOM.` });
    }
  }

  if (has(toks, SHOOT_WORDS)) return done({ intent: 'shoot', ack_line: 'PEW PEW.' });

  // Tier 0 hearing target-language it cannot grasp yet — that's the joke.
  if (req.tier === 0 && (has(toks, GOTO_VERBS) || has(toks, ATTACK_VERBS) || has(toks, PICKUP_VERBS))) {
    return done({ intent: 'clarify', ack_line: `${name} HEARD BIG WORDS. TRY LEFT?` });
  }

  if (insult) return done({ intent: 'chatter', ack_line: 'VOICE IS MEAN. ROBOT SULKS NOW.' });
  if (has(toks, GREETINGS)) return done({ intent: 'chatter', ack_line: `HELLO VOICE. ${name} IS HERE.` });
  if (has(toks, PRAISE)) return done({ intent: 'chatter', ack_line: `${name} KNOWS. ${name} IS GREAT.` });
  if (has(toks, QUESTION_WORDS)) {
    return done({ intent: 'chatter', ack_line: `${name} SEES DARK. AND ${name}.` });
  }
  // Real words we just don't understand: ADMIT it, naming what we heard.
  // "VOICE IS MUMBLY" is reserved for genuinely empty/garbled input — an
  // unknown command answered with "mumbly" reads as broken, not funny.
  const salient = [...toks].sort((a, b) => b.length - a.length)[0];
  return done({
    intent: 'clarify',
    ack_line: salient ? `${name} NOT KNOW ${salient.toUpperCase()}.` : 'VOICE IS MUMBLY. AGAIN?',
  });
}
