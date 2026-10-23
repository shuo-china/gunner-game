import { sweepSphereBox } from '../core/WeaponBallistics';
import { sweepSphereSphere } from '../core/RaidCollision';
import type { OriginalParticle } from './OriginalParticleSimulation';

export interface ParticleCollisionBox {
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number; readonly enabled?: boolean;
  sphere?: { x: number; y: number; z: number; radius: number };
}
interface Point { x: number; y: number; z: number; }
const COLLISION_CELL_SIZE = 10;
const MAX_COLLIDER_CELLS = 64;
const COLLISION_QUERY_MARGIN = 1e-5;
const collisionOrder = (a: number, b: number): number => a - b;

/** Conservative XZ broad phase. Rebuild once when the collider snapshot moves;
 * enabled remains live (including colliders disabled when they were indexed).
 * query's scratch result is valid until the next query on this index. */
export class ParticleCollisionIndex {
  private colliders: readonly ParticleCollisionBox[] = [];
  private readonly grid = new Map<number, Map<number, number[]>>();
  private readonly rows: Map<number, number[]>[] = [];
  private readonly cells: number[][] = [];
  private usedRows = 0;
  private usedCells = 0;
  private minX = Infinity;
  private maxX = -Infinity;
  private minZ = Infinity;
  private maxZ = -Infinity;
  private readonly always: number[] = [];
  private readonly candidates: number[] = [];
  private readonly visited: number[] = [];
  private version = 0;
  private readonly result: ParticleCollisionBox[] = [];

  setColliders(colliders: readonly ParticleCollisionBox[]): void {
    this.colliders = colliders;
    this.grid.clear();
    for (let i = 0; i < this.usedRows; i++) this.rows[i].clear();
    this.usedRows = this.usedCells = 0; this.always.length = 0;
    this.minX = this.minZ = Infinity; this.maxX = this.maxZ = -Infinity;
    for (let index = 0; index < colliders.length; index++) {
      const box = colliders[index], sphere = box.sphere;
      // Raid's sphere can extend outside its informational box. The sphere,
      // rather than those box fields, determines its narrow-phase bounds.
      const minX = Math.floor((sphere ? sphere.x - sphere.radius : box.minX) / COLLISION_CELL_SIZE);
      const maxX = Math.floor((sphere ? sphere.x + sphere.radius : box.maxX) / COLLISION_CELL_SIZE);
      const minZ = Math.floor((sphere ? sphere.z - sphere.radius : box.minZ) / COLLISION_CELL_SIZE);
      const maxZ = Math.floor((sphere ? sphere.z + sphere.radius : box.maxZ) / COLLISION_CELL_SIZE);
      const count = (maxX - minX + 1) * (maxZ - minZ + 1);
      // Long map walls do not need thousands of cell entries. Invalid bounds
      // also stay conservative, leaving any handling to the unchanged sweep.
      if (!Number.isFinite(count) || !Number.isSafeInteger(minX) || !Number.isSafeInteger(maxX) ||
        !Number.isSafeInteger(minZ) || !Number.isSafeInteger(maxZ) || minX > maxX || minZ > maxZ || count > MAX_COLLIDER_CELLS) {
        this.always.push(index); continue;
      }
      this.minX = Math.min(this.minX, minX); this.maxX = Math.max(this.maxX, maxX);
      this.minZ = Math.min(this.minZ, minZ); this.maxZ = Math.max(this.maxZ, maxZ);
      for (let x = minX; x <= maxX; x++) {
        let row = this.grid.get(x);
        if (!row) { row = this.rows[this.usedRows] ?? (this.rows[this.usedRows] = new Map()); this.usedRows++; this.grid.set(x, row); }
        for (let z = minZ; z <= maxZ; z++) {
          let cell = row.get(z);
          if (!cell) { cell = this.cells[this.usedCells] ?? (this.cells[this.usedCells] = []); this.usedCells++; cell.length = 0; row.set(z, cell); }
          cell.push(index);
        }
      }
    }
  }

