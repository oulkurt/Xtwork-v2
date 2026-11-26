import { markPartsOf, type Box, type MarkPart, type PoseMark } from './marks';
import { noise } from './motion';
import type { Bounds, Point } from './path';

export type { Box, MarkPart } from './marks';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (u: number) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
const f = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};

export interface RibbonPiece {
  d: string;
  front: boolean;
  box: Box;

  ribbon: number;

  along: [number, number];
  from: [number, number];
  to: [number, number];
}

const DESIGN = 228.541;

const BODY = 80;
const UNIT = BODY / DESIGN;

const RIM_MARGIN = 2;
const RING = 38.8 * (116 / 114.2705);

const RIM_STEPS = 180;

const RIM_FANS = 180;

function reachFinder(outlines: Point[][][], cx: number, cy: number): (a: number) => number {
  let count = 0;
  for (const outline of outlines) for (const poly of outline) count += poly.length;

  const e = new Float64Array(4 * count);

  const first = new Int32Array(count), more = new Int32Array(count);
  const start = new Int32Array(RIM_FANS + 1);
  let k = 0;
  for (const outline of outlines) {
    for (const poly of outline) {
      for (let i = 0; i < poly.length; i++, k++) {
        const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
        e[4 * k] = p[0]; e[4 * k + 1] = p[1]; e[4 * k + 2] = q[0] - p[0]; e[4 * k + 3] = q[1] - p[1];
        const px = p[0] - cx, py = p[1] - cy, qx = q[0] - cx, qy = q[1] - cy;

        const from = Math.atan2(py, px), turn = Math.atan2(px * qy - py * qx, px * qx + py * qy);
        const near = px * px + py * py < 1e-6 || qx * qx + qy * qy < 1e-6 || Math.abs(turn) > Math.PI - 0.1;
        const lo = Math.floor((Math.min(from, from + turn) / Math.PI) * RIM_FANS) - 1;
        const hi = Math.floor((Math.max(from, from + turn) / Math.PI) * RIM_FANS) + 1;
        const fk = near ? 0 : ((lo % RIM_FANS) + RIM_FANS) % RIM_FANS;
        const mk = near || !(hi - lo < RIM_FANS) ? RIM_FANS - 1 : hi - lo;
        first[k] = fk;
        more[k] = mk;
        for (let f = 0; f <= mk; f++) {
          const idx = ((fk + f) % RIM_FANS) + 1;
          start[idx] = start[idx]! + 1;
        }
      }
    }
  }
  for (let f = 0; f < RIM_FANS; f++) start[f + 1] = start[f + 1]! + start[f]!;
  const items = new Int32Array(start[RIM_FANS]!), next = start.slice(0, RIM_FANS);
  for (k = 0; k < count; k++) {
    const fk = first[k]!, mk = more[k]!;
    for (let f = 0; f <= mk; f++) {
      const idx = (fk + f) % RIM_FANS;
      const pos = next[idx]!;
      next[idx] = pos + 1;
      items[pos] = 4 * k;
    }
  }

  return (a) => {
    const ux = Math.cos(a), uy = Math.sin(a);

    const turns = Math.atan2(uy, ux) / Math.PI;
    const fan = Math.floor((turns - Math.floor(turns)) * RIM_FANS);

    const known = fan >= 0 && fan < RIM_FANS;
    let far = 0;
    for (let n = known ? start[fan]! : 0, end = known ? start[fan + 1]! : count; n < end; n++) {
      const at = known ? items[n]! : 4 * n;
      const x1 = e[at]!, y1 = e[at + 1]!, ex = e[at + 2]!, ey = e[at + 3]!, den = ux * ey - uy * ex;
      if (Math.abs(den) < 1e-12) continue;

      const t = ((x1 - cx) * ey - (y1 - cy) * ex) / den, s = ((x1 - cx) * uy - (y1 - cy) * ux) / den;
      if (s >= 0 && s <= 1) far = Math.max(far, Math.abs(t));
    }
    return far;
  };
}

function hoopRolls(seed: number): number[] {
  return Array.from({ length: HOOPS }, (_, i) => HOOP_ROLL + (i * Math.PI) / HOOPS + (noise(seed, 450 + i) - 0.5) * HOOP_JITTER);
}

export interface Rim {
  cx: number;
  cy: number;
  at: (angle: number) => number;
  max: number;
}
export function rimOf(outlines: Point[][][], cx: number, cy: number): Rim {
  const at = reachFinder(outlines, cx, cy);
  const steps = Array.from({ length: RIM_STEPS }, (_, k) => at((k * Math.PI) / RIM_STEPS));

  return { cx, cy, at, max: Math.max(...steps) * 1.02 };
}
const HOOP_TILT = 0.386;
const HOOP_ROLL = 0.157;

const HOOP_JITTER = 0.24;

const HOOP_TILT_JITTER = 0.08;
const LADDER = 38;
const ARC: [number, number] = [2.2, 3.4];
const FOLLOW: [number, number] = [0.74, 0.94];

