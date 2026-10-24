const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { OriginalInfVal } = require('./.build/session/core/OriginalInfVal.js');
const { getWeapon, getWeaponGrade, getWeaponIdsForGrade } = require('./.build/session/core/WeaponCatalog.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');

const KEY = economyStorageKey('production');
function storage() {
  const data = new Map(), writes = [];
  return { data, writes, getItem: key => data.get(key) ?? null,
    setItem(key, value) { data.set(key, value); writes.push(JSON.parse(value)); } };
}
function saved(store) { return JSON.parse(store.getItem(KEY)); }
function editSave(store, edit) { const data = saved(store); edit(data); store.setItem(KEY, JSON.stringify(data)); }
function fixture(edit = () => {}, options = {}) {
  const store = storage(), make = () => new BattleSession({ rng: () => 0, ...options, storage: store });
  make(); editSave(store, edit);
  return { store, make, session: make() };
}
function expectStep(session, step, drawCount = 0) {
  assert.deepEqual(session.getTutorialState(), { active: step !== 'done', step, drawCount });
}
function expectUnchanged(store, session, operation, reason) {
  const before = saved(store), state = session.weapons.serialize(), tutorial = session.getTutorialState(), count = store.writes.length;
  const result = operation();
  assert.equal(result.ok, false); if (reason) assert.equal(result.reason, reason);
  assert.deepEqual(session.weapons.serialize(), state); assert.deepEqual(session.getTutorialState(), tutorial);
  assert.deepEqual(saved(store), before); assert.equal(store.writes.length, count);
}
function openedFixture(options = {}) {
  const f = fixture(save => { save.levels = [3, 0, 0]; }, options);
  f.session.onWeaponPanelOpened();
  return f;
}

