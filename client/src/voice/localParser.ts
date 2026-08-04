/**
 * Zero-keys fail-soft parser. Keyword matching only — the LLM path
 * (/api/parse) is the real interpreter; this keeps the game playable with the
 * server down. ack_lines follow the toddler-speak bible: third person,
 * ≤7 words per sentence, uppercase, overconfident.
 */

import type {
  ChipId,
  Dir,
  DirectiveKind,
  EarsTier,
  IntentType,
  ParseEntity,
  ParsedCommand,
  PlanStep,
  Utterance,
} from '@shared/types';
import { CHIPS } from '@shared/content';

export interface LocalParseCtx {
  tier: EarsTier;
  options: ChipId[] | null;
  awaitingName: boolean;
  entities: ParseEntity[];
  /** Kept for contract symmetry; true in play — nothing is gated any more. */
  brain?: boolean;
  /** The question ROBOT is waiting on, if any — makes a bare "yes" meaningful. */
  pendingQuestion?: string | null;
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
/**
 * Verb particles wearing a direction's clothes. "hunt them DOWN", "pick it UP",
 * "put it BACK" are orders about a thing, not headings — reading them as a
 * heading marches the robot off across the room, which is the exact failure
 * that makes it look like it wasn't listening.
 */
const PARTICLE_DIRS = new Set(['up', 'down', 'back']);
const PARTICLE_SUBJECTS = new Set(['them', 'it', 'him', 'her', 'those', 'these', 'that', 'things', 'stuff', 'everything']);
/**
 * ...and the particle can sit straight after its verb with no subject at all:
 * "PICK UP the box" is the single most natural way to say it, and reading that
 * `up` as north sent the robot marching away from the most important object on
 * the floor. Motion verbs are deliberately absent — "go up" IS a heading.
 */
const PARTICLE_VERBS = new Set([
  'pick', 'grab', 'take', 'get', 'fetch', 'collect', 'carry', 'lift', 'scoop',
  'put', 'hold', 'hunt', 'track', 'tidy', 'clean', 'pack',
]);
const SHOOTS = new Set(['shoot', 'fire', 'pew', 'blast', 'attack', 'kill', 'zap', 'shot']);
const ATTACK_VERBS = SHOOTS;
const PICKUP_VERBS = new Set(['get', 'grab', 'take', 'fetch', 'pick', 'collect', 'carry']);
const GOTO_VERBS = new Set(['go', 'goto', 'walk', 'drive', 'roll', 'move', 'run', 'head']);
/**
 * Elevator language. Every floor carries TWO of them: `elevatorA` is the dead
 * one the robot arrived in (label "dead elevator behind robot"), `elevatorB`
 * is the exit. Unqualified elevator/lift/exit/door talk ALWAYS means B —
 * walking to A is walking to a door that does nothing, which reads as the
 * parser being broken rather than as a joke.
 */
const ELEVATOR_NOUNS = new Set(['elevator', 'elevators', 'lift', 'lifts', 'exit', 'door', 'doors', 'doorway']);
/** Verbs that mean the elevator, but only when nothing else was named. */
const ELEVATOR_VERBS = new Set(['enter', 'ride', 'board']);
/** The only words that let the player single out the DEAD elevator. */
const DEAD_ELEVATOR_WORDS = new Set([
  'dead', 'broken', 'busted', 'inert', 'dud', 'old', 'first', 'original', 'spawn', 'behind',
]);
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
/**
 * Step counts, including the homophones browser STT reliably produces for
 * them. "go to steps right" is the single most common mistranscription of
 * "go two steps right", and hearing it as a bare direction is exactly the bug
 * where the robot looks like it wasn't listening.
 */
const COUNT_WORDS: Record<string, number> = {
  one: 1, won: 1, a: 1, an: 1, '1': 1,
  two: 2, to: 2, too: 2, tu: 2, '2': 2,
  three: 3, tree: 3, free: 3, '3': 3,
  four: 4, for: 4, fore: 4, '4': 4,
  five: 5, '5': 5,
  six: 6, sicks: 6, '6': 6,
  seven: 7, '7': 7,
  eight: 8, ate: 8, '8': 8,
};
const EXPLORE_WORDS = new Set(['explore', 'exploring', 'wander', 'roam', 'scout', 'adventure']);
const EXPLORE_PHRASES = [
  'look around', 'have a look', 'go see', 'look about', 'check it out',
  'find something', 'see whats there', 'go exploring', 'do whatever', 'your choice',
];
const HELP_PHRASES = [
  'what can you do',
  'what do you know',
  'how does this work',
  'what do you do',
  'what can robot do',
];
/** norm() strips apostrophes, so "don't" arrives as "dont". */
const NEGATIONS = new Set(['dont', 'not', 'never', 'no']);

const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'do', 'please', 'aye']);
const YES_PHRASES = ['do it', 'go on', 'go ahead', 'good idea', 'sounds good', 'why not', 'lets go'];
const NO_WORDS = new Set(['no', 'nope', 'nah', 'dont', 'negative']);
const NO_PHRASES = ['not that', 'no thanks', 'bad idea', 'hold on'];

