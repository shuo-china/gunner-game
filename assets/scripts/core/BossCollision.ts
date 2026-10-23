import { clamp, closestPoint, length, normalize, sweepCircleAABB } from './math';
import { sweepSphereBox, ProjectilePoint } from './WeaponBallistics';
import type { AABB, OrientedBoxCollider, SweepHit, Vec2 } from './types';

/** Unity's Y rotation: worldX=cos*x+sin*z, worldZ=-sin*x+cos*z. */
export function boxLocal(point: Vec2, box: OrientedBoxCollider): Vec2 {
  const x = point.x - box.center.x, z = point.z - box.center.z;
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
  return { x: c * x - s * z, z: s * x + c * z };
}
export function boxWorld(point: Vec2, box: OrientedBoxCollider): Vec2 {
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
  return { x: box.center.x + c * point.x + s * point.z, z: box.center.z - s * point.x + c * point.z };
}
function localBounds(box: OrientedBoxCollider): AABB {
  return { minX: -box.halfX, maxX: box.halfX, minZ: -box.halfZ, maxZ: box.halfZ };
}
export function orientedBoxBounds(box: OrientedBoxCollider): AABB {
  const c = Math.abs(Math.cos(box.yaw)), s = Math.abs(Math.sin(box.yaw));
  const x = c * box.halfX + s * box.halfZ, z = s * box.halfX + c * box.halfZ;
  return { minX: box.center.x - x, maxX: box.center.x + x, minZ: box.center.z - z, maxZ: box.center.z + z };
}
export function closestPointOnOrientedBox(point: Vec2, height: number, box: OrientedBoxCollider): ProjectilePoint {
  return { ...boxWorld(closestPoint(boxLocal(point, box), localBounds(box)), box), y: clamp(height, box.minY, box.maxY) };
}
export function insideOrientedBox(point: Vec2, height: number, box: OrientedBoxCollider): boolean {
  const p = boxLocal(point, box);
  return Math.abs(p.x) < box.halfX && Math.abs(p.z) < box.halfZ && height > box.minY && height < box.maxY;
}
export function sweepSphereOrientedBox(from: ProjectilePoint, to: ProjectilePoint, radius: number, box: OrientedBoxCollider): number | null {
  return sweepSphereBox({ ...boxLocal(from, box), y: from.y }, { ...boxLocal(to, box), y: to.y }, radius, localBounds(box), box.minY, box.maxY);
}
export function sweepCircleOrientedBox(from: Vec2, to: Vec2, radius: number, box: OrientedBoxCollider): SweepHit | null {
  const hit = sweepCircleAABB(boxLocal(from, box), boxLocal(to, box), radius, localBounds(box));
  if (!hit) return null;
  const n = boxWorld(hit.normal, { ...box, center: { x: 0, z: 0 } });
  return { time: hit.time, normal: n };
}
export function separateCircleOrientedBox(point: Vec2, radius: number, box: OrientedBoxCollider): Vec2 {
  const p = boxLocal(point, box), near = closestPoint(p, localBounds(box));
  const delta = { x: p.x - near.x, z: p.z - near.z }, d = length(delta);
  if (d >= radius - 1e-8) return point;
  const r = radius + 1e-6;
  if (d > 1e-8) {
    const n = normalize(delta); return boxWorld({ x: near.x + n.x * r, z: near.z + n.z * r }, box);
  }
  const faces = [{ x: -box.halfX - r, z: p.z }, { x: box.halfX + r, z: p.z },
    { x: p.x, z: -box.halfZ - r }, { x: p.x, z: box.halfZ + r }];
  faces.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
  return boxWorld(faces[0], box);
}
/** Exact translational SAT for Cat's axis-aligned BoxCast against the yawed
 * Boss collider. Expanding its world AABB alone gives false corner obstacles. */
export function sweepBoxOrientedBox(from: Vec2, to: Vec2, halfX: number, halfZ: number,
  minY: number, maxY: number, box: OrientedBoxCollider): number | null {
  if (maxY < box.minY || minY > box.maxY) return null;
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw), u = { x: c, z: -s }, v = { x: s, z: c };
  let enter = 0, exit = 1;
  for (const axis of [{ x: 1, z: 0 }, { x: 0, z: 1 }, u, v]) {
    const extent = halfX * Math.abs(axis.x) + halfZ * Math.abs(axis.z) +
      box.halfX * Math.abs(axis.x * u.x + axis.z * u.z) + box.halfZ * Math.abs(axis.x * v.x + axis.z * v.z);
    const origin = (from.x - box.center.x) * axis.x + (from.z - box.center.z) * axis.z;
    const velocity = (to.x - from.x) * axis.x + (to.z - from.z) * axis.z;
    if (Math.abs(velocity) < 1e-12) { if (Math.abs(origin) > extent) return null; continue; }
    const a = (-extent - origin) / velocity, b = (extent - origin) / velocity;
    enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return null;
  }
  return enter;
}
