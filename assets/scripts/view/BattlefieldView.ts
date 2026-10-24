import { PetView, PetVisualAssets } from './PetView';
import { Node } from 'cc';
import { CombatEvent, CombatWorld, getWeapon, MuzzleSampleContext, projectWorld, Vec2, WEAPON_CONFIG } from '../core';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { CatView } from './CatView';
import { CharacterAppearance } from './CharacterAppearance';
import { OriginalFeedbackConfig } from './OriginalFeedbackAssets';
import { OriginalMapDefinition, OriginalMapView } from './OriginalMapView';
import { TreeAppearance } from './TreeAppearance';
import { RaidBossView } from './RaidBossView';
import { BossView } from './BossView';
import { HuntView } from './HuntView';
import { MineView } from './MineView';
import { TargetReticle } from './TargetReticle';
import { DamageNumbers, MoneyNumberConfig } from './DamageNumbers';
import { OriginalProjectiles } from './OriginalProjectiles';
import { MoneyBurstConfig, OriginalMoneyBurst } from './OriginalMoneyBurst';
import type { TreeReward } from '../session/BattleSession';
import type { OriginalSfx } from './OriginalSfx';
import { OriginalImpactFxThrottle } from './OriginalImpactFxThrottle';
import { OriginalTreeAmbient } from './OriginalTreeAmbient';
import type { ParticleSpec } from './OriginalParticleSimulation';
import { CAMERA_BASIS } from '../core/projection';

/** Coordinates independent, source-derived appearances; combat stays in ground space. */
export class BattlefieldView {
  readonly node: Node;
  readonly cat: CharacterAppearance;
  private petVisuals?: PetVisualAssets;
  private readonly pets = new Map<number, PetView>();
  private readonly cats = new Map<number, CharacterAppearance>();
  private readonly catLayer: Node;
  private readonly overlayLayer: Node;
  private raidBossView?: RaidBossView;
  private bossView?: BossView;
  private huntView?: HuntView;
  private mineView?: MineView;
  private readonly retiredMineViews: MineView[] = [];
  private raidPortal?: Node;
  private portalParticles: OriginalTreeAmbient[] = [];
  private readonly layerForOrder: (order: number) => Node;
  private readonly impactFx = new OriginalImpactFxThrottle();
  private impactTimeOffset = 0;
  private lastImpactSourceTime = 0;
  private shootingMuted = false;
  private skinId = 0;
  private readonly map: OriginalMapView;
  private readonly healthLayer: Node;
  private readonly healthFillLayer: Node;
  private readonly trees = new Map<number, TreeAppearance>();
  private readonly target: TargetReticle;
  private readonly numbers: DamageNumbers;
  private readonly projectiles: OriginalProjectiles;
  private readonly moneyBurst: OriginalMoneyBurst;
  private readonly shadowOffset: {x:number;y:number};
  private aspect=9/16;
  private battlefieldActive=true;
  private readonly normalOrder=new RenderGroupOrder();
  private readonly overlayOrder=new RenderGroupOrder();