/** Standing rules of engagement, keyed by the phrase that sets them. The more
 *  specific phrasing must come first within an opposed pair. */
const DIRECTIVE_PHRASES: Array<{ kind: DirectiveKind; any: string[] }> = [
  { kind: 'no_gather', any: ['stop picking', 'no picking', 'dont pick', 'ignore the scrap', 'ignore scrap', 'leave the scrap', 'no looting', 'dont grab'] },
  { kind: 'gather', any: ['pick everything', 'grab everything', 'pick up everything', 'take the scrap', 'grab shiny', 'loot everything', 'collect everything'] },
  { kind: 'avoid_enemies', any: ['avoid the enemies', 'avoid enemies', 'avoid the machines', 'avoid machines', 'avoid the printers', 'avoid printers', 'dont fight', 'no fighting', 'stop fighting', 'stay away from them', 'run away from', 'avoid them', 'dodge them'] },
  // 'fight_enemies' is now "go LOOKING for a fight" (Standing.hunt), not mere
  // self-defence — that is on by default. So the phrases here must all be the
  // aggressive kind; nothing here should fire for "shoot back if they come".
  { kind: 'fight_enemies', any: ['fight everything', 'kill everything', 'shoot everything', 'fight them', 'kill them', 'attack them', 'hunt', 'go get them', 'get them all', 'take them down', 'chase them', 'you can fight', 'stop running', 'shoot them all', 'fight the machines', 'fight machines'] },
  { kind: 'avoid_hazards', any: ['avoid the cable', 'avoid cables', 'watch the floor', 'watch out for the sparks', 'avoid the sparks', 'mind the cables'] },
  { kind: 'ignore_hazards', any: ['ignore the cable', 'ignore cables', 'dont worry about the floor'] },
  { kind: 'wait_for_orders', any: ['wait for me', 'wait for orders', 'dont move unless', 'stay put', 'do nothing unless', 'only do what i say', 'ask me first'] },
  { kind: 'act_alone', any: ['do your own thing', 'your own thing', 'you decide', 'keep busy', 'act alone', 'be free', 'do whatever you want', 'use your judgement'] },
  { kind: 'careful', any: ['be careful', 'stay quiet', 'go slow', 'be quiet', 'take it slow', 'from now on sneak'] },
  { kind: 'bold', any: ['stop sneaking', 'stop being careful', 'just go', 'full speed', 'dont sneak'] },
];

const DIRECTIVE_ACK: Record<DirectiveKind, string> = {
  avoid_enemies: 'ROBOT AVOIDS MACHINES. FOREVER.',
  fight_enemies: 'ROBOT HUNTS MACHINES NOW.',
  avoid_hazards: 'ROBOT WATCHES SPICY FLOOR.',
  ignore_hazards: 'ROBOT IGNORES SPICY FLOOR. BRAVE.',
  gather: 'ROBOT TAKES ALL SHINY.',
  no_gather: 'ROBOT LEAVES SHINY. HARD.',
  careful: 'ROBOT IS QUIET NOW.',
  bold: 'ROBOT STOPS SNEAKING. LOUD.',
  act_alone: 'ROBOT DECIDES THINGS NOW.',
  wait_for_orders: 'ROBOT WAITS FOR VOICE.',
};

/** Nouns that make "avoid X" a category rule instead of one named target. */
const ENEMY_NOUNS = new Set(['enemy', 'enemies', 'machine', 'machines', 'printers', 'them', 'everything', 'trouble', 'danger', 'monsters', 'bad']);

