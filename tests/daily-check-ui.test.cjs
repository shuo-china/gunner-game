const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/daily-check-system/config.json');
const ids = config.dailyCheckUi;

function harness(options = {}) {
  const borrowed = [], glyphs = [], pipelines = [], loads = [];
  class Vec3 {
    constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
    clone() { return new Vec3(this.x, this.y, this.z); }
  }
  class UITransform {
    width = 0; height = 0; anchorX = .5; anchorY = .5;
    setContentSize(width, height) { Object.assign(this, { width, height }); }
    setAnchorPoint(anchorX, anchorY) { Object.assign(this, { anchorX, anchorY }); }
    convertToNodeSpaceAR(p) { const at = this.node.worldPosition, s = this.node.worldScale; return new Vec3((p.x - at.x) / s.x, (p.y - at.y) / s.y); }
  }
  class Node {
    static EventType = { TOUCH_START: 'start', TOUCH_END: 'end', TOUCH_CANCEL: 'cancel', MOUSE_ENTER: 'enter', MOUSE_LEAVE: 'leave' };
    constructor(name) { Object.assign(this, { name, layer: 1 << 25, isValid: true, children: [], components: new Map(), events: new Map(), active: true, position: new Vec3(), scale: new Vec3(1, 1, 1) }); }
    get parent() { return this._parent; }
    set parent(value) { if (this._parent) { const old = this._parent.children.indexOf(this); if (old >= 0) this._parent.children.splice(old, 1); } this._parent = value; if (value && !value.children.includes(this)) value.children.push(this); }
    addChild(node) { node.parent = this; }
    setSiblingIndex(index) { const a = this.parent.children; a.splice(a.indexOf(this), 1); a.splice(index, 0, this); }
    addComponent(Type) { const value = new Type(); value.node = this; this.components.set(Type, value); return value; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y, z = 0) { this.position = new Vec3(x, y, z); }
    setScale(x, y, z = 1) { this.scale = typeof x === "object" ? x.clone() : new Vec3(x, y, z); }
    on(type, callback) { this.events.set(type, callback); }
    destroy() { this.isValid = false; this.destroyed = true; }
    get worldScale() { const p = this.parent?.worldScale || new Vec3(1, 1, 1); return new Vec3(this.scale.x * p.x, this.scale.y * p.y, this.scale.z * p.z); }
    get worldPosition() { const p = this.parent?.worldPosition || new Vec3(), s = this.parent?.worldScale || new Vec3(1, 1, 1); return new Vec3(p.x + this.position.x * s.x, p.y + this.position.y * s.y); }
  }
  class Color { constructor(r, g, b, a) { Object.assign(this, { r, g, b, a }); } }
  class Graphics { clear() {} rect() {} fill() {} }
  class Label { static HorizontalAlign = { LEFT: 0, RIGHT: 1, CENTER: 2 }; static VerticalAlign = { TOP: 0, BOTTOM: 1, CENTER: 2 }; static Overflow = { SHRINK: 0, CLAMP: 1 }; }
  class Sprite { static SizeMode = { CUSTOM: 0 }; static Type = { SLICED: 0, TILED: 1, SIMPLE: 2 }; }
  class SpriteAtlas { spriteFrames = {}; destroy() {} }
  class SpriteFrame { constructor() { this.destroyCalls = 0; glyphs.push(this); } reset(value) { Object.assign(this, value); } destroy() { this.destroyCalls++; } }
  class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
  class Size { constructor(width, height) { Object.assign(this, { width, height }); } }
  class Mask { static Type = { GRAPHICS_RECT: 0 }; }
  class Font {}
  class RichText {}
  class LabelOutline {}
  class LabelShadow {}
  class BlockInputEvents {}
  const cc = { Node, Vec3, Vec2: Vec3, UITransform, Color, Graphics, Label, Sprite, SpriteAtlas, SpriteFrame, Rect, Size, Mask, Font, RichText, LabelOutline, LabelShadow, BlockInputEvents };
  const makeNode = (name, parent) => { const node = new Node(name); node.layer = parent?.layer ?? node.layer; node.addComponent(UITransform); if (parent) parent.addChild(node); return node; };
  class SkinHudColorPipeline {
    materials = { sprite: {}, graphics: {}, layer: 1 << 16 }; active = false; dirty = false; invalidations = 0;
    constructor(owner) { pipelines.push(this); this.content = makeNode('DailyLinear', owner); this.content.layer = 1 << 16; }
    setActive(value) { this.active = this.content.active = value; }
    invalidate() { this.dirty = true; this.invalidations++; }
    resize() { this.invalidate(); }
    *bindInputSteps() { this.bindInput(); yield; }
    bindInput() {}
    destroy() { this.destroyed = true; this.destroyCalls = (this.destroyCalls || 0) + 1; }
  }

  const entryConfig = require('../assets/resources/art/feature-entries/dailyCheck.json');
  const imagePaths = [...Object.values(config.images).map(image => image.path), ...Object.values(config.bitmapFonts).flatMap(font => font.pages)];
  const art = { frames: new Map(imagePaths.map(p => { const frame = { texture: { path: p }, destroyCalls: 0, destroy() { this.destroyCalls++; } }; borrowed.push(frame); return [p, frame]; })),
    image: (name, spec, parent) => makeNode(name, parent),
    json: async p => p === 'art/daily-check-system/config' ? config : p === 'art/feature-entries/dailyCheck' ? entryConfig : assert.fail(p),
    loadFrame: async p => { loads.push(p); if (options.failLoad) throw Error('daily asset failure'); } };
  const modules = { cc, './ArtLibrary': { makeNode }, './SkinHudColorPipeline': { SkinHudColorPipeline } };
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'OriginalDiamondAttraction', 'DailyCheckHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
      { module, exports: module.exports, setTimeout: callback => callback(), require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const state = { checkNum: 0, totalCheckNum: 0, lastClaimDay: '', today: '2026-10-16', canClaim: true, blocked: false,
    days: [140,400,800,1200,1600,2000,3000].map((diamonds,dayIndex) => ({diamonds,dayIndex,status:dayIndex?'normal':'getable'})) };
  const records = { claims: [], sounds: [], visibility: [], alerts: [], entryClicks: 0 }, wallet = {money:'12.5K',diamonds:42};
  const canvas = makeNode('Canvas'), fallback = makeNode('MainDiamond',canvas); fallback.setPosition(300,600);
  const callbacks = { getState: () => state, getWallet: () => wallet, getFallbackDiamondTarget: () => fallback,
    claim: index => { records.claims.push(index); if (options.failure) return {ok:false,reason:options.failure};
      if (state.days[index].status !== 'getable') return {ok:false,reason:'notClaimable'};
      state.days[index].status='geted'; state.canClaim=false; state.checkNum++; state.totalCheckNum++; wallet.diamonds+=state.days[index].diamonds;
      return {ok:true,dayIndex:index,diamonds:state.days[index].diamonds}; },
    playSfx: value => records.sounds.push(value), onVisibilityChanged: value => records.visibility.push(value),alert:value=>records.alerts.push(value) };
  const assets = { config, chineseFont: null, originalFont: new Font(), numberFont: new Font() };
  const hud = new modules['./DailyCheckHud'].DailyCheckHud(canvas,art,assets,callbacks,options.presentation?{}:undefined,options.prepare);
  const entry = new modules['./DailyCheckHud'].DailyCheckEntry(canvas,art,{...assets,config:entryConfig},()=>records.entryClicks++,id=>records.sounds.push(id));
  const node = id => hud.ui.node(ids[id] ?? id);
  const emit = (id, type, pointer = 1, position, originalType = type, owner = hud) => {
    const target = owner.ui.node(ids[id] ?? id), event = { getID: () => pointer, getUILocation: () => position ?? target.worldPosition, getEventCode: () => originalType };
    target.events.get(type)?.(event); return event;
  };
  const click = id => { emit(id,'start'); emit(id,'end'); };
  return {hud,entry,art,assets,state,wallet,records,modules,callbacks,node,emit,click,UITransform,Label,Sprite,BlockInputEvents,
    makeNode,borrowed,glyphs,pipelines,loads,fallback,text:id=>node(id).getComponent(Label)?.string};
}

test('authored seven-day hierarchy retains original cards, only one badge and dynamic rewards', async () => {
  const h=harness(); await h.hud.prepared;
  assert.equal(config.dailyCheckUi.cards.length,7); assert.equal(config.diamondFx.count,8);
  assert.equal(config.nodes[ids.cards[6].root].rect.size[0],911.0999755859375);
  assert.equal(h.hud.isOpen,false); h.hud.open();
  ids.cards.forEach((c,i)=>{assert.equal(h.text(c.amount),String(h.state.days[i].diamonds));assert.equal(h.text(c.date),`Day ${i+1}`);});
  assert.equal(h.text('moneyText'),'12.5K');assert.equal(h.text('diamondText'),'42');
  assert.ok(h.node('background').getComponent(h.BlockInputEvents));
  for(const n of Object.values(config.nodes)) assert.ok(!/Coupang|Test_obj|Event_obj/.test(n.name));
  assert.equal(h.hud.node.children.some(n=>n.name==='DailyCheck_Btn'),false,'modal has no duplicate entry');
  h.hud.destroy();h.entry.destroy();
});

test('reward status advances from configured snapshot and a claim grants once without closing',()=>{
  const h=harness();h.hud.open();const first=ids.cards[0],next=ids.cards[1];
  assert.equal(h.node(first.getable).active,true);assert.equal(h.node(first.claimed).active,false);
  assert.equal(h.node(first.root).parent.children.at(-1),h.node(first.root));
  h.click(first.root);assert.equal(h.wallet.diamonds,182);assert.equal(h.hud.isOpen,true);assert.equal(h.hud.particles.count,8);
  assert.equal(h.node(first.getable).active,false);assert.equal(h.node(first.claimed).active,true);assert.equal(h.text('diamondText'),'182');
  h.click(first.root);h.click(next.root);assert.equal(h.wallet.diamonds,182);assert.equal(h.hud.particles.count,8);
  assert.deepEqual(h.records.sounds,[7,5,5]);
  h.state.days[1].status='getable';h.state.canClaim=true;h.state.today='2026-10-17';h.hud.update(0);
  assert.equal(h.node(next.getable).active,true);assert.equal(h.node(next.root).parent.children.at(-1),h.node(next.root));
  h.hud.destroy();h.entry.destroy();
});

test('pointer cancellation, mismatched fingers and hidden/blocked entries cannot claim or open',()=>{
  const h=harness(),id=ids.cards[0].root;
  h.emit(id,'start');h.emit(id,'end');assert.equal(h.records.claims.length,0);
  h.hud.open();h.emit(id,'start',1);h.emit(id,'end',2);assert.equal(h.records.claims.length,0);
  h.emit(id,'cancel',1);h.emit(id,'end',1);assert.equal(h.records.claims.length,0);
  h.emit(id,'start');h.hud.cancelInteractions();h.emit(id,'end');assert.equal(h.records.claims.length,0);
  h.emit(id,'start');h.emit(id,'end',1,{x:-9999,y:-9999});assert.equal(h.records.claims.length,0);
  const entryClick=()=>{h.emit('entry','start',1,undefined,'start',h.entry);h.emit('entry','end',1,undefined,'end',h.entry);};
  h.entry.setBlocked(true);entryClick();assert.equal(h.records.entryClicks,0);
  h.entry.setBlocked(false);h.entry.setVisible(false);entryClick();assert.equal(h.records.entryClicks,0);
  h.entry.setVisible(true);entryClick();assert.equal(h.records.entryClicks,1);
  h.hud.destroy();h.entry.destroy();
});

test('commit failure has no flight or balance change and close keeps the original sound',()=>{
  const h=harness({failure:'saveFailed'});h.hud.open();h.click(ids.cards[0].root);
  assert.equal(h.hud.particles.count,0);assert.equal(h.wallet.diamonds,42);assert.equal(h.node(ids.cards[0].getable).active,true);
  assert.deepEqual(h.records.sounds,[5]);assert.equal(h.records.alerts.length,1);
  h.click('close');assert.equal(h.hud.isOpen,false);assert.deepEqual(h.records.sounds,[5,1]);assert.deepEqual(h.records.visibility,[true,false]);
  h.hud.destroy();h.entry.destroy();
});

test('server-verified daily claim waits for success and rejects repeat clicks until it settles', async () => {
  const h = harness(), grant = h.callbacks.claim;
  let finish, requests = 0;
  h.callbacks.claim = index => { requests++; return new Promise(resolve => { finish = () => resolve(grant(index)); }); };
  h.hud.open(); h.click(ids.cards[0].root); h.click(ids.cards[0].root); h.click(ids.cards[1].root);
  assert.equal(requests, 1); assert.equal(h.wallet.diamonds, 42);
  assert.equal(h.hud.particles.count, 0); assert.deepEqual(h.records.sounds, []);
  finish(); await Promise.resolve();
  assert.equal(h.wallet.diamonds, 182); assert.equal(h.text('diamondText'), '182');
  assert.equal(h.node(ids.cards[0].claimed).active, true); assert.equal(h.hud.particles.count, 8);
  assert.deepEqual(h.records.sounds, [7]);
  h.click(ids.cards[0].root); assert.equal(requests, 2); finish(); await Promise.resolve();
  assert.equal(h.wallet.diamonds, 182);
  h.hud.destroy(); h.entry.destroy();
});

test('daily verification rejection and synchronous exceptions show Chinese feedback and allow retry', async () => {
  const h = harness(), grant = h.callbacks.claim;
  h.hud.open();
  for (const fail of [() => Promise.reject(new Error('network unavailable')), () => { throw new Error('network unavailable'); }]) {
    h.callbacks.claim = fail; h.click(ids.cards[0].root); await Promise.resolve();
    assert.equal(h.records.alerts.at(-1), '签到核验失败，请检查网络后重试。');
    assert.equal(h.wallet.diamonds, 42); assert.equal(h.hud.particles.count, 0);
  }
  h.callbacks.claim = () => Promise.resolve({ ok: false, reason: 'notLoggedIn', message: '请先登录后再签到。' });
  h.click(ids.cards[0].root); await Promise.resolve();
  assert.equal(h.records.alerts.at(-1), '请先登录后再签到。');
  h.callbacks.claim = grant; h.click(ids.cards[0].root); assert.equal(h.wallet.diamonds, 182);
  h.hud.destroy(); h.entry.destroy();
});

test('daily verification completion cannot update a destroyed HUD', async () => {
  for (const reject of [false, true]) {
    const h = harness(); let settle;
    h.callbacks.claim = () => new Promise((resolve, fail) => { settle = reject ? () => fail(new Error('network unavailable')) : () => resolve({ ok: true, dayIndex: 0, diamonds: 140 }); });
    h.hud.open(); h.click(ids.cards[0].root); h.hud.destroy(); h.entry.destroy();
    const sounds = h.records.sounds.length, alerts = h.records.alerts.length;
    h.hud.refresh = () => assert.fail('destroyed HUD must not refresh');
    settle(); await Promise.resolve();
    assert.equal(h.records.sounds.length, sounds); assert.equal(h.records.alerts.length, alerts);
  }
});

test('entry keeps original top coordinates at safe-area sizes',()=>{
  assert.deepEqual(config.nodes[ids.entry].entryLayout.parentSizeDelta,[-980,-1820]);
  const h=harness();h.entry.resize(1080,1920,48,30);const e=h.entry.entry;
  assert.ok(Math.abs(e.worldPosition.x-(-540+132.70001220703125))<1e-6);
  assert.ok(Math.abs(e.worldPosition.y-(960-48-98))<1e-6);
  assert.equal(e.getComponent(h.UITransform).width,65);
  h.entry.resize(720,1280,24,16);assert.ok(Math.abs(e.worldPosition.y-(640-24-98*2/3))<1e-6);
  h.hud.resize(720,1280,24,16);assert.equal(h.hud.node.scale.x,2/3);
  h.hud.destroy();h.entry.destroy();
});

test('entry loader rejects a missing authored parent layout before loading artwork',async()=>{
  const h=harness(),entryConfig=JSON.parse(JSON.stringify(require('../assets/resources/art/feature-entries/dailyCheck.json')));
  delete entryConfig.nodes[entryConfig.roots.entry].entryLayout;
  h.art.json=async()=>entryConfig;
  await assert.rejects(h.modules['./DailyCheckHud'].loadDailyCheckEntryAssets(h.art),/entry parent layout/);
  assert.equal(h.loads.length,0);h.hud.destroy();h.entry.destroy();
});

test('entry geometry follows the exported parent delta instead of embedded HUD constants',()=>{
  const h=harness(),entryConfig=JSON.parse(JSON.stringify(require('../assets/resources/art/feature-entries/dailyCheck.json')));
  entryConfig.nodes[entryConfig.roots.entry].entryLayout.parentSizeDelta=[-900,-1700];
  const entry=new h.modules['./DailyCheckHud'].DailyCheckEntry(h.makeNode('Canvas'),h.art,{...h.assets,config:entryConfig},()=>{});
  entry.resize(1080,1920);const at=entry.entry.worldPosition;
  assert.ok(Math.abs(at.x-(-540+450-357.29998779296875))<1e-6);
  assert.equal(at.y,960-850+812);entry.destroy();h.hud.destroy();h.entry.destroy();
});

test('original diamond particles retarget after close and finish once per sprite without touching wallet',()=>{
  const h=harness({presentation:true});h.hud.open();h.click(ids.cards[0].root);
  const effect=h.hud.particles,pipeline=h.pipelines[0],before=h.wallet.diamonds;
  assert.equal(effect.node.parent,pipeline.content);assert.equal(effect.count,8);
  h.hud.update(.1);assert.ok(effect.particles.some(p=>p.node.position.x!==h.node(ids.cards[0].root).position.x));
  h.hud.close();assert.equal(effect.node.parent,h.hud.node);assert.equal(pipeline.active,false);
  assert.equal(effect.particles[0].sprite.customMaterial,null);
  for(let n=0;n<75;n++)h.hud.update(1/60);
  assert.equal(effect.count,0);assert.equal(h.records.sounds.filter(n=>n===14).length,8);assert.equal(h.wallet.diamonds,before);
  assert.equal(h.fallback.scale.x,1);h.hud.update(1);assert.equal(h.records.sounds.filter(n=>n===14).length,8);
  h.hud.destroy();h.entry.destroy();assert.ok(h.borrowed.every(frame=>frame.destroyCalls===0));
});

test('source absolute Fast rotation keeps its incremental phase across hidden panels',()=>{
  const h=harness({presentation:true});h.hud.open();const p=h.pipelines[0],initial=p.invalidations;
  const glow=ids.cards[0].glow,base=config.nodes[glow].rect.angle,step=-180-base;
  assert.ok(Math.abs(step+31.492626)<.000001);assert.equal(h.node(glow).angle,base);
  h.hud.update(.5);assert.equal(h.node(glow).angle,base+step*.5);assert.ok(p.invalidations>initial);
  h.hud.close();const closed=p.invalidations;h.hud.update(.5);assert.equal(p.invalidations,closed);
  h.hud.open();assert.equal(h.node(glow).angle,-180,'opening resumes the hidden tween without resetting');
  h.hud.update(.5);assert.equal(h.node(glow).angle,base+step*1.5,'Incremental keeps the original short rotation delta');
  h.hud.destroy();h.entry.destroy();
});

test('each claim glow starts on its first activation while earlier glows keep time',()=>{
  const h=harness();h.hud.open();h.hud.update(2);
  const first=ids.cards[0].glow,next=ids.cards[1].glow,base=config.nodes[next].rect.angle;
  assert.equal(h.hud.glowElapsed.has(next),false);
  h.state.days[0].status='geted';h.state.days[1].status='getable';h.hud.update(.5);
  assert.equal(h.node(next).angle,base,'newly activated Unity Awake starts at zero');
  assert.equal(h.hud.glowElapsed.get(first),2.5,'inactive old glow is still advancing');
  h.hud.update(.25);assert.equal(h.node(next).angle,base+(-180-base)*.25);
  h.hud.destroy();h.entry.destroy();
});

test('an arriving diamond starts its balance bounce on the next frame, including long frames',()=>{
  const h=harness();h.hud.open();h.click(ids.cards[0].root);
  const effect=h.hud.particles,target=h.node(ids.diamondBounce.node),base=target.scale.x;
  h.hud.update(2);
  assert.equal(effect.count,0);assert.equal(effect.active,true);assert.equal(target.scale.x,base);
  assert.equal(h.records.sounds.filter(id=>id===14).length,8);
  h.hud.update(.05);assert.ok(Math.abs(target.scale.x/base-.95)<1e-6);
  h.hud.update(.05);assert.ok(Math.abs(target.scale.x/base-.9)<1e-6);
  h.hud.update(.11);assert.equal(target.scale.x,base);assert.equal(effect.active,false);
  h.hud.destroy();h.entry.destroy();
});

test('particles finish with their sound after all targets disappear and never replay a reward',()=>{
  const h=harness();h.hud.open();h.click(ids.cards[0].root);const paid=h.wallet.diamonds;
  h.hud.close();h.fallback.active=false;
  h.hud.update(2);assert.equal(h.hud.particles.count,0);assert.equal(h.hud.particles.active,false);
  assert.equal(h.records.sounds.filter(id=>id===14).length,8);assert.equal(h.wallet.diamonds,paid);
  h.hud.update(2);assert.equal(h.records.sounds.filter(id=>id===14).length,8);assert.equal(h.records.claims.length,1);
  h.hud.destroy();h.entry.destroy();
});

test('asset errors remain retryable and aborted preparation releases owned resources',async()=>{
  const failure=harness({failLoad:true});await assert.rejects(failure.modules['./DailyCheckHud'].loadDailyCheckHudAssets(failure.art),/daily asset failure/);
  failure.hud.destroy();failure.entry.destroy();
  const h=harness({presentation:true,prepare:async steps=>{for(let i=0;i<15;i++)steps.next();throw Error('cancel prepare');}});
  await assert.rejects(h.hud.prepared,/cancel prepare/);assert.equal(h.hud.node.isValid,false);assert.equal(h.pipelines[0].destroyCalls,1);
  assert.equal(h.records.claims.length,0);assert.ok(h.borrowed.every(f=>f.destroyCalls===0));h.entry.destroy();
});

test('source weighted attraction curves preserve knots and support fixed-size finished particles',()=>{
  const h=harness(),curve=h.modules['./OriginalDiamondAttraction'].diamondCurve,p=config.diamondFx.particle;
  assert.equal(curve(p._toTarget,1,.25),1);assert.equal(curve(p._startSize.mainCurve,.5,.25),60);
  assert.equal(curve(p._lifetime,0,0),.5);assert.equal(curve(p._lifetime,0,1),1);
  assert.equal(curve(p._startSpeed,0,0),1);assert.equal(curve(p._startSpeed,0,1),15);
  assert.ok(curve(p._toTarget,.7,.5)<.01);assert.ok(curve(p._toTarget,.95,.5)>.5);
  h.hud.destroy();h.entry.destroy();
});
