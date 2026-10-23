const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/fish-system/config.json');

// Real source fish renderer and gameplay system with lightweight Cocos primitives.
function harness(diamonds = 1000, presentation = false, contentState = { visible: true, unlocked: true }, load = file => require(`./.build/session/${file}.js`)) {
  const atlases = [], borrowedFrames = [], bitmapFrames = [];
  class Vec3 {
    constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
    clone() { return new Vec3(this.x, this.y, this.z); }
    set(x,y,z=0) { Object.assign(this,{x,y,z}); }
    static distance(a,b) { return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z); }
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
    setPosition(x, y, z = 0) { this.position = typeof x==='object' ? x.clone() : new Vec3(x, y, z); }
    setScale(x, y, z = 1) { this.scale = new Vec3(x, y, z); }
    on(event, callback) { this.events.set(event, callback); }
    destroy() { this.destroyed = true; }
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
  const modules = { '../core/EconomyConfig':load('core/EconomyConfig'), '../session/FishSystem':load('session/FishSystem'), '../core/DecimalAmount':load('core/DecimalAmount'), cc, './ArtLibrary': { makeNode }, './OriginalWeaponScroll': { OriginalWeaponScroll }, './SkinHudColorPipeline': { SkinHudColorPipeline } };
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'FishHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const { FishSystem, FISH_DRAW_PRICE } = load('session/FishSystem');
  const fish = new FishSystem(), records = { sounds: [], visibility: [], merges: [], deletes: [], alerts: [], beforeOpen: 0 };
  const today = '2026-10-15';
  const callbacks = {
    getState: () => fish.snapshot(diamonds,today), getContentState: () => contentState,
    getDailyAdState: () => ({visible:false,unlocked:false}),
    draw:kind=>{const r=fish.draw(kind,diamonds,today,()=>0);if(r.ok&&kind==='diamonds')diamonds-=FISH_DRAW_PRICE;return r;},
    merge:(from,to,grade,auto,revision)=>{records.merges.push([from,to,grade,auto,revision]);return fish.merge(from,to,grade,auto,revision);},
    remove:(index,grade,revision)=>{records.deletes.push([index,grade,revision]);return fish.remove(index,grade,revision);},
    setAuto:value=>fish.setAuto(value),
    onBeforeOpen:()=>records.beforeOpen++,onVisibilityChanged:value=>records.visibility.push(value),
    alert:text=>records.alerts.push(text),playSfx:id=>records.sounds.push(id),
  };
  const hud = new modules['./FishHud'].FishHud(makeNode('Canvas'),art,{config,chineseFont:new Font(),originalFont:new Font(),numberFont:new Font()},callbacks,presentation?{}:undefined);
  const node=id=>hud.ui.node(id),emit=(target,type,id=1,at=target.worldPosition)=>target.events.get(type)?.({getID:()=>id,getUILocation:()=>at});
  const click=id=>{emit(node(id),'start');emit(node(id),'end');};
  // Cocos selects the frontmost active node with an input listener. A graphic
  // alone cannot stop a sibling dismiss button underneath its empty regions.
  const screenClick=point=>{
    const hit=current=>{
      if(!current.active)return null;
      for(let i=current.children.length-1;i>=0;i--){const child=hit(current.children[i]);if(child)return child;}
      if(!current.events.has('start')&&!current.getComponent(cc.BlockInputEvents))return null;
      return current.getComponent(UITransform)?.getBoundingBoxToWorld().contains(point)?current:null;
    };
    const target=hit(hud.node);if(target){emit(target,'start',1,point);emit(target,'end',1,point);}return target;
  };
  return {hud,fish,callbacks,records,node,emit,click,screenClick,UITransform,Vec3,text:id=>node(id).getComponent(Label).string,state:()=>fish.snapshot(diamonds,today)};
}

const fixtureSave=(inventory=[])=>({inventory,collected:Array(13).fill(false),autoEnabled:false,freeDrawDate:'',freeDrawCount:0});
const restore=(h,inventory)=>{h.fish.restore(fixtureSave(inventory));h.hud.open();h.hud.update(0);};
const view=(h,index)=>h.hud.fishes.find(item=>item.index===index);