const HIDE_WORDS = new Set(['hide', 'hides', 'hiding', 'cover', 'vanish']);
const HIDE_PHRASES = ['take cover', 'get behind', 'go behind'];
const AVOID_WORDS = new Set(['avoid', 'avoids']);
const AVOID_PHRASES = ['stay away', 'keep away', 'dont touch', 'dont go near', 'stay clear', 'steer clear'];
const CAREFUL_WORDS = new Set([
  'sneak', 'sneaks', 'sneaky', 'careful', 'carefully', 'quiet', 'quietly', 'slowly', 'gently', 'cautious',
]);
/**
 * Sequence splitters: everything a player uses to mean "and after that" —
 * "then", "and then", "after that", and the commas that norm() eats. That last
 * one is why this runs on the RAW utterance, before normalising. A bare "and"
 * is deliberately NOT a splitter: "go to the elevator and avoid enemies" is one
 * order plus one standing rule, not two steps.
 */
const SEQ_SPLIT = /\s*(?:,|;|\band then\b|\bafter that\b|\bthen\b)\s*/i;
/** `plan` holds the TAIL only — the head command stays at the top level. */
const MAX_PLAN = 4;
const COUNT_SPOKEN = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'];
/** Intents a plan may hold (commands only, no meta). */
const CHAINABLE = new Set<IntentType>([
  'move', 'stop', 'shoot', 'goto', 'attack', 'pickup', 'enter_elevator', 'explore', 'hide', 'avoid',
]);

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

/** First real heading in the line, verb particles excluded (see PARTICLE_DIRS). */
function findDir(tokens: string[]): Dir | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const d = DIR_WORDS[tokens[i]];
    if (d === undefined) continue;
    if (i > 0 && PARTICLE_DIRS.has(tokens[i])) {
      if (PARTICLE_SUBJECTS.has(tokens[i - 1])) continue;
      // "pick up the box" = particle; a bare "get up" (nothing after it) is
      // still allowed to mean a heading.
      if (PARTICLE_VERBS.has(tokens[i - 1]) && i < tokens.length - 1) continue;
    }
    return d;
  }
  return undefined;
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
/**
 * Words for a KIND that never appear in that kind's label. Nobody looking at
 * the big glowing container on the floor calls it "the starter crate" — they
 * say "the box", and answering the most important object on the floor with
 * "ROBOT NOT KNOW BOX" is the whole complaint about pickups not working.
 * Nearest match wins, so it works on floors with several of a kind.
 */
const KIND_SYNONYMS: Array<{ kind: string; words: string[] }> = [
  { kind: 'crate', words: ['box', 'boxes', 'chest', 'container', 'present', 'package', 'cube'] },
  { kind: 'chip', words: ['upgrade', 'module', 'card', 'brain'] },
  { kind: 'scrap', words: ['shiny', 'junk', 'metal', 'loot', 'bits'] },
  { kind: 'fusedPrinter', words: ['machine', 'enemy', 'monster', 'thing', 'baddie'] },
  { kind: 'cable', words: ['wire', 'wires', 'spark', 'sparks', 'electricity'] },
];

function synonymEntity(tokens: string[], entities: ParseEntity[]): ParseEntity | null {
  for (const group of KIND_SYNONYMS) {
    if (!tokens.some((t) => group.words.includes(t))) continue;
    let best: ParseEntity | null = null;
    for (const e of entities) {
      if (e.kind !== group.kind) continue;
      if (best === null || (e.dist ?? Infinity) < (best.dist ?? Infinity)) best = e;
    }
    if (best) return best;
  }
  return null;
}

