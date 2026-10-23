const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');

// Compile in memory so the oracle is independent of both the optimized loops
// and shared .build outputs. The readable fixture freezes the original methods.
const core = path.resolve(__dirname, '../assets/scripts/core');
const modules = new Map();
function compile(source, file) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const localRequire = specifier => {
    const candidate = path.resolve(path.dirname(file), specifier + '.ts');
    return specifier.startsWith('.') && fs.existsSync(candidate) ? load(candidate) : createRequire(file)(specifier);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}
function load(file) {
  if (!modules.has(file)) modules.set(file, compile(fs.readFileSync(file, 'utf8'), file));
  return modules.get(file);
}
const moduleFor = name => load(path.join(core, name + '.ts'));
const { CombatWorld } = moduleFor('CombatWorld');
const { BruteForceWorld } = compile(fs.readFileSync(path.join(__dirname, 'fixtures/combat-spatial-before.ts.txt'), 'utf8'), path.join(core, 'BruteForceWorld.ts'));
// Preserve the frozen collision algorithm while running both implementations
// inside the same physics-time context. Event timestamps remain part of equal().
BruteForceWorld.prototype.updateBulletPhysics = BruteForceWorld.prototype.updateBullets;
BruteForceWorld.prototype.updateBullets = CombatWorld.prototype.updateBullets;
const { CombatSpatialIndex } = moduleFor('CombatSpatialIndex');
const { DecimalAmount: D } = moduleFor('DecimalAmount');
const { getWeapon, WEAPON_COUNT, WEAPON_TYPES } = moduleFor('WeaponCatalog');
const { Random } = moduleFor('math');
const { COMBAT_CONFIG: C } = moduleFor('config');
const { createStageDefinition } = moduleFor('map');
const { createBossDefinition } = moduleFor('BossMap');
const { createRaidDefinition } = moduleFor('RaidMap');
const { createHuntDefinition } = moduleFor('HuntMap');
const { BossCombat } = moduleFor('BossCombat');
const { RaidBossCombat } = moduleFor('RaidBossCombat');
const { HuntCombat } = moduleFor('HuntCombat');

function tree(id, x, z, half = .5, hp = 1000) {
  return { id, position: { x, z }, degree: 0, stageIndex: 0, reward: D.from(20), health: D.from(hp), maxHealth: D.from(hp), alive: true,
    collider: { minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half } };
}
function stage(seed, mine = false) {
  const random = new Random(seed), targets = [];
  for (let i = 0; i < 100; i++) targets.push(tree(i * 7 + 1, random.range(-35, 35), random.range(4, 140), random.range(.1, 3), 50 + Math.floor(random.range(0, 200))));
  // Reversed/unsorted IDs exercise pool order rather than ID or grid order.
  targets.reverse();
  const result = { stageIndex: 0, waveIndex: 0, skinIndex: 0, trees: targets,
    bounds: { minX: -80, maxX: 80, minZ: -20, maxZ: 180 }, bulletWalls: [], mapLayout: 'arena' };
  if (mine) {
    result.ores = targets.map((target, poolIndex) => ({ ...target, kind: 'ore', poolIndex, rare: false, score: 1 }));
    result.trees = []; result.mapLayout = 'mine';
  }
  return result;
}
function weapon(type) {
  return Array.from({ length: WEAPON_COUNT }, (_, i) => getWeapon(i)).filter(w => w.type === type).at(-1);
}
function pair(factory, type, seed = 37) {
  return [CombatWorld, BruteForceWorld].map(World => {
    const world = new World(seed, factory());
    world.setLoadout([0, 1, 2].map(actorIndex => ({ actorIndex, weapon: weapon(type), damage: D.from(30), attackInterval: .05 })));
    world.setMuzzleOffset({ x: 0, z: 0 });
    return world;
  });
}
function state(world) {
  return {
    players: world.players, stats: world.stats,
    targets: world.damageTargets.map(t => ({ id: t.id, position: t.position, collider: t.collider, health: t.health,
      maxHealth: t.maxHealth, alive: t.alive, healthPrecision: t.healthPrecision })),
    bullets: world.bullets.filter(b => b.active), timeouts: [...world.bulletTimeouts],
    frameTime: world.frameTime, physicsTime: world.physicsTime, physicsAccumulator: world.physicsAccumulator,
    nearHitPoint: world.nearHitPoint, autoTargetId: world.autoTargetId, lockedAttackTargetId: world.lockedAttackTargetId,
    attackClock: world.attackClock, bulletPoolCursor: world.bulletPoolCursor,
    events: world.drainEvents(),
  };
}
function equal(worlds, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(state(worlds[0]))), JSON.parse(JSON.stringify(state(worlds[1]))), label);
}

