const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');
const { generate, stringify } = require('../tools/build-weapon-runtime.cjs');
const { getWeaponCatalog } = require('./.build/core/WeaponCatalog.js');
const visuals = require('../assets/resources/art/weapon-system/visuals.json');
const critical = require('../assets/resources/art/weapon-system/critical/config.json');
const grades = require('../assets/resources/art/weapon-grade-effects/config.json');
const manifest = require('../assets/resources/art/effects/number-atlas/config.json');
const INDEX = 'art/weapon-runtime/index';
const source = ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view/WeaponVisualAssets.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS },
}).outputText;
// Cross-realm values become local objects without JSON.stringify erasing -0.
function plain(value) {
  if (Array.isArray(value)) return Array.from(value, plain);
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)])) : value;
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const tick = () => new Promise(setImmediate);
const categoryId = category => getWeaponCatalog().find(item => item.category === category).id;

function harness({ frame, effect, json, customize, freezeJson = false } = {}) {
  const requested = [], effects = [], jsonCalls = [], cached = new Map(), frames = new Map(), effectRequests = new Map();
  const module = { exports: {} }, warnings = [];
  const glyphModule={exports:{}},cc={EffectAsset:class {},
    Rect:class {constructor(x,y,width,height){Object.assign(this,{x,y,width,height});}},
    Size:class {constructor(width,height){Object.assign(this,{width,height});}},SpriteFrame:class {}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view/NumberGlyphAtlas.ts'),'utf8'),{
    compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS},
  }).outputText,{module:glyphModule,exports:glyphModule.exports,require:key=>{assert.equal(key,'cc');return cc;}});
  vm.runInNewContext(source, { module, exports: module.exports, console: { warn: text => warnings.push(text) }, require: key => key === 'cc'
    ? cc : key === './NumberGlyphAtlas' ? glyphModule.exports : key === '../core/WeaponCatalog' ? require('./.build/core/WeaponCatalog.js') : {} });
  const remember = (cache, key, operation) => {
    if (cache.has(key)) return cache.get(key);
    const request = Promise.resolve().then(operation).catch(error => { cache.delete(key); throw error; });
    cache.set(key, request); return request;
  };
  const art = {
    frames:new Map(),
    json: async path => {
      jsonCalls.push(path);
      if (json) await json(path);
      if (!cached.has(path)) {
        const value = JSON.parse(fs.readFileSync(projectPath('assets/resources/' + path + '.json'), 'utf8'));
        if (customize) customize(path, value);
        cached.set(path, freezeJson ? freeze(value) : value);
      }
      return cached.get(path);
    },
    // Match ArtLibrary's completed/in-flight cache and its failed-request eviction.
    loadFrame: path => remember(frames, path, async () => {
      requested.push(path);if(frame)await frame(path);
      const value={path,texture:{path}};art.frames.set(path,value);return value;
    }),
    resourceLoader: { load: (path, kind) => remember(effectRequests, path, async () => {
      assert.equal(kind, 'effect'); effects.push(path);
      return effect ? effect(path) : { name: 'custom projectile effect' };
    }) },
  };
  return { WeaponVisualAssets: module.exports.WeaponVisualAssets, art, requested, effects, jsonCalls, cached, warnings, glyphs:glyphModule.exports };
}

function pathsFor(ids) {
  const paths = new Set();
  for (const id of new Set(ids)) {
    const weapon = visuals.weapons.find(item => item.id === id);
    paths.add(weapon.image.path);
    for (const particle of visuals.projectileSkins[weapon.projectileSkin]) paths.add(particle.image.path);
    for (const particle of visuals.muzzleSkins[weapon.muzzleSkin].particleSystems) paths.add(visuals.images[particle.spriteId].path);
    const profile = visuals.customProjectiles?.[weapon.projectileSkin];
    if (profile) {
      paths.add(profile.sprite.path);
      if (profile.airFlow) paths.add(profile.airFlow.image.path);
      if (profile.cometTrail) paths.add(profile.cometTrail.image.path);
    }
  }
  for (const image of Object.values(grades.images)) paths.add(image.path);
  paths.add(manifest.atlas);
  return paths;
}
const groupCalls = h => h.jsonCalls.filter(path => path.startsWith('art/weapon-runtime/projectiles/'));
function sameFrames(h, ids) { assert.deepEqual(new Set(h.requested), pathsFor(ids)); assert.equal(h.requested.length, new Set(h.requested).size); }

