/**
 * ROBOT OPERATOR — cross-subsystem contracts. THE source of truth.
 * Imported by client (`@shared/types`) and server (relative path).
 * Extend HERE; never fork parallel types in a subsystem.
 */

// ---------------------------------------------------------------- geometry

export interface Vec {
  x: number;
  y: number;
}

export type Dir = 'up' | 'down' | 'left' | 'right';

/** Internal render resolution (16:9). Sim positions are px floats in this space. */
export const VIEW_W = 480;
export const VIEW_H = 270;
/** Tile size in px. Floor grids are TILES_X × TILES_Y. */
export const TILE = 16;
export const TILES_X = 30; // 480/16
export const TILES_Y = 16; // 256/16 — bottom 14px is slack under the OSD strip
/** Fixed sim timestep. */
export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;

// ---------------------------------------------------------------- content ids

export type ChipId = 'MAGNET' | 'RAGE' | 'SCARED' | 'MEMORY' | 'ZAP' | 'TOUGH';

/**
 * Anything the robot can have INSTALLED, and therefore anything that owns a
 * glyph on the OSD module strip: the personality chips plus the two crate
 * upgrades. EARS/BRAIN are not chips — they carry no stat block — but to the
 * player they are the same thing ("I got a new part"), and a box you cross a
 * floor for that leaves no mark on the HUD reads as a box that did nothing.
 */
export type ModuleId = ChipId | 'EARS' | 'BRAIN' | 'ROCKET';

/**
 * Hearing acuity. 1 is the FLOOR, not the ceiling: the robot understands named
 * targets from its first second awake (withholding vocabulary read as a broken
 * game, not as progression). 0 survives only for tooling/tests; 2 is the
 * floor-3 EARS crate — longer sight, unprompted callouts on what it notices.
 */
export type EarsTier = 0 | 1 | 2;

export type EntityKind =
  | 'scrap' // pickup, +1 scrap
  | 'chip' // loose personality chip lying on the floor; `option` holds ChipId
  | 'crate' // triad crate on pedestal; `option` holds ChipId
  | 'debris' // heap of dead machines (the opening pile); decorative, non-blocking
  | 'cable' // sparking floor cable hazard (zone damage, telegraphed sparks)
  | 'fusedPrinter' // enemy: printer melted onto a vacuum, chases + spits paper
  | 'fusedShredder' // BOSS (floor 6): bigger body, lobs arcing mortars
  | 'printerInnocent' // harmless decoy printer (wrong-target comedy)
  | 'mop' // harmless prop, wrong-target comedy
  | 'chair' // office chair; harmless furniture, wrong-target comedy
  | 'fuse' // fragile carryable; carrying disables weapon
  | 'fuseSocket' // where the fuse goes (floor 4, powers elevator B)
  | 'elevatorA' // spawn elevator (behind robot, inert)
  | 'elevatorB'; // exit elevator (lit; may need fuse)

export interface Entity {
  id: string; // unique within floor, e.g. 'crate_rage', 'enemy_1'
  kind: EntityKind;
  pos: Vec; // center, px
  hp?: number;
  maxHp?: number;
  /** ChipId for crates and loose floor chips. */
  option?: ChipId;
  /** Human-ish label given to the parser ("the angry crate", "printer"). */
  label: string;
  /**
   * Generic per-kind state machine tag (render may map to frames).
   * 'dormant' is reserved across every hostile kind: a machine that has not
   * been woken is SCENERY — not a threat, not a target, not something to route
   * around (see isLiveHostile / wakeMachine in sim/internal.ts).
   */
  state?: string;
  /** Facing for enemies. */
  facing?: Dir;
  /** True once consumed/opened/dead — kept for render fade-outs, ignored by logic. */
  dead?: boolean;
  /** Scratch fields for sim AI (cooldowns etc). Render must not touch. */
  ai?: Record<string, number>;
}

export interface Projectile {
  id: string;
  /**
   * robot bolt | enemy crumpled paper | robot rocket (explodes on impact) |
   * `shell` — the boss's arcing mortar round. `shell` is PURE DECORATION: it
   * flies over the walls, collides with nothing, and does no damage. The
   * damage lives entirely in the Mortar record it was launched alongside, so
   * the telegraph timing is exact by construction rather than by simulation.
   */
  kind: 'bolt' | 'paper' | 'rocket' | 'shell';
  pos: Vec;
  vel: Vec;
}

/**
 * A telegraphed ground strike: the red circle. Spawned at fire time with the
 * impact point and the fuse already decided, so what the player sees and what
 * the sim resolves cannot drift apart.
 *
 * RENDER CONTRACT: the circle is drawn from `radius` and `fuse/fuseMax` and
 * NOTHING ELSE. No separate visual radius, no fudge factor, no eased size.
 * The instant a render constant enters this picture the game starts lying to
 * the player about where it is safe to stand.
 */
export interface Mortar {
  id: string;
  /** Impact centre, px. */
  target: Vec;
  /** Where it was launched from — the decorative shell's start point. */
  from: Vec;
  /** Ticks until detonation; counts down to 0. */
  fuse: number;
  /** Fuse at launch — `fuse/fuseMax` is the only timing signal render gets. */
  fuseMax: number;
  /** Blast radius, px. Damage applies iff inside it. */
  radius: number;
}

