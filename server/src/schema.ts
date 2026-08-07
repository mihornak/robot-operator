/**
 * Zod mirrors of the shared parser enums (shared/types.ts is the source of
 * truth — the `satisfies` + exhaustiveness aliases below break the build if
 * either side drifts) and validation/normalization of LLM output.
 */

import { z } from 'zod';
import type {
  ChipId,
  Dir,
  DirectiveKind,
  EntityKind,
  IntentType,
  ParsedCommand,
  ParseRequest,
  PlanStep,
  SayRequest,
  SayResponse,
  WishlistRequest,
} from '../../shared/types';
import { defaultStanding } from '../../shared/types';

export const INTENTS = [
  'move',
  'stop',
  'shoot',
  'goto',
  'attack',
  'pickup',
  'enter_elevator',
  'explore',
  'name_robot',
  'choose',
  'hide',
  'flee',
  'avoid',
  'directive',
  'affirm',
  'deny',
  'robot_choice',
  'clarify',
  'chatter',
] as const satisfies readonly IntentType[];

/** Intents allowed inside an "X then Y" chain (commands only, no meta). */
export const CHAIN_INTENTS = [
  'move',
  'stop',
  'shoot',
  'goto',
  'attack',
  'pickup',
  'enter_elevator',
  'explore',
  'hide',
  // "shoot it, then run" is an ordinary sentence. A panic order that could not
  // be the tail of a plan would be a panic order the operator has to say twice.
  'flee',
  'avoid',
] as const satisfies readonly IntentType[];

export const DIRECTIVE_KINDS = [
  'avoid_enemies',
  'fight_enemies',
  'avoid_hazards',
  'ignore_hazards',
  'gather',
  'no_gather',
  'careful',
  'bold',
  'act_alone',
  'wait_for_orders',
  'keep_distance',
  'close_in',
  'dodge_projectiles',
  'ignore_projectiles',
  'keep_moving',
  'hold_ground',
  'focus_dangerous',
  'focus_nearest',
  'use_rockets',
  'use_bolts',
] as const satisfies readonly DirectiveKind[];

export const DIRS = ['up', 'down', 'left', 'right'] as const satisfies readonly Dir[];

export const AMOUNTS = ['bit', 'step'] as const satisfies readonly NonNullable<
  ParsedCommand['amount']
>[];

export const CHIP_IDS = [
  'MAGNET',
  'RAGE',
  'SCARED',
  'MEMORY',
  'ZAP',
  'TOUGH',
] as const satisfies readonly ChipId[];

export const ENTITY_KINDS = [
  'scrap',
  'chip',
  'debris',
  'crate',
  'cable',
  'fusedPrinter',
  'fusedShredder',
  'printerInnocent',
  'mop',
  'chair',
  'fuse',
  'fuseSocket',
  'elevatorA',
  'elevatorB',
] as const satisfies readonly EntityKind[];

// Compile-time: every member of the shared union appears in the mirror array.
type AssertExhaustive<T extends never> = T;
type AssertAssignable<T extends U, U> = T;
type _Intents = AssertExhaustive<Exclude<IntentType, (typeof INTENTS)[number]>>;
type _Dirs = AssertExhaustive<Exclude<Dir, (typeof DIRS)[number]>>;
type _Amounts = AssertExhaustive<
  Exclude<NonNullable<ParsedCommand['amount']>, (typeof AMOUNTS)[number]>
>;
type _Chips = AssertExhaustive<Exclude<ChipId, (typeof CHIP_IDS)[number]>>;
type _Kinds = AssertExhaustive<Exclude<EntityKind, (typeof ENTITY_KINDS)[number]>>;
type _Directives = AssertExhaustive<Exclude<DirectiveKind, (typeof DIRECTIVE_KINDS)[number]>>;

