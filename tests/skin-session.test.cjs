const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const build = process.env.FOREST_GUNNER_SESSION_TEST_BUILD || path.resolve(__dirname, '.build/session');
const compiled = file => require(path.join(build, file));
const { BattleSession, economyStorageKey } = compiled('session/BattleSession.js');
const { SKIN_CATALOG, getSkin, isSkinId } = compiled('session/SkinCatalog.js');
const { SkinSystem } = compiled('session/SkinSystem.js');
const { WeaponInventory } = compiled('session/WeaponInventory.js');
const { resolveContentConfig } = compiled('session/ContentConfig.js');
const { getWeapon } = compiled('core/WeaponCatalog.js');
const { DecimalAmount: D } = compiled('core/DecimalAmount.js');

function fixture(environment = 'test', onWeaponsChanged) {
  const data = new Map(), writes = [], key = economyStorageKey(environment);
  const storage = { getItem: key => data.get(key) ?? null, setItem(key, value) { data.set(key, value); writes.push(JSON.parse(value)); } };
  const config = resolveContentConfig(environment, { tutorialEnabled: false,
    testResources: { fundGoldUpgrades: false, fundRebirthUpgrades: false, diamonds: 0, starGems: 0 } });
  const make = () => new BattleSession({ environment, contentConfig: config, storage, now: () => 1791691200000, rng: () => .5, onWeaponsChanged });
  make(); const saved = JSON.parse(data.get(key)); saved.speedRun.stage = 1; data.set(key, JSON.stringify(saved));
  const session = make(); writes.length = 0;
  return { session, data, writes, key, make, patch(fn) { const saved = JSON.parse(data.get(key)); fn(saved); data.set(key, JSON.stringify(saved)); return make(); } };
}
function buy(session, ...ids) { session.weapons.grantDiamonds(30000); ids.forEach(id => assert.equal(session.purchaseSkin(id).ok, true)); }
function enterRaid(s) { assert.equal(s.openRaid().ok, true); assert.equal(s.startRaid().ok, true); s.advanceFrame(2); }

test('every unfinished tutorial step blocks skin transactions while retaining earlier purchases and bonuses', () => {
  for (const step of ['upgrade', 'gunOpen', 'gunBuy', 'gunMerge', 'gunEquip']) {
    const data = new Map(), writes = [], notices = [], key = economyStorageKey('production');
    const storage = { getItem: key => data.get(key) ?? null, setItem(key, value) { data.set(key, value); writes.push(value); } };
    new BattleSession({ storage });
    const saved = JSON.parse(data.get(key));
    saved.tutorial = { step, drawCount: ['gunMerge', 'gunEquip'].includes(step) ? 2 : 0 }; saved.weapons.diamonds = 1000; saved.weapons.stageValueMax = 9000;
    saved.progress = { stageIndex: 2, waveIndex: 0 }; saved.levels = [step === 'upgrade' ? 0 : 3, 0, 0];
    saved.content = { challengeUnlocked: step !== 'upgrade', weaponsUnlocked: step !== 'upgrade', firstDrawGranted: true };
    saved.skins = { owned: Array.from({ length: 25 }, (_, id) => id <= 1), selectedId: 1 };
    data.set(key, JSON.stringify(saved));
    const options = { storage, onWeaponsChanged: force => notices.push(force) };
    let session = new BattleSession(options);
    assert.equal(session.getTutorialState().step, step);
    const before = session.getSkinState(), raw = data.get(key);
    assert.deepEqual(before.totals, { damagePercent: 16, speedPercent: 10, moneyPercent: 5 });
    writes.length = 0; notices.length = 0;
    for (const action of [() => session.purchaseSkin(2), () => session.equipSkin(0)]) {
      assert.deepEqual(action(), { ok: false, reason: 'contentLocked' }, step);
    }
    assert.deepEqual(session.getSkinState(), before); assert.equal(data.get(key), raw);
    assert.equal(writes.length, 0); assert.equal(notices.length, 0);
    session = new BattleSession(options);
    assert.equal(session.getContentState('skins').unlocked, false);
    assert.equal(session.getSkinState().selectedId, 1); assert.deepEqual(session.getSkinState().totals, before.totals);
    session.setMode('Boss');
    assert.equal(session.purchaseSkin(2).reason, 'mode'); assert.equal(session.equipSkin(0).reason, 'mode');
    session.setMode('Main');
    assert.equal(session.requestRebirth('normal').reason, 'locked');
    session.tutorial.complete(); session.speedRun.restore({ stage: 1 });
    assert.equal(session.requestRebirth('normal').ok, true);
    assert.equal(session.purchaseSkin(2).reason, 'busy'); assert.equal(session.equipSkin(0).reason, 'busy');
  }
});

