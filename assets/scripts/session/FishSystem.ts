import { ECONOMY_CONFIG } from '../core/EconomyConfig';

export const FISH_COUNT = 13;
export const FISH_CAPACITY = 20;
export const FISH_DRAW_PRICE = ECONOMY_CONFIG.fish.drawPrice;
export type FishDrawKind = 'free' | 'diamonds';
export interface FishSave {
  inventory: number[]; collected: boolean[]; autoEnabled: boolean; freeDrawDate: string; freeDrawCount: number;
}
export interface FishBonuses {
  damagePercent: number; criticalChancePercent: number; criticalDamagePercent: number;
}
export interface FishDefinition extends FishBonuses { id: number; grade: string; name: string; }
export interface FishActionResult {
  ok: boolean;
  reason?: string;
  changed?: boolean; discovered?: number; grade?: number; index?: number; token?: string;
}
export interface FishSnapshot extends FishSave, FishBonuses {
  diamonds: number; revision: number; capacity: number; drawPrice: number;
  freeDrawRemaining: number; freeWithoutAdRemaining: number; freeDrawNeedsAd: boolean;
  autoAvailable: boolean; autoPair: { from: number; to: number; grade: number } | null;
}

/** Mathf.Pow returns float; native RoundToSignificant uses Math.Round (ties to even) twice. */
function roundEven(value: number): number {
  const floor = Math.floor(value), fraction = value - floor;
  return fraction < .5 ? floor : fraction > .5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
}
function roundSignificant(value: number): number {
  if (value === 0) return 0;
  const scale = Math.pow(10, 2 - Math.trunc(Math.log10(Math.abs(value))) - 1);
  return roundEven(roundEven(value * scale) / scale);
}

/** Fish_manager.Balance_Reload: 13 playable grades. These are additional percentages. */
export const FISH_CATALOG: readonly FishDefinition[] = Object.freeze(['D', 'C', 'B', 'A', 'S', 'SS', 'SSS', 'X', 'XX', 'XXX', 'Z', 'ZZ', 'ZZZ'].map((grade, id) => Object.freeze({
  id, grade, name: `${grade}级鱼`,
  damagePercent: roundSignificant(Math.fround(Math.fround(Math.pow(3, id)) * 4)),
  criticalChancePercent: Math.max(0, Math.min(100, roundSignificant(Math.fround(Math.pow(2.5, id))))),
  criticalDamagePercent: roundSignificant(Math.fround(Math.fround(Math.pow(2.5, id)) * 8)),
})));

export const isFishGrade = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < FISH_COUNT;
const emptySave = (): FishSave => ({ inventory: [], collected: Array(FISH_COUNT).fill(false), autoEnabled: false, freeDrawDate: '', freeDrawCount: 0 });
function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Pure compact inventory. BattleSession durably commits it together with the diamond wallet. */
export class FishSystem {
  private data = emptySave();
  private revision = 0;

