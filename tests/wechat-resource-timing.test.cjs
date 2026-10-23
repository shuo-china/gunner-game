const test=require('node:test');
const assert=require('node:assert/strict');
const {createTiming}=require('./support/wechat-resource-timing.cjs');
const {resourceModules}=require('./support/resource-modules.cjs');

test('early diagnostics are read-only and preserved when engine resource timing is installed later',()=>{
  let now=100;
  const wx={loadSubpackage(){},downloadFile(){}},load=wx.loadSubpackage,download=wx.downloadFile;
  const h=createTiming({Date:{now:()=>now},wx});
  assert.equal(wx.loadSubpackage,load);assert.equal(wx.downloadFile,download);
  h.exports.publishEarlySnapshot();
  assert.ok(Object.isFrozen(h.scope.__forestGunnerLoading));assert.ok(Object.isFrozen(h.api));
  const finish=h.exports.beginPackage('forest-startup-metadata','startup-index');now=180;finish('success');
  const early=h.scope.__forestGunnerLoading.snapshot();
  assert.equal(early.startup.phase,'platform-loader');assert.equal(early.timings.resources.phases.platformSubpackage.totalMs,80);
  const {installResourceTiming}=resourceModules({}, {__forestGunnerPlatformTiming:h.api})('GameResourceLoader');
  now=500;const timing=installResourceTiming({},undefined,()=>now),state=timing.snapshot();
  assert.equal(state.platform.startedAt,100);assert.equal(state.phases.platformSubpackage.totalMs,80);
  assert.equal(state.phases.networkDownload.started,0,'a platform package call does not prove a network transfer');
  assert.match(state.platform.subpackageMeaning,/unknown/);
  state.phases.platformSubpackage.totalMs=0;state.platform.packages[0].attempts=999;
  assert.equal(timing.snapshot().phases.platformSubpackage.totalMs,80);assert.equal(h.api.snapshot().packages[0].attempts,1);
  const live=Object.freeze({snapshot:()=>({live:true})});h.scope.__forestGunnerLoading=live;
  h.exports.publishEarlySnapshot();assert.equal(h.scope.__forestGunnerLoading,live,'early evidence cannot replace a running game API');
});

test('subpackage retries, reusable outcomes and late callbacks are counted separately without double settlement',()=>{
  let now=0;const h=createTiming({Date:{now:()=>now}}),name='forest-feature-weapons-0';
  const first=h.exports.beginPackage(name,'metadata-shared');h.exports.reusePackage(name);
  now=15000;first('timeout');h.exports.reusePackage(name);
  const second=h.exports.beginPackage(name,'metadata-shared');first('success');first('failed');
  now=15012;second('success');h.exports.reusePackage(name);
  const s=h.api.snapshot(),total=s.phases.platformSubpackage,p=s.packages[0];
  assert.deepEqual({...total},{started:2,active:0,failed:1,totalMs:15012,maxMs:15000});
  assert.equal(p.attempts,2);assert.equal(p.timedOut,1);assert.equal(p.outcome,'success');
  assert.equal(s.lateCallbacks,2);assert.deepEqual({...s.reuse},{inFlight:1,ready:1,failed:1,unknown:0});
  assert.equal(s.recent.length,2);
});

test('synchronous metadata timing preserves return values and errors, and never retains payloads or unbounded records',()=>{
  let now=0;const h=createTiming({Date:{now:()=>now}}),value={ready:true},error=Error('secret payload');
  assert.equal(h.exports.measureMetadata('metadataInflate','forest-metadata-core-0',()=>{now+=18;return value;}),value);
  assert.throws(()=>h.exports.measureMetadata('metadataParse','https://private/?secret=123',()=>{now+=7;throw error;}),e=>e===error);
  for(let i=0;i<110;i++){const finish=h.exports.beginPackage('forest-feature-'+i,'feature-images');now++;finish('success');}
  const s=h.api.snapshot();assert.equal(s.phases.metadataInflate.totalMs,18);assert.equal(s.phases.metadataParse.totalMs,7);
  assert.equal(s.phases.metadataParse.failed,1);assert.equal(s.phases.metadataParse.active,0);
  assert.equal(s.longOperations.length,1);assert.equal(s.longOperations[0].phase,'metadataInflate');
  assert.equal(s.longOperations[0].durationMs,18,'a slow early inflate survives later fast events');
  assert.equal(s.packages.length,96);assert.equal(s.recent.length,64);assert.equal(s.droppedPackages,14);
  assert.equal(s.phases.platformSubpackage.started,110);assert.doesNotMatch(JSON.stringify(s),/private|secret|payload/);
  s.packages.length=0;s.recent.length=0;s.longOperations[0].durationMs=0;
  assert.equal(h.api.snapshot().packages.length,96);assert.equal(h.api.snapshot().recent.length,64);assert.equal(h.api.snapshot().longOperations[0].durationMs,18);
});
