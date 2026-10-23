const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/rebirth-system/config.json');

// Real source renderer and HUD, with only Cocos component/event primitives
// replaced. No test-only implementation of rebirth UI rules is exercised.
function harness(overrides = {}) {
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
  class Graphics { clear() {} rect() {} fill() {} }
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
  const modules = { cc, './ArtLibrary': { makeNode } };
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'RewardedAdModal', 'RebirthHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const amount = value => ({ format: () => String(value) });
  const state = { ruby: amount(100), count: 0, reward: amount('316.22'), enhancedReward: amount('948.66'), unlocked: true, canRebirth: true,
    adAvailable: true, adEnabled: true, paidVisible: false, phase: 'idle', animationElapsed: 0,
    upgrades: ['power', 'speed', 'money'].map(type => ({ type, level: 0, value: amount(0), price: amount(3), affordable: true })), ...overrides };
  const records = { alerts: [], sounds: [], visibility: [], requests: [], results: [], upgrades: [] };
  const canvas = makeNode('Canvas'); let request = null;
  const modal = new modules['./RewardedAdModal'].RewardedAdModal(canvas, (id, outcome) => {
    if (!request || request.token !== id) return; const current = request; request = null; current.complete(outcome);
  });
  const presenter = { showRewardedAd(token, placement, complete) { request = { token, placement, complete }; modal.open(token); },
    cancelRewardedAd(token) { if (request?.token === token) { request = null; modal.dismiss(); } } };
  const hud = new modules['./RebirthHud'].RebirthHud(canvas, art,
    { config, chineseFont: new Font(), originalFont: new Font(), numberFont: new Font() }, {
      getState: () => state,
      requestRebirth: mode => { records.requests.push(mode); state.phase = mode === 'ad' ? 'adPending' : 'animating'; return { ok: true, token: mode === 'ad' ? 'ad-token' : undefined }; },
      completeAd: (token, outcome) => { records.results.push({ token, outcome }); state.phase = outcome === 'success' ? 'animating' : 'idle'; return { ok: outcome === 'success' }; },
      cancelAd: () => { records.results.push({ outcome: 'cancel' }); state.phase = 'idle'; },
      purchaseUpgrade: type => { records.upgrades.push(type); state.upgrades.find(u => u.type === type).level++; return true; },
      alert: value => records.alerts.push(value), playSfx: id => records.sounds.push(id), onVisibilityChanged: visible => records.visibility.push(visible),
    }, presenter);
  const node = id => hud.ui.node(`level0:${id}`);
  const event = (target, id = 1, at, originalType) => ({ getID: () => id, getUILocation: () => at || target.worldPosition, getEventCode: () => originalType });
  const emit = (target, type, id, at, originalType = type) => target.events.get(type)?.(event(target, id, at, originalType));
  const clickNode = target => { emit(target, 'start'); emit(target, 'end'); };
  const click = id => clickNode(node(id));
  const text = id => node(id).getComponent(Label).string;
  return { hud, modal, presenter, state, records, node, click, clickNode, emit, text, amount, UITransform, Label, RichText, Sprite, atlases, borrowedFrames, bitmapFrames, LabelOutline, LabelShadow };
}

test('rebirth keeps authored numeric glyphs and effects while Chinese uses the system font', () => {
  const h = harness(); h.state.reward = h.amount('484'); h.state.enhancedReward = h.amount('1.45a'); h.hud.open();
  const ordinary = h.node(9881).getComponent(h.Label), enhanced = h.node(9867).getComponent(h.Label);
  assert.equal(ordinary.fontSize, 41.5);
  assert.equal(enhanced.fontSize, 55, 'the 50.15 serialized preview must grow back to source maximum 55 for current text');
  assert.equal(h.node(9867).getComponent(h.LabelOutline), undefined);
  assert.equal(ordinary.enabled, false, 'platform Label only retains accessible/debug text; actual glyphs are source atlas sprites');
  assert.equal(config.nodes['level0:9867'].text.characterSpacing, 9);
  for (const id of [9881, 9867, 23415, 4375, 4854]) {
    assert.equal(h.node(id).children.filter(node => node.getComponent(h.Label) || node.getComponent(h.RichText)).length, 0,
      'source glyphs never layer multiple platform labels');
    assert.ok(h.node(id).children.some(node => node.name === 'OriginalGlyph'));
  }
  const chinese = h.node(7074).children.filter(node => node.active && node.name === 'SystemGlyph').map(node => node.getComponent(h.Label));
  assert.equal(chinese.map(label => label.string).join(''), '攻击力永久提升');
  assert.ok(chinese.every(label => label.font === null && label.useSystemFont && label.fontFamily === 'sans-serif'));
  assert.equal(h.node(7074).children.filter(node => node.active && node.name === 'OriginalGlyph').length, 0);
  assert.equal(config.bitmapFonts['1006:75'].glyphs['48'].origin, 'source-sdf');
  assert.equal(config.bitmapFonts['1002:3'].glyphs[String('转'.codePointAt(0))], undefined, 'Chinese is absent from the packaged display-font atlas');
  assert.ok(h.node(7074).getComponent(h.Label).fontSize < 36, 'source Chinese ascent/descent controls the small title box');
  const dailyProfile = config.textProfiles[config.nodes['level0:476'].text.profile];
  assert.equal(dailyProfile.source.font, 'sharedassets0.assets:1011', 'daily fraction retains its actual Playpen Sans Thai source face');
});

