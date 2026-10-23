const test = require('node:test');
const assert = require('node:assert/strict');
const { DailyCheckSystem, dailyCheckDay } = require('./.build/session/session/DailyCheckSystem.js');
const { economyModules } = require('./support/economy-modules.cjs');

test('seven sequential local dates use exact configured rewards, keep skipped days and restart after day seven', () => {
  const system = new DailyCheckSystem(), amounts = [140, 400, 800, 1200, 1600, 2000, 3000];
  assert.deepEqual(system.snapshot('2026-10-16').days.map(day => day.diamonds), amounts);
  for (let i = 0; i < 7; i++) {
    const today = `2026-10-${16 + i * 2}`;
    const state = system.snapshot(today);
    assert.equal(state.checkNum, i); assert.equal(state.totalCheckNum, i);
    assert.deepEqual(state.days.map(day => day.status), Array.from({ length: 7 }, (_, day) => day < i ? 'geted' : day === i ? 'getable' : 'normal'));
    const next = system.prepareClaim(i, today); assert.equal(next.ok, true); assert.equal(next.diamonds, amounts[i]);
    system.commit(next.save);
    assert.equal(system.snapshot(today).canClaim, false);
    assert.equal(system.prepareClaim(i, today).reason, 'notClaimable');
    assert.equal(system.prepareClaim(i + 1, today).ok, false);
  }
  assert.equal(system.snapshot('2026-10-28').checkNum, 7);
  assert.ok(system.snapshot('2026-10-28').days.every(day => day.status === 'geted'));
  const next = system.snapshot('2026-10-29');
  assert.equal(next.checkNum, 0); assert.equal(next.totalCheckNum, 7); assert.equal(next.canClaim, true);
  system.commit(system.prepareClaim(0, '2026-10-29').save);
  assert.deepEqual(system.serialize(), { lastClaimDay: '2026-10-29', checkNum: 1, totalCheckNum: 8 });
});

test('out of order, invalid dates and rollback never create a claim; calendar boundaries use local time', () => {
  const system = new DailyCheckSystem();
  for (const index of [-1, 7, .5, NaN, Infinity, '0', null]) assert.equal(system.prepareClaim(index, '2026-10-16').reason, 'invalidDay');
  assert.equal(system.prepareClaim(1, '2026-10-16').reason, 'notClaimable');
  for (const day of ['', '2026-02-30', '2026-13-01', '2026-1-1']) assert.equal(system.snapshot(day).canClaim, false);
  system.commit(system.prepareClaim(0, '2026-10-16').save);
  assert.equal(system.snapshot('2026-10-15').canClaim, false);
  assert.equal(system.snapshot('2026-10-16').canClaim, false);
  assert.equal(system.snapshot('2026-10-17').canClaim, true);
  assert.equal(dailyCheckDay(new Date(2026, 9, 16, 23, 59, 59).getTime()), '2026-10-16');
  assert.equal(dailyCheckDay(new Date(2026, 9, 17, 0, 0, 0).getTime()), '2026-10-17');
  assert.equal(dailyCheckDay(NaN), '');
});

test('missing legacy block starts eligible; malformed ledgers remain unchanged and blocked', () => {
  const system = new DailyCheckSystem(); system.restore(undefined);
  assert.equal(system.snapshot('2026-10-16').canClaim, true);
  for (const bad of [null, [], 'claimed', {}, { lastClaimDay: '2026-10-16', checkNum: 1, totalCheckNum: 0 },
    { lastClaimDay: '', checkNum: 1, totalCheckNum: 1 }, { lastClaimDay: '2026-02-30', checkNum: 1, totalCheckNum: 1 },
    { lastClaimDay: '2026-10-16', checkNum: 8, totalCheckNum: 8 }, { lastClaimDay: '2026-10-16', checkNum: 1.5, totalCheckNum: 1.5 },
    { lastClaimDay: '2026-10-16', checkNum: 2, totalCheckNum: 3 }]) {
    system.restore(bad); assert.deepEqual(system.serialize(), bad);
    assert.equal(system.snapshot('2026-10-17').blocked, true);
    assert.equal(system.prepareClaim(0, '2026-10-17').reason, 'invalidSave');
  }
  const max = Number.MAX_SAFE_INTEGER;
  system.restore({ lastClaimDay: '2026-10-16', checkNum: max % 7 || 7, totalCheckNum: max });
  assert.equal(system.prepareClaim(0, '2026-10-17').reason, 'counterLimit');
});

test('config changes use one preview/claim source, zero reward advances, and disabling never clears prior progress', () => {
  const load = economyModules(c => { c.dailyCheck.diamondsByDay = [0, 2, 3, 4, 5, 6, 7]; });
  const system = new (load('session/DailyCheckSystem').DailyCheckSystem)();
  assert.equal(system.snapshot('2026-10-16').days[0].diamonds, 0);
  const claim = system.prepareClaim(0, '2026-10-16'); assert.equal(claim.diamonds, 0); system.commit(claim.save);
  const disabled = economyModules(c => { c.dailyCheck.dailyLimit = 0; });
  const off = new (disabled('session/DailyCheckSystem').DailyCheckSystem)(); off.restore(system.serialize());
  assert.equal(off.snapshot('2026-10-17').canClaim, false); assert.deepEqual(off.serialize(), system.serialize());
  const resumed = new DailyCheckSystem(); resumed.restore(off.serialize());
  assert.equal(resumed.snapshot('2026-10-17').days[1].status, 'getable');
});
