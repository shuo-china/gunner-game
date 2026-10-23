const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/mine-system/config.json');

// Run the real source renderer, particle simulation and HUD against minimal Cocos primitives.
function harness(overrides = {}, economy = {mine:{scorePerDiamond:10,speedBuffMultiplier:3,adAdditionalMultiplier:3}}) {
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
    constructor(name) { Object.assign(this, { name, children: [], components: new Map(), events: new Map(), active: true, position: new Vec3(), scale: new Vec3(1, 1, 1) }); }
    addChild(node) { node.parent = this; this.children.push(node); }
    addComponent(Type) { const value = new Type(); value.node = this; this.components.set(Type, value); return value; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y, z = 0) { this.position = new Vec3(x, y, z); }
    setScale(x, y, z = 1) { this.scale = new Vec3(x, y, z); }
    on(event, callback) { this.events.set(event, callback); }
    destroy() { this.destroyed = true; }
    setSiblingIndex(index) { const siblings = this.parent?.children; if (!siblings) return; siblings.splice(siblings.indexOf(this), 1); siblings.splice(index, 0, this); }
    get worldScale() { const p = this.parent?.worldScale || new Vec3(1, 1, 1); return new Vec3(this.scale.x * p.x, this.scale.y * p.y, this.scale.z * p.z); }
    get worldPosition() { const p = this.parent?.worldPosition || new Vec3(), s = this.parent?.worldScale || new Vec3(1, 1, 1); return new Vec3(p.x + this.position.x * s.x, p.y + this.position.y * s.y, p.z + this.position.z * s.z); }
  }
  class Color { static WHITE = new Color(255, 255, 255, 255); constructor(r, g, b, a) { Object.assign(this, { r, g, b, a }); } }
  class Graphics { clear() {} rect() {} fill() {} moveTo() {} lineTo() {} close() {} }
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
  const makeNode = (name, parent) => { const node = new Node(name); node.addComponent(UITransform); if (parent) parent.addChild(node); return node; };
  const paths = [...Object.values(config.images).map(image => image.path), ...Object.values(config.bitmapFonts).flatMap(font => font.pages)];
  const art = { frames: new Map(paths.map(path => {
    const frame = { texture: { path }, destroyCalls: 0, destroy() { this.destroyCalls++; } }; borrowedFrames.push(frame); return [path, frame];
  })), image: (name, spec, parent) => makeNode(name, parent) };
  const modules = { cc, './ArtLibrary': { makeNode }, '../core/EconomyConfig': { ECONOMY_CONFIG: economy } };
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'OriginalWeaponConfettiNoise', 'OriginalWeaponConfettiMath', 'OriginalWeaponConfetti', 'RewardedAdModal', 'MineHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const state = {settlementPending:false,visible:true,unlocked:true,requiredStage:4,phase:'idle',adKind:null,remainingTickets:2,usedEntries:0,freeEntriesPerDay:2,bestReward:0,score:0,rewardDiamonds:0,additionalRewardDiamonds:0,timeRemaining:60,timeLimit:60,oreCountNow:0,oreCountMax:1000,loadingElapsed:null,resultElapsed:0,adsEnabled:false,speedAdAvailable:false,bonusAdAvailable:false,speedBuffRemainingSeconds:0,speedBuffMultiplier:1,...overrides};
  const records = {alerts:[],sounds:[],visibility:[],opens:0,closes:0,starts:0,exits:0,ads:[],results:[]};
  const canvas = makeNode('Canvas'); let request = null;
  const modal = new modules['./RewardedAdModal'].RewardedAdModal(canvas, (id, outcome) => {
    if (!request || request.token !== id) return; const current = request; request = null; current.complete(outcome);
  });
  const presenter = { showRewardedAd(token, placement, complete) { request = { token, placement, complete }; modal.open(token); },
    cancelRewardedAd(token) { if (request?.token === token) { request = null; modal.dismiss(); } } };
  const hud = new modules['./MineHud'].MineHud(canvas, art,
    { config, chineseFont: new Font(), originalFont: new Font(), numberFont: new Font() }, {
      getState: () => state,
      open: () => {records.opens++;state.phase='preparing';return {ok:true};},
      close: () => {records.closes++;state.phase='idle';return {ok:true};},
      start: () => {if(state.remainingTickets<=0)return {ok:false,reason:'dailyLimit'};records.starts++;state.phase='entering';return {ok:true};},
      exit: () => {records.exits++;state.phase='exiting';return {ok:true};},
      beginAd: kind => {records.ads.push(kind);state.adKind=kind;state.phase='adPending';return {ok:true,token:'ad-token-'+records.ads.length};},
      completeAd: (token,outcome) => {records.results.push({token,outcome});state.phase=outcome==='success'?(state.adKind==='entry'?'entering':'exiting'):(state.adKind==='entry'?'preparing':'result');state.adKind=null;return {ok:outcome==='success'};},
      cancelAd: () => {records.results.push({outcome:'cancel'});state.phase=state.adKind==='entry'?'preparing':'result';state.adKind=null;},
      alert: value => records.alerts.push(value), playSfx: id => records.sounds.push(id), onVisibilityChanged: value => records.visibility.push(value),
    }, presenter);
  const getRequest = () => request;
  const node = id => hud.ui.node(`level0:${id}`);
  const event = (target, id = 1, at, originalType) => ({ getID: () => id, getUILocation: () => at || target.worldPosition, getEventCode: () => originalType });
  const emit = (target, type, id, at, originalType = type) => target.events.get(type)?.(event(target, id, at, originalType));
  const clickNode = target => { emit(target, 'start'); emit(target, 'end'); };
  const click = id => clickNode(node(id));
  const text = id => node(id).getComponent(Label).string;
  return { hud, modal, presenter, getRequest, state, records, node, click, clickNode, emit, text, UITransform, Label, RichText, Sprite, atlases, borrowedFrames, bitmapFrames, LabelOutline, LabelShadow };
}

