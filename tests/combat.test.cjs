const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CombatWorld, COMBAT_CONFIG: C, generateFirstMap, treeCollider, sweepCircleAABB, rayAABB, circleOverlapsBox, projectWorld, unprojectGround } = require(path.resolve(__dirname, './.build/core/index.js'));

const approximately = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
function advance(world, seconds, rate = 60) {
  const events = [];
  for (let frame = 0; frame < Math.round(seconds * rate); frame++) {
    world.step(1 / rate);
    events.push(...world.drainEvents());
  }
  return events;
}

function stationaryTargetWorld(seed = 42) {
  const world = new CombatWorld(seed);
  const position = { x: 2, z: 10 };
  world.trees.splice(0, world.trees.length, {
    id: 1000, position, health: 1000000, maxHealth: 1000000, degree: 0,
    alive: true, collider: treeCollider(position),
  });
  world.stats.totalTrees = 1;
  // Begin this isolated firing fixture with a movement target already selected.
  // Main also resolves a newly acquired movement target in the same Update.
  world.autoTargetId = 1000;
  return world;
}

test('fixed camera projection has a ground-plane inverse and correct axis directions', () => {
  for (const position of [{ x: 0, z: 0 }, { x: -23.5, z: 72 }, { x: 1234, z: -23 }]) {
    const roundtrip = unprojectGround(projectWorld(position));
    approximately(roundtrip.x, position.x);
    approximately(roundtrip.z, position.z);
  }
  assert.ok(projectWorld({ x: 1, z: 0 }).y < 0);
  assert.ok(projectWorld({ x: 0, z: 1 }).y > 0);
  approximately(projectWorld({ x: 0, z: 0 }, 2).y, 1.6330009408996132);
});

test('first map reproduces the seeded 30-of-100 Morton layout and original tree collider offset', () => {
  const a = generateFirstMap(42), b = generateFirstMap(42), c = generateFirstMap(43);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 30);
  assert.equal(new Set(a.map(tree => tree.id)).size, 30);
  for (const tree of a) {
    assert.ok([250, 450].includes(Number(tree.health)));
    assert.equal(tree.maxHealth, tree.health);
    assert.equal(Number(tree.health), tree.degree ? 450 : 250);
    approximately((tree.collider.minX + tree.collider.maxX) / 2, tree.position.x - 2);
    approximately((tree.collider.minZ + tree.collider.maxZ) / 2, tree.position.z + 2);
    approximately(tree.collider.maxX - tree.collider.minX, 6);
    assert.ok(Math.abs(tree.position.x - ((tree.id % 10) * 5 - 22.5)) <= 1.5);
    assert.ok(Math.abs(tree.position.z - (Math.floor(tree.id / 10) * 5 + 27.5)) <= 1.5);
  }
  let high = 0, total = 0;
  for (let seed = 1; seed <= 300; seed++) for (const tree of generateFirstMap(seed)) { high += tree.degree; total++; }
  assert.ok(high / total > 0.17 && high / total < 0.23, `observed high-health rate ${high / total}`);
});

test('swept circular bullets hit faces at the correct time and do not tunnel', () => {
  const box = { minX: 0, maxX: 6, minZ: 0, maxZ: 6 };
  const hit = sweepCircleAABB({ x: -10, z: 3 }, { x: 10, z: 3 }, 0.6, box);
  assert.ok(hit);
  approximately(hit.time, 9.4 / 20);
  assert.deepEqual(hit.normal, { x: -1, z: 0 });
  assert.equal(sweepCircleAABB({ x: -10, z: -2 }, { x: 10, z: -2 }, 0.6, box), null);
});

test('rounded corners reject square-expansion false positives and detect true glancing contact', () => {
  const box = { minX: 0, maxX: 6, minZ: 0, maxZ: 6 };
  // Both endpoints enter the expanded AABB, but stay outside the rounded corner.
  assert.equal(sweepCircleAABB({ x: -0.61, z: -0.59 }, { x: -0.3, z: -0.59 }, 0.6, box), null);
  const hit = sweepCircleAABB({ x: -2, z: -0.3 }, { x: 2, z: -0.3 }, 0.6, box);
  assert.ok(hit);
  approximately(hit.time, (2 - Math.sqrt(0.36 - 0.09)) / 4);
  approximately(hit.normal.z, -0.5);
  assert.equal(sweepCircleAABB({ x: -0.6, z: 3 }, { x: -2, z: 3 }, 0.6, box), null, 'touching and moving away must not stick');
});

