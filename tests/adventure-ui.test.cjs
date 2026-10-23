const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/adventure-system/config.json');

// Real source renderer and skin HUD with lightweight Cocos primitives.
function harness(contentState = { visible: true, unlocked: true }, prepare) {
  const cache=new Map();
  function load(file){if(cache.has(file))return cache.get(file);const module={exports:{}};cache.set(file,module.exports);const filename=path.join(root,'assets/scripts',file+'.ts'),source=fs.readFileSync(filename,'utf8');vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{module,exports:module.exports,console,require:key=>load(path.posix.normalize(path.posix.join(path.posix.dirname(file),key)))});return module.exports;}
  const atlases = [], borrowedFrames = [], bitmapFrames = [];
  class Vec3 {
    constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
    clone() { return new Vec3(this.x, this.y, this.z); }
  }
  class UITransform {
    width = 0; height = 0; anchorX = .5; anchorY = .5;
    setContentSize(width, height) { Object.assign(this, { width, height }); }
    setAnchorPoint(anchorX, anchorY) { Object.assign(this, { anchorX, anchorY }); }
    convertToNodeSpaceAR(at) { const p = this.node.worldPosition, s = this.node.worldScale; return new Vec3((at.x - p.x) / s.x, (at.y - p.y) / s.y); }
    getBoundingBoxToWorld() {
      const p = this.node.worldPosition, s = this.node.worldScale;
      const x = p.x - this.width * this.anchorX * s.x, y = p.y - this.height * this.anchorY * s.y;
      return { contains: at => at.x >= x && at.y >= y && at.x <= x + this.width * s.x && at.y <= y + this.height * s.y };
    }
  }
  class Node {
    static EventType = { TOUCH_START: 'start', TOUCH_END: 'end', TOUCH_CANCEL: 'cancel', TOUCH_MOVE: 'move', MOUSE_ENTER: 'enter', MOUSE_LEAVE: 'leave' };
    constructor(name) { Object.assign(this, { name, layer: 1 << 25, children: [], components: new Map(), events: new Map(), active: true, position: new Vec3(), scale: new Vec3(1, 1, 1) }); }
    addChild(node) { node.parent = this; this.children.push(node); }
    addComponent(Type) { const value = new Type(); value.node = this; this.components.set(Type, value); return value; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y, z = 0) { this.position = new Vec3(x, y, z); }
    setScale(x, y, z = 1) { this.scale = new Vec3(x, y, z); }
    on(event, callback) { this.events.set(event, callback); }
    destroy() { this.destroyed = true; }
    get isValid() { return !this.destroyed; }
    setSiblingIndex(index) { const siblings = this.parent?.children; if (!siblings) return; siblings.splice(siblings.indexOf(this), 1); siblings.splice(index, 0, this); }
    getSiblingIndex() {return this.parent.children.indexOf(this);}
    setWorldPosition(x,y,z=0) {const p=typeof x==='object'?x:new Vec3(x,y,z),at=this.parent?.worldPosition||new Vec3(),s=this.parent?.worldScale||new Vec3(1,1,1);this.setPosition((p.x-at.x)/s.x,(p.y-at.y)/s.y,(p.z-at.z)/s.z);}
    get worldScale() { const p = this.parent?.worldScale || new Vec3(1, 1, 1); return new Vec3(this.scale.x * p.x, this.scale.y * p.y, this.scale.z * p.z); }
    get worldPosition() { const p = this.parent?.worldPosition || new Vec3(), s = this.parent?.worldScale || new Vec3(1, 1, 1); return new Vec3(p.x + this.position.x * s.x, p.y + this.position.y * s.y, p.z + this.position.z * s.z); }
  }
  class Color { static WHITE = new Color(255, 255, 255, 255); constructor(r, g, b, a) { Object.assign(this, { r, g, b, a }); } }
  class Graphics { clear() { this.lastRect = null; } rect(x, y, width, height) { this.lastRect = { x, y, width, height }; } fill() {} }
  class Label { static HorizontalAlign = { LEFT: 0, RIGHT: 1, CENTER: 2 }; static VerticalAlign = { TOP: 0, BOTTOM: 1, CENTER: 2 }; static Overflow = { SHRINK: 0, CLAMP: 1 }; }
  class Sprite { static SizeMode = { CUSTOM: 0 }; static Type = { SLICED: 0, TILED: 1, SIMPLE: 2 }; }
  class SpriteAtlas {
    spriteFrames = {}; destroyCalls = 0;
    constructor() { atlases.push(this); }
    destroy() { this.destroyCalls++; }
  }
  class SpriteFrame {
    destroyCalls = 0;
    constructor() { bitmapFrames.push(this); }
    reset(value) { Object.assign(this, value); }
    destroy() { this.destroyCalls++; }
  }
  class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
  class Size { constructor(width, height) { Object.assign(this, { width, height }); } }
  class Mask { static Type = { GRAPHICS_RECT: 0 }; }
  class Font {}
  class RichText {}
  class LabelOutline {}
  class LabelShadow {}
  const cc = { Node, Vec3, Vec2: Vec3, UITransform, Color, Graphics, Label, Sprite, SpriteAtlas, SpriteFrame, Rect, Size, Mask, Font, RichText,
    LabelOutline, LabelShadow, BlockInputEvents: class {}, resources: {} };
  const makeNode = (name, parent) => { const node = new Node(name); node.layer = parent?.layer ?? node.layer; node.addComponent(UITransform); if (parent) parent.addChild(node); return node; };
  const paths = [...Object.values(config.images).map(image => image.path), ...Object.values(config.bitmapFonts).flatMap(font => font.pages)];
  const art = { frames: new Map(paths.map(path => {
    const frame = { texture: { path }, destroyCalls: 0, destroy() { this.destroyCalls++; } }; borrowedFrames.push(frame); return [path, frame];
  })), image: (name, spec, parent) => makeNode(name, parent) };
  class OriginalWeaponScroll {
    stops = 0;
    configure(source) { this.source = source; }
    stopAutoScroll() { this.stops++; }
  }
  class SkinHudColorPipeline {
    materials = {}; pending = true; active = false; renders = 0;
    constructor(owner) { this.content = makeNode('CachedSkin', owner); this.content.active = false; }
    setActive(active) { if (active !== this.active) this.invalidate(); this.active = this.content.active = active; }
    invalidate() { this.pending = true; }
    setInvalidationSource(predicate) { this.predicate = predicate; }
    *bindInputSteps() { this.bindInput(); yield; }
    bindInput() {}
    resize() { this.invalidate(); }
    destroy() { this.active = false; }
    beforeDraw() {
      if (!this.active) return false;
      const changed = this.predicate?.();
      if (!this.pending && !changed) return false;
      this.pending = false; this.renders++; return true;
    }
  }
  class AdventureCamp { resize(){} setGrades(grades){this.grades=grades;} update(){} destroy(){} }
  const modules = { './AdventureCamp':{AdventureCamp},'./PetView':{},'../session/AdventureSystem':load('session/AdventureSystem'), '../core/EconomyConfig':load('core/EconomyConfig'), '../session/PetSystem':load('session/PetSystem'), cc, './ArtLibrary': { makeNode }, './OriginalWeaponScroll': { OriginalWeaponScroll }, './SkinHudColorPipeline': { SkinHudColorPipeline } };
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'AdventureHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }

  const {AdventureSystem}=load('session/AdventureSystem'),{RelicSystem}=load('session/RelicSystem'),{PetSystem}=load('session/PetSystem');
  const pets=new PetSystem(),adventure=new AdventureSystem(),relics=new RelicSystem(),now={value:new Date(2026,9,18,12).getTime()};
  pets.restore({...pets.serialize(),selected:[0,-1,-1]});
  const calls={start:0,cancel:0,claim:0,draw:0,alerts:[]};
  const callbacks={getState:()=>adventure.snapshot(pets.serialize(),now.value),getPetState:()=>pets.snapshot(1000),getRelicState:()=>relics.snapshot(adventure.cores),getContentState:()=>contentState,getAdState:()=>({visible:false,unlocked:false}),
   preview:(type,index,refs)=>adventure.preview(type,index,refs,pets.serialize(),now.value),
   start:(type,index,refs)=>{calls.start++;return adventure.start(type,index,refs,pets.serialize(),now.value);},
   cancel:(type,index)=>{calls.cancel++;return adventure.cancel(type,index);},claim:(type,index)=>{calls.claim++;return adventure.claim(type,index,now.value);},
   drawRelic:(core,max)=>{calls.draw++;return relics.draw(core,max?Math.floor(adventure.cores[core]/20):1,adventure,()=>0);},upgradeRelic:index=>relics.upgrade(index),alert:text=>calls.alerts.push(text)};
  const hud=new modules['./AdventureHud'].AdventureHud(makeNode('Canvas'),art,{config,chineseFont:new Font(),originalFont:new Font(),numberFont:new Font(),petVisuals:{}},callbacks,undefined,undefined,prepare);
  const node=id=>hud.ui.node(id),emit=(target,type,id=1,at=target.worldPosition)=>target.events.get(type)?.({getID:()=>id,getUILocation:()=>at}),click=id=>{emit(node(id),'start');emit(node(id),'end');};
  return {hud,pets,adventure,relics,now,calls,node,click,emit,UITransform,Label,Sprite,modules,art,makeNode,callbacks,text:id=>node(id).getComponent(Label).string};
}

