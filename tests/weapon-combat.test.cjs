const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, DecimalAmount: D, CHARACTER_CONFIG: C, circleOverlapsBox } = require('./.build/core/index.js');
const { getWeapon, WEAPON_TYPES, getWeaponCatalog } = require('./.build/core/WeaponCatalog.js');
const { FollowerAI } = require('./.build/core/FollowerAI.js');

const close = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
function weapon(type, fields = {}) { return { ...getWeapon(0), type, ...fields }; }
function entry(actorIndex = 0, type = 'SINGLE', fields = {}) {
  return { actorIndex, weapon: weapon(type), damage: D.from(100), attackInterval: .6, ...fields };
}
function tree(id, x, z, health = 1000, half = .5) {
  return { id, position: { x, z }, degree: 0, stageIndex: 0, reward: D.from(20), health: D.from(health), maxHealth: D.from(health), alive: true,
    collider: { minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half } };
}
function fixture(type, targets, fields = {}) {
  const world = new CombatWorld(42);
  world.setLoadout([entry(0, type, fields)]);
  world.trees.splice(0, world.trees.length, ...targets);
  world.stats.totalTrees = targets.length;
  world.setMuzzleOffset({ x: 0, z: 0 });
  world.player.aim = { x: 0, z: 1 };
  return world;
}
function shoot(world, dt = .5) {
  assert.equal(world.fire(), true);
  world.updateBullets(dt);
  return world.drainEvents();
}
function advance(world, seconds, fps = 60) {
  const events = [];
  for (let i = 0; i < Math.round(seconds * fps); i++) { world.step(1 / fps); events.push(...world.drainEvents()); }
  return events;
}

test('all seven recovered weapon kinds have catalog entries and dispatch from their own metadata', () => {
  assert.deepEqual([...new Set(getWeaponCatalog().map(w => w.type))].sort(), [...WEAPON_TYPES].sort());
  for (const type of WEAPON_TYPES) {
    const definition = getWeaponCatalog().find(w => w.type === type);
    const world = fixture(type, [tree(1, 0, 10)], { weapon: definition });
    world.fire();
    const event = world.drainEvents().find(e => e.type === 'shot');
    assert.equal(event.weaponId, definition.id);
    assert.equal(event.weaponType, type);
    assert.equal(world.bullets[event.bulletId].weaponType, type);
  }
});

test('single fire stops on its first target; shotgun fires independent full-damage non-piercing pellets', () => {
  const single = fixture('SINGLE', [tree(1, 0, 5), tree(2, 0, 10)]);
  const singleEvents = shoot(single);
  assert.deepEqual(single.trees.map(t => Number(t.health)), [900, 1000]);
  assert.equal(singleEvents.filter(e => e.type === 'impact').length, 1);
  const shotgun = fixture('SHOTGUN', [tree(1, 0, 5), tree(2, 0, 10)], {
    weapon: weapon('SHOTGUN', { id: 2, pelletCount: 4, shotgunSpreadAngle: 0 }),
  });
  const events = shoot(shotgun), shots = events.filter(e => e.type === 'shot');
  assert.equal(shots.length, 4);
  assert.equal(new Set(shots.map(e => e.volleyId)).size, 1);
  assert.deepEqual(shots.map(e => e.pelletIndex), [0, 1, 2, 3]);
  assert.deepEqual(shotgun.trees.map(t => Number(t.health)), [600, 1000]);
  assert.ok(events.filter(e => e.type === 'hit').every(e => e.damage.compare(100) === 0));
  assert.equal(shotgun.spread, 0, 'shotgun uses fixed per-gun pellet cone, not accumulating attack spread');
});

