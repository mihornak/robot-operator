/**
 * The director: owns the loop, the phase machine, the beats (FIRST_MINUTES),
 * input routing, parse pipeline, and all wiring between subsystems.
 * This is deliberately the ONLY place where subsystems meet.
 */

import type {
  ChipId,
  CommandSource,
  GamePhase,
  MicHelp,
  ModuleId,
  Order,
  ParseRequest,
  ParsedCommand,
  PlanStep,
  RenderApp,
  SayRequest,
  SayTrigger,
  SimEvent,
  SimState,
  UiState,
  Utterance,
} from '@shared/types';
import { TICK_MS, TILE, UPGRADE_LAND_MS, UPGRADE_TOTAL_MS, standingLabels } from '@shared/types';
import { CHIPS, MODULES, TRIADS } from '@shared/content';
import { deflectTalk } from '@shared/smallTalk';
import { BANK_BY_ID, LINE_GROUPS } from '@shared/voiceLines';
import { makeRng } from '@shared/rng';

import * as sim from '../sim/index';
import { initArt } from '../art/index';
import { createRenderApp } from '../render/index';
import { blastGain, createAudioEngine } from '../audio/engine';
import { stopAllEmitters, updateEmitters } from '../audio/emitters';
import type { MicCommandSource } from '../voice/webspeech';
import { SILENT_RMS, WebSpeechSource } from '../voice/webspeech';
import { LlmSpeechSource } from '../voice/llmspeech';
import { TeletypeSource } from '../voice/teletype';
import { parseLocal } from '../voice/localParser';
import { apiParse, apiSay, logEvent } from '../net/api';
import type { SpeechPriority } from './speech';
import { SpeechQueue } from './speech';
import { WishlistGate } from './wishlist';

/**
 * The boss bed, bundled like every other asset (rule 1 — relative path, no CDN).
 * If the file is not in the build, playMusic resolves false and the arena is
 * simply quieter: no console noise, no missing-asset branch anywhere else.
 */
const BOSS_MUSIC_URL = './assets/music/boss.mp3';

const uiRng = makeRng(0xc0ffee); // presentation-only randomness

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(uiRng() * arr.length)]!;
}

/** FIRST_MINUTES beat-1 wait ladder: deterministic idles at 5s/10s/20s of silence. */
/**
 * Floors in the authored run. The 6th is THE SHREDDER, and it is the ending:
 * ride out of it and the feed dies on the cliffhanger. Kept as a named constant
 * rather than `FLOORS.length` so a future scratch floor appended for tooling
 * cannot silently extend the story.
 */
const FLOORS_IN_RUN = 6;

const WAIT_LADDER = [
  { at: 10000, line: 'idle_here' },
  { at: 28000, line: 'idle_spin' },
  { at: 55000, line: 'idle_waiting' },
] as const;

const DID_BY_CAUSE: Record<string, string> = {
  cable: 'DROVE INTO SPICY FLOOR.',
  paper: 'CAUGHT PAPER. WITH FACE.',
  enemy: 'HUGGED ANGRY MACHINE.',
};

/**
 * Mic troubleshooting copy, one entry per fault. Deliberately concrete and
 * ordered by likelihood — "check your input device" is useless advice on its
 * own, so each step names the thing to click. The card always ends with the
 * teletype, because the typed path is guaranteed to work (CLAUDE.md rule 4).
 */
const MIC_HELP: Record<MicHelp['fault'], MicHelp> = {
  unsupported: {
    fault: 'unsupported',
    title: 'This browser has no speech recognition.',
    steps: [
      'Chrome, Edge or Arc on desktop will work.',
      'Safari and Firefox need the voice server.',
      'Or play by typing — press any letter key.',
    ],
  },
  // Browsers with no recognition of their own record the press and send it to
  // the parse model instead (voice/llmspeech.ts). With no model key upstream
  // that path has nowhere to go, and the mic is not the thing that is broken.
  noServer: {
    fault: 'noServer',
    title: 'This browser cannot transcribe, and voice is offline.',
    steps: [
      'The mic is fine — nothing is listening at the other end.',
      'Chrome, Edge or Arc listen locally, with no server.',
      'Or play by typing — press any letter key.',
    ],
  },
  denied: {
    fault: 'denied',
    title: 'Microphone permission was refused.',
    steps: [
      'Click the padlock / mic icon left of the address bar.',
      'Set Microphone to Allow, then reload the page.',
      'Or play by typing — press any letter key.',
    ],
  },
  silent: {
    fault: 'silent',
    title: 'Permission is fine, but no sound is reaching us.',
    steps: [
      'Check the input device in your OS sound settings.',
      'Unmute the mic — hardware switches count.',
      'Watch the bar below and speak: it should move.',
    ],
  },
  noWords: {
    fault: 'noWords',
    title: 'Sound arrives, but no words come back.',
    steps: [
      'Speak a little louder, a little closer.',
      'Recognition is English — try a short English phrase.',
      'Or play by typing — press any letter key.',
    ],
  },
};

/** Pre-wake: the thing in the pile shifts on this cadence (ms). */
const STIR_EVERY_MS = 4200;

export async function startGame(host: HTMLElement): Promise<void> {
  const d = new Director(host);
  await d.init();
}

class Director {
  private state!: SimState;
  private ui: UiState = {
    phase: 'off',
    osd: '',
    glyphs: [],
    caption: '',
    pttHeld: false,
    micState: 'idle',
    teletype: '',
    teletypeActive: false,
    stickyNote: true, // taped to the monitor before the monitor is even on
    talkHint: false,
    micHelp: null,
    micLevel: 0,
    pileStir: 0,
    deathCard: null,
    ceremonyOptions: null,
    upgrade: null,
    headToCameraMs: 0,
    moodGlyph: '',
    orders: [],
    objective: '',
    plan: [],
    hp: 6,
    maxHp: 6,
    hpFlash: 0,
    awaitingBriefing: true,
    danger: 0,
    degrade: 0,
  };

  private render!: RenderApp;
  private audio = createAudioEngine();
  private speech!: SpeechQueue;
  private speechSource: MicCommandSource | null = null;
  private teletype = new TeletypeSource();
  /** Owns the screen and the keyboard between a finished run and the next one. */
  private wishlist = new WishlistGate();

  // beat state
  private woken = false;
  private awaitingName = false;
  private awaitingFirstOrder = false; // between "WHAT X DO?" and the first command
  private playerGivenName: string | null = null;
  /** Everything installed, in the order it went in — the OSD strip IS this list. */
  private modules: ModuleId[] = [];
  private ceremony: { options: ChipId[]; floor: number } | null = null;
  private ceremonyNudged = false;
  private firstBumpDone = false;
  private saidWalkClaim = false;
  private lastBumpBarkAt = 0;
  private lastIdleAt = 0;
  private lastUtteranceAt = 0;
  private lastHeard = '…';
  private lastDid = 'WOKE UP.';
  /** Rolling "VOICE: … / ROBOT: …" log handed to the parser as conversation memory. */
  private dialogue: string[] = [];
  /** Pre-wake pile theatre. */
  private lastStirAt = 0;
  private stirCount = 0;
  /** Presses that produced no words, since the last one that did. */
  private emptyPresses = 0;
  private micHelpUntil = 0;
  private lowHpSaidFloor = -1;
  /** Remaining steps of the operator's plan, in order. Stepped through on
   *  order_done; voided by any world break (death, floor change, ceremony). */
  private pendingPlan: PlanStep[] = [];
  /** A question the ROBOT asked and is waiting on, so a bare "yes" has meaning. */
  private pendingQuestion: string | null = null;
  /** What "yes" would execute. Never runs without the player agreeing to it. */
  private pendingProposal: ParsedCommand | null = null;
  private questionUntil = 0;
  /** One unprompted line in flight at a time, on a floor of silence between them. */
  private sayInFlight = false;
  private lastSayAt = 0;
  /** Unanswered asks in a row. Drives the ask → shorter ask → shut up ladder. */
  private askStreak = 0;
  /** Earliest the robot may make an unprompted noise again (randomised). */
  private nextIdleVoiceAt = 0;
  /** Kind of the last order the director set — sim nulls robot.order before order_done fires. */
  private lastOrderKind: Order['kind'] | null = null;
  private parsing = false;
  /** Remote parses still in flight that we have NOT already answered locally.
   *  `parsing` is derived from this: a fast-applied utterance is ANSWERED, so
   *  the mic goes idle and the robot is free to talk while the model catches up. */
  private slowPending = 0;
  /**
   * Monotonic utterance counter. A remote result whose seq is not the newest is
   * stale and is thrown away — which is what lets a second utterance be spoken
   * while the first is still in flight instead of being dropped whole. runEpoch
   * still covers the across-death case; this covers the within-life one.
   */
  private parseSeq = 0;
  /** Reaction times in ms, by which path produced the first visible reaction. */
  private lat: Record<'fast' | 'llm' | 'local_fallback', number[]> = {
    fast: [],
    llm: [],
    local_fallback: [],
  };
  private reconciled = { confirm: 0, refine: 0, held: 0 };
  private booting = false;
  private ended = false;
  /** Bumped on restart/death/cliffhanger — in-flight parses from before are void. */
  private runEpoch = 0;
  /** WAIT_LADDER progress; length = exhausted, armed to 0 when a wait begins. */
  private idleLadderStep: number = WAIT_LADDER.length;
  private ladderStart = 0;
  private lastSparkAt = 0;
  /** pointerId of the finger currently holding PTT; null when none is down */
  private touchPtt: number | null = null;

  constructor(private host: HTMLElement) {}

