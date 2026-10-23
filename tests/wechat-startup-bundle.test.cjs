const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { projectPath, fixturePath } = require('./support/paths.cjs');
const {createTiming}=require('./support/wechat-resource-timing.cjs');
const { packageStartupMetadata, installStartupErrorHandler } = require('../tools/wechat-startup-package.cjs');
const { STARTUP_METADATA_PACKAGE } = require('../tools/wechat-startup-runtime.cjs');

const BASE = 'https://nurse.kylinsit.com/forest-gunner/';
const VERSION = '8de24';
const CONFIG_PATH = 'remote/resources/config.' + VERSION + '.json';
const CONFIG_URL = BASE + CONFIG_PATH;
const SOURCE = fs.readFileSync(projectPath('tools/wechat-startup-runtime.cjs'), 'utf8');
const ADAPTER = fs.readFileSync(fixturePath('wechat-3.8.8-asset-adapter.cjs'), 'utf8');

function cacheEntries() {
  const values = new Map();
  return { get: key => values.get(key), add: (key, value) => values.set(key, value),
    remove: key => values.delete(key) };
}

function fixture(options = {}) {
  const events = { downloads: [], reads: [], writes: [], scripts: [], folders: [], metadataReads: [], packages: [] };
  const disk = new Map();
  const cache = { cacheDir: '/wx-user/gamecaches', cachedFiles: cacheEntries(), tempFiles: cacheEntries(),
    makeBundleFolder(name) { events.folders.push(name); }, updateLastTime() {}, removeCache() {}, init() {} };
  const downloader = { handlers: {}, remoteBundles: ['resources'], remoteServerAddress: BASE,
    bundleVers: { resources: VERSION }, register(extension, handler) {
      if (typeof extension === 'string') this.handlers[extension] = handler;
      else Object.assign(this.handlers, extension);
    } };
  const cc = { assetManager: { downloader, parser: { register() {} }, cacheManager: cache,
    presets: { scene: {} }, transformPipeline: { append() {} }, init() {} },
    path: { basename: value => value.split('/').pop() }, sys: { platform: 'wechatgame', Platform: {} },
    settings: { querySettings: () => options.subpackages || [] } };
  const fsUtils = { fs: {}, getUserDataPath: () => '/wx-user',
    downloadFile(url, _path, _header, _progress, complete) {
      events.downloads.push(url);
      queueMicrotask(() => complete(new Error('CDN unavailable: ' + url), null));
    },
    readJson(file, complete) {
      events.reads.push(file);
      queueMicrotask(() => {
        let error = null, data = null;
        try { data = JSON.parse(disk.get(file)); } catch (failure) { error = failure; }
        complete(error, data);
      });
    },
    loadSubpackage(name, _progress, complete) {
      events.scripts.push('subpackage:' + name);
      queueMicrotask(() => complete(null));
    }, exists() {} };
  const adapterModule = { exports: {} };
  vm.runInNewContext(ADAPTER, { module: adapterModule, cc, window: { fsUtils }, console });
  adapterModule.exports(name => {
    if (name === './cache-manager') return cache;
    events.scripts.push(name);
    if (options.scriptError) throw options.scriptError;
  }, { exports: {} }, {});
  if (options.subpackages) cc.assetManager.init();
  const config = options.rawConfig === undefined ? JSON.stringify({ name: 'resources', paths: {} }) : options.rawConfig;
  const metadata = { version: 1, base: BASE, files: options.files || { [CONFIG_PATH]: config } };
  const compressed = zlib.deflateSync(Buffer.from(JSON.stringify(metadata), 'ascii'));
  const runtimeModule = { exports: {} };
  const timing=createTiming();
  vm.runInNewContext(SOURCE, { module: runtimeModule, queueMicrotask,
    setTimeout: options.timers ? options.timers.setTimeout : setTimeout,
    clearTimeout: options.timers ? options.timers.clearTimeout : clearTimeout,
    require(name) { return name==='./wechat-resource-timing.js'?timing.exports:require(projectPath('tools/vendor/startup-inflate.cjs')); },
    wx: { loadSubpackage: options.subpackageUnavailable ? undefined : request => {
      events.packages.push(request);
      if (options.loadSubpackage) return options.loadSubpackage(request);
      queueMicrotask(request.success);
    }, getFileSystemManager: () => ({
      readFileSync(file) {
        events.metadataReads.push(file);
        return compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
      },
      writeFileSync(file, source, encoding) {
        events.writes.push({ file, encoding });
        if (options.writeError) throw options.writeError;
        disk.set(file, source);
      },
    }) },
  });
  return { cc, downloader, cache, disk, events, timing:timing.api, timingScope:timing.scope,
    prepare: () => runtimeModule.exports.prepareStartupMetadata(),
    install: () => runtimeModule.exports.installStartupMetadata(cc),
    load(name = 'resources', requestOptions = {}) {
      return new Promise((resolve, reject) => downloader.handlers.bundle(name, requestOptions,
        (error, data) => error ? reject(error) : resolve(data)));
    } };
}