const standingSchema = z.object({
  avoidEnemies: z.boolean(),
  fight: z.boolean(),
  hunt: z.boolean().default(false),
  avoidHazards: z.boolean(),
  gather: z.boolean(),
  careful: z.boolean(),
  autonomy: z.boolean(),
  roam: z.boolean().default(false),
  avoidIds: z.array(z.string()).default([]),
  // Every combat-doctrine field carries its default: a client running last
  // week's bundle sends none of them, and a missing key must degrade to
  // today's behaviour rather than 400 the whole utterance.
  spacing: z.enum(['auto', 'far', 'close']).default('auto'),
  focus: z.enum(['auto', 'dangerous', 'nearest']).default('auto'),
  dodgeZones: z.boolean().default(false),
  keepMoving: z.boolean().default(false),
  weapon: z.enum(['bolt', 'rocket']).default('bolt'),
});

/** z.object STRIPS unknown keys — anything absent here NEVER reaches the model,
 *  silently and with a green build. `rank`/`size` are the fields "shoot the big
 *  one" binds to, so leaving them out fails as a mysteriously stupid parser. */
const parseEntitySchema = z.object({
  id: z.string(),
  kind: z.enum(ENTITY_KINDS),
  label: z.string(),
  dir: z.string().optional(),
  dist: z.number().optional(),
  rank: z.number().optional(),
  size: z.enum(['small', 'big', 'boss']).optional(),
});

/** Incoming /api/parse body. Defaults keep hand-rolled curl requests working. */
/**
 * A recorded press from a browser with no speech recognition of its own.
 * ~1.4 MB of base64 is 12s of 16 kHz mono WAV — the client's own cap, restated
 * here because a request body is never trusted for its size.
 */
export const audioClipSchema = z.object({
  data: z.string().min(64).max(1_500_000),
  format: z.literal('wav'),
  ms: z.number().int().min(0).max(20000).default(0),
});

export const parseRequestSchema = z.object({
  // Empty when `audio` carries the utterance — the refine below enforces that
  // one of the two is actually present.
  utterance: z.string().default(''),
  audio: audioClipSchema.nullish(),
  alternatives: z.array(z.string()).max(5).default([]),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
  floor: z.number().int().default(1),
  robotName: z.string().nullable().default(null),
  personality: z.array(z.enum(CHIP_IDS)).default([]),
  options: z.array(z.enum(CHIP_IDS)).nullable().default(null),
  awaitingName: z.boolean().default(false),
  brain: z.boolean().default(true),
  entities: z.array(parseEntitySchema).default([]),
  recent: z.array(z.string()).default([]),
  shouted: z.boolean().default(false),
  standing: standingSchema.default(defaultStanding()),
  pendingQuestion: z.string().nullable().default(null),
  busy: z.string().nullable().default(null),
  hp: z.number().default(6),
  maxHp: z.number().default(6),
  carrying: z.boolean().default(false),
  // Defaults FALSE: an old client that does not send it gets the terse,
  // combat-safe behaviour rather than a robot chatting through a firefight.
  calm: z.boolean().default(false),
}).refine((r) => r.utterance.length > 0 || !!r.audio, {
  message: 'utterance or audio required',
});

/** Incoming /api/say body — the unprompted-speech channel. */
export const sayRequestSchema = z.object({
  trigger: z
    .enum([
      'floor_start',
      'self_order',
      'found',
      'enemy_spotted',
      'hurt',
      'blocked',
      'idle_ask',
      'arrived',
      'banter',
    ])
    .default('banter'),
  detail: z.string().max(240).default(''),
  floor: z.number().int().default(1),
  robotName: z.string().nullable().default(null),
  personality: z.array(z.enum(CHIP_IDS)).default([]),
  standing: standingSchema.default(defaultStanding()),
  ideas: z.boolean().default(false),
  hp: z.number().default(6),
  maxHp: z.number().default(6),
  carrying: z.boolean().default(false),
  entities: z.array(parseEntitySchema).default([]),
  recent: z.array(z.string()).default([]),
});

/**
 * Something-shaped-like-an-email, deliberately not `z.string().email()`: zod's
 * built-in has changed its mind about what it accepts across releases, and the
 * only thing standing between a player and a restart must not be a moving
 * target. One @, dots after it, no spaces — the mail server decides the rest.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Incoming /api/wishlist body — the email gate on the death card. */
