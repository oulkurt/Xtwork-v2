import { mix, oklch, parseHex, toHex, toOklch } from './color';
import type { Rgb } from './color';
import { bodyScale, markParts, ribbonPieces, ribbonReach, rimOf } from './effects';
import type { Rim } from './effects';
import type { Box } from './effects';
import { eyePath, plainLook } from './eyes';
import type { EyeSpot } from './eyes';
import { computePose, hashString, noise } from './motion';
import type { EyeLook, Pose } from './motion';
import type { Bounds, Point } from './path';
import { EYE_H, EYE_W, GAZE_X, GAZE_Y, HAPPY_ARC, analyzeBody, eyeCenters, gazeRange, validateAvatar } from './validate';
import type { GazeRange } from './validate';
import { buildVolume } from './volume';
import type { EyePlane, Vec3, Volume, VolumeSlice } from './volume';
import type { AvatarDefinition, RenderOptions } from './types';

export const DEFAULT_COLOR = '#ff6a1a';
export const DEFAULT_EYE_COLOR = '#151515';

export const DEFAULT_DEPTH = 6;
const MAX_DEPTH = 14;

const CSS_EYE_LIFT = 1.5;

interface Prepared {
  def: AvatarDefinition;
  vol: Volume;
  range: GazeRange;
  seed: number;

  id: string;

  ids: Map<string, string>;

  detail: Map<string, boolean[]>;

  rims: () => { work: Rim; cage: Rim };
}

const cache = new Map<string, Prepared>();

const f = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function depthOption(options: RenderOptions): number {
  const d = clamp(Number.isFinite(options.depth) ? (options.depth as number) : DEFAULT_DEPTH, 0, MAX_DEPTH);
  return Math.round(d * 2) / 2;
}

const lazy = <T>(make: () => T): (() => T) => {
  let value: T | undefined;
  return () => (value ??= make());
};

