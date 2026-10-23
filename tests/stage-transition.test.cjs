const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { assertResourceImageMetadata } = require('./support/resource-image-metadata.cjs');
const config = require('../assets/resources/art/stage-transition/config.json');
const viewRoot = path.join(__dirname, '../assets/scripts/view');
function load(name, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(viewRoot, name + '.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
    { module, exports: module.exports, require: key => { assert.ok(key in imports, key); return imports[key]; } });
  return module.exports;
}
const math = load('OriginalStageTransitionMath');
const confettiMath = load('OriginalWeaponConfettiMath', { './OriginalWeaponConfettiNoise': load('OriginalWeaponConfettiNoise') });
const near = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

function fixture() {
  class UITransform {
    width = 0; height = 0; anchorX = .5; anchorY = .5;
    setContentSize(width, height) { Object.assign(this, { width, height }); }
    setAnchorPoint(anchorX, anchorY) { Object.assign(this, { anchorX, anchorY }); }
    hitTest(point) { return point.inside; }
  }
  class Node {
    static EventType = { TOUCH_START: 'start', TOUCH_END: 'end', TOUCH_CANCEL: 'cancel' };
    constructor(name) { Object.assign(this, { name, children: [], components: new Map(), active: true, isValid: true,
      events: new Map(), angle: 0, position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }); }
    on(type, fn) { this.events.set(type, fn); }
    emit(type, event) { this.events.get(type)?.(event); }
    get activeInHierarchy() { return this.active && (!this.parent || this.parent.activeInHierarchy); }
    addChild(node) { node.parent = this; this.children.push(node); }
    addComponent(Type) { const value = new Type(); value.node = this; this.components.set(Type, value); return value; }
    getComponent(Type) { return this.components.get(Type); }
    getChildByName(name) { return this.children.find(c => c.name === name); }
    setPosition(x, y, z = 0) { this.position = { x, y, z }; }
    setScale(x, y, z = 1) { this.scale = { x, y, z }; }
    setRotationFromEuler(x, y, z) { assert.equal(x, 0); assert.equal(y, 0); this.angle = z; }
    setRotation(quaternion) { this.quaternion = quaternion; }
    destroy() { this.isValid = false; this.children.forEach(c => c.destroy()); }
  }
  class Color { static WHITE = new Color(255, 255, 255, 255); constructor(r, g, b, a) { Object.assign(this, { r, g, b, a }); } }
  class Graphics { clear() {} rect() {} fill() {} moveTo() {} lineTo() {} close() {} }
  class Label {
    static HorizontalAlign = { LEFT: 0, RIGHT: 1, CENTER: 2 }; static VerticalAlign = { TOP: 0, BOTTOM: 1, CENTER: 2 }; static Overflow = { SHRINK: 0, CLAMP: 1, NONE: 2 };
    updateRenderData() {
      const width = Array.from(this.string).reduce((sum, char) => sum + (/[\x20-\x7e]/.test(char) ? .55 : 1), 0) * this.fontSize;
      this.node.getComponent(UITransform).setContentSize(width, this.fontSize * 1.26);
      this.textLayoutData = { canvasSize: { height: this.fontSize * 1.26 }, startPosition: { x: 0, y: this.fontSize * .87 } };
    }
  }
  class LabelOutline {}
  class Font {}
  class Sprite { static SizeMode = { CUSTOM: 0 }; static Type = { SLICED: 0, TILED: 1, SIMPLE: 2 }; }
  class SpriteFrame { reset(value) { Object.assign(this, value); } destroy() {} }
  class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
  class Size { constructor(width, height) { Object.assign(this, { width, height }); } }
  class Mask { static Type = { GRAPHICS_RECT: 0 }; }
  class UIOpacity {}
  class BlockInputEvents {}
  class Vec3 { constructor(x, y, z) { Object.assign(this, { x, y, z }); } }
  class Quat { constructor(x, y, z, w) { Object.assign(this, { x, y, z, w }); } }
  const cc = { Color, Font, Graphics, Label, LabelOutline, Mask, Node, resources: {}, Sprite, SpriteFrame, Rect, Size, UITransform, UIOpacity, BlockInputEvents, Vec3, Vec2: Vec3, Quat };
  const makeNode = (name, parent) => { const node = new Node(name); node.addComponent(UITransform); if (parent) parent.addChild(node); return node; };
  const paths = [...Object.values(config.images).map(image => image.path), ...Object.values(config.bitmapFonts).flatMap(font => font.pages)];
  const art = { frames: new Map(paths.map(path => [path, { texture: { path } }])) };
  const bitmap = load('OriginalBitmapText', { cc, './ArtLibrary': { makeNode } });
  const ui = load('OriginalWeaponUi', { cc, './ArtLibrary': { makeNode }, './OriginalBitmapText': bitmap,
    './ResourceBatch': load('ResourceBatch', { './ResourceLoadingPolicy': load('ResourceLoadingPolicy', {}) }) });
  const confetti = load('OriginalWeaponConfetti', { cc, './OriginalWeaponConfettiMath': confettiMath });
  const { OriginalStageTransition } = load('OriginalStageTransition', {
    cc, './ArtLibrary': { makeNode }, './OriginalWeaponUi': ui, './OriginalWeaponConfetti': confetti,
    './OriginalStageTransitionMath': math,
    './OriginalWeaponFeedback': load('OriginalWeaponFeedback', { cc }),
  });
  const sounds = [], font = new Font();
  const view = new OriginalStageTransition(makeNode('Canvas'), art, { config, font }, { play: id => sounds.push(id) });
  const state = (transition, skip, mode = 'Main') => ({ mode, stageTransition: transition, stageSkip: skip });
  const node = id => view.ui.node(id);
  const active = kind => node(config.roots[kind]).active;
  const panel = kind => node(config.nodes[config.roots[kind]].children.find(id => config.nodes[id].name === 'Panel'));
  return { view, cc, node, state, active, panel, sounds, font };
}

