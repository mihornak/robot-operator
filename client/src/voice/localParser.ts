/**
 * Zero-keys fail-soft parser. Keyword matching only — the LLM path
 * (/api/parse) is the real interpreter; this keeps the game playable with the
 * server down. ack_lines follow the toddler-speak bible: third person,
 * ≤7 words per sentence, uppercase, overconfident.
 */

import type { ChipId, Dir, EarsTier, ParseEntity, ParsedCommand, Utterance } from '@shared/types';
import { CHIPS } from '@shared/content';

export interface LocalParseCtx {
  tier: EarsTier;
  options: ChipId[] | null;
  awaitingName: boolean;
  entities: ParseEntity[];
}

// ---------------------------------------------------------------- wordlists

const DIR_WORDS: Record<string, Dir> = {
  up: 'up',
  north: 'up',
  forward: 'up',
  forwards: 'up',
  top: 'up',
  down: 'down',
  south: 'down',
  back: 'down',
  backward: 'down',
  backwards: 'down',
  bottom: 'down',
  left: 'left',
  west: 'left',
  right: 'right',
  east: 'right',
};

const STOPS = new Set(['stop', 'halt', 'wait', 'stay', 'freeze', 'whoa', 'woah', 'no']);
const SHOOTS = new Set(['shoot', 'fire', 'pew', 'blast', 'attack', 'kill', 'zap', 'shot']);
const ATTACK_VERBS = SHOOTS;
const PICKUP_VERBS = new Set(['get', 'grab', 'take', 'fetch', 'pick', 'collect', 'carry']);
const GOTO_VERBS = new Set(['go', 'goto', 'walk', 'drive', 'roll', 'move', 'run', 'head']);
const INSULTS = new Set([
  'stupid',
  'dumb',
  'idiot',
  'useless',
  'hate',
  'suck',
  'sucks',
  'moron',
  'trash',
  'garbage',
  'worst',
]);
const REFUSE = new Set(['no', 'nope', 'nah', 'never', 'nothing']);
const NAME_FILLER = new Set([
  'your',
  'name',
  'is',
  'you',
  'are',
  'youre',
  'call',
  'called',
  'him',
  'her',
  'it',
  'the',
  'a',
  'an',
  'i',
  'will',
  'ill',
  'shall',
  'be',
  'ok',
  'okay',
  'um',
  'uh',
]);
const LABEL_FILLER = new Set(['the', 'a', 'an', 'to', 'at', 'of', 'one']);
const INDIFFERENT = [
  'whatever',
  'dont care',
  'dont know',
  'no idea',
  'dunno',
  'you pick',
  'you choose',
  'you decide',
  'your pick',
  'anything',
  'surprise me',
  'yolo',
  'idc',
];
const ORDINALS: Record<string, number> = {
  first: 0,
  one: 0,
  '1': 0,
  second: 1,
  two: 1,
  '2': 1,
  middle: 1,
  third: 2,
  three: 2,
  '3': 2,
  last: 2,
};
/** Bare number words are picks only in terse utterances or after "number". */
const NUMBER_WORDS = new Set(['one', 'two', 'three']);
/** Nudge magnitudes: "a bit"-family → 'bit', "one step"-family → 'step'. */
const BIT_WORDS = new Set(['bit', 'little', 'slightly', 'touch', 'tad', 'smidge']);
const STEP_WORDS = new Set(['step', 'steps']);
const HELP_PHRASES = [
  'what can you do',
  'what do you know',
  'how does this work',
  'what do you do',
  'what can robot do',
];
/** norm() strips apostrophes, so "don't" arrives as "dont". */
const NEGATIONS = new Set(['dont', 'not', 'never', 'no']);

// ---------------------------------------------------------------- helpers

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isIndifferent(text: string): boolean {
  return INDIFFERENT.some((p) => text.includes(p));
}

function ordinalIndex(tokens: string[]): number | null {
  for (let i = 0; i < tokens.length; i++) {
    const idx = ORDINALS[tokens[i]];
    if (idx === undefined) continue;
    // "the shiny one" must not read as FIRST
    if (NUMBER_WORDS.has(tokens[i]) && tokens.length > 2 && tokens[i - 1] !== 'number') continue;
    return idx;
  }
  return null;
}

