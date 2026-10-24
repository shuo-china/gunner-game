const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');
const { ContentUnlockManager } = require('./.build/session/session/ContentUnlockManager.js');
const { AttackSpeedBuff } = require('./.build/session/session/MineSystem.js');
const { economyModules } = require('./support/economy-modules.cjs');
const NOW = new Date(2026, 9, 15, 12).getTime();
function fixture(overrides = {}, Session = BattleSession, resolve = resolveContentConfig) {
  let now = NOW, failure = '';
  const data = new Map(), writes = [], key = economyStorageKey('test');
  const storage = {
    getItem: key => { if (failure === 'readback') throw Error('readback'); return data.get(key) ?? null; },
    setItem(key, value) {
      if (failure === 'before') throw Error('before');
      data.set(key, value); writes.push(JSON.parse(value));
      if (failure === 'after') throw Error('after');
    },
  };
  let reloads = 0;
  const config = resolve('test', { adsEnabled: true, tutorialEnabled: false, firstDrawDiamonds: 0,
    testResources: { fundGoldUpgrades: false, fundRebirthUpgrades: false, diamonds: 0, starGems: 0 }, ...overrides });
  const create = () => new Session({ environment: 'test', contentConfig: config, storage, now: () => now, rng: () => .5,
    onWeaponsChanged: force => { if (force) reloads++; } });
  const session = create(); writes.length = 0;
  return { session, create, storage, data, key, writes, setNow: n => { now = n; }, fail: kind => { failure = kind; }, get reloads() { return reloads; } };
}
function enter(session, total = 10, buff = false) {
  assert.equal(session.openMine().ok, true);
  if (buff) {
    const ad = session.requestMineAd('entry'); assert.equal(ad.ok, true);
    assert.equal(session.completeMineAd(ad.token, 'success').ok, true);
  } else assert.equal(session.startMine().ok, true);
  session.setMineOreCount(total); session.advanceFrame(1.5);
  assert.equal(session.getMineState().phase, total === 0 ? 'result' : 'playing');
  return session.roundId;
}
function ores(normal, rare = 0, first = 0) {
  return Array.from({ length: normal + rare }, (_, i) => ({ id: 4000000 + first + i, rare: i >= normal, alive: false }));
}
function kill(session, list, roundId = session.roundId) {
  session.consumeMine(list.map(ore => ({ type: 'oreDied', oreId: ore.id, score: 999999,
    position: { x: 0, z: 0 }, sourceTime: .5 })), list, roundId);
}
function exit(session) {
  assert.equal(session.exitMine().ok, true); session.advanceFrame(1.5);
  assert.equal(session.mode, 'Main'); assert.equal(session.getMineState().phase, 'idle');
}

test('Mine uses tutorial gating, stage 3 preview/stage 4 unlock and the global ad switch', () => {
  const manager = new ContentUnlockManager(resolveContentConfig('production'));
  assert.equal(manager.get('mine', { stageValueMax: 999 }).visible, false);
  assert.equal(manager.get('mine', { stageValueMax: 19, tutorialCompleted: true }).visible, false);
  assert.equal(manager.get('mine', { stageValueMax: 20, tutorialCompleted: true }).visible, true);
  assert.equal(manager.get('mine', { stageValueMax: 29, tutorialCompleted: true }).unlocked, false);
  assert.equal(manager.get('mine', { stageValueMax: 30, tutorialCompleted: true }).unlocked, true);
  for (const environment of ['production', 'test']) {
    const p = new ContentUnlockManager(resolveContentConfig(environment), () => ({ stageValueMax: 999, tutorialCompleted: true }));
    for (const id of ['mineEntryAd', 'mineRewardAd']) assert.equal(p.get(id).reason, 'adsDisabled');
  }
  const f = fixture({ adsEnabled: false });
  f.session.openMine(); assert.equal(f.session.requestMineAd('entry').reason, 'adsDisabled');
  assert.equal(f.session.startMine().ok, true);
});