test('source manifest includes complete original roots, CN text, graphics, clips and confetti', () => {
  assert.equal(Object.keys(config.nodes).length, 53); // 52 source nodes plus the short courier shirt layer.
  const bodyChildren = config.nodes['level0:1502'].children;
  const shirtIndex = bodyChildren.indexOf('fox-loading-body-art');
  assert.ok(shirtIndex > bodyChildren.indexOf('level0:1173') && shirtIndex > bodyChildren.indexOf('level0:1504'), 'shirt covers both animated foot roots');
  assert.ok(shirtIndex < bodyChildren.indexOf('level0:133'), 'hands stay above the shirt');
  assert.deepEqual(Object.values(config.nodes).filter(n => n.text).map(n => n.text.value).sort(),
    ['关卡通关！', '时间到！', '关卡跳过！', '狐狸移动中..', 'x2', '已通关关卡移动速度提升2倍。'].sort());
  assert.equal(config.bannerAnimation.source, 'sharedassets0.assets:274');
  assert.equal(config.loadingAnimation.source, 'sharedassets0.assets:262');
  assert.equal(config.bannerAnimation.duration, 1.5); assert.equal(config.loadingAnimation.duration, 2);
  assert.equal(config.loadingAnimation.loop, true);
  assert.equal(config.fontSource.file, 'sharedassets0.assets:321');
  config.nodes['level0:2074'].rotation.forEach((value, i) => near(value, [0, 1, 0, 0][i]));
  config.nodes['level0:10146'].rotation.forEach((value, i) => near(value, [0, -1, 0, 0][i]));
  assert.deepEqual(config.confetti.map(e => e.source.m_GameObject.m_PathID), [11322, 11323, 11324]);
  assert.equal(Object.values(config.nodes).filter(node => node.button).length, 3);
  for (const image of Object.values(config.images)) {
    assertResourceImageMetadata(path.join(__dirname, '../assets/resources'), image);
  }
});

test('original cubic tracks preserve bounce extrema and loading loop without invented easing', () => {
  const scale = config.bannerAnimation.bindings.find(b => b.property === 'scale').curves[0];
  near(math.sampleStageCurve(scale, 0), 0);
  near(math.sampleStageCurve(scale, .125), .75);
  near(math.sampleStageCurve(scale, .25), 1.5);
  near(math.sampleStageCurve(scale, .5833333134651184), 1);
  const y = config.bannerAnimation.bindings.find(b => b.property === 'y').curves[0];
  near(math.sampleStageCurve(y, 0), 100); near(math.sampleStageCurve(y, 1.5), 564.4000244140625);
  near(math.stageAnimationTime(config.bannerAnimation, 20), 1.5);
  near(math.stageAnimationTime(config.loadingAnimation, 4.25), .25);
});

