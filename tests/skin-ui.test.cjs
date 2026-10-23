const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/skin-system/config.json');
const visualConfig = require('../assets/resources/art/skin-system/visuals.json');
const rig = require('../assets/resources/art/characters/cat_basic/rig.json');

// Real source renderer and skin HUD with lightweight Cocos primitives.
function harness(diamonds = 1000, presentation = false, contentState = { visible: true, unlocked: true }) {
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
    setSiblingIndex(index) { const siblings = this.parent?.children; if (!siblings) return; siblings.splice(siblings.indexOf(this), 1); siblings.splice(index, 0, this); }
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
  const paths = [...Object.values(config.images).map(image => image.path), ...Object.values(config.bitmapFonts).flatMap(font => font.pages),
    ...visualConfig.skins.flatMap(skin => skin.parts.map(part => part.path)), rig.attachments.face.path];
  const art = { frames: new Map(paths.map(path => {
    const frame = { texture: { path }, destroyCalls: 0, destroy() { this.destroyCalls++; } }; borrowedFrames.push(frame); return [path, frame];
  })), rig, skinVisuals: {
    appearance: id => visualConfig.skins[id],
    paletteMaterial: (id, base, portrait = false) => { assert.equal(portrait, false); return id ? { skin: id, base } : base; },
    bodyMaterial: base => base,
    ensureLoaded: async () => {},
  }, image: (name, spec, parent) => {
    const node = makeNode(name, parent), sprite = node.addComponent(Sprite), transform = node.getComponent(UITransform);
    sprite.spriteFrame = art.frames.get(spec.path); sprite.color = Color.WHITE;
    transform.setContentSize(...spec.sizeUnits); transform.setAnchorPoint(...spec.anchor);
    node.setPosition(...(spec.localPosition || [0, 0])); node.angle = spec.localRotationDeg || 0; node.setScale(...(spec.localScale || [1, 1]));
    return node;
  } };
  class OriginalWeaponScroll {
    stops = 0;
    configure(source) { this.source = source; }
    stopAutoScroll() { this.stops++; }
  }
  class SkinHudColorPipeline {
    materials = { sprite: {} }; pending = true; active = false; renders = 0;
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
  const modules = { cc, './ArtLibrary': { makeNode }, './OriginalWeaponScroll': { OriginalWeaponScroll }, './SkinHudColorPipeline': { SkinHudColorPipeline } };
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalCatAnimation', 'SkinPreview', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'SkinHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const { SkinSystem } = require('./.build/session/session/SkinSystem.js');
  const skins = new SkinSystem(), records = { sounds: [], visibility: [], purchases: [], equipped: [], alerts: [], beforeOpen: 0 };
  const callbacks = {
    getState: () => skins.snapshot(diamonds),
    getContentState: () => contentState,
    purchase: id => { records.purchases.push(id); return skins.purchase(id, diamonds, amount => { diamonds -= amount; return true; }); },
    equip: id => { records.equipped.push(id); return skins.equip(id); },
    onBeforeOpen: () => records.beforeOpen++, onVisibilityChanged: value => records.visibility.push(value),
    alert: text => records.alerts.push(text), playSfx: id => records.sounds.push(id),
  };
  const hud = new modules['./SkinHud'].SkinHud(makeNode('Canvas'), art,
    { config, chineseFont: new Font(), originalFont: new Font(), numberFont: new Font() }, callbacks, presentation ? {} : undefined);
  const node = id => hud.ui.node(typeof id === 'number' ? `level0:${id}` : id);
  const event = (target, id = 1, at, originalType) => ({ getID: () => id, getUILocation: () => at || target.worldPosition, getEventCode: () => originalType });
  const emit = (target, type, id, at, originalType = type) => target.events.get(type)?.(event(target, id, at, originalType));
  const clickNode = target => { emit(target, 'start'); emit(target, 'end'); };
  const click = id => clickNode(node(id));
  const text = id => node(id).getComponent(Label).string;
  const image = id => node(id).children.find(child => child.name === 'OriginalImage')?.getComponent(Sprite);
  return { hud, skins, callbacks, state: () => skins.snapshot(diamonds), setDiamonds: value => { diamonds = value; }, records, node, click, clickNode, emit, text, image,
    UITransform, Label, Sprite, Graphics, makeNode, borrowedFrames, bitmapFrames, art, modules };
}

const manager = config.roles['level0:123519'], detail = config.roles[manager.skin_info_ui];
const itemRoles = manager.Skin_item_list.map(key => config.roles[key]);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tutorialLocked = { visible: false, unlocked: false, reason: 'tutorial', message: '完成新手引导后开放皮肤。' };

test('skin entry initializes hidden and cannot open until the shared policy allows it', () => {
  const h = harness(1000, false, tutorialLocked), entry = h.node(config.roots.entry);
  assert.equal(entry.active, false);
  h.hud.setEntryVisible(true); h.hud.resize(390, 844); h.hud.update(0);
  assert.equal(entry.active, false);
  h.hud.open(); h.hud.openDetail(1); h.click(config.roots.entry);
  assert.equal(h.hud.isOpen, false); assert.equal(h.records.beforeOpen, 0);
  assert.deepEqual(h.records.purchases, []); assert.deepEqual(h.records.equipped, []);
  assert.equal(h.records.alerts.at(-1), tutorialLocked.message);
  h.callbacks.getContentState = () => ({ visible: true, unlocked: true });
  h.hud.update(0);
  assert.equal(entry.active, true, 'content access refreshes even when skin revision and diamonds do not change');
  h.click(config.roots.entry); assert.equal(h.hud.isOpen, true); assert.equal(h.records.beforeOpen, 1);
  h.hud.close(); h.hud.setEntryVisible(false); h.hud.open(); assert.equal(h.hud.isOpen, false);
});

test('restored tutorial restrictions cancel a pending skin selection, including before the next UI frame', async () => {
  for (const refresh of ['update', 'entry', 'completion']) {
    const h = harness(1000, true), pending = deferred();
    h.callbacks.purchase(1); h.callbacks.prepare = () => pending.promise;
    h.hud.open(); h.hud.openDetail(1); h.click(detail.Select_Btn_obj);
    h.callbacks.getContentState = () => tutorialLocked;
    if (refresh === 'update') h.hud.update(0);
    if (refresh === 'entry') h.hud.setEntryVisible(true);
    pending.resolve(); await new Promise(setImmediate);
    assert.equal(h.hud.isOpen, false, refresh); assert.equal(h.node(config.roots.entry).active, false);
    assert.equal(h.node(config.roots.detail).active, false); assert.equal(h.hud.colors.active, false);
    assert.deepEqual(h.records.equipped, []); assert.equal(h.state().selectedId, 0);
    assert.equal(h.state().diamonds, 900); assert.equal(h.records.sounds.includes(9), false);
    h.callbacks.getContentState = () => ({ visible: true, unlocked: true });
    h.hud.update(0); h.hud.open();
    assert.equal(h.hud.isOpen, true); assert.deepEqual(h.records.equipped, []);
  }
});

test('a lock applied between skin pointer down and up cannot purchase before the next refresh', () => {
  const h = harness(); h.hud.open(); h.hud.openDetail(1);
  h.emit(h.node(detail.Purchase_Btn_obj), 'start');
  h.callbacks.getContentState = () => tutorialLocked;
  h.emit(h.node(detail.Purchase_Btn_obj), 'end');
  assert.deepEqual(h.records.purchases, []); assert.equal(h.state().diamonds, 1000);
  assert.equal(h.hud.isOpen, false);
});

test('skin selection waits for prepared art, coalesces repeated clicks, and leaves purchase synchronous', async () => {
  const h = harness(1000), pending = deferred(), prepared = [];
  h.callbacks.prepare = id => { prepared.push(id); return pending.promise; };
  h.hud.open(); h.hud.openDetail(1); h.click(detail.Purchase_Btn_obj);
  assert.equal(h.state().owned[1], true); assert.equal(h.state().diamonds, 900);
  h.click(detail.Select_Btn_obj); h.click(detail.Select_Btn_obj);
  assert.deepEqual(prepared, [1]); assert.deepEqual(h.records.equipped, []);
  assert.equal(h.state().selectedId, 0); assert.match(h.records.alerts.at(-1), /正在加载皮肤/);
  pending.resolve(); await new Promise(setImmediate);
  assert.deepEqual(h.records.equipped, [1]); assert.equal(h.state().selectedId, 1);
  assert.equal(h.records.sounds.at(-1), 9); assert.equal(h.node(detail.Selected_obj).active, true);
  assert.equal(h.state().diamonds, 900);
});

test('a later skin selection wins when earlier downloads finish out of order', async () => {
  const h = harness(1000), first = deferred(), second = deferred();
  h.callbacks.purchase(1); h.callbacks.purchase(2);
  h.callbacks.prepare = id => id === 1 ? first.promise : second.promise;
  h.hud.open(); h.hud.openDetail(1); h.click(detail.Select_Btn_obj);
  h.hud.openDetail(2); h.click(detail.Select_Btn_obj);
  second.resolve(); await new Promise(setImmediate);
  assert.equal(h.state().selectedId, 2);
  first.resolve(); await new Promise(setImmediate);
  assert.deepEqual(h.records.equipped, [2]); assert.equal(h.state().selectedId, 2);
});

test('closing, background cancellation, and destruction discard a pending skin equip intent', async () => {
  for (const action of ['close', 'cancelInteractions', 'destroy']) {
    const h = harness(1000), pending = deferred(); h.callbacks.purchase(1);
    h.callbacks.prepare = () => pending.promise;
    h.hud.open(); h.hud.openDetail(1); h.click(detail.Select_Btn_obj);
    h.hud[action](); pending.resolve(); await new Promise(setImmediate);
    assert.deepEqual(h.records.equipped, [], action); assert.equal(h.state().selectedId, 0);
    assert.equal(h.records.sounds.includes(9), false);
  }
});

test('failed skin preparation preserves selection and lets the same button retry', async () => {
  const h = harness(1000), first = deferred(), second = deferred(), requests = [first.promise, second.promise];
  h.callbacks.purchase(1); h.callbacks.prepare = () => requests.shift();
  h.hud.open(); h.hud.openDetail(1); h.click(detail.Select_Btn_obj);
  first.reject(new Error('download failed')); await new Promise(setImmediate);
  assert.equal(h.state().selectedId, 0); assert.deepEqual(h.records.equipped, []);
  assert.match(h.records.alerts.at(-1), /皮肤加载失败.*重试/);
  h.click(detail.Select_Btn_obj); second.resolve(); await new Promise(setImmediate);
  assert.equal(h.state().selectedId, 1); assert.deepEqual(h.records.equipped, [1]);
});

test('opt-in linear skin materials include generated glyphs and dimmers while leaving menu entry rendering unchanged', () => {
  const h = harness(), sprite = { name: 'linear-sprite' }, graphics = { name: 'linear-graphics' }, layer = 1 << 16;
  const ui = new h.modules['./OriginalWeaponUi'].OriginalWeaponUi(h.art, h.hud.assets, { sprite, graphics, layer });
  const parent = h.makeNode('LinearRoot'); parent.layer = layer;
  ui.create(config.roots.list, parent); ui.create(config.roots.detail, parent);
  ui.layout(config.roots.list, 1080, 1920); ui.layout(config.roots.detail, 1080, 1920);
  ui.setText(detail.Price_txt, '<sprite=1>2400'); ui.tint(detail.Price_txt, [255, 127, 127, 255]);
  let images = 0, glyphs = 0, dimmers = 0;
  const visit = node => {
    const image = node.getComponent(h.Sprite), graphic = node.getComponent(h.Graphics);
    if (image) { assert.equal(image.customMaterial, sprite); images++; if (node.name === 'OriginalGlyph') glyphs++; }
    if (graphic) { assert.equal(graphic.customMaterial, graphics); dimmers++; }
    node.children.forEach(visit);
  };
  visit(parent); assert.ok(images > 70); assert.ok(glyphs > 10); assert.ok(dimmers > 0);
  const entryParent = h.makeNode('NormalRoot'), entry = ui.create(config.roots.entry, entryParent);
  assert.equal(entry.children.find(node => node.name === 'OriginalImage').getComponent(h.Sprite).customMaterial, undefined);
  const overlay = ui.node(itemRoles[1].Locked_obj).children.find(node => node.name === 'OriginalImage').getComponent(h.Sprite);
  assert.deepEqual([overlay.color.r, overlay.color.g, overlay.color.b, overlay.color.a], [0, 0, 0, 194]);
  ui.destroy();
});

test('skin source bundle preserves every original card, portrait, bitmap glyph, mask and hidden scrollbar', () => {
  assert.equal(itemRoles.length, 25); assert.equal(config.skinCount, 25);
  assert.equal(config.previewMode, 'battle-parts'); assert.equal(config.portraits, undefined);
  for (const image of Object.values(config.images)) assert.ok(fs.existsSync(path.join(root, 'assets/resources', image.path + '.png')), image.path);
  for (const font of Object.values(config.bitmapFonts)) for (const page of font.pages) assert.ok(fs.existsSync(path.join(root, 'assets/resources', page + '.png')));
  assert.equal(config.nodes['level0:19'].mask, true); assert.equal(config.nodes['level0:19'].maskShowGraphic, false);
  assert.deepEqual(config.nodes['level0:2146'].rect.scale, [0, 0]);
  const h = harness();
  assert.equal(h.hud.scroll.content, h.node(1182)); assert.equal(h.hud.scroll.source.m_MovementType, 1);
  assert.ok(Math.abs(h.hud.scroll.source.m_DecelerationRate - .135) < 1e-6);
  assert.equal(h.node(1182).getComponent(h.UITransform).height, 1924);
  for (let i = 0; i < 25; i++) {
    assert.equal(h.node(itemRoles[i].node).position.x, config.nodes[itemRoles[i].node].rect.position[0]);
    assert.equal(h.node(itemRoles[i].node).position.y, config.nodes[itemRoles[i].node].rect.position[1]);
    assert.equal(h.hud.previews.get(itemRoles[i].Cat_img).parts.get('body').sprite.spriteFrame,
      h.art.frames.get(visualConfig.skins[i].parts.find(part => part.id === 'body').path));
  }
});

test('default and locked details retain source labels, portrait/shadow, price tint and non-wrapping boundaries', () => {
  const h = harness(22); h.hud.open(); h.click(itemRoles[0].node);
  assert.equal(h.text(detail.Num_txt), '1'); assert.equal(h.node(detail.Before_Btn_obj).active, false); assert.equal(h.node(detail.Next_Btn_obj).active, true);
  assert.equal(h.node(detail.Selected_obj).active, true); assert.equal(h.node(detail.Purchase_Btn_obj).active, false);
  h.click(detail.Next_Btn_obj);
  assert.equal(h.text(detail.Num_txt), '2'); assert.equal(h.text(detail.Damage_txt), '+16%'); assert.equal(h.text(detail.Speed_txt), '+10%'); assert.equal(h.text(detail.Money_txt), '+5%');
  assert.equal(h.node(detail.Locked_img).active, true); assert.equal(h.node(detail.Purchase_Btn_obj).active, true);
  const color = h.node(detail.Price_txt).getComponent(h.Label).color;
  assert.deepEqual([color.r, color.g, color.b, color.a], [255, 127, 127, 255]);
  h.click(detail.Purchase_Btn_obj); assert.equal(h.records.purchases.length, 0); assert.equal(h.state().diamonds, 22);
  h.hud.openDetail(24); assert.equal(h.text(detail.Num_txt), '25'); assert.equal(h.text(detail.Price_txt), '2400');
  const lastBody = h.art.frames.get(visualConfig.skins[24].parts.find(part => part.id === 'body').path);
  for (const key of [detail.Cat_img, detail.Shadow_img, detail.Locked_img]) assert.equal(h.hud.previews.get(key).parts.get('body').sprite.spriteFrame, lastBody,
    'locked silhouette follows the current skin ears, clothing and tail as well as the portrait/shadow');
  assert.equal(h.text(detail.Damage_txt), '+384%'); assert.equal(h.node(detail.Next_Btn_obj).active, false);
  h.click(detail.Next_Btn_obj); h.hud.openDetail(25); assert.equal(h.text(detail.Num_txt), '25');
  h.hud.openDetail(0); h.click(detail.Before_Btn_obj); h.hud.openDetail(-1); assert.equal(h.text(detail.Num_txt), '1');
});

test('live skin navigation reuses battle frames, poses and nodes, colors fur only, and never equips', () => {
  const h = harness(22, true), baseMaterial = h.hud.colors.materials.sprite;
  const preview = h.hud.previews.get(detail.Cat_img), head = preview.parts.get('head');
  const geometry = JSON.stringify([preview.node.position, preview.node.scale]);
  const nodes = Array.from(preview.parts.values(), part => part.node);
  h.hud.open();
  for (const id of [...Array(25).keys(), 10, 7, 0]) {
    h.hud.openDetail(id);
    assert.equal(preview.parts.get('body').sprite.customMaterial, baseMaterial);
    if (id) assert.equal(head.sprite.customMaterial.skin, id);
    else assert.equal(head.sprite.customMaterial, baseMaterial);
    for (const part of visualConfig.skins[id].parts) {
      const source = part.id === 'foot_right' ? visualConfig.skins[id].parts.find(p => p.id === 'foot_left') : part;
      assert.equal(preview.parts.get(part.id).sprite.spriteFrame, h.art.frames.get(source.path));
    }
    assert.equal(JSON.stringify([preview.node.position, preview.node.scale]), geometry);
    assert.deepEqual(Array.from(preview.parts.values(), part => part.node), nodes);
    for (const key of [detail.Shadow_img, detail.Locked_img]) {
      const shadow = h.hud.previews.get(key);
      assert.equal(shadow.parts.get('head').sprite.customMaterial, baseMaterial);
      assert.equal(shadow.parts.get('head').sprite.color.r, 0);
    }
  }
  assert.deepEqual(h.records.purchases, []); assert.deepEqual(h.records.equipped, []);
});

test('all skin cards and details face forward with downward fingertips and balanced feet without changing battle assets', () => {
  const sourceRig = JSON.stringify(rig), h = harness(22, true);
  const world = node => {
    if (node.name === 'OriginalRig') return { x: 0, y: 0, r: 0, sx: 1, sy: 1 };
    const p = world(node.parent), a = p.r*Math.PI/180, x = node.position.x*p.sx, y = node.position.y*p.sy;
    return { x: p.x+Math.cos(a)*x-Math.sin(a)*y, y: p.y+Math.sin(a)*x+Math.cos(a)*y,
      r: p.r+(node.angle || 0), sx: p.sx*node.scale.x, sy: p.sy*node.scale.y };
  };
  const near = (a, b) => assert.ok(Math.abs(a-b) < 1e-6, `${a} != ${b}`);
  const find = (node, name) => node.name === name ? node : node.children.map(child => find(child, name)).find(Boolean);
  h.hud.open();
  for (let id = 0; id < 25; id++) {
    h.hud.openDetail(id);
    for (const role of [itemRoles[id], detail]) for (const key of ['Cat_img', 'Shadow_img', 'Locked_img']) {
      if (!role[key]) continue;
      const preview = h.hud.previews.get(role[key]);
      for (const [partId, x] of [['hand_left', -1.45], ['hand_right', 1.45]]) {
        const part = preview.parts.get(partId), at = world(part.node);
        near(at.x, x); near(at.y, 2.35);
        // Source landmarks run from the upper outer wrist to the round inner
        // fingertips. Their displayed direction must be down, slightly inward.
        const direction = [partId === 'hand_left' ? .52 : -.52, -.52];
        const angle = at.r*Math.PI/180, dx = Math.cos(angle)*direction[0]-Math.sin(angle)*direction[1];
        const dy = Math.sin(angle)*direction[0]+Math.cos(angle)*direction[1];
        assert.ok(dy < -.7, `${partId} fingertips must point down`);
        assert.ok(dx*x < 0 && Math.abs(dx) < .1, `${partId} fingertips should rest slightly inward`);
        assert.equal(part.sprite.spriteFrame, h.art.frames.get(visualConfig.skins[id].parts.find(p => p.id === partId).path));
      }
      const body = world(preview.parts.get('body').node);
      near(body.r, 0);
      const feet = ['foot_left', 'foot_right'].map(id => {
        const node = preview.parts.get(id).node, at = world(node), tr = node.getComponent(h.UITransform);
        near(at.r % 360, 0);
        return { ...at, width: tr.width*Math.abs(at.sx), height: tr.height*at.sy };
      });
      assert.ok(feet[0].sx > 0 && feet[1].sx < 0, 'foot-root pixels, not just rectangles, must mirror');
      assert.equal(preview.parts.get('foot_right').sprite.spriteFrame, preview.parts.get('foot_left').sprite.spriteFrame,
        'the right battle crop has a thicker sloping root and must not overlap the showcase hem');
      near((feet[0].x+feet[1].x)/2, body.x);
      near(feet[0].y-feet[0].height/2, feet[1].y-feet[1].height/2);
      near(feet[0].width, feet[1].width); near(feet[0].height, feet[1].height);
      const head = world(preview.parts.get('head').node), face = world(find(preview.node, 'Face'));
      const a = head.r*Math.PI/180;
      near((face.x-head.x)*Math.cos(a)+(face.y-head.y)*Math.sin(a), 0);
    }
  }
  assert.equal(JSON.stringify(rig), sourceRig, 'showcase must not mutate the battle rig or its animation clips');
  assert.deepEqual(h.records.purchases, []); assert.deepEqual(h.records.equipped, []);
});

test('skin UI prepares all battle bodies and no retired portrait frame; a missing body rejects readiness', async () => {
  const h = harness(), requested = [], loaded = [];
  h.art.json = async () => config;
  h.art.loadFrame = async path => { requested.push(path); return h.art.frames.get(path); };
  h.art.skinVisuals.ensureLoaded = async id => { loaded.push(id); };
  await h.modules['./SkinHud'].loadSkinHudAssets(h.art);
  assert.deepEqual(loaded, [...Array(25).keys()]);
  assert.ok(requested.includes(rig.attachments.face.path));
  const former = ['s593','s800','s544','s421','s471','s568','s721','s587','s701','s636','s754','s414','s892','s738','s702','s667','s592','s679','s878','s672','s619','s472','s590','s740','s765'];
  assert.ok(requested.every(path => !former.some(key => path === 'art/skin-system/images/'+key)));
  h.art.skinVisuals.ensureLoaded = async id => { if (id === 24) throw Error('missing battle body'); };
  await assert.rejects(h.modules['./SkinHud'].loadSkinHudAssets(h.art), /missing battle body/);
});

test('skin purchase adds holding bonuses without equipping, then equip updates both views while keeping detail open', () => {
  const h = harness(1000); h.hud.open(); h.hud.openDetail(1); h.click(detail.Purchase_Btn_obj);
  assert.equal(h.state().diamonds, 900); assert.equal(h.state().owned[1], true); assert.equal(h.state().selectedId, 0);
  assert.equal(h.text(manager.Damage_Accum_txt), '+16%'); assert.equal(h.text(manager.Speed_Accum_txt), '+10%'); assert.equal(h.text(manager.Money_Accum_txt), '+5%');
  assert.equal(h.node(itemRoles[1].Locked_obj).active, false); assert.equal(h.node(detail.Select_Btn_obj).active, true);
  assert.equal(h.node(detail.Selected_obj).active, false); assert.equal(h.node(903).active, true);
  assert.equal(h.records.sounds.at(-1), 7);
  h.click(detail.Purchase_Btn_obj); h.click(detail.Purchase_Btn_obj);
  assert.deepEqual(h.records.purchases, [1]); assert.equal(h.state().diamonds, 900, 'hidden owned purchase button cannot debit twice');
  h.click(detail.Select_Btn_obj); assert.equal(h.state().selectedId, 1); assert.equal(h.records.sounds.at(-1), 9);
  assert.equal(h.node(itemRoles[1].Selected_obj).active, true); assert.equal(h.node(itemRoles[0].Selected_obj).active, false);
  assert.equal(h.node(detail.Selected_obj).active, true); assert.equal(h.node(903).active, true);
  assert.equal(h.state().diamonds, 900); assert.equal(h.text(manager.Damage_Accum_txt), '+16%');
  h.click(1678); assert.equal(h.node(903).active, false); assert.equal(h.hud.isOpen, true);
  h.hud.close(); h.hud.open(); h.hud.openDetail(1); assert.equal(h.node(detail.Selected_obj).active, true);
});

test('owned default keeps its hidden purchase button normal, then next locked detail fades disabled over the source duration', () => {
  const h = harness(22); h.hud.open(); h.hud.openDetail(0); h.hud.update(.2);
  const buy = h.node(detail.Purchase_Btn_obj), spec = config.nodes[detail.Purchase_Btn_obj];
  const tint = () => h.image(detail.Purchase_Btn_obj).color;
  assert.equal(buy.active, false); assert.equal(h.state().items[0].affordable, true);
  assert.deepEqual([tint().r, tint().g, tint().b], spec.image.color.slice(0, 3));
  h.click(detail.Purchase_Btn_obj); assert.equal(h.records.purchases.length, 0); assert.equal(h.state().diamonds, 22);

  h.click(detail.Next_Btn_obj);
  assert.equal(h.text(detail.Num_txt), '2'); assert.equal(buy.active, true);
  assert.equal(tint().r, 255, 'affordability disables input immediately while the former normal tint starts fading');
  h.click(detail.Purchase_Btn_obj); assert.equal(h.records.purchases.length, 0);
  const duration = spec.buttonColors.fadeDuration;
  assert.ok(Math.abs(duration - .1) < 1e-7);
  h.hud.update(duration / 2); assert.equal(tint().r, 208);
  h.hud.update(duration / 2); assert.equal(tint().r, 161);
  assert.equal(tint().g, Math.round(213 * 161 / 255));
  h.emit(buy, 'enter'); h.hud.update(duration); assert.equal(tint().r, 161, 'hover cannot override disabled');
  h.click(detail.Purchase_Btn_obj); assert.equal(h.records.purchases.length, 0); assert.equal(h.state().diamonds, 22);
});

test('skin modal blocks underlying cards and entry, source raycast descendants click, and drag cancellation cannot purchase', () => {
  const h = harness(); h.hud.setEntryBlocked(true); h.click(1160); assert.equal(h.hud.isOpen, false);
  h.hud.setEntryBlocked(false); h.click(1160); assert.equal(h.hud.isOpen, true); assert.equal(h.records.beforeOpen, 1);
  const card = h.node(itemRoles[1].node);
  h.emit(card, 'start'); h.emit(card, 'cancel'); h.emit(card, 'end'); assert.equal(h.node(903).active, false);
  h.clickNode(h.node(itemRoles[1].Cat_img)); assert.equal(h.text(detail.Num_txt), '2');
  h.click(itemRoles[0].node); h.click(2135); assert.equal(h.text(detail.Num_txt), '2'); assert.equal(h.hud.isOpen, true);
  const buy = h.node(detail.Purchase_Btn_obj);
  h.emit(buy, 'start', 1); h.emit(buy, 'end', 2); assert.equal(h.records.purchases.length, 0);
  h.hud.cancelInteractions(); h.emit(buy, 'end', 1); assert.equal(h.records.purchases.length, 0);
  h.emit(buy, 'start'); h.emit(buy, 'end', 1, { x: -1e5, y: -1e5 }); assert.equal(h.records.purchases.length, 0);
  h.hud.close(); assert.deepEqual(h.records.visibility, [true, false]);
  h.hud.setEntryVisible(false); h.click(1160); h.hud.open(); assert.equal(h.hud.isOpen, false);
});

test('skin list and detail backdrops draw and block input across the full screen while panels retain safe-area positions', () => {
  for (const presentation of [false, true]) {
    const h = harness(1000, presentation), near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
    h.hud.open(); h.hud.openDetail(1);
    // Reuse the same view to catch accumulated overflow and stale geometry when
    // resizing back to a device without a notch or home indicator.
    for (const [width, height, top, bottom] of [[360, 800, 40, 0], [390, 844, 47, 34], [1440, 3200, 160, 80], [360, 640, 0, 0]]) {
      h.hud.resize(width, height, top, bottom);
      for (const id of [1691, 1814]) {
        const backdrop = h.node(id), tr = backdrop.getComponent(h.UITransform), p = backdrop.worldPosition, s = backdrop.worldScale;
        near(p.x - tr.width * tr.anchorX * s.x, -width / 2);
        near(p.x + tr.width * (1 - tr.anchorX) * s.x, width / 2);
        near(p.y - tr.height * tr.anchorY * s.y, -height / 2);
        near(p.y + tr.height * (1 - tr.anchorY) * s.y, height / 2);
        const image = backdrop.children.find(child => child.name === 'OriginalImage');
        const rect = image.getComponent(h.Graphics).lastRect;
        near(image.worldPosition.y + rect.y * s.y, -height / 2);
        near(image.worldPosition.y + (rect.y + rect.height) * s.y, height / 2);
        assert.ok(backdrop.getComponent(h.modules.cc.BlockInputEvents), 'expanded backdrop also intercepts edge touches');
        assert.ok(tr.getBoundingBoxToWorld().contains({ x: 0, y: height / 2 - 1 }));
        assert.ok(tr.getBoundingBoxToWorld().contains({ x: 0, y: -height / 2 + 1 }));
      }
      const scale = width / config.referenceWidth, offset = (bottom - top) / 2;
      near(h.node(401).worldPosition.y, offset + config.nodes['level0:401'].rect.position[1] * scale);
      near(h.node(1099).worldPosition.y, -height / 2 + bottom + config.nodes['level0:1099'].rect.position[1] * scale);
    }
    h.click(1678); assert.equal(h.node(903).active, false);
    h.click(2135); assert.equal(h.hud.isOpen, false);
  }
});

test('skin scroll position survives modal close/reopen and safe-area resize while clipped cards reject input', () => {
  const h = harness(); h.hud.open(); const content = h.node(1182), view = content.parent.getComponent(h.UITransform);
  const maximum = content.getComponent(h.UITransform).height - view.height;
  h.click(itemRoles[24].node); assert.equal(h.node(903).active, false, 'last card lies outside the source viewport at the top');
  content.setPosition(0, maximum); h.click(itemRoles[24].node); assert.equal(h.text(detail.Num_txt), '25');
  h.hud.close(); h.hud.open(); assert.equal(content.position.y, maximum);
  h.hud.resize(750, 1334, 24, 14); assert.ok(content.position.y > 0); assert.equal(h.node(903).active, false);
  assert.equal(h.hud.node.position.y, -5); assert.equal(h.hud.node.scale.x, 750 / 1080);
  assert.ok(h.hud.scroll.stops > 0); h.hud.cancelInteractions();
  h.click(2135); assert.equal(h.hud.isOpen, false);
});

test('skin buttons keep source press bounce and color fade, and wallet changes refresh availability', () => {
  const h = harness(22); h.hud.open(); h.hud.openDetail(1); h.hud.update(.2);
  const buyColor = h.image(detail.Purchase_Btn_obj).color;
  assert.equal(buyColor.r, 161); assert.equal(buyColor.g, Math.round(213 * 161 / 255));
  h.setDiamonds(100); h.hud.update(.2); assert.equal(h.image(detail.Purchase_Btn_obj).color.r, 255);
  const next = h.node(detail.Next_Btn_obj); h.emit(next, 'start'); h.hud.update(.05); assert.ok(next.scale.x < 1 && next.scale.x > .89);
  h.emit(next, 'end'); assert.equal(h.text(detail.Num_txt), '3'); h.hud.update(.2); assert.equal(next.scale.x, 1);
  const label = h.node(detail.Price_txt).getComponent(h.Label); assert.equal(label.enabled, false);
  const before = h.bitmapFrames.length; h.hud.update(.1); h.hud.update(.1); assert.equal(h.bitmapFrames.length, before);
  const frames = [...h.bitmapFrames]; h.hud.destroy(); h.hud.destroy();
  assert.equal(h.hud.isOpen, false); assert.equal(h.hud.node.active, false); assert.equal(h.hud.ui.nodes.size, 0);
  assert.ok(frames.every(frame => frame.destroyCalls === 1)); assert.ok(h.borrowedFrames.every(frame => frame.destroyCalls === 0));
});

test('static skin panels reuse their render cache and refresh it for modal lifecycle and layout changes', () => {
  const h = harness(22, true), cache = h.hud.colors;
  assert.equal(cache.beforeDraw(), false);
  h.hud.open(); assert.equal(cache.beforeDraw(), true); assert.equal(cache.beforeDraw(), false);
  let textWrites = 0, imageWrites = 0;
  const setText = h.hud.ui.setText.bind(h.hud.ui), image = h.hud.ui.image.bind(h.hud.ui);
  h.hud.ui.setText = (...args) => { textWrites++; return setText(...args); };
  h.hud.ui.image = (...args) => { imageWrites++; return image(...args); };
  for (let frame = 0; frame < 600; frame++) { h.hud.update(1 / 60); assert.equal(cache.beforeDraw(), false); }
  assert.equal(textWrites, 0); assert.equal(imageWrites, 0);
  h.hud.openDetail(1); assert.equal(cache.beforeDraw(), true);
  h.hud.update(.2); cache.beforeDraw();
  for (let frame = 0; frame < 60; frame++) { h.hud.update(1 / 60); assert.equal(cache.beforeDraw(), false); }
  h.hud.openDetail(2); assert.equal(cache.beforeDraw(), true); assert.equal(h.text(detail.Num_txt), '3');
  h.click(1678); assert.equal(cache.beforeDraw(), true); assert.equal(h.node(903).active, false);
  h.hud.resize(750, 1334, 24, 14); assert.equal(cache.beforeDraw(), true);
  h.hud.update(.2); cache.beforeDraw(); assert.equal(cache.beforeDraw(), false);
  h.hud.close(); assert.equal(cache.beforeDraw(), false);
  h.hud.open(); assert.equal(cache.beforeDraw(), true, 'reopening always repaints even with the same state and scroll offset');
});

test('cached skin UI paints wallet color changes, purchases and equipment without waiting for another input', () => {
  const h = harness(22, true), cache = h.hud.colors;
  h.hud.open(); h.hud.openDetail(1); h.hud.update(.2); cache.beforeDraw();
  assert.equal(cache.beforeDraw(), false);
  h.setDiamonds(100); h.hud.update(.05); assert.equal(cache.beforeDraw(), true);
  assert.ok(h.image(detail.Purchase_Btn_obj).color.r > 161 && h.image(detail.Purchase_Btn_obj).color.r < 255);
  h.hud.update(.05); assert.equal(cache.beforeDraw(), true); assert.equal(h.image(detail.Purchase_Btn_obj).color.r, 255);
  h.hud.update(.2); assert.equal(cache.beforeDraw(), false);
  h.click(detail.Purchase_Btn_obj); assert.equal(cache.beforeDraw(), true);
  assert.equal(h.state().diamonds, 0); assert.equal(h.node(itemRoles[1].Locked_obj).active, false);
  h.click(detail.Select_Btn_obj); assert.equal(cache.beforeDraw(), true);
  assert.equal(h.state().selectedId, 1); assert.equal(h.node(itemRoles[1].Selected_obj).active, true);
  h.hud.update(.5); cache.beforeDraw();
  h.click(detail.Purchase_Btn_obj); h.hud.update(.2); assert.equal(cache.beforeDraw(), false);
  assert.deepEqual(h.records.purchases, [1]);
});

test('render invalidation samples final scroll and button transforms before draw, including release and cancellation', () => {
  const h = harness(1000, true), cache = h.hud.colors, content = h.node(1182);
  h.hud.open(); h.hud.update(.2); cache.beforeDraw();
  // ScrollView can update after GameBootstrap/HUD. Its last inertial or release
  // position must be captured in this draw, without an extra update tick.
  for (const y of [20, 39, 52, 60, 63]) {
    h.hud.update(1 / 60); content.setPosition(0, y);
    assert.equal(cache.beforeDraw(), true); assert.equal(cache.beforeDraw(), false);
  }
  h.hud.openDetail(1); h.hud.update(.2); cache.beforeDraw();
  const buy = h.node(detail.Purchase_Btn_obj), next = h.node(detail.Next_Btn_obj);
  h.emit(buy, 'enter'); h.hud.update(.05); assert.equal(cache.beforeDraw(), true);
  h.hud.update(.06); assert.equal(cache.beforeDraw(), true); h.hud.update(.2); assert.equal(cache.beforeDraw(), false);
  h.emit(buy, 'leave'); h.hud.update(.2); assert.equal(cache.beforeDraw(), true);
  h.emit(next, 'start', 1); h.hud.update(.05); assert.equal(cache.beforeDraw(), true); assert.ok(next.scale.x < 1);
  h.emit(next, 'end', 2); assert.equal(h.text(detail.Num_txt), '2', 'another finger cannot complete this press');
  h.hud.update(.2); assert.equal(cache.beforeDraw(), true);
  h.hud.update(.2); assert.equal(cache.beforeDraw(), false, 'holding the source coroutine at its final scale does not redraw');
  h.hud.cancelInteractions(); assert.equal(next.scale.x, 1); assert.equal(cache.beforeDraw(), true);
  assert.equal(cache.beforeDraw(), false, 'the reset position is painted once even without another HUD update');
  h.emit(next, 'end', 1); assert.equal(h.text(detail.Num_txt), '2');
  h.emit(next, 'start', 3); h.hud.update(.04); cache.beforeDraw();
  h.emit(next, 'cancel', 3); h.hud.update(.2); assert.equal(cache.beforeDraw(), true); assert.equal(next.scale.x, 1);
  h.hud.update(.2); assert.equal(cache.beforeDraw(), false);
});
