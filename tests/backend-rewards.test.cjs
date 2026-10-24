const test = require('node:test');
const assert = require('node:assert/strict');
const { CloudSaveStorage } = require('./.build/session/session/CloudSaveStorage.js');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { GameLoginClient } = require('./.build/session/session/GameLogin.js');
const { DailyCheckSystem } = require('./.build/session/session/DailyCheckSystem.js');
const { DailyShareSystem } = require('./.build/session/session/DailyShareSystem.js');
const { ECONOMY_CONFIG } = require('./.build/session/core/EconomyConfig.js');
const { OriginalInfVal } = require('./.build/session/core/OriginalInfVal.js');

const key = economyStorageKey('production');
const next = () => new Promise(setImmediate);
const failure = (code, status = 0) => Object.assign(new Error(code), { code, status });
function memory() {
  const data = new Map();
  return { data, getItem: name => data.get(name) ?? null, setItem: (name, value) => data.set(name, value) };
}
const initial = memory(); new BattleSession({ environment: 'production', storage: initial });
function raw(level = 0, diamonds) {
  const save = JSON.parse(initial.getItem(key));
  save.levels[0] = level;
  if (diamonds !== undefined) save.weapons.diamonds = diamonds;
  return JSON.stringify(save);
}
function rewardStateFor(head) {
  const save = head.save === null ? null : JSON.parse(head.save);
  const daily = new DailyCheckSystem(), share = new DailyShareSystem();
  if (save) { daily.restore(save.dailyCheck); share.restore(save.dailyShare); }
  return { player_id: head.player_id, namespace: 'production', revision: head.revision, server_time_ms: 12345,
    next_daily_reset_ms: 12345 + 86400000, daily_check: daily.snapshot('2026-10-23'), daily_share: share.snapshot('2026-10-23') };
}
function server() {
  const saves = new Map(), receipts = new Map(), calls = [];
  const api = {
    saves, receipts, calls, rewardHook: null, beforeReward: null, awardDiamonds: 140, shareDiamonds: 80,
    seed(uid, save, revision = '1') {
      saves.set(uid, { player_id: uid, namespace: 'production', revision, save, saved_at_ms: 12345 });
    },
    async saveRequest(method, uid, body) {
      calls.push({ channel: 'save', method, uid, body });
      const current = saves.get(uid) ?? { player_id: uid, namespace: 'production', revision: '0', save: null, saved_at_ms: 0 };
      if (method === 'GET') return { ...current };
      if (body.base_revision !== current.revision) throw failure('SAVE_CONFLICT', 409);
      const revision = String(Number(current.revision) + 1);
      api.seed(uid, body.save, revision);
      return { player_id: uid, namespace: 'production', request_id: body.request_id, revision, current_revision: revision, saved_at_ms: 12345 };
    },
    async rewardRequest(kind, uid, body) {
      calls.push({ channel: 'reward', kind, uid, body });
      if (kind === 'state') return rewardStateFor(saves.get(uid) ?? { player_id: uid, revision: '0', save: null });
      if (api.beforeReward) await api.beforeReward(kind, uid, body);
      let receipt = receipts.get(uid + ':' + body.request_id);
      if (!receipt) {
        const current = saves.get(uid);
        if (current.revision !== body.base_revision) throw failure('SAVE_CONFLICT', 409);
        const save = JSON.parse(current.save), revision = String(Number(current.revision) + 1);
        const amount = kind === 'share' ? api.shareDiamonds : api.awardDiamonds;
        save.weapons.diamonds += amount;
        if (kind === 'share') save.dailyShare = { lastClaimDay: '2026-10-23' };
        if (kind === 'daily') save.dailyCheck = { lastClaimDay: '2026-10-23', checkNum: body.day_index + 1,
          totalCheckNum: (save.dailyCheck?.totalCheckNum ?? 0) + 1 };
        if (kind === 'redeem') save.redeemedCodes = [...(save.redeemedCodes ?? []), body.code];
        api.seed(uid, JSON.stringify(save), revision);
        receipt = { request_id: body.request_id, awarded_revision: revision, server_time_ms: 12345,
          reward: { kind, diamonds: amount, ...(kind === 'daily' ? { dayIndex: body.day_index } : {}), ...(kind === 'redeem' ? { code: body.code } : {}) } };
        if (kind === 'share') {
          const share = new DailyShareSystem(); share.restore(save.dailyShare);
          receipt.daily_share = { ...share.snapshot('2026-10-23'), diamonds: amount };
        }
        if (kind === 'daily') {
          const daily = new DailyCheckSystem(); daily.restore(save.dailyCheck);
          receipt.daily_check = daily.snapshot('2026-10-23');
        }
        receipts.set(uid + ':' + body.request_id, receipt);
      }
      const value = { ...receipt, ...saves.get(uid), ...rewardStateFor(saves.get(uid)) };
      return api.rewardHook ? api.rewardHook(value, body) : value;
    },
  };
  return api;
}
let serial = 0;
function client(storage, api, uid = '101', scope = 'https://game.example/game/v1') {
  return new CloudSaveStorage(storage, api, uid, key, scope, 'production', () => 12345,
    () => 'reward_request_' + String(++serial).padStart(8, '0'));
}
const open = value => value.open(async () => { throw new Error('Unexpected conflict'); });
const rewardCalls = api => api.calls.filter(call => call.channel === 'reward' && call.kind !== 'state');

