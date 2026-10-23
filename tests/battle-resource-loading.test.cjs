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
const { OriginalMapView } = load('OriginalMapView', { cc: { resources: { load: (key, type, callback) => callback(null, {}) } }, '../core': {}, './ArtLibrary': {} });
const { BattleAssetLoader } = load('BattleAssetLoader', { './ArtLibrary': {}, './OriginalMapView': { OriginalMapView } });
async function fixture(index = 0) {
  const requests = [], configs = [];
  const art = { catalog: {}, frames: new Map(), json: async name => { configs.push(name); return json(name); },
    loadFrame: async name => { requests.push(name); art.frames.set(name, {}); },
    resourceLoader: { load: async (name, kind) => { assert.equal(kind, 'effect'); return {}; } } };
  const map = await OriginalMapView.load(art, index);
  return { art, map, requests, configs, loader: new BattleAssetLoader(art, map) };
}

test('map startup fetches the saved stage and four matching trees, then explicitly preloads the next stage', async () => {
  const h = await fixture(7);
  const mapPaths = h.requests.filter(name => name.startsWith('art/stages/maps/'));
  assert.ok(mapPaths.length > 0); assert.ok(mapPaths.every(name => name.startsWith('art/stages/maps/7/')));
  const treePaths = h.requests.filter(name => name.startsWith('art/stages/trees/'));
  assert.equal(new Set(treePaths).size, 4);
  assert.ok(treePaths.every(name => /^art\/stages\/trees\/(28|29|30|31)$/.test(name)));
  assert.equal(h.loader.ready({ skinIndex: 7 }), true); assert.equal(h.loader.ready({ skinIndex: 8 }), false);
  await h.loader.load({ skinIndex: 8 }); assert.equal(h.loader.ready({ skinIndex: 8 }), true);
  assert.equal(h.requests.some(name => /^art\/(boss|raid)-system\//.test(name)), false);
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
