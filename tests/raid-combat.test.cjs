const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, RaidBossCombat, raidBossHealth, createRaidDefinition, createStageDefinition,
  getWeapon, DecimalAmount: D, COMBAT_CONFIG: C } = require('./.build/core/index.js');
const { sweepSphereSphere, closestPointOnSphere } = require('./.build/core/RaidCollision.js');

function fixture(type = 'SINGLE', damage = '10000000', fields = {}) {
  const boss = new RaidBossCombat(0), world = new CombatWorld(41, createRaidDefinition(boss));
  world.setLoadout([{ actorIndex: 0, weapon: { ...getWeapon(0), type, explosionRadius: 8, missileExplosionRadius: 8,
    blastSniperExplosionRadius: 8, missileSpeed: 35, pelletCount: 3, shotgunSpreadAngle: 0, ...fields },
    damage: D.from(damage), damagePrecision: D.from(damage).digits.length, attackInterval: .6 }]);
  world.setMuzzleOffset({ x: 0, z: 0 });
  world.player.aim = { x: -Math.SQRT1_2, z: Math.SQRT1_2 };
  return { boss, world };
}
function fire(world) {
  world.spread = 0;
  assert.equal(world.fire(), true);
  return world.bullets.filter(b => b.damaging).at(-1);
}

test('Raid HP caches p3 growth but exposes p2; it has no table boundary', () => {
  // 10m *3: the internal 2430m -> 7290m -> 21800m progression must not
  // feed the displayed 2400m back into the next multiplication.
  for (const [layer, expected] of [[0, '10000000'], [1, '30000000'], [2, '90000000'],
    [3, '270000000'], [5, '2400000000'], [6, '7200000000'], [7, '21000000000']]) {
    const actual = raidBossHealth(layer);
    assert.equal(actual.amount.toString(), expected); assert.equal(actual.precision, 2);
  }
  assert.ok(raidBossHealth(5001).amount.compare(raidBossHealth(5000).amount) > 0);
  assert.throws(() => raidBossHealth(-1)); assert.throws(() => raidBossHealth(1.5));
  assert.throws(() => new RaidBossCombat(5));
});

test('same Raid target synchronously respawns full health and discards every overkill remainder', () => {
  const boss = new RaidBossCombat(4), collider = boss.collider;
  assert.equal(boss.level, 1); assert.equal(boss.clearedLevels, 0);
  boss.hit(D.from(1), 1);
  assert.equal(boss.health.toString(), '10000000', 'weak p1 damage is lost at the original p2 alignment');
  const hit = boss.hit(D.from('999999999999'), 12);
  assert.equal(hit.defeated, true); assert.equal(hit.health.isZero, true);
  assert.equal(boss.clearedLevels, 1); assert.equal(boss.level, 2);
  assert.equal(boss.health.toString(), '30000000'); assert.equal(boss.healthPrecision, 2);
  assert.equal(boss.alive, true); assert.equal(boss.collider, collider);
  boss.hit(D.from('1000000'), 7);
  assert.equal(boss.health.toString(), '29000000'); assert.equal(boss.healthPrecision, 7);
  assert.ok(Math.abs(boss.healthRatio - 29 / 30) < 1e-8);
  boss.hit(D.from('29000000'), 8);
  assert.equal(boss.level, 3); assert.equal(boss.health.toString(), '90000000');
  assert.equal(boss.healthPrecision, 2, 'respawn uses a fresh p2 layer rather than previous-hit precision');
});

test('one physics batch can clear successive layers without completing a tree round or paying gold', () => {
  const { boss, world } = fixture('SINGLE', '90000000'), collider = boss.collider;
  fire(world); fire(world); fire(world);
  world.updateBullets(.5);
  assert.equal(boss.clearedLevels, 3); assert.equal(boss.health.toString(), '270000000');
  assert.equal(world.stats.hits, 3); assert.equal(world.stats.kills, 3); assert.equal(world.stats.complete, false);
  assert.equal(world.trees.length, 0); assert.equal(world.damageTargets[0], boss); assert.equal(boss.collider, collider);
  const events = world.drainEvents();
  assert.equal(events.filter(e => e.type === 'hit').length, 3);
  assert.equal(events.some(e => e.type === 'complete' || e.type === 'treeDied'), false);
  assert.equal(world.findAutoTarget(), boss, 'a clear retains a live target for the next rendered frame');
});

