/**
 * THE PROPERTIES PANEL — schema-driven, one section per selected thing.
 *
 * Every widget is a get/set pair over the draft, and every set goes through
 * `store.run` with source 'inspector', which is how a field being typed into
 * survives its own change notification: the panel skips rebuilding for its own
 * edits and only re-reads values.
 *
 * The trigger action editor is the reason this file is long. An action is a
 * discriminated union in shared/types.ts, and the editor mirrors it exactly —
 * changing the type swaps the body for that variant's fields, so an authored
 * trigger cannot be given a payload the sim will not read.
 */

import type {
  ChipId,
  DecorName,
  DecorPlacement,
  EntityKind,
  FixtureDef,
  LevelEntityDef,
  LightPlacement,
  SfxName,
  SoundEmitterDef,
  TileRect,
  TriggerAction,
  TriggerDef,
  WetPatch,
} from '@shared/types';
import { TILE, TILES_X, TILES_Y } from '@shared/types';
import { updateItemCmd, updateLitCmd, updateWetCmd, type DraftStore } from './store';
import { CHIP_IDS, ENTITY_KINDS, SFX_NAMES, kindInfo } from './palette';
import {
  DECOR_NAMES,
  LAMP_STYLE_NAMES,
  LIGHT_COLORS,
  WALL_STYLE_NAMES,
  decorEntry,
} from './litAssets';
import { renameFixture, renameLight, targetableLights } from './litEdit';
import { BUILTIN_COUNT } from './io';
import {
  boolRow,
  colorRow,
  el,
  group,
  mkBtn,
  numRow,
  optNumRow,
  selectRow,
  sliderRow,
  swatchStrip,
  textRow,
  type Widget,
} from './ui';

const NONE = '—';

export interface InspectorOpts {
  store: DraftStore;
  status: (msg: string) => void;
  /** The live marquee, for "take these tiles" on a setTiles action. */
  region: () => TileRect | null;
  /** Delete the current selection — the tools own it, so undo behaves. */
  remove: () => void;
  /** A light changed: push it at the running lightmap without a rebuild. */
  litNudge: (light: LightPlacement) => void;
  /** A fixture changed: same idea, straight at the sprite. */
  litFixture: (id: string, patch: Partial<FixtureDef>) => void;
  /** Preview a lamp being switched off, exactly as a trigger would do it. */
  litLightState: (id: string, state: { on?: boolean; intensity?: number }) => void;
}

export class Inspector {
  readonly root = el('div', 'rd-pane');
  private widgets: Widget[] = [];

  constructor(private o: InspectorOpts) {}

  /** A change the panel did not make — re-read everything into the DOM. */
  pull(): void {
    for (const w of this.widgets) w.pull();
  }

  render(): void {
    this.root.replaceChildren();
    this.widgets = [];
    this.root.appendChild(this.levelSection());
    const sel = this.o.store.selection;
    if (!sel || sel.kind === 'level') {
      this.root.appendChild(
        el('div', 'rd-empty', 'nothing selected — V and click a thing, or drag a region'),
      );
      return;
    }
    if (sel.kind === 'entity') {
      const e = this.o.store.entity(sel.id);
      if (e) this.root.appendChild(this.entitySection(e));
    } else if (sel.kind === 'trigger') {
      const t = this.o.store.trigger(sel.id);
      if (t) this.root.appendChild(this.triggerSection(t));
    } else if (sel.kind === 'decor') {
      const d = this.o.store.decor(sel.id);
      if (d) {
        this.root.appendChild(this.decorSection(d));
        if (d.fixtureId) {
          const f = this.o.store.fixture(d.fixtureId);
          if (f) this.root.appendChild(this.fixtureSection(f));
        }
      }
    } else if (sel.kind === 'light') {
      const l = this.o.store.light(sel.id);
      if (l) this.root.appendChild(this.lightSection(l));
    } else if (sel.kind === 'wet') {
      const w = this.o.store.level.wetPatches?.[sel.index];
      if (w) this.root.appendChild(this.wetSection(w, sel.index));
    } else {
      const s = this.o.store.sound(sel.id);
      if (s) this.root.appendChild(this.soundSection(s));
    }
  }

  private add(host: HTMLElement, w: Widget): void {
    host.appendChild(w.row);
    this.widgets.push(w);
  }

  // ------------------------------------------------------------------ level

