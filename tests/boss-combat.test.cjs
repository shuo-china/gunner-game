const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, BossCombat, bossHealth, bossPathCrossesCat, createBossDefinition, createStageDefinition,
  getWeapon, DecimalAmount: D, COMBAT_CONFIG: C } = require('./.build/core/index.js');
const { boxLocal, boxWorld, closestPointOnOrientedBox, insideOrientedBox, sweepSphereOrientedBox,
  sweepCircleOrientedBox, separateCircleOrientedBox, sweepBoxOrientedBox } = require('./.build/core/BossCollision.js');
const fixture = require('./fixtures/boss-health-original.json');
const close = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function battle(type = 'SINGLE', damage = 1000, fields = {}) {
  const boss = new BossCombat(0, 77), world = new CombatWorld(31, createBossDefinition(boss));
  world.setLoadout([{ actorIndex: 0, weapon: { ...getWeapon(0), type, explosionRadius: 8, missileExplosionRadius: 8,
    blastSniperExplosionRadius: 8, pelletCount: 3, shotgunSpreadAngle: 0, missileSpeed: 35, ...fields },
    damage: D.from(damage), damagePrecision: String(damage).length, attackInterval: .6 }]);
  const aim = boss.orientedBoxCollider.transform;
  world.player.position = { x: aim.x, z: aim.z - 35 }; world.player.aim = { x: 0, z: 1 };
  world.player.targetId = boss.id; world.nearHitPoint = { ...aim }; world.setMuzzleOffset({ x: 0, z: 0 });
  return { boss, world };
}
function fire(world) { world.spread = 0; assert.equal(world.fire(), true); return world.bullets.filter(b => b.damaging).at(-1); }

test('all 1000 authored Boss HP values match independently extracted Unity InfVal operands', () => {
  assert.equal(fixture.values.length, 1000);
  for (const [i, value] of fixture.values.entries()) {
    const hp = bossHealth(i);
    assert.equal(hp.amount.compare({ digits: value.s_digits, exponent: value.s_exponent }), 0, `Boss ${i}`);
    assert.equal(hp.precision, value.s_digits.length, `precision ${i}`);
  }
  assert.equal(bossHealth(999).amount.compare({ digits: '45', exponent: 698 }), 0);
  assert.equal(bossHealth(1000).amount.compare({ digits: '22', exponent: 699 }), 0);
  assert.equal(bossHealth(1001).amount.compare({ digits: '11', exponent: 700 }), 0);
  assert.equal(bossHealth(5001).precision, 2);
  assert.throws(() => bossHealth(-1)); assert.throws(() => bossHealth(.5));
});

