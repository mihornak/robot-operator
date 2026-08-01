/**
 * Zod mirrors of the shared parser enums (shared/types.ts is the source of
 * truth — the `satisfies` + exhaustiveness aliases below break the build if
 * either side drifts) and validation/normalization of LLM output.
 */

import { z } from 'zod';
import type {
  ChipId,
  Dir,
  EntityKind,
  IntentType,
  ParsedCommand,
  ParseRequest,
} from '../../shared/types';

export const INTENTS = [
  'move',
  'stop',
  'shoot',
  'goto',
  'attack',
  'pickup',
  'enter_elevator',
  'name_robot',
  'choose',
  'hide',
  'avoid',
  'robot_choice',
  'clarify',
  'chatter',
] as const satisfies readonly IntentType[];

/** Intents allowed inside a BRAIN "X then Y" chain (commands only, no meta). */
export const CHAIN_INTENTS = [
  'move',
  'stop',
  'shoot',
  'goto',
  'attack',
  'pickup',
  'enter_elevator',
  'hide',
  'avoid',
] as const satisfies readonly IntentType[];

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
  'crate',
  'cable',
  'fusedPrinter',
  'printerInnocent',
  'mop',
  'fuse',
  'fuseSocket',
  'elevatorA',
  'elevatorB',
] as const satisfies readonly EntityKind[];

// Compile-time: every member of the shared union appears in the mirror array.
type AssertExhaustive<T extends never> = T;
type _Intents = AssertExhaustive<Exclude<IntentType, (typeof INTENTS)[number]>>;
type _Dirs = AssertExhaustive<Exclude<Dir, (typeof DIRS)[number]>>;
type _Amounts = AssertExhaustive<
  Exclude<NonNullable<ParsedCommand['amount']>, (typeof AMOUNTS)[number]>
>;
type _Chips = AssertExhaustive<Exclude<ChipId, (typeof CHIP_IDS)[number]>>;
type _Kinds = AssertExhaustive<Exclude<EntityKind, (typeof ENTITY_KINDS)[number]>>;

/** Incoming /api/parse body. Defaults keep hand-rolled curl requests working. */
export const parseRequestSchema = z.object({
  utterance: z.string().min(1),
  tier: z.union([z.literal(0), z.literal(1)]).default(0),
  floor: z.number().int().default(1),
  robotName: z.string().nullable().default(null),
  personality: z.array(z.enum(CHIP_IDS)).default([]),
  options: z.array(z.enum(CHIP_IDS)).nullable().default(null),
  awaitingName: z.boolean().default(false),
  brain: z.boolean().default(false),
  entities: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(ENTITY_KINDS),
        label: z.string(),
        dir: z.string().optional(),
        dist: z.number().optional(),
      }),
    )
    .default([]),
  recent: z.array(z.string()).default([]),
  shouted: z.boolean().default(false),
});

/**
 * ONE-level "then" chain (BRAIN). Written out explicitly — no recursion, the
 * nested command deliberately has no `then` of its own and no meta fields.
 */
export const llmThenSchema = z.object({
  intent: z.enum(CHAIN_INTENTS),
  dir: z.enum(DIRS).nullish(),
  amount: z.enum(AMOUNTS).nullish(),
  careful: z.boolean().nullish(),
  target: z.string().nullish(),
  ack_line: z.string().nullish(),
});

/** Raw model output shape — nullable everywhere because strict JSON-schema mode requires all keys present. */
export const llmOutputSchema = z.object({
  intent: z.enum(INTENTS),
  dir: z.enum(DIRS).nullish(),
  amount: z.enum(AMOUNTS).nullish(),
  careful: z.boolean().nullish(),
  target: z.string().nullish(),
  choice: z.enum(CHIP_IDS).nullish(),
  name: z.string().nullish(),
  then: llmThenSchema.nullish(),
  ack_line: z.string(),
  insult: z.boolean().nullish(),
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
function validAck(ack: string, req: ParseRequest): string | null {
  const t = ack.trim();
  if (!t) return null;
  const ackNorm = normText(t);
  if (ackNorm.split(' ').length > 8) return null; // toddler-speak cap blown
  const uttNorm = normText(req.utterance);
  // verbatim transcript echo is forbidden (CLAUDE.md rule 6)
  if (uttNorm.split(' ').length >= 3 && ackNorm.includes(uttNorm)) return null;
  return t.toUpperCase();
}

const CHAINABLE = new Set<IntentType>(CHAIN_INTENTS);

/** Canned nested acks when the model skips/blows the chained ack_line. */
const THEN_ACKS: Record<(typeof CHAIN_INTENTS)[number], string> = {
  move: 'THEN ROBOT GOES.',
  stop: 'THEN ROBOT STOPS.',
  shoot: 'THEN PEW PEW.',
  goto: 'THEN ROBOT GOES THERE.',
  attack: 'THEN ROBOT FIGHTS.',
  pickup: 'THEN ROBOT GRABS IT.',
  enter_elevator: 'THEN ELEVATOR.',
  hide: 'THEN ROBOT HIDES.',
  avoid: 'THEN ROBOT AVOIDS IT.',
};

/** Fields the coherence check consumes (superset of top-level and `then` shapes). */
interface RawFields {
  intent: IntentType;
  dir?: Dir | null;
  amount?: NonNullable<ParsedCommand['amount']> | null;
  careful?: boolean | null;
  target?: string | null;
  choice?: ChipId | null;
  name?: string | null;
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
  if (!target && intent === 'enter_elevator') {
    target = req.entities.find((e) => e.kind === 'elevatorB')?.id;
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
      break;
    case 'goto':
    case 'attack':
    case 'pickup':
    case 'enter_elevator': {
      if (req.tier < 1) return null; // tier 0 has no concept of targets
      const target = resolveTarget(v.target, req, v.intent);
      if (!target) return null;
      cmd.target = target;
      break;
    }
    case 'hide':
      if (!req.brain) return null; // BRAIN-gated
      break;
    case 'avoid': {
      if (!req.brain) return null; // BRAIN-gated
      const target = resolveTarget(v.target, req, v.intent);
      if (!target) return null;
      cmd.target = target;
      break;
    }
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
  // careful (BRAIN) rides only on movement-ish commands; silently dropped elsewhere.
  if (
    v.careful &&
    req.brain &&
    (v.intent === 'move' || v.intent === 'goto' || v.intent === 'pickup')
  ) {
    cmd.careful = true;
  }
  return cmd;
}

/**
 * Validate + normalize model output into a ParsedCommand, with coherence
 * checks against the request (real entity ids, option in triad, tier gating).
 * An invalid one-level `then` is STRIPPED, never fatal to the parse.
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

  // ONE-level chain (BRAIN): same coherence checks; strip invalid then rather
  // than failing the whole parse. Chains hang only off real commands.
  if (v.then && req.brain && CHAINABLE.has(cmd.intent)) {
    const thenAck =
      (v.then.ack_line ? validAck(v.then.ack_line, req) : null) ?? THEN_ACKS[v.then.intent];
    const thenCmd = coherent(v.then, req, thenAck);
    if (thenCmd) cmd.then = thenCmd;
  }
  return cmd;
}
