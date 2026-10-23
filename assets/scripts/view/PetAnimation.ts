/** Minimal source-data evaluator for the exact ten Spine 4.1 pet rigs. Keeps
 * weighted vertices and absolute Bezier controls; does not downgrade JSON to
 * the engine's incompatible Spine version. Unsupported data fails at load. */
export interface PetBone { name: string; parent?: string; x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number; shearX?: number; shearY?: number; transform?: string; }
interface Key { time?: number; x?: number; y?: number; value?: number; curve?: 'stepped' | number[]; }
type Tracks = Partial<Record<'translate'|'rotate'|'scale'|'shear',Key[]>>;
export interface PetRig {
  version: number; id: number; name: string; scale: number; defaultMix: number;
  bones: PetBone[]; slots: {name:string;bone:string;attachment?:string;color?:string}[];
  attachments: Record<string,Record<string,{type?:string;path?:string;x?:number;y?:number;rotation?:number;scaleX?:number;scaleY?:number;width:number;height:number;uvs?:number[];vertices?:number[];triangles?:number[];color?:string}>>;
  constraints: {order?:number;bones:string[];target:string;x?:number;y?:number;mixX?:number;mixY?:number;mixRotate?:number;mixScaleX?:number;mixShearY?:number}[];
  animations: Record<'Idle'|'Walk',{bones:Record<string,Tracks>}>;
  images: Record<string,{path:string;sizePx:number[]}>;
  sourceTransforms: {m_LocalPosition:{x:number;y:number;z:number};m_LocalScale:{x:number;y:number;z:number};m_LocalRotation:{x:number;y:number;z:number;w:number}}[];
}
export interface PetMesh { name:string; path:string; indices:number[]; uv:number[][]; positions:number[][]; color:number[]; influences:number[][][]; }
type Local = {x:number;y:number;r:number;sx:number;sy:number;hx:number;hy:number};
type Matrix = {a:number;b:number;c:number;d:number;x:number;y:number};
const radians = Math.PI/180;
const wrap = (value:number):number => ((value+180)%360+360)%360-180;
const rgba = (hex='ffffffff'):number[] => [0,2,4,6].map(i=>parseInt(hex.slice(i,i+2),16)/255);

export function petTimelineValue(keys: readonly Key[] | undefined, time: number, field: 'value'|'x'|'y', fallback: number, channel=0): number {
  if (!keys?.length || time < (keys[0].time ?? 0)) return fallback;
  let index=0; while(index+1<keys.length && (keys[index+1].time ?? 0)<=time) index++;
  const from=keys[index],to=keys[index+1],a=from[field] ?? fallback;
  if (!to || from.curve==='stepped') return a;
  const t0=from.time ?? 0,t1=to.time ?? 0,b=to[field] ?? fallback;
  if (!Array.isArray(from.curve)) return a+(b-a)*(time-t0)/(t1-t0);
  const c=from.curve,offset=channel*4;
  // 4.1 stores control point time/value pairs per channel, in timeline units.
  const x1=c[offset],y1=c[offset+1],x2=c[offset+2],y2=c[offset+3];
  if (x1===undefined) throw new Error('Missing pet Bezier channel');
  const bezier=(u:number,p0:number,p1:number,p2:number,p3:number):number => {const v=1-u;return v*v*v*p0+3*v*v*u*p1+3*v*u*u*p2+u*u*u*p3;};
  let lo=0,hi=1;
  for(let i=0;i<20;i++){const u=(lo+hi)/2;if(bezier(u,t0,x1,x2,t1)<time)lo=u;else hi=u;}
  return bezier((lo+hi)/2,a,y1,y2,b);
}

