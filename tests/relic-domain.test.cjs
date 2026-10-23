const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const build = process.env.ADVENTURE_DOMAIN_BUILD || path.join(__dirname, '.build/session');
const { RelicSystem, RELIC_CATALOG, relicValue, relicMaxLevel, relicUpgradePrice } = require(path.join(build, 'session/RelicSystem.js'));
const { AdventureSystem } = require(path.join(build, 'session/AdventureSystem.js'));
const { OriginalInfVal } = require(path.join(build, 'core/OriginalInfVal.js'));
const { ECONOMY_CONFIG, validateEconomyConfig } = require(path.join(build, 'core/EconomyConfig.js'));
const evidence = require('./fixtures/original-relic-balances.json');
const START = new Date(2026, 9, 18, 12).getTime();
function wallet(amount = 1000, type = 0) { const system = new AdventureSystem(START); system.grantCores(type, amount); return system; }
function relicsWith(change) { const system = new RelicSystem(), save = system.serialize(); change(save.items); system.restore(save); return system; }

test('all 900 raw coefficients and exponents match the original scene fixture', () => {
  for (const [family, key] of ['damageBalance', 'moneyBalance', 'criticalDamageBalance'].entries()) {
    assert.deepEqual(ECONOMY_CONFIG.relics[key], evidence.tables[key]);
    assert.equal(ECONOMY_CONFIG.relics[key].length, 300);
    evidence.tables[key].forEach((raw, level) => {
      const [digits, exponent] = raw.split(':');
      const base = OriginalInfVal.fromSerialized({ digits, exponent: Number(exponent), precision: digits.length });
      assert.deepEqual(relicValue(family * 3, level).toJSON(), base.toJSON());
      assert.deepEqual(relicValue(family * 3 + 1, level).toJSON(), base.mul(OriginalInfVal.fromDouble(1.5)).discardDecimal().toJSON());
      assert.deepEqual(relicValue(family * 3 + 2, level).toJSON(), base.mul(2).toJSON());
    });
  }
  assert.deepEqual(RELIC_CATALOG.map(item => [item.type, item.core]), evidence.relics.map(item => [item.Type, item.Core_Type]));
  assert.equal(relicValue(0, 0).toString(), '5');
  assert.equal(relicValue(1, 0).toString(), '7');
  assert.equal(relicValue(2, 0).toString(), '10');
  assert.equal(relicValue(0, 299).toString(), '132000000');
  assert.throws(() => relicValue(0, 300));
});

test('only unlocked abilities affect totals, with original baseline and special formulas', () => {
  const fresh = new RelicSystem();
  assert.equal(fresh.totals.damage.toString(), '100'); assert.equal(fresh.totals.money.toString(), '100');
  assert.equal(fresh.totals.criticalDamage.toString(), '100'); assert.equal(fresh.totals.rebirthPercent, 100);
  const system = relicsWith(items => items.forEach(item => { item.unlocked = true; }));
  assert.equal(system.totals.damage.toString(), '122'); assert.equal(system.totals.money.toString(), '122');
  assert.equal(system.totals.criticalDamage.toString(), '122');
  assert.equal(system.totals.moveSpeedPercent, 2); assert.equal(system.totals.offlineMinutes, 10);
  assert.equal(system.totals.rebirthPercent, 105); assert.equal(system.totals.skipPercent, 6);
  const specials = relicsWith(items => items.forEach((item, i) => { if (RELIC_CATALOG[i].type > 8) { item.unlocked = true; item.level = 50; } }));
  assert.equal(specials.totals.moveSpeedPercent, 102); assert.equal(specials.totals.offlineMinutes, 510);
  assert.equal(specials.totals.rebirthPercent, 355); assert.equal(specials.totals.skipPercent, 306);
  const snapshot = specials.snapshot([20, 19, 200, 0]);
  assert.deepEqual(snapshot.drawMax, [1, 0, 10, 0]);
  assert.equal(snapshot.items[3].displayLevel, 51); assert.equal(snapshot.items[3].canUpgrade, false);
});

test('draws use the correct colored and universal pools; first copies unlock and repeats count', () => {
  for (const [core, first, last] of [[0, 0, 4], [1, 5, 9], [2, 10, 14], [3, 0, 14]]) {
    const system = new RelicSystem(), cores = wallet(60, core);
    assert.deepEqual(system.draw(core, 1, cores, () => 0).drawn, [{ index: first, isNew: true, count: 0 }]);
    assert.deepEqual(system.draw(core, 1, cores, () => 1).drawn, [{ index: last, isNew: true, count: 0 }]);
    assert.deepEqual(system.draw(core, 1, cores, () => 0).drawn, [{ index: first, isNew: false, count: 1 }]);
    assert.equal(cores.coreCount(core), 0);
    assert.equal(system.draw(core, 1, cores).reason, 'currency');
  }
});

