import { DecimalAmount } from '../core/DecimalAmount';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { OriginalInfVal } from '../core/OriginalInfVal';
import { getStageHealth, getStageHealthPrecision, getStageMoney, getStageMoneyPrecision,
  getStageTreeCount, STAGE_DEGREE_RATES, STAGE_HEALTH_MULTIPLIERS } from '../core/StageBalance';
import type { WeaponDefinition } from '../core/WeaponCatalog';
import { nextStagePosition, stageValue, validateStagePosition } from './StageProgression';
import { getUpgradeMultiplier, getUpgradePrice, getUpgradeValue, isUpgradeLevel, MAX_UPGRADE_LEVEL,
  UPGRADE_SOURCE } from './UpgradeEconomy';

/** OfflineProgressSimulator, Cat Gunner 1.1.61. These are combat/execution limits,
 * not resource amounts; all economy tuning is in EconomyConfig.offline/gold. */
export const OFFLINE_SOURCE = Object.freeze({
  maxIterations: 30000, frameBudgetMs: 60, remainingSecondsEpsilon: 0.05,
  stageTimeLimit: 180, minActionSeconds: 0.1, minTraversalPerTree: 0.05,
  minimumMoveMultiplier: 0.01, maximumKillSeconds: 1e9, maximumUpgradeWaitSeconds: 31536000,
  maximumConvertedValue: 1e15, pierceTargets: 10, laserTargets: 10, blastTargets: 5,
});
export type OfflineLevels = [number, number, number];
export type OfflineWeapon = Pick<WeaponDefinition, 'type' | 'damage' | 'attackInterval' | 'pelletCount'>;
/** Percent values include their original base 100. Fish values are bonuses.
 * Slot stars and expiring buffs intentionally are not simulator inputs. */
export interface OfflineModifiers {
  rebirthDamage: OriginalInfVal; rebirthSpeed: OriginalInfVal; rebirthMoney: OriginalInfVal;
  skinDamage: number; skinSpeed: number; skinMoney: number;
  petMoney: OriginalInfVal; petSpeed: number;
  fishDamage: number; fishCriticalChance: number; fishCriticalDamage: number;
  relicDamage: OriginalInfVal; relicCriticalDamage: OriginalInfVal; relicMoney: OriginalInfVal;
  buffPack: boolean;
}
export interface OfflineElapsed { elapsedSeconds: number; absentSeconds: number; isCapped: boolean; }
export interface OfflineProgressInput {
  gold: OriginalInfVal; moneyAccum?: OriginalInfVal; levels: readonly number[];
  stageIndex: number; waveIndex: number; stageValueMax: number;
  weapons: readonly (OfflineWeapon | null)[];
  elapsedSeconds: number; absentSeconds?: number;
  modifiers?: Partial<OfflineModifiers>;
}
export interface OfflineProgressResult extends OfflineElapsed {
  moneyGained: OriginalInfVal; moneyFinal: OriginalInfVal; moneyAccumFinal: OriginalInfVal;
  levels: OfflineLevels; levelsGained: OfflineLevels;
  stageIndex: number; waveIndex: number; stageValueMax: number; stagesCleared: number;
}
export interface OfflineClearInfo { combatTime: number; regularKillRate: number; }
export interface OfflineAsyncOptions {
  yieldFrame: () => Promise<void>; frameBudgetMs?: number; now?: () => number;
}
const f = Math.fround;
const zero = (): OriginalInfVal => OriginalInfVal.fromInt(0);
const hundred = (): OriginalInfVal => OriginalInfVal.fromInt(100);
const clamp = (n: number, low: number, high: number): number => Math.max(low, Math.min(high, n));
const clock = (): number => typeof performance !== 'undefined' ? performance.now() : Date.now();

export function effectiveMaxOfflineSeconds(extraMinutes = 0): number {
  if (!Number.isFinite(extraMinutes) || extraMinutes < 0) throw new Error('Invalid offline extension');
  return f(f(ECONOMY_CONFIG.offline.maxOfflineSeconds) + f(extraMinutes * 60));
}
/** The session chooses its trusted/persisted UTC checkpoint before calling this.
 * Invalid, future, missing and sub-threshold checkpoints produce no settlement. */
