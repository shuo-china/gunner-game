const test = require('node:test');
const assert = require('node:assert/strict');
const { createGamePlatform } = require('./.build/session/platform/PlatformServices.js');
const { GameLoginClient } = require('./.build/session/session/GameLogin.js');
const { resolveGameBackendConfig } = require('./.build/session/session/GameBackendConfig.js');
const { CloudSaveStorage } = require('./.build/session/session/CloudSaveStorage.js');
const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');

const backend = resolveGameBackendConfig(undefined, 'production');
const appId = 'tapmcg8evaubisjmzc';
const reply = (id = '301', provider = 'taptap_mini', app = appId) => ({
  player: { id, nickname: '玩家', provider, app_id: app }, is_new_player: false,
  token_info: { access_token: 'fg1_' + 'T'.repeat(43), token_type: 'Bearer', expires_in: 3600, expires_at_ms: 9999999999999 }, server_time_ms: 1,
});

function fixture(handler = xhr => xhr.respond(200, reply()), login) {
  const requests = [], callbacks = [];
  const host = {
    getAccountInfoSync() { assert.equal(this, host); return { miniProgram: { appId } }; },
    login(options) {
      assert.equal(this, host); callbacks.push(options);
      if (login) login(options);
      else options.success({ code: 'fresh-code-' + callbacks.length, openid: 'untrusted', session_key: 'never-forward' });
    },
    request() { throw new Error('H5 must use browser HTTP, not tap.request'); },
  };
  class Request {
    constructor() { this.headers = {}; this.aborts = 0; this.status = 0; this.withCredentials = true; }
    open(method, url, async) { Object.assign(this, { method, url, async }); }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { this.body = body; requests.push(this); queueMicrotask(() => handler(this)); }
    respond(status, body) { this.status = status; this.responseText = typeof body === 'string' ? body : JSON.stringify(body); this.onload?.(); }
    abort() { this.aborts++; this.onabort?.(); }
  }
  const globals = { __FOREST_GUNNER_PLATFORM__: { channel: 'taptap-h5' }, window: { tap: host, XMLHttpRequest: Request },
    wx: { login() { throw new Error('must not use WeChat login'); } } };
  const platform = createGamePlatform(globals, {});
  return { globals, platform, host, callbacks, requests, client: (timeout = 15000, now = Date.now) => new GameLoginClient(platform.createLogin(), backend, now, timeout) };
}

test('TapTap H5 requires explicit channel selection and has no ad or share capability', async () => {
  const f = fixture();
  assert.equal(f.platform.channel, 'taptap-h5'); assert.equal(f.platform.requiresLogin, true);
  assert.equal(createGamePlatform({ tap: f.host }, {}).channel, 'web');
  for (const build of [{ wechat: true }, { douyin: true }, { native: true }]) {
    assert.throws(() => createGamePlatform(f.globals, build));
  }
  const outcomes = [];
  f.platform.createRewardedAds().show({ id: 'fixture', placement: 'weapon-daily' }, outcome => outcomes.push(outcome));
  assert.deepEqual(outcomes, ['failure']);
  const share = f.platform.createShare(); assert.equal(share.supported, false);
  assert.equal((await share.share()).status, 'unavailable'); share.destroy();
});

test('TapTap concurrent login preserves host receivers and sends only code through browser JSON HTTP', async () => {
  const f = fixture(), client = f.client();
  const [a, b] = await Promise.all([client.login(), client.login()]);
  assert.equal(a, b); assert.equal(f.callbacks.length, 1); assert.equal(f.requests.length, 1);
  assert.equal(client.player.provider, 'taptap_mini');
  const request = f.requests[0];
  assert.equal(request.url, backend.baseUrl + '/auth/taptap');
  assert.equal(request.method, 'POST'); assert.equal(request.async, true);
  assert.deepEqual(JSON.parse(request.body), { code: 'fresh-code-1' });
  assert.deepEqual(request.headers, { 'Content-Type': 'application/json', Accept: 'application/json' });
  assert.equal(request.timeout, 15000); assert.equal(request.withCredentials, false);
  assert.equal(f.callbacks[0].timeout, 15000);
  client.dispose(); assert.equal(request.aborts, 0, 'completed requests need no abort');
});

