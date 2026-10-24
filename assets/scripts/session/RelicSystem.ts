import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { OriginalInfVal } from '../core/OriginalInfVal';
import { AdventureSystem, CoreType } from './AdventureSystem';

export interface RelicItemSave { level: number; count: number; unlocked: boolean; }
export interface RelicSave { version: 1; items: RelicItemSave[]; }
export interface RelicTotals {
  damage: OriginalInfVal; criticalDamage: OriginalInfVal; money: OriginalInfVal;
  moveSpeedPercent: number; offlineMinutes: number; rebirthPercent: number; skipPercent: number;
}
export interface RelicDrawItem { index: number; isNew: boolean; count: number; }
export interface RelicActionResult { ok: boolean; reason?: string; changed?: boolean; index?: number; drawn?: RelicDrawItem[]; spent?: number; }
export interface RelicItemSnapshot extends RelicItemSave {
  index: number; type: number; core: CoreType; displayLevel: number; maxLevel: number; displayMaxLevel: number;
  requiredCount: number; canUpgrade: boolean; name: string; description: string; value: string; nextValue: string;
}
export interface RelicSnapshot {
  items: RelicItemSnapshot[]; cores: number[]; drawPrice: number; drawMax: number[]; revision: number;
  damagePercent: string; criticalDamagePercent: string; moneyPercent: string;
  moveSpeedPercent: number; offlineMinutes: number; rebirthPercent: number; skipPercent: number;
}
export interface RelicDefinition { index: number; type: number; core: CoreType; name: string; }
const config = ECONOMY_CONFIG.relics;
const integer = (n: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): n is number => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;
const TYPE_NAMES = ['攻击力Ⅰ', '攻击力Ⅱ', '攻击力Ⅲ', '金币Ⅰ', '金币Ⅱ', '金币Ⅲ', '暴击伤害Ⅰ', '暴击伤害Ⅱ', '暴击伤害Ⅲ', '移动速度', '离线时间', '转生奖励', '跳关概率'];
export const RELIC_CATALOG: readonly RelicDefinition[] = Object.freeze(config.typesByCore.reduce<RelicDefinition[]>((all, types, core) => {
  for (const type of types) all.push(Object.freeze({ index: all.length, type, core: core as CoreType, name: TYPE_NAMES[type] }));
  return all;
}, []));
export const relicMaxLevel = (type: number): number => type <= 8 ? config.tableMaxLevel : config.specialMaxLevel;
export const relicUpgradePrice = (level: number): number => Math.max(config.upgradeBase, Math.min(config.upgradeMax, level * config.upgradePerLevel + config.upgradeBase));
const TABLES = [config.damageBalance, config.moneyBalance, config.criticalDamageBalance].map(table => table.map(raw => {
  const [digits, exponent] = raw.split(':');
  return OriginalInfVal.fromSerialized({ digits, exponent: Number(exponent), precision: digits.length });
}));
/** Exact original serialized InfVal tables; table row 299 is the last valid three-family level. */
export function relicValue(type: number, level: number): OriginalInfVal {
  if (!integer(type, 0, 12) || !integer(level, 0, relicMaxLevel(type))) throw new Error('Invalid relic value index');
  if (type <= 8) {
    const base = TABLES[Math.floor(type / 3)][level], tier = type % 3, multiplier = config.tierMultipliers[tier];
    if (tier === 0) return base.mul(multiplier);
    if (tier === 1) return base.mul(OriginalInfVal.fromDouble(multiplier)).discardDecimal();
    return base.mul(multiplier);
  }
  const amount = level + 1;
  return OriginalInfVal.fromInt(amount * (type === 9 ? config.moveSpeedPerLevel : type === 10 ? config.offlineMinutesPerLevel
    : type === 11 ? config.rebirthPercentPerLevel : config.skipPercentPerLevel));
}