test('maxed abilities leave the draw pool until the whole pool is maxed', () => {
  const system = relicsWith(items => items.slice(0, 4).forEach((item, i) => { item.unlocked = true; item.level = relicMaxLevel(RELIC_CATALOG[i].type); }));
  assert.equal(system.draw(0, 1, wallet(), () => 0).drawn[0].index, 4);
  assert.equal(system.draw(0, 1, wallet(), () => 0.99).drawn[0].index, 4);
  const allMax = relicsWith(items => items.forEach((item, i) => { item.unlocked = true; item.level = relicMaxLevel(RELIC_CATALOG[i].type); }));
  const result = allMax.draw(0, 1, wallet(), () => 0);
  assert.equal(result.ok, true); assert.deepEqual(result.drawn, [{ index: 0, isNew: false, count: 1 }]);
  assert.equal(allMax.draw(3, 1, wallet(20, 3), () => 1).drawn[0].index, 14);
});

test('batch draw failures cannot spend cores or partially unlock abilities', () => {
  const system = new RelicSystem(), cores = wallet(100);
  const before = system.serialize(), walletBefore = cores.serialize();
  let n = 0;
  assert.equal(system.draw(0, 3, cores, () => ++n === 3 ? NaN : 0).reason, 'invalidRandom');
  assert.deepEqual(system.serialize(), before); assert.deepEqual(cores.serialize(), walletBefore);
  for (const count of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) assert.equal(system.draw(0, count, cores).ok, false);
  assert.equal(system.draw(4, 1, cores).ok, false);
  const overflow = relicsWith(items => { items[0].unlocked = true; items[0].count = Number.MAX_SAFE_INTEGER; });
  assert.equal(overflow.draw(0, 1, cores, () => 0).reason, 'countLimit');
  assert.deepEqual(cores.serialize(), walletBefore);
});

test('upgrades consume 2*level+2 capped at 50 and cannot pass the source table boundary', () => {
  assert.deepEqual([0, 1, 23, 24, 25, 299].map(relicUpgradePrice), [2, 4, 48, 50, 50, 50]);
  const system = relicsWith(items => { items[0].unlocked = true; items[0].count = 6; });
  assert.equal(system.upgrade(0).ok, true); assert.equal(system.serialize().items[0].count, 4);
  assert.equal(system.upgrade(0).ok, true); assert.equal(system.serialize().items[0].level, 2);
  assert.equal(system.upgrade(0).reason, 'count');
  assert.equal(system.upgrade(1).reason, 'locked');
  const nearMax = relicsWith(items => { items[0] = { unlocked: true, level: 298, count: 100 }; items[3] = { unlocked: true, level: 49, count: 100 }; });
  assert.equal(nearMax.upgrade(0).ok, true); assert.equal(nearMax.upgrade(0).reason, 'maxLevel');
  assert.equal(nearMax.upgrade(3).ok, true); assert.equal(nearMax.upgrade(3).reason, 'maxLevel');
  const snapshot = nearMax.snapshot();
  assert.equal(snapshot.items[0].displayLevel, 300); assert.equal(snapshot.items[0].nextValue, snapshot.items[0].value);
  assert.equal(snapshot.items[3].displayLevel, 51); assert.equal(snapshot.items[3].nextValue, snapshot.items[3].value);
});

test('bad collection data and malformed economy tables are rejected without state replacement', () => {
  const system = new RelicSystem(), original = system.serialize();
  for (const mutate of [d => d.items.pop(), d => d.items[0].level = 300, d => d.items[3].level = 51,
    d => d.items[0].count = -1, d => d.items[0].count = 1, d => d.items[0].unlocked = 1]) {
    const bad = structuredClone(original); mutate(bad); assert.throws(() => system.restore(bad)); assert.deepEqual(system.serialize(), original);
  }
  validateEconomyConfig(ECONOMY_CONFIG);
  for (const mutate of [c => c.relics.damageBalance.pop(), c => c.relics.moneyBalance[0] = '0:0',
    c => c.relics.drawPrice = 0, c => c.adventure.ticketChargeHours = 0, c => c.adventure.initialCores[1] = -1,
    c => c.adventure.durationHours.pop()]) {
    const bad = structuredClone(ECONOMY_CONFIG); mutate(bad); assert.throws(() => validateEconomyConfig(bad));
  }
  assert.equal(Object.isFrozen(ECONOMY_CONFIG.adventure), true);
  assert.equal(Object.isFrozen(ECONOMY_CONFIG.relics.damageBalance), true);
});
