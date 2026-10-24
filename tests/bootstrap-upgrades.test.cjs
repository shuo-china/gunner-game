const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');
const core = require('./.build/core/index.js');
const sessionModule = require('./.build/session/session/BattleSession.js');
const { WeaponInventory } = require('./.build/session/session/WeaponInventory.js');

// Exercise the same purchase method bound to GameHud and the debug API, with
// real session/world objects. Rendering is outside this transaction contract.
function loadBootstrap() {
  const module = { exports: {} };
  const imports = {
    cc: { Component: class {}, _decorator: { ccclass: () => target => target, disallowMultiple: target => target } },
    'cc/env': { DEBUG: false, PREVIEW: false },
    './core': core,
    './core/SpeedRunMap': core,
    './core/RaidMap': core,
    './core/BossMap': core,
    './core/HuntMap': core,
    './core/BossCombat': core,
    './session/BattleSession': sessionModule,
    './session/RuntimeEnvironment': require('./.build/session/session/RuntimeEnvironment.js'),
    './session/ContentConfig': require('./.build/session/session/ContentConfig.js'),
    './session/GameBackendConfig': require('./.build/session/session/GameBackendConfig.js'),
    './session/GameLogin': require('./.build/session/session/GameLogin.js'),
    './session/EarlyWechatLogin': require('./.build/session/session/EarlyWechatLogin.js'),
    './view/FeatureCode': {},
    './platform/PlatformServices': require('./.build/session/platform/PlatformServices.js'),
    './session/TutorialPreview': require('./.build/session/session/TutorialPreview.js'),
    './session/RewardedAds': require('./.build/session/session/RewardedAds.js'),
    './session/AudioPreferences': {},
    './session/WeChatFontFallback': {},
    './view/SafeArea': {},
    './view/FontPolicyLabel': {},
    './view/StartupLoadingScreen': {},
    './view/CloudSavePanel': {},
    './session/CloudSaveStorage': require('./.build/session/session/CloudSaveStorage.js'),
    './view/ResourceLoadingPolicy': require('./support/resource-modules.cjs').resourceModules()('ResourceLoadingPolicy'),
    './view/UiPreparationQueue': require('./support/resource-modules.cjs').resourceModules()('UiPreparationQueue'),
    './view/BackgroundPreparationScheduler': require('./support/resource-modules.cjs').resourceModules()('BackgroundPreparationScheduler'),
    './view/ResourceModuleManager': require('./support/resource-modules.cjs').resourceModules()('ResourceModuleManager'),
    './view/StartupTimeline': require('./support/resource-modules.cjs').resourceModules()('StartupTimeline'),
    './view/StartupPreparationBudget': require('./support/resource-modules.cjs').resourceModules()('StartupPreparationBudget'),
    './view/FeatureResourceManifest': require('./support/resource-modules.cjs').resourceModules()('FeatureResourceManifest'),
    // These tests cover purchase/modal contracts; diagnostics and GPU leases are separate suites.
    './view/LoadingPerformanceTrace': { LoadingPerformanceTrace: class {
      frame() {} mark() {} measure(feature, phase, work) { return work(); }
      snapshot() { return { frames: [], events: [] }; }
    } },
    './view/SkinHudColorPipeline': { disposeSkinHudPresentation() {}, skinHudPresentationSnapshot: () => ({}) },
    './view/MineHud': {},
    './view/AdventureHud': {},
    './core/MineMap': core,
  };
  for (const name of ['BattleAssetLoader', 'GameResourcePreloader', 'FeatureEntry', 'ArtLibrary', 'BattlefieldView', 'GameHud', 'OriginalFeedbackAssets',
    'OriginalMapView', 'OriginalColorPipeline', 'OriginalColorMath', 'OriginalHudAssets',
    'DailyCheckHud', 'OfflineHud', 'OriginalMoneyBurst', 'DamageNumbers', 'WeaponVisualAssets', 'WeaponHud', 'OriginalAlerts', 'OriginalSfx', 'OriginalBgm', 'SettingsHud', 'RebirthHud', 'SpeedRunHud', 'RaidHud', 'BossHud', 'HuntHud', 'SkinHud', 'SkinVisualAssets', 'PetHud', 'PetView', 'FishHud', 'TutorialHud', 'RewardedAdModal']) {
    imports[`./view/${name}`] = {};
  }
  imports['./view/FeatureEntry'].rightMenuOffsets = () => ({});
  imports['./view/FeatureEntry'].rightMenuShareOffset = () => 355;
  imports['./view/DailyShareEntry'] = {};
  imports['./view/FeatureEntry'].leftMenuOffsets = () => ({});
  const source = fs.readFileSync(projectPath('assets/scripts/GameBootstrap.ts'), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
  } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, require: name => {
    assert.ok(Object.hasOwn(imports, name), `Missing import: ${name}`);
    return imports[name];
  } });
  return module.exports.GameBootstrap;
}
const GameBootstrap = loadBootstrap();

