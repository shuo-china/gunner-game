const test = require('node:test');
const assert = require('node:assert/strict');
const { CloudSaveStorage, validateCloudSave, CLOUD_SAVE_POLICY } = require('./.build/session/session/CloudSaveStorage.js');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const key = economyStorageKey('production');
const error = code => Object.assign(new Error(code), { code });
const next = () => new Promise(setImmediate);
function memory(missing = null) { const data = new Map(); return { data, getItem: k => data.has(k) ? data.get(k) : missing, setItem: (k, v) => data.set(k, v) }; }
const initialStorage = memory(); new BattleSession({ environment: 'production', storage: initialStorage });
const raw = (level = 0) => { const value = JSON.parse(initialStorage.getItem(key)); value.levels[0] = level; return JSON.stringify(value); };
function server() {
  const saves = new Map(), receipts = new Map(), calls = [];
  const api = { saves, receipts, calls, hook: null,
    seed(uid, save, revision = '1') { saves.set(uid, { player_id: uid, namespace: 'production', revision, save, saved_at_ms: 12345 }); },
    async saveRequest(method, uid, body) {
      calls.push({ method, uid, body });
      const current = saves.get(uid) ?? { player_id: uid, namespace: 'production', revision: '0', save: null, saved_at_ms: 0 };
      if (method === 'GET') return { ...current };
      let result = receipts.get(uid + body.request_id);
      if (!result) {
        if (body.base_revision !== current.revision) throw error('SAVE_CONFLICT');
        const revision = String(Number(current.revision) + 1);
        result = { player_id: uid, namespace: 'production', request_id: body.request_id, revision, current_revision: revision, saved_at_ms: 12345 };
        receipts.set(uid + body.request_id, result); api.seed(uid, body.save, revision);
      }
      result = { ...result, current_revision: saves.get(uid).revision };
      if (api.hook) return api.hook(result, body);
      return result;
    },
  }; return api;
}
let serial = 0;
function client(storage = memory(), api = server(), uid = '101', now = Date.now, scope = 'https://game.example/game/v1') {
  return new CloudSaveStorage(storage, api, uid, key, scope, 'production', now, () => 'request_test_' + String(++serial).padStart(8, '0'));
}
const open = c => c.open(async () => { throw new Error('Unexpected conflict'); });

test('mini-game empty missing keys allow a new account to save and reopen its exact snapshot', async () => {
  const storage = memory(''), api = server(), c = client(storage, api);
  await open(c);
  assert.equal(c.localSave, null); assert.equal(c.getItem(key + ':weapon-backup'), null);
  assert.deepEqual(api.calls.map(call => call.method), ['GET']);
  new BattleSession({ environment: 'production', storage: c });
  const saved = c.localSave; assert.ok(saved); await c.flush();
  assert.equal(c.dirty, false); assert.equal(api.saves.get('101').save, saved);
  c.dispose(); const reopened = client(storage, api); await open(reopened);
  assert.equal(reopened.localSave, saved); assert.equal(reopened.dirty, false);
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 1);
});

test('mini-game empty missing journal still loads an existing cloud save before unrelated legacy progress', async () => {
  const storage = memory(''), api = server(); storage.setItem(key, raw(8)); api.seed('101', raw(3));
  const c = client(storage, api); await open(c);
  assert.equal(c.localSave, raw(3)); assert.equal(c.dirty, false); assert.equal(storage.getItem(key), raw(8));
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(storage.data.has(key + ':cloud-owner'), false);
});

for (const old of [raw(4), '{', '{}']) test('new account ignores an obsolete unscoped local save: ' + old.slice(0, 12), async () => {
  const storage = memory(''), api = server(); storage.setItem(key, old); const c = client(storage, api);
  await open(c); assert.equal(c.localSave, null); assert.equal(c.dirty, false);
  assert.equal(storage.getItem(key), old); assert.equal(api.calls.filter(call => call.method === 'POST').length, 0);
  new BattleSession({ environment: 'production', storage: c }); await c.flush();
  assert.ok(c.localSave); assert.equal(JSON.parse(c.localSave).levels[0], 0);
  assert.equal(storage.getItem(key), old);
  const other = client(storage, api, '202'); await open(other); assert.equal(other.localSave, null);
});