function withStartupState(receipt) {
  return { ...receipt, next_daily_reset_ms: receipt.server_time_ms + 86400000,
    daily_check: new DailyCheckSystem().snapshot('2026-10-23'),
    daily_share: new DailyShareSystem().snapshot('2026-10-23') };
}

test('startup reuses the committed offline response once, saving a serial state round trip without caching later refreshes', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); let now = 1000; c.now = () => now;
  await open(c);
  api.beforeReward = () => { now += 400; };
  api.rewardHook = withStartupState;
  const receipt = await c.claimReward('offline'), journal = storage.getItem(c.journalKey);
  const state = await c.rewardState(receipt);
  assert.deepEqual(api.calls.map(call => call.channel === 'save' ? call.method : call.kind), ['GET', 'offline']);
  assert.equal(state.revision, c.currentRevision); assert.equal(state.responseAgeMs, 400);
  assert.deepEqual(state.daily_check, receipt.daily_check); assert.deepEqual(state.daily_share, receipt.daily_share);
  assert.equal(storage.getItem(c.journalKey), journal); assert.equal(c.localSave, receipt.save);
  await c.rewardState(receipt); await c.rewardState();
  assert.equal(api.calls.filter(call => call.kind === 'state').length, 2, 'the startup hint is single-use; ordinary reads stay fresh');
  assert.equal(rewardCalls(api).length, 1, 'state reuse cannot award again');
});

for (const [name, change] of [
  ['old backend', receipt => { delete receipt.daily_share; }],
  ['missing daily state', receipt => { delete receipt.daily_check; }],
  ['partial daily state', receipt => { receipt.daily_check = { today: '2026-10-23' }; }],
  ['invalid day amounts', receipt => { receipt.daily_check.days[0].diamonds = -1; }],
  ['different daily dates', receipt => { receipt.daily_check.today = '2026-10-22'; }],
  ['missing reset', receipt => { delete receipt.next_daily_reset_ms; }],
  ['nonfinite reset', receipt => { receipt.next_daily_reset_ms = Infinity; }],
]) {
  test(`startup rejects incomplete current-protocol receipt: ${name}`, async () => {
    const storage = memory(), api = server(); api.seed('101', raw(1, 40)); const c = client(storage, api); await open(c);
    api.rewardHook = receipt => { receipt = withStartupState(receipt); change(receipt); return receipt; };
    const before = c.localSave;
    await assert.rejects(c.claimReward('offline'), /奖励回执状态无效/);
    assert.equal(c.localSave, before); assert.equal(c.rewardPending, true);
    assert.equal(api.calls.filter(call => call.kind === 'state').length, 0); assert.equal(rewardCalls(api).length, 1);
  });
}

test('startup receipt freshness uses elapsed request time, includes transit across midnight and rejects delayed or reversed clocks', async () => {
  for (const [transit, delay, resetRemaining, reused] of [[400, 0, 1000, true], [400, 0, 400, false],
    [400, 601, 1000, false], [0, 1001, 86400000, false], [0, -1, 86400000, false]]) {
    const storage = memory(), api = server(); api.seed('101', raw(1, 40)); const c = client(storage, api);
    let now = 999999999999; c.now = () => now; await open(c);
    api.beforeReward = () => { now += transit; };
    api.rewardHook = receipt => ({ ...withStartupState(receipt), next_daily_reset_ms: receipt.server_time_ms + resetRemaining });
    const receipt = await c.claimReward('offline'); now += delay;
    const state = await c.rewardState(receipt);
    assert.equal(api.calls.filter(call => call.kind === 'state').length, reused ? 0 : 1, JSON.stringify([transit, delay, resetRemaining]));
    if (reused) assert.equal(state.responseAgeMs, transit + delay);
  }
});

test('receipt reuse rejects copied, other-account, changed-progress and disposed inputs; no receipt always fetches state', async () => {
  for (const scenario of ['copied', 'otherAccount', 'changedProgress', 'ordinary', 'disposed']) {
    const storage = memory(), api = server(); api.seed('101', raw(1, 40)); const c = client(storage, api); await open(c);
    api.rewardHook = withStartupState;
    let receipt = await c.claimReward('offline');
    if (scenario === 'copied') receipt = { ...receipt };
    if (scenario === 'otherAccount') {
      api.seed('202', raw(1, 40)); const other = client(memory(), api, '202'); await open(other);
      receipt = await other.claimReward('offline');
    }
    if (scenario === 'changedProgress') c.setItem(key, raw(2, 44));
    if (scenario === 'ordinary') receipt = undefined;
    if (scenario === 'disposed') {
      c.dispose(); await assert.rejects(c.rewardState(receipt), /存档同步已结束/);
      assert.equal(api.calls.filter(call => call.kind === 'state').length, 0);
    } else {
      await c.rewardState(receipt); assert.equal(api.calls.filter(call => call.kind === 'state').length, 1, scenario);
    }
  }
});

test('lost offline receipts recover once; a fresh claim supplies startup state and failed fallback cannot reuse an old hint', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40)); const c = client(storage, api); await open(c);
  api.rewardHook = () => { throw failure('NETWORK_ERROR'); };
  await assert.rejects(c.claimReward('offline'));
  const pending = JSON.parse(storage.getItem(c.journalKey)).reward.request_id;
  c.dispose(); api.rewardHook = withStartupState;
  const restored = client(storage, api); await open(restored);
  assert.equal(restored.lastReward.request_id, pending); assert.equal(api.receipts.size, 1);
  const receipt = await restored.claimReward('offline'); await restored.rewardState(receipt);
  assert.equal(api.receipts.size, 2); assert.equal(api.calls.filter(call => call.kind === 'state').length, 0);
  const request = api.rewardRequest.bind(api); let failed = false;
  api.rewardRequest = async (...args) => {
    if (args[0] === 'state' && !failed) { failed = true; throw failure('NETWORK_ERROR'); }
    return request(...args);
  };
  await assert.rejects(restored.rewardState(receipt));
  await restored.rewardState(receipt);
  assert.equal(api.calls.filter(call => call.kind === 'state').length, 1);
  assert.equal(api.receipts.size, 2);
});