// ---------------------------------------------------------------- robot & orders

/** The task the robot is executing right now. Set by the director from parsed
 *  commands, or by the sim itself when it acts on its own (see selfDriven). */
export type Order =
  | { kind: 'move'; dir: Dir; distancePx?: number } // until wall/stop; distancePx = nudge ("a bit", "one step") then order_done
  | { kind: 'stop' }
  | { kind: 'shoot' } // fire at nearest hostile in facing cone, else straight ahead
  | { kind: 'goto'; targetId: string; careful?: boolean } // careful = slow + wide berth around hostiles/hazards
  | { kind: 'attack'; targetId: string }
  | { kind: 'pickup'; targetId: string; careful?: boolean }
  | { kind: 'enter'; targetId: string }
  | { kind: 'explore' } // standing order: tour the floor, visiting interesting things one by one
  | { kind: 'hide' } // find cover breaking line-of-sight to nearest hostile, go there
  | { kind: 'retreat' } // back off from the nearest hostile until it is out of sight
  | { kind: 'evade' }; // keep moving through open ground: never stand where it just stood

/**
 * A persistent behaviour switch the player sets by talking ("avoid the
 * machines", "don't pick anything up", "fight everything"). Directives are the
 * robot's MEMORY of how this floor should be played: they survive order
 * changes, arrivals and completions, and are what makes "go to the elevator and
 * avoid enemies" one instruction rather than two forgotten halves.
 */
export type DirectiveKind =
  | 'avoid_enemies' // route wide around hostiles, never pick a fight
  | 'fight_enemies' // engage hostiles on sight (clears avoid_enemies)
  | 'avoid_hazards' // route wide around cables
  | 'ignore_hazards'
  | 'gather' // grab scrap/chips noticed on the way
  | 'no_gather'
  | 'careful' // move slow + quiet by default
  | 'bold'
  | 'act_alone' // go off and explore the floor unprompted, not just react
  | 'wait_for_orders' // stand still when idle, do nothing unasked
  // Combat doctrine. All of these are readjustments the player makes DURING a
  // fight, which is why they are directives and not intents: a directive folds
  // into the standing orders without cancelling whatever the robot is doing.
  | 'keep_distance' // hold the standoff band and shoot from there
  | 'close_in' // get in its face (also clears avoid_enemies, sets fight)
  | 'dodge_projectiles' // treat telegraphed blast zones as things to route around
  | 'ignore_projectiles'
  | 'keep_moving' // never plant: strafe between shots
  | 'hold_ground'
  | 'focus_dangerous' // shoot the worst threat first, not the closest
  | 'focus_nearest'
  | 'use_rockets'
  | 'use_bolts';

/** Resolved standing orders. Lives on RobotState; the sim reads it every tick. */
export interface Standing {
  avoidEnemies: boolean;
  /** Shoot back at a machine already coming for us. Self-defence, not a plan. */
  fight: boolean;
  /** Go LOOKING for a fight. Off by default: charging across the room at a
   *  machine nobody mentioned is the "guns blazing" problem, and it is the
   *  operator's call, not the robot's. Set by "fight everything". */
  hunt: boolean;
  avoidHazards: boolean;
  gather: boolean;
  careful: boolean;
  /** React on its own — finish deliveries, fight or back off, grab loot
   *  underfoot, and ask when it runs dry. Does NOT include wandering off. */
  autonomy: boolean;
  /** Go looking for things nobody asked about. Off by default: a companion
   *  that wanders off mid-sentence stops feeling like it is with you. The
   *  player turns it on by saying so ("do your own thing"). */
  roam: boolean;
  /** Specific entity ids to route wide around ("avoid THAT printer"). */
  avoidIds: string[];
  /** Engagement range. 'auto' = today's behaviour (close to ATTACK_RANGE and
   *  plant); 'far' holds a standoff band; 'close' gets in its face. */
  spacing: 'auto' | 'far' | 'close';
  /** Target priority. 'auto' = nearest, i.e. today's behaviour. */
  focus: 'auto' | 'dangerous' | 'nearest';
  /** Route wide around telegraphed blast zones. Off by default, same reasoning
   *  as avoidHazards — "avoid the red circles" has to visibly DO something, so
   *  it must not already be on. The point-blank panic dodge ignores this flag:
   *  standing in a detonating circle is a bug, not comedy. */
  dodgeZones: boolean;
  /** Never plant while fighting — strafe between shots. */
  keepMoving: boolean;
  /** Which gun. 'bolt' until the floor-6 crate exists, and the robot falls back
   *  to bolts anyway when it has no launcher. */
  weapon: 'bolt' | 'rocket';
}

export function defaultStanding(): Standing {
  return {
    avoidEnemies: false,
    fight: true,
    hunt: false,
    // Off by default. Routing around every spark is technically smarter and
    // much less fun — driving onto the spicy floor is a joke the robot is
    // supposed to be able to make. The player can ask for care.
    avoidHazards: false,
    gather: true,
    careful: false,
    autonomy: true,
    roam: false,
    avoidIds: [],
    // Every combat-doctrine field defaults to "however the robot already
    // fought", so adding them changed nothing. Each one only exists once the
    // player has said the sentence that turns it on.
    spacing: 'auto',
    focus: 'auto',
    dodgeZones: false,
    keepMoving: false,
    weapon: 'bolt',
  };
}