for (const choice of ['cloud', 'local']) {
  test(`mini-game empty missing backup keys preserve both conflicting snapshots when choosing ${choice}`, async () => {
    const api = server(), storageA = memory(''), storageB = memory(''); api.seed('101', raw(1));
    const a = client(storageA, api), b = client(storageB, api); await open(a); await open(b);
    a.setItem(key, raw(2)); await a.flush(); b.setItem(key, raw(3));
    await assert.rejects(b.flush(), e => e.code === 'SAVE_CONFLICT');
    assert.equal(b.status, 'conflict'); await b.resolveConflict(choice);
    const backups = [...storageB.data].filter(([name]) => name.includes(':backup:')).map(([, value]) => value);
    assert.ok(backups.includes(raw(3)) && backups.includes(raw(2)));
    assert.equal(b.localSave, choice === 'cloud' ? raw(2) : raw(3));
    assert.equal(api.saves.get('101').save, b.localSave);
  });
}

for (const missing of [null, '']) {
  test(`mini-game missing=${JSON.stringify(missing)} never discards nonempty malformed journal or cloud data`, async () => {
    for (const source of ['journal', 'cloud']) {
      for (const bad of [' ', '{', '{}']) {
        const storage = memory(missing), api = server(), c = client(storage, api);
        if (source === 'journal') storage.setItem(c.journalKey, bad);
        else api.seed('101', bad);
        const before = [...storage.data]; let choices = 0;
        await assert.rejects(c.open(async () => { choices++; return 'cloud'; }), undefined, `${source}: ${JSON.stringify(bad)}`);
        assert.equal(choices, 0); assert.deepEqual([...storage.data], before);
        assert.equal(api.calls.filter(call => call.method === 'POST').length, 0);
        if (source === 'cloud') assert.equal(api.saves.get('101').save, bad);
      }
    }
  });
}

test('read cloud before creating BattleSession and preserve exact huge-number representation', async () => {
  const storage = memory(), api = server(), v = JSON.parse(raw(9)); v.money = { digits: '12345678901234567890123456789', exponent: 8001, precision: 29 };
  const saved = JSON.stringify(v); api.seed('101', saved); const c = client(storage, api); await open(c);
  assert.equal(c.getItem(key), saved); assert.equal(c.dirty, false);
  const session = new BattleSession({ environment: 'production', storage: c });
  assert.equal(session.snapshot({}).upgrades[0].level, 9);
  assert.deepEqual(JSON.parse(c.localSave).money, v.money);
  assert.equal(api.calls.filter(c => c.method === 'POST').length, 0);
});

test('new save and account-scoped auxiliary backups never touch a different account or endpoint', async () => {
  const storage = memory(), api = server(), a = client(storage, api), b = client(storage, api, '202'), other = client(storage, api, '101', Date.now, 'https://other.example');
  await open(a); await open(b); await open(other);
  a.setItem(key, raw(1)); a.setItem(key + ':weapon-backup', raw(2)); await a.flush();
  assert.equal(b.getItem(key), null); assert.equal(other.getItem(key), null); assert.equal(b.getItem(key + ':weapon-backup'), null);
  assert.equal(storage.getItem(key), null); assert.equal(api.saves.has('202'), false);
});

test('existing cloud save takes precedence over unowned legacy without replacing its backup', async () => {
  const storage = memory(), api = server(); storage.setItem(key, raw(8)); api.seed('101', raw(3)); const c = client(storage, api); await open(c);
  assert.equal(c.localSave, raw(3)); assert.equal(storage.getItem(key), raw(8));
});

