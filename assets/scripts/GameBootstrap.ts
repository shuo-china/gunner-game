import { MineHud, loadMineHudAssets } from './view/MineHud';
import { OfflineHud, loadOfflineHudAssets } from './view/OfflineHud';
import type { OfflineHudState } from './view/OfflineHud';
import { DailyCheckEntry, DailyCheckHud, loadDailyCheckEntryAssets, loadDailyCheckHudAssets } from './view/DailyCheckHud';
import { MinePlacement } from './core/MineMap';
import { leftMenuOffsets, rightMenuOffsets } from './view/FeatureEntry';
import { FishHud, loadFishHudAssets } from './view/FishHud';
import type { FishActionResult, FishDrawKind } from './session/FishSystem';
import { AdventureHud, loadAdventureHudAssets } from './view/AdventureHud';
import { PetHud, loadPetHudAssets } from './view/PetHud';
import { PetVisualAssets } from './view/PetView';
import type { PetActionResult, PetSlotRef } from './session/PetSystem';
import { _decorator, assetManager, BlockInputEvents, Camera, Color, Component, director, Game, game, Graphics, Label, Node, profiler, ResolutionPolicy, sys, UITransform, view } from 'cc';
import { DEBUG, PREVIEW, WECHAT } from 'cc/env';
import { COMBAT_CONFIG, CombatWorld, createStageDefinition } from './core';
import { ArtLibrary, makeNode } from './view/ArtLibrary';
import { BattleAssetLoader } from './view/BattleAssetLoader';
import { GameResourcePreloader } from './view/GameResourcePreloader';
import { ResourceModuleManager } from './view/ResourceModuleManager';
import { StartupPreparationBudget } from './view/StartupPreparationBudget';
import { StartupLoadingScreen } from './view/StartupLoadingScreen';
import { RESOURCE_MODULE_ORDER, isAutomaticModule, isStartupModule, collectBackgroundResources, weaponPanelImagePaths } from './view/FeatureResourceManifest';
import type { BackgroundFeature } from './view/FeatureResourceManifest';
import { UiPreparationQueue } from './view/UiPreparationQueue';
import { LoadingPerformanceTrace } from './view/LoadingPerformanceTrace';
import type { UiPreparation, UiLayout } from './view/OriginalWeaponUi';
import { disposeSkinHudPresentation, skinHudPresentationSnapshot } from './view/SkinHudColorPipeline';
import { BackgroundPreparationScheduler } from './view/BackgroundPreparationScheduler';
import { RESOURCE_LOADING_POLICY } from './view/ResourceLoadingPolicy';
import { FeatureEntry, FeatureName, loadFeatureEntry } from './view/FeatureEntry';
import type { StageDefinition } from './core';
import { BattlefieldView } from './view/BattlefieldView';
import { GameHud } from './view/GameHud';
import { resolveSafeAreaInsets } from './view/SafeArea';
import type { SafeAreaHost, SafeAreaInsets } from './view/SafeArea';
import { loadOriginalFeedback } from './view/OriginalFeedbackAssets';
import { OriginalMapView } from './view/OriginalMapView';
import { OriginalColorPipeline } from './view/OriginalColorPipeline';
import { ORIGINAL_CAMERA_CLEAR } from './view/OriginalColorMath';
import { BattleMode, BattleSession, economyStorageKey, UpgradeType } from './session/BattleSession';
import { resolveRuntimeEnvironment } from './session/RuntimeEnvironment';
import { TutorialPreviewController } from './session/TutorialPreview';
import { loadTutorialHudAssets, TutorialHud } from './view/TutorialHud';
import { loadOriginalHudAssets } from './view/OriginalHudAssets';
import type { OriginalHudConfig } from './view/OriginalHudAssets';
import { attachFontPolicyLabel } from './view/FontPolicyLabel';
import { loadOriginalMoneyBurst } from './view/OriginalMoneyBurst';
import { loadOriginalMoneyNumbers } from './view/DamageNumbers';
import { WeaponVisualAssets } from './view/WeaponVisualAssets';
import { loadWeaponHudAssets, WeaponHud } from './view/WeaponHud';
import { loadOriginalAlertAssets, OriginalAlerts } from './view/OriginalAlerts';
import { loadOriginalSfxAssets, OriginalSfx } from './view/OriginalSfx';
import { loadOriginalBgmAssets, OriginalBgm } from './view/OriginalBgm';
import { AudioPreferences } from './session/AudioPreferences';
import { installWeChatFontFallback } from './session/WeChatFontFallback';
import { loadSettingsHudAssets, SettingsHud } from './view/SettingsHud';
import { loadRebirthHudAssets, RebirthHud } from './view/RebirthHud';
import { loadSpeedRunHudAssets, SpeedRunHud } from './view/SpeedRunHud';
import { createSpeedRunDefinition } from './core/SpeedRunMap';
import { createRaidDefinition } from './core/RaidMap';
import { loadRaidHudAssets, RaidHud } from './view/RaidHud';
import { BossCombat } from './core/BossCombat';
import { createHuntDefinition } from './core/HuntMap';
import { HuntHud, loadHuntHudAssets } from './view/HuntHud';
import { createBossDefinition } from './core/BossMap';
import { loadBossHudAssets, BossHud } from './view/BossHud';
import { loadSkinHudAssets, SkinHud } from './view/SkinHud';
import { SkinVisualAssets } from './view/SkinVisualAssets';
import { RewardedAdService, SimulatedRewardedAdProvider, UnavailableRewardedAdProvider } from './session/RewardedAds';
import type { RewardedAdProvider } from './session/RewardedAds';
import type { ContentId } from './session/ContentUnlockManager';
import { RewardedAdModal } from './view/RewardedAdModal';
import type { AdKind, AdOutcome, WeaponLocation, WeaponTestConfiguration } from './session/WeaponInventory';
import type { SkinActionResult } from './session/SkinSystem';

const {ccclass,disallowMultiple}=_decorator;
type DeferredHudName=FeatureName;
interface DeferredHudState { attempts:number; retryAt:number; failed:boolean; request?:Promise<void>; }
const DEFERRED_HUD_LABELS:Record<DeferredHudName,string>={weapons:'武器界面',raid:'讨伐界面',boss:'首领界面',speedrun:'挑战界面',rebirth:'转生界面',skins:'皮肤界面',pets:'宠物界面',fish:'鱼缸界面',hunt:'狩猎界面',mine:'矿山界面',adventure:'旅行界面'};
// These HUDs do not capture the display camera when constructed. They can be
// prepared behind an open offline/settings popup without borrowing its target.
const HUDS_WITHOUT_COMPOSITOR:readonly string[]=['speedrun','weapons','weaponCollection','rebirth','boss','hunt','mine','raid'];

@ccclass('GameBootstrap')
@disallowMultiple
export class GameBootstrap extends Component {
  private world!:CombatWorld;
  private artLibrary?:ArtLibrary;
  private battleAssets?:BattleAssetLoader;
  private battleLoading=false;
  private battleLoadVersion=0;
  private battleRetry?:()=>void;
  private battleNotice?:Node;
  private battleNoticeAt=0;
  private resourcePreloader?:GameResourcePreloader;
  private resourceModules=this.createResourceModules();
  private readonly moduleGuards=new Map<string,()=>boolean>();
  private preparationReady=false;
  private startupStartedAt=Date.now();
  private startupBudgetMs:number=RESOURCE_LOADING_POLICY.startup.coldBudgetMs;
  private startupRelease?:()=>void;
  private startupModules:BackgroundFeature[]=[];
  private startupCurrent?:BackgroundFeature;
  private startupRequest?:Promise<void>;
  private startupAssetRequest?:Promise<void>;
  private readonly startupAssetsAttempted=new Set<BackgroundFeature>();
  private startupFailure?:string;
  private startupAttempts=0;
  private startupRetryAt=0;
  private startupGeneration=0;
  private startupCoreReadyAt=0;
  private startupInteractiveAt=0;
  private startupReturning=false;
  private startupBudget?:StartupPreparationBudget;
  private readonly moduleAssetPaths=new Map<string,Set<string>>();
  private readonly pendingFrameEvictions=new Set<string>();
  private coreResourcePaths=new Set<string>();
  private collectionWarmRequest?:Promise<void>;
  private collectionRetryAt=0;
  private memoryPressureUntil=0;
  private readonly memoryEvictedModules=new Set<string>();
  private readonly moduleLastUsed=new Map<string,number>();
  private readonly loadingTrace=new LoadingPerformanceTrace(()=>this.preparationNow());
  private uiPreparation=this.createUiPreparation();
  private readonly preparedLayouts=new Map<string,string>();
  private readonly firstHudUpdates=new Set<string>();
  private presentationCamera?:Camera;
  private modalStateDirty=false;
  private committingHud=false;
  private backgroundPreparation=new BackgroundPreparationScheduler(()=>this.preparationNow());
  private nextBackgroundDecodeAt=0;
  private readonly backgroundHudRequests=new Map<string,Promise<void>>();
  private settingsRetryAt=0;
  private prefetchAt=0;
  private prefetchedStage=-1;
  private readonly featureEntries=new Map<FeatureName,FeatureEntry>();
  private readonly entryRequests=new Map<FeatureName,Promise<void>>();
  private readonly entryRetryAt=new Map<FeatureName,number>();
  private openingFeature?:FeatureName;
  private featureOpenVersion=0;
  private featureNoticeAt=0;
  private featureNoticeReportedVersion=-1;
  private battlefield?:BattlefieldView;
  private hud?:GameHud;
  private hudRoot?:Node;
  private worldScale?:Node;
  private colors?:OriginalColorPipeline;
  private loading?:Node;
  private startupScreen?:StartupLoadingScreen;
  private startupInputBlock?:Node;
  private startupProgress?:()=>void;
  private startupProgressNextAt=0;
  private loadingText?:ReturnType<typeof attachFontPolicyLabel>;
  private manuallyPaused=false;
  private backgrounded=false;
  private ready=false;
  private skipFrame=true;
  private viewport={width:720,height:1280};
  private layoutInsets:SafeAreaInsets={top:0,bottom:0};
  private seed=20261010;
  private disposed=false;
  private canvasTransform!:UITransform;
  private debugApi?:object;
  private loadingDiagnosticsApi?:object;
  private session!:BattleSession;
  private weaponsHud?:WeaponHud;
  private readonly visibleUsedFeatures=new Set<string>();
  private rebirthHud?:RebirthHud;
  private speedRunHud?:SpeedRunHud;
  private raidHud?:RaidHud;
  private bossHud?:BossHud;
  private huntHud?:HuntHud;
  private mineHud?:MineHud;
  private offlineHud?:OfflineHud;
  private offlineSummaryPending=false;
  private offlineHudRequest?:Promise<void>;
  private offlineHudLoader?:()=>Promise<OfflineHud|undefined>;
  private offlineNotice?:Node;
  private offlineCheckpointAt=0;
  private cancelOfflineRetry?:()=>void;
  private dailyCheckHud?:DailyCheckHud;
  private dailyCheckEntry?:DailyCheckEntry;
  private dailyCheckEntryRequest?:Promise<void>;
  private dailyCheckEntryRetryAt=0;
  private dailyCheckHudLoader?:()=>Promise<DailyCheckHud|undefined>;
  private dailyCheckHudRequest?:Promise<DailyCheckHud|undefined>;
  private dailyCheckOpening=false;
  private dailyCheckOpenVersion=0;
  private dailyCheckAutoPending=false;
  private dailyCheckRetryAt=0;
  private dailyCheckNoticeAt=0;
  private dailyCheckNotice?:Node;
  private minePlacement?:MinePlacement;
  private mineDefinition?:StageDefinition;
  private mineDefinitionRound=0;
  private petHud?:PetHud;
  private fishHud?:FishHud;
  private adventureHud?:AdventureHud;
  private adventureAlertAt=0;
  private petVisuals?:PetVisualAssets;
  private skinHud?:SkinHud;
  private skinVisuals?:SkinVisualAssets;
  private tutorialHud?:TutorialHud;
  private rewardedAds?:RewardedAdService;
  private rewardedAdModal?:RewardedAdModal;
  private alerts?:OriginalAlerts;
  private sfx?:OriginalSfx;
  private bgm?:OriginalBgm;
  private bgmAssetsLoader?:()=>ReturnType<typeof loadOriginalBgmAssets>;
  private bgmRequest?:Promise<void>;
  private bgmLoadVersion=0;
  private audioPreferences?:AudioPreferences;
  private settingsHud?:SettingsHud;
  private settingsHudLoader?:()=>Promise<SettingsHud|undefined>;
  private settingsHudRequest?:Promise<SettingsHud|undefined>;
  private settingsOpening=false;
  private settingsOpenVersion=0;
  private settingsLoading?:Node;
  private settingsNoticeAt=0;
  private deferredHudLoaders?:Record<DeferredHudName,()=>Promise<void>>;
  private readonly deferredHudStates:Record<DeferredHudName,DeferredHudState>={
    weapons:{attempts:0,retryAt:0,failed:false},raid:{attempts:0,retryAt:0,failed:false},boss:{attempts:0,retryAt:0,failed:false},
    speedrun:{attempts:0,retryAt:0,failed:false},rebirth:{attempts:0,retryAt:0,failed:false},skins:{attempts:0,retryAt:0,failed:false},pets:{attempts:0,retryAt:0,failed:false},fish:{attempts:0,retryAt:0,failed:false},hunt:{attempts:0,retryAt:0,failed:false},mine:{attempts:0,retryAt:0,failed:false},adventure:{attempts:0,retryAt:0,failed:false},
  };
  private deferredHudNotice?:Node;
  private raidStarRequest=0;
  private loadoutSignature='';
  private worldRoundId=0;
  private worldMode:BattleMode='Main';
  private modeRevealElapsed:number|null=null;

