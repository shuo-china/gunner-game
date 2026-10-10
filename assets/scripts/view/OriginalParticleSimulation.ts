import { BulletState, WEAPON_CONFIG } from '../core';
import { CAMERA_BASIS } from '../core/projection';
import { sampleParticleStops } from './OriginalFeedbackMath';
import { particleVelocityKeep } from './OriginalParticleMotion';
export { sampleParticleStops } from './OriginalFeedbackMath';

interface CurveKey {time:number;value:number;inSlope:number;outSlope:number}
export interface ParticleCurve {mode:number;value:number;min:number;keys:CurveKey[];minKeys:CurveKey[]}
interface Gradient {colors:number[][];alpha:number[][]}
export interface ParticleSpec {
  id:string;kind:'bullet'|'hit';name:string;scale:number;sortingOrder:number;sortingLayer:number;
  image:{path:string;sizePx:[number,number];sizeUnits:[number,number];anchor:[number,number]};
  blend:{source:number;destination:number};materialColor:number[];startColor:number[];
  lifetime:ParticleCurve;size:ParticleCurve;speed:ParticleCurve;rotation:ParticleCurve;gravity:ParticleCurve;
  emissionRate:number;bursts:{time:number;count:number}[];sphereRadius:number;sphereThickness:number;
  sizeCurve:ParticleCurve|null;gradient:Gradient|null;rotationCurve:ParticleCurve|null;
  inheritVelocity:ParticleCurve|null;limitVelocity:{magnitude:ParticleCurve;dampen:number}|null;
  renderMode:number;lengthScale:number;velocityScale:number;simulationSpace:number;maxParticles:number;
}
export interface OriginalParticle {
  index:number;spec:ParticleSpec;active:boolean;age:number;life:number;size:number;
  x:number;y:number;z:number;vx:number;vy:number;vz:number;rotation:number;random:number;
  emitterId?:number;
}
export interface ParticlePose {x:number;y:number;width:number;height:number;angle:number;color:number[]}
interface ParticleGroup {spec:ParticleSpec;particles:OriginalParticle[]}
interface BulletEmission {previousTravel:number;counts:number[]}

/** Engine-independent projection and lifetime simulation of the six source systems.
 * Only the modules actually enabled in the initial pistol prefabs are supported.
 * This is visual simulation: its random stream never changes combat outcomes.
 * Unity InitialModuleUI binds moveWithTransform to Local/World/Custom in that
 * order. Bullets use World (1); hit emitters use Local (0) at an unmoving origin,
 * whose sphere emission is equivalent to the cached world coordinates here.
 */