test('invalid cloud or cache never falls back to a new account snapshot', async () => {
  for (const bad of ['{}', '{', JSON.stringify({ ...JSON.parse(raw()), weapons: {} })]) {
    const storage = memory(), api = server(); api.seed('101', bad); const c = client(storage, api);
    await assert.rejects(open(c)); assert.equal(storage.getItem(c.journalKey), null); assert.equal(api.calls.filter(c => c.method === 'POST').length, 0);
  }
  const storage = memory(), c = client(storage); storage.setItem(c.journalKey, '{}'); await assert.rejects(open(c));
  assert.equal(storage.getItem(c.journalKey), '{}'); assert.throws(() => validateCloudSave(raw().replace('"version":3', '"version":99')));
});

test('lost response survives process restart and retries the durable request ID exactly once', async () => {
  const storage = memory(), api = server(), c = client(storage, api); await open(c); c.setItem(key, raw(2));
  api.hook = () => { throw error('NETWORK_ERROR'); }; await assert.rejects(c.flush());
  assert.equal(c.status, 'offline'); assert.equal(c.dirty, true);
  const pending = JSON.parse(storage.getItem(c.journalKey)).pending; assert.equal(api.saves.get('101').revision, '1');
  c.dispose(); api.hook = null; const replacement = client(storage, api); await open(replacement);
  assert.equal(replacement.dirty, false); assert.equal(api.saves.get('101').revision, '1');
  assert.deepEqual(api.calls.filter(c => c.method === 'POST').map(c => c.body.request_id), [pending.request_id, pending.request_id]);
});

test('cold-start uploads preserve the server offline anchor while ordinary flushes advance online activity', async () => {
  const storage = memory(), api = server(); api.seed('101', raw(1));
  const c = client(storage, api); await open(c); c.setItem(key, raw(2));
  await c.flushResume();
  const resumed = api.calls.filter(call => call.method === 'POST').at(-1).body;
  assert.equal(resumed.resume, true);
  assert.equal(resumed.base_revision, '1'); assert.equal(resumed.save, raw(2));

  c.setItem(key, raw(3)); await c.flush();
  const online = api.calls.filter(call => call.method === 'POST').at(-1).body;
  assert.equal(Object.hasOwn(online, 'resume'), false, 'normal gameplay must refresh its server activity checkpoint');

  // The final online save never reached the server. After a long absence, its
  // exact durable intent must retry as a resume instead of erasing that absence.
  c.setItem(key, raw(4));
  const transport = api.saveRequest;
  api.saveRequest = async (method, uid, body) => {
    if (method === 'POST') { api.calls.push({ method, uid, body }); throw error('NETWORK_ERROR'); }
    return transport(method, uid, body);
  };
  await assert.rejects(c.flush());
  const pending = JSON.parse(storage.getItem(c.journalKey)).pending;
  assert.equal(Object.hasOwn(api.calls.at(-1).body, 'resume'), false);
  assert.equal(api.saves.get('101').save, raw(3));
  c.dispose(); api.saveRequest = transport;
  const reopened = client(storage, api); await open(reopened);
  const recovered = api.calls.filter(call => call.method === 'POST').at(-1).body;
  assert.equal(recovered.resume, true, 'open must preserve the old server checkpoint even for an originally ordinary save');
  for (const field of ['request_id', 'base_revision', 'save']) assert.equal(recovered[field], pending[field], field);
  assert.equal(reopened.dirty, false); assert.equal(reopened.localSave, raw(4));

  reopened.setItem(key, raw(5)); await reopened.flush();
  assert.equal(Object.hasOwn(api.calls.filter(call => call.method === 'POST').at(-1).body, 'resume'), false,
    'resume behavior must not leak into later online autosaves');
});

test('edits made during an upload remain dirty after acknowledging only the sent snapshot', async () => {
  const storage = memory(), api = server(), c = client(storage, api); await open(c); c.setItem(key, raw(1)); let finish;
  api.hook = receipt => new Promise(resolve => { finish = () => resolve(receipt); });
  const saving = c.flush(); assert.equal(c.flush(), saving); await next(); c.setItem(key, raw(2)); finish(); await saving;
  assert.equal(c.localSave, raw(2)); assert.equal(c.dirty, true); assert.equal(api.saves.get('101').save, raw(1));
  api.hook = null; await c.flush(); assert.equal(c.dirty, false); assert.equal(api.saves.get('101').save, raw(2));
});