test('the real WeChat bundle adapter bypasses the registered JSON handler', async () => {
  const f = fixture();
  let calls = 0;
  f.downloader.register('.json', (_url, _options, complete) => { calls++; complete(null, {}); });
  await assert.rejects(f.load(), /CDN unavailable/);
  assert.equal(calls, 0);
  assert.deepEqual(f.events.downloads, [CONFIG_URL]);
});

test('packaged config starts the real bundle adapter offline while preserving its script and base', async () => {
  const f = fixture(), stats = f.install();
  const config = await f.load();
  assert.equal(config.name, 'resources');
  assert.equal(config.base, BASE + 'remote/resources/');
  assert.equal(stats.bundleInstalled, true);
  assert.equal(stats.bundleHits, 1);
  assert.deepEqual(f.events.downloads, []);
  assert.deepEqual(f.events.scripts, ['./src/bundle-scripts/resources/index.8de24.js']);
  assert.deepEqual(f.events.folders, ['resources']);
  assert.equal(f.events.writes[0].encoding, 'utf8');
  assert.equal(f.events.reads[0], f.cache.tempFiles.get(CONFIG_URL));
  assert.equal(stats.hits, 0); // The adapter still uses its own JSON reader.
});

test('repeated installs and loads retain the adapter cache entry and only write once', async () => {
  const f = fixture(), stats = f.install();
  assert.equal(f.install(), stats);
  const [first, second] = await Promise.all([f.load(), f.load()]);
  first.paths.changed = true;
  assert.equal(second.paths.changed, undefined);
  assert.equal(f.events.writes.length, 1);
  assert.equal(stats.bundleHits, 1);
  assert.deepEqual(f.events.downloads, []);
});

test('existing temporary and persistent cache entries are preserved', async () => {
  for (const persistent of [false, true]) {
    const f = fixture();
    const existing = '/wx-user/existing-config.json';
    f.disk.set(existing, '{"name":"resources","existing":true}');
    (persistent ? f.cache.cachedFiles : f.cache.tempFiles).add(CONFIG_URL, persistent ? { url: existing } : existing);
    const stats = f.install(), result = await f.load();
    assert.equal(result.existing, true);
    assert.equal(stats.bundleHits, 0);
    assert.equal(f.events.writes.length, 0);
    assert.deepEqual(f.events.reads, [existing]);
  }
});

test('disk failure and malformed config preserve the original network fallback', async () => {
  for (const options of [{ writeError: new Error('disk full') }, { rawConfig: '{bad' }, { rawConfig: 'null' }]) {
    const f = fixture(options), stats = f.install();
    await assert.rejects(f.load(), /CDN unavailable/);
    assert.deepEqual(f.events.downloads, [CONFIG_URL]);
    assert.equal(f.cache.tempFiles.get(CONFIG_URL), undefined);
    assert.equal(stats.bundleFallbacks, 1);
  }
});

test('unknown or missing versions, other servers and non-remote bundles keep original routing', async () => {
  const cases = [
    { change: f => { f.downloader.bundleVers = {}; } },
    { request: { version: 'abc123' } },
    { change: f => { f.downloader.remoteServerAddress = 'https://other.example/'; } },
    { change: f => { f.downloader.remoteBundles = []; } },
    { name: 'main' },
    { name: BASE + 'remote/resources' },
    { change: f => { delete f.cache.tempFiles.add; } },
  ];
  for (const item of cases) {
    const f = fixture();
    item.change && item.change(f);
    f.install();
    await assert.rejects(f.load(item.name, item.request));
    assert.equal(f.events.writes.length, 0);
  }
});