  private levelSection(): HTMLElement {
    const { root, body } = group('level');
    const s = this.o.store;
    const setMeta = (patch: Partial<typeof s.level.meta>): void => {
      const before = { ...s.level.meta };
      const after = { ...before, ...patch };
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      s.run(
        {
          label: 'edit level',
          structural: false,
          apply: (l) => {
            l.meta = { ...after };
          },
          revert: (l) => {
            l.meta = { ...before };
          },
        },
        'inspector',
      );
    };
    this.add(
      body,
      textRow(
        'id',
        () => s.level.meta.id,
        (v) => {
          // The id IS the file name on save, so it is sanitised on the way in
          // rather than rejected on the way out.
          const slug = v.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
          if (slug !== v) this.o.status(`id → '${slug}' (slug only: a-z 0-9 -)`);
          setMeta({ id: slug || 'level' });
          this.pull();
        },
        { hint: 'saved as client/src/levels/<id>.level.ts' },
      ),
    );
    this.add(
      body,
      textRow('name', () => s.level.meta.name, (v) => setMeta({ name: v })),
    );
    this.add(
      body,
      numRow('order', () => s.level.meta.order, (v) => setMeta({ order: v }), {
        min: -99,
        max: 99,
        hint: 'sort key among custom levels',
      }),
    );
    // Blank is the normal answer and has to stay typeable: a level with a
    // number in here stops being a side door reached by `?floor=N` and becomes
    // a floor of the run, standing where a built-in stood.
    this.add(
      body,
      optNumRow(
        'replaces',
        () => s.level.meta.replaces ?? null,
        (v) => setMeta({ replaces: v ?? undefined }),
        {
          min: 1,
          max: BUILTIN_COUNT,
          placeholder: 'append',
          hint: `built-in floor number this level stands in for (1..${BUILTIN_COUNT}); blank = appended after the built-ins`,
        },
      ),
    );
    // No explicit spawn is the NORMAL case, not a missing value: loadFloor falls
    // back to `elevA.pos` and then to (40,136)px. The rows have to show that,
    // because 0,0 is a wall in every level and reads as a placement bug — and it
    // is also the base the edit below merges a single typed axis into.
    const spawn = (): { tx: number; ty: number } => {
      if (s.level.spawn) return s.level.spawn;
      const a = s.level.entities.find((e) => e.id === 'elevA');
      return a ? { tx: a.tx, ty: a.ty } : { tx: 2, ty: 8 };
    };
    const setSpawn = (patch: { tx?: number; ty?: number }): void => {
      const before = s.level.spawn ? { ...s.level.spawn } : undefined;
      const after = { ...spawn(), ...patch };
      s.run(
        {
          label: 'move spawn',
          structural: true,
          apply: (l) => {
            l.spawn = { ...after };
          },
          revert: (l) => {
            if (before) l.spawn = { ...before };
            else delete l.spawn;
          },
        },
        'inspector',
      );
    };
    this.add(body, numRow('spawn tx', () => spawn().tx, (v) => setSpawn({ tx: v }), { min: 0, max: TILES_X - 1 }));
    this.add(body, numRow('spawn ty', () => spawn().ty, (v) => setSpawn({ ty: v }), { min: 0, max: TILES_Y - 1 }));
    const counts = el(
      'div',
      'rd-lbl',
      `${s.level.entities.length} entities · ${s.level.triggers.length} triggers · ${s.level.sounds.length} sounds`,
    );
    body.appendChild(counts);
    const lit = [
      [s.level.decor?.length ?? 0, 'decor'],
      [s.level.lights?.length ?? 0, 'lights'],
      [s.level.fixtures?.length ?? 0, 'fixtures'],
      [s.level.wetPatches?.length ?? 0, 'wet'],
    ] as const;
    if (lit.some(([n]) => n > 0)) {
      body.appendChild(el('div', 'rd-lbl', lit.map(([n, name]) => `${n} ${name}`).join(' · ')));
    }
    return root;
  }

  // ----------------------------------------------------------------- entity

  private patchEntity(id: string, patch: Partial<LevelEntityDef>, label = 'edit entity'): void {
    this.o.store.run(updateItemCmd(this.o.store.level, 'entities', id, patch, label), 'inspector');
  }

  private entitySection(e: LevelEntityDef): HTMLElement {
    const { root, body } = group(`entity · ${e.kind}`);
    const id = e.id;
    const live = (): LevelEntityDef => this.o.store.entity(id) ?? e;

    this.add(
      body,
      textRow('id', () => live().id, (v) => {
        const next = v.trim();
        if (!next || next === id) return;
        this.patchEntity(id, { id: next }, 'rename entity');
        this.o.store.select({ kind: 'entity', id: next });
      }, { hint: 'the name the director and the parser address it by' }),
    );
    this.add(
      body,
      selectRow('kind', ENTITY_KINDS, () => live().kind, (v) => {
        this.patchEntity(id, { kind: v as EntityKind }, 'change kind');
        this.render();
      }),
    );
    this.add(body, numRow('tx', () => live().tx, (v) => this.patchEntity(id, { tx: v }), { min: 0, max: TILES_X - 1 }));
    this.add(body, numRow('ty', () => live().ty, (v) => this.patchEntity(id, { ty: v }), { min: 0, max: TILES_Y - 1 }));
    this.add(
      body,
      textRow(
        'label',
        () => live().label ?? '',
        (v) => this.patchEntity(id, { label: v.trim() === '' ? undefined : v }),
        { placeholder: 'builder default', hint: 'what the player calls it out loud' },
      ),
    );

    if (e.kind === 'chip' || e.kind === 'crate') {
      this.add(
        body,
        selectRow(
          'chip',
          [NONE, ...CHIP_IDS],
          () => live().option ?? NONE,
          (v) => this.patchEntity(id, { option: v === NONE ? undefined : (v as ChipId) }),
          { hint: 'which personality this box or chip carries' },
        ),
      );
    }
    if (e.kind === 'fusedPrinter' || e.kind === 'fusedShredder' || e.kind === 'printerInnocent') {
      this.add(
        body,
        numRow('hp', () => live().hp ?? 0, (v) => this.patchEntity(id, { hp: v > 0 ? v : undefined }), {
          min: 0,
          max: 200,
          hint: '0 = the builder default',
        }),
      );
      this.add(
        body,
        boolRow('dormant', () => live().dormant === true, (v) => this.patchEntity(id, { dormant: v || undefined }), {
          hint: 'scenery until a trigger wakes it — the ambush',
        }),
      );
    }
    if (e.kind === 'elevatorB') {
      this.add(
        body,
        boolRow('dark', () => live().dark === true, (v) => this.patchEntity(id, { dark: v || undefined }), {
          hint: 'unpowered until a fuse or a power trigger lights it',
        }),
      );
    }

    const del = mkBtn('Delete', 'same as Del');
    del.addEventListener('click', () => this.o.remove());
    body.appendChild(del);
    return root;
  }

