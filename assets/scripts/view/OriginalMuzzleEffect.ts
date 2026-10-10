import { Color, gfx, Node, Sprite, UITransform } from 'cc';
import { ArtLibrary } from './ArtLibrary';
import { particleVelocityKeep } from './OriginalParticleMotion';
import { sampleParticleStops } from './OriginalFeedbackMath';

interface Point {x:number;y:number}
interface EmitterSpec {localScale:number;gunScale:number;rigScale:number}
/** The current emitter's three local unit axes, projected through its hierarchy. */
export interface MuzzleEmitterPose {origin:Point;xAxis:Point;yAxis:Point;zAxis:Point}
interface CurveKey {time:number;value:number;inSlope:number;outSlope:number}
interface SystemSpec {
  source:string; spriteId:string; burst:number; duration:number; worldSimulation:boolean;
  lifetime:[number,number]; speed:[number,number]; size:[number,number]; startAlpha:number;
  coneAngle:number; radius:number; sizeCurve:CurveKey[];
  gradient:{colors:number[][];alpha:number[][]}; stretched:boolean; lengthScale:number; velocityScale:number;
  limitVelocity:{magnitude:number;dampen:number}|null;
  sortingOrder:number;
}
interface Particle {
  node:Node; sprite:Sprite; transform:UITransform; spec:SystemSpec;
  x:number;y:number;z:number;vx:number;vy:number;vz:number;speed:number;size:number;age:number;life:number;
  emissionPose:MuzzleEmitterPose|null;
}

/** The two original Gun0 ParticleSystems, projected into the fixed 2D camera. */
export class OriginalMuzzleEffect {
  private readonly particles:Particle[]=[];
  private readonly specs:SystemSpec[];
  private readonly playing:number[];
  private readonly emitter:EmitterSpec;
  private readonly systemParticles:Particle[][];
  private readonly point:Point={x:0,y:0};
  private readonly velocity:Point={x:0,y:0};
  private readonly rgb=[1,1,1];
  private readonly alpha=[1];
  private readonly color=new Color();
  constructor(art:ArtLibrary,parent:Node,
    private readonly toLocal:(position:Point)=>Point,parentForOrder?:(order:number)=>Node) {
    this.specs=art.catalog.effects.muzzle.particleSystems;
    this.playing=this.specs.map(()=>0);
    this.systemParticles=this.specs.map(()=>[]);
    this.emitter=art.catalog.effects.muzzle.emitter;
    // Six glow quads (order1) then eight stretched sparks (order2).
    for(const spec of this.specs.slice().sort((a,b)=>a.stretched===b.stretched?0:a.stretched?1:-1)) {
      const particles=this.systemParticles[this.specs.indexOf(spec)];
      for(let i=0;i<spec.burst;i++) {
        const n=art.image(`${spec.spriteId}_${i}`,art.catalog.effects[spec.spriteId],parentForOrder?.(spec.sortingOrder)??parent);
        const sprite=n.getComponent(Sprite)!;
        // Creator 3.8.8 exposes no public destination-blend setter for UISprite.
        // This verified UIRenderer field feeds its material blend-state update.
        (sprite as any)._dstBlendFactor=gfx.BlendFactor.ONE;
        (sprite as any).srcBlendFactor=gfx.BlendFactor.SRC_ALPHA;
        (sprite as any).updateMaterial();
        n.active=false;
        const particle:Particle={node:n,sprite,transform:n.getComponent(UITransform)!,spec,
          x:0,y:0,z:0,vx:0,vy:0,vz:0,speed:0,size:0,age:1,life:0,emissionPose:null};
        this.particles.push(particle);particles.push(particle);
      }
    }
  }

  fire(pose:MuzzleEmitterPose):void {
    const sizeScale=this.emitter.localScale*this.emitter.gunScale*this.emitter.rigScale;
    for(let si=0;si<this.specs.length;si++) {
      const spec=this.specs[si];
      // Unity6 ParticleSystem.Play does not restart an already-playing system.
      if(this.playing[si]>0)continue;
      this.playing[si]=spec.duration;
      for(const p of this.systemParticles[si]) {
        const phi=Math.random()*Math.PI*2,r=Math.sqrt(Math.random());
        const radius=r*spec.radius;
        const spread=r*Math.tan(spec.coneAngle*Math.PI/180);
        const norm=Math.sqrt(1+spread*spread);
        const dx=Math.cos(phi)*spread/norm,dy=Math.sin(phi)*spread/norm,dz=1/norm;
        // Raw ParticleSystem positions and velocities remain in emitter space.
        // The source's moveWithTransform=0 is Local, not the old Boolean sense.
        p.x=Math.cos(phi)*radius;p.y=Math.sin(phi)*radius;p.z=0;
        p.speed=randomRange(spec.speed);p.size=randomRange(spec.size)*sizeScale;
        p.vx=dx*p.speed;p.vy=dy*p.speed;p.vz=dz*p.speed;
        p.emissionPose=pose;
        p.age=0;p.life=randomRange(spec.lifetime);p.node.active=true;
      }
    }
  }

