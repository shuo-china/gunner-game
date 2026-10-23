const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const root=path.resolve(__dirname, '..');
const {resolveContentConfig}=require('./.build/session/session/ContentConfig.js');
const {BattleSession}=require('./.build/session/session/BattleSession.js');
const {DecimalAmount}=require('./.build/session/core/DecimalAmount.js');
const catalog=require('./.build/session/core/WeaponCatalog.js');
const config=require(path.join(root,'assets/resources/art/weapon-system/config.json'));
// Use the real pure image fitting helper; only Cocos rendering is stubbed below.
const uiSource=fs.readFileSync(path.join(root,'assets/scripts/view/OriginalWeaponUi.ts'),'utf8');
const fitModule={exports:{}};
vm.runInNewContext(ts.transpileModule(uiSource.slice(uiSource.indexOf('export type Pair'),uiSource.indexOf('export interface OriginalUiNode')) + uiSource.slice(uiSource.indexOf('export type UiLayout'),uiSource.indexOf('export async function loadWeaponHudAssets')),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
  {module:fitModule,exports:fitModule.exports});

test('weapon UI price, probability, daily grade and actual draw share the edited economy config',()=>{
  const load=require('./support/economy-modules.cjs').economyModules(c=>{
    c.weapons.drawPrice=60;c.weapons.drawGradePercents=[20,80,0,0];c.weapons.dailyAd.grade=3;
  });
  const {hud,session}=harness('production',{},load);
  session.weapons.grantDiamonds(59);hud.refresh();
  assert.equal(hud.ui.texts.get('level0:117256'),'<sprite=1>60');
  assert.deepEqual(Array.from(hud.ui.tints.get('level0:117256')),[255,109,109,255]);
  assert.equal(session.weapons.draw().reason,'notEnoughDiamonds');
  session.weapons.grantDiamonds(1);hud.refresh();
  assert.deepEqual(Array.from(hud.ui.tints.get('level0:117256')),[255,255,255,255]);
  assert.equal(session.weapons.draw().ok,true);assert.equal(session.weapons.diamonds,0);
  assert.equal(hud.ui.texts.get('level0:9885'),'20%');assert.equal(hud.ui.texts.get('level0:9830'),'80%');
  assert.equal(hud.ui.texts.get('level0:1747'),'A');
});

// These stubs model Cocos component ownership and event delivery. The real
// WeaponHud constructor, handlers, update and domain commands are exercised;
// layout/rendering itself is verified by the separate browser acceptance run.
function harness(environment='test',overrides={},load=file=>require(`./.build/session/${file}.js`),options={}){
  const {BattleSession}=load('session/BattleSession'),{resolveContentConfig}=load('session/ContentConfig');
  const activeCatalog=load('core/WeaponCatalog');
  class Vec2{constructor(x=0,y=0){Object.assign(this,{x,y});}static distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}}
  class Vec3 extends Vec2{constructor(x=0,y=0,z=0){super(x,y);this.z=z;}clone(){return new Vec3(this.x,this.y,this.z);}}
  class UITransform{
    width=100;height=100;
    setContentSize(width,height){Object.assign(this,{width,height});}
    setAnchorPoint(){}
    getBoundingBoxToWorld(){const p=this.node.worldPosition;return{contains:v=>Math.abs(v.x-p.x)<=this.width/2&&Math.abs(v.y-p.y)<=this.height/2};}
  }
  class Node{
    static EventType={TOUCH_START:'start',TOUCH_END:'end',TOUCH_CANCEL:'cancel',TOUCH_MOVE:'move'};
    constructor(name=''){this.name=name;this.children=[];this.components=new Map();this.events=new Map();this.active=true;this.isValid=true;this.worldPosition=new Vec3();}
    addChild(node){this.children.push(node);node.parent=this;}
    addComponent(Type){const component=new Type();component.node=this;this.components.set(Type,component);return component;}
    getComponent(Type){return this.components.get(Type);}
    getComponentInChildren(Type){return this.getComponent(Type)||this.children.map(n=>n.getComponentInChildren(Type)).find(Boolean);}
    on(event,fn,target){const list=this.events.get(event)||[];list.push({fn,target});this.events.set(event,list);}
    off(event,fn,target){this.events.set(event,(this.events.get(event)||[]).filter(listener=>listener.fn!==fn||listener.target!==target));}
    emit(event,value){for(const {fn,target} of this.events.get(event)||[])fn.call(target,value);}
    setPosition(x,y,z=0){this.setWorldPosition(x,y,z);}
    get position(){return this.worldPosition;}
    setWorldPosition(x,y,z=0){this.worldPosition=typeof x==='object'?new Vec3(x.x,x.y,x.z):new Vec3(x,y,z);}
    setScale(x,y,z){this.scale={x,y,z};}
    setSiblingIndex(index){const siblings=this.parent?.children;if(!siblings)return;const from=siblings.indexOf(this);siblings.splice(from,1);siblings.splice(Math.min(index,siblings.length),0,this);}
    destroy(){this.isValid=false;this.active=false;this.children.forEach(node=>node.destroy());}
  }
  class Label{static HorizontalAlign={CENTER:0};static VerticalAlign={CENTER:0};static Overflow={SHRINK:0};string='';}
  class LabelOutline{}
  class Color{static WHITE=new Color(255,255,255,255);constructor(r,g,b,a){Object.assign(this,{r,g,b,a});}}
  class Sprite{static SizeMode={CUSTOM:0};static Type={SLICED:1};}
  class Graphics{clear(){}rect(){}roundRect(){}fill(){}}
  class BlockInputEvents{}
  class UIOpacity{opacity=255;}
  class ScrollView{stopAutoScroll(){this.stopped=true;}}
  class AudioSource{playOneShot(){}}
  const makeNode=(name,parent)=>{const node=new Node(name);node.addComponent(UITransform);if(parent)parent.addChild(node);return node;};
  const instantiate=node=>makeNode(node.name+' clone');
  class OriginalWeaponUi{
    constructor(){this.nodes=new Map();this.texts=new Map();this.tints=new Map();}
    create(key,parent){const work=this.createSteps(key,parent);for(;;){const step=work.next();if(step.done)return step.value;}}
    *createSteps(key,parent,active,include=()=>true){const spec=config.nodes[key],node=makeNode(spec.name,parent);node.active=active??spec.active;
      node.setPosition(...spec.rect.position);node.setScale(...spec.rect.scale,1);this.nodes.set(key,node);this.nodes.set(spec.transform,node);spec.components.forEach(id=>this.nodes.set(id,node));
      yield;for(const child of spec.children)if(include(child))yield* this.createSteps(child,node,undefined,include);return node;}
    *layoutSteps(key,width,height){this.layout(key,width,height);}
    prepare(owner,parent,steps,schedule){if(schedule)return schedule(steps);for(const _ of steps){}return Promise.resolve();}
    node(key){assert.ok(this.nodes.has(key),key);return this.nodes.get(key);}
    get(key){return this.nodes.get(key);}
    show(key,value){const node=this.nodes.get(key);if(node)node.active=value;}
    setText(key,value){if(key)this.texts.set(key,value);}
    tint(key,value){if(key)this.tints.set(key,value);}
    image(){}
    destroy(){this.destroyCalls=(this.destroyCalls||0)+1;}
    layout(key,width,height){this.node(key).getComponent(UITransform).setContentSize(width,height);
      if(key===config.roots.collection){this.node('level0:104542').getComponent(UITransform).setContentSize(1083,1292);this.node('level0:103947').getComponent(UITransform).setContentSize(1083,3160);}}
    rebindTree(target,source,overrides=new Map()){
      const a=config.nodes[target],b=config.nodes[source],node=this.node(target);node.active=b.active;node.angle=b.rect.angle;node.setScale(...b.rect.scale,1);node.setPosition(...b.rect.position);
      if(b.text){this.setText(target,b.text.value);this.tint(target,b.text.color);}
      a.children.forEach((key,i)=>{if(this.get(key))this.rebindTree(key,overrides.get(key)||b.children[i],overrides);});
    }
  }
  const input=new Node('GlobalInput'),Input={EventType:Node.EventType};
  const cc={AudioSource,BlockInputEvents,Color,Graphics,input,Input,instantiate,Label,LabelOutline,Node,ScrollView,Sprite,UITransform,UIOpacity,Vec2,Vec3};
  const feedback={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'assets/scripts/view/OriginalWeaponFeedback.ts'),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
    {module:feedback,exports:feedback.exports,require:key=>{assert.equal(key,'cc');return cc;}});
  const module={exports:{}};
  const imports={cc,'../core/DecimalAmount':{DecimalAmount},'../core/WeaponCatalog':activeCatalog,
    '../core/EconomyConfig':load('core/EconomyConfig'),
    '../session/ContentConfig':load('session/ContentConfig'),
    '../session/WeaponInventory':require('./.build/session/session/WeaponInventory.js'),
    './OriginalWeaponFeedback':feedback.exports,
    './OriginalWeaponScroll':{OriginalWeaponScroll:class extends ScrollView{configure(source){this.source=source;}}},
    './ArtLibrary':{makeNode},'./OriginalWeaponUi':{OriginalWeaponUi,OriginalGradeBadgePool:fitModule.exports.OriginalGradeBadgePool,loadWeaponCollectionAssets:options.loadCollection||async function(){},weaponCollectionWindow:fitModule.exports.weaponCollectionWindow,initialUiLayout:fitModule.exports.initialUiLayout,uiPreparationPhase:fitModule.exports.uiPreparationPhase,fitUiImage:fitModule.exports.fitUiImage,applyWeaponUiDisplay:fitModule.exports.applyWeaponUiDisplay,sourceColor:v=>new Color(...v)},
    './OriginalWeaponConfetti':{OriginalWeaponConfetti:class{play(){this.playCount=(this.playCount||0)+1;}update(){}clear(){this.clearCount=(this.clearCount||0)+1;}destroy(){}}}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'assets/scripts/view/WeaponHud.ts'),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
    {module,exports:module.exports,require:key=>{assert.ok(key in imports,`missing ${key}`);return imports[key];}});
  const session=new BattleSession({environment,contentConfig:resolveContentConfig(environment,{adsEnabled:true,tutorialEnabled:false,firstDrawDiamonds:0,thresholds:{challengePowerLevel:0},...overrides}),now:()=>1700000000000,rng:()=>0});
  const art={frames:new Map(),weaponVisuals:{clips:new Map()}},assets={config,chineseFont:{},originalFont:{}};
  const alerts={calls:[],show(text){this.calls.push({text});},showLocalized(key){this.calls.push({key});}};
  const sounds=[];
  const modalModule={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'assets/scripts/view/RewardedAdModal.ts'),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
    {module:modalModule,exports:modalModule.exports,require:key=>imports[key]});
  const canvas=makeNode('Canvas');let request=null;
  const modal=new modalModule.exports.RewardedAdModal(canvas,(id,outcome)=>{
    if(!request||request.token!==id)return;const current=request;request=null;current.complete(outcome);
  });
  const presenter={showRewardedAd(token,placement,complete){request={token,placement,complete};modal.open(token);},
    cancelRewardedAd(token){if(request?.token===token){request=null;modal.dismiss();}}};
  const hud=new module.exports.WeaponHud(canvas,art,assets,session,alerts,undefined,{play:id=>sounds.push(id)},presenter,options.prepare,options.collection);
  // Cocos 3.8.8 changes event.type to node TOUCH_CANCEL on an outside release,
  // but EventTouch.getEventCode() retains the original platform TOUCH_END.
  const event=(pointer=1,x=0,y=0,eventCode=Input.EventType.TOUCH_END,type=eventCode)=>
    ({getID:()=>pointer,getUILocation:()=>new Vec2(x,y),getEventCode:()=>eventCode,type,propagationStopped:false});
  const press=(id,pointer=1)=>{const node=hud.ui.node(id),p=node.worldPosition;node.emit(Node.EventType.TOUCH_START,event(pointer,p.x,p.y,Input.EventType.TOUCH_START));};
  const release=(id,pointer=1)=>{const node=hud.ui.node(id),p=node.worldPosition;node.emit(Node.EventType.TOUCH_END,event(pointer,p.x,p.y));};
  const cancel=(id,pointer=1)=>hud.ui.node(id).emit(Node.EventType.TOUCH_CANCEL,event(pointer,0,0,Input.EventType.TOUCH_CANCEL));
  const synchronize=()=>{session.weapons.drainNotifications();hud.refresh();};
  return{hud,modal,presenter,session,cc,event,press,release,cancel,synchronize,alerts,sounds};
}

