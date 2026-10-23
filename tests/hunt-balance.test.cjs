const test = require('node:test');
const assert = require('node:assert/strict');
const { huntHealth, HUNT_RULES, validateHuntLevel } = require('./.build/core/HuntBalance.js');
const fixture = require('./fixtures/hunt-health-original.json');

test('all 2000 authored Hunt HP values and their native precision match the independently extracted source table', () => {
  assert.equal(fixture.values.length, 2000);
  for (const [wave, value] of fixture.values.entries()) {
    const actual = huntHealth(wave);
    assert.equal(actual.amount.compare({ digits: value.s_digits, exponent: value.s_exponent }), 0, `Hunt wave ${wave}`);
    assert.equal(actual.precision, value.s_digits.length, `Hunt precision ${wave}`);
  }
});

test('Hunt preserves first-wave p3 and truncates each subsequent multiplication to p2', () => {
  const values = ['500', '1500', '4500', '13000', '39000', '110000', '330000', '990000', '2900000'];
  values.forEach((value, wave) => {
    assert.equal(huntHealth(wave).toString(), value);
    assert.equal(huntHealth(wave).precision, wave === 0 ? 3 : 2);
  });
  assert.equal(huntHealth(0, true).toString(), '1500');
  assert.equal(huntHealth(2, true).toString(), '13000');
  assert.equal(huntHealth(0, true).precision, 2);
});

test('Hunt combat tables preserve all five original targets, cadences and independent collision sizes', () => {
  assert.deepEqual(HUNT_RULES.targetCounts, [90, 120, 160, 200, 240]);
  assert.deepEqual(HUNT_RULES.spawnIntervals, [.35, .2, .17, .12, .08]);
  assert.equal(HUNT_RULES.poolSize, 240); assert.equal(HUNT_RULES.sparseSpawnInterval, .04);
  assert.equal(HUNT_RULES.barrierHp, 1); assert.equal(HUNT_RULES.barrierRadius, 15);
  assert.equal(HUNT_RULES.speedReferenceRadius, 20); assert.equal(HUNT_RULES.catRadius, 14);
  assert.equal(HUNT_RULES.rayCount, 60); assert.equal(HUNT_RULES.attackRange, 60);
});

test('restored high Hunt waves retain exact recurrence without allocating per-wave tables', () => {
  let expected = huntHealth(0);
  for (let wave = 1; wave < 2000; wave++) {
    expected = expected.mul(3).toPrecision(2);
    assert.equal(huntHealth(wave).amount.compare(expected.amount), 0, `wave ${wave}`);
  }
  for (const wave of [2000, 1e6, 1e12, Number.MAX_SAFE_INTEGER - 1]) {
    const health = huntHealth(wave);
    assert.equal(health.precision, 2); assert.ok(Number.isSafeInteger(health.amount.exponent));
    assert.equal(huntHealth(wave + 1).amount.compare(health.mul(3).toPrecision(2).amount), 0, `wave ${wave}`);
  }
  for (const wave of [-1, .5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => huntHealth(wave));
  for (const level of [-1, 5, .5, NaN]) assert.throws(() => validateHuntLevel(0, level));
});
