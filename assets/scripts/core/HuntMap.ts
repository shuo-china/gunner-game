import type { StageDefinition } from './map';
import type { HuntCombat } from './HuntCombat';
import { HUNT_CENTER } from './HuntCombat';
export const HUNT_MAP = Object.freeze({ originX: HUNT_CENTER.x, originZ: HUNT_CENTER.z, groundRadius: 76.8 });
export function createHuntDefinition(hunt: HuntCombat): StageDefinition {
  return { stageIndex: hunt.wave, waveIndex: hunt.level, skinIndex: hunt.wave % 10, trees: [], hunt,
    spawnPosition: { ...HUNT_CENTER }, mapOrigin: { ...HUNT_CENTER }, mapLayout: 'hunt',
    bounds: { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }, bulletWalls: [] };
}
