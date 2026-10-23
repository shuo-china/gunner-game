const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');
const { resourceModules } = require('./support/resource-modules.cjs');
const shared = resourceModules();
function load(name, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view', name + '.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports, require: name => {
    if (name === './ResourceLoadingPolicy') return shared('ResourceLoadingPolicy');
    assert.ok(name in imports, name); return imports[name];
  } });
  return module.exports;
}
const queueModule = load('BackgroundResourceQueue');
const manifest = load('FeatureResourceManifest');
const flush = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const json = name => JSON.parse(fs.readFileSync(projectPath('assets/resources', name + '.json'), 'utf8'));

test('background queue waits one second, prioritizes unlocked/promoted groups and shares resources', async () => {
  let now = 0; const q = new queueModule.BackgroundResourceQueue(() => now), calls = [], pending = [];
  const run = name => () => { calls.push(name); const wait = deferred(); pending.push(wait); return wait.promise; };
  q.enqueue('locked', 'raid', run('locked')); q.enqueue('shared', 'raid', run('shared'));
  q.enqueue('common', 'weapons', run('common')); q.enqueue('shared', 'weapons', run('duplicate'));
  q.setPriority('weapons', 30); q.setPriority('raid', 10); q.start(); q.start();
  now = 999; q.tick(); assert.deepEqual(calls, []);
  now = 1000; q.tick(); assert.deepEqual(calls, ['shared', 'common']);
  q.tick(); assert.equal(q.snapshot().active, 2);
  q.enqueue('later', 'settings', run('settings')); q.prioritize('settings');
  pending[0].resolve(); await flush(); assert.equal(calls.length, 2, 'settlement cannot dispatch outside the game update');
  q.tick(); assert.equal(calls[2], 'settings');
  pending[1].resolve(); pending[2].resolve(); await flush(); q.tick(); assert.equal(calls[3], 'locked');
  pending[3].resolve(); await flush(); q.tick(); assert.equal(q.snapshot().completed, 4);
});

test('background failures retry slowly after a failed burst and do not block other groups', async () => {
  let now = 0, failures = 0, others = 0;
  const q = new queueModule.BackgroundResourceQueue(() => now);
  q.enqueue('bad', 'weapons', async () => { failures++; if (failures < 3) throw Error('offline'); });
  q.enqueue('good', 'settings', async () => { others++; });
  q.start(0); q.tick(); await flush();
  assert.equal(failures, 1); assert.equal(others, 1);
  now = 9999; q.tick(); assert.equal(failures, 1);
  now = 10000; q.tick(); await flush(); assert.equal(failures, 2);
  now = 69999; q.tick(); assert.equal(failures, 2); assert.equal(q.snapshot().failed, 1);
  assert.match(q.snapshot('weapons').errors[0].message, /offline/);
  now = 70000; q.tick(); await flush(); assert.equal(failures, 3);
  assert.equal(q.snapshot().failed, 0); assert.equal(q.snapshot().completed, 2); assert.equal(q.snapshot().errors.length, 0);
});

test('pause and disposal stop new work and audio disabled after enqueue stays disabled', async () => {
  const q = new queueModule.BackgroundResourceQueue(() => 0), wait = deferred(), calls = [];
  q.enqueue('first', 'weapons', () => { calls.push('first'); return wait.promise; });
  q.enqueue('audio', 'sfx', async () => { calls.push('audio'); });
  q.setPriority('sfx', null); q.start(0); q.tick(); q.pause();
  q.enqueue('next', 'settings', async () => { calls.push('next'); });
  wait.resolve(); await flush(); q.tick(); assert.deepEqual(calls, ['first']);
  q.resume(); q.tick(); await flush(); assert.deepEqual(calls, ['first', 'next']);
  q.setPriority('sfx', 1); q.tick(); await flush(); assert.deepEqual(calls, ['first', 'next', 'audio']);
  const late = deferred(); q.enqueue('late', 'skins', () => late.promise); q.tick(); q.dispose();
  late.resolve(); await flush(); q.enqueue('after', 'skins', async () => calls.push('after')); q.resume(); q.tick();
  assert.equal(q.snapshot().total, 0); assert.equal(q.snapshot().active, 0); assert.equal(calls.length, 3);
});