/** Short OSD labels for the directives currently in force (memory made visible). */
export function standingLabels(s: Standing): string[] {
  const out: string[] = [];
  if (s.avoidEnemies) out.push('AVOID FOES');
  else if (!s.fight) out.push('NO FIGHT');
  else if (s.hunt) out.push('HUNTING');
  if (s.careful) out.push('SNEAK');
  if (s.avoidHazards) out.push('MIND CABLES');
  if (!s.gather) out.push('NO LOOT');
  if (s.roam) out.push('ROAMING');
  if (!s.autonomy) out.push('ON LEASH');
  if (s.spacing === 'far') out.push('KEEP BACK');
  else if (s.spacing === 'close') out.push('CLOSE IN');
  if (s.focus === 'dangerous') out.push('BIG FIRST');
  else if (s.focus === 'nearest') out.push('NEAR FIRST');
  if (s.dodgeZones) out.push('DODGE');
  if (s.keepMoving) out.push('KEEP MOVING');
  if (s.weapon === 'rocket') out.push('ROCKETS');
  if (s.avoidIds.length > 0) out.push(`AVOID ×${s.avoidIds.length}`);
  return out;
}

export interface RobotState {
  pos: Vec;
  vel: Vec;
  /** Body facing, radians (0 = right). */
  facing: number;
  /** Head facing, radians. Head swivels toward camera on ack — render-driven offset comes via UiState. */
  headFacing: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** Asleep inside the opening debris pile: ignores orders, renders as a glint.
   *  Cleared once — by `wakeRobot`, on the player's first real utterance. */
  dormant: boolean;
  tier: EarsTier;
  chips: ChipId[];
  /** Voice-given name; null until the naming beat. Forgotten (reset to null) on floor change until MEMORY. */
  name: string | null;
  /** True once the MEMORY chip is installed — name persists, gag stops. */
  hasMemory: boolean;
  /** Kept for the parser contract; TRUE from the first second — every phrase
   *  the player can say (hide, avoid, sneak, then-chains) works immediately. */
  brain: boolean;
  /** BRAIN crate (floor 4): the robot volunteers PLANS unprompted and holds
   *  longer chains. It could always execute; now it has opinions about what next. */
  ideas: boolean;
  /** Standing orders — the robot's memory of how to play this floor. */
  standing: Standing;
  order: Order | null;
  /** True when the CURRENT order was chosen by the robot itself, not the player. */
  selfDriven: boolean;
  /**
   * The robot has just arrived somewhere new and is HOLDING for instructions.
   * Nothing self-directed runs while this is set — it reports what it can see
   * and waits. Cleared by the first real order of the floor. Every floor is
   * supposed to open on "what do we do?", not on the robot already gone.
   */
  awaitingBriefing: boolean;
  /** 'ok' | 'sulk' (ignores orders ~3s) | 'fleeing' (SCARED). */
  mood: 'ok' | 'sulk' | 'fleeing';
  /** Ticks remaining of sulk. */
  sulkTicks: number;
  /** Entity id of carried fuse, null otherwise. Carrying disables shooting. */
  carrying: string | null;
  scrap: number;
  /** Derived stats after chips. */
  speed: number; // px/s
  damage: number;
  /** Weapon cooldown ticks remaining. */
  shootCd: number;
  /** Rocket cooldown ticks remaining. Its own clock: the launcher is a much
   *  slower weapon, and sharing shootCd would make swapping guns a free reload. */
  rocketCd: number;
  /** Launcher installed (floor-6 crate). Without it, standing.weapon is a wish. */
  rockets: boolean;
  /** Ticks robot has been continuously blocked by a wall (drives bump comedy). */
  wallBumpTicks: number;
}

// ---------------------------------------------------------------- sim state & events

export type SimEventType =
  | 'wall_bump' // robot drove into a wall (fires on impact, throttled by sim)
  | 'order_done' // goto/attack/pickup finished
  | 'order_blocked' // can't comply (e.g. shoot while carrying)
  | 'scrap_pickup'
  | 'chip_pickup' // loose floor chip collected — { chip: ChipId }
  | 'explore_found' // explore order reached a point of interest — id = entity, or none for a wander leg
  | 'robot_damage' // { source: 'cable' | 'paper' | 'enemy' }
  | 'robot_death' // { cause: string }
  | 'enemy_hit'
  | 'enemy_death'
  | 'shot_fired'
  | 'paper_thrown' // enemy attack
  | 'crate_reached' // robot adjacent to a crate (ceremony trigger)
  | 'fuse_pickup'
  | 'fuse_inserted' // elevator B powered
  | 'elevator_entered' // floor complete
  | 'enemy_spotted' // first time a hostile is within robot sight
  | 'chip_flee' // SCARED kicked in
  | 'chip_detour' // MAGNET detoured to scrap
  | 'self_order' // robot chose its own next task — { what, label }
  | 'need_orders' // robot is idle and out of ideas: it wants to be told something
  | 'threat_seen' // spotted a hostile and is HOLDING for instructions, not charging
  | 'path_failed' // no route exists to the ordered target
  | 'mortar_launch' // a blast zone was painted — { radius, fuse }
  | 'mortar_impact' // it went off — { radius, hit }
  | 'zone_dodge' // robot bailed out of a live blast zone
  | 'boss_wake' // the shredder stood up — the arena's one irreversible beat
  | 'boss_phase' // boss crossed an hp threshold — { phase }
  | 'weapon_idea'; // robot has an opinion about which gun to use