export function ribbonRims(polys: Point[][], b: Bounds): { work: Rim; cage: Rim } {
  const [cx, cy] = pivotOf(b);
  const bx = (b.minX + b.maxX) / 2, by = b.maxY;

  const posed = (rolls: number[], sys: number[]) => {
    const out: Point[][][] = [];
    for (const roll of rolls) {
      const r = (roll * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
      for (const k of sys) {
        out.push(polys.map((poly) => poly.map(([x, y]): Point => {
          const lx = bx + c * (x - bx) - sn * (y - by), ly = by + sn * (x - bx) + c * (y - by);
          return [cx + 1.01 * (lx - cx), cy + k * (ly - cy)];
        })));
      }
    }
    return out;
  };
  return { work: rimOf(posed([2.4, 4.5, 6.6], [0.98, 1]), cx, cy), cage: rimOf(posed([-1.7, 0, 1.7], [0.99, 1.055]), cx, cy) };
}

export function ribbonsFollow(rim: Rim, pose: Pick<Pose, 'lift' | 'sx' | 'sy'>, b: Bounds): Rim {
  const bx = (b.minX + b.maxX) / 2, by = b.maxY;
  return { ...rim, cx: bx + pose.sx * (rim.cx - bx), cy: by + pose.sy * (rim.cy - by) + pose.lift };
}

function prepare(definition: AvatarDefinition, depth: number): Prepared {
  const key = JSON.stringify([definition?.id, definition?.name, definition?.body?.path, definition?.eyes, depth]);
  const hit = cache.get(key);
  if (hit) return hit;
  const res = validateAvatar(definition);
  if (!res.ok) throw new Error(`Invalid avatar definition: ${res.errors.join('; ')}`);
  const def = res.value;
  const body = analyzeBody(def.body.path);
  const vol = buildVolume(def, depth / DEFAULT_DEPTH, body);
  const id = `oba-${hashString(`${def.id}|${def.body.path}|${depth}`).toString(36)}`;
  const ids = new Map<string, string>();
  for (const part of vol.parts) for (const s of [...part.zSlices, ...part.xSlices]) if (!ids.has(s.d)) ids.set(s.d, `${id}-${ids.size}`);
  const prepared: Prepared = {
    def,
    vol,
    range: gazeRange(body.polys, { ...def.eyes, scale: vol.eyeScale }),
    seed: hashString(def.id),
    id,
    ids,
    detail: new Map(),
    rims: lazy(() => ribbonRims(body.polys, vol.bounds)),
  };
  if (cache.size >= 64) cache.delete(cache.keys().next().value as string);
  cache.set(key, prepared);
  return prepared;
}

export function preparedVolume(definition: AvatarDefinition, depth?: number): { def: AvatarDefinition; vol: Volume } {
  const p = prepare(definition, depthOption({ depth }));
  return { def: p.def, vol: p.vol };
}

function poseOf(p: Prepared, options: RenderOptions): Pose {
  return computePose({
    seed: p.seed,
    time: Number.isFinite(options.time) ? (options.time as number) : 0,
    state: options.state,
    mood: options.mood,
    motion: options.motion,
    stateAge: options.stateAge,
    gaze: options.gaze,
    reducedMotion: options.reducedMotion === true,
    view: options.view,
    blend: options.motionBlend,
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

type M = Matrix;
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const about = (x: number, y: number, m: M): M => mul(translate(x, y), mul(m, translate(-x, -y)));
const invert = ([a, b, c, d, e, g]: M): M => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * g - d * e) / det, (b * e - a * g) / det];
};
const mat = (m: M) => `matrix(${m.map((v, i) => (i < 4 ? (Math.round(v * 10000) / 10000).toString() : f(v))).join(' ')})`;

export interface ViewBasis {
  cY: number;
  sY: number;
  cP: number;
  sP: number;

  facing: number;
}

export function viewBasis(yaw: number, pitch: number): ViewBasis {
  const cY = Math.cos(yaw), cP = Math.cos(pitch);
  return { cY, sY: Math.sin(yaw), cP, sP: Math.sin(pitch), facing: cY * cP };
}

export function facingOf(v: ViewBasis, [x, y, z]: Vec3): number {
  return v.sP * y + v.cP * (-v.sY * x + v.cY * z);
}

function eyeVisible(v: ViewBasis, plane: EyePlane): boolean {
  return facingOf(v, [-plane.dzdx, -plane.dzdy, 1]) > 1e-6;
}

function eyeMatrix(v: ViewBasis, { x, y, z, dzdx, dzdy }: EyePlane, pivot: Point): M {
  const m = planeMatrix(v, z - x * dzdx - y * dzdy, pivot);
  m[0] += v.sY * dzdx;
  m[1] -= v.cY * v.sP * dzdx;
  m[2] += v.sY * dzdy;
  m[3] -= v.cY * v.sP * dzdy;
  return m;
}

export function activeStack(v: ViewBasis): 'z' | 'x' {
  return Math.abs(v.cY) >= Math.abs(v.sY) ? 'z' : 'x';
}

export function planeMatrix(v: ViewBasis, z: number, pivot: Point): M {
  const [cx, cy] = pivot;
  return [
    v.cY, v.sY * v.sP, 0, v.cP,
    cx - v.cY * cx + v.sY * z,
    cy - v.cP * cy - v.sY * v.sP * cx - v.cY * v.sP * z,
  ];
}

export function sidePlaneMatrix(v: ViewBasis, x0: number, pivot: Point): M {
  const [cx, cy] = pivot;
  return [-v.sY, v.cY * v.sP, 0, v.cP, cx + v.cY * (x0 - cx), cy - v.cP * cy + v.sY * v.sP * (x0 - cx)];
}

export function projectPoint(v: ViewBasis, [x, y, z]: Vec3, pivot: Point): Vec3 {
  const m = planeMatrix(v, z, pivot);
  const X = x - pivot[0], Y = y - pivot[1];
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5], v.sP * Y + v.cP * (-v.sY * X + v.cY * z)];
}

function rootMatrix(pose: Pose, b: Bounds): M {
  const bx = (b.minX + b.maxX) / 2, by = b.maxY;
  const r = (pose.roll * Math.PI) / 180;
  const rot: M = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
  return mul(translate(0, pose.lift), about(bx, by, mul(rot, [pose.sx, 0, 0, pose.sy, 0, 0])));
}

const pivotOf = (b: Bounds): Point => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

const POSE_LIFT = 4;
const POSE_SWAY = 0.2;

