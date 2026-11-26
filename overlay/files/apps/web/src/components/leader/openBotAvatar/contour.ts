import type { Point } from './path';

export interface Field {

  values: Float64Array;
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  step: number;
}

export const RUN = 8;

export const runsOf = (nx: number) => Math.ceil((nx - 1) / RUN);

export function runRange(values: Float64Array, nx: number, ny: number): { min: Float64Array; max: Float64Array } {
  const runs = runsOf(nx);
  const lo = new Float64Array(runs * ny), hi = new Float64Array(runs * ny);
  for (let j = 0; j < ny; j++) {
    for (let r = 0; r < runs; r++) {
      let a = Infinity, b = -Infinity;
      for (let k = j * nx + r * RUN, end = j * nx + Math.min(nx - 1, (r + 1) * RUN); k <= end; k++) {
        const v = values[k]!;
        if (v < a) a = v;
        if (v > b) b = v;
      }
      lo[j * runs + r] = a; hi[j * runs + r] = b;
    }
  }
  const min = new Float64Array(runs * Math.max(0, ny - 1)), max = new Float64Array(min.length);
  for (let k = 0; k < min.length; k++) {
    min[k] = Math.min(lo[k]!, lo[k + runs]!);
    max[k] = Math.max(hi[k]!, hi[k + runs]!);
  }
  return { min, max };
}

let linkA = new Int32Array(0), linkB = new Int32Array(0);
let passed = new Uint8Array(0);
let order = new Int32Array(256);

let traced = new Float64Array(1024);
let ends = new Int32Array(16);

function trace(field: Field, level: number, flat: Uint8Array | undefined): number {
  const { values, nx, ny, x0, y0, step } = field;

  if (linkA.length < 2 * nx * ny) {
    linkA = new Int32Array(2 * nx * ny).fill(-1);
    linkB = new Int32Array(2 * nx * ny).fill(-1);
    passed = new Uint8Array(2 * nx * ny);
  }
  const a = linkA, b = linkB;

  let count = 0;
  const join = (p: number, q: number) => {
    if (a[p]! < 0) {
      if (count === order.length) { const grown = new Int32Array(2 * count); grown.set(order); order = grown; }
      order[count++] = p;
      a[p] = q;
    } else b[p] = q;
  };
  const link = (p: number, q: number) => { join(p, q); join(q, p); };

  const runs = runsOf(nx);
  for (let j = 0; j < ny - 1; j++) {
    const row = j * nx;
    for (let r = 0; r < runs; r++) {
      if (flat && flat[j * runs + r]) continue;
      let i = r * RUN;
      const end = Math.min(nx - 1, i + RUN);
      let tl = values[row + i]! - level >= 0, bl = values[row + nx + i]! - level >= 0;
      for (; i < end; i++) {
        const tr = values[row + i + 1]! - level >= 0, br = values[row + nx + i + 1]! - level >= 0;
        if (tl !== tr || tr !== br || br !== bl) {
          const top = 2 * (row + i), bottom = 2 * (row + nx + i), left = top + 1, right = top + 3;
          if (tl === br && tr === bl) {
            const center = ((values[row + i]! - level) + (values[row + i + 1]! - level) + (values[row + nx + i + 1]! - level) + (values[row + nx + i]! - level)) / 4 >= 0;

            if (tl === center) { link(top, right); link(bottom, left); }
            else { link(left, top); link(right, bottom); }
          } else if (tl !== tr) link(top, tr !== br ? right : br !== bl ? bottom : left);
          else if (tr !== br) link(right, br !== bl ? bottom : left);
          else link(bottom, left);
        }
        tl = tr; bl = br;
      }
    }
  }

  if (traced.length < 2 * count) traced = new Float64Array(4 * count);
  const xy = traced;
  let n = 0, loops = 0;
  for (let k = 0; k < count; k++) {
    const ok = order[k]!;
    if (passed[ok]) continue;
    let prev = -1, cur = ok;
    while (!passed[cur]) {
      passed[cur] = 1;
      const idx = cur >> 1, i = idx % nx, j = (idx - i) / nx;
      const v = values[idx]! - level;
      if (cur & 1) {
        const t = v / (v - (values[idx + nx]! - level));
        xy[n++] = x0 + i * step; xy[n++] = y0 + (j + t) * step;
      } else {
        const t = v / (v - (values[idx + 1]! - level));
        xy[n++] = x0 + (i + t) * step; xy[n++] = y0 + j * step;
      }

      let next = a[cur]!;
      if (next === prev || passed[next]) {
        next = b[cur]!;
        if (next < 0 || next === prev || passed[next]) break;
      }
      prev = cur; cur = next;
    }
    if (loops === ends.length) { const grown = new Int32Array(2 * loops); grown.set(ends); ends = grown; }
    ends[loops++] = n;
  }
  for (let k = 0; k < count; k++) { const ok = order[k]!; a[ok] = b[ok] = -1; passed[ok] = 0; }
  return loops;
}