test('two devices conflict instead of overwriting, and selecting cloud preserves both snapshots', async () => {
  const api = server(), storageA = memory(), storageB = memory(); api.seed('101', raw(1));
  const a = client(storageA, api), b = client(storageB, api); await open(a); await open(b);
  a.setItem(key, raw(2)); await a.flush(); b.setItem(key, raw(3)); await assert.rejects(b.flush(), e => e.code === 'SAVE_CONFLICT');
  assert.equal(b.status, 'conflict'); assert.equal(b.localSave, raw(3)); assert.equal(api.saves.get('101').save, raw(2));
  await b.resolveConflict('cloud'); assert.equal(b.localSave, raw(2));
  const backups = [...storageB.data].filter(([k]) => k.includes(':backup:')).map(([, v]) => v);
  assert.ok(backups.includes(raw(3)) && backups.includes(raw(2)));
  assert.throws(() => b.setItem(key, raw(8)), /重新进入/);
});

test('choosing local uses the displayed remote revision and detects another intervening write', async () => {
  const api = server(), c = client(memory(), api); api.seed('101', raw(1)); await open(c); c.setItem(key, raw(2)); api.seed('101', raw(3), '2');
  await assert.rejects(c.flush()); api.seed('101', raw(4), '3'); await assert.rejects(c.resolveConflict('local'), /又有更新/);
  assert.equal(api.saves.get('101').save, raw(4)); await c.resolveConflict('local');
  assert.equal(api.saves.get('101').save, raw(2)); assert.equal(api.saves.get('101').revision, '4');
});

test('changed server reward ledgers prevent a local conflict overwrite and still permit backed-up cloud recovery', async () => {
  for (const ledger of ['dailyCheck', 'redeemedCodes']) {
    let now = 0;
    const storage = memory(), api = server(); api.seed('101', raw(1));
    const c = client(storage, api, '101', () => now); await open(c); const local = raw(2); c.setItem(key, local);
    const rewarded = JSON.parse(raw(3));
    if (ledger === 'dailyCheck') rewarded.dailyCheck = { lastClaimDay: '2026-10-23', checkNum: 1, totalCheckNum: 1 };
    else rewarded.redeemedCodes = ['ALREADY_CLAIMED_SERVER_CODE'];
    rewarded.weapons.diamonds += 140;
    const remote = JSON.stringify(rewarded); api.seed('101', remote, '2');
    now = CLOUD_SAVE_POLICY.foregroundReadIntervalMs; await c.reconcile(); assert.equal(c.status, 'conflict');
    const journal = storage.getItem(c.journalKey), posts = api.calls.filter(call => call.method === 'POST').length;
    await assert.rejects(c.resolveConflict('local'), /本机奖励记录已过期/);
    assert.equal(api.calls.filter(call => call.method === 'POST').length, posts, `${ledger} must be checked before upload`);
    assert.equal(storage.getItem(c.journalKey), journal); assert.equal(c.status, 'conflict');
    assert.equal(c.conflict.local, local); assert.equal(c.conflict.cloud.save, remote);
    assert.equal(api.saves.get('101').save, remote);

    await c.resolveConflict('cloud');
    assert.equal(c.status, 'saved'); assert.equal(c.conflict, undefined); assert.equal(c.dirty, false);
    assert.equal(c.localSave, remote); assert.equal(api.saves.get('101').save, remote);
    assert.equal(api.calls.filter(call => call.method === 'POST').length, posts);
    const backups = [...storage.data].filter(([name]) => name.includes(':backup:')).map(([, value]) => value);
    assert.ok(backups.includes(local)); assert.ok(backups.includes(remote));
  }
});