export function avatarExtent(definition: AvatarDefinition, depth?: number): { x: number; y: number; size: number } {
  const p = prepare(definition, depthOption({ depth }));
  const { vol } = p;
  const b = vol.bounds;
  const [cx, cy] = pivotOf(b);
  const radius = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, Math.max(...vol.parts.map((part) => part.depth)) + 2 * CSS_EYE_LIFT) / 2;

  const { work, cage } = p.rims();

  const reach = (rim: Rim) => {
    const r = ribbonReach(rim.max);
    return Math.hypot(rim.cx - cx, rim.cy - cy) + POSE_LIFT + POSE_SWAY * Math.abs(b.maxY - rim.cy) + r.radius + r.band + 1.2;
  };
  const half = Math.max(radius + POSE_LIFT + POSE_SWAY * (radius + b.maxY - cy), reach(work), reach(cage));
  return { x: cx - half, y: cy - half, size: 2 * half };
}

function drawnSlices(p: Prepared, v: ViewBasis, size: number | undefined, visit: (s: VolumeSlice, m: M, part: number, index: number) => void) {
  const { vol } = p;
  const stack = activeStack(v);
  const pivot = pivotOf(vol.bounds);
  const drawn = sliceCull(v);
  const kept = sliceDetail(p, stack, size);
  let k = 0;
  vol.parts.forEach((part, i) => {
    (stack === 'z' ? part.zSlices : part.xSlices).forEach((s, j) => {
      if (!kept[k++] || !drawn(s)) return;
      visit(s, stack === 'z' ? planeMatrix(v, s.at, pivot) : sidePlaneMatrix(v, s.at, pivot), i, j);
    });
  });
}

function sliceCull(v: ViewBasis): (s: VolumeSlice) => boolean {

  const sweep = Math.hypot(v.sY, v.cY * v.sP);
  const inset = Math.min(Math.abs(v.cY), Math.abs(v.cP));
  return (s) => s.axis !== 'z' || s.inset <= 0 || Math.abs(s.at) * sweep > s.inset * inset;
}

interface EyeState {

  x: number;
  y: number;
  w: number;
  h: number;

  dx: number;
  dy: number;

  open: number;
  shift: number;
  look: EyeLook;

  plain: 'pill' | 'arc' | null;
}

function eyeStates(p: Prepared, pose: Pose): [EyeState, EyeState] {
  const s = p.vol.eyeScale;
  const w = EYE_W * s, h = EYE_H * s;
  const r = p.range;
  const dx = pose.gazeX * (pose.gazeX >= 0 ? r.right : r.left) * GAZE_X * s;
  const dy = pose.gazeY * (pose.gazeY >= 0 ? r.down : r.up) * GAZE_Y * s;
  const centers = eyeCenters(p.def.eyes);
  const plain = plainLook(pose.eyes);
  return ([0, 1] as const).map((i) => {
    const squint = i === 0 ? pose.squintL : pose.squintR;
    const open = Math.max(h * Math.max(0.09, (1 - pose.blink) * (1 - squint * 0.4)), w * 0.55);
    return { x: centers[i][0], y: centers[i][1], w, h, dx, dy, open, shift: (h - open) * 0.18, look: pose.eyes, plain };
  }) as [EyeState, EyeState];
}

function eyeSpot(e: EyeState, gaze: boolean): EyeSpot {
  return { x: e.x + (gaze ? e.dx : 0), y: e.y + (gaze ? e.dy : 0), w: e.w, h: e.h, open: e.open, shift: e.shift };
}

function happyArc(e: EyeState): string {
  const ex = e.x + e.dx, ey = e.y + e.dy;
  const hw = e.w * HAPPY_ARC.halfWidth, base = ey + e.h * HAPPY_ARC.base;
  return `M${f(ex - hw)} ${f(base)}Q${f(ex)} ${f(ey - e.h * HAPPY_ARC.peak)} ${f(ex + hw)} ${f(base)}`;
}

function eyeMark(e: EyeState): EyeMark {
  if (e.plain === 'arc') return { shape: 'arc', d: happyArc(e), strokeWidth: e.w * HAPPY_ARC.stroke };
  if (e.plain === null) return { shape: 'path', d: eyePath(e.look, eyeSpot(e, true)) };
  const cx = e.x + e.dx, cy = e.y + e.dy + e.shift;
  return { shape: 'pill', x: cx - e.w / 2, y: cy - e.open / 2, width: e.w, height: e.open, radius: Math.min(e.w, e.open) / 2 };
}

