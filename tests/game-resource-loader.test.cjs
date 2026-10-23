const test = require('node:test');
const assert = require('node:assert/strict');
const { resourceModules } = require('./support/resource-modules.cjs');

function fixture(timeoutMs) {
  const requests = [], downloads = [], cached = new Map();
  const cc = { SpriteFrame: class {}, ImageAsset: class {}, AudioClip: class {}, EffectAsset: class {}, JsonAsset: class {},
    resources: {
      load(path, type, callback) { requests.push({ path, type, callback, profile: 'foreground' }); },
      get(path, type) { return cached.get(type)?.get(path) ?? null; },
    },
    assetManager: {
      loadAny(request, options, callback) { requests.push({ ...request, options, callback, profile: 'background' }); },
      preloadAny(request, options, callback) { downloads.push({ ...request, options, callback }); },
    },
  };
  const { GameResourceLoader } = resourceModules(cc)('GameResourceLoader');
  return { loader: new GameResourceLoader(timeoutMs), requests, downloads, cc, cached };
}

test('startup prefetch and JSON discovery cannot apply gameplay throttles to the shared engine queue', async () => {
  const {loader,requests,downloads,cc}=fixture();loader.setStartupPhase(true);
  cc.assetManager.downloader={maxConcurrency:15,maxRequestsPerFrame:15};
  const config=loader.loadJson('art/next/config','background'),preload=loader.preload('art/next/image','image');
  for(const request of [requests[0],downloads[0]]){
    assert.equal(request.options.maxConcurrency,15);assert.equal(request.options.maxRequestsPerFrame,15);
    assert.equal(request.options.priority,-1);assert.equal(request.options.maxRetryCount,0);
  }
  requests[0].callback(null,{json:{ready:true}});downloads[0].callback(null);await Promise.all([config,preload]);
  loader.setStartupPhase(false);
  const background=loader.loadJson('art/later/config','background'),later=loader.preload('art/later/image','image');
  for(const request of [requests[1],downloads[1]]){
    assert.equal(request.options.maxConcurrency,2);assert.equal(request.options.maxRequestsPerFrame,1);
  }
  requests[1].callback(null,{json:{ready:true}});downloads[1].callback(null);await Promise.all([background,later]);
});

test('typed loads share pending requests and successful assets without mixing types', async () => {
  const { loader, requests, cc } = fixture();
  const first = loader.load('art/shared', 'audio'), same = loader.load('art/shared', 'audio');
  assert.equal(first, same); assert.equal(requests.length, 1);
  assert.equal(loader.hasLoaded('art/shared', 'audio'), false);
  const effect = loader.load('art/shared', 'effect');
  assert.equal(requests.length, 2); assert.equal(requests[0].type, cc.AudioClip); assert.equal(requests[1].type, cc.EffectAsset);
  const clip = new cc.AudioClip(), shader = new cc.EffectAsset();
  requests[0].callback(null, clip); requests[1].callback(null, shader);
  assert.equal(await first, clip); assert.equal(await same, clip); assert.equal(await effect, shader);
  assert.equal(await loader.load('art/shared', 'audio'), clip); assert.equal(requests.length, 2);
  assert.equal(loader.hasLoaded('art/shared', 'audio'), true);
});

test('live startup diagnostics show only unfinished requests, preserve failures, and clear them on retry', async () => {
  const {loader,requests,downloads,cc}=fixture(20);
  const preload=loader.preload('art/next/image','image');
  const slow=loader.load('art/maps/forest/ground/spriteFrame','spriteFrame');
  const fast=loader.loadJson('art/hud/config');
  assert.equal(loader.load('art/maps/forest/ground/spriteFrame','spriteFrame'),slow);
  let state=loader.loadingStatus(Date.now()+5000);
  assert.equal(state.pending.length,3);assert.equal(state.pending[0].preload,true);
  assert.ok(state.pending[1].elapsedMs>=5000);assert.equal(state.completed,0);
  state.pending[1].path='changed';assert.equal(loader.loadingStatus().pending[1].path,'art/maps/forest/ground/spriteFrame');
  requests[1].callback(null,{json:{ready:true}});await fast;
  downloads[0].callback(null);await preload;
  state=loader.loadingStatus();assert.equal(state.pending.length,1);assert.equal(state.completed,1);
  const failed=assert.rejects(slow,/HTTP 404/);requests[0].callback(Error('HTTP 404'));await failed;
  state=loader.loadingStatus();assert.equal(state.pending.length,0);
  assert.equal(state.failure.path,'art/maps/forest/ground/spriteFrame');assert.match(state.failure.reason,/HTTP 404/);
  const retry=loader.load('art/maps/forest/ground/spriteFrame','spriteFrame');assert.equal(loader.loadingStatus().failure,undefined);
  requests[2].callback(null,new cc.SpriteFrame());await retry;
  assert.equal(loader.loadingStatus().completed,2);assert.equal(loader.loadingStatus().pending.length,0);
  loader.setStartupPhase(true);
  await assert.rejects(loader.load('art/stalled','image'),/timed out/);
  assert.equal(loader.loadingStatus().pending.length,0);assert.match(loader.loadingStatus().failure.reason,/timed out/);
});

