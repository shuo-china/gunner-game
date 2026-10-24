import { DecimalAmount } from '../core/DecimalAmount';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { OriginalInfVal } from '../core/OriginalInfVal';
import { getRebirthBonus, getRebirthPrice, getRebirthReward, isRebirthLevel, remainingRebirthUpgradeBudget } from './RebirthEconomy';
import { ContentUnlockManager } from './ContentUnlockManager';
import { UPGRADE_TYPES, isUpgradeType } from './UpgradeEconomy';
import type { UpgradeType } from './UpgradeEconomy';
import type { StagePosition } from './StageProgression';

export type RebirthKind = 'normal' | 'ad';
export type RebirthAdOutcome = import('./RewardedAds').RewardedAdOutcome;
export type RebirthPhase = 'idle' | 'adPending' | 'animating';
export interface RebirthActionResult { ok: boolean; reason?: string; token?: string; }
export interface RebirthSnapshot {
  ruby: DecimalAmount; count: number;
  upgrades: readonly { type: UpgradeType; level: number; value: DecimalAmount; price: DecimalAmount | null; affordable: boolean }[];
  reward: DecimalAmount; enhancedReward: DecimalAmount;
  unlocked: boolean; canRebirth: boolean; adAvailable: boolean; adEnabled: boolean;
  unlockMessage: string; actionMessage: string;
  phase: RebirthPhase; animationElapsed: number;
}
export interface RebirthTestConfiguration { ruby?: string; levels?: readonly number[]; count?: number; adUsedDate?: string; }
interface RebirthData { ruby: OriginalInfVal; levels: number[]; count: number; adUsedDate: string; adUsedCount: number; }
export interface RebirthCompletion { readonly ruby: OriginalInfVal; readonly count: number; readonly adUsedDate: string; readonly adUsedCount: number; }
export const REBIRTH_ANIMATION_SECONDS = 2;
let instanceSerial = 0;
function validDate(value: unknown): value is string { return typeof value === 'string' && /^(?:|\d{4}-\d{2}-\d{2})$/.test(value); }
function today(clock: () => number): string {
  const date = new Date(clock());
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid rebirth clock');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Pure original rebirth economy/lifecycle. The session owns the reset transaction;
 * this module never touches weapons, the battle, storage, or presentation. */
export class RebirthSystem {
  private data: RebirthData = { ruby: OriginalInfVal.fromAmount(DecimalAmount.from(ECONOMY_CONFIG.newGame.ruby)), levels: [0, 0, 0], count: 0, adUsedDate: '', adUsedCount: 0 };
  private phaseValue: RebirthPhase = 'idle';
  private elapsed = 0;
  private kind: RebirthKind = 'normal';
  private pendingToken: string | null = null;
  private readonly instanceId = ++instanceSerial;
  private requestSerial = 0;
  private rewardPercent = ECONOMY_CONFIG.rebirth.defaultRewardPercent;
  constructor(private readonly clock: () => number = Date.now, private readonly content = new ContentUnlockManager()) {}
  get animating(): boolean { return this.phaseValue === 'animating'; }
  get adPending(): boolean { return this.phaseValue === 'adPending'; }
  get count(): number { return this.data.count; }
  get levels(): readonly number[] { return this.data.levels.slice(); }
  private adUsedToday(): number { return this.data.adUsedDate === today(this.clock) ? this.data.adUsedCount : 0; }

  snapshot(position: StagePosition, history: number): RebirthSnapshot {
    const progress = { stageValueMax: history, currentStageIndex: position.stageIndex };
    const entry = this.content.get('rebirth', progress), action = this.content.get('rebirthAction', progress);
    const adEnabled = this.content.isAdEnabled('rebirth');
    const adAvailable = adEnabled && this.adUsedToday() < ECONOMY_CONFIG.rebirth.adDailyLimit;
    return { ruby: this.data.ruby.amount, count: this.data.count,
      upgrades: UPGRADE_TYPES.map((type, index) => {
        const level = this.data.levels[index], price = getRebirthPrice(level)?.amount ?? null;
        return { type, level, value: getRebirthBonus(type, level).amount, price,
          affordable: entry.unlocked && this.phaseValue === 'idle' && price !== null && this.data.ruby.amount.compare(price) >= 0 };
      }), reward: this.reward(position).amount,
      enhancedReward: this.reward(position, true).amount,
      unlocked: entry.unlocked,
      canRebirth: entry.unlocked && action.unlocked && this.phaseValue === 'idle',
      adAvailable, adEnabled, unlockMessage: entry.message ?? '', actionMessage: action.message ?? '',
      phase: this.phaseValue, animationElapsed: this.elapsed };
  }

  private reward(position: StagePosition, enhanced = false): OriginalInfVal {
    const floor = this.content.config.testResources.rebirthRewardFloorStage - 1;
    const effective = this.content.config.bypassProgression && position.stageIndex < floor
      ? { stageIndex: floor, waveIndex: 0 } : position;
    return getRebirthReward(effective, this.rewardPercent, enhanced);
  }
  private canExecute(position: StagePosition): boolean {
    return this.content.isUnlocked('rebirth') && this.content.isUnlocked('rebirthAction', { currentStageIndex: position.stageIndex });
  }
  /** Explicit startup/manual test supply, never called while a reward or purchase settles. */
  refillTestResources(): boolean {
    if (this.content.config.environment !== 'test' || !this.content.config.testResources.fundRebirthUpgrades || this.phaseValue !== 'idle') return false;
    const budget = remainingRebirthUpgradeBudget(this.data.levels);
    if (this.data.ruby.amount.compare(budget) >= 0) return false;
    this.data = { ...this.data, ruby: OriginalInfVal.fromAmount(budget) };
    return true;
  }

  configureModifiers(modifiers: { rewardPercent?: number }): void {
    if (modifiers.rewardPercent === undefined) return;
    if (!Number.isSafeInteger(modifiers.rewardPercent) || modifiers.rewardPercent < 0) throw new Error('Invalid rebirth reward percent');
    this.rewardPercent = modifiers.rewardPercent;
  }

  request(kind: RebirthKind, position: StagePosition): RebirthActionResult {
    if (kind !== 'normal' && kind !== 'ad') return { ok: false, reason: 'invalid' };
    if (this.phaseValue !== 'idle') return { ok: false, reason: 'busy' };
    if (!this.canExecute(position)) return { ok: false, reason: 'locked' };
    if (kind === 'ad' && !this.content.isAdEnabled('rebirth')) return { ok: false, reason: 'adsDisabled' };
    if (this.data.count >= Number.MAX_SAFE_INTEGER) return { ok: false, reason: 'countLimit' };
    if (kind === 'ad' && this.adUsedToday() >= ECONOMY_CONFIG.rebirth.adDailyLimit) return { ok: false, reason: 'adUsed' };
    this.kind = kind; this.elapsed = 0;
    if (kind === 'normal') { this.phaseValue = 'animating'; return { ok: true }; }
    this.pendingToken = `rebirth:${this.instanceId}:${++this.requestSerial}`;
    this.phaseValue = 'adPending';
    return { ok: true, token: this.pendingToken };
  }

  completeAd(token: string, outcome: RebirthAdOutcome, position: StagePosition): RebirthActionResult {
    if (this.phaseValue !== 'adPending' || token !== this.pendingToken) return { ok: false, reason: 'staleAd' };
    if (!['success', 'cancel', 'failure'].includes(outcome)) return { ok: false, reason: 'invalid' };
    this.pendingToken = null; this.phaseValue = 'idle';
    if (outcome !== 'success') return { ok: false, reason: outcome };
    if (!this.content.isAdEnabled('rebirth')) return { ok: false, reason: 'adsDisabled' };
    if (!this.canExecute(position)) return { ok: false, reason: 'locked' };
    if (this.adUsedToday() >= ECONOMY_CONFIG.rebirth.adDailyLimit) return { ok: false, reason: 'adUsed' };
    this.phaseValue = 'animating'; this.elapsed = 0;
    return { ok: true };
  }
  cancelAd(): void {
    if (this.phaseValue === 'adPending') { this.pendingToken = null; this.phaseValue = 'idle'; }
  }

  /** Does not settle early or write anything durable; the caller can suspend
   * this animation clock while the app is hidden without changing wall time. */
  advance(dt: number): boolean {
    if (!this.animating || !Number.isFinite(dt) || dt <= 0) return false;
    this.elapsed = Math.min(REBIRTH_ANIMATION_SECONDS, this.elapsed + dt);
    return this.elapsed + 1e-10 >= REBIRTH_ANIMATION_SECONDS;
  }
  prepareCompletion(position: StagePosition): RebirthCompletion {
    if (!this.animating || this.elapsed + 1e-10 < REBIRTH_ANIMATION_SECONDS) throw new Error('Rebirth is not ready');
    // Source computes the reward again at Rebirth(), after the visual delay.
    const reward = this.reward(position, this.kind === 'ad');
    return { ruby: this.data.ruby.add(reward), count: this.data.count + 1,
      adUsedDate: this.kind === 'ad' ? today(this.clock) : this.data.adUsedDate,
      adUsedCount: this.kind === 'ad' ? this.adUsedToday() + 1 : this.data.adUsedCount };
  }
  commitCompletion(completion: RebirthCompletion): void {
    this.data = { ...this.data, ...completion };
    this.phaseValue = 'idle'; this.elapsed = 0; this.pendingToken = null; this.kind = 'normal';
  }
  purchase(type: UpgradeType): boolean {
    if (!isUpgradeType(type) || this.phaseValue !== 'idle' || !this.content.isUnlocked('rebirth')) return false;
    const index = UPGRADE_TYPES.indexOf(type), price = getRebirthPrice(this.data.levels[index]);
    if (!price || this.data.ruby.amount.compare(price.amount) < 0) return false;
    const ruby = this.data.ruby.sub(price), levels = this.data.levels.slice();
    levels[index]++;
    this.data = { ...this.data, ruby, levels };
    return true;
  }

  serialize(): unknown { return { ruby: this.data.ruby.toJSON(), levels: this.data.levels.slice(), count: this.data.count, adUsedDate: this.data.adUsedDate, adUsedCount: this.data.adUsedCount }; }
  restore(value: unknown): void {
    const saved = value as { ruby?: unknown; levels?: unknown; count?: unknown; adUsedDate?: unknown; adUsedCount?: unknown } | null;
    if (!saved || !Array.isArray(saved.levels) || saved.levels.length !== 3 || !saved.levels.every(isRebirthLevel) ||
        typeof saved.count !== 'number' || !Number.isSafeInteger(saved.count) || saved.count < 0 || !validDate(saved.adUsedDate)) throw new Error('Invalid rebirth save');
    const ruby = OriginalInfVal.fromSerialized(saved.ruby);
    const adUsedCount = saved.adUsedCount;
    if (typeof adUsedCount !== 'number' || !Number.isSafeInteger(adUsedCount) || adUsedCount < 0) throw new Error('Invalid rebirth ad count');
    if (ruby.amount.isNegative || ruby.amount.digits.length > 100000) throw new Error('Invalid rebirth wallet');
    this.data = { ruby, levels: saved.levels.slice(), count: saved.count, adUsedDate: saved.adUsedDate, adUsedCount };
  }
  configureTest(config: RebirthTestConfiguration): boolean {
    if (this.phaseValue !== 'idle') return false;
    try {
      const current = this.serialize() as { ruby: unknown; levels: number[]; count: number; adUsedDate: string; adUsedCount: number };
      let ruby = current.ruby;
      if (config.ruby !== undefined) {
        const amount = DecimalAmount.from(config.ruby);
        ruby = OriginalInfVal.fromAmount(amount).toJSON();
      }
      this.restore({ ruby, levels: config.levels ?? current.levels, count: config.count ?? current.count,
        adUsedDate: config.adUsedDate ?? current.adUsedDate,
        adUsedCount: config.adUsedDate === undefined ? current.adUsedCount : (config.adUsedDate ? Math.max(1, ECONOMY_CONFIG.rebirth.adDailyLimit) : 0) });
      return true;
    } catch (_) { return false; }
  }
}
