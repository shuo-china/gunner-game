const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createTiming } = require('./support/wechat-resource-timing.cjs');
const { packageStartupMetadata } = require('../tools/wechat-startup-package.cjs');

const BASE = 'https://nurse.kylinsit.com/forest-gunner/';
const configPath = 'remote/resources/config.abcde.json';
const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'];
const shared = '55555555-5555-5555-5555-555555555555';
const importPath = uuid => `remote/resources/import/${uuid.slice(0, 2)}/${uuid}.abcde.json`;

async function fixture(context, customize = () => {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gunner-lazy-metadata-'));
  context.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('gunner-lazy-metadata-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const input = path.join(temporary, 'input'), code = path.join(temporary, 'code');
  const write = (root, file, text) => {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, text);
  };
  const config = { types: ['cc.JsonAsset'], uuids: [...ids], paths: { 0: ['art/weapon-system/config', 0], 1: ['art/fish-system/config', 0],
    2: ['art/weapon-system/icons', 0], 3: ['art/fish-system/icons', 0] }, packs: { [shared]: [2, 3] } };
  const font = color => ({ pages: ['art/fonts/' + color], glyphs: {
    65: { advance: 16, width: 17, bearingX: 1, variants: { [color]: { page: 0, rect: [1, 2, 3, 4] } } },
    32: { advance: 10, empty: true },
  }, pointSize: 90, advances: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [i, i / 5])),
  source: { note: '森林 🎮' } });
  const expected = {
    [importPath(ids[0])]: { feature: 'weapon', nested: { count: 1 } },
    [importPath(ids[1])]: { feature: 'fish', bitmapFonts: { white: font('white'), red: font('red'), green: font('green') } },
    [importPath(shared)]: [1, ['full-pack-header'], {}, ['strings'], {}, [{ sprite: 'weapon' }, { sprite: 'fish' }]],
  };
  customize(config, expected);
  write(input, configPath, JSON.stringify(config));
  for (const [file, value] of Object.entries(expected)) write(input, file, JSON.stringify(value));
  write(code, 'game.js', "require('./engine-adapter.js'); return application.init(cc);");
  const report = packageStartupMetadata(input, code, BASE);
  const readPayload = file => JSON.parse(zlib.inflateSync(fs.readFileSync(path.join(code, file))).toString('ascii'));
  const index = readPayload(report.path), reads = [], packages = [], fallbacks = [], timers = new Map(), damaged = new Map();
  let now = 0, timerId = 0;
  const timing = createTiming({ Date: { now: () => now } });
  const runtime = { exports: {} };
  const downloader = { handlers: { '.json'(url, options, complete) {
    fallbacks.push({ url, options, receiver: this }); complete(null, { fallback: true });
  } }, register(extension, handler) { this.handlers[extension] = handler; } };
  const cc = { assetManager: { downloader } };
  vm.runInNewContext(fs.readFileSync(path.join(code, 'startup-metadata.js'), 'utf8'), {
    module: runtime, queueMicrotask, Date: { now: () => now },
    require: name => name === './wechat-resource-timing.js' ? timing.exports
      : require('../tools/vendor/startup-inflate.cjs'),
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    wx: { loadSubpackage(request) { packages.push(request); }, getFileSystemManager() { return {
      readFileSync(file) {
        reads.push(file);
        const buffer = damaged.get(file) || fs.readFileSync(path.join(code, file));
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      },
    }; } },
  });
  const preparing = runtime.exports.prepareStartupMetadata();
  packages[0].success(); assert.equal(await preparing, true);
  const stats = runtime.exports.installStartupMetadata(cc);
  assert.equal(stats.installed, true);
  const load = (file, options = {}) => new Promise((resolve, reject) => downloader.handlers['.json'](BASE + file, options,
    (error, data) => error ? reject(error) : resolve(data)));
  return { report, index, expected, input, code, reads, packages, fallbacks, stats, readPayload, damaged, load, cc, timing,
    advance(ms = 2001) { now += ms; },
    timeout() { const [id, timer] = Array.from(timers).sort(([, a], [, b]) => a.at - b.at)[0]; timers.delete(id); now = timer.at; timer.callback(); },
    timers, downloader };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('required core and starter weapon metadata share a deterministic bounded package without pulling locked categories', async context => {
  const indexId = '66666666-6666-6666-6666-666666666666', criticalId = '77777777-7777-7777-7777-777777777777';
  const starterId = '88888888-8888-8888-8888-888888888888', lockedId = '99999999-9999-9999-9999-999999999999';
  const authoringId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const customize = (config, expected) => {
    config.paths[0][0] = 'art/catalog'; expected[importPath(ids[0])] = { filler: 'a'.repeat(600 * 1024) };
    config.paths[1][0] = 'art/hud/config'; expected[importPath(ids[1])] = { filler: 'b'.repeat(600 * 1024) };
    config.uuids.push(indexId, criticalId, starterId, lockedId, authoringId);
    config.paths[4] = ['art/weapon-runtime/index', 0];
    config.paths[5] = ['art/weapon-system/critical/config', 0];
    // Derive the always-loaded category from weapon 0, including future changes
    // to the initial weapon; never hard-code archery in the package policy.
    config.paths[6] = ['art/weapon-runtime/projectiles/staff', 0];
    config.paths[7] = ['art/weapon-runtime/projectiles/cannon', 0];
    config.paths[8] = ['art/weapon-system/visuals', 0];
    expected[importPath(indexId)] = { weapons: [{ id: 0, projectileSkin: 'starter' }, { id: 1, projectileSkin: 'shell' }],
      projectileGroups: { starter: 'art/weapon-runtime/projectiles/staff', shell: 'art/weapon-runtime/projectiles/cannon' } };
    expected[importPath(criticalId)] = { glyphs: { 0: { path: 'number/glyph' } } };
    expected[importPath(starterId)] = { projectile: 'starter' };
    expected[importPath(lockedId)] = { projectile: 'locked' };
    expected[importPath(authoringId)] = { authoring: true };
  };
  const f = await fixture(context, customize), again = await fixture(context, (config, expected) => {
    customize(config, expected);
    // Directory insertion order must not change routes, package names or bytes.
    const reversed = Object.entries(expected).reverse();
    for (const file of Object.keys(expected)) delete expected[file];
    for (const [file, value] of reversed) expected[file] = value;
  });
  const required = [ids[0], ids[1], indexId, criticalId, starterId].map(importPath);
  const groupName = f.index.routes[required[0]], group = f.report.packages.find(item => item.name === groupName);
  assert.equal(groupName, 'forest-metadata-core-0');
  for (const file of required) assert.equal(f.index.routes[file], groupName);
  assert.equal(f.report.corePackagesMerged, 1);
  assert.ok(group.bytes <= 512 * 1024);
  assert.ok(zlib.inflateSync(fs.readFileSync(path.join(f.code, group.path))).length <= 2 * 1024 * 1024);
  assert.equal(f.index.routes[importPath(lockedId)], 'forest-feature-battle-weapon-cannon-0');
  assert.equal(f.index.routes[importPath(authoringId)], 'forest-feature-weapon-authoring-0');
  assert.notEqual(f.index.routes[importPath(shared)], groupName, 'mixed feature packs remain lazy');
  assert.deepEqual(f.index, again.index);
  assert.equal(f.report.sha256, again.report.sha256);
  for (const item of f.report.packages) {
    const file = item.path || f.report.path;
    assert.deepEqual(fs.readFileSync(path.join(f.code, file)), fs.readFileSync(path.join(again.code, file)));
  }
  const loading = Promise.all(required.map(file => f.load(file)));
  assert.equal(f.packages.length, 2, 'one index and one core platform request');
  f.packages[1].success();
  (await loading).forEach((value, index) => assert.deepEqual(plain(value), f.expected[required[index]]));
  assert.equal(f.fallbacks.length, 0);
  for (const [file, value] of Object.entries(f.expected)) {
    assert.equal(fs.readFileSync(path.join(f.input, file), 'utf8'), JSON.stringify(value));
    const owning = f.report.packages.slice(1).filter(item => Object.hasOwn(f.readPayload(item.path).files, file));
    assert.equal(owning.length, 1, 'every original import keeps exactly one route');
  }
});

