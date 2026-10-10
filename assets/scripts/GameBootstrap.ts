import { _decorator, Camera, Color, Component, Game, game, Label, Node, profiler, ResolutionPolicy, sys, UITransform, view } from 'cc';
import { DEBUG, PREVIEW } from 'cc/env';
import { COMBAT_CONFIG, CombatWorld } from './core';
import { ArtLibrary, makeNode } from './view/ArtLibrary';
import { BattlefieldView } from './view/BattlefieldView';
import { GameHud } from './view/GameHud';
import { loadOriginalFeedback } from './view/OriginalFeedbackAssets';
import { OriginalMapView } from './view/OriginalMapView';
import { OriginalColorPipeline } from './view/OriginalColorPipeline';
import { ORIGINAL_CAMERA_CLEAR } from './view/OriginalColorMath';
import { BattleMode, BattleSession, UpgradeType } from './session/BattleSession';
import { resolveRuntimeEnvironment } from './session/RuntimeEnvironment';
import { loadOriginalHudAssets } from './view/OriginalHudAssets';
import { loadOriginalMoneyBurst } from './view/OriginalMoneyBurst';
import { loadOriginalMoneyNumbers } from './view/DamageNumbers';

const {ccclass,disallowMultiple}=_decorator;

@ccclass('GameBootstrap')
@disallowMultiple
export class GameBootstrap extends Component {
  private world!:CombatWorld;
  private battlefield?:BattlefieldView;
  private hud?:GameHud;
  private hudRoot?:Node;
  private worldScale?:Node;
  private colors?:OriginalColorPipeline;
  private loading?:Node;
  private manuallyPaused=false;
  private backgrounded=false;
  private ready=false;
  private skipFrame=true;
  private viewport={width:720,height:1280};
  private seed=20261010;
  private disposed=false;
  private canvasTransform!:UITransform;
  private debugApi?:object;
  private session!:BattleSession;

  async start():Promise<void> {
    view.setDesignResolutionSize(720,1280,ResolutionPolicy.FIXED_WIDTH);
    profiler.hideStats();
    this.canvasTransform=this.node.getComponent(UITransform)!;
    const camera=this.node.getChildByName('Camera')?.getComponent(Camera);
    if(camera) camera.clearColor=new Color(...ORIGINAL_CAMERA_CLEAR.slice(0,3).map(c=>Math.round(c*255)) as [number,number,number],255);
    this.loading=makeNode('Loading',this.node);
    const message=this.loading.addComponent(Label);
    message.string='正在走进森林…';message.fontSize=27;message.color=new Color(88,67,44);
    game.on(Game.EVENT_HIDE,this.onHide,this);
    game.on(Game.EVENT_SHOW,this.onShow,this);
    // Browser Page Lifecycle freeze/resume can occur without a visibility change.
    if(typeof document!=='undefined') {
      document.addEventListener('freeze',this.onDocumentFreeze);
      document.addEventListener('resume',this.onDocumentResume);
    }
    view.on('canvas-resize',this.resize,this);
    try {
      const scope=globalThis as typeof globalThis & {__FOREST_GUNNER_ENV__?:unknown};
      this.session=new BattleSession({environment:resolveRuntimeEnvironment(scope.__FOREST_GUNNER_ENV__,PREVIEW),storage:sys.localStorage});
      const art=new ArtLibrary();await art.load();
      if(this.disposed)return;
      const [feedback,map,colorEffects,hudAssets,moneyBurst,moneyNumbers]=await Promise.all([
        loadOriginalFeedback(art),OriginalMapView.load(art),OriginalColorPipeline.load(),
        loadOriginalHudAssets(art),loadOriginalMoneyBurst(art),loadOriginalMoneyNumbers(art),
      ]);
      if(this.disposed)return;
      this.world=new CombatWorld(this.seed);
      this.world.setCombatModifiers(this.session.combatModifiers);
      if(!camera)throw new Error('Missing presentation camera');
      this.colors=new OriginalColorPipeline(this.node,camera,art,colorEffects);
      this.worldScale=makeNode('WorldScale',this.colors.world);
      this.battlefield=new BattlefieldView(art,this.world,this.worldScale,feedback,map,moneyBurst,moneyNumbers);
      this.world.setMuzzleProvider(context=>this.battlefield!.prepareCatPose(context));
      // Own the root before GameHud constructs its children, including failures.
      this.hudRoot=makeNode('GameInterface',this.node);
      this.hud=new GameHud(this.hudRoot,art,hudAssets,()=>this.restart(),type=>this.purchaseUpgrade(type));
      this.resize();this.ready=true;
      this.hud.update(this.hudState());
      this.loading.destroy();this.loading=undefined;
      // Explicit local diagnostic surface; excluded from release builds by DEBUG.
      if(DEBUG) {
        this.debugApi={
        snapshot:()=>({stats:{...this.world.stats},player:this.world.player,trees:this.world.trees,
          activeBullets:this.world.bullets.filter(x=>x.active).length,nodeCount:this.countNodes(this.node),
          paused:this.manuallyPaused,backgrounded:this.backgrounded,viewport:this.viewport,
          hud:this.hudState(),effects:this.battlefield!.diagnostics(),combatModifiers:this.session.combatModifiers}),
        restart:(seed?:number)=>{if(seed!==undefined)this.seed=seed;this.restart();},
        pause:()=>{if(!this.manuallyPaused)this.togglePause();},
        resume:()=>{if(this.manuallyPaused)this.togglePause();},
        background:(hidden:boolean)=>game.emit(hidden?Game.EVENT_HIDE:Game.EVENT_SHOW),
        setMode:(mode:BattleMode)=>this.setBattleMode(mode),
        upgrade:(type:UpgradeType)=>this.purchaseUpgrade(type),
        };
        (globalThis as typeof globalThis & {__forestGunner?:object}).__forestGunner=this.debugApi;
      }
    } catch(error) {
      if(this.disposed)return;
      this.clearViews();
      console.error('[ForestGunner] Startup failed',error);
      if(message.isValid)message.string='资源加载失败，请重新打开';
    }
  }

