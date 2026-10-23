const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const build = process.env.FOREST_GUNNER_OFFLINE_TEST_BUILD || path.join(__dirname, '.build/session');
const { BattleSession, economyStorageKey } = require(path.join(build, 'session/BattleSession.js'));
const { resolveContentConfig } = require(path.join(build, 'session/ContentConfig.js'));
const { runOfflineProgress } = require(path.join(build, 'session/OfflineProgressSimulator.js'));
const { OriginalInfVal } = require(path.join(build, 'core/OriginalInfVal.js'));
const { getWeapon } = require(path.join(build, 'core/WeaponCatalog.js'));
const { getRebirthPercent } = require(path.join(build, 'session/RebirthEconomy.js'));
const { PetSystem } = require(path.join(build, 'session/PetSystem.js'));
const { SkinSystem } = require(path.join(build, 'session/SkinSystem.js'));
const { FishSystem } = require(path.join(build, 'session/FishSystem.js'));
const NOW = Date.UTC(2026, 9, 15, 4);

function fixture(environment = 'production', overrides = {}) {
  let now = NOW, failure = '', unreadable = false;
  const data = new Map(), writes = [], key = economyStorageKey(environment);
  const storage = {
    getItem(key) { if (unreadable) throw Error('offline readback'); return data.get(key) ?? null; },
    setItem(key, value) {
      if (failure === 'before') throw Error('offline before write');
      if (failure === 'silent') return;
      data.set(key, value); writes.push(JSON.parse(value));
      if (failure === 'readback') unreadable = true;
      if (failure === 'after') throw Error('offline after write');
    },
  };
  const contentConfig = resolveContentConfig(environment, { tutorialEnabled: false, adsEnabled: true, firstDrawDiamonds: 0,
    testResources: { diamonds: 0, starGems: 0, fundGoldUpgrades: false, fundRebirthUpgrades: false }, ...overrides });
  const create = () => new BattleSession({ environment, storage, contentConfig, now: () => now, rng: () => 0 });
  create();
  const saved = JSON.parse(data.get(key));
  saved.money = OriginalInfVal.fromInt(1000).toJSON();
  saved.levels = [0, 0, 0]; saved.progress = { stageIndex: 0, waveIndex: 0 };
  saved.weapons.stageValueMax = 40;
  saved.offline = { lastSavedAtMs: NOW };
  data.set(key, JSON.stringify(saved)); writes.length = 0;
  return { create, data, key, writes, storage, saved, setNow: value => { now = value; },
    fail: value => { failure = value; unreadable = false; } };
}
const savedOf = f => JSON.parse(f.data.get(f.key));
const stateOf = s => ({ money: s.moneyBalance.toString(), levels: s.snapshot({ kills: 0, totalTrees: 0, elapsed: 0, complete: false }, false).upgrades.map(u => u.level),
  stageIndex: s.round.stageIndex, waveIndex: s.round.waveIndex, history: s.weapons.serialize().stageValueMax });
const expected = seconds => runOfflineProgress({ gold: OriginalInfVal.fromInt(1000), levels: [0, 0, 0],
  stageIndex: 0, waveIndex: 0, stageValueMax: 40, weapons: [getWeapon(0), null, null], elapsedSeconds: seconds, absentSeconds: seconds });

test('cold startup freezes the restored snapshot, automatically commits the simulated final state once, and keeps history', async () => {
  const f = fixture(); f.setNow(NOW + 600000);
  const original = f.data.get(f.key), s = f.create(), before = stateOf(s);
  assert.equal(s.offlineInitializationPending, true); assert.equal(s.canFight, false);
  assert.equal(f.data.get(f.key), original, 'constructor must not replace the old checkpoint');
  assert.deepEqual(s.offlineBefore.levels, [0, 0, 0]); assert.equal(s.offlineBefore.gold.toString(), '1000');
  assert.equal(Object.isFrozen(s.offlineBefore.levels), true);
  s.save(); s.checkpointForeground(); s.advanceFrame(500); assert.equal(s.purchase('power'), false);
  assert.equal(f.writes.length, 0); assert.deepEqual(stateOf(s), before);
  const first = s.initializeOfflineProgress(), same = s.initializeOfflineProgress();
  assert.equal(first, same, 'concurrent callers join the same initialization');
  const result = await first, simulation = expected(600);
  assert.equal(result.ok, true); assert.equal(result.result, s.offlineResult);
  assert.equal(s.offlineInitializationPending, false); assert.equal(s.canFight, true);
  assert.equal(s.moneyBalance.toString(), simulation.moneyFinal.toString(), 'the displayed net gain is not awarded again');
  assert.deepEqual(stateOf(s).levels, simulation.levels);
  assert.deepEqual(savedOf(f).money, simulation.moneyFinal.toJSON());
  assert.deepEqual(savedOf(f).levels, simulation.levels);
  assert.deepEqual(savedOf(f).progress, { stageIndex: simulation.stageIndex, waveIndex: simulation.waveIndex });
  assert.equal(savedOf(f).weapons.stageValueMax, 40); assert.equal(savedOf(f).offline.lastSavedAtMs, NOW + 600000);
  assert.equal(s.offlineBefore.gold.toString(), '1000');
  const count = f.writes.length, settled = stateOf(s);
  assert.equal((await s.initializeOfflineProgress()).result, result.result);
  assert.equal(f.writes.length, count); assert.deepEqual(stateOf(s), settled);
  const reload = f.create(); assert.equal(reload.offlineInitializationPending, false);
  assert.equal((await reload.initializeOfflineProgress()).result, null); assert.deepEqual(stateOf(reload), settled);
});

