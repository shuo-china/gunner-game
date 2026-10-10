import { AABB, SweepHit, Vec2 } from './types';

export const EPSILON = 1e-8;
export const clamp = (v: number, low: number, high: number): number => Math.max(low, Math.min(high, v));
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const length = (v: Vec2): number => Math.sqrt(v.x * v.x + v.z * v.z);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const normalize = (v: Vec2): Vec2 => {
  const magnitude = length(v);
  return magnitude > EPSILON ? { x: v.x / magnitude, z: v.z / magnitude } : { x: 0, z: 0 };
};
export const closestPoint = (p: Vec2, box: AABB): Vec2 => ({
  x: clamp(p.x, box.minX, box.maxX), z: clamp(p.z, box.minZ, box.maxZ),
});
export const distanceToBox = (p: Vec2, box: AABB): number => Math.hypot(
  p.x - clamp(p.x, box.minX, box.maxX), p.z - clamp(p.z, box.minZ, box.maxZ),
);

/** Exact circle-vs-box overlap: the expanded shape has round, not square, corners. */
export function circleOverlapsBox(p: Vec2, radius: number, box: AABB): boolean {
  return distanceToBox(p, box) < radius - EPSILON;
}

/** Earliest segment hit against a box's rounded Minkowski sum with a circle. */
export function sweepCircleAABB(start: Vec2, end: Vec2, radius: number, box: AABB): SweepHit | null {
  const dx = end.x - start.x, dz = end.z - start.z;
  const separationX = start.x - clamp(start.x, box.minX, box.maxX);
  const separationZ = start.z - clamp(start.z, box.minZ, box.maxZ);
  const initialDistance = Math.sqrt(separationX * separationX + separationZ * separationZ);
  if (initialDistance < radius - EPSILON) {
    let normal: Vec2;
    if (initialDistance < EPSILON) normal = penetrationNormal(start, box);
    else if (initialDistance > EPSILON) normal = { x: separationX / initialDistance, z: separationZ / initialDistance };
    else normal = { x: 0, z: 0 }; // Preserve normalize's strict epsilon boundary.
    return { time: 0, normal };
  }
  const a = dx * dx + dz * dz;
  if (Math.sqrt(a) < EPSILON) return null;
  // Keep candidate order (X faces, Z faces, then corners) so equal-time
  // contacts retain the same normal. Misses allocate no intermediate vectors.
  let bestTime = Infinity, normalX = 0, normalZ = 0;
  for (let axis = 0; axis < 2; axis++) {
    const delta = axis === 0 ? dx : dz;
    if (Math.abs(delta) <= EPSILON) continue;
    const origin = axis === 0 ? start.x : start.z;
    const minimum = axis === 0 ? box.minX : box.minZ;
    const maximum = axis === 0 ? box.maxX : box.maxZ;
    const otherOrigin = axis === 0 ? start.z : start.x;
    const otherDelta = axis === 0 ? dz : dx;
    const otherMin = axis === 0 ? box.minZ : box.minX;
    const otherMax = axis === 0 ? box.maxZ : box.maxX;
    for (let side = -1; side <= 1; side += 2) {
      const face = side < 0 ? minimum - radius : maximum + radius;
      const time = (face - origin) / delta;
      const other = otherOrigin + otherDelta * time;
      if (other < otherMin - EPSILON || other > otherMax + EPSILON ||
        time < -EPSILON || time > 1 + EPSILON || delta * side >= -EPSILON) continue;
      const t = clamp01(time);
      if (t < bestTime) {
        bestTime = t;
        normalX = axis === 0 ? side : 0;
        normalZ = axis === 0 ? 0 : side;
      }
    }
  }
  for (let sx = -1; sx <= 1; sx += 2) for (let sz = -1; sz <= 1; sz += 2) {
    const cornerX = sx < 0 ? box.minX : box.maxX, cornerZ = sz < 0 ? box.minZ : box.maxZ;
    const offsetX = start.x - cornerX, offsetZ = start.z - cornerZ;
    const b = 2 * (offsetX * dx + offsetZ * dz);
    const c = offsetX * offsetX + offsetZ * offsetZ - radius * radius;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) continue;
    const time = (-b - Math.sqrt(discriminant)) / (2 * a);
    const qx = start.x + dx * time - cornerX, qz = start.z + dz * time - cornerZ;
    if (qx * sx < -EPSILON || qz * sz < -EPSILON || time < -EPSILON || time > 1 + EPSILON) continue;
    const magnitude = Math.sqrt(qx * qx + qz * qz);
    const nx = magnitude > EPSILON ? qx / magnitude : 0, nz = magnitude > EPSILON ? qz / magnitude : 0;
    if (dx * nx + dz * nz >= -EPSILON) continue;
    const t = clamp01(time);
    if (t < bestTime) { bestTime = t; normalX = nx; normalZ = nz; }
  }
  return bestTime === Infinity ? null : { time: bestTime, normal: { x: normalX, z: normalZ } };
}

function penetrationNormal(p: Vec2, box: AABB): Vec2 {
  let depth = p.x - box.minX, x = -1, z = 0;
  if (box.maxX - p.x < depth) { depth = box.maxX - p.x; x = 1; }
  if (p.z - box.minZ < depth) { depth = p.z - box.minZ; x = 0; z = -1; }
  if (box.maxZ - p.z < depth) { x = 0; z = 1; }
  return { x, z };
}

export function rayAABB(origin: Vec2, direction: Vec2, maxDistance: number, box: AABB): number | null {
  let near = 0;
  let far = maxDistance;
  for (let axis = 0; axis < 2; axis++) {
    const min = axis === 0 ? box.minX : box.minZ;
    const max = axis === 0 ? box.maxX : box.maxZ;
    const component = axis === 0 ? direction.x : direction.z;
    const start = axis === 0 ? origin.x : origin.z;
    if (Math.abs(component) < EPSILON) {
      if (start < min || start > max) return null;
      continue;
    }
    let a = (min - start) / component;
    let b = (max - start) / component;
    if (a > b) { const swap = a; a = b; b = swap; }
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return null;
  }
  return near;
}

/** Stable local PRNG; reset uses the seed to reproduce all map and shot decisions. */
export class Random {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0 || 0x6d2b79f5; }
  next(): number {
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }
  range(min: number, max: number): number { return min + this.next() * (max - min); }
}