  // ------------------------------------------------------------------ decor

  private patchDecor(id: string, patch: Partial<DecorPlacement>, label = 'edit decor'): void {
    this.o.store.run(updateLitCmd(this.o.store.level, 'decor', id, patch, label), 'inspector');
  }

  private decorSection(d: DecorPlacement): HTMLElement {
    const { root, body } = group(`decor · ${d.name}`);
    const id = d.id;
    const live = (): DecorPlacement => this.o.store.decor(id) ?? d;
    const entry = decorEntry(d.name);

    this.add(
      body,
      textRow('id', () => live().id, (v) => {
        const next = v.trim();
        if (!next || next === id) return;
        this.patchDecor(id, { id: next }, 'rename decor');
        this.o.store.select({ kind: 'decor', id: next });
      }),
    );
    this.add(
      body,
      selectRow('prop', DECOR_NAMES, () => live().name, (v) => {
        this.patchDecor(id, { name: v as DecorName }, 'change prop');
        this.render();
      }),
    );
    // Fractional, and to two decimals: the tools snap to quarter tiles, but a
    // typed 3.33 is a legitimate answer and rounding it away in the panel would
    // silently move a prop somebody placed on purpose.
    this.add(body, numRow('tx', () => live().tx, (v) => this.patchDecor(id, { tx: v }), { min: 0, max: TILES_X, step: 0.01 }));
    this.add(body, numRow('ty', () => live().ty, (v) => this.patchDecor(id, { ty: v }), { min: 0, max: TILES_Y, step: 0.01 }));
    this.add(body, boolRow('flip', () => live().flip === true, (v) => this.patchDecor(id, { flip: v || undefined })));
    this.add(
      body,
      boolRow('reflect', () => live().reflect === true, (v) => this.patchDecor(id, { reflect: v || undefined }), {
        hint: 'mirror into the wet floor — only shows inside a wet patch',
      }),
    );
    this.add(
      body,
      boolRow('ceiling', () => live().ceiling === true, (v) => this.patchDecor(id, { ceiling: v || undefined }), {
        hint: 'draws over everything, casts nothing — hanging signs and lamps',
      }),
    );

    // ---- footprint: the light-blocking base
    const hasFoot = (): boolean => live().foot !== undefined;
    const foot = (): [number, number] => live().foot ?? [entry.w, Math.round(entry.h * 0.35)];
    this.add(
      body,
      boolRow('footprint', hasFoot, (v) => {
        this.patchDecor(id, { foot: v ? foot() : undefined }, 'edit footprint');
        this.render();
      }, { hint: 'blocks light and darkens the floor it stands on. Flat props have none' }),
    );
    if (hasFoot()) {
      this.add(
        body,
        numRow('foot w', () => foot()[0], (v) => this.patchDecor(id, { foot: [v, foot()[1]] }), { min: 1, max: 96 }),
      );
      this.add(
        body,
        numRow('foot h', () => foot()[1], (v) => this.patchDecor(id, { foot: [foot()[0], v] }), { min: 1, max: 64 }),
      );
    }

    body.appendChild(
      el('div', 'rd-lbl', `${entry.w}×${entry.h}px${entry.frames > 1 ? ` · ${entry.frames} frames` : ''}${entry.glow ? ' · emissive' : ''}`),
    );
    if (d.fixtureId) {
      body.appendChild(el('div', 'rd-note', `lamp '${d.fixtureId}' — light and fixture below move with this prop`));
    }
    const del = mkBtn('Delete', 'same as Del — takes its light and fixture with it');
    del.addEventListener('click', () => this.o.remove());
    body.appendChild(del);
    return root;
  }

