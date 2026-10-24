const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function load(name, imports = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, `assets/scripts/view/${name}.ts`), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
    { module, exports: module.exports, require: key => imports[key] ?? {} });
  return module.exports;
}
const catalog = require('./.build/core/WeaponCatalog.js');
const { OriginalImpactFxThrottle: Gate } = load('OriginalImpactFxThrottle', { '../core/WeaponCatalog': catalog });

test('FXThrottle keeps source zero-initialized per-gun state and 3D distance', () => {
  const gate = new Gate(); gate.beginFrame(0);
  assert.equal(gate.canSpawn(0, {x:0,z:0}, 0), false);
  assert.equal(gate.canSpawn(0, {x:0,z:0}, 1.499), false);
  assert.equal(gate.canSpawn(0, {x:0,z:0}, 1.5), true, 'height alone can meet the original squared-distance threshold');
});

test('FXThrottle covers all appended crossbows and rejects out-of-range IDs without consuming the frame cap', () => {
  const gate = new Gate(); gate.beginFrame(1);
  for (const id of [-1, 65, 66]) assert.equal(gate.canSpawn(id, { x: 10, z: 10 }, 2), false);
  for (const id of [62, 63, 64]) assert.equal(gate.canSpawn(id, { x: 10, z: 10 }, 2), true);
  assert.equal(gate.canSpawn(2, { x: 10, z: 10 }, 2), false);
});

test('same gun admits a burst after 50ms OR 1.5 world units, not only when both are met', () => {
  const gate = new Gate(); gate.beginFrame(0);
  assert.equal(gate.canSpawn(8, {x:10,z:10}, 2), true);
  gate.beginFrame(.049);
  assert.equal(gate.canSpawn(8, {x:10,z:10}, 2), false);
  gate.beginFrame(.05);
  assert.equal(gate.canSpawn(8, {x:10,z:10}, 2), true);
  assert.equal(gate.canSpawn(8, {x:11.499,z:10}, 2), false);
  assert.equal(gate.canSpawn(8, {x:11.5,z:10}, 2), true);
  assert.equal(gate.canSpawn(9, {x:11.5,z:10}, 2), true, 'different gun ID does not share the spatial cooldown');
});

test('every actor, gun, wall and blast shares the three-FX render-frame cap; rejection does not consume a gun cooldown', () => {
  const gate = new Gate(); gate.beginFrame(1);
  for (const id of [0, 1, 2]) assert.equal(gate.canSpawn(id, {x:4,z:5}, 2), true);
  assert.equal(gate.canSpawn(3, {x:4,z:5}, 2), false);
  gate.beginFrame(1);
  assert.equal(gate.canSpawn(3, {x:4,z:5}, 2), true);
  assert.equal(gate.canSpawn(0, {x:4,z:5}, 2), false);
  assert.equal(gate.canSpawn(0, {x:4,z:6.5}, 2), true);
});

test('Battlefield filters only impact rendering, retains all damage numbers and source shot/actor dispatch', () => {
  const { BattlefieldView } = load('BattlefieldView');
  const view = Object.create(BattlefieldView.prototype), effects = [], numbers = [], sounds = [], fires = [];
  Object.assign(view, { pets: new Map(), world: { simulationTime: 1, stage: {} }, impactFx: new Gate(), impactTimeOffset: 0, lastImpactSourceTime: 0,
    art: {}, sfx: { play: id => sounds.push(id) }, getCat: id => ({ fire: () => fires.push(id) }),
    projectiles: { hit: (...args) => effects.push(args), shot() {} }, trees: new Map(), numbers: { spawn: (...args) => numbers.push(args) } });
  const events = [];
  for (let id = 0; id < 5; id++) {
    events.push({ type:'impact', weaponId:id, position:{x:0,z:4}, radius:id===4?5:0, height:2 });
    events.push({ type:'hit', treeId:id, position:{x:0,z:4}, damage:100, sourceTime:1, height:id===0?8:undefined });
  }
  events.push({ type:'shot', actorId:1, weaponId:4, pelletIndex:0, bulletId:0 },
    { type:'shot', actorId:1, weaponId:4, pelletIndex:1, bulletId:1 }, { type:'shot', actorId:2, weaponId:14, pelletIndex:0, bulletId:2 });
  view.handleEvents(events, []);
  assert.equal(effects.length, 3); assert.equal(numbers.length, 5);
  assert.equal(numbers[0][4],8,'damage rendering receives the Raid surface height');
  assert.equal(numbers[1][4],undefined,'ordinary events retain the default height');
  assert.deepEqual(fires, [1,2]); assert.deepEqual(sounds, [8,8]);
  view.setShootingMuted(true); view.world.simulationTime += .06;
  view.handleEvents([events.at(-1)], []); assert.deepEqual(sounds, [8,8]);
});

