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
  DirectiveKind,
  IntentType,
  ParsedCommand,
  ParseEntity,
  ParseRequest,
  PlanStep,
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
/**
 * Verb particles wearing a direction's clothes. "hunt them DOWN", "pick it UP",
 * "put it BACK" are orders about a thing, not headings — reading them as a
 * heading marches the robot off across the room, which is the exact failure
 * that makes it look like it wasn't listening.
 */
const PARTICLE_DIRS = ['up', 'down', 'back'];
const PARTICLE_SUBJECTS = ['them', 'it', 'him', 'her', 'those', 'these', 'that', 'things', 'stuff', 'everything'];
/**
 * ...and the particle can sit straight after its verb with no subject at all:
 * "PICK UP the box" is the single most natural way to say it, and reading that
 * `up` as north sent the robot marching away from the most important object on
 * the floor. Motion verbs are deliberately absent — "go up" IS a heading.
 */
const PARTICLE_VERBS = [
  'pick', 'grab', 'take', 'get', 'fetch', 'collect', 'carry', 'lift', 'scoop',
  'put', 'hold', 'hunt', 'track', 'tidy', 'clean', 'pack',
];
/** Nudge magnitudes: "a bit"-family → 'bit', "one step"-family → 'step'. */
const BIT_WORDS = ['bit', 'little', 'slightly', 'touch', 'tad', 'smidge'];
const STEP_WORDS = ['step', 'steps'];
/** Step counts + the homophones browser STT produces for them ("to" = two). */
const COUNT_WORDS: Record<string, number> = {
  one: 1, won: 1, '1': 1,
  two: 2, to: 2, too: 2, '2': 2,
  three: 3, tree: 3, '3': 3,
  four: 4, for: 4, fore: 4, '4': 4,
  five: 5, '5': 5,
  six: 6, '6': 6,
  seven: 7, '7': 7,
  eight: 8, ate: 8, '8': 8,
};
const EXPLORE_WORDS = ['explore', 'wander', 'roam', 'scout', 'adventure', 'exploring'];
const EXPLORE_PHRASES = [
  'look around', 'have a look', 'go see', 'look about', 'check it out',
  'find something', 'go exploring', 'do whatever', 'your choice',
];
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
/**
 * Elevator language. Every floor carries TWO of them: `elevatorA` is the dead
 * one the robot arrived in (label "dead elevator behind robot"), `elevatorB`
 * is the exit. Unqualified elevator/lift/exit/door talk ALWAYS means B —
 * walking to A is walking to a door that does nothing, which reads as the
 * parser being broken rather than as a joke.
 */
const ELEVATOR_NOUNS = ['elevator', 'elevators', 'lift', 'lifts', 'exit', 'door', 'doors', 'doorway'];
/** Verbs that mean the elevator, but only when nothing else was named. */
const ELEVATOR_VERBS = ['enter', 'ride', 'board'];
/** The only words that let the player single out the DEAD elevator. */
const DEAD_ELEVATOR_WORDS = [
  'dead', 'broken', 'busted', 'inert', 'dud', 'old', 'first', 'original', 'spawn', 'behind',
];
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

const YES_WORDS = ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'do', 'please', 'go', 'affirmative', 'aye'];
const YES_PHRASES = ['do it', 'go on', 'go ahead', 'sounds good', 'good idea', 'why not', 'lets go'];
const NO_WORDS = ['no', 'nope', 'nah', 'dont', 'stop', 'negative'];
const NO_PHRASES = ['not that', 'no thanks', 'bad idea', 'hold on'];

/**
 * Standing rules of engagement, keyed by the phrase that sets them. Order
 * matters: the first match on a line wins for each opposed pair, so the more
 * specific phrasing must come first ("stop picking things up" before "stop").
 */
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

/** Enemy-ish nouns that make "avoid X" a POLICY rather than a named target. */
const ENEMY_NOUNS = ['enemy', 'enemies', 'machine', 'machines', 'printers', 'them', 'everything', 'trouble', 'danger', 'monsters', 'bad'];

const HIDE_WORDS = ['hide', 'hides', 'hiding', 'cover', 'vanish'];
const HIDE_PHRASES = ['take cover', 'get behind', 'go behind'];
const AVOID_WORDS = ['avoid', 'avoids'];
const AVOID_PHRASES = ['stay away', 'keep away', 'dont touch', 'dont go near', 'stay clear', 'steer clear'];
const CAREFUL_WORDS = [
  'sneak', 'sneaks', 'sneaky', 'careful', 'carefully', 'quiet', 'quietly', 'slowly', 'gently', 'cautious',
];
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
// 'nah'/'never' belong here for the same reason as 'no': the client refuses on
// them, and a robot cheerfully named "Nah" is the two parsers disagreeing.
const NAME_REFUSE = ['no', 'nope', 'nah', 'never', 'nothing', 'dont', 'whatever', 'skip', 'none', 'idk', 'dunno'];

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

