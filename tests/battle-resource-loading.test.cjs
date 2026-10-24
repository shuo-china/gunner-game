const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const { resourceModules } = require('./support/resource-modules.cjs');
const shared = resourceModules();
const json = name => JSON.parse(fs.readFileSync(path.join(root, 'assets/resources', name + '.json'), 'utf8'));
function load(name, imports) {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, 'assets/scripts/view', name + '.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
    { module, exports: module.exports, require: name => {
      if (name === './ResourceBatch') return shared('ResourceBatch');
      if (name === './NumberGlyphAtlas') return load('NumberGlyphAtlas', { cc: imports.cc });
      assert.ok(name in imports, name); return imports[name];
    } });
  return module.exports;
}
const { OriginalMapView } = load('OriginalMapView', { cc: { resources: { load: (key, type, callback) => callback(null, {}) } },
  '../core': {}, './ArtLibrary': {}, './MapBorderGeometry': {}, './OriginalParticleMesh': {} });
const { BattleAssetLoader } = load('BattleAssetLoader', { './ArtLibrary': {}, './OriginalMapView': { OriginalMapView } });
async function fixture(index = 0) {
  const requests = [], configs = [];
  const art = { catalog: {}, frames: new Map(), json: async name => { configs.push(name); return json(name); },
    loadFrame: async name => { requests.push(name); art.frames.set(name, {}); },
    resourceLoader: { load: async (name, kind) => { assert.equal(kind, 'effect'); return {}; } } };
  const map = await OriginalMapView.load(art, index);
  return { art, map, requests, configs, loader: new BattleAssetLoader(art, map) };
}

