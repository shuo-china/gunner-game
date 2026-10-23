const { projectPath } = require('./support/paths.cjs');
const test=require('node:test');
const assert=require('node:assert/strict');
const {OriginalParticleSimulation,particleRotate,particleEulerQuaternion}=require('./.build/feedback/view/OriginalParticleSimulation.js');
const {advanceParticleExtra}=require('./.build/feedback/view/OriginalParticleExtraMotion.js');
const visuals=require(projectPath('assets/resources/art/weapon-system/visuals.json'));
const legacy=require(projectPath('assets/resources/art/effects/original-feedback.json')).particles.systems[0];
const curve=value=>({mode:0,value,min:0,keys:[],minKeys:[]});
const identity={position:[0,0,0],rotation:[0,0,0,1]};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
const spec=(overrides={})=>({...legacy,id:'fixture',kind:'bullet',scale:1,lifetime:curve(2),size:curve(1),speed:curve(0),gravity:curve(0),rotation:curve(0),
  emissionRate:0,timeEmissionRate:0,bursts:[{time:0,count:1}],duration:1,looping:false,prewarm:false,shape:null,sourceTransform:identity,
  sizeCurve:null,gradient:null,rotationCurve:null,inheritVelocity:null,limitVelocity:null,maxParticles:100,...overrides});
const bullet=(overrides={})=>({id:1,active:true,damaging:true,age:.1,traveled:1,position:{x:1,z:0},direction:{x:1,z:0},height:2,speed:10,...overrides});
const live=sim=>sim.particles.filter(p=>p.active);

test('weapon source contains every skin and every authored mesh and atlas is renderable',()=>{
  assert.equal(visuals.weapons.length,65);assert.equal(Object.keys(visuals.customProjectiles).length,17);
  const originals=Object.entries({...require('./fixtures/retired-projectile-profiles.json'),...visuals.projectileSkins}).filter(([key])=>/^\d+-\d+$/.test(key));
  assert.equal(originals.length,45,'all original particle profiles remain regression baselines');
  const systems=originals.flatMap(([,systems])=>systems);
  assert.equal(systems.length,342);assert.equal(systems.filter(s=>s.mesh).length,69);
  assert.equal(systems.filter(s=>s.textureSheet).length,148);
  assert.equal(systems.filter(s=>s.noise).length,9);assert.equal(systems.filter(s=>s.collision).length,9);
  for(const s of systems){
    assert.ok(s.sourceTransform);assert.equal(typeof s.looping,'boolean');
    if(s.mesh){assert.ok(s.mesh.positions.length>0,s.id);assert.equal(s.mesh.positions.length,s.mesh.uv.length);
      assert.ok(s.mesh.indices.every(i=>i>=0&&i<s.mesh.positions.length));
      if(s.mesh.builtinId)assert.ok(s.mesh.reconstructed,'external Unity builtin tessellation is explicitly identified');
    }
    if(s.textureSheet)assert.ok(s.textureSheet.tilesX>0&&s.textureSheet.tilesY>0);
    if(s.renderMode!==4){
      const colors=[...s.materialColor,...s.startColor,...(s.startColorMin||[]),
        ...(s.gradient?[...s.gradient.colors,...s.gradient.alpha].flatMap(stop=>stop.slice(1)):[])];
      assert.ok(colors.every(channel=>channel>=0&&channel<=1),'all source HDR multipliers belong to meshes; billboard byte colors must remain sufficient');
    }
    if(s.shader?.source==='sharedassets0.assets:221'){
      assert.deepEqual(s.blend,{source:5,destination:10},'fixed shader state overrides stale material blend properties');
      assert.deepEqual(s.materialColor,[2,2,2,2],'original GLES fragment doubles the legacy tint');
    }
  }
});

