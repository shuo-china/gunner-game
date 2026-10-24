const test = require('node:test');
const assert = require('node:assert/strict');
const { createWechatShare } = require('./.build/session/platform/WechatShare.js');
const { PLATFORM_CHANNELS } = require('./.build/session/platform/PlatformConfig.js');

function fixture(shareAppMessage, menuApis = {}) {
  const calls = [], timers = [], cleared = [];
  const host = { shareAppMessage(options) {
    assert.equal(this, host, 'the host receiver must be preserved');
    calls.push(options); shareAppMessage?.(options);
  }, ...menuApis };
  const timer = {
    set(callback, delayMs) { const handle = { callback, delayMs }; timers.push(handle); return handle; },
    clear(handle) { cleared.push(handle); },
  };
  const provider = createWechatShare({ config: PLATFORM_CHANNELS['wechat-mini'], globals: { window: { wx: host } } }, timer);
  return { provider, calls, timers, cleared };
}

test('WeChat enables friend and timeline menus on startup and resume without opening a share sheet', () => {
  const registered = [], menus = [], removed = [];
  const { provider, calls, timers } = fixture(undefined, {
    onShareAppMessage(listener) { registered.push(['friend', listener]); },
    onShareTimeline(listener) { registered.push(['timeline', listener]); },
    showShareMenu(options) {
      assert.equal(registered.length, 2, 'card handlers are ready before enabling the menus');
      menus.push(options.menus);
    },
    offShareAppMessage(listener) { removed.push(['friend', listener]); },
    offShareTimeline(listener) { removed.push(['timeline', listener]); },
  });
  assert.deepEqual(menus, [['shareAppMessage', 'shareTimeline']]);
  for (const [, listener] of registered) {
    const card = listener();
    assert.deepEqual(card, { title: '三只小狐狸，能闯到第几关？' }, 'Use the selected title and let WeChat supply default images');
    card.title = 'foreign mutation';
    assert.deepEqual(listener(), { title: '三只小狐狸，能闯到第几关？' }, 'each share receives a fresh card');
    provider.onHide(); provider.onShow();
  }
  assert.deepEqual(calls, [], 'menu shares must not call the in-game share API');
  assert.deepEqual(timers, [], 'menu shares must not start an in-game reward request');
  assert.equal(menus.length, 3);
  assert.equal(registered.length, 2, 'resume must not duplicate global listeners');
  provider.destroy(); provider.destroy(); provider.onShow();
  assert.deepEqual(removed, registered, 'remove only these exact handlers, once');
  assert.equal(menus.length, 3, 'destroyed providers cannot reopen menus');
});

test('menu SDK failures do not prevent gameplay sharing or the other menu from initializing', async t => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  let timelineRegistrations = 0, menuAttempts = 0;
  const { provider, calls } = fixture(undefined, {
    onShareAppMessage() { throw new Error('registration failure'); },
    onShareTimeline() { timelineRegistrations++; },
    showShareMenu(options) {
      menuAttempts++;
      if (menuAttempts === 1) options.fail({ errMsg: 'showShareMenu:fail' });
      else throw new Error('menu unavailable');
    },
    offShareAppMessage() { throw new Error('cleanup failure'); },
  });
  assert.equal(timelineRegistrations, 1);
  const operation = provider.share();
  provider.onHide(); provider.onShow();
  assert.equal((await operation).status, 'unverified');
  assert.equal(calls.length, 1);
  assert.equal(menuAttempts, 2, 'foreground return retries enabling the menus');
  provider.destroy();
  assert.equal(warnings.length, 4, 'SDK failures remain visible in diagnostics');
});

test('WeChat uses the selected default title and only reports an unverified hide-show return', async () => {
  const { provider, calls, timers, cleared } = fixture();
  const results = [], operation = provider.share().then(result => { results.push(result); return result; });
  assert.equal(provider.supported, true);
  assert.deepEqual(calls, [{ title: '三只小狐狸，能闯到第几关？' }]);
  assert.equal(timers[0].delayMs, 30000);
  provider.onShow(); await Promise.resolve();
  assert.deepEqual(results, [], 'show without a request-scoped hide cannot settle sharing');
  provider.onHide(); provider.onHide();
  assert.deepEqual(cleared, [timers[0]], 'the opening timeout is cleared exactly once on hide');
  provider.onShow(); provider.onShow();
  assert.deepEqual(await operation, { status: 'unverified' });
  assert.equal(results.length, 1);
  provider.destroy();
});

