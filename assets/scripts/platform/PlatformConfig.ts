import type { GameChannel, PlatformBuildTarget, PlatformChannelConfig } from './PlatformTypes';

/** Public channel settings only. Ad enablement stays in session/ContentConfig.ts.
 * Register an SDK provider before changing ads.provider; unit IDs are per channel. */
export const PLATFORM_CHANNELS: Readonly<Record<GameChannel, PlatformChannelConfig>> = {
  'web': { channel: 'web', label: '浏览器', appId: '', ads: { provider: 'unavailable', unitIds: {} } },
  'wechat-mini': { channel: 'wechat-mini', label: '微信', appId: 'wx3dd63318911f5012',
    ads: { provider: 'unavailable', unitIds: {} } },
  'douyin-mini': { channel: 'douyin-mini', label: '抖音', appId: '', ads: { provider: 'unavailable', unitIds: {} } },
  'taptap-mini': { channel: 'taptap-mini', label: 'TapTap 小游戏', appId: '', ads: { provider: 'unavailable', unitIds: {} } },
  'taptap-android': { channel: 'taptap-android', label: 'TapTap 安卓', appId: '', ads: { provider: 'unavailable', unitIds: {} } },
};

/** Build flags take priority over incidental SDK globals (some hosts expose wx shims).
 * An unknown/native build must not silently enter the browser's local-only flow. */
export function resolvePlatformConfig(injected: unknown, build: PlatformBuildTarget): PlatformChannelConfig {
  let requested: GameChannel | undefined;
  if (injected !== undefined) {
    if (!injected || typeof injected !== 'object' || Array.isArray(injected)) throw new Error('游戏平台配置无效');
    const channel = (injected as { channel?: unknown }).channel;
    if (typeof channel !== 'string' || !Object.prototype.hasOwnProperty.call(PLATFORM_CHANNELS, channel)) {
      throw new Error('游戏平台配置无效');
    }
    requested = channel as GameChannel;
  }
  const forced = build.wechat ? 'wechat-mini' : build.douyin ? 'douyin-mini' : undefined;
  if (build.wechat && build.douyin) throw new Error('游戏平台构建配置冲突');
  if (forced && (build.native || (requested && requested !== forced))) throw new Error('游戏平台与构建目标不匹配');
  if (build.native && requested !== 'taptap-android') throw new Error('请配置安卓发行渠道');
  if (!build.native && requested === 'taptap-android') throw new Error('TapTap 安卓渠道需要原生构建');
  const channel = forced ?? requested ?? 'web';
  const profile = PLATFORM_CHANNELS[channel];
  return { ...profile, ads: { ...profile.ads, unitIds: { ...profile.ads.unitIds } } };
}