test('stationary penetration keeps stable face ties and normalizes a rounded-corner overlap', () => {
  const box = { minX: 0, maxX: 6, minZ: 0, maxZ: 6 };
  for (const [point, normal] of [
    [{ x: 3, z: 3 }, { x: -1, z: 0 }],
    [{ x: 5, z: 5 }, { x: 1, z: 0 }],
    [{ x: 3, z: 1 }, { x: 0, z: -1 }],
    [{ x: 3, z: 5 }, { x: 0, z: 1 }],
  ]) assert.deepEqual(sweepCircleAABB(point, point, 0.6, box), { time: 0, normal });
  const corner = sweepCircleAABB({ x: -0.3, z: -0.4 }, { x: -0.3, z: -0.4 }, 0.6, box);
  assert.ok(corner);
  assert.equal(corner.time, 0);
  approximately(corner.normal.x, -0.6);
  approximately(corner.normal.z, -0.8);
  assert.equal(sweepCircleAABB({ x: -1, z: -1 }, { x: -1, z: -1 }, 0.6, box), null);
});

test('sweeps retain endpoint contact and all four rounded-corner normals', () => {
  const box = { minX: 0, maxX: 6, minZ: 0, maxZ: 6 };
  assert.deepEqual(sweepCircleAABB({ x: -2, z: 3 }, { x: -0.6, z: 3 }, 0.6, box),
    { time: 1, normal: { x: -1, z: 0 } });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const cx = sx < 0 ? 0 : 6, cz = sz < 0 ? 0 : 6;
    const hit = sweepCircleAABB({ x: cx + sx * 2, z: cz + sz * 2 },
      { x: cx - sx * 2, z: cz - sz * 2 }, 1, box);
    assert.ok(hit);
    approximately(hit.time, (2 - Math.SQRT1_2) / 4);
    approximately(hit.normal.x, sx * Math.SQRT1_2);
    approximately(hit.normal.z, sz * Math.SQRT1_2);
  }
});

test('ray slabs retain parallel, reversed-direction, surface and distance-limit boundaries', () => {
  const box = { minX: 0, maxX: 6, minZ: 0, maxZ: 6 };
  for (const [origin, direction, limit, expected] of [
    [{ x: -2, z: 3 }, { x: 1, z: 0 }, 2, 2],
    [{ x: 8, z: 3 }, { x: -1, z: 0 }, 2, 2],
    [{ x: 3, z: -2 }, { x: 0, z: 1 }, 2, 2],
    [{ x: 3, z: 8 }, { x: 0, z: -1 }, 2, 2],
    [{ x: -2, z: 3 }, { x: 1, z: 0 }, 1.99, null],
    [{ x: -2, z: -1 }, { x: 1, z: 0 }, 20, null],
    [{ x: 0, z: 3 }, { x: -1, z: 0 }, 20, 0],
    [{ x: 3, z: 3 }, { x: 1, z: 0 }, 20, 0],
  ]) assert.equal(rayAABB(origin, direction, limit, box), expected);
});

test('a single projectile deals 100 once and 250/450 health requires 3/5 hits', () => {
  for (const health of [250, 450]) {
    const world = new CombatWorld(1);
    const position = { x: 2, z: 17 };
    world.trees.splice(0, world.trees.length, { id: 1000, position, health, maxHealth: health, degree: health === 450 ? 1 : 0, alive: true, collider: treeCollider(position) });
    world.stats.totalTrees = 1;
    const events = advance(world, 8);
    const hits = events.filter(event => event.type === 'hit');
    assert.equal(hits.length, Math.ceil(health / 100));
    assert.ok(hits.every(event => event.damage.compare(100) === 0));
    assert.equal(Number(world.trees[0].health), 0);
    assert.equal(events.filter(event => event.type === 'treeDied').length, 1);
    assert.equal(events.filter(event => event.type === 'complete').length, 1);
    assert.ok(hits.slice(0, -1).every(event => event.health > 0));
    assert.equal(Number(hits.at(-1).health), 0);
  }
});

