import type { StageDefinition } from './map';
import type { RaidBossCombat } from './RaidBossCombat';

export const RAID_MAP = Object.freeze({ originX: -100, originZ: 0, groundRadius: 76.8 });

/** Raid has its own non-tree target and the same open, shader-clipped ground
 * footprint as the ordinary challenge. The floor is not a radial side wall. */
export function createRaidDefinition(raidBoss: RaidBossCombat): StageDefinition {
  return { stageIndex: 0, waveIndex: 0, skinIndex: 0, trees: [], raidBoss,
    spawnPosition: { x: RAID_MAP.originX, z: RAID_MAP.originZ },
    mapOrigin: { x: RAID_MAP.originX, z: RAID_MAP.originZ }, mapLayout: 'raid',
    bounds: { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }, bulletWalls: [] };
}
