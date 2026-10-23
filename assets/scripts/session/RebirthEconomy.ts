import { OriginalInfVal } from '../core/OriginalInfVal';
import { DecimalAmount } from '../core/DecimalAmount';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';

export const REBIRTH_UPGRADE_TYPES = ['power', 'speed', 'money'] as const;
export type RebirthUpgradeType = typeof REBIRTH_UPGRADE_TYPES[number];
export const MAX_REBIRTH_UPGRADE_LEVEL = 20000;
const hundred = OriginalInfVal.fromInt(100);
const growth = OriginalInfVal.fromDouble(1.05);
const latePriceGrowth = OriginalInfVal.fromDouble(1.002);
const prices: OriginalInfVal[] = [];
const bonuses = new Map<number, OriginalInfVal>();
const moneyBonuses = new Map<number, OriginalInfVal>();
let latePriceFactor = OriginalInfVal.fromInt(1);
let remainingBudgets: readonly DecimalAmount[] | undefined;

export function isRebirthLevel(level: unknown): level is number {
  return typeof level === 'number' && Number.isInteger(level) && level >= 0 && level <= MAX_REBIRTH_UPGRADE_LEVEL;
}
function validateLevel(level: number): void { if (!isRebirthLevel(level)) throw new Error('Invalid rebirth upgrade level'); }
function validateType(type: RebirthUpgradeType): void { if (!REBIRTH_UPGRADE_TYPES.includes(type)) throw new Error('Invalid rebirth upgrade type'); }

/** Rebirth_manager.Rebirth_Reward_return: square at integer precision BEFORE multiplying sqrt. */
export function getRebirthReward(position: { stageIndex: number; waveIndex: number }, rewardPercent = ECONOMY_CONFIG.rebirth.defaultRewardPercent, enhanced = false): OriginalInfVal {
  if (!Number.isSafeInteger(position.stageIndex) || position.stageIndex < 0 || !Number.isInteger(position.waveIndex) || position.waveIndex < 0 || position.waveIndex > 4 ||
    !Number.isSafeInteger(rewardPercent) || rewardPercent < 0) throw new Error('Invalid rebirth reward input');
  if (position.stageIndex + 1 < ECONOMY_CONFIG.rebirth.minimumStage) return OriginalInfVal.fromInt(0);
  const progress = position.stageIndex * 5 + position.waveIndex;
  if (!Number.isSafeInteger(progress)) throw new Error('Invalid rebirth progress');
  const reward = OriginalInfVal.fromInt(progress).pow(ECONOMY_CONFIG.rebirth.progressPower).mul(OriginalInfVal.fromDouble(Math.sqrt(progress)))
    .mul(OriginalInfVal.fromInt(rewardPercent)).div(hundred).toPrecision(5).toPrecision(5);
  return enhanced ? reward.mul(ECONOMY_CONFIG.rebirth.adTotalMultiplier) : reward;
}

/** Purchase cost for level+1; level 20000 has no next purchase. */
export function getRebirthPrice(level: number): OriginalInfVal | null {
  validateLevel(level); if (level === MAX_REBIRTH_UPGRADE_LEVEL) return null;
  for (let index = prices.length; index <= level; index++) {
    let price = OriginalInfVal.fromDouble(Math.pow(index + 1, 1.6) * 3);
    if (index > 15000) {
      latePriceFactor = latePriceFactor.mul(latePriceGrowth).toPrecision(4);
      price = price.mul(latePriceFactor);
    }
    prices.push(price.discardDecimal().toPrecision(3));
  }
  return prices[level];
}

/** Exact remaining purchase cost; test wallets must not lose precision by summing InfVal prices. */
export function remainingRebirthUpgradeBudget(levels: readonly number[]): DecimalAmount {
  if (levels.length !== REBIRTH_UPGRADE_TYPES.length || !levels.every(isRebirthLevel)) throw new Error('Invalid rebirth levels');
  if (!remainingBudgets) {
    const amounts: DecimalAmount[] = new Array(MAX_REBIRTH_UPGRADE_LEVEL + 1);
    amounts[MAX_REBIRTH_UPGRADE_LEVEL] = DecimalAmount.from(0);
    for (let next = MAX_REBIRTH_UPGRADE_LEVEL - 1; next >= 0; next--) amounts[next] = amounts[next + 1].add(getRebirthPrice(next)!.amount);
    remainingBudgets = Object.freeze(amounts);
  }
  return levels.reduce((total, level) => total.add(remainingBudgets![level]), DecimalAmount.from(0));
}

/** The bonus printed on the original card, excluding the base 100%. */
export function getRebirthBonus(type: RebirthUpgradeType, level: number): OriginalInfVal {
  validateLevel(level); validateType(type);
  // Shipped level0:124798 uses p5 for every speed entry, including 0e-4.
  // Balance_Reload's integer constructor is an unused authoring alternative.
  if (type === 'speed') return OriginalInfVal.fromInt(5 * level).toPrecision(5);
  const cache = type === 'money' ? moneyBonuses : bonuses;
  let value = cache.get(level);
  if (!value) {
    const factor = type === 'money' ? OriginalInfVal.fromDouble(ECONOMY_CONFIG.gold.rebirthUpgradeGrowth) : growth;
    value = factor.pow(level).mul(hundred).sub(hundred).discardDecimal().toPrecision(3);
    cache.set(level, value);
  }
  return value;
}
/** Manager getters add 100 using InfVal addition, retaining the original precision cut. */
export function getRebirthPercent(type: RebirthUpgradeType, level: number): OriginalInfVal {
  return getRebirthBonus(type, level).add(hundred);
}
