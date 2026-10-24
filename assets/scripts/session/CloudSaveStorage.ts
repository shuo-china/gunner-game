import type { EconomyStorage, SavePriority } from './BattleSession';
import { DecimalAmount } from '../core/DecimalAmount';
import { OriginalInfVal } from '../core/OriginalInfVal';
import { WeaponInventory } from './WeaponInventory';
import { validateStagePosition } from './StageProgression';
import { isUpgradeLevel } from './UpgradeEconomy';
import type { DailyShareSnapshot } from './DailyShareSystem';
import { validDailyShareSnapshot } from './DailyShareSystem';

export interface CloudSaveApi {
  saveRequest(method: 'GET' | 'POST', ownerId: string, data?: unknown): Promise<Record<string, any>>;
  rewardRequest?(kind: 'state' | RewardKind, ownerId: string, data?: unknown): Promise<Record<string, any>>;
}
export type RewardKind = 'daily' | 'redeem' | 'offline' | 'share';
interface PendingReward { kind: RewardKind; request_id: string; base_revision: string; day_index?: number; code?: string; }
export interface RewardReceipt extends CloudSnapshot {
  request_id: string; awarded_revision: string; server_time_ms: number;
  next_daily_reset_ms: number;
  reward: { kind: RewardKind; diamonds?: number; dayIndex?: number; code?: string; result?: any; before?: any };
  daily_check: any;
  daily_share: DailyShareSnapshot;
}
export interface CloudSnapshot { player_id: string; namespace: string; revision: string; save: string | null; saved_at_ms: number; }
interface PendingSave { request_id: string; base_revision: string; save: string; }
interface Journal { version: 1; revision: string; confirmed: string | null; local: string | null; pending?: PendingSave; reward?: PendingReward; }
export type CloudSaveChoice = 'cloud' | 'local';
export type CloudSaveStatus = 'saved' | 'pending' | 'syncing' | 'offline' | 'conflict' | 'blocked';
export interface CloudSaveConflict { readonly cloud: CloudSnapshot; readonly local: string; }
/** Network cadence only; every gameplay transaction still commits to the local journal immediately. */
export const CLOUD_SAVE_POLICY = Object.freeze({
  routineDelayMs: 60000,
  criticalDebounceMs: 5000,
  criticalMaxWaitMs: 15000,
  automaticUploadIntervalMs: 30000,
  backgroundAttemptIntervalMs: 30000,
  foregroundReadIntervalMs: 300000,
  retryInitialMs: 15000,
  retryMaximumMs: 300000,
  offlineNoticeFailures: 3,
  syncingNoticeDelayMs: 3000,
});
const revisionValid = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(v) && Number.isSafeInteger(Number(v));

function completeDailyCheck(value: any): boolean {
  return !!value && typeof value.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.today)
    && typeof value.lastClaimDay === 'string' && typeof value.canClaim === 'boolean' && typeof value.blocked === 'boolean'
    && Number.isSafeInteger(value.checkNum) && value.checkNum >= 0 && value.checkNum <= 7
    && Number.isSafeInteger(value.totalCheckNum) && value.totalCheckNum >= value.checkNum
    && (value.claimableIndex === null || (Number.isInteger(value.claimableIndex) && value.claimableIndex >= 0 && value.claimableIndex < 7))
    && Array.isArray(value.days) && value.days.length === 7 && value.days.every((day: any, index: number) =>
      day?.dayIndex === index && Number.isSafeInteger(day.diamonds) && day.diamonds >= 0
      && ['geted', 'getable', 'normal'].includes(day.status));
}

function completeRewardState(value: any): boolean {
  return revisionValid(value.revision) && Number.isSafeInteger(value.server_time_ms)
    && Number.isSafeInteger(value.next_daily_reset_ms) && value.next_daily_reset_ms > value.server_time_ms
    && completeDailyCheck(value.daily_check) && validDailyShareSnapshot(value.daily_share)
    && value.daily_share.today === value.daily_check.today;
}

