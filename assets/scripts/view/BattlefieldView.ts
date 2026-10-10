import { Node } from 'cc';
import { CombatEvent, CombatWorld, MuzzleSampleContext, projectWorld, Vec2, WEAPON_CONFIG } from '../core';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { CatView } from './CatView';
import { CharacterAppearance } from './CharacterAppearance';
import { OriginalFeedbackConfig } from './OriginalFeedbackAssets';
import { OriginalMapDefinition, OriginalMapView } from './OriginalMapView';
import { TreeAppearance } from './TreeAppearance';
import { TargetReticle } from './TargetReticle';
import { DamageNumbers, MoneyNumberConfig } from './DamageNumbers';
import { OriginalProjectiles } from './OriginalProjectiles';
import { MoneyBurstConfig, OriginalMoneyBurst } from './OriginalMoneyBurst';
import type { TreeReward } from '../session/BattleSession';

/** Coordinates independent, source-derived appearances; combat stays in ground space. */
export class BattlefieldView {
  readonly node: Node;
  readonly cat: CharacterAppearance;
  private readonly map: OriginalMapView;
  private readonly treesLayer: Node;
  private readonly healthLayer: Node;
  private readonly healthFillLayer: Node;
  private readonly trees = new Map<number, TreeAppearance>();
  private readonly target: TargetReticle;
  private readonly numbers: DamageNumbers;
  private readonly projectiles: OriginalProjectiles;
  private readonly moneyBurst: OriginalMoneyBurst;
  private readonly shadowOffset: {x:number;y:number};
  private aspect=9/16;

  constructor(private art: ArtLibrary, private world: CombatWorld, parent: Node,
    private readonly feedback: OriginalFeedbackConfig, map: OriginalMapDefinition,
    moneyBurst:MoneyBurstConfig,moneyNumbers:MoneyNumberConfig) {
    this.node=makeNode('WorldProjection',parent);
    this.map=new OriginalMapView(art,map,this.node);
    const defaultLayers=new Map<number,Node>();
    const layer=(order:number):Node=>{
      let result=defaultLayers.get(order);
      if(!result){result=makeNode(`Default_Order${order}`,this.node);defaultLayers.set(order,result);}
      return result;
    };
    this.treesLayer=makeNode('Trees_Default0',layer(0));
    this.target=new TargetReticle(art,makeNode('Target_Default0',layer(0)),feedback.reticle);
    this.healthLayer=layer(10);
    this.healthFillLayer=layer(11);
    this.createTrees();
    this.projectiles=new OriginalProjectiles(art,this.node,layer);
    this.moneyBurst=new OriginalMoneyBurst(art,makeNode('MoneyBurst',layer(0)),moneyBurst);
    this.numbers=new DamageNumbers(art,makeNode('DamageNumbers',layer(1000)),moneyNumbers);
    // TagManager sorting layers: Default, then Cat, then Boss. Order41 does
    // not put a Default-layer impact over the Cat layer.
    Array.from(defaultLayers.keys()).sort((a,b)=>a-b).forEach((order,i)=>defaultLayers.get(order)!.setSiblingIndex(i+1));
    this.cat=new CatView(art,makeNode('Cat_SortingLayer',this.node));
    this.shadowOffset={x:this.cat.shadow.position.x,y:this.cat.shadow.position.y};
    this.cat.shadow.setParent(this.map.shadowLayer);
  }

  setViewport(aspect:number):void {
    this.aspect=aspect;
    // A paused battle still needs newly visible border tiles after a resize.
    this.map.updateCamera(this.map.cameraCenter(this.world.player.position),40*aspect,40);
  }

  /** Core calls once after movement/aim and before firing, never from render. */
  prepareCatPose({dt,player,targetPoint,attackFacing}:MuzzleSampleContext):Vec2 {
    const cp=projectWorld(player.position);
    this.cat.node.setPosition(cp.x,cp.y,0);
    this.cat.setAimTarget?.(targetPoint?{x:targetPoint.x-player.position.x,z:targetPoint.z-player.position.z}:null);
    this.cat.updatePose(dt,player.moving,player.facing);
    // Cat.Attack turns the body after UpdateHandRotation/UpdateFaceRotation.
    // Retain those local angles and elapsed time when the shot reverses facing.
    if(attackFacing!==undefined)this.cat.setFacing(attackFacing);
    return this.cat.getBulletSpawnOffset(WEAPON_CONFIG.bulletHeight);
  }

  update(dt:number):void {
    const player=this.world.player;
    const camera=this.map.cameraCenter(player.position);
    this.node.setPosition(-camera.x,-camera.y,0);
    this.map.updateCamera(camera,40*this.aspect,40);
    const cp=projectWorld(player.position);
    const target=this.world.trees.find(tree=>tree.id===player.targetId);
    this.cat.updateEffects(dt);
    this.cat.shadow.setPosition(cp.x-this.shadowOffset.x*player.facing,cp.y+this.shadowOffset.y,0);
    for(const tree of this.world.trees)this.trees.get(tree.id)!.update(dt,tree);
    this.target.update(dt,target);
    this.projectiles.update(dt,this.world.bullets);
    this.numbers.update(dt,this.world.simulationTime);
    this.moneyBurst.update(dt,this.world.trees,this.world.simulationTime);
  }

  handleEvents(events:readonly CombatEvent[],rewards:readonly TreeReward[]):void {
    for(const event of events) {
      if(event.type==='shot') {this.cat.fire();this.projectiles.shot(event.bulletId);}
      if(event.type==='impact')this.projectiles.hit(event.position);
      if(event.type==='hit') {
        this.trees.get(event.treeId)?.hit();
        this.numbers.spawn(event.position,event.damage,event.sourceTime);
        this.projectiles.hit(event.position);
      }
      if(event.type==='treeDied') {
        const reward=rewards.find(candidate=>candidate.treeId===event.treeId);
        if(reward) {
          this.numbers.spawnMoney(reward.position,reward.amount,reward.sourceTime);
          this.moneyBurst.spawn(reward.position,reward.sourceTime);
        }
      }
    }
  }

  reset():void {
    for(const appearance of this.trees.values())appearance.destroy();
    this.trees.clear();this.createTrees();
    this.cat.reset();this.target.reset();this.projectiles.reset();this.numbers.reset();
    this.moneyBurst.reset();
    this.prepareCatPose({dt:0,player:this.world.player,targetPoint:null});
  }

  clearTransientEffects():void {this.projectiles.reset();this.numbers.reset();this.moneyBurst.reset();}

  get hasActiveRewards():boolean {return this.moneyBurst.diagnostics().active>0||this.numbers.diagnostics().active>0;}

  diagnostics() {return {moneyBurst:this.moneyBurst.diagnostics(),numbers:this.numbers.diagnostics()};}

  destroy():void {this.moneyBurst.destroy();this.map.destroy();if(this.node.isValid)this.node.destroy();}

  private createTrees():void {
    const ordered=this.world.trees.slice().sort((a,b)=>projectWorld(b.position).y-projectWorld(a.position).y);
    for(const tree of ordered)this.trees.set(tree.id,new TreeAppearance(this.art,tree,this.treesLayer,this.feedback.tree,this.healthLayer,this.healthFillLayer));
  }
}
