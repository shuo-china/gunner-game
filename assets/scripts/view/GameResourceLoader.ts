import { Asset, assetManager, AudioClip, EffectAsset, ImageAsset, JsonAsset, resources, SpriteFrame } from 'cc';
import { RESOURCE_LOADING_POLICY } from './ResourceLoadingPolicy';

export type ResourceProfile = 'foreground' | 'background';
export interface ResourceAssets { spriteFrame: SpriteFrame; image: ImageAsset; audio: AudioClip; effect: EffectAsset; }
export type ResourceKind = keyof ResourceAssets;
export interface ResourceLoadingStatus {
  completed: number;
  pending: { path: string; elapsedMs: number; preload: boolean }[];
  failure?: { path: string; reason: string };
}
type AssetType<Value extends Asset> = new (...args: any[]) => Value;

const TYPES: { [Kind in ResourceKind]: AssetType<ResourceAssets[Kind]> } = {
  spriteFrame: SpriteFrame, image: ImageAsset, audio: AudioClip, effect: EffectAsset,
};

export class GameResourceLoader {
  private readonly timing = installResourceTiming(assetManager,
    (globalThis as typeof globalThis & { wx?: { downloadFile?: Function } }).wx);
  private readonly loads = new Map<string, Promise<unknown>>();
  private readonly preloads = new Map<string, Promise<unknown>>();
  private readonly loaded = new Map<string, Asset>();
  private readonly generations = new Map<string, number>();
  private startupPhase = false;
  private readonly activeLoads = new Set<{ path: string; startedAt: number; preload: boolean }>();
  private completedLoads = 0;
  private lastFailure?: { key: string; path: string; reason: string };

  constructor(private readonly backgroundTimeoutMs: number = RESOURCE_LOADING_POLICY.background.requestTimeoutMs) {}
  setStartupPhase(active: boolean): void { this.startupPhase = active; }

  load<Kind extends ResourceKind>(path: string, kind: Kind, profile: ResourceProfile = 'foreground'): Promise<ResourceAssets[Kind]> {
    const key = this.key(path, kind);
    const cached = this.loaded.get(key);
    if (cached && cached.isValid === false) this.invalidate(path, kind);
    const generation = this.generations.get(key) ?? 0;
    return this.remember(this.loads, key, path, () => this.request(path, TYPES[kind], profile).then(asset => {
      if ((this.generations.get(key) ?? 0) === generation) this.loaded.set(key, asset);
      return asset;
    }));
  }

  loadJson<Value = unknown>(path: string, profile: ResourceProfile = 'foreground'): Promise<Value> {
    return this.remember(this.loads, this.key(path, 'json'), path, () => this.request(path, JsonAsset, profile).then(asset => {
      if (asset.json === null || asset.json === undefined) throw new Error('Empty JSON asset');
      return asset.json as Value;
    }));
  }

  preload(path: string, kind: ResourceKind): Promise<void> {
    if (this.hasLoaded(path, kind)) return Promise.resolve();
    return this.remember(this.preloads, this.key(path, kind), path, () => this.withTimeout<void>('background', complete => {
      assetManager.preloadAny({ path, type: TYPES[kind], bundle: 'resources' }, this.prefetchOptions(),
        (error: Error | null) => complete(error, undefined));
    }));
  }

  hasLoaded<Kind extends ResourceKind>(path: string, kind: Kind): boolean {
    const asset = this.loaded.get(this.key(path, kind)) ?? resources.get(path, TYPES[kind]);
    return !!asset && asset.isValid !== false;
  }

  /** Drop JS cache ownership after an idle view is evicted. This does not
   * delete persistent WeChat files or release assets still owned by gameplay.
   * A late request may resolve for its old caller but cannot repopulate cache. */
  invalidate(path?: string, kind?: ResourceKind | 'json'): void {
    const keys = new Set<string>();
    this.loads.forEach((_, key) => keys.add(key)); this.preloads.forEach((_, key) => keys.add(key));
    this.loaded.forEach((_, key) => keys.add(key));
    if (path !== undefined && kind !== undefined) keys.add(this.key(path, kind));
    for (const key of Array.from(keys)) {
      if (path !== undefined && (kind !== undefined ? key !== this.key(path, kind) : !key.endsWith(`:${path}`))) continue;
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      this.loads.delete(key); this.preloads.delete(key); this.loaded.delete(key);
    }
  }

