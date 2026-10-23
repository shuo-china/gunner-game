const test = require('node:test');
const assert = require('node:assert/strict');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { subtractOriginalHealth } = require('./.build/session/core/OriginalInfVal.js');
const { BattleSession } = require('./.build/session/session/BattleSession.js');
const { CombatWorld, createSpeedRunDefinition } = require('./.build/core/index.js');
const sourcePrecision = require('./fixtures/original-stage-precision.json');

test('the first challenge preserves serialized p5 HP and gold before applying combat modifiers', () => {
  // The shipped scene retains 25000e-2 / 20000e-3; the unused authoring
  // Balance_Reload helper and normalized fixture values hide these zeroes.
  assert.deepEqual(sourcePrecision.fields.Stage_Health_Balance.samples[0], { stageIndex: 0, s_digits: '25000', s_exponent: -2 });
  assert.deepEqual(sourcePrecision.fields.Stage_Money_Balance.samples[0], { stageIndex: 0, s_digits: '20000', s_exponent: -3 });
  const session = new BattleSession({ environment: 'test' });
  session.weapons.grantTestWeapon(1); session.weapons.equip(0, 0);
  session.purchase('power'); session.purchase('money');
  session.configureRebirthTest({ levels: [0, 0, 5] });
  assert.equal(session.getLoadout()[0].damage.toNumber(), 86);
  assert.equal(session.getLoadout()[0].damagePrecision, 2);
  assert.equal(session.startSpeedRun().ok, true); session.advanceFrame(1.5);
  const map = createSpeedRunDefinition(0, 41), target = map.trees.find(tree => tree.degree === 0);
  assert.ok(target); assert.equal(target.healthPrecision, 5); assert.equal(target.rewardPrecision, 5);
  target.position = { x: -100, z: 10 };
  target.collider = { minX: -101, maxX: -99, minZ: 9, maxZ: 11 };
  map.trees = [target];
  const world = new CombatWorld(41, map);
  // Isolate one 86-damage projectile; the replacement D crossbow normally fires two.
  world.setLoadout(session.getLoadout().map(entry => ({ ...entry, weapon: { ...entry.weapon, type: 'SINGLE' } }))); world.setMuzzleOffset({ x: 0, z: 0 }); world.player.aim = { x: 0, z: 1 };
  assert.equal(world.fire(), true); world.updateBullets(.3);
  assert.equal(world.trees[0].health.toString(), '164', 'p5 keeps the whole 86 damage; p2 incorrectly aligned it to 80');
  world.trees[0].alive = false;
  const rewards = session.consume([{ type: 'treeDied', treeId: target.id, position: target.position, sourceTime: .3 }], world.trees);
  assert.equal(rewards[0].amount.toString(), '27.432', '20 × 108% × 127% retains the scene p5, instead of truncating to 27.4');
  for (const tree of createSpeedRunDefinition(1, 41).trees) {
    assert.equal(tree.healthPrecision, tree.degree === 1 ? 17 : 2);
    assert.equal(tree.rewardPrecision, tree.degree === 1 ? 17 : 2);
  }
});

test('challenge HP subtracts aligned source coefficients before the precision cut', () => {
  // Independent arithmetic from InfVal.op_Subtraction: exponent=max(order)+1-p,
  // cut both operands at that exponent, then subtract their integer coefficients.
  for (const [hp, hpPrecision, damage, damagePrecision, expected, precision] of [
    ['2000000', 2, '1', 1, '2000000', 2], // 20e5 - 0e5
    ['1700', 2, '125', 3, '1580', 3], // 170e1 - 12e1, not exact 1575
    ['210000', 2, '1250', 4, '208800', 4], // 2100e2 - 12e2
    ['450', 17, '125.5', 4, '324.5', 17],
    ['250', 2, '250', 3, '0', 3],
    ['250', 2, '300', 3, '0', 3],
  ]) {
    const actual = subtractOriginalHealth(D.from(hp), hpPrecision, D.from(damage), damagePrecision);
    assert.equal(actual.health.toString(), expected, `${hp}(p${hpPrecision}) - ${damage}(p${damagePrecision})`);
    assert.equal(actual.precision, precision);
  }
});

test('the larger damage precision remains on HP for subsequent weaker hits', () => {
  const first = subtractOriginalHealth(D.from(1700), 2, D.from(125), 3);
  const next = subtractOriginalHealth(first.health, first.precision, D.from(10), 2);
  assert.equal(next.health.toNumber(), 1570, 'retained p3 can represent the following ten-damage hit');
  assert.equal(next.precision, 3);
});

test('session preserves post-upgrade and post-star damage precision when exporting a loadout', () => {
  const session = new BattleSession({ environment: 'test' });
  assert.equal(session.getLoadout()[0].damage.toNumber(), 100);
  assert.equal(session.getLoadout()[0].damagePrecision, 3, 'serialized 100 retains p3 despite normalized coefficient 1');
  session.weapons.grantTestWeapon(1); session.weapons.equip(0, 0);
  session.configureRebirthTest({ levels: [1, 0, 0] }); session.purchase('power');
  session.weapons.configureTest({ starLevels: [1, 0, 0] });
  assert.equal(session.startSpeedRun().ok, true); session.advanceFrame(1.5);
  const actor = session.getLoadout()[0];
  assert.equal(actor.damage.toNumber(), 135);
  assert.equal(actor.damagePrecision, 3, 'the star percent table is p2 plus integer 100, producing p3');
});