test('a failed load reports its path, never retries itself, and clears only its own request', async () => {
  const { loader, requests, cc } = fixture();
  const broken = loader.load('art/broken', 'effect'), healthy = loader.load('art/good', 'effect');
  const rejected = assert.rejects(broken, /art\/broken.*offline/);
  requests[0].callback(Error('offline')); requests[1].callback(null, new cc.EffectAsset());
  await rejected; await healthy;
  assert.equal(requests.length, 2); assert.equal(loader.hasLoaded('art/broken', 'effect'), false);
  const retry = loader.load('art/broken', 'effect'); assert.notEqual(retry, broken); assert.equal(requests.length, 3);
  requests[2].callback(null, new cc.EffectAsset()); await retry;
  await loader.load('art/good', 'effect'); assert.equal(requests.length, 3);
});

test('background JSON discovery shares its parsed value with foreground callers', async () => {
  const { loader, requests, cc } = fixture();
  const background = loader.loadJson('art/panel/config', 'background');
  const foreground = loader.loadJson('art/panel/config');
  assert.equal(requests.length, 1); assert.equal(requests[0].type, cc.JsonAsset);
  assert.equal(requests[0].profile, 'background'); assert.equal(requests[0].bundle, 'resources');
  assert.equal(requests[0].options.priority, -1); assert.equal(requests[0].options.maxRetryCount, 0);
  const value = { images: { example: 'art/item' } };
  requests[0].callback(null, { json: value });
  assert.equal(await background, value); assert.equal(await foreground, value);
  assert.equal(await loader.loadJson('art/panel/config'), value); assert.equal(requests.length, 1);
});

test('missing JSON data is not cached and a later request can recover', async () => {
  const { loader, requests } = fixture();
  for (const json of [null, undefined]) {
    const request = loader.loadJson('art/invalid');
    const rejected = assert.rejects(request, /art\/invalid/);
    requests.at(-1).callback(null, { json }); await rejected;
  }
  assert.equal(requests.length, 2);
  const retry = loader.loadJson('art/invalid'); requests.at(-1).callback(null, { json: { valid: true } });
  assert.deepEqual(await retry, { valid: true }); assert.equal(requests.length, 3);
});

test('preloading is deduplicated but cannot mark a frame loaded or block a foreground load', async () => {
  const { loader, requests, downloads, cc } = fixture();
  const path = 'art/panel/spriteFrame';
  const preload = loader.preload(path, 'spriteFrame');
  assert.equal(loader.preload(path, 'spriteFrame'), preload); assert.equal(downloads.length, 1);
  const foreground = loader.load(path, 'spriteFrame');
  assert.equal(requests.length, 1, 'foreground starts without waiting for background completion');
  downloads[0].callback(null); await preload;
  assert.equal(loader.hasLoaded(path, 'spriteFrame'), false);
  const frame = new cc.SpriteFrame(); requests[0].callback(null, frame); assert.equal(await foreground, frame);
  assert.equal(loader.hasLoaded(path, 'spriteFrame'), true);
  await loader.preload(path, 'spriteFrame'); assert.equal(downloads.length, 1);
});

test('failed preloads can retry without invalidating a successful load', async () => {
  const { loader, downloads, requests, cc } = fixture();
  const preload = loader.preload('art/retry', 'audio');
  const failure = assert.rejects(preload, /art\/retry.*offline/);
  downloads[0].callback(Error('offline')); await failure; assert.equal(downloads.length, 1);
  const retry = loader.preload('art/retry', 'audio'); assert.equal(downloads.length, 2);
  downloads[1].callback(null); await retry;
  assert.equal(loader.hasLoaded('art/retry', 'audio'), false);
  const load = loader.load('art/retry', 'audio'); requests[0].callback(null, new cc.AudioClip()); await load;
  assert.equal(loader.hasLoaded('art/retry', 'audio'), true);
});

test('readiness recognizes frames already loaded by the engine', () => {
  const { loader, cached, cc } = fixture();
  cached.set(cc.SpriteFrame, new Map([['art/atlas/spriteFrame', new cc.SpriteFrame()]]));
  assert.equal(loader.hasLoaded('art/atlas/spriteFrame', 'spriteFrame'), true);
  assert.equal(loader.hasLoaded('art/atlas/spriteFrame', 'image'), false);
});

