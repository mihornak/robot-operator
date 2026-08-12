/**
 * GRAPHICS LAB — the tuning panel.
 *
 * Plain DOM over the canvas, no framework, no remote font (bundle law). The
 * renderer never talks to this file: the panel mutates `P` in place and calls
 * `onChange` so caches can be dropped. Everything the panel knows about a
 * param comes from `SCHEMA`, so adding a tunable is a one-line edit in
 * params.ts and it shows up here.
 */

import { DEFAULTS, GROUPS, P, PRESETS, SCHEMA, type ParamSpec, type Params } from './params';

export interface LabUiOptions {
  /** Called whenever any param changes (key + new value). Renderer uses it to invalidate caches. */
  onChange?: (key: keyof Params, value: number | boolean | string) => void;
  /** Called when the user asks for a fresh scene layout. */
  onReseed?: () => void;
}

export interface LabUi {
  /** Push a value the renderer changed itself back into the widgets. */
  sync(): void;
  /** Per-frame stats line. */
  setStats(text: string): void;
  destroy(): void;
}

/**
 * A param value. Selects store the option STRING, not its index — it costs
 * nothing here and it means `Copy TS` emits `lampStyle: 'dome'` rather than
 * `lampStyle: 1`, which is the difference between a pasteable default and a
 * magic number nobody can read six months later.
 */
type PVal = number | boolean | string;

const LS_PARAMS = 'robot-lab-params';
/** Debug toggles are never persisted, and never restored from an older save. */
const TRANSIENT_KEYS = new Set([
  'paused',
  'showLightmap',
  'showOccluders',
  'timeScale',
  // Layer switches are bisection tools. A persisted `layerWalls: false` looks
  // exactly like a rendering regression the next time the lab is opened.
  ...[
    'Floor', 'Walls', 'Props', 'Characters', 'PropShadows', 'BodyShadows',
    'Contact', 'Reflect', 'Rim', 'Emissive', 'Dust', 'Volume', 'Fog',
    'Lightmap', 'Masks',
  ].map((k) => `layer${k}`),
  'lmAmbient', 'lmLights', 'lmAo', 'lmShadowVolumes',
  'lmPropOccluders', 'lmFootprints', 'lmSpill',
]);
const LS_GROUPS = 'robot-lab-groups';
const LS_HIDDEN = 'robot-lab-hidden';

/** The three groups you actually reach for first; the rest start folded. */
const OPEN_BY_DEFAULT = ['Ambient', 'Lights', 'Shadows'];

const ACCENT = '#36e0b0';

/** `P` is a struct of number|boolean, so one indexed view serves every widget. */
const bag = P as unknown as Record<string, PVal>;
const defaultsBag = DEFAULTS as unknown as Record<string, PVal>;

const hexOf = (n: number): string => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const numOf = (hex: string): number => parseInt(hex.slice(1), 16) | 0;
/** Colours belong in params.ts as `0xffb774`, not as a decimal blob. */
const hexLit = (n: number): string => '0x' + (n & 0xffffff).toString(16).padStart(6, '0');

const specByKey = new Map<string, ParamSpec>(SCHEMA.map((s) => [s.key as string, s]));

/** Number boxes should read "0.42" and "5", never "0.4200000000000001". */
function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * The tuning loop ends with the numbers being pasted into `DEFAULTS`, so what
 * the user actually wants on the clipboard is the *diff* — the whole 70-key
 * dump is noise. Ordered by SCHEMA so it lines up with params.ts, rounded to
 * each param's own step so float dust never reaches the source.
 */
function tsPatch(): string {
  const lines: string[] = [];
  const emit = (key: string): void => {
    const v = bag[key];
    if (v === defaultsBag[key]) return;
    const spec = specByKey.get(key);
    let out: string;
    if (typeof v === 'boolean') out = String(v);
    else if (typeof v === 'string') out = `'${v}'`;
    else if (spec?.kind === 'color') out = hexLit(v);
    else {
      const step = spec?.step ?? 0.01;
      out = String(Number((Math.round(v / step) * step).toFixed(decimalsOf(step))));
    }
    lines.push(`  ${key}: ${out},`);
  };
  for (const spec of SCHEMA) emit(spec.key as string);
  for (const key of Object.keys(defaultsBag)) if (!specByKey.has(key)) emit(key); // widget-less keys still travel
  if (!lines.length) return '// no changes from DEFAULTS';
  return [`// ${lines.length} changed`, ...lines].join('\n');
}

