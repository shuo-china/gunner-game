const test=require('node:test');
const assert=require('node:assert/strict');
const config=require('../assets/resources/art/effects/money-burst/config.json');
const {MoneyBurstSimulation}=require('./.build/money/view/MoneyBurstSimulation.js');
const {projectWorld}=require('./.build/money/core/projection.js');
const close=(a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const clone=()=>JSON.parse(JSON.stringify(config));

function collisionFixture() {
  const settings=clone();settings.gravity.value=0;settings.limitVelocity.magnitude=1e9;
  settings.collision.dampen=0;settings.collision.radiusScale=0;
  const simulation=new MoneyBurstSimulation(settings,123);
  simulation.spawn({x:0,z:0});
  for(const p of simulation.particles)p.active=false;
  const p=simulation.particles[0];
  Object.assign(p,{active:true,age:0,life:3,x:0,y:2,z:0,vx:0,vy:0,vz:0,bounce:1});
  return {simulation,p};
}
function tree(alive=true) {
  return {id:1,degree:0,position:{x:5,z:0},health:250,maxHealth:250,alive,
    collider:{minX:2,maxX:8,minZ:-3,maxZ:3}};
}

test('tree deaths emit five original cash atlas cells with original motion ranges and spawn height',()=>{
  const simulation=new MoneyBurstSimulation(config,42);simulation.spawn({x:10,z:20});
  assert.deepEqual(simulation.diagnostics(),{active:5,pooled:5});
  assert.deepEqual(config.tiles,[3,3]);assert.equal(config.atlas.path,'art/effects/money-burst/cash_atlas');
  assert.deepEqual(config.atlas.sizePx,[128,128]);assert.equal(config.maxParticles,1000);
  for(const p of simulation.particles) {
    assert.equal(p.y,2);assert.ok(Math.hypot(p.x-10,p.z-20)<=.400001);
    assert.ok(p.life>=1&&p.life<=3);assert.ok(p.size>=1.7999&&p.size<=3);
    assert.ok(Math.hypot(p.vx,p.vy,p.vz)>=35&&Math.hypot(p.vx,p.vy,p.vz)<=50);
    assert.ok(p.vy>0);assert.ok(p.frame>=0&&p.frame<9);
  }
  const frames=simulation.particles.map(p=>p.frame);
  simulation.update(.2,[]);assert.deepEqual(simulation.particles.map(p=>p.frame),frames);
});

test('visual RNG repeats after reset, never reads Math.random, and preserves pool allocation',()=>{
  const previous=Math.random;Math.random=()=>{throw new Error('shared RNG must not be used');};
  try {
    const simulation=new MoneyBurstSimulation(config,9);
    simulation.spawn({x:1,z:3});const first=JSON.stringify(simulation.particles);
    simulation.update(.1,[]);simulation.reset(9);
    assert.deepEqual(simulation.diagnostics(),{active:0,pooled:5});
    simulation.spawn({x:1,z:3});assert.equal(JSON.stringify(simulation.particles),first);
    simulation.reset(10);simulation.spawn({x:1,z:3});assert.notEqual(JSON.stringify(simulation.particles),first);
  } finally {Math.random=previous;}
});

test('source pool cap is bounded, simultaneous bursts survive, and all final-tree particles finish',()=>{
  const simulation=new MoneyBurstSimulation(config);
  for(let i=0;i<205;i++)simulation.spawn({x:0,z:0});
  assert.deepEqual(simulation.diagnostics(),{active:1000,pooled:1000});
  simulation.update(3.01,[]);assert.deepEqual(simulation.diagnostics(),{active:0,pooled:1000});
  simulation.spawn({x:0,z:0});assert.deepEqual(simulation.diagnostics(),{active:5,pooled:1000});
});

test('pause/invalid deltas freeze particles and ordinary frame rates share 120 Hz motion',()=>{
  const a=new MoneyBurstSimulation(config,18),b=new MoneyBurstSimulation(config,18);
  a.spawn({x:0,z:0});b.spawn({x:0,z:0});const snapshot=JSON.stringify(a.particles);
  for(const dt of [0,-1,Infinity,NaN])a.update(dt,[]);
  assert.equal(JSON.stringify(a.particles),snapshot);
  for(let i=0;i<12;i++)a.update(1/30,[]);
  for(let i=0;i<48;i++)b.update(1/120,[]);
  a.particles.forEach((p,i)=>{for(const field of ['x','y','z','vx','vy','vz','age','rotation'])close(p[field],b.particles[i][field]);});
});

test('source tick timestamps age new bursts only for the residual render time and existing particles for dt',()=>{
  const simulation=new MoneyBurstSimulation(config,18);
  simulation.spawn({x:0,z:0},0);simulation.update(.1,[],.1);
  simulation.spawn({x:10,z:0},.39);
  simulation.spawn({x:20,z:0},.35);
  simulation.update(.3,[],.4);
  for(const p of simulation.particles.slice(0,5))close(p.age,.4);
  for(const p of simulation.particles.slice(5,10))close(p.age,.01);
  for(const p of simulation.particles.slice(10,15))close(p.age,.05);
  simulation.update(.1,[],.5);
  for(const p of simulation.particles.slice(0,5))close(p.age,.5);
  for(const p of simulation.particles.slice(5,10))close(p.age,.11);
  for(const p of simulation.particles.slice(10,15))close(p.age,.15);
});

test('source timestamp is replaced on pool reuse, replay resets the clock, and zero dt does not age',()=>{
  const simulation=new MoneyBurstSimulation(config,18);simulation.spawn({x:0,z:0},0);
  simulation.update(3.1,[],3.1);assert.equal(simulation.diagnostics().active,0);
  simulation.spawn({x:0,z:0},3.29);simulation.update(.2,[],3.3);
  assert.equal(simulation.diagnostics().pooled,5);
  for(const p of simulation.particles)close(p.age,.01);
  simulation.update(0,[],3.4);for(const p of simulation.particles)close(p.age,.01);
  simulation.update(.1,[],3.4);for(const p of simulation.particles)close(p.age,.11);
  simulation.reset();simulation.spawn({x:0,z:0});simulation.update(.1,[]);
  for(const p of simulation.particles){close(p.startedAt,0);close(p.age,.1);}
});

test('large absolute frame time expires old particles but preserves a recent emission without catch-up',()=>{
  const simulation=new MoneyBurstSimulation(config,18);simulation.spawn({x:0,z:0},0);
  simulation.spawn({x:10,z:0},999999.99);simulation.update(1e6,[],1e6);
  for(const p of simulation.particles.slice(0,5))assert.equal(p.active,false);
  for(const p of simulation.particles.slice(5,10)){assert.equal(p.active,true);close(p.age,.01);assert.ok(Number.isFinite(p.y));}
});

test('continuous collisions prevent fast particles tunneling through the floor and current map wall',()=>{
  const {simulation,p}=collisionFixture();p.y=.1;p.vy=-1000;
  simulation.update(.01,[]);assert.ok(p.y>=0);assert.ok(p.vy>0);
  Object.assign(p,{x:27,y:2,z:0,vx:1000,vy:0,vz:0});
  simulation.update(.01,[]);assert.ok(p.x<27.49990082);assert.ok(p.vx<0);
});

test('living tree volumes block particles, dead tree volumes do not, and combat state is untouched',()=>{
  const live=collisionFixture(),dead=collisionFixture();
  const obstacle=tree(),snapshot=JSON.stringify(obstacle);
  live.p.vx=1000;dead.p.vx=1000;
  live.simulation.update(.01,[obstacle]);dead.simulation.update(.01,[tree(false)]);
  assert.ok(live.p.vx<0);assert.ok(live.p.x<2);close(dead.p.x,10);
  assert.equal(JSON.stringify(obstacle),snapshot);
  const above=collisionFixture();above.p.y=7;above.p.vx=1000;
  above.simulation.update(.01,[obstacle]);close(above.p.x,10);
});

test('starting overlaps resolve outside a live tree without getting stuck in repeated contacts',()=>{
  const {simulation,p}=collisionFixture();p.x=2.1;p.vx=-5;
  simulation.update(.01,[tree()]);assert.ok(p.x<2);assert.ok(Number.isFinite(p.vx));
});

test('billboard pose uses original world projection and source shrink curve without alpha flight',()=>{
  const simulation=new MoneyBurstSimulation(config);simulation.spawn({x:0,z:0});const p=simulation.particles[0];
  Object.assign(p,{x:4,y:3,z:7,age:0,size:2,rotation:Math.PI});
  const pose=simulation.pose(p),projection=projectWorld(p,p.y);
  close(pose.x,projection.x);close(pose.y,projection.y);close(pose.size,2);close(pose.angle,-180);
  p.age=p.life;close(simulation.pose(p).size,0);
});

function moneyViewHarness(failFrameAt=0,viewConfig=config,renderable=false) {
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const ts=require('typescript');
  const frames=[],nodes=[];
  class Node {
    static EventType={NODE_DESTROYED:'destroyed'};
    constructor(name=''){this.name=name;this.children=[];this.isValid=true;this.listeners=[];this.destroyCalls=0;nodes.push(this);}
    once(event,fn,target){this.listeners.push({event,fn,target});}
    destroy(){
      if(!this.isValid)return;this.isValid=false;this.destroyCalls++;
      for(const {fn,target} of this.listeners.splice(0))fn.call(target);
      for(const child of this.children)child.destroy();
    }
  }
  class SpriteFrame {
    constructor(){this.destroyCalls=0;frames.push(this);}
    reset(options){if(frames.length===failFrameAt)throw new Error('frame reset failed');Object.assign(this,options);}
    destroy(){this.destroyCalls++;}
  }
  class Sprite {}
  class UITransform {setContentSize(width,height){this.width=width;this.height=height;}}
  let positions=0;
  class OrderedQuadBatch {
    constructor(){this.quads=[];this.destroyed=false;}
    begin(){this.quads.length=0;}
    add(frame,x,y,width,height,anchorX,anchorY,angle){
      assert.ok(renderable,'Disposed views must not submit quads');positions++;
      this.quads.push({frame,x,y,width,height,anchorX,anchorY,angle});
    }
    end(){}
    destroy(){this.destroyed=true;this.quads.length=0;}
  }
  const cc={Node,SpriteFrame,Sprite,UITransform,Rect:class {constructor(x,y,width,height){Object.assign(this,{x,y,width,height});}},
    Size:class {constructor(width,height){Object.assign(this,{width,height});}}};
  const artModule={makeNode:(name,parent)=>{const node=new Node(name);parent.children.push(node);return node;}};
  const source=fs.readFileSync(path.resolve(__dirname,'../assets/scripts/view/OriginalMoneyBurst.ts'),'utf8');
  const module={exports:{}};
  const imports={cc,'./ArtLibrary':artModule,'./MoneyBurstSimulation':{MoneyBurstSimulation},
    './OrderedQuadBatch':{OrderedQuadBatch}};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
    {module,exports:module.exports,require:name=>{assert.ok(name in imports,`Unexpected import ${name}`);return imports[name];}});
  const atlas={texture:{},destroyCalls:0,destroy(){this.destroyCalls++;}};
  const art={frames:new Map([[viewConfig.atlas.path,atlas]]),image(name,spec,parent){
    assert.ok(renderable,'Disposed views must not allocate particle nodes');
    const node=new Node(name),sprite=new Sprite(),transform=new UITransform();parent.children.push(node);
    node.getComponent=type=>type===Sprite?sprite:transform;
    node.setPosition=(x,y,z)=>{positions++;Object.assign(node,{x,y,z});};return node;
  }};
  const parent=new Node('Parent');
  return {create:()=>new module.exports.OriginalMoneyBurst(art,parent,viewConfig),parent,frames,nodes,atlas,positions:()=>positions};
}

