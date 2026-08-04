/**
 * Overlays: PRESS [SPACE] (phase off), death card (share artifact), title card,
 * and the sticky note — the note lives on `noteLayer`, OUTSIDE the CRT stack
 * (it's paper taped over the monitor, not part of the feed).
 */

import { Container, Graphics, Sprite, Text, Texture, TilingSprite } from 'pixi.js';
import type { ArtAtlas, ChipId, DeathCard, MicHelp, UiState, UpgradeReveal } from '@shared/types';
import { UPGRADE_LAND_MS, VIEW_H, VIEW_W } from '@shared/types';
import { makeRng } from '@shared/rng';
import {
  AMBER,
  AMBER_DIM,
  canvasTex,
  CAVEAT,
  clamp01,
  easeOutCubic,
  frames,
  glowTex,
  lerp,
  tex,
  VT323,
} from './util';

type CeremonyOption = { id: ChipId; name: string; blurb: string };

const NOTE_TEXT = "IF BROKEN: turn the main computer OFF and ON. It's on floor 15. — M.";

// ------------------------------------------------------------ upgrade reveal
/** Icon centre and the OSD strip slot it flies home to. */
const UP_CX = VIEW_W / 2;
const UP_CY = 104;
const UP_HOME_X = VIEW_W - 10; // rightmost slot of Osd.glyphRow
const UP_HOME_Y = 32;
/** 8px glyph blown up to 88px on the feed. */
const UP_SCALE = 11;
const UP_LAND = UPGRADE_LAND_MS / 1000;
const UP_FLY = 0.55; // fly duration, ending exactly on LAND
const UP_FLY_AT = UP_LAND - UP_FLY;
const UP_PARTICLES = 34;

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

  private micCard = new Container();
  private micData: MicHelp | null = null;
  private micT = 0;
  private micBar: Graphics | null = null;
  private micBarLast = -1;
  private micMeterY = 0;
  private micMeterW = 0;

  private upgrade = new Container();
  private upgradeData: UpgradeReveal | null = null;
  private upT = 0;
  private upScrim: Graphics | null = null;
  private upFlash: Graphics | null = null;
  private upRays: Container | null = null;
  private upRings: Sprite[] = [];
  private upIconWrap = new Container();
  private upIcon: Sprite | null = null;
  private upIconGlow: Sprite | null = null;
  private upHead: Text | null = null;
  private upName: Text | null = null;
  private upBlurb: Text | null = null;
  private upParts: Array<{
    s: Sprite;
    base: number;
    vx: number;
    vy: number;
    age: number;
    life: number;
  }> = [];
  private upRingTex: Texture;
  private upGlowTex: Texture;
  private upRng = makeRng(0x51ee);

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

    // Expanding shockwave ring — one texture, scaled per frame. Rebuilding a
    // Graphics circle every frame for a 3-ring burst is not free and this is.
    this.upRingTex = canvasTex(64, 64, (ctx) => {
      ctx.strokeStyle = '#ffb000';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(32, 32, 28, 0, Math.PI * 2);
      ctx.stroke();
    });
    this.upRingTex.source.scaleMode = 'linear';
    this.upGlowTex = glowTex(96, 'rgba(255,190,90,0.55)');

    this.noteText = this.buildNote();
    this.ceremony.visible = false;
    this.card.visible = false;
    this.micCard.visible = false;
    this.upgrade.visible = false;
    this.titleSub = vt(13, AMBER_DIM);
    this.buildTitle();
    this.title.visible = false;

    // The install reveal owns the whole feed while it runs, so it sits above
    // the ceremony/mic cards and below only the death card and title.
    this.container.addChild(this.blackout, this.press, this.hint, this.ceremony, this.micCard, this.upgrade, this.card, this.title);
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

  // ------------------------------------------------------ upgrade reveal

  /**
   * THE moment. A module went in, and for two seconds nothing else on the feed
   * matters: the room dims, the icon lands huge in the middle of the camera
   * with sparks off it, it says what it is — and then it flies up into the OSD
   * module strip and becomes the little glyph that lives there from now on.
   *
   * That last move is the point of the whole thing. The player watches the
   * thing they picked up turn into the thing in the corner, so the corner is
   * never again just decoration.
   */
  private buildUpgrade(d: UpgradeReveal): void {
    this.upgrade.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.upRings.length = 0;
    this.upParts.length = 0;
    this.upIconWrap = new Container();

    this.upScrim = new Graphics().rect(0, 0, VIEW_W, VIEW_H).fill({ color: 0x03040a, alpha: 1 });
    this.upScrim.alpha = 0;
    // Power surge: one additive wash over the feed on the install frame.
    this.upFlash = new Graphics().rect(0, 0, VIEW_W, VIEW_H).fill({ color: 0xffd9a0, alpha: 1 });
    this.upFlash.blendMode = 'add';
    this.upgrade.addChild(this.upScrim, this.upFlash);

    // Slow rotating shine behind the icon — a projector beam, not a sparkle.
    const rays = new Container();
    rays.position.set(UP_CX, UP_CY);
    for (let i = 0; i < 10; i++) {
      const ray = new Sprite(Texture.WHITE);
      ray.tint = AMBER;
      ray.anchor.set(0.5, 0);
      ray.width = 3;
      // Kept INSIDE the halo. Longer than the glow and they stop reading as
      // light and start reading as scratches on the lens.
      ray.height = 76;
      ray.rotation = (i / 10) * Math.PI * 2;
      ray.alpha = i % 2 === 0 ? 0.07 : 0.035;
      ray.blendMode = 'add';
      rays.addChild(ray);
    }
    this.upRays = rays;
    this.upgrade.addChild(rays);

    for (let i = 0; i < 3; i++) {
      const ring = new Sprite(this.upRingTex);
      ring.anchor.set(0.5);
      ring.position.set(UP_CX, UP_CY);
      ring.blendMode = 'add';
      ring.visible = false;
      this.upgrade.addChild(ring);
      this.upRings.push(ring);
    }

    this.upIconGlow = new Sprite(this.upGlowTex);
    this.upIconGlow.anchor.set(0.5);
    this.upIconGlow.blendMode = 'add';
    // Lives INSIDE the icon wrap so it flies home with it — which means its
    // scale is multiplied by UP_SCALE. 0.2 × 96px × 11 ≈ a 210px halo; at 1.0
    // it is a 1000px amber wash that eats the entire feed.
    this.upIconGlow.scale.set(0.2);
    this.upIcon = new Sprite(tex(this.art, `glyph_${d.id}`));
    this.upIcon.anchor.set(0.5);
    this.upIconWrap.addChild(this.upIconGlow, this.upIcon);
    this.upIconWrap.position.set(UP_CX, UP_CY);
    this.upgrade.addChild(this.upIconWrap);

    // Sparks: half chunky art frames, half 1px embers, all thrown outward from
    // under the icon on the same frame the flash goes off.
    const sparkFrames = frames(this.art, 'fx_spark');
    for (let i = 0; i < UP_PARTICLES; i++) {
      const chunky = i % 3 === 0;
      const s = chunky
        ? new Sprite(sparkFrames[i % sparkFrames.length])
        : new Sprite(Texture.WHITE);
      s.anchor.set(0.5);
      // Texture.WHITE is 1×1 — size embers with SCALE, never width/height, so
      // the shrink-out below doesn't fight the sizing.
      const base = chunky ? 1 : 2;
      s.scale.set(base);
      if (!chunky) s.tint = i % 2 === 0 ? AMBER : 0xffe6b0;
      s.blendMode = 'add';
      const ang = (i / UP_PARTICLES) * Math.PI * 2 + this.upRng() * 0.5;
      // Born on the rim of the icon, not under it: sparks that spawn dead
      // centre spend their brightest frames hidden behind 88px of glyph.
      const r0 = 34 + this.upRng() * 14;
      s.position.set(UP_CX + Math.cos(ang) * r0, UP_CY + Math.sin(ang) * r0);
      const spd = 130 + this.upRng() * 220;
      this.upgrade.addChild(s);
      this.upParts.push({
        s,
        base,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        age: 0,
        life: 0.7 + this.upRng() * 0.7,
      });
    }

    this.upHead = vt(11, AMBER_DIM);
    this.upHead.anchor.set(0.5);
    this.upHead.style.letterSpacing = 4;
    this.upHead.text = 'MODULE INSTALLED';
    this.upHead.position.set(UP_CX, 44);

    this.upName = vt(30);
    this.upName.anchor.set(0.5);
    this.upName.style.letterSpacing = 5;
    this.upName.text = d.name.toUpperCase();
    this.upName.position.set(UP_CX, 162);

    this.upBlurb = new Text({
      text: d.blurb,
      style: {
        fontFamily: VT323,
        fontSize: 13,
        fill: AMBER_DIM,
        align: 'center',
        wordWrap: true,
        wordWrapWidth: 300,
      },
    });
    this.upBlurb.anchor.set(0.5, 0);
    this.upBlurb.position.set(UP_CX, 182);

    this.upgrade.addChild(this.upHead, this.upName, this.upBlurb);
  }

  /** Per-frame choreography for the reveal. `this.upT` is seconds since install. */
  private updateUpgrade(dt: number): void {
    const t = this.upT;
    // Flying home: everything but the icon is gone by the time it moves.
    const fly = clamp01((t - UP_FLY_AT) / UP_FLY);
    const flyE = easeOutCubic(fly);

    if (this.upScrim) {
      // In fast, out with the fly — the room comes back as the icon leaves.
      this.upScrim.alpha = 0.82 * clamp01(t / 0.14) * (1 - flyE);
    }
    if (this.upFlash) {
      const f = Math.max(0, 1 - t / 0.28);
      this.upFlash.alpha = f * f * 0.55;
      this.upFlash.visible = f > 0;
    }
    if (this.upRays) {
      this.upRays.rotation += dt * 0.35;
      this.upRays.alpha = clamp01((t - 0.1) / 0.3) * (1 - flyE);
      this.upRays.scale.set(0.8 + 0.2 * clamp01(t / 0.6));
    }

    for (let i = 0; i < this.upRings.length; i++) {
      const ring = this.upRings[i]!;
      const rt = (t - 0.02 - i * 0.16) / 0.85;
      ring.visible = rt > 0 && rt < 1;
      if (!ring.visible) continue;
      const e = easeOutCubic(rt);
      ring.scale.set(0.25 + e * 3.4);
      ring.alpha = (1 - rt) * 0.55;
    }

    for (const p of this.upParts) {
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        p.s.visible = false;
        continue;
      }
      // drag + a little gravity: embers, not fireworks
      p.vx -= p.vx * 2.6 * dt;
      p.vy -= p.vy * 2.6 * dt;
      p.vy += 55 * dt;
      p.s.x += p.vx * dt;
      p.s.y += p.vy * dt;
      p.s.alpha = 1 - k * k;
      p.s.scale.set(p.base * Math.max(0.25, 1 - k * 0.8));
    }

    if (this.upIcon && this.upIconGlow) {
      // pop: overshoot in, then breathe until it leaves
      const pop = clamp01((t - 0.06) / 0.3);
      const b = pop - 1;
      const back = 1 + b * b * (2.7 * b + 1.7); // easeOutBack
      const breathe = 1 + 0.03 * Math.sin((t - 0.36) * 5);
      const big = UP_SCALE * (0.25 + 0.75 * back) * (pop >= 1 ? breathe : 1);
      const s = lerp(big, 1, flyE);
      this.upIconWrap.scale.set(s);
      this.upIconWrap.position.set(
        lerp(UP_CX, UP_HOME_X, flyE),
        lerp(UP_CY, UP_HOME_Y, flyE),
      );
      // hand-off: it vanishes the instant the OSD glyph pops in its place
      this.upIconWrap.alpha = pop * (fly >= 1 ? 0 : 1);
      this.upIconGlow.alpha = (0.55 + 0.25 * Math.sin(t * 7)) * (1 - flyE);
      this.upIconGlow.rotation += dt * 0.6;
    }

    const textOut = 1 - clamp01((t - UP_FLY_AT) / 0.28);
    if (this.upHead) this.upHead.alpha = clamp01((t - 0.14) / 0.25) * 0.9 * textOut;
    if (this.upName) {
      const np = clamp01((t - 0.26) / 0.22);
      this.upName.alpha = np * textOut;
      this.upName.scale.set(lerp(1.35, 1, easeOutCubic(np)));
    }
    if (this.upBlurb) this.upBlurb.alpha = clamp01((t - 0.5) / 0.3) * 0.9 * textOut;
  }

  // -------------------------------------------------------- mic help card

  /**
   * Mic troubleshooting, styled as a maintenance readout on the same feed —
   * never a browser dialog, never breaking the fiction that this is a monitor.
   * Numbered steps, a live input meter at the bottom so the player gets instant
   * feedback the moment the mic starts working, and the teletype escape hatch.
   */
  private buildMicCard(help: MicHelp): void {
    this.micCard.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.micBar = null;
    const W = 300;
    const H = 42 + help.steps.length * 13 + 26;

    const bg = new Graphics()
      .roundRect(0, 0, W, H, 4)
      .fill({ color: 0x060708, alpha: 0.93 })
      .stroke({ color: 0x3a2c08, width: 1 })
      .roundRect(3, 3, W - 6, H - 6, 3)
      .stroke({ color: AMBER, width: 1, alpha: 0.16 });
    const scan = new TilingSprite({ texture: this.cardScanTex, width: W, height: H });
    scan.alpha = 0.5;

    const head = vt(13);
    head.text = 'AUDIO INPUT FAULT';
    head.position.set(12, 8);

    const rule = new Graphics().rect(12, 25, W - 24, 1).fill({ color: AMBER, alpha: 0.18 });

    const why = new Text({
      text: help.title,
      style: { fontFamily: VT323, fontSize: 11, fill: AMBER_DIM, wordWrap: true, wordWrapWidth: W - 24 },
    });
    why.position.set(12, 28);

    this.micCard.addChild(bg, scan, head, rule, why);

    help.steps.forEach((s, i) => {
      const line = new Text({
        text: `${i + 1}. ${s}`,
        style: { fontFamily: VT323, fontSize: 11, fill: AMBER, wordWrap: true, wordWrapWidth: W - 30 },
      });
      line.position.set(16, 44 + i * 13);
      this.micCard.addChild(line);
    });

    const meterY = H - 17;
    this.micMeterY = meterY + 1;
    this.micMeterW = W - 62;
    const meterLabel = vt(10, AMBER_DIM);
    meterLabel.text = 'INPUT';
    meterLabel.position.set(12, meterY - 4);
    const track = new Graphics()
      .rect(48, meterY + 1, W - 60, 4)
      .stroke({ color: AMBER, width: 1, alpha: 0.25 });
    this.micBar = new Graphics();
    this.micBarLast = -1;

    const esc = vt(10, AMBER_DIM);
    esc.anchor.set(1, 0);
    esc.text = 'OR JUST TYPE — [ESC] TO CLOSE';
    esc.position.set(W - 12, 8);
    esc.alpha = 0.75;

    this.micCard.addChild(meterLabel, track, this.micBar, esc);
    this.micCard.x = (VIEW_W - W) / 2;
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

    // upgrade reveal — identity change restarts it, so the same module twice
    // (a restart, a re-install) still plays the whole beat
    if (ui.upgrade) {
      if (ui.upgrade !== this.upgradeData) {
        this.upgradeData = ui.upgrade;
        this.buildUpgrade(ui.upgrade);
        this.upT = 0;
        this.upgrade.visible = true;
      }
      this.upT += dt;
      this.updateUpgrade(dt);
    } else if (this.upgrade.visible) {
      // Cleared — either the beat ended or the world broke under it (death,
      // elevator). Either way it goes NOW: a reveal outliving its floor is worse
      // than a reveal cut short.
      this.upgrade.visible = false;
      this.upgradeData = null;
    } else {
      this.upgradeData = null;
    }

    // mic help card — slides in under the OSD header, live input meter running
    if (ui.micHelp) {
      if (ui.micHelp !== this.micData) {
        const fresh = this.micData === null;
        this.micData = ui.micHelp;
        this.buildMicCard(ui.micHelp);
        if (fresh) this.micT = 0;
        this.micCard.visible = true;
      }
      this.micT = Math.min(1, this.micT + dt / 0.35);
      const e = easeOutCubic(this.micT);
      this.micCard.alpha = e;
      this.micCard.y = lerp(20, 32, e);
      if (this.micBar) {
        // repaint only on visible change — Graphics rebuilds are not free
        const lvl = Math.round(clamp01(ui.micLevel) * 40) / 40;
        if (lvl !== this.micBarLast) {
          this.micBarLast = lvl;
          const w = this.micMeterW * lvl;
          this.micBar.clear();
          if (w > 0) {
            // green the moment ANY signal arrives — that is the whole diagnosis
            this.micBar
              .rect(49, this.micMeterY, w, 3)
              .fill({ color: lvl > 0.04 ? 0x7dff9a : AMBER, alpha: 0.9 });
          }
        }
      }
    } else if (this.micCard.visible) {
      this.micData = null;
      this.micCard.alpha = Math.max(0, this.micCard.alpha - dt / 0.22);
      if (this.micCard.alpha <= 0) this.micCard.visible = false;
    } else {
      this.micData = null;
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
