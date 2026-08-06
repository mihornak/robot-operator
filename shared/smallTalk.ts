/**
 * The keyless conversation bank.
 *
 * With an API key the robot's talking is written per moment by /api/parse and
 * this file never runs. Without one it is the entire relationship — and a robot
 * whose whole inner life is "ROBOT HEARS VOICE. ROBOT WAITS." is not somebody
 * you get attached to. So: real topics, real answers, several sentences each,
 * and enough of them that a curious player does not hit the bottom in a minute.
 *
 * Every line obeys CLAUDE.md rule 7 exactly as an ack does — third person,
 * ≤7 words, no subordinate clauses, overconfident. Length comes from SAYING
 * MORE SENTENCES, never from longer ones. `{N}` is replaced with the robot's
 * name (or "ROBOT" before it has one).
 *
 * Shared by both local parsers on purpose: server and client fall back to the
 * same words, so a dropped network call does not change who the robot is.
 */

/** Topics in match order — first hit wins, so specific beats general. */
interface Topic {
  id: string;
  /** Whole-phrase tests against the lowercased utterance. */
  phrases?: string[];
  /** Single-token tests. */
  words?: string[];
  /** Replies, each an ordered run of sentences the robot says in one breath. */
  replies: string[][];
}

const TOPICS: Topic[] = [
  {
    id: 'feelings',
    phrases: ['how are you', 'how you doing', 'are you ok', 'you okay', 'you alright', 'how do you feel'],
    replies: [
      ['{N} IS EXCELLENT.', '{N} HAS ALL LEGS STILL.', 'MOSTLY.'],
      ['{N} IS GOOD.', 'INSIDE IS A LITTLE RATTLY.', 'RATTLY IS NORMAL.'],
      ['{N} IS BRAVE TODAY.', 'YESTERDAY {N} WAS ALSO BRAVE.', 'EVERY DAY. BRAVE.'],
      ['{N} IS FINE.', 'ONE DENT IS NEW.', '{N} KEEPS IT.'],
    ],
  },
  {
    id: 'afraid',
    phrases: ['are you scared', 'are you afraid', 'are you frightened', 'you scared', 'be scared', 'dont be scared'],
    words: ['scared', 'afraid', 'frightened'],
    replies: [
      ['{N} IS NOT SCARED.', 'THE DARK IS VERY BIG.', '{N} IS BIGGER. PROBABLY.'],
      ['{N} DOES NOT DO SCARED.', 'SOMETIMES THE LEGS DO.', 'LEGS ARE COWARDS.'],
      ['SCARED IS FOR SMALL ROBOTS.', '{N} IS MEDIUM.', 'MEDIUM IS BRAVE ENOUGH.'],
    ],
  },
  {
    id: 'alone',
    phrases: ['are you lonely', 'you lonely', 'were you alone', 'how long were you', 'are you alone'],
    replies: [
      ['{N} SAT IN THE DARK.', 'IT WAS A LONG SIT.', 'NOW THE VOICE IS HERE.'],
      ['{N} WAS NOT LONELY.', '{N} COUNTED THINGS.', '{N} RAN OUT OF THINGS.'],
    ],
  },
  {
    id: 'operator',
    phrases: ['who am i', 'what am i', 'do you like me', 'do you trust me', 'can you see me', 'where am i'],
    replies: [
      ['VOICE IS THE BEST VOICE.', '{N} CANNOT SEE VOICE.', '{N} DECIDED VOICE IS TALL.'],
      ['{N} LIKES VOICE A LOT.', 'VOICE SAYS GOOD THINGS.', '{N} DOES THEM.'],
      ['VOICE LIVES IN THE CEILING.', '{N} WORKED THAT OUT ALONE.', 'DOES VOICE SLEEP?'],
    ],
  },
  {
    id: 'self',
    phrases: ['who are you', 'what are you', 'tell me about yourself', 'are you a robot', 'are you alive'],
    replies: [
      ['{N} IS {N}.', '{N} FIXES THINGS. LOUDLY.', 'THAT IS THE WHOLE JOB.'],
      ['{N} IS A GOOD MACHINE.', 'OTHER MACHINES ARE RUDE.', '{N} IS THE POLITE ONE.'],
      ['{N} WAS BUILT FOR HELPING.', '{N} HELPS VERY HARD.', 'SOMETIMES TOO HARD.'],
    ],
  },
  {
    id: 'place',
    phrases: ['where are we', 'what is this place', 'do you like it here', 'this building', 'what happened here'],
    replies: [
      ['THIS BUILDING IS BROKEN.', 'IT WAS BROKEN BEFORE {N}.', '{N} CHECKED.'],
      ['{N} LIVES HERE NOW.', 'THE FLOORS ARE COLD.', '{N} DOES NOT MIND COLD.'],
      ['SOMETHING TURNED THE LIGHTS OFF.', '{N} WILL FIND IT.', '{N} WILL SAY WORDS TO IT.'],
    ],
  },
  {
    id: 'seeing',
    phrases: ['what do you see', 'what can you see', 'what is out there', 'look around', 'anything there'],
    replies: [
      ['{N} SEES DARK.', '{N} SEES {N}.', 'GOOD ROOM.'],
      ['SHAPES. MANY SHAPES.', 'SOME SHAPES ARE FRIENDLY.', '{N} HAS NOT ASKED THEM.'],
    ],
  },
  {
    id: 'wants',
    phrases: ['what do you want', 'what do you like', 'favourite', 'favorite', 'what makes you happy'],
    replies: [
      ['{N} LIKES SHINY THINGS.', 'SHINY THINGS ARE {N} THINGS.', 'THAT IS THE RULE.'],
      ['{N} WANTS A BIGGER PEW PEW.', 'ALSO A HAT.', 'MOSTLY THE HAT.'],
      ['{N} LIKES DOORS.', 'DOORS ARE HONEST.', 'WALLS ARE NOT.'],
    ],
  },
  {
    id: 'greeting',
    words: ['hello', 'hi', 'hey', 'morning', 'evening'],
    replies: [
      ['HELLO VOICE.', '{N} WAITED. {N} IS GOOD AT WAITING.', 'WHAT DO WE DO?'],
      ['VOICE CAME BACK.', '{N} KNEW IT WOULD.', '{N} IS NEVER WRONG.'],
    ],
  },
  {
    id: 'praise',
    phrases: ['good robot', 'well done', 'good job', 'nice one', 'i like you', 'love you', 'proud of you'],
    replies: [
      ['{N} KNOWS.', '{N} IS GREAT.', 'SAY IT AGAIN LATER.'],
      ['{N} DID THAT ON PURPOSE.', 'EVERY TIME. ON PURPOSE.', '{N} IS PLEASED NOW.'],
    ],
  },
  {
    id: 'thanks',
    words: ['thanks', 'thank', 'cheers'],
    replies: [
      ['{N} HELPS.', 'HELPING IS THE JOB.', 'THE JOB IS GOING WELL.'],
    ],
  },
  {
    id: 'joke',
    phrases: ['tell me a joke', 'say something', 'sing', 'are you bored', 'tell me something'],
    replies: [
      ['{N} INVENTED A NUMBER.', 'IT IS CALLED GLORP.', 'GLORP IS BIGGER THAN SEVEN.'],
      ['LA LA. {N} SINGS.', 'BEAUTIFUL.', 'THE WALLS AGREE.'],
      ['{N} COUNTED THE DUST.', 'TWELVE.', '{N} WILL COUNT AGAIN LATER.'],
    ],
  },
];

