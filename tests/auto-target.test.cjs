const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, treeCollider } = require('./.build/core/index.js');

// First-wave Main-mode expectations from Cat.FindNearestTreeByGrid and
// HandleAutoMove; qa/fidelity/original-auto-target-source.json records the
// original bundle fields, stable Tree_list order and supporting ARM64.
// These search/timer fixtures have no retained attack lock. Live-lock retention
// and invalidation across real Updates are covered in target-lock.test.cjs.
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const tree = (id, x, z, alive = true) => ({ id, position: { x, z }, alive,
  health: alive ? 250 : 0, maxHealth: 250, degree: 0, collider: treeCollider({ x, z }) });
function fixture(...trees) {
  const world = new CombatWorld(1);
  world.trees.splice(0, world.trees.length, ...trees);
  world.autoTargetId = null;
  world.autoSearchTimer = 0;
  return world;
}

test('Main movement selection measures tree roots rather than collider centers or surfaces', () => {
  // Root distances 7 and 8 favor the first; collider-center and ClosestPoint
  // distances both favor the second because Coll is offset (-2,0,+2).
  const nearerRoot = tree(11, -7, 0), nearerCollider = tree(12, 8, 0);
  const world = fixture(nearerCollider, nearerRoot);
  assert.ok(Math.hypot(-9, 2) > Math.hypot(6, 2));
  assert.equal(world.findAutoTarget(), nearerRoot);
});

test('Nearby radius includes exactly 8; just beyond it pays the forward-Z penalty', () => {
  for (const [z, expected] of [[7.9999, 1], [8, 1], [8.0001, 2]]) {
    const forward = tree(1, 0, z), sideways = tree(2, 9, 0);
    const world = fixture(sideways, forward);
    assert.equal(world.findAutoTarget().id, expected, `forward root distance ${z}`);
  }
});

test('Only positive relative world-Z is penalized, with weight 0.4 beyond radius 8', () => {
  const forward = tree(1, 0, 10), sideways = tree(2, 11, 0), behind = tree(3, 0, -10);
  assert.equal(fixture(forward, sideways).findAutoTarget(), sideways, 'scores 14 and 11');
  assert.equal(fixture(sideways, behind).findAutoTarget(), behind, 'negative Z is not penalized');
  const world = fixture(tree(10, 100, 210), tree(11, 111, 200));
  world.player.position = { x: 100, z: 200 };
  assert.equal(world.findAutoTarget().id, 11, 'Z is relative to the cat, not absolute map Z');
  const belowFourteen = tree(20, 13.999, 0), aboveFourteen = tree(21, 14.001, 0);
  assert.equal(fixture(forward, belowFourteen).findAutoTarget(), belowFourteen);
  assert.equal(fixture(forward, aboveFourteen).findAutoTarget(), forward);
});

test('Strictly smaller scores replace a target; equal scores retain current serialized array order', () => {
  const first = tree(900, 10, 0), second = tree(1, -10, 0);
  const world = fixture(first, second);
  assert.equal(world.findAutoTarget(), first, 'numeric id does not break a tie');
  world.trees.reverse();
  assert.equal(world.findAutoTarget(), second);
  const slightlyCloser = tree(999, 9.999, 0);
  world.trees.push(slightlyCloser);
  assert.equal(world.findAutoTarget(), slightlyCloser, 'a later strictly better candidate wins');
});

test('Automatic movement targets must be alive but need not be visible or within attack range', () => {
  const inactive = tree(1, 1, 0, false), distant = tree(2, 100, 0);
  const world = fixture(inactive, distant);
  assert.equal(world.isVisible(distant), false);
  assert.equal(world.findAutoTarget(), distant);
  world.autoTargetId = distant.id;
  world.resolveAttackTarget();
  assert.equal(world.player.targetId, null, 'movement selection must not acquire an off-screen attack target');
  distant.alive = false;
  assert.equal(world.findAutoTarget(), undefined);
  world.trees.length = 0;
  assert.equal(world.findAutoTarget(), undefined);
});

test('Without an attack lock, a cached destination is rescored at 0.3 seconds and discards timer remainder', () => {
  const cached = tree(1, 15, 0), better = tree(2, 5, 0);
  const world = fixture(cached, better);
  world.autoTargetId = cached.id;
  world.updateAutoTarget(.12);
  world.updateAutoTarget(.12);
  assert.equal(world.autoTargetId, cached.id, 'better candidate cannot preempt between timed scans');
  close(world.autoSearchTimer, .24);
  world.updateAutoTarget(.09);
  assert.equal(world.autoTargetId, better.id);
  assert.equal(world.autoSearchTimer, 0, '0.03 seconds of excess is discarded');
  world.updateAutoTarget(.1);
  close(world.autoSearchTimer, .1);
  // Source float32 accumulation of three 0.1 steps reaches its serialized
  // float32 interval. This also protects the nominal boundary in this host.
  world.updateAutoTarget(.1);
  world.updateAutoTarget(.1);
  assert.equal(world.autoSearchTimer, 0);
});

test('Null or missing auto targets search immediately and reset the elapsed timer', () => {
  const candidate = tree(1, 100, 0);
  for (const cachedId of [null, 999]) {
    const world = fixture(candidate);
    world.autoTargetId = cachedId;
    world.autoSearchTimer = .12;
    world.updateAutoTarget(.001);
    assert.equal(world.autoTargetId, candidate.id);
    assert.equal(world.autoSearchTimer, 0);
  }
  const empty = fixture();
  empty.updateAutoTarget(.001);
  assert.equal(empty.autoTargetId, null);
  assert.equal(empty.autoSearchTimer, 0);
  empty.trees.push(candidate);
  empty.updateAutoTarget(.001);
  assert.equal(empty.autoTargetId, candidate.id, 'a still-null cache retries next Update');
});

test('A non-null dead auto target is replaced immediately without restarting its existing timer', () => {
  const dead = tree(1, 2, 0, false), alive = tree(2, 20, 0);
  const world = fixture(dead, alive);
  world.autoTargetId = dead.id;
  world.autoSearchTimer = .1;
  world.updateAutoTarget(.05);
  assert.equal(world.autoTargetId, alive.id);
  close(world.autoSearchTimer, .15);
  const better = tree(3, 4, 0);
  world.trees.push(better);
  world.updateAutoTarget(.149);
  assert.equal(world.autoTargetId, alive.id);
  world.updateAutoTarget(.002);
  assert.equal(world.autoTargetId, better.id, 'next scan remains on the old cadence');
  assert.equal(world.autoSearchTimer, 0);
});

test('Dead-target fallback returning null preserves timer once; the next null search resets it', () => {
  const dead = tree(1, 2, 0, false), world = fixture(dead);
  world.autoTargetId = dead.id;
  world.autoSearchTimer = .1;
  world.updateAutoTarget(.05);
  assert.equal(world.autoTargetId, null);
  close(world.autoSearchTimer, .15);
  world.updateAutoTarget(.01);
  assert.equal(world.autoTargetId, null);
  assert.equal(world.autoSearchTimer, 0);
});

test('Main automatic search does not treat an uncommitted ray result as an attack lock', () => {
  const cached = tree(1, 15, 0), near = tree(2, 3, 0);
  const world = fixture(cached, near);
  world.autoTargetId = cached.id;
  world.player.targetId = near.id;
  world.nearHitPoint = { x: 1, z: 0 };
  world.updateAutoTarget(.05);
  assert.equal(world.autoTargetId, cached.id, 'a raw ray result must still pass through attack-target resolution');
  close(world.autoSearchTimer, .05);
});
