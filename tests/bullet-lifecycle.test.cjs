const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, COMBAT_CONFIG: C, treeCollider } = require('./.build/core/index.js');

const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const emptyWorld = (seed = 71) => {
  const world = new CombatWorld(seed);
  world.trees.length = 0;
  world.stats.complete = true;
  return world;
};
const fire = world => {
  assert.equal(world.fire(), true);
  const event = world.drainEvents().find(event => event.type === 'shot');
  assert.ok(event);
  return world.bullets[event.bulletId];
};

test('the source pool has 27 slots and advances its cursor past returned objects', () => {
  const world = emptyWorld();
  assert.equal(C.bulletPoolSize, 27);
  assert.equal(world.bullets.length, 27);
  assert.equal(fire(world).id, 0);
  assert.equal(fire(world).id, 1);
  world.clearBullet(world.bullets[0]);
  assert.equal(fire(world).id, 2, 'an earlier free slot must not reset the round-robin cursor');
  world.reset();
  assert.equal(fire(world).id, 0, 'restart resets the pool cursor');
});

test('smart pooling prefers inactive slots and only then reclaims dead trails', () => {
  const world = emptyWorld();
  for (let i = 0; i < 27; i++) fire(world);
  const trail = world.bullets[0];
  world.stopBullet(trail);
  world.clearBullet(world.bullets[5]);
  assert.equal(fire(world).id, 5, 'the complete inactive pass precedes the dead-trail pass');
  assert.equal(trail.damaging, false);
  world.step(0.31);
  const reused = fire(world);
  assert.equal(reused.id, 0);
  assert.equal(reused.active, true);
  assert.equal(reused.damaging, true);
  assert.equal(reused.age, 0);
  assert.equal(reused.trailTime, 0);
  assert.equal(reused.traveled, 0);
  // The reclaimed trail's previous Invoke must not deactivate its new flight.
  world.step(0.32);
  world.step(0.32);
  assert.equal(reused.damaging, true);
  world.step(0.06);
  assert.equal(reused.damaging, false);
  assert.equal(reused.active, true);
  near(reused.trailTime, 1);
});

test('linear expiry and delayed deactivation use frame time rather than a count of physics steps', () => {
  const world = emptyWorld();
  world.step(0.007); // Give the firing time a different phase from fixed physics.
  const bullet = fire(world);
  for (let frame = 0; frame < 83; frame++) world.step(1 / 120);
  assert.equal(bullet.damaging, true);
  world.step(1 / 120);
  assert.equal(bullet.damaging, false, 'Invoke(Destroy, 0.7) expires on this frame');
  assert.equal(bullet.active, true);
  assert.ok(bullet.age < 0.7, 'the source rational physics step has not accumulated a full 0.7 seconds');
  const stopped = { ...bullet.position };
  for (let frame = 0; frame < 119; frame++) world.step(1 / 120);
  assert.equal(bullet.active, true);
  assert.deepEqual(bullet.position, stopped);
  world.step(1 / 120);
  assert.equal(bullet.active, false, 'Invoke(Deactivate, 1) does not wait for the next physics tick');
  assert.deepEqual(world.drainEvents(), [], 'an expired normal round does not spawn an explosion');
});

test('a hit cancels the original expiry and starts a fresh one-second deactivation delay', () => {
  const world = emptyWorld();
  const bullet = fire(world);
  world.step(0.2);
  world.stopBullet(bullet);
  const stopped = { ...bullet.position };
  world.step(0.3); world.step(0.3); // Past the original flight deadline of 0.7.
  assert.equal(bullet.active, true);
  assert.equal(bullet.damaging, false);
  near(bullet.trailTime, 0.4);
  world.stopBullet(bullet); // DieAndWait has an is_Die guard.
  world.step(0.3); world.step(0.1);
  assert.equal(bullet.active, false, 'duplicate death calls must not extend the release timer');
  assert.notDeepEqual(stopped, { x: 0, z: 0 });
});

test('a full live pool still consumes critical and spread random samples without growing spread', () => {
  const world = emptyWorld();
  for (const bullet of world.bullets) { bullet.active = true; bullet.damaging = true; }
  const samples = [];
  world.random = { next: () => { samples.push('critical'); return 0.5; }, range: (low, high) => { samples.push([low, high]); return 0; } };
  world.spread = 3;
  assert.equal(world.fire(), false);
  assert.deepEqual(samples, ['critical', [-3, 3]]);
  assert.equal(world.spread, 3);
  assert.equal(world.stats.shots, 0);
  assert.deepEqual(world.drainEvents(), []);
  assert.equal(world.bulletPoolCursor, 0, 'an unsuccessful scan leaves the pool cursor alone');
});

