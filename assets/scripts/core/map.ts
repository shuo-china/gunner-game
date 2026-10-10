import { ENEMY_CONFIG as E, MAP_CONFIG as M } from './config';
import { Random } from './math';
import { AABB, TreeState, Vec2 } from './types';

export function treeCollider(position: Vec2): AABB {
  const x = position.x + E.treeColliderOffsetX;
  const z = position.z + E.treeColliderOffsetZ;
  return { minX: x - E.treeHalfExtent, maxX: x + E.treeHalfExtent, minZ: z - E.treeHalfExtent, maxZ: z + E.treeHalfExtent };
}

export function morton(x: number, z: number): number {
  const spread = (v: number): number => {
    v = (v | v << 8) & 0x00ff00ff;
    v = (v | v << 4) & 0x0f0f0f0f;
    v = (v | v << 2) & 0x33333333;
    return (v | v << 1) & 0x55555555;
  };
  return spread(x) | spread(z) << 1;
}

export function generateFirstMap(seed: number): TreeState[] {
  const random = new Random(seed);
  const slotCount = M.treeGridColumns * M.treeGridRows;
  const ordered = Array.from({ length: slotCount }, (_, index) => index)
    .sort((a, b) => morton(a % M.treeGridColumns, Math.floor(a / M.treeGridColumns)) - morton(b % M.treeGridColumns, Math.floor(b / M.treeGridColumns)));
  const selected = new Set<number>();
  for (let i = 0; i < M.treeCount; i++) selected.add(ordered[Math.floor(i * slotCount / M.treeCount)]);
  const trees: TreeState[] = [];
  for (let index = 0; index < slotCount; index++) {
    if (!selected.has(index)) continue;
    const position = {
      x: (index % M.treeGridColumns) * M.treeSpacing + M.treeOriginX + random.range(-M.treeJitter, M.treeJitter),
      z: Math.floor(index / M.treeGridColumns) * M.treeSpacing + M.treeOriginZ + random.range(-M.treeJitter, M.treeJitter),
    };
    const degree: 0 | 1 = random.next() < E.degreeZeroProbability ? 0 : 1;
    const health = E.healthByDegree[degree];
    trees.push({ id: index, position, health, maxHealth: health, degree, alive: true, collider: treeCollider(position) });
  }
  return trees;
}
