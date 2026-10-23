const { projectPath } = require('./support/paths.cjs');
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const math=require('./.build/feedback/view/WeaponGradeEffectSimulation.js');
const {WeaponGradeEffectSimulation}=math;
const {getWeaponIdsForGrade}=require('./.build/feedback/core/WeaponCatalog.js');
const particleMath=require('./.build/feedback/view/OriginalParticleSimulation.js');
const projection=require('./.build/feedback/core/projection.js');
const source=require(projectPath('assets/resources/art/weapon-grade-effects/config.json'));
const curve=value=>({mode:0,value,min:0,keys:[],minKeys:[]});
const close=(a,b,epsilon=1e-5)=>assert.ok(Math.abs(a-b)<epsilon,`${a} != ${b}`);
const live=sim=>sim.particles.filter(p=>p.active);
const fixture=(overrides={})=>({...source.grades[4].systems[0],id:'main',scale:1,lifetime:curve(10),size:curve(1),speed:curve(0),gravity:curve(0),rotation:curve(0),
  simulationSpace:0,sourceTransform:{position:[0,0,0],rotation:[0,0,0,1]},timeEmissionRate:0,emissionRate:0,bursts:[{time:0,count:1,cycles:1,interval:0,probability:1}],
  duration:1,looping:false,prewarm:false,shape:null,sizeCurve:null,gradient:null,rotationCurve:null,inheritVelocity:null,limitVelocity:null,...overrides});
const config=systems=>({source:'fixture',grades:[{grade:0,systems}],images:{}});

test('13 source grades export every enabled emitter, original hierarchy and actual renderer material',()=>{
  assert.deepEqual(source.grades.map(g=>g.systems.length),[0,0,0,0,3,3,3,4,4,4,5,5,5]);
  for(const grade of source.grades)for(const s of grade.systems){
    assert.equal(s.sortingLayer,0);assert.ok(s.hierarchy.length>=2);assert.equal(s.hierarchy[0].name,'Degree_FX');
    assert.ok(fs.existsSync(projectPath('assets/resources', s.image.path+'.png')),s.image.path);
    assert.ok(s.materialSource&&s.shader.source);assert.ok(s.scale>0);assert.ok(s.maxParticles>0);
    if(s.spriteShape){assert.equal(s.spriteShape.placementMode,0);assert.equal(s.spriteShape.vertices.length,16);}
    for(const sub of s.subEmitters??[]){assert.equal(sub.event,0);assert.equal(sub.properties,0);assert.ok(grade.systems.some(child=>child.id===sub.id));}
  }
  for(const grade of source.grades.slice(10)){
    const trail=grade.systems.find(s=>s.trail),shadow=grade.systems.find(s=>s.name==='shadow');
    assert.equal(trail.renderMode,5);assert.equal(trail.sortingOrder,0);assert.ok(trail.materialSource.endsWith(':14'));
    assert.equal(shadow.renderMode,3);assert.equal(shadow.sortingOrder,-15);assert.equal(shadow.sheetSprites.length,1);
    assert.deepEqual(trail.materialColor,[1,1,1,1]);assert.deepEqual(shadow.materialColor,[1,1,1,1]);
    assert.equal(trail.shader.materialTintIgnored,true,'source Mobile GLES only multiplies texture by vertex color');
    assert.ok(shadow.sheetSprites[0].path.includes('819'));assert.equal(shadow.bursts[0].cycles,0);
  }
});

test('a grade follows explicit catalog metadata and D through A remain empty',()=>{
  const sim=new WeaponGradeEffectSimulation(source,()=>.5);
  for(let id=0;id<14;id++){sim.setWeapon(id);sim.update(1,[0,0,0]);assert.equal(live(sim).length,0);}
  assert.equal(sim.setWeapon(14),true);sim.update(1,[0,0,0]);assert.ok(live(sim).length>0);
  const particle=live(sim)[0],age=particle.age;
  assert.equal(sim.setWeapon(18),false);sim.update(.1,[0,0,0]);assert.ok(particle.age>age);
  assert.equal(sim.setWeapon(19),true);assert.equal(sim.particles.length,0);
});

