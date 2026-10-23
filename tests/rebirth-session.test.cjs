const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { getRebirthReward, remainingRebirthUpgradeBudget } = require('./.build/session/session/RebirthEconomy.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');
const { ContentUnlockManager } = require('./.build/session/session/ContentUnlockManager.js');
const { RebirthSystem } = require('./.build/session/session/RebirthSystem.js');
function ruleSession(options = {}) {
  const environment = options.environment || 'production';
  return new BattleSession({ contentConfig: resolveContentConfig(environment, { adsEnabled: true, bypassProgression: false,
    firstDrawDiamonds: 0, thresholds: { challengePowerLevel: 0 },
    testResources: { fundRebirthUpgrades: false } }), ...options });
}

const stats = { shots: 0, hits: 0, kills: 0, totalTrees: 1, elapsed: 0, complete: false };
function fixture(options = {}) {
  const data = new Map(), writes = [], now = options.now || (() => new Date(2026, 9, 10, 12).getTime());
  const storage = { getItem: key => data.get(key) ?? null, setItem(key, value) { data.set(key, value); writes.push(JSON.parse(value)); } };
  const key = economyStorageKey('production');
  ruleSession({ storage, now });
  const saved = JSON.parse(data.get(key));
  saved.money = D.from('12345.75'); saved.levels = [2, 3, 4];
  saved.tutorial = { step: 'done', drawCount: 2 }; saved.speedRun.stage = 1;
  saved.progress = options.position || { stageIndex: 2, waveIndex: 0 };
  saved.weapons.stageValueMax = options.history ?? 24;
  saved.weapons.diamonds = 5678; saved.weapons.starGems = 123;
  saved.weapons.starLevels = [1, 0, 0]; saved.weapons.starFailures = [2, 0, 0];
  saved.weapons.autoExpiresAt = now() + 86400000; saved.weapons.autoEnabled = true;
  saved.weapons.equipment[0].locked = true;
  if (options.rebirth !== undefined) saved.rebirth = options.rebirth;
  if (options.legacy) delete saved.rebirth;
  data.set(key, JSON.stringify(saved));
  const session = ruleSession({ storage, now, onRebirthCompleted: options.onRebirthCompleted }); writes.length = 0;
  return { session, storage, data, writes, key, now };
}
function clear(session) {
  const tree = { id: 0, alive: false, reward: D.from(20) };
  session.consume([{ type: 'treeDied', treeId: 0, position: { x: 0, z: 0 }, sourceTime: 1 },
    { type: 'complete', position: { x: 0, z: 0 } }], [tree], session.roundId);
}

test('rebirth entry uses historical stage 3, execution/reward use the current logical stage', () => {
  const low = fixture({ history: 19, position: { stageIndex: 1, waveIndex: 4 } }).session;
  assert.equal(low.getRebirthState().unlocked, false);
  assert.equal(low.requestRebirth('normal').reason, 'locked');
  const returned = fixture({ history: 24, position: { stageIndex: 0, waveIndex: 0 } }).session;
  assert.equal(returned.getRebirthState().unlocked, true);
  assert.equal(returned.getRebirthState().canRebirth, false);
  assert.equal(returned.getRebirthState().reward.toNumber(), 0);
  clear(low);
  assert.equal(low.round.stageIndex, 1, 'old wave remains visible during its victory');
  assert.equal(low.getRebirthState().unlocked, true);
  assert.equal(low.getRebirthState().canRebirth, true, 'original stage counter is already advanced to stage 3');
  assert.equal(low.getRebirthState().reward.toString(), '316.22');
});

