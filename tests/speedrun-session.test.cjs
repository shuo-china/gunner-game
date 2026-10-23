const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { WeaponInventory } = require('./.build/session/session/WeaponInventory.js');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');
const { ContentUnlockManager } = require('./.build/session/session/ContentUnlockManager.js');
const { SpeedRunSystem } = require('./.build/session/session/SpeedRunSystem.js');
function challengeSession(options = {}) {
  const environment = options.environment || 'production';
  return new BattleSession({ contentConfig: resolveContentConfig(environment, { adsEnabled: true, bypassProgression: false,
    firstDrawDiamonds: 0, thresholds: { challengePowerLevel: 0 },
    testResources: { fundRebirthUpgrades: false } }), ...options });
}

const stats = { shots: 0, hits: 0, kills: 0, totalTrees: 20, elapsed: 0, complete: false };
function fixture(environment = 'production') {
  const data = new Map(), writes = [];
  const storage = { getItem: key => data.get(key) ?? null, setItem(key, value) { data.set(key, value); writes.push(JSON.parse(value)); } };
  const session = challengeSession({ environment, storage }); writes.length = 0;
  return { session, data, storage, writes, key: economyStorageKey(environment) };
}
function death(id = 0) { return { type: 'treeDied', treeId: id, sourceTime: .5, position: { x: 4, z: 8 } }; }
function tree(id = 0, alive = false) { return { id, alive, reward: D.from(20), rewardPrecision: 3 }; }
function clear(session) { return session.consume([death(), { type: 'complete', position: { x: 0, z: 0 } }], [tree()], session.roundId); }
function enter(session) {
  assert.equal(session.startSpeedRun().ok, true);
  const round = session.advanceFrame(1.5);
  assert.equal(round.roundId, session.roundId);
  assert.equal(session.getSpeedRunState().phase, 'playing');
  return round;
}
function exit(session) {
  assert.equal(session.exitSpeedRun().ok, true);
  const round = session.advanceFrame(1.5);
  assert.equal(session.mode, 'Main');
  return round;
}

test('an unlocked challenge loads for 1.5s and starts its full 60s only after loading', () => {
  const { session } = fixture();
  session.consume([death()], [{ ...tree(), reward: D.from(43230000), rewardPrecision: 5 }]);
  assert.equal(session.getSpeedRunState().money, '43.23b', 'challenge wallet uses the original abbreviated display units');
  assert.equal(session.getSpeedRunState().unlocked, true);
  const mainRound = session.roundId;
  assert.equal(session.startSpeedRun().ok, true);
  assert.equal(session.roundId, mainRound + 1); assert.equal(session.mode, 'SpeedRun');
  assert.equal(session.canFight, false); assert.equal(session.getSpeedRunState().phase, 'entering');
  assert.equal(session.startSpeedRun().ok, false); assert.equal(session.purchase('power'), false);
  session.advanceFrame(50, session.roundId, true); session.advanceFrame(NaN); session.advanceFrame(-1);
  assert.equal(session.getSpeedRunState().loadingElapsed, 0);
  assert.equal(session.advanceFrame(1.49), null); assert.equal(session.getSpeedRunState().remainingSeconds, 60);
  assert.equal(session.advanceFrame(.01).roundId, session.roundId);
  assert.equal(session.canFight, true); assert.equal(session.getSpeedRunState().loadingElapsed, null);
  assert.equal(session.snapshot(stats, false).durationSeconds, 60);
  assert.equal(session.snapshot(stats, false).upgrades.length, 3);
  session.advanceFrame(20, session.roundId, true);
  assert.equal(session.getSpeedRunState().remainingSeconds, 60);
  session.advanceFrame(4.5); assert.equal(session.getSpeedRunState().remainingSeconds, 55.5);
});