test('level labels apply the original active kern feature and unchanged UI refreshes reuse glyphs and frames', () => {
  const h = harness(), text = h.node(4375), spec = config.nodes['level0:4375'].text;
  const font = config.bitmapFonts[spec.profile], label = h.hud.ui.bitmapTexts.get(text);
  const scale = label.fontSize / font.pointSize;
  assert.equal(spec.kerning, true);
  assert.ok(Math.abs(font.kerning['76:118'][0][2] + 5.4) < .00001, 'the source L/v pair advances -5.4 at 90 points');
  const [L, v] = text.children.filter(node => node.name === 'OriginalGlyph');
  const expected = (font.glyphs['76'].advance - 5.4 + font.glyphs['118'].bearingX - font.glyphs['76'].bearingX) * scale + spec.characterSpacing * label.fontSize / 100;
  assert.ok(Math.abs(v.position.x - L.position.x - expected) < .00001);
  const nodes = [...text.children], frames = h.bitmapFrames.length;
  h.hud.open(); h.hud.update(.1); h.hud.update(.1);
  assert.equal(text.children.length, nodes.length);
  assert.ok(text.children.every((node, index) => node === nodes[index]));
  assert.equal(h.bitmapFrames.length, frames, 'no frame or glyph allocation occurs on an unchanged frame');
});

test('the shipped engine module selection retains RichText required by source inline currency tags', () => {
  const engine = JSON.parse(fs.readFileSync(path.join(root, 'settings/v2/packages/engine.json'), 'utf8'));
  const selected = engine.modules.configs[engine.modules.globalConfigKey];
  assert.ok(selected, 'the build has a selected engine configuration');
  const sourceHasInlineText = Object.values(config.nodes).some(node => /<sprite=\d+>/.test(node.text?.value || ''));
  assert.equal(sourceHasInlineText, true, 'rebirth requires image glyphs within Chinese sentences');
  assert.equal(selected.cache['rich-text']?._value, true, 'RichText must survive engine module stripping');
  assert.ok(selected.includeModules.includes('rich-text'), 'build includeModules must include the runtime component');
});

test('source inline sprite metrics share text baselines and teardown releases owned frame views without destroying borrowed textures', () => {
  const h = harness();
  assert.equal(h.atlases.length, 0);
  for (const id of [10069, 10204]) {
    const currency = h.node(id).children.find(node => node.getComponent(h.Sprite)?.spriteFrame?.texture?.path === config.images[config.inlineSprites['2']].path);
    // Source art frames are borrowed directly (without creating a rich-text atlas).
    const image = h.node(id).children.find(node => h.borrowedFrames.includes(node.getComponent(h.Sprite)?.spriteFrame));
    assert.ok(image || currency);
  }
  assert.equal(config.inlineSpriteMetrics['2'].bearingY, 119.5);
  assert.equal(config.inlineSpriteMetrics['2'].scale, 1.2);
  const owned = [...h.bitmapFrames]; assert.ok(owned.length > 0);
  h.hud.destroy(); h.hud.destroy();
  assert.equal(h.hud.node.active, false); assert.equal(h.hud.node.destroyed, true);
  assert.ok(owned.every(frame => frame.destroyCalls === 1));
  assert.equal(h.hud.ui.nodes.size, 0);
  assert.ok(h.borrowedFrames.every(frame => frame.destroyCalls === 0));
});

test('rebirth asset provenance retains source roots, Chinese terms, padded sprites and animation', () => {
  assert.equal(config.source.language, 'resources.assets:2063'); assert.equal(config.source.languageIndex, 3);
  assert.deepEqual(config.roots, { entry: 'level0:1482', main: 'level0:1518', normal: 'level0:1311', ad: 'level0:632', fx: 'level0:15057' });
  assert.equal(Object.keys(config.nodes).length, 120);
  assert.equal(config.images[config.inlineSprites['2']].source, 'sharedassets0.assets:159'); assert.equal(config.images.s501.source, 'sharedassets0.assets:501');
  for (const image of Object.values(config.images)) assert.ok(fs.existsSync(path.join(root, 'assets/resources', image.path + '.png')));
  assert.equal(config.animation.duration, 2); assert.equal(config.animation.tracks.length, 10);
  config.animation.tracks.forEach((track, i) => {
    assert.ok(Math.abs(track.active.find(key => key.coefficients[3] === 1).time - i / 6) < 1e-6);
    assert.ok(Math.abs(track.bounce.duration - .3) < 1e-6);
    assert.deepEqual(config.nodes[track.node].rect.size, [3000, 3000]);
    assert.equal(config.nodes[track.node].image.color[3], 75);
  });
});

