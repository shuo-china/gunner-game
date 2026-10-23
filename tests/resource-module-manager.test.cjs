const test = require('node:test');
const assert = require('node:assert/strict');
const { ResourceModuleManager } = require('./support/resource-modules.cjs').resourceModules()('ResourceModuleManager');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;});return {promise,resolve,reject}; };
const flush = () => new Promise(setImmediate);

test('asset lookahead never publishes a view and a foreground prepare shares in-flight assets', async () => {
  const pending=deferred(),built=deferred();let loads=0,creates=0;
  const manager=new ResourceModuleManager();
  manager.register('panel',{load:()=>{loads++;return pending.promise;},create:async()=>{creates++;await built.promise;}});
  const assets=manager.prepareAssets('panel');await flush();
  assert.equal(manager.prepareAssets('panel'),assets);assert.equal(manager.invalidate('panel'),false);
  const opening=manager.prepare('panel');await flush();assert.equal(loads,1);assert.equal(creates,0);
  pending.resolve({});await assets;await flush();
  assert.equal(manager.isAssetReady('panel'),true);assert.equal(manager.isViewReady('panel'),false);assert.equal(creates,1);
  built.resolve();await opening;assert.equal(manager.isViewReady('panel'),true);
  const other=new ResourceModuleManager();let builtOther=0;
  other.register('other',{load:async()=>42,create:async()=>{builtOther++;}});
  await other.prepareAssets('other');assert.equal(other.snapshot().other.state,'loaded');
  assert.equal(other.isViewReady('other'),false);assert.equal(builtOther,0);
  await other.prepare('other');assert.equal(builtOther,1);
});

test('failed lookahead is retryable and late assets cannot publish after disposal', async () => {
  const manager=new ResourceModuleManager();let loads=0,creates=0;
  manager.register('panel',{load:async()=>{if(++loads===1)throw Error('download failed');return 42;},create:async()=>{creates++;}});
  await assert.rejects(manager.prepareAssets('panel'),/download failed/);
  assert.equal(manager.isViewReady('panel'),false);
  await manager.prepare('panel');assert.equal(loads,2);assert.equal(creates,1);
  const pending=deferred();let valid;
  manager.register('late',{load:current=>{valid=current;return pending.promise;},create:async()=>{throw Error('must not create');}});
  const late=manager.prepareAssets('late');await flush();const rejected=assert.rejects(late,/invalidated/);
  manager.dispose();assert.equal(valid(),false);pending.resolve(42);await rejected;
  assert.equal(manager.isAssetReady('late'),false);assert.equal(manager.snapshot().late.assetReady,false);
});

test('asset lookahead cannot construct view dependencies or bypass their readiness', async () => {
  const manager=new ResourceModuleManager();let loads=0,creates=0;
  manager.register('inventory',{load:async()=>{},create:async()=>{creates++;}});
  manager.register('collection',{dependencies:['inventory'],load:async()=>{loads++;},create:async()=>{creates++;}});
  await assert.rejects(manager.prepareAssets('collection'),/dependencies not ready/);
  assert.equal(loads,0);assert.equal(creates,0);
  await manager.prepare('collection');assert.equal(loads,1);assert.equal(creates,2);
});

test('startup, background and foreground reuse one asset and view task; persistence never blocks readiness', async () => {
  const load = deferred(), create = deferred(), priority = [], usage = []; let loads = 0, creates = 0;
  const manager = new ResourceModuleManager({onPrioritize:name=>priority.push(name),onUse:name=>usage.push(name)});
  manager.register('fish',{load:()=>{loads++;return load.promise;},create:async (assets,valid)=>{assert.equal(assets,42);assert.equal(valid(),true);creates++;await create.promise;}});
  manager.setPersistence('fish','pending');
  const startup=manager.prepare('fish'); await flush();
  assert.equal(manager.prepare('fish',{foreground:true}),startup);const clicked=manager.open('fish');
  assert.equal(loads,1);assert.equal(creates,0);assert.equal(manager.snapshot().fish.assetReady,false);
  load.resolve(42);await flush();assert.equal(manager.snapshot().fish.assetReady,true);assert.equal(manager.isViewReady('fish'),false);
  assert.equal(manager.snapshot().fish.persistence,'pending');assert.equal(creates,1);
  create.resolve();await startup;await clicked;
  assert.equal(manager.isViewReady('fish'),true);assert.deepEqual(usage,['fish']);assert.ok(priority.includes('fish'));
  await manager.prepare('fish');assert.equal(creates,1);assert.equal(loads,1);
});

test('stopping a startup wait leaves the original task alive and a later click joins it', async () => {
  const delayed=deferred();let loads=0,creates=0;const manager=new ResourceModuleManager();
  manager.register('raid',{load:()=>{loads++;return delayed.promise;},create:async()=>{creates++;}});
  const startup=manager.prepare('raid');await flush();
  assert.equal(await Promise.race([startup.then(()=>false),Promise.resolve(true)]),true);
  assert.equal(manager.prepare('raid',{foreground:true}),startup);
  delayed.resolve({});await startup;assert.equal(loads,1);assert.equal(creates,1);
});

test('failed view creation retries with its loaded assets, while memory eviction reloads them', async () => {
  let loads=0,creates=0,disposals=0;const manager=new ResourceModuleManager();
  manager.register('pets',{load:async()=>++loads,create:async()=>{if(++creates===1)throw Error('create failed');},dispose:()=>disposals++});
  await assert.rejects(manager.prepare('pets'),/create failed/);assert.equal(manager.snapshot().pets.assetReady,true);
  await manager.prepare('pets');assert.equal(loads,1);assert.equal(creates,2);
  manager.setPersistence('pets','persisted');assert.equal(manager.invalidate('pets'),true);assert.equal(manager.isViewReady('pets'),false);
  assert.equal(manager.snapshot().pets.persistence,'persisted');await manager.prepare('pets');assert.equal(loads,2);assert.equal(disposals,1);
});

test('running tasks cannot be evicted and disposal invalidates a queued publication', async () => {
  const built=deferred();let valid,published=false;const manager=new ResourceModuleManager();
  manager.register('skins',{load:async()=>({}),create:async(_,current)=>{valid=current;await built.promise;if(current())published=true;}});
  const request=manager.prepare('skins');await flush();assert.equal(manager.invalidate('skins'),false);assert.equal(valid(),true);
  const rejected=assert.rejects(request,/invalidated/);manager.dispose();assert.equal(valid(),false);built.resolve();await rejected;
  assert.equal(published,false);assert.equal(manager.isViewReady('skins'),false);
});

test('dependencies share results and are promoted; dependency cycles fail instead of hanging', async () => {
  const priority=[],order=[];const manager=new ResourceModuleManager({onPrioritize:name=>priority.push(name)});
  manager.register('shared',{load:async()=>{order.push('shared:load');},create:async()=>{order.push('shared:view');}});
  manager.register('panel',{dependencies:['shared'],load:async()=>{order.push('panel:load');},create:async()=>{order.push('panel:view');}});
  await manager.open('panel');assert.deepEqual(order,['shared:load','shared:view','panel:load','panel:view']);assert.ok(priority.includes('shared'));
  manager.register('a',{dependencies:['b'],load:async()=>{},create:async()=>{}});
  manager.register('b',{dependencies:['a'],load:async()=>{},create:async()=>{}});
  await assert.rejects(manager.open('a'),/Cyclic/);
});
