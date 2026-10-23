const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { WeaponInventory, getWeaponStarDamage, getStarMultiplier, getStarBonusPercent, getStarSuccessPercent, AD_WEAPON_DURATION_MS } = require('./.build/session/session/WeaponInventory.js');
const { getWeapon, getWeaponGrade, getWeaponCatalog, WEAPON_GRADES } = require('./.build/session/core/WeaponCatalog.js');
const { ContentUnlockManager } = require('./.build/session/session/ContentUnlockManager.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const stats = { shots: 0, hits: 0, kills: 0, totalTrees: 30, elapsed: 0, complete: false };
function storage() { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; }
function inventory(options = {}) {
  const environment = options.environment ?? 'test';
  const content = new ContentUnlockManager(resolveContentConfig(environment, { adsEnabled: true }), () => ({ weaponsUnlocked: true }));
  return new WeaponInventory({ environment, content, now: () => new Date(2026, 9, 10, 12).getTime(), rng: () => 0, ...options });
}
// These legacy economy cases isolate weapon rules from the separate tutorial tests.
function unlockedSession(options = {}) {
  const environment = options.environment ?? 'production';
  return new BattleSession({ ...options, contentConfig: resolveContentConfig(environment, { tutorialEnabled: false, adsEnabled: true, firstDrawDiamonds: 0, thresholds: { challengePowerLevel: 0 } }) });
}
function activeItems(w) { return w.snapshot().backpack.filter(Boolean); }
function beginSuccess(w, kind) { const start = w.beginAd(kind); assert.equal(start.ok, true, start.reason); return w.completeAd(start.token, 'success'); }

test('Weapon execution follows shared tutorial progress without changing inventory history', () => {
  let powerLevel = 2;
  const content = new ContentUnlockManager(resolveContentConfig('production'), () => ({ powerLevel }));
  const state = inventory().serialize();
  const w = new WeaponInventory({ content, initialState: state, rng: () => 0 });
  const revision = w.revision;
  assert.equal(w.snapshot().unlocked, false);
  for (const command of [() => w.draw(), () => w.equip(0, 1), () => w.merge(0, 1),
    () => w.toggleLock({ kind: 'equipment', index: 0 }), () => w.upgradeStar(0),
    () => w.moveBackpack(0, 1), () => w.swapBackpack(0, 1), () => w.swapEquipment(0, 1), () => w.unequip(0)]) {
    assert.equal(command().reason, 'weaponsLocked');
  }
  assert.equal(w.revision, revision); assert.equal(w.snapshot().stageValueMax, 0);
  powerLevel = 3;
  assert.equal(w.snapshot().unlocked, true);
  assert.equal(w.revision, revision, 'shared content progress does not fabricate inventory mutations');
  assert.equal(w.draw().ok, true);
});

test('Disabled advertising blocks all weapon ads without consuming the first merge offer', () => {
  const content = new ContentUnlockManager(resolveContentConfig('test', { adsEnabled: false }));
  const w = new WeaponInventory({ environment: 'test', content, rng: () => 0 });
  w.grantTestWeapon(0); w.grantTestWeapon(0); w.merge(0, 1);
  assert.equal(w.snapshot().dailyAdUnlocked, false);
  assert.equal(w.beginAd('daily').reason, 'adsDisabled');
  assert.equal(w.beginAd('weapon').reason, 'adsDisabled');
  assert.equal(w.serialize().adGunOffered, false);
  assert.equal(w.snapshot().backpack.some(item => item?.pendingAd), false);
  assert.equal(w.snapshot().auto.unlocked, true);
  assert.equal(w.setAutoMerge(true).ok, true, 'Auto does not depend on advertising');
});

test('Disabled ads remove only saved unclaimed placeholders and reject an in-flight reward', () => {
  const source = inventory(); source.grantTestWeapon(8);
  const state = source.serialize();
  state.backpack[1] = { weaponId: 8, locked: false, pendingAd: true };
  state.adGunExpiresAt = source.now + AD_WEAPON_DURATION_MS; state.adGunOffered = true;
  const restored = new WeaponInventory({ environment: 'test', initialState: state,
    content: new ContentUnlockManager(resolveContentConfig('test', { adsEnabled: false })) });
  assert.deepEqual(restored.serialize().backpack[0], state.backpack[0]);
  assert.equal(restored.serialize().backpack[1], null);
  assert.equal(restored.serialize().adGunOffered, true);
  assert.equal(restored.snapshot().collection[8], true);
  assert.equal(restored.snapshot().adGunExpiresAt, 0);
  const content = new ContentUnlockManager(resolveContentConfig('test', { adsEnabled: true }));
  const active = inventory({ content }), token = active.beginAd('daily').token;
  content.isAdEnabled = () => false;
  assert.equal(active.completeAd(token, 'success').reason, 'adsDisabled');
  assert.equal(active.snapshot().backpack.filter(Boolean).length, 0);
  assert.equal(active.serialize().dailyAdDate, '');
  assert.equal(active.completeAd(token, 'success').reason, 'staleAd');
});

test('Test refill reads configured targets, preserves larger balances and never grants weapons', () => {
  const content = new ContentUnlockManager(resolveContentConfig('test', { testResources: { diamonds: 2345678, starGems: 1234 } }));
  const w = new WeaponInventory({ environment: 'test', content });
  assert.equal(w.diamonds, 2345678); assert.equal(w.starGems, 1234);
  w.configureTest({ diamonds: 5, starGems: 2345 }); w.refillTestResources();
  assert.equal(w.diamonds, 2345678); assert.equal(w.starGems, 2345);
  assert.equal(w.snapshot().backpack.filter(Boolean).length, 0);
  assert.equal(new WeaponInventory().refillTestResources().reason, 'testOnly');
});

test('Seven-family catalog has 65 immutable definitions with explicit grade boundaries', () => {
  assert.equal(getWeaponCatalog().length, 65);
  for (let id = 0; id < 65; id++) {
    const weapon = getWeapon(id);
    assert.equal(weapon.id, id); assert.equal(getWeaponGrade(id), weapon.grade);
    assert.ok(D.from(weapon.damage).compare(0) > 0);
    assert.ok(weapon.attackInterval > 0);
  }
  assert.equal(getWeapon(0).type, 'SINGLE'); assert.equal(D.from(getWeapon(0).damage).toNumber(), 100);
  assert.equal(getWeapon(8).type, 'EXPLOSIVE');
  assert.equal(Object.isFrozen(getWeapon(8)), true); assert.equal(Object.isFrozen(getWeaponCatalog()), true);
  assert.deepEqual(WEAPON_GRADES, ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS', 'X', 'XX', 'XXX', 'Z', 'ZZ', 'ZZZ']);
  assert.throws(() => getWeapon(65)); assert.throws(() => getWeapon(-1));
});

test('Initial loadout is one gun with 16 backpack spaces; test currency funding and production are isolated', () => {
  const store = storage(); const testing = unlockedSession({ environment: 'test', storage: store });
  const state = testing.weapons.snapshot();
  assert.equal(testing.weapons.isTestEnvironment, true);
  assert.equal(state.backpack.length, 16); assert.equal(state.equipment.length, 3);
  assert.deepEqual(state.equipment.map(item => item?.weaponId ?? -1), [0, -1, -1]);
  assert.equal(state.collection.filter(Boolean).length, 1); assert.equal(state.diamonds, 2000000);
  assert.equal(state.starGems, 1000000); assert.equal(testing.weapons.draw().ok, true);
  assert.equal(testing.weapons.diamonds, 1999900);
  const production = unlockedSession({ storage: store });
  assert.equal(production.weapons.isTestEnvironment, false);
  assert.equal(production.weapons.starGems, 0);
  assert.equal(production.weapons.diamonds, 0); assert.equal(production.weapons.draw().reason, 'notEnoughDiamonds');
  assert.equal(production.weapons.grantTestWeapon(57).reason, 'testOnly');
  assert.equal(production.weapons.configureTest({ stageValueMax: 390 }).reason, 'testOnly');
  assert.equal(production.weapons.grantTestStarGems(100).reason, 'testOnly');
  assert.equal(production.weapons.advanceTestTime(100).reason, 'testOnly');
  assert.equal(unlockedSession({ environment: 'test', storage: store }).weapons.diamonds, 2000000);
});

test('v3 ignores old v1/v2 keys and restores its own weapon state in a separate key', () => {
  const store = storage(), old = JSON.stringify({ version: 1, money: D.from('1e2300').add('12.3'), levels: [2, 3, 4] });
  store.setItem('forest-gunner:economy:v1:production', old);
  store.setItem('forest-gunner:economy:v2:production', old);
  const session = unlockedSession({ storage: store });
  assert.equal(session.snapshot(stats, false).money.toString(), '0');
  assert.deepEqual(session.snapshot(stats, false).upgrades.map(upgrade => upgrade.level), [0, 0, 0]);
  assert.equal(store.getItem('forest-gunner:economy:v1:production'), old);
  assert.equal(store.getItem('forest-gunner:economy:v2:production'), old);
  assert.equal(JSON.parse(store.getItem(economyStorageKey('production'))).version, 3);
  session.weapons.recordStageValue(390);
  const reloaded = unlockedSession({ storage: store });
  assert.equal(reloaded.weapons.snapshot().lockUnlocked, true);
  assert.equal(reloaded.snapshot(stats, false).money.compare(session.snapshot(stats, false).money), 0);
  const testSession = unlockedSession({ environment: 'test', storage: store, now: () => 1000, rng: () => 0 });
  testSession.weapons.grantTestWeapon(18); testSession.weapons.equip(0, 2);
  testSession.weapons.configureTest({ stageValueMax: 390, starLevels: [1, 2, 3], starGems: 7654 });
  testSession.weapons.toggleLock({ kind: 'equipment', index: 2 });
  const testReloaded = unlockedSession({ environment: 'test', storage: store, now: () => 1000 });
  assert.equal(testReloaded.weapons.snapshot().equipment[2].locked, true);
  assert.deepEqual(testReloaded.weapons.snapshot().stars.map(slot => slot.level), [1, 2, 3]);
  assert.equal(testReloaded.weapons.starGems, 1000000);
  testReloaded.weapons.configureTest({ starGems: 1234567 });
  assert.equal(unlockedSession({ environment: 'test', storage: store }).weapons.starGems, 1234567);
});

test('Test protection locks work from a fresh save without changing progression or production unlocks', () => {
  const store = storage(), testing = unlockedSession({ environment: 'test', storage: store });
  const w = testing.weapons;
  assert.equal(w.snapshot().stageValueMax, 0);
  assert.equal(w.snapshot().lockUnlocked, true);
  assert.equal(w.snapshot().starUnlocked, true);
  assert.equal(w.snapshot().dailyAdUnlocked, true);
  assert.equal(w.toggleLock({ kind: 'equipment', index: 0 }).ok, true);
  assert.equal(w.snapshot().equipment[0].locked, true);
  w.grantTestWeapon(27);
  assert.equal(w.toggleLock({ kind: 'backpack', index: 0 }).ok, true);
  const saved = unlockedSession({ environment: 'test', storage: store }).weapons;
  assert.equal(saved.snapshot().stageValueMax, 0, 'test access never advances the saved stage');
  assert.equal(saved.snapshot().equipment[0].locked, true);
  assert.equal(saved.snapshot().backpack[0].locked, true);
  assert.equal(saved.toggleLock({ kind: 'backpack', index: 0 }).ok, true);
  assert.equal(saved.snapshot().backpack[0].locked, false);

  const production = unlockedSession({ environment: 'production', storage: store }).weapons;
  assert.equal(production.snapshot().lockUnlocked, false);
  assert.equal(production.toggleLock({ kind: 'equipment', index: 0 }).reason, 'locked');
  production.recordStageValue(389);
  assert.equal(production.snapshot().lockUnlocked, false);
  assert.equal(production.toggleLock({ kind: 'equipment', index: 0 }).reason, 'locked');
  production.recordStageValue(390);
  assert.equal(production.snapshot().lockUnlocked, true);
  assert.equal(production.toggleLock({ kind: 'equipment', index: 0 }).ok, true);
  assert.equal(production.snapshot().equipment[0].locked, true);
});

test('Test stars unlock at zero progress, retain costs and persist without unlocking production', () => {
  const store = storage(), w = unlockedSession({ environment: 'test', storage: store, rng: () => 0 }).weapons;
  assert.equal(w.snapshot().starUnlocked, true);
  assert.equal(w.starGems, 1000000);
  assert.equal(w.upgradeStar(0).status, 'success');
  assert.equal(w.starGems, 999950);
  const restored = unlockedSession({ environment: 'test', storage: store }).weapons.snapshot();
  assert.equal(restored.starUnlocked, true);
  assert.equal(restored.stageValueMax, 0);
  assert.equal(restored.stars[0].level, 1);
  assert.equal(restored.starGems, 1000000);
  const production = unlockedSession({ environment: 'production', storage: store }).weapons;
  for (const progress of [0, 389]) {
    production.recordStageValue(progress);
    assert.equal(production.snapshot().starUnlocked, false);
    assert.equal(production.upgradeStar(0).status, 'locked');
    assert.equal(production.snapshot().stars[0].level, 0);
  }
  production.recordStageValue(390);
  assert.equal(production.snapshot().starUnlocked, true);
  assert.equal(production.upgradeStar(0).status, 'notEnoughGem');
});

test('Draws are D only with five equal intervals; full/insufficient draws spend and sample nothing', () => {
  let rolls = 0, next = 0;
  const w = inventory({ rng: () => { rolls++; return next; } });
  for (let index = 0; index < 5; index++) { next = (index + 0.5) / 5; assert.equal(w.draw().weaponId, [0,1,59,60,62][index]); }
  assert.equal(w.diamonds, 1999500); assert.equal(rolls, 5);
  while (activeItems(w).length < 16) w.grantTestWeapon(0);
  assert.equal(w.draw().reason, 'backpackFull'); assert.equal(w.diamonds, 1999500); assert.equal(rolls, 5);
  const poor = inventory({ rng: () => { throw Error('must not sample'); } });
  poor.configureTest({ diamonds: 99 }); assert.equal(poor.draw().reason, 'notEnoughDiamonds'); assert.equal(poor.diamonds, 99);
});

test('Only first discovery queues the new-gun popup; snapshots and saves cannot mutate live state', () => {
  const w = inventory();
  assert.equal(w.grantTestWeapon(2).isNew, true); assert.equal(w.grantTestWeapon(2).isNew, false);
  assert.deepEqual(w.drainNotifications().map(notice => notice.weaponId), [2]); assert.deepEqual(w.drainNotifications(), []);
  const snapshot = w.snapshot(), saved = w.serialize();
  snapshot.backpack[0].weaponId = 57; snapshot.equipment[0].locked = true; snapshot.collection[57] = true;
  saved.backpack[1] = null; saved.starLevels[0] = 20;
  assert.equal(w.snapshot().backpack[0].weaponId, 2); assert.equal(w.snapshot().backpack[1].weaponId, 2);
  assert.equal(w.snapshot().equipment[0].locked, false); assert.equal(w.snapshot().collection[57], false);
  assert.equal(w.snapshot().stars[0].level, 0);
});

test('Same-grade different models merge uniformly to next grade; locked/max/pending items never merge', () => {
  const w = inventory({ rng: () => 0.999999 }); w.configureTest({ adGunEnabled: false });
  w.grantTestWeapon(0); w.grantTestWeapon(1);
  const merged = w.merge(0, 1); assert.equal(merged.ok, true); assert.equal(merged.weaponId, 63);
  assert.equal(w.snapshot().backpack[0], null); assert.equal(w.snapshot().backpack[1].weaponId, 63);
  w.grantTestWeapon(4);
  assert.equal(w.toggleLock({ kind: 'backpack', index: 0 }).ok, true);
  assert.equal(w.merge(0, 1).reason, 'protected');
  w.toggleLock({ kind: 'backpack', index: 0 }); assert.equal(w.merge(0, 1).weaponId, 64);
  w.grantTestWeapon(54); w.grantTestWeapon(57);
  assert.equal(w.merge(0, 2).reason, 'maxGrade'); assert.equal(w.merge(0, 1).reason, 'differentGrade');
  assert.equal(w.merge(0, 0).reason, 'invalidSlot');
});

test('teaching draws twice, merges the 240-attack C crossbow without RNG and emits completed actions atomically', () => {
  let tutorial = { active: true, step: 'gunBuy', drawCount: 0 }, rolls = 0;
  const actions = [], samples = [0.1, 0.3, 0.999999];
  const w = inventory({ getTutorialState: () => tutorial, rng: () => samples[rolls++],
    onMutation: (forceBalanceReload, action) => {
      if (!action) return;
      actions.push({ ...action, forceBalanceReload, diamonds: w.diamonds, state: w.serialize() });
      if (!tutorial.active) return;
      if (action.type === 'draw') {
        tutorial = { ...tutorial, drawCount: tutorial.drawCount + 1 };
        if (tutorial.drawCount === 2) tutorial.step = 'gunMerge';
      } else if (action.type === 'merge') tutorial.step = 'gunEquip';
      else tutorial = { ...tutorial, active: false, step: 'done' };
    } });
  w.configureTest({ diamonds: 200 });
  assert.equal(w.draw().weaponId, 0); assert.equal(w.diamonds, 100);
  assert.deepEqual(tutorial, { active: true, step: 'gunBuy', drawCount: 1 });
  assert.equal(w.equip(0, 1).reason, 'tutorialStep');
  assert.equal(w.merge(0, 1).reason, 'tutorialStep');
  assert.equal(w.draw().weaponId, 1); assert.equal(w.diamonds, 0);
  assert.equal(tutorial.step, 'gunMerge');
  assert.equal(w.draw().reason, 'tutorialStep');
  assert.equal(w.moveBackpack(1, 5).ok, true, 'moving a material preserves teaching');
  assert.equal(w.merge(0, 5).weaponId, 3);
  assert.equal(rolls, 2, 'the guaranteed tutorial result does not sample RNG');
  assert.equal(tutorial.step, 'gunEquip');
  assert.equal(w.snapshot().firstMerge, true);
  assert.equal(w.snapshot().backpack[0], null);
  assert.equal(w.snapshot().backpack[5].weaponId, 3);
  assert.equal(w.snapshot().backpack.some(item => item?.pendingAd), false, 'teaching does not introduce an ad placeholder');
  assert.equal(w.snapshot().collection[3], true);
  assert.equal(getWeapon(3).category, 'crossbow'); assert.equal(getWeaponGrade(3), 1);
  assert.equal(getWeaponStarDamage(3, 0).toNumber(), 240);
  assert.equal(w.merge(0, 5).reason, 'tutorialStep');
  assert.equal(w.equip(5, 2).weaponId, 3); assert.equal(tutorial.step, 'done');
  assert.equal(w.snapshot().equipment[2].weaponId, 3);
  assert.deepEqual(actions.map(({ type, weaponId, forceBalanceReload, diamonds }) => ({ type, weaponId, forceBalanceReload, diamonds })), [
    { type: 'draw', weaponId: 0, forceBalanceReload: false, diamonds: 100 },
    { type: 'draw', weaponId: 1, forceBalanceReload: false, diamonds: 0 },
    { type: 'merge', weaponId: 3, forceBalanceReload: false, diamonds: 0 },
    { type: 'equip', weaponId: 3, forceBalanceReload: true, diamonds: 0 },
  ]);
  assert.equal(actions[2].state.backpack[5].weaponId, 3, 'the event observes the committed inventory');
  assert.equal(actions[3].state.equipment[2].weaponId, 3);
  w.grantTestWeapon(0); w.grantTestWeapon(1);
  assert.equal(w.merge(0, 1).weaponId, 63, 'normal random merging resumes after teaching');
  assert.equal(rolls, 3);
});

test('teaching guards other inventory commands without spending, drawing randomness or emitting success events', () => {
  let tutorial = { active: false, step: 'done', drawCount: 0 }, rolls = 0, mutations = 0;
  const actions = [];
  const w = inventory({ getTutorialState: () => tutorial, rng: () => { rolls++; return 0; },
    onMutation: (_, action) => { mutations++; if (action) actions.push(action); } });
  for (const id of [0, 1, 2, 4]) w.grantTestWeapon(id);
  w.configureTest({ autoEnabled: true });
  tutorial = { active: true, step: 'gunOpen', drawCount: 0 };
  const before = w.serialize(), mutationCount = mutations;
  const commands = [() => w.draw(), () => w.merge(0, 1), () => w.equip(0, 1), () => w.unequip(0),
    () => w.swapEquipment(0, 1), () => w.toggleLock({ kind: 'backpack', index: 0 }),
    () => w.upgradeStar(0), () => w.setAutoMerge(true), () => w.autoMergeStep(),
    () => w.autoMergePair(0, 1, 0, 1), () => w.beginAd('daily'), () => w.beginAd('weapon')];
  for (const command of commands) assert.equal(command().reason, 'tutorialStep');
  assert.equal(w.findAutoMergePair(), null);
  assert.deepEqual(w.serialize(), before); assert.equal(mutations, mutationCount); assert.equal(rolls, 0);
  assert.deepEqual(actions, []);
  assert.equal(w.swapBackpack(0, 1).ok, true, 'lossless backpack reordering remains available');
  tutorial = { active: true, step: 'gunBuy', drawCount: 2 };
  assert.equal(w.draw().reason, 'tutorialStep', 'a delayed tutorial refresh cannot permit a third draw');
  tutorial = { active: true, step: 'gunMerge', drawCount: 2 };
  const beforeInvalidMerge = w.serialize(), beforeInvalidMutation = mutations;
  assert.equal(w.merge(2, 3).reason, 'tutorialStep', 'teaching cannot turn C materials into the guaranteed C reward');
  assert.deepEqual(w.serialize(), beforeInvalidMerge); assert.equal(mutations, beforeInvalidMutation);
  tutorial = { active: true, step: 'gunEquip', drawCount: 2 };
  assert.equal(w.equip(0, 1).reason, 'tutorialStep', 'equipping a D weapon cannot finish teaching');
  assert.equal(w.equip(2, 1).reason, 'tutorialStep', 'a different C weapon cannot replace the tutorial crossbow');
  assert.equal(rolls, 0); assert.deepEqual(actions, []);
});

test('failed tutorial draws and protected merges leave the wallet, materials and event history intact', () => {
  let tutorial = { active: true, step: 'gunBuy', drawCount: 0 }, mutations = 0;
  const seed = inventory(); seed.configureTest({ diamonds: 99 });
  const state = seed.serialize();
  const content = new ContentUnlockManager(resolveContentConfig('production'), () => ({ weaponsUnlocked: true }));
  const options = { environment: 'production', content, getTutorialState: () => tutorial,
    rng: () => { throw Error('failed teaching action must not sample RNG'); }, onMutation: () => mutations++ };
  const poor = new WeaponInventory({ ...options, initialState: state });
  assert.equal(poor.draw().reason, 'notEnoughDiamonds'); assert.deepEqual(poor.serialize(), state); assert.equal(mutations, 0);
  state.diamonds = 200; state.backpack.fill({ weaponId: 0, locked: false, pendingAd: false });
  const full = new WeaponInventory({ ...options, initialState: state });
  assert.equal(full.draw().reason, 'backpackFull'); assert.deepEqual(full.serialize(), state); assert.equal(mutations, 0);
  tutorial = { active: true, step: 'gunMerge', drawCount: 2 };
  state.backpack[0] = { weaponId: 0, locked: true, pendingAd: false };
  const protectedInventory = new WeaponInventory({ ...options, initialState: state });
  assert.equal(protectedInventory.merge(0, 1).reason, 'protected');
  assert.deepEqual(protectedInventory.serialize(), state); assert.equal(mutations, 0);
});

test('an advertisement started before teaching cannot inject a weapon or keep the busy token alive', () => {
  let tutorial = { active: false, step: 'done', drawCount: 0 };
  const actions = [], w = inventory({ getTutorialState: () => tutorial,
    onMutation: (_, action) => { if (action) actions.push(action); } });
  const pending = w.beginAd('daily'); assert.equal(pending.ok, true);
  const before = w.serialize();
  tutorial = { active: true, step: 'gunBuy', drawCount: 0 };
  assert.equal(w.completeAd(pending.token, 'success').reason, 'tutorialStep');
  assert.equal(w.snapshot().pendingAd, null); assert.deepEqual(w.serialize(), before);
  assert.equal(w.completeAd(pending.token, 'success').reason, 'staleAd');
  assert.deepEqual(actions, []);
});

test('Equipment preserves lock flags/holes and rejects removing the last gun or unloading to a full backpack', () => {
  const w = inventory(); w.configureTest({ stageValueMax: 390 });
  assert.equal(w.unequip(0).reason, 'lastWeapon');
  w.grantTestWeapon(6); w.toggleLock({ kind: 'backpack', index: 0 });
  assert.equal(w.equip(0, 2).ok, true); assert.equal(w.snapshot().equipment[2].locked, true);
  assert.deepEqual(w.snapshot().equipment.map(item => item?.weaponId ?? -1), [0, -1, 6]);
  assert.equal(w.unequip(0).ok, true);
  assert.deepEqual(w.snapshot().equipment.map(item => item?.weaponId ?? -1), [-1, -1, 6]);
  assert.equal(w.unequip(2).reason, 'lastWeapon');
  assert.equal(w.swapEquipment(2, 0).ok, true); assert.equal(w.snapshot().equipment[0].locked, true);
  w.equip(0, 1);
  while (activeItems(w).length < 16) w.grantTestWeapon(0);
  assert.equal(w.unequip(1).reason, 'backpackFull');
  assert.equal(w.equip(0, 0).ok, true, 'swap remains legal with full backpack');
  assert.equal(w.snapshot().backpack[0].locked, true);
});

test('Backpack drop moves an incompatible target to the previewed empty slot in one persisted transaction', () => {
  const writes = [];
  const w = inventory({ rng: () => { throw Error('reordering must not sample a merge result'); },
    onMutation: () => writes.push(JSON.stringify(w.serialize())) });
  w.grantTestWeapon(0); w.grantTestWeapon(3); w.grantTestWeapon(6);
  w.drainNotifications(); writes.length = 0;
  const before = w.serialize(), revision = w.revision;
  const expected = JSON.parse(JSON.stringify(before));
  expected.backpack[0] = null; expected.backpack[1] = before.backpack[0]; expected.backpack[5] = before.backpack[1];
  assert.equal(w.moveBackpack(0, 1, 5).ok, true);
  assert.deepEqual(w.serialize(), expected, 'only the three chosen positions change; no spending, collection or merge side effects');
  assert.equal(w.revision, revision + 1); assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]), expected, 'persistence observes the complete drop, never an intermediate missing item');
  assert.deepEqual(inventory({ initialState: JSON.parse(writes[0]) }).serialize(), expected);
  assert.deepEqual(w.drainNotifications(), []);
});

