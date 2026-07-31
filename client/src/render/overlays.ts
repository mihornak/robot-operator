/**
 * Overlays: PRESS [SPACE] (phase off), death card (share artifact), title card,
 * and the sticky note — the note lives on `noteLayer`, OUTSIDE the CRT stack
 * (it's paper taped over the monitor, not part of the feed).
 */

import { Container, Graphics, Sprite, Text, type Texture, TilingSprite } from 'pixi.js';
import type { ArtAtlas, DeathCard, UiState } from '@shared/types';
import { VIEW_H, VIEW_W } from '@shared/types';
import { AMBER, AMBER_DIM, canvasTex, CAVEAT, clamp01, easeOutCubic, frames, lerp, tex, VT323 } from './util';

const NOTE_TEXT = "IF BROKEN: turn the main computer OFF and ON. It's on floor 15. — M.";

function vt(size: number, color: number = AMBER): Text {
  return new Text({ text: '', style: { fontFamily: VT323, fontSize: size, fill: color } });
}

export class Overlays {
  readonly container = new Container(); // in-feed overlays
  readonly noteLayer = new Container(); // screen-space, outside CRT

  private blackout: Graphics;
  private press: Text;
  private offT = 0;

  private hint: Text;
  private hintA = 0;

  private noteText: Text;

  private card = new Container();
  private cardData: DeathCard | null = null;
  private cardT = 0;
  private pressAny: Text | null = null;
  private cardScanTex: Texture;

  private title = new Container();
  private titleT = -1;
  private noteFallV = -1;
  private titleSub: Text;

  private t = 0;

  constructor(private art: ArtAtlas) {
    this.blackout = new Graphics().rect(0, 0, VIEW_W, VIEW_H).fill(0x000000);
    this.press = vt(12, 0x9a7a2a);
    this.press.anchor.set(0.5);
    this.press.position.set(VIEW_W / 2, VIEW_H / 2);
    this.press.text = 'PRESS [SPACE]';
    this.press.alpha = 0;

    this.hint = vt(12, 0x9a7a2a);
    this.hint.anchor.set(0.5);
    this.hint.position.set(VIEW_W / 2, 196); // lower third, above the caption line
    this.hint.text = 'HOLD [SPACE] TO TALK';
    this.hint.alpha = 0;

    this.cardScanTex = canvasTex(1, 2, (ctx) => {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 1, 1, 1);
    });

    this.noteText = this.buildNote();
    this.card.visible = false;
    this.titleSub = vt(13, AMBER_DIM);
    this.buildTitle();
    this.title.visible = false;