test('normal rebirth commits reward and only implemented reset participants in one save', () => {
  const { session, writes, storage } = fixture();
  const oldRoundId = session.roundId, preserved = session.weapons.serialize();
  assert.equal(session.getRebirthState().enhancedReward.toString(), '948.66');
  assert.equal(session.requestRebirth('normal').ok, true);
  assert.equal(session.getRebirthState().phase, 'animating'); assert.equal(session.canFight, false);
  assert.equal(session.requestRebirth('normal').reason, 'busy');
  assert.equal(session.purchase('power'), false);
  assert.equal(session.advanceRebirth(NaN), null); assert.equal(session.advanceRebirth(-1), null);
  assert.equal(session.advanceRebirth(1.99), null); assert.equal(writes.length, 0);
  assert.equal(session.moneyBalance.toString(), '12345.75');
  const round = session.advanceRebirth(.01);
  assert.deepEqual(round, { stageIndex: 0, waveIndex: 0, roundId: oldRoundId + 1, movementMultiplier: 2 });
  assert.equal(writes.length, 1); assert.equal(session.moneyBalance.toNumber(), 0);
  assert.deepEqual(session.snapshot(stats, false).upgrades.map(item => item.level), [0, 0, 0]);
  assert.deepEqual(session.weapons.serialize(), preserved);
  assert.equal(session.getRebirthState().ruby.toString(), '316.22'); assert.equal(session.getRebirthState().count, 1);
  assert.equal(session.getRebirthState().phase, 'idle'); assert.equal(session.canFight, true);
  assert.equal(session.getRebirthState().canRebirth, false); assert.equal(session.getRebirthState().unlocked, true);
  assert.equal(session.advanceRebirth(99), null); assert.equal(writes.length, 1);
  assert.equal(session.advanceFrame(99, oldRoundId), null);
  assert.deepEqual(session.consume([{ type: 'treeDied', treeId: 0, sourceTime: 1, position: { x: 0, z: 0 } }],
    [{ id: 0, alive: false, reward: D.from(100) }], oldRoundId), []);
  const restored = ruleSession({ storage });
  assert.equal(restored.moneyBalance.toNumber(), 0); assert.equal(restored.getRebirthState().ruby.toString(), '316.22');
  assert.equal(restored.getRebirthState().count, 1); assert.equal(restored.round.stageIndex, 0);
});

test('cancelled or failed ads cannot award, consume a day, or accept stale/double callbacks', () => {
  const { session, writes } = fixture();
  const request = session.requestRebirth('ad');
  assert.equal(request.ok, true); assert.equal(typeof request.token, 'string');
  assert.equal(session.getRebirthState().phase, 'adPending');
  assert.equal(session.completeRebirthAd('other', 'success').reason, 'staleAd');
  assert.equal(session.completeRebirthAd(request.token, 'cancel').ok, false);
  assert.equal(session.getRebirthState().phase, 'idle');
  const second = session.requestRebirth('ad'); assert.notEqual(second.token, request.token);
  assert.equal(session.completeRebirthAd(request.token, 'success').reason, 'staleAd');
  assert.equal(session.completeRebirthAd(second.token, 'failure').ok, false);
  const third = session.requestRebirth('ad'); session.cancelRebirthAd();
  assert.equal(session.completeRebirthAd(third.token, 'success').reason, 'staleAd');
  assert.equal(session.getRebirthState().adAvailable, true); assert.equal(session.moneyBalance.toString(), '12345.75');
  assert.equal(writes.length, 0);
  const success = session.requestRebirth('ad');
  assert.equal(session.completeRebirthAd(success.token, 'success').ok, true);
  assert.equal(session.completeRebirthAd(success.token, 'success').reason, 'staleAd');
  assert.equal(session.getRebirthState().adAvailable, true, 'only the completed animation consumes the day');
  session.advanceRebirth(2);
  assert.equal(session.getRebirthState().ruby.toString(), '948.66'); assert.equal(session.getRebirthState().adAvailable, false);
  assert.equal(writes.length, 1);
});

test('enhanced rebirth charges the completion local day; availability changes at local midnight', () => {
  let clock = new Date(2026, 9, 10, 23, 59, 59).getTime();
  const { session, writes } = fixture({ now: () => clock, history: 990 });
  const request = session.requestRebirth('ad'); session.completeRebirthAd(request.token, 'success');
  clock += 2000; session.advanceRebirth(2);
  assert.equal(writes[0].rebirth.adUsedDate, '2026-10-11');
  assert.equal(session.getRebirthState().adAvailable, false);
  clock = new Date(2026, 9, 12, 0).getTime();
  assert.equal(session.getRebirthState().adAvailable, true);
});

