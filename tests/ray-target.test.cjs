const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CombatWorld } = require(path.resolve(__dirname, './.build/core/index.js'));

// Source oracle: original-physics-source.json, Cat.FindNearestEnemyByRaycast
// ARM64 0x2b4126c. Unity Physics.Raycast excludes a containing collider.
function boxTarget(id, minX, maxX, minZ, maxZ) {
  const x = (minX + maxX) / 2, z = (minZ + maxZ) / 2;
  return { id, position: { x: x + 2, z: z - 2 }, degree: 0,
    alive: true, health: 1000, maxHealth: 1000,
    collider: { minX, maxX, minZ, maxZ } };
}
function pointTarget(id, x, z, half = 0.01) {
  return boxTarget(id, x - half, x + half, z - half, z + half);
}
function fixture(...targets) {
  const world = new CombatWorld(1);
  world.trees.splice(0, world.trees.length, ...targets);
  world.player.position = { x: 0, z: 0 };
  world.setViewport(4);
  return world;
}

test('equal nearest hits retain the first ray, +Z, independent of target array order', () => {
  const plusZ = pointTarget(1, 0, 10);
  const world = fixture(pointTarget(2, 10, 0), pointTarget(3, 0, -10),
    pointTarget(4, -10, 0), plusZ);
  assert.equal(world.findRayTarget()?.id, plusZ.id);
});

test('36 source rays can miss a small collider between the ten-degree directions', () => {
  const between = pointTarget(1, 20 * Math.sin(Math.PI / 36), 20 * Math.cos(Math.PI / 36));
  const onRay = pointTarget(2, 22 * Math.sin(Math.PI / 18), 22 * Math.cos(Math.PI / 18));
  const world = fixture(between);
  assert.equal(world.findRayTarget(), undefined);
  world.trees.push(onRay);
  assert.equal(world.findRayTarget()?.id, onRay.id);
});

test('an off-screen first collider blocks a visible farther collider on the same ray', () => {
  const angle = 310 * Math.PI / 180;
  const far = pointTarget(1, 10 * Math.sin(angle), 10 * Math.cos(angle));
  // Its Transform is off-screen, while the large physical box crosses the ray.
  const blocker = boxTarget(2, -4, 50, 2, 4);
  const world = fixture(far, blocker);
  world.setViewport(0.1);
  assert.equal(world.isVisible(far), true);
  assert.equal(world.isVisible(blocker), false);
  assert.equal(world.findRayTarget(), undefined);
  world.trees.pop();
  assert.equal(world.findRayTarget()?.id, far.id);
});

test('a containing collider is skipped and does not hide the next ray hit', () => {
  const containing = boxTarget(1, -3, 3, -3, 3), far = pointTarget(2, 0, 10);
  const world = fixture(containing, far);
  assert.equal(world.findRayTarget()?.id, far.id);
  world.trees.pop();
  assert.equal(world.findRayTarget(), undefined);
});
