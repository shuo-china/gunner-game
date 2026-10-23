const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('typescript');
const root=path.resolve(__dirname, '..'),config=require(path.join(root,'assets/resources/art/weapon-system/config.json'));
const source=Object.values(config.nodes).find(n=>n.layoutType==='ScrollRect').layout;
class Vec3{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}}
class ScrollView{
  content={position:new Vec3(0,100,0)};view={height:500};enabledInHierarchy=true;
  stopAutoScroll(){} _handlePressLogic(){} _onScrollBarTouchEnded(){} _hasNestedViewGroup(){return false;} _stopPropagationIfTargetIsMe(){}
  _getLocalAxisAlignDelta(out,touch){out.y=touch.delta;}
  _getHowMuchOutOfBoundary(delta=new Vec3()){const p=this.content.position.y+delta.y;return new Vec3(0,p<0?-p:p>1000?1000-p:0);}
  _moveContent(delta){this.content.position.y+=delta.y;}
}
const mod={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'assets/scripts/view/OriginalWeaponScroll.ts'),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018,experimentalDecorators:true}}).outputText,
  {module:mod,exports:mod.exports,require:key=>{assert.equal(key,'cc');return{ScrollView,Vec3,_decorator:{ccclass:()=>Type=>Type}};}});
const make=()=>{const scroll=new mod.exports.OriginalWeaponScroll();scroll.configure(source);return scroll;};
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} != ${expected}`);

test('collection inertia retains 13.5 percent velocity per second and discards speed below one local unit',()=>{
  const s=make();s._handlePressLogic();s._handleMoveLogic({delta:10});s.update(.1);
  near(s.velocity,100);s._handleReleaseLogic({});
  s.update(.5);const half=100*Math.sqrt(source.m_DecelerationRate);near(s.velocity,half);near(s.content.position.y,110+half*.5);
  s.update(.5);near(s.velocity,100*source.m_DecelerationRate);
  s.velocity=.9;s.update(.01);near(s.velocity,0);
});

test('source elastic drag depends on total stretch and view size, reverses continuously, then springs without overshoot',()=>{
  const s=make();s.content.position.y=0;s._handlePressLogic();s._handleMoveLogic({delta:-100});
  near(s.content.position.y,-500*(1-1/1.11));s._handleMoveLogic({delta:100});near(s.content.position.y,0);
  s._handleMoveLogic({delta:-100});s._handleReleaseLogic({});
  let previous=s.content.position.y;for(let i=0;i<60;i++){s.update(1/60);assert.ok(s.content.position.y>=previous-1e-10&&s.content.position.y<=0);previous=s.content.position.y;}
  assert.ok(Math.abs(s.content.position.y)<.02,'spring settles within a fraction of a display pixel after one second');
});

test('closing or background cleanup removes drag and inertia while preserving the source collection scroll position',()=>{
  const s=make();s._handlePressLogic();s._handleMoveLogic({delta:30});s.update(.1);s._handleReleaseLogic({});assert.ok(s.velocity>0);
  const at=s.content.position.y;s.stopAutoScroll();near(s.velocity,0);assert.equal(s.dragging,false);
  s.update(1);near(s.content.position.y,at);s._handleMoveLogic({delta:50});near(s.content.position.y,at);
  s._handlePressLogic();s.update(.1);near(s.velocity,0,'a new pointer cannot inherit pre-hide movement');
});

test('wheel applies source sensitivity without creating drag inertia, and zero-dt frames do not corrupt velocity',()=>{
  const s=make();s._onMouseWheel({getScrollY:()=>-100});near(s.content.position.y,110);near(s.velocity,0);assert.equal(s.dragging,false);
  s.update(0);near(s.velocity,0);s.update(.1);near(s.content.position.y,110);
  const scrollbar=config.nodes['level0:1077'];assert.equal(scrollbar.rect.scale[0],0);assert.equal(scrollbar.rect.size[0],0,'original scrollbar remains intentionally invisible');
});

test('pooled rows receive the final scroll position during both dragging and inertia',()=>{
  const s=make(),observed=[];s.onPositionChanged=()=>observed.push(s.content.position.y);
  s._handlePressLogic();s._handleMoveLogic({delta:40});assert.equal(observed.at(-1),s.content.position.y);
  s.update(.1);s._handleReleaseLogic({});s.update(.1);
  assert.equal(observed.length,2);assert.equal(observed.at(-1),s.content.position.y);assert.ok(observed[1]>observed[0]);
  s.onPositionChanged=undefined;s.update(.1);assert.equal(observed.length,2);
});
