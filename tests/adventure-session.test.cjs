const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const build = process.env.FOREST_GUNNER_ADVENTURE_TEST_BUILD || path.join(__dirname, '.build/session');
const coreBuild = process.env.FOREST_GUNNER_ADVENTURE_TEST_BUILD ? path.join(build, 'core') : path.join(__dirname, '.build/core');
const { BattleSession, economyStorageKey } = require(path.join(build, 'session/BattleSession.js'));
const { resolveContentConfig } = require(path.join(build, 'session/ContentConfig.js'));
const { getUpgradeMultiplier } = require(path.join(build, 'session/UpgradeEconomy.js'));
const { getRebirthPercent, getRebirthReward } = require(path.join(build, 'session/RebirthEconomy.js'));
const { getStarPercent } = require(path.join(build, 'session/WeaponInventory.js'));
const { raidWeakness } = require(path.join(build, 'session/RaidSystem.js'));
const { runOfflineProgress, effectiveMaxOfflineSeconds } = require(path.join(build, 'session/OfflineProgressSimulator.js'));
const { OriginalInfVal: I } = require(path.join(build, 'core/OriginalInfVal.js'));
const { DecimalAmount: D } = require(path.join(build, 'core/DecimalAmount.js'));
const { getWeapon } = require(path.join(build, 'core/WeaponCatalog.js'));
const { CombatWorld } = require(path.join(coreBuild, 'index.js'));
const NOW = new Date(2026, 9, 18, 12).getTime(), HOUR = 3600000;
const owned = index => ({ kind: 'owned', index });
const selected = index => ({ kind: 'selected', index });
function fixture(edit = () => {}, options = {}) {
  let now = options.now ?? NOW, failure = '', unreadable = false, onWrite = null;
  const data = new Map(), writes = [], key = economyStorageKey('test');
  const storage = {
    getItem(k) { if (unreadable) throw Error('readback unavailable'); return data.get(k) ?? null; },
    setItem(k, raw) {
      if (failure === 'before') throw Error('write denied');
      if (failure === 'silent') return;
      data.set(k, raw); writes.push(JSON.parse(raw));
      if (onWrite) onWrite();
      if (failure === 'readback') unreadable = true;
      if (failure === 'after') throw Error('write completed before error');
    },
  };
  const contentConfig = resolveContentConfig('test', { tutorialEnabled: false, adsEnabled: options.ads ?? false, firstDrawDiamonds: 0,
    testResources: { diamonds: 0, starGems: 0, adventureTickets: 0, adventureCores: 0, fundGoldUpgrades: false, fundRebirthUpgrades: false, rebirthRewardFloorStage: 0 } });
  const make = () => new BattleSession({ environment: 'test', contentConfig, storage, now: () => now, rng: options.rng ?? (() => 0) });
  make();
  const saved = JSON.parse(data.get(key));
  saved.money = I.fromInt(1000).toJSON(); saved.weapons.stageValueMax = 400;
  saved.pets.owned = [0, 0, 1, ...Array(13).fill(-1)]; saved.pets.selected = [2, -1, -1];
  saved.pets.collected = [true, true, true, ...Array(7).fill(false)];
  edit(saved); data.set(key, JSON.stringify(saved));
  const session = make(); writes.length = 0;
  return { session, make, data, key, writes, storage, saved: () => JSON.parse(data.get(key)),
    setNow: value => { now = value; }, fail: value => { failure = value; unreadable = false; },
    onWrite: callback => { onWrite = callback; } };
}
const unlock = (saved, index, level = 0, count = 0) => { saved.relics.items[index] = { unlocked: true, level, count }; };
const coreState = s => ({ adventure: s.getAdventureState(), relics: s.getRelicState(), pets: s.getPetState() });

