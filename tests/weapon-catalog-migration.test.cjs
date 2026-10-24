const test = require('node:test');
const assert = require('node:assert/strict');
const legacy = require('./fixtures/legacy-weapon-data.json');
const { getWeapon, getWeaponCatalog, getWeaponIdsForGrade, WEAPON_CATEGORIES,
  WEAPON_CATEGORY_BY_TYPE, WEAPON_CATEGORY_NAMES, WEAPON_CATALOG_VERSION, WEAPON_COUNT } = require('./.build/session/core/WeaponCatalog.js');
const { WeaponInventory } = require('./.build/session/session/WeaponInventory.js');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');
const clone = value => JSON.parse(JSON.stringify(value));
function currentInventory() {
  const state = new WeaponInventory().serialize();
  state.collection.fill(true);
  state.equipment = [{ weaponId: 64, locked: true, pendingAd: false }, null, { weaponId: 28, locked: false, pendingAd: false }];
  state.backpack[0] = { weaponId: 1, locked: true, pendingAd: false };
  state.backpack[1] = { weaponId: 2, locked: false, pendingAd: false };
  state.backpack[2] = { weaponId: 8, locked: false, pendingAd: true };
  state.adGunExpiresAt = 2000000; state.adGunOffered = true;
  state.diamonds = 12345; state.starGems = 678; state.stageValueMax = 400;
  state.starLevels = [8, 13, 20]; state.starFailures = [0, 1, 4]; state.autoEnabled = true;
  return state;
}
function memoryStore(initial = []) {
  const data = new Map(initial), writes = [];
  return { data, writes, getItem: key => data.get(key) ?? null, setItem: (key, value) => { writes.push(key); data.set(key, value); } };
}
const options = storage => ({ environment: 'production', storage, now: () => 1000000,
  contentConfig: resolveContentConfig('production', { adsEnabled: true, tutorialEnabled: false, firstDrawDiamonds: 0, thresholds: { challengePowerLevel: 0 } }) });
function currentSave() {
  const store = memoryStore(); new BattleSession(options(store));
  const save = JSON.parse(store.data.get(economyStorageKey('production')));
  save.weapons = currentInventory(); save.money = { digits: '123456789', exponent: 0, precision: 9 }; save.levels = [5, 4, 3];
  return JSON.stringify(save);
}
function quiet(fn) { const old = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = old; } }

test('65 weapons preserve existing IDs and append the three same-grade crossbows', () => {
  const catalog = getWeaponCatalog(), kinds = ['SINGLE', 'SHOTGUN', 'PIERCE', 'EXPLOSIVE', 'LASER', 'BLAST_SNIPER', 'MISSILE'];
  const ranges = [[0, 3], [0, 4], [1, 12], [2, 12], [3, 12], [4, 12], [5, 12]];
  assert.equal(catalog.length, 65);
  assert.deepEqual(Array.from({ length: 13 }, (_, g) => getWeaponIdsForGrade(g).length), new Array(13).fill(5));
  WEAPON_CATEGORIES.forEach((category, i) => { const [start, end] = ranges[i];
    assert.deepEqual(catalog.filter(w => w.id < 59 && w.category === category).map(w => w.grade), Array.from({ length: end - start + 1 }, (_, j) => start + j)); });
  catalog.forEach((w, id) => { assert.equal(w.id, id); assert.equal(w.type, kinds[WEAPON_CATEGORIES.indexOf(w.category)]); assert.ok(Object.isFrozen(w));
    if (id && id < 59) assert.ok(w.grade > catalog[id - 1].grade || WEAPON_CATEGORIES.indexOf(w.category) > WEAPON_CATEGORIES.indexOf(catalog[id - 1].category)); });
  assert.deepEqual(catalog.slice(59).map(w => [w.id, w.category, w.grade]), [[59,'bow',0],[60,'bow',0],[61,'bow',1],[62,'crossbow',0],[63,'crossbow',1],[64,'crossbow',2]]);
  assert.ok(Object.isFrozen(getWeaponIdsForGrade(0))); assert.throws(() => getWeaponIdsForGrade(-1));
});

test('Raid mechanism names resolve explicitly to all seven authored families', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(WEAPON_CATEGORY_BY_TYPE).map(([type, category]) => [type, WEAPON_CATEGORY_NAMES[category]])), {
    SINGLE: '弓', SHOTGUN: '弩', PIERCE: '拳套', EXPLOSIVE: '法杖', LASER: '扇子', BLAST_SNIPER: '火铳', MISSILE: '火炮',
  });
  getWeaponCatalog().forEach(weapon => assert.equal(WEAPON_CATEGORY_BY_TYPE[weapon.type], weapon.category));
  assert.ok(Object.isFrozen(WEAPON_CATEGORY_BY_TYPE));
});

