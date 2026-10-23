const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, DecimalAmount: D, COMBAT_CONFIG: C, treeCollider } = require('./.build/core/index.js');
const { BattleSession } = require('./.build/session/session/BattleSession.js');

function targetWorld() {
  const world = new CombatWorld(73);
  world.player.position = { x: 0, z: 0 };
  // The center is (0,10), safely outside the player's stop distance.
  const position = { x: 2, z: 8 };
  world.trees.splice(0, world.trees.length, { id: 0, position, degree: 0, alive: true,
    health: 100000, maxHealth: 100000, collider: treeCollider(position) });
  world.stats.totalTrees = 1;
  world.player.aim = { x: 0, z: 1 };
  world.setMuzzleOffset({ x: 0, z: 0 });
  return world;
}

test('source damage truncates the global-upgraded base before applying slot stars, including reload', () => {
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const session = new BattleSession({ environment: 'test', storage });
  assert.equal(session.weapons.grantTestWeapon(1).ok, true);
  assert.equal(session.weapons.equip(0, 0).ok, true);
  assert.equal(session.combatLoadout[0].damage.toNumber(), 80);
  assert.equal(session.purchase('power'), true);
  assert.equal(session.combatLoadout[0].damage.toNumber(), 86, '80 * 108% discards .4 before stars');
  assert.equal(session.weapons.configureTest({ starLevels: [1, 0, 0] }).ok, true);
  assert.equal(session.combatLoadout[0].damage.toNumber(), 129, '86 * 150% is 129, not 129.6');
  assert.equal(new BattleSession({ environment: 'test', storage }).combatLoadout[0].damage.toNumber(), 129);
  const world = targetWorld(); world.setLoadout(session.combatLoadout); world.fire();
  session.weapons.configureTest({ starLevels: [2, 0, 0] });
  world.setLoadout(session.combatLoadout);
  assert.equal(world.bullets[0].damage.toNumber(), 129, 'star change preserves a fired bullet snapshot');
});

test('projectiles retain shot-time damage when attack power changes in flight', () => {
  const world = targetWorld();
  assert.equal(world.fire(), true);
  const first = world.bullets[0];
  world.setCombatModifiers({ damage: D.from(108), attackInterval: .6 });
  assert.equal(world.fire(), true);
  assert.equal(first.damage.compare(100), 0);
  assert.equal(world.bullets[1].damage.compare(108), 0);
  // Use the real fixed-step collision path, independent of auto-fire.
  world.updateBullets(.2);
  const hits = world.drainEvents().filter(event => event.type === 'hit');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(event => event.damage.toNumber()), [100, 108]);
  assert.equal(Number(world.trees[0].health), 100000 - 208);
});

test('updating speed preserves accrued cooldown, changes shot cadence and spread together', () => {
  const world = targetWorld();
  world.step(.1);
  const before = world.attackClock;
  const initialSpread = world.maximumSpread;
  world.spread = 4;
  world.setCombatModifiers({ damage: D.from(100), attackInterval: .05 });
  assert.equal(world.attackClock, before);
  assert.equal(world.spread, 0, 'Balance_Reload resets spread for every successful upgrade');
  assert.ok(world.maximumSpread > initialSpread);
  const beforeShots = world.stats.shots;
  world.step(1 / 60);
  assert.equal(world.stats.shots, beforeShots + 1);
  const faster = targetWorld(), base = targetWorld();
  faster.setCombatModifiers({ damage: D.from(100), attackInterval: .05 });
  for (let frame = 0; frame < 180; frame++) { faster.step(1 / 60); base.step(1 / 60); }
  assert.ok(faster.stats.shots > base.stats.shots * 5);
  faster.reset();
  assert.equal(faster.attackInterval, .05, 'round resets preserve upgrades');
});

test('cooldown remains in source bounds and invalid modifiers do not change combat state', () => {
  const world = targetWorld();
  world.setCombatModifiers({ damage: D.from(100), attackInterval: .0001 });
  assert.equal(world.attackInterval, .05);
  world.setCombatModifiers({ damage: D.from(100), attackInterval: 3 });
  assert.equal(world.attackInterval, 2);
  assert.throws(() => world.setCombatModifiers({ damage: D.from(100), attackInterval: NaN }));
  assert.throws(() => world.setCombatModifiers({ damage: D.from(0), attackInterval: C.attackInterval }));
  assert.equal(world.attackInterval, 2);
});

test('damage above JS number range kills once and remains exact in the hit event', () => {
  const world = targetWorld();
  const huge = D.from('1.23e330');
  world.setCombatModifiers({ damage: huge, attackInterval: C.attackInterval });
  world.fire(); world.updateBullets(.2);
  const events = world.drainEvents();
  assert.equal(Number(world.trees[0].health), 0);
  assert.equal(events.filter(e => e.type === 'treeDied').length, 1);
  assert.equal(events.find(e => e.type === 'hit').damage.compare(huge), 0);
  assert.equal(world.stats.kills, 1);
  world.updateBullets(.2);
  assert.equal(world.drainEvents().length, 0);
});
