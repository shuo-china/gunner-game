import { BlockInputEvents, EventTouch, Font, Mask, Node, UITransform, Vec3 } from 'cc';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { adventureRequiredExp } from '../session/AdventureSystem';
import type { AdventureActionResult, AdventureDispatchPet, AdventureMapSnapshot, AdventurePreview, AdventureSnapshot, CoreType, MapType } from '../session/AdventureSystem';
import type { RelicActionResult, RelicDrawItem, RelicItemSnapshot, RelicSnapshot } from '../session/RelicSystem';
import type { PetSlotRef, PetSnapshot } from '../session/PetSystem';
import type { ContentState } from '../session/ContentUnlockManager';
import type { RewardedAdOutcome, RewardedAdPresenter } from '../session/RewardedAds';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { initialUiLayout, OriginalGradeBadgePool, OriginalWeaponUi, uiPreparationPhase } from './OriginalWeaponUi';
import type { OriginalUiNode, UiPreparation, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';
import { OriginalWeaponScroll } from './OriginalWeaponScroll';
import { SkinHudColorPipeline } from './SkinHudColorPipeline';
import type { SkinHudPresentation } from './SkinHudColorPipeline';
import { loadResourceBatch } from './ResourceBatch';
import { AdventureCamp } from './AdventureCamp';
import type { AdventureCampSpec } from './AdventureCamp';
import { PetVisualAssets } from './PetView';

type Role=Record<string,any>;
export interface AdventureUiConfig extends WeaponUiConfig {
  portraits:string[];coreSprites:string[];camp:AdventureCampSpec;
  tweens:Record<string,Role>;fills:{node:string;amount:number;direction:number}[];
}
export interface AdventureHudAssets extends WeaponHudAssets {config:AdventureUiConfig;petVisuals:PetVisualAssets;}
export interface AdventureHudCallbacks {
  getState():AdventureSnapshot;getPetState():PetSnapshot;getRelicState():RelicSnapshot;
  getContentState():ContentState;getAdState?():ContentState;
  preview(type:MapType,index:number,pets:PetSlotRef[]):AdventurePreview;
  start(type:MapType,index:number,pets:PetSlotRef[]):AdventureActionResult;
  cancel(type:MapType,index:number):AdventureActionResult;claim(type:MapType,index:number):AdventureActionResult;
  drawRelic(core:CoreType,max:boolean):RelicActionResult;upgradeRelic(index:number):RelicActionResult;
  beginAd?(type:MapType,index:number):AdventureActionResult&{token?:string};
  completeAd?(token:string,outcome:RewardedAdOutcome):AdventureActionResult;cancelAd?():void;
  onBeforeOpen?():void;onVisibilityChanged?(visible:boolean):void;alert?(message:string):void;playSfx?(id:number):void;
}
export async function loadAdventureHudAssets(art:ArtLibrary,petVisuals=new PetVisualAssets(art)):Promise<AdventureHudAssets> {
  const config=await art.json<AdventureUiConfig>('art/adventure-system/config');
  if(config.version!==1||config.coreSprites.length!==4||config.portraits.length!==13||!config.bitmapFonts||!config.roots.relicDraw||config.camp.pets.length!==19)throw new Error('Invalid original adventure UI');
  const paths=Object.values(config.images).map(image=>image.path);
  for(const font of Object.values(config.bitmapFonts))paths.push(...font.pages);
  await loadResourceBatch(Array.from(new Set(paths)).map(path=>()=>art.loadFrame(path)));
  const font=new Font();return {config,petVisuals,chineseFont:font,originalFont:font,numberFont:font};
}
const color=(c:any):number[]=>Array.isArray(c)?c:c?[c.r*255,c.g*255,c.b*255,c.a*255]:[255,255,255,255];
const samePet=(a:PetSlotRef,b:PetSlotRef):boolean=>a.kind===b.kind&&a.index===b.index;
export function adventureDuration(ms:number,ticket=false):string {
  const seconds=Math.max(0,Math.floor(ms/1000)),h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;
  return h>0?(ticket?`${h}h ${m}m`:`${h}h ${m}m ${s}s`):m>0?`${m}m ${s}s`:`${s}s`;
}
interface RewardSequence {elapsed:number;type:MapType;core:number;exp:number;playedLevelUps:number;levels:{level:number;from:number;to:number;need:number;duration:number}[];}

/** Source-authored travel and ability panels. Commands remain atomic session
 * operations; opening, selection, animation and resource preparation are pure UI. */
export class AdventureHud {
  readonly node:Node;readonly prepared:Promise<void>;
  private readonly ui:OriginalWeaponUi;private readonly colors?:SkinHudColorPipeline;
  private readonly gradeBadges:OriginalGradeBadgePool;
  private readonly layoutGroups:OriginalUiNode[];
  private readonly groupedChildren=new Set<string>();
  private readonly roots=new Map<string,Node>();private readonly feedback=new OriginalWeaponFeedback(undefined);
  private readonly touches=new Map<Node,number>();private readonly fills=new Map<Node,{width:number;height:number;x:number;y:number}>();
  private readonly bounces=new Map<Node,{elapsed:number;duration:number;scale:number;base:[number,number]}>();
  private readonly panel:Role;private readonly enter:Role;private readonly petSelect:Role;private readonly reward:Role;
  private readonly exit:Role;private readonly relicManager:Role;private readonly relicDetail:Role;private readonly relicDraw:Role;private readonly relicDown:Role;
  private scroll?:OriginalWeaponScroll;private camp?:AdventureCamp;
  private initialized=false;private destroyed=false;private entryVisible=true;private entryBlocked=false;private entryOffset=855;
  private currentMap:MapType=0;private currentIndex=0;private selected:AdventureDispatchPet[]=[];private choices:AdventureDispatchPet[]=[];
  private tab=0;private core:CoreType=0;private detailIndex:number|null=null;private drawItems:RelicDrawItem[]=[];private drawPage=0;private drawTime=0;
  private drawLayoutKey='';
  private rewardSequence:RewardSequence|null=null;private adToken:string|null=null;private elapsed=0;private refreshKey='';

  constructor(parent:Node,art:ArtLibrary,private readonly assets:AdventureHudAssets,private readonly callbacks:AdventureHudCallbacks,
    presentation?:SkinHudPresentation,private readonly rewardedAds?:RewardedAdPresenter,prepare?:UiPreparation) {
    this.node=makeNode('OriginalAdventureHud',parent);if(presentation)this.colors=new SkinHudColorPipeline(this.node,presentation);
    this.ui=new OriginalWeaponUi(art,assets,this.colors?.materials);
    const roles=assets.config.roles,role=(type:string):Role=>{const r=Object.values(roles).find(v=>v.type===type);if(!r)throw new Error('Missing adventure role '+type);return r;};
    this.gradeBadges=new OriginalGradeBadgePool(Object.values(roles));
    this.layoutGroups=Object.values(assets.config.nodes).filter(spec=>spec.layoutType==='VerticalLayoutGroup'||spec.layoutType==='GridLayoutGroup');
    for(const group of this.layoutGroups)this.groupedChildren.add(group.id);
    this.panel=role('Adventure_Panel');this.enter=role('Adventure_Enter_popup');this.petSelect=role('Adventure_PetSelect_popup');this.reward=role('Adventure_Reward_popup');this.exit=role('Adventure_Exit_Panel');
    this.relicManager=role('Relic_manager');this.relicDetail=role('Relic_Info_UI');this.relicDraw=role('Relic_Draw_Panel');this.relicDown=role('Relic_DownPanel');
    const initialize=function*(this:AdventureHud):Generator<void>{
      for(const [name,id] of Object.entries(assets.config.roots)) {
        const root=yield* this.ui.createSteps(id,name==='entry'?this.node:this.colors?.content??this.node,undefined,this.gradeBadges.include);
        root.active=name==='entry';this.roots.set(name,root);
        if(name!=='entry'){
          root.addComponent(BlockInputEvents);
          root.children.filter(child=>child.name==='Panel'||child.name==='Pet_Panel'||child.name==='Currency_Core'||child.name==='PrismCore_Panel').forEach(child=>child.addComponent(BlockInputEvents));
        }
      }
      for(const spec of Object.values(assets.config.nodes))if(spec.button){this.bindButton(spec);yield;}
      const scrollSpec=Object.values(assets.config.nodes).find(spec=>spec.layoutType==='ScrollRect');
      if(scrollSpec){this.scroll=this.ui.node(scrollSpec.id).addComponent(OriginalWeaponScroll);this.scroll.content=this.ui.node(scrollSpec.layout!.m_Content);this.scroll.configure(scrollSpec.layout!);this.scroll.onPositionChanged=()=>this.colors?.invalidate();}
      this.camp=new AdventureCamp(art,this.ui.node(assets.config.camp.node),assets.config,assets.config.camp,assets.petVisuals,this.colors?.materials,()=>this.colors?.invalidate());yield;
      yield* uiPreparationPhase(prepare,'layout',this.resizeSteps(...initialUiLayout(prepare),false));
      yield* uiPreparationPhase(prepare,'initialRefresh',this.refreshSteps());
      if(this.colors)yield* uiPreparationPhase(prepare,'inputBinding',this.colors.bindInputSteps());
      this.initialized=true;
    };
    this.prepared=this.ui.prepare(this.node,parent,initialize.call(this),prepare,()=>this.releasePreparation());
  }
  get isOpen():boolean{return !this.destroyed&&!!this.roots.get('main')?.active;}
  setEntryVisible(value:boolean):void{this.entryVisible=value;this.syncAccess();}
  setEntryBlocked(value:boolean):void{
    this.entryBlocked=value;if(!value||this.destroyed)return;
    // The modal coordinator blocks the menu entry every frame while this panel
    // is open. Keep the panel's in-flight presses until their matching release.
    const entry=this.roots.get('entry')!;this.touches.delete(entry);this.feedback.cancelButton(entry);
  }
  setEntryOffset(y:number):void{this.entryOffset=y;if(this.destroyed)return;const tr=this.node.getComponent(UITransform)!;this.roots.get('entry')?.setPosition(tr.width/2,-tr.height/2+y);}
  open():void{
    if(this.destroyed||this.isOpen||!this.entryVisible)return;
    const state=this.callbacks.getContentState();if(!state.visible||!state.unlocked){if(state.message)this.callbacks.alert?.(state.message);return;}
    this.callbacks.onBeforeOpen?.();this.cancelInteractions();this.tab=0;this.roots.get('main')!.active=true;this.colors?.setActive(true);this.refreshKey='';this.refresh();this.callbacks.onVisibilityChanged?.(true);
  }
  close():void{
    if(this.destroyed)return;const open=this.isOpen;this.cancelInteractions();this.detailIndex=null;this.rewardSequence=null;this.drawItems=[];
    for(const [name,root] of Array.from(this.roots))if(name!=='entry')root.active=false;
    this.colors?.setActive(false);if(open)this.callbacks.onVisibilityChanged?.(false);
  }
  cancelInteractions():void{
    this.touches.clear();this.feedback.clear();this.scroll?.stopAutoScroll();
    for(const [node,m] of Array.from(this.bounces))node.setScale(...m.base,1);this.bounces.clear();
    if(this.adToken){const token=this.adToken;this.adToken=null;this.rewardedAds?.cancelRewardedAd(token);this.callbacks.cancelAd?.();}
    this.colors?.invalidate();
  }
  resizePrepared(prepare:UiPreparation,width:number,height:number,top=0,bottom=0):Promise<void>{return this.ui.prepare(this.node,this.node.parent!,this.resizeSteps(width,height,top,bottom),prepare,()=>this.releasePreparation());}
  resize(width:number,height:number,top=0,bottom=0):void{for(const _ of this.resizeSteps(width,height,top,bottom)){/* synchronous callers */}}
  private *resizeSteps(width:number,height:number,top=0,bottom=0,refresh=true):Generator<void>{
    if(this.destroyed||width<=0||height<=top+bottom)return;
    const offset=this.scroll?.content?.position.y??0;this.cancelInteractions();
    const scale=width/1080,h=(height-top-bottom)/scale;this.node.setScale(scale,scale,1);this.node.setPosition(0,(bottom-top)/2);this.node.getComponent(UITransform)!.setContentSize(1080,h);
    // Group children get their final size below. Do not first redraw the same
    // subtree with stale exported anchors, including its bitmap text.
    for(const [name,id] of Object.entries(this.assets.config.roots))yield* this.ui.layoutSteps(id,name==='entry'?130:1080,name==='entry'?120:h,name==='entry'?0:top/scale,name==='entry'?0:bottom/scale,id=>!this.groupedChildren.has(id));
    // Unity stretches these three cards to the available lower panel height.
    const list=this.ui.node('level0:1151'),tr=list.getComponent(UITransform)!,heightPer=(tr.height-120)/3;
    for(let index=0;index<this.panel.Adventure_Map_list.length;index++){
      const card=this.assets.config.roles[this.panel.Adventure_Map_list[index]],node=this.ui.node(card.node);
      yield* this.ui.layoutSteps(card.node,tr.width-40,heightPer);node.setPosition(0,tr.height/2-40-heightPer*(index+.5)-20*index);
    }
    for(const spec of this.layoutGroups)if(spec.id!=='level0:1151')yield* this.layoutSourceGroup(spec);
    this.setEntryOffset(this.entryOffset);this.fills.clear();this.drawLayoutKey='';
    for(const fill of this.assets.config.fills){const node=this.ui.node(fill.node),size=node.getComponent(UITransform)!;this.fills.set(node,{width:size.width,height:size.height,x:node.position.x,y:node.position.y});(node.getComponent(Mask)??node.addComponent(Mask)).type=Mask.Type.GRAPHICS_RECT;}
    if(this.scroll?.content){const content=this.scroll.content,view=content.parent!.getComponent(UITransform)!;content.setPosition(content.position.x,Math.max(0,Math.min(offset,content.getComponent(UITransform)!.height-view.height)));}
    this.camp?.resize();this.colors?.resize(width,height);this.refreshKey='';if(refresh)yield* this.refreshSteps();
  }
  /** Unity layout groups drive top-left anchors at runtime. Their serialized
   * RectTransform anchors are stale cache values and cannot position the rows. */
  private *layoutSourceGroup(spec:OriginalUiNode,visibleOnly=false):Generator<void>{
    const group=spec.layout!,parent=this.ui.node(spec.id),pt=parent.getComponent(UITransform)!,padding=group.m_Padding;
    const children=spec.children.filter(key=>!visibleOnly||this.ui.node(key).active);if(!children.length)return;
    const innerW=pt.width-padding.m_Left-padding.m_Right,innerH=pt.height-padding.m_Top-padding.m_Bottom;
    const ax=(group.m_ChildAlignment%3)/2,ay=Math.floor(group.m_ChildAlignment/3)/2;
    if(spec.layoutType==='VerticalLayoutGroup'){
      if(group.m_ReverseArrangement)children.reverse();
      const sizes=children.map(key=>this.assets.config.nodes[key].rect.size),required=sizes.reduce((sum,size)=>sum+size[1],0)+(children.length-1)*group.m_Spacing;
      const extra=Math.max(0,innerH-required),cellExtra=group.m_ChildForceExpandHeight?extra/children.length:0;
      let cursor=padding.m_Top+(cellExtra?0:extra*ay);
      for(let i=0;i<children.length;i++){
        const key=children[i],rect=this.assets.config.nodes[key].rect,width=group.m_ChildControlWidth?innerW:sizes[i][0],height=sizes[i][1]+(group.m_ChildControlHeight?cellExtra:0),cellH=sizes[i][1]+cellExtra;
        yield* this.ui.layoutSteps(key,width,height);
        this.ui.node(key).setPosition(-pt.width*pt.anchorX+padding.m_Left+(innerW-width)*ax+width*rect.pivot[0],pt.height*(1-pt.anchorY)-cursor-(cellH-height)*ay-height*(1-rect.pivot[1]));
        cursor+=cellH+group.m_Spacing;
      }
      return;
    }
    const cell=group.m_CellSize,spacing=group.m_Spacing,n=children.length;
    let columns:number,rows:number;
    if(group.m_Constraint===1){columns=group.m_ConstraintCount;rows=Math.ceil(n/columns);}
    else if(group.m_Constraint===2){rows=group.m_ConstraintCount;columns=Math.ceil(n/rows);}
    else if(group.m_StartAxis===1){rows=Math.max(1,Math.floor((innerH+spacing.y+.001)/(cell.y+spacing.y)));columns=Math.ceil(n/rows);}
    else {columns=Math.max(1,Math.floor((innerW+spacing.x+.001)/(cell.x+spacing.x)));rows=Math.ceil(n/columns);}
    columns=Math.min(columns,n);rows=Math.min(rows,n);
    const requiredW=columns*cell.x+(columns-1)*spacing.x,requiredH=rows*cell.y+(rows-1)*spacing.y;
    const left=-pt.width*pt.anchorX+padding.m_Left+(innerW-requiredW)*ax,top=pt.height*(1-pt.anchorY)-padding.m_Top-(innerH-requiredH)*ay;
    for(let i=0;i<n;i++){
      let x=group.m_StartAxis===1?Math.floor(i/rows):i%columns,y=group.m_StartAxis===1?i%rows:Math.floor(i/columns);
      if(group.m_StartCorner%2)x=columns-1-x;if(group.m_StartCorner>=2)y=rows-1-y;
      const key=children[i],pivot=this.assets.config.nodes[key].rect.pivot;
      yield* this.ui.layoutSteps(key,cell.x,cell.y);this.ui.node(key).setPosition(left+x*(cell.x+spacing.x)+cell.x*pivot[0],top-y*(cell.y+spacing.y)-cell.y*(1-pivot[1]));
    }
  }
  update(dt:number):void{
    if(this.destroyed)return;dt=Number.isFinite(dt)?Math.max(0,dt):0;this.elapsed+=dt;this.feedback.update(dt);this.syncAccess();
    if(!this.isOpen)return;this.refresh();this.camp?.update(dt);
    for(const motion of Object.values(this.assets.config.tweens)){
      const node=this.ui.get(motion.node);if(!node||!visibleInHierarchy(node))continue;
      if(motion.animationType===3||motion.animationType===4)node.angle=this.assets.config.nodes[motion.node].rect.angle+this.elapsed/motion.duration*motion.endValueV3.z;
      else if(motion.animationType===5){const t=(Math.sin((this.elapsed/motion.duration-.5)*Math.PI)+1)/2,base=this.assets.config.nodes[motion.node].rect.scale,target=motion.endValueFloat?[motion.endValueFloat,motion.endValueFloat]:[motion.endValueV3.x,motion.endValueV3.y];node.setScale(base[0]+(target[0]-base[0])*t,base[1]+(target[1]-base[1])*t,1);}
    }
    for(const [node,m] of Array.from(this.bounces)){m.elapsed+=dt;const t=m.elapsed/m.duration;let scale=t<1?m.scale*(1-(1-t)**3):m.scale+(1-m.scale)*Math.min(1,(t-1)/.6);node.setScale(m.base[0]*scale,m.base[1]*scale,1);if(t>=1.6)this.bounces.delete(node);}
    if(this.rewardSequence){this.rewardSequence.elapsed+=dt;this.paintReward();}
    if(this.drawItems.length&&this.roots.get('relicDraw')!.active){this.drawTime+=dt;this.paintDraw();}
    if(this.camp?.moving||this.feedback.hasActiveMotion||this.bounces.size||this.rewardSequence||this.drawItems.length||Object.keys(this.assets.config.tweens).length)this.colors?.invalidate();
  }
  destroy():void{if(this.destroyed)return;if(this.initialized)this.close();this.releasePreparation();this.ui.destroy();this.node.destroy();}
  private releasePreparation():void{if(this.destroyed)return;this.destroyed=true;this.node.active=false;this.camp?.destroy();this.colors?.destroy();}
  private syncAccess():void{
    if(this.destroyed)return;const access=this.callbacks.getContentState();this.roots.get('entry')!.active=this.entryVisible&&access.visible;
    this.ui.show('level0:1378',!access.unlocked);this.ui.show('level0:528',access.unlocked&&this.callbacks.getState().alert);
    if(!access.unlocked&&this.isOpen)this.close();
  }
  private refresh():void{for(const _ of this.refreshSteps()){/* state changes only */}}
  private *refreshSteps():Generator<void>{
    // This authored banner is another cash-core purchase entrance (target 1380).
    this.ui.show('level0:236',false);
    const state=this.callbacks.getState(),relics=this.callbacks.getRelicState();
    const key=JSON.stringify([state.revision,state.tickets,Math.ceil(state.ticketRemainingMs/1000),state.maps.map(map=>[map.status,Math.ceil(map.remainingMs/1000),map.adAvailable]),relics.revision,this.tab,this.core,this.currentMap,this.currentIndex,this.selected,this.detailIndex]);
    if(key===this.refreshKey)return;this.refreshKey=key;
    this.ui.setText(this.panel.Lv_txt,`Lv.${state.displayLevel}`);this.ui.setText(this.panel.Exp_txt,state.level===state.maxLevel?'MAX':`${state.exp}/${state.requiredExp}`);this.setFill(this.panel.Exp_Fill,state.expRatio);
    this.ui.show(this.panel.Map_Alert_obj,state.mapAlert);this.ui.show(this.panel.Core_Alert_obj,state.coreAlert||!!(state as AdventureSnapshot&{relicAlert?:boolean}).relicAlert);
    this.roles('Currency_Core').forEach(r=>r.Core_txt_list.forEach((k:string,i:number)=>this.ui.setText(k,String(state.cores[i]))));
    this.roles('Adventure_Ticket_UI').forEach(r=>{r.Count_txt.forEach((k:string)=>this.ui.setText(k,`${state.tickets}/${state.ticketMax}`));r.Cooltime_txt.forEach((k:string)=>this.ui.setText(k,state.tickets>=state.ticketMax?'':adventureDuration(state.ticketRemainingMs,true)));});
    this.ui.show('level0:2000',this.tab===0);this.ui.show('level0:47',this.tab===1);
    this.roles('Menu_Btn').forEach(r=>{this.ui.show(r.On_obj,r._num===this.tab);this.ui.show(r.Off_obj,r._num!==this.tab);});
    this.panel.Adventure_Map_list.forEach((key:string,type:number)=>{const r=this.assets.config.roles[key],maps=state.maps.filter(map=>map.type===type);this.ui.show(r.Finished_obj,maps.some(map=>map.status==='finished'));this.ui.show(r.Locked_obj,!maps[0].openToday);});
    this.ui.tint(this.panel.MapInfo_Panel_img,color(this.panel.MapInfo_Panel_Colors[this.currentMap]));
    for(let i=0;i<5;i++){const map=state.maps[this.currentMap*5+i],r=this.assets.config.roles[this.panel.Adventure_Map_Info_list[i]];this.paintMap(r,map);yield;}
    if(this.roots.get('enter')!.active)this.paintEnter(state);
    if(this.roots.get('petSelect')!.active)this.paintChoices(state);
    if(this.roots.get('exit')!.active){const map=state.maps[this.currentMap*5+this.currentIndex];this.paintRewards(this.exit,map.rewardCore,map.rewardExp,this.currentMap);}
    for(let i=0;i<relics.items.length;i++){const item=relics.items[i],r=this.assets.config.roles[this.relicManager.Relic_Item_List[i]];this.paintRelicCard(r,item);yield;}
    this.paintRelicControls(relics);if(this.detailIndex!==null)this.paintRelicDetail(relics.items[this.detailIndex]);
    if(this.isOpen)this.camp?.setGrades(state.availablePets.map(pet=>pet.grade));this.colors?.invalidate();
  }
  private roles(type:string):Role[]{return Object.values(this.assets.config.roles).filter(role=>role.type===type);}
  private paintMap(r:Role,map:AdventureMapSnapshot):void{
    this.ui.show(r.Block_obj,map.status==='locked');this.ui.show(r.Daylock_obj,map.status==='closed');this.ui.show(r.EnterAble_obj,map.status==='available');this.ui.show(r.Entered_obj,map.status==='running');this.ui.show(r.Finish_obj,map.status==='finished');
    r.Map_img_objs.forEach((k:string,type:number)=>this.ui.show(k,type===map.type));this.ui.image(r.Core_img,this.assets.config.coreSprites[map.type]);
    this.ui.setText(r.Stage_txt,`Stage ${map.index+1}`);this.ui.setText(r.Time_txt,`${map.effectiveHours}h`);this.ui.setText(r.Remaining_Duration_txt,adventureDuration(map.remainingMs));this.ui.setText(r.LvLock_txt,this.translate('Adventure/Adventure_LvLimit','达到Lv.{0}解锁').replace('{0}',String(map.unlockLevel)));
    const dispatched=[...map.pets].sort((a,b)=>(a.kind==='owned'?a.index:16+a.index)-(b.kind==='owned'?b.index:16+b.index));
    r.Pet_imgs.forEach((k:string,i:number)=>{this.ui.show(k,!!dispatched[i]);if(dispatched[i])this.ui.image(k,this.assets.config.portraits[dispatched[i].grade]);});
    this.ui.show(r.AD_Btn_obj,map.adAvailable&&!!this.callbacks.getAdState?.().unlocked);this.ui.setText(r.AD_Count_txt,String(this.callbacks.getState().adRemaining));
  }
  private paintPet(r:Role|undefined,grade:number):void{
    if(!r)return;this.ui.show(r.node,grade>=0);
    if(!this.gradeBadges.update(this.ui,r.Degree_objs,grade))r.Degree_objs?.forEach((key:string,id:number)=>this.ui.show(key,id===grade));
    if(grade<0)return;
    this.ui.image(r.Pet_img,this.assets.config.portraits[grade]);this.ui.image(r.Shadow_img,this.assets.config.portraits[grade]);this.ui.tint(r.Panel_img,this.assets.config.degreeColors[grade]);
  }
  private paintEnter(state:AdventureSnapshot):void{
    this.selected=this.selected.filter(pet=>state.availablePets.some(item=>samePet(item,pet)&&item.grade===pet.grade)).slice(0,state.openPetSlots);
    const preview=this.callbacks.preview(this.currentMap,this.currentIndex,this.selected),map=state.maps[this.currentMap*5+this.currentIndex];
    this.enter.Map_img_objs.forEach((key:string,type:number)=>this.ui.show(key,type===this.currentMap));this.ui.setText(this.enter.Stage_txt,`Stage ${this.currentIndex+1}`);this.ui.setText(this.enter.Time_txt,`${map.effectiveHours}h`);
    this.ui.setText(this.enter.Exp_txt,String(preview.rewardExp));this.ui.setText(this.enter.Core_txt,String(preview.rewardCore));this.ui.image(this.enter.RewardCore_img,this.assets.config.coreSprites[this.currentMap]);this.ui.tint(this.enter.RewardCore_Panel_img,color(this.enter.CorePanel_Colors[this.currentMap]));
    this.ui.setText(this.enter.EnterTicket_txt,String(preview.ticketCost));this.ui.tint(this.enter.EnterTicket_txt,color(state.tickets>=preview.ticketCost?this.enter.Color_EnterAble_txt:this.enter.Color_EnterDisable_txt));this.ui.tint(this.enter.Enter_Btn_img,color(preview.canStart?this.enter.Color_EnterAble:this.enter.Color_EnterDisable));
    this.enter.Pet_Slot_list.forEach((key:string,i:number)=>{const r=this.assets.config.roles[key];this.ui.show(r.Locked_obj,i>=state.openPetSlots);this.ui.show(r.Empty_obj,i<state.openPetSlots&&!this.selected[i]);this.ui.show(r.Selected_obj,!!this.selected[i]);this.paintPet(this.assets.config.roles[r.pet_item],this.selected[i]?.grade??-1);});
  }
  private paintChoices(state:AdventureSnapshot):void{
    const pets=this.callbacks.getPetState();
    this.choices=[...pets.selected.map((grade,index)=>({kind:'selected' as const,index,grade})),...pets.owned.map((grade,index)=>({kind:'owned' as const,index,grade}))];
    this.petSelect.Pet_Slot_list.forEach((key:string,i:number)=>{const r=this.assets.config.roles[key],pet=this.choices[i],exists=!!pet&&pet.grade>=0,allowed=exists&&state.availablePets.some(item=>samePet(item,pet))&&!this.selected.some(p=>samePet(p,pet))&&this.selected.length<state.openPetSlots;this.ui.show(r.node,true);this.ui.show(r.SelectAble_obj,allowed);this.ui.show(r.Disable_obj,exists&&!allowed);this.paintPet(this.assets.config.roles[r.pet_item_demo],pet?.grade??-1);});
  }
  private paintRewards(r:Role,core:number,exp:number,type:MapType):void{this.ui.setText(r.Reward_Core_txt,String(core));this.ui.setText(r.Reward_Exp_txt,String(exp));this.ui.image(r.Reward_Core_img,this.assets.config.coreSprites[type]);this.ui.tint(r.RewardCore_Panel_img,color(r.CorePanel_Colors[type]));}
  private paintRelicDemo(r:Role|undefined,item:RelicItemSnapshot):void{
    if(!r)return;r.Relic_Type_objs.forEach((key:string,type:number)=>this.ui.show(key,type===item.type));this.ui.image(r.Core_img,this.assets.config.coreSprites[item.core]);this.ui.image(r.Panel_img,'s'+r.Panel_sprites[item.core].split(':')[1]);
  }
  private paintRelicCard(r:Role,item:RelicItemSnapshot):void{
    this.ui.show(r.Unlock_obj,item.unlocked);this.ui.show(r.Locked_obj,!item.unlocked);this.ui.show(r.Alert_obj,item.canUpgrade);this.paintRelicDemo(this.assets.config.roles[r.relic_item_demo],item);
    this.ui.image(r.LockedPanel_img,'s'+r.Panel_sprites[item.core].split(':')[1]);this.ui.image(r.LockedCore_img,this.assets.config.coreSprites[item.core]);this.ui.setText(r.Lv_txt,`Lv.${item.displayLevel}`);
    this.ui.setText(r.Count_txt,item.level===item.maxLevel?'MAX':`${item.count}/${item.requiredCount}`);this.setFill(r.Fill,item.level===item.maxLevel?1:item.count/item.requiredCount);
  }
  private paintRelicControls(state:RelicSnapshot):void{
    const down=this.relicDown;this.ui.image(down.Core_img,this.assets.config.coreSprites[this.core]);this.ui.setText(down.Count_txt,String(state.cores[this.core]));
    down.DrawMode_Btn_list.forEach((key:string)=>{const r=this.assets.config.roles[key];this.ui.show(r.On_obj,r._type===this.core);this.ui.show(r.Off_obj,r._type!==this.core);});
    down.Core_Alert_objs.forEach((key:string,i:number)=>this.ui.show(key,state.cores[i]>=state.drawPrice));
    const groups=ECONOMY_CONFIG.relics.typesByCore,total=groups.reduce((sum,group)=>sum+group.length,0);
    down.Draw_Percent_txt_list.forEach((key:string,i:number)=>{const percent=this.core===groups.length?100*groups[i].length/total:this.core===i?100:0;this.ui.setText(key,`${Number(percent.toFixed(1))}%`);});
    this.ui.setText(down.MaxDraw_Count_txt,this.translate('Relic/Draw_Count','购买{0}个').replace('{0}',String(state.drawMax[this.core])));this.ui.setText(down.MaxDraw_Price_txt,String(state.drawMax[this.core]*state.drawPrice));
    down.Draw_Relic_Btn_list.forEach((key:string)=>{const r=this.assets.config.roles[key],price=r.is_Max?state.drawMax[this.core]*state.drawPrice:state.drawPrice,able=state.cores[this.core]>=price&&price>0;this.ui.image(r.Core_img,this.assets.config.coreSprites[this.core]);this.ui.setText(r.Price_txt,String(price));this.ui.tint(r.Panel_img,color(able?r.Color_Panel_Able:r.Colo_Paner_Disable));this.ui.tint(r.Price_txt,able?[255,255,255,255]:color(r.Color_Price_Disable));});
  }
  private paintRelicDetail(item:RelicItemSnapshot):void{
    const r=this.relicDetail,suffix=item.type<3?'Dmg':item.type<6?'Money':item.type<9?'CriDmg':item.type===9?'MoveSpeed':item.type===10?'Offline':item.type===11?'Rebirth':'Skip';
    this.paintRelicDemo(this.assets.config.roles[r.relic_item_demo],item);this.ui.setText(r.Name_txt,this.translate('Relic/RelicName_'+suffix,item.name));this.ui.setText(r.Lv_txt,`Lv.${item.displayLevel}`);
    this.ui.setText(r.Count_txt,item.level===item.maxLevel?'MAX':`${item.count}/${item.requiredCount}`);this.setFill(r.Fill,item.level===item.maxLevel?1:item.count/item.requiredCount);
    const value=item.value;
    this.ui.setText(r.Explain_txt,this.translate('Relic/RelicExplain_'+suffix,item.description).replace('{0}',value));this.ui.tint(r.Upgrade_Btn_img,color(item.canUpgrade?r.Color_UpgradeAble:r.Color_UpgradeDisable));
  }
  private translate(key:string,fallback:string):string{return this.assets.config.translations[key]??fallback;}
  private setFill(key:string,amount:number):void{
    const node=this.ui.get(key),size=node?this.fills.get(node):undefined;if(!node||!size)return;
    const ratio=Math.max(0,Math.min(1,amount)),tr=node.getComponent(UITransform)!;tr.setAnchorPoint(0,.5);tr.setContentSize(size.width*ratio,size.height);node.setPosition(size.x-size.width/2,size.y);
    const image=node.children.find(child=>child.name==='OriginalImage');if(image){image.active=ratio>0;image.getComponent(UITransform)!.setAnchorPoint(.5,.5);image.getComponent(UITransform)!.setContentSize(size.width,size.height);image.setPosition(size.width/2,0);}
  }
  private openPopup(name:string):void{this.touches.clear();this.feedback.clear();this.roots.get(name)!.active=true;this.refreshKey='';this.refresh();if(name!=='reward'&&name!=='relicDraw')this.bounceTree(this.assets.config.roots[name]);}
  private openEnter(index:number):void{
    this.currentIndex=index;const state=this.callbacks.getState();this.selected=state.availablePets.map((pet,order)=>({pet,order})).sort((a,b)=>b.pet.grade-a.pet.grade||a.order-b.order).slice(0,state.openPetSlots).map(x=>({...x.pet}));this.openPopup('enter');
  }
  private frontName():string{return ['relicDraw','relicInfo','reward','exit','petSelect','enter','mapList','main','entry'].find(name=>this.roots.get(name)?.active)??'entry';}
  private front(node:Node):boolean{if(this.destroyed||this.adToken)return false;const name=this.frontName();if(name==='entry'&&this.entryBlocked)return false;for(let current:Node|null=node;current;current=current.parent)if(current===this.roots.get(name))return true;return false;}
  private contains(node:Node,p:{x:number;y:number}):boolean{const tr=node.getComponent(UITransform)!,v=tr.convertToNodeSpaceAR(new Vec3(p.x,p.y));return v.x>=-tr.width*tr.anchorX&&v.x<=tr.width*(1-tr.anchorX)&&v.y>=-tr.height*tr.anchorY&&v.y<=tr.height*(1-tr.anchorY);}
  private bindButton(spec:OriginalUiNode):void{
    const node=this.ui.node(spec.id);node.on(Node.EventType.TOUCH_START,(e:EventTouch)=>{e.propagationStopped=true;if(!this.front(node)||this.touches.has(node))return;this.touches.set(node,e.getID()??-1);this.feedback.press(node,spec);});
    const finish=(e:EventTouch,click:boolean):void=>{e.propagationStopped=true;if(this.touches.get(node)!==(e.getID()??-1))return;this.touches.delete(node);this.feedback.release(node);if(!click||!visibleInHierarchy(node)||!this.front(node)||!this.contains(node,e.getUILocation()))return;for(const action of spec.button!)this.invoke(action.method,action.target,!!action.arguments.m_BoolArgument);if(spec.clickSound!==undefined)this.callbacks.playSfx?.(spec.clickSound);this.refreshKey='';this.refresh();};
    node.on(Node.EventType.TOUCH_END,(e:EventTouch)=>finish(e,true));node.on(Node.EventType.TOUCH_CANCEL,(e:EventTouch)=>finish(e,false));
  }
  private invoke(method:string,target:string,active:boolean):void{
    const role=this.assets.config.roles[target];
    if(method==='Content_Btn_Adventure')this.open();
    else if(method==='SetActive'){
      const name=Object.keys(this.assets.config.roots).find(name=>this.assets.config.roots[name]===target);if(!name)return;
      if(name==='main'){if(active)this.open();else this.close();return;}
      if(name==='reward'&&this.rewardSequence&&!this.ui.node(this.reward.Exit_obj).active)return;
      if(name==='relicDraw'&&this.drawTime<this.drawReadyTime())return;
      this.roots.get(name)!.active=active;if(name==='reward')this.rewardSequence=null;if(name==='relicDraw')this.drawItems=[];if(name==='relicInfo')this.detailIndex=null;
    } else if(method==='Map_List_Open'){this.currentMap=role._type;this.openPopup('mapList');}
    else if(method==='Enter_Popup_Open'){const index=this.panel.Adventure_Map_Info_list.indexOf(target);if(index>=0)this.openEnter(index);}
    else if(method==='Adventure_Cancel_onClick'){this.currentIndex=this.panel.Adventure_Map_Info_list.indexOf(target);this.openPopup('exit');}
    else if(method==='Cancel'){if(this.check(this.callbacks.cancel(this.currentMap,this.currentIndex)))this.roots.get('exit')!.active=false;}
    else if(method==='Reward_Get')this.claim(this.panel.Adventure_Map_Info_list.indexOf(target));
    else if(method==='OnClick_AdventureStart'){if(this.check(this.callbacks.start(this.currentMap,this.currentIndex,this.selected))){this.roots.get('enter')!.active=false;this.callbacks.playSfx?.(2);}}
    else if(method==='AD_Reduce_onClick')this.beginAd(this.panel.Adventure_Map_Info_list.indexOf(target));
    else if(method==='OnClick'&&role?.type==='Adventure_Pet_Slot'){
      const index=this.enter.Pet_Slot_list.indexOf(target);if(index>=this.callbacks.getState().openPetSlots)return;if(this.selected[index]){this.selected.splice(index,1);this.callbacks.playSfx?.(13);}else this.openPopup('petSelect');
    } else if(method==='OnClick'&&role?.type==='Adventure_PetSelect_Slot'){
      const pet=this.choices[this.petSelect.Pet_Slot_list.indexOf(target)];if(pet&&pet.grade>=0&&this.callbacks.getState().availablePets.some(item=>samePet(item,pet))&&!this.selected.some(p=>samePet(p,pet))&&this.selected.length<this.callbacks.getState().openPetSlots){this.selected.push({...pet});this.callbacks.playSfx?.(9);this.roots.get('petSelect')!.active=false;}
    } else if(method==='onClick'&&role?.type==='Menu_Btn'){this.tab=role._num;this.scroll?.stopAutoScroll();}
    else if(method==='onClick'&&role?.type==='Relic_DrawMode_Btn')this.core=role._type;
    else if(method==='onClick'&&role?.type==='Draw_Relic_Btn')this.draw(!!role.is_Max);
    else if(method==='onClick'&&(role?.type==='Relic_Item'||role?.type==='Relic_Item_Demo')){const index=this.relicManager.Relic_Item_List.findIndex((key:string)=>key===target||this.assets.config.roles[key].relic_item_demo===target);if(index>=0&&this.callbacks.getRelicState().items[index]?.unlocked){this.detailIndex=index;this.openPopup('relicInfo');}}
    else if(method==='Relic_Upgrade'&&this.detailIndex!==null){if(this.check(this.callbacks.upgradeRelic(this.detailIndex))){this.callbacks.playSfx?.(4);this.bounceTree(this.assets.config.roots.relicInfo);}else this.callbacks.playSfx?.(5);}
    else if(method==='OnClick_Left'&&this.drawTime>=this.drawReadyTime()&&this.drawPage>0){this.drawPage--;this.drawTime=Infinity;this.paintDraw();}
    else if(method==='OnClick_Right'&&this.drawTime>=this.drawReadyTime()&&this.drawPage<Math.ceil(this.drawItems.length/12)-1){this.drawPage++;this.drawTime=Infinity;this.paintDraw();}
  }
  private check(result:{ok:boolean;reason?:string}):boolean{
    if(!result.ok){const messages:Record<string,string>={currency:'核心不足。',tickets:'旅行券不足。',locked:'尚未解锁。',closed:'今天不可入场。',empty:'请选择派去旅行的宠物。',slots:'派遣宠物数量超过已解锁栏位。',petUnavailable:'宠物已变化或正在旅行中。',busy:'请稍后再试。',saveFailed:'保存失败，本次操作未生效。',stale:'状态已变化，请重试。',notFinished:'旅行尚未完成。',count:'能力数量不足。',maxLevel:'已达到最高等级。'};if(result.reason!=='cancelled')this.callbacks.alert?.(messages[result.reason??'']??'当前无法进行此操作。');}
    this.refreshKey='';return result.ok;
  }
  private claim(index:number):void{
    const result=this.callbacks.claim(this.currentMap,index);if(!this.check(result))return;
    let level=result.beforeLevel??0,exp=result.beforeExp??0,gain=result.expGain??0;const max=this.callbacks.getState().maxLevel,levels:RewardSequence['levels']=[];
    while(level<max&&gain>0){const need=adventureRequiredExp(level),to=Math.min(need,exp+gain);levels.push({level,from:exp,to,need,duration:this.reward.SliderFillDuration*Math.max((to-exp)/need,Math.fround(.01))});gain-=to-exp;if(to===need){level++;exp=0;}else break;}
    if(!levels.length&&level<max)levels.push({level,from:exp,to:exp,need:level===max?1:adventureRequiredExp(level),duration:this.reward.SliderFillDuration*Math.fround(.01)});
    [this.reward.ExpSlider_obj,this.reward.Endtxt_obj,this.reward.Exp_obj,this.reward.Core_obj,this.reward.Exit_obj].forEach(key=>this.ui.show(key,false));
    this.rewardSequence={elapsed:0,playedLevelUps:0,type:this.currentMap,core:result.coreGain??0,exp:result.expGain??0,levels};this.openPopup('reward');this.paintReward();
  }
  private paintReward():void{
    const seq=this.rewardSequence;if(!seq)return;const r=this.reward,gap=r.ElementGap,fillStart=.25+gap*4,fillEnd=fillStart+seq.levels.reduce((total,item)=>total+item.duration,0);
    // Native BounceIn changes only Y, using the two SmoothStep segments.
    const smooth=(t:number)=>{t=Math.min(1,Math.max(0,t));return t*t*(3-2*t);};
    const y=seq.elapsed<.15?1.1*smooth(seq.elapsed/.15):1.1-.1*smooth((seq.elapsed-.15)/.1);this.roots.get('reward')!.setScale(1,y,1);
    const nodes=[r.ExpSlider_obj,r.Endtxt_obj,r.Exp_obj,r.Core_obj];nodes.forEach((key:string,i:number)=>this.reveal(key,seq.elapsed>=.25+i*gap));this.reveal(r.Exit_obj,seq.elapsed>=fillEnd+r.ExitDelay);this.paintRewards(r,seq.core,seq.exp,seq.type);
    if(!seq.levels.length){this.ui.setText(r.Slider_Lv_txt,`Lv.${this.callbacks.getState().maxLevel+1}`);this.ui.setText(r.Slider_Exp_txt,'MAX');this.setFill(r.ExpSlider_Fill,1);return;}
    let remaining=Math.max(0,seq.elapsed-fillStart),index=0,completed=0;
    for(let i=0;i<seq.levels.length;i++){const item=seq.levels[i];if(remaining<item.duration){index=i;break;}if(item.to>=item.need)completed++;if(i===seq.levels.length-1){index=i;break;}remaining-=item.duration;index=i+1;}
    while(seq.playedLevelUps<completed){seq.playedLevelUps++;this.callbacks.playSfx?.(11);}
    const segment=seq.levels[index],t=Math.min(1,remaining/segment.duration);
    const exp=Math.round(segment.from+(segment.to-segment.from)*t),max=this.callbacks.getState().maxLevel;
    let level=segment.level;if(exp>=segment.need&&t===1&&index===seq.levels.length-1)level++;
    const full=level>=max;this.ui.setText(r.Slider_Lv_txt,`Lv.${Math.min(max,level)+1}`);this.ui.setText(r.Slider_Exp_txt,full?'MAX':`${level!==segment.level?0:exp}/${adventureRequiredExp(Math.min(max,level))}`);this.setFill(r.ExpSlider_Fill,full?1:level!==segment.level?0:exp/segment.need);
  }
  private draw(max:boolean):void{
    const result=this.callbacks.drawRelic(this.core,max);if(!this.check(result)||!result.drawn?.length)return;this.drawItems=result.drawn;this.drawPage=0;this.drawTime=0;this.ui.show(this.relicDraw.Relic_Item_obj,false);this.relicDraw.Relic_Item_obj_List.forEach((key:string)=>this.ui.show(key,false));this.openPopup('relicDraw');this.paintDraw();this.callbacks.playSfx?.(2);
  }
  private drawReadyTime():number{return this.drawItems.length===1?this.relicDraw.Single_CloseDelay:this.drawItems.length*this.relicDraw.Multi_Interval+Math.max(0,Math.ceil(this.drawItems.length/12)-1)*this.relicDraw.Page_Delay;}
  private paintDraw():void{
    const r=this.relicDraw,single=this.drawItems.length===1,state=this.callbacks.getRelicState(),ready=this.drawTime>=this.drawReadyTime();
    const previousPage=this.drawPage;
    if(!single&&this.drawTime!==Infinity)this.drawPage=Math.min(Math.ceil(this.drawItems.length/12)-1,Math.floor(this.drawTime/(12*r.Multi_Interval+r.Page_Delay)));
    if(previousPage!==this.drawPage)r.Relic_Item_obj_List.forEach((key:string)=>this.ui.show(key,false));
    const pageTime=this.drawTime-this.drawPage*(12*r.Multi_Interval+r.Page_Delay);
    this.reveal(r.Relic_Item_obj,single);
    if(single)this.paintRelicDemo(this.assets.config.roles[r.Relic_Item_Single],state.items[this.drawItems[0].index]);
    r.Relic_Item_obj_List.forEach((key:string,i:number)=>{const item=this.drawItems[this.drawPage*12+i],visible=!single&&!!item&&pageTime>=i*r.Multi_Interval;const changed=this.ui.node(key).active!==visible;this.reveal(key,visible);if(changed&&visible&&this.drawTime!==Infinity)this.callbacks.playSfx?.(14);if(visible)this.paintRelicDemo(this.assets.config.roles[r.Relic_Item_List[i]],state.items[item.index]);});
    const layoutKey=r.Relic_Item_obj_List.map((key:string)=>this.ui.node(key).active?'1':'0').join('');
    if(layoutKey!==this.drawLayoutKey){this.drawLayoutKey=layoutKey;for(const _ of this.layoutSourceGroup(this.assets.config.nodes['level0:719'],true)){/* Unity reflows visible draw cells. */}}
    this.ui.show(r.Close_Btn,ready);this.ui.show(r.Left_Btn,ready&&this.drawPage>0);this.ui.show(r.Right_Btn,ready&&this.drawPage<Math.ceil(this.drawItems.length/12)-1);
  }
  private reveal(key:string,visible:boolean):void{const node=this.ui.get(key);if(!node)return;const changed=node.active!==visible;node.active=visible;if(changed&&visible){const spec=Object.values(this.assets.config.nodes).find(spec=>this.ui.get(spec.id)===node);if(spec)this.bounceTree(spec.id);}}
  private bounceTree(key:string):void{
    const spec=this.assets.config.nodes[key],bounce=(spec as any).bounceStart;if(bounce){const node=this.ui.node(key);this.bounces.set(node,{elapsed:0,duration:bounce.duration,scale:bounce.scale,base:[...spec.rect.scale]});node.setScale(0,0,1);}
    spec.children.forEach(child=>this.bounceTree(child));
  }
  private beginAd(index:number):void{
    if(!this.callbacks.getAdState?.().unlocked||!this.callbacks.beginAd||!this.callbacks.completeAd||this.adToken)return;
    const result=this.callbacks.beginAd(this.currentMap,index);if(!this.check(result)||!result.token)return;const token=result.token;this.adToken=token;
    const complete=(outcome:RewardedAdOutcome):void=>{if(this.destroyed||this.adToken!==token)return;this.adToken=null;const result=this.callbacks.completeAd!(token,outcome);if(outcome==='failure')this.callbacks.alert?.('广告加载失败，请重试。');else if(outcome!=='cancel')this.check(result);this.refreshKey='';this.refresh();};
    if(this.rewardedAds)this.rewardedAds.showRewardedAd(token,'adventure-reduce',complete);else complete('failure');
  }
}