test('spatial candidates preserve pool order, deduplicate cells and refresh replaced or moved static colliders', () => {
  const targets = Array.from({ length: 80 }, (_, i) => tree(100 - i, i * 16, 0, i === 2 ? 9 : .5));
  const index = new CombatSpatialIndex(), output = [];
  index.synchronize(targets);
  const candidates = index.sweep({ x: 40, z: 0 }, { x: -1, z: 0 }, .2, output);
  assert.deepEqual(candidates.map(t => t.id), [100, 99, 98, 97]);
  assert.ok(candidates.length < targets.length / 10);
  const outer = [...candidates];
  index.around({ x: 1000, z: 0 }, 4, []);
  assert.deepEqual(candidates, outer, 'nested query into a different buffer cannot overwrite outer candidates');
  targets[70].collider = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
  targets[1] = tree(-25, 1, 0); targets.reverse();
  index.synchronize(targets);
  assert.deepEqual(index.around({ x: 0, z: 0 }, 1, output).map(t => t.id), [30, -25, 100]);
  targets[0].sphereCollider = { radius: 30, centerY: 2, transformY: 0 };
  targets[3].collider.minX = -Infinity;
  index.synchronize(targets);
  assert.ok(index.around({ x: 0, z: 0 }, 1, output).includes(targets[0]));
  assert.ok(output.includes(targets[3]));
  assert.equal(index.around({ x: NaN, z: 0 }, 1, output), targets);
  assert.equal(index.around({ x: 0, z: 0 }, Infinity, output), targets);
  assert.equal(index.sweep({ x: 0, z: 0 }, { x: 1e12, z: 1e12 }, 1, output), targets);
  index.generation = 0xffffffff;
  assert.ok(index.around({ x: 0, z: 0 }, 1, output).includes(targets.at(-1)), 'stamp rollover retains candidates');
});

for (const type of WEAPON_TYPES) test(`${type}: randomized frame state and event order match the original full-pool loops`, () => {
  for (const seed of [1, 42, 873]) {
    const worlds = pair(() => stage(seed, seed === 873), type, seed);
    const random = new Random(seed + 99);
    for (let frame = 0; frame < 150; frame++) {
      const dt = [1 / 120, 1 / 60, 1 / 30, .09][Math.floor(random.next() * 4)];
      const input = { x: random.range(-1, 1), y: random.range(-1, 1) };
      for (const world of worlds) {
        if (frame % 17 === 0) world.setMovementInput(input);
        if (frame % 9 === 0) { world.player.aim = { x: 0, z: 1 }; world.fire(); }
        if (frame === 30) {
          const target = world.damageTargets[70];
          target.position = { x: 0, z: 8 }; target.collider = { minX: -1, maxX: 1, minZ: 7, maxZ: 9 };
          // A same-length direct pool replacement must also invalidate the index.
          const pool = world.stage.ores ?? world.trees;
          pool[4] = { ...pool[4], collider: { minX: -1, maxX: 1, minZ: 15, maxZ: 17 } };
        }
        if (frame === 50) { world.damageTargets[70].alive = false; world.damageTargets[70].health = D.from(0); }
        if (frame === 53) { world.damageTargets[70].alive = true; world.damageTargets[70].health = D.from(80); }
        if (frame === 65) world.beginRebirth();
        if (frame === 68) world.reset(seed + 1, stage(seed + 1, seed === 873), { rebirth: true });
        if (frame === 100) world.setBattlefieldActive(false);
        if (frame === 102) { world.setBattlefieldActive(true); world.startCombat(); }
        world.step(dt);
      }
      equal(worlds, `${type} seed ${seed} frame ${frame}`);
    }
  }
});

