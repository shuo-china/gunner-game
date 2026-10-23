import { Node, Rect, Size, SpriteFrame } from 'cc';
import { CollisionWall, TreeState, Vec2 } from '../core/types';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { MoneyBurstConfig, MoneyBurstSimulation, MoneyParticlePose } from './MoneyBurstSimulation';
import { OrderedQuadBatch } from './OrderedQuadBatch';
export type { MoneyBurstConfig } from './MoneyBurstSimulation';

export async function loadOriginalMoneyBurst(art:ArtLibrary):Promise<MoneyBurstConfig> {
  const config=await art.json<MoneyBurstConfig>('art/effects/money-burst/config');
  const atlas=await art.loadFrame(config.atlas.path);
  // Frame rects below use the source texture directly, so keep it out of atlases.
  atlas.packable=false;
  return config;
}

/** Shared Default/order0 world effect, surviving the tree node's deactivation. */
export class OriginalMoneyBurst {
  private readonly node:Node;
  private readonly simulation:MoneyBurstSimulation;
  private readonly frames:SpriteFrame[]=[];
  private readonly batch:OrderedQuadBatch;
  private readonly pose:MoneyParticlePose={x:0,y:0,size:0,angle:0};
  private disposed=false;
  constructor(art:ArtLibrary,parent:Node,private readonly config:MoneyBurstConfig) {
    this.node=makeNode('MoneyBurst_Default0',parent);
    this.batch=new OrderedQuadBatch(art,this.node,'MoneyQuads');
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
  // Particle_Polling.Spawn only emits; update submits all this frame's bursts.
  spawn(position:Vec2,sourceTime?:number):void {if(!this.disposed)this.simulation.spawn(position,sourceTime);}
  setWalls(walls:readonly CollisionWall[]):void {this.simulation.setWalls(walls);}
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
    this.batch.destroy();
    for(const frame of this.frames.splice(0))frame.destroy();
  }
  private render():void {
    this.batch.begin();
    for(let i=0;i<this.simulation.particles.length;i++) {
      const p=this.simulation.particles[i];if(!p.active)continue;
      const pose=this.simulation.pose(p,this.pose);
      this.batch.add(this.frames[p.frame],pose.x,pose.y,pose.size,pose.size,
        this.config.atlas.anchor[0],this.config.atlas.anchor[1],pose.angle);
    }
    this.batch.end();
  }
}
