/**
 * PLAYTEST — press P and the draft becomes the game.
 *
 * Not a simulation of the game: the real `initialState`/`loadFloor`/`step`, the
 * real `WorldView`, the real emitters. The draft reaches the sim the only way a
 * level ever does — `levelToFloorDef` — parked in a scratch slot at the end of
 * `FLOORS` so `loadFloor` can be called with an index, exactly like a floor
 * that had been saved. Nothing here is a special code path the shipped game
 * does not also run.
 *
 * It NEVER speaks. Rule 8's chain belongs to the director; a level editor that
 * called TTS would burn credits on every keypress. Ambience only, and even that
 * is fail-soft to silence.
 *
 * PRESENTATION ACTIONS. A trigger's `say`/`sfx`/`hum`/`shake`/`light` half
 * never runs in the sim — it rides out on the `trigger_fired` event for the
 * director to interpret, and there is no director here. This class consumes the
 * two that a level designer is actually testing:
 *
 *   light  → `setLightState` on the lit preview. The alarm beat is a LIGHTING
 *            beat; watching it happen is the entire reason to press P.
 *   say    → the caption line, so the words can be read in place.
 *
 * `sfx`, `hum` and `shake` stay dropped. They belong to the audio mixer and the
 * camera rig, both of which are the game's; faking them here would be a second
 * implementation of a beat the designer cannot tune anyway.
 */

import type { LevelData, RenderView, SimEvent, SimState, UiState } from '@shared/types';
import { TICK_MS } from '@shared/types';
import { FLOORS } from '../sim/floors';
import { levelToFloorDef } from '../sim/levelLoader';
import { clearBriefing, initialState, loadFloor, setOrder, step, wakeRobot } from '../sim/index';
import { createAudioEngine } from '../audio/engine';
import { stopAllEmitters, updateEmitters } from '../audio/emitters';
import type { AudioEngine } from '@shared/types';

/** A UiState with nothing happening. The designer has no director to fill it. */
export function blankUi(): UiState {
  return {
    phase: 'play',
    osd: '',
    glyphs: [],
    caption: '',
    pttHeld: false,
    micState: 'idle',
    teletype: '',
    teletypeActive: false,
    stickyNote: false,
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
    hp: 10,
    maxHp: 10,
    hpFlash: 0,
    awaitingBriefing: false,
    danger: 0,
    degrade: 0,
  };
}

/** The walkability grid back as the ASCII map the renderer builds tiles from. */
export function mapFromSolid(solid: readonly boolean[][]): string[] {
  return solid.map((row) => row.map((s) => (s ? '#' : '.')).join(''));
}

/** Where the draft is parked in FLOORS while a playtest runs. -1 until first use. */
let scratchIndex = -1;

const GOTO_ID = '__designer_goto';

export interface PlaytestOpts {
  status: (msg: string) => void;
  /** A `light` action fired. No-op on a level with no lit data. */
  litLightState: (id: string, state: { on?: boolean; intensity?: number }) => void;
  /** A `setTiles` action opened a door — the lit tiles and occluders are stale. */
  litTilesChanged: (map: readonly string[]) => void;
}

export class Playtest {
  active = false;
  state: SimState | null = null;
  private ui = blankUi();
  private acc = 0;
  private audio: AudioEngine | null = null;
  private level: LevelData | null = null;
  private events: SimEvent[] = [];
  /** How long the `say` line stays up. There is no director to retire it. */
  private captionMs = 0;

  constructor(private o: PlaytestOpts) {}

