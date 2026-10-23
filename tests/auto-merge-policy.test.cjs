const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');
const { ContentUnlockManager } = require('./.build/session/session/ContentUnlockManager.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');
const { WeaponInventory } = require('./.build/session/session/WeaponInventory.js');
const { DecimalAmount } = require('./.build/session/core/DecimalAmount.js');
const catalog = require('./.build/session/core/WeaponCatalog.js');
// Legacy scenario identities are translated once at the test fixture boundary.
const fixtureId = id => catalog.LEGACY_WEAPON_ID_MAP[id];

function prepared(ids = [0, 5, 9, 15]) {
  let now = 1700000000000, samples = 0, writes = 0;
  const options = { environment: 'test', content: new ContentUnlockManager(resolveContentConfig('test', { adsEnabled: true })), now: () => now, rng: () => { samples++; return 0; }, onMutation: () => writes++ };
  const inventory = new WeaponInventory(options);
  inventory.configureTest({ autoEnabled: true, adGunEnabled: false });
  for (const id of ids) inventory.grantTestWeapon(fixtureId(id));
  inventory.drainNotifications();
  return { inventory, options, advance: milliseconds => { now += milliseconds; },
    observed: () => ({ state: inventory.serialize(), revision: inventory.revision, samples, writes }) };
}
function pair(fromIndex, toIndex, fromWeaponId, toWeaponId) { return { fromIndex, toIndex, fromWeaponId: fixtureId(fromWeaponId), toWeaponId: fixtureId(toWeaponId) }; }
function commit(inventory, selected) {
  return inventory.autoMergePair(selected.fromIndex, selected.toIndex, selected.fromWeaponId, selected.toWeaponId);
}

test('auto policy selects lowest grade then earliest slots, returns detached identities and never transacts while queried', () => {
  const h = prepared([5, 9, 0, 4, 2, 15]), w = h.inventory;
  const before = h.observed(), expected = pair(3, 2, 4, 0);
  const selected = w.findAutoMergePair();
  assert.deepEqual(selected, expected);
  assert.equal(w.isAutoMergePairValid(selected), true);
  assert.deepEqual(w.findAutoMergePair([2]), pair(4, 3, 2, 4));
  assert.deepEqual(w.findAutoMergePair([2, 3]), pair(1, 0, 9, 5));
  selected.fromIndex = 15;
  assert.deepEqual(w.findAutoMergePair(), expected, 'a returned identity cannot alter inventory or later selection');
  assert.deepEqual(h.observed(), before);
  assert.deepEqual(w.drainNotifications(), []);

  w.toggleLock({ kind: 'backpack', index: 3 });
  assert.deepEqual(w.findAutoMergePair(), pair(4, 2, 2, 0), 'protected materials are skipped');
  w.setAutoMerge(false);
  assert.equal(w.findAutoMergePair(), null);
});

test('auto policy honors discovery, configured grade and SSS caps and excludes unclaimed ad guns', () => {
  const w = prepared([0, 4]).inventory;
  assert.equal(w.findAutoMergePair(), null, 'D materials wait until C has been discovered');
  w.grantTestWeapon(2);
  assert.deepEqual(w.findAutoMergePair(), pair(1, 0, 4, 0));

  const high = prepared([35, 39, 30, 34, 64]).inventory;
  assert.deepEqual(high.findAutoMergePair(), pair(3, 2, 34, 30), 'X materials are above the automatic SSS cap');
  high.configureTest({ autoMergeDegree: 5 });
  assert.equal(high.findAutoMergePair(), null);

  const h = prepared([14, 10, 5, 9, 20]), state = h.inventory.serialize();
  state.backpack[0] = { weaponId: 8, locked: false, pendingAd: true };
  state.adGunExpiresAt = h.inventory.now + 500;
  const pending = new WeaponInventory({ ...h.options, initialState: state });
  assert.deepEqual(pending.findAutoMergePair(), pair(3, 2, 9, 5));
  assert.equal(pending.findAutoMergePair([2]), null, 'unclaimed B gun cannot become an automatic material');
});

test('elapsed offline time cannot expire Auto and policy queries remain read-only', () => {
  const h = prepared(), w = h.inventory, selected = w.findAutoMergePair();
  assert.ok(selected); h.advance(8 * 24 * 60 * 60 * 1000);
  const before = h.observed();
  assert.deepEqual(w.findAutoMergePair(), selected);
  assert.equal(w.isAutoMergePairValid(selected), true);
  assert.deepEqual(h.observed(), before);
  assert.deepEqual(w.drainNotifications(), []);
  assert.equal(commit(w, selected).ok, true);
  assert.equal(w.snapshot().auto.enabled, true);
});

test('auto query and command share rejection rules without changing established error precedence or sampling RNG', () => {
  const cases = [
    { change: () => {}, selected: pair(-1, 1, 9, 5), reason: 'invalidSlot' },
    { change: w => w.swapBackpack(2, 3), selected: pair(2, 1, 9, 5), reason: 'noPair' },
    { change: w => w.configureTest({ autoMergeDegree: 0 }), selected: pair(2, 1, 9, 5), reason: 'noPair' },
    { change: w => w.toggleLock({ kind: 'backpack', index: 1 }), selected: pair(2, 1, 9, 5), reason: 'protected' },
    { change: () => {}, selected: pair(2, 0, 9, 0), reason: 'differentGrade' },
    { change: w => w.setAutoMerge(false), selected: pair(-1, 1, 9, 5), reason: 'autoInactive' },
  ];
  for (const { change, selected, reason } of cases) {
    const h = prepared(), w = h.inventory; change(w); w.drainNotifications();
    const before = h.observed();
    assert.equal(w.isAutoMergePairValid(selected), false, reason);
    assert.equal(commit(w, selected).reason, reason);
    assert.deepEqual(h.observed(), before, reason);
    assert.deepEqual(w.drainNotifications(), []);
  }
  const h = prepared([14, 10, 20]), state = h.inventory.serialize();
  state.backpack[0] = { weaponId: 8, locked: false, pendingAd: true };
  state.adGunExpiresAt = h.inventory.now + 500;
  const pending = new WeaponInventory({ ...h.options, initialState: state }), selected = pair(0, 1, 14, 10);
  const before = pending.serialize();
  assert.equal(pending.isAutoMergePairValid(selected), false);
  assert.equal(commit(pending, selected).reason, 'pendingAd');
  assert.deepEqual(pending.serialize(), before);
});

