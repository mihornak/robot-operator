/**
 * LEVEL DESIGNER — the widget kit and the page chrome.
 *
 * Plain DOM, no framework, no remote font (bundle law). Same shape as
 * `lab/ui.ts` — a factory per widget kind, each returning a row plus a `pull()`
 * that re-reads the model into the DOM — but deliberately a COPY rather than an
 * import: the lab is a research surface that is allowed to churn, and a shared
 * widget file would tie the designer's chrome to it.
 *
 * Every widget is get/set over a closure rather than a bound key, because the
 * designer's model is a tree (level → entity → trigger → action) and there is no
 * flat param bag to index.
 */

export const AMBER = '#ffb000';
export const AMBER_DIM = '#b87f00';

/** Widget contract: a row in the panel, and a way to re-read the model. */
export interface Widget {
  row: HTMLElement;
  pull(): void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mkBtn(label: string, title = '', cls = ''): HTMLButtonElement {
  const b = el('button', 'rd-btn' + (cls ? ' ' + cls : ''), label);
  if (title) b.title = title;
  return b;
}

function labelled(label: string, hint?: string): HTMLElement {
  const row = el('div', 'rd-row');
  const lbl = el('div', 'rd-lbl', label);
  if (hint) {
    row.title = hint;
    lbl.appendChild(el('span', 'rd-hint', ' ?'));
  }
  row.appendChild(lbl);
  return row;
}

/** Number boxes should read "0.4" and "5", never "0.4000000000000001". */
function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

export function textRow(
  label: string,
  get: () => string,
  set: (v: string) => void,
  opts: { hint?: string; placeholder?: string } = {},
): Widget {
  const row = labelled(label, opts.hint);
  const input = el('input', 'rd-text rd-wide') as HTMLInputElement;
  input.type = 'text';
  input.spellcheck = false;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  row.appendChild(input);
  // Committed on blur/Enter, never on every keystroke: each commit is an undo
  // entry, and a per-character undo stack is a stack nobody can walk back.
  const commit = (): void => {
    if (input.value !== get()) set(input.value);
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = get();
      input.blur();
    }
  });
  const pull = (): void => {
    if (document.activeElement !== input) input.value = get();
  };
  pull();
  return { row, pull };
}