test('startup overlaps exactly one next asset load with current UI and waits for every complete view', async () => {
  const app=new GameBootstrap(),events=[];
  const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
  const flush=()=>new Promise(setImmediate),assets={},views={};
  app.preparationReady=true;app.startupModules=['settings','fish','pets'];
  app.resourcePreloader={updateStartupDownloads(){}};app.uiPreparation={tick(){}};
  let released=false;app.startupRelease=()=>{released=true;};
  const { StartupPreparationBudget }=require('./support/resource-modules.cjs').resourceModules()('StartupPreparationBudget');
  app.startupBudget=new StartupPreparationBudget(0,false,()=>99999);
  for(const name of [...app.startupModules,'locked']){
    assets[name]=deferred();views[name]=deferred();
    app.resourceModules.register(name,{load:()=>{events.push(name+':assets');return assets[name].promise;},
      create:()=>{events.push(name+':view');return views[name].promise;}});
  }
  app.updateStartupPreparation();await flush();assert.deepEqual(events,['settings:assets']);
  assets.settings.resolve({});await flush();app.updateStartupPreparation();await flush();
  assert.deepEqual(events,['settings:assets','settings:view','fish:assets']);
  assets.fish.resolve({});await flush();app.updateStartupPreparation();await flush();
  assert.equal(app.resourceModules.isAssetReady('fish'),true);assert.equal(app.resourceModules.isViewReady('fish'),false);
  assert.equal(events.includes('fish:view'),false);assert.equal(events.includes('pets:assets'),false);
  app.checkStartupRelease();assert.equal(released,false,'expired budget cannot bypass views');
  views.settings.resolve();await flush();app.backgrounded=true;app.updateStartupPreparation();await flush();
  assert.equal(events.includes('fish:view'),false,'hidden frames cannot admit another view');
  app.backgrounded=false;app.updateStartupPreparation();await flush();app.updateStartupPreparation();await flush();
  assert.equal(events.filter(x=>x==='fish:assets').length,1);assert.ok(events.includes('pets:assets'));
  assets.pets.resolve({});views.fish.resolve();await flush();app.updateStartupPreparation();await flush();
  app.checkStartupRelease();assert.equal(released,false);views.pets.resolve();await flush();app.checkStartupRelease();
  assert.equal(released,true);assert.equal(events.some(x=>x.startsWith('locked:')),false);
});

test('failed next-panel assets retry in the ordinary startup path without repeated speculative loads', async () => {
  const app=new GameBootstrap();let finish,loads=0;const flush=()=>new Promise(setImmediate);
  app.preparationReady=true;app.startupModules=['settings','fish'];
  app.resourcePreloader={updateStartupDownloads(){}};app.uiPreparation={tick(){}};
  app.resourceModules.register('settings',{load:async()=>{},create:()=>new Promise(resolve=>finish=resolve)});
  app.resourceModules.register('fish',{load:async()=>{if(++loads===1)throw Error('offline');},create:async()=>{}});
  app.updateStartupPreparation();await flush();app.updateStartupPreparation();await flush();
  for(let i=0;i<5;i++){app.updateStartupPreparation();await flush();}
  assert.equal(loads,1);assert.equal(app.startupFailure,undefined);assert.equal(app.resourceModules.isViewReady('fish'),false);
  finish();await flush();app.updateStartupPreparation();await flush();
  assert.equal(loads,2);assert.equal(app.resourceModules.isViewReady('fish'),true);
});