test('a pending ordinary save rejected by the reward ledger opens a cloud choice on restart instead of retrying forever', async () => {
  const storage = memory(), api = server(), rewarded = JSON.parse(raw(1));
  rewarded.redeemedCodes = ['SERVER_SETTLED_CODE']; rewarded.weapons.diamonds += 2000;
  const remote = JSON.stringify(rewarded), stale = raw(2); api.seed('101', remote);
  const c = client(storage, api); await open(c); c.setItem(key, stale);
  const transport = api.saveRequest;
  api.saveRequest = async (method, uid, body) => {
    if (method === 'POST') { api.calls.push({ method, uid, body }); throw error('REWARD_STATE_CONFLICT'); }
    return transport(method, uid, body);
  };
  await assert.rejects(c.flush(), failure => failure.code === 'REWARD_STATE_CONFLICT');
  const pending = JSON.parse(storage.getItem(c.journalKey)).pending;
  assert.ok(pending); assert.equal(c.status, 'conflict'); c.dispose();

  const reopened = client(storage, api); let choices = 0;
  await reopened.open(async conflict => {
    choices++; assert.equal(conflict.local, stale); assert.equal(conflict.cloud.save, remote);
    assert.equal(conflict.cloud.revision, pending.base_revision, 'a ledger rejection can occur without a newer revision');
    return 'cloud';
  });
  assert.equal(choices, 1); assert.equal(reopened.status, 'saved'); assert.equal(reopened.dirty, false);
  assert.equal(reopened.localSave, remote); assert.equal(reopened.conflict, undefined);
  assert.equal(JSON.parse(storage.getItem(reopened.journalKey)).pending, undefined);
  const posts = api.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[0].body.request_id, pending.request_id);
  assert.equal(posts[1].body.request_id, pending.request_id); assert.equal(posts[1].body.resume, true);
  const backups = [...storage.data].filter(([name]) => name.includes(':backup:')).map(([, value]) => value);
  assert.ok(backups.includes(stale)); assert.ok(backups.includes(remote));
  reopened.tick(); await next();
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 2, 'resolved pending save must not retry again');
  assert.equal(api.saves.get('101').save, remote);
});

test('foreground checks another device even when the local journal is clean', async () => {
  let now = 0;
  const api = server(), c = client(memory(), api, '101', () => now); api.seed('101', raw(1)); await open(c);
  api.seed('101', raw(2), '2'); now = CLOUD_SAVE_POLICY.foregroundReadIntervalMs; await c.reconcile();
  assert.equal(c.status, 'conflict'); assert.equal(c.localSave, raw(1)); assert.equal(c.conflict.cloud.save, raw(2));
});

test('startup chooses between unacknowledged local progress and newer cloud progress', async () => {
  const storage = memory(), api = server(), c = client(storage, api); api.seed('101', raw(1)); await open(c); c.setItem(key, raw(2)); c.dispose(); api.seed('101', raw(3), '2');
  const reopened = client(storage, api); let asks = 0; await reopened.open(async () => { asks++; return 'local'; });
  assert.equal(asks, 1); assert.equal(reopened.localSave, raw(2)); assert.equal(api.saves.get('101').revision, '3');
});

test('a missing or regressed server record cannot silently erase a clean local cache', async () => {
  const storage=memory(),api=server(),c=client(storage,api);api.seed('101',raw(7),'4');await open(c);c.dispose();api.saves.delete('101');
  const reopened=client(storage,api);let asked=0;
  await reopened.open(async conflict=>{asked++;assert.equal(conflict.cloud.save,null);return 'local';});
  assert.equal(asked,1);assert.equal(api.saves.get('101').save,raw(7));assert.equal(reopened.localSave,raw(7));
});

