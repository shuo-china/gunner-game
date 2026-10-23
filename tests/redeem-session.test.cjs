const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const build = process.env.FOREST_GUNNER_SESSION_TEST_BUILD || path.resolve(__dirname, '.build/session');
const { BattleSession, economyStorageKey } = require(path.join(build, 'session/BattleSession.js'));
const { resolveContentConfig } = require(path.join(build, 'session/ContentConfig.js'));

function config(environment) {
  return resolveContentConfig(environment, { tutorialEnabled: false,
    testResources: { fundGoldUpgrades: false, fundRebirthUpgrades: false, diamonds: 0, starGems: 0 } });
}
function fixture(environment = 'production', onWeaponsChanged) {
  const data = new Map(), writes = [], key = economyStorageKey(environment);
  const controls = { write: 'normal', denyRead: false, onWrite: undefined };
  const storage = {
    getItem(key) { if (controls.denyRead) throw new Error('Read denied'); return data.get(key) ?? null; },
    setItem(key, value) {
      if (controls.write === 'throw') throw new Error('Write denied');
      if (controls.write === 'silent') return;
      data.set(key, value); writes.push(JSON.parse(value)); controls.onWrite?.();
      if (controls.write === 'writeThenThrow') throw new Error('Provider threw after write');
    },
  };
  const make = (env = environment) => new BattleSession({ environment: env, contentConfig: config(env), storage,
    now: () => 1791691200000, rng: () => .5, onWeaponsChanged });
  const session = make(); writes.length = 0;
  return { session, storage, data, key, writes, controls, make,
    patch(fn) { const save = JSON.parse(data.get(key)); fn(save); data.set(key, JSON.stringify(save)); return make(); } };
}

test('built-in code commits 2000 diamonds and claim together before one wallet notification', () => {
  let active;
  const notices = [], f = fixture('production', force => {
    if (active) notices.push({ force, diamonds: active.weapons.diamonds, saved: JSON.parse(f.data.get(f.key)) });
  });
  active = f.session; active.weapons.grantDiamonds(37); f.writes.length = 0; notices.length = 0;
  assert.deepEqual(active.redeemCode('950424'), { ok: true, diamonds: 2000 });
  assert.equal(active.weapons.diamonds, 2037); assert.equal(f.writes.length, 1); assert.equal(notices.length, 1);
  assert.deepEqual(f.writes[0].redeemedCodes, ['950424']); assert.equal(f.writes[0].weapons.diamonds, 2037);
  assert.equal(notices[0].force, false); assert.equal(notices[0].diamonds, 2037);
  assert.deepEqual(notices[0].saved, f.writes[0]);
});

test('only the exact code with optional surrounding whitespace is accepted', () => {
  const f = fixture();
  for (const code of ['', ' ', '95042', '9504240', '0950424', '95 0424', '95\n0424', '９５０４２４', '950424x', 950424, null, undefined, {}]) {
    assert.deepEqual(f.session.redeemCode(code), { ok: false, reason: 'invalidCode' });
  }
  assert.equal(f.session.weapons.diamonds, 0); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.session.redeemCode(' \t950424\n '), { ok: true, diamonds: 2000 });
  assert.deepEqual(JSON.parse(f.data.get(f.key)).redeemedCodes, ['950424']);
});

test('claim survives reload and later wallet saves; repeated redemption never grants or writes', () => {
  const f = fixture(); assert.equal(f.session.redeemCode('950424').ok, true);
  assert.equal(f.session.weapons.spendDiamonds(100).ok, true);
  const restored = f.make(); f.writes.length = 0;
  for (const s of [f.session, restored]) {
    assert.deepEqual(s.redeemCode('950424'), { ok: false, reason: 'alreadyUsed' });
    assert.equal(s.weapons.diamonds, 1900);
  }
  assert.equal(f.writes.length, 0); restored.save();
  assert.deepEqual(JSON.parse(f.data.get(f.key)).redeemedCodes, ['950424']);
});

