const test = require('node:test');
const assert = require('node:assert/strict');
const { TutorialPreviewController, TUTORIAL_PREVIEW_FLAG: FLAG, TUTORIAL_PREVIEW_SUFFIX: SUFFIX } =
  require('./.build/session/session/TutorialPreview.js');
const { BattleSession } = require('./.build/session/session/BattleSession.js');

const KEY = 'forest-gunner:economy:v3:test';
const PREVIEW_KEY = KEY + SUFFIX;
function storage(entries = []) {
  const data = new Map(entries), calls = [];
  return { data, calls,
    getItem(key) { calls.push(['get', key]); return data.get(key) ?? null; },
    setItem(key, value) { calls.push(['set', key, value]); data.set(key, value); },
    removeItem(key) { calls.push(['remove', key]); data.delete(key); },
  };
}

test('ordinary test startup preserves original storage and default content configuration', () => {
  const store = storage([[KEY, 'normal-save']]);
  const controller = new TutorialPreviewController('test', store, KEY);
  assert.equal(controller.active, false);
  assert.equal(controller.storage, store);
  assert.equal(controller.contentConfig, undefined);
  assert.equal(controller.storage.getItem(KEY), 'normal-save');
  assert.deepEqual(store.calls.filter(call => call[0] !== 'get'), []);
});

test('replay request waits for restart before clearing preview and never clears the normal save', () => {
  const store = storage([[KEY, 'normal-save'], [PREVIEW_KEY, 'old-preview']]);
  const running = new TutorialPreviewController('test', store, KEY);
  assert.equal(running.requestReplay(), true);
  assert.equal(store.getItem(FLAG), 'reset');
  assert.equal(store.getItem(PREVIEW_KEY), 'old-preview');
  assert.equal(running.active, false);
  assert.equal(running.storage, store);
  running.storage.setItem(KEY, 'normal-on-destroy');
  const restarted = new TutorialPreviewController('test', store, KEY);
  assert.equal(restarted.active, true);
  assert.equal(store.getItem(FLAG), 'active');
  assert.equal(store.getItem(KEY), 'normal-on-destroy');
  assert.equal(restarted.storage.getItem(KEY), null);
  restarted.storage.setItem(KEY, 'new-preview');
  assert.equal(store.getItem(PREVIEW_KEY), 'new-preview');
  assert.equal(store.getItem(KEY), 'normal-on-destroy');
});

test('restarting an active replay clears after old preview teardown has saved', () => {
  const store = storage([[KEY, 'normal-save'], [PREVIEW_KEY, 'preview-progress'], [FLAG, 'active']]);
  const running = new TutorialPreviewController('test', store, KEY);
  assert.equal(running.requestReplay(), true);
  assert.equal(store.getItem(PREVIEW_KEY), 'preview-progress');
  running.storage.setItem(KEY, 'preview-on-destroy');
  const restarted = new TutorialPreviewController('test', store, KEY);
  assert.equal(restarted.storage.getItem(KEY), null);
  assert.equal(store.getItem(KEY), 'normal-save');
  const resetIndex = store.calls.findIndex(call => call[0] === 'remove' && call[1] === PREVIEW_KEY);
  const teardownIndex = store.calls.findIndex(call => call[0] === 'set' && call[2] === 'preview-on-destroy');
  assert.ok(resetIndex > teardownIndex);
});

test('ordinary reload resumes preview progress and maps only the supplied economy key', () => {
  const store = storage([[KEY, 'normal-save'], [PREVIEW_KEY, 'preview-progress'], [FLAG, 'active'], ['other', 'setting']]);
  const controller = new TutorialPreviewController('test', store, KEY);
  assert.equal(controller.active, true);
  assert.equal(controller.storage.getItem(KEY), 'preview-progress');
  assert.equal(controller.storage.getItem('other'), 'setting');
  controller.storage.setItem('other', 'new-setting');
  assert.equal(store.getItem('other'), 'new-setting');
  assert.equal(store.getItem(KEY), 'normal-save');
  assert.equal(store.calls.some(call => call[0] === 'remove'), false);
});

