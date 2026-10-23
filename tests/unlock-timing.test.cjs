const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { ContentUnlockManager } = require('./.build/session/session/ContentUnlockManager.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');

function fixture(history, { done = true, autoEnabled = false, overrides = {} } = {}) {
  const data = new Map(); let writes = 0;
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { writes++; data.set(k, v); } };
  const contentConfig = resolveContentConfig('production', overrides), key = economyStorageKey('production');
  const restore = () => new BattleSession({ storage, contentConfig, rng: () => 0, now: () => new Date(2026, 9, 15, 12).getTime() });
  restore();
  const saved = JSON.parse(storage.getItem(key));
  saved.progress = { stageIndex: Math.floor(history / 10), waveIndex: Math.min(4, history % 10) };
  saved.weapons.stageValueMax = history; saved.weapons.diamonds = 0;
  saved.content = { challengeUnlocked: true, weaponsUnlocked: true, firstDrawGranted: true };
  saved.tutorial = { step: done ? 'done' : 'gunOpen', drawCount: 0 };
  saved.speedRun.stage = 1;
  saved.fish = { inventory: [0, 0, 1], collected: Array(13).fill(false), autoEnabled, freeDrawDate: '', freeDrawCount: 0 };
  saved.pets = { owned: [0, 0, 1, ...Array(13).fill(-1)], selected: [-1, -1, -1], collected: Array(10).fill(false),
    coins: 0, autoEnabled, lastDailyAdDate: '', dailyAdCount: 0 };
  storage.setItem(key, JSON.stringify(saved));
  const session = restore(); writes = 0;
  return { session, restore, storage, key, get writes() { return writes; } };
}

test('fish and pet Auto stay unavailable below history 190, including previously enabled saves', () => {
  for (const history of [50, 110, 184, 189]) {
    const f = fixture(history, { autoEnabled: true }), s = f.session, before = f.storage.getItem(f.key);
    for (const state of [s.getFishState(), s.getPetState()]) {
      assert.equal(state.autoAvailable, false); assert.equal(state.autoPair, null);
      assert.equal(state.autoEnabled, true, 'retain the saved preference without running it');
    }
    assert.equal(s.setFishAutoMerge(true).reason, 'contentLocked');
    assert.equal(s.setPetAutoMerge(true).reason, 'contentLocked');
    assert.equal(s.mergeFish(0, 1, 0, true).reason, 'contentLocked');
    assert.equal(s.mergePets(0, 1, 0, true).reason, 'contentLocked');
    assert.equal(f.storage.getItem(f.key), before); assert.equal(f.writes, 0);
    assert.equal(f.restore().getFishState().autoAvailable, false);
    assert.equal(f.restore().getPetState().autoPair, null);
  }
});

test('manual fish/pet merging and disabling a saved Auto preference still work below stage 20', () => {
  const fish = fixture(50, { autoEnabled: true }).session;
  assert.equal(fish.setFishAutoMerge(false).ok, true);
  assert.equal(fish.mergeFish(0, 1, 0, false).ok, true);
  assert.deepEqual(fish.getFishState().inventory, [1, 1]);
  const pet = fixture(110, { autoEnabled: true }).session;
  assert.equal(pet.setPetAutoMerge(false).ok, true);
  assert.equal(pet.mergePets(0, 1, 0, false).ok, true);
  assert.equal(pet.getPetState().owned.filter(x => x >= 0).length, 2);
});

test('stage 20 enables fish/pet Auto for free, and retained history keeps it open after rebirth/reload', () => {
  const f = fixture(190), s = f.session;
  assert.equal(s.getFishState().autoAvailable, true); assert.equal(s.getPetState().autoAvailable, true);
  assert.equal(s.setFishAutoMerge(true).ok, true); assert.equal(s.setPetAutoMerge(true).ok, true);
  assert.ok(s.getFishState().autoPair); assert.ok(s.getPetState().autoPair);
  assert.equal(s.mergeFish(0, 1, 0, true).ok, true); assert.equal(s.mergePets(0, 1, 0, true).ok, true);
  assert.equal(s.weapons.diamonds, 0); assert.equal(s.getPetState().coins, 0);
  assert.equal(s.requestRebirth('normal').ok, true); s.advanceRebirth(2);
  const restored = f.restore(); assert.equal(restored.round.stageIndex, 0);
  assert.equal(restored.getFishState().autoAvailable, true); assert.equal(restored.getPetState().autoAvailable, true);
  assert.equal(restored.getFishState().autoEnabled, true); assert.equal(restored.getPetState().autoEnabled, true);
  for (const id of ['dailyAdWeapon', 'adWeapon', 'rebirthAd', 'speedrunAd', 'bossAd', 'raidAd', 'fishDailyAd', 'petDailyAd', 'huntAd', 'mineEntryAd', 'mineRewardAd']) {
    assert.equal(restored.getContentState(id).reason, 'adsDisabled', id);
  }
});

