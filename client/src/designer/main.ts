/**
 * LEVEL DESIGNER entry point (`/designer.html`).
 *
 * The whole design is one sentence: draw the room in the REAL renderer. The
 * page boots the game's own `initArt` + `WorldView` and hands them a `SimState`
 * built from the draft, so what is on the canvas is what the player will see —
 * not an approximation drawn by a second, slowly-diverging tool. Editing chrome
 * is DOM around the canvas and one overlay layer inside it.
 *
 * There are TWO real renderers now, and which one you get is the level's own
 * answer: a draft carrying any lit data (decor, lights, water, a look) draws
 * through `render/lit`'s `LitScene`, exactly as the game will; a draft carrying
 * none draws through `WorldView`, exactly as it always did. `L` cycles lit →
 * flat → lightmap, and the flat view is kept honest rather than kept for
 * nostalgia: it is the only way to see the walkability grid you are painting
 * once the room is properly dark.
 *
 * Pixi v8 boot order matters and is not negotiable: nearest FIRST (so no texture
 * is ever created with the wrong filter), `new Application()` and then
 * `await app.init()`, then `initArt()`, then the views.
 */

import { Application, Container, TextureStyle } from 'pixi.js';
import type { LevelData, RenderView, SimState } from '@shared/types';
import { TILE, TILES_X, TILES_Y } from '@shared/types';
import { initArt } from '../art/index';
import { WorldView } from '../render/world';
import { buildSolid } from '../sim/floors';
import { levelToFloorDef } from '../sim/levelLoader';
import { initialState } from '../sim/index';
import { DesignerOverlays } from './overlays';
import { Inspector } from './inspector';
import { createPalette } from './palette';
import { Playtest, blankUi } from './playtest';
import { ValidationPanel, type Focus } from './validation';
import { Tools, type Camera } from './tools';
import { LitPreview, MODE_LABEL, type PreviewMode } from './litPreview';
import { actorStates } from './litActors';
import { LookPanel } from './look';
import {
  DraftStore,
  clearDraft,
  hasLit,
  loadLevelCmd,
  restoreDraft,
  type ChangeInfo,
} from './store';
import {
  levelChoices,
  levelFor,
  levelSource,
  listCustomIds,
  newLevel,
  parseLevelSource,
  saveLevel,
} from './io';
import { el, flash, injectCss, mkBtn, promptText, toClipboard, typing } from './ui';

