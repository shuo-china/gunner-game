const test=require('node:test');
const assert=require('node:assert/strict');
const {ParticleCollisionIndex,advanceParticleExtra}=require('./.build/feedback/view/OriginalParticleExtraMotion.js');
const raw=scalar=>({minMaxState:0,scalar,minScalar:scalar,maxCurve:{m_Curve:[]},minCurve:{m_Curve:[]}});
const collision=(extra={})=>({m_Dampen:raw(.1),m_Bounce:raw(.6),m_EnergyLossOnCollision:raw(.03),minKillSpeed:0,maxKillSpeed:1e9,radiusScale:1,interiorCollisions:false,...extra});
const box=(minX,maxX,minZ,maxZ,extra={})=>({minX,maxX,minY:0,maxY:6,minZ,maxZ,...extra});
const point=(x,z,y=2)=>({x,y,z});
const particle=(extra={},module=collision())=>({active:true,x:0,y:2,z:0,vx:40,vy:0,vz:0,age:.1,life:5,size:.8,random:.371,spec:{scale:1,collision:module},...extra});
function check(original,dt,from,colliders,index){
  const expected=structuredClone(original),actual=structuredClone(original);
  advanceParticleExtra(expected,dt,from,colliders);
  advanceParticleExtra(actual,dt,from,colliders,index);
  assert.deepEqual(actual,expected);return actual;
}