test('travel reuses all 22 pet grade labels with exact atlas styles through forward, reverse and empty states', async()=>{
 const h=harness();await h.hud.prepared;h.hud.resize(1080,1920);
 const {assertPooledGrades}=require('./support/pooled-pet-grades.cjs');
 assertPooledGrades(h,config,role=>role.type==='Pet_Item_Demo',(role,grade)=>h.hud.paintPet(role,grade),264);
 h.hud.destroy();
});

test('travel group layout skips overwritten passes without changing any final geometry at safe-area sizes', async()=>{
 const h=harness(),reference=harness();await Promise.all([h.hud.prepared,reference.hud.prepared]);
 const initial=reference.hud.ui.layoutSteps;
 reference.hud.ui.layoutSteps=function*(...args){yield* initial.call(this,...args.slice(0,5));};
 const snapshot=h=>Object.keys(config.nodes).filter(id=>h.hud.ui.get(id)).map(id=>{
  const node=h.node(id),tr=node.getComponent(h.UITransform);
  return [id,node.position.x,node.position.y,tr.width,tr.height,tr.anchorX,tr.anchorY];
 });
 for(const [width,height,top,bottom] of [[360,640,0,0],[393,852,47,34],[430,932,59,34],[720,1280,0,0]]){
  h.hud.resize(width,height,top,bottom);reference.hud.resize(width,height,top,bottom);
  assert.deepEqual(snapshot(h),snapshot(reference),`${width}x${height} final child geometry`);
 }
 const original=h.hud.ui.layoutSteps,steps={optimized:0,reference:0};
 h.hud.ui.layoutSteps=function*(...args){for(const step of original.call(this,...args)){steps.optimized++;yield step;}};
 reference.hud.ui.layoutSteps=function*(...args){for(const step of initial.call(this,...args.slice(0,5))){steps.reference++;yield step;}};
 h.hud.resize(393,852,47,34);reference.hud.resize(393,852,47,34);
 assert.ok(steps.reference-steps.optimized>1000,`skips repeated subtree layout: ${steps.reference} -> ${steps.optimized}`);
 h.hud.destroy();reference.hud.destroy();
});

