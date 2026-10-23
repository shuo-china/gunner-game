const { projectPath } = require('./support/paths.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { OriginalParticleSimulation, sampleParticleStops } = require('./.build/feedback/view/OriginalParticleSimulation.js');
const { particles: { systems }, damage } = require(projectPath('assets/resources/art/effects/original-feedback.json'));
const { particleVelocityKeep } = require('./.build/feedback/view/OriginalParticleMotion.js');
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-6, `${a} != ${b}`);

test('hit reproduces the active source glow child as well as the six white sparks', () => {
  assert.deepEqual(systems.map(s=>[s.id,s.sortingOrder]), [['71568',10],['71567',11],['71566',13],['68367',14],['68688',40],['67675',41]]);
  const sim = new OriginalParticleSimulation(systems,()=>.5);
  sim.hit({x:4,z:8});
  const live=sim.particles.filter(p=>p.active);
  assert.equal(live.length,7);
  const glow=live.find(p=>p.spec.id==='68688');
  assert.ok(glow);assert.equal(glow.spec.blend.destination,1);
  assert.ok(glow.spec.image.path.includes('glow'));
  const pose=sim.pose(glow);
  close(pose.width,9.9);close(pose.height,9.9);
  close(pose.color[0],1);close(pose.color[1],197/255);close(pose.color[2],0);close(pose.color[3],1);
  close(glow.x,4);close(glow.y,2);close(glow.z,8);
  for(const spark of live.filter(p=>p!==glow)) {
    assert.equal(spark.spec.blend.destination,10);
    assert.deepEqual(sim.pose(spark).color,[1,1,1,1]);
    close(Math.hypot(spark.x-4,spark.y-2,spark.z-8),3.3);
  }
  sim.update(.075,[]);
  const faded=sim.pose(glow);
  assert.ok(faded.color[1]<pose.color[1]);close(faded.color[3],.5);
  assert.ok(faded.width<pose.width);
  sim.update(.2,[]);assert.equal(sim.particles.filter(p=>p.active).length,0);
});

test('every original trail child emits by traveled distance and stops on the stationary tail', () => {
  const sim=new OriginalParticleSimulation(systems,()=>.5);
  const b={id:1,active:true,age:1/60,traveled:70/60,position:{x:70/60,z:0},previousPosition:{x:0,z:0},direction:{x:1,z:0}};
  sim.shot(1);sim.update(1/60,[b]);
  const active=sim.particles.filter(p=>p.active);
  assert.equal(active.filter(p=>p.spec.id==='71568').length,2);
  assert.equal(active.filter(p=>p.spec.id==='71567').length,1);
  assert.equal(active.filter(p=>p.spec.id==='71566').length,4);
  assert.equal(active.filter(p=>p.spec.id==='68367').length,4);
  const orange=active.filter(p=>p.spec.id==='71566').map(p=>p.x).sort((a,b)=>a-b);
  orange.forEach((x,i)=>close(x,(i+1)/4));
  for(let i=0;i<30;i++)sim.update(1/60,[b]);
  assert.equal(sim.particles.filter(p=>p.active).length,0,'stationary pooled tail must not keep emitting');
});

test('reset clears all visual pool state and reused bullet IDs emit a fresh complete trail', () => {
  const sim=new OriginalParticleSimulation(systems,()=>.5);
  const b={id:2,active:true,age:1/60,traveled:70/60,position:{x:70/60,z:0},previousPosition:{x:0,z:0},direction:{x:1,z:0}};
  sim.shot(2);sim.hit({x:0,z:0});sim.update(1/60,[b]);sim.reset();
  assert.ok(sim.particles.every(p=>!p.active&&p.life===0&&p.vx===0));
  sim.shot(2);sim.update(1/60,[b]);
  assert.equal(sim.particles.filter(p=>p.active).length,11);
  assert.ok(sim.particles.length<500,'source maxParticles must not force thousands of Cocos nodes');
  assert.ok(damage.curves.every(c=>Object.values(c).every(v=>v.length===65)), 'original native Bake uses 0x41 entries');
});

