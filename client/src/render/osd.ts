/**
 * Amber camera OSD — part of the feed (inside the CRT stack). Two containers:
 * `container` sits under the screen-fx layer; `captionLayer` (captions +
 * teletype) sits above it so cliffhanger lines survive dead-cam static.
 */

import { Container, Sprite, Text, Texture } from 'pixi.js';
import type { ArtAtlas, ChipId, UiState } from '@shared/types';
import { VIEW_W } from '@shared/types';
import { makeRng } from '@shared/rng';
import { AMBER, AMBER_DIM, tex, VT323 } from './util';

const VU_BARS = 5;
const GLYPH_STEP = 12; // right-aligned strip pitch (8px glyph + 4px gap)
const SUB_TEXT_Y = 212; // caption home row; shifts up one line over the teletype

function osdText(size: number, color = AMBER): Text {
  return new Text({
    text: '',
    style: { fontFamily: VT323, fontSize: size, fill: color },
  });
}

export class Osd {
  readonly container = new Container();
  readonly captionLayer = new Container();

  private main: Text;
  private recDot: Text;
  private recGlow: Text;
  private clock: Text;
  private clockSec = -1;

  private glyphRow = new Container();
  private glyphIds = '';
  private glyphCount = 0;
  private glyphSprites: Sprite[] = [];
  private glyphFlash: (Sprite | null)[] = [];
  private glyphPop: number[] = [];

  private mood: Text;
  private mic: Text;
  private vuBars: Sprite[] = [];
  private vuLvl = [0, 0, 0, 0, 0];
  private vuTarget = [0, 0, 0, 0, 0];
  private vuT = 0;
  private dots: Text[] = [];
  private rng = makeRng(0x0a5d);

  private caption: Text;
  private capCursor: Sprite;
  private capTarget = '';
  private capShown = 0;
  private tele: Text;
  private t = 0;

  constructor(private art: ArtAtlas) {
    this.main = osdText(10);
    this.main.position.set(6, 4);

    this.recDot = osdText(10, 0xff4d3a); // REC dot reads hotter than the amber text
    this.recDot.text = '●';
    this.recDot.position.set(6, 4);

    // additive copy under a slight scale-up = 1px glow halo, pulsing with the blink
    this.recGlow = osdText(10, 0xff4d3a);
    this.recGlow.text = '●';
    this.recGlow.anchor.set(0.5);
    this.recGlow.blendMode = 'add';
    this.recGlow.visible = false;

    // CCTV burn-in clock, top-right — real session time, dimmer than the header
    this.clock = osdText(10, AMBER_DIM);
    this.clock.anchor.set(1, 0);
    this.clock.position.set(VIEW_W - 6, 4);
    this.clock.alpha = 0.7;
    this.clock.text = '00:00:00';

    this.mood = osdText(10, AMBER_DIM);
    this.mood.anchor.set(1, 0);
    this.mood.position.set(VIEW_W - 6, 30);

    this.mic = osdText(10);
    this.mic.position.set(6, 242);

    // fake VU meter — five 2px bars beside the mic label while listening
    for (let i = 0; i < VU_BARS; i++) {
      const bar = new Sprite(Texture.WHITE);
      bar.tint = AMBER;
      bar.width = 2;
      bar.height = 2;
      bar.visible = false;
      this.vuBars.push(bar);
    }

    // thinking indicator — three dots pulsing in sequence
    for (let i = 0; i < 3; i++) {
      const dot = osdText(10);
      dot.text = '·';
      dot.position.set(6 + i * 8, 242);
      dot.visible = false;
      this.dots.push(dot);
    }

    this.glyphRow.position.set(VIEW_W - 6, 20);
    this.container.addChild(
      this.main,
      this.recGlow,
      this.recDot,
      this.clock,
      this.glyphRow,
      this.mood,
      this.mic,
      ...this.vuBars,
      ...this.dots,
    );

    this.caption = new Text({
      text: '',
      style: {
        fontFamily: VT323,
        fontSize: 16,
        fill: AMBER,
        stroke: { color: 0x140b00, width: 1 },
        dropShadow: { color: 0x000000, alpha: 0.55, blur: 0.5, distance: 0.5, angle: Math.PI / 2 },
        align: 'center',
        wordWrap: true,
        wordWrapWidth: 420,
      },
    });
    this.caption.anchor.set(0.5, 0);
    this.caption.position.set(VIEW_W / 2, SUB_TEXT_Y);

    // amber block riding the typewriter reveal head
    this.capCursor = new Sprite(Texture.WHITE);
    this.capCursor.tint = AMBER;
    this.capCursor.width = 6;
    this.capCursor.height = 12;
    this.capCursor.alpha = 0.85;
    this.capCursor.visible = false;

    this.tele = osdText(10);
    this.tele.position.set(6, 256);
    this.captionLayer.addChild(this.caption, this.capCursor, this.tele);
  }