test('Backpack drop into an empty slot keeps holes, and a full backpack swaps the displaced item back to the source', () => {
  const w = inventory(); w.grantTestWeapon(1); w.drainNotifications();
  const before = w.serialize();
  assert.equal(w.moveBackpack(0, 15).ok, true);
  assert.equal(w.serialize().backpack[0], null); assert.deepEqual(w.serialize().backpack[15], before.backpack[0]);
  assert.equal(w.serialize().backpack.filter(Boolean).length, 1);
  const full = inventory();
  for (let id = 0; id < 16; id++) full.grantTestWeapon(id);
  full.drainNotifications();
  const original = full.serialize(), revision = full.revision;
  assert.equal(full.moveBackpack(0, 8).ok, true);
  const expected = JSON.parse(JSON.stringify(original));
  [expected.backpack[0], expected.backpack[8]] = [expected.backpack[8], expected.backpack[0]];
  assert.deepEqual(full.serialize(), expected); assert.equal(full.revision, revision + 1);
  assert.deepEqual(full.drainNotifications(), []);
});

test('Backpack drag preserves locked and pending-ad items and the pending reward follows its moved slot', () => {
  const w = inventory(); w.configureTest({ stageValueMax: 390 });
  w.grantTestWeapon(0); w.grantTestWeapon(0); w.merge(0, 1);
  w.grantTestWeapon(6); w.toggleLock({ kind: 'backpack', index: 2 });
  w.drainNotifications();
  const before = w.serialize(), ad = w.beginAd('weapon');
  assert.equal(ad.ok, true); assert.equal(w.swapBackpack(0, 2).reason, 'pendingAd', 'legacy swap restrictions stay unchanged');
  assert.equal(w.moveBackpack(2, 0, 5).ok, true);
  assert.deepEqual(w.serialize().backpack[0], before.backpack[2]);
  assert.deepEqual(w.serialize().backpack[5], before.backpack[0]);
  assert.equal(w.serialize().backpack[2], null);
  assert.equal(w.moveBackpack(5, 0).ok, true, 'a pending ad gun can also be the dragged source');
  assert.deepEqual(w.serialize().backpack[0], before.backpack[0]);
  assert.deepEqual(w.serialize().backpack[5], before.backpack[2]);
  assert.equal(w.serialize().adGunExpiresAt, before.adGunExpiresAt);
  assert.equal(w.serialize().collection[8], false); assert.deepEqual(w.drainNotifications(), []);
  const restored = inventory({ initialState: JSON.parse(JSON.stringify(w.serialize())) });
  assert.deepEqual(restored.serialize().backpack, w.serialize().backpack, 'save restoration preserves both item flags and positions');
  assert.equal(w.completeAd(ad.token, 'success').ok, true);
  assert.deepEqual(w.serialize().backpack[0], { weaponId: 8, locked: false, pendingAd: false });
  assert.deepEqual(w.serialize().backpack[5], before.backpack[2]);
  assert.equal(w.completeAd(ad.token, 'success').reason, 'staleAd');
});