export interface SimEvent {
  type: SimEventType;
  /** Entity/projectile id when relevant. */
  id?: string;
  /** Extra payload, event-specific. */
  data?: Record<string, string | number>;
}

export interface SimState {
  seed: number;
  /** Mutable rng state (mulberry32), advanced only inside sim.step. */
  rngState: number;
  tick: number;
  floorIndex: number; // 0-based; floor 1 = index 0
  robot: RobotState;
  entities: Entity[];
  projectiles: Projectile[];
  /** Live telegraphed blast zones. Deliberately NOT entities: the player never
   *  says "go to the red circle" — every circle phrase is a policy — and
   *  entity-ness would cost an exclusion filter in a dozen scan loops, each one
   *  a place a future circle silently becomes a thing the robot walks towards. */
  mortars: Mortar[];
  /** Monotonic id counter for anything the sim spawns. Ticks are NOT unique:
   *  two projectiles born on the same tick used to share an id. */
  nextId: number;
  /** Walkability grid [y][x], true = solid. Rebuilt on floor load. */
  solid: boolean[][];
  /** Events emitted by the LAST step() call — drained (replaced) each step. */
  events: SimEvent[];
  /** Sim halts (during boot/ceremony robot AI still idles; enemies freeze only when true). */
  frozen: boolean;
}

// ---------------------------------------------------------------- parser (LLM) contract

/** Command intents + meta intents. Nothing here is gated behind an upgrade. */
export type IntentType =
  | 'move' // dir required
  | 'stop'
  | 'shoot'
  | 'goto' // target required
  | 'attack'
  | 'pickup'
  | 'enter_elevator'
  | 'explore' // "go explore" / "look around" — standing wander order
  | 'name_robot' // naming beat; `name` holds the name
  | 'choose' // triad; `choice` holds ChipId
  | 'hide' // take cover from the nearest hostile
  /**
   * "run!", "get out of there", "fall back". The panic button, and deliberately
   * an INTENT rather than a directive: fleeing is something the robot does RIGHT
   * NOW and stops doing, not a rule it keeps. The persistent sense the operator
   * might also mean — "keep running, never plant" — is already `keep_moving`,
   * and a second standing rule that also meant "run" would only fight it.
   * Resolves to a `retreat` or `evade` order via sim.fleeOrder().
   */
  | 'flee'
  | 'avoid' // standing order — route wide around `target` from now on
  | 'directive' // pure standing-order change, no movement ("stop picking things up")
  | 'affirm' // "yes" / "do it" — answers the robot's own pending question
  | 'deny' // "no" / "not that"
  | 'robot_choice' // player indifferent — robot picks (director rolls)
  | 'clarify' // parser unsure — ack_line IS the in-character ask-again
  | 'chatter'; // not a command; ack_line is the in-character reply

/** One queued step of a plan. Commands only — no meta intents, no nesting. */
export interface PlanStep {
  intent: IntentType;
  dir?: Dir;
  amount?: 'bit' | 'step';
  steps?: number;
  careful?: boolean;
  target?: string;
  /** What the robot says as it STARTS this step. */
  ack_line: string;
}

export interface ParsedCommand {
  intent: IntentType;
  dir?: Dir;
  /** Movement magnitude: 'bit' ≈ 20px, 'step' ≈ one tile, omitted = until wall/stop. */
  amount?: 'bit' | 'step';
  /** Step count when the player asked for several ("two steps right"). 1..8, only with amount 'step'. */
  steps?: number;
  /** Cautious execution ("sneak to X") — slow + wide berth, this order only. */
  careful?: boolean;
  /**
   * The REST of a multi-step plan, in order, after this command. "Grab the
   * fuse, put it in the socket, then take the lift" is one utterance and one
   * plan: the robot executes the head immediately and holds the tail, stepping
   * through it as each order completes. Max 4 held steps.
   */
  plan?: PlanStep[];
  /** Standing-order changes carried by this utterance. May ride ALONG with a
   *  command: "go to the elevator and avoid enemies" is one goto + one directive. */
  directives?: DirectiveKind[];
  /** Entity id from ParseRequest.entities. */
  target?: string;
  choice?: ChipId;
  name?: string;
  /** Robot's repeat-back / reply, toddler-speak, ≤7 words, third person. */
  ack_line: string;
  /**
   * TALK: the long-form conversational answer, only ever set on `chatter`.
   *
   * The operator is not only an order-giver, they are the robot's one friend,
   * and a friend who answers "how are you" with five words and nothing else is
   * not someone you bond with. This is the channel where the robot gets to
   * ramble — but "longer" here means MORE SENTENCES, never longer ones: each
   * entry obeys the same ≤7-word toddler cap as `ack_line` (CLAUDE.md rule 7),
   * and the director speaks them one after another. A robot that suddenly
   * produces a subordinate clause stops being the robot.
   *
   * Only filled when `calm` — mid-fight the robot deflects instead, in one
   * line, because a companion that chats while being shot at is a toy.
   */
  talk?: string[];
  /** Player insulted the robot → sulk. */
  insult?: boolean;
  /** Where the parse came from (server sets). */
  source?: 'llm' | 'local';
  /**
   * What the model heard, when the utterance arrived as audio (`ParseRequest.
   * audio`) and the client therefore has no transcript of its own. It exists
   * so the rolling `recent` dialogue still has the player's side in it — a
   * robot that cannot remember what you just said is not a companion.
   *
   * NEVER RENDERED (CLAUDE.md rule 6). The robot repeats back in its own words
   * via ack_line; the raw transcript is for context only.
   */
  heard?: string;
}