test('historical unlock and current stage execution gate are independent', () => {
  const h = harness({ unlocked: false, canRebirth: false, unlockMessage: '第7关起可用。', actionMessage: '到达第9关后可转生。' }); h.click(1482);
  assert.equal(h.hud.isOpen, false); assert.equal(h.records.alerts[0], '第7关起可用。');
  h.state.unlocked = true; h.hud.update(.1); h.click(1482);
  assert.equal(h.node(2136).active, false); assert.equal(h.hud.isOpen, true);
  h.click(849); assert.equal(h.node(1311).active, false); assert.equal(h.records.requests.length, 0);
  assert.equal(h.records.alerts[1], '到达第9关后可转生。', 'both messages come from the shared policy rather than a fixed stage');
});

test('active tutorial hides the rebirth entry, blocks direct opening and restores its normal unlock behavior', () => {
  const h = harness(); h.hud.setContentBlocked(true);
  assert.equal(h.node(1482).active, false);
  h.hud.open(); h.click(1482); h.hud.update(.2); h.hud.resize(540, 1100, 20, 30);
  assert.equal(h.hud.isOpen, false); assert.equal(h.node(1482).active, false);
  assert.deepEqual(h.records.alerts, []); assert.deepEqual(h.records.visibility, []);
  h.hud.setContentBlocked(false); assert.equal(h.node(1482).active, true);
  h.hud.open(); assert.equal(h.hud.isOpen, true); h.hud.close();
  h.state.unlocked = false; h.hud.setContentBlocked(true); h.hud.setContentBlocked(false);
  h.hud.open(); assert.equal(h.hud.isOpen, false); assert.equal(h.records.alerts.length, 1);
});

test('covering the rebirth entry preserves tutorial and unlock visibility rules across refreshes', () => {
  const h = harness(); h.hud.setEntryBlocked(true);
  h.hud.setContentBlocked(true); h.hud.setContentBlocked(false);
  h.hud.update(.1); h.hud.resize(540, 1100, 20, 30);
  assert.equal(h.node(1482).active, true, 'the source menu stays drawn under the modal after a tutorial ends');
  h.click(1482); assert.equal(h.hud.isOpen, false, 'refresh does not remove the input block');
  h.hud.setContentBlocked(true); h.hud.setEntryBlocked(false);
  assert.equal(h.node(1482).active, false, 'removing a modal input block cannot bypass the tutorial');
  h.hud.setContentBlocked(false); assert.equal(h.node(1482).active, true);
  h.state.unlocked = false; h.hud.update(0); assert.equal(h.node(1482).active, true, 'locked rebirth keeps its explanatory entry');
  h.click(1482); assert.equal(h.hud.isOpen, false); assert.equal(h.records.alerts.length, 1);
});

test('covering the rebirth entry cancels held input and rejects new presses without blocking popup controls', () => {
  const h = harness(), entry = h.node(1482);
  h.emit(entry, 'start', 7); h.hud.update(.05); assert.equal(h.hud.touches.has(entry), true);
  h.hud.setEntryBlocked(true);
  assert.equal(entry.active, true); assert.equal(h.hud.touches.has(entry), false); assert.equal(entry.scale.x, 1);
  h.click(1482); assert.equal(h.hud.isOpen, false); assert.equal(h.hud.touches.has(entry), false);
  h.hud.setEntryBlocked(false); h.emit(entry, 'end', 7);
  assert.equal(h.hud.isOpen, false); assert.deepEqual(h.records.sounds, []);
  h.click(1482); assert.equal(h.hud.isOpen, true, 'a fresh press remains usable');
  h.hud.setEntryBlocked(true); assert.equal(h.hud.selectedButton, null);
  h.click(849); assert.equal(h.node(1311).active, true, 'popup controls remain usable');
});

test('tutorial blocking closes an existing panel once and tolerates synchronous visibility callback reentry', () => {
  const h = harness(); h.hud.open(); h.click(849); assert.equal(h.node(1311).active, true);
  const previous = h.hud.callbacks.onVisibilityChanged;
  h.hud.callbacks.onVisibilityChanged = visible => { previous(visible); h.hud.setContentBlocked(true); };
  h.hud.setContentBlocked(true);
  assert.equal(h.hud.isOpen, false); assert.equal(h.node(1311).active, false); assert.equal(h.node(1482).active, false);
  assert.deepEqual(h.records.visibility, [true, false]);
  for (let frame = 0; frame < 10; frame++) { h.hud.setContentBlocked(true); h.hud.update(.1); }
  assert.deepEqual(h.records.visibility, [true, false]); assert.deepEqual(h.records.requests, []);
});