test('reward request flushes local progress first and journals the exact account, base revision and request ID before sending', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); assert.equal(c.currentRevision, undefined);
  await open(c); assert.equal(c.currentRevision, '1'); c.setItem(key, raw(2, 55));
  api.beforeReward = (kind, uid, body) => {
    const journal = JSON.parse(storage.getItem(c.journalKey));
    assert.equal(uid, '101'); assert.equal(kind, 'daily'); assert.equal(body.day_index, 0);
    assert.equal(body.base_revision, '2'); assert.equal(journal.revision, '2');
    assert.equal(journal.pending, undefined); assert.equal(journal.local, journal.confirmed);
    assert.deepEqual(journal.reward, { kind, ...body });
    assert.deepEqual(Object.keys(body).sort(), ['base_revision', 'day_index', 'request_id']);
  };
  const receipt = await c.claimReward('daily', { day_index: 0 });
  assert.equal(receipt.reward.dayIndex, 0); assert.equal(receipt.awarded_revision, '3');
  assert.equal(JSON.parse(receipt.save).weapons.diamonds, 195); assert.equal(JSON.parse(receipt.save).levels[0], 2);
  assert.equal(c.localSave, receipt.save); assert.equal(c.getItem(key), receipt.save);
  assert.equal(c.lastReward, receipt); assert.equal(c.rewardPending, false); assert.equal(c.status, 'saved');
  assert.equal(c.currentRevision, receipt.revision);
  assert.deepEqual(api.calls.map(call => call.channel === 'save' ? call.method : call.kind), ['GET', 'POST', 'daily']);
});

test('share claims require verified capability and use the server amount without accepting client award fields', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40)); api.shareDiamonds = 93;
  const c = client(storage, api); await open(c);
  const session = new BattleSession({ storage: c, rewardAuthority: 'server', now: () => Date.UTC(2099, 0, 1),
    rewardBackend: { claim: (kind, payload) => c.claimReward(kind, payload), requireReload: () => assert.fail('unexpected reload') } });
  assert.equal(session.getDailyShareState(), undefined);
  assert.equal(session.claimDailyShare().reason, 'unavailable'); assert.equal(rewardCalls(api).length, 0);
  const state = { ...new DailyShareSystem().snapshot('2026-10-23'), diamonds: 93 };
  session.setVerifiedDailyShare(state); state.canClaim = false;
  assert.equal(session.getDailyShareState().canClaim, true, 'verified state cannot be mutated through its caller');
  let finish; api.rewardHook = receipt => new Promise(resolve => { finish = () => resolve(receipt); });
  const claiming = session.claimDailyShare(); await next();
  assert.equal(c.rewardPendingKind, 'share'); assert.equal(session.backendRewardPending, true);
  assert.equal(session.weapons.diamonds, 40);
  assert.equal((await session.claimDailyShare()).ok, false);
  finish(); const result = await claiming;
  assert.equal(result.ok, true); assert.equal(result.diamonds, 93);
  assert.equal(session.weapons.diamonds, 133); assert.equal(session.getDailyShareState().canClaim, false);
  assert.equal(session.claimDailyShare().reason, 'notClaimable');
  assert.deepEqual(Object.keys(rewardCalls(api)[0].body).sort(), ['base_revision', 'request_id']);
  assert.equal(JSON.parse(c.localSave).dailyShare.lastClaimDay, '2026-10-23');
  assert.equal(c.rewardPendingKind, undefined);
  session.setVerifiedDailyShare(undefined); assert.equal(session.getDailyShareState(), undefined);
  const unavailable = new BattleSession({ storage: memory(), rewardAuthority: 'unavailable' });
  assert.equal(unavailable.claimDailyShare().reason, 'unavailable');
});

test('definitive share refusals stop automatic retry while uncertain transport retains its durable recovery request', async () => {
  for (const [code, status, reason] of [
    ['SHARE_NOT_CLAIMABLE', 409, 'notClaimable'], ['REWARD_WALLET_LIMIT', 422, 'walletLimit'],
    ['REWARD_STATE_INVALID', 409, 'invalidSave'], ['REWARD_INVALID', 422, 'unavailable'],
    ['SERVER_ERROR', 404, 'unavailable'], ['ACCOUNT_DISABLED', 403, 'unavailable'],
    ['ACCOUNT_CHANGED', 0, 'unavailable'], ['NETWORK_ERROR', 0, 'saveFailed'],
    ['TIMEOUT', 408, 'saveFailed'], ['TOO_MANY_REQUESTS', 429, 'saveFailed'], ['SERVER_ERROR', 503, 'saveFailed'],
  ]) {
    const storage = memory(), api = server(); api.seed('101', raw(1, 40));
    const c = client(storage, api); await open(c);
    const session = new BattleSession({ storage: c, rewardAuthority: 'server',
      rewardBackend: { claim: (kind, payload) => c.claimReward(kind, payload), requireReload: () => assert.fail('unexpected reload') } });
    session.setVerifiedDailyShare(new DailyShareSystem().snapshot('2026-10-23'));
    api.beforeReward = () => { throw failure(code, status); };
    const result = await session.claimDailyShare();
    assert.equal(result.ok, false, code); assert.equal(result.reason, reason, code);
    assert.equal(session.weapons.diamonds, 40, code); assert.equal(api.receipts.size, 0, code);
    if (status >= 400 && status < 500 && ![408, 429].includes(status)) assert.equal(c.rewardPending, false, code);
    if (reason === 'saveFailed') assert.equal(c.rewardPendingKind, 'share', code);
    if (code === 'SHARE_NOT_CLAIMABLE') {
      assert.equal(c.status, 'saved'); assert.equal(session.getDailyShareState().canClaim, false);
      const calls = rewardCalls(api).length;
      assert.equal(session.claimDailyShare().reason, 'notClaimable'); assert.equal(rewardCalls(api).length, calls);
      session.setVerifiedDailyShare(new DailyShareSystem().snapshot('2026-10-24'));
      assert.equal(session.getDailyShareState().canClaim, true);
      assert.equal(rewardCalls(api).length, calls, 'next day eligibility never itself sends another reward');
    }
  }
});