  async start():Promise<void> {
    const bootScope=globalThis as typeof globalThis & {__FOREST_GUNNER_BOOT_STARTED_AT__?:number};
    this.startupStartedAt=bootScope.__FOREST_GUNNER_BOOT_STARTED_AT__??Date.now();
    view.setDesignResolutionSize(720,1280,ResolutionPolicy.FIXED_WIDTH);
    profiler.hideStats();
    this.canvasTransform=this.node.getComponent(UITransform)!;
    const camera=this.node.getChildByName('Camera')?.getComponent(Camera);
    this.presentationCamera=camera??undefined;
    if(camera) camera.clearColor=new Color(...ORIGINAL_CAMERA_CLEAR.slice(0,3).map(c=>Math.round(c*255)) as [number,number,number],255);
    // Keep the startup page opaque while the world and hidden panels are built.
    // The cover owns the text so both disappear together only after readiness.
    this.startupInputBlock=makeNode('StartupInputBlock',this.node);
    this.startupInputBlock.addComponent(BlockInputEvents);
    this.startupInputBlock.addComponent(Graphics).fillColor=new Color(245,240,223,255);
    this.loading=makeNode('Loading',this.startupInputBlock);
    const initialSize=this.canvasTransform.contentSize;
    const message=this.loading.addComponent(Label);
    message.string='正在初始化游戏存档…';message.fontSize=27;message.color=new Color(88,67,44);
    message.enableWrapText=true;message.overflow=Label.Overflow.SHRINK;message.lineHeight=36;
    this.startupScreen=new StartupLoadingScreen(this.startupInputBlock,message);
    this.startupScreen.setProgress(.15);
    this.resizeStartupScreen(initialSize.width||720,initialSize.height||1280);
    game.on(Game.EVENT_HIDE,this.onHide,this);
    game.on(Game.EVENT_SHOW,this.onShow,this);
    // Browser Page Lifecycle freeze/resume can occur without a visibility change.
    if(typeof document!=='undefined') {
      document.addEventListener('freeze',this.onDocumentFreeze);
      document.addEventListener('resume',this.onDocumentResume);
    }
    view.on('canvas-resize',this.resize,this);
    let loadingAssets=true,versionLine='',failedModule='基础资源',moduleFailed=false;
    try {
      const scope=globalThis as typeof globalThis & {__FOREST_GUNNER_ENV__?:unknown;__FOREST_GUNNER_RELEASE__?:unknown};
      versionLine=typeof scope.__FOREST_GUNNER_RELEASE__==='string'?`版本 ${scope.__FOREST_GUNNER_RELEASE__}\n`:'';
      const environment=resolveRuntimeEnvironment(scope.__FOREST_GUNNER_ENV__,PREVIEW);
      const launchKey=`forest-gunner-${environment}-returning-player-v1`;
      // This marker selects a waiting budget only. Cache availability is always
      // determined by the platform/files, never by a previous successful launch.
      try {this.startupReturning=sys.localStorage.getItem(launchKey)==='1';}catch{}
      this.startupBudgetMs=this.startupReturning?RESOURCE_LOADING_POLICY.startup.warmBudgetMs:RESOURCE_LOADING_POLICY.startup.coldBudgetMs;
      this.startupBudget=new StartupPreparationBudget(this.startupStartedAt,this.startupReturning,()=>Date.now());
      this.audioPreferences=new AudioPreferences({environment,storage:sys.localStorage});
      const tutorialPreview=new TutorialPreviewController(environment,sys.localStorage,economyStorageKey(environment));
      const storage=tutorialPreview.storage;
      const measuredStorage=storage?{getItem:(key:string)=>storage.getItem(key),setItem:(key:string,value:string)=>
        this.loadingTrace.measure('session','storageWrite',()=>storage.setItem(key,value))}:storage;
      this.session=new BattleSession({environment,storage:measuredStorage,contentConfig:tutorialPreview.contentConfig,onWeaponsChanged:force=>this.syncLoadout(force?'equipment':'inventory')});
      if(this.session.offlineInitializationPending){
        failedModule='离线进度';
        while(!this.disposed){
          message.string=versionLine+'正在计算离线进度…';
          const initialized=await this.session.initializeOfflineProgress(async()=>{
            await new Promise<void>(resolve=>setTimeout(resolve,0));
            if(this.disposed)throw new Error('Offline initialization disposed');
          });
          if(this.disposed)return;
          if(initialized.ok)break;
          message.string=versionLine+'离线进度保存失败，请检查存储空间\n点击这里重试';
          if(!await this.waitOfflineRetry())return;
        }
        if(this.disposed)return;
      }
      this.offlineSummaryPending=!!this.session.offlineResult;
      this.dailyCheckAutoPending=this.session.getDailyCheckState().claimableIndex!==null;
      installWeChatFontFallback(assetManager.parser);
      if(WECHAT){
        // Leave headroom for WeChat subpackage delivery and avoid a burst of
        // simultaneous remote image/audio requests on mobile connections.
        Object.assign(assetManager.downloader,RESOURCE_LOADING_POLICY.wechat);
      }
      message.string=versionLine+'正在准备森林资源…';
      const art=this.artLibrary=new ArtLibrary();
      art.resourceLoader.setStartupPhase(true);
      // Offline settlement has fixed the required set. Warm its first panels
      // during core loading, using the same low-priority download cache later.
      this.startupModules=RESOURCE_MODULE_ORDER.filter(name=>isStartupModule(name,
        name==='settings'||name==='offline'||this.session.getContentState(name).unlocked,this.offlineSummaryPending));
      this.resourcePreloader=new GameResourcePreloader(art.resourceLoader,()=>Date.now(),sys.localStorage,`forest-gunner-${environment}-feature-usage-v1`);
      this.resourcePreloader.start(true);
      this.startupScreen.resourceStatus=()=>art.resourceLoader.loadingStatus();
      let completedAssets=0;
      this.startupScreen?.setProgress(.20);
      const totalGroups=14;
      // CatView starts with weapon 0 before applying the saved squad loadout.
      const initialWeaponIds=Array.from(new Set([0,...this.session.combatLoadout.map(actor=>actor.weapon.id)]));
      let completedGroups=0;
      const pendingGroups=new Map<string,number>();
      const showModules=():void=>{
        this.startupScreen?.setProgress(.20+.50*completedGroups/totalGroups);
        if(loadingAssets&&!this.disposed&&!this.backgrounded&&message.isValid){
          let waiting:{name:string;started:number}|undefined;
          pendingGroups.forEach((started,name)=>{if(!waiting||started<waiting.started)waiting={name,started};});
          const seconds=waiting?Math.max(0,Math.floor((Date.now()-waiting.started)/1000)):0;
          message.string=`${versionLine}${waiting?`等待：${waiting.name}（已等待 ${seconds} 秒）`:'正在创建战场…'}\n模块已完成 ${completedGroups}/${totalGroups} · 资源已完成 ${completedAssets} 项`;
        }
      };
      this.startupProgress=showModules;this.startupProgressNextAt=Date.now()+1000;
      art.onAssetLoaded=completed=>{completedAssets=completed;showModules();};
      const loadGroup=<T>(name:string,task:Promise<T>):Promise<T>=>{
        const started=Date.now();pendingGroups.set(name,started);showModules();
        return task.then(value=>{
          if(loadingAssets&&!this.disposed)console.info(`[ForestGunner] 模块完成：${name}，耗时 ${Math.max(0,Date.now()-started)} ms`);
          completedGroups++;pendingGroups.delete(name);showModules();return value;
        },error=>{
          // The longest pending module is not necessarily the one that failed.
          if(!moduleFailed){moduleFailed=true;failedModule=name;}
          throw error;
        });
      };
      // Independent resource groups overlap from the start. Only the map waits
      // for ArtLibrary's catalog; its loader writes stageTrees into that catalog.
      // All promises join the same barrier so a failure cannot leave an
      // unhandled rejection or publish a partially initialized battlefield.
      const baseReady=loadGroup('基础美术',art.load());
      const fontReady=loadGroup('启动字体',(async()=>{
        const fontConfig=await art.json<OriginalHudConfig>('art/hud/config');
        await Promise.all(fontConfig.bitmapFont.pages.map(path=>art.loadFrame(path)));
        if(this.disposed||!loadingAssets)return;
        if(!this.startupScreen?.available)this.loadingText=attachFontPolicyLabel(message,art,fontConfig.bitmapFont);
      })());
      const petVisuals=this.petVisuals=new PetVisualAssets(art);
      const [feedback,map,colorEffects,hudAssets,moneyBurst,moneyNumbers,,alertAssets,sfxAssets,tutorialAssets,skinVisuals]=await Promise.all([
        loadGroup('战斗反馈',loadOriginalFeedback(art)),loadGroup('森林地图',baseReady.then(()=>{
          if(this.disposed||!loadingAssets)throw new Error('Startup preparation cancelled');
          return OriginalMapView.load(art,this.session.round.stageIndex);
        })),loadGroup('画面渲染',OriginalColorPipeline.load(art)),
        loadGroup('主界面',loadOriginalHudAssets(art)),loadGroup('金币效果',loadOriginalMoneyBurst(art)),loadGroup('伤害数字',loadOriginalMoneyNumbers(art)),
        loadGroup('武器外观',WeaponVisualAssets.load(art,initialWeaponIds)),loadGroup('提示消息',loadOriginalAlertAssets(art)),
        loadGroup('游戏音效',loadOriginalSfxAssets(art,[])),
        loadGroup('新手引导',loadTutorialHudAssets(art)),
        loadGroup('当前皮肤外观',SkinVisualAssets.load(art,this.session.getSkinState().selectedId)),
        loadGroup('当前宠物外观',petVisuals.prepare(this.session.getPetState().selected)),
        baseReady,fontReady,
      ]);
      loadingAssets=false;art.onAssetLoaded=undefined;
      if(this.disposed)return;
      failedModule='创建战场';
      message.string=versionLine+'正在创建战场与主界面…';
      this.skinVisuals=skinVisuals;this.battleAssets=new BattleAssetLoader(art,map);
      const round=this.session.round;
      this.world=new CombatWorld(this.seed,createStageDefinition(round.stageIndex,round.waveIndex,this.seed));
      this.worldRoundId=round.roundId;
      this.world.setMovementMultiplier(round.movementMultiplier);
      this.syncLoadout();
      if(!camera)throw new Error('Missing presentation camera');
      this.colors=new OriginalColorPipeline(this.node,camera,art,colorEffects);
      this.worldScale=makeNode('WorldScale',this.colors.world);
      this.sfx=new OriginalSfx(this.node,sfxAssets);
      this.sfx.setEnabled(this.audioPreferences.soundEnabled);
      this.battlefield=new BattlefieldView(art,this.world,this.worldScale,feedback,map,moneyBurst,moneyNumbers,this.sfx);
      this.battlefield.setSkin(this.session.getSkinState().selectedId);
      this.syncPets();
      this.world.setMuzzleProvider(context=>this.battlefield!.prepareCatPose(context));
      // Own the root before GameHud constructs its children, including failures.
      this.hudRoot=makeNode('GameInterface',this.node);
      const hudRoot=this.hudRoot;
      this.hud=new GameHud(this.hudRoot,art,hudAssets,()=>this.restart(),type=>this.purchaseUpgrade(type),this.sfx,()=>this.openSettings(),
        (direction,cancelled)=>cancelled?this.world.clearMovementInput():this.world.setMovementInput(direction));
      this.alerts=new OriginalAlerts(this.hudRoot,art,alertAssets);
      // Release policy controls construction as well as each business entry.
      // Production never offers the test modal's manual success button.
      if(this.session.content.config.adsEnabled) {
        let adProvider:RewardedAdProvider=new UnavailableRewardedAdProvider();
        if(environment==='test') {
          const simulated=new SimulatedRewardedAdProvider({
            open:id=>this.rewardedAdModal!.open(id),dismiss:()=>this.rewardedAdModal?.dismiss(),
          });
          this.rewardedAdModal=new RewardedAdModal(this.hudRoot,(id,outcome)=>simulated.resolve(id,outcome));
          adProvider=simulated;
        }
        this.rewardedAds=new RewardedAdService(adProvider,()=>this.syncModalState(),placement=>this.session.content.isAdEnabled(placement));
      }
      const prepareWeaponChoices=async():Promise<void>=>{
        await art.weaponVisuals?.prepareAll();
        if(this.disposed||this.artLibrary!==art)return;
        // These effects remain in use after the inventory closes. Protect them
        // from an unrelated hidden panel's shared-image memory reclamation.
        art.weaponVisuals?.loadedFramePaths.forEach(path=>this.coreResourcePaths.add(path));
      };
      const loadWithWeaponChoices=async<T>(load:()=>Promise<T>):Promise<T>=>{
        // Panel images and combat choices are independent, but both must be
        // ready before constructing a panel that can equip any weapon.
        const [assets]=await Promise.all([load(),prepareWeaponChoices()]);return assets;
      };
      const createWeaponHud=async(assets:Awaited<ReturnType<typeof loadWeaponHudAssets>>):Promise<void>=>{
        this.weaponsHud=await this.prepareFeatureHud('weapons',()=>new WeaponHud(hudRoot,art,assets,this.session,this.alerts!,()=>this.syncModalState(),this.sfx,this.rewardedAds,
          this.hudPreparation('weapons'),this.hudPreparation('weaponCollection')));
        if(this.weaponsHud){
          this.weaponsHud.onCollectionRequested=()=>this.resourceModules.open('weaponCollection');
          if(assets.config){
            const main=new Set(weaponPanelImagePaths(assets.config));
            this.moduleAssetPaths.set('weaponCollection',new Set(Object.values(assets.config.images).map(image=>image.path).filter(path=>!main.has(path))));
          }
        }
      };
      const createRebirthHud=async(assets:Awaited<ReturnType<typeof loadRebirthHudAssets>>):Promise<void>=>{this.rebirthHud=await this.prepareFeatureHud('rebirth',()=>new RebirthHud(hudRoot,art,assets,{
        getState:()=>this.session.getRebirthState(),
        requestRebirth:kind=>this.requestRebirth(kind),
        completeAd:(token,outcome)=>{
          const result=this.session.completeRebirthAd(token,outcome);
          if(result.ok&&this.session.rebirthAnimating)this.beginRebirthPresentation();
          return result;
        },
        cancelAd:()=>this.session.cancelRebirthAd(),
        purchaseUpgrade:type=>this.purchaseRebirthUpgrade(type),
        onBeforeOpen:()=>{this.hud?.cancelInteractions();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.settingsHud?.close();this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();this.weaponsHud?.close();this.speedRunHud?.close();this.raidHud?.close();this.bossHud?.close();this.huntHud?.close();this.mineHud?.close();},
        onVisibilityChanged:()=>this.syncModalState(),
        alert:text=>this.alerts?.show(text),
        playSfx:id=>this.sfx?.play(id),
      },this.rewardedAds,this.hudPreparation('rebirth')));};
      const createSpeedRunHud=async(assets:Awaited<ReturnType<typeof loadSpeedRunHudAssets>>):Promise<void>=>{this.speedRunHud=await this.prepareFeatureHud('speedrun',()=>new SpeedRunHud(hudRoot,art,assets,{
        getState:()=>this.session.getSpeedRunState(),getPhase:()=>this.session.getModePhase('SpeedRun'),
        start:()=>this.startSpeedRun(),exit:()=>this.exitSpeedRun(),
        beginAd:()=>this.session.beginSpeedRunAd(),
        completeAd:(token,outcome)=>this.session.completeSpeedRunAd(token,outcome),
        cancelAd:()=>this.session.cancelSpeedRunAd(),
        onBeforeOpen:()=>{this.hud?.cancelInteractions();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.settingsHud?.close();this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();this.weaponsHud?.close();this.rebirthHud?.close();this.raidHud?.close();this.bossHud?.close();this.huntHud?.close();this.mineHud?.close();},
        onVisibilityChanged:()=>this.syncModalState(),
        alert:text=>this.alerts?.show(text),playSfx:id=>this.sfx?.play(id),
      },this.rewardedAds,this.hudPreparation('speedrun')));};
      const createRaidHud=async(assets:Awaited<ReturnType<typeof loadRaidHudAssets>>):Promise<void>=>{this.raidHud=await this.prepareFeatureHud('raid',()=>new RaidHud(hudRoot,art,assets,{
        getState:()=>this.session.getRaidState(),getPhase:()=>this.session.getModePhase('Raid'),
        getWallet:()=>({money:this.session.moneyBalance.format(),diamonds:String(this.session.weapons.diamonds)}),
        getSlotStars:()=>this.session.weapons.snapshot().stars.map(star=>star.level),
        getStarUnlocked:()=>this.session.weapons.snapshot().starUnlocked,
        open:()=>this.session.openRaid(),close:()=>this.session.closeRaid(),
        start:()=>this.startRaid(),exit:()=>this.exitRaid(),
        selectWeapon:(slot,source)=>this.session.selectRaidWeapon(slot,source),
        unselectWeapon:slot=>this.session.unselectRaidWeapon(slot),
        autoSelectWeapons:()=>this.session.autoSelectRaidWeapons(),
        claimMission:index=>this.session.claimRaidMission(index),
        openStarUpgrade:slot=>this.openRaidStarUpgrade(slot),
        beginAd:()=>this.session.beginRaidAd(),
        completeAd:(token,outcome)=>this.completeRaidAd(token,outcome),
        cancelAd:()=>this.session.cancelRaidAd(),
        onBeforeOpen:()=>{this.hud?.cancelInteractions();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.settingsHud?.close();this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();this.weaponsHud?.close();this.rebirthHud?.close();this.speedRunHud?.close();this.bossHud?.close();this.huntHud?.close();this.mineHud?.close();},
        onVisibilityChanged:()=>this.syncModalState(),
        alert:text=>this.alerts?.show(text),playSfx:id=>this.sfx?.play(id),
      },this.rewardedAds,this.hudPreparation('raid')));};
      const createBossHud=async(assets:Awaited<ReturnType<typeof loadBossHudAssets>>):Promise<void>=>{this.bossHud=await this.prepareFeatureHud('boss',()=>new BossHud(hudRoot,art,assets,{
        getState:()=>this.session.getBossState(this.world.stage.boss),
        start:()=>this.startBoss(),exit:()=>this.exitBoss(),
        beginAd:()=>this.session.beginBossAd(),
        completeAd:(token,outcome)=>this.completeBossAd(token,outcome),
        cancelAd:()=>this.session.cancelBossAd(),
        onBeforeOpen:()=>{this.hud?.cancelInteractions();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.settingsHud?.close();this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();this.weaponsHud?.close();this.rebirthHud?.close();this.speedRunHud?.close();this.raidHud?.close();this.huntHud?.close();this.mineHud?.close();},
        onVisibilityChanged:()=>this.syncModalState(),
        alert:text=>this.alerts?.show(text),playSfx:id=>this.sfx?.play(id),
      },this.rewardedAds,this.hudPreparation('boss')));};
      const createHuntHud=async(assets:Awaited<ReturnType<typeof loadHuntHudAssets>>):Promise<void>=>{this.huntHud=await this.prepareFeatureHud('hunt',()=>new HuntHud(hudRoot,art,assets,{
        getState:()=>this.session.getHuntState(),getPhase:()=>this.session.getModePhase('Monster'),
        start:()=>this.startHunt(),giveUp:()=>this.giveUpHunt(),exit:()=>this.exitHunt(),
        beginAd:()=>this.session.beginHuntAd(),
        completeAd:(token,outcome)=>this.completeHuntAd(token,outcome),
        cancelAd:()=>this.session.cancelHuntAd(),
        retrySettlement:()=>this.session.retryHuntSettlement(),
        onBeforeOpen:()=>{this.hud?.cancelInteractions();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.settingsHud?.close();this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();this.weaponsHud?.close();this.rebirthHud?.close();this.speedRunHud?.close();this.raidHud?.close();this.bossHud?.close();this.mineHud?.close();},
        onVisibilityChanged:()=>this.syncModalState(),
        alert:text=>this.alerts?.show(text),playSfx:id=>this.sfx?.play(id),
      },this.rewardedAds,this.hudPreparation('hunt')));};
      const createMineHud=async(assets:Awaited<ReturnType<typeof loadMineHudAssets>>):Promise<void>=>{this.mineHud=await this.prepareFeatureHud('mine',()=>new MineHud(hudRoot,art,assets,{
        getState:()=>this.session.getMineState(),getPhase:()=>this.session.getModePhase('Mine'),open:()=>this.session.openMine(),close:()=>this.session.closeMine(),
        start:()=>this.startMine(),exit:()=>this.exitMine(),
        retrySettlement:()=>this.session.retryMineSettlement(),
        beginAd:kind=>this.session.requestMineAd(kind),completeAd:(token,outcome)=>this.completeMineAd(token,outcome),
        cancelAd:()=>this.session.cancelMineAd(),
        onBeforeOpen:()=>{this.hud?.cancelInteractions();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.settingsHud?.close();this.weaponsHud?.close();this.rebirthHud?.close();this.speedRunHud?.close();this.raidHud?.close();this.bossHud?.close();this.huntHud?.close();this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();},
        onVisibilityChanged:()=>this.syncModalState(),alert:text=>this.alerts?.show(text),playSfx:id=>this.sfx?.play(id),
      },this.rewardedAds,this.hudPreparation('mine')));};
      const registerHud=<T>(name:BackgroundFeature,load:()=>Promise<T>,create:(assets:T)=>Promise<void>):(()=>Promise<void>)=>{
        this.resourceModules.register(name,{load:async valid=>{
          const assets=await load(),config=(assets as {config?:unknown})?.config;
          if(!valid()||this.disposed||this.artLibrary!==art)throw new Error('HUD asset preparation invalidated');
          if(config)this.moduleAssetPaths.set(name,new Set(collectBackgroundResources(config,name)
            .filter(resource=>resource.kind==='image').map(resource=>resource.path)));
          return assets;
        },create:async(assets,valid)=>{
          if(!valid()||this.disposed||!this.preparationReady||!hudRoot.isValid)throw new Error('HUD preparation cancelled');
          this.moduleGuards.set(name,valid);
          try {await create(assets);} finally {this.moduleGuards.delete(name);}
        },dispose:()=>this.releaseModuleView(name)});
        return ()=>this.resourceModules.prepare(name);
      };
      const createSkinHud=async(assets:Awaited<ReturnType<typeof loadSkinHudAssets>>):Promise<void>=>{this.skinHud=await this.prepareFeatureHud('skins',()=>new SkinHud(hudRoot,art,assets,{
        getState:()=>this.session.getSkinState(),
        getContentState:()=>this.session.getContentState('skins'),
        purchase:id=>this.purchaseSkin(id),equip:id=>this.equipSkin(id),
        prepare:id=>this.prepareSkin(id),
        onBeforeOpen:()=>{this.hud?.cancelInteractions();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.settingsHud?.close();this.weaponsHud?.close();this.rebirthHud?.close();this.speedRunHud?.close();this.raidHud?.close();this.bossHud?.close();this.huntHud?.close();this.mineHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();},
        onVisibilityChanged:()=>this.syncModalState(),
        alert:text=>this.alerts?.show(text),playSfx:id=>this.sfx?.play(id),
      },{camera,effects:colorEffects,trace:(phase,ms)=>this.loadingTrace.mark('skins',phase,ms)},this.hudPreparation('skins')));};
      const createPetHud=async(assets:Awaited<ReturnType<typeof loadPetHudAssets>>):Promise<void>=>{this.petHud=await this.prepareFeatureHud('pets',()=>new PetHud(hudRoot,art,assets,{
        getState:()=>this.session.getPetState(),getContentState:()=>this.session.getContentState('pets'),
        getDailyAdState:()=>this.session.getContentState('petDailyAd'),
        beginAd:()=>this.session.beginPetAd(),
        completeAd:(token,outcome)=>{const result=this.session.completePetAd(token,outcome);if(result.ok){this.syncPets();this.hud?.update(this.hudState());}return result;},
        cancelAd:()=>this.session.cancelPetAd(),
        draw:currency=>this.petCommand(()=>this.session.drawPet(currency)),
        move:(from,to,grade,vacancy)=>this.petCommand(()=>this.session.movePet(from,to,grade,vacancy)),
        unequip:index=>this.petCommand(()=>this.session.unequipPet(index)),
        merge:(from,to,grade,automatic)=>this.petCommand(()=>this.session.mergePets(from,to,grade,automatic)),
        setAuto:enabled=>this.petCommand(()=>this.session.setPetAutoMerge(enabled)),
        prepare:grades=>petVisuals.prepare(grades),
        onBeforeOpen:()=>{this.hud?.cancelInteractions();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.settingsHud?.close();this.weaponsHud?.close();this.rebirthHud?.close();this.speedRunHud?.close();this.raidHud?.close();this.bossHud?.close();this.huntHud?.close();this.mineHud?.close();this.skinHud?.close();this.fishHud?.close();this.adventureHud?.close();},
        onVisibilityChanged:()=>this.syncModalState(),alert:text=>this.alerts?.show(text),playSfx:id=>this.sfx?.play(id),
      },{camera,effects:colorEffects,trace:(phase,ms)=>this.loadingTrace.mark('pets',phase,ms)},this.rewardedAds,this.hudPreparation('pets')));};
      const createFishHud=async(assets:Awaited<ReturnType<typeof loadFishHudAssets>>):Promise<void>=>{this.fishHud=await this.prepareFeatureHud('fish',()=>new FishHud(hudRoot,art,assets,{
        getState:()=>this.session.getFishState(),getContentState:()=>this.session.getContentState('fish'),
        getDailyAdState:()=>this.session.getContentState('fishDailyAd'),
        draw:kind=>this.fishCommand(()=>this.session.drawFish(kind)),
        merge:(from,to,grade,automatic,revision)=>this.fishCommand(()=>this.session.mergeFish(from,to,grade,automatic,revision)),
        remove:(index,grade,revision)=>this.fishCommand(()=>this.session.removeFish(index,grade,revision)),
        setAuto:enabled=>this.fishCommand(()=>this.session.setFishAutoMerge(enabled)),
        beginAd:()=>this.session.beginFishAd(),
        completeAd:(token,outcome)=>{const result=this.session.completeFishAd(token,outcome);if(result.ok){this.syncLoadout('upgrade');this.hud?.update(this.hudState());}return result;},
        cancelAd:()=>this.session.cancelFishAd(),
        onBeforeOpen:()=>{this.hud?.cancelInteractions();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.settingsHud?.close();this.weaponsHud?.close();this.rebirthHud?.close();this.speedRunHud?.close();this.raidHud?.close();this.bossHud?.close();this.huntHud?.close();this.mineHud?.close();this.skinHud?.close();this.petHud?.close();},
        onVisibilityChanged:()=>this.syncModalState(),alert:text=>this.alerts?.show(text),playSfx:id=>this.sfx?.play(id),
      },{camera,effects:colorEffects,trace:(phase,ms)=>this.loadingTrace.mark('fish',phase,ms)},this.rewardedAds,this.hudPreparation('fish')));};
      const createAdventureHud=async(assets:Awaited<ReturnType<typeof loadAdventureHudAssets>>):Promise<void>=>{
        this.adventureHud=await this.prepareFeatureHud('adventure',()=>new AdventureHud(hudRoot,art,assets,{
          getState:()=>this.session.getAdventureState(),getPetState:()=>this.session.getPetState(),
          getRelicState:()=>this.session.getRelicState(),getContentState:()=>this.session.getContentState('adventure'),
          getAdState:()=>this.session.getContentState('adventureAd'),
          preview:(type,index,pets)=>this.session.previewAdventure(type,index,pets),
          start:(type,index,pets)=>this.adventureResult(this.session.startAdventure(type,index,pets)),
          cancel:(type,index)=>this.adventureResult(this.session.cancelAdventure(type,index)),
          claim:(type,index)=>this.adventureResult(this.session.claimAdventure(type,index)),
          drawRelic:(core,max)=>this.adventureResult(this.session.drawRelic(core,max),true),
          upgradeRelic:index=>this.adventureResult(this.session.upgradeRelic(index),true),
          beginAd:(type,index)=>this.session.beginAdventureAd(type,index),
          completeAd:(token,outcome)=>this.session.completeAdventureAd(token,outcome),
          cancelAd:()=>this.session.cancelAdventureAd(),
          onBeforeOpen:()=>{
            this.hud?.cancelInteractions();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.settingsHud?.close();
            [this.weaponsHud,this.rebirthHud,this.speedRunHud,this.raidHud,this.bossHud,this.huntHud,this.mineHud,this.skinHud,this.petHud,this.fishHud].forEach(hud=>hud?.close());
          },
          onVisibilityChanged:()=>this.syncModalState(),alert:text=>this.alerts?.show(text),playSfx:id=>this.sfx?.play(id),
        },{camera,effects:colorEffects,trace:(phase,ms)=>this.loadingTrace.mark('adventure',phase,ms)},this.rewardedAds,this.hudPreparation('adventure')));
      };
      this.deferredHudLoaders={
        weapons:registerHud('weapons',()=>loadWithWeaponChoices(()=>loadWeaponHudAssets(art)),createWeaponHud),
        raid:registerHud('raid',()=>loadWithWeaponChoices(()=>loadRaidHudAssets(art)),createRaidHud),
        boss:registerHud('boss',()=>loadBossHudAssets(art),createBossHud),
        speedrun:registerHud('speedrun',()=>loadSpeedRunHudAssets(art),createSpeedRunHud),
        rebirth:registerHud('rebirth',()=>loadRebirthHudAssets(art),createRebirthHud),
        skins:registerHud('skins',()=>loadSkinHudAssets(art),createSkinHud),
        pets:registerHud('pets',()=>loadPetHudAssets(art),createPetHud),
        fish:registerHud('fish',()=>loadFishHudAssets(art),createFishHud),
        hunt:registerHud('hunt',()=>loadHuntHudAssets(art),createHuntHud),
        mine:registerHud('mine',()=>loadMineHudAssets(art),createMineHud),
        adventure:registerHud('adventure',()=>loadAdventureHudAssets(art,petVisuals),createAdventureHud),
      };
      // Settings loads its panel and Latin input font on demand. Chinese input
      // uses the system font and adds no download to startup or first open.
      registerHud('settings',()=>loadSettingsHudAssets(art),async settingsAssets=>{
        await this.prepareFeatureHud('settings',()=>new SettingsHud(this.hudRoot!,art,settingsAssets,{
        getState:()=>({bgmEnabled:this.audioPreferences!.bgmEnabled,soundEnabled:this.audioPreferences!.soundEnabled}),
        redeemCode:code=>this.session.redeemCode(code),
        toggleBgm:()=>{
          const prefs=this.audioPreferences!;prefs.setBgmEnabled(!prefs.bgmEnabled);this.bgm?.setEnabled(prefs.bgmEnabled);
          if(prefs.bgmEnabled)void this.loadBgm();
        },
        toggleSound:()=>{const prefs=this.audioPreferences!;prefs.setSoundEnabled(!prefs.soundEnabled);this.sfx?.setEnabled(prefs.soundEnabled);if(prefs.soundEnabled)this.warmCombatSounds();},
        onBeforeOpen:()=>{this.hud?.cancelInteractions();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.weaponsHud?.close();this.rebirthHud?.close();this.speedRunHud?.close();this.raidHud?.close();this.bossHud?.close();this.huntHud?.close();this.mineHud?.close();this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();},
        onVisibilityChanged:()=>this.syncModalState(),
        alert:text=>this.alerts?.show(text),playSfx:id=>this.sfx?.play(id),
        },{camera,effects:colorEffects,trace:(phase,ms)=>this.loadingTrace.mark('settings',phase,ms)},this.hudPreparation('settings')));
      });
      this.settingsHudLoader=async()=>{await this.resourceModules.prepare('settings');return this.settingsHud;};
      this.tutorialHud=new TutorialHud(this.hudRoot,art,tutorialAssets);
      registerHud('dailyCheck',()=>loadDailyCheckHudAssets(art),async assets=>{
        // The full panel already owns the entry artwork. Include its small
        // entry in startup preparation so the first interactive frame can use it.
        if(!this.ready&&!this.dailyCheckEntry)await this.uiPreparation.run('dailyCheck',(function*(this:GameBootstrap){
          if(this.disposed||!this.preparationReady||!hudRoot.isValid||this.moduleGuards.get('dailyCheck')?.()===false)throw new Error('Daily entry preparation cancelled');
          const entry=new DailyCheckEntry(hudRoot,art,assets,()=>{void this.openDailyCheck();},id=>this.sfx?.play(id));
          try {
            const {top,bottom}=this.safeAreaInsets();entry.resize(this.viewport.width,this.viewport.height,top,bottom);
            entry.setVisible(false);entry.setBlocked(true);
            const overlay=this.tutorialHud?.node;if(overlay)entry.node.setSiblingIndex(overlay.getSiblingIndex());
            this.dailyCheckEntry=entry;
          }catch(error){entry.destroy();throw error;}
        }).call(this),'entry');
        await this.prepareFeatureHud('dailyCheck',()=>new DailyCheckHud(hudRoot,art,assets,{
          getState:()=>this.session.getDailyCheckState(),claim:index=>this.session.claimDailyCheck(index),
          getWallet:()=>({money:this.session.moneyBalance.format(),diamonds:this.session.weapons.diamonds}),
          getFallbackDiamondTarget:()=>this.hud?.getDiamondTarget()??null,
          onBeforeOpen:()=>{this.hud?.cancelInteractions();this.world.clearMovementInput();},
          onVisibilityChanged:()=>{this.syncModalState();this.updateTutorial(0);},
          playSfx:id=>this.sfx?.play(id),alert:text=>this.alerts?.show(text),
        },{camera,effects:colorEffects,trace:(phase,ms)=>this.loadingTrace.mark('dailyCheck',phase,ms)},this.hudPreparation('dailyCheck')));
      });
      this.dailyCheckHudLoader=async()=>{await this.resourceModules.prepare('dailyCheck');return this.dailyCheckHud;};
      registerHud('offline',()=>loadOfflineHudAssets(art),async assets=>{
        await this.prepareFeatureHud('offline',()=>new OfflineHud(hudRoot,art,assets,{
          getState:()=>this.offlineState(),close:()=>this.closeOfflineSummary(),
          playSfx:id=>this.sfx?.play(id),onVisibilityChanged:()=>this.syncModalState(),
        },{camera,effects:colorEffects,trace:(phase,ms)=>this.loadingTrace.mark('offline',phase,ms)},this.hudPreparation('offline')));
      });
      this.offlineHudLoader=async()=>{await this.resourceModules.prepare('offline');return this.offlineHud;};
      this.resourceModules.register('weaponCollection',{
        dependencies:['weapons'],load:async()=>{await this.weaponsHud!.prepareCollectionAssets();},
        create:async(_assets,valid)=>{if(!valid())throw new Error('Collection preparation cancelled');await this.weaponsHud!.warmCollection();},
        dispose:()=>this.weaponsHud?.releaseCollection(),
      });
      this.startupInputBlock!.setSiblingIndex(this.node.children.length-1);
      this.resize();this.preparationReady=true;this.startupCoreReadyAt=Date.now();
      this.coreResourcePaths=new Set(art.frames.keys());
      this.backgroundPreparation.reset(0);
      this.resourcePreloader.setDemand('offline',this.offlineSummaryPending);
      this.resourcePreloader.setDemand('dailyCheck',this.dailyCheckPreparationDemand);
      this.startupProgress=()=>{
        const completed=this.startupModules.filter(name=>this.resourceModules.isViewReady(name)).length;
        this.startupScreen?.setProgress(.75+.24*completed/Math.max(1,this.startupModules.length));
        const name=this.startupCurrent,label=name==='settings'?'设置界面':name==='dailyCheck'?'签到界面':name==='offline'?'离线收益界面':name?DEFERRED_HUD_LABELS[name]:'常用界面';
        if(message.isValid)message.string=this.startupFailure?
          `${versionLine}${label}准备失败\n${this.startupFailure}\n点击这里重试（已完成 ${completed}/${this.startupModules.length}）`:
          `${versionLine}正在准备${label} ${completed}/${this.startupModules.length}…`;
      };
      this.loading.on(Node.EventType.TOUCH_END,this.retryStartupPreparation,this);
      this.startupInputBlock?.on(Node.EventType.TOUCH_END,this.retryStartupPreparation,this);
      // Read-only loading evidence is also available in production experience
      // builds. Do not expose the test API's gameplay or reward commands here.
      this.loadingDiagnosticsApi=Object.freeze({snapshot:()=>this.resourceLoadingSnapshot()});
      (globalThis as typeof globalThis & {__forestGunnerLoading?:object}).__forestGunnerLoading=this.loadingDiagnosticsApi;
      this.startupProgress();
      // Deadlines are diagnostics only. Every required view must be operable
      // before the shield is removed, including on a returning player's launch.
      await new Promise<void>(resolve=>{this.startupRelease=resolve;this.checkStartupRelease();});
      if(this.disposed)return;
      art.resourceLoader.setStartupPhase(false);
      this.startupProgress=undefined;this.ready=true;this.startupInteractiveAt=Date.now();
      try {sys.localStorage.setItem(launchKey,'1');}catch{}
      this.installMemoryWarning();
      this.prefetchAt=Date.now()+RESOURCE_LOADING_POLICY.nextStageDelayMs;this.warmCombatSounds();this.updateDeferredHuds();
      this.offlineCheckpointAt=Date.now()+10000;
      if(this.offlineSummaryPending)void this.loadOfflineHud();
      this.syncModalState();
      this.hud.update(this.hudState());
      this.updateTutorial(0);
      this.startupScreen?.setProgress(1);
      this.startupScreen?.destroy();this.startupScreen=undefined;
      this.loadingText?.destroy();this.loadingText=undefined;
      this.startupInputBlock?.destroy();this.startupInputBlock=undefined;this.loading=undefined;
      this.backgroundPreparation.reset();
      if(this.backgrounded)this.resourcePreloader.pause();
      // The test build also exposes diagnostics in WeChat where DEBUG is false.
      // Reward injection commands remain absent from production diagnostics.
      if(DEBUG||environment==='test') {
        this.debugApi={
          preload:()=>this.resourceLoadingSnapshot(),
          preparationMode:(mode:'download-only'|'decode'|'full')=>{this.resourcePreloader?.setMode(mode);return this.resourcePreloader?.mode;},
        snapshot:()=>({stats:{...this.world.stats},player:this.world.player,trees:this.world.trees,
          activeBullets:this.world.bullets.filter(x=>x.active).length,nodeCount:this.countNodes(this.node),
          paused:this.manuallyPaused,backgrounded:this.backgrounded,viewport:this.viewport,
          movementInput:this.world.currentMovementInput,
          hud:this.hudState(),effects:this.battlefield!.diagnostics(),combatModifiers:this.session.combatModifiers,
          players:this.world.players,weapons:this.session.weapons.snapshot(),loadout:this.session.combatLoadout,weaponPopup:!!this.weaponsHud?.isOpen,
          rebirth:this.session.getRebirthState(),rebirthPopup:!!this.rebirthHud?.isOpen,
          speedRun:this.session.getSpeedRunState(),speedRunPopup:!!this.speedRunHud?.isOpen,
          raid:this.session.getRaidState(),raidPopup:!!this.raidHud?.isOpen,
          boss:this.session.getBossState(this.world.stage.boss),bossPopup:!!this.bossHud?.isOpen,
          mine:this.session.getMineState(),minePopup:!!this.mineHud?.isOpen,ores:this.world.stage.ores,
          hunt:this.session.getHuntState(),huntPopup:!!this.huntHud?.isOpen,
          adventure:this.session.getAdventureState(),relics:this.session.getRelicState(),adventurePopup:!!this.adventureHud?.isOpen,
          skins:this.session.getSkinState(),skinPopup:!!this.skinHud?.isOpen,pets:this.session.getPetState(),petPopup:!!this.petHud?.isOpen,fish:this.session.getFishState(),fishPopup:!!this.fishHud?.isOpen,
          audio:{bgmEnabled:this.audioPreferences!.bgmEnabled,soundEnabled:this.audioPreferences!.soundEnabled},
          settingsPopup:!!this.settingsHud?.isOpen,redeemPopup:!!this.settingsHud?.isRedeemOpen,
          offline:this.offlineState(),offlinePopup:!!this.offlineHud?.isOpen,
          dailyCheck:this.session.getDailyCheckState(),dailyCheckPopup:!!this.dailyCheckHud?.isOpen,
          tutorial:this.session.getTutorialState()}),
        restart:(seed?:number)=>{if(seed!==undefined)this.seed=seed;this.restart();},
        pause:()=>{if(!this.manuallyPaused)this.togglePause();},
        resume:()=>{if(this.manuallyPaused)this.togglePause();},
        background:(hidden:boolean)=>game.emit(hidden?Game.EVENT_HIDE:Game.EVENT_SHOW),
        setMode:(mode:BattleMode)=>this.setBattleMode(mode),
        upgrade:(type:UpgradeType)=>this.purchaseUpgrade(type),
        ...(environment==='test'?{settings:{
          open:()=>this.openSettings(),close:()=>{this.cancelSettingsOpening();this.settingsHud?.close();this.syncModalState();},
        },offline:{
          state:()=>this.offlineState(),retry:()=>this.loadOfflineHud(),
          close:()=>this.closeOfflineSummary(),
        },dailyCheck:{
          state:()=>this.session.getDailyCheckState(),open:()=>this.openDailyCheck(),
          close:()=>{this.cancelDailyCheckOpening();this.dailyCheckHud?.close();this.syncModalState();},
        },tutorial:{
          state:()=>this.session.getTutorialState(),preview:tutorialPreview.active,
          replay:()=>this.restartForTutorial(()=>tutorialPreview.requestReplay()),
          exitReplay:()=>this.restartForTutorial(()=>tutorialPreview.requestExit()),
        },content:{
          state:(id:ContentId)=>this.session.getContentState(id),
          refillResources:()=>{
            const ok=this.session.refillTestResources();if(ok){this.syncLoadout('upgrade');this.hud?.update(this.hudState());this.rebirthHud?.update(0);this.speedRunHud?.update(0);}return ok;
          },
        },progression:{
          configure:(config:Parameters<BattleSession['configureProgressionTest']>[0])=>{
            if(!this.session.configureProgressionTest(config))return false;
            this.activateRound(this.session.round);return true;
          },
          stepFrames:(frames:number,dt=1/60)=>{
            if(!Number.isInteger(frames)||frames<0||frames>20000||!Number.isFinite(dt)||dt<=0||dt>COMBAT_CONFIG.maxFrameTime)throw new Error('Invalid test frame request');
            for(let i=0;i<frames;i++)this.update(dt);
            return this.hudState();
          },
        },speedRun:{
          open:()=>this.openFeature('speedrun'),close:()=>this.speedRunHud?.close(),
          start:()=>this.startSpeedRun(),exit:()=>this.exitSpeedRun(),
          configure:(config:Parameters<BattleSession['configureSpeedRunTest']>[0])=>{
            const ok=this.session.configureSpeedRunTest(config);if(ok)this.speedRunHud?.update(0);return ok;
          },
          beginAd:()=>this.session.beginSpeedRunAd(),
          completeAd:(token:string,outcome:AdOutcome)=>this.session.completeSpeedRunAd(token,outcome),
        },boss:{
          state:()=>this.session.getBossState(this.world.stage.boss),
          open:()=>this.openFeature('boss'),close:()=>this.bossHud?.close(),
          start:()=>this.startBoss(),exit:()=>this.exitBoss(),
          configure:(config:Parameters<BattleSession['configureBossTest']>[0])=>{
            const ok=this.session.configureBossTest(config);if(ok)this.bossHud?.update(0);return ok;
          },
          beginAd:()=>this.session.beginBossAd(),
          completeAd:(token:string,outcome:AdOutcome)=>this.completeBossAd(token,outcome),
        },mine:{
          state:()=>this.session.getMineState(),open:()=>this.openFeature('mine'),close:()=>this.mineHud?.close(),
          start:()=>this.startMine(),exit:()=>this.exitMine(),
          configure:(config:Parameters<BattleSession['configureMineTest']>[0])=>this.session.configureMineTest(config),
          beginAd:(kind:'entry'|'reward')=>this.session.requestMineAd(kind),
          completeAd:(token:string,outcome:AdOutcome)=>this.completeMineAd(token,outcome),
        },hunt:{
          state:()=>this.session.getHuntState(),open:()=>this.openFeature('hunt'),close:()=>this.huntHud?.close(),
          start:()=>this.startHunt(),giveUp:()=>this.giveUpHunt(),exit:()=>this.exitHunt(),
          configure:(config:Parameters<BattleSession['configureHuntTest']>[0])=>this.session.configureHuntTest(config),
          beginAd:()=>this.session.beginHuntAd(),completeAd:(token:string,outcome:AdOutcome)=>this.completeHuntAd(token,outcome),
        },raid:{
          state:()=>this.session.getRaidState(),
          open:()=>this.openFeature('raid'),close:()=>this.raidHud?.close(),
          start:()=>this.startRaid(),exit:()=>this.exitRaid(),
          select:(slot:number,source:number)=>this.session.selectRaidWeapon(slot,source),
          unselect:(slot:number)=>this.session.unselectRaidWeapon(slot),
          autoSelect:()=>this.session.autoSelectRaidWeapons(),
          claim:(index:number)=>this.session.claimRaidMission(index),
          claimAll:()=>this.session.claimAllRaidMissions(),
          configure:(config:Parameters<BattleSession['configureRaidTest']>[0])=>{
            const ok=this.session.configureRaidTest(config);if(ok)this.raidHud?.update(0);return ok;
          },
          beginAd:()=>this.session.beginRaidAd(),
          completeAd:(token:string,outcome:AdOutcome)=>this.completeRaidAd(token,outcome),
        },adventure:{
          state:()=>this.session.getAdventureState(),relics:()=>this.session.getRelicState(),
          open:()=>this.openFeature('adventure'),close:()=>this.adventureHud?.close(),
          start:(...args:Parameters<BattleSession['startAdventure']>)=>this.adventureResult(this.session.startAdventure(...args)),
          cancel:(...args:Parameters<BattleSession['cancelAdventure']>)=>this.adventureResult(this.session.cancelAdventure(...args)),
          claim:(...args:Parameters<BattleSession['claimAdventure']>)=>this.adventureResult(this.session.claimAdventure(...args)),
          draw:(...args:Parameters<BattleSession['drawRelic']>)=>this.adventureResult(this.session.drawRelic(...args),true),
          upgrade:(index:number)=>this.adventureResult(this.session.upgradeRelic(index),true),
        },pets:{
          state:()=>this.session.getPetState(),open:()=>this.openFeature('pets'),close:()=>this.petHud?.close(),
          detail:(grade:number)=>this.petHud?.openDetail(grade),
          draw:(currency:'diamonds'|'petCoins')=>this.petCommand(()=>this.session.drawPet(currency)),
          move:async(from:PetSlotRef,to:PetSlotRef)=>{const state=this.session.getPetState();await this.petVisuals?.prepare([...state.selected,...state.owned]);return this.petCommand(()=>this.session.movePet(from,to,state[from.kind][from.index]));},
          unequip:(index:number)=>this.petCommand(()=>this.session.unequipPet(index)),
          merge:(from:number,to:number)=>this.petCommand(()=>this.session.mergePets(from,to)),
          auto:(enabled:boolean)=>this.petCommand(()=>this.session.setPetAutoMerge(enabled)),
        },fish:{
          state:()=>this.session.getFishState(),open:()=>this.openFeature('fish'),close:()=>this.fishHud?.close(),
          detail:(grade:number)=>this.fishHud?.openDetail(grade),
          draw:(kind:FishDrawKind)=>this.fishCommand(()=>this.session.drawFish(kind)),
          merge:(from:number,to:number)=>this.fishCommand(()=>this.session.mergeFish(from,to)),
          remove:(index:number)=>this.fishCommand(()=>this.session.removeFish(index)),
          auto:(enabled:boolean)=>this.fishCommand(()=>this.session.setFishAutoMerge(enabled)),
          beginAd:()=>this.session.beginFishAd(),completeAd:(token:string,outcome:AdOutcome)=>this.session.completeFishAd(token,outcome),
        },skins:{
          state:()=>this.session.getSkinState(),
          open:()=>this.openFeature('skins'),close:()=>this.skinHud?.close(),
          detail:(id:number)=>this.skinHud?.openDetail(id),
          purchase:(id:number)=>this.purchaseSkin(id),equip:(id:number)=>this.equipSkin(id),
        },rebirth:{
          open:()=>this.openFeature('rebirth'),close:()=>this.rebirthHud?.close(),
          configure:(config:Parameters<BattleSession['configureRebirthTest']>[0])=>{
            const ok=this.session.configureRebirthTest(config);if(ok)this.syncLoadout('upgrade');return ok;
          },
          request:(kind:'normal'|'ad')=>this.requestRebirth(kind),
          completeAd:(token:string,outcome:AdOutcome)=>{
            const result=this.session.completeRebirthAd(token,outcome);
            if(result.ok&&this.session.rebirthAnimating)this.beginRebirthPresentation();return result;
          },
          upgrade:(type:UpgradeType)=>this.purchaseRebirthUpgrade(type),
        },weapons:{
          open:()=>this.openFeature('weapons'),close:()=>this.weaponsHud?.close(),
          configure:(config:WeaponTestConfiguration)=>this.session.weapons.configureTest(config),
          grant:(id:number)=>this.session.weapons.grantTestWeapon(id),
          starGems:(amount:number)=>this.session.weapons.grantTestStarGems(amount),
          advanceTime:(milliseconds:number)=>this.session.weapons.advanceTestTime(milliseconds),
          draw:()=>this.session.weapons.draw(),merge:(from:number,to:number)=>this.session.weapons.merge(from,to),
          equip:(from:number,to:number)=>this.session.weapons.equip(from,to),unequip:(slot:number)=>this.session.weapons.unequip(slot),
          lock:(location:WeaponLocation)=>this.session.weapons.toggleLock(location),
          star:(slot:number)=>this.session.weapons.upgradeStar(slot),
          beginAd:(kind:AdKind)=>this.session.weapons.beginAd(kind),
          completeAd:(token:string,outcome:AdOutcome)=>this.session.weapons.completeAd(token,outcome),
        }}:{}),
        };
        (globalThis as typeof globalThis & {__forestGunner?:object}).__forestGunner=this.debugApi;
      }
      // The first battle is ready before the original audio downloads begin.
      this.bgmAssetsLoader=()=>loadOriginalBgmAssets(art,this.session.mode==='Main'?'main':'contents');
      void this.loadBgm();
    } catch(error) {
      loadingAssets=false;
      if(this.disposed)return;
      this.clearViews();
      console.error('[ForestGunner] Startup failed',error);
      if(message.isValid){
        const reason=(error instanceof Error?error.message:String(error)).replace(/\s+/g,' ').slice(0,160);
        const text=`${versionLine}资源加载失败：${failedModule}\n${reason}\n点击这里重试`;
        message.fontSize=25;message.lineHeight=36;message.enableWrapText=true;message.overflow=Label.Overflow.SHRINK;
        message.string=text;
        let retrying=false;
        const retry=():void=>{
          if(retrying||this.disposed||this.backgrounded)return;
          const sceneName=director.getScene()?.name;if(!sceneName)return;
          retrying=true;message.string=versionLine+'正在重试，已下载资源会继续复用…';
          const failed=(reloadError:Error|null):void=>{
            if(!reloadError||this.disposed||!message.isValid)return;
            retrying=false;message.string=text;
            console.error('[ForestGunner] Startup retry failed',reloadError);
          };
          // Reload the scene, retaining the engine/download caches and saved game.
          if(!director.loadScene(sceneName,failed))failed(new Error('Scene reload rejected'));
        };
        this.loading!.on(Node.EventType.TOUCH_END,retry);
        this.startupInputBlock?.on(Node.EventType.TOUCH_END,retry);
      }
    } finally {this.startupProgress=undefined;}
  }