export function computeOfflineElapsed(lastSeenMs: number | null | undefined, nowMs: number, extraMinutes = 0): OfflineElapsed | null {
  if (lastSeenMs === null || lastSeenMs === undefined || !Number.isFinite(lastSeenMs) || !Number.isFinite(nowMs)) return null;
  const absentSeconds = f((nowMs - lastSeenMs) / 1000);
  if (!Number.isFinite(absentSeconds)) return null;
  const elapsedSeconds = clamp(absentSeconds, 0, effectiveMaxOfflineSeconds(extraMinutes));
  return elapsedSeconds < ECONOMY_CONFIG.offline.minimumAbsentSeconds ? null
    : { elapsedSeconds, absentSeconds, isCapped: f(elapsedSeconds + 1) < absentSeconds };
}
function toInfVal(value: number): OriginalInfVal {
  return OriginalInfVal.fromDouble(!Number.isFinite(value) || value > OFFLINE_SOURCE.maximumConvertedValue
    ? OFFLINE_SOURCE.maximumConvertedValue : value);
}
function modifiers(overrides: Partial<OfflineModifiers> = {}): OfflineModifiers {
  const result: OfflineModifiers = {
    rebirthDamage: hundred(), rebirthSpeed: hundred(), rebirthMoney: hundred(),
    skinDamage: 100, skinSpeed: 100, skinMoney: 100, petMoney: hundred(), petSpeed: 100,
    fishDamage: 0, fishCriticalChance: 0, fishCriticalDamage: 0,
    relicDamage: hundred(), relicCriticalDamage: hundred(), relicMoney: hundred(), buffPack: false,
    ...overrides,
  };
  for (const value of Object.values(result)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error('Invalid offline modifier');
    if (value instanceof OriginalInfVal && value.amount.isNegative) throw new Error('Invalid offline modifier');
  }
  return result;
}
function averageDegree(wave: number, multipliers: readonly number[]): number {
  let value = 0;
  // Native loads a float rate, widens to double, then divides by double 100.
  // Rounding rate/100 to float changes one-shot thresholds (e.g. wave 3, HP 620).
  for (let i = 0; i < 3; i++) value += (STAGE_DEGREE_RATES[wave][i] / 100) * multipliers[i];
  return value;
}
function targetCount(weapon: OfflineWeapon): number {
  switch (weapon.type) {
    case 'LASER': return OFFLINE_SOURCE.laserTargets;
    case 'PIERCE': return OFFLINE_SOURCE.pierceTargets;
    case 'SHOTGUN': return Math.max(1, weapon.pelletCount);
    case 'EXPLOSIVE': case 'MISSILE': case 'BLAST_SNIPER': return OFFLINE_SOURCE.blastTargets;
    default: return 1;
  }
}
function weaponDamage(weapon: OfflineWeapon): OriginalInfVal {
  const coefficient = weapon.damage.split(/[eE]/)[0].replace(/^[+-]/, '').replace('.', '');
  return OriginalInfVal.fromAmount(DecimalAmount.from(weapon.damage), coefficient.length);
}
function speedPercent(level: number, stage: number, m: OfflineModifiers): number {
  return clamp(getUpgradeValue('speed', level).toNumber() + Math.trunc(m.rebirthSpeed.amount.toNumber())
    + m.skinSpeed - 200 - stage * 30, 100, 10000);
}
function clearInfo(levels: readonly number[], stage: number, wave: number, history: number,
  weapons: readonly OfflineWeapon[], m: OfflineModifiers, buff: number): OfflineClearInfo {
  const count = getStageTreeCount(stage) * (wave + 1);
  const stageHealth = OriginalInfVal.fromAmount(getStageHealth(stage), getStageHealthPrecision(stage));
  let health = stageHealth.mul(toInfVal(averageDegree(wave, STAGE_HEALTH_MULTIPLIERS)));
  // Source replaces non-positive HP only; positive fractions are not raised to 1.
  if (health.amount.compare(0) <= 0) health = OriginalInfVal.fromInt(1);
  const bossHealth = wave === 4 ? stageHealth.mul(toInfVal(STAGE_HEALTH_MULTIPLIERS[3])) : zero();
  const chance = clamp(f(f(m.fishCriticalChance) / 100), 0, 1);
  const power = getUpgradeMultiplier('power', levels[0]), speed = speedPercent(levels[1], stage, m);
  const movement = Math.max(f(OFFLINE_SOURCE.minimumMoveMultiplier), f(f(m.petSpeed) / 100));
  const replay = stage * 10 + wave < history;
  const minAction = f(f(f(OFFLINE_SOURCE.minActionSeconds) / movement) * (replay ? 0.5 : 1));
  let rate = 0, bossDps = zero();
  for (const weapon of weapons) {
    let damage = weaponDamage(weapon).mul(power).div(100).mul(m.rebirthDamage).div(100).discardDecimal();
    damage = damage.mul(m.skinDamage).div(100).discardDecimal();
    damage = damage.mul(100 + m.fishDamage).div(100).discardDecimal();
    damage = damage.mul(m.relicDamage).div(100).discardDecimal().mul(buff).discardDecimal();
    const critical = damage.mul(125 + Math.trunc(m.fishCriticalDamage)).div(100).discardDecimal()
      .mul(m.relicCriticalDamage).div(100).discardDecimal();
    const expected = damage.mul(toInfVal(f(1 - chance))).add(critical.mul(toInfVal(chance)));
    if (expected.amount.compare(0) <= 0) continue;
    const interval = clamp(f(f(f(f(weapon.attackInterval) / speed) * 100) / buff),
      f(UPGRADE_SOURCE.minimumAttackInterval), f(UPGRADE_SOURCE.maximumAttackInterval));
    if (expected.amount.compare(health.amount) >= 0) rate += targetCount(weapon) / Math.max(interval, minAction);
    else {
      const ratio = health.div(expected).amount.toNumber();
      // Ghidra prints a cast here, but ARM64 0x2B08450 is FRINTP (ceiling).
      const hits = Math.max(1, Number.isFinite(ratio) ? Math.ceil(ratio) : OFFLINE_SOURCE.maximumKillSeconds);
      // Only non-finite ratios replace hits with 1e9. Finite hits remain unbounded;
      // clamp their double time product to 1e9 BEFORE converting it to float.
      const killTime = f(Math.min(hits * interval, OFFLINE_SOURCE.maximumKillSeconds));
      rate += 1 / Math.max(killTime, minAction);
    }
    if (wave === 4) bossDps = bossDps.add(expected.div(toInfVal(interval)));
  }
  if (rate <= 0) return { combatTime: Infinity, regularKillRate: rate };
  const traversal = f(f(f(OFFLINE_SOURCE.minTraversalPerTree) / movement) * (replay ? 0.5 : 1));
  const regularTime = Math.max(f(count / rate), f(traversal * count));
  let bossTime = 0;
  if (wave === 4) {
    if (bossDps.amount.compare(0) <= 0) return { combatTime: Infinity, regularKillRate: rate };
    const duration = bossHealth.div(bossDps).amount.toNumber();
    if (!Number.isFinite(duration)) return { combatTime: Infinity, regularKillRate: rate };
    bossTime = Math.max(f(duration), minAction);
  }
  const combatTime = f(regularTime + bossTime);
  return { combatTime: !Number.isFinite(combatTime) || combatTime > OFFLINE_SOURCE.stageTimeLimit ? Infinity : combatTime,
    regularKillRate: rate };
}
/** Exported to verify source combat cases without spending offline funds. */
export function calculateOfflineClearInfo(input: OfflineProgressInput): OfflineClearInfo {
  const engine = new OfflineProgressEngine(input);
  return engine.currentClearInfo();
}

