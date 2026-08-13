/**
 * GRAPHICS LAB entry point. Standalone page (`/lab.html`) — it shares the art
 * atlas and the Px helper with the game and nothing else. No sim, no director,
 * no voice: one room, lit properly, with every knob exposed.
 *
 * Post chain order, and each step's reason:
 *   bloom  first — it must see the raw emissive values, before the grade has
 *          crushed or lifted them
 *   grade  second — exposure/contrast/saturation/tint, then the lens effects
 *          (vignette, chroma, grain, scanlines) that pretend to be glass
 *   CRT    last and optional — it is a *display*, so it goes after everything
 *          the display would be showing
 */

import { AdvancedBloomFilter, CRTFilter } from 'pixi-filters';
import {
  Application,
  Container,
  Graphics,
  Rectangle,
  RenderTexture,
  Sprite,
  TextureStyle,
} from 'pixi.js';
import { initArt } from '../art';
import { GradeFilter } from '../render/lit/filters';
import { P } from './params';
import { LabScene } from './scene';
import { createLabUi } from './ui';

const VW = 480;
const VH = 270;
/** Slider panel width — the feed is centred in what's left of the window. */
const PANEL = 336;

async function boot(): Promise<void> {
  TextureStyle.defaultOptions.scaleMode = 'nearest';

  const app = new Application();
  await app.init({
    preference: 'webgl',
    antialias: false,
    background: '#05070a',
    resolution: 1,
    autoStart: false,
  });
  document.getElementById('app')!.appendChild(app.canvas);

  const art = await initArt();
  const scene = new LabScene(app.renderer, art);

  /**
   * The post chain runs at the LOGICAL resolution and the finished 480×270
   * image is upscaled afterwards — it is never in the display list itself.
   *
   * This is not an optimisation, it is the only correct place for it. A filter
   * applied to a scaled container runs in screen space: `uDimensions` stops
   * matching the filter area, the lightmap lands at 1:1 screen pixels instead
   * of covering the room, and grain and scanlines come out at monitor
   * resolution, which on a pixel-art game reads as dirt on the glass rather
   * than as grain. Rendering to an offscreen target at 1:1 makes every
   * screen-space effect land on the logical grid, and the nearest-neighbour
   * upscale afterwards keeps the pixels hard.
   */
  const post = new Container();
  post.addChild(scene.root);
  post.filterArea = new Rectangle(0, 0, VW, VH);
  const finalRt = RenderTexture.create({ width: VW, height: VH, antialias: false });
  finalRt.source.scaleMode = 'nearest';
  const screen = new Sprite(finalRt);

  const bloom = new AdvancedBloomFilter({
    threshold: P.bloomThreshold,
    bloomScale: P.bloomScale,
    brightness: P.bloomBrightness,
    blur: P.bloomBlur,
    quality: 4,
  });
  const grade = new GradeFilter(VW, VH);
  const crt = new CRTFilter({
    curvature: 2,
    lineWidth: 0,
    lineContrast: 0,
    noise: 0,
    vignetting: 0,
  });

  const frame = new Container();
  frame.addChild(screen);
  const letterbox = new Graphics();
  app.stage.addChild(letterbox, frame);

  function layout(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    app.renderer.resize(w, h);
    const panel = document.querySelector('.rlab-root');
    const panelOpen = !!panel && !panel.classList.contains('rlab-hidden');
    const avail = w > 820 && panelOpen ? w - PANEL : w;
    const s = Math.max(1, Math.min(avail / VW, h / VH));
    frame.scale.set(s);
    frame.position.set(
      Math.round((avail - VW * s) / 2),
      Math.round((h - VH * s) / 2),
    );
    letterbox.clear().rect(0, 0, w, h).fill(0x05070a);
  }
  layout();
  window.addEventListener('resize', layout);

  const ui = createLabUi({
    onReseed: () => scene.reseed(),
  });
  // Selecting a fixture loads ITS settings into P; the widgets have to follow.
  scene.onParamsChanged = () => ui.sync();
  // Hiding the panel gives the feed the whole window, so the fit has to be
  // recomputed when it does — the panel owns that class, not the body.
  const panelEl = document.querySelector('.rlab-root');
  if (panelEl) {
    new MutationObserver(layout).observe(panelEl, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  layout();

  /**
   * Drag a character anywhere in the room.
   *
   * The fixed patrol loops are good for judging motion but useless for the
   * question you actually keep asking — "what does the robot look like THERE" —
   * so the characters are grabbable. Auto-walk keeps running for whoever is not
   * being held, and a released character rejoins its loop at the nearest point.
   */
  const feedAt = (e: PointerEvent): { x: number; y: number } => {
    const r = app.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - frame.x) / frame.scale.x,
      y: (e.clientY - r.top - frame.y) / frame.scale.y,
    };
  };

  let dragging = false;
  app.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const p = feedAt(e);
    if (!scene.beginDrag(p.x, p.y)) return;
    dragging = true;
    app.canvas.setPointerCapture(e.pointerId);
    app.canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });
  app.canvas.addEventListener('pointermove', (e: PointerEvent) => {
    const p = feedAt(e);
    if (dragging) {
      scene.dragTo(p.x, p.y);
      return;
    }
    // hover affordance — without it there is nothing telling you this is possible
    app.canvas.style.cursor = scene.pickActor(p.x, p.y) ? 'grab' : 'default';
  });
  const release = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    scene.endDrag();
    app.canvas.releasePointerCapture(e.pointerId);
    app.canvas.style.cursor = 'grab';
  };
  app.canvas.addEventListener('pointerup', release);
  app.canvas.addEventListener('pointercancel', release);

  let last = performance.now();
  let acc = 0;
  let frames = 0;
  let fps = 0;

  function tick(now: number): void {
    requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    scene.update(dt);

    // ---- post chain, rebuilt only when a toggle actually flips
    const chain = [];
    if (P.bloomOn) {
      bloom.threshold = P.bloomThreshold;
      bloom.bloomScale = P.bloomScale;
      bloom.brightness = P.bloomBrightness;
      bloom.blur = P.bloomBlur;
      chain.push(bloom);
    }
    const u = grade.u;
    u.uTone[0] = P.exposure;
    u.uTone[1] = P.contrast;
    u.uTone[2] = P.saturation;
    u.uTone[3] = P.gamma;
    u.uLift[0] = ((P.liftColor >> 16) & 0xff) / 255;
    u.uLift[1] = ((P.liftColor >> 8) & 0xff) / 255;
    u.uLift[2] = (P.liftColor & 0xff) / 255;
    u.uLift[3] = P.liftAmount;
    u.uGain[0] = ((P.gainColor >> 16) & 0xff) / 255;
    u.uGain[1] = ((P.gainColor >> 8) & 0xff) / 255;
    u.uGain[2] = (P.gainColor & 0xff) / 255;
    u.uGain[3] = P.gainAmount;
    u.uLens[0] = P.vignette;
    u.uLens[1] = P.vignetteSoft;
    u.uLens[2] = P.chroma;
    u.uLens[3] = P.grain;
    u.uMisc[0] = P.scanline;
    u.uMisc[1] = now / 1000;
    u.uMisc[2] = P.gradeOn ? 1 : 0;
    chain.push(grade);
    if (P.crtOn) {
      crt.curvature = P.crtCurve * 8;
      crt.time = now / 1000;
      chain.push(crt);
    }
    post.filters = chain;

    app.renderer.render({ container: post, target: finalRt, clear: true });
    app.render();

    frames++;
    acc += dt;
    if (acc >= 0.5) {
      fps = Math.round(frames / acc);
      frames = 0;
      acc = 0;
      ui.setStats(`${fps} fps · ${scene.stats()}`);
    }
  }
  requestAnimationFrame(tick);

  (globalThis as { __lab?: unknown }).__lab = { app, scene, P };
}

boot().catch((err: unknown) => {
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#ff8080;font:12px monospace;padding:16px;white-space:pre-wrap';
  pre.textContent = `lab failed to boot:\n${String(err)}\n${(err as Error)?.stack ?? ''}`;
  document.body.appendChild(pre);
});
