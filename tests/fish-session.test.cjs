const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');
const { ContentUnlockManager } = require('./.build/session/session/ContentUnlockManager.js');
const { getUpgradeMultiplier } = require('./.build/session/session/UpgradeEconomy.js');
const { getRebirthPercent } = require('./.build/session/session/RebirthEconomy.js');
const { getStarPercent, AD_WEAPON_DURATION_MS } = require('./.build/session/session/WeaponInventory.js');
const { getWeapon } = require('./.build/session/core/WeaponCatalog.js');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { OriginalInfVal: I } = require('./.build/session/core/OriginalInfVal.js');
const { CombatWorld } = require('./.build/core/index.js');
const { economyModules } = require('./support/economy-modules.cjs');
const NOW = new Date(2026, 9, 15, 12).getTime();
const DAY = '2026-10-15';
const fishSave = (inventory = [], extra = {}) => ({ inventory, collected: Array(13).fill(false), autoEnabled: false,
  freeDrawDate: '', freeDrawCount: 0, ...extra });
function fixture({ environment = 'test', ads = true, patch, overrides = {}, load } = {}) {
  let now = NOW, random = 0;
  const data = new Map(), writes = [], key = economyStorageKey(environment);
  const storage = { getItem: k => data.get(k) ?? null, setItem(k, v) { data.set(k, v); writes.push(JSON.parse(v)); } };
  const Session = load ? load('session/BattleSession').BattleSession : BattleSession;
  const content = load ? load('session/ContentConfig').resolveContentConfig : resolveContentConfig;
  const config = content(environment, { tutorialEnabled: false, adsEnabled: ads, firstDrawDiamonds: 0,
    testResources: { diamonds: 0, starGems: 0, fundGoldUpgrades: false, fundRebirthUpgrades: false }, ...overrides });
  const make = () => new Session({ environment, storage, contentConfig: config, now: () => now, rng: () => random });
  let session = make();
  if (patch) { const state = JSON.parse(data.get(key)); patch(state); data.set(key, JSON.stringify(state)); session = make(); }
  writes.length = 0;
  return { session, storage, data, key, writes, make, setNow: t => { now = t; }, setRandom: r => { random = r; } };
}
function draws(s, count = 3) { for (let i = 0; i < count; i++) assert.equal(s.drawFish('free').ok, true); }
function silent(action) { const warn = console.warn; console.warn = () => {}; try { return action(); } finally { console.warn = warn; } }

test('fish uses original 4/6 historical stage visibility/unlock and tutorial gating', () => {
  const c = new ContentUnlockManager(resolveContentConfig('production', { adsEnabled: true }));
  for (const [stageValueMax, visible, unlocked] of [[29, false, false], [30, true, false], [49, true, false], [50, true, true]]) {
    const state = c.get('fish', { stageValueMax, tutorialCompleted: true });
    assert.equal(state.visible, visible); assert.equal(state.unlocked, unlocked);
  }
  assert.equal(c.get('fish', { stageValueMax: 1000, tutorialCompleted: false }).visible, false);
  const f = fixture({ environment: 'production', patch: s => { s.weapons.stageValueMax = 49; s.weapons.diamonds = 200; } });
  assert.equal(f.session.drawFish('free').reason, 'contentLocked'); assert.equal(f.writes.length, 0);
  f.session.weapons.recordStageValue(50); assert.equal(f.session.drawFish('diamonds').ok, true);
  assert.equal(f.session.weapons.diamonds, 0); assert.equal(f.make().getFishState().inventory.length, 1);
});

test('fish daily three free and two ads settle once; cancellation, failure and stale tokens do not consume', () => {
  const f = fixture(), s = f.session; draws(s);
  assert.equal(f.writes.length, 3); assert.equal(s.drawFish('free').reason, 'adRequired');
  for (const outcome of ['cancel', 'failure']) {
    const before = s.getFishState(), ad = s.beginFishAd(); assert.equal(ad.ok, true);
    assert.equal(s.completeFishAd(ad.token, outcome).ok, false); assert.deepEqual(s.getFishState(), before);
    assert.equal(s.completeFishAd(ad.token, 'success').reason, 'staleAd');
  }
  let ad = s.beginFishAd(); assert.equal(s.completeFishAd('other', 'success').reason, 'staleAd');
  assert.equal(s.completeFishAd(ad.token, 'invalid').reason, 'invalidAdOutcome');
  assert.equal(s.beginFishAd().reason, 'busy');
  assert.equal(s.completeFishAd(ad.token, 'success').ok, true);
  assert.equal(s.completeFishAd(ad.token, 'success').reason, 'staleAd');
  ad = s.beginFishAd(); assert.equal(s.completeFishAd(ad.token, 'success').ok, true);
  assert.equal(s.getFishState().freeDrawRemaining, 0); assert.equal(s.getFishState().inventory.length, 5);
  assert.equal(s.beginFishAd().reason, 'dailyLimit'); assert.equal(f.writes.length, 5);
  assert.equal(f.make().getFishState().freeDrawRemaining, 0); assert.equal(f.make().getFishState().inventory.length, 5);
});