test('tutorial blocking cannot dismiss an already running rebirth transaction or revive its hidden entry', () => {
  const h = harness(); h.hud.open(); h.click(849); h.hud.start(); h.hud.update(.1);
  assert.equal(h.state.phase, 'animating'); assert.equal(h.node(15057).active, true);
  h.hud.setContentBlocked(true);
  assert.equal(h.node(1482).active, false); assert.equal(h.node(15057).active, true);
  assert.equal(h.hud.isOpen, true); assert.deepEqual(h.records.requests, ['normal']);
  h.state.phase = 'idle'; h.hud.update(.1);
  assert.equal(h.hud.isOpen, false); assert.equal(h.node(1482).active, false);
  h.hud.setContentBlocked(false); assert.equal(h.node(1482).active, true);
});

test('disabled rebirth advertising hides its entire reward panel and confirmation while normal rebirth remains usable', () => {
  const h = harness({ adEnabled: false }); h.hud.open();
  assert.equal(h.node(754).active, false); assert.equal(h.node(1999).active, false); assert.equal(h.node(943).active, false);
  h.click(1999); h.hud.openConfirmation('ad');
  assert.equal(h.node(632).active, false); assert.equal(h.records.requests.length, 0);
  h.click(849); assert.equal(h.node(1311).active, true);
  h.hud.start(); assert.deepEqual(h.records.requests, ['normal']);
});

test('ad-free rebirth removes the reward row space while preserving upgrades across portrait safe areas', () => {
  const bounds = (h, id) => {
    const node = h.node(id), tr = node.getComponent(h.UITransform), p = node.worldPosition, s = node.worldScale;
    return { x: p.x, y: p.y, width: tr.width * s.x, height: tr.height * s.y,
      left: p.x - tr.width * s.x * tr.anchorX, bottom: p.y - tr.height * s.y * tr.anchorY,
      right: p.x + tr.width * s.x * (1 - tr.anchorX), top: p.y + tr.height * s.y * (1 - tr.anchorY) };
  };
  const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);
  const rowSpacing = config.nodes['level0:170'].rect.position[1] - config.nodes['level0:754'].rect.position[1];
  for (const [width, height, top, bottom] of [[360, 640, 0, 0], [390, 844, 44, 34], [412, 915, 24, 28]]) {
    const full = harness(), free = harness({ adEnabled: false, adAvailable: false });
    for (const h of [full, free]) { h.hud.resize(width, height, top, bottom); h.hud.open(); h.hud.update(0); }
    const fullPanel = bounds(full, 949), freePanel = bounds(free, 949), removedHeight = rowSpacing * width / config.referenceWidth;
    near(fullPanel.height - freePanel.height, removedHeight, 'exactly one row and its spacing collapse');
    near(freePanel.bottom, fullPanel.bottom, 'outer bottom edge stays fixed');
    near(bounds(free, 170).y, bounds(full, 754).y, 'normal reward occupies the removed advertisement row');
    near(bounds(free, 1850).y, bounds(full, 1850).y - removedHeight, 'angel follows the shorter panel');
    near(bounds(free, 378).y, bounds(full, 378).y - removedHeight, 'close button follows the shorter panel');
    for (const id of [33411, 19508, 19507, 1680, 1568]) {
      const before = bounds(full, id), after = bounds(free, id);
      for (const key of ['x', 'y', 'width', 'height']) near(after[key], before[key], `${id}: upgrade section ${key} is preserved`);
    }
    assert.ok(bounds(free, 170).bottom > bounds(free, 1568).top, 'normal reward leaves a gap above the upgrade separator');
    for (const id of [170, 849, 33411, 19508, 19507, 378]) {
      const box = bounds(free, id);
      assert.ok(box.left >= -width / 2 - 1e-6 && box.right <= width / 2 + 1e-6, `${id}: fits viewport width`);
      assert.ok(box.bottom >= -height / 2 + bottom - 1e-6 && box.top <= height / 2 - top + 1e-6, `${id}: fits vertical safe area`);
    }
    assert.equal(free.node(754).active, false);
    free.hud.resize(width, height, top, bottom); free.hud.update(.1);
    near(bounds(free, 949).height, freePanel.height, 'resizing preserves the collapsed height');
    near(bounds(free, 170).y, bounds(full, 754).y, 'resizing preserves the collapsed reward position');
  }
});

