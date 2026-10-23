const test = require('node:test');
const { assert, compiled, fixture, enter, win } = require('./support/boss-session-fixture.cjs');
const { resolveContentConfig } = compiled('session/ContentConfig.js');
const { ContentUnlockManager } = compiled('session/ContentUnlockManager.js');
const { BossSystem } = compiled('session/BossSystem.js');

test('original Boss entrance appears at displayed stage 6 and unlocks at 10 using retained history', () => {
  const progress = { stageValueMax: 0, currentStageIndex: 0, tutorialCompleted: true };
  const manager = new ContentUnlockManager(resolveContentConfig('production'), () => progress);
  const system = new BossSystem(manager);
  for (const [history, visible, unlocked] of [[49, false, false], [50, true, false], [89, true, false], [90, true, true]]) {
    progress.stageValueMax = history;
    const state = manager.get('boss');
    assert.equal(state.visible, visible, `history ${history}`); assert.equal(state.unlocked, unlocked);
    assert.equal(state.requiredStage, 10);
    if (!unlocked) assert.equal(system.start().reason, 'locked');
  }
  assert.equal(system.start().ok, true);
  assert.equal(manager.get('bossAd').reason, 'adsDisabled', 'default advertising remains disabled');
});

test('Boss test access and configured visibility remain separate from advertising switches', () => {
  const config = resolveContentConfig('test'), manager = new ContentUnlockManager(config);
  assert.equal(manager.isUnlocked('boss'), true); assert.equal(manager.get('boss').visible, true);
  assert.equal(manager.get('bossAd').unlocked, false);
  const custom = new ContentUnlockManager(resolveContentConfig('production', {
    thresholds: { bossVisibleStage: 2, bossStage: 4 }, adsEnabled: true }), () => ({ stageValueMax: 20, tutorialCompleted: true }));
  assert.equal(custom.get('boss').visible, true); assert.equal(custom.isUnlocked('boss'), false);
  assert.equal(custom.get('boss').requiredStage, 4);
  for (const overrides of [{ adsEnabled: false }, { adPlacements: { boss: false } }]) {
    const { session } = fixture('test', overrides); enter(session); win(session);
    assert.equal(session.getBossState().adEnabled, false); assert.equal(session.getBossState().adAvailable, false);
    assert.equal(session.beginBossAd().reason, 'adsDisabled'); assert.equal(session.getBossState().phase, 'won');
  }
});

test('production Boss commands enforce access and cannot apply test progression', () => {
  const { session } = fixture('production');
  assert.equal(session.startBoss().reason, 'locked'); assert.equal(session.mode, 'Main');
  assert.equal(session.configureBossTest({ stage: 3 }), false);
  const unlocked = fixture('production', { thresholds: { bossStage: 1 } }).session;
  enter(unlocked); assert.equal(unlocked.getBossState().phase, 'playing');
});

test('disabling a Boss reward placement invalidates its pending callback without advancing the lifecycle', () => {
  const manager = new ContentUnlockManager(resolveContentConfig('test', { adsEnabled: true }));
  let enabled = true; manager.isAdEnabled = () => enabled;
  const system = new BossSystem(manager); system.start(); system.advanceFrame(2); system.win();
  const ad = system.beginAd(); enabled = false;
  assert.equal(system.completeAd(ad.token, 'success').reason, 'adsDisabled');
  assert.equal(system.phase, 'won'); assert.equal(system.completeAd(ad.token, 'success').reason, 'staleAd');
});