  async init(): Promise<void> {
    if (import.meta.env.DEV) (globalThis as { __dir?: unknown }).__dir = this;
    const art = await initArt();
    this.render = createRenderApp(art);
    await this.render.init(this.host);
    this.state = sim.initialState((Date.now() % 2147483647) | 0);
    this.speech = new SpeechQueue(this.audio, () => {
      this.lastIdleAt = performance.now();
    });

    // EXACTLY ONE mic source, chosen per browser. Web Speech wherever it
    // exists: recognition on the device is free, private and instant. Where it
    // does not — Safari, and therefore every browser on iOS — we record the
    // press and let the parse model listen to it instead (voice/llmspeech.ts).
    // ?stt=llm forces the second path on a machine that has the first.
    const forceLlm = new URLSearchParams(location.search).get('stt') === 'llm';
    const speech = new WebSpeechSource();
    const mic: MicCommandSource =
      !forceLlm && speech.available ? speech : new LlmSpeechSource();
    if (mic.available) this.speechSource = mic;

    this.teletype.onUtterance((u) => {
      // With a mic available the teletype is transient; keep it live otherwise.
      if (this.speechSource) this.teletype.setActive(false);
      void this.handleUtterance(u);
    });
    this.teletype.onChange?.((value: string, active: boolean) => {
      this.ui.teletype = value;
      this.ui.teletypeActive = active || value.length > 0;
    });

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    this.bindTouch();

    // DEV debug overlay: live STT transcript + errors + parse state (never in prod builds).
    if (import.meta.env.DEV) {
      const dbg = document.createElement('div');
      dbg.style.cssText =
        'position:fixed;right:8px;bottom:8px;z-index:99;max-width:420px;padding:6px 9px;' +
        'font:12px/1.5 monospace;color:#7dff9a;background:rgba(0,0,0,0.72);border:1px solid #2c4;' +
        'pointer-events:none;white-space:pre-wrap;';
      document.body.appendChild(dbg);
      // liveTranscript only exists on the Web Speech path — the recorded path
      // has no words until the server answers.
      const src = this.speechSource instanceof WebSpeechSource ? this.speechSource : null;
      setInterval(() => {
        dbg.textContent =
          `mic: ${this.ui.micState}  avail: ${this.speechSource?.available ?? 'no-src'}\n` +
          `heard: ${src?.liveTranscript || '—'}\n` +
          `err: ${src?.lastError || '—'}\n` +
          `robot heard: ${this.lastHeard}`;
      }, 100);
    }

    // DEV shortcut: ?floor=N[&name=X][&tier=1] boots straight into a floor.
    if (import.meta.env.DEV) {
      const q = new URLSearchParams(location.search);
      const f = parseInt(q.get('floor') ?? '', 10);
      // Bounded on the floor TABLE, not on a literal: a floor that exists and
      // cannot be reached by the shortcut that exists to reach it is a floor
      // nobody tests.
      if (f >= 1 && f <= sim.FLOOR_COUNT) {
        this.woken = true;
        sim.wakeRobot(this.state);
        this.awaitingFirstOrder = false;
        this.playerGivenName = (q.get('name') ?? 'SPARKY').toUpperCase();
        this.state.robot.name = this.playerGivenName;
        if (q.get('ears') === '1' || f >= 4) sim.applyEars(this.state); // EARS crate is floor 3
        if (f >= 5) sim.applyBrain(this.state); // BRAIN crate is floor 4
        // The boss floor is not reachable by clearing floor 5 — it is appended
        // off the end of the run and this shortcut is the ONLY door into it. So
        // this line is not a convenience, it is the arena's loadout:
        //
        // MEASURED, five seeds, the shredder at 96 hp with its adds running:
        // a base robot (damage 1, 24-tick cooldown) loses 5/5. It lands 40–60
        // damage across 26–43 seconds and dies with the boss still in phase 1 —
        // its six hit points are simply not a budget that stretches over a
        // fight four times longer than the one they were priced for. The same
        // robot with ZAP (damage 2, 16-tick cooldown) wins, in 22–42 seconds,
        // living through all three phases and finishing on 0–5 hp.
        //
        // Nothing in the authored five floors grants ZAP (the only loose chip
        // in the run is MEMORY, on floor 2), so without this the trailer floor
        // is unwinnable by construction. The real fix is the ROCKET crate in
        // the arena becoming a genuine second answer — today the launcher has
        // no caller in sim/robot.ts at all, see rocketCeremony below.
        if (f >= 6) sim.applyChip(this.state, 'ZAP');
        // …and the OSD strip has to agree with what was just installed, or the
        // dev shortcut lies about the state it just built.
        if (this.state.robot.tier >= 2) this.modules.push('EARS');
        if (this.state.robot.ideas) this.modules.push('BRAIN');
        for (const c of this.state.robot.chips) this.modules.push(c);
        this.ui.glyphs = [...this.modules];
        sim.loadFloor(this.state, f - 1);
        if (f === FLOORS_IN_RUN) void this.audio.prefetchMusic(BOSS_MUSIC_URL);
        if (!this.state.robot.hasMemory) this.state.robot.name = null;
        this.ui.phase = 'play';
        this.ui.stickyNote = false;
        this.setOsd();
        this.booting = true;
      }
    }

    let last = performance.now();
    let acc = 0;
    let lastRun = -1;
    // Two drivers, one body: rAF while visible; a Worker heartbeat while the
    // tab is hidden (background timers are throttled to 1Hz, Workers are not).
    // The 8ms guard keeps the two chains from double-stepping a frame.
    const tick = (now: number) => {
      if (now - lastRun < 8) return;
      lastRun = now;
      try {
        loopBody(now);
      } catch (err) {
        console.error('[dir] loop error', err);
      }
    };
    const rafChain = () =>
      requestAnimationFrame((t) => {
        tick(t);
        rafChain();
      });
    const heart = new Worker(
      URL.createObjectURL(
        new Blob(['setInterval(function(){postMessage(0)},33)'], { type: 'text/javascript' }),
      ),
    );
    heart.onmessage = () => {
      if (document.hidden) tick(performance.now());
    };
    const loopBody = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      const frameEvents: SimEvent[] = [];
      if (this.simRunning()) {
        acc += dt;
        let steps = 0;
        while (acc >= TICK_MS && steps < 5) {
          sim.step(this.state);
          // Collect BEFORE processEvents — a floor load in there replaces state.events.
          frameEvents.push(...this.state.events);
          this.processEvents(this.state.events);
          acc -= TICK_MS;
          steps++;
        }
        if (acc > TICK_MS) acc = TICK_MS; // step cap hit — keep alpha ≤ 1
        // Placed ambience follows the robot. Outside the fixed-step loop on
        // purpose: this is a fade, not a rule, and it belongs to the frame.
        updateEmitters(this.audio, sim.floorSounds(this.state.floorIndex), this.state.robot.pos);
      } else {
        acc = 0;
      }
      this.updatePresentation(now, dt);
      this.render.render({
        sim: this.state,
        ui: this.ui,
        alpha: acc / TICK_MS,
        frameEvents,
        lit: sim.floorLit(this.state.floorIndex),
      });
    };
    rafChain();
  }

  private simRunning(): boolean {
    return this.ui.phase === 'play' || this.ui.phase === 'ceremony';
  }

  // ---------------------------------------------------------------- input

  private onKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return;
    if (this.wishlist.open) return; // the gate owns the keyboard while it is up
    const phase = this.ui.phase;

    if (phase === 'off') {
      if (e.code === 'Space') void this.boot();
      return;
    }
    if (phase === 'boot') return;
    // The two last frames of a run. Both loop back — through the gate.
    if (phase === 'death' || phase === 'title') {
      this.gateThenRestart();
      return;
    }
    if (phase === 'cliffhanger') return;

    // Teletype auto-activates on any printable char (space stays PTT until
    // there's a buffer); Escape closes it. The typed path must ALWAYS work.
    if (e.key === 'Escape') {
      if (this.ui.micHelp) {
        this.dismissMicHelp();
        return;
      }
      this.teletype.setActive(false);
      this.ui.teletypeActive = false;
      return;
    }
    if (
      !this.teletype.active &&
      e.key.length === 1 &&
      e.key !== ' ' &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      this.teletype.setActive(true);
    }
    if (this.teletype.handleKey(e)) {
      this.ui.teletype = this.teletype.value;
      this.ui.teletypeActive = true;
      this.audio.blip('teletype');
      e.preventDefault();
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      this.startPtt();
    }
  }

  /**
   * A finger is the space bar. Hold anywhere on the monitor to transmit, tap to
   * power on, tap to loop — the same phase machine, the same PTT, no second
   * code path to keep in sync. Bound to the canvas host, not the window, so the
   * wishlist gate (DOM, sitting above the monitor) keeps its own taps.
   */
  private bindTouch(): void {
    this.host.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return; // a mouse has a keyboard beside it
      e.preventDefault();
      this.onTouchDown(e);
      // Capture so a finger that slides off the canvas still delivers its up.
      // AFTER the handler and inside a try: capture throws if the pointer is
      // already gone (a tap fast enough to release first), and a failed nicety
      // must never swallow the order.
      try {
        (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
      } catch {
        // no capture — the window-level pointerup below is the safety net
      }
    });
    const up = (e: PointerEvent): void => {
      if (this.touchPtt !== e.pointerId) return;
      this.touchPtt = null;
      if (this.ui.pttHeld) void this.endPtt();
    };
    this.host.addEventListener('pointerup', up);
    this.host.addEventListener('pointercancel', up);
    // Belt and braces: a lost capture (context menu, app switch) must not leave
    // the transmission open forever.
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  private onTouchDown(e: PointerEvent): void {
    if (this.wishlist.open) return;
    const phase = this.ui.phase;

    if (phase === 'off') {
      void this.boot();
      return;
    }
    if (phase === 'boot' || phase === 'cliffhanger') return;
    if (phase === 'death' || phase === 'title') {
      this.gateThenRestart();
      return;
    }
    // A typed command in flight owns the input; the finger does not interrupt it.
    if (this.teletype.active && this.teletype.value.length > 0) return;
    if (this.touchPtt !== null) return; // a second finger is not a second mic
    this.touchPtt = e.pointerId;
    this.startPtt();
  }

  /** A run does not loop until the player has left an address (game/wishlist.ts). */
  private gateThenRestart(): void {
    if (this.wishlist.satisfied) {
      this.restart();
      return;
    }
    void this.wishlist
      .show({
        floor: this.state.floorIndex + 1,
        robotName: this.state.robot.name ?? this.playerGivenName ?? undefined,
      })
      .then(() => this.restart());
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (this.wishlist.open) return;
    if (e.code === 'Space' && this.ui.pttHeld) {
      e.preventDefault();
      void this.endPtt();
    }
  }

  private startPtt(): void {
    if (this.ui.pttHeld || this.parsing) return;
    this.ui.talkHint = false;
    this.ui.pttHeld = true;
    this.ui.micState = 'listening';
    this.ui.headToCameraMs = 900;
    this.audio.playSfx('radio_on');
    this.speechSource?.start();
  }

  private async endPtt(): Promise<void> {
    this.ui.pttHeld = false;
    this.audio.playSfx('radio_off');
    if (!this.speechSource) {
      // No mic path at all: say so plainly and open the typed path.
      this.ui.micState = 'idle';
      this.showMicHelp('unsupported');
      this.teletype.setActive(true);
      this.ui.teletypeActive = true;
      return;
    }
    this.ui.micState = 'thinking';
    const u = await this.speechSource.stop();
    // A recorded press carries no text at all — the words are inside u.audio
    // and only the parse model can read them. Empty means empty either way.
    if (!u || (!u.text.trim() && !u.audio)) {
      this.ui.micState = 'idle';
      this.onEmptyPress();
      return;
    }
    this.emptyPresses = 0;
    this.dismissMicHelp();
    await this.handleUtterance(u);
  }

  /**
   * A press that produced no words. The robot must NOT wake off this and must
   * NOT claim the voice was mumbly — there may have been no voice at all. We
   * work out which of the four failure modes it actually was and say so.
   */
  private onEmptyPress(): void {
    this.emptyPresses++;
    const d = this.speechSource?.diagnose();
    const heardAudio = (d?.peakRms ?? 0) >= SILENT_RMS;

    if (!this.woken) {
      // Pre-wake: the pile stirs — proof the game is alive — but the robot
      // stays asleep. Waking is reserved for words that actually arrived.
      this.stir();
      if (this.emptyPresses >= 2) {
        this.showMicHelp(!d || d.permission === 'denied' ? 'denied' : heardAudio ? 'noWords' : 'silent');
      }
      return;
    }

    if (d && d.permission === 'denied') {
      this.showMicHelp('denied');
      this.teletype.setActive(true);
      this.ui.teletypeActive = true;
      return;
    }
    if (!heardAudio) {
      // Silence is not mumbling. Nothing reached the mic; don't blame the player.
      if (this.emptyPresses >= 2) this.showMicHelp('silent');
      return;
    }
    // Real audio, no words — THIS is what "mumbly" was always meant for.
    this.speech.sayBank('mumbly', 'ack');
    if (this.emptyPresses >= 3) this.showMicHelp('noWords');
  }

  private showMicHelp(fault: MicHelp['fault']): void {
    if (this.ui.micHelp?.fault !== fault) this.audio.blip('warn');
    this.ui.micHelp = MIC_HELP[fault];
    this.micHelpUntil = performance.now() + 30000;
  }

  private dismissMicHelp(): void {
    this.ui.micHelp = null;
    this.micHelpUntil = 0;
  }

  /** Something moves under the heap: one soft clunk + a render shudder. */
  private stir(): void {
    this.lastStirAt = performance.now();
    this.ui.pileStir = 1;
    this.stirCount++;
    this.audio.playSfx('bump', { volume: 0.35, rate: 0.55 + uiRng() * 0.15 });
    if (this.stirCount % 3 === 0) this.audio.playSfx('servo', { volume: 0.3, rate: 0.7 });
  }

  // ---------------------------------------------------------------- boot & beats

  private async boot(): Promise<void> {
    if (this.booting) return;
    this.booting = true;
    if (import.meta.env.DEV) console.log('[dir] boot: audio.init…');
    try {
      await this.audio.init();
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[dir] audio.init failed', err);
    }
    if (import.meta.env.DEV) console.log('[dir] boot: audio ready');
    this.audio.playSfx('boot');
    this.render.fx.bootFlash();
    this.ui.phase = 'boot';
    logEvent('boot');
    // The power-on thunk knocks the sticky note loose — it drops and is gone.
    setTimeout(() => {
      this.ui.stickyNote = false;
    }, 500);
    // Mic permission prompt now, over the boot flash — not on first PTT.
    void this.speechSource?.warmup();
    setTimeout(() => {
      this.ui.phase = 'play';
      this.setOsd();
      this.audio.setHum(0.5);
      this.lastIdleAt = performance.now();
    }, 1400);
    // HOLD [SPACE] TO TALK — fades in after ~3s of stillness; one re-show if ignored.
    setTimeout(() => {
      if (!this.woken) this.ui.talkHint = true;
    }, 4400);
    setTimeout(() => {
      if (!this.woken) this.ui.talkHint = true;
    }, 19400);
    // No mic at all: say so early rather than letting them press space at a
    // heap of junk forever. With a mic we stay quiet and let them try.
    setTimeout(() => {
      if (!this.woken && !this.speechSource) this.showMicHelp('unsupported');
    }, 9000);
  }

  private wake(): void {
    this.woken = true;
    this.ui.talkHint = false;
    this.dismissMicHelp();
    this.ui.headToCameraMs = 2000;
    this.ui.pileStir = 0;
    // The pile bursts, the robot launches out of it, and only THEN does it
    // speak. Everything before this frame was a heap of dead machines.
    sim.wakeRobot(this.state);
    this.audio.playSfx('servo');
    this.audio.playSfx('bump', { volume: 0.9, rate: 0.7 });
    this.render.fx.shake(4, 320);
    this.render.fx.glitchFrame();
    // Keep the wake SHORT: hi + the name ask, then wait. Less is more.
    this.speech.sayBank('wake_hello', 'beat', 600);
    this.speech.sayBank('wake_name_ask', 'beat');
    this.awaitingName = true;
    // It has just met the operator; wandering off mid-introduction would throw
    // away the one beat the whole opening is built on. Initiative starts once
    // it has a name.
    sim.setAutonomy(this.state, false);
    this.lastIdleAt = performance.now() + 4000; // silence timer starts after the ask
    logEvent('wake');
    // Silent refusal → self-name after 9s of nothing.
    setTimeout(() => {
      if (this.awaitingName && performance.now() - this.lastUtteranceAt > 11000) {
        this.selfName();
      }
    }, 12000);
  }

  private applyName(raw: string): void {
    const name = raw
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(' ')
      .toUpperCase()
      .replace(/[^A-Z0-9 '-]/g, '')
      .slice(0, 14);
    if (!name) {
      this.selfName();
      return;
    }
    this.playerGivenName = name;
    this.state.robot.name = name;
    this.awaitingName = false;
    this.awaitingFirstOrder = true;
    sim.setAutonomy(this.state, true);
    this.armWaitLadder();
    this.speech.sayText(`ROBOT IS ${name}. ${name} IS GOOD AT THINGS.`, 'beat', 500);
    this.speech.sayText(`WHAT ${name} DO?`, 'beat');
    logEvent('named', { name });
  }

  private armWaitLadder(): void {
    this.idleLadderStep = 0;
    this.ladderStart = performance.now();
  }

  private selfName(): void {
    if (!this.awaitingName) return;
    this.awaitingName = false;
    this.awaitingFirstOrder = true;
    sim.setAutonomy(this.state, true);
    this.armWaitLadder();
    this.playerGivenName = 'ROBOT';
    this.state.robot.name = 'ROBOT';
    this.speech.sayBank('wake_self_name', 'beat', 500);
    this.speech.sayBank('what_do', 'beat');
    logEvent('named', { name: 'ROBOT', self: 1 });
  }

  // ---------------------------------------------------------------- utterances → commands

  private async handleUtterance(u: Utterance): Promise<void> {
    this.ui.talkHint = false;
    this.emptyPresses = 0;
    this.dismissMicHelp(); // words arrived; whatever was wrong isn't anymore
    this.lastUtteranceAt = performance.now();
    this.lastIdleAt = performance.now();
    // Somebody answered. The robot is allowed to be curious again.
    this.askStreak = 0;
    this.nextIdleVoiceAt = 0;
    if (this.awaitingFirstOrder) this.armWaitLadder();
    this.ui.headToCameraMs = 900;
    logEvent('utterance', { source: u.source, shouted: u.shouted ? 1 : 0 });

    if (!this.woken) {
      // THE relationship beat, and it is earned: this only runs once real words
      // have come through, so a broken mic can never fake it.
      this.ui.micState = 'idle';
      this.wake();
      return;
    }

    const t0 = performance.now();
    const epoch = this.runEpoch;
    const seq = ++this.parseSeq;
    // A recorded press has no words yet — they come back as `heard`. Hold the
    // slot with a marker so the log keeps its VOICE/ROBOT order, then fill it
    // in (or drop it) the moment the parse lands.
    const pending = `VOICE: …#${seq}`;
    this.remember(u.audio ? pending : `VOICE: ${u.text}`);
    const req = this.parseRequest(u);

    // LOCAL FIRST, synchronously. The keyword matcher is a table lookup — it
    // costs microseconds, and for the handful of shapes in fastEligible() its
    // answer cannot be wrong in a way that is worth 1.5 seconds of waiting.
    // The model still runs, and still gets the last word (see reconcile).
    const local = parseLocal(u.text, {
      tier: req.tier,
      options: req.options,
      awaitingName: req.awaitingName,
      entities: req.entities,
      brain: req.brain,
      pendingQuestion: req.pendingQuestion,
      robotName: req.robotName,
      recent: req.recent,
      calm: req.calm,
    });
    // The local matcher reads TEXT. A recorded press has none, so there is
    // nothing to match and nothing to answer early with — the model is the
    // only reader on that path.
    const fast =
      !u.audio && this.fastEligible(local, u.text.trim().split(/\s+/).filter(Boolean).length);
    if (fast) {
      this.apply(local);
      this.reaction(t0, 'fast', local.intent);
      // Answered. The mic goes straight back to idle rather than sitting on
      // "thinking" for a second and a half about a decision already made.
      if (!this.ui.pttHeld) this.ui.micState = 'idle';
    } else {
      this.slowPending++;
      this.parsing = true;
      this.ui.micState = 'thinking';
    }

    let remote: ParsedCommand | null = null;
    try {
      remote = await apiParse(req);
    } catch {
      remote = null; // network/timeout — the local reading is all we have
    }
    // Fill the held slot before ANY early return below: a marker left in the
    // dialogue log would be sent to the model as if the player had said it.
    if (u.audio) {
      const i = this.dialogue.lastIndexOf(pending);
      if (i >= 0) {
        if (remote?.heard) this.dialogue[i] = `VOICE: ${remote.heard}`;
        else this.dialogue.splice(i, 1);
      }
    }
    // A `local` answer to a RECORDED press means the server never ran the
    // model (no key upstream): it parsed the empty string we sent alongside
    // the audio. That is not a reading of what the player said, it is the
    // absence of one — and the mic is not what is broken, so say which.
    if (u.audio && remote?.source === 'local') {
      remote = null;
      this.showMicHelp('noServer');
      this.teletype.setActive(true);
      this.ui.teletypeActive = true;
    }
    if (!fast) {
      this.slowPending = Math.max(0, this.slowPending - 1);
      this.parsing = this.slowPending > 0;
      if (!this.parsing && !this.ui.pttHeld) this.ui.micState = 'idle';
    }
    // The world changed under the parse (death/restart/ending) — result is void.
    if (epoch !== this.runEpoch || !this.simRunning()) return;
    // ...and so is a result the operator has already talked over.
    if (seq !== this.parseSeq) {
      logEvent('parse_stale', { fast: fast ? 1 : 0 });
      return;
    }

    if (!fast) {
      // On the recorded path `local` was parsed from an empty string, so it is
      // a "mumbly" clarify — the one thing the robot must never say when the
      // player DID speak and it was the server that failed. Say the true thing
      // instead, in its own voice.
      const cmd =
        remote ??
        (u.audio
          ? ({ intent: 'clarify', ack_line: 'ROBOT EARS WENT AWAY. AGAIN?' } as ParsedCommand)
          : local);
      this.apply(cmd);
      this.reaction(t0, remote ? 'llm' : 'local_fallback', cmd.intent);
      return;
    }
    if (remote) this.reconcile(local, remote);
  }

  /**
   * May this local reading be applied NOW, before the model has spoken?
   *
   * The criterion is STRUCTURAL, not a confidence score. There is no confidence
   * anywhere in this pipeline, and inventing a number over a keyword matcher
   * would be fiction dressed as maths. What is safe is decided by SHAPE:
   *
   * - The panic class — stop, hide, a short move+direction. These are reflexes.
   *   The operator is reacting to something on screen and a model disagreeing
   *   1.5 seconds later is never worth the delay.
   * - The directive class — and this one is FREE, which is why the whole design
   *   works. applyDirectives runs BEFORE the intent switch and the `directive`
   *   case touches no order, so applying a rule early cannot cancel, redirect
   *   or hitch anything the robot is currently doing.
   *
   * Everything target-bearing is excluded: a wrong `goto` visibly sends the
   * robot across the room, and that is exactly what the model is for. affirm
   * and deny are excluded because they CONSUME pendingProposal — firing one
   * twice corrupts state that has no second copy.
   */
  private fastEligible(c: ParsedCommand, tokens: number): boolean {
    if (this.awaitingName || this.ceremony || this.pendingQuestion) return false;
    if (c.insult) return false;
    if (c.plan && c.plan.length > 0) return false;
    if (c.target) return false;
    if (c.intent === 'affirm' || c.intent === 'deny') return false;
    // Long sentences are briefs, not reflexes; the model reads those better.
    if (tokens > 6) return false;
    if (c.intent === 'stop' || c.intent === 'hide') return true;
    // "RUN!" is the definitive reflex utterance. Waiting a second and a half
    // for the model to confirm a panic order is the exact failure this path
    // exists to prevent — and unlike a goto, being wrong about it is cheap.
    if (c.intent === 'flee') return true;
    // Step COUNTS are where STT homophones bite hardest ("go to steps right"),
    // and reconciling those is the single thing the model is most useful for.
    if (c.intent === 'move' && c.dir && c.amount !== 'step') return true;
    if (c.intent === 'directive' && c.directives && c.directives.length > 0) return true;
    return false;
  }

  /**
   * The model landed a second behind a reading we already acted on.
   *
   * Same shape → say NOTHING. The robot already answered, and answering twice
   * is the fast path handing back the second it just saved.
   * Different shape → refine, with one exception: a `clarify` or `chatter` is
   * not evidence against a halt the operator already watched land. A shrug must
   * never undo a stop.
   */
  private reconcile(fast: ParsedCommand, remote: ParsedCommand): void {
    const sameCore =
      remote.intent === fast.intent &&
      (remote.dir ?? null) === (fast.dir ?? null) &&
      (remote.target ?? null) === (fast.target ?? null);
    const newRules = (remote.directives ?? []).filter((d) => !(fast.directives ?? []).includes(d));

    if (sameCore) {
      // Only the rules can still differ, and merging those is silent by
      // construction — applyDirectives changes no order.
      if (newRules.length > 0) this.mergeDirectives(newRules);
      this.reconciled.confirm++;
      logEvent('parse_confirm', { intent: remote.intent, merged: newRules.length });
      return;
    }
    if (remote.intent === 'clarify' || remote.intent === 'chatter') {
      if (newRules.length > 0) this.mergeDirectives(newRules);
      this.reconciled.held++;
      logEvent('parse_held', { was: fast.intent, model: remote.intent });
      return;
    }
    this.reconciled.refine++;
    logEvent('parse_refine', { was: fast.intent, now: remote.intent });
    this.apply(remote);
  }

  /** Fold in rules the model found and the local reading missed. No speech:
   *  the ack for this utterance has already been said. */
  private mergeDirectives(kinds: ParsedCommand['directives']): void {
    if (!kinds || kinds.length === 0) return;
    const st = sim.applyDirectives(this.state, kinds);
    this.ui.orders = standingLabels(st);
    logEvent('directives', { kinds: kinds.join(','), merged: 1 });
  }

  /** First VISIBLE reaction to an utterance: the order landed or the caption
   *  started. Both happen inside apply(), synchronously, so this is the honest
   *  moment to stop the clock. */
  private reaction(t0: number, path: 'fast' | 'llm' | 'local_fallback', intent: string): void {
    const ms = Math.round(performance.now() - t0);
    this.lat[path].push(ms);
    logEvent('reaction', { path, ms, intent });
  }

  /** DEV: `__dir.latencyReport()` in the console. p50/p95 per path, fast-path
   *  coverage, refine rate — the numbers the fast path has to justify itself on. */
  latencyReport(): Record<string, unknown> {
    const q = (a: number[], p: number): number =>
      a.length === 0 ? 0 : [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!;
    const total = this.lat.fast.length + this.lat.llm.length + this.lat.local_fallback.length;
    const out: Record<string, unknown> = { n: total };
    for (const k of ['fast', 'llm', 'local_fallback'] as const) {
      out[k] = { n: this.lat[k].length, p50: q(this.lat[k], 0.5), p95: q(this.lat[k], 0.95) };
    }
    out.fastCoverage = total === 0 ? 0 : +(this.lat.fast.length / total).toFixed(3);
    const rec = this.reconciled.confirm + this.reconciled.refine + this.reconciled.held;
    out.reconcile = { ...this.reconciled, refineRate: rec === 0 ? 0 : +(this.reconciled.refine / rec).toFixed(3) };
    return out;
  }

  /**
   * Say a RUN of sentences as one turn of conversation.
   *
   * Two rules make this work rather than turn the robot into a monologue
   * machine. First, the combat gate is re-checked HERE, at the moment of
   * speaking, not only where the reply was written: a parse takes seconds and
   * a machine can wake up inside them, and a warm three-sentence answer landing
   * while the robot is being shot at is worse than no feature at all. Second,
   * each sentence is its own speech item — one caption line, one TTS clip, a
   * beat between them — so the robot sounds like it is thinking between
   * sentences instead of reciting a paragraph.
   */
  private speakRun(lines: string[]): void {
    const name = (this.state.robot.name ?? 'ROBOT').toUpperCase();
    const calm = !sim.canSeeHostile(this.state) && !this.ceremony;
    const run = (calm ? lines : deflectTalk(name, this.dialogue, lines[0] ?? name))
      .map((l) => l.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 4);
    if (run.length === 0) return;
    for (let i = 0; i < run.length; i++) {
      this.remember(`ROBOT: ${run[i]}`);
      this.speech.sayText(run[i]!, 'ack', i === run.length - 1 ? undefined : 220);
    }
    this.lastHeard = run[run.length - 1]!;
    // Nothing unprompted on top of a conversation. Being asked "how are you"
    // and answering it while the idle ladder simultaneously asks for a job is
    // two robots talking at once.
    this.quietFor(3000 + run.length * 1600);
    logEvent('talk', { lines: run.length, calm: calm ? 1 : 0 });
  }

  /** Keep the last few turns of both sides — the parser's conversation memory. */
  private remember(line: string): void {
    this.dialogue.push(line);
    if (this.dialogue.length > 8) this.dialogue.splice(0, this.dialogue.length - 8);
  }

  /**
   * The robot speaks because the WORLD did something — it arrived somewhere,
   * noticed something, ran out of things to do. The sentence is written per
   * situation by /api/say rather than pulled from the line bank, which is the
   * whole difference between a companion and a jukebox.
   *
   * Everything about this path is fail-soft and non-blocking: one request in
   * flight, a floor of quiet between lines, a bank line when the network or the
   * keys aren't there, and silence rather than talking over an ack.
   */
  private voice(
    trigger: SayTrigger,
    detail: string,
    opts: { priority?: SpeechPriority; minGapMs?: number; bank?: string } = {},
  ): void {
    const priority = opts.priority ?? 'bark';
    const minGap = opts.minGapMs ?? 5000;
    const now = performance.now();
    const fallback = (): void => {
      if (opts.bank) this.speech.sayBank(opts.bank, priority);
    };
    // Barks lose to anything already being said; asking the model for a line
    // that SpeechQueue would drop anyway is a wasted call and a wasted second.
    if (this.sayInFlight || now - this.lastSayAt < minGap) return;
    if (priority !== 'beat' && this.speech.busy) {
      fallback();
      return;
    }
    if (this.ui.pttHeld || this.parsing) return; // never talk over the operator

    this.sayInFlight = true;
    this.lastSayAt = now;
    const epoch = this.runEpoch;
    const r = this.state.robot;
    const req: SayRequest = {
      trigger,
      detail,
      floor: this.state.floorIndex + 1,
      robotName: r.name,
      personality: r.chips,
      standing: r.standing,
      ideas: r.ideas,
      hp: r.hp,
      maxHp: r.maxHp,
      carrying: r.carrying !== null,
      entities: sim.visibleEntities(this.state),
      recent: [...this.dialogue],
    };
    void apiSay(req)
      .then((res) => {
        if (epoch !== this.runEpoch || !this.simRunning()) return;
        const line = res.line.trim().toUpperCase();
        if (!line) {
          fallback();
          return;
        }
        this.speech.sayText(line, priority);
        this.remember(`ROBOT: ${line}`);
        this.lastHeard = line;
        // Anything the robot suggested is something "yes" can now mean. An
        // outright question stays live longer than a passing remark, but both
        // are answerable — a player who says "do it" after "SHINY CRATE OVER
        // THERE" is agreeing, and being told there was no question is deadening.
        if (res.proposal) {
          this.pendingQuestion = line;
          this.pendingProposal = {
            intent: res.proposal.intent,
            ...(res.proposal.target ? { target: res.proposal.target } : {}),
            ...(res.proposal.dir ? { dir: res.proposal.dir } : {}),
            // A proposal may be a RULE rather than a destination — "SHOULD
            // ROBOT KEEP BACK?" is the most useful thing it can ask when it
            // walks into a room with three machines in it, and "yes" has to
            // mean something. apply() already knows how to install directives.
            ...(res.proposal.directives?.length ? { directives: res.proposal.directives } : {}),
            ack_line: 'ROBOT DOES IT.',
          };
          this.questionUntil = performance.now() + (res.question ? 25000 : 12000);
        }
      })
      .catch(() => {
        if (epoch === this.runEpoch) fallback();
      })
      .finally(() => {
        this.sayInFlight = false;
      });
  }

  private clearQuestion(): void {
    this.pendingQuestion = null;
    this.pendingProposal = null;
    this.questionUntil = 0;
  }

  /** Hold all unprompted noise for at least this long. */
  private quietFor(ms: number): void {
    this.nextIdleVoiceAt = Math.max(this.nextIdleVoiceAt, performance.now() + ms);
  }

  /**
   * The robot has nothing to do and nobody is answering.
   *
   * Asking twice is company; asking six times is a fault light. So it asks
   * ONCE properly, once more in three words, and then stops asking altogether
   * and simply exists out loud — hums, spins, says something strange — on a
   * randomised and steadily longer clock. The randomness matters as much as
   * the escalation: a noise on a fixed timer stops reading as a personality
   * and starts reading as a loop.
   */
  private idleVoice(now: number): void {
    if (now < this.nextIdleVoiceAt) return;
    const streak = this.askStreak++;
    const jitter = (base: number, spread: number): number => base + uiRng() * spread;
    if (streak === 0) {
      this.voice('idle_ask', 'has run out of things to do and wants a job', {
        priority: 'idle',
        minGapMs: 0,
      });
      this.nextIdleVoiceAt = now + jitter(10000, 9000);
      return;
    }
    if (streak === 1) {
      this.voice(
        'idle_ask',
        'already asked once and got no reply — ask again but MUCH shorter, three words at most, and still suggest something',
        { priority: 'idle', minGapMs: 0 },
      );
      this.nextIdleVoiceAt = now + jitter(18000, 16000);
      return;
    }
    // Given up on being answered. Entertain itself instead.
    if (uiRng() < 0.35) this.audio.playSfx('spin');
    this.voice(
      'banter',
      'has been waiting a long while with no reply and has stopped expecting one — do NOT ask for orders, do NOT offer a plan, just say something idle and strange to itself',
      { priority: 'idle', minGapMs: 0, bank: pick(LINE_GROUPS.idle) },
    );
    this.nextIdleVoiceAt = now + jitter(26000, 40000);
  }

  /** Everything the interpreter needs about the world right now. Built once and
   *  shared by BOTH readings, so the local fast path and the model are looking
   *  at the same room — a fast reading resolved against different entities than
   *  the model saw would make reconcile() lie. */
  private parseRequest(u: Utterance): ParseRequest {
    const src = this.speechSource;
    const r = this.state.robot;
    return {
      utterance: u.text,
      audio: u.audio ?? null,
      alternatives: u.source === 'speech' ? (src?.alternatives ?? []) : [],
      tier: r.tier,
      floor: this.state.floorIndex + 1,
      robotName: r.name,
      personality: r.chips,
      options: this.ceremony ? this.ceremony.options : null,
      awaitingName: this.awaitingName,
      brain: r.brain,
      entities: sim.visibleEntities(this.state),
      recent: [...this.dialogue],
      shouted: u.shouted,
      standing: r.standing,
      pendingQuestion: this.pendingQuestion,
      busy: sim.describeOrder(this.state),
      hp: r.hp,
      maxHp: r.maxHp,
      carrying: r.carrying !== null,
      // Is there room in the moment for an actual conversation? Nothing awake
      // and hostile in view, and no ceremony waiting on an answer. The engine
      // decides this, never the model — see ParsedCommand.talk.
      calm: !sim.canSeeHostile(this.state) && !this.ceremony,
    };
  }

  /**
   * @param fromPlan true when this is the next step of a plan already running,
   *   which is the one case that must NOT wipe the queue it came out of.
   */
  private apply(cmd: ParsedCommand, fromPlan = false): void {
    logEvent('command', {
      intent: cmd.intent,
      source: cmd.source ?? 'llm',
      tier: this.state.robot.tier,
      floor: this.state.floorIndex + 1,
      refused: 0,
    });

    // A fresh utterance replaces the old plan wholesale. Half-merging a new
    // instruction into a stale queue is how a robot ends up doing something
    // nobody asked for two orders later.
    if (!fromPlan) this.pendingPlan = [];

    if (this.awaitingName) {
      if (cmd.intent === 'name_robot' && cmd.name) this.applyName(cmd.name);
      else this.selfName();
      return;
    }

    // "yes" / "no" only mean something against the question the robot asked.
    if (cmd.intent === 'affirm' || cmd.intent === 'deny') {
      const proposal = this.pendingProposal;
      this.clearQuestion();
      if (cmd.intent === 'affirm' && proposal) {
        // Hand the agreed plan straight back through apply(), which speaks the
        // ack and installs the order exactly as if the player had said it.
        this.apply({ ...proposal, ack_line: cmd.ack_line });
        return;
      }
      this.lastHeard = cmd.ack_line.toUpperCase();
      this.remember(`ROBOT: ${this.lastHeard}`);
      this.speech.sayText(cmd.ack_line, 'ack');
      if (cmd.intent === 'deny') this.setOrder({ kind: 'stop' });
      return;
    }
    // Any other real utterance answers the question by superseding it.
    this.clearQuestion();

    // Standing rules ride along with whatever else was said, and they are
    // applied BEFORE the order so the order runs under the new rules from its
    // very first tick — "go to the lift and avoid them" must not sprint into a
    // printer for a second while the policy catches up.
    if (cmd.directives && cmd.directives.length > 0) {
      const st = sim.applyDirectives(this.state, cmd.directives);
      this.ui.orders = standingLabels(st);
      logEvent('directives', { kinds: cmd.directives.join(',') });
    }

    // Being told ANYTHING substantive ends the hold at the floor entrance —
    // a rule or an answer counts as a briefing just as much as an order does.
    if (cmd.intent !== 'chatter' && cmd.intent !== 'clarify') sim.clearBriefing(this.state);

    // Safety net: "what can you do"-style chatter must never be dead air.
    // If the parser (server or local) returned no reply, answer by tier.
    if (cmd.intent === 'chatter' && !(cmd.ack_line ?? '').trim()) {
      cmd = { ...cmd, ack_line: 'ROBOT GOES. FIGHTS. HIDES. GRABS.' };
    }

    // A conversational answer logs its OWN sentences below; remembering the
    // one-line summary as well would have the robot reading its dialogue back
    // to itself twice and repeating shapes it thinks it has not used.
    const talking = cmd.intent === 'chatter' && (cmd.talk?.length ?? 0) > 0;
    this.lastHeard = cmd.ack_line.toUpperCase();
    if (!talking) this.remember(`ROBOT: ${this.lastHeard}`);
    if (cmd.insult) {
      sim.sulk(this.state, 180);
      this.audio.blip('warn');
      this.speech.sayBank('sulk', 'ack');
      return;
    }

    // TALK. The operator stopped giving orders and just spoke to it, and the
    // robot gets to answer at length — several short sentences, one after the
    // other, rather than the single clipped ack every other intent gets. This
    // is the whole difference between a machine you operate and one you have a
    // relationship with, and it is why `talk` exists as its own field.
    if (talking) {
      this.speakRun(cmd.talk!);
      return;
    }

    // The repeat-back — never the transcript.
    this.speech.sayText(cmd.ack_line, 'ack');

    // Hold the rest of the plan; each step fires as the previous order lands.
    if (!fromPlan && cmd.plan && cmd.plan.length > 0) {
      this.pendingPlan = [...cmd.plan];
      logEvent('plan_set', { steps: this.pendingPlan.length });
    }

    // Ceremony is NOT a jail: driving around is allowed (elevator B stays dark
    // until a chip is picked, so nothing breaks). The robot just keeps the
    // question alive with a single "WHICH?" nudge per wander.
    if (
      this.ceremony &&
      ['move', 'goto', 'attack', 'pickup', 'enter_elevator'].includes(cmd.intent)
    ) {
      if (!this.ceremonyNudged) {
        this.ceremonyNudged = true;
        this.speech.sayBank('crate_which', 'idle', 400);
      }
    }

    switch (cmd.intent) {
      case 'move':
        if (cmd.dir) {
          if (cmd.amount) {
            // Nudge: fixed distance, then the sim emits order_done + halts.
            // No line on completion — silence is fine, it did the thing.
            // "two steps right" is two tiles, not one: getting counts wrong is
            // the exact thing that made the robot feel like it wasn't listening.
            const steps = Math.max(1, Math.min(8, cmd.steps ?? 1));
            const px = cmd.amount === 'bit' ? 20 : TILE * steps;
            this.setOrder({ kind: 'move', dir: cmd.dir, distancePx: px });
            this.lastDid = `WENT ${cmd.dir.toUpperCase()} A BIT.`;
          } else {
            this.setOrder({ kind: 'move', dir: cmd.dir });
            this.lastDid = `WENT ${cmd.dir.toUpperCase()}.`;
          }
          this.saidWalkClaim = false;
        }
        break;
      case 'explore':
        this.setOrder({ kind: 'explore' });
        this.lastDid = 'WENT EXPLORING.';
        this.awaitingFirstOrder = false;
        break;
      case 'stop':
        this.setOrder({ kind: 'stop' });
        break;
      case 'shoot':
        this.setOrder({ kind: 'shoot' });
        this.lastDid = 'DID PEW PEW.';
        break;
      case 'goto':
      case 'attack':
      case 'pickup':
      case 'enter_elevator': {
        const targetId = cmd.target ?? (cmd.intent === 'enter_elevator' ? 'elevB' : undefined);
        let target = targetId ? sim.entityById(this.state, targetId) : undefined;
        // Last-mile guard on the dead shaft. Elevator A is the one the robot
        // rode IN on; it does nothing, and walking to it is always a wasted
        // trip that reads as the robot being an idiot. Every parse path can
        // produce it, so the invariant is enforced here as well as upstream.
        if (target?.kind === 'elevatorA') {
          target = sim.entityById(this.state, 'elevB') ?? undefined;
        }
        if (!target || target.dead) break; // ack already voiced the confusion
        const kind =
          cmd.intent === 'goto'
            ? 'goto'
            : cmd.intent === 'attack'
              ? 'attack'
              : cmd.intent === 'pickup'
                ? 'pickup'
                : 'enter';
        const order = { kind, targetId: target.id } as Order;
        // BRAIN: "sneak/careful" maps onto goto/pickup orders only.
        if (cmd.careful && (order.kind === 'goto' || order.kind === 'pickup')) order.careful = true;
        this.setOrder(order);
        this.lastDid =
          cmd.intent === 'attack'
            ? `FOUGHT ${target.label.toUpperCase()}.`
            : `WENT TO ${target.label.toUpperCase()}.`;
        break;
      }
      case 'name_robot':
        if (cmd.name) this.applyName(cmd.name);
        break;
      case 'choose':
        if (this.ceremony && cmd.choice && this.ceremony.options.includes(cmd.choice)) {
          this.resolveCeremony(cmd.choice);
        } else if (this.ceremony) {
          this.rereadCeremony();
        }
        break;
      case 'robot_choice':
        if (this.ceremony) {
          const chip = pick(this.ceremony.options);
          this.speech.sayBank('pick_taste', 'beat', 300);
          this.resolveCeremony(chip);
        }
        break;
      case 'hide':
        this.setOrder({ kind: 'hide' });
        this.lastDid = 'HID.';
        break;
      // "RUN!" — urgent and one-shot, which is why it is an intent and not a
      // standing rule. The sim picks retreat vs evade from what it can actually
      // see (sim.fleeOrder), so this stays a line the director cannot get wrong.
      case 'flee':
        this.setOrder(sim.fleeOrder(this.state));
        this.lastDid = 'RAN AWAY.';
        break;
      case 'avoid': {
        const target = cmd.target ? sim.entityById(this.state, cmd.target) : null;
        if (!target || target.dead) break; // ack already voiced the confusion
        // Standing order — the avoid-list rides along; a running order keeps
        // running and simply re-plans around the new cost.
        sim.addAvoid(this.state, target.id);
        this.ui.orders = standingLabels(this.state.robot.standing);
        // ...but "go around the cables" said to a STOPPED robot is a movement
        // instruction, not a rule change. Answering it with a new rule and no
        // motion is the acknowledge-and-do-nothing failure again: the operator
        // asked for a different ROUTE, and a route needs somewhere to be going.
        // Resume the objective so the rule they just set is visibly obeyed.
        if (this.state.robot.order === null) this.resumeObjective();
        break;
      }
      case 'directive':
        // The ack already said what changed; applyDirectives ran above.
        this.lastDid = 'CHANGED ITS RULES.';
        break;
      case 'clarify':
        if (this.ceremony) this.rereadCeremony(false);
        break;
      case 'affirm':
      case 'deny':
      case 'chatter':
        break;
    }
    if (
      this.awaitingFirstOrder &&
      ['move', 'stop', 'shoot', 'goto', 'attack', 'explore', 'pickup', 'hide', 'flee', 'avoid', 'directive', 'enter_elevator'].includes(
        cmd.intent,
      )
    ) {
      this.awaitingFirstOrder = false;
    }

    // A plan whose head left nothing running starts NOW. Briefs that open with
    // a rule ("watch out for the cables, then take the lift") or with a target
    // that turned out not to be there would otherwise sit in the queue waiting
    // for an order_done that is never coming, and the player would watch the
    // robot acknowledge the whole plan and then do none of it.
    if (this.pendingPlan.length > 0 && this.state.robot.order === null) this.advancePlan();
  }

  private setOrder(order: Order): void {
    this.lastOrderKind = order.kind;
    // Having something to do resets the give-up ladder: after finishing a real
    // job it is allowed to ask what next properly again, rather than staying
    // sulkily quiet because nobody answered it twenty minutes ago.
    this.askStreak = 0;
    this.nextIdleVoiceAt = 0;
    sim.setOrder(this.state, order);
  }

  /** Void the queued plan — death, floor change, restart, ceremony, ending. */
  private clearThenChain(): void {
    this.pendingPlan = [];
    this.lastOrderKind = null;
    this.ui.plan = [];
  }

  /** Run the next step of the plan. Keeps the queue alive across the call. */
  private advancePlan(): boolean {
    const next = this.pendingPlan.shift();
    if (!next) return false;
    this.apply({ ...next }, true);
    return true;
  }

  /** Short OSD labels for the queued steps ("2· FUSE", "3· LIFT"). */
  private planLabels(): string[] {
    return this.pendingPlan.map((s, i) => {
      const ent = s.target ? sim.entityById(this.state, s.target) : null;
      const what = ent
        ? ent.label.split(' ').pop()!.toUpperCase()
        : s.dir
          ? s.dir.toUpperCase()
          : s.intent.toUpperCase().replace('_', ' ');
      return `${i + 2}·${what}`;
    });
  }

  // ---------------------------------------------------------------- ceremonies

  private startCeremony(floor: number): void {
    const options = TRIADS[floor];
    if (!options) return;
    this.clearThenChain();
    this.ceremony = { options: [...options], floor };
    this.ceremonyNudged = false;
    sim.setOrder(this.state, null); // parked — frozen halts enemies, not orders
    this.state.frozen = true;
    this.ui.phase = 'ceremony';
    // On-feed CRT card mirrors what the robot reads aloud. Selection stays voice-only.
    this.ui.ceremonyOptions = options.map((id) => ({
      id,
      name: CHIPS[id].spoken.toUpperCase(),
      blurb: CHIPS[id].blurb,
    }));
    for (const chip of options) this.speech.sayBank(CHIPS[chip].crateLineId, 'beat', 350);
    this.speech.sayBank('crate_which', 'beat');
    logEvent('ceremony_start', { floor });
  }

  private rereadCeremony(withScold = true): void {
    if (!this.ceremony) return;
    if (withScold) this.speech.sayBank('crate_again', 'beat', 300);
    for (const chip of this.ceremony.options) this.speech.sayBank(CHIPS[chip].crateLineId, 'beat', 350);
    this.speech.sayBank('crate_which', 'beat');
  }

  /**
   * The install beat, for EVERY module: chip off the floor, triad pick, EARS,
   * BRAIN. Fullscreen icon + sparks, then the icon flies into the OSD strip and
   * the glyph pops in its place at exactly the frame it lands.
   *
   * Freezing is not decoration: the reveal owns the whole feed for two seconds,
   * and a machine that walked up while the player could not see the room is a
   * hit they had no way to avoid.
   */
  private showUpgrade(id: ModuleId): void {
    const info = MODULES[id];
    this.ui.upgrade = { id, name: info.name, blurb: info.blurb };
    this.audio.playSfx('powerup');
    this.render.fx.shake(2, 320);
    this.state.frozen = true;
    const epoch = this.runEpoch;
    const floor = this.state.floorIndex;
    // Landed: the glyph appears in the corner as the flying icon reaches it.
    setTimeout(() => {
      if (this.runEpoch !== epoch) return;
      if (!this.modules.includes(id)) this.modules.push(id);
      this.ui.glyphs = [...this.modules];
    }, UPGRADE_LAND_MS);
    setTimeout(() => {
      if (this.runEpoch !== epoch) return;
      this.ui.upgrade = null;
      // A floor change already unfroze the world — don't stomp on it.
      if (this.state.floorIndex === floor && !this.ceremony) this.state.frozen = false;
    }, UPGRADE_TOTAL_MS);
  }

  private resolveCeremony(chip: ChipId): void {
    if (!this.ceremony) return;
    if (this.ceremony.floor !== this.state.floorIndex + 1) return; // stale ceremony
    const floor = this.ceremony.floor;
    this.ceremony = null;
    this.ui.ceremonyOptions = null;
    sim.openCrate(this.state, 'crate_triad');
    sim.applyChip(this.state, chip);
    this.showUpgrade(chip);
    if (chip === 'MEMORY' && this.playerGivenName && this.playerGivenName !== 'ROBOT') {
      const n = this.playerGivenName;
      this.state.robot.name = n;
      this.speech.sayText(`${n}! ROBOT REMEMBERS! ROBOT IS ${n}!`, 'beat');
    } else {
      this.speech.sayBank(CHIPS[chip].installLineId, 'beat');
    }
    // Still frozen: showUpgrade owns the thaw, at the end of the reveal.
    this.ui.phase = 'play';
    sim.powerElevatorB(this.state); // triad done — the way up lights on
    logEvent('ceremony_pick', { floor, chip });
  }

  /**
   * A chip picked up off the floor. Still NOT a ceremony — no card to read, no
   * choice to make, you drove over a shiny thing and you are now different.
   * What it does get is the install reveal, same as any other module: the thing
   * you crossed a room for has to land somewhere the player can see it.
   */
  private onChipPickup(chip: ChipId): void {
    if (!chip || !(chip in CHIPS)) return;
    sim.applyChip(this.state, chip);
    this.showUpgrade(chip);
    this.lastDid = `ATE ${chip} CHIP.`;
    if (chip === 'MEMORY' && this.playerGivenName && this.playerGivenName !== 'ROBOT') {
      // The forgetting gag was told on arrival; this is its punchline.
      const n = this.playerGivenName;
      this.state.robot.name = n;
      this.speech.sayText(`${n}! ROBOT REMEMBERS! ROBOT IS ${n}!`, 'ack');
    } else {
      this.speech.sayBank(CHIPS[chip].installLineId, 'ack');
    }
    logEvent('chip_pickup', { chip, floor: this.state.floorIndex + 1 });
  }

  private earsCeremony(): void {
    this.clearThenChain();
    sim.applyEars(this.state); // sharper senses: it notices things further off
    sim.openCrate(this.state, 'crate_EARS');
    this.showUpgrade('EARS'); // owns the freeze, the sfx and the thaw
    this.speech.sayBank('new_ears', 'beat', 400);
    this.speech.sayBank('say_thing', 'beat');
    logEvent('ears_tier1');
  }

  private brainCeremony(): void {
    this.clearThenChain();
    sim.applyBrain(this.state);
    sim.openCrate(this.state, 'crate_BRAIN');
    this.showUpgrade('BRAIN');
    this.speech.sayBank('new_brain', 'beat', 500);
    this.speech.sayBank('brain_hint', 'beat');
    logEvent('brain_installed');
  }

  /**
   * THE ROCKET CRATE (floor 6). The one upgrade in the boss arena, and until
   * now the one that did nothing: `crate_reached` dispatched on id and had
   * cases for EARS, BRAIN and the triad, so the rocket crate — the second
   * weapon, the whole reason to cross a room under mortar fire — fell through
   * this switch in silence. The player walked to the shiny box and the shiny
   * box was scenery.
   *
   * The install beat is the same one every other module gets — showUpgrade owns
   * the freeze, the fullscreen icon, the flight into the OSD strip and the thaw
   * — so the second weapon lands with exactly the weight EARS and BRAIN do.
   *
   * It grants the launcher AND switches to it, which is not the pattern the
   * chips use and is deliberate. The other upgrades are installed somewhere
   * quiet and the player has all the time in the world to try them; this one is
   * collected mid-boss-fight, and a reward that requires you to know a phrase
   * you have never been taught before it does anything is a reward the player
   * files as broken. It fires, and THEN the robot teaches the phrase, so "use
   * the small gun" is an informed choice rather than the only exit from a
   * weapon you cannot switch off.
   */
  private rocketCeremony(): void {
    this.clearThenChain();
    // Direct, because sim/index.ts belongs to another stream this round; the
    // one-line home for this is `applyRockets(state)` beside applyEars/
    // applyBrain, and it should move there.
    this.state.robot.rockets = true;
    sim.applyDirectives(this.state, ['use_rockets']);
    sim.openCrate(this.state, 'crate_ROCKET');
    this.showUpgrade('ROCKET'); // owns the freeze, the sfx, the strip and the thaw
    // sayText, not sayBank: there is no `new_rocket` line in the voice bank
    // (shared/voiceLines.ts is another stream's file, and an unknown bank id
    // resolves to an EMPTY caption, which is worse than realtime TTS).
    this.speech.sayText('ROBOT HAS BIG PEW PEW NOW.', 'beat', 400);
    this.speech.sayText('SAY BIG PEW PEW. OR SMALL PEW PEW.', 'beat');
    this.lastDid = 'GOT BIG PEW PEW.';
    logEvent('rockets_installed');
  }

  // ---------------------------------------------------------------- sim events

  private processEvents(events: SimEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'wall_bump':
          this.audio.playSfx('bump', { volume: 0.8, rate: 0.95 + uiRng() * 0.1 });
          break;
        case 'scrap_pickup':
          this.audio.playSfx('scrap');
          this.speech.sayBank(pick(LINE_GROUPS.scrap), 'bark');
          this.lastDid = 'GOT SHINY.';
          break;
        case 'chip_pickup':
          this.onChipPickup(String(ev.data?.chip ?? '') as ChipId);
          break;
        case 'explore_found': {
          const e = ev.id ? sim.entityById(this.state, ev.id) : null;
          this.voice(
            'found',
            e ? `walked over to look at the ${e.label}` : 'wandered to an empty bit of floor',
            { bank: 'idle_guard', minGapMs: 6000 },
          );
          break;
        }
        case 'self_order': {
          // The robot decided something for itself — let it announce the plan
          // in its own words. This is the beat that sells "it is playing too".
          this.lastOrderKind = null; // the robot's plan replaced whatever we set
          const what = String(ev.data?.what ?? '');
          const label = String(ev.data?.label ?? 'something');
          const detail =
            what === 'fight'
              ? `decided to take on the ${label}`
              : what === 'retreat'
                ? `decided to back away from the ${label}`
                : what === 'gather'
                  ? `decided to go grab the ${label}`
                  : what === 'deliver'
                    ? `decided to carry the fuse to the ${label}`
                    : `decided to go look at the ${label}`;
          this.lastDid = detail.replace('decided to ', '').toUpperCase();
          this.voice('self_order', detail, { minGapMs: 7000 });
          break;
        }
        case 'need_orders':
          // Out of ideas. The ladder decides whether that is worth saying yet,
          // and whether it is still a question at all.
          this.idleVoice(performance.now());
          break;
        case 'path_failed': {
          const e = ev.id ? sim.entityById(this.state, ev.id) : null;
          this.voice('blocked', `cannot find any way to reach the ${e?.label ?? 'thing'}`, {
            bank: 'wall_move',
            minGapMs: 4000,
          });
          // A step it cannot do must not stall the whole brief — skip to the
          // next one. The operator hears WHY, and the plan keeps moving.
          this.advancePlan();
          break;
        }
        case 'threat_seen': {
          // The robot has seen something and is deliberately NOT charging it.
          // Reporting and holding is the point: whether this is a fight is the
          // operator's call, and making that call is the game. This is the 70%
          // of instruction that happens on first contact.
          //
          // The roll-call goes in `detail` — the MODEL's context — and never in
          // the spoken line. The robot reciting "THREE MACHINES. ONE IS BIG.
          // ONE IS SHOOTING." is a lecture; the operator needs one short line
          // and then a beat to look at the room themselves. Silence is content
          // (FIRST_MINUTES rule 3), which is what the quietFor below buys.
          const e = ev.id ? sim.entityById(this.state, ev.id) : null;
          const count = Number(ev.data?.count ?? 1);
          const worst = String(ev.data?.worst ?? e?.label ?? 'machine');
          const boss = Number(ev.data?.boss ?? 0) > 0;
          const roll =
            count > 1
              ? `${count} machines are awake, the worst of them a ${worst}`
              : `a ${worst} about ${ev.data?.dist ?? '?'} away`;
          this.voice(
            'enemy_spotted',
            `has stopped dead and is looking at ${roll}${boss ? ', and one of them is very much bigger than the rest' : ''}. ` +
              'It is holding still and waiting to be told how to play this — fight, keep back, dodge, hide, or go around. ' +
              'Do NOT list them and do NOT count them out loud: ONE short line about what it is looking at, then the question.',
            { priority: 'beat', bank: 'enemy_spot', minGapMs: 3000 },
          );
          // Then shut up. The operator is reading the room; a second unprompted
          // noise on top of the one that matters is how a beat becomes chatter.
          this.quietFor(6000);
          break;
        }
        // THE ARENA'S ONE IRREVERSIBLE BEAT. Everything before it is a still
        // room; everything after is the fight. It gets the roar, the shake and
        // the music, because a boss that stands up quietly has not started
        // anything — see BOSS_NOTICE_PX in sim/boss.ts.
        case 'boss_wake':
          this.audio.playSfx('boss_roar');
          this.render.fx.shake(5, 500);
          this.audio.setHum(0.18); // the room tone gets out of the way
          void this.audio.playMusic(BOSS_MUSIC_URL, { volume: 0.45, fadeMs: 1200 });
          this.speech.sayBank('enemy_spot', 'bark');
          logEvent('boss_wake');
          break;
        // Each threshold is an escalation the player has to HEAR — the roar
        // existed in the synth bank with no caller, so crossing a phase was
        // silent and the fight had no shape in the ears at all.
        case 'boss_phase': {
          const phase = Number(ev.data?.phase ?? 0);
          if (phase > 1) {
            this.audio.playSfx('boss_roar');
            this.render.fx.shake(4, 400);
          }
          break;
        }
        case 'shot_fired':
          this.audio.playSfx('shoot');
          break;
        case 'paper_thrown':
          this.audio.playSfx('paper');
          break;
        case 'enemy_hit':
          this.audio.playSfx('hit');
          break;
        case 'enemy_death': {
          const dead = ev.id ? sim.entityById(this.state, ev.id) : null;
          if (dead?.kind === 'fusedShredder') {
            // The kill is a SEQUENCE, not a pop: silence, then everything at
            // once. The 200ms of nothing is what makes the blast land — see
            // the beat sheet.
            this.audio.playSfx('boom_huge');
            this.render.fx.shake(9, 900);
            this.render.fx.staticBurst(160);
            window.setTimeout(() => this.render.fx.glitchFrame(), 140);
            // The exit is dark for the whole fight, which is what makes the
            // shredder the way out rather than an obstacle beside it. Killing
            // it powers the lift — without this the ending is unreachable and
            // the player is sealed in a room with a corpse.
            sim.powerElevatorB(this.state);
            // The bed goes out with the boss. Slower than the blast on
            // purpose: the room is allowed to keep ringing for a moment.
            this.audio.stopMusic(2200);
            this.audio.setHum(0.5);
          } else {
            this.audio.playSfx('enemy_die');
            // Nothing used to shake when anything died, which is most of why
            // combat read as weightless.
            this.blastShake(2, 160, dead?.pos ?? null);
          }
          if (ev.id === 'printer_nice') {
            this.speech.sayBank('wrong_target', 'bark');
            logEvent('wrong_target');
          } else {
            this.speech.sayBank('enemy_dead', 'bark');
          }
          break;
        }
        // Every AoE detonation. The frame kicks even when it lands across the
        // room — the camera is bolted to the ceiling of the room being shelled,
        // which is what makes the arena feel like one space and not a diorama.
        case 'mortar_impact': {
          const at = { x: Number(ev.data?.x ?? 0), y: Number(ev.data?.y ?? 0) };
          this.audio.playSfx('boom_big', {
            volume: blastGain(Math.hypot(this.state.robot.pos.x - at.x, this.state.robot.pos.y - at.y)),
          });
          this.blastShake(5, 300, at);
          if (Number(ev.data?.hit ?? 0) > 0) this.render.fx.glitchFrame();
          break;
        }
        case 'mortar_launch':
          this.audio.playSfx('mortar_launch', { volume: 0.7 });
          break;
        case 'enemy_spotted': {
          const e = ev.id ? sim.entityById(this.state, ev.id) : null;
          const rule = this.state.robot.standing.avoidEnemies
            ? ' and it has been told not to fight'
            : '';
          this.voice('enemy_spotted', `a ${e?.label ?? 'machine'} has noticed it${rule}`, {
            bank: 'enemy_spot',
            minGapMs: 4000,
          });
          break;
        }
        case 'robot_damage': {
          this.audio.playSfx(ev.data?.source === 'cable' ? 'zap' : 'hit');
          this.render.fx.glitchFrame();
          this.render.fx.shake(3, 250);
          const src = String(ev.data?.source ?? '');
          this.voice(
            'hurt',
            src === 'cable' ? 'drove over a sparking floor cable' : 'was hit by an angry machine',
            {
              bank: src === 'cable' ? 'floor_spicy' : pick(LINE_GROUPS.hurt),
              minGapMs: 5000,
            },
          );
          if (this.state.robot.hp <= 2 && this.lowHpSaidFloor !== this.state.floorIndex) {
            this.lowHpSaidFloor = this.state.floorIndex;
            this.speech.sayBank('low_hp', 'bark');
          }
          break;
        }
        case 'robot_death':
          this.onDeath(String(ev.data?.cause ?? 'enemy'));
          break;
        case 'crate_reached': {
          const floor = this.state.floorIndex + 1;
          if (ev.id === 'crate_EARS') this.earsCeremony();
          else if (ev.id === 'crate_BRAIN') this.brainCeremony();
          else if (ev.id === 'crate_ROCKET') this.rocketCeremony();
          else if (ev.id === 'crate_triad' && TRIADS[floor] && !this.ceremony) {
            this.startCeremony(floor);
          }
          break;
        }
        case 'fuse_pickup':
          this.speech.sayBank('fuse_grab', 'bark');
          this.lastDid = 'CARRIED FUSE.';
          break;
        case 'fuse_inserted':
          this.audio.playSfx('fuse_in');
          this.speech.sayBank('fuse_in', 'bark');
          break;
        case 'elevator_entered':
          this.onFloorComplete();
          break;
        case 'order_blocked': {
          const reason = String(ev.data?.reason ?? '');
          if (reason === 'carrying') this.speech.sayBank('cant_shoot', 'bark');
          else if (reason === 'no_power') {
            // ONE line either way. On a floor with a socket the blocker IS the
            // fuse and saying so is the honest report; on a floor gated some
            // other way, working out the route back is the operator's job and
            // the robot only reports the door.
            const hasSocket = this.state.entities.some((e) => e.kind === 'fuseSocket' && !e.dead);
            this.speech.sayBank(hasSocket ? 'elev_no_fuse' : 'elev_other_way', 'bark');
            // ...and it does not immediately start asking what to do about it.
            this.quietFor(12000);
          }
          else if (reason === 'rage') this.speech.sayBank('refuse', 'bark');
          else if (reason === 'rage_relent') this.speech.sayBank('rage_done', 'bark');
          else if (reason === 'tired') this.speech.sayBank('elev_tired', 'bark');
          else if (reason === 'wall') this.speech.sayBank('wall_move', 'bark');
          else if (reason === 'gone' || reason === 'cant_carry') this.speech.sayBank('refuse', 'bark');
          // Anything that ended the order for good moves the plan along; a
          // temporary refusal (RAGE) does not, because that order still runs.
          if (reason === 'gone' || reason === 'cant_carry' || reason === 'wall' || reason === 'cant_hurt') {
            this.advancePlan();
          }
          break;
        }
        case 'chip_flee':
          this.speech.sayBank('flee', 'bark');
          break;
        case 'order_done': {
          // Sim nulls robot.order before emitting — the director's own record
          // is the only witness to WHAT finished.
          const wasHide = this.lastOrderKind === 'hide';
          // selfDriven still describes the order that just ended (the sim nulls
          // `order`, not the flag), so it is the honest test for whose idea it was.
          const wasPlayerOrder = !this.state.robot.selfDriven && this.lastOrderKind !== null;
          this.lastOrderKind = null;
          if (wasHide) this.speech.sayBank('hide_done', 'bark');
          if (this.advancePlan()) break;
          // A finished job the PLAYER asked for is a conversational opening:
          // report, then ask. Self-chosen legs stay quiet — the robot narrating
          // every step of its own tour would be exhausting.
          if (wasPlayerOrder && !wasHide) {
            const e = ev.id ? sim.entityById(this.state, ev.id) : null;
            this.voice('arrived', e ? `finished the job at the ${e.label}` : 'finished the job', {
              priority: 'idle',
              minGapMs: 6000,
            });
          }
          break;
        }
        // An authored level trigger went off. The sim already did the half that
        // changes the world (doors, ambushes, power); what arrives here is the
        // half it refuses to do — the noise. Lines come from the level data
        // verbatim, so a designer writing them owns rule 7 themselves.
        case 'trigger_fired': {
          for (const a of ev.actions ?? []) {
            switch (a.type) {
              case 'say':
                this.speech.sayText(a.line, 'beat');
                break;
              case 'sfx':
                this.audio.playSfx(
                  a.sound,
                  a.at
                    ? {
                        volume: blastGain(
                          Math.hypot(
                            this.state.robot.pos.x - a.at.x,
                            this.state.robot.pos.y - a.at.y,
                          ),
                        ),
                      }
                    : undefined,
                );
                break;
              case 'hum':
                this.audio.setHum(a.level);
                break;
              case 'shake':
                this.render.fx.shake(3, a.ms);
                break;
              case 'light': {
                // Kill the tubes, slam the bay red. Presentation, like `say`:
                // the lightmap is not part of the world the sim reasons about.
                const state: { on?: boolean; intensity?: number } = {};
                if (a.on !== undefined) state.on = a.on;
                if (a.intensity !== undefined) state.intensity = a.intensity;
                this.render.setLight(a.target, state);
                break;
              }
              default:
                break; // world actions already ran in the sim
            }
          }
          break;
        }
        case 'chip_detour':
          break;
      }
    }
  }

  // ---------------------------------------------------------------- floors, death, ending

  /**
   * Blast shake, attenuated by distance from the robot — but never to zero.
   * The camera is bolted to the ceiling of the room being shelled, so a
   * detonation across the hall still bumps the frame. That floor is the whole
   * trick: it is what makes the arena read as ONE room rather than a diorama
   * the robot happens to be standing in.
   */
  /**
   * Send the robot on with whatever it was already doing, or — failing that —
   * toward the way out. Used when the player gives a ROUTING instruction to a
   * stationary robot ("go around the cables"): re-stating the goal is the only
   * way a new route can show itself.
   *
   * The exit is the fallback rather than a guess at intent: it is the one place
   * every floor is trying to get to, and it is what the OSD objective row has
   * been saying the whole time.
   */
  private resumeObjective(): void {
    const b = sim.entityById(this.state, 'elevB');
    if (b && !b.dead) this.setOrder({ kind: 'goto', targetId: b.id });
  }

  private blastShake(px: number, ms: number, at: { x: number; y: number } | null): void {
    if (!at) {
      this.render.fx.shake(px, ms);
      return;
    }
    const d = Math.hypot(this.state.robot.pos.x - at.x, this.state.robot.pos.y - at.y);
    this.render.fx.shake(px * blastGain(d), ms);
  }

  private setOsd(): void {
    const n = this.state.floorIndex + 1;
    this.ui.osd = `CAM 0${n} · FLOOR 0${n} · REC ●`;
  }

  private onFloorComplete(): void {
    const done = this.state.floorIndex + 1;
    logEvent('floor_complete', { floor: done });
    this.audio.playSfx('doors');
    // Floor 6 is now the last one, and the run ends on the shredder rather than
    // on a lift door. The boss IS the cliffhanger's setup: the robot has just
    // done something genuinely hard, which is what makes its closing question
    // land instead of reading as another gag.
    if (done >= FLOORS_IN_RUN) {
      this.cliffhanger();
      return;
    }
    // A ceremony abandoned at the doors dies with its floor. So does a chain,
    // and so does any question that was hanging in the air.
    this.clearThenChain();
    this.clearQuestion();
    this.ceremony = null;
    this.ui.ceremonyOptions = null;
    this.ui.upgrade = null;
    this.state.frozen = false;
    this.ui.phase = 'play';
    this.speech.clear();
    stopAllEmitters(); // the room those sounds belonged to is behind the doors
    this.audio.playSfx('elevator_ding');
    this.render.fx.staticBurst(450);
    this.audio.playSfx('static_burst');
    sim.loadFloor(this.state, this.state.floorIndex + 1);
    sim.setOrder(this.state, null); // orders don't survive the elevator ride
    this.setOsd();
    const floor = this.state.floorIndex + 1;
    // Pull the bed down as the doors open, not when the boss stands up: it is
    // over a megabyte, and a fetch that starts on the roar is music that
    // arrives after the moment it exists to score.
    if (floor === FLOORS_IN_RUN) void this.audio.prefetchMusic(BOSS_MUSIC_URL);
    setTimeout(() => {
      if (this.state.floorIndex + 1 !== floor || !this.simRunning()) return;
      if (floor === 2) {
        this.speech.sayBank('elev_tired', 'beat', 600);
        if (this.playerGivenName && this.playerGivenName !== 'ROBOT' && !this.state.robot.hasMemory) {
          this.speech.sayText(`WHO IS ${this.playerGivenName}? … OH. IS ROBOT.`, 'beat');
        }
      }
      // Reads the new room out loud and offers a first move, so every floor
      // opens on a conversation instead of on the player guessing.
      const rules = standingLabels(this.state.robot.standing);
      this.voice(
        'floor_start',
        `stepped out of the lift onto floor ${floor}${rules.length ? `, still under the rules: ${rules.join(', ')}` : ''}`,
        { priority: 'beat', minGapMs: 0 },
      );
    }, 900);
  }

  private onDeath(cause: string): void {
    this.runEpoch++;
    this.clearThenChain();
    this.clearQuestion();
    this.ui.upgrade = null; // a reveal does not outlive the robot holding it
    this.speech.clear();
    this.audio.playSfx('powerdown');
    stopAllEmitters();
    // Dying in the arena takes the bed with it — the death card plays over a
    // dead feed, and a boss loop still going under it would say the fight is
    // somehow continuing without the robot.
    this.audio.stopMusic(600);
    this.render.fx.glitchFrame();
    this.ui.degrade = 1;
    const lastWords = pick(LINE_GROUPS.deathWords);
    this.ui.deathCard = {
      robotName: this.state.robot.name ?? this.playerGivenName ?? 'ROBOT',
      floor: this.state.floorIndex + 1,
      heard: this.lastHeard,
      did: DID_BY_CAUSE[cause] ?? this.lastDid,
      lastWords: '',
      scrap: this.state.robot.scrap,
    };
    logEvent('death', { floor: this.state.floorIndex + 1, cause });
    setTimeout(() => {
      this.speech.sayBank(lastWords, 'beat');
      if (this.ui.deathCard) {
        this.ui.deathCard = { ...this.ui.deathCard, lastWords: this.lineText(lastWords) };
      }
      this.ui.phase = 'death';
    }, 900);
  }

  private lineText(bankId: string): string {
    return BANK_BY_ID[bankId]?.text.toUpperCase() ?? '';
  }

  private restart(): void {
    if (this.ui.phase === 'boot') return;
    this.runEpoch++;
    this.clearThenChain();
    this.clearQuestion();
    this.speech.clear();
    this.audio.stopMusic(0); // a new run starts in a quiet building
    stopAllEmitters();
    this.render.fx.deadCam(false);
    this.state = sim.initialState((Date.now() % 2147483647) | 0);
    // The pile beat is a one-time opening, not a death penalty: a restart is
    // back in control immediately (FIRST_MINUTES: <2s to control).
    sim.wakeRobot(this.state);
    this.ceremony = null;
    this.ui.ceremonyOptions = null;
    this.awaitingName = false;
    this.awaitingFirstOrder = true;
    this.armWaitLadder();
    this.firstBumpDone = false;
    this.saidWalkClaim = false;
    this.lowHpSaidFloor = -1;
    this.lastDid = 'CAME BACK.';
    this.ui.deathCard = null;
    this.modules = [];
    this.ui.glyphs = [];
    this.ui.upgrade = null;
    this.ui.orders = standingLabels(this.state.robot.standing);
    this.ui.objective = '';
    this.ui.plan = [];
    this.ui.hp = this.state.robot.hp;
    this.ui.maxHp = this.state.robot.maxHp;
    this.ui.hpFlash = 0;
    this.ui.degrade = 0;
    this.ui.phase = 'play';
    this.setOsd();
    this.render.fx.staticBurst(350);
    this.audio.playSfx('static_burst');
    this.speech.sayBank('back_again', 'beat');
    logEvent('restart');
  }

  private cliffhanger(): void {
    if (this.ended) return;
    this.ended = true;
    this.runEpoch++;
    this.clearThenChain();
    this.speech.clear();
    this.ui.phase = 'cliffhanger';
    this.ui.upgrade = null;
    // Derived, not hard-coded: this used to read CAM 06 back when the run ended
    // on floor 5, and quietly became off-by-one the moment the shredder floor
    // joined the story.
    const next = this.state.floorIndex + 2;
    this.ui.osd = `CAM 0${next} · FLOOR 0${next} · NO SIGNAL`;
    this.render.fx.deadCam(true);
    stopAllEmitters(); // the feed is dead; the room it was watching goes with it
    this.audio.playSfx('static_burst');
    this.audio.setHum(0.25);
    logEvent('cliffhanger_reached');
    // THE ENDING. It has just killed the thing that was shelling it, and the
    // first thing it does is ask whether that was good. Then nothing answers —
    // and the silence after the question is the whole cliffhanger. Everything
    // below is spaced to let that gap sit rather than to fill it.
    setTimeout(() => this.speech.sayBank('cliff_win', 'beat', 1400), 1200);
    setTimeout(() => this.speech.sayBank('cliff_voice1', 'beat', 1100), 5200);
    setTimeout(() => this.speech.sayBank('cliff_voice2', 'beat', 1100), 7900);
    setTimeout(() => this.speech.sayBank('cliff_voice3', 'beat'), 10500);
    setTimeout(() => {
      this.ui.phase = 'title';
      this.audio.playSfx('title');
      this.ended = false;
      logEvent('title_card');
    }, 14200);
  }

  // ---------------------------------------------------------------- per-frame presentation

  private updatePresentation(now: number, dtMs: number): void {
    this.ui.caption = this.speech.caption;
    this.ui.headToCameraMs = Math.max(0, this.ui.headToCameraMs - dtMs);
    this.ui.teletype = this.teletype.value;
    this.ui.teletypeActive = this.teletype.active || this.teletype.value.length > 0;

    // Live input level — real RMS from the meter, so the VU and the help card's
    // bar are evidence, not decoration.
    this.ui.micLevel = this.speechSource?.level ?? 0;
    if (this.ui.micHelp && now > this.micHelpUntil) this.dismissMicHelp();

    const r = this.state.robot;
    this.ui.moodGlyph = r.sulkTicks > 0 ? 'SULK' : r.mood === 'fleeing' ? 'FLEE' : '';
    // The standing rules and the current job, on the feed. Without this the
    // player has no evidence the robot kept what they told it, which is the
    // whole point of it having a memory in the first place.
    this.ui.orders = standingLabels(r.standing);
    const busy = sim.describeOrder(this.state);
    this.ui.objective = busy
      ? `${r.selfDriven ? '·' : '»'} ${busy.toUpperCase()}`
      : r.awaitingBriefing
        ? '» AWAITING ORDERS'
        : '';
    this.ui.plan = this.planLabels();
    this.ui.awaitingBriefing = r.awaitingBriefing;
    if (this.pendingQuestion && now > this.questionUntil) this.clearQuestion();

    // Hull readout. hpFlash punches on every point lost so damage is felt on
    // the OSD, not just in the caption.
    if (r.hp < this.ui.hp) this.ui.hpFlash = 1;
    this.ui.hpFlash = Math.max(0, this.ui.hpFlash - dtMs / 330);
    this.ui.hp = r.hp;
    this.ui.maxHp = r.maxHp;

    // ---- pre-wake: the heap is alive, and it is the only thing on screen ----
    if (r.dormant) {
      this.ui.pileStir = Math.max(0, this.ui.pileStir - dtMs / 550);
      if (this.ui.phase === 'play' && now - this.lastStirAt > STIR_EVERY_MS) {
        // Something in there twitches on a slow clock. No voice, no captions —
        // the player has to decide, on their own, to talk to a pile of junk.
        this.stir();
        this.lastStirAt = now + (uiRng() * 1800 - 400);
      }
      return;
    }
    this.ui.pileStir = Math.max(0, this.ui.pileStir - dtMs / 400);

    if (this.simRunning() && r.alive) {
      const hostile = sim.nearestHostile(this.state);
      this.ui.danger = hostile ? Math.max(0, Math.min(1, 1 - (hostile.dist - 40) / 120)) : 0;
      this.ui.degrade = (1 - r.hp / r.maxHp) * 0.7;

      // Cable ambience — crackle when the spicy floor is near, louder when nearer.
      if (this.ui.phase === 'play' && now - this.lastSparkAt > 2500) {
        let nearest = Infinity;
        for (const e of this.state.entities) {
          if (e.kind !== 'cable' || e.dead) continue;
          nearest = Math.min(nearest, Math.hypot(e.pos.x - r.pos.x, e.pos.y - r.pos.y));
        }
        if (nearest < 90) {
          this.lastSparkAt = now;
          this.audio.playSfx('spark_loop', { volume: 0.15 + 0.55 * (1 - nearest / 90) });
        }
      }

      // Wall-bump comedy choreography (first time scripted, then random barks).
      if (r.wallBumpTicks > 70 && !this.saidWalkClaim && !this.firstBumpDone) {
        this.saidWalkClaim = true;
        this.speech.sayBank('walk_claim', 'bark', 900);
      }
      if (r.wallBumpTicks > 190 && !this.firstBumpDone) {
        this.firstBumpDone = true;
        this.speech.sayBank('wall_rude', 'beat');
      }
      if (this.firstBumpDone && r.wallBumpTicks > 60 && now - this.lastBumpBarkAt > 7000) {
        this.lastBumpBarkAt = now;
        this.speech.sayBank(pick(LINE_GROUPS.wallBump), 'bark');
      }

      // Idle beats — silence is content; dead air is the only bug.
      if (!this.speech.busy && this.ui.danger === 0 && !this.ui.pttHeld && this.woken && !this.awaitingName) {
        if (this.awaitingFirstOrder && this.idleLadderStep < WAIT_LADDER.length) {
          // Beat-1 wait: deterministic ladder first, random idles after.
          const step = WAIT_LADDER[this.idleLadderStep]!;
          if (now - this.ladderStart > step.at) {
            this.idleLadderStep++;
            this.lastIdleAt = now;
            if (step.line === 'idle_spin') this.audio.playSfx('spin');
            this.speech.sayBank(step.line, 'idle');
          }
        } else {
          const silence = now - this.lastIdleAt;
          const threshold = this.awaitingFirstOrder ? 25000 : 40000;
          if (silence > threshold) {
            this.lastIdleAt = now;
            // Same ladder as running out of jobs, and the same randomised
            // clock: there is only ever ONE reason the robot is making noise
            // into a silent room, and it should escalate and thin out the same
            // way whichever end it came from.
            this.idleVoice(now);
          }
        }
      }
    } else if (!this.simRunning()) {
      this.ui.danger = 0;
    }
  }
}