test('rebirth advertisement layout restores without drift or shared configuration changes', () => {
  const source = JSON.stringify(config), h = harness(); h.hud.resize(390, 844, 44, 34); h.hud.open();
  const geometry = () => [949, 1619, 170, 1850, 378, 33411, 19508, 19507, 1568].map(id => {
    const node = h.node(id), tr = node.getComponent(h.UITransform);
    return [node.worldPosition.x, node.worldPosition.y, tr.width, tr.height];
  });
  const original = geometry();
  h.state.adAvailable = false; h.hud.update(0);
  assert.deepEqual(geometry(), original, 'daily exhaustion does not collapse the advertising row');
  assert.equal(h.node(754).active, true); assert.equal(h.node(1999).active, false); assert.equal(h.node(943).active, true);
  let collapsed;
  for (let pass = 0; pass < 3; pass++) {
    h.state.adEnabled = false; h.hud.update(0); h.hud.resize(390, 844, 44, 34);
    if (!collapsed) collapsed = geometry();
    else assert.deepEqual(geometry(), collapsed, 'repeated collapse does not accumulate offsets');
    h.state.adEnabled = true; h.hud.update(0);
    assert.deepEqual(geometry(), original, 'reenabling restores the source layout exactly');
    assert.equal(h.node(754).active, true); assert.equal(h.node(943).active, true);
  }
  h.state.adEnabled = false; h.hud.update(0);
  const other = harness(); other.hud.open();
  assert.equal(other.node(949).getComponent(other.UITransform).height, config.nodes['level0:949'].rect.size[1]);
  assert.equal(JSON.stringify(config), source, 'per-HUD collapse never mutates shared source assets');
});

test('rebirth layout switches cancel held gestures before repeats and keep relocated actions usable', () => {
  for (const enabled of [false, true]) {
    const h = harness({ adEnabled: !enabled }); h.hud.open();
    const upgrade = h.node(9529), normal = h.node(849);
    h.emit(upgrade, 'start', 7); h.emit(normal, 'start', 8); h.hud.update(.3);
    h.state.adEnabled = enabled; h.hud.update(.2);
    assert.equal(h.hud.touches.size, 0, 'layout changes release captured fingers before the hold delay');
    h.emit(upgrade, 'end', 7); h.emit(normal, 'end', 8); h.hud.update(.5);
    assert.deepEqual(h.records.upgrades, []); assert.deepEqual(h.records.requests, []);
    assert.equal(h.node(1311).active, false); assert.equal(upgrade.scale.x, 1); assert.equal(normal.scale.x, 1);
    h.click(9529); assert.deepEqual(h.records.upgrades, ['power']);
    h.click(849); assert.equal(h.node(1311).active, true);
    h.click(1398); h.click(1398); assert.deepEqual(h.records.requests, ['normal']);
    assert.equal(h.state.phase, 'animating');
  }
});

test('turning off rebirth advertising cancels an open request and rejects its old completion', () => {
  const h = harness(); let stale;
  const present = h.presenter.showRewardedAd;
  h.presenter.showRewardedAd = (token, placement, complete) => { stale = complete; present(token, placement, complete); };
  h.hud.open(); h.click(1999); h.click(1256);
  assert.equal(h.state.phase, 'adPending');
  h.state.adEnabled = false; h.hud.update(0); stale('success');
  assert.equal(h.state.phase, 'idle'); assert.equal(h.modal.isOpen, false); assert.equal(h.node(754).active, false);
  assert.equal(h.node(632).active, false); assert.deepEqual(h.records.results, [{ outcome: 'cancel' }]);
});

test('main reward holds its original snapshot while each confirmation reads current reward', () => {
  const h = harness(); h.hud.open(); assert.equal(h.text(9881), '316.22');
  h.state.reward = h.amount('397.99'); h.hud.update(1); assert.equal(h.text(9881), '316.22');
  h.click(849); assert.equal(h.text(9846), '397.99');
  h.click(2168); h.click(378); h.hud.open(); assert.equal(h.text(9881), '397.99');
});

test('source sprite tag is an inline purple currency glyph inside the full Chinese sentence', () => {
  const h = harness(), text = h.node(10069), label = text.getComponent(h.Label);
  assert.ok(label.string.includes('\n')); assert.ok(!label.string.includes('\\')); assert.ok(label.string.includes('并获得可用于永久强化的'));
  assert.equal(text.getComponent(h.Label).enabled, false);
  const inline = text.children.find(node => node.getComponent(h.Sprite)?.spriteFrame?.texture?.path === config.images[config.inlineSprites['2']].path);
  assert.ok(inline, 'the original currency sprite is emitted between the Chinese sentence and final punctuation');
  const bitmap = h.hud.ui.bitmapTexts.get(text);
  assert.ok(Math.abs(inline.getComponent(h.UITransform).width / bitmap.fontSize - 1.392) < .00001,
    'pointSize zero in the original sprite asset uses font ascent and sprite scale, yielding 1.392 em');
  const spriteIndex = text.children.indexOf(inline);
  assert.ok(spriteIndex > 0 && spriteIndex < text.children.length - 1);
});

test('original menu layout places rebirth above pet, fish, skin and gun across safe areas', () => {
  const h = harness();
  for (const [width, height, top, bottom] of [[360, 640, 0, 0], [390, 844, 44, 34], [412, 915, 24, 28]]) {
    h.hud.resize(width, height, top, bottom);
    assert.ok(Math.abs(h.node(1482).worldPosition.y - (-height / 2 + bottom + 855 * width / 1080)) < 1e-6);
  }
});