test('core coalescing respects expanded ASCII and compressed byte budgets independently', async context => {
  for (const mode of ['expanded', 'compressed']) {
    const f = await fixture(context, (config, expected) => {
      config.paths[0][0] = 'art/catalog'; config.paths[1][0] = 'art/hud/config';
      for (const id of ids.slice(0, 2)) expected[importPath(id)] = { filler: mode === 'expanded'
        ? '森'.repeat(270 * 1024) : crypto.randomBytes(400 * 1024).toString('base64') };
    });
    const groups = f.report.packages.filter(item => item.group === 'core');
    assert.equal(groups.length, 2, mode);
    assert.equal(f.report.corePackagesMerged, 0, mode);
    assert.notEqual(f.index.routes[importPath(ids[0])], f.index.routes[importPath(ids[1])]);
    const loading = Promise.all(ids.slice(0, 2).map(id => f.load(importPath(id))));
    f.packages.slice(1).forEach(request => request.success());
    (await loading).forEach((value, index) => assert.deepEqual(plain(value), f.expected[importPath(ids[index])]));
    assert.equal(f.fallbacks.length, 0);
  }
});

test('boot reads only the index; a requested feature shares one lazy download and never inflates another feature', async context => {
  const f = await fixture(context);
  assert.deepEqual(f.reads, [f.report.path]);
  assert.deepEqual(Object.keys(f.index.files), [configPath]);
  assert.equal(f.stats.groupsLoaded, 0);
  const weaponPath = importPath(ids[0]), fishPath = importPath(ids[1]);
  assert.notEqual(f.index.routes[weaponPath], f.index.routes[fishPath]);
  const first = f.load(weaponPath), second = f.load(weaponPath);
  assert.equal(f.packages.length, 2);
  f.packages[1].success();
  const [a, b] = await Promise.all([first, second]);
  a.nested.count = 100;
  assert.equal(b.nested.count, 1);
  assert.equal(f.stats.groupsLoaded, 1);
  assert.equal(f.reads.length, 2);
  assert.equal(f.reads.includes(f.index.groups[f.index.routes[fishPath]].path), false);
  assert.deepEqual(plain(await f.load(weaponPath)), f.expected[weaponPath]);
  assert.equal(f.packages.length, 2); assert.equal(f.reads.length, 2);
  assert.equal(f.fallbacks.length, 0);
});