test('local glow follows a moving cat, world particles stay, and movement-only spikes use distance',()=>{
  const sim=new WeaponGradeEffectSimulation(config([fixture({id:'local'}),fixture({id:'world',simulationSpace:1}),
    fixture({id:'spike',simulationSpace:1,bursts:[],emissionRate:5,looping:true})]),()=>.5);
  sim.setWeapon(0);sim.update(0,[0,0,0]);sim.update(1,[0,0,0]);assert.equal(live(sim).length,2);
  sim.update(1,[2,0,0]);close(live(sim).find(p=>p.spec.id==='local').x,2);close(live(sim).find(p=>p.spec.id==='world').x,0);
  const spikes=live(sim).filter(p=>p.spec.id==='spike');assert.equal(spikes.length,10);
  close(Math.min(...spikes.map(p=>p.x)),.2);close(Math.max(...spikes.map(p=>p.x)),2);
});

test('birth child waits for its source burst and inherits parent particle velocity',()=>{
  const parent=fixture({id:'parent',simulationSpace:1,speed:curve(3),subEmitters:[{id:'child',event:0,properties:0,probability:1}]}),
    child=fixture({id:'child',simulationSpace:1,inheritVelocity:curve(1),sourceTransform:{position:[500,500,500],rotation:[0,0,0,1]},bursts:[{time:.1,count:1,cycles:1,interval:0,probability:1}]});
  const sim=new WeaponGradeEffectSimulation(config([parent,child]),()=>.5);sim.setWeapon(0);sim.update(0,[0,0,0]);assert.equal(live(sim).length,1);
  sim.update(.05,[0,0,0]);assert.equal(live(sim).length,1);sim.update(.05,[0,0,0]);
  const p=live(sim).find(p=>p.spec.id==='parent'),c=live(sim).find(p=>p.spec.id==='child');assert.ok(c);close(c.z,p.z);close(c.vz,3);close(c.x,0);close(c.y,0);
  sim.update(.1,[0,0,0]);close(c.z,p.z);assert.equal(live(sim).length,2,'child never emits autonomously');
  child.bursts[0].time=0;const immediate=new WeaponGradeEffectSimulation(config([parent,child]),()=>.5);immediate.setWeapon(0);immediate.update(0,[0,0,0]);assert.equal(live(immediate).length,2);
});

test('loop burst cycleCount=0 repeats inside each period and prewarm runs one source duration',()=>{
  const s=fixture({duration:4,looping:true,prewarm:true,bursts:[{time:0,count:1,cycles:0,interval:2,probability:1}]}),
    sim=new WeaponGradeEffectSimulation(config([s]),()=>.5);sim.setWeapon(0);sim.update(0,[0,0,0]);
  assert.equal(live(sim).length,3);close(live(sim)[0].age,4);sim.update(2,[0,0,0]);assert.equal(live(sim).length,4);
});

test('source sprite emitter uses vertices and authored full parent transform',()=>{
  const s={...source.grades[4].systems.find(s=>s.name==='FireFlies'),speed:curve(0),velocity:undefined,timeEmissionRate:0,
    bursts:[{time:0,count:1,cycles:1,interval:0,probability:1}],subEmitters:undefined};
  const sim=new WeaponGradeEffectSimulation(config([s]),()=>.5);sim.setWeapon(0);sim.update(0,[10,0,20]);const p=live(sim)[0];
  const selected=s.spriteShape.vertices[8].map(v=>v*s.scale),transformed=particleMath.particleRotate(s.sourceTransform.rotation,selected);
  close(p.x,10+s.sourceTransform.position[0]+transformed[0]);close(p.y,s.sourceTransform.position[1]+transformed[1]);close(p.z,20+s.sourceTransform.position[2]+transformed[2]);
});

test('Z trail-only renderer keeps an orbiting ribbon, local trail moves and expires with particle',()=>{
  const original=source.grades[10].systems.find(s=>s.trail),s={...original,prewarm:false,looping:false,duration:10},
    sim=new WeaponGradeEffectSimulation(config([s]),()=>.5);sim.setWeapon(0);sim.update(0,[0,0,0]);const p=live(sim)[0],x=p.x,z=p.z;
  sim.update(.5,[0,0,0]);assert.ok(p.y>s.sourceTransform.position[1]);assert.ok(Math.abs(p.x-x)+Math.abs(p.z-z)>1);
  assert.ok(p.trail.length>2);const first={...p.trail[0]};sim.update(.1,[10,0,5]);close(p.trail[0].x-first.x,10);close(p.trail[0].z-first.z,5);
  sim.update(3,[10,0,5]);assert.equal(p.active,false);assert.equal(p.trail.length,0);
});

