const test = require('node:test');
const assert = require('node:assert/strict');
const { economyModules } = require('./support/economy-modules.cjs');
const { ECONOMY_CONFIG, validateEconomyConfig } = require('./.build/session/core/EconomyConfig.js');
const NOW = new Date(2026, 9, 18, 12).getTime();
const normalLoad = name => require(`./.build/session/${name}.js`);

function fixture({ load = normalLoad, environment = 'test', testResources = {}, edit, data = new Map(), rng = () => 0 } = {}) {
  const { BattleSession, economyStorageKey } = load('session/BattleSession');
  const { resolveContentConfig } = load('session/ContentConfig');
  const key = economyStorageKey(environment);
  let now = NOW, unreadable = false, failReadback = false;
  const storage = {
    getItem(k) { if (unreadable) throw Error('travel supply readback unavailable'); return data.get(k) ?? null; },
    setItem(k, raw) { data.set(k, raw); if (failReadback) unreadable = true; },
  };
  const contentConfig = resolveContentConfig(environment, { tutorialEnabled: false, firstDrawDiamonds: 0,
    thresholds: { adventureStage: 0, adventureVisibleStage: 0 },
    testResources: { diamonds: 0, starGems: 0, fundGoldUpgrades: false, fundRebirthUpgrades: false, ...testResources } });
  const make = () => new BattleSession({ environment, contentConfig, storage, now: () => now, rng });
  let session = make();
  const saved = () => JSON.parse(data.get(key));
  if (edit) { const value = saved(); edit(value); data.set(key, JSON.stringify(value)); session = make(); }
  return { session, make, saved, data, key, contentConfig, setNow: value => { now = value; },
    failReadback: () => { failReadback = true; } };
}
const resources = session => {
  const { tickets, cores } = session.getAdventureState();
  return { tickets, cores };
};
const floorResources = { tickets: 1000000, cores: [1000000, 1000000, 1000000, 1000000] };

test('new test saves durably fund a million travel tickets and each core without changing progression', () => {
  const f = fixture(), state = f.session.getAdventureState();
  assert.equal(ECONOMY_CONFIG.testResources.adventureTickets, 1000000);
  assert.equal(ECONOMY_CONFIG.testResources.adventureCores, 1000000);
  assert.equal(ECONOMY_CONFIG.testResources.relicMaxDrawCount, 100);
  assert.deepEqual(resources(f.session), floorResources);
  assert.equal(f.saved().adventure.tickets, 1000000);
  assert.deepEqual(f.saved().adventure.cores, floorResources.cores);
  assert.equal(state.level, 0); assert.equal(state.exp, 0); assert.equal(state.ticketMax, 20);
  assert.equal(state.ticketRemainingMs, 0);
  assert.equal(state.maps.every(map => map.pets.length === 0), true);
  assert.equal(f.session.getRelicState().items.every(item => !item.unlocked), true);
});

test('production keeps ordinary initial and restored balances and rejects explicit test supply', () => {
  const fresh = fixture({ environment: 'production' });
  assert.deepEqual(resources(fresh.session), { tickets: 20, cores: [0, 0, 0, 0] });
  const f = fixture({ environment: 'production', edit: saved => {
    saved.adventure.tickets = 7; saved.adventure.cores = [13, 2000000, 29, 31];
  } });
  const before = resources(f.session), raw = f.data.get(f.key);
  assert.deepEqual(before, { tickets: 7, cores: [13, 2000000, 29, 31] });
  assert.equal(f.session.refillTestResources(), false);
  assert.deepEqual(resources(f.session), before); assert.equal(f.data.get(f.key), raw);
});

test('restored test balances only rise to the floor and retain running trips, pet locks and allowances', () => {
  let original;
  const f = fixture({ edit: saved => {
    saved.adventure.tickets = 2000000; saved.adventure.cores = [12, 2000000, 34, 3000000];
    saved.adventure.exp = 17; saved.adventure.adDate = '2026-10-18'; saved.adventure.adUsed = 1;
    saved.pets.owned[0] = 0; saved.pets.collected[0] = true;
    saved.adventure.nextRunId = 2;
    saved.adventure.maps[0] = { startedAt: NOW, runId: 1, pets: [{ kind: 'owned', index: 0, grade: 0 }] };
    original = JSON.parse(JSON.stringify(saved.adventure));
  } });
  assert.deepEqual(resources(f.session), { tickets: 2000000, cores: [1000000, 2000000, 1000000, 3000000] });
  const expected = { ...original, cores: [1000000, 2000000, 1000000, 3000000] };
  assert.deepEqual(f.saved().adventure, expected);
  assert.equal(f.session.getPetState().ownedLocked[0], true);
  assert.equal(f.session.getAdventureState().maps[0].status, 'running');
  assert.equal(f.session.getAdventureState().adRemaining, 1);
  assert.equal(f.session.refillTestResources(), true);
  assert.deepEqual(f.saved().adventure, expected);
});