export function numRow(
  label: string,
  get: () => number,
  set: (v: number) => void,
  opts: { min?: number; max?: number; step?: number; hint?: string } = {},
): Widget {
  const min = opts.min ?? -9999;
  const max = opts.max ?? 9999;
  const step = opts.step ?? 1;
  const dp = decimalsOf(step);
  const row = labelled(label, opts.hint);
  const input = el('input', 'rd-text rd-wide') as HTMLInputElement;
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  row.appendChild(input);
  const commit = (): void => {
    const raw = Number(input.value);
    const v = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : get();
    if (v !== get()) set(v);
    input.value = v.toFixed(dp);
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  const pull = (): void => {
    if (document.activeElement !== input) input.value = get().toFixed(dp);
  };
  pull();
  return { row, pull };
}

/**
 * A number box that can also be EMPTY, and where empty is a real answer rather
 * than a zero waiting to happen.
 *
 * `numRow` clamps whatever it is given into range, which is right for a spawn
 * coordinate and wrong for a field whose absence is the normal case: typed
 * blank, a plain number box commits `Number('') === 0`, and a level that meant
 * "append me" silently claims floor slot 0.
 */
export function optNumRow(
  label: string,
  get: () => number | null,
  set: (v: number | null) => void,
  opts: { min?: number; max?: number; hint?: string; placeholder?: string } = {},
): Widget {
  const min = opts.min ?? -9999;
  const max = opts.max ?? 9999;
  const row = labelled(label, opts.hint);
  const input = el('input', 'rd-text rd-wide') as HTMLInputElement;
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  row.appendChild(input);
  const commit = (): void => {
    const raw = input.value.trim();
    if (raw === '') {
      if (get() !== null) set(null);
      input.value = '';
      return;
    }
    const n = Number(raw);
    const v = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : get();
    if (v !== get()) set(v);
    input.value = v === null ? '' : String(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  const pull = (): void => {
    if (document.activeElement !== input) {
      const v = get();
      input.value = v === null ? '' : String(v);
    }
  };
  pull();
  return { row, pull };
}

export function sliderRow(
  label: string,
  get: () => number,
  set: (v: number) => void,
  opts: { min: number; max: number; step: number; hint?: string },
): Widget {
  const row = labelled(label, opts.hint);
  const range = el('input', 'rd-range') as HTMLInputElement;
  range.type = 'range';
  range.min = String(opts.min);
  range.max = String(opts.max);
  range.step = String(opts.step);
  const box = el('div', 'rd-num');
  row.append(range, box);
  const dp = decimalsOf(opts.step);
  const paint = (v: number): void => {
    const pct = opts.max > opts.min ? ((v - opts.min) / (opts.max - opts.min)) * 100 : 0;
    range.style.setProperty('--rd-fill', `${pct}%`);
    box.textContent = v.toFixed(dp);
  };
  range.addEventListener('input', () => {
    const v = Number(range.value);
    set(v);
    paint(v);
  });
  const pull = (): void => {
    const v = get();
    range.value = String(v);
    paint(v);
  };
  pull();
  return { row, pull };
}

export function selectRow(
  label: string,
  options: readonly string[],
  get: () => string,
  set: (v: string) => void,
  opts: { hint?: string; labels?: Record<string, string> } = {},
): Widget {
  const row = labelled(label, opts.hint);
  const sel = el('select', 'rd-select rd-wide') as HTMLSelectElement;
  for (const name of options) {
    const opt = el('option');
    opt.value = name;
    opt.textContent = opts.labels?.[name] ?? name;
    sel.appendChild(opt);
  }
  row.appendChild(sel);
  sel.addEventListener('change', () => set(sel.value));
  const pull = (): void => {
    sel.value = get();
  };
  pull();
  return { row, pull };
}

/**
 * A colour, as the 0xRRGGBB number every lit field stores.
 *
 * Two controls on one row on purpose: the swatch is how you FIND a colour and
 * the hex box is how you MATCH one — a light that has to be the same red as the
 * strobe beside it is typed, not eyedroppered.
 */
export function colorRow(
  label: string,
  get: () => number,
  set: (v: number) => void,
  opts: { hint?: string } = {},
): Widget {
  const row = labelled(label, opts.hint);
  const pick = el('input', 'rd-color') as HTMLInputElement;
  pick.type = 'color';
  const text = el('input', 'rd-text rd-hex') as HTMLInputElement;
  text.type = 'text';
  text.spellcheck = false;
  row.append(pick, text);
  const hex = (v: number): string => '#' + (v >>> 0).toString(16).padStart(6, '0');
  pick.addEventListener('input', () => {
    const v = parseInt(pick.value.slice(1), 16);
    if (Number.isFinite(v)) set(v);
    text.value = pick.value;
  });
  const commit = (): void => {
    const raw = text.value.trim().replace(/^#/, '');
    const v = parseInt(raw, 16);
    if (raw.length === 6 && Number.isFinite(v)) set(v);
    text.value = hex(get());
    pick.value = text.value;
  };
  text.addEventListener('change', commit);
  text.addEventListener('blur', commit);
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') text.blur();
  });
  const pull = (): void => {
    const h = hex(get());
    pick.value = h;
    if (document.activeElement !== text) text.value = h;
  };
  pull();
  return { row, pull };
}

/** A strip of one-click colours — the lit palette's emissive ramp, mostly. */
export function swatchStrip(
  colors: ReadonlyArray<{ name: string; value: number }>,
  set: (v: number) => void,
): HTMLElement {
  const strip = el('div', 'rd-swatches');
  for (const c of colors) {
    const b = el('button', 'rd-sw');
    b.title = c.name;
    b.style.background = '#' + (c.value >>> 0).toString(16).padStart(6, '0');
    b.addEventListener('click', () => set(c.value));
    strip.appendChild(b);
  }
  return strip;
}

export function boolRow(
  label: string,
  get: () => boolean,
  set: (v: boolean) => void,
  opts: { hint?: string } = {},
): Widget {
  const row = labelled(label, opts.hint);
  row.appendChild(el('div'));
  const tog = el('input', 'rd-tog') as HTMLInputElement;
  tog.type = 'checkbox';
  row.appendChild(tog);
  tog.addEventListener('change', () => set(tog.checked));
  const pull = (): void => {
    tog.checked = get();
  };
  pull();
  return { row, pull };
}

/** A section with a heading, for the inspector. */
export function group(title: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('div', 'rd-grp');
  root.appendChild(el('div', 'rd-grphead', title));
  const body = el('div', 'rd-grpbody');
  root.appendChild(body);
  return { root, body };
}

const flashTimers = new Map<HTMLButtonElement, number>();

/** Confirm in place — a toast would cover the room being edited. */
export function flash(btn: HTMLButtonElement, msg: string, restore: string): void {
  btn.textContent = msg;
  btn.classList.add('rd-ok');
  clearTimeout(flashTimers.get(btn));
  flashTimers.set(
    btn,
    window.setTimeout(() => {
      btn.textContent = restore;
      btn.classList.remove('rd-ok');
    }, 1200),
  );
}

export function toClipboard(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {
    // Clipboard denied (insecure origin) — the text still lands in the log,
    // which is the only copy path a file:// or plain-http page ever has.
    console.log(text);
  });
}

/** True when the event target is a field, so shortcuts must keep their hands off. */
export function typing(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

const CSS = `
:root{color-scheme:dark;}
html,body{margin:0;height:100%;background:#0a0c10;overflow:hidden;
  font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  color:#c3d1de;-webkit-font-smoothing:antialiased;}
*{box-sizing:border-box;}
button,input,select,textarea{font:inherit;}

#rd-app{position:fixed;inset:0;display:grid;
  grid-template-rows:auto 1fr auto;grid-template-columns:186px 1fr 316px;
  grid-template-areas:"top top top" "left center right" "status status status";}
#rd-top{grid-area:top;display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  padding:5px 8px;background:#0d1119;border-bottom:1px solid rgba(255,176,0,.18);}
#rd-left{grid-area:left;overflow-y:auto;background:#0c0f15;
  border-right:1px solid rgba(255,255,255,.07);}
#rd-center{grid-area:center;position:relative;overflow:hidden;background:#05070a;}
#rd-center canvas{display:block;image-rendering:pixelated;outline:none;}
#rd-right{grid-area:right;display:flex;flex-direction:column;background:#0c0f15;
  border-left:1px solid rgba(255,255,255,.07);min-height:0;}
#rd-status{grid-area:status;display:flex;align-items:center;gap:14px;padding:3px 8px;
  background:#0d1119;border-top:1px solid rgba(255,255,255,.07);color:#7b8fa3;
  font-size:10px;white-space:nowrap;overflow:hidden;}
#rd-status .rd-sok{color:#36e0b0;}
#rd-status .rd-swarn{color:${AMBER};}
#rd-status .rd-serr{color:#ff7b72;}

.rd-title{letter-spacing:.14em;color:${AMBER};text-shadow:0 0 10px rgba(255,176,0,.3);
  margin-right:4px;}
.rd-sep{width:1px;height:16px;background:rgba(255,255,255,.12);margin:0 2px;}
.rd-btn{padding:3px 7px;cursor:pointer;color:#b9c8d6;background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.1);border-radius:4px;font-size:10px;
  letter-spacing:.04em;white-space:nowrap;}
.rd-btn:hover{background:rgba(255,176,0,.14);border-color:rgba(255,176,0,.42);color:#ffe6b8;}
.rd-btn:active{transform:translateY(1px);}
.rd-btn.rd-on{background:rgba(255,176,0,.2);color:#ffe6b8;border-color:rgba(255,176,0,.6);}
.rd-btn.rd-ok{color:#36e0b0;border-color:rgba(54,224,176,.55);}
.rd-btn:disabled{opacity:.32;cursor:default;}
.rd-btn:disabled:hover{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);color:#b9c8d6;}

.rd-select,.rd-text{color:#dbe6f0;background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:2px 5px;font-size:10px;outline:none;}
.rd-select:focus,.rd-text:focus{border-color:rgba(255,176,0,.55);}
.rd-select option{background:#0d1420;color:#dbe6f0;}
textarea.rd-text{width:100%;height:120px;resize:vertical;}

.rd-row{display:grid;grid-template-columns:82px 1fr 44px;align-items:center;
  column-gap:6px;padding:2px 0;min-height:20px;}
.rd-row:hover{background:rgba(255,255,255,.03);}
.rd-lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aebdcb;font-size:10px;}
.rd-hint{color:#55697c;cursor:help;}
.rd-wide{grid-column:2 / 4;width:100%;}
.rd-num{text-align:right;font-size:10px;color:#dbe6f0;}
.rd-range{-webkit-appearance:none;appearance:none;width:100%;height:14px;background:transparent;
  outline:none;cursor:ew-resize;}
.rd-range::-webkit-slider-runnable-track{height:3px;border-radius:2px;
  background:linear-gradient(to right,${AMBER} 0 var(--rd-fill,0%),rgba(255,255,255,.13) var(--rd-fill,0%) 100%);}
.rd-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:9px;height:9px;
  margin-top:-3px;border-radius:50%;background:${AMBER};border:none;}
.rd-range::-moz-range-track{height:3px;border-radius:2px;background:rgba(255,255,255,.13);}
.rd-range::-moz-range-progress{height:3px;border-radius:2px;background:${AMBER};}
.rd-range::-moz-range-thumb{width:9px;height:9px;border-radius:50%;background:${AMBER};border:none;}
.rd-tog{-webkit-appearance:none;appearance:none;width:26px;height:14px;border-radius:7px;
  justify-self:end;position:relative;cursor:pointer;outline:none;
  background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);}
.rd-tog::after{content:"";position:absolute;top:1px;left:1px;width:10px;height:10px;
  border-radius:50%;background:#8ba0b3;transition:transform .12s ease;}
.rd-tog:checked{background:rgba(255,176,0,.3);border-color:rgba(255,176,0,.6);}
.rd-tog:checked::after{transform:translateX(12px);background:${AMBER};}

.rd-color{grid-column:2;width:100%;height:16px;padding:0;cursor:pointer;
  background:transparent;border:1px solid rgba(255,255,255,.15);border-radius:3px;}
.rd-color::-webkit-color-swatch-wrapper{padding:1px;}
.rd-color::-webkit-color-swatch{border:none;border-radius:2px;}
input.rd-hex{grid-column:3;width:100%;text-align:right;padding:2px 3px;}
.rd-swatches{display:flex;flex-wrap:wrap;gap:3px;padding:3px 0 5px;}
.rd-sw{width:15px;height:15px;border-radius:3px;cursor:pointer;padding:0;
  border:1px solid rgba(255,255,255,.22);}
.rd-sw:hover{border-color:${AMBER};transform:translateY(-1px);}

.rd-grp{border-bottom:1px solid rgba(255,255,255,.06);}
.rd-grphead{padding:5px 8px;color:#8ea3b6;letter-spacing:.1em;text-transform:uppercase;
  font-size:9px;background:rgba(255,255,255,.02);}
.rd-grpbody{padding:3px 8px 7px;}

/* ------------------------------------------------------------ left palette */
.rd-secthead{padding:6px 8px 3px;color:#8ea3b6;letter-spacing:.1em;text-transform:uppercase;
  font-size:9px;}
.rd-tools{display:grid;grid-template-columns:1fr 1fr;gap:3px;padding:0 6px 6px;}
.rd-assets{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:0 6px 10px;}
.rd-asset{display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 2px;
  cursor:pointer;border:1px solid rgba(255,255,255,.08);border-radius:4px;
  background:rgba(255,255,255,.03);}
.rd-asset:hover{border-color:rgba(255,176,0,.45);background:rgba(255,176,0,.1);}
.rd-asset.rd-on{border-color:${AMBER};background:rgba(255,176,0,.18);}
.rd-asset canvas,.rd-asset .rd-swatch{image-rendering:pixelated;height:26px;width:auto;
  max-width:64px;object-fit:contain;}
.rd-asset .rd-swatch{width:22px;border:1px solid rgba(255,255,255,.2);}
.rd-asset span{font-size:8.5px;color:#9fb0be;text-align:center;line-height:1.15;
  overflow:hidden;text-overflow:ellipsis;max-width:100%;}
.rd-asset.rd-on span{color:#ffe6b8;}
.rd-pages{display:flex;gap:2px;padding:5px 6px 3px;}
.rd-page{flex:1 1 0;padding:3px 1px;text-align:center;cursor:pointer;font-size:9px;
  letter-spacing:.06em;color:#8ea3b6;background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.09);border-radius:3px;}
.rd-page:hover{color:#d5e3ef;background:rgba(255,255,255,.08);}
.rd-page.rd-on{color:${AMBER};border-color:rgba(255,176,0,.55);background:rgba(255,176,0,.14);}
.rd-pagebody.rd-hidden{display:none;}
/* Decor thumbnails run three-up: 33 props at two-up is a scroll nobody reads. */
.rd-decor{display:grid;grid-template-columns:1fr 1fr 1fr;gap:3px;padding:0 6px 10px;}
.rd-decor .rd-asset{padding:3px 1px;gap:1px;}
.rd-decor .rd-asset canvas{height:auto;width:auto;max-height:30px;max-width:100%;}
.rd-decor .rd-asset span{font-size:7.5px;line-height:1.1;}
.rd-note{padding:0 8px 8px;color:#5d7286;font-size:9px;line-height:1.35;}
.rd-rowbar{display:grid;grid-template-columns:repeat(8,1fr);gap:2px;padding:2px 0 5px;}
.rd-rowbar .rd-btn{padding:2px 0;text-align:center;}

/* --------------------------------------------------------- right: tabs etc */
.rd-tabs{display:flex;flex:0 0 auto;border-bottom:1px solid rgba(255,255,255,.08);}
.rd-tab{flex:1 1 0;padding:5px 4px;text-align:center;cursor:pointer;font-size:10px;
  color:#8ea3b6;letter-spacing:.08em;background:transparent;border:none;}
.rd-tab:hover{color:#d5e3ef;background:rgba(255,255,255,.04);}
.rd-tab.rd-on{color:${AMBER};box-shadow:inset 0 -2px 0 ${AMBER};}
.rd-pane{flex:1 1 auto;overflow-y:auto;min-height:0;}
.rd-pane.rd-hidden{display:none;}
.rd-empty{padding:12px 10px;color:#5d7286;text-align:center;font-size:10px;}

.rd-act{border:1px solid rgba(255,255,255,.09);border-radius:4px;margin:4px 0;
  background:rgba(255,255,255,.03);}
.rd-acthead{display:flex;align-items:center;gap:4px;padding:3px 4px;
  border-bottom:1px solid rgba(255,255,255,.07);}
.rd-acthead .rd-select{flex:1 1 auto;}
.rd-actbody{padding:2px 5px 5px;}
.rd-mini{padding:1px 5px;font-size:10px;line-height:1.1;}

.rd-find{display:flex;gap:6px;padding:4px 8px;cursor:pointer;
  border-bottom:1px solid rgba(255,255,255,.05);font-size:10px;line-height:1.35;}
.rd-find:hover{background:rgba(255,176,0,.09);}
.rd-find .rd-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;margin-top:5px;}
.rd-err .rd-dot{background:#ff7b72;}
.rd-warn .rd-dot{background:${AMBER};}
.rd-err{color:#f3b3ae;}
.rd-warn{color:#d9c69a;}
.rd-pass{padding:10px;color:#36e0b0;text-align:center;}

.rd-pane::-webkit-scrollbar,#rd-left::-webkit-scrollbar{width:8px;}
.rd-pane::-webkit-scrollbar-thumb,#rd-left::-webkit-scrollbar-thumb{
  background:rgba(255,255,255,.13);border-radius:4px;}

/* ------------------------------------------------------------------ modal */
.rd-modal{position:fixed;inset:0;z-index:50;display:flex;align-items:center;
  justify-content:center;background:rgba(3,5,8,.72);}
.rd-card{width:min(560px,90vw);padding:12px;background:#0d1119;border-radius:6px;
  border:1px solid rgba(255,176,0,.28);box-shadow:0 18px 44px rgba(0,0,0,.6);}
.rd-card h2{margin:0 0 8px;font-size:11px;letter-spacing:.12em;color:${AMBER};font-weight:400;}
.rd-cardrow{display:flex;gap:6px;justify-content:flex-end;margin-top:8px;}
.rd-carderr{color:#ff7b72;min-height:14px;margin-top:4px;font-size:10px;}
`;

let injected = false;

export function injectCss(): void {
  if (injected) return;
  injected = true;
  const style = el('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * A modal with a textarea — import-from-paste and nothing else so far. Returns
 * the entered text, or null when dismissed.
 */
export function promptText(title: string, placeholder: string): Promise<string | null> {
  return new Promise((resolve) => {
    const back = el('div', 'rd-modal');
    const card = el('div', 'rd-card');
    const h = el('h2', undefined, title);
    const area = el('textarea', 'rd-text') as HTMLTextAreaElement;
    area.placeholder = placeholder;
    area.spellcheck = false;
    const err = el('div', 'rd-carderr');
    const row = el('div', 'rd-cardrow');
    const cancel = mkBtn('Cancel');
    const ok = mkBtn('Import', '', 'rd-on');
    row.append(cancel, ok);
    card.append(h, area, err, row);
    back.appendChild(card);
    document.body.appendChild(back);
    area.focus();

    const close = (value: string | null): void => {
      back.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', () => close(area.value));
    back.addEventListener('mousedown', (e) => {
      if (e.target === back) close(null);
    });
  });
}
