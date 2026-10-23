const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/hunt-system/config.json');

// Run the real source renderer, particle simulation and HUD against minimal Cocos primitives.
function harness(overrides = {}, economy = {}) {
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
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'OriginalWeaponConfettiNoise', 'OriginalWeaponConfettiMath', 'OriginalWeaponConfetti', 'RewardedAdModal', 'HuntHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const state = { visible:true, unlocked:true, wave:0, level:0, hp:1, maxHp:1, reward:30, runReward:90, adReward:90, petCoins:100, phase:'idle', kills:0,totalMonsters:30,remainingMonsters:30, progress:0,resultElapsed:0,adAvailable:false,adEnabled:false,settlementPending:false,...overrides };
  const records = { alerts: [], sounds: [], visibility: [], starts: 0, retries: 0, giveUps: 0, exits: 0, ads: 0, results: [] };
  const canvas = makeNode('Canvas'); let request = null;
  const modal = new modules['./RewardedAdModal'].RewardedAdModal(canvas, (id, outcome) => {
    if (!request || request.token !== id) return; const current = request; request = null; current.complete(outcome);
  });
  const presenter = { showRewardedAd(token, placement, complete) { request = { token, placement, complete }; modal.open(token); },
    cancelRewardedAd(token) { if (request?.token === token) { request = null; modal.dismiss(); } } };
  const hud = new modules['./HuntHud'].HuntHud(canvas, art,
    { config, chineseFont: new Font(), originalFont: new Font(), numberFont: new Font() }, {
      getState: () => state,
      start: () => { records.starts++; state.phase = 'entering'; return { ok: true }; },
      retrySettlement: () => { records.retries++; state.settlementPending=false; return {ok:true}; },
      giveUp: () => { records.giveUps++; state.phase='failed'; return {ok:true}; },
      exit: () => { records.exits++; state.phase = 'exiting'; return { ok: true }; },
      beginAd: () => { records.ads++; state.phase = 'adPending'; return { ok: true, token: records.ads === 1 ? 'ad-token' : `ad-token-${records.ads}` }; },
      completeAd: (token, outcome) => { records.results.push({ token, outcome }); state.phase = outcome === 'success' ? 'exiting' : 'failed'; return { ok: outcome === 'success' }; },
      cancelAd: () => { records.results.push({ outcome: 'cancel' }); state.phase = 'failed'; },
      alert: value => records.alerts.push(value), playSfx: id => records.sounds.push(id), onVisibilityChanged: value => records.visibility.push(value),
    }, presenter);
  const node = id => hud.ui.node(`level0:${id}`);
  const event = (target, id = 1, at, originalType) => ({ getID: () => id, getUILocation: () => at || target.worldPosition, getEventCode: () => originalType });
  const emit = (target, type, id, at, originalType = type) => target.events.get(type)?.(event(target, id, at, originalType));
  const clickNode = target => { emit(target, 'start'); emit(target, 'end'); };
  const click = id => clickNode(node(id));
  const text = id => node(id).getComponent(Label).string;
  return { hud, modal, presenter, state, records, node, click, clickNode, emit, text, UITransform, Label, RichText, Sprite, atlases, borrowedFrames, bitmapFrames, LabelOutline, LabelShadow };
}

test('Hunt retains original geometry, all twenty sprites, source TMP assets and animation clips', () => {
  assert.deepEqual(config.roots, {entry:'level0:885',start:'level0:1855',battle:'level0:1993',result:'level0:71'});
  assert.deepEqual(config.nodes['level0:2072'].rect.size,[1000,865]);
  assert.equal(config.monsterSprites.length,20);
  assert.equal(config.animations.result.duration,1.5);
  assert.equal(config.animations.explain.duration,5);
  assert.equal(config.animations.clear.source,'sharedassets0.assets:270');
  assert.equal(config.confetti.length,3);
  assert.ok(Object.values(config.nodes).every(n=>!/PlusPack|Sweep|^Auto_obj$|Rank|Remove Ads|IAP/.test(n.name)));
  const explanation=config.nodes['level0:10184'].text.value,upgrade=config.nodes['level0:10170'].text.value;
  const coin=explanation.match(/<sprite=(\d+)>/)[1],warning=upgrade.match(/<sprite=(\d+)>/)[1];
  assert.equal(config.inlineSprites[coin],'inline-1014-0');
  assert.equal(config.inlineSprites[warning],'inline-1016-0');
  for(const image of Object.values(config.images))assert.ok(fs.existsSync(path.join(root,'assets/resources',image.path+'.png')));
});

