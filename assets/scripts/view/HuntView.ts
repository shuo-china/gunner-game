import { Color, gfx, Graphics, Node, Sprite, UITransform } from 'cc';
import { DecimalAmount, projectWorld } from '../core';
import type { BulletState, Vec2 } from '../core';
import type { HuntCombat, HuntMonster } from '../core/HuntCombat';
import { CAMERA_BASIS } from '../core/projection';
import { ArtLibrary, ImageSpec, makeNode } from './ArtLibrary';
import { originalBounceScale } from './OriginalFeedbackMath';
import { OriginalParticleMesh } from './OriginalParticleMesh';
import { OriginalParticleSimulation, ParticlePose, ParticleSpec } from './OriginalParticleSimulation';
import type { OriginalMapView } from './OriginalMapView';

interface Transform { position: number[]; scale: number[]; rotation: number[]; source: string; }
interface Renderer { image: ImageSpec; transform: Transform; color: number[]; order: number; }
interface Disc { transform: Transform; source: { radius: number; thickness: number; color: { r: number; g: number; b: number; a: number } }; }
export interface HuntVisualConfig {
  version: number;
  ground: ImageSpec & { transform: Transform; tiling: [number, number]; clipRadius: number };
  innerGround: Renderer; monsterSprites: ImageSpec[]; monsterColors: number[][];
  monster: { root: Transform; plane: Transform; sprite: Transform; health: Renderer; healthFill: Renderer;
    spawnBounce: { WantSize: number; _upSizeTime: number; Middle_value: number };
    hitBounce: { WantSize: { x: number; y: number; z: number }; _upSizeTime: number } };
  barrier: { transform: Transform; ring: Disc; fill: Disc };
  barrierParticles: ParticleSpec[]; deathParticles: ParticleSpec[]; worldOrigin: number[];
}
interface MonsterView {
  node: Node; sprite: Node; health: Node; fill: Node; generation: number; skin: number;
  spawnElapsed: number; hitElapsed: number; hitYield: boolean; healthRevealed: boolean; depth: number;
}

/** Source Monster sprites are billboards, with independent spawn/hit springs.
 * Pool generation is authoritative: consecutive small stages reuse the world. */
export class HuntView {
  private readonly config: HuntVisualConfig;
  private readonly environment: Node;
  private readonly monsters = new Map<number, MonsterView>();
  private readonly pendingHits = new Map<number, number>();
  private readonly barrierParticles: HuntParticles;
  private readonly deathParticles: HuntParticles;
  private readonly ring: Graphics;
  private readonly ringFill: Graphics;
  private active = true;
  private lastHp = NaN;

