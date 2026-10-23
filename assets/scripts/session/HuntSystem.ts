import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { ContentUnlockManager } from './ContentUnlockManager';
import type { RewardedAdOutcome } from './RewardedAds';

export const HUNT_ENTER_SECONDS = 2;
export const HUNT_CLEAR_SECONDS = 2;
export const HUNT_EXIT_SECONDS = 1.5;
export const HUNT_LEVELS_PER_WAVE = 5;
export interface HuntSave { wave: number; level: number; }
export type HuntPhase = 'idle' | 'entering' | 'playing' | 'clearing' | 'failed' | 'adPending' | 'exiting';
export interface HuntActionResult { ok: boolean; reason?: string; token?: string; }
export interface HuntSnapshot extends HuntSave {
  visible: boolean; unlocked: boolean; requiredStage: number; phase: HuntPhase;
  hp: number; maxHp: number; kills: number; totalMonsters: number; remainingMonsters: number; progress: number;
  reward: number; runReward: number; adReward: number; petCoins: number;
  resultElapsed: number; loadingElapsed: number | null; adEnabled: boolean; adAvailable: boolean;
  settlementPending: boolean;
}
let serial = 0;
export function validateHuntSave(value: unknown): HuntSave {
  const data = value as HuntSave;
  if (!data || !Number.isSafeInteger(data.wave) || data.wave < 0 || data.wave >= Math.floor(Number.MAX_SAFE_INTEGER / HUNT_LEVELS_PER_WAVE)
    || !Number.isInteger(data.level) || data.level < 0 || data.level >= HUNT_LEVELS_PER_WAVE) throw new Error('Invalid hunt save');
  return { wave: data.wave, level: data.level };
}

/** Monster_manager lifecycle. Only wave/level survive a reload; the live run's
 * advertisement can never be claimed from a reconstructed result screen. */