  query(from: Point, to: Point, radius: number): readonly ParticleCollisionBox[] {
    const result = this.result; result.length = 0;
    const loX = Math.min(from.x, to.x) - radius - COLLISION_QUERY_MARGIN;
    const hiX = Math.max(from.x, to.x) + radius + COLLISION_QUERY_MARGIN;
    const loZ = Math.min(from.z, to.z) - radius - COLLISION_QUERY_MARGIN;
    const hiZ = Math.max(from.z, to.z) + radius + COLLISION_QUERY_MARGIN;
    if (!Number.isFinite(loX) || !Number.isFinite(hiX) || !Number.isFinite(loZ) || !Number.isFinite(hiZ)) {
      for (const box of this.colliders) if (box.enabled !== false) result.push(box);
      return result;
    }
    const candidates = this.candidates; candidates.length = 0;
    for (const index of this.always) candidates.push(index);
    if (++this.version === Number.MAX_SAFE_INTEGER) { this.visited.fill(0); this.version = 1; }
    const minX = Math.max(this.minX, Math.floor(loX / COLLISION_CELL_SIZE));
    const maxX = Math.min(this.maxX, Math.floor(hiX / COLLISION_CELL_SIZE));
    const minZ = Math.max(this.minZ, Math.floor(loZ / COLLISION_CELL_SIZE));
    const maxZ = Math.min(this.maxZ, Math.floor(hiZ / COLLISION_CELL_SIZE));
    // A very long sweep through a sparse map is cheaper as a linear fallback
    // than visiting every empty cell between its endpoints.
    if ((maxX - minX + 1) * (maxZ - minZ + 1) > this.usedCells * 4 && minX <= maxX && minZ <= maxZ) {
      for (const box of this.colliders) if (box.enabled !== false) result.push(box);
      return result;
    }
    for (let x = minX; x <= maxX; x++) {
      const row = this.grid.get(x); if (!row) continue;
      for (let z = minZ; z <= maxZ; z++) {
        const cell = row.get(z); if (!cell) continue;
        for (const index of cell) if (this.visited[index] !== this.version) { this.visited[index] = this.version; candidates.push(index); }
      }
    }
    // Deduplicate cell membership by input index, not object identity: repeated
    // collider references and equal-time contacts retain the original ordering.
    candidates.sort(collisionOrder);
    for (const index of candidates) { const box = this.colliders[index]; if (box.enabled !== false) result.push(box); }
    return result;
  }
}
interface RawCurve {
  minMaxState: number; scalar: number; minScalar: number;
  maxCurve: { m_Curve: { time: number; value: number; inSlope: number; outSlope: number }[] };
  minCurve: RawCurve['maxCurve'];
}
interface NoiseModule {
  strength: RawCurve; strengthY: RawCurve; strengthZ: RawCurve; separateAxes: boolean;
  frequency: number; damping: boolean; octaves: number; octaveMultiplier: number; octaveScale: number;
  scrollSpeed: RawCurve; positionAmount: RawCurve; remapEnabled: boolean; remap: RawCurve; remapY: RawCurve; remapZ: RawCurve;
}
interface CollisionModule {
  m_Dampen: RawCurve; m_Bounce: RawCurve; m_EnergyLossOnCollision: RawCurve;
  minKillSpeed: number; maxKillSpeed: number; radiusScale: number;
  interiorCollisions?: boolean;
}
const NOISE_STEP = 1 / 120;

/** Recreates the source's enabled Noise and world Collision modules. Unity's
 * native curl-noise implementation is unavailable: this uses deterministic
 * bounded curl flow integrated over time with the original frequency, octave
 * and strength curves; it does not claim Unity's native particle trajectories.
 * No gameplay RNG, bullet positions, health or death events are changed. */