async function boot(): Promise<void> {
  injectCss();

  // ------------------------------------------------------------------ DOM
  const root = el('div');
  root.id = 'rd-app';
  const top = el('div');
  top.id = 'rd-top';
  const left = el('div');
  left.id = 'rd-left';
  const center = el('div');
  center.id = 'rd-center';
  const right = el('div');
  right.id = 'rd-right';
  const status = el('div');
  status.id = 'rd-status';
  root.append(top, left, center, right, status);
  document.body.appendChild(root);

  const sTile = el('span', undefined, '—');
  const sTool = el('span', undefined, '');
  const sZoom = el('span', undefined, '');
  const sMsg = el('span', undefined, 'ready');
  const sVal = el('span', undefined, '');
  status.append(sTile, sTool, sZoom, sMsg, sVal);
  const say = (msg: string): void => {
    sMsg.textContent = msg;
  };

  // ----------------------------------------------------------------- pixi
  TextureStyle.defaultOptions.scaleMode = 'nearest';
  const app = new Application();
  await app.init({
    preference: 'webgl',
    antialias: false,
    background: '#05070a',
    resolution: 1,
    autoStart: false,
  });
  center.appendChild(app.canvas);

  const art = await initArt();
  const world = new WorldView(art);
  const overlays = new DesignerOverlays();
  const lit = new LitPreview({ renderer: app.renderer, art, status: (m) => say(m) });
  const frame = new Container();
  // The lit output is one sprite in the same world space the classic view
  // draws in, so the camera below moves both without knowing the difference.
  frame.addChild(world.container, lit.container, overlays.container);
  app.stage.addChild(frame);

  // ---------------------------------------------------------------- state
  const restored = restoreDraft();
  const store = new DraftStore(restored ?? newLevel());
  const camera: Camera = { scale: 2, x: 0, y: 0 };

  /**
   * The edit-mode sim state. A real `SimState` (so the renderer gets exactly
   * what it gets in the game) that is never stepped: `frozen`, tick 0, the
   * robot parked on the spawn tile as its own spawn marker.
   */
  const editState: SimState = initialState(1);
  editState.frozen = true;
  editState.robot.dormant = false;
  const editUi = blankUi();
  const editView: RenderView = { sim: editState, ui: editUi, alpha: 1, frameEvents: [] };

  /**
   * Which renderer is showing. `lit` is the default the moment a level has any
   * lit data, and the choice is remembered per session rather than per level —
   * a designer who switched to flat to check walkability wants it to stay flat
   * while they paint.
   */
  let previewMode: PreviewMode = 'lit';

  function litActive(): boolean {
    return hasLit(store.level) && previewMode !== 'flat';
  }

  /**
   * Push the current mode at both renderers and the chrome.
   *
   * The preview is told `flat` — not just hidden — whenever the DRAFT has no
   * lit data, because `LitPreview` keeps the last room it built. Loading a
   * classic level after a lit one would otherwise leave the previous level's
   * lightmap sitting on top of it, which reads as the new level being lit.
   */
  /** Whether the lit renderer is the one currently on screen. */
  let litShowing = false;

  function applyMode(): void {
    const on = litActive();
    litShowing = on;
    lit.setMode(on ? previewMode : 'flat');
    world.container.visible = !on;
    paintChrome();
  }

  function cycleMode(): void {
    if (!hasLit(store.level)) {
      say('this level has no lit data — place a prop or a light first (D / K)');
      return;
    }
    previewMode = previewMode === 'lit' ? 'flat' : previewMode === 'flat' ? 'lightmap' : 'lit';
    applyMode();
    say(`preview: ${MODE_LABEL[previewMode]}`);
  }

  let syncTimer = 0;
  function syncEditState(): void {
    const level = store.level;
    let solid: boolean[][];
    try {
      solid = buildSolid(level.map);
    } catch {
      return; // a malformed map is the validation panel's news to break, not a crash
    }
    editState.solid = solid;
    try {
      const def = levelToFloorDef(level);
      editState.entities = def.entities();
      const spawn =
        def.spawn ?? editState.entities.find((e) => e.kind === 'elevatorA')?.pos ?? { x: 40, y: 136 };
      editState.robot.pos = { x: spawn.x, y: spawn.y };
    } catch (err) {
      say(`level cannot be built: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Full rebuild. It drops fx and markers, which the designer has none of,
    // and it is the only public way to tell the tilemap the room changed.
    world.markDirty();
  }
  function scheduleSync(): void {
    clearTimeout(syncTimer);
    // ~50ms: one rebuild per paint stroke rather than one per painted tile.
    syncTimer = window.setTimeout(syncEditState, 50);
  }

  /**
   * The lit scene's own rebuild. Debounced inside `LitPreview`, and deliberately
   * NOT the same debounce as the sim view above: this one tears down and
   * rebuilds a deferred lighting rig, and its first call on a fresh level is
   * immediate so placing the first prop lights the room now.
   */
  function scheduleLit(): void {
    if (!hasLit(store.level)) {
      applyMode();
      return;
    }
    // Turning the lit renderer ON has to build the room in the same beat: the
    // flat view is hidden the moment applyMode runs, so a debounced build shows
    // whatever room the preview last held — after New, the PREVIOUS level.
    // `lit.built` cannot answer this, because the LitScene outlives the level
    // that created it: open a lit level, press New, place a lamp, and the scene
    // is still there from the first level while the flat view is still on top.
    const switching = litActive() !== litShowing;
    const now = switching || !lit.built;
    lit.setLevel(store.level, now);
    if (now) applyMode();
  }

  // ------------------------------------------------------------- playtest
  const playtest = new Playtest({
    status: say,
    litLightState: (id, state) => lit.setLightState(id, state),
    litTilesChanged: (map) => lit.markTilesDirty(map),
  });

  function stopPlaytest(): void {
    if (!playtest.active) return;
    playtest.stop();
    // The draft was never touched — rebuild the editing view from it. The lit
    // scene has to go back too: a playtest may have opened a door and killed
    // half the lamps, and neither is in the draft.
    syncEditState();
    world.markDirty();
    lit.setLevel(store.level, true);
    applyMode();
    say('back to editing');
  }

  function startPlaytest(): void {
    if (playtest.active) {
      stopPlaytest();
      return;
    }
    if (playtest.start(store.level)) {
      world.markDirty();
      // Any pending structural rebuild lands NOW — playing a room that is one
      // debounce behind the draft is how a designer ends up chasing a bug that
      // was fixed before they pressed P.
      lit.flush();
      paintChrome();
    }
  }

  // ---------------------------------------------------------------- tools
  const tools = new Tools({
    store,
    canvas: app.canvas,
    camera,
    status: say,
    isPlaytest: () => playtest.active,
    playtestClick: (x, y, right) => playtest.click(x, y, right),
    onChrome: () => paintChrome(),
    litNudge: (light) => lit.nudgeLight(light),
  });

  // ------------------------------------------------------------- panels
  const palette = createPalette(left, {
    renderer: app.renderer,
    art,
    getTool: () => tools.tool,
    getKind: () => tools.kind,
    setTool: (t) => tools.setTool(t),
    setKind: (k) => tools.setKind(k),
    getDecor: () => tools.decor,
    setDecor: (n) => tools.setDecor(n),
    getLight: () => tools.lightPreset,
    setLight: (k) => tools.setLightPreset(k),
    getVariant: () => tools.variant,
    setVariant: (v) => tools.setVariant(v),
  });

  const tabs = el('div', 'rd-tabs');
  const tabInspect = el('button', 'rd-tab rd-on', 'INSPECTOR') as HTMLButtonElement;
  const tabLook = el('button', 'rd-tab', 'LOOK') as HTMLButtonElement;
  const tabValid = el('button', 'rd-tab', 'CHECKS') as HTMLButtonElement;
  tabs.append(tabInspect, tabLook, tabValid);

  const inspector = new Inspector({
    store,
    status: say,
    region: () => store.region,
    remove: () => tools.deleteSelection(),
    litNudge: (light) => lit.nudgeLight(light),
    litFixture: (id, patch) => lit.setFixture(id, patch),
    litLightState: (id, state) => lit.setLightState(id, state),
  });
  const look = new LookPanel({
    store,
    status: say,
    apply: (next) => lit.updateLook(next),
    getLens: () => lit.lens,
    setLens: (on) => {
      lit.lens = on;
    },
    reseed: () => {
      const seed = (Math.floor(performance.now()) % 99999) + 1;
      store.run({
        label: 'reseed',
        structural: true,
        lit: true,
        apply: (l) => {
          l.meta = { ...l.meta, seed };
        },
        revert: (l) => {
          l.meta = { ...l.meta, seed: store.level.meta.seed };
        },
      });
      lit.reseed(seed);
      say(`dressing reseeded (${seed})`);
    },
  });
  const validation = new ValidationPanel({
    onFocus: (f) => focusFinding(f),
    onSummary: (errors, warns) => {
      sVal.className = errors > 0 ? 'rd-serr' : warns > 0 ? 'rd-swarn' : 'rd-sok';
      sVal.textContent =
        errors > 0 || warns > 0 ? `${errors} error(s), ${warns} warning(s)` : 'all checks pass';
      tabValid.textContent = errors > 0 ? `CHECKS (${errors}!)` : warns > 0 ? `CHECKS (${warns})` : 'CHECKS';
    },
  });
  right.append(tabs, inspector.root, look.root, validation.root);

  function showTab(which: 'inspect' | 'look' | 'valid'): void {
    inspector.root.classList.toggle('rd-hidden', which !== 'inspect');
    look.root.classList.toggle('rd-hidden', which !== 'look');
    validation.root.classList.toggle('rd-hidden', which !== 'valid');
    tabInspect.classList.toggle('rd-on', which === 'inspect');
    tabLook.classList.toggle('rd-on', which === 'look');
    tabValid.classList.toggle('rd-on', which === 'valid');
    if (which === 'look') look.render();
  }
  tabInspect.addEventListener('click', () => showTab('inspect'));
  tabLook.addEventListener('click', () => showTab('look'));
  tabValid.addEventListener('click', () => showTab('valid'));

  function focusFinding(f: Focus): void {
    if (f.kind === 'decor' || f.kind === 'light') {
      store.select({ kind: f.kind, id: f.id! });
      showTab('inspect');
      const target = f.kind === 'decor' ? store.decor(f.id!) : store.light(f.id!);
      if (target) centreOn(target.tx, target.ty);
      return;
    }
    if (f.kind === 'wet') {
      store.select({ kind: 'wet', index: f.index ?? 0 });
      showTab('inspect');
      const w = store.level.wetPatches?.[f.index ?? 0];
      if (w) centreOn(w.tx, w.ty);
      return;
    }
    if (f.kind === 'entity' || f.kind === 'trigger' || f.kind === 'sound') {
      store.select({ kind: f.kind, id: f.id! });
      showTab('inspect');
      const target =
        f.kind === 'entity'
          ? store.entity(f.id!)
          : f.kind === 'sound'
            ? store.sound(f.id!)
            : store.trigger(f.id!);
      if (target && 'tx' in target) centreOn(target.tx, target.ty);
      else if (target && 'pos' in target) centreOn(target.pos.x / TILE, target.pos.y / TILE);
      else if (target && 'rect' in target) centreOn(target.rect.tx, target.rect.ty);
      return;
    }
    if (f.kind === 'tile' && f.tx !== undefined && f.ty !== undefined) centreOn(f.tx, f.ty);
    if (f.kind === 'level') {
      store.select(null);
      showTab('inspect');
    }
  }

  function centreOn(tx: number, ty: number): void {
    const w = center.clientWidth;
    const h = center.clientHeight;
    camera.x = Math.round(w / 2 - (tx + 0.5) * TILE * camera.scale);
    camera.y = Math.round(h / 2 - (ty + 0.5) * TILE * camera.scale);
  }

  // -------------------------------------------------------------- toolbar
  top.appendChild(el('span', 'rd-title', 'LEVEL DESIGNER'));

  const levelSel = el('select', 'rd-select') as HTMLSelectElement;
  function fillLevels(): void {
    levelSel.replaceChildren();
    const head = el('option');
    head.value = '';
    head.textContent = '— load a level —';
    levelSel.appendChild(head);
    for (const c of levelChoices()) {
      const opt = el('option');
      opt.value = c.key;
      opt.textContent = c.label;
      levelSel.appendChild(opt);
    }
  }
  fillLevels();
  levelSel.addEventListener('change', () => {
    const key = levelSel.value;
    if (!key) return;
    const level = levelFor(key);
    levelSel.value = '';
    if (!level) return;
    if (key.startsWith('builtin:')) {
      // Built-ins are TS builders and stay that way. What lands in the draft is
      // a COPY under its own id (`floorToLevel`), so saving can never overwrite
      // floors.ts — "duplicate to edit" is the only way in.
      say(`duplicated as '${level.meta.id}' — edit and save it as a level`);
    } else {
      say(`loaded ${level.meta.id}`);
    }
    loadDraft(level);
  });
  top.append(levelSel);

  function loadDraft(level: LevelData): void {
    store.run(loadLevelCmd(store.level, level));
    store.resetHistory();
    store.select(null);
    store.setRegion(null);
    syncEditState();
    lit.setLevel(store.level, true);
    lit.updateLook(store.level.look);
    applyMode();
    inspector.render();
    look.render();
    validation.run(store.level);
    fit();
  }

  const btnNew = mkBtn('New', 'blank room with both elevators');
  btnNew.addEventListener('click', () => {
    loadDraft(newLevel());
    say('new level');
  });

  const btnImport = mkBtn('Import', 'paste a .level.ts file or LevelData JSON');
  btnImport.addEventListener('click', () => {
    void promptText('Import level', 'paste a .level.ts file or a LevelData JSON object…').then((text) => {
      if (text === null) return;
      const res = parseLevelSource(text);
      if ('error' in res) {
        say(`import failed: ${res.error}`);
        return;
      }
      loadDraft(res.level);
      say(`imported ${res.level.meta.id}`);
    });
  });

  const btnCopy = mkBtn('Copy TS', 'the exact .level.ts file, for pasting into client/src/levels/');
  btnCopy.addEventListener('click', () => {
    toClipboard(levelSource(store.level));
    flash(btnCopy, 'copied!', 'Copy TS');
  });

  const btnSave = mkBtn('Save', 'write client/src/levels/<id>.level.ts (dev server only)', 'rd-on');
  btnSave.addEventListener('click', () => {
    const errors = validation.findings.filter((f) => f.level === 'error');
    if (errors.length > 0) {
      say(`fix ${errors.length} error(s) first — the build would reject this level`);
      showTab('valid');
      return;
    }
    btnSave.disabled = true;
    void saveLevel(store.level).then((res) => {
      btnSave.disabled = false;
      if (res.ok) {
        flash(btnSave, 'saved!', 'Save');
        say(`wrote client/src/levels/${store.level.meta.id}.level.ts`);
      } else {
        say(`save failed: ${res.error ?? 'unknown'}`);
      }
    });
  });

  top.append(btnNew, btnImport, btnCopy, btnSave, el('span', 'rd-sep'));

  const btnUndo = mkBtn('↶ undo', 'Ctrl+Z');
  const btnRedo = mkBtn('↷ redo', 'Ctrl+Y');
  btnUndo.addEventListener('click', () => {
    store.undo();
  });
  btnRedo.addEventListener('click', () => {
    store.redo();
  });
  top.append(btnUndo, btnRedo, el('span', 'rd-sep'));

  const btnPlay = mkBtn('▶ playtest', 'P — Esc returns');
  btnPlay.addEventListener('click', startPlaytest);
  const btnGrid = mkBtn('grid', 'X');
  btnGrid.addEventListener('click', () => {
    tools.showGrid = !tools.showGrid;
    paintChrome();
  });
  const btnPaint = mkBtn('brush: wall', 'F flips what the wall tools paint');
  btnPaint.addEventListener('click', () => {
    tools.paintSolid = !tools.paintSolid;
    paintChrome();
  });
  const btnFit = mkBtn('fit', 'centre the room');
  btnFit.addEventListener('click', () => fit());
  const btnMode = mkBtn('view: lit', 'L cycles lit → flat → lightmap');
  btnMode.addEventListener('click', cycleMode);
  top.append(btnPlay, btnGrid, btnPaint, btnFit, btnMode);

  const btnForget = mkBtn('forget draft', 'drop the autosaved draft from this browser');
  btnForget.addEventListener('click', () => {
    clearDraft();
    flash(btnForget, 'cleared', 'forget draft');
  });
  top.append(el('span', 'rd-sep'), btnForget);

  // The save endpoint only exists behind `pnpm dev`. In a built bundle the
  // button would be a promise the page cannot keep, so it goes away and
  // `Copy TS` becomes the whole story.
  void listCustomIds().then((ids) => {
    if (ids === null) {
      btnSave.style.display = 'none';
      say('no dev server — Save is off, use Copy TS');
      return;
    }
    const known = new Set(levelChoices().map((c) => c.key.replace('custom:', '')));
    const stray = ids.filter((id) => !known.has(id));
    if (stray.length > 0) say(`levels on disk not in this bundle yet: ${stray.join(', ')} — reload`);
  });

  // ---------------------------------------------------------------- chrome
  function paintChrome(): void {
    palette.sync();
    palette.showFor(tools.tool);
    btnUndo.disabled = !store.canUndo;
    btnRedo.disabled = !store.canRedo;
    btnGrid.classList.toggle('rd-on', tools.showGrid);
    btnPaint.textContent = `brush: ${tools.paintSolid ? 'wall' : 'floor'}`;
    btnPlay.classList.toggle('rd-on', playtest.active);
    btnPlay.textContent = playtest.active ? '■ stop (Esc)' : '▶ playtest';
    btnMode.textContent = `view: ${hasLit(store.level) ? MODE_LABEL[previewMode] : 'flat (no lit data)'}`;
    btnMode.classList.toggle('rd-on', litActive());
    const detail =
      tools.tool === 'entity'
        ? ` · ${tools.kind}`
        : tools.tool === 'decor'
          ? ` · ${tools.decor}`
          : tools.tool === 'light'
            ? ` · ${tools.lightPreset}`
            : tools.tool === 'variant'
              ? ` · variant ${tools.variant}`
              : '';
    sTool.textContent = `${tools.tool}${detail}`;
    sZoom.textContent = `${Math.round(camera.scale * 100)}%`;
  }

  store.on((info: ChangeInfo) => {
    // A lit-only edit leaves the sim view alone: rebuilding a tilemap and a
    // full entity list because a lamp moved is work nobody asked for.
    if (info.structural) {
      if (!info.lit) scheduleSync();
      scheduleLit();
    } else if (info.lit) {
      // A look change — including UNDOING one, which is the case the panel's
      // own cheap path cannot cover, because it did not make the change.
      lit.updateLook(store.level.look);
      look.pull();
    }
    if (info.source === 'inspector') inspector.pull();
    else inspector.render();
    validation.schedule(store.level);
    paintChrome();
  });
  store.onSelection(() => {
    inspector.render();
    // Selecting something and being shown a different panel is the tool losing
    // your place. The LOOK and CHECKS tabs are things you go TO; the inspector
    // is where you come back to.
    if (store.selection !== null) showTab('inspect');
    paintChrome();
  });

  // ------------------------------------------------------------- viewport
  function fit(): void {
    tools.fit(Math.max(1, center.clientWidth), Math.max(1, center.clientHeight));
    paintChrome();
  }
  function resize(): void {
    const w = Math.max(1, center.clientWidth);
    const h = Math.max(1, center.clientHeight);
    app.renderer.resize(w, h);
  }
  new ResizeObserver(resize).observe(center);
  resize();
  fit();

  // ------------------------------------------------------------ shortcuts
  window.addEventListener('keydown', (e) => {
    if (typing(e.target)) return;
    if (e.key === 'Escape' && playtest.active) {
      stopPlaytest();
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      btnSave.click();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() === 'p') {
      startPlaytest();
      e.preventDefault();
      return;
    }
    // L is the PREVIEW toggle, not a tool: the light tool is K. A key that
    // placed something would be the wrong thing to reach for by reflex while
    // looking at a room you cannot see.
    if (e.key.toLowerCase() === 'l') {
      cycleMode();
      e.preventDefault();
    }
  });

  // ----------------------------------------------------------------- loop
  syncEditState();
  lit.setLevel(store.level, true);
  lit.updateLook(store.level.look);
  applyMode();
  inspector.render();
  validation.run(store.level);
  if (restored) say(`restored the draft '${store.level.meta.id}' from this browser`);

  let last = performance.now();
  let clock = 0;
  function tick(now: number): void {
    requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    clock += dt;

    const view = playtest.active ? playtest.update(dt) : editView;
    if (view) {
      for (const ev of view.frameEvents) world.handleEvent(ev, view);
      // The classic view still runs while the lit one is showing: it is one
      // hidden container's worth of work, and it is what makes `L` instant.
      world.update(view, dt);
      if (litActive()) {
        /**
         * The bodies, every frame. In edit mode the sim is frozen and the poses
         * are static — but they are the REAL sprites in the REAL lighting,
         * which is the whole question a designer is asking when they put a lamp
         * over a doorway.
         */
        lit.setActors(actorStates(art, view.sim.entities, view.sim.robot, clock));
      }
    }
    lit.update(dt);
    overlays.update({
      level: store.level,
      selection: store.selection,
      region: store.region,
      pending: tools.pending,
      pendingWet: tools.pendingWet,
      hover: playtest.active ? null : tools.hover,
      showGrid: tools.showGrid,
      visible: !playtest.active,
      lit: hasLit(store.level),
    });

    frame.scale.set(camera.scale);
    // NOT rounded here — the camera is already whole-pixel at every writer, and
    // rounding only at the draw would put the picture half a pixel away from
    // where the pointer maths thinks it is.
    frame.position.set(camera.x, camera.y);

    // The lit tools place on quarter tiles, so they get the fractional readout —
    // "10.5,5.75" is the number that ends up in the file, and a designer lining
    // two props up against the same wall needs to see it.
    const h = tools.hover;
    const f = tools.hoverT;
    const fractional = tools.tool === 'decor' || tools.tool === 'light' || tools.tool === 'wet';
    sTile.textContent = h ? (fractional && f ? `${f.tx},${f.ty}` : `${h.tx},${h.ty}`) : '—';
    sZoom.textContent = `${Math.round(camera.scale * 100)}%`;
    app.render();
  }
  requestAnimationFrame(tick);

  (globalThis as { __designer?: unknown }).__designer = { app, store, tools, world, playtest, lit };
  say(`ready — ${TILES_X}×${TILES_Y} tiles, ${TILE}px each`);
}

boot().catch((err: unknown) => {
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#ff8080;font:12px monospace;padding:16px;white-space:pre-wrap';
  pre.textContent = `designer failed to boot:\n${String(err)}\n${(err as Error)?.stack ?? ''}`;
  document.body.appendChild(pre);
});