  constructor(private art: ArtLibrary, private world: CombatWorld, parent: Node,
    private readonly feedback: OriginalFeedbackConfig, map: OriginalMapDefinition,
    moneyBurst:MoneyBurstConfig,moneyNumbers:MoneyNumberConfig,
    private readonly sfx?: Pick<OriginalSfx, 'play'>) {
    this.node=makeNode('WorldProjection',parent);
    this.map=new OriginalMapView(art,map,this.node,world.stage.skinIndex);
    this.map.setBattlefield(this.world.stage);
    const defaultLayers=new Map<number,Node>();
    const layer=(order:number):Node=>{
      let result=defaultLayers.get(order);
      if(!result){
        result=makeNode(`Default_Order${order}`,this.node);defaultLayers.set(order,result);
        Array.from(defaultLayers.keys()).sort((a,b)=>a-b).forEach((key,i)=>defaultLayers.get(key)!.setSiblingIndex(i+1));
      }
      return result;
    };
    this.layerForOrder=layer;
    // Keep the source Default/order0 ground anchors for depth and shadows.
    // Extend the source GO3 RenderObjects pass (600) to complete cat visuals:
    // skin/face must remain visible above world particles with their weapons.
    this.catLayer=layer(0);
    const overlayPass=makeNode('OriginalOverlayPass600',this.node);
    this.overlayLayer=makeNode('Overlay_Default0',overlayPass);
    this.target=new TargetReticle(art,this.overlayLayer,feedback.reticle);
    // The source health renderers are also GO3: their Default10/11 orders
    // apply inside Overlay, after the cat groups and ordinary world effects.
    this.healthLayer=makeNode('Overlay_Default10',overlayPass);
    this.healthFillLayer=makeNode('Overlay_Default11',overlayPass);
    this.createTrees();
    this.projectiles=new OriginalProjectiles(art,this.node,layer);
    this.setParticleColliders();
    this.moneyBurst=new OriginalMoneyBurst(art,makeNode('MoneyBurst',layer(0)),moneyBurst);
    this.moneyBurst.setWalls(this.world.bulletWalls);
    this.numbers=new DamageNumbers(art,makeNode('DamageNumbers',layer(1000)),moneyNumbers);
    Array.from(defaultLayers.keys()).sort((a,b)=>a-b).forEach((order,i)=>defaultLayers.get(order)!.setSiblingIndex(i+1));
    this.cat=new CatView(art,this.catLayer,layer,this.overlayLayer);
    this.cats.set(0,this.cat);
    this.shadowOffset={x:this.cat.shadow.position.x,y:this.cat.shadow.position.y};
    this.cat.shadow.setParent(this.map.shadowLayer);
    this.syncCharacters();
    this.createRaidBoss();
    this.createBoss();
    this.createHunt();
    this.createMine();
    this.sortRenderGroups();
    this.prepareLoadout();
  }

  setViewport(aspect:number):void {
    this.aspect=aspect;
    this.world.hunt?.setAspect(aspect);
    // A paused battle still needs newly visible border tiles after a resize.
    const halfHeight=this.world.hunt?45:40;
    this.map.updateCamera(this.map.cameraCenter(this.world.player.position),halfHeight*aspect,halfHeight);
  }

  /** Core calls once after movement/aim and before firing, never from render. */
  prepareCatPose({dt,player,targetPoint,manualLookDirection,attackFacing,actorId,weaponId,attackInterval,attackProgress,willFire}:MuzzleSampleContext):Vec2 {
    const cat=this.getCat(actorId??0);
    cat.setWeapon(weaponId??player.weaponId??0);
    const cp=projectWorld(player.position);
    cat.node.setPosition(cp.x,cp.y,0);
    cat.setAimTarget?.(targetPoint?{x:targetPoint.x-player.position.x,z:targetPoint.z-player.position.z}:null);
    cat.setManualLookDirection?.(actorId === 0 ? manualLookDirection : undefined);
    cat.setAttackState?.({attackInterval,attackProgress,willFire,hasTarget:!!targetPoint},dt);
    cat.updatePose(dt,player.moving,player.facing);
    // Cat.Attack turns the body after UpdateHandRotation/UpdateFaceRotation.
    // Retain those local angles and elapsed time when the shot reverses facing.
    if(attackFacing!==undefined)cat.setFacing(attackFacing);
    return cat.getBulletSpawnOffset(WEAPON_CONFIG.bulletHeight);
  }

  update(dt:number):void {
    this.syncCharacters();
    this.syncPets(dt);
    const player=this.world.player;
    const camera=this.map.cameraCenter(player.position);
    this.node.setPosition(-camera.x,-camera.y,0);
    const halfHeight=this.world.hunt?45:40;
    this.map.updateCamera(camera,halfHeight*this.aspect,halfHeight);
    const target=this.battlefieldActive?this.world.damageTargets.find(tree=>tree.id===player.targetId):undefined;
    for(const actor of this.world.players) {
      const cat=this.getCat(actor.actorId),cp=projectWorld(actor.position);
      cat.updateEffects(dt);
      cat.shadow.setPosition(cp.x-this.shadowOffset.x*actor.facing,cp.y+this.shadowOffset.y,0);
    }
    if(this.battlefieldActive)for(const tree of this.world.trees)this.trees.get(tree.id)!.update(dt,tree);
    if(this.battlefieldActive&&this.world.stage.raidBoss)this.raidBossView?.update(dt,this.world.stage.raidBoss,this.world.stage.raidBoss.bossIndex);
    if(this.battlefieldActive&&this.world.stage.boss)this.bossView?.update(dt,this.world.stage.boss);
    if(this.battlefieldActive)for(const particles of this.portalParticles)particles.update(dt);
    if(this.battlefieldActive&&this.world.hunt){this.huntView?.update(dt);this.setParticleColliders();}
    this.mineView?.update(dt,this.world.simulationTime);
    for(let i=this.retiredMineViews.length-1;i>=0;i--){
      const view=this.retiredMineViews[i];view.update(dt,this.world.simulationTime);
      const effects=view.diagnostics();if(effects.dust===0&&effects.numbers===0){view.destroy();this.retiredMineViews.splice(i,1);}
    }
    this.target.update(dt,target);
    this.projectiles.update(dt,this.world.bullets);
    this.numbers.update(dt,this.world.simulationTime);
    this.moneyBurst.update(dt,this.battlefieldActive?this.world.trees:[],this.world.simulationTime);
    this.sortRenderGroups();
  }

