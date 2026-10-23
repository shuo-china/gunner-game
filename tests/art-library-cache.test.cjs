const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const {projectPath} = require('./support/paths.cjs');
const glyphModule={exports:{}};
const cc={Rect:class {constructor(x,y,width,height){Object.assign(this,{x,y,width,height});}},
  Size:class {constructor(width,height){Object.assign(this,{width,height});}},SpriteFrame:class {}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view/NumberGlyphAtlas.ts'),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS},
}).outputText,{module:glyphModule,exports:glyphModule.exports,require:name=>{assert.equal(name,'cc');return cc;}});
const moduleUnderTest = {exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view/ArtLibrary.ts'),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS},
}).outputText,{module:moduleUnderTest,exports:moduleUnderTest.exports,require:name=>{
  if(name==='cc')return {};
  if(name==='./OriginalColorMath')return {ORIGINAL_WORLD_LAYER:1};
  if(name==='./GameResourceLoader')return {GameResourceLoader:class{}};
  if(name==='./ResourceBatch')return {loadResourceBatch:async tasks=>Promise.all(tasks.map(task=>task()))};
  if(name==='./NumberGlyphAtlas')return glyphModule.exports;
  throw Error(name);
}});
const {ArtLibrary}=moduleUnderTest.exports;
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const frame=()=>({isValid:true,refs:0,addRef(){this.refs++;},decRef(){this.refs--;}});

test('idle-frame eviction retains shared/core paths and balances library ownership',async()=>{
  const frames=new Map(),invalidated=[];let loads=0;
  const art=new ArtLibrary({load:async path=>{loads++;const asset=frame();frames.set(path,asset);return asset;},invalidate:(...args)=>invalidated.push(args)});
  const core=await art.loadFrame('core'),idle=await art.loadFrame('idle');assert.equal(core.refs,1);assert.equal(idle.refs,1);
  assert.equal(await art.loadFrame('core'),core);assert.equal(loads,2);
  assert.equal(art.evictFrames(['core','idle','idle'],new Set(['core'])),1);assert.equal(core.refs,1);assert.equal(idle.refs,0);
  assert.equal(art.frames.has('core'),true);assert.equal(art.frames.has('idle'),false);assert.deepEqual(invalidated,[['idle/spriteFrame','spriteFrame']]);
  const fresh=await art.loadFrame('idle');assert.notEqual(fresh,idle);assert.equal(fresh.refs,1);
  art.dispose();art.dispose();assert.equal(core.refs,0);assert.equal(fresh.refs,0);assert.equal(art.frames.size,0);
  await assert.rejects(art.loadFrame('core'),/disposed/);
});

test('pending frames cannot be evicted or repopulate a disposed library',async()=>{
  const wait=deferred(),invalidated=[];const art=new ArtLibrary({load:()=>wait.promise,invalidate:(...args)=>invalidated.push(args)});
  const request=art.loadFrame('pending');assert.equal(art.evictFrames(['pending'],new Set()),0);
  art.dispose();const asset=frame();wait.resolve(asset);await request;
  assert.equal(asset.refs,0);assert.equal(art.frames.size,0);assert.deepEqual(invalidated,[[]]);
});

test('base art prepares shared number atlas concurrently, preserves uncovered glyphs, and blocks until the atlas is ready',async()=>{
  const damage=require('../assets/resources/art/effects/original-feedback.json').damage;
  const manifest=require('../assets/resources/art/effects/number-atlas/config.json');
  const glyphs={...damage.glyphs,'?':{path:'custom/glyph',sizeUnits:[1,1]}};
  const configs={
    'art/catalog':{characters:{cat_basic:{rig:'rig'}},sprite:{path:'ordinary/sprite',sizeUnits:[1,1]}},
    rig:{parts:[],attachments:{}},'art/effects/original-feedback':{damage:{...damage,glyphs}},
    'art/effects/number-atlas/config':manifest,
  };
  const atlasWait=deferred(),requested=[];
  const art=new ArtLibrary({loadJson:async path=>configs[path],load:async path=>{
    requested.push(path);if(path===manifest.atlas+'/spriteFrame')await atlasWait.promise;
    return {...frame(),texture:{path}};
  }});
  let ready=false;const pending=art.load().then(()=>{ready=true;});
  await new Promise(setImmediate);
  assert.equal(ready,false);assert.ok(art.frames.has('ordinary/sprite'),'other images load while the atlas is pending');
  assert.equal(requested.some(path=>path.startsWith('art/effects/damage/')),false);
  atlasWait.resolve();await pending;
  assert.ok(art.frames.has('custom/glyph'));
  const requestsBeforeFirstHit=requested.length;
  for(const spec of Object.values(damage.glyphs))assert.equal(glyphModule.exports.numberGlyphFrame(art,spec.path).texture,art.frames.get(manifest.atlas).texture);
  assert.equal(glyphModule.exports.numberGlyphFrame(art,'custom/glyph'),art.frames.get('custom/glyph'));
  assert.equal(requested.length,requestsBeforeFirstHit,'the first damage hit is synchronous and starts no loads');
  assert.deepEqual(new Set(requested),new Set(['ordinary/sprite','custom/glyph',manifest.atlas].map(path=>path+'/spriteFrame')));
});
