import { Color, Graphics, Node, UITransform } from 'cc';
import { ConfettiRecord, OriginalConfettiSimulation } from './OriginalWeaponConfettiMath';

interface ConfettiUi { node(key:string):Node; }
interface EmitterView { node:Node; graphic:Graphics; trail?:Graphics; }

/** The original ParticleImage success effect uses untextured colored rectangles.
 * Keep its RectTransform hierarchy and draw the actual projected four corners. */
export class OriginalWeaponConfetti {
  readonly simulation:OriginalConfettiSimulation;
  private readonly views:EmitterView[];
  private readonly ownedNodes:Node[]=[];
  constructor(ui:ConfettiUi,records:readonly ConfettiRecord[],rng:()=>number=Math.random){
    this.simulation=new OriginalConfettiSimulation(records,rng);
    const graphic=(parent:Node,name:string)=>{
      const node=new Node(name);parent.addChild(node);node.addComponent(UITransform);this.ownedNodes.push(node);
      return node.addComponent(Graphics);
    };
    this.views=records.map(record=>{
      const node=ui.node(record.node),source=record.source;
      const trail=source._trailModule.enabled&&source._particleTrailRenderer.m_PathID?
        graphic(ui.node(`level0:${source._particleTrailRenderer.m_PathID}`),'OriginalConfettiTrail'):undefined;
      return {node,graphic:graphic(node,'OriginalConfettiParticles'),trail};
    });
  }
  play():void{this.syncTransforms();this.simulation.play();this.render();}
  clear():void{this.simulation.clear();this.views.forEach(v=>{v.graphic.clear();v.trail?.clear();});}
  destroy():void{this.clear();this.ownedNodes.forEach(node=>node.destroy());}
  update(dt:number):void{
    if(!this.simulation.playing)return;
    this.syncTransforms();this.simulation.update(dt);this.render();
  }
  private syncTransforms():void{
    this.views.forEach((view,i)=>{
      const emitter=this.simulation.emitters[i];emitter.width=view.node.getComponent(UITransform)!.width;
      let angle=0;for(let node:Node|null=view.node;node;node=node.parent)angle+=node.angle;
      emitter.worldAngle=angle;
    });
  }
  private render():void{
    this.views.forEach((view,i)=>{
      const emitter=this.simulation.emitters[i];view.graphic.clear();view.trail?.clear();
      for(const particle of emitter.particles){
        if(view.trail)for(const trail of this.simulation.trail(emitter,particle))this.polygon(view.trail,trail.corners,trail.color);
        if(particle.age<particle.life){const pose=this.simulation.pose(emitter,particle);this.polygon(view.graphic,pose.corners,pose.color);}
      }
    });
  }
  private polygon(graphic:Graphics,corners:number[][],rgba:number[]):void{
    if(rgba[3]<=0)return;
    graphic.fillColor=new Color(...rgba.map(v=>Math.round(Math.max(0,Math.min(1,v))*255)) as [number,number,number,number]);
    graphic.moveTo(corners[0][0],corners[0][1]);
    for(let i=1;i<corners.length;i++)graphic.lineTo(corners[i][0],corners[i][1]);
    graphic.close();graphic.fill();
  }
}
