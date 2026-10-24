const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');
const { ContentUnlockManager } = require('./.build/session/session/ContentUnlockManager.js');
const { raidCalendar, raidReward, raidWeakness } = require('./.build/session/session/RaidSystem.js');
const { getWeapon, WEAPON_TYPES } = require('./.build/session/core/WeaponCatalog.js');
const { getStarPercent } = require('./.build/session/session/WeaponInventory.js');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { OriginalInfVal: I } = require('./.build/session/core/OriginalInfVal.js');
const NOW = new Date(2026, 9, 5, 12).getTime();
function fixture(options = {}) {
  const data = new Map(), writes = [];
  const storage = { getItem: key => data.get(key) ?? null, setItem(key, value) { data.set(key, value); writes.push(JSON.parse(value)); } };
  let now = options.now ?? NOW;
  const environment = options.environment ?? 'test';
  const contentConfig = resolveContentConfig(environment, { adsEnabled: options.ads ?? false,
    thresholds: { challengePowerLevel: 0 },
    testResources: { fundGoldUpgrades: false, fundRebirthUpgrades: false, diamonds: 0, starGems: 0 } });
  const make = () => new BattleSession({ environment, storage, contentConfig, now: () => now, rng: () => 0 });
  const session = make(); writes.length = 0;
  return { session, data, writes, storage, key: economyStorageKey(environment), make, setNow: value => { now = value; } };
}
function enter(s) {
  if (s.getRaidState().phase === 'idle') assert.equal(s.openRaid().ok, true);
  assert.equal(s.startRaid().ok, true);
  assert.equal(s.advanceFrame(2).roundId, s.roundId);
  assert.equal(s.getRaidState().phase, 'playing');
}
function finish(s, clears) {
  const boss = s.getRaidBossCombat();
  for (let i = 0; i < clears; i++) boss.hit(boss.maxHealth);
  s.advanceFrame(60); assert.equal(s.getRaidState().phase, 'result');
}
function exit(s) {
  assert.equal(s.exitRaid().ok, true); const round = s.advanceFrame(1.5);
  assert.equal(s.mode, 'Main'); assert.equal(s.getRaidState().phase, 'idle'); return round;
}
function patchSaved(f, edit) { const save = JSON.parse(f.data.get(f.key)); edit(save); f.data.set(f.key, JSON.stringify(save)); return f.make(); }

test('Raid visibility and unlock use displayed stages 35 and 40; ads default off', () => {
  const policy = new ContentUnlockManager(resolveContentConfig('production'), () => ({ tutorialCompleted: true }));
  assert.equal(policy.get('raid', { stageValueMax: 339 }).visible, false);
  assert.equal(policy.get('raid', { stageValueMax: 340 }).visible, true);
  assert.equal(policy.get('raid', { stageValueMax: 389 }).unlocked, false);
  assert.equal(policy.get('raid', { stageValueMax: 390 }).unlocked, true);
  assert.equal(policy.get('raidAd', { stageValueMax: 9999 }).reason, 'adsDisabled');
  assert.equal(new BattleSession().openRaid().reason, 'locked');
  assert.equal(new BattleSession({ environment: 'test' }).getRaidState().adEnabled, false);
});

test('local Monday calendar rotates five bosses and reports the next local Monday', () => {
  assert.equal(raidCalendar(new Date(2024, 0, 1).getTime()).seasonIndex, 0);
  assert.equal(raidCalendar(new Date(2024, 0, 7, 23, 59, 59).getTime()).bossIndex, 0);
  assert.equal(raidCalendar(new Date(2024, 0, 8).getTime()).bossIndex, 1);
  assert.equal(raidCalendar(new Date(2024, 1, 5).getTime()).bossIndex, 0);
  assert.equal(raidCalendar(NOW).seasonEndsAt, new Date(2026, 9, 12).getTime());
  for (let i = 0; i < 5; i++) assert.equal(raidWeakness(i), ['PIERCE', 'EXPLOSIVE', 'LASER', 'MISSILE', 'BLAST_SNIPER'][i]);
});