test('distance emission spans all physics steps since the previous rendered frame', () => {
  const sim=new OriginalParticleSimulation(systems,()=>.5);
  const b={id:1,active:true,age:.06,traveled:4.2,position:{x:4.2,z:3},previousPosition:{x:2.8,z:3},direction:{x:1,z:0}};
  sim.shot(1);sim.update(.06,[b]);
  const orange=sim.particles.filter(p=>p.active&&p.spec.id==='71566').map(p=>p.x).sort((a,b)=>a-b);
  assert.equal(orange.length,16);
  orange.forEach((x,i)=>close(x,(i+1)/4));
  assert.ok(orange[0]<b.previousPosition.x,'older emissions must not bunch at the last physics step start');
});

test('reusing a bullet clears only that emitter trail, preserving other shots and impact effects', () => {
  const sim=new OriginalParticleSimulation(systems,()=>.5);
  const bullet=id=>({id,active:true,age:1/60,traveled:70/60,position:{x:70/60,z:id},previousPosition:{x:0,z:id},direction:{x:1,z:0}});
  sim.shot(1);sim.shot(2);sim.update(1/60,[bullet(1),bullet(2)]);sim.hit({x:8,z:8});
  const others=sim.particles.filter(p=>p.active&&p.emitterId===2);
  sim.shot(1);
  assert.ok(sim.particles.every(p=>!p.active||p.emitterId!==1));
  assert.equal(others.filter(p=>p.active).length,11);
  assert.equal(sim.particles.filter(p=>p.active&&p.spec.kind==='hit').length,7);
  sim.update(1/60,[bullet(1)]);
  assert.equal(sim.particles.filter(p=>p.active&&p.emitterId===1).length,11);
});

test('pool indexing and reusable poses preserve the pre-refactor seeded trajectory and random draw order', () => {
  let seed=123456789,calls=0;
  const sim=new OriginalParticleSimulation(systems,()=>{calls++;seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;});
  const trace=[],out={x:0,y:0,width:0,height:0,angle:0,color:[]};
  const bullet=(id,t,x,z)=>({id,active:true,age:t/70,traveled:t,position:{x:x+t*.6,z:z+t*.8},previousPosition:{x,z},direction:{x:.6,z:.8}});
  const step=(dt,bullets)=>{
    sim.update(dt,bullets);
    trace.push(sim.particles.filter(p=>p.active).map(p=>{
      const snapshot=sim.pose(p);
      assert.equal(sim.pose(p,out),out);
      assert.deepEqual(out,snapshot);
      return [p.index,p.emitterId??null,...['age','life','size','x','y','z','vx','vy','vz','rotation','random'].map(k=>p[k]),
        ...Object.values(out).flat()].map(v=>typeof v==='number'?Math.round(v*1e9)/1e9:v);
    }));
  };
  sim.shot(1);step(.06,[bullet(1,4.2,3,-2)]);
  sim.hit({x:8,z:9});sim.shot(2);step(.017,[bullet(1,5.6,3,-2),bullet(2,1.4,-5,3)]);
  step(.025,[bullet(1,7,3,-2),bullet(2,2.8,-5,3)]);
  sim.shot(1);step(.016,[bullet(1,1.4,10,5),bullet(2,4.2,-5,3)]);step(.05,[]);
  assert.equal(calls,1029);
  assert.deepEqual(trace.map(frame=>frame.length),[46,83,105,67,51]);
  // Captured from the reviewed implementation before the allocation refactor;
  // includes all live positions, velocities, sizes, alpha/colors and rotations.
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(trace)).digest('hex'),
    '00ae1759563dbc99bd0f88d7115eb5616f985493f44efd0f36ad0b131856de8a');
});

