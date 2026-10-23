const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createTiming}=require('./support/wechat-resource-timing.cjs');
const base = 'https://nurse.kylinsit.com/forest-gunner/';
const source = fs.readFileSync(require.resolve('../tools/wechat-map-runtime.cjs'), 'utf8');
function fixture({ failPackage = false, failLocal = false, pendingPackage = false, pendingRead = false } = {}) {
  const files = {}, packages = [], reads = [], warnings = [], requests = [], timers = [], readCallbacks = [];
  let now = 0;
  const timing=createTiming({Date:{now:()=>now}});
  for (const [i, name] of ['forest-map-common', 'forest-map-0', 'forest-map-0-1'].entries()) {
    const remote = `remote/resources/native/00/00000000-0000-0000-0000-00000000000${i}.abcd.png`;
    files[remote] = { package: name, path: `subpackages/${name}/${remote.slice('remote/resources/'.length)}` };
  }
  const module = { exports: {} }, downloader = { handlers: { '.png': (url, options, complete) => {
    reads.push(url); readCallbacks.push(complete); if (pendingRead) return;
    complete(failLocal && url.startsWith('subpackages/') ? Error('bad local image') : null, url);
  } }, register(type, handler) { this.handlers[type] = handler; } };
  vm.runInNewContext(source.replace('__FOREST_GUNNER_MAP_INDEX__', JSON.stringify({ version: 1, base, files })), {
    module, exports: module.exports, console: { warn: (...args) => warnings.push(args) },
    require:name=>{assert.equal(name,'./wechat-resource-timing.js');return timing.exports;},
    Date: { now: () => now },
    setTimeout(callback, delay) { const timer = { callback, at: now + delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    wx: { loadSubpackage(options) { packages.push(options.name); requests.push(options); if (pendingPackage) return; if (failPackage) options.fail(Error('offline')); else options.success(); } },
  });
  const cc = { assetManager: { downloader } };
  assert.equal(module.exports.installMapResources(cc), true, 'generated common/stage/split names install');
  assert.equal(module.exports.installMapResources(cc), true, 'installation is idempotent');
  const load = url => new Promise((resolve, reject) => downloader.handlers['.png'](url, {}, (error, data) => error ? reject(error) : resolve(data)));
  return { files, packages, reads, warnings, load, requests, timers, readCallbacks, timing:timing.api, advance: ms => { now += ms; },
    runNextTimer() { timers.sort((a,b) => a.at-b.at); const timer = timers.shift(); assert.ok(timer, 'pending map requests must have a watchdog'); now = timer.at; timer.callback(); } };
}

test('common and stage packages load once and untouched images retain their original downloader', async () => {
  const h = fixture(), paths = Object.keys(h.files);
  const results = await Promise.all(paths.flatMap(path => [h.load(base + path), h.load(base + path + '?cache=1')]));
  assert.deepEqual(h.packages, ['forest-map-common', 'forest-map-0', 'forest-map-0-1']);
  assert.ok(results.every(path => path.startsWith('subpackages/')));
  const other = base + 'remote/other.png'; assert.equal(await h.load(other), other);
});

test('failed subpackages or damaged local images fall back to the server', async () => {
  for (const options of [{ failPackage: true }, { failLocal: true }]) {
    const h = fixture(options), url = base + Object.keys(h.files)[0];
    assert.equal(await h.load(url), url); assert.equal(await h.load(url), url);
    assert.equal(h.packages.length, 1);
    if (options.failPackage) assert.equal(h.warnings.length, 1);
  }
});

test('a stalled map package releases shared engine requests, ignores late callbacks and recovers', async () => {
  const h = fixture({ pendingPackage: true }), url = base + Object.keys(h.files)[0];
  let completed = 0;
  const requests = [h.load(url), h.load(url + '?cache=1')].map(request => request.then(value => { completed++; return value; }));
  assert.equal(h.packages.length, 1); assert.equal(completed, 0);
  h.runNextTimer();
  assert.deepEqual(await Promise.all(requests), [url, url + '?cache=1']);
  assert.equal(completed, 2, 'both downloader slots are released through the existing CDN fallback');
  assert.equal(h.warnings.length, 1);
  h.requests[0].success(); h.requests[0].fail(Error('late failure'));
  await new Promise(setImmediate); assert.equal(h.reads.length, 2);
  await h.load(url); assert.equal(h.packages.length, 1, 'failed package requests share a cooldown');
  h.advance(60000);
  const recovered = h.load(url); assert.equal(h.packages.length, 2);
  h.requests[1].success(); assert.equal(await recovered, h.files[Object.keys(h.files)[0]].path);
  assert.equal(h.timers.length, 0);
  await h.load(url); assert.equal(h.packages.length, 2, 'successful package stays cached');
});

test('a missing local or CDN image callback cannot hold the downloader beyond its deadline', async () => {
  for (const failPackage of [false, true]) {
    const h=fixture({failPackage,pendingRead:true}),url=base+Object.keys(h.files)[0];
    const failed=assert.rejects(h.load(url),/map image timed out/);
    await new Promise(setImmediate);assert.equal(h.reads.length,1);
    h.runNextTimer();await failed;assert.equal(h.timers.length,0);
    h.readCallbacks[0](null,'late image');h.readCallbacks[0](Error('late error'));
    assert.equal(h.reads.length,1,'a timed-out local read cannot launch another fallback');
  }
});

test('map timing retains failure cooldown, late callbacks and later successful recovery independently',async()=>{
  const h=fixture({pendingPackage:true}),url=base+Object.keys(h.files)[0];
  const first=h.load(url),shared=h.load(url);h.advance(15000);h.runNextTimer();await Promise.all([first,shared]);
  await h.load(url);h.requests[0].success();h.advance(60000);
  const next=h.load(url);h.advance(30);h.requests[1].success();await next;await h.load(url);
  const s=h.timing.snapshot();assert.equal(s.phases.platformSubpackage.started,2);
  assert.equal(s.phases.platformSubpackage.failed,1);assert.equal(s.phases.platformSubpackage.active,0);
  assert.equal(s.phases.platformSubpackage.totalMs,15030);assert.equal(s.lateCallbacks,1);
  assert.equal(s.reuse.inFlight,1);assert.equal(s.reuse.failed,1);assert.equal(s.reuse.ready,1);
  assert.equal(s.packages[0].timedOut,1);assert.equal(s.packages[0].outcome,'success');
});
