import { evaluateParticleCurve as curve, OriginalParticle, OriginalParticleSimulation, ParticleCurve, ParticlePose, ParticleSpec, ParticleVector, particleEulerQuaternion, particleRotate } from './OriginalParticleSimulation';
import { particleVelocityKeep } from './OriginalParticleMotion';
import { CAMERA_BASIS } from '../core/projection';
import { getWeaponGrade } from '../core/WeaponCatalog';

interface GradeBurst {time:number;count:number;cycles:number;interval:number;probability:number}
interface GradeVelocity {x:ParticleCurve;y:ParticleCurve;z:ParticleCurve;orbitalX:ParticleCurve;orbitalY:ParticleCurve;orbitalZ:ParticleCurve;orbitalOffsetX:ParticleCurve;orbitalOffsetY:ParticleCurve;orbitalOffsetZ:ParticleCurve;radial:ParticleCurve;speedModifier:ParticleCurve;world:boolean}
interface ConstantColor {maxColor:{r:number;g:number;b:number;a:number}}
export interface GradeParticleSpec extends ParticleSpec {
  bursts:GradeBurst[];inheritMode:number;
  shape:(NonNullable<ParticleSpec['shape']>&{randomDirection:number})|null;
  spriteShape?:{source:string;vertices:number[][];indices:number[];placementMode:number};
  velocity?:GradeVelocity;
  subEmitters?:{id:string;event:number;properties:number;probability:number}[];
  trail?:{lifetime:ParticleCurve;minVertexDistance:number;width:ParticleCurve;sizeAffectsWidth:boolean;inheritParticleColor:boolean;worldSpace:boolean;dieWithParticles:boolean;colorOverLifetime:ConstantColor;colorOverTrail:ConstantColor};
}
export interface WeaponGradeEffectConfig {source:string;grades:{grade:number;source:string;systems:GradeParticleSpec[]}[];images:Record<string,ParticleSpec['image']>}
export interface GradeTrailPoint {x:number;y:number;z:number;age:number}
export interface GradeParticle extends OriginalParticle {spec:GradeParticleSpec;generation:number;baseVelocity:ParticleVector;velocityRandom:ParticleVector;center:ParticleVector;trail:GradeTrailPoint[]}
interface Group {spec:GradeParticleSpec;clock:number;distance:number;particles:GradeParticle[];sub:boolean}
interface SubEmission {group:Group;remaining:number;count:number;parent:GradeParticle;generation:number}
const ZERO:ParticleVector=[0,0,0],IDENTITY:[number,number,number,number]=[0,0,0,1],EPS=1e-8;

/** Authored Cat.Gun_Degree_FX_list modules. Grade effects have their own clock,
 * independent of shooting; changing a gun within one grade keeps that clock.
 * Integration is deterministic for tests; it is not Unity's native integrator.
 */