test('five independent seeded maps clear automatically without collision penetration or a stalled cat', () => {
  for (const seed of [1, 2, 3, 42, 20261010]) {
    const world = new CombatWorld(seed);
    const expectedHits = world.trees.reduce((sum, tree) => sum + Math.ceil(tree.health / 100), 0);
    let movingShots = 0;
    let completions = 0;
    const deaths = new Set();
    for (let frame = 0; frame < 60 * 180 && !world.stats.complete; frame++) {
      world.step(1 / 60);
      for (const event of world.drainEvents()) {
        if (event.type === 'shot' && world.player.moving) movingShots++;
        if (event.type === 'complete') completions++;
        if (event.type === 'treeDied') { assert.ok(!deaths.has(event.treeId)); deaths.add(event.treeId); }
      }
      for (const tree of world.trees) if (tree.alive) assert.equal(circleOverlapsBox(world.player.position, C.playerRadius - 1e-4, tree.collider), false);
    }
    assert.ok(world.stats.complete, `seed ${seed} stalled: ${JSON.stringify(world.stats)}`);
    assert.equal(world.stats.kills, 30);
    assert.equal(world.stats.hits, expectedHits);
    assert.equal(deaths.size, 30);
    assert.equal(completions, 1);
    assert.ok(movingShots > 0, 'walking must not disable automatic shooting');
    assert.equal(world.player.targetId, null, 'the reticle must lose its target on the final death frame');
    advance(world, 2);
    assert.equal(world.player.targetId, null, 'the completed round must not reacquire a target');
    assert.ok(world.bullets.every(bullet => !bullet.active && !bullet.damaging && bullet.age === 0));
  }
});

test('30/60/120 fps Update rates each clear the map while physics retains its original 50 Hz step', () => {
  const originalPhysicsStep = 2822399 / 141120000;
  for (const rate of [30, 60, 120]) {
    const world = new CombatWorld(20261010);
    const expectedHits = world.trees.reduce((sum, tree) => sum + Math.ceil(tree.health / C.damage), 0);
    let physicsSteps = 0, frames = 0, completions = 0;
    const updateBullets = world.updateBullets.bind(world);
    world.updateBullets = dt => {
      approximately(dt, originalPhysicsStep);
      physicsSteps++;
      updateBullets(dt);
    };
    for (; frames < rate * 180 && !world.stats.complete; frames++) {
      world.step(1 / rate);
      const events = world.drainEvents();
      assert.ok(events.filter(event => event.type === 'shot').length <= 1, 'one Update may attempt at most one attack');
      completions += events.filter(event => event.type === 'complete').length;
    }
    assert.ok(world.stats.complete, `${rate} fps stalled: ${JSON.stringify(world.stats)}`);
    assert.equal(world.stats.kills, 30);
    assert.equal(world.stats.hits, expectedHits);
    assert.equal(completions, 1);
    approximately(world.stats.elapsed, frames / rate);
    const remainder = frames / rate - physicsSteps * originalPhysicsStep;
    assert.ok(remainder >= -1e-7 && remainder < originalPhysicsStep + 1e-7, `invalid physics remainder at ${rate} fps: ${remainder}`);
  }
});

test('pause freezes state, a resumed long frame is capped without burst fire, and reset clears pooled state', () => {
  const world = new CombatWorld(42);
  advance(world, 1);
  const elapsedBeforePause = world.stats.elapsed;
  const saved = JSON.stringify({ player: world.player, bullets: world.bullets, stats: world.stats });
  world.pause();
  world.step(20);
  world.step(1 / 60);
  assert.equal(JSON.stringify({ player: world.player, bullets: world.bullets, stats: world.stats }), saved);
  world.resume();
  world.step(20);
  // TimeManager.Maximum Allowed Timestep caps one resumed Update. Bootstrap's
  // background skip-frame guard is separate from directly supplying a long dt.
  const originalMaximumFrameStep = 0.3333333432674408;
  approximately(world.stats.elapsed, elapsedBeforePause + originalMaximumFrameStep);
  assert.ok(world.drainEvents().filter(event => event.type === 'shot').length <= 1);
  world.step(1 / 60);
  approximately(world.stats.elapsed, elapsedBeforePause + originalMaximumFrameStep + 1 / 60);
  assert.ok(world.drainEvents().filter(event => event.type === 'shot').length <= 1);
  world.reset(42);
  const pristine = new CombatWorld(42);
  assert.deepEqual(world.player, pristine.player);
  assert.deepEqual(world.stats, pristine.stats);
  assert.deepEqual(world.trees, pristine.trees);
  assert.deepEqual(world.bullets, pristine.bullets);
  assert.deepEqual(world.drainEvents(), []);
});