test('animation freezes its original round, but an old loading coroutine resumes combat before completion', () => {
  const { session } = fixture({ history: 100 });
  clear(session);
  assert.equal(session.getRebirthState().reward.compare(getRebirthReward({ stageIndex: 2, waveIndex: 1 }).amount), 0);
  session.requestRebirth('normal');
  assert.equal(session.canFight, false);
  session.advanceFrame(.01); session.advanceFrame(1);
  assert.equal(session.phase, 'loading');
  const oldPendingRound = session.advanceFrame(.75);
  assert.equal(oldPendingRound.waveIndex, 1); assert.equal(session.canFight, true, 'Game_Start restores source is_Play despite active FX');
  assert.equal(session.rebirthAnimating, true);
  assert.equal(session.snapshot(stats, false).remainingSeconds, 180);
  session.advanceFrame(.1);
  assert.equal(session.snapshot(stats, false).remainingSeconds, 179.9, 'new Game_Cor counts down during the remaining FX');
  clear(session);
  assert.equal(session.getRebirthState().reward.compare(getRebirthReward({ stageIndex: 2, waveIndex: 2 }).amount), 0, 'new round can clear before the FX event');
  session.setRebirthModifiers({ rewardPercent: 200 });
  session.advanceRebirth(2);
  assert.equal(session.getRebirthState().ruby.compare(getRebirthReward({ stageIndex: 2, waveIndex: 2 }, 200).amount), 0);
  assert.equal(session.snapshot(stats, false).stageSkip, undefined);
  assert.equal(session.snapshot(stats, false).stageTransition, undefined);
  assert.equal(session.round.waveIndex, 0);
});

test('FX alone cannot resume its stopped round, and completion cancels a later loading restart', () => {
  const active = fixture().session;
  active.requestRebirth('normal');
  active.advanceFrame(.5); active.advanceRebirth(.5);
  assert.equal(active.canFight, false);
  assert.equal(active.snapshot(stats, false).remainingSeconds, 180);
  clear(active);
  assert.equal(active.round.waveIndex, 0); assert.equal(active.phase, 'playing');
  assert.equal(active.moneyBalance.toString(), '12345.75');

  const session = fixture({ history: 20 }).session;
  clear(session); // New progress waits 2s + 1.5s, longer than the 2s FX.
  session.requestRebirth('normal');
  session.advanceFrame(.01); session.advanceFrame(1.5); session.advanceRebirth(1.5);
  const oldRoundId = session.roundId;
  session.advanceFrame(.5);
  assert.equal(session.phase, 'loading'); assert.equal(session.canFight, false);
  const round = session.advanceRebirth(.5);
  assert.equal(round.roundId, oldRoundId + 1); assert.equal(round.stageIndex, 0); assert.equal(round.waveIndex, 0);
  assert.equal(session.snapshot(stats, false).stageTransition, undefined, 'Rebirth_Reset calls Game_Exit to cancel loading');
  assert.equal(session.advanceFrame(3), null);
  assert.equal(session.roundId, round.roundId, 'the cancelled loading cannot restart 1-1 a second time');
  assert.equal(session.canFight, true);
});

test('an already expired round still fails if rebirth stops play before the next timer resume', () => {
  const { session } = fixture({ history: 100 });
  session.advanceFrame(180);
  assert.equal(session.phase, 'playing', 'Game_Cor checks expiry on its next resume');
  assert.equal(session.snapshot(stats, false).remainingSeconds, 0);
  assert.equal(session.requestRebirth('normal').ok, true);
  session.advanceFrame(.01); session.advanceRebirth(.01);
  assert.equal(session.phase, 'failed', 'source checks remaining <= 0 even while is_Play is false');
  assert.equal(session.snapshot(stats, false).stageTransition.kind, 'fail');
  session.advanceFrame(1); session.advanceRebirth(1);
  assert.equal(session.phase, 'loading');
  const retry = session.advanceFrame(.75); session.advanceRebirth(.75);
  assert.equal(retry.stageIndex, 2); assert.equal(retry.waveIndex, 0);
  assert.equal(session.rebirthAnimating, true); assert.equal(session.canFight, true);
  const reborn = session.advanceRebirth(.24);
  assert.equal(reborn.stageIndex, 0); assert.equal(reborn.waveIndex, 0);
  assert.equal(session.snapshot(stats, false).stageTransition, undefined);
  assert.equal(session.getRebirthState().ruby.toString(), '316.22');
});