test('fish Auto button follows access changes without an inventory revision and cancels a pending merge',()=>{
  const h=harness();h.fish.restore(fixtureSave([0,0,1]));h.fish.setAuto(true);
  let available=false;h.callbacks.getState=()=>h.fish.snapshot(1000,'2026-10-15',available);
  h.hud.open();h.hud.update(.2);
  assert.equal(h.node(h.hud.manager.Auto_Btn_obj).active,false);assert.equal(h.hud.automatic,null);
  const revision=h.state().revision;available=true;h.hud.update(0);
  assert.equal(h.state().revision,revision);assert.equal(h.node(h.hud.manager.Auto_Btn_obj).active,true);
  h.hud.cancelInteractions();view(h,0).node.setPosition(-200,0);view(h,1).node.setPosition(200,0);
  h.hud.update(.2);assert.ok(h.hud.automatic);
  available=false;h.hud.update(.4);
  assert.equal(h.node(h.hud.manager.Auto_Btn_obj).active,false);assert.equal(h.hud.automatic,null);
  assert.deepEqual(h.state().inventory,[0,0,1]);assert.equal(h.records.merges.length,0);
});

test('empty fish tank and modal panel clicks intercept their background dismiss buttons',()=>{
  for(const presentation of [false,true]) {
    const h=harness(1000,presentation);h.hud.open();
    const tank=h.node(h.hud.tank.node);
    assert.equal(h.screenClick(tank.worldPosition),tank);
    assert.equal(h.hud.isOpen,true);
    const panel=h.node('level0:4812'),p=panel.worldPosition;
    h.screenClick(new h.Vec3(p.x-500,p.y+350));assert.equal(h.hud.isOpen,true);
    for(const [name,id] of [['detail','level0:19549'],['delete','level0:1174'],['drawInfo','level0:2487']]) {
      const modal=h.hud.roots.get(name);modal.active=true;
      const node=h.node(id),tr=node.getComponent(h.UITransform),at=node.worldPosition;
      const point=new h.Vec3(at.x-tr.width*.4,at.y-tr.height*.3);
      assert.equal(h.screenClick(point),node,name);
      assert.equal(modal.active,true,name);assert.equal(h.hud.isOpen,true,name);
      modal.active=false;
    }
    const background=h.node('level0:5488'),tr=h.hud.roots.get('main').getComponent(h.UITransform);
    assert.equal(h.screenClick(new h.Vec3(0,tr.height/2-20)),background);
    assert.equal(h.hud.isOpen,false,'outside the authored panel still dismisses');
  }
});

test('fish HUD price, probability table, free count and actual draw use the same economy configuration',()=>{
  const load=require('./support/economy-modules.cjs').economyModules(c=>{
    c.fish.drawPrice=40;c.fish.noAdDrawsPerDay=2;c.fish.drawGradePercents=[0,100,0,0];
  });
  const h=harness(80,false,{visible:true,unlocked:true},load);h.hud.open();
  assert.equal(h.text(h.hud.drawButton.Price_txt),'40');
  assert.equal(h.text(h.hud.manager.AD_Gacha_Count_txt),'x2');
  assert.equal(h.text('level0:14161'),'100%');assert.equal(h.text('level0:15847'),'100%');
  h.click('level0:5940');assert.deepEqual(h.state().inventory,[2]);assert.equal(h.state().diamonds,40);
});

test('fish HUD preserves native fish sizes, outline borders and all thirteen detail grades',()=>{
  const h=harness();restore(h,[0,12]);
  const first=view(h,0),last=view(h,1);
  assert.equal(h.hud.fishes.length,20);
  assert.equal(first.node.getComponent(h.UITransform).width,115);
  assert.equal(last.node.getComponent(h.UITransform).width,290);
  const skin=h.node(last.role.skinImage),outline=h.node(last.role.FusionAlert_img);
  assert.equal(skin.getComponent(h.UITransform).width,290);
  assert.equal(outline.getComponent(h.UITransform).width,303);
  assert.equal(h.hud.roots.get('newFish').parent,h.hud.roots.get('main'));
  h.hud.openDetail(12);
  assert.equal(h.node(h.hud.detail.Degree_objs[12]).active,true);
  assert.equal(h.node(h.hud.detail.RightBtn_obj).active,false);
  assert.equal(h.hud.roots.get('detail').getComponent(h.UITransform).width,1080);
});