test('real onboarding resumes after every action, saves balances and teaching together, then survives rebirth', () => {
  const { store, make, session: initial } = fixture(save => { save.money = OriginalInfVal.fromAmount(D.from(1000)).toJSON(); });
  let session = initial, challengeWon = false;
  function reloadAt(step, drawCount = 0) {
    expectStep(session, step, drawCount);
    for (const id of ['skins', 'rebirth']) assert.equal(session.getContentState(id).visible, step === 'done' && challengeWon);
    assert.deepEqual(saved(store).tutorial, { step, drawCount }, 'action saved teaching progress');
    const money = session.moneyBalance.toString(), weapons = session.weapons.serialize();
    session = make(); expectStep(session, step, drawCount);
    for (const id of ['skins', 'rebirth']) assert.equal(session.getContentState(id).visible, step === 'done' && challengeWon);
    assert.equal(session.moneyBalance.toString(), money); assert.deepEqual(session.weapons.serialize(), weapons);
  }
  function action(operation, step, drawCount, diamonds, backpackIds) {
    store.writes.length = 0;
    assert.equal(operation().ok, true); expectStep(session, step, drawCount);
    assert.equal(store.writes.length, 1, 'successful transaction makes one combined save');
    const committed = store.writes[0];
    assert.deepEqual(committed.tutorial, { step, drawCount });
    assert.equal(committed.weapons.diamonds, diamonds);
    assert.deepEqual(committed.weapons.backpack.filter(Boolean).map(item => item.weaponId), backpackIds);
    reloadAt(step, drawCount);
    session.onWeaponPanelOpened();
    assert.equal(session.weapons.diamonds, diamonds, 'reopen never replenishes consumed teaching funds');
  }
  reloadAt('upgrade');
  for (let level = 1; level <= 2; level++) {
    assert.equal(session.purchase('power'), true); reloadAt('upgrade');
    assert.equal(session.getSpeedRunState().unlocked, false); assert.equal(session.weapons.snapshot().unlocked, false);
  }
  assert.equal(session.purchase('power'), true); reloadAt('gunOpen');
  assert.equal(session.getSpeedRunState().unlocked, true); assert.equal(session.weapons.snapshot().unlocked, true);
  assert.equal(session.weapons.diamonds, 0, 'unlocking before a challenge grants no challenge reward');
  store.writes.length = 0; session.onWeaponPanelOpened();
  assert.equal(store.writes.length, 1);
  assert.deepEqual(store.writes[0].tutorial, { step: 'gunBuy', drawCount: 0 });
  assert.equal(store.writes[0].weapons.diamonds, 200);
  assert.equal(store.writes[0].content.firstDrawGranted, true);
  reloadAt('gunBuy');
  action(() => session.weapons.draw(), 'gunBuy', 1, 100, [0]);
  action(() => session.weapons.draw(), 'gunMerge', 2, 0, [0, 0]);
  action(() => session.weapons.merge(0, 1), 'gunEquip', 2, 0, [3]);
  assert.equal(session.weapons.snapshot().collection[3], true);
  assert.equal(D.from(getWeapon(3).damage).toNumber(), 240); assert.equal(getWeapon(3).category, 'crossbow');
  action(() => session.weapons.equip(1, 1), 'done', 2, 0, []);
  assert.equal(session.weapons.snapshot().equipment[1].weaponId, 3);
  assert.equal(session.purchaseSkin(1).reason, 'contentLocked');
  assert.equal(session.equipSkin(0).reason, 'contentLocked');
  assert.equal(session.requestRebirth('normal').reason, 'locked');
  for (const attempt of ['exit', 'failure', 'win']) {
    assert.equal(session.startSpeedRun().ok, true); session.advanceFrame(1.5);
    if (attempt === 'failure') {
      session.advanceFrame(60); session.advanceFrame(.01);
      assert.equal(session.getSpeedRunState().phase, 'failed');
    }
    if (attempt === 'win') {
      session.consume([{ type: 'complete', position: { x: 0, z: 0 } }], [{ id: 0, alive: false, reward: D.from(0) }]);
      assert.equal(session.getSpeedRunState().phase, 'won'); challengeWon = true;
    }
    assert.equal(session.exitSpeedRun().ok, true); session.advanceFrame(1.5);
    reloadAt('done', 2);
  }
  assert.equal(saved(store).speedRun.stage, 1);
  assert.equal(session.weapons.diamonds, 60);
  assert.equal(session.purchaseSkin(1).reason, 'diamonds', 'the first clear no longer funds a 100-diamond skin');
  assert.equal(session.startSpeedRun().ok, true); session.advanceFrame(1.5);
  session.consume([{ type: 'complete', position: { x: 0, z: 0 } }], [{ id: 0, alive: false, reward: D.from(0) }]);
  assert.equal(session.weapons.diamonds, 126, 'the second clear adds 66 diamonds');
  assert.equal(session.exitSpeedRun().ok, true); session.advanceFrame(1.5); reloadAt('done', 2);
  assert.equal(session.purchaseSkin(1).ok, true); assert.equal(session.equipSkin(1).ok, true);
  editSave(store, save => { save.progress = { stageIndex: 2, waveIndex: 0 }; save.weapons.stageValueMax = 20; });
  session = make(); assert.equal(session.requestRebirth('normal').ok, true); session.advanceRebirth(2);
  assert.equal(session.moneyBalance.toString(), '0'); assert.deepEqual(saved(store).levels, [0, 0, 0]);
  reloadAt('done', 2);
  assert.equal(session.getSkinState().selectedId, 1);
  assert.equal(session.getSpeedRunState().unlocked, true); assert.equal(session.weapons.snapshot().unlocked, true);
  session.onWeaponPanelOpened(); assert.equal(session.weapons.diamonds, 26);
});

