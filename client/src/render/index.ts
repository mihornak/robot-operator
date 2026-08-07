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

  /**
   * Integer scale is the pixel-pure ideal, and on a 27" monitor it costs
   * nothing. On a 13" laptop (2.7× available) or a phone (1.4×) the next
   * integer down throws away a third of the screen, and the game is a monitor
   * you lean into — a postage stamp in a black field is the wrong object. So:
   * take the integer only when it wastes little, otherwise fill the screen and
   * accept uneven pixel widths. The CRT curvature, scanlines and grain were
   * never a clean pixel grid anyway; empty room around the monitor is the more
   * visible defect.
   */
  function fitScale(w: number, h: number): number {
    const raw = Math.min(w / VIEW_W, h / VIEW_H);
    const int = Math.floor(raw);
    return int >= 1 && int / raw >= 0.86 ? int : raw;
  }

  function layout(): void {
    // visualViewport is the truth on mobile: innerHeight lies while the URL
    // bar animates and after the on-screen keyboard opens.
    const vv = window.visualViewport;
    const w = Math.max(1, Math.round(vv?.width ?? window.innerWidth));
    const h = Math.max(1, Math.round(vv?.height ?? window.innerHeight));
    app.renderer.resize(w, h);
    const s = fitScale(w, h);
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
      // no resizeTo: layout() owns the size, and it measures visualViewport
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
    // Coalesce to one relayout per frame: a phone fires resize + visualViewport
    // resize + orientationchange in a burst while the URL bar slides away.
    let pending = 0;
    const relayout = (): void => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        layout();
      });
    };
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', relayout);
    window.visualViewport?.addEventListener('resize', relayout);
    window.visualViewport?.addEventListener('scroll', relayout);
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
      view.sim.robot.alive && !view.sim.robot.dormant,
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