export function rewardLedgersMatch(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return true;
  const a = JSON.parse(left), b = JSON.parse(right), da = a.dailyCheck, db = b.dailyCheck;
  return !!da && !!db && a.dailyShare !== undefined && b.dailyShare !== undefined
    && a.redeemedCodes !== undefined && b.redeemedCodes !== undefined
    && da.lastClaimDay === db.lastClaimDay && da.checkNum === db.checkNum && da.totalCheckNum === db.totalCheckNum
    && JSON.stringify(a.dailyShare) === JSON.stringify(b.dailyShare)
    && JSON.stringify(a.redeemedCodes) === JSON.stringify(b.redeemedCodes);
}

/** Validate the same required economy blocks as restore, before any constructor can create defaults. */
export function validateCloudSave(raw: string): void {
  let bytes = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    bytes += c < 128 ? 1 : c < 2048 ? 2 : 3;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < raw.length && raw.charCodeAt(i + 1) >= 0xdc00 && raw.charCodeAt(i + 1) <= 0xdfff) { bytes++; i++; }
  }
  if (bytes > 2097152) throw new Error('存档过大，已保留原始数据，请联系管理员');
  let v: any;
  try { v = JSON.parse(raw); }
  catch { throw new Error('存档格式异常，已保留原始数据，请联系管理员'); }
  if (!v || v.version !== 3 || !Array.isArray(v.levels) || v.levels.length !== 3 || !v.levels.every(isUpgradeLevel)
    || !v.money || typeof v.money.digits !== 'string' || !/^\d+$/.test(v.money.digits) || v.money.digits.length > 100000
    || !Number.isSafeInteger(v.money.exponent)) throw new Error('存档格式异常，已保留原始数据，请联系管理员');
  for (const key of ['weapons', 'skins', 'pets', 'fish', 'hunt', 'mine', 'buffs', 'progress', 'rebirth', 'speedRun', 'boss', 'raid',
    'content', 'tutorial', 'redeemedCodes', 'offline', 'dailyCheck', 'dailyShare', 'adventure', 'relics']) {
    if (v[key] === undefined) throw new Error('存档格式不受支持，已保留原始数据');
  }
  OriginalInfVal.fromSerialized(v.money);
  if (DecimalAmount.from(v.money).isNegative) throw new Error('存档余额异常');
  WeaponInventory.validate(v.weapons); validateStagePosition(v.progress);
}

/** One durable per-account journal. Synchronous game transactions never wait for the network. */
export class CloudSaveStorage implements EconomyStorage {
  readonly journalKey: string;
  status: CloudSaveStatus = 'pending';
  errorMessage = '';
  conflict?: CloudSaveConflict;
  private journal?: Journal;
  private operation?: Promise<void>;
  private disposed = false;
  private sealed = false;
  private ready = false;
  private due = Infinity;
  private criticalSince?: number;
  private retries = 0;
  private retryAt = 0;
  private operationStartedAt = 0;
  private lastUploadAttemptAt = -Infinity;
  private lastUploadSucceededAt = -Infinity;
  private lastRemoteReadAt = -Infinity;
  private savedAt = 0;
  lastReward?: RewardReceipt;
  private rewardStateReceipt?: { receipt: RewardReceipt; startedAt: number; receivedAt: number };

  constructor(private readonly persistent: EconomyStorage, private readonly api: CloudSaveApi,
    readonly ownerId: string, private readonly economyKey: string, backendScope: string,
    readonly namespace = 'production', private readonly now: () => number = Date.now,
    private readonly newRequestId: () => string = () => {
      const bytes = new Uint8Array(16);
      const crypto = (globalThis as any).crypto;
      if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      return Date.now().toString(36) + '_' + Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    }) {
    if (!/^[1-9][0-9]*$/.test(ownerId)) throw new Error('存档账号无效');
    this.journalKey = `${economyKey}:cloud:${encodeURIComponent(backendScope)}:${namespace}:${ownerId}`;
  }

