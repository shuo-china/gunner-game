import { createBrowserHttpTransport } from './BrowserHttpTransport';
import type { PlatformContext, PlatformLoginBinding } from './PlatformTypes';

export interface TapTapLoginHost {
  login(options: { timeout: number; success(result: { code?: unknown }): void; fail(error: unknown): void }): void;
  getAccountInfoSync?(): { miniProgram?: { appId?: unknown } };
}

/** Only the actual TapTap host may supply this API. This does not load or emulate an SDK.
 * Host availability in the target workshop H5 runtime requires on-device acceptance. */
export function createTapTapH5Login(context: PlatformContext): PlatformLoginBinding {
  const scope = context.globals as { tap?: TapTapLoginHost; window?: { tap?: TapTapLoginHost } };
  const appId = context.config.appId;
  return {
    provider: {
      identityProvider: 'taptap_mini', appId, endpoint: '/auth/taptap',
      acquireCredential(options) {
        // A retry must see a freshly injected SDK and the current platform account.
        const host = scope.tap ?? scope.window?.tap;
        if (!host || typeof host.login !== 'function') { options.fail('TAPTAP_SDK_UNAVAILABLE'); return; }
        let settled = false;
        const fail = (code: string): void => {
          if (settled) return;
          settled = true; options.fail(code);
        };
        try {
          const actualAppId = typeof host.getAccountInfoSync === 'function' ? host.getAccountInfoSync()?.miniProgram?.appId : undefined;
          if (typeof actualAppId === 'string' && actualAppId && actualAppId !== appId) {
            fail('APP_ID_MISMATCH'); return;
          }
          host.login({ timeout: options.timeoutMs, success: result => {
            if (settled) return;
            if (typeof result?.code !== 'string' || !result.code || result.code.length > 256 || /\s/.test(result.code)) {
              fail('TAPTAP_LOGIN_FAILED'); return;
            }
            settled = true;
            options.success({ code: result.code });
          }, fail: error => {
            const message = error && typeof error === 'object' ? (error as { errMsg?: unknown }).errMsg : undefined;
            // Error text is used only to classify known outcomes, never displayed or forwarded.
            fail(typeof message === 'string' && /\bcancel(?:led|ed)?\b/i.test(message) ? 'LOGIN_CANCELLED'
              : typeof message === 'string' && /\btimeout\b|\btimed out\b/i.test(message) ? 'TIMEOUT' : 'TAPTAP_LOGIN_FAILED');
          } });
        } catch { fail('TAPTAP_LOGIN_FAILED'); }
        // tap.login does not document an abort task. Discard late or duplicate callbacks.
        return () => { settled = true; };
      },
    },
    transport: createBrowserHttpTransport(context.globals),
  };
}
