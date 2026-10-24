const test = require('node:test');
const assert = require('node:assert/strict');
const { PLATFORM_CHANNELS, resolvePlatformConfig } = require('./.build/session/platform/PlatformConfig.js');
const { PlatformProviderRegistry, createGamePlatform, createDefaultPlatformProviders } = require('./.build/session/platform/PlatformServices.js');
const { createWechatLogin } = require('./.build/session/platform/WechatPlatform.js');
const { GameLoginClient } = require('./.build/session/session/GameLogin.js');
const { RewardedAdService } = require('./.build/session/session/RewardedAds.js');
const backend = { baseUrl: 'https://game.example.test/game/v1' };
const reply = (provider = 'taptap_native', appId = 'fixture-client') => ({
  player: { id: '301', nickname: '玩家', provider, app_id: appId }, is_new_player: false,
  token_info: { access_token: 'fg1_' + 'B'.repeat(43), token_type: 'Bearer', expires_in: 3600, expires_at_ms: 9999999999999 }, server_time_ms: 1,
});
function binding(overrides = {}) {
  return { provider: { identityProvider: 'taptap_native', appId: 'fixture-client', endpoint: '/auth/taptap',
    acquireCredential: options => options.success({ authorization: { proof: 'fixture-sdk-proof' } }), ...overrides },
    transport: { request: options => options.success({ statusCode: 200, data: reply() }) } };
}

test('build target selects the channel even when other SDK globals exist', () => {
  let wxCalls = 0;
  const globals = { wx: { login() { wxCalls++; }, request() { wxCalls++; } }, tt: {} };
  assert.equal(createGamePlatform(globals, {}).channel, 'web');
  assert.equal(createGamePlatform(globals, { wechat: true }).channel, 'wechat-mini');
  const douyin = createGamePlatform(globals, { douyin: true });
  assert.equal(douyin.channel, 'douyin-mini'); assert.equal(douyin.requiresLogin, true);
  assert.throws(() => douyin.createLogin(), /抖音登录尚未接入/);
  assert.equal(wxCalls, 0, 'unsupported channels never fall back to WeChat');
});

test('native distributions require an explicit native channel and invalid settings never become guest login', () => {
  assert.throws(() => createGamePlatform({}, { native: true }), /安卓发行渠道/);
  const native = createGamePlatform({ __FOREST_GUNNER_PLATFORM__: { channel: 'taptap-android' } }, { native: true });
  assert.equal(native.requiresLogin, true); assert.throws(() => native.createLogin(), /TapTap 安卓登录尚未接入/);
  for (const injected of [null, [], {}, 'wechat-mini', { channel: 'unknown' }, { channel: '__proto__' }]) {
    assert.throws(() => resolvePlatformConfig(injected, {}));
  }
  assert.throws(() => resolvePlatformConfig({ channel: 'web' }, { wechat: true }));
  assert.throws(() => resolvePlatformConfig({ channel: 'taptap-android' }, {}));
  assert.throws(() => resolvePlatformConfig({ channel: 'taptap-mini' }, { native: true }));
  assert.throws(() => resolvePlatformConfig(undefined, { wechat: true, douyin: true }));
});

test('TapTap mini and native are separate extension points with no fabricated credentials', () => {
  const mini = createGamePlatform({ __FOREST_GUNNER_PLATFORM__: { channel: 'taptap-mini' } }, {});
  assert.equal(mini.requiresLogin, true); assert.throws(() => mini.createLogin(), /TapTap 小游戏登录尚未接入/);
  assert.equal(PLATFORM_CHANNELS['taptap-mini'].appId, '');
  assert.equal(PLATFORM_CHANNELS['taptap-android'].appId, '');
});

test('one ad network can serve different login channels with channel-specific ad units', () => {
  const registry = new PlatformProviderRegistry(), seen = [];
  registry.registerLogin('taptap-mini', () => binding({ identityProvider: 'taptap_mini' }));
  registry.registerLogin('taptap-android', () => binding());
  registry.registerAds('fixture-network', context => ({ show(request, complete) {
    seen.push([context.config.channel, context.config.ads.unitIds[request.placement]]); complete('cancel');
  } }));
  for (const [channel, identityProvider] of [['taptap-mini', 'taptap_mini'], ['taptap-android', 'taptap_native']]) {
    const context = { globals: {}, config: { ...PLATFORM_CHANNELS[channel], appId: 'fixture-client',
      ads: { provider: 'fixture-network', unitIds: { 'weapon-daily': channel + '-unit' } } } };
    assert.equal(registry.createLogin(context).provider.identityProvider, identityProvider);
    const service = new RewardedAdService(registry.createAds(context));
    const outcomes = [];
    service.showRewardedAd('business-token', 'weapon-daily', outcome => outcomes.push(outcome));
    assert.deepEqual(outcomes, ['cancel']); service.destroy();
  }
  assert.deepEqual(seen, [['taptap-mini', 'taptap-mini-unit'], ['taptap-android', 'taptap-android-unit']]);
});