  handleEvents(events:readonly CombatEvent[],rewards:readonly TreeReward[]):void {
    // Bootstrap drains once after all fixed steps in a rendered frame. Keep
    // the source's global FX clock continuous when the round resets its clock.
    const sourceTime=this.world.simulationTime;
    if(sourceTime<this.lastImpactSourceTime)this.impactTimeOffset+=this.lastImpactSourceTime;
    this.lastImpactSourceTime=sourceTime;
    this.impactFx.beginFrame(this.impactTimeOffset+sourceTime);
    for(const event of events) {
      if(event.type==='shot') {
        if(event.pelletIndex===0) {
          this.getCat(event.actorId).fire();
          if(!this.shootingMuted)this.sfx?.play(this.art.weaponVisuals?.appearance(event.weaponId).soundId??8);
        }
        this.projectiles.shot(event.bulletId,event.weaponId);
      }
      if(event.type==='impact') {
        const position=this.trees.get(event.treeId!)?.impactPosition(event.position,event.height)??event.position;
        // Contact visibility is independent of flash throttling. The real shot
        // reaches the same painted surface even when a duplicate flash is culled.
        if(event.bulletId!==undefined)this.projectiles.contact?.(event.bulletId,event.weaponId,position,event.height);
        if((this.projectiles.hitTrigger?.(event.weaponId)??'impact')==='impact'&&
          this.impactFx.canSpawn(event.weaponId,position,event.height,
            this.impactTimeOffset+(event.sourceTime??sourceTime)))
          this.projectiles.hit(position,event.weaponId,event.radius,event.height);
      }
      if(event.type==='hit') {
        // Per-target throwing-star flashes share the source FXThrottle with
        // ordinary impacts. Only rendering is suppressed; every hit still lands.
        // Their terminal impact remains excluded above to avoid a second flash.
        if(this.projectiles.hitTrigger?.(event.weaponId)==='hit') {
          const height=event.height??WEAPON_CONFIG.bulletHeight;
          const position=this.trees.get(event.treeId)?.impactPosition(event.position,height)??event.position;
          if(this.impactFx.canSpawn(event.weaponId,position,height,
            this.impactTimeOffset+(event.sourceTime??sourceTime)))
            this.projectiles.hit(position,event.weaponId,0,height);
        }
        this.trees.get(event.treeId)?.hit();
        this.huntView?.hit(event.treeId);
        this.mineView?.hit(event.treeId);
        if(event.treeId===this.world.stage.boss?.id)this.bossView?.hit();
        if(event.treeId===this.world.stage.raidBoss?.id)this.raidBossView?.hit();
      }
      if(event.type==='damageText'||event.type==='hit')
        this.numbers.spawn(event.position,event.damage,event.sourceTime,event.critical,event.height);
      if(event.type==='oreDied')this.mineView?.die(event.position,event.score,event.sourceTime);
      if(event.type==='huntMonsterDied')this.huntView?.die(event.targetId,event.position);
      if(event.type==='treeDied') {
        const reward=rewards.find(candidate=>candidate.treeId===event.treeId);
        if(reward) {
          this.numbers.spawnMoney(reward.position,reward.amount,reward.sourceTime);
          this.moneyBurst.spawn(reward.position,reward.sourceTime);
        }
      }
    }
  }