test('Hunt locked entry reports stage 12 and challenge enters once', () => {
  const h=harness({unlocked:false});h.hud.resize(390,844);h.hud.open();
  assert.ok(h.records.alerts[0].includes('12'));assert.equal(h.node(1855).active,false);
  h.state.unlocked=true;h.hud.open();h.hud.update(.31);
  assert.equal(h.node(1692).active,false);assert.equal(h.node(1855).active,true);
  assert.equal(h.text(597),'Wave 1-1');assert.equal(h.text(418),'?');
  h.click(724);h.click(724);assert.equal(h.records.starts,1);
  h.state.phase='playing';h.hud.update(0);assert.equal(h.hud.blocksUpgrades,false);
  h.click(1894);assert.equal(h.records.giveUps,1);assert.equal(h.records.exits,0);
  const configured=harness({unlocked:false,requiredStage:18});configured.hud.open();assert.ok(configured.records.alerts[0].includes('18'));
});

test('Hunt kill percentage and wave progress are independent from the barrier health', () => {
  const h=harness({phase:'playing',wave:12,level:2,progress:.36,hp:0});
  h.hud.update(0);assert.equal(h.text(2085),'36%');assert.equal(h.text(433),'Wave 13-3');
  for(const [id,fraction] of [[1873,.36],[1030,.5],[72,1]]) {
    const size=h.hud.fillSizes.get('level0:'+id);
    assert.ok(Math.abs(h.node(id).getComponent(h.UITransform).width-size.width*fraction)<1e-6);
  }
  assert.equal(h.node(895).position.x,0);
  assert.equal(h.node(72).getComponent(h.UITransform).anchorX,.5,'unbound full background keeps the Stage_Fill origin');
  const tint=(id)=>h.node(id).children.find(n=>n.name==='OriginalImage').getComponent(h.Sprite).color;
  assert.deepEqual(Object.values(tint(427)),config.progress.holeColors[0]);
  assert.deepEqual(Object.values(tint(66)),config.progress.holeColors[1]);
});

test('Hunt ordinary settlement shows original confirm, saved reward and no advertisement control', () => {
  const h=harness({phase:'failed',resultElapsed:2,runReward:120,adReward:120});h.hud.update(2);
  assert.equal(h.node(71).active,true);assert.equal(h.node(1769).active,true);
  assert.equal(h.node(966).active,false);assert.equal(h.node(338).active,false);
  assert.equal(h.text(1155),'120');assert.equal(h.text(10295),'确定');
  h.click(1769);h.click(1769);assert.equal(h.records.exits,1);assert.equal(h.records.ads,0);
});

test('Hunt result and clear banners retain native animated scale and reveal timing', () => {
  const h=harness({phase:'failed'});
  h.hud.update(0);assert.equal(h.node(1265).active,false);
  h.state.resultElapsed=.34;h.hud.update(.34);assert.equal(h.node(1265).active,true);assert.ok(h.node(1265).scale.x<1);
  h.state.resultElapsed=1.4;h.hud.update(1.06);assert.equal(h.node(191).active,true);assert.equal(h.node(1769).active,true);
  h.state.phase='playing';h.hud.update(0);h.state.phase='clearing';h.hud.update(0);
  assert.equal(h.node(257).active,true);assert.equal(h.node(486).scale.x,0);
  h.hud.update(.25);assert.equal(h.node(486).scale.x,1.5);assert.equal(h.text(1479),'30');
  h.state.phase='playing';h.hud.update(0);assert.equal(h.node(257).active,false);
});

