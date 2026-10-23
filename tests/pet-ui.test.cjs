const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/pet-system/config.json');

// Real source renderer and skin HUD with lightweight Cocos primitives.
function harness(diamonds = 1000, presentation = false, contentState = { visible: true, unlocked: true }, load = file => require(`./.build/session/${file}.js`), prepare, releaseSpread = false) {
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
  const modules = { '../core/EconomyConfig':load('core/EconomyConfig'), '../session/PetSystem':load('session/PetSystem'), cc, './ArtLibrary': { makeNode }, './OriginalWeaponScroll': { OriginalWeaponScroll }, './SkinHudColorPipeline': { SkinHudColorPipeline } };
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'PetHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
      transformers: releaseSpread ? { before: [require('./support/loose-array-spread.cjs').looseArraySpread] } : undefined }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const { PetSystem, PET_DRAW_PRICE } = load('session/PetSystem');
  const pets = new PetSystem(), records = { sounds: [], visibility: [], moves: [], alerts: [], beforeOpen: 0 };
  const callbacks = {
    getState: () => pets.snapshot(diamonds), getContentState: () => contentState,
    getDailyAdState: () => ({visible:false,unlocked:false}), prepare:async()=>{},
    draw:currency=>{const r=pets.draw(currency,diamonds);if(r.ok&&currency==='diamonds')diamonds-=PET_DRAW_PRICE;return r;},
    move:(from,to,grade,vacancy)=>{records.moves.push([from,to]);return pets.move(from,to,grade,vacancy);},
    unequip:index=>pets.unequip(index),merge:(from,to,grade,auto)=>pets.merge(from,to,grade,auto),setAuto:value=>pets.setAuto(value),
    onBeforeOpen:()=>records.beforeOpen++,onVisibilityChanged:value=>records.visibility.push(value),
    alert:text=>records.alerts.push(text),playSfx:id=>records.sounds.push(id),
  };
  const hud = new modules['./PetHud'].PetHud(makeNode('Canvas'),art,{config,chineseFont:new Font(),originalFont:new Font(),numberFont:new Font()},callbacks,presentation?{}:undefined,undefined,prepare);
  const node=id=>hud.ui.node(id),emit=(target,type,id=1,at=target.worldPosition)=>target.events.get(type)?.({getID:()=>id,getUILocation:()=>at});
  const click=id=>{emit(node(id),'start');emit(node(id),'end');};
  return {hud,pets,callbacks,records,node,emit,click,UITransform,Label,Sprite,modules,art,makeNode,text:id=>node(id).getComponent(Label).string,state:()=>pets.snapshot(diamonds)};
}

test('pet inventory, equipment, detail and reward reuse grades without stale glyphs or changed styles',async()=>{
 const h=harness();await h.hud.prepared;h.hud.resize(1080,1920);
 const {assertPooledGrades}=require('./support/pooled-pet-grades.cjs');
 const playableGrades=h.modules['../session/PetSystem'].PET_CATALOG.length;
 assertPooledGrades(h,config,role=>!!role.Degree_objs,(role,grade)=>{
  if(grade<playableGrades)h.hud.paint(role,grade);
  else h.hud.gradeBadges.update(h.hud.ui,role.Degree_objs,grade); // Preserve the three unused authored grades too.
 },252);
 h.hud.destroy();
});

test('sliced pet preparation keeps every secondary root and input binding behind the ready promise',async()=>{
 const driver=require('./support/ui-preparation.cjs').preparationDriver(),h=harness(1000,false,undefined,undefined,driver.prepare);
 let ready=false;h.hud.prepared.then(()=>{ready=true;});driver.advance(20);await Promise.resolve();
 assert.equal(ready,false);assert.equal(h.hud.node.active,false);assert.equal(h.hud.initialized,false);
 await driver.flush();await h.hud.prepared;assert.equal(ready,true);assert.equal(h.hud.initialized,true);
 assert.equal(Object.keys(config.nodes).filter(id=>h.hud.ui.get(id)).length,412);
 for(const [name,id] of Object.entries(config.roots))assert.equal(h.hud.roots.get(name),h.node(id),name);
 for(const spec of Object.values(config.nodes))if(spec.button)assert.ok(h.node(spec.id).events.has('end'),spec.id);
 h.hud.open();h.hud.openDetail(0);assert.equal(h.hud.roots.get('detail').active,true);
 h.hud.destroy();
});

