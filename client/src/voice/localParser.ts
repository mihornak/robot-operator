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
import { smallTalk } from '@shared/smallTalk';

export interface LocalParseCtx {
  tier: EarsTier;
  options: ChipId[] | null;
  awaitingName: boolean;
  entities: ParseEntity[];
  /** Kept for contract symmetry; true in play — nothing is gated any more. */
  brain?: boolean;
  /** The question ROBOT is waiting on, if any — makes a bare "yes" meaningful. */
  pendingQuestion?: string | null;
  /** Name for the conversation bank ("BEEP IS EXCELLENT."). */
  robotName?: string | null;
  /** Dialogue log, so the keyless robot does not answer the same way twice. */
  recent?: string[];
  /** Nothing hostile awake — false makes conversation a deflection. */
  calm?: boolean;
}

/**
 * A conversational answer, keyless. `ack_line` stays the one-line version for
 * the log and the OSD; `talk` is the run the robot actually speaks.
 */
function chat(raw: string, ctx: LocalParseCtx): ParsedCommand {
  const { lines } = smallTalk(raw, {
    name: (ctx.robotName ?? 'ROBOT').toUpperCase(),
    recent: ctx.recent ?? [],
    calm: ctx.calm ?? true,
  });
  return { intent: 'chatter', ack_line: lines[0]!, talk: lines };
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
 *  specific phrasing must come first within an opposed pair. `not` is an escape
 *  hatch for entries whose phrasing is a genuine substring of a MORE specific
 *  rule's phrasing — see avoid_enemies below. */
const DIRECTIVE_PHRASES: Array<{ kind: DirectiveKind; any: string[]; not?: string[] }> = [
  { kind: 'no_gather', any: ['stop picking', 'no picking', 'dont pick', 'ignore the scrap', 'ignore scrap', 'leave the scrap', 'no looting', 'dont grab'] },
  { kind: 'gather', any: ['pick everything', 'grab everything', 'pick up everything', 'take the scrap', 'grab shiny', 'loot everything', 'collect everything'] },
  // ---- combat doctrine ----------------------------------------------------
  // These sit ABOVE avoid_enemies deliberately. "run away from the red circles"
  // and "keep your distance" are readings the generic avoid rule would swallow
  // whole, and losing the specific one costs the player the exact mid-fight
  // readjustment they just made — which is the whole reason these exist.
  // 'further back' is listed SEPARATELY from bare 'further' so the masking rule
  // below fires on it: it contains `back`, a heading word, and without the mask
  // "further back" set the rule and then also drove the robot south.
  // `not`: 'further' is a substring of 'furthest', which is a TARGET word
  // ("shoot the furthest one") — the superlative must not silently become a
  // doctrine change. Same for farther/farthest.
  { kind: 'keep_distance', any: ['keep your distance', 'keep distance', 'keep back', 'stay back', 'back off', 'dont get too close', 'do not get too close', 'not too close', 'too close', 'not that close', 'fight from range', 'shoot from far', 'from a distance', 'at range', 'kite', 'further back', 'farther back', 'further', 'farther', 'more distance', 'more space', 'more room'], not: ['furthest', 'farthest'] },
  // NO bare 'close': it is a substring of focus_nearest's "closest", and one
  // player saying "kill the closest one" would silently turn into a charge.
  { kind: 'close_in', any: ['get closer', 'get close', 'in its face', 'in their face', 'in his face', 'point blank', 'up close', 'close in', 'charge them', 'right up to'], not: ['dont get', 'do not get', 'never get', 'not too close'] },
  { kind: 'dodge_projectiles', any: ['red circle', 'red circles', 'the circles', 'dodge the rocket', 'avoid the rocket', 'dodge the mortar', 'avoid the mortar', 'watch the ground', 'mind the ground', 'off the ground', 'dont get hit', 'do not get hit', 'dont get blown'], not: ['ignore the', 'dont worry'] },
  { kind: 'ignore_projectiles', any: ['ignore the circles', 'ignore the rockets', 'ignore the red', 'ignore the ground'] },
  { kind: 'keep_moving', any: ['keep moving', 'dont stop moving', 'do not stop moving', 'never stop moving', 'dont stand still', 'run around the map', 'run around', 'strafe', 'circle them', 'circle around', 'keep dancing'] },
  { kind: 'hold_ground', any: ['hold your ground', 'hold ground', 'stand your ground', 'stand still', 'stop moving around', 'stay in one place', 'plant yourself'], not: ['dont stand still', 'do not stand still', 'never stand still', 'dont stop moving', 'do not stop moving'] },
  { kind: 'focus_dangerous', any: ['big one first', 'biggest first', 'kill the big', 'most dangerous first', 'dangerous one first', 'worst one first', 'boss first', 'big ones first'] },
  { kind: 'focus_nearest', any: ['nearest first', 'closest first', 'nearest one first', 'closest one first', 'whichever is closest'] },
  { kind: 'use_rockets', any: ['use the rocket', 'use rockets', 'use your rocket', 'big gun', 'the launcher', 'big pew'] },
  { kind: 'use_bolts', any: ['use the bolt', 'use bolts', 'small gun', 'little gun', 'normal gun', 'small pew'] },
  // ---- end combat doctrine ------------------------------------------------
  // `not`: "run away from the red circles" is a DODGE order, not a refusal to
  // fight. Without this it fires both and the last one written wins, which is
  // how the operator ends up sneaking past a boss they meant to shoot at.
  { kind: 'avoid_enemies', any: ['avoid the enemies', 'avoid enemies', 'avoid the machines', 'avoid machines', 'avoid the printers', 'avoid printers', 'dont fight', 'no fighting', 'stop fighting', 'stay away from them', 'run away from', 'avoid them', 'dodge them'], not: ['red circle', 'the circles', 'rocket', 'mortar', 'the ground', 'the blast'] },
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
  keep_distance: 'ROBOT STAYS BACK. SHOOTS FROM FAR.',
  close_in: 'ROBOT GETS CLOSE. VERY CLOSE.',
  dodge_projectiles: 'ROBOT DODGES. ROBOT IS SLIPPERY.',
  ignore_projectiles: 'ROBOT IGNORES FLYING THINGS. BRAVE.',
  keep_moving: 'ROBOT NEVER STOPS. ROBOT ZOOMS.',
  hold_ground: 'ROBOT STANDS HERE. LIKE TREE.',
  focus_dangerous: 'BIG ONE DIES FIRST.',
  focus_nearest: 'ROBOT FIGHTS NEAREST. TIDY.',
  use_rockets: 'ROBOT USES BIG PEW PEW.',
  use_bolts: 'ROBOT USES SMALL PEW.',
};

/**
 * One rule as a bare verb phrase, for the case where the operator changed TWO
 * things in one breath. "keep your distance and dodge the rockets" answered
 * with only the first rule's ack is the player's evidence that the second one
 * was dropped — they will say it again, mid-fight, and be right to. Two short
 * sentences keep every clause inside the ≤7-word law.
 */
const DIRECTIVE_CLAUSE: Record<DirectiveKind, string> = {
  avoid_enemies: 'AVOIDS MACHINES',
  fight_enemies: 'HUNTS MACHINES',
  avoid_hazards: 'WATCHES FLOOR',
  ignore_hazards: 'IGNORES FLOOR',
  gather: 'TAKES SHINY',
  no_gather: 'LEAVES SHINY',
  careful: 'IS QUIET',
  bold: 'IS LOUD',
  act_alone: 'DECIDES THINGS',
  wait_for_orders: 'WAITS FOR VOICE',
  keep_distance: 'KEEPS BACK',
  close_in: 'GETS CLOSE',
  dodge_projectiles: 'DODGES',
  ignore_projectiles: 'IGNORES CIRCLES',
  keep_moving: 'NEVER STOPS',
  hold_ground: 'STANDS STILL',
  focus_dangerous: 'KILLS BIG ONE',
  focus_nearest: 'KILLS NEAR ONE',
  use_rockets: 'USES BIG PEW',
  use_bolts: 'USES SMALL PEW',
};

/** The ack for a pure rule change: one rule speaks in full, two speak in short
 *  clauses so the operator hears that BOTH stuck. */
function directiveAck(kinds: readonly DirectiveKind[]): string {
  if (kinds.length <= 1) return DIRECTIVE_ACK[kinds[0]!];
  return kinds
    .slice(0, 2)
    .map((k) => `ROBOT ${DIRECTIVE_CLAUSE[k]}.`)
    .join(' ');
}

/** Nouns that make "avoid X" a category rule instead of one named target. */
const ENEMY_NOUNS = new Set(['enemy', 'enemies', 'machine', 'machines', 'printers', 'them', 'everything', 'trouble', 'danger', 'monsters', 'bad']);

const HIDE_WORDS = new Set(['hide', 'hides', 'hiding', 'cover', 'vanish']);
const HIDE_PHRASES = ['take cover', 'get behind', 'go behind'];
/**
 * RUN. The word the game had no reading for at all, which is why "run", "flee",
 * "retreat" and "get away from it" all came back as a shrug and the operator
 * concluded the robot was not listening.
 *
 * Unambiguous by themselves — none of these is a heading, a target or a rule.
 * 'run' is deliberately NOT here; see RUN_WORDS.
 */
const FLEE_WORDS = new Set([
  'flee', 'fleeing', 'escape', 'retreat', 'retreats', 'retreating',
  'withdraw', 'disengage', 'abort', 'bail', 'scram', 'evacuate', 'evac', 'runaway',
]);
const FLEE_PHRASES = [
  'run away', 'run for it', 'get out of there', 'get out of here', 'get outta',
  'get away', 'get out', 'get clear', 'fall back', 'pull back', 'back away',
  'back off', 'leg it', 'bug out', 'save yourself', 'run robot',
];
/**
 * ...and the same guard avoid_enemies carries. "run away from the red circles"
 * is a DODGE rule, not a decision to leave the fight: answering it by actually
 * running costs the operator the fight they were in the middle of winning.
 */
const FLEE_NOT = ['red circle', 'the circles', 'rocket', 'mortar', 'the ground', 'the blast'];
/**
 * Bare "run" is the one that needs care, because it is three different
 * sentences: a flight ("run!"), a stance ("run around the map" → keep_moving),
 * and a heading or an errand ("run left", "run to the crate" — 'run' is a
 * GOTO_VERB). So it only means flight once every other reading has been ruled
 * out: no heading, no named thing, no elevator, and none of RUN_NOT.
 */
const RUN_WORDS = new Set(['run', 'runs', 'running']);
const RUN_NOT = ['run around', 'run about', 'run in circles', 'run laps'];
const AVOID_WORDS = new Set(['avoid', 'avoids']);
/**
 * "go around the cables" used to parse as `goto cable1` — the goto verb won and
 * the word doing all the work was dropped, so the offline path drove the robot
 * INTO the thing it was told to route around. Anything meaning "past it, not to
 * it" has to out-rank the verb, which is why these live here and are tested
 * before the goto branch.
 */
const AVOID_PHRASES = [
  'stay away', 'keep away', 'dont touch', 'dont go near', 'stay clear', 'steer clear',
  'go around', 'walk around', 'drive around', 'route around', 'get around',
  'go round', 'walk round', 'around the', 'other way', 'the long way', 'not through',
];
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
  'move', 'stop', 'shoot', 'goto', 'attack', 'pickup', 'enter_elevator', 'explore', 'hide', 'flee', 'avoid',
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

/**
 * Pointing with an adjective instead of a name: "the big one", "the little
 * one", "the one shooting", "the nearest". Hostiles only — `rank` (1 = worst)
 * and `size` are populated by visibleEntities() for live hostiles and are
 * absent on everything else, so this needs no kind list of its own.
 *
 * Two guards keep it from eating ordinary sentences. A non-hostile noun in the
 * line ("the big CRATE") hands it straight back to the label matcher, and a
 * bare adjective with no noun and no attack verb ("nearest first" — a RULE, not
 * a target) resolves to nothing at all. With zero hostiles visible it always
 * returns null, so a superlative never becomes a mysterious miss.
 */
const SUP_BIG = new Set([
  'big', 'bigger', 'biggest', 'large', 'larger', 'largest', 'huge', 'giant',
  'boss', 'dangerous', 'worst', 'scary', 'scariest', 'nastiest', 'toughest',
]);
const SUP_SMALL = new Set(['little', 'small', 'smaller', 'smallest', 'tiny', 'weakest', 'weedy']);
const SUP_NEAR = new Set(['nearest', 'closest', 'nearby']);
const SUP_FAR = new Set(['farthest', 'furthest']);
/** Phrases that mean "whatever is currently doing something to us" → rank 1. */
const SUP_ACTIVE = ['one shooting', 'one thats shooting', 'one attacking', 'shooting at', 'hitting us', 'hitting you'];
/** A superlative is a TARGET only when it has one of these to be about. */
const SUP_NOUNS = new Set([
  'one', 'ones', 'thing', 'things', 'machine', 'machines', 'printer', 'printers',
  'shredder', 'shredders', 'enemy', 'enemies', 'monster', 'monsters', 'baddie', 'guy',
]);
/**
 * ...and any of these in the line means the player is talking about scenery,
 * not a machine. "the big crate" must stay a crate even while three printers
 * are awake, which is exactly when the superlative path is most tempting.
 */
const NON_HOSTILE_WORDS = new Set([
  'crate', 'crates', 'box', 'boxes', 'chest', 'container', 'present', 'package', 'cube',
  'chip', 'chips', 'upgrade', 'module', 'card', 'scrap', 'shiny', 'junk', 'metal', 'loot', 'bits',
  'cable', 'cables', 'wire', 'wires', 'spark', 'sparks', 'electricity',
  'elevator', 'elevators', 'lift', 'lifts', 'exit', 'door', 'doors', 'doorway',
  'fuse', 'socket', 'mop', 'chair', 'pile', 'debris', 'heap', 'room', 'floor', 'wall',
  'gun', 'guns', 'rocket', 'rockets', 'bolt', 'bolts', 'circle', 'circles',
]);
/** Deictic stand-ins: the player is pointing at something they can see. */
const DEICTIC = new Set(['it', 'that', 'this', 'them', 'those', 'him', 'her', 'one', 'thing', 'things', 'guy']);

function sizeRank(e: ParseEntity): number {
  return e.size === 'boss' ? 2 : e.size === 'big' ? 1 : 0;
}

/** Live hostiles, in whatever order visibleEntities listed them. */
function hostilesOf(entities: ParseEntity[]): ParseEntity[] {
  return entities.filter((e) => e.rank !== undefined);
}

/** Rank 1 — the thing most likely to kill the robot next. */
function worstHostile(entities: ParseEntity[]): ParseEntity | null {
  const hs = hostilesOf(entities);
  if (hs.length === 0) return null;
  return hs.reduce((a, b) => (a.rank! <= b.rank! ? a : b));
}

function superlativeHostile(text: string, tokens: string[], entities: ParseEntity[]): ParseEntity | null {
  const hs = hostilesOf(entities);
  if (hs.length === 0) return null;
  if (tokens.some((t) => NON_HOSTILE_WORDS.has(t))) return null;
  if (SUP_ACTIVE.some((p) => text.includes(p))) return worstHostile(entities);
  const big = tokens.some((t) => SUP_BIG.has(t));
  const small = tokens.some((t) => SUP_SMALL.has(t));
  const near = tokens.some((t) => SUP_NEAR.has(t));
  const far = tokens.some((t) => SUP_FAR.has(t));
  if (!big && !small && !near && !far) return null;
  if (!tokens.some((t) => SUP_NOUNS.has(t)) && !tokens.some((t) => ATTACK_VERBS.has(t))) return null;
  if (near) return hs.reduce((a, b) => ((a.dist ?? Infinity) <= (b.dist ?? Infinity) ? a : b));
  if (far) return hs.reduce((a, b) => ((a.dist ?? -1) >= (b.dist ?? -1) ? a : b));
  // Body class decides first, threat rank breaks the tie — so "the big one"
  // still means something on a floor of identically-sized printers.
  if (small) {
    // Ties break on NEAREST, not on weakest: two identical printers on screen
    // and "the little one" means the one the operator is looking at.
    return hs.reduce((a, b) => {
      const d = sizeRank(a) - sizeRank(b);
      return d !== 0 ? (d < 0 ? a : b) : (a.dist ?? Infinity) <= (b.dist ?? Infinity) ? a : b;
    });
  }
  return hs.reduce((a, b) => {
    const d = sizeRank(a) - sizeRank(b);
    return d !== 0 ? (d > 0 ? a : b) : a.rank! <= b.rank! ? a : b;
  });
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

/**
 * Is this line the operator telling the robot to GET OUT? Runs on the whole
 * line, not on detectDirectives' leftovers, because "back off" is both a flee
 * phrase and a keep_distance phrase and the mask eats it (`back` is a heading
 * word) before `rest` is built. Both readings are wanted: run now, keep back
 * afterwards.
 */
function fleeAsk(text: string, tokens: string[], entities: ParseEntity[]): boolean {
  if (FLEE_NOT.some((p) => text.includes(p))) return false;
  if (tokens.some((t) => FLEE_WORDS.has(t))) return true;
  if (FLEE_PHRASES.some((p) => text.includes(p))) return true;
  if (!tokens.some((t) => RUN_WORDS.has(t))) return false;
  if (RUN_NOT.some((p) => text.includes(p))) return false;
  if (findDir(tokens) !== undefined) return false; // "run left" is a heading
  if (tokens.some((t) => ELEVATOR_NOUNS.has(t))) return false;
  return matchEntity(tokens, entities) === null; // "run to the crate" is an errand
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
  const { kinds: directives, rest } = detectDirectives(text);
  const restTokens = rest.length > 0 ? rest.split(' ') : [];

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
  // After hide ("run and hide" is a hide) and before every heuristic below it:
  // half this vocabulary would otherwise be read as a heading ('back off',
  // 'fall back') or as an errand with a missing noun ('get away' → PICKUP_VERB
  // → "WHICH THING?"), which is exactly how it failed in the playtest.
  if (fleeAsk(text, tokens, ctx.entities)) {
    const cmd: ParsedCommand = { intent: 'flee', ack_line: 'ROBOT RUNS AWAY. TACTICAL.' };
    if (directives.length > 0) cmd.directives = directives;
    return cmd;
  }

  const cmd = command(rest, restTokens, ctx, insult);
  if (carefulAsk && (cmd.intent === 'move' || cmd.intent === 'goto' || cmd.intent === 'pickup')) {
    cmd.careful = true;
    cmd.ack_line = 'ROBOT SNEAKS. VERY QUIET.';
  }
  if (directives.length > 0) {
    cmd.directives = directives;
    if (cmd.intent === 'chatter' || cmd.intent === 'clarify') {
      cmd.intent = 'directive';
      cmd.ack_line = directiveAck(directives);
    }
  }
  return cmd;
}

/**
 * Standing rules named anywhere in the line — deduped, capped — plus what is
 * LEFT of the line once the rule phrasing is taken out of it.
 *
 * The masking is the fix for a whole family of collisions. "stay back" is a
 * rule, but `stay` is in STOPS and `back` is in DIR_WORDS, so it used to halt
 * the robot mid-fight and then, failing that, drive it south. The old
 * `stopIsRule` guard only covered phrases that STARTED with "stop", so it
 * caught "stop picking things up" and missed "stay back", "stay put",
 * "no fighting" and "wait for me" — every one of which stopped the robot dead
 * while claiming to have set a policy.
 *
 * So: a matched rule phrase that contains a halt word or a heading word is cut
 * out of the text before the command heuristics ever see it. Phrases with
 * neither are left in place, because they are already unambiguous and the
 * readings that ride on them ("do whatever you want" is act_alone AND explore)
 * are worth keeping.
 */
function detectDirectives(text: string): { kinds: DirectiveKind[]; rest: string } {
  const out: DirectiveKind[] = [];
  let rest = text;
  for (const d of DIRECTIVE_PHRASES) {
    if (d.not?.some((p) => text.includes(p))) continue;
    let hit = false;
    for (const p of d.any) {
      if (!text.includes(p)) continue;
      hit = true;
      if (p.split(' ').some((w) => STOPS.has(w) || DIR_WORDS[w] !== undefined)) {
        rest = rest.split(p).join(' ');
      }
    }
    if (hit) out.push(d.kind);
  }
  return {
    kinds: [...new Set(out)].slice(0, 4),
    rest: rest.replace(/\s+/g, ' ').trim(),
  };
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
  // NOTE: there is no `stopIsRule` guard here any more. detectDirectives cuts
  // rule phrasing containing a halt or heading word out of the text before this
  // ever runs, so "stop picking things up", "stay back" and "wait for me"
  // arrive here already stripped. A bare "stop" — or "stop moving", which is
  // not a rule — still reaches STOPS untouched and still halts instantly.
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

  if (tokens.some((t) => STOPS.has(t))) {
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
    // Superlatives OUTRANK the label match on purpose: "the big printer" on a
    // floor of printers means the biggest one, and answering with the nearest
    // one is the robot ignoring the only word in the sentence that mattered.
    const sup = superlativeHostile(text, tokens, ctx.entities);
    const ent = sup ?? matchEntity(tokens, ctx.entities);
    // Elevator first: "take the exit" / "get in the lift" name no label at all,
    // and even a label-matched elevator has to go through the A/B rule before
    // it becomes an order. (A superlative can never be an elevator ask — any
    // elevator word disqualifies the superlative reading outright.)
    if (!sup && elevatorAsk(tokens, ent)) {
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

  // Deictic attack: "shoot it", "kill that thing", "get him". The operator is
  // pointing at something on the feed that we could not put a name to, and
  // "WHICH THING?" while a machine is chewing on the robot is the worst
  // possible moment to ask for precision. Rank 1 is what they meant.
  if (tokens.some((t) => ATTACK_VERBS.has(t)) && tokens.some((t) => DEICTIC.has(t))) {
    const worst = worstHostile(ctx.entities);
    if (worst) return { intent: 'attack', target: worst.id, ack_line: `ROBOT SHOOTS ${entLabel(worst)}.` };
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

  // CONVERSATION beats a shrug. A recognised topic ("how are you", "are you
  // scared", "what is this place") is answered properly even though it looks
  // like nothing the command matcher wants — this is the branch that stops the
  // keyless robot being a thing you can only issue orders to.
  if (!insult && smallTalk(text, { name: 'ROBOT', recent: [], calm: true }).matched) {
    return chat(text, ctx);
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
  // Real words, no command in them. Answer as conversation rather than with the
  // old "ROBOT HEARS VOICE. ROBOT WAITS." — which was true, and was also the
  // reason the robot felt like something you could not talk to.
  return chat(text, ctx);
}
