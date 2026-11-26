export type Segment =
  | { c: 'M'; x: number; y: number }
  | { c: 'L'; x: number; y: number }
  | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: 'Q'; x1: number; y1: number; x: number; y: number }
  | { c: 'A'; rx: number; ry: number; rot: number; large: 0 | 1; sweep: 0 | 1; x: number; y: number }
  | { c: 'Z' };

export type Point = [number, number];

export const PATH_LIMITS = {
  maxChars: 6000,
  maxSegments: 400,
  maxSubpaths: 16,
  coordMin: -20,
  coordMax: 120,
} as const;

const ARG_COUNT: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

export class PathError {
  readonly name = 'PathError';
  readonly message: string;
  readonly stack: string | undefined;
  constructor(message: string) {
    this.message = message;
    this.stack = new Error(message).stack;
  }
}
Object.setPrototypeOf(PathError.prototype, Error.prototype);

function tokenize(d: string): (string | number)[] {
  if (/[^MmLlHhVvCcSsQqTtAaZz0-9.,eE+\-\s]/.test(d)) {
    const bad = d.match(/[^MmLlHhVvCcSsQqTtAaZz0-9.,eE+\-\s]/)![0];
    throw new PathError(`unsupported character ${JSON.stringify(bad)} (allowed commands: M L H V C S Q T A Z)`);
  }
  const tokens: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([\s,]+)/y;
  let i = 0;
  while (i < d.length) {
    re.lastIndex = i;
    const m = re.exec(d);
    if (!m) throw new PathError(`cannot parse path near ${JSON.stringify(d.slice(i, i + 12))}`);
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(Number(m[2]));
    i = re.lastIndex;
  }
  return tokens;
}

export function parsePath(d: string, bounded = true): Segment[] {
  if (typeof d !== 'string' || d.trim() === '') throw new PathError('path is empty');
  if (d.length > PATH_LIMITS.maxChars) throw new PathError(`path longer than ${PATH_LIMITS.maxChars} characters`);
  const tokens = tokenize(d);
  const out: Segment[] = [];
  let i = 0;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let prevC: [number, number] | null = null;
  let prevQ: [number, number] | null = null;
  let cmd = '';
  let subpaths = 0;
  let open = false;

  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        if (!open) throw new PathError('Z without an open subpath');
        out.push({ c: 'Z' });
        cx = sx; cy = sy; prevC = prevQ = null; open = false;
        continue;
      }
    } else if (!cmd) {
      throw new PathError('path must start with M');
    } else if (cmd === 'Z' || cmd === 'z') {
      throw new PathError('numbers after Z');
    }
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (out.length === 0 && up !== 'M') throw new PathError('path must start with M');
    const n = ARG_COUNT[up];
    if (n === undefined) throw new PathError(`unsupported command ${cmd}`);
    const args: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = tokens[i + k];
      if (typeof v !== 'number') throw new PathError(`command ${cmd} expects ${n} numbers`);
      if (!Number.isFinite(v)) throw new PathError('non-finite number');
      args.push(v);
    }
    i += n;
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    let nextC: [number, number] | null = null;
    let nextQ: [number, number] | null = null;
    switch (up) {
      case 'M': {
        if (open) out.push({ c: 'Z' });
        cx = args[0]! + ox; cy = args[1]! + oy; sx = cx; sy = cy;
        out.push({ c: 'M', x: cx, y: cy });
        subpaths++; open = true;
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': cx = args[0]! + ox; cy = args[1]! + oy; out.push({ c: 'L', x: cx, y: cy }); break;
      case 'H': cx = args[0]! + ox; out.push({ c: 'L', x: cx, y: cy }); break;
      case 'V': cy = args[0]! + oy; out.push({ c: 'L', x: cx, y: cy }); break;
      case 'C': {
        const s: Segment = { c: 'C', x1: args[0]! + ox, y1: args[1]! + oy, x2: args[2]! + ox, y2: args[3]! + oy, x: args[4]! + ox, y: args[5]! + oy };
        out.push(s); nextC = [s.x2, s.y2]; cx = s.x; cy = s.y; break;
      }
      case 'S': {
        const x1: number = prevC ? 2 * cx - prevC[0] : cx, y1: number = prevC ? 2 * cy - prevC[1] : cy;
        const s: Segment = { c: 'C', x1, y1, x2: args[0]! + ox, y2: args[1]! + oy, x: args[2]! + ox, y: args[3]! + oy };
        out.push(s); nextC = [s.x2, s.y2]; cx = s.x; cy = s.y; break;
      }
      case 'Q': {
        const s: Segment = { c: 'Q', x1: args[0]! + ox, y1: args[1]! + oy, x: args[2]! + ox, y: args[3]! + oy };
        out.push(s); nextQ = [s.x1, s.y1]; cx = s.x; cy = s.y; break;
      }
      case 'T': {
        const x1: number = prevQ ? 2 * cx - prevQ[0] : cx, y1: number = prevQ ? 2 * cy - prevQ[1] : cy;
        const s: Segment = { c: 'Q', x1, y1, x: args[0]! + ox, y: args[1]! + oy };
        out.push(s); nextQ = [x1, y1]; cx = s.x; cy = s.y; break;
      }
      case 'A': {
        const rx = args[0]!, ry = args[1]!, rot = args[2]!, la = args[3]!, sw = args[4]!;
        if (rx < 0 || ry < 0) throw new PathError('arc radii must be non-negative');
        if ((la !== 0 && la !== 1) || (sw !== 0 && sw !== 1)) throw new PathError('arc flags must be 0 or 1, written as separate numbers');
        cx = args[5]! + ox; cy = args[6]! + oy;
        out.push({ c: 'A', rx, ry, rot, large: la, sweep: sw, x: cx, y: cy });
        break;
      }
      default:
        throw new PathError(`unsupported command ${cmd}`);
    }
    prevC = nextC; prevQ = nextQ;
    if (out.length > PATH_LIMITS.maxSegments) throw new PathError(`more than ${PATH_LIMITS.maxSegments} segments`);
  }
  if (open) out.push({ c: 'Z' });
  if (subpaths > PATH_LIMITS.maxSubpaths) throw new PathError(`more than ${PATH_LIMITS.maxSubpaths} subpaths`);
  for (const s of bounded ? out : []) {
    for (const [k, v] of Object.entries(s)) {
      if (k === 'c' || typeof v !== 'number') continue;
      if (k === 'rot' || k === 'large' || k === 'sweep') continue;
      if (v < PATH_LIMITS.coordMin || v > PATH_LIMITS.coordMax) throw new PathError(`coordinate ${v} far outside the 0..100 viewBox`);
    }
  }
  return out;
}

