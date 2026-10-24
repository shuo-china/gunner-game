const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');

function fixture(environment = 'production', onWeaponsChanged) {
  let now = new Date(2026, 9, 16, 12).getTime();
  const data = new Map(), writes = [], key = economyStorageKey(environment);
  const controls = { write: 'normal', denyRead: false, onWrite: undefined };
  const storage = { getItem(key) { if (controls.denyRead) throw new Error('Read denied'); return data.get(key) ?? null; },
    setItem(key, value) {
      if (controls.write === 'throw') throw new Error('Write denied');
      if (controls.write === 'silent') return;
      data.set(key, value); writes.push(JSON.parse(value)); controls.onWrite?.();
      if (controls.write === 'writeThenThrow') throw new Error('Provider threw after write');
    } };
  const make = (env = environment) => new BattleSession({ environment: env, storage, now: () => now,
    contentConfig: resolveContentConfig(env, { tutorialEnabled: false,
      testResources: { fundGoldUpgrades: false, fundRebirthUpgrades: false, diamonds: 0, starGems: 0 } }), onWeaponsChanged });
  const session = make(); writes.length = 0;
  return { session, data, writes, controls, key, make, setNow(value) { now = value; },
    patch(fn) { const raw = JSON.parse(data.get(key)); fn(raw); data.set(key, JSON.stringify(raw)); return make(); } };
}

test('claim atomically saves exact reward and both counters before one notification, with no duplicate or future claim', () => {
  let active; const notices = [];
  const f = fixture('production', () => { if (active) notices.push({ state: active.getDailyCheckState(), diamonds: active.weapons.diamonds, raw: JSON.parse(f.data.get(f.key)) }); });
  active = f.session;
  assert.deepEqual(active.claimDailyCheck(0), { ok: true, dayIndex: 0, diamonds: 140 });
  assert.equal(f.writes.length, 1); assert.equal(notices.length, 1); assert.equal(notices[0].diamonds, 140);
  assert.equal(notices[0].state.checkNum, 1); assert.equal(notices[0].raw.dailyCheck.totalCheckNum, 1);
  assert.equal(f.writes[0].weapons.diamonds, 140);
  assert.equal(active.claimDailyCheck(0).reason, 'notClaimable'); assert.equal(active.claimDailyCheck(1).reason, 'notClaimable');
  assert.equal(f.writes.length, 1);
  active.weapons.spendDiamonds(80); const restored = f.make();
  assert.equal(restored.weapons.diamonds, 60); assert.equal(restored.getDailyCheckState().checkNum, 1);
  assert.equal(restored.claimDailyCheck(0).reason, 'notClaimable');
  f.setNow(new Date(2026, 9, 17, 0).getTime());
  assert.equal(restored.claimDailyCheck(1).diamonds, 400); assert.equal(restored.weapons.diamonds, 460);
  f.setNow(new Date(2026, 9, 16, 23).getTime()); assert.equal(restored.claimDailyCheck(2).reason, 'notClaimable');
});

test('missing current daily ledger is rejected without rewriting the save or granting rewards', () => {
  const f = fixture(), session = f.patch(raw => { delete raw.dailyCheck; raw.weapons.diamonds = 517; });
  const saved = f.data.get(f.key); f.writes.length = 0;
  assert.equal(session.persistenceBlocked, true); assert.equal(session.claimDailyCheck(0).ok, false);
  session.save(); assert.equal(f.data.get(f.key), saved); assert.equal(f.writes.length, 0);
});

test('a complete seven-day cycle remains durable across reloads and restarts only on the following day', () => {
  const f = fixture(); let session = f.session;
  for (let index = 0; index < 7; index++) {
    f.setNow(new Date(2026, 9, 16 + index, 12).getTime());
    assert.equal(session.claimDailyCheck(index).ok, true);
    session.checkpointForeground(); session = f.make();
    assert.equal(session.getDailyCheckState().checkNum, index + 1);
    assert.equal(session.getDailyCheckState().totalCheckNum, index + 1);
    assert.equal(session.getDailyCheckState().claimableIndex, null);
  }
  assert.equal(session.weapons.diamonds, 9140);
  assert.ok(session.getDailyCheckState().days.every(day => day.status === 'geted'));
  f.setNow(new Date(2026, 9, 23, 0).getTime());
  assert.equal(session.getDailyCheckState().claimableIndex, 0);
  assert.equal(session.claimDailyCheck(0).diamonds, 140);
  session.checkpointForeground(); session = f.make();
  assert.equal(session.weapons.diamonds, 9280); assert.equal(session.getDailyCheckState().totalCheckNum, 8);
  assert.equal(session.getDailyCheckState().checkNum, 1);
});

