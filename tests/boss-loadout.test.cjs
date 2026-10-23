const test = require('node:test');
const { assert, fixture, enter, win, exit } = require('./support/boss-session-fixture.cjs');
function loadoutFixture({ weaponId = 0, gold = [0, 0, 0], rebirth = [0, 0, 0], stars = [0, 0, 0], gap = false } = {}) {
  const f = fixture(); const saved = JSON.parse(f.data.get(f.key));
  saved.levels = gold; saved.rebirth.levels = rebirth; saved.weapons.starLevels = stars;
  saved.weapons.collection[weaponId] = true; saved.weapons.equipment[0].weaponId = weaponId;
  if (gap) { saved.weapons.equipment[1] = saved.weapons.equipment[0]; saved.weapons.equipment[0] = null; }
  f.data.set(f.key, JSON.stringify(saved)); return f.restore();
}

test('Boss excludes all gold attack/speed levels while preserving normal-mode loadout on exit', () => {
  const base = loadoutFixture(), upgraded = loadoutFixture({ gold: [150, 150, 150] });
  const mainDamage = upgraded.getLoadout()[0].damage; const mainSpeed = upgraded.getLoadout()[0].attackInterval;
  assert.ok(mainDamage.compare(base.getLoadout()[0].damage) > 0);
  enter(base); enter(upgraded);
  assert.equal(upgraded.getLoadout()[0].damage.compare(base.getLoadout()[0].damage), 0);
  assert.equal(upgraded.getLoadout()[0].damagePrecision, base.getLoadout()[0].damagePrecision);
  assert.equal(upgraded.getLoadout()[0].attackInterval, base.getLoadout()[0].attackInterval);
  assert.equal(upgraded.combatModifiers.damage.compare(base.combatModifiers.damage), 0);
  for (const kind of ['power', 'speed', 'money']) assert.equal(upgraded.purchase(kind), false);
  win(upgraded); assert.equal(upgraded.purchase('power'), false); exit(upgraded);
  assert.equal(upgraded.getLoadout()[0].damage.compare(mainDamage), 0); assert.equal(upgraded.getLoadout()[0].attackInterval, mainSpeed);
});

test('Boss skips even the gold level-zero precision promotion before rebirth and compact actor stars', () => {
  const session = loadoutFixture({ weaponId: 16, rebirth: [5, 0, 0] });
  assert.equal(session.getLoadout()[0].damage.toString(), '1016'); enter(session);
  assert.equal(session.getLoadout()[0].damage.toString(), '1010');
  assert.equal(session.getLoadout()[0].damagePrecision, 3);
  const starred = loadoutFixture({ weaponId: 16, rebirth: [5, 0, 0], stars: [1, 20, 0], gap: true }); enter(starred);
  const actor = starred.getLoadout()[0]; assert.equal(actor.actorIndex, 0); assert.equal(actor.starLevel, 1);
  assert.equal(actor.damage.toString(), '1510', 'p3 stars truncate 1010*150 before dividing by 100');
  assert.equal(actor.damagePrecision, 3); assert.equal(starred.getLoadout().length, 1);
});

test('Boss rebirth speed begins above level 20, follows native float arithmetic and clamps its interval', () => {
  for (const [level, percent] of [[0, 100], [19, 100], [20, 100], [21, 105], [20000, 10000]]) {
    const session = loadoutFixture({ gold: [0, 500, 0], rebirth: [0, level, 0] });
    session.configureProgressionTest({ stageIndex: 100, stageValueMax: 1010 }); enter(session);
    const actor = session.getLoadout()[0], expected = Math.max(Math.fround(.05), Math.min(2,
      Math.fround(Math.fround(actor.weapon.attackInterval / percent) * 100)));
    assert.equal(actor.attackInterval, expected, `rebirth speed level ${level}`);
    assert.equal(session.round.movementMultiplier, 1, 'Main replay speed is excluded');
  }
});