test('module manifest covers panel assets but excludes heavy cosmetic and encounter catalogs', () => {
  const configs = manifest.backgroundConfigs(10), resources = new Map();
  for (const item of configs) {
    const config = json(item.path), found = manifest.collectBackgroundResources(config, item.group);
    resources.set(item.path, new Set(found.map(r => r.path)));
    assert.ok(found.length > 0, item.path);
    for (const r of found) {
      const base = projectPath('assets/resources', r.path.replace(/\/spriteFrame$/, ''));
      assert.ok(['.png', '.jpg', '.ttf', '.mp3', '.wav', '.ogg', '.effect'].some(ext => fs.existsSync(base + ext)), r.path);
    }
    if (config.roots) {
      const set = resources.get(item.path);
      const eligiblePaths = item.group === 'weapons' && config.roots.collection ? new Set(manifest.weaponPanelImagePaths(config)) : null;
      for (const image of Object.values(config.images)) {
        if (eligiblePaths && !eligiblePaths.has(image.path)) continue;
        assert.ok(set.has(image.path + '/spriteFrame'), image.path); assert.ok(set.has(image.path), 'native image: ' + image.path);
      }
      for (const bitmap of Object.values(config.bitmapFonts ?? {})) for (const page of bitmap.pages) {
        assert.ok(set.has(page + '/spriteFrame'), page); assert.ok(set.has(page), 'native font page: ' + page);
      }
      for (const bitmap of [config.bitmapFont, config.input?.bitmapFont]) for (const page of bitmap?.pages ?? []) {
        assert.ok(set.has(page + '/spriteFrame'), page); assert.ok(set.has(page), 'native policy font page: ' + page);
      }
    }
  }
  assert.equal(configs.filter(c => c.path.includes('characters/')).length, 0);
  for (const feature of manifest.BACKGROUND_FEATURES) assert.ok(configs.some(c => c.group === feature && c.path.endsWith('/config')), feature);
  assert.ok(configs.every(item => !/\/visuals$|\/characters\/|art\/maps\/|art\/stages\//.test(item.path)));
  assert.equal(new Set(manifest.RESOURCE_MODULE_ORDER).size, manifest.BACKGROUND_FEATURES.length);
  assert.equal(configs.flatMap(c => manifest.collectBackgroundResources(json(c.path), c.group)).some(r => r.kind === 'font'), false,
    'the current font policy renders Chinese with system fonts and uses bitmap pages instead of the legacy TTF paths');
  for (const track of ['main', 'contents']) assert.ok(resources.get('art/original-bgm/config').has(json('art/original-bgm/config')[track].path));
  assert.equal(manifest.collectBackgroundResources({ source: { path: 'art/unused' }, sounds: { unused: 'art/unused' } }, 'weapons').length, 0);
});

function preloaderFixture({ pendingConfig, pendingFrames = false, pendingDownloads = false, fail = false, failConfig = () => false, storage, usageKey } = {}) {
  let now = 0; const requests = [], downloads = [];
  const cc = { JsonAsset: class {}, SpriteFrame: class {}, ImageAsset: class {}, Font: class {}, AudioClip: class {}, EffectAsset: class {}, resources: { get: () => null }, assetManager: {
    loadAny(request, options, callback) {
      requests.push({ request, options, callback });
      if (request.type !== cc.JsonAsset) { if (!pendingFrames) callback(null, new request.type()); return; }
      if (pendingConfig) pendingConfig.promise.then(() => callback(null, { json: json(request.path) }));
      else if (fail || failConfig(request.path)) callback(Error('offline'));
      else callback(null, { json: json(request.path) });
    },
    preloadAny(request, options, callback) { downloads.push({ request, options, callback }); if(!pendingDownloads)callback(fail ? Error('offline') : null); },
  } };
  const { GameResourcePreloader } = load('GameResourcePreloader', { cc, '../session/PetSystem': { PET_COUNT: 10 },
    './BackgroundResourceQueue': queueModule, './FeatureResourceManifest': manifest });
  const { GameResourceLoader } = resourceModules(cc)('GameResourceLoader');
  const loader = new GameResourceLoader();
  const preloader = new GameResourcePreloader(loader, () => now, storage, usageKey);
  return { preloader, loader, requests, downloads, cc, time: value => { now = value; } };
}

test('core-stage prefetch uses only the first required panels and reuses their config later', async () => {
  for(const required of [['weapons','speedrun','settings','fish'],['settings']]){
    const h=preloaderFixture(),p=h.preloader;p.start(true);
    for(let n=0;n<350;n++){p.updateStartupDownloads(required);await flush();}
    const allowed=new Set(manifest.backgroundConfigs().filter(c=>required.slice(0,2).includes(c.group)).map(c=>c.path));
    assert.ok(h.downloads.length>0);
    assert.ok(h.requests.every(r=>r.request.type===h.cc.JsonAsset&&allowed.has(r.request.path)));
    const count=h.requests.length;await h.loader.loadJson(required[0]==='weapons'?'art/weapon-system/config':'art/settings-system/config');
    assert.equal(h.requests.length,count);assert.equal(p.snapshot().preparation.completed,0);
    const requests=count+h.downloads.length;p.pause();p.updateStartupDownloads(required);await flush();
    assert.equal(h.requests.length+h.downloads.length,requests);p.dispose();
  }
});

test('startup prefetch immediately downloads only the next two required panels without decoding or readiness', async () => {
  const h=preloaderFixture(),p=h.preloader,required=['weapons','speedrun','settings','fish'];p.start(true);
  for(let n=0;n<350;n++){p.updateStartupDownloads(required,'weapons');await flush();}
  assert.ok(h.downloads.length>0);assert.ok(h.downloads.some(r=>r.request.type===h.cc.ImageAsset));
  const allowed=new Set(manifest.backgroundConfigs().filter(c=>['speedrun','settings'].includes(c.group)).map(c=>c.path));
  assert.ok(h.requests.length>0);assert.ok(h.requests.every(r=>r.request.type===h.cc.JsonAsset&&allowed.has(r.request.path)));
  assert.equal(p.isFeatureReady('speedrun'),false);assert.equal(p.isFeatureReady('settings'),false);
  assert.equal(p.snapshot().preparation.active,0);assert.equal(p.snapshot().preparation.completed,0);
  for(let n=0;n<15;n++){p.updateStartupDownloads(required,'speedrun');await flush();}
  assert.ok(h.requests.some(r=>r.request.path==='art/fish-system/config'));
  const count=h.requests.length+h.downloads.length;p.updateStartupDownloads(required,'fish');await flush();
  assert.equal(h.requests.length+h.downloads.length,count,'no speculative dispatch after the last panel');p.dispose();
});

test('startup prefetch stays bounded, pauses between callbacks, shares foreground data and discards late discovery', async () => {
  const h=preloaderFixture({pendingDownloads:true}),p=h.preloader,required=['weapons','speedrun','settings'];p.start(true);
  for(let n=0;n<20;n++){p.updateStartupDownloads(required,'weapons');await flush();}
  assert.equal(h.downloads.length,2);assert.equal(p.snapshot().active,2);
  const requests=h.requests.length;await h.loader.loadJson('art/speedrun-system/config');assert.equal(h.requests.length,requests);
  p.pause();h.downloads.forEach(r=>r.callback(null));await flush();
  p.updateStartupDownloads(required,'weapons');assert.equal(h.downloads.length,2);
  p.resume();p.updateStartupDownloads(required,'weapons');assert.equal(h.downloads.length,4);
  p.dispose();h.downloads.slice(2).forEach(r=>r.callback(null));await flush();p.updateStartupDownloads(required,'weapons');assert.equal(h.downloads.length,4);
  const pending=deferred(),late=preloaderFixture({pendingConfig:pending});late.preloader.start(true);
  late.preloader.updateStartupDownloads(required,'weapons');late.preloader.dispose();pending.resolve();await flush();
  assert.equal(late.downloads.length,0);
});

test('a failed startup prefetch does not poison a foreground retry and runtime queues resume', async () => {
  let fail=true;const h=preloaderFixture({failConfig:()=>fail}),p=h.preloader;p.start(true);
  p.updateStartupDownloads(['weapons','speedrun','settings'],'weapons');await flush();assert.ok(p.snapshot().errors.length);
  fail=false;const value=await h.loader.loadJson('art/speedrun-system/config','background');assert.ok(value.roots);
  for(let n=0;n<800;n++){p.update(()=>true,true,true);await flush();}
  assert.equal(p.isFeatureReady('weapons'),true,'normal decoding resumes after startup');
  const q=p.queue;assert.equal(q.priorities.get('maps'),shared('ResourceLoadingPolicy').RESOURCE_LOADING_POLICY.background.priorities.maps);
  assert.equal(q.priorities.get('nextStage'),shared('ResourceLoadingPolicy').RESOURCE_LOADING_POLICY.background.priorities.nextStage);
  p.dispose();
});

test('preloader prepares every unlocked panel and leaves automatic summaries on demand', async () => {
  const h = preloaderFixture(), { preloader: p } = h;
  p.start(); const update = (bgm = false, sfx = false) => p.update(() => true, bgm, sfx);
  update(); assert.equal(h.requests.length, 1); assert.equal(h.downloads.length, 0);
  h.time(1000);
  for (let n = 0; n < 3600; n++) { update(); await flush(); }
  assert.equal(h.requests[0].request.path, 'art/weapon-system/config');
  assert.equal(h.requests.some(r => /original-(bgm|sfx)/.test(r.request.path)), false);
  assert.ok(h.downloads.every(r => r.request.type !== h.cc.JsonAsset));
  // A successful decode already owns its image; bulk download must not fetch it again.
  const frameRequests = h.requests.filter(r => r.request.type === h.cc.SpriteFrame);
  assert.ok(frameRequests.length > 0, 'common panels are actually parsed before their first click');
  const panelPaths = new Set(manifest.RESOURCE_MODULES.flatMap(module => manifest.collectBackgroundResources(json(module.config), module.name)).filter(r => r.kind === 'spriteFrame').map(r => r.path));
  assert.ok(frameRequests.every(r => panelPaths.has(r.request.path)), 'only panel dependencies may be decoded');
  assert.ok(h.requests.every(r => [h.cc.JsonAsset, h.cc.SpriteFrame].includes(r.request.type)));
  assert.equal(p.isFeatureReady('weapons'), true); assert.equal(p.isFeatureReady('settings'), true); assert.equal(p.isFeatureReady('speedrun'), true);
  for (const name of manifest.RESOURCE_MODULE_ORDER.filter(name => !['offline','dailyCheck'].includes(name))) {
    assert.equal(p.isFeatureReady(name), true, name); assert.equal(p.snapshot().features[name].eligible, true, name);
  }
  assert.equal(p.isFeatureReady('offline'), false); assert.equal(p.isFeatureReady('dailyCheck'), false);
  for (const { request, options } of [...h.requests, ...h.downloads]) {
    assert.equal(request.bundle, 'resources'); assert.equal(options.priority, -1); assert.equal(options.maxConcurrency, 2);
    assert.equal(options.maxRequestsPerFrame, 1); assert.equal(options.maxRetryCount, 0);
  }
  const paths = h.downloads.map(r => r.request.path); assert.equal(new Set(paths).size, paths.length, 'shared assets download once');
  assert.equal(p.snapshot().failed, 0);
  for (let n = 0; n < 100; n++) { update(true, true); await flush(); }
  assert.ok(h.downloads.some(r => r.request.type === h.cc.AudioClip));
  p.dispose();
});

test('locked weapons then challenge lead background downloads and decoding ahead of frequent ordinary panels', async () => {
  for (const phase of ['updateDownloads','updatePreparation']) {
    const h=preloaderFixture({storage:{getItem:()=>'{"settings":10,"fish":10,"speedrun":10}',setItem:()=>{}}}),p=h.preloader;
    p.start();h.time(1000);
    for(let n=0;n<1200;n++){p[phase](name=>name==='fish',false,false);await flush();}
    const configs=h.requests.map(r=>r.request.path).filter(path=>/^art\/[^/]+-system\/config$/.test(path));
    assert.deepEqual(configs.slice(0,3),['art/weapon-system/config','art/speedrun-system/config','art/settings-system/config'],phase);
    assert.equal(p.snapshot().features.speedrun.eligible,true);
    assert.equal(p.isFeatureReady('speedrun'),phase==='updatePreparation');
    assert.equal(h.requests.some(r=>r.request.path==='art/raid-system/config'),false);
    p.dispose();
  }
});

test('late config completion after disposal cannot enqueue or download assets', async () => {
  const wait = deferred(), h = preloaderFixture({ pendingConfig: wait }), p = h.preloader;
  p.start(); h.time(1000); p.update(() => true, true, true); assert.equal(h.requests.length, 1);
  p.dispose(); wait.resolve(); await flush(); p.update(() => true, true, true);
  assert.equal(h.downloads.length, 0); assert.equal(p.snapshot().total, 0);
});

test('downloads progress without any CPU preparation admission and respect locked content', async () => {
  const h=preloaderFixture(),p=h.preloader;p.start();h.time(1000);
  for(let i=0;i<1000;i++){p.updateDownloads(name=>name==='pets',false,false);await flush();}
  assert.ok(h.downloads.length>0);assert.ok(h.downloads.some(r=>r.request.type===h.cc.ImageAsset));
  assert.equal(h.requests.filter(r=>r.request.type===h.cc.SpriteFrame).length,0);
  assert.equal(p.isFeatureReady('pets'),false);assert.equal(h.requests.some(r=>r.request.path==='art/fish-system/config'),false);
  const downloaded=p.snapshot().features.pets;
  assert.equal(downloaded.downloadReady,true);assert.equal(downloaded.resourcesAcquired,true);assert.equal(downloaded.decodedReady,false);
  assert.equal(downloaded.downloads.completed,downloaded.downloads.total);assert.ok(downloaded.downloads.total>1);
  for(let i=0;i<500;i++){p.updatePreparation(name=>name==='pets');await flush();}
  assert.equal(p.isFeatureReady('pets'),true);assert.equal(p.snapshot().features.pets.decodedReady,true);p.dispose();
});

test('memory eviction suspends automatic reconstruction until a new foreground demand', async () => {
  const h=preloaderFixture(),p=h.preloader;p.start();h.time(1000);
  for(let i=0;i<800;i++){p.update(name=>name==='pets',false,false);await flush();}
  assert.equal(p.isFeatureReady('pets'),true);p.prioritize('pets');p.invalidate('pets');
  // Deduplicated textures may live under pet-system while also belonging to an
  // always-eligible module. Those shared resources can legitimately be reloaded.
  const common=new Set(manifest.backgroundConfigs().filter(item=>['weapons','speedrun','settings'].includes(item.group))
    .flatMap(item=>manifest.collectBackgroundResources(json(item.path),item.group).map(resource=>resource.path)));
  const petOnly=request=>request.request.path.startsWith('art/pet-system/')&&!common.has(request.request.path);
  const before=h.requests.filter(petOnly).length;
  for(let i=0;i<500;i++){p.update(name=>name==='pets',false,false);await flush();}
  assert.equal(p.isFeatureReady('pets'),false);assert.equal(p.snapshot().features.pets.eligible,false);
  assert.equal(h.requests.filter(petOnly).length,before);
  p.prioritize('pets');for(let i=0;i<300;i++){p.update(name=>name==='pets',false,false);await flush();}
  assert.equal(p.isFeatureReady('pets'),true);p.dispose();
});

test('warm-cache preparation and prefetch share one new resource admission per update', async () => {
  const h = preloaderFixture(), p = h.preloader;
  p.start(); h.time(2000);
  for (let i = 0; i < 80; i++) {
    const before = h.requests.length + h.downloads.length;
    p.update(() => true, true, true);
    await flush();
    assert.ok(h.requests.length + h.downloads.length - before <= 1, 'callbacks cannot refill either queue');
  }
  assert.ok(h.requests.length > 20); p.dispose();
});

test('a shared dispatch cap bounds synchronous failures as well as successful starts', async () => {
  const q = new queueModule.BackgroundResourceQueue(() => 2000); let calls = 0;
  for (let i = 0; i < 20; i++) q.enqueue(String(i), 'weapons', () => { calls++; throw Error('offline'); });
  q.start(0); assert.equal(q.tick(1), 1); assert.equal(calls, 1);
  assert.equal(q.tick(1), 1); assert.equal(calls, 2); q.dispose();
});

test('already loaded atlas-backed sprites need no standalone source image download', async () => {
  const h = preloaderFixture(), frame = {};
  h.cc.resources.get = (path, Type) => { assert.equal(path, 'art/maps/forest/border_up/spriteFrame'); assert.equal(Type, h.cc.SpriteFrame); return frame; };
  await h.preloader.download({ path: 'art/maps/forest/border_up', kind: 'image' });
  assert.equal(h.downloads.length, 0);
  h.preloader.dispose();
});

test('panel preparation waits for each decoded frame and shares it with first-use foreground loading', async () => {
  const h = preloaderFixture({ pendingFrames: true }), p = h.preloader;
  p.start(); h.time(1000);
  const update = () => p.update(() => false, false, false);
  for (let n = 0; n < 8; n++) { update(); await flush(); }
  const frames = () => h.requests.filter(r => r.request.type === h.cc.SpriteFrame);
  assert.equal(frames().length, 1, 'only one decoded frame may be in flight');
  assert.equal(p.snapshot().preparation.active, 1); assert.equal(p.isFeatureReady('weapons'), false);
  const first = frames()[0], foreground = h.loader.load(first.request.path, 'spriteFrame');
  assert.equal(frames().length, 1, 'foreground shares background asset request');
  const frame = new h.cc.SpriteFrame(); first.callback(null, frame);
  assert.equal(await foreground, frame); await flush();
  assert.equal(frames().length, 1, 'completion cannot dispatch the next frame');
  p.pause(); update(); assert.equal(frames().length, 1);
  p.resume(); update(); assert.equal(frames().length, 2);
  p.dispose(); frames()[1].callback(null, new h.cc.SpriteFrame()); await flush(); update();
  assert.equal(frames().length, 2); assert.equal(p.snapshot().preparation.total, 0); assert.equal(p.isFeatureReady('weapons'), false);
});

test('locked panels do not download and unlocking prepares their catalog and every font page', async () => {
  const h = preloaderFixture(), p = h.preloader;
  p.start(); h.time(1000);
  for (let n = 0; n < 650; n++) { p.update(() => false, false, false); await flush(); }
  assert.equal(p.isFeatureReady('pets'), false);
  assert.equal(h.requests.some(r => r.request.path === 'art/pet-system/config'), false);
  const before = h.requests.filter(r => r.request.type === h.cc.SpriteFrame).length;
  for (let n = 0; n < 150; n++) { p.update(name => name === 'pets', false, false); await flush(); }
  assert.equal(p.isFeatureReady('pets'), true);
  const petPaths = manifest.collectBackgroundResources(json('art/pet-system/config'), 'pets').filter(r => r.kind === 'spriteFrame');
  for (const item of petPaths) assert.equal(h.loader.hasLoaded(item.path, 'spriteFrame'), true, item.path);
  assert.ok(h.requests.filter(r => r.request.type === h.cc.SpriteFrame).length > before);
  assert.equal(p.isFeatureReady('fish'), false); assert.equal(p.snapshot().features.pets.errors.length, 0);
  p.dispose();
});

test('a panel whose config failed during early play recovers silently after cooldown', async () => {
  let attempts = 0;
  const h = preloaderFixture({ failConfig: path => path === 'art/settings-system/config' && ++attempts <= 2 }), p = h.preloader;
  p.start(); p.prioritize('settings'); h.time(1000);
  const update = () => p.update(name => name === 'settings', false, false);
  update(); await flush();
  assert.equal(p.isFeatureReady('settings'), false); assert.equal(attempts, 1);
  h.time(11000); update(); await flush();
  assert.equal(attempts, 2); assert.equal(p.snapshot().features.settings.failed, 1);
  assert.match(p.snapshot().features.settings.errors[0].message, /offline/);
  h.time(70999); update(); await flush(); assert.equal(attempts, 2);
  h.time(71000);
  for (let n = 0; n < 30; n++) { update(); await flush(); }
  assert.equal(attempts, 3); assert.equal(p.isFeatureReady('settings'), true);
  assert.equal(p.snapshot().features.settings.failed, 0); assert.equal(p.snapshot().features.settings.errors.length, 0);
  p.dispose();
});

test('used panels retain priority across launches without unlocking hidden content or mixing environments',async()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const first=preloaderFixture({storage,usageKey:'production'});first.preloader.recordUse('fish');first.preloader.recordUse('fish');first.preloader.dispose();
  const next=preloaderFixture({storage,usageKey:'production'}),testEnvironment=preloaderFixture({storage,usageKey:'test'});
  assert.equal(next.preloader.snapshot().usedFeatures.fish,2);assert.equal(testEnvironment.preloader.snapshot().usedFeatures.fish,undefined);
  const p=next.preloader;p.start();p.update(name=>name==='fish'||name==='pets',false,false);await flush();
  assert.equal(next.requests[0].request.path,'art/weapon-system/config','weapons start on the first eligible frame');
  assert.equal(next.downloads.length,0,'general download queue is still delayed');
  next.time(1000);
  for(let i=0;i<1200;i++){p.update(name=>name==='fish'||name==='pets',false,false);await flush();}
  const configs=next.requests.map(r=>r.request.path);
  assert.ok(configs.indexOf('art/fish-system/config')>=0);
  assert.ok(configs.indexOf('art/fish-system/config')<configs.indexOf('art/pet-system/config'),'previously used unlocked panels download first');
  assert.equal(p.isFeatureReady('fish'),true,'unlocked previously used panels prepare before their next click');
  assert.equal(p.isFeatureReady('raid'),false);p.dispose();testEnvironment.preloader.dispose();
});

test('invalid or unavailable usage storage cannot prevent resource preparation',()=>{
  for(const storage of [{getItem:()=>'{bad',setItem:()=>{throw Error('full');}},
    {getItem:()=>'{"weapons":-1,"fish":1000000,"pets":"3","unknown":99}',setItem:()=>{}},
    {getItem:()=>{throw Error('unavailable');},setItem:()=>{throw Error('unavailable');}}]){
    const h=preloaderFixture({storage});h.preloader.recordUse('weapons');h.preloader.start();h.preloader.update(()=>false,false,false);
    assert.equal(h.requests[0].request.path,'art/weapon-system/config');
    assert.ok((h.preloader.snapshot().usedFeatures.fish??0)<=10);h.preloader.dispose();
  }
});

test('offline and daily check decode only on explicit demand, ahead of common panels', async () => {
  const h = preloaderFixture(), p = h.preloader;
  p.start(); h.time(1000); p.setDemand('dailyCheck', true);
  p.update(() => true, false, false); await flush();
  assert.equal(h.requests[0].request.path, 'art/daily-check-system/config');
  assert.equal(p.snapshot().features.dailyCheck.eligible, true);
  p.setDemand('dailyCheck', false);
  p.update(() => true, false, false); await flush();
  assert.equal(p.snapshot().features.dailyCheck.eligible, false);
  assert.equal(h.requests[1].request.path, 'art/weapon-system/config');
  p.setDemand('offline', true);
  for (let i = 0; i < 40; i++) { p.update(() => true, false, false); await flush(); }
  assert.equal(p.isFeatureReady('offline'), true);
  assert.equal(p.isFeatureReady('dailyCheck'), false, 'withdrawn demand cannot start the remaining pages');
  p.dispose();
});

test('diagnostic modes retain downloads while pausing speculative decoding and can resume without duplicate loads', async () => {
  const h = preloaderFixture(), p = h.preloader, calls = [];
  p.setMode('download-only'); p.start(); h.time(1000);
  p.prepareBattle(['art/next-map'], async path => { calls.push(path); });
  for (let i = 0; i < 3600; i++) { p.update(() => true, false, false); await flush(); }
  assert.equal(p.mode, 'download-only'); assert.equal(p.snapshot().mode, 'download-only');
  assert.equal(h.requests.filter(r => r.request.type === h.cc.SpriteFrame).length, 0);
  assert.equal(calls.length, 0);
  assert.ok(h.downloads.some(r => r.request.path === 'art/next-map' && r.request.type === h.cc.ImageAsset));
  assert.ok(h.downloads.some(r => r.request.path === 'art/next-map/spriteFrame'));
  p.setMode('decode');
  for (let i = 0; i < 3600; i++) { p.update(() => true, false, false); await flush(); }
  assert.equal(p.isFeatureReady('weapons'), true); assert.deepEqual(calls, ['art/next-map']);
  assert.equal(p.isFeatureReady('raid'), true);
  const before = h.requests.length; p.setMode('full');
  for (let i = 0; i < 20; i++) { p.update(() => true, false, false); await flush(); }
  assert.equal(h.requests.length, before, 'changing UI mode cannot reload parsed assets');
  p.setMode('download-only'); p.prioritize('pets');
  for (let i = 0; i < 100; i++) { p.update(() => true, false, false); await flush(); }
  assert.equal(p.isFeatureReady('pets'), true, 'user demand is not disabled by a background diagnostic mode');
  p.dispose();
});

test('battle preparation shares the single decode slot, frame admission, pause and disposal', async () => {
  const h = preloaderFixture(), p = h.preloader;
  p.start(); h.time(1000);
  for (let i = 0; i < 3600; i++) { p.update(() => false, false, false); await flush(); }
  const calls = [], pending = [];
  const loadFrame = path => { calls.push(path); const task = deferred(); pending.push(task); return task.promise; };
  p.prepareBattle(['art/next-a', 'art/next-b', 'art/next-a'], loadFrame);
  p.prepareBattle(['art/next-a'], loadFrame);
  assert.equal(calls.length, 0, 'enqueue does not execute speculative work');
  p.update(() => false, false, false); assert.deepEqual(calls, ['art/next-a']);
  p.update(() => false, false, false); assert.equal(calls.length, 1, 'only one actual decode may run');
  p.pause(); pending[0].resolve(); await flush();
  p.update(() => false, false, false); assert.equal(calls.length, 1);
  p.resume(); p.update(() => false, false, false); assert.deepEqual(calls, ['art/next-a', 'art/next-b']);
  p.prepareBattle(['art/next-c'], loadFrame); p.dispose(); pending[1].resolve(); await flush();
  p.update(() => false, false, false); assert.equal(calls.length, 2);
  assert.equal(p.snapshot().battle.total, 0);
});


test('upcoming eligibility warms only selected locked panels and withdrawn eligibility stops new work',async()=>{
  const h=preloaderFixture(),p=h.preloader;p.start();h.time(1000);
  for(let n=0;n<650;n++){p.update(()=>false,false,false);await flush();}
  p.setUpcoming('pets',true);p.update(()=>false,false,false);await flush();
  assert.equal(p.snapshot().features.pets.eligible,true);
  p.setUpcoming('pets',false);p.update(()=>false,false,false);await flush();
  assert.equal(p.snapshot().features.pets.eligible,false);assert.equal(p.isFeatureReady('pets'),false);
  p.setUpcoming('pets',true);
  for(let n=0;n<300;n++){p.update(()=>false,false,false);await flush();}
  assert.equal(p.isFeatureReady('pets'),true);assert.equal(p.isFeatureReady('fish'),false);
  assert.equal(h.requests.some(r=>r.request.path==='art/fish-system/config'),false);
  const before=h.requests.length;p.setUpcoming('pets',false);
  for(let n=0;n<300;n++){p.update(name=>name==='pets',false,false);await flush();}
  assert.equal(p.isFeatureReady('pets'),true);assert.equal(h.requests.length,before,'unlock reuses the warmed resources');p.dispose();
});
