const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');
const core = require('./.build/core/index.js');
const { WeaponAttackAnimator } = require('./.build/character/WeaponAttackAnimation.js');

function load(name, imports = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(projectPath(`assets/scripts/view/${name}.ts`), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS,
  } }).outputText, { module, exports: module.exports, require: key => imports[key] ?? {} });
  return module.exports;
}
const { BattlefieldView } = load('BattlefieldView', { '../core': core });

test('every family and actor prepares the real attack phase before aiming and projectile origin sampling', () => {
  for (const category of core.WEAPON_CATEGORIES) for (const actorId of [0, 1, 2]) {
    const weapon = core.getWeaponCatalog().find(item => item.category === category), operations = [];
    const animator = new WeaponAttackAnimator();
    let pose, latestState;
    const cat = {
      node: { setPosition() {} }, setWeapon: id => assert.equal(id, weapon.id),
      setAimTarget: offset => operations.push(['target', offset]),
      setAttackState(state, dt) { latestState = state; pose = animator.sample(category, state, dt); operations.push(['attack', pose.phase]); },
      updatePose(dt, moving, facing) { assert.ok(pose); operations.push(['pose', facing]); },
      setFacing: facing => operations.push(['facing', facing]),
      getBulletSpawnOffset(height) { assert.equal(height, core.WEAPON_CONFIG.bulletHeight); operations.push(['origin', pose.phase]); return { x: 2, z: 1 }; },
    };
    const field = Object.create(BattlefieldView.prototype); field.cats = new Map([[actorId, cat]]);
    const player = { actorId, weaponId: weapon.id, position: { x: 5, z: 4 }, facing: -1, moving: true };
    const context = { actorId, weaponId: weapon.id, player, targetPoint: { x: 15, z: 8 },
      attackFacing: 1, attackInterval: .6, attackProgress: 1, willFire: true, dt: 1 / 60 };
    assert.deepEqual(field.prepareCatPose(context), { x: 2, z: 1 });
    assert.deepEqual(operations.map(operation => operation[0]), ['target', 'attack', 'pose', 'facing', 'origin']);
    assert.equal(pose.phase, 'release'); assert.equal(latestState.hasTarget, true);
    operations.length = 0;
    field.prepareCatPose({ ...context, attackFacing: undefined, attackProgress: .05, willFire: false, dt: .03 });
    assert.equal(pose.phase, 'recover');
    assert.equal(operations.filter(operation => operation[0] === 'attack').length, 1);
    field.prepareCatPose({ ...context, targetPoint: null, attackFacing: undefined, attackProgress: 0, willFire: false, dt: .6 });
    assert.equal(pose.phase, 'idle'); assert.equal(latestState.hasTarget, false);
  }
});

test('scene reset prepares idle attack state for all equipped actors without inventing shots', () => {
  const noop = () => {}, samples = [], resetActors = [];
  const players = [0, 14, 23].map((weaponId, actorId) => ({ weaponId, actorId }));
  const field = Object.create(BattlefieldView.prototype);
  Object.assign(field, {
    world: { stage: {}, players, bulletWalls: [] }, map: { setBattlefield: noop }, treesLayer: {}, trees: new Map(), retiredMineViews: [],
    cats: new Map(players.map(player => [player.actorId, { reset: () => resetActors.push(player.actorId) }])),
    createTrees: noop, createRaidBoss: noop, createBoss: noop, setParticleColliders: noop, syncCharacters: noop, sortRenderGroups: noop,
    target: { reset: noop }, projectiles: { reset: noop }, numbers: { reset: noop }, moneyBurst: { reset: noop, setWalls: noop },
    impactTimeOffset: 0, lastImpactSourceTime: 0, prepareCatPose: context => samples.push(context),
  });
  field.reset(); assert.deepEqual(resetActors, [0, 1, 2]); assert.equal(samples.length, 3);
  for (const sample of samples) {
    assert.equal(sample.dt, 0); assert.equal(sample.willFire, false); assert.equal(sample.attackProgress, 0);
    assert.equal(sample.targetPoint, null); assert.equal(sample.attackInterval, core.getWeapon(sample.weaponId).attackInterval);
  }
  resetActors.length = 0; samples.length = 0;
  field.reset({ preserveCharacterState: true, preserveTransientEffects: true });
  assert.equal(resetActors.length, 0); assert.equal(samples.length, 3);
});