const DRIFT: [number, number] = [0.5, 1.1];
const WIDEN = 2.5;

const START = 0.18;

const SIZE_FEW: [number, number] = [8, 10.5];
const SIZE_FOUR: [number, number] = [6.6, 8.6];
const SIZE_MANY: [number, number] = [5.6, 7.4];

const WORK_LANES: [number, number] = [3, 5];
const sizeFor = (count: number) => (count <= 3 ? SIZE_FEW : count === 4 ? SIZE_FOUR : SIZE_MANY);
const BRUSH = 1.7 * 1.98;
const FAR = 0.72;
const GROW_S = 0.34;

const STAGGER: [number, number] = [0.055, 0.105];

const SWEEP_RATE: [number, number] = [6.3, 15];

const SWEEP_LONGEST = 4;
export const LANES = 3;
export const HOOPS = 3;
const SAMPLES = 24;

const STRETCH = 6;

const SLIVER = 0.02;

const CAP = 7;

const mix = (range: [number, number], u: number) => range[0] + (range[1] - range[0]) * u;

export function ribbonReach(rimMax?: number): { radius: number; width: number; band: number } {
  const width = SIZE_FEW[1] * BRUSH * UNIT;
  const ring = rimMax === undefined ? RING : rimMax + RIM_MARGIN;
  return { radius: ring + (LADDER + WIDEN * SWEEP_LONGEST) * UNIT, width, band: width / 2 };
}