  update(dt:number):void {
    if(!this.ready||!this.battlefield||!this.hud)return;
    this.resizeIfNeeded();
    const paused=this.isPaused;
    if(this.skipFrame){this.skipFrame=false;dt=0;}
    if(!paused&&Number.isFinite(dt)&&dt>0) {
      // Unity runs zero or more fixed physics steps, then ONE Cat.Update per
      // render frame. Resampling Update at 60 Hz changes its Lerp and timers.
      const delta=Math.min(dt,COMBAT_CONFIG.maxFrameTime);
      this.world.step(delta);
      const events=this.world.drainEvents();
      const rewards=this.session.consume(events,this.world.trees);
      this.battlefield.handleEvents(events,rewards);
      this.battlefield.update(delta);
    }
    this.hud.update(this.hudState(),paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)));
  }

  lateUpdate():void {this.colors?.syncCamera();}

  private get isPaused():boolean {return this.manuallyPaused||this.backgrounded||this.session.mode!=='Main';}

  private hudState() {return this.session.snapshot(this.world.stats,this.isPaused,this.battlefield?.hasActiveRewards??false);}

  private purchaseUpgrade(type:UpgradeType):boolean {
    if(!this.ready||this.isPaused||this.hudState().resultsReady)return false;
    if(!this.session.purchase(type))return false;
    this.world.setCombatModifiers(this.session.combatModifiers);
    this.hud!.update(this.hudState());
    return true;
  }

  /** Future mode controllers use this seam; only the Main simulation exists today. */
  private setBattleMode(mode:BattleMode):void {
    if(!this.ready||mode===this.session.mode)return;
    this.hud?.cancelInteractions();
    this.session.setMode(mode);
    this.battlefield!.clearTransientEffects();
    if(this.isPaused)this.world.pause();else this.world.resume();
    this.skipFrame=true;
    this.hud!.update(this.hudState());
  }

  private togglePause():void {
    if(!this.ready)return;
    this.hud?.cancelInteractions();
    this.manuallyPaused=!this.manuallyPaused;
    if(this.isPaused)this.world.pause();else this.world.resume();
    this.skipFrame=true;
  }
  private restart():void {
    if(!this.ready)return;
    this.hud?.cancelInteractions();
    this.manuallyPaused=false;this.skipFrame=true;
    this.world.reset(this.seed);
    this.session.beginRound();
    if(this.isPaused)this.world.pause();
    this.battlefield!.reset();this.battlefield!.update(0);
    this.hud!.update(this.hudState());
  }
  private onHide():void {
    this.hud?.cancelInteractions();
    this.backgrounded=true;this.skipFrame=true;
    if(this.ready)this.world.pause();
  }
  private readonly onDocumentFreeze=():void=>this.onHide();
  private readonly onDocumentResume=():void=>this.onShow();
  private onShow():void {
    this.backgrounded=false;this.skipFrame=true;
    if(this.ready&&!this.isPaused)this.world.resume();
  }
  private resizeIfNeeded():void {
    const size=this.canvasTransform.contentSize;
    if(size.width!==this.viewport.width||size.height!==this.viewport.height)this.resize();
  }
  private resize():void {
    const size=(this.canvasTransform??this.node.getComponent(UITransform)!).contentSize;
    this.viewport={width:size.width||720,height:size.height||1280};
    const scale=this.viewport.height/80;
    this.worldScale?.setScale(scale,scale,1);
    this.colors?.resize(this.viewport.width,this.viewport.height);
    this.battlefield?.setViewport(this.viewport.width/this.viewport.height);
    // Creator returns platform safe bounds in design units, including WeChat's notch/home bar.
    const safe=sys.getSafeAreaRect(false);
    const topInset=Math.max(0,this.viewport.height-safe.y-safe.height);
    this.hud?.resize(this.viewport.width,this.viewport.height,topInset,Math.max(0,safe.y));
    this.world?.setViewport(this.viewport.width/this.viewport.height);
  }
  private countNodes(n:Node):number {return 1+n.children.reduce((count,child)=>count+this.countNodes(child),0);}
  private clearViews():void {
    this.ready=false;
    this.world?.pause();
    this.world?.setMuzzleProvider(null);
    this.battlefield?.destroy();this.battlefield=undefined;
    this.colors?.destroy();this.colors=undefined;
    this.hud?.destroy();
    if(this.hudRoot?.isValid)this.hudRoot.destroy();
    this.hudRoot=undefined;this.hud=undefined;
    this.worldScale=undefined;
  }
  onDestroy():void {
    this.disposed=true;
    this.clearViews();
    if(this.loading?.isValid)this.loading.destroy();
    this.loading=undefined;
    game.off(Game.EVENT_HIDE,this.onHide,this);game.off(Game.EVENT_SHOW,this.onShow,this);
    if(typeof document!=='undefined') {
      document.removeEventListener('freeze',this.onDocumentFreeze);
      document.removeEventListener('resume',this.onDocumentResume);
    }
    view.off('canvas-resize',this.resize,this);
    if(DEBUG) {
      const scope=globalThis as typeof globalThis & {__forestGunner?:object};
      if(scope.__forestGunner===this.debugApi)delete scope.__forestGunner;
      this.debugApi=undefined;
    }
  }
}