/** First real heading in the line, verb particles excluded (see PARTICLE_DIRS). */
function findDir(toks: string[]): Dir | undefined {
  for (let i = 0; i < toks.length; i++) {
    const d = DIR_WORDS[toks[i]];
    if (!d) continue;
    if (i > 0 && PARTICLE_DIRS.includes(toks[i])) {
      if (PARTICLE_SUBJECTS.includes(toks[i - 1])) continue;
      // "pick up the box" = particle; a bare "get up" (nothing after it) is
      // still allowed to mean a heading.
      if (PARTICLE_VERBS.includes(toks[i - 1]) && i < toks.length - 1) continue;
    }
    return d;
  }
  return undefined;
}

/**
 * Words for a KIND that never appear in that kind's label. Nobody looking at
 * the big glowing container calls it "the starter crate" — they say "the box",
 * and answering the most important object on the floor with "NOT KNOW BOX" is
 * the whole complaint about pickups not working. Nearest match wins.
 */
const KIND_SYNONYMS: Array<{ kind: string; words: string[] }> = [
  { kind: 'crate', words: ['box', 'boxes', 'chest', 'container', 'present', 'package', 'cube'] },
  { kind: 'chip', words: ['upgrade', 'module', 'card', 'brain'] },
  { kind: 'scrap', words: ['shiny', 'junk', 'metal', 'loot', 'bits'] },
  { kind: 'fusedPrinter', words: ['machine', 'enemy', 'monster', 'baddie'] },
  { kind: 'cable', words: ['wire', 'wires', 'spark', 'sparks', 'electricity'] },
];

function synonymEntity(toks: string[], entities: ParseEntity[]): ParseEntity | null {
  for (const group of KIND_SYNONYMS) {
    if (!has(toks, group.words)) continue;
    let best: ParseEntity | null = null;
    for (const e of entities) {
      if (e.kind !== group.kind) continue;
      if (best === null || (e.dist ?? Infinity) < (best.dist ?? Infinity)) best = e;
    }
    if (best) return best;
  }
  return null;
}