test('share receipt loss restores the same persistent request ID after restart without another platform share', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); await open(c);
  api.rewardHook = () => { throw failure('NETWORK_ERROR'); };
  await assert.rejects(c.claimReward('share', { day_index: 6, code: 'ignored' }));
  const pending = JSON.parse(storage.getItem(c.journalKey)).reward;
  assert.deepEqual(Object.keys(pending).sort(), ['base_revision', 'kind', 'request_id']);
  assert.equal(c.rewardPendingKind, 'share'); assert.equal(api.receipts.size, 1);
  c.dispose(); api.rewardHook = null;
  const recovered = client(storage, api); await open(recovered);
  assert.equal(recovered.rewardPending, false); assert.equal(JSON.parse(recovered.localSave).weapons.diamonds, 120);
  assert.deepEqual(rewardCalls(api).map(call => call.body.request_id), [pending.request_id, pending.request_id]);
  assert.equal(api.receipts.size, 1); assert.equal(recovered.lastReward.daily_share.canClaim, false);
});

test('missing or malformed share receipts retain their request and cannot mutate the live cached wallet', async () => {
  for (const corrupt of [receipt => { delete receipt.daily_share; return receipt; },
    receipt => ({ ...receipt, daily_share: { ...receipt.daily_share, diamonds: -1 } }),
    receipt => ({ ...receipt, daily_share: { ...receipt.daily_share, canClaim: true } }),
    receipt => ({ ...receipt, reward: { kind: 'share', diamonds: 1.5 } })]) {
    const storage = memory(), api = server(); api.seed('101', raw(1, 40));
    const c = client(storage, api); await open(c); api.rewardHook = corrupt;
    await assert.rejects(c.claimReward('share'));
    assert.equal(c.localSave, raw(1, 40)); assert.equal(c.rewardPendingKind, 'share');
  }
});

test('reward state requires the complete current protocol without accepting old missing fields', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40)); const c = client(storage, api); await open(c);
  const state = api.rewardRequest.bind(api);
  assert.ok((await c.rewardState()).daily_share);
  for (const field of ['daily_share', 'daily_check', 'next_daily_reset_ms', 'revision']) {
    api.rewardRequest = async (...args) => { const value = await state(...args); delete value[field]; return value; };
    await assert.rejects(c.rewardState(), /奖励状态响应无效/); assert.equal(c.localSave, raw(1, 40));
  }
});

test('reward verification freezes save writes and never sends another ordinary save while the receipt is pending', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); await open(c); let finish;
  api.rewardHook = receipt => new Promise(resolve => { finish = () => resolve(receipt); });
  const claiming = c.claimReward('redeem', { code: 'SERVERCODE' }); await next();
  const journal = storage.getItem(c.journalKey), saving = c.flush();
  assert.equal(c.rewardPending, true); assert.throws(() => c.setItem(key, raw(9, 999)), /奖励正在核验/);
  assert.equal(storage.getItem(c.journalKey), journal); assert.equal(c.localSave, raw(1, 40));
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 0);
  finish(); const receipt = await claiming; await saving;
  assert.equal(c.localSave, receipt.save); assert.equal(c.rewardPending, false);
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 0);
});

test('lost reward response survives restart, reuses its durable ID, and adopts the entire latest cloud head', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); await open(c);
  api.rewardHook = () => { throw failure('NETWORK_ERROR'); };
  await assert.rejects(c.claimReward('redeem', { code: 'ONCE' }), error => error.code === 'NETWORK_ERROR');
  const pending = JSON.parse(storage.getItem(c.journalKey)).reward;
  assert.equal(c.rewardPending, true); assert.equal(c.status, 'blocked'); assert.equal(c.localSave, raw(1, 40));
  assert.equal(api.saves.get('101').revision, '2'); assert.equal(api.receipts.size, 1);
  // A later device has advanced other fields since the original reward transaction.
  const latest = JSON.parse(raw(9, 700)); latest.money = { digits: '123456789012345678901', exponent: 900, precision: 21 };
  const latestRaw = JSON.stringify(latest); api.seed('101', latestRaw, '4');
  c.dispose(); api.rewardHook = null;
  const recovered = client(storage, api); await open(recovered);
  assert.deepEqual(rewardCalls(api).map(call => call.body.request_id), [pending.request_id, pending.request_id]);
  assert.equal(api.receipts.size, 1); assert.equal(api.saves.get('101').revision, '4');
  assert.equal(recovered.lastReward.awarded_revision, '2'); assert.equal(recovered.lastReward.revision, '4');
  assert.equal(recovered.localSave, latestRaw); assert.equal(recovered.rewardPending, false); assert.equal(recovered.dirty, false);
  assert.equal(JSON.parse(storage.getItem(recovered.journalKey)).revision, '4');
  assert.deepEqual(api.calls.slice(-2).map(call => call.channel === 'reward' ? call.kind : call.method), ['redeem', 'GET']);
});