  // ------------------------------------------------------------------ light

  private patchLight(id: string, patch: Partial<LightPlacement>, label = 'edit light'): void {
    this.o.store.run(updateLitCmd(this.o.store.level, 'lights', id, patch, label), 'inspector');
    const next = this.o.store.light(id);
    // Straight at the running lightmap: a light being tuned has to answer while
    // the slider is moving, and a scene rebuild per frame would not.
    if (next) this.o.litNudge(next);
  }

  private lightSection(l: LightPlacement): HTMLElement {
    const { root, body } = group(`light · ${l.kind ?? 'point'}`);
    const id = l.id;
    const live = (): LightPlacement => this.o.store.light(id) ?? l;

    this.add(
      body,
      textRow('id', () => live().id, (v) => {
        const next = v.trim();
        if (!next || next === id) return;
        // A lamp's light shares its id with its fixture and its prop's link, so
        // the rename has to travel — see litEdit.renameFixture.
        this.o.store.run(renameLight(this.o.store, id, next), 'inspector');
        this.o.store.select({ kind: 'light', id: next });
      }, { hint: "what a trigger's `light` action addresses" }),
    );
    this.add(
      body,
      selectRow('kind', ['point', 'cone'], () => live().kind ?? 'point', (v) => {
        const next: Partial<LightPlacement> = { kind: v as 'point' | 'cone' };
        if (v === 'cone') {
          next.dir = live().dir ?? Math.PI / 2;
          next.spread = live().spread ?? 0.75;
        }
        this.patchLight(id, next, 'change light kind');
        this.render();
      }),
    );
    this.add(body, numRow('tx', () => live().tx, (v) => this.patchLight(id, { tx: v }), { min: 0, max: TILES_X, step: 0.01 }));
    this.add(body, numRow('ty', () => live().ty, (v) => this.patchLight(id, { ty: v }), { min: 0, max: TILES_Y, step: 0.01 }));
    this.add(
      body,
      sliderRow('radius', () => live().radius, (v) => this.patchLight(id, { radius: v }), {
        min: 8,
        max: 260,
        step: 1,
        hint: 'authored px, before the level look scales it',
      }),
    );
    this.add(
      body,
      sliderRow('intensity', () => live().intensity, (v) => this.patchLight(id, { intensity: v }), {
        min: 0,
        max: 2.5,
        step: 0.01,
      }),
    );
    this.add(body, colorRow('colour', () => live().color, (v) => this.patchLight(id, { color: v })));
    body.appendChild(swatchStrip(LIGHT_COLORS, (v) => {
      this.patchLight(id, { color: v }, 'light colour');
      this.pull();
    }));

    if ((live().kind ?? 'point') === 'cone') {
      this.add(
        body,
        sliderRow('aim', () => live().dir ?? 0, (v) => this.patchLight(id, { dir: v }), {
          min: -Math.PI,
          max: Math.PI,
          step: 0.01,
          hint: 'radians, 0 = right. Drag the handle in the room instead',
        }),
      );
      this.add(
        body,
        sliderRow('spread', () => live().spread ?? 0.6, (v) => this.patchLight(id, { spread: v }), {
          min: 0.08,
          max: 1.5,
          step: 0.01,
          hint: 'half-angle, radians',
        }),
      );
    }
    this.add(
      body,
      sliderRow('flicker', () => live().flicker ?? 0, (v) => this.patchLight(id, { flicker: v || undefined }), {
        min: 0,
        max: 2,
        step: 0.05,
        hint: '0 steady, 1 a dying tube',
      }),
    );
    this.add(
      body,
      sliderRow('flicker Hz', () => live().flickerHz ?? 8, (v) => this.patchLight(id, { flickerHz: v }), {
        min: 1,
        max: 30,
        step: 0.5,
      }),
    );
    this.add(
      body,
      boolRow('cast shadow', () => live().castShadow !== false, (v) => this.patchLight(id, { castShadow: v }), {
        hint: 'a full-screen bake each. Accents leave it off',
      }),
    );
    this.add(
      body,
      boolRow('volumetric', () => live().volumetric !== false, (v) => this.patchLight(id, { volumetric: v || undefined }), {
        hint: 'fills the air with haze and dust',
      }),
    );
    this.add(
      body,
      sliderRow('radius ×', () => live().scale ?? 1, (v) => this.patchLight(id, { scale: v === 1 ? undefined : v }), {
        min: 0.2,
        max: 3,
        step: 0.05,
        hint: "multiplies the level's radius scale, so one lamp can stay small",
      }),
    );

    // A preview switch, not authored state: this is what a trigger's `light`
    // action will do, so you can see the beat before wiring the trigger.
    const bar = el('div', 'rd-tools');
    const off = mkBtn('preview off', 'kill this lamp in the preview — not saved');
    off.addEventListener('click', () => {
      this.o.litLightState(id, { on: false });
      this.o.status(`${id} off (preview only)`);
    });
    const on = mkBtn('preview on', 'and back on');
    on.addEventListener('click', () => {
      this.o.litLightState(id, { on: true, intensity: live().intensity });
      this.o.status(`${id} on`);
    });
    bar.append(off, on);
    body.appendChild(bar);

    const del = mkBtn('Delete', 'same as Del');
    del.addEventListener('click', () => this.o.remove());
    body.appendChild(del);
    return root;
  }

