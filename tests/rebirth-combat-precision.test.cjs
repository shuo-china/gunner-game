const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { getWeapon } = require('./.build/session/core/WeaponCatalog.js');
const { getStarPercent, getStarMultiplier } = require('./.build/session/session/WeaponInventory.js');
const { createStageDefinition, CombatWorld } = require('./.build/core/index.js');
const fixture = require('./fixtures/rebirth-golden.json');

function sessionFor({ weaponId = 0, powerLevel = 0, moneyLevel = 0, rebirthLevel = 0, starLevel = 0 }) {
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  new BattleSession({ storage });
  const key = economyStorageKey('production'), saved = JSON.parse(data.get(key));
  saved.levels = [powerLevel, 0, moneyLevel];
  saved.rebirth.levels = [rebirthLevel, 0, rebirthLevel];
  saved.weapons.collection[weaponId] = true;
  saved.weapons.equipment[0].weaponId = weaponId;
  saved.weapons.starLevels = [starLevel, 0, 0];
  data.set(key, JSON.stringify(saved));
  return { session: new BattleSession({ storage }), storage, data, key };
}
function amount(saved) { return D.from({ digits: saved.digits, exponent: saved.exponent }); }

test('live rebirth damage matches independent Cat and StarUpgrade native arithmetic, including huge values', () => {
  for (const row of fixture.combatDamage) {
    // Native fixture source 22 is the current 800-damage staff; other fixture IDs already match.
    const weaponId = row.weaponId === 22 ? 16 : row.weaponId;
    const { session, storage } = sessionFor({ ...row, weaponId });
    assert.equal(getWeapon(weaponId).damage, row.serializedBase);
    assert.equal(session.combatLoadout[0].damage.compare(amount(row.damage)), 0, JSON.stringify(row));
    assert.equal(new BattleSession({ storage }).combatLoadout[0].damage.compare(amount(row.damage)), 0, 'reload preserves precision inputs');
    const world = new CombatWorld(73);
    world.setLoadout(session.combatLoadout); world.fire();
    assert.equal(world.bullets[0].damage.compare(amount(row.damage)), 0, 'real projectile snapshots the original result');
  }
  assert.equal(sessionFor({ weaponId: 16, rebirthLevel: 5 }).session.combatLoadout[0].damage.toString(), '1016', 'ordinary level zero preserves p5 through 800 * 127%');
  assert.equal(sessionFor({ weaponId: 16, rebirthLevel: 5, starLevel: 1 }).session.combatLoadout[0].damage.toString(), '1524', '1016 keeps p4 after decimal discard, then receives 150%');
});

test('all star table percentages preserve native bonus-plus-100 precision', () => {
  for (const row of fixture.stars) {
    assert.deepEqual(getStarPercent(row.level).toJSON(), row.percent, `star ${row.level}`);
    assert.equal(getStarMultiplier(row.level).compare(amount(row.multiplier)), 0, `star multiplier ${row.level}`);
  }
});

test('generated tree precision survives into rebirth gold settlement and wallet persistence', () => {
  for (const row of fixture.treeMoney) {
    const { session, storage, data, key } = sessionFor(row);
    const trees = createStageDefinition(row.stageIndex, row.degree === 3 ? 4 : 1, 9183).trees;
    const tree = trees.find(candidate => candidate.degree === row.degree);
    assert.ok(tree, `fixture has degree ${row.degree}`);
    assert.equal(tree.reward.compare(amount(row.baseReward)), 0, JSON.stringify(row));
    assert.equal(tree.rewardPrecision, row.baseReward.precision);
    tree.alive = false;
    const event = { type: 'treeDied', treeId: tree.id, position: tree.position, sourceTime: 1 };
    const reward = session.consume([event], [tree]);
    assert.equal(reward[0].amount.compare(amount(row.payout)), 0, JSON.stringify(row));
    assert.equal(session.moneyBalance.compare(amount(row.payout)), 0);
    assert.equal(session.consume([event], [tree]).length, 0, 'same tree cannot pay twice');
    const saved = JSON.parse(data.get(key));
    assert.deepEqual(D.from(saved.money).toJSON(), reward[0].amount.toJSON(), 'wallet amount survives the precision field');
    assert.equal(saved.money.precision, row.payout.precision, 'wallet also retains the original reward precision');
    assert.equal(new BattleSession({ storage }).moneyBalance.compare(reward[0].amount), 0);
  }
});

test('custom tree metadata fallback rejects invalid precision without losing its payout or save', () => {
  for (const rewardPrecision of [undefined, null, 0, NaN, Infinity, -1, 100001, '3']) {
    const { session, storage } = sessionFor({ rebirthLevel: 11 });
    const tree = { id: 99, alive: false, reward: D.from(60), rewardPrecision };
    const rewards = session.consume([{ type: 'treeDied', treeId: 99, position: { x: 0, z: 0 }, sourceTime: 0 }], [tree]);
    assert.equal(rewards[0].amount.toString(), '102.6');
    assert.equal(new BattleSession({ storage }).moneyBalance.toString(), '102.6');
  }
});