test('laser crosses multiple colliders in one step with full damage once each, then dies at a wall', () => {
  const world = fixture('LASER', [tree(1, 0, 5), tree(2, 0, 10), tree(3, 0, 15)]);
  const events = shoot(world, .2), bullet = world.bullets[0];
  world.updateBullets(.1);
  world.updateBullets(.1);
  const all = events.concat(world.drainEvents());
  assert.deepEqual(world.trees.map(t => Number(t.health)), [900, 900, 900]);
  assert.deepEqual(all.filter(e => e.type === 'hit').map(e => e.treeId), [1, 2, 3]);
  assert.equal(all.filter(e => e.type === 'impact').length, 1, 'HitLaser requests FX only on its first enemy');
  assert.equal(bullet.hasEnemyImpactFx, true);
  assert.equal(bullet.damaging, true);
  world.updateBullets(2);
  assert.equal(bullet.damaging, false);
  assert.equal(world.drainEvents().filter(e => e.type === 'impact').length, 1);
});

test('pierce always crosses its first victim and thereafter crosses kills but stops at a survivor', () => {
  const world = fixture('PIERCE', [tree(1, 0, 5), tree(2, 0, 10, 100), tree(3, 0, 15), tree(4, 0, 20)]);
  const events = shoot(world);
  assert.deepEqual(world.trees.map(t => Number(t.health)), [900, 0, 900, 1000]);
  assert.equal(world.bullets[0].pierceCount, 3);
  assert.equal(world.bullets[0].damaging, false);
  assert.deepEqual(events.filter(e => e.type === 'hit').map(e => e.treeId), [1, 2, 3]);
  assert.equal(events.filter(e => e.type === 'impact').length, 1, 'later kills and the stopping survivor do not repeat FX');
});

test('explosives deal one full damage packet per collider and emit one shared blast effect', () => {
  const world = fixture('EXPLOSIVE', [tree(1, 0, 8), tree(2, 3, 8), tree(3, 7, 8)], {
    weapon: weapon('EXPLOSIVE', { explosionRadius: 4 }),
  });
  const events = shoot(world), hits = events.filter(e => e.type === 'hit'), impacts = events.filter(e => e.type === 'impact');
  assert.deepEqual(hits.map(e => e.treeId), [1, 2]);
  assert.ok(hits.every(e => e.damage.compare(100) === 0));
  assert.deepEqual(world.trees.map(t => Number(t.health)), [900, 900, 1000]);
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].radius, 4);
});

test('blast sniper requires its initial direct kill, then uses pierce rules without double-hitting blast neighbors', () => {
  const stopped = fixture('BLAST_SNIPER', [tree(1, 0, 5), tree(2, 0, 10)], {
    weapon: weapon('BLAST_SNIPER', { blastSniperExplosionRadius: 1 }),
  });
  shoot(stopped);
  assert.deepEqual(stopped.trees.map(t => Number(t.health)), [900, 1000]);
  assert.equal(stopped.bullets[0].damaging, false);
  const through = fixture('BLAST_SNIPER', [tree(1, 0, 5, 100), tree(2, 0, 7), tree(3, 0, 12), tree(4, 0, 17), tree(5, 0, 22)], {
    weapon: weapon('BLAST_SNIPER', { blastSniperExplosionRadius: 3 }),
  });
  const events = shoot(through);
  assert.deepEqual(through.trees.map(t => Number(t.health)), [0, 900, 900, 900, 1000]);
  assert.deepEqual(events.filter(e => e.type === 'hit').map(e => e.treeId), [1, 2, 3, 4]);
  assert.equal(events.filter(e => e.type === 'impact' && e.radius > 0).length, 1);
  assert.equal(events.filter(e => e.type === 'impact').length, 1, 'first explosion consumes the piercing enemy FX marker');
  assert.equal(through.bullets[0].pierceCount, 2, 'initial blast and blast neighbors do not consume pierce count');
});