test('Invalid backpack drops never overwrite or lose items, persist changes, or increment revision', () => {
  let writes = 0;
  const w = inventory({ onMutation: () => writes++ });
  w.grantTestWeapon(0); w.grantTestWeapon(2); w.grantTestWeapon(5); w.drainNotifications();
  const before = w.serialize(), revision = w.revision, written = writes;
  const attempts = [
    [-1, 1, 0], [16, 1, 0], [0, -1, 0], [0, 16, 0], [0.5, 1, 0], [0, NaN, 0],
    [0, 1, -1], [0, 1, 16], [0, 1, 0.5], [0, 1, Infinity], [0, 0, 0], [0, 1, 1],
    [3, 1, 3], [0, 1, 2],
  ];
  for (const args of attempts) {
    assert.equal(w.moveBackpack(...args).ok, false, `invalid drop ${args}`);
    assert.deepEqual(w.serialize(), before); assert.equal(w.revision, revision); assert.equal(writes, written);
  }
  assert.deepEqual(w.drainNotifications(), []);
});

test('Combat stars intentionally follow compact actor index, including the original empty-slot discrepancy', () => {
  const session = unlockedSession({ environment: 'test' }); const w = session.weapons;
  w.configureTest({ starLevels: [1, 2, 3] }); w.grantTestWeapon(8); w.equip(0, 2);
  let loadout = session.combatLoadout;
  assert.deepEqual(loadout.map(item => item.weapon.id), [0, 8]);
  assert.deepEqual(loadout.map(item => item.starLevel), [1, 2]);
  assert.equal(loadout[1].damage.compare(D.from(getWeapon(8).damage).mul('2.4')), 0);
  assert.equal(w.snapshot().stars[2].multiplier.toString(), '4.1');
  w.unequip(0); loadout = session.getLoadout();
  assert.equal(loadout.length, 1); assert.equal(loadout[0].weapon.id, 8); assert.equal(loadout[0].starLevel, 1);
  assert.equal(loadout[0].damage.compare(D.from(getWeapon(8).damage).mul('1.5')), 0);
  assert.equal(loadout[0].criticalChance, 0); assert.equal(loadout[0].criticalMultiplier, 1.25);
});

