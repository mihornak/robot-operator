/**
 * Amber camera OSD — part of the feed (inside the CRT stack). Two containers:
 * `container` sits under the screen-fx layer; `captionLayer` (captions +
 * teletype) sits above it so cliffhanger lines survive dead-cam static.
 */

import { Container, Sprite, Text } from 'pixi.js';
import type { ArtAtlas, ChipId, UiState } from '@shared/types';
import { VIEW_W } from '@shared/types';
import { AMBER, AMBER_DIM, tex, VT323 } from './util';

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
  private glyphRow = new Container();
  private glyphIds = '';
  private mood: Text;
  private mic: Text;
  private caption: Text;
  private capTarget = '';
  private capShown = 0;
  private tele: Text;
  private t = 0;

  constructor(private art: ArtAtlas) {
    this.main = osdText(10);
    this.main.position.set(6, 4);

    this.recDot = osdText(10, 0xff4d3a); // REC dot reads hotter than the amber text
    this.recDot.position.set(6, 4);

    this.mood = osdText(10, AMBER_DIM);
    this.mood.anchor.set(1, 0);
    this.mood.position.set(VIEW_W - 6, 15);

    this.mic = osdText(10);
    this.mic.position.set(6, 242);

    this.glyphRow.position.set(VIEW_W - 6, 9);
    this.container.addChild(this.main, this.recDot, this.glyphRow, this.mood, this.mic);

    this.caption = new Text({
      text: '',
      style: {
        fontFamily: VT323,
        fontSize: 16,
        fill: AMBER,
        stroke: { color: 0x140b00, width: 1 },
        align: 'center',
        wordWrap: true,
        wordWrapWidth: 420,
      },
    });
    this.caption.anchor.set(0.5, 0);
    this.caption.position.set(VIEW_W / 2, 212);

    this.tele = osdText(10);
    this.tele.position.set(6, 256);
    this.captionLayer.addChild(this.caption, this.tele);
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

    // module glyph strip (right-aligned) + mood glyph beside it
    const ids = ui.glyphs.join(',');
    if (ids !== this.glyphIds) {
      this.glyphIds = ids;
      this.glyphRow.removeChildren().forEach((c) => c.destroy());
      ui.glyphs.forEach((id: ChipId, i: number) => {
        const sp = new Sprite(tex(this.art, `glyph_${id}`));
        sp.anchor.set(1, 0.5);
        sp.x = -(ui.glyphs.length - 1 - i) * 10;
        this.glyphRow.addChild(sp);
      });
    }
    this.mood.text = ui.moodGlyph;

    // mic state, bottom-left
    if (ui.micState === 'listening') {
      this.mic.text = '● LISTENING';
      this.mic.alpha = 0.55 + 0.45 * Math.sin(this.t * 6);
    } else if (ui.micState === 'thinking') {
      const n = 1 + (Math.floor(this.t * 3) % 3);
      this.mic.text = '· '.repeat(n).trimEnd();
      this.mic.alpha = 0.8;
    } else {
      this.mic.text = '';
    }

    // caption: robot speech, fast per-char typewriter reveal (20ms/char)
    if (ui.caption !== this.capTarget) {
      this.capTarget = ui.caption;
      this.capShown = ui.caption === '' ? 0 : 1;
    }
    this.capShown = Math.min(this.capTarget.length, this.capShown + dt * 50);
    this.caption.text = this.capTarget.slice(0, Math.floor(this.capShown));

    // teletype line + blinking cursor
    const showTele = ui.teletypeActive || ui.teletype.length > 0;
    this.tele.visible = showTele;
    if (showTele) {
      const cursor = ui.teletypeActive && blink ? '█' : ' ';
      this.tele.text = `> ${ui.teletype}${cursor}`;
    }
  }
}