  reset(options:{preserveCharacterState?:boolean;preserveTransientEffects?:boolean}={}):void {
    this.battlefieldActive=true;
    this.map.setBattlefield(this.world.stage);
    if(!options.preserveTransientEffects){
      this.impactTimeOffset+=this.lastImpactSourceTime;
      this.lastImpactSourceTime=0;
    }
    for(const appearance of this.trees.values())appearance.destroy();
    this.trees.clear();this.createTrees();
    this.raidBossView?.destroy();this.raidBossView=undefined;
    this.raidPortal?.destroy();this.raidPortal=undefined;this.portalParticles=[];this.createRaidBoss();
    this.bossView?.destroy();this.bossView=undefined;this.createBoss();
    this.huntView?.destroy();this.huntView=undefined;this.createHunt();
    if(this.mineView){
      if(options.preserveTransientEffects){this.mineView.setActive(false);this.retiredMineViews.push(this.mineView);}
      else this.mineView.destroy();
      this.mineView=undefined;
    }
    if(!options.preserveTransientEffects){for(const view of this.retiredMineViews)view.destroy();this.retiredMineViews.length=0;}
    this.createMine();
    this.setParticleColliders();
    // Original rebirth warps existing characters. Keep their Animator state,
    // procedural aim and in-flight recoil rather than restarting Cat.Start.
    if(!options.preserveCharacterState)for(const cat of this.cats.values())cat.reset();
    this.syncCharacters();this.target.reset();
    // Source global projectile/number/money pools are outside Map_obj and keep
    // playing after rebirth. Their clock stays continuous with CombatWorld.
    if(!options.preserveTransientEffects){this.projectiles.reset();this.numbers.reset();this.moneyBurst.reset();}
    this.moneyBurst.setWalls(this.world.bulletWalls);
    for(const player of this.world.players)this.prepareCatPose({dt:0,player,targetPoint:null,actorId:player.actorId,
      weaponId:player.weaponId,attackInterval:getWeapon(player.weaponId).attackInterval,attackProgress:0,willFire:false});
    this.sortRenderGroups();
  }

  /** Hide Map_obj while global projectile/coin/number pools and actors survive. */
  setBattlefieldActive(active:boolean):void {
    this.battlefieldActive=active;
    this.map.setBattlefieldActive(active);
    this.bossView?.setActive(active);
    this.huntView?.setActive(active);
    this.mineView?.setActive(active);
    this.raidBossView?.setActive(active);
    if(this.raidPortal)this.raidPortal.active=active;
    for(const [id,tree] of this.trees) {
      tree.node.active=active && !!this.world.trees.find(state=>state.id===id)?.alive;
      tree.healthRoot.active=false;tree.healthFillRoot.active=false;
    }
    if(!active)this.target.reset();
    this.setParticleColliders();
    this.moneyBurst.setWalls(active?this.world.bulletWalls:[]);
  }

  clearTransientEffects():void {
    this.projectiles.reset();this.numbers.reset();this.moneyBurst.reset();this.mineView?.clearTransientEffects();
    for(const view of this.retiredMineViews)view.destroy();this.retiredMineViews.length=0;
  }

  get hasActiveRewards():boolean {return this.moneyBurst.diagnostics().active>0||this.numbers.diagnostics().active>0||(this.mineView?.diagnostics().numbers??0)>0||this.retiredMineViews.some(view=>view.diagnostics().numbers>0);}

  setShootingMuted(muted:boolean):void {this.shootingMuted=muted;}

  prepareLoadout():void {this.projectiles.prepareWeapons(this.world.players.map(player=>player.weaponId));}

  setPets(assets:PetVisualAssets,selected:readonly number[]):void {
    this.petVisuals=assets;this.world.petFollowers.setSelected(selected,this.world.player.position);this.syncPets(0);
  }

  private syncPets(dt:number):void {
    const states=this.world.petFollowers.pets;
    for(const [i,view] of this.pets)if(!states[i]||view.animator.rig.id!==states[i].grade){view.destroy();this.pets.delete(i);}
    states.forEach((state,i)=>{
      let view=this.pets.get(i);const rig=this.petVisuals?.rigs.get(state.grade);
      if(!view&&rig){view=new PetView(this.art,this.catLayer,rig);this.pets.set(i,view);}
      view?.update(dt,state);
    });
  }

  setSkin(id:number):void {
    if(this.skinId===id)return;
    for(const cat of this.cats.values())cat.setSkin(id);
    this.skinId=id;
  }

  diagnostics() {return {pets:this.world.petFollowers.pets.map((pet,i)=>({...pet,loaded:this.pets.has(i)})),moneyBurst:this.moneyBurst.diagnostics(),numbers:this.numbers.diagnostics(),
    mine:this.mineView?.diagnostics(),
    actors:this.world.players.map(player=>({actorId:player.actorId,weaponId:player.weaponId,skinId:this.skinId})),projectiles:this.projectiles.diagnostics()};}