test('two free tickets consume before loading; enter takes 2s and exit takes 1.5s', () => {
  const { session: s, writes } = fixture(); const mainRound = s.roundId;
  s.openRaid(); writes.length = 0;
  assert.equal(s.startRaid().ok, true); assert.equal(s.mode, 'Raid'); assert.equal(writes.length, 1);
  assert.equal(s.getRaidState().freeRemaining, 1); assert.equal(s.getRaidState().seasonTryCount, 0);
  assert.equal(s.canFight, false); assert.equal(s.purchase('power'), false);
  s.advanceFrame(100, s.roundId, true); s.advanceFrame(NaN); s.advanceFrame(-1);
  assert.equal(s.getRaidState().loadingElapsed, 0);
  assert.equal(s.advanceFrame(1.99), null); assert.equal(s.getRaidState().remainingSeconds, 60);
  assert.equal(s.advanceFrame(.01).roundId, mainRound + 1);
  assert.equal(s.getRaidState().seasonTryCount, 1); assert.equal(s.canFight, true);
  s.advanceFrame(20, s.roundId, true); assert.equal(s.getRaidState().remainingSeconds, 60);
  assert.equal(s.exitRaid().ok, true); assert.equal(s.canFight, false); assert.equal(s.advanceFrame(1.49), null);
  const returned = s.advanceFrame(.01); assert.equal(s.mode, 'Main'); assert.equal(returned.roundId, mainRound + 2);
  enter(s); exit(s); s.openRaid(); assert.equal(s.startRaid().reason, 'noEntries');
  assert.equal(s.beginRaidAd().reason, 'adsDisabled'); assert.equal(s.getRaidState().adAvailable, false);
});

test('timeout rewards each tier once, while voluntary exit does not reward or write a best', () => {
  for (const [clears, reward] of [[0, 0], [10, 250], [20, 450], [30, 550], [31, 555]]) {
    assert.equal(raidReward(clears), reward);
    const f = fixture(), s = f.session; enter(s); f.writes.length = 0; finish(s, clears);
    assert.equal(s.weapons.starGems, reward); assert.equal(f.writes.length, 1);
    assert.equal(s.getRaidState().seasonBestLevel, clears);
    assert.equal(s.getRaidState().bestByType[WEAPON_TYPES.indexOf(s.getRaidState().weakness)], clears);
    s.advanceFrame(999); assert.equal(s.weapons.starGems, reward); assert.equal(f.writes.length, 1);
    assert.equal(s.getRaidState().newRecord, clears > 0);
  }
  const { session: s } = fixture(); enter(s); s.getRaidBossCombat().hit(s.getRaidBossCombat().maxHealth); exit(s);
  assert.equal(s.weapons.starGems, 0); assert.equal(s.getRaidState().seasonBestLevel, 0);
  assert.equal(s.getRaidState().seasonTryCount, 1); assert.deepEqual(s.getRaidState().bestByType, new Array(7).fill(0));
});

test('Raid ignores ordinary combat rewards and resumes the saved Main position with new event identity', () => {
  const f = fixture(), s = f.session;
  s.configureProgressionTest({ stageIndex: 5, waveIndex: 2, stageValueMax: 50 });
  const main = s.round; enter(s); const raidId = s.roundId;
  assert.deepEqual(s.consume([{ type: 'treeDied', treeId: 0, sourceTime: 1, position: { x: 0, z: 0 } },
    { type: 'complete', position: { x: 0, z: 0 } }], [{ id: 0, alive: false, reward: D.from(1000) }]), []);
  assert.equal(s.moneyBalance.toNumber(), 0); assert.equal(s.weapons.diamonds, 0);
  const returned = exit(s); assert.deepEqual([returned.stageIndex, returned.waveIndex], [main.stageIndex, main.waveIndex]);
  assert.equal(s.advanceFrame(200, raidId), null); assert.ok(returned.roundId > raidId);
  assert.equal(s.weapons.stageValueMax, 50);
});

test('natural timeout settles in the last frame and includes hits already simulated in that frame', () => {
  const { session: s } = fixture(); enter(s); s.advanceFrame(59.75);
  const boss = s.getRaidBossCombat(); boss.hit(boss.maxHealth);
  s.advanceFrame(.25);
  assert.equal(s.getRaidState().phase, 'result'); assert.equal(s.getRaidState().remainingSeconds, 0);
  assert.equal(s.getRaidState().clearedLevels, 1); assert.equal(s.weapons.starGems, 25); assert.equal(s.canFight, false);
});