test('61 native balances match explicit original sources; four authored weapons are extrapolated', () => {
  const fields = ['damage', 'attackInterval', 'pelletCount', 'shotgunSpreadAngle', 'explosionRadius', 'missileExplosionRadius', 'missileSpeed', 'blastSniperExplosionRadius', 'penetratingBulletLifetime'];
  const sources = [
    0, 3, 5, 7, 8, 10, 12, 13, 14, 15, 16, 17, 18, 19, 16, 21, 22, 23, 29,
    25, 26, 27, 29, 28, 30, 31, 32, 34, 33, 35, 36, 37, 39, 38,
    40, 41, 42, 44, 43, 45, 46, 47, 49, 48, 50, 51, 52, 54, 53,
    55, 56, 57, 59, 58, 60, 61, 62, 64, 63, 1, 2, 6, 4, 7, 12,
  ];
  const extrapolated = new Set([14, 18, 63, 64]);
  assert.equal(sources.length, getWeaponCatalog().length);
  let inherited = 0;
  for (const w of getWeaponCatalog()) { const source = legacy[sources[w.id]];
    assert.equal(w.sourceWeaponId, source.id, `${w.id}: original source remains explicit`);
    if (extrapolated.has(w.id)) continue;
    inherited++; assert.equal(w.type, source.type); assert.equal(w.grade, Math.floor(source.id / 5));
    for (const field of fields) assert.equal(w[field], source[field], `${w.id}/${w.category}/${w.grade}/${field}`); }
  assert.equal(inherited, 61);
  for (const [id, balance] of [
    [14, { ...legacy[16], damage: '700e0', attackInterval: Math.fround(.3) }],
    [18, { ...legacy[29], damage: '600e0', attackInterval: legacy[24].attackInterval, blastSniperExplosionRadius: 4.5 }],
  ]) for (const field of fields) assert.equal(getWeapon(id)[field], balance[field], `${id}: existing S balance ${field}`);
  assert.deepEqual(getWeaponCatalog().filter(w => w.category === 'crossbow').map(w => w.pelletCount), [2, 2, 3, 3, 3, 2, 2, 3]);
});

test('eight named crossbows retain their identities while the three additions use distinct same-grade balances', () => {
  assert.deepEqual(getWeaponCatalog().filter(w => w.category === 'crossbow').map(w => [w.id, w.name]), [
    [1,'D级弩弓'],[3,'C级山羊弩'],[6,'B级炎弩'],[10,'A级炎帝弩弓'],[14,'S级传说黄金飞龙弩'],
    [62,'D级特制鹰弩'],[63,'C级猎弩弓'],[64,'B级白银弩'],
  ]);
  for (const [existing, added, expectedDamage, expectedInterval, expectedSource] of [
    [1,62,'90e0',Math.fround(1.1),4], [3,63,'180e0',Math.fround(.8),7], [6,64,'300e0',Math.fround(1.2),12],
  ]) {
    const { id, name, damage, attackInterval, sourceWeaponId, ...balance } = getWeapon(existing);
    const { id: addedId, name: addedName, damage: addedDamage, attackInterval: addedInterval, sourceWeaponId: addedSource, ...addedBalance } = getWeapon(added);
    assert.equal(addedDamage, expectedDamage); assert.equal(addedInterval, expectedInterval); assert.equal(addedSource, expectedSource);
    assert.deepEqual(addedBalance, balance);
  }
});

test('appended bows restore their authored balances and all five repeated family-grade groups have distinct damage and cadence', () => {
  for (const [existing, added, expectedDamage, expectedInterval, expectedSource] of [
    [0,59,'80e0',.5,1], [0,60,'50e0',Math.fround(.3),2], [2,61,'100e0',Math.fround(.3),6],
  ]) {
    const { id, name, damage, attackInterval, sourceWeaponId, ...balance } = getWeapon(existing);
    const { id: addedId, name: addedName, damage: addedDamage, attackInterval: addedInterval, sourceWeaponId: addedSource, ...addedBalance } = getWeapon(added);
    assert.equal(addedDamage, expectedDamage); assert.equal(addedInterval, expectedInterval); assert.equal(addedSource, expectedSource);
    assert.deepEqual(addedBalance, balance, `${added}: projectile and other parameters remain unchanged`);
  }
  for (const ids of [[0,59,60],[2,61],[1,62],[3,63],[6,64]]) {
    const group = ids.map(getWeapon), label = ids.join('/');
    assert.ok(group.every(w => w.category === group[0].category && w.grade === group[0].grade), label);
    assert.equal(new Set(group.map(w => w.damage)).size, ids.length, `${label}: distinct hit damage`);
    assert.equal(new Set(group.map(w => w.attackInterval)).size, ids.length, `${label}: distinct attack cadence`);
  }
});