test('all three Auto systems follow the shared configured threshold and normal test bypass', () => {
  for (const [history, expected] of [[190, false], [239, false], [240, true]]) {
    const s = fixture(history, { overrides: { thresholds: { autoMergeStage: 25 } } }).session;
    assert.equal(s.getContentState('autoMerge').unlocked, expected);
    assert.equal(s.getFishState().autoAvailable, expected); assert.equal(s.getPetState().autoAvailable, expected);
    assert.equal(s.setFishAutoMerge(true).ok, expected); assert.equal(s.setPetAutoMerge(true).ok, expected);
  }
  const testSession = new BattleSession({ environment: 'test' });
  assert.equal(testSession.getFishState().autoAvailable, true); assert.equal(testSession.getPetState().autoAvailable, true);
  const teaching = new BattleSession({ environment: 'test', contentConfig: resolveContentConfig('test', { tutorialEnabled: true }) });
  assert.equal(teaching.getFishState().autoAvailable, false); assert.equal(teaching.getPetState().autoAvailable, false);
});

test('Boss/Raid teaching gates precede test bypass and preserve the original visibility/unlock boundaries', () => {
  for (const environment of ['production', 'test']) {
    const p = { stageValueMax: 10000, tutorialCompleted: false };
    const policy = new ContentUnlockManager(resolveContentConfig(environment, { tutorialEnabled: true, adsEnabled: true }), () => p);
    for (const id of ['boss', 'raid', 'bossAd', 'raidAd']) {
      assert.equal(policy.get(id).visible, false, id); assert.equal(policy.get(id).unlocked, false, id);
      assert.equal(policy.get(id).reason, 'tutorial', id);
    }
    p.tutorialCompleted = true;
    for (const id of ['boss', 'raid']) assert.equal(policy.get(id).unlocked, true, id);
  }
  const policy = new ContentUnlockManager(resolveContentConfig('production'), () => ({ tutorialCompleted: true }));
  for (const [id, entries] of [
    ['boss', [[49,false,false],[50,true,false],[89,true,false],[90,true,true]]],
    ['raid', [[339,false,false],[340,true,false],[389,true,false],[390,true,true]]],
  ]) for (const [stageValueMax, visible, unlocked] of entries) {
    const state = policy.get(id, { stageValueMax });
    assert.equal(state.visible, visible); assert.equal(state.unlocked, unlocked);
  }
});

test('direct Boss/Raid commands stay locked until actual equipment teaching completes', () => {
  for (const id of ['boss', 'raid']) {
    const f = fixture(390, { done: false }), s = f.session;
    const before = f.storage.getItem(f.key);
    assert.equal(s.startBoss().reason, 'locked'); assert.equal(s.openRaid().reason, 'locked');
    assert.equal(s.startRaid().ok, false); assert.equal(s.mode, 'Main');
    assert.equal(f.storage.getItem(f.key), before, 'locked commands must preserve progression and entry resources');
    s.onWeaponPanelOpened(); assert.equal(s.getTutorialState().step, 'gunBuy');
    s.weapons.grantDiamonds(200); assert.equal(s.weapons.draw().ok, true);
    assert.equal(s.weapons.draw().ok, true); assert.equal(s.weapons.merge(0, 1).weaponId, 3);
    assert.equal(s.weapons.equip(1, 1).ok, true); assert.equal(s.getTutorialState().step, 'done');
    const restored = f.restore();
    assert.equal(restored.getContentState(id).visible, true); assert.equal(restored.getContentState(id).unlocked, true);
    if (id === 'boss') assert.equal(restored.startBoss().ok, true);
    else { assert.equal(restored.openRaid().ok, true); assert.equal(restored.startRaid().ok, true); }
  }
});