  // ---------------------------------------------------------------- fixture

  private fixtureSection(f: FixtureDef): HTMLElement {
    const { root, body } = group(`fixture · ${f.kind}`);
    const id = f.id;
    const live = (): FixtureDef => this.o.store.fixture(id) ?? f;
    const patch = (p: Partial<FixtureDef>, label = 'edit fixture'): void => {
      this.o.store.run(updateLitCmd(this.o.store.level, 'fixtures', id, p, label), 'inspector');
      // The fixture sprite takes a patch live — style, scale, mount, all of it.
      this.o.litFixture(id, p);
    };

    this.add(
      body,
      textRow('id', () => live().id, (v) => {
        const next = v.trim();
        if (!next || next === id) return;
        this.o.store.run(renameFixture(this.o.store, id, next), 'inspector');
        this.render();
      }, { hint: 'shared by the prop, the light and this record' }),
    );
    this.add(
      body,
      selectRow(
        'style',
        live().kind === 'wall' ? WALL_STYLE_NAMES : LAMP_STYLE_NAMES,
        () => live().style,
        (v) => patch({ style: v }, 'fixture style'),
        { hint: 'the housing only — swapping it leaves the room lit' },
      ),
    );
    this.add(body, sliderRow('scale', () => live().scale ?? 1, (v) => patch({ scale: v }), { min: 0.4, max: 2.5, step: 0.05 }));
    this.add(
      body,
      sliderRow('body alpha', () => live().bodyAlpha ?? 1, (v) => patch({ bodyAlpha: v }), { min: 0, max: 1, step: 0.02 }),
    );
    this.add(body, sliderRow('glow', () => live().glow ?? 1, (v) => patch({ glow: v }), { min: 0, max: 2, step: 0.02 }));

    if (live().kind === 'wall') {
      body.appendChild(
        el('div', 'rd-note', 'wall mounts sit on a SOUTH-facing wall face — a solid tile with open floor under it.'),
      );
      this.add(
        body,
        sliderRow('mount y', () => live().mountY ?? 0, (v) => patch({ mountY: v }), {
          min: -16,
          max: 16,
          step: 0.5,
          hint: 'where the housing sits on its 16px wall face',
        }),
      );
      this.add(body, sliderRow('light x', () => live().lightX ?? 0, (v) => patch({ lightX: v }), { min: -24, max: 24, step: 0.5 }));
      this.add(body, sliderRow('light y', () => live().lightY ?? 0, (v) => patch({ lightY: v }), { min: -24, max: 24, step: 0.5 }));
      this.add(
        body,
        sliderRow('spill', () => live().spill ?? 1, (v) => patch({ spill: v }), {
          min: 0,
          max: 3,
          step: 0.05,
          hint: 'the wall wash that lights the fixture itself and the wall behind it',
        }),
      );
    }
    return root;
  }

  // ------------------------------------------------------------ wet patches

  private wetSection(w: WetPatch, index: number): HTMLElement {
    const { root, body } = group('wet floor');
    const live = (): WetPatch => this.o.store.level.wetPatches?.[index] ?? w;
    const patch = (p: Partial<WetPatch>): void => {
      this.o.store.run(updateWetCmd(this.o.store.level, index, p), 'inspector');
    };
    this.add(body, numRow('tx', () => live().tx, (v) => patch({ tx: v }), { min: 0, max: TILES_X, step: 0.05 }));
    this.add(body, numRow('ty', () => live().ty, (v) => patch({ ty: v }), { min: 0, max: TILES_Y, step: 0.05 }));
    this.add(body, numRow('rx tiles', () => live().rx, (v) => patch({ rx: v }), { min: 0.2, max: 12, step: 0.05 }));
    this.add(body, numRow('ry tiles', () => live().ry, (v) => patch({ ry: v }), { min: 0.2, max: 12, step: 0.05 }));
    body.appendChild(
      el(
        'div',
        'rd-note',
        'reflections are off in the engine default — turn them on in LOOK to see the mirror.',
      ),
    );
    const del = mkBtn('Delete', 'same as Del');
    del.addEventListener('click', () => this.o.remove());
    body.appendChild(del);
    return root;
  }

  // ---------------------------------------------------------------- trigger

  private patchTrigger(id: string, patch: Partial<TriggerDef>, label = 'edit trigger'): void {
    this.o.store.run(updateItemCmd(this.o.store.level, 'triggers', id, patch, label), 'inspector');
  }