test('all eight missions track only entered tries and natural best; claims share one durable wallet mutation', () => {
  const f = fixture(), s = f.session; enter(s); finish(s, 30); exit(s); s.openRaid();
  let state = s.getRaidState(); assert.equal(state.missions.length, 8);
  assert.deepEqual(state.missions.map(m => m.target), [1, 4, 7, 1, 5, 10, 20, 30]);
  assert.deepEqual(state.missions.map(m => m.reward), [300, 500, 800, 200, 300, 400, 500, 600]);
  assert.equal(state.missions[0].claimable, true); assert.equal(state.missions[1].complete, false);
  f.writes.length = 0; assert.equal(s.claimRaidMission(0).ok, true); assert.equal(f.writes.length, 1);
  assert.equal(s.weapons.starGems, 850); assert.equal(s.claimRaidMission(0).reason, 'notClaimable');
  s.configureRaidTest({ seasonTryCount: 7 }); f.writes.length = 0;
  assert.equal(s.claimAllRaidMissions().ok, true); assert.equal(f.writes.length, 1);
  assert.equal(s.weapons.starGems, 550 + 3600); assert.equal(s.getRaidState().hasClaimable, false);
  assert.equal(s.claimAllRaidMissions().reason, 'notClaimable');
  const loaded = f.make(); assert.equal(loaded.weapons.starGems, 4150);
  assert.equal(loaded.getRaidState().missions.every(m => m.claimed), true);
});

test('recommendations rank weakness-adjusted base damage, retain duplicate owned sources, and reset on reopen', () => {
  const { session: s } = fixture(); [30, 30, 29, 31].forEach(id => s.weapons.grantTestWeapon(id));
  s.weapons.configureTest({ starLevels: [20, 1, 0] }); s.openRaid(); const state = s.getRaidState();
  assert.equal(state.candidates.filter(c => c.weaponId === 30).length, 2);
  for (const weapon of state.candidates) {
    assert.deepEqual(weapon.source, { kind: weapon.sourceIndex < 3 ? 'equipment' : 'backpack',
      index: weapon.sourceIndex < 3 ? weapon.sourceIndex : weapon.sourceIndex - 3, weaponId: weapon.weaponId });
  }
  const expected = [...state.candidates].sort((a, b) => b.damage.compare(a.damage) || a.sourceIndex - b.sourceIndex).slice(0, 3);
  assert.deepEqual(state.slots.map(w => w.sourceIndex), expected.map(w => w.sourceIndex));
  assert.equal(s.selectRaidWeapon(0, state.slots[1].sourceIndex).reason, 'unavailableWeapon');
  s.unselectRaidWeapon(0); s.unselectRaidWeapon(1); assert.equal(s.unselectRaidWeapon(2).reason, 'lastWeapon');
  s.closeRaid(); s.openRaid(); assert.deepEqual(s.getRaidState().slots.map(w => w.sourceIndex), expected.map(w => w.sourceIndex));
});

test('pending ad weapon is ineligible, while a claimed B staff weapon remains eligible', () => {
  const f = fixture({ ads: true });
  const s = patchSaved(f, save => {
    save.weapons.backpack[0] = { weaponId: 8, locked: false, pendingAd: true };
    save.weapons.backpack[1] = { weaponId: 8, locked: false, pendingAd: false };
    save.weapons.collection[8] = true;
    save.weapons.adGunExpiresAt = NOW + 100000; save.weapons.adGunOffered = true;
  });
  s.openRaid(); const candidates = s.getRaidState().candidates;
  assert.equal(candidates.some(c => c.sourceIndex === 3), false); assert.equal(candidates.some(c => c.sourceIndex === 4 && c.weaponId === 8), true);
});

test('empty Raid slots keep their star source while actor identities compact; battle loadout freezes', () => {
  const { session: s } = fixture(); [30, 31, 32].forEach(id => s.weapons.grantTestWeapon(id));
  s.weapons.configureTest({ starLevels: [1, 4, 9] }); s.openRaid(); s.unselectRaidWeapon(0);
  const preview = s.getRaidState(); const before = s.getLoadout();
  assert.equal(s.getRaidStarPreview(0, 1), null); assert.equal(s.getRaidStarPreview(1, 4), preview.slots[1].damage.format());
  assert.equal(s.getRaidStarPreview(1, 21), null); enter(s);
  const loadout = s.getLoadout(); assert.deepEqual(loadout.map(a => a.actorIndex), [0, 1]);
  assert.deepEqual(loadout.map(a => a.raidSlot), [1, 2]); assert.deepEqual(loadout.map(a => a.starLevel), [4, 9]);
  assert.notDeepEqual(loadout.map(a => a.weapon.id), before.map(a => a.weapon.id));
  for (const actor of loadout) {
    let expected = I.fromAmount(D.from(actor.weapon.damage), actor.weapon.damage.split('e')[0].length)
      .mul(100).div(100).mul(100).div(100).mul(100).div(100).discardDecimal().mul(getStarPercent(actor.starLevel)).div(100);
    if (actor.weapon.type === preview.weakness) expected = expected.mul(10);
    assert.equal(actor.damage.toString(), expected.amount.toString());
    assert.equal(actor.attackInterval, actor.weapon.attackInterval);
  }
  s.weapons.configureTest({ starLevels: [20, 20, 20] });
  assert.deepEqual(s.getLoadout().map(a => a.starLevel), [4, 9]); assert.equal(s.selectRaidWeapon(0, 0).reason, 'busy');
  assert.equal(s.getRaidState().slots[1].starLevel, 4);
});