test('new-player startup reads only archery effects and default-weapon frames while keeping all appearances', async () => {
  const h = harness(), assets = await h.WeaponVisualAssets.load(h.art);
  assert.deepEqual(groupCalls(h), ['art/weapon-runtime/projectiles/archery']);
  assert.equal(h.jsonCalls.includes('art/weapon-system/visuals'), false);
  sameFrames(h, [0]);
  assert.equal(assets.config.weapons.length, 65);
  for (const appearance of visuals.weapons) assert.deepEqual(plain(assets.appearance(appearance.id)), appearance);
  assert.equal(h.art.weaponVisuals, assets);
  assert.deepEqual(h.effects, ['art/rendering/custom-projectile']);
  assert.ok(assets.customProjectileEffect);
  assert.equal(Object.keys(assets.config.projectileSkins).length, Object.keys(h.cached.get(groupCalls(h)[0]).data.projectileSkins).length);
});

test('saved squads load only default and equipped categories; repeated, empty, and invalid IDs preserve fallback behavior', async () => {
  const glove = categoryId('glove'), cannon = categoryId('cannon'), ids = [glove, cannon, glove, cannon];
  const h = harness(); await h.WeaponVisualAssets.load(h.art, ids);
  sameFrames(h, [0, glove, cannon]);
  assert.deepEqual(new Set(groupCalls(h)), new Set(['archery', 'glove', 'cannon'].map(name => 'art/weapon-runtime/projectiles/' + name)));
  assert.equal(groupCalls(h).length, 3);
  assert.deepEqual(ids, [glove, cannon, glove, cannon]);
  const empty = harness(); await empty.WeaponVisualAssets.load(empty.art, []); sameFrames(empty, [0]);
  const invalid = harness(), assets = await invalid.WeaponVisualAssets.load(invalid.art, [-1, 999, .5, NaN, Infinity, '1']);
  sameFrames(invalid, [0]);
  for (const id of [-1, 999, .5, NaN, Infinity, '1']) assert.equal(assets.appearance(id).id, 0);
});

test('concurrent prepareAll shares each category request and restores all 65 weapons field-for-field before completion', async () => {
  let hold = false; const pending = [];
  const h = harness({ json: path => hold && path.includes('/projectiles/') ? new Promise(resolve => pending.push(resolve)) : undefined });
  const assets = await h.WeaponVisualAssets.load(h.art); hold = true;
  const first = assets.prepareAll(), second = assets.prepareAll();
  await tick();
  assert.equal(pending.length, 5, 'the five unopened categories each have one in-flight JSON request');
  assert.equal(groupCalls(h).length, 6);
  pending.forEach(resolve => resolve()); await Promise.all([first, second]);
  assert.deepEqual(Object.fromEntries(Object.keys(visuals).map(key => [key, plain(assets.config[key])])), visuals);
  sameFrames(h, visuals.weapons.map(item => item.id));
  await assets.prepareAll();
  assert.equal(groupCalls(h).length, 6, 'completed category results are reused');
  sameFrames(h, visuals.weapons.map(item => item.id));
  assert.equal(h.effects.length, 1);
});

