/**
 * The wishlist gate — the last frame of the game.
 *
 * A finished run does not loop until the player has left an address. It owns
 * its own DOM, styles, keyboard and lifecycle; the director only asks whether
 * it is satisfied and awaits show(). Two laws it must not break:
 *
 *  - The gate is satisfied by a VALID ENTRY, not by the server. If /api/wishlist
 *    is down the player still gets to play — the address is stashed for a later
 *    session to retry. Nothing here may require a backend.
 *  - While it is up the keyboard belongs to it. A keystroke that leaked to the
 *    director would restart the run behind a black overlay (see onWindowKey).
 *
 * Everything ships in the bundle: no CDN, no external font — VT323 is already
 * FontFace-loaded by render/index.ts and reached by family name only.
 */

import type { WishlistRequest } from '@shared/types';
import { apiWishlist } from '../net/api';

const STORE_KEY = 'robot-operator:wishlist';
const PENDING_KEY = 'robot-operator:wishlist-pending';

/** Deliberately explicit and dumb — this is a gate, not an RFC 5322 parser. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL = 254;

const FADE_MS = 400;
/** SENDING… must be seen even when the server answers instantly. */
const MIN_SEND_MS = 420;
/** …and must never hold the player longer than this, server or no server. */
const MAX_SEND_MS = 1200;
const SUCCESS_HOLD_MS = 950;

export interface WishlistContext {
  /** Floor the run ended on. */
  floor: number;
  robotName?: string;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- storage
// Every access is fail-soft: private mode throws on localStorage and the gate
// degrades to an in-memory flag for the session.

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* in-memory only for this session */
  }
}

