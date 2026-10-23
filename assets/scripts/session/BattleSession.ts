import type { CombatEvent, CombatModifiers, CombatStats, OreState, TreeState, Vec2 } from '../core/types';
import { WEAPON_CONFIG } from '../core/config';
import { DecimalAmount } from '../core/DecimalAmount';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { OriginalInfVal } from '../core/OriginalInfVal';
import { computeOfflineElapsed, runOfflineProgressAsync } from './OfflineProgressSimulator';
import type { OfflineProgressInput, OfflineProgressResult } from './OfflineProgressSimulator';
import { getWeapon } from '../core/WeaponCatalog';
import type { WeaponDefinition } from '../core/WeaponCatalog';
import { getStarPercent, WeaponInventory } from './WeaponInventory';
import type { WeaponInventoryOptions } from './WeaponInventory';
import { fullUpgradeBudget, getUpgradeMultiplier, getUpgradePrice, getUpgradeValue, isUpgradeLevel, isUpgradeType,
  MAX_UPGRADE_LEVEL, UPGRADE_SOURCE, UPGRADE_TYPES } from './UpgradeEconomy';
import type { UpgradeState, UpgradeType } from './UpgradeEconomy';
import { getRebirthPercent } from './RebirthEconomy';
import { RebirthSystem } from './RebirthSystem';
import type { RebirthActionResult, RebirthAdOutcome, RebirthKind, RebirthSnapshot, RebirthTestConfiguration } from './RebirthSystem';
import { MAIN_ROUND_SECONDS, StageProgression, validateStagePosition } from './StageProgression';
import type { StageModifiers, StagePhase, StagePosition, StageRound, StageSkip, StageTransition } from './StageProgression';
import { SPEED_RUN_SECONDS, SpeedRunSystem } from './SpeedRunSystem';
import type { SpeedRunActionResult, SpeedRunAdOutcome, SpeedRunSnapshot, SpeedRunTestConfiguration } from './SpeedRunSystem';
import { BOSS_SECONDS, BossSystem } from './BossSystem';
import type { BossActionResult, BossAdOutcome, BossHealth, BossSnapshot, BossTestConfiguration } from './BossSystem';
import { RAID_SECONDS, RaidSystem, raidReward } from './RaidSystem';
import type { RaidActionResult, RaidAdOutcome, RaidSnapshot, RaidTestConfiguration } from './RaidSystem';
import type { RaidBossCombat } from '../core/RaidBossCombat';
import { resolveContentConfig } from './ContentConfig';
import type { ResolvedContentConfig } from './ContentConfig';
import { ContentUnlockManager } from './ContentUnlockManager';
import type { ContentId, ContentState } from './ContentUnlockManager';
import { TutorialManager } from './TutorialManager';
import type { TutorialSnapshot } from './TutorialManager';
import { SkinSystem } from './SkinSystem';
import { PetSystem, PET_DRAW_PRICE } from './PetSystem';
import { FishSystem, FISH_DRAW_PRICE } from './FishSystem';
import { DailyCheckSystem, dailyCheckDay } from './DailyCheckSystem';
import { AdventureSystem } from './AdventureSystem';
import type { AdventureActionResult, AdventureSnapshot, CoreType } from './AdventureSystem';
import { RelicSystem } from './RelicSystem';
import type { RelicActionResult, RelicSnapshot } from './RelicSystem';
import type { DailyCheckSnapshot, DailyCheckResult } from './DailyCheckSystem';
export type { DailyCheckSnapshot, DailyCheckResult } from './DailyCheckSystem';
import type { FishSnapshot, FishActionResult, FishSave, FishDrawKind } from './FishSystem';
import { HuntSystem } from './HuntSystem';
import { AttackSpeedBuff, MINE_SECONDS, MineSystem } from './MineSystem';
import type { AttackSpeedBuffSave, MineActionResult, MineAdKind, MineSave, MineSnapshot, MineTestConfiguration } from './MineSystem';
import type { RewardedAdOutcome } from './RewardedAds';
import type { HuntSnapshot, HuntSave, HuntActionResult } from './HuntSystem';
import { HuntCombat } from '../core/HuntCombat';
import type { PetSnapshot, PetActionResult, PetSlotRef, PetCurrency, PetSave } from './PetSystem';
import type { SkinActionResult, SkinSnapshot } from './SkinSystem';
export type { SkinActionResult, SkinSnapshot } from './SkinSystem';
export type { UpgradeState, UpgradeType } from './UpgradeEconomy';
export { MAIN_ROUND_SECONDS } from './StageProgression';
export type { StageModifiers, StagePhase, StageRound } from './StageProgression';
export type { RebirthActionResult, RebirthAdOutcome, RebirthKind, RebirthSnapshot, RebirthTestConfiguration } from './RebirthSystem';
export type { SpeedRunActionResult, SpeedRunAdOutcome, SpeedRunSnapshot, SpeedRunTestConfiguration } from './SpeedRunSystem';
export type { BossActionResult, BossAdOutcome, BossHealth, BossSnapshot, BossTestConfiguration } from './BossSystem';
export type { RaidActionResult, RaidAdOutcome, RaidSnapshot, RaidTestConfiguration, RaidWeaponSource } from './RaidSystem';
export type { MineActionResult, MineAdKind, MineSnapshot, MineTestConfiguration } from './MineSystem';
export type { OfflineProgressResult } from './OfflineProgressSimulator';
export type { AdventureActionResult, AdventureSnapshot, CoreType } from './AdventureSystem';
export type { RelicActionResult, RelicSnapshot } from './RelicSystem';

export interface OfflineProgressBefore extends StagePosition {
  readonly levels: readonly [number, number, number]; readonly gold: OriginalInfVal;
}
export type OfflineInitializationResult = { ok: true; result: OfflineProgressResult | null } | { ok: false; reason: 'saveFailed' };
interface OfflineSaveOverride { gold: OriginalInfVal; levels: readonly number[]; progress: StagePosition; lastSavedUtcMs: number; }

/** Source UI_type order. Raid（突袭）and Boss（独立 BOSS 玩法）are separate modes. */
export const BATTLE_MODES = ['Main', 'SpeedRun', 'Mine', 'Boss', 'Monster', 'Raid'] as const;
export type BattleMode = typeof BATTLE_MODES[number];
export interface EconomyStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export type RedeemCodeResult = { ok: true; diamonds: number } |
  { ok: false; reason: 'invalidCode' | 'alreadyUsed' | 'saveFailed' | 'walletLimit' };
export interface BattleSessionOptions {
  environment?: 'test' | 'production'; storage?: EconomyStorage;
  contentConfig?: ResolvedContentConfig;
  now?: WeaponInventoryOptions['now']; rng?: WeaponInventoryOptions['rng']; onWeaponsChanged?: WeaponInventoryOptions['onMutation'];
  onStageCleared?: (round: Readonly<StageRound>) => void;
  onRebirthCompleted?: (state: Readonly<RebirthSnapshot>) => void;
  progressionModifiers?: Partial<StageModifiers>;
}
export interface ProgressionTestConfiguration extends Partial<StagePosition> {
  stageValueMax?: number; skipPercent?: number;
}
export interface SessionActorLoadout {
  actorIndex: number; weapon: WeaponDefinition; damage: DecimalAmount; damagePrecision: number; attackInterval: number;
  criticalChance: number; criticalMultiplier: number; starLevel: number;
  criticalRelicPercent?: OriginalInfVal;
  /** Raid stars belong to the preparation slot; actors themselves remain compact. */
  raidSlot?: number;
}
export const ECONOMY_SAVE_VERSION = 3;
let fishSessionSerial = 0;
/** Coefficient-length budget for untrusted saved representations, not a gameplay
 * magnitude cap. The exponent may be any safe integer, including high-stage gold. */
export const MAX_SAVED_DECIMAL_SPAN = 100000;
export function economyStorageKey(environment: 'test' | 'production'): string { return `forest-gunner:economy:v3:${environment}`; }
export function weaponCatalogBackupStorageKey(environment: 'test' | 'production', sourceVersion: 1 | 2 | 3 = 1): string {
  return `${economyStorageKey(environment)}:weapon-catalog-v${sourceVersion}-backup`;
}

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
  phase: StagePhase;
  roundId: number;
  canFight: boolean;
  stageReplay: boolean;
  stageTransition?: StageTransition;
  stageSkip?: StageSkip;
}

export interface TreeReward {
  treeId: number;
  position: Vec2;
  amount: DecimalAmount;
  sourceTime: number;
}

/** Persistent economy is separate from the round and its one-payment-per-tree ledger. */
export class BattleSession {
  private currentMode: BattleMode = 'Main';
  private gold = OriginalInfVal.fromAmount(DecimalAmount.from(ECONOMY_CONFIG.newGame.gold));
  private get money(): DecimalAmount { return this.gold.amount; }
  private readonly levels = [0, 0, 0];
  readonly weapons: WeaponInventory;
  readonly content: ContentUnlockManager;
  private readonly tutorial: TutorialManager;
  private contentProgress = { challengeUnlocked: false, weaponsUnlocked: false, firstDrawGranted: false };
  private readonly rewardedTrees = new Set<number>();
  private readonly storage?: EconomyStorage;
  private readonly storageKey: string;
  private readonly environment: 'test' | 'production';
  private readonly progression: StageProgression;
  private restoredPosition: StagePosition = { stageIndex: 0, waveIndex: 0 };
  private mutationDepth = 0;
  private pendingSave = false;
  private readonly onStageCleared?: BattleSessionOptions['onStageCleared'];
  private readonly onRebirthCompleted?: BattleSessionOptions['onRebirthCompleted'];
  private reportedStorageFailure = false;
  /** Never let constructor autosave overwrite an unreadable save or an
   * unbacked-up legacy catalog. Valid restored state can still run in memory. */
  private storageWriteBlocked = false;
  private readonly clock: () => number;
  private restoredRaw: string | null = null;
  private restoredCheckpoint: number | null = null;
  private checkpointUtcMs = 0;
  private offlineInput: OfflineProgressInput | null = null;
  private offlineBeforeValue: Readonly<OfflineProgressBefore> | null = null;
  private offlineResultValue: OfflineProgressResult | null = null;
  private offlineRequest: Promise<OfflineInitializationResult> | null = null;
  private offlineWrite: { raw: string; before: string | null; result: OfflineProgressResult; lastSavedUtcMs: number; uncertain: boolean } | null = null;
  private readonly rebirth: RebirthSystem;
  private rebirthStoppedRoundId: number | null = null;
  private readonly speedRun: SpeedRunSystem;
  private readonly boss: BossSystem;
  private readonly raid: RaidSystem;
  private readonly skins = new SkinSystem();
  private readonly pets = new PetSystem();
  private readonly fish = new FishSystem();
  private readonly dailyCheck = new DailyCheckSystem();
  private readonly adventure: AdventureSystem;
  private readonly relics = new RelicSystem();
  private malformedAdventure: { value: unknown } | null = null;
  private malformedRelics: { value: unknown } | null = null;
  private adventureAd: { token: string; type: number; index: number; runId: number; day: string; startedAt: number } | null = null;
  private adventureAdSerial = 0;
  private externalSkipPercent = 0;
  private externalRebirthPercent: number | undefined;
  private readonly hunt: HuntSystem;
  private readonly mine: MineSystem;
  private readonly attackSpeedBuff = new AttackSpeedBuff();
  private mineRound: StageRound | null = null;
  private mineCommitInFlight = false;
  private huntCombat?: HuntCombat;
  private huntRound: StageRound | null = null;
  private petAd: { token: string; day: string; revision: number; startedAt: number } | null = null;
  private petAdSerial = 0;
  /** A failed readback must be resolved before any other full-save write. */
  private huntWrite: { raw: string; before: string | null; pets: PetSave; next: HuntSave; kind: 'clear' | 'ad'; uncertain: boolean } | null = null;
  private readonly fishSessionId = ++fishSessionSerial;
  private fishRequestSerial = 0;
  private fishAd: { token: string; day: string; revision: number; startedAt: number } | null = null;
  private readonly fishRandom: () => number;
  private readonly onWeaponsChanged?: BattleSessionOptions['onWeaponsChanged'];
  private skinPurchasePending = false;
  /** Preserve a malformed optional ledger rather than erasing a possible prior claim. */
  private redeemedCodes: unknown = [];
  private redemptionInFlight = false;
  private raidRound: StageRound | null = null;
  private speedRunRound: StageRound | null = null;
  private bossRound: StageRound | null = null;
  /** Different modes reuse tree IDs. Every new world needs a session-wide ID. */
  private roundSerial = 1;

