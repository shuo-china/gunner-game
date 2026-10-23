import { Color, gfx, Material, Node, Sprite, UITransform } from 'cc';
import { ArtLibrary, ImageSpec } from './ArtLibrary';
import { particleVelocityKeep } from './OriginalParticleMotion';
import { sampleParticleStops } from './OriginalFeedbackMath';

interface Point {x:number;y:number}
export interface MuzzleEmitterSpec {localScale:number;gunScale:number;rigScale:number;projectionGapDegrees?:number}
/** The current emitter's three local unit axes, projected through its hierarchy. */
export interface MuzzleEmitterPose {origin:Point;xAxis:Point;yAxis:Point;zAxis:Point}
interface CurveKey {time:number;value:number;inSlope:number;outSlope:number}
export interface MuzzleSystemSpec {
  source:string; spriteId:string; burst:number; duration:number; worldSimulation:boolean;
  lifetime:[number,number]; speed:[number,number]; size:[number,number]; startAlpha:number;
  coneAngle:number; radius:number; sizeCurve:CurveKey[];
  gradient:{colors:number[][];alpha:number[][]}; stretched:boolean; lengthScale:number; velocityScale:number;
  limitVelocity:{magnitude:number;dampen:number}|null;
  sortingOrder:number;
}
export interface MuzzleEffectSpec {emitter:MuzzleEmitterSpec;particleSystems:MuzzleSystemSpec[]}
interface Particle {
  node:Node; sprite:Sprite; transform:UITransform; spec:MuzzleSystemSpec;
  x:number;y:number;z:number;vx:number;vy:number;vz:number;speed:number;size:number;age:number;life:number;
  emissionPose:MuzzleEmitterPose|null;
}

interface SharedMuzzleMaterial { material:Material; users:number }
// All muzzle systems use the same complete additive blend state. A base
// material identity is the remaining cache key; unrelated world sprites keep
// their source-alpha material. References are held once per owning effect.
const muzzleMaterials=new WeakMap<Material,SharedMuzzleMaterial>();

/** The two original Gun0 ParticleSystems, projected into the fixed 2D camera. */
export class OriginalMuzzleEffect {
  private readonly particles:Particle[]=[];
  private readonly specs:MuzzleSystemSpec[];
  private readonly playing:number[];
  private readonly emitter:MuzzleEmitterSpec;
  private readonly systemParticles:Particle[][];
  private readonly point:Point={x:0,y:0};
  private readonly velocity:Point={x:0,y:0};
  private readonly rgb=[1,1,1];
  private readonly alpha=[1];
  private readonly color=new Color();
  private readonly materials=new Map<Material,SharedMuzzleMaterial>();
  private listening=false;
  constructor(art:ArtLibrary,private readonly parent:Node,
    private readonly toLocal:(position:Point)=>Point,parentForOrder?:(order:number)=>Node,
    definition:MuzzleEffectSpec=art.catalog.effects.muzzle,
    images:Record<string,ImageSpec>=art.catalog.effects) {
    this.specs=definition.particleSystems;
    this.playing=this.specs.map(()=>0);
    this.systemParticles=this.specs.map(()=>[]);
    this.emitter=definition.emitter;
    // Six glow quads (order1) then eight stretched sparks (order2).
    let pendingNode:Node|undefined;
    try { for(const spec of this.specs.slice().sort((a,b)=>a.stretched===b.stretched?0:a.stretched?1:-1)) {
      const particles=this.systemParticles[this.specs.indexOf(spec)];
      for(let i=0;i<spec.burst;i++) {
        const n=art.image(`${spec.spriteId}_${i}`,images[spec.spriteId],parentForOrder?.(spec.sortingOrder)??parent);
        pendingNode=n;
        const sprite=n.getComponent(Sprite)!;
        // Custom materials skip UIRenderer's blend-factor update in Creator 3.8.8.
        // One shared variant also lets consecutive glow/spark quads batch.
        sprite.customMaterial=this.additiveMaterial(sprite.getSharedMaterial(0)!);
        n.active=false;
        const particle:Particle={node:n,sprite,transform:n.getComponent(UITransform)!,spec,
          x:0,y:0,z:0,vx:0,vy:0,vz:0,speed:0,size:0,age:1,life:0,emissionPose:null};
        this.particles.push(particle);particles.push(particle);
        pendingNode=undefined;
      }
    }
      // CatView construction can fail after this effect was created. The
      // enclosing node still tears down, even if no caller received CatView.
      if(this.materials.size){parent.once(Node.EventType.NODE_DESTROYED,this.destroy,this);this.listening=true;}
    } catch(error) {
      if(pendingNode?.isValid){pendingNode.active=false;pendingNode.destroy();}
      this.destroy();throw error;
    }
  }

  private additiveMaterial(base:Material):Material {
    let shared=this.materials.get(base);
    if(shared)return shared.material;
    shared=muzzleMaterials.get(base);
    if(!shared) {
      const material=new Material();
      try {material.copy(base,{states:{blendState:{targets:[{
        blend:true,blendSrc:gfx.BlendFactor.SRC_ALPHA,blendDst:gfx.BlendFactor.ONE,
        blendSrcAlpha:gfx.BlendFactor.ONE,blendDstAlpha:gfx.BlendFactor.ONE,
      }]}}});} catch(error) {material.destroy();throw error;}
      shared={material,users:0};muzzleMaterials.set(base,shared);
    }
    shared.users++;this.materials.set(base,shared);return shared.material;
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
  destroy():void {
    if(this.listening){this.parent.off(Node.EventType.NODE_DESTROYED,this.destroy,this);this.listening=false;}
    for(const p of this.particles)if(p.node.isValid){p.node.active=false;p.node.destroy();}
    this.particles.length=0;
    for(const [base,shared] of this.materials)if(--shared.users===0){
      muzzleMaterials.delete(base);shared.material.destroy();
    }
    this.materials.clear();
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
