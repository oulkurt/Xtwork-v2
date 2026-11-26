import type { EyeLook } from './motion';
import type { Point } from './path';
import { HAPPY_ARC } from './validate';

export interface EyeSpot {

  x: number;
  y: number;

  w: number;
  h: number;

  open: number;
  shift: number;
}

const STEPS = 40;

const SLIT = { length: 1.9, thick: 0.5, tip: 0.2 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function resample(pts: Point[], count: number): Point[] {
  const n = pts.length;
  const at: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!;
    at.push(at[i]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = at[n]!;
  const out: Point[] = [];
  let i = 0;
  for (let k = 0; k < count; k++) {
    const s = (k / count) * total;
    while (i < n - 1 && at[i + 1]! < s) i++;
    const a = pts[i]!, b = pts[(i + 1) % n]!;
    const a0 = at[i]!, a1 = at[i + 1]!;
    const u = a1 > a0 ? (s - a0) / (a1 - a0) : 0;
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

function sweep(cx: number, cy: number, r: number, from: number, to: number, steps: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function pill(cx: number, cy: number, w: number, h: number): Point[] {
  const r = Math.min(w, h) / 2;
  const fx = w / 2 - r, fy = h / 2 - r;
  const q = Math.PI / 2;
  return [
    [cx, cy - h / 2] as Point,
    ...sweep(cx + fx, cy - fy, r, -q, 0, 6),
    ...sweep(cx + fx, cy + fy, r, 0, q, 6),
    ...sweep(cx - fx, cy + fy, r, q, 2 * q, 6),
    ...sweep(cx - fx, cy - fy, r, 2 * q, 3 * q, 6),
  ];
}

function arc(e: EyeSpot): Point[] {
  const hw = e.w * HAPPY_ARC.halfWidth, base = e.y + e.h * HAPPY_ARC.base, peak = e.y - e.h * HAPPY_ARC.peak;
  const r = (e.w * HAPPY_ARC.stroke) / 2;

  const at = (s: number): { p: Point; n: Point } => {
    const m = 1 - s;
    const x = e.x + hw * (2 * s - 1), y = (m * m + s * s) * base + 2 * m * s * peak;
    const tx = 2 * hw, ty = 2 * (2 * s - 1) * (base - peak);
    const len = Math.hypot(tx, ty);
    return { p: [x, y], n: [ty / len, -tx / len] };
  };
  const edge = (from: number, to: number, side: 1 | -1): Point[] => {
    const pts: Point[] = [];
    for (let i = 0; i <= 8; i++) {
      const { p, n } = at(from + ((to - from) * i) / 8);
      pts.push([p[0] + n[0] * r * side, p[1] + n[1] * r * side]);
    }
    return pts;
  };
  const end = (s: 0 | 1): Point[] => {
    const { p, n } = at(s);
    const up = Math.atan2(n[1], n[0]);

    return s === 1 ? sweep(p[0], p[1], r, up, up + Math.PI, 8) : sweep(p[0], p[1], r, up + Math.PI, up + 2 * Math.PI, 8);
  };
  return [...edge(0.5, 1, 1), ...end(1), ...edge(1, 0, -1), ...end(0), ...edge(0, 0.5, 1)];
}

function slit(e: EyeSpot): Point[] {
  const length = e.w * SLIT.length, thick = e.w * SLIT.thick * clamp(e.open / e.h, 0.3, 1);
  const cos = Math.cos(SLIT.tip), sin = Math.sin(SLIT.tip);
  return pill(0, 0, length, thick).map(([x, y]) => [e.x + x * cos - y * sin, e.y + x * sin + y * cos]);
}

export function plainLook(look: EyeLook): 'pill' | 'arc' | null {
  if (look.arc >= 1) return 'arc';
  return look.arc <= 0 && look.slit <= 0 ? 'pill' : null;
}

export function eyeOutline(look: EyeLook, e: EyeSpot): Point[] {
  const a = clamp(look.arc, 0, 1), s = clamp(look.slit, 0, 1 - a);
  const shapes: [number, Point[]][] = [[1 - a - s, pill(e.x, e.y + e.shift, e.w, e.open)], [a, arc(e)], [s, slit(e)]];
  const out: Point[] = Array.from({ length: STEPS }, () => [0, 0]);
  for (const [weight, shape] of shapes) {
    if (weight <= 0) continue;
    resample(shape, STEPS).forEach(([x, y], i) => {
      const pt = out[i]!;
      pt[0] += x * weight;
      pt[1] += y * weight;
    });
  }
  return out;
}

const f = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};

export function outlinePath(pts: Point[]): string {
  const n = pts.length;
  const mid = (i: number): Point => {
    const a = pts[i % n]!, b = pts[(i + 1) % n]!;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const start = mid(n - 1);
  let d = `M${f(start[0])} ${f(start[1])}`;
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const m = mid(i);
    d += `Q${f(p[0])} ${f(p[1])} ${f(m[0])} ${f(m[1])}`;
  }
  return `${d}Z`;
}

export function eyePath(look: EyeLook, e: EyeSpot): string {
  return outlinePath(eyeOutline(look, e));
}
