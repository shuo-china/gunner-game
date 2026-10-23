const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, DecimalAmount: D, SIMULATION_CONFIG } = require('./.build/core/index.js');
const { getWeapon } = require('./.build/core/WeaponCatalog.js');

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function fixture(type, targetZ = 5) {
  const world = new CombatWorld(42);
  world.setLoadout([{ actorIndex: 0, weapon: { ...getWeapon(0), type, explosionRadius: 4, missileExplosionRadius: 4 },
    damage: D.from(100), attackInterval: 1000 }]);
  const target = { id: 1, position: { x: 0, z: targetZ }, degree: 0, stageIndex: 0, reward: D.from(20),
    health: D.from(1000), maxHealth: D.from(1000), alive: true,
    collider: { minX: -.5, maxX: .5, minZ: targetZ - .5, maxZ: targetZ + .5 } };
  world.trees.splice(0, world.trees.length, target);
  world.stats.totalTrees = 1;
  world.player.position = { x: 0, z: 0 };
  world.player.velocity = { x: 0, z: 0 };
  world.player.aim = { x: 0, z: 1 };
  world.setMuzzleOffset({ x: 0, z: 0 });
  assert.equal(world.fire(), true);
  const bullet = world.bullets.find(item => item.active);
  bullet.direction = { x: 0, z: 1 };
  world.drainEvents();
  return { world, bullet };
}

function feedback(world) {
  const events = world.drainEvents();
  const impact = events.find(event => event.type === 'impact');
  const damage = events.find(event => event.type === 'hit' || event.type === 'damageText');
  assert.ok(impact, 'the real simulation emits an impact');
  assert.ok(damage, 'the same collision emits its damage feedback');
  return { impact, damage };
}

for (const advance of ['step', 'advanceEffects']) {
  test(`${advance}: collision impact and damage retain the fixed tick within a longer render frame`, () => {
    const { world } = fixture('SINGLE');
    world[advance](.075);
    const { impact, damage } = feedback(world);
    close(impact.sourceTime, SIMULATION_CONFIG.physicsStep * 3);
    close(damage.sourceTime, impact.sourceTime);
    assert.ok(impact.sourceTime < world.simulationTime);
  });

  test(`${advance}: missile impact and damage use the Update frame time after fixed steps`, () => {
    const { world, bullet } = fixture('MISSILE');
    bullet.missileTarget = { x: 0, z: 5 };
    bullet.missileDuration = .05;
    bullet.missileArcHeight = 0;
    world[advance](.075);
    const { impact, damage } = feedback(world);
    close(impact.sourceTime, .075);
    close(damage.sourceTime, impact.sourceTime);
  });

  test(`${advance}: an explosive timeout uses frame time even though its weapon normally hits during physics`, () => {
    const { world, bullet } = fixture('EXPLOSIVE', 2);
    bullet.speed = 0;
    world.bulletTimeouts.set(bullet.id, .07);
    world[advance](.075);
    const { impact, damage } = feedback(world);
    close(impact.sourceTime, .075);
    close(damage.sourceTime, impact.sourceTime);
    assert.ok(impact.sourceTime > SIMULATION_CONFIG.physicsStep * 3,
      'timeout callbacks must not reuse the previous physics tick');
  });
}
