import type { ImageSpec } from './ArtLibrary';
import type { MoneyNumberConfig } from './DamageNumbers';
import type { ParticleSpec } from './OriginalParticleSimulation';

export interface MineTransform { position: number[]; scale: number[]; rotation: number[]; source: string; }
export interface MineRenderer { image: ImageSpec; transform: MineTransform; color: number[]; order: number; }
export interface MineVisualConfig {
  version: number; worldOrigin: number[];
  ground: ImageSpec & { transform: MineTransform; tiling: [number, number]; clipRadius: number };
  oreSprites: ImageSpec[];
  ore: { root: MineTransform; plane: MineTransform; sprite: MineTransform; health: MineRenderer; healthFill: MineRenderer;
    hitBounce: { WantSize: { x: number; y: number; z: number }; _upSizeTime: number }; dustSpawn: MineTransform };
  dustParticles: ParticleSpec[]; dustCount: number; diamondNumbers: MoneyNumberConfig;
}