test('gradient output buffers retain key endpoints and interpolate without aliasing source data', () => {
  const keys=[[.2,1,.7,0],[.8,.4,.3,1]],out=[99,99,99,99];
  assert.equal(sampleParticleStops(keys,0,out),out);
  assert.deepEqual(out,[1,.7,0]);
  const snapshot=sampleParticleStops(keys,.5);
  sampleParticleStops(keys,1,out);
  assert.deepEqual(out,[.4,.3,1]);
  snapshot.forEach((value,i)=>close(value,[.7,.5,.5][i]));
  assert.deepEqual(keys,[[.2,1,.7,0],[.8,.4,.3,1]]);
});

test('the two muzzle velocity limits retain the serialized modules, including their local units', () => {
  const catalog=require(projectPath('assets/resources/art/catalog.json'));
  const evidence=JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname,'./fixtures/character-runtime-evidence.json'),'utf8'));
  for(const spec of catalog.effects.muzzle.particleSystems) {
    const source=evidence[spec.source].data.ClampVelocityModule;
    assert.equal(source.enabled,true);
    assert.equal(source.inWorldSpace,false);
    assert.equal(source.separateAxis,false);
    assert.equal(source.drag.scalar,0);
    assert.deepEqual(spec.limitVelocity,{magnitude:source.magnitude.scalar,dampen:source.dampen});
  }
});

test('velocity limiting does not slow particles below the limit and is stable across elapsed-time partitions', () => {
  close(particleVelocityKeep(.2,.5,.05,1),1);
  close(particleVelocityKeep(15,0,.2,0),1);
  const step=(v,dt)=>v*particleVelocityKeep(v,.5,.05,dt);
  close(step(8,.1),step(step(8,.04),.06));
  assert.ok(step(8,.3)>.5);
  assert.ok(step(8,.3)<8);
});

function particleViewHarness(name,random=Math.random,toLocal=p=>p) {
  // Exercise the actual view at the Cocos boundary. UIRenderer.color copies
  // its input, matching the installed Creator 3.8.8 setter.
  const fs=require('node:fs'),vm=require('node:vm');
  const ts=require('typescript');
  let colorAllocations=0;
  const sharedMaterial={passes:[{blendState:{targets:[{
    blend:true,blendSrc:5,blendDst:10,blendSrcAlpha:1,blendDstAlpha:10,
  }]}}]};
  class Sprite {
    constructor(){this.customMaterial=sharedMaterial;}
    updateMaterial(){}
    getSharedMaterial(index){assert.equal(index,0);return this.customMaterial;}
    getMaterialInstance(index){
      assert.equal(index,0);
      if(!this.materialInstance)this.materialInstance={
        passes:JSON.parse(JSON.stringify(this.customMaterial.passes)),
        overridePipelineStates(overrides,passIndex=0){
          Object.assign(this.passes[passIndex],JSON.parse(JSON.stringify(overrides)));
        },
      };
      return this.materialInstance;
    }
    set color(value){this._color={r:value.r,g:value.g,b:value.b,a:value.a};}
    get color(){return this._color;}
  }
  const materials=[],nodes=[];let failMaterialCopy=false;
  class Material {
    constructor(){this.destroyCalls=0;materials.push(this);}
    copy(base,overrides){if(failMaterialCopy)throw new Error('material copy failed');this.passes=JSON.parse(JSON.stringify(base.passes));Object.assign(this.passes[0],JSON.parse(JSON.stringify(overrides.states)));}
    destroy(){this.destroyCalls++;}
  }
  class UITransform {setContentSize(width,height){this.width=width;this.height=height;}}
  class Color {
    constructor(r,g,b,a){colorAllocations++;this.set(r,g,b,a);}
    set(r,g,b,a){Object.assign(this,{r,g,b,a});}
  }
  class Node {
    static EventType={NODE_DESTROYED:'destroyed'};
    constructor(){this.listeners=[];}
    once(event,fn,target){this.listeners.push({event,fn,target});}
    off(event,fn,target){this.listeners=this.listeners.filter(item=>item.event!==event||item.fn!==fn||item.target!==target);}
    destroy(){for(const {fn,target} of this.listeners.slice())fn.call(target);this.listeners.length=0;}
  }
  const cc={Color,Sprite,UITransform,Material,Node,gfx:{BlendFactor:{ONE:1,SRC_ALPHA:5,ONE_MINUS_SRC_ALPHA:10}}};
  const catalog={...require(projectPath('assets/resources/art/catalog.json')),feedback:{particles:{systems}}};
  const art={catalog,image:(name,_spec,parent)=>{
    const sprite=new Sprite(),transform=new UITransform();
    const node={name,active:false,angle:0,parent,isValid:true,destroy(){this.isValid=false;},getComponent:t=>t===Sprite?sprite:transform,
      setSiblingIndex(index){parent.children.splice(parent.children.indexOf(this),1);parent.children.splice(index,0,this);},
      setPosition(x,y){this.x=x;this.y=y;}};
    (parent.children??=[]).push(node);
    nodes.push(node);return node;
  }};
  const source=fs.readFileSync(projectPath(`assets/scripts/view/${name}.ts`),'utf8');
  const module={exports:{}};
  const math=Object.create(Math);math.random=random;
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
    {exports:module.exports,module,Math:math,require:dependency=>dependency==='cc'?cc:
      dependency==='./OriginalParticleMotion'?{particleVelocityKeep}:
      dependency==='./OriginalFeedbackMath'?{sampleParticleStops}:
      dependency==='./OriginalParticleSimulation'?{OriginalParticleSimulation:class extends OriginalParticleSimulation {
        constructor(specs){super(specs,random);}
      }}:{} });
  const parents={1:{name:'Cat_Order1'},2:{name:'Cat_Order2'}};
  const parentForOrder=order=>parents[order]??(parents[order]={name:`Order${order}`});
  const ownerParent=new Node();
  const create=()=>name==='OriginalMuzzleEffect'?new module.exports[name](art,ownerParent,toLocal,parentForOrder):
    new module.exports[name](art,{},parentForOrder);
  return {effect:create(),create,parents,ownerParent,sharedMaterial,materials,nodes,failNextMaterial:()=>{failMaterialCopy=true;},colorAllocations:()=>colorAllocations};
}