test('reload and explicit refill replenish spent test wallets without clearing a newly dispatched trip', () => {
  const f = fixture({ edit: saved => { saved.pets.owned[0] = 0; saved.pets.collected[0] = true; } }), s = f.session;
  assert.equal(s.startAdventure(0, 0, [{ kind: 'owned', index: 0 }]).ok, true);
  assert.equal(s.drawRelic(1).ok, true);
  assert.equal(s.getAdventureState().tickets, 999999);
  assert.equal(s.getAdventureState().cores[1], 999980);
  const trip = f.saved().adventure.maps[0], relics = f.saved().relics;
  assert.equal(s.refillTestResources(), true);
  assert.deepEqual(resources(s), floorResources);
  assert.deepEqual(f.saved().adventure.maps[0], trip); assert.deepEqual(f.saved().relics, relics);
  assert.equal(s.getPetState().ownedLocked[0], true);
  assert.equal(s.drawRelic(2).ok, true);
  const reloaded = f.make();
  assert.deepEqual(resources(reloaded), floorResources);
  assert.deepEqual(f.saved().adventure.maps[0], trip); assert.equal(reloaded.getPetState().ownedLocked[0], true);
  assert.equal(reloaded.getRelicState().items.filter(item => item.unlocked).length, 2);
});

test('zero overrides disable travel supply and the domain floor operation is idempotent', () => {
  const f = fixture({ testResources: { adventureTickets: 0, adventureCores: 0 } });
  assert.deepEqual(resources(f.session), { tickets: 20, cores: [0, 0, 0, 0] });
  assert.equal(f.session.refillTestResources(), true);
  assert.deepEqual(resources(f.session), { tickets: 20, cores: [0, 0, 0, 0] });
  const { AdventureSystem } = normalLoad('session/AdventureSystem'), adventure = new AdventureSystem(NOW);
  assert.equal(adventure.ensureResourceFloor(0, 0), false);
  assert.equal(adventure.ensureResourceFloor(40, 60), true);
  const before = adventure.serialize();
  assert.equal(adventure.ensureResourceFloor(20, 50), false);
  assert.equal(adventure.ensureResourceFloor(40, 60), false);
  assert.deepEqual(adventure.serialize(), before);
});

test('missing travel blocks block persistence and test supply while malformed current blocks remain intact', t => {
  t.mock.method(console, 'warn', () => {});
  const legacy = fixture({ edit: saved => { delete saved.adventure; delete saved.relics; } });
  const raw = legacy.data.get(legacy.key);
  assert.equal(legacy.session.persistenceBlocked, true);
  assert.deepEqual(resources(legacy.session), { tickets: 20, cores: [0, 0, 0, 0] });
  legacy.session.refillTestResources(); legacy.session.checkpointForeground();
  assert.equal(legacy.data.get(legacy.key), raw); assert.equal(legacy.saved().adventure, undefined);
  const broken = { version: 91, future: ['keep', { amount: 9 }] };
  for (const block of ['adventure', 'relics']) {
    const f = fixture({ edit: saved => { saved[block] = broken; } });
    assert.deepEqual(f.saved()[block], broken);
    f.session.refillTestResources(); f.session.checkpointForeground();
    assert.deepEqual(f.saved()[block], broken);
    if (block === 'adventure') {
      assert.equal(f.session.getAdventureState().saveInvalid, true);
      assert.deepEqual(resources(f.session), { tickets: 20, cores: [0, 0, 0, 0] });
    } else assert.deepEqual(resources(f.session), floorResources);
  }
});

test('travel supply waits until offline restoration commits and then fills the restored wallet', async () => {
  const f = fixture(), saved = f.saved();
  saved.adventure.tickets = 7; saved.adventure.cores = [1, 2, 3, 4];
  saved.offline = { lastSavedAtMs: NOW }; f.data.set(f.key, JSON.stringify(saved));
  f.setNow(NOW + 31000);
  const s = f.make(), raw = f.data.get(f.key);
  assert.equal(s.offlineInitializationPending, true);
  assert.deepEqual(resources(s), { tickets: 7, cores: [1, 2, 3, 4] });
  s.refillTestResources();
  assert.deepEqual(resources(s), { tickets: 7, cores: [1, 2, 3, 4] });
  assert.equal(f.data.get(f.key), raw);
  assert.equal((await s.initializeOfflineProgress()).ok, true);
  assert.deepEqual(resources(s), floorResources);
  assert.equal(f.saved().adventure.tickets, 1000000);
});