  private waitOfflineRetry():Promise<boolean> {
    return new Promise(resolve=>{
      const loading=this.loading!,cover=this.startupInputBlock;
      const finish=(retry:boolean):void=>{
        loading.off(Node.EventType.TOUCH_END,clicked);
        cover?.off(Node.EventType.TOUCH_END,clicked);
        this.cancelOfflineRetry=undefined;resolve(retry);
      };
      const clicked=():void=>{if(!this.disposed&&!this.backgrounded)finish(true);};
      this.cancelOfflineRetry=()=>finish(false);
      loading.on(Node.EventType.TOUCH_END,clicked);
      cover?.on(Node.EventType.TOUCH_END,clicked);
    });
  }

  private offlineState():OfflineHudState|null {
    const result=this.session?.offlineResult,before=this.session?.offlineBefore;
    if(!result||!before)return null;
    const columns=(stageIndex:number,waveIndex:number,levels:readonly number[])=>({
      stageIndex,stageLevel:waveIndex,powerLevel:levels[0],speedLevel:levels[1],moneyLevel:levels[2],
    });
    return {visible:this.offlineSummaryPending,before:columns(before.stageIndex,before.waveIndex,before.levels),
      after:columns(result.stageIndex,result.waveIndex,result.levels),maxStage:result.stageValueMax,
      elapsedSeconds:result.elapsedSeconds,absentSeconds:result.absentSeconds};
  }

