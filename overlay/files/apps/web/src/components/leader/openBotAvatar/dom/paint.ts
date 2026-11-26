import { avatarExtent, preparedVolume } from '../render';
import type { AvatarFrame, FramePath, FrameShape, Matrix } from '../render';
import type { AvatarDefinition } from '../types';
import type { Volume } from '../volume';
import { eyeBox, paintEye } from './eye';
import { paintMark } from './materials/marks';
import { canvasMaterialOf, type AvatarMaterial } from './materials/material';

export interface Square {
  x: number;
  y: number;
  size: number;
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const FIT_SLACK = 8;

export const FIT_PAD = 1;

export function fitSquare(prev: Square | null, b: Bounds, cap: Square): Square {
  if (!(b.x0 <= b.x1 && b.y0 <= b.y1)) return prev ?? cap;
  if (
    prev &&
    b.x0 - FIT_PAD >= prev.x &&
    b.y0 - FIT_PAD >= prev.y &&
    b.x1 + FIT_PAD <= prev.x + prev.size &&
    b.y1 + FIT_PAD <= prev.y + prev.size
  ) {
    return prev;
  }
  let x0 = b.x0 - FIT_SLACK, y0 = b.y0 - FIT_SLACK, x1 = b.x1 + FIT_SLACK, y1 = b.y1 + FIT_SLACK;
  if (prev) {
    x0 = Math.min(x0, prev.x);
    y0 = Math.min(y0, prev.y);
    x1 = Math.max(x1, prev.x + prev.size);
    y1 = Math.max(y1, prev.y + prev.size);
  }
  const size = Math.max(x1 - x0, y1 - y0);
  const inCap = b.x0 >= cap.x && b.y0 >= cap.y && b.x1 <= cap.x + cap.size && b.y1 <= cap.y + cap.size;
  if (size >= cap.size && inCap) return cap;
  return { x: (x0 + x1 - size) / 2, y: (y0 + y1 - size) / 2, size };
}

interface Section {
  d: string;
  box: FramePath['box'];
  path: Path2D;
  rule: CanvasFillRule;

  round: boolean;
}

const MAX_SECTIONS = 4096;
const sections = new Map<string, Section>();

let supported: boolean | undefined;

export function canvasSupported(): boolean {
  if (supported === undefined) {

    supported = typeof Path2D !== 'undefined' && typeof document !== 'undefined' && !!document.createElement('canvas').getContext('2d');
  }
  return supported;
}

export function framePlacement(frame: AvatarFrame): { matrices: Matrix[]; bounds: Bounds } {
  const boxes = new Map(frame.paths.map((p) => [p.id, p.box]));
  const [ra, rb, rc, rd, re, rf] = frame.root;
  const bounds: Bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (m: Matrix, x: number, y: number) => {
    const X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5];
    if (X < bounds.x0) bounds.x0 = X;
    if (X > bounds.x1) bounds.x1 = X;
    if (Y < bounds.y0) bounds.y0 = Y;
    if (Y > bounds.y1) bounds.y1 = Y;
  };
  const matrices = frame.shapes.map((shape) => {
    const [a, b, c, d, e, f] = shape.matrix;
    const m: Matrix = [ra * a + rc * b, rb * a + rd * b, ra * c + rc * d, rb * c + rd * d, ra * e + rc * f + re, rb * e + rd * f + rf];
    const box = shape.kind === 'slice' ? boxes.get(shape.path) : shape.kind === 'eye' ? eyeBox(shape.mark) : shape.box;
    if (box) {
      add(m, box.x, box.y);
      add(m, box.x + box.w, box.y);
      add(m, box.x, box.y + box.h);
      add(m, box.x + box.w, box.y + box.h);
    }
    return m;
  });
  return { matrices, bounds };
}

export interface CanvasSurface {
  key: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;

  volume: (() => Volume) | null;
  cap: Square;
  fit: Square | null;
  layout: string;
  left: number;
  top: number;
}