test('same-frame cash bursts submit once with source timestamps and immediate reset',()=>{
  for(const count of [1,20,200]) {
    const h=moneyViewHarness(0,config,true),view=h.create(),reference=new MoneyBurstSimulation(config);
    let submits=0;const render=view.render.bind(view);view.render=()=>{submits++;render();};
    for(let i=0;i<count;i++){const position={x:i%10,z:Math.floor(i/10)},time=i%2?.09:0;
      view.spawn(position,time);reference.spawn(position,time);}
    assert.equal(submits,0);assert.equal(h.positions(),0);
    view.update(.1,[],.1);reference.update(.1,[],.1);
    assert.equal(submits,1);assert.equal(h.positions(),count*config.count);
    assert.deepEqual(view.simulation.particles,reference.particles,'deferred rendering cannot alter particle timing or state');
    assert.equal(view.batch.quads.length,count*config.count);
    for(let i=0;i<view.batch.quads.length;i++) {
      const p=reference.particles[i],pose=reference.pose(p),quad=view.batch.quads[i];
      close(quad.x,pose.x);close(quad.y,pose.y);close(quad.angle,pose.angle);
      close(quad.width,pose.size);close(quad.height,pose.size);
      assert.equal(quad.frame,view.frames[p.frame]);
      assert.equal(quad.anchorX,config.atlas.anchor[0]);assert.equal(quad.anchorY,config.atlas.anchor[1]);
    }
    assert.equal(h.nodes.length,2,'the money view no longer allocates one Node per particle');
    view.reset();assert.equal(view.batch.quads.length,0);view.destroy();assert.equal(view.batch.destroyed,true);
  }
});

