const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { OriginalInfVal: I } = require('./.build/session/core/OriginalInfVal.js');
const E = require('./.build/session/session/RebirthEconomy.js');
const fixture = require('./fixtures/rebirth-golden.json');

test('InfVal distinguishes integer precision, double G17 precision, and stored trailing zeroes', () => {
  assert.deepEqual(I.fromInt(100).toJSON(), { digits: '1', exponent: 2, precision: 3 });
  assert.deepEqual(I.fromInt(0).toJSON(), { digits: '0', exponent: 0, precision: 1 });
  assert.deepEqual(I.fromDouble(1.38).toJSON(), { digits: '13799999999999999', exponent: -16, precision: 17 });
  assert.deepEqual(I.fromDouble(1).toJSON(), { digits: '1', exponent: 0, precision: 17 });
  assert.equal(I.fromInt(100).mul(3).precision, 3);
  assert.equal(I.fromAmount(D.from('1e500')).precision, 501);
  assert.equal(I.fromAmount(D.from('1e500'), 3).precision, 3);
  const saved = I.fromDouble(316.22).toPrecision(5).toJSON();
  assert.deepEqual(I.fromSerialized(JSON.parse(JSON.stringify(saved))).toJSON(), saved);
  assert.ok(Object.isFrozen(I.fromInt(1)));
  for (const value of [null, 1, {}, { digits: '1', exponent: 0, precision: 0 }, { digits: '12345', exponent: 0, precision: 3 },
    { digits: '1', exponent: NaN, precision: 1 }, { digits: '1', exponent: 0, precision: 100001 }]) assert.throws(() => I.fromSerialized(value));
  for (const value of [Infinity, NaN]) assert.throws(() => I.fromDouble(value));
  for (const value of [1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => I.fromInt(value));
});

test('InfVal operators align operands before addition/subtraction and cut after multiplication', () => {
  const small = I.fromAmount(D.from('9.999'), 4);
  assert.equal(I.fromInt(10000).sub(small).toString(), '9991');
  assert.equal(I.fromInt(-10000).add(small).toString(), '-9991');
  assert.equal(I.fromInt(999).add(I.fromInt(1)).toString(), '1000');
  assert.equal(I.fromInt(999).add(I.fromInt(1)).precision, 3);
  assert.equal(I.fromAmount(D.from('123.99'), 5).toPrecision(3).toString(), '123');
  assert.equal(I.fromAmount(D.from('-123.99'), 5).discardDecimal().toString(), '-123');
  assert.equal(I.fromDouble(123).discardDecimal().precision, 3);
  assert.equal(I.fromInt(11).pow(2).toString(), '120');
  assert.equal(I.fromInt(11).pow(2, false).toString(), '120');
  assert.equal(I.fromInt(0).toPrecision(5).pow(0).precision, 5);
  assert.equal(I.fromInt(0).pow(-1).toString(), '0');
  assert.throws(() => I.fromInt(1).pow(0.5));
});

test('InfVal division follows the original coefficient expansion, including unequal precisions', () => {
  assert.equal(I.fromInt(1).div(3).toString(), '0.3');
  assert.equal(I.fromInt(1).toPrecision(17).div(3).toString(), '0.33333333333333333');
  assert.deepEqual(I.fromInt(1).div(I.fromDouble(3)).toJSON(), { digits: '3', exponent: -1, precision: 17 });
  assert.equal(I.fromInt(-10).div(3).toString(), '-3.3');
  assert.equal(I.fromInt(2).pow(-2).toString(), '0.2');
  assert.equal(I.fromInt(10).pow(-2).toString(), '0.01');
  assert.throws(() => I.fromInt(10).div(0));
});

test('InfVal balance accumulation and zero cancellation preserve precision across save/load', () => {
  const reward = E.getRebirthReward({ stageIndex: 2, waveIndex: 1 });
  let balance = I.fromInt(0);
  for (let i = 0; i < 3; i++) balance = I.fromSerialized(balance.add(reward).toJSON());
  assert.equal(balance.toString(), '1193.9');
  assert.equal(balance.precision, 5);
  assert.equal(balance.sub(E.getRebirthPrice(0)).toString(), '1190.9');
  const preciseZero = reward.sub(reward);
  assert.equal(preciseZero.precision, 5);
  assert.deepEqual(I.fromSerialized(preciseZero.toJSON()).toJSON(), preciseZero.toJSON());
  // Native zero get_precision retains unusual positive raw exponents after huge cancellation.
  const huge = I.fromAmount(D.from('1e400'), 3), zero = huge.sub(huge);
  assert.deepEqual(zero.toJSON(), { digits: '0', exponent: 396, precision: 1 });
  assert.deepEqual(I.fromSerialized(zero.toJSON()).toPrecision(3).toJSON(), zero.toPrecision(3).toJSON());
  assert.deepEqual(I.fromSerialized(zero.toJSON()).add(reward).toJSON(), reward.toJSON());
});

test('Rebirth rewards match independent original-code golden cases at unlock, wave and relic boundaries', () => {
  assert.equal(E.getRebirthReward({ stageIndex: 2, waveIndex: 0 }).toString(), '316.22');
  assert.equal(E.getRebirthReward({ stageIndex: 2, waveIndex: 0 }, 100, true).toString(), '948.66');
  assert.equal(E.getRebirthReward({ stageIndex: 2, waveIndex: 1 }).toString(), '397.99');
  assert.equal(E.getRebirthReward({ stageIndex: 2, waveIndex: 1 }, 100, true).toString(), '1193.9');
  for (const row of fixture.rewards) {
    assert.deepEqual(E.getRebirthReward(row, row.rewardPercent).toJSON(), row.ordinary, JSON.stringify(row));
    assert.deepEqual(E.getRebirthReward(row, row.rewardPercent, true).toJSON(), row.enhanced, JSON.stringify(row));
  }
  for (const position of [{ stageIndex: -1, waveIndex: 0 }, { stageIndex: 2, waveIndex: 5 }, { stageIndex: 2, waveIndex: -1 }, { stageIndex: 2.5, waveIndex: 1 }]) assert.throws(() => E.getRebirthReward(position));
});

test('Rebirth prices and bonuses match the original recurrence at 15000 and 20000 level boundaries', () => {
  assert.deepEqual(E.REBIRTH_UPGRADE_TYPES, ['power', 'speed', 'money']);
  assert.equal(E.MAX_REBIRTH_UPGRADE_LEVEL, 20000);
  for (const row of fixture.upgrades) {
    assert.deepEqual(E.getRebirthPrice(row.level)?.toJSON() ?? null, row.price, `price ${row.level}`);
    for (const type of E.REBIRTH_UPGRADE_TYPES) {
      assert.deepEqual(E.getRebirthBonus(type, row.level).toJSON(), row[type === 'speed' ? 'speedBonus' : 'powerBonus'], `${type} bonus ${row.level}`);
      assert.deepEqual(E.getRebirthPercent(type, row.level).toJSON(), row[type === 'speed' ? 'speedPercent' : 'powerPercent'], `${type} percent ${row.level}`);
    }
  }
  assert.equal(E.getRebirthBonus('power', 20000).amount.scientificExponent, 425);
  assert.equal(E.getRebirthBonus('speed', 20000).toString(), '100000');
  for (const level of [-1, 0.5, 20001, Infinity, NaN]) {
    assert.equal(E.isRebirthLevel(level), false);
    assert.throws(() => E.getRebirthPrice(level)); assert.throws(() => E.getRebirthBonus('power', level));
  }
  assert.throws(() => E.getRebirthBonus('unknown', 0));
});

test('Rebirth fixture records immutable original source hashes and runtime source avoids BigInt', () => {
  assert.match(fixture.provenance.method, /not runtime captures/);
  for (const [source, hash] of Object.entries(fixture.provenance.sourceSha256)) {
    assert.match(hash, /^[a-f0-9]{64}$/);
    const local = path.resolve(__dirname, '../..', source);
    if (fs.existsSync(local)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex'), hash, source);
  }
  const source = fs.readFileSync(path.resolve(__dirname, '../assets/scripts/core/OriginalInfVal.ts'), 'utf8');
  assert.doesNotMatch(source, /\bBigInt\s*\(|\b\d+n\b/);
});

test('remaining permanent-upgrade budget sums exact prices for each current level', () => {
  assert.equal(E.remainingRebirthUpgradeBudget([0, 0, 0]).toString(), '291160414119861');
  assert.equal(E.remainingRebirthUpgradeBudget([20000, 20000, 20000]).toNumber(), 0);
  assert.equal(E.remainingRebirthUpgradeBudget([19999, 20000, 20000]).compare(E.getRebirthPrice(19999).amount), 0);
  assert.equal(E.remainingRebirthUpgradeBudget([1, 0, 0]).toString(), '291160414119858');
  for (const invalid of [[], [0, 0], [0, 0, 20001], [0, .5, 0], [0, NaN, 0]]) assert.throws(() => E.remainingRebirthUpgradeBudget(invalid));
});