test('reused inventory, detail and notice artwork apply fixed sizes and staff angles before fitting without scaling the card',()=>{
  const {hud}=harness(),before=JSON.stringify(config),calls=[];
  hud.ui.image=(key)=>{const node=hud.ui.node(key);calls.push({key,angle:node.angle,scale:{...node.scale}});};
  for(const role of [...hud.slots,...hud.backpack,hud.detail,hud.newGun]){
    const card=hud.ui.node(role.node),cardScale={...card.scale},cardPosition={...card.worldPosition};
    for(const weaponId of [8,58,0,55,18,1,8]){
      const display=config.inventoryWeaponDisplays[role.type][weaponId];calls.length=0;
      hud.updateRole(role,{weaponId,locked:false,pendingAd:false});
      const gun=hud.ui.node(role.Gun_img),shadow=hud.ui.node(role.Shadow_img);
      assert.equal(shadow.angle,display.angle);assert.equal(shadow.scale.x,display.scale);
      assert.equal(gun.angle,display.foregroundPosition?0:display.angle);
      assert.equal(gun.scale.x,display.foregroundPosition?1:display.scale);
      assert.deepEqual(card.scale,cardScale);assert.deepEqual({...card.worldPosition},cardPosition);
      assert.equal(calls[0].angle,gun.angle,'angle is applied before the foreground is fitted');
      assert.equal(calls[1].scale.x,display.scale,'shadow uses the new scale on first fitting');
      hud.updateRole(role,null);assert.equal(gun.active,false);assert.equal(shadow.active,false);
    }
  }
  assert.equal(JSON.stringify(config),before,'runtime changes do not mutate the shared source configuration');
});

test('equipment cards display physical slot stars while compact combat actors preserve the source empty-slot mapping',()=>{
  const {hud,modal,session,synchronize}=harness(),w=session.weapons;
  w.configureTest({stageValueMax:390,starLevels:[1,2,3]});w.grantTestWeapon(0);w.equip(0,2);synchronize();
  assert.equal(hud.ui.texts.get(hud.slots[0].Damage_txt),'150');
  assert.equal(hud.ui.texts.get(hud.slots[1].Damage_txt),'');
  assert.equal(hud.ui.texts.get(hud.slots[2].Damage_txt),'410');
  assert.equal(session.combatLoadout.length,2);assert.equal(session.combatLoadout[1].damage.toString(),'240');
  hud.openDetail(0,{kind:'equipment',index:2});assert.equal(hud.ui.texts.get(hud.detail.Damage_txt),'100','source detail remains the gun base damage');
  hud.starIndex=2;hud.roots.get('star').active=true;hud.refreshStar(w.snapshot());
  assert.equal(hud.ui.texts.get(hud.star.DamageValue_txt_Now),'410');
  hud.starIndex=1;hud.refreshStar(w.snapshot());assert.equal(hud.ui.node(hud.star.Damage_Value_obj).active,false,'empty slots can open their persistent star panel');
});

test('collection cards and detail clicks use explicit GunNum after card ordering changes',()=>{
  const {hud,session,synchronize}=harness(),role=hud.collection.at(-1),previous=role.GunNum;
  const target=Object.keys(config.roles).find(key=>config.roles[key]===role);
  try{
    role.GunNum=58;hud.collection=[role,...hud.collection.slice(0,-1)];
    hud.openCollection();hud.refresh();const pooled=hud.collectionPool[0];assert.equal(hud.collectionUi.texts.get(pooled.role.Type_txt),'火炮');assert.equal(hud.collectionUi.node(pooled.role.Locked_obj).active,true);
    session.weapons.grantTestWeapon(58);synchronize();assert.equal(hud.collectionUi.node(pooled.role.Locked_obj).active,false);
    hud.invoke(pooled.target,'Touch',{});assert.equal(hud.detailId,58);
    assert.equal(hud.ui.node(hud.detail.Name_txt).active,false,'equipment details omit weapon names');
  }finally{role.GunNum=previous;}
});

test('star preview, upgraded card and battle agree at truncation and zero-star boundaries',()=>{
  const {hud,session,synchronize}=harness(),w=session.weapons;
  for(const [weaponId,level,current,next] of [[1,7,'5.6a','12.8a'],[3,8,'38.6a','103a'],[0,9,'43.1a','120a'],[57,0,'2c','3c']]){
    w.grantTestWeapon(weaponId);
    const index=w.snapshot().backpack.findIndex(item=>item?.weaponId===weaponId);
    w.equip(index,0);w.configureTest({starLevels:[level,0,0]});synchronize();
    hud.starIndex=0;hud.roots.get('star').active=true;hud.refreshStar(w.snapshot());
    assert.equal(hud.ui.texts.get(hud.slots[0].Damage_txt),current);
    assert.equal(hud.ui.texts.get(hud.star.DamageValue_txt_Now),current);
    assert.equal(hud.ui.texts.get(hud.star.DamageValue_txt_After),next);
    hud.invoke('', 'onClick_Upgrade', {});
    assert.equal(w.snapshot().stars[0].level,level+1);
    assert.equal(hud.ui.texts.get(hud.slots[0].Damage_txt),next);
    assert.equal(hud.ui.texts.get(hud.star.DamageValue_txt_Now),next);
    assert.equal(session.combatLoadout[0].damage.format(),next);
  }
});

test('Raid opens the shared star popup alone, previews the chosen weapon and restores the ordinary preview on close',()=>{
  const {hud,session,synchronize}=harness();
  session.weapons.configureTest({starLevels:[0,0,0]});synchronize();
  hud.openStarUpgrade(2,level=>`Raid ${level}`);
  assert.equal(hud.roots.get('inventory').active,false);
  assert.equal(hud.roots.get('star').active,true);
  assert.equal(hud.ui.texts.get(hud.star.DamageValue_txt_Now),'Raid 0');
  assert.equal(hud.ui.texts.get(hud.star.DamageValue_txt_After),'Raid 1');
  hud.invoke('', 'onClick_Upgrade', {});
  assert.equal(session.weapons.snapshot().stars[2].level,1);
  assert.equal(hud.ui.texts.get(hud.star.DamageValue_txt_Now),'Raid 1');
  hud.close();
  assert.equal(hud.starPreview,null);
  hud.openStarUpgrade(0);
  assert.equal(hud.ui.texts.get(hud.star.DamageValue_txt_Now),'100','ordinary equipment preview is restored');
});

test('weapon entry refreshes when shared progress unlocks without an inventory revision',()=>{
  const h=harness('production',{thresholds:{challengePowerLevel:3}}),{hud,session,alerts}=h,w=session.weapons;
  assert.equal(hud.roots.get('entry').active,false);
  hud.open();assert.equal(hud.roots.get('inventory').active,false);
  assert.ok(alerts.calls[0].text.includes('Lv.3'));
  const revision=w.revision;
  const get=w.content.get.bind(w.content);
  w.content.get=(id,extra)=>get(id,{...extra,weaponsUnlocked:true});
  hud.update(0);
  assert.equal(w.revision,revision);
  assert.equal(hud.roots.get('entry').active,true);
  hud.open();assert.equal(hud.roots.get('inventory').active,true);
});

test('covering the weapon entry preserves its source unlock visibility across refreshes',()=>{
  const {hud,session,press,release}=harness('production',{thresholds:{challengePowerLevel:3}}),w=session.weapons;
  hud.setEntryBlocked(true);assert.equal(hud.roots.get('entry').active,false,'blocking does not bypass unlock');
  const get=w.content.get.bind(w.content);w.content.get=(id,extra)=>get(id,{...extra,weaponsUnlocked:true});
  hud.update(0);hud.refresh();hud.resize(540,1100,20,30);
  assert.equal(hud.roots.get('entry').active,true,'an unlocked entry remains drawn under the modal');
  press('level0:624');release('level0:624');assert.equal(hud.isOpen,false,'refresh does not remove the input block');
  hud.setEntryBlocked(false);assert.equal(hud.roots.get('entry').active,true);
});

test('covering the weapon entry cancels held input and rejects new presses without blocking popup controls',()=>{
  const {hud,press,release,sounds}=harness(),id='level0:624',node=hud.ui.node(id);
  press(id,7);hud.update(.05);assert.equal(hud.buttonTouches.has(node),true);
  hud.setEntryBlocked(true);
  assert.equal(node.active,true);assert.equal(hud.buttonTouches.has(node),false);assert.equal(node.scale.x,1);
  press(id,9);release(id,9);assert.equal(hud.isOpen,false);assert.equal(hud.buttonTouches.has(node),false);
  hud.setEntryBlocked(false);release(id,7);
  assert.equal(hud.isOpen,false);assert.deepEqual(sounds,[],'a stale release cannot click through the closed overlay');
  press(id,8);release(id,8);assert.equal(hud.isOpen,true,'a fresh press remains usable');
  hud.setEntryBlocked(true);const starButton=hud.slots[0].StarUpgrade_obj;
  press(starButton,10);release(starButton,10);assert.equal(hud.roots.get('star').active,true,'popup controls remain usable');
});

test('Auto is immediately visible in test and toggles without opening an advertisement',()=>{
  const {hud,modal,session}=harness('test',{adsEnabled:false}),w=session.weapons;
  assert.equal(w.snapshot().firstMerge,false);
  hud.open();assert.equal(hud.ui.node('level0:17341').active,true);
  assert.equal(hud.ui.node('level0:1491').active,false);
  hud.invoke('', 'AutoMerge_Change', {});
  assert.equal(w.snapshot().auto.enabled,true);assert.equal(modal.isOpen,false);
  assert.equal(w.snapshot().pendingAd,null);
  hud.invoke('', 'AutoMerge_Change', {});
  assert.equal(w.snapshot().auto.enabled,false);
});

test('tutorial targets use the real entry, buy button and second equipment slot, yielding to overlays and dragging',()=>{
  const {hud,session,synchronize}=harness(),w=session.weapons;
  session.getTutorialState=()=>({active:true,step:'gunEquip',drawCount:2});
  let targets=hud.getTutorialTargets();
  assert.equal(targets.entry,hud.ui.node('level0:624'));assert.equal(targets.buy,hud.ui.node('level0:802'));
  assert.equal(targets.from,null);assert.equal(targets.to,null);assert.equal(targets.blocked,false);
  w.grantTestWeapon(8);w.grantTestWeapon(3);
  w.state.backpack[0]={weaponId:8,locked:false,pendingAd:true};w.state.adGunExpiresAt=w.now+1800000;
  w.toggleLock({kind:'backpack',index:1});synchronize();hud.open();
  targets=hud.getTutorialTargets();
  assert.equal(targets.from,hud.ui.node(hud.backpack[1].node),'ad placeholders are excluded, protected weapons can still equip');
  assert.equal(targets.to,hud.ui.node(hud.slots[1].node));assert.equal(targets.blocked,false);
  for(const overlay of ['detail','collection','probability','star','newGun']){
    hud.roots.get(overlay).active=true;assert.equal(hud.getTutorialTargets().blocked,true,overlay);hud.roots.get(overlay).active=false;
  }
  hud.adToken='tutorial-ad';assert.equal(hud.getTutorialTargets().blocked,true);hud.adToken=null;
  hud.drag={moved:true};assert.equal(hud.getTutorialTargets().blocked,true);hud.drag=null;
  hud.close();assert.equal(hud.getTutorialTargets().from,null);assert.equal(hud.getTutorialTargets().to,null);
});

