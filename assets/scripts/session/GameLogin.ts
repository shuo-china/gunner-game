import type { GameBackendConfig } from './GameBackendConfig';
import type { PlatformCredential, PlatformLoginBinding } from '../platform/PlatformTypes';

export interface GamePlayer { readonly id: string; readonly nickname: string; readonly provider: string; readonly app_id: string; }
export interface GameLoginResult {
  readonly player: GamePlayer;
  readonly is_new_player: boolean;
  readonly token_info: { readonly access_token: string; readonly token_type: 'Bearer'; readonly expires_in: number; readonly expires_at_ms: number; };
  readonly server_time_ms: number;
}
const MESSAGES: Record<string, string> = {
  NETWORK_ERROR: '连接失败，请检查网络后重试', TIMEOUT: '登录超时，请重试',
  LOGIN_FAILED: '平台登录失败，请重试', LOGIN_CANCELLED: '登录已取消，点击重试',
  CREDENTIAL_INVALID: '平台登录凭证无效，请重试',
  WECHAT_CODE_INVALID: '微信登录凭证已失效，请重试', WECHAT_LOGIN_FAILED: '微信登录失败，请重试',
  WECHAT_NOT_CONFIGURED: '登录服务尚未配置，请稍后再试', WECHAT_CONFIG_ERROR: '登录服务配置异常，请联系管理员',
  WECHAT_UNAVAILABLE: '微信登录服务暂时不可用，请稍后重试', WECHAT_RATE_LIMITED: '登录过于频繁，请稍后重试',
  TOO_MANY_REQUESTS: '登录过于频繁，请稍后重试', ACCOUNT_DISABLED: '账号不可用，请联系管理员',
  WECHAT_ACCOUNT_RESTRICTED: '当前微信账号暂无法登录，请联系管理员',
  SESSION_INVALID: '登录已失效，请重新登录', INVALID_RESPONSE: '登录服务返回异常，请稍后重试',
  APP_ID_MISMATCH: '当前应用与登录服务不匹配', DISPOSED: '登录已取消', SERVER_ERROR: '登录服务暂时不可用，请稍后重试',
  SAVE_CONFLICT: '其他设备已更新进度', REQUEST_ID_CONFLICT: '保存请求冲突，请重新进入游戏',
  SAVE_INVALID: '存档格式异常，请联系管理员', SAVE_TOO_LARGE: '存档过大，请联系管理员',
  ACCOUNT_CHANGED: '登录账号已变化，请重新进入游戏',
  REWARD_INVALID: '领取请求无效，请重试', SAVE_REQUIRED: '请先保存进度再领取',
  REWARD_STATE_INVALID: '领取记录异常，请联系管理员', REWARD_STATE_CONFLICT: '领取记录已更新，请重新进入游戏',
  DAILY_NOT_CLAIMABLE: '今天已签到或当前奖励尚不可领取', REDEEM_INVALID: '兑换码不存在或已失效',
  SHARE_NOT_CLAIMABLE: '今天已领取分享奖励或暂不可领取',
  REDEEM_ALREADY_USED: '兑换码已被使用。', REWARD_WALLET_LIMIT: '钻石余额已达上限',
  REWARD_CALCULATION_FAILED: '离线收益计算暂不可用，请稍后重试', REWARD_CONFIG_ERROR: '奖励服务暂不可用，请稍后重试',
};

export class GameLoginError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(typeof MESSAGES[code] === 'string' ? MESSAGES[code] : MESSAGES.SERVER_ERROR); this.name = 'GameLoginError'; }
}

/** Platform authentication and authenticated transport, separate from game-state synchronization. */
export class GameLoginClient {
  private result?: GameLoginResult;
  private validUntil = 0;
  private pending?: Promise<GameLoginResult>;
  private generation = 0;
  private disposed = false;
  private readonly cancellations = new Set<() => void>();

