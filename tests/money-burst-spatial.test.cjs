const test=require('node:test');
const assert=require('node:assert/strict');
const config=require('../assets/resources/art/effects/money-burst/config.json');
const {MoneyBurstSimulation}=require('./.build/money/view/MoneyBurstSimulation.js');
const {evaluateParticleCurve}=require('./.build/money/view/OriginalParticleSimulation.js');
const {particleVelocityKeep}=require('./.build/money/view/OriginalParticleMotion.js');

// Independent pre-index oracle: retain the old full-array traversal, integrator
// and slab sweep here. It does not call the production grid or narrow phase.
// Spawning/curve sampling are shared because this change does not alter them.
class BruteForceMoney extends MoneyBurstSimulation {
  update(dt,trees,frameTime) {
    if(!(dt>0)||!Number.isFinite(dt))return;
    const endTime=typeof frameTime==='number'&&Number.isFinite(frameTime)?Math.max(this.clock,frameTime):Math.min(Number.MAX_VALUE,this.clock+dt);
    const c=this.config.collision;
    this.referenceBoxes=[...this.walls.map(wall=>({...wall,minY:c.wallMinY,maxY:c.wallMaxY})),
      ...trees.filter(tree=>tree.alive).map(tree=>({...tree.collider,minY:tree.colliderMinY??c.treeMinY,maxY:tree.colliderMaxY??c.treeMaxY}))];
    for(const p of this.particles)if(p.active) {
      const elapsed=Math.max(0,Math.min(dt,endTime-p.startedAt-p.age));
      if(elapsed>=p.life-p.age){p.age=p.life;p.active=false;continue;}
      let remaining=elapsed;
      while(remaining>1e-10){const used=Math.min(1/120,remaining);this.referenceAdvance(p,used);remaining-=used;}
    }
    this.clock=endTime;
  }
  referenceAdvance(p,dt) {
    const c=this.config,t=Math.min(1,(p.age+dt*.5)/p.life);
    p.rotation+=evaluateParticleCurve(c.rotationCurve,t,p.random)*dt;
    p.vy-=9.81*evaluateParticleCurve(c.gravity,t,p.random)*dt;
    const keep=particleVelocityKeep(Math.hypot(p.vx,p.vy,p.vz),c.limitVelocity.magnitude,c.limitVelocity.dampen,dt);
    p.vx*=keep;p.vy*=keep;p.vz*=keep;
    const radius=Math.max(0,p.size*evaluateParticleCurve(c.sizeCurve,t,p.random)*.5*c.collision.radiusScale);
    let remaining=dt;
    for(let bounce=0;bounce<6&&remaining>1e-10;bounce++) {
      let contact=null;
      if(p.y<radius)contact={time:0,nx:0,ny:1,nz:0,penetration:radius-p.y};
      else if(p.vy<0&&p.y+p.vy*remaining<radius)contact={time:(radius-p.y)/(p.vy*remaining),nx:0,ny:1,nz:0,penetration:0};
      for(const box of this.referenceBoxes){const hit=referenceSweep(p,remaining,box,radius);if(hit&&(!contact||hit.time<contact.time))contact=hit;}
      if(!contact){p.x+=p.vx*remaining;p.y+=p.vy*remaining;p.z+=p.vz*remaining;break;}
      const {time,nx,ny,nz,penetration}=contact;
      p.x+=p.vx*remaining*time+nx*(penetration+1e-5);
      p.y+=p.vy*remaining*time+ny*(penetration+1e-5);
      p.z+=p.vz*remaining*time+nz*(penetration+1e-5);
      const dot=p.vx*nx+p.vy*ny+p.vz*nz;
      if(dot<0){const loss=1-c.collision.dampen;p.vx=(p.vx-(1+p.bounce)*dot*nx)*loss;p.vy=(p.vy-(1+p.bounce)*dot*ny)*loss;p.vz=(p.vz-(1+p.bounce)*dot*nz)*loss;}
      remaining*=1-time;
    }
    p.age+=dt;
  }
}
function referenceSweep(p,dt,b,r) {
  const minX=b.minX-r,minY=b.minY-r,minZ=b.minZ-r,maxX=b.maxX+r,maxY=b.maxY+r,maxZ=b.maxZ+r;
  if(p.x>minX&&p.x<maxX&&p.y>minY&&p.y<maxY&&p.z>minZ&&p.z<maxZ){
    let penetration=Infinity,axis=0,sign=1;
    for(let i=0;i<3;i++){const origin=i===0?p.x:i===1?p.y:p.z,min=i===0?minX:i===1?minY:minZ,max=i===0?maxX:i===1?maxY:maxZ;
      if(origin-min<penetration){penetration=origin-min;axis=i;sign=-1;}if(max-origin<penetration){penetration=max-origin;axis=i;sign=1;}}
    return {time:0,nx:axis===0?sign:0,ny:axis===1?sign:0,nz:axis===2?sign:0,penetration};
  }
  let enter=0,exit=1,axis=-1,sign=0;
  for(let i=0;i<3;i++){const origin=i===0?p.x:i===1?p.y:p.z,travel=(i===0?p.vx:i===1?p.vy:p.vz)*dt;
    const min=i===0?minX:i===1?minY:minZ,max=i===0?maxX:i===1?maxY:maxZ;
    if(Math.abs(travel)<1e-12){if(origin<min||origin>max)return null;continue;}
    const a=(min-origin)/travel,z=(max-origin)/travel,near=Math.min(a,z),far=Math.max(a,z);
    if(near>=enter){enter=near;axis=i;sign=travel>0?-1:1;}exit=Math.min(exit,far);if(enter>exit)return null;
  }
  if(axis<0||enter<0||enter>1||exit<0)return null;
  return {time:enter,nx:axis===0?sign:0,ny:axis===1?sign:0,nz:axis===2?sign:0,penetration:0};
}
function tree(minX,maxX,minZ,maxZ,extra={}){return {alive:true,collider:{minX,maxX,minZ,maxZ},...extra};}
function pair(settings=config){return [new MoneyBurstSimulation(settings,1234567),new BruteForceMoney(settings,1234567)];}
function step(sims,dt,trees,time){for(const s of sims)s.update(dt,trees,time);assert.deepEqual(sims[0].particles,sims[1].particles);assert.equal(sims[0].clock,sims[1].clock);}
function collisionPair(pose,settings={}) {
  const c=structuredClone(config);c.gravity.value=0;c.limitVelocity.magnitude=1e12;c.collision.dampen=0;c.collision.radiusScale=0;Object.assign(c.collision,settings);
  const sims=pair(c);
  for(const s of sims){s.setWalls([]);s.spawn({x:0,z:0});for(const p of s.particles)p.active=false;Object.assign(s.particles[0],{active:true,age:0,life:3,x:0,y:2,z:0,vx:0,vy:0,vz:0,bounce:1},pose);}
  return sims;
}

