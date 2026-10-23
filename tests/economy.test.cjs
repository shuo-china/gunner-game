const test = require('node:test');
const assert = require('node:assert/strict');
const { DecimalAmount: D, ORIGINAL_NUMBER_UNITS: units } = require('./.build/session/core/DecimalAmount.js');
const { BattleSession, economyStorageKey, MAX_SAVED_DECIMAL_SPAN } = require('./.build/session/session/BattleSession.js');
const { UPGRADE_TYPES, MAX_UPGRADE_LEVEL, getUpgradePrice, getUpgradeValue, fullUpgradeBudget } = require('./.build/session/session/UpgradeEconomy.js');
const stats = { shots: 0, hits: 0, kills: 0, totalTrees: 30, elapsed: 0, complete: false };
function storage() {
  const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
function seeded(money, levels = [0, 0, 0], environment = 'production') {
  const store = storage(); new BattleSession({ environment, storage: store });
  const saved = JSON.parse(store.getItem(economyStorageKey(environment)));
  store.setItem(economyStorageKey(environment), JSON.stringify({ ...saved, money: D.from(money), levels }));
  return { store, session: new BattleSession({ environment, storage: store }) };
}
function snapshot(session) { return session.snapshot(stats, false); }
function reward(session, degree = 0, id = 0) {
  return session.consume([{ type: 'treeDied', treeId: id, sourceTime: 1.5, position: { x: 0, z: 0 } }],
    [{ id, degree, alive: false, reward: D.from(degree === 0 ? 20 : 36), rewardPrecision: degree === 0 ? 2 : 17 }]);
}

test('DecimalAmount preserves tiny rewards and exact subtraction alongside a 2207-digit wallet', () => {
  const huge = D.from('1e2206'), changed = huge.add('21.6');
  assert.equal(changed.compare(huge), 1); assert.equal(changed.sub(huge).toString(), '21.6');
  assert.equal(D.from(JSON.parse(JSON.stringify(changed))).compare(changed), 0);
  assert.equal(Object.isFrozen(changed), true);
  assert.equal(D.from('0.1').add('0.2').toString(), '0.3');
  assert.equal(D.from(50).mul('1.3799999999999999').truncateSignificant(17).truncateSignificant(4).toString(), '68.99');
  assert.equal(D.from('-123.99').discardDecimal().toString(), '-123');
  assert.equal(D.from('-123.99').truncateSignificant(3).toString(), '-123');
  assert.equal(D.from(0).compare(0), 0); assert.equal(D.from('-0').toString(), '0');
  assert.equal(D.from('1e2205').ratio('4e2205'), 0.25);
  assert.equal(D.from('1e-10000').ratio('1e10000'), 0);
  assert.equal(D.from('1e10000').ratio(20), 1);
  for (const invalid of [NaN, Infinity, '-Infinity', '', 'abc', { digits: '12x', exponent: 0 }, { digits: '12', exponent: 0.5 }]) assert.throws(() => D.from(invalid));
});

test('Exact arithmetic agrees with independent BigInt integer oracle across signs and decimal scales', () => {
  let seed = 812739;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 250; i++) {
    const a = BigInt(next()) * BigInt(next()) * (i % 2 ? -1n : 1n), b = BigInt(next()) * BigInt(next()) * (i % 3 ? -1n : 1n);
    const da = D.from(a.toString()).scale(-2), db = D.from(b.toString()).scale(-2);
    assert.equal(da.add(db).scale(2).compare((a + b).toString()), 0);
    assert.equal(da.sub(db).scale(2).compare((a - b).toString()), 0);
    assert.equal(da.mul(db).scale(4).compare((a * b).toString()), 0);
    assert.equal(da.compare(db), a === b ? 0 : a < b ? -1 : 1);
  }
});

