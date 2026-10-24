import type { RuntimeEnvironment } from './RuntimeEnvironment';

export interface GameBackendConfig { readonly baseUrl: string; }

// Public routing configuration only. AppSecret belongs exclusively in PHP/.env.
export const GAME_BACKEND = {
  production: 'https://nurse.kylinsit.com/game/v1',
  test: 'http://127.0.0.1:8787/game/v1',
} as const;

export function resolveGameBackendConfig(injected: unknown, environment: RuntimeEnvironment): GameBackendConfig {
  let baseUrl: unknown = GAME_BACKEND[environment];
  if (injected !== undefined) {
    if (!injected || typeof injected !== 'object' || Array.isArray(injected)) throw new Error('游戏服务地址配置无效');
    baseUrl = (injected as { baseUrl?: unknown }).baseUrl;
  }
  if (typeof baseUrl !== 'string' || baseUrl.length > 300) throw new Error('游戏服务地址配置无效');
  const normalized = baseUrl.replace(/\/+$/, '');
  const https = /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9_-]+)*$/i.test(normalized);
  const local = environment === 'test' && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?(?:\/[a-z0-9_-]+)*$/i.test(normalized);
  if (!https && !local) throw new Error('游戏服务需要 HTTPS 地址，本地测试仅允许回环地址');
  return { baseUrl: normalized };
}
