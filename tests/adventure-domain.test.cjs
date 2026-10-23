const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const build = process.env.ADVENTURE_DOMAIN_BUILD || path.join(__dirname, '.build/session');
const { AdventureSystem, adventureCoreReward, adventureRequiredExp, adventureOpenDay } = require(path.join(build, 'session/AdventureSystem.js'));
const { PetSystem } = require(path.join(build, 'session/PetSystem.js'));
const { ECONOMY_CONFIG } = require(path.join(build, 'core/EconomyConfig.js'));
const HOUR = 3600000;
// Use local dates: the native opening calendar is a local weekday calendar.
const SUNDAY = new Date(2026, 9, 18, 12).getTime();
const ref = (index, kind = 'owned') => ({ kind, index });
function pets(owned = [0, 1, 2, 3], selected = [4, 5, 6]) {
  const system = new PetSystem(), save = system.serialize();
  owned.forEach((grade, i) => save.owned[i] = grade);
  selected.forEach((grade, i) => save.selected[i] = grade);
  system.restore(save);
  return system;
}
function adventure(level = 0, overrides = {}, now = SUNDAY) {
  const system = new AdventureSystem(now);
  system.restore({ ...system.serialize(), level, ...overrides });
  return system;
}

test('opening calendar and displayed unlock/slot levels match all seven native weekdays', () => {
  for (let type = 0; type < 3; type++) for (let day = 0; day < 7; day++) {
    const now = new Date(2026, 9, 18 + day, 12).getTime(), system = adventure(15, {}, now);
    assert.equal(adventureOpenDay(type, day), [[0, 1, 4], [0, 2, 5], [0, 3, 6]][type].includes(day));
    assert.equal(system.map(type, 0, now).status, adventureOpenDay(type, day) ? 'available' : 'closed');
  }
  for (const [level, slots, tiers] of [[0, 1, 1], [1, 1, 2], [2, 2, 2], [3, 2, 3], [6, 2, 4], [7, 3, 4], [10, 3, 5]]) {
    const snapshot = adventure(level).snapshot(pets().serialize(), SUNDAY);
    assert.equal(snapshot.displayLevel, level + 1);
    assert.equal(snapshot.openPetSlots, slots);
    assert.equal(snapshot.maps.filter(map => map.type === 0 && map.status === 'available').length, tiers);
    assert.deepEqual(snapshot.maps.slice(0, 5).map(map => map.unlockLevel), [1, 2, 4, 7, 11]);
  }
});

test('offline tickets preserve partial recharge, stop at cap, and restart when spending from full', () => {
  const system = adventure(0, { tickets: 15 }), petSave = pets().serialize();
  const original = system.serialize();
  assert.equal(system.snapshot(petSave, SUNDAY + 9 * HOUR).tickets, 17);
  assert.equal(system.snapshot(petSave, SUNDAY + 9 * HOUR).ticketRemainingMs, 3 * HOUR);
  assert.deepEqual(system.serialize(), original, 'reading snapshots must not write the save');
  system.refresh(SUNDAY + 9 * HOUR);
  assert.equal(system.serialize().lastTicketChargeAt, SUNDAY + 8 * HOUR);
  assert.equal(system.snapshot(petSave, SUNDAY - HOUR).tickets, 17, 'clock rollback does not recharge');
  system.refresh(SUNDAY + 30 * HOUR);
  assert.equal(system.serialize().tickets, 20);
  assert.equal(system.serialize().lastTicketChargeAt, SUNDAY + 30 * HOUR);
  // Next Sunday: old full-wallet time cannot create tickets after a new dispatch.
  const later = SUNDAY + 7 * 24 * HOUR;
  assert.equal(system.start(0, 0, [ref(0)], petSave, later).ok, true);
  assert.equal(system.serialize().tickets, 19);
  assert.equal(system.serialize().lastTicketChargeAt, later);
  assert.equal(system.snapshot(petSave, later + HOUR).ticketRemainingMs, 3 * HOUR);
});

