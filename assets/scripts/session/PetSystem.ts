import { OriginalInfVal } from '../core/OriginalInfVal';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';

export const PET_COUNT = 10;
export const PET_DRAW_PRICE = ECONOMY_CONFIG.pets.drawPrice;
export const PET_BACKPACK_SIZE = 16;
export const PET_EQUIPMENT_SIZE = 3;
export type PetCurrency = 'diamonds' | 'petCoins';
export interface PetSlotRef { kind: 'owned' | 'selected'; index: number; }
export interface PetSave { owned: number[]; selected: number[]; collected: boolean[]; coins: number; autoEnabled: boolean; lastDailyAdDate: string; dailyAdCount: number; }
export interface PetActionResult { ok: boolean; reason?: string; changed?: boolean; discovered?: number; grade?: number; token?: string; }
export interface PetDefinition { id: number; grade: string; money: OriginalInfVal; moveSpeed: number; }
/** Pet_manager.Balance_Reload: double 3.1, ToPrecision(2), DiscardDecimal; ten playable rows. */
export const PET_CATALOG: readonly PetDefinition[] = (() => {
  let money = OriginalInfVal.fromInt(ECONOMY_CONFIG.gold.petFirstBonusPercent), speed = 2;
  return ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS', 'Z', 'ZZ', 'ZZZ'].map((grade, id) => {
    if (id) { money = money.mul(ECONOMY_CONFIG.gold.petGradeGrowth).toPrecision(2).discardDecimal(); speed += id * 2; }
    return Object.freeze({ id, grade, money, moveSpeed: speed });
  });
})();
export interface PetSnapshot extends PetSave {
  diamonds: number; gold: string; revision: number; moneyPercent: string; moveSpeedPercent: number; autoLimit: number;
  autoAvailable: boolean; autoPair: { from: number; to: number; grade: number } | null;
  dailyAdRemaining: number;
  ownedLocked: boolean[]; selectedLocked: boolean[];
}
export const isPetGrade = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < PET_COUNT;
const emptySave = (): PetSave => ({ owned: Array(16).fill(-1), selected: Array(3).fill(-1), collected: Array(10).fill(false), coins: ECONOMY_CONFIG.newGame.petCoins, autoEnabled: false, lastDailyAdDate: '', dailyAdCount: 0 });
function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Pure inventory. Session commits a candidate together with the shared diamond wallet. */
export class PetSystem {
  private data = emptySave();
  private revision = 0;
  // Derived from AdventureSave after every session restore/commit. Never serialized twice.
  private locks = new Set<string>();
  setLocks(refs: readonly PetSlotRef[]): void {
    const locks = new Set<string>();
    for (const ref of refs) {
      if (!this.array(ref) || this.gradeAt(ref) < 0) throw new Error('Invalid pet lock');
      locks.add(`${ref.kind}:${ref.index}`);
    }
    // Creator's loose array-spread transform treats a Set as one array item.
    // Compare membership directly so release builds enforce the same locks.
    if (locks.size !== this.locks.size || refs.some(ref => !this.locks.has(`${ref.kind}:${ref.index}`))) {
      this.locks = locks; this.revision++;
    }
  }
  isLocked(ref: PetSlotRef): boolean { return !!ref && this.locks.has(`${ref.kind}:${ref.index}`); }
  gradeAt(ref: PetSlotRef): number { const a = this.array(ref); return a ? a[ref.index] : -1; }
  get moneyMultiplier(): OriginalInfVal {
    let total = OriginalInfVal.fromInt(0);
    for (const grade of this.data.selected) if (grade >= 0) total = total.add(PET_CATALOG[grade].money);
    return total.add(100);
  }
  get moveSpeedPercent(): number { return this.data.selected.reduce((sum, grade) => sum + (grade < 0 ? 0 : PET_CATALOG[grade].moveSpeed), 100); }
  get autoLimit(): number { return Math.min(6, this.data.collected.lastIndexOf(true) - 1); }
  autoPair(): PetSnapshot['autoPair'] {
    if (!this.data.autoEnabled) return null;
    for (let grade = 0; grade <= this.autoLimit; grade++) {
      const matches = this.data.owned.map((value, index) => value === grade && !this.isLocked({ kind: 'owned', index }) ? index : -1).filter(index => index >= 0);
      const [first = -1, second = -1] = matches;
      if (first >= 0 && second >= 0) return { from: first, to: second, grade };
    }
    return null;
  }
  snapshot(diamonds: number, gold = '0', today = '', autoAvailable = true): PetSnapshot {
    return { ...this.serialize(), diamonds, gold, revision: this.revision, moneyPercent: this.moneyMultiplier.amount.format(),
      moveSpeedPercent: this.moveSpeedPercent, autoLimit: this.autoLimit, autoAvailable,
      autoPair: autoAvailable ? this.autoPair() : null, dailyAdRemaining: this.dailyAdRemaining(today),
      ownedLocked: this.data.owned.map((_, index) => this.isLocked({ kind: 'owned', index })),
      selectedLocked: this.data.selected.map((_, index) => this.isLocked({ kind: 'selected', index })) };
  }
  serialize(): PetSave { return { ...this.data, owned: [...this.data.owned], selected: [...this.data.selected], collected: [...this.data.collected] }; }
  restore(value: unknown): void {
    const d = value as PetSave;
    const validSlots = (a: unknown, size: number) => Array.isArray(a) && a.length === size && a.every(x => x === -1 || isPetGrade(x));
    if (!d || !validSlots(d.owned, 16) || !validSlots(d.selected, 3) || !Array.isArray(d.collected) || d.collected.length !== 10
      || d.collected.some(x => typeof x !== 'boolean') || !Number.isSafeInteger(d.coins) || d.coins < 0
      || typeof d.autoEnabled !== 'boolean' || typeof d.lastDailyAdDate !== 'string'
      || (d.lastDailyAdDate !== '' && !validDay(d.lastDailyAdDate))
      || !Number.isSafeInteger(d.dailyAdCount) || d.dailyAdCount < 0) throw new Error('Invalid pet save');
    this.data = { owned: [...d.owned], selected: [...d.selected], collected: [...d.collected], coins: d.coins, autoEnabled: d.autoEnabled,
      lastDailyAdDate: d.lastDailyAdDate, dailyAdCount: d.dailyAdCount };
    for (const grade of [...d.owned, ...d.selected]) if (grade >= 0) this.data.collected[grade] = true;
    this.revision++;
  }
  private array(ref: PetSlotRef): number[] | null {
    if (!ref || !['owned', 'selected'].includes(ref.kind) || !Number.isInteger(ref.index)) return null;
    const a = this.data[ref.kind]; return ref.index >= 0 && ref.index < a.length ? a : null;
  }
  private discover(grade: number): PetActionResult {
    const fresh = !this.data.collected[grade]; this.data.collected[grade] = true;
    this.revision++;
    return { ok: true, changed: true, grade, ...(fresh ? { discovered: grade } : {}) };
  }
  draw(currency: PetCurrency, diamonds: number): PetActionResult {
    if (currency !== 'diamonds' && currency !== 'petCoins') return { ok: false, reason: 'invalid' };
    const index = this.data.owned.indexOf(-1);
    if (index < 0) return { ok: false, reason: 'full' };
    if ((currency === 'petCoins' ? this.data.coins : diamonds) < PET_DRAW_PRICE) return { ok: false, reason: 'currency' };
    if (currency === 'petCoins') this.data.coins -= PET_DRAW_PRICE;
    this.data.owned[index] = ECONOMY_CONFIG.pets.drawGrade; return this.discover(ECONOMY_CONFIG.pets.drawGrade);
  }
  grantCoins(amount: number): PetActionResult {
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(this.data.coins + amount)) return { ok: false, reason: 'walletLimit' };
    this.data.coins += amount; if (amount) this.revision++; return { ok: true, changed: amount > 0 };
  }
  dailyAdRemaining(today: string): number {
    const used = validDay(today) && today > this.data.lastDailyAdDate ? 0 : this.data.dailyAdCount;
    return Math.max(0, ECONOMY_CONFIG.pets.dailyAd.dailyLimit - used);
  }
  claimDailyAd(today: string): PetActionResult {
    if (!validDay(today)) return { ok: false, reason: 'invalid' };
    const index = this.data.owned.indexOf(-1);
    if (index < 0) return { ok: false, reason: 'full' };
    if (!this.dailyAdRemaining(today)) return { ok: false, reason: 'dailyLimit' };
    const used = today > this.data.lastDailyAdDate ? 0 : this.data.dailyAdCount;
    this.data.lastDailyAdDate = today > this.data.lastDailyAdDate ? today : this.data.lastDailyAdDate;
    this.data.dailyAdCount = used + 1;
    this.data.owned[index] = ECONOMY_CONFIG.pets.dailyAd.grade;
    return this.discover(ECONOMY_CONFIG.pets.dailyAd.grade);
  }
  move(from: PetSlotRef, to: PetSlotRef, expected?: number, swapVacancy?: number): PetActionResult {
    const a = this.array(from), b = this.array(to);
    if (!a || !b) return { ok: false, reason: 'invalid' };
    if (this.isLocked(from) || this.isLocked(to) || (swapVacancy !== undefined && this.isLocked({ kind: 'owned', index: swapVacancy }))) return { ok: false, reason: 'locked' };
    if (a[from.index] < 0) return { ok: false, reason: 'empty' };
    if (expected !== undefined && a[from.index] !== expected) return { ok: false, reason: 'stale' };
    if (a === b && from.index === to.index) return { ok: true, changed: false };
    if (swapVacancy !== undefined) {
      if (from.kind !== 'owned' || to.kind !== 'owned' || !Number.isInteger(swapVacancy) || swapVacancy < 0 || swapVacancy >= 16
        || (swapVacancy !== from.index && a[swapVacancy] !== -1)) return { ok: false, reason: 'stale' };
      const moving = a[from.index], displaced = a[to.index];
      a[from.index] = -1; a[swapVacancy] = displaced; a[to.index] = moving;
    } else [a[from.index], b[to.index]] = [b[to.index], a[from.index]];
    this.revision++;
    return { ok: true, changed: true };
  }
  unequip(index: number): PetActionResult {
    if (this.isLocked({ kind: 'selected', index })) return { ok: false, reason: 'locked' };
    const to = this.data.owned.indexOf(-1);
    if (to < 0) return { ok: false, reason: 'full' };
    return this.move({ kind: 'selected', index }, { kind: 'owned', index: to });
  }
  merge(from: number, to: number, expected?: number, automatic = false): PetActionResult {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to || from < 0 || to < 0 || from >= 16 || to >= 16) return { ok: false, reason: 'invalid' };
    if (this.isLocked({ kind: 'owned', index: from }) || this.isLocked({ kind: 'owned', index: to })) return { ok: false, reason: 'locked' };
    const grade = this.data.owned[from];
    if (grade < 0 || this.data.owned[to] !== grade) return { ok: false, reason: 'grade' };
    if (expected !== undefined && expected !== grade) return { ok: false, reason: 'stale' };
    if (grade === PET_COUNT - 1) return { ok: false, reason: 'maxGrade' };
    if (automatic && (!this.data.autoEnabled || grade > this.autoLimit)) return { ok: false, reason: 'grade' };
    this.data.owned[from] = -1; this.data.owned[to] = grade + 1; return this.discover(grade + 1);
  }
  setAuto(enabled: boolean): PetActionResult {
    if (typeof enabled !== 'boolean') return { ok: false, reason: 'invalid' };
    const changed = this.data.autoEnabled !== enabled; this.data.autoEnabled = enabled; if (changed) this.revision++; return { ok: true, changed };
  }
}