test('TapTap missing host fails visibly and the same login binding can retry after delayed injection', async () => {
  const f = fixture(), client = f.client(); delete f.globals.window.tap;
  await assert.rejects(client.login(), e => e.code === 'TAPTAP_SDK_UNAVAILABLE' && /TapTap 内/.test(e.message));
  assert.equal(client.player, undefined); assert.equal(f.requests.length, 0);
  f.globals.window.tap = f.host; await client.login();
  assert.equal(client.player.id, '301'); client.dispose();
});

test('TapTap H5 requires browser HTTP and can retry after XMLHttpRequest becomes available', async () => {
  const f = fixture(), client = f.client(), Request = f.globals.window.XMLHttpRequest;
  delete f.globals.window.XMLHttpRequest;
  await assert.rejects(client.login(), e => e.code === 'NETWORK_ERROR');
  assert.equal(f.requests.length, 0); assert.equal(client.player, undefined);
  f.globals.XMLHttpRequest = Request; await client.login();
  assert.equal(f.callbacks.length, 2, 'the failed code is not reused');
  assert.equal(client.player.id, '301'); client.dispose();
});

test('TapTap AppID mismatch never requests a code and optional account API failures remain retryable', async () => {
  const f = fixture(), client = f.client();
  f.host.getAccountInfoSync = () => ({ miniProgram: { appId: 'another-miniapp' } });
  await assert.rejects(client.login(), e => e.code === 'APP_ID_MISMATCH');
  assert.equal(f.callbacks.length, 0); assert.equal(f.requests.length, 0);
  f.host.getAccountInfoSync = () => { throw new Error('SDK not ready'); };
  await assert.rejects(client.login(), e => e.code === 'TAPTAP_LOGIN_FAILED');
  delete f.host.getAccountInfoSync; await client.login(); client.dispose();
});

test('TapTap validates real code strings and never forwards SDK error text or identity fields', async () => {
  for (const code of [undefined, null, true, 123, '', 'a b', 'a\nb', 'x'.repeat(257)]) {
    const f = fixture(undefined, o => o.success({ code, openid: 'fake' })), client = f.client();
    await assert.rejects(client.login(), e => e.code === 'TAPTAP_LOGIN_FAILED');
    assert.equal(f.requests.length, 0); client.dispose();
  }
  for (const [errMsg, expected] of [['login:fail cancel', 'LOGIN_CANCELLED'], ['login:fail timeout', 'TIMEOUT'], ['private-sdk-error', 'TAPTAP_LOGIN_FAILED']]) {
    const f = fixture(undefined, o => o.fail({ errMsg })), client = f.client();
    await assert.rejects(client.login(), e => e.code === expected && !e.message.includes(errMsg));
    assert.equal(f.requests.length, 0); client.dispose();
  }
  const unknown = fixture(undefined, o => o.fail({ errno: 999999 })), unknownClient = unknown.client();
  await assert.rejects(unknownClient.login(), e => e.code === 'TAPTAP_LOGIN_FAILED');
  assert.equal(unknown.requests.length, 0); unknownClient.dispose();
});

test('TapTap credential timeout, logout and disposal discard late SDK callbacks', async () => {
  const f = fixture(undefined, () => {}), client = f.client(10);
  await assert.rejects(client.login(), e => e.code === 'TIMEOUT');
  f.callbacks[0].success({ code: 'late-code' }); assert.equal(f.requests.length, 0);
  const first = client.login(), rejected = assert.rejects(first, e => e.code === 'DISPOSED');
  await client.logout(); await rejected;
  const next = client.login();
  f.callbacks[1].success({ code: 'old-code' }); f.callbacks[2].success({ code: 'new-code' });
  f.callbacks[2].success({ code: 'duplicate-code' }); f.callbacks[2].fail({ errMsg: 'late-error' });
  await next;
  assert.deepEqual(f.requests.map(r => JSON.parse(r.body)), [{ code: 'new-code' }]);
  const last = client.login(), disposed = assert.rejects(last, e => e.code === 'DISPOSED');
  client.dispose(); await disposed; f.callbacks[3].success({ code: 'destroyed-code' });
  assert.equal(f.requests.length, 1); assert.equal(client.player, undefined);
});