/** Pure state machine. The synchronous and frame-sliced paths execute identical
 * iterations; yielding never grants money or consumes simulated time itself. */
export class OfflineProgressEngine {
  private readonly startGold: OriginalInfVal;
  private readonly startLevels: OfflineLevels;
  private readonly m: OfflineModifiers;
  private readonly weapons: readonly OfflineWeapon[];
  private readonly elapsed: OfflineElapsed;
  private readonly history: number;
  private readonly buff: number;
  private money: OriginalInfVal;
  private accumulated: OriginalInfVal;
  private levels: OfflineLevels;
  private stage: number;
  private wave: number;
  private timeLeft: number;
  private iterations = 0;
  private cleared = 0;
  private cached?: { key: string; info: OfflineClearInfo; perSecond: OriginalInfVal; perStage: OriginalInfVal };
  private completed?: OfflineProgressResult;

  constructor(input: OfflineProgressInput) {
    validateStagePosition(input);
    if (input.levels.length !== 3 || !input.levels.every(isUpgradeLevel)) throw new Error('Invalid offline upgrade levels');
    if (!Number.isSafeInteger(input.stageValueMax) || input.stageValueMax < 0) throw new Error('Invalid offline history');
    if (!Number.isFinite(input.elapsedSeconds) || input.elapsedSeconds < 0 ||
      (input.absentSeconds !== undefined && (!Number.isFinite(input.absentSeconds) || input.absentSeconds < 0))) throw new Error('Invalid offline duration');
    if (input.gold.amount.isNegative || input.moneyAccum?.amount.isNegative) throw new Error('Invalid offline wallet');
    this.levels = [input.levels[0], input.levels[1], input.levels[2]];
    this.startLevels = [...this.levels]; this.startGold = this.money = input.gold;
    this.accumulated = input.moneyAccum ?? zero();
    this.stage = input.stageIndex; this.wave = input.waveIndex; this.history = input.stageValueMax;
    this.timeLeft = f(input.elapsedSeconds);
    const absentSeconds = f(input.absentSeconds ?? input.elapsedSeconds);
    this.elapsed = { elapsedSeconds: this.timeLeft, absentSeconds, isCapped: f(this.timeLeft + 1) < absentSeconds };
    this.m = modifiers(input.modifiers);
    this.buff = this.m.buffPack ? ECONOMY_CONFIG.offline.permanentBuffMultiplier : 1;
    this.weapons = input.weapons.filter((weapon): weapon is OfflineWeapon => weapon !== null).map(weapon => ({ ...weapon }));
  }
  currentClearInfo(): OfflineClearInfo { return { ...this.values().info }; }
  get iterationCount(): number { return this.iterations; }
  get remainingSeconds(): number { return this.timeLeft; }
  get result(): OfflineProgressResult | null { return this.completed ? this.copyResult(this.completed) : null; }

