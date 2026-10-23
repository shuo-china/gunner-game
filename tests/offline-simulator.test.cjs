const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
// A separate compiler output permits targeted tests while other agents build the session.
const root = path.resolve(__dirname, process.env.OFFLINE_TEST_BUILD || '.build/session');
const load = name => require(path.join(root, `${name}.js`));
const { OriginalInfVal: I } = load('core/OriginalInfVal');
const { getWeapon } = load('core/WeaponCatalog');
const { ECONOMY_CONFIG, validateEconomyConfig } = load('core/EconomyConfig');
const { computeOfflineElapsed, effectiveMaxOfflineSeconds, runOfflineProgress, runOfflineProgressAsync,
  OfflineProgressEngine, calculateOfflineClearInfo } = load('session/OfflineProgressSimulator');
const strong = { type: 'SINGLE', damage: '1000e0', attackInterval: 1, pelletCount: 2 };
function input(overrides = {}) {
  return { gold: I.fromInt(0), levels: [0, 0, 0], stageIndex: 0, waveIndex: 0, stageValueMax: 0,
    weapons: [strong], elapsedSeconds: 30, ...overrides };
}
function json(value) { return JSON.parse(JSON.stringify(value)); }
function configured(edit) {
  const config = json(ECONOMY_CONFIG); edit(config); validateEconomyConfig(config);
  const cache = new Map([[path.join(root, 'core/EconomyConfig.js'), { ECONOMY_CONFIG: config }]]);
  function read(name, parent = root) {
    const filename = path.resolve(parent, `${name}.js`);
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} }; cache.set(filename, module.exports);
    vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(
      dep => read(dep, path.dirname(filename)), module, module.exports);
    cache.set(filename, module.exports); return module.exports;
  }
  return read;
}

test('elapsed follows the original 30-second gate, 8-hour cap, float clock and 1-second capped tolerance', () => {
  assert.equal(effectiveMaxOfflineSeconds(), 28800);
  assert.equal(effectiveMaxOfflineSeconds(30), 30600);
  assert.equal(computeOfflineElapsed(undefined, 30000), null);
  assert.equal(computeOfflineElapsed(100000, 99999), null);
  assert.equal(computeOfflineElapsed(0, 29999), null);
  assert.deepEqual(computeOfflineElapsed(0, 30000), { elapsedSeconds: 30, absentSeconds: 30, isCapped: false });
  assert.equal(computeOfflineElapsed(0, 28801000).isCapped, false);
  assert.deepEqual(computeOfflineElapsed(0, 86400000), { elapsedSeconds: 28800, absentSeconds: 86400, isCapped: true });
  assert.equal(computeOfflineElapsed(0, NaN), null);
  assert.equal(computeOfflineElapsed(0, 86400000, 30).elapsedSeconds, 30600);
});

test('automatic purchases choose the lowest level, break ties power/speed/money, and retain net versus gross income', () => {
  // Shipped prices: level 0 costs 50, level 1 costs 68. Only four purchases fit.
  const source = input({ elapsedSeconds: 0, gold: I.fromInt(250), moneyAccum: I.fromInt(999) });
  const before = json(source), result = runOfflineProgress(source);
  assert.deepEqual(result.levels, [2, 1, 1]); assert.deepEqual(result.levelsGained, [2, 1, 1]);
  assert.equal(result.moneyFinal.toString(), '32'); assert.equal(result.moneyGained.toString(), '-218');
  assert.equal(result.moneyAccumFinal.toString(), '999'); assert.deepEqual(json(source), before);
  const maxed = runOfflineProgress(input({ elapsedSeconds: 0, levels: [10000, 10000, 10000], gold: I.fromInt(250) }));
  assert.equal(maxed.moneyFinal.toString(), '250'); assert.deepEqual(maxed.levelsGained, [0, 0, 0]);
  const uneven = runOfflineProgress(input({ elapsedSeconds: 0, levels: [1, 0, 0], gold: I.fromInt(50) }));
  assert.deepEqual(uneven.levels, [1, 1, 0]);
});

