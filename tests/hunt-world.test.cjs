const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, HuntCombat, createHuntDefinition, createStageDefinition, getWeapon, DecimalAmount: D,
  COMBAT_CONFIG: C, HUNT_CENTER } = require('./.build/core/index.js');
const { closestPointOnHuntCapsule, insideHuntCapsule, sweepSphereHuntCapsule } = require('./.build/core/HuntCollision.js');
const close = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function battle(type = 'SINGLE', damage = 100) {
  const hunt = new HuntCombat(0, 0, 81); hunt.startLevel();
  const enemy = hunt.enemies.find(e => e.alive); enemy.position = { x: -100, z: 30 }; enemy.velocity = { x: 0, z: 0 };
  enemy.inwardVelocity = { x: 0, z: 0 };
  const world = new CombatWorld(31, createHuntDefinition(hunt));
  world.setLoadout([{ actorIndex: 0, weapon: { ...getWeapon(0), type, explosionRadius: 8, missileExplosionRadius: 8,
    blastSniperExplosionRadius: 8, pelletCount: 3, shotgunSpreadAngle: 0, missileSpeed: 35 },
    damage: D.from(damage), damagePrecision: String(damage).length, attackInterval: .6 }]);
  world.player.aim = { x: 0, z: 1 }; world.player.targetId = enemy.id;
  world.nearHitPoint = { ...enemy.position }; world.setMuzzleOffset({ x: 0, z: 0 });
  return { hunt, enemy, world };
}
function fire(world) { world.spread = 0; assert.equal(world.fire(), true); return world.bullets.filter(b => b.damaging).at(-1); }

test('Hunt has an open map and its own Damageable pool without tree economy', () => {
  const { hunt, world } = battle();
  assert.equal(world.hunt, hunt); assert.equal(world.damageTargets, hunt.enemies);
  assert.equal(world.stage.mapLayout, 'hunt'); assert.deepEqual(world.stage.mapOrigin, { x: -100, z: 0 });
  assert.deepEqual(world.trees, []); assert.deepEqual(world.stage.bulletWalls, []); assert.equal(world.stage.bounds.maxX, Infinity);
  assert.equal(world.stats.totalTrees, 0); assert.equal(world.stats.complete, false);
});

test('capsule sweeps use curved vertical caps and ignore empty AABB corners', () => {
  const { enemy } = battle(); enemy.position = { x: 0, z: 0 };
  const from = { x: 0, y: 2, z: -10 }, to = { x: 0, y: 2, z: 10 };
  const reach = Math.sqrt(2.7 ** 2 - .15 ** 2);
  close(sweepSphereHuntCapsule(from, to, .6, enemy), (10 - reach) / 20);
  assert.equal(sweepSphereHuntCapsule({ x: 2, y: 5, z: 2 }, { x: 3, y: 5, z: 3 }, 0, enemy), null);
  assert.equal(sweepSphereHuntCapsule({ x: 0, y: 11, z: -10 }, { x: 0, y: 11, z: 10 }, .6, enemy), null);
  close(sweepSphereHuntCapsule({ x: 0, y: 20, z: 0 }, { x: 0, y: 0, z: 0 }, .6, enemy), (20 - 10.65) / 20);
  assert.equal(insideHuntCapsule({ x: 0, z: 0 }, 0, enemy), false);
  assert.equal(insideHuntCapsule({ x: 0, z: 0 }, 2, enemy), true);
  const surface = closestPointOnHuntCapsule({ x: 0, z: 0 }, 20, enemy); close(surface.y, 10.05);
  assert.deepEqual(closestPointOnHuntCapsule({ x: 1, z: 0 }, 5, enemy), { x: 1, y: 5, z: 0 });
});

