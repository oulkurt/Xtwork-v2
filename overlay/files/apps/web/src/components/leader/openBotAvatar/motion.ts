import { BANG, DOTS, blendMarks, poseMarks, type PoseMark } from './marks';
import type { AvatarMood, AvatarMotion, AvatarMotionBlend, AvatarState } from './types';

export interface EyeLook {

  arc: number;

  slit: number;
}

export interface Pose {

  yaw: number;
  pitch: number;

  roll: number;

  lift: number;

  sx: number;
  sy: number;

  gazeX: number;
  gazeY: number;

  blink: number;

  squintL: number;
  squintR: number;
  eyes: EyeLook;

  ribbons: number;

  cage: number;

  sweep: number;

  marks: readonly PoseMark[];
}

export const STATES: readonly AvatarState[] = ['idle', 'thinking', 'working', 'waiting', 'blocked', 'done'];
export const MOODS: readonly AvatarMood[] = ['neutral', 'happy'];

export function isState(value: unknown): value is AvatarState {
  return STATES.includes(value as AvatarState);
}

export function isMood(value: unknown): value is AvatarMood {
  return MOODS.includes(value as AvatarMood);
}

export function resolveLook(given: { state?: unknown; mood?: unknown; motion?: unknown }): { state: AvatarState; mood: AvatarMood } {
  return {
    state: isState(given.state) ? given.state : given.motion === 'thinking' ? 'thinking' : 'idle',
    mood: isMood(given.mood) ? given.mood : given.motion === 'happy' ? 'happy' : 'neutral',
  };
}

export const BASE_YAW = -0.3;
export const BASE_PITCH = 0.2;

export const LOOK_YAW = 0.32;
export const LOOK_PITCH = 0.18;
export const LOOK_EYES = 0.7;