test('rebirth clears a skip still pending before the loading phase', () => {
  const { session } = fixture({ history: 100 });
  session.setProgressionModifiers({ skipPercent: 100 }); clear(session);
  session.requestRebirth('normal'); session.advanceRebirth(2);
  assert.equal(session.snapshot(stats, false).stageSkip, undefined);
  session.restartRound(); assert.equal(session.snapshot(stats, false).stageSkip, undefined);
});

test('refresh before completion resumes durable pre-rebirth state without ad debit or reward', () => {
  const { session, storage, now } = fixture();
  const request = session.requestRebirth('ad'); session.completeRebirthAd(request.token, 'success');
  session.advanceRebirth(1.5); session.save();
  const restored = ruleSession({ storage, now });
  assert.equal(restored.getRebirthState().phase, 'idle'); assert.equal(restored.getRebirthState().count, 0);
  assert.equal(restored.getRebirthState().ruby.toNumber(), 0); assert.equal(restored.getRebirthState().adAvailable, true);
  assert.equal(restored.moneyBalance.toString(), '12345.75'); assert.equal(restored.round.stageIndex, 2);
  assert.equal(restored.completeRebirthAd(request.token, 'success').reason, 'staleAd');
});

test('future completion adapters run once after the complete save and cannot interrupt a committed reset', () => {
  let context, calls = 0;
  context = fixture({ onRebirthCompleted(state) {
    calls++;
    const saved = JSON.parse(context.data.get(context.key));
    assert.equal(saved.rebirth.count, state.count);
    assert.deepEqual(saved.progress, { stageIndex: 0, waveIndex: 0 });
    assert.equal(D.from(saved.money).toNumber(), 0);
    throw new Error('unavailable future mission adapter');
  } });
  const warning = console.warn; console.warn = () => {};
  try { context.session.requestRebirth('normal'); context.session.advanceRebirth(2); context.session.advanceRebirth(2); }
  finally { console.warn = warning; }
  assert.equal(calls, 1); assert.equal(context.writes.length, 1); assert.equal(context.session.canFight, true);
});

test('old v3 saves load defaults and corrupt rebirth blocks never discard valid existing progress', () => {
  const old = fixture({ legacy: true }).session;
  assert.equal(old.getRebirthState().ruby.toNumber(), 0);
  assert.deepEqual(old.getRebirthState().upgrades.map(item => item.level), [0, 0, 0]);
  const warning = console.warn; console.warn = () => {};
  try {
    for (const rebirth of [null, { ruby: { digits: '-5', exponent: 0, precision: 1 }, levels: [0, 0, 0], count: 1, adUsedDate: '' },
      { ruby: { digits: '5', exponent: 0, precision: 1 }, levels: [20001, 0, 0], count: 1, adUsedDate: '' }]) {
      const damaged = fixture({ rebirth }).session;
      assert.equal(damaged.getRebirthState().ruby.toNumber(), 0); assert.equal(damaged.moneyBalance.toString(), '12345.75');
      assert.equal(damaged.weapons.diamonds, 5678); assert.equal(damaged.round.stageIndex, 2);
      assert.deepEqual(damaged.snapshot(stats, false).upgrades.map(item => item.level), [2, 3, 4]);
    }
  } finally { console.warn = warning; }
});