test('a cross-feature Creator import pack remains complete and has one shared route', async context => {
  const f = await fixture(context), file = importPath(shared);
  assert.equal(f.index.routes[file], 'forest-metadata-shared-0');
  const waiting = f.load(file);
  f.packages.at(-1).success();
  assert.deepEqual(plain(await waiting), f.expected[file]);
  const occurrences = f.report.packages.slice(1).filter(group => Object.hasOwn(f.readPayload(group.path).files, file));
  assert.equal(occurrences.length, 1);
});

test('feature metadata and its native image share an in-flight and completed platform download', async context => {
  const f = await fixture(context), file = importPath(ids[0]), packageName = f.index.routes[file];
  const png = 'remote/resources/native/ab/ab1234.abcd.png';
  f.downloader.handlers['.png'] = (url, options, complete) => complete(null, url);
  const featureModule = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../tools/wechat-feature-runtime.cjs'), 'utf8')
    .replace('__FOREST_GUNNER_FEATURE_INDEX__', JSON.stringify({ version: 2, base: BASE, files: {
      [png]: { package: packageName, path: 'subpackages/' + packageName + '/' + png.slice('remote/resources/'.length), localOnly: false },
    } }));
  vm.runInNewContext(source, { module: featureModule, setTimeout, clearTimeout,
    require: name => { assert.equal(name, './wechat-resource-timing.js'); return f.timing.exports; },
    wx: { loadSubpackage() { assert.fail('feature must use the shared platform broker'); } } });
  assert.equal(featureModule.exports.installFeatureResources(f.cc), true);
  const image = () => new Promise((resolve, reject) => f.downloader.handlers['.png'](BASE + png, {}, (e, d) => e ? reject(e) : resolve(d)));
  const metadata = f.load(file), native = image();
  assert.equal(f.packages.length, 2);
  f.packages.at(-1).success();
  assert.deepEqual(plain(await metadata), f.expected[file]);
  assert.equal(await native, 'subpackages/' + packageName + '/' + png.slice('remote/resources/'.length));
  await Promise.all([f.load(file), image()]);
  assert.equal(f.packages.length, 2);
  const timing = f.timing.api.snapshot();
  assert.equal(timing.phases.platformSubpackage.started, 2, 'index plus one shared feature download');
  assert.equal(timing.phases.platformSubpackage.active, 0);
  assert.equal(timing.packages.find(item => item.name === packageName).attempts, 1);
  assert.ok(timing.reuse.inFlight >= 1, 'native and metadata share the pending broker request');
  assert.ok(timing.reuse.ready >= 1, 'repeat native access reuses the completed package');
  assert.equal(timing.phases.metadataInflate.started, 2, 'index and feature each inflate only once');
});

