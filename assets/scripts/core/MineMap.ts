import { DecimalAmount } from './DecimalAmount';
import { ECONOMY_CONFIG } from './EconomyConfig';
import { MineRandom, minePerlinNoise } from './MineNoise';
import type { StageDefinition } from './map';
import type { OreState, Vec2 } from './types';

/** Scene Mine_manager 124788 and Ore box; placement coroutine RVA 0x2b4b158. */
export const MINE_MAP = Object.freeze({
  originX: -100, originZ: 0, outerRadius: 150, innerRadius: 24.299999237060547,
  noiseScale: .08500000089406967, noiseThreshold: .5170000195503235,
  gridSpacing: 4, capacity: 1000, perFrame: 30, poolIdBase: 4000000,
  colliderSize: 2.8299999237060547, normalHealth: 3, rareHealth: 5, groundRadius: 153.6,
});
export interface MinePlacementSnapshot {
  phase: 'sampling' | 'placing' | 'ready'; processedCandidates: number; placed: number; total: number; ready: boolean;
}
interface Candidate { position: Vec2; noise: number; }
const f = Math.fround;

/** One advance is one original coroutine resume, with real work before each
 * yield. Candidate budget counts ring cells, including below-threshold cells;
 * activation budget counts pool slots, including unused/deactivated slots. */
export class MinePlacement {
  readonly stage: StageDefinition;
  private readonly random: MineRandom;
  private readonly candidates: Candidate[] = [];
  private readonly rare = new Set<number>();
  private phase: MinePlacementSnapshot['phase'] = 'sampling';
  private processed = 0;
  private poolCursor = 0;
  private total = 0;
  private readonly extent = Math.floor(f(MINE_MAP.outerRadius * .25));
  private x = -this.extent;
  private z = -this.extent;
  private readonly offsetX: number;
  private readonly offsetZ: number;
  constructor(seed: number, private readonly rareCount = ECONOMY_CONFIG.mine.rareOreCount) {
    if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(rareCount) || rareCount < 0) throw new Error('Invalid mine placement');
    this.random = new MineRandom(seed);
    // Native double constant at libil2cpp 0x1070a08 is exactly 9999.
    this.offsetX = f(this.random.next() * 9999); this.offsetZ = f(this.random.next() * 9999);
    this.stage = { stageIndex: 0, waveIndex: 0, skinIndex: 0, trees: [], ores: [],
      mapLayout: 'mine', mapOrigin: { x: MINE_MAP.originX, z: MINE_MAP.originZ },
      spawnPosition: { x: MINE_MAP.originX, z: MINE_MAP.originZ },
      bounds: { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }, bulletWalls: [] };
  }
  get ready(): boolean { return this.phase === 'ready'; }
  snapshot(): MinePlacementSnapshot { return { phase: this.phase, processedCandidates: this.processed, placed: this.stage.ores!.length, total: this.total, ready: this.ready }; }
  advanceFrame(): MinePlacementSnapshot {
    if (this.phase === 'sampling') {
      while (this.x <= this.extent) {
        const x = f(MINE_MAP.originX + this.x * MINE_MAP.gridSpacing), z = f(MINE_MAP.originZ + this.z * MINE_MAP.gridSpacing);
        if (++this.z > this.extent) { this.z = -this.extent; this.x++; }
        const dx = f(x - MINE_MAP.originX), dz = f(z - MINE_MAP.originZ), radius2 = f(f(dx * dx) + f(dz * dz));
        if (radius2 < f(MINE_MAP.innerRadius * MINE_MAP.innerRadius) || radius2 > f(MINE_MAP.outerRadius * MINE_MAP.outerRadius)) continue;
        const noise = minePerlinNoise(f(f(x + this.offsetX) * MINE_MAP.noiseScale), f(f(z + this.offsetZ) * MINE_MAP.noiseScale));
        if (noise >= MINE_MAP.noiseThreshold) this.candidates.push({ position: { x, z }, noise });
        if (++this.processed % MINE_MAP.perFrame === 0) return this.snapshot();
      }
      // The source lambda is b.noise.CompareTo(a.noise), highest density first.
      this.candidates.sort((a, b) => b.noise - a.noise);
      this.total = Math.min(MINE_MAP.capacity, this.candidates.length);
      const indices = Array.from({ length: this.total }, (_, i) => i);
      for (let i = 0; i < Math.min(this.total, this.rareCount); i++) {
        const next = this.random.range(i, this.total);
        [indices[i], indices[next]] = [indices[next], indices[i]]; this.rare.add(indices[i]);
      }
      this.phase = 'placing';
    }
    if (this.phase === 'placing') {
      while (this.poolCursor < MINE_MAP.capacity) {
        const index = this.poolCursor++;
        if (index < this.total) this.stage.ores!.push(createMineOre(index, this.candidates[index].position, this.rare.has(index)));
        if (this.poolCursor % MINE_MAP.perFrame === 0) return this.snapshot();
      }
      this.phase = 'ready';
    }
    return this.snapshot();
  }
}
export function createMineOre(poolIndex: number, position: Vec2, rare = false): OreState {
  const health = DecimalAmount.from(rare ? MINE_MAP.rareHealth : MINE_MAP.normalHealth), half = MINE_MAP.colliderSize / 2;
  return { id: MINE_MAP.poolIdBase + poolIndex, kind: 'ore', poolIndex, rare, position: { ...position },
    score: rare ? ECONOMY_CONFIG.mine.rareScore : ECONOMY_CONFIG.mine.normalScore,
    health, maxHealth: health, healthPrecision: 1, alive: true,
    collider: { minX: f(position.x - half), maxX: f(position.x + half), minZ: f(position.z - half), maxZ: f(position.z + half) },
    colliderMinY: 0, colliderMaxY: 4 };
}
/** Headless convenience. Interactive entry must advance MinePlacement per frame. */
export function createMineDefinition(seed: number, rareCount = ECONOMY_CONFIG.mine.rareOreCount): StageDefinition {
  const placement = new MinePlacement(seed, rareCount);
  while (!placement.ready) placement.advanceFrame();
  return placement.stage;
}
