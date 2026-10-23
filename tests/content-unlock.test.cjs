const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { ContentUnlockManager } = require('./.build/session/session/ContentUnlockManager.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { remainingRebirthUpgradeBudget } = require('./.build/session/session/RebirthEconomy.js');

function storage() {
  const data = new Map(); let writes = 0;
  return { data, get writes() { return writes; }, getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { writes++; data.set(key, value); } };
}
function seedProduction(edit = () => {}) {
  const store = storage(); new BattleSession({ storage: store });
  const saved = JSON.parse(store.getItem(economyStorageKey('production')));
  edit(saved); store.setItem(economyStorageKey('production'), JSON.stringify(saved));
  return { store, session: new BattleSession({ storage: store, rng: () => 0 }) };
}
function winChallenge(session) {
  assert.equal(session.startSpeedRun().ok, true); session.advanceFrame(1.5);
  session.consume([{ type: 'complete', position: { x: 0, z: 0 } }], [{ id: 0, alive: false, reward: D.from(0) }]);
}

test('skins require tutorial completion even with high progression or a test bypass', () => {
  for (const environment of ['production', 'test']) {
    const manager = new ContentUnlockManager(resolveContentConfig(environment, { tutorialEnabled: true }), () => ({
      stageValueMax: 9999, powerLevel: 999, challengeWins: 999, challengeUnlocked: true, weaponsUnlocked: true,
    }));
    assert.deepEqual(manager.get('skins'), { visible: false, unlocked: false, reason: 'tutorial', message: '完成新手引导后开放皮肤。' });
    assert.deepEqual(manager.get('skins', { tutorialCompleted: true }), { visible: true, unlocked: true });
    const noTutorial = new ContentUnlockManager(resolveContentConfig(environment, { tutorialEnabled: false }), () => ({ challengeWins: 1 }));
    assert.deepEqual(noTutorial.get('skins'), { visible: true, unlocked: true });
  }
  assert.equal(new ContentUnlockManager(resolveContentConfig('test')).isUnlocked('skins'), true);
});

test('skin, rebirth and daily check entries require both teaching and a challenge victory independently of stage progress', () => {
  const manager = new ContentUnlockManager(resolveContentConfig('production'));
  for (const tutorialCompleted of [false, true]) for (const challengeWins of [0, 1]) {
    for (const id of ['skins', 'rebirth', 'dailyCheck']) {
      const state = manager.get(id, { tutorialCompleted, challengeWins, stageValueMax: 9999 });
      assert.equal(state.visible, tutorialCompleted && challengeWins === 1, `${id}: ${tutorialCompleted}/${challengeWins}`);
      assert.equal(state.unlocked, state.visible);
      if (!state.visible) assert.equal(state.reason, tutorialCompleted ? 'challenge' : 'tutorial');
    }
  }
  assert.deepEqual(manager.get('rebirth', { tutorialCompleted: true, challengeWins: 1 }), {
    visible: true, unlocked: false, reason: 'stage', requiredStage: 3, message: '第3关起可用。',
  });
  const twoWins = new ContentUnlockManager(resolveContentConfig('production', { tutorialEnabled: false,
    thresholds: { rebirthSkinChallengeWins: 2 } }));
  for (const id of ['skins', 'rebirth', 'dailyCheck']) {
    assert.equal(twoWins.get(id, { challengeWins: 1, stageValueMax: 20 }).reason, 'challenge');
    assert.equal(twoWins.get(id, { challengeWins: 2, stageValueMax: 20 }).unlocked, true);
    const preview = new ContentUnlockManager(resolveContentConfig('test', { bypassProgression: false, tutorialEnabled: true }));
    assert.equal(preview.get(id, { tutorialCompleted: true }).visible, false);
  }
});

test('a challenge won before teaching completes is remembered but reveals the three entries only after teaching finishes', () => {
  const { session, store } = seedProduction(save => { save.levels = [3, 0, 0]; });
  winChallenge(session);
  assert.equal(session.exitSpeedRun().ok, true); session.advanceFrame(1.5);
  const reloaded = new BattleSession({ storage: store, rng: () => 0 });
  for (const id of ['skins', 'rebirth', 'dailyCheck']) assert.equal(reloaded.getContentState(id).visible, false);
  reloaded.onWeaponPanelOpened();
  assert.equal(reloaded.weapons.draw().ok, true); assert.equal(reloaded.weapons.draw().ok, true);
  assert.equal(reloaded.weapons.merge(0, 1).ok, true); assert.equal(reloaded.weapons.equip(1, 1).ok, true);
  for (const current of [reloaded, new BattleSession({ storage: store })]) {
    for (const id of ['skins', 'rebirth', 'dailyCheck']) assert.equal(current.getContentState(id).visible, true);
  }
});

test('production thresholds use displayed stages and ads override both environment unlock policies', () => {
  const config = resolveContentConfig('production', { adsEnabled: true });
  const manager = new ContentUnlockManager(config, () => ({ tutorialCompleted: true, challengeWins: 1 }));
  for (const [id, before, after] of [['rebirth', 19, 20], ['dailyAdWeapon', 29, 30],
    ['autoMerge', 189, 190], ['weaponLock', 389, 390], ['weaponStar', 389, 390]]) {
    assert.equal(manager.isUnlocked(id, { stageValueMax: before }), false, id);
    assert.equal(manager.isUnlocked(id, { stageValueMax: after }), true, id);
  }
  assert.equal(manager.isUnlocked('rebirthAction', { currentStageIndex: 1 }), false);
  assert.equal(manager.isUnlocked('rebirthAction', { currentStageIndex: 2 }), true);
  for (const environment of ['production', 'test']) {
    const closed = new ContentUnlockManager(resolveContentConfig(environment, { adsEnabled: false }), () => ({ stageValueMax: 999 }));
    for (const id of ['dailyAdWeapon', 'adWeapon', 'rebirthAd', 'speedrunAd']) {
      assert.equal(closed.get(id).visible, false); assert.equal(closed.get(id).reason, 'adsDisabled');
    }
  }
  const partial = new ContentUnlockManager(resolveContentConfig('test', { adsEnabled: true, adPlacements: { rebirth: false } }));
  assert.equal(partial.isUnlocked('dailyAdWeapon'), true); assert.equal(partial.isUnlocked('rebirthAd'), false);
  assert.equal(resolveContentConfig('production', { bypassProgression: true }).bypassProgression, false);
  assert.throws(() => new BattleSession({ contentConfig: resolveContentConfig('test') }), /mismatch/);
});

test('new production unlocks weapons with challenges at Lv3 and persists the first panel top-up once', () => {
  const { session, store } = seedProduction(save => { save.money = D.from(1000); });
  assert.equal(session.getSpeedRunState().unlocked, false);
  assert.equal(session.startSpeedRun().reason, 'locked');
  assert.equal(session.weapons.snapshot().unlocked, false);
  assert.equal(session.weapons.draw().reason, 'weaponsLocked');
  for (let i = 0; i < 2; i++) assert.equal(session.purchase('power'), true);
  assert.equal(session.getSpeedRunState().unlocked, false);
  assert.equal(session.getContentState('weapons').visible, false);
  assert.equal(session.getContentState('speedrun').visible, false);
  assert.equal(session.purchase('power'), true);
  assert.equal(session.getSpeedRunState().unlocked, true);
  assert.equal(session.getContentState('weapons').visible, true);
  assert.equal(session.getContentState('speedrun').visible, true);
  assert.equal(session.weapons.snapshot().unlocked, true);
  assert.equal(session.weapons.diamonds, 0);
  assert.equal(session.getTutorialState().step, 'gunOpen');
  assert.equal(JSON.parse(store.getItem(economyStorageKey('production'))).content.firstDrawGranted, false);
  const beforeOpen = store.writes;
  session.onWeaponPanelOpened();
  assert.equal(store.writes - beforeOpen, 1, 'panel progression and draw grant persist atomically');
  assert.equal(session.weapons.diamonds, 200);
  const firstVisit = JSON.parse(store.getItem(economyStorageKey('production')));
  assert.equal(firstVisit.content.firstDrawGranted, true);
  assert.equal(firstVisit.tutorial.step, 'gunBuy');
  assert.equal(session.weapons.draw().ok, true); assert.equal(session.weapons.diamonds, 100);
  const reload = new BattleSession({ storage: store });
  assert.equal(reload.weapons.diamonds, 100);
  reload.onWeaponPanelOpened(); assert.equal(reload.weapons.diamonds, 100, 'reload/reopen does not repeat the grant');
  assert.equal(reload.weapons.draw().ok, true); assert.equal(reload.weapons.diamonds, 0);
  winChallenge(reload); assert.equal(reload.weapons.diamonds, 60);
  assert.equal(JSON.parse(store.getItem(economyStorageKey('production'))).content.firstDrawGranted, true);
});

test('first draw top-up preserves larger wallets and unlocked content survives rebirth after a challenge win', () => {
  const { session, store } = seedProduction(save => {
    save.levels = [3, 0, 0]; save.weapons.diamonds = 500;
    save.tutorial = { step: 'done', drawCount: 2 }; save.speedRun.stage = 1;
    save.weapons.stageValueMax = 20; save.progress = { stageIndex: 2, waveIndex: 0 };
  });
  session.onWeaponPanelOpened();
  assert.equal(session.weapons.diamonds, 500, 'the first visit does not reduce an existing larger wallet');
  assert.equal(JSON.parse(store.getItem(economyStorageKey('production'))).content.firstDrawGranted, true);
  assert.equal(session.requestRebirth('normal').ok, true);
  session.advanceRebirth(2);
  assert.equal(session.moneyBalance.toString(), '0');
  const reload = new BattleSession({ storage: store });
  assert.equal(reload.getSpeedRunState().unlocked, true);
  assert.equal(reload.weapons.snapshot().unlocked, true);
  assert.equal(reload.weapons.diamonds, 500);
  assert.equal(reload.round.stageIndex, 0);
  assert.equal(reload.requestRebirth('normal').reason, 'locked', 'production action still needs current stage 3');
});

test('a challenge before first opening supplies only the difference to 200 and cannot grant inside challenge mode', () => {
  const { session, store } = seedProduction(save => { save.levels = [3, 0, 0]; });
  const before = store.writes; winChallenge(session);
  assert.equal(store.writes - before, 1); assert.equal(session.weapons.diamonds, 60);
  session.onWeaponPanelOpened(); assert.equal(session.weapons.diamonds, 60);
  assert.equal(JSON.parse(store.getItem(economyStorageKey('production'))).content.firstDrawGranted, false);
  assert.equal(session.exitSpeedRun().ok, true); session.advanceFrame(1.5);
  session.onWeaponPanelOpened(); assert.equal(session.weapons.diamonds, 200);
  session.onWeaponPanelOpened(); assert.equal(session.weapons.diamonds, 200);
});

test('both content entries share the configured power threshold and either permanent entitlement', () => {
  const manager = new ContentUnlockManager(resolveContentConfig('production', { thresholds: { challengePowerLevel: 5 } }));
  for (const [powerLevel, expected] of [[3, false], [4, false], [5, true]]) {
    for (const id of ['weapons', 'speedrun']) {
      const state = manager.get(id, { powerLevel, challengeWins: 99 });
      assert.equal(state.unlocked, expected); assert.equal(state.visible, expected);
      if (!expected) assert.match(state.message, /Lv\.5/);
    }
  }
  for (const flag of ['challengeUnlocked', 'weaponsUnlocked']) {
    for (const id of ['weapons', 'speedrun']) assert.equal(manager.get(id, { [flag]: true }).unlocked, true);
    const { session, store } = seedProduction(save => {
      save.content = { challengeUnlocked: false, weaponsUnlocked: false, firstDrawGranted: false, [flag]: true };
    });
    for (const id of ['weapons', 'speedrun']) assert.equal(session.getContentState(id).unlocked, true);
    const recorded = JSON.parse(store.getItem(economyStorageKey('production'))).content;
    assert.equal(recorded.challengeUnlocked, true); assert.equal(recorded.weaponsUnlocked, true);
    const reloaded = new BattleSession({ storage: store });
    assert.equal(reloaded.getContentState('weapons').unlocked, true); assert.equal(reloaded.getContentState('speedrun').unlocked, true);
  }
});

test('legacy v3 entries remain open without another grant and retired auto entitlement is discarded', () => {
  const { session, store } = seedProduction(save => {
    delete save.content; save.weapons.diamonds = 7; save.weapons.autoExpiresAt = Number.MAX_SAFE_INTEGER;
  });
  assert.equal(session.getSpeedRunState().unlocked, true);
  assert.equal(session.weapons.snapshot().unlocked, true);
  assert.equal(session.weapons.diamonds, 7);
  assert.equal(session.weapons.snapshot().auto.unlocked, false, 'old entitlement cannot bypass stage 20');
  const saved = JSON.parse(store.getItem(economyStorageKey('production')));
  assert.equal('autoExpiresAt' in saved.weapons, false);
  assert.deepEqual(saved.content, { challengeUnlocked: true, weaponsUnlocked: true, firstDrawGranted: true });
});

test('test environment opens non-ad content at stage 1 with resources but no free guns or altered history', () => {
  const store = storage(), session = new BattleSession({ environment: 'test', storage: store });
  for (const id of ['weapons', 'speedrun', 'autoMerge', 'weaponLock', 'weaponStar', 'rebirth', 'rebirthAction'])
    assert.equal(session.getContentState(id).unlocked, true, id);
  const weapons = session.weapons.snapshot(), rebirth = session.getRebirthState();
  assert.equal(weapons.diamonds, 2000000); assert.equal(weapons.starGems, 1000000);
  assert.equal(weapons.stageValueMax, 0); assert.equal(weapons.backpack.filter(Boolean).length, 0);
  assert.equal(weapons.equipment.filter(Boolean).length, 1); assert.equal(weapons.collection.filter(Boolean).length, 1);
  assert.equal(rebirth.ruby.compare(remainingRebirthUpgradeBudget([0, 0, 0])), 0);
  assert.equal(rebirth.reward.toString(), '316.22');
  assert.equal(session.requestRebirth('normal').ok, true);
  assert.equal(session.refillTestResources(), false, 'cannot refill during rebirth settlement');
  session.advanceRebirth(2); assert.equal(session.moneyBalance.toString(), '0');
  const reload = new BattleSession({ environment: 'test', storage: store });
  assert.equal(reload.moneyBalance.toString(), '0', 'reload preserves rebirth reset');
  reload.weapons.configureTest({ diamonds: 1, starGems: 2 });
  reload.configureRebirthTest({ ruby: '0', levels: [2, 3, 4] });
  assert.equal(reload.refillTestResources(), true);
  assert.equal(reload.weapons.diamonds, 2000000);
  assert.equal(reload.getRebirthState().ruby.compare(remainingRebirthUpgradeBudget([2, 3, 4])), 0);
  assert.equal(reload.moneyBalance.compare(0), 1);
  assert.equal(new BattleSession().refillTestResources(), false);
});

test('changing the centralized config changes gates and test funding without rewriting module rules', () => {
  const config = resolveContentConfig('test', { bypassProgression: false, thresholds: { rebirthStage: 5, rebirthActionStage: 5,
    autoMergeStage: 6, weaponLockStage: 7, weaponStarStage: 8, rebirthSkinChallengeWins: 0 },
    testResources: { diamonds: 500, starGems: 300, fundGoldUpgrades: false, fundRebirthUpgrades: false } });
  const session = new BattleSession({ environment: 'test', contentConfig: config });
  assert.equal(session.weapons.diamonds, 500); assert.equal(session.weapons.starGems, 300);
  assert.equal(session.moneyBalance.toString(), '0'); assert.equal(session.getRebirthState().ruby.toString(), '0');
  session.configureProgressionTest({ stageIndex: 3, stageValueMax: 39 });
  assert.equal(session.getRebirthState().unlocked, false);
  assert.match(session.getRebirthState().unlockMessage, /5/);
  session.configureProgressionTest({ stageIndex: 4, stageValueMax: 40 });
  assert.equal(session.getRebirthState().canRebirth, true);
  assert.equal(session.getContentState('autoMerge').unlocked, false);
});


test('upcoming panels require a visible locked entry or the final pre-unlock challenge without granting access',()=>{
  const progress={stageValueMax:0,tutorialCompleted:false,challengeWins:0};
  const manager=new ContentUnlockManager(resolveContentConfig('production'),()=>progress);
  for(const name of ['mine','fish','hunt','pets','boss','raid','skins','rebirth','dailyCheck'])assert.equal(manager.isUpcoming(name,true),false,name);
  progress.tutorialCompleted=true;
  for(const name of ['skins','rebirth','dailyCheck']){
    assert.equal(manager.isUpcoming(name,false),false);assert.equal(manager.isUpcoming(name,true),true);
    assert.equal(manager.get(name).visible,false);assert.equal(manager.get(name).unlocked,false);
  }
  progress.stageValueMax=20;assert.equal(manager.isUpcoming('mine',false),true);assert.equal(manager.get('mine').unlocked,false);
  assert.equal(manager.isUpcoming('raid',true),false);
  progress.stageValueMax=30;assert.equal(manager.get('mine').unlocked,true);assert.equal(manager.isUpcoming('mine',false),false);
  progress.challengeWins=1;assert.equal(manager.get('skins').unlocked,true);assert.equal(manager.isUpcoming('skins',true),false);
});