  private closeOfflineSummary():void {
    this.offlineSummaryPending=false;
    this.offlineHud?.update(0);
    if(this.offlineNotice)this.offlineNotice.active=false;
    this.syncModalState();this.updateTutorial(0);
  }

  private canOpenDailyCheck():boolean {
    if(!this.ready||this.disposed||this.offlineSummaryPending||this.isPaused||this.session.mode!=='Main'||
      !this.session.getContentState('dailyCheck').unlocked||this.session.rebirthAnimating||this.modeRevealElapsed!==null||this.openingFeature||this.settingsOpening)return false;
    const state=this.hudState();
    return state.phase==='playing'&&!state.stageTransition&&!state.stageSkip&&
      !this.weaponsHud?.isOpen&&!this.rebirthHud?.isOpen&&!this.settingsHud?.isOpen&&!this.skinHud?.isOpen&&
      !this.petHud?.isOpen&&!this.fishHud?.isOpen&&!this.adventureHud?.isOpen&&!this.speedRunHud?.blocksUpgrades&&!this.raidHud?.blocksUpgrades&&
      !this.bossHud?.blocksUpgrades&&!this.huntHud?.blocksUpgrades&&!this.mineHud?.blocksUpgrades;
  }

  private ensureDailyCheckHud():Promise<DailyCheckHud|undefined> {
    if(this.dailyCheckHud)return Promise.resolve(this.dailyCheckHud);
    if(this.dailyCheckHudRequest)return this.dailyCheckHudRequest;
    if(!this.dailyCheckHudLoader)return Promise.resolve(undefined);
    const request=this.dailyCheckHudLoader().then(hud=>{
      if(!this.disposed&&this.preparationReady&&hud){this.dailyCheckHud=hud;this.modalStateDirty=true;}
      return hud;
    }).then(hud=>{if(this.dailyCheckHudRequest===request)this.dailyCheckHudRequest=undefined;return hud;},error=>{
      if(this.dailyCheckHudRequest===request)this.dailyCheckHudRequest=undefined;throw error;
    });
    this.dailyCheckHudRequest=request;return request;
  }

  private async openDailyCheck():Promise<void> {
    if(!this.canOpenDailyCheck()||this.dailyCheckOpening||this.dailyCheckHud?.isOpen)return;
    if(this.dailyCheckHud){
      this.hud?.cancelInteractions();this.resizeIfNeeded();this.syncModalState();this.dailyCheckHud.open();
      if(this.dailyCheckHud.isOpen){this.dailyCheckAutoPending=false;this.dailyCheckRetryAt=0;}
      this.syncModalState();return;
    }
    const version=++this.dailyCheckOpenVersion;
    this.dailyCheckOpening=true;this.dailyCheckNoticeAt=Date.now()+200;
    this.resourcePreloader?.prioritize('dailyCheck');this.hud?.cancelInteractions();this.syncModalState();
    try {
      const hud=await this.ensureDailyCheckHud();
      if(!hud||version!==this.dailyCheckOpenVersion||!this.canOpenDailyCheck())return;
      this.dailyCheckOpening=false;this.dailyCheckNotice?.destroy();this.dailyCheckNotice=undefined;
      this.syncModalState();hud.open();
      if(hud.isOpen){this.dailyCheckAutoPending=false;this.dailyCheckRetryAt=0;}
    } catch(error) {
      this.dailyCheckRetryAt=Date.now()+RESOURCE_LOADING_POLICY.background.retryDelayMs;
      if(version===this.dailyCheckOpenVersion&&!this.disposed&&this.ready){
        console.error('[ForestGunner] Daily check loading failed',error);
        this.alerts?.show('七日领取加载失败，可点击入口重试');
      }
    } finally {
      if(version===this.dailyCheckOpenVersion){
        this.dailyCheckOpening=false;this.dailyCheckNotice?.destroy();this.dailyCheckNotice=undefined;
        if(!this.disposed&&this.ready)this.syncModalState();
      }
    }
  }

  private cancelDailyCheckOpening():void {
    this.dailyCheckOpenVersion++;this.dailyCheckOpening=false;
    this.dailyCheckNotice?.destroy();this.dailyCheckNotice=undefined;
  }

  private updateDailyCheck():void {
    if(!this.ready||this.disposed||this.backgrounded)return;
    if(this.dailyCheckOpening&&!this.dailyCheckNotice&&Date.now()>=this.dailyCheckNoticeAt){
      this.dailyCheckNotice=makeNode('DailyCheckLoading',this.node);
      const label=this.dailyCheckNotice.addComponent(Label);
      label.string='正在准备七日领取…';label.fontSize=27;label.color=new Color(88,67,44);
    }
    // Pending belongs to this launch. Closing once or returning from background
    // never schedules another automatic popup; tutorial/challenge gates and temporary blockers retain it.
    if(!this.dailyCheckAutoPending)return;
    if(this.session.getDailyCheckState().claimableIndex===null){this.dailyCheckAutoPending=false;return;}
    if(Date.now()>=this.dailyCheckRetryAt&&this.canOpenDailyCheck())void this.openDailyCheck();
  }

  private updateDailyCheckEntry():void {
    if(this.dailyCheckEntry||this.dailyCheckEntryRequest||Date.now()<this.dailyCheckEntryRetryAt||!this.artLibrary||!this.hudRoot)return;
    const parent=this.hudRoot,art=this.artLibrary;
    const request=loadDailyCheckEntryAssets(art).then(async assets=>{
      if(this.disposed||!this.ready||!parent.isValid)return;
      this.retainEntryResources(assets.config,'dailyCheck');
      const entry=new DailyCheckEntry(parent,art,assets,()=>{void this.openDailyCheck();},id=>this.sfx?.play(id));
      try {
        await entry.prepared;
        if(this.disposed||!this.ready||!parent.isValid){entry.destroy();return;}
        this.dailyCheckEntry=entry;
        const {top,bottom}=this.safeAreaInsets();entry.resize(this.viewport.width,this.viewport.height,top,bottom);
        const overlay=this.tutorialHud?.node;if(overlay)entry.node.setSiblingIndex(overlay.getSiblingIndex());
        this.syncModalState();
      } catch(error){entry.destroy();throw error;}
    }).catch(error=>{
      this.dailyCheckEntryRetryAt=Date.now()+RESOURCE_LOADING_POLICY.background.retryDelayMs;
      if(!this.disposed)console.error('[ForestGunner] Daily check entry loading failed',error);
    }).then(()=>{if(this.dailyCheckEntryRequest===request)this.dailyCheckEntryRequest=undefined;});
    this.dailyCheckEntryRequest=request;
  }

  private loadOfflineHud():Promise<void> {
    if(this.offlineHudRequest)return this.offlineHudRequest;
    if(!this.offlineSummaryPending||this.offlineHud||!this.offlineHudLoader||this.disposed)return Promise.resolve();
    if(this.offlineNotice)this.offlineNotice.active=false;
    const request=(async()=>{
      let created:OfflineHud|undefined;
      try{
        const hud=created=await this.offlineHudLoader!();
        if(!hud)return;
        if(this.disposed||!this.preparationReady){hud.destroy();return;}
        this.offlineHud=hud;
        this.modalStateDirty=true;
      }catch(error){
        if(created){
          if(this.offlineHud===created)this.offlineHud=undefined;
          created.destroy();
        }
        if(this.disposed||!this.preparationReady)return;
        console.error('[ForestGunner] Offline summary load failed',error);
        if(!this.offlineNotice){
          const notice=this.offlineNotice=makeNode('OfflineSummaryRetry',this.hudRoot!);
          notice.getComponent(UITransform)!.setContentSize(620,110);
          const label=notice.addComponent(Label);label.fontSize=24;label.color=new Color(88,67,44);label.enableWrapText=true;
          label.string='离线进度已保存，结果界面加载失败\n点击这里重试';
          notice.on(Node.EventType.TOUCH_END,()=>{if(!this.backgrounded)void this.loadOfflineHud();});
        }
        this.offlineNotice.active=true;
      }
    })().then(()=>{if(this.offlineHudRequest===request)this.offlineHudRequest=undefined;});
    this.offlineHudRequest=request;return request;
  }

  private loadBgm():Promise<void> {
    if(this.bgmRequest)return this.bgmRequest;
    if(!this.audioPreferences?.bgmEnabled||this.backgrounded||this.bgm||!this.ready||this.disposed||!this.bgmAssetsLoader)return Promise.resolve();
    const version=this.bgmLoadVersion,load=this.bgmAssetsLoader;
    const current=():boolean=>version===this.bgmLoadVersion&&!this.disposed&&this.ready&&this.node.isValid;
    const request=(async()=>{
      let created:OriginalBgm|undefined;
      try {
        const assets=await load();
        if(!current())return;
        created=new OriginalBgm(this.node,assets);
        // Preferences, mode and foreground state may change during download.
        created.setEnabled(this.audioPreferences!.bgmEnabled);
        created.setPaused(this.backgrounded);
        created.setMode(this.session.mode);
        this.bgm=created;
      } catch(error){
        created?.destroy();
        if(current()){
          console.error('[ForestGunner] Background music load failed',error);
          this.alerts?.show('背景音乐加载失败，可在设置中重新开启');
        }
      }
    })().then(()=>{if(this.bgmRequest===request)this.bgmRequest=undefined;});
    this.bgmRequest=request;
    return request;
  }