/** Best label-token overlap; exact or 4+-char prefix hits only. */
function matchEntity(tokens: string[], entities: ParseEntity[]): ParseEntity | null {
  let best: ParseEntity | null = null;
  let bestScore = 0;
  for (const e of entities) {
    const labelTokens = norm(e.label)
      .split(' ')
      .filter((w) => w.length > 2 && !LABEL_FILLER.has(w));
    let score = 0;
    for (const lt of labelTokens) {
      for (const t of tokens) {
        if (t.length < 3) continue;
        if (t === lt) score += 2;
        else if ((lt.length >= 4 && t.startsWith(lt)) || (t.length >= 4 && lt.startsWith(t)))
          score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

function entLabel(e: ParseEntity): string {
  return norm(e.label).replace(/^the /, '').toUpperCase();
}

function cap(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// ---------------------------------------------------------------- parser

export function parseLocal(utterance: Utterance | string, ctx: LocalParseCtx): ParsedCommand {
  const text = norm(typeof utterance === 'string' ? utterance : utterance.text);
  const tokens = text.length > 0 ? text.split(' ') : [];
  const insult = tokens.some((t) => INSULTS.has(t));
  const base = interpret(text, tokens, ctx, insult);
  return { ...base, ...(insult ? { insult: true } : {}), source: 'local' };
}

function interpret(
  text: string,
  tokens: string[],
  ctx: LocalParseCtx,
  insult: boolean,
): ParsedCommand {
  // naming beat — refusal/indifference means the robot names itself
  if (ctx.awaitingName) {
    if (!text || tokens.some((t) => REFUSE.has(t)) || isIndifferent(text)) {
      return { intent: 'name_robot', name: 'Robot', ack_line: 'ROBOT NAMES ROBOT: ROBOT.' };
    }
    const words = tokens.filter((t) => !NAME_FILLER.has(t)).slice(0, 2);
    if (words.length === 0) {
      return { intent: 'name_robot', name: 'Robot', ack_line: 'ROBOT NAMES ROBOT: ROBOT.' };
    }
    const name = words.map(cap).join(' ');
    const up = name.toUpperCase();
    return { intent: 'name_robot', name, ack_line: `ROBOT IS ${up}. ${up} IS GOOD.` };
  }

  if (!text) return { intent: 'clarify', ack_line: 'VOICE IS MUMBLY. AGAIN?' };

  // triad ceremony: chip names, ordinals, indifference
  if (ctx.options && ctx.options.length > 0) {
    // ceremony help: the robot's one ability right now is choosing
    if (tokens.includes('help') || HELP_PHRASES.some((p) => text.includes(p))) {
      return { intent: 'chatter', ack_line: 'ROBOT CHOOSES NOW. SAY CRATE WORD.' };
    }
    for (const c of ctx.options) {
      const spoken = CHIPS[c].spoken;
      if (tokens.some((t) => t === spoken || t.startsWith(spoken) || (t.length > 2 && spoken.startsWith(t)))) {
        return { intent: 'choose', choice: c, ack_line: `ROBOT PICKS ${spoken.toUpperCase()}.` };
      }
    }
    const ord = ordinalIndex(tokens);
    if (ord !== null && ord < ctx.options.length) {
      const c = ctx.options[ord];
      return { intent: 'choose', choice: c, ack_line: `ROBOT PICKS ${CHIPS[c].spoken.toUpperCase()}.` };
    }
    if (isIndifferent(text)) {
      return { intent: 'robot_choice', ack_line: 'ROBOT PICKS. ROBOT HAS TASTE.' };
    }
    // ceremony wants a pick — anything unresolvable is an ask-again
    return { intent: 'clarify', ack_line: 'ROBOT READS AGAIN. LISTEN BETTER.' };
  }

  // negated verb/dir ("dont go left") must not execute as the command itself.
  // STOPS deliberately excluded: "no no stop" must still stop.
  const negIdx = tokens.findIndex((t) => NEGATIONS.has(t));
  if (
    negIdx !== -1 &&
    tokens
      .slice(negIdx + 1)
      .some((t) => DIR_WORDS[t] !== undefined || SHOOTS.has(t) || GOTO_VERBS.has(t) || PICKUP_VERBS.has(t))
  ) {
    return { intent: 'clarify', ack_line: 'ROBOT HEARD NO-GO. WHICH WAY?' };
  }

  const dir = tokens.map((t) => DIR_WORDS[t]).find((d): d is Dir => d !== undefined);
  const amount = tokens.some((t) => STEP_WORDS.has(t))
    ? ('step' as const)
    : tokens.some((t) => BIT_WORDS.has(t))
      ? ('bit' as const)
      : undefined;

  // "go left a bit and stop" is ONE nudge (the move halts itself) — nudge beats the stop word.
  if (dir && amount) {
    return { intent: 'move', dir, amount, ack_line: `ROBOT GOES ${dir.toUpperCase()}. SMALL GO.` };
  }

  if (tokens.some((t) => STOPS.has(t))) return { intent: 'stop', ack_line: 'ROBOT STOPS.' };

  if (dir) return { intent: 'move', dir, ack_line: `ROBOT GOES ${dir.toUpperCase()}.` };

  // help: proud capability listing, tier-appropriate
  if (
    HELP_PHRASES.some((p) => text.includes(p)) ||
    (tokens.includes('help') &&
      !tokens.some((t) => GOTO_VERBS.has(t) || PICKUP_VERBS.has(t) || ATTACK_VERBS.has(t)))
  ) {
    return {
      intent: 'chatter',
      ack_line: ctx.tier >= 1 ? 'ROBOT GOES TO THINGS. SAY THING.' : 'ROBOT KNOWS GO, STOP, SHOOT.',
    };
  }

  // tier 1+: named targets
  if (ctx.tier >= 1) {
    const ent = matchEntity(tokens, ctx.entities);
    if (ent) {
      if (ent.kind === 'elevatorA' || ent.kind === 'elevatorB') {
        return { intent: 'enter_elevator', target: ent.id, ack_line: 'ROBOT ENTERS ELEVATOR.' };
      }
      const label = entLabel(ent);
      if (tokens.some((t) => ATTACK_VERBS.has(t))) {
        return { intent: 'attack', target: ent.id, ack_line: `ROBOT SHOOTS ${label}.` };
      }
      if (tokens.some((t) => PICKUP_VERBS.has(t)) || ent.kind === 'scrap' || ent.kind === 'fuse') {
        return { intent: 'pickup', target: ent.id, ack_line: `ROBOT GETS ${label}.` };
      }
      return { intent: 'goto', target: ent.id, ack_line: `ROBOT GOES TO ${label}.` };
    }
  }

  if (tokens.some((t) => SHOOTS.has(t))) {
    return { intent: 'shoot', ack_line: 'ROBOT SHOOTS. PEW PEW.' };
  }

  // elevator works at any tier (tier 0 floor 1 must be finishable)
  if (tokens.includes('elevator') || tokens.includes('lift')) {
    const elev =
      ctx.entities.find((e) => e.kind === 'elevatorB') ??
      ctx.entities.find((e) => e.kind === 'elevatorA');
    if (elev) {
      return { intent: 'enter_elevator', target: elev.id, ack_line: 'ROBOT ENTERS ELEVATOR.' };
    }
  }

  // target-ish verb with nothing resolvable → in-character ask-again
  if (tokens.some((t) => GOTO_VERBS.has(t) || PICKUP_VERBS.has(t))) {
    if (ctx.tier >= 1) return { intent: 'clarify', ack_line: 'ROBOT SEES NO THING. WHICH THING?' };
    // Tier 0: name the unknown word — the limitation must be crystal clear.
    const noise = new Set(['the', 'a', 'an', 'to', 'go', 'at', 'that', 'this', 'it', 'over']);
    const noun = [...tokens]
      .reverse()
      .find((t) => !noise.has(t) && !GOTO_VERBS.has(t) && !PICKUP_VERBS.has(t));
    return {
      intent: 'clarify',
      ack_line: noun ? `ROBOT NOT KNOW ${noun.toUpperCase()}.` : 'ROBOT HEARD MAYBE-GO. WHICH WAY?',
    };
  }

  if (insult) return { intent: 'chatter', ack_line: 'VOICE IS MEAN. ROBOT SULKS NOW.' };
  return { intent: 'chatter', ack_line: 'ROBOT HEARS VOICE. ROBOT WAITS.' };
}