  get dirty(): boolean { return !!this.journal && (!!this.journal.pending || this.journal.local !== this.journal.confirmed); }
  get lastSavedAt(): number { return this.savedAt; }
  get localSave(): string | null { return this.journal?.local ?? null; }
  /** Confirmed cloud head; presentation responses from older revisions must not replace it. */
  get currentRevision(): string | undefined { return this.journal?.revision; }
  get blocked(): boolean { return this.status === 'conflict' || this.status === 'blocked'; }
  get rewardPending(): boolean { return !!this.journal?.reward; }
  get rewardPendingKind(): RewardKind | undefined { return this.journal?.reward?.kind; }
  /** Avoid flashing routine network activity or treating a single failed request as an outage. */
  get displayStatus(): CloudSaveStatus {
    if (this.status === 'offline' && this.retries < CLOUD_SAVE_POLICY.offlineNoticeFailures) return 'pending';
    if (this.status === 'syncing' && this.now() - this.operationStartedAt < CLOUD_SAVE_POLICY.syncingNoticeDelayMs) return 'pending';
    return this.status;
  }
  requireReload(message: string): void { this.status = 'blocked'; this.errorMessage = message; }

  async open(chooseConflict: (value: CloudSaveConflict) => Promise<CloudSaveChoice>): Promise<void> {
    this.assertActive();
    const cached = this.readStored(this.journalKey);
    if (cached !== null) {
      let value: Journal;
      try { value = JSON.parse(cached) as Journal; }
      catch { throw new Error('本机存档缓存异常，已保留原始数据，请联系管理员'); }
      if (!value || value.version !== 1 || !revisionValid(value.revision) || (value.local !== null && typeof value.local !== 'string')
        || (value.confirmed !== null && typeof value.confirmed !== 'string')
        || (value.pending && (typeof value.pending.save !== 'string' || value.pending.base_revision !== value.revision
          || !/^[A-Za-z0-9_-]{16,80}$/.test(value.pending.request_id)))) throw new Error('本机存档缓存异常，请联系管理员');
      if (value.local !== null) validateCloudSave(value.local);
      if (value.confirmed !== null) validateCloudSave(value.confirmed);
      if (value.pending) validateCloudSave(value.pending.save);
      if (value.reward && (!['daily', 'redeem', 'offline', 'share'].includes(value.reward.kind)
        || !/^[A-Za-z0-9_-]{16,80}$/.test(value.reward.request_id) || value.reward.base_revision !== value.revision
        || value.pending || value.local !== value.confirmed)) throw new Error('奖励请求缓存异常，请联系管理员');
      this.journal = value;
      // Recover a committed reward before ordinary save reconciliation can see its new revision.
      if (value.reward) await this.sendReward();
      // A lost response must retry its original request before comparing revisions.
      if (value.pending) {
        try { await this.uploadPending(true); }
        catch (e) {
          if (!['SAVE_CONFLICT', 'REWARD_STATE_CONFLICT'].includes((e as any)?.code)) throw e;
          if ((e as any)?.code === 'REWARD_STATE_CONFLICT') this.makeConflict(await this.readRemote());
        }
      }
    }
    const remote = await this.readRemote();
    if (!this.journal) {
      this.commit({ version: 1, revision: remote.revision, confirmed: remote.save, local: remote.save });
    } else if (this.conflict || remote.revision !== this.journal.revision || remote.save !== this.journal.confirmed) {
      if (this.dirty || Number(remote.revision) <= Number(this.journal.revision)) {
        this.makeConflict(remote);
        const choice = await chooseConflict(this.conflict!); this.assertActive();
        await this.resolveConflict(choice, false);
      } else this.adopt(remote);
    }
    this.savedAt = remote.saved_at_ms;
    this.ready = true; this.setState();
    if (this.dirty) this.due = this.now();
  }

