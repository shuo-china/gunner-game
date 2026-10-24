const test=require('node:test'),assert=require('node:assert/strict');
const {splitModules}=require('../tools/wechat-code-package.cjs');
const {installFeatureCode}=require('../tools/wechat-code-runtime.cjs');
const stems=['Weapon','SpeedRun','Rebirth','Raid','Boss','Hunt','Mine','Skin','Pet','Fish','Adventure'];
const reg=(name,deps=[])=>`System.register("chunks:///_virtual/${name}",${JSON.stringify(deps)},function(){return{setters:[],execute:function(){}}});`;
test('code splitting preserves eager dependencies and defers exclusive HUD dependencies exactly once',()=>{
  const source=reg('GameBootstrap.ts',['./Shared.ts'])+reg('Shared.ts')+reg('FishDetails.ts')+
    stems.map(stem=>reg(stem+'Hud.ts',['./Shared.ts',...(stem==='Fish'?['./FishDetails.ts']:[])])).join('')+
    reg('main',['./GameBootstrap.ts',...stems.map(stem=>'./'+stem+'Hud.ts'),'./Shared.ts','./FishDetails.ts']);
  const split=splitModules(source);assert.equal(split.deferred.length,12);
  assert.match(split.main,/System.register\("chunks:\/\/\/_virtual\/Shared.ts"/);
  assert.doesNotMatch(split.main,/FishHud|FishDetails/);
  const moved=split.groups.flatMap(g=>g.modules.map(x=>x.id));assert.equal(new Set(moved).size,moved.length);
  assert.ok(split.groups.find(g=>g.owners.includes('fish')).modules.some(m=>m.id.endsWith('FishDetails.ts')));
});
test('runtime deduplicates overlapping deliveries, registers code once and reuses ready packages',async()=>{
  const calls=[],registered=[],scope={wx:{loadSubpackage:o=>calls.push(o)}};
  const requireScript=name=>name==='./wechat-resource-timing'?{beginPackage:()=>()=>{}}:registered.push(name);
  installFeatureCode({fish:['shared','fish'],pets:['shared','pets']},scope,requireScript);
  const a=scope.__FOREST_GUNNER_LOAD_FEATURE_CODE__('fish'),b=scope.__FOREST_GUNNER_LOAD_FEATURE_CODE__('pets');
  assert.equal(calls.length,3);calls.forEach(o=>o.success());await Promise.all([a,b]);
  await scope.__FOREST_GUNNER_LOAD_FEATURE_CODE__('fish');assert.equal(calls.length,3);assert.equal(registered.length,3);
});
test('code download failure remains retryable and never marks a panel ready',async()=>{
  const calls=[],scope={wx:{loadSubpackage:o=>calls.push(o)}};
  installFeatureCode({fish:['fish']},scope,name=>name==='./wechat-resource-timing'?{beginPackage:()=>()=>{}}:{});
  const a=scope.__FOREST_GUNNER_LOAD_FEATURE_CODE__('fish');calls[0].fail(new Error('network'));await assert.rejects(a,/network/);
  const b=scope.__FOREST_GUNNER_LOAD_FEATURE_CODE__('fish');assert.equal(calls.length,2);calls[1].success();await b;
  await assert.rejects(scope.__FOREST_GUNNER_LOAD_FEATURE_CODE__('unknown'),/Unknown/);
});