test('zero crossing yields before failure; final clear wins only before the next resume', () => {
  const winning = challengeSession(); enter(winning);
  winning.advanceFrame(60); assert.equal(winning.canFight, true);
  clear(winning); winning.advanceFrame(.01);
  assert.equal(winning.getSpeedRunState().phase, 'won'); assert.equal(winning.weapons.diamonds, 60);
  assert.equal(winning.getSpeedRunState().progress, 1);
  const failing = challengeSession(); enter(failing);
  failing.advanceFrame(60); failing.advanceFrame(.01);
  assert.equal(failing.getSpeedRunState().phase, 'failed'); assert.equal(failing.canFight, false);
  assert.deepEqual(clear(failing), []); assert.equal(failing.weapons.diamonds, 0);
  failing.advanceFrame(1000); assert.equal(failing.getSpeedRunState().phase, 'failed', 'failure waits for explicit exit');
});

test('a clear commits gold, exactly 60 diamonds and the independent next stage in one save', () => {
  let mainNotifications = 0;
  const { storage, data, key, writes } = fixture();
  const session = challengeSession({ storage, onStageCleared: () => mainNotifications++ });
  enter(session); writes.length = 0;
  clear(session); clear(session);
  assert.equal(writes.length, 1); assert.equal(mainNotifications, 0);
  assert.equal(session.moneyBalance.toNumber(), 20); assert.equal(session.weapons.diamonds, 60);
  assert.equal(session.getSpeedRunState().stage, 0, 'result shows played stage');
  const saved = JSON.parse(data.get(key));
  assert.deepEqual(saved.speedRun, { stage: 1 }); assert.deepEqual(saved.progress, { stageIndex: 0, waveIndex: 0 });
  assert.equal(saved.weapons.stageValueMax, 0); assert.equal(saved.weapons.diamonds, 60);
  const restored = challengeSession({ storage });
  assert.equal(restored.mode, 'Main'); assert.equal(restored.getSpeedRunState().phase, 'idle');
  assert.equal(restored.getSpeedRunState().stage, 1); assert.equal(restored.weapons.diamonds, 60);
  exit(session); assert.equal(session.getSpeedRunState().stage, 1);
  assert.equal(enter(session).stageIndex, 1);
});

test('reward ad cancellation/failure returns to victory; success grants 180 once then exits', () => {
  const { session, storage, writes } = fixture(); enter(session); clear(session);
  for (const outcome of ['cancel', 'failure']) {
    const ad = session.beginSpeedRunAd(); assert.equal(ad.ok, true);
    assert.equal(session.getSpeedRunState().phase, 'adPending');
    assert.equal(session.beginSpeedRunAd().reason, 'adInProgress');
    assert.equal(session.completeSpeedRunAd(ad.token, outcome).ok, false);
    assert.equal(session.getSpeedRunState().phase, 'won'); assert.equal(session.weapons.diamonds, 60);
    assert.equal(session.completeSpeedRunAd(ad.token, 'success').reason, 'staleAd');
  }
  const cancelled = session.beginSpeedRunAd(); session.cancelSpeedRunAd();
  assert.equal(session.getSpeedRunState().phase, 'won');
  assert.equal(session.completeSpeedRunAd(cancelled.token, 'success').reason, 'staleAd');
  const ad = session.beginSpeedRunAd();
  assert.equal(session.completeSpeedRunAd(ad.token, 'unknown').reason, 'invalid');
  assert.equal(session.getSpeedRunState().phase, 'adPending');
  writes.length = 0;
  assert.equal(session.completeSpeedRunAd(ad.token, 'success').ok, true);
  assert.equal(session.weapons.diamonds, 240); assert.equal(writes.length, 1);
  assert.equal(session.getSpeedRunState().phase, 'exiting'); assert.equal(session.getSpeedRunState().adAvailable, false);
  assert.equal(session.completeSpeedRunAd(ad.token, 'success').reason, 'staleAd');
  const restored = challengeSession({ storage });
  assert.equal(restored.weapons.diamonds, 240); assert.equal(restored.completeSpeedRunAd(ad.token, 'success').reason, 'staleAd');
  session.advanceFrame(1.5); assert.equal(session.mode, 'Main');
});