test('routine changes wait sixty seconds while each local journal update remains immediately durable', async () => {
  let now = 0; const api = server(), storage = memory(), c = client(storage, api, '101', () => now); await open(c);
  c.setItem(key, raw(1), 'routine');
  for (let second = 1; second < 60; second++) {
    now = second * 1000; c.setItem(key, raw(second + 1), 'routine'); c.tick(); await next();
    assert.equal(JSON.parse(storage.getItem(c.journalKey)).local, raw(second + 1));
    assert.equal(api.receipts.size, 0);
  }
  now = 60000; c.tick(); await next(); assert.equal(api.receipts.size, 1);
  assert.equal(api.saves.get('101').save, raw(60));
  now = 61000; c.setItem(key, raw(61), 'routine');
  now = 120999; c.tick(); await next(); assert.equal(api.receipts.size, 1);
  now = 121000; c.tick(); await next(); assert.equal(api.receipts.size, 2);
});

test('critical changes debounce five seconds, cap batching at fifteen, and upload at most once per thirty seconds', async () => {
  let now = 0; const api = server(), c = client(memory(), api, '101', () => now); await open(c);
  c.setItem(key, raw(1), 'critical'); now = 4999; c.tick(); await next(); assert.equal(api.receipts.size, 0);
  now = 5000; c.tick(); await next(); assert.equal(api.receipts.size, 1);
  const uploadedAt = [5000]; api.hook = value => { uploadedAt.push(now); return value; };
  for (let second = 6; second <= 100; second++) {
    now = second * 1000; c.setItem(key, raw(second), 'critical'); c.tick(); await next();
  }
  assert.deepEqual(uploadedAt, [5000, 35000, 65000, 95000]);
  assert.equal(api.saves.get('101').save, raw(95)); assert.equal(c.localSave, raw(100));
  const freshApi = server(), fresh = client(memory(), freshApi, '101', () => now); await open(fresh);
  for (let second = 0; second < 15; second++) {
    now = 100000 + second * 1000; fresh.setItem(key, raw(second + 1), 'critical'); fresh.tick(); await next();
    assert.equal(freshApi.receipts.size, 0);
  }
  now = 115000; fresh.tick(); await next(); assert.equal(freshApi.receipts.size, 1);
});

test('ordinary tree rewards keep routine priority through the transaction boundary', () => {
  const storage = memory(), priorities = [];
  const original = storage.setItem; storage.setItem = (k, v, p) => { original(k, v); priorities.push(p); };
  const session = new BattleSession({ environment: 'production', storage }); priorities.length = 0;
  session.checkpointForeground(); assert.equal(priorities.at(-1), 'routine');
  session.mutationDepth++; session.save('routine'); session.finishMutation(); assert.equal(priorities.at(-1), 'routine');
  session.mutationDepth++; session.save('critical'); session.save('routine'); session.finishMutation(); assert.equal(priorities.at(-1), 'critical');
});

test('network failures back off and do not clear the durable pending snapshot', async () => {
  let now = 0; const api = server(), c = client(memory(), api, '101', () => now); await open(c); c.setItem(key, raw(2));
  api.hook = () => { throw error('NETWORK_ERROR'); }; await assert.rejects(c.flush()); const count = api.calls.length;
  now = 14999; c.tick(); await next(); assert.equal(api.calls.length, count);
  api.hook = null; now = 15000; c.tick(); await next(); assert.equal(c.dirty, false);
});

test('continued gameplay keeps the offline notice until server acknowledgement', async () => {
  const api=server(),c=client(memory(),api);await open(c);c.setItem(key,raw(1));api.hook=()=>{throw error('NETWORK_ERROR');};
  await assert.rejects(c.flush());c.setItem(key,raw(2),'routine');assert.equal(c.status,'offline');
  api.hook=null;await c.flush();assert.equal(c.dirty,true);await c.flush();assert.equal(c.status,'saved');
});