test('Hunt advert cancellation leaves ordinary exit and ignores late duplicate completion', () => {
  const h=harness({phase:'failed',resultElapsed:2,adEnabled:true,adAvailable:true});h.hud.update(2);
  let complete;const present=h.presenter.showRewardedAd;
  h.presenter.showRewardedAd=(token,placement,callback)=>{assert.equal(placement,'hunt');complete=callback;present(token,placement,callback);};
  assert.equal(h.text(1155),'180');assert.equal(h.text(179),'90');
  h.click(966);assert.equal(h.records.ads,1);assert.equal(h.state.phase,'adPending');
  h.state.adEnabled=false;h.hud.update(0);complete('success');complete('success');
  assert.equal(h.records.results.length,1);assert.equal(h.state.phase,'failed');
  h.click(1769);assert.equal(h.records.exits,1);assert.equal(h.records.ads,1);
});

test('Hunt keeps touch ownership through cancel, outside release, resize and mode changes', () => {
  for(const [phase,id,action] of [['idle',724,'starts'],['playing',1894,'giveUps'],['failed',1769,'exits']]) {
    const h=harness({phase,resultElapsed:2});h.hud.resize(390,844);if(phase==='idle')h.hud.open();h.hud.update(.31);
    const button=h.node(id);h.emit(button,'start',71);h.emit(button,'end',72);
    assert.equal(h.records[action],0);h.emit(button,'end',71,{x:10000,y:10000});assert.equal(h.records[action],0);
    h.emit(button,'start',73);h.hud.resize(412,915,44,24);h.emit(button,'end',73);assert.equal(h.records[action],0);
    h.hud.update(.31);h.emit(button,'start',74);h.emit(button,'end',74);h.emit(button,'end',74);assert.equal(h.records[action],1);
  }
});

test('Hunt original challenge and confirm controls fit the supported portrait safe frames', () => {
  for(const [width,height] of [[360,640],[390,844],[412,915]]) {
    const h=harness(),top=44,bottom=24;h.hud.resize(width,height,top,bottom);h.hud.open();h.hud.update(.31);
    for(const [phase,id] of [['idle',724],['playing',1894],['failed',1769]]) {
      h.state.phase=phase;h.state.resultElapsed=2;h.hud.update(2);
      const n=h.node(id),tr=n.getComponent(h.UITransform),p=n.worldPosition,s=n.worldScale;
      assert.ok(p.x-tr.anchorX*tr.width*s.x>=-width/2-.001);
      assert.ok(p.x+(1-tr.anchorX)*tr.width*s.x<=width/2+.001);
      assert.ok(p.y-tr.anchorY*tr.height*s.y>=-height/2+bottom-.001);
      assert.ok(p.y+(1-tr.anchorY)*tr.height*s.y<=height/2-top+.001);
    }
  }
});

test('Hunt failed persistence offers the original confirm as retry without a second claim or exit', () => {
  const h=harness({phase:'clearing',settlementPending:true});h.hud.update(2);
  assert.equal(h.node(71).active,true);assert.equal(h.node(1769).active,true);
  assert.equal(h.text(643),'Save Failed');assert.equal(h.records.alerts.length,1);
  h.hud.update(.1);h.click(1769);
  assert.equal(h.records.retries,1);assert.equal(h.records.exits,0);assert.equal(h.records.ads,0);
  assert.equal(h.node(71).active,false);assert.equal(h.state.phase,'clearing');
});

test('Hunt source tweens use absolute 12 to 15 icon movement and InOutQuad slime squash', () => {
  const h=harness({phase:'playing'});h.hud.update(1);
  assert.equal(h.node(162).position.y,15);
  h.hud.update(1);assert.equal(h.node(162).position.y,12);
  h.state.phase='idle';h.hud.open();h.hud.update(.5);
  assert.ok(Math.abs(h.node(364).scale.x-1.0125)<1e-6);
});