test('piercing FX marker resets on pool reuse; later wall FX remains independent from the first enemy', () => {
  for (const type of ['LASER', 'PIERCE', 'BLAST_SNIPER']) {
    const world = fixture(type, [tree(1, 0, 5, 100), tree(2, 8, 5)], {
      weapon: weapon(type, { blastSniperExplosionRadius: 1 }),
    });
    const enemy = shoot(world, .12).filter(e => e.type === 'impact');
    assert.equal(enemy.length, 1); assert.equal(world.bullets[0].hasEnemyImpactFx, true);
    world.updateBullets(2);
    const wall = world.drainEvents().filter(e => e.type === 'impact');
    assert.equal(wall.length, 1, `${type}: a wall still invokes SpawnFX after its enemy FX`);
    assert.equal(wall[0].radius, 0);
    world.clearBullet(world.bullets[0]);
    assert.equal(world.bullets[0].hasEnemyImpactFx, false);
    world.bulletPoolCursor = 0;
    world.trees[0] = tree(1, 0, 5, 100);
    const second = shoot(world, .12).filter(e => e.type === 'impact');
    assert.equal(second.length, 1); assert.equal(world.bullets[0].hasEnemyImpactFx, true);
  }
});

test('explosive lifetime bursts once; blast-sniper and laser lifetime expiration do not invent an explosion', () => {
  for (const type of ['EXPLOSIVE', 'BLAST_SNIPER', 'LASER']) {
    const world = fixture(type, [tree(1, 4, 0)], { weapon: weapon(type, { explosionRadius: 5, blastSniperExplosionRadius: 5 }) });
    world.fire(); world.drainEvents();
    world.frameTime = world.bulletTimeouts.get(0);
    world.updateBulletTimeouts();
    const events = world.drainEvents();
    assert.equal(events.filter(e => e.type === 'impact').length, type === 'EXPLOSIVE' ? 1 : 0);
    assert.equal(Number(world.trees[0].health), type === 'EXPLOSIVE' ? 900 : 1000);
    world.updateBulletTimeouts();
    assert.equal(world.drainEvents().length, 0);
  }
});

test('missile snapshots its target, follows the distance-scaled arc and uses flight duration instead of linear lifetime', () => {
  const world = fixture('MISSILE', [tree(1, 0, 40)], { weapon: weapon('MISSILE', { missileSpeed: 20, missileExplosionRadius: 4 }) });
  world.player.targetId = 1;
  world.fire(); world.drainEvents();
  const bullet = world.bullets[0];
  assert.equal(bullet.height, 2, 'GetFirePosition projects every weapon muzzle, including missiles, to Y=2');
  assert.deepEqual(bullet.missileTarget, { x: 0, z: 40 });
  close(bullet.missileDuration, 2);
  world.trees.length = 0;
  world.updateMissiles(1);
  close(bullet.position.z, 20, 1e-6);
  close(bullet.height, 17, 1e-6);
  assert.equal(bullet.damaging, true);
  world.updateMissiles(1);
  close(bullet.position.z, 40, 1e-6);
  close(bullet.height, 0, 1e-6);
  assert.equal(bullet.damaging, false);
  const events = world.drainEvents();
  assert.equal(events.filter(e => e.type === 'impact').length, 1);
  assert.equal(events.find(e => e.type === 'impact').radius, 4);
  close(events.find(e => e.type === 'impact').height, 0, 1e-6);
});

test('missile can pass above a foreground tree and explodes when its descending sphere meets the target', () => {
  const world = fixture('MISSILE', [tree(1, 0, 15), tree(2, 0, 30)], {
    weapon: weapon('MISSILE', { missileSpeed: 30, missileExplosionRadius: 2 }),
  });
  world.player.targetId = 2;
  world.fire(); world.drainEvents();
  world.updateMissiles(1.1);
  assert.deepEqual(world.trees.map(t => Number(t.health)), [1000, 900]);
  assert.equal(world.bullets[0].damaging, false);
  const impacts = world.drainEvents().filter(e => e.type === 'impact');
  assert.equal(impacts.length, 1);
  const bullet = world.bullets[0], previousT = bullet.previousPosition.z / 30;
  const previousHeight = 2 * (1 - previousT) + 4 * previousT * (1 - previousT) * bullet.missileArcHeight;
  close(impacts[0].height, Math.max(0, Math.min(6, previousHeight)), 1e-6,
    'SpawnFX receives the same ClosestPoint height as Explode');
});