  update(dt:number,pose:MuzzleEmitterPose,mirror:number,display:{scale:number;projectionScaleY:number}):void {
    for(let i=0;i<this.playing.length;i++)this.playing[i]=Math.max(0,this.playing[i]-dt);
    for(const p of this.particles) {
      if(!p.node.active)continue;
      const used=Math.max(0,Math.min(dt,p.life-p.age));
      p.age+=dt;
      if(p.age>=p.life){p.node.active=false;continue;}
      if(p.spec.limitVelocity) {
        // Both original muzzle modules limit local velocity (inWorldSpace=false).
        // Keep raw emitter units here; its hierarchy is applied when projecting.
        const speed=Math.hypot(p.vx,p.vy,p.vz),limit=p.spec.limitVelocity;
        const keep=particleVelocityKeep(speed,limit.magnitude,limit.dampen,used);
        p.vx*=keep;p.vy*=keep;p.vz*=keep;
      }
      p.speed=Math.hypot(p.vx,p.vy,p.vz);
      p.x+=p.vx*used;p.y+=p.vy*used;p.z+=p.vz*used;
      // Local systems follow the current muzzle, gun recoil, animation and flip.
      // World systems instead retain the complete transform at emission.
      const frame=p.spec.worldSimulation?p.emissionPose!:pose;
      const point=projectMuzzleVector(frame,p.x,p.y,p.z,this.point);
      const velocity=projectMuzzleVector(frame,p.vx,p.vy,p.vz,this.velocity);
      point.x+=frame.origin.x;point.y+=frame.origin.y;
      const t=p.age/p.life,local=this.toLocal(point);
      p.node.setPosition(local.x,local.y,0);
      const size=p.size*sampleCurve(p.spec.sizeCurve,t);
      const length=p.spec.stretched?size*p.spec.lengthScale+p.speed*p.spec.velocityScale:size;
      const angle=p.spec.stretched?Math.atan2(velocity.y,velocity.x):0;
      const c=Math.cos(angle),s=Math.sin(angle),py=display.projectionScaleY;
      p.node.angle=Math.atan2(s/py,c*mirror)*180/Math.PI;
      p.transform.setContentSize(Math.max(.0001,length/display.scale),Math.max(.0001,size/(display.scale*py)));
      const rgb=sampleParticleStops(p.spec.gradient.colors,t,this.rgb);
      const a=sampleParticleStops(p.spec.gradient.alpha,t,this.alpha)[0]*p.spec.startAlpha;
      this.color.set(Math.round(rgb[0]*255),Math.round(rgb[1]*255),Math.round(rgb[2]*255),Math.round(a*255));
      p.sprite.color=this.color;
    }
  }

  reset():void {
    for(let i=0;i<this.playing.length;i++)this.playing[i]=0;
    for(const p of this.particles){p.node.active=false;p.age=p.life;p.emissionPose=null;}
  }
}

export function projectMuzzleVector(pose:MuzzleEmitterPose,x:number,y:number,z:number,out:Point={x:0,y:0}):Point {
  out.x=pose.xAxis.x*x+pose.yAxis.x*y+pose.zAxis.x*z;
  out.y=pose.xAxis.y*x+pose.yAxis.y*y+pose.zAxis.y*z;
  return out;
}

function randomRange(range:[number,number]):number{return range[0]+Math.random()*(range[1]-range[0]);}
function sampleCurve(keys:CurveKey[],t:number):number {
  if(t<=keys[0].time)return keys[0].value;
  for(let i=1;i<keys.length;i++)if(t<=keys[i].time) {
    const a=keys[i-1],b=keys[i],dt=b.time-a.time,u=(t-a.time)/dt,u2=u*u,u3=u2*u;
    return (2*u3-3*u2+1)*a.value+(u3-2*u2+u)*dt*a.outSlope+(-2*u3+3*u2)*b.value+(u3-u2)*dt*b.inSlope;
  }
  return keys[keys.length-1].value;
}