  private price(level: number): OriginalInfVal | null {
    const price = getUpgradePrice(level);
    return price ? OriginalInfVal.fromAmount(price, 3) : null;
  }
  private buyAffordable(): void {
    while (true) {
      let selected = -1;
      for (let i = 0; i < 3; i++) {
        if (this.levels[i] < MAX_UPGRADE_LEVEL && (selected < 0 || this.levels[i] < this.levels[selected])) selected = i;
      }
      if (selected < 0) return;
      const price = this.price(this.levels[selected])!;
      if (this.money.amount.compare(price.amount) < 0) return;
      this.money = this.money.sub(price); this.levels[selected]++;
    }
  }
  private values(): NonNullable<OfflineProgressEngine['cached']> {
    const key = `${this.levels.join(',')}:${this.stage}:${this.wave}`;
    if (this.cached?.key === key) return this.cached;
    const info = clearInfo(this.levels, this.stage, this.wave, this.history, this.weapons, this.m, this.buff);
    const base = OriginalInfVal.fromAmount(getStageMoney(this.stage), getStageMoneyPrecision(this.stage));
    const perTree = base.mul(toInfVal(averageDegree(this.wave, ECONOMY_CONFIG.gold.degreeMultipliers)));
    const count = getStageTreeCount(this.stage) * (this.wave + 1);
    const perStage = perTree.mul(count).add(this.wave === 4 ? base.mul(toInfVal(ECONOMY_CONFIG.gold.degreeMultipliers[3])) : zero());
    this.cached = { key, info, perSecond: info.regularKillRate <= 0 ? zero() : this.applyMoney(perTree).mul(toInfVal(info.regularKillRate)),
      perStage: this.applyMoney(perStage) };
    return this.cached;
  }
  private applyMoney(value: OriginalInfVal): OriginalInfVal {
    const m = this.m;
    return value.mul(getUpgradeMultiplier('money', this.levels[2])).div(100).mul(m.rebirthMoney).div(100)
      .mul(m.skinMoney).div(100).mul(Math.trunc(m.petMoney.amount.toNumber())).div(100)
      .mul(m.relicMoney).div(100).mul(this.buff);
  }
  private addIncome(value: OriginalInfVal): void {
    this.money = this.money.add(value); this.accumulated = this.accumulated.add(value);
  }
  private waitForUpgrade(perSecond: OriginalInfVal): number {
    if (perSecond.amount.compare(0) <= 0) return Infinity;
    let cheapest: OriginalInfVal | null = null;
    for (const level of this.levels) {
      const price = this.price(level);
      if (price && (!cheapest || price.amount.compare(cheapest.amount) < 0)) cheapest = price;
    }
    if (!cheapest || cheapest.amount.compare(0) <= 0) return Infinity;
    if (this.money.amount.compare(cheapest.amount) >= 0) return 0;
    return f(Math.min(cheapest.sub(this.money).div(perSecond).amount.toNumber(), OFFLINE_SOURCE.maximumUpgradeWaitSeconds));
  }
  private iteration(): void {
    this.buyAffordable();
    const { info, perSecond, perStage } = this.values();
    const clearDuration = Number.isFinite(info.combatTime)
      ? f(f(info.combatTime * f(ECONOMY_CONFIG.offline.clearTimeScale)) + f(ECONOMY_CONFIG.offline.stageClearDelaySeconds)) : Infinity;
    if (Number.isFinite(clearDuration) && clearDuration <= this.timeLeft) {
      this.addIncome(perStage); this.timeLeft = f(this.timeLeft - clearDuration);
      const next = nextStagePosition({ stageIndex: this.stage, waveIndex: this.wave });
      if (stageValue(next) <= this.history) { this.stage = next.stageIndex; this.wave = next.waveIndex; this.cleared++; }
      return;
    }
    if (!Number.isFinite(clearDuration)) {
      const wait = this.waitForUpgrade(perSecond);
      if (Number.isFinite(wait) && wait <= this.timeLeft) {
        this.addIncome(perSecond.mul(toInfVal(wait))); this.timeLeft = f(this.timeLeft - wait); return;
      }
    }
    if (perSecond.amount.compare(0) > 0) this.addIncome(perSecond.mul(toInfVal(this.timeLeft)));
    this.finish();
  }
  private finish(): void {
    this.buyAffordable();
    this.completed = { ...this.elapsed, moneyGained: this.money.sub(this.startGold), moneyFinal: this.money,
      moneyAccumFinal: this.accumulated, levels: [...this.levels],
      levelsGained: [this.levels[0] - this.startLevels[0], this.levels[1] - this.startLevels[1], this.levels[2] - this.startLevels[2]],
      stageIndex: this.stage, waveIndex: this.wave, stageValueMax: this.history, stagesCleared: this.cleared };
  }
  private copyResult(result: OfflineProgressResult): OfflineProgressResult {
    return { ...result, levels: [...result.levels], levelsGained: [...result.levelsGained] };
  }
  step(frameBudgetMs: number = OFFLINE_SOURCE.frameBudgetMs, now: () => number = clock): OfflineProgressResult | null {
    if (frameBudgetMs <= 0 || Number.isNaN(frameBudgetMs)) throw new Error('Invalid offline frame budget');
    if (this.completed) return this.copyResult(this.completed);
    const started = now(); let ran = false;
    while (!this.completed) {
      if (this.timeLeft <= f(OFFLINE_SOURCE.remainingSecondsEpsilon) || this.iterations >= OFFLINE_SOURCE.maxIterations) { this.finish(); break; }
      if (ran && now() - started >= frameBudgetMs) break;
      this.iterations++; this.iteration(); ran = true;
    }
    return this.result;
  }
}
export function runOfflineProgress(input: OfflineProgressInput): OfflineProgressResult {
  return new OfflineProgressEngine(input).step(Infinity)!;
}
export async function runOfflineProgressAsync(input: OfflineProgressInput, options: OfflineAsyncOptions): Promise<OfflineProgressResult> {
  const engine = new OfflineProgressEngine(input);
  let result: OfflineProgressResult | null;
  while (!(result = engine.step(options.frameBudgetMs, options.now))) await options.yieldFrame();
  return result;
}