test('money view owns fractional cash atlas frames and explicit teardown releases each exactly once',()=>{
  const h=moneyViewHarness(),view=h.create();assert.equal(h.frames.length,9);
  for(const frame of h.frames){close(frame.rect.width,128/3);close(frame.rect.height,128/3);assert.equal(frame.packable,false);}
  view.destroy();view.destroy();
  view.spawn({x:0,z:0});view.update(.1,[]);view.reset();
  for(const frame of h.frames)assert.equal(frame.destroyCalls,1);
  assert.equal(h.nodes[1].destroyCalls,1);assert.equal(h.atlas.destroyCalls,0);
  assert.deepEqual({...view.diagnostics()},{active:0,pooled:0});
});

test('parent destruction frees generated frames even without an explicit money view destroy',()=>{
  const h=moneyViewHarness(),view=h.create();h.parent.destroy();view.destroy();
  for(const frame of h.frames)assert.equal(frame.destroyCalls,1);
  assert.equal(h.atlas.destroyCalls,0);assert.equal(h.nodes[1].destroyCalls,1);
});

test('partial money constructor failure frees the failing frame and all previously generated frames',()=>{
  const h=moneyViewHarness(4);assert.throws(()=>h.create(),/frame reset failed/);
  assert.equal(h.frames.length,4);
  for(const frame of h.frames)assert.equal(frame.destroyCalls,1);
  assert.equal(h.nodes[1].isValid,false);assert.equal(h.atlas.destroyCalls,0);
  h.parent.destroy();for(const frame of h.frames)assert.equal(frame.destroyCalls,1);
});
