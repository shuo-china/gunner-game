import { RESOURCE_LOADING_POLICY } from './ResourceLoadingPolicy';

interface BackgroundTask {
  run: () => Promise<void>;
  groups: Map<string, number>;
  state: 'queued' | 'running' | 'completed' | 'failed';
  attempts: number;
  retryAt: number;
  error?: string;
}

export interface BackgroundQueueSnapshot {
  total: number; queued: number; active: number; completed: number; failed: number; paused: boolean;
  errors: { id: string; message: string; retryAt: number }[];
  running: string[];
}

/** Frame-driven resource work. Promise completion never starts more work:
 * hide/dispose and foreground requests always get a chance to run first. */
export class BackgroundResourceQueue {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly priorities = new Map<string, number | null>();
  private readonly promoted = new Set<string>();
  private started = false;
  private startAt = 0;
  private paused = false;
  private disposed = false;
  private active = 0;

  constructor(private readonly now: () => number = Date.now,
    private readonly maxConcurrency: number = RESOURCE_LOADING_POLICY.background.maxConcurrency) {}

  start(delayMs: number = RESOURCE_LOADING_POLICY.background.startDelayMs): void {
    if (this.started || this.disposed) return;
    this.started = true; this.startAt = this.now() + delayMs;
  }

  enqueue(id: string, group: string, run: () => Promise<void>, offset = 0): void {
    if (this.disposed) return;
    const existing = this.tasks.get(id);
    if (existing) {
      existing.groups.set(group, Math.max(existing.groups.get(group) ?? -Infinity, offset));
      return;
    }
    this.tasks.set(id, { run, groups: new Map([[group, offset]]), state: 'queued', attempts: 0, retryAt: 0 });
  }

  setPriority(group: string, priority: number | null): void { this.priorities.set(group, priority); }
  prioritize(group: string): void { this.promoted.add(group); }
  clearPriorityBoost(group: string): void { this.promoted.delete(group); }
  pause(): void { this.paused = true; }
  resume(): void { if (!this.disposed) this.paused = false; }
  invalidateGroup(group: string): void {
    if (this.disposed) return;
    this.tasks.forEach(task => {
      if (!task.groups.has(group) || task.state === 'running') return;
      task.state = 'queued'; task.attempts = 0; task.retryAt = 0; task.error = undefined;
    });
  }

  private priority(task: BackgroundTask): number {
    let best = -Infinity;
    task.groups.forEach((offset, group) => {
      const priority = this.priorities.has(group) ? this.priorities.get(group)! : 0;
      if (priority !== null) best = Math.max(best, priority + offset + (this.promoted.has(group) ? RESOURCE_LOADING_POLICY.background.priorities.promoted : 0));
    });
    return best;
  }

  tick(maxStarts: number = this.maxConcurrency): number {
    const now = this.now();
    if (!this.started || this.disposed || this.paused || now < this.startAt) return 0;
    let started = 0;
    // At most two logical resources, including configuration discovery. Engine
    // options also bound the native dependencies of each resource.
    while (this.active < this.maxConcurrency && started < maxStarts) {
      let next: BackgroundTask | undefined, priority = -Infinity;
      this.tasks.forEach(task => {
        if ((task.state !== 'queued' && task.state !== 'failed') || task.retryAt > now) return;
        const value = this.priority(task);
        if (value > priority) { next = task; priority = value; }
      });
      if (!next) break;
      const task = next;
      if (task.state === 'failed') task.attempts = 0;
      task.state = 'running'; task.attempts++; this.active++; started++;
      const settle = (error?: unknown): void => {
        if (this.disposed) return;
        this.active--;
        if (error === undefined) { task.state = 'completed'; task.error = undefined; task.retryAt = 0; return; }
        task.error = error instanceof Error ? error.message : String(error);
        task.state = task.attempts < RESOURCE_LOADING_POLICY.background.maxAttempts ? 'queued' : 'failed';
        task.retryAt = this.now() + (task.state === 'failed' ? RESOURCE_LOADING_POLICY.background.recoveryDelayMs : RESOURCE_LOADING_POLICY.background.retryDelayMs);
      };
      try { task.run().then(() => settle(), error => settle(error ?? 'Resource request failed')); }
      catch (error) { settle(error ?? 'Resource request failed'); }
    }
    return started;
  }

  snapshot(group?: string): BackgroundQueueSnapshot {
    const result: BackgroundQueueSnapshot = { total: 0, queued: 0, active: 0, completed: 0, failed: 0, paused: this.paused, errors: [], running: [] };
    this.tasks.forEach((task, id) => {
      if (group !== undefined && !task.groups.has(group)) return;
      result.total++; result[task.state === 'running' ? 'active' : task.state]++;
      if (task.state === 'running') result.running.push(id);
      if (task.error) result.errors.push({ id, message: task.error, retryAt: task.retryAt });
    });
    return result;
  }

  dispose(): void {
    this.disposed = true; this.paused = true; this.tasks.clear(); this.priorities.clear(); this.promoted.clear(); this.active = 0;
  }
}