test('a missile hitting the top of a tree places explosion FX on the collider surface, not its sphere center', () => {
  const world = fixture('MISSILE', [tree(1, 0, 30, 1000, 5)], {
    weapon: weapon('MISSILE', { missileSpeed: 30, missileExplosionRadius: 2 }),
  });
  world.player.targetId = 1;
  world.fire(); world.drainEvents();
  world.updateMissiles(1.1);
  const bullet = world.bullets[0], impacts = world.drainEvents().filter(e => e.type === 'impact');
  assert.equal(bullet.damaging, false);
  close(bullet.height, 6.6, 1e-6, 'the sphere contacts the collider top at Y6 plus radius .6');
  assert.equal(impacts.length, 1);
  close(impacts[0].height, 6);
});

test('missile pose samples the collider transform while other weapons preserve their near-surface aim', () => {
  const world = fixture('MISSILE', [tree(1, 2, 20, 10000, 3)]);
  world.player.targetId = 1; world.nearHitPoint = { x: 2, z: 17 };
  const samples = []; world.setMuzzleProvider(context => { samples.push(context); return { x: 0, z: 0 }; });
  world.sampleMuzzle(.02, world.trees[0]);
  assert.deepEqual(samples[0].targetPoint, { x: 2, z: 20 });
  world.setLoadout([entry()]); world.sampleMuzzle(.02, world.trees[0]);
  assert.deepEqual(samples[1].targetPoint, { x: 2, z: 17 });
  world.setLoadout([entry(), entry(1, 'MISSILE')]);
  const follower = world.followers[0]; follower.player.targetId = 1; follower.nearHitPoint = { x: 2, z: 17 };
  world.updateFollowers(.02);
  assert.deepEqual(samples[2].targetPoint, { x: 2, z: 20 });
});

test('shotgun shares one crit roll; weapon/damage/critical state is frozen for all in-flight pellets', () => {
  const world = fixture('SHOTGUN', [tree(1, 0, 8)], { criticalChance: 1, criticalMultiplier: 1.25,
    weapon: weapon('SHOTGUN', { id: 2, pelletCount: 3, shotgunSpreadAngle: 0 }),
  });
  world.fire();
  world.setLoadout([entry(0, 'LASER', { weapon: weapon('LASER', { id: 50 }), damage: D.from('1e330'), criticalChance: 0 })]);
  world.updateBullets(.2);
  const events = world.drainEvents(), hits = events.filter(e => e.type === 'hit');
  assert.equal(hits.length, 3);
  assert.ok(hits.every(e => e.weaponId === 2 && e.weaponType === 'SHOTGUN' && e.critical && e.damage.compare(125) === 0));
  assert.equal(Number(world.trees[0].health), 625);
  assert.ok(events.filter(e => e.type === 'shot').every(e => e.critical));
});

test('overlapping volleys from three cats kill and reward every tree only once, including replayed death batches', () => {
  const { BattleSession } = require('./.build/session/session/BattleSession.js');
  const world = fixture('EXPLOSIVE', [tree(1, 0, 8, 100), tree(2, 2, 8, 100), tree(3, 0, 12, 100)]);
  world.trees[1].degree = 1;
  world.trees[1].reward = D.from(36);
  const loadout = [entry(0, 'EXPLOSIVE', { weapon: weapon('EXPLOSIVE', { id: 14, explosionRadius: 5 }) }),
    entry(1, 'SHOTGUN', { weapon: weapon('SHOTGUN', { id: 2, pelletCount: 4, shotgunSpreadAngle: 0 }) }), entry(2, 'LASER')];
  world.setLoadout(loadout);
  for (const player of world.players) {
    player.position = { x: 0, z: 0 }; player.aim = { x: 0, z: 1 }; player.targetId = 1;
    assert.equal(world.fireActor(player, loadout[player.actorId], { x: 0, z: 8 }, { x: 0, z: 0 }, 0), true);
  }
  world.updateBullets(.5);
  const events = world.drainEvents(), deaths = events.filter(e => e.type === 'treeDied');
  assert.deepEqual(deaths.map(e => e.treeId).sort(), [1, 2, 3]);
  assert.equal(events.filter(e => e.type === 'complete').length, 1);
  assert.equal(world.stats.kills, 3); assert.equal(world.stats.complete, true);
  const session = new BattleSession();
  assert.equal(session.consume([...events, ...events], world.trees).length, 3);
  assert.equal(session.moneyBalance.toNumber(), 76);
  assert.deepEqual(session.consume(events, world.trees), []);
  world.updateBullets(2); world.frameTime += 3; world.updateBulletTimeouts();
  const late = world.drainEvents();
  assert.equal(late.filter(e => e.type === 'treeDied' || e.type === 'complete').length, 0);
  assert.deepEqual(session.consume([...late, ...deaths], world.trees), []);
  assert.equal(world.stats.kills, 3); assert.equal(session.moneyBalance.toNumber(), 76);
});