test('teaching guards retain materials and the crossbow while invalid operations leave saves unchanged', () => {
  const fresh = new BattleSession();
  assert.equal(fresh.purchase('power'), false); assert.equal(fresh.startSpeedRun().reason, 'locked');
  assert.equal(fresh.weapons.draw().reason, 'weaponsLocked'); fresh.onWeaponPanelOpened();
  expectStep(fresh, 'upgrade'); assert.equal(fresh.weapons.diamonds, 0);
  const { store, session: s } = fixture(save => { save.levels = [3, 0, 0]; });
  expectUnchanged(store, s, () => s.weapons.draw(), 'tutorialStep');
  s.onWeaponPanelOpened();
  assert.equal(s.weapons.draw().ok, true);
  for (const operation of [() => s.weapons.equip(0, 1), () => s.weapons.merge(0, 1),
    () => s.weapons.unequip(0), () => s.weapons.beginAd('daily')]) expectUnchanged(store, s, operation, 'tutorialStep');
  assert.equal(s.weapons.draw().ok, true);
  expectUnchanged(store, s, () => s.weapons.draw(), 'tutorialStep');
  expectUnchanged(store, s, () => s.weapons.equip(0, 1), 'tutorialStep');
  expectUnchanged(store, s, () => s.weapons.merge(0, 0), 'invalidSlot');
  expectUnchanged(store, s, () => s.weapons.merge(0, 15), 'emptySlot');
  assert.equal(s.weapons.merge(0, 1).weaponId, 3);
  expectUnchanged(store, s, () => s.weapons.draw(), 'tutorialStep');
  expectUnchanged(store, s, () => s.weapons.merge(1, 0), 'tutorialStep');
  expectUnchanged(store, s, () => s.weapons.equip(1, 9), 'invalidSlot');
  assert.equal(s.weapons.equip(1, 0).ok, true); expectStep(s, 'done', 2);
});

test('teaching draws use the D pool and all random rolls merge to the 240-attack C crossbow in every legal slot', () => {
  const observed = new Set();
  for (const rngValue of [0, .25, .5, .75, .999999]) for (const equipmentSlot of [0, 1, 2]) {
    const { session: s, make } = openedFixture({ rng: () => rngValue });
    const a = s.weapons.draw(), b = s.weapons.draw();
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    for (const result of [a, b]) { assert.equal(getWeaponGrade(result.weaponId), 0); observed.add(result.weaponId); }
    assert.equal(s.weapons.merge(0, 1).weaponId, 3);
    const crossbow = getWeapon(s.weapons.snapshot().backpack[1].weaponId);
    assert.equal(crossbow.grade, 1); assert.equal(crossbow.category, 'crossbow'); assert.equal(D.from(crossbow.damage).toNumber(), 240);
    assert.equal(s.weapons.equip(1, equipmentSlot).ok, true); expectStep(s, 'done', 2);
    assert.equal(make().weapons.snapshot().equipment[equipmentSlot].weaponId, 3);
  }
  assert.deepEqual([...observed].sort((a, b) => a - b), [...getWeaponIdsForGrade(0)]);
});

test('moving cards in the backpack preserves count and resumes the same merge/equip step', () => {
  const { store, make, session: s } = openedFixture();
  s.weapons.draw(); s.weapons.draw();
  assert.equal(s.weapons.moveBackpack(0, 5).ok, true); expectStep(s, 'gunMerge', 2);
  let reloaded = make(); assert.equal(reloaded.weapons.merge(5, 1).weaponId, 3);
  assert.equal(reloaded.weapons.moveBackpack(1, 6).ok, true); expectStep(reloaded, 'gunEquip', 2);
  reloaded = make(); reloaded.onWeaponPanelOpened(); assert.equal(reloaded.weapons.diamonds, 0);
  assert.equal(reloaded.weapons.equip(6, 2).ok, true);
  assert.deepEqual(saved(store).tutorial, { step: 'done', drawCount: 2 });
});

test('an existing or pending weapon cannot replace the required two successful paid draws', () => {
  const options = { contentConfig: resolveContentConfig('production', { adsEnabled: true }), now: () => 1000 };
  const { store, session: s } = fixture(save => {
    save.levels = [3, 0, 0]; save.tutorial = { step: 'gunBuy', drawCount: 0 };
    save.content = { challengeUnlocked: true, weaponsUnlocked: true, firstDrawGranted: true };
    save.weapons.backpack[0] = { weaponId: 8, locked: false, pendingAd: true };
    save.weapons.backpack[1] = { weaponId: 0, locked: false, pendingAd: false };
    save.weapons.adGunExpiresAt = 100000;
  }, options);
  expectStep(s, 'gunBuy');
  expectUnchanged(store, s, () => s.weapons.draw(), 'notEnoughDiamonds');
  expectUnchanged(store, s, () => s.weapons.equip(1, 1), 'tutorialStep');
  expectUnchanged(store, s, () => s.weapons.beginAd('weapon'), 'tutorialStep');
  s.weapons.grantDiamonds(200); s.weapons.draw(); expectStep(s, 'gunBuy', 1);
  s.weapons.draw(); expectStep(s, 'gunMerge', 2);
  expectUnchanged(store, s, () => s.weapons.merge(0, 1), 'pendingAd');
  assert.equal(s.weapons.merge(2, 3).weaponId, 3); expectStep(s, 'gunEquip', 2);
});

