const test = require('node:test');
const assert = require('node:assert/strict');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { getUpgradePrice, getUpgradeMultiplier } = require('./.build/session/session/UpgradeEconomy.js');
const { getRebirthPrice, getRebirthBonus, getRebirthPercent } = require('./.build/session/session/RebirthEconomy.js');
const source = require('./fixtures/original-economy-precision.json');

function matches(actual, row, label) {
  const expected = D.from({ digits: row.s_digits, exponent: row.s_exponent });
  assert.equal(actual.amount.compare(expected), 0, label);
  const precision = expected.isZero ? Math.max(1, 1 - row.s_exponent) : row.s_digits.replace('-', '').length;
  assert.equal(actual.precision, precision, `${label}: serialized coefficient precision`);
}

test('ordinary power and money match shipped table values and preserve level-zero trailing zeroes', () => {
  for (const [type, table] of [['power', 'Power_balance'], ['money', 'Money_balance']]) {
    const evidence = source.tables[`ordinary.${table}`];
    assert.deepEqual(evidence.precisionCounts, { 3: 10000, 5: 1 });
    for (const row of evidence.samples) matches(getUpgradeMultiplier(type, row.level), row, `${type} ${row.level}`);
  }
  for (const row of source.tables['ordinary.Price_balance'].samples.filter(row => row.level < 10000)) {
    assert.equal(getUpgradePrice(row.level).compare(D.from({ digits: row.s_digits, exponent: row.s_exponent })), 0);
  }
});

test('permanent upgrade prices and bonuses match the shipped source table samples', () => {
  for (const type of ['power', 'speed', 'money']) {
    for (const row of source.tables[`rebirth.${type}`].samples) matches(getRebirthBonus(type, row.level), row, `${type} ${row.level}`);
  }
  assert.deepEqual(source.tables['rebirth.speed'].precisionCounts, { 5: 20001 });
  for (const row of source.tables['rebirth.Price_balance'].samples.filter(row => row.level < 20000)) {
    matches(getRebirthPrice(row.level), row, `rebirth price ${row.level}`);
  }
  assert.equal(getRebirthPercent('speed', 199).amount.toNumber(), 1095);
  assert.equal(getRebirthPercent('speed', 19999).amount.toNumber(), 100090);
});