test('Skin catalog matches all 25 published costs and bonuses; no generated upgrade levels or unlock grants', () => {
  assert.equal(SKIN_CATALOG.length, 25);
  assert.deepEqual(getSkin(0), { id: 0, number: 1, price: 0, damagePercent: 0, speedPercent: 0, moneyPercent: 0 });
  assert.deepEqual(getSkin(24), { id: 24, number: 25, price: 2400, damagePercent: 384, speedPercent: 240, moneyPercent: 120 });
  assert.equal(SKIN_CATALOG.reduce((n, s) => n + s.price, 0), 30000);
  for (const id of [-1, 25, .5, NaN, Infinity, '1', null]) assert.equal(isSkinId(id), false);
  for (const environment of ['test', 'production']) {
    const s = fixture(environment).session.getSkinState();
    assert.deepEqual(s.owned, Array.from({ length: 25 }, (_, i) => i === 0)); assert.equal(s.selectedId, 0);
    assert.deepEqual(s.totals, { damagePercent: 0, speedPercent: 0, moneyPercent: 0 });
  }
});

test('purchases allow any skin, debit exactly once, commit wallet and ownership before one forced notification', () => {
  let s; const calls = [];
  const f = fixture('production', force => { if (s) calls.push({ force, state: s.getSkinState(), save: JSON.parse(f.data.get(f.key)) }); });
  s = f.session; s.weapons.grantDiamonds(2400); calls.length = 0; f.writes.length = 0;
  assert.equal(s.purchaseSkin(24).ok, true); assert.equal(calls.length, 1); assert.equal(calls[0].force, true);
  assert.equal(calls[0].state.diamonds, 0); assert.equal(calls[0].state.owned[24], true);
  assert.equal(calls[0].save.weapons.diamonds, 0); assert.equal(calls[0].save.skins.owned[24], true);
  assert.equal(f.writes.length, 1); assert.equal(s.getSkinState().selectedId, 0);
  assert.equal(s.purchaseSkin(24).reason, 'owned'); assert.equal(s.purchaseSkin(1).reason, 'diamonds');
  assert.equal(s.purchaseSkin(-1).reason, 'invalid'); assert.equal(s.purchaseSkin(25).reason, 'invalid');
  assert.equal(calls.length, 1); assert.equal(f.writes.length, 1);
});