test('legacy broken locks recover only unavailable trips, refund once and retain an immutable original backup',()=>{
 const f=fixture(saved=>{saved.adventure.level=7;saved.adventure.tickets=17;saved.adventure.nextRunId=3;saved.adventure.cores=[31,42,53,64];
   saved.adventure.maps[0]={startedAt:NOW-3600000,runId:1,pets:[{kind:'owned',index:3,grade:0},{kind:'owned',index:1,grade:0}]};
   saved.adventure.maps[5]={startedAt:NOW-1000,runId:2,pets:[{kind:'selected',index:0,grade:2}]};
 });
 const s=f.session,backupKey=f.key+':adventure-pet-lock-backup',backup=f.data.get(backupKey);
 assert.ok(backup);assert.equal(JSON.parse(backup).adventure.maps[0].pets.length,2);
 assert.equal(s.getAdventureState().saveInvalid,false);assert.equal(s.getAdventureState().tickets,19);
 assert.equal(s.getAdventureState().maps[0].pets.length,0);assert.equal(s.getAdventureState().maps[5].runId,2);
 assert.deepEqual(s.getAdventureState().cores,[31,42,53,64]);assert.equal(s.getPetState().selectedLocked[0],true);
 assert.equal(s.getPetState().ownedLocked[1],false);assert.equal(s.mergePets(0,1).ok,true);
 assert.equal(s.drawRelic(0).ok,true);assert.equal(s.startAdventure(2,0,[owned(2)]).ok,true);
 const reloaded=f.make();assert.equal(reloaded.getAdventureState().tickets,18);assert.equal(f.data.get(backupKey),backup);
 assert.deepEqual(reloaded.getPetState().owned,s.getPetState().owned);assert.equal(reloaded.getPetState().selectedLocked[0],true);
});

test('legacy lock recovery preserves over-cap ticket refunds and does not invent cores or experience',()=>{
 const f=fixture(saved=>{saved.adventure.tickets=20;saved.adventure.nextRunId=2;saved.adventure.exp=12;
   saved.adventure.maps[0]={startedAt:NOW-3600000,runId:1,pets:[{kind:'owned',index:0,grade:9}]};});
 assert.equal(f.session.getAdventureState().tickets,21);assert.equal(f.session.getAdventureState().exp,12);
 assert.deepEqual(f.session.getAdventureState().cores,[0,0,0,0]);assert.equal(f.make().getAdventureState().tickets,21);
 assert.equal(f.session.getPetState().owned[0],0);
});

test('lock recovery cannot overwrite the source save if its backup fails',()=>{
 const f=fixture(),raw=f.saved();raw.adventure.nextRunId=2;raw.adventure.maps[0]={startedAt:NOW,runId:1,pets:[{kind:'owned',index:3,grade:0}]};
 f.data.set(f.key,JSON.stringify(raw));const before=f.data.get(f.key),write=f.storage.setItem;
 for(const failure of ['silent','throw']){
   f.storage.setItem=(key,value)=>{if(key.endsWith(':adventure-pet-lock-backup')){if(failure==='throw')throw Error('quota');return;}write(key,value);};
   const s=f.make();assert.equal(s.getAdventureState().saveInvalid,true);s.save();assert.equal(f.data.get(f.key),before);
 }
 f.storage.setItem=write;assert.equal(f.make().getAdventureState().saveInvalid,false);
 assert.equal(f.saved().adventure.tickets,21);
});

test('dispatch saves ticket debit and pet identity together, restores locks and settles each trip once', () => {
  const f = fixture(), s = f.session, pets = f.saved().pets;
  assert.equal(s.startAdventure(0, 0, [selected(0)]).ok, true);
  assert.equal(f.writes.length, 1); assert.equal(s.getAdventureState().tickets, 19);
  assert.equal(s.getPetState().selectedLocked[0], true);
  assert.deepEqual(f.saved().pets, pets, 'dispatch does not move or delete its source pet');
  assert.equal(s.unequipPet(0).reason, 'locked');
  const reload = f.make(); assert.equal(reload.getPetState().selectedLocked[0], true);
  f.setNow(NOW + HOUR); const preview = reload.getAdventureState().maps[0];
  assert.equal(preview.status, 'finished');
  const result = reload.claimAdventure(0, 0); assert.equal(result.ok, true);
  assert.equal(reload.getAdventureState().cores[0], preview.rewardCore);
  assert.equal(reload.getAdventureState().exp, preview.rewardExp);
  assert.equal(reload.getPetState().selectedLocked[0], false);
  assert.equal(reload.claimAdventure(0, 0).ok, false);
  assert.equal(f.saved().adventure.cores[0], result.coreGain);
});