test('swapping equipped weapons applies the new cadence on the next update without moving actor cooldowns', () => {
  const world = fixture('SINGLE', [tree(1, 0, 12, 100000)]);
  const slow = entry(0, 'SINGLE', { weapon: weapon('SINGLE', { id: 0 }), attackInterval: .6 });
  const fast = entry(1, 'SINGLE', { weapon: weapon('SINGLE', { id: 4 }), attackInterval: .2 });
  world.setLoadout([slow, fast]);
  world.movePlayer = () => {}; world.followers[0].update = () => {};
  world.player.targetId = world.lockedAttackTargetId = 1; world.previouslyHadTarget = true;
  world.nearHitPoint = { x: 0, z: 11.5 }; world.attackClock = .35;
  const follower = world.followers[0];
  follower.player.position = { x: 0, z: 0 }; follower.player.targetId = 1;
  follower.nearHitPoint = { x: 0, z: 11.5 }; follower.previouslyHadTarget = true; follower.attackClock = .1;
  world.setMuzzleProvider(() => ({ x: 0, z: 0 }));
  world.setLoadout([{ ...fast, actorIndex: 0 }, { ...slow, actorIndex: 1 }]);
  world.step(.02);
  const first = world.drainEvents().filter(e => e.type === 'shot');
  assert.deepEqual(first.map(e => [e.actorId, e.weaponId]), [[0, 4]], 'main keeps .35s elapsed and fires the newly equipped fast gun');
  close(follower.attackClock, .12);
  const beforeFollower = advance(world, .46, 50).filter(e => e.type === 'shot');
  assert.equal(beforeFollower.some(e => e.actorId === 1), false, 'follower keeps its own .1s clock and waits for the newly equipped .6s gun');
  world.step(.02);
  assert.deepEqual(world.drainEvents().filter(e => e.type === 'shot' && e.actorId === 1).map(e => e.weaponId), [0]);
});

test('an unequipped follower missile retains its actor, critical damage, arc, target and blast radius until impact', () => {
  const world = fixture('SINGLE', [tree(1, 0, 30, 1000), tree(2, 2, 30, 1000), tree(3, 7, 30, 1000)]);
  const missile = entry(1, 'MISSILE', { damage: D.from(160), criticalChance: 1, criticalMultiplier: 1.25,
    weapon: weapon('MISSILE', { id: 24, missileSpeed: 30, missileExplosionRadius: 4 }) });
  world.setLoadout([entry(), missile]);
  const follower = world.players[1]; follower.position = { x: 0, z: 0 }; follower.targetId = 1;
  world.fireActor(follower, missile, { x: 0, z: 30 }, { x: 0, z: 0 }, 0);
  const bullet = world.bullets.find(b => b.damaging);
  world.updateMissiles(.25); world.drainEvents();
  const before = { position: { ...bullet.position }, age: bullet.age, target: { ...bullet.missileTarget } };
  world.setLoadout([entry(0, 'EXPLOSIVE', { damage: D.from('1e330'),
    weapon: weapon('EXPLOSIVE', { id: 55, explosionRadius: 20 }) })]);
  assert.equal(world.players.length, 1); assert.deepEqual(bullet.position, before.position); close(bullet.age, before.age);
  assert.deepEqual(bullet.missileTarget, before.target); assert.equal(bullet.speed, 30);
  close(bullet.missileDuration, 1); close(bullet.missileArcHeight, 12); assert.equal(bullet.explosionRadius, 4);
  world.updateMissiles(1);
  const events = world.drainEvents(), hits = events.filter(e => e.type === 'hit');
  assert.deepEqual(hits.map(e => e.treeId), [1, 2]);
  assert.ok(hits.every(e => e.actorId === 1 && e.weaponId === 24 && e.weaponType === 'MISSILE' && e.critical && e.damage.compare(200) === 0));
  assert.deepEqual(world.trees.map(t => Number(t.health)), [800, 800, 1000]);
  assert.equal(events.filter(e => e.type === 'impact').length, 1);
  assert.equal(events.find(e => e.type === 'impact').radius, 4);
});