export class OriginalParticleSimulation {
  readonly particles:OriginalParticle[]=[];
  private readonly emissions=new Map<number,BulletEmission>();
  private readonly bulletGroups:ParticleGroup[];
  private readonly hitGroups:ParticleGroup[];
  private readonly alpha=[1];
  constructor(specs:readonly ParticleSpec[],private readonly random:()=>number=Math.random) {
    const groups=new Map<ParticleSpec,ParticleGroup>();
    for(const spec of specs.slice().sort((a,b)=>a.sortingOrder-b.sortingOrder)) {
      const group:ParticleGroup={spec,particles:[]};groups.set(spec,group);
      // Reserve several simultaneous effects; source maxParticles is an upper limit.
      const maxLife=spec.lifetime.mode===3?Math.max(spec.lifetime.value,spec.lifetime.min):spec.lifetime.value;
      const capacity=spec.kind==='bullet'?Math.ceil(spec.emissionRate*WEAPON_CONFIG.bulletSpeed*maxLife*4)+16:
        Math.max(8,spec.bursts.reduce((n,b)=>n+b.count,0)*8);
      for(let i=0;i<Math.min(spec.maxParticles,capacity);i++) {
        const particle:OriginalParticle={index:this.particles.length,spec,active:false,age:0,life:0,size:0,
          x:0,y:0,z:0,vx:0,vy:0,vz:0,rotation:0,random:0};
        this.particles.push(particle);group.particles.push(particle);
      }
    }
    // Pool slots keep render order; emission keeps the original catalog order
    // so grouping does not change random draws or first-inactive-slot reuse.
    this.bulletGroups=specs.filter(s=>s.kind==='bullet').map(s=>groups.get(s)!);
    this.hitGroups=specs.filter(s=>s.kind==='hit').map(s=>groups.get(s)!);
  }
  shot(bulletId:number):void {
    // Bullet.SetupLinear calls Stop(WithChildren, StopEmittingAndClear) and
    // Clear(WithChildren) before reusing its own ParticleSystem hierarchy.
    for(const p of this.particles)if(p.spec.kind==='bullet'&&p.emitterId===bulletId)p.active=false;
    const emission=this.emissionFor(bulletId);
    emission.previousTravel=0;emission.counts.fill(0);
  }
  hit(position:{x:number;z:number}):void {
    for(const group of this.hitGroups)for(const burst of group.spec.bursts) {
      // Both selected hit systems have one burst at time zero.
      if(burst.time!==0)throw new Error(`Unsupported delayed original burst: ${group.spec.id}`);
      for(let i=0;i<burst.count;i++)this.spawn(group,position.x,position.z,0,0,0);
    }
  }
  update(dt:number,bullets:readonly BulletState[]):void {
    if(!(dt>0)||!Number.isFinite(dt))return;
    for(const p of this.particles)if(p.active)this.advance(p,dt);
    for(const b of bullets) {
      if(!b.active)continue;
      const emission=this.emissionFor(b.id);
      if(b.traveled<emission.previousTravel)this.shot(b.id);
      emission.previousTravel=b.traveled;
      for(let si=0;si<this.bulletGroups.length;si++) {
        const group=this.bulletGroups[si],spec=group.spec;
        if(spec.emissionRate<=0)continue;
        const count=emission.counts[si];
        const wanted=Math.floor(b.traveled*spec.emissionRate+1e-9);
        for(let i=count+1;i<=wanted;i++) {
          const behind=b.traveled-i/spec.emissionRate;
          // A rendered frame can contain several physics steps. The selected
          // pistol travels in a straight line, so recover the entire distance
          // interval instead of clamping older emissions to the last step.
          this.spawn(group,b.position.x-b.direction.x*behind,b.position.z-b.direction.z*behind,
            b.direction.x*WEAPON_CONFIG.bulletSpeed,b.direction.z*WEAPON_CONFIG.bulletSpeed,
            behind/WEAPON_CONFIG.bulletSpeed,b.id);
        }
        emission.counts[si]=wanted;
      }
    }
  }
  reset():void {
    this.emissions.clear();
    for(const p of this.particles){p.active=false;p.age=p.life=0;p.vx=p.vy=p.vz=0;}
  }
  /** Pass an output buffer in the render loop; omitted output remains an independent snapshot. */
  pose(p:OriginalParticle,out:ParticlePose={x:0,y:0,width:0,height:0,angle:0,color:[]}):ParticlePose {
    const t=Math.max(0,Math.min(1,p.age/p.life)),s=p.spec;
    const size=p.size*(s.sizeCurve?evaluateParticleCurve(s.sizeCurve,t,p.random):1);
    const camera=CAMERA_BASIS;
    out.x=camera.rightX*p.x+camera.rightZ*p.z;
    out.y=camera.upX*p.x+camera.upZ*p.z+camera.upY*p.y;
    let angle=-p.rotation*180/Math.PI,height=size;
    if(s.renderMode===1) {
      const vx=camera.rightX*p.vx+camera.rightZ*p.vz;
      const vy=camera.upX*p.vx+camera.upZ*p.vz+camera.upY*p.vy;
      height=size*s.lengthScale+Math.hypot(vx,vy)*s.velocityScale;
      angle=Math.atan2(vy,vx)*180/Math.PI-90;
    }
    const color=out.color;
    if(s.gradient)sampleParticleStops(s.gradient.colors,t,color);
    else {color[0]=color[1]=color[2]=1;}
    const alpha=s.gradient?sampleParticleStops(s.gradient.alpha,t,this.alpha)[0]:1;
    for(let i=0;i<3;i++)color[i]=color[i]*s.startColor[i]*s.materialColor[i];
    color[3]=alpha*s.startColor[3]*s.materialColor[3];
    out.width=Math.max(.0001,size);out.height=Math.max(.0001,height);out.angle=angle;
    return out;
  }
  private emissionFor(bulletId:number):BulletEmission {
    let emission=this.emissions.get(bulletId);
    if(!emission) {
      emission={previousTravel:0,counts:this.bulletGroups.map(()=>0)};
      this.emissions.set(bulletId,emission);
    }
    return emission;
  }
  private spawn(group:ParticleGroup,x:number,z:number,emitterVX:number,emitterVZ:number,age:number,emitterId?:number):void {
    let p:OriginalParticle|undefined;
    for(const candidate of group.particles)if(!candidate.active){p=candidate;break;}
    if(!p)return;
    const spec=group.spec;
    p.emitterId=emitterId;
    p.random=this.random();p.life=evaluateParticleCurve(spec.lifetime,0,this.random());
    p.age=0;p.active=true;p.size=evaluateParticleCurve(spec.size,0,this.random())*spec.scale;
    p.rotation=evaluateParticleCurve(spec.rotation,0,this.random());
    // A sphere shell is rotation-invariant, including the hit parent's X=-90.
    const az=this.random()*Math.PI*2,up=this.random()*2-1,r=Math.sqrt(Math.max(0,1-up*up));
    const nx=r*Math.cos(az),ny=up,nz=r*Math.sin(az);
    const radius=spec.sphereRadius*spec.scale*(spec.sphereThickness>0?
      Math.cbrt((1-spec.sphereThickness)**3+this.random()*(1-(1-spec.sphereThickness)**3)):1);
    p.x=x+nx*radius;p.y=WEAPON_CONFIG.bulletHeight+ny*radius;p.z=z+nz*radius;
    const speed=evaluateParticleCurve(spec.speed,0,this.random())*spec.scale;
    const inherit=spec.inheritVelocity?evaluateParticleCurve(spec.inheritVelocity,0,p.random):0;
    p.vx=nx*speed+emitterVX*inherit;p.vy=ny*speed;p.vz=nz*speed+emitterVZ*inherit;
    if(age>0)this.advance(p,age);
  }
  private advance(p:OriginalParticle,dt:number):void {
    const used=Math.min(dt,p.life-p.age),s=p.spec,t=Math.min(1,(p.age+used*.5)/p.life);
    if(s.rotationCurve)p.rotation+=evaluateParticleCurve(s.rotationCurve,t,p.random)*used;
    p.vy-=9.81*evaluateParticleCurve(s.gravity,t,p.random)*used;
    if(s.limitVelocity) {
      const speed=Math.hypot(p.vx,p.vy,p.vz);
      const limit=evaluateParticleCurve(s.limitVelocity.magnitude,t,p.random)*s.scale;
      if(speed>limit) {
        const keep=particleVelocityKeep(speed,limit,s.limitVelocity.dampen,used);
        p.vx*=keep;p.vy*=keep;p.vz*=keep;
      }
    }
    p.x+=p.vx*used;p.y+=p.vy*used;p.z+=p.vz*used;
    p.age+=dt;if(p.age>=p.life)p.active=false;
  }
}
export function evaluateParticleCurve(c:ParticleCurve,t:number,random=.5):number {
  if(c.mode===0)return c.value;
  if(c.mode===3)return c.min+(c.value-c.min)*random;
  if(c.mode===1)return hermiteParticleCurve(c.keys,t)*c.value;
  if(c.mode===2)return (hermiteParticleCurve(c.minKeys,t)*(1-random)+hermiteParticleCurve(c.keys,t)*random)*c.value;
  throw new Error(`Unsupported original particle curve mode ${c.mode}`);
}
function hermiteParticleCurve(keys:CurveKey[],t:number):number {
  if(!keys.length)return 1;
  if(t<=keys[0].time)return keys[0].value;
  if(t>=keys[keys.length-1].time)return keys[keys.length-1].value;
  let i=0;
  while(i<keys.length-2&&keys[i+1].time<t)i++;
  const a=keys[i],b=keys[i+1],dt=b.time-a.time,u=(t-a.time)/dt;
  return (2*u*u*u-3*u*u+1)*a.value+(u*u*u-2*u*u+u)*dt*a.outSlope+
    (-2*u*u*u+3*u*u)*b.value+(u*u*u-u*u)*dt*b.inSlope;
}
