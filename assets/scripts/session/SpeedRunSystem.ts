import { ContentUnlockManager } from './ContentUnlockManager';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { getStageDiamondRewards } from '../core/StageDiamondRewards';

/** SpeedRun_manager's independent challenge lifecycle. Map/combat and durable
 * wallet writes belong to BattleSession; only the next challenge stage is saved. */
export const SPEED_RUN_SECONDS = 60;
export const SPEED_RUN_LOADING_SECONDS = 1.5;
export type SpeedRunPhase = 'idle' | 'entering' | 'playing' | 'won' | 'failed' | 'adPending' | 'exiting';
export type SpeedRunAdOutcome = import('./RewardedAds').RewardedAdOutcome;
export interface SpeedRunActionResult { ok: boolean; reason?: string; token?: string; }
export interface SpeedRunTestConfiguration { stage?: number; }
export interface SpeedRunSnapshot {
  unlocked: boolean; stage: number; reward: number; additionalReward: number; totalReward: number; money: string; diamonds: string;
  phase: SpeedRunPhase; progress: number; remainingSeconds: number; resultElapsed: number;
  adAvailable: boolean; adEnabled: boolean; loadingElapsed: number | null;
}
export interface SpeedRunSave { stage: number; }
let instanceSerial = 0;
function validStage(stage: unknown): stage is number {
  return typeof stage === 'number' && Number.isSafeInteger(stage) && stage >= 0 && stage < Number.MAX_SAFE_INTEGER;
}

export class SpeedRunSystem {
  private stageValue = 0;
  private playedStage = 0;
  private phaseValue: SpeedRunPhase = 'idle';
  private remaining = SPEED_RUN_SECONDS;
  private elapsedValue = 0;
  private loading = 0;
  private resultTime = 0;
  private progressValue = 0;
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
      this.stageRewards = getStageDiamondRewards(ECONOMY_CONFIG.speedRun, stage); this.rewardStage = stage;
    }
    return this.stageRewards!;
  }
  get phase(): SpeedRunPhase { return this.phaseValue; }
  get canFight(): boolean { return this.phaseValue === 'playing'; }
  get remainingSeconds(): number { return Math.max(0, this.remaining); }
  get elapsed(): number { return this.elapsedValue; }
  get loadingElapsed(): number | null { return this.phaseValue === 'entering' || this.phaseValue === 'exiting' ? this.loading : null; }
  serialize(): SpeedRunSave { return { stage: this.stageValue }; }
  restore(value: unknown): void {
    const data = value as Partial<SpeedRunSave> | null;
    if (!data || !validStage(data.stage)) throw new Error('Invalid challenge save');
    this.stageValue = data.stage;
  }
  configureTest(config: SpeedRunTestConfiguration): boolean {
    if (this.phaseValue !== 'idle' || (config.stage !== undefined && !validStage(config.stage))) return false;
    if (config.stage !== undefined) this.stageValue = config.stage;
    return true;
  }
  snapshot(money: string, diamonds: string): SpeedRunSnapshot {
    const adEnabled = this.content.isAdEnabled('speedrun');
    return { unlocked: this.content.isUnlocked('speedrun'), stage: this.phaseValue === 'idle' ? this.stageValue : this.playedStage,
      reward: this.rewards.reward, additionalReward: this.rewards.additionalReward, totalReward: this.rewards.totalReward,
      money, diamonds, phase: this.phaseValue,
      progress: this.progressValue, remainingSeconds: this.remainingSeconds,
      resultElapsed: this.resultTime, adAvailable: adEnabled && this.phaseValue === 'won', adEnabled, loadingElapsed: this.loadingElapsed };
  }
  start(): SpeedRunActionResult {
    if (this.phaseValue !== 'idle') return { ok: false, reason: 'busy' };
    if (!this.content.isUnlocked('speedrun')) return { ok: false, reason: 'locked' };
    if (!validStage(this.stageValue + 1)) return { ok: false, reason: 'stageLimit' };
    if (!this.rewards.withinWalletLimit) return { ok: false, reason: 'stageLimit' };
    this.playedStage = this.stageValue; this.phaseValue = 'entering'; this.loading = 0;
    this.remaining = SPEED_RUN_SECONDS; this.elapsedValue = 0; this.resultTime = 0;
    this.progressValue = 0; this.settledThisFrame = false; this.pendingToken = null;
    return { ok: true };
  }
  exit(): SpeedRunActionResult {
    if (this.phaseValue === 'idle' || this.phaseValue === 'exiting') return { ok: false, reason: 'inactive' };
    this.pendingToken = null; this.phaseValue = 'exiting'; this.loading = 0; this.settledThisFrame = false;
    return { ok: true };
  }
  setProgress(kills: number, total: number): void {
    if (this.canFight && total > 0) this.progressValue = Math.max(0, Math.min(1, kills / total));
  }
  win(): boolean {
    if (!this.canFight) return false;
    this.phaseValue = 'won'; this.stageValue++; this.progressValue = 1;
    this.resultTime = 0; this.settledThisFrame = true;
    return true;
  }
  beginAd(): SpeedRunActionResult {
    if (!this.content.isAdEnabled('speedrun')) return { ok: false, reason: 'adsDisabled' };
    if (this.phaseValue !== 'won') return { ok: false, reason: this.phaseValue === 'adPending' ? 'adInProgress' : 'notWon' };
    this.pendingToken = `speedrun:${this.instanceId}:${++this.requestSerial}`;
    this.phaseValue = 'adPending'; return { ok: true, token: this.pendingToken };
  }
  completeAd(token: string, outcome: SpeedRunAdOutcome): SpeedRunActionResult {
    if (this.phaseValue !== 'adPending' || this.pendingToken !== token) return { ok: false, reason: 'staleAd' };
    if (!['success', 'cancel', 'failure'].includes(outcome)) return { ok: false, reason: 'invalid' };
    this.pendingToken = null; this.phaseValue = 'won';
    if (!this.content.isAdEnabled('speedrun')) return { ok: false, reason: 'adsDisabled' };
    return outcome === 'success' ? { ok: true } : { ok: false, reason: outcome };
  }
  cancelAd(): void {
    if (this.phaseValue === 'adPending') { this.pendingToken = null; this.phaseValue = 'won'; }
  }
  /** Like the source coroutine, crossing zero yields once before failure. A
   * final kill processed before the next resume may still settle victory. */
  advanceFrame(dt: number, paused = false): 'entered' | 'exited' | null {
    if (paused || !Number.isFinite(dt) || dt <= 0) return null;
    if (this.phaseValue === 'entering' || this.phaseValue === 'exiting') {
      this.loading += dt;
      if (this.loading + 1e-10 < SPEED_RUN_LOADING_SECONDS) return null;
      const entered = this.phaseValue === 'entering';
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