test('test refill cannot replace a committed travel draw when storage readback became uncertain', () => {
  const f = fixture(), s = f.session;
  assert.equal(s.drawRelic(0).ok, true);
  const before = resources(s); f.failReadback();
  assert.equal(s.drawRelic(0).reason, 'saveFailed');
  const committed = f.data.get(f.key);
  assert.equal(JSON.parse(committed).adventure.cores[0], 999960);
  s.refillTestResources(); s.save();
  assert.deepEqual(resources(s), before); assert.equal(f.data.get(f.key), committed);
});

test('edited economy supply and batch settings flow through content, state, debit and save', () => {
  const load = economyModules(config => {
    Object.assign(config.testResources, { adventureTickets: 321, adventureCores: 654, relicMaxDrawCount: 7 });
    config.relics.drawPrice = 13;
  });
  const f = fixture({ load }), s = f.session;
  assert.equal(f.contentConfig.testResources.adventureTickets, 321);
  assert.equal(f.contentConfig.testResources.adventureCores, 654);
  assert.equal(f.contentConfig.testResources.relicMaxDrawCount, 7);
  assert.deepEqual(resources(s), { tickets: 321, cores: [654, 654, 654, 654] });
  assert.deepEqual(s.getRelicState().drawMax, [7, 7, 7, 7]);
  const result = s.drawRelic(3, true);
  assert.equal(result.ok, true); assert.equal(result.drawn.length, 7); assert.equal(result.spent, 91);
  assert.equal(f.saved().adventure.cores[3], 563);
  const lower = economyModules(config => {
    Object.assign(config.testResources, { adventureTickets: 21, adventureCores: 22, relicMaxDrawCount: 3 });
  });
  const reloaded = fixture({ load: lower, data: f.data }).session;
  assert.deepEqual(resources(reloaded), { tickets: 321, cores: [654, 654, 654, 563] });
});

test('invalid travel supply and batch values fail configuration validation before they reach a wallet', () => {
  const { resolveContentConfig } = normalLoad('session/ContentConfig');
  for (const field of ['adventureTickets', 'adventureCores', 'relicMaxDrawCount']) {
    const values = [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
    if (field === 'relicMaxDrawCount') values.push(0);
    for (const value of values) {
      const bad = JSON.parse(JSON.stringify(ECONOMY_CONFIG)); bad.testResources[field] = value;
      assert.throws(() => validateEconomyConfig(bad), /Invalid economy configuration/, `${field}=${value}`);
      assert.throws(() => resolveContentConfig('test', { testResources: { [field]: value } }), /Invalid content configuration/, `${field}=${value}`);
    }
  }
});

test('test maximum draw displays and debits the same bounded count across all four core types', () => {
  let rolls = 0;
  const f = fixture({ rng: () => { rolls++; return 0; } }), s = f.session;
  for (let core = 0; core < 4; core++) {
    const state = s.getRelicState(), before = state.cores[core], beforeRolls = rolls;
    assert.equal(state.drawMax[core], 100);
    const result = s.drawRelic(core, true);
    assert.equal(result.ok, true); assert.equal(result.drawn.length, state.drawMax[core]);
    assert.equal(rolls - beforeRolls, 100);
    assert.equal(result.spent, state.drawMax[core] * state.drawPrice);
    assert.equal(s.getAdventureState().cores[core], before - result.spent);
    assert.equal(f.saved().adventure.cores[core], before - result.spent);
  }
  const low = fixture({ testResources: { adventureTickets: 0, adventureCores: 0 }, edit: saved => { saved.adventure.cores[0] = 45; } });
  assert.equal(low.session.getRelicState().drawMax[0], 2);
  const result = low.session.drawRelic(0, true);
  assert.equal(result.drawn.length, 2); assert.equal(result.spent, 40);
  assert.equal(low.session.getAdventureState().cores[0], 5);
  assert.equal(low.session.getRelicState().drawMax[0], 0);
});

test('production maximum draw still purchases more than the test-only batch cap when affordable', () => {
  const f = fixture({ environment: 'production', edit: saved => { saved.adventure.cores[0] = 2027; } }), s = f.session;
  assert.equal(s.getRelicState().drawMax[0], 101);
  const result = s.drawRelic(0, true);
  assert.equal(result.ok, true); assert.equal(result.drawn.length, 101); assert.equal(result.spent, 2020);
  assert.equal(s.getAdventureState().cores[0], 7); assert.equal(f.saved().adventure.cores[0], 7);
});
