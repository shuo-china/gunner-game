import { Color, gfx, Node, Rect, Size, Sprite, SpriteFrame, UITransform } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalParticleMesh, ParticleMeshGeometry } from './OriginalParticleMesh';
import { evaluateParticleCurve, ParticlePose, ParticleVector } from './OriginalParticleSimulation';
import { GradeParticle, GradeParticleSpec, WeaponGradeEffectSimulation } from './WeaponGradeEffectSimulation';
import { CAMERA_BASIS as C } from '../core/projection';

interface GradeView {node:Node;sprite:Sprite;transform:UITransform;frame?:number;mesh?:OriginalParticleMesh;geometry?:ParticleMeshGeometry;lengths?:number[];capacity:number}
interface BlendSprite {srcBlendFactor:number;_dstBlendFactor:number;updateMaterial():void}
const IDENTITY={position:[0,0,0] as ParticleVector,rotation:[0,0,0,1] as [number,number,number,number],scale:[1,1,1] as ParticleVector};
const WHITE=[1,1,1,1];

/** Default-layer persistent grade particles, deliberately outside Cat_Bone:
 * turning a cat must never mirror its world-space fireflies or spiral trail. */
export class OriginalWeaponGradeEffects {
  private readonly simulation?:WeaponGradeEffectSimulation;
  private readonly views:GradeView[]=[];
  private readonly ownLayers=new Map<number,Node>();
  private readonly frames=new Map<string,SpriteFrame>();
  private readonly pose:ParticlePose={x:0,y:0,width:0,height:0,angle:0,color:[]};
  private readonly color=new Color();
  constructor(private readonly art:ArtLibrary,private readonly parent:Node,private readonly layerForOrder?:(order:number)=>Node) {
    const config=art.weaponVisuals?.config.gradeEffects;
    if(config)this.simulation=new WeaponGradeEffectSimulation(config);
  }
  setWeapon(id:number):void {if(this.simulation?.setWeapon(id))this.clearViews();}
  setActive(active:boolean):void {this.simulation?.setActive(active);if(!active)for(const view of this.views)if(view)view.node.active=false;}
  reset():void {this.simulation?.reset();for(const view of this.views)if(view)view.node.active=false;}
  update(dt:number,origin:ParticleVector):void {
    const simulation=this.simulation;if(!simulation)return;simulation.update(dt,origin);
    for(const particle of simulation.particles) {
      let view=this.views[particle.index];
      if(!view&&particle.active){view=this.createView(particle);this.views[particle.index]=view;}
      if(!view)continue;
      view.node.active=particle.active;if(!particle.active)continue;
      const pose=simulation.pose(particle,this.pose),s=particle.spec;
      if(s.trail) {
        const capacity=2**Math.ceil(Math.log2(Math.max(4,particle.trail.length+1)));
        if(capacity>view.capacity){view.node.active=false;view.node.destroy();view=this.createView(particle,capacity);this.views[particle.index]=view;}
        this.renderTrail(particle,view,pose);
      } else {
        if(pose.frame!==undefined&&view.frame!==pose.frame){view.sprite.spriteFrame=this.sheetFrame(s,pose.frame);view.frame=pose.frame;}
        view.node.setPosition(pose.x,pose.y,0);view.node.angle=pose.angle;
        view.transform.setContentSize(pose.width,pose.height);
        const color=pose.color;
        this.color.set(colorByte(color[0]),colorByte(color[1]),colorByte(color[2]),colorByte(color[3]));view.sprite.color=this.color;
      }
    }
  }
  destroy():void {
    this.simulation?.clear();this.clearViews();
    for(const frame of this.frames.values())frame.destroy();this.frames.clear();
    for(const layer of this.ownLayers.values())layer.destroy();this.ownLayers.clear();
  }
  diagnostics():{pooled:number;active:number;trails:number} {
    return {pooled:this.views.filter(Boolean).length,active:this.simulation?.particles.filter(p=>p.active).length??0,
      trails:this.simulation?.particles.filter(p=>p.active&&p.spec.trail).length??0};
  }
  private clearViews():void {for(const view of this.views)if(view?.node.isValid){view.node.active=false;view.node.destroy();}this.views.length=0;}
  private createView(p:GradeParticle,capacity=4):GradeView {
    const s=p.spec;
    let layer=this.layerForOrder?.(s.sortingOrder)??this.ownLayers.get(s.sortingOrder);
    if(!layer){layer=makeNode('Grade_Default_Order'+s.sortingOrder,this.parent);this.ownLayers.set(s.sortingOrder,layer);}
    const node=this.art.image(`WeaponGrade_${s.name}_${p.index}`,s.image,layer),sprite=node.getComponent(Sprite)!;
    const blend=sprite as unknown as BlendSprite;
    blend.srcBlendFactor=s.blend.source===1?gfx.BlendFactor.ONE:gfx.BlendFactor.SRC_ALPHA;
    blend._dstBlendFactor=s.blend.destination===0?gfx.BlendFactor.ZERO:s.blend.destination===1?gfx.BlendFactor.ONE:gfx.BlendFactor.ONE_MINUS_SRC_ALPHA;blend.updateMaterial();
    const view:GradeView={node,sprite,transform:node.getComponent(UITransform)!,capacity:0};
    if(s.trail) {
      // Renderer=None suppresses the billboard, not the TrailModule mesh.
      const geometry:ParticleMeshGeometry={positions:[],uv:[],indices:[],colors:[]};
      for(let i=0;i<capacity;i++) {
        geometry.positions.push([0,0,0],[0,0,0]);geometry.uv.push([0,0],[0,1]);geometry.colors!.push([1,1,1,1],[1,1,1,1]);
        if(i>0){const n=i*2;geometry.indices.push(n-2,n-1,n,n,n-1,n+1);}
      }
      view.geometry=geometry;view.lengths=new Array<number>(capacity).fill(0);view.capacity=capacity;view.mesh=new OriginalParticleMesh(sprite,geometry);
    }
    return view;
  }
  private renderTrail(p:GradeParticle,view:GradeView,pose:ParticlePose):void {
    const trail=p.spec.trail!,points=p.trail,count=points.length+1,geometry=view.geometry!,lengths=view.lengths!;
    // The live particle is the ribbon's final point. Keep the source samples and
    // all vertex/UV/color tuples in place instead of rebuilding them each frame.
    lengths[0]=0;
    for(let i=1;i<count;i++) {
      const at=i<points.length?points[i]:p,previous=points[i-1];
      lengths[i]=lengths[i-1]+Math.hypot(at.x-previous.x,at.y-previous.y,at.z-previous.z);
    }
    const total=lengths[count-1]||1,color=trail.colorOverLifetime.maxColor,end=trail.colorOverTrail.maxColor;
    const red=color.r*end.r,green=color.g*end.g,blue=color.b*end.b,alpha=color.a*end.a;
    for(let i=0;i<view.capacity;i++) {
      const index=Math.min(i,count-1),previousIndex=Math.max(0,index-1),nextIndex=Math.min(count-1,index+1);
      const at=index<points.length?points[index]:p,previous=previousIndex<points.length?points[previousIndex]:p,next=nextIndex<points.length?points[nextIndex]:p;
      const dx=next.x-previous.x,dy=next.y-previous.y,dz=next.z-previous.z;
      const x=C.rightX*dx+C.rightZ*dz,y=C.upX*dx+C.upY*dy+C.upZ*dz,norm=Math.hypot(x,y)||1;
      const fraction=lengths[index]/total;
      const width=evaluateParticleCurve(trail.width,1-fraction,p.random)*(trail.sizeAffectsWidth?pose.width:1)*.5;
      const nx=-y/norm*width,ny=x/norm*width;
      const worldX=C.rightX*nx+C.upX*ny,worldY=C.upY*ny,worldZ=C.rightZ*nx+C.upZ*ny;
      for(let side=0;side<2;side++) {
        const offset=i*2+side,sign=side===0?-1:1;
        const position=geometry.positions[offset],uv=geometry.uv[offset],tint=geometry.colors![offset];
        position[0]=at.x+worldX*sign;position[1]=at.y+worldY*sign;position[2]=at.z+worldZ*sign;
        uv[0]=fraction;uv[1]=side;
        tint[0]=red;tint[1]=green;tint[2]=blue;tint[3]=alpha;
      }
    }
    view.node.active=count>1;view.mesh!.update(IDENTITY);view.mesh!.setTint(trail.inheritParticleColor?pose.color:WHITE);
  }
  private sheetFrame(s:GradeParticleSpec,index:number):SpriteFrame {
    const sheet=s.textureSheet!,key=s.image.path+':'+index,existing=this.frames.get(key);if(existing)return existing;
    const original=this.art.frames.get(s.image.path)!,width=s.image.sizePx[0]/sheet.tilesX,height=s.image.sizePx[1]/sheet.tilesY;
    const frame=new SpriteFrame();frame.reset({texture:original.texture,rect:new Rect(index%sheet.tilesX*width,Math.floor(index/sheet.tilesX)*height,width,height),originalSize:new Size(width,height)});
    frame.packable=false;this.frames.set(key,frame);return frame;
  }
}
function colorByte(n:number):number{return Math.round(Math.max(0,Math.min(1,n))*255);}
