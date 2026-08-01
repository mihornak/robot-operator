/**
 * Overlays: PRESS [SPACE] (phase off), death card (share artifact), title card,
 * and the sticky note — the note lives on `noteLayer`, OUTSIDE the CRT stack
 * (it's paper taped over the monitor, not part of the feed).
 */

import { Container, Graphics, Sprite, Text, type Texture, TilingSprite } from 'pixi.js';
import type { ArtAtlas, ChipId, DeathCard, UiState } from '@shared/types';
import { VIEW_H, VIEW_W } from '@shared/types';
import { AMBER, AMBER_DIM, canvasTex, CAVEAT, clamp01, easeOutCubic, frames, lerp, tex, VT323 } from './util';

type CeremonyOption = { id: ChipId; name: string; blurb: string };

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

  private ceremony = new Container();
  private ceremonyData: CeremonyOption[] | null = null;
  private ceremonyT = 0;
  private ceremonyCols: Container[] = [];
  private ceremonySay: Text | null = null;

  private card = new Container();
  private cardData: DeathCard | null = null;
  private cardT = 0;
  private pressAny: Text | null = null;
  private pressAnyBox: Graphics | null = null;
  private cardRecDot: Text | null = null;
  private cardScanTex: Texture;

  private title = new Container();
  private titleWord = new Container();
  private titleT = -1;
  private noteFallV = -1;
  private titleSub: Text;
  private titleSubShown = -1;

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
    this.ceremony.visible = false;
    this.card.visible = false;
    this.titleSub = vt(13, AMBER_DIM);
    this.buildTitle();
    this.title.visible = false;

    this.container.addChild(this.blackout, this.press, this.hint, this.ceremony, this.card, this.title);
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

  // ------------------------------------------------------- ceremony card

  /**
   * Triad options card — same CRT family as the death card, upper third of the
   * feed (y ~34..108: below the OSD header, above the caption rows). Three
   * columns: glyph, spoken NAME large, blurb small+dim. Selection stays
   * voice-only — the footer just says so.
   */
  private buildCeremony(opts: CeremonyOption[]): void {
    this.ceremony.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.ceremonyCols.length = 0;
    const W = 320;
    const H = 74;

    const bg = new Graphics()
      .roundRect(0, 0, W, H, 4)
      .fill({ color: 0x060708, alpha: 0.9 })
      .stroke({ color: 0x3a2c08, width: 1 })
      .roundRect(3, 3, W - 6, H - 6, 3)
      .stroke({ color: AMBER, width: 1, alpha: 0.16 });

    const scan = new TilingSprite({ texture: this.cardScanTex, width: W, height: H });
    scan.alpha = 0.5;
    this.ceremony.addChild(bg, scan);

    const colW = W / Math.max(1, opts.length);
    // faint separators between the columns
    for (let i = 1; i < opts.length; i++) {
      const sep = new Graphics().rect(0, 0, 1, H - 28).fill({ color: AMBER, alpha: 0.08 });
      sep.position.set(Math.round(colW * i), 12);
      this.ceremony.addChild(sep);
    }

    for (let i = 0; i < opts.length; i++) {
      const o = opts[i]!;
      const col = new Container();
      col.position.set(colW * (i + 0.5), 36); // children centered on col origin → pop scales in place

      const glyph = new Sprite(tex(this.art, `glyph_${o.id}`));
      glyph.anchor.set(0.5);
      glyph.scale.set(2);
      glyph.y = -22;

      const name = vt(16);
      name.anchor.set(0.5);
      name.text = o.name.toUpperCase();
      name.y = -6;

      const blurb = new Text({
        text: o.blurb,
        style: {
          fontFamily: VT323,
          fontSize: 10,
          fill: AMBER_DIM,
          align: 'center',
          wordWrap: true,
          wordWrapWidth: colW - 14,
        },
      });
      blurb.anchor.set(0.5, 0);
      blurb.alpha = 0.85;
      blurb.y = 4;

      col.addChild(glyph, name, blurb);
      col.alpha = 0; // pops in staggered, in update
      this.ceremony.addChild(col);
      this.ceremonyCols.push(col);
    }

    this.ceremonySay = vt(10, AMBER_DIM);
    this.ceremonySay.anchor.set(0.5);
    this.ceremonySay.text = 'SAY A WORD';
    this.ceremonySay.position.set(W / 2, H - 9);
    this.ceremonySay.visible = false;
    this.ceremony.addChild(this.ceremonySay);

    this.ceremony.x = (VIEW_W - W) / 2;
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

    // 1px amber border pulsing gently around PRESS ANY KEY
    const paW = this.pressAny.width + 12;
    const paH = this.pressAny.height + 4;
    this.pressAnyBox = new Graphics()
      .roundRect(W / 2 - paW / 2, H - 16 - paH / 2, paW, paH, 2)
      .stroke({ color: AMBER, width: 1 });
    this.pressAnyBox.alpha = 0.1;

    // the camera kept recording — slow REC ● in the card's corner
    const recL = vt(10, AMBER_DIM);
    recL.anchor.set(1, 0);
    recL.text = 'REC';
    recL.alpha = 0.8;
    recL.position.set(W - 24, 10);
    this.cardRecDot = vt(10, 0xff4d3a);
    this.cardRecDot.text = '●';
    this.cardRecDot.position.set(W - 20, 10);

    this.card.addChild(bg, scan, halo, portrait, name, floor, heardL, heard, didL, did, last, scrapSp, scrap, this.pressAnyBox, this.pressAny, recL, this.cardRecDot);
    portrait.addChild(wheels, body, head);
    this.card.x = (VIEW_W - W) / 2;
  }

  // ---------------------------------------------------------------- title

  private buildTitle(): void {
    const mk = (dx: number, dy: number, alpha: number): Text => {
      const g = new Text({
        text: 'ROBOT OPERATOR',
        style: { fontFamily: VT323, fontSize: 40, fill: AMBER, letterSpacing: 8 },
      });
      g.anchor.set(0.5);
      g.position.set(VIEW_W / 2 + dx, 118 + dy);
      g.alpha = alpha;
      if (dx !== 0 || dy !== 0) g.blendMode = 'add'; // layered offset copies = cheap glow
      return g;
    };
    // diamond-pattern halo: 1px ring bright, 2px ring faint — no boxy scale ghost
    this.titleWord.addChild(
      mk(2, 0, 0.05), mk(-2, 0, 0.05), mk(0, 2, 0.05), mk(0, -2, 0.05),
      mk(1, 0, 0.12), mk(-1, 0, 0.12), mk(0, 1, 0.12), mk(0, -1, 0.12),
      mk(0, 0, 1),
    );
    this.title.addChild(this.titleWord);

    // measure at full text, then left-anchor so the typewriter reveal stays put
    this.titleSub.text = 'TO BE CONTINUED';
    this.titleSub.style.letterSpacing = 6;
    this.titleSub.anchor.set(0, 0);
    this.titleSub.position.set(VIEW_W / 2 - this.titleSub.width / 2, 156);
    this.titleSub.text = '';
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
      this.press.y = VIEW_H / 2 + 2 * Math.sin(this.t * 1.7); // slow bob invites the eye
    } else {
      this.offT = 0;
    }

    // onboarding hint: fades with ui.talkHint, same breathing as PRESS [SPACE]
    this.hintA = clamp01(this.hintA + (ui.talkHint ? dt / 0.5 : -dt / 0.35));
    this.hint.alpha = this.hintA * 0.8 * (0.92 + 0.08 * Math.sin(this.t * 5));
    this.hint.visible = this.hintA > 0.01;
    this.hint.y = 196 + 2 * Math.sin(this.t * 1.7 + 1.3);

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

    // ceremony options card: slide/fade in 300ms, columns pop staggered 80ms
    if (ui.ceremonyOptions) {
      if (ui.ceremonyOptions !== this.ceremonyData) {
        // options may arrive as a new array mid-ceremony (re-read) — rebuild
        // content but only restart the slide when coming up from hidden
        const fresh = this.ceremonyData === null;
        this.ceremonyData = ui.ceremonyOptions;
        this.buildCeremony(ui.ceremonyOptions);
        if (fresh) this.ceremonyT = 0;
        this.ceremony.visible = true;
      }
      this.ceremonyT += dt;
      const e = easeOutCubic(clamp01(this.ceremonyT / 0.3));
      this.ceremony.alpha = e;
      this.ceremony.y = lerp(24, 34, e);
      for (let i = 0; i < this.ceremonyCols.length; i++) {
        const col = this.ceremonyCols[i]!;
        const cp = clamp01((this.ceremonyT - 0.1 - i * 0.08) / 0.2);
        const b = cp - 1;
        col.scale.set(0.6 + 0.4 * (1 + b * b * (2.7 * b + 1.7))); // easeOutBack pop
        col.alpha = cp;
      }
      if (this.ceremonySay) {
        // dim footer, slow blink — the only prompt; selection is voice-only
        this.ceremonySay.visible = this.ceremonyT > 0.55 && this.t % 2.4 < 1.6;
      }
    } else if (this.ceremony.visible) {
      this.ceremonyData = null;
      this.ceremony.alpha = Math.max(0, this.ceremony.alpha - dt / 0.25);
      this.ceremony.y -= 10 * dt; // drifts up as it fades
      if (this.ceremony.alpha <= 0) this.ceremony.visible = false;
    } else {
      this.ceremonyData = null;
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
      if (this.pressAnyBox)
        this.pressAnyBox.alpha = 0.1 + 0.1 * (0.5 + 0.5 * Math.sin(this.t * 2.6));
      if (this.cardRecDot) this.cardRecDot.visible = this.t % 1.8 < 1.0; // slow — still recording
    } else {
      this.cardData = null;
      this.card.visible = false;
    }

    // title over dead static
    if (ui.phase === 'title') {
      if (this.titleT < 0) {
        this.titleT = 0;
        this.titleSubShown = 0;
        this.titleSub.text = '';
      }
      this.titleT += dt;
      this.title.visible = true;
      this.title.alpha = clamp01(this.titleT / 0.6);
      // 0.3Hz breathe on the wordmark
      this.titleWord.alpha = 0.9 + 0.1 * Math.sin(this.titleT * Math.PI * 0.6);
      // TO BE CONTINUED types itself out after the beat
      if (this.titleT > 1.4) {
        const shown = Math.min(15, this.titleSubShown + dt * 16);
        if (Math.floor(shown) !== Math.floor(this.titleSubShown)) {
          this.titleSub.text = 'TO BE CONTINUED'.slice(0, Math.floor(shown));
        }
        this.titleSubShown = shown;
        this.titleSub.alpha = 1;
      } else {
        this.titleSub.alpha = 0;
      }
    } else {
      this.titleT = -1;
      this.title.visible = false;
    }
  }
}