test('Raid skips gold and rebirth damage/speed upgrades', () => {
  const f = fixture(); const base = f.session; base.weapons.grantTestWeapon(30); base.openRaid(); enter(base);
  const before = base.getLoadout().map(a => [a.damage.toString(), a.attackInterval]); exit(base);
  const upgraded = patchSaved(f, save => { save.levels = [99, 99, 0]; save.rebirth.levels = [99, 99, 0]; });
  upgraded.openRaid(); enter(upgraded);
  assert.deepEqual(upgraded.getLoadout().map(a => [a.damage.toString(), a.attackInterval]), before);
});

test('inventory relocation before entry invalidates selection without charging a ticket', () => {
  const { session: s } = fixture(); s.weapons.grantTestWeapon(30); s.weapons.grantTestWeapon(31); s.openRaid();
  s.weapons.swapBackpack(0, 1);
  assert.equal(s.startRaid().reason, 'loadoutChanged'); assert.equal(s.getRaidState().freeRemaining, 2);
  assert.equal(s.autoSelectRaidWeapons().ok, true); assert.equal(s.startRaid().ok, true);
});

test('day/week refresh is forward-only and invalidates pending ads without consuming the refreshed free tickets', () => {
  const f = fixture({ ads: true }), s = f.session; s.configureRaidTest({ freeUsed: 2 }); s.openRaid();
  const ad = s.beginRaidAd(); assert.equal(ad.ok, true);
  assert.equal(s.weapons.beginAd('daily').reason, 'adInProgress');
  f.setNow(new Date(2026, 9, 6).getTime()); assert.equal(s.completeRaidAd(ad.token, 'success').reason, 'staleAd');
  assert.equal(s.getRaidState().freeRemaining, 2); enter(s); exit(s);
  f.setNow(new Date(2026, 9, 5).getTime()); assert.equal(s.getRaidState().freeRemaining, 1);
  assert.equal(f.make().getRaidState().freeRemaining, 1);
  f.setNow(new Date(2026, 9, 12).getTime()); const newWeek = s.getRaidState();
  assert.equal(newWeek.freeRemaining, 2); assert.equal(newWeek.seasonTryCount, 0); assert.equal(newWeek.hasClaimable, false);
});

test('optional ad entry handles cancellation/failure, then succeeds once and is mutually exclusive with other modes', () => {
  const f = fixture({ ads: true }), s = f.session; s.configureRaidTest({ freeUsed: 2 }); s.openRaid();
  for (const outcome of ['cancel', 'failure']) {
    const request = s.beginRaidAd(); assert.equal(request.ok, true);
    assert.equal(s.startSpeedRun().reason, 'busy'); assert.equal(s.requestRebirth('normal').reason, 'busy');
    assert.equal(s.completeRaidAd(request.token, outcome).ok, false); assert.equal(s.getRaidState().phase, 'preparing');
    assert.equal(s.completeRaidAd(request.token, 'success').reason, 'staleAd');
  }
  let request = s.beginRaidAd(); s.cancelRaidAd(); assert.equal(s.completeRaidAd(request.token, 'success').reason, 'staleAd');
  request = s.beginRaidAd(); assert.equal(s.completeRaidAd(request.token, 'unknown').reason, 'invalid');
  f.writes.length = 0; assert.equal(s.completeRaidAd(request.token, 'success').ok, true); assert.equal(f.writes.length, 1);
  assert.equal(s.mode, 'Raid'); assert.equal(s.getRaidState().freeRemaining, 0);
  assert.equal(s.completeRaidAd(request.token, 'success').reason, 'staleAd');
  s.advanceFrame(2); exit(s); s.openRaid(); assert.equal(s.beginRaidAd().reason, 'unavailable');
});