export function advanceParticleExtra(p: OriginalParticle, dt: number, from: Point,
  colliders: readonly ParticleCollisionBox[] = [], index?: ParticleCollisionIndex): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  if (p.spec.noise) advanceNoise(p, dt, from);
  if (!p.spec.collision || (!colliders.length && !index)) return;
  const collision = p.spec.collision as CollisionModule, to = { x: p.x, y: p.y, z: p.z };
  const radius = Math.max(0, p.size * .5 * collision.radiusScale);
  let hit: ParticleCollisionBox | undefined, nearest = Infinity;
  for (const box of index ? index.query(from, to, radius) : colliders) {
    if (box.enabled === false) continue;
    // The source smoke disables interior collisions. A newly emitted particle
    // already inside a tree may leave it; treating the sweep's t=0 overlap as
    // an external hit would repeatedly remove lifetime and trap that particle.
    const sphere = box.sphere;
    if (collision.interiorCollisions === false && (sphere
      ? Math.hypot(from.x - sphere.x, from.y - sphere.y, from.z - sphere.z) < sphere.radius
      : from.x > box.minX && from.x < box.maxX && from.y > box.minY && from.y < box.maxY && from.z > box.minZ && from.z < box.maxZ)) continue;
    const at = sphere ? sweepSphereSphere(from, to, radius, sphere, sphere.radius)
      : sweepSphereBox(from, to, radius, box, box.minY, box.maxY);
    if (at !== null && at < nearest) { nearest = at; hit = box; }
  }
  if (!hit) return;
  p.x = from.x + (to.x - from.x) * nearest; p.y = from.y + (to.y - from.y) * nearest; p.z = from.z + (to.z - from.z) * nearest;
  const normal = hit.sphere ? [p.x - hit.sphere.x, p.y - hit.sphere.y, p.z - hit.sphere.z]
    : [p.x - clamp(p.x, hit.minX, hit.maxX), p.y - clamp(p.y, hit.minY, hit.maxY), p.z - clamp(p.z, hit.minZ, hit.maxZ)];
  let length = Math.hypot(...normal);
  if (length < 1e-8) {
    const faces = [Math.abs(p.x - hit.minX), Math.abs(p.x - hit.maxX), Math.abs(p.y - hit.minY), Math.abs(p.y - hit.maxY), Math.abs(p.z - hit.minZ), Math.abs(p.z - hit.maxZ)];
    const face = faces.indexOf(Math.min(...faces)); normal[Math.floor(face / 2)] = face % 2 ? 1 : -1; length = 1;
  }
  for (let i = 0; i < 3; i++) normal[i] /= length;
  const t = Math.min(1, p.age / p.life), dot = p.vx * normal[0] + p.vy * normal[1] + p.vz * normal[2];
  const bounce = curve(collision.m_Bounce, t, p.random), keep = 1 - curve(collision.m_Dampen, t, p.random);
  if (dot < 0) {
    p.vx = (p.vx - (1 + bounce) * dot * normal[0]) * keep;
    p.vy = (p.vy - (1 + bounce) * dot * normal[1]) * keep;
    p.vz = (p.vz - (1 + bounce) * dot * normal[2]) * keep;
  }
  // Move outside the contact surface; a stationary touching particle must not
  // repeatedly lose lifetime solely because of an inclusive sphere sweep.
  p.x += normal[0] * 1e-5; p.y += normal[1] * 1e-5; p.z += normal[2] * 1e-5;
  p.age += p.life * curve(collision.m_EnergyLossOnCollision, t, p.random);
  const speed = Math.hypot(p.vx, p.vy, p.vz);
  if (speed < collision.minKillSpeed || speed > collision.maxKillSpeed || p.age >= p.life) p.active = false;
}

function advanceNoise(p: OriginalParticle, dt: number, from: Point): void {
  const noise = p.spec.noise as NoiseModule;
  // Substep the ordinary motion too: callers have already integrated velocity.
  // Sampling every catch-up substep at its final endpoint changes the flow with
  // frame rate. No previous-offset state is retained across particle-pool reuse.
  const steps = Math.max(1, Math.ceil(dt / NOISE_STEP)), step = dt / steps;
  const dx = (p.x - from.x) / steps, dy = (p.y - from.y) / steps, dz = (p.z - from.z) / steps;
  let x = from.x, y = from.y, z = from.z;
  for (let i = 0; i < steps; i++) {
    const age = p.age + i * step;
    const start = noiseVelocity(p, noise, x, y, z, age);
    // Midpoint integration keeps curved flow consistent across render rates.
    const velocity = noiseVelocity(p, noise, x + (dx + start[0] * step) * .5,
      y + (dy + start[1] * step) * .5, z + (dz + start[2] * step) * .5, age + step * .5);
    x += dx + velocity[0] * step; y += dy + velocity[1] * step; z += dz + velocity[2] * step;
  }
  p.x = x; p.y = y; p.z = z;
}

