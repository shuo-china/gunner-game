import type { Damageable, Vec2 } from './types';
import type { ProjectilePoint } from './WeaponBallistics';

/** Exact segment against a sphere, including projectile radius. Unlike a box,
 * its XZ cross-section shrinks as an arcing missile rises above the center. */
export function sweepSphereSphere(from: ProjectilePoint, to: ProjectilePoint, radius: number,
  center: ProjectilePoint, targetRadius: number): number | null {
  const x = from.x - center.x, y = from.y - center.y, z = from.z - center.z;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const r = radius + targetRadius, c = x * x + y * y + z * z - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy + dz * dz;
  if (a <= 1e-16) return null;
  const b = x * dx + y * dy + z * dz, discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / a;
  return t >= 0 && t <= 1 ? t : null;
}

export function sphereCenter(target: Damageable): ProjectilePoint {
  return { x: (target.collider.minX + target.collider.maxX) / 2,
    y: target.sphereCollider!.centerY, z: (target.collider.minZ + target.collider.maxZ) / 2 };
}

/** Physics.ClosestPoint returns the supplied point when already inside. */
export function closestPointOnSphere(point: Vec2, height: number, target: Damageable): ProjectilePoint {
  const center = sphereCenter(target), radius = target.sphereCollider!.radius;
  const dx = point.x - center.x, dy = height - center.y, dz = point.z - center.z;
  const length = Math.hypot(dx, dy, dz);
  if (length <= radius) return { x: point.x, y: height, z: point.z };
  const scale = radius / length;
  return { x: center.x + dx * scale, y: center.y + dy * scale, z: center.z + dz * scale };
}