test('older v3 saves without a claim ledger retain economy and progression when first redeemed', () => {
  const f = fixture();
  const s = f.patch(saved => {
    delete saved.redeemedCodes;
    saved.money = { digits: '12345', exponent: 2, precision: 5 }; saved.levels = [7, 8, 9];
    saved.weapons.diamonds = 517; saved.weapons.starGems = 39; saved.weapons.stageValueMax = 34;
    saved.weapons.equipment[0].weaponId = 3; saved.weapons.collection[3] = true;
    saved.progress = { stageIndex: 3, waveIndex: 2 };
    saved.skins.owned[1] = true; saved.skins.selectedId = 1;
  });
  const before = JSON.parse(f.data.get(f.key)); f.writes.length = 0;
  assert.deepEqual(s.redeemCode('950424'), { ok: true, diamonds: 2000 });
  const expected = structuredClone(before); expected.weapons.diamonds += 2000; expected.redeemedCodes = ['950424'];
  assert.deepEqual(JSON.parse(f.data.get(f.key)), expected); assert.equal(f.writes.length, 1);
  const restored = f.make(); assert.equal(restored.weapons.diamonds, 2517);
  assert.equal(restored.moneyBalance.toString(), '1234500'); assert.equal(restored.getSkinState().selectedId, 1);
  assert.equal(restored.round.stageIndex, 3); assert.equal(restored.round.waveIndex, 2);
});

test('claim ledger is environment-isolated and preserves unknown valid code markers', () => {
  const f = fixture('test');
  const s = f.patch(saved => { saved.redeemedCodes = ['an-older-campaign']; });
  assert.equal(s.redeemCode('950424').ok, true);
  assert.deepEqual(JSON.parse(f.data.get(f.key)).redeemedCodes, ['an-older-campaign', '950424']);
  const production = f.make('production'); assert.equal(production.weapons.diamonds, 0);
  assert.equal(production.redeemCode('950424').ok, true); assert.equal(production.weapons.diamonds, 2000);
  assert.equal(f.make().weapons.diamonds, 2000);
  assert.deepEqual(f.make().redeemCode('950424'), { ok: false, reason: 'alreadyUsed' });
});

test('rebirth keeps the one-time claim and its diamond wallet', () => {
  const f = fixture('test'), s = f.session;
  assert.equal(s.redeemCode('950424').ok, true);
  assert.equal(s.requestRebirth('normal').ok, true); assert.ok(s.advanceRebirth(2));
  assert.equal(s.weapons.diamonds, 2000);
  const restored = f.make(); assert.equal(restored.weapons.diamonds, 2000);
  assert.deepEqual(restored.redeemCode('950424'), { ok: false, reason: 'alreadyUsed' });
});

test('missing or unreadable storage cannot award or replace an existing damaged save', t => {
  t.mock.method(console, 'warn', () => {});
  const s = new BattleSession({ environment: 'production', contentConfig: config('production') });
  assert.deepEqual(s.redeemCode('950424'), { ok: false, reason: 'saveFailed' }); assert.equal(s.weapons.diamonds, 0);
  const f = fixture(); f.data.set(f.key, '{damaged');
  const corrupt = f.make(); f.writes.length = 0;
  assert.deepEqual(corrupt.redeemCode('950424'), { ok: false, reason: 'saveFailed' });
  assert.equal(corrupt.weapons.diamonds, 0); assert.equal(f.data.get(f.key), '{damaged'); assert.equal(f.writes.length, 0);
  f.controls.denyRead = true; const denied = f.make();
  assert.deepEqual(denied.redeemCode('950424'), { ok: false, reason: 'saveFailed' }); assert.equal(denied.weapons.diamonds, 0);
});

test('malformed optional claim ledgers preserve the wallet and ledger without allowing a claim', () => {
  for (const ledger of [null, {}, '950424', [950424], ['950424', null]]) {
    const f = fixture(); const s = f.patch(saved => { saved.weapons.diamonds = 777; saved.redeemedCodes = ledger; });
    assert.equal(s.weapons.diamonds, 777); f.writes.length = 0;
    assert.deepEqual(s.redeemCode('950424'), { ok: false, reason: 'saveFailed' }); assert.equal(f.writes.length, 0);
    s.save(); assert.deepEqual(JSON.parse(f.data.get(f.key)).redeemedCodes, ledger);
    assert.equal(f.make().weapons.diamonds, 777);
  }
});