test('dispatch validates maps, pets, slots and tickets before changing any saved field', () => {
  const system = adventure(), save = pets().serialize(), initial = system.serialize();
  for (const args of [[0, 1, [ref(0)]], [0, 0, []], [0, 0, [ref(0), ref(1)]], [0, 0, [ref(15)]], [3, 0, [ref(0)]]]) {
    assert.equal(system.start(...args, save, SUNDAY).ok, false);
    assert.deepEqual(system.serialize(), initial);
  }
  const double = adventure(7);
  assert.equal(double.start(0, 0, [ref(0), ref(0)], save, SUNDAY).reason, 'petUnavailable');
  const emptyWallet = adventure(7, { tickets: 0 });
  assert.equal(emptyWallet.start(0, 0, [ref(0)], save, SUNDAY).reason, 'tickets');
  const now = new Date(2026, 9, 20, 12).getTime();
  assert.equal(system.start(0, 0, [ref(0)], save, now).reason, 'closed');
  const run = double.start(0, 0, [ref(0), ref(1), ref(0, 'selected')], save, SUNDAY);
  assert.equal(run.ok, true);
  assert.equal(double.serialize().tickets, 17);
  assert.deepEqual(double.locks(), [ref(0), ref(1), ref(0, 'selected')]);
  assert.equal(double.start(1, 0, [ref(0)], save, SUNDAY).reason, 'petUnavailable');
  const serialized = double.serialize(); serialized.maps[0].pets[0].grade = 9; serialized.cores[0] = 1000;
  assert.equal(double.serialize().maps[0].pets[0].grade, 0, 'snapshots are detached');
  assert.equal(double.coreCount(0), 0);
});

test('core rewards preserve each ARM64 single-precision operation before truncation', () => {
  assert.equal(adventureCoreReward([1, 11], 1), 63, 'a double-precision implementation incorrectly yields 64');
  assert.equal(adventureCoreReward([2, 4], 1), 52);
  assert.equal(adventureCoreReward([0], 16), 320);
  assert.equal(adventureCoreReward([9, 9, 9], 16), 1824);
  assert.equal(adventureCoreReward([0, 1, 1], 1), 63);
  assert.equal(adventureCoreReward([1, 1, 0], 1), 64);
  assert.equal(adventureCoreReward([], 16), 0);
});

test('claim is exactly once, gives base-duration rewards, and cancellation only releases locks', () => {
  const system = adventure(7), save = pets([2, 4]).serialize();
  const preview = system.preview(0, 0, [ref(0), ref(1)], save, SUNDAY);
  assert.equal(preview.rewardCore, 52); assert.equal(preview.rewardExp, 20);
  system.start(0, 0, [ref(0), ref(1)], save, SUNDAY);
  const pending = system.serialize();
  assert.equal(system.claim(0, 0, SUNDAY + HOUR - 1).reason, 'notFinished');
  assert.deepEqual(system.serialize(), pending);
  assert.equal(system.snapshot(save, SUNDAY + HOUR).mapAlert, true);
  const result = system.claim(0, 0, SUNDAY + HOUR);
  assert.equal(result.coreGain, 52); assert.equal(result.expGain, 20); assert.equal(result.beforeLevel, 7);
  assert.deepEqual(system.locks(), []);
  assert.equal(system.coreCount(0), 52);
  assert.equal(system.snapshot(save, SUNDAY + HOUR).coreAlert, true);
  const claimed = system.serialize();
  assert.equal(system.claim(0, 0, SUNDAY + HOUR).ok, false);
  assert.deepEqual(system.serialize(), claimed);
  system.start(1, 0, [ref(0)], save, SUNDAY + HOUR);
  const tickets = system.serialize().tickets;
  assert.equal(system.cancel(1, 0).ok, true);
  assert.equal(system.serialize().tickets, tickets);
  assert.equal(system.coreCount(1), 0);
  assert.equal(system.cancel(1, 0).ok, false);
  assert.deepEqual(system.locks(), []);
  // Cross-day forest closure never prevents claiming an already finished trip.
  const crossDay = adventure();
  crossDay.start(0, 0, [ref(0)], save, SUNDAY);
  assert.equal(crossDay.claim(0, 0, SUNDAY + 2 * 24 * HOUR).ok, true);
});

