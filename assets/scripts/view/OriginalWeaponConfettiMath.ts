import { originalConfettiNoise } from './OriginalWeaponConfettiNoise';

/** Raw ParticleImage fields exported from the three original success emitters. */
export interface ConfettiRecord { node: string; source: Record<string, any>; }
export interface ConfettiPoint { x: number; y: number; age: number; }
export interface ConfettiParticle {
  x:number;y:number;vx:number;vy:number;gx:number;gy:number;age:number;life:number;
  initial:number[];size:number[];rotation:number[];color:number[];random:number[];trail:ConfettiPoint[];hasTrail:boolean;
}
export interface ConfettiEmitter {
  record:ConfettiRecord;particles:ConfettiParticle[];width:number;worldAngle:number;
  elapsed:number;emitted:number;bursts:Set<number>;
}
export interface ConfettiPose { corners:number[][];color:number[];width:number;rotation:number[]; }
const clamp=(x:number)=>Math.max(0,Math.min(1,x));
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;

export function confettiCurve(curve:Record<string,any>,time:number,random=.5):number {
  if(!curve)return 1;
  switch(curve.m_Mode){
    case 0:return curve.m_ConstantMax;
    case 3:return mix(curve.m_ConstantMin,curve.m_ConstantMax,random);
    case 1:return hermite(curve.m_CurveMax.m_Curve,time)*curve.m_CurveMultiplier;
    case 2:return mix(hermite(curve.m_CurveMin.m_Curve,time),hermite(curve.m_CurveMax.m_Curve,time),random)*curve.m_CurveMultiplier;
    default:return 1;
  }
}
function hermite(keys:Record<string,number>[],t:number):number {
  if(!keys.length)return 0;if(t<=keys[0].time)return keys[0].value;
  for(let i=1;i<keys.length;i++)if(t<=keys[i].time){
    const a=keys[i-1],b=keys[i],dt=b.time-a.time;if(dt<=0)return b.value;
    const u=(t-a.time)/dt,u2=u*u,u3=u2*u;
    if(!Number.isFinite(a.outSlope))return a.value;
    return (2*u3-3*u2+1)*a.value+(u3-2*u2+u)*dt*a.outSlope+(-2*u3+3*u2)*b.value+(u3-u2)*dt*b.inSlope;
  }return keys[keys.length-1].value;
}
function vectorCurve(raw:Record<string,any>,t:number,r:number,zOnly=false):number[]{
  if(raw.separated)return ['xCurve','yCurve','zCurve'].map(k=>confettiCurve(raw[k],t,r));
  const n=confettiCurve(raw.mainCurve,t,r);return zOnly?[0,0,n]:[n,n,n];
}
function rgba(raw:Record<string,number>):number[]{return [raw.r,raw.g,raw.b,raw.a];}
function gradient(raw:Record<string,any>,t:number):number[]{
  const read=(kind:'Color'|'Alpha',channel:string)=>{
    const length=raw[`m_Num${kind}Keys`],prefix=kind==='Color'?'ctime':'atime';
    if(!length)return 1;const first=raw.key0[channel];if(t<=raw[`${prefix}0`]/65535)return first;
    for(let i=1;i<length;i++){const bt=raw[`${prefix}${i}`]/65535;if(t<=bt){
      const at=raw[`${prefix}${i-1}`]/65535,a=raw[`key${i-1}`][channel],b=raw[`key${i}`][channel];
      return raw.m_Mode===1?a:mix(a,b,clamp((t-at)/Math.max(1e-9,bt-at)));
    }}return raw[`key${length-1}`][channel];
  };return ['r','g','b'].map(c=>read('Color',c)).concat(read('Alpha','a'));
}
function colorCurve(raw:Record<string,any>,t:number,r:number):number[]{
  if(raw.m_Mode===0)return rgba(raw.m_ColorMax);
  if(raw.m_Mode===2)return rgba(raw.m_ColorMin).map((c,i)=>mix(c,rgba(raw.m_ColorMax)[i],r));
  if(raw.m_Mode===3)return gradient(raw.m_GradientMin,t).map((c,i)=>mix(c,gradient(raw.m_GradientMax,t)[i],r));
  return gradient(raw.m_GradientMax,raw.m_Mode===4?r:t);
}
function speedT(source:Record<string,any>,key:string,p:ConfettiParticle):number{
  const range=source[key],speed=Math.hypot(p.vx,p.vy);return range?.to!==range?.from?clamp((speed-range.from)/(range.to-range.from)):0;
}
function lifetimeRotation(raw:Record<string,any>,t:number,r:number):number[]{
  const one=(c:Record<string,any>)=>confettiCurve(c,t,r)*(c.m_Mode===0||c.m_Mode===3?t:1);
  return raw.separated?['xCurve','yCurve','zCurve'].map(k=>one(raw[k])):[0,0,one(raw.mainCurve)];
}
function rotateCorner(x:number,y:number,angles:number[]):number[]{
  // Unity Quaternion.Euler applies Z, X, Y. Project the resulting XY rectangle.
  const [rx,ry,rz]=angles.map(v=>v*Math.PI/180),cz=Math.cos(rz),sz=Math.sin(rz),cx=Math.cos(rx),sx=Math.sin(rx),cy=Math.cos(ry),sy=Math.sin(ry);
  const xx=x*cz-y*sz,yy=x*sz+y*cz,zz=yy*sx;
  return [xx*cy+zz*sy,yy*cx];
}

