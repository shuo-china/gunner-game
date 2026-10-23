const test = require('node:test');
const assert = require('node:assert/strict');
const { ContentUnlockManager } = require('./.build/session/session/ContentUnlockManager.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');

test('adventure preserves original next-content visibility at 12 and unlock at 35', () => {
  const policy = new ContentUnlockManager(resolveContentConfig('production'), () => ({ tutorialCompleted: true }));
  for (const [stage, visible, unlocked] of [[1,false,false],[11,false,false],[12,true,false],[34,true,false],[35,true,true],[50,true,true]]) {
    const state = policy.get('adventure', { stageValueMax: (stage - 1) * 10, currentStageIndex: 0 });
    assert.equal(state.visible, visible, `stage ${stage} visibility`);
    assert.equal(state.unlocked, unlocked, `stage ${stage} access`);
    assert.equal(state.requiredStage, 35);
  }
  assert.equal(policy.get('adventure', { tutorialCompleted: false, stageValueMax: 9999 }).visible, false);
  assert.equal(policy.isUpcoming('adventure', false), false);
  const next = new ContentUnlockManager(resolveContentConfig('production'), () => ({ tutorialCompleted: true, stageValueMax: 110 }));
  assert.equal(next.isUpcoming('adventure', false), true, 'locked visible travel can prepare in background');
});

test('adventure test bypass and advertising obey independent project switches', () => {
  for (const environment of ['production','test']) {
    const off = new ContentUnlockManager(resolveContentConfig(environment), () => ({ tutorialCompleted: true, stageValueMax: 9999 }));
    assert.equal(off.get('adventureAd').reason, 'adsDisabled');
    const on = new ContentUnlockManager(resolveContentConfig(environment, { adsEnabled: true }), () => ({ tutorialCompleted: true, stageValueMax: 340 }));
    assert.equal(on.get('adventureAd').unlocked, true);
    const disabledPlacement = new ContentUnlockManager(resolveContentConfig(environment, { adsEnabled: true, adPlacements: { 'adventure-reduce': false } }));
    assert.equal(disabledPlacement.get('adventureAd').reason, 'adsDisabled');
  }
  assert.equal(new ContentUnlockManager(resolveContentConfig('test')).get('adventure').unlocked, true);
  assert.equal(new ContentUnlockManager(resolveContentConfig('test', { tutorialEnabled: true })).get('adventure').visible, false);
  const changed = new ContentUnlockManager(resolveContentConfig('production', { thresholds: { adventureVisibleStage: 20, adventureStage: 40 } }), () => ({ tutorialCompleted: true }));
  assert.equal(changed.get('adventure', { stageValueMax: 180 }).visible, false);
  assert.equal(changed.get('adventure', { stageValueMax: 190 }).visible, true);
  assert.equal(changed.get('adventure', { stageValueMax: 380 }).unlocked, false);
  assert.equal(changed.get('adventure', { stageValueMax: 390 }).unlocked, true);
});