test('all seven weapon types hit Hunt capsules through existing ballistics and emit no tree/main results', () => {
  for (const type of ['SINGLE', 'LASER', 'PIERCE', 'SHOTGUN', 'EXPLOSIVE', 'MISSILE', 'BLAST_SNIPER']) {
    const { hunt, enemy, world } = battle(type), bullet = fire(world);
    if (type === 'MISSILE') world.updateMissiles(2); else world.updateBullets(.7);
    const events = world.drainEvents(), hits = events.filter(e => e.type === 'hit');
    assert.equal(hits.length, type === 'SHOTGUN' ? 3 : 1, type);
    assert.equal(enemy.health.toString(), type === 'SHOTGUN' ? '200' : '400', type);
    assert.equal(events.some(e => ['treeDied', 'bossDied', 'complete'].includes(e.type)), false, type);
    assert.equal(hunt.kills, 0); assert.equal(world.stats.complete, false);
    if (type === 'LASER' || type === 'PIERCE') assert.equal(bullet.damaging, true, type);
    assert.ok(hits.every(e => Number.isFinite(e.height)), `capsule contact height: ${type}`);
    assert.ok(bullet.hitIds.includes(enemy.id), `stable collider identity: ${type}`);
  }
});

test('Hunt deaths deactivate colliders and completing a level never invokes Main completion/rewards', () => {
  const { hunt, enemy, world } = battle('SHOTGUN', 500); fire(world); world.updateBullets(.7);
  assert.equal(enemy.alive, false); assert.equal(hunt.kills, 1); assert.equal(world.stats.kills, 1);
  let events = world.drainEvents();
  assert.equal(events.filter(e => e.type === 'huntMonsterDied').length, 1);
  assert.equal(events.filter(e => e.type === 'hit').length, 1);
  assert.equal(events.some(e => e.type === 'damageText'), false, 'inactive monster cannot receive later pellets');
  while (hunt.kills < hunt.total) {
    hunt.update(.04);
    const next = hunt.enemies.find(e => e.alive); assert.ok(next);
    world.hitTree(next, next.position, next.maxHealth); events.push(...world.drainEvents());
  }
  assert.equal(hunt.completed, false); hunt.update(.04); events.push(...world.drainEvents());
  assert.equal(events.filter(e => e.type === 'huntLevelComplete').length, 1);
  assert.equal(events.some(e => ['treeDied', 'bossDied', 'complete'].includes(e.type)), false);
  assert.equal(world.stats.complete, false); assert.equal(world.combatStopped, false, 'LevelClear keeps source is_Play true');
  assert.equal(world.stats.kills, 90); assert.equal(hunt.wave, 0); assert.equal(hunt.level, 0);
});

test('barrier failure freezes combat before remaining physics contacts and emits one failure', () => {
  const { hunt, enemy, world } = battle(); fire(world);
  enemy.position = { x: -100, z: 16.9 }; world.player.velocity = { x: 5, z: 0 };
  world.step(C.physicsStep); assert.equal(hunt.failed, true); assert.equal(world.combatStopped, true);
  assert.deepEqual(world.player.velocity, { x: 0, z: 0 }); assert.equal(hunt.barrierHp, 0);
  const events = world.drainEvents(); assert.equal(events.filter(e => e.type === 'huntFailed').length, 1);
  assert.equal(events.some(e => ['hit', 'complete', 'treeDied', 'huntLevelComplete'].includes(e.type)), false);
  world.step(.3); assert.equal(world.drainEvents().some(e => e.type === 'huntFailed'), false);
});

test('60 rays see narrow targets missed by Main rays and reach beyond its 40-unit range', () => {
  const { enemy, world } = battle(); world.setViewport(2);
  // A target at 6 degrees and radius58 is missed by both adjacent 10-degree Main rays.
  const angle = Math.PI / 30; enemy.position = { x: -100 + Math.sin(angle) * 58, z: Math.cos(angle) * 58 };
  const hitPoint = { x: 0, z: 0 };
  assert.equal(world.findRayTarget(world.player, hitPoint), enemy);
  assert.ok(Math.hypot(hitPoint.x + 100, hitPoint.z) > 40);
  enemy.position = { x: -100, z: 63 }; assert.equal(world.findRayTarget(), undefined, 'capsule is beyond range60');
});

test('off-screen ray colliders guide all cats toward their radial point but cannot be attacked', () => {
  const { enemy, world } = battle();
  world.setLoadout([0, 1, 2].map(actorIndex => ({ actorIndex, weapon: getWeapon(0), damage: D.from(100), attackInterval: .6 })));
  enemy.position = { x: -50, z: 0 }; world.setViewport(.4);
  assert.equal(world.isVisible(enemy), false);
  for (const player of world.players) {
    player.position = { ...HUNT_CENTER }; player.targetId = world.findRayTarget(player, { x: 0, z: 0 })?.id ?? null;
    assert.equal(player.targetId, null);
    world.moveHuntCat(player, .1, player.actorId ? 17 : 15);
    assert.ok(player.velocity.x > 0); close(player.velocity.z, 0);
  }
  world.updateFollowers(.1); assert.equal(world.drainEvents().some(e => e.type === 'shot'), false);
  world.huntOffscreenTargets.clear(); world.player.position = { x: -90, z: 0 }; world.player.velocity = { x: 0, z: 0 };
  world.autoSmoothVelocity = { x: 0, z: 0 }; world.movePlayer(.1);
  assert.ok(world.player.velocity.x < 0, 'with no ray targets returns to center');
});