  update(ui: UiState, dt: number): void {
    this.t += dt;
    const blink = this.t % 1 < 0.5;

    // top-left OSD line; trailing ● becomes the blinking REC dot
    let osd = ui.osd;
    let hasDot = false;
    if (osd.endsWith('●')) {
      hasDot = true;
      osd = osd.slice(0, -1);
    }
    this.main.text = osd;
    this.recDot.visible = hasDot && blink;
    this.recDot.x = 6 + this.main.width;
    this.recGlow.visible = this.recDot.visible;
    if (this.recGlow.visible) {
      this.recGlow.position.set(this.recDot.x + this.recDot.width / 2, 4 + this.recDot.height / 2);
      const pulse = 0.5 + 0.5 * Math.sin(this.t * Math.PI * 2);
      this.recGlow.scale.set(1.15 + 0.2 * pulse);
      this.recGlow.alpha = 0.25 + 0.2 * pulse;
    }

    // session clock — string rebuilt only when the second ticks over
    this.clock.visible = ui.osd.length > 0;
    const sec = Math.floor(this.t);
    if (sec !== this.clockSec) {
      this.clockSec = sec;
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      this.clock.text = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    // module glyph strip (right-aligned) + mood glyph beside it
    const ids = ui.glyphs.join(',');
    if (ids !== this.glyphIds) {
      const prevCount = this.glyphCount;
      this.glyphIds = ids;
      this.glyphCount = ui.glyphs.length;
      this.glyphRow.removeChildren().forEach((c) => c.destroy());
      this.glyphSprites.length = 0;
      this.glyphFlash.length = 0;
      this.glyphPop.length = 0;
      ui.glyphs.forEach((id: ChipId, i: number) => {
        const k = ui.glyphs.length - 1 - i; // 0 = rightmost slot
        if (i > 0) {
          // faint separator dot centered in the gap
          const sep = new Sprite(Texture.WHITE);
          sep.anchor.set(0.5);
          sep.width = 1;
          sep.height = 1;
          sep.tint = AMBER;
          sep.alpha = 0.22;
          sep.position.set(-k * GLYPH_STEP - 10, 0);
          this.glyphRow.addChild(sep);
        }
        const sp = new Sprite(tex(this.art, `glyph_${id}`));
        sp.anchor.set(0.5);
        sp.x = -k * GLYPH_STEP - 4;
        this.glyphRow.addChild(sp);
        this.glyphSprites.push(sp);
        if (i >= prevCount) {
          // fresh install: scale bounce + additive flash fading out
          this.glyphPop.push(0);
          const flash = new Sprite(sp.texture);
          flash.anchor.set(0.5);
          flash.x = sp.x;
          flash.blendMode = 'add';
          this.glyphRow.addChild(flash);
          this.glyphFlash.push(flash);
        } else {
          this.glyphPop.push(1);
          this.glyphFlash.push(null);
        }
      });
    }
    for (let i = 0; i < this.glyphPop.length; i++) {
      if (this.glyphPop[i] >= 1) continue;
      const p = Math.min(1, this.glyphPop[i] + dt / 0.16);
      this.glyphPop[i] = p;
      // 2-beat bounce: overshoot big → dip under → settle at 1
      const s = p < 0.55 ? 1.9 - 1.2 * (p / 0.55) : 0.7 + 0.3 * ((p - 0.55) / 0.45);
      this.glyphSprites[i].scale.set(s);
      const flash = this.glyphFlash[i];
      if (flash) {
        flash.scale.set(s);
        flash.alpha = 1 - p;
        if (p >= 1) flash.visible = false;
      }
      if (p >= 1) this.glyphSprites[i].scale.set(1);
    }
    this.mood.text = ui.moodGlyph;

    // mic state, bottom-left
    const listening = ui.micState === 'listening';
    const thinking = ui.micState === 'thinking';
    if (listening) {
      this.mic.text = '● LISTENING';
      this.mic.alpha = 0.55 + 0.45 * Math.sin(this.t * 6);
    } else {
      this.mic.text = '';
    }
    for (let i = 0; i < 3; i++) {
      const dot = this.dots[i];
      dot.visible = thinking;
      if (thinking) dot.alpha = Math.floor(this.t * 4) % 3 === i ? 1 : 0.3;
    }
    // fake VU — rng retargets ~14×/s, bars chase; real RMS unavailable here
    if (listening) {
      this.vuT += dt;
      if (this.vuT > 0.07) {
        this.vuT = 0;
        for (let i = 0; i < VU_BARS; i++) this.vuTarget[i] = 2 + this.rng() * 6;
      }
      const chase = Math.min(1, dt * 16);
      const x0 = 6 + this.mic.width + 6;
      for (let i = 0; i < VU_BARS; i++) {
        this.vuLvl[i] += (this.vuTarget[i] - this.vuLvl[i]) * chase;
        const bar = this.vuBars[i];
        bar.visible = true;
        bar.height = this.vuLvl[i];
        bar.position.set(x0 + i * 3, 251 - this.vuLvl[i]);
        bar.alpha = 0.9;
      }
    } else {
      for (let i = 0; i < VU_BARS; i++) {
        this.vuBars[i].visible = false;
        this.vuLvl[i] = 0;
      }
    }

    // caption: robot speech, fast per-char typewriter reveal (20ms/char);
    // rides one line higher while the teletype owns the bottom row
    const showTele = ui.teletypeActive || ui.teletype.length > 0;
    this.caption.y = showTele ? SUB_TEXT_Y - 16 : SUB_TEXT_Y;
    if (ui.caption !== this.capTarget) {
      this.capTarget = ui.caption;
      this.capShown = ui.caption === '' ? 0 : 1;
      this.caption.text = ''; // clear stale glyphs before the new reveal
    }
    const prevShown = Math.floor(this.capShown);
    this.capShown = Math.min(this.capTarget.length, this.capShown + dt * 50);
    const shown = Math.floor(this.capShown);
    if (shown !== prevShown || this.caption.text.length !== shown) {
      this.caption.text = this.capTarget.slice(0, shown);
    }
    // amber block at the reveal head while typing
    const typing = shown > 0 && shown < this.capTarget.length;
    this.capCursor.visible = typing;
    if (typing) {
      this.capCursor.position.set(
        VIEW_W / 2 + this.caption.width / 2 + 1,
        this.caption.y + Math.max(0, this.caption.height - 13),
      );
    }

    // teletype line + blinking cursor
    this.tele.visible = showTele;
    if (showTele) {
      const cursor = ui.teletypeActive && blink ? '█' : ' ';
      this.tele.text = `> ${ui.teletype}${cursor}`;
    }
  }
}