const TAU = Math.PI * 2;

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function noise(seed: number, n: number): number {
  let h = (seed ^ Math.imul(n | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (u: number) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

export function blinkAt(seed: number, t: number): number {
  const SLOT = 4.2, DUR = 0.19;
  const slot = Math.floor(t / SLOT);
  let closure = 0;
  for (const s of [slot - 1, slot]) {
    const start = s * SLOT + 0.5 + noise(seed, s * 2) * 2.9;
    const starts = noise(seed, s * 2 + 1) > 0.8 ? [start, start + 0.34] : [start];
    for (const b of starts) {
      const u = (t - b) / DUR;
      if (u > 0 && u < 1) closure = Math.max(closure, Math.sin(Math.PI * u));
    }
  }
  return closure;
}

export function wanderAt(seed: number, t: number): [number, number] {
  const SLOT = 1.9;
  const s = Math.floor(t / SLOT);
  const target = (k: number): [number, number] => {
    if (noise(seed, 1000 + k * 3) < 0.4) return [0, 0];
    return [(noise(seed, 1001 + k * 3) * 2 - 1) * 0.6, (noise(seed, 1002 + k * 3) * 2 - 1) * 0.35];
  };
  const a = target(s - 1), b = target(s);
  const e = smooth((t - s * SLOT) / 0.16);
  return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e];
}

function dartAt(seed: number, t: number): [number, number] {
  const SLOT = 0.62;
  const s = Math.floor(t / SLOT);
  const target = (k: number): [number, number] => [(noise(seed, 2001 + k * 3) * 2 - 1) * 0.8, 0.1 + noise(seed, 2002 + k * 3) * 0.5];
  const a = target(s - 1), b = target(s);
  const e = smooth((t - s * SLOT) / 0.12);
  return [mix(a[0], b[0], e), mix(a[1], b[1], e)];
}

export interface PoseInput {
  seed: number;
  time: number;
  state?: AvatarState | AvatarStateDefinition | undefined;
  mood?: AvatarMood | undefined;

  motion?: AvatarMotion | undefined;

  stateAge?: number | undefined;

  gaze?: { x: number; y: number; weight?: number | undefined } | undefined;
  reducedMotion: boolean;

  view?: { yaw: number; pitch: number } | undefined;

  blend?: AvatarMotionBlend | undefined;
}

export function blendPoses(a: Pose, b: Pose, t: number): Pose {
  const k = clamp(t, 0, 1);
  const m = (x: number, y: number) => mix(x, y, k);

  const sweep = a.ribbons > 0 && b.ribbons > 0 ? m(a.sweep, b.sweep) : a.ribbons > 0 ? a.sweep : b.sweep;

  const cage = a.ribbons > 0 && b.ribbons > 0 ? m(a.cage, b.cage) : a.ribbons > 0 ? a.cage : b.cage;
  return {
    yaw: m(a.yaw, b.yaw), pitch: m(a.pitch, b.pitch), roll: m(a.roll, b.roll), lift: m(a.lift, b.lift),
    sx: m(a.sx, b.sx), sy: m(a.sy, b.sy), gazeX: m(a.gazeX, b.gazeX), gazeY: m(a.gazeY, b.gazeY),
    blink: m(a.blink, b.blink), squintL: m(a.squintL, b.squintL), squintR: m(a.squintR, b.squintR),
    eyes: { arc: m(a.eyes.arc, b.eyes.arc), slit: m(a.eyes.slit, b.eyes.slit) },
    ribbons: m(a.ribbons, b.ribbons), cage, sweep, marks: blendMarks(a.marks, b.marks, m),
  };
}

export function computePose(input: PoseInput): Pose {
  const pose = statePose(input);
  const blend = input.blend;
  if (!blend || !(blend.t < 1)) return pose;
  const from = typeof blend.from === 'string' ? { motion: blend.from } : blend.from;

  const stateAge = stateId(lookOf(from).state) === stateId(lookOf(input).state) ? input.stateAge : from.age;
  const before = computePose({ ...input, state: from.state, mood: from.mood, motion: from.motion, stateAge, blend: from.blend });
  return blendPoses(before, pose, Number.isFinite(blend.t) ? blend.t : 1);
}

export const DONE_TURN_S = 3.87;
export const DONE_CYCLE_S = 6.2;
const DONE_SWEEPS = 9;

const DONE_DRAW_IN_S = 0.5;

const WORK_FIRST_S = 1.2;
const WORK_FIRST_JITTER_S = 1.2;
const WORK_GAP_S = 7.5;
const WORK_JITTER_S = 1.5;
const WORK_TURN_S = 1.5;

const WORK_EASE = 6.2;

function workTurn(seed: number, age: number): number | null {
  const first = WORK_FIRST_S + WORK_FIRST_JITTER_S * noise(seed, 41);
  if (age < first) return null;
  const n = Math.floor((age - first) / WORK_GAP_S);

  for (const k of [n, n - 1]) {
    if (k < 0) continue;
    const start = first + k * WORK_GAP_S + (k ? WORK_JITTER_S * noise(seed, 60 + k) : 0);
    if (age >= start && age < start + WORK_TURN_S) return age - start;
  }
  return null;
}

const near = (angle: number) => angle - TAU * Math.round(angle / TAU);

const CELEBRATION_END_S = 3.79;
const CELEBRATION_SPEED = (DONE_SWEEPS * TAU + 0.5) / 2.4625;
function celebration(t: number): number {
  const v = CELEBRATION_SPEED;
  if (t <= 0) return 0;
  if (t < 0.24) return -0.25 * (1 - Math.cos((Math.PI * t) / 0.24));
  if (t < 0.54) return -0.5 + (v * (t - 0.24) ** 2) / 0.6;
  if (t < 2.54) return -0.5 + v * (t - 0.39);
  if (t < CELEBRATION_END_S) return -0.5 + v * 2.15 + (1.25 * v * (1 - (1 - (t - 2.54) / 1.25) ** 4)) / 4;
  return DONE_SWEEPS * TAU;
}

export interface StateContext {

  seed: number;

  time: number;

  t: number;

  stateAge: number | undefined;
  mood: AvatarMood;
  reducedMotion: boolean;

  live: number;

  sway: number;

  wave(period: number, phase?: number): number;

  base: Pose;

  rest(pace?: number): Pose;
}

export interface AvatarStateDefinition {

  id: string;

  pose(ctx: StateContext): Partial<Pose>;

  startAge?: number;
}

function rest({ seed, t, reducedMotion, sway, wave, base }: Omit<StateContext, 'rest'>, pace: number): Pose {
  const pose = { ...base };
  pose.yaw += 0.07 * sway * wave(6.1 * pace);
  pose.pitch += 0.04 * sway * wave(4.7 * pace, 1);
  pose.roll = 1.6 * wave(5.3 * pace, 2);
  pose.lift = reducedMotion ? 0 : -0.45 * (1 - Math.cos((TAU * t) / (3.4 * pace)));
  const breath = wave(3.4 * pace, -Math.PI / 2);
  pose.sy = 1 + 0.012 * breath;
  pose.sx = 1 - 0.008 * breath;
  if (!reducedMotion) {
    pose.blink = blinkAt(seed, t);
    [pose.gazeX, pose.gazeY] = wanderAt(seed, t);
  }
  return pose;
}

const STATE_DEFINITIONS: Record<AvatarState, AvatarStateDefinition> = {
  idle: {
    id: 'idle',
    pose(ctx) {
      if (ctx.mood !== 'happy') return ctx.rest();

      const { t, reducedMotion, live, wave } = ctx;
      const pose = { ...ctx.base };
      const period = 0.92;
      const p = reducedMotion ? 0.5 : ((t % period) + period) % period / period;
      const air = 4 * p * (1 - p);
      const land = reducedMotion ? 0 : clamp(1 - Math.min(p, 1 - p) / 0.12, 0, 1);
      pose.lift = reducedMotion ? 0 : -3.2 * air;
      pose.sy = 1 - 0.09 * land + 0.03 * air * live;
      pose.sx = 1 + 0.07 * land - 0.015 * air * live;
      pose.roll = 4.5 * wave(period * 2);
      pose.yaw += 0.1 * wave(period * 2, 0.6);
      return pose;
    },
  },
  thinking: {
    id: 'thinking',

    pose({ seed, t, reducedMotion, live, sway, wave, base }) {
      const pose = { ...base };
      pose.yaw += 0.12 + 0.05 * sway * wave(7.3);
      pose.pitch += 0.08;
      pose.roll = -5 + 1.4 * wave(4.1);
      pose.lift = -0.5 * (1 - Math.cos((TAU * t) / 5.2)) * live;
      pose.gazeX = 0.55 + 0.3 * wave(5.6);
      pose.gazeY = -0.8;
      pose.squintL = 0.22;
      pose.squintR = 0.32 + 0.1 * wave(3.1);
      if (!reducedMotion) pose.blink = blinkAt(seed, t * 0.7);
      pose.marks = [{ mark: DOTS, weight: 1 }];
      return pose;
    },
  },
  working: {
    id: 'working',

    pose({ seed, time, t, stateAge, reducedMotion, live, sway, wave, base }) {
      const pose = { ...base };
      const beat = wave(0.7);
      pose.yaw += 0.08 * sway * wave(2.3, 0.4);
      pose.pitch -= 0.05;
      pose.roll = 3 + 0.6 * beat;
      pose.lift = -0.3 * (0.5 + 0.5 * beat) * live;
      pose.sy = 0.99 - 0.008 * beat;
      pose.sx = 1.005 + 0.005 * beat;
      pose.squintL = 0.25;
      pose.squintR = 0.25;
      if (reducedMotion) {
        pose.gazeX = 0.15;
        pose.gazeY = 0.3;
      } else {
        [pose.gazeX, pose.gazeY] = dartAt(seed, t);
        pose.blink = blinkAt(seed, t * 1.3);
      }

      const age = Number.isFinite(stateAge) ? Math.max(0, stateAge as number) : Math.max(0, time);
      const into = reducedMotion ? null : workTurn(seed, age);
      if (into !== null) {

        const e = WORK_EASE * into;
        const turn = TAU * (1 - (1 + e) * Math.exp(-e));
        const swell = Math.sin(turn / 2);
        pose.ribbons = clamp(into / 0.16, 0, 1) * clamp((WORK_TURN_S - into) / 0.5, 0, 1);
        pose.sweep = turn;
        pose.yaw += 0.22 * swell;
        pose.roll += 3 * swell;
        pose.lift -= 1.2 * swell;
        pose.gazeX = clamp(pose.gazeX * (1 - swell) - 0.85 * Math.sin(turn), -1, 1);
        pose.gazeY = pose.gazeY * (1 - swell) - 0.3 * swell;
      }
      return pose;
    },
  },
  waiting: {
    id: 'waiting',

    pose({ seed, t, reducedMotion, live, sway, wave, base }) {
      const pose = { ...base };
      const p = reducedMotion ? 0 : ((t % 6.5) + 6.5) % 6.5 / 6.5;

      const sigh = Math.sin(TAU * clamp(p / 0.33, 0, 1));
      pose.yaw += 0.04 * sway * wave(7.4);
      pose.pitch += 0.02 + 0.03 * sigh;
      pose.roll = 7 + 1.2 * wave(6.4, 2);
      pose.lift = -0.3 * (1 - Math.cos((TAU * t) / 6.5)) * live;
      pose.sy = 1 + 0.025 * sigh;
      pose.sx = 1 - 0.012 * sigh;
      pose.gazeX = 0.5 + 0.15 * wave(8.2);
      pose.gazeY = 0.1;
      pose.eyes = { arc: base.eyes.arc, slit: 1 - base.eyes.arc };
      if (!reducedMotion) pose.blink = blinkAt(seed, t * 0.6);
      return pose;
    },
  },
  blocked: {
    id: 'blocked',

    pose: () => ({ sy: 1.02, sx: 0.99, marks: [{ mark: BANG, weight: 1 }] }),
  },
  done: {
    id: 'done',
    startAge: DONE_TURN_S,

    pose(ctx) {
      const { seed, stateAge, reducedMotion } = ctx;
      const pose = ctx.rest(1.25);

      const age = !reducedMotion && Number.isFinite(stateAge) ? Math.max(0, stateAge as number) : DONE_TURN_S;
      const length = DONE_CYCLE_S * (1 + 0.15 * noise(seed, 31));
      const cycle = Math.floor(age / length), since = age - cycle * length;
      if (since < DONE_TURN_S) {
        const swell = Math.sin((Math.PI * since) / DONE_TURN_S);
        const way = cycle % 2 ? -1 : 1;
        const sweep = celebration(since) * way;

        pose.yaw += near(sweep / 3);
        pose.lift -= 2.2 * swell;
        pose.sy += 0.04 * swell;

        pose.ribbons = clamp(since / 0.1, 0, 1) * clamp((DONE_TURN_S - since) / DONE_DRAW_IN_S, 0, 1);
        pose.cage = 1;

        pose.sweep = way * Math.max(0, celebration(since));
      }
      return pose;
    },
  },
};

export function isStateDefinition(value: unknown): value is AvatarStateDefinition {
  const v = value as AvatarStateDefinition | null;
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.pose === 'function';
}

export function stateDefinition(state: AvatarState | AvatarStateDefinition): AvatarStateDefinition {
  return typeof state === 'string' ? STATE_DEFINITIONS[state] : state;
}

export function stateId(state: AvatarState | AvatarStateDefinition): string {
  return typeof state === 'string' ? state : state.id;
}

export function lookOf(given: { state?: unknown; mood?: unknown; motion?: unknown }): { state: AvatarState | AvatarStateDefinition; mood: AvatarMood } {
  const named = resolveLook(given);
  return isStateDefinition(given.state) ? { state: given.state, mood: named.mood } : named;
}

const POSE_NUMBERS = ['yaw', 'pitch', 'roll', 'lift', 'sx', 'sy', 'gazeX', 'gazeY', 'blink', 'squintL', 'squintR', 'ribbons', 'cage', 'sweep'] as const;

function laid(base: Pose, given: Partial<Pose> | undefined): Pose {
  const pose = { ...base };
  if (typeof given !== 'object' || given === null) return pose;
  const number = (v: unknown, or: number) => (typeof v === 'number' && Number.isFinite(v) ? v : or);
  for (const key of POSE_NUMBERS) pose[key] = number(given[key], base[key]);
  pose.eyes = { arc: number(given.eyes?.arc, base.eyes.arc), slit: number(given.eyes?.slit, base.eyes.slit) };
  if (given.marks !== undefined) pose.marks = poseMarks(given.marks);
  return pose;
}

function statePose(input: PoseInput): Pose {
  const { seed, time, gaze, reducedMotion, view } = input;
  const { state, mood } = lookOf(input);

  const t = reducedMotion ? 0 : time + noise(seed, 7) * 10;
  const given = gaze && Number.isFinite(gaze.x) && Number.isFinite(gaze.y)
    ? [clamp(gaze.x, -1, 1), clamp(gaze.y, -1, 1)] as [number, number]
    : null;
  const weight = given ? (Number.isFinite(gaze?.weight) ? clamp(gaze?.weight as number, 0, 1) : 1) : 0;

  const base: Pose = {
    yaw: BASE_YAW, pitch: BASE_PITCH, roll: 0, lift: 0, sx: 1, sy: 1,
    gazeX: 0, gazeY: 0, blink: 0, squintL: 0, squintR: 0,
    eyes: { arc: mood === 'happy' ? 1 : 0, slit: 0 }, ribbons: 0, cage: 0, sweep: 0, marks: [],
  };
  const ctx: Omit<StateContext, 'rest'> = {
    seed, time, t, stateAge: input.stateAge, mood, reducedMotion,
    live: reducedMotion ? 0 : 1,

    sway: 1 - 0.7 * weight,
    wave: (period, phase = 0) => (reducedMotion ? 0 : Math.sin((TAU * t) / period + phase)),
    base,
  };
  const pose = laid(base, stateDefinition(state).pose({ ...ctx, rest: (pace = 1) => rest(ctx, pace) }));

  if (given && weight > 0) {

    const share = reducedMotion ? 1 : LOOK_EYES;
    const follow = weight * (1 - pose.eyes.arc);
    pose.gazeX = mix(pose.gazeX, given[0] * share, follow);
    pose.gazeY = mix(pose.gazeY, given[1] * share, follow);
    if (!reducedMotion) {

      pose.yaw += weight * (given[0] * LOOK_YAW - BASE_YAW);
      pose.pitch += weight * (-given[1] * LOOK_PITCH - BASE_PITCH / 2);
    }
  }
  if (view && Number.isFinite(view.yaw) && Number.isFinite(view.pitch)) {
    pose.yaw += view.yaw;
    pose.pitch += view.pitch;
  }
  return pose;
}
