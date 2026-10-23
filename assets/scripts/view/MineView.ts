import { Color, gfx, Node, Rect, Size, Sprite, SpriteFrame, UITransform } from 'cc';
import { projectWorld } from '../core';
import { OriginalInfVal } from '../core/OriginalInfVal';
import type { OreState, Vec2 } from '../core';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { CAMERA_BASIS } from '../core/projection';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { DamageNumbers } from './DamageNumbers';
import { originalBounceScale } from './OriginalFeedbackMath';
import { OriginalParticleSimulation, ParticlePose, ParticleSpec } from './OriginalParticleSimulation';
import { OriginalParticleMesh } from './OriginalParticleMesh';
import type { MineTransform, MineVisualConfig } from './MineVisualAssets';

interface OreView { node: Node; sprite: Node; health?: Node; fill?: Node; hitElapsed: number; hitYield: boolean; depth: number; }

/** Source Ore billboards and original dust/font. BattlefieldView handles the
 * white hit numbers; each death adds its separate fractional diamond value. */
export class MineView {
  private readonly config: MineVisualConfig;
  private readonly views = new Map<number, OreView>();
  private readonly numbers: DamageNumbers;
  private readonly numberRoot: Node;
  private readonly particles: OriginalParticleSimulation;
  private readonly particleViews: {node:Node;sprite:Sprite;transform:UITransform;mesh?:OriginalParticleMesh;frame?:number}[] = [];
  private readonly sheetFrames = new Map<string, SpriteFrame>();
  private readonly particlePose: ParticlePose = { x:0,y:0,width:0,height:0,angle:0,color:[] };
  private active = true;
  constructor(private readonly art: ArtLibrary, private readonly ores: readonly OreState[], parent: Node,
    private readonly healthParent: Node, private readonly fillParent: Node, layer: (order: number) => Node) {
    this.config = art.catalog.mine;
    if (!this.config || this.config.version !== 1 || this.config.oreSprites.length !== 2) throw new Error('Missing original mine artwork');
    this.numberRoot = makeNode('OriginalMineDiamondNumbers', layer(1000));
    this.numbers = new DamageNumbers(art, this.numberRoot);
    this.particles = new OriginalParticleSimulation(this.config.dustParticles);
    for (const particle of this.particles.particles) {
      const spec = particle.spec, node = art.image(`MineDust_${particle.index}`, spec.image, layer(spec.sortingOrder));
      const sprite = node.getComponent(Sprite)!;
      const blend = sprite as any;
      blend.srcBlendFactor = spec.blend.source === 1 ? gfx.BlendFactor.ONE : gfx.BlendFactor.SRC_ALPHA;
      blend._dstBlendFactor = spec.blend.destination === 0 ? gfx.BlendFactor.ZERO : spec.blend.destination === 1 ? gfx.BlendFactor.ONE : gfx.BlendFactor.ONE_MINUS_SRC_ALPHA;
      blend.updateMaterial(); node.active = false;
      this.particleViews.push({ node, sprite, transform: node.getComponent(UITransform)!, mesh: spec.mesh ? new OriginalParticleMesh(sprite, spec.mesh) : undefined });
    }
    for (const ore of ores) {
      const node = makeNode(`OriginalOre_${ore.poolIndex}`, parent);
      const sprite = art.image('OreSprite', this.config.oreSprites[ore.rare ? 1 : 0], node);
      this.views.set(ore.id, { node, sprite, hitElapsed: Infinity, hitYield: false, depth: 0 });
    }
    this.update(0, 0);
  }
  get renderGroups(): {node:Node;depth:number}[] { return Array.from(this.views.values()).map(view => ({node:view.node,depth:view.depth})); }
  hit(id:number):void {
    const view = this.views.get(id); if (!view) return;
    view.hitYield = !Number.isFinite(view.hitElapsed); view.hitElapsed = 0;
    if (!view.health) {
      const ore = this.config.ore;
      view.health = this.art.image('OreHealth', { ...ore.health.image, color: ore.health.color as [number,number,number,number] }, this.healthParent);
      view.fill = this.art.image('OreHealthFill', { ...ore.healthFill.image, color: ore.healthFill.color as [number,number,number,number] }, this.fillParent);
      const fill = view.fill.getComponent(Sprite)!;
      if (this.art.originalHealthFillMaterial) { (fill as any).srcBlendFactor=gfx.BlendFactor.ONE; fill.customMaterial=this.art.originalHealthFillMaterial; }
      fill.type=Sprite.Type.FILLED;fill.fillType=Sprite.FillType.HORIZONTAL;fill.fillStart=0;
    }
  }
  die(position:Vec2,score:number,sourceTime:number):void {
    const config=this.config, height=config.ore.dustSpawn.position[1];
    this.particles.hit(position,0,height);
    const amount=OriginalInfVal.fromInt(score).toPrecision(17).div(ECONOMY_CONFIG.mine.scorePerDiamond).amount;
    this.numbers.spawnStyledText(position,config.diamondNumbers.height,`+${amount.scientificExponent<3?amount.toString():amount.format()}`,config.diamondNumbers,sourceTime);
  }
  update(dt:number,sourceTime:number):void {
    const elapsed=Math.max(0,Number.isFinite(dt)?dt:0);
    this.particles.update(elapsed,[]);this.numbers.update(elapsed,sourceTime);
    for (const particle of this.particles.particles) {
      const view=this.particleViews[particle.index];view.node.active=particle.active;if(!particle.active)continue;
      const pose=this.particles.pose(particle,this.particlePose);
      if(pose.frame!==undefined&&view.frame!==pose.frame){
        view.sprite.spriteFrame=this.sheetFrame(particle.spec,pose.frame);view.frame=pose.frame;
      }
      if(view.mesh&&pose.mesh)view.mesh.update(pose.mesh);else {view.node.setPosition(pose.x,pose.y,0);view.node.angle=pose.angle;view.transform.setContentSize(pose.width,pose.height);}
      const bytes=pose.color.map(value=>Math.round(Math.max(0,Math.min(1,value))*255));
      view.sprite.color=new Color(...bytes as [number,number,number,number]);view.mesh?.setTint(pose.color);
    }
    for (const ore of this.ores) {
      const view=this.views.get(ore.id)!;view.node.active=this.active&&ore.alive;
      if(view.health){view.health.active=view.fill!.active=this.active&&ore.alive;}
      if(!view.node.active)continue;
      if(view.hitYield)view.hitYield=false;else view.hitElapsed+=elapsed;
      const config=this.config.ore, hit=config.hitBounce;
      const bounce=Number.isFinite(view.hitElapsed)?originalBounceScale(view.hitElapsed,hit._upSizeTime,[hit.WantSize.x,hit.WantSize.y]):{x:1,y:1};
      if(view.hitElapsed>hit._upSizeTime)view.hitElapsed=Infinity;
      const root=config.root.scale[0], plane=config.plane;
      const position=projectWorld(ore.position);view.node.setPosition(position.x,position.y,0);
      const sx=root*plane.scale[0]*config.sprite.scale[0]*bounce.x,sy=root*plane.scale[1]*config.sprite.scale[1]*bounce.y;
      applyPlane(view.sprite,{...plane,scale:[sx,sy,root*config.sprite.scale[2]]},{x:0,z:0});
      const image=this.config.oreSprites[ore.rare?1:0];
      const center=rotate(plane.rotation,[(.5-image.anchor[0])*image.sizeUnits[0]*sx,(.5-image.anchor[1])*image.sizeUnits[1]*sy,0]);
      view.depth=(ore.position.x+center[0])*CAMERA_BASIS.forwardX+center[1]*CAMERA_BASIS.forwardY+(ore.position.z+center[2])*CAMERA_BASIS.forwardZ;
      if(view.health){
        const health=config.health.transform;
        // Slider is a sibling of the bouncing sprite, so it stays steady.
        applyPlane(view.health,health,ore.position);applyPlane(view.fill!,health,ore.position);
        view.fill!.getComponent(Sprite)!.fillRange=ore.health.ratio(ore.maxHealth);
      }
    }
  }
  setActive(active:boolean):void {this.active=active;for(const view of this.views.values()){view.node.active=false;if(view.health)view.health.active=view.fill!.active=false;}}
  clearTransientEffects():void {this.particles.reset();this.numbers.reset();for(const view of this.particleViews)view.node.active=false;}
  diagnostics():{activeOres:number;dust:number;numbers:number} {return {activeOres:this.ores.filter(ore=>ore.alive).length,dust:this.particles.particles.filter(p=>p.active).length,numbers:this.numbers.diagnostics().active};}
  destroy():void {
    this.particles.reset();this.numbers.reset();
    for(const view of this.views.values()){view.node.destroy();view.health?.destroy();view.fill?.destroy();}
    this.views.clear();for(const view of this.particleViews)view.node.destroy();this.numberRoot.destroy();
    for(const frame of this.sheetFrames.values())frame.destroy();this.sheetFrames.clear();
  }
  private sheetFrame(spec:ParticleSpec,index:number):SpriteFrame {
    const sheet=spec.textureSheet!,key=`${spec.image.path}:${sheet.tilesX}:${sheet.tilesY}:${index}`;
    const cached=this.sheetFrames.get(key);if(cached)return cached;
    const original=this.art.frames.get(spec.image.path)!;
    const width=spec.image.sizePx[0]/sheet.tilesX,height=spec.image.sizePx[1]/sheet.tilesY;
    // GibletExplodeDirt uses one tile of its 4x4 sheet, not the complete atlas.
    // Both Unity's whole-sheet sequence and Cocos Rect start at the top-left.
    const frame=new SpriteFrame();frame.reset({texture:original.texture,
      rect:new Rect(index%sheet.tilesX*width,Math.floor(index/sheet.tilesX)*height,width,height),
      originalSize:new Size(width,height)});
    frame.packable=false;this.sheetFrames.set(key,frame);return frame;
  }
}
function applyPlane(node:Node,transform:MineTransform,origin:Vec2):void {
  const u=rotate(transform.rotation,[transform.scale[0],0,0]),v=rotate(transform.rotation,[0,transform.scale[1],0]);
  const a=projectWorld({x:u[0],z:u[2]},u[1]),b=projectWorld({x:v[0],z:v[2]},v[1]);
  const p=projectWorld({x:origin.x+transform.position[0],z:origin.z+transform.position[2]},transform.position[1]);
  node.setPosition(p.x,p.y,0);node.angle=Math.atan2(a.y,a.x)*180/Math.PI;
  node.setScale(Math.hypot(a.x,a.y),(a.x*b.y-a.y*b.x<0?-1:1)*Math.hypot(b.x,b.y),1);
}
function rotate([x,y,z,w]:number[],[vx,vy,vz]:number[]):number[]{return [(1-2*(y*y+z*z))*vx+2*(x*y-z*w)*vy+2*(x*z+y*w)*vz,2*(x*y+z*w)*vx+(1-2*(x*x+z*z))*vy+2*(y*z-x*w)*vz,2*(x*z-y*w)*vx+2*(y*z+x*w)*vy+(1-2*(x*x+y*y))*vz];}