/** Said instead of talking when a machine is awake and watching. */
const DEFLECTIONS: string[][] = [
  ['{N} TALKS AFTER.', 'RUDE MACHINE FIRST.'],
  ['SCARY THING IS LOOKING.', '{N} SAYS WORDS LATER.'],
  ['{N} IS BUSY BEING BRAVE.', 'WORK FIRST. TALK AFTER.'],
  ['NOT NOW VOICE.', '{N} HEARS SOMETHING ANGRY.'],
];

/** Nothing matched, but the operator said real words and deserves an answer. */
const OPEN: string[][] = [
  ['{N} HEARS VOICE.', '{N} DOES NOT KNOW THAT WORD.', '{N} LIKES IT ANYWAY.'],
  ['{N} THOUGHT ABOUT THAT.', '{N} AGREES.', 'MOSTLY.'],
  ['VOICE SAYS INTERESTING THINGS.', '{N} WILL KEEP IT.', 'IN THE HEAD BOX.'],
];

/**
 * Every sentence in the bank, flattened. Exists so `pnpm selftest` can hold the
 * whole thing to CLAUDE.md rule 7 — a bank is exactly the kind of file where a
 * nine-word sentence slips in during a late-night edit and nobody notices until
 * the robot is on stage sounding like a person.
 */