test('entry consumes one durable ticket; loading waits for both actual map count and 1.5 seconds', () => {
  const f = fixture(), s = f.session, main = s.roundId;
  assert.equal(s.openMine().ok, true); f.writes.length = 0;
  assert.equal(s.startMine().ok, true); assert.equal(f.writes.length, 1);
  assert.equal(s.getMineState().remainingTickets, 1); assert.equal(f.writes[0].mine.playCount, 1);
  assert.equal(s.startMine().ok, false); assert.equal(s.canFight, false); assert.equal(s.purchase('speed'), false);
  assert.equal(s.advanceFrame(100, s.roundId, true), null); assert.equal(s.getMineState().loadingElapsed, 0);
  assert.equal(s.advanceFrame(3), null); assert.equal(s.getMineState().phase, 'entering');
  s.setMineOreCount(12, main); assert.equal(s.advanceFrame(.1), null);
  s.setMineOreCount(12); assert.equal(s.advanceFrame(.1).roundId, main + 1);
  assert.equal(s.getMineState().oreCountMax, 12); assert.equal(s.getMineState().timeRemaining, 60);
  s.setMineOreCount(1000); assert.equal(s.getMineState().oreCountMax, 12);
  assert.equal(f.create().getMineState().usedEntries, 1);
  exit(s); assert.ok(s.roundId > main + 1); assert.equal(s.moneyBalance.toString(), '0');
});

test('ore deaths score once using ore kind, floor diamonds on timeout, and never pay gold or Main progress', () => {
  const f = fixture(), s = f.session, main = s.round;
  enter(s, 100); const list = ores(9, 1);
  kill(s, list); kill(s, list);
  kill(s, [{ id: 4999999, rare: true, alive: true }]);
  assert.equal(s.getMineState().score, 38); assert.equal(s.getMineState().oreCountNow, 10);
  assert.equal(s.weapons.diamonds, 0); assert.equal(s.moneyBalance.toString(), '0');
  assert.deepEqual(s.consume([{ type: 'complete', position: { x: 0, z: 0 } },
    { type: 'treeDied', treeId: 2, position: { x: 0, z: 0 }, sourceTime: 0 }], []), []);
  f.writes.length = 0; s.advanceFrame(60);
  assert.equal(s.getMineState().phase, 'result'); assert.equal(s.getMineState().rewardDiamonds, 3);
  assert.equal(s.getMineState().bestReward, 3); assert.equal(s.weapons.diamonds, 3);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].weapons.diamonds, 3); assert.equal(f.writes[0].mine.bestReward, 3);
  kill(s, ores(0, 10, 100)); s.advanceFrame(10); assert.equal(s.weapons.diamonds, 3);
  assert.equal(f.create().weapons.diamonds, 3); exit(s);
  assert.equal(s.round.stageIndex, main.stageIndex); assert.equal(s.round.waveIndex, main.waveIndex);
});

test('twofold ore values retain fractional credit until settlement and ad rewards use the settled amount once', () => {
  for (const [normal, rare, expected] of [[1, 0, 0], [4, 0, 0], [5, 0, 1], [0, 1, 2], [9, 1, 3], [900, 100, 380]]) {
    const f = fixture(), session = f.session;
    enter(session, normal + rare); kill(session, ores(normal, rare));
    assert.equal(session.getMineState().rewardDiamonds, expected, `${normal} normal and ${rare} rare`);
    assert.equal(session.weapons.diamonds, expected);
    assert.equal(f.create().weapons.diamonds, expected);
    if (!expected) {
      assert.equal(session.requestMineAd('reward').reason, 'unavailable');
      continue;
    }
    const cancelled = session.requestMineAd('reward');
    assert.equal(session.completeMineAd(cancelled.token, 'cancel').reason, 'cancel');
    assert.equal(session.weapons.diamonds, expected);
    const rewarded = session.requestMineAd('reward');
    assert.equal(session.completeMineAd(rewarded.token, 'success').ok, true);
    assert.equal(session.weapons.diamonds, expected * 4);
    assert.equal(session.completeMineAd(rewarded.token, 'success').reason, 'staleAd');
    assert.equal(f.create().weapons.diamonds, expected * 4);
  }
});

test('clearing the actual smaller map settles immediately and stale rounds cannot score a later run', () => {
  const f = fixture(), s = f.session;
  const old = enter(s, 2); kill(s, ores(1, 1));
  assert.equal(s.getMineState().phase, 'result'); assert.equal(s.getMineState().timeRemaining, 60);
  assert.equal(s.weapons.diamonds, 2); exit(s);
  enter(s, 2); kill(s, ores(0, 2), old); assert.equal(s.getMineState().score, 0);
  kill(s, ores(0, 2)); assert.equal(s.weapons.diamonds, 6); assert.equal(s.getMineState().bestReward, 4);
  exit(s); assert.equal(s.openMine().ok, true); assert.equal(s.startMine().reason, 'dailyLimit');
  assert.equal(s.requestMineAd('entry').reason, 'dailyLimit');
});

