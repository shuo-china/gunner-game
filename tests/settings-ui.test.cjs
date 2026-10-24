const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/settings-system/config.json');
const ids = config.settingsUi;

// Exercise the actual source renderer, button feedback and settings controller.
function harness({ presentation = false, bgmEnabled = true, soundEnabled = true, webInput = false,
  redeemCode = () => ({ ok: false, reason: 'invalidCode' }) } = {}) {
  const bitmapFrames = [], borrowedFrames = [], fontRequests = [], imageRequests = [], pipelines = [];
  class Vec3 {
    constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
    clone() { return new Vec3(this.x, this.y, this.z); }
  }
  class UITransform {
    width = 0; height = 0; anchorX = .5; anchorY = .5;
    setContentSize(width, height) { Object.assign(this, { width, height }); }
    setAnchorPoint(anchorX, anchorY) { Object.assign(this, { anchorX, anchorY }); }
    convertToNodeSpaceAR(at) { const p = this.node.worldPosition, s = this.node.worldScale; return new Vec3((at.x - p.x) / s.x, (at.y - p.y) / s.y); }
  }
  class Node {
    static EventType = { TOUCH_START: 'start', TOUCH_END: 'end', TOUCH_CANCEL: 'cancel', TOUCH_MOVE: 'move', MOUSE_ENTER: 'enter', MOUSE_LEAVE: 'leave' };
    constructor(name) { Object.assign(this, { name, layer: 1 << 25, isValid: true, children: [], components: new Map(), events: new Map(), active: true, position: new Vec3(), scale: new Vec3(1, 1, 1) }); }
    addChild(node) { node.parent = this; this.children.push(node); }
    addComponent(Type) { const value = new Type(); value.node = this; this.components.set(Type, value); return value; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y, z = 0) { this.position = new Vec3(x, y, z); }
    setScale(x, y, z = 1) { this.scale = new Vec3(x, y, z); }
    on(event, callback) { this.events.set(event, callback); }
    destroy() { this.isValid = false; this.destroyed = true; }
    setSiblingIndex(index) { const siblings = this.parent?.children; if (!siblings) return; siblings.splice(siblings.indexOf(this), 1); siblings.splice(index, 0, this); }
    get worldScale() { const p = this.parent?.worldScale || new Vec3(1, 1, 1); return new Vec3(this.scale.x * p.x, this.scale.y * p.y, this.scale.z * p.z); }
    get worldPosition() { const p = this.parent?.worldPosition || new Vec3(), s = this.parent?.worldScale || new Vec3(1, 1, 1); return new Vec3(p.x + this.position.x * s.x, p.y + this.position.y * s.y, p.z + this.position.z * s.z); }
  }
  class Color {
    static WHITE = new Color(255, 255, 255, 255);
    constructor(r, g, b, a) { Object.assign(this, { r, g, b, a }); }
    toCSS() { return `rgba(${this.r}, ${this.g}, ${this.b}, ${this.a / 255})`; }
  }
  class Graphics { clear() {} rect() {} fill() {} }
  class Label { static HorizontalAlign = { LEFT: 0, RIGHT: 1, CENTER: 2 }; static VerticalAlign = { TOP: 0, BOTTOM: 1, CENTER: 2 }; static Overflow = { SHRINK: 0, CLAMP: 1 }; }
  class Sprite { static SizeMode = { CUSTOM: 0 }; static Type = { SLICED: 0, TILED: 1, SIMPLE: 2 }; }
  class SpriteAtlas { spriteFrames = {}; destroy() {} }
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
  class BlockInputEvents {}
  class EditBox {
    static InputMode = { SINGLE_LINE: 6 }; static InputFlag = { DEFAULT: 5 }; static KeyboardReturnType = { DONE: 1 };
    static EventType = { TEXT_CHANGED: 'text-changed', EDITING_DID_BEGAN: 'editing-did-began', EDITING_DID_ENDED: 'editing-did-ended', EDITING_RETURN: 'editing-return' };
    value = ''; focused = false; blurCount = 0;
    constructor() {
      if (webInput) {
        const values = new Map();
        this._impl = { _edTxt: { style: {
          writes: [], setProperty(name, value) { this.writes.push([name, value]); values.set(name, value); },
          getPropertyValue: name => values.get(name) ?? '',
        } } };
      }
    }
    set string(value) { this.value = value; this.sync(); }
    get string() { return this.value; }
    set placeholder(value) { this.placeholderLabel.string = value; }
    sync() {
      if (this.textLabel) { this.textLabel.string = this.value; this.textLabel.node.active = !this.focused && this.value.length > 0; }
      if (this.placeholderLabel) this.placeholderLabel.node.active = !this.focused && this.value.length === 0;
    }
    focus() {
      this.focused = true; this.sync(); this.node.events.get(EditBox.EventType.EDITING_DID_BEGAN)?.(this);
      // Match Creator's ordering: begin event fires before _showDom copies its limited text styles.
      const style = this._impl?._edTxt.style;
      if (style) {
        style.setProperty('color', this.textLabel.color.toCSS());
        style.setProperty('font-family', this.textLabel.font?._fontFamily || this.textLabel.fontFamily);
        style.setProperty('font-size', `${this.textLabel.fontSize}px`);
      }
    }
    blur() { this.blurCount++; const wasFocused = this.focused; this.focused = false; this.sync(); if (wasFocused) this.node.events.get(EditBox.EventType.EDITING_DID_ENDED)?.(this); }
  }
  const cc = { Node, Vec3, Vec2: Vec3, UITransform, Color, Graphics, Label, Sprite, SpriteAtlas, SpriteFrame, Rect, Size, Mask, Font, RichText,
    LabelOutline, LabelShadow, BlockInputEvents, EditBox, resources: { load(key, Type, callback) { assert.equal(Type, Font); fontRequests.push(key); callback(null, new Font()); } } };
  const makeNode = (name, parent) => { const node = new Node(name); node.layer = parent?.layer ?? node.layer; node.addComponent(UITransform); if (parent) parent.addChild(node); return node; };
  const paths = [...Object.values(config.images).map(image => image.path), ...Object.values(config.bitmapFonts).flatMap(font => font.pages)];
  const art = { frames: new Map(paths.map(path => {
    const frame = { texture: { path }, destroyCalls: 0, destroy() { this.destroyCalls++; } }; borrowedFrames.push(frame); return [path, frame];
  })), image: (name, spec, parent) => makeNode(name, parent), json: async key => { assert.equal(key, 'art/settings-system/config'); return config; },
    loadFrame: async path => { imageRequests.push(path); } };
  class SkinHudColorPipeline {
    materials = { sprite: {}, graphics: {}, layer: 1 << 16 }; pending = true; active = false; renders = 0; boundNodes = [];
    constructor(owner) { pipelines.push(this); this.content = makeNode('CachedSettings', owner); this.content.layer = 1 << 16; this.content.active = false; }
    setActive(active) { if (active !== this.active) this.invalidate(); this.active = this.content.active = active; }
    invalidate() { this.pending = true; }
    setInvalidationSource(predicate) { this.predicate = predicate; }
    *bindInputSteps() { this.bindInput(); yield; }
    bindInput() { const visit = node => { this.boundNodes.push(node); node.children.forEach(visit); }; visit(this.content); }
    resize() { this.invalidate(); }
    destroy() { this.destroyCalls = (this.destroyCalls ?? 0) + 1; this.active = false; this.destroyed = true; }
    beforeDraw() { if (!this.active) return false; const changed = this.predicate?.(); if (!this.pending && !changed) return false; this.pending = false; this.renders++; return true; }
  }
  const modules = { cc, './ArtLibrary': { makeNode }, './FontPolicyLabel': require('./support/font-policy-handle.cjs'), './SkinHudColorPipeline': { SkinHudColorPipeline, SKIN_PRESENT_LAYER: 1 << 17 } };
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'SettingsHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const state = { bgmEnabled, soundEnabled }, records = { sounds: [], visibility: [], alerts: [], toggles: [], redemptions: [], beforeOpen: 0 };
  const callbacks = { getState: () => state,
    redeemCode: code => { records.redemptions.push(code); return redeemCode(code); },
    toggleBgm: () => { state.bgmEnabled = !state.bgmEnabled; records.toggles.push('bgm'); },
    toggleSound: () => { state.soundEnabled = !state.soundEnabled; records.toggles.push('sound'); },
    onBeforeOpen: () => records.beforeOpen++, onVisibilityChanged: value => records.visibility.push(value), alert: text => records.alerts.push(text),
    playSfx: id => { if (state.soundEnabled) records.sounds.push(id); },
  };
  const assets = { config, chineseFont: null, originalFont: new Font(), numberFont: new Font() };
  assets.originalFont._fontFamily = 'OriginalLatin';
  const hud = new modules['./SettingsHud'].SettingsHud(makeNode('Canvas'), art, assets, callbacks, presentation ? {} : undefined);
  const node = id => hud.ui.node(ids[id] ?? id);
  const event = (target, id = 1, at, originalType) => ({ getID: () => id, getUILocation: () => at || target.worldPosition, getEventCode: () => originalType });
  const emit = (target, type, id, at, originalType = type) => target.events.get(type)?.(event(target, id, at, originalType));
  const clickNode = target => { emit(target, 'start'); emit(target, 'end'); };
  const click = id => clickNode(node(id));
  const input = node('inputField').getComponent(EditBox);
  const inputText = value => { input.string = value; input.node.events.get(EditBox.EventType.TEXT_CHANGED)?.(input); };
  return { hud, input, inputText, records, state, assets, art, callbacks, modules, node, emit, click, clickNode,
    UITransform, Label, LabelOutline, Color, Sprite, Graphics, BlockInputEvents, EditBox, bitmapFrames, borrowedFrames, fontRequests, imageRequests, pipelines, makeNode };
}