test('win/fail/skip render original nodes and exactly-once result sounds; skip survives a round reveal', () => {
  const f = fixture(), t = { id: 1, kind: 'win', elapsed: .25, loadingElapsed: null };
  f.view.update(f.state(t)); assert.equal(f.active('win'), true); assert.equal(f.active('fail'), false);
  near(f.panel('win').scale.x, 1.5); assert.deepEqual(f.sounds, [11]);
  for (let i = 0; i < 3; i++) f.view.update(f.state(t)); assert.deepEqual(f.sounds, [11]);
  f.view.update(f.state({ id: 2, kind: 'fail', elapsed: .25, loadingElapsed: null }));
  assert.equal(f.active('win'), false); assert.equal(f.active('fail'), true); assert.deepEqual(f.sounds, [11, 12]);
  f.view.update(f.state(undefined, { id: 1, elapsed: .25 }));
  assert.equal(f.active('fail'), false); assert.equal(f.active('skip'), true); near(f.panel('skip').scale.x, 1.5);
  f.view.update(f.state(undefined, { id: 1, elapsed: 1.8 })); assert.equal(f.active('skip'), false);
  assert.deepEqual(f.sounds, [11, 12]);
});

test('loading fades only its original Background CanvasGroup, keeps the bottom strip opaque and animates the cat', () => {
  const f = fixture(), t = { id: 1, kind: 'win', elapsed: 2, loadingElapsed: 0 };
  f.view.update(f.state(t)); assert.equal(f.active('loading'), true);
  const fade = f.node(config.loadingCanvasGroup).getComponent(f.cc.UIOpacity);
  near(fade.opacity, 0);
  near(f.node('level0:2074').quaternion.y, 1);
  near(f.node('level0:2074').quaternion.z, 0);
  f.view.update(f.state({ ...t, elapsed: 2.3, loadingElapsed: .3 })); near(fade.opacity, 127.5, .0001);
  assert.equal(f.node('level0:147').getComponent(f.cc.UIOpacity), undefined);
  assert.ok(f.node('level0:2019').getComponent(f.cc.BlockInputEvents));
  assert.equal(f.node(config.roots.loading).getComponent(f.cc.BlockInputEvents), undefined);
  const animated = config.loadingAnimation.bindings.find(b => b.property === 'euler');
  near(f.node(animated.node).angle, math.sampleStageCurve(animated.curves[2], .3));
  f.view.update(f.state({ ...t, elapsed: 3.6, loadingElapsed: 1.6 })); near(fade.opacity, 255);
  assert.equal(f.active('loading'), true, 'reveal may cover the already-playing next round');
  f.view.update(f.state()); assert.equal(f.active('loading'), false);
});

test('progression view preserves source draw order, safe-area layout and moving UV tile periods across sizes', () => {
  const f = fixture();
  assert.deepEqual(f.view.node.children.map(n => n.name), ['GameWin_obj', 'GameFail_obj', 'GameSkip_obj', 'Loading_UI']);
  for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) {
    f.view.resize(width, height, 20, 10);
    near(f.view.node.scale.x, width / 1080); near(f.view.node.position.y, -5);
    const loading = f.node(config.roots.loading).getComponent(f.cc.UITransform);
    near(loading.width, 1080); near(loading.height, (height - 30) * 1080 / width);
    const scroll = f.view.scrolls.find(s => s.spec.scroll.tileSize === 400);
    near(scroll.tileWidth, 400); near(scroll.tileHeight, 400);
    f.view.update(f.state({ id: 1, kind: 'win', elapsed: 2.5, loadingElapsed: .5 }));
    near(scroll.tile.position.x, -540 + math.stageTextureOffset(-.30000001192092896, .5, 400));
  }
});