/** Single-thread ParticleImage motion. No combat/session state is read or mutated. */
export class OriginalConfettiSimulation {
  readonly emitters:ConfettiEmitter[];
  playing=false;
  constructor(records:readonly ConfettiRecord[],private readonly rng:()=>number=Math.random){
    this.emitters=records.map(record=>({record,particles:[],width:record.source._length,worldAngle:0,elapsed:0,emitted:0,bursts:new Set<number>()}));
  }
  get count():number{return this.emitters.reduce((n,e)=>n+e.particles.length,0);}
  play():void{this.clear();this.playing=true;this.emitters.forEach(e=>this.emitDue(e,0));}
  clear():void{this.playing=false;this.emitters.forEach(e=>{e.particles.length=0;e.elapsed=0;e.emitted=0;e.bursts.clear();});}
  update(dt:number):void{
    if(!this.playing||!(dt>0)||!Number.isFinite(dt))return;
    for(const e of this.emitters){
      const next=e.elapsed+dt;
      for(const p of e.particles)this.advance(e,p,dt);
      this.emitDue(e,next);e.elapsed=next;
      e.particles=e.particles.filter(p=>p.age<p.life||(p.hasTrail&&p.trail.length>1));
    }
    if(this.emitters.every(e=>e.elapsed>=e.record.source._startDelay+e.record.source._duration)&&this.count===0)this.playing=false;
  }
  pose(e:ConfettiEmitter,p:ConfettiParticle):ConfettiPose{
    const s=e.record.source,t=clamp(p.age/p.life),sizeLife=vectorCurve(s._sizeOverLifetime,t,p.random[0]);
    const sizeSpeed=vectorCurve(s._sizeBySpeed,speedT(s,'_sizeSpeedRange',p),p.random[0]);
    const width=p.size[0]*sizeLife[0]*sizeSpeed[0],height=p.size[1]*sizeLife[1]*sizeSpeed[1];
    const rotateLife=lifetimeRotation(s._rotationOverLifetime,t,p.random[1]);
    const rotateSpeed=vectorCurve(s._rotationBySpeed,speedT(s,'_rotationSpeedRange',p),p.random[1],true);
    const rotation=p.rotation.map((v,i)=>v+rotateLife[i]+rotateSpeed[i]);
    if(!s._alignToDirection)rotation[2]-=e.worldAngle;
    const lifeColor=colorCurve(s._colorOverLifetime,t,p.random[2]),speedColor=colorCurve(s._colorBySpeed,speedT(s,'_colorSpeedRange',p),p.random[2]);
    const color=p.color.map((v,i)=>v*lifeColor[i]*speedColor[i]*(rgba(s.m_Color)[i]));
    const corners=[[-width/2,-height/2],[width/2,-height/2],[width/2,height/2],[-width/2,height/2]]
      .map(([x,y])=>{const q=rotateCorner(x,y,rotation);return [q[0]+p.x,q[1]+p.y];});
    return {corners,color,width,rotation};
  }
  trail(e:ConfettiEmitter,p:ConfettiParticle):{corners:number[][];color:number[]}[]{
    if(!p.hasTrail||p.trail.length<2)return [];
    const s=e.record.source,pose=this.pose(e,p),out:{corners:number[][];color:number[]}[]=[];
    const points=p.trail,first=points[0],last=points[points.length-1],length=Math.hypot(last.x-first.x,last.y-first.y)||1;
    const width=(a:ConfettiPoint)=>pose.width*confettiCurve(s._trailWidth,1-clamp(Math.hypot(a.x-first.x,a.y-first.y)/length),p.random[0])*.5;
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i],distance=Math.hypot(b.x-a.x,b.y-a.y);if(distance<1e-8)continue;
      const nx=-(b.y-a.y)/distance,ny=(b.x-a.x)/distance,wa=width(a),wb=width(b);
      const along=1-clamp(Math.hypot(b.x-first.x,b.y-first.y)/length);
      const lifeColor=colorCurve(s._trailColorOverLifetime,clamp(p.age/p.life),p.random[2]),trailColor=colorCurve(s._trailColorOverTrail,along,p.random[2]);
      const color=lifeColor.map((v,c)=>v*trailColor[c]*(s._inheritParticleColor?pose.color[c]:1));
      out.push({corners:[[a.x+nx*wa,a.y+ny*wa],[b.x+nx*wb,b.y+ny*wb],[b.x-nx*wb,b.y-ny*wb],[a.x-nx*wa,a.y-ny*wa]],color});
    }return out;
  }
  private emitDue(e:ConfettiEmitter,to:number):void{
    const s=e.record.source,start=s._startDelay,end=start+s._duration;
    (s._bursts as {time:number;count:number}[]).forEach((burst,i)=>{
      const time=start+burst.time;if(e.bursts.has(i)||time>to+1e-9||time>end+1e-9)return;
      e.bursts.add(i);for(let n=0;n<burst.count;n++)this.birth(e,Math.max(0,to-time));
    });
    if(s._rate>0){
      const total=Math.floor(Math.max(0,Math.min(to,end)-start)*s._rate+1e-6);
      while(e.emitted<total){const time=start+(++e.emitted)/s._rate;this.birth(e,Math.max(0,to-time));}
    }
  }
  private birth(e:ConfettiEmitter,age:number):void{
    const s=e.record.source,rand=()=>clamp(this.rng()),x=s._shape===3?(rand()-.5)*(s._fitRect?e.width:s._length):0;
    const angle=s._shape===4?(rand()-.5)*s._angle*Math.PI/180:0;
    const speed=confettiCurve(s._startSpeed,rand(),rand());
    const p:ConfettiParticle={x,y:0,vx:Math.sin(angle)*speed,vy:Math.cos(angle)*speed,gx:0,gy:0,age:0,
      life:Math.max(.0001,confettiCurve(s._lifetime,rand(),rand())),
      size:vectorCurve(s._startSize,rand(),rand()),rotation:vectorCurve(s._startRotation,rand(),rand(),true),
      color:colorCurve(s._startColor,rand(),rand()),random:[rand(),rand(),rand(),rand(),rand()],trail:[],hasTrail:false,
      initial:[Math.sin(angle)*speed,Math.cos(angle)*speed]};
    p.hasTrail=!!(s._trailModule.enabled&&rand()<s._trailRatio);
    if(p.hasTrail)p.trail.push({x:p.x,y:p.y,age:0});
    e.particles.push(p);if(age>0)this.advance(e,p,age);
  }
  private advance(e:ConfettiEmitter,p:ConfettiParticle,dt:number):void{
    const s=e.record.source,target=p.age+dt;
    while(p.age<Math.min(target,p.life)-1e-9){
      const step=Math.min(1/60,target-p.age,p.life-p.age);p.age+=step;const t=clamp(p.age/p.life);
      const speed=confettiCurve(s._speedOverLifetime,t,p.random[3]);
      // _startVelocity stays constant; only the normalized-life multiplier changes.
      let vx=p.initial[0]*speed,vy=p.initial[1]*speed;
      if(s._gravityModule.enabled){
        const gravity=confettiCurve(s._gravity,t,p.random[4]),angle=e.worldAngle*Math.PI/180;
        p.gx+=Math.sin(angle)*gravity*step;p.gy+=Math.cos(angle)*gravity*step;
      }
      if(s._noiseModule.enabled){
        const noise=originalConfettiNoise(p.x+s._noiseOffset.x,p.y+s._noiseOffset.y,s._noiseFrequency/100);
        // Original Particle.Simulate uses cos/sin(noise * PI) as velocity offset.
        const angle=noise*Math.PI;vx+=Math.cos(angle)*s._noiseStrength;vy+=Math.sin(angle)*s._noiseStrength;
      }
      p.vx=vx+p.gx;p.vy=vy+p.gy;p.x+=p.vx*step*100;p.y+=p.vy*step*100;
      if(p.hasTrail){const previous=p.trail[p.trail.length-1];
        if(!previous||Math.hypot(p.x-previous.x,p.y-previous.y)>s._minimumVertexDistance)p.trail.push({x:p.x,y:p.y,age:p.age});
      }
    }
    p.age=target;
    if(p.hasTrail){p.trail=p.trail.filter(point=>point.age+s._trailLifetime>target);if(s._dieWithParticle&&target>=p.life)p.trail.length=0;}
  }
}