test('cancelled incremental settings construction releases its compositor and partial node tree', async () => {
  const h = harness(), canvas = h.makeNode('PreparingCanvas');
  const hud = new h.modules['./SettingsHud'].SettingsHud(canvas, h.art, h.assets, h.callbacks, {}, async steps => {
    for (let index = 0; index < 12; index++) steps.next();
    throw new Error('preparation cancelled');
  });
  assert.equal(hud.node.active, false);
  await assert.rejects(hud.prepared, /preparation cancelled/);
  assert.doesNotThrow(() => { hud.destroy(); hud.destroy(); });
  assert.equal(h.pipelines.at(-1).destroyed, true);
  assert.equal(h.pipelines.at(-1).destroyCalls, 1);
  assert.equal(hud.node.destroyed, true); assert.equal(hud.ui.nodes.size, 0);
  assert.deepEqual(h.records.toggles, []); assert.deepEqual(h.records.redemptions, []);
  assert.ok(h.borrowedFrames.every(frame => frame.destroyCalls === 0));
});

test('settings destroy works before modal roots or input fields have been initialized', async () => {
  const { preparationDriver } = require('./support/ui-preparation.cjs');
  const h = harness();
  for (const steps of [0, 1, 25, 60]) {
    const driver = preparationDriver(), canvas = h.makeNode('PreparingCanvas');
    const hud = new h.modules['./SettingsHud'].SettingsHud(canvas, h.art, h.assets, h.callbacks, {}, driver.prepare);
    const rejected = assert.rejects(hud.prepared, /owner destroyed/);
    await Promise.resolve(); driver.advance(steps);
    assert.doesNotThrow(() => { hud.destroy(); hud.destroy(); }, `destroy after ${steps} steps`);
    driver.advance(); await rejected;
    assert.equal(h.pipelines.at(-1).destroyCalls, 1); assert.equal(hud.node.destroyed, true);
    assert.equal(hud.ui.nodes.size, 0);
  }
  assert.deepEqual(h.records.toggles, []); assert.deepEqual(h.records.redemptions, []);
});