test('sliced travel preparation still completes every main and secondary root before ready',async()=>{
 const driver=require('./support/ui-preparation.cjs').preparationDriver(),h=harness(undefined,driver.prepare);
 let ready=false;h.hud.prepared.then(()=>{ready=true;});driver.advance(20);await Promise.resolve();
 assert.equal(ready,false);assert.equal(h.hud.node.active,false);assert.equal(h.hud.initialized,false);
 await driver.flush();await h.hud.prepared;assert.equal(ready,true);assert.equal(h.hud.initialized,true);
 assert.equal(Object.keys(config.nodes).filter(id=>h.hud.ui.get(id)).length,1449);
 for(const [name,id] of Object.entries(config.roots))assert.equal(h.hud.roots.get(name),h.node(id),name);
 for(const spec of Object.values(config.nodes))if(spec.button)assert.ok(h.node(spec.id).events.has('end'),spec.id);
 h.hud.open();for(const name of ['mapList','enter','petSelect','exit','reward','relicInfo','relicDraw']){h.hud.openPopup(name);assert.equal(h.hud.roots.get(name).active,true);h.hud.roots.get(name).active=false;}
 h.hud.destroy();
});

test('original adventure assets preserve all nine roots, three maps, fifteen abilities and nineteen camp puppets',()=>{
 assert.deepEqual(Object.keys(config.roots),['entry','main','mapList','enter','petSelect','exit','reward','relicInfo','relicDraw']);
 assert.equal(config.camp.pets.length,19);assert.ok(config.camp.pets.every(pet=>pet.length===10));assert.equal(config.coreSprites.length,4);
 assert.equal(Object.values(config.roles).filter(r=>r.type==='Relic_Item').length,15);
 const seen=new Set();for(const id of Object.values(config.roots)){const walk=id=>{assert.ok(config.nodes[id],id);assert.ok(!seen.has(id),id);seen.add(id);config.nodes[id].children.forEach(walk);};walk(id);}
 for(const id of ['level0:1380','level0:874','level0:236','level0:1473'])assert.ok(!config.nodes[id]);
 for(const [id,node] of Object.entries(config.nodes))if(node.image?.sprite)assert.ok(config.images[node.image.sprite],id);
 for(const key of ['s447','s398','s766','s352'])assert.equal(config.images[key],undefined);
 assert.ok(fs.existsSync(path.join(root,'assets/resources/art/raid-system/images/s447.png')));
 for(const key of ['s398','s766','s352'])assert.equal(fs.existsSync(path.join(root,'assets/resources/art/adventure-system/images',key+'.png')),false);
 for(const image of Object.values(config.images))assert.ok(fs.existsSync(path.join(root,'assets/resources',image.path+'.png')),image.path);
 for(const font of Object.values(config.bitmapFonts))for(const page of font.pages)assert.ok(fs.existsSync(path.join(root,'assets/resources',page+'.png')),page);
 for(const basis of config.camp.cameraBasis)assert.ok(Math.abs(Math.hypot(...basis)-1)<1e-5);
 for(const role of Object.values(config.roles))for(const field of ['Damage_Balance','Money_Balance','CriDmg_Balance','Ticket_Now','AD_Reduce_UseCount'])assert.equal(role[field],undefined);
});