test('memory eviction and destroyed engine assets cannot reuse a permanently cached promise', async () => {
  const {loader,requests,cc}=fixture();const path='art/idle/spriteFrame';
  const first=loader.load(path,'spriteFrame');const frame=new cc.SpriteFrame();requests[0].callback(null,frame);await first;
  loader.invalidate(path,'spriteFrame');assert.equal(loader.hasLoaded(path,'spriteFrame'),false);
  const reloaded=loader.load(path,'spriteFrame');assert.notEqual(reloaded,first);assert.equal(requests.length,2);
  const second=new cc.SpriteFrame();requests[1].callback(null,second);await reloaded;second.isValid=false;
  const third=loader.load(path,'spriteFrame');assert.equal(requests.length,3);requests[2].callback(null,new cc.SpriteFrame());await third;
});

test('an invalidated pending request cannot restore released cache ownership on late completion', async () => {
  const {loader,requests,cc}=fixture();const path='art/idle/spriteFrame';const stale=loader.load(path,'spriteFrame');
  loader.invalidate(path,'spriteFrame');const fresh=loader.load(path,'spriteFrame');
  requests[0].callback(null,new cc.SpriteFrame());await stale;assert.equal(loader.hasLoaded(path,'spriteFrame'),false);
  const frame=new cc.SpriteFrame();requests[1].callback(null,frame);await fresh;
  assert.equal(await loader.load(path,'spriteFrame'),frame);assert.equal(requests.length,2);
});

test('a stalled background load times out, permits retry and ignores the obsolete callback', async () => {
  const { loader, requests, cc } = fixture(10);
  const stale = loader.load('art/stalled/spriteFrame', 'spriteFrame', 'background');
  await assert.rejects(stale, /art\/stalled\/spriteFrame.*timed out/);
  assert.equal(loader.hasLoaded('art/stalled/spriteFrame', 'spriteFrame'), false);
  const retry = loader.load('art/stalled/spriteFrame', 'spriteFrame');
  assert.equal(requests.length, 2);
  requests[0].callback(null, new cc.SpriteFrame());
  assert.equal(loader.hasLoaded('art/stalled/spriteFrame', 'spriteFrame'), false);
  const frame = new cc.SpriteFrame(); requests[1].callback(null, frame);
  assert.equal(await retry, frame);
  assert.equal(await loader.load('art/stalled/spriteFrame', 'spriteFrame'), frame);
});

test('a stalled download releases its cache slot for a subsequent background retry', async () => {
  const { loader, downloads } = fixture(10);
  await assert.rejects(loader.preload('art/stalled', 'image'), /timed out/);
  const retry = loader.preload('art/stalled', 'image');
  downloads[0].callback(Error('late failure'));
  assert.equal(loader.preload('art/stalled', 'image'), retry);
  downloads[1].callback(null); await retry;
});

test('download diagnostics distinguish network, cache pipeline and image decode without changing callbacks or tasks',()=>{
  const {installResourceTiming}=resourceModules()('GameResourceLoader');let now=0,request,parsed;
  const task={abort(){}},network={downloadFile(options){assert.equal(this,network);request=options;return task;}};
  const manager={downloader:{download(id,url,type,options,done){assert.equal(this,manager.downloader);done(null,'local-path');}},
    parser:{parse(id,file,type,options,done){parsed=done;}},
    cacheManager:{cacheEnabled:true,cachedFiles:{_map:{one:{}}},cacheQueue:{two:{}},outOfStorage:false}};
  const timing=installResourceTiming(manager,network,()=>now),once=manager.downloader.download;
  assert.equal(installResourceTiming(manager,network,()=>now),timing);assert.equal(manager.downloader.download,once);
  let value;manager.downloader.download('id','remote.png','.png',{},(err,result)=>{assert.equal(err,null);value=result;});
  assert.equal(value,'local-path');assert.equal(timing.snapshot().phases.networkDownload.started,0,'a local cache read is not a network request');
  manager.parser.parse('id','local','.png',{},()=>{});now=7;parsed(null,{});
  assert.equal(timing.snapshot().phases.imageDecode.totalMs,7);
  let success;assert.equal(network.downloadFile({success:result=>success=result}),task);now=20;
  const result={statusCode:200};request.success(result);assert.equal(success,result);
  assert.equal(timing.snapshot().phases.networkDownload.totalMs,13);
  network.downloadFile({});request.fail(Error('offline'));assert.equal(timing.snapshot().phases.networkDownload.failed,1);
  assert.equal(timing.snapshot().cache.saved,1);assert.equal(timing.snapshot().cache.pendingWrites,1);
  const copy=timing.snapshot();copy.phases.imageDecode.totalMs=100;assert.equal(timing.snapshot().phases.imageDecode.totalMs,7);
});