test('map startup fetches the reordered saved stage and matching targets before preloading the next stage', async () => {
  const stages = json('art/stages/config');
  for (const index of [0, 7]) {
    const h = await fixture(index);
    const paths = h.requests.filter(name => /^art\/stages\/(maps|trees)\//.test(name));
    const expected = [...Object.values(stages.skins[index].sprites), ...stages.treeSprites.slice(index * 4, index * 4 + 4)].map(spec => spec.path);
    assert.deepEqual([...new Set(paths)].sort(), [...new Set(expected)].sort());
    assert.equal(h.loader.ready({ skinIndex: index }), true); assert.equal(h.loader.ready({ skinIndex: index + 1 }), false);
    await h.loader.load({ skinIndex: index + 1 }); assert.equal(h.loader.ready({ skinIndex: index + 1 }), true);
    assert.equal(h.requests.some(name => /^art\/(boss|raid)-system\//.test(name)), false);
  }
});

test('map startup overlaps delayed base art without scanning other stages or mutating source catalogs', async () => {
  const { ArtLibrary } = load('ArtLibrary', { cc: {}, './OriginalColorMath': {}, './GameResourceLoader': {} });
  const sourceCatalog = json('art/catalog'), rigPath = sourceCatalog.characters.cat_basic.rig;
  for (const blockedPath of ['art/catalog', rigPath]) {
    let releaseBase, baseReady = false;
    const blocked = new Promise(resolve => { releaseBase = resolve; });
    const sources = new Map(), requests = [];
    const art = new ArtLibrary({
      loadJson: async name => {
        if (name === blockedPath) await blocked;
        if (!sources.has(name)) sources.set(name, json(name));
        return sources.get(name);
      },
      load: async (name, kind) => { requests.push({ name, kind }); return { texture: {} }; },
    });
    const runtimeCatalog = art.catalog;
    const base = art.load().then(() => { baseReady = true; });
    const map = await OriginalMapView.load(art, 7);
    assert.equal(baseReady, false, 'saved-stage images finish before delayed base art');
    assert.equal(art.catalog, runtimeCatalog, 'map uses the stable runtime catalog');
    assert.equal(art.catalog.stageTrees, sources.get('art/stages/config'));
    releaseBase(); await base;
    assert.equal(art.catalog, runtimeCatalog, 'base completion preserves the map catalog owner');
    assert.equal(art.catalog.stageTrees, sources.get('art/stages/config'));
    assert.deepEqual(sources.get('art/catalog'), sourceCatalog, 'feedback and stages never change cached base JSON');
    assert.equal(art.catalog.feedback, sources.get('art/effects/original-feedback'));
    const stagePaths = requests.filter(item => /^art\/stages\/(maps|trees)\//.test(item.name)).map(item => item.name);
    const stages = json('art/stages/config');
    const expected = [...Object.values(stages.skins[7].sprites), ...stages.treeSprites.slice(28, 32)].map(spec => spec.path + '/spriteFrame');
    assert.deepEqual(stagePaths.sort(), expected.sort(), 'stage eight loads its swapped environment and unchanged ruins targets');
    assert.ok(OriginalMapView.stageFrames(art, map, 7).every(spec => art.frames.has(spec.path)));
  }
});

test('map shader overlaps frame loading and readiness waits for both', async () => {
  let releaseFrames, releaseEffect, effectStarted = false, ready = false;
  const frames = new Promise(resolve => { releaseFrames = resolve; });
  const effect = new Promise(resolve => { releaseEffect = resolve; });
  const requests = [];
  const art = { catalog: {}, json: async name => json(name),
    loadFrame: async name => { requests.push(name); await frames; },
    resourceLoader: { load: () => { effectStarted = true; return effect; } } };
  const pending = OriginalMapView.load(art, 3).then(map => { ready = true; return map; });
  await new Promise(setImmediate);
  assert.ok(requests.length > 0); assert.equal(effectStarted, true, 'shader starts while the image batch is blocked');
  assert.equal(ready, false);
  releaseFrames(); await new Promise(setImmediate); assert.equal(ready, false, 'images alone cannot publish the map');
  releaseEffect({}); await pending; assert.equal(ready, true);
});

test('failed map shader rejects readiness and retry reuses downloaded stage frames', async () => {
  const requests = [], frames = new Map(); let effectLoads = 0;
  const art = { catalog: {}, json: async name => json(name),
    loadFrame: async name => { if (!frames.has(name)) { requests.push(name); frames.set(name, {}); } },
    resourceLoader: { load: async () => { if (++effectLoads === 1) throw Error('floor unavailable'); return {}; } } };
  await assert.rejects(OriginalMapView.load(art, 7), /floor unavailable/);
  await new Promise(setImmediate);
  const firstRequests = requests.length;
  await OriginalMapView.load(art, 7);
  assert.equal(effectLoads, 2); assert.equal(requests.length, firstRequests);
});

test('boss and raid artwork load only when their corresponding encounter is requested', async () => {
  const h = await fixture(); const boss = { skinIndex: 0, boss: { stageIndex: 1 } };
  assert.equal(h.loader.ready(boss), false); assert.equal(h.configs.some(name => /boss-system/.test(name)), false);
  await h.loader.load(boss); assert.equal(h.loader.ready(boss), true);
  assert.equal(h.configs.filter(name => /boss-system/.test(name)).length, 1);
  assert.equal(h.configs.some(name => /raid-system/.test(name)), false);
  const raid = { skinIndex: 0, raidBoss: { bossIndex: 2 } };
  assert.equal(h.loader.ready(raid), false); await h.loader.load(raid); assert.equal(h.loader.ready(raid), true);
  const before = h.configs.length; await h.loader.load(raid); assert.equal(h.configs.length, before);
});

test('failed encounter assets remain unready and can be retried without losing the current map', async () => {
  const h = await fixture(), original = h.art.loadFrame;
  const stage = { skinIndex: 0, boss: { stageIndex: 0 } };
  h.art.loadFrame = async name => { if (name.startsWith('art/boss-system/')) throw Error('offline'); return original(name); };
  await assert.rejects(h.loader.load(stage), /offline/);
  assert.equal(h.loader.ready(stage), false); assert.equal(h.loader.ready({ skinIndex: 0 }), true);
  h.art.loadFrame = original; await h.loader.load(stage); assert.equal(h.loader.ready(stage), true);
});

test('runtime particle catalogs contain only skins referenced by the current 65 weapons', () => {
  const visuals = json('art/weapon-system/visuals');
  for (const [catalog, field] of [['projectileSkins', 'projectileSkin'], ['muzzleSkins', 'muzzleSkin']]) {
    const used = new Set(visuals.weapons.map(weapon => weapon[field]).filter(Boolean));
    assert.deepEqual(Object.keys(visuals[catalog]).sort(), Array.from(used).sort());
  }
});

test('next-stage preparation queues background loads, populates ArtLibrary and shares a pending foreground entry', async () => {
  const h = await fixture(7), requests = [], jobs = [];
  const cc = { SpriteFrame: class {}, ImageAsset: class {}, JsonAsset: class {}, AudioClip: class {}, EffectAsset: class {},
    resources: { get: () => null, load(path, type, callback) { requests.push({ path, type, callback, profile: 'foreground' }); } },
    assetManager: { loadAny(request, options, callback) { requests.push({ ...request, options, callback, profile: 'background' }); } } };
  const { GameResourceLoader } = resourceModules(cc)('GameResourceLoader');
  const { ArtLibrary } = load('ArtLibrary', { cc, './OriginalColorMath': {}, './GameResourceLoader': { GameResourceLoader } });
  const art = new ArtLibrary(); art.catalog = h.art.catalog;
  h.art.frames.forEach((frame, path) => art.frames.set(path, frame));
  const loader = new BattleAssetLoader(art, h.map), stage = { skinIndex: 8 };
  loader.preload(stage, { prepareBattle(paths, loadFrame) { paths.forEach(path => jobs.push(() => loadFrame(path))); } });
  assert.ok(jobs.length > 0); assert.equal(requests.length, 0, 'preload only queues work');
  const first = jobs[0]();
  assert.equal(requests.length, 1); assert.equal(requests[0].profile, 'background');
  assert.equal(requests[0].options.priority, -1);
  const foreground = loader.load(stage);
  assert.equal(requests.filter(r => r.path === requests[0].path).length, 1, 'entry shares the in-flight map frame');
  let completed = 0;
  for (let i = 0; i < 30; i++) {
    for (const request of requests.slice(completed)) { request.callback(null, new cc.SpriteFrame()); completed++; }
    await new Promise(setImmediate);
    if (loader.ready(stage)) break;
  }
  await first; await foreground; assert.equal(loader.ready(stage), true);
  const count = requests.length;
  await Promise.all(jobs.map(job => job()));
  assert.equal(requests.length, count, 'queued completion reuses frames after foreground entry');
  const after = []; loader.preload(stage, { prepareBattle(paths) { after.push(...paths); } });
  assert.equal(after.length, 0, 'ready map frames do not create new warmup tasks');
});