test('the combat provider drives each family release once per real volley through BattlefieldView', () => {
  for (const category of core.WEAPON_CATEGORIES) {
    const weapon = core.getWeaponCatalog().find(item => item.category === category);
    const world = new core.CombatWorld(42), position = { x: 2, z: 10 };
    world.trees.splice(0, world.trees.length, { id: 1000, position, health: core.DecimalAmount.from('1e30'),
      maxHealth: core.DecimalAmount.from('1e30'), degree: 0, alive: true, collider: core.treeCollider(position) });
    world.stats.totalTrees = 1;
    world.setLoadout([{ actorIndex: 0, weapon, damage: core.DecimalAmount.from(10), attackInterval: .6 }]);
    const animator = new WeaponAttackAnimator();
    let pose, state, releases = 0, volleys = 0;
    const cat = { node: { setPosition() {} }, setWeapon() {}, setAimTarget() {}, setFacing() {}, updatePose() {},
      setAttackState(next, dt) { state = next; pose = animator.sample(category, next, dt); if(next.willFire)releases++; },
      getBulletSpawnOffset() { return { x: 1.25, z: 0 }; } };
    const field = Object.create(BattlefieldView.prototype); field.cats = new Map([[0, cat]]);
    world.setMuzzleProvider(context => field.prepareCatPose(context));
    for (let frame = 0; frame < 180; frame++) {
      world.step(1 / 60);
      const shots = world.drainEvents().filter(event => event.type === 'shot');
      assert.equal(state.willFire, shots.length > 0, category);
      if (shots.length) {
        volleys++; assert.equal(pose.phase, 'release');
        assert.equal(shots.length, weapon.type === 'SHOTGUN' ? weapon.pelletCount : 1);
        for(const shot of shots)assert.ok(Math.abs(shot.position.x-world.player.position.x-1.25)<1e-8);
      }
    }
    assert.ok(volleys > 1, category); assert.equal(releases, volleys, category);
  }
});

test('shot events route every family through its real appearance, sound once per crossbow volley, and respect shooting mute', () => {
  const { WeaponVisualAssets } = load('WeaponVisualAssets');
  const weaponVisuals = new WeaponVisualAssets(require('../assets/resources/art/weapon-system/visuals.json'));
  const soundIds = { bow: 17, crossbow: 18, staff: 19, fan: 20, glove: 21, cannon: 22, handgun: 8 };
  for (const category of core.WEAPON_CATEGORIES) {
    const weapon = core.getWeaponCatalog().find(item => item.category === category);
    const sounds = [], projectiles = [], releases = [];
    const field = Object.create(BattlefieldView.prototype);
    Object.assign(field, {
      world: { simulationTime: 1, stage: {} }, art: { weaponVisuals },
      impactTimeOffset: 0, lastImpactSourceTime: 0, impactFx: { beginFrame() {} },
      cats: new Map([[0, { fire: () => releases.push(weapon.id) }]]),
      sfx: { play: id => sounds.push(id) },
      projectiles: { shot: (bulletId, weaponId) => projectiles.push([bulletId, weaponId]) },
    });
    const pelletCount = weapon.type === 'SHOTGUN' ? weapon.pelletCount : 1;
    if (category === 'crossbow') assert.ok(pelletCount > 1, 'exercise a real multi-pellet crossbow');
    const shots = Array.from({ length: pelletCount }, (_, pelletIndex) => ({
      type: 'shot', actorId: 0, weaponId: weapon.id, bulletId: pelletIndex + 1, pelletIndex,
    }));
    field.setShootingMuted(false); field.handleEvents(shots, []);
    assert.deepEqual(sounds, [soundIds[category]], `${category}: one sound for the entire volley`);
    assert.deepEqual(releases, [weapon.id]);
    assert.deepEqual(projectiles, shots.map(shot => [shot.bulletId, weapon.id]));
    field.setShootingMuted(true); field.handleEvents(shots, []);
    assert.deepEqual(sounds, [soundIds[category]], `${category}: muted shots cannot play sound`);
    assert.equal(releases.length, 2, 'muting preserves the attack animation');
    assert.equal(projectiles.length, 2 * pelletCount, 'muting preserves every projectile');
  }
});