test('wallet limit refuses the entire award and leaves the code available after spending', () => {
  const f = fixture(); f.session.weapons.grantDiamonds(Number.MAX_SAFE_INTEGER - 1999); f.writes.length = 0;
  assert.deepEqual(f.session.redeemCode('950424'), { ok: false, reason: 'walletLimit' });
  assert.equal(f.session.weapons.diamonds, Number.MAX_SAFE_INTEGER - 1999); assert.equal(f.writes.length, 0);
  assert.deepEqual(JSON.parse(f.data.get(f.key)).redeemedCodes, []);
  f.session.weapons.spendDiamonds(1);
  assert.deepEqual(f.session.redeemCode('950424'), { ok: true, diamonds: 2000 });
  assert.equal(f.session.weapons.diamonds, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(f.make().redeemCode('950424'), { ok: false, reason: 'alreadyUsed' });
});

test('throwing and silent failed saves leave both live and persisted wallet unchanged and permit a later retry', t => {
  t.mock.method(console, 'warn', () => {});
  for (const write of ['throw', 'silent']) {
    let notifications = 0;
    const f = fixture('production', () => notifications++); f.session.weapons.grantDiamonds(81); notifications = 0;
    const before = f.data.get(f.key); f.writes.length = 0; f.controls.write = write;
    for (let i = 0; i < 2; i++) assert.deepEqual(f.session.redeemCode('950424'), { ok: false, reason: 'saveFailed' });
    assert.equal(f.session.weapons.diamonds, 81); assert.equal(f.data.get(f.key), before);
    assert.equal(f.writes.length, 0); assert.equal(notifications, 0);
    f.controls.write = 'normal'; assert.equal(f.session.redeemCode('950424').ok, true);
    assert.equal(f.session.weapons.diamonds, 2081); assert.equal(f.writes.length, 1); assert.equal(notifications, 1);
    assert.deepEqual(f.make().redeemCode('950424'), { ok: false, reason: 'alreadyUsed' });
  }
});

test('a provider throwing after an atomic write is recognized as committed and cannot award twice', t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture(); f.controls.write = 'writeThenThrow';
  assert.deepEqual(f.session.redeemCode('950424'), { ok: true, diamonds: 2000 });
  assert.equal(f.session.weapons.diamonds, 2000); assert.equal(f.writes.length, 1);
  assert.deepEqual(f.session.redeemCode('950424'), { ok: false, reason: 'alreadyUsed' });
  f.controls.write = 'normal'; const restored = f.make(); assert.equal(restored.weapons.diamonds, 2000);
  assert.deepEqual(restored.redeemCode('950424'), { ok: false, reason: 'alreadyUsed' });
});

test('unreadable commit confirmation blocks autosaves and retries until reload resolves the claim', t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture(); f.controls.onWrite = () => { f.controls.denyRead = true; };
  assert.deepEqual(f.session.redeemCode('950424'), { ok: false, reason: 'saveFailed' });
  assert.equal(f.session.weapons.diamonds, 0);
  const committed = f.data.get(f.key); assert.equal(JSON.parse(committed).weapons.diamonds, 2000);
  f.controls.onWrite = undefined; f.controls.denyRead = false; f.writes.length = 0;
  assert.deepEqual(f.session.redeemCode('950424'), { ok: false, reason: 'saveFailed' });
  f.session.save(); f.session.weapons.grantDiamonds(1);
  assert.equal(f.data.get(f.key), committed); assert.equal(f.writes.length, 0);
  const restored = f.make(); assert.equal(restored.weapons.diamonds, 2000);
  assert.deepEqual(restored.redeemCode('950424'), { ok: false, reason: 'alreadyUsed' });
});

test('reentrant storage and notification callbacks cannot award twice', () => {
  let s;
  const notificationResults = [], f = fixture('production', () => { if (s) notificationResults.push(s.redeemCode('950424')); });
  s = f.session; const nestedResults = [];
  f.controls.onWrite = () => { nestedResults.push(s.redeemCode('950424')); s.save(); };
  assert.deepEqual(s.redeemCode('950424'), { ok: true, diamonds: 2000 });
  assert.deepEqual(nestedResults, [{ ok: false, reason: 'saveFailed' }]);
  assert.deepEqual(notificationResults, [{ ok: false, reason: 'alreadyUsed' }]);
  assert.equal(s.weapons.diamonds, 2000); assert.equal(f.writes.length, 1);
});

test('serialization failure leaves the claim available and notification failure cannot undo a committed award', t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture('production', () => { throw new Error('Renderer failed'); });
  const serialize = f.session.serializeSave;
  f.session.serializeSave = () => { throw new Error('Serialization failed'); };
  assert.deepEqual(f.session.redeemCode('950424'), { ok: false, reason: 'saveFailed' });
  assert.equal(f.session.weapons.diamonds, 0); assert.equal(f.writes.length, 0);
  f.session.serializeSave = serialize;
  assert.deepEqual(f.session.redeemCode('950424'), { ok: true, diamonds: 2000 });
  assert.equal(f.session.weapons.diamonds, 2000); assert.equal(f.writes.length, 1);
  assert.deepEqual(f.session.redeemCode('950424'), { ok: false, reason: 'alreadyUsed' });
});