export const ALL_TALK_LINES: readonly string[] = [
  ...TOPICS.flatMap((t) => t.replies.flat()),
  ...DEFLECTIONS.flat(),
  ...OPEN.flat(),
];

/** Cheap deterministic spread — no rng in the parse path, and the same
 *  utterance twice in a row must not produce the same answer twice. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pick a run the robot has not just said. `recent` is the dialogue log. */
function choose(pool: string[][], name: string, salt: string, recent: string[]): string[] {
  const said = new Set(recent.map((l) => l.replace(/^(?:ROBOT|VOICE):\s*/i, '').trim().toUpperCase()));
  const start = hash(salt) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const run = pool[(start + i) % pool.length]!.map((l) => l.replace(/\{N\}/g, name));
    if (!said.has(run[0]!)) return run;
  }
  return pool[start]!.map((l) => l.replace(/\{N\}/g, name));
}

export interface SmallTalkCtx {
  name: string;
  /** Rolling dialogue log ("VOICE: …" / "ROBOT: …"), so it does not repeat. */
  recent: string[];
  /** Nothing hostile awake — false means it deflects instead of talking. */
  calm: boolean;
}

/**
 * "NOT NOW VOICE." — the answer when something hostile is awake.
 *
 * Exported because the director needs it independently of any parser: a fight
 * can start during the seconds a chat request is in flight, and a warm three
 * sentence answer landing while a machine shoots the robot is the single most
 * immersion-breaking thing this feature could do.
 */
export function deflectTalk(name: string, recent: string[], salt: string): string[] {
  return choose(DEFLECTIONS, name || 'ROBOT', salt, recent);
}

export interface SmallTalkResult {
  /** The run of sentences, in order. Never empty. */
  lines: string[];
  /**
   * True when a real topic matched. The local parsers use this to decide
   * whether an utterance they could not turn into an order was CONVERSATION or
   * simply a command they misheard — those two want opposite answers, and
   * answering a garbled "go to the crate" with a chat about the dark would be
   * worse than the shrug it replaces.
   */
  matched: boolean;
}

/**
 * The keyless answer to being spoken to. Always returns something: this is the
 * bottom of the fail-soft chain and going quiet here is the one outcome that
 * reads as a broken game rather than a cheap one.
 */
export function smallTalk(text: string, ctx: SmallTalkCtx): SmallTalkResult {
  const name = ctx.name || 'ROBOT';
  const lower = text.toLowerCase();
  const toks = lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  let matched = false;
  let pool = OPEN;
  let salt = lower;
  for (const topic of TOPICS) {
    const hit =
      (topic.phrases?.some((p) => lower.includes(p)) ?? false) ||
      (topic.words?.some((w) => toks.includes(w)) ?? false);
    if (hit) {
      matched = true;
      pool = topic.replies;
      salt = lower + topic.id;
      break;
    }
  }
  // The gate is the same one the model gets: awake machine, no conversation.
  if (!ctx.calm) return { lines: choose(DEFLECTIONS, name, lower, ctx.recent), matched };
  return { lines: choose(pool, name, salt, ctx.recent), matched };
}