test('source ceiling and one-shot multi-target rules cover every weapon mechanism', () => {
  for (const [type, targets] of Object.entries({ SINGLE: 1, LASER: 10, PIERCE: 10, SHOTGUN: 2, EXPLOSIVE: 5, MISSILE: 5, BLAST_SNIPER: 5 })) {
    const clear = calculateOfflineClearInfo(input({ weapons: [{ ...strong, type }] }));
    assert.equal(clear.regularKillRate, targets, type); assert.equal(clear.combatTime, 30 / targets, type);
    // First-wave expected HP is 250*(.8+1.8*.2)=290; 100 damage takes CEIL(2.9)=3 hits.
    const weak = calculateOfflineClearInfo(input({ weapons: [{ ...strong, type, damage: '100e0' }] }));
    assert.equal(weak.regularKillRate, 1 / 3, `${type} cannot multi-kill before it can one-shot`);
    assert.equal(weak.combatTime, 90);
  }
  const shotgun = calculateOfflineClearInfo(input({ weapons: [{ ...strong, type: 'SHOTGUN', pelletCount: 0 }] }));
  assert.equal(shotgun.regularKillRate, 1);
});

test('the fifth wave includes one boss and ordinary farm rate survives an impossible clear', () => {
  const boss = calculateOfflineClearInfo(input({ waveIndex: 4, stageValueMax: 4 }));
  assert.equal(boss.regularKillRate, 1); assert.equal(boss.combatTime, 158.75); // 150 trees + (250*35)/1000
  const source = input({ weapons: [{ ...strong, damage: '1e0' }] });
  const impossible = calculateOfflineClearInfo(source);
  assert.equal(impossible.combatTime, Infinity); assert.equal(impossible.regularKillRate, 1 / 290);
  const result = runOfflineProgress(source);
  assert.equal(result.moneyFinal.toString(), '2.4000000000000001'); assert.deepEqual(result.levels, [0, 0, 0]);
  const engine = new OfflineProgressEngine({ ...source, elapsedSeconds: 5000 });
  const upgraded = engine.step(Infinity);
  assert.ok(engine.iterationCount > 1, 'failed clears farm until upgrades become affordable and recalculate');
  assert.ok(upgraded.levels.some(level => level > 0));
});

test('degree percentages divide in double precision at the native one-shot boundary', () => {
  // Native FCVT D, S precedes FDIV D (0x2B08974). float(5/100), float(35/100)
  // and float(60/100) would make average HP exceed 620 and disable pierce multi-kills.
  const clear = calculateOfflineClearInfo(input({ waveIndex: 3, stageValueMax: 3,
    weapons: [{ ...strong, type: 'PIERCE', damage: '620e0' }] }));
  assert.equal(clear.regularKillRate, 10); assert.equal(clear.combatTime, 12);
  // In wave 0, double 1.1600000000000001 promotes HP just above exact 290.
  const boundary = calculateOfflineClearInfo(input({ weapons: [{ ...strong, type: 'PIERCE', damage: '290e0' }] }));
  assert.equal(boundary.regularKillRate, 1, 'do not normalize away InfVal G17 precision before comparing one-shot HP');
});

test('positive fractional regular health is preserved; only non-positive health becomes one', () => {
  const local = configured(() => {}), stages = local('core/StageBalance');
  const Value = local('core/OriginalInfVal').OriginalInfVal, Decimal = local('core/DecimalAmount').DecimalAmount;
  let health = '0.2';
  stages.getStageHealth = () => Decimal.from(health); stages.getStageHealthPrecision = () => 17;
  const sim = local('session/OfflineProgressSimulator');
  const source = input({ gold: Value.fromInt(0), weapons: [{ ...strong, type: 'PIERCE', damage: '1e0' }],
    modifiers: { fishCriticalChance: 50, relicCriticalDamage: Value.fromInt(0) } });
  assert.equal(sim.calculateOfflineClearInfo(source).regularKillRate, 10, '0.232 HP remains below 0.5 expected damage');
  health = '0';
  assert.equal(sim.calculateOfflineClearInfo(source).regularKillRate, 0.5, 'zero HP is replaced with 1, requiring two hits');
});

test('huge-hit caps follow native ordering, including the non-finite ratio fallback', () => {
  const local = configured(() => {}), stages = local('core/StageBalance');
  const Value = local('core/OriginalInfVal').OriginalInfVal, Decimal = local('core/DecimalAmount').DecimalAmount;
  let health = '2000000000';
  stages.getStageHealth = () => Decimal.from(health); stages.getStageHealthPrecision = () => 17;
  const sim = local('session/OfflineProgressSimulator');
  const source = input({ gold: Value.fromInt(0), weapons: [{ ...strong, damage: '1e0', attackInterval: 0.001 }] });
  assert.equal(sim.calculateOfflineClearInfo(source).regularKillRate, 1 / 116000000,
    'finite 2.32e9 hits are not capped before multiplication by the 0.05f interval');
  health = '1e12';
  assert.equal(sim.calculateOfflineClearInfo(source).regularKillRate, 1e-9, 'finite kill time is capped at 1e9 seconds');
  health = '1e400';
  assert.equal(sim.calculateOfflineClearInfo(source).regularKillRate, 2e-8,
    'infinite ratio substitutes 1e9 hits, then multiplies interval, rather than substituting 1e9 seconds');
});