test('an explicit packaged version is used without guessing from a different default', async () => {
  const f = fixture({ files: { 'remote/resources/config.abc123.json': '{"name":"resources","explicit":true}' } });
  f.install();
  const result = await f.load('resources', { version: 'abc123' });
  assert.equal(result.explicit, true);
  assert.deepEqual(f.events.scripts, ['./src/bundle-scripts/resources/index.abc123.js']);
  assert.deepEqual(f.events.downloads, []);
});

test('adapter subpackage configuration retains its original local config path', async () => {
  const f = fixture({ subpackages: ['resources'] });
  f.disk.set('subpackages/resources/config.8de24.json', '{"name":"resources","subpackage":true}');
  f.install();
  const result = await f.load();
  assert.equal(result.subpackage, true);
  assert.equal(result.base, 'subpackages/resources/');
  assert.equal(f.events.writes.length, 0);
  assert.deepEqual(f.events.downloads, []);
});

test('adapter script and callback exceptions are never swallowed or invoked twice', async () => {
  const failure = new Error('bundle script failed'), f = fixture({ scriptError: failure });
  f.install();
  await assert.rejects(f.load(), error => error === failure);
  assert.deepEqual(f.events.downloads, []);
  const direct = fixture();
  direct.downloader.handlers.bundle = (_url, _options, complete) => complete(null, {});
  direct.install();
  let count = 0;
  assert.throws(() => direct.downloader.handlers.bundle('resources', {}, () => { count++; throw failure; }), error => error === failure);
  assert.equal(count, 1);
});

function fakeTimers() {
  const pending = new Map(), delays = [], cleared = [];
  let nextId = 0;
  return { pending, delays, cleared,
    setTimeout(callback, delay) {
      const timer = ++nextId;
      pending.set(timer, callback);
      delays.push(delay);
      return timer;
    },
    clearTimeout(timer) { cleared.push(timer); pending.delete(timer); },
    fire() { for (const callback of [...pending.values()]) callback(); },
  };
}

test('earliest metadata package diagnostics survive timeout, shared retry and late callbacks before Cocos initialization',async()=>{
  const timers=fakeTimers(),f=fixture({timers,loadSubpackage(){}});
  const first=f.prepare(),shared=f.prepare();assert.equal(first,shared);
  assert.equal(f.timingScope.__forestGunnerLoading.snapshot().startup.phase,'platform-loader');
  assert.equal(f.timing.snapshot().phases.platformSubpackage.active,1);
  timers.fire();assert.equal(await first,false);assert.equal(await shared,false);
  const retry=f.prepare();f.events.packages[0].success();f.events.packages[0].fail(Error('late'));
  assert.equal(f.timing.snapshot().phases.platformSubpackage.active,1,'late callbacks cannot finish a new attempt');
  f.events.packages[1].success();assert.equal(await retry,true);assert.equal(await f.prepare(),true);
  const s=f.timing.snapshot();assert.equal(s.phases.platformSubpackage.started,2);assert.equal(s.phases.platformSubpackage.active,0);
  assert.equal(s.phases.platformSubpackage.failed,1);assert.equal(s.packages[0].timedOut,1);assert.equal(s.lateCallbacks,2);
  assert.equal(s.reuse.inFlight,1);assert.equal(s.reuse.ready,1);assert.equal(s.packages[0].outcome,'success');
  assert.equal(f.install().installed,true);assert.equal(f.timing.snapshot().phases.metadataInflate.started,1);
});