test('Equipment star damage follows source precision and applies the percent before division', () => {
  // Native Damage_Apply multiplies the serialized InfVal, truncates, then
  // divides by int 100; these fixtures expose exact-Decimal overstatements.
  for (const [weaponId, level, expected] of [
    [1, 0, '80'], [1, 8, '12800'], [1, 9, '34400'],
    [3, 8, '38600'], [3, 9, '103000'], [3, 18, '11000000000'],
    [0, 10, '120000'], [57, 20, '2400000000000000000'],
  ]) assert.equal(getWeaponStarDamage(weaponId, level).toString(), expected, `${weaponId} at star ${level}`);
  assert.throws(() => getWeaponStarDamage(0, -1));
  assert.throws(() => getWeaponStarDamage(0, 21));
  assert.throws(() => getWeaponStarDamage(65, 1));
});

test('Star formula preserves source double accumulation, truncated bonuses and capped high-level failure boost', () => {
  assert.deepEqual([0, 1, 2, 3, 5, 10, 20].map(level => getStarMultiplier(level).toString()),
    // Source EnsureTables uses InfVal addition: the p2 bonus + int 100 is p3.
    ['1', '1.5', '2.4', '4.1', '14', '1200', '1200000000']);
  assert.equal(getStarBonusPercent(2).toString(), '140');
  assert.deepEqual([0, 1, 2, 3, 4, 40].map(failure => getStarSuccessPercent(17, failure)), [1, 2, 3, 4, 5, 5]);
  assert.equal(getStarSuccessPercent(16, 100), 5); assert.equal(getStarSuccessPercent(20, 0), null);
  let roll = 0.01, samples = 0;
  const w = inventory({ rng: () => { samples++; return roll; } });
  w.configureTest({ starGems: 0 });
  assert.equal(w.upgradeStar(1).status, 'notEnoughGem'); assert.equal(samples, 0);
  w.grantTestStarGems(10000);
  assert.equal(w.upgradeStar(1).status, 'success', 'empty slots can upgrade'); assert.equal(w.starGems, 9950);
  w.configureTest({ starLevels: [17, 1, 20] });
  assert.equal(w.upgradeStar(0).status, 'failure'); assert.equal(w.starGems, 9050);
  assert.equal(w.snapshot().stars[0].level, 17); assert.equal(w.snapshot().stars[0].failureCount, 1);
  assert.equal(w.upgradeStar(0).status, 'success'); assert.equal(w.starGems, 8150); assert.equal(w.snapshot().stars[0].failureCount, 0);
  const before = samples; assert.equal(w.upgradeStar(2).status, 'max'); assert.equal(samples, before);
});

