const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const core = require('./.build/core/index.js');
const { CombatWorld, createStageDefinition, createSpeedRunDefinition, getSpeedRunTreeCount,
  getStageHealth, getStageMoney, DecimalAmount: D, getWeapon, projectWorld } = core;

test('SpeedRun uses the source ring populations, 190-tree cap and three equally sampled degrees', () => {
  // Tree_Batch rounds area-density ring count and circumference allocation,
  // then puts the rounding remainder into its final ring. These populations
  // are independent source-formula examples, not captured from this renderer.
  for (const [stage, radii, expected] of [
    [0, [34, 58], [7, 13]], [2, [30, 46, 62], [11, 17, 22]],
    [12, [26, 34, 42, 50, 58, 66], [18, 23, 29, 34, 40, 46]],
  ]) {
    const map = createSpeedRunDefinition(stage, 41);
    const populations = radii.map(() => 0);
    for (const tree of map.trees) {
      const radius = Math.hypot(tree.position.x + 100, tree.position.z);
      const ring = radii.findIndex(r => Math.abs(radius - r) < 3.1);
      assert.ok(ring >= 0, 'serialized radial ±3 and tangential ±2 offset'); populations[ring]++;
    }
    assert.deepEqual(populations, expected);
    assert.equal(map.trees.length, Math.min(20 + stage * 15, 190));
    assert.equal(map.trees.some(tree => tree.degree === 3), false);
  }
  assert.equal(getSpeedRunTreeCount(11), 185); assert.equal(getSpeedRunTreeCount(12), 190);
  assert.equal(getSpeedRunTreeCount(10000), 190);
  const degrees = [0, 0, 0];
  for (let seed = 1; seed <= 80; seed++) for (const tree of createSpeedRunDefinition(12, seed).trees) degrees[tree.degree]++;
  for (const count of degrees) assert.ok(count > 4600 && count < 5500, `uniform Range(0,3): ${degrees}`);
});

test('SpeedRun trees use original challenge boxes, stage balance and a persistent separate pool', () => {
  for (const stage of [0, 7, 4999, 5000]) {
    const map = createSpeedRunDefinition(stage, 41);
    assert.deepEqual(map.spawnPosition, { x: -100, z: 0 });
    assert.deepEqual(map.mapOrigin, map.spawnPosition); assert.equal(map.mapLayout, 'arena');
    assert.deepEqual(map.bulletWalls, [], 'the source challenge ground has no corridor walls');
    assert.equal(map.bounds.minX, -Infinity); assert.equal(map.bounds.maxZ, Infinity);
    assert.equal(map.skinIndex, stage % 10);
    for (const [slot, tree] of map.trees.entries()) {
      const precision = tree.degree === 1 ? 17 : stage === 0 ? 5 : 2, multiplier = [1, 1.8, 3][tree.degree];
      assert.equal(tree.id, 1000000 + slot);
      assert.equal(tree.health.compare(getStageHealth(stage).mul(multiplier).truncateSignificant(precision)), 0);
      assert.equal(tree.reward.compare(getStageMoney(stage).mul(multiplier).truncateSignificant(precision)), 0);
      assert.equal(tree.rewardPrecision, precision);
      assert.equal(tree.healthPrecision, precision);
      assert.equal(tree.collider.maxX - tree.collider.minX, 5);
      assert.equal((tree.collider.minX + tree.collider.maxX) / 2, tree.position.x - 2);
      assert.equal((tree.collider.minZ + tree.collider.maxZ) / 2, tree.position.z + 2);
    }
  }
  assert.deepEqual(createSpeedRunDefinition(0, 7), createSpeedRunDefinition(0, 7));
  assert.notDeepEqual(createSpeedRunDefinition(0, 7).trees, createSpeedRunDefinition(0, 8).trees);
  assert.deepEqual(createSpeedRunDefinition(0, 7).trees.map(t => t.id), createSpeedRunDefinition(0, 8).trees.map(t => t.id));
  assert.throws(() => createSpeedRunDefinition(-1, 1)); assert.throws(() => getSpeedRunTreeCount(1.5));
});