  getItem(key: string): string | null {
    if (key === this.economyKey) return this.journal?.local ?? null;
    return this.readStored(this.mapKey(key));
  }

  setItem(key: string, value: string, priority: SavePriority = 'critical'): void {
    this.assertActive();
    if (this.sealed) throw new Error('已选择另一份进度，正在重新进入游戏');
    if (key !== this.economyKey) { this.writeVerified(this.mapKey(key), value); return; }
    if (!this.ready || !this.journal) throw new Error('云存档尚未读取');
    if (this.journal.reward) throw new Error('奖励正在核验，请稍候');
    if (value === this.journal.local) return;
    try { this.commit({ ...this.journal, local: value }); }
    catch (error) { this.status = 'blocked'; this.errorMessage = '本机存档写入失败，请检查存储空间后重新进入'; throw error; }
    // Fresh gameplay must not hide an outstanding network/storage failure.
    if (this.status === 'saved') this.status = 'pending';
    const now = this.now();
    if (priority === 'critical') {
      this.criticalSince ??= now;
      this.due = Math.min(now + CLOUD_SAVE_POLICY.criticalDebounceMs, this.criticalSince + CLOUD_SAVE_POLICY.criticalMaxWaitMs);
    } else this.due = Math.min(this.due, now + CLOUD_SAVE_POLICY.routineDelayMs);
  }

  tick(): void {
    if (this.ready && !this.disposed && !this.sealed && !this.blocked && this.dirty
      && this.now() >= Math.max(this.due, this.retryAt, this.lastUploadSucceededAt + CLOUD_SAVE_POLICY.automaticUploadIntervalMs)) {
      void this.flush().catch(() => {});
    }
  }

  flush(): Promise<void> { return !this.dirty && !this.operation ? Promise.resolve() : this.run(async () => { if (this.dirty) await this.uploadPending(); }); }
  /** Best effort on hide; duplicate lifecycle events cannot bypass upload spacing or failure backoff. */
  flushBackground(): Promise<void> {
    if (this.operation) return this.operation;
    if (!this.dirty || this.now() < Math.max(this.retryAt,
      this.lastUploadAttemptAt + CLOUD_SAVE_POLICY.backgroundAttemptIntervalMs,
      this.lastUploadSucceededAt + CLOUD_SAVE_POLICY.automaticUploadIntervalMs)) return Promise.resolve();
    return this.flush();
  }
  /** Cold-start catch-up retains the previous server clock anchor until offline settlement commits. */
  flushResume(): Promise<void> { return this.run(async () => { if (this.dirty) await this.uploadPending(true); }); }

  async rewardState(startupReceipt?: RewardReceipt): Promise<Record<string, any>> {
    this.assertActive();
    // Only the immediate startup caller may reuse the just-committed response.
    // Ordinary foreground refreshes always read the server; never persist this hint.
    const hint = this.rewardStateReceipt;
    this.rewardStateReceipt = undefined;
    const now = this.now();
    if (startupReceipt && hint?.receipt === startupReceipt && startupReceipt === this.lastReward
      && startupReceipt.reward.kind === 'offline' && !this.dirty && !this.blocked && !this.sealed && !this.rewardPending
      && startupReceipt.revision === this.currentRevision && startupReceipt.save === this.localSave
      && startupReceipt.player_id === this.ownerId && startupReceipt.namespace === this.namespace
      && completeRewardState(startupReceipt)
      && now >= hint.receivedAt && hint.receivedAt >= hint.startedAt && now - hint.receivedAt <= 1000
      // Include the entire request duration as a conservative transit estimate.
      && startupReceipt.next_daily_reset_ms - startupReceipt.server_time_ms > now - hint.startedAt) {
      return { ...startupReceipt, responseAgeMs: now - hint.startedAt };
    }
    if (!this.api.rewardRequest) throw new Error('奖励服务未连接');
    const value = await this.api.rewardRequest('state', this.ownerId); this.assertActive();
    if (value.player_id !== this.ownerId || value.namespace !== this.namespace || !completeRewardState(value)) throw new Error('奖励状态响应无效');
    return value;
  }