test('Raid HitLaser and HitPierce both stop on their first hit, including a layer clear', () => {
  for (const type of ['LASER', 'PIERCE']) for (const damage of ['1000000', '10000000']) {
    const { boss, world } = fixture(type, damage), bullet = fire(world);
    world.updateBullets(.5);
    assert.equal(bullet.damaging, false); assert.deepEqual(bullet.hitIds, [boss.id]);
    assert.equal(bullet.pierceCount, type === 'PIERCE' ? 1 : 0);
    assert.equal(boss.clearedLevels, damage === '10000000' ? 1 : 0);
    const health = boss.health.toString();
    bullet.position = { x: -100, z: 0 }; world.updateBullets(.5);
    assert.equal(boss.health.toString(), health);
    assert.equal(world.drainEvents().filter(e => e.type === 'hit').length, 1);
  }
});

test('shotgun, explosive, missile and first blast-sniper explosion retain their own hit paths', () => {
  for (const type of ['SHOTGUN', 'EXPLOSIVE', 'MISSILE', 'BLAST_SNIPER']) {
    const { boss, world } = fixture(type, '90000000');
    if (type === 'MISSILE') world.player.targetId = boss.id;
    fire(world);
    if (type === 'MISSILE') world.updateMissiles(1.2); else world.updateBullets(.5);
    assert.equal(boss.clearedLevels, type === 'SHOTGUN' ? 3 : 1, type);
    assert.equal(world.stats.complete, false);
    assert.equal(world.drainEvents().some(e => e.type === 'treeDied'), false);
  }
});

test('Raid missiles snapshot the collider transform height and retain it through a map switch', () => {
  const { boss, world } = fixture('MISSILE');
  world.player.targetId = boss.id;
  const bullet = fire(world), height = boss.sphereCollider.transformY;
  assert.equal(bullet.missileTargetHeight, height);
  world.setBattlefieldActive(false);
  world.updateMissiles(.1);
  let t = bullet.age / bullet.missileDuration;
  assert.ok(Math.abs(bullet.height - (C.bulletHeight * (1 - t) + height * t + 4 * t * (1 - t) * bullet.missileArcHeight)) < 1e-10);
  world.reset(2, createStageDefinition(0, 0, 2), { preserveActorState: true, preserveProjectiles: true });
  world.setBattlefieldActive(false);
  world.updateMissiles(.1);
  t = bullet.age / bullet.missileDuration;
  assert.equal(bullet.missileTargetHeight, height);
  assert.ok(Math.abs(bullet.height - (C.bulletHeight * (1 - t) + height * t + 4 * t * (1 - t) * bullet.missileArcHeight)) < 1e-10);
  world.updateMissiles(bullet.missileDuration);
  assert.equal(bullet.damaging, false); assert.equal(bullet.height, height);
  assert.equal(boss.clearedLevels, 0);
});

test('Raid damage numbers preserve the sphere surface height for direct hits, blasts and post-timeout text', () => {
  for (const type of ['SINGLE', 'EXPLOSIVE', 'MISSILE']) for (const stopped of [false, true]) {
    const { boss, world } = fixture(type, '1000000');
    if (type === 'MISSILE') world.player.targetId = boss.id;
    fire(world);
    if (stopped) world.stopCombat();
    if (type === 'MISSILE') world.updateMissiles(1.2); else world.updateBullets(.5);
    const events = world.drainEvents(), hit = events.find(e => e.type === (stopped ? 'damageText' : 'hit'));
    assert.ok(hit, `${type}, stopped=${stopped}`);
    assert.ok(Number.isFinite(hit.height)); assert.notEqual(hit.height, C.bulletHeight);
    assert.ok(Math.abs(events.find(e => e.type === 'impact').height - hit.height) < 1e-7,
      'impact particles and damage text share the surface height');
    const distanceToCenter = Math.hypot(hit.position.x + 120, hit.height - boss.sphereCollider.centerY, hit.position.z - 20);
    assert.ok(Math.abs(distanceToCenter - boss.sphereCollider.radius) < 1e-7);
    if (stopped) assert.equal(boss.health.toString(), '10000000');
  }
});