test('Hunt main cat retains its valid auto attack lock and manual input adopts the latest ray target', () => {
  const { hunt, enemy, world } = battle(); hunt.update(.04);
  const next = hunt.enemies.find(e => e.alive && e !== enemy); assert.ok(next);
  next.position = { x: -100, z: 20 }; next.velocity = { x: 0, z: 0 };
  world.resolveAttackTarget(); assert.equal(world.lockedAttackTargetId, enemy.id);
  world.player.targetId = world.findRayTarget()?.id ?? null; assert.equal(world.player.targetId, next.id);
  world.resolveAttackTarget(); assert.equal(world.player.targetId, enemy.id);
  assert.deepEqual(world.nearHitPoint, enemy.position, 'leader aims at collider transform, not last ray contact');
  world.setMovementInput({ x: 1, y: 0 }); world.player.targetId = next.id;
  world.resolveAttackTarget(); assert.equal(world.player.targetId, next.id); assert.equal(world.lockedAttackTargetId, next.id);
  world.setMovementInput({ x: 0, y: 0 }); world.player.targetId = enemy.id; next.alive = false;
  world.resolveAttackTarget(); assert.equal(world.player.targetId, enemy.id); assert.equal(world.lockedAttackTargetId, enemy.id);
  enemy.position = { x: -30, z: 0 }; world.player.targetId = null;
  world.resolveAttackTarget(); assert.equal(world.player.targetId, null); assert.equal(world.lockedAttackTargetId, null);
});

test('Hunt follower retains the source collider reference until its next ray scan, while inactive monsters cannot take damage', () => {
  const { hunt, enemy, world } = battle();
  world.setLoadout([0, 1].map(actorIndex => ({ actorIndex, weapon: getWeapon(0), damage: D.from(500), attackInterval: .6 })));
  const follower = world.followers[0]; follower.player.targetId = enemy.id; follower.nearHitPoint = { ...enemy.position };
  follower.previouslyHadTarget = true; follower.searchTimer = 0; follower.attackClock = 0;
  world.hitTree(enemy, enemy.position, enemy.maxHealth); world.drainEvents();
  world.updateFollowers(.04); assert.equal(follower.player.targetId, enemy.id);
  world.updateFollowers(.04); assert.equal(follower.player.targetId, enemy.id);
  assert.equal(hunt.hit(enemy.id, D.from(500)).damaged, false);
  world.updateFollowers(.02); assert.equal(follower.player.targetId, null);
  assert.equal(hunt.kills, 1); assert.deepEqual(world.drainEvents(), []);
});

test('manual and automatic cats stay within radius14; outward velocity is removed while tangent/inward velocity survives', () => {
  const { world } = battle();
  world.player.position = { x: -86, z: 0 }; world.player.velocity = { x: 8, z: 3 };
  world.constrainHuntCat(world.player); close(world.player.velocity.x, 0); close(world.player.velocity.z, 3);
  world.player.velocity = { x: -8, z: 3 }; world.constrainHuntCat(world.player); close(world.player.velocity.x, -8);
  world.moveAndSlide({ x: 100, z: 50 }); close(Math.hypot(world.player.position.x + 100, world.player.position.z), 14);
  world.setMovementInput({ x: 1, y: 0 });
  for (let i = 0; i < 100; i++) { world.moveManually(); world.moveAndSlide({ x: world.player.velocity.x * .02, z: world.player.velocity.z * .02 }); }
  assert.ok(Math.hypot(world.player.position.x + 100, world.player.position.z) <= 14 + 1e-8);
});