  async recoverPendingReward(): Promise<RewardReceipt | undefined> {
    if (this.operation) await this.operation.catch(() => {});
    if (!this.journal?.reward) return undefined;
    const value = await this.sendReward(); this.setState(); return value;
  }

  /** Freeze gameplay while awaiting this transaction. Persist the request before sending any award. */
  async claimReward(kind: RewardKind, payload: { day_index?: number; code?: string } = {}): Promise<RewardReceipt> {
    if (this.operation) await this.operation;
    let result: RewardReceipt | undefined;
    await this.run(async () => {
      while (this.dirty && !this.blocked) await this.uploadPending();
      if (this.blocked || !this.journal || this.journal.local === null) throw new Error('请先同步游戏进度');
      if (this.journal.reward) throw new Error('奖励待恢复，请重新进入游戏');
      const fields = kind === 'daily' ? { day_index: payload.day_index } : kind === 'redeem' ? { code: payload.code } : {};
      this.commit({ ...this.journal, reward: { kind, request_id: this.newRequestId(), base_revision: this.journal.revision, ...fields } });
      result = await this.sendReward();
    });
    return result!;
  }

  private async sendReward(): Promise<RewardReceipt> {
    const pending = this.journal?.reward;
    if (!pending || !this.api.rewardRequest) throw new Error('奖励服务未连接');
    const { kind, ...body } = pending;
    this.rewardStateReceipt = undefined;
    const startedAt = this.now();
    let value: Record<string, any>;
    try { value = await this.api.rewardRequest(kind, this.ownerId, body); }
    catch (error) {
      // Definite rejected requests did not pay; transport/server failures must retain their ID.
      const status = (error as any)?.status;
      if (status >= 400 && status < 500 && ![408, 429].includes(status) && this.journal) {
        this.commit({ ...this.journal, reward: undefined });
      }
      throw error;
    }
    this.assertActive();
    if (value.player_id !== this.ownerId || value.namespace !== this.namespace || value.request_id !== pending.request_id
      || !revisionValid(value.revision) || !revisionValid(value.awarded_revision)
      || Number(value.awarded_revision) !== Number(pending.base_revision) + 1
      || Number(value.revision) < Number(value.awarded_revision) || typeof value.save !== 'string'
      || !Number.isSafeInteger(value.saved_at_ms) || !Number.isSafeInteger(value.server_time_ms)
      || value.reward?.kind !== kind) throw new Error('奖励回执无效，请重新进入恢复');
    validateCloudSave(value.save);
    if (!completeRewardState(value) || (kind === 'share' && (!Number.isSafeInteger(value.reward.diamonds)
      || value.reward.diamonds < 0))) throw new Error('奖励回执状态无效，请重新进入恢复');
    const receipt = value as RewardReceipt;
    this.adopt(receipt); this.savedAt = receipt.saved_at_ms; this.lastReward = receipt;
    this.rewardStateReceipt = { receipt, startedAt, receivedAt: this.now() };
    this.lastUploadSucceededAt = this.now();
    this.due = Infinity; this.criticalSince = undefined;
    return receipt;
  }

  /** Called on foreground. Never install another device's state into an already-running session. */
  reconcile(): Promise<void> {
    if (this.operation) return this.operation.then(() => this.reconcile());
    if (this.now() < Math.max(this.retryAt, this.lastRemoteReadAt + CLOUD_SAVE_POLICY.foregroundReadIntervalMs)) return Promise.resolve();
    return this.run(async () => {
      if (this.journal?.pending) await this.uploadPending();
      const remote = await this.readRemote();
      if (this.journal && (remote.revision !== this.journal.revision || remote.save !== this.journal.confirmed)) this.makeConflict(remote);
      // Local changes keep their scheduled upload; the CAS still protects against a later device write.
    });
  }