test('current catalog preserves copies, identities, pending claims and complete state without mutation', () => {
  const source = currentInventory(), before = clone(source), next = WeaponInventory.validate(source);
  assert.deepEqual(source, before); assert.deepEqual(next, source); assert.notEqual(next, source);
  assert.equal(next.catalogVersion, WEAPON_CATALOG_VERSION); assert.equal(next.collection.length, WEAPON_COUNT);
  assert.deepEqual(WeaponInventory.validate(next), next);
  source.collection[1] = false; assert.throws(() => WeaponInventory.validate(source), /missing from collection/);
});

test('unversioned, retired and future catalogs are rejected even when collection counts match', () => {
  for (const version of [undefined, 1, 2, 3, 5, 99]) {
    const source = currentInventory();
    if (version === undefined) delete source.catalogVersion; else source.catalogVersion = version;
    assert.throws(() => WeaponInventory.validate(source), /Unsupported weapon catalog version/);
  }
  for (const count of [59, 62, 64, 66]) {
    const source = currentInventory(); source.collection = new Array(count).fill(true);
    assert.throws(() => WeaponInventory.validate(source), /Invalid collection/);
  }
  const missingCount = currentInventory(); delete missingCount.dailyAdCount;
  assert.throws(() => WeaponInventory.validate(missingCount), /Invalid daily weapon count/);
});

test('every member of every variable-size next-grade merge pool is reachable', () => {
  for (let grade = 0; grade < 12; grade++) { const materials = getWeaponIdsForGrade(grade), results = getWeaponIdsForGrade(grade + 1);
    for (let pick = 0; pick < results.length; pick++) { const w = new WeaponInventory({ environment: 'test', rng: () => (pick + .5) / results.length });
      w.configureTest({ adGunEnabled: false }); w.grantTestWeapon(materials[0]); w.grantTestWeapon(materials[materials.length - 1]);
      assert.equal(w.merge(0, 1).weaponId, results[pick]); } }
});

test('current saves reload unchanged without migration backups or remapped IDs', () => {
  const key = economyStorageKey('production'), raw = currentSave(), store = memoryStore([[key, raw]]);
  const session = new BattleSession(options(store));
  assert.equal(session.persistenceBlocked, false);
  assert.deepEqual(session.weapons.serialize(), JSON.parse(raw).weapons);
  assert.deepEqual(JSON.parse(store.data.get(key)), JSON.parse(raw));
  assert.ok(store.writes.length > 0); assert.ok(store.writes.every(k => k === key));
  assert.deepEqual(new BattleSession(options(store)).weapons.serialize(), session.weapons.serialize());
});

test('unsupported and corrupt catalogs never overwrite the source save or create a migration backup', () => {
  const key = economyStorageKey('production');
  const raws = ['not json'];
  for (const version of [undefined, 1, 2, 3, 5, 99]) {
    const save = JSON.parse(currentSave());
    if (version === undefined) delete save.weapons.catalogVersion; else save.weapons.catalogVersion = version;
    raws.push(JSON.stringify(save));
  }
  for (const raw of raws) {
    const store = memoryStore([[key, raw]]), session = quiet(() => new BattleSession(options(store)));
    assert.equal(session.persistenceBlocked, true);
    session.weapons.grantDiamonds(1); session.save();
    assert.equal(store.data.get(key), raw); assert.deepEqual(store.writes, []); assert.equal(store.data.size, 1);
  }
});

test('D draws and C/B merges have five equal buckets including each new crossbow', () => {
  for (const grade of [0,1,2]) assert.equal(getWeaponIdsForGrade(grade).length,5);
  for (let i=0;i<5;i++) for (const offset of [.001,.999]) {
    const w = new WeaponInventory({ environment:'test',rng:()=>(i+offset)/5 });
    w.configureTest({adGunEnabled:false});
    assert.equal(w.draw().weaponId,getWeaponIdsForGrade(0)[i]);
    w.grantTestWeapon(59); w.grantTestWeapon(60);
    assert.equal(w.merge(1,2).weaponId,getWeaponIdsForGrade(1)[i]);
    const b = new WeaponInventory({ environment:'test',rng:()=>(i+offset)/5 });
    b.configureTest({adGunEnabled:false}); b.grantTestWeapon(3); b.grantTestWeapon(63);
    assert.equal(b.merge(0,1).weaponId,getWeaponIdsForGrade(2)[i]);
  }
});

test('discovering appended bows and crossbows does not reduce the auto-merge ceiling of an existing high-grade collection', () => {
  const w = new WeaponInventory({ environment:'test',rng:()=>0 });
  w.configureTest({adGunEnabled:false}); w.grantTestWeapon(58);
  const before = w.snapshot().auto;
  for (const id of [59,60,61,62,63,64]) { w.grantTestWeapon(id); assert.deepEqual(w.snapshot().auto,before); }
});