function colors(options: RenderOptions): { color: string; ink: string } {
  return {
    color: toHex(parseHex(options.color) ?? (parseHex(DEFAULT_COLOR) as Rgb)),
    ink: toHex(parseHex(options.eyeColor) ?? (parseHex(DEFAULT_EYE_COLOR) as Rgb)),
  };
}

export type Matrix = [number, number, number, number, number, number];

export type EyeMark =
  | { shape: 'pill'; x: number; y: number; width: number; height: number; radius: number }
  | { shape: 'arc'; d: string; strokeWidth: number }
  | { shape: 'path'; d: string };

export type FrameShape =
  | {
      kind: 'slice';

      key: string;

      path: string;
      matrix: Matrix;
    }
  | { kind: 'eye'; key: 'eye-0' | 'eye-1'; matrix: Matrix; mark: EyeMark }
  | {

      kind: 'ribbon';
      key: string;
      d: string;
      box: { x: number; y: number; w: number; h: number };
      matrix: Matrix;
      front: boolean;

      fill: string;

      gradient: { x1: number; y1: number; x2: number; y2: number; stops: string[] };
    };

export interface FramePath {
  id: string;
  d: string;
  evenOdd: boolean;
  box: { x: number; y: number; w: number; h: number };

  round?: boolean;
}

export interface AvatarFrame {
  name: string;
  color: string;
  ink: string;

  paths: FramePath[];

  root: Matrix;

  shapes: FrameShape[];

  surface: { view: ViewBasis; scale: number; eyes: SurfaceEye[] };
}

export interface SurfaceEye {
  mark: EyeMark;
  dx: number;
  dy: number;
}

export function avatarFrame(definition: AvatarDefinition, options: RenderOptions = {}): AvatarFrame {
  return flatFrame(definition, options, undefined);
}

export function liveFrame(definition: AvatarDefinition, options: RenderOptions = {}): AvatarFrame {
  return flatFrame(definition, options, options.size);
}

const RAMP_LIGHT = 0.09;
const RAMP_HUE = 14;

const RAMP_RANGE = [0.36, 0.9] as const;
const WARM = 100;
const palettes = new Map<string, Rgb[][]>();

const GRADIENT_LIGHT = 0.13;
const GRADIENT_HUE = 25;
const GRADIENT_STOPS = 5;

const NEUTRAL = 0.04;
const NEUTRAL_TINT = 0.025;

const BAND_SHADES = [[0, 1, 2], [2, 0, 3], [1, 2, 0]] as const;

function turnToward(h: number, to: number, by: number): number {
  const d = ((to - h + 540) % 360) - 180;
  return (h + Math.sign(d) * Math.min(Math.abs(d), by) + 360) % 360;
}

function runAt(run: Rgb[], t: number): string {
  const x = clamp(t, 0, 1) * (run.length - 1), n = Math.min(Math.floor(x), run.length - 2);
  return toHex(mix(run[n]!, run[n + 1]!, x - n));
}

function ribbonPalette(color: string | undefined, seed: number): Rgb[][] {
  const key = `${color}|${seed}`;
  let palette = palettes.get(key);
  if (palette) return palette;
  const [light, chroma, hue] = toOklch(parseHex(color) ?? (parseHex(DEFAULT_COLOR) as Rgb));

  const neutral = chroma < NEUTRAL;
  const base = neutral ? (130 + noise(seed, 500) * 310) % 360 : hue;
  const c = neutral ? NEUTRAL_TINT : Math.max(chroma, 0.17);
  const from = Math.min(RAMP_RANGE[1], Math.max(RAMP_RANGE[0], light));
  const steps: number[] = [];
  for (let k = 1; steps.length < 5 && k < 10; k++) {
    for (const step of [k, -k]) {
      const l = from + step * RAMP_LIGHT;
      if (steps.length < 5 && l >= RAMP_RANGE[0] - 1e-9 && l <= RAMP_RANGE[1] + 1e-9) steps.push(step);
    }
  }
  while (steps.length < 5) steps.push(steps[steps.length - 1] ?? 1);
  const shades = steps.map((step) => {
    const l = from + step * RAMP_LIGHT;
    const h = turnToward(base, step > 0 ? WARM : WARM + 180, RAMP_HUE * Math.abs(step));

    const away = step > 0 ? 1 : -1;
    const run = Array.from({ length: GRADIENT_STOPS }, (_, n) => {
      const t = n / (GRADIENT_STOPS - 1);
      const hue = turnToward(h, away > 0 ? WARM : WARM + 180, GRADIENT_HUE * t);
      return oklch(clamp(l + away * GRADIENT_LIGHT * t, 0.26, 0.9), c, hue);
    });
    return { step, run };
  });

  palette = BAND_SHADES.flatMap((pick) => pick.map((n) => shades[n]!).sort((x, y) => y.step - x.step).map(({ run }) => run));
  if (palettes.size >= 64) palettes.clear();
  palettes.set(key, palette);
  return palette;
}