test('fish drag uses ellipse overlap, merges at its target and preserves unaffected fish positions',()=>{
  const h=harness();restore(h,[0,0,2]);
  const from=view(h,0),to=view(h,1),other=view(h,2);
  from.node.setPosition(-180,0);to.node.setPosition(120,30);other.node.setPosition(260,-180);
  const expected=to.node.position.clone(),untouched=other.node.position.clone();
  h.emit(from.node,'start');h.emit(from.node,'move',1,to.node.worldPosition);
  assert.equal(h.hud.drag.target,to);
  assert.equal(h.node(from.role.FusionAlert_img).active,true);
  h.emit(from.node,'end',1,to.node.worldPosition);
  assert.deepEqual(h.state().inventory,[2,1]);
  assert.deepEqual(view(h,1).node.position,expected);
  assert.deepEqual(view(h,0).node.position,untouched);
  assert.equal(h.hud.roots.get('newFish').active,true);
  assert.equal(h.records.merges.length,1);
  h.emit(from.node,'end');assert.equal(h.records.merges.length,1);
});

test('fish delete drag requires confirmation, cancellation preserves inventory and stale confirmation cannot delete',()=>{
  for(const finish of ['cancel','confirm','stale','close']) {
    const h=harness();restore(h,[0,1]);const fish=view(h,0),zone=h.node(h.hud.deleteZone.node);
    h.emit(fish.node,'start');h.emit(fish.node,'move',1,zone.worldPosition);h.emit(fish.node,'end',1,zone.worldPosition);
    assert.equal(h.hud.roots.get('delete').active,true);
    assert.deepEqual(h.state().inventory,[0,1]);
    if(finish==='cancel')h.click('level0:1053');
    if(finish==='close')h.hud.close();
    if(finish==='stale')h.fish.setAuto(true);
    if(finish==='confirm'||finish==='stale')h.click('level0:1431');
    assert.deepEqual(h.state().inventory,finish==='confirm'?[1]:[0,1],finish);
    assert.equal(h.hud.roots.get('delete').active,false);
    assert.equal(h.hud.pendingDelete,null);
  }
});

test('fish cancelled drag, foreign pointer and revision change never merge',()=>{
  for(const outcome of ['cancel','revision','foreign']) {
    const h=harness();restore(h,[0,0]);const from=view(h,0),to=view(h,1);
    from.node.setPosition(-100,0);to.node.setPosition(100,0);const original=from.node.position.clone();
    h.emit(from.node,'start',7);h.emit(from.node,'move',7,to.node.worldPosition);
    if(outcome==='revision')h.fish.setAuto(true);
    h.emit(from.node,outcome==='cancel'?'cancel':'end',outcome==='foreign'?8:7,to.node.worldPosition);
    assert.deepEqual(h.state().inventory,[0,0]);assert.equal(h.records.merges.length,0);
    if(outcome==='foreign')h.emit(from.node,'cancel',7);
    assert.deepEqual(from.node.position,original);
  }
});

test('second-finger draw cancels both unfinished and completed fish press scaling without a stale release',()=>{
  for(const elapsed of [.04,.08])for(const moved of [false,true]) {
    const h=harness();restore(h,[0,0]);const fish=view(h,0),target=view(h,1);
    fish.node.setPosition(-150,0);target.node.setPosition(150,0);const original=fish.node.position.clone();
    h.emit(fish.node,'start',7);h.hud.update(elapsed);
    assert.ok(fish.node.scale.x<1,'press has actually shrunk the fish');
    if(moved)h.emit(fish.node,'move',7,target.node.worldPosition);
    const button=h.node('level0:5940');h.emit(button,'start',8);h.emit(button,'end',8);
    assert.equal(h.hud.drag,null);assert.equal(fish.node.scale.x,1);assert.equal(fish.node.scale.y,1);
    assert.equal(h.hud.scales.has(fish),false);assert.equal(h.hud.bounces.has(fish),false);
    assert.deepEqual(fish.node.position,original);
    assert.equal(h.node(fish.role.FusionAlert_img).active,false);assert.equal(h.node(target.role.FusionAlert_img).active,false);
    assert.equal(h.node(h.hud.deleteZone.node).active,false);
    h.emit(fish.node,'end',7);h.hud.update(.2);
    assert.equal(fish.node.scale.x,1);assert.equal(h.hud.roots.get('detail').active,false);
    assert.deepEqual(h.state().inventory,[0,0,1]);assert.equal(h.records.merges.length,0);
  }
});

