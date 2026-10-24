const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { DailyShareSystem, dailyShareDay } = require('./.build/session/session/DailyShareSystem.js');
const { rewardLedgersMatch } = require('./.build/session/session/CloudSaveStorage.js');

function fixture() {
  let now = Date.UTC(2026, 9, 23, 15, 59, 59, 999);
  const key = economyStorageKey('production'), data = new Map(), controls = { mode: 'normal', onWrite: undefined, denyRead: false };
  const storage = { getItem: name => { if (controls.denyRead) throw new Error('read failed'); return data.get(name) ?? null; },
    setItem(name, value) {
      if (controls.mode === 'throw') throw new Error('write failed');
      if (controls.mode === 'silent') return;
      data.set(name, value); controls.onWrite?.();
      if (controls.mode === 'writeThenThrow') throw new Error('after write');
    } };
  const make = () => new BattleSession({ storage, now: () => now });
  return { key, data, controls, make, session: make(), setNow: value => { now = value; },
    patch(fn) { const value = JSON.parse(data.get(key)); fn(value); data.set(key, JSON.stringify(value)); return make(); } };
}

test('daily share grants once, survives reload and rolls over at Beijing midnight independently of host timezone', () => {
  const f = fixture();
  assert.equal(dailyShareDay(Date.UTC(2026, 9, 23, 15, 59, 59, 999)), '2026-10-23');
  assert.equal(dailyShareDay(Date.UTC(2026, 9, 23, 16)), '2026-10-24');
  assert.equal(dailyShareDay(NaN), '');
  assert.deepEqual(f.session.claimDailyShare(), { ok: true, diamonds: 80 });
  assert.equal(f.session.claimDailyShare().reason, 'notClaimable');
  assert.equal(f.make().claimDailyShare().reason, 'notClaimable');
  const saved = JSON.parse(f.data.get(f.key));
  assert.equal(saved.weapons.diamonds, 80); assert.deepEqual(saved.dailyShare, { lastClaimDay: '2026-10-23' });
  f.setNow(Date.UTC(2026, 9, 23, 16));
  assert.deepEqual(f.session.claimDailyShare(), { ok: true, diamonds: 80 });
  f.setNow(Date.UTC(2026, 9, 22, 16));
  assert.equal(f.session.claimDailyShare().reason, 'notClaimable');
  assert.equal(f.session.weapons.diamonds, 160);
});

test('missing share ledger is an unsupported save and cannot be overwritten or rewarded', () => {
  const f = fixture(), session = f.patch(save => { delete save.dailyShare; save.weapons.diamonds = 517; });
  const raw = f.data.get(f.key); assert.equal(session.persistenceBlocked, true);
  assert.equal(session.claimDailyShare().ok, false); session.save(); assert.equal(f.data.get(f.key), raw);
});

test('damaged share ledgers remain intact and blocked across ordinary saves, without affecting other rewards', () => {
  for (const bad of [null, [], 'claimed', {}, { lastClaimDay: '2026-02-30' }, { lastClaimDay: 0 }]) {
    const f = fixture(), session = f.patch(save => { save.dailyShare = bad; save.weapons.diamonds = 37; });
    assert.equal(session.getDailyShareState().blocked, true);
    assert.equal(session.claimDailyShare().reason, 'invalidSave');
    session.weapons.grantDiamonds(2); session.save();
    assert.deepEqual(JSON.parse(f.data.get(f.key)).dailyShare, bad);
    assert.equal(session.weapons.diamonds, 39);
    assert.equal(session.claimDailyCheck(0).ok, true);
    assert.deepEqual(JSON.parse(f.data.get(f.key)).dailyShare, bad);
  }
});

test('share write failures and reentrant callbacks never split a reward from its daily ledger', t => {
  t.mock.method(console, 'warn', () => {});
  for (const mode of ['throw', 'silent']) {
    const f = fixture(); f.controls.mode = mode;
    assert.equal(f.session.claimDailyShare().reason, 'saveFailed');
    assert.equal(f.session.weapons.diamonds, 0); assert.equal(f.session.getDailyShareState().canClaim, true);
    f.controls.mode = 'normal'; assert.equal(f.session.claimDailyShare().ok, true);
  }
  const f = fixture(), nested = []; f.controls.mode = 'writeThenThrow';
  f.controls.onWrite = () => { nested.push(f.session.claimDailyShare()); f.session.save(); };
  assert.equal(f.session.claimDailyShare().ok, true);
  assert.deepEqual(nested, [{ ok: false, reason: 'saveFailed' }]);
  f.controls.onWrite = undefined; f.controls.mode = 'normal';
  assert.equal(f.make().weapons.diamonds, 80);
  assert.equal(f.session.claimDailyShare().reason, 'notClaimable');
});

test('an uncertain share readback preserves a possibly committed reward until reload', t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture(); f.controls.onWrite = () => { f.controls.denyRead = true; };
  assert.equal(f.session.claimDailyShare().reason, 'saveFailed');
  const committed = f.data.get(f.key); assert.equal(JSON.parse(committed).weapons.diamonds, 80);
  f.controls.onWrite = undefined; f.controls.denyRead = false;
  assert.equal(f.session.weapons.diamonds, 0); assert.equal(f.session.claimDailyShare().reason, 'saveFailed');
  f.session.save(); assert.equal(f.data.get(f.key), committed);
  assert.equal(f.make().claimDailyShare().reason, 'notClaimable');
});

test('cloud overwrite protection includes share claims and preserves malformed optional ledgers', () => {
  const raw = share => JSON.stringify({ dailyCheck: { lastClaimDay: '', checkNum: 0, totalCheckNum: 0 }, redeemedCodes: [], ...(share === undefined ? {} : { dailyShare: share }) });
  assert.equal(rewardLedgersMatch(raw(undefined), raw({ lastClaimDay: '' })), false);
  assert.equal(rewardLedgersMatch(raw(undefined), raw({ lastClaimDay: '2026-10-23' })), false);
  assert.equal(rewardLedgersMatch(raw(null), raw(undefined)), false);
  assert.equal(rewardLedgersMatch(raw({ damaged: true }), raw({ lastClaimDay: '' })), false);
  assert.equal(rewardLedgersMatch(raw({ lastClaimDay: '2026-10-23' }), raw({ lastClaimDay: '2026-10-23' })), true);
  const system = new DailyShareSystem();
  for (const day of ['', '2026-02-30', '2026-13-01']) assert.equal(system.prepareClaim(day).reason, 'notClaimable');
});