test('Auto unlocks by progression, rejects retired advertising and has no timed entitlement', () => {
  const w = inventory();
  assert.equal(w.snapshot().auto.unlocked, true);
  assert.equal(w.snapshot().firstMerge, false);
  assert.equal(w.setAutoMerge(true).ok, true);
  const before = w.serialize();
  assert.equal(w.beginAd('auto').reason, 'invalidAd');
  assert.equal(w.completeAd('retired-auto', 'success').reason, 'staleAd');
  assert.deepEqual(w.serialize(), before);
  w.advanceTestTime(8 * 24 * 60 * 60 * 1000);
  assert.equal(w.snapshot().auto.enabled, true);
  assert.equal('expiresAt' in w.snapshot().auto, false);
  assert.equal('entitled' in w.snapshot().auto, false);
  const production = inventory({ environment: 'production' });
  production.recordStageValue(189);
  assert.equal(production.snapshot().auto.unlocked, false);
  assert.equal(production.setAutoMerge(true).reason, 'locked');
  production.recordStageValue(190);
  assert.equal(production.setAutoMerge(true).ok, true);
  assert.equal(production.snapshot().auto.enabled, true);
});

test('Old auto expiration fields are discarded while the player switch and real weapons survive reload', () => {
  const w = inventory(); w.configureTest({ adGunEnabled: false });
  w.grantTestWeapon(2); w.grantTestWeapon(0); w.grantTestWeapon(1); w.setAutoMerge(true);
  const saved = w.serialize(); saved.autoExpiresAt = 1;
  const restored = inventory({ initialState: saved });
  assert.equal(restored.snapshot().auto.enabled, true);
  assert.equal('autoExpiresAt' in restored.serialize(), false);
  assert.deepEqual(restored.serialize().backpack, saved.backpack);
  assert.equal(restored.autoMergeStep().ok, true);
});