  private triggerSection(t: TriggerDef): HTMLElement {
    const { root, body } = group('trigger');
    const id = t.id;
    const live = (): TriggerDef => this.o.store.trigger(id) ?? t;

    this.add(
      body,
      textRow('id', () => live().id, (v) => {
        const next = v.trim();
        if (!next || next === id) return;
        this.patchTrigger(id, { id: next }, 'rename trigger');
        this.o.store.select({ kind: 'trigger', id: next });
      }),
    );
    this.add(
      body,
      selectRow('when', ['enter', 'exit'], () => live().when, (v) =>
        this.patchTrigger(id, { when: v as 'enter' | 'exit' }),
      { hint: 'which edge of the rect the robot CENTRE crosses' }),
    );
    this.add(
      body,
      boolRow('once', () => live().once !== false, (v) => this.patchTrigger(id, { once: v }), {
        hint: 'off = fires every crossing',
      }),
    );
    const rectField = (key: keyof TileRect, label: string, max: number): Widget =>
      numRow(label, () => live().rect[key], (v) => this.patchTrigger(id, { rect: { ...live().rect, [key]: v } }), {
        min: key === 'tw' || key === 'th' ? 1 : 0,
        max,
      });
    this.add(body, rectField('tx', 'rect tx', TILES_X - 1));
    this.add(body, rectField('ty', 'rect ty', TILES_Y - 1));
    this.add(body, rectField('tw', 'rect w', TILES_X));
    this.add(body, rectField('th', 'rect h', TILES_Y));

    body.appendChild(el('div', 'rd-secthead', 'actions'));
    const list = el('div');
    body.appendChild(list);
    this.paintActions(list, id);

    const add = mkBtn('+ action');
    add.addEventListener('click', () => {
      const next = [...live().actions, this.freshAction('say')];
      this.patchTrigger(id, { actions: next }, 'add action');
      this.render();
    });
    body.appendChild(add);
    return root;
  }

  /**
   * A new action of this type, pointed at something real where it can be.
   *
   * `defaultAction` is a pure table and stays one; a `light` action defaulting
   * to the empty string is a validation error the moment it is added, which
   * teaches that the red panel is noise.
   */
  private freshAction(type: TriggerAction['type']): TriggerAction {
    const a = defaultAction(type);
    if (a.type === 'light') {
      const first = targetableLights(this.o.store.level)[0];
      if (first) a.target = first.id;
    }
    return a;
  }

  private paintActions(host: HTMLElement, trigId: string): void {
    const live = (): TriggerDef | undefined => this.o.store.trigger(trigId);
    const actions = live()?.actions ?? [];
    const setActions = (next: TriggerAction[], label: string): void => {
      this.patchTrigger(trigId, { actions: next }, label);
    };
    const patchAt = (i: number, next: TriggerAction): void => {
      const arr = [...(live()?.actions ?? [])];
      arr[i] = next;
      setActions(arr, 'edit action');
    };

    actions.forEach((a, i) => {
      const card = el('div', 'rd-act');
      const head = el('div', 'rd-acthead');
      const sel = el('select', 'rd-select') as HTMLSelectElement;
      for (const type of ACTION_TYPES) {
        const opt = el('option');
        opt.value = type;
        opt.textContent = type;
        sel.appendChild(opt);
      }
      sel.value = a.type;
      sel.addEventListener('change', () => {
        patchAt(i, this.freshAction(sel.value as TriggerAction['type']));
        this.render();
      });
      const up = mkBtn('↑', 'move up', 'rd-mini');
      const down = mkBtn('↓', 'move down', 'rd-mini');
      const kill = mkBtn('✕', 'remove', 'rd-mini');
      up.disabled = i === 0;
      down.disabled = i === actions.length - 1;
      up.addEventListener('click', () => {
        const arr = [...(live()?.actions ?? [])];
        [arr[i - 1], arr[i]] = [arr[i]!, arr[i - 1]!];
        setActions(arr, 'reorder actions');
        this.render();
      });
      down.addEventListener('click', () => {
        const arr = [...(live()?.actions ?? [])];
        [arr[i + 1], arr[i]] = [arr[i]!, arr[i + 1]!];
        setActions(arr, 'reorder actions');
        this.render();
      });
      kill.addEventListener('click', () => {
        const arr = [...(live()?.actions ?? [])];
        arr.splice(i, 1);
        setActions(arr, 'remove action');
        this.render();
      });
      head.append(sel, up, down, kill);
      const bodyEl = el('div', 'rd-actbody');
      this.actionFields(bodyEl, a, i, (next) => patchAt(i, next), trigId);
      card.append(head, bodyEl);
      host.appendChild(card);
    });
  }