function noiseVelocity(p: OriginalParticle, noise: NoiseModule, x: number, y: number, z: number, age: number): number[] {
  const t = Math.min(1, age / p.life), seed = p.random * 1024, frequency = Math.max(.0001, noise.frequency);
  const scroll = age * curve(noise.scrollSpeed, t, p.random);
  const sample = [x * frequency + seed, y * frequency + seed * .7, z * frequency + scroll];
  let weight = 1, scale = 1, total = 0; const field = [0, 0, 0];
  for (let octave = 0; octave < Math.max(1, noise.octaves); octave++) {
    const curl = curlNoise(sample[0] * scale, sample[1] * scale, sample[2] * scale);
    for (let axis = 0; axis < 3; axis++) field[axis] += curl[axis] * weight;
    total += weight; weight *= noise.octaveMultiplier; scale *= noise.octaveScale;
  }
  // Finite-difference curl can exceed unit magnitude. Bound the flow before
  // applying authored strengths; treating it as an absolute offset teleports
  // newborn smoke and feeds back on later frames.
  const divisor = Math.max(.0001, total, Math.hypot(...field));
  const amount = curve(noise.positionAmount, t, p.random) * p.spec.scale / (noise.damping ? frequency : 1);
  const strengths = noise.separateAxes ? [noise.strength, noise.strengthY, noise.strengthZ] : [noise.strength, noise.strength, noise.strength];
  const remaps = noise.separateAxes ? [noise.remap, noise.remapY, noise.remapZ] : [noise.remap, noise.remap, noise.remap];
  return field.map((value, axis) => {
    value /= divisor;
    if (noise.remapEnabled) value = 2 * curve(remaps[axis], (value + 1) / 2, p.random) - 1;
    return value * amount * curve(strengths[axis], t, p.random);
  });
}

function curve(c: RawCurve, t: number, random: number): number {
  if (c.minMaxState === 0) return c.scalar;
  if (c.minMaxState === 3) return c.minScalar + random * (c.scalar - c.minScalar);
  const sample = (keys: RawCurve['maxCurve']['m_Curve']): number => {
    if (!keys.length) return 1;
    if (t <= keys[0].time) return keys[0].value;
    for (let i = 1; i < keys.length; i++) if (t <= keys[i].time) {
      const a = keys[i - 1], b = keys[i], d = b.time - a.time, u = (t - a.time) / d;
      return (2 * u ** 3 - 3 * u * u + 1) * a.value + (u ** 3 - 2 * u * u + u) * d * a.outSlope +
        (-2 * u ** 3 + 3 * u * u) * b.value + (u ** 3 - u * u) * d * b.inSlope;
    }
    return keys[keys.length - 1].value;
  };
  const high = sample(c.maxCurve.m_Curve);
  return c.scalar * (c.minMaxState === 2 ? sample(c.minCurve.m_Curve) * (1 - random) + high * random : high);
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function noise(x: number, y: number, z: number): number {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z), values: number[] = [];
  const fade = (v: number) => v * v * v * (v * (v * 6 - 15) + 10);
  const u = fade(x - X), v = fade(y - Y), w = fade(z - Z);
  for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    let h = Math.imul(X + dx, 374761393) ^ Math.imul(Y + dy, 668265263) ^ Math.imul(Z + dz, 1442695041);
    h = Math.imul(h ^ h >>> 13, 1274126177); values.push(((h ^ h >>> 16) >>> 0) / 2147483647.5 - 1);
  }
  const mix = (a: number, b: number, f: number) => a + (b - a) * f;
  return mix(mix(mix(values[0], values[1], u), mix(values[2], values[3], u), v),
    mix(mix(values[4], values[5], u), mix(values[6], values[7], u), v), w);
}
function curlNoise(x: number, y: number, z: number): number[] {
  const e = .01, field = (axis: number, dx: number, dy: number, dz: number) => noise(x + dx + axis * 31.7, y + dy + axis * 17.3, z + dz + axis * 47.1);
  return [
    (field(2, 0, e, 0) - field(2, 0, -e, 0) - field(1, 0, 0, e) + field(1, 0, 0, -e)) / (2 * e),
    (field(0, 0, 0, e) - field(0, 0, 0, -e) - field(2, e, 0, 0) + field(2, -e, 0, 0)) / (2 * e),
    (field(1, e, 0, 0) - field(1, -e, 0, 0) - field(0, 0, e, 0) + field(0, 0, -e, 0)) / (2 * e),
  ];
}
