const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, COMBAT_CONFIG: C, createStageDefinition, DecimalAmount: D } = require('./.build/core/index.js');

// Main and SpeedRun intentionally differ from the source's automatic retarget
// priority: finish a usable current target, and move toward the target being shot.
const modes = [undefined, 'main', 'arena'];
const label = mode => mode ?? 'legacy Main';
function tree(id, x, z) {
  return { id, position: { x: x + 2, z: z - 2 }, degree: 0, stageIndex: 0,
    alive: true, health: D.from(1000000), maxHealth: D.from(1000000), reward: D.from(1),
    collider: { minX: x - 3, maxX: x + 3, minZ: z - 3, maxZ: z + 3 } };
}
function place(target, x, z) {
  target.position = { x: x + 2, z: z - 2 };
  target.collider = { minX: x - 3, maxX: x + 3, minZ: z - 3, maxZ: z + 3 };
}
function fixture(mode, ...trees) {
  const world = new CombatWorld(42, { stageIndex: 0, waveIndex: 0, skinIndex: 0, trees,
    mapLayout: mode, spawnPosition: { x: 0, z: 0 }, bulletWalls: [],
    bounds: { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity } });
  world.setViewport(4);
  return world;
}
function sameTarget(world, target, reason) {
  assert.equal(world.player.targetId, target.id, `${reason}: attack`);
  assert.equal(world.lockedAttackTargetId, target.id, `${reason}: lock`);
  assert.equal(world.autoTargetId, target.id, `${reason}: movement`);
}

for (const mode of modes) {
  test(`${label(mode)} keeps attacking its live lock through repeated ray and automatic searches`, () => {
    const locked = tree(1, 0, 18), nearer = tree(2, 8, 0);
    const world = fixture(mode, locked);
    world.step(.001);
    sameTarget(world, locked, 'initial acquisition');
    world.trees.push(nearer); world.stats.totalTrees++;
    assert.equal(world.findAutoTarget().id, nearer.id, 'the new candidate really has a better automatic score');
    assert.equal(world.findRayTarget().id, nearer.id, 'the new candidate is also the nearer ray result');
    for (let frame = 0; frame < 180; frame++) {
      world.step(1 / 60); world.drainEvents();
      assert.ok(locked.alive && world.isValidTarget(locked) && world.targetRange(locked) <= C.attackRange);
      sameTarget(world, locked, `frame ${frame}`);
    }
    assert.ok(world.stats.shots >= 4, 'actual attacks must continue while the alternative is available');
  });

  for (const invalidation of ['death', 'removal', 'off-screen', 'out-of-range']) {
    test(`${label(mode)} replaces its lock immediately after ${invalidation} and moves toward the new attack target`, () => {
      const old = tree(1, 0, 18), next = tree(2, -18, 0);
      const world = fixture(mode, old);
      world.step(.001);
      sameTarget(world, old, 'initial acquisition');
      world.trees.push(next); world.stats.totalTrees++;
      if (invalidation === 'death') { old.alive = false; old.health = D.from(0); }
      if (invalidation === 'removal') world.trees.splice(world.trees.indexOf(old), 1);
      if (invalidation === 'off-screen') {
        place(old, 25, 25); world.setViewport(9 / 16);
        assert.equal(world.isVisible(old), false);
        assert.ok(world.targetRange(old) < C.attackRange, 'visibility alone must invalidate the lock');
      }
      if (invalidation === 'out-of-range') {
        place(old, 42, 0);
        assert.equal(world.isVisible(old), true);
        assert.ok(world.targetRange(old) > C.attackRange, 'range alone must invalidate the lock');
      }
      world.autoSearchTimer = world.attackSearchTimer = 0;
      world.step(.001);
      sameTarget(world, next, 'replacement before either periodic timer expires');
      assert.equal(world.player.moving, true);
      assert.ok(world.player.velocity.x < 0, 'movement must already head toward the replacement on the same frame');
    });
  }

  test(`${label(mode)} acquires its first movement and attack target on the same frame`, () => {
    const next = tree(1, 20, 0), world = fixture(mode, next);
    world.step(.001);
    sameTarget(world, next, 'first Update');
    assert.equal(world.player.moving, true);
    assert.ok(world.player.velocity.x > 0);
  });

  test(`${label(mode)} approaches a distant or off-screen target without firing at an invalid old reference`, () => {
    for (const distant of [tree(2, 42, 0), tree(2, 25, 25)]) {
      const old = tree(1, 0, 18), world = fixture(mode, old);
      world.step(.001);
      old.alive = false; old.health = D.from(0);
      world.trees.push(distant); world.stats.totalTrees++;
      if (distant.position.z > 0) world.setViewport(9 / 16);
      world.attackClock = C.attackInterval;
      world.autoSearchTimer = world.attackSearchTimer = 0;
      world.step(.001);
      assert.equal(world.autoTargetId, distant.id, 'a remote destination still permits automatic approach');
      assert.equal(world.player.targetId, null);
      assert.equal(world.lockedAttackTargetId, null);
      assert.equal(world.player.moving, true);
      assert.equal(world.stats.shots, 0, 'a ready weapon must not fire at the stale dead reference');
    }
  });

  test(`${label(mode)} manual input can change target and releasing input retains that valid target`, () => {
    const old = tree(1, -12, 0), manual = tree(2, 0, 10);
    const world = fixture(mode, old);
    world.step(.001);
    world.trees.push(manual); world.stats.totalTrees++;
    assert.equal(world.findAutoTarget().id, old.id, 'the original target remains the automatic scoring winner');
    world.previouslyHadTarget = true; world.attackClock = .2;
    world.attackSearchTimer = C.attackSearchInterval;
    world.setMovementInput({ x: 1, y: 0 });
    world.step(.001);
    assert.equal(world.player.targetId, manual.id);
    assert.equal(world.lockedAttackTargetId, manual.id);
    assert.equal(world.autoTargetId, null);
    assert.ok(Math.abs(world.attackClock - .201) < 1e-9);
    world.setMovementInput({ x: 0, y: 0 });
    world.step(.001);
    sameTarget(world, manual, 'manual release');
    assert.ok(Math.abs(world.attackClock - .202) < 1e-9, 'target ownership changes must not restart cooldown');
    for (let frame = 0; frame < 30; frame++) {
      world.step(1 / 60); world.drainEvents();
      sameTarget(world, manual, `post-release frame ${frame}`);
    }
  });
}

test('real fifth-wave seed never abandons a usable live lock while combat continues', () => {
  // Before retention, this seed dropped tree 111 at 179.7167 s with 350 HP,
  // changed its destination to 100, and changed attack target one frame later.
  // Exercise full movement, collisions, weapon hits, deaths and periodic scans.
  const world = new CombatWorld(1, createStageDefinition(0, 4, 1));
  let retainedFrames = 0;
  for (let frame = 0; frame < 180 * 60; frame++) {
    const previous = world.trees.find(target => target.id === world.lockedAttackTargetId);
    world.step(1 / 60); world.drainEvents();
    if (previous?.alive && world.isValidTarget(previous) && world.targetRange(previous) <= C.attackRange) {
      retainedFrames++;
      sameTarget(world, previous, `frame ${frame}: still-usable tree ${previous.id}`);
    }
    if (world.player.targetId !== null) assert.equal(world.autoTargetId, world.player.targetId, `frame ${frame}: movement/attack`);
  }
  assert.ok(retainedFrames > 1000, 'the run must exercise sustained live locks');
  assert.ok(world.stats.shots > 100 && world.stats.kills > 10, 'retention must not stall actual combat');
});