test('early exit settles earned diamonds once, floors fractions, and keeps its spent ticket', () => {
  const f = fixture(), s = f.session;
  const roundId = enter(s, 100); kill(s, ores(9, 1)); s.advanceFrame(7);
  assert.equal(s.getMineState().score, 38); assert.equal(s.weapons.diamonds, 0);
  f.writes.length = 0;
  assert.equal(s.exitMine().ok, true);
  assert.equal(s.getMineState().phase, 'exiting'); assert.equal(s.getMineState().timeRemaining, 53);
  assert.equal(s.weapons.diamonds, 3); assert.equal(s.getMineState().usedEntries, 1); assert.equal(s.getMineState().bestReward, 3);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].weapons.diamonds, 3); assert.equal(f.writes[0].mine.bestReward, 3);
  assert.equal(s.exitMine().reason, 'inactive'); assert.equal(s.retryMineSettlement().reason, 'inactive');
  kill(s, ores(0, 10, 100), roundId);
  assert.equal(s.getMineState().score, 38); assert.equal(s.requestMineAd('reward').reason, 'unavailable');
  assert.equal(s.weapons.diamonds, 3); assert.equal(f.writes.length, 1);
  const restored = f.create(); assert.equal(restored.weapons.diamonds, 3); assert.equal(restored.getMineState().usedEntries, 1);
  s.advanceFrame(1.5); assert.equal(s.mode, 'Main'); assert.equal(s.exitMine().reason, 'mode');
  enter(s, 0); assert.equal(s.getMineState().rewardDiamonds, 0); assert.equal(s.getMineState().bonusAdAvailable, false);
  exit(s); assert.equal(f.create().getMineState().usedEntries, 2); assert.equal(s.weapons.diamonds, 3);
});

test('early exits with no whole diamond or during loading cannot create rewards or refund entry', () => {
  const f = fixture(), s = f.session;
  enter(s, 100); kill(s, ores(4)); exit(s);
  assert.equal(s.weapons.diamonds, 0); assert.equal(s.getMineState().bestReward, 0);
  assert.equal(s.getMineState().usedEntries, 1);
  s.openMine(); assert.equal(s.startMine().ok, true); exit(s);
  assert.equal(s.weapons.diamonds, 0); assert.equal(s.getMineState().usedEntries, 2);
  const restored = f.create(); assert.equal(restored.weapons.diamonds, 0); assert.equal(restored.getMineState().usedEntries, 2);
});

test('early-exit settlement failures freeze credit, preserve pending rewards and retry exactly once', () => {
  const f = fixture(), s = f.session; enter(s, 100); kill(s, ores(9, 1));
  f.writes.length = 0; f.fail('before');
  assert.equal(s.exitMine().reason, 'saveFailed'); assert.equal(s.getMineState().phase, 'result');
  assert.equal(s.getMineState().settlementPending, true); assert.equal(s.canFight, false);
  assert.equal(s.weapons.diamonds, 0); assert.equal(s.getMineState().bestReward, 0);
  kill(s, ores(0, 10, 100)); assert.equal(s.getMineState().score, 38);
  assert.equal(s.requestMineAd('reward').reason, 'unavailable'); assert.equal(s.exitMine().reason, 'saveFailed');
  f.fail('after'); assert.equal(s.exitMine().ok, true);
  assert.equal(s.getMineState().settlementPending, false); assert.equal(s.weapons.diamonds, 3);
  assert.equal(s.getMineState().bestReward, 3); assert.equal(f.writes.length, 1);
  assert.equal(s.exitMine().reason, 'inactive'); assert.equal(f.writes.length, 1);
  f.fail(''); s.advanceFrame(1.5);
  const restored = f.create(); assert.equal(restored.weapons.diamonds, 3); assert.equal(restored.getMineState().usedEntries, 1);
});