test('an impossible clear adds income and subtracts float wait before the next purchase pass', () => {
  // About 0.08 gold/sec reaches the first 50-gold upgrade at 625 seconds.
  // Native InfVal division of a p3 price by a p17 rate first truncates the wait
  // to 624; the next iteration farms the shortfall before a purchase is possible.
  const source = input({ weapons: [{ ...strong, damage: '1e0' }], elapsedSeconds: 624 });
  assert.deepEqual(runOfflineProgress(source).levels, [0, 0, 0]);
  const atThreshold = runOfflineProgress({ ...source, elapsedSeconds: 625 });
  assert.deepEqual(atThreshold.levels, [1, 0, 0]);
  let ticks = 0;
  const engine = new OfflineProgressEngine({ ...source, elapsedSeconds: 626 });
  assert.equal(engine.step(1, () => ticks++), null);
  assert.equal(engine.iterationCount, 1); assert.equal(engine.remainingSeconds, 2);
  const result = engine.step(Infinity);
  assert.deepEqual(result.levels, [1, 0, 0]); assert.equal(engine.iterationCount, 3);
});

test('partial finite clears farm the remainder once, then buy upgrades, without a new clear attempt', () => {
  const engine = new OfflineProgressEngine(input({ weapons: [{ ...strong, damage: '100e0' }] }));
  const result = engine.step(Infinity);
  assert.equal(engine.iterationCount, 1); assert.deepEqual(result.levels, [2, 1, 1]);
  assert.equal(result.moneyAccumFinal.toString(), '232'); assert.equal(result.moneyFinal.toString(), '14');
  assert.equal(result.stagesCleared, 0);
});

test('simulation replays up to historical progress, never unlocks a new record or counts repeats as cleared', () => {
  const replay = runOfflineProgress(input({ stageValueMax: 4, elapsedSeconds: 1200 }));
  assert.equal(replay.stageIndex, 0); assert.equal(replay.waveIndex, 4); assert.equal(replay.stageValueMax, 4);
  assert.equal(replay.stagesCleared, 4);
  const stalled = runOfflineProgress(input({ elapsedSeconds: 1200 }));
  assert.equal(stalled.waveIndex, 0); assert.equal(stalled.stagesCleared, 0);
  assert.ok(stalled.moneyAccumFinal.amount.compare(0) > 0);
});

test('pet movement and historical replay affect traversal floors; neither imposes that floor on raw farm rate', () => {
  const weapons = [{ ...strong, type: 'PIERCE', attackInterval: 0.001 }];
  const normal = calculateOfflineClearInfo(input({ weapons }));
  const pet = calculateOfflineClearInfo(input({ weapons, modifiers: { petSpeed: 200 } }));
  const replay = calculateOfflineClearInfo(input({ weapons, stageValueMax: 1 }));
  assert.equal(normal.combatTime, 1.5); assert.equal(pet.combatTime, 0.75); assert.equal(replay.combatTime, 0.75);
  assert.ok(normal.regularKillRate > 99.99); assert.ok(pet.regularKillRate > 199.99);
  const income = runOfflineProgress(input({ weapons, elapsedSeconds: 0.1 }));
  assert.ok(income.moneyAccumFinal.amount.toNumber() > 230, 'raw kill rate, rather than N/combatTime or /1.3, determines partial farming');
});

test('offline damage uses fish expected criticals and its own truncation instead of slot stars or live buffs', () => {
  const weapon = { ...strong, damage: '200e0' };
  const base = calculateOfflineClearInfo(input({ weapons: [weapon] }));
  const skin = calculateOfflineClearInfo(input({ weapons: [weapon], modifiers: { skinDamage: 150 } }));
  const crit = calculateOfflineClearInfo(input({ weapons: [weapon], modifiers: { fishCriticalChance: 100, fishCriticalDamage: 25 } }));
  assert.equal(base.combatTime, 60); assert.equal(skin.combatTime, 30); assert.equal(crit.combatTime, 30);
  const buff = calculateOfflineClearInfo(input({ weapons: [weapon], modifiers: { buffPack: true } }));
  assert.equal(buff.combatTime, 7.5);
  const truncated = calculateOfflineClearInfo(input({ weapons: [{ ...strong, damage: '3e0' }],
    modifiers: { rebirthDamage: I.fromInt(150), skinDamage: 200 } }));
  assert.equal(truncated.regularKillRate, 1 / 37, 'floor(3*1.5)=4 before skin x2 gives 8 damage, not 9');
  const empty = runOfflineProgress(input({ weapons: [null, null] }));
  assert.equal(empty.moneyAccumFinal.toString(), '0'); assert.equal(empty.stagesCleared, 0);
});