test('settings loader preloads the input glyph pages without downloading any TTF', async () => {
  const h = harness(), assets = await h.modules['./SettingsHud'].loadSettingsHudAssets(h.art);
  assert.equal(assets.config, config); assert.deepEqual(h.fontRequests, []);
  for (const page of config.input.bitmapFont.pages) assert.ok(h.imageRequests.includes(page));
  assert.equal(assets.chineseFont, null);
  assert.equal(assets.numberFont, assets.originalFont);
  assert.equal(new Set(h.imageRequests).size, h.imageRequests.length);
  assert.equal(config.referenceWidth, 1080); assert.equal(h.input.maxLength, 16); assert.equal(h.input.inputMode, h.EditBox.InputMode.SINGLE_LINE);
  assert.equal(h.input.inputFlag, h.EditBox.InputFlag.DEFAULT);
  assert.equal(h.node('inputText').active, false); assert.equal(h.node('inputPlaceholder').active, false);
  assert.equal(h.node('inputText').getComponent(h.Label), undefined);
  assert.equal(h.node('inputPlaceholder').getComponent(h.Label), undefined);
  assert.equal(h.input.textLabel.font, null);
  assert.equal(h.input.placeholderLabel.font, h.assets.chineseFont);
  assert.equal(h.input.placeholderLabel.useSystemFont, true);
  assert.equal(h.input.placeholderLabel.fontFamily, 'sans-serif');
  assert.equal(h.input.placeholderLabel.string, '请输入兑换码');
  assert.equal(h.input.placeholderLabel.isItalic, true);
  assert.equal(h.input.textLabel.isItalic, false);
  assert.ok(Math.abs(h.input.placeholderLabel.fontSize - 36) < .00001);
  assert.equal(h.node('settingPanel').getComponent(h.UITransform).width, 641.1699829101562);
  assert.equal(h.node('redeemPanel').getComponent(h.UITransform).width, 932.7000122070312);
});