const featureHuds = ['weaponsHud', 'rebirthHud', 'speedRunHud', 'raidHud', 'bossHud', 'skinHud', 'petHud', 'fishHud', 'adventureHud', 'settingsHud'];

function modalFixture() {
  const app = new GameBootstrap();
  app.session = { mode: 'Main', rebirthAnimating: false, getTutorialState: () => ({ active: false }),
    getDailyShareState: () => undefined,
    content: { isUnlocked: () => true }, getSpeedRunState: () => ({ unlocked: true }),
    getContentState: () => ({ visible: true }) };
  app.hudRoot = { children: [] };
  const node = name => {
    const value = { name, active: true, parent: app.hudRoot,
      getSiblingIndex() { return this.parent.children.indexOf(this); },
      setSiblingIndex(index) {
        const siblings = this.parent.children;
        siblings.splice(siblings.indexOf(this), 1); siblings.splice(Math.min(index, siblings.length), 0, this);
      } };
    app.hudRoot.children.push(value); return value;
  };
  node('battlefield');
  for (const name of featureHuds) {
    app[name] = { node: node(name), isOpen: false, blocksUpgrades: false,
      setEntryVisible(visible) { this.entryVisible = visible; },
      setEntryBlocked(blocked) { this.entryBlocked = blocked; }, setContentBlocked() {},
      close() { this.isOpen = false; },
      setExternalModalOpen(open) { this.externalModalOpen = open; } };
  }
  node('alerts'); node('tutorial'); node('rewardedAd');
  app.rewardedAds = { isPresenting: false };
  app.hud = { setModalOpen(open) { this.modalOpen = open; } };
  app.battlefield = { setShootingMuted(muted) { this.shootingMuted = muted; } };
  return app;
}

function assertEntriesBlocked(app, blocked) {
  for (const name of featureHuds) {
    assert.equal(app[name].entryBlocked, blocked, `${name} entry input`);
  }
}

function assertForeground(app, name) {
  const foreground = app[name].node;
  for (const other of featureHuds) {
    if (other !== name) assert.ok(foreground.getSiblingIndex() > app[other].node.getSiblingIndex(), `${name} covers ${other}'s menu`);
  }
  assert.deepEqual(app.hudRoot.children.slice(1 + featureHuds.length).map(node => node.name), ['alerts', 'tutorial', 'rewardedAd'],
    'feature popups stay below alerts, tutorial and rewarded advertisements');
}

for (const name of featureHuds) {
  test(`${name} popup covers every feature menu without passing higher overlays`, () => {
    const app = modalFixture();
    app.syncModalState(); assertEntriesBlocked(app, false);
    app[name].isOpen = true; app[name].blocksUpgrades = true;
    app.syncModalState(); assertForeground(app, name); assertEntriesBlocked(app, true);
    assert.equal(app.hud.modalOpen, true); assert.equal(app.battlefield.shootingMuted, true);
    app[name].isOpen = false; app[name].blocksUpgrades = false;
    app.syncModalState(); assertEntriesBlocked(app, false);
    assert.equal(app.hud.modalOpen, false); assert.equal(app.battlefield.shootingMuted, false);
  });
}

for (const [name, target, field, value, clear] of [
  ['rebirth animation', 'session', 'rebirthAnimating', true, false],
  ['rewarded advertisement', 'rewardedAds', 'isPresenting', true, false],
  ['mode reveal', null, 'modeRevealElapsed', 0, null],
]) test(`all menu entries block and restore input with ${name}`, () => {
  const app = modalFixture(), owner = target ? app[target] : app;
  app.syncModalState(); assertEntriesBlocked(app, false);
  owner[field] = value; app.syncModalState(); assertEntriesBlocked(app, true);
  assert.equal(app.hud.modalOpen, true); assert.equal(app.battlefield.shootingMuted, true);
  owner[field] = clear; app.syncModalState(); assertEntriesBlocked(app, false);
  assert.equal(app.hud.modalOpen, false); assert.equal(app.battlefield.shootingMuted, false);
});