test('shared font metrics are encoded once and restored as independent complete objects on every request', async context => {
  const f = await fixture(context), file = importPath(ids[1]);
  const payload = f.readPayload(f.index.groups[f.index.routes[file]].path);
  assert.equal(payload.version, 2);
  assert.equal(payload.fontMetrics.length, 1);
  assert.equal(payload.fonts[file].length, 3);
  assert.equal(f.report.fontMetricCopiesRemoved, 2);
  assert.ok(f.report.fontMetricBytesAvoided > 1000);
  const waiting = f.load(file); f.packages.at(-1).success();
  const data = await waiting;
  assert.deepEqual(plain(data), f.expected[file]);
  data.bitmapFonts.white.glyphs[65].advance = 900;
  data.bitmapFonts.white.advances[10] = 900;
  data.bitmapFonts.red.glyphs[65].variants.red.rect[0] = 999;
  assert.equal(data.bitmapFonts.red.glyphs[65].advance, 16);
  assert.equal(data.bitmapFonts.green.advances[10], 2);
  assert.deepEqual(plain(await f.load(file)), f.expected[file]);
  assert.equal(f.reads.length, 2);
});

test('lazy package failure preserves original URL/options/receiver, shares cooldown, and can recover', async context => {
  const f = await fixture(context), file = importPath(ids[0]), options = { priority: 7 };
  const waiting = f.load(file, options); f.packages.at(-1).fail(new Error('offline'));
  assert.deepEqual(await waiting, { fallback: true });
  assert.equal(f.fallbacks[0].url, BASE + file);
  assert.equal(f.fallbacks[0].options, options);
  assert.equal(f.fallbacks[0].receiver, f.downloader);
  assert.deepEqual(await f.load(file), { fallback: true });
  assert.equal(f.packages.length, 2);
  f.advance(); const recovered = f.load(file); f.packages.at(-1).success();
  assert.deepEqual(plain(await recovered), f.expected[file]);
  assert.equal(f.packages.length, 3); assert.equal(f.stats.groupFallbacks, 2);
});

test('missing lazy callbacks time out before the outer watchdog and ignore late completion', async context => {
  const f = await fixture(context), file = importPath(ids[0]);
  const waiting = f.load(file), stale = f.packages.at(-1);
  f.timeout(); assert.deepEqual(await waiting, { fallback: true });
  stale.success(); stale.fail(new Error('late'));
  assert.equal(f.reads.length, 1); assert.equal(f.timers.size, 0);
  f.advance(); const retry = f.load(file); f.packages.at(-1).success();
  assert.deepEqual(plain(await retry), f.expected[file]);
  assert.equal(f.fallbacks.length, 1);
});