function place(tree, x, z, health = 2000) {
  tree.position = { x, z }; tree.health = tree.maxHealth = D.from(health); tree.alive = true;
  tree.collider = { minX: x - .5, maxX: x + .5, minZ: z - .5, maxZ: z + .5 };
}
function fire(world, type = 'SINGLE') {
  world.setLoadout([{ actorIndex: 0, weapon: { ...getWeapon(0), type }, damage: D.from(100), attackInterval: .6 }]);
  world.setMuzzleOffset({ x: 0, z: 0 }); world.player.aim = { x: 0, z: 1 };
  assert.equal(world.fire(), true);
  return world.bullets.find(bullet => bullet.damaging);
}
const warp = { preserveActorState: true, preserveProjectiles: true };

test('challenge scene Warp retains absolute projectile state, actor clocks and original lifetime', () => {
  const world = new CombatWorld(42), player = world.player;
  world.trees.length = 0; world.frameTime = 8;
  const bullet = fire(world), deadline = world.bulletTimeouts.get(bullet.id);
  world.attackClock = .41; world.autoSearchTimer = .09; world.previouslyHadTarget = true;
  world.player.targetId = world.autoTargetId = world.lockedAttackTargetId = 0;
  world.updateBullets(.05); const position = { ...bullet.position };
  const stage = createSpeedRunDefinition(0, 9);
  stage.trees = [stage.trees[0]]; place(stage.trees[0], -100, position.z + 2);
  world.reset(9, stage, warp);
  assert.equal(world.player, player); assert.deepEqual(player.position, { x: -100, z: 0 });
  assert.equal(world.attackClock, .41); assert.equal(world.autoSearchTimer, .09);
  assert.equal(world.previouslyHadTarget, true); assert.equal(world.rebirthStopped, false);
  assert.equal(player.targetId, null); assert.equal(world.autoTargetId, null); assert.equal(world.lockedAttackTargetId, null);
  assert.deepEqual(bullet.position, position); assert.equal(world.simulationTime, 8);
  assert.equal(world.bulletTimeouts.get(bullet.id), deadline);
  world.updateBullets(.1);
  assert.equal(stage.trees[0].health.toNumber(), 2000, 'Main shot at x0 cannot hit the tree at challenge x−100');
  assert.equal(bullet.damage.toNumber(), 100);
  const main = createStageDefinition(0, 0, 10); main.trees = [];
  world.reset(10, main, warp); assert.deepEqual(player.position, { x: 0, z: 0 });
  assert.equal(bullet.active, true); assert.equal(world.bulletTimeouts.get(bullet.id), deadline);
  for (let i = 0; i < 8; i++) world.advanceEffects(.1);
  assert.equal(bullet.damaging, false, 'entry/exit never restarts Invoke timeout');
  world.reset(10, main, true);
  assert.equal(bullet.active, false, 'ordinary Main replay retains its previous clearing behavior');
});

test('challenge preserves three actor identities and imposes no Main corridor or north wall', () => {
  const world = new CombatWorld(5);
  world.setLoadout([0, 1, 2].map(actorIndex => ({ actorIndex, weapon: getWeapon(0), damage: D.from(100), attackInterval: .6 })));
  const followers = [...world.followers]; followers[0].attackClock = .27; followers[1].searchTimer = .13;
  followers[0].player.targetId = 0; followers[1].player.targetId = 1;
  world.reset(2, createSpeedRunDefinition(0, 2), warp);
  assert.equal(world.followers[0], followers[0]); assert.equal(world.followers[1], followers[1]);
  assert.equal(followers[0].attackClock, .27); assert.equal(followers[1].searchTimer, .13);
  assert.equal(followers[0].player.targetId, null); assert.equal(followers[1].player.targetId, null);
  assert.deepEqual(followers[0].player.position, { x: -106, z: -6 });
  assert.deepEqual(followers[1].player.position, { x: -94, z: -6 });
  world.trees.length = 0; world.moveAndSlide({ x: -50, z: -60 });
  assert.deepEqual(world.player.position, { x: -150, z: -60 });
  world.moveAndSlide({ x: 100, z: 200 });
  assert.deepEqual(world.player.position, { x: -50, z: 140 });
});