  start(level: LevelData): boolean {
    const def = levelToFloorDef(level);
    // One scratch slot, reused: pushing per playtest would grow FLOORS all
    // session and quietly change what `?floor=N` means on the next reload.
    if (scratchIndex < 0) {
      scratchIndex = FLOORS.length;
      FLOORS.push(def);
    } else {
      FLOORS[scratchIndex] = def;
    }
    let state: SimState;
    try {
      state = initialState(1234);
      loadFloor(state, scratchIndex);
    } catch (err) {
      this.o.status(`playtest failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    // Awake and briefed: the designer is testing the ROOM, and a robot asleep
    // in a pile that only floor 1 has is a five-second detour every single time.
    wakeRobot(state);
    clearBriefing(state);
    this.state = state;
    this.level = level;
    this.ui = blankUi();
    this.ui.hp = state.robot.hp;
    this.ui.maxHp = state.robot.maxHp;
    this.acc = 0;
    this.active = true;
    this.events = [];
    void this.ensureAudio();
    this.o.status('PLAYTEST — click to send the robot, Esc returns to editing');
    return true;
  }

  stop(): void {
    this.active = false;
    this.state = null;
    this.level = null;
    stopAllEmitters();
  }

  /** Advance the fixed-timestep sim and hand back a view to render. */
  update(dt: number): RenderView | null {
    const state = this.state;
    if (!this.active || !state) return null;
    this.events = [];
    this.acc += dt * 1000;
    // Cap the catch-up: a background tab that returns after ten seconds must
    // not run six hundred ticks in one frame.
    let budget = 8;
    while (this.acc >= TICK_MS && budget-- > 0) {
      this.acc -= TICK_MS;
      step(state);
      for (const ev of state.events) this.events.push(ev);
    }
    if (this.acc > TICK_MS * 8) this.acc = 0;

    if (this.captionMs > 0) {
      this.captionMs -= dt * 1000;
      if (this.captionMs <= 0) this.ui.caption = '';
    }

    this.ui.hp = state.robot.hp;
    this.ui.maxHp = state.robot.maxHp;
    // The goto marker is a real entity so the robot has something to path to;
    // it evaporates the moment the trip is over.
    if (this.events.some((e) => e.type === 'order_done' && e.id === GOTO_ID)) this.clearGoto();
    this.consumeEvents();

    const sounds = this.level?.sounds ?? [];
    if (this.audio?.ready) updateEmitters(this.audio, sounds, state.robot.pos);

    return {
      sim: state,
      ui: this.ui,
      alpha: Math.min(1, this.acc / TICK_MS),
      frameEvents: this.events,
    };
  }

  /**
   * A click in the room. On a thing, it is the contextual order (fetch it,
   * shoot it, ride it); on bare floor it drops a marker and walks there —
   * `goto` needs a target ENTITY, and inventing a point order for a dev tool
   * would be a sim change made for the tool's convenience.
   */
  click(x: number, y: number, right: boolean): void {
    const state = this.state;
    if (!state) return;
    let best: { id: string; d: number; kind: string; hp: boolean } | null = null;
    for (const e of state.entities) {
      if (e.dead || e.id === GOTO_ID) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.y - y);
      if (d <= 14 && (!best || d < best.d)) {
        best = { id: e.id, d, kind: e.kind, hp: e.hp !== undefined };
      }
    }
    if (best) {
      const hostile = best.kind === 'fusedPrinter' || best.kind === 'fusedShredder';
      if (right || hostile) {
        if (best.hp) {
          setOrder(state, { kind: 'attack', targetId: best.id });
          this.o.status(`attack ${best.id}`);
          return;
        }
      }
      const fetchable = best.kind === 'scrap' || best.kind === 'chip' || best.kind === 'fuse';
      setOrder(
        state,
        fetchable ? { kind: 'pickup', targetId: best.id } : { kind: 'goto', targetId: best.id },
      );
      this.o.status(`${fetchable ? 'pickup' : 'goto'} ${best.id}`);
      return;
    }
    this.clearGoto();
    state.entities.push({
      id: GOTO_ID,
      kind: 'scrap',
      pos: { x, y },
      label: 'marker',
    });
    setOrder(state, { kind: 'goto', targetId: GOTO_ID });
    this.o.status(`goto ${Math.round(x)},${Math.round(y)}`);
  }

  /**
   * The half of a trigger the sim refused to run, plus the one sim event the
   * lit renderer has to know about. See the note at the top of the file for
   * what is deliberately dropped.
   */
  private consumeEvents(): void {
    const state = this.state;
    if (!state) return;
    for (const ev of this.events) {
      if (ev.type === 'tiles_changed') {
        // The sim rewrote `solid`, not the ASCII map — that only ever existed
        // in the level. The lit scene wants the map, so it is read back off the
        // grid the door actually opened in.
        this.o.litTilesChanged(mapFromSolid(state.solid));
        continue;
      }
      if (ev.type !== 'trigger_fired') continue;
      for (const a of ev.actions ?? []) {
        if (a.type === 'light') {
          this.o.litLightState(a.target, { on: a.on, intensity: a.intensity });
          this.o.status(`trigger ${ev.id ?? ''}: light ${a.target} ${a.on === false ? 'off' : 'on'}`);
        } else if (a.type === 'say') {
          this.ui.caption = a.line;
          this.captionMs = 2600;
        }
      }
    }
  }

  private clearGoto(): void {
    const state = this.state;
    if (!state) return;
    const i = state.entities.findIndex((e) => e.id === GOTO_ID);
    if (i >= 0) state.entities.splice(i, 1);
  }

  private async ensureAudio(): Promise<void> {
    if (this.audio) return;
    try {
      const engine = createAudioEngine();
      await engine.init();
      this.audio = engine;
    } catch {
      // No audio context (no gesture yet, or a browser that refused). Emitters
      // are ambience; a silent playtest is a working playtest.
      this.audio = null;
    }
  }
}
