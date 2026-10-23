import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { ADVENTURE_RULES as rules } from './ContentConfig';
import { isPetGrade, PetSave, PetSlotRef } from './PetSystem';

export type MapType = 0 | 1 | 2;
export type CoreType = MapType | 3;
export type AdventureMapStatus = 'locked' | 'available' | 'closed' | 'running' | 'finished';
export interface AdventureDispatchPet extends PetSlotRef { grade: number; }
export interface AdventureMapSave { startedAt: number | null; runId: number; pets: AdventureDispatchPet[]; }
export interface AdventureSave {
  version: 1; level: number; exp: number; tickets: number; lastTicketChargeAt: number;
  cores: number[]; maps: AdventureMapSave[]; adDate: string; adUsed: number; nextRunId: number;
}
export interface AdventureActionResult {
  ok: boolean; reason?: string; changed?: boolean; runId?: number; token?: string;
  beforeLevel?: number; beforeExp?: number; coreGain?: number; expGain?: number; type?: MapType; index?: number;
}
export interface AdventurePreview {
  effectiveHours: number; durationMs: number; ticketCost: number; rewardCore: number; rewardExp: number;
  canStart: boolean; reason?: string;
}
export interface AdventureMapSnapshot extends AdventureMapSave {
  type: MapType; index: number; status: AdventureMapStatus; baseHours: number; effectiveHours: number;
  unlockLevel: number; remainingMs: number; rewardCore: number; rewardExp: number; adAvailable: boolean; openToday: boolean;
}
export interface AdventureSnapshot {
  level: number; displayLevel: number; exp: number; requiredExp: number; expRatio: number; maxLevel: number;
  tickets: number; ticketMax: number; ticketRemainingMs: number; cores: number[]; openPetSlots: number;
  adRemaining: number; maps: AdventureMapSnapshot[]; alert: boolean; mapAlert: boolean; coreAlert: boolean;
  availablePets: AdventureDispatchPet[]; revision: number;
}
const config = ECONOMY_CONFIG.adventure;
const HOUR_MS = 3600000;
const slotKey = (ref: PetSlotRef): string => `${ref.kind}:${ref.index}`;
const integer = (n: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): n is number => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;
function time(now: number): number {
  const date = new Date(now);
  if (!integer(now) || !Number.isFinite(date.getTime()) || date.getFullYear() > 9999) throw new Error('Invalid adventure time');
  return now;
}
function validRef(ref: PetSlotRef): boolean { return !!ref && integer(ref.index, 0, ref.kind === 'owned' ? 15 : 2) && (ref.kind === 'owned' || ref.kind === 'selected'); }
function gradeAt(save: PetSave, ref: PetSlotRef): number { return validRef(ref) && save && Array.isArray(save[ref.kind]) ? save[ref.kind][ref.index] : -1; }
function dayKey(now: number): string {
  const d = new Date(time(now));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function validDay(day: unknown): day is string {
  if (typeof day !== 'string') return false;
  if (day === '') return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}
export function adventureRequiredExp(level: number): number { return config.expQuadratic * level * level + config.expLinear * level + config.expBase; }
/** ARM64 FMUL, FADD, FADD per pet, two FMULs then FCVTZS. Do not replace with double arithmetic. */
export function adventureCoreReward(grades: readonly number[], hours: number): number {
  const f = Math.fround, coefficient = f(config.petGradeCoreBonus);
  let sum = 0;
  for (const grade of grades) sum = f(sum + f(f(grade * coefficient) + 1));
  return Math.trunc(f(f(sum * config.corePerHour) * hours));
}
export function adventureOpenDay(type: number, weekday: number): boolean {
  return integer(type, 0, 2) && integer(weekday, 0, 6) && rules.openDays[type].includes(weekday);
}
const emptyMaps = (): AdventureMapSave[] => Array.from({ length: 15 }, () => ({ startedAt: null, runId: 0, pets: [] }));
const copyMap = (map: AdventureMapSave): AdventureMapSave => ({ ...map, pets: map.pets.map(pet => ({ ...pet })) });
/** Native GetLockedGrades scans owned slots then selected slots when calculating a completed trip. */
const rewardOrder = (a: AdventureDispatchPet, b: AdventureDispatchPet): number => a.kind === b.kind ? a.index - b.index : a.kind === 'owned' ? -1 : 1;

/** Pure candidate state. AdventureSave is the sole persisted authority for all 19 pet locks. */
export class AdventureSystem {
  private data: AdventureSave;
  private revision = 0;
  constructor(nowMs = Date.now()) {
    this.data = { version: 1, level: 0, exp: 0, tickets: config.initialTickets, lastTicketChargeAt: time(nowMs),
      cores: [...config.initialCores], maps: emptyMaps(), adDate: '', adUsed: 0, nextRunId: 1 };
  }
  serialize(): AdventureSave { return { ...this.data, cores: [...this.data.cores], maps: this.data.maps.map(copyMap) }; }
  /** Session-controlled test funding preserves trips, recharge time and larger balances. */
  ensureResourceFloor(ticketFloor: number, coreFloor: number): boolean {
    if (!integer(ticketFloor) || !integer(coreFloor)) return false;
    const tickets = Math.max(this.data.tickets, ticketFloor), cores = this.data.cores.map(value => Math.max(value, coreFloor));
    if (tickets === this.data.tickets && cores.every((value, index) => value === this.data.cores[index])) return false;
    this.data = { ...this.data, tickets, cores }; this.revision++; return true;
  }
  restore(value: unknown, pets?: PetSave, nowMs?: number): void {
    if (nowMs !== undefined) time(nowMs);
    if (value === undefined) return;
    const d = value as AdventureSave, fail = (): never => { throw new Error('Invalid adventure save'); };
    if (!d || d.version !== 1 || !integer(d.level, 0, config.maxLevel) || !integer(d.exp) || (d.level === config.maxLevel ? d.exp !== 0 : d.exp >= adventureRequiredExp(d.level))
      || !integer(d.tickets) || !integer(d.lastTicketChargeAt) || !Number.isFinite(new Date(d.lastTicketChargeAt).getTime())
      || !Array.isArray(d.cores) || d.cores.length !== 4 || d.cores.some(n => !integer(n))
      || !Array.isArray(d.maps) || d.maps.length !== 15 || !validDay(d.adDate) || !integer(d.adUsed)
      || !integer(d.nextRunId, 1)) fail();
    const occupied = new Set<string>(), runs = new Set<number>();
    d.maps.forEach((map, i) => {
      if (!map || !Array.isArray(map.pets) || map.pets.length > rules.petSlotUnlockLevels.filter(level => level <= d.level).length || !integer(map.runId)) fail();
      if (map.startedAt === null) { if (map.pets.length || map.runId !== 0) fail(); return; }
      // Negative start times can arise when an ad reduces a trip near the epoch; real clock values stay safe.
      if (!Number.isSafeInteger(map.startedAt) || !Number.isFinite(new Date(map.startedAt).getTime()) || !map.pets.length
        || map.runId < 1 || map.runId >= d.nextRunId || runs.has(map.runId) || rules.unlockLevels[i % 5] > d.level) fail();
      runs.add(map.runId);
      for (const ref of map.pets) {
        if (!validRef(ref) || !isPetGrade(ref.grade) || occupied.has(slotKey(ref)) || (pets && gradeAt(pets, ref) !== ref.grade)) fail();
        occupied.add(slotKey(ref));
      }
    });
    this.data = { ...d, cores: [...d.cores], maps: d.maps.map(copyMap) }; this.revision++;
  }
  locks(): PetSlotRef[] { const refs: PetSlotRef[] = []; for (const map of this.data.maps) for (const { kind, index } of map.pets) refs.push({ kind, index }); return refs; }
  /** Repair only structurally valid legacy trips whose pet slots changed while
   * release-build locks were broken. Cancel the affected whole trip and return
   * its spent tickets once; keep valid trips, pets, cores and experience intact. */
  recoverUnavailablePets(pets: PetSave, nowMs: number): number {
    const invalid = this.data.maps.filter(map => map.pets.some(ref => gradeAt(pets, ref) !== ref.grade));
    if (!invalid.length) return 0;
    const refunded = invalid.reduce((total, map) => total + map.pets.length, 0);
    const ticket = this.ticketState(nowMs);
    if (!integer(ticket.tickets + refunded)) throw new Error('Adventure ticket refund exceeds wallet limit');
    Object.assign(this.data, ticket); this.data.tickets += refunded;
    for (const map of invalid) { map.startedAt = null; map.runId = 0; map.pets = []; }
    this.revision++; return invalid.length;
  }
  get cores(): readonly number[] { return [...this.data.cores]; }
  coreCount(type: number): number { return integer(type, 0, 3) ? this.data.cores[type] : 0; }
  get openPetSlots(): number { return rules.petSlotUnlockLevels.filter(level => level <= this.data.level).length; }
  private index(type: number, index: number): number { return integer(type, 0, 2) && integer(index, 0, 4) ? type * 5 + index : -1; }
  private effectiveHours(index: number, plusPack: boolean): number { return Math.max(0, config.durationHours[index] - (plusPack ? config.plusPackReduceHours : 0)); }
  private ticketState(nowMs: number): { tickets: number; lastTicketChargeAt: number } {
    time(nowMs);
    const { tickets, lastTicketChargeAt } = this.data;
    if (tickets >= config.ticketMax) return { tickets, lastTicketChargeAt };
    const interval = config.ticketChargeHours * HOUR_MS, count = Math.max(0, Math.floor((nowMs - lastTicketChargeAt) / interval));
    if (!count) return { tickets, lastTicketChargeAt };
    const next = Math.min(config.ticketMax, tickets + count);
    return { tickets: next, lastTicketChargeAt: next === config.ticketMax ? nowMs : lastTicketChargeAt + count * interval };
  }
  refresh(nowMs: number): boolean {
    const next = this.ticketState(nowMs), changed = next.tickets !== this.data.tickets || next.lastTicketChargeAt !== this.data.lastTicketChargeAt;
    if (changed) { Object.assign(this.data, next); this.revision++; } return changed;
  }
  private usedAds(nowMs: number): number { return dayKey(nowMs) > this.data.adDate ? 0 : this.data.adUsed; }
  availablePets(pets: PetSave): AdventureDispatchPet[] {
    const occupied = new Set(this.locks().map(slotKey)), result: AdventureDispatchPet[] = [];
    for (const kind of ['selected', 'owned'] as const) pets[kind].forEach((grade, index) => {
      if (isPetGrade(grade) && !occupied.has(slotKey({ kind, index }))) result.push({ kind, index, grade });
    });
    return result;
  }
  autoSelect(pets: PetSave): AdventureDispatchPet[] {
    return this.availablePets(pets).map((pet, order) => ({ pet, order }))
      .sort((a, b) => b.pet.grade - a.pet.grade || a.order - b.order).slice(0, this.openPetSlots).map(item => item.pet);
  }
  map(type: number, index: number, nowMs: number, plusPack = false): AdventureMapSnapshot | null {
    time(nowMs);
    const flat = this.index(type, index); if (flat < 0) return null;
    const item = this.data.maps[flat], effectiveHours = this.effectiveHours(index, plusPack), baseHours = config.durationHours[index];
    const openToday = adventureOpenDay(type, new Date(nowMs).getDay()), unlocked = this.data.level >= rules.unlockLevels[index];
    const remainingMs = item.startedAt === null ? 0 : Math.max(0, item.startedAt + effectiveHours * HOUR_MS - nowMs);
    const status: AdventureMapStatus = !unlocked ? 'locked' : item.startedAt !== null ? remainingMs > 0 ? 'running' : 'finished' : openToday ? 'available' : 'closed';
    const highest = rules.unlockLevels.reduce((last, value, i) => value <= this.data.level ? i : last, 0);
    const ordered = [...item.pets].sort(rewardOrder);
    return { ...copyMap(item), type: type as MapType, index, status, baseHours, effectiveHours, unlockLevel: rules.unlockLevels[index] + 1,
      remainingMs, rewardCore: adventureCoreReward(ordered.map(pet => pet.grade), baseHours), rewardExp: baseHours * config.expPerHour * item.pets.length,
      openToday, adAvailable: !plusPack && (!rules.adHighestUnlockedOnly || index === highest) && status === 'running' && this.usedAds(nowMs) < config.adDailyLimit };
  }
  snapshot(pets: PetSave, nowMs: number, plusPack = false): AdventureSnapshot {
    const ticket = this.ticketState(nowMs), maps = this.data.maps.map((_, i) => this.map(Math.floor(i / 5), i % 5, nowMs, plusPack)!);
    const requiredExp = this.data.level === config.maxLevel ? 0 : adventureRequiredExp(this.data.level), mapAlert = maps.some(map => map.status === 'finished');
    const coreAlert = this.data.cores.some(count => count >= ECONOMY_CONFIG.relics.drawPrice);
    return { level: this.data.level, displayLevel: this.data.level + 1, exp: this.data.exp, requiredExp,
      expRatio: requiredExp ? this.data.exp / requiredExp : 1, maxLevel: config.maxLevel, tickets: ticket.tickets, ticketMax: config.ticketMax,
      ticketRemainingMs: ticket.tickets >= config.ticketMax ? 0 : Math.max(0, ticket.lastTicketChargeAt + config.ticketChargeHours * HOUR_MS - nowMs),
      cores: [...this.data.cores], openPetSlots: this.openPetSlots, adRemaining: Math.max(0, config.adDailyLimit - this.usedAds(nowMs)),
      maps, alert: mapAlert || coreAlert, mapAlert, coreAlert, availablePets: this.availablePets(pets), revision: this.revision };
  }
  preview(type: number, index: number, refs: readonly PetSlotRef[], pets: PetSave, nowMs: number, plusPack = false): AdventurePreview {
    const map = this.map(type, index, nowMs, plusPack), available = new Map(this.availablePets(pets).map(pet => [slotKey(pet), pet]));
    const selected = refs.filter(validRef).map(ref => available.get(slotKey(ref)));
    let reason: string | undefined;
    if (!map) reason = 'invalid';
    else if (map.status !== 'available') reason = map.status;
    else if (!refs.length) reason = 'empty';
    else if (refs.length > this.openPetSlots) reason = 'slots';
    else if (selected.length !== refs.length || selected.some(pet => !pet) || new Set(refs.map(slotKey)).size !== refs.length) reason = 'petUnavailable';
    else if (this.ticketState(nowMs).tickets < refs.length) reason = 'tickets';
    // Native ready-panel preview uses selection order. Preserve its float32 ordering even though
    // completed trips use GetLockedGrades slot order, which can differ by one core after truncation.
    const grades = selected.filter((pet): pet is AdventureDispatchPet => !!pet).map(pet => pet.grade);
    return { effectiveHours: map?.effectiveHours ?? 0, durationMs: (map?.effectiveHours ?? 0) * HOUR_MS, ticketCost: refs.length,
      rewardCore: adventureCoreReward(grades, map?.baseHours ?? 0), rewardExp: (map?.baseHours ?? 0) * config.expPerHour * grades.length, canStart: !reason, ...(reason ? { reason } : {}) };
  }
  start(type: number, index: number, refs: readonly PetSlotRef[], pets: PetSave, nowMs: number, plusPack = false): AdventureActionResult {
    const preview = this.preview(type, index, refs, pets, nowMs, plusPack);
    if (!preview.canStart) return { ok: false, reason: preview.reason };
    if (!integer(this.data.nextRunId + 1)) return { ok: false, reason: 'limit' };
    this.refresh(nowMs);
    if (this.data.tickets >= config.ticketMax) this.data.lastTicketChargeAt = nowMs;
    this.data.tickets -= refs.length;
    const runId = this.data.nextRunId++;
    this.data.maps[this.index(type, index)] = { startedAt: nowMs, runId, pets: refs.map(ref => ({ kind: ref.kind, index: ref.index, grade: gradeAt(pets, ref) })) };
    this.revision++; return { ok: true, changed: true, runId, type: type as MapType, index };
  }
  claim(type: number, index: number, nowMs: number, plusPack = false): AdventureActionResult {
    const map = this.map(type, index, nowMs, plusPack);
    if (!map || map.status !== 'finished') return { ok: false, reason: map ? 'notFinished' : 'invalid' };
    if (!integer(this.data.cores[type] + map.rewardCore)) return { ok: false, reason: 'walletLimit' };
    const beforeLevel = this.data.level, beforeExp = this.data.exp;
    this.data.cores[type] += map.rewardCore;
    if (this.data.level < config.maxLevel) {
      this.data.exp += map.rewardExp;
      while (this.data.level < config.maxLevel && this.data.exp >= adventureRequiredExp(this.data.level)) {
        this.data.exp -= adventureRequiredExp(this.data.level); this.data.level++;
      }
      if (this.data.level === config.maxLevel) this.data.exp = 0;
    }
    this.data.maps[this.index(type, index)] = { startedAt: null, runId: 0, pets: [] }; this.revision++;
    return { ok: true, changed: true, beforeLevel, beforeExp, coreGain: map.rewardCore, expGain: map.rewardExp, type: type as MapType, index };
  }
  cancel(type: number, index: number): AdventureActionResult {
    const flat = this.index(type, index);
    if (flat < 0 || this.data.maps[flat].startedAt === null) return { ok: false, reason: flat < 0 ? 'invalid' : 'notRunning' };
    this.data.maps[flat] = { startedAt: null, runId: 0, pets: [] }; this.revision++; return { ok: true, changed: true };
  }
  reduceByAd(type: number, index: number, expectedRunId: number, nowMs: number, plusPack = false): AdventureActionResult {
    const map = this.map(type, index, nowMs, plusPack);
    if (!map || map.runId !== expectedRunId || !integer(expectedRunId, 1)) return { ok: false, reason: 'stale' };
    if (!map.adAvailable) return { ok: false, reason: 'unavailable' };
    const today = dayKey(nowMs), used = this.usedAds(nowMs);
    this.data.maps[this.index(type, index)].startedAt! -= config.adReduceMinutes * 60000;
    if (today > this.data.adDate) this.data.adDate = today;
    this.data.adUsed = used + 1; this.revision++; return { ok: true, changed: true, runId: map.runId };
  }
  grantCores(type: number, amount: number): AdventureActionResult {
    if (!integer(type, 0, 3) || !integer(amount) || !integer(this.data.cores[type] + amount)) return { ok: false, reason: 'walletLimit' };
    this.data.cores[type] += amount; if (amount) this.revision++; return { ok: true, changed: amount > 0 };
  }
  spendCores(type: number, amount: number): AdventureActionResult {
    if (!integer(type, 0, 3) || !integer(amount)) return { ok: false, reason: 'invalid' };
    if (this.data.cores[type] < amount) return { ok: false, reason: 'currency' };
    this.data.cores[type] -= amount; if (amount) this.revision++; return { ok: true, changed: amount > 0 };
  }
}