interface Effects {

  body: number;
  ribbons: { d: string; box: Box; front: boolean; fill: string; gradient: RibbonGradient }[];
  marks: { id: string; d: string; box: Box; matrix: M; round: boolean }[];
}

function markId(shape: string): string {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(shape) ? shape : `m-${hashString(String(shape)).toString(36)}`;
}

function effectsOf(p: Prepared, pose: Pose, options: RenderOptions): Effects {
  const b = p.vol.bounds;
  const time = Number.isFinite(options.time) ? (options.time as number) : 0;
  const still = options.reducedMotion === true;
  const [cx, cy] = pivotOf(b);
  return {
    body: bodyScale(pose.marks),

    ribbons: still || pose.ribbons <= 0.01 ? [] : ribbonPieces(b, pose.ribbons, p.seed, time, pose.sweep, pose.cage, ribbonsFollow(pose.cage >= 0.5 ? p.rims().cage : p.rims().work, pose, b)).map((r) => {
      const hue = ribbonPalette(options.color, p.seed)[r.ribbon]!;

      const [s0, s1] = r.along;
      const stops = [s0, (s0 + s1) / 2, s1].map((t) => runAt(hue, t));
      const midStop = stops[1]!;

      const long = Math.hypot(r.to[0] - r.from[0], r.to[1] - r.from[1]) > 0.01;
      return {
        d: r.d, box: r.box, front: r.front, fill: midStop,
        gradient: long ? { x1: r.from[0], y1: r.from[1], x2: r.to[0], y2: r.to[1], stops } : { x1: r.from[0], y1: r.from[1], x2: r.from[0] + 0.01, y2: r.from[1], stops: [midStop, midStop, midStop] },
      };
    }),
    marks: markParts(b, pose.marks, p.seed, time, still).map((part) => {
      const turn: M = [Math.cos(part.turn), Math.sin(part.turn), -Math.sin(part.turn), Math.cos(part.turn), 0, 0];
      return {
        id: `${p.id}-${markId(part.shape)}`,
        d: part.d,
        box: part.box,
        round: part.round === true,
        matrix: mul(about(cx, cy, turn), mul(translate(part.x, part.y), [part.scale, 0, 0, part.scale, 0, 0])),
      };
    }),
  };
}

