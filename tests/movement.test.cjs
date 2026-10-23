const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, COMBAT_CONFIG: C, treeCollider, screenSpeedMultiplier } = require('./.build/core/index.js');

// Expectations come from Cat.HandleAutoMove/AutoSmoothStop ARM64 and scene
// level0:147400, recorded in qa/fidelity/original-auto-movement-source.json.
// Cat_manager.Start calls Balance_Reload, overriding Inspector speed 13 with 15.
const close = (a, b, tolerance = 2e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const sourceScreenSpeed = direction => {
  const x = Math.SQRT1_2 * (direction.x + direction.z);
  const z = Math.SQRT1_2 * (direction.z - direction.x);
  const magnitude = Math.hypot(x, z * Math.fround(.57735026));
  return magnitude >= Math.fround(.0001) ? (1 / Math.fround(1.2)) / magnitude : 1;
};
const expectedVelocity = (delta, ratio = 1) => {
  const length = Math.hypot(delta.x, delta.z);
  const direction = { x: delta.x / length, z: delta.z / length };
  const speed = 15 * ratio * sourceScreenSpeed(direction);
  return { x: direction.x * speed, z: direction.z * speed };
};
function movementWorld(autoPosition = { x: 0, z: 20 }, nearPoint = null) {
  const world = new CombatWorld(1);
  const target = { id: 1000, position: { ...autoPosition }, health: 1e6, maxHealth: 1e6,
    degree: 0, alive: true, collider: treeCollider(autoPosition) };
  world.trees.splice(0, world.trees.length, target);
  world.autoTargetId = target.id;
  world.player.targetId = nearPoint ? target.id : null;
  world.nearHitPoint = nearPoint ? { ...nearPoint } : { x: 0, z: 0 };
  return world;
}

test('Source separation boundaries: 10 stops, 5 stops, below 5 retreats only with nearObj', () => {
  for (const separation of [5, 5.0001, 9.9999, 10]) {
    const world = movementWorld({ x: 0, z: 20 }, { x: 0, z: separation });
    world.movePlayer(.125);
    assert.equal(world.player.moving, false, `separation ${separation}`);
    assert.deepEqual(world.player.velocity, { x: 0, z: 0 });
  }
  const retreat = movementWorld({ x: 0, z: 20 }, { x: 0, z: 4.9999 });
  retreat.movePlayer(.125);
  assert.equal(retreat.player.moving, true);
  assert.ok(retreat.player.velocity.z < 0);
  for (const separation of [0, 1, 4.9999]) {
    const noNear = movementWorld({ x: 0, z: separation });
    noNear.movePlayer(.125);
    assert.equal(noNear.player.moving, false, 'close auto root alone cannot cause retreat');
  }
  const approach = movementWorld({ x: 0, z: 20 }, { x: 0, z: 10.0001 });
  approach.movePlayer(.125);
  assert.equal(approach.player.moving, true);
  assert.ok(approach.player.velocity.z > 0);
});

test('Approach stops below the source 0.3 target-point threshold and preserves facing there', () => {
  const tolerance = Math.fround(.3);
  for (const [distance, moving] of [[.2999, false], [tolerance, true], [.3001, true]]) {
    // The current auto root and the prior Resolve nearObj may differ on a
    // retarget frame. Use nearPoint for separation and root+Z offset for motion.
    const world = movementWorld({ x: distance, z: 9 }, { x: 0, z: 20 });
    world.player.facing = -1;
    world.movePlayer(.125);
    assert.equal(world.player.moving, moving, `destination distance ${distance}`);
    if (!moving) {
      assert.deepEqual(world.player.velocity, { x: 0, z: 0 });
      assert.equal(world.player.facing, -1, 'early approach stop does not face a target');
    }
  }
});

test('Approach uses world-Z capped offset and source smoothstep speed from 0.2 to 1', () => {
  for (const separation of [10.0001, 10.5, 11, 11.5, 12, 30]) {
    const world = movementWorld({ x: 12, z: 20 }, { x: 0, z: separation });
    world.movePlayer(.125); // clamp(dt*8)=1 exposes desired velocity.
    const t = Math.min(1, (separation - 10) / 2);
    const h = t * t * (3 - 2 * t);
    const expected = expectedVelocity({ x: 12, z: 11 }, h + (1 - h) * Math.fround(.2));
    close(world.player.velocity.x, expected.x);
    close(world.player.velocity.z, expected.z);
    close(world.player.velocity.x / world.player.velocity.z, 12 / 11);
  }
});

test('Retreat faces away; tiny pre-normalized directions use Vector3.back below squared 0.001', () => {
  const world = movementWorld({ x: 0, z: 20 }, { x: 2, z: 0 });
  world.movePlayer(.125);
  assert.equal(world.player.facing, -1, 'nearObj lies right, but retreat faces left');
  const expected = expectedVelocity({ x: -3.5, z: 0 });
  close(world.player.velocity.x, expected.x); close(world.player.velocity.z, 0);
  const threshold = Math.sqrt(Math.fround(.001));
  for (const separation of [0, threshold - 1e-8, threshold + 1e-8]) {
    const sample = movementWorld({ x: 0, z: 20 }, { x: separation, z: 0 });
    sample.movePlayer(.125);
    const usesBack = separation < threshold;
    const delta = usesBack ? { x: separation, z: -5.5 } : { x: separation - 5.5, z: 0 };
    const expected = expectedVelocity(delta);
    close(sample.player.velocity.x, expected.x); close(sample.player.velocity.z, expected.z);
    assert.equal(sample.player.facing, -1);
  }
});

test('Movement and stop use clamp01(dt*8), preserve position, and stop animation before residual velocity', () => {
  for (const dt of [0, 1 / 60, .0625, .125, 1]) {
    const world = movementWorld({ x: 12, z: 20 });
    world.player.velocity = { x: 3, z: -4 };
    world.autoSmoothVelocity = { ...world.player.velocity };
    const desired = expectedVelocity({ x: 12, z: 11 });
    const factor = Math.min(1, Math.max(0, dt * 8));
    world.movePlayer(dt);
    close(world.player.velocity.x, 3 + (desired.x - 3) * factor);
    close(world.player.velocity.z, -4 + (desired.z + 4) * factor);
    assert.deepEqual(world.player.position, { x: 0, z: 0 }, 'Update writes velocity without integrating physics');
    assert.equal(world.player.moving, true);
  }
  const stop = movementWorld({ x: 0, z: 8 });
  stop.player.velocity = { x: 3, z: -4 };
  stop.autoSmoothVelocity = { ...stop.player.velocity };
  stop.movePlayer(1 / 60);
  close(stop.player.velocity.x, 2.6); close(stop.player.velocity.z, -4 * 13 / 15);
  assert.equal(stop.player.moving, false, 'Walk immediately becomes false during smooth stop');
});

test('AutoSmoothStop compares squared speed against float32 0.01, strictly less', () => {
  const threshold = Math.fround(.01);
  for (const squaredSpeed of [threshold - 1e-8, threshold + 1e-8, .0999999995 ** 2]) {
    const world = movementWorld({ x: 0, z: 8 });
    const speed = Math.sqrt(squaredSpeed);
    world.player.velocity = { x: speed, z: 0 };
    world.autoSmoothVelocity = { ...world.player.velocity };
    world.movePlayer(0);
    assert.equal(world.player.moving, false);
    close(world.player.velocity.x, squaredSpeed < threshold ? 0 : speed, 1e-12);
  }
});

test('No auto target preserves facing while common stop decays its stored velocity', () => {
  const world = movementWorld();
  world.autoTargetId = null;
  world.player.facing = 1;
  world.player.velocity = { x: -2, z: -2 };
  world.autoSmoothVelocity = { ...world.player.velocity };
  world.movePlayer(.0625);
  assert.equal(world.player.facing, 1);
  assert.equal(world.player.moving, false);
  assert.deepEqual(world.player.velocity, { x: -1, z: -1 });
  const zeroDirection = movementWorld({ x: 1, z: -1 });
  zeroDirection.player.facing = 1;
  zeroDirection.movePlayer(0);
  assert.equal(zeroDirection.player.facing, -1, 'CamCorrection X=0 chooses left without a dead zone');
});

test('Screen speed uses source Cat constants, including the small-vector threshold', () => {
  for (const direction of [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: Math.SQRT1_2, z: -Math.SQRT1_2 },
    { x: .0002, z: 0 }, { x: .00001, z: 0 }]) {
    close(screenSpeedMultiplier(direction), sourceScreenSpeed(direction));
  }
});