test('legacy v3, malformed or future checkpoints do not manufacture an absence or discard valid progress', async () => {
  for (const offline of [undefined, null, {}, { lastSavedAtMs: 'yesterday' }, { lastSavedAtMs: -1 },
    { lastSavedAtMs: NOW + 3600001 }, { lastSavedAtMs: 1.5 }]) {
    const f = fixture(), saved = savedOf(f);
    saved.offline = offline; saved.levels = [3, 4, 5]; saved.progress = { stageIndex: 6, waveIndex: 2 };
    f.data.set(f.key, JSON.stringify(saved)); f.setNow(NOW + 3600000);
    const s = f.create();
    assert.equal(s.offlineInitializationPending, false); assert.equal((await s.initializeOfflineProgress()).result, null);
    assert.equal(s.moneyBalance.toString(), '1000'); assert.deepEqual(stateOf(s).levels, [3, 4, 5]);
    assert.equal(s.round.stageIndex, 6); assert.equal(s.round.waveIndex, 2);
    assert.equal(savedOf(f).offline.lastSavedAtMs, NOW + 3600000);
  }
});

test('the source thirty-second minimum and eight-hour cap reach session initialization', async () => {
  for (const [seconds, pending] of [[29.999, false], [30, true], [60 * 60 * 24, true]]) {
    const f = fixture(); f.setNow(NOW + seconds * 1000); const s = f.create();
    assert.equal(s.offlineInitializationPending, pending);
    const result = await s.initializeOfflineProgress(); assert.equal(result.ok, true);
    if (!pending) assert.equal(result.result, null);
    else {
      assert.equal(result.result.elapsedSeconds, Math.min(seconds, 28800));
      assert.equal(result.result.absentSeconds, seconds); assert.equal(result.result.isCapped, seconds > 28800);
    }
  }
});

test('checkpoint and hide-style saves refresh online time without settling in the running session', async () => {
  const f = fixture(), s = f.create(), before = stateOf(s);
  f.setNow(NOW + 10000); s.checkpointForeground(); assert.equal(savedOf(f).offline.lastSavedAtMs, NOW + 10000);
  f.setNow(NOW + 30000); s.save(); assert.equal(savedOf(f).offline.lastSavedAtMs, NOW + 30000);
  f.setNow(NOW + 3600000); s.checkpointForeground();
  assert.equal(s.offlineResult, null); assert.deepEqual(stateOf(s), before);
  assert.equal((await s.initializeOfflineProgress()).result, null, 'a resume is not another cold initialization');
  assert.equal(f.create().offlineInitializationPending, false, 'resuming checkpoints before a later reload');
});

test('write-before, silent write and write-after failures resolve against the same atomic candidate', async () => {
  for (const failure of ['before', 'silent', 'after']) {
    const f = fixture(); f.setNow(NOW + 600000); const s = f.create(), original = f.data.get(f.key), before = stateOf(s);
    f.fail(failure); const first = await s.initializeOfflineProgress();
    if (failure === 'after') {
      assert.equal(first.ok, true, 'a provider throwing after its atomic write still committed');
      assert.equal(s.moneyBalance.toString(), expected(600).moneyFinal.toString());
    } else {
      assert.equal(first.ok, false); assert.equal(s.offlineInitializationPending, true);
      assert.equal(f.data.get(f.key), original); assert.deepEqual(stateOf(s), before);
      f.setNow(NOW + 900000); f.fail(''); const retry = await s.initializeOfflineProgress();
      assert.equal(retry.ok, true); assert.equal(retry.result.absentSeconds, 600, 'retry reuses the frozen input and result');
      assert.equal(s.moneyBalance.toString(), expected(600).moneyFinal.toString());
    }
    f.fail(''); const count = f.writes.length; await s.initializeOfflineProgress(); assert.equal(f.writes.length, count);
  }
});