test('muzzle glow and sparks share additive material without changing the shared world material', () => {
  const {effect,create,sharedMaterial,materials}=particleViewHarness('OriginalMuzzleEffect');
  assert.equal(effect.particles.length,14);
  const other=create();
  const instances=[...effect.particles,...other.particles].map(p=>p.sprite.customMaterial);
  assert.equal(new Set(instances).size,1,'all muzzle sprites share the same additive variant');
  assert.equal(materials.length,1);
  for(const p of effect.particles) {
    assert.notEqual(p.sprite.customMaterial,sharedMaterial);
    assert.equal(p.sprite.materialInstance,undefined);
    assert.deepEqual(p.sprite.customMaterial.passes[0].blendState.targets[0],{
      blend:true,blendSrc:5,blendDst:1,blendSrcAlpha:1,blendDstAlpha:1,
    });
  }
  assert.deepEqual(sharedMaterial.passes[0].blendState.targets[0],{
    blend:true,blendSrc:5,blendDst:10,blendSrcAlpha:1,blendDstAlpha:10,
  },'ordinary world sprites must retain source-alpha blending');
  effect.destroy();effect.destroy();assert.equal(materials[0].destroyCalls,0,'other effect retains its material');
  other.destroy();other.destroy();assert.equal(materials[0].destroyCalls,1);
  const next=create();assert.equal(materials.length,2);next.destroy();assert.equal(materials[1].destroyCalls,1);
});

test('muzzle parent destruction releases shared variants even if the enclosing view failed construction',()=>{
  const {effect,create,ownerParent,materials}=particleViewHarness('OriginalMuzzleEffect');
  const other=create();assert.equal(ownerParent.listeners.length,2);
  effect.destroy();assert.equal(ownerParent.listeners.length,1,'weapon replacement removes its owner listener');
  assert.equal(materials[0].destroyCalls,0);
  ownerParent.destroy();assert.equal(materials[0].destroyCalls,1);
  other.destroy();assert.equal(materials[0].destroyCalls,1);assert.equal(ownerParent.listeners.length,0);
});