test('level restart keeps the existing world cats and global projectile ledger, scene exit removes Hunt colliders', () => {
  const { hunt, enemy, world } = battle('LASER'); const bullet = fire(world); world.updateBullets(.5);
  assert.ok(bullet.hitIds.includes(enemy.id)); const position = { ...world.player.position };
  world.stopCombat(); hunt.startLevel(0, 1); world.startCombat();
  assert.deepEqual(world.player.position, position); assert.equal(bullet.damaging, true); assert.ok(bullet.hitIds.includes(enemy.id));
  assert.equal(world.hunt, hunt); assert.equal(world.damageTargets.length, 240);
  world.setBattlefieldActive(false); const hp = hunt.enemies.find(e => e.alive).health;
  world.updateBullets(.7); assert.equal(hunt.enemies.find(e => e.alive).health, hp);
  world.reset(3, createStageDefinition(0, 0, 3), { preserveActorState: true, preserveProjectiles: true });
  assert.equal(world.hunt, undefined); assert.equal(world.damageTargets, world.trees);
});

test('three autonomous cats clear live moving Hunt targets at 30/60/120fps without crossing the barrier circle', () => {
  for (const fps of [30, 60, 120]) {
    const hunt = new HuntCombat(0, 0, 100), world = new CombatWorld(50, createHuntDefinition(hunt));
    world.setLoadout([0, 1, 2].map(actorIndex => ({ actorIndex, weapon: getWeapon(0), damage: D.from(5000), attackInterval: .05 })));
    hunt.startLevel(); let completed = 0;
    for (let frame = 0; frame < fps * 60 && !hunt.completed && !hunt.failed; frame++) {
      world.step(1 / fps);
      for (const player of world.players) assert.ok(Math.hypot(player.position.x + 100, player.position.z) <= 14 + 1e-8);
      const events = world.drainEvents(); completed += events.filter(e => e.type === 'huntLevelComplete').length;
      assert.equal(events.some(e => e.type === 'treeDied' || e.type === 'complete'), false);
    }
    assert.equal(hunt.completed, true, `${fps}fps`); assert.equal(hunt.failed, false);
    assert.equal(hunt.kills, 90); assert.equal(completed, 1); assert.equal(world.stats.complete, false);
  }
});

test('Hunt clear banner keeps cats returning to center, cooldowns and projectiles alive without spawning or rewarding again', () => {
  for (const fps of [30, 60, 120]) {
    const { hunt, world } = battle();
    world.setLoadout([0, 1, 2].map(actorIndex => ({ actorIndex, weapon: getWeapon(0), damage: D.from(500), attackInterval: .6 })));
    while (!hunt.completed) {
      for (const monster of hunt.enemies.filter(e => e.alive)) world.hitTree(monster, monster.position, monster.maxHealth);
      hunt.update(.04); world.drainEvents();
    }
    for (const [index, player] of world.players.entries()) {
      player.position = { x: -100 + 10 + index, z: 0 }; player.velocity = { x: 0, z: 1 }; player.targetId = null;
    }
    const bullet = fire(world), originalAge = bullet.age, spawned = hunt.spawned, kills = hunt.kills;
    const clocks = [world.attackClock, ...world.followers.map(f => f.attackClock)], shots = world.stats.shots;
    world.drainEvents();
    world.advanceHuntIntermission(1 / fps);
    assert.ok(world.player.position.x > -91, 'intermission does not warp the cat to center');
    assert.ok(bullet.age >= originalAge, 'global projectile advances on its normal physics clock');
    for (let frame = 1; frame < fps * 2; frame++) world.advanceHuntIntermission(1 / fps);
    // The two followers keep source separation avoidance around the leader.
    for (const player of world.players) assert.ok(Math.hypot(player.position.x + 100, player.position.z) < C.separationRadius, `${fps}fps actor${player.actorId}`);
    const nextClocks = [world.attackClock, ...world.followers.map(f => f.attackClock)];
    nextClocks.forEach((clock, index) => close(clock, clocks[index] + 2));
    assert.equal(world.stats.shots, shots); assert.equal(hunt.spawned, spawned); assert.equal(hunt.kills, kills);
    assert.equal(hunt.running, false); assert.equal(hunt.activeCount, 0); assert.deepEqual(world.drainEvents(), []);
    hunt.startLevel(0, 1); const position = { ...world.player.position }; world.advanceHuntIntermission(.3);
    assert.deepEqual(world.player.position, position, 'live levels reject intermission updates');
  }
});