test('cancellation releases locks without refund or payout and locked pets cannot move or merge', () => {
  const f = fixture(), s = f.session;
  assert.equal(s.startAdventure(0, 0, [owned(0)]).ok, true);
  assert.equal(s.mergePets(0, 1).reason, 'locked');
  assert.equal(s.equipPet(0, 1).reason, 'locked');
  assert.equal(s.movePet(owned(1), owned(0)).reason, 'locked');
  assert.equal(s.cancelAdventure(0, 0).ok, true);
  assert.equal(s.getAdventureState().tickets, 19); assert.deepEqual(s.getAdventureState().cores, [0, 0, 0, 0]);
  assert.equal(s.getPetState().ownedLocked[0], false); assert.equal(s.mergePets(0, 1).ok, true);
});

test('silent and failed writes publish no dispatch, draw or upgrade; write-then-throw publishes one durable candidate', () => {
  for (const failure of ['before', 'silent']) {
    const f = fixture(saved => { saved.adventure.cores[0] = 80; unlock(saved, 0, 0, 2); }), s = f.session;
    const before = coreState(s), raw = f.data.get(f.key); f.fail(failure);
    assert.equal(s.startAdventure(0, 0, [owned(0)]).reason, 'saveFailed');
    assert.equal(s.drawRelic(0).reason, 'saveFailed'); assert.equal(s.upgradeRelic(0).reason, 'saveFailed');
    assert.deepEqual(coreState(s), before); assert.equal(f.data.get(f.key), raw);
  }
  const f = fixture(saved => { saved.adventure.cores[0] = 60; }), s = f.session;
  f.fail('after'); assert.equal(s.drawRelic(0).ok, true);
  assert.equal(s.getAdventureState().cores[0], 40); assert.equal(s.getRelicState().items[0].unlocked, true);
  assert.equal(f.writes.length, 1); f.fail(''); assert.equal(f.make().getAdventureState().cores[0], 40);
});

test('an unreadable committed candidate is preserved until reload and prevents old state overwrites', () => {
  const f = fixture(), s = f.session; f.fail('readback');
  assert.equal(s.startAdventure(0, 0, [owned(0)]).reason, 'saveFailed');
  assert.equal(s.getPetState().ownedLocked[0], false);
  const committed = f.data.get(f.key); s.save(); s.checkpointForeground();
  assert.equal(s.startAdventure(1, 0, [owned(1)]).reason, 'saveFailed');
  assert.equal(f.data.get(f.key), committed); f.fail('');
  assert.equal(f.make().getPetState().ownedLocked[0], true); assert.equal(f.saved().adventure.tickets, 19);
});

test('nested settlement during storage callbacks cannot double-spend or change the gold candidate', () => {
  const f = fixture(saved => { saved.adventure.cores[0] = 80; }), s = f.session; let nested;
  f.onWrite(() => { nested = [s.drawRelic(0), s.startAdventure(0, 0, [owned(0)]), s.purchase('power')]; });
  assert.equal(s.drawRelic(0).ok, true); assert.deepEqual(nested.map(x => typeof x === 'boolean' ? x : x.reason), ['busy', 'busy', false]);
  assert.equal(f.writes.length, 1); assert.equal(f.saved().adventure.cores[0], 60); assert.equal(s.moneyBalance.toString(), '1000');
});

test('reentrant public inventory changes cannot publish a partial whole-save candidate or erase its trip', () => {
  const f = fixture(), s = f.session;
  f.onWrite(() => s.weapons.grantDiamonds(10));
  assert.equal(s.startAdventure(0, 0, [owned(0)]).reason, 'saveFailed');
  const committed = f.data.get(f.key); assert.equal(f.saved().adventure.tickets, 19);
  assert.equal(s.getPetState().ownedLocked[0], false); s.save(); assert.equal(f.data.get(f.key), committed);
  f.onWrite(null); assert.equal(f.make().getPetState().ownedLocked[0], true);
});