export class HuntSystem {
  private position: HuntSave = { wave: 0, level: 0 };
  private played: HuntSave = { wave: 0, level: 0 };
  private state: HuntPhase = 'idle';
  private timer = 0;
  private resultTime = 0;
  private earned = 0;
  private hp = 1;
  private kills = 0;
  private total = 0;
  private clearPending = false;
  private adPending = false;
  private pendingToken: string | null = null;
  private readonly id = ++serial;
  private requestSerial = 0;
  private justSettled = false;
  constructor(private readonly content = new ContentUnlockManager()) {}
  get wave(): number { return this.position.wave; }
  get level(): number { return this.position.level; }
  get phase(): HuntPhase { return this.state; }
  get canFight(): boolean { return this.state === 'playing'; }
  get settlementPending(): boolean { return this.clearPending || this.adPending; }
  get pendingClear(): boolean { return this.clearPending; }
  get pendingAdReward(): boolean { return this.adPending; }
  get runReward(): number { return this.earned; }
  get adReward(): number { return this.earned * ECONOMY_CONFIG.hunt.adAdditionalMultiplier; }
  get firstClear(): boolean { return this.position.wave > 0 || this.position.level > 0; }
  serialize(): HuntSave { return { ...this.position }; }
  restore(value: unknown): void { if (value !== undefined) this.position = validateHuntSave(value); }
  configureTest(value: Partial<HuntSave>): boolean {
    if (this.state !== 'idle') return false;
    try { this.position = validateHuntSave({ ...this.position, ...value }); return true; } catch (_) { return false; }
  }
  snapshot(petCoins: number): HuntSnapshot {
    const access = this.content.get('hunt'), adEnabled = this.content.isAdEnabled('hunt');
    return { ...(this.state === 'idle' ? this.position : this.played), visible: access.visible, unlocked: access.unlocked,
      requiredStage: access.requiredStage ?? this.content.config.thresholds.huntStage,
      phase: this.state, hp: this.hp, maxHp: 1, kills: this.kills, totalMonsters: this.total,
      remainingMonsters: Math.max(0, this.total - this.kills), progress: this.total ? this.kills / this.total : 0,
      reward: ECONOMY_CONFIG.hunt.petCoinsPerLevel, runReward: this.earned, adReward: this.adReward, petCoins,
      resultElapsed: this.resultTime, loadingElapsed: this.state === 'entering' || this.state === 'exiting' ? this.timer : null,
      adEnabled, adAvailable: adEnabled && this.state === 'failed' && this.earned > 0,
      settlementPending: this.settlementPending };
  }
  start(): HuntActionResult {
    if (this.state !== 'idle') return { ok: false, reason: 'busy' };
    if (!this.content.isUnlocked('hunt')) return { ok: false, reason: 'contentLocked' };
    this.played = this.serialize(); this.state = 'entering'; this.timer = this.resultTime = this.earned = this.kills = this.total = 0;
    this.hp = 1; this.clearPending = this.adPending = this.justSettled = false; this.pendingToken = null;
    return { ok: true };
  }
  setProgress(kills: number, total: number, hp = this.hp): void {
    if (this.state === 'idle' || this.state === 'entering') return;
    this.kills = Math.max(0, kills); this.total = Math.max(this.kills, total); this.hp = Math.max(0, hp);
  }
  requestClear(wave: number, level: number): boolean {
    if (!this.canFight || wave !== this.played.wave || level !== this.played.level) return false;
    this.state = 'clearing'; this.timer = 0; this.clearPending = true; return true;
  }
  nextSave(): HuntSave {
    return validateHuntSave(this.position.level + 1 === HUNT_LEVELS_PER_WAVE
      ? { wave: this.position.wave + 1, level: 0 } : { wave: this.position.wave, level: this.position.level + 1 });
  }
  commitClear(next: HuntSave): void {
    if (!this.clearPending) return;
    this.position = validateHuntSave(next); this.earned += ECONOMY_CONFIG.hunt.petCoinsPerLevel;
    this.clearPending = false; this.timer = 0; this.justSettled = true;
  }
  fail(): HuntActionResult {
    if (!this.canFight) return { ok: false, reason: this.settlementPending ? 'saveFailed' : 'inactive' };
    this.hp = 0; this.state = 'failed'; this.resultTime = 0; return { ok: true };
  }
  giveUp(): HuntActionResult {
    if (this.settlementPending) return { ok: false, reason: 'saveFailed' };
    if (this.state !== 'playing' && this.state !== 'clearing' && this.state !== 'entering') return { ok: false, reason: 'inactive' };
    this.state = 'failed'; this.resultTime = 0; return { ok: true };
  }
  exit(): HuntActionResult {
    if (this.settlementPending) return { ok: false, reason: 'saveFailed' };
    if (this.state === 'idle' || this.state === 'exiting') return { ok: false, reason: 'inactive' };
    this.pendingToken = null; this.state = 'exiting'; this.timer = 0; return { ok: true };
  }
  beginAd(): HuntActionResult {
    if (!this.content.isAdEnabled('hunt')) return { ok: false, reason: 'adsDisabled' };
    if (this.state !== 'failed' || this.earned <= 0) return { ok: false, reason: 'unavailable' };
    this.pendingToken = `hunt:${this.id}:${++this.requestSerial}`; this.state = 'adPending';
    return { ok: true, token: this.pendingToken };
  }
  completeAd(token: string, outcome: RewardedAdOutcome): HuntActionResult {
    if (this.state !== 'adPending' || token !== this.pendingToken) return { ok: false, reason: 'staleAd' };
    if (!['success', 'cancel', 'failure'].includes(outcome)) return { ok: false, reason: 'invalid' };
    if (this.adPending) return { ok: true };
    if (outcome !== 'success' || !this.content.isAdEnabled('hunt')) {
      this.pendingToken = null; this.state = 'failed'; return { ok: false, reason: outcome === 'success' ? 'adsDisabled' : outcome };
    }
    this.adPending = true; return { ok: true };
  }
  commitAd(): void { if (this.adPending) { this.adPending = false; this.pendingToken = null; this.exit(); } }
  cancelAd(): void { if (this.state === 'adPending' && !this.adPending) { this.pendingToken = null; this.state = 'failed'; } }
  advanceFrame(dt: number, paused = false): 'entered' | 'next' | 'exited' | null {
    if (paused || !Number.isFinite(dt) || dt <= 0 || this.settlementPending) return null;
    if (this.justSettled) { this.justSettled = false; if (this.state === 'clearing') return null; }
    if (this.state === 'entering' || this.state === 'clearing' || this.state === 'exiting') {
      this.timer += dt;
      const duration = this.state === 'entering' ? HUNT_ENTER_SECONDS : this.state === 'clearing' ? HUNT_CLEAR_SECONDS : HUNT_EXIT_SECONDS;
      if (this.timer + 1e-10 < duration) return null;
      const transition = this.state === 'entering' ? 'entered' : this.state === 'clearing' ? 'next' : 'exited';
      this.timer = 0; this.state = transition === 'exited' ? 'idle' : 'playing';
      if (transition !== 'exited') { this.played = this.serialize(); this.kills = this.total = 0; }
      return transition;
    }
    if (this.state === 'failed' || this.state === 'adPending') this.resultTime += dt;
    return null;
  }
}
