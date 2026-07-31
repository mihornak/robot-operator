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

/** EARS comprehension tier. Teaser uses 0 (RC tank) and 1 (named targets). */
export type EarsTier = 0 | 1;

export type EntityKind =
  | 'scrap' // pickup, +1 scrap
  | 'crate' // triad crate on pedestal; `option` holds ChipId
  | 'cable' // sparking floor cable hazard (zone damage, telegraphed sparks)
  | 'fusedPrinter' // enemy: printer melted onto a vacuum, chases + spits paper
  | 'printerInnocent' // harmless decoy printer (wrong-target comedy)
  | 'mop' // harmless prop, wrong-target comedy
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
  /** ChipId for crates. */
  option?: ChipId;
  /** Human-ish label given to the parser ("the angry crate", "printer"). */
  label: string;
  /** Generic per-kind state machine tag (render may map to frames). */
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
  kind: 'bolt' | 'paper'; // robot bolt | enemy crumpled paper
  pos: Vec;
  vel: Vec;
}

// ---------------------------------------------------------------- robot & orders

/** Standing order the behavior tree executes. Set by the director from parsed commands. */
export type Order =
  | { kind: 'move'; dir: Dir } // tier 0: keeps going until wall/stop
  | { kind: 'stop' }
  | { kind: 'shoot' } // fire at nearest hostile in facing cone, else straight ahead
  | { kind: 'goto'; targetId: string } // tier 1: straight-line to entity (through hazards — that's the joke)
  | { kind: 'attack'; targetId: string }
  | { kind: 'pickup'; targetId: string }
  | { kind: 'enter'; targetId: string }; // elevator

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
  tier: EarsTier;
  chips: ChipId[];
  /** Voice-given name; null until the naming beat. Forgotten (reset to null) on floor change until MEMORY. */
  name: string | null;
  /** True once the MEMORY chip is installed — name persists, gag stops. */
  hasMemory: boolean;
  order: Order | null;
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
  /** Ticks robot has been continuously blocked by a wall (drives bump comedy). */
  wallBumpTicks: number;
}

// ---------------------------------------------------------------- sim state & events

export type SimEventType =
  | 'wall_bump' // robot drove into a wall (fires on impact, throttled by sim)
  | 'order_done' // goto/attack/pickup finished
  | 'order_blocked' // can't comply (e.g. shoot while carrying)
  | 'scrap_pickup'
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
  | 'chip_detour'; // MAGNET detoured to scrap

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
  /** Walkability grid [y][x], true = solid. Rebuilt on floor load. */
  solid: boolean[][];
  /** Events emitted by the LAST step() call — drained (replaced) each step. */
  events: SimEvent[];
  /** Sim halts (during boot/ceremony robot AI still idles; enemies freeze only when true). */
  frozen: boolean;
}

// ---------------------------------------------------------------- parser (LLM) contract

/** Tier-gated command intents + meta intents. */
export type IntentType =
  | 'move' // dir required
  | 'stop'
  | 'shoot'
  | 'goto' // tier 1+, target required
  | 'attack' // tier 1+
  | 'pickup' // tier 1+
  | 'enter_elevator'
  | 'name_robot' // naming beat; `name` holds the name
  | 'choose' // triad; `choice` holds ChipId
  | 'robot_choice' // player indifferent — robot picks (director rolls)
  | 'clarify' // parser unsure — ack_line IS the in-character ask-again
  | 'chatter'; // not a command; ack_line is the in-character reply

export interface ParsedCommand {
  intent: IntentType;
  dir?: Dir;
  /** Entity id from ParseRequest.entities. */
  target?: string;
  choice?: ChipId;
  name?: string;
  /** Robot's repeat-back / reply, toddler-speak, ≤7 words, third person. */
  ack_line: string;
  /** Player insulted the robot → sulk. */
  insult?: boolean;
  /** Where the parse came from (server sets). */
  source?: 'llm' | 'local';
}

export interface ParseEntity {
  id: string;
  kind: EntityKind;
  label: string;
  /** Rough bearing/distance from robot, for "the one on the left". */
  dir?: string;
  dist?: number;
}

export interface ParseRequest {
  utterance: string;
  tier: EarsTier;
  floor: number; // 1-based, for flavor
  robotName: string | null;
  /** Active chip ids. */
  personality: ChipId[];
  /** Triad options if a ceremony is active, else null. */
  options: ChipId[] | null;
  /** Awaiting the naming answer? */
  awaitingName: boolean;
  /** Visible entities the robot could target. */
  entities: ParseEntity[];
  /** Last few robot lines, for conversational context. */
  recent: string[];
  shouted: boolean;
}

// ---------------------------------------------------------------- server API

/** POST /api/parse : ParseRequest -> ParsedCommand (400/500 -> client falls back to local parser) */
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

export interface Utterance {
  text: string;
  shouted: boolean;
  source: 'speech' | 'typed';
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

export interface DeathCard {
  robotName: string;
  floor: number;
  heard: string; // what it HEARD, in its own words (last ack_line)
  did: string; // what it did ("DROVE INTO SPICY FLOOR.")
  lastWords: string;
  scrap: number;
}

export interface UiState {
  phase: GamePhase;
  /** OSD top-left, e.g. "CAM 03 · FLOOR 03 · REC ●". */
  osd: string;
  /** Installed module glyphs for the OSD strip. */
  glyphs: ChipId[];
  /** Current spoken caption (robot line) or ''. */
  caption: string;
  /** Player push-to-talk held. */
  pttHeld: boolean;
  /** 'idle' | 'listening' | 'thinking' — mic state indicator on OSD. */
  micState: 'idle' | 'listening' | 'thinking';
  /** Teletype input line currently being typed ('' = hidden). */
  teletype: string;
  teletypeActive: boolean;
  /** Sticky note visible (always, phases off/boot excepted). */
  stickyNote: boolean;
  deathCard: DeathCard | null;
  /** Robot head should aim at camera (ack tell), decays in render. */
  headToCameraMs: number;
  /** Mood glyph on OSD: '' | 'SULK' | 'FLEE'. */
  moodGlyph: string;
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
  | 'title'; // title card sting

export interface AudioEngine {
  /** Must be called from a user gesture. Starts hum. */
  init(): Promise<void>;
  playSfx(name: SfxName, opts?: { volume?: number; rate?: number }): void;
  /** Play robot voice MP3 bytes through the radio chain. Resolves when playback ends. */
  playVoiceBytes(bytes: ArrayBuffer): Promise<void>;
  stopVoice(): void;
  /** Room-tone hum level 0..1. */
  setHum(level: number): void;
  /** Synth beeps for teletype/OSD ticks. */
  blip(kind: 'teletype' | 'osd' | 'warn'): void;
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
