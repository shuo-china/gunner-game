const test = require('node:test');
const assert = require('node:assert/strict');
const { economyModules } = require('./support/economy-modules.cjs');
const { ECONOMY_CONFIG, validateEconomyConfig } = require('./.build/session/core/EconomyConfig.js');
const NOW = new Date(2026, 9, 15, 12).getTime();

function fixture(load, environment = 'production') {
  const { BattleSession } = load('session/BattleSession');
  const { resolveContentConfig, CONTENT_CONFIG } = load('session/ContentConfig');
  let now = NOW;
  const saved = new Map(), storage = { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) };
  const contentConfig = resolveContentConfig(environment, { tutorialEnabled: false, adsEnabled: true,
    thresholds: Object.fromEntries(Object.keys(CONTENT_CONFIG.production).map(key => [key, 0])) });
  const make = () => new BattleSession({ environment, contentConfig, storage, now: () => now, rng: () => 0 });
  return { session: make(), make, saved, setNow: n => { now = n; } };
}

test('economy settings are deeply frozen and reject invalid authoring before play', () => {
  assert.ok(Object.isFrozen(ECONOMY_CONFIG.gold.degreeMultipliers));
  assert.ok(Object.isFrozen(ECONOMY_CONFIG.raid.missions[0]));
  assert.ok(Object.isFrozen(ECONOMY_CONFIG.dailyCheck.diamondsByDay));
  for (const edit of [c => { c.boss.baseDiamonds = -1; }, c => { c.weapons.drawGradePercents = [99, 0, 0, 0]; },
    c => { c.raid.adEntriesPerDay = 1.5; }, c => { c.gold.stageGrowth = NaN; },
    c => { c.redeemCodes.push({ ...c.redeemCodes[0] }); }, c => { c.dailyCheck.diamondsByDay.pop(); },
    c => { c.dailyCheck.diamondsByDay[0] = -1; }, c => { c.dailyCheck.diamondsByDay[0] = .5; },
    c => { c.dailyCheck.dailyLimit = 2; }, c => { c.dailyCheck.dailyLimit = -1; },
    c => { c.dailyShare.diamonds = -1; }, c => { c.dailyShare.diamonds = .5; },
    c => { c.dailyShare.dailyLimit = 2; }, c => { c.dailyShare.dailyLimit = -1; },
    c => { c.speedRun.stageGrowthPercent = -.1; }, c => { c.boss.stageGrowthPercent = .5; },
    c => { delete c.boss.stageGrowthPercent; }]) {
    const bad = JSON.parse(JSON.stringify(ECONOMY_CONFIG)); edit(bad);
    assert.throws(() => validateEconomyConfig(bad), /Invalid economy configuration/);
  }
});

test('daily share previews, durable awards and disabled state use the single configured source', () => {
  const load = economyModules(c => { c.dailyShare.diamonds = 123; });
  const f = fixture(load);
  assert.equal(f.session.getDailyShareState().diamonds, 123);
  assert.deepEqual(f.session.claimDailyShare(), { ok: true, diamonds: 123 });
  assert.equal(f.make().weapons.diamonds, 123);
  assert.equal(f.make().claimDailyShare().reason, 'notClaimable');
  const disabled = economyModules(c => { c.dailyShare.dailyLimit = 0; });
  const system = new (disabled('session/DailyShareSystem').DailyShareSystem)();
  system.restore({ lastClaimDay: '2026-10-14' });
  assert.equal(system.snapshot('2026-10-15').canClaim, false);
  assert.deepEqual(system.serialize(), { lastClaimDay: '2026-10-14' });
});

test('daily check previews and durable claims share changed final values without reapplying a multiplier', () => {
  const load = economyModules(c => { c.dailyCheck.diamondsByDay = [7, 0, 3, 4, 5, 6, 7]; });
  const f = fixture(load), s = f.session;
  assert.equal(s.getDailyCheckState().days[0].diamonds, 7); assert.equal(s.claimDailyCheck(0).diamonds, 7);
  assert.equal(f.make().weapons.diamonds, 7);
  f.setNow(NOW + 86400000); assert.equal(s.claimDailyCheck(1).diamonds, 0);
  assert.equal(s.getDailyCheckState().checkNum, 2); assert.equal(s.weapons.diamonds, 7);
  assert.equal(s.claimDailyCheck(1).ok, false);
});