test('corrupt lazy metadata falls back without disabling healthy feature packages', async context => {
  const f = await fixture(context), weapon = importPath(ids[0]), fish = importPath(ids[1]);
  f.damaged.set(f.index.groups[f.index.routes[weapon]].path, Buffer.from([1, 2, 3]));
  const bad = f.load(weapon); f.packages.at(-1).success();
  assert.deepEqual(await bad, { fallback: true });
  const good = f.load(fish); f.packages.at(-1).success();
  assert.deepEqual(plain(await good), f.expected[fish]);
  assert.equal(f.stats.groupsLoaded, 1);
});

test('actual weapon geometry is compacted losslessly and each restored effect/request stays independent', async context => {
  const original = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/resources/art/weapon-system/visuals.json'), 'utf8'));
  const file = importPath(ids[0]);
  const f = await fixture(context, (config, expected) => {
    config.paths[0][0] = 'art/weapon-system/visuals'; expected[file] = original;
  });
  const payload = f.readPayload(f.index.groups[f.index.routes[file]].path);
  assert.equal(payload.version, 3);
  assert.equal(payload.meshGeometries.length, 4, 'small geometry stays inline when reference overhead is not worthwhile');
  assert.equal(payload.meshes[file].length, 56);
  assert.equal(f.report.meshGeometryCopiesRemoved, 52);
  assert.ok(f.report.meshGeometryBytesAvoided > 2300000);
  assert.ok(payload.files[file].length < 1300000);
  const waiting = f.load(file); f.packages.at(-1).success();
  const result = await waiting;
  assert.deepEqual(plain(result), original);
  const refs = payload.meshes[file];
  const a = refs[0], b = refs.find(ref => ref !== a && ref.index === a.index);
  const at = ref => ref.path.reduce((value, key) => value[key], result);
  at(a).positions[0][0] = 123456;
  assert.notEqual(at(b).positions[0][0], 123456);
  assert.deepEqual(plain(await f.load(file)), original);
  assert.equal(f.fallbacks.length, 0);
});

test('battle definition and its sprite metadata do not request complete weapon or skin panels', async context => {
  const panel = '66666666-6666-6666-6666-666666666666';
  const skin = '77777777-7777-7777-7777-777777777777';
  const skinPanel = '88888888-8888-8888-8888-888888888888';
  const f = await fixture(context, (config, expected) => {
    config.paths[0][0] = 'art/weapon-system/visuals';
    expected[importPath(ids[0])] = { customProjectiles: { arrow: { sprite: { path: 'art/weapon-system/bullet', aspect: 2 } } } };
    config.paths[2][0] = 'art/weapon-system/bullet/spriteFrame';
    delete config.packs[shared]; delete expected[importPath(shared)];
    expected[importPath(ids[2])] = { sprite: 'bullet' }; expected[importPath(ids[3])] = { sprite: 'fish' };
    config.uuids.push(panel, skin, skinPanel);
    config.paths[4] = ['art/weapon-system/config', 0]; expected[importPath(panel)] = { panel: 'weapons' };
    config.paths[5] = ['art/skin-system/visuals', 0]; expected[importPath(skin)] = { skins: [] };
    config.paths[6] = ['art/skin-system/config', 0]; expected[importPath(skinPanel)] = { panel: 'skins' };
  });
  const visual = importPath(ids[0]), sprite = importPath(ids[2]);
  assert.equal(f.index.routes[visual], f.index.routes[sprite]);
  assert.notEqual(f.index.routes[visual], f.index.routes[importPath(panel)]);
  assert.notEqual(f.index.routes[importPath(skin)], f.index.routes[importPath(skinPanel)]);
  const loading = Promise.all([f.load(visual), f.load(sprite)]); f.packages.at(-1).success(); await loading;
  assert.equal(f.packages.length, 2);
  assert.equal(f.reads.includes(f.index.groups[f.index.routes[importPath(panel)]].path), false);
  const skinLoading = f.load(importPath(skin)); f.packages.at(-1).success(); await skinLoading;
  assert.equal(f.reads.includes(f.index.groups[f.index.routes[importPath(skinPanel)]].path), false);
});

