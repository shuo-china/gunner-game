import { ECONOMY_CONFIG } from '../core/EconomyConfig';

export interface DailyShareSave { lastClaimDay: string; }
export interface DailyShareSnapshot extends DailyShareSave {
  today: string; canClaim: boolean; blocked: boolean; diamonds: number;
}
export type DailyShareResult = { ok: true; diamonds: number } |
  { ok: false; reason: 'notClaimable' | 'unavailable' | 'saveFailed' | 'walletLimit' | 'invalidSave'; message?: string };
export type DailyShareCandidate = { ok: true; diamonds: number; save: DailyShareSave } |
  Extract<DailyShareResult, { ok: false }>;

const initialSave = (): DailyShareSave => ({ lastClaimDay: '' });
function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Local previews use the same Asia/Shanghai day boundary as the production reward service. */
export function dailyShareDay(now: number): string {
  const date = new Date(now + 8 * 60 * 60 * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}
function validSave(value: unknown): value is DailyShareSave {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const day = (value as DailyShareSave).lastClaimDay;
  return day === '' || isDay(day);
}
export function validDailyShareSnapshot(value: unknown): value is DailyShareSnapshot {
  if (!validSave(value)) return false;
  const state = value as DailyShareSnapshot;
  return isDay(state.today) && typeof state.canClaim === 'boolean' && typeof state.blocked === 'boolean'
    && Number.isSafeInteger(state.diamonds) && state.diamonds >= 0
    && (!state.canClaim || (!state.blocked && state.today > state.lastClaimDay));
}

/** Computes a candidate only; the session persists the ledger and diamond wallet atomically. */
export class DailyShareSystem {
  private raw: unknown = initialSave();
  private data: DailyShareSave | null = initialSave();

  restore(value: unknown): void {
    this.raw = value;
    this.data = validSave(this.raw) ? { ...this.raw } : null;
  }
  /** Preserve damaged optional ledgers verbatim, while preventing reward claims. */
  serialize(): unknown { return this.raw && typeof this.raw === 'object' ? JSON.parse(JSON.stringify(this.raw)) : this.raw; }
  snapshot(today: string): DailyShareSnapshot {
    const data = this.data ?? initialSave(), validToday = isDay(today);
    return { ...data, today, blocked: this.data === null || !validToday,
      canClaim: this.data !== null && validToday && today > data.lastClaimDay && ECONOMY_CONFIG.dailyShare.dailyLimit > 0,
      diamonds: ECONOMY_CONFIG.dailyShare.diamonds };
  }
  prepareClaim(today: string): DailyShareCandidate {
    if (!this.data) return { ok: false, reason: 'invalidSave' };
    const state = this.snapshot(today);
    if (!state.canClaim) return { ok: false, reason: 'notClaimable' };
    return { ok: true, diamonds: state.diamonds, save: { lastClaimDay: today } };
  }
  commit(save: DailyShareSave): void { this.restore(save); }
}