test('merge teaching selects two usable D cards, while equipment teaching only selects the C crossbow',()=>{
  const {hud,session,synchronize}=harness(),w=session.weapons;
  let tutorial={active:true,step:'gunMerge',drawCount:2};session.getTutorialState=()=>tutorial;
  [0,1,2,0,1,3].forEach(id=>w.grantTestWeapon(id));
  w.state.backpack[0].locked=true;w.state.backpack[1].pendingAd=true;w.state.adGunExpiresAt=w.now+1800000;
  synchronize();hud.open();
  let targets=hud.getTutorialTargets();
  assert.equal(targets.from,hud.ui.node(hud.backpack[3].node));
  assert.equal(targets.to,hud.ui.node(hud.backpack[4].node),'a locked card, ad placeholder and C card cannot become merge targets');
  w.state.backpack[4].locked=true;targets=hud.getTutorialTargets();
  assert.equal(targets.from,null);assert.equal(targets.to,null,'a lone legal source is not an actionable merge gesture');
  tutorial={active:true,step:'gunEquip',drawCount:2};targets=hud.getTutorialTargets();
  assert.equal(targets.from,hud.ui.node(hud.backpack[5].node),'other C weapons cannot replace the taught crossbow');
  assert.equal(targets.to,hud.ui.node(hud.slots[1].node));
  w.state.backpack[5].pendingAd=true;targets=hud.getTutorialTargets();
  assert.equal(targets.from,null);assert.equal(targets.to,null,'an unclaimed crossbow cannot be equipped');
  w.state.backpack[5].pendingAd=false;hud.close();
  assert.equal(hud.getTutorialTargets().from,null);assert.equal(hud.getTutorialTargets().to,null);
  hud.open();assert.equal(hud.getTutorialTargets().from,hud.ui.node(hud.backpack[5].node));
});

test('the weapon entry teaches two draws, a fixed C crossbow merge and equipment across reopening',()=>{
  const {hud,session,press,release,alerts}=harness('production',{tutorialEnabled:true,firstDrawDiamonds:200,
    thresholds:{challengePowerLevel:3}});
  session.gold=require('./.build/session/core/OriginalInfVal.js').OriginalInfVal.fromAmount(DecimalAmount.from(1000),4);
  for(let level=0;level<3;level++)assert.equal(session.purchase('power'),true);hud.update(0);
  assert.equal(session.getTutorialState().step,'gunOpen');assert.equal(session.weapons.diamonds,0);
  press('level0:624');release('level0:624');
  assert.equal(hud.roots.get('inventory').active,true);assert.equal(session.getTutorialState().step,'gunBuy');
  assert.equal(session.weapons.diamonds,200);assert.equal(hud.ui.texts.get('level0:119569'),'200');
  hud.close();hud.open();assert.equal(session.getTutorialState().step,'gunBuy');assert.equal(session.weapons.diamonds,200);
  press('level0:802');release('level0:802');
  assert.equal(session.getTutorialState().step,'gunBuy');assert.equal(session.getTutorialState().drawCount,1);assert.equal(session.weapons.diamonds,100);
  hud.drop({kind:'backpack',index:0},{kind:'equipment',index:1});
  assert.match(alerts.calls.at(-1).text,/抽取 2 次武器（1\/2）/);assert.equal(session.getTutorialState().step,'gunBuy');
  hud.close();hud.open();assert.equal(session.weapons.diamonds,100);
  press('level0:802');release('level0:802');
  assert.equal(session.getTutorialState().step,'gunMerge');assert.equal(session.weapons.diamonds,0);
  let targets=hud.getTutorialTargets();
  assert.equal(targets.from,hud.ui.node(hud.backpack[0].node));assert.equal(targets.to,hud.ui.node(hud.backpack[1].node));
  assert.deepEqual(Array.from(hud.ui.tints.get('level0:117256')),[160,160,160,255]);
  press('level0:802');release('level0:802');assert.match(alerts.calls.at(-1).text,/两把 D 级武器/);
  hud.close();hud.open();assert.equal(session.getTutorialState().step,'gunMerge');assert.equal(session.weapons.diamonds,0);
  hud.drop({kind:'backpack',index:0},{kind:'backpack',index:1});
  assert.equal(session.getTutorialState().step,'gunEquip');assert.equal(session.weapons.snapshot().backpack[1].weaponId,3);
  hud.close();press('level0:624');release('level0:624');
  assert.equal(session.getTutorialState().step,'gunEquip');assert.equal(session.weapons.diamonds,0);
  assert.equal(hud.ui.texts.get('level0:119569'),'0','reopening does not issue another tutorial allowance');
  assert.equal(hud.getTutorialTargets().from,hud.ui.node(hud.backpack[1].node));
  hud.drop({kind:'backpack',index:1},{kind:'equipment',index:1});
  assert.equal(session.getTutorialState().step,'done');assert.equal(session.getTutorialState().active,false);
});

test('new weapon acquisition temporarily takes priority over the main equipment tutorial target',()=>{
  const {hud,session}=harness();session.getTutorialState=()=>({active:true,step:'gunEquip',drawCount:2});
  hud.open();session.weapons.grantTestWeapon(3);hud.update(0);
  assert.equal(hud.getTutorialTargets().blocked,true);assert.equal(hud.roots.get('newGun').active,true);
  assert.equal(hud.getTutorialTargets().from,hud.ui.node(hud.backpack[0].node));
  hud.update(2);assert.equal(hud.getTutorialTargets().blocked,false);
  assert.equal(session.getTutorialState().step,'gunEquip','the popup does not complete or skip the equipment step');
});

test('main tutorial suspends merge hints and auto motion, and completion resumes them without an inventory revision',()=>{
  const {hud,session,synchronize}=harness(),w=session.weapons;
  let tutorial={active:true,step:'gunBuy',drawCount:0};session.getTutorialState=()=>tutorial;
  w.configureTest({autoEnabled:true,adGunEnabled:false});[0,1,2].forEach(id=>w.grantTestWeapon(id));synchronize();hud.open();
  const arrow=hud.ui.node(config.mergeTutorial.node),revision=w.revision;
  hud.update(1);assert.equal(arrow.active,false);assert.equal(hud.autoMotion,null);assert.equal(w.snapshot().firstMerge,false);
  const firstDrawPolicy=hud.lastPolicy;tutorial={active:true,step:'gunBuy',drawCount:1};hud.update(0);
  assert.notEqual(hud.lastPolicy,firstDrawPolicy,'successful draw count refreshes policy even within the same step');assert.equal(w.revision,revision);
  const policy=hud.lastPolicy;tutorial={active:true,step:'gunMerge',drawCount:2};hud.update(0);
  assert.notEqual(hud.lastPolicy,policy);assert.equal(w.revision,revision);
  tutorial={active:false,step:'done',drawCount:2};hud.update(0);
  assert.equal(arrow.active,true);assert.ok(hud.autoMotion);assert.equal(w.revision,revision);
  tutorial={active:true,step:'gunEquip',drawCount:2};hud.update(1);
  assert.equal(arrow.active,false);assert.equal(hud.autoMotion,null);assert.equal(w.snapshot().firstMerge,false);
});

test('source new-gun Reload immediately replaces the active card and resets its grade and two-second clip',()=>{
  const {hud,modal,session}=harness();session.weapons.grantTestWeapon(29);
  hud.update(0);assert.equal(hud.shownNotice.weaponId,29);assert.equal(hud.ui.texts.get(hud.newGun.Degree_objs[0]),'X');
  hud.update(1.9);session.weapons.grantTestWeapon(1);hud.update(0);
  assert.equal(hud.shownNotice.weaponId,1);assert.equal(hud.noticeTime,0);assert.equal(hud.ui.texts.get(hud.newGun.Degree_objs[0]),'D');
  assert.equal(hud.ui.node(hud.newGun.Degree_objs[0]).active,true);
  hud.update(1.9);assert.equal(hud.roots.get('newGun').active,true);
  hud.update(.1);assert.equal(hud.shownNotice,null);assert.equal(hud.roots.get('newGun').active,false);
});

test('mock ads cover the complete resized viewport and cancellation never grants rewards',()=>{
  for(const environment of ['test','production']){
    const {hud,modal,session,cc}=harness(environment);
    session.weapons.recordStageValue(30);hud.resize(720,1600,30,20);modal.resize(720,1550);hud.open();hud.beginAd('daily');
    assert.equal(modal.node.active,true,`${environment} uses the authorized mock provider`);
    const bounds=modal.node.getComponent(cc.UITransform),full=hud.node.getComponent(cc.UITransform);
    assert.equal(bounds.width,full.width);assert.equal(bounds.height,full.height);
    assert.ok(modal.node.getComponent(cc.BlockInputEvents));
    assert.equal(modal.node.parent.children.at(-1),modal.node,'ad shield is above every normal popup');
    assert.ok(modal.node.children.some(n=>n.name==='AdPanel'),'small ad controls live inside the full-screen shield');
    const token=session.weapons.snapshot().pendingAd.token;hud.cancelInteractions();
    assert.equal(session.weapons.snapshot().pendingAd,null);assert.equal(session.weapons.snapshot().backpack.filter(Boolean).length,0);
    assert.equal(session.weapons.completeAd(token,'success').reason,'staleAd');
  }
});

test('test-mode daily draw is visible at stage zero and its real ad buttons preserve the allowance until success',()=>{
  const {hud,modal,session,cc,event,press,release,alerts}=harness(),w=session.weapons;
  hud.open();
  const daily=()=>hud.ui.node('level0:1491').active;
  const finish=index=>{const button=modal.node.children[0].children.find(node=>node.name===`Ad${index}`),p=button.worldPosition;
    button.emit(cc.Node.EventType.TOUCH_START,event(1,p.x,p.y,cc.Node.EventType.TOUCH_START));button.emit(cc.Node.EventType.TOUCH_END,event(1,p.x,p.y));};
  assert.equal(w.snapshot().stageValueMax,0);assert.equal(daily(),true);
  const before=w.serialize().backpack,balance=w.diamonds;
  for(const [outcome,index] of [['cancel',1],['failure',2]]){
    press('level0:1491');release('level0:1491');
    assert.equal(w.snapshot().pendingAd.kind,'daily');assert.equal(modal.node.active,true);
    assert.equal(modal.node.children[0].children[0].getComponent(cc.Label).string,'模拟广告');
    const token=w.snapshot().pendingAd.token;finish(index);
    assert.equal(modal.node.active,false);assert.equal(w.snapshot().pendingAd,null);
    assert.deepEqual(w.serialize().backpack,before,`${outcome} grants no weapon`);
    assert.equal(w.snapshot().dailyAdAvailable,true);assert.equal(daily(),true);
    assert.equal(w.completeAd(token,'success').reason,'staleAd','late completion cannot grant a cancelled reward');
  }
  assert.deepEqual(alerts.calls,[{text:'广告加载失败。'}]);
  press('level0:1491');release('level0:1491');
  const token=w.snapshot().pendingAd.token;finish(0);
  const reward=w.snapshot().backpack.filter(Boolean);
  assert.equal(reward.length,1);assert.equal(catalog.getWeaponGrade(reward[0].weaponId),1);
  assert.equal(reward[0].pendingAd,false);assert.equal(w.diamonds,balance);
  assert.equal(w.snapshot().dailyAdAvailable,false);assert.equal(daily(),false);
  assert.equal(w.snapshot().stageValueMax,0,'the bypass does not advance progression');
  assert.equal(w.completeAd(token,'success').reason,'staleAd');
  assert.equal(w.snapshot().backpack.filter(Boolean).length,1);
});

test('production daily draw remains hidden before stage 30 and appears when the source milestone is reached',()=>{
  const {hud,modal,session,press,release,synchronize}=harness('production'),w=session.weapons;
  hud.open();
  for(const stage of [0,29]){
    w.recordStageValue(stage);synchronize();
    assert.equal(hud.ui.node('level0:1491').active,false);
    assert.equal(w.snapshot().dailyAdUnlocked,false);
    assert.equal(w.beginAd('daily').reason,'locked');assert.equal(w.snapshot().pendingAd,null);
  }
  w.recordStageValue(30);synchronize();
  assert.equal(hud.ui.node('level0:1491').active,true);assert.equal(w.snapshot().dailyAdUnlocked,true);
  press('level0:1491');release('level0:1491');
  assert.equal(modal.node.active,true);assert.equal(w.snapshot().pendingAd.kind,'daily');
});

test('shared provider routes weapon placements and immediate failure never grants the queued reward',()=>{
  const {hud,modal,presenter,session,alerts}=harness();
  presenter.showRewardedAd=(token,placement,complete)=>{
    assert.equal(placement,'weapon-daily');complete('failure');complete('success');
  };
  hud.open();hud.beginAd('daily');
  assert.equal(modal.isOpen,false);assert.equal(session.weapons.snapshot().pendingAd,null);
  assert.equal(session.weapons.snapshot().backpack.filter(Boolean).length,0);
  assert.deepEqual(alerts.calls,[{text:'广告加载失败。'}]);
});