  /** All fish in the tank contribute, including duplicate grades. No equipment slots. */
  get totals(): FishBonuses {
    return this.data.inventory.reduce((total, grade) => {
      const fish = FISH_CATALOG[grade];
      total.damagePercent += fish.damagePercent; total.criticalChancePercent += fish.criticalChancePercent;
      total.criticalDamagePercent += fish.criticalDamagePercent; return total;
    }, { damagePercent: 0, criticalChancePercent: 0, criticalDamagePercent: 0 });
  }
  serialize(): FishSave { return { ...this.data, inventory: [...this.data.inventory], collected: [...this.data.collected] }; }
  restore(value: unknown): void {
    if (value === undefined) return;
    const d = value as FishSave;
    if (!d || !Array.isArray(d.inventory) || d.inventory.length > FISH_CAPACITY || d.inventory.some(v => !isFishGrade(v))
      || !Array.isArray(d.collected) || d.collected.length !== FISH_COUNT || d.collected.some(v => typeof v !== 'boolean')
      || typeof d.autoEnabled !== 'boolean' || typeof d.freeDrawDate !== 'string' || (d.freeDrawDate !== '' && !isDate(d.freeDrawDate))
      || !Number.isSafeInteger(d.freeDrawCount) || d.freeDrawCount < 0) throw new Error('Invalid fish save');
    this.data = { inventory: [...d.inventory], collected: [...d.collected], autoEnabled: d.autoEnabled,
      freeDrawDate: d.freeDrawDate, freeDrawCount: d.freeDrawCount };
    for (const grade of d.inventory) this.data.collected[grade] = true;
    this.revision++;
  }
  private dailyUsed(today: string): number {
    // Clock rollback cannot refresh a claimed day; preserve counts when a configured limit decreases.
    return isDate(today) && today > this.data.freeDrawDate ? 0 : this.data.freeDrawCount;
  }
  snapshot(diamonds: number, today: string, autoAvailable = true): FishSnapshot {
    const freeDrawCount = this.dailyUsed(today), totals = this.totals;
    return { ...this.serialize(), ...totals, diamonds, revision: this.revision, capacity: FISH_CAPACITY, drawPrice: FISH_DRAW_PRICE,
      freeDrawCount, criticalChancePercent: Math.min(100, totals.criticalChancePercent), criticalDamagePercent: 125 + totals.criticalDamagePercent,
      freeDrawRemaining: Math.max(0, ECONOMY_CONFIG.fish.freeDrawsPerDay - freeDrawCount),
      freeWithoutAdRemaining: Math.max(0, ECONOMY_CONFIG.fish.noAdDrawsPerDay - freeDrawCount),
      freeDrawNeedsAd: freeDrawCount >= ECONOMY_CONFIG.fish.noAdDrawsPerDay && freeDrawCount < ECONOMY_CONFIG.fish.freeDrawsPerDay,
      autoAvailable, autoPair: this.autoPair(autoAvailable) };
  }
  autoPair(available = true): FishSnapshot['autoPair'] {
    if (!available || !this.data.autoEnabled) return null;
    // Domain fallback for a freshly populated pool. The HUD retains its fixed visual
    // pool order after removals/reuse: first matching fish is target, second is mover.
    for (let grade = 0; grade < FISH_COUNT - 1; grade++) {
      const first = this.data.inventory.indexOf(grade), second = this.data.inventory.indexOf(grade, first + 1);
      if (first >= 0 && second >= 0) return { from: second, to: first, grade };
    }
    return null;
  }
  private append(grade: number): FishActionResult {
    const discovered = !this.data.collected[grade];
    this.data.inventory.push(grade); this.data.collected[grade] = true; this.revision++;
    return { ok: true, changed: true, grade, index: this.data.inventory.length - 1, ...(discovered ? { discovered: grade } : {}) };
  }
  draw(kind: FishDrawKind, diamonds: number, today: string, random: () => number = Math.random, adRewarded = false): FishActionResult {
    if ((kind !== 'free' && kind !== 'diamonds') || !isDate(today)) return { ok: false, reason: 'invalid' };
    if (this.data.inventory.length >= FISH_CAPACITY) return { ok: false, reason: 'full' };
    if (kind === 'diamonds' && (!Number.isSafeInteger(diamonds) || diamonds < FISH_DRAW_PRICE)) return { ok: false, reason: 'currency' };
    const count = this.dailyUsed(today);
    if (kind === 'free') {
      if (count >= ECONOMY_CONFIG.fish.freeDrawsPerDay) return { ok: false, reason: 'dailyLimit' };
      if (count >= ECONOMY_CONFIG.fish.noAdDrawsPerDay && !adRewarded) return { ok: false, reason: 'adRequired' };
    }
    const roll = random();
    if (!Number.isFinite(roll) || roll < 0 || roll > 1) return { ok: false, reason: 'invalid' };
    const base = kind === 'free' ? ECONOMY_CONFIG.fish.freeBaseGrade : ECONOMY_CONFIG.fish.premiumBaseGrade;
    let grade = base, cumulative = 0;
    for (let i = 0; i < ECONOMY_CONFIG.fish.drawGradePercents.length; i++) {
      cumulative += ECONOMY_CONFIG.fish.drawGradePercents[i];
      if (Math.fround(roll * 100) < cumulative) { grade = base + i; break; }
    }
    // Like the native float Range(0,100), its inclusive endpoint falls back to the base grade.
    if (kind === 'free') { this.data.freeDrawDate = today > this.data.freeDrawDate ? today : this.data.freeDrawDate; this.data.freeDrawCount = count + 1; }
    return this.append(grade);
  }
  merge(from: number, to: number, expectedGrade?: number, automatic = false, expectedRevision?: number): FishActionResult {
    if (expectedRevision !== undefined && expectedRevision !== this.revision) return { ok: false, reason: 'stale' };
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to || from < 0 || to < 0
      || from >= this.data.inventory.length || to >= this.data.inventory.length) return { ok: false, reason: 'invalid' };
    const grade = this.data.inventory[from];
    if (expectedGrade !== undefined && expectedGrade !== grade) return { ok: false, reason: 'stale' };
    if (this.data.inventory[to] !== grade) return { ok: false, reason: 'grade' };
    if (grade === FISH_COUNT - 1) return { ok: false, reason: 'maxGrade' };
    if (automatic && !this.data.autoEnabled) return { ok: false, reason: 'grade' };
    this.data.inventory.splice(Math.max(from, to), 1); this.data.inventory.splice(Math.min(from, to), 1);
    return this.append(grade + 1);
  }
  remove(index: number, expectedGrade?: number, expectedRevision?: number): FishActionResult {
    if (expectedRevision !== undefined && expectedRevision !== this.revision) return { ok: false, reason: 'stale' };
    if (!Number.isInteger(index) || index < 0 || index >= this.data.inventory.length) return { ok: false, reason: 'invalid' };
    if (expectedGrade !== undefined && this.data.inventory[index] !== expectedGrade) return { ok: false, reason: 'stale' };
    const grade = this.data.inventory[index]; this.data.inventory.splice(index, 1); this.revision++;
    return { ok: true, changed: true, grade, index };
  }
  setAuto(enabled: boolean): FishActionResult {
    if (typeof enabled !== 'boolean') return { ok: false, reason: 'invalid' };
    const changed = this.data.autoEnabled !== enabled; this.data.autoEnabled = enabled;
    if (changed) this.revision++; return { ok: true, changed };
  }
}