  diagnostics() { return this.timing.snapshot(); }

  /** Lightweight live request state: no cache-file probes or engine changes. */
  loadingStatus(now = Date.now()): ResourceLoadingStatus {
    return {
      completed: this.completedLoads,
      pending: Array.from(this.activeLoads, item => ({ path: item.path, preload: item.preload,
        elapsedMs: Math.max(0, now - item.startedAt) })),
      failure: this.lastFailure ? { path: this.lastFailure.path, reason: this.lastFailure.reason } : undefined,
    };
  }

  private key(path: string, kind: ResourceKind | 'json'): string { return `resources:${kind}:${path}`; }

  private remember<Value>(cache: Map<string, Promise<unknown>>, key: string, path: string, run: () => Promise<Value>): Promise<Value> {
    const pending = cache.get(key);
    if (pending) return pending as Promise<Value>;
    const operation = { path, startedAt: Date.now(), preload: cache === this.preloads };
    this.activeLoads.add(operation);
    if (this.lastFailure?.key === key) this.lastFailure = undefined;
    const request = run().then(value => {
      this.activeLoads.delete(operation);
      if (!operation.preload) this.completedLoads++;
      return value;
    }, error => {
      this.activeLoads.delete(operation);
      const reason = error instanceof Error ? error.message : String(error);
      if (cache.get(key) === request) this.lastFailure = { key, path, reason };
      if (cache.get(key) === request) cache.delete(key);
      throw new Error(`${path}: ${reason}`);
    });
    cache.set(key, request);
    return request;
  }

  private request<Value extends Asset>(path: string, type: AssetType<Value>, profile: ResourceProfile): Promise<Value> {
    return this.withTimeout<Value>(profile, complete => {
      const loaded = (error: Error | null, asset: Value): void => complete(error || (!asset ? new Error('Empty asset') : null), asset);
      if (profile === 'background') {
        assetManager.loadAny({ path, type, bundle: 'resources' }, this.prefetchOptions(), loaded);
      } else resources.load(path, type, loaded);
    });
  }

  private prefetchOptions() {
    if (!this.startupPhase) return { ...RESOURCE_LOADING_POLICY.background.engine };
    const policy = RESOURCE_LOADING_POLICY.startup.engine;
    // Match the active platform's foreground limits (WeChat is configured to
    // 6/6). A smaller per-request cap can throttle Cocos' entire shared queue.
    return { ...policy, maxConcurrency: assetManager.downloader?.maxConcurrency ?? policy.maxConcurrency,
      maxRequestsPerFrame: assetManager.downloader?.maxRequestsPerFrame ?? policy.maxRequestsPerFrame };
  }

  private withTimeout<Value>(profile: ResourceProfile, run: (complete: (error: Error | null, value: Value) => void) => void): Promise<Value> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = profile === 'background' || this.startupPhase ? setTimeout(() => {
        settled = true; reject(new Error(`${profile === 'background' ? 'Background' : 'Startup'} resource request timed out`));
      }, this.backgroundTimeoutMs) : undefined;
      const complete = (error: Error | null, asset: Value): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (error) reject(error);
        else resolve(asset);
      };
      try { run(complete); }
      catch (error) { complete(error instanceof Error ? error : new Error(String(error)), undefined as Value); }
    });
  }
}