test('ordinary session draws and merges resume their normal rules when teaching is disabled', () => {
  const results = [];
  for (const roll of [0, .999999]) {
    const s = new BattleSession({ environment: 'test', rng: () => roll });
    expectStep(s, 'done'); s.weapons.draw(); s.weapons.draw();
    results.push(s.weapons.merge(0, 1).weaponId);
    assert.equal(s.weapons.draw().ok, true, 'the third paid draw is available outside teaching');
  }
  assert.notEqual(results[0], results[1], 'normal C merges still sample the catalog pool');
});

test('new production saves teach while saves without a tutorial block are rejected without rewriting', t => {
  t.mock.method(console, 'warn', () => {});
  const freshStore = storage(), fresh = new BattleSession({ storage: freshStore });
  expectStep(fresh, 'upgrade'); assert.deepEqual(saved(freshStore).tutorial, { step: 'upgrade', drawCount: 0 });
  const { store, session, make } = fixture(save => {
    delete save.tutorial; save.money = OriginalInfVal.fromAmount(D.from('234.56')).toJSON(); save.weapons.diamonds = 47; save.speedRun.stage = 1;
    save.levels = [3, 2, 1]; save.progress = { stageIndex: 2, waveIndex: 3 };
  });
  const raw = store.getItem(KEY), writes = store.writes.length;
  assert.equal(session.persistenceBlocked, true);
  assert.deepEqual(saved(store).levels, [3, 2, 1]); assert.deepEqual(saved(store).progress, { stageIndex: 2, waveIndex: 3 });
  assert.equal(make().persistenceBlocked, true);
  assert.equal(store.getItem(KEY), raw); assert.equal(store.writes.length, writes);
});

test('a damaged tutorial block cannot be rewritten over the original wallet, weapons or stage', t => {
  t.mock.method(console, 'warn', () => {});
  for (const tutorial of [null, {}, { step: 'unknown' }, { step: 5 }, { step: 'gunBuy', drawCount: -1 }]) {
    const { store, session, make } = fixture(save => {
      save.tutorial = tutorial; save.money = OriginalInfVal.fromAmount(D.from('12345.67')).toJSON(); save.weapons.diamonds = 37; save.weapons.starGems = 9; save.speedRun.stage = 1;
      save.levels = [3, 2, 1]; save.progress = { stageIndex: 2, waveIndex: 4 }; save.weapons.stageValueMax = 24;
      save.weapons.backpack[0] = { weaponId: 0, locked: false, pendingAd: false };
    });
    const raw = store.getItem(KEY), writes = store.writes.length;
    assert.equal(session.persistenceBlocked, true);
    assert.equal(D.from(saved(store).money).toString(), '12345.67');
    assert.equal(saved(store).weapons.diamonds, 37); assert.equal(saved(store).weapons.starGems, 9);
    assert.equal(saved(store).weapons.backpack[0].weaponId, 0); assert.equal(saved(store).weapons.stageValueMax, 24);
    assert.deepEqual(saved(store).levels, [3, 2, 1]); assert.deepEqual(saved(store).progress, { stageIndex: 2, waveIndex: 4 });
    assert.equal(make().persistenceBlocked, true);
    assert.equal(store.getItem(KEY), raw); assert.equal(store.writes.length, writes);
  }
});

test('ordinary test environment skips teaching across saves and rebirth', () => {
  const store = storage(), session = new BattleSession({ environment: 'test', storage: store });
  expectStep(session, 'done'); session.onWeaponPanelOpened(); expectStep(session, 'done');
  assert.equal(session.weapons.diamonds, 2000000);
  assert.equal(session.requestRebirth('normal').ok, true); session.advanceRebirth(2); expectStep(session, 'done');
  expectStep(new BattleSession({ environment: 'test', storage: store }), 'done');
});
