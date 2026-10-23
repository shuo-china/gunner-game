import { BackgroundResourceQueue } from './BackgroundResourceQueue';
import { BACKGROUND_FEATURES, RESOURCE_MODULE_ORDER, backgroundConfigs, collectBackgroundResources, isAutomaticModule } from './FeatureResourceManifest';
import type { BackgroundConfig, BackgroundFeature, BackgroundResource } from './FeatureResourceManifest';
import type { GameResourceLoader } from './GameResourceLoader';
import { RESOURCE_LOADING_POLICY } from './ResourceLoadingPolicy';
import type { BackgroundPreparationMode } from './ResourceLoadingPolicy';

interface UsageStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }

/** Downloads the catalog, and gradually parses eligible panels into the shared
 * engine cache. HUD construction and gameplay readiness remain the caller's job. */
export class GameResourcePreloader {
  private readonly queue: BackgroundResourceQueue;
  private readonly preparation: BackgroundResourceQueue;
  private readonly discovered = new Set<BackgroundFeature>();
  private readonly ready = new Set<BackgroundFeature>();
  private readonly eligible = new Set<BackgroundFeature>();
  private disposed = false;
  private readonly uses = new Map<BackgroundFeature, number>();
  private readonly demanded = new Set<BackgroundFeature>();
  private readonly upcoming = new Set<BackgroundFeature>();
  private readonly promoted = new Set<BackgroundFeature>();
  private readonly resourcesByFeature = new Map<BackgroundFeature, BackgroundResource[]>();
  private readonly suspended = new Set<BackgroundFeature>();
  private preparationMode = RESOURCE_LOADING_POLICY.preparationMode;

  constructor(private readonly resourceLoader: GameResourceLoader, now: () => number = Date.now,
    private readonly usageStorage?: UsageStorage, private readonly usageKey = 'forest-gunner-feature-usage-v1') {
    try {
      const saved = JSON.parse(usageStorage?.getItem(usageKey) || '{}');
      for (const name of BACKGROUND_FEATURES) {
        const count = saved?.[name];
        if (Number.isInteger(count) && count > 0) this.uses.set(name, Math.min(count, RESOURCE_LOADING_POLICY.background.priorities.maxUseCount));
      }
    } catch { /* Scheduling preferences must never prevent startup. */ }
    this.queue = new BackgroundResourceQueue(now);
    this.preparation = new BackgroundResourceQueue(now, RESOURCE_LOADING_POLICY.background.preparationConcurrency);
    for (const name of BACKGROUND_FEATURES) this.preparation.setPriority(name, null);
    this.queue.setPriority('bgm', null); this.queue.setPriority('sfx', null);
    this.queue.setPriority('maps', RESOURCE_LOADING_POLICY.background.priorities.maps);
    this.queue.setPriority('nextStage', RESOURCE_LOADING_POLICY.background.priorities.nextStage);
    this.preparation.setPriority('nextStage', RESOURCE_LOADING_POLICY.background.priorities.nextStage);
    for (const item of backgroundConfigs()) {
      if (BACKGROUND_FEATURES.includes(item.group as BackgroundFeature) && /^art\/[^/]+-system\/config$/.test(item.path)) this.preparePanel(item);
      this.queue.enqueue(`json:${item.path}`, item.group, async () => {
        // Visuals outside eligible panels stay download-only to limit memory.
        const config = await this.resourceLoader.loadJson(item.path, 'background');
        if (this.disposed) return;
        for (const resource of collectBackgroundResources(config, item.group)) {
          this.queue.enqueue(`${resource.kind}:${resource.path}`, item.group, () => this.download(resource), item.offset);
        }
      }, item.offset);
    }
  }

  private preparePanel(item: BackgroundConfig): void {
    const name = item.group as BackgroundFeature;
    this.preparation.enqueue(`json:${item.path}`, name, async () => {
      const config = await this.resourceLoader.loadJson(item.path, 'background');
      if (this.disposed) return;
      const resources = collectBackgroundResources(config, name);
      this.resourcesByFeature.set(name, resources);
      for (const resource of resources) {
        if (resource.kind !== 'spriteFrame') continue;
        this.preparation.enqueue(`spriteFrame:${resource.path}`, name, async () => {
          // Actual load resolves native dependencies and image decoding. Do not
          // separately instantiate the ImageAsset, nor start the whole panel in
          // Promise.all: the preparation queue admits one resource per frame.
          await this.resourceLoader.load(resource.path, 'spriteFrame', 'background');
        });
      }
      this.discovered.add(name);
    });
  }

  private download(resource: BackgroundResource): Promise<void> {
    // Startup's atlas-backed forest borders have no standalone ImageAsset path
    // in a build. A loaded SpriteFrame already owns its downloaded texture;
    // don't request its original (possibly stripped) source image again.
    if (resource.kind === 'image' && this.resourceLoader.hasLoaded(`${resource.path}/spriteFrame`, 'spriteFrame')) return Promise.resolve();
    return this.resourceLoader.preload(resource.path, resource.kind);
  }

