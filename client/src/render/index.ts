/**
 * RenderApp — PixiJS v8 presentation. 480×270 logical feed, integer-scaled and
 * letterboxed, everything on the monitor runs through the CRT filter stack.
 * Reads RenderView every rAF; writes nothing back to sim/ui.
 */

import { Application, Container, Graphics, Rectangle, TextureStyle } from 'pixi.js';
import type { ArtAtlas, RenderApp, RenderFx, RenderView } from '@shared/types';
import { VIEW_H, VIEW_W } from '@shared/types';
import { CrtStack } from './crt';
import { Osd } from './osd';
import { Overlays } from './overlays';
import { WorldView } from './world';

async function loadFont(family: string, url: string): Promise<void> {
  try {
    const face = new FontFace(family, `url('${url}')`);
    await face.load();
    document.fonts.add(face);
  } catch {
    // zero-font fail-soft: VT323→monospace, Caveat→cursive stacks still read
  }
}

export function createRenderApp(art: ArtAtlas): RenderApp {
  const app = new Application();
  const frame = new Container();
  const crtWrap = new Container();
  let letterbox: Graphics;
  let crt: CrtStack;
  let world: WorldView;
  let osd: Osd;
  let overlays: Overlays;
  let inited = false;
  let lastNow = -1;

  function layout(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    app.renderer.resize(w, h);
    const s = Math.max(1, Math.floor(Math.min(w / VIEW_W, h / VIEW_H)));
    frame.scale.set(s);
    frame.position.set(
      Math.round((w - VIEW_W * s) / 2),
      Math.round((h - VIEW_H * s) / 2),
    );
    letterbox.clear().rect(0, 0, w, h).fill(0x050505);
    // Pin the filter target to the logical feed rect (LOCAL space). Without
    // this the filter texture tracks fluctuating content bounds and curvature
    // samples uninitialized/reused regions — garbage wedges + white feedback.
    crtWrap.filterArea = new Rectangle(0, 0, VIEW_W, VIEW_H);
    crt.setScale(s);
    overlays.setNoteResolution(s);
  }

  async function init(host: HTMLElement): Promise<void> {
    // nearest everywhere — set BEFORE any render-owned texture is created
    TextureStyle.defaultOptions.scaleMode = 'nearest';

    await app.init({
      preference: 'webgl',
      antialias: false,
      background: '#08090b',
      resizeTo: window,
      resolution: 1,
      autoStart: false, // render() drives frames — enables dropped-frame flicker
    });

    await Promise.all([
      loadFont('VT323', './fonts/VT323-Regular.ttf'),
      loadFont('Caveat', './fonts/Caveat.ttf'),
    ]);

    world = new WorldView(art);
    osd = new Osd(art);
    overlays = new Overlays(art);
    crt = new CrtStack(crtWrap);
    // tear bands snapshot the WORLD only — the OSD is burned in by the
    // monitor and never tears
    crt.attachFeed(app.renderer, world.container);
    // center pivot so the rare auto-focus "breathe" zoom pulses around center
    world.container.pivot.set(VIEW_W / 2, VIEW_H / 2);

    const feedBg = new Graphics().rect(0, 0, VIEW_W, VIEW_H).fill(0x08090b);
    crtWrap.addChild(
      feedBg,
      world.container,
      crt.fxLayer, // static bursts / roll / boot bloom cover the feed…
      osd.container, // …but the OSD is burned in by the MONITOR — always on top
      overlays.container, // death card & title above dead static
      osd.captionLayer, // captions survive the cliffhanger static
    );

    letterbox = new Graphics();
    frame.addChild(crtWrap, overlays.noteLayer);
    app.stage.addChild(letterbox, frame);

    layout();
    window.addEventListener('resize', layout);
    host.appendChild(app.canvas);
    if (import.meta.env.DEV) (globalThis as { __app?: unknown }).__app = app;
    inited = true;
  }

  function render(view: RenderView): void {
    if (!inited) return;
    const now = performance.now();
    const dt = lastNow < 0 ? 1 / 60 : Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;

    // every sim event since last frame (multiple steps may run per rAF);
    // robot_damage screen fx come from the director via fx — not here
    for (const ev of view.frameEvents) world.handleEvent(ev, view);

    world.update(view, dt);
    osd.update(view.ui, dt);
    overlays.update(view.ui, dt);

    const f = crt.update(dt, view.ui.danger, view.ui.degrade);
    // pivot sits at feed center (init) — position carries it back + jitter
    world.container.position.set(VIEW_W / 2 + f.ox, VIEW_H / 2 + f.oy);
    world.container.scale.set(f.zoom);
    // phosphor glow rides the robot — the only bright thing on the feed
    crt.setGlow(
      world.robot.container.x + f.ox,
      world.robot.container.y + f.oy,
      view.sim.robot.alive,
    );

    if (!f.skip) app.render();
  }

  const fx: RenderFx = {
    bootFlash: () => inited && crt.bootFlash(),
    staticBurst: (ms: number) => inited && crt.staticBurst(ms),
    glitchFrame: () => inited && crt.glitchFrame(),
    shake: (px: number, ms: number) => inited && crt.shake(px, ms),
    deadCam: (on: boolean) => inited && crt.deadCam(on),
  };

  return { init, render, fx };
}