export const wishlistRequestSchema = z.object({
  // Order matters: trim and lowercase run before the length and shape checks,
  // so " Foo@Bar.COM " is stored the same way it will be typed next time.
  email: z.string().trim().toLowerCase().max(254).regex(EMAIL_RE),
  floor: z.number().int().min(1).max(99).optional(),
  robotName: z.string().max(40).optional(),
});

// Compile-time: the parsed body still is a WishlistRequest.
type _Wishlist = AssertAssignable<z.infer<typeof wishlistRequestSchema>, WishlistRequest>;

/**
 * One queued step of a plan. Flat and non-recursive on purpose: a step has no
 * plan of its own and no meta fields, so "do A then B then C" is an ARRAY, not
 * a linked list the model has to nest correctly under a strict JSON schema.
 */
export const llmPlanStepSchema = z.object({
  intent: z.enum(CHAIN_INTENTS),
  dir: z.enum(DIRS).nullish(),
  amount: z.enum(AMOUNTS).nullish(),
  steps: z.number().int().min(1).max(8).nullish(),
  careful: z.boolean().nullish(),
  target: z.string().nullish(),
  ack_line: z.string().nullish(),
});

/** How many steps the robot will hold beyond the one it is doing. */
export const MAX_PLAN_STEPS = 4;

/** Raw model output shape — nullable everywhere because strict JSON-schema mode requires all keys present. */
export const llmOutputSchema = z.object({
  intent: z.enum(INTENTS),
  dir: z.enum(DIRS).nullish(),
  amount: z.enum(AMOUNTS).nullish(),
  steps: z.number().int().min(1).max(8).nullish(),
  careful: z.boolean().nullish(),
  target: z.string().nullish(),
  choice: z.enum(CHIP_IDS).nullish(),
  name: z.string().nullish(),
  plan: z.array(llmPlanStepSchema).max(MAX_PLAN_STEPS).nullish(),
  directives: z.array(z.enum(DIRECTIVE_KINDS)).max(4).nullish(),
  ack_line: z.string(),
  // Only asked for on the audio path: the model's own transcript, so the
  // dialogue log still has the player's side. Never displayed (rule 6).
  heard: z.string().nullish(),
  insult: z.boolean().nullish(),
  // The conversation channel. An array rather than a paragraph so the toddler
  // cap can be enforced per sentence and the director can pace them.
  talk: z.array(z.string()).max(6).nullish(),
});

/** Raw /api/say model output. */
export const sayOutputSchema = z.object({
  line: z.string(),
  question: z.boolean().nullish(),
  proposal: z
    .object({
      intent: z.enum(INTENTS),
      target: z.string().nullish(),
      dir: z.enum(DIRS).nullish(),
      // A briefing's best answer is often a RULE, not a destination — "SHOULD
      // ROBOT KEEP BACK?" is the single most useful thing it can ask when it
      // walks into a room with three machines in it. Without this field "yes"
      // has nothing to mean and the question is decoration.
      directives: z.array(z.enum(DIRECTIVE_KINDS)).max(4).nullish(),
    })
    .nullish(),
});

/** Lowercase, strip punctuation, collapse whitespace — ack/utterance compare. */
function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Toddler-speak gate: non-empty, ≤8 norm words, never a verbatim transcript echo. */
function validAck(ack: string, req: Pick<ParseRequest, 'utterance'>): string | null {
  const t = ack.trim();
  if (!t) return null;
  const ackNorm = normText(t);
  if (ackNorm.split(' ').length > 8) return null; // toddler-speak cap blown
  const uttNorm = normText(req.utterance);
  // verbatim transcript echo is forbidden (CLAUDE.md rule 6)
  if (uttNorm.split(' ').length >= 3 && ackNorm.includes(uttNorm)) return null;
  return t.toUpperCase();
}

/** How many sentences of rambling the robot is allowed in one breath. Four is
 *  already a long time to stand still listening to a robot; beyond that it
 *  stops being a friend answering and starts being a cutscene. */
const MAX_TALK_LINES = 4;