test('visual muzzle coordinates set the projectile origin and reset restores the default barrel offset', () => {
  const world = new CombatWorld(42);
  const firstShot = () => {
    for (let frame = 0; frame < 120; frame++) {
      world.step(1 / 60);
      const shot = world.drainEvents().find(event => event.type === 'shot');
      if (shot) return shot;
    }
    assert.fail('automatic attack did not fire within two seconds');
  };
  const offset = { x: -2.25, z: 3.75 };
  world.setMuzzleOffset(offset);
  // The rendering adapter can reuse its vector without changing a submitted socket.
  offset.x = 99;
  const shot = firstShot();
  approximately(shot.position.x - world.player.position.x, -2.25);
  approximately(shot.position.z - world.player.position.z, 3.75);
  const bullet = world.bullets[shot.bulletId];
  assert.deepEqual(bullet.previousPosition, shot.position);
  assert.deepEqual(bullet.position, shot.position, 'physics ran before this Update spawned the bullet');
  assert.equal(bullet.age, 0);
  assert.equal(bullet.traveled, 0);
  for (let frame = 0; frame < 2 && bullet.age === 0; frame++) world.step(C.referenceFrameStep);
  approximately(bullet.age, C.physicsStep);
  approximately(bullet.position.x, shot.position.x + shot.direction.x * C.bulletSpeed * C.physicsStep);
  approximately(bullet.position.z, shot.position.z + shot.direction.z * C.bulletSpeed * C.physicsStep);

  world.reset(42);
  const resetShot = firstShot();
  approximately(resetShot.position.x - world.player.position.x, world.player.aim.x * C.muzzleDistance);
  approximately(resetShot.position.z - world.player.position.z, world.player.aim.z * C.muzzleDistance);
});

test('the original animated muzzle envelope cannot strand a retained target or stall map completion', () => {
  // All original idle/walk frames and 5-degree aim samples give forward offsets
  // 3.489..5.313 and lateral offsets within +/-1.433 after removing bullet height.
  // Exercise a wider envelope and feed the previous tick's aim like a view adapter.
  for (const forward of [3.3, 5.6]) for (const lateral of [-1.6, 1.6]) {
    for (const seed of [1, 2, 3, 42, 20261010]) {
      const world = new CombatWorld(seed);
      const expectedHits = world.trees.reduce((sum, tree) => sum + Math.ceil(tree.health / C.damage), 0);
      for (let frame = 0; frame < 60 * 180 && !world.stats.complete; frame++) {
        const aim = world.player.aim;
        world.setMuzzleOffset({ x: aim.x * forward - aim.z * lateral, z: aim.z * forward + aim.x * lateral });
        world.step(1 / 60);
        world.drainEvents();
      }
      assert.ok(world.stats.complete, `muzzle ${forward},${lateral}; seed ${seed} stalled: ${JSON.stringify(world.stats)}`);
      assert.equal(world.stats.kills, 30);
      assert.equal(world.stats.hits, expectedHits, 'offsets must not lose or duplicate damage');
    }
  }
});

test('viewport aspect changes on-screen search and both portrait and landscape remain clearable', () => {
  for (const aspect of [0.45, 9 / 16, 16 / 9]) {
    const world = new CombatWorld(42);
    world.setViewport(aspect);
    for (let frame = 0; frame < 60 * 180 && !world.stats.complete; frame++) { world.step(1 / 60); world.drainEvents(); }
    assert.ok(world.stats.complete, `aspect ${aspect} did not clear`);
  }
});

test('the first shot aims from the animated muzzle to the near surface rather than parallel to the cat', () => {
  for (const offset of [{ x: -3, z: 1.8 }, { x: 3, z: 4 }]) {
    const world = stationaryTargetWorld();
    world.setMuzzleOffset(offset);
    const shot = advance(world, C.attackInterval).find(event => event.type === 'shot');
    assert.ok(shot);
    assert.deepEqual(world.player.position, { x: 0, z: 0 });
    // Original ResolveAttackTarget's ClosestPoint(Ray_trans) is (0, 2, 9).
    const dx = -offset.x, dz = 9 - offset.z, magnitude = Math.hypot(dx, dz);
    approximately(shot.direction.x, dx / magnitude);
    approximately(shot.direction.z, dz / magnitude);
    assert.notEqual(shot.direction.x, world.player.aim.x);
  }
});