test('Original G17 constants, truncation and level-5000 price transition match recovered fixtures', () => {
  assert.deepEqual(Array.from({ length: 6 }, (_, level) => getUpgradePrice(level).toNumber()), [50, 68, 95, 131, 181, 249]);
  assert.deepEqual(Array.from({ length: 6 }, (_, level) => getUpgradeValue('power', level).toNumber()), [100, 108, 116, 125, 135, 145]);
  assert.equal(getUpgradePrice(4999).compare('3.04e700'), 0);
  assert.equal(getUpgradePrice(5000).compare('4.20e700'), 0);
  assert.equal(getUpgradePrice(5001).compare('8.40e700'), 0);
  assert.equal(getUpgradePrice(9999).compare('1.87e2205'), 0);
  assert.equal(getUpgradeValue('power', 10000).compare('1.22e328'), 0);
  assert.equal(getUpgradeValue('money', 10000).compare('1.22e328'), 0);
  assert.equal(getUpgradeValue('speed', 10000).toNumber(), 80100);
  assert.equal(getUpgradePrice(10000), null);
  assert.throws(() => getUpgradePrice(10001)); assert.throws(() => getUpgradeValue('power', -1));
});

test('Original currency display truncates without losing wallet decimals and falls back after zz', () => {
  assert.equal(units.length, 702); assert.equal(units[0], 'a'); assert.equal(units[26], 'aa'); assert.equal(units[701], 'zz');
  for (const [value, expected] of [['21.6', '21'], ['999.99', '999'], ['1000', '1a'], ['1234.99', '1.23a'], ['12345.9', '12.34a'], ['999999.99', '999.99a'], ['1e2106', '1zz'], ['1.234567e2109', '1.23e+2109']]) assert.equal(D.from(value).format(units), expected);
  assert.equal(D.from('1.87e2205').format(units), '1.87e+2205');
});

test('Purchases reject insufficient funds and deduct exact equality atomically, one level at a time', () => {
  const { session } = seeded('49.99');
  assert.equal(session.purchase('power'), false); assert.equal(snapshot(session).money.toString(), '49.99');
  assert.ok(Math.abs(snapshot(session).upgrades[0].progress - 49.99 / 50) < 1e-12);
  const exact = seeded(50).session;
  assert.equal(exact.purchase('power'), true); assert.equal(snapshot(exact).money.toString(), '0');
  assert.deepEqual(snapshot(exact).upgrades.map(u => u.level), [1, 0, 0]);
  assert.equal(snapshot(exact).upgrades[0].price.toNumber(), 68);
  assert.equal(exact.purchase('power'), false); assert.equal(exact.purchase('invalid'), false);
  assert.equal(exact.combatModifiers.damage.toNumber(), 108);
  assert.equal(exact.combatModifiers.attackInterval, Math.fround(0.6));
});

test('Income upgrade changes future fractional rewards, preserves duplicate protection and no hard cap', () => {
  const { session } = seeded(50);
  assert.equal(session.purchase('money'), true);
  const first = reward(session); assert.equal(first[0].amount.toString(), '21.6');
  assert.equal(snapshot(session).money.toString(), '21.6'); assert.deepEqual(reward(session), []);
  session.beginRound(); assert.equal(reward(session, 1)[0].amount.toString(), '38.88');
  assert.equal(snapshot(session).money.toString(), '60.48');
  // Tree_Batch's degree-1 double multiplier keeps p17, so Lv2 preserves 41.76.
  const levelTwo = seeded(0, [0, 0, 2]).session;
  assert.equal(reward(levelTwo, 0, 1)[0].amount.toString(), '23.2');
  assert.equal(reward(levelTwo, 1, 2)[0].amount.toString(), '41.76');
  const huge = seeded('1e2300').session; reward(huge);
  assert.equal(snapshot(huge).money.compare('1e2300'), 0, 'native InfVal cannot retain tiny income beyond the wallet precision');
});