test('malformed optional ledger blocks only daily claims and survives other saves without erasing wallet', () => {
  const f = fixture();
  for (const value of [null, 'unknown-claimed', { checkNum: 5, lastClaimDay: '2026-10-16' }]) {
    const s = f.patch(raw => { raw.dailyCheck = value; raw.weapons.diamonds = 37; });
    assert.equal(s.weapons.diamonds, 37); assert.equal(s.getDailyCheckState().blocked, true);
    assert.equal(s.claimDailyCheck(0).reason, 'invalidSave'); s.weapons.grantDiamonds(2); s.save();
    assert.deepEqual(JSON.parse(f.data.get(f.key)).dailyCheck, value);
    assert.equal(JSON.parse(f.data.get(f.key)).weapons.diamonds, 39);
  }
});

test('failed or silent writes allow retry, while a throw after an atomic write is accepted exactly once', t => {
  t.mock.method(console, 'warn', () => {});
  for (const mode of ['throw', 'silent']) {
    const f = fixture(); f.controls.write = mode; const before = f.data.get(f.key);
    assert.equal(f.session.claimDailyCheck(0).reason, 'saveFailed'); assert.equal(f.session.weapons.diamonds, 0);
    assert.equal(f.session.getDailyCheckState().canClaim, true); assert.equal(f.data.get(f.key), before);
    f.controls.write = 'normal'; assert.equal(f.session.claimDailyCheck(0).diamonds, 140);
  }
  const f = fixture(); f.controls.write = 'writeThenThrow';
  assert.equal(f.session.claimDailyCheck(0).ok, true); assert.equal(f.session.weapons.diamonds, 140);
  f.controls.write = 'normal'; assert.equal(f.make().claimDailyCheck(0).reason, 'notClaimable');
});

test('unknown commit readback blocks autosave and repeat grants until reload resolves committed progress', t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture(); f.controls.onWrite = () => { f.controls.denyRead = true; };
  assert.equal(f.session.claimDailyCheck(0).reason, 'saveFailed'); assert.equal(f.session.weapons.diamonds, 0);
  const committed = f.data.get(f.key); assert.equal(JSON.parse(committed).weapons.diamonds, 140);
  f.controls.onWrite = undefined; f.controls.denyRead = false; f.writes.length = 0;
  assert.equal(f.session.claimDailyCheck(0).reason, 'saveFailed'); f.session.weapons.grantDiamonds(1); f.session.save();
  assert.equal(f.data.get(f.key), committed); assert.equal(f.writes.length, 0);
  const restored = f.make(); assert.equal(restored.weapons.diamonds, 140); assert.equal(restored.claimDailyCheck(0).reason, 'notClaimable');
});

test('reentrant storage callbacks and later notification callbacks cannot duplicate daily rewards or redeem during commit', () => {
  let active; const notifications = [], nested = [];
  const f = fixture('production', () => { if (active) notifications.push(active.claimDailyCheck(0)); }); active = f.session;
  f.controls.onWrite = () => { nested.push(active.claimDailyCheck(0), active.redeemCode('950424')); active.save(); };
  assert.equal(active.claimDailyCheck(0).ok, true);
  assert.deepEqual(nested.map(result => result.reason), ['saveFailed', 'saveFailed']);
  assert.deepEqual(notifications.map(result => result.reason), ['notClaimable']);
  assert.equal(f.writes.length, 1); assert.equal(active.weapons.diamonds, 140);
});

test('storage, serialization, overflow and UI failures cannot split reward from the claim ledger', t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture('production', () => { throw new Error('Renderer failed'); });
  const serialize = f.session.serializeSave; f.session.serializeSave = () => { throw new Error('Serialize failed'); };
  assert.equal(f.session.claimDailyCheck(0).reason, 'saveFailed'); assert.equal(f.writes.length, 0);
  f.session.serializeSave = serialize; assert.equal(f.session.claimDailyCheck(0).ok, true);
  assert.equal(f.session.weapons.diamonds, 140);
  const overflow = fixture(); overflow.session.weapons.grantDiamonds(Number.MAX_SAFE_INTEGER);
  assert.equal(overflow.session.claimDailyCheck(0).reason, 'walletLimit'); assert.equal(overflow.session.getDailyCheckState().canClaim, true);
  const noStorage = new BattleSession({ now: () => new Date(2026, 9, 16).getTime() });
  assert.equal(noStorage.claimDailyCheck(0).reason, 'saveFailed'); assert.equal(noStorage.weapons.diamonds, 0);
});

test('test and production have independent claims and existing test clock advances daily eligibility', () => {
  const f = fixture('test'); assert.equal(f.session.claimDailyCheck(0).ok, true);
  const production = f.make('production'); assert.equal(production.weapons.diamonds, 0);
  assert.equal(production.claimDailyCheck(0).ok, true);
  assert.equal(f.make().getDailyCheckState().checkNum, 1);
  f.session.weapons.advanceTestTime(86400000);
  assert.equal(f.session.getDailyCheckState().days[1].status, 'getable');
});