test('entry ad cancellation, failure, close, stale and duplicate callbacks cannot spend tickets or grant a buff', () => {
  const f = fixture(), s = f.session; s.openMine();
  for (const outcome of ['cancel', 'failure']) {
    const ad = s.requestMineAd('entry'); assert.equal(ad.ok, true);
    assert.equal(s.requestMineAd('entry').reason, 'adInProgress');
    assert.equal(s.completeMineAd('old', 'success').reason, 'staleAd');
    assert.equal(s.completeMineAd(ad.token, 'invalid').reason, 'invalid');
    assert.equal(s.getMineState().phase, 'adPending');
    assert.equal(s.completeMineAd(ad.token, outcome).reason, outcome);
    assert.equal(s.completeMineAd(ad.token, 'success').reason, 'staleAd');
    assert.equal(s.getMineState().usedEntries, 0); assert.equal(s.attackSpeedBuffRemainingSeconds, 0);
  }
  const close = s.requestMineAd('entry'); s.closeMine();
  assert.equal(s.completeMineAd(close.token, 'success').reason, 'staleAd');
  s.openMine(); const ad = s.requestMineAd('entry');
  assert.equal(s.completeMineAd(ad.token, 'success').ok, true);
  assert.equal(s.completeMineAd(ad.token, 'success').reason, 'staleAd');
  assert.equal(s.getMineState().phase, 'entering'); assert.equal(s.getMineState().usedEntries, 1);
  assert.equal(s.attackSpeedBuffRemainingSeconds, 300); assert.equal(s.attackSpeedBuffMultiplier, 3);
  assert.equal(f.create().attackSpeedBuffRemainingSeconds, 300);
});

test('result ad adds three times the floored base reward once, then exits; failed ads retain the base payment', () => {
  const f = fixture(), s = f.session;
  enter(s, 12); kill(s, ores(9, 3)); assert.equal(s.weapons.diamonds, 7);
  assert.equal(s.getMineState().additionalRewardDiamonds, 21);
  for (const outcome of ['cancel', 'failure']) {
    const ad = s.requestMineAd('reward'); assert.equal(ad.ok, true);
    assert.equal(s.completeMineAd(ad.token, outcome).reason, outcome);
    assert.equal(s.getMineState().phase, 'result'); assert.equal(s.weapons.diamonds, 7);
  }
  const ad = s.requestMineAd('reward'); f.writes.length = 0;
  assert.equal(s.completeMineAd(ad.token, 'success').ok, true); assert.equal(s.weapons.diamonds, 28);
  assert.equal(s.getMineState().phase, 'exiting'); assert.equal(s.getMineState().bestReward, 7);
  assert.equal(f.writes.length, 1); assert.equal(f.create().weapons.diamonds, 28);
  assert.equal(s.completeMineAd(ad.token, 'success').reason, 'staleAd');
  s.advanceFrame(1.5); assert.equal(s.mode, 'Main');
});

test('civil-day refill advances only forward and invalidates an entry ad across midnight', () => {
  const f = fixture(), s = f.session;
  enter(s); exit(s); enter(s); exit(s); assert.equal(s.getMineState().remainingTickets, 0);
  f.setNow(NOW + 86400000); assert.equal(s.getMineState().remainingTickets, 2);
  enter(s); exit(s); f.setNow(NOW); assert.equal(s.getMineState().remainingTickets, 1);
  assert.equal(f.create().getMineState().remainingTickets, 1);
  s.openMine(); const ad = s.requestMineAd('entry'); f.setNow(NOW + 2 * 86400000);
  assert.equal(s.completeMineAd(ad.token, 'success').reason, 'staleAd');
  assert.equal(s.getMineState().remainingTickets, 2); assert.equal(s.attackSpeedBuffRemainingSeconds, 0);
});

test('Mine callbacks recheck the ad gate and pending tokens never survive a reload', () => {
  for (const kind of ['entry', 'reward']) {
    const f = fixture(), s = f.session;
    if (kind === 'entry') s.openMine();
    else { enter(s, 1); kill(s, ores(0, 1)); }
    const before = s.weapons.diamonds, ad = s.requestMineAd(kind); assert.equal(ad.ok, true);
    assert.equal(f.create().completeMineAd(ad.token, 'success').reason, 'staleAd');
    s.content.isAdEnabled = () => false;
    assert.equal(s.completeMineAd(ad.token, 'success').reason, 'adsDisabled');
    assert.equal(s.weapons.diamonds, before); assert.equal(s.attackSpeedBuffRemainingSeconds, 0);
    assert.equal(s.getMineState().phase, kind === 'entry' ? 'preparing' : 'result');
    assert.equal(s.completeMineAd(ad.token, 'success').reason, 'staleAd');
  }
});