export interface ParseEntity {
  id: string;
  kind: EntityKind;
  label: string;
  /** Rough bearing/distance from robot, for "the one on the left". */
  dir?: string;
  dist?: number;
  /** Threat rank among the live hostiles, 1 = worst. Hostiles only, absent
   *  everywhere else. Gives "shoot the dangerous one" something to bind to. */
  rank?: number;
  /** Body class, so "the big one" resolves to a WORD rather than to a number
   *  the model has to compare across entities. */
  size?: 'small' | 'big' | 'boss';
}

export interface ParseRequest {
  /** Empty string when `audio` carries the utterance instead. */
  utterance: string;
  /**
   * The press as sound, for clients whose browser cannot transcribe (iOS).
   * When set, the model listens instead of reading `utterance`, and returns
   * what it heard in `ParsedCommand.heard`.
   */
  audio?: AudioClip | null;
  /** Runner-up STT hypotheses for the SAME audio, best-first, excluding
   *  `utterance`. Browser speech recognition mangles homophones ("go to steps
   *  right" for "go two steps right") — the model reconciles them. */
  alternatives: string[];
  tier: EarsTier;
  floor: number; // 1-based, for flavor
  robotName: string | null;
  /** Active chip ids. */
  personality: ChipId[];
  /** Triad options if a ceremony is active, else null. */
  options: ChipId[] | null;
  /** Awaiting the naming answer? */
  awaitingName: boolean;
  /** Always true in play — kept in the contract so the schema stays stable. */
  brain: boolean;
  /** Visible entities the robot could target. */
  entities: ParseEntity[];
  /** Rolling dialogue log, oldest first: "VOICE: …" / "ROBOT: …". */
  recent: string[];
  shouted: boolean;
  /** Standing orders in force — so the model can answer "what are you doing?"
   *  and can tell a NEW directive from one already running. */
  standing: Standing;
  /** The question the robot itself last asked, awaiting an answer. A bare
   *  "yes"/"go on"/"nah" is meaningless without it. Null when none is open. */
  pendingQuestion: string | null;
  /** What the robot is doing this second, in words ("going to the elevator"). */
  busy: string | null;
  hp: number;
  maxHp: number;
  /** Hands full (carrying the fuse) — no shooting, and it knows it. */
  carrying: boolean;
  /**
   * Nothing hostile in sight — the robot is free to actually TALK (see
   * `ParsedCommand.talk`). False means a machine is awake and looking at it,
   * and small talk gets deflected rather than answered: "ROBOT IS BUSY BEING
   * BRAVE. TALK AFTER." The gate is the director's, computed from the sim; the
   * model is only told which side of it we are on.
   */
  calm: boolean;
}

// ---------------------------------------------------------------- robot voice (unprompted)

/**
 * Why the robot is opening its mouth without being spoken to. This is the
 * channel that stops the robot sounding like a jukebox of pre-written lines:
 * the situation goes to the model, the model writes the sentence.
 */
export type SayTrigger =
  | 'floor_start' // just arrived on a new floor — reads the room, proposes a plan
  | 'self_order' // chose its own next task, announces it
  | 'found' // reached something interesting on its tour
  | 'enemy_spotted'
  | 'hurt'
  | 'blocked' // couldn't do the thing (no route, no power, hands full)
  | 'idle_ask' // out of ideas: asks the operator what to do
  | 'arrived' // finished the ordered task, wants the next one
  | 'banter'; // long silence, nothing happening — says something anyway

export interface SayRequest {
  trigger: SayTrigger;
  /** One plain-English fact about what just happened, written by the director. */
  detail: string;
  floor: number;
  robotName: string | null;
  personality: ChipId[];
  standing: Standing;
  /** BRAIN crate installed — the robot may volunteer a concrete proposal. */
  ideas: boolean;
  hp: number;
  maxHp: number;
  carrying: boolean;
  entities: ParseEntity[];
  recent: string[];
}

/**
 * The robot's unprompted line, plus (optionally) something it wants to DO. The
 * proposal is never executed on its own — it waits for the operator to agree,
 * which is what keeps the engine, not the model, in charge of the world.
 */
export interface SayResponse {
  line: string;
  /** True when `line` ends on a question the operator is expected to answer. */
  question?: boolean;
  /** `directives` lets a proposal be a RULE rather than a destination, so a
   *  briefing whose best answer is "SHOULD ROBOT KEEP BACK?" can be agreed to
   *  with a plain "yes". Executed through the same path as a parsed command. */
  proposal?: { intent: IntentType; target?: string; dir?: Dir; directives?: DirectiveKind[] } | null;
  source?: 'llm' | 'local';
}

// ---------------------------------------------------------------- server API