test('experience handles threshold carry and max-level reset without an extra level', () => {
  const save = pets([9, 9, 9]).serialize(), system = adventure(0, { exp: 49 });
  system.start(0, 0, [ref(0)], save, SUNDAY);
  assert.equal(system.claim(0, 0, SUNDAY + HOUR).ok, true);
  assert.equal(system.serialize().level, 1); assert.equal(system.serialize().exp, 9);
  const maximum = adventure(14, { exp: adventureRequiredExp(14) - 1 });
  maximum.start(0, 4, [ref(0), ref(1), ref(2)], save, SUNDAY, true);
  const result = maximum.claim(0, 4, SUNDAY, true);
  assert.equal(result.expGain, 480); assert.equal(result.coreGain, 1824);
  assert.equal(maximum.serialize().level, 15); assert.equal(maximum.serialize().exp, 0);
  const snapshot = maximum.snapshot(save, SUNDAY);
  assert.equal(snapshot.displayLevel, 16); assert.equal(snapshot.requiredExp, 0); assert.equal(snapshot.expRatio, 1);
  maximum.start(0, 0, [ref(0)], save, SUNDAY, true); maximum.claim(0, 0, SUNDAY, true);
  assert.equal(maximum.serialize().exp, 0);
});

test('all 19 dispatch locks block inventory changes but preserve selected combat bonuses', () => {
  const system = pets(Array(16).fill(0), [1, 2, 3]);
  const money = system.moneyMultiplier.toJSON(), speed = system.moveSpeedPercent;
  system.setAuto(true);
  const all = [...Array.from({ length: 16 }, (_, i) => ref(i)), ...Array.from({ length: 3 }, (_, i) => ref(i, 'selected'))];
  system.setLocks(all);
  const snapshot = system.snapshot(0);
  assert.deepEqual(snapshot.ownedLocked, Array(16).fill(true));
  assert.deepEqual(snapshot.selectedLocked, Array(3).fill(true));
  assert.equal(system.move(ref(0), ref(1)).reason, 'locked');
  assert.equal(system.move(ref(0, 'selected'), ref(1)).reason, 'locked');
  assert.equal(system.merge(0, 1).reason, 'locked');
  assert.equal(system.unequip(0).reason, 'locked');
  assert.equal(system.autoPair(), null);
  assert.deepEqual(system.moneyMultiplier.toJSON(), money); assert.equal(system.moveSpeedPercent, speed);
  assert.equal(Object.hasOwn(system.serialize(), 'ownedLocked'), false, 'locks have one persistence authority');
  system.setLocks([ref(0)]);
  assert.deepEqual(system.autoPair(), { from: 1, to: 2, grade: 0 });
  assert.equal(system.move(ref(1), ref(0)).reason, 'locked');
  assert.equal(system.merge(1, 0).reason, 'locked');
  system.setLocks([]);
  assert.equal(system.merge(0, 1).ok, true);
});

test('preview excludes dispatched pets and auto-select is stable selected-first for equal grades', () => {
  const system = adventure(7), save = pets([5, 9, 5], [5, 9, 4]).serialize();
  assert.deepEqual(system.autoSelect(save).map(({ kind, index }) => ({ kind, index })), [ref(1, 'selected'), ref(1), ref(0, 'selected')]);
  system.start(0, 0, [ref(1, 'selected'), ref(1)], save, SUNDAY);
  assert.deepEqual(system.availablePets(save).map(({ kind, index }) => ({ kind, index })), [ref(0, 'selected'), ref(2, 'selected'), ref(0), ref(2)]);
  assert.deepEqual(system.autoSelect(save).map(({ kind, index }) => ({ kind, index })), [ref(0, 'selected'), ref(0), ref(2)]);
});