test('local particles follow emitter translation and rotation while world trails stay behind',()=>{
  const sim=new OriginalParticleSimulation([spec({id:'local',simulationSpace:0}),spec({id:'world',simulationSpace:1})],()=>.5);
  sim.shot(1);sim.update(.1,[bullet()]);
  const local=live(sim).find(p=>p.spec.id==='local'),world=live(sim).find(p=>p.spec.id==='world');
  close(local.x,1);close(world.x,0);
  sim.update(.1,[bullet({age:.2,traveled:2,position:{x:2,z:0},direction:{x:0,z:1}})]);
  close(local.x,2);close(local.z,0);close(world.x,0);close(world.z,0);
  const forward=particleRotate(local.baseRotation,[0,0,1]);close(forward[0],0);close(forward[2],1);
});

test('missile particles follow the frozen target height and slope for Raid and ordinary ground targets',()=>{
  for(const targetHeight of [undefined,-7.449999809265137]) {
    const sim=new OriginalParticleSimulation([spec({simulationSpace:0})],()=>.5);
    const age=.25,arc=4,speed=10,targetY=targetHeight??0;
    const b=bullet({age,speed,missileStart:{x:0,z:0},missileTarget:{x:10,z:0},
      missileTargetHeight:targetHeight,missileDuration:1,missileArcHeight:arc});
    sim.shot(b.id);sim.update(age,[b]);
    const particle=live(sim)[0],vertical=targetY-2+4*(1-2*age)*arc;
    close(particle.x,10*age);close(particle.y,2*(1-age)+targetY*age+4*age*(1-age)*arc);
    const forward=particleRotate(particle.baseRotation,[0,0,1]),magnitude=Math.hypot(speed,vertical);
    close(forward[0],speed/magnitude);close(forward[1],vertical/magnitude);close(forward[2],0);
  }
});

test('authored hit height, delayed bursts and continuous emission survive frame crossing without duplication',()=>{
  const sim=new OriginalParticleSimulation([spec({kind:'hit',timeEmissionRate:10,duration:.3,bursts:[{time:0,count:1},{time:.2,count:2}]})],()=>.5);
  sim.hit({x:4,z:7},100,0);assert.equal(live(sim).length,1);close(live(sim)[0].y,0);
  sim.update(.25,[]);assert.equal(live(sim).length,5);
  for(const p of live(sim)){close(p.y,0);close(p.x,4);close(p.z,7);}
  sim.update(.2,[]);assert.equal(live(sim).length,6);
  sim.update(.2,[]);assert.equal(live(sim).length,6,'non-looping emitter stops after source duration');
});

test('looping zero-time bursts repeat by duration and prewarm fills exactly one source cycle',()=>{
  const looping=spec({duration:.2,looping:true,lifetime:curve(2)});
  const sim=new OriginalParticleSimulation([looping],()=>.5);
  sim.shot(1);sim.update(.45,[bullet({age:.45})]);assert.equal(live(sim).length,3);
  sim.update(.01,[bullet({age:.46})]);assert.equal(live(sim).length,3);
  const warmed=new OriginalParticleSimulation([spec({prewarm:true,looping:true,duration:1,timeEmissionRate:10,bursts:[],lifetime:curve(.5)})],()=>.5);
  warmed.shot(1);warmed.update(.01,[bullet({age:.01})]);assert.equal(live(warmed).length,5);
});

test('particle death clears only source Mesh_particle selections and keeps detached trails',()=>{
  const sim=new OriginalParticleSimulation([spec({id:'mesh',stopOnDeath:true}),spec({id:'trail',stopOnDeath:false})],()=>.5);
  sim.shot(1);sim.update(.1,[bullet()]);assert.equal(live(sim).length,2);
  sim.update(.01,[bullet({damaging:false,trailTime:.01})]);assert.deepEqual(live(sim).map(p=>p.spec.id),['trail']);
});