test('a partial shotgun volley uses the shared 27-object pool and remains a successful shot', () => {
  const world = fixture('SINGLE', []);
  for (let i = 0; i < 25; i++) world.fire();
  world.drainEvents();
  world.setLoadout([entry(0, 'SHOTGUN', { weapon: weapon('SHOTGUN', { pelletCount: 5 }) })]);
  assert.equal(world.fire(), true);
  assert.equal(world.drainEvents().filter(e => e.type === 'shot').length, 2);
  assert.equal(world.bullets.filter(b => b.damaging).length, 27);
  assert.equal(world.fire(), false);
});

test('out-of-range catalog IDs cannot enter a loadout and rejection preserves actors and in-flight damage', () => {
  const world = fixture('SINGLE', [tree(1, 0, 20)]);
  world.fire();
  const bullets = [...world.bullets], actor = world.player, events = world.drainEvents();
  assert.ok(events.some(event => event.type === 'shot'));
  for (const id of [-1, .5, 65, 66, NaN]) {
    assert.throws(() => world.setLoadout([entry(0, 'SINGLE', { weapon: weapon('SINGLE', { id }) })]), /Invalid actor loadout/);
    assert.strictEqual(world.player, actor); assert.deepEqual(world.bullets, bullets); assert.equal(world.player.weaponId, 0);
  }
  for (const id of [58,62,63,64]) {
    const last = getWeapon(id);
    world.setLoadout([entry(0, last.type, { weapon: last })]); assert.equal(world.player.weaponId, id);
  }
});

test('loadout compression uses actor order for identity/stars and preserves active actors/cooldowns on equipment changes', () => {
  const world = new CombatWorld(123);
  world.attackClock = .4;
  world.setLoadout([entry(0, 'SINGLE', { starLevel: 2 }), entry(1, 'LASER', { weapon: weapon('LASER', { id: 10 }), starLevel: 5 })]);
  assert.equal(world.players.length, 2);
  assert.strictEqual(world.players[0], world.player);
  assert.deepEqual(world.players.map(p => [p.actorId, p.starLevel]), [[0, 2], [1, 5]]);
  assert.deepEqual(world.players[1].position, { x: 0, z: 2.5 });
  const follower = world.players[1]; follower.position = { x: 5, z: 7 };
  world.followers[0].attackClock = .35;
  world.setLoadout([entry(), entry(1, 'PIERCE', { weapon: weapon('PIERCE', { id: 11 }) }), entry(2)]);
  assert.strictEqual(world.players[1], follower);
  assert.deepEqual(follower.position, { x: 5, z: 7 });
  assert.equal(world.followers[0].attackClock, .35);
  assert.equal(world.attackClock, .4);
  assert.equal(world.players[1].weaponId, 11);
  world.setLoadout([entry()]);
  assert.equal(world.players.length, 1);
  assert.throws(() => world.setLoadout([entry(), entry(2)]));
  assert.equal(world.players.length, 1, 'invalid loadout changes nothing');
  world.setLoadout([entry(), entry(1)]);
  assert.strictEqual(world.players[1], follower, 'disabled serialized cats retain their identity');
  assert.equal(world.followers[0].attackClock, .35);
  assert.deepEqual(follower.position, { x: 0, z: 2.5 }, 'reenabling warps to the leader formation');
});