test('pool exhaustion retries next Update instead of waiting another complete cooldown', () => {
  const world = new CombatWorld(91);
  const position = { x: 2, z: 10 };
  world.trees.splice(0, world.trees.length, { id: 1000, degree: 0, position,
    collider: treeCollider(position), health: 1000000, maxHealth: 1000000, alive: true });
  world.stats.totalTrees = 1;
  world.autoTargetId = world.lockedAttackTargetId = world.player.targetId = 1000;
  world.previouslyHadTarget = true;
  world.attackClock = 0.59;
  // Stationary live rounds outside the scene isolate pool exhaustion from hits.
  for (const bullet of world.bullets) Object.assign(bullet, { active: true, damaging: true,
    position: { x: 1000, z: 1000 }, direction: { x: 0, z: 0 } });
  world.step(0.02);
  assert.equal(world.stats.shots, 0);
  near(world.attackClock, 0.58);
  world.stopBullet(world.bullets[13]);
  world.step(0.02);
  const shot = world.drainEvents().find(event => event.type === 'shot');
  assert.ok(shot);
  assert.equal(shot.bulletId, 13);
  assert.equal(world.attackClock, 0);
});

test('lethal damage disables the tree immediately and the same bullet cannot deal damage twice', () => {
  const world = emptyWorld();
  const tree = { id: 1000, degree: 0, position: { x: 2, z: 10 },
    collider: { minX: -3, maxX: 3, minZ: 9, maxZ: 15 }, health: 50, maxHealth: 50, alive: true };
  world.trees.push(tree);
  world.stats.totalTrees = 1;
  const bullet = fire(world);
  for (let i = 0; i < 8; i++) world.step(C.physicsStep);
  assert.equal(tree.alive, false);
  assert.equal(bullet.damaging, false);
  assert.equal(world.stats.hits, 1);
  assert.equal(world.stats.kills, 1);
  const events = world.drainEvents();
  assert.deepEqual(events.map(event => event.type), ['hit', 'treeDied', 'complete', 'impact']);
  world.step(0.2);
  assert.equal(world.stats.hits, 1);
  assert.deepEqual(world.drainEvents(), []);
});

test('each existing map wall stops a normal round and spawns its closest-point effect without damage', () => {
  const cases = [
    { origin: { x: 0, z: -26 }, direction: { x: 0, z: -1 }, impact: { x: 0, z: -27.5 } },
    { origin: { x: 0, z: 106 }, direction: { x: 0, z: 1 }, impact: { x: 0, z: 107.5 } },
    { origin: { x: -26, z: 50 }, direction: { x: -1, z: 0 }, impact: { x: -27.500150680541992, z: 50 } },
    { origin: { x: 26, z: 50 }, direction: { x: 1, z: 0 }, impact: { x: 27.499900817871094, z: 50 } },
  ];
  for (const sample of cases) {
    const world = emptyWorld();
    world.player.aim = sample.direction;
    world.setMuzzleOffset(sample.origin);
    const bullet = fire(world);
    world.step(C.physicsStep);
    assert.equal(bullet.damaging, false);
    assert.deepEqual(world.drainEvents(), [{ type: 'impact', position: sample.impact, radius: 0, height: 2, sourceTime: C.physicsStep,
      bulletId: bullet.id, actorId: 0, weaponId: 0, weaponType: 'SINGLE', critical: false }]);
    assert.equal(world.stats.hits, 0);
    assert.equal(world.stats.kills, 0);
    world.step(C.physicsStep);
    assert.deepEqual(world.drainEvents(), [], 'disabled bullet colliders do not repeatedly impact a wall');
  }
});

test('a wall in front of a tree blocks the bullet but stays excluded from target raycasts', () => {
  const world = emptyWorld();
  const position = { x: 35, z: 0 };
  const tree = { id: 1000, degree: 0, position,
    collider: treeCollider(position), health: 250, maxHealth: 250, alive: true };
  world.trees.push(tree);
  world.isVisible = () => true;
  assert.equal(world.findRayTarget()?.id, 1000, 'the attack ray mask contains enemies, not Default-layer walls');
  world.player.aim = { x: 1, z: 0 };
  world.setMuzzleOffset({ x: 26, z: 0 });
  fire(world);
  world.step(C.physicsStep);
  assert.deepEqual(world.drainEvents().map(event => event.type), ['impact']);
  assert.equal(tree.health, 250);
  assert.equal(world.stats.hits, 0);
});

test('hit timestamps identify their fixed step while the frame clock keeps advancing after completion', () => {
  const world = emptyWorld();
  const tree = { id: 1000, degree: 0, position: { x: 2, z: 10 },
    collider: { minX: -3, maxX: 3, minZ: 9, maxZ: 15 }, health: 50, maxHealth: 50, alive: true };
  world.trees.push(tree);
  world.stats.totalTrees = 1;
  fire(world);
  // Five physics steps move from z1.8 through the near face at z9-radius0.6.
  world.step(0.113);
  const hit = world.drainEvents().find(event => event.type === 'hit');
  assert.ok(hit);
  near(hit.sourceTime, 5 * (2822399 / 141120000));
  near(world.simulationTime, 0.113);
  assert.ok(hit.sourceTime < world.simulationTime);
  assert.equal(world.stats.elapsed, 0);
  world.step(0.01);
  near(world.simulationTime, 0.123);
  world.pause(); world.step(0.2);
  near(world.simulationTime, 0.123);
  world.resume(); world.step(0.01);
  near(world.simulationTime, 0.133);
  world.reset();
  assert.equal(world.simulationTime, 0);
});