test('nested popup closes restore the remaining foreground while keeping entries blocked', () => {
  const app = modalFixture();
  app.weaponsHud.isOpen = true; app.rebirthHud.isOpen = true;
  app.syncModalState(); assertForeground(app, 'weaponsHud'); assertEntriesBlocked(app, true);
  app.rewardedAds.isPresenting = true; app.syncModalState(); assertEntriesBlocked(app, true);
  app.rewardedAds.isPresenting = false; app.weaponsHud.isOpen = false;
  app.syncModalState(); assertForeground(app, 'rebirthHud'); assertEntriesBlocked(app, true);
  app.rebirthHud.isOpen = false; app.syncModalState(); assertEntriesBlocked(app, false);
});

test('raid star upgrades take foreground priority and return it to Raid when closed', () => {
  const app = modalFixture(); app.raidHud.isOpen = true; app.raidHud.blocksUpgrades = true;
  app.syncModalState(); assertForeground(app, 'raidHud');
  app.weaponsHud.isOpen = true; app.syncModalState(); assertForeground(app, 'weaponsHud'); assertEntriesBlocked(app, true);
  app.weaponsHud.isOpen = false; app.syncModalState(); assertForeground(app, 'raidHud'); assertEntriesBlocked(app, true);
  app.raidHud.isOpen = false; app.raidHud.blocksUpgrades = false;
  app.session.mode = 'Raid'; app.syncModalState(); assertEntriesBlocked(app, true);
  app.session.mode = 'Main'; app.syncModalState(); assertEntriesBlocked(app, false);
});

function fixture({ actors = 3, levels = [0, 0, 0], environment = 'test' } = {}) {
  const app = new GameBootstrap();
  app.world = new core.CombatWorld(73);
  const data = new Map(), key = sessionModule.economyStorageKey(environment);
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  new sessionModule.BattleSession({ environment, storage });
  const saved = JSON.parse(data.get(key));
  saved.levels = levels; saved.money = { digits: '0', exponent: 0, precision: 1 };
  data.set(key, JSON.stringify(saved));
  app.session = new sessionModule.BattleSession({ environment,
    storage,
    onWeaponsChanged: force => app.syncLoadout(force ? 'equipment' : 'inventory'),
  });
  if (actors > 1) for (let slot = 1; slot < actors; slot++) {
    assert.equal(app.session.weapons.grantTestWeapon(slot).ok, true);
    assert.equal(app.session.weapons.equip(0, slot).ok, true);
  }
  app.syncLoadout();
  app.ready = true;
  app.weaponsHud = { isOpen: false };
  app.battlefield = { hasActiveRewards: false, prepareLoadout() {} };
  app.hud = { update(state) { this.state = state; } };
  assert.equal(app.world.fire(), true);
  app.world.drainEvents();
  app.world.spread = 7;
  app.world.attackClock = .017;
  app.world.followers.forEach((follower, index) => {
    follower.spread = 9 + index;
    follower.attackClock = .023 + index * .01;
  });
  return app;
}

function combatState(world) {
  return {
    clocks: [world.attackClock, ...world.followers.map(follower => follower.attackClock)],
    spreads: [world.spread, ...world.followers.map(follower => follower.spread)],
    players: JSON.stringify(world.players),
    bullets: JSON.stringify(world.bullets.filter(bullet => bullet.active)),
    stats: JSON.stringify(world.stats),
  };
}

for (const actors of [1, 3]) for (const scenario of [
  { type: 'power', levels: [0, 0, 0] },
  { type: 'speed', levels: [0, 0, 0] },
  { type: 'money', levels: [0, 0, 0] },
  { type: 'speed', levels: [0, 1000, 0], capped: true },
]) {
  test(`real upgrade entry resets all ${actors} cats: ${scenario.type}${scenario.capped ? ' after cooldown reaches its floor' : ''}`, () => {
    const app = fixture({ actors, levels: scenario.levels });
    const before = combatState(app.world);
    const oldMoney = app.session.moneyBalance;
    const upgrade = app.hudState().upgrades.find(value => value.type === scenario.type);
    if (scenario.capped) assert.ok(app.session.combatLoadout.every(actor => actor.attackInterval === Math.fround(.05)));

    assert.equal(app.purchaseUpgrade(scenario.type), true);

    const after = combatState(app.world);
    assert.deepEqual(after.spreads, Array(actors).fill(0));
    assert.deepEqual(after.clocks, before.clocks, 'upgrades preserve accrued attack cooldown');
    assert.equal(after.players, before.players, 'positions, aim and targets do not reset');
    assert.equal(after.bullets, before.bullets, 'already fired projectiles retain their shot-time state');
    assert.equal(after.stats, before.stats, 'buying an upgrade does not advance combat');
    assert.equal(app.session.moneyBalance.compare(oldMoney.sub(upgrade.price)), 0);
    assert.equal(app.hud.state.upgrades.find(value => value.type === scenario.type).level, upgrade.level + 1);
    const desired = app.session.combatLoadout;
    app.world.loadout.forEach((actor, index) => {
      assert.equal(actor.damage.compare(desired[index].damage), 0);
      assert.equal(actor.attackInterval, desired[index].attackInterval);
    });
  });
}