  update(dt:number):void {
    this.loadingTrace.frame(dt);
    const frameStartedAt=this.preparationNow(),frameDelta=dt;
    this.loadingText?.sync();
    this.startupScreen?.sync();
    // The engine keeps updating during async start. No timer survives teardown
    // or performs work while the app is in the background.
    if(this.startupProgress&&!this.backgrounded&&Date.now()>=this.startupProgressNextAt){
      this.startupProgressNextAt=Date.now()+1000;this.startupProgress();
    }
    if(!this.ready){
      // Canvas can apply its new size one frame after the resize event.
      if(this.canvasTransform)this.resizeIfNeeded();
      if(this.preparationReady&&!this.disposed){this.updateStartupPreparation();this.checkStartupRelease();}
      else if(!this.disposed&&!this.backgrounded)this.resourcePreloader?.updateStartupDownloads(this.startupModules);
      return;
    }
    if(!this.battlefield||!this.hud)return;
    // Original Gamemanager autosaves every ten foreground seconds, including menus.
    if(!this.backgrounded&&Date.now()>=this.offlineCheckpointAt){
      this.offlineCheckpointAt=Date.now()+10000;this.session.checkpointForeground();
    }
    if(!this.backgrounded){
      if(this.openingFeature)this.refreshDeferredHudNotice();
      this.refreshSettingsNotice();
      if(this.battleLoading&&this.battleNotice&&!this.battleRetry&&Date.now()>=this.battleNoticeAt)this.battleNotice.active=true;
    }
    this.sfx?.update(this.backgrounded||!Number.isFinite(dt)?0:Math.max(0,dt));
    this.featureEntries.forEach(entry=>entry.update(this.backgrounded||!Number.isFinite(dt)?0:Math.max(0,dt)));
    this.dailyCheckEntry?.update(this.backgrounded||!Number.isFinite(dt)?0:Math.max(0,dt));
    this.resizeIfNeeded();
    // Buff time follows the foreground clock even during menus or asset loading.
    const foregroundDelta=this.backgrounded||this.manuallyPaused||this.rewardedAds?.isPresenting||this.skipFrame||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime));
    this.session.advanceBuff(foregroundDelta);
    const mineWasLoading=this.battleLoading&&this.session.mode==='Mine'&&this.session.getMineState().phase==='entering';
    if(mineWasLoading&&foregroundDelta>0){
      // Mine's placement coroutine yields while Unity's global shot/FX pools
      // keep ticking. The hidden map cannot score; background/ad time is zero.
      if(this.world.isPaused)this.world.resume();
      this.world.advanceEffects(foregroundDelta);
      this.battlefield.handleEvents(this.world.drainEvents(),[]);
      this.battlefield.update(foregroundDelta);
      this.session.advanceFrame(foregroundDelta,this.session.roundId);
      if(this.minePlacement){
        this.minePlacement.advanceFrame();
        if(this.minePlacement.ready){
          this.mineDefinition=this.minePlacement.stage;this.minePlacement=undefined;
          this.activateRound(this.session.round);
        }
      }
      // The loader already advanced this frame's entry clock.
      dt=0;
    }
    const paused=this.isPaused;
    this.prefetchNextStage();
    if(this.skipFrame){this.skipFrame=false;dt=0;}
    this.session.weapons.tick();
    this.updatePreparedHud('weapons',this.weaponsHud,this.backgrounded||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)));
    this.alerts?.update(this.backgrounded||!Number.isFinite(dt)?0:Math.max(0,dt));
    if(!paused&&Number.isFinite(dt)&&dt>0) {
      // Unity runs zero or more fixed physics steps, then ONE Cat.Update per
      // render frame. Resampling Update at 60 Hz changes its Lerp and timers.
      const delta=Math.min(dt,COMBAT_CONFIG.maxFrameTime);
      if((this.session.mode==='SpeedRun'&&this.session.getSpeedRunState().phase==='exiting')||
         (this.session.mode==='Raid'&&this.session.getRaidState().phase==='exiting')||
         (this.session.mode==='Boss'&&this.session.getBossState().phase==='exiting')||
         (this.session.mode==='Monster'&&this.session.getHuntState().phase==='exiting')||
         (this.session.mode==='Mine'&&this.session.getMineState().phase==='exiting')){
        // Game_Exit disables Map_obj immediately. Global shots and FX remain
        // alive while Exit_Cor waits to rebuild the main battlefield.
        this.world.setBattlefieldActive(false);this.battlefield.setBattlefieldActive(false);
      }
      if(this.modeRevealElapsed!==null){
        this.modeRevealElapsed+=delta;
        if(this.modeRevealElapsed+1e-10>=.2)this.modeRevealElapsed=null;
      }
      const roundId=this.worldRoundId,wasFighting=this.session.canFight;
      if(wasFighting){
        // A final render frame may cross a timed mode's deadline. Resolve its live
        // portion before settlement without giving bullets extra battle time.
        const combatDelta=this.session.mode==='Raid'?Math.min(delta,this.session.getRaidState().remainingSeconds):
          this.session.mode==='Mine'?Math.min(delta,this.session.getMineState().timeRemaining):delta;
        this.world.step(combatDelta);
      } else if(this.session.mode==='Monster'&&this.session.getHuntState().phase==='clearing'&&!this.session.getHuntState().settlementPending) {
        this.world.advanceHuntIntermission(delta);
      } else this.world.advanceEffects(delta);
      const events=this.world.drainEvents();
      const rewards=this.session.consume(events,this.world.trees,roundId);
      this.session.consumeMine(events,this.world.stage.ores??[],roundId);
      this.battlefield.handleEvents(events,rewards);
      this.battlefield.update(delta);
      const next=this.session.advanceFrame(delta,roundId);
      if(next){
        if(this.session.mode==='Monster'&&this.worldMode==='Monster'){
          // StartNextLevel reuses the original pool, cats and live projectiles.
          // The session has committed progress and restarted that same controller.
          this.worldRoundId=next.roundId;
          this.world.stage.stageIndex=next.stageIndex;this.world.stage.waveIndex=next.waveIndex;
          this.world.startCombat();
        } else if((this.session.mode==='SpeedRun'||this.session.mode==='Raid'||this.session.mode==='Boss'||this.session.mode==='Mine')&&this.worldMode===this.session.mode){
          // Enter_Cor has already built the arena and warped the squad. Its
          // final callback only sets is_Play; rebuilding would erase FX time.
          this.world.startCombat();
        } else {
        // Original Loading_Then_Start keeps running during rebirth FX. Its
        // Game_Start resumes combat until the FX event resets everything.
        this.activateRound(next,this.session.rebirthAnimating);
        }
      }
      else if(wasFighting&&!this.session.canFight&&!(this.session.mode==='Monster'&&this.session.getHuntState().phase==='clearing'&&!this.session.getHuntState().settlementPending))this.world.stopCombat();
      const reborn=this.battleLoading?undefined:this.session.advanceRebirth(delta);
      if(reborn){this.activateRound(reborn,true);this.rebirthHud?.close();this.syncModalState();}
    }
    this.updatePreparedHud('rebirth',this.rebirthHud,paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)),this.session.getRebirthState());
    this.updatePreparedHud('speedrun',this.speedRunHud,paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)),this.session.getSpeedRunState());
    this.updatePreparedHud('raid',this.raidHud,paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)),this.session.getRaidState());
    this.updatePreparedHud('boss',this.bossHud,paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)),this.session.getBossState(this.world.stage.boss));
    this.updatePreparedHud('mine',this.mineHud,paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)),this.session.getMineState());
    this.updatePreparedHud('hunt',this.huntHud,paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)),this.session.getHuntState());
    this.updatePreparedHud('pets',this.petHud,paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)));
    this.updatePreparedHud('adventure',this.adventureHud,this.backgrounded||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)));
    this.updatePreparedHud('fish',this.fishHud,paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)));
    this.updatePreparedHud('skins',this.skinHud,paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)));
    this.updatePreparedHud('settings',this.settingsHud,this.backgrounded||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)));
    this.updatePreparedHud('offline',this.offlineHud,this.backgrounded||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)));
    this.updatePreparedHud('dailyCheck',this.dailyCheckHud,this.backgrounded||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)));
    this.bgm?.setMode(this.session.mode);
    this.updateDeferredHuds();
    if(this.modalStateDirty)this.loadingTrace.measure('hud','commitRefresh',()=>this.syncModalState());
    else this.syncModalState();
    this.hud.setLoadingOverlay(this.session.getMineState().loadingElapsed??this.session.getHuntState().loadingElapsed??this.session.getBossState().loadingElapsed??this.session.getRaidState().loadingElapsed??this.session.getSpeedRunState().loadingElapsed??(this.modeRevealElapsed===null?null:1.5+this.modeRevealElapsed));
    this.hud.update(this.hudState(),paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)));
    this.updateTutorial(paused||!Number.isFinite(dt)?0:Math.max(0,Math.min(dt,COMBAT_CONFIG.maxFrameTime)));
    this.updateDailyCheck();
    this.updateResourcePreparation(frameDelta,frameStartedAt);
  }

  private preparationNow():number {return typeof performance!=='undefined'&&typeof performance.now==='function'?performance.now():Date.now();}

  private createResourceModules():ResourceModuleManager {
    return new ResourceModuleManager({now:()=>Date.now(),onPrioritize:name=>{
      this.memoryEvictedModules.delete(name);
      const feature=name==='weaponCollection'?'weapons':name as BackgroundFeature;
      this.resourcePreloader?.prioritize(feature);
    },onUse:name=>{this.moduleLastUsed.set(name,Date.now());}});
  }

  private shouldPrepareModule(name:BackgroundFeature):boolean {
    if(this.memoryEvictedModules.has(name))return false;
    if(name==='offline')return this.offlineSummaryPending;
    if(name==='dailyCheck')return this.dailyCheckPreparationDemand||this.session.getContentState(name).unlocked||this.isUpcomingModule(name);
    return isAutomaticModule(name,name==='settings'||this.session.getContentState(name).unlocked)||this.isUpcomingModule(name);
  }

  private isUpcomingModule(name:BackgroundFeature):boolean {
    return name!=='settings'&&name!=='offline'&&!this.memoryEvictedModules.has(name)&&
      this.session.content.isUpcoming(name,this.session.mode==='SpeedRun');
  }

  private updateStartupPreparation():void {
    if(this.ready||this.disposed||this.backgrounded||!this.preparationReady)return;
    if(this.startupFailure)return;
    if(!this.startupRequest&&Date.now()>=this.startupRetryAt){
      const name=this.startupModules.find(module=>!this.resourceModules.isViewReady(module));
      if(!name)return;
      if(this.startupCurrent!==name){this.startupCurrent=name;this.startupAttempts=0;}
      const generation=this.startupGeneration;this.startupAttempts++;
      this.startupProgress?.();
      const request=this.resourceModules.prepare(name).catch(error=>{
        if(this.disposed||generation!==this.startupGeneration)return;
        const delay=RESOURCE_LOADING_POLICY.foreground.retryDelaysMs[this.startupAttempts-1];
        if(delay!==undefined)this.startupRetryAt=Date.now()+delay;
        else this.startupFailure=(error instanceof Error?error.message:String(error)).replace(/\s+/g,' ').slice(0,120);
        this.loadingTrace.mark(name,'startupFailure');this.startupProgress?.();
      }).then(()=>{if(this.startupRequest===request)this.startupRequest=undefined;});
      this.startupRequest=request;
    }
    // One UI owner and at most one next-panel asset task. It starts only once
    // current assets are ready, so two full four-worker loads never compete.
    // Speculative failures are retried by that panel's ordinary startup path.
    if(this.startupCurrent&&this.resourceModules.isAssetReady(this.startupCurrent)&&!this.startupAssetRequest){
      const next=this.startupModules[this.startupModules.indexOf(this.startupCurrent)+1];
      if(next&&!this.startupAssetsAttempted.has(next)){
        this.startupAssetsAttempted.add(next);
        const generation=this.startupGeneration;
        const request=this.resourceModules.prepareAssets(next).catch(()=>{
          if(!this.disposed&&generation===this.startupGeneration)this.loadingTrace.mark(next,'startupAssetPrefetchFailure');
        }).then(()=>{if(this.startupAssetRequest===request)this.startupAssetRequest=undefined;});
        this.startupAssetRequest=request;
      }
    }
    // The startup slice yields every frame so the progress bar can still paint.
    if(this.startupCurrent){
      this.resourcePreloader?.updateStartupDownloads(this.startupModules,this.startupCurrent);
      this.uiPreparation.tick(this.startupCurrent,name=>name===this.startupCurrent&&this.canPrepareHud(name),undefined,'startup');
    }
  }

  private retryStartupPreparation():void {
    if(!this.startupFailure||this.startupRequest||this.backgrounded||this.disposed||this.ready)return;
    this.startupFailure=undefined;this.startupAttempts=0;this.startupRetryAt=0;this.startupProgress?.();
  }

  private get dailyCheckPreparationDemand():boolean {
    return this.dailyCheckOpening||(this.dailyCheckAutoPending&&this.session.getContentState('dailyCheck').unlocked);
  }

  private checkStartupRelease():void {
    if(!this.startupRelease)return;
    const result=this.startupBudget?.evaluate({coreReady:this.preparationReady,
      viewsReady:this.startupModules.every(name=>this.resourceModules.isViewReady(name)),hidden:this.backgrounded});
    if(this.disposed||(!this.startupRequest&&!this.startupFailure&&result?.release)){
      this.startupCurrent=undefined;const release=this.startupRelease;this.startupRelease=undefined;release();
    }
  }

  private warmWeaponCollection():void {
    if(!this.weaponsHud||this.weaponsHud.collectionReady||this.collectionWarmRequest||Date.now()<this.collectionRetryAt||
      this.memoryEvictedModules.has('weaponCollection')||
      Date.now()<this.memoryPressureUntil||this.resourcePreloader?.mode!=='full'||
      RESOURCE_MODULE_ORDER.some(name=>this.shouldPrepareModule(name)&&!this.resourceModules.isViewReady(name)))return;
    const request=this.resourceModules.prepare('weaponCollection').catch(error=>{
      this.collectionRetryAt=Date.now()+RESOURCE_LOADING_POLICY.background.retryDelayMs;
      this.loadingTrace.mark('weaponCollection','backgroundFailure');
      console.warn('[ForestGunner] Collection preparation will retry',error);
    }).then(()=>{if(this.collectionWarmRequest===request)this.collectionWarmRequest=undefined;});
    this.collectionWarmRequest=request;
  }

  private releaseModuleView(name:string):void {
    const fields:Record<string,string>={weapons:'weaponsHud',settings:'settingsHud',speedrun:'speedRunHud',rebirth:'rebirthHud',
      skins:'skinHud',pets:'petHud',fish:'fishHud',adventure:'adventureHud',boss:'bossHud',hunt:'huntHud',raid:'raidHud',mine:'mineHud',offline:'offlineHud',dailyCheck:'dailyCheckHud'};
    const field=fields[name];if(!field)return;
    const state=this as unknown as Record<string,{destroy():void}|undefined>;
    state[field]?.destroy();state[field]=undefined;
    if(name==='settings')this.settingsHudRequest=undefined;
    else if(name==='dailyCheck')this.dailyCheckHudRequest=undefined;
    else if(name==='offline')this.offlineHudRequest=undefined;
    else {const deferred=this.deferredHudStates[name as FeatureName];if(deferred){deferred.request=undefined;deferred.retryAt=0;deferred.failed=false;}}
    this.modalStateDirty=true;
  }

  private installMemoryWarning():void {
    const host=(globalThis as any).wx;
    host?.onMemoryWarning?.(this.onMemoryWarning);
  }

  private readonly onMemoryWarning=():void=>{
    if(this.disposed||!this.ready)return;
    this.memoryPressureUntil=Date.now()+60000;
    const released=new Set<string>();
    if(!this.weaponsHud?.isOpen&&this.resourceModules.invalidate('weaponCollection')){
      this.memoryEvictedModules.add('weaponCollection');
      for(const path of this.moduleAssetPaths.get('weaponCollection')??[])released.add(path);
    }
    const candidates=RESOURCE_MODULE_ORDER.filter(name=>!['weapons','speedrun','offline','dailyCheck'].includes(name))
      .filter(name=>this.resourceModules.isViewReady(name)&&name!==this.openingFeature&&!(name==='settings'&&this.settingsOpening))
      .filter(name=>{const hud=name==='settings'?this.settingsHud:this.getFeature(name as FeatureName);return !!hud&&!hud.isOpen;})
      .sort((a,b)=>(this.moduleLastUsed.get(a)??0)-(this.moduleLastUsed.get(b)??0));
    for(const name of candidates.slice(0,2))if(this.resourceModules.invalidate(name)){
      this.memoryEvictedModules.add(name);
      this.resourcePreloader?.invalidate(name);for(const path of this.moduleAssetPaths.get(name)??[])released.add(path);
    }
    for(const path of released)this.pendingFrameEvictions.add(path);
    this.flushFrameEvictions();this.syncModalState();
  };

  private flushFrameEvictions():void {
    if(!this.pendingFrameEvictions.size||this.disposed||this.backgrounded||!this.artLibrary)return;
    const retained=new Set(this.coreResourcePaths),state=this.resourceModules.snapshot();
    for(const path of this.battleAssets?.residentPaths?.(this.world.stage)??[])retained.add(path);
    this.moduleAssetPaths.forEach((paths,name)=>{if(state[name]?.assetReady)for(const path of paths)retained.add(path);});
    // A partially loaded module has not published its dependency set yet. Keep
    // frames conservatively until those owners finish; nodes can still be freed.
    const pendingOwners=Object.values(state).some(module=>module.state==='loading')||this.entryRequests.size>0||!!this.dailyCheckEntryRequest||this.battleLoading;
    if(pendingOwners)return;
    const count=this.artLibrary.evictFrames(Array.from(this.pendingFrameEvictions),retained);
    for(const path of this.pendingFrameEvictions)if(retained.has(path)||!this.artLibrary.frames.has(path))this.pendingFrameEvictions.delete(path);
    if(count)this.loadingTrace.mark('memory','evictedFrames',count);
  }

  private updatePreparedHud(name:string,hud:{update(dt:number,state?:any):void}|undefined,dt:number,state?:unknown):void {
    if(!hud)return;
    const first=this.firstHudUpdates.delete(name),started=first?this.preparationNow():0;
    hud.update(dt,state);
    if(first)this.loadingTrace.mark(name,'firstUpdate',this.preparationNow()-started);
  }

  private createUiPreparation():UiPreparationQueue {
    return new UiPreparationQueue(()=>this.preparationNow(),(name,phase,ms,done)=>{
      if(done||ms>=1)this.loadingTrace.mark(name,done?phase:phase+':slowStep',ms);
    });
  }

  private currentUiLayout():UiLayout {
    const {top,bottom}=this.safeAreaInsets();return [this.viewport.width,this.viewport.height,top,bottom];
  }

  private hudPreparation(name:string):UiPreparation {
    const queue=this.uiPreparation;
    const prepare:UiPreparation=steps=>queue.run(name,steps);
    prepare.managed=true;
    prepare.layout=()=>{const layout=this.currentUiLayout();this.preparedLayouts.set(name,layout.join(':'));return layout;};
    prepare.trace=(phase,ms)=>this.loadingTrace.mark(name,phase,ms);
    return prepare;
  }

  private updateResourcePreparation(dt:number,frameStartedAt:number):void {
    if(this.backgrounded||this.disposed){this.resourcePreloader?.pause();return;}
    if(!this.ready){this.updateStartupPreparation();return;}
    this.flushFrameEvictions();
    this.resourcePreloader?.resume();
    this.resourcePreloader?.setDemand('offline',this.offlineSummaryPending&&!this.offlineHud);
    this.resourcePreloader?.setDemand('dailyCheck',(this.dailyCheckPreparationDemand||this.session.getContentState('dailyCheck').unlocked)&&!this.dailyCheckHud);
    for(const name of RESOURCE_MODULE_ORDER)this.resourcePreloader?.setUpcoming(name,this.isUpcomingModule(name));
    const unlocked=(name:BackgroundFeature)=>name==='settings'||name==='offline'||name==='dailyCheck'||this.session.getContentState(name).unlocked;
    // Downloads are independent of the frame-admission clock. Pausing the whole
    // queue here would also pause dependencies of a promoted foreground request.
    this.resourcePreloader?.updateDownloads(unlocked,!!this.audioPreferences?.bgmEnabled,!!this.audioPreferences?.soundEnabled);
    const foreground=this.offlineSummaryPending&&!this.offlineHud?'offline':this.openingFeature||
      (this.settingsOpening?'settings':this.dailyCheckOpening?'dailyCheck':this.weaponsHud?.preparingCollection?'weaponCollection':undefined);
    if(foreground){
      this.resourcePreloader?.updatePreparation(unlocked);
      if(foreground==='offline'&&!this.offlineHudRequest&&!this.offlineNotice?.active)void this.loadOfflineHud();
      this.uiPreparation.tick(foreground,name=>name===foreground&&this.canPrepareHud(name));return;
    }
    if(this.battleLoading||this.session.rebirthAnimating||this.rewardedAds?.isPresenting||Date.now()<this.memoryPressureUntil)return;
    const startup=!this.ready;
    if(!startup&&!this.backgroundPreparation.allow(dt,this.preparationNow()-frameStartedAt))return;
    const forced=!startup&&this.backgroundPreparation.lastAdmissionForced;
    // Every admitted rendering frame shares one UI budget. Completed views are
    // published ahead of long construction queues; decode cadence is separate.
    let uiSteps=0;
    if(this.resourcePreloader?.mode==='full'){
      this.prepareBackgroundHuds();
      const startupFocus=startup?this.uiPreparation.nextName(name=>this.canPrepareHud(name)):undefined;
      uiSteps=this.uiPreparation.tick(startupFocus,name=>this.canPrepareHud(name),forced?1:undefined);
    }
    if(forced&&uiSteps)return;
    const now=this.preparationNow();
    if((startup||forced||now>=this.nextBackgroundDecodeAt)&&
      (startup||forced||this.backgroundPreparation.hasFrameHeadroom(dt,now-frameStartedAt))){
      this.nextBackgroundDecodeAt=now+RESOURCE_LOADING_POLICY.backgroundScheduling.decodeIntervalMs;
      this.resourcePreloader?.updatePreparation(unlocked);
    }
    if(this.ready)this.warmWeaponCollection();
  }

  lateUpdate():void {this.colors?.syncCamera();}

  private get isPaused():boolean {return this.battleLoading||this.manuallyPaused||this.backgrounded||!!this.rewardedAds?.isPresenting||!['Main','SpeedRun','Raid','Boss','Monster','Mine'].includes(this.session.mode);}

  private hudState() {return this.session.snapshot(this.world.stats,this.isPaused,this.battlefield?.hasActiveRewards??false);}

  private updateTutorial(dt:number):void {
    if(!this.tutorialHud||!this.hud)return;
    const state=this.session.getTutorialState(),hud=this.hudState();
    const power=hud.upgrades.find(upgrade=>upgrade.type==='power');
    const targets=this.weaponsHud?.getTutorialTargets()??{entry:this.featureEntries.get('weapons')?.entry??null,buy:null,from:null,to:null,blocked:false};
    this.tutorialHud.update(state,{
      ...targets,upgrade:this.hud.getTutorialUpgradeTarget(),weaponOpen:!!this.weaponsHud?.isOpen,
      canUpgrade:!!power?.affordable&&(state.step==='upgrade'||!this.session.content.isUnlocked('speedrun')),
      blocked:targets.blocked||this.offlineSummaryPending||this.dailyCheckOpening||!!this.dailyCheckHud?.isOpen||this.isPaused||this.session.mode!=='Main'||hud.phase!=='playing'||
        this.session.rebirthAnimating||!!this.rebirthHud?.isOpen||!!this.speedRunHud?.isOpen||!!this.raidHud?.isOpen||!!this.bossHud?.isOpen||!!this.huntHud?.isOpen||!!this.mineHud?.isOpen||!!this.skinHud?.isOpen||!!this.petHud?.isOpen||!!this.fishHud?.isOpen||!!this.adventureHud?.isOpen||!!this.settingsHud?.isOpen||this.settingsOpening||!!this.openingFeature||this.modeRevealElapsed!==null,
    },dt);
  }

  private syncModalState():void {
    if(this.committingHud){this.modalStateDirty=true;return;}
    this.modalStateDirty=false;
    const main=this.session?.mode==='Main';
    const dailyCheckVisible=main&&this.session.getContentState('dailyCheck').visible;
    if(this.openingFeature&&(!main||this.isPaused)){this.featureOpenVersion++;this.openingFeature=undefined;}
    if(this.settingsOpening&&(!main||this.isPaused||this.session.rebirthAnimating||this.modeRevealElapsed!==null))this.cancelSettingsOpening();
    if(this.dailyCheckOpening&&(!dailyCheckVisible||this.isPaused||this.session.rebirthAnimating||this.modeRevealElapsed!==null))this.cancelDailyCheckOpening();
    if(this.dailyCheckHud){if(!dailyCheckVisible&&this.dailyCheckHud.isOpen)this.dailyCheckHud.close();this.dailyCheckHud.node.active=dailyCheckVisible;}
    if(this.weaponsHud)this.weaponsHud.node.active=main;
    if(this.rebirthHud)this.rebirthHud.node.active=main;
    if(this.skinHud)this.skinHud.node.active=main;
    if(this.petHud)this.petHud.node.active=main;
    this.petHud?.setEntryVisible(main&&!this.session.rebirthAnimating);
    if(this.fishHud)this.fishHud.node.active=main;
    if(this.adventureHud){if(!main&&this.adventureHud.isOpen)this.adventureHud.close();this.adventureHud.node.active=main;}
    this.adventureHud?.setEntryVisible(main&&!this.session.rebirthAnimating&&this.session.getContentState('adventure').visible);
    this.fishHud?.setEntryVisible(main&&!this.session.rebirthAnimating);
    if(this.settingsHud){if(!main&&this.settingsHud.isOpen)this.settingsHud.close();this.settingsHud.node.active=main;}
    this.skinHud?.setEntryVisible(main&&!this.session.rebirthAnimating);
    this.rebirthHud?.setContentBlocked(!this.session.getContentState('rebirth').visible);
    this.speedRunHud?.setEntryVisible(main&&!this.session.rebirthAnimating);
    this.raidHud?.setEntryVisible(main&&!this.session.rebirthAnimating&&!this.session.getTutorialState().active&&this.session.getContentState('raid').visible);
    this.huntHud?.setEntryVisible(main&&!this.session.rebirthAnimating&&!this.session.getTutorialState().active&&this.session.getContentState('hunt').visible);
    this.bossHud?.setEntryVisible(main&&!this.session.rebirthAnimating&&!this.session.getTutorialState().active&&this.session.getContentState('boss').visible);
    this.mineHud?.setEntryVisible(main&&!this.session.rebirthAnimating&&this.session.getContentState('mine').visible);
    this.layoutLeftMenu();this.layoutRightMenu();
    this.raidHud?.setExternalModalOpen(!!this.weaponsHud?.isOpen);
    const open=!!(this.offlineSummaryPending||this.dailyCheckOpening||this.dailyCheckHud?.isOpen||this.rewardedAds?.isPresenting||this.weaponsHud?.isOpen||this.rebirthHud?.isOpen||this.skinHud?.isOpen||this.petHud?.isOpen||this.fishHud?.isOpen||this.adventureHud?.isOpen||this.settingsHud?.isOpen||this.settingsOpening||this.openingFeature||this.battleLoading||this.session?.rebirthAnimating||this.speedRunHud?.blocksUpgrades||this.raidHud?.blocksUpgrades||this.bossHud?.blocksUpgrades||this.huntHud?.blocksUpgrades||this.mineHud?.blocksUpgrades||this.modeRevealElapsed!==null);
    // Unity keeps Main_UI/Btn_list below Gun_UI, Rebirth_manager and Contents_UI.
    // Our feature roots also own their menu buttons, so bring the open feature
    // above every other menu without crossing the ad, tutorial or alert layers.
    // Weapon dialogs take precedence when Raid opens a slot's star upgrade.
    const features=[this.weaponsHud,this.rebirthHud,this.speedRunHud,this.raidHud,this.bossHud,this.huntHud,this.mineHud,this.skinHud,this.petHud,this.fishHud,this.adventureHud,this.settingsHud,this.dailyCheckHud].filter(
      (hud):hud is WeaponHud|RebirthHud|SpeedRunHud|RaidHud|BossHud|HuntHud|MineHud|SkinHud|PetHud|FishHud|AdventureHud|SettingsHud|DailyCheckHud=>!!hud);
    const foreground=features.find(hud=>hud.node.active&&hud.isOpen);
    // Ready HUDs have their own entry buttons and can bypass openFeature.
    // Count visibility transitions, so both entry paths persist usage once.
    if(this.resourcePreloader){
      for(const name of [...Object.keys(DEFERRED_HUD_LABELS),'settings','dailyCheck'] as (DeferredHudName|'settings'|'dailyCheck')[]){
        const hud=name==='settings'?this.settingsHud:name==='dailyCheck'?this.dailyCheckHud:this.getFeature(name);
        if(hud?.node.active&&hud.isOpen){
          if(!this.visibleUsedFeatures.has(name)){this.visibleUsedFeatures.add(name);this.moduleLastUsed.set(name,Date.now());this.resourcePreloader.recordUse?.(name);}
        }else this.visibleUsedFeatures.delete(name);
      }
    }
    if(foreground){
      const top=Math.max(...features.map(hud=>hud.node.getSiblingIndex()),...Array.from(this.featureEntries.values()).map(entry=>entry.node.getSiblingIndex()),this.dailyCheckEntry?.node.getSiblingIndex()??0);
      if(foreground.node.getSiblingIndex()!==top)foreground.node.setSiblingIndex(top);
    }
    if(this.offlineHud?.isOpen)this.offlineHud.node.setSiblingIndex(this.hudRoot!.children.length-1);
    for(const feature of features)feature.setEntryBlocked(open||!main);
    this.dailyCheckEntry?.setVisible(dailyCheckVisible&&!this.session.rebirthAnimating);
    this.dailyCheckEntry?.setBlocked(open||!main||this.isPaused);
    if(this.featureEntries.size){
      const visible=this.visibleDeferredHuds();
      this.featureEntries.forEach((entry,name)=>entry.setState(main&&visible[name]&&!this.hasDeferredHud(name)&&!this.session.rebirthAnimating,
        !this.session.getContentState(name).unlocked,open||!main||this.isPaused));
    }
    this.hud?.setModalOpen(open);this.battlefield?.setShootingMuted(open);
  }

  private visibleDeferredHuds():Record<DeferredHudName,boolean> {
    return {weapons:this.session.content.isUnlocked('weapons'),raid:this.session.getContentState('raid').visible,boss:this.session.getContentState('boss').visible,
      speedrun:this.session.getSpeedRunState().unlocked,rebirth:this.session.getContentState('rebirth').visible,skins:this.session.getContentState('skins').visible,pets:this.session.getContentState('pets').visible,fish:this.session.getContentState('fish').visible,hunt:this.session.getContentState('hunt').visible,mine:this.session.getContentState('mine').visible,adventure:this.session.getContentState('adventure').visible};
  }

  private layoutLeftMenu():void {
    const offsets=leftMenuOffsets(this.visibleDeferredHuds());
    for(const [name,y] of Object.entries(offsets)){
      const feature=name as 'weapons'|'skins'|'fish'|'pets'|'rebirth';
      this.featureEntries.get(feature)?.setEntryOffset(y);
      const hud=feature==='weapons'?this.weaponsHud:feature==='skins'?this.skinHud:feature==='fish'?this.fishHud:feature==='pets'?this.petHud:this.rebirthHud;
      hud?.setEntryOffset(y);
    }
  }

  private layoutRightMenu():void {
    const offsets=rightMenuOffsets(this.visibleDeferredHuds());
    for(const [name,y] of Object.entries(offsets)){
      const feature=name as 'speedrun'|'mine'|'boss'|'hunt'|'adventure'|'raid';
      this.featureEntries.get(feature)?.setEntryOffset(y);
      const hud=feature==='speedrun'?this.speedRunHud:feature==='mine'?this.mineHud:feature==='boss'?this.bossHud:feature==='hunt'?this.huntHud:feature==='adventure'?this.adventureHud:this.raidHud;
      hud?.setEntryOffset(y);
    }
  }

  private hasDeferredHud(name:DeferredHudName):boolean {
    return !!(name==='weapons'?this.weaponsHud:name==='raid'?this.raidHud:name==='boss'?this.bossHud:name==='hunt'?this.huntHud:name==='mine'?this.mineHud:name==='speedrun'?this.speedRunHud:name==='skins'?this.skinHud:name==='pets'?this.petHud:name==='fish'?this.fishHud:name==='adventure'?this.adventureHud:this.rebirthHud);
  }

  private resourceLoadingSnapshot() {
    const scope=globalThis as typeof globalThis & {__FOREST_GUNNER_RELEASE__?:unknown};
    const preloading=this.resourcePreloader?.snapshot(),states=this.resourceModules.snapshot();
    const modules={} as Record<string,(typeof states)[string]&{downloads:unknown;downloadReady:boolean;decodedReady:boolean;resourcesAcquired:boolean}>;
    for(const [name,state] of Object.entries(states)){
      const background=preloading?.features[name as BackgroundFeature];
      const decodedReady=state.assetReady||!!background?.decodedReady;
      const downloadReady=state.assetReady||!!background?.downloadReady;
      modules[name]={...state,downloads:background?.downloads??null,downloadReady,decodedReady,
        resourcesAcquired:downloadReady||decodedReady};
    }
    return {...preloading,version:scope.__FOREST_GUNNER_RELEASE__??'local',
      modules,startup:{returningPlayer:this.startupReturning,budgetMs:this.startupBudgetMs,
        uiFrameBudgetMs:RESOURCE_LOADING_POLICY.startup.uiFrameBudgetMs,prefetchPanels:RESOURCE_LOADING_POLICY.startup.prefetchPanels,
        overBudget:(this.startupInteractiveAt||Date.now())-this.startupStartedAt>this.startupBudgetMs,
        waitingModule:this.startupCurrent,failure:this.startupFailure,attempts:this.startupAttempts,
        moduleTimings:this.startupModules.map(name=>({name,startedAt:states[name]?.startedAt,readyAt:states[name]?.readyAt,
          durationMs:states[name]?.readyAt!==undefined&&states[name]?.startedAt!==undefined?states[name].readyAt!-states[name].startedAt!:null})),
        coreReadyMs:this.startupCoreReadyAt?this.startupCoreReadyAt-this.startupStartedAt:null,
        interactiveMs:this.startupInteractiveAt?this.startupInteractiveAt-this.startupStartedAt:null,
        requiredViews:this.startupModules,preparationReady:this.preparationReady,interactive:this.ready,
        clock:'game-entry; platform time before game.js requires device launch trace'},
      foreground:!this.backgrounded,mode:this.session?.mode,preparationMode:this.resourcePreloader?.mode,battleLoading:this.battleLoading,
      opening:this.openingFeature||(this.settingsOpening?'settings':this.dailyCheckOpening?'dailyCheck':undefined),
      uiReady:RESOURCE_MODULE_ORDER.reduce((result,name)=>{result[name]=this.resourceModules.isViewReady(name);return result;},{} as Record<string,boolean>),
      uiPending:this.uiPreparation.snapshot(),hudPending:Array.from(this.backgroundHudRequests.keys()),
      activeResources:this.artLibrary?.resourceLoader.loadingStatus(),
      scheduling:this.backgroundPreparation.snapshot(),
      timings:{resources:this.artLibrary?.resourceLoader?.diagnostics?.(),ui:this.uiPreparation.timings()},
      trace:this.loadingTrace.snapshot(),
      presentation:this.presentationCamera?skinHudPresentationSnapshot(this.presentationCamera):undefined,
      weaponCollection:{ready:!!this.weaponsHud?.collectionReady,opening:!!this.weaponsHud?.preparingCollection},
      pendingFrameEvictions:this.pendingFrameEvictions.size};
  }

  private async prepareFeatureHud<T extends {node:Node;prepared?:Promise<void>;destroy():void;resize(width:number,height:number,top?:number,bottom?:number):void;
    resizePrepared?(prepare:(steps:Generator<void>)=>Promise<void>,width:number,height:number,top?:number,bottom?:number):Promise<void>}>(name:string,create:()=>T):Promise<T|undefined> {
    if(this.disposed||!this.preparationReady||!this.hudRoot?.isValid)return;
    const parent=this.hudRoot!,created:{hud?:T}={},guard=this.moduleGuards.get(name);
    const valid=()=>!this.disposed&&this.preparationReady&&parent.isValid&&guard?.()!==false;
    try {
      await this.uiPreparation.run(name,(function*(){
        if(!valid())throw new Error('HUD construction cancelled');
        const owned=new Set(parent.children);
        try {created.hud=create();created.hud.node.active=false;}
        catch(error){parent.children.filter(child=>!owned.has(child)).forEach(child=>child.destroy());throw error;}
      })(),'construct');
      const hud=created.hud!;
      await hud.prepared;
      for(;;){
        if(!valid()){if(hud.node.isValid)hud.destroy();return;}
        const layout=this.currentUiLayout(),key=layout.join(':');
        // Initial construction already used the actual viewport. Only a change
        // during preparation requires another sliced layout.
        if(this.preparedLayouts.get(name)!==key){
          this.preparedLayouts.set(name,key);
          if(hud.resizePrepared)await hud.resizePrepared(this.hudPreparation(name),...layout);
          else await this.uiPreparation.run(name,(function*(){hud.resize(...layout);})(),'layout');
        }
        let committed=false;
        await this.uiPreparation.run(name,(function*(this:GameBootstrap){
          if(!valid())throw new Error('HUD publication cancelled');
          if(this.currentUiLayout().join(':')!==key)return;
          const overlays=[this.alerts?.node,this.tutorialHud?.node,this.rewardedAdModal?.node].filter((node):node is Node=>!!node);
          if(overlays.length)hud.node.setSiblingIndex(Math.min(...overlays.map(node=>node.getSiblingIndex())));
          this.committingHud=true;
          try {
            this.loadingTrace.measure(name,'activation',()=>{hud.node.active=true;});
            if(name==='offline'&&this.ready){
              this.hud?.cancelInteractions();this.world.clearMovementInput();
              (hud as unknown as OfflineHud).update(0);
            }else if(name!=='offline')this.bindPreparedHud(name,hud);
            this.publishPreparedHud(name,hud);
          } finally {this.committingHud=false;}
          this.firstHudUpdates.add(name);this.modalStateDirty=true;committed=true;
        }).call(this),'commit');
        if(committed)break;
      }
      if(!valid()){if(hud.node.isValid)hud.destroy();return;}
      return hud;
    } catch(error){if(created.hud?.node.isValid)created.hud.destroy();throw error;}
    finally {this.preparedLayouts.delete(name);}
  }

  private publishPreparedHud(name:string,hud:{node:Node}):void {
    const fields:Record<string,string>={weapons:'weaponsHud',settings:'settingsHud',speedrun:'speedRunHud',rebirth:'rebirthHud',
      skins:'skinHud',pets:'petHud',fish:'fishHud',adventure:'adventureHud',boss:'bossHud',hunt:'huntHud',raid:'raidHud',mine:'mineHud',offline:'offlineHud',dailyCheck:'dailyCheckHud'};
    const field=fields[name];if(field)(this as unknown as Record<string,unknown>)[field]=hud;
  }

  private bindPreparedHud(name:string,hud:object):void {
    const update=(hud as {update?:(dt:number,state?:unknown)=>void}).update;if(!update)return;
    const state=name==='speedrun'?this.session.getSpeedRunState():name==='rebirth'?this.session.getRebirthState():
      name==='raid'?this.session.getRaidState():name==='boss'?this.session.getBossState(this.world.stage.boss):
      name==='mine'?this.session.getMineState():name==='hunt'?this.session.getHuntState():undefined;
    this.loadingTrace.measure(name,'initialBinding',()=>update.call(hud,0,state));
  }

  private get presentationOpen():boolean {return !!(this.offlineHud?.isOpen||this.dailyCheckHud?.isOpen||this.settingsHud?.isOpen||this.skinHud?.isOpen||this.petHud?.isOpen||this.fishHud?.isOpen||this.adventureHud?.isOpen);}

  private canPrepareHud(name:string):boolean {return !this.presentationOpen||HUDS_WITHOUT_COMPOSITOR.includes(name);}

  private prepareBackgroundHuds():boolean {
    if(!this.resourcePreloader||this.backgrounded||this.disposed||!this.preparationReady||
      (this.offlineSummaryPending&&!this.offlineHud)||this.openingFeature||this.settingsOpening||this.dailyCheckOpening||this.battleLoading||this.session.rebirthAnimating||this.rewardedAds?.isPresenting||Date.now()<this.memoryPressureUntil)return false;
    // Admit at most one ready HUD per frame. An unrelated asset/load Promise
    // must not hold all other panels; construction still shares the single
    // UiPreparationQueue frame budget, including compositor safety checks.
    if(this.shouldPrepareModule('dailyCheck')&&this.canPrepareHud('dailyCheck')&&!this.dailyCheckHud&&!this.dailyCheckHudRequest&&Date.now()>=this.dailyCheckRetryAt&&this.resourcePreloader.isFeatureReady('dailyCheck')){
      const request=this.ensureDailyCheckHud().then(()=>{},()=>{this.dailyCheckRetryAt=Date.now()+RESOURCE_LOADING_POLICY.background.retryDelayMs;})
        .then(()=>{if(this.backgroundHudRequests.get('dailyCheck')===request)this.backgroundHudRequests.delete('dailyCheck');});
      this.backgroundHudRequests.set('dailyCheck',request);return true;
    }
    const order=RESOURCE_MODULE_ORDER.filter((name):name is FeatureName|'settings'=>name!=='offline'&&name!=='dailyCheck');
    const name=order.find(key=>this.shouldPrepareModule(key)&&this.canPrepareHud(key)&&this.resourcePreloader!.isFeatureReady(key)&&(key==='settings'?
      !this.settingsHud&&!this.settingsHudRequest&&Date.now()>=this.settingsRetryAt:
      !this.hasDeferredHud(key)&&!this.deferredHudStates[key].request&&Date.now()>=this.deferredHudStates[key].retryAt));
    if(!name)return false;
    const request=(name==='settings'?this.ensureSettingsHud().then(()=>{},()=>{this.settingsRetryAt=Date.now()+RESOURCE_LOADING_POLICY.background.retryDelayMs;}):
      this.loadDeferredHud(name,true)).then(()=>{if(this.backgroundHudRequests.get(name)===request)this.backgroundHudRequests.delete(name);});
    this.backgroundHudRequests.set(name,request);
    return true;
  }

  private ensureSettingsHud():Promise<SettingsHud|undefined> {
    if(this.settingsHud)return Promise.resolve(this.settingsHud);
    if(this.settingsHudRequest)return this.settingsHudRequest;
    if(!this.settingsHudLoader)return Promise.resolve(undefined);
    const request=this.settingsHudLoader().then(hud=>{
      if(!this.disposed&&this.preparationReady&&hud){this.settingsHud=hud;this.modalStateDirty=true;}
      return hud;
    },error=>{if(this.settingsHudRequest===request)this.settingsHudRequest=undefined;throw error;});
    this.settingsHudRequest=request;return request;
  }

  private loadDeferredHud(name:DeferredHudName,background=false):Promise<void> {
    const state=this.deferredHudStates[name];
    if(state.request)return state.request;
    if(this.hasDeferredHud(name)||!this.preparationReady||this.disposed||!this.deferredHudLoaders)return Promise.resolve();
    state.attempts++;state.failed=false;
    const request=this.deferredHudLoaders[name]().then(()=>{
      state.failed=false;state.retryAt=0;
    },error=>{
      state.failed=!background||this.openingFeature===name;state.retryAt=Date.now()+RESOURCE_LOADING_POLICY.background.retryDelayMs;
      if(state.failed&&!this.disposed&&this.ready)console.error(`[ForestGunner] ${name} UI loading failed`,error);
    }).then(()=>{
      state.request=undefined;
      if(!this.disposed&&this.ready)this.refreshDeferredHudNotice();
    });
    state.request=request;this.refreshDeferredHudNotice();
    return request;
  }

  private getFeature(name:FeatureName) {
    return name==='weapons'?this.weaponsHud:name==='raid'?this.raidHud:name==='boss'?this.bossHud:name==='hunt'?this.huntHud:name==='mine'?this.mineHud:
      name==='speedrun'?this.speedRunHud:name==='skins'?this.skinHud:name==='pets'?this.petHud:name==='fish'?this.fishHud:name==='adventure'?this.adventureHud:this.rebirthHud;
  }

  private retainEntryResources(config:unknown,name:BackgroundFeature):void {
    if(!config)return;
    for(const resource of collectBackgroundResources(config,name))if(resource.kind==='image')this.coreResourcePaths.add(resource.path);
  }

  private async openFeature(name:FeatureName):Promise<void> {
    if(!this.ready||this.offlineSummaryPending||this.disposed||this.isPaused||this.session.mode!=='Main'||this.session.rebirthAnimating||this.modeRevealElapsed!==null)return;
    const access=this.session.getContentState(name);
    if(!access.unlocked){this.alerts?.show(access.message||'暂未开放');return;}
    const prepared=this.resourceModules.isViewReady(name)?this.getFeature(name):undefined;
    const version=++this.featureOpenVersion;this.openingFeature=prepared?undefined:name;
    this.moduleLastUsed.set(name,Date.now());
    this.featureNoticeAt=Date.now()+200;this.resourcePreloader?.prioritize(name);
    this.hud?.cancelInteractions();this.cancelSettingsOpening();this.settingsHud?.close();this.cancelDailyCheckOpening();this.dailyCheckHud?.close();
    [this.weaponsHud,this.rebirthHud,this.speedRunHud,this.raidHud,this.bossHud,this.huntHud,this.mineHud,this.skinHud,this.petHud,this.fishHud,this.adventureHud].forEach(hud=>hud?.close());
    this.syncModalState();
    // A ready panel must not briefly become a loading modal while awaiting an
    // already resolved Promise. Open it in this input event, even if the next
    // engine frame or the platform's Promise continuation is delayed.
    if(prepared){prepared.open();this.syncModalState();this.refreshDeferredHudNotice();return;}
    // Promote the existing module operation and its dependencies; retain the
    // same error presentation and retry state used by background preparation.
    void this.resourceModules.open(name).catch(()=>{});
    await this.loadDeferredHud(name);
    if(version!==this.featureOpenVersion||!this.ready||this.disposed||this.isPaused||this.session.mode!=='Main')return;
    this.openingFeature=undefined;
    if(this.session.getContentState(name).unlocked&&this.getFeature(name)){
      this.getFeature(name)!.open();
    }
    this.syncModalState();this.refreshDeferredHudNotice();
  }

  private updateDeferredHuds():void {
    if(!this.ready||this.disposed||this.backgrounded||this.session.mode!=='Main'||!this.artLibrary||!this.hudRoot)return;
    this.updateDailyCheckEntry();
    const adventureEntry=this.featureEntries.get('adventure');
    if(adventureEntry&&Date.now()>=this.adventureAlertAt){
      this.adventureAlertAt=Date.now()+10000;
      adventureEntry.setAlert(this.session.getContentState('adventure').unlocked&&this.session.getAdventureState().alert);
    }
    const visible=this.visibleDeferredHuds();
    for(const name of Object.keys(visible) as FeatureName[]) {
      if(!visible[name]||this.hasDeferredHud(name)||this.featureEntries.has(name)||this.entryRequests.has(name)||Date.now()<(this.entryRetryAt.get(name)??0))continue;
      const parent=this.hudRoot,art=this.artLibrary;
      const request=loadFeatureEntry(art,name).then(assets=>{
        if(this.disposed||!this.ready||!parent.isValid)return;
        this.retainEntryResources(assets.config,name);
        const previous=new Set(parent.children);
        let entry:FeatureEntry;
        try {entry=new FeatureEntry(parent,art,assets,name,()=>{void this.openFeature(name);},id=>this.sfx?.play(id));}
        catch(error){parent.children.filter(child=>!previous.has(child)).forEach(child=>child.destroy());throw error;}
        this.featureEntries.set(name,entry);this.entryRetryAt.delete(name);
        const overlay=this.tutorialHud?.node;if(overlay)entry.node.setSiblingIndex(overlay.getSiblingIndex());
        const {top,bottom}=this.safeAreaInsets();
        entry.resize(this.viewport.width,this.viewport.height,top,bottom);
        this.layoutLeftMenu();this.syncModalState();
      }).catch(error=>{
        this.entryRetryAt.set(name,Infinity);
        if(!this.disposed)console.error('[ForestGunner] Feature entry load failed',name,error);
      }).then(()=>{this.entryRequests.delete(name);this.refreshDeferredHudNotice();});
      this.entryRequests.set(name,request);
    }
    this.refreshDeferredHudNotice();
  }

  private refreshDeferredHudNotice():void {
    if(!this.ready||this.disposed)return;
    const visible=this.visibleDeferredHuds();
    const name=this.openingFeature||(Object.keys(visible) as FeatureName[]).find(key=>visible[key]&&
      (this.deferredHudStates[key].failed||this.entryRetryAt.has(key)));
    if(!name||this.backgrounded||this.session.mode!=='Main'||(this.openingFeature&&Date.now()<this.featureNoticeAt)){if(this.deferredHudNotice)this.deferredHudNotice.active=false;return;}
    if(this.openingFeature&&this.featureNoticeReportedVersion!==this.featureOpenVersion){
      this.featureNoticeReportedVersion=this.featureOpenVersion;
      console.info('[ForestGunner] Resource wait',name,this.resourceLoadingSnapshot());
    }
    if(!this.deferredHudNotice){
      const notice=this.deferredHudNotice=makeNode('FeatureLoadStatus',this.node);
      notice.getComponent(UITransform)!.setContentSize(620,90);
      const label=notice.addComponent(Label);label.fontSize=22;label.color=new Color(88,67,44);label.enableWrapText=true;
      notice.on(Node.EventType.TOUCH_END,()=>{
        if(this.openingFeature||this.backgrounded)return;
        this.entryRetryAt.clear();
        const failed=(Object.keys(this.deferredHudStates) as FeatureName[]).find(key=>this.visibleDeferredHuds()[key]&&this.deferredHudStates[key].failed);
        if(failed)void this.openFeature(failed);else this.updateDeferredHuds();
      });
    }
    this.deferredHudNotice.active=true;this.deferredHudNotice.setPosition(0,0);
    this.deferredHudNotice.getComponent(Label)!.string=this.openingFeature?`正在准备${DEFERRED_HUD_LABELS[name]}…`:'资源加载失败，点击重试';
  }

  private canOpenSettings():boolean {
    return this.ready&&!this.offlineSummaryPending&&!this.dailyCheckOpening&&!this.dailyCheckHud?.isOpen&&!this.openingFeature&&!this.disposed&&!this.isPaused&&!this.rewardedAds?.isPresenting&&this.session.mode==='Main'&&!this.session.rebirthAnimating&&this.modeRevealElapsed===null&&
      !this.weaponsHud?.isOpen&&!this.rebirthHud?.isOpen&&!this.skinHud?.isOpen&&!this.petHud?.isOpen&&!this.fishHud?.isOpen&&!this.adventureHud?.isOpen&&!this.speedRunHud?.blocksUpgrades&&!this.raidHud?.blocksUpgrades&&!this.bossHud?.blocksUpgrades&&!this.huntHud?.blocksUpgrades&&!this.mineHud?.blocksUpgrades;
  }

  private async openSettings():Promise<void> {
    if(!this.canOpenSettings()||this.settingsOpening||this.settingsHud?.isOpen)return;
    this.moduleLastUsed.set('settings',Date.now());
    if(this.settingsHud){this.resizeIfNeeded();this.syncModalState();this.settingsHud.open();if(this.settingsHud.isOpen)this.sfx?.play(1);this.syncModalState();return;}
    if(!this.settingsHudLoader)return;
    const version=++this.settingsOpenVersion;
    this.settingsOpening=true;this.settingsNoticeAt=Date.now()+200;this.resourcePreloader?.prioritize('settings');
    let request:Promise<SettingsHud|undefined>|undefined;
    try {
      this.hud?.cancelInteractions();
      this.syncModalState();
      void this.resourceModules.open('settings').catch(()=>{});
      request=this.ensureSettingsHud();
      const hud=await request;
      if(this.disposed||!this.ready||!hud)return;
      this.settingsHud=hud;
      if(version!==this.settingsOpenVersion||!this.canOpenSettings())return;
      // Release the temporary modal before opening SettingsHud, whose own
      // entry guard must still reject another feature that became foreground.
      this.settingsOpening=false;
      this.settingsLoading?.destroy();this.settingsLoading=undefined;
      this.resizeIfNeeded();this.syncModalState();
      hud.open();
      // Original Setting_Btn plays ClickSound only after its panel opens.
      if(hud.isOpen)this.sfx?.play(1);
    } catch(error) {
      if(this.settingsHudRequest===request)this.settingsHudRequest=undefined;
      if(version===this.settingsOpenVersion&&!this.disposed&&this.ready){
        console.error('[ForestGunner] Settings loading failed',error);
        this.alerts?.show('设置加载失败，请再次点击重试');
      }
    } finally {
      if(version===this.settingsOpenVersion){
        this.settingsOpening=false;
        this.settingsLoading?.destroy();this.settingsLoading=undefined;
        if(!this.disposed&&this.ready)this.syncModalState();
      }
    }
  }

  private cancelSettingsOpening():void {
    const wasOpening=this.settingsOpening;
    this.settingsOpenVersion++;
    this.settingsOpening=false;
    this.settingsLoading?.destroy();this.settingsLoading=undefined;
    if(wasOpening&&this.ready&&!this.disposed)this.syncModalState();
  }

  private refreshSettingsNotice():void {
    if(!this.settingsOpening||this.settingsLoading||this.backgrounded||this.disposed||Date.now()<this.settingsNoticeAt)return;
    console.info('[ForestGunner] Resource wait','settings',this.resourceLoadingSnapshot());
    this.settingsLoading=makeNode('SettingsLoading',this.node);
    const message=this.settingsLoading.addComponent(Label);
    message.string='正在加载设置资源…';message.fontSize=27;message.color=new Color(88,67,44);
  }

  private startSpeedRun() {
    if(!this.ready||!this.speedRunHud||this.isPaused||this.session.rebirthAnimating||this.modeRevealElapsed!==null)return {ok:false,reason:'unavailable'};
    const result=this.session.startSpeedRun();
    if(result.ok){
      this.hud?.cancelInteractions();this.weaponsHud?.close();this.rebirthHud?.close();this.raidHud?.close();this.bossHud?.close();this.huntHud?.close();this.mineHud?.close();this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();this.alerts?.clear();
      this.activateRound(this.session.round);this.world.stopCombat();this.sfx?.play(10);this.syncModalState();
    }
    return result;
  }

  private exitSpeedRun() {
    const result=this.session.exitSpeedRun();
    if(result.ok){
      this.cancelBattleAssetWait();this.worldRoundId=this.session.roundId;this.world.stopCombat();
      this.world.setBattlefieldActive(false);this.battlefield?.setBattlefieldActive(false);
      this.hud?.cancelInteractions();this.syncModalState();
    }
    return result;
  }

  private startRaid() {
    if(!this.ready||this.isPaused||this.session.rebirthAnimating||this.modeRevealElapsed!==null||this.weaponsHud?.isOpen)return {ok:false,reason:'unavailable'};
    const result=this.session.startRaid();
    if(result.ok)this.beginRaidPresentation();
    return result;
  }
  private completeRaidAd(token:string,outcome:AdOutcome) {
    const result=this.session.completeRaidAd(token,outcome);
    if(result.ok&&this.session.mode==='Raid')this.beginRaidPresentation();
    return result;
  }
  private beginRaidPresentation():void {
    this.hud?.cancelInteractions();this.weaponsHud?.close();this.rebirthHud?.close();this.speedRunHud?.close();this.bossHud?.close();this.huntHud?.close();this.mineHud?.close();this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();this.alerts?.clear();
    this.activateRound(this.session.round);this.world.stopCombat();this.sfx?.play(10);this.syncModalState();
  }
  private exitRaid() {
    const result=this.session.exitRaid();
    if(result.ok){
      this.cancelBattleAssetWait();this.worldRoundId=this.session.roundId;this.world.stopCombat();
      this.world.setBattlefieldActive(false);this.battlefield?.setBattlefieldActive(false);
      this.hud?.cancelInteractions();this.syncModalState();
    }
    return result;
  }
  private async openRaidStarUpgrade(slot:number):Promise<void> {
    if(!this.ready||this.isPaused||this.session.mode!=='Main'||this.session.getRaidState().phase!=='preparing')return;
    const request=++this.raidStarRequest;
    if(!this.weaponsHud)await this.loadDeferredHud('weapons');
    if(request!==this.raidStarRequest||!this.ready||this.disposed||this.isPaused||this.session.mode!=='Main'||this.session.getRaidState().phase!=='preparing')return;
    if(!this.weaponsHud){this.alerts?.show('武器界面加载失败，请再次点击重试');return;}
    this.raidHud?.cancelInteractions();
    this.weaponsHud?.openStarUpgrade(slot,level=>this.session.getRaidStarPreview(slot,level));
    this.syncModalState();
  }

  private startBoss() {
    if(!this.ready||this.isPaused||this.session.rebirthAnimating||this.modeRevealElapsed!==null||this.weaponsHud?.isOpen)return {ok:false,reason:'unavailable'};
    const result=this.session.startBoss();
    if(result.ok){
      this.hud?.cancelInteractions();this.weaponsHud?.close();this.rebirthHud?.close();this.speedRunHud?.close();this.raidHud?.close();this.huntHud?.close();this.mineHud?.close();this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();this.alerts?.clear();
      this.activateRound(this.session.round);this.world.stopCombat();this.sfx?.play(10);this.syncModalState();
    }
    return result;
  }
  private deactivateBossBattlefield():void {
    this.cancelBattleAssetWait();
    this.worldRoundId=this.session.roundId;this.world.stopCombat();
    this.world.setBattlefieldActive(false);this.battlefield?.setBattlefieldActive(false);
    this.hud?.cancelInteractions();this.syncModalState();
  }
  private exitBoss() {
    const result=this.session.exitBoss();
    if(result.ok)this.deactivateBossBattlefield();
    return result;
  }
  private completeBossAd(token:string,outcome:AdOutcome) {
    const result=this.session.completeBossAd(token,outcome);
    if(result.ok)this.deactivateBossBattlefield();
    return result;
  }

  private startMine() {
    if(!this.ready||this.isPaused||this.session.rebirthAnimating||this.modeRevealElapsed!==null)return {ok:false,reason:'unavailable'};
    const result=this.session.startMine();
    if(result.ok)this.beginMinePresentation();
    return result;
  }
  private beginMinePresentation():void {
    this.hud?.cancelInteractions();this.alerts?.clear();
    [this.weaponsHud,this.rebirthHud,this.speedRunHud,this.raidHud,this.bossHud,this.huntHud,this.skinHud,this.petHud,this.fishHud,this.adventureHud].forEach(hud=>hud?.close());
    this.world.stopCombat();this.world.setBattlefieldActive(false);this.battlefield?.setBattlefieldActive(false);
    this.mineDefinition=undefined;this.mineDefinitionRound=this.session.roundId;
    const seed=(this.seed^Math.imul(this.session.roundId-1,0x45d9f3b))>>>0;
    this.minePlacement=new MinePlacement(seed);this.battleLoading=true;
    this.bgm?.setMode('Mine');this.sfx?.play(10);this.syncModalState();
  }
  private exitMine() {
    const result=this.session.exitMine();
    if(result.ok)this.deactivateMineBattlefield();
    return result;
  }
  private deactivateMineBattlefield():void {
    this.minePlacement=undefined;this.cancelBattleAssetWait();
    this.worldRoundId=this.session.roundId;this.world.stopCombat();
    this.world.setBattlefieldActive(false);this.battlefield?.setBattlefieldActive(false);
    this.hud?.cancelInteractions();this.syncModalState();
  }
  private completeMineAd(token:string,outcome:AdOutcome) {
    const result=this.session.completeMineAd(token,outcome);
    if(result.ok&&this.session.mode==='Mine'){
      if(this.session.getMineState().phase==='entering')this.beginMinePresentation();
      else if(this.session.getMineState().phase==='exiting')this.deactivateMineBattlefield();
    }
    return result;
  }

  private startHunt() {
    if(!this.ready||this.isPaused||this.session.rebirthAnimating||this.modeRevealElapsed!==null||this.weaponsHud?.isOpen)return {ok:false,reason:'unavailable'};
    const result=this.session.startHunt(this.viewport.width/this.viewport.height,this.seed);
    if(result.ok){
      this.hud?.cancelInteractions();this.weaponsHud?.close();this.rebirthHud?.close();this.speedRunHud?.close();this.raidHud?.close();this.bossHud?.close();this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();this.alerts?.clear();
      this.activateRound(this.session.round);this.world.stopCombat();this.sfx?.play(10);this.syncModalState();
    }
    return result;
  }
  private giveUpHunt() {
    const result=this.session.giveUpHunt();
    if(result.ok){this.world.stopCombat();this.hud?.cancelInteractions();this.syncModalState();}
    return result;
  }
  private deactivateHuntBattlefield():void {
    this.cancelBattleAssetWait();this.worldRoundId=this.session.roundId;this.world.stopCombat();
    this.world.setBattlefieldActive(false);this.battlefield?.setBattlefieldActive(false);
    this.hud?.cancelInteractions();this.syncModalState();
  }
  private exitHunt() {
    const result=this.session.exitHunt();
    if(result.ok)this.deactivateHuntBattlefield();
    return result;
  }
  private completeHuntAd(token:string,outcome:AdOutcome) {
    const result=this.session.completeHuntAd(token,outcome);
    if(result.ok)this.deactivateHuntBattlefield();
    return result;
  }

  private requestRebirth(kind:'normal'|'ad') {
    if(!this.ready||this.isPaused)return {ok:false,reason:'unavailable'};
    const result=this.session.requestRebirth(kind);
    if(result.ok&&this.session.rebirthAnimating)this.beginRebirthPresentation();
    return result;
  }

  private beginRebirthPresentation():void {
    this.hud?.cancelInteractions();this.weaponsHud?.cancelInteractions();
    this.world.beginRebirth();
    this.syncModalState();
  }

  private purchaseRebirthUpgrade(type:UpgradeType):boolean {
    if(!this.ready||this.isPaused||this.session.rebirthAnimating)return false;
    if(!this.session.purchaseRebirthUpgrade(type))return false;
    this.syncLoadout('upgrade');return true;
  }

  private purchaseSkin(id:number):SkinActionResult {
    if(!this.ready||this.isPaused||this.modeRevealElapsed!==null)return {ok:false,reason:'busy'};
    const result=this.session.purchaseSkin(id);
    if(result.ok)this.hud?.update(this.hudState());
    return result;
  }

  private equipSkin(id:number):SkinActionResult {
    if(!this.ready||this.disposed||this.isPaused||this.modeRevealElapsed!==null||!this.skinVisuals?.isLoaded(id))return {ok:false,reason:'busy'};
    const result=this.session.equipSkin(id);
    if(result.ok)this.battlefield?.setSkin(this.session.getSkinState().selectedId);
    return result;
  }

  private async prepareSkin(id:number):Promise<void> {
    if(!this.ready||this.disposed||!this.skinVisuals)throw new Error('Skin view is unavailable');
    await this.skinVisuals.ensureLoaded(id);
  }

  private petCommand(operation:()=>PetActionResult):PetActionResult {
    if(!this.ready||this.disposed||this.isPaused||this.modeRevealElapsed!==null)return {ok:false,reason:'busy'};
    const result=operation();if(result.ok){this.syncPets();this.hud?.update(this.hudState());}return result;
  }
  private fishCommand(operation:()=>FishActionResult):FishActionResult {
    if(!this.ready||this.disposed||this.isPaused||this.modeRevealElapsed!==null)return {ok:false,reason:'busy'};
    const result=operation();if(result.ok&&result.changed){this.syncLoadout('upgrade');this.hud?.update(this.hudState());}return result;
  }
  private adventureResult<T extends {ok:boolean}>(result:T,attributes=false):T {
    if(result.ok){if(attributes)this.syncLoadout('upgrade');else this.syncPets();this.hud?.update(this.hudState());}
    return result;
  }
  private syncPets():void {
    if(!this.world||!this.session)return;
    const state=this.session.getPetState();this.world.setPetSpeedPercent(this.session.movementSpeedPercent);
    if(this.petVisuals)this.battlefield?.setPets(this.petVisuals,state.selected);
  }

  private syncLoadout(reason:'inventory'|'upgrade'|'equipment'='inventory'):void {
    if(!this.world||!this.session)return;
    this.syncPets();
    const loadout=this.session.combatLoadout;
    const signature=loadout.map(actor=>`${actor.weapon.id}:${actor.damage.toString()}:${actor.attackInterval}:${actor.starLevel}:${actor.criticalChance}:${actor.criticalMultiplier}:${actor.criticalRelicPercent?.toString()??''}:${actor.criticalRelicPercent?.precision??''}`).join('|');
    // Every successful source upgrade runs Balance_Reload and resets each
    // active cat's spread, even for money or an already capped attack speed.
    // EquipToSlot / PerformSlotSwap also reload balance when identical guns
    // leave the numeric loadout unchanged. Currency/locks do not trigger it.
    if(reason==='inventory'&&signature===this.loadoutSignature)return;
    this.world.setLoadout(loadout);this.loadoutSignature=signature;this.warmCombatSounds();
    this.battlefield?.prepareLoadout();
  }

  private purchaseUpgrade(type:UpgradeType):boolean {
    if(!this.ready||this.offlineSummaryPending||this.dailyCheckOpening||this.dailyCheckHud?.isOpen||this.isPaused||this.weaponsHud?.isOpen||this.rebirthHud?.isOpen||this.skinHud?.isOpen||this.petHud?.isOpen||this.fishHud?.isOpen||this.adventureHud?.isOpen||this.settingsHud?.isOpen||this.settingsOpening||this.openingFeature||this.speedRunHud?.blocksUpgrades||this.raidHud?.blocksUpgrades||this.bossHud?.blocksUpgrades||this.huntHud?.blocksUpgrades||this.mineHud?.blocksUpgrades||this.modeRevealElapsed!==null||this.session.rebirthAnimating||this.hudState().resultsReady)return false;
    if(!this.session.purchase(type))return false;
    this.syncLoadout('upgrade');
    // Upgrade_manager.Upgrade plays SFX 4 only after a successful purchase.
    // Both clicks and hold repeats share this path and the global cooldown.
    this.sfx?.play(4);
    this.hud!.update(this.hudState());
    return true;
  }

  /** Diagnostics enter implemented modes through the same gameplay transactions. */
  private setBattleMode(mode:BattleMode):void {
    if(!this.ready||mode===this.session.mode)return;
    if(mode==='SpeedRun'){this.startSpeedRun();return;}
    if(mode==='Raid'){this.raidHud?.open();this.startRaid();return;}
    if(mode==='Boss'){this.startBoss();return;}
    if(mode==='Mine'){this.mineHud?.open();this.startMine();return;}
    if(mode==='Monster'){this.startHunt();return;}
    if(mode==='Main'&&this.session.mode==='SpeedRun'){this.exitSpeedRun();return;}
    if(mode==='Main'&&this.session.mode==='Raid'){this.exitRaid();return;}
    if(mode==='Main'&&this.session.mode==='Boss'){this.exitBoss();return;}
    if(mode==='Main'&&this.session.mode==='Mine'){this.exitMine();return;}
    if(mode==='Main'&&this.session.mode==='Monster'){this.exitHunt();return;}
    if(this.session.mode==='Raid'||this.session.mode==='SpeedRun'||this.session.mode==='Boss'||this.session.mode==='Monster'||this.session.mode==='Mine')return;
    this.cancelSettingsOpening();
    this.hud?.cancelInteractions();
    this.weaponsHud?.close();
    this.rebirthHud?.close();
    this.speedRunHud?.close();
    this.raidHud?.close();
    this.bossHud?.close();this.huntHud?.close();this.mineHud?.close();
    this.skinHud?.close();this.petHud?.close();this.fishHud?.close();this.adventureHud?.close();
    this.alerts?.clear();
    this.session.setMode(mode);
    this.battlefield!.clearTransientEffects();
    if(this.isPaused)this.world.pause();else this.world.resume();
    this.skipFrame=true;
    this.hud!.update(this.hudState());
  }

  private togglePause():void {
    if(!this.ready)return;
    this.hud?.cancelInteractions();
    this.weaponsHud?.cancelInteractions();
    this.rebirthHud?.cancelInteractions();
    this.speedRunHud?.cancelInteractions();
    this.raidHud?.cancelInteractions();
    this.bossHud?.cancelInteractions();this.huntHud?.cancelInteractions();this.mineHud?.cancelInteractions();
    this.skinHud?.cancelInteractions();this.petHud?.cancelInteractions();this.fishHud?.cancelInteractions();this.adventureHud?.cancelInteractions();
    this.settingsHud?.cancelInteractions();
    this.offlineHud?.cancelInteractions();
    this.manuallyPaused=!this.manuallyPaused;
    if(this.manuallyPaused)this.cancelSettingsOpening();
    if(this.isPaused)this.world.pause();else this.world.resume();
    this.skipFrame=true;
  }
  private restart():void {
    if(!this.ready||this.session.rebirthAnimating||this.session.mode!=='Main')return;
    this.activateRound(this.session.restartRound());
  }

  private restartForTutorial(request:()=>boolean):boolean {
    if(!this.ready||this.disposed)return false;
    const sceneName=director.getScene()?.name;
    if(!sceneName||!request())return false;
    this.session.save();
    // Release views before scene teardown invalidates their pointer targets.
    // Reload just the scene: restarting the engine also reuses a destroyed
    // profiler canvas in Creator 3.8.8's EVENT_RESTART listener.
    this.clearViews();
    this.loading=makeNode('TutorialReload',this.node);
    const message=this.loading.addComponent(Label);message.string='正在重新开始…';message.fontSize=27;
    const failed=(error:Error|null):void=>{
      if(!error||this.disposed)return;
      console.error('[ForestGunner] Tutorial scene reload failed',error);
      if(message.isValid)message.string='重新开始失败，请重新打开';
    };
    const accepted=director.loadScene(sceneName,failed);
    if(!accepted)failed(new Error('Current scene could not be reloaded'));
    return accepted;
  }

  private activateRound(round:{roundId:number;stageIndex:number;waveIndex:number;movementMultiplier:1|2},rebirth=false):void {
    this.loadingTrace.mark('battle','activateRound');
    this.cancelBattleAssetWait();
    this.hud?.cancelInteractions();
    this.weaponsHud?.cancelInteractions();
    this.alerts?.clear();
    // A fresh wave/retry rerolls its grid while diagnostic seeds stay repeatable.
    const seed=(this.seed^Math.imul(round.roundId-1,0x45d9f3b))>>>0;
    const modeChanged=this.worldMode!==this.session.mode;
    if(modeChanged)this.cancelSettingsOpening();
    // Exit_Cor starts the main round, then leaves loading visible for .2 s.
    if(modeChanged&&this.session.mode==='Main')this.modeRevealElapsed=0;
    if(this.session.mode==='Mine'&&(!this.mineDefinition||this.mineDefinitionRound!==round.roundId))return;
    const definition=this.session.mode==='Mine'?this.mineDefinition!:
      this.session.mode==='Monster'?createHuntDefinition(this.session.getHuntCombat()!):
      this.session.mode==='Boss'?createBossDefinition(new BossCombat(round.stageIndex,seed)):
      this.session.mode==='Raid'?createRaidDefinition(this.session.getRaidBossCombat()!):
      this.session.mode==='SpeedRun'?createSpeedRunDefinition(round.stageIndex,seed):createStageDefinition(round.stageIndex,round.waveIndex,seed);
    if(this.battleAssets&&!this.battleAssets.ready(definition)) {
      this.waitForBattleAssets(definition,()=>this.activateRound(round,rebirth));return;
    }
    this.world.reset(seed,definition,rebirth?{preserveActorState:true,rebirth:true}:modeChanged?{preserveActorState:true,preserveProjectiles:true}:true);
    this.worldMode=this.session.mode;
    const scale=this.viewport.height/(this.world?.hunt?90:80);
    this.worldScale?.setScale(scale,scale,1);
    this.bgm?.setMode(this.session.mode);
    if(modeChanged)this.settingsHud?.close();
    this.worldRoundId=round.roundId;
    this.world.setMovementMultiplier(round.movementMultiplier);
    this.syncLoadout('upgrade');
    if(this.isPaused)this.world.pause();
    if(!this.session.canFight)this.world.stopCombat();
    this.battlefield!.reset({preserveCharacterState:rebirth||modeChanged,preserveTransientEffects:rebirth||modeChanged});this.battlefield!.update(0);
    if(this.session.mode==='Mine')this.session.setMineOreCount(definition.ores?.length??0,round.roundId);
    this.hud!.update(this.hudState());
  }
  private warmCombatSounds():void {
    if(!this.audioPreferences?.soundEnabled||!this.artLibrary?.weaponVisuals||!this.sfx)return;
    const ids=this.session.combatLoadout.map(actor=>this.artLibrary!.weaponVisuals!.appearance(actor.weapon.id).soundId);
    void this.sfx.preload([1,...ids]);
  }

  private cancelBattleAssetWait():void {
    this.battleLoadVersion++;this.battleLoading=false;this.battleRetry=undefined;
    if(this.battleNotice)this.battleNotice.active=false;
  }

  private prefetchNextStage():void {
    if(!this.battleAssets||!this.resourcePreloader||this.isPaused||this.session.mode!=='Main'||Date.now()<this.prefetchAt)return;
    const index=this.session.round.stageIndex+1;
    if(this.prefetchedStage===index)return;
    this.prefetchedStage=index;
    this.battleAssets.preload(createStageDefinition(index,0,this.seed),this.resourcePreloader);
  }

  private waitForBattleAssets(definition:StageDefinition,activate:()=>void):void {
    const version=++this.battleLoadVersion,roundId=this.session.roundId,mode=this.session.mode;
    this.battleLoading=true;this.world.pause();this.hud?.cancelInteractions();
    if(!this.battleNotice){
      this.battleNotice=makeNode('BattleResourceStatus',this.node);
      this.battleNotice.getComponent(UITransform)!.setContentSize(620,100);
      const label=this.battleNotice.addComponent(Label);label.fontSize=25;label.color=new Color(88,67,44);
      this.battleNotice.on(Node.EventType.TOUCH_END,()=>{const retry=this.battleRetry;this.battleRetry=undefined;retry?.();});
    }
    const current=()=>!this.disposed&&this.ready&&version===this.battleLoadVersion&&roundId===this.session.roundId&&mode===this.session.mode;
    const attempt=():void=>{
      if(!current())return;
      this.battleNoticeAt=Date.now()+200;
      this.battleNotice!.active=false;this.battleNotice!.getComponent(Label)!.string='正在准备下一场战斗…';
      void this.battleAssets!.load(definition).then(()=>{
        if(!current())return;
        this.battleLoading=false;this.battleRetry=undefined;this.battleNotice!.active=false;
        activate();this.skipFrame=true;this.syncModalState();
      },error=>{
        if(!current())return;
        console.error('[ForestGunner] Battle resources failed',error);
        this.battleNotice!.active=!this.backgrounded;
        this.battleNotice!.getComponent(Label)!.string='资源加载失败，点击重试';this.battleRetry=attempt;
      });
    };
    attempt();this.syncModalState();
  }

  private onHide():void {
    this.resourcePreloader?.pause();
    if(this.battleNotice)this.battleNotice.active=false;
    this.featureOpenVersion++;this.openingFeature=undefined;this.featureEntries.forEach(entry=>entry.cancelInteractions());
    this.raidStarRequest++;
    if(this.deferredHudNotice)this.deferredHudNotice.active=false;
    this.cancelSettingsOpening();
    this.cancelDailyCheckOpening();this.dailyCheckEntry?.cancelInteractions();this.dailyCheckHud?.cancelInteractions();
    this.bgm?.setPaused(true);
    this.settingsHud?.cancelInteractions();
    this.offlineHud?.cancelInteractions();
    this.rewardedAds?.cancelAll();
    this.rewardedAdModal?.cancelInteractions();
    this.hud?.cancelInteractions();
    this.weaponsHud?.cancelInteractions();
    this.rebirthHud?.cancelInteractions();
    this.speedRunHud?.cancelInteractions();
    this.raidHud?.cancelInteractions();
    this.bossHud?.cancelInteractions();this.huntHud?.cancelInteractions();this.mineHud?.cancelInteractions();
    this.skinHud?.cancelInteractions();this.petHud?.cancelInteractions();this.fishHud?.cancelInteractions();this.adventureHud?.cancelInteractions();
    this.session?.cancelRebirthAd();
    this.session?.cancelSpeedRunAd();
    this.session?.cancelRaidAd();
    this.session?.cancelBossAd();
    this.session?.cancelHuntAd();
    this.session?.cancelMineAd();
    this.session?.cancelPetAd();
    this.alerts?.clear();
    this.tutorialHud?.hide();
    const pending=this.session?.weapons.snapshot().pendingAd;
    if(pending)this.session.weapons.completeAd(pending.token,'cancel');
    this.session?.save();
    this.backgrounded=true;this.skipFrame=true;
    if(this.ready)this.world.pause();
  }
  private readonly onDocumentFreeze=():void=>this.onHide();
  private readonly onDocumentResume=():void=>this.onShow();
  private onShow():void {
    this.backgrounded=false;this.skipFrame=true;
    this.backgroundPreparation.reset(RESOURCE_LOADING_POLICY.backgroundScheduling.recoveryDelayMs);
    // Navigation mode/safe bounds can change while hidden without a Canvas resize.
    if(this.canvasTransform&&!this.disposed)this.resizeIfNeeded(true);
    this.offlineCheckpointAt=Date.now()+10000;
    this.session?.checkpointForeground();
    this.dailyCheckHud?.update(0);
    this.resourcePreloader?.resume();
    if(this.battleLoading&&this.battleNotice&&this.battleRetry)this.battleNotice.active=true;
    this.bgm?.setPaused(false);
    if(this.ready)void this.loadBgm();
    if(this.ready&&!this.isPaused)this.world.resume();
  }
  private resizeIfNeeded(checkSafeArea=false):void {
    const size=this.canvasTransform.contentSize;
    if(size.width!==this.viewport.width||size.height!==this.viewport.height)this.resize();
    else if(checkSafeArea) {
      const insets=this.safeAreaInsets();
      if(insets.top!==this.layoutInsets.top||insets.bottom!==this.layoutInsets.bottom)this.resize();
    }
  }
  private safeAreaInsets():SafeAreaInsets {
    const scope=globalThis as typeof globalThis & {wx?:SafeAreaHost;window?:{wx?:SafeAreaHost}};
    return resolveSafeAreaInsets(this.viewport,()=>sys.getSafeAreaRect(false),WECHAT?(scope.wx??scope.window?.wx):undefined);
  }
  private resizeStartupScreen(width:number,height:number):void {
    if(!this.startupInputBlock?.isValid)return;
    this.startupInputBlock.getComponent(UITransform)!.setContentSize(width,height);
    const background=this.startupInputBlock.getComponent(Graphics)!;
    background.clear();background.rect(-width/2,-height/2,width,height);background.fill();
    this.loading?.getComponent(UITransform)?.setContentSize(Math.max(1,Math.min(650,width-64)),Math.max(1,Math.min(340,height-64)));
    this.startupScreen?.resize(width,height);
  }
  private resize():void {
    const size=(this.canvasTransform??this.node.getComponent(UITransform)!).contentSize;
    this.viewport={width:size.width||720,height:size.height||1280};
    this.resizeStartupScreen(this.viewport.width,this.viewport.height);
    const scale=this.viewport.height/(this.world?.hunt?90:80);
    this.worldScale?.setScale(scale,scale,1);
    this.colors?.resize(this.viewport.width,this.viewport.height);
    this.battlefield?.setViewport(this.viewport.width/this.viewport.height);
    const {top:topInset,bottom:bottomInset}=this.safeAreaInsets();
    this.layoutInsets={top:topInset,bottom:bottomInset};
    this.hud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.weaponsHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.rebirthHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.speedRunHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.raidHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.bossHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.huntHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.mineHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.skinHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.petHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.fishHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.adventureHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.settingsHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.offlineHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.dailyCheckHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.dailyCheckEntry?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.featureEntries.forEach(entry=>entry.resize(this.viewport.width,this.viewport.height,topInset,bottomInset));
    this.tutorialHud?.resize(this.viewport.width,this.viewport.height,topInset,bottomInset);
    this.rewardedAdModal?.resize(this.viewport.width,this.viewport.height);
    this.alerts?.resize(this.viewport.width,this.viewport.height);
    this.world?.setViewport(this.viewport.width/this.viewport.height);
    this.world?.hunt?.setAspect(this.viewport.width/this.viewport.height);
    if(this.session){this.layoutLeftMenu();this.layoutRightMenu();}
  }
  private countNodes(n:Node):number {return 1+n.children.reduce((count,child)=>count+this.countNodes(child),0);}
  private clearViews():void {
    this.startupGeneration++;this.startupRequest=undefined;this.startupCurrent=undefined;
    this.startupAssetRequest=undefined;this.startupAssetsAttempted.clear();this.startupModules=[];
    this.startupFailure=undefined;this.startupAttempts=0;this.startupRetryAt=0;
    // Startup failures keep the complete page visible and clickable for retry.
    this.startupInputBlock?.off(Node.EventType.TOUCH_END,this.retryStartupPreparation,this);
    this.preparationReady=false;this.startupRelease?.();this.startupRelease=undefined;
    this.resourceModules.dispose();this.resourceModules=this.createResourceModules();this.moduleGuards.clear();
    this.collectionWarmRequest=undefined;this.moduleAssetPaths.clear();this.coreResourcePaths.clear();this.memoryEvictedModules.clear();this.pendingFrameEvictions.clear();
    this.cancelDailyCheckOpening();
    this.dailyCheckHud?.destroy();this.dailyCheckHud=undefined;
    this.dailyCheckEntry?.destroy();this.dailyCheckEntry=undefined;
    this.dailyCheckHudLoader=undefined;this.dailyCheckHudRequest=undefined;this.dailyCheckEntryRequest=undefined;
    this.dailyCheckAutoPending=false;
    this.cancelOfflineRetry?.();
    this.offlineHud?.destroy();this.offlineHud=undefined;
    this.offlineNotice?.destroy();this.offlineNotice=undefined;
    this.offlineHudLoader=undefined;this.offlineHudRequest=undefined;this.offlineSummaryPending=false;
    this.resourcePreloader?.dispose();this.resourcePreloader=undefined;
    this.uiPreparation.dispose();this.uiPreparation=this.createUiPreparation();this.backgroundHudRequests.clear();this.preparedLayouts.clear();this.firstHudUpdates.clear();
    this.backgroundPreparation.reset();this.nextBackgroundDecodeAt=0;
    this.ready=false;this.featureOpenVersion++;this.openingFeature=undefined;
    this.battleLoadVersion++;this.battleLoading=false;this.battleRetry=undefined;
    this.battleNotice?.destroy();this.battleNotice=undefined;this.battleAssets=undefined;
    this.featureEntries.forEach(entry=>entry.destroy());this.featureEntries.clear();this.entryRequests.clear();
    this.startupProgress=undefined;
    this.bgmLoadVersion++;
    this.bgmAssetsLoader=undefined;this.bgmRequest=undefined;
    this.raidStarRequest++;
    this.deferredHudLoaders=undefined;
    this.deferredHudNotice?.destroy();this.deferredHudNotice=undefined;
    this.cancelSettingsOpening();
    this.settingsHudLoader=undefined;this.settingsHudRequest=undefined;
    this.rewardedAds?.destroy();this.rewardedAds=undefined;
    this.rewardedAdModal?.destroy();this.rewardedAdModal=undefined;
    this.world?.pause();
    this.world?.setMuzzleProvider(null);
    // Restore the skin capture camera before the world compositor restores
    // the original display-camera visibility during teardown.
    this.settingsHud?.destroy();this.settingsHud=undefined;
    this.fishHud?.destroy();this.fishHud=undefined;
    this.adventureHud?.destroy();this.adventureHud=undefined;
    this.petHud?.destroy();this.petHud=undefined;this.petVisuals=undefined;
    this.skinHud?.destroy();this.skinHud=undefined;
    this.skinVisuals=undefined;
    if(this.presentationCamera)disposeSkinHudPresentation(this.presentationCamera);
    this.battlefield?.destroy();this.battlefield=undefined;
    this.colors?.destroy();this.colors=undefined;
    this.hud?.destroy();
    this.weaponsHud?.destroy();this.weaponsHud=undefined;
    this.rebirthHud?.destroy();this.rebirthHud=undefined;
    this.speedRunHud?.destroy();this.speedRunHud=undefined;
    this.raidHud?.destroy();this.raidHud=undefined;
    this.bossHud?.destroy();this.bossHud=undefined;
    this.huntHud?.destroy();this.huntHud=undefined;
    this.mineHud?.destroy();this.mineHud=undefined;this.minePlacement=undefined;this.mineDefinition=undefined;
    this.tutorialHud?.destroy();this.tutorialHud=undefined;
    this.alerts?.destroy();this.alerts=undefined;
    this.sfx?.destroy();this.sfx=undefined;
    this.bgm?.destroy();this.bgm=undefined;
    if(this.hudRoot?.isValid)this.hudRoot.destroy();
    this.hudRoot=undefined;this.hud=undefined;
    this.worldScale=undefined;
    this.artLibrary?.dispose();this.artLibrary=undefined;
  }
  onDestroy():void {
    this.disposed=true;
    (globalThis as any).wx?.offMemoryWarning?.(this.onMemoryWarning);
    this.clearViews();
    this.loadingText?.destroy();this.loadingText=undefined;
    this.startupScreen?.destroy();this.startupScreen=undefined;
    if(this.startupInputBlock?.isValid)this.startupInputBlock.destroy();
    this.startupInputBlock=undefined;
    this.loading=undefined;
    game.off(Game.EVENT_HIDE,this.onHide,this);game.off(Game.EVENT_SHOW,this.onShow,this);
    if(typeof document!=='undefined') {
      document.removeEventListener('freeze',this.onDocumentFreeze);
      document.removeEventListener('resume',this.onDocumentResume);
    }
    view.off('canvas-resize',this.resize,this);
    if(this.loadingDiagnosticsApi){
      const scope=globalThis as typeof globalThis & {__forestGunnerLoading?:object};
      if(scope.__forestGunnerLoading===this.loadingDiagnosticsApi)delete scope.__forestGunnerLoading;
      this.loadingDiagnosticsApi=undefined;
    }
    if(this.debugApi) {
      const scope=globalThis as typeof globalThis & {__forestGunner?:object};
      if(scope.__forestGunner===this.debugApi)delete scope.__forestGunner;
      this.debugApi=undefined;
    }
  }
}