test('permanent upgrades use source hold delay and interval; cancel and late release cannot buy', () => {
  const h = harness(); h.hud.open(); const button = h.node(9529);
  h.emit(button, 'start'); h.hud.update(.39); assert.equal(h.records.upgrades.length, 0);
  h.hud.update(.011); assert.equal(h.records.upgrades.length, 1);
  h.hud.update(.04); assert.equal(h.records.upgrades.length, 2);
  h.emit(button, 'end'); assert.equal(h.records.upgrades.length, 3); assert.equal(h.text(4375), 'Lv.3');
  h.emit(button, 'start'); h.hud.cancelInteractions(); h.emit(button, 'end'); assert.equal(h.records.upgrades.length, 3);
  h.emit(button, 'start'); h.hud.update(4); assert.equal(h.records.upgrades.length, 4, 'one coroutine step after a slow frame');
  h.emit(button, 'cancel'); h.hud.update(1); assert.equal(h.records.upgrades.length, 4);
});

test('leaving a source button stops only its hold; returning can still click without restarting repeats', () => {
  const h = harness(); h.hud.open(); const button = h.node(9529);
  h.emit(button, 'start'); h.hud.update(.401);
  assert.equal(h.records.upgrades.length, 1);
  const outside = { x: button.worldPosition.x + 1000, y: button.worldPosition.y };
  h.emit(button, 'move', 1, outside); h.hud.update(.5);
  assert.equal(h.records.upgrades.length, 1, 'serialized EventTrigger PointerExit invokes OnHoldEnd');
  assert.ok(button.scale.x < .901, 'BounceBtn has no PointerExit handler and stays pressed');
  h.emit(button, 'move'); h.hud.update(.5);
  assert.equal(h.records.upgrades.length, 1, 'there is no OnHoldStart on PointerEnter');
  h.emit(button, 'end');
  assert.equal(h.records.upgrades.length, 2, 'Unity Button retains the original press and clicks on release inside');
  h.hud.update(.101); assert.equal(button.scale.x, 1);

  const normal = h.node(849);
  h.emit(normal, 'start'); h.emit(normal, 'move', 1, outside); h.emit(normal, 'move'); h.emit(normal, 'end');
  assert.equal(h.node(1311).active, true, 'non-upgrade buttons also retain their original press through pointer exit');
});

test('release outside recovers source button scale without invoking its action', () => {
  const h = harness(); h.hud.open(); const button = h.node(9529);
  h.emit(button, 'start'); h.hud.update(.101); h.emit(button, 'cancel');
  assert.ok(button.scale.x < .901, 'Cocos outside release is TOUCH_CANCEL, not an immediate source OnDisable');
  h.hud.update(.05); assert.ok(button.scale.x > .9 && button.scale.x < 1);
  h.hud.update(.051); assert.equal(button.scale.x, 1);
  assert.equal(h.records.upgrades.length, 0);
});

test('rapid rebirth repress preserves the original BounceBtn concurrent coroutine timers', () => {
  const h = harness(); h.state.upgrades[0].affordable = false; h.hud.open(); const button = h.node(9529);
  h.emit(button, 'start'); h.hud.update(.05);
  assert.ok(Math.abs(button.scale.x - .95) < .00001);
  h.emit(button, 'end'); h.hud.update(.02);
  assert.ok(Math.abs(button.scale.x - .92) < .00001, 'short release uses fixed WantSize, not the current scale');
  h.emit(button, 'start'); h.hud.update(.025);
  assert.ok(Math.abs(button.scale.x - .95) < .00001,
    'repress resets shared Down_time, but both old and newly started coroutine chains advance it by dt');
  h.emit(button, 'end'); h.hud.update(.025);
  assert.ok(Math.abs(button.scale.x - .95) < .00001, 'both surviving chains also advance the shared Up_time');
  h.hud.update(.051); assert.equal(button.scale.x, 1);
  h.emit(button, 'start'); h.hud.update(.025);
  assert.ok(Math.abs(button.scale.x - .975) < .00001, 'finished release chains do not carry into the next independent press');
  assert.equal(h.records.upgrades.length, 0);
});

test('source raycast text outside an upgrade image forwards one click to its parent button', () => {
  const h = harness(); h.hud.open(); const button = h.node(9529), title = h.node(26939);
  assert.equal(config.nodes['level0:26939'].text.raycast, true);
  const at = { x: title.worldPosition.x + 160, y: title.worldPosition.y };
  assert.ok(at.x > button.worldPosition.x + button.getComponent(h.UITransform).width / 2);
  h.emit(title, 'start', 1, at); h.hud.update(.051); h.emit(title, 'end', 1, at);
  assert.deepEqual(h.records.upgrades, ['power']);
  assert.deepEqual(h.records.sounds, [4], 'the descendant graphic routes once instead of triggering parent and child');
});

