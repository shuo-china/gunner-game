const { projectPath } = require('./support/paths.cjs');
const test=require('node:test');
const assert=require('node:assert/strict');
const {OriginalConfettiSimulation,confettiCurve}=require('./.build/feedback/view/OriginalWeaponConfettiMath.js');
const {originalConfettiNoise}=require('./.build/feedback/view/OriginalWeaponConfettiNoise.js');
const source=require(projectPath('assets/resources/art/weapon-system/config.json')).starConfetti;
const close=(actual,expected,tolerance=1e-7)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
const constant=n=>({m_Mode:0,m_ConstantMax:n});
const vector=(x,y=x,z=x)=>({separated:true,xCurve:constant(x),yCurve:constant(y),zCurve:constant(z)});
const color=(r,g,b,a=1)=>({m_Mode:0,m_ColorMax:{r,g,b,a}});
const curve=(from,to,slope=to-from)=>({m_Mode:1,m_CurveMultiplier:1,m_CurveMax:{m_Curve:[
  {time:0,value:from,inSlope:slope,outSlope:slope},{time:1,value:to,inSlope:slope,outSlope:slope}]}});
function fixture(overrides={}){
  return {node:'fixture',source:{...structuredClone(source[1].source),_startDelay:0,_duration:.1,_rate:0,
    _bursts:[{time:0,count:1}],_shape:4,_angle:0,_lifetime:constant(2),_startSpeed:constant(2),
    _startSize:vector(20,60,20),_startRotation:vector(0),_sizeOverLifetime:vector(1),_sizeBySpeed:vector(1),
    _rotationOverLifetime:vector(0),_rotationBySpeed:vector(0),_startColor:color(1,1,1),
    _colorOverLifetime:color(1,1,1),_colorBySpeed:color(1,1,1),_speedOverLifetime:constant(1),
    _gravityModule:{enabled:0},_noiseModule:{enabled:0},_trailModule:{enabled:0},...overrides}};
}
const seeded=()=>{let seed=73;return()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);};

test('upgrade success retains original three ParticleImage emitters, delayed rain and two bursts',()=>{
  assert.deepEqual(source.map(r=>r.node),['level0:237','level0:1858','level0:2214']);
  const [rain,left,right]=source.map(r=>r.source);
  assert.equal(rain._startDelay,1);assert.equal(rain._duration,1);assert.equal(rain._rate,300);
  assert.equal(rain._shape,3);assert.equal(rain._fitRect,1);assert.equal(rain._length,1080);
  assert.deepEqual(rain._bursts,[]);assert.equal(rain._trailModule.enabled,0);
  for(const burst of [left,right]){
    assert.equal(burst._startDelay,0);assert.equal(burst._rate,0);assert.equal(burst._shape,4);
    assert.equal(burst._angle,45);assert.deepEqual(burst._bursts,[{time:0,count:100,used:0}]);
    assert.equal(burst._trailModule.enabled,1);close(burst._trailRatio,.1,1e-8);
    close(burst._trailLifetime,.3,1e-7);assert.equal(burst._minimumVertexDistance,20);
  }
  for(const s of [rain,left,right]){
    assert.equal(s._startSize.xCurve.m_ConstantMax,20);assert.equal(s._startSize.yCurve.m_ConstantMax,60);
    assert.equal(s._noiseModule.enabled,1);assert.equal(s._multithreadModule.enabled,0);
    assert.equal(s.m_Sprite.m_PathID,0);assert.equal(s.m_Texture.m_PathID,0,'source uses untextured rectangles');
  }
});

test('noise matches independently executed upstream C# OpenSimplex2 reference values',()=>{
  // FastNoiseLite.cs v1.1.1, compiled with PowerShell Add-Type. Original OnEnable
  // uses seed 1337/type 0 and frequency=authored .3 / 100. Float32 reference vs
  // JS doubles has sub-micro absolute error; these fixtures are not TS outputs.
  for(const [x,y,expected] of [[0,0,0],[120,260,.5449484],[-100,80,.087277465],
    [540,-300,-.83719605],[12.5,-19.75,-.14501648],[-333.25,-444.5,-.41957903]]){
    close(originalConfettiNoise(x,y,.003),expected,1e-6);
  }
});

test('Unity curves preserve zero constants, reversed random ranges and Hermite tangents',()=>{
  assert.equal(confettiCurve(constant(0),.5),0);
  assert.equal(confettiCurve({m_Mode:3,m_ConstantMin:720,m_ConstantMax:360},.5,.25),630);
  close(confettiCurve(curve(1,0,0),.25),.84375);
  const between={...curve(1,0,0),m_Mode:2,m_CurveMultiplier:2,m_CurveMin:curve(.5,0,0).m_CurveMax};
  close(confettiCurve(between,.5,.25),.625);
  close(confettiCurve(curve(1,0,0),-1),1);close(confettiCurve(curve(1,0,0),2),0);
});

test('emission crosses frame boundaries once, stops at duration and replay resets the lifecycle',()=>{
  const sim=new OriginalConfettiSimulation([fixture({_startDelay:.2,_duration:.3,_rate:10,
    _bursts:[{time:0,count:2},{time:.15,count:3}]})],()=>.5);
  sim.play();assert.equal(sim.count,0);
  sim.update(.19);assert.equal(sim.count,0);
  sim.update(.17);assert.equal(sim.count,6,'both bursts plus first rate particle');
  sim.update(.14);assert.equal(sim.count,8,'two later rate particles and no duplicate bursts');
  sim.update(.1);assert.equal(sim.count,8,'emitter ended');
  sim.update(3);assert.equal(sim.count,0);assert.equal(sim.playing,false);
  sim.play();sim.update(.36);assert.equal(sim.count,6);
  sim.clear();assert.equal(sim.count,0);assert.equal(sim.playing,false);
  sim.update(1);assert.equal(sim.count,0,'closed UI cannot create delayed rain');
});

