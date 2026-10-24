const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { projectRoot } = require('./support/paths.cjs');
const build = path.join(__dirname, '.build/session');
const { BattleSession, economyStorageKey } = require(path.join(build, 'session/BattleSession.js'));
const { OriginalInfVal } = require(path.join(build, 'core/OriginalInfVal.js'));
const { ECONOMY_CONFIG } = require(path.join(build, 'core/EconomyConfig.js'));
const { RELIC_CATALOG } = require(path.join(build, 'session/RelicSystem.js'));
const backend = path.resolve(projectRoot, '../PHP');
const worker = path.join(backend, 'bin/reward-worker.cjs');
const { settleOffline } = require(worker);
const NOW = Date.UTC(2026, 9, 23, 4);
const key = economyStorageKey('production');
const json = value => JSON.parse(JSON.stringify(value));
function storage(raw = null) {
  const data = new Map(raw === null ? [] : [[key, raw]]);
  return { getItem: k => data.get(k) ?? null, setItem: (k, value) => data.set(k, value) };
}
function fixture(rich = false) {
  const saved = storage();
  new BattleSession({ storage: saved, now: () => NOW });
  const save = JSON.parse(saved.getItem(key));
  save.money = OriginalInfVal.fromInt(1000).toJSON();
  save.levels = [0, 0, 0]; save.progress = { stageIndex: 0, waveIndex: 0 };
  save.weapons.stageValueMax = 72; save.offline = { lastSavedAtMs: NOW };
  save.customFutureField = { label: '保留尚未识别的数据', precision: '000100' };
  save.dailyShare = { lastClaimDay: '2026-10-23' };
  if (rich) {
    save.levels = [20, 12, 8]; save.progress = { stageIndex: 2, waveIndex: 1 };
    save.weapons.equipment = [1, 3, 8].map(weaponId => ({ weaponId, locked: false, pendingAd: false }));
    for (const item of save.weapons.equipment) save.weapons.collection[item.weaponId] = true;
    save.rebirth.levels = [14, 8, 19];
    save.skins.owned.fill(true);
    save.pets.selected = [0, 3, 6]; save.fish.inventory = [0, 5, 9];
    save.relics.items.forEach((item, index) => {
      item.unlocked = true; item.level = RELIC_CATALOG[index].type <= 8 ? 13 : 2;
    });
  }
  return save;
}
async function clientResult(save, elapsedSeconds) {
  const saved = storage(JSON.stringify(save));
  const session = new BattleSession({ storage: saved, now: () => NOW + elapsedSeconds * 1000 });
  const initialized = await session.initializeOfflineProgress();
  assert.equal(initialized.ok, true);
  return { result: json(initialized.result), save: JSON.parse(saved.getItem(key)) };
}

