import { Color, gfx, Node, Rect, Size, Sprite, SpriteFrame, UITransform } from 'cc';
import { BulletState } from '../core';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalParticleSimulation, ParticlePose, ParticleSpec } from './OriginalParticleSimulation';
import { OriginalParticleMesh } from './OriginalParticleMesh';
import type { ParticleCollisionBox } from './OriginalParticleExtraMotion';
import { CustomProjectiles } from './CustomProjectiles';

interface ParticleView {node:Node;sprite:Sprite;transform:UITransform;mesh?:OriginalParticleMesh;frame?:number}
interface SkinView {
  key:string; simulation:OriginalParticleSimulation; views:ParticleView[];
  bullets:BulletState[]; idleSeconds:number; prepared:boolean;
  custom?:CustomProjectiles;
}
interface BlendSprite {srcBlendFactor:number;_dstBlendFactor:number;updateMaterial():void}

/** Source skins are shared by gun IDs; live emitter state stays separate.
 * Only used skins allocate particles, and idle pools are retired after switching. */
export class OriginalProjectiles {
  private readonly skins=new Map<string,SkinView>();
  private readonly emitterSkins=new Map<number,string>();
  private readonly layers=new Map<number,Node>();
  private readonly sheetFrames=new Map<string,SpriteFrame>();
  private readonly preparedSkins=new Set<string>();
  private colliders:readonly ParticleCollisionBox[]=[];
  private readonly pose:ParticlePose={x:0,y:0,width:0,height:0,angle:0,color:[]};
  private readonly color=new Color();
  constructor(private readonly art:ArtLibrary,private readonly parent:Node,
    private readonly layerForOrder?:(order:number)=>Node) {}

  /** Allocate the equipped skins while entering battle / changing equipment.
   * No shot, particle emission, random sampling or simulation time advances. */
  prepareWeapons(weaponIds:readonly number[]):void {
    this.preparedSkins.clear();
    for(const id of weaponIds)this.preparedSkins.add(this.skinFor(id,true).key);
  }