test('fish ad callback cannot cross dates or time rollback; unavailable ads retain earned quota', () => {
  const f = fixture(), s = f.session; draws(s); const ad = s.beginFishAd();
  f.setNow(NOW + 86400000); assert.equal(s.completeFishAd(ad.token, 'success').reason, 'staleAd');
  assert.equal(s.getFishState().inventory.length, 3); assert.equal(s.getFishState().freeDrawRemaining, 5);
  draws(s); const second = s.beginFishAd(); f.setNow(NOW + 86400000 - 1);
  assert.equal(s.completeFishAd(second.token, 'success').reason, 'staleAd'); assert.equal(s.getFishState().inventory.length, 6);
  const disabled = fixture({ ads: false }).session; draws(disabled);
  assert.equal(disabled.beginFishAd().reason, 'adsDisabled'); assert.equal(disabled.getFishState().freeDrawRemaining, 2);
});

test('fish diamond draw shares one durable wallet commit, and full tank cannot spend currency or quota', () => {
  const f = fixture({ patch: s => { s.weapons.diamonds = 400; } }), s = f.session;
  f.setRandom(.9); assert.equal(s.drawFish('diamonds').grade, 3); assert.equal(s.weapons.diamonds, 200);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].weapons.diamonds, 200); assert.deepEqual(f.writes[0].fish.inventory, [3]);
  assert.equal(f.make().weapons.diamonds, 200); assert.deepEqual(f.make().getFishState().inventory, [3]);
  const full = fixture({ patch: state => { state.fish = fishSave(Array(20).fill(0)); state.weapons.diamonds = 500; } });
  assert.equal(full.session.drawFish('diamonds').reason, 'full'); assert.equal(full.session.drawFish('free').reason, 'full');
  assert.equal(full.session.weapons.diamonds, 500); assert.equal(full.session.getFishState().freeDrawRemaining, 5); assert.equal(full.writes.length, 0);
});

test('fish transaction detects failed storage and reentrant writes before publishing wallet/inventory', () => {
  for (const behavior of ['throw', 'drop', 'afterWrite', 'readFail', 'reenter']) {
    const f = fixture({ patch: s => { s.weapons.diamonds = 400; } }), before = f.session.getFishState();
    const write = f.storage.setItem; let nested;
    f.storage.setItem = (k, v) => {
      if (behavior === 'reenter') nested = f.session.drawFish('diamonds');
      if (behavior === 'throw') throw Error('quota');
      if (behavior !== 'drop') write(k, v);
      if (behavior === 'afterWrite') throw Error('after write');
      if (behavior === 'readFail') f.storage.getItem = () => { throw Error('read'); };
    };
    const result = silent(() => f.session.drawFish('diamonds')), committed = behavior === 'afterWrite' || behavior === 'reenter';
    assert.equal(result.ok, committed, behavior);
    if (committed) { assert.equal(f.session.weapons.diamonds, 200); assert.deepEqual(f.session.getFishState().inventory, [1]); }
    else { assert.equal(result.reason, 'saveFailed'); assert.deepEqual(f.session.getFishState(), before); }
    if (nested) assert.equal(nested.reason, 'busy');
  }
});

test('failed fish ad settlement preserves the earned quota and a fresh token can retry durably', () => {
  const f = fixture(), s = f.session; draws(s); const before = s.getFishState(), write = f.storage.setItem;
  f.storage.setItem = () => { throw Error('quota'); };
  const ad = s.beginFishAd(); assert.equal(ad.ok, true);
  assert.equal(silent(() => s.completeFishAd(ad.token, 'success')).reason, 'saveFailed');
  assert.deepEqual(s.getFishState(), before); assert.equal(s.completeFishAd(ad.token, 'success').reason, 'staleAd');
  f.storage.setItem = write;
  const retry = s.beginFishAd(); assert.equal(s.completeFishAd(retry.token, 'success').ok, true);
  assert.equal(f.make().getFishState().freeDrawCount, 4); assert.equal(f.make().getFishState().inventory.length, 4);
});