test('TapTap H5 cancels a pending browser request once and ignores saved late event handlers', async () => {
  let lateLoad;
  const f = fixture(xhr => { lateLoad = xhr.onload; }), client = f.client();
  const pending = client.login(), rejected = assert.rejects(pending, e => e.code === 'DISPOSED');
  await Promise.resolve(); await Promise.resolve();
  client.dispose(); client.dispose(); await rejected;
  const request = f.requests[0];
  assert.equal(request.aborts, 1); assert.equal(request.onload, null); assert.equal(request.onerror, null);
  request.respond(200, reply()); lateLoad(); assert.equal(client.player, undefined);
});

test('browser timeouts, lost callbacks and network failures produce retryable errors', async () => {
  for (const [handler, expected] of [[xhr => xhr.ontimeout(), 'TIMEOUT'], [xhr => xhr.onerror(), 'NETWORK_ERROR'],
    [xhr => xhr.respond(0, ''), 'NETWORK_ERROR'], [() => {}, 'TIMEOUT']]) {
    const f = fixture(handler), client = f.client(10);
    await assert.rejects(client.login(), e => e.code === expected);
    assert.equal(client.player, undefined);
    f.requests[0].respond(200, reply()); assert.equal(client.player, undefined); client.dispose();
  }
});

test('TapTap rejects malformed HTTP success and identities from WeChat or another MiniApp', async () => {
  for (const body of ['<html>proxy error</html>', '[]', reply('301', 'wechat_mini'), reply('301', 'taptap_mini', 'wrong-app'),
    { ...reply(), token_info: { ...reply().token_info, access_token: 'fake' } }]) {
    const f = fixture(xhr => xhr.respond(200, body)), client = f.client();
    await assert.rejects(client.login(), e => e.code === 'INVALID_RESPONSE');
    assert.equal(client.player, undefined); client.dispose();
  }
});

test('TapTap backend failures keep safe actionable messages and do not authenticate', async () => {
  for (const [code, status] of [['TAPTAP_CODE_INVALID', 401], ['TAPTAP_NOT_CONFIGURED', 503], ['TAPTAP_UNAVAILABLE', 502],
    ['TOO_MANY_REQUESTS', 429], ['ACCOUNT_DISABLED', 403]]) {
    const f = fixture(xhr => xhr.respond(status, { code, message: 'secret-upstream-detail' })), client = f.client();
    await assert.rejects(client.login(), e => e.code === code && e.status === status && !e.message.includes('secret'));
    assert.equal(client.player, undefined); assert.equal(f.requests.length, 1); client.dispose();
  }
});

test('TapTap renews an expired bearer using a fresh code and retains authenticated save ownership', async () => {
  let reads = 0;
  const f = fixture(xhr => {
    if (xhr.url.endsWith('/auth/taptap')) xhr.respond(200, reply());
    else if (++reads === 1) xhr.respond(401, { code: 'SESSION_INVALID' });
    else xhr.respond(200, { player_id: '301', revision: 2 });
  }), client = f.client();
  await client.login(); assert.equal((await client.saveRequest('GET', '301')).revision, 2);
  assert.equal(f.callbacks.length, 2); assert.equal(reads, 2);
  assert.equal(f.requests[1].body, null); assert.equal(f.requests[1].headers.Authorization, 'Bearer ' + reply().token_info.access_token);
  assert.notEqual(f.requests[0].body, f.requests[2].body); client.dispose();
});