test('Physics consumes the previous Update velocity before targeting and emits one pose per frame', () => {
  const world = movementWorld();
  const operations = [], displacements = [];
  world.player.velocity = { x: 4, z: -3 };
  world.findRayTarget = () => undefined;
  world.resolveAttackTarget = () => operations.push('resolve');
  world.updateAutoTarget = () => operations.push('auto');
  world.moveAndSlide = delta => { operations.push('physics'); displacements.push(delta); };
  world.updateBullets = () => operations.push('bullets');
  world.movePlayer = () => { operations.push('velocity'); world.player.velocity = { x: 8, z: -6 }; };
  world.setMuzzleProvider(() => { operations.push('pose'); return null; });
  world.physicsAccumulator = C.physicsStep - 1 / 60;
  world.updateFrame(1 / 60);
  assert.deepEqual(operations, ['physics', 'bullets', 'auto', 'resolve', 'velocity', 'pose']);
  close(displacements[0].x, 4 * (2822399 / 141120000));
  close(displacements[0].z, -3 * (2822399 / 141120000));
});

test('30/60/120 Hz input runs one source Update and pose per supplied frame with 50 physics steps per second', () => {
  for (const hz of [30, 60, 120]) {
    const world = movementWorld();
    const poses = [], movements = [], physics = [];
    let resolves = 0;
    world.resolveAttackTarget = () => { resolves++; world.player.targetId = null; };
    world.updateAutoTarget = () => {};
    world.movePlayer = dt => { movements.push(dt); };
    world.player.velocity = { x: 3, z: -4 };
    world.moveAndSlide = delta => { physics.push(delta); };
    world.updateBullets = () => {};
    world.setMuzzleProvider(context => { poses.push(context.dt); return null; });
    for (let frame = 0; frame < hz; frame++) {
      world.step(1 / hz);
      assert.equal(poses.length, frame + 1, `${hz} Hz must not silently resample into 60 Hz Updates`);
      assert.equal(movements.length, frame + 1);
      assert.equal(resolves, frame + 1);
      assert.equal(poses[frame], 1 / hz, 'pose receives the supplied frame delta');
      assert.equal(movements[frame], 1 / hz, 'movement smoothing receives the supplied frame delta');
    }
    assert.equal(physics.length, 50, `${hz} render frames should accumulate 50 independent physics steps`);
    for (const displacement of physics) {
      close(displacement.x, 3 * (2822399 / 141120000));
      close(displacement.z, -4 * (2822399 / 141120000));
    }
  }
});

test('Irregular frame deltas reach source Update unchanged instead of becoming fixed-size substeps', () => {
  const world = movementWorld(), deltas = [.007, .023, .031, .011, .045];
  const poses = [], movements = [];
  let physicsCount = 0;
  world.resolveAttackTarget = () => { world.player.targetId = null; };
  world.updateAutoTarget = () => {};
  world.movePlayer = dt => { movements.push(dt); };
  world.moveAndSlide = () => { physicsCount++; };
  world.updateBullets = () => {};
  world.setMuzzleProvider(context => { poses.push(context.dt); return null; });
  for (const dt of deltas) world.step(dt);
  assert.deepEqual(poses, deltas);
  assert.deepEqual(movements, deltas);
  assert.equal(physicsCount, 5, '0.117 seconds accumulates five original fixed physics steps');
});