test('the real settings background shares image imports without downloading the fish panel', async context => {
  const settings = require('../assets/resources/art/settings-system/config.json');
  const image = settings.images.s675;
  assert.equal(image.path, 'art/fish-system/images/s675', 'exercise the cross-panel path that caused the startup regression');
  const imageId = '66666666-6666-6666-6666-666666666666';
  const textureId = imageId + '@6c48a', frameId = imageId + '@f9941';
  const texturePack = '77777777-7777-7777-7777-777777777777';
  const privateId = '88888888-8888-8888-8888-888888888888';
  const f = await fixture(context, (config, expected) => {
    config.types.push('cc.ImageAsset', 'cc.Texture2D', 'cc.SpriteFrame');
    config.paths[0][0] = 'art/settings-system/config';
    expected[importPath(ids[0])] = { images: { background: image } };
    expected[importPath(ids[1])].images = { background: image, private: { path: 'art/fish-system/private' } };
    config.uuids.push(imageId, textureId, frameId, privateId);
    config.paths[4] = [image.path, 1]; config.paths[5] = [image.path + '/texture', 2];
    config.paths[6] = [image.path + '/spriteFrame', 3]; config.paths[7] = ['art/fish-system/private/texture', 2];
    config.packs[texturePack] = [5, 7];
    expected[importPath(imageId)] = { __type__: 'cc.ImageAsset', _native: '.png' };
    expected[importPath(frameId)] = { __type__: 'cc.SpriteFrame', texture: textureId, rect: [0, 0, 64, 64] };
    expected[importPath(texturePack)] = { type: 'cc.Texture2D', data: [{ image: imageId }, { image: 'private-image' }] };
  });
  const requested = [importPath(ids[0]), importPath(imageId), importPath(frameId), importPath(texturePack)];
  for (const file of requested.slice(1)) assert.equal(f.index.routes[file], 'forest-metadata-shared-0', file);
  assert.notEqual(f.index.routes[importPath(ids[0])], f.index.routes[importPath(ids[1])]);
  const loading = Promise.all(requested.map(file => f.load(file)));
  f.packages.slice(1).forEach(request => request.success());
  const restored = await loading;
  restored.forEach((value, i) => assert.deepEqual(plain(value), f.expected[requested[i]]));
  assert.equal(f.packages.some(request => request.name.startsWith('forest-feature-fish-')), false);
  assert.equal(f.fallbacks.length, 0);
  assert.equal(f.reads.includes(f.index.groups[f.index.routes[importPath(ids[1])]].path), false);
  assert.deepEqual(plain(restored[3]), f.expected[importPath(texturePack)], 'the entire compiled Texture2D pack is retained');
  for (const [file, expected] of Object.entries(f.expected)) {
    assert.equal(fs.readFileSync(path.join(f.input, file), 'utf8'), JSON.stringify(expected), 'hashed source bytes remain unchanged');
    const occurrences = f.report.packages.slice(1).filter(group => Object.hasOwn(f.readPayload(group.path).files, file));
    assert.equal(occurrences.length, 1, 'one unchanged URL route per import');
  }
});

test('cross-directory private imports follow their actual consumer while unreferenced images retain directory ownership', async context => {
  const used = '66666666-6666-6666-6666-666666666666';
  const unknown = '77777777-7777-7777-7777-777777777777';
  const f = await fixture(context, (config, expected) => {
    config.types.push('cc.SpriteFrame');
    config.paths[0][0] = 'art/settings-system/config';
    expected[importPath(ids[0])] = { images: { background: { path: 'art/fish-system/private-setting' } } };
    config.uuids.push(used, unknown);
    config.paths[4] = ['art/fish-system/private-setting/spriteFrame', 1];
    config.paths[5] = ['art/fish-system/dynamic-unlisted/spriteFrame', 1];
    expected[importPath(used)] = { sprite: 'settings-only' }; expected[importPath(unknown)] = { sprite: 'dynamic' };
  });
  assert.equal(f.index.routes[importPath(used)], f.index.routes[importPath(ids[0])]);
  assert.equal(f.index.routes[importPath(unknown)], f.index.routes[importPath(ids[1])]);
  const first = f.load(importPath(used)); f.packages.at(-1).success();
  assert.deepEqual(plain(await first), f.expected[importPath(used)]);
  assert.equal(f.packages.some(request => request.name.startsWith('forest-feature-fish-')), false);
});