function prepareAuto(){
  const h=harness(),{hud,session,synchronize}=h,w=session.weapons;
  w.configureTest({autoEnabled:true,adGunEnabled:false});
  w.grantTestWeapon(5);w.equip(0,1);w.grantTestWeapon(0);w.grantTestWeapon(2);w.grantTestWeapon(2);w.equip(0,2);
  synchronize();hud.open();
  hud.list.SlotTransforms.forEach((key,index)=>hud.ui.node(key).setWorldPosition(index*300,200));
  hud.slots.forEach((role,index)=>hud.ui.node(role.node).setWorldPosition(-1000-index*400,1000));
  hud.alignBackpack();hud.update(0);
  return{...h,w};
}

test('source auto motion moves the later card into the first with SmoothStep and keeps that exact pair through draws',()=>{
  const {hud,w,press,release}=prepareAuto(),motion=hud.autoMotion;
  assert.ok(motion);assert.equal(motion.fromIndex,2);assert.equal(motion.toIndex,1);
  hud.update(.05);assert.ok(Math.abs(motion.from.worldPosition.x-568.8)<1e-8);
  const position=motion.from.worldPosition.x;
  for(let i=0;i<2;i++){press('level0:802');release('level0:802');}
  assert.ok(hud.autoMotion===motion,'draw refresh keeps the same pair');assert.equal(motion.elapsed,.05);
  assert.equal(motion.from.worldPosition.x,position,'drawing never snaps the moving card to its slot');
  assert.equal(hud.ui.node(hud.backpack[0].node).worldPosition.x,0,'new D gun appears in the earlier empty slot');
  assert.ok(hud.spawnBounces.has(hud.ui.node(hud.backpack[0].node)));
  assert.ok(!hud.spawnBounces.has(motion.from));assert.ok(!hud.spawnBounces.has(motion.to));
  hud.update(.15);assert.ok(hud.autoMotion===motion,'31.2 units remain, outside the source merge threshold');
  hud.update(.0125);assert.equal(hud.autoMotion,null,'merge triggers within 25 units before .25 seconds');
  const bag=w.snapshot().backpack;
  assert.equal(bag[0].weaponId,0);assert.equal(bag[3].weaponId,0,'the newer lower-grade pair was not consumed');
  assert.equal(bag[1].weaponId,5);assert.equal(bag[2],null,'result remains in the earlier C slot');
  hud.update(.119);assert.equal(hud.autoMotion,null);hud.update(.002);
  assert.equal(hud.autoMotion.fromIndex,3);assert.equal(hud.autoMotion.toIndex,0);
});

test('drawing owns one pointer while auto continues and charges once per accepted action',()=>{
  const {hud,w,press,release,cancel}=prepareAuto(),motion=hud.autoMotion;
  const balance=w.diamonds;
  press('level0:802',1);assert.ok(hud.autoMotion===motion);press('level0:802',2);release('level0:802',2);cancel('level0:802',2);
  const button=hud.ui.node('level0:802');
  assert.equal(w.diamonds,balance);assert.equal(hud.buttonTouches.get(button).pointer,1);
  release('level0:802',1);assert.equal(w.diamonds,balance-100);assert.equal(hud.buttonTouches.has(button),false);
  press('level0:802',3);hud.update(.4);assert.equal(w.diamonds,balance-100,'source Draw button has no repeat component');
  assert.equal(w.snapshot().backpack[1].weaponId,5,'held drawing does not pause the current merge');
  hud.update(.1);assert.equal(w.diamonds,balance-100);release('level0:802',3);assert.equal(w.diamonds,balance-200);
  release('level0:802',3);assert.equal(w.diamonds,balance-200,'duplicate release cannot draw again');
  press('level0:802',4);cancel('level0:802',4);hud.update(1);assert.equal(w.diamonds,balance-200);
});

test('discovering a new draw does not interrupt auto motion or the next pair behind its acquisition popup',()=>{
  const {hud,w,press,release}=prepareAuto(),motion=hud.autoMotion;
  w.rng=()=>.9;hud.update(.05);
  press('level0:802');release('level0:802');press('level0:802');release('level0:802');
  hud.update(.01);
  assert.equal(hud.shownNotice.weaponId,62);assert.ok(hud.autoMotion===motion);
  assert.ok(Math.abs(motion.elapsed-.06)<1e-9);assert.ok(motion.from.worldPosition.x<568.8);
  hud.update(.16);assert.equal(w.snapshot().backpack[1].weaponId,64);assert.equal(w.snapshot().backpack[2],null);
  hud.update(.12);assert.equal(hud.autoMotion.fromIndex,3);assert.equal(hud.autoMotion.toIndex,0);
  assert.equal(hud.roots.get('newGun').active,true,'new-gun popup stays visible while the next pair starts');
});

test('source overlays preserve both the active auto pair and the next pair instead of pausing the chain',()=>{
  for(const overlay of ['detail','collection','probability','star']){
    const {hud,w}=prepareAuto(),motion=hud.autoMotion;
    w.grantTestWeapon(1);w.grantTestWeapon(0);w.drainNotifications();hud.refresh();
    if(overlay==='detail')hud.openDetail(0,{kind:'equipment',index:0});
    else hud.roots.get(overlay).active=true;
    assert.ok(hud.autoMotion===motion);hud.update(.22);assert.equal(w.snapshot().backpack[1].weaponId,5,overlay);
    hud.update(.121);assert.ok(hud.autoMotion,`${overlay} does not stop the next auto pair`);
    assert.equal(hud.ui.node('level0:10362').active,true);assert.equal(hud.ui.node('level0:10186').active,false);
    w.setAutoMerge(false);hud.update(0);assert.equal(hud.ui.node('level0:10362').active,false);assert.equal(hud.ui.node('level0:10186').active,true);
  }
});

test('new-gun card alone consumes input while outer inventory actions remain usable for the full source display duration',()=>{
  const {hud,modal,session,cc,event,press,release}=harness();hud.open();session.weapons.grantTestWeapon(29);hud.update(0);
  const root=hud.roots.get('newGun');assert.equal(root.getComponent(cc.BlockInputEvents),undefined);
  assert.ok(hud.ui.node('level0:8964').getComponent(cc.BlockInputEvents));
  assert.equal(hud.ui.node('level0:19309').getComponent(cc.BlockInputEvents),undefined);
  root.emit(cc.Node.EventType.TOUCH_END,event());assert.equal(root.active,true,'there is no whole-screen dismiss listener');
  const before=session.weapons.diamonds;press('level0:802');release('level0:802');assert.equal(session.weapons.diamonds,before-100);
  hud.close();session.weapons.grantTestWeapon(39);hud.update(0);
  assert.equal(root.active,true);assert.equal(hud.isOpen,false,'standalone acquisition is not a full-screen modal');
});

test('first merge tutorial picks the first two unlocked non-ad D cards and ends permanently after first merge',()=>{
  const {hud,modal,session,synchronize}=harness(),w=session.weapons,c=config.mergeTutorial;
  [2,1,0,1,1].forEach(id=>w.grantTestWeapon(id));w.toggleLock({kind:'backpack',index:1});
  w.state.backpack[2].pendingAd=true;w.state.adGunExpiresAt=w.now+1800000;w.changed();synchronize();hud.open();
  const arrow=hud.ui.node(c.node);assert.equal(arrow.active,true);
  assert.equal(hud.feedback.tutorial.from,hud.ui.node(hud.backpack[3].node));assert.equal(hud.feedback.tutorial.to,hud.ui.node(hud.backpack[4].node));
  hud.close();assert.equal(arrow.active,false);hud.open();assert.equal(arrow.active,true);
  hud.cancelInteractions();assert.equal(arrow.active,false);hud.update(0);assert.equal(arrow.active,true,'guidance resumes after background cleanup while the inventory remains open');
  w.merge(3,4);hud.update(0);assert.equal(arrow.active,false);assert.equal(w.snapshot().firstMerge,true);
  w.grantTestWeapon(0);hud.refresh();assert.equal(arrow.active,false);
});

test('test star buttons open and upgrade at zero progress while production waits for stage 390',()=>{
  for(const environment of ['test','production']){
    const {hud,modal,session,press,release,alerts}=harness(environment),w=session.weapons;
    hud.open();
    for(const slot of hud.slots)assert.equal(hud.ui.node(slot.StarUpgrade_obj).active,environment==='test');
    const starButton=hud.slots[0].StarUpgrade_obj;
    press(starButton);release(starButton);
    assert.equal(hud.roots.get('star').active,environment==='test');
    if(environment==='test'){
      assert.equal(w.starGems,1000000);
      w.configureTest({starGems:0});hud.refresh();
      press('level0:1072');release('level0:1072');
      assert.deepEqual(alerts.calls,[{key:'StarUpgrade/NotEnoughGem'}]);
      w.grantTestStarGems(50);hud.refresh();
      press('level0:1072');release('level0:1072');
      assert.equal(w.snapshot().stars[0].level,1);assert.equal(w.starGems,0);
      assert.equal(hud.confetti.playCount,1);
      assert.equal(w.snapshot().stageValueMax,0);
    }else{
      w.recordStageValue(389);hud.refresh();assert.equal(hud.ui.node(starButton).active,false);
      w.recordStageValue(390);hud.refresh();assert.equal(hud.ui.node(starButton).active,true);
      press(starButton);release(starButton);assert.equal(hud.roots.get('star').active,true);
    }
  }
});

test('star cost and upgrade button use both original serialized affordability color arrays',()=>{
  const {hud,modal,session}=harness(),w=session.weapons;hud.roots.get('star').active=true;
  for(const gems of [0,50]){
    w.configureTest({starGems:gems});hud.refreshStar(w.snapshot());const affordable=gems>=50?1:0;
    for(const [target,colors] of [[hud.star.UpgradePrice_txt,hud.star.UpgradePrice_Colors],[hud.star.Upgrade_Btn_img,hud.star.UpgradeBtn_Colors]]){
      const c=colors[affordable];assert.deepEqual(Array.from(hud.ui.tints.get(target)),[c.r,c.g,c.b,c.a].map(value=>Math.round(value*255)));
    }
  }
});

test('star price refresh preserves the original inline currency through changing costs and removes it at max level',()=>{
  const {hud,modal,session}=harness(),w=session.weapons;hud.roots.get('star').active=true;
  for(const level of [0,1,3,19,20]){
    w.configureTest({starLevels:[level,0,0]});const snapshot=w.snapshot();hud.refreshStar(snapshot);
    const cost=snapshot.stars[0].cost;
    assert.equal(hud.ui.texts.get(hud.star.UpgradePrice_txt),cost===null?'MAX':`<sprite=0>${cost}`);
  }
});

test('original generic button sound and scale follow a single valid pointer, cancel outside releases and reset when hidden',()=>{
  const {hud,cc,event,press,release,cancel,sounds}=harness();const id='level0:624',node=hud.ui.node(id),spec=config.nodes[id];
  press(id,1);press(id,2);hud.update(spec.bounceButton.duration*.5);assert.ok(Math.abs(node.scale.x-.95)<1e-6);
  release(id,2);assert.equal(hud.isOpen,false);release(id,1);assert.equal(hud.isOpen,true);assert.deepEqual(sounds,[1]);
  hud.update(spec.bounceButton.duration);assert.equal(node.scale.x,1);
  hud.close();press(id,3);hud.update(spec.bounceButton.duration);
  node.emit(cc.Node.EventType.TOUCH_CANCEL,event(3,99999,99999,cc.Input.EventType.TOUCH_END,cc.Node.EventType.TOUCH_CANCEL));
  assert.equal(hud.isOpen,false);assert.deepEqual(sounds,[1]);assert.equal(node.scale.x,1);
  press(id,4);node.emit(cc.Node.EventType.TOUCH_END,event(4,99999,99999));assert.equal(hud.isOpen,false);assert.deepEqual(sounds,[1]);
  press(id,5);hud.update(.05);node.active=false;hud.update(0);assert.equal(node.scale.x,1);assert.equal(hud.buttonTouches.has(node),false);
  node.active=true;release(id,5);assert.equal(hud.isOpen,false);press(id,6);cancel(id,6);assert.deepEqual(sounds,[1]);
});