  constructor(options: BattleSessionOptions = {}) {
    const environment = options.environment === 'test' ? 'test' : 'production';
    this.environment = environment;
    this.clock = options.now ?? Date.now;
    this.checkpointUtcMs = this.checkpointTime();
    this.fishRandom = options.rng ?? Math.random;
    this.adventure = new AdventureSystem(this.adventureNow);
    this.externalSkipPercent = options.progressionModifiers?.skipPercent ?? 0;
    const contentConfig = options.contentConfig ?? resolveContentConfig(environment);
    if (contentConfig.environment !== environment) throw new Error('Content configuration environment mismatch');
    this.tutorial = new TutorialManager(contentConfig.tutorialEnabled);
    this.content = new ContentUnlockManager(contentConfig, () => ({
      stageValueMax: this.weapons?.stageValueMax ?? 0,
      currentStageIndex: this.progression?.serialize().stageIndex ?? this.restoredPosition.stageIndex,
      powerLevel: this.levels[0], challengeWins: this.speedRun?.stage ?? 0,
      challengeUnlocked: this.contentProgress.challengeUnlocked, weaponsUnlocked: this.contentProgress.weaponsUnlocked,
      tutorialCompleted: this.tutorial.snapshot().step === 'done',
      huntFirstClear: this.hunt?.firstClear ?? false,
    }));
    this.rebirth = new RebirthSystem(() => this.clock(), this.content);
    this.speedRun = new SpeedRunSystem(this.content);
    this.boss = new BossSystem(this.content);
    this.hunt = new HuntSystem(this.content);
    this.mine = new MineSystem(this.content, () => this.clock());
    this.raid = new RaidSystem(this.content, () => this.weapons.snapshot(), () => this.weapons?.now ?? this.clock(), () => this.skins.totals,
      () => this.fish.totals, () => this.attackSpeedBuff.multiplier, () => this.relics.totals);
    this.onWeaponsChanged = options.onWeaponsChanged;
    this.onStageCleared = options.onStageCleared;
    this.onRebirthCompleted = options.onRebirthCompleted;
    this.storage = options.storage; this.storageKey = economyStorageKey(environment);
    const weaponState = this.restore();
    this.weapons = new WeaponInventory({ environment, content: this.content, now: options.now, rng: options.rng, initialState: weaponState,
      getTutorialState: () => this.tutorial.snapshot(),
      isRewardedAdBusy: () => !!this.adventureAd || this.mine.adPending || !!this.fishAd || !!this.petAd || this.hunt.phase === 'adPending' || this.hunt.settlementPending || this.rebirth.adPending || this.speedRun.phase === 'adPending' || this.boss.phase === 'adPending' || this.raid.adPending || this.raid.active,
      onMutation: (forceBalanceReload, action) => {
        if (this.redemptionInFlight) return;
        if (action) this.tutorial.onWeaponAction(action);
        this.refreshTutorial(); this.save();
        if (!this.skinPurchasePending && this.onWeaponsChanged) this.onWeaponsChanged(forceBalanceReload);
      } });
    this.progression = new StageProgression(this.restoredPosition, { ...options.progressionModifiers, rng: options.rng });
    this.refreshRelicEffects();
    this.progression.startRound(this.weapons.snapshot().stageValueMax);
    const elapsed = this.restoredCheckpoint === null ? null : computeOfflineElapsed(this.restoredCheckpoint, this.clock(), this.relics.totals.offlineMinutes);
    if (elapsed) {
      const inventory = this.weapons.serialize(), skins = this.skins.totals, fish = this.fish.totals;
      const levels: [number, number, number] = [this.levels[0], this.levels[1], this.levels[2]];
      this.offlineBeforeValue = Object.freeze({ ...this.restoredPosition, levels: Object.freeze(levels), gold: this.gold });
      this.offlineInput = { gold: this.gold, levels: [...levels], ...this.restoredPosition, ...elapsed,
        stageValueMax: inventory.stageValueMax, weapons: inventory.equipment.map(item => item ? getWeapon(item.weaponId) : null),
        modifiers: { rebirthDamage: getRebirthPercent('power', this.rebirth.levels[0]),
          rebirthSpeed: getRebirthPercent('speed', this.rebirth.levels[1]), rebirthMoney: getRebirthPercent('money', this.rebirth.levels[2]),
          skinDamage: 100 + skins.damagePercent, skinSpeed: 100 + skins.speedPercent, skinMoney: 100 + skins.moneyPercent,
          petMoney: this.pets.moneyMultiplier, petSpeed: this.pets.moveSpeedPercent,
          fishDamage: fish.damagePercent, fishCriticalChance: fish.criticalChancePercent, fishCriticalDamage: fish.criticalDamagePercent,
          relicDamage: this.relics.totals.damage, relicCriticalDamage: this.relics.totals.criticalDamage, relicMoney: this.relics.totals.money } };
    }
    if (!this.offlineInitializationPending) this.completeStartup();
  }

  /** Called once after the restored economy has been evaluated, never between simulation steps. */
  private completeStartup(): void {
    // Initial test funding is useful before the first rebirth; afterwards a
    // reload must preserve the completed reset instead of refilling its wallet.
    if (this.environment === 'test' && this.content.config.testResources.fundGoldUpgrades && this.rebirth.count === 0) this.fundTestGold();
    this.rebirth.refillTestResources();
    this.fundTestAdventureResources();
    this.refreshContentProgress();
    this.save();
  }

  get offlineInitializationPending(): boolean { return this.offlineInput !== null; }
  get offlineBefore(): Readonly<OfflineProgressBefore> | null { return this.offlineBeforeValue; }
  get offlineResult(): OfflineProgressResult | null { return this.offlineResultValue; }

  /** Cold-load continuation. Repeated calls share one simulation and retry the identical durable candidate. */
  initializeOfflineProgress(yieldFrame: () => Promise<void> = () => Promise.resolve()): Promise<OfflineInitializationResult> {
    if (this.offlineRequest) return this.offlineRequest;
    if (!this.offlineInput) return Promise.resolve({ ok: true, result: this.offlineResultValue });
    const request = this.initializeOffline(yieldFrame);
    this.offlineRequest = request;
    void request.then(() => { if (this.offlineRequest === request) this.offlineRequest = null; },
      () => { if (this.offlineRequest === request) this.offlineRequest = null; });
    return request;
  }

  private async initializeOffline(yieldFrame: () => Promise<void>): Promise<OfflineInitializationResult> {
    if (this.storageWriteBlocked) return { ok: false, reason: 'saveFailed' };
    if (!this.offlineWrite) {
      const result = await runOfflineProgressAsync(this.offlineInput!, { yieldFrame });
      const progress = validateStagePosition(result), lastSavedUtcMs = this.checkpointTime();
      const raw = this.serializeSave(undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        { gold: result.moneyFinal, levels: result.levels, progress, lastSavedUtcMs });
      this.offlineWrite = { raw, before: this.restoredRaw, result, lastSavedUtcMs, uncertain: false };
    }
    const pending = this.offlineWrite;
    if (this.storage) {
      try {
        const current = this.storage.getItem(this.storageKey);
        if (current !== pending.raw) {
          // Another owner changed the save. Do not overwrite it with this cold-load snapshot.
          if (current !== pending.before) return { ok: false, reason: 'saveFailed' };
          try { this.storage.setItem(this.storageKey, pending.raw); }
          catch (error) { this.reportStorageFailure(error); }
          if (this.storage.getItem(this.storageKey) !== pending.raw) return { ok: false, reason: 'saveFailed' };
        }
        pending.uncertain = false;
      } catch (error) {
        // Keep the exact candidate for readback/retry. All ordinary writers stay blocked.
        pending.uncertain = true; this.reportStorageFailure(error); return { ok: false, reason: 'saveFailed' };
      }
    }
    this.gold = pending.result.moneyFinal;
    this.checkpointUtcMs = pending.lastSavedUtcMs;
    pending.result.levels.forEach((level, index) => { this.levels[index] = level; });
    this.progression.setPosition(pending.result);
    this.progression.startRound(this.weapons.serialize().stageValueMax);
    this.rewardedTrees.clear();
    this.offlineResultValue = pending.result;
    this.offlineInput = null; this.offlineWrite = null;
    this.completeStartup();
    return { ok: true, result: this.offlineResultValue };
  }

  /** Bootstrap invokes this every ten foreground seconds and immediately on foreground resume. */
  checkpointForeground(): void { this.save(); }
  private checkpointTime(): number {
    const now = this.clock();
    return Number.isSafeInteger(now) && now >= 0 ? now : this.checkpointUtcMs;
  }