  async resolveConflict(choice: CloudSaveChoice, seal = true): Promise<void> {
    this.assertActive();
    if (!this.conflict || !this.journal) throw new Error('没有待处理的存档冲突');
    // Re-read, then CAS the exact version the player saw. A further race asks again.
    const seen = this.conflict.cloud, remote = await this.readRemote();
    if (remote.revision !== seen.revision || remote.save !== seen.save) { this.makeConflict(remote); throw new Error('云端进度又有更新，请重新选择'); }
    const local = this.journal.local;
    if (choice === 'local' && !rewardLedgersMatch(local, remote.save)) throw new Error('本机奖励记录已过期，请使用云端进度；两份进度会保留备份');
    if (local) this.backup('conflict-local-' + this.newRequestId(), local);
    if (remote.save) this.backup('conflict-cloud-' + remote.revision, remote.save);
    this.commit({ version: 1, revision: remote.revision, confirmed: remote.save, local: choice === 'local' ? local : remote.save });
    this.conflict = undefined; this.status = 'pending';
    try { if (choice === 'local' && this.dirty) await this.uploadPending(!seal); }
    catch (e) {
      if ((e as any)?.code === 'SAVE_CONFLICT') this.makeConflict(await this.readRemote());
      // An uncertain local upload stays in the durable journal; reload retries that same ID.
      else this.status = 'offline';
      throw e;
    }
    this.sealed = seal; this.setState();
  }

  dispose(): void { this.disposed = true; }

  private run(work: () => Promise<void>): Promise<void> {
    if (this.operation) return this.operation;
    if (this.blocked || this.sealed || this.disposed) return Promise.reject(new Error(this.errorMessage || '存档同步已暂停'));
    const operation = (async () => {
      this.operationStartedAt = this.now(); this.status = 'syncing';
      try { await work(); this.retries = 0; this.retryAt = 0; if (!this.blocked) this.setState(); }
      catch (error) {
        if (!this.disposed) {
          this.errorMessage = error instanceof Error ? error.message : '存档同步失败';
          const code = (error as any)?.code;
          const status = (error as any)?.status;
          if (!this.rewardPending && status >= 400 && status < 500
            && ['DAILY_NOT_CLAIMABLE', 'SHARE_NOT_CLAIMABLE', 'REDEEM_ALREADY_USED', 'REDEEM_INVALID', 'REWARD_INVALID', 'REWARD_WALLET_LIMIT'].includes(code)) {
            // A definitive business refusal is a successful server response, not a save outage.
            this.retries = 0; this.retryAt = 0; this.setState();
            throw error;
          } else if (code === 'SAVE_CONFLICT' || code === 'REWARD_STATE_CONFLICT') {
            try { this.makeConflict(await this.readRemote()); }
            catch { this.status = 'offline'; }
          } else this.status = this.rewardPending || ['ACCOUNT_CHANGED', 'ACCOUNT_DISABLED', 'SAVE_INVALID', 'SAVE_TOO_LARGE', 'REQUEST_ID_CONFLICT', 'LOCAL_STORAGE_ERROR', 'REWARD_STATE_CONFLICT'].includes(code) ? 'blocked' : 'offline';
          this.retryAt = this.now() + Math.min(CLOUD_SAVE_POLICY.retryMaximumMs,
            CLOUD_SAVE_POLICY.retryInitialMs * Math.pow(2, Math.min(this.retries++, 8)));
        }
        throw error;
      }
    })();
    this.operation = operation;
    void operation.then(() => { if (this.operation === operation) this.operation = undefined; }, () => { if (this.operation === operation) this.operation = undefined; });
    return operation;
  }

