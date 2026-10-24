import { ContentUnlockManager } from './ContentUnlockManager';
import { DecimalAmount } from '../core/DecimalAmount';
import { bossHealth } from '../core/BossBalance';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { getStageDiamondRewards } from '../core/StageDiamondRewards';

/** Boss_manager owns an independent, unlimited challenge progression. */
export const BOSS_SECONDS = 60;
export const BOSS_ENTER_SECONDS = 2;
export const BOSS_EXIT_SECONDS = 1.5;
export type BossPhase = 'idle' | 'entering' | 'playing' | 'won' | 'failed' | 'adPending' | 'exiting';
export type BossAdOutcome = import('./RewardedAds').RewardedAdOutcome;
export interface BossActionResult { ok: boolean; reason?: string; token?: string; }
export interface BossTestConfiguration { stage?: number; }
export interface BossHealth { health: DecimalAmount; maxHealth: DecimalAmount; }
export interface BossSnapshot {
  visible: boolean; unlocked: boolean; stage: number; reward: number; additionalReward: number; totalReward: number; money: string; diamonds: string;
  phase: BossPhase; progress: number; healthRatio: number; health: string; maxHealth: string;
  remainingSeconds: number; resultElapsed: number; adAvailable: boolean; adEnabled: boolean;
  loadingElapsed: number | null;
}
export interface BossSave { stage: number; }
let instanceSerial = 0;
function validStage(stage: unknown): stage is number {
  return typeof stage === 'number' && Number.isSafeInteger(stage) && stage >= 0 && stage < Number.MAX_SAFE_INTEGER;
}

