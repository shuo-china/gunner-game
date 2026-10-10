import type { CombatEvent, CombatStats, TreeState, Vec2 } from '../core/types';
import { WEAPON_CONFIG } from '../core/config';
import { DecimalAmount } from '../core/DecimalAmount';
import { fullUpgradeBudget, getUpgradePrice, getUpgradeValue, isUpgradeLevel, isUpgradeType,
  MAX_UPGRADE_LEVEL, UPGRADE_SOURCE, UPGRADE_TYPES } from './UpgradeEconomy';
import type { UpgradeState, UpgradeType } from './UpgradeEconomy';
export type { UpgradeState, UpgradeType } from './UpgradeEconomy';

/** Source UI_type order; only Main gameplay is implemented in this prototype. */
export const BATTLE_MODES = ['Main', 'SpeedRun', 'Mine', 'Boss', 'Monster', 'Raid'] as const;
export type BattleMode = typeof BATTLE_MODES[number];
export interface EconomyStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export interface BattleSessionOptions { environment?: 'test' | 'production'; storage?: EconomyStorage; }
export interface CombatModifiers { damage: DecimalAmount; attackInterval: number; }
export const ECONOMY_SAVE_VERSION = 1;
export function economyStorageKey(environment: 'test' | 'production'): string { return `forest-gunner:economy:v1:${environment}`; }

export interface BattleHudState {
  mode: BattleMode;
  stageIndex: number;
  waveIndex: number;
  kills: number;
  totalTrees: number;
  remainingSeconds: number;
  durationSeconds: number;
  elapsed: number;
  paused: boolean;
  complete: boolean;
  resultsReady: boolean;
  money: DecimalAmount;
  diamonds: number;
  upgrades: readonly UpgradeState[];
}

export interface TreeReward {
  treeId: number;
  position: Vec2;
  amount: DecimalAmount;
  sourceTime: number;
}

export const MAIN_ROUND_SECONDS = 180;
// Tree_manager.Stage_Money_Balance[0] = 20; Degree_Money_Balance = [1, 1.8, 3, 100].
// This map uses degree 0/1 and applies its persistent Money upgrade below.
const FIRST_STAGE_REWARDS = [20, 36] as const;

/** Persistent economy is separate from the round and its one-payment-per-tree ledger. */
export class BattleSession {
  private currentMode: BattleMode = 'Main';
  private money = DecimalAmount.from(0);
  private readonly levels = [0, 0, 0];
  private readonly diamonds = 0;
  private readonly rewardedTrees = new Set<number>();
  private readonly storage?: EconomyStorage;
  private readonly storageKey: string;
  private reportedStorageFailure = false;

  constructor(options: BattleSessionOptions = {}) {
    const environment = options.environment === 'test' ? 'test' : 'production';
    this.storage = options.storage; this.storageKey = economyStorageKey(environment);
    this.restore();
    if (environment === 'test' && this.money.compare(fullUpgradeBudget()) < 0) this.money = fullUpgradeBudget();
    this.save();
  }

  get mode(): BattleMode { return this.currentMode; }
  get combatModifiers(): CombatModifiers {
    const speed = Math.max(100, Math.min(10000, getUpgradeValue('speed', this.levels[1]).toNumber()));
    return {
      damage: DecimalAmount.from(WEAPON_CONFIG.damage).mul(getUpgradeValue('power', this.levels[0])).scale(-2),
      attackInterval: Math.max(UPGRADE_SOURCE.minimumAttackInterval, Math.min(UPGRADE_SOURCE.maximumAttackInterval, WEAPON_CONFIG.attackInterval * 100 / speed)),
    };
  }

  setMode(mode: BattleMode): void {
    if (!BATTLE_MODES.includes(mode)) throw new Error(`Unsupported battle mode: ${mode}`);
    this.currentMode = mode;
  }

  /** A replay reuses tree IDs, so reset the ledger without resetting the session wallet. */
  beginRound(): void { this.rewardedTrees.clear(); }

  purchase(type: UpgradeType): boolean {
    if (!isUpgradeType(type)) return false;
    const index = UPGRADE_TYPES.indexOf(type), level = this.levels[index];
    if (level >= MAX_UPGRADE_LEVEL) return false;
    const price = getUpgradePrice(level)!;
    if (this.money.compare(price) < 0) return false;
    this.money = this.money.sub(price); this.levels[index] = level + 1; this.save();
    return true;
  }

  consume(events: readonly CombatEvent[], trees: readonly TreeState[]): TreeReward[] {
    const rewards: TreeReward[] = [];
    if (this.mode !== 'Main') return rewards;
    for (const event of events) {
      if (event.type !== 'treeDied' || this.rewardedTrees.has(event.treeId)) continue;
      const tree = trees.find(candidate => candidate.id === event.treeId);
      if (!tree || tree.alive) continue;
      const amount = DecimalAmount.from(FIRST_STAGE_REWARDS[tree.degree]).mul(getUpgradeValue('money', this.levels[2])).scale(-2);
      this.rewardedTrees.add(tree.id);
      this.money = this.money.add(amount);
      rewards.push({ treeId: tree.id, amount, position: { ...event.position }, sourceTime: event.sourceTime });
    }
    if (rewards.length) this.save();
    return rewards;
  }

  snapshot(stats: Readonly<CombatStats>, paused: boolean, rewardEffectsActive = false): BattleHudState {
    return {
      mode: this.mode, stageIndex: 0, waveIndex: 0,
      kills: stats.kills, totalTrees: stats.totalTrees,
      durationSeconds: MAIN_ROUND_SECONDS,
      remainingSeconds: Math.max(0, MAIN_ROUND_SECONDS - stats.elapsed),
      elapsed: stats.elapsed, paused, complete: stats.complete,
      resultsReady: stats.complete && !rewardEffectsActive,
      money: this.money, diamonds: this.diamonds,
      upgrades: UPGRADE_TYPES.map((type, index) => {
        const level = this.levels[index], price = getUpgradePrice(level);
        return { type, level, value: getUpgradeValue(type, level), price,
          affordable: price !== null && this.money.compare(price) >= 0,
          progress: price === null ? 0 : this.money.ratio(price) };
      }),
    };
  }

  /** App hide may flush too; purchases and reward batches already persist immediately. */
  save(): void {
    if (!this.storage) return;
    try { this.storage.setItem(this.storageKey, JSON.stringify({ version: ECONOMY_SAVE_VERSION, money: this.money, levels: this.levels })); }
    catch (error) { this.reportStorageFailure(error); }
  }

  private restore(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey); if (raw === null) return;
      const data = JSON.parse(raw) as { version?: unknown; money?: unknown; levels?: unknown };
      if (!data || data.version !== ECONOMY_SAVE_VERSION || !Array.isArray(data.levels) || data.levels.length !== 3 || !data.levels.every(isUpgradeLevel)) throw new Error('Invalid economy save');
      const serialized = data.money as { digits?: unknown; exponent?: unknown } | undefined;
      if (!serialized || typeof serialized.digits !== 'string' || typeof serialized.exponent !== 'number') throw new Error('Invalid saved wallet');
      const money = DecimalAmount.from({ digits: serialized.digits, exponent: serialized.exponent });
      if (money.isNegative) throw new Error('Invalid saved wallet');
      this.money = money; data.levels.forEach((level: number, index: number) => { this.levels[index] = level; });
    } catch (error) { this.reportStorageFailure(error); }
  }

  private reportStorageFailure(error: unknown): void {
    if (this.reportedStorageFailure) return;
    this.reportedStorageFailure = true;
    console.warn('Economy storage unavailable or invalid; play continues in memory.', error);
  }
}
