import { OriginalInfVal } from './OriginalInfVal';

/** Monster_manager's authored combat values (level0). Rewards belong to EconomyConfig. */
export const HUNT_RULES = Object.freeze({
  poolSize: 240, levelsPerWave: 5, skinCount: 10,
  targetCounts: Object.freeze([90, 120, 160, 200, 240]),
  spawnIntervals: Object.freeze([.35, .2, .17, .12, .08]),
  sparseSpawnInterval: .04, sparseAliveThreshold: 3, completionPollInterval: .1,
  largeProbabilityStep: .2, largeHealthMultiplier: 3, largeVisualScale: 1.5,
  barrierHp: 1, barrierRadius: 15, barrierCenterY: 0,
  monsterRadius: 2.1, monsterHeight: 10, monsterCenterY: 5.05,
  catRadius: 14, catArrivalThreshold: 1, attackRange: 60, rayCount: 60, cameraHalfHeight: 45,
  spawnRadius: 60, spawnMinimumAxis: 30, spawnJitter: 5,
  normalTravelDivisor: 37.5, largeTravelDivisor: 50, speedReferenceRadius: 20, minimumSpeedDistance: .1,
  knockbackSpeed: 20, knockbackMinimumDuration: .05, knockbackDurationScale: .3,
});

// Wave 0 is the serialized 500 (p3). Thereafter each table entry multiplies
// the previous one by three and truncates to p2. The two-digit coefficients
// repeat, allowing restored progress beyond the 2,000 authored entries.
const healthCycle = (() => {
  const states: { coefficient: number; exponent: number }[] = [], seen = new Map<number, number>();
  let coefficient = 15, exponent = 2;
  while (!seen.has(coefficient)) {
    seen.set(coefficient, states.length); states.push({ coefficient, exponent });
    coefficient *= 3;
    if (coefficient >= 100) { coefficient = Math.floor(coefficient / 10); exponent++; }
  }
  const start = seen.get(coefficient)!;
  return { states, start, length: states.length - start, exponentStep: exponent - states[start].exponent };
})();

export function huntHealth(wave: number, large = false): OriginalInfVal {
  if (!Number.isSafeInteger(wave) || wave < 0) throw new Error('Invalid Hunt wave');
  let health: OriginalInfVal;
  if (wave === 0) health = OriginalInfVal.fromInt(500);
  else {
    const step = wave - 1, offset = Math.max(0, step - healthCycle.start);
    const cycles = step < healthCycle.start ? 0 : Math.floor(offset / healthCycle.length);
    const index = step < healthCycle.start ? step : healthCycle.start + offset % healthCycle.length;
    const state = healthCycle.states[index], exponent = state.exponent + cycles * healthCycle.exponentStep;
    if (!Number.isSafeInteger(exponent) || !Number.isSafeInteger(exponent + 3)) throw new Error('Unsupported Hunt health exponent');
    health = OriginalInfVal.fromSerialized({ digits: String(state.coefficient), exponent, precision: 2 });
  }
  return large ? health.mul(HUNT_RULES.largeHealthMultiplier).toPrecision(2) : health;
}

export function validateHuntLevel(wave: number, level: number): void {
  huntHealth(wave);
  if (!Number.isInteger(level) || level < 0 || level >= HUNT_RULES.levelsPerWave) throw new Error('Invalid Hunt level');
}