test('building surface mapping is shared by the arrow tip and its single flash, even when flash throttling rejects it', () => {
  const { BattlefieldView } = load('BattlefieldView');
  const view = Object.create(BattlefieldView.prototype), contacts = [], effects = [], mappings = [];
  const painted = { x: 2, z: 3 }, physical = { x: 6, z: 7 };
  let allowed = true;
  Object.assign(view, { world: { simulationTime: 1, stage: {} }, impactTimeOffset: 0, lastImpactSourceTime: 0,
    impactFx: { beginFrame() {}, canSpawn() { return allowed; } },
    trees: new Map([[12, { impactPosition(point, height) { mappings.push([point, height]); return painted; } }]]),
    projectiles: { contact: (...args) => contacts.push(args), hit: (...args) => effects.push(args), hitTrigger: () => 'impact' },
  });
  const event = { type: 'impact', bulletId: 7, treeId: 12, weaponId: 0, position: physical, height: 2, radius: 0, sourceTime: 1 };
  view.handleEvents([event], []);
  assert.deepEqual(contacts, [[7, 0, painted, 2]]); assert.deepEqual(effects, [[painted, 0, 0, 2]]);
  allowed = false; view.handleEvents([event], []);
  assert.equal(contacts.length, 2, 'suppressed flash still supplies the actual arrow contact');
  assert.equal(effects.length, 1, 'surface correction never duplicates flashes');
  assert.equal(event.position, physical, 'view cannot mutate the gameplay event or its damage position');
  assert.deepEqual(mappings, [[physical, 2], [physical, 2]]);
});