test('skin snapshots do not expose mutable ownership and full collection stacks holding bonuses', () => {
  const s = fixture().session; buy(s, ...Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(s.weapons.diamonds, 0);
  assert.deepEqual(s.getSkinState().totals, { damagePercent: 4800, speedPercent: 3000, moneyPercent: 1500 });
  const state = s.getSkinState(); state.owned[24] = false; state.items[24].owned = false; state.totals.damagePercent = 0;
  assert.equal(s.getSkinState().owned[24], true); assert.equal(s.getSkinState().totals.damagePercent, 4800);
});

test('equip is cosmetic, refuses unowned ids and persists without forcing balance refresh', () => {
  const calls = [], f = fixture('test', force => calls.push(force)), s = f.session;
  buy(s, 1, 3); calls.length = 0; f.writes.length = 0;
  const loadout = s.getLoadout(), balance = s.weapons.diamonds;
  assert.equal(s.equipSkin(2).reason, 'locked'); assert.equal(s.equipSkin(25).reason, 'invalid');
  assert.deepEqual(s.equipSkin(3), { ok: true, skinId: 3, changed: true });
  assert.deepEqual(s.getLoadout(), loadout); assert.equal(s.weapons.diamonds, balance); assert.equal(calls.length, 0);
  assert.equal(f.writes.length, 1); assert.equal(f.make().getSkinState().selectedId, 3);
  assert.equal(s.equipSkin(3).changed, false); assert.equal(s.equipSkin(0).ok, true);
});

test('missing or corrupt skin saves block overwrites while readable current economy remains available', () => {
  const f = fixture('production'); f.session.weapons.grantDiamonds(9876);
  const malformed = [null, {}, { owned: [] }, { owned: Array(25).fill(false), selectedId: 0 },
    { owned: [true, ...Array(24).fill(false)], selectedId: 1 }, { owned: [true, ...Array(24).fill(0)], selectedId: 0 },
    { owned: [true, ...Array(24).fill(false)], selectedId: 25 }];
  const warn = console.warn; console.warn = () => {};
  try {
    for (const skins of [undefined, ...malformed]) {
      const s = f.patch(saved => { saved.skins = skins; saved.money = { digits: '12345', exponent: 2, precision: 5 }; saved.levels = [7, 8, 9]; });
      const raw = f.data.get(f.key); assert.equal(s.persistenceBlocked, true);
      if (skins !== undefined) { assert.equal(s.weapons.diamonds, 9876); assert.equal(s.moneyBalance.toString(), '1234500'); }
      assert.equal(s.getSkinState().selectedId, 0); assert.deepEqual(s.getSkinState().owned, [true, ...Array(24).fill(false)]);
      assert.deepEqual(JSON.parse(f.data.get(f.key)).levels, [7, 8, 9]);
      s.save(); assert.equal(f.data.get(f.key), raw);
    }
  } finally { console.warn = warn; }
  const system = new SkinSystem(); system.purchase(1, 100, () => true); system.equip(1);
  assert.throws(() => system.restore({ owned: Array(25).fill(true), selectedId: 99 }));
  assert.equal(system.snapshot(0).selectedId, 1, 'failed restore cannot partially overwrite valid state');
});

test('rebirth preserves skin ownership and selection; transaction guards cannot spend during other flows', () => {
  const s = fixture().session; buy(s, 24); s.equipSkin(24);
  const owned = s.getSkinState().owned, balance = s.weapons.diamonds;
  assert.equal(s.requestRebirth('normal').ok, true); assert.equal(s.purchaseSkin(1).reason, 'busy'); assert.equal(s.equipSkin(0).reason, 'busy');
  assert.ok(s.advanceRebirth(2)); assert.deepEqual(s.getSkinState().owned, owned); assert.equal(s.getSkinState().selectedId, 24);
  assert.equal(s.weapons.diamonds, balance);
  s.openRaid(); assert.equal(s.purchaseSkin(1).reason, 'busy'); s.closeRaid();
  s.startBoss(); assert.equal(s.purchaseSkin(1).reason, 'mode'); assert.equal(s.equipSkin(0).reason, 'mode');
});

test('source InfVal cuts apply holding damage before stars, including Boss omission of ordinary precision promotion', () => {
  const f = fixture(); const s = f.patch(saved => {
    saved.weapons.equipment[0].weaponId = 16; saved.weapons.collection[16] = true;
    saved.rebirth.levels = [5, 0, 0];
  });
  buy(s, 1); assert.equal(s.getLoadout()[0].damage.toString(), '1178');
  s.weapons.configureTest({ starLevels: [1, 0, 0] }); assert.equal(s.getLoadout()[0].damage.toString(), '1767');
  assert.equal(s.startBoss().ok, true); s.advanceFrame(2);
  assert.equal(s.getLoadout()[0].damage.toString(), '1750'); assert.equal(s.getLoadout()[0].damagePrecision, 3);
  assert.equal(s.getLoadout()[0].criticalChance, 0);
});

test('main and SpeedRun use skin speed with existing upgrades; Boss preserves its original base subtraction', () => {
  const s = fixture().session; buy(s, 1, 24);
  const base = getWeapon(0).attackInterval;
  assert.equal(s.getLoadout()[0].attackInterval, Math.fround(Math.fround(base / 350) * 100));
  s.startSpeedRun(); s.advanceFrame(2); assert.equal(s.getLoadout()[0].attackInterval, Math.fround(Math.fround(base / 350) * 100));
  s.exitSpeedRun(); s.advanceFrame(1.5); s.startBoss(); s.advanceFrame(2);
  assert.equal(s.getLoadout()[0].attackInterval, Math.fround(Math.fround(base / 250) * 100));
});

test('all four modes match independent native binary32 cooldown fixtures, including high values and both clamps', () => {
  const fixtureData = require('./fixtures/skin-native-intervals.json');
  for (const row of fixtureData.cases) {
    const f = fixture(), s = f.patch(saved => {
      saved.levels[1] = row.goldSpeed; saved.rebirth.levels[1] = row.rebirthSpeed;
      saved.progress.stageIndex = row.stage; saved.weapons.stageValueMax = row.stage * 10;
    });
    buy(s, ...row.skins);
    if (row.mode === 'Raid') enterRaid(s);
    else if (row.mode === 'Boss') { assert.equal(s.startBoss().ok, true); s.advanceFrame(2); }
    else if (row.mode === 'SpeedRun') { assert.equal(s.startSpeedRun().ok, true); s.advanceFrame(2); }
    const interval = s.getLoadout()[0].attackInterval;
    assert.equal(interval, row.interval, JSON.stringify(row));
    const bytes = Buffer.alloc(4); bytes.writeFloatLE(interval); assert.equal(bytes.readUInt32LE().toString(16), row.bits);
  }
  const s = fixture().session;
  assert.equal(s.attackInterval(5, 100), 2, 'source upper float clamp');
  assert.equal(s.attackInterval(.01, 100), 0.05000000074505806, 'source lower float clamp');
});

test('skin money bonus affects each eligible tree once, without requiring equip', () => {
  const s = fixture().session; buy(s, 1, 24);
  const tree = { id: 91, alive: false, reward: D.from(20), rewardPrecision: 2 };
  const events = [{ type: 'treeDied', treeId: 91, position: { x: 0, z: 0 }, sourceTime: 1 }];
  assert.equal(s.consume(events, [tree])[0].amount.toString(), '45'); assert.equal(s.moneyBalance.toString(), '45');
  assert.deepEqual(s.consume(events, [tree]), []); assert.equal(s.getSkinState().selectedId, 0);
});

test('Raid retains skin damage and speed but skips gold/rebirth; entry freezes the final parameters', () => {
  const f = fixture(); const s = f.patch(saved => {
    saved.weapons.equipment[0].weaponId = 16; saved.weapons.collection[16] = true;
    saved.levels = [150, 150, 150]; saved.rebirth.levels = [100, 100, 100]; saved.weapons.starLevels = [1, 0, 0];
  });
  buy(s, 1); enterRaid(s);
  const weak = s.getRaidState().weakness === getWeapon(16).type;
  assert.equal(s.getLoadout()[0].damage.toString(), weak ? '13900' : '1390');
  assert.equal(s.getLoadout()[0].attackInterval, getWeapon(16).attackInterval, 'only 10% skin speed still clamps to 100 in Raid');
  const frozen = s.getLoadout(); assert.equal(s.purchaseSkin(24).ok, false); s.weapons.configureTest({ starLevels: [20, 20, 20] });
  assert.deepEqual(s.getLoadout(), frozen);
  const faster = fixture().session; buy(faster, 24); enterRaid(faster);
  assert.equal(faster.getLoadout()[0].attackInterval, Math.fround(Math.fround(getWeapon(0).attackInterval / 240) * 100));
});

test('shared diamond debit rejects invalid/insufficient requests without changes or notifications', () => {
  let changes = 0; const w = new WeaponInventory({ onMutation: () => changes++ }); w.grantDiamonds(100); changes = 0;
  for (const n of [-1, NaN, Infinity, .5, 101]) assert.equal(w.spendDiamonds(n).ok, false);
  assert.equal(w.diamonds, 100); assert.equal(changes, 0);
  assert.equal(w.spendDiamonds(100).ok, true); assert.equal(w.diamonds, 0); assert.equal(changes, 1);
  assert.equal(w.spendDiamonds(0).ok, true); assert.equal(changes, 1);
});

test('successful holding purchases reset all actor spread while preserving clocks and in-flight damage even at speed cap', () => {
  const coreBuild = process.env.FOREST_GUNNER_CORE_TEST_BUILD || path.resolve(__dirname, '.build/core');
  const { CombatWorld } = require(path.join(coreBuild, 'index.js'));
  const world = new CombatWorld(13); let s, forced = 0;
  const f = fixture('test', force => { if (s && force) { forced++; world.setLoadout(s.getLoadout()); } });
  s = f.patch(saved => { saved.levels = [0, 500, 0]; saved.weapons.equipment[1] = { weaponId: 0, locked: false, pendingAd: false }; });
  world.setLoadout(s.getLoadout()); s.weapons.grantDiamonds(1000);
  world.fire(); world.spread = 9; world.attackClock = .023;
  world.followers[0].spread = 8; world.followers[0].attackClock = .031;
  const oldDamage = world.bullets[0].damage, oldBullets = [...world.bullets], interval = s.getLoadout()[0].attackInterval;
  assert.equal(s.purchaseSkin(1).ok, true); assert.equal(forced, 1);
  assert.equal(s.getLoadout()[0].attackInterval, interval); assert.equal(world.spread, 0); assert.equal(world.followers[0].spread, 0);
  assert.equal(world.attackClock, .023); assert.equal(world.followers[0].attackClock, .031);
  assert.deepEqual(world.bullets, oldBullets); assert.equal(world.bullets[0].damage, oldDamage);
  assert.ok(s.getLoadout()[0].damage.compare(oldDamage) > 0);
  world.spread = 7; assert.equal(s.equipSkin(1).ok, true); assert.equal(world.spread, 7); assert.equal(forced, 1);
});
