import { MAP_CONFIG } from '../core/config';
import { projectWorld } from '../core/projection';
import { TreeState, Vec2 } from '../core/types';
import { evaluateParticleCurve, ParticleCurve } from './OriginalParticleSimulation';
import { particleVelocityKeep } from './OriginalParticleMotion';

export interface MoneyBurstConfig {
  count: number; spawnHeight: number; maxParticles: number;
  atlas: {path:string;sizePx:[number,number];sizeUnits:[number,number];anchor:[number,number]};
  tiles: [number, number];
  lifetime: ParticleCurve; speed: ParticleCurve; size: ParticleCurve; rotation: ParticleCurve;
  gravity: ParticleCurve; sizeCurve: ParticleCurve; rotationCurve: ParticleCurve;
  cone: {radius:number;angleDegrees:number};
  limitVelocity: {magnitude:number;dampen:number};
  collision: {dampen:number;bounce:ParticleCurve;radiusScale:number;treeMinY:number;treeMaxY:number;wallMinY:number;wallMaxY:number};
}

export interface MoneyParticle {
  active:boolean; age:number; life:number; startedAt:number; size:number; rotation:number; random:number; frame:number;
  x:number;y:number;z:number;vx:number;vy:number;vz:number;bounce:number;
}
export interface MoneyParticlePose {x:number;y:number;size:number;angle:number}
interface Box {minX:number;maxX:number;minY:number;maxY:number;minZ:number;maxZ:number}
interface Contact {time:number;nx:number;ny:number;nz:number;penetration:number}
const STEP=1/120;
const EPSILON=1e-5;
const DEFAULT_SEED=0x4d4f4e59;

/** Source-configured visual simulation, independent of the combat random stream.
 * Unity's internal cone sampler, collision response and integration are not
 * available. We approximate them with a uniform cone-base disk, 120 Hz steps,
 * swept sphere/box contacts and the existing 60 Hz reference velocity damping.
 * Lifetimes, curves, counts, atlas, gravity and collision settings are extracted.
 */
export class MoneyBurstSimulation {
  readonly particles:MoneyParticle[]=[];
  private randomState=DEFAULT_SEED;
  private clock=0;
  private readonly boxes:Box[]=[];
  constructor(readonly config:MoneyBurstConfig,seed=DEFAULT_SEED) {this.reset(seed);}

  spawn(position:Vec2,sourceTime=this.clock):void {
    const c=this.config;
    for(let i=0;i<c.count;i++) {
      let p=this.particles.find(candidate=>!candidate.active);
      if(!p) {
        if(this.particles.length>=c.maxParticles)break;
        p={active:false,age:0,life:0,startedAt:0,size:0,rotation:0,random:0,frame:0,x:0,y:0,z:0,vx:0,vy:0,vz:0,bounce:0};
        this.particles.push(p);
      }
      p.active=true;p.age=0;p.startedAt=Number.isFinite(sourceTime)?sourceTime:this.clock;p.random=this.random();
      p.life=evaluateParticleCurve(c.lifetime,0,this.random());
      p.size=evaluateParticleCurve(c.size,0,this.random());
      p.rotation=evaluateParticleCurve(c.rotation,0,this.random());
      p.frame=Math.min(c.tiles[0]*c.tiles[1]-1,Math.floor(this.random()*c.tiles[0]*c.tiles[1]));
      p.bounce=evaluateParticleCurve(c.collision.bounce,0,this.random());
      const azimuth=this.random()*Math.PI*2,radial=Math.sqrt(this.random());
      const nx=Math.cos(azimuth),nz=Math.sin(azimuth),slope=radial*Math.tan(c.cone.angleDegrees*Math.PI/180);
      const speed=evaluateParticleCurve(c.speed,0,this.random()),vertical=1/Math.hypot(1,slope);
      p.x=position.x+nx*radial*c.cone.radius;p.y=c.spawnHeight;p.z=position.z+nz*radial*c.cone.radius;
      p.vx=nx*slope*vertical*speed;p.vy=vertical*speed;p.vz=nz*slope*vertical*speed;
    }
  }

  update(dt:number,trees:readonly TreeState[],frameTime?:number):void {
    if(!(dt>0)||!Number.isFinite(dt))return;
    const endTime=typeof frameTime==='number'&&Number.isFinite(frameTime)?Math.max(this.clock,frameTime):
      Math.min(Number.MAX_VALUE,this.clock+dt);
    this.boxes.length=0;
    const c=this.config.collision;
    for(const wall of MAP_CONFIG.bulletWalls)this.boxes.push({...wall,minY:c.wallMinY,maxY:c.wallMaxY});
    for(const tree of trees)if(tree.alive)this.boxes.push({...tree.collider,minY:c.treeMinY,maxY:c.treeMaxY});
    for(const p of this.particles)if(p.active) {
      // Death may occur in a physics tick near the end of this render frame.
      // Existing particles consume dt; a new burst consumes only the time since
      // its source tick, so a slow frame cannot skip the initial explosion.
      const elapsed=Math.max(0,Math.min(dt,endTime-p.startedAt-p.age));
      // Very large deltas expire particles without an unbounded catch-up loop.
      // Pausing is handled by the caller: zero/invalid delta leaves state intact.
      if(elapsed>=p.life-p.age){p.age=p.life;p.active=false;continue;}
      let remaining=elapsed;
      while(remaining>1e-10) {const used=Math.min(STEP,remaining);this.advance(p,used);remaining-=used;}
    }
    this.clock=endTime;
  }