test('source sphere collider catches round edges and high missiles without AABB corner hits', () => {
  const boss = new RaidBossCombat(0), centerY = 4.550000190734863;
  assert.equal(boss.sphereCollider.radius, 12); assert.equal(boss.sphereCollider.centerY, centerY);
  const center = { x: -120, y: centerY, z: 20 };
  assert.equal(sweepSphereSphere({ x: -132, y: 2, z: 0 }, { x: -132, y: 2, z: 40 }, 0, center, 12), null,
    'the outer AABB edge is outside the y2 sphere cross-section');
  const actual = sweepSphereSphere({ x: -120, y: 2, z: 0 }, { x: -120, y: 2, z: 40 }, 0, center, 12);
  const expected = (20 - Math.sqrt(144 - (2 - centerY) ** 2)) / 40;
  assert.ok(Math.abs(actual - expected) < 1e-10);
  assert.notEqual(sweepSphereSphere({ x: -120, y: 15, z: 0 }, { x: -120, y: 15, z: 40 }, .1, center, 12), null);
  assert.equal(sweepSphereSphere({ x: -120, y: 18, z: 0 }, { x: -120, y: 18, z: 40 }, .1, center, 12), null);
  const point = closestPointOnSphere({ x: -100, z: 0 }, 2, boss);
  assert.ok(Math.abs(Math.hypot(point.x - center.x, point.y - center.y, point.z - center.z) - 12) < 1e-10);
});

test('Raid capsule-body collision uses the round 13.5-radius boundary and keeps the arena open', () => {
  const { boss, world } = fixture();
  assert.equal(world.stage.mapLayout, 'raid'); assert.deepEqual(world.stage.mapOrigin, { x: -100, z: 0 });
  assert.deepEqual(world.stage.bulletWalls, []); assert.equal(world.stage.bounds.maxX, Infinity);
  world.player.position = { x: -120, z: 0 }; world.moveAndSlide({ x: 0, z: 40 });
  assert.ok(world.player.position.z < 6.501); assert.ok(world.player.position.z > 6.48);
  world.player.position = { x: -132, z: 8 }; world.resolveBodyOverlap(world.player);
  assert.deepEqual(world.player.position, { x: -132, z: 8 }, 'AABB corner stays walkable');
  world.player.position = { ...boss.position }; world.resolveBodyOverlap(world.player);
  assert.ok(Math.hypot(world.player.position.x + 120, world.player.position.z - 20) >= 13.5);
  world.player.position = { x: -70, z: 0 }; world.moveAndSlide({ x: 0, z: 1000 });
  assert.equal(world.player.position.z, 1000);
});

test('Raid timeout/loading block HP and score, preserve global shots, and return to the Main target pool', () => {
  const { boss, world } = fixture('LASER'), impactBullet = fire(world);
  world.player.aim = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
  const bullet = fire(world);
  const deadline = world.bulletTimeouts.get(bullet.id), state = boss.snapshot();
  world.stopCombat(); world.updateBullets(.5);
  assert.deepEqual(boss.snapshot(), state);
  assert.equal(impactBullet.damaging, false, 'timeout still lets HitLaser stop the shot without damaging the boss');
  assert.equal(bullet.damaging, true, 'a shot travelling away remains in the global pool');
  assert.equal(world.drainEvents().some(e => e.type === 'hit' || e.type === 'treeDied' || e.type === 'complete'), false);
  world.setBattlefieldActive(false);
  bullet.position = { x: -100, z: 0 }; bullet.hitIds.length = 0; world.updateBullets(.5);
  assert.equal(bullet.damaging, true); assert.deepEqual(boss.snapshot(), state);
  world.reset(2, createStageDefinition(0, 0, 2), { preserveActorState: true, preserveProjectiles: true });
  assert.equal(world.stage.raidBoss, undefined); assert.equal(world.damageTargets, world.trees);
  assert.equal(world.bulletTimeouts.get(bullet.id), deadline); assert.equal(bullet.damaging, true);
  assert.deepEqual(world.player.position, { x: 0, z: 0 });
});

test('three live actors approach the sphere, keep firing and never switch into completed-tree behavior', () => {
  const { boss, world } = fixture();
  world.setLoadout([0, 1, 2].map(actorIndex => ({ actorIndex, weapon: getWeapon(0), damage: D.from('10000000000'),
    damagePrecision: 11, attackInterval: .05 })));
  const actors = new Set();
  for (let frame = 0; frame < 600; frame++) {
    world.step(1 / 60);
    for (const event of world.drainEvents()) if (event.type === 'hit') actors.add(event.actorId);
  }
  assert.deepEqual([...actors].sort(), [0, 1, 2]);
  assert.ok(boss.clearedLevels >= 10); assert.ok(world.stats.hits > 100); assert.equal(world.stats.complete, false);
  for (const player of world.players) assert.ok(Math.hypot(player.position.x + 120, player.position.z - 20) >= 13.5 - 1e-6);
});