test('ordinary impacts and piercing hits share one three-FX frame budget across the squad without dropping feedback or rewards', () => {
  const core = require('./.build/core/index.js');
  const { BattlefieldView } = load('BattlefieldView', { '../core': core });
  const view = Object.create(BattlefieldView.prototype), gate = new Gate();
  const effects = [], numbers = [], moneyNumbers = [], moneyBursts = [], damagedTargets = [], throttleCalls = [];
  const canSpawn = gate.canSpawn.bind(gate);
  gate.canSpawn = (...args) => { throttleCalls.push(args); return canSpawn(...args); };
  Object.assign(view, { world: { simulationTime: 1, stage: {} }, impactFx: gate,
    impactTimeOffset: 0, lastImpactSourceTime: 0,
    projectiles: { hitTrigger: id => [4, 7].includes(id) ? 'hit' : 'impact', hit: (...args) => effects.push(args) },
    trees: new Map([1, 2, 3, 4].map(id => [id, { hit: () => damagedTargets.push(id), impactPosition: point => point }])),
    numbers: { spawn: (...args) => numbers.push(args), spawnMoney: (...args) => moneyNumbers.push(args) },
    moneyBurst: { spawn: (...args) => moneyBursts.push(args) },
  });
  const hit = (treeId, weaponId, actorId, x, height, sourceTime) => ({ type: 'hit', treeId, weaponId, actorId,
    position: { x, z: 10 }, height, sourceTime, damage: 100, critical: false });
  const reward = { treeId: 3, position: { x: 16, z: 10 }, amount: 50, sourceTime: 1 };
  view.handleEvents([
    { type: 'impact', weaponId: 0, actorId: 0, position: { x: 10, z: 10 }, radius: 4, height: 2, sourceTime: .94 },
    hit(1, 4, 1, 12, undefined, .96),
    { type: 'impact', weaponId: 4, actorId: 1, position: { x: 14, z: 10 }, radius: 0, height: 2, sourceTime: .96 },
    hit(2, 7, 2, 14, 8, .98),
    { type: 'impact', weaponId: 1, actorId: 0, position: { x: 16, z: 10 }, radius: 0, height: 2, sourceTime: 1 },
    hit(3, 4, 1, 16, 2, 1),
    hit(4, 0, 0, 10, 2, 1),
    { type: 'treeDied', treeId: 3 },
  ], [reward]);
  assert.deepEqual(effects.map(effect => effect[1]), [0, 4, 7], 'all physics ticks and actors share one render-frame budget');
  assert.equal(effects[0][2], 4, 'ordinary blast radius is retained');
  assert.equal(effects[1][3], core.WEAPON_CONFIG.bulletHeight, 'omitted hit height uses the configured projectile height');
  assert.equal(effects[2][3], 8, 'explicit surface height reaches the particle effect');
  assert.deepEqual(throttleCalls.map(call => call[0]), [0, 4, 7, 1, 4], 'terminal shuriken impacts neither flash nor consume the shared gate');
  assert.deepEqual(damagedTargets, [1, 2, 3, 4], 'suppressed flashes still deliver every target hit reaction');
  assert.deepEqual(numbers.map(number => number[1]), [100, 100, 100, 100], 'damage text dispatch is independent of the FX budget');
  assert.deepEqual(moneyNumbers, [[reward.position, reward.amount, reward.sourceTime]]);
  assert.deepEqual(moneyBursts, [[reward.position, reward.sourceTime]]);
});

test('piercing hits use the source per-weapon 50ms OR 1.5-unit cooldown including default and explicit heights', () => {
  const core = require('./.build/core/index.js');
  const { BattlefieldView } = load('BattlefieldView', { '../core': core });
  const view = Object.create(BattlefieldView.prototype), effects = [], numbers = [];
  Object.assign(view, { world: { simulationTime: 0, stage: {} }, impactFx: new Gate(),
    impactTimeOffset: 0, lastImpactSourceTime: 0, trees: new Map(),
    projectiles: { hitTrigger: () => 'hit', hit: (...args) => effects.push(args) },
    numbers: { spawn: (...args) => numbers.push(args) },
  });
  const hit = (actorId, x = 10, height) => ({ type: 'hit', actorId, weaponId: 4, treeId: 1,
    position: { x, z: 10 }, height, sourceTime: view.world.simulationTime, damage: 100, critical: false });
  view.handleEvents([hit(0)], []);
  assert.equal(effects.length, 1);
  view.world.simulationTime = .049;
  view.handleEvents([hit(1)], []);
  assert.equal(effects.length, 1, 'a different actor using the same weapon cannot bypass the near-hit cooldown');
  view.world.simulationTime = .05;
  view.handleEvents([hit(2), hit(0, 11.499), hit(1, 11.5),
    hit(2, 11.5, core.WEAPON_CONFIG.bulletHeight + 1.499),
    hit(0, 11.5, core.WEAPON_CONFIG.bulletHeight + 1.5)], []);
  assert.deepEqual(effects.map(effect => [effect[0].x, effect[3]]), [
    [10, core.WEAPON_CONFIG.bulletHeight],
    [10, core.WEAPON_CONFIG.bulletHeight],
    [11.5, core.WEAPON_CONFIG.bulletHeight],
    [11.5, core.WEAPON_CONFIG.bulletHeight + 1.5],
  ]);
  assert.equal(numbers.length, 7, 'time and distance suppression only reduce visual hit bursts');
});

