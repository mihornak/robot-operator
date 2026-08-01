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
  'robot_choice',
  'clarify',
  'chatter',
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

/** Raw model output shape — nullable everywhere because strict JSON-schema mode requires all keys present. */
export const llmOutputSchema = z.object({
  intent: z.enum(INTENTS),
  dir: z.enum(DIRS).nullish(),
  amount: z.enum(AMOUNTS).nullish(),
  target: z.string().nullish(),
  choice: z.enum(CHIP_IDS).nullish(),
  name: z.string().nullish(),
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

/**
 * Validate + normalize model output into a ParsedCommand, with coherence
 * checks against the request (real entity ids, option in triad, tier gating).
 * Returns null when invalid — caller retries once, then falls back to local.
 */
export function toParsedCommand(raw: unknown, req: ParseRequest): ParsedCommand | null {
  const parsed = llmOutputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  const ack = v.ack_line.trim();
  if (!ack) return null;
  const ackNorm = normText(ack);
  if (ackNorm.split(' ').length > 8) return null; // toddler-speak cap blown
  const uttNorm = normText(req.utterance);
  // verbatim transcript echo is forbidden (CLAUDE.md rule 6)
  if (uttNorm.split(' ').length >= 3 && ackNorm.includes(uttNorm)) return null;
  const cmd: ParsedCommand = { intent: v.intent, ack_line: ack.toUpperCase(), source: 'llm' };
  if (v.insult) cmd.insult = true;

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
      let target = v.target ?? undefined;
      if (target && !req.entities.some((e) => e.id === target)) {
        // Model echoed a label instead of an id — resolve if unambiguous.
        const byLabel = req.entities.filter(
          (e) => e.label.toLowerCase() === target!.toLowerCase(),
        );
        target = byLabel.length === 1 ? byLabel[0].id : undefined;
      }
      if (!target && v.intent === 'enter_elevator') {
        target = req.entities.find((e) => e.kind === 'elevatorB')?.id;
      }
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
  return cmd;
}