test('pet draw price and grade probabilities follow configuration in the real HUD',()=>{
 const load=require('./support/economy-modules.cjs').economyModules(c=>{c.pets={...c.pets,drawPrice:40,drawGrade:4};});
 const h=harness(80,false,{visible:true,unlocked:true},load);h.hud.open();h.hud.update(0);
 assert.equal(h.text('level0:411'),'40');assert.equal(h.text('level0:175'),'40');
 assert.equal(h.text('level0:9891'),'0%');assert.equal(h.text('level0:9862'),'100%');assert.equal(h.text('level0:185'),'S');
 h.click('level0:1326');assert.equal(h.state().diamonds,40);assert.equal(h.state().owned[0],4);
});

const fixtureSave=(owned=[],selected=[])=>({owned:[...owned,...Array(16-owned.length).fill(-1)],selected:[...selected,...Array(3-selected.length).fill(-1)],collected:Array(10).fill(false),coins:0,autoEnabled:false,lastDailyAdDate:''});

test('pet Auto button follows access changes without an inventory revision and cancels a pending merge',()=>{
  const h=harness();h.pets.restore(fixtureSave([0,0,1]));h.pets.setAuto(true);
  let available=false;h.callbacks.getState=()=>h.pets.snapshot(1000,'0','2026-10-15',available);
  h.hud.open();h.hud.update(.13);
  assert.equal(h.node(h.hud.manager.Auto_Btn_obj).active,false);assert.equal(h.hud.auto,null);
  const revision=h.state().revision;available=true;h.hud.update(.13);
  assert.equal(h.state().revision,revision);assert.equal(h.node(h.hud.manager.Auto_Btn_obj).active,true);assert.ok(h.hud.auto);
  available=false;h.hud.update(.3);
  assert.equal(h.node(h.hud.manager.Auto_Btn_obj).active,false);assert.equal(h.hud.auto,null);
  assert.deepEqual(h.state().owned.slice(0,3),[0,0,1]);
});

test('pet UI preserves original cards and all visible equipment content has nonzero rectangles',()=>{
 const h=harness();h.pets.restore(fixtureSave([0],[1]));h.hud.open();h.hud.update(0);
 const role=h.hud.selected[0];
 for(const key of [role.Selected_obj,role.Panel_img,role.Money_txt,role.MoveSpeed_txt]){const n=h.node(key),tr=n.getComponent(h.UITransform);assert.equal(n.active,true);assert.ok(tr.width>0&&tr.height>0,key);}
 assert.equal(h.hud.owned.length,16);assert.equal(h.hud.selected.length,3);
});
test('pet draw duplicate end and cancelled touch debit at most one price; coin shortage is inert',()=>{
 const h=harness();h.hud.open();h.click('level0:1100');assert.equal(h.state().diamonds,1000);
 h.emit(h.node('level0:1326'),'start');h.emit(h.node('level0:1326'),'end');h.emit(h.node('level0:1326'),'end');assert.equal(h.state().diamonds,900);
 h.hud.update(2.1);h.emit(h.node('level0:1326'),'start');h.emit(h.node('level0:1326'),'cancel');h.emit(h.node('level0:1326'),'end');assert.equal(h.state().diamonds,900);
});
test('pending pet equipment can be cancelled, failed or stale without moving either slot',async()=>{
 for(const outcome of ['close','cancel','failure','stale','success']){
  const h=harness();h.pets.restore(fixtureSave([0],[1]));h.hud.open();let resolve,reject;
  h.callbacks.prepare=()=>new Promise((yes,no)=>{resolve=yes;reject=no;});const before=h.state();
  const work=h.hud.movePrepared({kind:'owned',index:0},{kind:'selected',index:0},0,before);
  assert.deepEqual(h.state(),before);
  if(outcome==='close')h.hud.close();if(outcome==='cancel')h.hud.cancelInteractions();if(outcome==='stale')h.pets.setAuto(true);
  if(outcome==='failure')reject(Error('load'));else resolve();await work;
  assert.equal(h.state().selected[0],outcome==='success'?0:1,outcome);assert.equal(h.records.moves.length,outcome==='success'?1:0);
 }
});
test('auto motion cannot transact after close, drag, nested dialog or background cancellation',()=>{
 for(const cancel of [h=>h.hud.close(),h=>h.hud.cancelInteractions(),h=>h.hud.openDetail(0),h=>h.emit(h.node(h.hud.owned[0].node),'start')]){
  const h=harness();h.pets.restore(fixtureSave([0,0,1]));h.pets.setAuto(true);h.hud.open();h.hud.update(.13);const before=h.state();cancel(h);h.hud.update(0);
  assert.deepEqual(h.state().owned,before.owned);
 }
});

