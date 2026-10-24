const test = require('node:test');
const assert = require('node:assert/strict');
const { TutorialManager } = require('./.build/session/session/TutorialManager.js');
const { resolveContentConfig, WEAPON_TUTORIAL_RULES } = require('./.build/session/session/ContentConfig.js');

const progress = weaponsUnlocked => ({ weaponsUnlocked });
const action = (manager, type, weaponId = 0) => manager.onWeaponAction({ type, weaponId });

test('main tutorial follows weapon unlock, opening, two draws, fixed merge and equipment', () => {
  const manager = new TutorialManager(true);
  assert.deepEqual(WEAPON_TUTORIAL_RULES, { drawCount: 2, drawGrade: 0, mergeWeaponId: 3 });
  assert.deepEqual(manager.snapshot(), { active: true, step: 'upgrade', drawCount: 0 });
  assert.equal(manager.sync(progress(false)), false);
  assert.equal(manager.sync(progress(true)), true);
  assert.equal(manager.snapshot().step, 'gunOpen');
  assert.equal(manager.onWeaponPanelOpened(), true);
  assert.equal(manager.snapshot().step, 'gunBuy');
  assert.equal(action(manager, 'draw'), true);
  assert.deepEqual(manager.snapshot(), { active: true, step: 'gunBuy', drawCount: 1 });
  assert.equal(action(manager, 'draw', 1), true);
  assert.deepEqual(manager.snapshot(), { active: true, step: 'gunMerge', drawCount: 2 });
  assert.equal(action(manager, 'merge', 3), true);
  assert.equal(manager.snapshot().step, 'gunEquip');
  assert.equal(action(manager, 'equip', 3), true);
  assert.deepEqual(manager.snapshot(), { active: false, step: 'done', drawCount: 2 });
});

test('unrelated inventory and out-of-order action events never skip a tutorial step', () => {
  const manager = new TutorialManager(true);
  assert.equal(manager.onWeaponPanelOpened(), false);
  assert.equal(action(manager, 'draw'), false);
  manager.sync(progress(true));
  assert.equal(action(manager, 'draw'), false);
  assert.equal(action(manager, 'equip', 3), false);
  manager.onWeaponPanelOpened();
  assert.equal(manager.sync({ weaponsUnlocked: true, hasBackpackWeapon: true, equipmentChanged: true }), false);
  assert.equal(action(manager, 'merge', 3), false);
  assert.equal(action(manager, 'equip', 3), false);
  action(manager, 'draw'); action(manager, 'draw', 1);
  assert.equal(action(manager, 'draw'), false);
  assert.equal(action(manager, 'merge', 2), false, 'other C-grade weapons cannot satisfy the fixed merge');
  assert.equal(action(manager, 'equip', 3), false);
  action(manager, 'merge', 3);
  assert.equal(action(manager, 'equip', 2), false, 'only the tutorial crossbow completes equipment guidance');
  action(manager, 'equip', 3);
  assert.equal(manager.sync(progress(false)), false);
  assert.equal(action(manager, 'draw'), false);
  assert.equal(manager.onWeaponPanelOpened(), false);
  assert.deepEqual(manager.snapshot(), { active: false, step: 'done', drawCount: 2 });
});

test('closing and reopening never resets drawing, merging or equipment guidance', () => {
  const manager = new TutorialManager(true);
  manager.sync(progress(true)); manager.onWeaponPanelOpened();
  for (const [type, weaponId] of [['draw', 0], ['draw', 1], ['merge', 3]]) {
    action(manager, type, weaponId);
    const before = manager.snapshot();
    assert.equal(manager.onWeaponPanelOpened(), false);
    assert.deepEqual(manager.snapshot(), before);
  }
});

test('tutorial state survives save/reload at every step, including the first successful draw', () => {
  for (const [step, drawCount] of [['upgrade', 0], ['gunOpen', 0], ['gunBuy', 0], ['gunBuy', 1],
    ['gunMerge', 2], ['gunEquip', 2], ['done', 2]]) {
    const original = new TutorialManager(true); original.restore({ step, drawCount });
    const loaded = new TutorialManager(true); loaded.restore(JSON.parse(JSON.stringify(original.serialize())));
    assert.deepEqual(loaded.snapshot(), { active: step !== 'done', step, drawCount });
    const detached = loaded.serialize(); detached.step = 'upgrade'; detached.drawCount = 0;
    assert.deepEqual(loaded.serialize(), { step, drawCount }, 'serialized objects are detached');
  }
  const manager = new TutorialManager(true); manager.complete();
  assert.equal(manager.sync(progress(true)), false);
  assert.deepEqual(manager.serialize(), { step: 'done', drawCount: 0 });
});

test('malformed saves cannot alter valid teaching progress', () => {
  const manager = new TutorialManager(true); manager.restore({ step: 'gunEquip', drawCount: 2 });
  for (const saved of [null, [], {}, true, 3, 'done', { step: null }, { step: 5 }, { step: 'invalid' },
    { step: 'gunBuy' }, { step: 'challenge', drawCount: 0 }, { step: 'gunBuy', drawCount: -1 }, { step: 'gunBuy', drawCount: 1.5 },
    { step: 'gunBuy', drawCount: 3 }, { step: 'gunBuy', drawCount: '1' }, { step: 'gunBuy', drawCount: null }]) {
    assert.throws(() => manager.restore(saved), /Invalid tutorial save/);
    assert.deepEqual(manager.serialize(), { step: 'gunEquip', drawCount: 2 });
  }
  assert.throws(() => manager.restore(undefined), /Invalid tutorial save/);
  assert.equal(manager.snapshot().step, 'gunEquip');
});

test('production enables teaching, test skips it, and explicit overrides remain available', () => {
  assert.equal(resolveContentConfig('production').tutorialEnabled, true);
  assert.equal(resolveContentConfig('test').tutorialEnabled, false);
  assert.equal(resolveContentConfig('production', { tutorialEnabled: false }).tutorialEnabled, false);
  assert.equal(resolveContentConfig('test', { tutorialEnabled: true }).tutorialEnabled, true);
  const manager = new TutorialManager(false);
  assert.deepEqual(manager.snapshot(), { active: false, step: 'done', drawCount: 0 });
  manager.restore({ step: 'gunOpen', drawCount: 0 });
  assert.equal(manager.onWeaponPanelOpened(), false);
  assert.equal(manager.sync(progress(true)), false);
  assert.equal(action(manager, 'draw'), false);
  assert.deepEqual(manager.serialize(), { step: 'done', drawCount: 0 });
});