test('entry blocking, source toggle visuals and action-before-sound ordering preserve both audio choices', () => {
  const h = harness({ bgmEnabled: false });
  h.hud.setEntryBlocked(true); h.hud.open(); assert.equal(h.hud.isOpen, false); assert.equal(h.records.beforeOpen, 0);
  h.hud.setEntryBlocked(false); h.hud.open(); h.hud.open();
  assert.equal(h.records.beforeOpen, 1); assert.deepEqual(h.records.visibility, [true]);
  assert.equal(h.node('bgmOn').active, false); assert.equal(h.node('bgmOff').active, true);
  h.click('bgmButton'); assert.equal(h.state.bgmEnabled, true); assert.equal(h.node('bgmOn').active, true);
  assert.deepEqual(h.records.sounds, [1]);
  h.click('soundButton'); assert.equal(h.state.soundEnabled, false); assert.deepEqual(h.records.sounds, [1], 'closing Sound prevents its own subsequent click SFX');
  h.click('soundButton'); assert.equal(h.state.soundEnabled, true); assert.deepEqual(h.records.sounds, [1, 1]);
  h.hud.close(); h.hud.open(); assert.equal(h.node('bgmOn').active, true); assert.equal(h.node('soundOn').active, true);
});

test('redeem is a nested modal, close and backdrop remove one layer, and background controls reject input', () => {
  const h = harness(); h.hud.open(); h.click('redeemOpen');
  assert.equal(h.hud.isOpen, true); assert.equal(h.hud.isRedeemOpen, true); assert.deepEqual(h.records.visibility, [true]);
  h.click('bgmButton'); h.click('settingClose'); assert.equal(h.state.bgmEnabled, true); assert.equal(h.hud.isOpen, true);
  for (const name of ['settingPanel', 'redeemPanel']) assert.ok(h.node(name).getComponent(h.BlockInputEvents));
  h.click('redeemClose'); assert.equal(h.hud.isRedeemOpen, false); assert.equal(h.hud.isOpen, true);
  h.click('redeemOpen'); h.click('redeemBackground'); assert.equal(h.hud.isRedeemOpen, false); assert.equal(h.hud.isOpen, true);
  h.click('settingBackground'); assert.equal(h.hud.isOpen, false); assert.deepEqual(h.records.visibility, [true, false]);
});