test('Auto merge checks discovered grade/config/SSS cap and excludes protected or dragged items', () => {
  const w = inventory(); w.configureTest({ adGunEnabled: false }); w.setAutoMerge(true);
  w.grantTestWeapon(0); w.grantTestWeapon(1);
  assert.equal(w.autoMergeStep().reason, 'noPair', 'D discovery alone cannot auto-merge D');
  w.grantTestWeapon(2);
  assert.equal(w.autoMergeStep([0]).reason, 'noPair'); assert.equal(w.autoMergeStep().weaponId, 2);
  assert.deepEqual(w.snapshot().backpack.slice(0, 3).map(item => item?.weaponId ?? -1), [2, -1, 2],
    'source FindAutoMergePair/FuseItems keep the result in the earlier slot');
  assert.equal(w.autoMergeStep().reason, 'noPair', 'C material waits for B discovery');
  w.grantTestWeapon(5); assert.equal(w.autoMergeStep().weaponId, 5);
  const high = inventory(); high.configureTest({ adGunEnabled: false }); high.setAutoMerge(true);
  high.grantTestWeapon(57); high.grantTestWeapon(29); high.grantTestWeapon(32);
  assert.equal(high.snapshot().auto.maxMaterialGrade, 6); assert.equal(high.autoMergeStep().reason, 'noPair');
  high.grantTestWeapon(24); high.grantTestWeapon(27); assert.equal(high.autoMergeStep().weaponId, 29);
});

