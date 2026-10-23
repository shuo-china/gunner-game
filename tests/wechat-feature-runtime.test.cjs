const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createTiming}=require('./support/wechat-resource-timing.cjs');
const base = 'https://nurse.kylinsit.com/forest-gunner/';
const png = 'remote/resources/native/ab/ab1234.abcd.png', font = 'remote/resources/native/cd/cd1234.abcd.png';
const item = remote => ({ package: 'forest-ui-weapons-0', path: 'subpackages/forest-ui-weapons-0/' + remote.slice('remote/resources/'.length), localOnly: false });
function fixture(group = 'weapons', localOnly = false) {
  const module = { exports: {} }, packages = [], reads = [], timers = [];
  let now = 0;
  const timing=createTiming({Date:{now:()=>now}});
  const original = (url, options, callback) => { reads.push({ url, options }); callback(null, url); };
  const downloader = { handlers: { '.png': original }, register(ext, handler) { this.handlers[ext] = handler; } };
  const entry = remote => group === 'startup' ? { package: null, path: 'startup-ui/' + remote.slice('remote/resources/'.length), localOnly: true } : { ...item(remote), localOnly };
  const code = fs.readFileSync(path.join(__dirname, '../tools/wechat-feature-runtime.cjs'), 'utf8').replace('__FOREST_GUNNER_FEATURE_INDEX__', JSON.stringify({ version: 2, base, files: { [png]: entry(png), [font]: entry(font) } }).replaceAll('forest-ui-weapons-0', 'forest-ui-' + group + '-0'));
  vm.runInNewContext(code, { module, exports: module.exports, wx: { loadSubpackage(options) { packages.push(options); } },
    require:name=>{assert.equal(name,'./wechat-resource-timing.js');return timing.exports;},
    Date: { now: () => now },
    setTimeout(callback, delay) { const timer = { callback, at: now + delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); } });
  const cc = { assetManager: { downloader } };
  assert.equal(module.exports.installFeatureResources(cc), true);
  const load = remote => new Promise((resolve, reject) => downloader.handlers[path.extname(remote)](base + remote, {}, (error, data) => error ? reject(error) : resolve(data)));
  return { load, packages, reads, timers, timing:timing.api, advance() { now += 2001; }, now: () => now,
    runNextTimer() { timers.sort((a, b) => a.at - b.at); const timer = timers.shift(); assert.ok(timer); now = timer.at; timer.callback(); },
    install: () => module.exports.installFeatureResources(cc), downloader };
}
const flush = () => new Promise(setImmediate);

test('new per-feature and shared font groups and collection art use their own package', async () => {
  for (const group of ['fonts-settings', 'fonts-daily-check', 'fonts-shared-a8d1b229', 'collection']) {
    const f = fixture(group, group.startsWith('fonts-')), waiting = f.load(png);
    assert.equal(f.packages[0].name, 'forest-ui-' + group + '-0');
    f.packages[0].success();
    assert.equal(await waiting, item(png).path.replace('weapons', group));
    assert.equal(f.packages.length, 1);
  }
});

test('settings images and input glyphs use only the small settings subpackage without a TTF handler', async () => {
  const f = fixture('settings'), pngReady = f.load(png), fontReady = f.load(font);
  assert.equal(f.packages.length, 1); assert.equal(f.packages[0].name, 'forest-ui-settings-0');
  f.packages[0].success(); await Promise.all([pngReady, fontReady]);
  assert.ok(f.reads.every(read => read.url.startsWith('subpackages/forest-ui-settings-0/')));
});