test('exit keeps teardown isolated and returns to the intact normal save on restart', () => {
  const store = storage([[KEY, 'normal-save'], [PREVIEW_KEY, 'preview-progress'], [FLAG, 'active']]);
  const running = new TutorialPreviewController('test', store, KEY);
  assert.equal(running.requestExit(), true);
  assert.equal(store.getItem(FLAG), null);
  assert.equal(running.active, true, 'running mode does not change until restart');
  running.storage.setItem(KEY, 'preview-on-destroy');
  const restarted = new TutorialPreviewController('test', store, KEY);
  assert.equal(restarted.active, false);
  assert.equal(restarted.storage, store);
  assert.equal(restarted.storage.getItem(KEY), 'normal-save');
  assert.equal(store.getItem(PREVIEW_KEY), 'preview-on-destroy');
});

test('production never reads or changes preview flags and rejects both requests', () => {
  for (const flag of ['active', 'reset']) {
    const productionKey = 'forest-gunner:economy:v3:production';
    const store = storage([[FLAG, flag], [productionKey, 'production-save'], [PREVIEW_KEY, 'preview-progress']]);
    const controller = new TutorialPreviewController('production', store, productionKey);
    assert.equal(controller.active, false);
    assert.equal(controller.storage, store);
    assert.equal(controller.contentConfig, undefined);
    assert.equal(controller.requestReplay(), false);
    assert.equal(controller.requestExit(), false);
    assert.deepEqual(store.calls, []);
    assert.equal(store.data.get(FLAG), flag);
    assert.equal(store.data.get(productionKey), 'production-save');
    assert.equal(store.data.get(PREVIEW_KEY), 'preview-progress');
  }
});

test('preview uses the real tutorial and progression without startup test resources', () => {
  const controller = new TutorialPreviewController('test', storage([[FLAG, 'active']]), KEY);
  const config = controller.contentConfig;
  assert.equal(config.environment, 'test');
  assert.equal(config.tutorialEnabled, true);
  assert.equal(config.bypassProgression, false);
  assert.equal(config.testResources.diamonds, 0);
  assert.equal(config.testResources.starGems, 0);
  assert.equal(config.testResources.adventureTickets, 0);
  assert.equal(config.testResources.adventureCores, 0);
  assert.equal(config.testResources.fundGoldUpgrades, false);
  assert.equal(config.testResources.fundRebirthUpgrades, false);
  assert.equal(config.thresholds.challengePowerLevel, 3);
  assert.equal('weaponsChallengeWins' in config.thresholds, false);
  assert.equal(config.firstDrawDiamonds, 200);
});

test('a new preview session starts with zero currency and saves only in its isolated slot', () => {
  const store = storage([[KEY, 'normal-save'], [FLAG, 'reset']]);
  const controller = new TutorialPreviewController('test', store, KEY);
  const session = new BattleSession({ environment: 'test', storage: controller.storage, contentConfig: controller.contentConfig });
  assert.equal(session.moneyBalance.toString(), '0');
  assert.equal(session.weapons.diamonds, 0);
  assert.equal(session.weapons.starGems, 0);
  assert.equal(session.getRebirthState().ruby.toString(), '0');
  assert.equal(session.getAdventureState().tickets, 20);
  assert.deepEqual(session.getAdventureState().cores, [0, 0, 0, 0]);
  assert.deepEqual(session.getTutorialState(), { active: true, step: 'upgrade', drawCount: 0 });
  assert.deepEqual(session.getContentState('skins'), { visible: false, unlocked: false, reason: 'tutorial', message: '完成新手引导后开放皮肤。' });
  assert.equal(session.purchaseSkin(1).reason, 'contentLocked');
  assert.equal(session.equipSkin(0).reason, 'contentLocked');
  assert.equal(session.getSpeedRunState().unlocked, false);
  assert.equal(session.weapons.snapshot().unlocked, false);
  assert.equal(store.getItem(KEY), 'normal-save');
  assert.equal(JSON.parse(store.getItem(PREVIEW_KEY)).tutorial.step, 'upgrade');
});