test('network, timeout, rate-limit and server failures retain the original reward request and local state', async () => {
  for (const [code, status] of [['NETWORK_ERROR', 0], ['TIMEOUT', 408], ['TOO_MANY_REQUESTS', 429], ['SERVER_ERROR', 500]]) {
    const storage = memory(), api = server(); api.seed('101', raw(1, 40));
    const c = client(storage, api); await open(c);
    api.beforeReward = () => { throw failure(code, status); };
    await assert.rejects(c.claimReward('offline'), error => error.code === code);
    const journal = JSON.parse(storage.getItem(c.journalKey)), calls = api.calls.length;
    assert.equal(c.localSave, raw(1, 40)); assert.equal(c.rewardPending, true); assert.equal(c.status, 'blocked');
    assert.equal(journal.reward.request_id, rewardCalls(api)[0].body.request_id);
    c.tick(); await next(); assert.equal(api.calls.length, calls);
    assert.throws(() => c.setItem(key, raw(7, 500)), /奖励正在核验/);
    await assert.rejects(c.claimReward('daily', { day_index: 0 }));
    assert.equal(rewardCalls(api).length, 1); assert.equal(api.receipts.size, 0);
  }
});

test('a definite save conflict preserves both progress snapshots and does not credit a reward', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); await open(c); api.seed('101', raw(8, 90), '2');
  await assert.rejects(c.claimReward('daily', { day_index: 0 }), error => error.code === 'SAVE_CONFLICT');
  assert.equal(c.status, 'conflict'); assert.equal(c.localSave, raw(1, 40));
  assert.equal(c.conflict.local, raw(1, 40)); assert.equal(c.conflict.cloud.save, raw(8, 90));
  assert.equal(c.rewardPending, false); assert.equal(api.receipts.size, 0); assert.equal(api.saves.get('101').save, raw(8, 90));
  await assert.rejects(c.claimReward('redeem', { code: 'OTHER' })); assert.equal(rewardCalls(api).length, 1);
});

test('definite business rejection preserves the wallet, clears only the pending reward and permits another attempt', async () => {
  for (const code of ['DAILY_NOT_CLAIMABLE', 'SHARE_NOT_CLAIMABLE', 'REDEEM_ALREADY_USED', 'REDEEM_INVALID', 'REWARD_INVALID']) {
    const storage = memory(), api = server(); api.seed('101', raw(1, 40));
    const c = client(storage, api); await open(c);
    api.beforeReward = () => { throw failure(code, 409); };
    await assert.rejects(c.claimReward('redeem', { code: 'INVALID' }), error => error.code === code);
    assert.equal(c.rewardPending, false); assert.equal(c.localSave, raw(1, 40)); assert.equal(api.receipts.size, 0);
    assert.equal(c.status, 'saved', 'business refusal is not an offline outage');
    api.beforeReward = null; const receipt = await c.claimReward('redeem', { code: 'VALID' });
    assert.equal(c.localSave, receipt.save); assert.equal(api.receipts.size, 1);
    assert.notEqual(rewardCalls(api)[0].body.request_id, rewardCalls(api)[1].body.request_id);
  }
});

test('invalid or cross-account reward receipts cannot replace the cache and retain their request for recovery', async () => {
  const invalid = [value => ({ ...value, player_id: '202' }), value => ({ ...value, namespace: 'test' }),
    value => ({ ...value, request_id: 'another_request_000001' }), value => ({ ...value, awarded_revision: '8' }),
    value => ({ ...value, revision: '1' }), value => ({ ...value, save: '{}' }),
    value => ({ ...value, reward: { kind: 'offline' } })];
  for (const corrupt of invalid) {
    const storage = memory(), api = server(); api.seed('101', raw(1, 40));
    const c = client(storage, api); await open(c); api.rewardHook = corrupt;
    await assert.rejects(c.claimReward('daily', { day_index: 0 }));
    assert.equal(c.localSave, raw(1, 40)); assert.equal(c.lastReward, undefined);
    assert.equal(c.rewardPending, true); assert.equal(c.status, 'blocked');
    assert.equal(JSON.parse(storage.getItem(c.journalKey)).reward.request_id, rewardCalls(api)[0].body.request_id);
  }
});

test('pending rewards stay isolated by account and backend until the original owner reconnects', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40)); api.seed('202', raw(2, 70));
  const a = client(storage, api); await open(a); api.rewardHook = () => { throw failure('NETWORK_ERROR'); };
  await assert.rejects(a.claimReward('redeem', { code: 'PRIVATE' }));
  const journal = storage.getItem(a.journalKey); a.dispose(); api.rewardHook = null;
  const b = client(storage, api, '202'); await open(b); await b.claimReward('daily', { day_index: 0 });
  assert.equal(storage.getItem(a.journalKey), journal); assert.equal(b.lastReward.player_id, '202');
  const elsewhere = client(storage, api, '101', 'https://other.example/game/v1'); await open(elsewhere);
  assert.equal(elsewhere.rewardPending, false); assert.equal(rewardCalls(api).length, 2);
  const recovered = client(storage, api); await open(recovered);
  assert.deepEqual(rewardCalls(api).map(call => call.uid), ['101', '202', '101']);
  assert.equal(recovered.lastReward.reward.code, 'PRIVATE'); assert.equal(api.receipts.size, 2);
  assert.equal(JSON.parse(b.localSave).weapons.diamonds, 210);
});