test('only the redeem button submits every code including empty input, and failures preserve input until reopening', () => {
  const h = harness(); h.hud.open(); h.hud.openRedeem();
  for (const value of ['', '1234', '   ', '猫咪兑换码', 'AbC#$%']) {
    h.inputText(value); h.input.node.events.get(h.EditBox.EventType.EDITING_RETURN)?.(h.input);
    assert.equal(h.records.alerts.length, h.records.sounds.length);
    h.click('redeemSubmit'); assert.equal(h.input.string, value); assert.equal(h.hud.isRedeemOpen, true);
    assert.equal(h.records.alerts.at(-1), '兑换码不存在');
  }
  h.hud.closeRedeem(); h.hud.openRedeem(); assert.equal(h.input.string, '');
  h.hud.close(); h.hud.submitRedeem(); assert.equal(h.records.alerts.length, 5);
});

test('successful redemption shows the original reward text, clears input and plays Purchase while keeping both panels open', () => {
  const h = harness({ presentation: true, redeemCode: () => ({ ok: true, diamonds: 2000 }) });
  h.hud.open(); h.hud.openRedeem(); h.inputText('950424'); h.input.focus();
  h.click('redeemSubmit');
  assert.deepEqual(h.records.redemptions, ['950424']);
  assert.deepEqual(h.records.alerts, ['获得2000颗钻石！']);
  assert.deepEqual(h.records.sounds, [7, 1], 'original success SFX precedes the submit button ClickSound');
  assert.equal(h.input.focused, false); assert.equal(h.input.string, '');
  assert.equal(h.input.placeholderLabel.node.active, true);
  assert.equal(h.hud.isOpen, true); assert.equal(h.hud.isRedeemOpen, true);
  assert.equal(h.hud.colors.beforeDraw(), true);
  h.click('redeemClose'); assert.equal(h.hud.isOpen, true); assert.equal(h.hud.isRedeemOpen, false);
});

test('server redemption waits for verification, prevents duplicate submissions and preserves newly typed codes', async () => {
  let finish;
  const h = harness({ redeemCode: () => new Promise(resolve => { finish = resolve; }) });
  h.hud.open(); h.hud.openRedeem(); h.inputText('SERVERCODE');
  h.click('redeemSubmit'); h.click('redeemSubmit'); h.hud.submitRedeem();
  assert.deepEqual(h.records.redemptions, ['SERVERCODE']); assert.deepEqual(h.records.alerts, []);
  assert.equal(h.input.string, 'SERVERCODE'); assert.deepEqual(h.records.sounds, [1]);
  finish({ ok: true, diamonds: 2000 }); await Promise.resolve();
  assert.deepEqual(h.records.alerts, ['获得2000颗钻石！']); assert.equal(h.input.string, '');
  assert.deepEqual(h.records.sounds, [1, 7]); assert.equal(h.hud.isRedeemOpen, true);
  h.inputText('SECOND'); h.click('redeemSubmit'); h.inputText('THIRD');
  finish({ ok: true, diamonds: 2000 }); await Promise.resolve();
  assert.equal(h.input.string, 'THIRD'); assert.deepEqual(h.records.redemptions, ['SERVERCODE', 'SECOND']);
  h.hud.destroy();
});