/** POST /api/parse : ParseRequest -> ParsedCommand (400/500 -> client falls back to local parser) */
/** POST /api/say : SayRequest -> SayResponse (any failure -> client uses a bank line) */
/** POST /api/tts : TtsRequest -> audio/mpeg bytes */
export interface TtsRequest {
  text: string;
  /** Cache key hint; server hashes text anyway. */
  id?: string;
}
/** POST /api/log : LogBatch -> 204 */
export interface LogBatch {
  session: string;
  events: Array<{ t: number; type: string; data?: Record<string, unknown> }>;
}

// ---------------------------------------------------------------- voice input

/**
 * A push-to-talk recording: 16 kHz mono 16-bit WAV, base64, no data: prefix.
 *
 * This is the ears for browsers that have none. Safari — every browser on iOS —
 * ships no SpeechRecognition at all, so on a phone the whole voice game is
 * dead without this. The clip rides straight into /api/parse and the parse
 * model listens to it; there is no separate transcription hop, because a
 * second round trip on a mobile connection is the difference between a robot
 * that answers and a robot that lags.
 *
 * WAV specifically: OpenRouter takes base64 wav/mp3, and MediaRecorder gives
 * webm/opus on Chrome and mp4/aac on Safari — neither reliably accepted, and
 * transcoding on the server is a codec dependency this bundle will not have.
 * Raw PCM out of WebAudio, downsampled and RIFF-wrapped in ~40 lines, is the
 * one path that is identical on every browser.
 */
export interface AudioClip {
  /** base64 of the WAV bytes. */
  data: string;
  format: 'wav';
  /** Clip duration in ms — for logging and the empty-press diagnosis. */
  ms: number;
}

export interface Utterance {
  text: string;
  shouted: boolean;
  source: 'speech' | 'typed';
  /**
   * Set instead of `text` by a source with no local recognition: the words are
   * still inside the audio and only the parse model can read them. Anything
   * consuming an Utterance must handle `text === ''` with `audio` set.
   */
  audio?: AudioClip;
}

/** Any input that produces player utterances. NOTHING may assume a mic exists. */
export interface CommandSource {
  /** Begin capture (PTT press / teletype focus). */
  start(): void;
  /** End capture (PTT release). Resolves with utterance or null if nothing heard. */
  stop(): Promise<Utterance | null>;
  /** Fires for sources that complete on their own (teletype enter). */
  onUtterance(cb: (u: Utterance) => void): void;
  readonly available: boolean;
}

// ---------------------------------------------------------------- ui / render view

export type GamePhase =
  | 'off' // black, PRESS [SPACE]
  | 'boot' // CRT bloom flash, scanlines settle
  | 'play' // normal floor play (includes wake/naming — director scripts within)
  | 'ceremony' // triad active (world keeps rendering; enemies frozen on ceremony floors anyway)
  | 'death' // death card visible
  | 'cliffhanger' // CAM 06 dead static + voice
  | 'title'; // ROBOT OPERATOR + TO BE CONTINUED

/** Why the mic produced nothing, and what the player can do about it. */
export type MicFault =
  | 'unsupported' // no SpeechRecognition in this browser
  | 'noServer' // no local recognition AND the server has no model to listen with
  | 'denied' // permission refused / blocked
  | 'silent' // permission fine, but zero audio energy reached us — wrong input device
  | 'noWords'; // audio arrived, recognition returned no words (accent/noise/language)

export interface MicHelp {
  fault: MicFault;
  title: string;
  steps: string[];
}

export interface DeathCard {
  robotName: string;
  floor: number;
  heard: string; // what it HEARD, in its own words (last ack_line)
  did: string; // what it did ("DROVE INTO SPICY FLOOR.")
  lastWords: string;
  scrap: number;
}

/**
 * The install moment, fullscreen. Set by the director the instant a module goes
 * in and cleared when the beat is over; render restarts the animation whenever
 * the OBJECT identity changes, so re-installing the same id still plays.
 */
export interface UpgradeReveal {
  id: ModuleId;
  /** Big word under the icon ("BRAIN"). */
  name: string;
  /** One short line of what it does. */
  blurb: string;
}

/** When the flying icon touches down in the OSD module strip. The director adds
 *  the glyph at exactly this moment, so the strip pops as the icon lands —
 *  which is the whole trick that ties "I got a thing" to "it is up there now". */
export const UPGRADE_LAND_MS = 2100;
/**
 * When the reveal is over and `UiState.upgrade` goes back to null.
 *
 * The card used to vanish 300ms after the icon landed, which is long enough to
 * SEE it and nowhere near long enough to READ it — and the blurb is the only
 * place the game ever explains what a module actually does. The world stays
 * frozen for this whole window, so the cost is dead air the player asked for.
 */
export const UPGRADE_TOTAL_MS = 4200;

