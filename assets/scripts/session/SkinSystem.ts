import { getSkin, isSkinId, SKIN_CATALOG, SKIN_COUNT } from './SkinCatalog';
import type { SkinBonuses, SkinDefinition } from './SkinCatalog';

export interface SkinSave { owned: boolean[]; selectedId: number; }
export interface SkinItemSnapshot extends SkinDefinition { owned: boolean; equipped: boolean; affordable: boolean; }
export interface SkinSnapshot {
  selectedId: number; diamonds: number; owned: readonly boolean[]; items: readonly SkinItemSnapshot[];
  /** Holding bonuses, excluding the base 100 percent. Equipment is cosmetic. */
  totals: SkinBonuses; revision: number;
}
export interface SkinActionResult {
  ok: boolean; reason?: 'invalid' | 'owned' | 'locked' | 'contentLocked' | 'diamonds' | 'busy' | 'mode'; skinId?: number; changed?: boolean;
}

/** Owns ownership and global cosmetic selection; BattleSession commits the wallet atomically. */
export class SkinSystem {
  private owned = Array.from({ length: SKIN_COUNT }, (_, id) => id === 0);
  private selectedId = 0;
  private revision = 0;
  get totals(): SkinBonuses {
    const totals = { damagePercent: 0, speedPercent: 0, moneyPercent: 0 };
    SKIN_CATALOG.forEach(skin => {
      if (!this.owned[skin.id]) return;
      totals.damagePercent += skin.damagePercent; totals.speedPercent += skin.speedPercent; totals.moneyPercent += skin.moneyPercent;
    });
    return totals;
  }
  purchase(id: number, diamonds: number, spend: (amount: number) => boolean): SkinActionResult {
    if (!isSkinId(id)) return { ok: false, reason: 'invalid' };
    if (this.owned[id]) return { ok: false, reason: 'owned' };
    const price = getSkin(id).price;
    if (diamonds < price || !spend(price)) return { ok: false, reason: 'diamonds' };
    this.owned[id] = true; this.revision++;
    return { ok: true, skinId: id, changed: true };
  }
  equip(id: number): SkinActionResult {
    if (!isSkinId(id)) return { ok: false, reason: 'invalid' };
    if (!this.owned[id]) return { ok: false, reason: 'locked' };
    const changed = this.selectedId !== id;
    this.selectedId = id;
    if (changed) this.revision++;
    return { ok: true, skinId: id, changed };
  }
  snapshot(diamonds: number): SkinSnapshot {
    return { selectedId: this.selectedId, diamonds, owned: [...this.owned], totals: this.totals, revision: this.revision,
      items: SKIN_CATALOG.map(skin => ({ ...skin, owned: this.owned[skin.id], equipped: skin.id === this.selectedId, affordable: diamonds >= skin.price })) };
  }
  serialize(): SkinSave { return { owned: [...this.owned], selectedId: this.selectedId }; }
  restore(value: unknown): void {
    const data = value as Partial<SkinSave> | null;
    if (!data || !Array.isArray(data.owned) || data.owned.length !== SKIN_COUNT || data.owned.some(v => typeof v !== 'boolean')
      || data.owned[0] !== true || !isSkinId(data.selectedId) || !data.owned[data.selectedId]) throw new Error('Invalid skin save');
    this.owned = [...data.owned]; this.selectedId = data.selectedId; this.revision++;
  }
}
