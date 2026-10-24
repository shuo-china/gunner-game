const test = require('node:test');
const assert = require('node:assert/strict');
const { GameLoginClient } = require('./.build/session/session/GameLogin.js');
const { GAME_BACKEND, resolveGameBackendConfig } = require('./.build/session/session/GameBackendConfig.js');
const { createWechatLogin } = require('./.build/session/platform/WechatPlatform.js');
const { PLATFORM_CHANNELS } = require('./.build/session/platform/PlatformConfig.js');
const config = resolveGameBackendConfig(undefined, 'production');
const appId = PLATFORM_CHANNELS['wechat-mini'].appId;
const wechatBinding = host => createWechatLogin({ config: PLATFORM_CHANNELS['wechat-mini'], globals: { wx: host } });
const success = (id = '101') => ({ player: { id, nickname: '玩家', provider: 'wechat_mini', app_id: appId },
  is_new_player: false, token_info: { access_token: 'fg1_' + 'A'.repeat(43), token_type: 'Bearer', expires_in: 86400, expires_at_ms: 9999999999999 }, server_time_ms: 1000000 });
function fixture(handler) {
  let codes = 0;
  const requests = [];
  const host = { getAccountInfoSync: () => ({ miniProgram: { appId } }),
    login: options => queueMicrotask(() => options.success({ code: 'fresh-code-' + (++codes) })),
    request: options => { requests.push(options); queueMicrotask(() => handler(options)); return { abort() {} }; } };
  return { host, requests, codes: () => codes };
}

test('production requires HTTPS and accepts only public routing configuration', () => {
  assert.equal(config.baseUrl, 'https://nurse.kylinsit.com/game/v1');
  assert.equal(resolveGameBackendConfig(undefined, 'test').baseUrl, GAME_BACKEND.test);
  for (const baseUrl of ['http://127.0.0.1:8787/game/v1', 'https://user:password@host/game', 'https://host/game?secret=x', 'https://host/../game']) {
    assert.throws(() => resolveGameBackendConfig({ baseUrl }, 'production'));
  }
  assert.throws(() => resolveGameBackendConfig({ baseUrl: 'http://remote.test/game' }, 'test'));
});

test('save retry pins the original UID when an expired session logs into another account', async () => {
  let logins = 0, writes = 0;
  const f = fixture(o => {
    if (o.url.endsWith('/wechat')) o.success({ statusCode: 200, data: success(++logins === 1 ? '101' : '202') });
    else { writes++; o.success({ statusCode: 401, data: { code: 'SESSION_INVALID' } }); }
  });
  const client = new GameLoginClient(wechatBinding(f.host), config); await client.login();
  await assert.rejects(client.saveRequest('POST', '101', { save: 'private-progress' }), e => e.code === 'ACCOUNT_CHANGED');
  assert.equal(writes, 1); assert.equal(client.player.id, '202'); client.dispose();
});

test('concurrent login calls share one fresh wx.login code and send no player-supplied identity', async () => {
  const f = fixture(o => o.success({ statusCode: 200, data: success() }));
  const client = new GameLoginClient(wechatBinding(f.host), config);
  const [a, b] = await Promise.all([client.login(), client.login()]);
  assert.equal(a, b);
  assert.equal(f.codes(), 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].data, { code: 'fresh-code-1' });
  assert.equal(f.requests[0].url, config.baseUrl + '/auth/wechat');
  assert.equal(f.requests[0].header.Authorization, undefined);
  assert.equal(client.player.id, '101');
  client.dispose();
});

test('relogin uses a new platform code and the returned player identity', async () => {
  let uid = '101';
  const f = fixture(o => o.success({ statusCode: 200, data: success(uid) }));
  const client = new GameLoginClient(wechatBinding(f.host), config);
  await client.login(); uid = '202'; await client.login();
  assert.equal(client.player.id, '202');
  assert.equal(f.codes(), 2);
  assert.notEqual(f.requests[0].data.code, f.requests[1].data.code);
  client.dispose();
});