test('auto pair uses source overlays, cancels spawn scaling and cannot be pressed or dragged',()=>{
  const {hud,w,cc,event}=prepareAuto();hud.stopAutoMotion();
  for(const index of [1,2])hud.spawnBounce(hud.ui.node(hud.backpack[index].node));
  assert.equal(hud.spawnBounces.size,2);hud.startAutoMotion(w.snapshot());
  const motion=hud.autoMotion;assert.equal(hud.spawnBounces.size,0);
  for(const index of [1,2]){
    const role=hud.backpack[index],node=hud.ui.node(role.node);
    assert.equal(hud.ui.node(role.AutoMerge_obj).active,true);assert.equal(hud.ui.node(role.FusionAble_obj).active,false);
    hud.spawnBounce(node);assert.equal(hud.spawnBounces.has(node),false);assert.equal(node.scale.x,1);
    node.emit(cc.Node.EventType.TOUCH_START,event(1,node.worldPosition.x,200));
    node.emit(cc.Node.EventType.TOUCH_MOVE,event(1,-500,200));
    node.emit(cc.Node.EventType.TOUCH_END,event(1,-500,200));
    assert.equal(hud.drag,null);assert.equal(hud.roots.get('detail').active,false);assert.ok(hud.autoMotion===motion);
  }
  assert.ok(motion.from.parent.children.at(-1)===motion.from);
  hud.close();assert.equal(hud.autoMotion,null);
  for(const index of [1,2])assert.equal(hud.ui.node(hud.backpack[index].AutoMerge_obj).active,false);
});

test('auto cancels only when a material changes and never merges a replacement item',()=>{
  const {hud,w}=prepareAuto(),motion=hud.autoMotion;hud.update(.05);
  w.equip(2,0);hud.update(.15);
  assert.equal(hud.autoMotion,null);assert.equal(motion.from.worldPosition.x,600);
  assert.equal(w.snapshot().backpack[1].weaponId,2);assert.equal(w.snapshot().backpack[2].weaponId,0);
  assert.equal(hud.ui.node(hud.backpack[1].AutoMerge_obj).active,false);
});

test('unrelated backpack dragging keeps auto moving but delays its transaction and cannot hover on its pair',()=>{
  const {hud,w,cc,event,synchronize}=prepareAuto();w.draw();synchronize();
  const motion=hud.autoMotion,other=hud.ui.node(hud.backpack[0].node);
  other.emit(cc.Node.EventType.TOUCH_START,event(1,0,200));
  other.emit(cc.Node.EventType.TOUCH_MOVE,event(1,300,200));
  assert.ok(hud.autoMotion===motion);assert.equal(hud.drag.overlap,null,'auto materials are excluded from hover exchange/merge');
  hud.update(.25);assert.ok(hud.autoMotion===motion);assert.equal(motion.from.worldPosition.x,300);
  assert.equal(w.snapshot().backpack[1].weaponId,2,'do not refresh the list under a drag');
  other.emit(cc.Node.EventType.TOUCH_CANCEL,event(1,300,200,cc.Input.EventType.TOUCH_CANCEL));
  assert.equal(hud.drag,null);assert.equal(motion.from.worldPosition.x,300,'drag cleanup preserves the waiting animation');
  hud.update(0);assert.equal(w.snapshot().backpack[1].weaponId,5);assert.equal(w.snapshot().backpack[2],null);
});

test('source auto selection during a drag skips its source and preview target while unrelated pairs keep moving',()=>{
  // FindAutoMergePair excludes isDragging, currentFusionTarget and currentSwapTarget;
  // AutoMergeRoutine only waits for IsAnyItemDragging once the pair reaches its target.
  for(const ids of [[1,2,2,3,5],[1,0,1,2,2,5]]){
    const {hud,w,start,move,source,cc,event,synchronize}=prepareHoverDrag(ids);
    w.setAutoMerge(true);synchronize();start();move(0);
    const drag=hud.drag,before=w.serialize(),target=ids[1]===2?2:3;
    assert.equal(drag.overlap,1);hud.update(0);
    assert.ok(hud.autoMotion,'a held unrelated card must not suspend Auto selection');
    assert.equal(hud.autoMotion.toIndex,target);assert.equal(hud.autoMotion.fromIndex,target+1);
    assert.equal(hud.drag,drag);assert.equal(drag.overlap,1,'the hover preview keeps ownership of its target');
    hud.update(.3);assert.ok(hud.autoMotion);assert.deepEqual(w.serialize(),before,'movement cannot commit under the drag');
    source.emit(cc.Node.EventType.TOUCH_CANCEL,event(1,0,200,cc.Input.EventType.TOUCH_CANCEL));
    hud.update(0);assert.equal(w.snapshot().backpack[target].weaponId,5);assert.equal(w.snapshot().backpack[target+1],null);
    assert.equal(w.snapshot().backpack[0].weaponId,1);assert.equal(w.snapshot().backpack[1].weaponId,ids[1]);
  }
});

test('ad countdown truncates remaining seconds like Gun_Item.UpdateAdTimeText and never displays a negative value',()=>{
  const {hud,session}=harness(),w=session.weapons;w.grantTestWeapon(8);
  w.state.backpack[0].pendingAd=true;const role=hud.backpack[0];
  for(const [remaining,text] of [[60001,'1:00'],[59999,'0:59'],[999,'0:00'],[1,'0:00']]){
    w.state.adGunExpiresAt=w.now+remaining;hud.refreshTimers(w.snapshot());assert.equal(hud.ui.texts.get(role.AD_Time_txt),text);
  }
  w.beginAd('weapon');w.advanceTestTime(10);
  hud.refreshTimers(w.snapshot());assert.equal(hud.ui.texts.get(role.AD_Time_txt),'0:00','in-flight rewarded ads may retain an expired placeholder');
});

test('opening a nested popup cancels an underlying held button before its claimed touch can transact',()=>{
  const {hud,session,press,release,synchronize}=harness(),w=session.weapons;
  w.grantTestWeapon(2);w.equip(0,1);synchronize();hud.open();
  const unequip='level0:32426',button=hud.ui.node(unequip),before=w.serialize();
  press(unequip,1);press('level0:4572',2);release('level0:4572',2);
  assert.equal(hud.roots.get('star').active,true);
  release(unequip,1);assert.deepEqual(w.serialize(),before,'a release claimed before the popup cannot remove its displayed gun');
  assert.equal(hud.buttonTouches.has(button),false);
  press('level0:1072',3);release('level0:1072',3);
  assert.equal(w.snapshot().stars[1].level,1,'the active popup remains interactive');
});

test('vault entry is absent and test-only lock bypass is reflected by the real detail buttons',()=>{
  for(const environment of ['test','production']){
    const {hud,modal,session,press,release,alerts}=harness(environment),w=session.weapons;
    assert.equal(hud.ui.node('level0:2027').active,false);assert.equal(hud.ui.node('level0:483').active,false);
    hud.openDetail(0,{kind:'equipment',index:0});
    assert.equal(hud.ui.node(hud.detail.Pause_Btn_Locked_obj).active,environment==='production');
    assert.equal(hud.ui.node(hud.detail.Pause_Btn_obj).active,environment==='test');
    if(environment==='test'){
      press(hud.detail.Pause_Btn_obj);release(hud.detail.Pause_Btn_obj);
      assert.equal(w.snapshot().equipment[0].locked,true);assert.equal(hud.ui.node(hud.detail.Unpause_Btn_obj).active,true);
      press(hud.detail.Unpause_Btn_obj);release(hud.detail.Unpause_Btn_obj);
      assert.equal(w.snapshot().equipment[0].locked,false);assert.equal(alerts.calls.length,0);
    }
    assert.equal(w.snapshot().stageValueMax,0);
  }
});

function prepareOutsideDrag(options={}){
  const h=harness('test',{},undefined,options),{hud,session,cc}=h,w=session.weapons;
  w.configureTest({autoEnabled:false,adGunEnabled:false});w.grantTestWeapon(2);h.synchronize();hud.open();
  // Explicit independent bounds keep this a gesture/transaction test rather
  // than asserting an approximation of Cocos layout or camera projection.
  hud.slots.forEach((role,index)=>hud.ui.node(role.node).setWorldPosition(-1000-index*200,200));
  hud.list.SlotTransforms.forEach((key,index)=>hud.ui.node(key).setWorldPosition(1000+index*200,200));
  hud.ui.node(hud.list.SlotTransforms[0]).setWorldPosition(-400,200);
  hud.ui.node(hud.slots[2].node).setWorldPosition(400,200);hud.alignBackpack();
  const source=hud.ui.node(hud.backpack[0].node);source.getComponent(cc.UITransform).setContentSize(100,100);
  return {...h,w,source};
}

test('a claimed UI drag released outside its source drops on platform END even when its node event is CANCEL',()=>{
  const {hud,w,source,cc,event}=prepareOutsideDrag(),{Node,Input}=cc;
  const emit=(type,pointer,x,y,code=type)=>source.emit(type,event(pointer,x,y,code,type));
  emit(Node.EventType.TOUCH_START,7,-400,200);emit(Node.EventType.TOUCH_START,8,-400,200);
  assert.equal(hud.drag.pointer,7,'a second touch cannot replace the claimed drag');
  emit(Node.EventType.TOUCH_MOVE,8,400,200);assert.equal(hud.drag.moved,false);
  emit(Node.EventType.TOUCH_MOVE,7,400,200);assert.equal(hud.drag.moved,true);
  assert.equal(hud.drag.ghost,undefined,'the original card follows the pointer, without a ghost');
  assert.equal(source.worldPosition.x,400);assert.equal(source.scale.x,1);
  assert.equal(source.getComponent(cc.UIOpacity),undefined,'the dragged card stays fully opaque');
  emit(Node.EventType.TOUCH_CANCEL,8,400,200,Input.EventType.TOUCH_CANCEL);assert.equal(hud.drag.pointer,7);
  const revision=w.snapshot().revision;
  // A claimed UI event does not reach global input in Cocos. Deliberately emit
  // only on the source node to reproduce the browser-discovered regression.
  emit(Node.EventType.TOUCH_CANCEL,7,400,200,Input.EventType.TOUCH_END);
  assert.equal(hud.drag,null);assert.equal(w.snapshot().equipment[2].weaponId,2);assert.equal(w.snapshot().backpack[0],null);
  assert.equal(w.snapshot().revision,revision+1);assert.equal(source.isValid,true);assert.equal(source.worldPosition.x,-400);
  cc.input.emit(Input.EventType.TOUCH_END,event(7,400,200));assert.equal(w.snapshot().revision,revision+1,'late duplicate END cannot apply another transaction');
  hud.destroy();assert.ok([...cc.input.events.values()].every(list=>list.length===0),'global fallback listeners are removed with the HUD');
  assert.equal(hud.ui.destroyCalls,1,'the weapon HUD releases its owned bitmap frame views');
});

test('dropping an unclaimed ad gun on equipment opens its reward flow without equipping it',()=>{
  const {hud,modal,w,source,cc,event,synchronize,alerts}=prepareOutsideDrag(),{Node,Input}=cc;
  w.state.backpack[0]={weaponId:8,locked:false,pendingAd:true};w.state.adGunExpiresAt=w.now+1800000;w.changed();synchronize();
  const equipment=w.serialize().equipment;
  const drag=()=>{
    source.emit(Node.EventType.TOUCH_START,event(7,-400,200,Input.EventType.TOUCH_START));
    source.emit(Node.EventType.TOUCH_MOVE,event(7,400,200,Input.EventType.TOUCH_MOVE));
    source.emit(Node.EventType.TOUCH_CANCEL,event(7,400,200,Input.EventType.TOUCH_END,Node.EventType.TOUCH_CANCEL));
  };
  drag();assert.equal(hud.drag,null);assert.equal(modal.isOpen,true);assert.equal(w.snapshot().pendingAd.kind,'weapon');
  assert.deepEqual(w.serialize().equipment,equipment);assert.equal(w.snapshot().backpack[0].pendingAd,true);
  hud.completeAd('cancel');assert.equal(modal.isOpen,false);assert.equal(w.snapshot().backpack[0].pendingAd,true);
  drag();hud.completeAd('success');assert.equal(w.snapshot().backpack[0].pendingAd,false);
  assert.deepEqual(w.serialize().equipment,equipment,'the source reward claims the backpack gun, without automatically equipping it');
  drag();assert.equal(w.snapshot().equipment[2].weaponId,8);assert.equal(w.snapshot().backpack[0],null);
  assert.deepEqual(alerts.calls,[],'the ad gesture does not display the generic rejection');
});

