import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { ContentUnlockManager } from './ContentUnlockManager';
import type { RewardedAdOutcome } from './RewardedAds';

export const MINE_SECONDS = 60;
export const MINE_LOADING_SECONDS = 1.5;
export type MinePhase = 'idle' | 'preparing' | 'entering' | 'playing' | 'result' | 'adPending' | 'exiting';
export type MineAdKind = 'entry' | 'reward';
export interface MineActionResult { ok: boolean; reason?: string; token?: string; }
export interface MineSave { entryDay: number; usedEntries: number; bestReward: number; playCount: number; lastSeenMs: number; }
export interface MineTestConfiguration { usedEntries?: number; bestReward?: number; }
export interface MineSnapshot {
  phase: MinePhase; adKind: MineAdKind | null;
  visible: boolean; unlocked: boolean; requiredStage: number;
  remainingTickets: number; usedEntries: number; freeEntriesPerDay: number;
  bestReward: number; score: number; rewardDiamonds: number; additionalRewardDiamonds: number;
  timeRemaining: number; timeLimit: number; oreCountNow: number; oreCountMax: number;
  loadingElapsed: number | null; resultElapsed: number; settlementPending: boolean;
  adsEnabled: boolean; speedAdAvailable: boolean; bonusAdAvailable: boolean;
  speedBuffRemainingSeconds: number; speedBuffMultiplier: number;
}
export interface AttackSpeedBuffSave { attackSpeedRemainingSeconds: number; }
const validInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const civilDay = (ms: number): number => {
  const d = new Date(ms); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
};
let instanceSerial = 0;

/** The original buff stores time left, rather than an offline wall-clock expiry. */
export class AttackSpeedBuff {
  private remaining = 0;
  get seconds(): number { return this.remaining; }
  get multiplier(): number { return this.remaining > 0 ? ECONOMY_CONFIG.mine.speedBuffMultiplier : 1; }
  nextGrantSeconds(): number {
    return Math.max(this.remaining, Math.min(ECONOMY_CONFIG.mine.speedBuffMaxSeconds, this.remaining + ECONOMY_CONFIG.mine.speedBuffSeconds));
  }
  setSeconds(seconds: number): void { this.remaining = seconds; }
  advance(dt: number, paused: boolean): boolean {
    if (paused || !Number.isFinite(dt) || dt <= 0 || this.remaining === 0) return false;
    this.remaining = Math.max(0, this.remaining - dt); return true;
  }
  serialize(): AttackSpeedBuffSave { return { attackSpeedRemainingSeconds: this.remaining }; }
  restore(value: unknown): void {
    if (value === undefined) return;
    const n = (value as AttackSpeedBuffSave | null)?.attackSpeedRemainingSeconds;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw new Error('Invalid attack-speed buff save');
    // Preserve valid remaining time when an author lowers the configured cap.
    this.remaining = n;
  }
}