test('save outages stay quiet for two failures, then back off to five minutes without replacing the durable request', async () => {
  let now = 0; const api = server(), storage = memory(), c = client(storage, api, '101', () => now); await open(c); c.setItem(key, raw(1));
  api.hook = () => { throw error('NETWORK_ERROR'); };
  await assert.rejects(c.flush()); const request = JSON.parse(storage.getItem(c.journalKey)).pending.request_id;
  assert.equal(c.displayStatus, 'pending');
  for (const [at, attempt] of [[15000, 2], [45000, 3], [105000, 4], [225000, 5], [465000, 6], [765000, 7]]) {
    now = at - 1; c.tick(); await c.reconcile(); await next();
    assert.equal(api.calls.filter(call => call.method === 'POST').length, attempt - 1);
    assert.equal(api.calls.filter(call => call.method === 'GET').length, 1, 'foreground must respect a failing save backoff');
    now = at; c.tick(); await next();
    assert.equal(api.calls.filter(call => call.method === 'POST').length, attempt);
    assert.equal(c.displayStatus, attempt < 3 ? 'pending' : 'offline');
    assert.equal(JSON.parse(storage.getItem(c.journalKey)).pending.request_id, request);
  }
  api.hook = null; now = 1065000; c.tick(); await next();
  assert.equal(c.displayStatus, 'saved'); assert.equal(c.dirty, false);
  assert.equal(api.receipts.size, 1, 'response retries must never create duplicate revisions');
});

test('only a sync lasting three seconds shows activity and successful completion clears it', async () => {
  let now = 0; const api = server(), c = client(memory(), api, '101', () => now); await open(c); c.setItem(key, raw(1));
  let finish; api.hook = value => new Promise(resolve => { finish = () => resolve(value); });
  const sending = c.flush(); await next(); assert.equal(c.status, 'syncing'); assert.equal(c.displayStatus, 'pending');
  now = 2999; assert.equal(c.displayStatus, 'pending');
  now = 3000; assert.equal(c.displayStatus, 'syncing');
  finish(); await sending; assert.equal(c.displayStatus, 'saved');
});

test('invalid and used redemption codes, denied daily claims and full wallets are never save outage failures', async () => {
  for (const code of ['REDEEM_INVALID', 'REDEEM_ALREADY_USED', 'REWARD_INVALID', 'DAILY_NOT_CLAIMABLE', 'REWARD_WALLET_LIMIT']) {
    let now = 0; const api = server(), c = client(memory(), api, '101', () => now); api.seed('101', raw(1)); await open(c);
    api.rewardRequest = async () => { throw Object.assign(error(code), { status: 422 }); };
    for (let i = 0; i < 5; i++) {
      const attempt = c.claimReward('redeem', { code: 'WRONG' });
      assert.equal(c.displayStatus, 'pending');
      await assert.rejects(attempt, failure => failure.code === code);
      assert.equal(c.status, 'saved'); assert.equal(c.displayStatus, 'saved');
      assert.equal(c.rewardPending, false); assert.equal(c.errorMessage, ''); now += 1000;
    }
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 0);
    c.setItem(key, raw(2)); api.hook = () => { throw error('NETWORK_ERROR'); };
    await assert.rejects(c.flush()); assert.equal(c.displayStatus, 'pending', 'business rejections never count toward the outage threshold');
  }
});

test('background saves are best effort and repeated hide events cannot bypass thirty-second spacing or failure backoff', async () => {
  let now = 0; const api = server(), c = client(memory(), api, '101', () => now); await open(c);
  c.setItem(key, raw(1), 'routine'); await c.flushBackground(); assert.equal(api.receipts.size, 1);
  c.setItem(key, raw(2), 'routine');
  for (now = 1000; now < 30000; now += 1000) await c.flushBackground();
  assert.equal(api.receipts.size, 1); assert.equal(c.localSave, raw(2));
  await c.flushBackground(); assert.equal(api.receipts.size, 2);
  now = 60000; c.setItem(key, raw(3)); api.hook = () => { throw error('NETWORK_ERROR'); };
  await assert.rejects(c.flushBackground()); const count = api.calls.length;
  now = 75000; await c.flushBackground(); assert.equal(api.calls.length, count);
  now = 90000; await assert.rejects(c.flushBackground());
  now = 120000; await assert.rejects(c.flushBackground()); const afterThird = api.calls.length;
  now = 150000; await c.flushBackground(); assert.equal(api.calls.length, afterThird, 'sixty-second retry backoff wins over background interval');
  api.hook = null; now = 180000; await c.flushBackground(); assert.equal(c.dirty, false);
});