test('equipment drag to the backpack uses the first vacancy, and a full backpack keeps the equipment',()=>{
 for(const full of [false,true]){
  const h=harness();h.pets.restore(fixtureSave(full?Array(16).fill(2):[2,-1,3],[0]));h.hud.open();
  const n=h.node(h.hud.selected[0].node),p=h.node(h.hud.list.node).worldPosition;
  h.emit(n,'start');h.emit(n,'move',1,p);h.emit(n,'end',1,p);
  assert.equal(h.state().selected[0],full?0:-1);assert.equal(h.state().owned[1],full?2:0);
 }
});
test('backpack overlap uses shrunken rectangles, gives closest occupied slot priority and returns to nearest vacancy',()=>{
 const h=harness();h.pets.restore(fixtureSave([0,0,1]));h.hud.open();
 const n=h.node(h.hud.owned[0].node),target=h.node(h.hud.list.SlotTransforms[1]);
 h.emit(n,'start');h.emit(n,'move',1,target.worldPosition);
 assert.deepEqual(JSON.parse(JSON.stringify(h.hud.drag.target)),{kind:'owned',index:1});
 assert.equal(h.node(h.hud.owned[0].FusionAble_obj).active,true);assert.equal(h.node(h.hud.owned[1].FusionAble_obj).active,true);
 h.hud.update(.075);assert.ok(n.scale.x>1&&n.scale.x<1.05);h.hud.update(.08);assert.ok(Math.abs(n.scale.x-1.05)<1e-6);
 h.emit(n,'cancel');assert.deepEqual(h.state().owned.slice(0,3),[0,0,1]);assert.equal(n.scale.x,1);
});


test('closed pet HUD skips state reads and gold-only updates do not repaint cards or steady frames', () => {
  const h = harness(1000, true); let reads = 0, gold = '0';
  h.callbacks.getState = () => { reads++; return h.pets.snapshot(1000, gold); };
  for (let i = 0; i < 60; i++) h.hud.update(1 / 60);
  assert.equal(reads, 0);
  h.hud.open(); h.hud.update(0); h.hud.colors.beforeDraw();
  let paints = 0; const paint = h.hud.paint;
  h.hud.paint = function (...args) { paints++; return paint.apply(this, args); };
  gold = '123'; h.hud.update(1 / 60);
  assert.equal(h.text('level0:9850'), '123'); assert.equal(paints, 0);
  assert.equal(h.hud.colors.beforeDraw(), true, 'changed wallet is presented');
  h.hud.update(1 / 60); assert.equal(h.hud.colors.beforeDraw(), false);
  h.emit(h.node('level0:1326'), 'start'); h.hud.update(.04); assert.equal(h.hud.colors.beforeDraw(), true);
  h.emit(h.node('level0:1326'), 'cancel'); h.hud.update(.2);
  assert.equal(h.hud.colors.beforeDraw(), true, 'the final release frame must be presented');
  assert.equal(h.node('level0:1326').scale.x, 1);
  h.hud.update(.2); assert.equal(h.hud.colors.beforeDraw(), false);
});

test('pet drag presents every move after press and equipment highlight animations settle', () => {
  for (const destination of ['backpack', 'equipment']) {
    const h = harness(1000, true); h.pets.restore(fixtureSave([0])); h.hud.open();
    const source = h.node(h.hud.owned[0].node), origin = source.worldPosition.clone();
    const at = destination === 'equipment' ? h.node(h.hud.selected[0].node).worldPosition.clone() : origin.clone();
    h.hud.update(0); h.hud.colors.beforeDraw();
    h.emit(source, 'start'); h.hud.update(.2); h.hud.colors.beforeDraw();
    h.emit(source, 'move', 1, { x: at.x + 10, y: at.y + 10 });
    h.hud.update(.2); h.hud.colors.beforeDraw();
    h.hud.update(0); assert.equal(h.hud.colors.beforeDraw(), false, 'stationary drag can keep its cached frame');
    for (let step = 1; step <= 3; step++) {
      const point = { x: at.x + 10 + step * 2, y: at.y + 10 };
      h.emit(source, 'move', 1, point); h.hud.update(1 / 60);
      assert.equal(source.worldPosition.x, point.x);
      assert.equal(h.hud.colors.beforeDraw(), true, `${destination}: move ${step} must reach the displayed frame`);
    }
    h.hud.destroy();
  }
});