  destroy():void {
    for(const pet of this.pets.values())pet.destroy();this.pets.clear();
    this.bossView?.destroy();this.bossView=undefined;
    this.huntView?.destroy();this.huntView=undefined;
    this.mineView?.destroy();this.mineView=undefined;
    for(const view of this.retiredMineViews)view.destroy();this.retiredMineViews.length=0;
    this.raidBossView?.destroy();this.raidBossView=undefined;
    for(const cat of this.cats.values())cat.destroy();this.cats.clear();
    this.projectiles.destroy();this.moneyBurst.destroy();this.map.destroy();if(this.node.isValid)this.node.destroy();
  }

  private getCat(id:number):CharacterAppearance {
    let cat=this.cats.get(id);
    if(!cat) {
      cat=new CatView(this.art,this.catLayer,this.layerForOrder,this.overlayLayer);this.cats.set(id,cat);
      cat.setSkin(this.skinId);
      cat.node.name=`Cat_${id}`;
      if(cat.overlayNode)cat.overlayNode.name=`CatOverlay_${id}`;
      cat.shadow.setParent(this.map.shadowLayer);
    }
    return cat;
  }

  private syncCharacters():void {
    for(const player of this.world.players) {
      const cat=this.getCat(player.actorId);
      cat.node.active=true;cat.shadow.active=true;cat.setActive?.(true);cat.setWeapon(player.weaponId);
    }
    for(const [id,cat] of this.cats)if(!this.world.players.some(player=>player.actorId===id)) {
      if(cat.node.active)cat.reset();cat.node.active=false;cat.shadow.active=false;cat.setActive?.(false);
    }
  }

  private createTrees():void {
    const ordered=this.world.trees.slice().sort((a,b)=>projectWorld(b.position).y-projectWorld(a.position).y);
    for(const tree of ordered)this.trees.set(tree.id,new TreeAppearance(this.art,tree,this.catLayer,this.feedback.tree,this.healthLayer,this.healthFillLayer));
  }

  private createHunt():void {
    if(this.world.hunt)this.huntView=new HuntView(this.art,this.world.hunt,this.catLayer,this.map,this.healthLayer,this.healthFillLayer,this.layerForOrder);
  }

  private createMine():void {
    if(this.world.stage.ores)this.mineView=new MineView(this.art,this.world.stage.ores,this.catLayer,this.healthLayer,this.healthFillLayer,this.layerForOrder);
  }

  private createBoss():void {
    const boss=this.world.stage.boss;
    // The dragon's limb orders are local to its Default/order0 SortingGroup.
    if(boss)this.bossView=new BossView(this.art,boss,this.catLayer,this.map.shadowLayer,this.layerForOrder);
  }

  private createRaidBoss():void {
    const raidBoss=this.world.stage.raidBoss;
    if(raidBoss){
      this.raidBossView=new RaidBossView(this.art,raidBoss,this.node,raidBoss.bossIndex,this.layerForOrder);
      const specs=this.art.catalog.raid?.portalParticles as ParticleSpec[]|undefined;
      if(specs?.length){
        const point=projectWorld(this.world.stage.mapOrigin!);
        this.raidPortal=makeNode('RaidPortal',this.layerForOrder(specs[0].sortingOrder));
        this.raidPortal.setPosition(point.x,point.y,0);
        this.portalParticles=specs.map(spec=>new OriginalTreeAmbient(this.art,this.raidPortal!,spec));
      }
    }
  }

