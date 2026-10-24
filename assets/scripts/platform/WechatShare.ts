import type { PlatformContext, PlatformShareOptions, PlatformShareProvider, PlatformShareResult } from './PlatformTypes';

const DEFAULT_SHARE_TITLE = '三只小狐狸，能闯到第几关？';

export interface WechatShareHost {
  /** The current Mini Game API has no success, fail or complete callback. */
  shareAppMessage(options: PlatformShareOptions): void;
  showShareMenu?(options: { menus: ('shareAppMessage' | 'shareTimeline')[]; fail(error: unknown): void }): void;
  onShareAppMessage?(listener: () => PlatformShareOptions): void;
  offShareAppMessage?(listener: () => PlatformShareOptions): void;
  onShareTimeline?(listener: () => PlatformShareOptions): void;
  offShareTimeline?(listener: () => PlatformShareOptions): void;
}
export interface WechatShareTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}
const DEFAULT_TIMER: WechatShareTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
interface PendingShare {
  hidden: boolean;
  timer: unknown | null;
  resolve(result: PlatformShareResult): void;
}

/** WeChat only exposes opening the share sheet and returning to the game.
 * The Cocos lifecycle owner forwards hide/show; this adapter never claims that
 * either event confirms delivery and never registers a second lifecycle listener.
 * https://developers.weixin.qq.com/minigame/dev/api/share/wx.shareAppMessage.html */
class WechatShareProvider implements PlatformShareProvider {
  readonly supported: boolean;
  private pending?: PendingShare;
  private backgrounded = false;
  private destroyed = false;
  // Use the selected share title and WeChat's default card images. Menu sharing is
  // independent of an in-game share request and must not start reward settlement.
  private readonly menuAppMessage = (): PlatformShareOptions => ({ title: DEFAULT_SHARE_TITLE });
  private readonly menuTimeline = (): PlatformShareOptions => ({ title: DEFAULT_SHARE_TITLE });

  constructor(private readonly host: WechatShareHost | undefined, private readonly timer: WechatShareTimer,
    private readonly openTimeoutMs: number) {
    this.supported = typeof host?.shareAppMessage === 'function';
    if (this.supported) {
      try { host?.onShareAppMessage?.(this.menuAppMessage); }
      catch (error) { console.warn('[WechatShare] Friend share registration failed', error); }
      try { host?.onShareTimeline?.(this.menuTimeline); }
      catch (error) { console.warn('[WechatShare] Timeline share registration failed', error); }
      this.showMenu();
    }
  }

  share(options: PlatformShareOptions = {}): Promise<PlatformShareResult> {
    if (this.destroyed) return Promise.resolve({ status: 'cancelled', message: '分享已取消' });
    if (!this.supported) return Promise.resolve({ status: 'unavailable', message: '微信分享接口不可用' });
    if (this.pending) return Promise.resolve({ status: 'failed', message: '分享正在进行中，请稍候' });
    if (this.backgrounded) return Promise.resolve({ status: 'failed', message: '请返回游戏后重试分享' });
    return new Promise(resolve => {
      const pending: PendingShare = { hidden: false, timer: null, resolve };
      this.pending = pending;
      // Copy only documented card fields; callbacks and gameplay state never
      // cross into wx even if a caller supplies additional runtime properties.
      try {
        // A missing hide event must not leave the entry permanently busy. This
        // timeout only fails opening; it never proves success or limits sharing
        // time after the game has actually entered the background.
        pending.timer = this.timer.set(() => {
          if (!pending.hidden) this.finish(pending, { status: 'failed', message: '分享未完成，请重试' });
        }, this.openTimeoutMs);
        if (this.pending !== pending) { this.clearTimer(pending); return; }
        const card: PlatformShareOptions = {
          title: options.title ?? DEFAULT_SHARE_TITLE,
          ...(options.imageUrl === undefined ? {} : { imageUrl: options.imageUrl }),
          ...(options.query === undefined ? {} : { query: options.query }),
        };
        this.host!.shareAppMessage(card);
      }
      catch { this.finish(pending, { status: 'failed', message: '分享未完成，请重试' }); }
    });
  }

  onHide(): void {
    if (this.destroyed) return;
    this.backgrounded = true;
    if (this.pending) { this.pending.hidden = true; this.clearTimer(this.pending); }
  }

  onShow(): void {
    if (this.destroyed) return;
    this.backgrounded = false;
    this.showMenu();
    const pending = this.pending;
    if (pending?.hidden) this.finish(pending, { status: 'unverified' });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pending) this.finish(this.pending, { status: 'cancelled', message: '分享已取消' });
    if (this.supported) {
      try { this.host?.offShareAppMessage?.(this.menuAppMessage); }
      catch (error) { console.warn('[WechatShare] Friend share cleanup failed', error); }
      try { this.host?.offShareTimeline?.(this.menuTimeline); }
      catch (error) { console.warn('[WechatShare] Timeline share cleanup failed', error); }
    }
  }

  private showMenu(): void {
    if (!this.supported) return;
    try {
      this.host?.showShareMenu?.({
        menus: ['shareAppMessage', 'shareTimeline'],
        fail: error => console.warn('[WechatShare] Share menu could not be enabled', error),
      });
    }
    catch (error) { console.warn('[WechatShare] Share menu could not be enabled', error); }
  }

  private finish(pending: PendingShare, result: PlatformShareResult): void {
    if (this.pending !== pending) return;
    this.pending = undefined;
    this.clearTimer(pending);
    pending.resolve(result);
  }

  private clearTimer(pending: PendingShare): void {
    const handle = pending.timer;
    pending.timer = null;
    if (handle !== null) { try { this.timer.clear(handle); } catch {} }
  }
}

export function createWechatShare(context: PlatformContext, timer: WechatShareTimer = DEFAULT_TIMER,
  openTimeoutMs = 30000): PlatformShareProvider {
  const scope = context.globals as { wx?: WechatShareHost; window?: { wx?: WechatShareHost } };
  return new WechatShareProvider(scope.wx ?? scope.window?.wx, timer, openTimeoutMs);
}
