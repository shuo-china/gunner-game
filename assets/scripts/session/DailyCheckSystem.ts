import { ECONOMY_CONFIG } from '../core/EconomyConfig';

export interface DailyCheckSave { lastClaimDay: string; checkNum: number; totalCheckNum: number; }
export type DailyCheckStatus = 'normal' | 'getable' | 'geted';
export interface DailyCheckSnapshot extends DailyCheckSave {
  today: string; canClaim: boolean; claimableIndex: number | null; blocked: boolean;
  days: readonly { dayIndex: number; diamonds: number; status: DailyCheckStatus }[];
}
export type DailyCheckResult = { ok: true; dayIndex: number; diamonds: number } |
  { ok: false; reason: 'invalidDay' | 'notClaimable' | 'saveFailed' | 'walletLimit' | 'invalidSave' | 'counterLimit' };
export type DailyCheckCandidate = { ok: true; dayIndex: number; diamonds: number; save: DailyCheckSave } |
  Extract<DailyCheckResult, { ok: false }>;

const initialSave = (): DailyCheckSave => ({ lastClaimDay: '', checkNum: 0, totalCheckNum: 0 });
function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Local calendar dates match the project's existing daily systems, including its injected test clock. */
export function dailyCheckDay(now: number): string {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return '';
  const day = `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return isDay(day) ? day : '';
}
function validSave(value: unknown): value is DailyCheckSave {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as DailyCheckSave;
  if (!Number.isSafeInteger(d.checkNum) || d.checkNum < 0 || d.checkNum > 7
    || !Number.isSafeInteger(d.totalCheckNum) || d.totalCheckNum < d.checkNum) return false;
  if (d.totalCheckNum === 0) return d.checkNum === 0 && d.lastClaimDay === '';
  return isDay(d.lastClaimDay) && d.checkNum % 7 === d.totalCheckNum % 7;
}

/** Computes claim candidates only; BattleSession commits a candidate and the wallet together. */
export class DailyCheckSystem {
  private raw: unknown = initialSave();
  private data: DailyCheckSave | null = initialSave();

  restore(value: unknown): void {
    this.raw = value === undefined ? initialSave() : value;
    this.data = validSave(this.raw) ? { ...this.raw } : null;
  }
  /** A malformed optional ledger remains verbatim in future full saves and cannot grant rewards. */
  serialize(): unknown { return this.raw && typeof this.raw === 'object' ? JSON.parse(JSON.stringify(this.raw)) : this.raw; }
  snapshot(today: string): DailyCheckSnapshot {
    const data = this.data ?? initialSave(), validToday = isDay(today);
    const nextDay = validToday && today > data.lastClaimDay;
    const checkNum = data.checkNum === 7 && nextDay ? 0 : data.checkNum;
    const canClaim = this.data !== null && nextDay && ECONOMY_CONFIG.dailyCheck.dailyLimit > 0
      && data.totalCheckNum < Number.MAX_SAFE_INTEGER;
    return { ...data, checkNum, today, canClaim, claimableIndex: canClaim ? checkNum : null, blocked: this.data === null || !validToday,
      days: ECONOMY_CONFIG.dailyCheck.diamondsByDay.map((diamonds, dayIndex) => ({ dayIndex, diamonds,
        status: dayIndex < checkNum ? 'geted' : dayIndex === checkNum && canClaim ? 'getable' : 'normal' })) };
  }
  prepareClaim(dayIndex: number, today: string): DailyCheckCandidate {
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= 7) return { ok: false, reason: 'invalidDay' };
    if (!this.data) return { ok: false, reason: 'invalidSave' };
    if (this.data.totalCheckNum === Number.MAX_SAFE_INTEGER) return { ok: false, reason: 'counterLimit' };
    const state = this.snapshot(today);
    if (!state.canClaim || dayIndex !== state.checkNum) return { ok: false, reason: 'notClaimable' };
    return { ok: true, dayIndex, diamonds: state.days[dayIndex].diamonds,
      save: { lastClaimDay: today, checkNum: dayIndex + 1, totalCheckNum: state.totalCheckNum + 1 } };
  }
  commit(save: DailyCheckSave): void { this.restore(save); }
}