test('retired payment fields in v3 payloads are ignored without losing earned wallets or free ad rewards', () => {
  const { data, key, storage, now } = fixture({ history: 990 });
  const saved = JSON.parse(data.get(key));
  // Optional/unknown fields from earlier or imported payloads must never turn
  // into a bypass of the retained rewarded-ad transactions.
  saved.noAds = true; saved.removeAdsAll = true; saved.plusPack = true;
  saved.rebirth.paidVisible = true; saved.rebirth.removeAdsAll = true;
  saved.weapons.removeAdsAll = true; saved.weapons.rewardAdRemoved = true;
  saved.speedRun = { stage: 4, rewardAuto: true, removeAdsAll: true };
  data.set(key, JSON.stringify(saved));
  const restored = ruleSession({ storage, now });
  assert.equal(restored.moneyBalance.toString(), '12345.75'); assert.equal(restored.weapons.diamonds, 5678);
  assert.equal(Object.hasOwn(restored.getRebirthState(), 'paidVisible'), false);
  assert.equal(restored.weapons.snapshot().auto.unlocked, true, 'auto merge now follows the stage unlock rather than retired ad entitlement');
  assert.equal(restored.getSpeedRunState().reward, 84);
  assert.equal(restored.getSpeedRunState().stage, 4);
  assert.equal(restored.startSpeedRun().ok, true); restored.advanceFrame(1.5); clear(restored);
  assert.equal(restored.weapons.diamonds, 5762, 'old no-ad flags cannot automatically grant the fifth-stage extra 252');
  assert.equal(restored.getSpeedRunState().adAvailable, true);
  const persisted = JSON.parse(data.get(key));
  for (const name of ['noAds', 'removeAdsAll', 'plusPack']) assert.equal(Object.hasOwn(persisted, name), false);
  assert.equal(Object.hasOwn(persisted.rebirth, 'paidVisible'), false);
  assert.equal(Object.hasOwn(persisted.weapons, 'removeAdsAll'), false);
  assert.equal(Object.hasOwn(persisted.weapons, 'rewardAdRemoved'), false);
  assert.deepEqual(persisted.speedRun, { stage: 5 });
});

test('permanent upgrades affect damage before integer discard/stars, income, and additive stage speed', () => {
  const session = ruleSession({ environment: 'test' });
  session.configureRebirthTest({ ruby: '100000', levels: [1, 10, 1] });
  session.weapons.grantTestWeapon(1); session.weapons.equip(0, 0);
  session.purchase('power'); session.weapons.configureTest({ starLevels: [1, 0, 0] });
  assert.equal(session.combatLoadout[0].damage.toNumber(), 135, 'floor(80 * 1.08 * 1.05) * 1.5');
  session.purchase('speed'); session.configureProgressionTest({ stageIndex: 1 });
  assert.equal(session.combatLoadout[0].attackInterval, Math.fround(Math.fround(session.combatLoadout[0].weapon.attackInterval / 128) * 100));
  session.configureProgressionTest({ stageIndex: 10000 });
  assert.equal(session.combatLoadout[0].attackInterval, session.combatLoadout[0].weapon.attackInterval);
  session.configureProgressionTest({ stageIndex: 0 }); session.configureRebirthTest({ levels: [1, 20000, 1] });
  assert.equal(session.combatLoadout[0].attackInterval, Math.fround(.05));
  session.requestRebirth('normal'); // Locked at stage 1, leaving reward testing active.
  const reward = session.consume([{ type: 'treeDied', treeId: 0, sourceTime: 0, position: { x: 0, z: 0 } }],
    [{ id: 0, alive: false, reward: D.from(20) }]);
  assert.equal(reward[0].amount.toNumber(), 21);
});