test('foreground reads are cached for five minutes, concurrent resumes coalesce, and a read does not force an upload', async () => {
  let now = 0; const api = server(), c = client(memory(), api, '101', () => now); api.seed('101', raw(1)); await open(c);
  for (now = 10000; now < 300000; now += 10000) await c.reconcile();
  assert.equal(api.calls.length, 1);
  c.setItem(key, raw(2), 'routine');
  await Promise.all(Array.from({ length: 20 }, () => c.reconcile()));
  assert.deepEqual(api.calls.map(call => call.method), ['GET', 'GET']); assert.equal(c.dirty, true);
  now = 359999; c.tick(); await next(); assert.equal(api.calls.length, 2);
  now = 360000; c.tick(); await next(); assert.equal(api.calls.at(-1).method, 'POST');
  now = 600000; await c.reconcile(); assert.equal(api.calls.filter(call => call.method === 'GET').length, 3);
});

test('failed foreground reads respect exponential backoff and a successful read resets the five-minute cache', async () => {
  let now = 0; const api = server(), c = client(memory(), api, '101', () => now); api.seed('101', raw(1)); await open(c);
  const send = api.saveRequest; let failReads = true;
  api.saveRequest = async (...args) => { const result = await send(...args); if (args[0] === 'GET' && failReads) throw error('NETWORK_ERROR'); return result; };
  now = 300000; await assert.rejects(c.reconcile()); const count = api.calls.length;
  now = 314999; await c.reconcile(); assert.equal(api.calls.length, count);
  now = 315000; await assert.rejects(c.reconcile());
  now = 344999; await c.reconcile(); assert.equal(api.calls.length, count + 1);
  failReads = false; now = 345000; await c.reconcile(); assert.equal(c.displayStatus, 'saved');
  now = 644999; await c.reconcile(); assert.equal(api.calls.length, count + 2);
  now = 645000; await c.reconcile(); assert.equal(api.calls.length, count + 3);
});

test('storage failure and invalid acknowledgements cannot report synced or discard pending writes', async () => {
  const storage = memory(), api = server(), c = client(storage, api); await open(c); c.setItem(key, raw(2));
  api.hook = result => ({ ...result, revision: '999' }); await assert.rejects(c.flush()); assert.equal(c.dirty, true);
  assert.ok(JSON.parse(storage.getItem(c.journalKey)).pending); api.hook = null; await c.flush();
  storage.setItem = () => { throw new Error('quota'); }; assert.throws(() => c.setItem(key, raw(3)));
  assert.equal(c.status, 'blocked'); assert.equal(c.localSave, raw(2));
});

test('late network completion after disposal cannot mutate the account journal', async () => {
  const storage = memory(), api = server(), c = client(storage, api); await open(c); c.setItem(key, raw(1)); let finish;
  api.hook = r => new Promise(resolve => { finish = () => resolve(r); }); const pending = c.flush(); await next();
  const before = storage.getItem(c.journalKey); c.dispose(); finish(); await assert.rejects(pending);
  assert.equal(storage.getItem(c.journalKey), before);
});

test('failure to persist an acknowledgement blocks play and retries the original committed request after restart', async () => {
  const storage=memory(),api=server(),c=client(storage,api);await open(c);c.setItem(key,raw(5));
  const write=storage.setItem;storage.setItem=(k,v)=>{if(k===c.journalKey&&JSON.parse(v).revision==='1')throw Error('quota');write(k,v);};
  await assert.rejects(c.flush());assert.equal(c.status,'blocked');assert.equal(c.dirty,true);assert.equal(api.saves.get('101').revision,'1');
  storage.setItem=write;c.dispose();const reopened=client(storage,api);await open(reopened);
  assert.equal(reopened.dirty,false);assert.equal(reopened.localSave,raw(5));assert.equal(api.saves.get('101').revision,'1');
});