test('unavailable ads fail and unregistered networks do not fall back to simulated success', () => {
  const platform = createGamePlatform({}, {}), results = [];
  platform.createRewardedAds().show({ id: 'fixture', placement: 'weapon-daily' }, result => results.push(result));
  assert.deepEqual(results, ['failure']);
  const providers = createDefaultPlatformProviders();
  assert.throws(() => providers.createAds({ globals: {}, config: { ...PLATFORM_CHANNELS.web, ads: { provider: 'missing', unitIds: {} } } }));
  assert.throws(() => providers.registerLogin('wechat-mini', () => binding()), /重复/);
  assert.throws(() => providers.registerAds('unavailable', () => ({})), /重复/);
});

test('shared sessions accept SDK proof payloads and a non-WeChat transport for login, me and logout', async () => {
  const adapter = binding(), requests = [];
  adapter.transport.request = options => {
    requests.push(options);
    options.success({ statusCode: 200, data: options.url.endsWith('/logout') ? { logged_out: true } : reply() });
  };
  const client = new GameLoginClient(adapter, backend);
  await client.login(); assert.equal((await client.me()).provider, 'taptap_native'); await client.logout();
  assert.deepEqual(requests.map(request => request.url), ['/auth/taptap', '/auth/me', '/auth/logout'].map(path => backend.baseUrl + path));
  assert.deepEqual(requests[0].data, { authorization: { proof: 'fixture-sdk-proof' } });
  assert.equal(requests[0].header.Authorization, undefined);
  assert.equal(requests[1].header.Authorization, 'Bearer ' + reply().token_info.access_token);
  assert.equal(client.player, undefined); client.dispose();
});

test('server success for another platform or app cannot authenticate the selected channel', async () => {
  for (const response of [reply('wechat_mini'), reply('taptap_mini'), reply('taptap_native', 'another-client')]) {
    const adapter = binding(); adapter.transport.request = options => options.success({ statusCode: 200, data: response });
    const client = new GameLoginClient(adapter, backend);
    await assert.rejects(client.login(), error => error.code === 'INVALID_RESPONSE');
    assert.equal(client.player, undefined); client.dispose();
  }
});

test('cancelled native credential acquisition is aborted and late callbacks cannot cross a subsequent login', async () => {
  const callbacks = [], sent = []; let cancelled = 0;
  const adapter = binding({ acquireCredential: options => { callbacks.push(options); return () => { cancelled++; }; } });
  adapter.transport.request = options => { sent.push(options.data); options.success({ statusCode: 200, data: reply() }); };
  const client = new GameLoginClient(adapter, backend);
  const first = client.login(), rejected = assert.rejects(first, error => error.code === 'DISPOSED');
  await client.logout(); await rejected; const second = client.login();
  callbacks[0].success({ staleProof: 'old-account' }); callbacks[1].success({ proof: 'new-account' });
  await second;
  assert.deepEqual(sent, [{ proof: 'new-account' }]); assert.equal(cancelled, 1); client.dispose();
});

test('lost native credential callbacks time out, abort once and cannot later start HTTP', async () => {
  let callback, cancelled = 0, requests = 0;
  const adapter = binding({ acquireCredential: options => { callback = options; return () => { cancelled++; }; } });
  adapter.transport.request = () => { requests++; };
  const client = new GameLoginClient(adapter, backend, Date.now, 10);
  await assert.rejects(client.login(), error => error.code === 'TIMEOUT');
  callback.success({ proof: 'late' }); client.dispose();
  assert.equal(cancelled, 1); assert.equal(requests, 0);
});

test('user-cancelled login and empty credentials never reach the backend', async () => {
  for (const [acquireCredential, expected] of [
    [options => options.fail('LOGIN_CANCELLED'), 'LOGIN_CANCELLED'],
    [options => options.success({}), 'CREDENTIAL_INVALID'],
    [options => options.success(null), 'CREDENTIAL_INVALID'],
  ]) {
    const adapter = binding({ acquireCredential }); let requests = 0;
    adapter.transport.request = () => { requests++; };
    const client = new GameLoginClient(adapter, backend);
    await assert.rejects(client.login(), error => error.code === expected);
    assert.equal(requests, 0); client.dispose();
  }
});

test('login adapters cannot route credential proofs outside the configured login API', () => {
  for (const endpoint of ['https://other.test/auth', '/../auth/test', '/auth/me', '/auth/logout', '/auth/test?redirect=x']) {
    assert.throws(() => new GameLoginClient(binding({ endpoint }), backend));
  }
});