test('replay completes two draws and the fixed merge across reloads without affecting the normal save', () => {
  const store = storage([[KEY, 'normal-save'], [FLAG, 'reset']]);
  function reload() {
    const controller = new TutorialPreviewController('test', store, KEY);
    return new BattleSession({ environment: 'test', storage: controller.storage, contentConfig: controller.contentConfig, rng: () => .999999 });
  }
  let session = reload();
  const seeded = JSON.parse(store.getItem(PREVIEW_KEY));
  seeded.money = { digits: '1000', exponent: 0, precision: 4 };
  store.setItem(PREVIEW_KEY, JSON.stringify(seeded)); session = reload();
  for (let n = 0; n < 3; n++) assert.equal(session.purchase('power'), true);
  assert.equal(session.getTutorialState().step, 'gunOpen');
  session.onWeaponPanelOpened(); assert.equal(session.weapons.diamonds, 200);
  assert.equal(session.weapons.draw().ok, true); session = reload(); session.onWeaponPanelOpened();
  assert.deepEqual(session.getTutorialState(), { active: true, step: 'gunBuy', drawCount: 1 });
  assert.equal(session.weapons.diamonds, 100);
  assert.equal(session.weapons.draw().ok, true); session = reload(); session.onWeaponPanelOpened();
  assert.deepEqual(session.getTutorialState(), { active: true, step: 'gunMerge', drawCount: 2 });
  assert.equal(session.weapons.diamonds, 0);
  assert.equal(session.weapons.merge(0, 1).weaponId, 3); session = reload(); session.onWeaponPanelOpened();
  assert.equal(session.getTutorialState().step, 'gunEquip'); assert.equal(session.weapons.diamonds, 0);
  assert.equal(session.weapons.equip(1, 1).ok, true); session = reload();
  assert.deepEqual(session.getTutorialState(), { active: false, step: 'done', drawCount: 2 });
  assert.equal(session.weapons.snapshot().equipment[1].weaponId, 3);
  assert.equal(store.getItem(KEY), 'normal-save');
});

test('unknown flag is inert and failed storage requests do not switch the running mode', () => {
  const store = storage([[FLAG, 'unknown'], [KEY, 'normal-save']]);
  const controller = new TutorialPreviewController('test', store, KEY);
  assert.equal(controller.active, false);
  assert.equal(controller.storage, store);
  store.setItem = () => { throw new Error('unavailable'); };
  store.removeItem = () => { throw new Error('unavailable'); };
  assert.equal(controller.requestReplay(), false);
  assert.equal(controller.requestExit(), false);
  assert.equal(controller.active, false);
  assert.equal(store.data.get(KEY), 'normal-save');
});

test('unavailable storage or failed preview reset falls back without altering the normal save', () => {
  const unreadable = storage([[KEY, 'normal-save']]);
  unreadable.getItem = () => { throw new Error('storage disabled'); };
  const fallback = new TutorialPreviewController('test', unreadable, KEY);
  assert.equal(fallback.active, false);
  assert.equal(fallback.storage, unreadable);
  assert.equal(fallback.contentConfig, undefined);
  assert.equal(unreadable.data.get(KEY), 'normal-save');
  for (const operation of ['removeItem', 'setItem']) {
    const blocked = storage([[KEY, 'normal-save'], [PREVIEW_KEY, 'preview-save'], [FLAG, 'reset']]);
    blocked[operation] = () => { throw new Error('storage denied'); };
    const controller = new TutorialPreviewController('test', blocked, KEY);
    assert.equal(controller.active, false);
    assert.equal(controller.storage, blocked);
    assert.equal(controller.contentConfig, undefined);
    assert.equal(blocked.data.get(KEY), 'normal-save');
    assert.equal(blocked.data.get(FLAG), 'reset');
    if (operation === 'removeItem') assert.equal(blocked.data.get(PREVIEW_KEY), 'preview-save');
  }
});
