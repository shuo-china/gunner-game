import { OriginalInfVal } from './OriginalInfVal';

/** Boss_manager.Health_Balance, level0:124699: 1,000 p2 values. The whole
 * authored table is independently checked against the extracted fixture.
 * Each multiplication keeps two significant digits. Its integer coefficient
 * has only 90 possible states, so record one cycle instead of caching levels. */
const healthCycle = (() => {
  const states: { coefficient: number; exponent: number }[] = [];
  const seen = new Map<number, number>();
  let coefficient = 50, exponent = 3;
  while (!seen.has(coefficient)) {
    seen.set(coefficient, states.length); states.push({ coefficient, exponent });
    coefficient *= 5;
    if (coefficient >= 100) { coefficient = Math.floor(coefficient / 10); exponent++; }
  }
  const start = seen.get(coefficient)!;
  return { states, start, length: states.length - start, exponentStep: exponent - states[start].exponent };
})();
export function bossHealth(stageIndex: number): OriginalInfVal {
  if (!Number.isSafeInteger(stageIndex) || stageIndex < 0) throw new Error('Invalid Boss stage');
  const offset = Math.max(0, stageIndex - healthCycle.start);
  const cycles = stageIndex < healthCycle.start ? 0 : Math.floor(offset / healthCycle.length);
  const index = stageIndex < healthCycle.start ? stageIndex : healthCycle.start + offset % healthCycle.length;
  const state = healthCycle.states[index], exponent = state.exponent + cycles * healthCycle.exponentStep;
  // Keep room for significant-digit exponent arithmetic in InfVal operations.
  if (!Number.isSafeInteger(exponent) || !Number.isSafeInteger(exponent + 2)) throw new Error('Unsupported Boss health exponent');
  return OriginalInfVal.fromSerialized({ digits: String(state.coefficient), exponent, precision: 2 });
}
export const BOSS_RULES = Object.freeze({ duration: 60, skinCount: 9,
  moveSpeed: 15, arrivalThreshold: .5, minWaitTime: 1, maxWaitTime: 3,
  catAvoidRadius: 4, maxPointRetries: 10, mapRadius: 60 });