test('equal-grade equipment swaps keep both weapons and explain that fusion requires unequipping',()=>{
  const {hud,session,synchronize,alerts}=harness(),w=session.weapons;
  w.configureTest({starLevels:[2,3,4]});w.grantTestWeapon(1);w.grantTestWeapon(0);w.equip(1,1);
  w.toggleLock({kind:'backpack',index:0});synchronize();
  hud.drop({kind:'backpack',index:0},{kind:'equipment',index:0});
  assert.equal(w.snapshot().backpack[0].weaponId,0);assert.equal(w.snapshot().equipment[0].weaponId,1);
  assert.equal(w.snapshot().equipment[0].locked,true);
  assert.deepEqual(alerts.calls,[{key:'Alarm/SelectedFusionError'}]);
  hud.drop({kind:'equipment',index:0},{kind:'equipment',index:1});
  assert.deepEqual(w.snapshot().equipment.map(item=>item?.weaponId??null),[0,1,null]);
  assert.equal(w.snapshot().equipment[1].locked,true);
  assert.deepEqual(w.snapshot().stars.map(star=>star.level),[2,3,4],'the notice does not move slot stars');
  assert.deepEqual(alerts.calls,[{key:'Alarm/SelectedFusionError'},{key:'Alarm/SelectedFusionError'}]);
  hud.drop({kind:'equipment',index:1},{kind:'equipment',index:2});
  w.grantTestWeapon(2);synchronize();
  hud.drop({kind:'backpack',index:1},{kind:'equipment',index:0});
  assert.equal(w.snapshot().equipment[0].weaponId,2);
  assert.equal(alerts.calls.length,2,'empty destinations and different-grade swaps do not show a fusion warning');
});

test('platform CANCEL over a valid destination cleans the drag without equipping or opening details',()=>{
  const {hud,w,source,cc,event}=prepareOutsideDrag(),{Node,Input}=cc;
  source.emit(Node.EventType.TOUCH_START,event(3,-400,200,Input.EventType.TOUCH_START));
  source.emit(Node.EventType.TOUCH_MOVE,event(3,400,200,Input.EventType.TOUCH_MOVE));
  const before=w.snapshot();assert.equal(source.worldPosition.x,400);
  source.emit(Node.EventType.TOUCH_CANCEL,event(3,400,200,Input.EventType.TOUCH_CANCEL,Node.EventType.TOUCH_CANCEL));
  assert.equal(hud.drag,null);assert.equal(w.snapshot().equipment[2],null);assert.deepEqual(w.snapshot().backpack,before.backpack);
  assert.equal(w.snapshot().revision,before.revision);assert.equal(source.isValid,true);assert.equal(source.worldPosition.x,-400);assert.equal(source.scale.x,1);
  assert.equal(hud.roots.get('detail').active,false);assert.equal(w.snapshot().pendingAd,null);
  hud.backpack.forEach(role=>assert.equal(hud.ui.node(role.FusionAble_obj).active,false));
});

function prepareHoverDrag(ids=[1,2,5]){
  const h=harness(),{hud,session,cc,event}=h,w=session.weapons;
  w.configureTest({autoEnabled:false,adGunEnabled:false,stageValueMax:390});ids.forEach(id=>w.grantTestWeapon(id));h.synchronize();hud.open();
  hud.slots.forEach((role,index)=>hud.ui.node(role.node).setWorldPosition(-3000-index*400,1000));
  hud.list.SlotTransforms.forEach((key,index)=>hud.ui.node(key).setWorldPosition(2000+index*300,200));
  [-600,0,400,120,600].forEach((x,index)=>hud.ui.node(hud.list.SlotTransforms[index]).setWorldPosition(x,200));
  hud.ui.node(hud.list.node).getComponent(cc.UITransform).setContentSize(1600,700);
  hud.ui.node(hud.list.node).setWorldPosition(0,200);hud.alignBackpack();
  const source=hud.ui.node(hud.backpack[0].node),at=index=>hud.ui.node(hud.backpack[index].node).worldPosition.x;
  const emit=(type,x,y=200,pointer=1,code=type)=>source.emit(type,event(pointer,x,y,code,type));
  const start=(x=-600,y=200)=>emit(cc.Node.EventType.TOUCH_START,x,y);
  const move=(x,y=200)=>emit(cc.Node.EventType.TOUCH_MOVE,x,y);
  const end=(x,y=200)=>emit(cc.Node.EventType.TOUCH_CANCEL,x,y,1,cc.Input.EventType.TOUCH_END);
  return {...h,w,source,at,emit,start,move,end};
}

test('different-grade hover immediately yields the nearest empty grid cell, switches stably and commits only on release',()=>{
  const {hud,w,at,start,move,end}=prepareHoverDrag();const before=w.serialize(),revision=w.snapshot().revision;
  start();move(0);assert.equal(at(0),0);assert.equal(at(1),120,'target previews in slot 3 rather than swapping into distant source slot');
  assert.equal(hud.drag.displacedTo,3);assert.deepEqual(w.serialize(),before);assert.equal(w.snapshot().revision,revision);
  move(5);assert.equal(at(1),120,'logical original slot keeps the preview stable after the target moves');
  move(400);assert.equal(at(1),0,'previous target immediately returns');assert.equal(at(2),600);assert.equal(hud.drag.displacedTo,4);
  move(1000);assert.equal(at(2),400);assert.equal(hud.drag.overlap,null);
  move(0);end(0);assert.equal(hud.drag,null);assert.equal(w.snapshot().revision,revision+1);
  assert.deepEqual(w.snapshot().backpack.slice(0,4).map(item=>item?.weaponId??null),[null,1,5,2]);
  assert.equal(at(1),0);assert.equal(at(3),120);assert.equal(hud.cardScales.size<=2,true);
});

test('full backpack hover uses the source cell, platform cancel restores it, and release swaps without losing any gun',()=>{
  const {hud,w,at,start,move,end,emit,cc}=prepareHoverDrag(Array.from({length:16},(_,i)=>catalog.getWeaponIdsForGrade(i%13)[0]));
  const before=w.serialize();start();move(0);assert.equal(at(1),-600);assert.equal(hud.drag.displacedTo,0);
  emit(cc.Node.EventType.TOUCH_CANCEL,0);assert.equal(at(0),-600);assert.equal(at(1),0);assert.deepEqual(w.serialize(),before);
  start();move(0);end(0);assert.equal(w.snapshot().backpack[0].weaponId,2);assert.equal(w.snapshot().backpack[1].weaponId,0);
  assert.deepEqual(w.snapshot().backpack.map(x=>x.weaponId).sort((a,b)=>a-b),before.backpack.map(x=>x.weaponId).sort((a,b)=>a-b));
});

test('drag retains grab offset and source overlap shrink; only the current pair gets SmoothStep fusion feedback',()=>{
  const {hud,w,source,start,move,end,at}=prepareHoverDrag([1,0,1]);start(-588,208);hud.update(.04);
  assert.ok(Math.abs(source.scale.x-.95)<1e-6,'halfway press uses .08 second SmoothStep to .9');
  move(142,208);assert.equal(at(0),130,'grabbing off-center does not snap the card center to the finger');
  assert.equal(hud.drag.overlap,null,'shrunk rectangles touching at 130 units do not overlap');
  move(141,208);assert.equal(hud.drag.overlap,1);assert.equal(hud.drag.fusion,1);
  assert.equal(hud.ui.node(hud.backpack[0].FusionAble_obj).active,true);
  assert.equal(hud.ui.node(hud.backpack[1].FusionAble_obj).active,true);
  assert.equal(hud.ui.node(hud.backpack[2].FusionAble_obj).active,false,'other same-grade cards stay unhighlighted');
  hud.update(.075);assert.ok(Math.abs(source.scale.x-1.025)<1e-6);
  hud.update(.075);assert.equal(source.scale.x,1.05);
  move(700,208);hud.update(.15);assert.equal(source.scale.x,1);assert.equal(hud.ui.node(hud.backpack[1].node).scale.x,1);
  move(12,208);end(12,208);assert.equal(w.snapshot().backpack[0],null);assert.equal(w.snapshot().backpack[1].weaponId,2);
});

test('same-grade locked cards do not yield or fuse, while locked different-grade cards can move',()=>{
  const {hud,w,start,move,end,at,synchronize}=prepareHoverDrag([1,0,5]);w.toggleLock({kind:'backpack',index:1});synchronize();
  const before=w.serialize();start();move(0);assert.equal(at(1),0);assert.equal(hud.drag.fusion,null);assert.equal(hud.drag.displacedTo,null);
  end(0);assert.deepEqual(w.serialize(),before);assert.equal(hud.alerts.calls.at(-1).key,'Gun/PauseMergeError');
  w.toggleLock({kind:'backpack',index:0});synchronize();start();move(400);assert.equal(at(2),600);end(400);
  assert.equal(w.snapshot().backpack[2].weaponId,1);assert.equal(w.snapshot().backpack[2].locked,true);assert.equal(w.snapshot().backpack[4].weaponId,5);
});

test('pending ad guns can be dragged; same-grade drop opens the ad without merging and highest grade still previews before rejecting',()=>{
  const {hud,modal,w,start,move,end,synchronize}=prepareHoverDrag([8,5]);
  w.state.backpack[0]={weaponId:8,locked:false,pendingAd:true};w.state.adGunExpiresAt=w.now+1800000;w.changed();synchronize();
  const before=w.serialize().backpack;start();move(0);assert.equal(hud.drag.moved,true);assert.equal(hud.drag.fusion,1);
  end(0);assert.equal(w.snapshot().pendingAd.kind,'weapon');assert.deepEqual(w.serialize().backpack,before);assert.equal(modal.node.active,true);
  hud.completeAd('cancel');assert.deepEqual(w.serialize().backpack,before);
  w.state.backpack[0]={weaponId:54,locked:false,pendingAd:false};w.state.backpack[1]={weaponId:57,locked:false,pendingAd:false};w.changed();synchronize();
  const maxBefore=w.serialize().backpack;start();move(0);assert.equal(hud.drag.fusion,1);end(0);
  assert.deepEqual(w.serialize().backpack,maxBefore);assert.equal(hud.alerts.calls.at(-1).key,'Alarm/MaxGradeError');
});

test('closing, background cleanup and inventory revision cancel preview positions and every temporary scale',()=>{
  const {hud,w,start,move,at}=prepareHoverDrag();const before=w.serialize();start();move(0);hud.close();
  assert.equal(at(0),-600);assert.equal(at(1),0);assert.equal(hud.drag,null);assert.equal(hud.cardScales.size,0);assert.deepEqual(w.serialize(),before);
  hud.open();start();move(0);w.grantTestWeapon(9);hud.update(0);assert.equal(hud.drag,null);assert.equal(at(1),0);
  assert.equal(w.snapshot().backpack[0].weaponId,1);assert.equal(w.snapshot().backpack[1].weaponId,2);
});

test('refresh or a second finger opening a nested popup cancels the old drag before it can commit behind that popup',()=>{
  const {hud,w,start,move,end,at}=prepareHoverDrag();start();move(0);w.grantTestWeapon(9);hud.refresh();
  assert.equal(hud.drag,null);assert.equal(at(1),0);end(0);assert.equal(w.snapshot().backpack[0].weaponId,1);
  start();move(0);const before=w.serialize();hud.roots.get('collection').active=true;end(0);
  assert.equal(hud.drag,null);assert.equal(at(0),-600);assert.equal(at(1),0);assert.deepEqual(w.serialize(),before);
});

test('expiry during the final pointer update cancels the stale transaction even if the first release snapshot was current',()=>{
  const {hud,w,start,move,end}=prepareHoverDrag();start();move(0);
  const before=w.serialize(),snapshot=w.snapshot.bind(w);let reads=0;
  w.snapshot=()=>{if(++reads===2)w.configureTest({diamonds:123456});return snapshot();};
  end(0);assert.equal(hud.drag,null);assert.deepEqual(w.serialize().backpack,before.backpack);assert.equal(w.diamonds,123456);
});

test('a drop outside the bag settles into the nearest empty cell with lower-index tie breaking',()=>{
  const {hud,w,start,move,end}=prepareHoverDrag();
  hud.ui.node(hud.list.SlotTransforms[3]).setWorldPosition(100,800);
  hud.ui.node(hud.list.SlotTransforms[4]).setWorldPosition(300,800);
  start();move(200,800);end(200,800);assert.equal(w.snapshot().backpack[0],null);assert.equal(w.snapshot().backpack[3].weaponId,1);
});