test('editing gold settings changes generated drops and the wallet without changing attack growth', () => {
  const load = economyModules(c => { Object.assign(c.gold, { firstStageBase: 50, stageGrowth: 2, degreeMultipliers: [1, 2, 3, 4],
    upgradeBasePercent: 200, upgradeGrowthG17: '1.2', rebirthUpgradeGrowth: 1.1, skinBonusPerIndex: 7, petFirstBonusPercent: 5, petGradeGrowth: 2 }); });
  const old = economyModules(), stage = load('core/StageBalance'), upgrades = load('session/UpgradeEconomy');
  assert.equal(stage.getStageMoney(2).toNumber(), 200);
  assert.notEqual(stage.getStageMoney(5001).toString(), old('core/StageBalance').getStageMoney(5001).toString());
  assert.equal(stage.getStageHealth(5001).toString(), old('core/StageBalance').getStageHealth(5001).toString());
  assert.equal(upgrades.getUpgradeValue('money', 1).toNumber(), 240);
  assert.equal(upgrades.getUpgradeValue('power', 50).toString(), old('session/UpgradeEconomy').getUpgradeValue('power', 50).toString());
  const rebirth = load('session/RebirthEconomy'), oldRebirth = old('session/RebirthEconomy');
  assert.notEqual(rebirth.getRebirthBonus('money', 10).amount.toString(), oldRebirth.getRebirthBonus('money', 10).amount.toString());
  assert.equal(rebirth.getRebirthBonus('power', 10).amount.toString(), oldRebirth.getRebirthBonus('power', 10).amount.toString());
  assert.equal(load('session/SkinCatalog').getSkin(2).moneyPercent, 14);
  assert.equal(load('session/PetSystem').PET_CATALOG[1].money.amount.toNumber(), 10);
  const f = fixture(load), map = load('core/map').createStageDefinition(0, 0, 123);
  const tree = map.trees.find(t => t.degree === 0); assert.equal(tree.reward.toNumber(), 50);
  const event = { type: 'treeDied', treeId: tree.id, sourceTime: 0, position: tree.position };
  f.session.consume([event], [{ ...tree, alive: false }]);
  assert.equal(f.session.moneyBalance.toNumber(), 100);
  f.session.consume([event], [{ ...tree, alive: false }]);
  assert.equal(f.make().moneyBalance.toNumber(), 100, 'drop is durable and is not granted twice');
});

test('challenge and Boss configured base/extra amounts reach the durable wallet exactly once', () => {
  const load = economyModules(c => { Object.assign(c.speedRun, { baseDiamonds: 47, additionalDiamonds: 13 });
    Object.assign(c.boss, { baseDiamonds: 71, additionalDiamonds: 29 }); });
  for (const mode of ['SpeedRun', 'Boss']) {
    const f = fixture(load), s = f.session, base = mode === 'Boss' ? 71 : 47, extra = mode === 'Boss' ? 29 : 13;
    assert.equal(s[`start${mode}`]().ok, true); s.advanceFrame(2);
    const event = mode === 'Boss' ? { type: 'bossDied', treeId: 3000000, sourceTime: 0, position: { x: 0, z: 0 } }
      : { type: 'complete', position: { x: 0, z: 0 } };
    s.consume([event], mode === 'Boss' ? [] : [{ id: 0, alive: false, reward: load('core/DecimalAmount').DecimalAmount.from(0) }], s.roundId);
    assert.equal(s[`get${mode}State`]().reward, base); assert.equal(s.weapons.diamonds, base);
    let ad = s[`begin${mode}Ad`](); assert.equal(ad.ok, true);
    s[`complete${mode}Ad`](ad.token, 'cancel'); assert.equal(s.weapons.diamonds, base);
    ad = s[`begin${mode}Ad`](); assert.equal(s[`complete${mode}Ad`](ad.token, 'success').ok, true);
    assert.equal(s.weapons.diamonds, base + extra);
    assert.equal(s[`complete${mode}Ad`](ad.token, 'success').ok, false);
    assert.equal(f.make().weapons.diamonds, base + extra);
  }
});

