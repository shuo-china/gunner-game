import { RESOURCE_LOADING_POLICY } from './ResourceLoadingPolicy';

interface Preparation {
  name: string;
  phase: string;
  steps: Generator<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Runs UI construction only from a foreground frame, with one shared budget.
 * Promise completions never start construction outside the game update. */
export class UiPreparationQueue {
  private readonly tasks: Preparation[] = [];
  private disposed = false;
  private readonly measurements = new Map<string, { runs: number; steps: number; workMs: number; maxStepMs: number }>();

  constructor(private readonly now: () => number = Date.now,
    private readonly observe?: (name: string, phase: string, ms: number, done: boolean) => void) {}

  run(name: string, steps: Generator<void>, phase = 'prepare'): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('UI preparation disposed'));
    const total = this.measurements.get(name) ?? { runs: 0, steps: 0, workMs: 0, maxStepMs: 0 };
    total.runs++; this.measurements.set(name, total);
    return new Promise<void>((resolve, reject) => { this.tasks.push({ name, phase, steps, resolve, reject }); });
  }

  tick(foreground?: string, allowed: (name: string) => boolean = () => true, maxSteps?: number,
    phase: 'runtime' | 'startup' = 'runtime'): number {
    if (this.disposed) return 0;
    const policy = RESOURCE_LOADING_POLICY.uiPreparation, start = this.now();
    const focused = this.tasks.some(task => task.name === foreground && allowed(task.name));
    // Only the current startup panel may spend the larger slice. An absent or
    // blocked focus must never grant extra time to unrelated background work.
    const startup = focused && phase === 'startup';
    const budget = startup ? RESOURCE_LOADING_POLICY.startup.uiFrameBudgetMs : focused ? policy.foregroundFrameBudgetMs : policy.frameBudgetMs;
    const limit = Math.min(maxSteps ?? Infinity, startup ? RESOURCE_LOADING_POLICY.startup.uiMaxStepsPerFrame : focused ? policy.foregroundMaxStepsPerFrame : policy.maxStepsPerFrame);
    let count = 0, committed = false;
    while (this.tasks.length && count < limit && (count === 0 || this.now() - start < budget)) {
      // Spend the extra foreground budget only on the feature being opened.
      if (focused && !this.tasks.some(task => task.name === foreground && allowed(task.name))) break;
      const eligible=(item:Preparation)=>allowed(item.name)&&(!focused||item.name===foreground)&&(!committed||item.phase!=='commit');
      // A completed panel must not wait behind another panel's thousands of
      // construction steps. Publication shares the same clock/step budget.
      const task = this.tasks.find(item => item.phase==='commit'&&eligible(item)) ?? this.tasks.find(eligible);
      if (!task) break;
      count++;
      const stepStart = this.now();
      let done = false;
      try {
        if (task.steps.next().done) { done = true; this.remove(task); task.resolve(); }
      } catch (error) {
        this.remove(task); this.close(task);
        task.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        const total = this.measurements.get(task.name)!;
        const ms = Math.max(0, this.now() - stepStart); total.steps++; total.workMs += ms; total.maxStepMs = Math.max(total.maxStepMs, ms);
        this.observe?.(task.name, task.phase, ms, done);
      }
      // Commit is a separate admission boundary. Even a coarse clock must not
      // publish several newly prepared HUDs in the same background frame.
      if (task.phase === 'commit') committed = true;
    }
    return count;
  }

  nextName(allowed:(name:string)=>boolean=()=>true):string|undefined {
    return (this.tasks.find(task=>task.phase==='commit'&&allowed(task.name))??this.tasks.find(task=>allowed(task.name)))?.name;
  }

  snapshot(): string[] { return this.tasks.map(task => task.name); }
  timings() {
    const result: Record<string, { runs: number; steps: number; workMs: number; maxStepMs: number }> = {};
    this.measurements.forEach((value, name) => { result[name] = { ...value }; }); return result;
  }

  dispose(): void {
    this.disposed = true;
    for (const task of this.tasks.splice(0)) {
      this.close(task); task.reject(new Error('UI preparation disposed'));
    }
  }

  private remove(task: Preparation): void { this.tasks.splice(this.tasks.indexOf(task), 1); }
  private close(task: Preparation): void { try { task.steps.return(undefined); } catch { /* The original failure is reported to the owner. */ } }
}