test('target reacquisition resets spread and cooldown, while continuous shots keep random yaw', () => {
  const world = stationaryTargetWorld(1234);
  world.setMuzzleOffset({ x: 0, z: 1.8 });
  const shots = advance(world, 3 * C.attackInterval).filter(event => event.type === 'shot');
  assert.equal(shots.length, 3);
  approximately(shots[0].direction.x, 0);
  assert.ok(shots.slice(1).some(shot => Math.abs(shot.direction.x) > 1e-4), 'continuous fire must retain source random spread');
  const maxSpread = 2 + 18 * (1 - (Math.log(0.6) + Math.log(20)) / Math.log(40));
  for (const shot of shots) assert.ok(Math.abs(Math.atan2(shot.direction.x, shot.direction.z) * 180 / Math.PI) <= maxSpread);
  world.trees[0].alive = false;
  advance(world, 2);
  world.trees[0].alive = true;
  let framesAfterAcquisition = 0, acquired = false, nextShot;
  for (let frame = 0; frame < 90 && !nextShot; frame++) {
    world.step(1 / 60);
    if (world.player.targetId !== null) { acquired = true; framesAfterAcquisition++; }
    nextShot = world.drainEvents().find(event => event.type === 'shot');
  }
  assert.ok(acquired && nextShot);
  assert.equal(framesAfterAcquisition, Math.round(C.attackInterval * 60), 'idle cooldown must not cause an immediate shot on reacquisition');
  approximately(nextShot.direction.x, 0);
  approximately(nextShot.direction.z, 1);
});

test('spread can miss a narrow target and an expired straight projectile is not corrected into a hit', () => {
  const world = stationaryTargetWorld(1234);
  world.setMuzzleOffset({ x: 0, z: 1.8 });
  world.trees[0].collider = { minX: -0.02, maxX: 0.02, minZ: 9, maxZ: 15 };
  advance(world, 30);
  const unresolved = world.bullets.filter(bullet => bullet.active && bullet.damaging).length;
  assert.ok(world.stats.hits > 0);
  assert.ok(world.stats.shots > world.stats.hits + unresolved, 'some source-spread trajectories must expire without a hit');
  assert.equal(Number(world.trees[0].health), 1000000 - world.stats.hits * C.damage);
});

test('an oblique hit places the effect at ClosestPoint(previous physics position)', () => {
  const world = stationaryTargetWorld();
  const tree = world.trees[0];
  tree.collider = { minX: 0, maxX: 6, minZ: 0, maxZ: 6 };
  world.stats.complete = true; // Keep the actor idle while an existing projectile finishes.
  Object.assign(world.bullets[0], {
    active: true, damaging: true, position: { x: -1, z: 1 }, previousPosition: { x: -1, z: 1 },
    direction: { x: Math.SQRT1_2, z: Math.SQRT1_2 }, age: 0, traveled: 0,
  });
  world.step(C.referenceFrameStep);
  assert.deepEqual(world.drainEvents(), [], 'one 60 Hz Update has not reached the original 50 Hz physics step');
  assert.deepEqual(world.bullets[0].position, { x: -1, z: 1 });
  assert.equal(world.bullets[0].age, 0);
  world.step(C.referenceFrameStep);
  const hit = world.drainEvents().find(event => event.type === 'hit');
  assert.ok(hit);
  assert.deepEqual(hit.position, { x: 0, z: 1 });
  approximately(world.bullets[0].age, C.physicsStep);
  assert.ok(world.bullets[0].position.z > hit.position.z, 'effect point must not use the swept contact center');
  assert.equal(world.bullets[0].damaging, false);
});

test('main cat stops Walk as it enters deceleration and snaps residual speed below the source threshold', () => {
  const world = stationaryTargetWorld();
  world.player.velocity = { x: 0.12, z: 0 };
  world.autoSmoothVelocity = { ...world.player.velocity };
  world.step(C.referenceFrameStep);
  assert.equal(world.player.moving, false, 'HandleAutoMove stop branch clears Walk before residual movement finishes');
  approximately(world.player.velocity.x, 0.104);
  assert.deepEqual(world.player.position, { x: 0, z: 0 }, 'Update changes velocity; physics has not advanced yet');
  world.step(C.referenceFrameStep);
  approximately(world.player.position.x, 0.104 * C.physicsStep);
  approximately(world.player.position.z, 0);
  assert.deepEqual(world.player.velocity, { x: 0, z: 0 });
  const stoppedPosition = { ...world.player.position };
  world.step(C.referenceFrameStep);
  assert.deepEqual(world.player.position, stoppedPosition);
});

