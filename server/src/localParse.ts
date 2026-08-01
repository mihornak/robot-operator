/**
 * Fail-soft keyword parser (source:'local'). The LLM path is the real game;
 * this keeps /api/parse answering when keys are missing, the model times out,
 * or it returns garbage twice. Same heuristics family as the client fallback.
 * Every ack obeys the toddler-speak bible: third person, ≤7 words, UPPERCASE.
 */

import { CHIPS } from '../../shared/content';
import type {
  ChipId,
  Dir,
  IntentType,
  ParsedCommand,
  ParseEntity,
  ParseRequest,
} from '../../shared/types';

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
/** Nudge magnitudes: "a bit"-family → 'bit', "one step"-family → 'step'. */
const BIT_WORDS = ['bit', 'little', 'slightly', 'touch', 'tad', 'smidge'];
const STEP_WORDS = ['step', 'steps'];
const HELP_PHRASES = [
  'what can you do',
  'what do you know',
  'how does this work',
  'what do you do',
  'what can robot do',
];
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

// --- BRAIN vocabulary (norm() strips apostrophes: "don't" arrives as "dont") ---
const HIDE_WORDS = ['hide', 'hides', 'hiding', 'cover', 'vanish'];
const HIDE_PHRASES = ['take cover', 'get behind', 'go behind'];
const AVOID_WORDS = ['avoid', 'avoids'];
const AVOID_PHRASES = ['stay away', 'keep away', 'dont touch', 'dont go near', 'stay clear', 'steer clear'];
const CAREFUL_WORDS = [
  'sneak', 'sneaks', 'sneaky', 'careful', 'carefully', 'quiet', 'quietly', 'slowly', 'gently', 'cautious',
];
/** "X then Y" / "X and then Y" splitter (text is norm()'d — no punctuation). */
const THEN_SPLIT = /\s(?:and\s+)?then\s/;
/** Intents a BRAIN chain may hold (commands only, no meta). */
const CHAINABLE = new Set<IntentType>([
  'move', 'stop', 'shoot', 'goto', 'attack', 'pickup', 'enter_elevator', 'hide', 'avoid',
]);

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
  // Ceremony help: the robot's one ability right now is choosing.
  if (toks.includes('help') || HELP_PHRASES.some((p) => text.includes(p))) {
    return { intent: 'chatter', ack_line: `${name} CHOOSES NOW. SAY CRATE WORD.` };
  }
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

/**
 * One command, BRAIN-aware. depth 0 may split ONE "X then Y" chain via a
 * single recursive self-call at depth 1 (a third step is dropped, admitted).
 */
function interpretCommand(text: string, req: ParseRequest, name: string, depth: number): ParsedCommand {
  if (depth === 0) {
    const parts = text.split(THEN_SPLIT).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      if (!req.brain) return { intent: 'clarify', ack_line: 'PLANS NEED BIGGER BRAIN.' };
      const primary = interpretCommand(parts[0], req, name, 1);
      if (!CHAINABLE.has(primary.intent)) return primary;
      const second = interpretCommand(parts[1], req, name, 1);
      if (!CHAINABLE.has(second.intent)) return primary;
      primary.then = second;
      primary.ack_line =
        parts.length > 2 ? `${name} HOLDS TWO IDEAS ONLY.` : `${name} HAS PLAN. TWO STEPS.`;
      return primary;
    }
  }

  const toks = text.split(' ').filter(Boolean);
  const hideAsk = has(toks, HIDE_WORDS) || HIDE_PHRASES.some((p) => text.includes(p));
  const avoidAsk = has(toks, AVOID_WORDS) || AVOID_PHRASES.some((p) => text.includes(p));
  const carefulAsk = has(toks, CAREFUL_WORDS);

  // No BRAIN yet: name the limitation, crystal clear.
  if (!req.brain && (hideAsk || avoidAsk || carefulAsk)) {
    const word = hideAsk ? 'HIDE' : avoidAsk ? 'AVOID' : 'SNEAK';
    return { intent: 'clarify', ack_line: `${word}? ${name} BRAIN TOO SMALL.` };
  }

  if (req.brain && avoidAsk) {
    const target = matchEntity(toks, req.entities);
    if (target) {
      return {
        intent: 'avoid',
        target: target.id,
        ack_line: `${name} AVOIDS ${labelWord(target)}. FOREVER.`,
      };
    }
    return { intent: 'clarify', ack_line: `${name} AVOIDS WHAT? SAY THING.` };
  }
  if (req.brain && hideAsk) {
    return { intent: 'hide', ack_line: `${name} HIDES NOW. NOBODY SEES ${name}.` };
  }

  const cmd = basicCommand(text, toks, req, name);
  // careful (BRAIN) rides on movement-ish commands only.
  if (
    req.brain &&
    carefulAsk &&
    (cmd.intent === 'move' || cmd.intent === 'goto' || cmd.intent === 'pickup')
  ) {
    cmd.careful = true;
    cmd.ack_line = `${name} SNEAKS. VERY QUIET.`;
  }
  return cmd;
}