test('split weapon runtime categories remain independent of the original authoring export and unselected categories', async context => {
  const archery = '66666666-6666-6666-6666-666666666666';
  const cannon = '77777777-7777-7777-7777-777777777777';
  const arrow = '88888888-8888-8888-8888-888888888888';
  const shell = '99999999-9999-9999-9999-999999999999';
  const f = await fixture(context, (config, expected) => {
    config.types.push('cc.SpriteFrame');
    config.paths[0][0] = 'art/weapon-system/visuals';
    expected[importPath(ids[0])] = { authoring: true, images: [
      { path: 'art/weapon-system/arrow', aspect: 1 }, { path: 'art/weapon-system/shell', aspect: 1 },
    ] };
    config.paths[1][0] = 'art/weapon-runtime/index'; expected[importPath(ids[1])] = { weapons: [], sounds: {} };
    config.uuids.push(archery, cannon, arrow, shell);
    config.paths[4] = ['art/weapon-runtime/projectiles/archery', 0];
    config.paths[5] = ['art/weapon-runtime/projectiles/cannon', 0];
    config.paths[6] = ['art/weapon-system/arrow/spriteFrame', 1];
    config.paths[7] = ['art/weapon-system/shell/spriteFrame', 1];
    expected[importPath(archery)] = { projectile: { path: 'art/weapon-system/arrow', aspect: 1 } };
    expected[importPath(cannon)] = { projectile: { path: 'art/weapon-system/shell', aspect: 1 } };
    expected[importPath(arrow)] = { sprite: 'arrow' }; expected[importPath(shell)] = { sprite: 'shell' };
  });
  assert.equal(f.index.routes[importPath(ids[0])], 'forest-feature-weapon-authoring-0');
  assert.equal(f.index.routes[importPath(ids[1])], 'forest-feature-battle-weapon-core-0');
  assert.equal(f.index.routes[importPath(archery)], 'forest-feature-battle-weapon-archery-0');
  assert.equal(f.index.routes[importPath(cannon)], 'forest-feature-battle-weapon-cannon-0');
  assert.equal(f.index.routes[importPath(arrow)], f.index.routes[importPath(archery)]);
  assert.equal(f.index.routes[importPath(shell)], f.index.routes[importPath(cannon)]);
  const wanted = [importPath(ids[1]), importPath(archery), importPath(arrow)];
  const loading = Promise.all(wanted.map(file => f.load(file)));
  f.packages.slice(1).forEach(request => request.success());
  (await loading).forEach((value, i) => assert.deepEqual(plain(value), f.expected[wanted[i]]));
  assert.equal(f.packages.some(request => request.name.includes('authoring') || request.name.includes('cannon')), false);
  assert.equal(f.fallbacks.length, 0);
});

test('damaged shared mesh references fall back, preserving the original remote asset', async context => {
  const original = require('../assets/resources/art/weapon-system/visuals.json'), file = importPath(ids[0]);
  const f = await fixture(context, (config, expected) => { config.paths[0][0] = 'art/weapon-system/visuals'; expected[file] = original; });
  const metadataPath = f.index.groups[f.index.routes[file]].path, payload = f.readPayload(metadataPath);
  payload.meshes[file][0].index = -1;
  const ascii = JSON.stringify(payload).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  f.damaged.set(metadataPath, zlib.deflateSync(Buffer.from(ascii)));
  const waiting = f.load(file); f.packages.at(-1).success();
  assert.deepEqual(await waiting, { fallback: true }); assert.equal(f.fallbacks[0].url, BASE + file);
});
