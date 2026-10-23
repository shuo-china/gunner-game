const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');

function fixture(money, levels = [0, 0, 0]) {
  const key = economyStorageKey('production'), data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  new BattleSession({ storage });
  const saved = JSON.parse(data.get(key));
  data.set(key, JSON.stringify({ ...saved, money, levels }));
  return { session: new BattleSession({ storage }), storage, saved: () => JSON.parse(data.get(key)) };
}
function pay(session, value = 20, precision = 5, id = 0) {
  const position = { x: 0, z: 0 };
  return session.consume([{ type: 'treeDied', treeId: id, position, sourceTime: 0 }],
    [{ id, alive: false, reward: D.from(value), rewardPrecision: precision, position }]);
}

// Source Gamemanager.Get_Money / Lose_Money use InfVal add/subtract, not exact
// DecimalAmount arithmetic. Price_balance level 1 = 680e-1, precision 3.
test('gold income truncates a carry and the next purchase aligns its operands before subtraction', () => {
  const { session, saved } = fixture({ digits: '99999', exponent: 0, precision: 5 }, [1, 0, 0]);
  assert.equal(pay(session)[0].amount.toString(), '20');
  assert.equal(session.moneyBalance.toString(), '100010'); // 99999 + 20 -> p5
  assert.equal(session.purchase('power'), true);
  assert.equal(session.moneyBalance.toString(), '99950'); // 100010 - trunc(68, tens)
  assert.equal(saved().money.precision, 5);
  assert.equal(pay(session).length, 0, 'precision conversion does not weaken duplicate protection');
});

test('a serialized wallet retains precision hidden by normalized trailing zeroes across reload', () => {
  const f = fixture({ digits: '1', exponent: 17, precision: 17 });
  assert.equal(pay(f.session)[0].amount.toString(), '20');
  assert.equal(f.session.moneyBalance.compare('100000000000000020'), 0);
  assert.equal(f.saved().money.precision, 17);
  const restored = new BattleSession({ storage: f.storage });
  assert.equal(restored.purchase('power'), true);
  assert.equal(restored.moneyBalance.compare('99999999999999970'), 0);
  assert.equal(f.saved().money.precision, 17);
});

test('higher-precision income promotes gold and low-precision income cannot add invisible exact digits', () => {
  const f = fixture({ digits: '1', exponent: 17, precision: 5 });
  pay(f.session, 20, 5, 1);
  assert.equal(f.session.moneyBalance.compare('1e17'), 0);
  pay(f.session, 36, 17, 2);
  assert.equal(f.session.moneyBalance.compare('100000000000000030'), 0);
  assert.equal(f.saved().money.precision, 17);
});

test('legacy and damaged optional gold precision preserve the existing amount, levels and inventory', () => {
  const originalWarn = console.warn; console.warn = () => {};
  try {
    for (const precision of [undefined, 0, '5', 100001, 3]) {
      const f = fixture({ digits: '123456789', exponent: -3, ...(precision === undefined ? {} : { precision }) }, [3, 2, 1]);
      assert.equal(f.session.moneyBalance.toString(), '123456.789');
      assert.equal(f.saved().money.precision, 9);
      assert.deepEqual(f.saved().levels, [3, 2, 1]);
      assert.equal(f.session.weapons.snapshot().equipment[0].weaponId, 0);
      const reloaded = new BattleSession({ storage: f.storage });
      assert.equal(reloaded.moneyBalance.toString(), '123456.789');
    }
  } finally { console.warn = originalWarn; }
});

test('new gold and rebirth reset begin at native integer-zero precision', () => {
  const f = fixture({ digits: '1', exponent: 17, precision: 17 });
  const saved = f.saved();
  saved.progress = { stageIndex: 2, waveIndex: 0 };
  saved.weapons.stageValueMax = 20;
  saved.tutorial = { step: 'done', drawCount: 2 }; saved.speedRun.stage = 1;
  f.storage.setItem(economyStorageKey('production'), JSON.stringify(saved));
  const session = new BattleSession({ storage: f.storage });
  assert.equal(session.requestRebirth('normal').ok, true);
  assert.ok(session.advanceRebirth(2));
  assert.equal(session.moneyBalance.toString(), '0');
  assert.equal(f.saved().money.precision, 1);
});