  /**
   * One variant's fields. Every writer produces a WHOLE action object, so a
   * half-edited union member can never reach the draft.
   *
   * The fields read the action through `cur()`, never through the `a` they were
   * built with. An edit here re-runs the panel's `pull()` rather than its
   * `render()` — that is what stops a field losing focus mid-type — so the
   * closures outlive the object they were handed, and a widget reading the
   * stale copy writes the value BACK on the next edit. It is invisible until
   * one action has two controls: flip a toggle, touch a second field, and the
   * toggle silently returns to where it was.
   */
  private actionFields(
    host: HTMLElement,
    a: TriggerAction,
    index: number,
    write: (next: TriggerAction) => void,
    trigId: string,
  ): void {
    const entityIds = this.o.store.level.entities.map((e) => e.id);
    const at = (): TriggerAction | undefined => this.o.store.trigger(trigId)?.actions[index];
    /** This action as it is NOW, or the one we were built with if it is gone. */
    const cur = <T extends TriggerAction['type']>(type: T): Extract<TriggerAction, { type: T }> => {
      const v = at();
      return (v && v.type === type ? v : a) as Extract<TriggerAction, { type: T }>;
    };
    switch (a.type) {
      case 'say':
        this.add(
          host,
          textRow('line', () => cur('say').line, (v) => write({ type: 'say', line: v.toUpperCase() }), {
            hint: 'toddler-speak: third person, ≤7 words, no clauses',
          }),
        );
        break;
      case 'sfx': {
        this.add(
          host,
          selectRow('sound', SFX_NAMES, () => cur('sfx').sound, (v) => write({ ...cur('sfx'), sound: v as SfxName })),
        );
        this.add(
          host,
          boolRow('positional', () => cur('sfx').at !== undefined, (v) => {
            if (!v) {
              write({ type: 'sfx', sound: cur('sfx').sound });
              this.render();
              return;
            }
            const r = this.o.store.trigger(trigId)?.rect;
            const spot = r
              ? { x: (r.tx + r.tw / 2) * TILE, y: (r.ty + r.th / 2) * TILE }
              : { x: 0, y: 0 };
            write({ type: 'sfx', sound: cur('sfx').sound, at: spot });
            this.render();
          }, { hint: 'volume falls off from the robot' }),
        );
        if (a.at) {
          const spot = (): { x: number; y: number } => cur('sfx').at ?? { x: 0, y: 0 };
          this.add(host, numRow('x', () => spot().x, (v) => write({ ...cur('sfx'), at: { x: v, y: spot().y } }), { min: 0, max: TILES_X * TILE }));
          this.add(host, numRow('y', () => spot().y, (v) => write({ ...cur('sfx'), at: { x: spot().x, y: v } }), { min: 0, max: TILES_Y * TILE }));
        }
        break;
      }
      case 'wake':
        this.add(
          host,
          selectRow('target', entityIds.length ? entityIds : [NONE], () => cur('wake').target, (v) =>
            write({ type: 'wake', target: v }),
          { hint: 'clears dormant — the ambush stands up' }),
        );
        break;
      case 'power':
        this.add(
          host,
          selectRow('target', entityIds.length ? entityIds : [NONE], () => cur('power').target, (v) =>
            write({ type: 'power', target: v, on: cur('power').on }),
          ),
        );
        this.add(
          host,
          boolRow('on', () => cur('power').on, (v) => write({ type: 'power', target: cur('power').target, on: v })),
        );
        break;
      case 'hum':
        this.add(
          host,
          sliderRow('level', () => cur('hum').level, (v) => write({ type: 'hum', level: v }), {
            min: 0,
            max: 1,
            step: 0.05,
          }),
        );
        break;
      case 'shake':
        this.add(host, numRow('ms', () => cur('shake').ms, (v) => write({ type: 'shake', ms: v }), { min: 0, max: 3000, step: 50 }));
        break;
      case 'spawn': {
        const e = (): LevelEntityDef => cur('spawn').entity;
        this.add(host, textRow('id', () => e().id, (v) => write({ type: 'spawn', entity: { ...e(), id: v.trim() || e().id } })));
        this.add(
          host,
          selectRow('kind', ENTITY_KINDS, () => e().kind, (v) =>
            write({ type: 'spawn', entity: { ...e(), kind: v as EntityKind } }),
          ),
        );
        this.add(host, numRow('tx', () => e().tx, (v) => write({ type: 'spawn', entity: { ...e(), tx: v } }), { min: 0, max: TILES_X - 1 }));
        this.add(host, numRow('ty', () => e().ty, (v) => write({ type: 'spawn', entity: { ...e(), ty: v } }), { min: 0, max: TILES_Y - 1 }));
        break;
      }
      case 'light': {
        // Wall washes are left out on purpose: `setLightState` drives a sconce
        // and its `_pt` companion as one lamp, so offering both would be two
        // names for one switch and one of them would look broken.
        const lights = targetableLights(this.o.store.level).map((l) => l.id);
        this.add(
          host,
          selectRow(lights.length ? 'target' : 'target (none)', lights.length ? lights : [NONE], () => cur('light').target, (v) =>
            write({ ...cur('light'), target: v }),
          { hint: 'an authored light id — the lamp this beat drives' }),
        );
        this.add(
          host,
          boolRow('on', () => cur('light').on !== false, (v) => write({ ...cur('light'), on: v }), {
            hint: 'off kills the lamp and its own lit face',
          }),
        );
        this.add(
          host,
          boolRow('set intensity', () => cur('light').intensity !== undefined, (v) => {
            const now = cur('light');
            write(v ? { ...now, intensity: 1 } : { type: 'light', target: now.target, on: now.on });
            this.render();
          }),
        );
        if (a.intensity !== undefined) {
          this.add(
            host,
            sliderRow('intensity', () => cur('light').intensity ?? 1, (v) => write({ ...cur('light'), intensity: v }), {
              min: 0,
              max: 2.5,
              step: 0.05,
            }),
          );
        }
        const test = mkBtn('fire it', 'apply this action to the preview now — not saved');
        test.addEventListener('click', () => {
          const now = cur('light');
          this.o.litLightState(now.target, { on: now.on, intensity: now.intensity });
          this.o.status(`${now.target}: ${now.on === false ? 'off' : 'on'}`);
        });
        host.appendChild(test);
        break;
      }
      case 'setTiles': {
        const count = el('div', 'rd-lbl', `${a.tiles.length} tiles`);
        host.appendChild(count);
        const solidNow = (): boolean => {
          const tiles = cur('setTiles').tiles;
          return tiles.length > 0 && tiles.every((t) => t.solid);
        };
        this.add(
          host,
          boolRow('solid', solidNow, (v) =>
            write({ type: 'setTiles', tiles: cur('setTiles').tiles.map((t) => ({ ...t, solid: v })) }),
          { hint: 'off = the door opens' }),
        );
        const take = mkBtn('take region', 'fill from the current marquee (drag one with V)');
        take.addEventListener('click', () => {
          const r = this.o.region();
          if (!r) {
            this.o.status('no region — drag one with the select tool first');
            return;
          }
          const tiles: Array<{ tx: number; ty: number; solid: boolean }> = [];
          for (let y = r.ty; y < r.ty + r.th; y++) {
            for (let x = r.tx; x < r.tx + r.tw; x++) tiles.push({ tx: x, ty: y, solid: false });
          }
          write({ type: 'setTiles', tiles });
          this.render();
        });
        host.appendChild(take);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ sound

  private soundSection(s: SoundEmitterDef): HTMLElement {
    const { root, body } = group('sound emitter');
    const id = s.id;
    const live = (): SoundEmitterDef => this.o.store.sound(id) ?? s;
    const patch = (p: Partial<SoundEmitterDef>): void => {
      this.o.store.run(updateItemCmd(this.o.store.level, 'sounds', id, p, 'edit emitter'), 'inspector');
    };
    this.add(
      body,
      textRow('id', () => live().id, (v) => {
        const next = v.trim();
        if (!next || next === id) return;
        patch({ id: next });
        this.o.store.select({ kind: 'sound', id: next });
      }),
    );
    this.add(body, selectRow('sound', SFX_NAMES, () => live().sound, (v) => patch({ sound: v as SfxName })));
    this.add(
      body,
      sliderRow('radius px', () => live().radiusPx, (v) => patch({ radiusPx: v }), {
        min: 8,
        max: 320,
        step: 4,
        hint: 'full volume at the centre, silent at the edge',
      }),
    );
    this.add(
      body,
      boolRow('loop', () => live().loop !== false, (v) => patch({ loop: v }), {
        hint: 'off = one shot, fired on entering the radius',
      }),
    );
    this.add(
      body,
      sliderRow('volume', () => live().volume ?? 1, (v) => patch({ volume: v }), { min: 0, max: 1, step: 0.05 }),
    );
    this.add(body, numRow('x', () => live().pos.x, (v) => patch({ pos: { x: v, y: live().pos.y } }), { min: 0, max: TILES_X * TILE }));
    this.add(body, numRow('y', () => live().pos.y, (v) => patch({ pos: { x: live().pos.x, y: v } }), { min: 0, max: TILES_Y * TILE }));
    return root;
  }
}

const ACTION_TYPES: Array<TriggerAction['type']> = [
  'say',
  'sfx',
  'wake',
  'spawn',
  'setTiles',
  'power',
  'hum',
  'shake',
  'light',
];

function defaultAction(type: TriggerAction['type']): TriggerAction {
  switch (type) {
    case 'say':
      return { type: 'say', line: 'ROBOT SEES SOMETHING' };
    case 'sfx':
      return { type: 'sfx', sound: 'alarm' };
    case 'wake':
      return { type: 'wake', target: '' };
    case 'spawn':
      return {
        type: 'spawn',
        entity: { id: 'spawned', kind: 'scrap', tx: 1, ty: 1 },
      };
    case 'setTiles':
      return { type: 'setTiles', tiles: [] };
    case 'power':
      return { type: 'power', target: 'elevB', on: true };
    case 'hum':
      return { type: 'hum', level: 0.5 };
    case 'shake':
      return { type: 'shake', ms: 400 };
    case 'light':
      return { type: 'light', target: '', on: false };
  }
}

/** Exported for the palette's tooltip text and the README's shortcut table. */
export const entityKindLabel = (k: EntityKind): string => kindInfo(k).label;
