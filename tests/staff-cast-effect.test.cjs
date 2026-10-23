const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const {STAFF_PREVIEW_PPU}=require('./.build/character/WeaponAttackAnimation.js');
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

function fixture() {
  class Vec3 {x=0;y=0;z=0;set(x,y,z){Object.assign(this,{x,y,z});return this;}}
  class Color {constructor(...values){this.values=values;}}
  class UITransform {}
  class Graphics {
    calls=[];
    clear(){this.calls.length=0;}
    circle(...args){this.calls.push(['circle',...args]);}
    ellipse(...args){this.calls.push(['ellipse',...args]);}
    moveTo(...args){this.calls.push(['move',...args]);}
    lineTo(...args){this.calls.push(['line',...args]);}
    close(){this.calls.push(['close']);}
    fill(){this.calls.push(['fill']);}
    stroke(){this.calls.push(['stroke']);}
  }
  let node;
  const makeNode=()=>node={active:true,isValid:true,position:[0,0],angle:0,
    setPosition(x,y){this.position=[x,y];},setScale(x,y){this.scale=[x,y];},
    addComponent(){return this.graphic=new Graphics();},destroy(){this.isValid=false;}};
  const transform={x:100,y:-40,sx:-2,sy:3};
  const parent={getComponent(){return {convertToNodeSpaceAR(p,out){
    return out.set((p.x-transform.x)/transform.sx,(p.y-transform.y)/transform.sy,0);
  }};}};
  const axis={x:3,y:-2};
  const muzzle={worldPosition:{x:128,y:50},getComponent(){return {convertToWorldSpaceAR(p,out){
    return out.set(muzzle.worldPosition.x+p.x*axis.x,muzzle.worldPosition.y+p.x*axis.y,0);
  }};}};
  const output={exports:{}},modules={cc:{Vec3,Color,Graphics,UITransform,gfx:{BlendFactor:{ONE:1}}},
    './ArtLibrary':{makeNode},'./WeaponAttackAnimation':{STAFF_PREVIEW_PPU}};
  const source=fs.readFileSync(path.join(__dirname,'../assets/scripts/view/StaffCastEffect.ts'),'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports:output.exports,require:name=>modules[name]});
  const material={},effect=new output.exports.StaffCastEffect({linearGraphicsMaterial:material},parent,muzzle);
  return {effect,node,muzzle,axis,transform,material};
}

test('staff cast draws three stars and follows the fully transformed real muzzle in either facing',()=>{
  const {effect,node,muzzle,axis,transform,material}=fixture();
  assert.equal(node.active,false);assert.equal(node.graphic.customMaterial,material);
  close(node.scale[0],1/STAFF_PREVIEW_PPU);
  for(const mirror of [-1,1])for(const angle of [0,45,150]) {
    transform.sx=mirror*2;muzzle.worldPosition.x=128+angle;muzzle.worldPosition.y=50-angle;
    axis.x=Math.cos(angle*Math.PI/180)*transform.sx;axis.y=Math.sin(angle*Math.PI/180)*transform.sy;
    effect.update({time:.21,charge:.95,flash:0});
    close(node.position[0],(muzzle.worldPosition.x-transform.x)/transform.sx);
    close(node.position[1],(muzzle.worldPosition.y-transform.y)/transform.sy);
    close(node.angle,angle);
    assert.equal(node.active,true);
    assert.equal(node.graphic.calls.filter(c=>c[0]==='circle').length,12);
    assert.equal(node.graphic.calls.filter(c=>c[0]==='close').length,3);
    assert.equal(node.graphic.calls.filter(c=>c[0]==='ellipse').length,0);
  }
});

test('staff release ring uses the sampled strength and clears all previous charge geometry',()=>{
  const {effect,node}=fixture();
  effect.update({time:.21,charge:1,flash:0});
  effect.update({time:.3225,charge:0,flash:1});
  assert.deepEqual(node.graphic.calls,[['ellipse',0,0,23,26],['stroke']]);
  effect.update({time:.57,charge:0,flash:0});
  assert.equal(node.active,false);assert.deepEqual(node.graphic.calls,[]);
  effect.update({time:.21,charge:1,flash:0});effect.reset();
  assert.equal(node.active,false);assert.deepEqual(node.graphic.calls,[]);
  effect.update({time:.21,charge:1,flash:0});effect.destroy();
  assert.equal(node.active,false);assert.equal(node.isValid,false);assert.deepEqual(node.graphic.calls,[]);
});

test('switching staff grades changes charge, stars and release colors without changing geometry or opacity',()=>{
  const {effect,node}=fixture();
  effect.setColor([1,.5,0]); effect.update({time:.21,charge:0,flash:1});
  assert.deepEqual(node.graphic.strokeColor.values,[255,128,0,179]);
  const geometry=JSON.stringify(node.graphic.calls);
  effect.setColor([.1,.4,1]); effect.update({time:.21,charge:0,flash:1});
  assert.deepEqual(node.graphic.strokeColor.values,[26,102,255,179]);
  assert.equal(JSON.stringify(node.graphic.calls),geometry);
  effect.update({time:.21,charge:1,flash:0});
  assert.deepEqual(node.graphic.strokeColor.values,[26,102,255,204]);
  assert.deepEqual(node.graphic.fillColor.values,[209,224,255,204]);
});
