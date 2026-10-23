export type ResourcePersistence = 'unknown' | 'pending' | 'persisted' | 'failed';
export interface ResourceModuleRegistration<Assets> {
  load: (valid: () => boolean) => Promise<Assets>;
  create: (assets: Assets, valid: () => boolean) => Promise<void>;
  dispose?: () => void;
  dependencies?: readonly string[];
}
export interface ResourceModuleSnapshot {
  state: 'idle' | 'loading' | 'loaded' | 'creating' | 'ready' | 'failed';
  assetReady: boolean;
  viewReady: boolean;
  persistence: ResourcePersistence;
  foreground: boolean;
  attempts: number;
  startedAt?: number;
  readyAt?: number;
  error?: string;
}
interface ModuleRecord extends ResourceModuleSnapshot {
  registration: ResourceModuleRegistration<unknown>;
  assets?: unknown;
  generation: number;
  request?: Promise<void>;
  assetRequest?: Promise<void>;
}

/** Owns one preparation result per module across startup and foreground opens.
 * Priority changes never cancel/restart the shared work. The caller drives
 * sliced construction and checks valid() at publication, including disposal. */
export class ResourceModuleManager {
  private readonly modules = new Map<string, ModuleRecord>();
  private disposed = false;
  private readonly now: () => number;
  constructor(private readonly hooks: { onPrioritize?: (name: string) => void;
    onUse?: (name: string) => void; now?: () => number } = {}) { this.now = hooks.now ?? Date.now; }

  register<Assets>(name: string, registration: ResourceModuleRegistration<Assets>): void {
    if (this.disposed) throw new Error('Resource module manager disposed');
    if (this.modules.has(name)) throw new Error(`Resource module already registered: ${name}`);
    this.modules.set(name, { registration: registration as ResourceModuleRegistration<unknown>, generation: 0,
      state: 'idle', assetReady: false, viewReady: false, persistence: 'unknown', foreground: false, attempts: 0 });
  }

