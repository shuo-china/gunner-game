import { AABB } from './types';

export interface ProjectilePoint { x: number; y: number; z: number }
/** Exact swept sphere against a 3D box. The closest-point distance is a
 * quadratic on each slab interval, including rounded edges and corners. */
export function sweepSphereBox(from: ProjectilePoint, to: ProjectilePoint, radius: number,
  box: AABB, minY: number, maxY: number): number | null {
  const start = [from.x, from.y, from.z], delta = [to.x - from.x, to.y - from.y, to.z - from.z];
  const low = [box.minX, minY, box.minZ], high = [box.maxX, maxY, box.maxZ];
  const cuts = [0, 1];
  for (let axis = 0; axis < 3; axis++) if (Math.abs(delta[axis]) > 1e-12) {
    for (const edge of [low[axis], high[axis]]) {
      const t = (edge - start[axis]) / delta[axis];
      if (t > 0 && t < 1) cuts.push(t);
    }
  }
  cuts.sort((a, b) => a - b);
  for (let interval = 0; interval + 1 < cuts.length; interval++) {
    const left = cuts[interval], right = cuts[interval + 1], middle = (left + right) * 0.5;
    let a = 0, b = 0, c = -radius * radius;
    for (let axis = 0; axis < 3; axis++) {
      const value = start[axis] + delta[axis] * middle;
      const edge = value < low[axis] ? low[axis] : value > high[axis] ? high[axis] : null;
      if (edge === null) continue;
      const offset = start[axis] - edge;
      a += delta[axis] ** 2; b += 2 * offset * delta[axis]; c += offset ** 2;
    }
    if (a * left * left + b * left + c <= 1e-10) return left;
    const discriminant = b * b - 4 * a * c;
    if (a > 1e-12 && discriminant >= 0) {
      const root = (-b - Math.sqrt(discriminant)) / (2 * a);
      if (root >= left - 1e-10 && root <= right + 1e-10) return Math.max(left, Math.min(right, root));
    }
  }
  return null;
}