test('cache audit treats index entries and pending writes as unverified until actual file access succeeds',()=>{
  const {createCacheFileAudit}=resourceModules()('GameResourceLoader');
  const pending=[], cache={cachedFiles:{_map:{a:{url:'wxfile://a'},b:{url:'wxfile://b'}}},cacheQueue:{c:{}}};
  const audit=createCacheFileAudit({getFileSystemManager:()=>({access:options=>pending.push(options)})},()=>10);
  const before=audit(cache);assert.equal(before.present,0);assert.equal(before.checking,2);assert.equal(before.unverified,2);
  pending[0].success();pending[1].fail();
  const after=audit(cache);assert.equal(after.present,1);assert.equal(after.missing,1);assert.equal(after.checking,0);
  assert.equal(cache.cachedFiles._map.b.url,'wxfile://b','diagnostics must not mutate the Cocos cache index');
  assert.equal(pending.length,2,'fresh access results are reused');
  assert.equal(createCacheFileAudit()(cache).unverified,2,'unsupported hosts cannot claim persistent cache hits');
});

test('cache file audits bound asynchronous IO, expire stale evidence and ignore replaced paths or old callbacks',()=>{
  const {createCacheFileAudit}=resourceModules()('GameResourceLoader');let now=0;
  const pending=[], entries=Object.fromEntries(Array.from({length:8},(_,i)=>['id'+i,{url:'wxfile://'+i}]));
  const cache={cachedFiles:{_map:entries}}, audit=createCacheFileAudit({getFileSystemManager:()=>({access:o=>pending.push(o)})},()=>now);
  audit(cache);assert.equal(pending.length,4);audit(cache);assert.equal(pending.length,4);
  entries.id0.url='wxfile://replacement';pending[0].success();
  pending[1].success();pending[2].fail();pending[3].success();
  const next=audit(cache);assert.equal(next.present,2);assert.equal(next.missing,1);assert.equal(next.checking,4);
  const replacement=pending[4];assert.equal(replacement.path,'wxfile://replacement');
  now=6000;audit(cache);const latest=pending.findLast(p=>p.path==='wxfile://replacement');
  assert.notEqual(latest,replacement);replacement.success();assert.equal(audit(cache).present,2,'expired callback must not verify a replacement probe');
  latest.success();assert.equal(audit(cache).present,3);
  now=40000;assert.equal(audit(cache).present,0,'old file existence must be rechecked');
});

test('resource diagnostics retain bounded long decode records with resource identity, without equating wall time to CPU',()=>{
  const {installResourceTiming}=resourceModules()('GameResourceLoader');let now=0,done;
  const timing=installResourceTiming({parser:{parse(id,file,type,options,callback){done=callback;}}},undefined,()=>now);
  // Use the wrapped owner from a separate instance to execute real callbacks.
  const manager={parser:{parse(id,file,type,options,callback){done=callback;}}};
  const observed=installResourceTiming(manager,undefined,()=>now);
  for(let i=0;i<70;i++) {manager.parser.parse('image-'+i+'?token=private','local','.png',{},()=>{});now+=20;done(null,{});done(null,{});}
  const state=observed.snapshot();assert.equal(state.longOperations.length,64);assert.equal(state.phases.imageDecode.started,70);
  assert.equal(state.phases.imageDecode.active,0);assert.equal(state.longOperations[0].resource,'image-6');
  assert.equal(state.longOperations[0].durationMs,20);assert.equal(state.longOperations[0].phase,'imageDecode');
  state.longOperations[0].durationMs=0;assert.equal(observed.snapshot().longOperations[0].durationMs,20);
  assert.equal(timing.snapshot().longOperations.length,0);
});


test('startup foreground requests time out, retry independently, and ignore the expired callback', async () => {
  const {loader, requests, cc}=fixture(10);loader.setStartupPhase(true);
  const first=loader.load('art/startup-panel','spriteFrame');
  await assert.rejects(first,/Startup resource request timed out/);
  const second=loader.load('art/startup-panel','spriteFrame'),fresh=new cc.SpriteFrame();
  requests[0].callback(null,new cc.SpriteFrame());assert.equal(loader.hasLoaded('art/startup-panel','spriteFrame'),false);
  requests[1].callback(null,fresh);assert.equal(await second,fresh);
  loader.setStartupPhase(false);
  const runtime=loader.loadJson('art/later/config');await new Promise(resolve=>setTimeout(resolve,20));
  requests[2].callback(null,{json:{ok:true}});assert.equal((await runtime).ok,true);
});
