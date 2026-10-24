import type { PlatformContext, PlatformHttpTransport, PlatformLoginBinding } from './PlatformTypes';

export interface WechatLoginHost extends PlatformHttpTransport {
  login(options: { timeout: number; success(result: { code?: string }): void; fail(error: unknown): void }): void;
  getAccountInfoSync?(): { miniProgram?: { appId?: string } };
}

/** The only login adapter that knows wx.login / wx.request. */
export function createWechatLogin(context: PlatformContext): PlatformLoginBinding {
  const scope = context.globals as { wx?: WechatLoginHost; window?: { wx?: WechatLoginHost } };
  const host = scope.wx ?? scope.window?.wx;
  if (!host || typeof host.login !== 'function' || typeof host.request !== 'function') throw new Error('微信登录接口不可用');
  const appId = context.config.appId;
  return {
    provider: {
      identityProvider: 'wechat_mini', appId, endpoint: '/auth/wechat',
      acquireCredential(options) {
        const actualAppId = host.getAccountInfoSync?.().miniProgram?.appId;
        if (actualAppId && actualAppId !== appId) { options.fail('APP_ID_MISMATCH'); return; }
        host.login({ timeout: options.timeoutMs, success: data => {
          if (typeof data?.code !== 'string' || !data.code || data.code.length > 256 || /\s/.test(data.code)) {
            options.fail('WECHAT_LOGIN_FAILED'); return;
          }
          options.success({ code: data.code });
        }, fail: () => options.fail('WECHAT_LOGIN_FAILED') });
      },
    },
    transport: { request: options => host.request(options) },
  };
}