test('exiting pending ads invalidates tokens and reload never restores transient rewards', () => {
  const { session, storage } = fixture(); enter(session); clear(session);
  const ad = session.beginSpeedRunAd(); exit(session);
  assert.equal(session.completeSpeedRunAd(ad.token, 'success').ok, false);
  enter(session); clear(session); const nextAd = session.beginSpeedRunAd();
  assert.notEqual(nextAd.token, ad.token);
  assert.equal(session.completeSpeedRunAd(ad.token, 'success').reason, 'staleAd');
  const restored = challengeSession({ storage });
  assert.equal(restored.weapons.diamonds, 126); assert.equal(restored.getSpeedRunState().stage, 2);
  assert.equal(restored.completeSpeedRunAd(nextAd.token, 'success').reason, 'staleAd');
  enter(restored); clear(restored); const reloadAd = restored.beginSpeedRunAd();
  assert.notEqual(reloadAd.token, nextAd.token, 'instance identity also protects callback collisions after reload');
});

test('failure and voluntary exit preserve paid tree gold, main position and history', () => {
  for (const shouldFail of [false, true]) {
    const session = challengeSession(); const mainId = session.roundId; enter(session);
    const challengeId = session.roundId;
    session.consume([death()], [tree(), tree(1, true)]);
    assert.equal(session.moneyBalance.toNumber(), 20); assert.equal(session.getSpeedRunState().progress, .5);
    assert.deepEqual(session.consume([death()], [tree(), tree(1, true)]), []);
    if (shouldFail) { session.advanceFrame(60); session.advanceFrame(.01); }
    assert.equal(session.exitSpeedRun().ok, true); assert.equal(session.canFight, false);
    assert.equal(session.advanceFrame(1.49), null);
    const returned = session.advanceFrame(.01);
    assert.ok(returned.roundId > challengeId && challengeId > mainId);
    assert.deepEqual([returned.stageIndex, returned.waveIndex], [0, 0]);
    assert.equal(session.snapshot(stats, false).remainingSeconds, 180);
    assert.equal(session.moneyBalance.toNumber(), 20); assert.equal(session.weapons.diamonds, 0);
    assert.equal(session.getSpeedRunState().stage, 0); assert.equal(session.weapons.snapshot().stageValueMax, 0);
    assert.deepEqual(session.consume([death()], [tree()], challengeId), []);
    assert.equal(session.advanceFrame(180, challengeId), null);
    session.consume([death()], [tree()], returned.roundId); assert.equal(session.moneyBalance.toNumber(), 40);
  }
});

test('challenge cancels a queued main transition and skip without advancing its saved target', () => {
  const { session, data, key } = fixture('test');
  session.configureProgressionTest({ stageIndex: 0, waveIndex: 3, stageValueMax: 20, skipPercent: 100 });
  clear(session); session.advanceFrame(.01); session.advanceFrame(1);
  assert.equal(session.phase, 'loading');
  const target = JSON.parse(data.get(key)).progress;
  enter(session); assert.equal(session.snapshot(stats, false).stageTransition, undefined);
  session.advanceFrame(10); const returned = exit(session);
  assert.deepEqual({ stageIndex: returned.stageIndex, waveIndex: returned.waveIndex }, target);
  assert.equal(session.snapshot(stats, false).stageTransition, undefined);
  assert.equal(session.snapshot(stats, false).stageSkip, undefined);
  const id = returned.roundId; session.advanceFrame(10); assert.equal(session.roundId, id);
});

test('challenge uses normal power/upgrades but excludes main stage attack-speed and replay movement effects', () => {
  const session = challengeSession({ environment: 'test' });
  session.configureProgressionTest({ stageIndex: 3, waveIndex: 0, stageValueMax: 40 });
  session.configureRebirthTest({ levels: [1, 10, 1] }); session.purchase('power'); session.purchase('speed');
  const mainLoadout = session.getLoadout()[0]; assert.equal(session.round.movementMultiplier, 2);
  assert.equal(session.startSpeedRun().ok, true); assert.equal(session.purchase('power'), false);
  session.advanceFrame(1.5);
  const challengeLoadout = session.getLoadout()[0];
  assert.equal(session.round.movementMultiplier, 1);
  assert.equal(challengeLoadout.damage.compare(mainLoadout.damage), 0);
  assert.equal(mainLoadout.attackInterval, mainLoadout.weapon.attackInterval);
  assert.equal(challengeLoadout.attackInterval, Math.fround(Math.fround(challengeLoadout.weapon.attackInterval / 158) * 100));
  assert.equal(session.purchase('power'), true); assert.ok(session.getLoadout()[0].damage.compare(challengeLoadout.damage) > 0);
  const saved = session.moneyBalance;
  session.consume([death()], [tree(), tree(1, true)]);
  assert.equal(session.moneyBalance.sub(saved).toNumber(), 21, 'normal rebirth income applies to challenge trees');
  assert.equal(session.requestRebirth('normal').reason, 'mode'); clear(session);
  assert.equal(session.purchase('power'), false);
  exit(session); assert.equal(session.round.movementMultiplier, 2);
});