test('hydration leaves frozen cached JSON untouched and gives duplicate mesh references independent arrays with negative zero intact', async () => {
  const staffPath = 'art/weapon-runtime/projectiles/staff';
  const h = harness({ freezeJson: true, customize: (path, data) => {
    if (path !== staffPath) return;
    const geometry = JSON.parse(data.meshGeometries[0]); geometry.positions[0][0] = -0;
    data.meshGeometries[0] = stringify(geometry);
  } });
  const assets = await h.WeaponVisualAssets.load(h.art), cachedIndexBefore = plain(h.cached.get(INDEX));
  await assets.prepareAll();
  assert.deepEqual(plain(h.cached.get(INDEX)), cachedIndexBefore);
  assert.equal(h.cached.get(INDEX).projectileSkins, undefined);
  const catalog = h.cached.get(staffPath), refs = catalog.meshes.filter(ref => ref.index === 0);
  assert.ok(refs.length >= 2);
  const at = (value, reference) => reference.path.reduce((parent, key) => parent[key], value);
  assert.equal(at(catalog.data, refs[0]).positions, undefined, 'cached compact metadata is not hydrated in place');
  const a = at(assets.config, refs[0]), b = at(assets.config, refs[1]);
  assert.ok(Object.is(a.positions[0][0], -0)); assert.ok(Object.is(b.positions[0][0], -0));
  assert.notEqual(a.positions, b.positions); assert.notEqual(a.positions[0], b.positions[0]);
  a.positions[0][0] = 123456;
  assert.ok(Object.is(b.positions[0][0], -0));
  assert.ok(Object.is(JSON.parse(catalog.meshGeometries[0]).positions[0][0], -0));
});

test('a failed category request retries without repeating successfully prepared categories', async () => {
  const failedPath = 'art/weapon-runtime/projectiles/cannon'; let failures = 1;
  const h = harness({ json: path => { if (path === failedPath && failures-- > 0) throw new Error('category unavailable'); } });
  const assets = await h.WeaponVisualAssets.load(h.art);
  await assert.rejects(assets.prepareAll(), /category unavailable/);
  await tick();
  await assets.prepareAll();
  assert.equal(groupCalls(h).filter(path => path === failedPath).length, 2);
  for (const path of new Set(groupCalls(h))) if (path !== failedPath) assert.equal(groupCalls(h).filter(value => value === path).length, 1);
  assert.deepEqual(plain(assets.config.projectileSkins), visuals.projectileSkins);
});

test('a failed frame is not marked ready and retries while reusing the already hydrated category', async () => {
  const id = categoryId('cannon'), failedPath = visuals.weapons.find(item => item.id === id).image.path; let failures = 1;
  const h = harness({ frame: path => { if (path === failedPath && failures-- > 0) throw new Error('image unavailable'); } });
  const assets = await h.WeaponVisualAssets.load(h.art);
  await assert.rejects(assets.prepareWeapons([id]), /image unavailable/);
  assert.equal(assets.loadedFramePaths.has(failedPath), false);
  await assets.prepareWeapons([id]);
  assert.equal(assets.loadedFramePaths.has(failedPath), true);
  assert.equal(h.requested.filter(path => path === failedPath).length, 2);
  assert.equal(groupCalls(h).filter(path => path.endsWith('/cannon')).length, 1);
});

test('startup publishes only after requested images and custom shader both finish', async () => {
  let releaseFrame, releaseEffect;
  const delayed = visuals.weapons.find(item => item.id === 0).image.path;
  const h = harness({ frame: path => path === delayed ? new Promise(resolve => { releaseFrame = resolve; }) : undefined,
    effect: () => new Promise(resolve => { releaseEffect = resolve; }) });
  const previous = {}; h.art.weaponVisuals = previous;
  const waiting = h.WeaponVisualAssets.load(h.art);
  await tick(); assert.equal(h.art.weaponVisuals, previous); assert.deepEqual(h.effects, []);
  releaseFrame(); await tick();
  assert.equal(h.art.weaponVisuals, previous); assert.equal(typeof releaseEffect, 'function');
  const effect = {}; releaseEffect(effect);
  const assets = await waiting;
  assert.equal(h.art.weaponVisuals, assets); assert.equal(assets.customProjectileEffect, effect);
});

