const test = require('node:test');
const { assert, fixture } = require('./support/boss-session-fixture.cjs');
const { CombatWorld, DecimalAmount: D } = require('./.build/core/index.js');

const VARIANTS = [60, 63, 64];
const MODES = ['Main', 'Boss', 'SpeedRun', 'Raid'];

function variantSession({ upgraded = false, capped = false, stars = [0, 0, 0] } = {}) {
  const f = fixture();
  const saved = JSON.parse(f.data.get(f.key));
  saved.weapons.equipment = VARIANTS.map((weaponId, index) => ({ weaponId, locked: index === 1, pendingAd: false }));
  VARIANTS.forEach(id => { saved.weapons.collection[id] = true; });
  saved.weapons.starLevels = stars;
  if (upgraded) {
    saved.levels = [1, 10, 0];
    saved.rebirth.levels = [1, 20, 0];
    saved.skins.owned[24] = true;
  }
  if (capped) {
    saved.levels[1] = 10000;
    saved.rebirth.levels[1] = 20000;
    saved.skins.owned.fill(true);
  }
  f.data.set(f.key, JSON.stringify(saved));
  return { ...f, session: f.restore() };
}

function enter(session, mode) {
  if (mode === 'Raid') {
    assert.equal(session.openRaid().ok, true);
    assert.equal(session.startRaid().ok, true);
  } else if (mode === 'Boss') assert.equal(session.startBoss().ok, true);
  else if (mode === 'SpeedRun') assert.equal(session.startSpeedRun().ok, true);
  if (mode !== 'Main') session.advanceFrame(2);
  assert.equal(session.mode, mode);
}

function orderedLoadout(session) {
  return VARIANTS.map(id => {
    const actor = session.getLoadout().find(entry => entry.weapon.id === id);
    assert.ok(actor, `weapon ${id} remains equipped in ${session.mode}`);
    return actor;
  });
}

test('tuned fast bow and crossbows feed damage, stars and cooldown into all four modes', () => {
  // Gold power 108%, rebirth power 105%, skin power 484%, star 150%.
  // InfVal cuts each operation; Boss omits gold, Raid omits gold and rebirth.
  // Speed divisors are 520 (Main/SpeedRun), 340 (Boss), 240 (Raid).
  const expected = {
    Main: { damage: ['411', '1470', '2460'], interval: [0.057692307978868484, 0.1538461595773697, 0.23076923191547394] },
    Boss: { damage: ['381', '1370', '2280'], interval: [0.0882352963089943, 0.2352941334247589, 0.3529411852359772] },
    Raid: { damage: ['363', '1300', '2170'], interval: [0.1250000149011612, 0.3333333432674408, 0.5000000596046448] },
  };
  for (const mode of MODES) {
    const { session } = variantSession({ upgraded: true, stars: [1, 1, 1] });
    enter(session, mode);
    const actors = orderedLoadout(session), row = expected[mode === 'SpeedRun' ? 'Main' : mode];
    assert.deepEqual(actors.map(a => a.damage.toString()), row.damage, `${mode} damage`);
    assert.deepEqual(actors.map(a => a.attackInterval), row.interval, `${mode} cooldown`);
    assert.deepEqual(actors.map(a => a.starLevel), [1, 1, 1]);
  }
});

test('real variant volleys retain tuned per-arrow damage and their distinct cooldowns', () => {
  const { session } = variantSession();
  const expected = [
    { count: 1, damage: 50, interval: Math.fround(.3) },
    { count: 2, damage: 180, interval: Math.fround(.8) },
    { count: 3, damage: 300, interval: Math.fround(1.2) },
  ];
  orderedLoadout(session).forEach((actor, index) => {
    const row = expected[index], world = new CombatWorld(42);
    world.setLoadout([{ ...actor, actorIndex: 0 }]);
    world.player.position = { x: 0, z: 0 };
    world.player.aim = { x: 0, z: 1 };
    world.setMuzzleOffset({ x: 0, z: 0 });
    // A broad target catches the existing random shotgun cone without changing it.
    world.trees.splice(0, world.trees.length, { id: 1, position: { x: 0, z: 5 }, degree: 0, stageIndex: 0,
      reward: D.from(20), health: D.from(100000), maxHealth: D.from(100000), alive: true,
      collider: { minX: -2, maxX: 2, minZ: 4, maxZ: 6 } });
    world.stats.totalTrees = 1;
    assert.equal(world.attackInterval, row.interval);
    assert.equal(world.fire(), true);
    const shots = world.drainEvents().filter(event => event.type === 'shot');
    assert.equal(shots.length, row.count, `weapon ${actor.weapon.id} projectile count`);
    assert.equal(new Set(shots.map(event => event.volleyId)).size, 1);
    for (const shot of shots) {
      assert.equal(shot.weaponId, actor.weapon.id);
      assert.equal(world.bullets[shot.bulletId].damage.toNumber(), row.damage);
    }
    world.updateBullets(.2);
    const hits = world.drainEvents().filter(event => event.type === 'hit');
    assert.deepEqual(hits.map(event => event.damage.toNumber()), new Array(row.count).fill(row.damage));
    assert.equal(world.trees[0].health.toNumber(), 100000 - row.count * row.damage);
  });
});

test('variant cooldowns keep the original 0.05-second floor under maximum bonuses in every mode', () => {
  for (const mode of MODES) {
    const { session } = variantSession({ capped: true });
    enter(session, mode);
    const actors = orderedLoadout(session);
    assert.deepEqual(actors.map(a => a.attackInterval), new Array(3).fill(Math.fround(.05)), mode);
    const world = new CombatWorld(42);
    world.setLoadout(session.getLoadout());
    assert.equal(world.attackInterval, Math.fround(.05), `${mode} live combat floor`);
  }
});

test('reloading tuned variants retains equipment identity, locks, slot stars and derived balance', () => {
  const f = variantSession({ upgraded: true, stars: [1, 2, 3] });
  const before = f.session.weapons.serialize();
  const balance = session => orderedLoadout(session).map(actor => [actor.weapon.id, actor.starLevel,
    actor.damage.toString(), actor.damagePrecision, actor.attackInterval]);
  const restored = f.restore();
  assert.deepEqual(restored.weapons.serialize().equipment, before.equipment);
  assert.deepEqual(restored.weapons.serialize().starLevels, [1, 2, 3]);
  assert.deepEqual(balance(restored), balance(f.session));
});
