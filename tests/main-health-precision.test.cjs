const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, createStageDefinition, DecimalAmount: D } = require('./.build/core/index.js');
const { getWeapon } = require('./.build/core/WeaponCatalog.js');

// Independent expected values from level0:124872's raw InfVal coefficients
// (first HP 25000e-2, money 20000e-3; following rows p2), Tree_Batch's
// multiplication, and Enemy.Damaged's aligned-coefficient subtraction.
test('main maps retain serialized HP and reward precision and truncate integer degree multipliers', () => {
  for (const [stage, degree, hp, precision, money, moneyPrecision] of [
    [0, 0, '250', 5, '20', 5], [0, 1, '450', 17, '36', 17],
    [0, 2, '750', 5, '60', 5], [0, 3, '8750', 5, '2000', 5],
    [1, 0, '750', 2, '60', 2], [1, 1, '1350', 17, '108', 17],
    [1, 2, '2200', 2, '180', 2], [1, 3, '26000', 2, '6000', 3],
  ]) {
    const tree = createStageDefinition(stage, degree === 3 ? 4 : 2, 9183).trees.find(t => t.degree === degree);
    assert.ok(tree);
    assert.equal(tree.health.toString(), hp, `stage ${stage} degree ${degree} HP`);
    assert.equal(tree.maxHealth.toString(), hp);
    assert.equal(tree.healthPrecision, precision);
    assert.equal(tree.reward.toString(), money);
    assert.equal(tree.rewardPrecision, moneyPrecision);
  }
});

function targetWorld(stage = 2) {
  const world = new CombatWorld(42, createStageDefinition(stage, 0, 42));
  const target = world.trees.find(t => t.degree === 0);
  target.position = { x: 0, z: 5 };
  target.collider = { minX: -.5, maxX: .5, minZ: 4.5, maxZ: 5.5 };
  world.trees.splice(0, world.trees.length, target);
  world.stats.totalTrees = 1;
  world.setMuzzleOffset({ x: 0, z: 0 });
  world.player.aim = { x: 0, z: 1 };
  return { world, target };
}
function strike(world, damage, damagePrecision, critical = false) {
  world.setLoadout([{ actorIndex: 0, weapon: getWeapon(0), damage: D.from(damage), damagePrecision,
    attackInterval: .6, criticalChance: critical ? 1 : 0, criticalMultiplier: 1.25 }]);
  assert.equal(world.fire(), true);
  world.updateBullets(.1);
  return world.drainEvents();
}

test('main projectiles retain health precision across weak hits and settle the resulting kill only once', () => {
  const { world, target } = targetWorld();
  assert.equal(target.health.toString(), '2200');
  const first = strike(world, 125, 3);
  assert.equal(target.health.toString(), '2080', '220e1 - 12e1, instead of exact 2075');
  assert.equal(target.healthPrecision, 3);
  assert.equal(first.find(e => e.type === 'hit').health.toString(), '2080');
  assert.equal(target.maxHealth.toString(), '2200');
  strike(world, 2069, 4);
  assert.equal(target.health.toString(), '11');
  assert.equal(target.healthPrecision, 4);
  assert.equal(target.alive, true);
  const killed = strike(world, 11, 2);
  assert.equal(target.health.toString(), '0');
  assert.equal(target.alive, false);
  assert.equal(world.stats.kills, 1);
  assert.equal(killed.filter(e => e.type === 'treeDied').length, 1);
  assert.equal(killed.filter(e => e.type === 'complete').length, 1);
  world.updateBullets(.1);
  assert.equal(world.drainEvents().filter(e => e.type === 'treeDied').length, 0);
});

test('damage below the retained main-stage coefficient scale cannot erode high HP', () => {
  const { world, target } = targetWorld();
  strike(world, 1, 1);
  assert.equal(target.health.toString(), '2200', '22e2 - 0e2');
  assert.equal(target.healthPrecision, 2);
  assert.equal(target.alive, true);
});

test('main critical bullets use the native integer percent arithmetic before health subtraction', () => {
  const { world, target } = targetWorld();
  const events = strike(world, 1010, 3, true);
  const hit = events.find(e => e.type === 'hit');
  assert.equal(hit.critical, true);
  assert.equal(hit.damage.toString(), '1260', '1010(p3) * int125 / int100, not exact 1262.5');
  assert.equal(target.health.toString(), '940');
  assert.equal(world.bullets[0].damagePrecision, 3);
});

test('first-stage serialized reward precision survives a real kill and compounded coin bonuses', () => {
  const { BattleSession } = require('./.build/session/session/BattleSession.js');
  const session = new BattleSession({ environment: 'test' });
  session.configureRebirthTest({ levels: [0, 0, 5] });
  assert.equal(session.purchase('money'), true);
  assert.equal(session.purchase('money'), true);
  const { world, target } = targetWorld(0);
  const events = strike(world, 250, 3);
  const paid = session.consume(events, [target]);
  assert.equal(paid.length, 1);
  // 20.000(p5) * 116(p3) / 100 * 127(p3) / 100 = 29.464(p5).
  assert.equal(paid[0].amount.toString(), '29.464', 'the old missing p5 reduced the reward to 29.4');
  assert.equal(session.consume(events, [target]).length, 0);
});