function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
}

export function serializePath(segs: Segment[]): string {
  const parts: string[] = [];
  for (const s of segs) {
    switch (s.c) {
      case 'M': parts.push(`M${fmt(s.x)} ${fmt(s.y)}`); break;
      case 'L': parts.push(`L${fmt(s.x)} ${fmt(s.y)}`); break;
      case 'C': parts.push(`C${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x2)} ${fmt(s.y2)} ${fmt(s.x)} ${fmt(s.y)}`); break;
      case 'Q': parts.push(`Q${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x)} ${fmt(s.y)}`); break;
      case 'A': parts.push(`A${fmt(s.rx)} ${fmt(s.ry)} ${fmt(s.rot)} ${s.large} ${s.sweep} ${fmt(s.x)} ${fmt(s.y)}`); break;
      case 'Z': parts.push('Z'); break;
    }
  }
  return parts.join('');
}

function sampleArc(x0: number, y0: number, s: Extract<Segment, { c: 'A' }>, out: Point[]): void {
  let { rx, ry } = s;
  const { x, y } = s;
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) { out.push([x, y]); return; }
  const phi = (s.rot * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const k = Math.sqrt(lambda); rx *= k; ry *= k; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (s.large === s.sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!s.sweep && dt > 0) dt -= 2 * Math.PI;
  if (s.sweep && dt < 0) dt += 2 * Math.PI;

  const step = 2 * Math.acos(Math.max(-1, 1 - FLATNESS / Math.max(rx, ry)));
  const steps = Math.min(256, Math.max(4, Math.ceil(Math.abs(dt) / step)));
  for (let k = 1; k <= steps; k++) {
    const t = t1 + (dt * k) / steps;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
}

export const FLATNESS = 0.02;

export function flattenPath(segs: Segment[]): Point[][] {
  const polys: Point[][] = [];
  let cur: Point[] = [];
  let px = 0, py = 0;
  for (const s of segs) {
    switch (s.c) {
      case 'M':
        if (cur.length) polys.push(cur);
        cur = [[s.x, s.y]]; px = s.x; py = s.y; break;
      case 'L': cur.push([s.x, s.y]); px = s.x; py = s.y; break;
      case 'C': {

        const m = Math.max(Math.hypot(px - 2 * s.x1 + s.x2, py - 2 * s.y1 + s.y2), Math.hypot(s.x1 - 2 * s.x2 + s.x, s.y1 - 2 * s.y2 + s.y));
        const n = Math.min(128, Math.max(2, Math.ceil(Math.sqrt((0.75 * m) / FLATNESS))));
        for (let k = 1; k <= n; k++) {
          const t = k / n, u = 1 - t;
          cur.push([
            u * u * u * px + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
            u * u * u * py + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y,
          ]);
        }
        px = s.x; py = s.y; break;
      }
      case 'Q': {
        const n = Math.min(128, Math.max(2, Math.ceil(Math.sqrt((0.25 * Math.hypot(px - 2 * s.x1 + s.x, py - 2 * s.y1 + s.y)) / FLATNESS))));
        for (let k = 1; k <= n; k++) {
          const t = k / n, u = 1 - t;
          cur.push([u * u * px + 2 * u * t * s.x1 + t * t * s.x, u * u * py + 2 * u * t * s.y1 + t * t * s.y]);
        }
        px = s.x; py = s.y; break;
      }
      case 'A': sampleArc(px, py, s, cur); px = s.x; py = s.y; break;
      case 'Z':
        if (cur.length) { polys.push(cur); px = cur[0]![0]; py = cur[0]![1]; }
        cur = []; break;
    }
  }
  if (cur.length) polys.push(cur);
  return polys.filter((p) => p.length >= 3);
}

export function winding(polys: Point[][], x: number, y: number): number {
  let w = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yj <= y) {
        if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) w++;
      } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) w--;
    }
  }
  return w;
}