test('shader failure does not publish partial assets and a subsequent startup reuses successful image loads', async () => {
  let failures = 1;
  const h = harness({ effect: () => { if (failures-- > 0) throw new Error('shader unavailable'); return { name: 'recovered' }; } });
  const previous = {}; h.art.weaponVisuals = previous;
  await assert.rejects(h.WeaponVisualAssets.load(h.art), /shader unavailable/);
  assert.equal(h.art.weaponVisuals, previous);
  const imageRequests = h.requested.length, assets = await h.WeaponVisualAssets.load(h.art);
  assert.equal(h.art.weaponVisuals, assets); assert.equal(h.requested.length, imageRequests);
  assert.equal(h.effects.length, 2); assert.equal(assets.customProjectileEffect.name, 'recovered');
});

test('weapon publication waits for the number atlas and the first critical hit uses it without loading individual glyphs',async()=>{
  let releaseAtlas;
  const h=harness({frame:path=>path===manifest.atlas?new Promise(resolve=>{releaseAtlas=resolve;}):undefined});
  const pending=h.WeaponVisualAssets.load(h.art);await tick();
  assert.equal(typeof releaseAtlas,'function');assert.equal(h.art.weaponVisuals,undefined);
  assert.ok(h.art.frames.has(visuals.weapons[0].image.path),'ordinary images load concurrently');
  releaseAtlas();const assets=await pending,requestsBeforeFirstHit=h.requested.length;
  for(const spec of Object.values(critical.glyphs)) {
    assert.equal(h.art.frames.has(spec.path),false);
    assert.equal(assets.loadedFramePaths.has(spec.path),false);
    assert.equal(h.glyphs.numberGlyphFrame(h.art,spec.path).texture,h.art.frames.get(manifest.atlas).texture);
  }
  assert.ok(assets.loadedFramePaths.has(manifest.atlas));
  assert.equal(h.requested.length,requestsBeforeFirstHit,'first critical hit is synchronous');
});

test('atlas failure blocks weapon publication, retries, and future uncovered glyphs preserve their frame fallback',async()=>{
  const custom='custom/critical-glyph';let atlasFailures=1,fallbackFailures=1;
  const h=harness({customize:(path,data)=>{if(path==='art/weapon-system/critical/config')data.glyphs['?']={...data.glyphs['0'],path:custom};},
    frame:path=>{
      if(path===manifest.atlas&&atlasFailures-->0)throw new Error('atlas unavailable');
      if(path===custom&&fallbackFailures-->0)throw new Error('fallback unavailable');
    }});
  await assert.rejects(h.WeaponVisualAssets.load(h.art),/atlas unavailable/);
  assert.equal(h.art.weaponVisuals,undefined);assert.equal(h.requested.includes(custom),false);
  await assert.rejects(h.WeaponVisualAssets.load(h.art),/fallback unavailable/);
  assert.equal(h.art.weaponVisuals,undefined);
  const assets=await h.WeaponVisualAssets.load(h.art);
  assert.equal(h.art.weaponVisuals,assets);assert.ok(assets.loadedFramePaths.has(custom));
  assert.equal(h.glyphs.numberGlyphFrame(h.art,custom),h.art.frames.get(custom));
  assert.equal(h.requested.filter(path=>path===manifest.atlas).length,2);
  assert.equal(h.requested.filter(path=>path===custom).length,2);
  assert.equal(h.requested.some(path=>path.startsWith('art/weapon-system/critical/')),false);
});

test('generated category catalogs are deterministic, current, and preserve source bytes and negative-zero serialization', () => {
  const authoringPath = projectPath('assets/resources/art/weapon-system/visuals.json'), before = fs.readFileSync(authoringPath);
  const first = generate(), second = generate();
  assert.equal(first.size, 7); assert.deepEqual(first, second);
  for (const [path, contents] of first) assert.equal(fs.readFileSync(projectPath('assets/resources/' + path), 'utf8'), contents, path);
  assert.deepEqual(fs.readFileSync(authoringPath), before);
  assert.ok(Object.is(JSON.parse(stringify({ coordinate: -0 })).coordinate, -0));
});
