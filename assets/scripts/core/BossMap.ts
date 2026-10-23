import type { StageDefinition } from './map';
import type { BossCombat } from './BossCombat';
export const BOSS_MAP = Object.freeze({ originX: -100, originZ: 0, groundRadius: 76.8 });
export function createBossDefinition(boss: BossCombat): StageDefinition {
  return { stageIndex: boss.stageIndex, waveIndex: 0, skinIndex: boss.skinIndex, trees: [], boss,
    spawnPosition: { x: -100, z: 0 }, mapOrigin: { x: -100, z: 0 }, mapLayout: 'boss',
    bounds: { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }, bulletWalls: [] };
}