test('failure to persist the pending reward prevents sending any award request', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); await open(c); const journal = storage.getItem(c.journalKey);
  storage.setItem = () => { throw new Error('storage full'); };
  await assert.rejects(c.claimReward('daily', { day_index: 0 }), error => error.code === 'LOCAL_STORAGE_ERROR');
  assert.equal(rewardCalls(api).length, 0); assert.equal(storage.getItem(c.journalKey), journal);
  assert.equal(c.localSave, raw(1, 40)); assert.equal(c.status, 'blocked');
});

test('reward state validates its owner, namespace and server clock without changing the saved wallet', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); await open(c); const journal = storage.getItem(c.journalKey);
  const state = await c.rewardState(); assert.equal(state.daily_check.today, '2026-10-23');
  assert.equal(storage.getItem(c.journalKey), journal); assert.equal(c.lastReward, undefined);
  for (const changed of [{ player_id: '202' }, { namespace: 'test' }, { server_time_ms: NaN }, { daily_check: null }]) {
    api.rewardRequest = async () => ({ ...state, ...changed });
    await assert.rejects(c.rewardState(), /奖励状态响应无效/);
    assert.equal(storage.getItem(c.journalKey), journal);
  }
});

test('server session accepts a backend-only code and publishes only the server-confirmed amount', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40)); api.awardDiamonds = 777;
  const c = client(storage, api); await open(c); const reloads = [];
  const session = new BattleSession({ environment: 'production', storage: c, rewardAuthority: 'server',
    rewardBackend: { claim: (kind, payload) => c.claimReward(kind, payload), requireReload: message => reloads.push(message) } });
  assert.equal(ECONOMY_CONFIG.redeemCodes.some(value => value.code === 'ONLY_ON_BACKEND'), false);
  let finish; api.rewardHook = receipt => new Promise(resolve => { finish = () => resolve(receipt); });
  const before = session.weapons.diamonds, claiming = session.redeemCode('  ONLY_ON_BACKEND  '); await next();
  assert.equal(session.weapons.diamonds, before); assert.equal(c.rewardPending, true);
  const duplicate = await session.claimDailyCheck(0);
  assert.equal(duplicate.ok, false); assert.equal(rewardCalls(api).length, 1);
  finish(); const result = await claiming;
  assert.equal(result.ok, true); assert.equal(result.diamonds, 777); assert.equal(session.weapons.diamonds, before + 777);
  assert.equal(rewardCalls(api)[0].body.code, 'ONLY_ON_BACKEND');
  assert.equal(JSON.parse(c.localSave).weapons.diamonds, before + 777);
  assert.ok(JSON.parse(c.localSave).redeemedCodes.includes('ONLY_ON_BACKEND'));
  assert.deepEqual(reloads, []); assert.equal(c.rewardPending, false);
});

test('empty and whitespace redemption input is rejected locally without requests, writes or reward state changes', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); await open(c);
  const session = new BattleSession({ environment: 'production', storage: c, rewardAuthority: 'server',
    rewardBackend: { claim: (kind, payload) => c.claimReward(kind, payload), requireReload: () => assert.fail('unexpected reload') } });
  const beforeCalls = api.calls.length, beforeJournal = storage.getItem(c.journalKey);
  const beforeDiamonds = session.weapons.diamonds, beforeStatus = c.status, beforeDirty = c.dirty;
  let writes = 0; const write = storage.setItem;
  storage.setItem = (name, value) => { writes++; return write(name, value); };
  for (const input of ['', '   ', '\t\r\n', ' \u3000\u00a0 ']) {
    const result = session.redeemCode(input);
    assert.equal(typeof result?.then, 'undefined', 'empty input should fail before entering the asynchronous server transaction');
    assert.deepEqual(result, { ok: false, reason: 'invalidCode' });
    assert.equal(session.backendRewardPending, false); assert.equal(c.rewardPending, false);
  }
  await next();
  assert.equal(api.calls.length, beforeCalls); assert.equal(writes, 0);
  assert.equal(storage.getItem(c.journalKey), beforeJournal); assert.equal(session.weapons.diamonds, beforeDiamonds);
  assert.equal(c.status, beforeStatus); assert.equal(c.dirty, beforeDirty);
});

test('server daily eligibility follows verified state despite client clock changes and installs the confirmed ledger', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); await open(c); let now = Date.UTC(2035, 0, 1);
  const session = new BattleSession({ environment: 'production', storage: c, now: () => now, rewardAuthority: 'server',
    rewardBackend: { claim: (kind, payload) => c.claimReward(kind, payload), requireReload: () => assert.fail('unexpected reload') } });
  assert.equal(session.getDailyCheckState().canClaim, false);
  const verified = new DailyCheckSystem().snapshot('2026-10-23'); session.setVerifiedDailyCheck(verified);
  now = Date.UTC(2099, 0, 1); assert.equal(session.getDailyCheckState(), verified);
  const before = session.weapons.diamonds, result = await session.claimDailyCheck(0);
  assert.equal(result.ok, true); assert.equal(session.weapons.diamonds, before + result.diamonds);
  assert.equal(session.getDailyCheckState().today, '2026-10-23'); assert.equal(session.getDailyCheckState().canClaim, false);
  assert.equal(session.getDailyCheckState().checkNum, 1); assert.equal(session.getDailyCheckState().lastClaimDay, '2026-10-23');
  now = Date.UTC(2100, 0, 1); assert.equal(session.getDailyCheckState().canClaim, false);
  assert.deepEqual(Object.keys(rewardCalls(api)[0].body).sort(), ['base_revision', 'day_index', 'request_id']);
});