test('metadata preparation shares one official subpackage request and never reads before success', async () => {
  const timers = fakeTimers(), context = fixture({ timers, loadSubpackage() {} });
  const first = context.prepare(), concurrent = context.prepare();
  assert.equal(first, concurrent);
  assert.equal(context.events.packages.length, 1);
  assert.equal(context.events.packages[0].name, STARTUP_METADATA_PACKAGE.name);
  assert.equal(context.install().installed, false);
  assert.deepEqual(context.events.metadataReads, []);
  context.events.packages[0].success();
  assert.equal(await first, true);
  assert.equal(context.prepare(), first);
  assert.equal(timers.pending.size, 0);
  assert.equal(timers.cleared.length, 1);
  const stats = context.install();
  assert.deepEqual(context.events.metadataReads, [STARTUP_METADATA_PACKAGE.path]);
  assert.equal((await context.load()).name, 'resources');
  assert.equal(stats.bundleHits, 1);
  assert.deepEqual(context.events.downloads, []);
});

test('subpackage failure clears the shared request and preserves CDN fallback before explicit recovery', async () => {
  const timers = fakeTimers(), context = fixture({ timers, loadSubpackage() {} });
  const first = context.prepare();
  context.events.packages[0].fail({ errMsg: 'download failed' });
  assert.equal(await first, false);
  assert.equal(timers.pending.size, 0);
  assert.equal(context.install().reason, 'metadata-unavailable');
  await assert.rejects(context.load(), /CDN unavailable/);
  assert.deepEqual(context.events.downloads, [CONFIG_URL]);
  assert.deepEqual(context.events.metadataReads, []);
  const retried = context.prepare();
  assert.notEqual(retried, first);
  assert.equal(context.events.packages.length, 2);
  context.events.packages[1].success();
  assert.equal(await retried, true);
  assert.equal(context.install().installed, true);
  assert.equal((await context.load()).name, 'resources');
});

test('missing APIs and synchronous subpackage errors fall back without retaining timers or rejected promises', async () => {
  for (const options of [{ subpackageUnavailable: true }, { loadSubpackage() { throw new Error('host failure'); } }]) {
    const timers = fakeTimers(), context = fixture({ ...options, timers });
    const first = context.prepare();
    assert.equal(await first, false);
    assert.equal(timers.pending.size, 0);
    assert.equal(context.install().installed, false);
    assert.deepEqual(context.events.metadataReads, []);
    const retry = context.prepare();
    assert.notEqual(retry, first);
    assert.equal(await retry, false);
    await assert.rejects(context.load(), /CDN unavailable/);
  }
});

test('a silent subpackage times out, ignores late callbacks and permits a clean retry', async () => {
  const timers = fakeTimers(), context = fixture({ timers, loadSubpackage() {} });
  const request = context.prepare();
  assert.deepEqual(timers.delays, [120000]);
  timers.fire();
  assert.equal(await request, false);
  assert.equal(timers.pending.size, 0);
  const retry = context.prepare();
  context.events.packages[0].success();
  context.events.packages[0].fail();
  assert.equal(context.install().installed, false);
  assert.deepEqual(context.events.metadataReads, []);
  context.events.packages[1].success();
  context.events.packages[1].fail();
  assert.equal(await retry, true);
  assert.equal(timers.pending.size, 0);
  assert.equal(context.install().installed, true);
  assert.deepEqual(context.events.metadataReads, [STARTUP_METADATA_PACKAGE.path]);
});

const ENTRY = `/* FOREST_GUNNER_ENV_START */
globalThis.__FOREST_GUNNER_ENV__ = {"environment":"production"};
/* FOREST_GUNNER_ENV_END */
globalThis.startup = Promise.resolve(application).then((application) => {
  return onApplicationCreated(application);
}).catch((err) => { console.error(err); });
function onApplicationCreated(application) {
  return Promise.resolve(engine).then((cc) => {
    require('./engine-adapter.abc123.js');
    return application.init(cc);
  }).then(() => application.start());
}
`;

function packagedFixture(context) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gunner-startup-package-'));
  context.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('gunner-startup-package-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const input = path.join(temporary, 'input'), code = path.join(temporary, 'code');
  const write = (root, relative, data) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  };
  const sources = { [CONFIG_PATH]: '{"name":"resources","paths":{}}',
    'remote/resources/import/00/00112233-4455-6677-8899-aabbccddeeff.abc123.json': '{"message":"森林 🎮","nested":[1,2]}' };
  for (const [file, source] of Object.entries(sources)) write(input, file, source);
  write(code, 'game.js', ENTRY);
  return { input, code, temporary, write, sources };
}