test('Mine retains original free geometry, bitmap lettering, result animation and world assets', () => {
  assert.deepEqual(config.roots,{entry:'level0:1231',start:'level0:1949',battle:'level0:1165',result:'level0:1406'});
  assert.equal(config.nodes['level0:1358'].rect.size[0],1000);
  assert.ok(Math.abs(config.nodes['level0:1358'].rect.size[1]-864.3)<.001);
  assert.equal(config.animations.result.source,'sharedassets0.assets:277');
  assert.equal(config.confetti.length,3);
  assert.equal(config.nodes['level0:10373'].text.value,'在1分钟内尽可能多地挖掘钻石！');
  assert.equal(config.nodes['level0:10240'].text.value,'提示. 对矿物的伤害始终为1');
  assert.ok(Object.values(config.nodes).every(n=>!/MinePack|Sweep|^Auto_obj$|Remove Ads|PlusPack|Purchase/.test(n.name)));
  assert.deepEqual(config.fonts,{});
  for(const image of Object.values(config.images)) assert.ok(fs.existsSync(path.join(root,'assets/resources',image.path+'.png')));
  const world=require('../assets/resources/art/mine-system/visuals.json');
  assert.deepEqual(world.ground.sizePx,[512,512]);
  assert.equal(world.oreSprites.length,2);assert.deepEqual(world.oreSprites[0].sizePx,[286,285]);
  assert.equal(Object.keys(world.diamondNumbers.glyphs).length,42);assert.equal(world.diamondNumbers.curves.length,12);
  for(const glyph of Object.values(world.diamondNumbers.glyphs)) assert.ok(fs.existsSync(path.join(root,'assets/resources',glyph.path+'.png')));
});

test('Mine preparation is session owned, locked entry explains stage and normal start happens once', () => {
  const h=harness({unlocked:false});h.hud.open();assert.ok(h.records.alerts[0].includes('4'));assert.equal(h.records.opens,0);
  h.state.unlocked=true;h.hud.open();h.hud.update(.31);
  assert.equal(h.state.phase,'preparing');assert.equal(h.node(1949).active,true);assert.equal(h.text(1973),'2/2');assert.equal(h.text(1527),'?');
  h.click(1698);assert.equal(h.records.closes,1);assert.equal(h.state.phase,'idle');assert.equal(h.hud.isOpen,false);
  h.hud.open();h.hud.update(.31);h.click(1616);h.click(1616);assert.equal(h.records.starts,1);
  h.state.phase='playing';h.hud.update(0);assert.equal(h.hud.blocksUpgrades,false);
  h.click(956);assert.equal(h.records.exits,1);
});