test('real travel HUD builds, resizes and opens every authored popup with original references',async()=>{
 const h=harness();await h.hud.prepared;h.hud.resize(1080,1920);h.hud.open();assert.equal(h.hud.isOpen,true);
 for(const name of ['mapList','enter','petSelect','exit','relicInfo']){if(name==='relicInfo')h.hud.detailIndex=0;h.hud.openPopup(name);h.hud.update(.016);h.hud.roots.get(name).active=false;}
 h.hud.resize(1080,2400);h.hud.resize(1080,1600);assert.equal(h.node(config.roots.entry).position.y,-800+855);h.hud.close();h.hud.destroy();
});

test('million travel balances remain complete on one line inside actual HUD text boxes',async()=>{
 const h=harness();await h.hud.prepared;h.adventure.ensureResourceFloor(1000000,1000000);
 const role=type=>Object.values(config.roles).find(role=>role.type===type);
 const cores=role('Currency_Core').Core_txt_list,tickets=role('Adventure_Ticket_UI').Count_txt,relic=role('Relic_DownPanel').Count_txt;
 const fits=(id,value)=>{
  const node=h.node(id),box=node.getComponent(h.UITransform),glyphs=node.children.filter(child=>child.active&&child.name==='OriginalGlyph');
  assert.equal(h.text(id),value,`${id}: the complete balance is shown`);
  assert.equal(glyphs.length,value.length,`${id}: every character retains its authored glyph`);
  let previousLeft=-Infinity;
  for(const glyph of glyphs){
   const tr=glyph.getComponent(h.UITransform),left=glyph.position.x-tr.anchorX*tr.width,right=left+tr.width;
   const bottom=glyph.position.y-tr.anchorY*tr.height,top=bottom+tr.height;
   assert.ok(left>previousLeft,`${id}: glyphs stay on one line without wrapping`);previousLeft=left;
   assert.ok(left>=-box.anchorX*box.width-.001&&right<=(1-box.anchorX)*box.width+.001,`${id}: glyph fits the text width`);
   assert.ok(bottom>=-box.anchorY*box.height-.001&&top<=(1-box.anchorY)*box.height+.001,`${id}: glyph fits the text height`);
  }
 };
 for(const [width,height] of [[390,844],[360,640]]){
  h.hud.resize(width,height);h.hud.open();cores.forEach(id=>fits(id,'1000000'));fits(tickets[0],'1000000/20');
  h.hud.openPopup('mapList');h.hud.openEnter(0);fits(tickets[1],'1000000/20');
  h.hud.roots.get('enter').active=false;h.hud.roots.get('mapList').active=false;
  h.hud.tab=1;h.hud.refresh();fits(relic,'1000000');
 }
 h.hud.destroy();
});