    this.container.addChild(this.blackout, this.press, this.hint, this.card, this.title);
  }

  /** Note is physical paper: crisp above the chunky feed. Set on resize. */
  setNoteResolution(res: number): void {
    this.noteText.resolution = Math.max(1, Math.min(4, res));
  }

  // ---------------------------------------------------------- sticky note

  private buildNote(): Text {
    const note = new Container();
    note.position.set(VIEW_W - 100, 6);
    note.rotation = -4 * (Math.PI / 180);

    const paper = new Graphics()
      .roundRect(0, 0, 94, 68, 2)
      .fill(0xf1e7ae)
      .roundRect(0, 62, 94, 6, 2)
      .fill(0xe3d795); // bottom curl shading
    const shadow = new Graphics().roundRect(2, 3, 94, 68, 2).fill({ color: 0x000000, alpha: 0.4 });

    const text = new Text({
      text: NOTE_TEXT,
      style: {
        fontFamily: CAVEAT,
        fontSize: 13,
        fill: 0x27273a,
        wordWrap: true,
        wordWrapWidth: 84,
        lineHeight: 14,
      },
    });
    text.position.set(5, 3);

    const tape = new Graphics().rect(-13, -4, 26, 9).fill({ color: 0xd8dade, alpha: 0.5 });
    tape.position.set(47, 0);
    tape.rotation = 0.05;

    note.addChild(shadow, paper, text, tape);
    this.noteLayer.addChild(note);
    return text;
  }

  // ----------------------------------------------------------- death card

  private buildCard(d: DeathCard): void {
    this.card.removeChildren().forEach((c) => c.destroy({ children: true }));
    const W = 368;
    const H = 216;

    const bg = new Graphics()
      .roundRect(0, 0, W, H, 4)
      .fill({ color: 0x060708, alpha: 0.97 })
      .stroke({ color: 0x3a2c08, width: 1 })
      .roundRect(3, 3, W - 6, H - 6, 3)
      .stroke({ color: AMBER, width: 1, alpha: 0.16 });

    const scan = new TilingSprite({ texture: this.cardScanTex, width: W, height: H });
    scan.alpha = 0.6;

    // robot portrait, dimmed — composed from the art frames
    const portrait = new Container();
    const wheels = new Sprite(frames(this.art, 'robot_wheels')[0]);
    const body = new Sprite(frames(this.art, 'robot_body')[0]);
    const head = new Sprite(frames(this.art, 'robot_head')[2]); // S — facing the operator
    for (const s of [wheels, body, head]) {
      s.anchor.set(0.5);
      s.tint = 0xa2a2ac;
    }
    wheels.y = 10;
    body.y = -2;
    head.y = -20;
    portrait.scale.set(2.4);
    portrait.position.set(52, 96);
    const halo = new Graphics().circle(52, 96, 34).stroke({ color: AMBER, width: 1, alpha: 0.14 });

    const name = vt(24);
    name.text = (d.robotName || 'ROBOT').toUpperCase();
    name.position.set(104, 16);

    const floor = vt(12, AMBER_DIM);
    floor.text = `FLOOR ${String(d.floor).padStart(2, '0')}`;
    floor.position.set(104, 44);

    const heardL = vt(10, AMBER_DIM);
    heardL.text = 'HEARD:';
    heardL.position.set(104, 70);
    const heard = vt(13);
    heard.text = d.heard;
    heard.position.set(150, 68);

    const didL = vt(10, AMBER_DIM);
    didL.text = 'DID:';
    didL.position.set(104, 92);
    const did = vt(13);
    did.text = d.did;
    did.position.set(150, 90);

    const last = new Text({
      text: `“${d.lastWords}”`,
      style: {
        fontFamily: VT323,
        fontSize: 15,
        fill: AMBER,
        align: 'center',
        wordWrap: true,
        wordWrapWidth: 320,
      },
    });
    last.anchor.set(0.5, 0);
    last.position.set(W / 2, 128);

    const scrapSp = new Sprite(tex(this.art, 'scrap'));
    scrapSp.anchor.set(0, 0.5);
    scrapSp.position.set(104, 176);
    const scrap = vt(12, AMBER_DIM);
    scrap.text = `SCRAP × ${d.scrap}`;
    scrap.position.set(118, 170);

    this.pressAny = vt(11, AMBER_DIM);
    this.pressAny.anchor.set(0.5);
    this.pressAny.text = 'PRESS ANY KEY';
    this.pressAny.position.set(W / 2, H - 16);

    this.card.addChild(bg, scan, halo, portrait, name, floor, heardL, heard, didL, did, last, scrapSp, scrap, this.pressAny);
    portrait.addChild(wheels, body, head);
    this.card.x = (VIEW_W - W) / 2;
  }

  // ---------------------------------------------------------------- title

  private buildTitle(): void {
    const mk = (scale: number, alpha: number): Text => {
      const g = new Text({
        text: 'ROBOT OPERATOR',
        style: { fontFamily: VT323, fontSize: 40, fill: AMBER, letterSpacing: 8 },
      });
      g.anchor.set(0.5);
      g.position.set(VIEW_W / 2, 118);
      g.scale.set(scale);
      g.alpha = alpha;
      if (scale !== 1) g.blendMode = 'add'; // layered alpha copies = cheap glow
      return g;
    };
    this.title.addChild(mk(1.09, 0.08), mk(1.035, 0.17), mk(1, 1));

    this.titleSub.text = 'TO BE CONTINUED';
    this.titleSub.anchor.set(0.5);
    this.titleSub.style.letterSpacing = 6;
    this.titleSub.position.set(VIEW_W / 2, 164);
    this.title.addChild(this.titleSub);
  }

  // ------------------------------------------------------------ per frame

  update(ui: UiState, dt: number): void {
    this.t += dt;

    // phase off: black + dim PRESS [SPACE], fading in after 1s
    const off = ui.phase === 'off';
    this.blackout.visible = off;
    this.press.visible = off;
    if (off) {
      this.offT += dt;
      this.press.alpha =
        clamp01((this.offT - 1) / 1.2) * 0.85 * (0.9 + 0.1 * Math.sin(this.t * 13));
    } else {
      this.offT = 0;
    }

    // onboarding hint: fades with ui.talkHint, same breathing as PRESS [SPACE]
    this.hintA = clamp01(this.hintA + (ui.talkHint ? dt / 0.5 : -dt / 0.35));
    this.hint.alpha = this.hintA * 0.8 * (0.92 + 0.08 * Math.sin(this.t * 5));
    this.hint.visible = this.hintA > 0.01;

    // Note falls off the monitor when stickyNote flips false (boot thunk).
    if (ui.stickyNote) {
      this.noteLayer.visible = true;
      this.noteFallV = -1;
    } else if (this.noteLayer.visible) {
      const note = this.noteLayer.children[0];
      if (note) {
        if (this.noteFallV < 0) this.noteFallV = 0;
        this.noteFallV += 620 * dt; // gravity, logical px/s²
        note.y += this.noteFallV * dt;
        note.x += 6 * dt; // slight drift as it peels
        note.rotation += 0.9 * dt;
        if (note.y > VIEW_H + 90) this.noteLayer.visible = false;
      } else {
        this.noteLayer.visible = false;
      }
    }

    // death card slide-in
    if (ui.deathCard) {
      if (ui.deathCard !== this.cardData) {
        // lastWords arrive as a NEW object ~900ms in — rebuild the content but
        // only restart the slide when the card comes up from hidden
        const fresh = this.cardData === null;
        this.cardData = ui.deathCard;
        this.buildCard(ui.deathCard);
        if (fresh) this.cardT = 0;
        this.card.visible = true;
      }
      this.cardT = Math.min(1, this.cardT + dt / 0.55);
      this.card.y = lerp(VIEW_H + 12, 26, easeOutCubic(this.cardT));
      if (this.pressAny) this.pressAny.visible = this.t % 1.2 < 0.7;
    } else {
      this.cardData = null;
      this.card.visible = false;
    }

    // title over dead static
    if (ui.phase === 'title') {
      if (this.titleT < 0) this.titleT = 0;
      this.titleT += dt;
      this.title.visible = true;
      this.title.alpha = clamp01(this.titleT / 0.6);
      this.titleSub.alpha = clamp01((this.titleT - 1.4) / 0.8);
    } else {
      this.titleT = -1;
      this.title.visible = false;
    }
  }
}