test('Mine depleted tickets use original red bitmap variant and block normal and ad entry', () => {
  const h=harness({remainingTickets:0,usedEntries:2,adsEnabled:true});h.hud.open();h.hud.update(.31);
  assert.equal(h.text(1973),'0/2');h.click(1616);h.click(1058);assert.equal(h.records.starts,0);assert.equal(h.records.ads.length,0);
  assert.ok(h.records.alerts.includes('今日入场次数已用完。'));
  assert.equal(h.node(1973).getComponent(h.Label).color.r,255);assert.equal(h.node(1973).getComponent(h.Label).color.g,95);
  assert.equal(h.node(1058).active,false,'source hides entry ad when tickets are depleted');
});

test('Mine normal preparation keeps unknown reward even after a prior best and hides active-buff entry ad', () => {
  const h=harness({bestReward:190,adsEnabled:true,speedBuffRemainingSeconds:100});h.hud.open();h.hud.update(.31);
  assert.equal(h.text(1527),'?');assert.equal(h.node(1058).active,false);
});

test('Mine battle shows fractional diamonds, clock and independently clipped ore/time fills', () => {
  const h=harness({phase:'playing',score:123,oreCountNow:200,timeRemaining:20.1});h.hud.update(0);
  assert.equal(h.text(9837),'12.3');assert.equal(h.text(1965),'21s');
  for(const [id,fraction] of [[73,.2],[1377,20.1/60]]) {
    const size=h.hud.fillSizes.get('level0:'+id),node=h.node(id),image=node.children.find(n=>n.name==='OriginalImage');
    assert.ok(Math.abs(node.getComponent(h.UITransform).width-size.width*fraction)<1e-6);
    assert.equal(image.getComponent(h.UITransform).width,size.width,'original fill image is clipped without squeezing');
  }
});

test('Mine displays twofold fractional progress before the settled integer and its advertised total', () => {
  const h = harness({ phase: 'playing', score: 38, oreCountNow: 10 });
  h.hud.update(0); assert.equal(h.text(9837), '3.8');
  Object.assign(h.state, { phase: 'result', resultElapsed: 2, rewardDiamonds: 3, additionalRewardDiamonds: 9 });
  h.hud.update(0); assert.equal(h.text(231), '3'); assert.equal(h.text(645), '3');
  h.state.adsEnabled = true; h.state.bonusAdAvailable = true; h.hud.update(0);
  assert.equal(h.text(231), '12'); assert.equal(h.text(645), '3');
});

test('Mine ordinary result shows saved diamonds and original confirm with ads disabled', () => {
  const h=harness({phase:'result',resultElapsed:2,rewardDiamonds:12,additionalRewardDiamonds:36});h.hud.update(2);
  assert.equal(h.node(1406).active,true);assert.equal(h.node(928).active,true);assert.equal(h.node(131).active,false);assert.equal(h.node(1749).active,false);
  assert.equal(h.text(231),'12');assert.equal(h.text(10352),'确定');
  h.click(928);h.click(928);assert.equal(h.records.exits,1);assert.equal(h.records.ads.length,0);
});

test('Mine settlement persistence failure exposes retry and cannot leave or request a bonus', () => {
  const h=harness({phase:'result',resultElapsed:2,rewardDiamonds:12,additionalRewardDiamonds:36,adsEnabled:true,bonusAdAvailable:true,settlementPending:true});
  let retries=0;h.hud.callbacks.retrySettlement=()=>{retries++;return {ok:false,reason:'saveFailed'};};h.hud.update(2);
  assert.equal(h.node(928).active,true);assert.equal(h.node(131).active,false);assert.equal(h.node(1749).active,false);
  assert.equal(h.text(10352),'重试领取');assert.equal(h.text(231),'12');
  h.click(928);h.click(131);h.click(1045);assert.equal(retries,1);assert.equal(h.records.exits,0);assert.equal(h.records.ads.length,0);
  assert.ok(h.records.alerts.includes('进度保存失败，请重试。'));
});

