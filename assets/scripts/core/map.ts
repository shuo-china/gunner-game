import { ENEMY_CONFIG as E, MAP_CONFIG as M } from './config';
import { Random } from './math';
import { OriginalInfVal } from './OriginalInfVal';
import { AABB, OreState, TreeState, Vec2 } from './types';
import type { RaidBossCombat } from './RaidBossCombat';
import type { BossCombat } from './BossCombat';
import type { HuntCombat } from './HuntCombat';
import { getStageHealth, getStageHealthPrecision, getStageMoney, getStageMoneyPrecision, getStageTreeCount, STAGE_DEGREE_RATES,
  STAGE_HEALTH_MULTIPLIERS, STAGE_MONEY_MULTIPLIERS, validateStage } from './StageBalance';

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

export interface StageDefinition {
  stageIndex: number;
  waveIndex: number;
  skinIndex: number;
  trees: TreeState[];
  /** Independent Mine targets never enter the ordinary tree/gold ledger. */
  ores?: OreState[];
  /** Raid's continuously respawning Enemy is not a tree or a gold reward. */
  raidBoss?: RaidBossCombat;
  boss?: BossCombat;
  hunt?: HuntCombat;
  bounds: AABB;
  bulletWalls: Array<AABB & { minY: number; maxY: number }>;
  /** Source scene roots are separated in absolute XZ space. */
  spawnPosition?: Vec2;
  mapOrigin?: Vec2;
  /** The challenge has a single open ground plane, not Main's corridor. */
  mapLayout?: 'main' | 'arena' | 'raid' | 'boss' | 'hunt' | 'mine';
}

/** Runtime Tree_Batch: activate 1..5 original grid banks and a fifth-wave Boss. */
export function createStageDefinition(stageIndex: number, waveIndex: number, seed: number): StageDefinition {
  validateStage(stageIndex, waveIndex);
  const random = new Random(seed);
  const slotCount = M.treeGridColumns * M.treeGridRows;
  const count = getStageTreeCount(stageIndex);
  const baseHealth = getStageHealth(stageIndex), baseMoney = getStageMoney(stageIndex);
  // Tree_Batch multiplies the serialized InfVal operands before assigning HP.
  // Preserve the table precision: degree-1's double promotes it to p17, while
  // the integer multipliers retain the larger operand precision.
  const healthValues = STAGE_HEALTH_MULTIPLIERS.map(multiplier => OriginalInfVal.fromAmount(baseHealth, getStageHealthPrecision(stageIndex))
    .mul(Number.isInteger(multiplier) ? OriginalInfVal.fromInt(multiplier) : OriginalInfVal.fromDouble(multiplier)));
  const rewards = STAGE_MONEY_MULTIPLIERS.map(multiplier => OriginalInfVal.fromAmount(baseMoney, getStageMoneyPrecision(stageIndex))
    .mul(Number.isInteger(multiplier) ? OriginalInfVal.fromInt(multiplier) : OriginalInfVal.fromDouble(multiplier)));
  const ordered = Array.from({ length: slotCount }, (_, index) => index)
    .sort((a, b) => morton(a % M.treeGridColumns, Math.floor(a / M.treeGridColumns)) - morton(b % M.treeGridColumns, Math.floor(b / M.treeGridColumns)));
  const selected = new Set<number>();
  for (let i = 0; i < count; i++) selected.add(ordered[Math.floor(i * slotCount / count)]);
  const trees: TreeState[] = [];
  for (let grid = 0; grid <= waveIndex; grid++) {
  for (let index = 0; index < slotCount; index++) {
    if (!selected.has(index)) continue;
    const position = {
      x: (index % M.treeGridColumns) * M.treeSpacing + M.treeOriginX + random.range(-M.treeJitter, M.treeJitter),
      z: grid * M.treeGridStride + Math.floor(index / M.treeGridColumns) * M.treeSpacing + M.treeOriginZ + random.range(-M.treeJitter, M.treeJitter),
    };
    const roll = random.next() * 100;
    let sum = 0, degree: 0 | 1 | 2 | 3 = 0;
    for (let candidate = 0; candidate < 4; candidate++) {
      sum += STAGE_DEGREE_RATES[waveIndex][candidate];
      if (roll < sum) { degree = candidate as 0 | 1 | 2 | 3; break; }
    }
    const health = healthValues[degree];
    // Tree_Grid.Spawn reuses its serialized Tree_list[index] and collider even
    // when a different stage changes which slots are active. Keep pool identity
    // independent of the live-array order and stage/round for Bullet._hitIds.
    trees.push({ id: grid * slotCount + index, position, health: health.amount, maxHealth: health.amount, healthPrecision: health.precision, degree, stageIndex,
      gridOriginZ: M.treeGridOriginZ + grid * M.treeGridStride,
      reward: rewards[degree].amount, rewardPrecision: rewards[degree].precision, alive: true, collider: treeCollider(position) });
  }
  }
  if (waveIndex === 4) {
    // BossTree is a distinct serialized object, not part of any Tree_Grid.
    const position = { x: 0, z: 282 }, health = healthValues[3];
    trees.push({ id: 500, position, health: health.amount, maxHealth: health.amount, healthPrecision: health.precision, degree: 3, stageIndex,
      reward: rewards[3].amount, rewardPrecision: rewards[3].precision, alive: true,
      collider: { minX: -3.5, maxX: 3.5, minZ: 278.5, maxZ: 285.5 } });
  }
  const north = (waveIndex + 1) * 50 + 60;
  return { stageIndex, waveIndex, skinIndex: stageIndex % 10, trees,
    bounds: { minX: M.mapMinX, maxX: M.mapMaxX, minZ: M.mapMinZ, maxZ: north - 2.5 },
    bulletWalls: M.bulletWalls.map((wall, index) => index === 1
      ? { ...wall, minZ: north - 2.5, maxZ: north + 2.5 } : { ...wall }),
  };
}

/** Kept for source-compatible first-stage callers and deterministic fixtures. */
export function generateFirstMap(seed: number): TreeState[] { return createStageDefinition(0, 0, seed).trees; }