test('unknown readback blocks ordinary writers until retry recognises an already committed settlement', async () => {
  const f = fixture(); f.setNow(NOW + 600000); const s = f.create(), before = stateOf(s);
  f.fail('readback'); assert.equal((await s.initializeOfflineProgress()).ok, false);
  assert.equal(f.writes.length, 1); const committed = f.data.get(f.key);
  assert.deepEqual(stateOf(s), before); assert.equal(s.offlineInitializationPending, true);
  s.save(); s.checkpointForeground(); assert.equal(s.redeemCode('950424').ok, false);
  assert.equal(f.data.get(f.key), committed); assert.equal(f.writes.length, 1);
  f.fail(''); const result = await s.initializeOfflineProgress(); assert.equal(result.ok, true);
  assert.equal(s.moneyBalance.toString(), expected(600).moneyFinal.toString());
  const reloaded = f.create(); assert.equal(reloaded.offlineInitializationPending, false);
  assert.deepEqual(stateOf(reloaded), stateOf(s));
});

test('a save changed by another owner during initialization is preserved', async () => {
  const f = fixture(); f.setNow(NOW + 600000); const s = f.create();
  const changed = savedOf(f); changed.weapons.diamonds = 987;
  f.data.set(f.key, JSON.stringify(changed)); const external = f.data.get(f.key);
  assert.equal((await s.initializeOfflineProgress()).ok, false);
  s.save(); assert.equal(f.data.get(f.key), external); assert.equal(f.writes.length, 0);
});

test('test gold funding occurs after the offline snapshot and does not enter a repeated simulation', async () => {
  const f = fixture('test', { testResources: { diamonds: 0, starGems: 0, fundGoldUpgrades: true, fundRebirthUpgrades: false } });
  f.setNow(NOW + 600000); const s = f.create();
  assert.equal(s.moneyBalance.toString(), '1000'); assert.equal(s.offlineBefore.gold.toString(), '1000');
  const result = await s.initializeOfflineProgress();
  assert.equal(result.ok, true); assert.equal(result.result.moneyFinal.toString(), expected(600).moneyFinal.toString());
  assert.ok(s.moneyBalance.compare(result.result.moneyFinal.amount) > 0, 'test-only funding is applied after simulation');
  const balance = s.moneyBalance.toString(); await s.initializeOfflineProgress();
  assert.equal(s.moneyBalance.toString(), balance);
});

test('offline input uses saved permanent bonuses and base equipment, while slot stars and a timed mine buff stay unchanged', async () => {
  const f = fixture(), saved = savedOf(f);
  saved.weapons.equipment = [null, { weaponId: 1, locked: false, pendingAd: false }, { weaponId: 4, locked: false, pendingAd: false }];
  saved.weapons.collection[1] = true; saved.weapons.collection[4] = true; saved.weapons.starLevels = [4, 5, 6];
  saved.skins.owned[2] = true; saved.pets.owned[0] = 3; saved.pets.selected[0] = 3; saved.pets.collected[3] = true;
  saved.fish.inventory = [1]; saved.fish.collected[1] = true; saved.rebirth.levels = [3, 4, 5];
  saved.buffs.attackSpeedRemainingSeconds = 200;
  f.data.set(f.key, JSON.stringify(saved)); f.setNow(NOW + 300000);
  const pets = new PetSystem(), skins = new SkinSystem(), fish = new FishSystem();
  pets.restore(saved.pets); skins.restore(saved.skins); fish.restore(saved.fish);
  const simulation = runOfflineProgress({ gold: OriginalInfVal.fromInt(1000), levels: [0, 0, 0],
    stageIndex: 0, waveIndex: 0, stageValueMax: 40, weapons: [null, getWeapon(1), getWeapon(4)], elapsedSeconds: 300,
    modifiers: { rebirthDamage: getRebirthPercent('power', 3), rebirthSpeed: getRebirthPercent('speed', 4), rebirthMoney: getRebirthPercent('money', 5),
      skinDamage: 100 + skins.totals.damagePercent, skinSpeed: 100 + skins.totals.speedPercent, skinMoney: 100 + skins.totals.moneyPercent,
      petMoney: pets.moneyMultiplier, petSpeed: pets.moveSpeedPercent,
      fishDamage: fish.totals.damagePercent, fishCriticalChance: fish.totals.criticalChancePercent, fishCriticalDamage: fish.totals.criticalDamagePercent } });
  const s = f.create(), result = await s.initializeOfflineProgress(); assert.equal(result.ok, true);
  assert.equal(s.moneyBalance.toString(), simulation.moneyFinal.toString()); assert.deepEqual(stateOf(s).levels, simulation.levels);
  assert.deepEqual(savedOf(f).weapons.starLevels, [4, 5, 6]); assert.equal(s.attackSpeedBuffRemainingSeconds, 200);
  for (const key of ['skins', 'pets', 'fish', 'rebirth']) assert.deepEqual(savedOf(f)[key], saved[key], key);
});