  getContentState(id: ContentId): ContentState { return this.content.get(id); }
  getAdventureState(): AdventureSnapshot & { available: boolean; adPending: boolean; saveInvalid: boolean; relicAlert: boolean } {
    const state = this.adventure.snapshot(this.pets.serialize(), this.adventureNow);
    const relicAlert = !this.malformedRelics && this.relics.snapshot(state.cores).items.some(item => item.canUpgrade);
    // Original ShouldAlert_return only combines finished trips and enough cores to draw.
    // Ability upgrade availability stays on individual ability cards.
    return { ...state, relicAlert,
      available: !this.malformedAdventure && this.content.isUnlocked('adventure'),
      adPending: this.adventureAd !== null, saveInvalid: this.malformedAdventure !== null };
  }
  getRelicState(): RelicSnapshot & { available: boolean; saveInvalid: boolean } {
    const state = this.relics.snapshot(this.adventure.serialize().cores);
    return { ...state, drawMax: state.cores.map(count => this.relicBatchCount(count)), available: !this.malformedRelics && !this.malformedAdventure
      && this.content.isUnlocked('adventure'), saveInvalid: !!(this.malformedRelics || this.malformedAdventure) };
  }
  previewAdventure(type: number, index: number, refs: PetSlotRef[]) {
    return this.adventure.preview(type, index, refs, this.pets.serialize(), this.adventureNow);
  }
  startAdventure(type: number, index: number, refs: PetSlotRef[]): AdventureActionResult {
    return this.adventureCommand(candidate => candidate.start(type, index, refs, this.pets.serialize(), this.adventureNow));
  }
  cancelAdventure(type: number, index: number): AdventureActionResult {
    return this.adventureCommand(candidate => candidate.cancel(type, index));
  }
  claimAdventure(type: number, index: number): AdventureActionResult {
    return this.adventureCommand(candidate => candidate.claim(type, index, this.adventureNow));
  }
  drawRelic(type: CoreType, max = false): RelicActionResult {
    return this.adventureCommand((candidate, relics) => relics.draw(type, max ? this.relicBatchCount(candidate.coreCount(type)) : 1,
      candidate, this.fishRandom), true);
  }
  private relicBatchCount(cores: number): number {
    const affordable = Math.floor(cores / ECONOMY_CONFIG.relics.drawPrice);
    return this.environment === 'test' ? Math.min(affordable, this.content.config.testResources.relicMaxDrawCount) : affordable;
  }
  upgradeRelic(index: number): RelicActionResult {
    return this.adventureCommand((_candidate, relics) => relics.upgrade(index), true);
  }
  beginAdventureAd(type: number, index: number): AdventureActionResult {
    const blocked = this.adventureEligibility(); if (blocked) return blocked;
    if (!this.content.isUnlocked('adventureAd')) return { ok: false, reason: 'contentLocked' };
    const now = this.adventureNow, target = this.adventure.map(type, index, now);
    if (!target) return { ok: false, reason: 'invalid' };
    const candidate = new AdventureSystem(now); candidate.restore(this.adventure.serialize(), this.pets.serialize(), now);
    const eligible = candidate.reduceByAd(type, index, target.runId, now);
    if (!eligible.ok) return eligible;
    const token = `adventure:${this.fishSessionId}:${++this.adventureAdSerial}`;
    this.adventureAd = { token, type, index, runId: target.runId, day: dailyCheckDay(now), startedAt: now };
    return { ok: true, token };
  }
  completeAdventureAd(token: string, outcome: RewardedAdOutcome): AdventureActionResult {
    const request = this.adventureAd;
    if (!request || request.token !== token) return { ok: false, reason: 'staleAd' };
    if (!['success', 'cancel', 'failure'].includes(outcome)) return { ok: false, reason: 'invalid' };
    this.adventureAd = null;
    try {
      if (outcome !== 'success') return { ok: false, reason: outcome };
      if (!this.content.isUnlocked('adventureAd')) return { ok: false, reason: 'contentLocked' };
      const now = this.adventureNow;
      if (dailyCheckDay(now) !== request.day || now < request.startedAt) return { ok: false, reason: 'staleAd' };
      return this.adventureCommand(candidate => candidate.reduceByAd(request.type, request.index, request.runId, now));
    } finally { this.weapons.tick(); }
  }
  private get adventureNow(): number {
    const now = this.weapons?.now ?? this.clock();
    return this.isAdventureTime(now) ? now : this.isAdventureTime(this.checkpointUtcMs) ? this.checkpointUtcMs : 0;
  }
  private isAdventureTime(now: number): boolean {
    // Match the source DateTime/calendar range; malformed clocks are display-only fallbacks.
    return Number.isSafeInteger(now) && now >= 0 && now <= 8640000000000000 && new Date(now).getFullYear() <= 9999;
  }
  private adventureEligibility(relic = false): AdventureActionResult | null {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (!this.content.isUnlocked('adventure')) return { ok: false, reason: 'contentLocked' };
    if (!this.isAdventureTime(this.weapons.now)) return { ok: false, reason: 'invalidTime' };
    if (this.malformedAdventure || relic && this.malformedRelics) return { ok: false, reason: 'invalidSave' };
    if (this.storageWriteBlocked || this.offlineInitializationPending || this.huntWrite) return { ok: false, reason: 'saveFailed' };
    if (this.redemptionInFlight || this.mineCommitInFlight || this.mutationDepth || this.skinPurchasePending || this.adventureAd
      || this.mine.phase !== 'idle' || this.raid.phase !== 'idle' || this.rebirth.adPending || this.rebirthAnimating
      || this.fishAd || this.petAd || this.weapons.snapshot().pendingAd || this.hunt.phase === 'adPending') return { ok: false, reason: 'busy' };
    return null;
  }
  /** Both resource wallets, all ability rows and pet assignment identities commit in one v3 record. */
  private adventureCommand<T extends AdventureActionResult>(operation: (candidate: AdventureSystem, relics: RelicSystem) => T,
    requireRelics = false): T | AdventureActionResult {
    const blocked = this.adventureEligibility(requireRelics); if (blocked) return blocked;
    this.redemptionInFlight = true;
    try {
      const candidate = new AdventureSystem(this.adventureNow), relics = new RelicSystem();
      candidate.restore(this.adventure.serialize(), this.pets.serialize(), this.adventureNow);
      relics.restore(this.relics.serialize());
      const result = operation(candidate, relics); if (!result.ok) return result;
      const adventure = candidate.serialize(), relic = this.malformedRelics ? this.malformedRelics.value : relics.serialize();
      const raw = this.serializeSave(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, adventure, relic);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, raw); } catch (error) { this.reportStorageFailure(error); }
        try { if (this.storage.getItem(this.storageKey) !== raw) return { ok: false, reason: 'saveFailed' }; }
        catch (error) {
          // This write may already have committed. Do not overwrite its cores, assignments or abilities from the old live state.
          this.storageWriteBlocked = true; this.reportStorageFailure(error); return { ok: false, reason: 'saveFailed' };
        }
        // Public inventory APIs can still be invoked by a storage provider. A changed
        // unrelated wallet means the confirmed record is no longer the whole candidate.
        // Preserve the possibly settled trip until reload instead of overwriting it.
        if (this.serializeSave(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, adventure, relic) !== raw) {
          this.storageWriteBlocked = true; return { ok: false, reason: 'saveFailed' };
        }
      }
      this.adventure.restore(adventure, this.pets.serialize(), this.adventureNow);
      if (!this.malformedRelics) this.relics.restore(relic);
      this.pets.setLocks(this.adventure.locks()); this.refreshRelicEffects();
      try { this.onWeaponsChanged?.(true); } catch (error) { console.warn('Adventure notification failed after settlement.', error); }
      return result;
    } finally { this.redemptionInFlight = false; }
  }
  cancelAdventureAd(): void { this.adventureAd = null; this.weapons.tick(); }
  get movementSpeedPercent(): number { return this.pets.moveSpeedPercent + this.relics.totals.moveSpeedPercent; }
  private refreshRelicEffects(): void {
    this.rebirth.configureModifiers({ rewardPercent: this.externalRebirthPercent ?? this.relics.totals.rebirthPercent });
    this.progression?.configure({ skipPercent: Math.min(100, this.externalSkipPercent + this.relics.totals.skipPercent) });
  }
  getDailyCheckState(): DailyCheckSnapshot { return this.dailyCheck.snapshot(dailyCheckDay(this.weapons.now)); }
  /** Seven-day progress and diamonds become visible only after one complete v3 write is confirmed. */
  claimDailyCheck(dayIndex: number): DailyCheckResult {
    const candidate = this.dailyCheck.prepareClaim(dayIndex, dailyCheckDay(this.weapons.now));
    if (!candidate.ok) return candidate;
    if (!this.storage || this.storageWriteBlocked || this.offlineInitializationPending || this.huntWrite
      || this.redemptionInFlight || this.mineCommitInFlight || this.mutationDepth > 0) return { ok: false, reason: 'saveFailed' };
    const weapons = this.weapons.serialize();
    weapons.diamonds += candidate.diamonds;
    if (!Number.isSafeInteger(weapons.diamonds)) return { ok: false, reason: 'walletLimit' };
    this.redemptionInFlight = true;
    try {
      let saved: string;
      try { saved = this.serializeSave(weapons, undefined, undefined, undefined, undefined, undefined, undefined, undefined, candidate.save); }
      catch (error) { this.reportStorageFailure(error); return { ok: false, reason: 'saveFailed' }; }
      try { this.storage.setItem(this.storageKey, saved); }
      catch (error) { this.reportStorageFailure(error); }
      try {
        if (this.storage.getItem(this.storageKey) !== saved) return { ok: false, reason: 'saveFailed' };
      } catch (error) {
        // An unreadable write may have committed: preserve it until reload, never overwrite with the old wallet.
        this.storageWriteBlocked = true; this.reportStorageFailure(error);
        return { ok: false, reason: 'saveFailed' };
      }
      this.dailyCheck.commit(candidate.save);
      this.weapons.grantDiamonds(candidate.diamonds);
    } finally { this.redemptionInFlight = false; }
    try { this.onWeaponsChanged?.(false); }
    catch (error) { console.warn('Daily check notification failed after settlement.', error); }
    return { ok: true, dayIndex: candidate.dayIndex, diamonds: candidate.diamonds };
  }
  /** Claim and reward share one durable v3 save; only a confirmed commit changes the live wallet. */
  redeemCode(input: string): RedeemCodeResult {
    const reward = typeof input === 'string' ? ECONOMY_CONFIG.redeemCodes.find(item => item.code === input.trim()) : undefined;
    if (!reward) return { ok: false, reason: 'invalidCode' };
    const claimed = this.redeemedCodes;
    if (!Array.isArray(claimed) || !claimed.every(code => typeof code === 'string')) return { ok: false, reason: 'saveFailed' };
    if (claimed.includes(reward.code)) return { ok: false, reason: 'alreadyUsed' };
    if (!this.storage || this.storageWriteBlocked || this.offlineInitializationPending || this.huntWrite || this.redemptionInFlight || this.mutationDepth > 0) return { ok: false, reason: 'saveFailed' };
    const diamonds = this.weapons.diamonds + reward.diamonds;
    if (!Number.isSafeInteger(diamonds)) return { ok: false, reason: 'walletLimit' };
    const nextClaims = [...claimed, reward.code], weapons = this.weapons.serialize();
    weapons.diamonds = diamonds;
    this.redemptionInFlight = true;
    try {
      let saved: string;
      try { saved = this.serializeSave(weapons, nextClaims); }
      catch (error) { this.reportStorageFailure(error); return { ok: false, reason: 'saveFailed' }; }
      try { this.storage.setItem(this.storageKey, saved); }
      catch (error) { this.reportStorageFailure(error); }
      // Resolve a provider throwing after its atomic write, and reject silent write failures.
      // If readback itself fails, later autosaves must not overwrite a possibly committed reward.
      try {
        if (this.storage.getItem(this.storageKey) !== saved) return { ok: false, reason: 'saveFailed' };
      } catch (error) {
        this.storageWriteBlocked = true; this.reportStorageFailure(error);
        return { ok: false, reason: 'saveFailed' };
      }
      this.redeemedCodes = nextClaims;
      // Overflow was checked before the durable write. Suppress the ordinary inventory
      // autosave/notification until both in-memory parts match the committed record.
      this.weapons.grantDiamonds(reward.diamonds);
    } finally { this.redemptionInFlight = false; }
    // A presentation failure cannot turn a committed award into an unsuccessful claim.
    try { this.onWeaponsChanged?.(false); }
    catch (error) { console.warn('Redemption notification failed after settlement.', error); }
    return { ok: true, diamonds: reward.diamonds };
  }
  private get fishDay(): string {
    const date = new Date(this.weapons.now);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  private isAutoMergeUnlocked(content: 'fish' | 'pets'): boolean {
    return this.content.isUnlocked(content) && this.content.isUnlocked('autoMerge');
  }
  getFishState(): FishSnapshot { return this.fish.snapshot(this.weapons.diamonds, this.fishDay, this.isAutoMergeUnlocked('fish')); }
  private fishEligibility(): FishActionResult | null {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (!this.content.isUnlocked('fish')) return { ok: false, reason: 'contentLocked' };
    if (this.adventureAd || this.mine.adPending || this.fishAd || this.petAd || this.hunt.phase === 'adPending' || this.raid.phase !== 'idle' || this.getRebirthState().phase !== 'idle' || this.weapons.snapshot().pendingAd
      || this.redemptionInFlight || this.mutationDepth || this.skinPurchasePending) return { ok: false, reason: 'busy' };
    if (this.storageWriteBlocked || this.offlineInitializationPending) return { ok: false, reason: 'saveFailed' };
    return null;
  }
  /** One complete candidate is persisted before either fish or diamonds become visible. */
  private fishCommand(operation: (candidate: FishSystem) => FishActionResult, diamondCost = 0): FishActionResult {
    const blocked = this.fishEligibility(); if (blocked) return blocked;
    this.redemptionInFlight = true;
    try {
      const candidate = new FishSystem(); candidate.restore(this.fish.serialize());
      const result = operation(candidate); if (!result.ok || !result.changed) return result;
      const weapons = this.weapons.serialize();
      if (weapons.diamonds < diamondCost) return { ok: false, reason: 'currency' };
      weapons.diamonds -= diamondCost;
      if (this.storage) {
        const raw = this.serializeSave(weapons, this.redeemedCodes, this.pets.serialize(), candidate.serialize());
        try { this.storage.setItem(this.storageKey, raw); } catch (error) { this.reportStorageFailure(error); }
        try { if (this.storage.getItem(this.storageKey) !== raw) return { ok: false, reason: 'saveFailed' }; }
        catch (error) { this.storageWriteBlocked = true; this.reportStorageFailure(error); return { ok: false, reason: 'saveFailed' }; }
      }
      this.fish.restore(candidate.serialize());
      if (diamondCost) this.weapons.spendDiamonds(diamondCost);
      return result;
    } finally { this.redemptionInFlight = false; }
  }
  drawFish(kind: FishDrawKind): FishActionResult {
    return this.fishCommand(candidate => candidate.draw(kind, this.weapons.diamonds, this.fishDay, this.fishRandom), kind === 'diamonds' ? FISH_DRAW_PRICE : 0);
  }
  mergeFish(from: number, to: number, expectedGrade?: number, automatic = false, expectedRevision?: number): FishActionResult {
    if (automatic && !this.isAutoMergeUnlocked('fish')) return { ok: false, reason: 'contentLocked' };
    if (expectedRevision !== undefined && expectedRevision !== this.getFishState().revision) return { ok: false, reason: 'stale' };
    return this.fishCommand(candidate => candidate.merge(from, to, expectedGrade, automatic));
  }
  removeFish(index: number, expectedGrade?: number, expectedRevision?: number): FishActionResult {
    if (expectedRevision !== undefined && expectedRevision !== this.getFishState().revision) return { ok: false, reason: 'stale' };
    return this.fishCommand(candidate => candidate.remove(index, expectedGrade));
  }
  setFishAutoMerge(enabled: boolean): FishActionResult {
    if (enabled && !this.isAutoMergeUnlocked('fish')) return { ok: false, reason: 'contentLocked' };
    return this.fishCommand(candidate => candidate.setAuto(enabled));
  }
  beginFishAd(): FishActionResult {
    const blocked = this.fishEligibility(); if (blocked) return blocked;
    if (!this.content.isUnlocked('fishDailyAd')) return { ok: false, reason: 'adsDisabled' };
    const state = this.getFishState();
    if (state.inventory.length >= state.capacity) return { ok: false, reason: 'full' };
    if (!state.freeDrawNeedsAd) return { ok: false, reason: state.freeDrawRemaining ? 'invalid' : 'dailyLimit' };
    const token = `fish:${this.fishSessionId}:${++this.fishRequestSerial}`;
    this.fishAd = { token, day: this.fishDay, revision: state.revision, startedAt: this.weapons.now };
    return { ok: true, token };
  }
  completeFishAd(token: string, outcome: import('./RewardedAds').RewardedAdOutcome): FishActionResult {
    const request = this.fishAd;
    if (!request || request.token !== token) return { ok: false, reason: 'staleAd' };
    if (!['success', 'cancel', 'failure'].includes(outcome)) return { ok: false, reason: 'invalidAdOutcome' };
    this.fishAd = null;
    try {
      if (outcome !== 'success') return { ok: false, reason: outcome === 'cancel' ? 'cancelled' : 'failure' };
      if (!this.content.isUnlocked('fishDailyAd')) return { ok: false, reason: 'adsDisabled' };
      if (request.day !== this.fishDay || request.revision !== this.getFishState().revision || this.weapons.now < request.startedAt)
        return { ok: false, reason: 'staleAd' };
      return this.fishCommand(candidate => candidate.draw('free', this.weapons.diamonds, this.fishDay, this.fishRandom, true));
    } finally { this.weapons.tick(); }
  }
  cancelFishAd(): void { this.fishAd = null; this.weapons.tick(); }
  getPetState(): PetSnapshot { return this.pets.snapshot(this.weapons.diamonds, this.money.format(), this.fishDay, this.isAutoMergeUnlocked('pets')); }
  beginPetAd(): PetActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (!this.content.isUnlocked('petDailyAd')) return { ok: false, reason: 'contentLocked' };
    if (this.adventureAd || this.mine.adPending || this.petAd || this.fishAd || this.hunt.phase === 'adPending' || this.raid.phase !== 'idle'
      || this.getRebirthState().phase !== 'idle' || this.weapons.snapshot().pendingAd || this.redemptionInFlight || this.mutationDepth)
      return { ok: false, reason: 'busy' };
    if (this.storageWriteBlocked || this.offlineInitializationPending) return { ok: false, reason: 'saveFailed' };
    const state = this.getPetState();
    if (!state.owned.includes(-1)) return { ok: false, reason: 'full' };
    if (!state.dailyAdRemaining) return { ok: false, reason: 'dailyLimit' };
    const token = `pet:${this.fishSessionId}:${++this.petAdSerial}`;
    this.petAd = { token, day: this.fishDay, revision: state.revision, startedAt: this.weapons.now };
    return { ok: true, token };
  }
  completePetAd(token: string, outcome: import('./RewardedAds').RewardedAdOutcome): PetActionResult {
    const request = this.petAd;
    if (!request || request.token !== token) return { ok: false, reason: 'staleAd' };
    if (!['success', 'cancel', 'failure'].includes(outcome)) return { ok: false, reason: 'invalid' };
    this.petAd = null;
    try {
      if (outcome !== 'success') return { ok: false, reason: outcome };
      if (!this.content.isUnlocked('petDailyAd')) return { ok: false, reason: 'contentLocked' };
      if (request.day !== this.fishDay || request.revision !== this.getPetState().revision || this.weapons.now < request.startedAt)
        return { ok: false, reason: 'staleAd' };
      return this.petCommand(candidate => candidate.claimDailyAd(this.fishDay));
    } finally { this.weapons.tick(); }
  }
  cancelPetAd(): void { this.petAd = null; this.weapons.tick(); }
  get petMovementPercent(): number { return this.movementSpeedPercent; }
  private petCommand(operation: (candidate: PetSystem) => PetActionResult, diamondCost = 0): PetActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (!this.content.isUnlocked('pets')) return { ok: false, reason: 'contentLocked' };
    if (this.malformedAdventure) return { ok: false, reason: 'invalidSave' };
    if (this.adventureAd || this.mine.adPending || this.raid.phase !== 'idle' || this.getRebirthState().phase !== 'idle' || this.weapons.snapshot().pendingAd || this.fishAd || this.petAd || this.hunt.phase === 'adPending' || this.redemptionInFlight || this.mutationDepth)
      return { ok: false, reason: 'busy' };
    if (this.storageWriteBlocked || this.offlineInitializationPending) return { ok: false, reason: 'saveFailed' };
    this.redemptionInFlight = true;
    try {
    const candidate = new PetSystem(); candidate.restore(this.pets.serialize()); candidate.setLocks(this.adventure.locks());
    const result = operation(candidate);
    if (!result.ok || !result.changed) return result;
    const weapons = this.weapons.serialize();
    if (weapons.diamonds < diamondCost) return { ok: false, reason: 'currency' };
    weapons.diamonds -= diamondCost;
    // Persist one complete candidate before publishing either half of the transaction.
    if (this.storage) {
      const raw = this.serializeSave(weapons, this.redeemedCodes, candidate.serialize());
      try { this.storage.setItem(this.storageKey, raw); } catch (error) { this.reportStorageFailure(error); }
      try { if (this.storage.getItem(this.storageKey) !== raw) return { ok: false, reason: 'saveFailed' }; }
      catch (error) { this.storageWriteBlocked = true; this.reportStorageFailure(error); return { ok: false, reason: 'saveFailed' }; }
    }
    this.pets.restore(candidate.serialize()); this.pets.setLocks(this.adventure.locks()); if (diamondCost) this.weapons.spendDiamonds(diamondCost);
    return result;
    } finally { this.redemptionInFlight = false; }
  }
  drawPet(currency: PetCurrency): PetActionResult { return this.petCommand(p => p.draw(currency, this.weapons.diamonds), currency === 'diamonds' ? PET_DRAW_PRICE : 0); }
  movePet(from: PetSlotRef, to: PetSlotRef, expected?: number, swapVacancy?: number): PetActionResult { return this.petCommand(p => p.move(from, to, expected, swapVacancy)); }
  equipPet(ownedIndex: number, selectedIndex: number, expected?: number): PetActionResult { return this.movePet({ kind: 'owned', index: ownedIndex }, { kind: 'selected', index: selectedIndex }, expected); }
  unequipPet(index: number): PetActionResult { return this.petCommand(p => p.unequip(index)); }
  mergePets(from: number, to: number, expected?: number, automatic = false): PetActionResult {
    if (automatic && !this.isAutoMergeUnlocked('pets')) return { ok: false, reason: 'contentLocked' };
    return this.petCommand(p => p.merge(from, to, expected, automatic));
  }
  setPetAutoMerge(enabled: boolean): PetActionResult {
    if (enabled && !this.isAutoMergeUnlocked('pets')) return { ok: false, reason: 'contentLocked' };
    return this.petCommand(p => p.setAuto(enabled));
  }
  getSkinState(): SkinSnapshot { return this.skins.snapshot(this.weapons.diamonds); }
  private skinCommandGuard(): SkinActionResult | null {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (this.adventureAd || this.mine.adPending || this.raid.phase !== 'idle' || this.getRebirthState().phase !== 'idle' || this.weapons.snapshot().pendingAd || this.fishAd || this.petAd || this.skinPurchasePending)
      return { ok: false, reason: 'busy' };
    if (!this.content.isUnlocked('skins')) return { ok: false, reason: 'contentLocked' };
    return null;
  }
  purchaseSkin(id: number): SkinActionResult {
    const blocked = this.skinCommandGuard(); if (blocked) return blocked;
    this.mutationDepth++; this.skinPurchasePending = true;
    let result: SkinActionResult;
    try {
      result = this.skins.purchase(id, this.weapons.diamonds, price => this.weapons.spendDiamonds(price).ok);
      if (result.ok) this.save();
    } finally { this.skinPurchasePending = false; this.finishMutation(); }
    // Notify only after both ownership and wallet have committed. Even a
    // clamped attack interval must reset spread, preserving cooldown/bullets.
    if (result.ok && this.onWeaponsChanged) this.onWeaponsChanged(true);
    return result;
  }
  equipSkin(id: number): SkinActionResult {
    const blocked = this.skinCommandGuard(); if (blocked) return blocked;
    const result = this.skins.equip(id);
    if (result.ok && result.changed) this.save();
    return result;
  }
  getTutorialState(): TutorialSnapshot { return this.tutorial.snapshot(); }
  /** UI opening is a semantic event, not a pointer press; reload/reopen cannot repeat the grant. */
  onWeaponPanelOpened(): void {
    if (this.mode !== 'Main' || !this.content.isUnlocked('weapons')) return;
    this.mutationDepth++;
    try {
      this.tutorial.onWeaponPanelOpened();
      // Also support players who opted out of the tutorial. The first actual
      // visit to the weapon panel receives the same one-time draw budget.
      if (!this.contentProgress.firstDrawGranted) {
        this.contentProgress.firstDrawGranted = true;
        const topUp = this.content.config.firstDrawDiamonds - this.weapons.diamonds;
        if (topUp > 0) this.weapons.grantDiamonds(topUp);
      }
      this.refreshTutorial(); this.save();
    } finally { this.finishMutation(); }
  }
  private refreshTutorial(): void {
    if (!this.weapons) return;
    this.tutorial.sync({ weaponsUnlocked: this.content.isUnlocked('weapons') });
  }
  /** Test-only, explicit refill. Rebirth still clears gold and ordinary levels. */
  refillTestResources(): boolean {
    if (this.redemptionInFlight || this.adventureAd || this.environment !== 'test' || this.mode !== 'Main' || this.getRebirthState().phase !== 'idle' || this.weapons.snapshot().pendingAd || this.fishAd || this.petAd) return false;
    this.mutationDepth++;
    try {
      if (this.content.config.testResources.fundGoldUpgrades) this.fundTestGold();
      this.weapons.refillTestResources(); this.rebirth.refillTestResources(); this.fundTestAdventureResources(); this.save();
      return true;
    } finally { this.finishMutation(); }
  }
  private fundTestAdventureResources(): void {
    if (this.environment !== 'test' || this.malformedAdventure || this.storageWriteBlocked || this.huntWrite || this.offlineInitializationPending) return;
    const resources = this.content.config.testResources;
    this.adventure.ensureResourceFloor(resources.adventureTickets, resources.adventureCores);
  }
  private fundTestGold(): void {
    const budget = fullUpgradeBudget();
    if (this.money.compare(budget) >= 0) return;
    // Explicit test supply retains the full upgrade budget and fractional test
    // rewards. Ordinary play keeps the precision acquired from source income.
    this.gold = OriginalInfVal.fromAmount(budget, budget.digits.length + 17);
  }
  /** Permanent unlocks survive rebirth; the draw grant is issued on opening the weapon panel. */
  private refreshContentProgress(): void {
    if (this.content.isUnlocked('weapons')) {
      this.contentProgress.challengeUnlocked = true;
      this.contentProgress.weaponsUnlocked = true;
    }
    this.refreshTutorial();
  }

  get mode(): BattleMode { return this.currentMode; }
  get moneyBalance(): DecimalAmount { return this.money; }
  get round(): StageRound {
    if (this.mode === 'Mine' && this.mineRound) return { ...this.mineRound, roundId: this.roundSerial };
    if (this.mode === 'Monster' && this.huntRound) return { ...this.huntRound, roundId: this.roundSerial };
    if (this.mode === 'Raid' && this.raidRound) return { ...this.raidRound, roundId: this.roundSerial };
    if (this.mode === 'Boss' && this.bossRound) return { ...this.bossRound, roundId: this.roundSerial };
    return this.mode === 'SpeedRun' && this.speedRunRound
      ? { ...this.speedRunRound, roundId: this.roundSerial }
      : { ...this.progression.round, roundId: this.roundSerial };
  }
  get roundId(): number { return this.roundSerial; }
  get phase(): StagePhase {
    if (this.mode === 'Mine') return this.mine.canFight ? 'playing' : this.mine.phase === 'result' || this.mine.phase === 'adPending' ? 'won' : 'loading';
    if (this.mode === 'Monster') return this.hunt.canFight ? 'playing' : this.hunt.phase === 'failed' || this.hunt.phase === 'adPending' ? 'failed' : 'loading';
    if (this.mode === 'Raid') return this.raid.phase === 'playing' ? 'playing' : this.raid.phase === 'result' ? 'won' : 'loading';
    if (this.mode !== 'SpeedRun' && this.mode !== 'Boss') return this.progression.phase;
    const phase = this.mode === 'Boss' ? this.boss.phase : this.speedRun.phase;
    return phase === 'entering' || phase === 'exiting' || phase === 'idle' ? 'loading'
      : phase === 'adPending' ? 'won' : phase;
  }
  get canFight(): boolean {
    if (this.offlineInitializationPending || this.redemptionInFlight) return false;
    if (this.mode === 'Mine') return this.mine.canFight;
    if (this.mode === 'Monster') return this.hunt.canFight;
    if (this.mode === 'Raid') return this.raid.canFight;
    if (this.mode === 'Boss') return this.boss.canFight;
    return this.mode === 'SpeedRun' ? this.speedRun.canFight
      : this.mode === 'Main' && !this.rebirthStopsRound && this.progression.canFight;
  }
  get rebirthAnimating(): boolean { return this.rebirth.animating; }
  /** FX sets is_Play=false once. An already waiting Loading_Then_Start can
   * still run Game_Start, which sets it true for the newly created round. */
  private get rebirthStopsRound(): boolean { return this.rebirthAnimating && this.rebirthStoppedRoundId === this.roundId; }
  getModePhase(mode: 'SpeedRun'): SpeedRunSnapshot['phase'];
  getModePhase(mode: 'Raid'): RaidSnapshot['phase'];
  getModePhase(mode: 'Boss'): BossSnapshot['phase'];
  getModePhase(mode: 'Monster'): HuntSnapshot['phase'];
  getModePhase(mode: 'Mine'): MineSnapshot['phase'];
  getModePhase(mode: BattleMode): StagePhase | SpeedRunSnapshot['phase'] | RaidSnapshot['phase'] | BossSnapshot['phase'] | HuntSnapshot['phase'] | MineSnapshot['phase'];
  getModePhase(mode: BattleMode) {
    if (mode === 'SpeedRun') return this.speedRun.phase;
    if (mode === 'Raid') return this.raid.phase;
    if (mode === 'Boss') return this.boss.phase;
    if (mode === 'Monster') return this.hunt.phase;
    if (mode === 'Mine') return this.mine.phase;
    return this.progression.phase;
  }
  getRebirthState(): RebirthSnapshot { return this.rebirth.snapshot(this.progression.serialize(), this.weapons.stageValueMax); }
  setRebirthModifiers(modifiers: { rewardPercent?: number }): void {
    this.rebirth.configureModifiers(modifiers);
    if (modifiers.rewardPercent !== undefined) this.externalRebirthPercent = modifiers.rewardPercent;
  }
  requestRebirth(kind: RebirthKind): RebirthActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (this.redemptionInFlight) return { ok: false, reason: 'busy' };
    if (this.mine.phase !== 'idle') return { ok: false, reason: 'busy' };
    if (this.adventureAd || this.fishAd || this.petAd || this.raid.phase !== 'idle') return { ok: false, reason: 'busy' };
    const result = this.rebirth.request(kind, this.progression.serialize());
    if (result.ok && this.rebirthAnimating) this.rebirthStoppedRoundId = this.roundId;
    return result;
  }
  completeRebirthAd(token: string, outcome: RebirthAdOutcome): RebirthActionResult {
    if (this.mode !== 'Main') { this.rebirth.cancelAd(); this.weapons.tick(); return { ok: false, reason: 'mode' }; }
    const result = this.rebirth.completeAd(token, outcome, this.progression.serialize());
    if (result.ok && this.rebirthAnimating) this.rebirthStoppedRoundId = this.roundId;
    this.weapons.tick();
    return result;
  }
  cancelRebirthAd(): void { this.rebirth.cancelAd(); this.weapons.tick(); }
  getMineState(): MineSnapshot {
    if (this.mine.refreshCalendar()) this.save();
    return this.mine.snapshot(this.attackSpeedBuff.seconds, this.attackSpeedBuff.multiplier);
  }
  configureMineTest(config: MineTestConfiguration): boolean {
    if (this.environment !== 'test' || this.mode !== 'Main' || this.mineActionBusy || !this.mine.configureTest(config)) return false;
    this.save(); return true;
  }
  get attackSpeedBuffRemainingSeconds(): number { return this.attackSpeedBuff.seconds; }
  get attackSpeedBuffMultiplier(): number { return this.attackSpeedBuff.multiplier; }
  /** Called once per foreground frame, including menus/loading. Paused and ad time do not count. */
  advanceBuff(dt: number, paused = false): void {
    const before = this.attackSpeedBuff.seconds;
    if (!this.attackSpeedBuff.advance(dt, paused || !!this.adventureAd || this.mine.adPending || !!this.fishAd || !!this.petAd
      || this.rebirth.adPending || this.speedRun.phase === 'adPending' || this.boss.phase === 'adPending'
      || this.hunt.phase === 'adPending' || this.raid.adPending || !!this.weapons.snapshot().pendingAd)) return;
    if (this.attackSpeedBuff.seconds === 0) this.onWeaponsChanged?.(true);
    if (Math.ceil(before) !== Math.ceil(this.attackSpeedBuff.seconds)) this.save();
  }
  private get mineActionBusy(): boolean {
    return !!this.adventureAd || !!this.fishAd || !!this.petAd || this.raid.phase !== 'idle' || this.getRebirthState().phase !== 'idle'
      || !!this.weapons.snapshot().pendingAd || this.redemptionInFlight || this.mutationDepth > 0 || !!this.huntWrite;
  }
  openMine(): MineActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (this.mineActionBusy) return { ok: false, reason: 'busy' };
    const result = this.mine.open(); if (result.ok) this.save(); return result;
  }
  closeMine(): MineActionResult { const result = this.mine.close(); this.weapons.tick(); return result; }
  startMine(): MineActionResult { return this.enterMine(false); }
  private enterMine(grantBuff: boolean): MineActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (this.mineActionBusy) return { ok: false, reason: 'busy' };
    const checked = this.mine.checkStart(); if (!checked.ok) return checked;
    const next = this.mine.nextEntrySave(), buff = grantBuff ? this.attackSpeedBuff.nextGrantSeconds() : this.attackSpeedBuff.seconds;
    const saved = this.persistMine(next, 0, buff); if (!saved.ok) return saved;
    this.mine.commitStart(next); this.attackSpeedBuff.setSeconds(buff);
    this.progression.cancelTransition(); this.currentMode = 'Mine';
    this.mineRound = { stageIndex: 0, waveIndex: 0, roundId: ++this.roundSerial, movementMultiplier: 1 };
    this.rewardedTrees.clear();
    if (grantBuff) this.onWeaponsChanged?.(true);
    return { ok: true };
  }
  /** Register the actual generated count only after map/world loading has completed. */
  setMineOreCount(total: number, roundId = this.roundId): void {
    if (this.mode === 'Mine' && roundId === this.roundId) this.mine.setOreCount(total);
  }
  consumeMine(events: readonly CombatEvent[], ores: readonly OreState[], roundId = this.roundId): void {
    if (this.mode !== 'Mine' || roundId !== this.roundId || !this.mine.canFight) return;
    const byId = new Map(ores.map(ore => [ore.id, ore]));
    for (const event of events) {
      if (event.type !== 'oreDied') continue;
      const ore = byId.get(event.oreId);
      if (!ore || ore.alive) continue;
      // Read the validated world's ore class, never a caller-supplied reward value.
      this.mine.recordOre(ore.id, ore.rare ? ECONOMY_CONFIG.mine.rareScore : ECONOMY_CONFIG.mine.normalScore);
    }
    this.retryMineSettlement();
  }
  retryMineSettlement(): MineActionResult {
    if (this.mode !== 'Mine' || !this.mine.settlementPending) return { ok: false, reason: 'inactive' };
    const next = this.mine.resultSave(), result = this.persistMine(next, this.mine.reward);
    if (!result.ok) return result;
    this.mineCommitInFlight = true;
    try {
      this.mine.commitResult(next); this.weapons.grantDiamonds(this.mine.reward);
    } finally { this.mineCommitInFlight = false; }
    return { ok: true };
  }
  exitMine(): MineActionResult {
    if (this.mode !== 'Mine') return { ok: false, reason: 'mode' };
    if (this.mine.settlementPending) { const result = this.retryMineSettlement(); if (!result.ok) return result; }
    const result = this.mine.exit(); this.weapons.tick(); return result;
  }
  requestMineAd(kind: MineAdKind): MineActionResult {
    if ((kind === 'entry' && this.mode !== 'Main') || (kind === 'reward' && this.mode !== 'Mine')) return { ok: false, reason: 'mode' };
    if (this.mineActionBusy) return { ok: false, reason: 'busy' };
    if (kind === 'entry' && this.attackSpeedBuff.seconds > 0) return { ok: false, reason: 'buffActive' };
    if (kind === 'reward' && !Number.isSafeInteger(this.weapons.diamonds + this.mine.additionalReward)) return { ok: false, reason: 'walletLimit' };
    return this.mine.beginAd(kind);
  }
  completeMineAd(token: string, outcome: RewardedAdOutcome): MineActionResult {
    const kind = this.mine.pendingKind;
    const result = this.mine.completeAd(token, outcome);
    if (!result.ok) { this.weapons.tick(); return result; }
    if (kind === 'entry') {
      const entered = this.enterMine(true); this.weapons.tick(); return entered;
    }
    if (kind !== 'reward' || this.mode !== 'Mine') return { ok: false, reason: 'staleAd' };
    const saved = this.persistMine(this.mine.serialize(), this.mine.additionalReward);
    if (!saved.ok) { this.weapons.tick(); return saved; }
    this.mineCommitInFlight = true;
    try {
      this.mine.commitBonus(); this.weapons.grantDiamonds(this.mine.additionalReward); this.mine.exit();
      return { ok: true };
    } finally { this.mineCommitInFlight = false; this.weapons.tick(); }
  }
  cancelMineAd(): void { this.mine.cancelAd(); this.weapons.tick(); }
  /** Persist tickets, best score and wallet in one record before exposing the successful action. */
  private persistMine(mine: MineSave, diamonds = 0, buffSeconds = this.attackSpeedBuff.seconds): MineActionResult {
    if (this.storageWriteBlocked || this.offlineInitializationPending || this.huntWrite || this.redemptionInFlight) return { ok: false, reason: 'saveFailed' };
    const weapons = this.weapons.serialize();
    if (!Number.isSafeInteger(weapons.diamonds + diamonds)) return { ok: false, reason: 'walletLimit' };
    weapons.diamonds += diamonds;
    if (!this.storage) return { ok: true };
    const raw = this.serializeSave(weapons, this.redeemedCodes, this.pets.serialize(), this.fish.serialize(), this.hunt.serialize(), mine,
      { attackSpeedRemainingSeconds: buffSeconds });
    try {
      try { this.storage.setItem(this.storageKey, raw); }
      catch (error) {
        // A storage adapter may throw after writing; verify before deciding it failed.
        if (this.storage.getItem(this.storageKey) !== raw) { this.reportStorageFailure(error); return { ok: false, reason: 'saveFailed' }; }
      }
      if (this.storage.getItem(this.storageKey) !== raw) return { ok: false, reason: 'saveFailed' };
      return { ok: true };
    } catch (error) {
      // Unknown write outcome must never be overwritten by an older in-memory wallet.
      this.storageWriteBlocked = true; this.reportStorageFailure(error); return { ok: false, reason: 'saveFailed' };
    }
  }
  getHuntState(): HuntSnapshot {
    if (this.huntCombat) this.hunt.setProgress(this.huntCombat.kills, this.huntCombat.total, this.huntCombat.barrierHp);
    return this.hunt.snapshot(this.pets.serialize().coins);
  }
  getHuntCombat(): HuntCombat | undefined { return this.huntCombat; }
  startHunt(aspect = 9 / 16, seed = 20261010): HuntActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (this.mine.phase !== 'idle') return { ok: false, reason: 'busy' };
    if (this.adventureAd || this.fishAd || this.petAd || this.raid.phase !== 'idle' || this.getRebirthState().phase !== 'idle'
      || this.weapons.snapshot().pendingAd || this.redemptionInFlight || this.mutationDepth) return { ok: false, reason: 'busy' };
    if (this.storageWriteBlocked) return { ok: false, reason: 'saveFailed' };
    if (!Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(seed)) return { ok: false, reason: 'invalid' };
    if (!Number.isSafeInteger(this.pets.serialize().coins + ECONOMY_CONFIG.hunt.petCoinsPerLevel)) return { ok: false, reason: 'walletLimit' };
    try { this.hunt.nextSave(); } catch (_) { return { ok: false, reason: 'stageLimit' }; }
    const result = this.hunt.start(); if (!result.ok) return result;
    this.huntCombat = new HuntCombat(this.hunt.wave, this.hunt.level, seed, aspect);
    this.progression.cancelTransition(); this.currentMode = 'Monster';
    this.huntRound = { stageIndex: this.hunt.wave, waveIndex: this.hunt.level, roundId: ++this.roundSerial, movementMultiplier: 1 };
    this.rewardedTrees.clear(); return result;
  }
  giveUpHunt(): HuntActionResult {
    if (this.mode !== 'Monster') return { ok: false, reason: 'mode' };
    if (this.hunt.settlementPending && !this.retryHuntSettlement().ok) return { ok: false, reason: 'saveFailed' };
    const result = this.hunt.giveUp(); if (result.ok) this.huntCombat?.stopMotion(); return result;
  }
  exitHunt(): HuntActionResult {
    if (this.mode !== 'Monster') return { ok: false, reason: 'mode' };
    if (this.hunt.settlementPending) {
      if (!this.retryHuntSettlement().ok) return { ok: false, reason: 'saveFailed' };
      if (this.hunt.phase === 'exiting') { this.huntCombat?.stopMotion(); this.weapons.tick(); return { ok: true }; }
    }
    const result = this.hunt.exit(); if (result.ok) this.huntCombat?.stopMotion(); this.weapons.tick(); return result;
  }
  beginHuntAd(): HuntActionResult {
    if (this.mode !== 'Monster') return { ok: false, reason: 'mode' };
    if (this.adventureAd || this.mine.adPending || this.petAd || this.fishAd || this.weapons.snapshot().pendingAd) return { ok: false, reason: 'busy' };
    if (!Number.isSafeInteger(this.pets.serialize().coins + this.hunt.adReward)) return { ok: false, reason: 'walletLimit' };
    return this.hunt.beginAd();
  }
  completeHuntAd(token: string, outcome: import('./RewardedAds').RewardedAdOutcome): HuntActionResult {
    if (this.mode !== 'Monster') return { ok: false, reason: 'staleAd' };
    const result = this.hunt.completeAd(token, outcome);
    if (!result.ok) { this.weapons.tick(); return result; }
    return this.retryHuntSettlement();
  }
  cancelHuntAd(): void { this.hunt.cancelAd(); this.weapons.tick(); }
  configureHuntTest(config: Partial<HuntSave>): boolean {
    if (this.environment !== 'test' || this.mode !== 'Main' || !this.hunt.configureTest(config)) return false;
    this.save(); return true;
  }
  /** Coins and next level are one candidate. A readback failure keeps that exact
   * candidate so a retry can recognise a write that actually succeeded. */
  retryHuntSettlement(): HuntActionResult {
    if (this.offlineInitializationPending) return { ok: false, reason: 'saveFailed' };
    if (this.mode !== 'Monster' || !this.hunt.settlementPending) return { ok: false, reason: 'inactive' };
    if (this.redemptionInFlight || this.mutationDepth) return { ok: false, reason: 'busy' };
    if (this.storageWriteBlocked && !this.huntWrite?.uncertain) return { ok: false, reason: 'saveFailed' };
    this.redemptionInFlight = true;
    try {
      if (!this.huntWrite) {
        const candidate = new PetSystem(); candidate.restore(this.pets.serialize());
        const kind = this.hunt.pendingClear ? 'clear' : 'ad';
        const amount = kind === 'clear' ? ECONOMY_CONFIG.hunt.petCoinsPerLevel : this.hunt.adReward;
        const reward = candidate.grantCoins(amount); if (!reward.ok) return reward;
        if (kind === 'clear' && !Number.isSafeInteger(this.hunt.runReward + amount)) return { ok: false, reason: 'walletLimit' };
        let next: HuntSave;
        try { next = kind === 'clear' ? this.hunt.nextSave() : this.hunt.serialize(); }
        catch (_) { return { ok: false, reason: 'stageLimit' }; }
        const pets = candidate.serialize();
        const before = this.storage?.getItem(this.storageKey) ?? null;
        this.huntWrite = { kind, pets, next, before, uncertain: false,
          raw: this.serializeSave(this.weapons.serialize(), this.redeemedCodes, pets, this.fish.serialize(), next) };
      }
      const pending = this.huntWrite;
      if (this.storage) {
        let current: string | null;
        try { current = this.storage.getItem(this.storageKey); }
        catch (error) { pending.uncertain = true; this.storageWriteBlocked = true; this.reportStorageFailure(error); return { ok: false, reason: 'saveFailed' }; }
        if (pending.uncertain && current !== pending.raw && current !== pending.before) return { ok: false, reason: 'saveFailed' };
        // Calendar refreshes and the public weapon inventory can change while a
        // failed provider is awaiting retry. Carry their latest state forward,
        // while preserving this transaction's exact pet reward and Hunt position.
        const latest = this.serializeSave(this.weapons.serialize(), this.redeemedCodes, pending.pets, this.fish.serialize(), pending.next);
        if (latest !== pending.raw) { pending.before = current; pending.raw = latest; }
        if (current !== pending.raw) {
          try { this.storage.setItem(this.storageKey, pending.raw); } catch (error) { this.reportStorageFailure(error); }
          try { if (this.storage.getItem(this.storageKey) !== pending.raw) return { ok: false, reason: 'saveFailed' }; }
          catch (error) { pending.uncertain = true; this.storageWriteBlocked = true; this.reportStorageFailure(error); return { ok: false, reason: 'saveFailed' }; }
        }
        // A reentrant storage provider may invoke a public inventory command.
        // Do not publish a reward until the durable record contains that state too.
        if (this.serializeSave(this.weapons.serialize(), this.redeemedCodes, pending.pets, this.fish.serialize(), pending.next) !== pending.raw)
          return { ok: false, reason: 'saveFailed' };
      }
      this.pets.restore(pending.pets);
      if (pending.kind === 'clear') this.hunt.commitClear(pending.next); else this.hunt.commitAd();
      if (pending.uncertain) this.storageWriteBlocked = false;
      this.huntWrite = null; return { ok: true };
    } catch (error) { this.reportStorageFailure(error); return { ok: false, reason: 'saveFailed' }; }
    finally { this.redemptionInFlight = false; }
  }
  getSpeedRunState(): SpeedRunSnapshot {
    return this.speedRun.snapshot(this.money.format(), String(this.weapons.diamonds));
  }
  startSpeedRun(): SpeedRunActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (this.redemptionInFlight) return { ok: false, reason: 'busy' };
    if (this.mine.phase !== 'idle') return { ok: false, reason: 'busy' };
    if (this.adventureAd || this.fishAd || this.petAd || this.raid.phase !== 'idle') return { ok: false, reason: 'busy' };
    if (this.getRebirthState().phase !== 'idle') return { ok: false, reason: 'busy' };
    if (!Number.isSafeInteger(this.weapons.diamonds + this.speedRun.rewards.reward)) return { ok: false, reason: 'walletLimit' };
    const result = this.speedRun.start();
    if (!result.ok) return result;
    this.progression.cancelTransition(); this.currentMode = 'SpeedRun';
    this.speedRunRound = { stageIndex: this.speedRun.stage, waveIndex: 0, roundId: ++this.roundSerial, movementMultiplier: 1 };
    this.rewardedTrees.clear(); return result;
  }
  exitSpeedRun(): SpeedRunActionResult {
    if (this.mode !== 'SpeedRun') return { ok: false, reason: 'mode' };
    const result = this.speedRun.exit(); this.weapons.tick(); return result;
  }
  beginSpeedRunAd(): SpeedRunActionResult {
    if (this.mode !== 'SpeedRun') return { ok: false, reason: 'mode' };
    if (!Number.isSafeInteger(this.weapons.diamonds + this.speedRun.rewards.additionalReward)) return { ok: false, reason: 'walletLimit' };
    return this.speedRun.beginAd();
  }
  completeSpeedRunAd(token: string, outcome: SpeedRunAdOutcome): SpeedRunActionResult {
    if (this.mode !== 'SpeedRun') return { ok: false, reason: 'staleAd' };
    const result = this.speedRun.completeAd(token, outcome);
    if (!result.ok) { this.weapons.tick(); return result; }
    this.mutationDepth++;
    try {
      const reward = this.weapons.grantDiamonds(this.speedRun.rewards.additionalReward);
      if (reward.ok) this.speedRun.exit();
      this.weapons.tick(); this.save(); return reward;
    } finally { this.finishMutation(); }
  }
  cancelSpeedRunAd(): void { this.speedRun.cancelAd(); this.weapons.tick(); }
  configureSpeedRunTest(config: SpeedRunTestConfiguration): boolean {
    if (this.environment !== 'test' || this.mode !== 'Main' || !this.speedRun.configureTest(config)) return false;
    this.save(); return true;
  }
  getBossState(health?: BossHealth): BossSnapshot {
    return this.boss.snapshot(this.money.format(), String(this.weapons.diamonds), health);
  }
  startBoss(): BossActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (this.redemptionInFlight || this.adventureAd) return { ok: false, reason: 'busy' };
    if (this.mine.phase !== 'idle') return { ok: false, reason: 'busy' };
    if (this.raid.phase !== 'idle' || this.getRebirthState().phase !== 'idle' || this.weapons.snapshot().pendingAd || this.fishAd || this.petAd) return { ok: false, reason: 'busy' };
    if (!Number.isSafeInteger(this.weapons.diamonds + this.boss.rewards.reward)) return { ok: false, reason: 'walletLimit' };
    const result = this.boss.start();
    if (!result.ok) return result;
    this.progression.cancelTransition(); this.currentMode = 'Boss';
    this.bossRound = { stageIndex: this.boss.stage, waveIndex: 0, roundId: ++this.roundSerial, movementMultiplier: 1 };
    this.rewardedTrees.clear(); return result;
  }
  exitBoss(): BossActionResult {
    if (this.mode !== 'Boss') return { ok: false, reason: 'mode' };
    const result = this.boss.exit(); this.weapons.tick(); return result;
  }
  beginBossAd(): BossActionResult {
    if (this.mode !== 'Boss') return { ok: false, reason: 'mode' };
    if (!Number.isSafeInteger(this.weapons.diamonds + this.boss.rewards.additionalReward)) return { ok: false, reason: 'walletLimit' };
    return this.boss.beginAd();
  }
  completeBossAd(token: string, outcome: BossAdOutcome): BossActionResult {
    if (this.mode !== 'Boss') return { ok: false, reason: 'staleAd' };
    const result = this.boss.completeAd(token, outcome);
    if (!result.ok) { this.weapons.tick(); return result; }
    this.mutationDepth++;
    try {
      const reward = this.weapons.grantDiamonds(this.boss.rewards.additionalReward);
      if (reward.ok) this.boss.exit();
      this.weapons.tick(); this.save(); return reward;
    } finally { this.finishMutation(); }
  }
  cancelBossAd(): void { this.boss.cancelAd(); this.weapons.tick(); }
  configureBossTest(config: BossTestConfiguration): boolean {
    if (this.environment !== 'test' || this.mode !== 'Main' || !this.boss.configureTest(config)) return false;
    this.save(); return true;
  }
  getRaidState(): RaidSnapshot {
    if (this.raid.refreshCalendar()) this.save();
    return this.raid.snapshot();
  }
  getRaidBossCombat(): RaidBossCombat | null { return this.raid.bossCombat; }
  getRaidStarPreview(slot: number, level: number): string | null { return this.raid.starPreview(slot, level); }
  openRaid(): RaidActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (this.redemptionInFlight || this.adventureAd) return { ok: false, reason: 'busy' };
    if (this.mine.phase !== 'idle') return { ok: false, reason: 'busy' };
    if (this.rebirth.snapshot(this.progression.serialize(), this.weapons.stageValueMax).phase !== 'idle'
      || this.weapons.snapshot().pendingAd || this.fishAd || this.petAd) return { ok: false, reason: 'busy' };
    const result = this.raid.open(); this.save(); return result;
  }
  closeRaid(): RaidActionResult { const result = this.raid.close(); this.weapons.tick(); return result; }
  autoSelectRaidWeapons(): RaidActionResult { return this.raid.autoSelect(); }
  selectRaidWeapon(raidSlot: number, sourceIndex: number): RaidActionResult { return this.raid.select(raidSlot, sourceIndex); }
  unselectRaidWeapon(raidSlot: number): RaidActionResult { return this.raid.unselect(raidSlot); }
  private activateRaid(): void {
    this.progression.cancelTransition(); this.currentMode = 'Raid';
    this.raidRound = { stageIndex: 0, waveIndex: 0, roundId: ++this.roundSerial, movementMultiplier: 1 };
    this.rewardedTrees.clear();
  }
  startRaid(): RaidActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (this.redemptionInFlight) return { ok: false, reason: 'busy' };
    if (this.mine.phase !== 'idle') return { ok: false, reason: 'busy' };
    if (this.adventureAd || this.fishAd || this.petAd || this.rebirth.adPending || this.weapons.snapshot().pendingAd || this.getRebirthState().phase !== 'idle') return { ok: false, reason: 'busy' };
    this.mutationDepth++;
    try {
      const result = this.raid.start(); if (result.ok) this.activateRaid(); this.save(); return result;
    } finally { this.finishMutation(); }
  }
  beginRaidAd(): RaidActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'mode' };
    if (this.mine.phase !== 'idle') return { ok: false, reason: 'busy' };
    if (this.adventureAd || this.fishAd || this.petAd || this.rebirth.adPending || this.weapons.snapshot().pendingAd || this.getRebirthState().phase !== 'idle') return { ok: false, reason: 'busy' };
    return this.raid.beginAd();
  }
  completeRaidAd(token: string, outcome: RaidAdOutcome): RaidActionResult {
    if (this.mode !== 'Main') return { ok: false, reason: 'staleAd' };
    this.mutationDepth++;
    try {
      const result = this.raid.completeAd(token, outcome); if (result.ok) this.activateRaid();
      this.weapons.tick(); this.save(); return result;
    } finally { this.finishMutation(); }
  }
  cancelRaidAd(): void { this.raid.cancelAd(); this.weapons.tick(); }
  exitRaid(): RaidActionResult {
    if (this.mode !== 'Raid') return { ok: false, reason: 'mode' };
    return this.raid.exit();
  }
  claimRaidMission(index: number): RaidActionResult { return this.claimRaidRewards(index); }
  claimAllRaidMissions(): RaidActionResult { return this.claimRaidRewards(); }
  private claimRaidRewards(index?: number): RaidActionResult {
    if (this.mode !== 'Main' || this.raid.phase !== 'preparing') return { ok: false, reason: 'busy' };
    this.mutationDepth++;
    try {
      const claimable = this.getRaidState().missions.filter(m => m.claimable && (index === undefined || m.index === index));
      if (!claimable.length) return { ok: false, reason: 'notClaimable' };
      const available = claimable.reduce((n, m) => n + m.reward, 0);
      if (!Number.isSafeInteger(this.weapons.snapshot().starGems + available)) return { ok: false, reason: 'walletLimit' };
      const amount = index === undefined ? this.raid.claimAll() : this.raid.claim(index);
      const result = this.weapons.grantStarGems(amount); this.save(); return result;
    } finally { this.finishMutation(); }
  }
  configureRaidTest(config: RaidTestConfiguration): boolean {
    if (this.environment !== 'test' || this.mode !== 'Main' || !this.raid.configureTest(config)) return false;
    this.save(); return true;
  }
  purchaseRebirthUpgrade(type: UpgradeType): boolean {
    if (this.huntWrite || this.redemptionInFlight) return false;
    if (!this.rebirth.purchase(type)) return false;
    this.save(); return true;
  }
  configureRebirthTest(config: RebirthTestConfiguration): boolean {
    if (this.huntWrite || this.redemptionInFlight || this.environment !== 'test' || !this.rebirth.configureTest(config)) return false;
    this.save(); return true;
  }
  /** All durable rebirth writes happen together. Future systems add a prepared
   * reset action here only when their original reset semantics are implemented. */
  advanceRebirth(dt: number): StageRound | null {
    if (!this.rebirth.advance(dt)) return null;
    const completion = this.rebirth.prepareCompletion(this.progression.serialize());
    const history = this.weapons.serialize().stageValueMax;
    let round: StageRound | null = null;
    // Weapons, stars, diamonds, history and completed onboarding survive rebirth.
    const resetParticipants: readonly (() => void)[] = [
      () => { this.gold = OriginalInfVal.fromInt(0); this.levels.fill(0); },
      () => { this.rewardedTrees.clear(); this.progression.resetForRebirth(history); this.roundSerial++; round = this.round; },
    ];
    this.mutationDepth++;
    try {
      this.rebirth.commitCompletion(completion);
      this.rebirthStoppedRoundId = null;
      for (const reset of resetParticipants) reset();
      this.save();
    } finally { this.finishMutation(); }
    if (this.onRebirthCompleted) {
      try { this.onRebirthCompleted(this.getRebirthState()); }
      catch (error) { console.warn('Rebirth notification failed after settlement.', error); }
    }
    return round;
  }
  /** Relic adapters use this in either environment. Skip is read at victory. */
  setProgressionModifiers(modifiers: Partial<StageModifiers>): void {
    this.progression.configure(modifiers);
    if (modifiers.skipPercent !== undefined) this.externalSkipPercent = modifiers.skipPercent;
    this.refreshRelicEffects();
  }
  /** The source compacts empty weapon slots before indexing cats. Star levels therefore use actorIndex. */
  get combatLoadout(): readonly SessionActorLoadout[] {
    if (this.mode === 'Raid') return this.raid.loadout;
    const inventory = this.weapons.snapshot();
    const power = getUpgradeMultiplier('power', this.levels[0]);
    const speed = this.attackSpeedPercent;
    const rebirthPower = getRebirthPercent('power', this.rebirth.levels[0]);
    return inventory.equipment.filter(item => item !== null).map((item, actorIndex) => {
      const weapon = getWeapon(item!.weaponId), starLevel = inventory.stars[actorIndex].level;
      // Preserve the serialized coefficient's trailing zeroes: 800e0 has p3.
      // Cat.Balance_Reload truncates every InfVal operation, then discards
      // fractions before StarUpgrade_manager.Damage_Apply's own mul/div pair.
      const precision = weapon.damage.split(/[eE]/)[0].replace(/^[+-]/, '').length;
      let damage = OriginalInfVal.fromAmount(DecimalAmount.from(weapon.damage), precision);
      // Boss skips the whole gold-upgrade operation, including its precision
      // promotion. Rebirth and permanent equipment-slot stars still apply.
      if (this.mode !== 'Boss' && this.mode !== 'Monster') damage = damage.mul(power).div(100);
      damage = damage.mul(rebirthPower).div(100).mul(100 + this.skins.totals.damagePercent).div(100)
        .mul(100 + this.fish.totals.damagePercent).div(100).mul(this.relics.totals.damage).div(100).discardDecimal();
      if (starLevel > 0) damage = damage.mul(getStarPercent(starLevel)).div(100);
      return { actorIndex, weapon, damage: this.mode === 'Mine' ? DecimalAmount.from(1) : damage.amount, damagePrecision: this.mode === 'Mine' ? 1 : damage.precision,
        attackInterval: this.attackInterval(weapon.attackInterval, speed),
        criticalChance: this.mode === 'Mine' ? 0 : Math.min(1, this.fish.totals.criticalChancePercent / 100), criticalMultiplier: (125 + this.fish.totals.criticalDamagePercent) / 100, criticalRelicPercent: this.relics.totals.criticalDamage, starLevel };
    });
  }
  getLoadout(): readonly SessionActorLoadout[] { return this.combatLoadout; }
  private get attackSpeedPercent(): number {
    // Cat.CalculateAtkCoolMax consumes Speed_return's serialized p5 InfVal
    // (+100), casts that result to int, then removes the extra base 100.
    // Preserve its precision cut at the six-digit boundary (99995 + 100 -> 100090).
    const rebirthSpeed = getRebirthPercent('speed', this.rebirth.levels[1]).amount.toNumber();
    return Math.max(100, Math.min(10000, (this.mode === 'Boss' || this.mode === 'Monster' ? 0 : getUpgradeValue('speed', this.levels[1]).toNumber())
      + rebirthSpeed - 100 + this.skins.totals.speedPercent - (this.mode === 'Main' ? 30 * this.progression.serialize().stageIndex : 0)));
  }
  private attackInterval(base: number, percent: number): number {
    // All modes share Cat.CalculateAtkCoolMax. Round the original float
    // division before its multiplication, including the float clamp bounds.
    const value = Math.fround(Math.fround(Math.fround(Math.fround(base) / percent) * 100) / this.attackSpeedBuff.multiplier);
    return Math.max(Math.fround(UPGRADE_SOURCE.minimumAttackInterval), Math.min(Math.fround(UPGRADE_SOURCE.maximumAttackInterval), value));
  }
  get combatModifiers(): CombatModifiers {
    const speed = this.attackSpeedPercent;
    let damage = OriginalInfVal.fromInt(WEAPON_CONFIG.damage);
    if (this.mode !== 'Boss' && this.mode !== 'Monster') damage = damage.mul(getUpgradeMultiplier('power', this.levels[0])).div(100);
    return {
      damage: this.mode === 'Mine' ? DecimalAmount.from(1) : damage.mul(getRebirthPercent('power', this.rebirth.levels[0])).div(100)
        .mul(100 + this.skins.totals.damagePercent).div(100).mul(100 + this.fish.totals.damagePercent).div(100)
        .mul(this.relics.totals.damage).div(100).discardDecimal().amount,
      attackInterval: this.attackInterval(WEAPON_CONFIG.attackInterval, speed),
    };
  }

  setMode(mode: BattleMode): void {
    if (!BATTLE_MODES.includes(mode)) throw new Error(`Unsupported battle mode: ${mode}`);
    if (this.hunt.settlementPending && mode !== this.currentMode) throw new Error('Cannot change mode during Hunt settlement');
    if (mode !== this.currentMode) { this.cancelAdventureAd(); this.cancelFishAd(); this.cancelPetAd(); this.cancelHuntAd(); this.cancelMineAd(); }
    this.currentMode = mode;
  }

  /** A replay reuses tree IDs, so reset the ledger without resetting the session wallet. */
  beginRound(): void { this.restartRound(); }

  restartRound(): StageRound {
    if (this.mode === 'Mine' || this.mode === 'SpeedRun' || this.mode === 'Raid' || this.mode === 'Boss' || this.mode === 'Monster') return this.round;
    this.rewardedTrees.clear();
    this.progression.startRound(this.weapons.snapshot().stageValueMax); this.roundSerial++;
    this.save(); return this.round;
  }

  advanceFrame(dt: number, roundId = this.roundId, paused = false): StageRound | null {
    if (this.offlineInitializationPending) return null;
    if (roundId !== this.roundId) return null;
    if (this.mode === 'Mine') {
      const transition = this.mine.advanceFrame(dt, paused);
      if (this.mine.settlementPending) this.retryMineSettlement();
      if (transition === 'entered') return this.round;
      if (transition === 'exited') {
        this.currentMode = 'Main'; this.mineRound = null; this.weapons.tick(); return this.restartRound();
      }
      return null;
    }
    if (this.mode === 'Monster') {
      if (paused || !Number.isFinite(dt) || dt <= 0) return null;
      if (this.hunt.settlementPending && !this.retryHuntSettlement().ok) return null;
      const transition = this.hunt.advanceFrame(dt);
      if (transition === 'entered' || transition === 'next') {
        if (transition === 'next') this.roundSerial++;
        this.huntRound = { stageIndex: this.hunt.wave, waveIndex: this.hunt.level, roundId: this.roundSerial, movementMultiplier: 1 };
        this.huntCombat!.startLevel(this.hunt.wave, this.hunt.level);
        return this.round;
      }
      if (transition === 'exited') {
        this.huntCombat?.clear(); this.huntCombat = undefined; this.huntRound = null;
        this.currentMode = 'Main'; this.weapons.tick(); return this.restartRound();
      }
      return null;
    }
    if (this.mode === 'Raid') {
      this.mutationDepth++;
      try {
        if (this.raid.refreshCalendar()) this.save();
        const transition = this.raid.advanceFrame(dt, paused);
        if (transition === 'entered') { this.save(); return this.round; }
        if (transition === 'settled') {
          this.weapons.grantStarGems(raidReward(this.raid.bossCombat!.snapshot().clearedLevels)); this.save();
        }
        if (transition === 'exited') {
          this.currentMode = 'Main'; this.raidRound = null; this.weapons.tick(); return this.restartRound();
        }
        return null;
      } finally { this.finishMutation(); }
    }
    if (this.raid.refreshCalendar()) this.save();
    if (this.mode === 'Boss') {
      const transition = this.boss.advanceFrame(dt, paused);
      if (transition === 'entered') return this.round;
      if (transition === 'exited') {
        this.currentMode = 'Main'; this.bossRound = null;
        return this.restartRound();
      }
      return null;
    }
    if (this.mode === 'SpeedRun') {
      const transition = this.speedRun.advanceFrame(dt, paused);
      if (transition === 'entered') return this.round;
      if (transition === 'exited') {
        this.currentMode = 'Main'; this.speedRunRound = null;
        return this.restartRound();
      }
      return null;
    }
    if (this.mode !== 'Main') return null;
    const round = this.progression.advanceFrame(dt, this.weapons.snapshot().stageValueMax, paused, this.rebirthStopsRound);
    if (round) { this.rewardedTrees.clear(); this.roundSerial++; return this.round; }
    return null;
  }

  configureProgressionTest(config: ProgressionTestConfiguration): boolean {
    if (this.environment !== 'test' || this.mode !== 'Main' || this.getRebirthState().phase !== 'idle') return false;
    const position = { stageIndex: config.stageIndex ?? this.round.stageIndex, waveIndex: config.waveIndex ?? this.round.waveIndex };
    try {
      validateStagePosition(position);
      if (config.stageValueMax !== undefined && (!Number.isSafeInteger(config.stageValueMax) || config.stageValueMax < 0)) return false;
      this.setProgressionModifiers(config.skipPercent === undefined ? {} : { skipPercent: config.skipPercent });
    } catch (_) { return false; }
    this.mutationDepth++;
    try {
      if (config.stageValueMax !== undefined) this.weapons.configureTest({ stageValueMax: config.stageValueMax });
      this.progression.setPosition(position); this.restartRound();
    } finally { this.finishMutation(); }
    return true;
  }

  purchase(type: UpgradeType): boolean {
    if (this.offlineInitializationPending || this.redemptionInFlight) return false;
    if (this.mode === 'Raid' || this.mode === 'Boss' || this.mode === 'Monster' || !isUpgradeType(type) || this.rebirthAnimating
      || (this.mode === 'Mine' && !this.mine.canFight) || (this.mode === 'SpeedRun' && !this.speedRun.canFight)) return false;
    const index = UPGRADE_TYPES.indexOf(type), level = this.levels[index];
    if (level >= MAX_UPGRADE_LEVEL) return false;
    const price = getUpgradePrice(level)!;
    if (this.money.compare(price) < 0) return false;
    // The shipped Price_balance entries all have p3, including 500e-1.
    this.gold = this.gold.sub(OriginalInfVal.fromAmount(price, 3)); this.levels[index] = level + 1;
    this.refreshContentProgress(); this.save();
    return true;
  }

  consume(events: readonly CombatEvent[], trees: readonly TreeState[], roundId = this.roundId): TreeReward[] {
    const rewards: TreeReward[] = [];
    let cleared: StageRound | undefined;
    if (this.mode === 'Mine' || this.mode === 'Raid' || !this.canFight || roundId !== this.roundId) return rewards;
    if (this.mode === 'Monster') {
      this.getHuntState();
      if (events.some(event => event.type === 'huntFailed')) { this.hunt.fail(); this.huntCombat?.stopMotion(); return rewards; }
      for (const event of events) if (event.type === 'huntLevelComplete' && this.hunt.requestClear(event.wave, event.level)) {
        this.huntCombat?.stopMotion(); this.retryHuntSettlement(); break;
      }
      return rewards;
    }
    if (this.mode === 'Boss') {
      if (!events.some(event => event.type === 'bossDied')) return rewards;
      // Commit the wallet and next Boss stage together; tree events and Main
      // completion notifications never belong to this independent encounter.
      this.mutationDepth++;
      try {
        const reward = this.boss.rewards.reward;
        if (Number.isSafeInteger(this.weapons.diamonds + reward) && this.boss.win()) {
          this.weapons.grantDiamonds(reward); this.save();
        }
      } finally { this.finishMutation(); }
      return rewards;
    }
    this.mutationDepth++;
    try { for (const event of events) {
      if (event.type !== 'treeDied' || this.rewardedTrees.has(event.treeId)) continue;
      const tree = trees.find(candidate => candidate.id === event.treeId);
      if (!tree || tree.alive) continue;
        // Tree_Batch supplies its original coefficient precision separately
        // because DecimalAmount normalizes trailing zeroes. Custom/headless
        // trees without that metadata retain their supplied significant digits.
        const precision = Number.isSafeInteger(tree.rewardPrecision) && tree.rewardPrecision! > 0 && tree.rewardPrecision! <= 100000
          ? tree.rewardPrecision! : Math.max(3, tree.reward.digits.replace('-', '').length);
        const reward = OriginalInfVal.fromAmount(tree.reward, precision)
          .mul(getUpgradeMultiplier('money', this.levels[2])).div(100)
          .mul(getRebirthPercent('money', this.rebirth.levels[2])).div(100)
          .mul(this.pets.moneyMultiplier).div(100)
          .mul(100 + this.skins.totals.moneyPercent).div(100).mul(this.relics.totals.money).div(100);
      this.rewardedTrees.add(tree.id);
      this.gold = this.gold.add(reward);
      rewards.push({ treeId: tree.id, amount: reward.amount, position: { ...event.position }, sourceTime: event.sourceTime });
    }
    if (this.mode === 'SpeedRun') this.speedRun.setProgress(trees.filter(tree => !tree.alive).length, trees.length);
    if (events.some(event => event.type === 'complete') && trees.length > 0 && trees.every(tree => !tree.alive)) {
      const round = this.round;
      if (this.mode === 'SpeedRun') {
        const reward = this.speedRun.rewards.reward;
        if (Number.isSafeInteger(this.weapons.diamonds + reward) && this.speedRun.win()) {
          this.weapons.grantDiamonds(reward); this.refreshContentProgress(); this.save();
        }
      } else {
        const maximum = this.progression.win(this.weapons.snapshot().stageValueMax);
        if (maximum !== null) { this.weapons.recordStageValue(maximum); this.save(); cleared = round; }
      }
    }
    if (rewards.length) this.save();
    } finally { this.finishMutation(); }
    if (cleared && this.onStageCleared) {
      try { this.onStageCleared(cleared); }
      catch (error) { console.warn('Stage-clear notification failed after settlement.', error); }
    }
    return rewards;
  }

  snapshot(stats: Readonly<CombatStats>, paused: boolean, _rewardEffectsActive = false): BattleHudState {
    return {
      mode: this.mode, stageIndex: this.round.stageIndex, waveIndex: this.round.waveIndex,
      kills: stats.kills, totalTrees: stats.totalTrees,
      durationSeconds: this.mode === 'Mine' ? MINE_SECONDS : this.mode === 'Monster' ? 0 : this.mode === 'Raid' ? RAID_SECONDS : this.mode === 'Boss' ? BOSS_SECONDS : this.mode === 'SpeedRun' ? SPEED_RUN_SECONDS : MAIN_ROUND_SECONDS,
      remainingSeconds: this.mode === 'Mine' ? this.mine.remainingSeconds : this.mode === 'Monster' ? 0 : this.mode === 'Raid' ? this.raid.remainingSeconds : this.mode === 'Boss' ? this.boss.remainingSeconds : this.mode === 'SpeedRun' ? this.speedRun.remainingSeconds : this.progression.remainingSeconds,
      elapsed: this.mode === 'Mine' ? this.mine.elapsed : this.mode === 'Monster' ? stats.elapsed : this.mode === 'Raid' ? this.raid.elapsed : this.mode === 'Boss' ? this.boss.elapsed : this.mode === 'SpeedRun' ? this.speedRun.elapsed : this.progression.elapsed, paused, complete: stats.complete,
      resultsReady: this.mode === 'Mine' ? this.mine.phase === 'result' || this.mine.pendingKind === 'reward' : this.mode === 'Monster' ? this.hunt.phase === 'failed' || this.hunt.phase === 'adPending' : this.mode === 'Raid' ? this.raid.phase === 'result' : this.mode === 'Boss' ? !this.boss.canFight : this.mode === 'SpeedRun' ? !this.speedRun.canFight : !this.progression.canFight,
      phase: this.phase, roundId: this.roundId, canFight: this.canFight,
      stageReplay: this.round.movementMultiplier === 2,
      stageTransition: this.mode === 'Main' ? this.progression.transition : undefined,
      stageSkip: this.mode === 'Main' ? this.progression.skip : undefined,
      money: this.money, diamonds: this.weapons.diamonds,
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
    if (this.offlineInitializationPending) return;
    if (this.redemptionInFlight || this.huntWrite || this.mineCommitInFlight) return;
    if (this.mutationDepth > 0) { this.pendingSave = true; return; }
    if (!this.storage || this.storageWriteBlocked) return;
    this.checkpointUtcMs = this.checkpointTime();
    try { this.storage.setItem(this.storageKey, this.serializeSave()); }
    catch (error) { this.reportStorageFailure(error); }
  }

  private serializeSave(weapons = this.weapons.serialize(), redeemedCodes: unknown = this.redeemedCodes, pets: PetSave = this.pets.serialize(), fish: FishSave = this.fish.serialize(), hunt: HuntSave = this.hunt.serialize(), mine: MineSave = this.mine.serialize(), buffs: AttackSpeedBuffSave = this.attackSpeedBuff.serialize(), offline?: OfflineSaveOverride, dailyCheck: unknown = this.dailyCheck.serialize(),
    adventure: unknown = this.malformedAdventure ? this.malformedAdventure.value : this.adventure.serialize(),
    relics: unknown = this.malformedRelics ? this.malformedRelics.value : this.relics.serialize()): string {
    return JSON.stringify({ version: ECONOMY_SAVE_VERSION, money: offline?.gold ?? this.gold, levels: offline?.levels ?? this.levels,
      weapons, skins: this.skins.serialize(), pets, fish, hunt, mine, buffs, progress: offline?.progress ?? this.progression.serialize(), rebirth: this.rebirth.serialize(), speedRun: this.speedRun.serialize(), boss: this.boss.serialize(), raid: this.raid.serialize(), content: this.contentProgress, tutorial: this.tutorial.serialize(), redeemedCodes,
      dailyCheck, adventure, relics, offline: { lastSavedAtMs: offline?.lastSavedUtcMs ?? this.checkpointUtcMs } });
  }

  private restore(): unknown {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (raw === null || raw === '') return;
      const data = JSON.parse(raw) as { version?: unknown; money?: unknown; levels?: unknown; weapons?: unknown; skins?: unknown; pets?: unknown; fish?: unknown; hunt?: unknown; mine?: unknown; buffs?: unknown; progress?: unknown; rebirth?: unknown; speedRun?: unknown; boss?: unknown; raid?: unknown; content?: unknown; tutorial?: unknown; redeemedCodes?: unknown; offline?: unknown; dailyCheck?: unknown; adventure?: unknown; relics?: unknown };
      if (!data || data.version !== ECONOMY_SAVE_VERSION || !Array.isArray(data.levels) || data.levels.length !== 3 || !data.levels.every(isUpgradeLevel)) throw new Error('Invalid economy save');
      const serialized = data.money as { digits?: unknown; exponent?: unknown; precision?: unknown } | undefined;
      if (!serialized || typeof serialized.digits !== 'string' || typeof serialized.exponent !== 'number') throw new Error('Invalid saved wallet');
      const digitCount = serialized.digits.length - (serialized.digits[0] === '-' ? 1 : 0);
      if (!Number.isSafeInteger(serialized.exponent) || digitCount > MAX_SAVED_DECIMAL_SPAN) throw new Error('Saved wallet representation exceeds resource budget');
      const money = DecimalAmount.from({ digits: serialized.digits, exponent: serialized.exponent });
      if (money.isNegative) throw new Error('Invalid saved wallet');
      // Existing v3 saves have no precision field. Keep their complete balance
      // without inventing trailing integer zeroes from an enormous exponent.
      let gold = OriginalInfVal.fromAmount(money, Math.max(1, digitCount));
      if (serialized.precision !== undefined) {
        try { gold = OriginalInfVal.fromSerialized(serialized); }
        catch (error) { this.reportStorageFailure(error); }
      }
      const weapons = WeaponInventory.validate(data.weapons);
      const position = validateStagePosition(data.progress);
      const sourceCatalogVersion = (data.weapons as { catalogVersion?: number }).catalogVersion;
      if (sourceCatalogVersion === undefined || sourceCatalogVersion === 2 || sourceCatalogVersion === 3) {
        // Preserve the exact complete save, including optional systems, before
        // the constructor's first version-4 catalog write. Existing backups are immutable.
        try {
          const backupKey = weaponCatalogBackupStorageKey(this.environment, sourceCatalogVersion ?? 1);
          const previous = this.storage.getItem(backupKey);
          if (previous !== null && previous !== raw) throw new Error('A different legacy weapon backup already exists');
          if (previous === null) this.storage.setItem(backupKey, raw);
          if (this.storage.getItem(backupKey) !== raw) throw new Error('Legacy weapon backup could not be verified');
        } catch (error) { this.storageWriteBlocked = true; this.reportStorageFailure(error); }
      }
      this.gold = gold; data.levels.forEach((level: number, index: number) => { this.levels[index] = level; });
      this.restoredPosition = position;
      this.redeemedCodes = data.redeemedCodes === undefined ? [] : data.redeemedCodes;
      this.dailyCheck.restore(data.dailyCheck);
      // New optional save blocks are isolated: damaged rebirth data cannot
      // discard a previously valid v3 wallet, weapon inventory or progression.
      try { this.rebirth.restore(data.rebirth); }
      catch (error) { this.reportStorageFailure(error); }
      try { this.speedRun.restore(data.speedRun); }
      catch (error) { this.reportStorageFailure(error); }
      try { this.boss.restore(data.boss); }
      catch (error) { this.reportStorageFailure(error); }
      try { this.raid.restore(data.raid); }
      catch (error) { this.reportStorageFailure(error); }
      try { this.pets.restore(data.pets); }
      catch (error) { this.reportStorageFailure(error); }
      try { this.hunt.restore(data.hunt); }
      catch (error) { this.reportStorageFailure(error); }
      try { this.mine.restore(data.mine); }
      catch (error) { this.reportStorageFailure(error); }
      try { this.attackSpeedBuff.restore(data.buffs); }
      catch (error) { this.reportStorageFailure(error); }
      try { this.fish.restore(data.fish); }
      catch (error) { this.reportStorageFailure(error); }
      try { this.skins.restore(data.skins); }
      catch (error) { this.reportStorageFailure(error); }
      try {
        const candidate = new AdventureSystem(this.adventureNow);
        // Validate structure before repairing the known legacy slot-lock defect.
        // Unknown/malformed formats still use the existing isolated-save path.
        candidate.restore(data.adventure, undefined, this.adventureNow);
        if (candidate.recoverUnavailablePets(this.pets.serialize(), this.adventureNow)) {
          const backupKey = `${this.storageKey}:adventure-pet-lock-backup`;
          try {
            if (this.storage.getItem(backupKey) === null) {
              this.storage.setItem(backupKey, raw);
              if (this.storage.getItem(backupKey) !== raw) throw new Error('Adventure recovery backup could not be verified');
            }
          } catch (error) { this.storageWriteBlocked = true; throw error; }
        }
        this.adventure.restore(candidate.serialize(), this.pets.serialize(), this.adventureNow);
        this.pets.setLocks(this.adventure.locks());
      } catch (error) { this.malformedAdventure = { value: data.adventure }; this.reportStorageFailure(error); }
      try {
        const candidate = new RelicSystem(); candidate.restore(data.relics);
        this.relics.restore(candidate.serialize());
      } catch (error) { this.malformedRelics = { value: data.relics }; this.reportStorageFailure(error); }
      // Earlier v3 versions exposed both entries from the start. Keep them open
      // for those saves; do not retroactively issue another onboarding grant.
      const savedContent = data.content as Partial<typeof this.contentProgress> | null;
      if (savedContent && ['challengeUnlocked', 'weaponsUnlocked', 'firstDrawGranted'].every(key =>
        typeof (savedContent as Record<string, unknown>)[key] === 'boolean')) {
        this.contentProgress = { challengeUnlocked: savedContent.challengeUnlocked!, weaponsUnlocked: savedContent.weaponsUnlocked!, firstDrawGranted: savedContent.firstDrawGranted! };
      } else {
        this.contentProgress = { challengeUnlocked: true, weaponsUnlocked: true, firstDrawGranted: true };
      }
      // Existing v3 players are not forced through newly added teaching. A
      // damaged optional tutorial block must not discard their actual progress.
      if (data.tutorial === undefined) this.tutorial.complete();
      else {
        try { this.tutorial.restore(data.tutorial); }
        catch (error) { this.tutorial.complete(); this.reportStorageFailure(error); }
      }
      this.restoredRaw = raw;
      // Optional metadata cannot invalidate a valid legacy v3 economy. An absent,
      // damaged or future checkpoint grants no retroactive income.
      const checkpoint = (data.offline as { lastSavedAtMs?: unknown } | null)?.lastSavedAtMs;
      if (typeof checkpoint === 'number' && Number.isSafeInteger(checkpoint) && checkpoint >= 0 && checkpoint <= this.clock()) {
        this.restoredCheckpoint = checkpoint;
      }
      return weapons;
    } catch (error) { this.storageWriteBlocked = true; this.reportStorageFailure(error); }
  }

  private finishMutation(): void {
    this.mutationDepth--;
    if (this.mutationDepth === 0 && this.pendingSave) { this.pendingSave = false; this.save(); }
  }

  private reportStorageFailure(error: unknown): void {
    if (this.reportedStorageFailure) return;
    this.reportedStorageFailure = true;
    console.warn('Economy storage unavailable or invalid; play continues in memory.', error);
  }
}