test('buff counts active foreground seconds in menus/loading, pauses for ads and persists without offline subtraction', () => {
  const f = fixture(), s = f.session;
  enter(s, 10, true); exit(s);
  const changes = f.reloads; s.advanceBuff(10, true); s.advanceBuff(NaN); s.advanceBuff(-1);
  assert.equal(s.attackSpeedBuffRemainingSeconds, 300);
  s.openMine(); s.advanceBuff(23.5); assert.equal(s.attackSpeedBuffRemainingSeconds, 276.5);
  assert.equal(s.getMineState().speedAdAvailable, false); assert.equal(s.requestMineAd('entry').reason, 'buffActive');
  const ad = s.weapons.beginAd('daily'); assert.equal(ad.ok, true);
  s.advanceBuff(100); assert.equal(s.attackSpeedBuffRemainingSeconds, 276.5);
  s.weapons.completeAd(ad.token, 'cancel'); s.closeMine();
  f.setNow(NOW + 7 * 86400000); assert.equal(f.create().attackSpeedBuffRemainingSeconds, 276.5);
  s.advanceBuff(276.5); assert.equal(s.attackSpeedBuffMultiplier, 1); assert.equal(f.reloads, changes + 1);
  assert.equal(f.create().attackSpeedBuffRemainingSeconds, 0);
});

test('buff stacking caps at 900s and lowered caps preserve existing saved time', () => {
  const buff = new AttackSpeedBuff();
  for (let i = 0; i < 5; i++) buff.setSeconds(buff.nextGrantSeconds());
  assert.equal(buff.seconds, 900); buff.advance(1.5, false); assert.equal(buff.seconds, 898.5);
  const load = economyModules(c => { c.mine.speedBuffMaxSeconds = 100; });
  const edited = new (load('session/MineSystem').AttackSpeedBuff)();
  edited.restore(buff.serialize()); assert.equal(edited.seconds, 898.5);
  edited.setSeconds(edited.nextGrantSeconds()); assert.equal(edited.seconds, 898.5);
});

test('attack-speed buff expires dynamically across Main, Mine, Boss, SpeedRun, Hunt and Raid loadouts', () => {
  const f = fixture(); enter(f.session, 10, true); exit(f.session);
  for (const mode of ['Main', 'Mine', 'Boss', 'SpeedRun', 'Monster', 'Raid']) {
    const s = f.create();
    if (mode === 'Raid') { s.openRaid(); assert.equal(s.startRaid().ok, true); }
    else s.setMode(mode);
    const faster = s.combatLoadout[0].attackInterval;
    assert.ok(faster > 0); s.advanceBuff(300);
    const normal = s.combatLoadout[0].attackInterval;
    assert.ok(normal > faster, mode); assert.ok(Math.abs(normal / faster - 3) < .00001, mode);
    if (mode === 'Mine') { assert.equal(s.combatLoadout[0].damage.toString(), '1'); assert.equal(s.combatLoadout[0].criticalChance, 0); }
    // Reset only fixture storage so each mode starts with the identical active buff.
    const saved = JSON.parse(f.data.get(f.key)); saved.buffs.attackSpeedRemainingSeconds = 300;
    f.data.set(f.key, JSON.stringify(saved));
  }
});

test('missing Mine/buff saves are rejected; valid reduced-cap ledgers retain uses and wallet', t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture(), save = JSON.parse(f.data.get(f.key));
  save.weapons.diamonds = 123;
  for (const block of ['mine', 'buffs']) {
    const missing = structuredClone(save); delete missing[block]; const raw = JSON.stringify(missing);
    f.data.set(f.key, raw); const old = f.create();
    assert.equal(old.persistenceBlocked, true); old.save(); assert.equal(f.data.get(f.key), raw);
  }
  save.mine.usedEntries = 9; save.mine.bestReward = 190;
  f.data.set(f.key, JSON.stringify(save)); const reduced = f.create();
  assert.equal(reduced.getMineState().usedEntries, 9); assert.equal(reduced.getMineState().remainingTickets, 0);
  assert.equal(reduced.getMineState().bestReward, 190); assert.equal(reduced.weapons.diamonds, 123);
});

test('failed ticket/result writes do not spend or pay in memory; retries and throw-after-write settle exactly once', () => {
  const f = fixture(), s = f.session; s.openMine(); f.fail('before');
  assert.equal(s.startMine().reason, 'saveFailed'); assert.equal(s.getMineState().usedEntries, 0);
  f.fail(''); assert.equal(s.startMine().ok, true); s.setMineOreCount(1); s.advanceFrame(1.5);
  f.fail('before'); kill(s, ores(0, 1));
  assert.equal(s.getMineState().settlementPending, true); assert.equal(s.weapons.diamonds, 0);
  assert.equal(s.exitMine().reason, 'saveFailed'); f.fail('after'); s.advanceFrame(.1);
  assert.equal(s.getMineState().settlementPending, false); assert.equal(s.weapons.diamonds, 2);
  f.fail(''); s.advanceFrame(.1); assert.equal(s.weapons.diamonds, 2); assert.equal(f.create().weapons.diamonds, 2);
});

