const test = require('node:test');
const assert = require('node:assert/strict');
const legacy = require('./fixtures/legacy-weapon-data.json');
const { getWeapon, getWeaponCatalog, getWeaponIdsForGrade, WEAPON_CATEGORIES,
  WEAPON_CATEGORY_BY_TYPE, WEAPON_CATEGORY_NAMES, LEGACY_WEAPON_ID_MAP: migration, AD_WEAPON_ID } = require('./.build/session/core/WeaponCatalog.js');
const { WeaponInventory } = require('./.build/session/session/WeaponInventory.js');
const { BattleSession, economyStorageKey, weaponCatalogBackupStorageKey } = require('./.build/session/session/BattleSession.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');
const clone = value => JSON.parse(JSON.stringify(value));
function oldInventory() {
  const state = new WeaponInventory().serialize(); delete state.catalogVersion;
  state.collection = new Array(65).fill(true);
  state.equipment = [{ weaponId: 64, locked: true, pendingAd: false }, null, { weaponId: 28, locked: false, pendingAd: false }];
  state.backpack[0] = { weaponId: 1, locked: true, pendingAd: false };
  state.backpack[1] = { weaponId: 2, locked: false, pendingAd: false };
  state.backpack[2] = { weaponId: 14, locked: false, pendingAd: true };
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
function legacySave() {
  const store = memoryStore(); new BattleSession(options(store));
  const save = JSON.parse(store.data.get(economyStorageKey('production')));
  save.weapons = oldInventory(); save.money = { digits: '123456789', exponent: 0, precision: 9 }; save.levels = [5, 4, 3];
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

test('all 65 legacy IDs preserve grade and mechanism except the two approved S substitutions', () => {
  assert.equal(migration.length, 65); assert.equal(new Set(migration).size, 59);
  assert.deepEqual(migration, [
    0,0,0,1,1,2,2,3,4,4,5,5,6,7,8,9,10,11,12,13,14,15,16,17,18,
    19,20,21,23,22,24,25,26,28,27,29,30,31,33,32,34,35,36,38,37,
    39,40,41,43,42,44,45,46,48,47,49,50,51,53,52,54,55,56,58,57,
  ], 'balance provenance never changes saved weapon identity');
  for (const old of legacy) { const w = getWeapon(migration[old.id]); assert.equal(w.grade, Math.floor(old.id / 5));
    if (![20, 24].includes(old.id)) assert.equal(w.type, old.type);
    const state = oldInventory(); state.equipment[0] = { weaponId: old.id, locked: true, pendingAd: false };
    assert.equal(WeaponInventory.validate(state).equipment[0].weaponId, w.id); }
  assert.equal(getWeapon(migration[14]).category, 'staff'); assert.equal(migration[14], AD_WEAPON_ID);
  assert.equal(getWeapon(migration[20]).category, 'crossbow'); assert.equal(getWeapon(migration[24]).category, 'handgun');
});

test('migration preserves copies, locks, pending claims and stars, ORs discoveries and is idempotent', () => {
  const source = oldInventory(), before = clone(source), next = WeaponInventory.validate(source);
  assert.deepEqual(source, before); assert.equal(next.catalogVersion, 4); assert.equal(next.collection.length, 65);
  assert.ok(next.collection.slice(0,59).every(Boolean)); assert.deepEqual(next.collection.slice(59), new Array(6).fill(false));
  assert.deepEqual(next.backpack.slice(0, 3), [{ weaponId: 0, locked: true, pendingAd: false }, { weaponId: 0, locked: false, pendingAd: false }, { weaponId: 8, locked: false, pendingAd: true }]);
  assert.deepEqual(next.equipment, [{ weaponId: 57, locked: true, pendingAd: false }, null, { weaponId: 23, locked: false, pendingAd: false }]);
  for (const key of Object.keys(source).filter(k => !['backpack', 'equipment', 'collection'].includes(k))) assert.deepEqual(next[key], source[key], key);
  assert.deepEqual(WeaponInventory.validate(next), next);
  source.collection[1] = false; assert.throws(() => WeaponInventory.validate(source), /missing from collection/);
  const invalid = oldInventory(); invalid.catalogVersion = 2; assert.throws(() => WeaponInventory.validate(invalid));
  const future = clone(next); future.catalogVersion = 5; assert.throws(() => WeaponInventory.validate(future), /version/);
});

test('every member of every variable-size next-grade merge pool is reachable', () => {
  for (let grade = 0; grade < 12; grade++) { const materials = getWeaponIdsForGrade(grade), results = getWeaponIdsForGrade(grade + 1);
    for (let pick = 0; pick < results.length; pick++) { const w = new WeaponInventory({ environment: 'test', rng: () => (pick + .5) / results.length });
      w.configureTest({ adGunEnabled: false }); w.grantTestWeapon(materials[0]); w.grantTestWeapon(materials[materials.length - 1]);
      assert.equal(w.merge(0, 1).weaponId, results[pick]); } }
});

test('legacy loading backs up exact full save before migration and preserves balance and progress on reload', () => {
  const key = economyStorageKey('production'), backup = weaponCatalogBackupStorageKey('production'), raw = legacySave();
  const store = memoryStore([[key, raw]]), session = new BattleSession(options(store));
  assert.equal(store.data.get(backup), raw); assert.equal(store.writes[0], backup);
  const migrated = JSON.parse(store.data.get(key)); assert.equal(migrated.weapons.catalogVersion, 4);
  assert.deepEqual(migrated.money, JSON.parse(raw).money); assert.deepEqual(migrated.levels, [5, 4, 3]); assert.deepEqual(migrated.progress, JSON.parse(raw).progress);
  assert.equal(session.weapons.diamonds, 12345); assert.equal(session.weapons.starGems, 678);
  assert.deepEqual(migrated.weapons, WeaponInventory.validate(JSON.parse(raw).weapons));
  const reloaded = new BattleSession(options(store)); assert.deepEqual(reloaded.weapons.serialize(), session.weapons.serialize());
  assert.equal(store.data.get(backup), raw); assert.equal(store.writes.filter(k => k === backup).length, 1);
});

test('backup write failure, silent loss or collision never overwrite the active legacy save', () => {
  const key = economyStorageKey('production'), backup = weaponCatalogBackupStorageKey('production'), raw = legacySave();
  for (const failure of ['throw', 'silent', 'collision']) { const store = memoryStore([[key, raw]]), write = store.setItem;
    if (failure === 'collision') store.data.set(backup, 'another preserved save');
    store.setItem = (k, value) => { if (k === backup && failure === 'throw') throw Error('quota'); if (k === backup && failure === 'silent') return; write(k, value); };
    const session = quiet(() => new BattleSession(options(store))); assert.equal(session.weapons.diamonds, 12345); assert.equal(session.weapons.serialize().catalogVersion, 4);
    session.weapons.grantDiamonds(1); session.save(); assert.equal(store.data.get(key), raw); }
});

test('corrupt and future catalogs cannot be replaced by constructor autosave', () => {
  const key = economyStorageKey('production');
  for (const raw of ['not json', JSON.stringify({ ...JSON.parse(legacySave()), weapons: { ...oldInventory(), catalogVersion: 99 } })]) {
    const store = memoryStore([[key, raw]]), session = quiet(() => new BattleSession(options(store)));
    session.save(); assert.equal(store.data.get(key), raw); assert.deepEqual(store.writes, []); }
});

function previousSave(version = 2) {
  const save = JSON.parse(legacySave()), weapons = WeaponInventory.validate(save.weapons);
  weapons.catalogVersion = version; weapons.collection = new Array(version === 2 ? 59 : 62).fill(true);
  weapons.equipment[0] = { weaponId: 9, locked: true, pendingAd: false };
  if (version === 3) {
    weapons.equipment[2] = { weaponId: 61, locked: true, pendingAd: false };
    weapons.backpack[0] = { weaponId: 59, locked: true, pendingAd: false };
    weapons.backpack[1] = { weaponId: 60, locked: false, pendingAd: false };
  }
  save.weapons = weapons; return JSON.stringify(save);
}

test('v2 preserves every existing ID and A bow, adds only six locked discoveries, and reloads idempotently', () => {
  const raw = previousSave(), source = JSON.parse(raw).weapons, original = clone(source);
  for (let id = 0; id < 59; id++) {
    const state = clone(source); state.equipment[0].weaponId = id;
    assert.equal(WeaponInventory.validate(state).equipment[0].weaponId, id);
  }
  const next = WeaponInventory.validate(source);
  assert.deepEqual(source, original); assert.equal(next.catalogVersion, 4);
  assert.deepEqual(next.collection, [...source.collection, ...new Array(6).fill(false)]);
  for (const key of Object.keys(source).filter(k => !['catalogVersion','collection'].includes(k))) assert.deepEqual(next[key], source[key], key);
  assert.deepEqual(WeaponInventory.validate(next), next);
  assert.equal(getWeapon(next.equipment[0].weaponId).grade, 3);
  assert.equal(getWeapon(next.equipment[0].weaponId).name, 'A级迅速之翼');
  const key = economyStorageKey('production'), backup = weaponCatalogBackupStorageKey('production', 2);
  const oldBackup = weaponCatalogBackupStorageKey('production', 1), store = memoryStore([[key,raw],[oldBackup,'older v1 backup']]);
  const session = new BattleSession(options(store));
  assert.equal(store.data.get(backup), raw); assert.equal(store.writes[0], backup);
  assert.equal(store.data.get(oldBackup), 'older v1 backup');
  assert.deepEqual(new BattleSession(options(store)).weapons.serialize(), session.weapons.serialize());
  assert.equal(store.writes.filter(k => k === backup).length, 1);
});

test('v2 failed or colliding backups and corrupt collections cannot overwrite the original save', () => {
  const key = economyStorageKey('production'), backup = weaponCatalogBackupStorageKey('production',2);
  for (const failure of ['throw','silent','collision','invalidCollection','invalidId']) {
    let raw = previousSave();
    if (failure === 'invalidCollection' || failure === 'invalidId') {
      const data = JSON.parse(raw);
      if (failure === 'invalidCollection') data.weapons.collection.pop();
      else data.weapons.equipment[0].weaponId = 59;
      raw = JSON.stringify(data);
    }
    const store = memoryStore([[key,raw]]), write = store.setItem;
    if (failure === 'collision') store.data.set(backup,'preserved other v2 save');
    store.setItem = (k,v) => { if (k === backup && failure === 'throw') throw Error('quota'); if (k === backup && failure === 'silent') return; write(k,v); };
    const session = quiet(() => new BattleSession(options(store))); session.weapons.grantDiamonds(1); session.save();
    assert.equal(store.data.get(key),raw,failure);
    if (failure.startsWith('invalid')) assert.deepEqual(store.writes,[]);
  }
});

test('v3 retains all 62 IDs and complete state, appends three locked discoveries, and safely reloads as v4', () => {
  const raw = previousSave(3), source = JSON.parse(raw).weapons, original = clone(source);
  for (let id = 0; id < 62; id++) {
    const state = clone(source); state.equipment[0].weaponId = id;
    assert.equal(WeaponInventory.validate(state).equipment[0].weaponId, id);
  }
  const next = WeaponInventory.validate(source);
  assert.deepEqual(source, original); assert.equal(next.catalogVersion, 4);
  assert.deepEqual(next.collection, [...source.collection, false, false, false]);
  for (const key of Object.keys(source).filter(k => !['catalogVersion','collection'].includes(k))) assert.deepEqual(next[key], source[key], key);
  assert.deepEqual(WeaponInventory.validate(next), next);
  const key = economyStorageKey('production'), backup = weaponCatalogBackupStorageKey('production',3);
  const v1 = weaponCatalogBackupStorageKey('production',1), v2 = weaponCatalogBackupStorageKey('production',2);
  const store = memoryStore([[key,raw],[v1,'preserved v1 save'],[v2,'preserved v2 save']]);
  const session = new BattleSession(options(store)), saved = JSON.parse(store.data.get(key));
  assert.equal(store.data.get(backup),raw); assert.equal(store.writes[0],backup);
  assert.equal(store.data.get(v1),'preserved v1 save'); assert.equal(store.data.get(v2),'preserved v2 save');
  assert.deepEqual(saved.weapons,next);
  for (const field of ['money','levels','progress']) assert.deepEqual(saved[field],JSON.parse(raw)[field]);
  assert.deepEqual(new BattleSession(options(store)).weapons.serialize(),session.weapons.serialize());
  assert.equal(store.writes.filter(k=>k===backup).length,1);
});

test('v3 failed or colliding backups and invalid inventories never overwrite their source save', () => {
  const key = economyStorageKey('production'), backup = weaponCatalogBackupStorageKey('production',3);
  for (const failure of ['throw','silent','collision','invalidCollection','invalidId','invalidDiscovery']) {
    let raw = previousSave(3);
    if (failure.startsWith('invalid')) {
      const data = JSON.parse(raw);
      if (failure === 'invalidCollection') data.weapons.collection.push(false);
      if (failure === 'invalidId') data.weapons.equipment[0].weaponId = 62;
      if (failure === 'invalidDiscovery') data.weapons.collection[61] = false;
      raw = JSON.stringify(data);
    }
    const store = memoryStore([[key,raw]]), write = store.setItem;
    if (failure === 'collision') store.data.set(backup,'preserved other v3 save');
    store.setItem = (k,v) => { if (k === backup && failure === 'throw') throw Error('quota'); if (k === backup && failure === 'silent') return; write(k,v); };
    const session = quiet(() => new BattleSession(options(store))); session.weapons.grantDiamonds(1); session.save();
    assert.equal(store.data.get(key),raw,failure);
    if (failure.startsWith('invalid')) assert.deepEqual(store.writes,[]);
  }
});

test('unversioned legacy and v4 saves with equal 65-entry counts use different identity semantics', () => {
  const legacyState = oldInventory();
  assert.equal(WeaponInventory.validate(legacyState).equipment[0].weaponId,57);
  const current = WeaponInventory.validate(legacyState);
  for (const id of [59,60,61,62,63,64]) {
    current.equipment[0].weaponId = id; current.collection[id] = true;
    const restored = WeaponInventory.validate(current);
    assert.equal(restored.equipment[0].weaponId,id); assert.deepEqual(restored,current);
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
