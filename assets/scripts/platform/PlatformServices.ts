import { UnavailableRewardedAdProvider } from '../session/RewardedAds';
import type { RewardedAdProvider } from '../session/RewardedAds';
import { resolvePlatformConfig } from './PlatformConfig';
import { createWechatLogin } from './WechatPlatform';
import { createWechatShare } from './WechatShare';
import type { GameChannel, PlatformBuildTarget, PlatformContext, PlatformLoginBinding, PlatformShareProvider } from './PlatformTypes';

type LoginFactory = (context: PlatformContext) => PlatformLoginBinding;
type AdFactory = (context: PlatformContext) => RewardedAdProvider;
type ShareFactory = (context: PlatformContext) => PlatformShareProvider;

/** Login channels and ad networks are independent registries. Native TapTap can
 * use a native ad SDK without making gameplay or session code depend on either. */
export class PlatformProviderRegistry {
  private readonly logins = new Map<GameChannel, LoginFactory>();
  private readonly ads = new Map<string, AdFactory>();
  private readonly shares = new Map<GameChannel, ShareFactory>();

  registerLogin(channel: GameChannel, factory: LoginFactory): this {
    if (this.logins.has(channel)) throw new Error(`登录适配器重复注册：${channel}`);
    this.logins.set(channel, factory); return this;
  }
  registerAds(provider: string, factory: AdFactory): this {
    if (!provider || this.ads.has(provider)) throw new Error(`广告适配器名称无效或重复：${provider}`);
    this.ads.set(provider, factory); return this;
  }
  registerShare(channel: GameChannel, factory: ShareFactory): this {
    if (this.shares.has(channel)) throw new Error(`分享适配器重复注册：${channel}`);
    this.shares.set(channel, factory); return this;
  }
  createLogin(context: PlatformContext): PlatformLoginBinding {
    const factory = this.logins.get(context.config.channel);
    if (!factory || !context.config.appId) throw new Error(`${context.config.label}登录尚未接入或配置`);
    return factory(context);
  }
  createAds(context: PlatformContext): RewardedAdProvider {
    const factory = this.ads.get(context.config.ads.provider);
    if (!factory) throw new Error('广告平台尚未接入或配置');
    return factory(context);
  }
  createShare(context: PlatformContext): PlatformShareProvider {
    const factory = this.shares.get(context.config.channel);
    if (factory) return factory(context);
    return {
      supported: false,
      share: async () => ({ status: 'unavailable', message: `${context.config.label}分享尚未接入` }),
      destroy: () => {},
    };
  }
}

/** Add real SDK integrations here, or register them before the scene starts.
 * Reserved channels deliberately have no fake login or success implementation. */
export function createDefaultPlatformProviders(): PlatformProviderRegistry {
  return new PlatformProviderRegistry()
    .registerLogin('wechat-mini', createWechatLogin)
    .registerShare('wechat-mini', createWechatShare)
    .registerAds('unavailable', () => new UnavailableRewardedAdProvider());
}
export const platformProviders = createDefaultPlatformProviders();

export function createGamePlatform(globals: object, build: PlatformBuildTarget, providers = platformProviders) {
  const injected = (globals as { __FOREST_GUNNER_PLATFORM__?: unknown }).__FOREST_GUNNER_PLATFORM__;
  const config = resolvePlatformConfig(injected, build);
  const context: PlatformContext = { config, globals };
  return {
    channel: config.channel,
    label: config.label,
    requiresLogin: config.channel !== 'web',
    createLogin: (): PlatformLoginBinding => providers.createLogin(context),
    createRewardedAds: (): RewardedAdProvider => providers.createAds(context),
    createShare: (): PlatformShareProvider => providers.createShare(context),
  };
}