test('Mine native countdown shows remaining plus one, including exact endpoints', () => {
  const h=harness({phase:'playing'});assert.equal(h.text(1965),'61s');h.state.timeRemaining=0;h.hud.update(0);assert.equal(h.text(1965),'1s');
});

test('Mine original result reveal timing, bounce and once-only confetti sound survive ad transitions', () => {
  const h=harness({phase:'result'});h.hud.update(0);assert.equal(h.node(908).active,false);
  h.state.resultElapsed=.34;h.hud.update(.34);assert.equal(h.node(908).active,true);assert.ok(h.node(908).scale.x<1);
  h.state.resultElapsed=.7;h.hud.update(.36);assert.equal(h.node(1722).active,true);assert.equal(h.node(1990).active,false);
  h.state.resultElapsed=1.4;h.hud.update(.7);assert.equal(h.node(1990).active,true);assert.equal(h.node(1045).active,false);
  h.state.resultElapsed=1.6;h.hud.update(.2);assert.equal(h.node(1045).active,true);
  assert.equal(h.records.sounds.filter(x=>x===11).length,1);
});

test('Mine entry ad cancellation and completion retain context and ignore late callbacks', () => {
  const h=harness({adsEnabled:true,speedAdAvailable:true});h.hud.open();h.hud.update(.31);h.click(1058);
  const request=h.getRequest();assert.equal(request.placement,'mine-entry');assert.equal(h.state.phase,'adPending');assert.equal(h.node(1949).active,true);assert.equal(h.node(1406).active,false);
  h.hud.cancelInteractions();assert.equal(h.state.phase,'preparing');request.complete('success');assert.equal(h.records.results.length,1);
  h.hud.update(0);h.click(1058);const next=h.getRequest();next.complete('success');next.complete('success');
  assert.equal(h.state.phase,'entering');assert.equal(h.records.results.length,2);assert.equal(h.records.starts,0,'session owns ad entry transaction');
});

test('Mine reward ad failure can retry and successful reward leaves once', () => {
  const h=harness({phase:'result',resultElapsed:2,rewardDiamonds:12,additionalRewardDiamonds:36,adsEnabled:true,bonusAdAvailable:true});h.hud.update(2);
  assert.equal(h.text(231),'48');assert.equal(h.text(645),'12');assert.equal(h.node(928).active,false);
  h.click(131);const first=h.getRequest();assert.equal(first.placement,'mine-reward');assert.equal(h.node(1406).active,true);assert.equal(h.node(1949).active,false);
  first.complete('failure');assert.equal(h.state.phase,'result');assert.ok(h.records.alerts.includes('广告加载失败。'));
  h.click(131);const next=h.getRequest();next.complete('success');next.complete('success');assert.equal(h.state.phase,'exiting');assert.equal(h.records.results.length,2);
});

test('Mine ordinary exit, disabled ad policy, touch ownership and teardown cannot create reward callbacks', () => {
  const h=harness({phase:'result',resultElapsed:2,adsEnabled:true,bonusAdAvailable:true});h.hud.update(2);
  h.emit(h.node(131),'start',3);h.emit(h.node(131),'end',4);assert.equal(h.records.ads.length,0);
  h.emit(h.node(131),'cancel',3);assert.equal(h.records.ads.length,0);
  h.click(131);const request=h.getRequest();h.state.adsEnabled=false;h.hud.update(0);assert.equal(h.state.phase,'result');assert.equal(h.records.results.length,1);
  request.complete('success');assert.equal(h.records.results.length,1);h.hud.update(0);h.click(928);assert.equal(h.records.exits,1);
  h.hud.destroy();assert.ok(h.borrowedFrames.every(frame=>frame.destroyCalls===0));
});

test('Mine safe-area layout keeps original geometry at all requested mobile widths and persists entry offset', () => {
  for(const [w,hgt] of [[360,640],[390,844],[412,915]]) {
    const h=harness();h.hud.setEntryOffset(730);h.hud.resize(w,hgt,20,16);h.hud.open();h.hud.update(.31);
    assert.ok(Math.abs(h.hud.node.scale.x-w/1080)<1e-8);
    assert.equal(h.node(1358).getComponent(h.UITransform).width,1000);
    assert.equal(h.node(1231).position.y,-h.hud.height/2+730);
    h.click(1616);assert.equal(h.records.starts,1);
  }
});