test('stopped challenge bullets keep moving but cannot damage or settle; pool identities never alias Main', () => {
  const stage = createSpeedRunDefinition(0, 1); stage.trees = [stage.trees[0]]; place(stage.trees[0], -100, 5);
  const world = new CombatWorld(1, stage), tree = stage.trees[0], bullet = fire(world, 'LASER');
  bullet.hitIds.push(0); world.updateBullets(.1);
  assert.equal(tree.health.toNumber(), 1900, 'Main slot0 does not suppress challenge slot0');
  const next = createSpeedRunDefinition(0, 2); next.trees = [next.trees[0]];
  place(next.trees[0], -100, bullet.position.z + 4);
  world.reset(2, next, warp); world.updateBullets(.1);
  assert.equal(next.trees[0].health.toNumber(), 2000, 'same challenge pool slot retains old laser hit identity');

  const stoppedStage = createSpeedRunDefinition(0, 3); stoppedStage.trees = [stoppedStage.trees[0]];
  place(stoppedStage.trees[0], -100, 5);
  world.reset(3, stoppedStage); const stoppedBullet = fire(world);
  world.stopCombat(); world.advanceEffects(.1);
  assert.ok(stoppedBullet.position.z > 0); assert.equal(stoppedStage.trees[0].health.toNumber(), 2000);
  const events = world.drainEvents(); assert.ok(events.some(event => event.type === 'damageText'));
  assert.equal(events.some(event => event.type === 'treeDied' || event.type === 'complete'), false);
});

test('Map_obj deactivation removes tree and wall collisions while global bullets continue through loading', () => {
  const stage = createStageDefinition(0, 0, 2); stage.trees = [stage.trees[0]]; place(stage.trees[0], 0, 5);
  stage.bulletWalls = [{ minX: -10, maxX: 10, minZ: 8, maxZ: 9, minY: 0, maxY: 6 }];
  const world = new CombatWorld(2, stage), bullet = fire(world), deadline = world.bulletTimeouts.get(bullet.id);
  world.setBattlefieldActive(false); world.startCombat();
  assert.equal(world.isBattlefieldActive, false); assert.equal(world.combatStopped, true);
  assert.deepEqual(world.bulletWalls, []);
  world.advanceEffects(.2);
  assert.ok(bullet.position.z > 9); assert.equal(bullet.damaging, true);
  assert.equal(stage.trees[0].health.toNumber(), 2000); assert.equal(world.drainEvents().some(e => e.type === 'impact'), false);
  assert.equal(world.bulletTimeouts.get(bullet.id), deadline);
  const challenge = createSpeedRunDefinition(0, 3); challenge.trees = [];
  world.reset(3, challenge, warp); world.stopCombat();
  const position = { ...world.player.position }, before = world.simulationTime;
  assert.equal(world.isBattlefieldActive, true); world.advanceEffects(.1); world.startCombat();
  assert.equal(world.combatStopped, false); assert.deepEqual(world.player.position, position);
  assert.ok(world.simulationTime > before); assert.equal(world.bulletTimeouts.get(bullet.id), deadline);
});

test('challenge bullets snapshot InfVal precision and HP retains it across later weaker hits', () => {
  const stage = createSpeedRunDefinition(0, 3); stage.trees = [stage.trees[0]];
  const tree = stage.trees[0]; place(tree, -100, 5, 1700); tree.healthPrecision = 2;
  const world = new CombatWorld(3, stage);
  const loadout = (damage, damagePrecision) => [{ actorIndex: 0, weapon: getWeapon(0), damage: D.from(damage), damagePrecision, attackInterval: .6 }];
  world.setLoadout(loadout(125, 3)); world.setMuzzleOffset({ x: 0, z: 0 }); world.player.aim = { x: 0, z: 1 };
  world.fire(); const bullet = world.bullets.find(b => b.damaging);
  world.setLoadout(loadout(10, 2)); world.updateBullets(.1);
  assert.equal(bullet.damage.toNumber(), 125); assert.equal(bullet.damagePrecision, 3);
  assert.equal(tree.health.toNumber(), 1580, '170e1 - truncated12e1, not exact1575');
  assert.equal(tree.healthPrecision, 3);
  world.fire(); world.updateBullets(.1);
  assert.equal(tree.health.toNumber(), 1570); assert.equal(tree.healthPrecision, 3);

  const main = createStageDefinition(0, 0, 4); main.trees = [main.trees[0]]; place(main.trees[0], 0, 5, 1700);
  world.reset(4, main); world.setLoadout(loadout(125, 3)); world.setMuzzleOffset({ x: 0, z: 0 });
  world.fire(); world.updateBullets(.1);
  assert.equal(main.trees[0].health.toNumber(), 1575, 'existing Main arithmetic remains unchanged');
});