test('mesh poses retain separate XYZ size and rotation plus texture sheet frames',()=>{
  const sim=new OriginalParticleSimulation([spec({kind:'hit',scale:.5,size:curve(2),startSizeY:curve(3),startSizeZ:curve(4),
    sizeCurveY:curve(2),startRotationX:curve(Math.PI/2),rotationCurveY:curve(Math.PI),
    textureSheet:{tilesX:4,tilesY:3,cycles:1,frame:{mode:1,value:1,min:0,keys:[{time:0,value:0,outSlope:1},{time:1,value:1,inSlope:1}],minKeys:[]},startFrame:curve(0)},
    mesh:{source:'fixture',name:'triangle',positions:[[0,0,0],[1,0,0],[0,1,0]],uv:[[0,0],[1,0],[0,1]],indices:[0,1,2]}})],()=>.5);
  sim.hit({x:2,z:3},0,0);sim.update(.5,[]);const p=live(sim)[0],pose=sim.pose(p);
  assert.equal(pose.frame,3);assert.deepEqual(pose.mesh.scale,[1,3,2]);assert.deepEqual(pose.mesh.position,[2,0,3]);
  const expected=particleEulerQuaternion(Math.PI/2,Math.PI/2,0);
  pose.mesh.rotation.forEach((value,index)=>close(value,expected[index]));
});

test('all 45 extracted visual skins simulate finite source poses through active and tail phases',()=>{
  for(const [key,systems] of Object.entries({...require('./fixtures/retired-projectile-profiles.json'),...visuals.projectileSkins})){
    let seed=77;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);
    const sim=new OriginalParticleSimulation(systems,random);sim.shot(1);sim.hit({x:4,z:3},0,0);
    for(let frame=1;frame<=45;frame++){
      const age=Math.min(frame/60,.4),b=bullet({age,damaging:frame<=24,trailTime:Math.max(0,frame/60-.4),traveled:age*70,speed:70,position:{x:age*70,z:0}});
      sim.update(1/60,[b]);
      for(const p of live(sim)){
        const pose=sim.pose(p);assert.ok([pose.x,pose.y,pose.width,pose.height,pose.angle,...pose.color].every(Number.isFinite),`${key}/${p.spec.id}`);
        if(pose.mesh)assert.ok([...pose.mesh.position,...pose.mesh.rotation,...pose.mesh.scale].every(Number.isFinite));
        if(pose.frame!==undefined)assert.ok(pose.frame>=0&&pose.frame<p.spec.textureSheet.tilesX*p.spec.textureSheet.tilesY);
      }
    }
  }
});

test('projectile view crops atlas tiles, preserves blend modes and dispatches mesh poses',()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const ts=require('typescript');
  class Color {set(r,g,b,a){Object.assign(this,{r,g,b,a});}}
  class Sprite {updateMaterial(){}}
  class UITransform {setContentSize(width,height){Object.assign(this,{width,height});}}
  class Rect {constructor(x,y,width,height){Object.assign(this,{x,y,width,height});}}
  class Size {constructor(width,height){Object.assign(this,{width,height});}}
  class SpriteFrame {reset(options){Object.assign(this,options);}destroy(){this.destroyed=true;}}
  class OriginalParticleMesh {constructor(sprite,geometry){Object.assign(this,{sprite,geometry});}update(pose){this.last=JSON.parse(JSON.stringify(pose));}setTint(tint){this.tint=tint.slice();}}
  const cc={Color,Sprite,UITransform,Rect,Size,SpriteFrame,gfx:{BlendFactor:{ZERO:0,ONE:1,SRC_ALPHA:5,ONE_MINUS_SRC_ALPHA:10}}};
  const textureSheet={tilesX:4,tilesY:3,cycles:1,frame:{mode:1,value:1,min:0,keys:[{time:0,value:0,outSlope:1},{time:1,value:1,inSlope:1}],minKeys:[]},startFrame:curve(0)};
  const base=spec({kind:'hit',image:{path:'sheet',sizePx:[128,192],sizeUnits:[1,1],anchor:[.5,.5]},textureSheet,blend:{source:1,destination:0},
    startColor:[1,1,1,1],materialColor:[2.5,2,1,2]});
  const systems=[base,{...base,id:'mesh',mesh:{source:'fixture',name:'triangle',positions:[[0,0,0],[1,0,0],[0,1,0]],uv:[[0,0],[1,0],[0,1]],indices:[0,1,2]}}];
  const original={texture:{id:'original'}};
  const art={frames:new Map([['sheet',original]]),weaponVisuals:{appearance:()=>({projectileSkin:'test'}),config:{projectileSkins:{test:systems}}},image:()=>{
    const sprite=new Sprite(),transform=new UITransform();sprite.spriteFrame=original;
    return {isValid:true,getComponent:kind=>kind===Sprite?sprite:transform,setPosition(x,y){Object.assign(this,{x,y});},destroy(){this.isValid=false;}};
  }};
  const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view/OriginalProjectiles.ts'),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
    {exports:module.exports,module,require:id=>id==='cc'?cc:id==='./OriginalParticleSimulation'?{OriginalParticleSimulation}:id==='./OriginalParticleMesh'?{OriginalParticleMesh}:{}});
  const effect=new module.exports.OriginalProjectiles(art,{},()=>({}));effect.hit({x:2,z:3},0,0,0);effect.update(.5,[]);
  const views=Array.from(effect.skins.values())[0].views.filter(v=>v.node.active);
  assert.equal(views.length,2);
  for(const v of views){assert.equal(v.sprite.srcBlendFactor,1);assert.equal(v.sprite._dstBlendFactor,0);
    assert.deepEqual({...v.sprite.spriteFrame.rect},{x:96,y:0,width:32,height:64});
  }
  assert.equal(views[0].sprite.spriteFrame,views[1].sprite.spriteFrame,'both renderers reuse the same tile asset');
  assert.deepEqual(views.find(v=>v.mesh).mesh.last.position,[2,0,3]);
  assert.deepEqual(Array.from(views.find(v=>v.mesh).mesh.tint),[2.5,2,1,2],'mesh tint keeps float HDR until fragment texture multiplication');
  const frames=Array.from(effect.sheetFrames.values());effect.destroy();assert.ok(frames.every(f=>f.destroyed));assert.equal(original.destroyed,undefined);
});