function readStore<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStore(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — the lab still works, it just forgets. */
  }
}

const CSS = `
.rlab-root{position:fixed;top:0;right:0;width:320px;height:100%;z-index:99999;
  display:flex;flex-direction:column;box-sizing:border-box;
  font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  color:#c3d1de;background:rgba(9,14,22,.82);
  -webkit-backdrop-filter:blur(12px) saturate(1.25);backdrop-filter:blur(12px) saturate(1.25);
  border-left:1px solid rgba(54,224,176,.20);box-shadow:-14px 0 34px rgba(0,0,0,.45);
  -webkit-user-select:none;user-select:none;}
.rlab-root *{box-sizing:border-box;font:inherit;}
/* Safari honours an inherited user-select:none inside inputs — undo it there. */
.rlab-root input,.rlab-root select{-webkit-user-select:auto;user-select:auto;}
.rlab-hidden{display:none;}

.rlab-fab{position:fixed;top:10px;right:10px;z-index:99999;width:30px;height:30px;
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  font:14px/1 ui-monospace,monospace;color:${ACCENT};
  background:rgba(9,14,22,.8);border:1px solid rgba(54,224,176,.28);border-radius:6px;
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);}
.rlab-fab:hover{background:rgba(54,224,176,.16);}

.rlab-head{flex:0 0 auto;padding:8px 10px 7px;border-bottom:1px solid rgba(255,255,255,.07);
  background:rgba(6,10,16,.55);}
.rlab-titlerow{display:flex;align-items:center;gap:6px;margin-bottom:6px;}
.rlab-title{flex:1 1 auto;letter-spacing:.14em;font-size:11px;color:${ACCENT};text-shadow:0 0 10px rgba(54,224,176,.35);}
.rlab-btns{display:flex;flex-wrap:wrap;gap:4px;}
.rlab-btn{flex:1 1 auto;padding:4px 6px;cursor:pointer;color:#b9c8d6;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);border-radius:4px;
  font-size:10px;letter-spacing:.04em;white-space:nowrap;}
.rlab-btn:hover{background:rgba(54,224,176,.14);border-color:rgba(54,224,176,.4);color:#e6f4ee;}
.rlab-btn:active{transform:translateY(1px);}
.rlab-btn.rlab-ok{color:${ACCENT};border-color:rgba(54,224,176,.55);}
.rlab-btn:disabled{opacity:.3;cursor:default;}
.rlab-btn:disabled:hover{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.09);color:#b9c8d6;}
.rlab-btn:disabled:active{transform:none;}

.rlab-slots{display:flex;gap:4px;margin-top:4px;}
.rlab-slot{flex:0 0 auto;min-width:24px;}
.rlab-flip{flex:0 0 40px;}
/* Filled slot = accent outline; the slot currently driving P is filled solid. */
.rlab-btn.rlab-live{background:rgba(54,224,176,.22);color:#eafff8;border-color:rgba(54,224,176,.7);}

.rlab-select,.rlab-text{color:#dbe6f0;background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:3px 5px;font-size:11px;outline:none;}
.rlab-select:focus,.rlab-text:focus{border-color:rgba(54,224,176,.55);}
.rlab-select option{background:#0d1420;color:#dbe6f0;}
.rlab-preset{flex:0 0 128px;}
.rlab-search{width:100%;margin-top:6px;}
.rlab-stats{margin-top:6px;min-height:13px;font-size:10px;color:#7b8fa3;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

.rlab-body{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;padding-bottom:24px;}
.rlab-body::-webkit-scrollbar{width:8px;}
.rlab-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.13);border-radius:4px;}
.rlab-body::-webkit-scrollbar-track{background:transparent;}

.rlab-grp{border-bottom:1px solid rgba(255,255,255,.055);}
.rlab-grphead{display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;
  color:#8ea3b6;letter-spacing:.1em;text-transform:uppercase;font-size:10px;}
.rlab-grphead:hover{color:#d5e3ef;background:rgba(255,255,255,.03);}
.rlab-chev{width:8px;color:#5d7286;transition:transform .12s ease;}
.rlab-grp.rlab-open .rlab-chev{transform:rotate(90deg);color:${ACCENT};}
.rlab-count{margin-left:auto;font-size:9px;color:#4f6376;}
.rlab-grpbody{display:none;padding:1px 10px 7px;}
.rlab-grp.rlab-open .rlab-grpbody{display:block;}

.rlab-row{display:grid;grid-template-columns:1fr 104px 48px;align-items:center;
  column-gap:6px;padding:2px 0;min-height:20px;}
.rlab-row:hover{background:rgba(255,255,255,.03);}
.rlab-lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aebdcb;}
.rlab-hint{color:#55697c;cursor:help;}
.rlab-wide{grid-column:2 / 4;}
.rlab-num{width:48px;text-align:right;padding:2px 4px;font-size:10px;color:#dbe6f0;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:3px;outline:none;}
.rlab-num:focus{border-color:rgba(54,224,176,.55);background:rgba(54,224,176,.08);}
.rlab-num.rlab-mod{color:${ACCENT};}

.rlab-range{-webkit-appearance:none;appearance:none;width:100%;height:14px;background:transparent;outline:none;cursor:ew-resize;}
.rlab-range::-webkit-slider-runnable-track{height:3px;border-radius:2px;
  background:linear-gradient(to right,${ACCENT} 0 var(--rlab-fill,0%),rgba(255,255,255,.13) var(--rlab-fill,0%) 100%);}
.rlab-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:9px;height:9px;
  margin-top:-3px;border-radius:50%;background:${ACCENT};border:none;box-shadow:0 0 6px rgba(54,224,176,.5);}
.rlab-range::-moz-range-track{height:3px;border-radius:2px;background:rgba(255,255,255,.13);}
.rlab-range::-moz-range-progress{height:3px;border-radius:2px;background:${ACCENT};}
.rlab-range::-moz-range-thumb{width:9px;height:9px;border-radius:50%;background:${ACCENT};border:none;}

.rlab-tog{-webkit-appearance:none;appearance:none;width:26px;height:14px;border-radius:7px;
  justify-self:end;position:relative;cursor:pointer;outline:none;
  background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);transition:background .12s ease;}
.rlab-tog::after{content:"";position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:50%;
  background:#8ba0b3;transition:transform .12s ease,background .12s ease;}
.rlab-tog:checked{background:rgba(54,224,176,.3);border-color:rgba(54,224,176,.6);}
.rlab-tog:checked::after{transform:translateX(12px);background:${ACCENT};}

.rlab-swatch{-webkit-appearance:none;appearance:none;justify-self:end;width:46px;height:15px;padding:0;
  background:none;border:1px solid rgba(255,255,255,.16);border-radius:3px;cursor:pointer;}
.rlab-swatch::-webkit-color-swatch-wrapper{padding:1px;}
.rlab-swatch::-webkit-color-swatch{border:none;border-radius:2px;}
.rlab-swatch::-moz-color-swatch{border:none;border-radius:2px;}
.rlab-hex{text-align:right;font-size:10px;color:#7b8fa3;}

.rlab-empty{padding:10px;color:#5d7286;text-align:center;}
`;

