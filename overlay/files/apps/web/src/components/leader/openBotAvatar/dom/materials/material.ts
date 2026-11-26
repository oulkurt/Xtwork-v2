import type { SurfaceEye, ViewBasis } from '../../render';
import type { MaterialShape } from './shape';

export interface MaterialImage {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  size: number;
  cx: number;
  cy: number;
  radius: number;
}

export interface MaterialLook {
  color: string;
  ink: string;
  eyes: SurfaceEye[];
}

export interface CanvasMaterial {
  readonly id: string;

  readonly margin?: number;

  render(shape: MaterialShape, view: ViewBasis, look: MaterialLook, scale: number): MaterialImage | null;
}

export type AvatarMaterial = 'flat' | CanvasMaterial;

const ENTRIES: Record<string, string> = { fluffy: 'open-bot-avatar/materials/fluffy', glass: 'open-bot-avatar/materials/glass' };
const warned = new Set<string>();

export function canvasMaterialOf(material: unknown): CanvasMaterial | null {
  if (material === undefined || material === null || material === 'flat') return null;
  if (typeof material === 'object' && material !== null && typeof (material as CanvasMaterial).render === 'function') return material as CanvasMaterial;
  const name = typeof material === 'string' ? JSON.stringify(material) : typeof material;
  if (!warned.has(name) && warned.size < 16) {
    warned.add(name);
    const entry = typeof material === 'string' ? ENTRIES[material] : undefined;
    console.warn(
      `open-bot-avatar: material ${name} is not a material, drawing flat. ` +
        (entry ? `Import { ${material} } from "${entry}" and pass it as \`material\`.` : 'Pass "flat" or an imported material, such as { fluffy } from "open-bot-avatar/materials/fluffy".'),
    );
  }
  return null;
}