test('rebirth preserves challenge stage, while malformed optional blocks cannot erase existing economy', () => {
  const { session, storage, data, key } = fixture('test');
  assert.equal(session.configureSpeedRunTest({ stage: 12 }), true);
  session.configureProgressionTest({ stageIndex: 2, stageValueMax: 20 });
  assert.equal(session.requestRebirth('normal').ok, true); assert.equal(session.startSpeedRun().reason, 'busy');
  session.advanceRebirth(2);
  assert.equal(session.getSpeedRunState().stage, 12);
  assert.equal(challengeSession({ environment: 'test', storage }).getSpeedRunState().stage, 12);
  const saved = JSON.parse(data.get(key));
  saved.money = D.from(1234); saved.weapons.diamonds = 5678; saved.speedRun = { stage: -1 };
  data.set(key, JSON.stringify(saved)); const warn = console.warn; console.warn = () => {};
  let restored;
  try { restored = challengeSession({ environment: 'test', storage }); } finally { console.warn = warn; }
  assert.equal(restored.moneyBalance.toNumber(), 1234); assert.equal(restored.weapons.diamonds, resolveContentConfig('test').testResources.diamonds);
  assert.equal(restored.getSpeedRunState().stage, 0); assert.equal(restored.getRebirthState().count, 1);
  const legacy = JSON.parse(data.get(key)); delete legacy.speedRun; data.set(key, JSON.stringify(legacy));
  assert.equal(challengeSession({ environment: 'test', storage }).getSpeedRunState().stage, 0);
  assert.equal(session.configureSpeedRunTest({ stage: NaN }), false);
  assert.equal(challengeSession().configureSpeedRunTest({ stage: 1 }), false);
});

test('durable diamond grants reject invalid and unsafe amounts without mutating the wallet', () => {
  let mutations = 0; const weapons = new WeaponInventory({ onMutation: () => mutations++ });
  assert.equal(weapons.grantDiamonds(30).ok, true); assert.equal(weapons.diamonds, 30);
  for (const invalid of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.equal(weapons.grantDiamonds(invalid).ok, false);
  assert.equal(weapons.diamonds, 30); assert.equal(mutations, 1);
});

test('challenge domain commands enforce configured unlocks and hide disabled reward ads', () => {
  const progress = { powerLevel: 2 };
  const manager = new ContentUnlockManager(resolveContentConfig('production', { adsEnabled: false }), () => progress);
  const system = new SpeedRunSystem(manager);
  assert.equal(system.snapshot('0', '0').unlocked, false); assert.equal(system.start().reason, 'locked');
  progress.powerLevel = 3;
  assert.equal(system.snapshot('0', '0').unlocked, true); assert.equal(system.start().ok, true);
  system.advanceFrame(1.5); assert.equal(system.win(), true);
  assert.equal(system.snapshot('0', '0').adEnabled, false); assert.equal(system.snapshot('0', '0').adAvailable, false);
  assert.equal(system.beginAd().reason, 'adsDisabled'); assert.equal(system.phase, 'won');
});

test('closing the speedrun ad placement before completion rejects the reward and invalidates its token', () => {
  let adsEnabled = true;
  const manager = new ContentUnlockManager(resolveContentConfig('test', { adsEnabled: true }));
  manager.isAdEnabled = () => adsEnabled;
  const system = new SpeedRunSystem(manager); system.start(); system.advanceFrame(1.5); system.win();
  const ad = system.beginAd(); assert.equal(ad.ok, true);
  adsEnabled = false;
  assert.equal(system.completeAd(ad.token, 'success').reason, 'adsDisabled'); assert.equal(system.phase, 'won');
  assert.equal(system.completeAd(ad.token, 'success').reason, 'staleAd');
});
