import { Color, gfx, Node, Sprite, UITransform } from 'cc';
import { BulletState } from '../core';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalParticleSimulation, ParticlePose } from './OriginalParticleSimulation';

interface ParticleView {node:Node;sprite:Sprite;transform:UITransform}

/** All original pistol layers: trail glow, sparks, orange shell, white core,
 * impact glow, and impact sparks. Each keeps its own material and source order.
 */
export class OriginalProjectiles {
  private readonly simulation:OriginalParticleSimulation;
  private readonly views:ParticleView[]=[];
  private readonly pose:ParticlePose={x:0,y:0,width:0,height:0,angle:0,color:[]};
  private readonly color=new Color();
  constructor(art:ArtLibrary,parent:Node,layerForOrder?:(order:number)=>Node) {
    this.simulation=new OriginalParticleSimulation(art.catalog.feedback.particles.systems);
    const layers=new Map<number,Node>();
    for(const p of this.simulation.particles) {
      let layer=layers.get(p.spec.sortingOrder);
      if(!layer){layer=layerForOrder?.(p.spec.sortingOrder)??makeNode(`Default_Order${p.spec.sortingOrder}`,parent);layers.set(p.spec.sortingOrder,layer);}
      const node=art.image(`${p.spec.kind}_${p.spec.name}_${p.index}`,p.spec.image,layer);
      const sprite=node.getComponent(Sprite)!;
      // Source Unity materials use SRC_ALPHA with ONE or ONE_MINUS_SRC_ALPHA.
      // Creator 3.8.8 has no public destination setter; use its material update
      // path, as in OriginalMuzzleEffect.
      (sprite as any).srcBlendFactor=gfx.BlendFactor.SRC_ALPHA;
      (sprite as any)._dstBlendFactor=p.spec.blend.destination===1?gfx.BlendFactor.ONE:gfx.BlendFactor.ONE_MINUS_SRC_ALPHA;
      (sprite as any).updateMaterial();
      node.active=false;
      this.views.push({node,sprite,transform:node.getComponent(UITransform)!});
    }
  }
  shot(id:number):void {this.simulation.shot(id);}
  hit(position:{x:number;z:number}):void {this.simulation.hit(position);this.render();}
  update(dt:number,bullets:readonly BulletState[]):void {this.simulation.update(dt,bullets);this.render();}
  reset():void {this.simulation.reset();this.render();}
  private render():void {
    for(const p of this.simulation.particles) {
      const view=this.views[p.index];view.node.active=p.active;if(!p.active)continue;
      const pose=this.simulation.pose(p,this.pose);
      view.node.setPosition(pose.x,pose.y,0);view.node.angle=pose.angle;
      view.transform.setContentSize(pose.width,pose.height);
      const c=pose.color;
      this.color.set(colorByte(c[0]),colorByte(c[1]),colorByte(c[2]),colorByte(c[3]));
      // UIRenderer.color copies its input in Creator 3.8.8, so one scratch
      // Color is safe across all sprites and still triggers dirty updates.
      view.sprite.color=this.color;
    }
  }
}

function colorByte(value:number):number{return Math.round(Math.max(0,Math.min(1,value))*255);}