test('ability upgrade alerts stay on individual cards; entry only signals cores or finished trips', () => {
  const f = fixture(saved => unlock(saved, 0, 0, 2)), s = f.session;
  assert.equal(s.getAdventureState().mapAlert, false); assert.equal(s.getAdventureState().coreAlert, false);
  assert.equal(s.getAdventureState().relicAlert, true); assert.equal(s.getRelicState().items[0].canUpgrade, true);
  assert.equal(s.getAdventureState().alert, false);
  s.upgradeRelic(0); assert.equal(s.getAdventureState().relicAlert, false); assert.equal(s.getAdventureState().alert, false);
  assert.equal(s.getRelicState().items[0].canUpgrade, false);
  const cores = fixture(saved => { saved.adventure.cores[0] = 20; });
  assert.equal(cores.session.getAdventureState().alert, true);
  const trip = fixture(); trip.session.startAdventure(0, 0, [owned(0)]);
  assert.equal(trip.session.getAdventureState().alert, false);
  trip.setNow(NOW + HOUR); assert.equal(trip.session.getAdventureState().alert, true);
});

test('ability max draw and upgrade debit their own currencies in one save and effects update immediately', () => {
  const f = fixture(saved => { saved.adventure.cores[0] = 80; }), s = f.session;
  const result = s.drawRelic(0, true); assert.equal(result.drawn.length, 4); assert.equal(result.spent, 80);
  assert.equal(s.getRelicState().items[0].count, 3); assert.equal(s.getAdventureState().cores[0], 0);
  assert.equal(s.upgradeRelic(0).ok, true); assert.equal(s.getRelicState().items[0].displayLevel, 2);
  assert.equal(s.getRelicState().items[0].count, 1); assert.equal(s.getRelicState().damagePercent, '110');
  assert.equal(f.make().getRelicState().items[0].displayLevel, 2); assert.equal(f.writes[0].relics.items[0].count, 3);
});

test('optional v3 blocks migrate neutrally, malformed blocks remain isolated and byte-equivalent as JSON values', () => {
  const legacy = fixture(saved => { delete saved.adventure; delete saved.relics; });
  assert.equal(legacy.session.moneyBalance.toString(), '1000'); assert.equal(legacy.session.getAdventureState().tickets, 20);
  assert.equal(legacy.session.getRelicState().damagePercent, '100');
  const broken = { version: 91, future: ['preserve', { record: 7 }] };
  for (const block of ['adventure', 'relics']) {
    const f = fixture(saved => { saved[block] = broken; });
    assert.equal(f.session.moneyBalance.toString(), '1000'); assert.equal(f.session.drawRelic(0).reason, 'invalidSave');
    if (block === 'adventure') assert.equal(f.session.movePet(owned(0), owned(3)).reason, 'invalidSave');
    else assert.equal(f.session.startAdventure(0, 0, [owned(0)]).ok, true);
    f.session.checkpointForeground(); assert.deepEqual(f.saved()[block], broken);
  }
});

test('ads default off; successful reduction is exactly once and failure or cancellation consumes no allowance', () => {
  const off = fixture(); off.session.startAdventure(0, 0, [owned(0)]);
  assert.equal(off.session.beginAdventureAd(0, 0).ok, false);
  const f = fixture(() => {}, { ads: true }), s = f.session; s.startAdventure(0, 0, [owned(0)]);
  for (const outcome of ['cancel', 'failure']) {
    const request = s.beginAdventureAd(0, 0); assert.equal(request.ok, true);
    assert.equal(s.completeAdventureAd(request.token, outcome).ok, false); assert.equal(s.getAdventureState().adRemaining, 2);
  }
  const request = s.beginAdventureAd(0, 0); assert.equal(s.cancelAdventure(0, 0).reason, 'busy');
  assert.equal(s.startBoss().reason, 'busy'); assert.equal(s.openRaid().reason, 'busy'); assert.equal(s.startSpeedRun().reason, 'busy');
  assert.equal(s.completeAdventureAd(request.token, 'success').ok, true);
  assert.equal(s.getAdventureState().maps[0].remainingMs, HOUR / 2); assert.equal(s.getAdventureState().adRemaining, 1);
  assert.equal(s.completeAdventureAd(request.token, 'success').reason, 'staleAd');
  const next = s.beginAdventureAd(0, 0); assert.equal(s.completeAdventureAd(next.token, 'success').ok, true);
  assert.equal(s.getAdventureState().maps[0].status, 'finished'); assert.equal(s.getAdventureState().adRemaining, 0);
});