test('offline summary art and glyphs load from the packaged offline group without CDN traffic', async () => {
  const f = fixture('offline'), imageReady = f.load(png), glyphReady = f.load(font);
  assert.equal(f.packages.length, 1);
  assert.equal(f.packages[0].name, 'forest-ui-offline-0');
  assert.equal(f.reads.length, 0);
  f.packages[0].success();
  assert.deepEqual(await Promise.all([imageReady, glyphReady]), [png, font].map(remote =>
    'subpackages/forest-ui-offline-0/' + remote.slice('remote/resources/'.length)));
  assert.ok(f.reads.every(read => read.url.startsWith('subpackages/forest-ui-offline-0/')));
});
test('daily check artwork uses its packaged group without disabling all feature mappings', async () => {
  const f = fixture('daily-check'), waiting = f.load(png);
  assert.equal(f.packages[0].name, 'forest-ui-daily-check-0');
  f.packages[0].success();
  assert.equal(await waiting, item(png).path.replace('weapons', 'daily-check'));
  assert.ok(f.reads.every(read => read.url.startsWith('subpackages/forest-ui-daily-check-0/')));
});
test('HUD glyphs load directly from the main package without a subpackage or network request', async () => {
  const f = fixture('startup');
  assert.equal(await f.load(font), 'startup-ui/' + font.slice('remote/resources/'.length));
  assert.equal(f.packages.length, 0); assert.equal(f.reads.length, 1);
  assert.ok(f.reads[0].url.startsWith('startup-ui/'));
});
test('a cold weapon panel shares one platform download and reads icons and fonts locally', async () => {
  const f = fixture(), first = f.load(png), second = f.load(font);
  assert.equal(f.packages.length, 1); assert.equal(f.reads.length, 0);
  f.packages[0].success();
  assert.deepEqual(await Promise.all([first, second]), [item(png).path, item(font).path]);
  await f.load(png); assert.equal(f.packages.length, 1);
  assert.ok(f.reads.every(read => read.url.startsWith('subpackages/')));
  const handler = f.downloader.handlers['.png']; assert.equal(f.install(), true); assert.equal(f.downloader.handlers['.png'], handler);
});
test('two transient subpackage errors recover inside the same panel load without CDN traffic', async () => {
  const f = fixture(), waiting = f.load(png);
  for (let n = 0; n < 2; n++) { f.packages[n].fail(Error('offline')); await flush(); f.runNextTimer(); await flush(); }
  f.packages[2].success(); assert.equal(await waiting, item(png).path); assert.equal(f.packages.length, 3);
  assert.ok(f.reads.every(read => !read.url.startsWith('https:')));
});
test('an exhausted platform request falls back, shares its cooldown and can recover on a later retry', async () => {
  const f = fixture(), waiting = f.load(png);
  for (let n = 0; n < 3; n++) { f.packages[n].fail(Error('offline')); await flush(); if (f.timers.length) { f.runNextTimer(); await flush(); } }
  assert.equal(await waiting, base + png); assert.equal(await f.load(font), base + font); assert.equal(f.packages.length, 3);
  f.advance(); const recovered = f.load(png); assert.equal(f.packages.length, 4); f.packages[3].success();
  assert.equal(await recovered, item(png).path);
});
test('a newly packaged glyph page reports unavailable instead of requesting an undeployed CDN version', async () => {
  const f = fixture('fonts', true), waiting = f.load(font), rejected = assert.rejects(waiting, /offline/);
  for (let n = 0; n < 3; n++) { f.packages[n].fail(Error('offline')); await flush(); if (f.timers.length) { f.runNextTimer(); await flush(); } }
  await rejected; assert.equal(f.reads.length, 0);
  f.advance(); const recovered = f.load(font); f.packages[3].success();
  assert.equal(await recovered, item(font).path.replace('weapons', 'fonts'));
});
test('missing platform callbacks time out shared glyph requests and allow a later package retry', async () => {
  const f = fixture('fonts', true);
  const first = assert.rejects(f.load(png), /subpackage request timed out/);
  const second = assert.rejects(f.load(font), /subpackage request timed out/);
  assert.equal(f.packages.length, 1);
  for (let n = 0; n < 3; n++) {
    f.runNextTimer(); await flush();
    if (n < 2) { f.runNextTimer(); await flush(); }
  }
  await Promise.all([first, second]);
  assert.equal(f.packages.length, 3); assert.equal(f.timers.length, 0);
  assert.ok(f.now() < 60000, 'the adapter releases the engine request before the outer resource timeout');
  assert.equal(f.reads.length, 0, 'packaged-only glyphs never fall back to an undeployed CDN file');
  await assert.rejects(f.load(font), /subpackage request timed out/);
  assert.equal(f.packages.length, 3, 'the failure cooldown is shared');
  f.advance(); const recovered = f.load(font);
  assert.equal(f.packages.length, 4);
  for (const stale of f.packages.slice(0, 3)) { stale.success(); stale.fail(Error('late failure')); }
  await flush(); assert.equal(f.reads.length, 0, 'late results cannot complete the replacement attempt');
  f.packages[3].success();
  assert.equal(await recovered, item(font).path.replace('weapons', 'fonts'));
  assert.equal(f.reads.length, 1); assert.equal(f.timers.length, 0);
});
test('timed-out ordinary art falls back once and ignores late platform completion', async () => {
  const f = fixture(), waiting = f.load(png);
  for (let n = 0; n < 3; n++) {
    f.runNextTimer(); await flush();
    if (n < 2) { f.runNextTimer(); await flush(); }
  }
  assert.equal(await waiting, base + png);
  for (const stale of f.packages) { stale.success(); stale.fail(Error('late failure')); }
  await flush(); assert.equal(f.reads.length, 1); assert.equal(f.timers.length, 0);
});
test('successful platform completion clears its watchdog and ignores duplicate callbacks', async () => {
  const f = fixture(), waiting = f.load(png), request = f.packages[0];
  request.success(); request.fail(Error('late failure')); request.success();
  assert.equal(await waiting, item(png).path);
  assert.equal(f.timers.length, 0); assert.equal(f.reads.length, 1);
});

test('feature timing counts shared platform attempts, retries, timeout and late callbacks without claiming network traffic',async()=>{
  const f=fixture(),first=f.load(png),second=f.load(font);
  assert.equal(f.timing.snapshot().phases.platformSubpackage.started,1);
  assert.equal(f.timing.snapshot().reuse.inFlight,1);
  f.runNextTimer();await flush();f.runNextTimer();await flush();
  assert.equal(f.packages.length,2);
  f.packages[0].success();f.packages[0].fail(Error('late private failure'));
  f.packages[1].success();await Promise.all([first,second]);await f.load(png);
  const s=f.timing.snapshot(),p=s.packages[0];
  assert.equal(s.phases.platformSubpackage.started,2);assert.equal(s.phases.platformSubpackage.active,0);
  assert.equal(s.phases.platformSubpackage.failed,1);assert.equal(p.timedOut,1);assert.equal(s.lateCallbacks,2);
  assert.equal(s.reuse.ready,1);assert.equal(p.outcome,'success');assert.match(s.subpackageMeaning,/unknown/);
  assert.doesNotMatch(JSON.stringify(s),/private failure|https:/);
});
