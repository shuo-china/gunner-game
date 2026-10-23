import { ECONOMY_CONFIG } from '../core/EconomyConfig';
/** Shipped Skin_manager (level0:123519): fixed catalog, numbered 1..25 in UI. */
export const SKIN_COUNT = 25;
export interface SkinBonuses { damagePercent: number; speedPercent: number; moneyPercent: number; }
export interface SkinDefinition extends SkinBonuses { id: number; number: number; price: number; }
export const SKIN_CATALOG: readonly Readonly<SkinDefinition>[] = Object.freeze(Array.from({ length: SKIN_COUNT }, (_, id) =>
  Object.freeze({ id, number: id + 1, price: id * 100, damagePercent: id * 16, speedPercent: id * 10, moneyPercent: id * ECONOMY_CONFIG.gold.skinBonusPerIndex })));
export function isSkinId(id: unknown): id is number { return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < SKIN_COUNT; }
export function getSkin(id: number): Readonly<SkinDefinition> {
  if (!isSkinId(id)) throw new Error('Invalid skin id');
  return SKIN_CATALOG[id];
}