test('all nine high grades stay finite and bounded while moving, then clean queues on deactivate',()=>{
  const sim=new WeaponGradeEffectSimulation(source,()=>.4);
  for(let grade=4;grade<13;grade++){
    sim.setWeapon(getWeaponIdsForGrade(grade)[0]);sim.update(0,[0,0,0]);
    for(let i=1;i<=600;i++)sim.update(1/60,[i/30,0,Math.sin(i/30)*2]);
    for(const p of sim.particles){assert.ok([p.x,p.y,p.z,p.size,p.life].every(Number.isFinite),p.spec.id);assert.ok(p.trail.length<150);}
    for(const s of source.grades[grade].systems)assert.ok(sim.particles.filter(p=>p.spec.id===s.id).length<=s.maxParticles);
    assert.ok(live(sim).length>0);sim.setActive(false);assert.equal(live(sim).length,0);sim.update(5,[100,0,100]);assert.equal(live(sim).length,0);
    sim.setActive(true);sim.update(.2,[0,0,0]);assert.ok(live(sim).length>0);sim.reset();assert.equal(live(sim).length,0);
  }
});

function viewHarness(){
  class UITransform {setContentSize(w,h){this.width=w;this.height=h;} }
  class Sprite {updateMaterial(){} }
  class Node {constructor(name){this.name=name;this.children=[];this.active=true;this.isValid=true;this.position={x:0,y:0,z:0};this.parts=new Map([[UITransform,new UITransform],[Sprite,new Sprite]]);this.parts.get(Sprite).node=this;}
    getComponent(type){return this.parts.get(type);} setPosition(x,y,z){this.position={x,y,z};} destroy(){this.isValid=false;this.active=false;} }
  class Color {set(...v){this.value=v;} }
  class SpriteFrame {reset(options){this.options=options;} destroy(){this.destroyed=true;} }
  class Mesh {constructor(sprite,geometry){this.sprite=sprite;this.geometry=geometry;} update(){assert.ok(this.geometry.positions.flat().every(Number.isFinite));} setTint(c){this.tint=c;} }
  const imports={'cc':{UITransform,Sprite,Node,Color,SpriteFrame,Rect:class {},Size:class {},gfx:{BlendFactor:{ONE:1,ZERO:0,SRC_ALPHA:5,ONE_MINUS_SRC_ALPHA:10}}},
    './ArtLibrary':{makeNode:(name,parent)=>{const node=new Node(name);parent.children.push(node);return node;}},'./OriginalParticleMesh':{OriginalParticleMesh:Mesh},
    './OriginalParticleSimulation':particleMath,'./WeaponGradeEffectSimulation':math,'../core/projection':projection};
  const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view/OriginalWeaponGradeEffects.ts'),'utf8'),
    {compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,require:name=>{assert.ok(name in imports,name);return imports[name];}});
  const layers=new Map(),art={weaponVisuals:{config:{gradeEffects:source}},frames:new Map(Object.values(source.images).map(s=>[s.path,{texture:{}}])),
    image:(name,_spec,parent)=>{const node=new Node(name);parent.children.push(node);return node;}};
  const view=new module.exports.OriginalWeaponGradeEffects(art,new Node('root'),order=>{if(!layers.has(order))layers.set(order,new Node('order'+order));return layers.get(order);});
  return {view,layers};
}

test('real grade view renders Default layers and trail geometry, switching/deactivation destroy or hide external nodes',()=>{
  const {view,layers}=viewHarness();view.setWeapon(44);view.update(.6,[0,0,0]);
  assert.ok(view.diagnostics().trails>0);assert.ok(layers.get(0).children.some(node=>node.active&&node.name.includes('Z Degree FX')));
  assert.ok(layers.get(-15).children.some(node=>node.active&&node.name.includes('shadow')));
  const old=Array.from(layers.values()).flatMap(layer=>layer.children).filter(node=>node.isValid);
  view.setActive(false);assert.ok(old.every(node=>!node.active));assert.equal(view.diagnostics().active,0);
  view.setActive(true);view.update(.5,[0,0,0]);assert.ok(view.diagnostics().active>0);
  view.setWeapon(14);assert.ok(old.every(node=>!node.isValid));view.update(.5,[0,0,0]);assert.equal(view.diagnostics().trails,0);
  view.setWeapon(0);view.update(2,[0,0,0]);assert.equal(view.diagnostics().pooled,0);
  view.setWeapon(54);view.update(5,[0,0,0]);view.destroy();assert.equal(view.diagnostics().pooled,0);
  assert.ok(Array.from(layers.values()).flatMap(layer=>layer.children).every(node=>!node.isValid));
});