export function isInside(polys: Point[][], x: number, y: number): boolean {
  return winding(polys, x, y) !== 0;
}

export function insideRow(polys: Point[][], y: number, xs: number[], out: Uint8Array): void {
  const hits: [number, number][] = [];
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xj, yj] = poly[j]!, [xi, yi] = poly[i]!;
      if (yj <= y && yi > y) hits.push([xj + ((y - yj) * (xi - xj)) / (yi - yj), 1]);
      else if (yi <= y && yj > y) hits.push([xj + ((y - yj) * (xi - xj)) / (yi - yj), -1]);
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  let w = 0, h = 0;
  for (let k = 0; k < xs.length; k++) {
    while (h < hits.length && hits[h]![0] < xs[k]!) w += hits[h++]![1];
    out[k] = w !== 0 ? 1 : 0;
  }
}

export class EdgeBands {

  private readonly e: Float64Array;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly y0: number;
  private readonly inv: number;
  private readonly n: number;
  private hitX = new Float64Array(16);
  private hitDir = new Int8Array(16);

  constructor(polys: Point[][]) {
    let count = 0;
    for (const poly of polys) count += poly.length;
    const e = this.e = new Float64Array(4 * count);
    let k = 0, lo = Infinity, hi = -Infinity, climb = 0;
    for (const poly of polys) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const pj = poly[j]!, pi = poly[i]!;
        const yj = pj[1], yi = pi[1];
        e[k] = pj[0]; e[k + 1] = yj; e[k + 2] = pi[0]; e[k + 3] = yi;
        k += 4;
        if (yj < lo) lo = yj;
        if (yj > hi) hi = yj;
        climb += Math.abs(yi - yj);
      }
    }

    const tall = climb > 0 ? Math.floor((3 * count * (hi - lo)) / climb) : Infinity;
    const n = this.n = Math.max(1, Math.min(512, Math.ceil(count / 4), tall));
    this.y0 = count ? lo : 0;
    this.inv = hi > lo ? n / (hi - lo) : 0;

    const start = this.start = new Int32Array(n + 1);
    for (k = 0; k < e.length; k += 4) {
      const a = this.band(Math.min(e[k + 1]!, e[k + 3]!)), b = this.band(Math.max(e[k + 1]!, e[k + 3]!));
      for (let q = a; q <= b; q++) start[q + 1] = start[q + 1]! + 1;
    }
    for (let q = 0; q < n; q++) start[q + 1] = start[q + 1]! + start[q]!;
    const items = this.items = new Int32Array(start[n]!);
    const next = start.slice(0, n);
    for (k = 0; k < e.length; k += 4) {
      const a = this.band(Math.min(e[k + 1]!, e[k + 3]!)), b = this.band(Math.max(e[k + 1]!, e[k + 3]!));
      for (let q = a; q <= b; q++) {
        const pos = next[q]!;
        next[q] = pos + 1;
        items[pos] = k;
      }
    }
  }

  private band(y: number): number {
    const q = Math.floor((y - this.y0) * this.inv);
    return q >= this.n ? this.n - 1 : q > 0 ? q : 0;
  }

  winding(x: number, y: number): number {
    const { e, items } = this;
    const b = this.band(y);
    let w = 0;
    for (let q = this.start[b]!, end = this.start[b + 1]!; q < end; q++) {
      const k = items[q]!;
      const xj = e[k]!, yj = e[k + 1]!, xi = e[k + 2]!, yi = e[k + 3]!;
      if (yj <= y) {
        if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) w++;
      } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) w--;
    }
    return w;
  }

  private crossings(y: number): number {
    const { e, items } = this;
    const b = this.band(y);
    const startB = this.start[b]!, end = this.start[b + 1]!;
    if (end - startB > this.hitX.length) {
      this.hitX = new Float64Array(2 * (end - startB));
      this.hitDir = new Int8Array(this.hitX.length);
    }
    const hx = this.hitX, hd = this.hitDir;
    let n = 0;
    for (let q = startB; q < end; q++) {
      const k = items[q]!;
      const xj = e[k]!, yj = e[k + 1]!, xi = e[k + 2]!, yi = e[k + 3]!;
      let dir = 0;
      if (yj <= y && yi > y) dir = 1;
      else if (yi <= y && yj > y) dir = -1;
      else continue;
      const x = xj + ((y - yj) * (xi - xj)) / (yi - yj);

      let m = n++;
      for (; m > 0 && hx[m - 1]! > x; m--) { hx[m] = hx[m - 1]!; hd[m] = hd[m - 1]!; }
      hx[m] = x; hd[m] = dir;
    }
    return n;
  }

  insideRow(y: number, xs: ArrayLike<number>, out: Uint8Array): void {
    const n = this.crossings(y);
    const hx = this.hitX, hd = this.hitDir;
    let w = 0, h = 0;
    for (let k = 0; k < xs.length; k++) {
      while (h < n && hx[h]! < xs[k]!) w += hd[h++]!;
      out[k] = w !== 0 ? 1 : 0;
    }
  }

  insideRowAt(x: number, y: number): boolean {
    const n = this.crossings(y);
    let w = 0;
    for (let h = 0; h < n && this.hitX[h]! < x; h++) w += this.hitDir[h]!;
    return w !== 0;
  }
}

const bands = new WeakMap<Point[][], EdgeBands>();

export function edgeBands(polys: Point[][]): EdgeBands {
  let index = bands.get(polys);
  if (!index) bands.set(polys, index = new EdgeBands(polys));
  return index;
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function bounds(polys: Point[][]): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of polys) for (let k = 0; k < p.length; k++) {
    const pt = p[k]!;
    const x = pt[0], y = pt[1];
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  }
  return b;
}

export function filledArea(polys: Point[][], b: Bounds = bounds(polys)): number {
  let n = 0;
  const xs: number[] = [];
  for (let x = Math.floor(b.minX) + 0.5; x < b.maxX; x += 1) xs.push(x);
  const row = new Uint8Array(xs.length);
  const index = edgeBands(polys);
  for (let y = Math.floor(b.minY) + 0.5; y < b.maxY; y += 1) {
    index.insideRow(y, xs, row);
    for (const v of row) n += v;
  }
  return n;
}

export function splitSubpaths(segs: Segment[]): Segment[][] {
  const out: Segment[][] = [];
  for (const s of segs) {
    if (s.c === 'M') out.push([]);
    out[out.length - 1]?.push(s);
  }
  return out;
}