test('packaging keeps only the bundle index at boot and routes every intact import to a lazy package', context => {
  const fixture = packagedFixture(context);
  const result = packageStartupMetadata(fixture.input, fixture.code, BASE);
  const data = fs.readFileSync(path.join(fixture.code, result.path));
  const metadata = JSON.parse(zlib.inflateSync(data).toString('ascii'));
  assert.equal(metadata.version, 2);
  assert.deepEqual(metadata.files, { [CONFIG_PATH]: fixture.sources[CONFIG_PATH] });
  const reconstructed = { ...metadata.files };
  for (const group of Object.values(metadata.groups)) {
    const payload = JSON.parse(zlib.inflateSync(fs.readFileSync(path.join(fixture.code, group.path))).toString('ascii'));
    for (const [file, source] of Object.entries(payload.files)) {
      assert.equal(metadata.routes[file], group.name);
      assert.equal(Object.hasOwn(reconstructed, file), false);
      reconstructed[file] = source;
    }
  }
  assert.deepEqual(reconstructed, fixture.sources);
  assert.equal(result.packages.length, 2);
  assert.equal(result.files, Object.keys(fixture.sources).length);
  assert.equal(result.sourceBytes, Object.values(fixture.sources).reduce((total, source) => total + Buffer.byteLength(source), 0));
  assert.equal(result.compressedBytes, data.length);
  assert.equal(result.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  assert.equal(result.package.name, STARTUP_METADATA_PACKAGE.name);
  assert.equal(result.package.root, STARTUP_METADATA_PACKAGE.root);
  assert.equal(result.package.bytes, data.length + fs.statSync(path.join(fixture.code, result.package.root, 'game.js')).size);
  assert.ok(result.package.bytes <= 4 * 1024 * 1024);
  assert.equal(fs.existsSync(path.join(fixture.code, 'startup-metadata.bin')), false);
  for (const [file, source] of Object.entries(fixture.sources)) assert.equal(fs.readFileSync(path.join(fixture.input, file), 'utf8'), source);
  assert.equal(fs.readFileSync(path.join(fixture.code, 'startup-metadata.js'), 'utf8'), SOURCE);
});

test('the generated game entry awaits metadata and installs every resource hook before application init', async context => {
  const fixture = packagedFixture(context), order = [];
  packageStartupMetadata(fixture.input, fixture.code, BASE);
  const entryPath = path.join(fixture.code, 'game.js');
  const marker = "require('./startup-metadata').installStartupMetadata(cc);";
  fs.writeFileSync(entryPath, fs.readFileSync(entryPath, 'utf8').replace(marker, marker
    + "\nrequire('./startup-features').installFeatureResources(cc);\nrequire('./startup-maps').installMapResources(cc);"));
  installStartupErrorHandler(fixture.code);
  const runtime = fixtureRuntime(order), scope = {
    engine: runtime.cc,
    application: { async init(cc) {
      order.push('init');
      assert.equal(cc, runtime.cc);
      assert.equal((await runtime.load()).name, 'resources');
    }, start() { order.push('start'); } },
    require: runtime.require,
  };
  vm.runInNewContext(fs.readFileSync(entryPath, 'utf8'), scope);
  await new Promise(setImmediate);
  assert.deepEqual(order, ['subpackage', 'adapter']);
  assert.deepEqual(runtime.events.metadataReads, []);
  runtime.events.packages[0].success();
  await scope.startup;
  assert.deepEqual(order, ['subpackage', 'adapter', 'metadata', 'features', 'maps', 'init', 'start']);
  assert.deepEqual(runtime.events.metadataReads, [STARTUP_METADATA_PACKAGE.path]);
  assert.deepEqual(runtime.events.downloads, []);
});

function fixtureRuntime(order, options = {}) {
  const runtime = fixture({ ...options, loadSubpackage() { order.push('subpackage'); } });
  return { ...runtime, require(name) {
    if (name === './engine-adapter.abc123.js') { order.push('adapter'); return {}; }
    if (name === './startup-metadata') return {
      prepareStartupMetadata: runtime.prepare,
      installStartupMetadata(cc) { assert.equal(cc, runtime.cc); order.push('metadata'); return runtime.install(); },
    };
    if (name === './startup-features') return { installFeatureResources() { order.push('features'); } };
    if (name === './startup-maps') return { installMapResources() { order.push('maps'); } };
    if (name === './startup-errors') return { reportStartupError(error) { order.push('error:' + error.message); } };
    throw new Error('Unexpected entry require: ' + name);
  } };
}

test('subpackage failure continues into normal startup and its CDN rejection reaches the existing error hook', async context => {
  const fixture = packagedFixture(context), order = [], runtime = fixtureRuntime(order);
  packageStartupMetadata(fixture.input, fixture.code, BASE);
  installStartupErrorHandler(fixture.code);
  const scope = { engine: runtime.cc, require: runtime.require,
    application: { init() { order.push('init'); return runtime.load(); }, start() { order.push('start'); } } };
  vm.runInNewContext(fs.readFileSync(path.join(fixture.code, 'game.js'), 'utf8'), scope);
  await new Promise(setImmediate);
  runtime.events.packages[0].fail({ errMsg: 'offline' });
  await scope.startup;
  assert.deepEqual(order, ['subpackage', 'adapter', 'metadata', 'init', 'error:CDN unavailable: ' + CONFIG_URL]);
  assert.deepEqual(runtime.events.metadataReads, []);
});

test('packaging rejects oversized metadata and ambiguous startup order without changing the entry', context => {
  const fixture = packagedFixture(context);
  fixture.write(fixture.input, Object.keys(fixture.sources)[1], JSON.stringify({ data: crypto.randomBytes(5 * 1024 * 1024).toString('base64') }));
  assert.throws(() => packageStartupMetadata(fixture.input, fixture.code, BASE), /metadata subpackage exceeds 4 MiB/);
  assert.equal(fs.existsSync(path.join(fixture.code, STARTUP_METADATA_PACKAGE.root)), false);
  assert.equal(fs.readFileSync(path.join(fixture.code, 'game.js'), 'utf8'), ENTRY);
  fixture.write(fixture.input, Object.keys(fixture.sources)[1], '{}');
  for (const entry of [ENTRY.replace('return application.init(cc);', ''), ENTRY + 'return application.init(cc);',
    ENTRY.replace("require('./engine-adapter.abc123.js');\n    return application.init(cc);",
      "return application.init(cc);\n    require('./engine-adapter.abc123.js');")]) {
    fixture.write(fixture.code, 'game.js', entry);
    assert.throws(() => packageStartupMetadata(fixture.input, fixture.code, BASE), /ambiguous metadata hook/);
    assert.equal(fs.readFileSync(path.join(fixture.code, 'game.js'), 'utf8'), entry);
  }
});

test('the release manifest, include list and game declaration agree on metadata subpackage accounting', context => {
  const fixture = packagedFixture(context), destination = path.join(fixture.temporary, 'release');
  fixture.write(fixture.input, 'game.js', ENTRY);
  fixture.write(fixture.input, 'game.json', JSON.stringify({ deviceOrientation: 'landscape' }));
  fixture.write(fixture.input, 'project.config.json', JSON.stringify({ appid: 'wx3dd63318911f5012', compileType: 'game' }));
  fixture.write(fixture.input, 'first-screen.abc123.js', 'let useLogo = false; let useDefaultLogo = false;');
  fixture.write(fixture.input, 'cocos-startup.LICENSE.abc123.txt', 'license fixture');
  const hashedImage = 'remote/resources/native/aa/aa112233-4455-6677-8899-aabbccddeeff.abcd1.png';
  const hashedBytes = Buffer.from('Creator hashed image bytes: packaging must not rewrite this file');
  fixture.write(fixture.input, hashedImage, hashedBytes);
  fixture.write(fixture.input, 'src/settings.abc123.json', JSON.stringify({ engine: { debug: false }, splashScreen: { totalTime: 0 },
    assets: { server: BASE, remoteBundles: ['resources'], subpackages: [], bundleVers: { resources: VERSION } } }));
  const packageStub = (name, hook) => (_input, code) => {
    const root = 'subpackages/' + name + '/';
    fixture.write(code, root + 'game.js', "'use strict';\n");
    const entryPath = path.join(code, 'game.js'), marker = "require('./startup-metadata').installStartupMetadata(cc);";
    const entry = fs.readFileSync(entryPath, 'utf8');
    assert.equal(entry.split(marker).length, 2);
    fs.writeFileSync(entryPath, entry.replace(marker, marker + '\n' + hook));
    return { packages: [{ name, root, bytes: 14, files: 0 }] };
  };
  vm.runInNewContext(fs.readFileSync(projectPath('tools/package-wechat-release.cjs'), 'utf8'), {
    __dirname: projectPath('tools'), Buffer,
    process: { argv: ['node', 'package-wechat-release.cjs', fixture.input, destination, '0.1.12'], env: {} },
    console: { log() {} },
    require(name) {
      if (name === 'node:child_process') return { spawnSync(_command, args) {
        assert.equal(args.includes('--apply'), false, 'packaging must run the PNG encoder in read-only mode after Creator hashes exist');
        fs.writeFileSync(args[args.indexOf('--report') + 1], JSON.stringify({ applied: false, before: 100, after: 80, saved: 20, rgbaPixelsEqual: true, colorProfileEqual: true }));
        return { status: 0 };
      } };
      if (name === './wechat-map-package.cjs') return { packageMapResources: packageStub('forest-map-common', "require('./startup-maps').installMapResources(cc);") };
      if (name === './wechat-feature-package.cjs') return { packageFeatureResources: packageStub('forest-ui-fonts-0', "require('./startup-features').installFeatureResources(cc);") };
      if (name === './wechat-startup-package.cjs') return { packageStartupMetadata, installStartupErrorHandler };
      return require(name);
    },
  });
  const outputCode = path.join(destination, 'wechatgame');
  const report = JSON.parse(fs.readFileSync(path.join(destination, 'release-manifest.json'), 'utf8'));
  const game = JSON.parse(fs.readFileSync(path.join(outputCode, 'game.json'), 'utf8'));
  const project = JSON.parse(fs.readFileSync(path.join(outputCode, 'project.config.json'), 'utf8'));
  assert.deepEqual(game.subpackages[0], { name: STARTUP_METADATA_PACKAGE.name, root: STARTUP_METADATA_PACKAGE.root });
  assert.equal(game.subpackages.length, 4);
  for (const item of report.startupMetadata.packages) {
    assert.ok(project.packOptions.include.some(include => include.value === (item.path || report.startupMetadata.path)));
  }
  assert.ok(project.packOptions.include.some(item => item.type === 'file' && item.value === STARTUP_METADATA_PACKAGE.path));
  assert.equal(project.packOptions.include.some(item => item.value === 'startup-metadata.bin'), false);
  assert.equal(report.startupMetadata.path, STARTUP_METADATA_PACKAGE.path);
  assert.deepEqual(report.pngOptimization, { applied: false, before: 100, after: 100, saved: 0, potentialSaved: 20,
    rgbaPixelsEqual: true, colorProfileEqual: true });
  assert.deepEqual(fs.readFileSync(path.join(fixture.input, hashedImage)), hashedBytes);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'server', hashedImage)), hashedBytes);
  assert.deepEqual(report.subpackageBudgets.map(({ name, root }) => ({ name, root })), game.subpackages);
  for (const budget of report.subpackageBudgets) {
    assert.equal(budget.bytes, report.codeFiles.filter(file => file.path.startsWith(budget.root)).reduce((total, file) => total + file.bytes, 0));
    assert.ok(budget.bytes <= budget.limitBytes);
  }
  assert.equal(report.startupMetadata.package.bytes, report.subpackageBudgets[0].bytes);
  assert.equal(report.codeBytes, report.mainPackageBytes + report.subpackageBudgets.reduce((total, item) => total + item.bytes, 0));
  assert.equal(report.codeFiles.some(file => file.path.startsWith('remote/')), false);
  assert.equal(game.networkTimeout.downloadFile, 120000);
  assert.match(fs.readFileSync(path.join(outputCode, 'game.js'), 'utf8'), /__FOREST_GUNNER_RELEASE__ = "0\.1\.12"/);
  assert.ok(fs.readFileSync(path.join(outputCode, 'game.js'), 'utf8').startsWith('globalThis.__FOREST_GUNNER_BOOT_STARTED_AT__ = Date.now();\n'));
});