test('WeChat adapter preserves host receivers, window fallback and the existing code-only wire format', async () => {
  const host = { getAccountInfoSync() { assert.equal(this, host); return { miniProgram: { appId: PLATFORM_CHANNELS['wechat-mini'].appId } }; },
    login(options) { assert.equal(this, host); options.success({ code: 'fixture-code', openid: 'untrusted-extra' }); },
    request(options) { assert.equal(this, host); assert.deepEqual(options.data, { code: 'fixture-code' });
      options.success({ statusCode: 200, data: reply('wechat_mini', PLATFORM_CHANNELS['wechat-mini'].appId) }); } };
  const client = new GameLoginClient(createWechatLogin({ config: PLATFORM_CHANNELS['wechat-mini'], globals: { window: { wx: host } } }), backend);
  await client.login(); assert.equal(client.player.provider, 'wechat_mini'); client.dispose();
});

test('switching an ad network retains shared cancel, duplicate-callback and cleanup protections', () => {
  const callbacks = [], requests = [], outcomes = []; let cleaned = 0, destroyed = 0;
  const providers = new PlatformProviderRegistry().registerAds('fixture-native-ads', () => ({
    show(request, callback) { requests.push(request); callbacks.push(callback); return () => { cleaned++; }; },
    destroy() { destroyed++; },
  }));
  const context = { globals: {}, config: { ...PLATFORM_CHANNELS['taptap-android'], ads: { provider: 'fixture-native-ads', unitIds: {} } } };
  const service = new RewardedAdService(providers.createAds(context));
  service.showRewardedAd('private-token-1', 'weapon-daily', result => outcomes.push(result));
  assert.equal(requests[0].token, undefined); service.cancelAll();
  service.showRewardedAd('private-token-2', 'mine-reward', result => outcomes.push(result));
  callbacks[0]('success'); assert.deepEqual(outcomes, ['cancel']);
  callbacks[1]('success'); callbacks[1]('success'); service.destroy(); service.destroy();
  assert.deepEqual(outcomes, ['cancel', 'success']); assert.equal(cleaned, 2); assert.equal(destroyed, 1);
});

test('sharing follows the selected channel and unsupported channels never use a WeChat shim', async () => {
  let wxCalls = 0, menuCalls = 0;
  const wx = {
    shareAppMessage() { wxCalls++; },
    showShareMenu(options) { assert.equal(this, wx); assert.deepEqual(options.menus, ['shareAppMessage', 'shareTimeline']); menuCalls++; },
    onShareAppMessage() { assert.equal(this, wx); menuCalls++; },
    onShareTimeline() { assert.equal(this, wx); menuCalls++; },
    offShareAppMessage() { assert.equal(this, wx); menuCalls++; },
    offShareTimeline() { assert.equal(this, wx); menuCalls++; },
  };
  for (const channel of ['web', 'douyin-mini', 'taptap-h5', 'taptap-mini', 'taptap-android']) {
    const globals = { __FOREST_GUNNER_PLATFORM__: { channel }, wx };
    const platform = createGamePlatform(globals, { native: channel === 'taptap-android' });
    const share = platform.createShare();
    assert.equal(share.supported, false); assert.equal((await share.share()).status, 'unavailable'); share.destroy();
  }
  assert.equal(wxCalls, 0);
  assert.equal(menuCalls, 0, 'other channels must not register or enable WeChat menus');
  const wechat = createGamePlatform({ wx }, { wechat: true }).createShare();
  assert.equal(menuCalls, 3);
  assert.equal(wechat.supported, true);
  const operation = wechat.share(); wechat.onHide(); wechat.onShow();
  assert.equal((await operation).status, 'unverified'); assert.equal(wxCalls, 1); wechat.destroy();
  assert.equal(menuCalls, 6);
});

test('new share adapters register independently of login and ad providers', async () => {
  const registry = new PlatformProviderRegistry(), seen = [];
  registry.registerShare('taptap-mini', context => ({
    supported: true,
    share: async options => { seen.push([context.config.channel, options]); return { status: 'confirmed' }; },
    destroy() {},
  }));
  const platform = createGamePlatform({ __FOREST_GUNNER_PLATFORM__: { channel: 'taptap-mini' } }, {}, registry);
  const share = platform.createShare();
  assert.equal((await share.share({ title: 'fixture' })).status, 'confirmed');
  assert.deepEqual(seen, [['taptap-mini', { title: 'fixture' }]]);
  assert.throws(() => registry.registerShare('taptap-mini', () => share), /重复/);
  assert.throws(() => createDefaultPlatformProviders().registerShare('wechat-mini', () => share), /重复/);
  assert.throws(() => platform.createLogin(), /登录尚未接入/); share.destroy();
});