test('three cats choose separate nearby targets, keep independent firing cadence, and sample their own muzzle', () => {
  const world = fixture('SINGLE', [tree(1, 0, 12, 100000), tree(2, 15, 12, 100000), tree(3, -15, 12, 100000)]);
  world.setLoadout([entry(0, 'SINGLE', { attackInterval: .3 }), entry(1, 'SINGLE', { attackInterval: .6 }), entry(2, 'SINGLE', { attackInterval: .9 })]);
  world.players[1].position = { x: 15, z: 0 };
  world.players[2].position = { x: -15, z: 0 };
  world.setViewport(2);
  world.movePlayer = () => {};
  for (const follower of world.followers) follower.update = () => {};
  const poses = new Set();
  world.setMuzzleProvider(context => { poses.add(context.actorId); return { x: 0, z: 0 }; });
  const events = advance(world, 3), shots = events.filter(e => e.type === 'shot');
  assert.deepEqual(world.players.map(p => p.targetId), [1, 2, 3]);
  assert.deepEqual([...poses].sort(), [0, 1, 2]);
  const counts = [0, 1, 2].map(id => shots.filter(e => e.actorId === id).length);
  assert.ok(counts[0] > counts[1] && counts[1] > counts[2], counts.join(','));
  assert.strictEqual(world.cameraAnchor, world.player.position);
  assert.deepEqual(world.players.map(p => p.position.x), [0, 15, -15]);
});

test('followers retreat from close targets, enforce the leader leash, and do not physically push the leader', () => {
  const world = fixture('SINGLE', []);
  world.setLoadout([entry(), entry(1)]);
  const follower = world.followers[0], p = follower.player;
  p.position = { x: 0, z: 0 };
  const context = { leader: world.player, leaderTarget: null, ownTarget: { x: 0, z: 3 }, history: [], time: 1,
    separation: { x: 0, z: 0 }, pathClear: () => true, breadcrumb: () => ({ x: 0, z: 0 }) };
  follower.update(.3, context);
  assert.equal(follower.state, 'Reposition');
  assert.ok(p.velocity.z < 0);
  p.position = { x: 0, z: 25 };
  follower.update(.3, { ...context, ownTarget: { x: 0, z: 26 } });
  assert.equal(follower.state, 'Follow');
  assert.ok(p.velocity.z < 0);
  const before = { ...world.player.position };
  world.moveAndSlide({ x: 0, z: -25 }, p);
  assert.deepEqual(p.position, before, 'cat/cat collision is disabled');
  assert.deepEqual(world.player.position, before);
  assert.equal(C.playerSpeed, 15);
  assert.equal(C.followerSpeed, 17);
});

test('equipped mixed teams clear seeded forests while all active cats respect tree collision', () => {
  for (const seed of [1, 42]) {
    const world = new CombatWorld(seed);
    world.setLoadout([entry(0, 'PIERCE'), entry(1, 'SHOTGUN', { weapon: weapon('SHOTGUN', { pelletCount: 4, shotgunSpreadAngle: 7 }) }), entry(2, 'LASER')]);
    const actors = new Set();
    for (let frame = 0; frame < 60 * 180 && !world.stats.complete; frame++) {
      world.step(1 / 60);
      for (const e of world.drainEvents()) if (e.type === 'shot') actors.add(e.actorId);
      for (const actor of world.players) for (const target of world.trees) if (target.alive) {
        assert.equal(circleOverlapsBox(actor.position, C.playerRadius - 1e-4, target.collider), false);
      }
    }
    assert.equal(world.stats.complete, true, `seed ${seed} stalled`);
    assert.deepEqual([...actors].sort(), [0, 1, 2]);
  }
});