  shot(id:number,weaponId=0):void {
    const skin=this.skinFor(weaponId),previous=this.emitterSkins.get(id);
    if(previous&&previous!==skin.key) {
      this.skins.get(previous)?.simulation.clearEmitter(id);
      this.skins.get(previous)?.custom?.clearEmitter(id);
    }
    this.emitterSkins.set(id,skin.key);skin.simulation.shot(id);skin.custom?.shot(id);skin.idleSeconds=0;
  }
  hitTrigger(weaponId:number):'impact'|'hit' {
    const library=this.art.weaponVisuals;if(!library)return 'impact';
    return library.config.customProjectiles?.[library.appearance(weaponId).projectileSkin]?.hitTrigger??'impact';
  }
  contact(id:number,weaponId:number,position:{x:number;z:number},height:number):void {
    this.skinFor(weaponId).custom?.contact(id,position,height);
  }
  hit(position:{x:number;z:number},weaponId=0,radius=0,height?:number):void {
    const skin=this.skinFor(weaponId);
    // Bootstrap drains every event before update: submit the final state once,
    // not the entire skin again for each impact in the same rendered frame.
    skin.simulation.hit(position,radius,height);skin.idleSeconds=0;
  }
  update(dt:number,bullets:readonly BulletState[]):void {
    for(const skin of this.skins.values())skin.bullets.length=0;
    for(const bullet of bullets)if(bullet.active)this.skinFor(bullet.weaponId??0).bullets.push(bullet);
    let usedSkins=0;
    for(const skin of this.skins.values())if(!skin.prepared)usedSkins++;
    for(const skin of this.skins.values()) {
      if(skin.prepared){
        skin.idleSeconds+=Math.max(0,dt);
        if(skin.idleSeconds>2&&!this.preparedSkins.has(skin.key))this.releaseSkin(skin);
        continue;
      }
      skin.simulation.update(dt,skin.bullets);skin.custom?.update(dt,skin.bullets);this.render(skin);
      const active=skin.bullets.length>0||skin.simulation.hasActiveParticles||skin.custom?.hasActiveParticles;
      skin.idleSeconds=active?0:skin.idleSeconds+Math.max(0,dt);
      // Merely preparing another weapon must not evict an old used pool early:
      // that would change its later first-use order and random sampling order.
      if(skin.idleSeconds>2&&usedSkins>3){this.releaseSkin(skin);usedSkins--;}
    }
  }
  reset():void {
    for(const skin of this.skins.values()){skin.simulation.reset();skin.custom?.reset();skin.bullets.length=0;this.render(skin);}
    this.emitterSkins.clear();
  }
  setColliders(colliders:readonly ParticleCollisionBox[]):void {
    this.colliders=colliders;
    for(const skin of this.skins.values())skin.simulation.setColliders(colliders);
  }
  destroy():void {
    for(const skin of this.skins.values())this.releaseSkin(skin);
    this.emitterSkins.clear();
    for(const frame of this.sheetFrames.values())frame.destroy();
    this.sheetFrames.clear();
    this.preparedSkins.clear();
  }
  diagnostics():{skins:number;pooled:number;active:number} {
    let pooled=0,active=0;
    for(const skin of this.skins.values()) {
      pooled+=skin.views.length;active+=skin.simulation.particles.filter(particle=>particle.active).length;
      const custom=skin.custom?.diagnostics();if(custom){pooled+=custom.pooled;active+=custom.active;}
    }
    return {skins:this.skins.size,pooled,active};
  }
  private skinFor(weaponId:number,prepare=false):SkinView {
    const library=this.art.weaponVisuals;
    const key=library?library.appearance(weaponId).projectileSkin:'pistol';
    const existing=this.skins.get(key);
    if(existing){
      if(existing.prepared&&!prepare){
        // Hidden preallocated nodes must not change transparent draw order:
        // commit their slots at the same first-use point as lazy creation.
        for(const view of existing.views)view.node.setSiblingIndex(view.node.parent!.children.length-1);
        existing.prepared=false;
        // Simulation random sampling follows first-use order, as it did when
        // skins were created lazily. Preparation itself must not reorder it.
        this.skins.delete(key);this.skins.set(key,existing);
      }
      return existing;
    }
    const specs:ParticleSpec[]=library?library.config.projectileSkins[key]:this.art.catalog.feedback.particles.systems;
    if(!specs)throw new Error('Missing projectile skin '+key);
    const simulation=new OriginalParticleSimulation(specs),views:ParticleView[]=[];
    simulation.setColliders(this.colliders);
    for(const particle of simulation.particles) {
      let layer=this.layers.get(particle.spec.sortingOrder);
      if(!layer) {
        layer=this.layerForOrder?.(particle.spec.sortingOrder)??makeNode('Default_Order'+particle.spec.sortingOrder,this.parent);
        this.layers.set(particle.spec.sortingOrder,layer);
      }
      const node=this.art.image(key+'_'+particle.spec.kind+'_'+particle.index,particle.spec.image,layer);
      const sprite=node.getComponent(Sprite)!;
      const blend=sprite as unknown as BlendSprite;
      blend.srcBlendFactor=particle.spec.blend.source===1?gfx.BlendFactor.ONE:gfx.BlendFactor.SRC_ALPHA;
      blend._dstBlendFactor=particle.spec.blend.destination===0?gfx.BlendFactor.ZERO:
        particle.spec.blend.destination===1?gfx.BlendFactor.ONE:gfx.BlendFactor.ONE_MINUS_SRC_ALPHA;
      blend.updateMaterial();node.active=false;
      const mesh=particle.spec.mesh;
      if(mesh&&!mesh.positions.length)throw new Error('Unresolved original particle mesh '+mesh.source);
      views.push({node,sprite,transform:node.getComponent(UITransform)!,mesh:mesh?new OriginalParticleMesh(sprite,mesh):undefined});
    }
    const profile=library?.config.customProjectiles?.[key];
    if(profile&&!library!.customProjectileEffect)throw new Error('Custom projectile material must load before rendering '+key);
    const custom=profile?new CustomProjectiles(this.art,profile,order=>{
      let layer=this.layers.get(order);
      if(!layer){layer=this.layerForOrder?.(order)??makeNode('Default_Order'+order,this.parent);this.layers.set(order,layer);}
      return layer;
    },library!.customProjectileEffect!):undefined;
    const skin:SkinView={key,simulation,views,bullets:[],idleSeconds:0,prepared:prepare,custom};this.skins.set(key,skin);return skin;
  }
  private releaseSkin(skin:SkinView):void {
    skin.simulation.reset();
    skin.custom?.destroy();
    for(const view of skin.views)if(view.node.isValid){view.node.active=false;view.node.destroy();}
    this.skins.delete(skin.key);
    for(const [id,key] of this.emitterSkins)if(key===skin.key)this.emitterSkins.delete(id);
  }
  private render(skin:SkinView):void {
    for(const particle of skin.simulation.particles) {
      const view=skin.views[particle.index];view.node.active=particle.active;if(!particle.active)continue;
      const pose=skin.simulation.pose(particle,this.pose);
      if(pose.frame!==undefined&&view.frame!==pose.frame) {
        view.sprite.spriteFrame=this.sheetFrame(particle.spec,pose.frame);view.frame=pose.frame;
      }
      if(view.mesh&&pose.mesh)view.mesh.update(pose.mesh);
      else {
        view.node.setPosition(pose.x,pose.y,0);view.node.angle=pose.angle;
        view.transform.setContentSize(pose.width,pose.height);
      }
      const c=pose.color;
      this.color.set(colorByte(c[0]),colorByte(c[1]),colorByte(c[2]),colorByte(c[3]));view.sprite.color=this.color;
      view.mesh?.setTint(pose.color);
    }
  }
  private sheetFrame(spec:ParticleSpec,index:number):SpriteFrame {
    const sheet=spec.textureSheet!,key=`${spec.image.path}:${sheet.tilesX}:${sheet.tilesY}:${index}`;
    const cached=this.sheetFrames.get(key);if(cached)return cached;
    const original=this.art.frames.get(spec.image.path)!;
    const width=spec.image.sizePx[0]/sheet.tilesX,height=spec.image.sizePx[1]/sheet.tilesY;
    // Unity's whole-sheet sequence starts at the top-left. Cocos Rect uses the
    // same bitmap origin; individual tiles retain the authored particle size.
    const frame=new SpriteFrame();frame.reset({texture:original.texture,
      rect:new Rect(index%sheet.tilesX*width,Math.floor(index/sheet.tilesX)*height,width,height),
      originalSize:new Size(width,height)});
    frame.packable=false;this.sheetFrames.set(key,frame);return frame;
  }
}
function colorByte(value:number):number{return Math.round(Math.max(0,Math.min(1,value))*255);}