test('server denial does not award locally and a subsequent confirmed request remains possible', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); await open(c); const reloads = [];
  const session = new BattleSession({ environment: 'production', storage: c, rewardAuthority: 'server',
    rewardBackend: { claim: (kind, payload) => c.claimReward(kind, payload), requireReload: message => reloads.push(message) } });
  const before = session.weapons.diamonds;
  api.beforeReward = () => { throw Object.assign(new Error('兑换码已被使用。'), { code: 'REDEEM_ALREADY_USED', status: 409 }); };
  const rejected = await session.redeemCode(ECONOMY_CONFIG.redeemCodes[0].code);
  assert.equal(rejected.ok, false); assert.equal(rejected.message, '兑换码已被使用。');
  assert.equal(session.weapons.diamonds, before); assert.equal(JSON.parse(c.localSave).weapons.diamonds, before);
  assert.equal(api.receipts.size, 0); assert.deepEqual(reloads, []);
  api.beforeReward = null; const accepted = await session.redeemCode('SERVER_ACCEPTED');
  assert.equal(accepted.ok, true); assert.equal(session.weapons.diamonds, before + accepted.diamonds);
});

test('a committed reward with a later head requires reload and never lets the stale live wallet overwrite that head', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1, 40));
  const c = client(storage, api); await open(c); const reloads = [];
  const session = new BattleSession({ environment: 'production', storage: c, rewardAuthority: 'server',
    rewardBackend: { claim: (kind, payload) => c.claimReward(kind, payload), requireReload: message => reloads.push(message) } });
  const before = session.weapons.diamonds, latest = raw(9, 900);
  api.rewardHook = receipt => {
    api.seed('101', latest, String(Number(receipt.revision) + 1));
    return { ...receipt, ...api.saves.get('101') };
  };
  const result = await session.redeemCode('COMMITTED');
  assert.equal(result.ok, false); assert.equal(reloads.length, 1); assert.match(reloads[0], /重新进入/);
  assert.equal(session.weapons.diamonds, before); assert.equal(c.localSave, latest); assert.equal(c.dirty, false);
  session.save(); session.checkpointForeground(); assert.equal(c.localSave, latest);
  assert.equal((await session.claimDailyCheck(0)).ok, false); assert.equal(rewardCalls(api).length, 1);
});

test('unavailable or unconfigured server authority never falls back to local rewards or offline simulation', async () => {
  for (const authority of ['unavailable', 'server']) {
    const storage = memory(), saved = JSON.parse(raw(1, 40));
    saved.offline = { lastSavedAtMs: Date.UTC(2026, 9, 22) }; storage.setItem(key, JSON.stringify(saved));
    const session = new BattleSession({ environment: 'production', storage, rewardAuthority: authority, now: () => Date.UTC(2026, 9, 23) });
    const before = session.weapons.diamonds, balance = session.moneyBalance.toString();
    assert.equal(session.offlineInitializationPending, false);
    assert.equal((await session.initializeOfflineProgress()).result, null);
    assert.equal(session.getDailyCheckState().canClaim, false);
    for (const result of [await session.claimDailyCheck(0), await session.redeemCode(ECONOMY_CONFIG.redeemCodes[0].code)]) {
      assert.equal(result.ok, false); assert.match(result.message, /登录/);
    }
    assert.equal(session.weapons.diamonds, before); assert.equal(session.moneyBalance.toString(), balance);
  }
});

test('explicit local authority preserves synchronous preview rewards and does not call a backend', () => {
  const storage = memory(), session = new BattleSession({ environment: 'production', storage, rewardAuthority: 'local',
    now: () => Date.UTC(2026, 9, 23), rewardBackend: { claim: () => assert.fail('local preview must not use server'),
      requireReload: () => assert.fail('local preview must not reload') } });
  const before = session.weapons.diamonds, daily = session.claimDailyCheck(0), redemption = session.redeemCode(ECONOMY_CONFIG.redeemCodes[0].code);
  assert.equal(daily.ok, true); assert.equal(typeof daily.then, 'undefined'); assert.equal(redemption.ok, true);
  assert.equal(session.weapons.diamonds, before + daily.diamonds + redemption.diamonds);
  assert.equal(session.claimDailyCheck(0).ok, false); assert.equal(session.redeemCode(ECONOMY_CONFIG.redeemCodes[0].code).ok, false);
});

