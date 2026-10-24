import { DecimalAmount } from '../core/DecimalAmount';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { OriginalInfVal } from '../core/OriginalInfVal';
import { RaidBossCombat } from '../core/RaidBossCombat';
import { getWeapon, getWeaponGrade } from '../core/WeaponCatalog';
import type { WeaponType } from '../core/WeaponCatalog';
import { ContentUnlockManager } from './ContentUnlockManager';
import { getStarPercent } from './WeaponInventory';
import type { WeaponInventorySnapshot } from './WeaponInventory';
import type { SessionActorLoadout } from './BattleSession';
import type { SkinBonuses } from './SkinCatalog';
import type { FishBonuses } from './FishSystem';

export const RAID_SECONDS = 60;
export const RAID_FREE_LIMIT = ECONOMY_CONFIG.raid.freeEntriesPerDay;
export const RAID_ENTER_SECONDS = 2;
export const RAID_EXIT_SECONDS = 1.5;
export type RaidPhase = 'idle' | 'preparing' | 'adPending' | 'entering' | 'playing' | 'result' | 'exiting';
export type RaidAdOutcome = import('./RewardedAds').RewardedAdOutcome;
export interface RaidActionResult { ok: boolean; reason?: string; token?: string; }
/** Owned inventory location plus the expected weapon; no global item IDs needed. */
export interface RaidWeaponSource { kind: 'equipment' | 'backpack'; index: number; weaponId: number; }
export interface RaidWeaponSnapshot {
  source: Readonly<RaidWeaponSource>;
  sourceIndex: number; weaponId: number; name: string; type: WeaponType; grade: number;
  weak: boolean; damage: DecimalAmount; attackInterval: number; raidSlot: number | null;
  starLevel: number; selected: boolean; canSelect: boolean;
}
export interface RaidMissionSnapshot {
  index: number; type: 'tries' | 'best'; target: number; progress: number; reward: number;
  complete: boolean; claimed: boolean; claimable: boolean;
}
export interface RaidSnapshot {
  unlocked: boolean; unlockMessage?: string; phase: RaidPhase;
  seasonIndex: number; bossIndex: number; weakness: WeaponType; seasonRemainingSeconds: number;
  freeRemaining: number; freeLimit: number; adEnabled: boolean; adAvailable: boolean; canEnter: boolean;
  starGems: number; seasonTryCount: number; seasonBestLevel: number; bestByType: readonly number[];
  remainingSeconds: number; durationSeconds: number; clearedLevels: number; level: number;
  health: DecimalAmount; maxHealth: DecimalAmount; healthRatio: number;
  reward: number; newRecord: boolean; resultElapsed: number; loadingElapsed: number | null;
  slots: readonly (RaidWeaponSnapshot | null)[]; candidates: readonly RaidWeaponSnapshot[];
  missions: readonly RaidMissionSnapshot[]; hasClaimable: boolean;
  /** Stable while the corresponding presentation data is unchanged. */
  candidatesRevision?: number; missionsRevision?: number;
}
export interface RaidSave {
  entryDay: number; freeUsed: number; adUsed: boolean; adUsedCount: number; seasonIndex: number;
  seasonTryCount: number; seasonBestLevel: number; bestByType: number[];
  missionClear: boolean[]; missionClaimed: boolean[]; lastSeenMs: number;
}
export interface RaidTestConfiguration { freeUsed?: number; adUsed?: boolean; seasonTryCount?: number; seasonBestLevel?: number; }
type Selection = RaidWeaponSource;
export const RAID_MISSIONS = ECONOMY_CONFIG.raid.missions;
const TYPE_ORDER: readonly WeaponType[] = ['SINGLE', 'LASER', 'PIERCE', 'SHOTGUN', 'EXPLOSIVE', 'MISSILE', 'BLAST_SNIPER'];
const DAY_MS = 86400000;
const EPOCH_DAY = Date.UTC(2024, 0, 1) / DAY_MS;
const validInt = (n: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
let instanceSerial = 0;

/** Civil-day arithmetic avoids DST changing a seven-day week into a fraction. */
export function raidCalendar(now: number): { day: number; seasonIndex: number; bossIndex: number; seasonEndsAt: number } {
  const d = new Date(now), day = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
  const seasonIndex = Math.floor((day - EPOCH_DAY) / 7);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (7 - (d.getDay() + 6) % 7));
  return { day, seasonIndex, bossIndex: (seasonIndex % 5 + 5) % 5, seasonEndsAt: end.getTime() };
}
export function raidReward(cleared: number): number {
  let remaining = Math.max(0, Math.floor(cleared)), total = 0;
  for (const tier of ECONOMY_CONFIG.raid.starGemTiers) {
    const count = Math.min(remaining, tier.levels);
    total += count * tier.perLevel; remaining -= count;
  }
  return total + remaining * ECONOMY_CONFIG.raid.starGemsPerExtraLevel;
}
const RAID_WEAKNESSES: readonly WeaponType[] = ['PIERCE', 'EXPLOSIVE', 'LASER', 'MISSILE', 'BLAST_SNIPER'];
export function raidWeakness(bossIndex: number): WeaponType { return RAID_WEAKNESSES[(bossIndex % 5 + 5) % 5]; }
function raidAttackInterval(base: number, skinSpeedBonus: number, buffMultiplier = 1): number {
  const percent = Math.max(100, Math.min(10000, skinSpeedBonus));
  return Math.max(Math.fround(.05), Math.min(2, Math.fround(Math.fround(Math.fround(base / percent) * 100) / buffMultiplier)));
}
function rawDamage(weaponId: number): OriginalInfVal {
  const weapon = getWeapon(weaponId);
  return OriginalInfVal.fromAmount(DecimalAmount.from(weapon.damage), weapon.damage.split(/[eE]/)[0].replace(/^[+-]/, '').length);
}
function baseDamage(weaponId: number, weakness: WeaponType): OriginalInfVal {
  const weapon = getWeapon(weaponId);
  let damage = rawDamage(weaponId);
  if (weapon.type === weakness) damage = damage.mul(10);
  return damage;
}
const sourceIndexOf = (source: RaidWeaponSource): number => source.index + (source.kind === 'equipment' ? 0 : 3);