test('redemption rejection and synchronous exceptions show Chinese feedback and release the submit button', async () => {
  let redeem = () => Promise.reject(new Error('network unavailable'));
  const h = harness({ redeemCode: () => redeem() });
  h.hud.open(); h.hud.openRedeem(); h.inputText('SERVERCODE');
  for (const fail of [() => Promise.reject(new Error('network unavailable')), () => { throw new Error('network unavailable'); }]) {
    redeem = fail; h.click('redeemSubmit'); await Promise.resolve();
    assert.equal(h.records.alerts.at(-1), '兑换核验失败，请检查网络后重试。');
    assert.equal(h.input.string, 'SERVERCODE');
  }
  redeem = () => Promise.resolve({ ok: false, reason: 'notLoggedIn', message: '请先登录后再兑换。' });
  h.click('redeemSubmit'); await Promise.resolve();
  assert.equal(h.records.alerts.at(-1), '请先登录后再兑换。');
  redeem = () => Promise.resolve({ ok: true, diamonds: 2000 });
  h.click('redeemSubmit'); await Promise.resolve();
  assert.equal(h.records.redemptions.length, 4); assert.equal(h.input.string, '');
  assert.equal(h.records.sounds.filter(id => id === 7).length, 1);
  h.hud.destroy();
});

test('server redemption completion cannot mutate a destroyed settings HUD', async () => {
  for (const reject of [false, true]) {
    let settle;
    const h = harness({ redeemCode: () => new Promise((resolve, fail) => {
      settle = reject ? () => fail(new Error('network unavailable')) : () => resolve({ ok: true, diamonds: 2000 });
    }) });
    h.hud.open(); h.hud.openRedeem(); h.inputText('SERVERCODE'); h.click('redeemSubmit'); h.hud.destroy();
    const sounds = h.records.sounds.length, alerts = h.records.alerts.length;
    h.hud.syncInput = () => assert.fail('destroyed input must not synchronize');
    settle(); await Promise.resolve();
    assert.equal(h.input.string, 'SERVERCODE');
    assert.equal(h.records.sounds.length, sounds); assert.equal(h.records.alerts.length, alerts);
  }
});

test('used codes and failed persistence preserve input and never emit success audio', () => {
  for (const [reason, message] of [['alreadyUsed', '兑换码已被使用。'],
    ['saveFailed', '保存失败，请重试'], ['walletLimit', '钻石数量已达上限']]) {
    const h = harness({ redeemCode: () => ({ ok: false, reason }) });
    h.hud.open(); h.hud.openRedeem(); h.inputText('950424'); h.click('redeemSubmit');
    assert.equal(h.records.alerts.at(-1), message); assert.equal(h.input.string, '950424');
    assert.equal(h.hud.isRedeemOpen, true); assert.deepEqual(h.records.sounds, [1]);
  }
  const muted = harness({ soundEnabled: false, redeemCode: () => ({ ok: true, diamonds: 2000 }) });
  muted.hud.open(); muted.hud.openRedeem(); muted.inputText('950424'); muted.click('redeemSubmit');
  assert.deepEqual(muted.records.alerts, ['获得2000颗钻石！']); assert.deepEqual(muted.records.sounds, []);
});