export function ribbonPieces(
  b: Bounds, presence: number, seed: number, _time: number, sweep = 0, cage = 0, rim?: Rim,
): RibbonPiece[] {
  const k = clamp(presence, 0, 1), more = cage >= 0.5 ? 1 : 0;
  if (k <= 0.01) return [];
  const cx = rim ? rim.cx : (b.minX + b.maxX) / 2, cy = rim ? rim.cy : (b.minY + b.maxY) / 2;
  const rolls = hoopRolls(seed), rollOf = (i: number) => rolls[i]!;
  const cageRing = rim ? Math.max(...[0, 1, 2].map((i) => rim.at(rollOf(i)))) + RIM_MARGIN : RING;
  const unit = UNIT;
  const dir = sweep < 0 ? -1 : 1;

  const since = Math.abs(sweep) / mix(SWEEP_RATE, more);
  const pieces: RibbonPiece[] = [];
  for (let i = 0; i < (more ? HOOPS : 1); i++) {
    const hoopRoll = rollOf(i);
    const hoopTilt = HOOP_TILT + (noise(seed, 460 + i) - 0.5) * HOOP_TILT_JITTER;
    const ring = more ? cageRing : rim ? rim.at(hoopRoll) + RIM_MARGIN : RING;
    const lanes = i || more > 0 ? LANES : Math.round(mix(WORK_LANES, noise(seed, 47)));
    for (let l = 0; l < lanes; l++) {
      const n = (m: number) => noise(seed, 500 + (i * LANES + l) * 11 + m);

      const order = more > 0 ? l * HOOPS + i : l;
      const at = order * mix(STAGGER, n(7));
      const life = since - at;
      if (life <= 0) continue;
      const before = since > 0 ? Math.abs(sweep) * (at / since) : 0;
      const roll = hoopRoll;
      const tilt = hoopTilt;
      const flat = Math.sin(tilt), depth = Math.cos(tilt);
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const r = ring + (l * LADDER * unit) / (lanes - 1) + mix([0, WIDEN], n(2)) * unit * life;

      const travel = (Math.abs(sweep) - before) * mix(FOLLOW, n(3)) + mix(DRIFT, n(4)) * life;
      const head = dir * (before + travel - START * n(5));
      const ret = 1 - clamp(k * 1.25, 0, 1);
      const length = Math.min(mix(ARC, n(6)), travel) * (1 - ret * ret * (3 - 2 * ret));
      if (length <= 0.02) continue;
      const size = mix(sizeFor(lanes), n(8)) * (1 - more) + mix(SIZE_MANY, n(8)) * more;
      const nearHead = clamp(Math.cos(head) * depth, 0, 1);
      let full = size * BRUSH * unit * (FAR + (1 - FAR) * nearHead) * smooth(life / GROW_S) * (1 - 0.72 * ret * ret);

      const lamAt = (u: number) => head - dir * length * (1 - u);
      const point = (lam: number): [number, number] => {
        const a = Math.sin(lam), y = -Math.cos(lam) * flat;
        return [cx + r * (a * cr - y * sr), cy + r * (a * sr + y * cr)];
      };

      const along = (lam: number) => 1 - (head - lam) / (dir * length);
      const sliver = SLIVER / length;
      const ss: number[] = [];
      for (let j = 0; j <= SAMPLES; j++) ss.push(j / SAMPLES);
      const lo = Math.min(head, head - dir * length), hi = Math.max(head, head - dir * length);
      for (let side = Math.ceil((lo - Math.PI / 2) / Math.PI); Math.PI / 2 + side * Math.PI < hi; side++) {
        const u = along(Math.PI / 2 + side * Math.PI);
        for (const d of [-sliver, 0, sliver]) if (u + d > 0 && u + d < 1) ss.push(u + d);
      }
      ss.sort((x, y) => x - y);

      const near = ss.map((u) => Math.cos(lamAt(u) + dir * 1e-6) > 0);

      const mid: [number, number][] = [], halfs: number[] = [], norm: [number, number][] = [], bend: number[] = [];
      for (const u of ss) {
        const lam = lamAt(u);

        const nx = Math.sin(lam) * flat, ny = -Math.cos(lam);
        const nl = Math.hypot(nx, ny) || 1;
        const ux = nx / nl, uy = ny / nl;
        mid.push(point(lam));
        norm.push([ux * cr - uy * sr, ux * sr + uy * cr]);
        halfs.push(0.5 + 0.5 * u);

        const c = Math.cos(lam), sn = Math.sin(lam);
        bend.push((r * (c * c + flat * flat * sn * sn) ** 1.5) / flat);
      }
      const last = ss.length - 1;

      let onScreen = 0;
      for (let j = 1; j <= last; j++) onScreen += Math.hypot(mid[j]![0] - mid[j - 1]![0], mid[j]![1] - mid[j - 1]![1]);
      full = Math.min(full, 0.34 * onScreen);
      for (let j = 0; j <= last; j++) halfs[j] = Math.min(halfs[j]! * (full / 2), 0.9 * bend[j]!);
      const side = (j: number, sign: number): [number, number] => [mid[j]![0] + sign * norm[j]![0] * halfs[j]!, mid[j]![1] + sign * norm[j]![1] * halfs[j]!];

      const cap = (j: number, ahead: boolean): [number, number][] => {
        const o = (ahead ? mid[j - 1] : mid[j + 1])!;
        const mj = mid[j]!;
        let tx = ahead ? mj[0] - o[0] : o[0] - mj[0], ty = ahead ? mj[1] - o[1] : o[1] - mj[1];
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl; ty /= tl;
        const [nx, ny] = norm[j]!, h = halfs[j]!, out: [number, number][] = [];
        for (let c = 1; c < CAP; c++) {
          const t = (Math.PI * c) / CAP;

          const e = ahead ? Math.cos(t) : -Math.cos(t), g = ahead ? Math.sin(t) : -Math.sin(t);
          out.push([mj[0] + (nx * e + tx * g) * h, mj[1] + (ny * e + ty * g) * h]);
        }
        return out;
      };

      let from = 0;
      for (let j = 1; j <= last; j++) {
        const turns = j < last && near[j] !== near[from];
        if (j < last && !turns && j - from < STRETCH) continue;
        const to = j;
        const behind = !near[from];
        const end = to < last && (!turns || behind) ? to + 1 : to;
        const start = from > 0 && behind && near[from - 1] ? from - 1 : from;
        const pts: [number, number][] = [];
        for (let q = start; q <= end; q++) pts.push(side(q, 1));
        if (end === last) pts.push(...cap(last, true));
        for (let q = end; q >= start; q--) pts.push(side(q, -1));
        if (start === 0) pts.push(...cap(0, false));
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const x = Math.min(...xs), y = Math.min(...ys);
        pieces.push({
          d: `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}Z`,
          front: near[from]!,
          box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y },
          ribbon: i * LANES + l,
          along: [ss[from]!, ss[to]!],
          from: mid[from]!,
          to: mid[to]!,
        });
        from = j;
      }
    }
  }
  return pieces;
}

const MARK_FROM = 0.45;
const grown = (weight: number) => smooth((clamp(weight, 0, 1) - MARK_FROM) / (1 - MARK_FROM));

function markUnit(b: Bounds): number {
  return clamp(Math.min(b.maxX - b.minX, b.maxY - b.minY), 34, 78);
}

export function markParts(b: Bounds, marks: readonly PoseMark[], seed: number, time: number, still: boolean): MarkPart[] {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const ctx = { unit: markUnit(b), time: still ? 0 : time + noise(seed, 9) * 10, still };
  return marks.flatMap(({ mark, weight }) => {
    const g = grown(weight);
    if (!(g > 0)) return [];
    return markPartsOf(mark.parts(ctx)).map((part) => ({ ...part, x: cx + part.x * g, y: cy + part.y * g, scale: part.scale * g }));
  });
}

export function bodyScale(marks: readonly PoseMark[]): number {
  const left = (weight: number) => 1 - smooth(clamp(weight, 0, 1) / 0.55);
  const scale = left(marks.reduce((sum, m) => sum + m.weight, 0));
  return marks.some((m) => grown(m.weight) > 0) ? scale : Math.max(scale, left(MARK_FROM));
}