test('travel dispatch click is atomic, cancellation unlocks, and hidden dialogs reject duplicate end',async()=>{
 const h=harness();await h.hud.prepared;h.hud.open();h.hud.openPopup('mapList');h.hud.openEnter(0);
 assert.equal(h.hud.selected.length,1);const button=Object.values(config.nodes).find(n=>n.button?.some(a=>a.method==='OnClick_AdventureStart'));
 h.click(button.id);h.emit(h.node(button.id),'end');assert.equal(h.calls.start,1);assert.equal(h.adventure.snapshot(h.pets.serialize(),h.now.value).maps[0].status,'running');
 h.hud.currentIndex=0;h.hud.openPopup('exit');h.hud.update(1);const cancel=Object.values(config.nodes).find(n=>n.button?.some(a=>a.method==='Cancel'));h.click(cancel.id);assert.equal(h.calls.cancel,1);assert.equal(h.adventure.snapshot(h.pets.serialize(),h.now.value).maps[0].status,'available');
});

for(const initiallyBlocked of [false,true])for(const action of ['close','dispatch'])test(`travel ${action} completes across modal-sync frames when entry blocking ${initiallyBlocked?'stays enabled':'becomes enabled'}`,async()=>{
 const h=harness();await h.hud.prepared;h.hud.open();
 if(action==='dispatch'){h.hud.openPopup('mapList');h.hud.openEnter(0);}
 h.hud.update(1);h.hud.setEntryBlocked(initiallyBlocked);
 const spec=Object.values(config.nodes).find(n=>n.button?.some(a=>action==='dispatch'
  ?a.method==='OnClick_AdventureStart'
  :n.name==='Close_Btn'&&a.method==='SetActive'&&a.target===config.roots.main&&!a.arguments.m_BoolArgument));
 assert.ok(spec,`${action} uses an authored visible button`);
 const button=h.node(spec.id);h.emit(button,'start',7);
 // GameBootstrap updates the active HUD, then blocks menu entries every frame.
 // An open panel's held pointer must survive both repeated true and false -> true.
 for(let frame=0;frame<3;frame++){h.hud.update(1/60);h.hud.setEntryBlocked(true);}
 h.emit(button,'end',7);
 if(action==='close')assert.equal(h.hud.isOpen,false,'the close button receives the matching release');
 else {
  assert.equal(h.calls.start,1,'dispatch receives one matching release across frames');
  assert.equal(h.adventure.snapshot(h.pets.serialize(),h.now.value).maps[0].status,'running');
  h.emit(button,'end',7);assert.equal(h.calls.start,1,'a repeated release cannot dispatch again');
 }
 h.hud.destroy();
});

test('entry blocking cancels its held pointer and cannot revive it after unblocking',async()=>{
 const h=harness();await h.hud.prepared;const entry=h.node(config.roots.entry);
 h.hud.setEntryBlocked(false);h.emit(entry,'start',11);h.hud.update(.05);
 assert.equal(h.hud.touches.has(entry),true);
 for(let frame=0;frame<3;frame++){h.hud.setEntryBlocked(true);h.hud.update(1/60);}
 assert.equal(h.hud.touches.has(entry),false,'blocking discards the covered entry pointer');
 h.click(config.roots.entry);assert.equal(h.hud.isOpen,false,'covered entries reject new presses');
 h.hud.setEntryBlocked(false);h.emit(entry,'end',11);
 assert.equal(h.hud.isOpen,false,'a late old release cannot open the panel');
 h.click(config.roots.entry);assert.equal(h.hud.isOpen,true,'a new press works after unblocking');
 h.hud.destroy();
});

