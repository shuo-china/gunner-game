const test = require('node:test');
const assert = require('node:assert/strict');
const { HuntCombat, HUNT_CENTER } = require('./.build/core/HuntCombat.js');
const { DecimalAmount: D } = require('./.build/core/DecimalAmount.js');
const { HUNT_RULES: H } = require('./.build/core/HuntBalance.js');
const close = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const living = hunt => hunt.enemies.filter(e => e.alive);
const kill = (hunt, enemy) => hunt.hit(enemy.id, enemy.maxHealth, enemy.healthPrecision);

test('Hunt starts explicitly, spawns immediately and uses post-spawn active count for sparse cadence', () => {
  const hunt = new HuntCombat();
  assert.equal(hunt.enemies.length, 240); assert.equal(hunt.activeCount, 0); assert.equal(hunt.running, false);
  hunt.update(100); assert.equal(hunt.spawned, 0);
  hunt.startLevel(); assert.equal(hunt.spawned, 1);
  hunt.update(.039); assert.equal(hunt.spawned, 1); hunt.update(.001); assert.equal(hunt.spawned, 2);
  hunt.update(.04); assert.equal(hunt.spawned, 3);
  hunt.update(.349); assert.equal(hunt.spawned, 3); hunt.update(.001); assert.equal(hunt.spawned, 4);
  hunt.update(10); assert.equal(hunt.spawned, 5, 'WaitForSeconds has one resumption per rendered frame');
});

test('five sublevels finish only after their kill target and the coroutine resumes; progress stays session-owned', () => {
  const hunt = new HuntCombat(2, 0, 99);
  for (let level = 0; level < 5; level++) {
    hunt.startLevel(2, level);
    for (let i = 0; i < H.targetCounts[level]; i++) {
      assert.equal(hunt.activeCount, 1);
      const monster = living(hunt)[0]; kill(hunt, monster);
      assert.equal(hunt.hit(monster.id, D.from(99999)).defeated, false, 'death is idempotent');
      assert.equal(hunt.completed, false, 'last damage does not skip coroutine waiting');
      hunt.update(.04);
    }
    assert.equal(hunt.completed, true); assert.equal(hunt.failed, false); assert.equal(hunt.running, false);
    assert.equal(hunt.wave, 2); assert.equal(hunt.level, level); assert.equal(hunt.kills, hunt.total);
    const events = hunt.drainEvents();
    assert.equal(events.filter(e => e.type === 'huntMonsterDied').length, hunt.total);
    assert.equal(events.filter(e => e.type === 'huntLevelComplete').length, 1);
    assert.equal(events.at(-1).wave, 2); assert.equal(events.at(-1).level, level);
    hunt.update(100); assert.deepEqual(hunt.drainEvents(), []);
  }
});

test('240 source colliders are recycled FIFO by death order while visual generation increments', () => {
  const hunt = new HuntCombat(0, 4); hunt.startLevel();
  while (hunt.spawned < 240) hunt.update(1);
  assert.equal(hunt.activeCount, 240);
  const first = hunt.enemies[22], second = hunt.enemies[4], shape = first.capsuleCollider;
  kill(hunt, first); kill(hunt, second);
  hunt.startLevel(1, 0);
  assert.equal(living(hunt)[0], first); assert.equal(first.spawnGeneration, 2);
  assert.equal(first.capsuleCollider, shape); assert.equal(first.id, 4000022);
  hunt.update(.04); assert.equal(second.alive, true); assert.equal(second.spawnGeneration, 2);
});

test('birth follows the original rotated ellipse and resizing affects future monsters only', () => {
  const hunt = new HuntCombat(0, 0, 1, .5);
  // Deterministic source RNG samples: angle pi/2, zero radial jitter, normal monster.
  hunt.random = { range: (min, max) => min === 0 ? Math.PI / 2 : 0, next: () => 1 };
  hunt.startLevel();
  const first = living(hunt)[0], initial = { ...first.position }, k = .7071067690849304;
  close(first.position.x, -100 - 60 * k); close(first.position.z, 60 * k);
  close(Math.hypot(first.velocity.x, first.velocity.z), (Math.hypot(initial.x + 100, initial.z) - 20) / 37.5);
  hunt.random = { range: (min, max) => 0, next: () => 1 };
  hunt.update(.04); const narrow = living(hunt)[1]; close(narrow.position.x, -100 + 30 * k);
  hunt.setAspect(2); hunt.update(.04); const wide = living(hunt)[2]; close(wide.position.x, -100 + 60 * k);
  assert.deepEqual(first.position, initial, 'aspect change does not move existing monsters');
});

