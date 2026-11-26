import type { Bounds } from '../../path';
import type { Volume } from '../../volume';

export interface Capsule {
  bounds: Bounds;
  radius: number;
}

export type MaterialShape = Volume | Capsule;

export function halfDepth(shape: MaterialShape): number {
  return 'radius' in shape ? shape.radius : Math.max(0.5, ...shape.parts.map((part) => part.depth / 2));
}