  start(duringStartup = false): void {
    this.queue.start(duringStartup ? 0 : RESOURCE_LOADING_POLICY.background.startDelayMs);
    this.preparation.start(RESOURCE_LOADING_POLICY.background.preparationStartDelayMs);
  }

  /** Fetch the first required panels during core boot, then the next required
   * panels while the current panel loads/builds. This
   * shares the runtime download cache and two-worker queue, never admits image
   * decoding or UI construction, and dispatches only from visible game frames.
   * Failed speculation is optional: the real panel loader still owns retries. */
  updateStartupDownloads(required: readonly BackgroundFeature[], current?: BackgroundFeature): void {
    if (this.disposed) return;
    const index = current === undefined ? -1 : required.indexOf(current);
    const next = current !== undefined && index < 0 ? [] : required.slice(index + 1, index + 1 + RESOURCE_LOADING_POLICY.startup.prefetchPanels);
    for (const name of BACKGROUND_FEATURES) {
      const order = next.indexOf(name);
      this.queue.setPriority(name, order < 0 ? null : RESOURCE_LOADING_POLICY.background.priorities.unlocked + next.length - order);
    }
    for (const group of ['maps', 'nextStage', 'bgm', 'sfx']) this.queue.setPriority(group, null);
    this.queue.tick(RESOURCE_LOADING_POLICY.background.maxConcurrency);
  }
  get mode(): BackgroundPreparationMode { return this.preparationMode; }
  setMode(mode: BackgroundPreparationMode): void {
    if (!this.disposed && ['download-only', 'decode', 'full'].includes(mode)) this.preparationMode = mode;
  }
  /** Automatic summaries are prepared only while the caller actually needs
   * them. A user-requested panel remains eligible until its work completes. */
  setDemand(name: BackgroundFeature, value: boolean): void {
    if (this.disposed) return;
    if (value) { this.demanded.add(name); this.suspended.delete(name); } else this.demanded.delete(name);
  }
  setUpcoming(name: BackgroundFeature, value: boolean): void {
    if (this.disposed) return;
    if (value) this.upcoming.add(name); else this.upcoming.delete(name);
  }
  prepareBattle(paths: readonly string[], loadFrame: (path: string) => Promise<unknown>): void {
    if (this.disposed) return;
    for (const path of Array.from(new Set(paths))) {
      // These share the bulk catalog's download ids. The download-only mode
      // still warms the next map without creating textures or updating readiness.
      for (const resource of [{ path, kind: 'image' }, { path: `${path}/spriteFrame`, kind: 'spriteFrame' }] as BackgroundResource[]) {
        this.queue.enqueue(`${resource.kind}:${resource.path}`, 'nextStage', () => this.download(resource));
      }
      this.preparation.enqueue(`battle:${path}`, 'nextStage', async () => { await loadFrame(path); });
    }
  }
  private refreshPriorities(unlocked: (name: BackgroundFeature) => boolean): void {
    const priorities = RESOURCE_LOADING_POLICY.background.priorities;
    // Startup temporarily restricts this same queue to its lookahead window.
    this.queue.setPriority('maps', priorities.maps);
    this.queue.setPriority('nextStage', priorities.nextStage);
    for (const name of BACKGROUND_FEATURES) {
      const available = !this.suspended.has(name) && isAutomaticModule(name, unlocked(name));
      const near = this.upcoming.has(name) && !this.suspended.has(name);
      const requested = this.demanded.has(name) || this.promoted.has(name);
      const prepare = requested || (this.preparationMode !== 'download-only' && (available || near));
      // Keep weapons, then challenge ahead of ordinary panels even when a
      // returning player used those panels often. Explicit requests still win.
      const earlyPanel = name === 'weapons' || name === 'speedrun';
      const priority = (available || requested ? priorities.unlocked : priorities.locked) + RESOURCE_MODULE_ORDER.length - RESOURCE_MODULE_ORDER.indexOf(name)
        + (name === 'weapons' ? priorities.weaponsBonus : 0)
        + (earlyPanel ? priorities.commonBonus : (this.uses.get(name) ?? 0) * priorities.usedBonus)
        + (this.demanded.has(name) ? priorities.promoted : 0);
      this.queue.setPriority(name, available || requested || near ? priority : null);
      this.preparation.setPriority(name, prepare ? priority : null);
      if (prepare) this.eligible.add(name); else this.eligible.delete(name);
    }
    this.preparation.setPriority('nextStage', this.preparationMode === 'download-only' ? null : priorities.nextStage);
  }