function pointsOf(xy: Float64Array, start: number, end: number, keep?: Uint8Array): Point[] {
  const loop: Point[] = [];
  for (let k = start; k < end; k += 2) if (!keep || keep[(k - start) >> 1]) loop.push([xy[k]!, xy[k + 1]!]);
  return loop;
}

export function contourLoops(field: Field, level: number, flat?: Uint8Array): Point[][] {
  const loops: Point[][] = [];
  for (let k = 0, n = trace(field, level, flat), start = 0; k < n; start = ends[k++]!) {
    const end = ends[k]!;
    if (end - start >= 6) loops.push(pointsOf(traced, start, end));
  }
  return loops;
}

export function contourOutlines(field: Field, level: number, tolerance: number, flat?: Uint8Array): Point[][] {
  const loops: Point[][] = [];
  for (let k = 0, n = trace(field, level, flat), start = 0; k < n; start = ends[k++]!) {
    const end = ends[k]!;
    const points = (end - start) >> 1;
    if (points < 3) continue;
    if (points <= 8) { loops.push(pointsOf(traced, start, end)); continue; }
    const keep = simplify(traced, start, points, tolerance);
    let kept = 0;
    for (let q = 0; q < points; q++) kept += keep[q]!;
    if (kept >= 3) loops.push(pointsOf(traced, start, end, keep));
  }
  return loops;
}

const CLEAR = 1e-9;

let kept = new Uint8Array(256);
let chains = new Int32Array(64);

function simplify(xy: Float64Array, start: number, n: number, tolerance: number): Uint8Array {
  if (kept.length < n) kept = new Uint8Array(2 * n);
  const keep = kept.fill(0, 0, n);

  const x0 = xy[start]!, y0 = xy[start + 1]!;
  let far = 0, top = -1, next = -1;
  for (let k = 1; k < n; k++) {
    const dx = xy[start + 2 * k]! - x0, dy = xy[start + 2 * k + 1]! - y0, d = dx * dx + dy * dy;
    if (d > top) { next = top; top = d; far = k; } else if (d > next) next = d;
  }
  if (next >= top * (1 - CLEAR)) {
    let best = -1;
    far = 0;
    for (let k = 1; k < n; k++) {
      const d = Math.hypot(xy[start + 2 * k]! - x0, xy[start + 2 * k + 1]! - y0);
      if (d > best) { best = d; far = k; }
    }
  }
  keep[0] = keep[far] = 1;
  let open = 0;
  chains[open++] = 0; chains[open++] = far; chains[open++] = far; chains[open++] = n;
  while (open) {
    const e = chains[--open]!, s = chains[--open]!;

    const ax = xy[start + 2 * s]!, ay = xy[start + 2 * s + 1]!;
    const dx = xy[start + 2 * (e % n)]! - ax, dy = xy[start + 2 * (e % n) + 1]! - ay;
    let idx = -1, lead = -1, second = -1;
    for (let k = s + 1; k < e; k++) {
      const d = Math.abs(dx * (ay - xy[start + 2 * k + 1]!) - dy * (ax - xy[start + 2 * k]!));
      if (d > lead) { second = lead; lead = d; idx = k; } else if (d > second) second = d;
    }
    const bar = tolerance * Math.sqrt(dx * dx + dy * dy);
    if (lead <= bar * (1 - CLEAR) && bar > 0) idx = -1;
    else if (!(lead > bar * (1 + CLEAR) && second < lead * (1 - CLEAR))) {
      const len = Math.hypot(dx, dy);
      let max = tolerance;
      idx = -1;
      for (let k = s + 1; k < e; k++) {
        const px = xy[start + 2 * k]!, py = xy[start + 2 * k + 1]!;
        const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dx * (ay - py) - dy * (ax - px)) / len;
        if (d > max) { max = d; idx = k; }
      }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      if (open + 4 > chains.length) { const grown = new Int32Array(2 * chains.length); grown.set(chains); chains = grown; }
      chains[open++] = s; chains[open++] = idx; chains[open++] = idx; chains[open++] = e;
    }
  }
  return keep;
}