test('collision index retains original order and duplicate input references without repeated cell memberships',()=>{
  const large=box(-25,25,-25,25),first=box(9,11,9,11),last=box(-12,-8,-12,-8);
  const colliders=[first,large,last,first],index=new ParticleCollisionIndex();index.setColliders(colliders);
  const output=index.query(point(-15,-15),point(15,15),.4);
  assert.deepEqual(output,colliders);assert.equal(output[0],first);assert.equal(output[3],first);
  const next=index.query(point(9.5,9.5),point(9.6,9.6),0);
  assert.equal(next,output,'query reuses its documented scratch result');assert.deepEqual(next,[first,large,first]);
});
test('collision index uses actual sphere extents and keeps large colliders outside the grid',()=>{
  const sphere=box(100,101,100,101,{sphere:{x:-10,y:2,z:-10,radius:3}});
  const wall=box(-1000,1000,-1000,1000),index=new ParticleCollisionIndex();index.setColliders([sphere,wall]);
  assert.equal(index.always.length,1);assert.equal(index.cells.length,4,'large wall does not allocate its 40,401 grid cells');
  assert.deepEqual(index.query(point(-15,-10),point(-5,-10),.1),[sphere,wall]);
  assert.deepEqual(index.query(point(100,100),point(101,101),.1),[wall]);
  const onlySphere=new ParticleCollisionIndex();onlySphere.setColliders([sphere]);
  const hit=check(particle({x:-5,z:-10}),.1,point(-15,-10),[sphere],onlySphere);
  assert.ok(hit.x<-13,'sphere collision must use the actual center, outside its informational box');
});
test('collision index observes disabled getters changing without a rebuild and refreshes moved bounds',()=>{
  let enabled=false;const dynamic=box(0,2,0,2),index=new ParticleCollisionIndex();
  Object.defineProperty(dynamic,'enabled',{get:()=>enabled});index.setColliders([dynamic]);
  assert.deepEqual(index.query(point(1,1),point(1,1),0),[]);enabled=true;
  assert.deepEqual(index.query(point(1,1),point(1,1),0),[dynamic]);enabled=false;
  assert.deepEqual(index.query(point(1,1),point(1,1),0),[]);enabled=true;
  dynamic.minX=100;dynamic.maxX=102;dynamic.minZ=-102;dynamic.maxZ=-100;index.setColliders([dynamic]);
  assert.deepEqual(index.query(point(1,1),point(1,1),0),[]);
  assert.deepEqual(index.query(point(101,-101),point(101,-101),0),[dynamic]);
  index.setColliders([]);assert.deepEqual(index.query(point(-1000,-1000),point(1000,1000),1),[]);
});
test('indexed collision matches brute force across cell borders, high speeds, radius and vertical exclusions',()=>{
  const colliders=[box(-10,10,-10,10)],index=new ParticleCollisionIndex();index.setColliders(colliders);
  for(const [from,to] of [[point(-200,-10),point(200,-10)],[point(200,10),point(-200,10)],
    [point(10,-200),point(10,200)],[point(-10,200),point(-10,-200)],
    [point(10.3,-20),point(10.3,20)],[point(-20,0,20),point(20,0,20)]]){
    check(particle({...to,vx:(to.x-from.x)*60,vy:(to.y-from.y)*60,vz:(to.z-from.z)*60}),1/60,from,colliders,index);
  }
});
test('indexed collision preserves equal-time input priority, interiors and sphere normals',()=>{
  const a=box(2,4,-5,5),b=box(-5,5,2,4),sphere=box(90,100,90,100,{sphere:{x:0,y:2,z:0,radius:2}});
  for(const colliders of [[a,b],[b,a],[sphere,a,a],[box(-3,3,-3,3),box(-2,4,-4,4)]]){
    const index=new ParticleCollisionIndex();index.setColliders(colliders);
    for(const interiors of [true,false]){
      check(particle({x:5,z:5,vx:100,vz:100},collision({interiorCollisions:interiors})),.05,point(0,0),colliders,index);
      check(particle({x:5,z:0,vx:100},collision({interiorCollisions:interiors})),.1,point(-5,0),colliders,index);
    }
  }
});
test('indexed collision preserves invalid deltas, energy loss, kill speeds and no-collision noise paths',()=>{
  const colliders=[box(-1,1,-1,1)],index=new ParticleCollisionIndex();index.setColliders(colliders);
  for(const dt of [0,-1,NaN,Infinity])check(particle({x:2}),dt,point(-2,0),colliders,index);
  for(const limits of [{minKillSpeed:100},{maxKillSpeed:1},{m_EnergyLossOnCollision:raw(1)}]){
    assert.equal(check(particle({x:2},collision(limits)),.1,point(-2,0),colliders,index).active,false);
  }
  const plain=particle({x:2,spec:{scale:1}});check(plain,.1,point(-2,0),colliders,index);
  index.setColliders([]);check(particle({x:2}),.1,point(-2,0),[],index);
});
test('collision index reuses storage across repeated map rebuilds and avoids unbounded sparse sweeps',()=>{
  const colliders=Array.from({length:500},(_,i)=>box(i%25*5-60,i%25*5-58,Math.floor(i/25)*5-40,Math.floor(i/25)*5-38));
  const index=new ParticleCollisionIndex();index.setColliders(colliders);
  const rows=[...index.rows],cells=[...index.cells],result=index.query(point(0,0),point(1,1),.3);
  for(let frame=0;frame<40;frame++){
    const shift=frame%2?100:-100;for(const b of colliders){b.minX+=shift;b.maxX+=shift;b.minZ+=shift;b.maxZ+=shift;}
    index.setColliders(colliders);assert.equal(index.query(point(0,0),point(1,1),.3),result);
    assert.equal(index.rows.length,rows.length);assert.equal(index.cells.length,cells.length);
    index.rows.forEach((row,i)=>assert.equal(row,rows[i]));index.cells.forEach((cell,i)=>assert.equal(cell,cells[i]));
  }
  const sparse=[box(-1e12,-1e12+1,-1e12,-1e12+1),box(1e12,1e12+1,1e12,1e12+1)];index.setColliders(sparse);
  assert.deepEqual(index.query(point(-2e12,-2e12),point(2e12,2e12),1),sparse);
  const huge=[box(1e20,1e20,-1e20,-1e20)];index.setColliders(huge);
  assert.deepEqual(index.query(point(1e20,-1e20),point(1e20,-1e20),0),huge);
});
test('1000 seeded particles match brute-force collision exactly for 60 frames in a changing 500-collider map',()=>{
  let seed=1987654321;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  let colliders=Array.from({length:500},(_,i)=>{
    const x=(i%25)*6-72,z=Math.floor(i/25)*6-35;
    return box(x,x+3,z,z+3,i%7===0?{sphere:{x:x+1.5,y:2,z:z+1.5,radius:2}}:{});
  });
  const module=collision({m_EnergyLossOnCollision:raw(0)}),index=new ParticleCollisionIndex();index.setColliders(colliders);
  const actual=Array.from({length:1000},()=>particle({x:random()*150-75,y:random()*10,z:random()*125-40,
    vx:random()*160-80,vy:random()*20-10,vz:random()*160-80,random:random(),size:.1+random()*3,life:20},module));
  const expected=structuredClone(actual);
  for(let frame=0;frame<60;frame++){
    if(frame===10||frame===40)for(let i=0;i<colliders.length;i+=9)colliders[i].enabled=frame===40;
    if(frame===20){for(const b of colliders){b.minX+=2;b.maxX+=2;if(b.sphere)b.sphere.x+=2;}index.setColliders(colliders);}
    if(frame===30){colliders=[...colliders.slice(100),colliders[105],colliders[104]];index.setColliders(colliders);}
    const dt=[1/30,1/60,1/120][frame%3];
    for(let i=0;i<actual.length;i++){
      const p=actual[i],q=expected[i],from={x:p.x,y:p.y,z:p.z};
      for(const value of [p,q]){value.x+=value.vx*dt;value.y+=value.vy*dt;value.z+=value.vz*dt;value.age+=dt;}
      advanceParticleExtra(p,dt,from,colliders,index);advanceParticleExtra(q,dt,from,colliders);
    }
    assert.deepEqual(actual,expected,`frame ${frame}`);assert.equal(actual.filter(p=>p.active).length,1000);
  }
});
test('indexed authored noise and smoke-collision modules use post-noise endpoints without changing trajectories',()=>{
  const visuals=require('../assets/resources/art/weapon-system/visuals.json');
  const specs=Object.values(visuals.projectileSkins).flat(),noise=specs.find(spec=>spec.noise),smoke=specs.find(spec=>spec.collision);
  assert.ok(noise);assert.ok(smoke);
  // Shipped noise and collision modules live on separate source systems. This
  // composition fixture also checks that optional combined modules query the
  // endpoint after noise rather than the caller's pre-noise velocity endpoint.
  const source={...noise,collision:smoke.collision};
  const colliders=[box(-2,2,-2,2),box(-9,-5,-9,-5)],index=new ParticleCollisionIndex();index.setColliders(colliders);
  const actual=Array.from({length:8},(_,i)=>particle({x:i-4,z:2-i*.5,vx:5-i,vz:i-4,age:.1,life:10,random:i/9,spec:source}));
  const expected=structuredClone(actual);
  for(let frame=0;frame<12;frame++)for(let i=0;i<actual.length;i++){
    const p=actual[i],q=expected[i],from={x:p.x,y:p.y,z:p.z},dt=[1/30,1/60,1/120][frame%3];
    for(const value of [p,q]){value.x+=value.vx*dt;value.y+=value.vy*dt;value.z+=value.vz*dt;}
    advanceParticleExtra(p,dt,from,colliders,index);advanceParticleExtra(q,dt,from,colliders);
    assert.deepEqual(p,q);p.age+=dt;q.age+=dt;
  }
});
