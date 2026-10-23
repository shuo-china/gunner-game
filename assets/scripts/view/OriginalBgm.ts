import { AudioClip, AudioSource, Node, sys } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';

export type OriginalBgmTrack = 'main' | 'contents';
interface OriginalBgmEntry { path: string; sourceClip: string; }
export interface OriginalBgmConfig {
  version: number; volume: number; loop: boolean;
  main: OriginalBgmEntry; contents: OriginalBgmEntry;
}
export interface OriginalBgmAssets {
  config: OriginalBgmConfig;
  clips: Partial<Record<OriginalBgmTrack, AudioClip>>;
  ensureClip?(track: OriginalBgmTrack): Promise<AudioClip>;
}

export async function loadOriginalBgmAssets(art: ArtLibrary, initialTrack?: OriginalBgmTrack): Promise<OriginalBgmAssets> {
  const config = await art.json<OriginalBgmConfig>('art/original-bgm/config');
  if (config.version !== 1 || config.volume !== 1 || config.loop !== true || !config.main?.path || !config.contents?.path) {
    throw new Error('Unsupported original BGM configuration');
  }
  const clips: OriginalBgmAssets['clips'] = {}, requests = new Map<OriginalBgmTrack, Promise<AudioClip>>();
  const ensureClip = (track: OriginalBgmTrack): Promise<AudioClip> => {
    const pending = requests.get(track); if (pending) return pending;
    const request = art.resourceLoader.load(config[track].path, 'audio').then(clip => { clips[track] = clip; return clip; }, error => {
      requests.delete(track); throw error;
    });
    requests.set(track, request); return request;
  };
  await Promise.all((initialTrack ? [initialTrack] : ['main', 'contents'] as OriginalBgmTrack[]).map(ensureClip));
  return { config, clips, ensureClip };
}

/** One looping source, as in Sound_manager. Muting changes volume, never position. */
export class OriginalBgm {
  readonly node: Node;
  private readonly audio: AudioSource;
  private track: OriginalBgmTrack | null = null;
  private paused = false;
  private playing = false;
  private destroyed = false;
  private enabled = true;
  private readonly loadingTracks = new Set<OriginalBgmTrack>();
  private failedTracks = new Set<OriginalBgmTrack>();
  private browserAudioReady = !sys.isBrowser;
  private gestureTarget: Document | null = null;
  private readonly gestureEvents = ['mouseup', 'touchend', 'keydown'] as const;
  private readonly unlockBrowserAudio = (event: Event): void => {
    if (this.destroyed || !event.isTrusted) return;
    this.browserAudioReady = true;
    this.removeGestureListeners();
    this.startIfReady();
  };

  constructor(parent: Node, private readonly assets: OriginalBgmAssets) {
    this.node = makeNode('OriginalBgm', parent);
    this.audio = this.node.addComponent(AudioSource);
    this.audio.playOnAwake = false;
    this.audio.loop = true;
    this.audio.volume = assets.config.volume;
    if (sys.isBrowser) {
      const activation = typeof navigator === 'undefined' ? undefined :
        (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
      this.browserAudioReady = activation?.hasBeenActive === true;
      if (!this.browserAudioReady && typeof document !== 'undefined') {
        this.gestureTarget = document;
        for (const name of this.gestureEvents) document.addEventListener(name, this.unlockBrowserAudio, true);
      }
    }
    // The caller restores preferences and background state before setMode starts playback.
  }

  setMode(mode: string): void {
    if (this.destroyed || !this.node.isValid) return;
    const track: OriginalBgmTrack = mode === 'Main' ? 'main' : 'contents';
    if (track !== this.track) {
      this.track = track; this.playing = false;
      this.audio.clip = this.assets.clips[track] ?? null;
    }
    this.startIfReady();
  }

  setEnabled(enabled: boolean): void {
    if (this.destroyed || !this.node.isValid) return;
    this.enabled = enabled;
    this.audio.volume = enabled ? this.assets.config.volume : 0;
    if (enabled) { this.failedTracks.clear(); this.startIfReady(); }
  }

  setPaused(paused: boolean): void {
    if (this.destroyed || !this.node.isValid || this.paused === paused) return;
    this.paused = paused;
    if (paused && this.playing) {
      this.audio.pause(); this.playing = false;
    } else if (!paused) this.startIfReady();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.removeGestureListeners();
    this.playing = false;
    if (this.node.isValid) { this.audio.stop(); this.node.destroy(); }
  }

  private startIfReady(): void {
    if (this.destroyed || !this.node.isValid || !this.track || this.playing || this.paused || !this.enabled) return;
    if (!this.assets.clips[this.track]) {
      const track = this.track;
      if (this.assets.ensureClip && !this.loadingTracks.has(track) && !this.failedTracks.has(track)) {
        this.loadingTracks.add(track);
        void this.assets.ensureClip(track).then(clip => {
          this.loadingTracks.delete(track);
          if (this.destroyed || !this.node.isValid || this.track !== track) return;
          this.audio.clip = clip; this.startIfReady();
        }, error => {
          this.loadingTracks.delete(track);
          this.failedTracks.add(track);
          if (!this.destroyed) console.warn('[ForestGunner] Music track load failed', error);
        });
      }
      return;
    }
    if (!this.browserAudioReady) return;
    // AudioSource.play resumes a paused source; invoking it on an already playing source restarts it.
    this.playing = true;
    this.audio.play();
  }

  private removeGestureListeners(): void {
    if (!this.gestureTarget) return;
    for (const name of this.gestureEvents) this.gestureTarget.removeEventListener(name, this.unlockBrowserAudio, true);
    this.gestureTarget = null;
  }
}