  pose(p:MoneyParticle,out:MoneyParticlePose={x:0,y:0,size:0,angle:0}):MoneyParticlePose {
    const projected=projectWorld(p,p.y);
    out.x=projected.x;out.y=projected.y;
    out.size=Math.max(0,p.size*evaluateParticleCurve(this.config.sizeCurve,p.age/p.life,p.random));
    out.angle=-p.rotation*180/Math.PI;
    return out;
  }

  reset(seed=DEFAULT_SEED):void {
    this.randomState=(seed>>>0)||DEFAULT_SEED;this.clock=0;
    for(const p of this.particles){p.active=false;p.age=p.life=p.startedAt=0;p.vx=p.vy=p.vz=0;}
  }
  diagnostics():{active:number;pooled:number} {
    return {active:this.particles.reduce((count,p)=>count+(p.active?1:0),0),pooled:this.particles.length};
  }

  private random():number {
    let x=this.randomState;x^=x<<13;x^=x>>>17;x^=x<<5;this.randomState=x>>>0;
    return this.randomState/4294967296;
  }
  private advance(p:MoneyParticle,dt:number):void {
    const c=this.config,t=Math.min(1,(p.age+dt*.5)/p.life);
    p.rotation+=evaluateParticleCurve(c.rotationCurve,t,p.random)*dt;
    p.vy-=9.81*evaluateParticleCurve(c.gravity,t,p.random)*dt;
    const keep=particleVelocityKeep(Math.hypot(p.vx,p.vy,p.vz),c.limitVelocity.magnitude,c.limitVelocity.dampen,dt);
    p.vx*=keep;p.vy*=keep;p.vz*=keep;
    const radius=Math.max(0,p.size*evaluateParticleCurve(c.sizeCurve,t,p.random)*.5*c.collision.radiusScale);
    let remaining=dt;
    // Multiple contacts can occur in one step at a tree/wall or floor corner.
    // If a pathological overlap consumes this budget, stop moving for this step.
    for(let bounce=0;bounce<6&&remaining>1e-10;bounce++) {
      let contact:Contact|null=null;
      if(p.y<radius)contact={time:0,nx:0,ny:1,nz:0,penetration:radius-p.y};
      else if(p.vy<0&&p.y+p.vy*remaining<radius)
        contact={time:(radius-p.y)/(p.vy*remaining),nx:0,ny:1,nz:0,penetration:0};
      for(const box of this.boxes) {
        const hit=sweepParticleBox(p,remaining,box,radius);
        if(hit&&(!contact||hit.time<contact.time))contact=hit;
      }
      if(!contact){p.x+=p.vx*remaining;p.y+=p.vy*remaining;p.z+=p.vz*remaining;break;}
      const {time,nx,ny,nz,penetration}=contact;
      p.x+=p.vx*remaining*time+nx*(penetration+EPSILON);
      p.y+=p.vy*remaining*time+ny*(penetration+EPSILON);
      p.z+=p.vz*remaining*time+nz*(penetration+EPSILON);
      const dot=p.vx*nx+p.vy*ny+p.vz*nz;
      if(dot<0) {
        const loss=1-c.collision.dampen;
        p.vx=(p.vx-(1+p.bounce)*dot*nx)*loss;
        p.vy=(p.vy-(1+p.bounce)*dot*ny)*loss;
        p.vz=(p.vz-(1+p.bounce)*dot*nz)*loss;
      }
      remaining*=1-time;
    }
    p.age+=dt;
  }
}

/** Continuous sphere-vs-AABB sweep (the tiny source collision radius expands
 * each box). Starting overlaps resolve to the nearest exterior face, including
 * neighboring trees whose source colliders overlap the emitter position.
 */
function sweepParticleBox(p:MoneyParticle,dt:number,b:Box,r:number):Contact|null {
  const minX=b.minX-r,minY=b.minY-r,minZ=b.minZ-r,maxX=b.maxX+r,maxY=b.maxY+r,maxZ=b.maxZ+r;
  if(p.x>minX&&p.x<maxX&&p.y>minY&&p.y<maxY&&p.z>minZ&&p.z<maxZ) {
    let penetration=Infinity,axis=0,sign=1;
    for(let i=0;i<3;i++) {
      const origin=i===0?p.x:i===1?p.y:p.z,min=i===0?minX:i===1?minY:minZ,max=i===0?maxX:i===1?maxY:maxZ;
      if(origin-min<penetration){penetration=origin-min;axis=i;sign=-1;}
      if(max-origin<penetration){penetration=max-origin;axis=i;sign=1;}
    }
    return {time:0,nx:axis===0?sign:0,ny:axis===1?sign:0,nz:axis===2?sign:0,penetration};
  }
  let enter=0,exit=1,axis=-1,sign=0;
  for(let i=0;i<3;i++) {
    const origin=i===0?p.x:i===1?p.y:p.z,travel=(i===0?p.vx:i===1?p.vy:p.vz)*dt;
    const min=i===0?minX:i===1?minY:minZ,max=i===0?maxX:i===1?maxY:maxZ;
    if(Math.abs(travel)<1e-12){if(origin<min||origin>max)return null;continue;}
    const a=(min-origin)/travel,z=(max-origin)/travel;
    const near=Math.min(a,z),far=Math.max(a,z);
    if(near>=enter){enter=near;axis=i;sign=travel>0?-1:1;}
    exit=Math.min(exit,far);if(enter>exit)return null;
  }
  if(axis<0||enter<0||enter>1||exit<0)return null;
  return {time:enter,nx:axis===0?sign:0,ny:axis===1?sign:0,nz:axis===2?sign:0,penetration:0};
}