test('ad callbacks reject elapsed targets, crossed local dates, backwards clocks and cancelled identities', () => {
  for (const kind of ['finished', 'midnight', 'backwards', 'cancelled', 'mode']) {
    const start = kind === 'midnight' ? new Date(2026, 9, 18, 23, 59).getTime() : NOW;
    const f = fixture(() => {}, { ads: true, now: start }), s = f.session;
    s.startAdventure(0, 0, [owned(0)]); const request = s.beginAdventureAd(0, 0);
    if (kind === 'finished') f.setNow(start + HOUR);
    else if (kind === 'midnight') f.setNow(start + 120000);
    else if (kind === 'backwards') f.setNow(start - 1);
    else if (kind === 'mode') s.setMode('Boss');
    else { s.cancelAdventureAd(); s.cancelAdventure(0, 0); s.startAdventure(0, 0, [owned(0)]); }
    assert.equal(s.completeAdventureAd(request.token, 'success').ok, false, kind);
    assert.equal(f.saved().adventure.adUsed, 0, kind);
  }
});

test('invalid clocks cannot turn the snapshot fallback into a free elapsed dispatch or consume an ad', () => {
  for (const now of [NaN, Infinity, -1, NOW + 0.25, new Date(10000, 0, 1).getTime()]) {
    const f = fixture(() => {}, { ads: true }), s = f.session, before = f.data.get(f.key);
    f.setNow(now); assert.doesNotThrow(() => s.getAdventureState());
    assert.equal(s.startAdventure(0, 0, [owned(0)]).reason, 'invalidTime');
    assert.equal(s.beginAdventureAd(0, 0).reason, 'invalidTime'); assert.equal(f.data.get(f.key), before);
  }
});

test('relic damage, critical precision, currency and movement apply in source order; Mine disables damage and critical', () => {
  const f = fixture(saved => {
    for (const index of [0, 1, 2, 5, 6, 7, 10, 11, 12, 13]) unlock(saved, index, index === 13 ? 20 : 36);
    saved.levels = [7, 4, 3]; saved.rebirth.levels = [5, 0, 8]; saved.weapons.starLevels = [2, 0, 0];
    saved.weapons.equipment[0].weaponId = 16; saved.weapons.collection[16] = true;
  }), s = f.session, totals = s.relics.totals, weapon = getWeapon(16);
  const expected = I.fromSerialized({ digits: '800', exponent: 0, precision: 3 }).mul(getUpgradeMultiplier('power', 7)).div(100)
    .mul(getRebirthPercent('power', 5)).div(100).mul(100).div(100).mul(100).div(100).mul(totals.damage).div(100)
    .discardDecimal().mul(getStarPercent(2)).div(100);
  assert.equal(s.combatLoadout[0].damage.toString(), expected.toString());
  const entry = { ...s.combatLoadout[0], criticalChance: 1, criticalMultiplier: 1.53 }, world = new CombatWorld(5);
  world.setLoadout([entry]); world.fire();
  const crit = expected.mul(153).div(100).mul(totals.criticalDamage).div(100).discardDecimal();
  assert.equal(world.bullets[0].damage.toString(), crit.toString()); assert.equal(world.bullets[0].damagePrecision, crit.precision);
  const reward = I.fromSerialized({ digits: '567', exponent: 0, precision: 3 }).mul(getUpgradeMultiplier('money', 3)).div(100)
    .mul(getRebirthPercent('money', 8)).div(100).mul(s.pets.moneyMultiplier).div(100).mul(100).div(100).mul(totals.money).div(100);
  const actual = s.consume([{ type: 'treeDied', treeId: 991, position: { x: 0, z: 0 }, sourceTime: 1 }],
    [{ id: 991, alive: false, reward: D.from(567), rewardPrecision: 3 }]);
  assert.equal(actual[0].amount.toString(), reward.toString());
  assert.equal(s.movementSpeedPercent, s.getPetState().moveSpeedPercent + 42); assert.equal(s.petMovementPercent, s.movementSpeedPercent);
  s.setMode('Mine'); assert.equal(s.combatLoadout[0].damage.toString(), '1'); assert.equal(s.combatLoadout[0].criticalChance, 0);
  assert.equal(s.movementSpeedPercent, s.getPetState().moveSpeedPercent + 42);
  s.setMode('Boss'); const boss = I.fromAmount(D.from(weapon.damage), 3).mul(getRebirthPercent('power', 5)).div(100)
    .mul(100).div(100).mul(100).div(100).mul(totals.damage).div(100).discardDecimal().mul(getStarPercent(2)).div(100);
  assert.equal(s.combatLoadout[0].damage.toString(), boss.toString());
});