test('single-line canvas input delegates mixed text while native input stays system; blur, resize and teardown release input', () => {
  const h = harness(); h.hud.open(); h.hud.openRedeem();
  h.inputText('12345678\r\n901234567890'); assert.equal(h.input.string, '1234567890123456');
  assert.equal(h.input.textLabel.font, null);
  h.inputText('中文ABC'); assert.equal(h.input.textLabel.font, null); assert.equal(h.input.textLabel.fontSize, 50);
  assert.equal(h.input.textLabel.useSystemFont, true); assert.equal(h.input.textLabel.fontFamily, 'sans-serif');
  h.inputText('ABC'); assert.equal(h.input.textLabel.font, null); assert.equal(h.input.textLabel.fontSize, 50);
  assert.equal(h.input.textLabel.useSystemFont, true);
  assert.equal(h.input.textLabel.policyText, h.input.string);
  assert.equal(h.input.textLabel.policyFont, config.input.bitmapFont);
  h.input.focus(); h.hud.resize(720, 1600, 50, 30); assert.equal(h.input.focused, false);
  const area = h.node('inputTextArea').getComponent(h.UITransform), label = h.input.textLabel;
  assert.equal(label.node.getComponent(h.UITransform).width, area.width); assert.equal(label.node.position.x, 0); assert.equal(label.node.position.y, 0);
  h.input.focus(); h.hud.cancelInteractions(); assert.equal(h.input.focused, false);
  h.input.focus(); h.hud.destroy(); h.hud.destroy(); assert.equal(h.input.focused, false); assert.equal(h.hud.isOpen, false);
  h.hud.open(); assert.equal(h.hud.isOpen, false);
  assert.ok(h.bitmapFrames.every(frame => frame.destroyCalls === 1)); assert.ok(h.borrowedFrames.every(frame => frame.destroyCalls === 0));
});

test('button touch IDs, cancellation, release outside and child graphics cannot cause accidental toggles', () => {
  const h = harness(); h.hud.open(); const button = h.node('bgmButton');
  h.emit(button, 'start', 1); h.emit(button, 'end', 2); assert.equal(h.records.toggles.length, 0);
  h.emit(button, 'cancel', 1); h.emit(button, 'end', 1); assert.equal(h.records.toggles.length, 0);
  h.emit(button, 'start', 1); h.emit(button, 'end', 1, { x: 9999, y: 9999 }); assert.equal(h.records.toggles.length, 0);
  h.emit(button, 'start', 1); h.hud.cancelInteractions(); h.emit(button, 'end', 1); assert.equal(h.records.toggles.length, 0);
  const text = config.nodes[ids.bgmButton].children.map(id => config.nodes[id]).find(spec => spec.text);
  h.clickNode(h.node(text.id)); assert.deepEqual(h.records.toggles, ['bgm']);
  const textNode = h.node(text.id);
  h.emit(textNode, 'start', 3); h.emit(textNode, 'cancel', 3, button.worldPosition, 'end');
  assert.deepEqual(h.records.toggles, ['bgm', 'bgm'], 'real release moving from label onto the same button remains a click');
  h.emit(textNode, 'start', 3); h.emit(textNode, 'cancel', 3, { x: 9999, y: 9999 }, 'end');
  h.emit(textNode, 'start', 3); h.emit(textNode, 'cancel', 3, button.worldPosition, 'cancel');
  assert.equal(h.records.toggles.length, 2, 'actual cancellation and release outside still reject the click');
});

test('source bounce and tint transitions redraw only when needed, including native input label visibility', () => {
  const h = harness({ presentation: true }); h.hud.open(); const pipeline = h.hud.colors;
  assert.equal(pipeline.beforeDraw(), true); assert.equal(pipeline.beforeDraw(), false);
  const button = h.node('redeemOpen'); h.emit(button, 'start'); h.hud.update(.05);
  assert.ok(button.scale.x < 1); assert.equal(pipeline.beforeDraw(), true);
  const sprite = button.children.find(node => node.name === 'OriginalImage').getComponent(h.Sprite);
  assert.ok(sprite.color.r < config.nodes[ids.redeemOpen].image.color[0]);
  h.emit(button, 'end'); assert.equal(h.hud.isRedeemOpen, true); pipeline.beforeDraw();
  assert.equal(h.input.node.layer, 1 << 17, 'DOM control uses the always-live presentation camera');
  assert.equal(h.input.textLabel.node.layer, 1 << 16, 'actual label is included in the original color conversion');
  assert.ok(pipeline.boundNodes.includes(h.input.textLabel.node));
  assert.ok(pipeline.boundNodes.includes(h.input.node));
  h.inputText('HELLO'); assert.equal(pipeline.beforeDraw(), true); assert.equal(pipeline.beforeDraw(), false);
  h.input.focus(); assert.equal(pipeline.beforeDraw(), true); assert.equal(pipeline.beforeDraw(), false);
  h.input.blur(); assert.equal(pipeline.beforeDraw(), true);
  h.hud.close(); assert.equal(pipeline.active, false); assert.equal(pipeline.beforeDraw(), false);
});

