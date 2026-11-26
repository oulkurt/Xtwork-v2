const TAU = Math.PI * 2;
const f = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};

export interface Box { x: number; y: number; w: number; h: number }

export interface MarkPart {

  shape: string;
  d: string;
  box: Box;

  x: number;
  y: number;
  turn: number;
  scale: number;

  round?: boolean;
}

export interface MarkContext {

  unit: number;

  time: number;

  still: boolean;
}

export interface AvatarMark {

  id: string;

  parts(ctx: MarkContext): MarkPart[];
}

export interface PoseMark {
  mark: AvatarMark;
  weight: number;
}

export const circle = (r: number) => `M${f(r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(-r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(r)} 0Z`;
export const capsule = (w: number, h: number) => {
  const r = w / 2, y = h / 2 - r;
  return `M${f(-r)} ${f(-y)}A${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-y)}L${f(r)} ${f(y)}A${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(y)}Z`;
};

export const BANG: AvatarMark = {
  id: 'bang',
  parts({ unit: u, time: t, still }) {
    const barW = 0.21 * u, barH = 0.5 * u, dot = 0.115 * u, gap = 0.1 * u;
    const total = barH + gap + 2 * dot;

    const p = still ? 1 : ((t % 2.6) + 2.6) % 2.6 / 2.6;
    const alarm = p < 0.3 ? p / 0.3 : 1;
    const jump = still ? 0 : Math.sin(Math.PI * alarm);
    const turn = still ? 0 : 0.2 * Math.sin(TAU * 3 * alarm) * (1 - alarm);
    const lift = -0.09 * u * jump;
    const barY = -total / 2 + barH / 2, dotY = total / 2 - dot;

    return [
      { shape: 'bar', d: capsule(barW, barH), box: { x: -barW / 2, y: -barH / 2, w: barW, h: barH }, x: 0, y: barY + lift, turn, scale: 1, round: true },
      { shape: 'dot', d: circle(dot), box: { x: -dot, y: -dot, w: 2 * dot, h: 2 * dot }, x: 0, y: dotY + lift * 0.45, turn, scale: 1, round: true },
    ];
  },
};

export const DOTS: AvatarMark = {
  id: 'dots',
  parts({ unit: u, time: t, still }) {
    const r = 0.1 * u, step = 0.31 * u;
    return [0, 1, 2].map((i) => {

      const p = still ? 0 : (((t - i * 0.17) % 1.25) + 1.25) % 1.25 / 1.25;
      const hop = p < 0.4 ? Math.sin(Math.PI * (p / 0.4)) : 0;
      return { shape: 'dot3', d: circle(r), box: { x: -r, y: -r, w: 2 * r, h: 2 * r }, x: (i - 1) * step, y: -0.16 * u * hop, turn: 0, scale: 1 + 0.12 * hop, round: true };
    });
  },
};

export function blendMarks(a: readonly PoseMark[], b: readonly PoseMark[], mix: (x: number, y: number) => number): PoseMark[] {
  const weight = (list: readonly PoseMark[], id: string) => list.find((m) => m.mark.id === id)?.weight ?? 0;

  const marks = [...b, ...a.filter((m) => !b.some((n) => n.mark.id === m.mark.id))].map((m) => m.mark);
  return marks
    .map((mark) => ({ mark, weight: mix(weight(a, mark.id), weight(b, mark.id)) }))
    .filter((m) => m.weight > 0)
    .sort((m, n) => (m.mark.id < n.mark.id ? -1 : m.mark.id > n.mark.id ? 1 : 0));
}

export function poseMarks(given: unknown): PoseMark[] {
  if (!Array.isArray(given)) return [];
  const marks: PoseMark[] = [];
  for (const entry of given as (Partial<PoseMark> | null)[]) {
    const mark = entry?.mark, weight = entry?.weight;
    if (typeof mark?.id !== 'string' || typeof mark.parts !== 'function') continue;
    if (typeof weight !== 'number' || !(weight > 0) || marks.some((m) => m.mark.id === mark.id)) continue;
    marks.push({ mark, weight: Math.min(1, weight) });
  }
  return marks.sort((m, n) => (m.mark.id < n.mark.id ? -1 : m.mark.id > n.mark.id ? 1 : 0));
}

export function markPartsOf(given: unknown): MarkPart[] {
  if (!Array.isArray(given)) return [];
  const number = (v: unknown, or: number) => (typeof v === 'number' && Number.isFinite(v) ? v : or);
  const parts: MarkPart[] = [];
  for (const part of given as (Partial<MarkPart> | null)[]) {
    if (typeof part !== 'object' || part === null) continue;
    const { shape, d, box } = part;
    if (typeof shape !== 'string' || typeof d !== 'string' || d === '') continue;
    if (typeof box !== 'object' || box === null || ![box.x, box.y, box.w, box.h].every(Number.isFinite) || !(box.w > 0 && box.h > 0)) continue;
    parts.push({ ...part, shape, d, box, x: number(part.x, 0), y: number(part.y, 0), turn: number(part.turn, 0), scale: number(part.scale, 1) });
  }
  return parts;
}
