const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, createStageDefinition, DecimalAmount: D, getWeapon } = require('./.build/core/index.js');

test('automatic wave changes warp existing cats without rerolling AI or resetting attack/search clocks', () => {
  const world = new CombatWorld(42);
  const loadout = [0, 1, 2].map(actorIndex => ({ actorIndex, weapon: getWeapon(0), damage: D.from(100), attackInterval: .6 }));
  world.setLoadout(loadout);
  world.attackClock = .41; world.attackSearchTimer = .12; world.autoSearchTimer = .09;
  const first = world.followers[0], second = world.followers[1];
  first.attackClock = .27; first.searchTimer = .13; second.attackClock = .38;
  first.player.targetId = 5; first.player.position = {x: 14, z: 88}; first.player.velocity = {x: 4, z: 6};
  const lag = first.lag, speed = first.speedMultiplier;
  world.reset(999, createStageDefinition(0, 1, 999), true);
  world.setLoadout(loadout);
  assert.equal(world.attackClock, .41); assert.equal(world.attackSearchTimer, .12); assert.equal(world.autoSearchTimer, .09);
  assert.equal(world.followers[0], first); assert.equal(world.followers[1], second);
  assert.equal(first.attackClock, .27); assert.equal(first.searchTimer, .13); assert.equal(second.attackClock, .38);
  assert.equal(first.lag, lag); assert.equal(first.speedMultiplier, speed);
  assert.equal(first.player.targetId, null); assert.deepEqual(first.player.velocity, {x: 0, z: 0});
  assert.deepEqual(first.player.position, first.formationOffset);
  assert.equal(world.trees.length, 60);
});

test('rebirth preserves actor instances, cooldowns and target-transition memory while clearing old references', () => {
  const world = new CombatWorld(42);
  const loadout = [0, 1, 2].map(actorIndex => ({ actorIndex, weapon: getWeapon(0), damage: D.from(100), attackInterval: .6 }));
  world.setLoadout(loadout);
  world.attackClock = .41; world.attackSearchTimer = .12; world.autoSearchTimer = .09;
  world.previouslyHadTarget = true; world.autoTargetId = world.lockedAttackTargetId = 4;
  const player = world.player, follower = world.followers[0];
  follower.attackClock = .27; follower.searchTimer = .13; follower.previouslyHadTarget = true;
  follower.player.targetId = 5; player.targetId = 4; player.moving = true;
  const poses = [];
  world.setMuzzleProvider(pose => { poses.push(pose); return { x: 0, z: 0 }; });
  world.beginRebirth();
  assert.equal(player.targetId, null); assert.equal(player.moving, false);
  assert.equal(world.previouslyHadTarget, true); assert.equal(world.attackClock, .41);
  world.advanceEffects(.1); assert.equal(world.attackClock, .41);
  assert.equal(poses.filter(pose => pose.dt === .1).length, 3, 'procedural hand/face poses continue for every cat during FX');
  world.reset(1000, createStageDefinition(0, 0, 1000), { preserveActorState: true, rebirth: true });
  assert.equal(world.player, player); assert.equal(world.followers[0], follower);
  assert.equal(world.attackClock, .41); assert.equal(world.attackSearchTimer, .12); assert.equal(world.autoSearchTimer, 0);
  assert.equal(world.previouslyHadTarget, true); assert.equal(follower.previouslyHadTarget, true);
  assert.equal(follower.attackClock, .27); assert.equal(follower.searchTimer, .13);
  assert.equal(follower.player.targetId, null); assert.equal(world.autoTargetId, null); assert.equal(world.lockedAttackTargetId, null);
  assert.deepEqual(world.drainEvents(), []);
  world.step(1 / 60);
  assert.ok(world.attackClock > .41, 'first reacquisition keeps an already-targeting leader cooldown');
  assert.notEqual(world.player.targetId, null, 'leader performs the due ray search on its first new frame');
});

test('rebirth uses original follower SmoothStop while freezing AI and attack clocks', () => {
  const world = new CombatWorld(42);
  world.setLoadout([0, 1, 2].map(actorIndex => ({ actorIndex, weapon: getWeapon(0), damage: D.from(100), attackInterval: .6 })));
  for (const tree of world.trees) tree.alive = false;
  const follower = world.followers[0], slow = world.followers[1];
  world.player.velocity = { x: 10, z: 0 }; world.player.moving = true;
  follower.player.velocity = { x: 10, z: 5 }; follower.player.moving = true;
  slow.player.velocity = { x: .05, z: 0 }; slow.player.moving = true;
  follower.attackClock = .27; follower.searchTimer = .13; follower.stateTime = .2;
  const before = { ...follower.player.position }, poses = [];
  world.setMuzzleProvider(pose => { poses.push({ actorId: pose.actorId, moving: pose.player.moving }); return { x: 0, z: 0 }; });
  world.beginRebirth();
  assert.deepEqual(world.player.velocity, { x: 0, z: 0 });
  assert.deepEqual(follower.player.velocity, { x: 10, z: 5 }, 'FX activation does not instantly zero AI velocity');
  world.advanceEffects(.05);
  assert.ok(follower.player.position.x > before.x && follower.player.position.z > before.z, 'fixed physics keeps integrating residual motion');
  assert.deepEqual(follower.player.velocity, { x: 6, z: 3 }, 'SmoothStop lerps by 8 times deltaTime');
  assert.equal(follower.player.moving, true);
  assert.deepEqual(slow.player.velocity, { x: 0, z: 0 }); assert.equal(slow.player.moving, false, 'source squared-speed threshold snaps to idle');
  assert.ok(poses.some(pose => pose.actorId === 1 && pose.moving), 'walk animation remains active during deceleration');
  assert.equal(follower.attackClock, .27); assert.equal(follower.searchTimer, .13); assert.equal(follower.stateTime, .2);
  assert.equal(world.stats.shots, 0);
});