test('combat speed uses the original getter precision at permanent bonus digit boundaries', () => {
  const session = ruleSession({ environment: 'test' });
  // Native Speed_return adds integer 100 using InfVal before Cat casts to int.
  // Values below are evaluated from the source coefficient/precision pairs,
  // independently of the production RebirthEconomy getter.
  for (const [level, stageIndex, percent] of [
    [179, 2, 935], [180, 2, 940], [181, 2, 945], [182, 2, 950],
    [199, 2, 1035], [200, 2, 1040], [1999, 300, 1095], [19999, 3300, 1090],
  ]) {
    assert.equal(session.configureRebirthTest({ levels: [0, level, 0] }), true);
    assert.equal(session.configureProgressionTest({ stageIndex }), true);
    assert.equal(session.getRebirthState().upgrades[1].value.toNumber(), 5 * level, 'card still displays the full bonus');
    const actor = session.combatLoadout[0];
    assert.equal(actor.attackInterval, Math.max(Math.fround(.05), Math.min(2, Math.fround(Math.fround(actor.weapon.attackInterval / percent) * 100))), `level ${level}`);
  }
  session.configureRebirthTest({ levels: [0, 199, 0] });
  session.configureProgressionTest({ stageIndex: 2 });
  session.purchase('speed');
  const actor = session.combatLoadout[0];
  assert.equal(actor.attackInterval, Math.max(Math.fround(.05), Math.min(2, Math.fround(Math.fround(actor.weapon.attackInterval / 1043) * 100))));
});

test('permanent purchases obey equality/max and persist InfVal wallet precision; test rebirth does not re-fund coins', () => {
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const session = ruleSession({ environment: 'test', storage });
  assert.equal(session.configureSpeedRunTest({ stage: 1 }), true);
  session.configureProgressionTest({ stageValueMax: 20 });
  assert.equal(session.configureRebirthTest({ ruby: '3', levels: [0, 0, 20000] }), true);
  assert.equal(session.purchaseRebirthUpgrade('power'), true);
  assert.equal(session.getRebirthState().ruby.toNumber(), 0); assert.equal(session.purchaseRebirthUpgrade('speed'), false);
  assert.equal(session.purchaseRebirthUpgrade('money'), false); assert.equal(session.purchaseRebirthUpgrade('invalid'), false);
  assert.equal(session.configureRebirthTest({ ruby: '-1' }), false);
  assert.equal(ruleSession().configureRebirthTest({ ruby: '1e20' }), false);
  session.configureProgressionTest({ stageIndex: 2, stageValueMax: 20 }); session.requestRebirth('normal'); session.advanceRebirth(2);
  assert.equal(session.moneyBalance.toNumber(), 0); assert.equal(session.purchase('power'), false);
  assert.equal(session.getRebirthState().upgrades[0].level, 1);
  const restored = ruleSession({ environment: 'test', storage });
  assert.equal(restored.moneyBalance.toNumber(), 0, 'test funding cannot undo a completed rebirth after refresh');
  assert.equal(restored.getRebirthState().count, 1); assert.equal(restored.getRebirthState().upgrades[0].level, 1);
});

test('rebirth balances retain saved InfVal precision across reloads and are isolated from returned snapshots', () => {
  const { session, storage, now, data, key } = fixture({ rebirth: {
    ruby: { digits: '12345', exponent: -2, precision: 5 }, levels: [0, 0, 0], count: 4, adUsedDate: '',
  } });
  const snapshot = session.getRebirthState(); snapshot.upgrades[0].level = 20000;
  assert.equal(session.purchaseRebirthUpgrade('power'), true);
  let saved = JSON.parse(data.get(key));
  assert.equal(saved.rebirth.ruby.precision, 5); assert.equal(D.from(saved.rebirth.ruby).toString(), '120.45');
  const restored = ruleSession({ storage, now });
  assert.equal(restored.getRebirthState().ruby.toString(), '120.45'); assert.equal(restored.getRebirthState().upgrades[0].level, 1);
  restored.requestRebirth('normal'); restored.advanceRebirth(2);
  saved = JSON.parse(data.get(key));
  assert.equal(saved.rebirth.ruby.precision, 5); assert.equal(D.from(saved.rebirth.ruby).toString(), '436.67');
});

