/**
 * The director: owns the loop, the phase machine, the beats (FIRST_MINUTES),
 * input routing, parse pipeline, and all wiring between subsystems.
 * This is deliberately the ONLY place where subsystems meet.
 */

import type {
  ChipId,
  CommandSource,
  GamePhase,
  Order,
  ParseRequest,
  ParsedCommand,
  RenderApp,
  SimEvent,
  SimState,
  UiState,
  Utterance,
} from '@shared/types';
import { TICK_MS } from '@shared/types';
import { CHIPS, TRIADS } from '@shared/content';
import { BANK_BY_ID, LINE_GROUPS } from '@shared/voiceLines';
import { makeRng } from '@shared/rng';

import * as sim from '../sim/index';
import { initArt } from '../art/index';
import { createRenderApp } from '../render/index';
import { createAudioEngine } from '../audio/engine';
import { WebSpeechSource } from '../voice/webspeech';
import { TeletypeSource } from '../voice/teletype';
import { parseLocal } from '../voice/localParser';
import { apiParse, logEvent } from '../net/api';
import { SpeechQueue } from './speech';

const uiRng = makeRng(0xc0ffee); // presentation-only randomness

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(uiRng() * arr.length)]!;
}

const DID_BY_CAUSE: Record<string, string> = {
  cable: 'DROVE INTO SPICY FLOOR.',
  paper: 'CAUGHT PAPER. WITH FACE.',
  enemy: 'HUGGED ANGRY MACHINE.',
};

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

    deathCard: null,
    headToCameraMs: 0,
    moodGlyph: '',
    danger: 0,
    degrade: 0,
  };

  private render!: RenderApp;
  private audio = createAudioEngine();
  private speech!: SpeechQueue;
  private speechSource: CommandSource | null = null;
  private teletype = new TeletypeSource();

  // beat state
  private woken = false;
  private awaitingName = false;
  private awaitingFirstOrder = false; // between "WHAT X DO?" and the first command
  private playerGivenName: string | null = null;
  private ceremony: { options: ChipId[]; floor: number } | null = null;
  private firstBumpDone = false;
  private saidWalkClaim = false;
  private lastBumpBarkAt = 0;
  private lastIdleAt = 0;
  private lastUtteranceAt = 0;
  private lastHeard = '…';
  private lastDid = 'WOKE UP.';
  private lowHpSaidFloor = -1;
  private parsing = false;
  private booting = false;
  private ended = false;

  constructor(private host: HTMLElement) {}

  async init(): Promise<void> {
    if (import.meta.env.DEV) (globalThis as { __dir?: unknown }).__dir = this;
    const art = await initArt();
    this.render = createRenderApp(art);
    await this.render.init(this.host);
    this.state = sim.initialState((Date.now() % 2147483647) | 0);
    this.speech = new SpeechQueue(this.audio as never, () => {
      this.lastIdleAt = performance.now();
    });

    const speech = new WebSpeechSource();
    if (speech.available) this.speechSource = speech;

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

    // DEV shortcut: ?floor=N[&name=X][&tier=1] boots straight into a floor.
    if (import.meta.env.DEV) {
      const q = new URLSearchParams(location.search);
      const f = parseInt(q.get('floor') ?? '', 10);
      if (f >= 1 && f <= 5) {
        this.woken = true;
        this.awaitingFirstOrder = false;
        this.playerGivenName = (q.get('name') ?? 'SPARKY').toUpperCase();
        this.state.robot.name = this.playerGivenName;
        if (q.get('tier') === '1' || f >= 4) this.state.robot.tier = 1;
        sim.loadFloor(this.state, f - 1);
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
      if (this.simRunning()) {
        acc += dt;
        let steps = 0;
        while (acc >= TICK_MS && steps < 5) {
          sim.step(this.state);
          this.processEvents(this.state.events);
          acc -= TICK_MS;
          steps++;
        }
      } else {
        acc = 0;
      }
      this.updatePresentation(now, dt);
      this.render.render({ sim: this.state, ui: this.ui, alpha: acc / TICK_MS });
    };
    rafChain();
  }

  private simRunning(): boolean {
    return this.ui.phase === 'play' || this.ui.phase === 'ceremony';
  }

  // ---------------------------------------------------------------- input

  private onKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return;
    const phase = this.ui.phase;

    if (phase === 'off') {
      if (e.code === 'Space') void this.boot();
      return;
    }
    if (phase === 'boot') return;
    if (phase === 'death') {
      this.restart();
      return;
    }
    if (phase === 'title') {
      this.restart();
      return;
    }
    if (phase === 'cliffhanger') return;

    // Teletype auto-activates on any printable char (space stays PTT until
    // there's a buffer); Escape closes it. The typed path must ALWAYS work.
    if (e.key === 'Escape') {
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

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space' && this.ui.pttHeld) {
      e.preventDefault();
      void this.endPtt();
    }
  }

  private startPtt(): void {
    if (this.ui.pttHeld || this.parsing) return;
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
      // No mic path: PTT release just prompts the teletype.
      this.ui.micState = 'idle';
      if (this.woken) this.speech.sayBank('teletype', 'bark');
      this.teletype.setActive(true);
      this.ui.teletypeActive = true;
      return;
    }
    this.ui.micState = 'thinking';
    const u = await this.speechSource.stop();
    if (!u || !u.text.trim()) {
      this.ui.micState = 'idle';
      if (this.woken && !this.speech.busy) this.speech.sayBank('mumbly', 'bark');
      return;
    }
    await this.handleUtterance(u);
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
    setTimeout(() => {
      this.ui.phase = 'play';
      this.setOsd();
      this.audio.setHum(0.5);
      this.lastIdleAt = performance.now();
    }, 1400);
  }

  private wake(): void {
    this.woken = true;
    this.ui.headToCameraMs = 2000;
    this.audio.playSfx('servo');
    this.speech.sayBank('wake_hello', 'beat', 500);
    this.speech.sayBank('wake_sleep', 'beat', 400);
    this.speech.sayBank('wake_name_ask', 'beat');
    this.awaitingName = true;
    this.lastIdleAt = performance.now() + 4000; // silence timer starts after the ask
    logEvent('wake');
    // Silent refusal → self-name after 9s of nothing.
    setTimeout(() => {
      if (this.awaitingName && performance.now() - this.lastUtteranceAt > 8000) {
        this.selfName();
      }
    }, 9000);
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
    this.speech.sayText(`ROBOT IS ${name}. ${name} IS GOOD AT THINGS.`, 'beat', 500);
    this.speech.sayText(`WHAT ${name} DO?`, 'beat');
    logEvent('named', { name });
  }

  private selfName(): void {
    if (!this.awaitingName) return;
    this.awaitingName = false;
    this.awaitingFirstOrder = true;
    this.playerGivenName = 'ROBOT';
    this.state.robot.name = 'ROBOT';
    this.speech.sayBank('wake_self_name', 'beat', 500);
    this.speech.sayBank('what_do', 'beat');
    logEvent('named', { name: 'ROBOT', self: 1 });
  }

  // ---------------------------------------------------------------- utterances → commands

  private async handleUtterance(u: Utterance): Promise<void> {
    this.lastUtteranceAt = performance.now();
    this.lastIdleAt = performance.now();
    this.ui.headToCameraMs = 900;
    logEvent('utterance', { source: u.source, shouted: u.shouted ? 1 : 0 });

    if (!this.woken) {
      this.ui.micState = 'idle';
      this.wake();
      return;
    }

    this.parsing = true;
    this.ui.micState = 'thinking';
    const cmd = await this.parse(u);
    this.parsing = false;
    this.ui.micState = 'idle';
    this.apply(cmd);
  }

  private async parse(u: Utterance): Promise<ParsedCommand> {
    const req: ParseRequest = {
      utterance: u.text,
      tier: this.state.robot.tier,
      floor: this.state.floorIndex + 1,
      robotName: this.state.robot.name,
      personality: this.state.robot.chips,
      options: this.ceremony ? this.ceremony.options : null,
      awaitingName: this.awaitingName,
      entities: sim.visibleEntities(this.state),
      recent: [this.lastHeard],
      shouted: u.shouted,
    };
    try {
      return await apiParse(req);
    } catch {
      return parseLocal(u.text, {
        tier: req.tier,
        options: req.options,
        awaitingName: req.awaitingName,
        entities: req.entities,
      });
    }
  }

  private apply(cmd: ParsedCommand): void {
    logEvent('command', {
      intent: cmd.intent,
      source: cmd.source ?? 'llm',
      tier: this.state.robot.tier,
      floor: this.state.floorIndex + 1,
      refused: 0,
    });

    if (this.awaitingName) {
      if (cmd.intent === 'name_robot' && cmd.name) this.applyName(cmd.name);
      else this.selfName();
      return;
    }

    this.lastHeard = cmd.ack_line.toUpperCase();
    if (cmd.insult) {
      sim.sulk(this.state, 180);
      this.audio.blip('warn');
      this.speech.sayBank('sulk', 'ack');
      return;
    }

    // The repeat-back — never the transcript.
    this.speech.sayText(cmd.ack_line, 'ack');

    switch (cmd.intent) {
      case 'move':
        if (cmd.dir) {
          this.setOrder({ kind: 'move', dir: cmd.dir });
          this.lastDid = `WENT ${cmd.dir.toUpperCase()}.`;
          this.saidWalkClaim = false;
        }
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
        const target = targetId ? sim.entityById(this.state, targetId) : undefined;
        if (!target || target.dead) break; // ack already voiced the confusion
        const kind =
          cmd.intent === 'goto'
            ? 'goto'
            : cmd.intent === 'attack'
              ? 'attack'
              : cmd.intent === 'pickup'
                ? 'pickup'
                : 'enter';
        this.setOrder({ kind, targetId: target.id } as Order);
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
      case 'clarify':
        if (this.ceremony) this.rereadCeremony(false);
        break;
      case 'chatter':
        break;
    }
    if (this.awaitingFirstOrder && ['move', 'stop', 'shoot', 'goto', 'attack'].includes(cmd.intent)) {
      this.awaitingFirstOrder = false;
    }
  }

  private setOrder(order: Order): void {
    sim.setOrder(this.state, order);
  }

  // ---------------------------------------------------------------- ceremonies

  private startCeremony(floor: number): void {
    const options = TRIADS[floor];
    if (!options) return;
    this.ceremony = { options: [...options], floor };
    this.state.frozen = true;
    this.ui.phase = 'ceremony';
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

  private resolveCeremony(chip: ChipId): void {
    if (!this.ceremony) return;
    const floor = this.ceremony.floor;
    this.ceremony = null;
    sim.openCrate(this.state, `crate_${chip}`);
    sim.applyChip(this.state, chip);
    this.ui.glyphs = [...this.state.robot.chips];
    this.audio.playSfx('powerup');
    if (chip === 'MEMORY' && this.playerGivenName && this.playerGivenName !== 'ROBOT') {
      const n = this.playerGivenName;
      this.state.robot.name = n;
      this.speech.sayText(`${n}! ROBOT REMEMBERS! ROBOT IS ${n}!`, 'beat');
    } else {
      this.speech.sayBank(CHIPS[chip].installLineId, 'beat');
    }
    this.state.frozen = false;
    this.ui.phase = 'play';
    logEvent('ceremony_pick', { floor, chip });
  }

  private earsCeremony(): void {
    this.state.frozen = true;
    this.audio.playSfx('powerup');
    this.state.robot.tier = 1;
    this.speech.sayBank('new_ears', 'beat', 400);
    this.speech.sayBank('say_thing', 'beat');
    sim.openCrate(this.state, 'crate_EARS');
    setTimeout(() => {
      this.state.frozen = false;
    }, 2500);
    logEvent('ears_tier1');
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
        case 'shot_fired':
          this.audio.playSfx('shoot');
          break;
        case 'paper_thrown':
          this.audio.playSfx('paper');
          break;
        case 'enemy_hit':
          this.audio.playSfx('hit');
          break;
        case 'enemy_death':
          this.audio.playSfx('enemy_die');
          if (ev.id === 'printer_nice') {
            this.speech.sayBank('wrong_target', 'bark');
            logEvent('wrong_target');
          } else {
            this.speech.sayBank('enemy_dead', 'bark');
          }
          break;
        case 'enemy_spotted':
          this.speech.sayBank('enemy_spot', 'bark');
          break;
        case 'robot_damage': {
          this.audio.playSfx(ev.data?.source === 'cable' ? 'zap' : 'hit');
          this.render.fx.glitchFrame();
          this.render.fx.shake(3, 250);
          const src = String(ev.data?.source ?? '');
          if (src === 'cable') {
            this.speech.sayBank(this.state.floorIndex === 1 ? 'floor_spicy' : 'floor_bit', 'bark');
          } else {
            this.speech.sayBank(pick(LINE_GROUPS.hurt), 'bark');
          }
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
          else if (TRIADS[floor] && !this.ceremony) this.startCeremony(floor);
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
          else if (reason === 'no_power') this.speech.sayBank('fuse_need', 'bark');
          else if (reason === 'rage') this.speech.sayBank('refuse', 'bark');
          break;
        }
        case 'chip_flee':
          this.speech.sayBank('flee', 'bark');
          break;
        case 'order_done':
        case 'chip_detour':
          break;
      }
    }
  }

  // ---------------------------------------------------------------- floors, death, ending

  private setOsd(): void {
    const n = this.state.floorIndex + 1;
    this.ui.osd = `CAM 0${n} · FLOOR 0${n} · REC ●`;
  }

  private onFloorComplete(): void {
    const done = this.state.floorIndex + 1;
    logEvent('floor_complete', { floor: done });
    this.audio.playSfx('doors');
    if (done >= 5) {
      this.cliffhanger();
      return;
    }
    this.speech.clear();
    this.audio.playSfx('elevator_ding');
    this.render.fx.staticBurst(450);
    this.audio.playSfx('static_burst');
    sim.loadFloor(this.state, this.state.floorIndex + 1);
    sim.setOrder(this.state, null); // orders don't survive the elevator ride
    this.setOsd();
    const floor = this.state.floorIndex + 1;
    setTimeout(() => {
      if (floor === 2) {
        this.speech.sayBank('elev_tired', 'beat', 600);
        if (this.playerGivenName && this.playerGivenName !== 'ROBOT' && !this.state.robot.hasMemory) {
          this.speech.sayText(`WHO IS ${this.playerGivenName}? … OH. IS ROBOT.`, 'beat');
        }
      }
    }, 900);
  }

  private onDeath(cause: string): void {
    this.speech.clear();
    this.audio.playSfx('powerdown');
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
    this.speech.clear();
    this.render.fx.deadCam(false);
    this.state = sim.initialState((Date.now() % 2147483647) | 0);
    this.ceremony = null;
    this.awaitingName = false;
    this.awaitingFirstOrder = true;
    this.firstBumpDone = false;
    this.saidWalkClaim = false;
    this.lowHpSaidFloor = -1;
    this.lastDid = 'CAME BACK.';
    this.ui.deathCard = null;
    this.ui.glyphs = [];
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
    this.speech.clear();
    this.ui.phase = 'cliffhanger';
    this.ui.osd = 'CAM 06 · FLOOR 06 · NO SIGNAL';
    this.render.fx.deadCam(true);
    this.audio.playSfx('static_burst');
    this.audio.setHum(0.25);
    logEvent('cliffhanger_reached');
    setTimeout(() => this.speech.sayBank('cliff_voice1', 'beat', 1100), 1500);
    setTimeout(() => this.speech.sayBank('cliff_voice2', 'beat', 1100), 4200);
    setTimeout(() => this.speech.sayBank('cliff_voice3', 'beat'), 6800);
    setTimeout(() => {
      this.ui.phase = 'title';
      this.audio.playSfx('title');
      this.ended = false;
      logEvent('title_card');
    }, 10500);
  }

  // ---------------------------------------------------------------- per-frame presentation

  private updatePresentation(now: number, dtMs: number): void {
    this.ui.caption = this.speech.caption;
    this.ui.headToCameraMs = Math.max(0, this.ui.headToCameraMs - dtMs);
    this.ui.teletype = this.teletype.value;
    this.ui.teletypeActive = this.teletype.active || this.teletype.value.length > 0;

    const r = this.state.robot;
    this.ui.moodGlyph = r.sulkTicks > 0 ? 'SULK' : r.mood === 'fleeing' ? 'FLEE' : '';

    if (this.simRunning() && r.alive) {
      const hostile = sim.nearestHostile(this.state);
      this.ui.danger = hostile ? Math.max(0, Math.min(1, 1 - (hostile.dist - 40) / 120)) : 0;
      this.ui.degrade = (1 - r.hp / r.maxHp) * 0.7;

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
        const silence = now - this.lastIdleAt;
        const threshold = this.awaitingFirstOrder ? 6000 : 16000;
        if (silence > threshold) {
          this.lastIdleAt = now;
          const line = pick(LINE_GROUPS.idle);
          if (line === 'idle_spin') this.audio.playSfx('spin');
          this.speech.sayBank(line, 'idle');
        }
      }
    } else if (!this.simRunning()) {
      this.ui.danger = 0;
    }
  }
}