test('authored noise module produces finite seeded visual motion without mutating a combat bullet',()=>{
  const source=Object.values(visuals.projectileSkins).flat().find(s=>s.noise);
  assert.ok(source);assert.equal(source.noise.frequency,.5);assert.equal(source.noise.octaves,1);
  const noiseOnly={...source,kind:'hit',bursts:[{time:0,count:1}],timeEmissionRate:0,emissionRate:0,prewarm:false,
    lifetime:curve(2),speed:curve(0),shape:null,gravity:curve(0),inheritVelocity:null};
  const run=seed=>{
    const sim=new OriginalParticleSimulation([noiseOnly],()=>seed);sim.hit({x:0,z:0});
    const combat=bullet(),before=JSON.stringify(combat);sim.update(.05,[combat]);assert.equal(JSON.stringify(combat),before);
    const p=live(sim)[0];assert.ok(p);assert.ok([p.x,p.y,p.z,p.vx,p.vy,p.vz].every(Number.isFinite));return [p.x,p.y,p.z];
  };
  assert.deepEqual(run(.2),run(.2),'visual seed produces deterministic reconstruction');
  assert.notDeepEqual(run(.2),run(.7),'independent particles receive distinct noise paths');
});

test('authored smoke collision prevents tunneling and applies bounce and lifetime loss, skipping disabled boxes',()=>{
  const source=Object.values(visuals.projectileSkins).flat().find(s=>s.collision);
  assert.ok(source);close(source.collision.m_Bounce.scalar,.5);close(source.collision.m_EnergyLossOnCollision.scalar,.3);
  const makeParticle=()=>({index:0,spec:source,active:true,age:0,life:2,size:1,x:2,y:2,z:0,vx:10,vy:0,vz:0,random:.5});
  const box={minX:-1,maxX:1,minY:0,maxY:6,minZ:-1,maxZ:1},from={x:-2,y:2,z:0},p=makeParticle();
  advanceParticleExtra(p,.4,from,[box]);assert.ok(p.x<-1,'swept contact remains outside the box');
  close(p.vx,-5);close(p.age,.6);assert.equal(p.active,true);
  const disabled=makeParticle();advanceParticleExtra(disabled,.4,from,[{...box,enabled:false}]);
  close(disabled.x,2);close(disabled.vx,10);close(disabled.age,0);
  assert.equal(source.collision.interiorCollisions,false);
  const interior=makeParticle();advanceParticleExtra(interior,.2,{x:0,y:2,z:0},[box]);
  close(interior.x,2);close(interior.age,0);close(interior.vx,10);
});