export function simplifyLoop(loop: Point[], tolerance: number): Point[] {
  if (loop.length <= 8) return loop;
  const xy = new Float64Array(2 * loop.length);
  for (let k = 0; k < loop.length; k++) { const pt = loop[k]!; xy[2 * k] = pt[0]; xy[2 * k + 1] = pt[1]; }
  const keep = simplify(xy, 0, loop.length, tolerance);
  return loop.filter((_, k) => keep[k]);
}

export function simplifiedLoop(xy: Float64Array, n: number, tolerance: number): Point[] {
  return n <= 8 ? pointsOf(xy, 0, 2 * n) : pointsOf(xy, 0, 2 * n, simplify(xy, 0, n, tolerance));
}

const UNIT = 100;

const write = (k: number) => {
  const a = Math.abs(k), whole = Math.floor(a / UNIT), frac = a % UNIT;
  const f = frac === 0 ? '' : frac % 10 === 0 ? `.${frac / 10}` : frac < 10 ? `.0${frac}` : `.${frac}`;
  return (k < 0 ? '-' : '') + (whole || !f ? whole : '') + f;
};

const NEAR = 4096;
const written: (string | undefined)[] = new Array(2 * NEAR + 1);
const num = (k: number) => (Number.isInteger(k) && k >= -NEAR && k <= NEAR ? (written[k + NEAR] ??= write(k)) : write(k));

const CORNER = 0.6;

const SAG = 0.1;
const TAN_CORNER = Math.tan(CORNER);

let snapped = new Float64Array(512);
let corners = new Uint8Array(256);

export function loopsToPath(loops: Point[][]): string {
  let d = '', cmd = '', last = '';

  const emit = (c: string, x: number, y: number) => {
    if (c !== cmd) { d += c; cmd = c; last = ''; }
    for (let k = 0; k < 2; k++) {
      const t = num(k ? y : x);

      if (last && t[0] !== '-' && !(t[0] === '.' && last.includes('.'))) d += ' ';
      d += t;
      last = t;
    }
  };
  for (const loop of loops) {
    const n = loop.length;
    if (snapped.length < 2 * n) { snapped = new Float64Array(4 * n); corners = new Uint8Array(2 * n); }

    const v = snapped, corner = corners;
    for (let k = 0; k < n; k++) {
      const p = loop[k]!, a = loop[(k + n - 1) % n]!, b = loop[(k + 1) % n]!;
      v[2 * k] = 2 * Math.round(p[0] * UNIT / 2); v[2 * k + 1] = 2 * Math.round(p[1] * UNIT / 2);
      const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      const dot = (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]);

      const turn = Math.abs(cross), steep = dot * TAN_CORNER;
      if (dot > 0 ? turn > steep * (1 + CLEAR) || (turn >= steep * (1 - CLEAR) && Math.abs(Math.atan2(cross, dot)) > CORNER) : Math.abs(Math.atan2(cross, dot)) > CORNER) {
        corner[k] = 1;
        continue;
      }

      const chord = (4 * SAG) ** 2 * ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
      corner[k] = turn * turn > chord * (1 + CLEAR) || (turn * turn >= chord * (1 - CLEAR) && turn > 4 * SAG * Math.hypot(b[0] - a[0], b[1] - a[1])) ? 1 : 0;
    }

    let cx = (v[0]! + v[2 * (1 % n)]!) / 2, cy = (v[1]! + v[2 * (1 % n) + 1]!) / 2;
    emit('M', cx, cy);
    let smooth = false;
    for (let k = 1; k <= n; k++) {
      const at = 2 * (k % n), after = 2 * ((k + 1) % n);
      const px = v[at]!, py = v[at + 1]!;
      const mx = (px + v[after]!) / 2, my = (py + v[after + 1]!) / 2;
      if (corner[k % n]) {

        emit('l', px - cx, py - cy);
        cx = px; cy = py;
        if (k < n && !corner[(k + 1) % n]) {
          emit('l', mx - cx, my - cy);
          cx = mx; cy = my;
        }
        smooth = false;
      } else {

        if (smooth) emit('t', mx - cx, my - cy);
        else { emit('q', px - cx, py - cy); emit('q', mx - cx, my - cy); }
        cx = mx; cy = my;
        smooth = true;
      }
    }
    d += 'Z';
    cmd = 'Z'; last = '';
  }
  return d;
}