test('a release over another graphic of the same button remains a click, while a real cancellation cannot click', () => {
  const h = harness(); h.hud.open(); const button = h.node(9529), title = h.node(26939);
  const at = { x: title.worldPosition.x + 160, y: title.worldPosition.y };
  h.emit(title, 'start', 1, at);
  h.emit(title, 'move', 1, button.worldPosition);
  h.emit(title, 'cancel', 1, button.worldPosition, 'end');
  assert.equal(h.records.upgrades.length, 1, 'Cocos outside-child release retains its original END event code');
  h.emit(title, 'start', 1, at); h.emit(title, 'cancel', 1, button.worldPosition);
  assert.equal(h.records.upgrades.length, 1, 'an actual system cancellation is not a release click');
});

test('hold hit testing excludes gaps between source graphics and handles a stationary finger outside the shrinking image', () => {
  const h = harness(); h.hud.open(); const button = h.node(9529), title = h.node(26939);
  const textPoint = { x: title.worldPosition.x + 160, y: title.worldPosition.y };
  const gap = { x: button.worldPosition.x + 160, y: button.worldPosition.y - 55 };
  h.emit(title, 'start', 1, textPoint); h.emit(title, 'move', 1, gap); h.hud.update(.5);
  h.emit(title, 'cancel', 1, gap, 'end');
  assert.equal(h.records.upgrades.length, 0, 'the union bounding box includes this gap but no original Graphic does');
  h.hud.update(.101);
  const edge = { x: button.worldPosition.x + 137, y: button.worldPosition.y };
  h.emit(button, 'start', 1, edge); h.hud.update(.101); h.hud.update(.5);
  assert.equal(h.records.upgrades.length, 0, 'the original per-frame raycast sees the 0.9-scale image leave the stationary finger');
  h.emit(button, 'cancel', 1, edge, 'end');
  assert.equal(h.records.upgrades.length, 0);
});

test('a confirmation masks both new and already captured touches on underlying buttons', () => {
  const h = harness(); h.hud.open(); const upgrade = h.node(9529);
  h.emit(upgrade, 'start'); h.click(849); h.emit(upgrade, 'end'); h.click(9529);
  assert.equal(h.node(1311).active, true); assert.equal(h.records.upgrades.length, 0);
  h.click(1999); assert.equal(h.node(632).active, false, 'a masked main-panel action cannot replace the front popup');
});

test('opening confirmations and starting FX preserve the underlying release animation and selected color', () => {
  const h = harness(); h.hud.open(); const normal = h.node(849);
  h.emit(normal, 'start'); h.hud.update(.101); h.emit(normal, 'end');
  assert.equal(h.node(1311).active, true);
  assert.ok(normal.scale.x < .901, 'opening a sibling confirmation does not disable BounceBtn');
  h.hud.update(.05); assert.ok(normal.scale.x > .9 && normal.scale.x < 1);
  h.hud.update(.051); assert.equal(normal.scale.x, 1);

  const apply = h.node(1398), spec = config.nodes['level0:1398'];
  const sprite = apply.children.find(node => node.name === 'OriginalImage').getComponent(h.Sprite);
  h.emit(apply, 'start'); h.hud.update(.101); h.emit(apply, 'end');
  assert.equal(h.state.phase, 'animating'); assert.ok(apply.scale.x < .901);
  h.state.animationElapsed = .05; h.hud.update(.05); assert.ok(apply.scale.x > .9 && apply.scale.x < 1);
  h.state.animationElapsed = .101; h.hud.update(.051); assert.equal(apply.scale.x, 1);
  assert.equal(sprite.color.r, Math.round(spec.image.color[0] * 245 / 255), 'source FX activation does not deselect the confirm button');
});

test('daily-ad adapter forwards string ticket once, and supports cancellation, failure and success', () => {
  for (const [index, outcome] of [[0, 'success'], [1, 'cancel'], [2, 'failure']]) {
    const h = harness(); h.hud.open(); h.click(1999); h.click(1256);
    assert.equal(h.state.phase, 'adPending');
    const button = h.modal.node.children[0].children.find(node => node.name === `Ad${index}`);
    h.clickNode(button); h.clickNode(button);
    assert.deepEqual(h.records.results, [{ token: 'ad-token', outcome }]);
    assert.equal(h.state.phase, outcome === 'success' ? 'animating' : 'idle');
    if (outcome === 'failure') assert.equal(h.records.alerts[0], '广告加载失败。');
  }
});

test('paid confirmation and every purchase entry are absent from the exported UI', () => {
  const h = harness({ adAvailable: false }); h.hud.open();
  assert.equal(config.roots.paid, undefined);
  assert.equal(config.nodes['level0:823'], undefined);
  assert.equal(config.nodes['level0:1659'], undefined);
  assert.ok(Object.values(config.nodes).every(node => !/IAP|NoAds|FreeCash/.test(node.name) && !/\$\d/.test(node.text?.value ?? '')));
  assert.equal(h.node(943).active, true, 'the exhausted daily reward keeps its original disabled state');
});