test('dragging equipment over occupied backpack cards never previews an exchange and unloads to the first free cell',()=>{
  const {hud,w,cc,event,synchronize,at}=prepareHoverDrag();w.equip(0,1);synchronize();
  const source=hud.ui.node(hud.slots[1].node),origin=source.worldPosition.clone();
  source.emit(cc.Node.EventType.TOUCH_START,event(1,origin.x,origin.y));
  source.emit(cc.Node.EventType.TOUCH_MOVE,event(1,0,200));assert.equal(at(1),0);assert.equal(hud.drag.overlap,null);
  source.emit(cc.Node.EventType.TOUCH_CANCEL,event(1,0,200,cc.Input.EventType.TOUCH_END,cc.Node.EventType.TOUCH_CANCEL));
  assert.equal(w.snapshot().equipment[1],null);assert.equal(w.snapshot().backpack[0].weaponId,1);assert.equal(w.snapshot().backpack[1].weaponId,2);
  assert.equal(source.worldPosition.x,origin.x);assert.equal(source.worldPosition.y,origin.y);
});

test('last equipped gun drag uses the shared original localized alert without changing inventory or adding an error sound',()=>{
  const {hud,w,cc,event,alerts}=prepareHoverDrag(),before=w.serialize();
  const source=hud.ui.node(hud.slots[0].node),origin=source.worldPosition.clone(),sounds=[];hud.sound=id=>sounds.push(id);
  source.emit(cc.Node.EventType.TOUCH_START,event(1,origin.x,origin.y));
  source.emit(cc.Node.EventType.TOUCH_MOVE,event(1,0,200));
  source.emit(cc.Node.EventType.TOUCH_CANCEL,event(1,0,200,cc.Input.EventType.TOUCH_END,cc.Node.EventType.TOUCH_CANCEL));
  assert.deepEqual(w.serialize(),before);assert.deepEqual(alerts.calls,[{key:'Alarm/UnSelectError'}]);assert.deepEqual(sounds,[]);
  assert.equal(source.worldPosition.x,origin.x);assert.equal(hud.node.children.some(n=>n.name==='WeaponMessage'),false);
  hud.result({ok:false,reason:'backpackFull'});hud.result({ok:false,reason:'notEnoughGem'});hud.result({ok:false,reason:'adFailed'});
  assert.deepEqual(alerts.calls.slice(1),[{key:'Gun/InventoryFull'},{key:'StarUpgrade/NotEnoughGem'},{text:'广告加载失败。'}]);
});

test('the report lists all 65 current weapons with matching names, grades, damage, provenance and active special parameters',()=>{
  const report=fs.readFileSync(path.join(root,'docs/武器系统与特效说明.md'),'utf8');
  const rows=report.split(/\r?\n/).filter(line=>/^\| \d+ \|/.test(line)).map(line=>line.split('|').slice(1,-1).map(v=>v.trim()));
  assert.equal(rows.length,65);const legacy=require('./fixtures/legacy-weapon-data.json');const mechanisms={SINGLE:'单发',SHOTGUN:'霰弹',PIERCE:'条件穿透',LASER:'完全穿透狙击',EXPLOSIVE:'爆炸',MISSILE:'导弹',BLAST_SNIPER:'爆破狙击'};
  const readable=value=>Number(value.toPrecision(6));
  rows.forEach((row,id)=>{
    const weapon=catalog.getWeapon(id);assert.equal(Number(row[0]),id);assert.ok(row[1]);assert.equal(row[2],weapon.name);assert.equal(row[1],catalog.WEAPON_CATEGORY_NAMES[weapon.category]);assert.equal(Number(row[8]),weapon.sourceWeaponId);assert.equal(row[9],legacy[weapon.sourceWeaponId].name.trim());
    assert.equal(row[3],catalog.getWeaponGradeName(id));assert.equal(row[4],mechanisms[weapon.type]);
    assert.equal(DecimalAmount.from(row[5]).compare(weapon.damage),0);assert.equal(Number(row[6]),readable(weapon.attackInterval));
    const specials=row[7];
    if(weapon.type==='SHOTGUN'){assert.ok(specials.includes(`${weapon.pelletCount} 颗`));assert.ok(specials.includes(`±${readable(weapon.shotgunSpreadAngle)}°`));assert.ok(specials.includes('不穿透'));}
    if(weapon.type==='EXPLOSIVE')assert.ok(specials.includes(`爆炸半径 ${readable(weapon.explosionRadius)}`));
    if(weapon.type==='MISSILE'){assert.ok(specials.includes(`爆炸半径 ${readable(weapon.missileExplosionRadius)}`));assert.ok(specials.includes(`弹速 ${readable(weapon.missileSpeed)}`));}
    if(weapon.type==='BLAST_SNIPER')assert.ok(specials.includes(`首爆半径 ${readable(weapon.blastSniperExplosionRadius)}`));
    if(['LASER','PIERCE','BLAST_SNIPER'].includes(weapon.type))assert.ok(specials.includes(`寿命字段 ${readable(weapon.penetratingBulletLifetime)} 秒`));
  });
  assert.match(report,/level0:123082/);assert.match(report,/700\/箭/);assert.match(report,/600、0.4 秒/);assert.match(report,/catalogVersion: 4/);assert.doesNotMatch(report,/CURRENT_VISUAL_INDEX/);
});

test('the visual report maps every current weapon once to its active muzzle and projectile skin',()=>{
  const report=fs.readFileSync(path.join(root,'docs/武器系统与特效说明.md'),'utf8');
  const visuals=JSON.parse(fs.readFileSync(path.join(root,'assets/resources/art/weapon-system/visuals.json'),'utf8'));
  const rows=report.split(/\r?\n/).filter(line=>/^\| V\d{2} \|/.test(line)).map(line=>line.split('|').slice(1,-1).map(value=>value.trim()));
  assert.equal(rows.length,new Set(visuals.weapons.map(w=>w.projectileSkin)).size);const seenIds=new Set(),seenSkins=new Set();
  for(const [index,row] of rows.entries()){
    assert.equal(row[0],`V${String(index+1).padStart(2,'0')}`);assert.ok(row[4]);assert.ok(row[5]);
    const ids=row[1].split(',').map(Number),muzzles=new Map(row[2].split('；').map(pair=>pair.split('→')));
    assert.equal(muzzles.size,ids.length);assert.ok(!seenSkins.has(row[3]));seenSkins.add(row[3]);
    for(const id of ids){const weapon=visuals.weapons[id];assert.ok(weapon);assert.ok(!seenIds.has(id));seenIds.add(id);
      assert.equal(row[3],weapon.projectileSkin);assert.equal(muzzles.get(String(id)),weapon.muzzleSkin);}
  }
  assert.equal(seenIds.size,65);assert.deepEqual([...seenIds].sort((a,b)=>a-b),Array.from({length:65},(_,id)=>id));
  assert.deepEqual([...seenSkins].sort(),[...new Set(visuals.weapons.map(w=>w.projectileSkin))].sort());
  for(const key of seenSkins) assert.ok(visuals.projectileSkins[key],`missing impact profile ${key}`);
  for(const weapon of visuals.weapons){const definition=catalog.getWeapon(weapon.id);assert.ok(visuals.muzzleSkins[weapon.muzzleSkin]);
    if(!['handgun','cannon'].includes(definition.category)) assert.equal(weapon.muzzleSkin,'none');
  }
});


test('the historical report preserves all 65 original numeric rows as a separate migration baseline',()=>{
  const report=fs.readFileSync(path.join(root,'docs/原版65武器与历史验收.md'),'utf8'),legacy=require('./fixtures/legacy-weapon-data.json');
  const rows=report.split(/\r?\n/).filter(line=>/^\| \d+ \|/.test(line)).map(line=>line.split('|').slice(1,-1).map(v=>v.trim()));
  assert.equal(rows.length,legacy.length);rows.forEach((row,id)=>{assert.equal(Number(row[0]),id);assert.equal(row[2],legacy[id].name.trim());
    assert.equal(DecimalAmount.from(row[5]).compare(legacy[id].damage),0);assert.equal(Number(row[6]),Number(legacy[id].attackInterval.toPrecision(6)));});
});

test('WeaponHud binds all 65 grades to the existing backpack and equipment badge after empty-slot refreshes',()=>{
  const {hud}=harness(),roles=[...hud.backpack,...hud.slots];
  for(const id of Array.from({length:65},(_,i)=>i))for(const role of roles){
    const target=role.Degree_objs[0],node=hud.ui.node(target),spec=config.nodes[role.Degree_objs[catalog.getWeaponGrade(id)]];
    hud.updateRole(role,null);assert.equal(node.active,false);
    hud.updateRole(role,{weaponId:id,locked:false,pendingAd:false});assert.equal(node.active,true);
    assert.equal(hud.ui.texts.get(target),spec.text.value);
    assert.deepEqual(Array.from(hud.ui.tints.get(target)),spec.text.color);
    assert.deepEqual([node.position.x,node.position.y],spec.rect.position);
    assert.ok(role.Degree_objs.slice(1).every(key=>!hud.ui.get(key)));
  }
  hud.destroy();
});

test('backpack opens and supports drawing, merging and equipment before collection construction',async()=>{
  const driver=require('./support/ui-preparation.cjs').preparationDriver();
  const {hud,session}=harness('test',{},undefined,{collection:driver.prepare});
  await hud.prepared;
  assert.equal(hud.collectionReady,false);
  const authored=Object.keys(config.nodes).filter(id=>hud.ui.get(id));
  assert.equal(authored.length,595,'1702 collection nodes and 228 duplicate grade labels are absent from initial preparation');
  hud.open();assert.equal(hud.isOpen,true);assert.equal(hud.draw(),true);assert.equal(hud.draw(),true);
  hud.dismissNotice();hud.drop({kind:'backpack',index:0},{kind:'backpack',index:1});
  const merged=session.weapons.snapshot().backpack[1];assert.ok(merged);assert.ok(catalog.getWeaponGrade(merged.weaponId)>0);
  hud.dismissNotice();hud.drop({kind:'backpack',index:1},{kind:'equipment',index:1});
  assert.equal(session.weapons.snapshot().equipment[1].weaponId,merged.weaponId);
  hud.warmCollection();await hud.prepareCollectionAssets();assert.equal(driver.pending,1);
  driver.advance(100);assert.equal(hud.collectionReady,false);assert.equal(hud.isOpen,true);
  assert.equal(hud.collectionUi.node(config.roots.collection).active,false,'partial collection remains invisible');
  assert.equal(hud.getTutorialTargets().blocked,false,'background collection does not block the backpack');
  await driver.flush();await hud.collectionRequest;
  assert.equal(hud.collectionReady,true);assert.equal(hud.roots.get('collection').active,false);
  assert.equal(Object.keys(config.nodes).filter(id=>hud.collectionUi.get(id)).length,12+45*14,'only pooled cards and one grade label per card are built');
  const original=hud.roots.get('collection');hud.openCollection();assert.equal(original.active,true);
  hud.invoke(config.roots.collection,'SetActive',{m_BoolArgument:false});
  hud.openCollection();assert.equal(hud.roots.get('collection'),original,'reopening reuses the completed collection');
  hud.destroy();
});

test('early collection clicks join one build, resize safely and cannot reopen after closing the backpack',async()=>{
  const driver=require('./support/ui-preparation.cjs').preparationDriver();
  const {hud,session,alerts}=harness('test',{},undefined,{collection:driver.prepare});
  hud.open();hud.openCollection();hud.openCollection();await hud.prepareCollectionAssets();
  assert.equal(driver.pending,1);assert.equal(hud.preparingCollection,true);assert.equal(alerts.calls.length,1);
  driver.advance(100);hud.resize(390,844,25,20);hud.close();
  await driver.flush();await hud.collectionRequest;await Promise.resolve();
  assert.equal(hud.preparingCollection,false);assert.equal(hud.isOpen,false);
  assert.equal(hud.roots.get('collection').getComponent(hud.node.components.keys().next().value).width,1080);
  hud.open();session.weapons.grantTestWeapon(58);hud.openCollection();
  hud.collectionContent.setPosition(0,1868);hud.collectionScroll.onPositionChanged();
  const slot=hud.collectionPool.find(slot=>hud.collectionBindings.get(slot.target)===58);
  assert.equal(hud.collectionUi.node(slot.role.Locked_obj).active,false,'scrolling uses current collection ownership');
  hud.invoke(slot.target,'Touch',{});assert.equal(hud.detailId,58);assert.equal(hud.roots.get('detail').active,true);
  hud.destroy();
});