export class BossSystem {
  private stageValue = 0;
  private playedStage = 0;
  private phaseValue: BossPhase = 'idle';
  private remaining = BOSS_SECONDS;
  private elapsedValue = 0;
  private loading = 0;
  private resultTime = 0;
  private settledThisFrame = false;
  private pendingToken: string | null = null;
  private readonly instanceId = ++instanceSerial;
  private requestSerial = 0;
  private rewardStage = -1;
  private stageRewards: ReturnType<typeof getStageDiamondRewards> | null = null;
  constructor(private readonly content = new ContentUnlockManager()) {}
  get stage(): number { return this.stageValue; }
  get rewards(): ReturnType<typeof getStageDiamondRewards> {
    const stage = this.phaseValue === 'idle' ? this.stageValue : this.playedStage;
    if (stage !== this.rewardStage) {
      this.stageRewards = getStageDiamondRewards(ECONOMY_CONFIG.boss, stage); this.rewardStage = stage;
    }
    return this.stageRewards!;
  }
  get phase(): BossPhase { return this.phaseValue; }
  get canFight(): boolean { return this.phaseValue === 'playing'; }
  get remainingSeconds(): number { return Math.max(0, this.remaining); }
  get elapsed(): number { return this.elapsedValue; }
  get loadingElapsed(): number | null { return this.phaseValue === 'entering' || this.phaseValue === 'exiting' ? this.loading : null; }
  serialize(): BossSave { return { stage: this.stageValue }; }
  restore(value: unknown): void {
    const data = value as Partial<BossSave> | null;
    if (!data || !validStage(data.stage)) throw new Error('Invalid Boss save');
    this.stageValue = data.stage;
  }
  configureTest(config: BossTestConfiguration): boolean {
    if (this.phaseValue !== 'idle' || (config.stage !== undefined && !validStage(config.stage))) return false;
    if (config.stage !== undefined) this.stageValue = config.stage;
    return true;
  }
  snapshot(money: string, diamonds: string, boss?: BossHealth): BossSnapshot {
    const access = this.content.get('boss'), adEnabled = this.content.isAdEnabled('boss');
    const stage = this.phaseValue === 'idle' ? this.stageValue : this.playedStage;
    const maxHealth = boss?.maxHealth ?? bossHealth(stage).amount;
    const health = boss?.health ?? (this.phaseValue !== 'idle' && this.stageValue > this.playedStage ? DecimalAmount.from(0) : maxHealth);
    const healthRatio = Math.max(0, Math.min(1, health.ratio(maxHealth)));
    return { visible: access.visible, unlocked: access.unlocked, stage,
      reward: this.rewards.reward, additionalReward: this.rewards.additionalReward, totalReward: this.rewards.totalReward,
      money, diamonds, phase: this.phaseValue, progress: 1 - healthRatio, healthRatio,
      health: health.format(), maxHealth: maxHealth.format(),
      // Boss_Slider displays (int)(GameTime_Now + 1) after the coroutine's
      // subtraction and retains it on failure. Keep the final negative value
      // here; the generic battle HUD uses the clamped getter above.
      remainingSeconds: this.remaining, resultElapsed: this.resultTime,
      adAvailable: adEnabled && this.phaseValue === 'won', adEnabled, loadingElapsed: this.loadingElapsed };
  }
  start(): BossActionResult {
    if (this.phaseValue !== 'idle') return { ok: false, reason: 'busy' };
    if (!this.content.isUnlocked('boss')) return { ok: false, reason: 'locked' };
    if (!validStage(this.stageValue + 1)) return { ok: false, reason: 'stageLimit' };
    if (!this.rewards.withinWalletLimit) return { ok: false, reason: 'stageLimit' };
    this.playedStage = this.stageValue; this.phaseValue = 'entering'; this.loading = 0;
    this.remaining = BOSS_SECONDS; this.elapsedValue = 0; this.resultTime = 0;
    this.settledThisFrame = false; this.pendingToken = null;
    return { ok: true };
  }
  exit(): BossActionResult {
    if (this.phaseValue === 'idle' || this.phaseValue === 'exiting') return { ok: false, reason: 'inactive' };
    this.pendingToken = null; this.phaseValue = 'exiting'; this.loading = 0; this.settledThisFrame = false;
    return { ok: true };
  }
  win(): boolean {
    if (!this.canFight) return false;
    this.phaseValue = 'won'; this.stageValue++; this.resultTime = 0; this.settledThisFrame = true;
    return true;
  }
  beginAd(): BossActionResult {
    if (!this.content.isAdEnabled('boss')) return { ok: false, reason: 'adsDisabled' };
    if (this.phaseValue !== 'won') return { ok: false, reason: this.phaseValue === 'adPending' ? 'adInProgress' : 'notWon' };
    this.pendingToken = `boss:${this.instanceId}:${++this.requestSerial}`;
    this.phaseValue = 'adPending'; return { ok: true, token: this.pendingToken };
  }
  completeAd(token: string, outcome: BossAdOutcome): BossActionResult {
    if (this.phaseValue !== 'adPending' || this.pendingToken !== token) return { ok: false, reason: 'staleAd' };
    if (!['success', 'cancel', 'failure'].includes(outcome)) return { ok: false, reason: 'invalid' };
    this.pendingToken = null; this.phaseValue = 'won';
    if (!this.content.isAdEnabled('boss')) return { ok: false, reason: 'adsDisabled' };
    return outcome === 'success' ? { ok: true } : { ok: false, reason: outcome };
  }
  cancelAd(): void {
    if (this.phaseValue === 'adPending') { this.pendingToken = null; this.phaseValue = 'won'; }
  }
  /** The coroutine yields once after subtracting through zero. A final hit
   * before its next resume still wins; result animation starts on a later frame. */
  advanceFrame(dt: number, paused = false): 'entered' | 'exited' | null {
    if (paused || !Number.isFinite(dt) || dt <= 0) return null;
    if (this.phaseValue === 'entering' || this.phaseValue === 'exiting') {
      this.loading += dt;
      const entered = this.phaseValue === 'entering';
      if (this.loading + 1e-10 < (entered ? BOSS_ENTER_SECONDS : BOSS_EXIT_SECONDS)) return null;
      this.phaseValue = entered ? 'playing' : 'idle'; this.loading = 0;
      return entered ? 'entered' : 'exited';
    }
    if (this.settledThisFrame) { this.settledThisFrame = false; return null; }
    if (this.canFight) {
      if (this.remaining <= 0) { this.phaseValue = 'failed'; this.resultTime = 0; }
      else { this.remaining -= dt; this.elapsedValue += dt; }
    } else if (this.phaseValue === 'won' || this.phaseValue === 'failed' || this.phaseValue === 'adPending') this.resultTime += dt;
    return null;
  }
}
