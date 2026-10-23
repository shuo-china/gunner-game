import { AudioClip, AudioSource, Node, sys } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';

export interface OriginalSfxEntry { id: number; path: string; volume: number; sourceClip: string; }
export interface OriginalSfxConfig {
  version: number; source: string; blockSameFrameDuplicate: boolean; blockCooldownDuplicate: boolean;
  cooldownSeconds: number; sourceVolume: number; sourcePitch: number; entries: OriginalSfxEntry[];
}
export interface OriginalSfxAssets { config: OriginalSfxConfig; clips: ReadonlyMap<number, AudioClip>; ensureClip?(id: number): Promise<AudioClip | undefined>; }

export async function loadOriginalSfxAssets(art: ArtLibrary, initialIds?: readonly number[]): Promise<OriginalSfxAssets> {
  const config = await art.json<OriginalSfxConfig>('art/original-sfx/config');
  if (config.version !== 1 || config.sourcePitch !== 1) throw new Error('Unsupported original SFX configuration');
  const paths = new Map<string, Promise<AudioClip>>();
  const clips = new Map<number, AudioClip>();
  const ensureClip = async (id: number): Promise<AudioClip | undefined> => {
    const entry = config.entries.find(entry => entry.id === id);
    if (!entry) return;
    let request = paths.get(entry.path);
    if (!request) {
      request = art.resourceLoader.load(entry.path, 'audio')
        .catch(error => { paths.delete(entry.path); throw error; });
      paths.set(entry.path, request);
    }
    const clip = await request; clips.set(entry.id, clip); return clip;
  };
  await Promise.all((initialIds ?? config.entries.map(entry => entry.id)).map(ensureClip));
  return { config, clips, ensureClip };
}

/** One Sound_manager for both combat and UI. Deduplication keys are source
 * SFX enum IDs, even when two IDs refer to the same underlying AudioClip. */
export class OriginalSfx {
  readonly node: Node;
  private readonly audio: AudioSource;
  private readonly entries = new Map<number, OriginalSfxEntry>();
  private readonly lastFrames = new Map<number, number>();
  private readonly lastTimes = new Map<number, number>();
  private frame = 0;
  private elapsed = 0;
  private enabled = true;
  private destroyed = false;
  private readonly downloads = new Map<number, Promise<void>>();
  private readonly retryAt = new Map<number, number>();
  private browserAudioReady = !sys.isBrowser;
  private gestureTarget: Document | null = null;
  private readonly gestureEvents = ['mouseup', 'touchend', 'keydown'] as const;
  private readonly unlockBrowserAudio = (event: Event): void => {
    if (this.destroyed || !event.isTrusted) return;
    this.browserAudioReady = true;
    this.removeGestureListeners();
  };

  constructor(parent: Node, private readonly assets: OriginalSfxAssets) {
    this.node = makeNode('OriginalSfx', parent);
    this.audio = this.node.addComponent(AudioSource);
    this.audio.playOnAwake = false;
    this.audio.loop = false;
    this.audio.volume = assets.config.sourceVolume;
    for (const entry of assets.config.entries) this.entries.set(entry.id, entry);
    // The recovered AudioSource and all these callers use pitch=1, which is
    // Cocos's native playback rate; no lossy pitch-resampled clips are needed.
    if (sys.isBrowser) {
      const activation = typeof navigator === 'undefined' ? undefined :
        (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
      this.browserAudioReady = activation?.hasBeenActive === true;
      if (!this.browserAudioReady && typeof document !== 'undefined') {
        this.gestureTarget = document;
        // Capture runs before Cocos's button handler, so its first real click
        // can sound. Historical battle shots are dropped, never replayed.
        for (const name of this.gestureEvents) document.addEventListener(name, this.unlockBrowserAudio, true);
      }
    }
  }

  /** Called once per rendered frame, including paused/open-popup frames. */
  update(unscaledDelta: number): void {
    if (this.destroyed) return;
    this.frame++;
    if (Number.isFinite(unscaledDelta) && unscaledDelta > 0) this.elapsed += unscaledDelta;
  }

  /** Source Sound_manager checks mute before starting a one-shot; existing tails continue. */
  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  preload(ids: readonly number[]): Promise<void> {
    if (!this.enabled || this.destroyed) return Promise.resolve();
    return Promise.all(ids.map(id => {
      if (this.assets.clips.has(id) || !this.assets.ensureClip || Date.now() < (this.retryAt.get(id) ?? 0)) return;
      const pending = this.downloads.get(id); if (pending) return pending;
      const request = this.assets.ensureClip(id).then(() => {}, error => {
        this.retryAt.set(id, Date.now() + 10000);
        if (!this.destroyed) console.warn(`[ForestGunner] Sound ${id} load failed`, error);
      }).then(() => { this.downloads.delete(id); });
      this.downloads.set(id, request); return request;
    })).then(() => {});
  }

  play(id: number): void {
    if (this.destroyed || !this.node.isValid || !this.enabled || !this.browserAudioReady) return;
    // Creator 3.8.8 OneShotAudioWeb starts before runContext resolves. A voice
    // evicted at the 24-channel limit releases its buffer, but its pending
    // unlock callback still schedules a second release. Do not accumulate
    // inaudible one-shots while the browser is waiting for its first gesture.
    const entry = this.entries.get(id), clip = this.assets.clips.get(id);
    if (!entry) return;
    // Never replay an old shot after a delayed download; the next live event uses it.
    if (!clip) { void this.preload([id]); return; }
    const config = this.assets.config;
    if (config.blockSameFrameDuplicate) {
      if (this.lastFrames.get(id) === this.frame) return;
      // Sound_manager records the frame BEFORE checking the cooldown.
      this.lastFrames.set(id, this.frame);
    }
    if (config.blockCooldownDuplicate) {
      const time = Math.fround(this.elapsed), previous = this.lastTimes.get(id);
      if (previous !== undefined && Math.fround(time - previous) < config.cooldownSeconds) return;
      this.lastTimes.set(id, time);
    }
    this.audio.playOneShot(clip, entry.volume);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.removeGestureListeners();
    this.lastFrames.clear(); this.lastTimes.clear();
    if (this.node.isValid) this.node.destroy();
  }

  private removeGestureListeners(): void {
    if (!this.gestureTarget) return;
    for (const name of this.gestureEvents) this.gestureTarget.removeEventListener(name, this.unlockBrowserAudio, true);
    this.gestureTarget = null;
  }
}