/** Mine owns tickets and the run ledger; BattleSession atomically pays its result. */
export class MineSystem {
  private state: MineSave;
  private phaseValue: MinePhase = 'idle';
  private remaining = MINE_SECONDS;
  private loading = 0;
  private resultTime = 0;
  private scoreValue = 0;
  private total = 0;
  private mapReady = false;
  private readonly killed = new Set<number>();
  private settlement = false;
  private bonusClaimed = false;
  private pending: { token: string; kind: MineAdKind; day: number } | null = null;
  private readonly instanceId = ++instanceSerial;
  private requestSerial = 0;
  constructor(private readonly content: ContentUnlockManager, private readonly clock: () => number = Date.now) {
    const now = this.readClock();
    this.state = { entryDay: civilDay(now), usedEntries: 0, bestReward: 0, playCount: 0, lastSeenMs: now };
  }
  get phase(): MinePhase { return this.phaseValue; }
  get canFight(): boolean { return this.phaseValue === 'playing'; }
  get adPending(): boolean { return this.pending !== null; }
  get pendingKind(): MineAdKind | null { return this.pending?.kind ?? null; }
  get settlementPending(): boolean { return this.settlement; }
  get remainingSeconds(): number { return this.remaining; }
  get elapsed(): number { return MINE_SECONDS - this.remaining; }
  get reward(): number { return Math.floor(this.scoreValue / ECONOMY_CONFIG.mine.scorePerDiamond); }
  get additionalReward(): number { return this.reward * ECONOMY_CONFIG.mine.adAdditionalMultiplier; }
  get remainingTickets(): number { return Math.max(0, ECONOMY_CONFIG.mine.freeEntriesPerDay - this.state.usedEntries); }
  private readClock(): number {
    const n = this.clock(); return validInt(n) && n <= 8640000000000000 ? n : this.state?.lastSeenMs ?? 0;
  }
  refreshCalendar(): boolean {
    const now = Math.max(this.state.lastSeenMs, this.readClock()), day = civilDay(now);
    this.state.lastSeenMs = now;
    if (day <= this.state.entryDay) return false;
    this.state.entryDay = day; this.state.usedEntries = 0;
    if (this.pending?.kind === 'entry') this.cancelAd();
    return true;
  }
  serialize(): MineSave { return { ...this.state }; }
  restore(value: unknown): void {
    if (value === undefined) return;
    const s = value as MineSave | null;
    if (!s || !Number.isSafeInteger(s.entryDay) || Math.abs(s.entryDay) > 100000000 || !validInt(s.usedEntries)
      || !validInt(s.bestReward) || !validInt(s.playCount) || !validInt(s.lastSeenMs) || s.lastSeenMs > 8640000000000000) throw new Error('Invalid mine save');
    this.state = { ...s }; this.refreshCalendar();
  }
  configureTest(config: MineTestConfiguration): boolean {
    if (this.phaseValue !== 'idle' || Object.values(config).some(n => !validInt(n))) return false;
    this.refreshCalendar();
    if (config.usedEntries !== undefined) this.state.usedEntries = config.usedEntries;
    if (config.bestReward !== undefined) this.state.bestReward = config.bestReward;
    return true;
  }
  open(): MineActionResult {
    if (this.phaseValue !== 'idle') return { ok: false, reason: 'busy' };
    if (!this.content.isUnlocked('mine')) return { ok: false, reason: 'locked' };
    this.refreshCalendar(); this.phaseValue = 'preparing'; return { ok: true };
  }
  close(): MineActionResult {
    if (this.phaseValue !== 'preparing' && !(this.pending?.kind === 'entry')) return { ok: false, reason: 'inactive' };
    this.cancelAd(); this.phaseValue = 'idle'; return { ok: true };
  }
  checkStart(): MineActionResult {
    this.refreshCalendar();
    if (this.phaseValue !== 'preparing') return { ok: false, reason: 'busy' };
    if (!this.content.isUnlocked('mine')) return { ok: false, reason: 'locked' };
    if (this.remainingTickets <= 0) return { ok: false, reason: 'dailyLimit' };
    if (!validInt(this.state.playCount + 1)) return { ok: false, reason: 'countLimit' };
    return { ok: true };
  }
  nextEntrySave(): MineSave { return { ...this.state, usedEntries: this.state.usedEntries + 1, playCount: this.state.playCount + 1 }; }
  commitStart(next: MineSave): void {
    this.state = { ...next }; this.pending = null; this.phaseValue = 'entering'; this.loading = 0;
    this.remaining = MINE_SECONDS; this.resultTime = 0; this.scoreValue = 0; this.total = 0; this.mapReady = false;
    this.killed.clear(); this.settlement = false; this.bonusClaimed = false;
  }
  setOreCount(total: number): void {
    if (this.phaseValue !== 'entering' || this.mapReady || !validInt(total) || total > 1000) return;
    this.total = total; this.mapReady = true;
  }
  recordOre(id: number, score: number): boolean {
    if (!this.canFight || !validInt(id) || !validInt(score) || this.killed.has(id) || this.killed.size >= this.total) return false;
    if (!validInt(this.scoreValue + score)) return false;
    this.killed.add(id); this.scoreValue += score;
    if (this.killed.size === this.total) this.finish();
    return true;
  }
  private finish(): void { this.phaseValue = 'result'; this.resultTime = 0; this.settlement = true; }
  resultSave(): MineSave { return { ...this.state, bestReward: Math.max(this.state.bestReward, this.reward) }; }
  commitResult(next: MineSave): void { this.state = { ...next }; this.settlement = false; }
  commitBonus(): void { this.bonusClaimed = true; }
  exit(): MineActionResult {
    if (this.phaseValue === 'idle' || this.phaseValue === 'preparing' || this.phaseValue === 'exiting' || this.pending?.kind === 'entry') return { ok: false, reason: 'inactive' };
    if (this.settlement) return { ok: false, reason: 'saveFailed' };
    this.pending = null; this.phaseValue = 'exiting'; this.loading = 0; return { ok: true };
  }
  beginAd(kind: MineAdKind): MineActionResult {
    if (kind !== 'entry' && kind !== 'reward') return { ok: false, reason: 'invalid' };
    if (this.pending) return { ok: false, reason: 'adInProgress' };
    if (!this.content.isUnlocked(kind === 'entry' ? 'mineEntryAd' : 'mineRewardAd')) return { ok: false, reason: 'adsDisabled' };
    if (kind === 'entry') { const check = this.checkStart(); if (!check.ok) return check; }
    else if (this.phaseValue !== 'result' || this.settlement || this.bonusClaimed || this.reward === 0) return { ok: false, reason: 'unavailable' };
    const token = `mine-${this.instanceId}-${++this.requestSerial}`;
    this.pending = { token, kind, day: this.state.entryDay }; this.phaseValue = 'adPending'; return { ok: true, token };
  }
  completeAd(token: string, outcome: RewardedAdOutcome): MineActionResult {
    this.refreshCalendar();
    if (!this.pending || this.pending.token !== token) return { ok: false, reason: 'staleAd' };
    if (!['success', 'cancel', 'failure'].includes(outcome)) return { ok: false, reason: 'invalid' };
    const allowed = this.content.get(this.pending.kind === 'entry' ? 'mineEntryAd' : 'mineRewardAd');
    if (!allowed.unlocked) { this.cancelAd(); return { ok: false, reason: allowed.reason === 'adsDisabled' ? 'adsDisabled' : 'locked' }; }
    this.cancelAd(); return outcome === 'success' ? { ok: true } : { ok: false, reason: outcome };
  }
  cancelAd(): void {
    if (!this.pending) return;
    this.phaseValue = this.pending.kind === 'entry' ? 'preparing' : 'result'; this.pending = null;
  }
  advanceFrame(dt: number, paused: boolean): 'entered' | 'exited' | 'settled' | null {
    if (paused || !Number.isFinite(dt) || dt <= 0 || this.pending) return null;
    if (this.phaseValue === 'entering' || this.phaseValue === 'exiting') {
      this.loading += dt;
      if (this.loading < MINE_LOADING_SECONDS || (this.phaseValue === 'entering' && !this.mapReady)) return null;
      if (this.phaseValue === 'exiting') { this.phaseValue = 'idle'; return 'exited'; }
      this.phaseValue = 'playing'; if (this.total === 0) this.finish(); return 'entered';
    }
    if (this.canFight) {
      this.remaining = Math.max(0, this.remaining - dt);
      if (this.remaining === 0) { this.finish(); return 'settled'; }
    } else if (this.phaseValue === 'result') this.resultTime += dt;
    return null;
  }
  snapshot(buffSeconds = 0, buffMultiplier = 1): MineSnapshot {
    const content = this.content.get('mine');
    return { phase: this.phaseValue, adKind: this.pendingKind, visible: content.visible, unlocked: content.unlocked,
      requiredStage: this.content.config.thresholds.mineStage, remainingTickets: this.remainingTickets,
      usedEntries: this.state.usedEntries, freeEntriesPerDay: ECONOMY_CONFIG.mine.freeEntriesPerDay,
      bestReward: this.state.bestReward, score: this.scoreValue, rewardDiamonds: this.reward, additionalRewardDiamonds: this.additionalReward,
      timeRemaining: this.remaining, timeLimit: MINE_SECONDS, oreCountNow: this.killed.size, oreCountMax: this.total,
      loadingElapsed: this.phaseValue === 'entering' || this.phaseValue === 'exiting' ? this.loading : null,
      resultElapsed: this.resultTime, settlementPending: this.settlement,
      adsEnabled: this.content.config.adsEnabled,
      speedAdAvailable: this.phaseValue === 'preparing' && buffSeconds <= 0 && this.remainingTickets > 0 && this.content.isUnlocked('mineEntryAd'),
      bonusAdAvailable: this.phaseValue === 'result' && !this.settlement && !this.bonusClaimed && this.reward > 0 && this.content.isUnlocked('mineRewardAd'),
      speedBuffRemainingSeconds: buffSeconds, speedBuffMultiplier: buffMultiplier };
  }
}