/** Pre-BRAIN heuristics (dir/stop/help/targets/shoot/chatter), unchanged family. */
function basicCommand(text: string, toks: string[], req: ParseRequest, name: string): ParsedCommand {
  const insult = has(toks, INSULT_WORDS);
  const dir = toks.map((t) => DIR_WORDS[t]).find((d): d is Dir => Boolean(d));
  const amount = has(toks, STEP_WORDS) ? ('step' as const) : has(toks, BIT_WORDS) ? ('bit' as const) : undefined;

  // "go left a bit and stop" is ONE nudge (the move halts itself) — nudge beats the stop word.
  if (dir && amount) {
    return { intent: 'move', dir, amount, ack_line: `${name} GOES ${dir.toUpperCase()}. SMALL ZOOM.` };
  }

  if (has(toks, STOP_WORDS)) {
    return { intent: 'stop', ack_line: `${name} STOPS. STOPPING IS EASY.` };
  }

  if (dir) {
    const tail = req.shouted ? 'FAST FAST.' : 'ZOOM.';
    return { intent: 'move', dir, ack_line: `${name} GOES ${dir.toUpperCase()}. ${tail}` };
  }

  // Help: proud capability listing, tier- and brain-appropriate.
  if (
    HELP_PHRASES.some((p) => text.includes(p)) ||
    (toks.includes('help') && !has(toks, GOTO_VERBS) && !has(toks, PICKUP_VERBS) && !has(toks, ATTACK_VERBS))
  ) {
    return {
      intent: 'chatter',
      ack_line: req.brain
        ? `${name} HIDES. AVOIDS. SNEAKS. MAKES PLANS.`
        : req.tier >= 1
          ? `${name} GOES TO THINGS. SAY THING.`
          : `${name} KNOWS GO, STOP, SHOOT.`,
    };
  }

  if (req.tier >= 1) {
    if (has(toks, ENTER_WORDS)) {
      const elev =
        req.entities.find((e) => e.kind === 'elevatorB') ??
        req.entities.find((e) => e.label.toLowerCase().includes('elevator'));
      if (elev) {
        return {
          intent: 'enter_elevator',
          target: elev.id,
          ack_line: `${name} RIDES ELEVATOR. UP IS GOOD.`,
        };
      }
    }
    const target = matchEntity(toks, req.entities);
    if (target) {
      const word = labelWord(target);
      if (has(toks, ATTACK_VERBS)) {
        return { intent: 'attack', target: target.id, ack_line: `${name} FIGHTS ${word}. PEW PEW.` };
      }
      if (has(toks, PICKUP_VERBS)) {
        return { intent: 'pickup', target: target.id, ack_line: `${name} GRABS ${word}. YES.` };
      }
      return { intent: 'goto', target: target.id, ack_line: `${name} GOES TO ${word}. ZOOM.` };
    }
  }

  if (has(toks, SHOOT_WORDS)) return { intent: 'shoot', ack_line: 'PEW PEW.' };

  // Tier 0 hearing target-language it cannot grasp yet — that's the joke.
  if (req.tier === 0 && (has(toks, GOTO_VERBS) || has(toks, ATTACK_VERBS) || has(toks, PICKUP_VERBS))) {
    return { intent: 'clarify', ack_line: `${name} HEARD BIG WORDS. TRY LEFT?` };
  }

  if (insult) return { intent: 'chatter', ack_line: 'VOICE IS MEAN. ROBOT SULKS NOW.' };
  if (has(toks, GREETINGS)) return { intent: 'chatter', ack_line: `HELLO VOICE. ${name} IS HERE.` };
  if (has(toks, PRAISE)) return { intent: 'chatter', ack_line: `${name} KNOWS. ${name} IS GREAT.` };
  if (has(toks, QUESTION_WORDS)) {
    return { intent: 'chatter', ack_line: `${name} SEES DARK. AND ${name}.` };
  }
  // Real words we just don't understand: ADMIT it, naming what we heard.
  // "VOICE IS MUMBLY" is reserved for genuinely empty/garbled input — an
  // unknown command answered with "mumbly" reads as broken, not funny.
  const salient = [...toks].sort((a, b) => b.length - a.length)[0];
  return {
    intent: 'clarify',
    ack_line: salient ? `${name} NOT KNOW ${salient.toUpperCase()}.` : 'VOICE IS MUMBLY. AGAIN?',
  };
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

  return done(interpretCommand(text, req, name, 0));
}