test('fish same-grade index shifts cannot apply stale drag/drop or release confirmation', () => {
  const f = fixture({ patch: s => { s.fish = fishSave([0, 0, 0, 0]); } }), s = f.session, state = s.getFishState();
  assert.equal(s.removeFish(0, 0, state.revision).ok, true);
  const before = s.getFishState();
  assert.equal(s.removeFish(1, 0, state.revision).reason, 'stale');
  assert.equal(s.mergeFish(0, 1, 0, false, state.revision).reason, 'stale'); assert.deepEqual(s.getFishState(), before);
  assert.equal(s.mergeFish(0, 1, 0, false, before.revision).grade, 1); assert.deepEqual(f.make().getFishState().inventory, [0, 1]);
});

test('missing or invalid fish saves block overwrites; current saves survive rebirth and keep wallets isolated', () => {
  silent(() => {
    for (const fish of [undefined, null, {}, fishSave([13]), fishSave([], { freeDrawCount: -1 })]) {
      const f = fixture({ environment: 'production', patch: s => { s.fish = fish; s.weapons.diamonds = 731; s.levels = [7, 8, 9]; } });
      const raw = f.data.get(f.key); assert.equal(f.session.persistenceBlocked, true);
      if (fish !== undefined) assert.equal(f.session.weapons.diamonds, 731);
      assert.deepEqual(f.session.getFishState().inventory, []);
      assert.deepEqual(JSON.parse(f.data.get(f.key)).levels, [7, 8, 9]);
      f.session.save(); assert.equal(f.data.get(f.key), raw);
    }
  });
  const f = fixture({ patch: s => { s.fish = fishSave([4, 7], { autoEnabled: true, freeDrawDate: DAY, freeDrawCount: 4 }); } });
  const before = f.session.getFishState();
  assert.equal(f.session.configureProgressionTest({ stageIndex: 2, waveIndex: 0, stageValueMax: 50 }), true);
  assert.equal(f.session.requestRebirth('normal').ok, true); assert.equal(f.session.drawFish('free').reason, 'busy');
  f.session.advanceRebirth(2);
  const restored = f.make().getFishState(); assert.deepEqual(restored.inventory, before.inventory);
  assert.equal(restored.freeDrawCount, 4); assert.equal(restored.autoEnabled, true);
  assert.deepEqual(new BattleSession({ storage: f.storage }).getFishState().inventory, []);
});

test('fish and weapon ads lock each other and prevent mode changes, pet and skin mutations', () => {
  const f = fixture({ patch: s => { s.weapons.diamonds = 999; } }), s = f.session; draws(s);
  let weaponAd = s.weapons.beginAd('daily'); assert.equal(weaponAd.ok, true);
  assert.equal(s.beginFishAd().reason, 'busy'); assert.equal(s.drawFish('diamonds').reason, 'busy');
  s.weapons.completeAd(weaponAd.token, 'cancel');
  let ad = s.beginFishAd(); assert.equal(ad.ok, true);
  assert.equal(s.weapons.beginAd('daily').reason, 'adInProgress');
  assert.equal(s.drawPet('diamonds').reason, 'busy'); assert.equal(s.purchaseSkin(1).reason, 'busy');
  assert.equal(s.startBoss().reason, 'busy'); assert.equal(s.startSpeedRun().reason, 'busy'); assert.equal(s.openRaid().reason, 'busy');
  assert.equal(s.requestRebirth('normal').reason, 'busy'); s.cancelFishAd();
  assert.equal(s.completeFishAd(ad.token, 'success').reason, 'staleAd'); assert.equal(s.weapons.beginAd('daily').ok, true);
});