test('native preview selection order and claim slot order preserve the original float32 boundary', () => {
  const system = adventure(7), save = pets([0, 1, 1]).serialize(), refs = [ref(1), ref(2), ref(0)];
  assert.equal(system.preview(0, 0, refs, save, SUNDAY).rewardCore, 64);
  system.start(0, 0, refs, save, SUNDAY);
  assert.equal(system.claim(0, 0, SUNDAY + HOUR).coreGain, 63);
});

test('existing ticket balances and consumed ads survive reduced configuration caps', () => {
  const save = pets().serialize(), system = adventure(0, { tickets: 25, adUsed: 5, adDate: '2026-10-18' });
  assert.equal(system.snapshot(save, SUNDAY).tickets, 25);
  assert.equal(system.snapshot(save, SUNDAY).ticketRemainingMs, 0);
  assert.equal(system.snapshot(save, SUNDAY).adRemaining, 0);
  assert.equal(system.start(0, 0, [ref(0)], save, SUNDAY).ok, true);
  assert.equal(system.serialize().tickets, 24);
  system.refresh(SUNDAY + 24 * HOUR);
  assert.equal(system.serialize().tickets, 24);
});

test('ads require the current run, highest unlocked tier and remaining daily quota', () => {
  const system = adventure(10), save = pets().serialize();
  const now = new Date(2026, 9, 18, 23, 45).getTime();
  const low = system.start(0, 0, [ref(0)], save, now);
  assert.equal(system.reduceByAd(0, 0, low.runId, now).ok, false);
  const high = system.start(0, 4, [ref(1)], save, now);
  assert.equal(system.reduceByAd(0, 4, high.runId, now, true).ok, false);
  assert.equal(system.reduceByAd(0, 4, high.runId, now).ok, true);
  assert.equal(system.reduceByAd(0, 4, high.runId, now).ok, true);
  assert.equal(system.reduceByAd(0, 4, high.runId, now).ok, false);
  assert.equal(system.map(0, 4, now).remainingMs, 15 * HOUR);
  assert.equal(system.snapshot(save, now - 24 * HOUR).adRemaining, 0, 'clock rollback does not reset quota');
  assert.equal(system.reduceByAd(0, 4, high.runId, now + HOUR).ok, true, 'next local day resets quota');
  system.cancel(0, 4);
  const restarted = system.start(0, 4, [ref(1)], save, now + HOUR);
  assert.notEqual(restarted.runId, high.runId);
  const before = system.serialize();
  assert.equal(system.reduceByAd(0, 4, high.runId, now + HOUR).reason, 'stale');
  assert.deepEqual(system.serialize(), before);
});

test('corrupt saves fail without replacing the previous state or silently releasing refs', () => {
  const system = adventure(7), save = pets().serialize();
  system.start(0, 0, [ref(0)], save, SUNDAY);
  const original = system.serialize();
  const changes = [
    d => d.maps.pop(), d => d.cores.push(0), d => d.maps[0].pets[0].grade = 9,
    d => d.maps[1] = { ...d.maps[0], runId: 2 }, d => d.nextRunId = 1,
    d => d.maps[0].startedAt = NaN, d => d.level = 16, d => d.adDate = '2026-02-30',
    d => d.maps[0].pets.push({ kind: 'owned', index: 0, grade: 0 }),
  ];
  for (const mutate of changes) {
    const bad = structuredClone(original); mutate(bad);
    assert.throws(() => system.restore(bad, save));
    assert.deepEqual(system.serialize(), original);
  }
  assert.throws(() => new AdventureSystem(NaN));
  assert.throws(() => new AdventureSystem(8640000000000000), 'clock dates must fit the persisted calendar key');
  assert.throws(() => system.snapshot(save, Infinity));
  const tooMany = adventure(0).serialize(); tooMany.nextRunId = 2;
  tooMany.maps[0] = { startedAt: SUNDAY, runId: 1, pets: [{ ...ref(0), grade: 0 }, { ...ref(1), grade: 1 }] };
  assert.throws(() => system.restore(tooMany, save));
  const restored = new AdventureSystem(SUNDAY); restored.restore(original, save);
  assert.deepEqual(restored.serialize(), original);
  assert.deepEqual(restored.locks(), [ref(0)]);
});