test('fixed-step timestamps control impact cooldowns while every physics step still shares the render-frame cap', () => {
  const core = require('./.build/core/index.js');
  const { BattlefieldView } = load('BattlefieldView', { '../core': core });
  const view = Object.create(BattlefieldView.prototype), effects = [], numbers = [];
  Object.assign(view, { world: { simulationTime: .2, stage: {} }, impactFx: new Gate(),
    impactTimeOffset: 0, lastImpactSourceTime: 0, trees: new Map(),
    projectiles: { hitTrigger: id => id === 4 ? 'hit' : 'impact', hit: (...args) => effects.push(args) },
    numbers: { spawn: (...args) => numbers.push(args) },
  });
  const impact = sourceTime => ({ type: 'impact', weaponId: 0, actorId: 0,
    position: { x: 10, z: 10 }, height: 2, radius: 0, sourceTime });
  const hit = sourceTime => ({ type: 'hit', actorId: 1, weaponId: 4, treeId: 1,
    position: { x: 12, z: 10 }, height: 2, sourceTime, damage: 100, critical: false });
  view.handleEvents([impact(.02), impact(.04), impact(.08), hit(.1), hit(.18)], []);
  assert.deepEqual(effects.map(effect => effect[1]), [0, 0, 4],
    'elapsed fixed-step time admits the second ordinary impact, but never raises the frame cap above three');
  assert.equal(numbers.length, 2, 'the fourth eligible burst is hidden without losing its hit event');
  view.world.simulationTime = .22;
  view.handleEvents([hit(.22)], []);
  assert.equal(effects.length, 4, 'the next frame renews the budget and the rejected .18 hit did not advance the weapon cooldown');
});

test('suppression is visual only: a rejected first FX never suppresses blast damage or permits a later enemy FX', () => {
  const { CombatWorld, DecimalAmount } = require('./.build/core/index.js');
  const { getWeapon } = require('./.build/core/WeaponCatalog.js');
  const world = new CombatWorld(42), gun = { ...getWeapon(0), type:'BLAST_SNIPER', blastSniperExplosionRadius:1 };
  world.setLoadout([{actorIndex:0,weapon:gun,damage:DecimalAmount.from(100),attackInterval:.6}]);
  const enemy = (id,z,health) => ({id,position:{x:0,z},degree:0,alive:true,health,maxHealth:health,collider:{minX:-.5,maxX:.5,minZ:z-.5,maxZ:z+.5}});
  world.trees.splice(0,world.trees.length,enemy(0,5,100),enemy(1,10,1000),enemy(2,15,1000));
  world.stats.totalTrees=3; world.player.aim={x:0,z:1}; world.setMuzzleOffset({x:0,z:0});
  world.fire(); world.updateBullets(.4);
  const events=world.drainEvents(), gate=new Gate(); gate.beginFrame(0);
  for(let i=0;i<3;i++)assert.equal(gate.canSpawn(i,{x:10,z:10},2),true);
  assert.equal(events.filter(e=>e.type==='impact'&&gate.canSpawn(e.weaponId,e.position,e.height)).length,0);
  assert.deepEqual(world.trees.map(t=>Number(t.health)),[0,900,900]);
  assert.equal(events.filter(e=>e.type==='impact').length,1);
});