test('large monsters vary sprite/health/speed only, preserving their original capsule', () => {
  for (let level = 0; level < 5; level++) {
    const hunt = new HuntCombat(2, level);
    hunt.random = { range: () => 0, next: () => level * .2 + .0001 }; hunt.startLevel();
    const normal = living(hunt)[0]; assert.equal(normal.large, false); assert.equal(normal.health.toString(), '4500');
    hunt.random = { range: () => 0, next: () => level * .2 }; hunt.update(.04);
    const large = living(hunt)[1]; assert.equal(large.large, true); assert.equal(large.health.toString(), '13000');
    assert.equal(normal.skinIndex, 4); assert.equal(large.skinIndex, 5); assert.equal(large.visualScale, 1.5);
    assert.deepEqual(large.collider, normal.collider); assert.deepEqual(large.capsuleCollider, normal.capsuleCollider);
    close(Math.hypot(large.velocity.x, large.velocity.z) / Math.hypot(normal.velocity.x, normal.velocity.z), .75);
  }
});

test('damage-proportional knockback restarts and blends back into the original inward velocity', () => {
  const hunt = new HuntCombat(); hunt.startLevel(); const enemy = living(hunt)[0], inward = { ...enemy.velocity };
  const result = hunt.hit(enemy.id, D.from(100), 3);
  assert.equal(result.health.toString(), '400'); close(enemy.knockbackDuration, .11);
  close(Math.hypot(enemy.velocity.x, enemy.velocity.z), 4);
  const outward = { ...enemy.velocity }; hunt.update(.055);
  close(enemy.velocity.x, (outward.x + inward.x) / 2); close(enemy.velocity.z, (outward.z + inward.z) / 2);
  hunt.hit(enemy.id, D.from(50), 2); close(enemy.knockbackDuration, .08); assert.equal(enemy.knockbackElapsed, 0);
  hunt.update(.08); close(enemy.velocity.x, inward.x); close(enemy.velocity.z, inward.z);
  hunt.hit(enemy.id, D.from(1), 1); hunt.stopMotion();
  const position = { ...enemy.position }; hunt.fixedStep(20); hunt.update(20);
  assert.deepEqual(enemy.position, position); assert.deepEqual(enemy.velocity, { x: 0, z: 0 });
});

test('barrier uses sphere15 and vertical capsule contact, never the speed reference radius20 or big artwork', () => {
  const hunt = new HuntCombat(); hunt.startLevel(); const enemy = living(hunt)[0]; enemy.large = true;
  enemy.velocity = { x: 0, z: 0 };
  for (const d of [20, 17.1, 17.0]) {
    enemy.position = { x: HUNT_CENTER.x + d, z: 0 }; hunt.fixedStep(.02);
    assert.equal(hunt.failed, false, `distance ${d}`);
  }
  enemy.position.x = HUNT_CENTER.x + 16.95; hunt.fixedStep(.02);
  assert.equal(hunt.failed, true); assert.equal(hunt.barrierHp, 0); assert.equal(hunt.kills, 0); assert.equal(enemy.alive, false);
  const events = hunt.drainEvents(); assert.equal(events.length, 1); assert.equal(events[0].type, 'huntFailed');
  hunt.fixedStep(20); assert.deepEqual(hunt.drainEvents(), []);
});

test('invasion replacement does not count as a kill/nominal spawn, and next level never restores barrier HP', () => {
  const hunt = new HuntCombat(); hunt.startLevel(); hunt.barrierHp = 3;
  const enemy = living(hunt)[0]; enemy.position = { ...HUNT_CENTER }; hunt.fixedStep(.02);
  assert.equal(hunt.barrierHp, 2); assert.equal(hunt.kills, 0); assert.equal(hunt.spawned, 1);
  hunt.update(.04); assert.equal(hunt.spawned, 1); assert.equal(hunt.activeCount, 1);
  hunt.update(.04); assert.equal(hunt.spawned, 2); assert.equal(hunt.activeCount, 2);
  hunt.startLevel(0, 1); assert.equal(hunt.barrierHp, 2); assert.equal(hunt.kills, 0);
});