test('fish ad cancellation, success and failure immediately release delayed weapon offer expiry', () => {
  for (const outcome of ['success', 'cancel', 'failure', 'explicit']) {
    const f = fixture({ patch: s => {
      s.weapons.backpack[0] = { weaponId: 8, locked: false, pendingAd: true };
      s.weapons.adGunExpiresAt = NOW + AD_WEAPON_DURATION_MS; s.weapons.adGunOffered = true;
    } }), s = f.session; draws(s); const ad = s.beginFishAd(); assert.equal(ad.ok, true);
    f.setNow(NOW + AD_WEAPON_DURATION_MS); s.weapons.tick(); assert.equal(s.weapons.serialize().backpack[0].pendingAd, true);
    if (outcome === 'explicit') s.cancelFishAd(); else s.completeFishAd(ad.token, outcome);
    assert.equal(s.weapons.serialize().backpack[0], null, outcome); assert.equal(s.weapons.serialize().adGunExpiresAt, 0);
  }
});

test('configured fish price and quality reach the same shared wallet and quota without erasing old claims', () => {
  const load = economyModules(c => { Object.assign(c.fish, { drawPrice: 70, freeDrawsPerDay: 2, noAdDrawsPerDay: 1,
    premiumBaseGrade: 3, freeBaseGrade: 2, drawGradePercents: [0, 0, 100, 0] }); });
  const f = fixture({ load, patch: s => { s.weapons.diamonds = 140; } }), s = f.session;
  assert.equal(s.drawFish('diamonds').grade, 5); assert.equal(s.weapons.diamonds, 70); assert.equal(s.getFishState().drawPrice, 70);
  assert.equal(s.drawFish('free').grade, 4); assert.equal(s.drawFish('free').reason, 'adRequired');
  const ad = s.beginFishAd(); assert.equal(s.completeFishAd(ad.token, 'success').grade, 4);
  assert.equal(f.make().getFishState().freeDrawRemaining, 0); assert.equal(f.make().weapons.diamonds, 70);
  const reduced = fixture({ load, patch: state => { state.fish = fishSave([0], { freeDrawDate: DAY, freeDrawCount: 5 }); } });
  assert.equal(reduced.session.getFishState().freeDrawCount, 5); assert.equal(reduced.session.drawFish('free').reason, 'dailyLimit');
});

test('fish damage and critical bonuses apply in Main, SpeedRun, Boss and Raid in native operation order', () => {
  for (const mode of ['Main', 'SpeedRun', 'Boss', 'Raid']) {
    const f = fixture({ patch: s => {
      s.fish = fishSave([0, 1]); s.levels = [13, 7, 0]; s.rebirth.levels = [5, 21, 0];
      s.skins.owned[1] = true; s.weapons.equipment[0].weaponId = 16; s.weapons.collection[16] = true; s.weapons.starLevels = [1, 0, 0];
    } }), s = f.session;
    if (mode === 'Raid') { assert.equal(s.openRaid().ok, true); assert.equal(s.startRaid().ok, true); s.advanceFrame(2); }
    else if (mode !== 'Main') { assert.equal(s[`start${mode}`]().ok, true); s.advanceFrame(2); }
    const actor = s.getLoadout()[0], weapon = getWeapon(16), precision = weapon.damage.split(/[eE]/)[0].length;
    // Cat.Balance_Reload: upgrades (Main/SpeedRun only), rebirth (not Raid), skin, fish, relic, integer cut, stars, Raid weakness.
    let expected = I.fromAmount(D.from(weapon.damage), precision);
    if (mode === 'Main' || mode === 'SpeedRun') expected = expected.mul(getUpgradeMultiplier('power', 13)).div(100);
    if (mode !== 'Raid') expected = expected.mul(getRebirthPercent('power', 5)).div(100);
    expected = expected.mul(116).div(100).mul(116).div(100).mul(100).div(100).discardDecimal().mul(getStarPercent(1)).div(100);
    if (mode === 'Raid' && weapon.type === s.getRaidState().weakness) expected = expected.mul(10);
    assert.equal(actor.damage.toString(), expected.amount.toString(), mode);
    assert.equal(actor.criticalChance, .03); assert.equal(actor.criticalMultiplier, 1.53);
    const critical = expected.mul(153).div(100).mul(100).div(100).discardDecimal();
    const world = new CombatWorld(73); world.setLoadout(s.getLoadout()); world.random.next = () => 0;
    assert.equal(world.fire(), true);
    const bullet = world.bullets.find(b => b.active);
    assert.equal(bullet.critical, true); assert.equal(bullet.damage.toString(), critical.amount.toString(), `${mode} actual critical projectile`);
    assert.equal(bullet.damagePrecision, critical.precision);
    if (mode !== 'Main') assert.equal(s.drawFish('free').reason, 'mode');
  }
});