test('activating a stationary follower inside a tree separates its body on the next physics step', () => {
  const world = fixture('SINGLE', [tree(1, 0, 3, 10000)]);
  const leader = { ...world.player.position };
  world.setLoadout([entry(), entry(1)]);
  const follower = world.players[1];
  assert.equal(circleOverlapsBox(follower.position, C.playerRadius, world.trees[0].collider), true);
  world.step(1 / 50);
  assert.equal(circleOverlapsBox(follower.position, C.playerRadius, world.trees[0].collider), false);
  assert.deepEqual(world.player.position, leader);
});

test('overlap resolution finds a free exit when another tree and the map boundary block nearest faces', () => {
  const world = fixture('SINGLE', [tree(1, 24, 15, 10000, 2), tree(2, 20, 15, 10000, 2)]);
  world.setLoadout([entry(), entry(1), entry(2)]);
  const follower = world.players[1];
  follower.position = { x: 24, z: 15 };
  world.moveAndSlide({ x: 0, z: 0 }, follower);
  for (const target of world.trees) assert.equal(circleOverlapsBox(follower.position, C.playerRadius, target.collider), false);
  assert.ok(follower.position.x <= 27.49990082 - C.playerRadius);
  assert.ok(Math.hypot(follower.position.x - 24, follower.position.z - 15) < 4);
  const other = world.players[2]; other.position = { x: 0, z: 109 };
  world.moveAndSlide({ x: 0, z: 0 }, other);
  close(other.position.z, 107.5 - C.playerRadius);
});

test('a breadcrumb under the follower stops its walk or uses source half-speed separation drift', () => {
  const world = fixture('SINGLE', []); world.setLoadout([entry(), entry(1)]);
  const follower = world.followers[0], p = follower.player;
  p.position = { x: 0, z: 25 };
  const context = { leader: world.player, leaderTarget: null, ownTarget: null, history: [], time: 1,
    separation: { x: 0, z: 0 }, pathClear: () => false, breadcrumb: () => ({ ...p.position }) };
  follower.update(.3, context);
  assert.equal(p.moving, false); assert.deepEqual(p.velocity, { x: 0, z: 0 });
  follower.update(.3, { ...context, separation: { x: 1, z: 0 } });
  const { screenSpeedMultiplier } = require('./.build/core/index.js');
  close(p.velocity.x, 17 * .5 * screenSpeedMultiplier({ x: 1, z: 0 }));
  assert.equal(p.moving, true); assert.equal(p.velocity.z, 0);
});

test('source separation includes unequipped serialized cats at their initial or last disabled positions', () => {
  const world = fixture('SINGLE', []); world.setLoadout([entry(), entry(1)]);
  const follower = world.followers[0]; let separation;
  follower.update = (_dt, context) => { separation = context.separation; };
  follower.player.position = { x: 7, z: -6 };
  world.updateFollowers(.02);
  close(separation.x, (1 - 1 / 1.8) * 3); close(separation.z, 0);
  world.setLoadout([entry(), entry(1), entry(2)]);
  world.players[2].position = { x: 10, z: 10 };
  world.setLoadout([entry(), entry(1)]);
  follower.player.position = { x: 11, z: 10 };
  world.updateFollowers(.02);
  close(separation.x, (1 - 1 / 1.8) * 3); close(separation.z, 0);
  assert.equal(world.players.length, 2); assert.deepEqual(world.player.velocity, { x: 0, z: 0 });
});

test('reset retains equipped actors, clears projectile hit history and restarts deterministic followers', () => {
  const world = new CombatWorld(81);
  world.setLoadout([entry(), entry(1, 'LASER'), entry(2, 'MISSILE')]);
  const first = advance(world, 2);
  world.reset();
  assert.equal(world.players.length, 3);
  assert.ok(world.bullets.every(b => !b.active && !b.hitIds.length && !b.hasExploded && !b.missileStart));
  assert.deepEqual(advance(world, 2), first);
});
