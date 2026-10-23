import { StageDefinition } from './map';
import { Random } from './math';
import { OriginalInfVal } from './OriginalInfVal';
import { getStageHealth, getStageHealthPrecision, getStageMoney, getStageMoneyPrecision, validateStage } from './StageBalance';
import { TreeState, Vec2 } from './types';

/** Serialized SpeedRun_manager level0:124629 / root Transform level0:39316.
 * Tree_Batch RVA 0x2baa234; Map_Batch.MoveNext RVA 0x2bab320 (Cat Gunner 1.1.61).
 * Constants below are native float32 values, not C# constructor defaults. */
export const SPEED_RUN_MAP = Object.freeze({
  originX: -100, originZ: 0, innerRadius: 22, outerRadius: 70,
  radialOffset: 3, tangentialOffset: 2, capacity: 190, poolIdBase: 1000000,
  /** Sprite512 / ppu50 * transformScale15 * shader UV radius.5. Visual only. */
  groundRadius: 76.8,
  pi: 3.1415927410125732, tau: 6.2831854820251465, degreesToRadians: 0.01745329238474369,
});

export function getSpeedRunTreeCount(stageIndex: number): number {
  validateStage(stageIndex);
  return Math.min(SPEED_RUN_MAP.capacity, 20 + 15 * stageIndex);
}

const f = Math.fround;
function roundToEven(value: number): number {
  const floor = Math.floor(value), fraction = value - floor;
  return fraction === .5 ? floor + floor % 2 : Math.round(value);
}

/** Equal-density concentric rings, source Mathf.RoundToInt and alternate-ring
 * half-step. All placement RNG is consumed before Map_Batch chooses degrees. */
function positions(count: number, random: Random): Vec2[] {
  const c = SPEED_RUN_MAP;
  const area = f(f(f(c.outerRadius * c.outerRadius) - f(c.innerRadius * c.innerRadius)) * c.pi);
  const ringCount = Math.max(1, roundToEven(f(f(c.outerRadius - c.innerRadius) / f(Math.sqrt(f(area / count))))));
  const radii = Array.from({ length: ringCount }, (_, ring) =>
    f(f(f(f(c.outerRadius - c.innerRadius) / ringCount) * f(ring + .5)) + c.innerRadius));
  const circumference = radii.reduce((sum, radius) => f(sum + f(radius * c.tau)), 0);
  const perRing = radii.map(radius => Math.max(1, roundToEven(f(f(f(radius * c.tau) / circumference) * count))));
  perRing[ringCount - 1] = Math.max(1, perRing[ringCount - 1] + count - perRing.reduce((sum, n) => sum + n, 0));
  const result: Vec2[] = [];
  for (let ring = 0; ring < ringCount; ring++) {
    const step = f(360 / perRing[ring]), offset = ring % 2 ? f(step * .5) : 0;
    for (let slot = 0; slot < perRing[ring] && result.length < count; slot++) {
      const angle = f(f(offset + f(step * slot)) * c.degreesToRadians);
      const sin = f(Math.sin(angle)), cos = f(Math.cos(angle));
      const radial = f(random.range(-c.radialOffset, c.radialOffset));
      const tangent = f(random.range(-c.tangentialOffset, c.tangentialOffset));
      const x = f(f(f(radii[ring] * cos) + f(cos * radial)) - f(sin * tangent));
      const z = f(f(f(radii[ring] * sin) + f(sin * radial)) + f(cos * tangent));
      result.push({ x: f(x + c.originX), z: f(z + c.originZ) });
    }
  }
  return result;
}

export function createSpeedRunDefinition(stageIndex: number, seed: number): StageDefinition {
  const count = getSpeedRunTreeCount(stageIndex), random = new Random(seed);
  const points = positions(count, random);
  const baseHealth = OriginalInfVal.fromAmount(getStageHealth(stageIndex), getStageHealthPrecision(stageIndex));
  const baseMoney = OriginalInfVal.fromAmount(getStageMoney(stageIndex), getStageMoneyPrecision(stageIndex));
  // Tree_manager's degree arrays hold int 1, double 1.8, int 3. InfVal promotes
  // only degree 1 to p17; preserve the money precision for session multipliers.
  const health = [1, 1.8, 3].map(multiplier => baseHealth.mul(multiplier));
  const money = [1, 1.8, 3].map(multiplier => baseMoney.mul(multiplier));
  const trees: TreeState[] = points.map((position, slot) => {
    const degree = Math.floor(random.next() * 3) as 0 | 1 | 2;
    // Source Coll Transform=(-2,0,2), BoxCollider=(5,6,5); Main uses a 6-wide box.
    const x = position.x - 2, z = position.z + 2;
    return { id: SPEED_RUN_MAP.poolIdBase + slot, position, degree, stageIndex,
      health: health[degree].amount, healthPrecision: health[degree].precision, maxHealth: health[degree].amount,
      reward: money[degree].amount, rewardPrecision: money[degree].precision,
      alive: true, collider: { minX: x - 2.5, maxX: x + 2.5, minZ: z - 2.5, maxZ: z + 2.5 },
      colliderMinY: 0, colliderMaxY: 6 };
  });
  // Map_obj contains only the shader-clipped circular ground and trees. Its
  // thin BoxCollider is a floor, not a side wall or radial movement clamp;
  // Main's north wall and corridor must never constrain the circular arena.
  return { stageIndex, waveIndex: 0, skinIndex: stageIndex % 10, trees,
    spawnPosition: { x: SPEED_RUN_MAP.originX, z: SPEED_RUN_MAP.originZ },
    mapOrigin: { x: SPEED_RUN_MAP.originX, z: SPEED_RUN_MAP.originZ }, mapLayout: 'arena',
    bounds: { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }, bulletWalls: [] };
}