/**
 * The conversation channel, held to exactly the same toddler-speak gate as an
 * ack — one sentence at a time. This is the whole trick that lets the robot
 * talk at length without the voice collapsing: a bad sentence is DROPPED, not
 * fatal, so one over-long clause costs that line and nothing else.
 */
function validTalk(
  talk: string[] | null | undefined,
  req: Pick<ParseRequest, 'utterance'>,
): string[] | undefined {
  if (!talk || talk.length === 0) return undefined;
  const out: string[] = [];
  for (const raw of talk) {
    // A model that ignores the array and writes a paragraph into one slot is
    // recoverable: split it back into sentences and gate each one.
    for (const piece of raw.split(/(?<=[.!?])\s+/)) {
      const line = validAck(piece, req);
      if (!line) continue;
      if (out.includes(line)) continue; // it repeated itself; once is enough
      out.push(line);
      if (out.length >= MAX_TALK_LINES) return out;
    }
  }
  return out.length > 0 ? out : undefined;
}

const CHAINABLE = new Set<IntentType>(CHAIN_INTENTS);

/** Canned acks when the model skips/blows a plan step's own ack_line. */
const THEN_ACKS: Record<(typeof CHAIN_INTENTS)[number], string> = {
  move: 'THEN ROBOT GOES.',
  stop: 'THEN ROBOT STOPS.',
  shoot: 'THEN PEW PEW.',
  goto: 'THEN ROBOT GOES THERE.',
  attack: 'THEN ROBOT FIGHTS.',
  pickup: 'THEN ROBOT GRABS IT.',
  enter_elevator: 'THEN ELEVATOR.',
  explore: 'THEN ROBOT LOOKS AROUND.',
  hide: 'THEN ROBOT HIDES.',
  flee: 'THEN ROBOT RUNS AWAY.',
  avoid: 'THEN ROBOT AVOIDS IT.',
};

/** ParseEntity.dir strings ("left of robot") → the Dir a tier-0 lunge uses. */
function bearingToDir(bearing: string | undefined): Dir | null {
  if (!bearing) return null;
  if (bearing.startsWith('left')) return 'left';
  if (bearing.startsWith('right')) return 'right';
  if (bearing.startsWith('above')) return 'up';
  if (bearing.startsWith('below')) return 'down';
  return null;
}

/** Fields the coherence check consumes (superset of top-level and `then` shapes). */
interface RawFields {
  intent: IntentType;
  dir?: Dir | null;
  amount?: NonNullable<ParsedCommand['amount']> | null;
  steps?: number | null;
  careful?: boolean | null;
  target?: string | null;
  choice?: ChipId | null;
  name?: string | null;
  directives?: DirectiveKind[] | null;
}

/** Resolve a model-provided target to a real entity id (label echo tolerated). */
function resolveTarget(
  t: string | null | undefined,
  req: ParseRequest,
  intent: IntentType,
): string | undefined {
  let target = t ?? undefined;
  if (target && !req.entities.some((e) => e.id === target)) {
    // Model echoed a label instead of an id — resolve if unambiguous.
    const byLabel = req.entities.filter((e) => e.label.toLowerCase() === target!.toLowerCase());
    target = byLabel.length === 1 ? byLabel[0].id : undefined;
  }
  const exit = req.entities.find((e) => e.kind === 'elevatorB')?.id;
  if (!target && intent === 'enter_elevator') target = exit;
  // Elevator A is dead scenery — the shaft the robot rode IN on. Sending the
  // robot to it is always a wasted trip and always reads as the robot being
  // stupid, so it is never a valid destination: any elevator target becomes
  // the live one. There is exactly one working lift per floor.
  if (target && exit) {
    const picked = req.entities.find((e) => e.id === target);
    if (picked?.kind === 'elevatorA') target = exit;
  }
  return target;
}

/**
 * Coherence-check ONE command against the request (tier/brain gates, real
 * entity ids, option in triad). Shared by the top-level command and its
 * one-level `then`. Returns null when invalid.
 */