test('round reset retains the global FX cooldown even when both rounds have the same first frame timestamp', () => {
  const { BattlefieldView } = load('BattlefieldView', { '../core': { MAP_CONFIG: { bulletWalls: [] } } });
  const view = Object.create(BattlefieldView.prototype), effects = [], noop = () => {};
  Object.assign(view, { pets: new Map(), world: { simulationTime: .02, trees: [], damageTargets: [], players: [], stage: { stageIndex: 0 }, bulletWalls: [] }, impactFx: new Gate(), map: { setBattlefield: noop }, bossSortingLayer: { active: true },
    impactTimeOffset: 0, lastImpactSourceTime: 0, cats: new Map(), trees: new Map(), retiredMineViews: [], treesLayer: { active: true }, sortRenderGroups: noop,
    target: { reset: noop }, numbers: { reset: noop }, moneyBurst: { reset: noop, setWalls: noop },
    projectiles: { hit: (...args) => effects.push(args), reset: noop, setColliders: noop } });
  const event = { type: 'impact', weaponId: 0, position: { x: 10, z: 10 }, height: 2, radius: 0 };
  view.handleEvents([event], []); assert.equal(effects.length, 1);
  view.world.simulationTime = 0; view.reset();
  view.world.simulationTime = .02; view.handleEvents([event], []); assert.equal(effects.length, 1);
  view.world.simulationTime = .05; view.handleEvents([event], []); assert.equal(effects.length, 2);
});

test('rebirth map rebuild preserves global effects and their continuous FX cooldown clock', () => {
  const { BattlefieldView } = load('BattlefieldView');
  const view = Object.create(BattlefieldView.prototype), effects = [], resets = [], noop = () => {};
  Object.assign(view, { pets: new Map(), world: { simulationTime: 3, trees: [], damageTargets: [], players: [], stage: { stageIndex: 0 }, bulletWalls: [] }, bossSortingLayer: { active: true },
    impactFx: new Gate(), map: { setBattlefield: noop }, impactTimeOffset: 0, lastImpactSourceTime: 0,
    cats: new Map(), trees: new Map(), treesLayer: { active: true }, target: { reset: noop }, sortRenderGroups: noop,
    numbers: { reset: () => resets.push('numbers') }, moneyBurst: { reset: () => resets.push('money'), setWalls: noop },
    projectiles: { hit: (...args) => effects.push(args), reset: () => resets.push('projectiles'), setColliders: noop } });
  const event = { type: 'impact', weaponId: 0, position: { x: 10, z: 10 }, height: 2, radius: 0 };
  view.handleEvents([event], []); assert.equal(effects.length, 1);
  view.reset({ preserveCharacterState: true, preserveTransientEffects: true });
  assert.deepEqual(resets, [], 'source independent pools are not children of the rebuilt Map_obj');
  view.world.simulationTime = 3.02; view.handleEvents([event], []); assert.equal(effects.length, 1);
  view.world.simulationTime = 3.06; view.handleEvents([event], []); assert.equal(effects.length, 2);
});

test('hiding Map_obj removes visual colliders and tree UI without clearing global effects', () => {
  const { BattlefieldView } = load('BattlefieldView');
  const view = Object.create(BattlefieldView.prototype), resets = [], colliderLists = [], walls = [];
  const tree = { node: { active: true }, healthRoot: { active: true }, healthFillRoot: { active: true } };
  Object.assign(view, { pets: new Map(), world: { trees: [], damageTargets: [], bulletWalls: [] }, map: { setBattlefieldActive: active => walls.push(active) }, bossSortingLayer: { active: true },
    treesLayer: { active: true }, trees: new Map([[1, tree]]), target: { reset: () => resets.push('target') },
    projectiles: { reset: () => resets.push('projectiles'), setColliders: value => colliderLists.push(value) },
    moneyBurst: { reset: () => resets.push('money'), setWalls: value => walls.push(value) },
    numbers: { reset: () => resets.push('numbers') } });
  view.setBattlefieldActive(false);
  assert.equal(tree.node.active, false); assert.equal(tree.healthRoot.active, false); assert.equal(tree.healthFillRoot.active, false);
  assert.deepEqual(resets, ['target']); assert.equal(colliderLists[0].length, 0); assert.equal(walls[0], false);
});