test('rebirth retains the global projectile pool and old shot damage until its original timeout', () => {
  const world = new CombatWorld(42);
  world.trees.length = 0;
  world.frameTime = 1.8;
  world.setLoadout([{ actorIndex: 0, weapon: getWeapon(0), damage: D.from(800), attackInterval: .6 }]);
  world.setMuzzleOffset({ x: 0, z: 0 }); world.player.aim = { x: 0, z: 1 };
  assert.equal(world.fire(), true);
  const bullet = world.bullets.find(bullet => bullet.damaging);
  world.beginRebirth(); world.advanceEffects(.1);
  const time = world.simulationTime, position = { ...bullet.position }, deadline = world.bulletTimeouts.get(bullet.id);
  const stage = createStageDefinition(0, 0, 999), z = position.z + 1;
  stage.trees = [{ id: 0, position: { x: 0, z }, degree: 0, stageIndex: 0, reward: D.from(20),
    health: D.from(2000), maxHealth: D.from(2000), alive: true,
    collider: { minX: -.5, maxX: .5, minZ: z - .5, maxZ: z + .5 } }];
  world.reset(999, stage, { rebirth: true });
  world.setLoadout([{ actorIndex: 0, weapon: getWeapon(0), damage: D.from(100), attackInterval: .6 }]);
  assert.equal(bullet.damaging, true); assert.deepEqual(bullet.position, position);
  assert.equal(world.simulationTime, time); assert.equal(world.bulletTimeouts.get(bullet.id), deadline);
  world.step(.02);
  assert.equal(world.trees[0].health.toNumber(), 1200, 'a shot already in flight keeps its pre-reset damage');
  assert.equal(world.drainEvents().find(event => event.type === 'hit').damage.toNumber(), 800);

  const empty = new CombatWorld(7); empty.trees.length = 0; empty.frameTime = 8;
  empty.setMuzzleOffset({ x: 0, z: 0 }); empty.fire(); empty.beginRebirth(); empty.advanceEffects(.1);
  const live = empty.bullets.find(bullet => bullet.damaging), next = createStageDefinition(0, 0, 7); next.trees = [];
  empty.reset(7, next, { rebirth: true });
  for (let index = 0; index < 5; index++) empty.advanceEffects(.1);
  assert.equal(live.damaging, true, 'rebirth does not restart or drop the lifetime timer');
  empty.advanceEffects(.1);
  assert.equal(live.damaging, false, 'source Invoke expires at the original absolute deadline');
});

test('a surviving laser recognizes a reactivated collider slot across rebirth but hits an untouched slot', () => {
  const oldStage = createStageDefinition(2, 1, 42), firstStage = createStageDefinition(0, 0, 999);
  const oldTarget = oldStage.trees.find(tree => tree.id === 0);
  const reusedTarget = firstStage.trees.find(tree => tree.id === oldTarget.id);
  const untouchedTarget = firstStage.trees.find(tree => tree.id !== oldTarget.id);
  assert.notEqual(oldTarget, reusedTarget, 'simulation state objects are rebuilt but their original collider identity is stable');
  function place(tree, z, health) {
    tree.position = { x: 0, z }; tree.health = tree.maxHealth = D.from(health); tree.alive = true;
    tree.collider = { minX: -.5, maxX: .5, minZ: z - .5, maxZ: z + .5 };
  }
  for (const tree of oldStage.trees) tree.alive = false;
  place(oldTarget, 5, 1000);
  const world = new CombatWorld(42, oldStage);
  world.setLoadout([{ actorIndex: 0, weapon: { ...getWeapon(0), type: 'LASER' }, damage: D.from(100), attackInterval: .6 }]);
  world.setMuzzleOffset({ x: 0, z: 0 }); world.player.aim = { x: 0, z: 1 }; world.fire();
  world.updateBullets(.15);
  const bullet = world.bullets.find(bullet => bullet.damaging), z = bullet.position.z;
  assert.equal(oldTarget.health.toNumber(), 900); assert.deepEqual(bullet.hitIds, [oldTarget.id]);
  world.drainEvents();
  for (const tree of firstStage.trees) tree.alive = false;
  place(reusedTarget, z + 2, 2000); place(untouchedTarget, z + 4, 2000);
  world.reset(999, firstStage, { rebirth: true }); world.updateBullets(.15);
  assert.equal(reusedTarget.health.toNumber(), 2000, 'source Tree_list slot keeps the same Collider.GetInstanceID and remains in the shot ledger');
  assert.equal(untouchedTarget.health.toNumber(), 1900, 'the different pool slot is still damaged by the same laser');
  assert.deepEqual(world.drainEvents().filter(event => event.type === 'hit').map(event => event.treeId), [untouchedTarget.id]);
  assert.deepEqual(bullet.hitIds, [oldTarget.id, untouchedTarget.id]);
});