function coherent(v: RawFields, req: ParseRequest, ack: string): ParsedCommand | null {
  const cmd: ParsedCommand = { intent: v.intent, ack_line: ack };
  switch (v.intent) {
    case 'move':
      if (!v.dir) return null;
      cmd.dir = v.dir;
      if (v.amount) cmd.amount = v.amount;
      if (v.amount === 'step' && v.steps && v.steps > 1) cmd.steps = Math.min(8, v.steps);
      break;
    case 'goto':
    case 'attack':
    case 'pickup':
    case 'enter_elevator': {
      const target = resolveTarget(v.target, req, v.intent);
      if (!target) return null;
      if (req.tier < 1) {
        // Tier 0 has no precise machinery for named things — but refusing was
        // deadening. Degrade the order into a lunge toward the target's rough
        // bearing so the robot always DOES something, and let EARS (tier 1) be
        // the upgrade from "roughly that way" to "actually arrives".
        const dir = bearingToDir(req.entities.find((e) => e.id === target)?.dir);
        if (!dir) return null;
        cmd.intent = 'move';
        cmd.dir = dir;
        break;
      }
      cmd.target = target;
      break;
    }
    case 'explore':
      break; // no fields
    case 'hide':
      break;
    // Fieldless on purpose, and listed rather than left to `default` so the
    // next person adding an intent sees that "no fields" was a DECISION.
    // `flee` never carries a target: "run away from the printer" is still just
    // running, and letting it bind a target is how a panic order turns into a
    // trip across the room towards the thing the operator wanted it away from.
    case 'flee':
      break;
    case 'avoid': {
      // "avoid the printer" names a thing; "avoid enemies" is a directive and
      // arrives with no resolvable target — let it through as a pure policy.
      const target = resolveTarget(v.target, req, v.intent);
      if (!target) {
        if (v.directives && v.directives.length > 0) {
          cmd.intent = 'directive';
          break;
        }
        return null;
      }
      cmd.target = target;
      break;
    }
    case 'directive':
      if (!v.directives || v.directives.length === 0) return null;
      break;
    case 'affirm':
    case 'deny':
      break; // the director resolves these against its own pending question
    case 'choose':
      if (!v.choice || !req.options || !req.options.includes(v.choice)) return null;
      cmd.choice = v.choice;
      break;
    case 'name_robot': {
      const name = v.name?.trim();
      if (!name) return null;
      cmd.name = name.slice(0, 24);
      break;
    }
    default:
      break;
  }
  // careful rides only on movement-ish commands; silently dropped elsewhere.
  if (v.careful && (v.intent === 'move' || v.intent === 'goto' || v.intent === 'pickup')) {
    cmd.careful = true;
  }
  // Directives ride ALONG with any command — "go to the elevator and avoid the
  // machines" must survive as one instruction, not decay into whichever half
  // the model happened to put first.
  if (v.directives && v.directives.length > 0) {
    cmd.directives = [...new Set(v.directives)].slice(0, 4);
  }
  return cmd;
}

/**
 * Validate + normalize model output into a ParsedCommand, with coherence
 * checks against the request (real entity ids, option in triad, tier gating).
 * An invalid plan step is DROPPED, never fatal to the parse.
 * Returns null when invalid — caller retries once, then falls back to local.
 */