for (const scenario of [
  { name: 'not ready', setup: app => { app.ready = false; } },
  { name: 'paused', setup: app => { app.manuallyPaused = true; } },
  { name: 'backgrounded', setup: app => { app.backgrounded = true; } },
  { name: 'another mode', setup: app => app.session.setMode('Mine') },
  { name: 'weapon popup', setup: app => { app.weaponsHud.isOpen = true; } },
  { name: 'skin popup', setup: app => { app.skinHud = { isOpen: true }; } },
  { name: 'fish popup', setup: app => { app.fishHud = { isOpen: true }; } },
  { name: 'settings popup', setup: app => { app.settingsHud = { isOpen: true }; } },
  { name: 'daily check popup', setup: app => { app.dailyCheckHud = { isOpen: true }; } },
  { name: 'daily check loading', setup: app => { app.dailyCheckOpening = true; } },
  { name: 'settings loading', setup: app => { app.settingsOpening = true; } },
  { name: 'results ready', setup: app => {
    app.world.stats.complete = true;
    for(const tree of app.world.trees)tree.alive=false;
    app.session.consume([{type:'complete',position:{x:0,z:0}}],app.world.trees);
  } },
  { name: 'maximum level', options: { levels: [0, 0, 10000] } },
  { name: 'insufficient funds', options: { actors: 1, environment: 'production' } },
]) {
  test(`rejected purchase leaves spread and combat unchanged: ${scenario.name}`, () => {
    const app = fixture(scenario.options);
    if (scenario.name.startsWith('daily check')) {
      const price = app.hudState().upgrades.find(value => value.type === 'money').price;
      assert.ok(app.session.moneyBalance.compare(price) >= 0, 'daily modal must block an otherwise affordable purchase');
    }
    scenario.setup?.(app);
    const before = combatState(app.world), money = app.session.moneyBalance.toString();
    assert.equal(app.purchaseUpgrade('money'), false);
    assert.deepEqual(combatState(app.world), before);
    assert.equal(app.session.moneyBalance.toString(), money);
  });
}

test('unrelated inventory changes still avoid rebalancing active cats', () => {
  const app = fixture();
  const before = combatState(app.world);
  assert.equal(app.session.weapons.grantTestStarGems(50).ok, true);
  assert.deepEqual(combatState(app.world), before);
});

for (const type of ['power', 'speed', 'money']) test(`Mine ${type} upgrade refreshes the active squad without replacing projectiles`, () => {
  const app = fixture({ actors: 3 });
  assert.equal(app.session.openMine().ok, true); assert.equal(app.session.startMine().ok, true);
  app.session.setMineOreCount(1000); app.session.advanceFrame(1.5); app.syncLoadout('equipment');
  app.world.spread = 7; app.world.followers.forEach(actor => { actor.spread = 9; });
  const before = combatState(app.world), intervals = app.world.loadout.map(actor => actor.attackInterval);
  assert.equal(app.purchaseUpgrade(type), true);
  const after = combatState(app.world);
  assert.deepEqual(after.spreads, [0, 0, 0]); assert.deepEqual(after.clocks, before.clocks);
  assert.equal(after.bullets, before.bullets); assert.equal(after.players, before.players); assert.equal(after.stats, before.stats);
  app.world.loadout.forEach((actor, index) => {
    assert.equal(actor.damage.toString(), '1'); assert.equal(actor.criticalChance, 0);
    assert.equal(actor.attackInterval, app.session.combatLoadout[index].attackInterval);
    if (type === 'speed') assert.ok(actor.attackInterval < intervals[index]);
  });
});