test('each render-frame Update samples its current muzzle once with the original frame dt before firing', () => {
  for (const rate of [30, 60, 120]) {
    const world = stationaryTargetWorld();
    world.autoTargetId = null; // Exercise fresh-world acquisition as well as sampling.
    let calls = 0;
    const samples = [];
    world.setMuzzleProvider(({ dt, player, targetPoint, attackFacing }) => {
      assert.equal(dt, 1 / rate);
      const offset = { x: ++calls / 20, z: 2 };
      assert.equal(player.targetId, 1000, 'Main acquires its shared movement/attack target before sampling');
      assert.deepEqual(targetPoint, { x: player.position.x, z: 9 });
      samples.push({ position: { ...player.position }, offset, targetPoint, attackFacing });
      return offset;
    });
    // Source timers accumulate each render frame, not synthetic 60 Hz Updates.
    // Acquisition on frame 1 counts that frame's dt toward the 0.6s cooldown.
    const attackFrames = Math.round(C.attackInterval * rate);
    const totalFrames = attackFrames + 2;
    const shots = advance(world, totalFrames / rate, rate).filter(event => event.type === 'shot');
    assert.equal(calls, totalFrames);
    approximately(world.stats.elapsed, totalFrames / rate);
    assert.equal(shots.length, 1);
    const firingSamples = samples.filter(sample => sample.attackFacing !== undefined);
    assert.equal(firingSamples.length, 1);
    const firing = firingSamples[0];
    assert.equal(samples.indexOf(firing), attackFrames - 1);
    approximately(shots[0].position.x, firing.position.x + firing.offset.x);
    approximately(shots[0].position.z, firing.position.z + firing.offset.z);
    const dx = -attackFrames / 20, dz = 7 - firing.position.z, magnitude = Math.hypot(dx, dz);
    approximately(shots[0].direction.x, dx / magnitude);
    approximately(shots[0].direction.z, dz / magnitude);
    world.pause(); world.step(1 / rate);
    assert.equal(calls, totalFrames);
    world.reset();
    world.stats.complete = true;
    world.setMuzzleProvider(({ targetPoint }) => { assert.equal(targetPoint, null); calls++; return null; });
    world.step(1 / rate);
    assert.equal(calls, totalFrames + 1, 'completed worlds must still advance presentation poses');
  }
});

test('a variable-length Update fires only after its accumulated cooldown and discards attack overshoot', () => {
  const world = stationaryTargetWorld();
  const received = [];
  world.setMuzzleProvider(({ dt }) => { received.push(dt); return { x: 0, z: 1.8 }; });
  const deltas = [0.23, 0.23, 0.23, 0.23, 0.23, 0.23];
  const shotCounts = [];
  for (const dt of deltas) {
    world.step(dt);
    shotCounts.push(world.drainEvents().filter(event => event.type === 'shot').length);
  }
  assert.deepEqual(received, deltas, 'each supplied frame must advance the pose exactly once with its own dt');
  assert.deepEqual(shotCounts, [0, 0, 1, 0, 0, 1]);
  assert.equal(world.attackClock, 0, 'Cat.Update resets AtkCool_Now to zero after an attack, rather than preserving overshoot');
  approximately(world.stats.elapsed, 1.38);
});

test('a muzzle provider survives restart and rejects stale or non-finite samples', () => {
  const world = stationaryTargetWorld();
  let calls = 0;
  world.setMuzzleProvider(() => { calls++; return { x: NaN, z: 4 }; });
  const first = advance(world, C.attackInterval).find(event => event.type === 'shot');
  assert.ok(first);
  approximately(first.position.x, 0);
  approximately(first.position.z, C.muzzleDistance);
  world.reset();
  const before = calls;
  world.step(C.referenceFrameStep);
  assert.equal(calls, before + 1, 'restart keeps the installed pose adapter');
  world.setMuzzleProvider(null);
  world.step(C.referenceFrameStep);
  assert.equal(calls, before + 1);
});