export function toParsedCommand(raw: unknown, req: ParseRequest): ParsedCommand | null {
  const parsed = llmOutputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  const ack = validAck(v.ack_line, req);
  if (!ack) return null;
  const cmd = coherent(v, req, ack);
  if (!cmd) return null;
  cmd.source = 'llm';
  if (v.insult) cmd.insult = true;
  // The transcript comes back only when the client sent audio and so has none
  // of its own. Capped: this feeds a rolling log, not a document.
  if (req.audio && typeof v.heard === 'string') {
    const heard = v.heard.trim().slice(0, 200);
    if (heard) cmd.heard = heard;
  }

  // TALK. Hangs off `chatter` and nothing else: a rambling answer attached to
  // a goto would have the robot deliver a monologue while walking away from
  // the operator mid-sentence. And never while something is awake and hostile
  // — the director re-checks this on arrival too, because a fight can start
  // during the three seconds this call is in flight.
  if (cmd.intent === 'chatter' && req.calm && !v.insult) {
    const talk = validTalk(v.talk, req);
    if (talk) cmd.talk = talk;
  }

  // The rest of the plan. Same coherence checks per step; a step that fails
  // them is DROPPED rather than failing the whole parse — losing "then take
  // the lift" is survivable, losing the whole sentence is not. Plans hang only
  // off real commands, never off chatter or a clarify.
  // `directive` is allowed to head a plan even though it is not itself a
  // command: "watch out for the cables, then take the lift" opens with a rule
  // and continues with actions, and dropping the actions loses most of the
  // sentence. The rule applies instantly, so the director starts step one
  // immediately rather than waiting for an order that will never finish.
  if (v.plan && v.plan.length > 0 && (CHAINABLE.has(cmd.intent) || cmd.intent === 'directive')) {
    const steps: PlanStep[] = [];
    for (const raw of v.plan) {
      const ack = (raw.ack_line ? validAck(raw.ack_line, req) : null) ?? THEN_ACKS[raw.intent];
      const step = coherent(raw, req, ack);
      if (!step || !CHAINABLE.has(step.intent)) continue;
      steps.push({
        intent: step.intent,
        ack_line: step.ack_line,
        ...(step.dir ? { dir: step.dir } : {}),
        ...(step.amount ? { amount: step.amount } : {}),
        ...(step.steps ? { steps: step.steps } : {}),
        ...(step.careful ? { careful: true } : {}),
        ...(step.target ? { target: step.target } : {}),
      });
      if (steps.length >= MAX_PLAN_STEPS) break;
    }
    if (steps.length > 0) cmd.plan = steps;
  }
  return cmd;
}

/**
 * Validate an unprompted robot line. Same toddler-speak cap as an ack — this
 * channel exists to make the robot sound alive, not to let it start writing
 * paragraphs — and a proposal is kept only when it names a thing that is
 * actually there, because the player will be answering "yes" to it blind.
 */
export function toSayResponse(raw: unknown, req: SayRequest): SayResponse | null {
  const parsed = sayOutputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  const line = validAck(v.line, { utterance: '' });
  if (!line) return null;
  const out: SayResponse = { line, source: 'llm' };
  if (v.question) out.question = true;
  if (v.proposal) {
    const p = v.proposal;
    const entity = p.target ? req.entities.find((e) => e.id === p.target) : undefined;
    // A proposal with a dead target is worse than none: the operator says yes
    // and nothing happens. Keep only what the engine can actually execute.
    let target = entity?.id;
    // ...and never let the robot talk the operator into hurting it. Saying
    // "yes" must always be safe: a suggestion to go stand on a live cable, or
    // to pick a fight the operator has forbidden, is a trap, not an idea.
    if (entity?.kind === 'cable') target = undefined;
    // Never send the operator's "yes" to the dead shaft.
    if (entity?.kind === 'elevatorA') {
      target = req.entities.find((e) => e.kind === 'elevatorB')?.id;
    }
    const hostile = entity?.kind === 'fusedPrinter' || entity?.kind === 'fusedShredder';
    if (hostile && (req.standing.avoidEnemies || p.intent !== 'attack')) target = undefined;
    // The boss is never a suggestion. Everything else on this list is a thing
    // the operator might reasonably not have noticed; picking a fight with the
    // biggest machine in the building is a DECISION, and the robot volunteering
    // it turns the one genuine choice on the floor into a yes/no prompt.
    if (entity?.size === 'boss') target = undefined;
    // Rules ride on a proposal the same way they ride on a parsed command, so
    // "SHOULD ROBOT KEEP BACK?" → "yes" lands as a directive change with no
    // order attached and nothing cancelled.
    const directives = p.directives && p.directives.length > 0
      ? [...new Set(p.directives)].slice(0, 4)
      : undefined;
    if (
      target ||
      p.dir ||
      directives ||
      p.intent === 'explore' ||
      p.intent === 'hide' ||
      p.intent === 'stop'
    ) {
      out.proposal = {
        intent: p.intent,
        ...(target ? { target } : {}),
        ...(p.dir ? { dir: p.dir } : {}),
        ...(directives ? { directives } : {}),
      };
    }
  }
  return out;
}
