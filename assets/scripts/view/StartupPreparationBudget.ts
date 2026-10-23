import { RESOURCE_LOADING_POLICY } from './ResourceLoadingPolicy';

/** A launch-history marker chooses a UX budget only. It is never evidence that
 * the OS retained downloaded files, decoded assets or constructed views. */
export class StartupPreparationBudget {
  readonly budgetMs: number;
  constructor(private readonly startedAt: number, returningPlayer: boolean,
    private readonly now: () => number = Date.now) {
    this.budgetMs = returningPlayer ? RESOURCE_LOADING_POLICY.startup.warmBudgetMs : RESOURCE_LOADING_POLICY.startup.coldBudgetMs;
  }

  evaluate(state: { coreReady: boolean; viewsReady: boolean; hidden: boolean }) {
    const elapsedMs = Math.max(0, this.now() - this.startedAt), expired = elapsedMs >= this.budgetMs;
    const release = !state.hidden && state.coreReady && state.viewsReady;
    const reason = state.hidden ? 'hidden' : !state.coreReady ? 'core' : state.viewsReady ? 'views' : 'waiting';
    return { release, reason, elapsedMs, budgetMs: this.budgetMs, expired };
  }
}
