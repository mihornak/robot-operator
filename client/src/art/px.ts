/** Tiny pixel-plot helper over a 2d context. All art draws through this. */

export type Drawer = (p: Px, frame: number) => void;

/** Deterministic 0..1 hash — art must not boil between runs. */
export function hash01(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class Px {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    readonly w: number,
    readonly h: number,
  ) {}

  /** Single pixel. */
  p(x: number, y: number, c: string): void {
    this.ctx.fillStyle = c;
    this.ctx.fillRect(x, y, 1, 1);
  }

  /** Filled rect. */
  r(x: number, y: number, w: number, h: number, c: string): void {
    this.ctx.fillStyle = c;
    this.ctx.fillRect(x, y, w, h);
  }

  /** Horizontal line. */
  hl(x: number, y: number, w: number, c: string): void {
    this.r(x, y, w, 1, c);
  }

  /** Vertical line. */
  vl(x: number, y: number, h: number, c: string): void {
    this.r(x, y, 1, h, c);
  }

  /** 1px rect outline. */
  box(x: number, y: number, w: number, h: number, c: string): void {
    this.hl(x, y, w, c);
    this.hl(x, y + h - 1, w, c);
    this.vl(x, y + 1, h - 2, c);
    this.vl(x + w - 1, y + 1, h - 2, c);
  }

  /** Filled pixel circle via row spans. */
  disc(cx: number, cy: number, rad: number, c: string): void {
    for (let dy = -rad; dy <= rad; dy++) {
      const span = Math.floor(Math.sqrt(rad * rad - dy * dy) + 0.5);
      this.hl(cx - span, cy + dy, span * 2 + 1, c);
    }
  }

  /** Punch a transparent disc (for hollow smoke rings). */
  hole(cx: number, cy: number, rad: number): void {
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'destination-out';
    this.disc(cx, cy, rad, '#000');
    this.ctx.restore();
  }

  /** 50% checkerboard dither fill; parity flips the phase. */
  checker(x: number, y: number, w: number, h: number, c: string, parity = 0): void {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++)
        if (((xx + yy + parity) & 1) === 0) this.p(xx, yy, c);
  }

  /** Sparse deterministic grime scatter (~density of pixels in rect). */
  scatter(x: number, y: number, w: number, h: number, c: string, density: number, seed: number): void {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++)
        if (hash01(xx, yy, seed) < density) this.p(xx, yy, c);
  }

  /** String bitmap. `map` gives char→color; '.' and ' ' are transparent. */
  bmp(x: number, y: number, rows: readonly string[], map: Record<string, string>): void {
    for (let yy = 0; yy < rows.length; yy++) {
      const row = rows[yy];
      for (let xx = 0; xx < row.length; xx++) {
        const c = map[row[xx]];
        if (c) this.p(x + xx, y + yy, c);
      }
    }
  }
}