function flatFrame(definition: AvatarDefinition, options: RenderOptions, size: number | undefined): AvatarFrame {
  const p = prepare(definition, depthOption(options));
  const { vol } = p;
  const b = vol.bounds;
  const { color, ink } = colors(options);
  const pose = poseOf(p, options);
  const pivot = pivotOf(b);
  const v = viewBasis(pose.yaw, pose.pitch);
  const stack = activeStack(v);
  const eyes: SurfaceEye[] = [];
  const fx = effectsOf(p, pose, options);
  const root = rootMatrix(pose, b);

  const shrink = (m: M): M => (fx.body < 1 ? mul(about(pivot[0], pivot[1], [fx.body, 0, 0, fx.body, 0, 0]), m) : m);

  const paths = new Map<string, FramePath>();
  const items: { depth: number; shape: FrameShape }[] = [];
  if (fx.body > 0) {
    drawnSlices(p, v, size, (s, m, i, j) => {
      let path = paths.get(s.d);
      if (!path) {
        path = { id: p.ids.get(s.d) as string, d: s.d, evenOdd: s.evenOdd, box: { ...s.box } };
        paths.set(s.d, path);
      }

      const depth = stack === 'z' ? v.facing * s.at : -v.sY * v.cP * s.at;
      items.push({ depth, shape: { kind: 'slice', key: `${i}${stack}${j}`, path: path.id, matrix: shrink(m) } });
    });

    eyeStates(p, pose).forEach((e, idx) => {
      const plane = vol.eyePlanes[idx]!;
      eyes.push({ mark: eyeMark({ ...e, dx: 0, dy: 0 }), dx: e.dx, dy: e.dy });
      if (!eyeVisible(v, plane)) return;

      const halfW = e.w * (e.plain === 'pill' ? 0.5 : HAPPY_ARC.halfWidth + 0.5 * HAPPY_ARC.stroke);
      const xDepth = -v.sY * v.cP;
      const z = plane.z + e.dx * plane.dzdx + e.dy * plane.dzdy;
      const depth = stack === 'z'
        ? v.facing * z + Math.abs(v.facing) * (Math.abs(plane.dzdx) * halfW + (Math.abs(plane.dzdy) * e.h) / 2)
        : xDepth * (e.x + e.dx) + Math.abs(xDepth) * halfW;
      items.push({
        depth: depth + 1e-6,
        shape: { kind: 'eye', key: idx === 0 ? 'eye-0' : 'eye-1', matrix: shrink(eyeMatrix(v, plane, pivot)), mark: eyeMark(e) },
      });
    });
    items.sort((a, c) => a.depth - c.depth);
  }

  const fixed = fx.ribbons.length || fx.marks.length ? invert(root) : null;
  const ribbon = (front: boolean): FrameShape[] =>
    fx.ribbons.flatMap((r, i) =>
      r.front === front ? [{ kind: 'ribbon' as const, key: `ribbon-${i}`, d: r.d, box: r.box, matrix: fixed as M, front, fill: r.fill, gradient: r.gradient }] : [],
    );
  const marks = fx.marks.map((mark, i): FrameShape => {

    const taken = paths.get(mark.id);
    const id = taken && taken.d !== mark.d ? `${mark.id}-${hashString(mark.d).toString(36)}` : mark.id;
    if (!paths.has(id)) paths.set(id, { id, d: mark.d, evenOdd: false, box: mark.box, ...(mark.round ? { round: true } : {}) });
    return { kind: 'slice', key: `mark-${i}`, path: id, matrix: mul(fixed as M, mark.matrix) };
  });
  return {
    name: p.def.name, color, ink, paths: [...paths.values()], root,
    shapes: [...ribbon(false), ...items.map((it) => it.shape), ...ribbon(true), ...marks],
    surface: { view: v, scale: fx.body, eyes },
  };
}

function eyeSvg(mark: EyeMark, ink: string): string {
  if (mark.shape === 'path') return `<path d="${mark.d}" fill="${ink}"/>`;
  if (mark.shape === 'arc') {
    return `<path d="${mark.d}" fill="none" stroke="${ink}" stroke-width="${f(mark.strokeWidth)}" stroke-linecap="round"/>`;
  }
  return `<rect x="${f(mark.x)}" y="${f(mark.y)}" width="${f(mark.width)}" height="${f(mark.height)}" rx="${f(mark.radius)}" fill="${ink}"/>`;
}

type RibbonGradient = { x1: number; y1: number; x2: number; y2: number; stops: string[] };

function ribbonSvg(d: string, g: RibbonGradient, idPrefix = ''): string {
  const id = `${idPrefix}oba-g${hashString(`${f(g.x1)},${f(g.y1)},${f(g.x2)},${f(g.y2)},${g.stops.join()}`).toString(36)}`;
  const stops = g.stops.map((c, i) => `<stop offset="${f(i / (g.stops.length - 1))}" stop-color="${c}"/>`).join('');
  return (
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(g.x1)}" y1="${f(g.y1)}" x2="${f(g.x2)}" y2="${f(g.y2)}">${stops}</linearGradient>` +
    `<path d="${d}" fill="url(#${id})"/>`
  );
}