test('verified offline result is presentation data for the already-settled cloud balance and never credits it again', async () => {
  const storage = memory(), saved = JSON.parse(raw(2, 40));
  saved.money = OriginalInfVal.fromInt(9999).toJSON(); storage.setItem(key, JSON.stringify(saved));
  const session = new BattleSession({ environment: 'production', storage, rewardAuthority: 'server' });
  const balance = session.moneyBalance.toString();
  const reward = { kind: 'offline', before: { stageIndex: 0, waveIndex: 0, levels: [0, 0, 0], gold: OriginalInfVal.fromInt(1000).toJSON() },
    result: { stageIndex: 0, waveIndex: 0, levels: [2, 0, 0], moneyFinal: OriginalInfVal.fromInt(9999).toJSON(),
      moneyGained: OriginalInfVal.fromInt(8999).toJSON(), moneyAccumFinal: OriginalInfVal.fromInt(10000).toJSON() } };
  session.setVerifiedOffline(reward); session.setVerifiedOffline(reward);
  assert.equal(session.offlineBefore.gold.toString(), '1000'); assert.equal(session.offlineResult.moneyGained.toString(), '8999');
  assert.equal(session.offlineResult.moneyFinal.toString(), '9999'); assert.equal(session.moneyBalance.toString(), balance);
  assert.equal(session.offlineInitializationPending, false); await session.initializeOfflineProgress();
  assert.equal(session.moneyBalance.toString(), balance); assert.deepEqual(JSON.parse(storage.getItem(key)).money, saved.money);
});

function loginFixture(handler) {
  const requests = []; let credentials = 0;
  const binding = {
    provider: { identityProvider: 'test_platform', appId: 'reward-test', endpoint: '/auth/test',
      acquireCredential: options => queueMicrotask(() => options.success({ code: 'fresh-' + (++credentials) })) },
    transport: { request: options => { requests.push(options); queueMicrotask(() => handler(options)); return { abort() {} }; } },
  };
  return { requests, credentials: () => credentials, client: new GameLoginClient(binding, { baseUrl: 'https://game.example/game/v1' }) };
}
const authenticated = (uid = '101', token = 'A') => ({ player: { id: uid, nickname: '玩家', provider: 'test_platform', app_id: 'reward-test' },
  is_new_player: false, token_info: { access_token: 'fg1_' + token.repeat(43), token_type: 'Bearer', expires_in: 86400, expires_at_ms: 9999999999999 }, server_time_ms: 12345 });

test('all reward routes use authenticated transport with GET state and POST claims', async () => {
  const f = loginFixture(request => request.success({ statusCode: 200,
    data: request.url.endsWith('/auth/test') ? authenticated() : { player_id: '101' } }));
  for (const kind of ['state', 'daily', 'redeem', 'offline', 'share']) {
    const body = kind === 'state' ? undefined : { request_id: 'reward_request_00000001', base_revision: '1' };
    await f.client.rewardRequest(kind, '101', body);
    const request = f.requests.at(-1);
    assert.equal(request.url, 'https://game.example/game/v1/rewards/' + kind);
    assert.equal(request.method, kind === 'state' ? 'GET' : 'POST'); assert.equal(request.data, body);
    assert.equal(request.header.Authorization, 'Bearer ' + authenticated().token_info.access_token);
  }
  assert.equal(f.credentials(), 1); f.client.dispose();
});

test('expired reward token renews once and retries the exact request with the new bearer token', async () => {
  let logins = 0, claims = 0;
  const f = loginFixture(request => {
    if (request.url.endsWith('/auth/test')) request.success({ statusCode: 200, data: authenticated('101', ++logins === 1 ? 'A' : 'B') });
    else request.success(++claims === 1 ? { statusCode: 401, data: { code: 'SESSION_INVALID' } } : { statusCode: 200, data: { player_id: '101' } });
  });
  const body = { request_id: 'reward_request_00000001', base_revision: '4', code: 'ONCE' };
  await f.client.rewardRequest('redeem', '101', body);
  const requests = f.requests.filter(request => request.url.endsWith('/rewards/redeem'));
  assert.equal(f.credentials(), 2); assert.equal(requests.length, 2);
  assert.equal(requests[0].data, body); assert.equal(requests[1].data, body);
  assert.equal(requests[0].header.Authorization, 'Bearer ' + authenticated('101', 'A').token_info.access_token);
  assert.equal(requests[1].header.Authorization, 'Bearer ' + authenticated('101', 'B').token_info.access_token);
  f.client.dispose();
});

test('reward retry refuses an account switch and never sends the old owner claim under the new account', async () => {
  let logins = 0, claims = 0;
  const f = loginFixture(request => {
    if (request.url.endsWith('/auth/test')) request.success({ statusCode: 200, data: authenticated(++logins === 1 ? '101' : '202') });
    else { claims++; request.success({ statusCode: 401, data: { code: 'SESSION_INVALID' } }); }
  });
  await assert.rejects(f.client.rewardRequest('offline', '101', { request_id: 'reward_request_00000001', base_revision: '1' }),
    error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(claims, 1); assert.equal(f.client.player.id, '202'); f.client.dispose();
});

test('reward transport rejects a wrong response owner and preserves safe Chinese business errors', async () => {
  for (const response of [{ statusCode: 200, data: { player_id: '202' } },
    { statusCode: 409, data: { code: 'REDEEM_ALREADY_USED', message: 'untrusted server detail' } }]) {
    const f = loginFixture(request => request.success(request.url.endsWith('/auth/test') ? { statusCode: 200, data: authenticated() } : response));
    await assert.rejects(f.client.rewardRequest('redeem', '101', {}), error => {
      assert.equal(error.code, response.statusCode === 200 ? 'ACCOUNT_CHANGED' : 'REDEEM_ALREADY_USED');
      assert.equal(error.message.includes('untrusted'), false);
      if (response.statusCode === 409) assert.equal(error.message, '兑换码已被使用。');
      return true;
    });
    f.client.dispose();
  }
});