test('Raid freezes relic damage before stars and weakness and retains a separate critical percent', () => {
  const f = fixture(saved => { unlock(saved, 0, 30); unlock(saved, 10, 20); saved.weapons.starLevels = [2, 0, 0]; }), s = f.session;
  assert.equal(s.openRaid().ok, true); assert.equal(s.startRaid().ok, true);
  const entry = s.combatLoadout[0], w = entry.weapon;
  let damage = I.fromAmount(D.from(w.damage), w.damage.split(/[eE]/)[0].length).mul(100).div(100).mul(100).div(100)
    .mul(s.relics.totals.damage).div(100).discardDecimal().mul(getStarPercent(2)).div(100);
  if (w.type === raidWeakness(s.getRaidState().bossIndex)) damage = damage.mul(10);
  assert.equal(entry.damage.toString(), damage.toString()); assert.equal(entry.criticalRelicPercent.toString(), s.relics.totals.criticalDamage.toString());
});

test('restored abilities extend offline limit before simulation and supply all original combat and money factors', async () => {
  const f = fixture(saved => { for (const index of [0, 5, 10, 8, 13]) unlock(saved, index, 3); });
  f.setNow(NOW + 20 * HOUR); const s = f.make();
  assert.equal(s.offlineInitializationPending, true); assert.equal(s.offlineInput.elapsedSeconds, effectiveMaxOfflineSeconds(40));
  assert.equal(s.offlineInput.modifiers.relicDamage.toString(), s.relics.totals.damage.toString());
  assert.equal(s.offlineInput.modifiers.relicCriticalDamage.toString(), s.relics.totals.criticalDamage.toString());
  assert.equal(s.offlineInput.modifiers.relicMoney.toString(), s.relics.totals.money.toString());
  assert.equal(s.offlineInput.modifiers.petSpeed, s.getPetState().moveSpeedPercent, 'offline source excludes relic movement');
  const expected = runOfflineProgress(s.offlineInput), result = await s.initializeOfflineProgress();
  assert.equal(result.ok, true); assert.equal(s.moneyBalance.toString(), expected.moneyFinal.toString());
  assert.equal(s.offlineResult.elapsedSeconds, effectiveMaxOfflineSeconds(40));
});

test('rebirth preserves trips and abilities; true skip totals stay visible while execution clamps and external adapters remain usable', () => {
  const f = fixture(saved => {
    saved.progress = { stageIndex: 3, waveIndex: 0 }; saved.speedRun.stage = 1;
    for (const index of [4, 9, 14]) unlock(saved, index, 50);
    unlock(saved, 3, 8); unlock(saved, 13, 2);
  }), s = f.session;
  assert.equal(s.getRelicState().skipPercent, 306); assert.equal(s.progression.options.skipPercent, 100);
  assert.equal(s.getRebirthState().reward.toString(), getRebirthReward({ stageIndex: 3, waveIndex: 0 }, 145).toString());
  s.setRebirthModifiers({ rewardPercent: 180 }); s.setProgressionModifiers({ skipPercent: 7 });
  assert.equal(s.getRebirthState().reward.toString(), getRebirthReward({ stageIndex: 3, waveIndex: 0 }, 180).toString()); assert.equal(s.progression.options.skipPercent, 100);
  assert.equal(s.startAdventure(0, 0, [owned(0)]).ok, true);
  const saved = f.saved(); assert.equal(s.requestRebirth('normal').ok, true); assert.ok(s.advanceRebirth(2));
  assert.deepEqual(f.saved().adventure, saved.adventure); assert.deepEqual(f.saved().relics, saved.relics);
  assert.equal(s.getPetState().ownedLocked[0], true); assert.equal(s.rebirth.rewardPercent, 180);
});