  private async uploadPending(resume = false): Promise<void> {
    this.assertActive();
    if (this.journal?.reward) throw new Error('奖励待恢复，请重新进入游戏');
    if (!this.journal || !this.dirty || this.journal.local === null) return;
    if (!this.journal.pending) {
      validateCloudSave(this.journal.local);
      this.commit({ ...this.journal, pending: { request_id: this.newRequestId(), base_revision: this.journal.revision, save: this.journal.local } });
    }
    const sent = this.journal.pending!;
    this.lastUploadAttemptAt = this.now();
    const result = await this.api.saveRequest('POST', this.ownerId, resume ? { ...sent, resume: true } : sent); this.assertActive();
    if (result.player_id !== this.ownerId || result.namespace !== this.namespace || result.request_id !== sent.request_id
      || result.revision !== String(Number(sent.base_revision) + 1) || !revisionValid(result.current_revision)
      || Number(result.current_revision) < Number(result.revision) || !Number.isSafeInteger(result.saved_at_ms)) throw new Error('云端保存回执无效');
    this.commit({ ...this.journal, revision: result.revision, confirmed: sent.save, pending: undefined });
    this.savedAt = result.saved_at_ms; this.lastUploadSucceededAt = this.now(); this.criticalSince = undefined;
    this.due = this.dirty ? this.now() + CLOUD_SAVE_POLICY.criticalDebounceMs : Infinity;
    if (result.current_revision !== result.revision) this.makeConflict(await this.readRemote());
  }

  private async readRemote(): Promise<CloudSnapshot> {
    const v = await this.api.saveRequest('GET', this.ownerId); this.assertActive();
    if (v.player_id !== this.ownerId || v.namespace !== this.namespace || !revisionValid(v.revision)
      || !Number.isSafeInteger(v.saved_at_ms) || (v.revision === '0' ? v.save !== null : typeof v.save !== 'string')) throw new Error('云端存档响应异常，未覆盖本机数据');
    if (v.save !== null) validateCloudSave(v.save);
    this.lastRemoteReadAt = this.now();
    return v as CloudSnapshot;
  }

  private makeConflict(remote: CloudSnapshot): void {
    const local = this.journal?.local;
    if (local === null || local === undefined) throw new Error('存档状态异常');
    this.conflict = { cloud: remote, local };
    this.status = 'conflict'; this.errorMessage = '其他设备已更新进度，请选择要使用的存档';
  }
  private adopt(remote: CloudSnapshot): void {
    this.commit({ version: 1, revision: remote.revision, confirmed: remote.save, local: remote.save }); this.conflict = undefined;
  }
  private commit(value: Journal): void { this.assertActive(); this.writeVerified(this.journalKey, JSON.stringify(value)); this.journal = value; }
  private readStored(key: string): string | null {
    const value = this.persistent.getItem(key);
    // Creator's WeChat adapter forwards wx.getStorageSync: a missing key is ''.
    // Only normalize absence; malformed nonempty snapshots must remain blocked.
    return value === '' || value == null ? null : value;
  }
  private writeVerified(key: string, value: string): void {
    try {
      this.persistent.setItem(key, value);
      if (this.persistent.getItem(key) !== value) throw new Error('Readback mismatch');
    } catch {
      throw Object.assign(new Error('本机存档写入失败，请检查存储空间'), { code: 'LOCAL_STORAGE_ERROR' });
    }
  }
  private mapKey(key: string): string { return this.journalKey + ':aux:' + encodeURIComponent(key); }
  private backup(name: string, raw: string): void {
    const key = this.journalKey + ':backup:' + name, old = this.readStored(key);
    if (old === null) this.writeVerified(key, raw);
    else if (old !== raw) throw new Error('存档备份不一致，已停止覆盖');
  }
  private assertActive(): void { if (this.disposed) throw new Error('存档同步已结束'); }
  private setState(): void { if (!this.conflict) { this.status = this.dirty ? 'pending' : 'saved'; this.errorMessage = ''; } }
}