  /** Network/cache warming is driven even on busy gameplay frames. It never
   * starts UI construction or a SpriteFrame load/decode. */
  updateDownloads(unlocked: (name: BackgroundFeature) => boolean, bgmEnabled: boolean, soundEnabled: boolean): void {
    if (this.disposed) return;
    this.refreshPriorities(unlocked);
    this.queue.setPriority('bgm', bgmEnabled ? RESOURCE_LOADING_POLICY.background.priorities.audio : null);
    this.queue.setPriority('sfx', soundEnabled ? RESOURCE_LOADING_POLICY.background.priorities.audio : null);
    this.queue.tick(1);
  }

  /** Call only after admitting one bounded CPU preparation slice. */
  updatePreparation(unlocked: (name: BackgroundFeature) => boolean): void {
    if (this.disposed) return;
    this.refreshPriorities(unlocked); this.preparation.tick(1);
  }

  update(unlocked: (name: BackgroundFeature) => boolean, bgmEnabled: boolean, soundEnabled: boolean): void {
    if (this.disposed) return;
    this.refreshPriorities(unlocked);
    this.queue.setPriority('bgm', bgmEnabled ? RESOURCE_LOADING_POLICY.background.priorities.audio : null);
    this.queue.setPriority('sfx', soundEnabled ? RESOURCE_LOADING_POLICY.background.priorities.audio : null);
    // Parsing and bulk prefetch share one admission. In particular, warm-cache
    // completions cannot refill both queues in the same game frame.
    if (this.preparation.tick(1) === 0) this.queue.tick(1);
  }
  isFeatureReady(name: BackgroundFeature): boolean {
    if (this.disposed || !this.discovered.has(name)) return false;
    if (this.ready.has(name)) return true;
    const state = this.preparation.snapshot(name);
    if (state.total > 0 && state.completed === state.total) this.ready.add(name);
    return this.ready.has(name);
  }
  prioritize(name: BackgroundFeature): void {
    if (this.disposed) return;
    this.suspended.delete(name);
    this.promoted.add(name); this.queue.prioritize(name); this.preparation.prioritize(name);
  }
  recordUse(name: BackgroundFeature): void {
    if (this.disposed || !BACKGROUND_FEATURES.includes(name)) return;
    this.uses.set(name, Math.min((this.uses.get(name) ?? 0) + 1, RESOURCE_LOADING_POLICY.background.priorities.maxUseCount));
    try { this.usageStorage?.setItem(this.usageKey, JSON.stringify(this.usageSnapshot())); }
    catch { /* Storage can be unavailable without affecting the panel. */ }
  }
  pause(): void { this.queue.pause(); this.preparation.pause(); }
  /** Caller releases the corresponding idle view and its ArtLibrary references
   * first. Disk downloads remain reusable; decoded readiness must be rebuilt. */
  invalidate(name: BackgroundFeature): void {
    this.suspended.add(name); this.promoted.delete(name); this.demanded.delete(name);
    this.queue.clearPriorityBoost(name); this.preparation.clearPriorityBoost(name);
    this.ready.clear(); this.discovered.delete(name);
    this.preparation.invalidateGroup(name);
    for (const resource of this.resourcesByFeature.get(name) ?? []) {
      if (resource.kind === 'spriteFrame') this.resourceLoader.invalidate(resource.path, resource.kind);
    }
  }
  private usageSnapshot(): Partial<Record<BackgroundFeature, number>> {
    const result: Partial<Record<BackgroundFeature, number>> = {};
    this.uses.forEach((count, name) => { result[name] = count; }); return result;
  }
  resume(): void { this.queue.resume(); this.preparation.resume(); }
  snapshot() {
    const features = {} as Record<BackgroundFeature, ReturnType<BackgroundResourceQueue['snapshot']> & {
      eligible: boolean; ready: boolean; decodedReady: boolean; downloadReady: boolean; resourcesAcquired: boolean;
      downloads: ReturnType<BackgroundResourceQueue['snapshot']> }>;
    for (const name of BACKGROUND_FEATURES) {
      const downloads=this.queue.snapshot(name),ready=this.isFeatureReady(name);
      const downloadReady=downloads.total>0&&downloads.completed===downloads.total;
      features[name]={...this.preparation.snapshot(name),downloads,eligible:this.eligible.has(name),ready,
        decodedReady:ready,downloadReady,resourcesAcquired:downloadReady||ready};
    }
    return { ...this.queue.snapshot(), mode: this.mode, preparation: this.preparation.snapshot(),
      battle: this.preparation.snapshot('nextStage'), features, usedFeatures: this.usageSnapshot() };
  }
  dispose(): void { this.disposed = true; this.queue.dispose(); this.preparation.dispose(); this.discovered.clear(); this.ready.clear(); this.eligible.clear(); this.demanded.clear(); this.upcoming.clear(); this.promoted.clear(); this.resourcesByFeature.clear(); this.suspended.clear(); }
}