test('TapTap account change during renewal never sends old saves or rewards under the new player', async () => {
  for (const kind of ['save', 'reward']) {
    let logins = 0, writes = 0;
    const f = fixture(xhr => {
      if (xhr.url.endsWith('/auth/taptap')) xhr.respond(200, reply(++logins === 1 ? '301' : '402'));
      else { writes++; xhr.respond(401, { code: 'SESSION_INVALID' }); }
    }), client = f.client();
    await client.login();
    const operation = kind === 'save' ? client.saveRequest('POST', '301', { save: 'old-private-save' })
      : client.rewardRequest('daily', '301', { request_id: 'old-player-reward' });
    await assert.rejects(operation, e => e.code === 'ACCOUNT_CHANGED');
    assert.equal(writes, 1); assert.equal(client.player.id, '402'); client.dispose();
  }
});

test('TapTap disabled sessions are cleared without retry and logout uses browser bearer transport', async () => {
  let disabled = false;
  const f = fixture(xhr => {
    if (xhr.url.endsWith('/auth/taptap')) xhr.respond(200, reply());
    else if (disabled) xhr.respond(403, { code: 'ACCOUNT_DISABLED' });
    else xhr.respond(200, { logged_out: true });
  }), client = f.client();
  await client.login(); await client.logout();
  assert.equal(f.requests[1].url, backend.baseUrl + '/auth/logout');
  assert.equal(f.requests[1].headers.Authorization, 'Bearer ' + reply().token_info.access_token);
  assert.equal(client.player, undefined);
  await client.login(); disabled = true;
  await assert.rejects(client.me(), e => e.code === 'ACCOUNT_DISABLED');
  assert.equal(client.player, undefined); assert.equal(f.callbacks.length, 2); client.dispose();
});

const economyKey = economyStorageKey('production');
const memory = () => { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; };
const seedStorage = memory(); new BattleSession({ environment: 'production', storage: seedStorage });
const save = level => { const value = JSON.parse(seedStorage.getItem(economyKey)); value.levels[0] = level; return JSON.stringify(value); };
let requestSerial = 0;
const cloud = (storage, login, owner) => new CloudSaveStorage(storage, login, owner, economyKey, backend.baseUrl,
  'production', Date.now, () => 'taptap_request_' + String(++requestSerial).padStart(8, '0'));
const openCloud = value => value.open(async () => { throw new Error('Unexpected cloud conflict'); });

/** Models only the server contracts exercised by the real adapter/login/storage pipeline. */
function cloudServer() {
  const saves = new Map(), receipts = new Map(), owners = new Map(), writes = [];
  const state = { loseNextWrite: false, saves, writes,
    handler(currentPlayer = () => '301') {
      return xhr => {
        if (xhr.url.endsWith('/auth/taptap')) {
          const response = reply(currentPlayer());
          response.token_info.access_token = 'fg1_' + currentPlayer().padEnd(43, 'T');
          owners.set('Bearer ' + response.token_info.access_token, response.player.id);
          xhr.respond(200, response); return;
        }
        const owner = owners.get(xhr.headers.Authorization);
        if (!owner) { xhr.respond(401, { code: 'SESSION_INVALID' }); return; }
        const current = saves.get(owner) ?? { player_id: owner, namespace: 'production', revision: '0', save: null, saved_at_ms: 0 };
        if (xhr.method === 'GET') { xhr.respond(200, current); return; }
        const body = JSON.parse(xhr.body); writes.push({ owner, ...body });
        let receipt = receipts.get(owner + ':' + body.request_id);
        if (!receipt) {
          if (body.base_revision !== current.revision) { xhr.respond(409, { code: 'SAVE_CONFLICT' }); return; }
          const revision = String(Number(current.revision) + 1);
          receipt = { player_id: owner, namespace: 'production', request_id: body.request_id, revision, current_revision: revision, saved_at_ms: 1000 };
          receipts.set(owner + ':' + body.request_id, receipt);
          saves.set(owner, { ...current, save: body.save, revision, saved_at_ms: 1000 });
        }
        if (state.loseNextWrite) { state.loseNextWrite = false; xhr.onerror(); return; }
        xhr.respond(200, { ...receipt, current_revision: saves.get(owner).revision });
      };
    },
  };
  return state;
}