  prepare(name: string, options: { foreground?: boolean } = {}): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Resource module manager disposed'));
    const module = this.modules.get(name);
    if (!module) return Promise.reject(new Error(`Unknown resource module: ${name}`));
    try { this.checkDependencies(name, []); }
    catch (error) { return Promise.reject(error); }
    if (options.foreground) this.prioritize(name);
    if (module.request) return module.request;
    if (module.viewReady) return Promise.resolve();
    const generation = module.generation;
    const valid = () => !this.disposed && generation === module.generation;
    const assertValid = () => { if (!valid()) throw new Error(`Resource module invalidated: ${name}`); };
    module.state = module.assetReady ? 'creating' : 'loading'; module.error = undefined;
    module.startedAt ??= this.now(); module.readyAt = undefined; module.attempts++;
    // Enter a microtask before invoking callbacks so synchronous re-entry also
    // observes the exact same request and cannot create a second view.
    const request = Promise.resolve().then(async () => {
      assertValid();
      for (const dependency of module.registration.dependencies ?? []) {
        await this.prepare(dependency, { foreground: module.foreground }); assertValid();
      }
      await this.prepareAssets(name); assertValid();
      module.state = 'creating';
      await module.registration.create(module.assets, valid); assertValid();
      module.viewReady = true; module.state = 'ready'; module.readyAt = this.now();
    }).catch(error => {
      if (valid()) { module.state = 'failed'; module.error = error instanceof Error ? error.message : String(error); }
      throw error;
    }).then(() => { if (module.request === request) module.request = undefined; }, error => {
      if (module.request === request) module.request = undefined;
      throw error;
    });
    module.request = request;
    return request;
  }

  /** Warm one module's assets without creating or publishing its view. Callers
   * with view dependencies must prepare those views first (e.g. collection).
   * Foreground prepare joins this exact request, including its failure. */
  prepareAssets(name: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Resource module manager disposed'));
    const module = this.modules.get(name);
    if (!module) return Promise.reject(new Error(`Unknown resource module: ${name}`));
    if (module.assetReady) return Promise.resolve();
    if (module.assetRequest) return module.assetRequest;
    if (module.registration.dependencies?.some(dependency => !this.isViewReady(dependency))) {
      return Promise.reject(new Error(`Resource module dependencies not ready: ${name}`));
    }
    const generation = module.generation;
    const valid = () => !this.disposed && generation === module.generation;
    const assertValid = () => { if (!valid()) throw new Error(`Resource module invalidated: ${name}`); };
    module.state = 'loading'; module.error = undefined; module.startedAt ??= this.now();
    // Publish the shared promise before invoking user code, preserving both
    // synchronous re-entry safety and the normal foreground admission timing.
    let resolveRequest!: () => void, rejectRequest!: (error: unknown) => void;
    const request = new Promise<void>((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    module.assetRequest = request;
    const run = async () => {
      assertValid();
      const assets = await module.registration.load(valid); assertValid();
      module.assets = assets; module.assetReady = true; module.state = 'loaded';
    };
    void run().then(() => {
      if (module.assetRequest === request) module.assetRequest = undefined;
      resolveRequest();
    }, error => {
      if (valid()) { module.state = 'failed'; module.error = error instanceof Error ? error.message : String(error); }
      if (module.assetRequest === request) module.assetRequest = undefined;
      rejectRequest(error);
    });
    return request;
  }

  open(name: string): Promise<void> {
    const request = this.prepare(name, { foreground: true });
    // Usage counts successful visible requests, not speculative preparation.
    return request.then(() => { if (!this.disposed) this.hooks.onUse?.(name); });
  }

  private prioritize(name: string): void {
    const module = this.modules.get(name)!;
    module.foreground = true; this.hooks.onPrioritize?.(name);
    for (const dependency of module.registration.dependencies ?? []) this.prioritize(dependency);
  }

  private checkDependencies(name: string, path: readonly string[]): void {
    const module = this.modules.get(name);
    if (!module) throw new Error(`Unknown resource module: ${name}`);
    if (path.includes(name)) throw new Error(`Cyclic resource modules: ${[...path, name].join(' -> ')}`);
    for (const dependency of module.registration.dependencies ?? []) this.checkDependencies(dependency, [...path, name]);
  }

  isViewReady(name: string): boolean { return !this.disposed && !!this.modules.get(name)?.viewReady; }
  isAssetReady(name: string): boolean { return !this.disposed && !!this.modules.get(name)?.assetReady; }
  setViewReady(name: string): void {
    const module = this.modules.get(name);
    if (this.disposed || !module) return;
    module.assetReady = true; module.viewReady = true; module.state = 'ready'; module.readyAt = this.now();
  }
  setPersistence(name: string, persistence: ResourcePersistence): void {
    const module = this.modules.get(name); if (!this.disposed && module) module.persistence = persistence;
  }

  /** Memory pressure may evict only idle/closed modules; an in-progress create
   * remains owned until it settles. Persistence describes disk, so is retained. */
  invalidate(name: string, options: { assets?: boolean } = {}): boolean {
    const module = this.modules.get(name);
    if (this.disposed || !module || module.request || module.assetRequest) return false;
    module.generation++; module.registration.dispose?.();
    module.viewReady = false; module.state = 'idle'; module.foreground = false;
    module.error = undefined; module.startedAt = undefined; module.readyAt = undefined;
    if (options.assets !== false) { module.assetReady = false; module.assets = undefined; }
    return true;
  }

  snapshot(): Record<string, ResourceModuleSnapshot> {
    const result: Record<string, ResourceModuleSnapshot> = {};
    this.modules.forEach((module, name) => { const { state, assetReady, viewReady, persistence, foreground,
      attempts, startedAt, readyAt, error } = module;
      result[name] = { state, assetReady, viewReady, persistence, foreground, attempts, startedAt, readyAt, error }; });
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.modules.forEach(module => { module.generation++; module.registration.dispose?.();
      module.assets = undefined; module.assetReady = false; module.viewReady = false; module.state = 'idle'; });
  }
}
