/**
 * THE LOOK TAB — how the room is LIT, as opposed to what is in it.
 *
 * Every control here writes `LevelData.look`, which is a partial over
 * `LOOK_DEFAULTS`: a level stores only the keys it disagreed with, so retuning
 * the engine retunes every level that never had an opinion. `lookPatch` in
 * render/lit/types.ts does that reduction and is the ONLY serializer — a second
 * one here would be a second definition of "default", and they would drift the
 * first time a number was retuned.
 *
 * None of it goes through a scene rebuild. `updateLook` is safe every frame,
 * which is what makes a slider feel like a slider rather than like a form.
 *
 * The tile-dressing group lives here too, and it is the exception: hazard lanes
 * and floor variants are geometry, so they rebuild. They are here because they
 * are the same question — "what does this room look like" — and putting them in
 * the inspector would mean selecting nothing to reach them.
 */

import type { LevelData, LevelLook, TileAuthoring } from '@shared/types';
import { TILES_Y } from '@shared/types';
import { LOOK_DEFAULTS, lookPatch, resolveLook } from '../render/lit/types';
import { LOOK_GROUPS, LOOK_PRESETS, type LookField } from './litAssets';
import { replaceLookCmd, setLookCmd, setTileAuthCmd, type DraftStore } from './store';
import {
  boolRow,
  colorRow,
  el,
  group,
  mkBtn,
  sliderRow,
  numRow,
  type Widget,
} from './ui';

export interface LookPanelOpts {
  store: DraftStore;
  status: (msg: string) => void;
  /** Push the whole look at the running preview — the cheap path. */
  apply: (look: LevelLook | undefined) => void;
  /** Preview-only lens toggle; never serialized. */
  getLens: () => boolean;
  setLens: (on: boolean) => void;
  /** New dressing seed, and the reseed button. */
  reseed: () => void;
}

export class LookPanel {
  readonly root = el('div', 'rd-pane rd-hidden');
  private widgets: Widget[] = [];

  constructor(private o: LookPanelOpts) {}

  /** A change from elsewhere (undo, a preset, a load) — re-read the values. */
  pull(): void {
    for (const w of this.widgets) w.pull();
  }

  private add(host: HTMLElement, w: Widget): void {
    host.appendChild(w.row);
    this.widgets.push(w);
  }

  private get level(): LevelData {
    return this.o.store.level;
  }

  /** Resolved look — what the renderer is actually using right now. */
  private resolved(): Required<LevelLook> {
    return resolveLook(this.level.look);
  }

  /**
   * Write one key. A value back at its engine default is REMOVED rather than
   * stored: `lookPatch` is what decides that on the way out, and letting the
   * two disagree would save `"gamma": 1` into every level anyone ever opened
   * the panel on.
   */
  private set(key: keyof LevelLook, value: number | boolean): void {
    const next = lookPatch({ ...this.resolved(), [key]: value } as Required<LevelLook>);
    const cmd = replaceLookCmd(this.level, Object.keys(next).length > 0 ? next : undefined, `look ${key}`);
    this.o.store.run(cmd, 'inspector');
    this.o.apply(this.level.look);
  }

  render(): void {
    this.root.replaceChildren();
    this.widgets = [];

    // ------------------------------------------------------------- presets
    const presets = group('presets');
    const bar = el('div', 'rd-tools');
    for (const name of Object.keys(LOOK_PRESETS)) {
      const b = mkBtn(name, `apply the ${name} look`);
      b.addEventListener('click', () => {
        this.o.store.run(replaceLookCmd(this.level, { ...LOOK_PRESETS[name]! }, `look: ${name}`));
        this.o.apply(this.level.look);
        this.pull();
        this.o.status(`look: ${name}`);
      });
      bar.appendChild(b);
    }
    const reset = mkBtn('engine defaults', 'drop every override — the level stores no look at all');
    reset.addEventListener('click', () => {
      this.o.store.run(replaceLookCmd(this.level, undefined, 'look: engine defaults'));
      this.o.apply(undefined);
      this.pull();
      this.o.status('look reset to the engine defaults');
    });
    bar.appendChild(reset);
    presets.body.appendChild(bar);
    this.add(
      presets.body,
      boolRow('lens (preview)', () => this.o.getLens(), (v) => this.o.setLens(v), {
        hint: 'vignette, chroma, grain, scanlines. The GAME puts these on; they are never saved',
      }),
    );
    this.root.appendChild(presets.root);

    // -------------------------------------------------------------- groups
    for (const g of LOOK_GROUPS) {
      const sec = group(g.title);
      for (const f of g.fields) this.add(sec.body, this.field(f));
      this.root.appendChild(sec.root);
    }

    this.root.appendChild(this.dressingSection());

    // A level with no `look` key renders on the defaults — say so, because an
    // empty panel and a panel full of defaults look identical.
    const overrides = this.level.look ? Object.keys(this.level.look).length : 0;
    this.root.appendChild(
      el(
        'div',
        'rd-note',
        overrides === 0
          ? 'no look overrides — this level renders on the engine defaults'
          : `${overrides} override${overrides === 1 ? '' : 's'} saved into level.look`,
      ),
    );
  }