test('pet drag cancellation, no-op release and pending equipment present the restored card', async () => {
  for (const outcome of ['cancel', 'same-slot', 'equipment']) {
    const h = harness(1000, true); h.pets.restore(fixtureSave([0])); h.hud.open();
    const source = h.node(h.hud.owned[0].node), origin = source.worldPosition.clone();
    let reject; h.callbacks.prepare = () => new Promise((resolve, fail) => { reject = fail; });
    const at = outcome === 'equipment' ? h.node(h.hud.selected[0].node).worldPosition.clone() : { x: origin.x + 20, y: origin.y + 20 };
    h.emit(source, 'start'); h.emit(source, 'move', 1, at); h.hud.update(.2);
    h.hud.colors.invalidate(); h.hud.colors.beforeDraw();
    h.hud.update(0); assert.equal(h.hud.colors.beforeDraw(), false);
    h.emit(source, outcome === 'cancel' ? 'cancel' : 'end', 1, at); h.hud.update(0);
    assert.equal(source.worldPosition.x, origin.x); assert.equal(source.worldPosition.y, origin.y);
    assert.equal(h.hud.colors.beforeDraw(), true, `${outcome}: restored position must be visible even without a transaction`);
    assert.equal(source.scale.x, 1); assert.equal(h.state().owned[0], 0); assert.equal(h.state().selected[0], -1);
    if (reject) { reject(Error('load')); await Promise.resolve(); }
    h.hud.update(.2); assert.equal(h.hud.colors.beforeDraw(), false, 'settled HUD returns to cached rendering');
    h.hud.destroy();
  }
});


test('dispatched pets show source locks and cannot be dragged or used as drop targets',()=>{
 const h=harness();h.pets.restore(fixtureSave([0,0,1],[2]));h.pets.setLocks([{kind:'owned',index:0},{kind:'selected',index:0}]);h.hud.open();h.hud.update(0);
 assert.equal(h.node(h.hud.owned[0].Lock_obj).active,true);assert.equal(h.node(h.hud.selected[0].Lock_obj).active,true);
 h.emit(h.node(h.hud.owned[0].node),'start');assert.equal(h.hud.drag,null);h.emit(h.node(h.hud.selected[0].node),'start');assert.equal(h.hud.drag,null);
 const moving=h.node(h.hud.owned[1].node),locked=h.node(h.hud.list.SlotTransforms[0]);h.emit(moving,'start');h.emit(moving,'move',1,locked.worldPosition);assert.notEqual(h.hud.drag?.target?.index,0);h.emit(moving,'cancel');
 h.pets.setLocks([]);h.hud.update(0);assert.equal(h.node(h.hud.owned[0].Lock_obj).active,false);
});

test('release build drag highlights leave the previous target when crossing several cards',()=>{
 const h=harness(1000,false,undefined,undefined,undefined,true);h.pets.restore(fixtureSave([0,0,0]));h.hud.open();
 const n=h.node(h.hud.owned[0].node),b=h.node(h.hud.owned[1].node),c=h.node(h.hud.owned[2].node);
 h.emit(n,'start');h.emit(n,'move',1,b.worldPosition);h.hud.update(.16);assert.ok(b.scale.x>1);
 h.emit(n,'move',1,c.worldPosition);h.hud.update(.16);
 assert.equal(b.scale.x,1,'old target must return to its original size');assert.ok(c.scale.x>1);
 h.emit(n,'end',1,c.worldPosition);assert.deepEqual(h.state().owned.slice(0,3),[-1,0,1]);
});

test('pet entry blocking cancels only its held pointer and never revives a cancelled open',()=>{
 const h=harness(),entry=h.node(config.roots.entry);
 h.emit(entry,'start');h.hud.setEntryBlocked(true);h.hud.setEntryBlocked(false);h.emit(entry,'end');assert.equal(h.hud.isOpen,false);
 h.hud.open();const draw=h.node('level0:1326');h.emit(draw,'start');
 for(let i=0;i<8;i++){h.hud.setEntryBlocked(true);h.hud.update(1/60);}
 h.emit(draw,'end');assert.equal(h.state().diamonds,900);assert.equal(h.state().owned[0],0);
 h.hud.update(2.1);assert.equal(h.hud.roots.get('newPet').active,false);
 h.click('level0:1100');assert.equal(h.state().diamonds,900,'insufficient pet coins do not spend diamonds');
});