test('test startup funds remaining permanent upgrades and permits stage-one rebirth without changing progression', () => {
  const session = new BattleSession({ environment: 'test' });
  const before = session.getRebirthState();
  assert.equal(before.unlocked, true); assert.equal(before.canRebirth, true);
  assert.equal(before.adEnabled, false); assert.equal(before.adAvailable, false);
  assert.equal(before.ruby.compare(remainingRebirthUpgradeBudget([0, 0, 0])), 0);
  assert.equal(before.reward.toString(), '316.22');
  assert.deepEqual([session.round.stageIndex, session.round.waveIndex, session.weapons.snapshot().stageValueMax], [0, 0, 0]);
  assert.equal(session.requestRebirth('ad').reason, 'adsDisabled');
  session.cancelRebirthAd();
  assert.equal(session.requestRebirth('normal').ok, true);
  session.advanceRebirth(2);
  assert.equal(session.getRebirthState().count, 1);
  assert.equal(session.getRebirthState().ruby.compare(before.ruby.add('316.22').truncateSignificant(15)), 0);
  assert.equal(session.moneyBalance.toNumber(), 0);
  assert.deepEqual([session.round.stageIndex, session.round.waveIndex, session.weapons.snapshot().stageValueMax], [0, 0, 0]);
});

test('permanent test supply only raises the wallet to its remaining budget and respects disabled funding', () => {
  const config = resolveContentConfig('test'), system = new RebirthSystem(() => 0, new ContentUnlockManager(config));
  system.configureTest({ levels: [19999, 20000, 20000], ruby: '1' });
  assert.equal(system.refillTestResources(), true);
  assert.equal(D.from(system.serialize().ruby).toString(), '187000000000');
  assert.equal(system.refillTestResources(), false);
  assert.equal(system.purchase('power'), true);
  assert.equal(D.from(system.serialize().ruby).toNumber(), 0);
  assert.equal(system.refillTestResources(), false);
  system.configureTest({ ruby: '1e20' });
  assert.equal(system.refillTestResources(), false); assert.equal(D.from(system.serialize().ruby).toString(), '100000000000000000000');
  for (const profile of [resolveContentConfig('production'), resolveContentConfig('test', { testResources: { fundRebirthUpgrades: false } })]) {
    const disabled = new RebirthSystem(() => 0, new ContentUnlockManager(profile));
    assert.equal(disabled.refillTestResources(), false); assert.equal(D.from(disabled.serialize().ruby).toNumber(), 0);
  }
});

test('rebirth entry and execution follow separate configured thresholds and reject locked permanent purchases', () => {
  const progress = { stageValueMax: 39, currentStageIndex: 5, tutorialCompleted: true, challengeWins: 1 };
  const manager = new ContentUnlockManager(resolveContentConfig('production', { thresholds: { rebirthStage: 5, rebirthActionStage: 6 } }), () => progress);
  const system = new RebirthSystem(() => 0, manager); system.configureTest({ ruby: '100' });
  assert.equal(system.snapshot({ stageIndex: 5, waveIndex: 0 }, 39).unlockMessage, '第5关起可用。');
  assert.equal(system.request('normal', { stageIndex: 5, waveIndex: 0 }).reason, 'locked');
  assert.equal(system.purchase('power'), false);
  progress.stageValueMax = 40;
  const state = system.snapshot({ stageIndex: 4, waveIndex: 0 }, 40);
  assert.equal(state.unlocked, true); assert.equal(state.canRebirth, false); assert.equal(state.actionMessage, '第6关起可用。');
  assert.equal(system.purchase('power'), true);
  assert.equal(system.request('normal', { stageIndex: 4, waveIndex: 0 }).reason, 'locked');
  assert.equal(system.request('normal', { stageIndex: 5, waveIndex: 0 }).ok, true);
});

test('a disabled rebirth ad callback clears the pending transaction without granting reward', () => {
  let adsEnabled = true;
  const config = resolveContentConfig('test', { adsEnabled: true });
  const manager = new ContentUnlockManager(config); manager.isAdEnabled = () => adsEnabled;
  const system = new RebirthSystem(() => 0, manager), position = { stageIndex: 0, waveIndex: 0 };
  const request = system.request('ad', position); assert.equal(request.ok, true);
  adsEnabled = false;
  assert.equal(system.completeAd(request.token, 'success', position).reason, 'adsDisabled');
  const state = system.snapshot(position, 0);
  assert.equal(state.phase, 'idle'); assert.equal(state.count, 0); assert.equal(state.ruby.toNumber(), 0);
  assert.equal(system.completeAd(request.token, 'success', position).reason, 'staleAd');
});