test('piercing shuriken flashes and ordinary impacts use the same visual throttle without suppressing hits', () => {
  const flashes = [], damagedTargets = [], throttleCalls = [], numbers = [];
  const field = Object.create(BattlefieldView.prototype);
  Object.assign(field, { world: { simulationTime: 1, stage: {} }, art: {}, impactTimeOffset: 0, lastImpactSourceTime: 0,
    impactFx: { beginFrame() {}, canSpawn(id, position) { throttleCalls.push(id); return position.x > 0 && position.x < 3; } },
    trees: new Map([1, 2, 3, 4, 5].map(id => [id, { hit: () => damagedTargets.push(id) }])),
    projectiles: { hitTrigger: id => id === 4 ? 'hit' : 'impact', hit: (...args) => flashes.push(args) },
    numbers: { spawn: (...args) => numbers.push(args) },
  });
  const hits = [1, 2, 3, 4, 5].map(treeId => ({ type: 'hit', treeId, weaponId: 4, position: { x: treeId, z: 0 },
    height: 2, damage: 10, sourceTime: 1, critical: false }));
  field.handleEvents([...hits, { type: 'impact', weaponId: 4, position: { x: 5, z: 0 }, radius: 0, height: 2 },
    { ...hits[0], weaponId: 0 }, { type: 'impact', weaponId: 0, position: { x: 1, z: 0 }, radius: 0, height: 2 },
    { type: 'impact', weaponId: 0, position: { x: 0, z: 0 }, radius: 0, height: 2 }], []);
  assert.equal(flashes.filter(flash => flash[1] === 4).length, 2);
  assert.equal(flashes.filter(flash => flash[1] === 0).length, 1);
  assert.deepEqual(throttleCalls, [4, 4, 4, 4, 4, 0, 0]); assert.equal(numbers.length, 6);
  assert.deepEqual(damagedTargets, [1, 2, 3, 4, 5, 1]);
});

test('an empty non-firearm release profile initializes and fires without allocating gun sparks', () => {
  const { OriginalMuzzleEffect } = load('OriginalMuzzleEffect', { cc: { Color: class {} } });
  const effect = new OriginalMuzzleEffect({ image: () => assert.fail('empty release allocates no particles') }, {}, point => point,
    undefined, { emitter: { localScale: 1, gunScale: .4, rigScale: .55 }, particleSystems: [] }, {});
  const pose = { origin: { x: 0, y: 0 }, xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, zAxis: { x: 1, y: 0 } };
  effect.fire(pose); effect.update(.1, pose, 1, { scale: .55, projectionScaleY: 1 }); effect.reset(); effect.destroy();
  assert.equal(effect.particles.length, 0);
});

test('weapon appearance validation accepts empty release effects and rejects ambiguous bindings', () => {
  const { WeaponVisualAssets } = load('WeaponVisualAssets');
  const appearance = { id: 0, image: { path: 'bow' }, muzzle: { localPosition: [1, 0] }, projectileSkin: 'arrow', muzzleSkin: 'none' };
  const config = { weapons: [appearance], projectileSkins: { arrow: [] }, muzzleSkins: { none: { particleSystems: [] } } };
  assert.equal(new WeaponVisualAssets(config).appearance(0), appearance);
  assert.throws(() => new WeaponVisualAssets({ ...config, weapons: [appearance, appearance] }), /duplicate/);
  assert.throws(() => new WeaponVisualAssets({ ...config, muzzleSkins: {} }), /release effect/);
  const registered={...appearance,image:{path:'crossbow',sizePx:[256,143]},supportGripPx:[130,80]};
  assert.equal(new WeaponVisualAssets({...config,weapons:[registered]}).appearance(0),registered);
  for(const point of [[-1,80],[130,144],[Infinity,80],[130]])
    assert.throws(()=>new WeaponVisualAssets({...config,weapons:[{...registered,supportGripPx:point}]}),/support grip/);
  assert.throws(() => new WeaponVisualAssets({ ...config, customProjectiles: { arrow: {
    sprite: { path: 'arrow', aspect: 2 }, bodyLength: 5, flightRamp: { duration: 0 },
  } } }), /custom projectile profile/);
});