test('failed muzzle material copy releases its material and the not-yet-pooled node',()=>{
  const h=particleViewHarness('OriginalMuzzleEffect');h.effect.destroy();h.failNextMaterial();
  assert.throws(()=>h.create(),/material copy failed/);
  assert.ok(h.nodes.every(node=>!node.isValid));
  assert.ok(h.materials.every(material=>material.destroyCalls===1));
  assert.equal(h.ownerParent.listeners.length,0);
});

test('multiple impacts submit one skin per frame and reset hides it immediately', () => {
  const {effect}=particleViewHarness('OriginalProjectiles');
  const render=effect.render.bind(effect);let renders=0;
  effect.render=skin=>{renders++;render(skin);};
  for(let i=0;i<20;i++)effect.hit({x:i,z:8});
  assert.equal(renders,0);
  const skin=Array.from(effect.skins.values())[0];
  assert.ok(skin.simulation.particles.some(p=>p.active));
  assert.ok(skin.views.every(v=>!v.node.active));
  effect.update(.025,[]);assert.equal(renders,1);
  assert.ok(skin.views.some(v=>v.node.active));
  effect.reset();assert.ok(skin.views.every(v=>!v.node.active));
});

test('muzzle particles use their source damping before movement and stretched-speed evaluation', () => {
  const {effect,parents}=particleViewHarness('OriginalMuzzleEffect');
  const pose={origin:{x:0,y:0},xAxis:{x:1,y:0},yAxis:{x:0,y:1},zAxis:{x:1,y:0}};
  effect.fire(pose);
  const initial=effect.particles.map(p=>({p,speed:p.speed,x:p.x,y:p.y,z:p.z}));
  effect.update(1/60,pose,1,{scale:1,projectionScaleY:1});
  for(const before of initial) {
    const p=before.p,limit=p.spec.limitVelocity;
    assert.equal(p.node.parent,parents[p.spec.sortingOrder],'source sorting orders select separate Cat layer parents');
    const expectedSpeed=before.speed>limit.magnitude?
      limit.magnitude+(before.speed-limit.magnitude)*(1-limit.dampen):before.speed;
    close(p.speed,expectedSpeed);
    close(Math.hypot(p.x-before.x,p.y-before.y,p.z-before.z),expectedSpeed/60);
    assert.ok(p.speed<before.speed,'active source limiter must reduce muzzle travel');
  }
  effect.reset();assert.ok(effect.particles.every(p=>!p.node.active));
});

test('muzzle buffer reuse preserves the pre-refactor seeded render trace without per-frame Colors', () => {
  let calls=0,seed=246813579;
  const random=()=>{calls++;seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const {effect,colorAllocations}=particleViewHarness('OriginalMuzzleEffect',random,p=>({x:p.x/2,y:p.y/3}));
  const initialColors=colorAllocations();
  const pose={origin:{x:3,y:-2},xAxis:{x:.4,y:.2},yAxis:{x:-.1,y:.8},zAxis:{x:.7,y:.3}},trace=[];
  const step=(dt,mirror=1)=>{
    effect.update(dt,pose,mirror,{scale:.55,projectionScaleY:.99658572});
    trace.push(effect.particles.map(p=>[p.node.active,...['x','y','z','vx','vy','vz','speed','size','age','life'].map(k=>p[k]),
      p.node.x,p.node.y,p.node.angle,p.transform.width,p.transform.height,...Object.values(p.sprite.color??{})]
      .map(v=>typeof v==='number'?Math.round(v*1e9)/1e9:v)));
  };
  effect.fire(pose);step(0);step(1/60);effect.fire(pose);step(.02,-1);step(.04);step(.08);
  effect.fire(pose);step(0,-1);step(.033,-1);effect.reset();step(0);
  assert.equal(calls,70);
  assert.equal(colorAllocations(),initialColors);
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(trace)).digest('hex'),
    '8808f5910c6082e60d4545a0ad47c883508d2764fb168195b122b0c562cdf90b');
});

