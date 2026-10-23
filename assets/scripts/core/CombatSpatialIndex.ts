import type { Damageable, Vec2 } from './types';

const CELL_SIZE = 8;
const MAX_CELLS = 256;
const MAX_COORDINATE = 1e7;

/** Conservative broad phase for the static Main/Mine collider pools. Health and
 * activation remain the caller's responsibility, so pooled revivals need no rebuild. */
export class CombatSpatialIndex {
  private readonly cells = new Map<number, Map<number, number[]>>();
  private readonly snapshots: { target: Damageable; minX: number; maxX: number; minZ: number; maxZ: number; shaped: boolean }[] = [];
  private readonly always: number[] = [];
  private readonly indices: number[] = [];
  private seen = new Uint32Array(0);
  private generation = 0;
  private targets: readonly Damageable[] = [];

  clear(): void {
    this.cells.clear(); this.snapshots.length = this.always.length = 0;
    this.targets = [];
  }

  /** Validate once per batch, not per projectile. Public fixture/editor pools may
   * replace, reorder or move a collider without resetting the world. */
  synchronize(targets: readonly Damageable[]): void {
    this.targets = targets;
    let changed = this.snapshots.length !== targets.length;
    if (!changed) for (let i = 0; i < targets.length; i++) {
      const target = targets[i], box = target.collider, saved = this.snapshots[i];
      if (saved.target !== target || !Object.is(saved.minX, box.minX) || !Object.is(saved.maxX, box.maxX) ||
          !Object.is(saved.minZ, box.minZ) || !Object.is(saved.maxZ, box.maxZ) ||
          saved.shaped !== !!(target.sphereCollider || target.orientedBoxCollider || target.capsuleCollider)) {
        changed = true; break;
      }
    }
    if (!changed) return;
    this.cells.clear(); this.snapshots.length = this.always.length = 0;
    if (this.seen.length < targets.length) this.seen = new Uint32Array(targets.length);
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i], box = target.collider;
      const shaped = !!(target.sphereCollider || target.orientedBoxCollider || target.capsuleCollider);
      this.snapshots.push({ target, minX: box.minX, maxX: box.maxX, minZ: box.minZ, maxZ: box.maxZ, shaped });
      // Unknown/moving shapes and unusual bounds are always tested precisely.
      if (shaped || !this.safeBounds(box.minX, box.minZ, box.maxX, box.maxZ)) { this.always.push(i); continue; }
      const x0 = Math.floor(box.minX / CELL_SIZE), x1 = Math.floor(box.maxX / CELL_SIZE);
      const z0 = Math.floor(box.minZ / CELL_SIZE), z1 = Math.floor(box.maxZ / CELL_SIZE);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > MAX_CELLS) { this.always.push(i); continue; }
      for (let x = x0; x <= x1; x++) {
        let column = this.cells.get(x);
        if (!column) this.cells.set(x, column = new Map());
        for (let z = z0; z <= z1; z++) {
          let cell = column.get(z);
          if (!cell) column.set(z, cell = []);
          cell.push(i);
        }
      }
    }
  }

  sweep(from: Vec2, to: Vec2, radius: number, output: Damageable[]): readonly Damageable[] {
    if (!Number.isFinite(radius) || radius < 0) return this.targets;
    // Exact sweeps accept a small epsilon beyond [0, 1]; preserve those contacts
    // even when an endpoint lies just across a grid boundary.
    const padding = radius + 1e-6 * (1 + Math.max(Math.abs(to.x - from.x), Math.abs(to.z - from.z)));
    return this.query(Math.min(from.x, to.x) - padding, Math.min(from.z, to.z) - padding,
      Math.max(from.x, to.x) + padding, Math.max(from.z, to.z) + padding, output);
  }

  around(point: Vec2, radius: number, output: Damageable[]): readonly Damageable[] {
    return this.sweep(point, point, radius, output);
  }

  private safeBounds(minX: number, minZ: number, maxX: number, maxZ: number): boolean {
    return Number.isFinite(minX) && Number.isFinite(minZ) && Number.isFinite(maxX) && Number.isFinite(maxZ) &&
      minX <= maxX && minZ <= maxZ && Math.max(Math.abs(minX), Math.abs(minZ), Math.abs(maxX), Math.abs(maxZ)) <= MAX_COORDINATE;
  }

  private query(minX: number, minZ: number, maxX: number, maxZ: number, output: Damageable[]): readonly Damageable[] {
    if (!this.safeBounds(minX, minZ, maxX, maxZ)) return this.targets;
    const x0 = Math.floor(minX / CELL_SIZE), x1 = Math.floor(maxX / CELL_SIZE);
    const z0 = Math.floor(minZ / CELL_SIZE), z1 = Math.floor(maxZ / CELL_SIZE);
    // Long sweeps/large explosions retain the original bounded full-pool scan.
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > MAX_CELLS) return this.targets;
    this.generation = (this.generation + 1) >>> 0;
    if (this.generation === 0) { this.seen.fill(0); this.generation = 1; }
    const indices = this.indices;
    indices.length = 0;
    for (const i of this.always) { indices.push(i); this.seen[i] = this.generation; }
    for (let x = x0; x <= x1; x++) {
      const column = this.cells.get(x);
      if (!column) continue;
      for (let z = z0; z <= z1; z++) {
        const cell = column.get(z);
        if (!cell) continue;
        for (const i of cell) if (this.seen[i] !== this.generation) {
          this.seen[i] = this.generation; indices.push(i);
        }
      }
    }
    // Preserve serialized pool order, including equal-time/equal-distance ties.
    indices.sort((a, b) => a - b);
    output.length = 0;
    for (const i of indices) output.push(this.targets[i]);
    return output;
  }
}
