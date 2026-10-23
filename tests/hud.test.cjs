const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const scripts = path.join(root, 'assets/scripts/view');
const config = JSON.parse(fs.readFileSync(path.join(root, 'assets/resources/art/hud/config.json'), 'utf8'));
const upgrades = JSON.parse(fs.readFileSync(path.join(root, 'assets/resources/art/upgrades/config.json'), 'utf8'));
const stageTransition = require('../assets/resources/art/stage-transition/config.json');
const decimal = require('./.build/core/DecimalAmount.js');
const { DecimalAmount } = decimal;

function load(name, imports = {}) {
  imports['./FontPolicyLabel'] ??= require('./support/font-policy-handle.cjs');
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(scripts, `${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  vm.runInNewContext(compiled, { module, exports: module.exports, require: name => {
    assert.ok(name in imports, `Unexpected import ${name}`); return imports[name];
  } });
  return module.exports;
}
const math = load('HudMath', { '../core/DecimalAmount': decimal });

function fixture() {
  const nodes = [], labels = [], assets = [];
  class UITransform {
    writes = 0;
    setContentSize(width, height) { this.width = width; this.height = height; this.writes++; }
    setAnchorPoint(x, y) { this.anchor = [x, y]; }
    hitTest(position) { return position.inside !== false && (!position.region || position.region === this.node.name); }
  }
  class Node {
    static EventType = { TOUCH_START: 'start', TOUCH_MOVE: 'move', TOUCH_END: 'touch', TOUCH_CANCEL: 'cancel' };
    constructor(name = '') { this.name = name; this.children = []; this.components = new Map(); this.listeners = []; this.active = true; this.isValid = true; this.destroyCalls = 0; nodes.push(this); }
    addChild(child) { child.parent = this; this.children.push(child); }
    addComponent(Type) {
      const component = new Type(); component.node = this; this.components.set(Type, component);
      // Real Cocos Label starts with overflow NONE and autosizes default text.
      if (Type === Label) this.getComponent(UITransform).setContentSize(102.4, 50.4);
      return component;
    }
    getComponent(Type) { return this.components.get(Type); }
    getChildByName(name) { return this.children.find(n => n.name === name); }
    setPosition(...value) { this.position = value; }
    setScale(...value) { this.scale = value; }
    on(name, fn) { this.listeners.push({ name, fn }); }
    emit(name, event) { this.listeners.filter(e => e.name === name).forEach(e => e.fn(event)); }
    removeFromParent() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = undefined; }
    setSiblingIndex(index) { const parent = this.parent; this.removeFromParent(); this.parent = parent; parent.children.splice(index, 0, this); }
    destroy() { if (!this.isValid) return; this.destroyCalls++; this.isValid = false; this.children.slice().forEach(n => n.destroy()); this.listeners.length = 0; }
  }
  class Label {
    static Overflow = { NONE: 0, SHRINK: 1 };
    static HorizontalAlign = { CENTER: 1, RIGHT: 2 };
    static VerticalAlign = { CENTER: 1 };
    constructor() { labels.push(this); this.writes = 0; }
    set string(value) { this.value = value; this.writes++; }
    get string() { return this.value; }
  }
  class Sprite { static Type = { SLICED: 1 }; }
  class Mask { static Type = { GRAPHICS_RECT: 0 }; }
  class Graphics { roundRect() {} fill() {} stroke() {} }
  class Color { constructor(...rgba) { this.rgba = rgba; } static WHITE = new Color(255, 255, 255, 255); }
  class Vec2 { constructor(x, y) { this.x = x; this.y = y; } }
  class Font { destroyCalls = 0; destroy() { this.destroyCalls++; } }
  class BlockInputEvents {}
  const cc = { Node, UITransform, Label, Sprite, Mask, Graphics, Color, Vec2, Font, BlockInputEvents };
  function makeNode(name, parent) { const node = new Node(name); node.addComponent(UITransform); if (parent) parent.addChild(node); return node; }
  const font = new Font(); assets.push(font);
  const frames = new Map([...Object.values(config.images), ...Object.values(upgrades.images)].map(spec => [spec.path, { destroyCalls: 0 }]));
  const art = { frames, image(name, spec, parent) {
    assert.ok(spec && frames.has(spec.path), `Missing sprite for ${name}`);
    const node = makeNode(name, parent); node.addComponent(Sprite).spriteFrame = frames.get(spec.path); return node;
  } };
  const upgradeModule = load('UpgradeHud', { cc, './ArtLibrary': { makeNode }, './UpgradeInput': load('UpgradeInput') });
  // The actual source hierarchy/clip renderer has its own component-level suite.
  class OriginalStageTransition {
    constructor(parent) { this.node = makeNode('OriginalStageTransitions', parent); }
    resize() {}
    update(state) { this.state = state; }
    showExternalLoading(elapsed) { this.loadingElapsed = elapsed; }
    destroy() { this.node.destroy(); }
  }
  const { GameHud } = load('GameHud', { cc, './ArtLibrary': { makeNode }, './HudMath': math, './UpgradeHud': upgradeModule,
    './OriginalStageTransition': { OriginalStageTransition }, './FloatingJoystick': {} });
  let restarts = 0, settingsOpened = 0; const purchases = [];
  const hud = new GameHud(new Node('Canvas'), art, { config, font, upgrades, upgradeFont: font }, () => restarts++, type => {
    purchases.push(type); return true;
  }, undefined, () => settingsOpened++);
  const state = { mode: 'Main', stageIndex: 0, waveIndex: 0, kills: 0, totalTrees: 30,
    remainingSeconds: 180, durationSeconds: 180, elapsed: 0, paused: false, complete: false, resultsReady: false, money: DecimalAmount.from(0), diamonds: 0,
    upgrades: ['power', 'speed', 'money'].map(type => ({ type, level: 0, value: DecimalAmount.from(100), price: DecimalAmount.from(50), affordable: false, progress: 0 })) };
  const find = (node, name) => node.name === name ? node : node.children.map(n => find(n, name)).find(Boolean);
  return { hud, state, cc, nodes, labels, frames, font, find, purchases, restarts: () => restarts, settingsOpened: () => settingsOpened };
}

test('source ratios and wallet formatting handle round boundaries without overstating gold', () => {
  assert.equal(math.completionRatio(1, 3), 1 / 3);
  assert.equal(math.completionRatio(30, 30), 1);
  assert.equal(math.completionRatio(1, 0), 0);
  assert.equal(math.timeRatio(-2, 180), 0);
  assert.equal(math.timeRatio(360, 180), 1);
  assert.equal(math.timeRatio(100, 0), 0);
  assert.equal(math.stageLabel(1, 4), 'Stage 2-5');
  assert.equal(math.stageLabel(NaN, 999), 'Stage 1-5');
  for (const [amount, expected] of [[0, '0'], [999, '999'], [1000, '1a'], [1001, '1a'],
    [12345, '12.34a'], [999999, '999.99a'], [1000000, '1b'], [1000000000, '1c']]) {
    assert.equal(math.formatGold(amount, config.format.units), expected);
  }
  assert.equal(math.formatGold(Infinity, config.format.units), '0');
  assert.equal(math.formatDiamonds(12.9), '12');
});

test('HUD mounts only Main and restores fresh state after repeated mode switches', () => {
  const f = fixture();
  f.hud.update({ ...f.state, mode: 'Mine' });
  assert.equal(f.find(f.hud.node, 'Main_UI'), undefined);
  f.hud.update(f.state);
  const first = f.find(f.hud.node, 'Main_UI');
  assert.equal(f.find(first, 'Stage_txt').getComponent(f.cc.Label).string, 'Stage 1-1');
  assert.equal(f.find(f.hud.node, 'EquipmentBar'), undefined);
  for (const mode of ['Mine', 'SpeedRun', 'Boss', 'Monster', 'Raid']) {
    f.hud.update({ ...f.state, mode, complete: true, resultsReady: true });
    assert.equal(f.find(f.hud.node, 'Main_UI'), undefined);
    assert.equal(f.find(f.hud.node, 'CompleteOverlay'), undefined);
    assert.equal(f.hud.transition.state.mode, mode);
    f.hud.update({ ...f.state, waveIndex: 4, stageIndex: 2, money: 12345 });
    const main = f.find(f.hud.node, 'Main_UI');
    assert.equal(f.find(main, 'Stage_txt').getComponent(f.cc.Label).string, 'Stage 3-5');
    assert.equal(f.find(main, 'Player_Icon').position[0], 240);
    assert.equal(f.find(f.find(main, 'Money'), 'Price_txt').getComponent(f.cc.Label).string, '12.34a');
  }
  assert.equal(first.active, false); assert.equal(first.destroyCalls, 1);
  f.hud.destroy(); f.hud.destroy();
  assert.equal(f.hud.node.destroyCalls, 1); assert.equal(f.font.destroyCalls, 0);
  assert.ok(Array.from(f.frames.values()).every(frame => frame.destroyCalls === 0));
});

test('600 identical HUD snapshots do not rebuild text, geometry or fill masks', () => {
  const f = fixture(); f.hud.update(f.state);
  const writes = f.labels.map(label => label.writes);
  const transforms = f.nodes.map(node => node.getComponent(f.cc.UITransform)).filter(Boolean);
  const dimensions = transforms.map(tr => tr.writes), count = f.nodes.length;
  for (let i = 0; i < 600; i++) f.hud.update(f.state);
  assert.deepEqual(f.labels.map(label => label.writes), writes);
  assert.deepEqual(transforms.map(tr => tr.writes), dimensions);
  assert.equal(f.nodes.length, count);
  f.hud.update({ ...f.state, kills: 15, remainingSeconds: 90, money: 1000, diamonds: 3 });
  const main = f.find(f.hud.node, 'Main_UI');
  assert.equal(f.find(main, 'Value_txt').getComponent(f.cc.Label).string, '50%');
  assert.equal(f.find(main, 'ValueFill').getComponent(f.cc.UITransform).width, 540);
  assert.equal(f.find(main, 'TimeFill').getComponent(f.cc.UITransform).width, 540);
  f.hud.update({ ...f.state, remainingSeconds: -10 });
  assert.equal(f.find(main, 'TimeFill').active, false);
});

test('settings entry opens once on matching release and cancels outside, other fingers and modal transitions', () => {
  const f = fixture(); f.hud.update(f.state);
  const button = () => f.find(f.hud.node, 'Setting_Btn');
  const event = (id = 1, inside = true) => ({ getID: () => id, getLocation: () => ({ inside }) });
  button().emit('touch', event()); assert.equal(f.settingsOpened(), 0, 'release without press cannot open');
  button().emit('start', event()); f.hud.update(f.state, .1);
  assert.equal(button().scale[0], .9);
  button().emit('touch', event(2)); assert.equal(f.settingsOpened(), 0, 'another finger cannot release the gesture');
  button().emit('touch', event()); button().emit('touch', event());
  assert.equal(f.settingsOpened(), 1);
  button().emit('start', event()); button().emit('touch', event(1, false));
  button().emit('start', event()); button().emit('cancel', event()); button().emit('touch', event());
  assert.equal(f.settingsOpened(), 1);
  button().emit('start', event()); f.hud.setModalOpen(true); button().emit('touch', event());
  assert.equal(f.settingsOpened(), 1); assert.equal(button().scale[0], 1);
  button().emit('start', event()); button().emit('touch', event()); assert.equal(f.settingsOpened(), 1);
  f.hud.setModalOpen(false); button().emit('start', event()); button().emit('touch', event());
  assert.equal(f.settingsOpened(), 2);
  f.hud.destroy();
});

test('settings entry rejects paused and loading input and discards gestures across remount and destruction', () => {
  const f = fixture(); f.hud.update(f.state);
  const event = { getID: () => 1, getLocation: () => ({ inside: true }) };
  const press = () => f.find(f.hud.node, 'Setting_Btn').emit('start', event);
  const release = () => f.find(f.hud.node, 'Setting_Btn').emit('touch', event);
  press(); f.hud.update({ ...f.state, paused: true }); release();
  press(); release(); assert.equal(f.settingsOpened(), 0);
  f.hud.update(f.state); press(); f.hud.setLoadingOverlay(0); f.hud.update(f.state); release();
  assert.equal(f.settingsOpened(), 0);
  f.hud.setLoadingOverlay(null); f.hud.update(f.state); press();
  const stale = f.find(f.hud.node, 'Setting_Btn');
  f.hud.update({ ...f.state, mode: 'Raid' }); f.hud.update(f.state); release();
  stale.emit('touch', event); assert.equal(f.settingsOpened(), 0);
  press(); release(); assert.equal(f.settingsOpened(), 1);
  const current = f.find(f.hud.node, 'Setting_Btn'); press(); f.hud.destroy();
  current.emit('touch', event); assert.equal(f.settingsOpened(), 1);
});

test('original font, overlapping bars and safe-area geometry remain independent of results', () => {
  const f = fixture(); f.hud.resize(720, 1280, 30, 12); f.hud.update(f.state);
  const main = f.find(f.hud.node, 'Main_UI');
  assert.equal(main.scale[0], 2 / 3); assert.equal(main.position[1], 610);
  assert.equal(f.find(main, 'Time_Slider').position[1], -33.5);
  assert.equal(f.find(main, 'Value_Slider').position[1], -18.5);
  const timeIndex = main.children.indexOf(f.find(main, 'Time_Slider'));
  assert.ok(timeIndex < main.children.indexOf(f.find(main, 'Value_Slider')));
  const stage = f.find(main, 'Stage_txt').getComponent(f.cc.Label);
  assert.equal(stage.font, null); assert.equal(stage.enabled, false); assert.equal(stage.policyFont, config.bitmapFont); assert.equal(stage.enableOutline, true);
  assert.equal(stage.node.getComponent(f.cc.UITransform).width, config.layout.stageTextSize[0]);
  assert.equal(stage.node.getComponent(f.cc.UITransform).height, config.layout.stageTextSize[1]);
  for (const [name, bounds] of [['Money', config.layout.moneyTextSize], ['Dia', config.layout.diamondTextSize]]) {
    const background = f.find(main, name), text = f.find(background, 'Price_txt'), icon = f.find(background, 'Image');
    const tr = text.getComponent(f.cc.UITransform), iconTr = icon.getComponent(f.cc.UITransform);
    assert.ok(tr.width < bounds[0]); assert.equal(tr.height, bounds[1]);
    assert.ok(text.position[0] - tr.width / 2 >= icon.position[0] + iconTr.width / 2 + 4 - .001);
    assert.ok(text.position[0] + tr.width / 2 <= background.getComponent(f.cc.UITransform).width / 2 - 8 + .001);
  }
  f.hud.update({ ...f.state, complete: true, kills: 30, elapsed: 61.2 });
  assert.equal(f.find(f.hud.node, 'CompleteOverlay'), undefined);
  f.hud.update({ ...f.state, complete: true, resultsReady: true, kills: 30, elapsed: 61.2 });
  assert.equal(f.find(f.hud.node, 'CompleteOverlay'), undefined);
  assert.equal(f.find(main, 'Value_txt').getComponent(f.cc.Label).string, '100%');
  assert.equal(f.find(f.hud.node, 'PlayAgain'), undefined); assert.equal(f.restarts(), 0);
  const transition = { id: 1, kind: 'win', elapsed: .25, loadingElapsed: null };
  f.hud.update({ ...f.state, stageTransition: transition });
  assert.equal(f.hud.transition.state.stageTransition, transition);
  assert.equal(f.hud.node.children[0], f.hud.transition.node);
  f.hud.update(f.state); assert.equal(f.hud.transition.state.stageTransition, undefined);
  f.hud.destroy(); f.hud.update(f.state); assert.equal(f.hud.node.isValid, false);
});

test('exported font subset retains the source identity and all source assets have explicit borders', () => {
  assert.equal(config.font.sourceSha256, '90aa76fcfd9fe49a615c7c0475a545be91cc41e13ba9e41fe83441ff9c5604df');
  const file = path.join(root, `assets/resources/${config.font.path}.ttf`);
  assert.ok(fs.statSync(file).size < 50000);
  assert.equal(fs.readFileSync(file).readUInt32BE(0), 0x10000);
  assert.deepEqual(config.images.bar.border, [55, 11, 55, 10]);
  assert.equal(config.images.money_icon.source, 'sharedassets0.assets:375');
  assert.equal(config.images.hatch.source, 'sharedassets0.assets:144');
  assert.equal(config.format.units[0], 'a'); assert.equal(config.format.units[26], 'aa');
});

test('asset loader preloads HUD and stage glyphs without invoking a platform TTF loader', async () => {
  class Font {}
  const framePaths = [];
  const allConfigs = { 'art/hud/config': config, 'art/upgrades/config': upgrades, 'art/stage-transition/config': stageTransition };
  const art = { json: async name => { assert.ok(name in allConfigs); return allConfigs[name]; },
    loadFrame: async name => { framePaths.push(name); return {}; } };
  const { loadOriginalHudAssets } = load('OriginalHudAssets', { cc: { Font, resources: {
    load: () => { throw new Error('platform TTF unavailable'); },
  } } });
  const result = await loadOriginalHudAssets(art);
  assert.ok(result.font instanceof Font); assert.equal(result.config, config);
  assert.equal(result.upgradeFont, result.font); assert.equal(result.upgrades, upgrades);
  assert.equal(result.stageTransition.config, stageTransition); assert.equal(result.stageTransition.font, result.font);
  const expected = new Set([...Object.values(config.images), ...Object.values(upgrades.images), ...Object.values(stageTransition.images)].map(image => image.path));
  for (const page of config.bitmapFont.pages) expected.add(page);
  for (const bitmap of Object.values(stageTransition.bitmapFonts)) for (const page of bitmap.pages) expected.add(page);
  assert.deepEqual(new Set(framePaths), expected);
  await assert.rejects(loadOriginalHudAssets({ ...art, loadFrame: async () => { throw new Error('glyph page unavailable'); } }), /glyph page unavailable/);
});

test('original upgrade cards render bottom safe-area geometry, vertical affordability and Max', () => {
  const f = fixture(); f.hud.resize(720, 1280, 30, 24); f.hud.update(f.state);
  const list = f.find(f.hud.node, 'Upgrade_List');
  assert.equal(list.scale[0], 2 / 3); assert.equal(list.position[1], -530);
  for (const [i, type] of ['power', 'speed', 'money'].entries()) {
    const card = f.find(list, `Upgrade_${type}`);
    assert.equal(card.position[0], upgrades.layout.centers[i]);
    assert.equal(card.getComponent(f.cc.UITransform).width, 300);
    assert.equal(f.find(card, 'Title_txt').getComponent(f.cc.Label).string, upgrades.titles[i]);
    assert.equal(f.find(card, 'Title_txt').getComponent(f.cc.Label).fontSize, 32);
    assert.equal(f.find(card, 'Value_txt').getComponent(f.cc.Label).string, '100');
    assert.equal(f.find(card, 'Value_txt').getComponent(f.cc.Label).fontSize, 45);
    assert.ok(f.find(card, 'Value_txt').getComponent(f.cc.Label).lineHeight <= upgrades.layout.valueSize[1]);
    assert.equal(f.find(card, 'Lv_txt').getComponent(f.cc.Label).horizontalAlign, f.cc.Label.HorizontalAlign.RIGHT);
    assert.equal(f.find(card, 'Price_txt').getComponent(f.cc.Label).string, '50');
    assert.deepEqual(f.find(card, 'Price_txt').getComponent(f.cc.Label).color.rgba, upgrades.palette.insufficient);
  }
  f.hud.update({ ...f.state, upgrades: f.state.upgrades.map(item => ({ ...item, progress: .5 })) });
  const power = f.find(list, 'Upgrade_power'), fill = f.find(power, 'Fill');
  assert.equal(fill.getComponent(f.cc.UITransform).width, 300);
  assert.equal(fill.getComponent(f.cc.UITransform).height, upgrades.layout.size[1] / 2);
  assert.deepEqual(fill.getComponent(f.cc.UITransform).anchor, [.5, 0]);
  assert.equal(fill.position[1], -upgrades.layout.size[1] / 2);
  f.hud.update({ ...f.state, upgrades: f.state.upgrades.map(item => ({ ...item, affordable: true, progress: 1 })) });
  assert.equal(f.find(power, 'UpgradeAble_obj').active, true); assert.equal(fill.active, false);
  f.hud.update({ ...f.state, upgrades: f.state.upgrades.map(item => ({ ...item, level: 10000, price: null, affordable: false })) });
  assert.equal(f.find(power, 'Lv_txt').getComponent(f.cc.Label).string, 'Lv.10000');
  assert.equal(f.find(power, 'Price_txt').getComponent(f.cc.Label).string, 'Max');
  assert.equal(f.find(power, 'Price_txt').getComponent(f.cc.Label).color, f.cc.Color.WHITE);
  assert.equal(f.find(power, 'UpgradeAble_obj').active, false); assert.equal(fill.active, false);
});

test('upgrade gestures retain original hold on pointer exit but cancel on release outside, pause and mode changes', () => {
  const f = fixture(); f.hud.update(f.state);
  const event = (id = 1, inside = true) => ({ getID: () => id, getLocation: () => ({ inside }) });
  const getCard = () => f.find(f.hud.node, 'Upgrade_power');
  getCard().emit('start', event()); f.hud.update(f.state, .39); assert.equal(f.purchases.length, 0);
  f.hud.update(f.state, .01); assert.deepEqual(f.purchases, ['power']);
  getCard().emit('touch', event()); assert.deepEqual(f.purchases, ['power', 'power']);
  getCard().emit('start', event()); getCard().emit('move', event(1, false));
  f.hud.update(f.state, .4); assert.equal(f.purchases.length, 3, 'original has no pointer-exit hold cancellation');
  getCard().emit('touch', event(1, false)); assert.equal(f.purchases.length, 3, 'outside release does not add a click');
  for (const stoppedState of [{ ...f.state, paused: true }, { ...f.state, complete: true, resultsReady: true }]) {
    f.hud.update(f.state); getCard().emit('start', event()); f.hud.update(stoppedState, 1);
    getCard().emit('touch', event()); assert.equal(f.purchases.length, 3);
  }
  assert.equal(f.find(f.hud.node, 'Shade'), undefined, 'source transition owns input blockers, no invented full-screen result shade');
  f.hud.update(f.state); getCard().emit('start', event()); f.hud.cancelInteractions();
  getCard().emit('touch', event()); assert.equal(f.purchases.length, 3);
  getCard().emit('start', event()); f.hud.update({ ...f.state, mode: 'Boss' }, 1);
  assert.equal(f.find(f.hud.node, 'Upgrade_List'), undefined);
  f.hud.update(f.state, 1); assert.equal(f.purchases.length, 3);
  f.hud.destroy(); assert.ok(f.nodes.filter(n => n.name === 'Upgrade_List').every(n => !n.isValid));
});

test('upgrade title and level raycasts share one purchase with the panel and reject cancellation or another pointer', () => {
  const f = fixture(); f.hud.update(f.state);
  const card = f.find(f.hud.node, 'Upgrade_power'), title = f.find(card, 'Title_txt'), level = f.find(card, 'Lv_txt');
  const event = (region, id = 1, code) => ({ getID: () => id, getLocation: () => ({ region }), getEventCode: () => code });
  for (const graphic of [title, level]) {
    graphic.emit('start', event(graphic.name)); graphic.emit('touch', event(graphic.name));
  }
  assert.deepEqual(f.purchases, ['power', 'power'], 'labels remain clickable beyond the panel rectangle');
  title.emit('start', event(title.name));
  title.emit('cancel', event(card.name, 2, f.cc.Node.EventType.TOUCH_END));
  assert.equal(f.purchases.length, 2, 'a different finger cannot release the title gesture');
  title.emit('cancel', event(card.name, 1, f.cc.Node.EventType.TOUCH_END));
  card.emit('touch', event(card.name));
  assert.equal(f.purchases.length, 3, 'Cocos END converted to CANCEL over a sibling commits exactly once');
  title.emit('start', event(title.name)); title.emit('cancel', event(title.name));
  f.hud.update(f.state, 1); title.emit('touch', event(title.name));
  assert.equal(f.purchases.length, 3, 'true platform cancellation cannot purchase or keep repeating');
  title.emit('start', event(title.name)); f.hud.setModalOpen(true);
  title.emit('touch', event(title.name)); assert.equal(f.purchases.length, 3);
  f.hud.destroy();
});

test('a touch caught by an upgrade flash still receives release after its visual disappears', () => {
  const f = fixture(); f.hud.update(f.state);
  const card = f.find(f.hud.node, 'Upgrade_power'), flash = f.find(card, 'Upgrade_Anim');
  const proxy = f.find(card, 'UpgradeFlashInput');
  const event = (inside = true) => ({ getID: () => 1, getLocation: () => ({ inside }) });
  card.emit('start', event()); card.emit('touch', event());
  assert.equal(f.purchases.length, 1); assert.equal(flash.active, true);
  proxy.emit('start', event()); f.hud.update(f.state, .26);
  assert.equal(flash.active, false); assert.equal(proxy.active, true, 'capture owner must remain enabled for Cocos dispatch');
  assert.equal(proxy.getComponent(f.cc.UITransform).width, 0, 'expired flash no longer expands the hit area');
  if (proxy.active) proxy.emit('cancel', event(false));
  f.hud.update(f.state, .15); f.hud.update(f.state, .1);
  assert.equal(f.purchases.length, 1, 'releasing an expired flash cannot leave unattended hold purchases');
  card.emit('start', event()); card.emit('touch', event());
  assert.equal(f.purchases.length, 2, 'the next gesture is no longer blocked by the old pointer');
  f.hud.destroy();
});

test('tutorial target exposes the current power card and disappears behind modals, loading and unavailable modes', () => {
  const f = fixture(); assert.equal(f.hud.getTutorialUpgradeTarget(), null);
  f.hud.update(f.state);
  const power = f.find(f.hud.node, 'Upgrade_power'); assert.equal(f.hud.getTutorialUpgradeTarget(), power);
  f.hud.setModalOpen(true); assert.equal(f.hud.getTutorialUpgradeTarget(), null);
  f.hud.setModalOpen(false); assert.equal(f.hud.getTutorialUpgradeTarget(), power);
  f.hud.setLoadingOverlay(0); assert.equal(f.hud.getTutorialUpgradeTarget(), null);
  f.hud.setLoadingOverlay(null); assert.equal(f.hud.getTutorialUpgradeTarget(), power);
  f.hud.update({ ...f.state, upgrades: [] }); assert.equal(f.hud.getTutorialUpgradeTarget(), null);
  f.hud.update({ ...f.state, mode: 'Boss' }); assert.equal(f.hud.getTutorialUpgradeTarget(), null);
  f.hud.update(f.state); assert.notEqual(f.hud.getTutorialUpgradeTarget(), power);
  f.hud.destroy(); assert.equal(f.hud.getTutorialUpgradeTarget(), null);
});

test('Mine retains the three upgrade cards without rebuilding and entry cancellation clears held input', () => {
  const f = fixture(); f.hud.update(f.state);
  const cards = f.find(f.hud.node, 'Upgrade_List'), power = f.find(cards, 'Upgrade_power');
  const event = { getID: () => 1, getLocation: () => ({ inside: true }) };
  power.emit('start', event);
  // GameBootstrap.beginMinePresentation cancels gestures before changing worlds.
  f.hud.cancelInteractions();
  const mine = { ...f.state, mode: 'Mine' }; f.hud.update(mine, 1);
  assert.ok(f.find(f.hud.node, 'Upgrade_List') === cards, 'Mine reuses the independent Upgrade_List');
  assert.equal(f.find(f.hud.node, 'Main_UI'), undefined); assert.equal(f.purchases.length, 0);
  const count = f.nodes.length, writes = f.labels.map(label => label.writes);
  for (let i = 0; i < 600; i++) f.hud.update(mine);
  assert.equal(f.nodes.length, count); assert.deepEqual(f.labels.map(label => label.writes), writes);
  for (const type of ['power', 'speed', 'money']) {
    const card = f.find(cards, `Upgrade_${type}`); assert.ok(card.active);
    card.emit('start', event); card.emit('touch', event);
  }
  assert.deepEqual(f.purchases, ['power', 'speed', 'money']);
  f.hud.destroy(); assert.equal(cards.destroyCalls, 1);
});