type PlatformTimingPhase = 'platformSubpackage' | 'metadataRead' | 'metadataInflate' | 'metadataParse' | 'metadataHydrate';
type TimingPhase = 'downloadOrCacheRead' | 'imageDecode' | 'parseOther' | 'networkDownload' | PlatformTimingPhase;
const PLATFORM_TIMING_PHASES:PlatformTimingPhase[] = ['platformSubpackage','metadataRead','metadataInflate','metadataParse','metadataHydrate'];
interface TimingTotal { started: number; active: number; failed: number; totalMs: number; maxMs: number; }
interface LongResourceOperation { phase: TimingPhase; resource: string; durationMs: number; atMs: number; failed: boolean; }
interface CacheFileProbe { getFileSystemManager?: () => { access?: (options: {
  path: string; success: () => void; fail: () => void;
}) => void }; }
interface CacheFileCheck { path: string; state: 'checking' | 'present' | 'missing'; at: number; }

/** Cache indexes can outlive their files. Check a bounded number asynchronously
 * only when diagnostics are requested; never scan the filesystem on a frame. */
export function createCacheFileAudit(network?: CacheFileProbe, now: () => number = Date.now) {
  const checks = new Map<string, CacheFileCheck>();
  return (cache: any) => {
    const entries = cache?.cachedFiles?._map ?? {}, time = now();
    for (const [key, check] of checks) if (entries[key]?.url !== check.path) checks.delete(key);
    let fs: ReturnType<NonNullable<CacheFileProbe['getFileSystemManager']>> | undefined;
    try { fs = network?.getFileSystemManager?.(); } catch { /* API unavailable. */ }
    let admitted = 0, active = Array.from(checks.values()).filter(check => check.state === 'checking' && time - check.at < 5000).length;
    if (typeof fs?.access === 'function') for (const [key, entry] of Object.entries(entries) as [string, { url?: string }][]) {
      const old = checks.get(key), age = old ? time - old.at : Infinity;
      if (typeof entry.url !== 'string' || !entry.url || (old && age < (old.state === 'checking' ? 5000 : 30000))) continue;
      if (active >= 4 || admitted >= 4) break;
      const check: CacheFileCheck = { path: entry.url, state: 'checking', at: time };
      checks.set(key, check); active++; admitted++;
      const finish = (state: 'present' | 'missing') => {
        if (checks.get(key) !== check || check.state !== 'checking' || cache?.cachedFiles?._map?.[key]?.url !== check.path) return;
        check.state = state; check.at = now();
      };
      try { fs.access({ path: entry.url, success: () => finish('present'), fail: () => finish('missing') }); }
      catch { checks.delete(key); }
    }
    let present = 0, missing = 0, checking = 0;
    for (const check of checks.values()) {
      if (time - check.at >= (check.state === 'checking' ? 5000 : 30000)) continue;
      if (check.state === 'present') present++;
      else if (check.state === 'missing') missing++;
      else checking++;
    }
    return { supported: typeof fs?.access === 'function', present, missing, checking,
      unverified: Math.max(0, Object.keys(entries).length - present - missing),
      maxAgeMs: 30000, checkedAt: time };
  };
}
const timingInstallations = new WeakMap<object, { snapshot: () => {
  phases: Record<TimingPhase, TimingTotal>; observed: string[];
  platform: { available:boolean; [key:string]:unknown };
  longOperations: LongResourceOperation[];
  cache: { enabled?: boolean; saved: number; pendingWrites: number; outOfStorage: boolean;
    files: ReturnType<ReturnType<typeof createCacheFileAudit>> };
} }>();

/** Observe the existing pipeline without changing routing, retries or cache.
 * Download-stage time includes cache reads and queuing; only wx.downloadFile
 * counts as network. Platform package calls may use WeChat's own cache.
 * The pre-engine hooks retain their earliest evidence across this installation.
 * Totals can overlap and are not elapsed startup time. */
