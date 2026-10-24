import { GameLoginClient } from './GameLogin';
import type { GameLoginResult } from './GameLogin';
import { resolveGameBackendConfig } from './GameBackendConfig';
import type { GameBackendConfig } from './GameBackendConfig';
import { resolveRuntimeEnvironment } from './RuntimeEnvironment';
import { resolvePlatformConfig } from '../platform/PlatformConfig';
import { createWechatLogin } from '../platform/WechatPlatform';
import type { PlatformLoginBinding } from '../platform/PlatformTypes';

interface EarlyLogin {
  client: GameLoginClient;
  appId: string;
  startedAt: number;
  finishedAt?: number;
  outcome: Promise<{ ok: true; value: GameLoginResult } | { ok: false; error: unknown }>;
}
interface BootScope {
  __FOREST_GUNNER_ENV__?: unknown;
  __FOREST_GUNNER_BACKEND__?: unknown;
  __FOREST_GUNNER_PLATFORM__?: unknown;
  __FOREST_GUNNER_EARLY_LOGIN__?: EarlyLogin;
}

/** Built from the same authentication sources as the scene, without importing cc.
 * Only authentication runs early; cloud reconciliation and rewards stay in Bootstrap. */
export function beginEarlyWechatLogin(scope: BootScope, now: () => number = Date.now): void {
  if (scope.__FOREST_GUNNER_EARLY_LOGIN__) return;
  const environment = resolveRuntimeEnvironment(scope.__FOREST_GUNNER_ENV__, false);
  if (environment !== 'production') return;
  // Invalid configuration must still be reported by the normal startup error UI.
  try {
    const config = resolvePlatformConfig(scope.__FOREST_GUNNER_PLATFORM__, { wechat: true, douyin: false, native: false });
    const backend = resolveGameBackendConfig(scope.__FOREST_GUNNER_BACKEND__, environment);
    const client = new GameLoginClient(createWechatLogin({ config, globals: scope }), backend, now);
    const startedAt = now();
    const entry: EarlyLogin = { client, appId: config.appId, startedAt, outcome: Promise.resolve().then(async () => {
      try { return { ok: true as const, value: await client.login() }; }
      catch (error) { return { ok: false as const, error }; }
      finally { entry.finishedAt = now(); }
    }) };
    scope.__FOREST_GUNNER_EARLY_LOGIN__ = entry;
  } catch { /* Bootstrap owns configuration errors and the retry interface. */ }
}

/** Transfer ownership once. Never reuse authentication across a changed routing/app context. */
export function takeEarlyWechatLogin(scope: BootScope, binding: PlatformLoginBinding, backend: GameBackendConfig): EarlyLogin | undefined {
  const entry = scope.__FOREST_GUNNER_EARLY_LOGIN__;
  delete scope.__FOREST_GUNNER_EARLY_LOGIN__;
  if (!entry) return undefined;
  if (binding.provider.identityProvider !== 'wechat_mini' || binding.provider.appId !== entry.appId
    || backend.baseUrl !== entry.client.backendScope || resolveRuntimeEnvironment(scope.__FOREST_GUNNER_ENV__, false) !== 'production') {
    entry.client.dispose(); return undefined;
  }
  return entry;
}