for (const kind of ['equip', 'swap']) test(`identical-weapon ${kind} still reloads all cats without resetting cooldown or projectiles`, () => {
  const app = fixture({ actors: 1 });
  for (let i = 0; i < 2; i++) assert.equal(app.session.weapons.grantTestWeapon(0).ok, true);
  assert.equal(app.session.weapons.equip(0, 1).ok, true);
  app.world.spread = 7; app.world.followers[0].spread = 9;
  const before = combatState(app.world), signature = app.loadoutSignature;
  const result = kind === 'equip' ? app.session.weapons.equip(1, 0) : app.session.weapons.swapEquipment(0, 1);
  assert.equal(result.ok, true); assert.equal(app.loadoutSignature, signature);
  const after = combatState(app.world);
  assert.deepEqual(after.spreads, [0, 0]);
  assert.deepEqual(after.clocks, before.clocks);
  assert.equal(after.players, before.players);
  assert.equal(after.bullets, before.bullets);
  assert.equal(after.stats, before.stats);
});

test('rejected equipment transactions and equipment locks do not reload combat balance', () => {
  const app = fixture({ actors: 1 }), before = combatState(app.world);
  assert.equal(app.session.weapons.equip(0, 0).ok, false);
  assert.equal(app.session.weapons.swapEquipment(1, 0).ok, false);
  assert.equal(app.session.weapons.unequip(0).ok, false);
  assert.equal(app.session.weapons.toggleLock({ kind: 'equipment', index: 0 }).ok, true);
  assert.deepEqual(combatState(app.world), before);
});

test('a successful star upgrade reloads cats even for an empty slot, while failure preserves spread', () => {
  const app = fixture({ actors: 1 }), before = combatState(app.world), signature = app.loadoutSignature;
  assert.equal(app.session.weapons.upgradeStar(2).status, 'success');
  assert.equal(app.loadoutSignature, signature); assert.equal(app.world.spread, 0);
  assert.deepEqual(combatState(app.world).clocks, before.clocks);
  app.world.spread = 7; app.session.weapons.rng = () => .999;
  assert.equal(app.session.weapons.upgradeStar(2).status, 'failure');
  assert.equal(app.world.spread, 7);
});

test('Skin bootstrap purchase reloads squad balance once while equip changes appearance without a combat reset', () => {
  const app = fixture({ actors: 3 }), before = combatState(app.world), wallet = app.session.weapons.diamonds;
  const loaded = new Set([0]); app.skinVisuals = { isLoaded: id => loaded.has(id) };
  app.battlefield.setSkin = function (id) { this.skinId = id; };
  const price = app.session.getSkinState().items[1].price;
  assert.equal(app.purchaseSkin(1).ok, true);
  assert.equal(app.session.weapons.diamonds, wallet - price);
  assert.equal(app.session.getSkinState().selectedId, 0);
  const after = combatState(app.world);
  assert.deepEqual(after.spreads, [0, 0, 0]); assert.deepEqual(after.clocks, before.clocks);
  assert.equal(after.players, before.players); assert.equal(after.bullets, before.bullets); assert.equal(after.stats, before.stats);
  app.world.spread = 7; app.world.followers.forEach(follower => { follower.spread = 9; });
  const preEquip = combatState(app.world), signature = app.loadoutSignature;
  assert.equal(app.equipSkin(1).ok, false, 'unprepared public equip must not persist an invisible skin');
  assert.equal(app.session.getSkinState().selectedId, 0); loaded.add(1);
  assert.equal(app.equipSkin(1).ok, true); assert.equal(app.battlefield.skinId, 1);
  assert.equal(app.loadoutSignature, signature); assert.deepEqual(combatState(app.world), preEquip);
  assert.equal(app.purchaseSkin(1).ok, false); assert.equal(app.equipSkin(2).ok, false);
  assert.deepEqual(combatState(app.world), preEquip);
});