test('partial settings construction releases color pipeline cameras and its unowned root', () => {
  const h = harness(), parent = h.makeNode('PartialCanvas');
  const art = { ...h.art, frames: { get() { throw new Error('missing sprite'); } } };
  assert.throws(() => new h.modules['./SettingsHud'].SettingsHud(parent, art, h.assets, { getState: () => h.state }, {}), /missing sprite/);
  assert.equal(h.pipelines.length, 1); assert.equal(h.pipelines[0].destroyed, true);
  assert.equal(parent.children[0].destroyed, true);
});

test('focused Web input retains the canvas fill and outer outline without changing other controls', () => {
  const h = harness({ presentation: true, webInput: true }), other = harness({ webInput: true });
  h.hud.open(); h.hud.openRedeem(); h.inputText('HELLO');
  const label = h.input.textLabel, outline = label.node.getComponent(h.LabelOutline);
  const before = { color: label.color, width: outline.width, font: label.font, fontSize: label.fontSize };
  const style = h.input._impl._edTxt.style;
  const otherWrites = other.input._impl._edTxt.style.writes.length;
  h.input.focus();
  assert.equal(style.getPropertyValue('color'), label.color.toCSS());
  assert.equal(style.getPropertyValue('-webkit-text-fill-color'), label.color.toCSS());
  assert.equal(style.getPropertyValue('-webkit-text-stroke-color'), outline.color.toCSS());
  assert.equal(style.getPropertyValue('-webkit-text-stroke-width'), `${outline.width * 2}px`);
  assert.equal(style.getPropertyValue('paint-order'), 'stroke fill', 'draw outline first, then preserve the white face like Canvas');
  assert.equal(style.getPropertyValue('caret-color'), label.color.toCSS(), 'native caret remains visible');
  assert.equal(style.getPropertyValue('font-family'), 'sans-serif');
  h.input.blur(); h.input.focus();
  assert.equal(label.color, before.color); assert.equal(outline.width, before.width);
  assert.equal(label.font, before.font); assert.equal(label.fontSize, before.fontSize);
  assert.equal(other.input._impl._edTxt.style.writes.length, otherWrites, 'style changes stay on this EditBox only');
  const writes = style.writes.length; h.hud.update(0); h.hud.update(0);
  assert.equal(style.writes.length, writes, 'stable frames avoid rewriting DOM styles');
});

test('editing Web input updates Chinese fallback and source color changes without waiting for another focus', () => {
  const h = harness({ webInput: true }); h.hud.open(); h.hud.openRedeem(); h.input.focus();
  const style = h.input._impl._edTxt.style;
  h.inputText('兑换码');
  assert.equal(style.getPropertyValue('font-family'), 'sans-serif');
  h.input.blur(); h.input.focus(); assert.equal(style.getPropertyValue('font-family'), 'sans-serif');
  assert.equal(style.getPropertyValue('font-size'), `${h.input.textLabel.fontSize}px`);
  h.inputText('CODE'); assert.equal(style.getPropertyValue('font-family'), 'sans-serif');
  assert.equal(style.getPropertyValue('font-size'), '50px');
  h.input.textLabel.color = new h.Color(220, 230, 240, 255); h.hud.update(0);
  assert.equal(style.getPropertyValue('color'), 'rgba(220, 230, 240, 1)');
  assert.equal(style.getPropertyValue('-webkit-text-fill-color'), 'rgba(220, 230, 240, 1)');
  const inputValue = h.input.string; h.hud.submitRedeem();
  assert.equal(h.input.string, inputValue); assert.equal(h.records.alerts.at(-1), '兑换码不存在');
  h.hud.destroy(); assert.equal(h.hud.styledWebInput, null);
});