test('reward backend exports match the single economy source and have explicit code modes', () => {
  const config = JSON.parse(fs.readFileSync(path.join(backend, 'config/rewards-economy.json'), 'utf8'));
  assert.deepEqual(config, { schemaVersion: 1, dailyCheck: json(ECONOMY_CONFIG.dailyCheck), dailyShare: json(ECONOMY_CONFIG.dailyShare),
    redeemCodes: ECONOMY_CONFIG.redeemCodes.map(({ code, diamonds, mode }) => ({ code, diamonds, mode })) });
  for (const reward of config.redeemCodes) assert.ok(['per_player', 'global_once'].includes(reward.mode));
  const checked = spawnSync(process.execPath, [path.join(projectRoot, 'tools/export-reward-backend.cjs'), '--check'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout || String(checked.error));
});

test('server offline settlement exactly matches existing upgrades, stage replay, modifiers and large-number arithmetic', async () => {
  for (const rich of [false, true]) {
    const save = fixture(rich), original = json(save), seconds = 600;
    const result = settleOffline({ save, last_saved_at_ms: NOW, now_ms: NOW + seconds * 1000 });
    const expected = await clientResult(save, seconds);
    assert.deepEqual(result.reward.result, expected.result);
    for (const field of ['money', 'levels', 'progress']) assert.deepEqual(result.save[field], expected.save[field], field);
    assert.deepEqual(result.reward.before, { gold: save.money, levels: save.levels, ...save.progress });
    assert.equal(result.reward.kind, 'offline');
    assert.equal(result.save.offline.lastSavedAtMs, NOW + seconds * 1000);
    for (const field of Object.keys(save).filter(field => !['money', 'levels', 'progress', 'offline'].includes(field))) {
      assert.deepEqual(result.save[field], save[field], `unrelated block ${field} must survive`);
    }
    assert.deepEqual(save, original, 'worker must not mutate its caller input');
    assert.ok(result.reward.result.levelsGained.some(levels => levels > 0));
    assert.ok(result.reward.result.stageIndex * 10 + result.reward.result.waveIndex <= save.weapons.stageValueMax);
  }
});

test('only server timestamps determine absence, including no-retroactive first import and immediate repeat', () => {
  const save = fixture(), request = { save, last_saved_at_ms: NOW, now_ms: NOW + 60000 };
  const expected = settleOffline(request);
  for (const checkpoint of [0, NOW - 864000000, NOW + 864000000, 'forged', null]) {
    const forged = json(save); forged.offline.lastSavedAtMs = checkpoint;
    assert.deepEqual(settleOffline({ ...request, save: forged }), expected);
  }
  for (const last_saved_at_ms of [0, NOW + 60001]) {
    const result = settleOffline({ ...request, last_saved_at_ms });
    assert.equal(result.reward.result, null);
    assert.deepEqual(result.save.money, save.money);
    assert.equal(result.save.offline.lastSavedAtMs, Math.max(last_saved_at_ms, request.now_ms));
  }
  const again = settleOffline({ save: expected.save, last_saved_at_ms: request.now_ms, now_ms: request.now_ms });
  assert.equal(again.reward.result, null); assert.deepEqual(again.save, expected.save);
});

test('server applies the thirty-second threshold and eight-hour plus relic extension cap', () => {
  for (const [seconds, pending] of [[29.999, false], [30, true], [86400, true]]) {
    const output = settleOffline({ save: fixture(), last_saved_at_ms: NOW, now_ms: NOW + seconds * 1000 });
    assert.equal(output.reward.result !== null, pending);
    assert.equal(output.save.offline.lastSavedAtMs, NOW + seconds * 1000);
    if (pending) {
      assert.equal(output.reward.result.elapsedSeconds, Math.min(seconds, ECONOMY_CONFIG.offline.maxOfflineSeconds));
      assert.equal(output.reward.result.absentSeconds, seconds);
    }
  }
  const rich = fixture(true);
  const extra = rich.relics.items.reduce((sum, item, index) =>
    sum + (RELIC_CATALOG[index].type === 10 ? (item.level + 1) * ECONOMY_CONFIG.relics.offlineMinutesPerLevel * 60 : 0), 0);
  const output = settleOffline({ save: rich, last_saved_at_ms: NOW, now_ms: NOW + 86400000 });
  assert.equal(output.reward.result.elapsedSeconds, ECONOMY_CONFIG.offline.maxOfflineSeconds + extra);
  assert.equal(output.reward.result.isCapped, true);
});

test('worker rejects absent or invalid current wallet precision and modifier systems without mutating input', () => {
  for (const precision of [undefined, null, 0, -1, '3']) {
    const save = fixture(); save.money.precision = precision;
    const before = json(save);
    assert.throws(() => settleOffline({ save, last_saved_at_ms: NOW, now_ms: NOW + 60000 }));
    assert.deepEqual(json(save), before);
  }
  for (const field of ['rebirth', 'skins', 'pets', 'fish', 'relics']) for (const value of [undefined, null, { damaged: true }]) {
    const save = fixture(); save[field] = value;
    const before = json(save);
    assert.throws(() => settleOffline({ save, last_saved_at_ms: NOW, now_ms: NOW + 60000 }), field);
    assert.deepEqual(json(save), before);
  }
});

test('offline arithmetic leaves unrelated reward ledgers unchanged for the server to validate', () => {
  const save = fixture(); save.dailyShare = { damaged: true };
  const output = settleOffline({ save, last_saved_at_ms: NOW, now_ms: NOW + 60000 });
  assert.deepEqual(output.save.dailyShare, save.dailyShare);
});

test('worker rejects invalid core data, client reward overrides and malformed transport without returning a save', () => {
  const base = { save: fixture(), last_saved_at_ms: NOW, now_ms: NOW + 60000 };
  for (const change of [request => { request.elapsedSeconds = 86400; }, request => { request.now_ms = -1; },
    request => { request.last_saved_at_ms = '1'; }, request => { request.save.levels[0] = 10001; },
    request => { request.save.weapons.testTimeOffsetMs = 3600000; }, request => { request.save.money.digits = '-1'; },
    request => { request.save.progress.waveIndex = 5; }, request => { request.save.weapons.equipment[0].weaponId = -1; }]) {
    const request = json(base); change(request); assert.throws(() => settleOffline(request));
  }
  const run = input => spawnSync(process.execPath, [worker], { input, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 3 * 1024 * 1024 });
  const valid = run(JSON.stringify(base));
  assert.equal(valid.status, 0, valid.stderr); assert.deepEqual(JSON.parse(valid.stdout), settleOffline(base));
  const invalid = run('{"save":');
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.equal(invalid.stderr, 'Reward calculation failed.\n');
  const oversized = run(' '.repeat(2097152 + 4097));
  assert.equal(oversized.status, 1); assert.equal(oversized.stdout, ''); assert.equal(oversized.stderr, 'Reward calculation failed.\n');
});