test('Local save restores decimal balances and independent upgrades; replay changes neither', () => {
  const { store, session } = seeded('500.25');
  for (const type of UPGRADE_TYPES) assert.equal(session.purchase(type), true);
  reward(session); const before = snapshot(session);
  const restored = new BattleSession({ storage: store });
  assert.equal(snapshot(restored).money.compare(before.money), 0);
  assert.deepEqual(snapshot(restored).upgrades.map(u => u.level), [1, 1, 1]);
  restored.beginRound(); assert.equal(snapshot(restored).money.compare(before.money), 0);
  assert.equal(restored.combatModifiers.damage.toNumber(), 108);
  assert.equal(restored.combatModifiers.attackInterval, Math.fround(Math.fround(Math.fround(0.6) / 108) * 100));
});

test('Mutating a returned snapshot cannot change session levels, wallet or immutable amounts', () => {
  const { session } = seeded('500.25', [1, 2, 3]);
  const state = snapshot(session), money = state.money, value = state.upgrades[0].value;
  assert.equal(Object.isFrozen(money), true); assert.equal(Object.isFrozen(value), true);
  assert.equal(Reflect.set(money, 'digits', '999999'), false);
  assert.equal(Reflect.set(money, 'exponent', 100), false);
  assert.equal(Reflect.set(value, 'digits', '0'), false);
  state.money = D.from(0);
  state.upgrades[0].level = 9999; state.upgrades[0].price = D.from(0);
  state.upgrades[1].value = D.from(0); state.upgrades.splice(2, 1);
  const fresh = snapshot(session);
  assert.equal(fresh.money.toString(), '500.25');
  assert.deepEqual(fresh.upgrades.map(u => u.level), [1, 2, 3]);
  assert.equal(fresh.upgrades[0].price.toNumber(), 68);
  assert.equal(fresh.upgrades[0].value.toNumber(), 108);
  assert.equal(fresh.upgrades[1].value.toNumber(), 116);
  assert.equal(session.purchase('power'), true);
  assert.equal(snapshot(session).money.toString(), '432.25');
  assert.equal(money.toString(), '500.25', 'past snapshot amounts remain unchanged after purchases');
});

test('Test funding derives exact full upgrade cost, remains spendable and never leaks to production', () => {
  const store = storage(), session = new BattleSession({ environment: 'test', storage: store });
  const total = fullUpgradeBudget();
  assert.equal(total.truncateSignificant(17).toString(), '1.1238824265397839e+2206');
  assert.equal(snapshot(session).money.compare(total), 0);
  assert.equal(session.purchase('power'), true); assert.equal(total.sub(snapshot(session).money).toNumber(), 50);
  const production = new BattleSession({ environment: 'production', storage: store });
  assert.equal(snapshot(production).money.toNumber(), 0);
  assert.deepEqual(snapshot(production).upgrades.map(u => u.level), [0, 0, 0]);
  const reloaded = new BattleSession({ environment: 'test', storage: store });
  assert.equal(snapshot(reloaded).money.compare(total), 0); assert.equal(snapshot(reloaded).upgrades[0].level, 1);
  const higher = seeded(total.add(20), [2, 3, 4], 'test').session;
  assert.equal(snapshot(higher).money.compare(total.add(20)), 0);
});

for (const order of ['forward', 'reverse', 'alternating']) {
  test(`The exact test budget buys all 30000 levels in ${order} order`, () => {
    const session = new BattleSession({ environment: 'test' });
    if (order === 'alternating') {
      for (let level = 0; level < MAX_UPGRADE_LEVEL; level++) for (const type of UPGRADE_TYPES) assert.equal(session.purchase(type), true, `${type} ${level}`);
    } else {
      const types = order === 'forward' ? UPGRADE_TYPES : [...UPGRADE_TYPES].reverse();
      for (const type of types) for (let level = 0; level < MAX_UPGRADE_LEVEL; level++) assert.equal(session.purchase(type), true, `${type} ${level}`);
    }
    const state = snapshot(session);
    assert.equal(state.money.toString(), '0');
    for (const upgrade of state.upgrades) {
      assert.equal(upgrade.level, 10000); assert.equal(upgrade.price, null);
      assert.equal(upgrade.affordable, false); assert.equal(upgrade.progress, 0);
      assert.equal(session.purchase(upgrade.type), false);
    }
    assert.equal(session.combatModifiers.attackInterval, Math.fround(0.05));
    assert.equal(session.combatModifiers.damage.compare('1.22e328'), 0);
  });
}