test('immediate auto merge uses the same selector and preserves its chosen pair through an unrelated draw', () => {
  const h = prepared(), w = h.inventory, select = w.findAutoMergePair.bind(w);
  let calls = 0;
  w.findAutoMergePair = excluded => {
    calls++; const selected = select(excluded);
    w.draw(); // A lower-grade pair appears after this query selected C materials.
    return selected;
  };
  assert.equal(w.autoMergeStep().weaponId, 5);
  assert.equal(calls, 1);
  const bag = w.serialize().backpack;
  assert.equal(bag[1].weaponId, 5); assert.equal(bag[2], null);
  assert.equal(bag[0].weaponId, 0); assert.equal(bag[4].weaponId, 0);
  assert.equal(h.observed().samples, 2, 'only draw and successful merge consume RNG');
});

function hudWithPolicy(inventory) {
  // Execute the real HUD methods with presentation-only stubs. Its complete
  // constructor, event handling and animation curves have separate UI tests.
  const module = { exports: {} };
  const imports = { cc: {}, '../core/DecimalAmount': { DecimalAmount }, '../core/WeaponCatalog': catalog,
    '../core/EconomyConfig': require('./.build/session/core/EconomyConfig.js'),
    '../session/ContentConfig': require('./.build/session/session/ContentConfig.js'),
    '../session/WeaponInventory': require('./.build/session/session/WeaponInventory.js'),
    './ArtLibrary': {}, './OriginalWeaponUi': {}, './OriginalWeaponConfetti': {},
    './OriginalWeaponFeedback': {}, './OriginalWeaponScroll': {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view/WeaponHud.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
  { module, exports: module.exports, require: key => { assert.ok(key in imports, key); return imports[key]; } });
  const hud = Object.create(module.exports.WeaponHud.prototype);
  const nodes = Array.from({ length: 16 }, (_, index) => ({
    worldPosition: { x: index * 300, y: 200, z: 0, clone() { return { x: this.x, y: this.y, z: this.z }; } },
    setWorldPosition(position) { this.worldPosition = position; },
  }));
  Object.assign(hud, { session: { weapons: inventory, moneyBalance: DecimalAmount.from(0), getTutorialState: () => ({ active: false, step: 'done' }) },
    backpack: nodes.map((_, node) => ({ node })), list: { SlotTransforms: nodes.map((_, i) => i), AutoMerge_PairDelay: .12, AutoMerge_MergeDistance: 25 },
    ui: { node: index => nodes[index], setText() {} }, node: { scale: { x: 1 } },
    clock: 0, autoElapsed: 0, autoMotion: null, drag: null, tutorialNeedsRefresh: false,
    adToken: null, roots: new Map([['entry', { active: true }], ['star', { active: false }], ['inventory', { active: true }]]),
    feedback: { update() {} }, confetti: { clear() {} }, lastRevision: inventory.revision,
    cancelHiddenButtons() {}, updateAnimations() {}, refreshTimers() {}, notifyVisibility() {},
    refresh(snapshot) { this.lastRevision = snapshot.revision; }, restoreAutoPair() {},
    paintAutoMotion: () => Infinity, stopAutoMotion() { this.autoMotion = null; },
    result(result) { this.lastResult = result; this.lastRevision = inventory.revision; }, spawnBounce() {}, sound() {},
  });
  return hud;
}

test('real HUD update selects and validates through domain policy and commits its original animated identity', () => {
  const h = prepared(), w = h.inventory, hud = hudWithPolicy(w);
  const select = w.findAutoMergePair.bind(w), validate = w.isAutoMergePairValid.bind(w);
  let selections = 0, validations = 0;
  w.findAutoMergePair = (...args) => { selections++; return select(...args); };
  w.isAutoMergePairValid = selected => { validations++; return validate(selected); };
  hud.update(0);
  const motion = hud.autoMotion;
  assert.equal(selections, 1); assert.equal(motion.fromIndex, 2); assert.equal(motion.toIndex, 1);
  assert.equal(motion.start.x, 600); assert.equal(motion.end.x, 300);
  w.draw(); w.drainNotifications(); hud.update(.05);
  assert.equal(validations, 1, 'HUD checks current domain eligibility each update');
  assert.equal(hud.autoMotion, motion); assert.equal(selections, 1, 'unrelated draw never reselects an animated pair');
  hud.paintAutoMotion = () => 0; hud.update(.2);
  assert.equal(hud.lastResult.weaponId, 5); assert.equal(hud.autoMotion, null);
  assert.equal(w.serialize().backpack[0].weaponId, 0); assert.equal(w.serialize().backpack[4].weaponId, 0);
  w.drainNotifications(); hud.update(.121);
  assert.equal(selections, 2); assert.equal(hud.autoMotion.fromIndex, 4); assert.equal(hud.autoMotion.toIndex, 0);
  w.setAutoMerge(false); hud.update(0);
  assert.equal(hud.autoMotion, null, 'domain rejection cancels the motion before another transaction');
});