export class WeaponGradeEffectSimulation {
  readonly particles:GradeParticle[]=[];
  private groups:Group[]=[];
  private readonly subEmissions:SubEmission[]=[];
  private readonly poseMath=new OriginalParticleSimulation([]);
  private origin:ParticleVector=[0,0,0];
  private initialized=false;
  private grade=-1;
  private enabled=true;
  constructor(private readonly config:WeaponGradeEffectConfig,private readonly random:()=>number=Math.random) {}
  setWeapon(weaponId:number):boolean {
    const grade=getWeaponGrade(weaponId);if(grade===this.grade)return false;
    this.grade=grade;this.clear();
    const specs=this.config.grades[grade]?.systems??[],children=new Set<string>();
    for(const spec of specs)for(const child of spec.subEmitters??[])children.add(child.id);
    this.groups=specs.map(spec=>({spec,clock:-EPS,distance:0,particles:[],sub:children.has(spec.id)}));
    return true;
  }
  setActive(active:boolean):void {if(this.enabled===active)return;this.enabled=active;this.reset();}
  reset():void {
    this.initialized=false;this.subEmissions.length=0;
    for(const group of this.groups){group.clock=-EPS;group.distance=0;}
    for(const p of this.particles){p.active=false;p.trail.length=0;}
  }
  clear():void {this.reset();this.particles.length=0;this.groups=[];}
  update(dt:number,origin:ParticleVector):void {
    if(!this.enabled)return;
    if(!this.initialized) {
      this.origin=[...origin];this.initialized=true;
      for(const group of this.groups)if(!group.sub) {
        this.emit(group,0,origin,ZERO,0);
        if(group.spec.prewarm&&group.spec.looping) {
          // Unity prewarm simulates one duration, for this emitter only.
          for(let age=0,duration=group.spec.duration??1;age<duration-EPS;) {
            const step=Math.min(1/60,duration-age);age+=step;
            for(const p of group.particles)if(p.active)this.advance(p,step);
            this.emit(group,step,origin,ZERO,0);
          }
        }
      }
    }
    if(!(dt>0)||!Number.isFinite(dt))return;
    const before=this.origin,delta=origin.map((v,i)=>v-before[i]) as ParticleVector;
    const velocity=delta.map(v=>v/dt) as ParticleVector;
    const steps=Math.max(1,Math.ceil(dt*60)),step=dt/steps;
    for(let i=1;i<=steps;i++) {
      const at=before.map((v,a)=>v+delta[a]*i/steps) as ParticleVector;
      const movement=delta.map(v=>v/steps) as ParticleVector;
      for(const p of this.particles)if(p.active) {
        if(p.spec.simulationSpace===0) {
          p.x+=movement[0];p.y+=movement[1];p.z+=movement[2];
          for(let a=0;a<3;a++)p.center[a]+=movement[a];
          if(p.spec.trail&&!p.spec.trail.worldSpace)for(const point of p.trail){point.x+=movement[0];point.y+=movement[1];point.z+=movement[2];}
        }
        this.advance(p,step);
      }
      for(let si=this.subEmissions.length-1;si>=0;si--) {
        const sub=this.subEmissions[si];sub.remaining-=step;
        if(sub.remaining>EPS)continue;
        this.subEmissions.splice(si,1);
        if(sub.parent.active&&sub.parent.generation===sub.generation) {
          const parent=sub.parent;
          for(let n=0;n<sub.count;n++)this.spawn(sub.group,[parent.x,parent.y,parent.z],[parent.vx,parent.vy,parent.vz],0,true);
        }
      }
      for(const group of this.groups)if(!group.sub)this.emit(group,step,at,velocity,Math.hypot(...movement));
    }
    this.origin=[...origin];
  }
  pose(p:GradeParticle,out?:ParticlePose):ParticlePose {
    const pose=this.poseMath.pose(p,out);
    // Vertical Billboard locks the source quad to world Y (the camera's upY).
    if(p.spec.renderMode===3)pose.height*=CAMERA_BASIS.upY;
    return pose;
  }
  private emit(group:Group,dt:number,origin:ParticleVector,velocity:ParticleVector,distance:number):void {
    const s=group.spec,previous=group.clock,current=group.clock<0?dt:group.clock+dt;
    group.clock=current;
    const duration=Math.max(EPS,s.duration??1),end=s.looping?current:Math.min(duration,current);
    const times:number[]=[];
    for(const burst of s.bursts) {
      const first=s.looping?Math.max(0,Math.floor(previous/duration)):0,last=s.looping?Math.floor((end+EPS)/duration):0;
      const repeats=burst.cycles===0?Math.ceil((duration-burst.time)/Math.max(EPS,burst.interval)):burst.cycles;
      for(let cycle=first;cycle<=last;cycle++)for(let n=0;n<repeats;n++) {
        const local=burst.time+n*burst.interval;if(local>=duration-EPS&&n>0)break;
        const time=cycle*duration+local;
        if((previous<0||time>previous+EPS)&&time<=end+EPS&&this.random()<=burst.probability)for(let k=0;k<burst.count;k++)times.push(time);
      }
    }
    const rate=s.timeEmissionRate??0;
    if(rate>0)for(let n=Math.floor(Math.max(0,previous)*rate+EPS)+1;n<=Math.floor(end*rate+EPS);n++)times.push(n/rate);
    const fromDistance=group.distance;group.distance+=distance;
    if(s.emissionRate>0&&end>=current-EPS)for(let n=Math.floor(fromDistance*s.emissionRate+EPS)+1;n<=Math.floor(group.distance*s.emissionRate+EPS);n++)
      times.push(current-(group.distance-n/s.emissionRate)/Math.max(EPS,Math.hypot(...velocity)));
    times.sort((a,b)=>a-b);
    for(const time of times) {
      const age=Math.max(0,current-time),at=origin.map((v,i)=>v-velocity[i]*age) as ParticleVector;
      const particle=this.spawn(group,at,velocity,time);
      if(particle&&age>0){this.advance(particle,age);if(s.simulationSpace===0){
        particle.x+=velocity[0]*age;particle.y+=velocity[1]*age;particle.z+=velocity[2]*age;
        for(let i=0;i<3;i++)particle.center[i]+=velocity[i]*age;
        for(const point of particle.trail){point.x+=velocity[0]*age;point.y+=velocity[1]*age;point.z+=velocity[2]*age;}
      }}
    }
  }
  private spawn(group:Group,origin:ParticleVector,velocity:ParticleVector,time:number,sub=false):GradeParticle|undefined {
    const s=group.spec;
    let p=group.particles.find(candidate=>!candidate.active);
    if(!p) {
      if(group.particles.length>=s.maxParticles)return;
      p={index:this.particles.length,spec:s,active:false,age:0,life:0,size:0,x:0,y:0,z:0,vx:0,vy:0,vz:0,rotation:0,random:0,generation:0,baseVelocity:[0,0,0],velocityRandom:[0,0,0],center:[0,0,0],trail:[]};
      this.particles.push(p);group.particles.push(p);
    }
    p.generation++;p.active=true;p.age=0;p.random=this.random();p.life=curve(s.lifetime,0,this.random());
    p.size=curve(s.size,0,this.random())*s.scale;p.sizeY=s.startSizeY?curve(s.startSizeY,0,this.random())*s.scale:undefined;
    p.sizeZ=s.startSizeZ?curve(s.startSizeZ,0,this.random())*s.scale:undefined;p.rotation=curve(s.rotation,0,this.random());
    p.rotationX=s.startRotationX?curve(s.startRotationX,0,this.random()):0;p.rotationY=s.startRotationY?curve(s.startRotationY,0,this.random()):0;
    p.sheetRandom=this.random();p.sheetStart=s.textureSheet?curve(s.textureSheet.startFrame,0,this.random()):0;
    p.velocityRandom=[this.random(),this.random(),this.random()];p.trail.length=0;
    const shape=this.shape(s,time),rotation=s.sourceTransform?.rotation??IDENTITY;
    const point=particleRotate(rotation,shape.position),direction=particleRotate(rotation,shape.direction);
    const center=sub?origin:origin.map((v,i)=>v+(s.sourceTransform?.position[i]??0)) as ParticleVector;
    p.center=[...center];p.baseRotation=rotation;p.x=center[0]+point[0];p.y=center[1]+point[1];p.z=center[2]+point[2];
    const speed=curve(s.speed,0,this.random())*s.scale;
    const inherit=s.inheritVelocity&&s.simulationSpace===1?curve(s.inheritVelocity,0,p.random):0;
    p.baseVelocity=direction.map((v,i)=>v*speed+velocity[i]*inherit) as ParticleVector;
    [p.vx,p.vy,p.vz]=p.baseVelocity;
    if(s.trail)p.trail.push({x:p.x,y:p.y,z:p.z,age:0});
    for(const child of s.subEmitters??[])if(child.event===0&&this.random()<=child.probability) {
      const target=this.groups.find(g=>g.spec.id===child.id);if(!target)throw new Error('Missing grade sub-emitter '+child.id);
      // Birth supports the child emission timeline; the child is anchored at
      // its parent particle, not at the authored editor transform offset.
      for(const burst of target.spec.bursts)for(let i=0;i<Math.max(1,burst.cycles);i++) {
        const delay=burst.time+i*burst.interval;
        if(delay<=0)for(let count=0;count<burst.count;count++)this.spawn(target,[p.x,p.y,p.z],[p.vx,p.vy,p.vz],0,true);
        else this.subEmissions.push({group:target,remaining:delay,count:burst.count,parent:p,generation:p.generation});
      }
    }
    return p;
  }
  private shape(s:GradeParticleSpec,time:number):{position:ParticleVector;direction:ParticleVector} {
    const shape=s.shape;if(!shape)return {position:[0,0,0],direction:[0,0,1]};
    const angle=this.random()*Math.PI*2,up=this.random()*2-1,side=Math.sqrt(1-up*up);
    let direction:ParticleVector=[side*Math.cos(angle),up,side*Math.sin(angle)],position:ParticleVector=[0,0,0];
    const inner=1-shape.thickness;
    if(shape.type===0){const radius=shape.radius*s.scale*Math.cbrt(inner**3+this.random()*(1-inner**3));position=direction.map(v=>v*radius) as ParticleVector;}
    else if(shape.type===19) {
      // Sprite shape placementMode=0 is Vertex, not Triangle. Fireflies use
      // the exact 16 vertices of the original sprite's tight mesh.
      const vertices=s.spriteShape!.vertices;
      position=vertices[Math.min(vertices.length-1,Math.floor(this.random()*vertices.length))].map(v=>v*s.scale) as ParticleVector;
      if(shape.randomDirection===0)direction=[0,0,1];
    } else {
      const arc=shape.arc,az=arc?.mode===1?(time*curve(arc.speed,0,.5)%1)*arc.degrees*Math.PI/180:angle;
      const radius=Math.sqrt(inner*inner+this.random()*(1-inner*inner))*shape.radius*s.scale;
      const spread=shape.type===10?Math.PI/2:Math.atan(Math.tan(shape.angle*Math.PI/180)*radius/Math.max(EPS,shape.radius*s.scale));
      direction=[Math.sin(spread)*Math.cos(az),Math.sin(spread)*Math.sin(az),Math.cos(spread)];
      position=[Math.cos(az)*radius,Math.sin(az)*radius,0];
      if(shape.type===8){const depth=this.random()*shape.length*s.scale;position=position.map((v,i)=>v+direction[i]*depth) as ParticleVector;}
    }
    const rotation=particleEulerQuaternion(...shape.rotation.map(v=>v*Math.PI/180) as ParticleVector);
    position=particleRotate(rotation,position.map((v,i)=>v*shape.scale[i]) as ParticleVector);
    position=position.map((v,i)=>v+shape.position[i]*s.scale) as ParticleVector;
    return {position,direction:particleRotate(rotation,direction)};
  }
  private advance(p:GradeParticle,dt:number):void {
    const s=p.spec,used=Math.min(dt,p.life-p.age),t=Math.min(1,(p.age+used*.5)/p.life);
    p.baseVelocity[1]-=9.81*curve(s.gravity,t,p.random)*used;
    let velocity=[...p.baseVelocity] as ParticleVector;
    if(s.velocity) {
      const v=s.velocity,q=s.sourceTransform?.rotation??IDENTITY;
      let linear:ParticleVector=[curve(v.x,t,p.velocityRandom[0]),curve(v.y,t,p.velocityRandom[1]),curve(v.z,t,p.velocityRandom[2])];
      if(!v.world)linear=particleRotate(q,linear);
      velocity=velocity.map((n,i)=>(n+linear[i]*s.scale)*curve(v.speedModifier,t,p.random)) as ParticleVector;
      // Space applies to Linear XYZ. Orbital axes belong to the system's
      // transform, including the Z emitter's authored X=-90 degree tilt.
      const spin=particleRotate(q,[curve(v.orbitalX,t,p.random),curve(v.orbitalY,t,p.random),curve(v.orbitalZ,t,p.random)]);
      const relative:ParticleVector=[p.x-p.center[0],p.y-p.center[1],p.z-p.center[2]];
      if(spin.some(n=>n!==0)) {
        const length=Math.hypot(...spin),r=length*used*.5,turn:[number,number,number,number]=[spin[0]/length*Math.sin(r),spin[1]/length*Math.sin(r),spin[2]/length*Math.sin(r),Math.cos(r)];
        const rotated=particleRotate(turn,relative);p.x+=rotated[0]-relative[0];p.y+=rotated[1]-relative[1];p.z+=rotated[2]-relative[2];
      }
    }
    if(s.limitVelocity){const keep=particleVelocityKeep(Math.hypot(...velocity),curve(s.limitVelocity.magnitude,t,p.random)*s.scale,s.limitVelocity.dampen,used);velocity=velocity.map(n=>n*keep) as ParticleVector;p.baseVelocity=p.baseVelocity.map(n=>n*keep) as ParticleVector;}
    [p.vx,p.vy,p.vz]=velocity;p.x+=p.vx*used;p.y+=p.vy*used;p.z+=p.vz*used;
    if(s.rotationCurve)p.rotation+=curve(s.rotationCurve,t,p.random)*used;
    p.age+=dt;if(p.age>=p.life){p.active=false;p.trail.length=0;return;}
    if(s.trail) {
      const trail=s.trail,maxAge=curve(trail.lifetime,t,p.random)*p.life;
      while(p.trail.length&&p.age-p.trail[0].age>maxAge)p.trail.shift();
      const last=p.trail[p.trail.length-1];
      if(!last||Math.hypot(p.x-last.x,p.y-last.y,p.z-last.z)>=trail.minVertexDistance)p.trail.push({x:p.x,y:p.y,z:p.z,age:p.age});
    }
  }
}
