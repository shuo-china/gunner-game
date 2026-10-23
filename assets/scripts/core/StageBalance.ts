import { DecimalAmount } from './DecimalAmount';
import { ECONOMY_CONFIG } from './EconomyConfig';

/** Tree_manager.Balance_Reload / GetStageHealth / GetStageMoney, original IL2CPP. */
export const PRECOMPUTED_STAGE_COUNT = 5000;
export const STAGE_HEALTH_MULTIPLIERS = [1, 1.8, 3, 35] as const;
export const STAGE_MONEY_MULTIPLIERS = ECONOMY_CONFIG.gold.degreeMultipliers;
/** Metadata A393C0... at 0x929E90: Tree_Grid.degreeRates, five rows of four floats. */
export const STAGE_DEGREE_RATES: readonly (readonly number[])[] = Object.freeze([
  Object.freeze([80, 20, 0, 0]), Object.freeze([50, 45, 5, 0]),
  Object.freeze([20, 55, 25, 0]), Object.freeze([5, 35, 60, 0]), Object.freeze([0, 15, 85, 0]),
]);

function table(first: number, growth = 3): DecimalAmount[] {
  const values = [DecimalAmount.from(first)];
  for (let i = 1; i < PRECOMPUTED_STAGE_COUNT; i++) values.push(values[i - 1].mul(growth).truncateSignificant(2));
  return values;
}
const health = table(250), money = table(ECONOMY_CONFIG.gold.firstStageBase, ECONOMY_CONFIG.gold.stageGrowth);
const healthCache = new Map<number, DecimalAmount>(), moneyCache = new Map<number, DecimalAmount>();

export function validateStage(stageIndex: number, waveIndex = 0): void {
  if (!Number.isSafeInteger(stageIndex) || stageIndex < 0) throw new Error('Stage index must be a nonnegative safe integer');
  if (!Number.isInteger(waveIndex) || waveIndex < 0 || waveIndex > 4) throw new Error('Wave index must be 0 through 4');
}

/** Native PowOfThree truncates both the accumulator and squared base each step. */
export function stagePowerOfThree(exponent: number): DecimalAmount {
  return stagePower(exponent, 3);
}
function stagePower(exponent: number, growth: number): DecimalAmount {
  if (!Number.isSafeInteger(exponent) || exponent < 0) throw new Error('Invalid stage exponent');
  let value = DecimalAmount.from(1), base = DecimalAmount.from(growth);
  while (exponent > 0) {
    if (exponent % 2 !== 0) value = value.mul(base).truncateSignificant(2);
    base = base.mul(base).truncateSignificant(2);
    exponent = Math.floor(exponent / 2);
  }
  return value;
}
function stageValue(stageIndex: number, values: DecimalAmount[], cache: Map<number, DecimalAmount>, growth = 3): DecimalAmount {
  validateStage(stageIndex);
  if (stageIndex < values.length) return values[stageIndex];
  let value = cache.get(stageIndex);
  if (!value) {
    const last = values.length - 1;
    value = values[last].mul(stagePower(stageIndex - last, growth)).truncateSignificant(2);
    cache.set(stageIndex, value);
  }
  return value;
}
export function getStageHealth(stageIndex: number): DecimalAmount { return stageValue(stageIndex, health, healthCache); }
export function getStageMoney(stageIndex: number): DecimalAmount { return stageValue(stageIndex, money, moneyCache, ECONOMY_CONFIG.gold.stageGrowth); }
/** Runtime uses serialized level0:124872 tables, whose first entries are
 * 25000e-2 and 20000e-3 (p5). Balance_Reload is an unused authoring helper;
 * normalized DecimalAmount values alone cannot recover those trailing zeroes. */
export function getStageHealthPrecision(stageIndex: number): number { validateStage(stageIndex); return stageIndex === 0 ? 5 : 2; }
export function getStageMoneyPrecision(stageIndex: number): number { validateStage(stageIndex); return stageIndex === 0 ? 5 : 2; }
export function getStageTreeCount(stageIndex: number): number {
  validateStage(stageIndex);
  return stageIndex >= 7 ? 100 : 30 + stageIndex * 10;
}