test('A draw during auto movement keeps the selected pair even when a new lower-grade pair becomes available', () => {
  let samples = 0, writes = 0;
  const w = inventory({ rng: () => { samples++; return 0; }, onMutation: () => writes++ });
  w.configureTest({ adGunEnabled: false }); w.setAutoMerge(true);
  for (const id of [0, 2, 4, 5]) w.grantTestWeapon(id);
  w.drainNotifications();
  assert.equal(w.draw().weaponId, 0);
  const before = w.serialize(), revision = w.revision, written = writes;
  assert.equal(w.autoMergePair(2, 1, 4, 2).weaponId, 5);
  assert.deepEqual(w.snapshot().backpack.map(item => item?.weaponId ?? -1),
    [0, 5, -1, 5, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
  assert.deepEqual(w.serialize().backpack[0], before.backpack[0], 'first backpack gun stays in place');
  assert.deepEqual(w.serialize().backpack[4], before.backpack[4], 'newly drawn gun stays in place');
  assert.equal(w.diamonds, before.diamonds); assert.equal(samples, 2);
  assert.equal(w.revision, revision + 1); assert.equal(writes, written + 1);
  const merged = w.serialize();
  assert.equal(w.autoMergePair(2, 1, 4, 2).reason, 'noPair', 'duplicate animation completion cannot merge another pair');
  assert.deepEqual(w.serialize(), merged); assert.equal(samples, 2); assert.equal(writes, written + 1);
});

test('Selected auto pairs reject changed guns, locks, pending rewards, limits, invalid slots and disabled Auto', () => {
  function prepared() {
    const w = inventory({ rng: () => { throw Error('rejected auto pair must not sample a result'); } });
    w.configureTest({ adGunEnabled: false }); w.setAutoMerge(true);
    for (const id of [0, 2, 4, 9]) w.grantTestWeapon(id);
    return w;
  }
  const cases = [
    { change: w => w.swapBackpack(1, 3), reason: 'noPair' },
    { change: w => w.toggleLock({ kind: 'backpack', index: 1 }), reason: 'protected' },
    { change: w => w.configureTest({ autoMergeDegree: 0 }), reason: 'noPair' },
    { change: w => w.setAutoMerge(false), reason: 'autoInactive' },
  ];
  for (const { change, reason } of cases) {
    const w = prepared(); change(w); const before = w.serialize(), revision = w.revision;
    assert.equal(w.autoMergePair(1, 2, 2, 4).reason, reason);
    assert.deepEqual(w.serialize(), before); assert.equal(w.revision, revision);
  }
  const w = prepared(), before = w.serialize(), revision = w.revision;
  for (const [from, to] of [[-1, 2], [1, 16], [1, 1], [NaN, 2], [1.5, 2]]) {
    assert.equal(w.autoMergePair(from, to, 2, 4).reason, 'invalidSlot');
    assert.deepEqual(w.serialize(), before); assert.equal(w.revision, revision);
  }
  const state = w.serialize();
  state.backpack[1] = { weaponId: 8, locked: false, pendingAd: true };
  state.backpack[2] = { weaponId: 5, locked: false, pendingAd: false };
  state.collection[5] = true; state.adGunExpiresAt = w.now + AD_WEAPON_DURATION_MS;
  const pending = inventory({ initialState: state });
  assert.equal(pending.autoMergePair(1, 2, 8, 5).reason, 'pendingAd');
  assert.deepEqual(pending.serialize(), state);
  const high = prepared(); high.grantTestWeapon(57); high.grantTestWeapon(29); high.grantTestWeapon(32);
  assert.equal(high.autoMergePair(5, 6, 29, 32).reason, 'noPair', 'SSS is the automatic material cap');
  const undiscovered = inventory(); undiscovered.setAutoMerge(true);
  undiscovered.grantTestWeapon(0); undiscovered.grantTestWeapon(1);
  assert.equal(undiscovered.autoMergePair(0, 1, 0, 1).reason, 'noPair', 'next grade must already be discovered');
});

test('Test daily C ad works at stage zero but honors day/full-backpack boundaries; failure consumes neither today nor RNG', () => {
  let samples = 0; const w = inventory({ rng: () => { samples++; return 0.999; } });
  assert.equal(w.snapshot().stageValueMax, 0); assert.equal(w.snapshot().dailyAdUnlocked, true);
  let ad = w.beginAd('daily'); w.completeAd(ad.token, 'failure');
  assert.equal(w.snapshot().dailyAdAvailable, true); assert.equal(samples, 0);
  ad = w.beginAd('daily'); while (activeItems(w).length < 16) w.grantTestWeapon(0);
  assert.equal(w.completeAd(ad.token, 'success').reason, 'backpackFull'); assert.equal(samples, 0);
  assert.equal(w.snapshot().dailyAdAvailable, true);
  w.drainNotifications();
  w.configureTest({ adGunEnabled: false }); w.merge(0, 1);
  assert.equal(beginSuccess(w, 'daily').weaponId, 63); assert.equal(w.snapshot().dailyAdAvailable, false);
  assert.equal(w.beginAd('daily').reason, 'dailyUsed');
  w.advanceTestTime(24 * 60 * 60 * 1000); assert.equal(w.snapshot().dailyAdAvailable, true);
});

test('Daily ad bypass is test-only and saved daily claims stay consumed without changing stage progress', () => {
  const store = storage(), options = { environment: 'test', storage: store, now: () => 1700000000000, rng: () => 0 };
  const testing = unlockedSession(options).weapons;
  assert.equal(testing.snapshot().dailyAdAvailable, true);
  assert.equal(beginSuccess(testing, 'daily').weaponId, 2);
  const restored = unlockedSession(options).weapons;
  assert.equal(restored.snapshot().stageValueMax, 0);
  assert.equal(restored.snapshot().dailyAdUnlocked, true); assert.equal(restored.snapshot().dailyAdAvailable, false);
  assert.equal(restored.beginAd('daily').reason, 'dailyUsed');
  const production = unlockedSession({ ...options, environment: 'production' }).weapons;
  for (const stage of [0, 29]) {
    production.recordStageValue(stage);
    assert.equal(production.snapshot().dailyAdUnlocked, false); assert.equal(production.snapshot().dailyAdAvailable, false);
    assert.equal(production.beginAd('daily').reason, 'locked');
  }
  production.recordStageValue(30);
  assert.equal(production.snapshot().dailyAdUnlocked, true); assert.equal(production.snapshot().dailyAdAvailable, true);
  assert.equal(beginSuccess(production, 'daily').weaponId, 2);
});

test('Repeat daily C rewards do not force discovery popups, and ad tokens never overflow into duplicates', () => {
  const w = inventory(); w.configureTest({ stageValueMax: 30 }); w.grantTestWeapon(2); w.drainNotifications();
  assert.equal(beginSuccess(w, 'daily').forceShow, false); assert.deepEqual(w.drainNotifications(), []);
  const saved = w.serialize(); saved.nextAdId = Number.MAX_SAFE_INTEGER; saved.dailyAdDate = '';
  const exhausted = inventory({ initialState: saved });
  assert.equal(exhausted.beginAd('daily').reason, 'adTokenExhausted'); assert.equal(exhausted.snapshot().pendingAd, null);
  assert.equal(w.advanceTestTime(Number.MAX_SAFE_INTEGER).reason, 'invalidTime');
});

test('30-minute ad gun is a claim deadline: pending cannot be used, in-flight ads defer expiry, claimed guns persist', () => {
  const w = inventory(); w.grantTestWeapon(0); w.grantTestWeapon(0); w.merge(0, 1);
  let state = w.snapshot(); const at = state.backpack.findIndex(item => item?.pendingAd);
  assert.ok(at >= 0); assert.equal(state.collection[8], false);
  assert.equal(w.equip(at, 1).reason, 'pendingAd'); assert.equal(w.merge(at, 1).reason, 'pendingAd');
  w.configureTest({ stageValueMax: 390 }); assert.equal(w.toggleLock({ kind: 'backpack', index: at }).reason, 'pendingAd');
  const ad = w.beginAd('weapon'); w.advanceTestTime(AD_WEAPON_DURATION_MS + 1);
  assert.equal(w.snapshot().backpack[at].pendingAd, true);
  const claim = w.completeAd(ad.token, 'success'); assert.equal(claim.weaponId, 8); assert.equal(claim.forceShow, true);
  assert.equal(w.snapshot().collection[8], true); w.advanceTestTime(8 * 24 * 60 * 60 * 1000);
  assert.equal(w.snapshot().backpack[at].weaponId, 8); assert.equal(w.snapshot().backpack[at].pendingAd, false);
  const expires = inventory(); expires.grantTestWeapon(0); expires.grantTestWeapon(0); expires.merge(0, 1);
  const before = expires.snapshot().backpack.findIndex(item => item?.pendingAd); const cancelled = expires.beginAd('weapon');
  expires.advanceTestTime(AD_WEAPON_DURATION_MS); expires.completeAd(cancelled.token, 'cancel');
  assert.equal(expires.snapshot().backpack[before], null); assert.equal(expires.snapshot().collection[8], false);
});

test('Every rewarded ad defers a pending gun deadline until its own callback without granting that gun', () => {
  for (const kind of ['daily']) for (const outcome of ['success', 'cancel', 'failure']) {
    let now = new Date(2026, 9, 10, 12).getTime();
    const w = inventory({ now: () => now });
    w.grantTestWeapon(0); w.grantTestWeapon(0); w.merge(0, 1);
    const at = w.snapshot().backpack.findIndex(item => item?.pendingAd), deadline = w.snapshot().adGunExpiresAt;
    w.drainNotifications(); now = deadline - 1;
    const ad = w.beginAd(kind);
    assert.equal(ad.ok, true);
    now = deadline + 1000; w.tick();
    assert.equal(w.snapshot().backpack[at]?.pendingAd, true, `${kind} defers the unrelated offer's expiration`);
    assert.equal(w.snapshot().adGunExpiresAt, deadline);
    assert.equal(w.snapshot().collection[8], false);
    assert.equal(w.completeAd(ad.token, outcome).ok, outcome === 'success');
    assert.equal(w.snapshot().backpack[at], null, 'the expired unclaimed gun is removed when the ad finishes');
    assert.equal(w.snapshot().adGunExpiresAt, 0);
    assert.equal(w.snapshot().collection[8], false, 'watching another ad never claims the pending gun');
    assert.equal(w.completeAd(ad.token, 'success').reason, 'staleAd');
  }
});

test('Saved ad attempts do not survive reload or replay tokens, and expired pending guns are removed on launch', () => {
  const w = inventory(); w.grantTestWeapon(0); w.grantTestWeapon(0); w.merge(0, 1);
  const ad = w.beginAd('weapon'); const saved = w.serialize();
  const reloaded = inventory({ initialState: saved }); assert.equal(reloaded.completeAd(ad.token, 'success').reason, 'staleAd');
  assert.notEqual(reloaded.beginAd('weapon').token, ad.token);
  const expired = inventory({ initialState: saved, now: () => saved.adGunExpiresAt + 1 });
  assert.equal(expired.snapshot().adGunExpiresAt, 0); assert.equal(activeItems(expired).some(item => item.pendingAd), false);
});

test('Interrupted 30-minute weapon ads preserve an unexpired offer but expire it at the deadline without discovery or replay', () => {
  for (const outcome of ['cancel', 'failure']) for (const expired of [false, true]) {
    let now = new Date(2026, 9, 10, 12).getTime();
    const w = inventory({ now: () => now }); w.grantTestWeapon(0); w.grantTestWeapon(0); w.merge(0, 1); w.drainNotifications();
    const slot = w.snapshot().backpack.findIndex(item => item?.pendingAd), deadline = w.snapshot().adGunExpiresAt;
    const ad = w.beginAd('weapon'); now = deadline - (expired ? 0 : 1);
    w.tick(); assert.equal(w.snapshot().backpack[slot].pendingAd, true, 'the active ad defers expiration until its callback');
    assert.equal(w.completeAd(ad.token, outcome).reason, outcome === 'cancel' ? 'adCancelled' : 'adFailed');
    assert.equal(w.completeAd(ad.token, 'success').reason, 'staleAd');
    assert.equal(w.snapshot().collection[8], false); assert.deepEqual(w.drainNotifications(), []);
    const restored = inventory({ now: () => now, initialState: w.serialize() });
    assert.equal(restored.completeAd(ad.token, 'success').reason, 'staleAd');
    if (expired) {
      assert.equal(restored.snapshot().backpack[slot], null); assert.equal(restored.snapshot().adGunExpiresAt, 0);
      assert.equal(restored.beginAd('weapon').reason, 'noAdWeapon');
    } else {
      assert.equal(restored.snapshot().backpack[slot].pendingAd, true); assert.equal(restored.snapshot().adGunExpiresAt, deadline);
      const retry = restored.beginAd('weapon'); assert.notEqual(retry.token, ad.token);
      assert.equal(restored.completeAd(retry.token, 'success').weaponId, 8);
      now = deadline + 8 * 24 * 60 * 60 * 1000;
      assert.equal(restored.snapshot().backpack[slot].pendingAd, false); assert.equal(restored.snapshot().collection[8], true);
    }
  }
});

test('Removed step rewards and unsupported payment commands cannot create transactions in either environment', () => {
  for (const environment of ['test', 'production']) {
    const w = inventory({ environment }), saved = w.serialize(), revision = w.revision;
    assert.equal(w.beginStepUpAd, undefined); assert.equal(w.grantTestStepUp, undefined);
    for (const kind of ['purchase', 'payment', 'buyDiamonds', 'stepUp']) {
      assert.equal(w.beginAd(kind).reason, 'invalidAd');
      assert.equal(w.completeAd(kind, 'success').reason, 'staleAd');
    }
    assert.deepEqual(w.serialize(), saved); assert.equal(w.revision, revision);
    assert.equal(w.snapshot().pendingAd, null); assert.deepEqual(w.drainNotifications(), []);
  }
});

test('Corrupt inventory fails atomically and mutation callback persists each completed command once', () => {
  let changes = 0; const w = inventory({ onMutation: () => changes++ });
  w.grantTestWeapon(2); assert.equal(changes, 1); w.equip(0, 1); assert.equal(changes, 2);
  assert.equal(w.merge(0, 1).ok, false); assert.equal(changes, 2);
  const invalids = [state => { state.equipment.fill(null); }, state => { state.backpack[0] = { weaponId: 65, locked: false, pendingAd: false }; },
    state => { state.starLevels[0] = NaN; }, state => { state.collection[0] = false; }, state => { state.diamonds = Infinity; }];
  for (const invalidate of invalids) { const state = w.serialize(); invalidate(state); assert.throws(() => WeaponInventory.validate(state)); }
  const repairable = w.serialize(); repairable.starLevels = [-1, 21, 3]; repairable.starFailures = [-12, 2, 0];
  const repaired = WeaponInventory.validate(repairable);
  assert.deepEqual(repaired.starLevels, [0, 20, 3]); assert.deepEqual(repaired.starFailures, [0, 2, 0]);
  const before = w.snapshot(); assert.equal(w.configureTest({ starLevels: [21, 0, 0], diamonds: 0 }).ok, false);
  assert.equal(w.diamonds, before.diamonds); assert.equal(w.snapshot().stars[0].level, before.stars[0].level);
});