test('very large restored Boss stages use exact coefficient cycles without allocating per-level health', () => {
  // The authored table itself establishes this 23-step, 10^16 recurrence.
  for (const start of [0, 11, 22, 976]) {
    const a = fixture.values[start], b = fixture.values[start + 23];
    assert.equal(D.from({ digits: a.s_digits, exponent: a.s_exponent + 16 })
      .compare({ digits: b.s_digits, exponent: b.s_exponent }), 0);
  }
  for (const stage of [1e6, 1e12, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
    const remainder = stage % 23, cycles = Math.floor(stage / 23), base = fixture.values[remainder];
    const expected = D.from({ digits: base.s_digits, exponent: base.s_exponent + cycles * 16 });
    assert.equal(bossHealth(stage).amount.compare(expected), 0, `Boss ${stage}`);
    assert.equal(bossHealth(stage).precision, 2);
  }
  assert.throws(() => bossHealth(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => bossHealth(Infinity));
});

test('Boss HP retains native precision, dies once, and never replenishes like Raid', () => {
  const boss = new BossCombat(9);
  assert.equal(boss.skinIndex, 0); assert.equal(boss.level, 10);
  const first = new BossCombat(0);
  first.hit(D.from(1), 1); assert.equal(first.health.toString(), '50000');
  first.hit(D.from(1), 6); assert.equal(first.health.toString(), '49999'); assert.equal(first.healthPrecision, 6);
  assert.equal(first.hit(D.from(100000), 6).defeated, true); assert.equal(first.alive, false);
  assert.equal(first.health.isZero, true); assert.equal(first.maxHealth.toString(), '50000');
  assert.equal(first.hit(D.from(100000), 6).defeated, false); assert.equal(first.level, 1);
});

test('Boss shape preserves root, transform offset, rotated local center and height separately', () => {
  const boss = new BossCombat(0), box = boss.orientedBoxCollider;
  assert.deepEqual(boss.position, { x: -115, z: 15 });
  close(box.transform.x, -119.86999988555908); close(box.transform.z, 19.610000133514404);
  close(box.transformY, -.03999999910593033); close(box.minY, .0799998864531517);
  close(box.maxY, 12.079999886453152);
  assert.notDeepEqual(box.center, box.transform); assert.notDeepEqual(box.center, boss.position);
  const world = new CombatWorld(1, createBossDefinition(boss));
  assert.deepEqual(world.colliderCenter(boss), box.transform);
  assert.equal(world.findAutoTarget(), boss);
  boss.position.x = 1000;
  assert.equal(world.findAutoTarget(), boss, 'direct Boss search does not require on-screen collider');
  assert.equal(world.isVisible(boss), false);
});

test('rotated sphere sweeps, surface points and rounded body corners do not use world AABB', () => {
  const box = new BossCombat(0).orientedBoxCollider;
  const start = boxWorld({ x: 0, z: -30 }, box), end = boxWorld({ x: 0, z: 30 }, box);
  close(sweepSphereOrientedBox({ ...start, y: 2 }, { ...end, y: 2 }, .6, box), (30 - box.halfZ - .6) / 60);
  const above = box.maxY + 1;
  assert.equal(sweepSphereOrientedBox({ ...start, y: above }, { ...end, y: above }, .6, box), null);
  const farCorner = boxWorld({ x: box.halfX + 1, z: box.halfZ + 1 }, box);
  assert.equal(sweepCircleOrientedBox(farCorner, farCorner, 1, box), null, 'round corner, not square inflation');
  const projected = closestPointOnOrientedBox(start, -10, box), local = boxLocal(projected, box);
  close(local.x, 0); close(local.z, -box.halfZ); close(projected.y, box.minY);
  const separated = separateCircleOrientedBox(box.center, 1.5, box);
  assert.equal(insideOrientedBox(separated, 2, box), false);
  const surface = closestPointOnOrientedBox(separated, 2, box);
  close(Math.hypot(separated.x - surface.x, separated.z - surface.z), 1.500001);
});

test('follower BoxCast intersects the oriented box but ignores its empty AABB corners', () => {
  const box = new BossCombat(0).orientedBoxCollider;
  const start = boxWorld({ x: 0, z: -30 }, box), end = boxWorld({ x: 0, z: 30 }, box);
  assert.notEqual(sweepBoxOrientedBox(start, end, .3, .3, -.4, .4, box), null);
  const a = boxWorld({ x: box.halfX + 2, z: box.halfZ + 2 }, box);
  const b = boxWorld({ x: box.halfX + 3, z: box.halfZ + 2 }, box);
  assert.equal(sweepBoxOrientedBox(a, b, .3, .3, -.4, .4, box), null);
  assert.equal(sweepBoxOrientedBox(start, end, .3, .3, 13, 14, box), null);
});

test('all seven weapon types use Boss contacts; no tree rewards or Raid first-hit exception', () => {
  for (const type of ['SINGLE', 'LASER', 'PIERCE', 'SHOTGUN', 'EXPLOSIVE', 'MISSILE', 'BLAST_SNIPER']) {
    const { boss, world } = battle(type), bullet = fire(world);
    if (type === 'MISSILE') world.updateMissiles(2); else world.updateBullets(.7);
    const events = world.drainEvents(), hits = events.filter(e => e.type === 'hit');
    assert.equal(hits.length, type === 'SHOTGUN' ? 3 : 1, type);
    assert.equal(boss.health.toString(), type === 'SHOTGUN' ? '47000' : '49000', type);
    assert.equal(events.some(e => ['treeDied', 'bossDied', 'complete'].includes(e.type)), false);
    if (type === 'LASER' || type === 'PIERCE') assert.equal(bullet.damaging, true, type);
    if (type === 'MISSILE') assert.equal(bullet.missileTargetHeight, boss.orientedBoxCollider.transformY);
    assert.ok(hits.every(e => Number.isFinite(e.height)), `3D damage height: ${type}`);
  }
});

test('lethal hit emits one Boss event and gates the rest of this physics batch immediately', () => {
  const { boss, world } = battle('SHOTGUN', 50000);
  fire(world); world.updateBullets(.7);
  const events = world.drainEvents();
  assert.equal(events.filter(e => e.type === 'hit').length, 1);
  assert.equal(events.filter(e => e.type === 'bossDied').length, 1);
  assert.equal(events.filter(e => e.type === 'damageText').length, 2, 'remaining pellets contact the corpse but cannot damage it');
  assert.equal(events.filter(e => e.type === 'impact').length, 3);
  assert.equal(events.some(e => e.type === 'treeDied' || e.type === 'complete'), false);
  assert.equal(world.stats.kills, 1); assert.equal(world.stats.complete, false); assert.equal(world.combatStopped, true);
  assert.equal(boss.alive, false); assert.equal(world.findAutoTarget(), undefined);
  assert.equal(world.trees.length, 0); assert.deepEqual(boss.velocity, { x: 0, z: 0 });
});

test('Boss corpse contacts preserve all weapon-specific FX, penetration and text rules without HP or rewards', () => {
  for (const type of ['SINGLE', 'LASER', 'PIERCE', 'SHOTGUN', 'EXPLOSIVE', 'MISSILE', 'BLAST_SNIPER']) {
    const { boss, world } = battle(type), bullet = fire(world);
    world.hitTree(boss, boss.position, D.from(50000)); world.drainEvents();
    assert.equal(boss.alive, false); assert.equal(world.findAutoTarget(), undefined);
    if (type === 'MISSILE') world.updateMissiles(2); else world.updateBullets(.7);
    const events = world.drainEvents(), count = type === 'PIERCE' ? 0 : type === 'SHOTGUN' ? 3 : 1;
    assert.equal(events.filter(e => e.type === 'damageText').length, count, type);
    assert.equal(events.filter(e => e.type === 'impact').length, count, type);
    assert.equal(events.some(e => ['hit', 'bossDied', 'treeDied', 'complete'].includes(e.type)), false, type);
    assert.equal(boss.health.toString(), '0'); assert.equal(world.stats.hits, 1); assert.equal(world.stats.kills, 1);
    assert.equal(bullet.damaging, type === 'LASER' || type === 'PIERCE', type);
    assert.equal(bullet.pierceCount, 0, type); assert.ok(bullet.hitIds.includes(boss.id), type);
  }
  const { boss, world } = battle('BLAST_SNIPER'), bullet = fire(world);
  // Subsequent sniper contacts use HitPierce, unlike its first explosive contact.
  bullet.hasExploded = true; bullet.hasEnemyImpactFx = true;
  world.hitTree(boss, boss.position, D.from(50000)); world.drainEvents(); world.updateBullets(.7);
  assert.equal(world.drainEvents().length, 0); assert.equal(bullet.damaging, true);
  assert.equal(bullet.pierceCount, 0); assert.ok(bullet.hitIds.includes(boss.id));
});

test('scene exit removes the corpse collider while preserving a previously fired volley', () => {
  const { boss, world } = battle('SHOTGUN'); fire(world);
  world.hitTree(boss, boss.position, D.from(50000)); world.drainEvents();
  const shots = world.bullets.filter(b => b.damaging);
  world.setBattlefieldActive(false); world.updateBullets(.7);
  assert.equal(world.drainEvents().length, 0); assert.ok(shots.every(b => b.damaging));
  assert.ok(shots.every(b => !b.hitIds.includes(boss.id))); assert.equal(boss.health.toString(), '0');
});

test('timeout permits projectile feedback but never damage, death or movement', () => {
  const { boss, world } = battle(); fire(world);
  boss.update(.02, world.player.position); const position = { ...boss.position };
  world.stopCombat(); world.step(.3); world.step(.3);
  assert.equal(boss.health.toString(), '50000'); assert.deepEqual(boss.position, position);
  const events = world.drainEvents(); assert.ok(events.some(e => e.type === 'damageText'));
  assert.equal(events.some(e => e.type === 'hit' || e.type === 'bossDied'), false);
});

test('map stays open and Boss collider pushes cats out without adding radial walls', () => {
  const { boss, world } = battle();
  assert.equal(world.stage.mapLayout, 'boss'); assert.equal(world.stage.bounds.maxX, Infinity);
  assert.deepEqual(world.stage.bulletWalls, []); assert.deepEqual(world.stage.mapOrigin, { x: -100, z: 0 });
  world.player.position = { ...boss.orientedBoxCollider.center }; world.resolveBodyOverlap(world.player);
  const p = closestPointOnOrientedBox(world.player.position, 2, boss.orientedBoxCollider);
  assert.ok(Math.hypot(p.x - world.player.position.x, p.z - world.player.position.z) >= 1.5);
  world.player.position = { x: -30, z: 0 }; world.moveAndSlide({ x: 0, z: 1000 });
  assert.equal(world.player.position.z, 1000);
});

test('wander selection avoids cat-crossing segments and consumes velocity on fixed physics ticks', () => {
  assert.equal(bossPathCrossesCat({ x: -120, z: 0 }, { x: -80, z: 0 }, { x: -100, z: 1 }, 4), true);
  assert.equal(bossPathCrossesCat({ x: -120, z: 0 }, { x: -80, z: 0 }, { x: -100, z: 4 }, 4), false);
  const boss = new BossCombat(0, 5), origin = { ...boss.position }, cat = { x: -100, z: 0 };
  boss.update(1 / 60, cat); assert.deepEqual(boss.position, origin);
  close(Math.hypot(boss.velocity.x, boss.velocity.z), 15);
  assert.ok(Math.hypot(boss.destination.x + 100, boss.destination.z) <= 60);
  assert.equal(bossPathCrossesCat(origin, boss.destination, cat, 4), false);
  boss.fixedStep(.02); close(Math.hypot(boss.position.x - origin.x, boss.position.z - origin.z), .3);
  boss.position = { ...boss.destination }; boss.update(.02, cat);
  assert.equal(boss.moving, false); assert.ok(boss.waitRemaining >= 1 && boss.waitRemaining <= 3);
  const waiting = { ...boss.position }; boss.fixedStep(.02); assert.deepEqual(boss.position, waiting);
  boss.update(.1, cat); assert.equal(boss.moving, false);
});

test('three automatic cats chase and defeat a wandering Boss at 30/60/120 fps without body penetration', () => {
  for (const rate of [30, 60, 120]) {
    const boss = new BossCombat(0, 77), world = new CombatWorld(31, createBossDefinition(boss));
    world.setLoadout([0, 1, 2].map(actorIndex => ({ actorIndex, weapon: getWeapon(0),
      damage: D.from(200), damagePrecision: 3, attackInterval: .3 })));
    const start = { ...boss.position }, events = []; let moved = false;
    for (let frame = 0; frame < rate * 60 && boss.alive; frame++) {
      world.step(1 / rate); events.push(...world.drainEvents());
      moved ||= Math.hypot(boss.position.x - start.x, boss.position.z - start.z) > 10;
      if (boss.alive) for (const player of world.players) {
        const surface = closestPointOnOrientedBox(player.position, 2, boss.orientedBoxCollider);
        assert.ok(Math.hypot(surface.x - player.position.x, surface.z - player.position.z) >= C.playerRadius - 1e-6,
          `Boss body penetration at ${rate} fps, actor ${player.actorId}`);
      }
    }
    assert.equal(moved, true); assert.equal(boss.alive, false, `Boss must die before its 60-second limit at ${rate} fps`);
    assert.equal(events.filter(e => e.type === 'bossDied').length, 1);
    assert.equal(events.filter(e => e.type === 'hit').length, 250);
    assert.equal(events.some(e => e.type === 'treeDied' || e.type === 'complete'), false);
    assert.equal(new Set(events.filter(e => e.type === 'shot').map(e => e.actorId)).size, 3);
  }
});

test('paused world freezes Boss; scene exit removes collision without clearing global projectiles', () => {
  const { boss, world } = battle('MISSILE'); const bullet = fire(world);
  boss.update(.02, world.player.position); const position = { ...boss.position };
  world.pause(); world.step(.3); assert.deepEqual(boss.position, position);
  world.resume(); world.setBattlefieldActive(false); world.updateMissiles(.1);
  const age = bullet.age, target = { ...bullet.missileTarget }, y = bullet.missileTargetHeight;
  world.reset(1, createStageDefinition(0, 0, 1), { preserveActorState: true, preserveProjectiles: true });
  assert.equal(bullet.age, age); assert.deepEqual(bullet.missileTarget, target); assert.equal(bullet.missileTargetHeight, y);
  assert.equal(world.stage.boss, undefined); assert.equal(boss.health.toString(), '50000');
});