function dropRaw(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

function storedEmail(): string | null {
  const raw = readRaw(STORE_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { email?: unknown };
    return typeof v.email === 'string' && v.email ? v.email : null;
  } catch {
    return null;
  }
}

/** Best-effort POST. Never throws, never surfaces an error to the player. */
async function send(req: WishlistRequest): Promise<void> {
  try {
    await apiWishlist(req);
    dropRaw(PENDING_KEY);
  } catch {
    /* the address stays in PENDING_KEY for a later session */
  }
}

/** One silent retry of an address a previous session could not deliver. */
function retryPending(): void {
  const raw = readRaw(PENDING_KEY);
  if (!raw) return;
  let req: WishlistRequest | null = null;
  try {
    const v = JSON.parse(raw) as Partial<WishlistRequest>;
    if (typeof v.email === 'string' && EMAIL_RE.test(v.email)) req = v as WishlistRequest;
  } catch {
    /* unreadable — drop it below */
  }
  if (!req) {
    dropRaw(PENDING_KEY);
    return;
  }
  void send(req);
}

// ---------------------------------------------------------------- styles

const CSS = `
.ro-wl {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 20px;
  background: #000;
  color: #ffb000;
  font-family: 'VT323', monospace;
  text-shadow: 0 0 6px rgba(255, 176, 0, 0.35);
  opacity: 0;
  transition: opacity ${FADE_MS}ms linear;
  cursor: default;
}
.ro-wl-in { opacity: 1; }
/* scanlines + a soft tube bloom, both inert to the pointer */
.ro-wl::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    repeating-linear-gradient(to bottom, rgba(255,176,0,0.055) 0 1px, rgba(0,0,0,0) 1px 3px),
    radial-gradient(circle at 50% 44%, rgba(255,176,0,0.05), rgba(0,0,0,0) 62%);
}
.ro-wl-panel {
  position: relative;
  box-sizing: border-box;
  /* 560px read as a modest card on a 1440px demo screen — this is the last
     frame of the game and it should own the monitor, not sit politely in it. */
  width: min(720px, 100%);
  padding: clamp(18px, 4.4vw, 40px);
  border: 1px solid rgba(255, 176, 0, 0.22);
}
.ro-wl-body { animation: ro-wl-glow 6.5s ease-in-out infinite; }
.ro-wl-h {
  margin: 0;
  /* 40px, not more: VT323 is monospace at 0.5em advance, so the 29-character
     heading needs ~603px of the panel's 640px inner width. 44px overflows it
     and wraps "AGAIN." onto a lonely second line. */
  font-size: clamp(22px, 5.4vw, 40px);
  line-height: 1.05;
  letter-spacing: 0.02em;
}
.ro-wl-sub {
  margin-top: 6px;
  color: #b87f00;
  font-size: clamp(14px, 3.2vw, 23px);
  line-height: 1.15;
}
.ro-wl-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: clamp(18px, 4vw, 28px);
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 176, 0, 0.28);
}
.ro-wl-caret { color: #b87f00; font-size: clamp(18px, 4.4vw, 26px); }
.ro-wl-field {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #ffb000;
  caret-color: #ffb000;
  font-family: inherit;
  font-size: clamp(18px, 4.4vw, 26px);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  text-shadow: inherit;
  border-radius: 0;
  -webkit-appearance: none;
  appearance: none;
  /* the page sets user-select:none on body — typing and paste need it back */
  -webkit-user-select: text;
  user-select: text;
}
.ro-wl-field::placeholder { color: rgba(184, 127, 0, 0.5); opacity: 1; }
.ro-wl-msg {
  min-height: 1.4em;
  margin-top: 10px;
  color: #b87f00;
  font-size: clamp(13px, 3vw, 18px);
}
.ro-wl-msg.ro-wl-ok { color: #ffb000; }
.ro-wl-msg.ro-wl-warn { color: #ff4d3a; text-shadow: 0 0 6px rgba(255, 77, 58, 0.4); }
.ro-wl-cta {
  display: inline-block;
  margin-top: clamp(12px, 2.8vw, 20px);
  padding: 4px 12px 6px;
  border: 1px solid rgba(255, 176, 0, 0.35);
  font-size: clamp(13px, 3vw, 17px);
  animation: ro-wl-pulse 2.4s ease-in-out infinite;
}
/* visibility, not display — the panel must not jump as the state changes */
.ro-wl-cta.ro-wl-gone { visibility: hidden; }
.ro-wl-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin-top: clamp(16px, 3.6vw, 26px);
  color: #b87f00;
  font-size: clamp(11px, 2.6vw, 15px);
}
.ro-wl-foot b { color: #ffb000; font-weight: normal; }
@keyframes ro-wl-glow {
  0%, 100% { opacity: 1; }
  46% { opacity: 0.965; }
  62% { opacity: 0.995; }
  71% { opacity: 0.93; }
  76% { opacity: 1; }
}
@keyframes ro-wl-pulse {
  0%, 100% { border-color: rgba(255, 176, 0, 0.14); }
  50% { border-color: rgba(255, 176, 0, 0.5); }
}
@keyframes ro-wl-shake {
  0% { transform: translateX(0); }
  25% { transform: translateX(-3px); }
  75% { transform: translateX(3px); }
  100% { transform: translateX(0); }
}
.ro-wl-shake { animation: ro-wl-shake 200ms steps(2, end) 2; }
@media (prefers-reduced-motion: reduce) {
  .ro-wl { transition: none; }
  .ro-wl-body, .ro-wl-cta, .ro-wl-shake { animation: none; }
}
`;

let styleEl: HTMLStyleElement | null = null;

function ensureStyle(): void {
  if (styleEl?.isConnected) return;
  styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
}

// ---------------------------------------------------------------- the gate

export class WishlistGate {
  private root: HTMLDivElement | null = null;
  private panel: HTMLDivElement | null = null;
  private field: HTMLInputElement | null = null;
  private msg: HTMLDivElement | null = null;
  private cta: HTMLDivElement | null = null;

  private ctx: WishlistContext = { floor: 1 };
  private done: boolean;
  private readonly bypassed: boolean;
  private busy = false;
  private closing = false;
  private pending: Promise<void> | null = null;
  private settle: (() => void) | null = null;
  private fadeGuard: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // ?nowishlist=1 is the dev/demo escape hatch. DEV alone must NOT bypass —
    // the gate has to be testable in the mode it is developed in.
    let bypass = false;
    try {
      bypass = new URLSearchParams(location.search).get('nowishlist') === '1';
    } catch {
      /* no location — treated as no bypass */
    }
    this.bypassed = bypass;
    this.done = storedEmail() !== null;
    if (!this.bypassed && typeof window !== 'undefined') retryPending();
  }

  /** True when the player may loop straight back into a run. */
  get satisfied(): boolean {
    return this.bypassed || this.done;
  }

  /** True while the overlay owns the screen and the keyboard. */
  get open(): boolean {
    return this.root !== null;
  }

  /** Resolves once the address is in — the caller restarts then. */
  show(ctx: WishlistContext): Promise<void> {
    if (this.pending) return this.pending;
    if (this.satisfied) return Promise.resolve();
    this.ctx = ctx;
    this.build();
    this.pending = new Promise<void>((res) => {
      this.settle = res;
    });
    return this.pending;
  }

  /** Tear-down without letting the run through — the promise stays unsettled. */
  destroy(): void {
    this.settle = null;
    this.teardown();
    this.pending = null;
  }

  // -------------------------------------------------------------- internals

  private build(): void {
    ensureStyle();

    const root = document.createElement('div');
    root.className = 'ro-wl';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Leave an email address');
    // Static markup only — every player-derived value goes in via textContent.
    root.innerHTML =
      '<div class="ro-wl-panel"><div class="ro-wl-body">' +
      '<h1 class="ro-wl-h">ROBOT WANTS TO SEE YOU AGAIN.</h1>' +
      '<div class="ro-wl-sub">LEAVE ADDRESS. ROBOT WILL WRITE.</div>' +
      '<div class="ro-wl-row"><span class="ro-wl-caret">&gt;</span>' +
      '<input class="ro-wl-field" type="email" name="email" placeholder="YOU@SOMEWHERE.COM" ' +
      'autocomplete="email" inputmode="email" spellcheck="false" autocapitalize="off" ' +
      'autocorrect="off" maxlength="254" aria-label="Email address" /></div>' +
      '<div class="ro-wl-msg"></div>' +
      '<div class="ro-wl-cta">[ENTER] &mdash; SEND</div>' +
      '<div class="ro-wl-foot"></div>' +
      '</div></div>';

    this.root = root;
    this.panel = root.querySelector('.ro-wl-panel');
    this.field = root.querySelector('.ro-wl-field');
    this.msg = root.querySelector('.ro-wl-msg');
    this.cta = root.querySelector('.ro-wl-cta');

    const foot = root.querySelector('.ro-wl-foot');
    if (foot) {
      const name = document.createElement('span');
      name.append('ROBOT ');
      const nameV = document.createElement('b');
      nameV.textContent = (this.ctx.robotName || 'ROBOT').toUpperCase();
      name.append(nameV);
      const floor = document.createElement('span');
      floor.append('LAST FLOOR ');
      const floorV = document.createElement('b');
      floorV.textContent = String(this.ctx.floor).padStart(2, '0');
      floor.append(floorV);
      foot.append(name, floor);
    }

    // Layer 1: nothing that happens inside the overlay reaches window.
    root.addEventListener('keydown', this.onRootKeyDown);
    root.addEventListener('keyup', this.onSwallow);
    root.addEventListener('keypress', this.onSwallow);
    root.addEventListener('mousedown', this.onRootMouseDown);
    // Layer 2: focus that escaped to the page cannot type into the game either.
    window.addEventListener('keydown', this.onWindowKey, true);
    window.addEventListener('keyup', this.onWindowKey, true);
    this.field?.addEventListener('blur', this.onFieldBlur);

    document.body.appendChild(root);
    // Flush layout so the transition has a start value, then go — deliberately
    // NOT requestAnimationFrame: Chrome suspends rAF for frames it considers
    // non-rendered, and a gate stuck at opacity 0 still eats every keystroke.
    // A black hole is the one failure this overlay must not have.
    void root.offsetWidth;
    root.classList.add('ro-wl-in');
    // Last-ditch: timers fire even where animation frames are suspended, so the
    // overlay is guaranteed visible shortly after it starts eating keystrokes.
    // (The transition has to go too: a suspended animation clock pins a running
    // transition at its start value no matter what the specified opacity is.)
    this.fadeGuard = setTimeout(() => {
      if (!this.root || this.closing) return;
      this.root.style.transition = 'none';
      this.root.style.opacity = '1';
    }, FADE_MS + 120);
    this.field?.focus();
  }

  private onRootKeyDown = (e: KeyboardEvent): void => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      void this.submit();
      return;
    }
    // No escape, no close button — that is the point.
    if (e.key === 'Escape') e.preventDefault();
  };

  private onSwallow = (e: Event): void => {
    e.stopPropagation();
  };

  private onRootMouseDown = (e: MouseEvent): void => {
    if (e.target === this.field) return;
    e.preventDefault(); // keep focus in the field instead of dropping it on body
    this.field?.focus();
  };

  /**
   * Keys aimed at anything outside the overlay (body, after a stray blur) are
   * stopped in the capture phase, before the director's window listeners see
   * them, and re-routed into the field. Without this a keystroke behind the
   * black overlay would restart the run.
   */
  private onWindowKey = (e: KeyboardEvent): void => {
    const root = this.root;
    if (!root) return;
    const target = e.target as Node | null;
    if (target && root.contains(target)) return; // handled by the overlay itself
    e.stopPropagation();
    e.preventDefault();
    if (this.busy || this.closing || !this.field) return;
    if (e.type !== 'keydown') return;
    this.field.focus();
    if (e.key === 'Enter') {
      void this.submit();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.field.value = (this.field.value + e.key).slice(0, MAX_EMAIL);
    }
  };

  private onFieldBlur = (): void => {
    if (!this.root || this.closing) return;
    // The field is the only place a keystroke may land while the gate is up.
    setTimeout(() => {
      if (this.root && !this.closing) this.field?.focus();
    }, 0);
  };

  private setMsg(text: string, tone: 'dim' | 'ok' | 'warn'): void {
    if (!this.msg) return;
    this.msg.textContent = text;
    this.msg.className = `ro-wl-msg${tone === 'ok' ? ' ro-wl-ok' : tone === 'warn' ? ' ro-wl-warn' : ''}`;
  }

  private refuse(): void {
    this.setMsg('ROBOT CANNOT READ THAT.', 'warn');
    const panel = this.panel;
    if (!panel) return;
    panel.classList.remove('ro-wl-shake');
    void panel.offsetWidth; // restart the animation
    panel.classList.add('ro-wl-shake');
    setTimeout(() => panel.classList.remove('ro-wl-shake'), 500);
  }

  private async submit(): Promise<void> {
    if (this.busy || this.closing || !this.field) return;
    const email = this.field.value.trim().toLowerCase();
    if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
      this.refuse();
      return;
    }

    this.busy = true;
    this.field.readOnly = true; // readOnly, not disabled — focus stays trapped
    this.setMsg('ROBOT WRITES IT DOWN…', 'dim');
    this.cta?.classList.add('ro-wl-gone');

    // Satisfied by the entry, not by the server: mark it before the request.
    this.done = true;
    const at = Date.now();
    writeRaw(STORE_KEY, JSON.stringify({ email, at }));
    const req: WishlistRequest = {
      email,
      floor: this.ctx.floor,
      ...(this.ctx.robotName ? { robotName: this.ctx.robotName } : {}),
    };
    writeRaw(PENDING_KEY, JSON.stringify({ ...req, at })); // send() clears it on success

    const started = Date.now();
    await Promise.race([send(req), delay(MAX_SEND_MS)]);
    const left = MIN_SEND_MS - (Date.now() - started);
    if (left > 0) await delay(left);

    this.setMsg('ROBOT SAVED IT. ROBOT NEVER FORGETS.', 'ok');
    await delay(SUCCESS_HOLD_MS);
    this.close();
  }

  private close(): void {
    if (this.closing) return;
    this.closing = true;
    if (this.fadeGuard) clearTimeout(this.fadeGuard);
    this.fadeGuard = null;
    if (this.root) {
      // drop whatever the guard forced, so the fade-out can run normally
      this.root.style.transition = '';
      this.root.style.opacity = '';
      void this.root.offsetWidth;
    }
    this.root?.classList.remove('ro-wl-in');
    const settle = this.settle;
    setTimeout(() => {
      this.teardown();
      this.pending = null;
      this.settle = null;
      settle?.();
    }, FADE_MS);
  }

  private teardown(): void {
    if (this.fadeGuard) clearTimeout(this.fadeGuard);
    this.fadeGuard = null;
    const root = this.root;
    if (!root) return;
    root.removeEventListener('keydown', this.onRootKeyDown);
    root.removeEventListener('keyup', this.onSwallow);
    root.removeEventListener('keypress', this.onSwallow);
    root.removeEventListener('mousedown', this.onRootMouseDown);
    window.removeEventListener('keydown', this.onWindowKey, true);
    window.removeEventListener('keyup', this.onWindowKey, true);
    this.field?.removeEventListener('blur', this.onFieldBlur);
    root.remove();
    this.root = null;
    this.panel = null;
    this.field = null;
    this.msg = null;
    this.cta = null;
    this.busy = false;
    this.closing = false;
  }
}