test('every fish drag cancellation restores position, scale and motion ownership immediately',()=>{
  const cancellations={
    pointer:h=>h.emit(view(h,0).node,'cancel',7),
    background:h=>h.hud.cancelInteractions(),
    close:h=>h.hud.close(),
    detail:h=>h.hud.openDetail(0),
    resize:h=>h.hud.resize(1080,1920),
    staleEnd:h=>{h.fish.setAuto(true);h.emit(view(h,0).node,'end',7);},
    staleRefresh:h=>{h.fish.setAuto(true);h.hud.refresh();},
  };
  for(const [name,cancel] of Object.entries(cancellations)) {
    const h=harness();restore(h,[0]);const fish=view(h,0),original=fish.node.position.clone();
    h.emit(fish.node,'start',7);h.hud.update(.08);assert.ok(fish.node.scale.x<1);
    cancel(h);
    assert.equal(h.hud.drag,null,name);assert.equal(fish.node.scale.x,1,name);assert.equal(fish.node.scale.y,1,name);
    assert.deepEqual(fish.node.position,original,name);assert.equal(h.hud.scales.has(fish),false,name);
    assert.equal(h.hud.bounces.has(fish),false,name);assert.equal(h.node(h.hud.deleteZone.node).active,false,name);
    assert.deepEqual(h.state().inventory,[0],name);
  }
});

test('fish auto merge moves a pair and is cancelled by modal, close and background cancellation',()=>{
  for(const mode of ['complete','detail','close','cancel']) {
    const h=harness();h.fish.restore(fixtureSave([0,0,1]));h.fish.setAuto(true);h.hud.open();
    view(h,0).node.setPosition(-200,0);view(h,1).node.setPosition(200,0);
    h.hud.update(.2);assert.ok(h.hud.automatic);
    if(mode==='detail')h.hud.openDetail(0);
    if(mode==='close')h.hud.close();
    if(mode==='cancel')h.hud.cancelInteractions();
    h.hud.update(mode==='complete'?.4:0);
    assert.deepEqual(h.state().inventory,mode==='complete'?[1,1]:[0,0,1]);
    assert.equal(h.records.merges.length,mode==='complete'?1:0);
  }
});

test('fish render order matches native rounded height plus grade offset and mover overrides',()=>{
  const h=harness();restore(h,[0,12,2]);const low=view(h,0),high=view(h,1),middle=view(h,2);
  for(const fish of [low,high,middle])fish.node.setPosition(0,0);
  h.hud.sortFish();
  assert.ok(high.node.getSiblingIndex()<middle.node.getSiblingIndex());
  assert.ok(middle.node.getSiblingIndex()<low.node.getSiblingIndex());
  for(const [y,expected] of [[298.5,2],[297.5,2],[300.5,0],[301.5,0],[3000,0],[-3000,2000]]) {
    high.node.setPosition(0,y);assert.equal(h.hud.sortOrder(high),expected);
  }
  high.node.setPosition(0,0);h.hud.drag={fish:high};h.hud.sortFish();
  assert.equal(high.node.getSiblingIndex(),high.node.parent.children.length-1);
  h.hud.drag=null;h.hud.automatic={from:high};h.hud.sortFish();
  assert.equal(high.node.getSiblingIndex(),high.node.parent.children.length-1);
});

test('manual fish fusion selects the first eligible fixed pool entry even when another fish is nearer',()=>{
  const h=harness();restore(h,[0,0,0]);const first=view(h,0),near=view(h,1),dragged=view(h,2);
  first.node.setPosition(60,0);near.node.setPosition(10,0);dragged.node.setPosition(0,0);
  assert.equal(h.hud.fusionTarget(dragged),first);
  h.hud.automatic={from:first,to:first};assert.equal(h.hud.fusionTarget(dragged),near);
  near.node.active=false;assert.equal(h.hud.fusionTarget(dragged),null);
});

test('auto fish fusion uses fixed pool second to first after delete and reuse, at the first fish position',()=>{
  const h=harness();restore(h,[0,0,1,1]);const removed=view(h,0);
  h.hud.pendingDelete={fish:removed,index:0,grade:0,revision:h.state().revision};h.hud.confirmDelete();
  h.hud.draw('free');
  const first=h.hud.fishes[0],second=h.hud.fishes[1];
  assert.equal(first.index,3);assert.equal(second.index,0);
  first.node.setPosition(-200,40);second.node.setPosition(200,40);const expected=first.node.position.clone();
  h.fish.setAuto(true);h.hud.refresh();h.hud.updateAuto(.16);
  assert.equal(h.hud.automatic.from,second);assert.equal(h.hud.automatic.to,first);
  h.hud.updateAuto(.4);
  assert.deepEqual(h.records.merges[0].slice(0,4),[0,3,0,true]);
  assert.deepEqual(view(h,2).node.position,expected);
});