test('cross-week runs freeze their boss and reward history, with no new-week best or mission credit', () => {
  for (const crossWhileLoading of [false, true]) {
    const f = fixture({ now: new Date(2026, 9, 11, 23, 59, 59).getTime() }), s = f.session;
    s.openRaid(); s.startRaid(); if (!crossWhileLoading) s.advanceFrame(2);
    const boss = s.getRaidState().bossIndex, season = s.getRaidState().seasonIndex;
    f.setNow(new Date(2026, 9, 12, 0, 0, 1).getTime());
    if (crossWhileLoading) s.advanceFrame(2);
    assert.equal(s.getRaidState().bossIndex, boss); assert.equal(s.getRaidState().seasonIndex, season + 1);
    f.writes.length = 0; finish(s, 10); assert.equal(f.writes.length, 1);
    const result = s.getRaidState(); assert.equal(result.seasonTryCount, 0); assert.equal(result.seasonBestLevel, 0);
    assert.equal(result.hasClaimable, false); assert.equal(s.weapons.starGems, 250);
    assert.equal(result.bestByType[WEAPON_TYPES.indexOf(result.weakness)], 10);
    assert.equal(result.freeRemaining, 2); exit(s); s.openRaid(); assert.equal(s.getRaidState().bossIndex, (boss + 1) % 5);
  }
});

test('current reload retains consumed entries but abandons unfinished runs; invalid Raid blocks cannot overwrite saves', () => {
  const f = fixture(), s = f.session; enter(s); s.getRaidBossCombat().hit(s.getRaidBossCombat().maxHealth);
  const reloaded = f.make(); assert.equal(reloaded.mode, 'Main'); assert.equal(reloaded.getRaidState().phase, 'idle');
  assert.equal(reloaded.getRaidState().freeRemaining, 1); assert.equal(reloaded.getRaidState().seasonTryCount, 1);
  assert.equal(reloaded.weapons.starGems, 0); assert.equal(reloaded.getRaidState().seasonBestLevel, 0);
  for (const raid of [undefined, { freeUsed: -1 }, null]) {
    const save = JSON.parse(f.data.get(f.key)); save.money = { digits: '1234', exponent: 0, precision: 4 }; save.raid = raid;
    const raw=JSON.stringify(save);f.data.set(f.key,raw);f.writes.length=0; const warn = console.warn; console.warn = () => {};
    let restored; try { restored = f.make(); } finally { console.warn = warn; }
    assert.equal(restored.persistenceBlocked,true);assert.equal(restored.getRaidState().freeRemaining,2);
    assert.equal(f.data.get(f.key),raw);assert.equal(f.writes.length,0);assert.equal(JSON.parse(raw).money.digits,'1234');
  }
});


test('Raid cached presentation revisions track inventory, selection, missions and season without exposing mutable cache', () => {
  const f = fixture(), s = f.session;
  const first = s.getRaidState(), second = s.getRaidState();
  assert.equal(second.candidatesRevision, first.candidatesRevision); assert.equal(second.missionsRevision, first.missionsRevision);
  assert.notEqual(first.candidates, second.candidates); assert.notEqual(first.missions, second.missions);
  first.candidates[0].source.weaponId = 64; first.missions[0].reward = -1;
  assert.notEqual(s.getRaidState().candidates[0].source.weaponId, 64); assert.notEqual(s.getRaidState().missions[0].reward, -1);
  s.weapons.grantDiamonds(1); assert.equal(s.getRaidState().candidatesRevision, second.candidatesRevision);
  s.weapons.grantTestWeapon(58); const added = s.getRaidState(); assert.ok(added.candidatesRevision > second.candidatesRevision);
  s.openRaid(); const selected = s.getRaidState(); assert.ok(selected.candidatesRevision > added.candidatesRevision);
  s.configureRaidTest({seasonTryCount: 4}); const missions = s.getRaidState(); assert.ok(missions.missionsRevision > selected.missionsRevision);
  s.claimRaidMission(0); assert.ok(s.getRaidState().missionsRevision > missions.missionsRevision);
  s.closeRaid(); const beforeSeason = s.getRaidState();
  f.setNow(NOW + 7 * 86400000); s.advanceFrame(0); const nextSeason = s.getRaidState();
  assert.ok(nextSeason.candidatesRevision > beforeSeason.candidatesRevision);
  assert.ok(nextSeason.missionsRevision > beforeSeason.missionsRevision);
});