test('a pending collection leaves backpack dragging usable and cannot interrupt an accepted drop when it finishes',async()=>{
  const driver=require('./support/ui-preparation.cjs').preparationDriver();
  const {hud,w,source,cc,event}=prepareOutsideDrag({collection:driver.prepare});
  hud.openCollection();await hud.prepareCollectionAssets();
  assert.equal(hud.preparingCollection,true);assert.equal(hud.getTutorialTargets().blocked,false);
  const request=hud.collectionRequest;
  source.emit(cc.Node.EventType.TOUCH_START,event(7,-400,200,cc.Input.EventType.TOUCH_START));
  assert.ok(hud.drag,'the visible backpack accepts the next gesture without closing');
  assert.equal(hud.preparingCollection,false,'the new gesture supersedes the pending navigation');
  source.emit(cc.Node.EventType.TOUCH_MOVE,event(7,400,200));const drag=hud.drag;
  await driver.flush();await request;await Promise.resolve();hud.update(0);
  assert.equal(hud.collectionReady,true);assert.equal(hud.roots.get('collection').active,false);
  assert.equal(hud.drag,drag,'background completion cannot steal the pointer or open an overlay');
  source.emit(cc.Node.EventType.TOUCH_CANCEL,event(7,400,200,cc.Input.EventType.TOUCH_END));
  assert.equal(w.snapshot().equipment[2].weaponId,2);assert.equal(w.snapshot().backpack[0],null);
  hud.openCollection();assert.equal(hud.roots.get('collection').active,true,'the prepared collection remains reusable');hud.destroy();
});

test('drawing, weapon details and probability remain usable during a collection wait and cancel only its auto-open',async()=>{
  for(const action of ['draw','detail','probability']){
    const driver=require('./support/ui-preparation.cjs').preparationDriver();
    const {hud,session,press,release,synchronize}=harness('test',{},undefined,{collection:driver.prepare});
    hud.open();session.weapons.grantTestWeapon(2);synchronize();
    hud.openCollection();await hud.prepareCollectionAssets();const request=hud.collectionRequest;
    const diamonds=session.weapons.diamonds;
    const button=action==='draw'?'level0:802':action==='detail'?hud.backpack[0].node:
      Object.values(config.nodes).find(spec=>spec.button?.some(call=>call.method==='SetActive'&&call.target===config.roots.probability&&call.arguments.m_BoolArgument)).id;
    press(button);release(button);
    assert.equal(hud.preparingCollection,false,action);
    if(action==='draw')assert.equal(session.weapons.diamonds,diamonds-100);
    else assert.equal(hud.roots.get(action).active,true,action);
    assert.equal(hud.collectionRequest,request,'the shared preparation task is retained');
    await driver.flush();await request;await Promise.resolve();
    assert.equal(hud.roots.get('collection').active,false,action);assert.equal(hud.roots.get('inventory').active,true);
    if(action!=='draw')assert.equal(hud.roots.get(action).active,true,'completion must preserve the current popup');
    hud.destroy();
  }
});

test('lifecycle interaction cancellation prevents a collection wait from reopening on resume',async()=>{
  const driver=require('./support/ui-preparation.cjs').preparationDriver();
  const {hud}=harness('test',{},undefined,{collection:driver.prepare});
  hud.open();hud.openCollection();await hud.prepareCollectionAssets();
  hud.cancelInteractions();assert.equal(hud.preparingCollection,false);
  await driver.flush();await hud.collectionRequest;await Promise.resolve();
  assert.equal(hud.roots.get('inventory').active,true);assert.equal(hud.roots.get('collection').active,false);
  hud.openCollection();assert.equal(hud.roots.get('collection').active,true);hud.destroy();
});

test('a superseded collection failure does not replace feedback for the current backpack action and permits retry',async()=>{
  const driver=require('./support/ui-preparation.cjs').preparationDriver();let reject,loads=0;
  const {hud,alerts,press,release}=harness('test',{},undefined,{collection:driver.prepare,
    loadCollection:()=>++loads===1?new Promise((_,fail)=>{reject=fail;}):Promise.resolve()});
  hud.open();hud.openCollection();press('level0:802');release('level0:802');
  assert.equal(hud.preparingCollection,false);reject(Error('late unavailable collection'));await new Promise(setImmediate);
  assert.equal(alerts.calls.some(call=>call.text?.includes('图鉴准备失败')),false);
  hud.openCollection();await hud.prepareCollectionAssets();await driver.flush();await hud.collectionRequest;await Promise.resolve();
  assert.equal(loads,2);assert.equal(hud.roots.get('collection').active,true);hud.destroy();
});

test('collection failure is isolated, retriable and scene teardown never publishes a late panel',async()=>{
  const driver=require('./support/ui-preparation.cjs').preparationDriver();let attempts=0;
  const {hud,alerts}=harness('test',{},undefined,{collection:steps=>++attempts===1?Promise.reject(Error('construction failed')):driver.prepare(steps)});
  hud.open();hud.openCollection();await new Promise(setImmediate);
  assert.equal(hud.isOpen,true);assert.equal(hud.node.isValid,true);assert.equal(hud.preparingCollection,false);
  assert.match(alerts.calls.at(-1).text,/准备失败/);
  hud.openCollection();await Promise.resolve();driver.advance(20);
  const root=hud.collectionUi.get(config.roots.collection);hud.destroy();
  await driver.flush();await new Promise(setImmediate);
  assert.equal(root.isValid,false);assert.equal(hud.collectionReady,false);assert.equal(hud.node.isValid,false);
});


test('steady weapon frames reuse one snapshot and leave hidden collection cards untouched until opened', () => {
  const {hud, session, synchronize} = harness(); synchronize();
  let reads = 0, collectionPaints = 0;
  const snapshot = session.weapons.snapshot.bind(session.weapons), updateRole = hud.updateRole;
  session.weapons.snapshot = () => { reads++; return snapshot(); };
  hud.updateRole = function (role, ...rest) { if (this.collectionPool.some(slot=>slot.role===role)) collectionPaints++; return updateRole.call(this, role, ...rest); };
  hud.tutorialNeedsRefresh = true; hud.update(.01); assert.equal(reads, 1);
  session.weapons.grantTestWeapon(58); synchronize();
  assert.equal(collectionPaints, 0);
  hud.openCollection(); assert.equal(collectionPaints,35,'only first screen and the spare row refresh');
  collectionPaints = 0; reads = 0; hud.update(.01);
  assert.equal(reads, 1); assert.equal(collectionPaints, 0);
  hud.resize(720, 1600, 72, 36);
  assert.equal(collectionPaints,35, 'resize restores visible-card image fitting after layout');
});

test('scroll recycling preserves the pool, updates offscreen ownership and rejects a recycled pointer release',()=>{
  const {hud,session,cc,event}=harness();hud.open();hud.openCollection();
  const initialNodes=[...new Set(hud.collectionUi.nodes.values())],slot=hud.collectionPool[0],node=hud.collectionUi.node(slot.role.node);
  const first=hud.collectionBindings.get(slot.target),pressAt=node.worldPosition;
  node.emit(cc.Node.EventType.TOUCH_START,event(3,pressAt.x,pressAt.y));
  session.weapons.grantTestWeapon(58);
  hud.collectionContent.setPosition(0,1868);hud.collectionScroll.onPositionChanged();
  assert.deepEqual([...new Set(hud.collectionUi.nodes.values())],initialNodes,'a fling creates no additional nodes');
  assert.notEqual(hud.collectionBindings.get(slot.target),first,'the pressed node now represents a later weapon');
  const endAt=node.worldPosition;node.emit(cc.Node.EventType.TOUCH_END,event(3,endAt.x,endAt.y));
  assert.equal(hud.roots.get('detail').active,false,'release of the old card cannot open the recycled one');
  const owned=hud.collectionPool.find(slot=>hud.collectionBindings.get(slot.target)===58);
  assert.equal(hud.collectionUi.node(owned.role.Locked_obj).active,false);
  const ownedNode=hud.collectionUi.node(owned.role.node),at=ownedNode.worldPosition;
  ownedNode.emit(cc.Node.EventType.TOUCH_START,event(4,at.x,at.y));ownedNode.emit(cc.Node.EventType.TOUCH_END,event(4,at.x,at.y));
  assert.equal(hud.detailId,58,'a new tap opens the current weapon, independent of template order');
  hud.roots.get('detail').active=false;
  hud.collectionContent.setPosition(0,0);hud.collectionScroll.onPositionChanged();
  assert.equal(hud.collectionBindings.get(slot.target),first);
  assert.equal(hud.collectionPool.filter(slot=>hud.collectionUi.node(slot.role.node).active).length,35);
});

test('optional collection pool can be released and rebuilt while inventory remains available',async()=>{
  const driver=require('./support/ui-preparation.cjs').preparationDriver();
  const {hud}=harness('test',{},undefined,{collection:driver.prepare});
  hud.open();let warm=hud.warmCollection();await Promise.resolve();await driver.flush();await warm;
  const previous=hud.roots.get('collection'),previousNodes=[...hud.collectionPool].map(slot=>hud.collectionUi.node(slot.role.node));
  hud.releaseCollection();assert.equal(hud.collectionReady,false);assert.equal(hud.collectionPool.length,0);
  assert.equal(hud.collectionAssetsRequest,undefined);assert.equal(hud.assets.collectionImagesDeferred,true);
  assert.equal(previous.isValid,false);assert.ok(previousNodes.every(node=>!node.isValid));assert.equal(hud.roots.get('inventory').active,true);
  warm=hud.warmCollection();await Promise.resolve();await driver.flush();await warm;
  assert.equal(hud.collectionReady,true);assert.notEqual(hud.roots.get('collection'),previous);assert.equal(hud.collectionPool.length,45);
  hud.destroy();
});

test('explicit collection click promotes the registered module and joins its existing background work',async()=>{
  const driver=require('./support/ui-preparation.cjs').preparationDriver(),{hud}=harness('test',{},undefined,{collection:driver.prepare});
  const background=hud.warmCollection();await hud.prepareCollectionAssets();let promoted=0;
  hud.onCollectionRequested=()=>{promoted++;return hud.warmCollection();};
  hud.open();hud.openCollection();hud.openCollection();assert.equal(promoted,1);assert.equal(driver.pending,1);
  await driver.flush();await background;await Promise.resolve();
  assert.equal(hud.collectionReady,true);assert.equal(hud.roots.get('collection').active,true);hud.destroy();
});

test('release during collection preparation cancels only the old generation and permits retry',async()=>{
  const driver=require('./support/ui-preparation.cjs').preparationDriver();
  const {hud}=harness('test',{},undefined,{collection:driver.prepare});
  const first=hud.warmCollection().catch(error=>error);await hud.prepareCollectionAssets();driver.advance(80);hud.releaseCollection();
  const second=hud.warmCollection();await Promise.resolve();await driver.flush();await second;
  assert.match(String(await first),/cancelled/);assert.equal(hud.collectionReady,true);assert.equal(hud.collectionPool.length,45);
  hud.destroy();
});

test('collection asset readiness is separate, shared, retriable and reused by view preparation',async()=>{
  const driver=require('./support/ui-preparation.cjs').preparationDriver();let loads=0,resolve;
  const {hud}=harness('test',{},undefined,{collection:driver.prepare,loadCollection:()=>{
    if(++loads===1)return Promise.reject(Error('network'));
    return new Promise(done=>{resolve=done;});
  }});
  await assert.rejects(hud.prepareCollectionAssets(),/network/);
  const assets=hud.prepareCollectionAssets();assert.equal(hud.prepareCollectionAssets(),assets);resolve();await assets;
  assert.equal(loads,2);assert.equal(hud.collectionReady,false);assert.equal(hud.collectionPool.length,0);assert.equal(driver.pending,0);
  const warm=hud.warmCollection();await Promise.resolve();await driver.flush();await warm;
  assert.equal(loads,2);assert.equal(hud.collectionReady,true);assert.equal(hud.roots.get('collection').active,false);
  hud.destroy();
});