test('sync, multiple frame budgets, and async yielding preserve every result digit and do not mutate caller snapshots', async () => {
  const source = input({ gold: I.fromInt(9999), weapons: [getWeapon(0), null, getWeapon(8)], elapsedSeconds: 28800,
    absentSeconds: 99999, stageValueMax: 23, modifiers: { skinDamage: 115, skinSpeed: 110, skinMoney: 120,
      fishDamage: 25, fishCriticalChance: 17, fishCriticalDamage: 31, petMoney: I.fromDouble(173.9), petSpeed: 170 } });
  const before = json(source), expected = json(runOfflineProgress(source));
  let ticks = 0, yields = 0;
  const actual = await runOfflineProgressAsync(source, { frameBudgetMs: 3, now: () => ticks++, yieldFrame: async () => { yields++; } });
  assert.ok(yields > 1); assert.deepEqual(json(actual), expected); assert.deepEqual(json(source), before);
  const engine = new OfflineProgressEngine(source); let result;
  while (!(result = engine.step(7, () => ticks++))) {}
  assert.deepEqual(json(result), expected);
  result.levels[0] = -1;
  assert.deepEqual(json(engine.step(1)), expected, 'a caller cannot mutate the completed result retained by the engine');
});

test('30000 iterations bound excessive elapsed inputs while reported duration and history remain original', () => {
  const engine = new OfflineProgressEngine(input({ elapsedSeconds: 2e6, modifiers: { skinMoney: 0 } }));
  const result = engine.step(Infinity);
  assert.equal(engine.iterationCount, 30000); assert.ok(engine.remainingSeconds > 0);
  assert.equal(result.elapsedSeconds, 2e6); assert.equal(result.stageValueMax, 0); assert.equal(result.stagesCleared, 0);
});

test('configuration changes flow into offline duration and income without changing source combat values', () => {
  const changed = configured(c => { c.offline.maxOfflineSeconds = 3600; c.offline.minimumAbsentSeconds = 60;
    c.gold.firstStageBase = 40; c.gold.degreeMultipliers = [1, 2, 3, 100]; });
  const sim = changed('session/OfflineProgressSimulator'), Value = changed('core/OriginalInfVal').OriginalInfVal;
  assert.equal(sim.computeOfflineElapsed(0, 30000), null); assert.equal(sim.computeOfflineElapsed(0, 7200000).elapsedSeconds, 3600);
  const source = input({ gold: Value.fromInt(0), elapsedSeconds: 1, weapons: [{ ...strong, damage: '100e0' }] });
  assert.equal(sim.calculateOfflineClearInfo(source).combatTime, 90);
  const result = sim.runOfflineProgress(source);
  assert.ok(Math.abs(result.moneyAccumFinal.amount.toNumber() - 16) < 1e-12);
  const timing = configured(c => { c.offline.clearTimeScale = 2; c.offline.stageClearDelaySeconds = 7; });
  const timingSim = timing('session/OfflineProgressSimulator'), TimingValue = timing('core/OriginalInfVal').OriginalInfVal;
  const timingInput = input({ gold: TimingValue.fromInt(0), stageValueMax: 1, modifiers: { skinMoney: 0 } });
  assert.equal(timingSim.runOfflineProgress({ ...timingInput, elapsedSeconds: 66 }).stagesCleared, 0);
  assert.equal(timingSim.runOfflineProgress({ ...timingInput, elapsedSeconds: 67 }).stagesCleared, 1);
  for (const edit of [c => { c.offline.clearTimeScale = 0; }, c => { c.offline.maxOfflineSeconds = 29; },
    c => { c.offline.permanentBuffMultiplier = 1.5; }, c => { c.offline.stageClearDelaySeconds = -1; }]) {
    const bad = json(ECONOMY_CONFIG); edit(bad); assert.throws(() => validateEconomyConfig(bad), /Invalid economy configuration/);
  }
});

test('invalid arithmetic inputs fail before publishing a result', () => {
  for (const changes of [{ levels: [0, 0] }, { levels: [0, -1, 0] }, { elapsedSeconds: NaN },
    { gold: I.fromInt(-1) }, { stageIndex: -1 }, { waveIndex: 5 }]) {
    assert.throws(() => runOfflineProgress(input(changes)), /Invalid|Stage|Wave/);
  }
  assert.throws(() => new OfflineProgressEngine(input()).step(0), /frame budget/);
});
