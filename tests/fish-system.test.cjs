const test = require('node:test');
const assert = require('node:assert/strict');
const { FishSystem, FISH_CATALOG, FISH_CAPACITY, FISH_DRAW_PRICE } = require('./.build/session/session/FishSystem.js');
const { ECONOMY_CONFIG, validateEconomyConfig } = require('./.build/session/core/EconomyConfig.js');
const { economyModules } = require('./support/economy-modules.cjs');
const DAY = '2026-10-15';
const save = (inventory = [], extras = {}) => ({ inventory, collected: Array(13).fill(false), autoEnabled: false,
  freeDrawDate: '', freeDrawCount: 0, ...extras });

test('fish native 13-grade float balance preserves ties-to-even and critical cap', () => {
  assert.deepEqual(FISH_CATALOG.map(f => f.grade), ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS', 'X', 'XX', 'XXX', 'Z', 'ZZ', 'ZZZ']);
  assert.deepEqual(FISH_CATALOG.map(f => f.damagePercent), [4, 12, 36, 110, 320, 970, 2900, 8700, 26000, 79000, 240000, 710000, 2100000]);
  assert.deepEqual(FISH_CATALOG.map(f => f.criticalChancePercent), [1, 2, 6, 16, 39, 98, 100, 100, 100, 100, 100, 100, 100]);
  assert.deepEqual(FISH_CATALOG.map(f => f.criticalDamagePercent), [8, 20, 50, 120, 310, 780, 2000, 4900, 12000, 31000, 76000, 190000, 480000]);
  assert.equal(FISH_CAPACITY, 20); assert.equal(FISH_DRAW_PRICE, 200);
});

test('fish draw uses shipped scene 60/30/10/0 probabilities and premium base offset', () => {
  for (const [roll, grade] of [[0, 0], [.599, 0], [.6, 1], [.899, 1], [.9, 2], [.999, 2], [1, 0]]) {
    for (const kind of ['free', 'diamonds']) {
      const f = new FishSystem(), r = f.draw(kind, 200, DAY, () => roll);
      assert.equal(r.ok, true); assert.equal(r.grade, grade + (kind === 'diamonds' ? 1 : 0));
      assert.equal(r.index, 0); assert.equal(r.discovered, r.grade);
    }
  }
  const f = new FishSystem(), empty = f.serialize();
  assert.equal(f.draw('diamonds', 199, DAY).reason, 'currency'); assert.deepEqual(f.serialize(), empty);
  for (const rng of [-.1, NaN, Infinity, 1.1]) assert.equal(f.draw('free', 0, DAY, () => rng).reason, 'invalid');
  assert.deepEqual(f.serialize(), empty);
  f.restore(save(Array(20).fill(0))); const full = f.serialize();
  assert.equal(f.draw('diamonds', 999, DAY).reason, 'full'); assert.equal(f.draw('free', 0, DAY).reason, 'full');
  assert.deepEqual(f.serialize(), full);
});

test('three direct draws, then two rewarded draws; rejection never consumes fish or quota', () => {
  const f = new FishSystem();
  for (let i = 0; i < 3; i++) assert.equal(f.draw('free', 0, DAY, () => 0).ok, true);
  const beforeAd = f.serialize(), s = f.snapshot(0, DAY);
  assert.equal(s.freeDrawRemaining, 2); assert.equal(s.freeWithoutAdRemaining, 0); assert.equal(s.freeDrawNeedsAd, true);
  assert.equal(f.draw('free', 0, DAY).reason, 'adRequired'); assert.deepEqual(f.serialize(), beforeAd);
  assert.equal(f.draw('free', 0, DAY, () => .6, true).ok, true);
  assert.equal(f.draw('free', 0, DAY, () => .9, true).ok, true);
  const after = f.serialize(); assert.equal(f.draw('free', 0, DAY, () => 0, true).reason, 'dailyLimit');
  assert.deepEqual(f.serialize(), after); assert.equal(f.snapshot(0, DAY).freeDrawRemaining, 0);
  assert.equal(f.draw('diamonds', 200, DAY, () => 0).ok, true); assert.equal(f.serialize().freeDrawCount, 5);
});

test('fish daily refresh, date rollback, save isolation and reduced limits preserve claims', () => {
  const f = new FishSystem(); f.restore(save([0], { freeDrawDate: DAY, freeDrawCount: 17 }));
  assert.equal(f.snapshot(0, DAY).freeDrawRemaining, 0); assert.equal(f.draw('free', 0, DAY).reason, 'dailyLimit');
  assert.equal(f.snapshot(0, '2026-10-14').freeDrawRemaining, 0);
  assert.equal(f.snapshot(0, '2026-10-16').freeDrawRemaining, 5);
  assert.equal(f.draw('free', 0, '2026-10-16', () => 0).ok, true);
  assert.equal(f.serialize().freeDrawCount, 1); assert.equal(f.serialize().freeDrawDate, '2026-10-16');
  assert.equal(f.snapshot(0, DAY).freeDrawRemaining, 4, 'rollback does not replenish yesterday');
  const copied = f.serialize(); copied.inventory[0] = 12; copied.collected[12] = true;
  assert.equal(f.serialize().inventory[0], 0); assert.equal(f.serialize().collected[12], false);
  const restored = new FishSystem(); restored.restore(f.serialize()); assert.deepEqual(restored.serialize(), f.serialize());
  const before = restored.serialize();
  for (const invalid of [null, {}, save([13]), save(Array(21).fill(0)), save([.5]), save([], { freeDrawCount: -1 }),
    save([], { freeDrawDate: '2026-02-30' }), save([], { collected: Array(13).fill(0) }), save([], { autoEnabled: 1 })]) {
    assert.throws(() => restored.restore(invalid), /Invalid fish save/); assert.deepEqual(restored.serialize(), before);
  }
  assert.throws(() => restored.restore(undefined), /Invalid fish save/); assert.deepEqual(restored.serialize(), before);
});

test('native compact fusion removes both source positions and appends the next grade', () => {
  const f = new FishSystem(); f.restore(save([2, 0, 3, 0, 12, 12]));
  const revision = f.snapshot(0, DAY).revision;
  assert.deepEqual(f.merge(3, 1, 0, false, revision), { ok: true, changed: true, grade: 1, index: 4, discovered: 1 });
  assert.deepEqual(f.serialize().inventory, [2, 3, 12, 12, 1]);
  const before = f.serialize();
  assert.equal(f.merge(2, 3).reason, 'maxGrade'); assert.equal(f.merge(0, 1).reason, 'grade');
  assert.equal(f.merge(0, 0).reason, 'invalid'); assert.equal(f.merge(-1, 1).reason, 'invalid');
  assert.equal(f.remove(1, 3, revision).reason, 'stale'); assert.equal(f.remove(1, 0).reason, 'stale');
  assert.deepEqual(f.serialize(), before);
  assert.equal(f.remove(1, 3).ok, true); assert.deepEqual(f.serialize().inventory, [2, 12, 12, 1]);
  assert.equal(f.serialize().collected[3], true, 'releasing a fish retains collection history');
});

test('fish auto merge is opt-in, low-grade-first, can discover grades and stops at ZZZ', () => {
  const f = new FishSystem(); f.restore(save([1, 0, 1, 0, 11, 11, 12, 12]));
  assert.equal(f.autoPair(), null); f.setAuto(true);
  assert.deepEqual(f.autoPair(), { from: 3, to: 1, grade: 0 }); assert.equal(f.autoPair(false), null);
  assert.equal(f.merge(3, 1, 0, true).ok, true); assert.deepEqual(f.autoPair(), { from: 1, to: 0, grade: 1 });
  let pair; while ((pair = f.autoPair())) assert.equal(f.merge(pair.from, pair.to, pair.grade, true).ok, true);
  assert.deepEqual(f.serialize().inventory, [12, 12, 1, 2, 12]);
  f.setAuto(false); assert.equal(f.merge(0, 1, 12, true).reason, 'maxGrade');
  f.restore(save([0, 0])); assert.equal(f.merge(0, 1, 0, true).ok, false);
});

test('every held duplicate contributes bonuses and snapshot reports native critical baseline', () => {
  const f = new FishSystem(); assert.deepEqual(f.totals, { damagePercent: 0, criticalChancePercent: 0, criticalDamagePercent: 0 });
  assert.equal(f.snapshot(0, DAY).criticalDamagePercent, 125);
  f.restore(save([0, 0, 12])); assert.deepEqual(f.totals, { damagePercent: 2100008, criticalChancePercent: 102, criticalDamagePercent: 480016 });
  assert.equal(f.snapshot(0, DAY).criticalChancePercent, 100); assert.equal(f.snapshot(0, DAY).criticalDamagePercent, 480141);
  f.remove(2); assert.equal(f.totals.damagePercent, 8); assert.equal(f.snapshot(0, DAY).criticalDamagePercent, 141);
});

test('fish prices, daily limits, bases and weights have one validated economy configuration', () => {
  for (const edit of [c => { c.fish.drawPrice = -1; }, c => { c.fish.noAdDrawsPerDay = 6; },
    c => { c.fish.freeBaseGrade = 10; }, c => { c.fish.drawGradePercents = [60, 30, 9, 0]; }]) {
    const config = JSON.parse(JSON.stringify(ECONOMY_CONFIG)); edit(config); assert.throws(() => validateEconomyConfig(config), /Invalid economy configuration/);
  }
  const load = economyModules(c => { Object.assign(c.fish, { drawPrice: 7, freeDrawsPerDay: 2, noAdDrawsPerDay: 1,
    freeBaseGrade: 4, premiumBaseGrade: 5, drawGradePercents: [0, 0, 0, 100] }); });
  const { FishSystem: ModifiedFish, FISH_DRAW_PRICE: price } = load('session/FishSystem');
  const f = new ModifiedFish(); assert.equal(price, 7); assert.equal(f.snapshot(7, DAY).drawPrice, 7);
  assert.equal(f.draw('diamonds', 6, DAY, () => 0).reason, 'currency'); assert.equal(f.draw('diamonds', 7, DAY, () => 0).grade, 8);
  assert.equal(f.draw('free', 0, DAY, () => 0).grade, 7); assert.equal(f.draw('free', 0, DAY).reason, 'adRequired');
  assert.equal(f.draw('free', 0, DAY, () => 0, true).grade, 7); assert.equal(f.draw('free', 0, DAY).reason, 'dailyLimit');
});