test('money spatial broad phase matches full traversal in 500-tree battles at 30/60/120 Hz',()=>{
  const trees=Array.from({length:500},(_,i)=>tree((i%20)*5-48,(i%20)*5-46,Math.floor(i/20)*5-48,Math.floor(i/20)*5-46));
  for(const fps of [30,60,120]){
    const sims=pair();
    for(let i=0;i<40;i++)for(const s of sims)s.spawn({x:(i%8)*7-25,z:Math.floor(i/8)*7-20});
    for(let frame=0;frame<fps*2;frame++)step(sims,1/fps,trees);
  }
});
test('money swept query crosses many cells and includes negative and exact cell boundaries',()=>{
  for(const pose of [{x:-50,z:-10,vx:12000,vz:0},{x:50,z:10,vx:-12000,vz:0},{x:10,z:-50,vx:0,vz:12000},{x:-10,z:50,vx:0,vz:-12000}]){
    const sims=collisionPair(pose);step(sims,1/120,[tree(-10,10,-10,10)]);
    assert.ok(sims[0].particles[0].vx!==pose.vx||sims[0].particles[0].vz!==pose.vz,'fixture must collide');
  }
});
test('money query expands by radius and retains authored collider vertical bounds',()=>{
  const sims=collisionPair({x:9.7,z:9,vz:120,size:2},{radiusScale:.5});
  step(sims,1/120,[tree(10,12,10,12)]);assert.ok(sims[0].particles[0].vz<0);
  const above=collisionPair({x:0,y:8,vx:1200});step(above,1/120,[tree(2,4,-2,2,{colliderMinY:0,colliderMaxY:3})]);
  assert.equal(above[0].particles[0].x,10);
});
test('money deduplicates multi-cell colliders and keeps original equal-time tree and wall order',()=>{
  const trees=[tree(8,35,-25,35),tree(-25,35,8,35),tree(-35,35,-35,35)];
  for(const order of [trees,[...trees].reverse()]){
    const sims=collisionPair({x:9,z:9,vx:180,vz:180});
    for(const s of sims)s.setWalls([{minX:9.5,maxX:11,minZ:-40,maxZ:40}]);
    for(let frame=0;frame<12;frame++)step(sims,1/120,order);
  }
});
test('money re-queries after rebounds and preserves corner/overlap six-contact budget',()=>{
  const trees=[tree(-11,-10,-5,5),tree(10,11,-5,5),tree(-20,20,5,6)];
  const sims=collisionPair({x:0,z:0,vx:100000,vz:1000});step(sims,1/120,trees);
  const overlapping=collisionPair({x:10,z:0,vx:-50,vy:-10});
  for(let frame=0;frame<10;frame++)step(overlapping,1/60,[tree(8,12,-2,2),tree(9,14,-3,3)]);
});
test('money index refreshes after tree death, collider movement, and map/wall replacement',()=>{
  const trees=[tree(-5,-3,-5,-3),tree(2,4,-2,2)],sims=collisionPair({vx:100});
  step(sims,1/120,trees);trees[1].alive=false;step(sims,1/120,trees);
  trees[0].collider={minX:2,maxX:3,minZ:-1,maxZ:1};step(sims,1/120,trees);
  for(const s of sims)s.setWalls([{minX:-1,maxX:0,minZ:-4,maxZ:4}]);
  step(sims,1/30,[tree(-40,-30,-40,-30)]);
  for(const s of sims){s.reset(18);s.setWalls([]);s.spawn({x:-35,z:-35});}
  step(sims,1/60,[tree(-36,-34,-36,-34)]);
});
test('money preserves source timestamps, invalid deltas and lifetime expiry with indexed colliders',()=>{
  const sims=pair(),trees=[tree(-1,1,-1,1)];
  for(const s of sims)s.spawn({x:0,z:0},0);
  for(const dt of [0,-1,NaN,Infinity])step(sims,dt,trees);
  step(sims,.1,trees,.1);
  for(const s of sims){s.spawn({x:10,z:0},.39);s.spawn({x:20,z:0},.35);}
  step(sims,.3,trees,.4);step(sims,0,trees,.5);step(sims,.1,trees,.5);
  for(const s of sims)s.spawn({x:0,z:0},999999.99);
  step(sims,1e6,trees,1e6);
});
test('money skips collider reads for empty or expiring pools and reuses collision storage after warmup',()=>{
  const s=new MoneyBurstSimulation(config,5),unreadable=new Proxy([],{get(){throw new Error('inactive pool read trees');}});
  s.update(1,unreadable);assert.equal(s.clock,1);s.spawn({x:0,z:0});s.update(4,unreadable);assert.equal(s.clock,5);
  const trees=Array.from({length:100},(_,i)=>tree(i%10*5,i%10*5+2,Math.floor(i/10)*5,Math.floor(i/10)*5+2));
  s.spawn({x:0,z:0});s.update(1/120,trees);
  const boxes=[...s.treeBoxes],walls=[...s.wallBoxes],rows=[...s.gridRows],cells=[...s.gridCells];
  for(let i=0;i<30;i++)s.update(1/120,trees);
  for(const [now,before] of [[s.treeBoxes,boxes],[s.wallBoxes,walls],[s.gridRows,rows],[s.gridCells,cells]]){assert.equal(now.length,before.length);now.forEach((value,i)=>assert.equal(value,before[i]));}
});
