import { filledArea, flattenPath, parsePath, serializePath, type Segment } from '../../path';
import { viewBasis, type FramePath } from '../../render';
import { analyzeBody } from '../../validate';
import { buildVolume, type Volume } from '../../volume';
import type { CanvasMaterial } from './material';
import type { Capsule } from './shape';

const RADIUS = 12;
const FRONT = viewBasis(0, 0);

const HEADROOM = 1.12;

const models = new Map<number, Capsule>();

const sprites = new WeakMap<CanvasMaterial, Map<string, Sprite>>();

interface Sprite { canvas: HTMLCanvasElement; cx: number; cy: number; radius: number }
const MAX_SPRITES = 32;

function paintCapsule(material: CanvasMaterial, ctx: CanvasRenderingContext2D, box: FramePath['box'], scale: number, color: string): boolean {
  const aspect = Math.round((1000 * box.h) / box.w) / 1000;
  let model = models.get(aspect);
  if (!model) {
    const halfHeight = RADIUS * aspect;
    model = { radius: RADIUS, bounds: { minX: -RADIUS, maxX: RADIUS, minY: -halfHeight, maxY: halfHeight } };
    if (models.size >= MAX_OUTLINES) models.clear();
    models.set(aspect, model);
  }

  const unit = box.w / (2 * RADIUS);

  const density = Math.min(8, Math.max(0.5, 2 ** Math.ceil(Math.log2(HEADROOM * scale * unit))));
  const sprite = spriteOf(material, `${aspect}|${color}|${density}`, model, color, density);
  if (!sprite) return false;
  const radius = sprite.radius * unit;
  ctx.drawImage(sprite.canvas, -radius, -radius, 2 * radius, 2 * radius);
  return true;
}

function spriteOf(material: CanvasMaterial, key: string, model: Capsule | Volume, color: string, density: number): Sprite | null {
  let kept = sprites.get(material);
  if (!kept) sprites.set(material, (kept = new Map()));
  let sprite = kept.get(key);
  if (sprite) return sprite;
  const image = material.render(model, FRONT, { color, ink: color, eyes: [] }, density);
  if (!image) return null;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = image.size;
  const copy = canvas.getContext('2d');
  if (!copy) return null;
  copy.drawImage(image.canvas, image.x, image.y, image.size, image.size, 0, 0, image.size, image.size);
  sprite = { canvas, cx: image.cx, cy: image.cy, radius: image.radius };
  if (kept.size >= MAX_SPRITES) kept.delete(kept.keys().next().value!);
  kept.set(key, sprite);
  return sprite;
}

interface OutlineModel { key: string; volume: Volume; scale: number; cx: number; cy: number }
const CENTRE = 50;

const FIT = 84;

const outlines = new Map<string, OutlineModel | null>();
const volumes = new Map<string, Volume>();
const MAX_OUTLINES = 64;

export function outlineModel(d: string, box: FramePath['box']): OutlineModel | null {

  const name = `${d}|${box.x},${box.y},${box.w},${box.h}`;
  const known = outlines.get(name);
  if (known !== undefined) return known;
  let model: OutlineModel | null = null;
  try {
    const segs = parsePath(d, false);
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const moved = (scale: number) => {
      const X = (x: number) => CENTRE + (x - cx) * scale, Y = (y: number) => CENTRE + (y - cy) * scale;
      return segs.map((s): Segment => {
        if (s.c === 'Z') return s;
        if (s.c === 'A') return { ...s, rx: s.rx * scale, ry: s.ry * scale, x: X(s.x), y: Y(s.y) };
        if (s.c === 'C') return { ...s, x1: X(s.x1), y1: Y(s.y1), x2: X(s.x2), y2: Y(s.y2), x: X(s.x), y: Y(s.y) };
        if (s.c === 'Q') return { ...s, x1: X(s.x1), y1: Y(s.y1), x: X(s.x), y: Y(s.y) };
        return { ...s, x: X(s.x), y: Y(s.y) };
      });
    };

    const fit = FIT / Math.max(box.w, box.h);
    const polys = flattenPath(moved(fit));
    let round = 0;
    for (const poly of polys) {
      poly.forEach(([x, y], i) => {
        const next = poly[(i + 1) % poly.length]!;
        round += Math.hypot(next[0] - x, next[1] - y);
      });
    }
    const stroke = (2 * filledArea(polys)) / round;
    const scale = fit * Math.min(1, (2 * RADIUS) / stroke);
    if (stroke > 0 && Number.isFinite(scale)) {
      const key = serializePath(moved(scale));
      let volume = volumes.get(key);
      if (!volume) {

        const def = { version: 1 as const, id: 'mark', name: 'mark', body: { path: key }, eyes: { x: CENTRE, y: CENTRE, spacing: 10, scale: 1 } };
        volume = buildVolume(def, 1, analyzeBody(key, false));
        if (volumes.size >= MAX_OUTLINES) volumes.delete(volumes.keys().next().value!);
        volumes.set(key, volume);
      }
      model = { key, volume, scale, cx, cy };
    }
  } catch {
    model = null;
  }
  if (outlines.size >= MAX_OUTLINES) outlines.delete(outlines.keys().next().value!);
  outlines.set(name, model);
  return model;
}

function paintOutline(material: CanvasMaterial, ctx: CanvasRenderingContext2D, d: string, box: FramePath['box'], scale: number, color: string): boolean {
  const model = outlineModel(d, box);
  if (!model) return false;

  const density = Math.min(8, Math.max(0.5, 2 ** Math.ceil(Math.log2((HEADROOM * scale) / model.scale))));
  const sprite = spriteOf(material, `${model.key}|${color}|${density}`, model.volume, color, density);
  if (!sprite) return false;
  const radius = sprite.radius / model.scale;
  ctx.drawImage(sprite.canvas, model.cx + (sprite.cx - CENTRE) / model.scale - radius, model.cy + (sprite.cy - CENTRE) / model.scale - radius, 2 * radius, 2 * radius);
  return true;
}

export function paintMark(
  material: CanvasMaterial, ctx: CanvasRenderingContext2D, part: { d: string; box: FramePath['box']; round: boolean }, scale: number, color: string,
): boolean {
  return part.round ? paintCapsule(material, ctx, part.box, scale, color) : paintOutline(material, ctx, part.d, part.box, scale, color);
}