export function mountCanvas(el: HTMLElement, key: string, definition: AvatarDefinition, depth: number | undefined): CanvasSurface {
  const cap = avatarExtent(definition, depth);
  const wrap = document.createElement('div');

  wrap.style.cssText = 'position:relative;width:100%;height:100%;pointer-events:none';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute';
  wrap.append(canvas);
  el.replaceChildren(wrap);
  let volume: Volume | undefined;
  return {
    key, canvas, ctx: canvas.getContext('2d'), cap, fit: null, layout: '', left: 0, top: 0,
    volume: depth === 0 ? null : () => (volume ??= preparedVolume(definition, depth).vol),
  };
}

const isMark = (shape: FrameShape) => shape.key.startsWith('mark-');

export function paintCanvas(surface: CanvasSurface, frame: AvatarFrame, size: number, fill = frame.color, ink = frame.ink, material: AvatarMaterial = 'flat') {
  const { canvas, ctx } = surface;
  if (!ctx || size <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  const scale = (size / 100) * dpr;
  const layout = `${size}|${dpr}`;
  if (sections.size > MAX_SECTIONS) sections.clear();
  for (const { id, d, evenOdd, box, round } of frame.paths) {

    const known = sections.get(id);
    if (!known || known.d !== d || known.round !== (round === true)) sections.set(id, { d, box, path: new Path2D(d), rule: evenOdd ? 'evenodd' : 'nonzero', round: round === true });
  }
  const { matrices, bounds } = framePlacement(frame);
  const finish = canvasMaterialOf(material);
  const volume = finish ? surface.volume : null;
  if (finish) {
    const margin = finish.margin ?? 0;
    bounds.x0 -= margin;
    bounds.y0 -= margin;
    bounds.x1 += margin;
    bounds.y1 += margin;
  }
  const fit = fitSquare(surface.layout === layout ? surface.fit : null, bounds, surface.cap);
  if (surface.layout === layout && fit === surface.fit) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  } else {

    surface.layout = layout;
    surface.fit = fit;
    surface.left = Math.floor(fit.x * scale);
    surface.top = Math.floor(fit.y * scale);
    const bitmap = Math.ceil(fit.size * scale) + 1;
    canvas.width = canvas.height = bitmap;
    canvas.style.left = `${surface.left / dpr}px`;
    canvas.style.top = `${surface.top / dpr}px`;
    canvas.style.width = canvas.style.height = `${bitmap / dpr}px`;
  }

  const { view, scale: bodyScale, eyes } = frame.surface;
  const coat = finish && volume && bodyScale > 0.001
    ? finish.render(volume(), view, { color: fill, ink, eyes }, scale)
    : null;
  let coatPainted = false;
  ctx.lineCap = 'round';
  ctx.strokeStyle = ink;
  ctx.fillStyle = fill;

  for (let i = 0; i < frame.shapes.length; i++) {
    const shape = frame.shapes[i]!, m = matrices[i]!;
    ctx.setTransform(scale * m[0], scale * m[1], scale * m[2], scale * m[3], scale * m[4] - surface.left, scale * m[5] - surface.top);
    if (shape.kind === 'slice') {
      const section = sections.get(shape.path) as Section;
      if (isMark(shape)) {

        if (!finish || !paintMark(finish, ctx, section, scale, fill)) ctx.fill(section.path, section.rule);
      } else if (!coat) {
        ctx.fill(section.path, section.rule);
      } else if (!coatPainted) {

        coatPainted = true;
        const [a, b, c, d, e, f] = frame.root;
        ctx.setTransform(scale * a, scale * b, scale * c, scale * d, scale * e - surface.left, scale * f - surface.top);
        const radius = coat.radius * bodyScale;
        ctx.drawImage(coat.canvas, coat.x, coat.y, coat.size, coat.size, coat.cx - radius, coat.cy - radius, 2 * radius, 2 * radius);
      }
    } else if (shape.kind === 'eye') {
      if (coat) continue;
      ctx.fillStyle = ink;
      paintEye(ctx, shape.mark);
      ctx.fillStyle = fill;
    } else {
      const g = shape.gradient;
      const paint = ctx.createLinearGradient(g.x1, g.y1, g.x2, g.y2);
      g.stops.forEach((c, i) => paint.addColorStop(i / (g.stops.length - 1), c));
      ctx.fillStyle = paint;
      ctx.fill(new Path2D(shape.d));
      ctx.fillStyle = fill;
    }
  }
}