test('main and external loading cover notch and home-bar areas including the tiled clip throughout animation', () => {
  const f = fixture();
  function bounds(node) {
    let y = 0, scale = 1;
    for (let at = node; at; at = at.parent) { y = y * at.scale.y + at.position.y; scale *= at.scale.y; }
    const tr = node.getComponent(f.cc.UITransform);
    return [y - tr.height * tr.anchorY * scale, y + tr.height * (1 - tr.anchorY) * scale];
  }
  for (const [width, height, top, bottom] of [[360, 800, 40, 0], [390, 844, 47, 34], [1440, 3200, 160, 80], [360, 640, 0, 0]]) {
    f.view.resize(width, height, top, bottom);
    const backdrop = f.node('level0:2019'), hatch = f.node('level0:17820');
    const scroll = f.view.scrolls.find(s => s.node === hatch);
    for (const elapsed of [0, .1, .5, 1.7, 2.5]) {
      for (const external of [false, true]) {
        if (external) f.view.showExternalLoading(elapsed);
        else f.view.update(f.state({ id: 1, kind: 'win', elapsed: 2 + elapsed, loadingElapsed: elapsed }));
        for (const node of [backdrop, backdrop.getChildByName('OriginalImage'), hatch, scroll.tile.parent]) {
          const [low, high] = bounds(node); near(low, -height / 2); near(high, height / 2);
        }
        near(scroll.height, height * 1080 / width);
        assert.ok(backdrop.getComponent(f.cc.BlockInputEvents));
      }
    }
  }
});

test('source confetti really advances from snapshot time and is cleared on replacement/mode switch/disposal', () => {
  const f = fixture();
  f.view.update(f.state({ id: 1, kind: 'win', elapsed: 1.2, loadingElapsed: null }));
  assert.ok(f.view.confetti.simulation.count > 0);
  const count = f.view.confetti.simulation.count;
  f.view.update(f.state({ id: 1, kind: 'win', elapsed: 1.2, loadingElapsed: null }));
  assert.equal(f.view.confetti.simulation.count, count, 'identical snapshots must not emit again');
  f.view.update(f.state(undefined, undefined, 'Mine'));
  assert.equal(f.view.confetti.simulation.count, 0);
  assert.ok(['win', 'fail', 'skip', 'loading'].every(k => !f.active(k)));
  f.view.destroy(); f.view.destroy(); assert.equal(f.view.node.isValid, false);
});

test('replay keeps source x2 button, exact DOTween float/spin and original non-pausing explanation actions', () => {
  const f = fixture(), state = { ...f.state(), stageReplay: true, paused: false };
  f.view.update(state, .5);
  assert.equal(f.node(config.replayIndicator).active, true);
  assert.equal(f.node(config.replayExplain).active, false);
  near(f.node('level0:108').position.y, 31.5); near(f.node('level0:911').angle, -45);
  const button = f.node(config.replayIndicator);
  button.emit('start'); button.emit('end', { getLocation: () => ({ inside: false }) });
  assert.equal(f.node(config.replayExplain).active, false); assert.deepEqual(f.sounds, []);
  button.emit('start'); button.emit('end');
  assert.equal(f.node(config.replayExplain).active, true); assert.deepEqual(f.sounds, [1]);
  const copy = f.node('level0:10104'), text = copy.children.filter(node => node.active && node.name === 'SystemGlyph').map(node => node.getComponent(f.cc.Label));
  assert.equal(text.map(label => label.string).join(''), '已通关关卡移动速度提升2倍。');
  assert.ok(text.every(label => label.useSystemFont && label.fontFamily === 'sans-serif'));
  assert.equal(copy.children.filter(node => node.active && node.name === 'OriginalGlyph').length, 0, 'the 2 follows the Chinese system face');
  const badge = Object.values(config.nodes).find(node => node.text?.value === 'x2');
  assert.equal(f.node(badge.id).children.filter(node => node.active && node.name === 'OriginalGlyph').length, 2, 'the separate x2 badge retains its display face');
  f.view.update(state, .5); near(f.node('level0:108').position.y, 34); near(f.node('level0:911').angle, -90);
  f.node('level0:1805').emit('start'); f.node('level0:1805').emit('end');
  assert.equal(f.node(config.replayExplain).active, false); assert.deepEqual(f.sounds, [1, 1]);
  f.view.update(state, 1); near(f.node('level0:108').position.y, 29);
  f.view.update({ ...state, paused: true }, 1); near(f.node('level0:911').angle, -180);
  f.view.update({ ...state, stageReplay: false }); assert.equal(button.active, false);
  f.view.update({ ...state, mode: 'Mine' }); f.view.resize(360, 640);
  assert.equal(f.active('replay'), false); assert.equal(f.active('explain'), false);
});