test('TapTap XHR lost save acknowledgement survives restart and replays the same durable request once', async () => {
  const api = cloudServer(), storage = memory(), f = fixture(api.handler()), login = f.client();
  await login.login(); const first = cloud(storage, login, '301'); await openCloud(first);
  first.setItem(economyKey, save(2)); api.loseNextWrite = true;
  await assert.rejects(first.flush(), e => e.code === 'NETWORK_ERROR');
  assert.equal(first.status, 'offline'); assert.equal(first.dirty, true);
  const pending = JSON.parse(storage.getItem(first.journalKey)).pending;
  first.dispose(); login.dispose();
  const reopenedFixture = fixture(api.handler()), reopenedLogin = reopenedFixture.client();
  await reopenedLogin.login(); const reopened = cloud(storage, reopenedLogin, '301'); await openCloud(reopened);
  assert.equal(reopened.dirty, false); assert.equal(reopened.localSave, save(2));
  assert.equal(api.saves.get('301').revision, '1');
  assert.deepEqual(api.writes.map(write => write.request_id), [pending.request_id, pending.request_id]);
  assert.equal(api.writes[1].resume, true); reopened.dispose(); reopenedLogin.dispose();
});

test('TapTap two-device save conflicts retain both snapshots and never overwrite silently', async () => {
  const api = cloudServer();
  api.saves.set('301', { player_id: '301', namespace: 'production', revision: '1', save: save(1), saved_at_ms: 1000 });
  const fa = fixture(api.handler()), fb = fixture(api.handler()), loginA = fa.client(), loginB = fb.client();
  await Promise.all([loginA.login(), loginB.login()]);
  const storageB = memory(), a = cloud(memory(), loginA, '301'), b = cloud(storageB, loginB, '301');
  await Promise.all([openCloud(a), openCloud(b)]);
  a.setItem(economyKey, save(2)); await a.flush(); b.setItem(economyKey, save(3));
  await assert.rejects(b.flush(), e => e.code === 'SAVE_CONFLICT');
  assert.equal(b.status, 'conflict'); assert.equal(b.localSave, save(3)); assert.equal(api.saves.get('301').save, save(2));
  await b.resolveConflict('cloud'); assert.equal(b.localSave, save(2));
  const backups = [...storageB.data].filter(([key]) => key.includes(':backup:')).map(([, value]) => value);
  assert.ok(backups.includes(save(2)) && backups.includes(save(3)));
  a.dispose(); b.dispose(); loginA.dispose(); loginB.dispose();
});

test('TapTap preemptive token renewal blocks an old account journal and isolates the new account cache', async () => {
  let owner = '301', now = 0;
  const api = cloudServer(), storage = memory(), f = fixture(api.handler(() => owner)), login = f.client(15000, () => now);
  await login.login(); const old = cloud(storage, login, owner); await openCloud(old);
  old.setItem(economyKey, save(8)); old.setItem(economyKey + ':weapon-backup', save(7));
  owner = '402'; now = 3600000;
  await assert.rejects(old.flush(), e => e.code === 'ACCOUNT_CHANGED');
  assert.equal(old.status, 'blocked'); assert.equal(api.writes.length, 0);
  const previousJournal = storage.getItem(old.journalKey);
  assert.equal(JSON.parse(previousJournal).pending.save, save(8));
  const current = cloud(storage, login, owner); await openCloud(current);
  assert.notEqual(current.journalKey, old.journalKey);
  assert.equal(current.localSave, null); assert.equal(current.getItem(economyKey + ':weapon-backup'), null);
  current.setItem(economyKey, save(1)); await current.flush();
  assert.equal(storage.getItem(old.journalKey), previousJournal); assert.equal(api.saves.has('301'), false);
  assert.equal(api.saves.get('402').save, save(1));
  owner = '301'; await login.login();
  const restored = cloud(storage, login, owner); await openCloud(restored);
  assert.equal(restored.localSave, save(8)); assert.equal(restored.getItem(economyKey + ':weapon-backup'), save(7));
  assert.equal(api.saves.get('301').save, save(8)); assert.equal(api.saves.get('402').save, save(1));
  old.dispose(); current.dispose(); restored.dispose(); login.dispose();
});
