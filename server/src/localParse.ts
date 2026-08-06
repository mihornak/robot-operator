/**
 * Fail-soft keyword parser (source:'local'). The LLM path is the real game;
 * this keeps /api/parse answering when keys are missing, the model times out,
 * or it returns garbage twice. Same heuristics family as the client fallback.
 * Every ack obeys the toddler-speak bible: third person, ≤7 words, UPPERCASE.
 */

import { CHIPS } from '../../shared/content';
import { smallTalk } from '../../shared/smallTalk';
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
const DIRECTIVE_PHRASES: Array<{ kind: DirectiveKind; any: string[]; not?: string[] }> = [
  { kind: 'no_gather', any: ['stop picking', 'no picking', 'dont pick', 'ignore the scrap', 'ignore scrap', 'leave the scrap', 'no looting', 'dont grab'] },
  { kind: 'gather', any: ['pick everything', 'grab everything', 'pick up everything', 'take the scrap', 'grab shiny', 'loot everything', 'collect everything'] },
  // ---- combat doctrine ----------------------------------------------------
  // Above avoid_enemies deliberately: "run away from the red circles" and "keep
  // your distance" are readings the generic avoid rule would swallow whole, and
  // losing the specific one costs the operator the exact mid-fight readjustment
  // they just made — the whole reason these directives exist.
  // 'further back' is listed SEPARATELY from bare 'further' so the masking rule
  // below fires on it: it contains `back`, a heading word, and without the mask
  // "further back" set the rule and then also drove the robot south.
  // `not`: 'further' is a substring of 'furthest', which is a TARGET word
  // ("shoot the furthest one") — the superlative must not silently become a
  // doctrine change. Same for farther/farthest.
  { kind: 'keep_distance', any: ['keep your distance', 'keep distance', 'keep back', 'stay back', 'back off', 'dont get too close', 'do not get too close', 'not too close', 'too close', 'not that close', 'fight from range', 'shoot from far', 'from a distance', 'at range', 'kite', 'further back', 'farther back', 'further', 'farther', 'more distance', 'more space', 'more room'], not: ['furthest', 'farthest'] },
  // NO bare 'close': it is a substring of focus_nearest's "closest", and "kill
  // the closest one" would silently turn into a charge.
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
  // fight. Without it both fire and the later one wins, which is how an
  // operator ends up sneaking past a boss they meant to shoot at.
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

/** Enemy-ish nouns that make "avoid X" a POLICY rather than a named target. */
const ENEMY_NOUNS = ['enemy', 'enemies', 'machine', 'machines', 'printers', 'them', 'everything', 'trouble', 'danger', 'monsters', 'bad'];

const HIDE_WORDS = ['hide', 'hides', 'hiding', 'cover', 'vanish'];
const HIDE_PHRASES = ['take cover', 'get behind', 'go behind'];
/**
 * RUN. The word the game had no reading for at all, which is why "run", "flee",
 * "retreat" and "get away from it" all came back as a shrug and the operator
 * concluded the robot was not listening.
 *
 * Unambiguous by themselves — none of these is a heading, a target or a rule.
 * 'run' is deliberately NOT here; see RUN_WORDS.
 */
const FLEE_WORDS = [
  'flee', 'fleeing', 'escape', 'retreat', 'retreats', 'retreating',
  'withdraw', 'disengage', 'abort', 'bail', 'scram', 'evacuate', 'evac', 'runaway',
];
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
 * and an errand ("run to the crate"). So it only means flight once every other
 * reading has been ruled out: no heading, no named thing, no elevator, and none
 * of RUN_NOT.
 */
const RUN_WORDS = ['run', 'runs', 'running'];
const RUN_NOT = ['run around', 'run about', 'run in circles', 'run laps'];
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
  'move', 'stop', 'shoot', 'goto', 'attack', 'pickup', 'enter_elevator', 'explore', 'hide', 'flee', 'avoid',
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

/**
 * Pointing with an adjective instead of a name: "the big one", "the little
 * one", "the one shooting", "the nearest". Hostiles only — `rank` (1 = worst)
 * and `size` are populated by visibleEntities() for live hostiles and absent on
 * everything else, so this needs no kind list of its own.
 *
 * Two guards keep it from eating ordinary sentences: a non-hostile noun in the
 * line ("the big CRATE") hands it back to the label matcher, and a bare
 * adjective with no noun and no attack verb ("nearest first" — a RULE, not a
 * target) resolves to nothing. Zero hostiles visible always returns null, so a
 * superlative never becomes a mysterious miss.
 */
const SUP_BIG = [
  'big', 'bigger', 'biggest', 'large', 'larger', 'largest', 'huge', 'giant',
  'boss', 'dangerous', 'worst', 'scary', 'scariest', 'nastiest', 'toughest',
];
const SUP_SMALL = ['little', 'small', 'smaller', 'smallest', 'tiny', 'weakest', 'weedy'];
const SUP_NEAR = ['nearest', 'closest', 'nearby'];
const SUP_FAR = ['farthest', 'furthest'];
/** Phrases meaning "whatever is currently doing something to us" → rank 1. */
const SUP_ACTIVE = ['one shooting', 'one thats shooting', 'one attacking', 'shooting at', 'hitting us', 'hitting you'];
/** A superlative is a TARGET only when it has one of these to be about. */
const SUP_NOUNS = [
  'one', 'ones', 'thing', 'things', 'machine', 'machines', 'printer', 'printers',
  'shredder', 'shredders', 'enemy', 'enemies', 'monster', 'monsters', 'baddie', 'guy',
];
/** ...and any of these means the operator is talking about scenery, not a
 *  machine. "the big crate" must stay a crate even while three printers are
 *  awake, which is exactly when the superlative path is most tempting. */
const NON_HOSTILE_WORDS = [
  'crate', 'crates', 'box', 'boxes', 'chest', 'container', 'present', 'package', 'cube',
  'chip', 'chips', 'upgrade', 'module', 'card', 'scrap', 'shiny', 'junk', 'metal', 'loot', 'bits',
  'cable', 'cables', 'wire', 'wires', 'spark', 'sparks', 'electricity',
  'elevator', 'elevators', 'lift', 'lifts', 'exit', 'door', 'doors', 'doorway',
  'fuse', 'socket', 'mop', 'chair', 'pile', 'debris', 'heap', 'room', 'floor', 'wall',
  'gun', 'guns', 'rocket', 'rockets', 'bolt', 'bolts', 'circle', 'circles',
];
/** Deictic stand-ins: the operator is pointing at something they can see. */
const DEICTIC = ['it', 'that', 'this', 'them', 'those', 'him', 'her', 'one', 'thing', 'things', 'guy'];

function sizeRank(e: ParseEntity): number {
  return e.size === 'boss' ? 2 : e.size === 'big' ? 1 : 0;
}

function hostilesOf(entities: ParseEntity[]): ParseEntity[] {
  return entities.filter((e) => e.rank !== undefined);
}

/** Rank 1 — the thing most likely to kill the robot next. */
function worstHostile(entities: ParseEntity[]): ParseEntity | null {
  const hs = hostilesOf(entities);
  if (hs.length === 0) return null;
  return hs.reduce((a, b) => (a.rank! <= b.rank! ? a : b));
}

function superlativeHostile(text: string, toks: string[], entities: ParseEntity[]): ParseEntity | null {
  const hs = hostilesOf(entities);
  if (hs.length === 0) return null;
  if (has(toks, NON_HOSTILE_WORDS)) return null;
  if (SUP_ACTIVE.some((p) => text.includes(p))) return worstHostile(entities);
  const big = has(toks, SUP_BIG);
  const small = has(toks, SUP_SMALL);
  const near = has(toks, SUP_NEAR);
  const far = has(toks, SUP_FAR);
  if (!big && !small && !near && !far) return null;
  if (!has(toks, SUP_NOUNS) && !has(toks, ATTACK_VERBS)) return null;
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

/**
 * Is this line the operator telling the robot to GET OUT? Runs on the whole
 * line, not on detectDirectives' leftovers, because "back off" is both a flee
 * phrase and a keep_distance phrase and the mask eats it (`back` is a heading
 * word) before `rest` is built. Both readings are wanted: run now, keep back
 * afterwards.
 */
function fleeAsk(text: string, toks: string[], entities: ParseEntity[]): boolean {
  if (FLEE_NOT.some((p) => text.includes(p))) return false;
  if (has(toks, FLEE_WORDS)) return true;
  if (FLEE_PHRASES.some((p) => text.includes(p))) return true;
  if (!has(toks, RUN_WORDS)) return false;
  if (RUN_NOT.some((p) => text.includes(p))) return false;
  if (findDir(toks) !== undefined) return false; // "run left" is a heading
  if (has(toks, ELEVATOR_NOUNS)) return false;
  return matchEntity(toks, entities) === null; // "run to the crate" is an errand
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
 * Standing rules named anywhere in the line — deduped, first-match per pair —
 * plus what is LEFT of the line once the rule phrasing is taken out of it.
 *
 * The masking fixes a whole family of collisions. "stay back" is a rule, but
 * `stay` is in STOP_WORDS and `back` is in DIR_WORDS, so it used to halt the
 * robot mid-fight and then, failing that, drive it south. The old `stopIsRule`
 * guard only covered phrases that STARTED with "stop", so it caught "stop
 * picking things up" and missed "stay back", "stay put", "no fighting" and
 * "wait for me" — each of which stopped the robot dead while claiming to have
 * set a policy.
 *
 * A matched rule phrase containing a halt word or a heading word is therefore
 * cut out of the text before the command heuristics ever see it. Phrases with
 * neither are left in place: they are already unambiguous, and the readings
 * that ride on them ("do whatever you want" is act_alone AND explore) are worth
 * keeping.
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
      if (p.split(' ').some((w) => STOP_WORDS.includes(w) || DIR_WORDS[w] !== undefined)) {
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
  keep_distance: 'STAYS BACK. SHOOTS FROM FAR.',
  close_in: 'GETS CLOSE. VERY CLOSE.',
  dodge_projectiles: 'DODGES NOW. IS SLIPPERY.',
  ignore_projectiles: 'IGNORES FLYING THINGS. BRAVE.',
  keep_moving: 'NEVER STOPS. ZOOMS FOREVER.',
  hold_ground: 'STANDS HERE. LIKE TREE.',
  focus_dangerous: 'KILLS BIG ONE FIRST.',
  focus_nearest: 'FIGHTS NEAREST. VERY TIDY.',
  use_rockets: 'USES BIG PEW PEW.',
  use_bolts: 'USES SMALL PEW. TIDY.',
};

/**
 * One rule as a bare verb phrase, for the case where the operator changed TWO
 * things in one breath. "keep your distance and dodge the rockets" answered
 * with only the first rule's ack is the operator's evidence that the second one
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
function directiveAck(kinds: readonly DirectiveKind[], name: string): string {
  if (kinds.length <= 1) return `${name} ${DIRECTIVE_ACK[kinds[0]!]}`;
  return kinds
    .slice(0, 2)
    .map((k) => `${name} ${DIRECTIVE_CLAUSE[k]}.`)
    .join(' ');
}

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
  const { kinds: directives, rest } = detectDirectives(text);

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
  // After hide ("run and hide" is a hide) and before every heuristic below it:
  // half this vocabulary would otherwise be read as a heading ('back off',
  // 'fall back') or as an errand with a missing noun ('get away' → PICKUP_VERB
  // → "WHICH THING?"), which is exactly how it failed in the playtest.
  if (fleeAsk(text, toks, req.entities)) {
    const cmd: ParsedCommand = { intent: 'flee', ack_line: `${name} RUNS AWAY. VERY TACTICAL.` };
    if (directives.length > 0) cmd.directives = directives;
    return cmd;
  }

  const cmd = basicCommand(rest, rest.split(' ').filter(Boolean), req, name);
  if (carefulAsk && (cmd.intent === 'move' || cmd.intent === 'goto' || cmd.intent === 'pickup')) {
    cmd.careful = true;
    cmd.ack_line = `${name} SNEAKS. VERY QUIET.`;
  }
  if (directives.length > 0) {
    cmd.directives = directives;
    // A rule with nothing to do attached is still an instruction, not noise.
    if (cmd.intent === 'chatter' || cmd.intent === 'clarify') {
      cmd.intent = 'directive';
      cmd.ack_line = directiveAck(directives, name);
    }
  }
  return cmd;
}

/** Pre-BRAIN heuristics (dir/stop/help/targets/shoot/chatter), unchanged family. */
function basicCommand(text: string, toks: string[], req: ParseRequest, name: string): ParsedCommand {
  const insult = has(toks, INSULT_WORDS);
  const dir = findDir(toks);
  const amount = has(toks, STEP_WORDS) ? ('step' as const) : has(toks, BIT_WORDS) ? ('bit' as const) : undefined;
  // NOTE: there is no `stopIsRule` guard here any more. detectDirectives cuts
  // rule phrasing containing a halt or heading word out of the text before this
  // runs, so "stop picking things up", "stay back" and "wait for me" arrive
  // already stripped. A bare "stop" — or "stop moving", which is not a rule —
  // still reaches STOP_WORDS untouched and still halts instantly.

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
      ack_line: `${name} GOES. FIGHTS. HIDES. GRABS.`,
    };
  }

  if (req.tier >= 1) {
    // Superlatives OUTRANK the label match on purpose: "the big printer" on a
    // floor of printers means the biggest one, and answering with the nearest
    // is the robot ignoring the only word in the sentence that mattered.
    const sup = superlativeHostile(text, toks, req.entities);
    const target = sup ?? matchEntity(toks, req.entities);
    // Elevator first: "take the exit" / "get in the lift" name no label at all,
    // and even a label-matched elevator has to go through the A/B rule before
    // it becomes an order. (A superlative can never be an elevator ask — any
    // elevator word disqualifies the superlative reading outright.)
    if (!sup && elevatorAsk(toks, target)) {
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

  // Deictic attack: "shoot it", "kill that thing", "get him". The operator is
  // pointing at something on the feed we could not put a name to, and asking
  // "WHICH THING?" while a machine is chewing on the robot is the worst
  // possible moment to demand precision. Rank 1 is what they meant.
  if (has(toks, ATTACK_VERBS) && has(toks, DEICTIC)) {
    const worst = worstHostile(req.entities);
    if (worst) {
      return { intent: 'attack', target: worst.id, ack_line: `${name} FIGHTS ${labelWord(worst)}. PEW PEW.` };
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
  // CONVERSATION. Greetings, praise and question words used to get one canned
  // sentence each; they now go through the same bank as everything else, which
  // is several sentences and does not repeat itself.
  if (has(toks, GREETINGS) || has(toks, PRAISE) || has(toks, QUESTION_WORDS)) {
    return chat(req, name);
  }
  const talk = smallTalk(req.utterance, { name, recent: req.recent, calm: req.calm });
  if (talk.matched) return { intent: 'chatter', ack_line: talk.lines[0]!, talk: talk.lines };
  // Real words we just don't understand: ADMIT it, naming what we heard.
  // "VOICE IS MUMBLY" is reserved for genuinely empty/garbled input — an
  // unknown command answered with "mumbly" reads as broken, not funny.
  const salient = [...toks].sort((a, b) => b.length - a.length)[0];
  return {
    intent: 'clarify',
    ack_line: salient ? `${name} NOT KNOW ${salient.toUpperCase()}.` : 'VOICE IS MUMBLY. AGAIN?',
  };
}

/** Keyless conversational answer. `ack_line` is the log/OSD line; `talk` is the
 *  run the robot speaks. See shared/smallTalk.ts. */
function chat(req: ParseRequest, name: string): ParsedCommand {
  const { lines } = smallTalk(req.utterance, { name, recent: req.recent, calm: req.calm });
  return { intent: 'chatter', ack_line: lines[0]!, talk: lines };
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
