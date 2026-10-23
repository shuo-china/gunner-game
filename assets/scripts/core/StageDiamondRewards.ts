import { DecimalAmount } from './DecimalAmount';
import type { EconomyConfig } from './EconomyConfig';

/** stageIndex is zero-based. Round each grant only after applying linear growth. */
export function getStageDiamondRewards(config: EconomyConfig['speedRun'], stageIndex: number): {
  reward: number; additionalReward: number; totalReward: number; withinWalletLimit: boolean;
} {
  if (!Number.isSafeInteger(stageIndex) || stageIndex < 0) throw new Error('Invalid reward stage');
  const multiplier = DecimalAmount.from(stageIndex).mul(config.stageGrowthPercent).scale(-2).add(1);
  const base = multiplier.mul(config.baseDiamonds).discardDecimal();
  const additional = multiplier.mul(config.additionalDiamonds).discardDecimal();
  const total = base.add(additional);
  // Keep extreme legacy-stage previews safe without discarding their progress.
  // Such a round cannot start until its full reward fits the integer wallet.
  const limit = Number.MAX_SAFE_INTEGER;
  const preview = (value: DecimalAmount): number => value.compare(limit) > 0 ? limit : value.toNumber();
  return { reward: preview(base), additionalReward: preview(additional), totalReward: preview(total),
    withinWalletLimit: total.compare(limit) <= 0 };
}
