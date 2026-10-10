import { Node, Rect, Size, Sprite, SpriteFrame, UITransform } from 'cc';
import { TreeState, Vec2 } from '../core/types';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { MoneyBurstConfig, MoneyBurstSimulation, MoneyParticlePose } from './MoneyBurstSimulation';
export type { MoneyBurstConfig } from './MoneyBurstSimulation';

export async function loadOriginalMoneyBurst(art:ArtLibrary):Promise<MoneyBurstConfig> {
  const config=await art.json<MoneyBurstConfig>('art/effects/money-burst/config');
  const atlas=await art.loadFrame(config.atlas.path);
  // Nine fractional UV cells of the original 128px atlas must not be repacked.
  atlas.packable=false;
  return config;
}

interface ParticleView {node:Node;sprite:Sprite;transform:UITransform;frame:number}

/** Shared Default/order0 world effect, surviving the tree node's deactivation. */
export class OriginalMoneyBurst {
  private readonly node:Node;
  private readonly simulation:MoneyBurstSimulation;
  private readonly frames:SpriteFrame[]=[];
  private readonly views:ParticleView[]=[];
  private readonly pose:MoneyParticlePose={x:0,y:0,size:0,angle:0};
  private disposed=false;
  constructor(private readonly art:ArtLibrary,parent:Node,private readonly config:MoneyBurstConfig) {
    this.node=makeNode('MoneyBurst_Default0',parent);
    this.simulation=new MoneyBurstSimulation(config);
    // Own generated frames even if the enclosing BattlefieldView constructor
    // fails before Bootstrap can receive its instance and call destroy().
    this.node.once(Node.EventType.NODE_DESTROYED,this.releaseFrames,this);
    try {
      const atlas=art.frames.get(config.atlas.path)!;
      const [columns,rows]=config.tiles,w=config.atlas.sizePx[0]/columns,h=config.atlas.sizePx[1]/rows;
      for(let i=0;i<columns*rows;i++) {
        const frame=new SpriteFrame();this.frames.push(frame);
        frame.reset({texture:atlas.texture,rect:new Rect((i%columns)*w,Math.floor(i/columns)*h,w,h),originalSize:new Size(w,h)});
        frame.packable=false;
      }
    } catch(error) {
      this.destroy();throw error;
    }
  }
  spawn(position:Vec2,sourceTime?:number):void {if(!this.disposed){this.simulation.spawn(position,sourceTime);this.render();}}
  update(dt:number,trees:readonly TreeState[],frameTime?:number):void {if(!this.disposed){this.simulation.update(dt,trees,frameTime);this.render();}}
  reset(seed?:number):void {if(!this.disposed){this.simulation.reset(seed);this.render();}}
  diagnostics():{active:number;pooled:number} {return this.simulation.diagnostics();}
  destroy():void {
    this.releaseFrames();
    if(this.node.isValid)this.node.destroy();
  }
  private releaseFrames():void {
    if(this.disposed)return;
    this.disposed=true;this.simulation.reset();
    for(const frame of this.frames.splice(0))frame.destroy();
  }
  private render():void {
    for(let i=0;i<this.simulation.particles.length;i++) {
      const p=this.simulation.particles[i];let view=this.views[i];
      if(!view) {
        const node=this.art.image(`Money_${i}`,this.config.atlas,this.node),sprite=node.getComponent(Sprite)!;
        sprite.trim=false;
        // The shared linear sprite material already uses SRC_ALPHA /
        // ONE_MINUS_SRC_ALPHA, exactly as the source Money_mat.
        view={node,sprite,transform:node.getComponent(UITransform)!,frame:-1};this.views.push(view);
      }
      view.node.active=p.active;if(!p.active)continue;
      if(view.frame!==p.frame){view.sprite.spriteFrame=this.frames[p.frame];view.frame=p.frame;}
      const pose=this.simulation.pose(p,this.pose);
      view.node.setPosition(pose.x,pose.y,0);view.node.angle=pose.angle;
      view.transform.setContentSize(pose.size,pose.size);
    }
  }
}
