const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CombatWorld, COMBAT_CONFIG: C, projectWorld, unprojectGround,
  MANUAL_INPUT_SQUARED_THRESHOLD: manualThreshold } = require(path.resolve(__dirname, './.build/core/index.js'));

// Independent source oracle: original-targeting-position.json, original Cat
// ResolveAttackTarget/IsOnScreen ARM64 and the serialized first-tree collider.
// Main/SpeedRun now deliberately retain a usable attack lock. Tests for the
// original automatic priority use Mine, whose targeting policy is unchanged.
const cameraOffset = { x: 0.07070614888647242, y: -1.093257687919511 };
const approximately = (actual, expected, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const pointEquals = (actual, expected) => {
  assert.ok(actual, 'expected a resolved nearHitPoint');
  approximately(actual.x, expected.x);
  approximately(actual.z, expected.z);
};

function target(id, x, z, alive = true) {
  // Source Coll is offset (-2,0,+2) from Tree_0, with a 6x6x6 box.
  return {
    id, position: { x: x + 2, z: z - 2 }, degree: 0,
    alive, health: alive ? 1000000 : 0, maxHealth: 1000000,
    collider: { minX: x - 3, maxX: x + 3, minZ: z - 3, maxZ: z + 3 },
  };
}

function fixture(...trees) {
  const world = new CombatWorld(42);
  world.trees.splice(0, world.trees.length, ...trees);
  world.stats.totalTrees = trees.length;
  world.player.position = { x: 0, z: 0 };
  world.player.velocity = { x: 0, z: 0 };
  world.player.targetId = null;
  world.autoTargetId = null;
  world.lockedAttackTargetId = null;
  world.nearHitPoint = { x: 0, z: 0 };
  world.setViewport(4); // Separate range/lock tests from portrait camera edges.
  return world;
}

function sourceFixture(...trees) {
  const world = fixture(...trees);
  world.stage.mapLayout = 'mine';
  world.stage.ores = world.trees;
  return world;
}

test('Mine retains the source priority: a valid automatic target overrides a live attack lock', () => {
  const locked = target(1, -10, 0), auto = target(2, 0, 20), ray = target(3, 8, 0);
  const world = sourceFixture(locked, auto, ray);
  world.lockedAttackTargetId = locked.id;
  world.player.targetId = ray.id;
  world.autoTargetId = auto.id;
  world.resolveAttackTarget();
  assert.equal(world.player.targetId, auto.id);
  assert.equal(world.lockedAttackTargetId, auto.id);
  pointEquals(world.nearHitPoint, { x: 0, z: 17 });
  assert.equal(locked.alive, true, 'the source can switch a living lock when its automatic target takes priority');
});

test('Mine retains the source out-of-range automatic priority over a nearer attack lock', () => {
  const nearby = target(1, 10, 0), distantAuto = target(2, 42, 0);
  const world = sourceFixture(nearby, distantAuto);
  world.player.targetId = nearby.id;
  world.lockedAttackTargetId = nearby.id;
  world.autoTargetId = distantAuto.id;
  world.resolveAttackTarget();
  assert.equal(world.player.targetId, null);
  assert.equal(world.lockedAttackTargetId, null);
  pointEquals(world.nearHitPoint, { x: 39, z: 0 });
  assert.equal(world.autoTargetId, distantAuto.id, 'attack resolution must not replace the movement target');
});

test('Mine falls back from an inactive automatic target to the valid locked collider Transform', () => {
  const locked = target(1, 0, 20), inactiveAuto = target(2, 10, 0, false), ray = target(3, -8, 0);
  const world = sourceFixture(locked, inactiveAuto, ray);
  world.autoTargetId = inactiveAuto.id;
  world.lockedAttackTargetId = locked.id;
  world.player.targetId = ray.id;
  world.resolveAttackTarget();
  assert.equal(world.player.targetId, locked.id);
  assert.equal(world.lockedAttackTargetId, locked.id);
  pointEquals(world.nearHitPoint, { x: 0, z: 20 });
});

test('Mine retains its valid in-range lock against a nearer ray when there is no automatic target', () => {
  const locked = target(1, 0, 20), ray = target(2, 10, 0);
  const world = sourceFixture(locked, ray);
  world.lockedAttackTargetId = locked.id;
  world.player.targetId = ray.id;
  world.resolveAttackTarget();
  assert.equal(world.player.targetId, locked.id);
  pointEquals(world.nearHitPoint, { x: 0, z: 20 });
});

test('starting a Main-mode drag adopts the real ray candidate before clearing a living automatic target', () => {
  const locked = target(1, 0, 20), nearerRay = target(2, 10, 0);
  const world = fixture(locked, nearerRay);
  world.autoTargetId = world.player.targetId = world.lockedAttackTargetId = locked.id;
  world.attackSearchTimer = C.attackSearchInterval;
  world.setMovementInput({ x: 1, y: 0 });
  world.step(.001);
  assert.equal(world.player.targetId, nearerRay.id);
  assert.equal(world.lockedAttackTargetId, nearerRay.id);
  assert.equal(world.autoTargetId, null, 'manual movement clears its automatic destination after resolving attack');
  pointEquals(world.nearHitPoint, { x: 10, z: 0 });
  assert.equal(locked.alive, true, 'the old automatic target remains valid and alive');
});

test('a continuing Main-mode drag clears a living attack lock when the next real ray scan finds nothing', () => {
  // Unity rays ignore a collider containing their origin. The lock itself is
  // still alive, visible and in range, so automatic resolution would retain it.
  const locked = target(1, 0, 0), world = fixture(locked);
  world.player.targetId = world.lockedAttackTargetId = locked.id;
  world.attackSearchTimer = C.attackSearchInterval - .002;
  world.setMovementInput({ x: 1, y: 0 });
  world.step(.001);
  assert.equal(world.player.targetId, locked.id, 'no scan has run on the first drag frame');
  assert.equal(world.autoTargetId, null);
  world.step(.001);
  assert.equal(world.isValidTarget(locked), true);
  assert.ok(world.targetRange(locked) < C.attackRange);
  assert.equal(world.player.targetId, null);
  assert.equal(world.lockedAttackTargetId, null);
  assert.deepEqual(world.player.position, { x: 0, z: 0 }, 'both Updates precede the first physics step');
});

test('releasing a Main drag keeps its current valid target for both attack and movement without resetting cooldown', () => {
  // The closer ray hit is at (0,7), but its root's forward-Z penalty makes the
  // other tree the automatic scoring winner. Release now keeps the manual lock.
  const manual = target(1, 0, 10), automatic = target(2, -12, 0);
  const world = fixture(manual, automatic);
  world.player.targetId = world.lockedAttackTargetId = automatic.id;
  world.autoTargetId = automatic.id;
  world.previouslyHadTarget = true;
  world.attackClock = .2;
  world.attackSearchTimer = C.attackSearchInterval;
  world.setMovementInput({ x: 1, y: 0 });
  world.step(.001);
  assert.equal(world.player.targetId, manual.id);
  assert.equal(world.autoTargetId, null);
  approximately(world.attackClock, .201);

  world.setMovementInput({ x: 0, y: 0 });
  world.step(.001);
  assert.equal(world.player.targetId, manual.id, 'release retains the last valid manual target');
  assert.equal(world.autoTargetId, manual.id, 'automatic movement follows the retained attack target immediately');
  approximately(world.attackClock, .202);
  world.step(.001);
  assert.equal(world.player.targetId, manual.id);
  assert.equal(world.lockedAttackTargetId, manual.id);
  assert.equal(world.autoTargetId, manual.id);
  assert.equal(manual.alive, true);
  approximately(world.attackClock, .203);
  assert.equal(world.stats.shots, 0);
});

test('manual attack resolution requires squared input strictly above the original threshold', () => {
  for (const squared of [0, manualThreshold - 1e-10, manualThreshold, manualThreshold + 1e-10]) {
    const automatic = target(1, 0, 20), nearerRay = target(2, 10, 0);
    const world = fixture(automatic, nearerRay);
    world.autoTargetId = world.player.targetId = world.lockedAttackTargetId = automatic.id;
    world.attackSearchTimer = C.attackSearchInterval;
    world.setMovementInput({ x: Math.sqrt(squared), y: 0 });
    world.step(.001);
    const expected = squared > manualThreshold ? nearerRay.id : automatic.id;
    assert.equal(world.player.targetId, expected, `squared input ${squared}`);
    assert.equal(world.lockedAttackTargetId, expected, `lock at squared input ${squared}`);
    pointEquals(world.nearHitPoint, squared > manualThreshold ? { x: 10, z: 0 } : { x: 0, z: 17 });
  }
});

test('Mine adopts the current near object and its collider Transform after an invalid lock', () => {
  const inactive = target(1, 0, 20, false), ray = target(2, 10, 0);
  const world = sourceFixture(inactive, ray);
  world.lockedAttackTargetId = inactive.id;
  world.player.targetId = ray.id;
  world.nearHitPoint = { x: 7, z: 0 }; // What the +X ray hit wrote before Resolve.
  world.resolveAttackTarget();
  assert.equal(world.player.targetId, ray.id);
  assert.equal(world.lockedAttackTargetId, ray.id);
  pointEquals(world.nearHitPoint, { x: 10, z: 0 });
});

test('Mine retains its source inactive but non-destroyed collider reference until a later scan', () => {
  const inactive = target(1, 0, 20, false);
  const world = sourceFixture(inactive);
  world.player.targetId = inactive.id;
  world.lockedAttackTargetId = inactive.id;
  world.resolveAttackTarget();
  assert.equal(world.player.targetId, inactive.id);
  assert.equal(world.lockedAttackTargetId, inactive.id);
  pointEquals(world.nearHitPoint, { x: 0, z: 20 });
});

test('adopting no near object clears the lock without inventing a new aim point', () => {
  const world = fixture(target(1, 0, 20, false));
  world.lockedAttackTargetId = 1;
  world.nearHitPoint = { x: 7, z: 9 };
  world.resolveAttackTarget();
  assert.equal(world.player.targetId, null);
  assert.equal(world.lockedAttackTargetId, null);
  pointEquals(world.nearHitPoint, { x: 7, z: 9 });
});

test('lock range includes the two-unit vertical difference from Ray_trans to the collider Transform', () => {
  for (const [x, expected] of [[39.94, true], [39.96, false]]) {
    const auto = target(1, x, 0);
    const world = fixture(auto);
    world.autoTargetId = auto.id;
    world.resolveAttackTarget();
    assert.equal(world.player.targetId, expected ? auto.id : null, `3D center distance at x=${x}`);
    assert.equal(world.lockedAttackTargetId, expected ? auto.id : null);
    assert.equal(Math.hypot(x, 2) <= 40, expected);
    assert.ok(x < 40 && x - 3 < 40, 'both 2D center and box-surface shortcuts would incorrectly accept the outside case');
  }
});

test('camera visibility uses Collider Transform rather than the visual tree root', () => {
  const tree = target(1, 10, 0);
  const world = fixture(tree);
  world.setViewport(9 / 16);
  // Artificially separate root and collider to identify which reference is used.
  tree.position = { x: 500, z: 500 };
  assert.equal(world.isVisible(tree), true);
  tree.position = { x: 0, z: 0 };
  tree.collider = { minX: 497, maxX: 503, minZ: 497, maxZ: 503 };
  assert.equal(world.isVisible(tree), false);
});

test('camera visibility includes the original camera-child offset and the two-percent viewport margin', () => {
  const aspect = 0.45, boundary = 40 * aspect * 1.04;
  for (const [delta, expected] of [[-0.005, true], [0.005, false]]) {
    const center = unprojectGround({ x: cameraOffset.x + boundary + delta, y: cameraOffset.y });
    const tree = target(1, center.x, center.z);
    const world = fixture(tree);
    world.setViewport(aspect);
    assert.equal(world.isVisible(tree), expected, `right viewport boundary delta=${delta}`);
    const projected = projectWorld(center);
    approximately(projected.x - cameraOffset.x, boundary + delta);
  }
});

test('Mine ray scans run while locked, wait for their first interval, and discard timer remainder', () => {
  const locked = target(1, 0, 20), nearerRay = target(2, 10, 0);
  const world = sourceFixture(locked, nearerRay);
  world.player.targetId = locked.id;
  world.lockedAttackTargetId = locked.id;
  // Keep movement acquisition out of this isolated ray/lock timing contract.
  world.updateAutoTarget = () => {};
  world.movePlayer = () => {};
  let scans = 0;
  const candidatesAtResolve = [];
  const resolve = world.resolveAttackTarget.bind(world);
  world.resolveAttackTarget = () => { candidatesAtResolve.push(world.player.targetId); resolve(); };
  world.findRayTarget = () => { scans++; world.nearHitPoint = { x: 7, z: 0 }; return nearerRay; };
  world.step(C.referenceFrameStep);
  assert.equal(scans, 0, 'zero-initialized elapsed timer must not scan immediately');
  world.attackSearchTimer = C.attackSearchInterval - C.referenceFrameStep / 2;
  world.step(C.referenceFrameStep);
  assert.equal(scans, 1, 'an existing attack lock must not suppress the periodic scan');
  approximately(world.attackSearchTimer, 0);
  assert.equal(candidatesAtResolve.at(-1), nearerRay.id, 'the timed scan writes nearObj before Resolve runs');
  assert.equal(world.player.targetId, locked.id, 'Resolve must restore the valid lock after the scan writes a nearer target');
  pointEquals(world.nearHitPoint, { x: 0, z: 20 });
});

test('Mine keeps the source update order: a newly selected movement target affects attack next tick', () => {
  const oldAuto = target(1, 0, 20), nextAuto = target(2, 20, 0);
  const world = sourceFixture(oldAuto, nextAuto);
  world.autoTargetId = oldAuto.id;
  world.movePlayer = () => {};
  world.updateAutoTarget = () => { world.autoTargetId = nextAuto.id; };
  world.step(C.referenceFrameStep);
  assert.equal(world.player.targetId, oldAuto.id);
  assert.equal(world.autoTargetId, nextAuto.id);
  world.step(C.referenceFrameStep);
  assert.equal(world.player.targetId, nextAuto.id);
});