export function renderAvatarSvg(definition: AvatarDefinition, options: RenderOptions = {}): string {
  const frame = avatarFrame(definition, options);
  const idPrefix = typeof options.idPrefix === 'string' && options.idPrefix.length > 0 ? options.idPrefix : '';

  const defsMarkup = frame.paths.map((d) => `<path id="${idPrefix}${d.id}" d="${esc(d.d)}"${d.evenOdd ? ' fill-rule="evenodd"' : ''}/>`).join('');
  const body = frame.shapes
    .map((s) =>
      s.kind === 'slice' ? `<use href="#${idPrefix}${s.path}" transform="${mat(s.matrix)}"/>`
      : s.kind === 'eye' ? `<g transform="${mat(s.matrix)}">${eyeSvg(s.mark, frame.ink)}</g>`
      : `<g transform="${mat(s.matrix)}">${ribbonSvg(s.d, s.gradient, idPrefix)}</g>`,
    )
    .join('');
  const size = Number.isFinite(options.size) && (options.size as number) > 0 ? f(clamp(options.size as number, 8, 4096)) : null;
  const dims = size ? ` width="${size}" height="${size}"` : ' width="100%" height="100%"';
  const overflow = options.reducedMotion === true ? 'hidden' : 'visible';
  const label = esc(frame.name);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${dims} style="display:block;width:100%;height:100%;pointer-events:none" role="img" aria-label="${label}" overflow="${overflow}">` +
    `<title>${label}</title>` +
    `<defs>${defsMarkup}</defs>` +
    `<g transform="${mat(frame.root)}" fill="${frame.color}">` +
    body +
    `</g></svg>`
  );
}

const u = (n: number) => `${f(n)}cqw`;
const eyePlaneCss = ({ z, dzdx, dzdy }: EyePlane) =>
  `translateZ(${u(z + CSS_EYE_LIFT)}) matrix3d(1,0,${r4(dzdx)},0,0,1,${r4(dzdy)},0,0,0,1,0,0,0,0,1)`;
const FILL = 'position:absolute;left:0;top:0;width:100%;height:100%;';

function sliceMarkup(s: VolumeSlice): string {
  const pad = 0.3;
  const x = s.box.x - pad, y = s.box.y - pad, w = s.box.w + 2 * pad, h = s.box.h + 2 * pad;
  const rule = s.evenOdd ? ' fill-rule="evenodd"' : '';
  const place = s.axis === 'z'
    ? `left:${u(x)};top:${u(y)};transform:translateZ(${u(s.at)})`
    :
      `left:${u(s.at + x)};top:${u(y)};transform-origin:${u(-x)} 50%;transform:rotateY(90deg)`;
  return (
    `<svg viewBox="${f(x)} ${f(y)} ${f(w)} ${f(h)}" style="position:absolute;width:${u(w)};height:${u(h)};overflow:visible;${place}" aria-hidden="true">` +
    `<path d="${s.d}"${rule} fill="currentColor"/></svg>`
  );
}

const overlay = (side: 'back' | 'front') =>
  `<svg data-fx="${side}" viewBox="0 0 100 100" style="${FILL}overflow:visible;pointer-events:none" fill="currentColor" aria-hidden="true"></svg>`;

export function renderAvatarScene(definition: AvatarDefinition, options: Pick<RenderOptions, 'depth'> = {}): string {
  const p = prepare(definition, depthOption(options));
  const { vol } = p;
  const b = vol.bounds;
  const [cx, cy] = pivotOf(b);
  const ink = `var(--avatar-ink,${DEFAULT_EYE_COLOR})`;
  const stack = (axis: 'z' | 'x') =>
    `<div data-stack="${axis}" style="${FILL}transform-style:preserve-3d">` +
    vol.parts.map((part) => (axis === 'z' ? part.zSlices : part.xSlices).map(sliceMarkup).join('')).join('') +
    `</div>`;
  const eyes = eyeStates(p, poseOf(p, { reducedMotion: true })).map((e, i) => {
    const box = `left:${u(e.x - e.w / 2)};top:${u(e.y - e.h / 2)};width:${u(e.w)};height:${u(e.h)}`;
    return (
      `<div data-eye="${i}" style="position:absolute;${box};backface-visibility:hidden;transform:${eyePlaneCss(vol.eyePlanes[i]!)}">` +
      `<i style="position:absolute;inset:0;border-radius:999px;background:${ink}"></i>` +
      `<svg viewBox="${f(e.x - e.w / 2)} ${f(e.y - e.h / 2)} ${f(e.w)} ${f(e.h)}" style="${FILL}overflow:visible;display:none" aria-hidden="true">` +
      `<path d="${happyArc(e)}" fill="none" stroke="${ink}" stroke-width="${f(e.w * HAPPY_ARC.stroke)}" stroke-linecap="round"/></svg>` +

      `<svg data-morph viewBox="${f(e.x - e.w / 2)} ${f(e.y - e.h / 2)} ${f(e.w)} ${f(e.h)}" style="${FILL}overflow:visible;display:none" aria-hidden="true">` +
      `<path fill="${ink}"/></svg>` +
      `</div>`
    );
  });
  return (
    `<div data-avatar-scene="${p.id}" style="position:relative;width:100%;height:100%;container-type:size">` +

    overlay('back') +

    `<div data-motion style="${FILL}will-change:transform;transform-origin:${u((b.minX + b.maxX) / 2)} ${u(b.maxY)}">` +
    `<div data-view style="${FILL}transform-style:preserve-3d;transform-origin:${u(cx)} ${u(cy)}">` +
    stack('z') + stack('x') + eyes.join('') +
    `</div></div>` +
    overlay('front') +
    `</div>`
  );
}

export interface SceneFrame {

  scene: string;

  motion: string;

  view: string;

  body: number;

  back: string;
  front: string;
  stack: 'z' | 'x';

  slices: boolean[];

  eyes: { visible: boolean; happy: boolean; transform: string; pill: string; d: string }[];
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

const SLICE_GAP_PX = 0.75;

function sliceDetail(p: Prepared, stack: 'z' | 'x', size: number | undefined): boolean[] {
  const px = Number.isFinite(size) && (size as number) > 0 ? Math.round(size as number) : 0;
  const key = `${stack}${px}`;
  let keep = p.detail.get(key);
  if (keep) return keep;
  const gap = px ? (SLICE_GAP_PX * 100) / px : 0;
  keep = p.vol.parts.flatMap((part) => {
    const slices = stack === 'z' ? part.zSlices : part.xSlices;
    let last = -Infinity;
    return slices.map((s, j) => {
      const core = s.axis === 'z' && s.at === 0 && s.inset === 0;
      const kept = core || j === 0 || j === slices.length - 1 || s.at - last >= gap;
      if (kept) last = s.at;
      return kept;
    });
  });
  if (p.detail.size >= 32) p.detail.clear();
  p.detail.set(key, keep);
  return keep;
}

export function sceneFrame(definition: AvatarDefinition, options: RenderOptions = {}): SceneFrame {
  const p = prepare(definition, depthOption(options));
  const pose = poseOf(p, options);
  const v = viewBasis(pose.yaw, pose.pitch);
  const states = eyeStates(p, pose);
  const stack = activeStack(v);
  const drawn = sliceCull(v);
  const kept = sliceDetail(p, stack, options.size);
  const fx = effectsOf(p, pose, options);
  const piece = (front: boolean) => fx.ribbons.filter((r) => r.front === front).map((r) => ribbonSvg(r.d, r.gradient)).join('');
  let k = 0;
  return {
    scene: p.id,
    motion: `translate(0,${u(pose.lift)}) rotate(${f(pose.roll)}deg) scale(${r4(pose.sx)},${r4(pose.sy)})`,
    view: (fx.body < 1 ? `scale(${r4(fx.body)}) ` : '') + `rotateX(${r4(pose.pitch)}rad) rotateY(${r4(pose.yaw)}rad)`,
    body: fx.body,
    back: piece(false),
    front: piece(true) + fx.marks.map((mark) => `<path d="${esc(mark.d)}" transform="${mat(mark.matrix)}"/>`).join(''),
    stack,
    slices: p.vol.parts.flatMap((part) => (stack === 'z' ? part.zSlices : part.xSlices).map((s) => Boolean(kept[k++]) && drawn(s))),
    eyes: states.map((e, i) => ({
      visible: eyeVisible(v, p.vol.eyePlanes[i]!),
      happy: e.plain === 'arc',
      transform: `${eyePlaneCss(p.vol.eyePlanes[i]!)} translate(${u(e.dx)},${u(e.dy)})`,
      pill: `translateY(${u(e.shift)}) scaleY(${r4(e.open / e.h)})`,
      d: e.plain === null ? eyePath(e.look, eyeSpot(e, false)) : '',
    })),
  };
}