function matchEntity(toks: string[], entities: ParseEntity[]): ParseEntity | null {
  // The dead elevator's label is fat with common words ("dead elevator behind
  // robot"): it ties the real exit on "elevator" alone, scores on the word
  // "robot", and — being listed first on every floor — wins those ties. So it
  // is invisible to the matcher unless the player names it as the dead one.
  const wantsDead = has(toks, DEAD_ELEVATOR_WORDS);
  let best: ParseEntity | null = null;
  let bestScore = 0;
  for (const e of entities) {
    if (e.kind === 'elevatorA' && !wantsDead) continue;
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
    // ...and when they DO name it, it has to out-score B's single "elevator"
    // ("the broken elevator" hits no label word B does not also hit).
    if (score > 0 && e.kind === 'elevatorA') score += 1;
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  // Labels are the engine's names for things, not the player's.
  return best ?? synonymEntity(toks, entities);
}

/**
 * THE elevator, for any line that asks for one. B is the exit on every floor;
 * A is the inert one behind the spawn. A is returned only when the player
 * explicitly singles it out, and is NEVER a fallback for a missing B — a dead
 * door is not a second-best exit, it is a wasted trip across the floor.
 */
function resolveElevator(toks: string[], entities: ParseEntity[]): ParseEntity | null {
  if (has(toks, DEAD_ELEVATOR_WORDS)) {
    const a = entities.find((e) => e.kind === 'elevatorA');
    if (a) return a;
  }
  return entities.find((e) => e.kind === 'elevatorB') ?? null;
}

/** Is this line about the elevator at all? A matched elevator entity counts —
 *  it still has to go through resolveElevator to land on the right one. */
function elevatorAsk(toks: string[], matched: ParseEntity | null): boolean {
  if (has(toks, ELEVATOR_NOUNS)) return true;
  if (matched && (matched.kind === 'elevatorA' || matched.kind === 'elevatorB')) return true;
  return has(toks, ELEVATOR_VERBS) && !matched;
}

function enterElevator(elev: ParseEntity, name: string): ParsedCommand {
  return {
    intent: 'enter_elevator',
    target: elev.id,
    ack_line:
      elev.kind === 'elevatorA'
        ? `${name} TRIES DEAD ELEVATOR. BOLD.`
        : `${name} RIDES ELEVATOR. UP IS GOOD.`,
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
function toPlanStep(cmd: ParsedCommand, name: string): PlanStep {
  const first = (cmd.ack_line.split('.')[0] ?? '').trim();
  const step: PlanStep = {
    intent: cmd.intent,
    ack_line: first ? `THEN ${first}.` : `THEN ${name} DOES THING.`,
  };
  if (cmd.dir) step.dir = cmd.dir;
  if (cmd.amount) step.amount = cmd.amount;
  if (cmd.steps) step.steps = cmd.steps;
  if (cmd.careful) step.careful = cmd.careful;
  if (cmd.target) step.target = cmd.target;
  return step;
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

/** Standing rules named anywhere in the line — deduped, first-match per pair. */
function detectDirectives(text: string): DirectiveKind[] {
  const out: DirectiveKind[] = [];
  for (const d of DIRECTIVE_PHRASES) {
    if (d.any.some((p) => text.includes(p))) out.push(d.kind);
  }
  return [...new Set(out)].slice(0, 4);
}

/** Short label for the ack of a pure policy change. */
const DIRECTIVE_ACK: Record<DirectiveKind, string> = {
  avoid_enemies: 'AVOIDS MACHINES NOW. FOREVER.',
  fight_enemies: 'HUNTS MACHINES NOW. PEW PEW.',
  avoid_hazards: 'WATCHES FLOOR NOW. SPICY FLOOR.',
  ignore_hazards: 'IGNORES SPICY FLOOR. BRAVE.',
  gather: 'TAKES ALL SHINY. ALL OF IT.',
  no_gather: 'LEAVES SHINY. HARD BUT OKAY.',
  careful: 'IS QUIET NOW. VERY QUIET.',
  bold: 'STOPS SNEAKING. LOUD AGAIN.',
  act_alone: 'DECIDES THINGS NOW. EXCITING.',
  wait_for_orders: 'WAITS FOR VOICE. ONLY VOICE.',
};

/**
 * One utterance can hold a whole errand ("grab the fuse, put it in the socket,
 * then take the lift"). The head runs now; the rest is handed over as `plan`
 * and stepped through as each order finishes. Meta answers (chatter, clarify,
 * a bare standing rule) never take a slot in the queue — their directives are
 * folded into the head instead, so "…then stop picking things up" still
 * changes the rules without burning a step on nothing.
 */
function interpretUtterance(raw: string, text: string, req: ParseRequest, name: string): ParsedCommand {
  const parts = splitSteps(raw);
  if (parts.length <= 1) return interpretCommand(text, req, name);

  const parsed = parts.map((p) => interpretCommand(p, req, name));
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
    head.plan = tail.map((c) => toPlanStep(c, name));
    const held = 1 + head.plan.length;
    head.ack_line =
      steps.length > 1 + MAX_PLAN
        ? `${name} HOLDS ${COUNT_SPOKEN[held]} THINGS ONLY.`
        : `${name} HAS PLAN. ${COUNT_SPOKEN[held]} STEPS.`;
  }
  if (carried.length > 0) head.directives = [...new Set(carried)].slice(0, 4);
  return head;
}

/** One command, one segment of text. */
function interpretCommand(text: string, req: ParseRequest, name: string): ParsedCommand {
  const toks = text.split(' ').filter(Boolean);
  const hideAsk = has(toks, HIDE_WORDS) || HIDE_PHRASES.some((p) => text.includes(p));
  const avoidAsk = has(toks, AVOID_WORDS) || AVOID_PHRASES.some((p) => text.includes(p));
  const carefulAsk = has(toks, CAREFUL_WORDS);
  const directives = detectDirectives(text);

  // "avoid the enemies" is a POLICY; "avoid that printer" names one thing.
  // Getting this backwards is what made a standing rule evaporate after one
  // corner, so the policy reading wins whenever the noun is a category.
  if (avoidAsk && !has(toks, ENEMY_NOUNS)) {
    const target = matchEntity(toks, req.entities);
    if (target) {
      const cmd: ParsedCommand = {
        intent: 'avoid',
        target: target.id,
        ack_line: `${name} AVOIDS ${labelWord(target)}. FOREVER.`,
      };
      if (directives.length > 0) cmd.directives = directives;
      return cmd;
    }
  }
  if (hideAsk) {
    const cmd: ParsedCommand = { intent: 'hide', ack_line: `${name} HIDES NOW. NOBODY SEES ${name}.` };
    if (directives.length > 0) cmd.directives = directives;
    return cmd;
  }

  const cmd = basicCommand(text, toks, req, name);
  if (carefulAsk && (cmd.intent === 'move' || cmd.intent === 'goto' || cmd.intent === 'pickup')) {
    cmd.careful = true;
    cmd.ack_line = `${name} SNEAKS. VERY QUIET.`;
  }
  if (directives.length > 0) {
    cmd.directives = directives;
    // A rule with nothing to do attached is still an instruction, not noise.
    if (cmd.intent === 'chatter' || cmd.intent === 'clarify') {
      cmd.intent = 'directive';
      cmd.ack_line = `${name} ${DIRECTIVE_ACK[directives[0]]}`;
    }
  }
  return cmd;
}

/** Pre-BRAIN heuristics (dir/stop/help/targets/shoot/chatter), unchanged family. */
function basicCommand(text: string, toks: string[], req: ParseRequest, name: string): ParsedCommand {
  const insult = has(toks, INSULT_WORDS);
  const dir = findDir(toks);
  const amount = has(toks, STEP_WORDS) ? ('step' as const) : has(toks, BIT_WORDS) ? ('bit' as const) : undefined;
  // A "stop" that belongs to a standing rule ("stop picking things up", "stop
  // fighting") is not a halt order — it changes the rules and the robot keeps
  // walking. Only a bare stop stops. "stop moving" is not a rule, so it still does.
  const stopIsRule = DIRECTIVE_PHRASES.some((d) =>
    d.any.some((p) => p.startsWith('stop') && text.includes(p)),
  );

  // "go left a bit and stop" is ONE nudge (the move halts itself) — nudge beats the stop word.
  if (dir && amount) {
    const cmd: ParsedCommand = {
      intent: 'move',
      dir,
      amount,
      ack_line: `${name} GOES ${dir.toUpperCase()}. SMALL ZOOM.`,
    };
    if (amount === 'step') {
      const si = toks.findIndex((t) => STEP_WORDS.includes(t));
      const n = si > 0 ? COUNT_WORDS[toks[si - 1]] : undefined;
      if (n && n > 1) {
        cmd.steps = n;
        cmd.ack_line = `${name} GOES ${dir.toUpperCase()}. ${n} STEPS.`;
      }
    }
    return cmd;
  }

  if (EXPLORE_PHRASES.some((p) => text.includes(p)) || has(toks, EXPLORE_WORDS)) {
    return { intent: 'explore', ack_line: `${name} EXPLORES. ${name} IS BRAVE.` };
  }

  if (!stopIsRule && has(toks, STOP_WORDS)) {
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
      ack_line: `${name} GOES. FIGHTS. HIDES. GRABS.`,
    };
  }

  if (req.tier >= 1) {
    const target = matchEntity(toks, req.entities);
    // Elevator first: "take the exit" / "get in the lift" name no label at all,
    // and even a label-matched elevator has to go through the A/B rule before
    // it becomes an order.
    if (elevatorAsk(toks, target)) {
      const elev = resolveElevator(toks, req.entities);
      if (elev) return enterElevator(elev, name);
    }
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

  // Tier 0 hearing target-language: no precision, but never a refusal — it
  // heads roughly the right way and owns the guess. EARS buys accuracy later.
  if (req.tier === 0) {
    const ent = matchEntity(toks, req.entities);
    const b = ent?.dir ?? '';
    const lunge: Dir | null = b.startsWith('left')
      ? 'left'
      : b.startsWith('right')
        ? 'right'
        : b.startsWith('above')
          ? 'up'
          : b.startsWith('below')
            ? 'down'
            : null;
    if (ent && lunge) {
      return { intent: 'move', dir: lunge, ack_line: `${name} GOES ${lunge.toUpperCase()}. PROBABLY RIGHT.` };
    }
    // The elevator answers to bad ears too — floor 1 has to be finishable at
    // EARS 0, so an out-of-sight exit is still a real order, not a shrug.
    if (has(toks, ELEVATOR_NOUNS)) {
      const elev = resolveElevator(toks, req.entities);
      if (elev) return enterElevator(elev, name);
    }
    if (has(toks, GOTO_VERBS) || has(toks, ATTACK_VERBS) || has(toks, PICKUP_VERBS)) {
      return { intent: 'clarify', ack_line: `${name} HEARD BIG WORDS. TRY LEFT?` };
    }
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

  // A bare yes/no only means something while ROBOT is holding a question open.
  if (req.pendingQuestion && toks.length <= 4) {
    if (has(toks, YES_WORDS) || YES_PHRASES.some((p) => text.includes(p))) {
      return done({ intent: 'affirm', ack_line: `${name} DOES IT. GOOD PLAN.` });
    }
    if (has(toks, NO_WORDS) || NO_PHRASES.some((p) => text.includes(p))) {
      return done({ intent: 'deny', ack_line: `${name} DOES NOT. FINE.` });
    }
  }

  return done(interpretUtterance(req.utterance, text, req, name));
}
