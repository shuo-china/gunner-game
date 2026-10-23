import { clamp } from './math';
import { sweepSphereSphere } from './RaidCollision';
import type { Damageable, Vec2 } from './types';
import type { ProjectilePoint } from './WeaponBallistics';

/** The unscaled Y-axis CapsuleCollider is independent of the monster artwork. */
export function huntCapsuleAxis(target: Damageable): { x: number; z: number; minY: number; maxY: number; radius: number } {
  const shape = target.capsuleCollider!, half = Math.max(0, shape.height / 2 - shape.radius);
  const y = shape.centerY + shape.transformY, bounds = target.collider;
  return { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2,
    minY: y - half, maxY: y + half, radius: shape.radius };
}

export function insideHuntCapsule(point: Vec2, height: number, target: Damageable): boolean {
  const axis = huntCapsuleAxis(target);
  return Math.hypot(point.x - axis.x, point.z - axis.z, height - clamp(height, axis.minY, axis.maxY)) < axis.radius;
}

export function closestPointOnHuntCapsule(point: Vec2, height: number, target: Damageable): ProjectilePoint {
  const axis = huntCapsuleAxis(target), y = clamp(height, axis.minY, axis.maxY);
  const dx = point.x - axis.x, dy = height - y, dz = point.z - axis.z, length = Math.hypot(dx, dy, dz);
  if (length <= axis.radius) return { x: point.x, y: height, z: point.z };
  const scale = axis.radius / length;
  return { x: axis.x + dx * scale, y: y + dy * scale, z: axis.z + dz * scale };
}

/** Exact swept sphere against the capsule's cylindrical middle and two caps. */
export function sweepSphereHuntCapsule(from: ProjectilePoint, to: ProjectilePoint, radius: number, target: Damageable): number | null {
  const axis = huntCapsuleAxis(target), r = axis.radius + radius;
  const x = from.x - axis.x, z = from.z - axis.z, y = from.y - clamp(from.y, axis.minY, axis.maxY);
  if (x * x + z * z + y * y <= r * r) return 0;
  let best = Infinity;
  for (const capY of [axis.minY, axis.maxY]) {
    const hit = sweepSphereSphere(from, to, radius, { x: axis.x, y: capY, z: axis.z }, axis.radius);
    if (hit !== null) best = Math.min(best, hit);
  }
  const dx = to.x - from.x, dz = to.z - from.z, a = dx * dx + dz * dz;
  if (a > 1e-16) {
    const b = x * dx + z * dz, c = x * x + z * z - r * r, discriminant = b * b - a * c;
    if (discriminant >= 0) {
      const t = (-b - Math.sqrt(discriminant)) / a, atY = from.y + (to.y - from.y) * t;
      if (t >= 0 && t <= 1 && atY >= axis.minY && atY <= axis.maxY) best = Math.min(best, t);
    }
  }
  return best === Infinity ? null : best;
}