export class PetAnimation {
  readonly meshes: PetMesh[];
  private readonly names: Map<string,number>;
  private readonly parents: number[];
  private readonly world: Matrix[];
  private readonly durations: Record<'Idle'|'Walk',number>;
  private animation: 'Idle'|'Walk'='Idle';
  private time=0;
  private previous?: {animation:'Idle'|'Walk';time:number;elapsed:number};
  constructor(readonly rig: PetRig) {
    if (rig.version!==1 || rig.bones.some(b=>b.transform && b.transform!=='normal')) throw new Error('Unsupported pet rig');
    this.names=new Map(rig.bones.map((b,i)=>[b.name,i])); this.parents=rig.bones.map(b=>b.parent?this.names.get(b.parent)!:-1);
    this.world=rig.bones.map(()=>({a:1,b:0,c:0,d:1,x:0,y:0}));
    const duration=(name:'Idle'|'Walk'):number=>{let end=0;for(const tracks of Object.values(rig.animations[name].bones))for(const keys of Object.values(tracks))for(const key of keys)end=Math.max(end,key.time ?? 0);return end;};
    this.durations={Idle:duration('Idle'),Walk:duration('Walk')};
    this.meshes=rig.slots.filter(slot=>!!slot.attachment).map(slot=>{
      const attachment=rig.attachments[slot.name]?.[slot.attachment!]; if(!attachment)throw new Error('Missing pet attachment');
      const bone=this.names.get(slot.bone)!,image=rig.images[attachment.path ?? slot.attachment!];if(!image)throw new Error('Missing pet image');
      let influences:number[][][],uv:number[][],indices:number[];
      if(attachment.type==='mesh') {
        const vertices=attachment.vertices!;uv=[];influences=[];indices=attachment.triangles!;
        for(let i=0;i<attachment.uvs!.length;i+=2)uv.push([attachment.uvs![i],1-attachment.uvs![i+1]]);
        if(vertices.length===uv.length*2) influences=uv.map((_,i)=>[[bone,vertices[i*2],vertices[i*2+1],1]]);
        else for(let cursor=0;cursor<vertices.length;){const count=vertices[cursor++],weights:number[][]=[];for(let n=0;n<count;n++){weights.push(vertices.slice(cursor,cursor+4));cursor+=4;}influences.push(weights);}
      } else {
        if(attachment.type && attachment.type!=='region')throw new Error('Unsupported pet attachment type');
        const r=(attachment.rotation ?? 0)*radians,c=Math.cos(r),s=Math.sin(r);
        influences=[[-.5,-.5],[.5,-.5],[-.5,.5],[.5,.5]].map(([u,v])=>{
          const x=u*attachment.width*(attachment.scaleX ?? 1),y=v*attachment.height*(attachment.scaleY ?? 1);
          return [[bone,c*x-s*y+(attachment.x ?? 0),s*x+c*y+(attachment.y ?? 0),1]];
        });uv=[[0,0],[1,0],[0,1],[1,1]];indices=[0,1,2,2,1,3];
      }
      if(influences.length!==uv.length || indices.some(i=>i<0||i>=uv.length))throw new Error('Invalid pet mesh');
      const color=rgba(slot.color),tint=rgba(attachment.color);
      return {name:slot.name,path:image.path,uv,indices,influences,color:color.map((v,i)=>v*tint[i]),positions:uv.map(()=>[0,0,0])};
    });
    this.update(0,false);
  }
  private local(index:number,animation:'Idle'|'Walk',time:number):Local {
    const b=this.rig.bones[index],t=this.rig.animations[animation].bones[b.name] ?? {},at=time%this.durations[animation];
    return {x:(b.x ?? 0)+petTimelineValue(t.translate,at,'x',0),y:(b.y ?? 0)+petTimelineValue(t.translate,at,'y',0,1),
      r:(b.rotation ?? 0)+petTimelineValue(t.rotate,at,'value',0),
      sx:(b.scaleX ?? 1)*petTimelineValue(t.scale,at,'x',1),sy:(b.scaleY ?? 1)*petTimelineValue(t.scale,at,'y',1,1),
      hx:(b.shearX ?? 0)+petTimelineValue(t.shear,at,'x',0),hy:(b.shearY ?? 0)+petTimelineValue(t.shear,at,'y',0,1)};
  }
  update(dt:number,walking:boolean):void {
    const next=walking?'Walk':'Idle';
    if(next!==this.animation){this.previous={animation:this.animation,time:this.time,elapsed:0};this.animation=next;this.time=0;}
    this.time+=dt;
    if(this.previous){this.previous.time+=dt;this.previous.elapsed+=dt;if(this.previous.elapsed>=this.rig.defaultMix)this.previous=undefined;}
    this.rig.bones.forEach((_,i)=>{
      const p=this.local(i,this.animation,this.time),old=this.previous;
      if(old){const from=this.local(i,old.animation,old.time),a=old.elapsed/this.rig.defaultMix;
        for(const key of ['x','y','sx','sy','hx','hy'] as const)p[key]=from[key]+(p[key]-from[key])*a;
        p.r=from.r+wrap(p.r-from.r)*a;
      }
      const x=(p.r+p.hx)*radians,y=(p.r+90+p.hy)*radians;
      const a=Math.cos(x)*p.sx,b=Math.cos(y)*p.sy,c=Math.sin(x)*p.sx,d=Math.sin(y)*p.sy,w=this.world[i],parent=this.world[this.parents[i]];
      if(parent)Object.assign(w,{a:parent.a*a+parent.b*c,b:parent.a*b+parent.b*d,c:parent.c*a+parent.d*c,d:parent.c*b+parent.d*d,x:parent.a*p.x+parent.b*p.y+parent.x,y:parent.c*p.x+parent.d*p.y+parent.y});
      else Object.assign(w,{a,b,c,d,x:p.x,y:p.y});
    });
    // Acorn has three absolute world translation constraints. Their other mixes
    // are authored zero; constrained bones have no children in these rigs.
    for(const constraint of this.rig.constraints.slice().sort((a,b)=>(a.order ?? 0)-(b.order ?? 0))){
      if((constraint.mixRotate ?? 1)!==0 || (constraint.mixScaleX ?? 1)!==0 || (constraint.mixShearY ?? 1)!==0)throw new Error('Unsupported pet transform mix');
      const t=this.world[this.names.get(constraint.target)!],x=t.a*(constraint.x ?? 0)+t.b*(constraint.y ?? 0)+t.x,y=t.c*(constraint.x ?? 0)+t.d*(constraint.y ?? 0)+t.y;
      for(const name of constraint.bones){const b=this.world[this.names.get(name)!];b.x+=(x-b.x)*(constraint.mixX ?? 1);b.y+=(y-b.y)*(constraint.mixY ?? constraint.mixX ?? 1);}
    }
    for(const mesh of this.meshes)mesh.influences.forEach((influences,i)=>{
      let x=0,y=0;for(const [bone,vx,vy,weight] of influences){const b=this.world[bone];x+=(b.a*vx+b.b*vy+b.x)*weight;y+=(b.c*vx+b.d*vy+b.y)*weight;}
      mesh.positions[i][0]=x*this.rig.scale;mesh.positions[i][1]=y*this.rig.scale;
    });
  }
}