interface Widget {
  spec: ParamSpec;
  row: HTMLElement;
  /** Re-read `P` into the DOM. */
  pull: () => void;
  haystack: string;
}

interface Group {
  name: string;
  section: HTMLElement;
  widgets: Widget[];
  countEl: HTMLElement;
}

export function createLabUi(opts: LabUiOptions = {}): LabUi {
  // Stored params win over DEFAULTS, but only key-by-key and only if the type
  // still matches — a renamed param must never poison the whole session.
  const stored = readStore<Record<string, unknown>>(LS_PARAMS);
  if (stored) {
    for (const key of Object.keys(stored)) {
      const value = stored[key];
      if (!(key in defaultsBag)) continue;
      if (TRANSIENT_KEYS.has(key)) continue; // never restore a debug toggle
      if (typeof value !== typeof defaultsBag[key]) continue;
      bag[key] = value as PVal;
    }
  }

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'rlab-root';

  const fab = document.createElement('button');
  fab.className = 'rlab-fab rlab-hidden';
  fab.textContent = '⚙';
  fab.title = 'show graphics lab (H)';

  // ------------------------------------------------------------------ header
  const head = document.createElement('div');
  head.className = 'rlab-head';

  const titleRow = document.createElement('div');
  titleRow.className = 'rlab-titlerow';
  const title = document.createElement('div');
  title.className = 'rlab-title';
  title.textContent = 'GRAPHICS LAB';
  const presetSel = document.createElement('select');
  presetSel.className = 'rlab-select rlab-preset';
  presetSel.title = 'preset ( [ / ] )';
  const presetNames = Object.keys(PRESETS);
  for (const name of presetNames) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    presetSel.appendChild(opt);
  }
  titleRow.append(title, presetSel);

  const btnRow = document.createElement('div');
  btnRow.className = 'rlab-btns';
  const slotRow = document.createElement('div');
  slotRow.className = 'rlab-slots';
  const mkBtn = (parent: HTMLElement, label: string, tip: string, cls = ''): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'rlab-btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.title = tip;
    parent.appendChild(b);
    return b;
  };
  const resetBtn = mkBtn(btnRow, 'Reset', 'back to DEFAULTS (R)');
  const copyBtn = mkBtn(btnRow, 'Copy JSON', 'every param, as JSON');
  const copyTsBtn = mkBtn(btnRow, 'Copy TS', 'only what differs from DEFAULTS, as pasteable TS');
  const reseedBtn = mkBtn(btnRow, 'Reseed', 'new scene layout');
  const slotABtn = mkBtn(slotRow, 'A', 'capture current look into slot A (1)', 'rlab-slot');
  const slotBBtn = mkBtn(slotRow, 'B', 'capture current look into slot B (2)', 'rlab-slot');
  const flipBtn = mkBtn(slotRow, 'A|B', 'flip between the two captures (\\)', 'rlab-flip');
  const clearBtn = mkBtn(slotRow, 'Clear saved', 'forget localStorage');
  const hideBtn = mkBtn(slotRow, 'Hide', 'collapse panel (H)');

  const search = document.createElement('input');
  search.className = 'rlab-text rlab-search';
  search.type = 'search';
  search.placeholder = 'filter…';

  const stats = document.createElement('div');
  stats.className = 'rlab-stats';

  head.append(titleRow, btnRow, slotRow, search, stats);

  const body = document.createElement('div');
  body.className = 'rlab-body';

  const empty = document.createElement('div');
  empty.className = 'rlab-empty rlab-hidden';
  empty.textContent = 'no params match';

  root.append(head, body, empty);

  // ------------------------------------------------------------- persistence
  /**
   * Debug toggles are inspection state, not a look, and they must never be
   * saved. A persisted `paused: true` is indistinguishable from a broken build
   * the next time the page is opened — which is exactly how it presented.
   */
  const TRANSIENT = TRANSIENT_KEYS;

  let saveTimer = 0;
  const queueSave = (): void => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const keep: Record<string, PVal> = {};
      for (const [k, v] of Object.entries(bag)) if (!TRANSIENT.has(k)) keep[k] = v;
      writeStore(LS_PARAMS, keep);
    }, 250);
  };

  const widgets: Widget[] = [];

  /** Single funnel for every mutation: write, notify, persist. */
  function set(key: keyof Params, value: PVal, silent = false): void {
    if (bag[key as string] === value) return;
    bag[key as string] = value;
    if (!silent) opts.onChange?.(key, value);
    queueSave();
  }

  /** Bulk apply (preset / reset). Fires onChange once per key that moved. */
  function applyAll(next: Record<string, PVal>): void {
    for (const key of Object.keys(defaultsBag)) {
      const v = key in next ? next[key] : defaultsBag[key];
      set(key as keyof Params, v);
    }
    syncAll();
  }

  // ----------------------------------------------------------------- widgets
  function addLabel(row: HTMLElement, spec: ParamSpec): void {
    const lbl = document.createElement('div');
    lbl.className = 'rlab-lbl';
    lbl.textContent = spec.label;
    if (spec.hint) {
      row.title = spec.hint;
      const q = document.createElement('span');
      q.className = 'rlab-hint';
      q.textContent = ' ?';
      lbl.appendChild(q);
    }
    row.appendChild(lbl);
  }

  function numWidget(spec: ParamSpec): Widget {
    const min = spec.min ?? 0;
    const max = spec.max ?? 1;
    const step = spec.step ?? 0.01;
    const dp = decimalsOf(step);

    const row = document.createElement('div');
    row.className = 'rlab-row';
    addLabel(row, spec);

    const range = document.createElement('input');
    range.className = 'rlab-range';
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);

    const box = document.createElement('input');
    box.className = 'rlab-num';
    box.type = 'text';
    box.inputMode = 'decimal';
    box.spellcheck = false;

    row.append(range, box);

    const paint = (v: number): void => {
      const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
      range.style.setProperty('--rlab-fill', `${pct}%`);
      // Highlight anything the user has moved off the tuned default.
      box.classList.toggle('rlab-mod', v !== (defaultsBag[spec.key as string] as number));
    };
    const pull = (): void => {
      const v = bag[spec.key as string] as number;
      range.value = String(v);
      if (document.activeElement !== box) box.value = v.toFixed(dp);
      paint(v);
    };

    range.addEventListener('input', () => {
      const v = Number(range.value);
      set(spec.key, v);
      box.value = v.toFixed(dp);
      paint(v);
    });
    const commit = (): void => {
      const raw = Number(box.value);
      const v = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : (bag[spec.key as string] as number);
      set(spec.key, v);
      range.value = String(v);
      box.value = v.toFixed(dp);
      paint(v);
    };
    box.addEventListener('blur', commit);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commit();
        box.blur();
      }
    });

    pull();
    return { spec, row, pull, haystack: `${spec.label} ${spec.key}`.toLowerCase() };
  }

  function boolWidget(spec: ParamSpec): Widget {
    const row = document.createElement('div');
    row.className = 'rlab-row';
    addLabel(row, spec);
    const spacer = document.createElement('div');
    const tog = document.createElement('input');
    tog.className = 'rlab-tog';
    tog.type = 'checkbox';
    row.append(spacer, tog);

    const pull = (): void => {
      tog.checked = bag[spec.key as string] as boolean;
    };
    tog.addEventListener('change', () => set(spec.key, tog.checked));
    pull();
    return { spec, row, pull, haystack: `${spec.label} ${spec.key}`.toLowerCase() };
  }

  function colorWidget(spec: ParamSpec): Widget {
    const row = document.createElement('div');
    row.className = 'rlab-row';
    addLabel(row, spec);
    const hex = document.createElement('div');
    hex.className = 'rlab-hex';
    const swatch = document.createElement('input');
    swatch.className = 'rlab-swatch';
    swatch.type = 'color';
    row.append(hex, swatch);

    const pull = (): void => {
      const s = hexOf(bag[spec.key as string] as number);
      swatch.value = s;
      hex.textContent = s;
    };
    swatch.addEventListener('input', () => {
      set(spec.key, numOf(swatch.value));
      hex.textContent = swatch.value;
    });
    pull();
    return { spec, row, pull, haystack: `${spec.label} ${spec.key}`.toLowerCase() };
  }

  function selectWidget(spec: ParamSpec): Widget {
    const row = document.createElement('div');
    row.className = 'rlab-row';
    addLabel(row, spec);
    const sel = document.createElement('select');
    sel.className = 'rlab-select rlab-wide';
    const options = spec.options ?? [];
    options.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    row.appendChild(sel);

    const pull = (): void => {
      sel.value = String(bag[spec.key as string] ?? '');
    };
    sel.addEventListener('change', () => set(spec.key, sel.value));
    pull();
    return {
      spec,
      row,
      pull,
      haystack: `${spec.label} ${spec.key} ${options.join(' ')}`.toLowerCase(),
    };
  }

  function build(spec: ParamSpec): Widget {
    switch (spec.kind) {
      case 'bool':
        return boolWidget(spec);
      case 'color':
        return colorWidget(spec);
      case 'select':
        return selectWidget(spec);
      default:
        return numWidget(spec);
    }
  }

  // ------------------------------------------------------------------ groups
  const openState = readStore<Record<string, boolean>>(LS_GROUPS) ?? {};
  const groups: Group[] = [];

  for (const name of GROUPS) {
    const section = document.createElement('div');
    section.className = 'rlab-grp';

    const header = document.createElement('div');
    header.className = 'rlab-grphead';
    const chev = document.createElement('span');
    chev.className = 'rlab-chev';
    chev.textContent = '▶';
    const label = document.createElement('span');
    label.textContent = name;
    const countEl = document.createElement('span');
    countEl.className = 'rlab-count';
    header.append(chev, label, countEl);

    const grpBody = document.createElement('div');
    grpBody.className = 'rlab-grpbody';

    const mine = SCHEMA.filter((s) => s.group === name);
    const built = mine.map(build);
    for (const w of built) grpBody.appendChild(w.row);
    widgets.push(...built);
    countEl.textContent = String(built.length);

    const open = openState[name] ?? OPEN_BY_DEFAULT.includes(name);
    section.classList.toggle('rlab-open', open);

    header.addEventListener('click', () => {
      // While filtering, groups are force-opened; clicking then would fight the
      // filter, so the toggle only edits the remembered state when idle.
      const next = !section.classList.contains('rlab-open');
      openState[name] = next;
      writeStore(LS_GROUPS, openState);
      section.classList.toggle('rlab-open', next);
    });

    section.append(header, grpBody);
    body.appendChild(section);
    groups.push({ name, section, widgets: built, countEl });
  }

  function syncAll(): void {
    for (const w of widgets) w.pull();
  }

  // ------------------------------------------------------------------ filter
  function applyFilter(): void {
    const q = search.value.trim().toLowerCase();
    let total = 0;
    for (const g of groups) {
      let shown = 0;
      for (const w of g.widgets) {
        const hit = !q || w.haystack.includes(q);
        w.row.classList.toggle('rlab-hidden', !hit);
        if (hit) shown++;
      }
      g.countEl.textContent = q ? `${shown}/${g.widgets.length}` : String(g.widgets.length);
      g.section.classList.toggle('rlab-hidden', q !== '' && shown === 0);
      if (q) g.section.classList.add('rlab-open');
      else g.section.classList.toggle('rlab-open', openState[g.name] ?? OPEN_BY_DEFAULT.includes(g.name));
      total += shown;
    }
    empty.classList.toggle('rlab-hidden', total > 0);
  }
  search.addEventListener('input', applyFilter);
  applyFilter();

  // ------------------------------------------------------------------ header
  // actions
  let presetIdx = 0;
  function applyPreset(i: number): void {
    presetIdx = (i + presetNames.length) % presetNames.length;
    const name = presetNames[presetIdx];
    presetSel.value = name;
    applyAll({ ...defaultsBag, ...(PRESETS[name] as Record<string, PVal>) });
  }
  presetSel.addEventListener('change', () => applyPreset(presetNames.indexOf(presetSel.value)));

  resetBtn.addEventListener('click', () => {
    presetIdx = 0;
    presetSel.value = presetNames[0];
    applyAll({ ...defaultsBag });
  });
  reseedBtn.addEventListener('click', () => opts.onReseed?.());

  const flashTimers = new Map<HTMLButtonElement, number>();
  /** Confirm in place — a toast would cover the thing being tuned. */
  function flash(btn: HTMLButtonElement, msg: string, restore: string): void {
    btn.textContent = msg;
    btn.classList.add('rlab-ok');
    clearTimeout(flashTimers.get(btn));
    flashTimers.set(
      btn,
      window.setTimeout(() => {
        btn.textContent = restore;
        btn.classList.remove('rlab-ok');
      }, 1100),
    );
  }

  function toClipboard(text: string): void {
    void navigator.clipboard?.writeText(text).catch(() => {
      /* clipboard denied (insecure origin) — the text still lands in the log. */
      console.log(text);
    });
  }

  copyBtn.addEventListener('click', () => {
    toClipboard(JSON.stringify(P, null, 2));
    flash(copyBtn, 'copied!', 'Copy JSON');
  });
  copyTsBtn.addEventListener('click', () => {
    toClipboard(tsPatch());
    flash(copyTsBtn, 'copied!', 'Copy TS');
  });

  clearBtn.addEventListener('click', () => {
    try {
      localStorage.removeItem(LS_PARAMS);
      localStorage.removeItem(LS_GROUPS);
      localStorage.removeItem(LS_HIDDEN);
    } catch {
      /* nothing to clear */
    }
    flash(clearBtn, 'cleared', 'Clear saved');
  });

  // A/B captures. Two looks can only be judged by flipping between them on the
  // same frame — comparing the current render against a memory never works.
  // In-memory on purpose: a slot is a scratch comparison, not a saved preset.
  const slots: { A: Record<string, PVal> | null; B: Record<string, PVal> | null } = { A: null, B: null };
  let live: 'A' | 'B' | null = null;

  function paintSlots(): void {
    slotABtn.classList.toggle('rlab-ok', slots.A !== null);
    slotBBtn.classList.toggle('rlab-ok', slots.B !== null);
    slotABtn.classList.toggle('rlab-live', live === 'A');
    slotBBtn.classList.toggle('rlab-live', live === 'B');
    const both = slots.A !== null && slots.B !== null;
    flipBtn.disabled = !both;
    // Lowercase marks the slot you are not looking at.
    flipBtn.textContent = both && live ? (live === 'A' ? 'A|b' : 'a|B') : 'A|B';
  }

  function capture(which: 'A' | 'B'): void {
    slots[which] = { ...bag };
    live = which;
    paintSlots();
  }

  function flip(): void {
    const a = slots.A;
    const b = slots.B;
    if (!a || !b) return;
    live = live === 'A' ? 'B' : 'A';
    applyAll(live === 'A' ? a : b);
    paintSlots();
  }

  slotABtn.addEventListener('click', () => capture('A'));
  slotBBtn.addEventListener('click', () => capture('B'));
  flipBtn.addEventListener('click', flip);
  paintSlots();

  let hidden = readStore<boolean>(LS_HIDDEN) ?? false;
  function setHidden(next: boolean): void {
    hidden = next;
    root.classList.toggle('rlab-hidden', hidden);
    fab.classList.toggle('rlab-hidden', !hidden);
    writeStore(LS_HIDDEN, hidden);
  }
  hideBtn.addEventListener('click', () => setHidden(true));
  fab.addEventListener('click', () => setHidden(false));
  setHidden(hidden);

  // --------------------------------------------------------------- keyboard
  const typing = (el: EventTarget | null): boolean => {
    const tag = (el as HTMLElement | null)?.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing(e.target)) {
      // Typing in the panel must never also drive the game underneath.
      e.stopPropagation();
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    switch (e.key) {
      case 'h':
      case 'H':
        setHidden(!hidden);
        break;
      case 'r':
      case 'R':
        applyAll({ ...defaultsBag });
        break;
      case '[':
        applyPreset(presetIdx - 1);
        break;
      case ']':
        applyPreset(presetIdx + 1);
        break;
      case '1':
        capture('A');
        break;
      case '2':
        capture('B');
        break;
      case '\\':
        flip();
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey, true);

  // Wheel over the panel scrolls the panel, never the page/camera behind it.
  const onWheel = (e: WheelEvent): void => e.stopPropagation();
  root.addEventListener('wheel', onWheel, { passive: true });

  document.body.append(root, fab);

  return {
    sync: syncAll,
    setStats(text: string) {
      stats.textContent = text;
    },
    destroy() {
      clearTimeout(saveTimer);
      for (const t of flashTimers.values()) clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
      root.removeEventListener('wheel', onWheel);
      root.remove();
      fab.remove();
      style.remove();
    },
  };
}
