import { DecimalAmount } from '../core/DecimalAmount';
import { OriginalInfVal } from '../core/OriginalInfVal';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { AD_WEAPON_ID, DRAW_PRICE, getWeapon, getWeaponGrade, getWeaponIdsForGrade, isWeaponId,
  WEAPON_CATALOG_VERSION, WEAPON_COUNT, WEAPON_GRADES } from '../core/WeaponCatalog';
import { resolveContentConfig, WEAPON_TUTORIAL_RULES } from './ContentConfig';
import { ContentUnlockManager } from './ContentUnlockManager';
import type { ContentId } from './ContentUnlockManager';
import type { TutorialSnapshot } from './TutorialManager';

export const BACKPACK_CAPACITY = 16;
export const EQUIPMENT_CAPACITY = 3;
export const AD_WEAPON_DURATION_MS = ECONOMY_CONFIG.weapons.offer.durationSeconds * 1000;
export const MAX_STAR_LEVEL = 20;
export const STAR_SUCCESS_PERCENT = Object.freeze([100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 10, 10, 10, 10, 5, 5, 5, 1, 1, 1]);
const MAX_DATE_MS = 8640000000000000;
export type AdKind = 'daily' | 'weapon';
export type AdOutcome = import('./RewardedAds').RewardedAdOutcome;
export type PendingWeaponAd = { token: string; kind: AdKind };
export interface WeaponItem { readonly weaponId: number; readonly locked: boolean; readonly pendingAd: boolean; }
export interface WeaponLocation { kind: 'backpack' | 'equipment'; index: number; }
export interface AutoMergePair {
  readonly fromIndex: number; readonly toIndex: number;
  readonly fromWeaponId: number; readonly toWeaponId: number;
}
export interface WeaponActionResult {
  ok: boolean;
  reason?: string;
  weaponId?: number;
  isNew?: boolean;
  forceShow?: boolean;
  token?: string;
}
export interface WeaponNotice { weaponId: number; isNew: boolean; forceShow: boolean; }
export type WeaponMutationAction = { type: 'draw' | 'merge' | 'equip'; weaponId: number };
export interface StarActionResult extends WeaponActionResult { status: 'success' | 'failure' | 'max' | 'notEnoughGem' | 'locked' | 'invalid'; }
export interface StarSlotSnapshot {
  level: number; failureCount: number; cost: number | null; successPercent: number | null;
  bonusPercent: DecimalAmount; nextBonusPercent: DecimalAmount | null; multiplier: DecimalAmount;
}
export interface WeaponInventorySnapshot {
  unlocked: boolean; unlockMessage?: string; lockMessage?: string; starMessage?: string;
  backpack: readonly (WeaponItem | null)[];
  equipment: readonly (WeaponItem | null)[];
  collection: readonly boolean[];
  diamonds: number; starGems: number; stageValueMax: number;
  lockUnlocked: boolean; starUnlocked: boolean;
  stars: readonly StarSlotSnapshot[];
  auto: { unlocked: boolean; enabled: boolean; maxMaterialGrade: number; configuredMaxGrade: number; };
  dailyAdAvailable: boolean;
  dailyAdUnlocked: boolean;
  pendingAd: PendingWeaponAd | null;
  adGunExpiresAt: number;
  firstMerge: boolean;
  revision: number;
}
export interface SerializedWeaponInventory {
  catalogVersion: typeof WEAPON_CATALOG_VERSION;
  backpack: (WeaponItem | null)[]; equipment: (WeaponItem | null)[]; collection: boolean[];
  diamonds: number; starGems: number; stageValueMax: number;
  starLevels: number[]; starFailures: number[];
  autoEnabled: boolean; autoMergeDegree: number;
  dailyAdDate: string; dailyAdCount: number; adGunExpiresAt: number; adGunOffered: boolean; adGunEnabled: boolean;
  firstMerge: boolean; nextAdId: number;
  testTimeOffsetMs: number;
}
export interface WeaponInventoryOptions {
  environment?: 'test' | 'production'; now?: () => number; rng?: () => number;
  content?: ContentUnlockManager;
  onMutation?: (forceBalanceReload?: boolean, action?: WeaponMutationAction) => void; initialState?: unknown;
  /** The session owns teaching progress; independent inventories have no tutorial restrictions. */
  getTutorialState?: () => TutorialSnapshot;
  /** Other gameplay systems share the source rewarded-ad busy flag. */
  isRewardedAdBusy?: () => boolean;
}
export interface WeaponTestConfiguration {
  stageValueMax?: number; diamonds?: number; starGems?: number;
  autoEnabled?: boolean; autoMergeDegree?: number;
  starLevels?: readonly number[]; starFailures?: readonly number[];
  adGunEnabled?: boolean;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function copyItem(item: WeaponItem | null): WeaponItem | null { return item ? { ...item } : null; }
function dateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const STAR_BONUSES: readonly DecimalAmount[] = (() => {
  const values = [DecimalAmount.from(0)]; let multiplier = 1;
  for (let level = 1; level <= MAX_STAR_LEVEL; level++) {
    multiplier = multiplier * Math.pow(1.07, level - 1) * 1.5;
    values.push(DecimalAmount.from(((multiplier - 1) * 100).toPrecision(17)).truncateSignificant(2));
  }
  return Object.freeze(values);
})();
export function getStarBonusPercent(level: number): DecimalAmount {
  if (!integer(level, 0, MAX_STAR_LEVEL)) throw new Error('Invalid star level');
  return STAR_BONUSES[level];
}
/** EnsureTables adds int 100 to the p2 bonus through InfVal, producing p3. */
export function getStarPercent(level: number): OriginalInfVal {
  return OriginalInfVal.fromAmount(getStarBonusPercent(level), 2).add(100);
}
export function getStarMultiplier(level: number): DecimalAmount { return getStarPercent(level).div(100).amount; }
/** Gun_Slot and StarUpgrade_popup both use Damage_Apply on the serialized gun
 * damage. Preserve its coefficient precision and the source multiply/divide
 * order so the next-level preview agrees with the upgraded equipment card. */
export function getWeaponStarDamage(weaponId: number, level: number): DecimalAmount {
  const weapon = getWeapon(weaponId), percent = getStarPercent(level);
  const precision = weapon.damage.split(/[eE]/)[0].replace(/^[+-]/, '').length;
  const damage = OriginalInfVal.fromAmount(DecimalAmount.from(weapon.damage), precision);
  return level === 0 ? damage.amount : damage.mul(percent).div(100).amount;
}
export function getStarSuccessPercent(level: number, failures: number): number | null {
  if (!integer(level, 0, MAX_STAR_LEVEL) || !integer(failures)) throw new Error('Invalid star state');
  if (level === MAX_STAR_LEVEL) return null;
  return level >= 17 ? Math.min(5, STAR_SUCCESS_PERCENT[level] + failures) : STAR_SUCCESS_PERCENT[level];
}

/** Owns all weapon transactions. Rendering and ad completion only call commands; no mutation leaks through snapshots. */
export class WeaponInventory {
  private state: SerializedWeaponInventory;
  private readonly environment: 'test' | 'production';
  private readonly content: ContentUnlockManager;
  private readonly clock: () => number;
  private readonly rng: () => number;
  private readonly onMutation?: WeaponInventoryOptions['onMutation'];
  private readonly getTutorialState?: WeaponInventoryOptions['getTutorialState'];
  private pendingAd: PendingWeaponAd | null = null;
  private readonly isRewardedAdBusy: () => boolean;
  private readonly notices: WeaponNotice[] = [];
  private revisionValue = 0;
  constructor(options: WeaponInventoryOptions = {}) {
    this.environment = options.environment === 'test' ? 'test' : 'production';
    this.content = options.content ?? new ContentUnlockManager(resolveContentConfig(this.environment));
    if (this.content.config.environment !== this.environment) throw new Error('Content configuration environment mismatch');
    this.clock = options.now || Date.now; this.rng = options.rng || Math.random; this.onMutation = options.onMutation;
    this.getTutorialState = options.getTutorialState;
    this.isRewardedAdBusy = options.isRewardedAdBusy ?? (() => false);
    this.state = options.initialState === undefined ? WeaponInventory.defaults() : WeaponInventory.validate(options.initialState);
    if (this.environment === 'test') {
      this.state.diamonds = Math.max(this.content.config.testResources.diamonds, this.state.diamonds);
      this.state.starGems = Math.max(this.content.config.testResources.starGems, this.state.starGems);
    }
    else this.state.testTimeOffsetMs = 0;
    this.expire();
  }
  private static defaults(): SerializedWeaponInventory {
    const collection = new Array<boolean>(WEAPON_COUNT).fill(false); collection[ECONOMY_CONFIG.newGame.starterWeaponId] = true;
    return { catalogVersion: WEAPON_CATALOG_VERSION, backpack: new Array<null>(BACKPACK_CAPACITY).fill(null), equipment: [{ weaponId: ECONOMY_CONFIG.newGame.starterWeaponId, locked: false, pendingAd: false }, null, null],
      collection, diamonds: ECONOMY_CONFIG.newGame.diamonds, starGems: ECONOMY_CONFIG.newGame.starGems, stageValueMax: 0, starLevels: [0, 0, 0], starFailures: [0, 0, 0],
      autoEnabled: false, autoMergeDegree: 6, dailyAdDate: '', dailyAdCount: 0, adGunExpiresAt: 0,
      adGunOffered: false, adGunEnabled: true, firstMerge: false, nextAdId: 1, testTimeOffsetMs: 0 };
  }
  /** Strict validation finishes before replacing state, so corrupt saves cannot partly apply a transaction. */
  static validate(value: unknown): SerializedWeaponInventory {
    if (!value || typeof value !== 'object') throw new Error('Invalid weapon save');
    const candidate = value as SerializedWeaponInventory;
    if (candidate.catalogVersion !== WEAPON_CATALOG_VERSION) throw new Error('Unsupported weapon catalog version');
    const items = (list: unknown, length: number, allowPending: boolean): (WeaponItem | null)[] => {
      if (!Array.isArray(list) || list.length !== length) throw new Error('Invalid weapon slots');
      return list.map(item => {
        if (item === null) return null;
        if (!item || !isWeaponId(item.weaponId) || typeof item.locked !== 'boolean' || typeof item.pendingAd !== 'boolean' ||
          (item.pendingAd && (!allowPending || item.locked))) throw new Error('Invalid weapon item');
        return { weaponId: item.weaponId, locked: item.locked, pendingAd: item.pendingAd };
      });
    };
    const backpack = items(candidate.backpack, BACKPACK_CAPACITY, true), equipment = items(candidate.equipment, EQUIPMENT_CAPACITY, false);
    if (!equipment.some(Boolean) || backpack.filter(item => item && item.pendingAd).length > 1) throw new Error('Invalid equipped or pending weapon count');
    const bools = (list: unknown, length: number): boolean[] => {
      if (!Array.isArray(list) || list.length !== length || list.some(item => typeof item !== 'boolean')) throw new Error('Invalid collection');
      return list.slice();
    };
    const numbers = (list: unknown, max: number): number[] => {
      if (!Array.isArray(list) || list.length !== EQUIPMENT_CAPACITY || list.some(item => !Number.isSafeInteger(item))) throw new Error('Invalid star slots');
      // Source StarUpgrade save restoration clamps levels and negative failure counts.
      return list.map(item => Math.max(0, Math.min(max, item)));
    };
    const collection = bools(candidate.collection, WEAPON_COUNT);
    for (const item of [...backpack, ...equipment]) if (item && !item.pendingAd && !collection[item.weaponId]) throw new Error('Owned weapon missing from collection');
    for (const field of ['diamonds', 'starGems', 'stageValueMax', 'adGunExpiresAt', 'nextAdId', 'testTimeOffsetMs'] as const) {
      if (!integer(candidate[field], 0, Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid weapon save ${field}`);
    }
    if (!integer(candidate.autoMergeDegree, 0, 6) || typeof candidate.dailyAdDate !== 'string' ||
      !/^(?:|\d{4}-\d{2}-\d{2})$/.test(candidate.dailyAdDate)) throw new Error('Invalid weapon time state');
    if (!integer(candidate.dailyAdCount)) throw new Error('Invalid daily weapon count');
    for (const field of ['autoEnabled', 'adGunOffered', 'adGunEnabled', 'firstMerge'] as const) if (typeof candidate[field] !== 'boolean') throw new Error('Invalid weapon flag');
    const pending = backpack.some(item => item && item.pendingAd);
    if (pending !== (candidate.adGunExpiresAt > 0)) throw new Error('Invalid pending weapon expiration');
    return { catalogVersion: WEAPON_CATALOG_VERSION, backpack, equipment, collection,
      diamonds: candidate.diamonds, starGems: candidate.starGems, stageValueMax: candidate.stageValueMax,
      starLevels: numbers(candidate.starLevels, MAX_STAR_LEVEL), starFailures: numbers(candidate.starFailures, Number.MAX_SAFE_INTEGER),
      autoEnabled: candidate.autoEnabled, autoMergeDegree: candidate.autoMergeDegree,
      dailyAdDate: candidate.dailyAdDate, dailyAdCount: candidate.dailyAdCount, adGunExpiresAt: candidate.adGunExpiresAt,
      adGunOffered: candidate.adGunOffered, adGunEnabled: candidate.adGunEnabled,
      firstMerge: candidate.firstMerge, nextAdId: candidate.nextAdId, testTimeOffsetMs: candidate.testTimeOffsetMs };
  }
  get revision(): number { return this.revisionValue; }
  get isTestEnvironment(): boolean { return this.environment === 'test'; }
  get diamonds(): number { return this.state.diamonds; }
  get stageValueMax(): number { return this.state.stageValueMax; }
  /** Shared durable reward path for gameplay systems (not a test grant). */
  grantDiamonds(amount: number): WeaponActionResult {
    if (!integer(amount) || !integer(this.state.diamonds + amount)) return this.fail('invalidAmount');
    if (amount > 0) { this.state.diamonds += amount; this.changed(); }
    return { ok: true };
  }
  /** Shared debit for durable gameplay transactions; failures never notify or mutate. */
  spendDiamonds(amount: number): WeaponActionResult {
    if (!integer(amount)) return this.fail('invalidAmount');
    if (this.state.diamonds < amount) return this.fail('diamonds');
    if (amount > 0) { this.state.diamonds -= amount; this.changed(); }
    return { ok: true };
  }
  get starGems(): number { return this.state.starGems; }
  get now(): number { return this.clock() + this.state.testTimeOffsetMs; }
  private changed(forceBalanceReload = false, action?: WeaponMutationAction): void {
    this.revisionValue++; if (this.onMutation) this.onMutation(forceBalanceReload, action);
  }
  private tutorialActive(): boolean { return this.getTutorialState?.().active === true; }
  private fail(reason: string): WeaponActionResult { return { ok: false, reason }; }
  private randomIndex(count: number): number {
    const value = this.rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Weapon RNG must return [0,1)');
    return Math.floor(value * count);
  }
  private freeSlot(): number { return this.state.backpack.indexOf(null); }
  private policy(id: ContentId) { return this.content.get(id, { stageValueMax: this.state.stageValueMax }); }
  private unlocked(): boolean { return this.policy('weapons').unlocked; }
  private lockUnlocked(): boolean { return this.policy('weaponLock').unlocked; }
  private starUnlocked(): boolean { return this.policy('weaponStar').unlocked; }
  private dailyAdUnlocked(): boolean { return this.policy('dailyAdWeapon').unlocked; }
  private dailyAdUsed(): number { return this.state.dailyAdDate === dateKey(this.now) ? this.state.dailyAdCount : 0; }
  private autoUnlocked(): boolean { return this.unlocked() && this.policy('autoMerge').unlocked; }
  private highestGrade(): number {
    // Appended models retain stable IDs; a larger ID does not imply a higher grade.
    return this.state.collection.reduce((highest, owned, id) => owned ? Math.max(highest, getWeaponGrade(id)) : highest, 0);
  }
  private maxAutoGrade(): number { return Math.min(6, this.state.autoMergeDegree, this.highestGrade() - 1); }
  private collect(weaponId: number, forceShow = false): WeaponActionResult {
    const isNew = !this.state.collection[weaponId]; this.state.collection[weaponId] = true;
    if (isNew || forceShow) this.notices.push({ weaponId, isNew, forceShow });
    return { ok: true, weaponId, isNew, forceShow };
  }
  private expire(): boolean {
    let changed = false;
    // Disabled advertising cannot leave an unclaimable placeholder in inventory.
    // Real claimed weapons and the offer's historical flag survive.
    if (!this.content.isAdEnabled('weapon-unlock') && this.state.adGunExpiresAt > 0) {
      this.state.backpack = this.state.backpack.map(item => item?.pendingAd ? null : item);
      this.state.adGunExpiresAt = 0; changed = true;
    }
    // Original Gun_manager.Update defers expiration while ANY rewarded ad is
    // busy. Recheck as soon as its success/cancel/failure callback settles.
    if (this.state.adGunExpiresAt > 0 && this.now >= this.state.adGunExpiresAt && !this.pendingAd && !this.isRewardedAdBusy()) {
      this.state.backpack = this.state.backpack.map(item => item && item.pendingAd ? null : item);
      this.state.adGunExpiresAt = 0; changed = true;
    }
    return changed;
  }
  tick(): void { if (this.expire()) this.changed(); }
  snapshot(): WeaponInventorySnapshot {
    this.tick();
    return { unlocked: this.unlocked(), unlockMessage: this.policy('weapons').message,
      lockMessage: this.policy('weaponLock').message, starMessage: this.policy('weaponStar').message,
      backpack: this.state.backpack.map(copyItem), equipment: this.state.equipment.map(copyItem), collection: this.state.collection.slice(),
      diamonds: this.state.diamonds, starGems: this.state.starGems, stageValueMax: this.state.stageValueMax,
      lockUnlocked: this.lockUnlocked(), starUnlocked: this.starUnlocked(), stars: this.state.starLevels.map((level, index) => ({
        level, failureCount: this.state.starFailures[index], cost: level === MAX_STAR_LEVEL ? null : (level + 1) * 50,
        successPercent: getStarSuccessPercent(level, this.state.starFailures[index]), bonusPercent: getStarBonusPercent(level),
        nextBonusPercent: level === MAX_STAR_LEVEL ? null : getStarBonusPercent(level + 1), multiplier: getStarMultiplier(level),
      })),
      auto: { unlocked: this.autoUnlocked(), enabled: this.autoUnlocked() && this.state.autoEnabled,
        maxMaterialGrade: this.maxAutoGrade(), configuredMaxGrade: this.state.autoMergeDegree },
      dailyAdAvailable: this.dailyAdUnlocked() && this.dailyAdUsed() < ECONOMY_CONFIG.weapons.dailyAd.dailyLimit,
      dailyAdUnlocked: this.dailyAdUnlocked(),
      pendingAd: this.pendingAd ? { ...this.pendingAd } : null, adGunExpiresAt: this.state.adGunExpiresAt,
      firstMerge: this.state.firstMerge, revision: this.revisionValue };
  }
  serialize(): SerializedWeaponInventory {
    return { ...this.state, backpack: this.state.backpack.map(copyItem), equipment: this.state.equipment.map(copyItem),
      collection: this.state.collection.slice(), starLevels: this.state.starLevels.slice(), starFailures: this.state.starFailures.slice() };
  }
  drainNotifications(): WeaponNotice[] { return this.notices.splice(0); }
  draw(): WeaponActionResult {
    if (!this.unlocked()) return this.fail('weaponsLocked');
    const tutorial = this.getTutorialState?.();
    if (tutorial?.active && (tutorial.step !== 'gunBuy' || tutorial.drawCount >= WEAPON_TUTORIAL_RULES.drawCount)) return this.fail('tutorialStep');
    this.tick(); const at = this.freeSlot();
    if (at < 0) return this.fail('backpackFull');
    if (this.state.diamonds < DRAW_PRICE) return this.fail('notEnoughDiamonds');
    const weights = ECONOMY_CONFIG.weapons.drawGradePercents;
    const activeGrades = weights.map((weight, grade) => ({ weight, grade })).filter(item => item.weight > 0);
    let grade = tutorial?.active ? WEAPON_TUTORIAL_RULES.drawGrade : activeGrades[0].grade;
    // Keep the original RNG sequence when the pool has only one enabled grade.
    if (!tutorial?.active && activeGrades.length > 1) {
      let roll = this.randomIndex(100);
      for (const entry of activeGrades) { if (roll < entry.weight) { grade = entry.grade; break; } roll -= entry.weight; }
    }
    const candidates = getWeaponIdsForGrade(grade), weaponId = candidates[this.randomIndex(candidates.length)];
    this.state.diamonds -= DRAW_PRICE; this.state.backpack[at] = { weaponId, locked: false, pendingAd: false };
    const result = this.collect(weaponId); this.changed(false, { type: 'draw', weaponId }); return result;
  }
  swapBackpack(a: number, b: number): WeaponActionResult {
    if (!this.unlocked()) return this.fail('weaponsLocked');
    this.tick();
    if (!integer(a, 0, BACKPACK_CAPACITY - 1) || !integer(b, 0, BACKPACK_CAPACITY - 1) || a === b) return this.fail('invalidSlot');
    if (this.state.backpack[a]?.pendingAd || this.state.backpack[b]?.pendingAd) return this.fail('pendingAd');
    [this.state.backpack[a], this.state.backpack[b]] = [this.state.backpack[b], this.state.backpack[a]];
    this.changed(); return { ok: true };
  }
  /** Commits a drag preview in one transaction; hovering never rearranges saved items.
   * Pending ad guns and locks travel with their items, without granting either reward. */
  moveBackpack(from: number, to: number, displacedTo: number = from): WeaponActionResult {
    if (!this.unlocked()) return this.fail('weaponsLocked');
    if (!integer(from, 0, BACKPACK_CAPACITY - 1) || !integer(to, 0, BACKPACK_CAPACITY - 1) ||
      !integer(displacedTo, 0, BACKPACK_CAPACITY - 1) || from === to || displacedTo === to) return this.fail('invalidSlot');
    const source = this.state.backpack[from], target = this.state.backpack[to];
    if (!source) return this.fail('emptySlot');
    if (target && displacedTo !== from && this.state.backpack[displacedTo]) return this.fail('occupiedSlot');
    this.state.backpack[from] = null;
    if (target) this.state.backpack[displacedTo] = target;
    this.state.backpack[to] = source;
    this.changed(); return { ok: true, weaponId: source.weaponId };
  }
  equip(backpackIndex: number, slotIndex: number): WeaponActionResult {
    if (!this.unlocked()) return this.fail('weaponsLocked');
    const tutorial = this.getTutorialState?.();
    if (tutorial?.active && (tutorial.step !== 'gunEquip' || this.state.backpack[backpackIndex]?.weaponId !== WEAPON_TUTORIAL_RULES.mergeWeaponId)) return this.fail('tutorialStep');
    this.tick();
    if (!integer(backpackIndex, 0, BACKPACK_CAPACITY - 1) || !integer(slotIndex, 0, EQUIPMENT_CAPACITY - 1)) return this.fail('invalidSlot');
    const item = this.state.backpack[backpackIndex];
    if (!item) return this.fail('emptySlot'); if (item.pendingAd) return this.fail('pendingAd');
    this.state.backpack[backpackIndex] = this.state.equipment[slotIndex]; this.state.equipment[slotIndex] = item;
    this.changed(true, { type: 'equip', weaponId: item.weaponId }); return { ok: true, weaponId: item.weaponId };
  }
  unequip(slotIndex: number): WeaponActionResult {
    if (!this.unlocked()) return this.fail('weaponsLocked');
    if (this.tutorialActive()) return this.fail('tutorialStep');
    this.tick();
    if (!integer(slotIndex, 0, EQUIPMENT_CAPACITY - 1)) return this.fail('invalidSlot');
    const item = this.state.equipment[slotIndex]; if (!item) return this.fail('emptySlot');
    if (this.state.equipment.filter(Boolean).length <= 1) return this.fail('lastWeapon');
    const at = this.freeSlot(); if (at < 0) return this.fail('backpackFull');
    this.state.backpack[at] = item; this.state.equipment[slotIndex] = null; this.changed(true); return { ok: true, weaponId: item.weaponId };
  }
  swapEquipment(a: number, b: number): WeaponActionResult {
    if (!this.unlocked()) return this.fail('weaponsLocked');
    if (this.tutorialActive()) return this.fail('tutorialStep');
    if (!integer(a, 0, EQUIPMENT_CAPACITY - 1) || !integer(b, 0, EQUIPMENT_CAPACITY - 1) || a === b) return this.fail('invalidSlot');
    if (!this.state.equipment[a]) return this.fail('emptySlot');
    [this.state.equipment[a], this.state.equipment[b]] = [this.state.equipment[b], this.state.equipment[a]];
    this.changed(true); return { ok: true };
  }
  toggleLock(location: WeaponLocation): WeaponActionResult {
    if (!this.unlocked()) return this.fail('weaponsLocked');
    if (this.tutorialActive()) return this.fail('tutorialStep');
    this.tick(); if (!this.lockUnlocked()) return this.fail('locked');
    const list = location.kind === 'backpack' ? this.state.backpack : location.kind === 'equipment' ? this.state.equipment : null;
    if (!list || !integer(location.index, 0, list.length - 1)) return this.fail('invalidSlot');
    const item = list[location.index]; if (!item) return this.fail('emptySlot'); if (item.pendingAd) return this.fail('pendingAd');
    list[location.index] = { ...item, locked: !item.locked }; this.changed(); return { ok: true };
  }
  merge(from: number, to: number): WeaponActionResult {
    if (!this.unlocked()) return this.fail('weaponsLocked');
    const tutorial = this.getTutorialState?.();
    if (tutorial?.active && tutorial.step !== 'gunMerge') return this.fail('tutorialStep');
    this.tick();
    const reason = this.mergeFailure(from, to); if (reason) return this.fail(reason);
    const grade = getWeaponGrade(this.state.backpack[from]!.weaponId);
    if (tutorial?.active && grade !== WEAPON_TUTORIAL_RULES.drawGrade) return this.fail('tutorialStep');
    const candidates = getWeaponIdsForGrade(grade + 1);
    const weaponId = tutorial?.active ? WEAPON_TUTORIAL_RULES.mergeWeaponId : candidates[this.randomIndex(candidates.length)];
    this.state.backpack[from] = null; this.state.backpack[to] = { weaponId, locked: false, pendingAd: false };
    const result = this.collect(weaponId); this.state.firstMerge = true; this.offerAdWeapon();
    this.changed(false, { type: 'merge', weaponId }); return result;
  }
  private mergeFailure(from: number, to: number): string | null {
    if (!integer(from, 0, BACKPACK_CAPACITY - 1) || !integer(to, 0, BACKPACK_CAPACITY - 1) || from === to) return 'invalidSlot';
    const a = this.state.backpack[from], b = this.state.backpack[to];
    if (!a || !b) return 'emptySlot'; if (a.pendingAd || b.pendingAd) return 'pendingAd';
    if (a.locked || b.locked) return 'protected';
    const grade = getWeaponGrade(a.weaponId); if (grade !== getWeaponGrade(b.weaponId)) return 'differentGrade';
    return grade >= WEAPON_GRADES.length - 1 ? 'maxGrade' : null;
  }
  private offerAdWeapon(): void {
    if (this.tutorialActive()) return;
    if (!this.content.isAdEnabled('weapon-unlock')) return;
    if (!this.state.firstMerge || this.state.adGunOffered || !this.state.adGunEnabled || this.highestGrade() >= ECONOMY_CONFIG.weapons.offer.maximumOwnedGradeExclusive) return;
    const at = this.freeSlot(); if (at < 0) return;
    this.state.backpack[at] = { weaponId: AD_WEAPON_ID, locked: false, pendingAd: true };
    this.state.adGunExpiresAt = this.now + AD_WEAPON_DURATION_MS; this.state.adGunOffered = true;
  }
  setAutoMerge(enabled: boolean): WeaponActionResult {
    if (this.tutorialActive()) return this.fail('tutorialStep');
    this.tick(); if (typeof enabled !== 'boolean') return this.fail('invalidValue');
    if (enabled && !this.autoUnlocked()) return this.fail('locked');
    this.state.autoEnabled = enabled; this.changed(); return { ok: true };
  }
  /** Finishes the pair selected before the move animation. Unrelated draws must
   * not select a different pair when that animation reaches its destination. */
  autoMergePair(from: number, to: number, fromWeaponId: number, toWeaponId: number): WeaponActionResult {
    if (this.tutorialActive()) return this.fail('tutorialStep');
    this.tick();
    const reason = this.autoMergePairFailure({ fromIndex: from, toIndex: to, fromWeaponId, toWeaponId });
    if (reason) return this.fail(reason);
    return this.merge(from, to);
  }
  /** Read-only policy query: no expiration transaction, RNG, notices or save.
   * The caller owns animation timing; a selected pair keeps its slot/gun identity. */
  findAutoMergePair(excludedBackpackIndices: readonly number[] = []): AutoMergePair | null {
    if (this.tutorialActive()) return null;
    if (!this.autoUnlocked() || !this.state.autoEnabled) return null;
    const limit = this.maxAutoGrade(), excluded = new Set(excludedBackpackIndices);
    for (let grade = 0; grade <= limit; grade++) {
      const pair: number[] = [];
      for (let index = 0; index < BACKPACK_CAPACITY; index++) {
        const item = this.state.backpack[index];
        if (!excluded.has(index) && item && !item.locked && !item.pendingAd && getWeaponGrade(item.weaponId) === grade) pair.push(index);
        // Source FindAutoMergePair / FuseItems moves the later slot into the first.
        if (pair.length === 2) return { fromIndex: pair[1], toIndex: pair[0],
          fromWeaponId: item!.weaponId, toWeaponId: this.state.backpack[pair[0]]!.weaponId };
      }
    }
    return null;
  }
  isAutoMergePairValid(pair: AutoMergePair): boolean { return this.autoMergePairFailure(pair) === null; }
  private autoMergePairFailure(pair: AutoMergePair): string | null {
    if (this.tutorialActive()) return 'tutorialStep';
    if (!this.autoUnlocked() || !this.state.autoEnabled) return 'autoInactive';
    const { fromIndex: from, toIndex: to, fromWeaponId, toWeaponId } = pair;
    if (!integer(from, 0, BACKPACK_CAPACITY - 1) || !integer(to, 0, BACKPACK_CAPACITY - 1) || from === to) return 'invalidSlot';
    const a = this.state.backpack[from], b = this.state.backpack[to];
    if (!a || !b || a.weaponId !== fromWeaponId || b.weaponId !== toWeaponId) return 'noPair';
    const limit = this.maxAutoGrade();
    if (getWeaponGrade(a.weaponId) > limit || getWeaponGrade(b.weaponId) > limit) return 'noPair';
    return this.mergeFailure(from, to);
  }
  /** Immediate domain command; the HUD uses the same query before animating. */
  autoMergeStep(excludedBackpackIndices: readonly number[] = []): WeaponActionResult {
    if (this.tutorialActive()) return this.fail('tutorialStep');
    this.tick(); if (!this.autoUnlocked() || !this.state.autoEnabled) return this.fail('autoInactive');
    const pair = this.findAutoMergePair(excludedBackpackIndices);
    return pair ? this.autoMergePair(pair.fromIndex, pair.toIndex, pair.fromWeaponId, pair.toWeaponId) : this.fail('noPair');
  }
  upgradeStar(slotIndex: number): StarActionResult {
    if (!this.unlocked()) return { ok: false, reason: 'weaponsLocked', status: 'locked' };
    if (this.tutorialActive()) return { ok: false, reason: 'tutorialStep', status: 'locked' };
    if (!integer(slotIndex, 0, EQUIPMENT_CAPACITY - 1)) return { ok: false, reason: 'invalidSlot', status: 'invalid' };
    if (!this.starUnlocked()) return { ok: false, reason: 'locked', status: 'locked' };
    const level = this.state.starLevels[slotIndex];
    if (level >= MAX_STAR_LEVEL) return { ok: false, reason: 'max', status: 'max' };
    const cost = (level + 1) * 50;
    if (this.state.starGems < cost) return { ok: false, reason: 'notEnoughGem', status: 'notEnoughGem' };
    const success = this.randomIndex(100) < getStarSuccessPercent(level, this.state.starFailures[slotIndex])!;
    this.state.starGems -= cost;
    if (success) { this.state.starLevels[slotIndex]++; this.state.starFailures[slotIndex] = 0; }
    else this.state.starFailures[slotIndex] = Math.min(Number.MAX_SAFE_INTEGER, this.state.starFailures[slotIndex] + 1);
    this.changed(success); return { ok: true, status: success ? 'success' : 'failure' };
  }
  beginAd(kind: AdKind): WeaponActionResult {
    if (!['daily', 'weapon'].includes(kind)) return this.fail('invalidAd');
    if (!this.unlocked()) return this.fail('weaponsLocked');
    if (this.tutorialActive()) return this.fail('tutorialStep');
    if (!this.content.isAdEnabled(kind === 'daily' ? 'weapon-daily' : 'weapon-unlock')) return this.fail('adsDisabled');
    this.tick(); if (this.pendingAd || this.isRewardedAdBusy()) return this.fail('adInProgress');
    if (kind === 'daily') {
      if (!this.dailyAdUnlocked()) return this.fail('locked');
      if (this.dailyAdUsed() >= ECONOMY_CONFIG.weapons.dailyAd.dailyLimit) return this.fail('dailyUsed');
      if (this.freeSlot() < 0) return this.fail('backpackFull');
    }
    if (kind === 'weapon' && !this.state.backpack.some(item => item && item.pendingAd)) return this.fail('noAdWeapon');
    if (this.state.nextAdId >= Number.MAX_SAFE_INTEGER) return this.fail('adTokenExhausted');
    const token = `weapon-ad-${this.state.nextAdId++}`;
    this.pendingAd = { token, kind }; this.changed(); return { ok: true, token };
  }
  completeAd(token: string, outcome: AdOutcome): WeaponActionResult {
    const pending = this.pendingAd;
    if (!pending || pending.token !== token) return this.fail('staleAd');
    if (!['success', 'cancel', 'failure'].includes(outcome)) return this.fail('invalidAdOutcome');
    if (this.tutorialActive()) {
      this.pendingAd = null; this.expire(); this.changed(); return this.fail('tutorialStep');
    }
    const allowed = this.unlocked() && this.content.isAdEnabled(pending.kind === 'daily' ? 'weapon-daily' : 'weapon-unlock');
    if (!allowed || (pending.kind === 'daily' && !this.dailyAdUnlocked())) {
      this.pendingAd = null; this.expire(); this.changed(); return this.fail(allowed ? 'locked' : 'adsDisabled');
    }
    if (outcome !== 'success') {
      this.pendingAd = null; this.expire(); this.changed(); return this.fail(outcome === 'cancel' ? 'adCancelled' : 'adFailed');
    }
    let result: WeaponActionResult = { ok: true };
    if (pending.kind === 'daily') {
      const at = this.freeSlot();
      if (this.dailyAdUsed() >= ECONOMY_CONFIG.weapons.dailyAd.dailyLimit) result = this.fail('dailyUsed');
      else if (at < 0) result = this.fail('backpackFull');
      else {
        const candidates = getWeaponIdsForGrade(ECONOMY_CONFIG.weapons.dailyAd.grade), weaponId = candidates[this.randomIndex(candidates.length)];
        this.state.backpack[at] = { weaponId, locked: false, pendingAd: false };
        this.state.dailyAdCount = this.dailyAdUsed() + 1; this.state.dailyAdDate = dateKey(this.now);
        result = this.collect(weaponId);
      }
    } else {
      const at = this.state.backpack.findIndex(item => item && item.pendingAd);
      if (at < 0) result = this.fail('noAdWeapon');
      else {
        // Honor the saved offer after a balance update changes future offers.
        const weaponId = this.state.backpack[at]!.weaponId;
        this.state.backpack[at] = { weaponId, locked: false, pendingAd: false };
        this.state.adGunExpiresAt = 0; result = this.collect(weaponId, true);
      }
    }
    this.pendingAd = null; this.expire(); this.changed(); return result;
  }
  /** Historical progress is monotonic and independent of the current/replayed round. */
  recordStageValue(value: number): void {
    if (integer(value) && value > this.state.stageValueMax) { this.state.stageValueMax = value; this.changed(); }
  }
  configureTest(config: WeaponTestConfiguration): WeaponActionResult {
    if (this.environment !== 'test') return this.fail('testOnly');
    if ((config.starLevels && (config.starLevels.length !== EQUIPMENT_CAPACITY || config.starLevels.some(level => !integer(level, 0, MAX_STAR_LEVEL)))) ||
      (config.starFailures && (config.starFailures.length !== EQUIPMENT_CAPACITY || config.starFailures.some(count => !integer(count))))) return this.fail('invalidTestConfiguration');
    const next = this.serialize();
    for (const field of ['stageValueMax', 'diamonds', 'starGems', 'autoEnabled', 'autoMergeDegree', 'adGunEnabled'] as const) {
      if (config[field] !== undefined) (next as unknown as Record<string, unknown>)[field] = config[field];
    }
    if (config.starLevels) next.starLevels = [...config.starLevels];
    if (config.starFailures) next.starFailures = [...config.starFailures];
    try { this.state = WeaponInventory.validate(next); } catch (_) { return this.fail('invalidTestConfiguration'); }
    this.expire(); this.changed(); return { ok: true };
  }
  grantTestWeapon(weaponId: number): WeaponActionResult {
    if (this.environment !== 'test') return this.fail('testOnly');
    if (!isWeaponId(weaponId)) return this.fail('invalidWeapon'); this.tick();
    const at = this.freeSlot(); if (at < 0) return this.fail('backpackFull');
    this.state.backpack[at] = { weaponId, locked: false, pendingAd: false }; const result = this.collect(weaponId); this.changed(); return result;
  }
  refillTestResources(): WeaponActionResult {
    if (!this.isTestEnvironment) return this.fail('testOnly');
    const resources = this.content.config.testResources;
    this.state.diamonds = Math.max(this.state.diamonds, resources.diamonds);
    this.state.starGems = Math.max(this.state.starGems, resources.starGems);
    this.changed(); return { ok: true };
  }
  grantTestStarGems(amount: number): WeaponActionResult {
    if (this.environment !== 'test') return this.fail('testOnly');
    return this.grantStarGems(amount);
  }
  /** Earned raid and mission rewards use the normal durable star-gem wallet. */
  grantStarGems(amount: number): WeaponActionResult {
    if (!integer(amount) || !integer(this.state.starGems + amount)) return this.fail('invalidAmount');
    if (amount > 0) { this.state.starGems += amount; this.changed(); }
    return { ok: true };
  }
  advanceTestTime(milliseconds: number): WeaponActionResult {
    if (this.environment !== 'test') return this.fail('testOnly');
    if (!integer(milliseconds) || !integer(this.state.testTimeOffsetMs + milliseconds) ||
      !integer(this.now + milliseconds, 0, MAX_DATE_MS - AD_WEAPON_DURATION_MS)) return this.fail('invalidTime');
    this.state.testTimeOffsetMs += milliseconds; this.expire(); this.changed(); return { ok: true };
  }
}