export interface UiState {
  phase: GamePhase;
  /** OSD top-left, e.g. "CAM 03 · FLOOR 03 · REC ●". */
  osd: string;
  /** Installed module glyphs for the OSD strip. */
  glyphs: ModuleId[];
  /** Current spoken caption (robot line) or ''. */
  caption: string;
  /** Player push-to-talk held. */
  pttHeld: boolean;
  /** 'idle' | 'listening' | 'thinking' — mic state indicator on OSD. */
  micState: 'idle' | 'listening' | 'thinking';
  /** Teletype input line currently being typed ('' = hidden). */
  teletype: string;
  teletypeActive: boolean;
  /** Sticky note visible (pre-boot; falls off on the power-on thunk). */
  stickyNote: boolean;
  /** "HOLD [SPACE] TO TALK" onboarding hint — director sets ~3s after boot until first PTT. */
  talkHint: boolean;
  /** Mic troubleshooting card, or null. Shown when a press yields no words. */
  micHelp: MicHelp | null;
  /** Live input level 0..1 while listening — drives the real VU meter, and is
   *  the player's proof the mic works before the robot has ever answered. */
  micLevel: number;
  /** Pulses 1→0 when the sleeping robot stirs inside the pile (pre-wake theatre). */
  pileStir: number;
  deathCard: DeathCard | null;
  /** Triad options panel (single shiny crate opened): render as an on-feed CRT
   *  card — glyph, spoken name, one-line blurb each. Voice-only selection. */
  ceremonyOptions: Array<{ id: ChipId; name: string; blurb: string }> | null;
  /** Fullscreen install ceremony (chip eaten, crate opened), or null. */
  upgrade: UpgradeReveal | null;
  /** Robot head should aim at camera (ack tell), decays in render. */
  headToCameraMs: number;
  /** Mood glyph on OSD: '' | 'SULK' | 'FLEE'. */
  moodGlyph: string;
  /** Standing-order chips on the OSD — the player's proof the robot remembered. */
  orders: string[];
  /** What the robot is doing right now, OSD second row ("→ ELEVATOR"). */
  objective: string;
  /** Queued plan steps still to come, in order, as short labels. */
  plan: string[];
  /** Robot condition, for the OSD hull bar. */
  hp: number;
  maxHp: number;
  /** Pulses 1→0 when hp drops, so the bar can flash the hit. */
  hpFlash: number;
  /** True while the robot is holding at a floor entrance waiting to be briefed. */
  awaitingBriefing: boolean;
  /** 0..1 how close danger is (drives CRT jitter). */
  danger: number;
  /** 0..1 feed degradation (robot HP worry). */
  degrade: number;
}

export interface RenderView {
  sim: SimState;
  ui: UiState;
  /** Interpolation 0..1 between previous and current sim tick. */
  alpha: number;
  /** ALL sim events since the last render frame (multiple steps may run per
   *  frame; sim.events only holds the LAST step's). Render reacts to these. */
  frameEvents: SimEvent[];
}

/** One-shot visual effects the director can trigger. Implemented by render. */
export interface RenderFx {
  bootFlash(): void; // CRT bloom power-on
  staticBurst(ms: number): void; // camera cut
  glitchFrame(): void; // one hard glitch frame (robot damage)
  shake(px: number, ms: number): void;
  /** Dead-cam full static (cliffhanger). */
  deadCam(on: boolean): void;
}

export interface RenderApp {
  init(host: HTMLElement): Promise<void>;
  /** Called every rAF with the current view. Render owns interpolation/tweens. */
  render(view: RenderView): void;
  fx: RenderFx;
}

// ---------------------------------------------------------------- audio

/** Pregenerated file SFX ids — files at /assets/sfx/<id>.mp3 (see scripts/genSfx). */
export type SfxName =
  | 'radio_on' // PTT press click
  | 'radio_off' // PTT release click
  | 'static_burst' // camera cut
  | 'servo' // head swivel
  | 'bump' // wall thud
  | 'shoot' // robot bolt
  | 'zap' // cable spark damage
  | 'spark_loop' // cable ambient crackle
  | 'elevator_ding'
  | 'doors' // elevator doors close
  | 'powerup' // chip install
  | 'powerdown' // robot death
  | 'boot' // CRT power-on thunk+bloom
  | 'paper' // enemy paper shot
  | 'hit' // enemy takes hit
  | 'enemy_die'
  | 'scrap' // pickup chime
  | 'spin' // celebratory idle spin whir
  | 'fuse_in'
  | 'title' // title card sting
  | 'mortar_launch' // boss lobs one — hollow thump + rising whistle
  | 'mortar_warn' // the circle's last-moment warning beeps
  | 'boom_small'
  | 'boom_big'
  | 'boom_huge' // the boss dying
  | 'rocket_fire'
  | 'boss_roar'
  | 'alarm'; // facility klaxon (boss floor arrival)

/**
 * How the robot got hurt. Carried through damageRobot so a later phase can give
 * each channel its own i-frame budget — a swarm's paper stacking is what makes
 * numbers matter, and it must not also halve the cost of driving over a cable.
 */
export type DamageChannel = 'contact' | 'projectile' | 'blast' | 'hazard';