  constructor(private readonly art: ArtLibrary, private readonly hunt: HuntCombat,
    private readonly parent: Node, map: OriginalMapView, private readonly healthParent: Node,
    private readonly fillParent: Node, layer: (order: number) => Node) {
    this.config = art.catalog.hunt;
    if (!this.config || this.config.monsterSprites.length !== 20) throw new Error('Missing original Hunt artwork');
    // Insert inside the map before the actor-shadow band, preserving -39..-35.
    this.environment = makeNode('OriginalHuntEnvironment', map.node); this.environment.setSiblingIndex(1);
    const layers = new Map<number, Node>();
    const environmentLayer = (order: number): Node => {
      let node = layers.get(order);
      if (!node) { node = makeNode(`HuntGround_Order${order}`, this.environment); layers.set(order, node);
        Array.from(layers.keys()).sort((a,b)=>a-b).forEach((key,i)=>layers.get(key)!.setSiblingIndex(i)); }
      return node;
    };
    const ground = this.config.innerGround;
    const inner = art.image('OriginalHuntInnerGround', { ...ground.image, color: ground.color as [number,number,number,number] }, environmentLayer(ground.order));
    map.configureOverlayGround(inner, ground.image);
    applyPlane(inner, ground.transform, this.origin);
    this.ring = makeNode('BarrierHP_Background', environmentLayer(-36)).addComponent(Graphics);
    this.ringFill = makeNode('BarrierHP_Fill', environmentLayer(-35)).addComponent(Graphics);
    if (art.linearGraphicsMaterial) for (const graphics of [this.ring, this.ringFill]) {
      (graphics as Graphics & {srcBlendFactor:gfx.BlendFactor}).srcBlendFactor=gfx.BlendFactor.ONE;
      graphics.customMaterial=art.linearGraphicsMaterial;
    }
    this.barrierParticles = new HuntParticles(art, this.config.barrierParticles, environmentLayer, this.origin);
    // Particle_Polling.Spawn sets the particle root to Monster.transform.position.
    const death = this.config.deathParticles.map(spec => ({ ...spec,
      sourceTransform: spec.sourceTransform ? { ...spec.sourceTransform, position: [0,0,0] as [number,number,number] } : undefined }));
    this.deathParticles = new HuntParticles(art, death, layer);
    this.update(0);
  }
  private get origin(): Vec2 { return { x: this.config.worldOrigin[0], z: this.config.worldOrigin[2] }; }
  get renderGroups(): {node: Node; depth: number}[] { return Array.from(this.monsters.values()).map(view => ({ node: view.node, depth: view.depth })); }
  hit(id: number): void {
    const monster = this.hunt.enemies.find(enemy => enemy.id === id);
    if (monster) this.pendingHits.set(id, monster.spawnGeneration);
  }
  die(id: number, position: Vec2): void {
    const state = this.hunt.enemies.find(enemy => enemy.id === id);
    this.deathParticles.hit(position, this.config.monsterColors[Math.floor((state?.skinIndex ?? this.hunt.wave * 2) / 2) % 10]);
  }
  update(dt: number): void {
    if (!this.active) return;
    const elapsed = Math.max(0, Number.isFinite(dt) ? dt : 0);
    this.barrierParticles.update(elapsed); this.deathParticles.update(elapsed);
    if (this.lastHp !== this.hunt.barrierHp) { this.lastHp = this.hunt.barrierHp; this.drawDisc(this.ring, this.config.barrier.ring, 1); this.drawDisc(this.ringFill, this.config.barrier.fill, this.lastHp); }
    for (const state of this.hunt.enemies) {
      let view = this.monsters.get(state.id);
      if (!view && !state.alive) continue;
      if (!view) { view = this.createMonster(state); this.monsters.set(state.id, view); }
      if (view.generation !== state.spawnGeneration) {
        view.generation = state.spawnGeneration; view.spawnElapsed = 0; view.hitElapsed = Infinity; view.hitYield = false; view.healthRevealed = false;
      } else view.spawnElapsed += elapsed;
      if (this.pendingHits.has(state.id)) {
        if (this.pendingHits.get(state.id) === state.spawnGeneration) {
          view.healthRevealed=true;view.hitYield=!Number.isFinite(view.hitElapsed);view.hitElapsed=0;
        }
        this.pendingHits.delete(state.id);
      }
      view.node.active = state.alive; view.health.active = view.fill.active = state.alive && view.healthRevealed;
      if (!state.alive) continue;
      if (view.skin !== state.skinIndex) {
        view.skin = state.skinIndex; const image = this.config.monsterSprites[state.skinIndex];
        view.sprite.getComponent(Sprite)!.spriteFrame = this.art.frames.get(image.path)!;
        view.sprite.getComponent(UITransform)!.setContentSize(...image.sizeUnits); view.sprite.getComponent(UITransform)!.setAnchorPoint(...image.anchor);
      }
      const spawn = this.config.monster.spawnBounce;
      const split = spawn._upSizeTime * spawn.Middle_value, time = view.spawnElapsed;
      const spawnScale = time < split ? spawn.WantSize * time / split : time < spawn._upSizeTime ?
        spawn.WantSize + (1-spawn.WantSize)*(time-split)/(spawn._upSizeTime-split) : 1;
      if (view.hitYield) view.hitYield = false; else view.hitElapsed += elapsed;
      const hit = this.config.monster.hitBounce;
      const bounce = Number.isFinite(view.hitElapsed) ? originalBounceScale(view.hitElapsed, hit._upSizeTime, [hit.WantSize.x,hit.WantSize.y]) : {x:1,y:1};
      if (view.hitElapsed > hit._upSizeTime) view.hitElapsed = Infinity;
      const scale = this.config.monster.root.scale[0] * state.visualScale * spawnScale;
      const position = projectWorld(state.position); view.node.setPosition(position.x,position.y,0);
      const plane = this.config.monster.plane;
      applyPlane(view.sprite, { ...plane, scale: [scale*bounce.x,scale*bounce.y,scale] }, {x:0,z:0});
      const image = this.config.monsterSprites[state.skinIndex];
      const center = rotate(plane.rotation, [(0.5-image.anchor[0])*image.sizeUnits[0]*scale*bounce.x,
        (0.5-image.anchor[1])*image.sizeUnits[1]*scale*bounce.y,0]);
      view.depth = (state.position.x+center[0])*CAMERA_BASIS.forwardX + center[1]*CAMERA_BASIS.forwardY + (state.position.z+center[2])*CAMERA_BASIS.forwardZ;
      const health = this.config.monster.health.transform, rootScale = this.config.monster.root.scale[0];
      const healthTransform = { ...health, position: health.position.map(v=>v*rootScale), scale: health.scale.map(v=>v*rootScale) };
      applyPlane(view.health, healthTransform, state.position); applyPlane(view.fill, healthTransform, state.position);
      view.fill.getComponent(Sprite)!.fillRange = state.health.ratio(state.maxHealth);
    }
  }
  setActive(active: boolean): void {
    this.active = active; this.environment.active = active; this.deathParticles.setActive(active);
    for (const view of this.monsters.values()) { view.node.active = view.health.active = view.fill.active = false; }
    if (active) this.update(0);
  }
  destroy(): void {
    this.barrierParticles.destroy(); this.deathParticles.destroy();
    for (const view of this.monsters.values()) { view.node.destroy(); view.health.destroy(); view.fill.destroy(); }
    this.monsters.clear(); this.pendingHits.clear(); this.environment.destroy();
  }
  private createMonster(state: HuntMonster): MonsterView {
    const node = makeNode(`OriginalMonster_${state.id}`,this.parent), monster = this.config.monster;
    const sprite = this.art.image('MonsterSprite',this.config.monsterSprites[state.skinIndex],node);
    const health = this.art.image('MonsterHealth',monster.health.image,this.healthParent);
    const fill = this.art.image('MonsterHealthFill',{...monster.healthFill.image,color:monster.healthFill.color as [number,number,number,number]},this.fillParent);
    const renderer = fill.getComponent(Sprite)!;
    if (this.art.originalHealthFillMaterial) { (renderer as any).srcBlendFactor=gfx.BlendFactor.ONE; renderer.customMaterial=this.art.originalHealthFillMaterial; }
    renderer.type=Sprite.Type.FILLED; renderer.fillType=Sprite.FillType.HORIZONTAL; renderer.fillStart=0;
    return {node,sprite,health,fill,generation:-1,skin:state.skinIndex,spawnElapsed:0,hitElapsed:Infinity,hitYield:false,healthRevealed:false,depth:0};
  }
  private drawDisc(graphics: Graphics, disc: Disc, fraction: number): void {
    graphics.clear(); if (!(fraction>0)) return;
    const c=disc.source.color; graphics.fillColor=new Color(c.r*255,c.g*255,c.b*255,c.a*255);
    const scale=this.config.barrier.transform.scale[0]*this.config.barrier.ring.transform.scale[0];
    const radius=disc.source.radius*scale, half=disc.source.thickness*scale/2;
    const angle=Math.atan2(2*disc.transform.rotation[2]*disc.transform.rotation[3],1-2*disc.transform.rotation[2]**2);
    const segments=Math.ceil(128*Math.min(1,fraction)),end=2*Math.PI*Math.min(1,fraction);
    const point=(i:number,r:number)=>projectWorld({x:this.origin.x+Math.cos(angle+end*i/segments)*r,z:this.origin.z+Math.sin(angle+end*i/segments)*r});
    for(let i=0;i<=segments;i++){const p=point(i,radius+half);if(i)graphics.lineTo(p.x,p.y);else graphics.moveTo(p.x,p.y);}
    for(let i=segments;i>=0;i--){const p=point(i,radius-half);graphics.lineTo(p.x,p.y);}graphics.close();graphics.fill();
  }
}

