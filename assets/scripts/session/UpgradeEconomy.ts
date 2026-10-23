import { DecimalAmount } from '../core/DecimalAmount';
import { OriginalInfVal } from '../core/OriginalInfVal';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
export const UPGRADE_TYPES = ['power', 'speed', 'money'] as const;
export type UpgradeType = typeof UPGRADE_TYPES[number];
export const MAX_UPGRADE_LEVEL = 10000;
export const UPGRADE_SOURCE = Object.freeze({
  version: 'Cat Gunner 1.1.61', priceGrowthG17: '1.3799999999999999', valueGrowthG17: '1.0800000000000001',
  latePriceLevel: 5000, holdDelay: 0.4, holdInterval: 0.1, minimumAttackInterval: 0.05, maximumAttackInterval: 2,
});
export interface UpgradeState { type: UpgradeType; level: number; value: DecimalAmount; price: DecimalAmount | null; affordable: boolean; progress: number; }
let prices: readonly DecimalAmount[] | undefined, values: readonly DecimalAmount[] | undefined, budget: DecimalAmount | undefined;
let moneyValues: readonly DecimalAmount[] | undefined;
function ensureTables(): void {
  if (prices && values) return;
  const priceTable: DecimalAmount[] = [], valueTable: DecimalAmount[] = [];
  const growth = DecimalAmount.from(UPGRADE_SOURCE.priceGrowthG17), valueGrowth = DecimalAmount.from(UPGRADE_SOURCE.valueGrowthG17);
  let accumulator = DecimalAmount.from(50), value = DecimalAmount.from(100);
  for (let level = 0; level <= MAX_UPGRADE_LEVEL; level++) {
    priceTable.push(accumulator.discardDecimal().truncateSignificant(3)); valueTable.push(value);
    // Actual Balance_Reload generation, not the different offline CalcPrice helper.
    accumulator = accumulator.mul(level < UPGRADE_SOURCE.latePriceLevel ? growth : 2).truncateSignificant(17).truncateSignificant(4);
    value = value.mul(valueGrowth).truncateSignificant(17).truncateSignificant(3);
  }
  prices = Object.freeze(priceTable); values = Object.freeze(valueTable);
}
export function isUpgradeType(type: unknown): type is UpgradeType { return UPGRADE_TYPES.includes(type as UpgradeType); }
export function isUpgradeLevel(level: unknown): level is number { return typeof level === 'number' && Number.isInteger(level) && level >= 0 && level <= MAX_UPGRADE_LEVEL; }
function validateLevel(level: number): void { if (!isUpgradeLevel(level)) throw new Error('Invalid upgrade level'); }
/** Price of purchasing level+1; max-level cards have no purchasable price. */
export function getUpgradePrice(level: number): DecimalAmount | null {
  validateLevel(level); if (level === MAX_UPGRADE_LEVEL) return null;
  ensureTables(); return prices![level];
}
export function getUpgradeValue(type: UpgradeType, level: number): DecimalAmount {
  validateLevel(level); if (!isUpgradeType(type)) throw new Error('Invalid upgrade type');
  if (type === 'speed') return DecimalAmount.from(100 + 8 * level);
  if (type === 'money') {
    if (!moneyValues) {
      const table: DecimalAmount[] = [], growth = DecimalAmount.from(ECONOMY_CONFIG.gold.upgradeGrowthG17);
      let value = DecimalAmount.from(ECONOMY_CONFIG.gold.upgradeBasePercent);
      for (let i = 0; i <= MAX_UPGRADE_LEVEL; i++) {
        table.push(value); value = value.mul(growth).truncateSignificant(17).truncateSignificant(3);
      }
      moneyValues = Object.freeze(table);
    }
    return moneyValues[level];
  }
  ensureTables(); return values![level];
}
/** The shipped level0:124056 Power/Money tables start at 10000e-2 (p5),
 * then use p3. Getter calls copy these entries without recomputing the table. */
export function getUpgradeMultiplier(type: 'power' | 'money', level: number): OriginalInfVal {
  return OriginalInfVal.fromAmount(getUpgradeValue(type, level), level === 0 ? 5 : 3);
}
/** Test funding only. The original game has no business limit on wallet balance. */
export function fullUpgradeBudget(): DecimalAmount {
  if (budget) return budget;
  ensureTables(); let total = DecimalAmount.from(0);
  for (let level = 0; level < MAX_UPGRADE_LEVEL; level++) total = total.add(prices![level]);
  budget = total.mul(3); return budget;
}