test('projectile renders reuse Color and pose storage while sprites retain independent values', () => {
  const {effect,colorAllocations}=particleViewHarness('OriginalProjectiles');
  const initialColors=colorAllocations();
  effect.hit({x:4,z:8});effect.update(.025,[]);
  assert.equal(colorAllocations(),initialColors);
  const views=Array.from(effect.skins.values()).flatMap(skin=>skin.views);
  const live=views.filter(view=>view.node.active);
  assert.equal(live.length,7);
  assert.notEqual(live[0].sprite.color,live[1].sprite.color);
  assert.ok(live[0].sprite.color.g<255,'the yellow glow must not inherit a later white spark color');
  assert.equal(live[1].sprite.color.g,255);
  effect.reset();assert.ok(views.every(view=>!view.node.active));
});

test('equipped particle preparation preserves first-use random, simulation and transparent order',()=>{
  const fixture=()=>{
    let seed=31,calls=0;
    const h=particleViewHarness('OriginalProjectiles',()=>{calls++;seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;});
    const specs=h.effect.art.catalog.feedback.particles.systems;
    h.effect.art.weaponVisuals={appearance:id=>({projectileSkin:`skin${id}`}),config:{
      projectileSkins:Object.fromEntries([0,1,2,3,4,5].map(id=>[`skin${id}`,specs])),
    }};
    return {...h,calls:()=>calls};
  };
  const lazy=fixture(),warm=fixture();
  warm.effect.prepareWeapons([0,1,2]);
  const allocated=warm.nodes.length;
  assert.ok(allocated>0);assert.equal(warm.calls(),0);assert.equal(warm.effect.diagnostics().active,0);
  warm.effect.update(.1,[]);assert.equal(warm.calls(),0,'no emission or random draw while preparing');
  const snapshot=h=>[...h.effect.skins.values()].filter(s=>!s.prepared).map(s=>({key:s.key,
    particles:s.simulation.particles.map(p=>Object.fromEntries(Object.entries(p).filter(([key])=>key!=='spec')))}));
  const visible=h=>Object.entries(h.parents).map(([order,parent])=>[order,(parent.children??[])
    .filter(n=>n.active&&n.isValid).map(n=>[n.name,n.x,n.y,n.angle])]);
  // First-use order intentionally differs from equipment order.
  for(const id of [2,0,1,2]){
    for(const h of [lazy,warm]){h.effect.hit({x:id*7,z:8},id);h.effect.update(.025,[]);}
    assert.equal(warm.calls(),lazy.calls());assert.deepEqual(snapshot(warm),snapshot(lazy));
    assert.deepEqual(visible(warm),visible(lazy));
  }
  assert.equal(warm.nodes.length,allocated,'first shots reuse the prepared particles');
  warm.effect.prepareWeapons([3,4,5]);warm.effect.update(3,[]);
  assert.deepEqual([...warm.effect.skins.values()].filter(s=>!s.prepared).map(s=>s.key),['skin2','skin0','skin1'],
    'unused prepared skins do not evict old pools or change their reuse order');
  for(const id of [3,4,5])warm.effect.hit({x:0,z:8},id);
  warm.effect.update(3,[]);
  assert.deepEqual([...warm.effect.skins.keys()],['skin3','skin4','skin5'],'old inactive skins retire only once new skins are used');
  warm.effect.prepareWeapons([0,1,2]);warm.effect.update(3,[]);
  warm.effect.prepareWeapons([3,4,5]);warm.effect.update(3,[]);
  assert.deepEqual([...warm.effect.skins.keys()],['skin3','skin4','skin5'],'unused prepared skins retire after unequipping');
  warm.effect.destroy();assert.equal(warm.effect.skins.size,0);assert.equal(warm.effect.preparedSkins.size,0);
});