test('cell edges, identical contact times, penetration and nested explosions retain original hit ordering', () => {
  for (const type of WEAPON_TYPES) {
    const worlds = pair(() => {
      const s = stage(7); s.trees = [tree(55, 8, 8, .5, 1), tree(3, 8, 8, .5, 1), tree(90, 8, 16, .5, 1),
        tree(2, 7.5, 24, 8, 500), ...s.trees]; return s;
    }, type);
    for (const world of worlds) {
      world.player.position = { x: 8, z: 0 }; world.player.aim = { x: 0, z: 1 };
      world.player.targetId = 55; world.nearHitPoint = { x: 8, z: 8 }; world.fire();
      world.updateBullets(.5); world.updateMissiles(.3);
    }
    equal(worlds, `${type} tied contact`);
  }
});

test('501-target main-stage simulation matches the original for mixed weapons and retained projectiles', () => {
  const worlds = pair(() => createStageDefinition(100, 4, 42), 'SHOTGUN');
  for (const world of worlds) world.setLoadout(['SHOTGUN', 'MISSILE', 'BLAST_SNIPER'].map((type, actorIndex) => ({
    actorIndex, weapon: weapon(type), damage: D.from('100000000000000000000000'), attackInterval: .05,
  })));
  for (let frame = 0; frame < 180; frame++) {
    for (const world of worlds) {
      if (frame === 90) world.reset(17, createStageDefinition(100, 4, 17), { preserveActorState: true, preserveProjectiles: true });
      world.step(1 / 60);
    }
    equal(worlds, `501 targets frame ${frame}`);
  }
});

test('epsilon contacts across a cell edge and unusual sweeps or explosions match the original fallback', () => {
  const worlds = pair(() => {
    const result = stage(7);
    result.trees = [tree(17, 0, 8.5), ...Array.from({ length: 30 }, (_, i) => tree(i + 100, 500 + i * 16, 200))];
    return result;
  }, 'SINGLE');
  for (const world of worlds) {
    world.fire();
    const bullet = world.bullets.find(b => b.damaging);
    bullet.position = { x: 0, z: 0 }; bullet.direction = { x: 0, z: 1 };
    bullet.speed = (8 - C.bulletRadius - 1e-9) / .02;
    world.updateBullets(.02);
    assert.equal(world.stats.hits, 1, 'the exact sweep accepts a contact just beyond its endpoint');
  }
  equal(worlds, 'epsilon endpoint');
  for (const [kind, value] of [['sweep', 1e12], ['sweep', NaN], ['explosion', 1e12], ['explosion', Infinity], ['explosion', NaN]]) {
    const unusual = pair(() => stage(17), kind === 'sweep' ? 'LASER' : 'EXPLOSIVE');
    for (const world of unusual) {
      world.fire();
      const bullet = world.bullets.find(b => b.damaging);
      if (kind === 'sweep') { bullet.speed = value; world.updateBullets(.02); }
      else { bullet.explosionRadius = value; world.explode(bullet, { x: 0, z: 10 }); }
    }
    equal(unusual, `${kind} ${value}`);
  }
});

test('mode switches retain old bullets while dynamic Boss, Raid and Hunt shapes always use current positions', () => {
  const factories = [() => stage(42), () => createBossDefinition(new BossCombat(0, 7)),
    () => createRaidDefinition(new RaidBossCombat(0)), () => {
      const hunt = new HuntCombat(0, 4, 7); hunt.startLevel();
      for (let i = 0; i < 30; i++) hunt.update(.4);
      return createHuntDefinition(hunt);
    }, () => stage(7, true)];
  const worlds = pair(factories[0], 'MISSILE');
  for (let mode = 0; mode < factories.length; mode++) for (let frame = 0; frame < 70; frame++) {
    for (const world of worlds) {
      if (frame === 0) world.reset(mode + 1, factories[mode](), { preserveActorState: true, preserveProjectiles: true });
      if (frame % 5 === 0) world.fire();
      world.step(.03);
    }
    equal(worlds, `mode ${mode} frame ${frame}`);
  }
});