test('original success timing produces exactly 200 burst and 300 delayed rain particles',()=>{
  const sim=new OriginalConfettiSimulation(source,()=>.5);
  sim.play();assert.deepEqual(sim.emitters.map(e=>e.particles.length),[0,100,100]);
  sim.update(.5);assert.equal(sim.emitters[0].particles.length,0);
  sim.update(1);assert.equal(sim.emitters[0].emitted,150);
  sim.update(.5);assert.equal(sim.emitters[0].emitted,300);
  sim.update(5);assert.equal(sim.count,0);assert.equal(sim.playing,false);
});

test('source movement uses 100 UI units per speed unit and rotates gravity into emitter space',()=>{
  const sim=new OriginalConfettiSimulation([fixture({_gravityModule:{enabled:1},_gravity:constant(-10)})],()=>.5);
  sim.emitters[0].worldAngle=90;sim.play();sim.update(1/60);
  const p=sim.emitters[0].particles[0];
  close(p.vx,-10/60);close(p.vy,2);close(p.x,-10/3600*100);close(p.y,2/60*100);
  sim.update(1/60);close(p.gx,-20/60);close(p.gy,0);close(p.x,-30/3600*100);
});

test('speed over life scales launch velocity each frame without compounding deceleration',()=>{
  const sim=new OriginalConfettiSimulation([fixture({_lifetime:constant(1),_speedOverLifetime:curve(1,0)})],()=>.5);
  sim.play();sim.update(.5);const p=sim.emitters[0].particles[0];
  close(p.vy,1);close(p.y,2*100/60*(30-30*31/120));
  assert.deepEqual(p.initial,[0,2],'launch velocity stays unchanged for the next frame');
});

test('fit-rect line emission follows resized width while cone emission retains source angle',()=>{
  const line=new OriginalConfettiSimulation([fixture({_shape:3,_length:1080,_fitRect:true})],()=>1);
  line.emitters[0].width=720;line.play();close(line.emitters[0].particles[0].x,360);
  const cone=new OriginalConfettiSimulation([fixture({_shape:4,_angle:60})],()=>1);
  cone.play();const p=cone.emitters[0].particles[0];close(p.x,0);close(p.vx,1);close(p.vy,Math.sqrt(3));
});

test('projected paper corners use XYZ rotation, normalized lifetime and original color multipliers',()=>{
  const sim=new OriginalConfettiSimulation([fixture({_rotationOverLifetime:vector(180,0,0),
    _startColor:color(.5,.8,1,.5),_colorOverLifetime:color(.4,.5,1,.5),m_Color:{r:.5,g:1,b:1,a:.5}})],()=>.5);
  sim.play();sim.update(1);const e=sim.emitters[0],p=e.particles[0],pose=sim.pose(e,p);
  assert.deepEqual(pose.rotation,[90,0,0]);
  for(const corner of pose.corners)close(corner[1],p.y); // 90-degree X rotation turns paper edge-on.
  pose.color.forEach((v,i)=>close(v,[.1,.4,1,.125][i]));
  e.worldAngle=30;close(sim.pose(e,p).rotation[2],-30); // Un-aligned paper cancels emitter rotation.
});

test('trails remain briefly after particle death and clear on expiry or close',()=>{
  const record=fixture({_lifetime:constant(.1),_trailModule:{enabled:1},_trailRatio:1,
    _trailLifetime:.3,_minimumVertexDistance:1,_dieWithParticle:false});
  const sim=new OriginalConfettiSimulation([record],()=>.5);sim.play();sim.update(.15);
  const e=sim.emitters[0],p=e.particles[0];assert.ok(p.age>=p.life);assert.ok(sim.trail(e,p).length>0);
  sim.update(.3);assert.equal(sim.count,0);assert.equal(sim.playing,false);
  sim.play();sim.update(.05);assert.ok(sim.count>0);sim.clear();assert.equal(sim.count,0);
  const die=new OriginalConfettiSimulation([fixture({...record.source,_dieWithParticle:true})],()=>.5);
  die.play();die.update(.15);assert.equal(die.count,0,'source die-with-particle switch is respected');
});

test('all source emitters keep finite paper/trail poses and release every particle after repeated plays',()=>{
  const sim=new OriginalConfettiSimulation(source,seeded());
  for(let replay=0;replay<3;replay++){
    sim.play();let peak=0;
    for(let frame=0;frame<420;frame++){
      sim.update(1/60);peak=Math.max(peak,sim.count);
      for(const e of sim.emitters)for(const p of e.particles){
        const pose=sim.pose(e,p);assert.ok([...pose.corners.flat(),...pose.color,...pose.rotation].every(Number.isFinite));
        for(const trail of sim.trail(e,p))assert.ok([...trail.corners.flat(),...trail.color].every(Number.isFinite));
      }
    }
    assert.ok(peak>=300&&peak<=500);assert.equal(sim.count,0);assert.equal(sim.playing,false);
  }
  sim.play();const count=sim.count;sim.update(NaN);sim.update(Infinity);sim.update(-1);sim.update(0);
  assert.equal(sim.count,count);sim.clear();
});