/** Uses the shared source particle simulator and mesh adapter, including the
 * authored vertical aura mesh; no replacement circle sprites or generated art. */
class HuntParticles {
  private readonly simulation: OriginalParticleSimulation;
  private readonly views: {node:Node;sprite:Sprite;transform:UITransform;mesh?:OriginalParticleMesh}[]=[];
  private readonly emitter?: BulletState;
  private readonly pose:ParticlePose={x:0,y:0,width:0,height:0,angle:0,color:[]};
  private active=true;
  constructor(art:ArtLibrary,specs:ParticleSpec[],layer:(order:number)=>Node,origin?:Vec2) {
    this.simulation=new OriginalParticleSimulation(specs);
    if(origin)this.emitter={id:-10,active:true,damaging:true,position:{...origin},previousPosition:{...origin},direction:{x:0,z:1},age:0,life:Infinity,
      trailTime:0,traveled:0,damage:DecimalAmount.from(0),actorId:0,weaponId:0,weaponType:'SINGLE',critical:false,volleyId:0,pelletIndex:0,height:0,speed:0,
      explosionRadius:0,hitIds:[],pierceCount:0,hasExploded:false,hasEnemyImpactFx:false,missileStart:null,missileTarget:null,missileDuration:0,missileArcHeight:0};
    for(const particle of this.simulation.particles){
      const spec=particle.spec,node=art.image(`Hunt_${spec.name}_${particle.index}`,spec.image,layer(spec.sortingOrder)),sprite=node.getComponent(Sprite)!;
      const blend=sprite as any;blend.srcBlendFactor=spec.blend.source===1?gfx.BlendFactor.ONE:gfx.BlendFactor.SRC_ALPHA;
      blend._dstBlendFactor=spec.blend.destination===0?gfx.BlendFactor.ZERO:spec.blend.destination===1?gfx.BlendFactor.ONE:gfx.BlendFactor.ONE_MINUS_SRC_ALPHA;
      blend.updateMaterial();node.active=false;
      this.views.push({node,sprite,transform:node.getComponent(UITransform)!,mesh:spec.mesh?new OriginalParticleMesh(sprite,spec.mesh):undefined});
    }
  }
  hit(position:Vec2,color:number[]):void {
    const before=new Set(this.simulation.particles.filter(p=>p.active)); this.simulation.hit(position,0,0);
    for(const particle of this.simulation.particles)if(particle.active&&!before.has(particle))particle.tint=color.map(v=>v/255);
    this.render();
  }
  update(dt:number):void {if(!this.active)return;if(this.emitter)this.emitter.age+=dt;this.simulation.update(dt,this.emitter?[this.emitter]:[]);this.render();}
  setActive(active:boolean):void{this.active=active;this.render();}
  destroy():void{this.simulation.reset();for(const view of this.views)view.node.destroy();}
  private render():void {
    for(const particle of this.simulation.particles){const view=this.views[particle.index];view.node.active=this.active&&particle.active;if(!view.node.active)continue;
      const pose=this.simulation.pose(particle,this.pose);
      if(view.mesh&&pose.mesh)view.mesh.update(pose.mesh);else{view.node.setPosition(pose.x,pose.y,0);view.node.angle=pose.angle;view.transform.setContentSize(pose.width,pose.height);}
      const c=pose.color;view.sprite.color=new Color(...c.map(v=>Math.round(Math.max(0,Math.min(1,v))*255)) as [number,number,number,number]);view.mesh?.setTint(c);
    }
  }
}

function applyPlane(node:Node,transform:Transform,origin:Vec2):void {
  const u=rotate(transform.rotation,[transform.scale[0],0,0]),v=rotate(transform.rotation,[0,transform.scale[1],0]);
  const a=projectWorld({x:u[0],z:u[2]},u[1]),b=projectWorld({x:v[0],z:v[2]},v[1]);
  const p=projectWorld({x:origin.x+transform.position[0],z:origin.z+transform.position[2]},transform.position[1]);
  node.setPosition(p.x,p.y,0);node.angle=Math.atan2(a.y,a.x)*180/Math.PI;
  node.setScale(Math.hypot(a.x,a.y),(a.x*b.y-a.y*b.x<0?-1:1)*Math.hypot(b.x,b.y),1);
}
function rotate([x,y,z,w]:number[],[vx,vy,vz]:number[]):number[]{
  return [(1-2*(y*y+z*z))*vx+2*(x*y-z*w)*vy+2*(x*z+y*w)*vz,
    2*(x*y+z*w)*vx+(1-2*(x*x+z*z))*vy+2*(y*z-x*w)*vz,
    2*(x*z-y*w)*vx+2*(y*z+x*w)*vy+(1-2*(x*x+y*y))*vz];
}