  constructor(private readonly binding: PlatformLoginBinding, private readonly config: GameBackendConfig,
    private readonly now: () => number = Date.now, private readonly timeoutMs = 15000) {
    const provider = binding.provider;
    if (!/^[a-z][a-z0-9_]*$/.test(provider.identityProvider) || !provider.appId
      || !/^\/auth\/[a-z][a-z0-9-]*$/.test(provider.endpoint) || ['/auth/me', '/auth/logout'].includes(provider.endpoint)) {
      throw new Error('平台登录适配器配置无效');
    }
  }

  get player(): GamePlayer | undefined { return this.result?.player; }
  get backendScope(): string { return this.config.baseUrl; }

  /** Pin the owner across credential renewal: an old save must never follow a new account. */
  async saveRequest(method: 'GET' | 'POST', ownerId: string, data?: unknown): Promise<Record<string, any>> {
    return this.authenticatedRequest(method, '/save', ownerId, data);
  }

  async rewardRequest(kind: 'state' | 'daily' | 'redeem' | 'offline' | 'share', ownerId: string, data?: unknown): Promise<Record<string, any>> {
    return this.authenticatedRequest(kind === 'state' ? 'GET' : 'POST', '/rewards/' + kind, ownerId, data);
  }

  private async authenticatedRequest(method: 'GET' | 'POST', path: string, ownerId: string, data?: unknown): Promise<Record<string, any>> {
    if (!this.result || this.now() >= this.validUntil) await this.login();
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = this.generation;
      if (this.result?.player.id !== ownerId) throw new GameLoginError('ACCOUNT_CHANGED');
      try {
        const raw = await this.send(method, path, data, this.result.token_info.access_token);
        this.assertCurrent(generation);
        if (raw.player_id !== ownerId || this.result?.player.id !== ownerId) throw new GameLoginError('ACCOUNT_CHANGED');
        return raw;
      } catch (error) {
        this.assertCurrent(generation);
        if (error instanceof GameLoginError && (error.status === 401 || error.status === 403)) {
          this.result = undefined; this.validUntil = 0;
          if (error.status === 401 && attempt === 0) { await this.login(); continue; }
        }
        throw error;
      }
    }
    throw new GameLoginError('SESSION_INVALID', 401);
  }

  /** Reacquire the current platform credential on cold start or explicit relogin. */
  login(): Promise<GameLoginResult> {
    if (this.disposed) return Promise.reject(new GameLoginError('DISPOSED'));
    if (this.pending) return this.pending;
    this.result = undefined;
    this.validUntil = 0;
    const generation = this.generation;
    const operation = (async () => {
      const credential = await this.freshCredential();
      this.assertCurrent(generation);
      const raw = await this.send('POST', this.binding.provider.endpoint, credential);
      this.assertCurrent(generation);
      const result = this.parseLogin(raw);
      this.result = result;
      // Do not compare device time against a server epoch; compute a local lifetime instead.
      this.validUntil = this.now() + Math.max(0, result.token_info.expires_in - 30) * 1000;
      return result;
    })();
    this.pending = operation;
    void operation.then(() => { if (this.pending === operation) this.pending = undefined; },
      () => { if (this.pending === operation) this.pending = undefined; });
    return operation;
  }

  async me(): Promise<GamePlayer> {
    if (!this.result || this.now() >= this.validUntil) await this.login();
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = this.generation;
      try {
        const raw = await this.send('GET', '/auth/me', undefined, this.result!.token_info.access_token);
        this.assertCurrent(generation);
        if (!this.isPlayer(raw.player) || raw.player.id !== this.result?.player.id) throw new GameLoginError('INVALID_RESPONSE');
        return raw.player;
      } catch (error) {
        this.assertCurrent(generation);
        if (error instanceof GameLoginError && (error.status === 401 || error.status === 403)) {
          this.result = undefined;
          this.validUntil = 0;
          if (error.status === 401 && attempt === 0) { await this.login(); continue; }
        }
        throw error;
      }
    }
    throw new GameLoginError('SESSION_INVALID', 401);
  }

  async logout(): Promise<void> {
    const token = this.result?.token_info.access_token;
    this.generation++;
    this.result = undefined;
    this.validUntil = 0;
    this.pending = undefined;
    // Creator's loose spread transform assumes arrays; explicitly materialize the Set.
    for (const cancel of Array.from(this.cancellations)) cancel();
    if (token && !this.disposed) {
      try { await this.send('POST', '/auth/logout', {}, token); }
      catch (error) { if (!(error instanceof GameLoginError && error.status === 401)) throw error; }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.result = undefined;
    this.pending = undefined;
    for (const cancel of Array.from(this.cancellations)) cancel();
  }

  private assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.generation) throw new GameLoginError('DISPOSED');
  }

  private freshCredential(): Promise<PlatformCredential> {
    return this.bounded((resolve, reject) => this.binding.provider.acquireCredential({
      timeoutMs: this.timeoutMs,
      success: credential => {
        if (!credential || typeof credential !== 'object' || Array.isArray(credential) || !Object.keys(credential).length) {
          reject(new GameLoginError('CREDENTIAL_INVALID')); return;
        }
        resolve(credential);
      },
      fail: code => reject(new GameLoginError(code)),
    }));
  }

  private send(method: 'GET' | 'POST', path: string, data?: unknown, token?: string): Promise<Record<string, any>> {
    return this.bounded((resolve, reject) => {
      const header: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (token) header.Authorization = `Bearer ${token}`;
      const task = this.binding.transport.request({ url: this.config.baseUrl + path, method, data, header, timeout: this.timeoutMs,
        success: response => {
          let body = response.data;
          if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = undefined; } }
          const object = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, any> : undefined;
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const code = typeof object?.code === 'string' && typeof MESSAGES[object.code] === 'string' ? object.code : 'SERVER_ERROR';
            reject(new GameLoginError(code, response.statusCode)); return;
          }
          if (!object) { reject(new GameLoginError('INVALID_RESPONSE')); return; }
          resolve(object);
        }, fail: () => reject(new GameLoginError('NETWORK_ERROR')),
      });
      return () => task?.abort?.();
    });
  }

  private bounded<T>(start: (resolve: (value: T) => void, reject: (error: Error) => void) => void | (() => void)): Promise<T> {
    if (this.disposed) return Promise.reject(new GameLoginError('DISPOSED'));
    return new Promise<T>((resolve, reject) => {
      let settled = false, abort: (() => void) | void;
      const finish = (error?: Error, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancellations.delete(cancel);
        if (error) reject(error); else resolve(value as T);
      };
      const cancel = (): void => { finish(new GameLoginError('DISPOSED')); try { abort?.(); } catch {} };
      const timer = setTimeout(() => { finish(new GameLoginError('TIMEOUT')); try { abort?.(); } catch {} }, this.timeoutMs);
      this.cancellations.add(cancel);
      try { abort = start(value => finish(undefined, value), error => finish(error)); }
      catch { finish(new GameLoginError('NETWORK_ERROR')); }
    });
  }

  private isPlayer(value: any): value is GamePlayer {
    return !!value && typeof value === 'object' && typeof value.id === 'string' && /^[1-9][0-9]*$/.test(value.id)
      && typeof value.nickname === 'string' && value.provider === this.binding.provider.identityProvider && value.app_id === this.binding.provider.appId;
  }

  private parseLogin(raw: Record<string, any>): GameLoginResult {
    const token = raw.token_info;
    if (!this.isPlayer(raw.player) || typeof raw.is_new_player !== 'boolean' || !token
      || typeof token.access_token !== 'string' || !/^fg1_[A-Za-z0-9_-]{43}$/.test(token.access_token)
      || token.token_type !== 'Bearer' || !Number.isSafeInteger(token.expires_in) || token.expires_in < 1 || token.expires_in > 604800
      || !Number.isSafeInteger(token.expires_at_ms) || !Number.isSafeInteger(raw.server_time_ms)) {
      throw new GameLoginError('INVALID_RESPONSE');
    }
    return raw as unknown as GameLoginResult;
  }
}
