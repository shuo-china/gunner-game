const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/boss-system/config.json');

test('Boss HUD uses the completed-stage reward snapshot for the advertised total', () => {
  const economy = { boss: { additionalDiamonds: 29 } };
  const h = harness({ reward: 71, additionalReward: 29, totalReward: 100, stage: 4, phase: 'won', resultElapsed: 2 }, economy);
  h.hud.update(0); assert.equal(h.text(87), '100');
  h.state.adEnabled = false; h.hud.update(0); assert.equal(h.text(87), '71');
  assert.equal(h.records.ads, 0);
});

// Run the real source renderer, particle simulation and HUD against minimal Cocos primitives.
function harness(overrides = {}, economy = require('./.build/session/core/EconomyConfig.js').ECONOMY_CONFIG) {
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
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'OriginalWeaponConfettiNoise', 'OriginalWeaponConfettiMath', 'OriginalWeaponConfetti', 'RewardedAdModal', 'BossHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const state = { visible: true, unlocked: true, health:'50a', maxHealth:'50a', healthRatio:1, stage: 0, reward: 300, additionalReward: 600, totalReward: 900, money: '1.2a', diamonds: '30', phase: 'idle',
    progress: 0, remainingSeconds: 60, resultElapsed: 0, adAvailable: true, adEnabled: true, ...overrides };
  const records = { alerts: [], sounds: [], visibility: [], starts: 0, exits: 0, ads: 0, results: [] };
  const canvas = makeNode('Canvas'); let request = null;
  const modal = new modules['./RewardedAdModal'].RewardedAdModal(canvas, (id, outcome) => {
    if (!request || request.token !== id) return; const current = request; request = null; current.complete(outcome);
  });
  const presenter = { showRewardedAd(token, placement, complete) { request = { token, placement, complete }; modal.open(token); },
    cancelRewardedAd(token) { if (request?.token === token) { request = null; modal.dismiss(); } } };
  const hud = new modules['./BossHud'].BossHud(canvas, art,
    { config, chineseFont: new Font(), originalFont: new Font(), numberFont: new Font() }, {
      getState: () => state,
      start: () => { records.starts++; state.phase = 'entering'; return { ok: true }; },
      exit: () => { records.exits++; state.phase = 'exiting'; return { ok: true }; },
      beginAd: () => { records.ads++; state.phase = 'adPending'; return { ok: true, token: records.ads === 1 ? 'ad-token' : `ad-token-${records.ads}` }; },
      completeAd: (token, outcome) => { records.results.push({ token, outcome }); state.phase = outcome === 'success' ? 'exiting' : 'won'; return { ok: outcome === 'success' }; },
      cancelAd: () => { records.results.push({ outcome: 'cancel' }); state.phase = 'won'; },
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

test('Boss exports original geometry, nine heads and retained free branches', () => {
  assert.deepEqual(config.nodes['level0:737'].rect.size, [1000, 857.2000122070312]);
  assert.equal(config.bossHeads.length, 9);
  assert.ok(config.nodes['level0:10249'].text.value.startsWith('在1分钟内击败Boss！'));
  assert.ok(config.nodes['level0:10249'].text.value.endsWith('攻击力和速度升级不可用。'));
  assert.ok(Object.values(config.nodes).every(n => !/PlusPack|Sweep|^Auto_obj$|Rank_Panel|NoAds|Remove Ads|FreeCash|IAP/.test(n.name)));
  assert.equal(config.nodes['level0:906'].name, 'Continue_Btn');
  assert.equal(config.animations.win.duration, 1.5); assert.equal(config.animations.fail.duration, 1.5);
  assert.equal(config.confetti.length, 3);
  assert.ok(Object.values(config.images).every(image => fs.existsSync(path.join(root, 'assets/resources', image.path + '.png'))));
});
test('Boss locked entry prompts stage 10, then exact challenge binding enters', () => {
  const h = harness({ unlocked: false }); h.hud.resize(390, 844); h.hud.update(1);
  assert.equal(h.node(600).active, true); h.click(600);
  assert.equal(h.records.starts, 0); assert.equal(h.records.alerts.length, 1);
  assert.ok(h.records.alerts[0].includes('10'));
  h.state.unlocked = true; h.hud.update(0); h.click(146); h.hud.update(.31);
  assert.equal(h.node(635).active, true); assert.equal(h.node(600).active, false);
  h.click(785); assert.equal(h.records.starts, 1); assert.equal(h.state.phase, 'entering');
  h.click(785); assert.equal(h.records.starts, 1);
  h.state.phase = 'playing'; h.hud.update(0); assert.equal(h.hud.blocksUpgrades, false);
  h.click(428); assert.equal(h.records.exits, 1);
});
test('Boss displays HP, native time truncation and ad-free 300 with one claim button', () => {
  const h = harness({ adEnabled: false, adAvailable: false, phase: 'playing', remainingSeconds: 9, health: '12.5a', healthRatio: .25 });
  h.hud.update(0); assert.equal(h.text(1903), '12.5a'); assert.equal(h.text(1188), '10s');
  const size = h.hud.fillSizes.get('level0:453');
  assert.ok(Math.abs(h.node(453).getComponent(h.UITransform).width - size.width * .25) < 1e-6);
  h.state.phase = 'won'; h.state.resultElapsed = 2; h.hud.update(2);
  assert.equal(h.text(87), '300'); assert.equal(h.node(1892).active, true);
  for (const id of [2016, 642, 1224, 906]) assert.equal(h.node(id).active, false);
  assert.equal(h.text(10160), '领取'); assert.equal(h.node(10160).position.x, 0); assert.equal(h.node(10160).position.y, 0);
  h.click(1892); h.click(1892);
  assert.equal(h.records.exits, 1); assert.equal(h.records.ads, 0); assert.equal(h.records.results.length, 0);
});
test('Boss ad-free claim keeps the original result animation without restoring skip controls', () => {
  const free = harness({ phase: 'won', adEnabled: false }), ad = harness({ phase: 'won' });
  const visible = node => { for (let current = node; current; current = current.parent) if (!current.active) return false; return true; };
  for (const elapsed of [0, .34, .59, .99, 1, 1.15, 1.5, 2]) {
    free.state.resultElapsed = elapsed; ad.state.resultElapsed = elapsed;
    free.hud.update(.1); ad.hud.update(.1);
    assert.equal(visible(free.node(1892)), visible(ad.node(1892)), `${elapsed}: original entrance timing`);
    assert.equal(free.node(1892).worldScale.x, ad.node(1892).worldScale.x, `${elapsed}: original bounce scale`);
    assert.equal(free.node(1892).worldPosition.y, ad.node(1892).worldPosition.y, `${elapsed}: original position`);
    for (const id of [2016, 642, 1224, 906]) assert.equal(free.node(id).active, false, `${elapsed}: ${id} stays hidden`);
    assert.equal(free.text(87), '300');
  }
  assert.equal(visible(free.node(1892)), true);
});
test('Boss toggles the existing claim between free and advertised rewards', () => {
  const h = harness({ phase: 'won', resultElapsed: 2, adAvailable: false }); h.hud.update(2);
  h.click(1892); assert.equal(h.records.ads, 0); assert.equal(h.records.exits, 0);
  for (const enabled of [false, true, false]) {
    h.state.adEnabled = enabled; h.hud.update(0);
    assert.equal(h.node(1892).active, true); assert.equal(h.node(906).active, false);
    for (const id of [2016, 642, 1224]) assert.equal(h.node(id).active, enabled);
    assert.equal(h.text(87), enabled ? '900' : '300');
  }
  h.click(1892); assert.equal(h.records.exits, 1); assert.equal(h.records.ads, 0);
});
test('Boss disabling an active ad rejects its late callback and permits one free claim', () => {
  const h = harness({ phase: 'won', resultElapsed: 2 }); h.hud.update(2);
  let complete;
  const present = h.presenter.showRewardedAd;
  h.presenter.showRewardedAd = (token, placement, callback) => { complete = callback; present(token, placement, callback); };
  h.click(1892); assert.equal(h.records.ads, 1); assert.equal(h.state.phase, 'adPending');
  h.state.adEnabled = false; h.state.adAvailable = false; h.hud.update(0);
  assert.equal(h.state.phase, 'won'); assert.deepEqual(h.records.results, [{ outcome: 'cancel' }]);
  complete('success');
  assert.equal(h.state.phase, 'won'); assert.equal(h.records.results.length, 1);
  h.click(1892); h.click(1892); complete('success');
  assert.equal(h.state.phase, 'exiting'); assert.equal(h.records.exits, 1); assert.equal(h.records.ads, 1);
  assert.deepEqual(h.records.results, [{ outcome: 'cancel' }]);
});
test('Boss restored ads ignore the cancelled request while accepting the current result once', () => {
  const h = harness({ phase: 'won', resultElapsed: 2 }); h.hud.update(2);
  const completions = [], present = h.presenter.showRewardedAd;
  h.presenter.showRewardedAd = (token, placement, callback) => { completions.push(callback); present(token, placement, callback); };
  h.click(1892); h.state.adEnabled = false; h.hud.update(0);
  h.state.adEnabled = true; h.hud.update(0); h.click(1892);
  assert.equal(h.records.ads, 2); assert.equal(h.state.phase, 'adPending');
  completions[0]('success'); assert.equal(h.state.phase, 'adPending'); assert.equal(h.records.results.length, 1);
  completions[1]('success'); completions[1]('success');
  assert.equal(h.state.phase, 'exiting'); assert.equal(h.records.exits, 0);
  assert.deepEqual(h.records.results, [{ outcome: 'cancel' }, { token: 'ad-token-2', outcome: 'success' }]);
});
test('Boss failure exits without reward; ad cancellation leaves victory retryable', () => {
  const failed = harness({ phase: 'failed', resultElapsed: 2, adEnabled: false }); failed.hud.update(2);
  assert.equal(failed.text(2192), '0'); failed.click(1503); assert.equal(failed.records.exits, 1);
  const won = harness({ phase: 'won', resultElapsed: 2 }); won.hud.update(2);
  assert.equal(won.text(87), '900'); assert.equal(won.node(906).active, false);
  won.click(1892); assert.equal(won.records.ads, 1); won.hud.cancelInteractions();
  assert.equal(won.state.phase, 'won'); assert.equal(won.records.results.at(-1).outcome, 'cancel');
});
test('Boss preserves native final countdown text through failure for negative and exact-zero operands', () => {
  const { fixture, enter } = require('./support/boss-session-fixture.cjs');
  for (const [elapsed, expectedText] of [[60.125, '0s'], [60, '1s']]) {
    const session = fixture().session; enter(session); session.advanceFrame(elapsed);
    const h = harness(session.getBossState()); h.hud.update(0);
    assert.equal(h.state.phase, 'playing'); assert.equal(h.text(1188), expectedText);
    assert.equal(h.node(176).getComponent(h.UITransform).width, 0, 'negative time never creates a negative fill width');
    session.advanceFrame(.01); Object.assign(h.state, session.getBossState()); h.hud.update(.01);
    assert.equal(h.state.phase, 'failed'); assert.equal(h.text(1188), expectedText);
    session.advanceFrame(2); Object.assign(h.state, session.getBossState()); h.hud.update(2);
    assert.equal(h.node(1260).active, true); assert.equal(h.text(1188), expectedText);
    assert.equal(h.node(176).getComponent(h.UITransform).width, 0);
  }
});
test('Boss layout survives the three supported portrait sizes', () => {
  const h = harness(); h.hud.open();
  for (const [w, height] of [[360,640],[390,844],[412,915]]) {
    h.hud.resize(w,height); h.hud.update(.5);
    assert.equal(h.node(737).getComponent(h.UITransform).width, 1000);
    assert.ok(Math.abs(h.node(737).getComponent(h.UITransform).width * h.node(737).worldScale.x - w * 1000 / 1080) < 1e-6);
    assert.equal(h.text(1875), 'Lv.1'); assert.equal(h.text(1893), '50a');
    assert.ok(h.node(146).position.y > -height / (w/1080) / 2);
  }
});

test('Boss buttons keep finger ownership and invalidate outside, cancel, resize and background gestures', () => {
  for (const [phase, buttonId, action] of [['idle', 785, 'starts'], ['playing', 428, 'exits'], ['won', 1892, 'exits'], ['failed', 1503, 'exits']]) {
    const h = harness({ phase, resultElapsed: 2, adEnabled: false }); h.hud.resize(390, 844);
    if (phase === 'idle') h.hud.open(); h.hud.update(.31);
    const button = h.node(buttonId), outside = { x: 10000, y: 10000 };
    for (const [index, reason] of ['outside', 'cancel', 'resize', 'background'].entries()) {
      const finger = 30 + index; h.emit(button, 'start', finger); h.hud.update(.05);
      assert.equal(h.hud.touches.get(button)?.id, finger, `${phase}: press recorded`);
      if (reason === 'outside') h.emit(button, 'end', finger, outside);
      else if (reason === 'cancel') h.emit(button, 'cancel', finger);
      else if (reason === 'resize') h.hud.resize(412, 915, 44, 24);
      else h.hud.cancelInteractions();
      assert.equal(h.records[action], 0, `${phase}: ${reason} cannot activate`);
      assert.equal(h.hud.touches.has(button), false, `${phase}: ${reason} clears ownership`);
      h.emit(button, 'end', finger);
      assert.equal(h.records[action], 0, `${phase}: stale release after ${reason} cannot activate`);
      h.hud.update(.2); assert.equal(button.scale.x, 1, `${phase}: pressed scale restores`);
    }
    h.emit(button, 'start', 71); h.emit(button, 'start', 72);
    h.emit(button, 'cancel', 72); h.emit(button, 'end', 72);
    assert.equal(h.records[action], 0, `${phase}: another finger cannot activate`);
    assert.equal(h.hud.touches.get(button)?.id, 71, `${phase}: another finger cannot cancel the owner`);
    h.emit(button, 'end', 71); h.emit(button, 'end', 71);
    assert.equal(h.records[action], 1, `${phase}: owning finger activates exactly once`);
  }
});

test('Boss controls remain inside nonzero top and bottom safe insets in the renderer harness', () => {
  for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) {
    const h = harness({ adEnabled: false }), top = 44, bottom = 24;
    h.hud.resize(width, height, top, bottom); h.hud.open(); h.hud.update(.31);
    const insideSafeFrame = id => {
      const node = h.node(id), tr = node.getComponent(h.UITransform), p = node.worldPosition, s = node.worldScale;
      const left = p.x - tr.anchorX * tr.width * s.x, low = p.y - tr.anchorY * tr.height * s.y;
      const right = left + tr.width * s.x, high = low + tr.height * s.y;
      assert.ok(left >= -width / 2 - 1e-4 && right <= width / 2 + 1e-4, `${width}: ${id} horizontal bounds`);
      assert.ok(low >= -height / 2 + bottom - 1e-4 && high <= height / 2 - top + 1e-4, `${width}: ${id} safe vertical bounds`);
      for (let parent = node; parent; parent = parent.parent) assert.equal(parent.active, true, `${id}: visible`);
    };
    insideSafeFrame(785); h.hud.close();
    h.state.phase = 'playing'; h.hud.update(0);
    [176, 1188, 428].forEach(insideSafeFrame);
    h.state.phase = 'won'; h.state.resultElapsed = 2; h.hud.update(2); insideSafeFrame(1892);
    h.state.phase = 'failed'; h.hud.update(2); insideSafeFrame(1503);
  }
});
