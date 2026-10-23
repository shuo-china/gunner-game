const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/offline-system/config.json');
const ids = config.offlineUi;

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
    static EventType = { TOUCH_START: 'start', TOUCH_END: 'end', TOUCH_CANCEL: 'cancel' };
    constructor(name) { Object.assign(this, { name, layer: 1 << 25, isValid: true, children: [], components: new Map(), events: new Map(), active: true, position: new Vec3(), scale: new Vec3(1, 1, 1) }); }
    addChild(node) { node.parent = this; this.children.push(node); }
    addComponent(Type) { const value = new Type(); value.node = this; this.components.set(Type, value); return value; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y, z = 0) { this.position = new Vec3(x, y, z); }
    setScale(x, y, z = 1) { this.scale = new Vec3(x, y, z); }
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
    constructor(owner) { pipelines.push(this); this.content = makeNode('OfflineLinear', owner); this.content.layer = 1 << 16; }
    setActive(value) { this.active = this.content.active = value; }
    invalidate() { this.dirty = true; this.invalidations++; }
    resize() { this.invalidate(); }
    *bindInputSteps() { this.bindInput(); yield; }
    bindInput() {}
    destroy() { this.destroyed = true; this.destroyCalls = (this.destroyCalls || 0) + 1; }
  }
  const imagePaths = [...Object.values(config.images).map(image => image.path), ...Object.values(config.bitmapFonts).flatMap(font => font.pages)];
  const art = { frames: new Map(imagePaths.map(p => { const frame = { texture: { path: p }, destroyCalls: 0, destroy() { this.destroyCalls++; } }; borrowed.push(frame); return [p, frame]; })),
    image: (name, spec, parent) => makeNode(name, parent),
    json: async p => { assert.equal(p, 'art/offline-system/config'); return config; },
    loadFrame: async p => { loads.push(p); if (options.failLoad) throw Error('offline asset failure'); } };
  const modules = { cc, './ArtLibrary': { makeNode }, './SkinHudColorPipeline': { SkinHudColorPipeline } };
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'OfflineHud']) {
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
      { module, exports: module.exports, setTimeout: callback => callback(), require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const state = { visible: true, before: { stageIndex: 0, stageLevel: 0, powerLevel: 2, speedLevel: 3, moneyLevel: 4, money: '99' },
    after: { stageIndex: 1, stageLevel: 3, powerLevel: 12, speedLevel: 8, moneyLevel: 9, money: '9K' },
    elapsedSeconds: 7200, absentSeconds: 36000, maxStage: 13, ...options.state };
  const records = { closes: 0, sounds: [], visibility: [] };
  const callbacks = { getState: () => options.empty ? null : state, close: () => { records.closes++; state.visible = false; },
    playSfx: value => records.sounds.push(value), onVisibilityChanged: value => records.visibility.push(value) };
  const assets = { config, chineseFont: null, originalFont: new Font(), numberFont: new Font() };
  const hud = new modules['./OfflineHud'].OfflineHud(makeNode('Canvas'), art, assets, callbacks, options.presentation ? {} : undefined, options.prepare);
  const node = id => hud.ui.node(ids[id] ?? id);
  const emit = (id, type, pointer = 1, position, originalType = type) => {
    const target = node(id), event = { getID: () => pointer, getUILocation: () => position ?? target.worldPosition, getEventCode: () => originalType };
    target.events.get(type)?.(event); return event;
  };
  const click = id => { emit(id, 'start'); emit(id, 'end'); };
  return { hud, art, assets, state, records, modules, callbacks, node, emit, click, UITransform, Label, Sprite, BlockInputEvents,
    makeNode, borrowed, glyphs, pipelines, loads, text: id => node(id).getComponent(Label)?.string };
}

test('offline catalog preserves original hierarchy, hidden state and fixed source Chinese without TTF', () => {
  assert.equal(config.roots.offline, 'level0:2147');
  assert.deepEqual(config.nodes['level0:490'].rect.size, [1000, 645.3358154296875]);
  for (const id of ['level0:1521', 'level0:1630', 'level0:202']) assert.equal(config.nodes[id].active, false);
  assert.equal(config.nodes['level0:2158'].mask, true);
  const buttons = Object.values(config.nodes).filter(n => n.button);
  assert.equal(buttons.length, 1); assert.equal(buttons[0].id, ids.close);
  assert.equal(buttons[0].button[0].method, 'SetActive');
  assert.equal(buttons[0].button[0].arguments.m_BoolArgument, 0);
  for (const [id, value] of [[ids.title, '欢迎回来！'], [ids.explanation, '离线进度不会超过最高关卡！']]) {
    const node = config.nodes[id];
    assert.equal(node.fixedText.value, value); assert.equal(node.fixedText.rasterScale, 4);
    assert.equal(node.fixedText.font.fontFile, 'sharedassets0.assets:321');
    assert.equal(node.fixedText.dynamicSourceAtlasWasEmpty, true);
    assert.equal(node.text, undefined); assert.ok(node.image.sprite);
  }
  assert.equal(config.fonts, undefined); assert.equal(config.fontVariants, undefined);
  for (const image of Object.values(config.images)) assert.ok(fs.existsSync(path.join(root, 'assets/resources', image.path + '.png')), image.path);
  for (const font of Object.values(config.bitmapFonts)) for (const page of font.pages) assert.ok(fs.existsSync(path.join(root, 'assets/resources', page + '.png')));
});

test('receipt shows zero-based stage conversion, original time units and max boundary without revealing Money', () => {
  const h = harness(); h.hud.update(.31);
  assert.equal(h.hud.isOpen, true); assert.equal(h.text('Time_txt'), '2h 0m');
  assert.equal(h.text('Stage_Before_txt'), 'Stage 1-1'); assert.equal(h.text('Stage_After_txt'), 'Stage 2-4');
  assert.equal(h.text('PowerLv_After_txt'), 'Lv.12'); assert.equal(h.text('SpeedLv_After_txt'), 'Lv.8');
  assert.equal(h.text('MoneyLv_After_txt'), 'Lv.9'); assert.equal(h.text('Money_After_txt'), '9K');
  for (const id of ['level0:1521', 'level0:1630', 'level0:202']) assert.equal(h.node(id).active, false);
  assert.equal(h.node('MaxStage_obj').active, true);
  h.state.maxStage = 14; h.state.absentSeconds = 7201; h.hud.update(0);
  assert.equal(h.node('MaxStage_obj').active, false);
  h.state.elapsedSeconds = 60; h.state.absentSeconds = 60.9; h.hud.update(0); assert.equal(h.text('Time_txt'), '1m 0s');
  const format = h.modules['./OfflineHud'].formatOfflineTime;
  for (const [seconds, text] of [[0,'0s'],[59.99,'59s'],[60,'1m 0s'],[3599.99,'59m 59s'],[3600,'1h 0m'],[28800,'8h 0m']]) assert.equal(format(seconds), text);
});

test('panel retains two-stage 0.3 second bounce, safe-area positioning and a live cached backdrop', () => {
  const h = harness({ presentation: true }), panel = h.node('panel');
  assert.equal(panel.scale.x, 0);
  h.hud.update(.18); assert.ok(Math.abs(panel.scale.x - 1.1) < 1e-6);
  h.hud.update(.12); assert.ok(Math.abs(panel.scale.x - 1) < 1e-6);
  h.hud.update(.01);
  const renders = h.pipelines[0].invalidations; h.hud.update(1);
  assert.equal(h.pipelines[0].invalidations, renders, 'settled receipt does not redraw its cached UI every frame');
  for (const [width, height, top, bottom] of [[360,640,0,0],[390,844,47,34],[412,915,0,0]]) {
    h.hud.resize(width, height, top, bottom);
    assert.equal(h.hud.node.scale.x, width / 1080);
    assert.equal(h.hud.node.position.y, (bottom - top) / 2);
    assert.equal(panel.position.y, -95);
    assert.equal(panel.getComponent(h.UITransform).width, 1000);
    assert.equal(h.node(ids.close).getComponent(h.UITransform).width, 100);
  }
  assert.ok(h.node(config.roots.offline).getComponent(h.BlockInputEvents));
  assert.ok(panel.getComponent(h.BlockInputEvents));
});

test('close button dismisses once; cancellation, wrong pointer and backdrop never dismiss or award', () => {
  const h = harness(); h.hud.update(.31);
  h.emit('close', 'start', 2); h.hud.update(.1);
  assert.ok(Math.abs(h.node('close').scale.x - .9) < 1e-6);
  h.emit('close', 'end', 3); assert.equal(h.records.closes, 0);
  h.emit('close', 'cancel', 2); h.hud.update(.11); assert.equal(h.records.closes, 0);
  h.emit('close', 'start'); h.hud.cancelInteractions(); h.emit('close', 'end'); assert.equal(h.records.closes, 0);
  h.click('level0:218'); assert.equal(h.records.closes, 0);
  h.click('close'); h.click('close');
  assert.equal(h.records.closes, 1); assert.deepEqual(h.records.sounds, [1]);
  assert.deepEqual(h.records.visibility, [true, false]); assert.equal(h.hud.isOpen, false);
  h.state.visible = true; h.hud.update(0); assert.equal(h.node('panel').scale.x, 0);
});

test('asset loading uses exact image manifests and failure leaves settlement state untouched', async () => {
  const h = harness(), load = h.modules['./OfflineHud'].loadOfflineHudAssets;
  await load(h.art);
  const paths = new Set([...Object.values(config.images).map(image => image.path), ...Object.values(config.bitmapFonts).flatMap(font => font.pages)]);
  assert.deepEqual(new Set(h.loads), paths);
  const failed = harness({ failLoad: true });
  await assert.rejects(failed.modules['./OfflineHud'].loadOfflineHudAssets(failed.art), /offline asset failure/);
  assert.equal(failed.records.closes, 0); assert.equal(failed.state.visible, true);
});

test('incremental preparation cancellation destroys owned UI only, preserving the pending receipt', async () => {
  const h = harness({ presentation: true, prepare: async steps => { for (let i = 0; i < 14; i++) steps.next(); throw Error('cancelled prepare'); } });
  assert.equal(h.hud.node.active, false);
  await assert.rejects(h.hud.prepared, /cancelled prepare/);
  h.hud.destroy(); h.hud.destroy();
  assert.equal(h.hud.node.destroyed, true); assert.equal(h.hud.ui.nodes.size, 0);
  assert.equal(h.pipelines[0].destroyCalls, 1); assert.equal(h.records.closes, 0); assert.equal(h.state.visible, true);
  assert.ok(h.borrowed.every(frame => frame.destroyCalls === 0));
});

test('destroying an open receipt does not dismiss session state or release borrowed atlas textures', () => {
  const h = harness({ presentation: true }); h.hud.update(.31);
  assert.equal(h.node('title').getComponent(h.Label), undefined);
  assert.equal(h.node('explanation').getComponent(h.Label), undefined);
  assert.equal(h.text('Stage_After_txt'), 'Stage 2-4');
  h.hud.destroy(); h.hud.destroy();
  assert.equal(h.records.closes, 0); assert.equal(h.state.visible, true);
  assert.ok(h.borrowed.every(frame => frame.destroyCalls === 0));
  assert.ok(h.glyphs.every(frame => frame.destroyCalls === 1));
});


test('managed receipt preparation paints state without activating its presentation before commit', async () => {
  let pending, finish;
  const phases = [];
  const prepare = steps => { pending = steps; return new Promise(resolve => { finish = resolve; }); };
  prepare.managed = true; prepare.layout = () => [720, 1600, 72, 36];
  prepare.trace = phase => phases.push(phase);
  const h = harness({ presentation: true, prepare });
  await Promise.resolve();
  for (;;) {
    const next = pending.next();
    assert.equal(h.hud.node.active, false);
    assert.equal(h.pipelines[0].active, false, 'hidden construction must not acquire the presentation target');
    assert.deepEqual(h.records.visibility, []);
    if (next.done) break;
  }
  finish(); await h.hud.prepared;
  assert.equal(h.hud.node.active, false);
  assert.equal(h.hud.isOpen, false);
  assert.equal(h.text('Stage_After_txt'), 'Stage 2-4');
  assert.equal(h.hud.node.scale.x, 720 / 1080);
  assert.equal(h.hud.node.position.y, -18);
  assert.ok(phases.includes('initialRefresh')); assert.ok(phases.includes('inputBinding'));
  h.hud.node.active = true; h.hud.update(0);
  assert.equal(h.hud.isOpen, true); assert.equal(h.pipelines[0].active, true);
  assert.deepEqual(h.records.visibility, [true]);
});