test('expired server session triggers one fresh login then retries the authenticated read', async () => {
  let reads = 0;
  const f = fixture(o => {
    if (o.url.endsWith('/wechat')) o.success({ statusCode: 200, data: success() });
    else if (++reads === 1) o.success({ statusCode: 401, data: { code: 'SESSION_INVALID' } });
    else o.success({ statusCode: 200, data: { player: success().player } });
  });
  const client = new GameLoginClient(wechatBinding(f.host), config);
  await client.login();
  assert.equal((await client.me()).id, '101');
  assert.equal(reads, 2); assert.equal(f.codes(), 2);
  assert.equal(f.requests[1].header.Authorization, 'Bearer ' + success().token_info.access_token);
  client.dispose();
});

test('disabled accounts are not retried or retained as authenticated', async () => {
  const f = fixture(o => o.success(o.url.endsWith('/wechat') ? { statusCode: 200, data: success() }
    : { statusCode: 403, data: { code: 'ACCOUNT_DISABLED' } }));
  const client = new GameLoginClient(wechatBinding(f.host), config);
  await client.login();
  await assert.rejects(client.me(), e => e.code === 'ACCOUNT_DISABLED');
  assert.equal(client.player, undefined); assert.equal(f.codes(), 1);
  client.dispose();
});

test('failed explicit relogin does not retain the previous account session', async () => {
  let failed = false;
  const f = fixture(o => o.success(failed ? { statusCode: 403, data: { code: 'WECHAT_ACCOUNT_RESTRICTED' } }
    : { statusCode: 200, data: success() }));
  const client = new GameLoginClient(wechatBinding(f.host), config);
  await client.login(); failed = true;
  await assert.rejects(client.login(), e => e.code === 'WECHAT_ACCOUNT_RESTRICTED');
  assert.equal(client.player, undefined); client.dispose();
});

test('malformed success, wrong AppID and spoofed upstream error messages never authenticate', async () => {
  for (const body of [{}, { ...success(), player: { ...success().player, provider: 'taptap_mini' } },
    { ...success(), token_info: { ...success().token_info, access_token: 'not-a-session' } }]) {
    const f = fixture(o => o.success({ statusCode: 200, data: body }));
    const client = new GameLoginClient(wechatBinding(f.host), config);
    await assert.rejects(client.login(), e => e.code === 'INVALID_RESPONSE');
    assert.equal(client.player, undefined); client.dispose();
  }
  const f = fixture(o => o.success({ statusCode: 500, data: { code: 'SERVER_ERROR', message: 'secret-must-not-be-displayed' } }));
  const client = new GameLoginClient(wechatBinding(f.host), config);
  await assert.rejects(client.login(), e => !e.message.includes('secret'));
  client.dispose();
  f.host.getAccountInfoSync = () => ({ miniProgram: { appId: 'wrong' } });
  await assert.rejects(new GameLoginClient(wechatBinding(f.host), config).login(), e => e.code === 'APP_ID_MISMATCH');
});

test('logout revokes the bearer session and clears local identity', async () => {
  const f = fixture(o => o.success({ statusCode: 200, data: o.url.endsWith('/wechat') ? success() : { logged_out: true } }));
  const client = new GameLoginClient(wechatBinding(f.host), config);
  await client.login(); await client.logout();
  assert.equal(client.player, undefined);
  assert.equal(f.requests.at(-1).url, config.baseUrl + '/auth/logout');
  assert.equal(f.requests.at(-1).header.Authorization, 'Bearer ' + success().token_info.access_token);
  client.dispose();
});

test('lost platform callbacks time out and late responses cannot log in a destroyed game', async () => {
  const hanging = new GameLoginClient(wechatBinding({ login() {}, request() {} }), config, Date.now, 10);
  await assert.rejects(hanging.login(), e => e.code === 'TIMEOUT'); hanging.dispose();
  let response, aborted = 0;
  const host = { login(o) { o.success({ code: 'code' }); }, request(o) { response = o; return { abort() { aborted++; } }; } };
  const client = new GameLoginClient(wechatBinding(host), config);
  const promise = client.login();
  await Promise.resolve(); client.dispose();
  await assert.rejects(promise, e => e.code === 'DISPOSED');
  response.success({ statusCode: 200, data: success() });
  assert.equal(client.player, undefined); assert.equal(aborted, 1);
});

test('device/server clock skew does not immediately expire a valid session', async () => {
  const f = fixture(o => o.success({ statusCode: 200, data: o.url.endsWith('/wechat') ? success() : { player: success().player } }));
  const client = new GameLoginClient(wechatBinding(f.host), config, () => 999999999999999);
  await client.login(); await client.me();
  assert.equal(f.codes(), 1); client.dispose();
});