test('share card configuration forwards only supported fields without fabricated SDK callbacks', async () => {
  const { provider, calls } = fixture();
  const operation = provider.share({ title: '森林枪手', imageUrl: 'share.png', query: 'source=daily', success() {}, diamonds: 80 });
  assert.deepEqual(calls, [{ title: '森林枪手', imageUrl: 'share.png', query: 'source=daily' }]);
  provider.onHide(); provider.onShow();
  assert.equal((await operation).status, 'unverified'); provider.destroy();
});

test('concurrent clicks do not launch a second sheet or replace the original pending request', async () => {
  const { provider, calls } = fixture();
  const first = provider.share();
  assert.equal((await provider.share()).status, 'failed');
  assert.equal(calls.length, 1);
  provider.onHide(); provider.onShow();
  assert.equal((await first).status, 'unverified');
  const results = [], second = provider.share().then(result => { results.push(result); return result; });
  provider.onShow(); await Promise.resolve();
  assert.deepEqual(results, [], 'a duplicate old show must not complete the next share');
  provider.onHide(); provider.onShow();
  assert.equal((await second).status, 'unverified'); assert.equal(calls.length, 2); provider.destroy();
});

test('sharing while backgrounded fails and earlier lifecycle events cannot satisfy the next request', async () => {
  const { provider, calls } = fixture();
  provider.onHide();
  assert.equal((await provider.share()).status, 'failed'); assert.equal(calls.length, 0);
  provider.onShow();
  const results = [], operation = provider.share().then(result => { results.push(result); return result; });
  provider.onShow(); await Promise.resolve(); assert.deepEqual(results, []);
  provider.onHide(); provider.onShow(); assert.equal((await operation).status, 'unverified'); provider.destroy();
});

test('missing WeChat share support is explicitly unavailable without throwing or faking success', async () => {
  for (const globals of [{}, { wx: {} }, { window: { wx: {} } }]) {
    const provider = createWechatShare({ config: PLATFORM_CHANNELS['wechat-mini'], globals });
    assert.equal(provider.supported, false);
    assert.equal((await provider.share()).status, 'unavailable'); provider.destroy();
  }
});

test('a synchronous SDK failure clears the pending request and permits a later retry', async () => {
  let shouldThrow = true;
  const { provider, timers, cleared } = fixture(() => { if (shouldThrow) throw new Error('SDK failed'); });
  assert.deepEqual(await provider.share(), { status: 'failed', message: '分享未完成，请重试' });
  assert.deepEqual(cleared, [timers[0]]);
  shouldThrow = false;
  const operation = provider.share();
  provider.onHide(); provider.onShow(); assert.equal((await operation).status, 'unverified'); provider.destroy();
});

test('the opening timeout fails without rewards and stale timers cannot complete a later attempt', async () => {
  const { provider, timers, cleared } = fixture();
  const first = provider.share();
  timers[0].callback();
  assert.deepEqual(await first, { status: 'failed', message: '分享未完成，请重试' });
  assert.deepEqual(cleared, [timers[0]]);
  const results = [], second = provider.share().then(result => { results.push(result); return result; });
  timers[0].callback(); provider.onShow(); await Promise.resolve();
  assert.deepEqual(results, []);
  provider.onHide(); provider.onShow(); assert.equal((await second).status, 'unverified'); provider.destroy();
});

test('entering the background cancels the opening timeout without imposing a sharing duration', async () => {
  const { provider, timers, cleared } = fixture();
  const results = [], operation = provider.share().then(result => { results.push(result); return result; });
  provider.onHide();
  assert.deepEqual(cleared, [timers[0]]);
  timers[0].callback(); await Promise.resolve();
  assert.deepEqual(results, [], 'even a queued expired timer cannot cancel a valid background share');
  provider.onShow(); assert.equal((await operation).status, 'unverified'); provider.destroy();
});

test('destroy cancels an in-flight request once, clears its timer and ignores late events', async () => {
  for (const hideFirst of [false, true]) {
    const { provider, timers, cleared, calls } = fixture();
    const results = [], operation = provider.share().then(result => { results.push(result); return result; });
    if (hideFirst) provider.onHide();
    provider.destroy(); provider.destroy();
    provider.onHide(); provider.onShow(); timers[0].callback();
    assert.equal((await operation).status, 'cancelled'); assert.equal(results.length, 1);
    assert.deepEqual(cleared, [timers[0]]);
    assert.equal((await provider.share()).status, 'cancelled'); assert.equal(calls.length, 1);
  }
});

test('pending is installed before invoking an SDK that synchronously forwards lifecycle events', async () => {
  let provider;
  const current = fixture(() => { provider.onHide(); provider.onShow(); });
  provider = current.provider;
  assert.equal((await provider.share()).status, 'unverified');
  assert.equal(current.cleared.length, 1); provider.destroy();
});