/** Raid（突袭）owns eligibility and durable counters; it is separate from the 'Boss' battle mode.
 * BattleSession commits its grants with the shared wallet; CombatWorld synchronously
 * updates the Raid boss enemy. Boss fields in this class refer to that enemy. */
export class RaidSystem {
  private state: RaidSave;
  private phaseValue: RaidPhase = 'idle';
  private selected: (Selection | null)[] = [null, null, null];
  private frozenLoadout: SessionActorLoadout[] = [];
  private frozenSkinSpeed = 0;
  private playedSeason = 0;
  private playedBoss = 0;
  private runBest = 0;
  private runNewRecord = false;
  private loading = 0;
  private remaining = RAID_SECONDS;
  private elapsedValue = 0;
  private resultTime = 0;
  private pending: { token: string; day: number; season: number } | null = null;
  private readonly instanceId = ++instanceSerial;
  private requestSerial = 0;
  private candidateKey = '';
  private candidatesRevision = 0;
  private candidateCache: RaidWeaponSnapshot[] = [];
  private missionKey = '';
  private missionsRevision = 0;
  private missionCache: RaidMissionSnapshot[] = [];
  bossCombat: RaidBossCombat | null = null;

  constructor(private readonly content: ContentUnlockManager,
    private readonly inventory: () => WeaponInventorySnapshot, private readonly clock: () => number = Date.now,
    private readonly skinBonuses: () => SkinBonuses = () => ({ damagePercent: 0, speedPercent: 0, moneyPercent: 0 }),
    private readonly fishBonuses: () => FishBonuses = () => ({ damagePercent: 0, criticalChancePercent: 0, criticalDamagePercent: 0 }),
    private readonly speedBuffMultiplier: () => number = () => 1,
    private readonly relicBonuses: () => { damage: OriginalInfVal; criticalDamage: OriginalInfVal } =
      () => ({ damage: OriginalInfVal.fromInt(100), criticalDamage: OriginalInfVal.fromInt(100) })) {
    const now = this.readClock(), cal = raidCalendar(now);
    this.state = { entryDay: cal.day, freeUsed: 0, adUsed: false, adUsedCount: 0, seasonIndex: cal.seasonIndex,
      seasonTryCount: 0, seasonBestLevel: 0, bestByType: new Array(7).fill(0),
      missionClear: new Array(RAID_MISSIONS.length).fill(false), missionClaimed: new Array(RAID_MISSIONS.length).fill(false), lastSeenMs: now };
  }
  get phase(): RaidPhase { return this.phaseValue; }
  get canFight(): boolean { return this.phaseValue === 'playing'; }
  get adPending(): boolean { return this.phaseValue === 'adPending'; }
  get active(): boolean { return ['entering', 'playing', 'result', 'exiting'].includes(this.phaseValue); }
  get remainingSeconds(): number { return Math.max(0, this.remaining); }
  get elapsed(): number { return this.elapsedValue; }
  get loadout(): readonly SessionActorLoadout[] {
    return this.frozenLoadout.map(actor => ({ ...actor,
      attackInterval: raidAttackInterval(actor.weapon.attackInterval, this.frozenSkinSpeed, this.speedBuffMultiplier()) }));
  }
  starPreview(slot: number, level: number): string | null {
    if (!validInt(slot, 0, 2) || !validInt(level, 0, 20)) return null;
    const selected = this.selected[slot];
    if (!selected || !this.candidates().some(c => c.sourceIndex === sourceIndexOf(selected) && c.weaponId === selected.weaponId)) return null;
    let damage = baseDamage(selected.weaponId, raidWeakness(this.bossIndex()));
    if (level > 0) damage = damage.mul(getStarPercent(level)).div(100);
    return damage.amount.format();
  }
  serialize(): RaidSave { return { ...this.state, bestByType: [...this.state.bestByType], missionClear: [...this.state.missionClear], missionClaimed: [...this.state.missionClaimed] }; }
  restore(value: unknown): void {
    const s = value as RaidSave | null;
    // A lowered daily cap must not invalidate an existing save with more uses.
    if (!s || !validInt(s.entryDay, -100000000, 100000000) || !validInt(s.freeUsed)
      || typeof s.adUsed !== 'boolean' || !validInt(s.seasonIndex, -20000000, 20000000)
      || !validInt(s.seasonTryCount) || !validInt(s.seasonBestLevel) || !validInt(s.lastSeenMs, 0, 8640000000000000)
      || !Array.isArray(s.bestByType) || s.bestByType.length !== 7 || !s.bestByType.every(n => validInt(n))
      || !validInt(s.adUsedCount) || s.adUsed !== (s.adUsedCount > 0)
      || !Array.isArray(s.missionClear) || s.missionClear.length !== RAID_MISSIONS.length || s.missionClear.some(b => typeof b !== 'boolean')
      || !Array.isArray(s.missionClaimed) || s.missionClaimed.length !== RAID_MISSIONS.length || s.missionClaimed.some((b, i) => typeof b !== 'boolean' || (b && !s.missionClear[i]))) throw new Error('Invalid raid save');
    this.state = { ...s, bestByType: [...s.bestByType], missionClear: [...s.missionClear], missionClaimed: [...s.missionClaimed] };
    this.refreshCalendar();
  }
  private readClock(): number {
    const value = this.clock();
    return validInt(value, 0, 8640000000000000) ? value : (this.state?.lastSeenMs ?? 0);
  }
  /** Forward-only boundaries: changing the device clock backwards cannot refill tickets. */
  refreshCalendar(): boolean {
    const now = Math.max(this.state.lastSeenMs, this.readClock()), cal = raidCalendar(now);
    this.state.lastSeenMs = now;
    let changed = false;
    if (cal.day > this.state.entryDay) {
      this.state.entryDay = cal.day; this.state.freeUsed = 0; this.state.adUsed = false; this.state.adUsedCount = 0; changed = true;
    }
    if (cal.seasonIndex > this.state.seasonIndex) {
      this.state.seasonIndex = cal.seasonIndex; this.state.seasonTryCount = 0; this.state.seasonBestLevel = 0;
      this.state.missionClear.fill(false); this.state.missionClaimed.fill(false); changed = true;
    }
    if (changed && this.pending) this.cancelAd();
    return changed;
  }
  private bossIndex(): number { return this.active ? this.playedBoss : (this.state.seasonIndex % 5 + 5) % 5; }
  private candidates(inv = this.inventory()): RaidWeaponSnapshot[] {
    const weakness = raidWeakness(this.bossIndex());
    const key = `${weakness}:${[...inv.equipment, ...inv.backpack].map(item => item ? `${item.weaponId}:${item.pendingAd}` : '-').join(',')}:${this.selected.map(item => item ? `${sourceIndexOf(item)}:${item.weaponId}` : '-').join(',')}`;
    if (key === this.candidateKey) return this.candidateCache.map(item => ({ ...item, source: { ...item.source } }));
    const result: RaidWeaponSnapshot[] = [];
    [...inv.equipment, ...inv.backpack].forEach((item, sourceIndex) => {
      if (!item || item.pendingAd) return;
      const weapon = getWeapon(item.weaponId), raidSlot = this.selected.findIndex(s => s && sourceIndexOf(s) === sourceIndex && s.weaponId === item.weaponId);
      const source: RaidWeaponSource = { kind: sourceIndex < 3 ? 'equipment' : 'backpack', index: sourceIndex < 3 ? sourceIndex : sourceIndex - 3, weaponId: item.weaponId };
      result.push({ source, sourceIndex, weaponId: item.weaponId, name: weapon.name, type: weapon.type, grade: getWeaponGrade(item.weaponId),
        weak: weapon.type === weakness, damage: baseDamage(item.weaponId, weakness).amount, attackInterval: weapon.attackInterval,
        raidSlot: raidSlot < 0 ? null : raidSlot, starLevel: 0, selected: raidSlot >= 0, canSelect: raidSlot < 0 });
    });
    result.sort((a, b) => b.damage.compare(a.damage) || a.sourceIndex - b.sourceIndex);
    this.candidateKey = key; this.candidateCache = result; this.candidatesRevision++;
    return result.map(item => ({ ...item, source: { ...item.source } }));
  }
  private validateSelection(): boolean {
    const inventory = this.inventory(); let changed = false;
    this.selected = this.selected.map(s => {
      if (s) {
        const owned = inventory[s.kind][s.index];
        if (!owned || owned.pendingAd || owned.weaponId !== s.weaponId) { changed = true; return null; }
      }
      return s;
    });
    return !changed;
  }
  open(): RaidActionResult {
    this.refreshCalendar();
    if (!this.content.isUnlocked('raid')) return { ok: false, reason: 'locked' };
    if (this.phaseValue !== 'idle') return { ok: false, reason: 'busy' };
    this.phaseValue = 'preparing'; this.bossCombat = null; this.autoSelect(); return { ok: true };
  }
  close(): RaidActionResult {
    if (this.phaseValue !== 'preparing' && !this.adPending) return { ok: false, reason: 'busy' };
    this.pending = null; this.phaseValue = 'idle'; return { ok: true };
  }
  autoSelect(): RaidActionResult {
    if (this.phaseValue !== 'preparing') return { ok: false, reason: 'busy' };
    const list = this.candidates();
    this.selected = [0, 1, 2].map(i => list[i] ? { ...list[i].source } : null);
    return { ok: true };
  }
  select(raidSlot: number, sourceIndex: number): RaidActionResult {
    if (this.phaseValue !== 'preparing') return { ok: false, reason: 'busy' };
    if (!validInt(raidSlot, 0, 2)) return { ok: false, reason: 'invalidSlot' };
    const candidate = this.candidates().find(c => c.sourceIndex === sourceIndex);
    if (!candidate || candidate.selected) return { ok: false, reason: 'unavailableWeapon' };
    this.selected[raidSlot] = { ...candidate.source }; return { ok: true };
  }
  unselect(raidSlot: number): RaidActionResult {
    if (this.phaseValue !== 'preparing') return { ok: false, reason: 'busy' };
    if (!validInt(raidSlot, 0, 2) || !this.selected[raidSlot]) return { ok: false, reason: 'invalidSlot' };
    if (this.selected.filter(Boolean).length <= 1) return { ok: false, reason: 'lastWeapon' };
    this.selected[raidSlot] = null; return { ok: true };
  }
  start(): RaidActionResult {
    this.refreshCalendar();
    if (this.phaseValue !== 'preparing') return { ok: false, reason: 'busy' };
    if (this.state.freeUsed >= RAID_FREE_LIMIT) return { ok: false, reason: 'noEntries' };
    const result = this.prepareStart();
    if (result.ok) this.state.freeUsed++;
    return result;
  }
  private prepareStart(): RaidActionResult {
    if (!this.content.isUnlocked('raid')) return { ok: false, reason: 'locked' };
    if (!this.validateSelection()) return { ok: false, reason: 'loadoutChanged' };
    if (!this.selected.some(Boolean)) return { ok: false, reason: 'noWeapons' };
    const stars = this.inventory().stars, skins = this.skinBonuses(), fish = this.fishBonuses(), relics = this.relicBonuses();
    this.frozenSkinSpeed = skins.speedPercent;
    this.playedSeason = this.state.seasonIndex; this.playedBoss = (this.playedSeason % 5 + 5) % 5;
    this.runBest = this.state.seasonBestLevel; this.runNewRecord = false;
    this.frozenLoadout = [];
    this.selected.forEach((s, raidSlot) => {
      if (!s) return;
      const weapon = getWeapon(s.weaponId), starLevel = stars[raidSlot].level;
      // Preserve the separate skin, fish and relic operations before the integer cut.
      let damage = rawDamage(s.weaponId).mul(100 + skins.damagePercent).div(100).mul(100 + fish.damagePercent).div(100)
        .mul(relics.damage).div(100).discardDecimal();
      if (starLevel > 0) damage = damage.mul(getStarPercent(starLevel)).div(100);
      if (weapon.type === raidWeakness(this.playedBoss)) damage = damage.mul(10);
      // Stars use the preparation slot even across gaps; combat actors retain
      // contiguous identities for the existing leader/follower formation.
      this.frozenLoadout.push({ actorIndex: this.frozenLoadout.length, raidSlot, weapon, damage: damage.amount, damagePrecision: damage.precision,
        // Source removes the base 100 when ordinary and rebirth speed are
        // disabled: Raid's divisor is the skin bonus itself, clamped to 100.
        attackInterval: raidAttackInterval(weapon.attackInterval, skins.speedPercent), criticalChance: Math.min(1, fish.criticalChancePercent / 100),
        criticalMultiplier: (125 + fish.criticalDamagePercent) / 100, criticalRelicPercent: relics.criticalDamage, starLevel });
    });
    this.bossCombat = new RaidBossCombat(this.playedBoss);
    this.phaseValue = 'entering'; this.loading = 0; this.remaining = RAID_SECONDS;
    this.elapsedValue = 0; this.resultTime = 0; this.pending = null; return { ok: true };
  }
  beginAd(): RaidActionResult {
    this.refreshCalendar();
    if (!this.content.isAdEnabled('raid-entry')) return { ok: false, reason: 'adsDisabled' };
    if (this.phaseValue !== 'preparing') return { ok: false, reason: 'busy' };
    if (this.state.freeUsed < RAID_FREE_LIMIT || this.state.adUsedCount >= ECONOMY_CONFIG.raid.adEntriesPerDay) return { ok: false, reason: 'unavailable' };
    const token = `raid:${this.instanceId}:${++this.requestSerial}`;
    this.pending = { token, day: this.state.entryDay, season: this.state.seasonIndex }; this.phaseValue = 'adPending';
    return { ok: true, token };
  }
  completeAd(token: string, outcome: RaidAdOutcome): RaidActionResult {
    this.refreshCalendar();
    if (!this.pending || !this.adPending || this.pending.token !== token) return { ok: false, reason: 'staleAd' };
    if (!['success', 'failure', 'cancel'].includes(outcome)) return { ok: false, reason: 'invalid' };
    this.pending = null; this.phaseValue = 'preparing';
    if (!this.content.isAdEnabled('raid-entry')) return { ok: false, reason: 'adsDisabled' };
    if (outcome !== 'success') return { ok: false, reason: outcome };
    const result = this.prepareStart();
    if (result.ok) { this.state.adUsedCount++; this.state.adUsed = true; }
    return result;
  }
  cancelAd(): void { this.pending = null; if (this.adPending) this.phaseValue = 'preparing'; }
  exit(): RaidActionResult {
    if (!this.active || this.phaseValue === 'exiting') return { ok: false, reason: 'inactive' };
    this.phaseValue = 'exiting'; this.loading = 0; this.pending = null; return { ok: true };
  }
  /** CombatWorld has already processed this frame's hits before its clock commits. */
  advanceFrame(dt: number, paused: boolean): 'entered' | 'exited' | 'settled' | null {
    this.refreshCalendar();
    if (paused || !Number.isFinite(dt) || dt <= 0) return null;
    if (this.phaseValue === 'entering' || this.phaseValue === 'exiting') {
      this.loading += dt;
      const entering = this.phaseValue === 'entering';
      if (this.loading + 1e-10 < (entering ? RAID_ENTER_SECONDS : RAID_EXIT_SECONDS)) return null;
      this.loading = 0; this.phaseValue = entering ? 'playing' : 'idle';
      if (entering && this.playedSeason === this.state.seasonIndex) { this.state.seasonTryCount++; this.refreshMissions(); }
      return entering ? 'entered' : 'exited';
    }
    if (this.canFight) {
      this.remaining = Math.max(0, this.remaining - dt);
      this.elapsedValue = Math.min(RAID_SECONDS, this.elapsedValue + dt);
      if (this.remaining <= 1e-10) {
        this.remaining = 0;
        const cleared = this.bossCombat!.snapshot().clearedLevels;
        this.runNewRecord = cleared > this.runBest;
        const type = TYPE_ORDER.indexOf(raidWeakness(this.playedBoss));
        this.state.bestByType[type] = Math.max(this.state.bestByType[type], cleared);
        if (this.playedSeason === this.state.seasonIndex) { this.state.seasonBestLevel = Math.max(this.state.seasonBestLevel, cleared); this.refreshMissions(); }
        this.phaseValue = 'result'; this.resultTime = 0; return 'settled';
      }
    } else if (this.phaseValue === 'result') this.resultTime += dt;
    return null;
  }
  private refreshMissions(): void {
    RAID_MISSIONS.forEach((m, i) => {
      if ((m.type === 'tries' ? this.state.seasonTryCount : this.state.seasonBestLevel) >= m.target) this.state.missionClear[i] = true;
    });
  }
  claim(index: number): number {
    this.refreshCalendar(); this.refreshMissions();
    if (!validInt(index, 0, RAID_MISSIONS.length - 1) || !this.state.missionClear[index] || this.state.missionClaimed[index]) return 0;
    this.state.missionClaimed[index] = true; return RAID_MISSIONS[index].reward;
  }
  claimAll(): number { let total = 0; for (let i = 0; i < RAID_MISSIONS.length; i++) total += this.claim(i); return total; }
  configureTest(config: RaidTestConfiguration): boolean {
    if (this.active || this.adPending) return false;
    for (const [k, v] of Object.entries(config)) {
      if (!['freeUsed', 'adUsed', 'seasonTryCount', 'seasonBestLevel'].includes(k)) return false;
      if (k === 'adUsed' ? typeof v !== 'boolean' : !validInt(v)) return false;
    }
    this.refreshCalendar(); Object.assign(this.state, config);
    if (config.adUsed !== undefined) this.state.adUsedCount = config.adUsed ? Math.max(1, ECONOMY_CONFIG.raid.adEntriesPerDay) : 0;
    this.refreshMissions(); return true;
  }
  snapshot(): RaidSnapshot {
    const inventory = this.inventory(), unlocked = this.content.get('raid'), bossIndex = this.bossIndex();
    const candidates = this.candidates(inventory), weakness = raidWeakness(bossIndex), combat = this.active ? this.bossCombat?.snapshot() : undefined;
    const missionKey = `${this.state.seasonTryCount}:${this.state.seasonBestLevel}:${this.state.missionClear.join(',')}:${this.state.missionClaimed.join(',')}`;
    if (missionKey !== this.missionKey) {
      this.missionKey = missionKey; this.missionsRevision++;
      this.missionCache = RAID_MISSIONS.map((m, index) => ({ ...m, index,
      progress: Math.min(m.target, m.type === 'tries' ? this.state.seasonTryCount : this.state.seasonBestLevel),
      complete: this.state.missionClear[index], claimed: this.state.missionClaimed[index],
      claimable: this.state.missionClear[index] && !this.state.missionClaimed[index] }));
    }
    const missions = this.missionCache.map(item => ({ ...item }));
    const slots = this.selected.map((s, raidSlot) => {
      if (!s) return null;
      const weapon = getWeapon(s.weaponId);
      const c = candidates.find(c => c.sourceIndex === sourceIndexOf(s) && c.weaponId === s.weaponId)
        ?? (this.active ? { source: { ...s }, sourceIndex: sourceIndexOf(s), weaponId: s.weaponId, name: weapon.name, type: weapon.type,
          grade: getWeaponGrade(s.weaponId), weak: weapon.type === weakness, attackInterval: weapon.attackInterval,
          selected: true, canSelect: false } : null);
      if (!c) return null;
      const starLevel = this.active ? this.frozenLoadout.find(a => a.raidSlot === raidSlot)!.starLevel : inventory.stars[raidSlot].level;
      let damage = baseDamage(s.weaponId, weakness); if (starLevel > 0) damage = damage.mul(getStarPercent(starLevel)).div(100);
      return { ...c, raidSlot, starLevel, damage: damage.amount };
    });
    const adEnabled = this.content.isAdEnabled('raid-entry'), freeRemaining = Math.max(0, RAID_FREE_LIMIT - this.state.freeUsed);
    const clearedLevels = combat?.clearedLevels ?? 0;
    return { unlocked: unlocked.unlocked, unlockMessage: unlocked.message, phase: this.phaseValue,
      seasonIndex: this.state.seasonIndex, bossIndex, weakness,
      seasonRemainingSeconds: Math.max(0, (raidCalendar(this.state.lastSeenMs).seasonEndsAt - this.state.lastSeenMs) / 1000),
      freeRemaining, freeLimit: RAID_FREE_LIMIT, adEnabled,
      adAvailable: adEnabled && this.state.adUsedCount < ECONOMY_CONFIG.raid.adEntriesPerDay && freeRemaining === 0 && this.phaseValue === 'preparing',
      canEnter: unlocked.unlocked && this.phaseValue === 'preparing' && freeRemaining > 0 && slots.some(Boolean),
      starGems: inventory.starGems, seasonTryCount: this.state.seasonTryCount,
      seasonBestLevel: this.state.seasonBestLevel, bestByType: [...this.state.bestByType],
      remainingSeconds: this.remainingSeconds, durationSeconds: RAID_SECONDS, clearedLevels, level: combat?.level ?? 1,
      health: combat?.health ?? DecimalAmount.from(10000000), maxHealth: combat?.maxHealth ?? DecimalAmount.from(10000000), healthRatio: combat?.healthRatio ?? 1,
      reward: raidReward(clearedLevels), newRecord: this.runNewRecord || (this.canFight && clearedLevels > this.runBest), resultElapsed: this.resultTime,
      loadingElapsed: this.phaseValue === 'entering' || this.phaseValue === 'exiting' ? this.loading : null,
      candidatesRevision: this.candidatesRevision, missionsRevision: this.missionsRevision,
      slots, candidates, missions, hasClaimable: missions.some(m => m.claimable) };
  }
}