test('unknown write/readback outcome locks later writes rather than overwriting a potentially committed wallet', () => {
  const f = fixture(), s = f.session; enter(s, 1); f.fail('readback'); kill(s, ores(0, 1));
  assert.equal(s.weapons.diamonds, 0); assert.equal(s.getMineState().settlementPending, true);
  f.fail(''); const committed = f.data.get(f.key); s.save(); s.advanceFrame(.1);
  assert.equal(f.data.get(f.key), committed); assert.equal(f.create().weapons.diamonds, 2);
});

test('economy edits change scores, conversion, daily cap, ad reward and speed reward at their owning boundaries', () => {
  const load = economyModules(c => { Object.assign(c.mine, { freeEntriesPerDay: 4, normalScore: 3, rareScore: 17,
    scorePerDiamond: 5, adAdditionalMultiplier: 2, speedBuffSeconds: 22, speedBuffMaxSeconds: 44, speedBuffMultiplier: 2 }); });
  const f = fixture({}, load('session/BattleSession').BattleSession, load('session/ContentConfig').resolveContentConfig), s = f.session;
  enter(s, 2, true); assert.equal(s.getMineState().remainingTickets, 3); assert.equal(s.attackSpeedBuffRemainingSeconds, 22);
  assert.equal(s.attackSpeedBuffMultiplier, 2); kill(s, ores(1, 1));
  assert.equal(s.getMineState().score, 20); assert.equal(s.weapons.diamonds, 4);
  const ad = s.requestMineAd('reward'); s.completeMineAd(ad.token, 'success'); assert.equal(s.weapons.diamonds, 12);
  assert.equal(f.create().weapons.diamonds, 12);
});

test('Mine preparation blocks competing mode/ad entries and production rejects test counter edits', () => {
  const f = fixture(), s = f.session; s.openMine();
  for (const action of [() => s.startSpeedRun(), () => s.startBoss(), () => s.startHunt(), () => s.openRaid(), () => s.requestRebirth('normal')])
    assert.equal(action().reason, 'busy');
  const ad = s.requestMineAd('entry'); assert.equal(s.weapons.beginAd('daily').reason, 'adInProgress');
  s.cancelMineAd(); s.closeMine(); assert.equal(s.configureMineTest({ usedEntries: 4, bestReward: 5 }), true);
  assert.equal(s.getMineState().remainingTickets, 0); assert.equal(s.getMineState().bestReward, 5);
  assert.equal(new BattleSession().configureMineTest({ usedEntries: 0 }), false);
  assert.equal(s.completeMineAd(ad.token, 'success').reason, 'staleAd');
});

test('Mine keeps all three gold upgrades during play: speed refreshes immediately while ore damage stays one', () => {
  const f = fixture(), saved = JSON.parse(f.data.get(f.key));
  saved.money = { digits: '1000000', exponent: 0, precision: 7 };
  f.data.set(f.key, JSON.stringify(saved)); const s = f.create();
  s.openMine(); s.startMine();
  for (const type of ['power', 'speed', 'money']) assert.equal(s.purchase(type), false, `${type} loading`);
  s.setMineOreCount(1); s.advanceFrame(1.5);
  const speed = s.combatLoadout[0].attackInterval;
  for (const type of ['power', 'speed', 'money']) {
    const before = s.moneyBalance, { getUpgradePrice } = require('./.build/session/session/UpgradeEconomy.js');
    assert.equal(s.purchase(type), true, `${type} playing`);
    assert.equal(s.moneyBalance.toString(), before.sub(getUpgradePrice(0)).toString());
    assert.equal(s.combatLoadout[0].damage.toString(), '1'); assert.equal(s.combatLoadout[0].criticalChance, 0);
  }
  assert.ok(s.combatLoadout[0].attackInterval < speed);
  kill(s, ores(0, 1));
  for (const type of ['power', 'speed', 'money']) assert.equal(s.purchase(type), false, `${type} result`);
  const durable = JSON.parse(f.data.get(f.key)); assert.deepEqual(durable.levels, [1, 1, 1]);
  assert.equal(durable.weapons.diamonds, 2); exit(s);
  assert.equal(s.combatLoadout[0].damage.compare(1) > 0, true, 'Main resumes normal upgraded damage');
});