export function installResourceTiming(manager: any, network?: { downloadFile?: Function } & CacheFileProbe, now: () => number = Date.now) {
  if (manager && timingInstallations.has(manager)) return timingInstallations.get(manager)!;
  const phases = {} as Record<TimingPhase, TimingTotal>, observed: string[] = [];
  const longOperations: LongResourceOperation[] = [];
  for (const name of ['downloadOrCacheRead', 'imageDecode', 'parseOther', 'networkDownload', ...PLATFORM_TIMING_PHASES] as TimingPhase[]) {
    phases[name] = { started: 0, active: 0, failed: 0, totalMs: 0, maxMs: 0 };
  }
  const begin = (name: TimingPhase, resource = '') => {
    const total = phases[name], start = now(); let settled = false;
    total.started++; total.active++;
    return (error?: unknown): void => {
      if (settled) return; settled = true;
      const ms = Math.max(0, now() - start); total.active--; total.failed += error ? 1 : 0;
      total.totalMs += ms; total.maxMs = Math.max(total.maxMs, ms);
      if (ms >= 16) {
        longOperations.push({ phase: name, resource: resource.split('?')[0], durationMs: ms, atMs: now(), failed: !!error });
        if (longOperations.length > 64) longOperations.shift();
      }
    };
  };
  const wrap = (owner: any, method: string, phase: (args: any[]) => TimingPhase) => {
    if (typeof owner?.[method] !== 'function') return;
    const original = owner[method];
    try {
      owner[method] = function (this: unknown, ...args: any[]) {
        const callback = args[args.length - 1];
        if (typeof callback !== 'function') return original.apply(this, args);
        const finish = begin(phase(args), typeof args[0] === 'string' ? args[0] : '');
        args[args.length - 1] = function (this: unknown, ...result: any[]) { finish(result[0]); return callback.apply(this, result); };
        try { return original.apply(this, args); } catch (error) { finish(error); throw error; }
      };
      observed.push(method);
    } catch { /* Read-only platform adapters keep their original behavior. */ }
  };
  wrap(manager?.downloader, 'download', () => 'downloadOrCacheRead');
  wrap(manager?.parser, 'parse', args => /\.(png|jpe?g|webp|image|bmp|gif|pvr|pkm|astc)$/i.test(args[2]) ? 'imageDecode' : 'parseOther');
  if (typeof network?.downloadFile === 'function') {
    const original = network.downloadFile;
    try {
      network.downloadFile = function (this: unknown, options: any) {
        const finish = begin('networkDownload', typeof options?.url === 'string' ? options.url : '');
        const request = { ...options,
          success: function (this: unknown, result: any) { finish(result?.statusCode >= 400); return options.success?.call(this, result); },
          fail: function (this: unknown, error: unknown) { finish(true); return options.fail?.call(this, error); },
        };
        try { return original.call(this, request); } catch (error) { finish(true); throw error; }
      };
      observed.push('wx.downloadFile');
    } catch { /* Diagnostics are optional on hosts with read-only APIs. */ }
  }
  const auditCacheFiles = createCacheFileAudit(network, now);
  const result = { snapshot: () => {
    const snapshot = {} as Record<TimingPhase, TimingTotal>;
    for (const key of Object.keys(phases) as TimingPhase[]) snapshot[key] = { ...phases[key] };
    let platform:{available:boolean;phases?:Partial<Record<PlatformTimingPhase,TimingTotal>>;[key:string]:unknown}={available:false};
    try {
      const source=(globalThis as typeof globalThis & {__forestGunnerPlatformTiming?:{snapshot:()=>typeof platform}}).__forestGunnerPlatformTiming;
      if(source&&typeof source.snapshot==='function')platform=source.snapshot();
    } catch { /* Missing or replaced optional diagnostics cannot affect loading. */ }
    for(const key of PLATFORM_TIMING_PHASES)if(platform.phases?.[key])snapshot[key]={...platform.phases[key]!};
    const cache = manager?.cacheManager;
    return { phases: snapshot, platform, observed: observed.slice(), longOperations: longOperations.map(item => ({ ...item })),
      cache: { enabled: cache?.cacheEnabled,
      saved: Object.keys(cache?.cachedFiles?._map ?? {}).length,
      pendingWrites: Object.keys(cache?.cacheQueue ?? {}).length, outOfStorage: !!cache?.outOfStorage,
      files: auditCacheFiles(cache) } };
  } };
  if (manager) timingInstallations.set(manager, result);
  return result;
}