export interface AudioEngine {
  /** Must be called from a user gesture. Starts hum. */
  init(): Promise<void>;
  playSfx(name: SfxName, opts?: { volume?: number; rate?: number }): void;
  /** Play robot voice MP3 bytes through the radio chain. Resolves when playback ends. */
  playVoiceBytes(bytes: ArrayBuffer): Promise<void>;
  /** Fetch+decode+play a voice mp3 URL through the radio chain. Throws on 404. */
  playVoiceUrl(url: string): Promise<void>;
  stopVoice(): void;
  /**
   * Start a looping music bed from a bundled file (see client/public/music).
   * Resolves false when there is no track to play — music is the one layer the
   * game is allowed to be missing, exactly like the voice bank in rule 8, and a
   * boss fight with no soundtrack must still be a boss fight.
   */
  playMusic(url: string, opts?: { volume?: number; fadeMs?: number }): Promise<boolean>;
  /**
   * Fetch + decode a bed WITHOUT playing it. Called when the floor that needs
   * it loads, so the track is in memory before the beat that starts it — a
   * megabyte arriving after the roar is music that begins in the wrong place.
   */
  prefetchMusic(url: string): Promise<void>;
  /** Fade the bed out and drop it. Safe to call when nothing is playing. */
  stopMusic(fadeMs?: number): void;
  /** Room-tone hum level 0..1. */
  setHum(level: number): void;
  /** Synth beeps for teletype/OSD ticks. */
  /** 'type' is the near-subliminal caption-typewriter tick — far softer than
   *  'teletype'. It was reachable in the engine but not through this interface,
   *  which meant a caller coding against the contract could not ask for it. */
  blip(kind: 'teletype' | 'osd' | 'warn' | 'type'): void;
  readonly ready: boolean;
}

// ---------------------------------------------------------------- art

/** Implemented by client/src/art — returns pixi Textures by manifest name. Typed loosely here to keep shared/ pixi-free. */
export interface ArtAtlas {
  /** Frame textures for a manifest entry (length = frames). */
  frames(name: string): unknown[];
  /** Single texture (first frame). */
  tex(name: string): unknown;
}

// ---------------------------------------------------------------- wishlist

/**
 * The email gate that stands between a finished run and the next one.
 *
 * The client owns the hard part of the contract: a run does not restart until
 * the player has typed something that looks like an email. The server is
 * best-effort persistence — if Postgres or the network is down the player still
 * gets to play (rule 4's spirit: nothing in this game may require a backend).
 */
export interface WishlistRequest {
  email: string;
  /** Floor reached on the run that just ended. */
  floor?: number;
  /** Whatever the player named the robot — the only other thing worth keeping. */
  robotName?: string;
}

export interface WishlistResponse {
  ok: true;
  /** True when this email was already on the list (re-submits are not errors). */
  already: boolean;
  /** False when the server has no database and only wrote a log line. */
  stored: boolean;
}

// ---------------------------------------------------------------- analytics

/**
 * The read side of the durable analytics store, backing `/admin`.
 *
 * Every client event already flows through `/api/log`; the server dual-writes
 * it into Postgres so the answers survive a redeploy (Railway's disk does not).
 * These shapes are the contract between server/src/adminRoute.ts and the
 * dashboard page — the game bundle never imports them.
 */
export interface AdminOverview {
  /** Window this covers, in days back from now. */
  days: number;
  /** Distinct sessions that loaded the page at all. */
  sessions: number;
  /** …that got past the title screen and booted the feed. */
  booted: number;
  /** …that issued at least one command. The real "tried it" number. */
  played: number;
  /** …that died at least once. */
  died: number;
  /** …that reached the ending card. */
  finished: number;
  /** Deepest floor reached, per session, bucketed: floor → session count. */
  depth: Array<{ floor: number; sessions: number }>;
  /** Mean and median deepest floor across sessions that played. */
  avgFloor: number | null;
  medianFloor: number | null;
  /**
   * Sessions that were asked for an address — the conversion denominator.
   *
   * The UNION of `wishlist_shown` and `wishlist_submit` sessions, not just
   * `wishlist_shown`. A submit is only reachable from an open gate, so a submit
   * with no matching shown means the gate WAS shown and the event was lost in a
   * dropped beacon batch. Counting the union keeps the funnel monotonic —
   * `signups` can never exceed `sawGate` — without discarding known-good data.
   */
  sawGate: number;
  /**
   * Sessions that entered a valid address, from `wishlist_submit` events.
   * This is the funnel number: it counts players who completed the gate.
   */
  signups: number;
  signupsAllTime: number;
  /**
   * Rows actually in the `wishlist` table. Deliberately separate from
   * `signups`: the gate logs its event BEFORE the POST and the POST is
   * fail-soft, so a player can leave an address that never reaches Postgres.
   * `signups` > `addressesStored` is not a bug — it is the delivery gap, and
   * seeing it is the point.
   */
  addressesStored: number;
  /**
   * `signups / sawGate` as a percentage 0..100, null when the gate has never
   * been shown. Deliberately NOT signups over end-frames: a returning player is
   * already satisfied from localStorage and never sees the gate, so that
   * denominator would understate the rate.
   */
  conversionPct: number | null;
  /** One row per day, oldest first. */
  daily: Array<{ day: string; sessions: number; played: number; signups: number }>;
}

/** One row of the recent-sessions drill-down. */
export interface AdminSession {
  session: string;
  firstSeen: string;
  lastSeen: string;
  /** Deepest floor reached, or null if they never got moving. */
  maxFloor: number | null;
  commands: number;
  deaths: number;
  /** True when this session's player left an address. */
  signedUp: boolean;
}

/** One wishlist signup, for the list and the CSV export. */
export interface AdminSignup {
  email: string;
  floor: number | null;
  robotName: string | null;
  createdAt: string;
}