test('rebirth handles immediate provider failure once and releases its local ticket', () => {
  const h = harness();
  h.presenter.showRewardedAd = (token, placement, complete) => {
    assert.equal(placement, 'rebirth'); complete('failure'); complete('success');
  };
  h.hud.open(); h.click(1999); h.click(1256);
  assert.equal(h.state.phase, 'idle'); assert.equal(h.modal.isOpen, false);
  assert.deepEqual(h.records.results, [{ token: 'ad-token', outcome: 'failure' }]);
});

test('source animation derives all circles from session time and closes every rebirth popup on completion', () => {
  const h = harness(); h.hud.open(); h.click(849); h.click(1398);
  assert.equal(h.state.phase, 'animating'); assert.equal(h.node(15057).active, true);
  h.state.animationElapsed = .15; h.hud.update(.15);
  assert.ok(Math.abs(h.node(11852).scale.x - .5) < 1e-6); assert.equal(h.node(12197).active, false);
  h.state.animationElapsed = 1.9; h.hud.update(1.75);
  assert.ok(config.animation.tracks.every(track => h.hud.ui.node(track.node).active));
  assert.equal(h.records.sounds.filter(id => id === 6).length, 1);
  h.state.phase = 'idle'; h.hud.update(.1); assert.equal(h.hud.isOpen, false);
  assert.deepEqual(h.records.visibility, [true, false]);
});

test('rebirth buttons retain original ColorTint timing, selection and scale together', () => {
  const h = harness(); h.hud.open(); const button = h.node(849), spec = config.nodes['level0:849'];
  const sprite = button.children.find(node => node.name === 'OriginalImage').getComponent(h.Sprite);
  const rgb = () => [sprite.color.r, sprite.color.g, sprite.color.b];
  const color = factor => spec.image.color.slice(0, 3).map(channel => Math.round(channel * factor / 255));
  assert.deepEqual(spec.buttonColors.pressed, [200, 200, 200, 255]);
  h.emit(button, 'enter'); h.hud.update(.101); assert.deepEqual(rgb(), color(245));
  h.emit(button, 'leave', 1, { x: button.worldPosition.x + 1000, y: button.worldPosition.y }); h.hud.update(.101); assert.deepEqual(rgb(), color(255));
  h.emit(button, 'start'); h.hud.update(.05);
  assert.ok(sprite.color.r < spec.image.color[0] && sprite.color.r > color(200)[0], 'source .1 second tint interpolates');
  assert.ok(button.scale.x < 1 && button.scale.x > .9);
  h.hud.update(.051); assert.deepEqual(rgb(), color(200));
  h.emit(button, 'end'); h.hud.update(.101); assert.deepEqual(rgb(), color(245), 'original selectable remains selected after pointer-up');
});

test('exhausted daily button keeps its original bounce and failure sound without opening a popup', () => {
  const h = harness({ adAvailable: false, paidVisible: false }); h.hud.open(); const button = h.node(943);
  h.emit(button, 'start'); h.hud.update(.101); assert.ok(button.scale.x < .901);
  h.emit(button, 'end'); h.hud.update(.101); assert.equal(button.scale.x, 1);
  assert.deepEqual(h.records.sounds, [5]); assert.equal(h.records.requests.length, 0);
  assert.ok(!h.node(632).active);
});

test('unaffordable upgrades retain independent BounceBtn feedback but cannot click or hold-purchase', () => {
  const h = harness(); h.state.upgrades[0].affordable = false; h.hud.open(); const button = h.node(9529);
  const beforeReward = h.text(9881); h.state.reward = h.amount('different logical reward');
  h.emit(button, 'start'); h.hud.update(.101); assert.ok(button.scale.x < .901);
  h.hud.update(.5); h.emit(button, 'end'); h.hud.update(.101);
  assert.equal(h.records.upgrades.length, 0); assert.equal(h.records.sounds.length, 0);
  assert.equal(button.scale.x, 1); assert.equal(h.text(9881), beforeReward, 'a stopped source hold does not reload the main panel');
});

test('a hold that exhausts currency stops without refreshing the reward after logical stage advances', () => {
  const h = harness(); h.hud.open(); const button = h.node(9529);
  const purchase = h.hud.callbacks.purchaseUpgrade;
  h.hud.callbacks.purchaseUpgrade = type => {
    const result = purchase(type); h.state.upgrades[0].affordable = false; return result;
  };
  h.emit(button, 'start'); h.hud.update(.401);
  assert.equal(h.records.upgrades.length, 1); assert.equal(h.text(4375), 'Lv.1');
  const purchasedReward = h.text(9881); h.state.reward = h.amount('397.99');
  h.hud.update(.041); h.hud.update(1); h.emit(button, 'end');
  assert.equal(h.records.upgrades.length, 1); assert.deepEqual(h.records.sounds, [4]);
  assert.equal(h.text(9881), purchasedReward, 'the original hold coroutine exits before calling Upgrade or Reload when currency is insufficient');
});