test('challenge critical uses source integer125/100 arithmetic and preserves the resulting bullet precision', () => {
  const world = new CombatWorld(3, createSpeedRunDefinition(0, 3)); world.trees.length = 0;
  world.setLoadout([{ actorIndex: 0, weapon: getWeapon(0), damage: D.from(450000), damagePrecision: 3,
    attackInterval: .6, criticalChance: 1, criticalMultiplier: 1.25 }]);
  world.fire(); const bullet = world.bullets.find(b => b.damaging);
  assert.equal(bullet.critical, true); assert.equal(bullet.damage.toNumber(), 562000);
  assert.equal(bullet.damagePrecision, 3, 'integer percent retains p3; double1.25 would create p17');
  world.reset(5, createStageDefinition(0, 0, 5), warp);
  assert.equal(bullet.damage.toNumber(), 562000); assert.equal(bullet.damagePrecision, 3);
  world.reset(6); assert.equal(bullet.damagePrecision, undefined, 'pool clearing cannot leak prior metadata');
});

test('arena map origin moves ground geometry once, keeps shadows absolute and restores the Main layout', () => {
  const definition = require('../assets/resources/art/maps/forest/map.json');
  class Sprite {} class UITransform {}
  class Vec4 { constructor(...values) { this.values = values; } }
  const context = { exports: {}, require: id => id === 'cc' ? { Sprite, UITransform, Vec4 } :
    id === '../core' ? core : id === './ArtLibrary' ? {} :
      id === './ResourceBatch' ? require('./support/resource-modules.cjs').resourceModules()('ResourceBatch') : require(id) };
  const source = fs.readFileSync(path.join(__dirname, '../assets/scripts/view/OriginalMapView.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText, context);
  const map = Object.create(context.exports.OriginalMapView.prototype);
  const node = () => ({ active: true, position: { x: 0, y: 0 },
    setPosition(x, y) { this.position = { x, y }; }, setScale(x, y) { this.scale = { x, y }; } });
  map.definition = definition; map.skinIndex = 0; map.origin = { x: 0, z: 0 }; map.arena = false;
  map.fillItems = []; map.shadowLayer = node(); map.material = { setProperty(name, value) { this[name] = value; } };
  map.spriteItems = ['ground', definition.borders[0].asset].map((asset, index) => {
    const item = { node: node(), asset, basis: index ? definition.borders[0] : definition.ground };
    item.visible = { node: item.node }; return item;
  });
  map.visibleItems = map.spriteItems.map(item => item.visible);
  map.setBattlefield(createSpeedRunDefinition(0, 1));
  const origin = projectWorld({ x: -100, z: 0 });
  assert.deepEqual(map.spriteItems[0].node.position, { x: origin.x, y: origin.y });
  assert.ok(Math.abs(map.spriteItems[0].node.scale.x - 15) < .00001);
  assert.ok(Math.abs(map.spriteItems[0].node.scale.y - 8.66017) < .0001);
  assert.deepEqual(map.material.groundClip.values, [.5, .5, .25, 1], 'source circle mask uses untiled sprite UV');
  const mask = map.material.groundClip.values;
  const clipped = (u, v) => mask[3] > .5 && (u - mask[0]) ** 2 + (v - mask[1]) ** 2 > mask[2];
  assert.equal(clipped(.5, .5), false);
  assert.equal(clipped(1, .5), false, 'source radius boundary is inclusive');
  assert.equal(clipped(1, 1), true, 'the former rectangular corner must be absent');
  assert.equal(clipped(.5 + Math.sqrt(.125), .5 + Math.sqrt(.125) - 1e-8), false);
  assert.equal(clipped(.9, .9), true);
  assert.deepEqual(map.shadowLayer.position, { x: 0, y: 0 });
  map.updateCamera(origin, 200, 200); assert.equal(map.spriteItems[1].node.active, false);
  map.setBattlefieldActive(false); map.updateCamera(origin, 200, 200);
  assert.equal(map.spriteItems[0].node.active, false);
  assert.equal(map.shadowLayer.active, true, 'global cat/FX shadows are outside Map_obj');
  map.setBattlefield(createStageDefinition(0, 0, 1));
  assert.deepEqual(map.spriteItems[0].node.position, { x: definition.ground.position[0], y: definition.ground.position[1] });
  assert.equal(map.spriteItems[1].node.active, true);
  assert.deepEqual(map.material.uvTransform.values, [18, 18, 0, 0]);
  assert.deepEqual(map.material.groundClip.values, [.5, .5, .25, 0], 'Main retains its full rectangular ground');
});