  /** Preserve each source SortingGroup, sorting its root far-to-near. */
  private sortRenderGroups():void {
    const normal=this.normalOrder,overlay=this.overlayOrder;
    normal.begin();overlay.begin();
    const depth=(position:Vec2,height=0)=>position.x*CAMERA_BASIS.forwardX+height*CAMERA_BASIS.forwardY+position.z*CAMERA_BASIS.forwardZ;
    for(const player of this.world.players) {
      const cat=this.cats.get(player.actorId);
      if(!cat)continue;
      const d=cat.sortingDepth??depth(player.position);
      normal.add(cat.node,d);
      if(cat.overlayNode)overlay.add(cat.overlayNode,d);
    }
    for(const pet of this.pets.values())normal.add(pet.node,pet.sortingDepth);
    for(const state of this.world.trees) {
      const tree=this.trees.get(state.id);
      if(tree)normal.add(tree.node,tree.sortingDepth);
    }
    if(this.huntView)for(const group of this.huntView.renderGroups)normal.add(group.node,group.depth);
    if(this.mineView)for(const group of this.mineView.renderGroups)normal.add(group.node,group.depth);
    if(this.bossView)normal.add(this.bossView.node,this.bossView.sortingDepth);
    const target=this.world.damageTargets?.find(item=>item.id===this.world.player?.targetId);
    if(target&&this.target.node?.active)overlay.add(this.target.node,depth({
      x:(target.collider.minX+target.collider.maxX)/2,z:(target.collider.minZ+target.collider.maxZ)/2,
    },this.feedback.reticle.height+(target.sphereCollider?.transformY??0)));
    normal.end();overlay.end();
  }

  private setParticleColliders():void {
    if(!this.battlefieldActive){this.projectiles.setColliders([]);return;}
    this.projectiles.setColliders([
      ...this.world.damageTargets.map(tree=>({...tree.collider,minY:tree.colliderMinY??0,maxY:tree.colliderMaxY??6,
        ...(tree.sphereCollider?{sphere:{x:(tree.collider.minX+tree.collider.maxX)/2,y:tree.sphereCollider.centerY,z:(tree.collider.minZ+tree.collider.maxZ)/2,radius:tree.sphereCollider.radius}}:{}),
        get enabled(){return tree.alive;}})),
      ...this.world.bulletWalls,
    ]);
  }
}

interface RenderGroupEntry {node:Node;depth:number;order:number}

/** Reuse stable entries and repair the already sorted order as actors/bounces
 * move. Non-owned effect slots retain the exact original permutation rule. */
class RenderGroupOrder {
  private readonly entries:RenderGroupEntry[]=[];
  private readonly sorted:RenderGroupEntry[]=[];
  private readonly owned=new Set<Node>();
  private readonly children:Node[]=[];
  private readonly desired:Node[]=[];
  private count=0;
  private changed=false;
  private structure=false;
  private parent:Node|null=null;

  begin():void {this.count=0;this.changed=false;this.structure=false;}
  add(node:Node,depth:number):void {
    if(!node.active||!node.isValid)return;
    const index=this.count++,entry=this.entries[index];
    if(!entry){this.entries.push({node,depth,order:index});this.structure=true;}
    else {
      if(entry.node!==node){entry.node=node;this.structure=true;}
      if(entry.depth!==depth){entry.depth=depth;this.changed=true;}
    }
  }
  end():void {
    if(this.entries.length!==this.count){this.entries.length=this.count;this.structure=true;}
    if(this.structure){
      this.sorted.length=0;this.owned.clear();
      for(const entry of this.entries){this.sorted.push(entry);this.owned.add(entry.node);}
      this.sorted.sort((a,b)=>b.depth-a.depth||a.order-b.order);
    }
    let reordered=this.structure;
    if(!this.structure&&this.changed){
      // Temporal coherence: the great majority of trees retain their depth.
      // Explicit source rank preserves ties through moves and activation.
      for(let i=1;i<this.sorted.length;i++){
        const entry=this.sorted[i];let j=i;
        while(j>0){
          const previous=this.sorted[j-1],delta=entry.depth-previous.depth;
          if(!(delta>0||(!(delta<0)&&entry.order<previous.order)))break;
          this.sorted[j]=previous;j--;
        }
        if(j!==i){this.sorted[j]=entry;reordered=true;}
      }
    }
    const parent=this.entries[0]?.node.parent??null;
    if(parent!==this.parent){this.parent=parent;reordered=true;}
    if(!parent){this.children.length=this.desired.length=0;return;}
    const current=parent.children;
    if(!reordered){
      if(current.length!==this.children.length)reordered=true;
      else for(let i=0;i<current.length;i++)if(current[i]!==this.children[i]){reordered=true;break;}
    }
    if(!reordered)return;
    let next=0;
    this.desired.length=current.length;
    for(let i=0;i<current.length;i++)this.desired[i]=this.owned.has(current[i])?this.sorted[next++].node:current[i];
    for(let i=0;i<this.desired.length;i++)if(parent.children[i]!==this.desired[i])this.desired[i].setSiblingIndex(i);
    this.children.length=current.length;
    for(let i=0;i<current.length;i++)this.children[i]=current[i];
  }
}