test('twofold first-stage rewards grow linearly on each independent stage, including configured rounding', () => {
  const { getStageDiamondRewards: rewards } = require('./.build/session/core/StageDiamondRewards.js');
  for (const [stage, challenge, boss] of [[0, [60, 180, 240], [300, 600, 900]],
    [1, [66, 198, 264], [330, 660, 990]], [9, [114, 342, 456], [570, 1140, 1710]],
    [10, [120, 360, 480], [600, 1200, 1800]], [99, [654, 1962, 2616], [3270, 6540, 9810]]]) {
    for (const [config, expected] of [[ECONOMY_CONFIG.speedRun, challenge], [ECONOMY_CONFIG.boss, boss]]) {
      const result = rewards(config, stage);
      assert.deepEqual([result.reward, result.additionalReward, result.totalReward], expected);
      assert.equal(result.withinWalletLimit, true);
    }
  }
  assert.deepEqual(rewards({ baseDiamonds: 47, additionalDiamonds: 13, stageGrowthPercent: 10 }, 1),
    { reward: 51, additionalReward: 14, totalReward: 65, withinWalletLimit: true });
  assert.equal(rewards({ ...ECONOMY_CONFIG.speedRun, stageGrowthPercent: 0 }, 500).reward, 60);
  const extreme = rewards(ECONOMY_CONFIG.boss, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(extreme.withinWalletLimit, false);
  for (const amount of [extreme.reward, extreme.additionalReward, extreme.totalReward]) assert.ok(Number.isSafeInteger(amount));
});

test('changed stage growth controls previews, completed-stage settlement, ads and restored progression', () => {
  const load = economyModules(c => { c.speedRun.stageGrowthPercent = 25; c.boss.stageGrowthPercent = 20; });
  for (const [mode, block, base, extra, nextBase] of [['SpeedRun', 'speedRun', 105, 315, 120], ['Boss', 'boss', 480, 960, 540]]) {
    const f = fixture(load);
    for (const [key, value] of f.saved) {
      const raw = JSON.parse(value); raw[block].stage = 3; raw.weapons.diamonds = 123;
      raw.progress = { stageIndex: 20, waveIndex: 0 }; f.saved.set(key, JSON.stringify(raw));
    }
    const s = f.make();
    const state = () => s[`get${mode}State`]();
    assert.equal(state().reward, base); assert.equal(state().additionalReward, extra);
    assert.equal(state().totalReward, base + extra); assert.equal(s.weapons.diamonds, 123);
    assert.equal(s[`start${mode}`]().ok, true); s.advanceFrame(2);
    const event = mode === 'Boss' ? { type: 'bossDied', treeId: 3000000, sourceTime: 0, position: { x: 0, z: 0 } }
      : { type: 'complete', position: { x: 0, z: 0 } };
    const trees = mode === 'Boss' ? [] : [{ id: 0, alive: false, reward: load('core/DecimalAmount').DecimalAmount.from(0) }];
    s.consume([event], trees, s.roundId); s.consume([event], trees, s.roundId);
    assert.equal(state().stage, 3); assert.equal(state().reward, base);
    assert.equal(s.weapons.diamonds, 123 + base);
    assert.equal(f.make()[`get${mode}State`]().reward, nextBase);
    for (const outcome of ['cancel', 'failure']) {
      const ad = s[`begin${mode}Ad`](); assert.equal(ad.ok, true);
      assert.equal(s[`complete${mode}Ad`](ad.token, outcome).ok, false);
      assert.equal(s.weapons.diamonds, 123 + base); assert.equal(state().additionalReward, extra);
    }
    const ad = s[`begin${mode}Ad`]();
    assert.equal(s[`complete${mode}Ad`](ad.token, 'success').ok, true);
    assert.equal(s[`complete${mode}Ad`](ad.token, 'success').ok, false);
    assert.equal(s.weapons.diamonds, 123 + base + extra);
    assert.equal(state().reward, base, 'exit transition still describes the completed stage');
    s.advanceFrame(1.5); assert.equal(state().reward, nextBase);
    assert.equal(f.make().weapons.diamonds, 123 + base + extra);
    assert.equal(f.make()[`get${mode}State`]().reward, nextBase);
  }
});

test('growing rewards guard wallet capacity at entry and recheck it on delayed ad completion', () => {
  const load = economyModules();
  for (const [mode, block, base, extra] of [['SpeedRun', 'speedRun', 114, 342], ['Boss', 'boss', 570, 1140]]) {
    const f = fixture(load);
    for (const [key, value] of f.saved) {
      const raw = JSON.parse(value); raw[block].stage = 9;
      raw.weapons.diamonds = Number.MAX_SAFE_INTEGER - base + 1; f.saved.set(key, JSON.stringify(raw));
    }
    const s = f.make(); assert.equal(s[`start${mode}`]().reason, 'walletLimit');
    assert.equal(s[`get${mode}State`]().stage, 9);
    s.weapons.spendDiamonds(extra + 1);
    assert.equal(s[`start${mode}`]().ok, true); s.advanceFrame(2);
    const event = mode === 'Boss' ? { type: 'bossDied', treeId: 3000000, sourceTime: 0, position: { x: 0, z: 0 } }
      : { type: 'complete', position: { x: 0, z: 0 } };
    s.consume([event], mode === 'Boss' ? [] : [{ id: 0, alive: false, reward: load('core/DecimalAmount').DecimalAmount.from(0) }], s.roundId);
    assert.equal(s.weapons.diamonds, Number.MAX_SAFE_INTEGER - extra);
    const ad = s[`begin${mode}Ad`](); assert.equal(ad.ok, true);
    s.weapons.grantDiamonds(extra);
    assert.equal(s[`complete${mode}Ad`](ad.token, 'success').ok, false);
    assert.equal(s[`get${mode}State`]().phase, 'won'); assert.equal(s.weapons.diamonds, Number.MAX_SAFE_INTEGER);
    assert.equal(s[`complete${mode}Ad`](ad.token, 'success').reason, 'staleAd');
    assert.equal(s[`begin${mode}Ad`]().reason, 'walletLimit');
    s.weapons.spendDiamonds(extra);
    const retry = s[`begin${mode}Ad`](); assert.equal(s[`complete${mode}Ad`](retry.token, 'success').ok, true);
    assert.equal(s.weapons.diamonds, Number.MAX_SAFE_INTEGER); assert.equal(f.make().weapons.diamonds, Number.MAX_SAFE_INTEGER);
    assert.equal(f.make()[`get${mode}State`]().stage, 10);
  }
});

test('extreme legacy stages preserve saved progress while blocking rewards beyond the safe wallet', () => {
  const load = economyModules(), f = fixture(load);
  for (const [key, value] of f.saved) {
    const raw = JSON.parse(value); raw.speedRun.stage = raw.boss.stage = Number.MAX_SAFE_INTEGER - 2;
    raw.weapons.diamonds = 0; f.saved.set(key, JSON.stringify(raw));
  }
  const s = f.make();
  for (const mode of ['SpeedRun', 'Boss']) {
    const state = s[`get${mode}State`](); assert.equal(state.stage, Number.MAX_SAFE_INTEGER - 2);
    assert.ok(Number.isSafeInteger(state.reward)); assert.ok(Number.isSafeInteger(state.totalReward));
    assert.equal(s[`start${mode}`]().reason, 'stageLimit');
    assert.equal(s.mode, 'Main'); assert.equal(s.weapons.diamonds, 0);
  }
});

test('configured new-game wallets, onboarding, pet draw, redeem codes and test supply are used', () => {
  const load = economyModules(c => {
    c.newGame = { gold: '1234', diamonds: 17, starGems: 19, ruby: '27', petCoins: 80, starterWeaponId: 1 };
    c.onboarding.firstDrawDiamondFloor = 123; c.pets = { ...c.pets, drawPrice: 40, drawGrade: 2 };
    c.redeemCodes = [{ code: 'one', diamonds: 7, mode: 'per_player' }, { code: 'two', diamonds: 9, mode: 'per_player' }];
    Object.assign(c.testResources, { diamonds: 333, starGems: 444, fundGoldUpgrades: false, fundRebirthUpgrades: false });
  });
  const f = fixture(load), s = f.session;
  assert.equal(s.moneyBalance.toNumber(), 1234); assert.equal(s.weapons.diamonds, 17); assert.equal(s.weapons.starGems, 19);
  assert.equal(s.getRebirthState().ruby.toNumber(), 27); assert.equal(s.weapons.snapshot().equipment[0].weaponId, 1);
  s.onWeaponPanelOpened(); assert.equal(s.weapons.diamonds, 123);
  s.weapons.spendDiamonds(3); s.onWeaponPanelOpened(); assert.equal(s.weapons.diamonds, 120);
  assert.equal(s.drawPet('petCoins').ok, true); assert.equal(s.getPetState().coins, 40); assert.equal(s.getPetState().owned[0], 2);
  assert.equal(s.drawPet('diamonds').ok, true); assert.equal(s.weapons.diamonds, 80);
  assert.equal(s.redeemCode(' one ').diamonds, 7); assert.equal(s.redeemCode('two').diamonds, 9);
  const restored = f.make(); assert.equal(restored.weapons.diamonds, 96);
  assert.equal(restored.redeemCode('one').reason, 'alreadyUsed');
  restored.onWeaponPanelOpened(); assert.equal(restored.weapons.diamonds, 96);
  const testing = fixture(load, 'test').session;
  assert.equal(testing.weapons.diamonds, 333); assert.equal(testing.weapons.starGems, 444); assert.equal(testing.moneyBalance.toNumber(), 1234);
});

test('gameplay income changes retain onboarding, redemption, test supply and historical wallet records', () => {
  const load = economyModules(), f = fixture(load), session = f.session;
  assert.equal(session.weapons.diamonds, 0);
  session.onWeaponPanelOpened(); assert.equal(session.weapons.diamonds, 200);
  assert.equal(session.redeemCode('950424').diamonds, 2000);
  session.weapons.spendDiamonds(37); session.save();
  for (const [key, value] of f.saved) {
    const saved = JSON.parse(value);
    saved.mine.bestReward = 19; saved.speedRun.stage = 3; saved.boss.stage = 2;
    f.saved.set(key, JSON.stringify(saved));
  }
  const restored = f.make();
  assert.equal(restored.weapons.diamonds, 2163);
  assert.equal(restored.getMineState().bestReward, 19);
  assert.equal(restored.getSpeedRunState().stage, 3); assert.equal(restored.getBossState().stage, 2);
  restored.onWeaponPanelOpened(); assert.equal(restored.weapons.diamonds, 2163);
  assert.equal(restored.redeemCode('950424').reason, 'alreadyUsed');
  const testing = fixture(load, 'test').session;
  assert.equal(testing.weapons.diamonds, 2000000); assert.equal(testing.weapons.starGems, 1000000);
  assert.equal(testing.weapons.draw().ok, true); assert.equal(testing.weapons.diamonds, 1999900);
});

test('configured weapon price, weighted grades and ad quality/limit survive current-format reload', () => {
  const load = economyModules(c => { c.weapons.drawPrice = 60; c.weapons.drawGradePercents = [20, 80, 0, 0]; c.weapons.dailyAd = { grade: 3, dailyLimit: 2 }; });
  const { WeaponInventory } = load('session/WeaponInventory'), { getWeaponGrade } = load('core/WeaponCatalog');
  const { ContentUnlockManager } = load('session/ContentUnlockManager'), { resolveContentConfig } = load('session/ContentConfig');
  const content = new ContentUnlockManager(resolveContentConfig('production', { adsEnabled: true,
    thresholds: { challengePowerLevel: 0, dailyAdWeaponStage: 0 } }), () => ({ weaponsUnlocked: true, stageValueMax: 100 }));
  let now = NOW, rolls = [.19, 0, .20, 0];
  const options = { content, now: () => now, rng: () => rolls.length ? rolls.shift() : 0 };
  const w = new WeaponInventory(options); w.grantDiamonds(120);
  assert.equal(getWeaponGrade(w.draw().weaponId), 0); assert.equal(getWeaponGrade(w.draw().weaponId), 1); assert.equal(w.diamonds, 0);
  let ad = w.beginAd('daily'); assert.equal(w.completeAd(ad.token, 'cancel').ok, false);
  ad = w.beginAd('daily'); assert.equal(getWeaponGrade(w.completeAd(ad.token, 'success').weaponId), 3);
  const saved = w.serialize(), missing = { ...saved }; delete missing.dailyAdCount;
  assert.throws(() => new WeaponInventory({ ...options, initialState: missing }), /Invalid/);
  const restored = new WeaponInventory({ ...options, initialState: saved });
  assert.equal(restored.snapshot().dailyAdAvailable, true);
  ad = restored.beginAd('daily'); assert.equal(restored.completeAd(ad.token, 'success').ok, true);
  assert.equal(restored.completeAd(ad.token, 'success').ok, false); assert.equal(restored.beginAd('daily').reason, 'dailyUsed');
  assert.equal(new WeaponInventory({ ...options, initialState: restored.serialize() }).snapshot().dailyAdAvailable, false);
  now += 86400000; assert.equal(restored.snapshot().dailyAdAvailable, true);
});

test('existing pending weapon offer keeps its identity when future offer config changes', () => {
  const load = economyModules(c => { c.weapons.offer.weaponId = 9; });
  const { WeaponInventory } = load('session/WeaponInventory'), { ContentUnlockManager } = load('session/ContentUnlockManager');
  const content = new ContentUnlockManager(load('session/ContentConfig').resolveContentConfig('test', { adsEnabled: true }));
  const state = new WeaponInventory({ environment: 'test', content, now: () => NOW }).serialize();
  state.backpack[0] = { weaponId: 8, locked: false, pendingAd: true }; state.adGunExpiresAt = NOW + 1000; state.adGunOffered = true;
  const w = new WeaponInventory({ environment: 'test', content, now: () => NOW, initialState: state });
  const ad = w.beginAd('weapon'); assert.equal(w.completeAd(ad.token, 'success').weaponId, 8);
  assert.equal(w.serialize().backpack[0].weaponId, 8);
});

test('configured rebirth multiplier and daily count survive completion, reload and next day', () => {
  const load = economyModules(c => { c.rebirth.adTotalMultiplier = 5; c.rebirth.adDailyLimit = 2; });
  const { RebirthSystem } = load('session/RebirthSystem'), { ContentUnlockManager } = load('session/ContentUnlockManager');
  const content = new ContentUnlockManager(load('session/ContentConfig').resolveContentConfig('test', { adsEnabled: true }));
  let now = NOW; const make = () => new RebirthSystem(() => now, content), p = { stageIndex: 2, waveIndex: 0 };
  const r = make(), preview = r.snapshot(p, 24);
  assert.equal(preview.enhancedReward.toString(), preview.reward.mul(5).toString());
  let ad = r.request('ad', p); r.completeAd(ad.token, 'cancel', p);
  ad = r.request('ad', p); assert.equal(r.completeAd(ad.token, 'success', p).ok, true); r.advance(2);
  r.commitCompletion(r.prepareCompletion(p)); assert.equal(r.snapshot(p, 24).ruby.toString(), preview.enhancedReward.toString());
  const saved = r.serialize(), missing = { ...saved }; delete missing.adUsedCount;
  const restored = make(); assert.throws(() => restored.restore(missing), /Invalid rebirth ad count/); restored.restore(saved);
  assert.equal(restored.snapshot(p, 24).adAvailable, true);
  ad = restored.request('ad', p); restored.completeAd(ad.token, 'success', p); restored.advance(2); restored.commitCompletion(restored.prepareCompletion(p));
  assert.equal(restored.request('ad', p).reason, 'adUsed');
  const reloaded = make(); reloaded.restore(restored.serialize()); assert.equal(reloaded.snapshot(p, 24).adAvailable, false);
  now += 86400000; assert.equal(reloaded.snapshot(p, 24).adAvailable, true);
});

test('Raid configured tiers, missions and daily tickets settle through the session and require current counts', () => {
  const load = economyModules(c => { c.raid.freeEntriesPerDay = 1; c.raid.adEntriesPerDay = 2;
    c.raid.starGemTiers = [{ levels: 2, perLevel: 7 }, { levels: 1, perLevel: 3 }]; c.raid.starGemsPerExtraLevel = 1;
    c.raid.missions[0].reward = 61; });
  const { raidReward, RaidSystem } = load('session/RaidSystem');
  assert.deepEqual([0, 1, 2, 3, 4].map(raidReward), [0, 7, 14, 17, 18]);
  const f = fixture(load), s = f.session;
  s.openRaid(); assert.equal(s.getRaidState().freeRemaining, 1); assert.equal(s.startRaid().ok, true); s.advanceFrame(2);
  const boss = s.getRaidBossCombat(); for (let i = 0; i < 4; i++) boss.hit(boss.maxHealth);
  s.advanceFrame(60); assert.equal(s.getRaidState().reward, 18); assert.equal(s.weapons.starGems, 18);
  s.exitRaid(); s.advanceFrame(1.5); s.openRaid();
  assert.equal(s.claimRaidMission(0).ok, true); assert.equal(s.weapons.starGems, 79);
  assert.equal(s.claimRaidMission(0).ok, false);
  let ad = s.beginRaidAd(); s.completeRaidAd(ad.token, 'cancel'); assert.equal(s.getRaidState().adAvailable, true);
  ad = s.beginRaidAd(); assert.equal(s.completeRaidAd(ad.token, 'success').ok, true); s.exitRaid(); s.advanceFrame(1.5);
  const restored = f.make(); restored.openRaid(); assert.equal(restored.getRaidState().adAvailable, true);
  ad = restored.beginRaidAd(); assert.equal(restored.completeRaidAd(ad.token, 'success').ok, true);
  restored.exitRaid(); restored.advanceFrame(1.5); restored.openRaid(); assert.equal(restored.getRaidState().adAvailable, false);
  const saved = new RaidSystem(s.content, () => s.weapons.snapshot(), () => NOW).serialize();
  saved.freeUsed = 5; saved.adUsed = true; saved.adUsedCount = 1;
  const missing = { ...saved }; delete missing.adUsedCount;
  const raid = new RaidSystem(s.content, () => s.weapons.snapshot(), () => NOW);
  assert.throws(() => raid.restore(missing), /Invalid raid save/); raid.restore(saved);
  assert.equal(raid.snapshot().freeRemaining, 0, 'lowering caps preserves an existing save');
  f.setNow(NOW + 86400000); const tomorrow = f.make(); assert.equal(tomorrow.getRaidState().freeRemaining, 1);
});

test('zero ad limits disable claims and a zero-reward completed Raid mission can still be closed', () => {
  const load = economyModules(c => { c.weapons.dailyAd.dailyLimit = 0; c.rebirth.adDailyLimit = 0;
    c.raid.adEntriesPerDay = 0; c.raid.freeEntriesPerDay = 1; c.raid.missions[0].reward = 0; });
  const s = fixture(load).session;
  assert.equal(s.weapons.snapshot().dailyAdAvailable, false); assert.equal(s.weapons.beginAd('daily').reason, 'dailyUsed');
  assert.equal(s.getRebirthState().adAvailable, false); assert.equal(s.requestRebirth('ad').reason, 'adUsed');
  s.openRaid(); s.startRaid(); s.advanceFrame(2); s.exitRaid(); s.advanceFrame(1.5); s.openRaid();
  assert.equal(s.getRaidState().adAvailable, false); assert.equal(s.beginRaidAd().reason, 'unavailable');
  assert.equal(s.claimRaidMission(0).ok, true); assert.equal(s.getRaidState().missions[0].claimed, true);
  assert.equal(s.weapons.starGems, 0); assert.equal(s.claimRaidMission(0).reason, 'notClaimable');
});