test('reward and multi-draw reveal waits gate close and keep twelve original cards per page',async()=>{
 const h=harness();await h.hud.prepared;h.hud.open();h.adventure.start(0,0,[{kind:'selected',index:0}],h.pets.serialize(),h.now.value);h.now.value+=24*3600000;h.hud.claim(0);
 assert.equal(h.node(h.hud.reward.Exit_obj).active,false);h.hud.update(20);assert.equal(h.node(h.hud.reward.Exit_obj).active,true);
 h.hud.drawItems=Array.from({length:13},()=>({index:0,isNew:false,count:1}));h.hud.drawTime=0;h.hud.drawPage=0;h.hud.openPopup('relicDraw');h.hud.paintDraw();assert.equal(h.node(h.hud.relicDraw.Close_Btn).active,false);
 h.hud.update(2);assert.equal(h.hud.drawPage,1);assert.equal(h.node(h.hud.relicDraw.Left_Btn).active,true);h.hud.paintDraw();assert.equal(h.hud.relicDraw.Relic_Item_obj_List.filter(id=>h.node(id).active).length,1);
});



test('travel loader passes deduplicated string paths after non-iterable spread downlevel compilation',async()=>{
 const module={exports:{}},source=fs.readFileSync(path.join(root,'assets/scripts/view/AdventureHud.ts'),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES5,downlevelIteration:false}}).outputText;
 const modules={cc:{Font:class{}},'./ResourceBatch':{loadResourceBatch:tasks=>Promise.all(tasks.map(task=>task()))}};
 vm.runInNewContext(compiled,{module,exports:module.exports,require:key=>modules[key]??{}});
 const paths=[],art={json:async()=>config,loadFrame:async path=>{assert.equal(typeof path,'string');assert.ok(path.length>0);paths.push(path);}};
 await module.exports.loadAdventureHudAssets(art,{});
 const expected=Array.from(new Set(Object.values(config.images).map(image=>image.path).concat(Object.values(config.bitmapFonts).flatMap(font=>font.pages)))).sort();
 assert.deepEqual(paths.sort(),expected);
});


test('Unity-driven map rows and all three grids use their parent geometry rather than stale bottom anchors',async()=>{
 const h=harness();await h.hud.prepared;
 for(const [width,height] of [[360,640],[393,852],[430,932]]){
  h.hud.resize(width,height);h.hud.open();h.hud.openPopup('mapList');h.hud.update(1);
  const panel=h.node('level0:1384'),pt=panel.getComponent(h.UITransform),scale=panel.worldScale;
  for(const role of h.hud.panel.Adventure_Map_Info_list){const n=h.node(config.roles[role].node),tr=n.getComponent(h.UITransform);assert.ok(n.worldPosition.y+tr.height*scale.y/2<=panel.worldPosition.y+pt.height*scale.y/2);assert.ok(n.worldPosition.y-tr.height*scale.y/2>=panel.worldPosition.y-pt.height*scale.y/2);}
  const button=h.node('level0:16966').worldPosition;assert.ok(width/2+button.x>0&&width/2+button.x<width);assert.ok(height/2-button.y>0&&height/2-button.y<height);
  for(const key of ['level0:1112','level0:872','level0:719']){const group=h.node(key),tr=group.getComponent(h.UITransform);for(const id of config.nodes[key].children){const n=h.node(id),rect=n.getComponent(h.UITransform);assert.ok(n.position.y+rect.height*(1-rect.anchorY)<=tr.height*(1-tr.anchorY)+.01,id);assert.ok(n.position.y-rect.height*rect.anchorY>=-tr.height*tr.anchorY-.01,id);}}
  assert.equal(h.hud.ui.get('level0:236'),undefined);h.hud.close();
 }
});


test('actual ability card demo button opens its list item and draw demos cannot open details',async()=>{
 const h=harness();await h.hud.prepared;h.adventure.grantCores(0,20);h.relics.draw(0,1,h.adventure,()=>0);h.hud.open();h.hud.tab=1;h.hud.refresh();
 const item=config.roles[h.hud.relicManager.Relic_Item_List[0]],demo=config.roles[item.relic_item_demo];assert.ok(config.nodes[demo.node].button);h.click(demo.node);assert.equal(h.hud.detailIndex,0);assert.equal(h.hud.roots.get('relicInfo').active,true);
 h.hud.roots.get('relicInfo').active=false;h.hud.detailIndex=null;h.hud.drawItems=[{index:0,isNew:false,count:0}];h.hud.drawTime=Infinity;h.hud.openPopup('relicDraw');h.hud.paintDraw();h.hud.update(1);h.click(config.roles[h.hud.relicDraw.Relic_Item_Single].node);assert.equal(h.hud.detailIndex,null);assert.equal(h.hud.roots.get('relicInfo').active,false);
});