test('fish inspection and deletion are silent; only successful draw, merge and premium shortage play native sounds',()=>{
  const h=harness();restore(h,[0,0]);let fish=view(h,0);
  h.emit(fish.node,'start');h.emit(fish.node,'end');assert.deepEqual(h.records.sounds,[]);
  h.hud.roots.get('detail').active=false;
  h.hud.pendingDelete={fish,index:0,grade:0,revision:h.state().revision};h.hud.confirmDelete();
  assert.deepEqual(h.records.sounds,[]);
  h.hud.draw('free');assert.deepEqual(h.records.sounds,[2]);
  h.hud.merge(view(h,0),view(h,1),false,h.state().revision);assert.deepEqual(h.records.sounds,[2,3]);
  const poor=harness(0);poor.hud.open();poor.hud.draw('diamonds');assert.deepEqual(poor.records.sounds,[5]);
  const full=harness();restore(full,Array(20).fill(0));full.hud.draw('diamonds');full.hud.draw('free');
  assert.deepEqual(full.records.sounds,[]);
});

test('fish free quota hides unavailable ads, repeated premium draws replay the source animation, and drawing is single shot',()=>{
  const h=harness();h.hud.open();
  assert.equal(h.text(h.hud.manager.All_CriPer_txt),'0%');
  assert.equal(h.text(h.hud.manager.All_CriVal_txt),'125%');
  assert.equal(h.text(h.hud.manager.AD_Gacha_Count_txt),'x3');
  for(let i=0;i<3;i++)h.click('level0:1474');
  assert.equal(h.state().freeWithoutAdRemaining,0);
  assert.equal(h.node(h.hud.manager.AD_Gacha_Btn_obj).active,false);
  assert.equal(h.state().inventory.length,3);
  h.click('level0:5940');assert.equal(h.state().diamonds,800);
  h.emit(h.node('level0:5940'),'end');assert.equal(h.state().diamonds,800);
  h.hud.update(1.84);assert.equal(h.hud.roots.get('newFish').active,false);
  h.click('level0:5940');assert.equal(h.hud.roots.get('newFish').active,true);
  h.hud.update(.5);assert.ok(Math.abs(h.hud.roots.get('newFish').scale.x-1)<1e-5);
  assert.ok(Math.abs(h.node('level0:31276').angle+45)<1e-5);
});

test('fish swimming stays inside the tank and resizing preserves native size and entry position',()=>{
  const h=harness();restore(h,[12]);const fish=view(h,0);
  for(let i=0;i<60;i++)h.hud.update(.5);
  const bounded=h.hud.clamp(fish,fish.node.position);
  assert.deepEqual(bounded,fish.node.position);
  h.hud.resize(540,960);
  assert.equal(fish.node.getComponent(h.UITransform).width,290);
  assert.equal(h.hud.roots.get('entry').position.y,-960+605);
  assert.ok(Number.isFinite(fish.node.position.x)&&Number.isFinite(fish.node.position.y));
});

test('fish HUD cancels pending ad presentation on close and ignores old or duplicate completion',()=>{
  for(const outcome of ['close','success','cancel','failure']) {
    const h=harness(1000,true);h.fish.restore({...fixtureSave(),freeDrawDate:'2026-10-15',freeDrawCount:3});
    h.callbacks.getDailyAdState=()=>({visible:true,unlocked:true});
    let complete,settlements=0,cancels=0;
    h.callbacks.beginAd=()=>({ok:true,token:'fish-token'});
    h.callbacks.completeAd=(_token,result)=>{settlements++;return result==='success'?h.fish.draw('free',1000,'2026-10-15',()=>0,true):{ok:false,reason:result};};
    h.callbacks.cancelAd=()=>cancels++;
    h.hud.rewardedAds={showRewardedAd:(_token,placement,callback)=>{assert.equal(placement,'fish-daily');complete=callback;},cancelRewardedAd:()=>{}};
    h.hud.open();h.click('level0:1474');assert.equal(h.hud.adToken,'fish-token');
    if(outcome==='close')h.hud.close();
    complete(outcome==='close'?'success':outcome);complete('success');
    assert.equal(h.state().inventory.length,outcome==='success'?1:0,outcome);
    assert.equal(settlements,outcome==='close'?0:1);
    assert.equal(cancels,outcome==='close'?1:0);
    assert.equal(h.hud.adToken,null);
  }
});