test('Malformed saves fall back safely and unavailable storage warns once while play continues', () => {
  const originalWarn = console.warn, warnings = []; console.warn = (...message) => warnings.push(message);
  try {
    const empty = new BattleSession({ storage: { getItem() { return ''; }, setItem() {} } });
    assert.equal(snapshot(empty).money.toNumber(), 0);
    assert.equal(warnings.length, 0, 'WeChat returns an empty string for a missing key');
    const valid = JSON.parse(seeded(50).store.getItem(economyStorageKey('production')));
    for (const raw of ['bad json', '{"version":2}', JSON.stringify({ ...valid, money: { digits: '-1', exponent: 0 } }),
      JSON.stringify({ ...valid, levels: [0, 10001, 0] }), JSON.stringify({ ...valid, progress: { stageIndex: -1, waveIndex: 0 } }),
      JSON.stringify({ ...valid, progress: { stageIndex: 0, waveIndex: 5 } }), JSON.stringify({ ...valid, progress: undefined })]) {
      const store = storage(); store.setItem(economyStorageKey('production'), raw);
      const session = new BattleSession({ storage: store });
      assert.equal(snapshot(session).money.toNumber(), 0); assert.deepEqual(snapshot(session).upgrades.map(u => u.level), [0, 0, 0]);
    }
    for (const money of [{ digits: '1', exponent: Number.MAX_SAFE_INTEGER + 1 }, { digits: '1', exponent: -Number.MAX_SAFE_INTEGER - 1 },
      { digits: '1'.repeat(MAX_SAVED_DECIMAL_SPAN + 1), exponent: 0 }]) {
      const store = storage();
      store.setItem(economyStorageKey('production'), JSON.stringify({ ...valid, money, levels: [2, 3, 4] }));
      const session = new BattleSession({ storage: store });
      assert.equal(snapshot(session).money.toNumber(), 0);
      assert.deepEqual(snapshot(session).upgrades.map(u => u.level), [0, 0, 0]);
      for (let id = 0; id < 3; id++) reward(session, 0, id);
      assert.equal(snapshot(session).money.toNumber(), 60);
      assert.equal(session.purchase('power'), true);
      assert.equal(snapshot(session).money.toNumber(), 10);
      assert.equal(snapshot(session).upgrades[0].level, 1);
    }
    const before = warnings.length;
    const session = new BattleSession({ environment: 'test', storage: { getItem() { throw Error('disabled'); }, setItem() { throw Error('quota'); } } });
    assert.equal(session.purchase('money'), true); reward(session); session.save();
    assert.equal(warnings.length - before, 1);
    assert.equal(snapshot(session).money.compare(fullUpgradeBudget().sub(50).add('21.6')), 0);
  } finally { console.warn = originalWarn; }
});

test('High-stage v3 wallets retain safe large exponents and progress without expanding their coefficient', () => {
  const { store } = seeded(0), key = economyStorageKey('production');
  const saved = JSON.parse(store.getItem(key));
  saved.money = { digits: '27', exponent: 120000 };
  saved.progress = { stageIndex: 250000, waveIndex: 4 };
  saved.weapons.stageValueMax = 2500004;
  store.setItem(key, JSON.stringify(saved));
  const session = new BattleSession({ storage: store });
  assert.deepEqual(session.moneyBalance.toJSON(), saved.money);
  assert.equal(session.round.stageIndex, 250000); assert.equal(session.round.waveIndex, 4);
  assert.equal(session.weapons.snapshot().stageValueMax, 2500004);
  session.save();
  const again = new BattleSession({ storage: store });
  assert.deepEqual(again.moneyBalance.toJSON(), saved.money);
  assert.equal(again.round.stageIndex, 250000); assert.equal(again.round.waveIndex, 4);
});