/** Pure candidate collection. Session commits its save and the candidate Adventure core wallet together. */
export class RelicSystem {
  private data: RelicSave = { version: 1, items: RELIC_CATALOG.map(() => ({ level: 0, count: 0, unlocked: false })) };
  private revision = 0;
  serialize(): RelicSave { return { version: 1, items: this.data.items.map(item => ({ ...item })) }; }
  restore(value: unknown): void {
    const d = value as RelicSave;
    if (!d || d.version !== 1 || !Array.isArray(d.items) || d.items.length !== RELIC_CATALOG.length
      || d.items.some((item, i) => !item || !integer(item.level, 0, relicMaxLevel(RELIC_CATALOG[i].type)) || !integer(item.count)
        || typeof item.unlocked !== 'boolean' || (!item.unlocked && (item.level !== 0 || item.count !== 0)))) throw new Error('Invalid relic save');
    this.data = { version: 1, items: d.items.map(item => ({ ...item })) }; this.revision++;
  }
  get totals(): RelicTotals {
    let damage = OriginalInfVal.fromInt(0), criticalDamage = OriginalInfVal.fromInt(0), money = OriginalInfVal.fromInt(0);
    let moveSpeedPercent = 0, offlineMinutes = 0, rebirthPercent = 100, skipPercent = 0;
    this.data.items.forEach((item, index) => {
      if (!item.unlocked) return;
      const type = RELIC_CATALOG[index].type, value = relicValue(type, item.level);
      if (type <= 2) damage = damage.add(value);
      else if (type <= 5) money = money.add(value);
      else if (type <= 8) criticalDamage = criticalDamage.add(value);
      else {
        const numeric = Number(value.toString());
        if (type === 9) moveSpeedPercent += numeric;
        else if (type === 10) offlineMinutes += numeric;
        else if (type === 11) rebirthPercent += numeric;
        else skipPercent += numeric;
      }
    });
    return { damage: damage.add(100), criticalDamage: criticalDamage.add(100), money: money.add(100), moveSpeedPercent, offlineMinutes, rebirthPercent, skipPercent };
  }
  snapshot(cores: readonly number[] = [0, 0, 0, 0]): RelicSnapshot {
    const totals = this.totals;
    const items = this.data.items.map((item, index): RelicItemSnapshot => {
      const definition = RELIC_CATALOG[index], { type } = definition, maxLevel = relicMaxLevel(type), requiredCount = relicUpgradePrice(item.level);
      const value = relicValue(type, item.level).format(), nextValue = relicValue(type, Math.min(maxLevel, item.level + 1)).format();
      return { ...item, ...definition, displayLevel: item.level + 1, maxLevel, displayMaxLevel: maxLevel + 1, requiredCount,
        canUpgrade: item.unlocked && item.level < maxLevel && item.count >= requiredCount, value, nextValue,
        description: `${definition.name} +${value}${type === 10 ? '分钟' : '%'}` };
    });
    return { items, cores: [...cores], drawPrice: config.drawPrice, drawMax: cores.map(core => Math.floor(core / config.drawPrice)), revision: this.revision,
      damagePercent: totals.damage.format(), criticalDamagePercent: totals.criticalDamage.format(), moneyPercent: totals.money.format(),
      moveSpeedPercent: totals.moveSpeedPercent, offlineMinutes: totals.offlineMinutes, rebirthPercent: totals.rebirthPercent, skipPercent: totals.skipPercent };
  }
  draw(coreType: number, count: number, adventure: AdventureSystem, random: () => number = Math.random): RelicActionResult {
    if (!integer(coreType, 0, 3) || !integer(count, 1) || !integer(count * config.drawPrice)) return { ok: false, reason: 'invalid' };
    if (adventure.coreCount(coreType) < count * config.drawPrice) return { ok: false, reason: 'currency' };
    const candidates = RELIC_CATALOG.filter(item => coreType === 3 || item.core === coreType);
    const nonMax = candidates.filter(item => this.data.items[item.index].level < relicMaxLevel(item.type));
    const pool = nonMax.length ? nonMax : candidates;
    const items = this.data.items.map(item => ({ ...item })), drawn: RelicDrawItem[] = [];
    for (let n = 0; n < count; n++) {
      const roll = random();
      if (!Number.isFinite(roll) || roll < 0 || roll > 1) return { ok: false, reason: 'invalidRandom' };
      const index = pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))].index, item = items[index], isNew = !item.unlocked;
      if (isNew) item.unlocked = true;
      else {
        if (!integer(item.count + 1)) return { ok: false, reason: 'countLimit' };
        item.count++;
      }
      drawn.push({ index, isNew, count: item.count });
    }
    const spent = count * config.drawPrice, payment = adventure.spendCores(coreType, spent);
    if (!payment.ok) return payment;
    this.data.items = items; this.revision++; return { ok: true, changed: true, drawn, spent };
  }
  upgrade(index: number): RelicActionResult {
    if (!integer(index, 0, RELIC_CATALOG.length - 1)) return { ok: false, reason: 'invalid' };
    const item = this.data.items[index], definition = RELIC_CATALOG[index], price = relicUpgradePrice(item.level);
    if (!item.unlocked) return { ok: false, reason: 'locked' };
    if (item.level >= relicMaxLevel(definition.type)) return { ok: false, reason: 'maxLevel' };
    if (item.count < price) return { ok: false, reason: 'count' };
    item.count -= price; item.level++; this.revision++; return { ok: true, changed: true, index };
  }
}