function matchEntity(tokens: string[], entities: ParseEntity[]): ParseEntity | null {
  // The dead elevator's label is fat with common words ("dead elevator behind
  // robot"): it ties the real exit on "elevator" alone, scores on the word
  // "robot", and — being listed first on every floor — wins those ties. So it
  // is invisible to the matcher unless the player names it as the dead one.
  const wantsDead = tokens.some((t) => DEAD_ELEVATOR_WORDS.has(t));
  let best: ParseEntity | null = null;
  let bestScore = 0;
  for (const e of entities) {
    if (e.kind === 'elevatorA' && !wantsDead) continue;
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
    // ...and when they DO name it, it has to out-score B's single "elevator"
    // ("the broken elevator" hits no label word B does not also hit).
    if (score > 0 && e.kind === 'elevatorA') score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  // Labels are the engine's names for things, not the player's. Fall back to
  // what a human would actually call it.
  return best ?? synonymEntity(tokens, entities);
}

/**
 * THE elevator, for any line that asks for one. B is the exit on every floor;
 * A is the inert one behind the spawn. A is returned only when the player
 * explicitly singles it out, and is NEVER a fallback for a missing B — a dead
 * door is not a second-best exit, it is a wasted trip across the floor.
 */
function resolveElevator(tokens: string[], entities: ParseEntity[]): ParseEntity | null {
  if (tokens.some((t) => DEAD_ELEVATOR_WORDS.has(t))) {
    const a = entities.find((e) => e.kind === 'elevatorA');
    if (a) return a;
  }
  return entities.find((e) => e.kind === 'elevatorB') ?? null;
}

/** Is this line about the elevator at all? A matched elevator entity counts —
 *  it still has to go through resolveElevator to land on the right one. */
function elevatorAsk(tokens: string[], matched: ParseEntity | null): boolean {
  if (tokens.some((t) => ELEVATOR_NOUNS.has(t))) return true;
  if (matched && (matched.kind === 'elevatorA' || matched.kind === 'elevatorB')) return true;
  return tokens.some((t) => ELEVATOR_VERBS.has(t)) && !matched;
}

function enterElevator(elev: ParseEntity): ParsedCommand {
  return {
    intent: 'enter_elevator',
    target: elev.id,
    ack_line: elev.kind === 'elevatorA' ? 'ROBOT TRIES DEAD ELEVATOR. BOLD.' : 'ROBOT ENTERS ELEVATOR.',
  };
}

/** Sequence pieces of a raw utterance, normalised, in order. */
function splitSteps(raw: string): string[] {
  return raw
    .split(SEQ_SPLIT)
    .map((p) => norm(p))
    .filter(Boolean);
}

/** A held step says "THEN <what it would have said>" — first sentence only, so
 *  the ≤7-word law survives the prefix. */
function toPlanStep(cmd: ParsedCommand): PlanStep {
  const first = (cmd.ack_line.split('.')[0] ?? '').trim();
  const step: PlanStep = {
    intent: cmd.intent,
    ack_line: first ? `THEN ${first}.` : 'THEN ROBOT DOES THING.',
  };
  if (cmd.dir) step.dir = cmd.dir;
  if (cmd.amount) step.amount = cmd.amount;
  if (cmd.steps) step.steps = cmd.steps;
  if (cmd.careful) step.careful = cmd.careful;
  if (cmd.target) step.target = cmd.target;
  return step;
}

function entLabel(e: ParseEntity): string {
  return norm(e.label).replace(/^the /, '').toUpperCase();
}

function cap(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// ---------------------------------------------------------------- parser

export function parseLocal(utterance: Utterance | string, ctx: LocalParseCtx): ParsedCommand {
  const raw = typeof utterance === 'string' ? utterance : utterance.text;
  const text = norm(raw);
  const tokens = text.length > 0 ? text.split(' ') : [];
  const insult = tokens.some((t) => INSULTS.has(t));
  const base = interpret(raw, text, tokens, ctx, insult);
  return { ...base, ...(insult ? { insult: true } : {}), source: 'local' };
}

/**
 * The whole line. Ceremony beats answer it as ONE thing and never split; a
 * command line may hold a whole errand ("grab the fuse, put it in the socket,
 * then take the lift"). The head runs now; the rest is handed over as `plan`
 * and stepped through as each order finishes. Meta answers (chatter, clarify,
 * a bare standing rule) never take a slot in the queue — their directives are
 * folded into the head instead, so "…then stop picking things up" still
 * changes the rules without burning a step on nothing.
 */
function interpret(
  raw: string,
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

  // A bare yes/no only means something while ROBOT holds a question open.
  if (ctx.pendingQuestion && tokens.length <= 4) {
    if (tokens.some((t) => YES_WORDS.has(t)) || YES_PHRASES.some((p) => text.includes(p))) {
      return { intent: 'affirm', ack_line: 'ROBOT DOES IT. GOOD PLAN.' };
    }
    if (tokens.some((t) => NO_WORDS.has(t)) || NO_PHRASES.some((p) => text.includes(p))) {
      return { intent: 'deny', ack_line: 'ROBOT DOES NOT. FINE.' };
    }
  }

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

  // Plans: "X, Y, then Z" → head now, the rest held in order.
  const parts = splitSteps(raw);
  if (parts.length > 1) {
    const parsed = parts.map((p) => interpretOne(p, p.split(' '), ctx, insult));
    const carried: DirectiveKind[] = [];
    for (const c of parsed) if (c.directives) carried.push(...c.directives);
    // A panicked "stop, stop!" is one order repeated, not a two-step plan.
  const steps = parsed
    .filter((c) => CHAINABLE.has(c.intent))
    .filter((c, i, all) => i === 0 || c.intent !== all[i - 1].intent || c.target !== all[i - 1].target || c.dir !== all[i - 1].dir);
    // Nothing executable in the whole line: answer the first thing that was said.
    const head = steps[0] ?? parsed[0];
    const tail = steps.slice(1, 1 + MAX_PLAN);
    if (tail.length > 0) {
      head.plan = tail.map(toPlanStep);
      const held = 1 + head.plan.length;
      head.ack_line =
        steps.length > 1 + MAX_PLAN
          ? `ROBOT HOLDS ${COUNT_SPOKEN[held]} THINGS ONLY.`
          : `ROBOT HAS PLAN. ${COUNT_SPOKEN[held]} STEPS.`;
    }
    if (carried.length > 0) head.directives = [...new Set(carried)].slice(0, 4);
    return head;
  }

  return interpretOne(text, tokens, ctx, insult);
}

/** One command, one segment of text: hide/avoid readings, standing rules, and
 *  the keyword heuristics underneath. */
function interpretOne(
  text: string,
  tokens: string[],
  ctx: LocalParseCtx,
  insult: boolean,
): ParsedCommand {
  const hideAsk = tokens.some((t) => HIDE_WORDS.has(t)) || HIDE_PHRASES.some((p) => text.includes(p));
  const avoidAsk = tokens.some((t) => AVOID_WORDS.has(t)) || AVOID_PHRASES.some((p) => text.includes(p));
  const carefulAsk = tokens.some((t) => CAREFUL_WORDS.has(t));
  const directives = detectDirectives(text);

  // "avoid the enemies" is a standing POLICY; "avoid that printer" names one
  // thing. Reading the first as the second is how a rule evaporates after one
  // corner, which is precisely the amnesia this parser has to stop having.
  if (avoidAsk && !tokens.some((t) => ENEMY_NOUNS.has(t))) {
    const ent = matchEntity(tokens, ctx.entities);
    if (ent) {
      const cmd: ParsedCommand = {
        intent: 'avoid',
        target: ent.id,
        ack_line: `ROBOT AVOIDS ${entLabel(ent)}. FOREVER.`,
      };
      if (directives.length > 0) cmd.directives = directives;
      return cmd;
    }
  }
  if (hideAsk) {
    const cmd: ParsedCommand = { intent: 'hide', ack_line: 'ROBOT HIDES NOW. NOBODY SEES ROBOT.' };
    if (directives.length > 0) cmd.directives = directives;
    return cmd;
  }

  const cmd = command(text, tokens, ctx, insult);
  if (carefulAsk && (cmd.intent === 'move' || cmd.intent === 'goto' || cmd.intent === 'pickup')) {
    cmd.careful = true;
    cmd.ack_line = 'ROBOT SNEAKS. VERY QUIET.';
  }
  if (directives.length > 0) {
    cmd.directives = directives;
    if (cmd.intent === 'chatter' || cmd.intent === 'clarify') {
      cmd.intent = 'directive';
      cmd.ack_line = DIRECTIVE_ACK[directives[0]];
    }
  }
  return cmd;
}

/** Standing rules named anywhere in the line — deduped, capped. */
function detectDirectives(text: string): DirectiveKind[] {
  const out: DirectiveKind[] = [];
  for (const d of DIRECTIVE_PHRASES) {
    if (d.any.some((p) => text.includes(p))) out.push(d.kind);
  }
  return [...new Set(out)].slice(0, 4);
}

/** Pre-BRAIN heuristics (negation/dir/stop/help/targets/shoot/chatter), unchanged family. */
function command(
  text: string,
  tokens: string[],
  ctx: LocalParseCtx,
  insult: boolean,
): ParsedCommand {
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

  const dir = findDir(tokens);
  // A "stop" that belongs to a standing rule ("stop picking things up", "stop
  // fighting") is not a halt order — it changes the rules and the robot keeps
  // walking. Only a bare stop stops. "stop moving" is not a rule, so it still does.
  const stopIsRule = DIRECTIVE_PHRASES.some((d) =>
    d.any.some((p) => p.startsWith('stop') && text.includes(p)),
  );
  const amount = tokens.some((t) => STEP_WORDS.has(t))
    ? ('step' as const)
    : tokens.some((t) => BIT_WORDS.has(t))
      ? ('bit' as const)
      : undefined;

  // "go left a bit and stop" is ONE nudge (the move halts itself) — nudge beats the stop word.
  if (dir && amount) {
    const cmd: ParsedCommand = {
      intent: 'move',
      dir,
      amount,
      ack_line: `ROBOT GOES ${dir.toUpperCase()}. SMALL GO.`,
    };
    if (amount === 'step') {
      // The count word sits immediately before "step(s)" — take it from there
      // so "go to steps right" resolves as two, not as a stray article.
      const si = tokens.findIndex((t) => STEP_WORDS.has(t));
      const n = si > 0 ? COUNT_WORDS[tokens[si - 1]!] : undefined;
      if (n && n > 1) {
        cmd.steps = n;
        cmd.ack_line = `ROBOT GOES ${dir.toUpperCase()}. ${n} STEPS.`;
      }
    }
    return cmd;
  }

  if (EXPLORE_PHRASES.some((p) => text.includes(p)) || tokens.some((t) => EXPLORE_WORDS.has(t))) {
    return { intent: 'explore', ack_line: 'ROBOT EXPLORES. ROBOT IS BRAVE.' };
  }

  if (!stopIsRule && tokens.some((t) => STOPS.has(t))) {
    return { intent: 'stop', ack_line: 'ROBOT STOPS.' };
  }

  if (dir) return { intent: 'move', dir, ack_line: `ROBOT GOES ${dir.toUpperCase()}.` };

  // help: proud capability listing, tier- and brain-appropriate
  if (
    HELP_PHRASES.some((p) => text.includes(p)) ||
    (tokens.includes('help') &&
      !tokens.some((t) => GOTO_VERBS.has(t) || PICKUP_VERBS.has(t) || ATTACK_VERBS.has(t)))
  ) {
    return { intent: 'chatter', ack_line: 'ROBOT GOES. FIGHTS. HIDES. GRABS.' };
  }

  // tier 0: it can't navigate to a named thing, but it can head that way.
  // Refusing outright made the opening minutes feel deaf; a confident wrong-ish
  // lunge is both funnier and playable, and EARS still upgrades it to precision.
  if (ctx.tier < 1) {
    const ent = matchEntity(tokens, ctx.entities);
    const bearing = ent?.dir ?? '';
    const lunge: Dir | null = bearing.startsWith('left')
      ? 'left'
      : bearing.startsWith('right')
        ? 'right'
        : bearing.startsWith('above')
          ? 'up'
          : bearing.startsWith('below')
            ? 'down'
            : null;
    if (ent && lunge) {
      return {
        intent: 'move',
        dir: lunge,
        ack_line: `ROBOT GOES ${lunge.toUpperCase()}. PROBABLY RIGHT.`,
      };
    }
  }

  // tier 1+: named targets
  if (ctx.tier >= 1) {
    const ent = matchEntity(tokens, ctx.entities);
    // Elevator first: "take the exit" / "get in the lift" name no label at all,
    // and even a label-matched elevator has to go through the A/B rule before
    // it becomes an order.
    if (elevatorAsk(tokens, ent)) {
      const elev = resolveElevator(tokens, ctx.entities);
      if (elev) return enterElevator(elev);
    }
    if (ent) {
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

  // The elevator answers to bad ears too — floor 1 has to be finishable at
  // EARS 0, so an out-of-sight exit is still a real order, not a shrug. Never
  // the dead one: resolveElevator returns null rather than settle for A.
  if (tokens.some((t) => ELEVATOR_NOUNS.has(t))) {
    const elev = resolveElevator(tokens, ctx.entities);
    if (elev) return enterElevator(elev);
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