  private field(f: LookField): Widget {
    const get = (): number | boolean => this.resolved()[f.key] as number | boolean;
    const dflt = LOOK_DEFAULTS[f.key];
    const hint = `${f.hint ? f.hint + ' — ' : ''}engine default ${
      typeof dflt === 'number' ? dflt : dflt ? 'on' : 'off'
    }`;
    if (f.kind === 'color') {
      return colorRow(f.label, () => get() as number, (v) => this.set(f.key, v), { hint });
    }
    if (f.kind === 'bool') {
      return boolRow(f.label, () => get() as boolean, (v) => this.set(f.key, v), { hint });
    }
    return sliderRow(f.label, () => get() as number, (v) => this.set(f.key, v), {
      min: f.min ?? 0,
      max: f.max ?? 1,
      step: f.step ?? 0.01,
      hint,
    });
  }

  // ---------------------------------------------------------- tile dressing

  private dressingSection(): HTMLElement {
    const { root, body } = group('tile dressing');
    const store = this.o.store;

    this.add(
      body,
      numRow(
        'seed',
        () => this.level.meta.seed ?? 1,
        (v) => {
          store.run(
            {
              label: 'edit seed',
              structural: true,
              lit: true,
              apply: (l) => {
                l.meta = { ...l.meta, seed: v };
              },
              revert: (l) => {
                l.meta = { ...l.meta, seed: this.level.meta.seed };
              },
            },
            'inspector',
          );
        },
        { min: 1, max: 99999, hint: 'floor variants and dust. Authored, so the room is the same room every time' },
      ),
    );
    const rer = mkBtn('reseed', 'roll a new seed — the layout is untouched, only the dressing');
    rer.addEventListener('click', () => {
      this.o.reseed();
      this.pull();
    });
    body.appendChild(rer);

    // ---- hazard lanes, one toggle per row
    //
    // A lane has to be a LINE (render/lit/scene.ts buildTiles): scattering the
    // stripe variant per tile turns a painted walkway into a field of yellow
    // dashes. So it is authored per ROW, and this is a row of row buttons.
    body.appendChild(el('div', 'rd-secthead', 'hazard lanes — click a row'));
    const rows = el('div', 'rd-rowbar');
    const walk = new Set(this.level.tiles?.walkRows ?? []);
    for (let y = 0; y < TILES_Y; y++) {
      const b = mkBtn(String(y), `row ${y}`, walk.has(y) ? 'rd-on' : '');
      b.classList.add('rd-mini');
      b.addEventListener('click', () => {
        const cur = new Set(this.level.tiles?.walkRows ?? []);
        if (cur.has(y)) cur.delete(y);
        else cur.add(y);
        const next: TileAuthoring = { ...this.level.tiles };
        const list = [...cur].sort((a, b2) => a - b2);
        if (list.length > 0) next.walkRows = list;
        else delete next.walkRows;
        store.run(setTileAuthCmd(this.level, next, 'edit hazard lanes'));
        this.render();
      });
      rows.appendChild(b);
    }
    body.appendChild(rows);

    const overrides = this.level.tiles?.overrides?.length ?? 0;
    body.appendChild(
      el('div', 'rd-lbl', `${overrides} floor variant override${overrides === 1 ? '' : 's'} — Y paints them`),
    );
    if (overrides > 0) {
      const clear = mkBtn('clear variants', 'drop every painted floor variant');
      clear.addEventListener('click', () => {
        const next: TileAuthoring = { ...this.level.tiles };
        delete next.overrides;
        store.run(setTileAuthCmd(this.level, next, 'clear floor variants'));
        this.render();
      });
      body.appendChild(clear);
    }
    return root;
  }
}
