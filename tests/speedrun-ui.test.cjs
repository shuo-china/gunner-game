const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/speedrun-system/config.json');

test('challenge HUD uses the completed-stage reward snapshot for the advertised total', () => {
  const h = harness({ reward: 47, additionalReward: 13, totalReward: 60, stage: 4, phase: 'won', resultElapsed: 2 }, { speedRun: { additionalDiamonds: 13 } });
  h.hud.update(0); assert.equal(h.text(117223), '60');
  h.state.adEnabled = false; h.hud.update(0); assert.equal(h.text(117223), '47');
  assert.equal(h.records.ads, 0);
});

// Run the real source renderer, particle simulation and HUD against minimal Cocos primitives.
function harness(overrides = {}, economy = require('./.build/session/core/EconomyConfig.js').ECONOMY_CONFIG, prepare) {
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
    constructor(name) { Object.assign(this, { name, isValid: true, children: [], components: new Map(), events: new Map(), active: true, position: new Vec3(), scale: new Vec3(1, 1, 1) }); }
    addChild(node) { node.parent = this; this.children.push(node); }
    addComponent(Type) { const value = new Type(); value.node = this; this.components.set(Type, value); return value; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y, z = 0) { this.position = new Vec3(x, y, z); }
    setScale(x, y, z = 1) { this.scale = new Vec3(x, y, z); }
    on(event, callback) { this.events.set(event, callback); }
    destroy() { this.destroyed = true; this.isValid = false; }
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
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'OriginalWeaponConfettiNoise', 'OriginalWeaponConfettiMath', 'OriginalWeaponConfetti', 'RewardedAdModal', 'SpeedRunHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const state = { unlocked: true, stage: 0, reward: 60, additionalReward: 180, totalReward: 240, money: '1.2a', diamonds: '60', phase: 'idle',
    progress: 0, remainingSeconds: 60, resultElapsed: 0, adAvailable: true, adEnabled: true, ...overrides };
  const records = { alerts: [], sounds: [], visibility: [], starts: 0, exits: 0, ads: 0, results: [] };
  const canvas = makeNode('Canvas'); let request = null;
  const modal = new modules['./RewardedAdModal'].RewardedAdModal(canvas, (id, outcome) => {
    if (!request || request.token !== id) return; const current = request; request = null; current.complete(outcome);
  });
  const presenter = { showRewardedAd(token, placement, complete) { request = { token, placement, complete }; modal.open(token); },
    cancelRewardedAd(token) { if (request?.token === token) { request = null; modal.dismiss(); } } };
  const hud = new modules['./SpeedRunHud'].SpeedRunHud(canvas, art,
    { config, chineseFont: new Font(), originalFont: new Font(), numberFont: new Font() }, {
      getState: () => state,
      start: () => { records.starts++; state.phase = 'entering'; return { ok: true }; },
      exit: () => { records.exits++; state.phase = 'exiting'; return { ok: true }; },
      beginAd: () => { records.ads++; state.phase = 'adPending'; return { ok: true, token: records.ads === 1 ? 'ad-token' : `ad-token-${records.ads}` }; },
      completeAd: (token, outcome) => { records.results.push({ token, outcome }); state.phase = outcome === 'success' ? 'exiting' : 'won'; return { ok: outcome === 'success' }; },
      cancelAd: () => { records.results.push({ outcome: 'cancel' }); state.phase = 'won'; },
      alert: value => records.alerts.push(value), playSfx: id => records.sounds.push(id), onVisibilityChanged: value => records.visibility.push(value),
    }, presenter, prepare);
  const node = id => hud.ui.node(`level0:${id}`);
  const event = (target, id = 1, at, originalType) => ({ getID: () => id, getUILocation: () => at || target.worldPosition, getEventCode: () => originalType });
  const emit = (target, type, id, at, originalType = type) => target.events.get(type)?.(event(target, id, at, originalType));
  const clickNode = target => { emit(target, 'start'); emit(target, 'end'); };
  const click = id => clickNode(node(id));
  const text = id => node(id).getComponent(Label).string;
  return { hud, canvas, modal, presenter, state, records, node, click, clickNode, emit, text, UITransform, Label, RichText, Sprite, atlases, borrowedFrames, bitmapFrames, LabelOutline, LabelShadow };
}

test('challenge prepares hidden node-by-node and its prepared resize matches the synchronous HUD', async () => {
  const { preparationDriver } = require('./support/ui-preparation.cjs');
  const driver = preparationDriver(), h = harness({}, undefined, driver.prepare), sync = harness();
  assert.equal(h.hud.node.active, false); assert.equal(h.hud.ui.nodes.size, 0);
  await Promise.resolve();
  let before = 0;
  for (let frame = 0; frame < 40; frame++) {
    driver.advance();
    const after = Object.keys(config.nodes).filter(id => h.hud.ui.get(id)).length;
    assert.ok(after - before <= 1, 'each construction step creates at most one authored node');
    assert.equal(h.hud.node.active, false); before = after;
  }
  await driver.flush(); await h.hud.prepared;
  assert.equal(h.hud.node.active, true); assert.equal(h.hud.isOpen, false);
  assert.equal(h.records.starts, 0); assert.equal(h.records.ads, 0);
  const snapshot = fixture => Object.keys(config.nodes).map(id => {
    const node = fixture.hud.ui.get(id), tr = node?.getComponent(fixture.UITransform);
    return node && [id, node.active, node.position.x, node.position.y, tr.width, tr.height, node.getComponent(fixture.Label)?.string];
  });
  assert.deepEqual(snapshot(h), snapshot(sync));
  const resize = h.hud.resizePrepared(driver.prepare, 390, 844, 34, 16);
  assert.equal(h.hud.node.active, false);
  await driver.flush(); await resize;
  sync.hud.resize(390, 844, 34, 16);
  assert.deepEqual(snapshot(h), snapshot(sync));
  h.hud.open(); assert.equal(h.hud.isOpen, true); assert.equal(h.records.starts, 0);
});

test('destroying the scene mid-preparation rejects and frees generated glyphs without touching shared art', async () => {
  const { preparationDriver } = require('./support/ui-preparation.cjs');
  const driver = preparationDriver(), h = harness({}, undefined, driver.prepare);
  const rejected = assert.rejects(h.hud.prepared, /owner destroyed/);
  await Promise.resolve(); driver.advance(45);
  assert.ok(h.bitmapFrames.length > 0); h.canvas.destroy(); driver.advance();
  await rejected;
  assert.doesNotThrow(() => { h.hud.destroy(); h.hud.destroy(); });
  assert.equal(h.hud.node.destroyed, true); assert.equal(h.hud.node.active, false);
  assert.equal(h.hud.ui.nodes.size, 0);
  assert.ok(h.bitmapFrames.every(frame => frame.destroyCalls === 1));
  assert.ok(h.borrowedFrames.every(frame => frame.destroyCalls === 0));
  assert.equal(h.records.starts, 0); assert.equal(h.records.ads, 0);
});

test('challenge destroy is safe and idempotent at every partially initialized stage', async () => {
  const { preparationDriver } = require('./support/ui-preparation.cjs');
  for (const steps of [0, 1, 45, 95, 180]) {
    const driver = preparationDriver(), h = harness({}, undefined, driver.prepare);
    const rejected = assert.rejects(h.hud.prepared, /owner destroyed/);
    await Promise.resolve(); driver.advance(steps);
    assert.doesNotThrow(() => { h.hud.destroy(); h.hud.destroy(); }, `destroy after ${steps} steps`);
    driver.advance(); await rejected;
    assert.equal(h.hud.node.destroyed, true); assert.equal(h.hud.ui.nodes.size, 0);
    assert.ok(h.bitmapFrames.every(frame => frame.destroyCalls === 1));
    assert.ok(h.borrowedFrames.every(frame => frame.destroyCalls === 0));
    assert.deepEqual(h.records.results, []); assert.deepEqual(h.records.visibility, []);
  }
});


test('challenge export keeps ordinary source geometry and omits all PlusPack and sweep controls', () => {
  const forbidden = /PlusPack|Sweep|^Auto_obj$|NoAds|Remove Ads|FreeCash|IAP/;
  assert.ok(Object.values(config.nodes).every(node => !forbidden.test(node.name)));
  assert.deepEqual(config.nodes['level0:1825'].rect.size, [1000, 864.2999877929688]);
  assert.equal(config.nodes['level0:1170'].active, true);
  assert.equal(config.nodes['level0:465'], undefined);
  assert.equal(config.nodes['level0:10311'].text.value, '在1分钟内摧毁所有树木！');
  assert.equal(config.nodes['level0:1825'].image.sprite, 's478');
  assert.equal(config.animations.win.duration, 1.5);
  assert.equal(config.animations.fail.duration, 1.5);
  assert.equal(config.confetti.length, 3);
  assert.equal(config.treeIcons.length, 40);
  assert.equal(config.nodes['level0:19137'], undefined);
  assert.equal(config.nodes['level0:19132'], undefined);
  assert.ok(Object.values(config.nodes).every(node => !/\$\d/.test(node.text?.value ?? '')));
  for (const image of Object.values(config.images)) assert.ok(fs.existsSync(path.join(root, 'assets/resources', image.path + '.png')));
  for (const font of Object.values(config.bitmapFonts)) for (const page of font.pages) assert.ok(fs.existsSync(path.join(root, 'assets/resources', page + '.png')));
});

test('ordinary challenge opens, uses stage plus one, settles bounce, and launches once', () => {
  const h = harness({ stage: 2 }); h.click(444); h.hud.update(.31);
  assert.equal(h.hud.isOpen, true); assert.equal(h.hud.blocksUpgrades, true);
  assert.equal(h.text(10219), 'Stage 3');
  assert.equal(h.node(1825).scale.x, 1);
  assert.equal(h.node(1170).active, true);
  h.click(2179); h.click(2179);
  assert.equal(h.records.starts, 1); assert.equal(h.state.phase, 'entering');
  assert.equal(h.node(937).active, false); assert.equal(h.node(1457).active, false);
  assert.equal(h.hud.blocksUpgrades, true);
});

test('challenge entry follows shared unlock state even after the outer menu requests visibility', () => {
  const h = harness({ unlocked: false });
  h.hud.setEntryVisible(true); assert.equal(h.node(444).active, false);
  h.hud.open(); assert.equal(h.hud.isOpen, false);
  h.state.unlocked = true; h.hud.update(0); assert.equal(h.node(444).active, true);
  h.hud.open(); assert.equal(h.hud.isOpen, true);
});

test('covering the challenge entry preserves unlock and phase visibility rules across refreshes', () => {
  const h = harness({ unlocked: false }); h.hud.setEntryBlocked(true);
  assert.equal(h.node(444).active, false);
  h.state.unlocked = true; h.hud.update(0); h.hud.resize(540, 1100, 20, 30);
  assert.equal(h.node(444).active, true, 'an unlocked entry stays drawn under the modal');
  h.click(444); assert.equal(h.hud.isOpen, false, 'refresh does not remove the input block');
  h.hud.setEntryBlocked(false); assert.equal(h.node(444).active, true);
  h.state.phase = 'playing'; h.hud.setEntryBlocked(true); h.hud.update(0);
  assert.equal(h.node(444).active, false, 'blocking does not bypass the challenge phase gate');
});

test('covering the challenge entry cancels held input and rejects new presses without blocking popup controls', () => {
  const h = harness(), entry = h.node(444);
  h.emit(entry, 'start', 7); h.hud.update(.05); assert.equal(h.hud.touches.has(entry), true);
  h.hud.setEntryBlocked(true);
  assert.equal(entry.active, true); assert.equal(h.hud.touches.has(entry), false); assert.equal(entry.scale.x, 1);
  assert.equal(h.hud.selected, null);
  h.click(444); assert.equal(h.hud.isOpen, false); assert.equal(h.hud.touches.has(entry), false);
  h.hud.setEntryBlocked(false); h.emit(entry, 'end', 7);
  assert.equal(h.hud.isOpen, false); assert.deepEqual(h.records.sounds, []);
  h.click(444); assert.equal(h.hud.isOpen, true, 'a fresh press remains usable');
  h.hud.setEntryBlocked(true); h.hud.update(.31); h.click(2179); assert.equal(h.records.starts, 1, 'popup controls remain usable');
});

test('ad-free challenge keeps the animated claim button and hides advertisements and skip controls', () => {
  const h = harness({ adEnabled: false, adAvailable: false, phase: 'won', diamonds: '60' });
  for (const elapsed of [0, .5, .99, 1, 1.6, 5]) {
    h.state.resultElapsed = elapsed; h.hud.update(.1);
    assert.equal(h.node(1538).active, elapsed >= 1, `the claim button keeps its reveal time at ${elapsed}`);
    for (const id of [857, 1144, 934]) assert.equal(h.node(id).active, false, `${id} stays hidden at ${elapsed}`);
    assert.equal(h.node(1132).active, true);
    assert.equal(h.text(10302), '领取'); assert.equal(h.node(10302).position.x, 0);
    assert.equal(h.text(117223), '60', 'the large win amount must match the granted base reward, not the hidden advertisement total');
    assert.equal(h.text(117137), '60');
    assert.equal(h.text(119571), '60', 'the wallet shows the same already-granted first-win reward');
    if (elapsed < 1) { h.click(1132); assert.equal(h.records.exits, 0, 'claim cannot run before its reveal'); }
  }
  h.click(2298); assert.equal(h.records.exits, 0, 'hidden skip cannot exit');
  h.click(1132); h.click(1132); h.hud.invoke('Bonus_AD_Show', '');
  assert.equal(h.records.exits, 1); assert.equal(h.records.ads, 0); assert.deepEqual(h.records.results, []);
  assert.equal(h.state.phase, 'exiting'); assert.equal(h.state.diamonds, '60'); assert.equal(h.modal.isOpen, false);
});

test('win amount follows advertisement policy changes and the configured base reward without granting anything', () => {
  const h = harness({ phase: 'won', resultElapsed: 2, reward: 45, additionalReward: 135, totalReward: 180, diamonds: '45' });
  h.hud.update(0); assert.equal(h.text(117223), '180');
  h.state.adEnabled = false; h.hud.update(0);
  assert.equal(h.text(117223), '45'); assert.equal(h.text(117137), '45'); assert.equal(h.text(119571), '45');
  assert.equal(h.node(1538).active, true);
  for (const id of [857, 1144, 934]) assert.equal(h.node(id).active, false);
  h.state.adEnabled = true; h.hud.update(0);
  assert.equal(h.text(117223), '180'); assert.equal(h.text(117137), '45'); assert.equal(h.text(119571), '45');
  assert.equal(h.node(1538).active, true); assert.equal(h.records.ads, 0); assert.deepEqual(h.records.results, []);
  for (const id of [857, 1144, 934]) assert.equal(h.node(id).active, true);
});

test('disabling challenge advertising cancels the open request without accepting its stale success', () => {
  const h = harness({ phase: 'won', resultElapsed: 2 }); let stale;
  const present = h.presenter.showRewardedAd;
  h.presenter.showRewardedAd = (token, placement, complete) => { stale = complete; present(token, placement, complete); };
  h.click(1132); h.state.adEnabled = false; h.hud.update(0); stale('success');
  assert.equal(h.state.phase, 'won'); assert.equal(h.node(1538).active, true); assert.equal(h.modal.isOpen, false);
  for (const id of [857, 1144, 934]) assert.equal(h.node(id).active, false);
  assert.deepEqual(h.records.results, [{ outcome: 'cancel' }]);
  h.click(1132); h.click(1132); stale('success');
  assert.equal(h.records.exits, 1); assert.equal(h.records.ads, 1); assert.equal(h.state.diamonds, '60');
  assert.deepEqual(h.records.results, [{ outcome: 'cancel' }]);
});

test('ad-free challenge claim stays within portrait safe areas after resizing and cancels held gestures', () => {
  for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) {
    const h = harness({ phase: 'won', resultElapsed: 2, adEnabled: false, adAvailable: false });
    const top = 44, bottom = 24, button = h.node(1132);
    h.emit(button, 'start', 1); h.hud.resize(width, height, top, bottom); h.hud.update(0);
    h.emit(button, 'end', 1); assert.equal(h.records.exits, 0);
    const tr = button.getComponent(h.UITransform), p = button.worldPosition, s = button.worldScale;
    const left = p.x - tr.anchorX * tr.width * s.x, low = p.y - tr.anchorY * tr.height * s.y;
    assert.ok(left >= -width / 2 && left + tr.width * s.x <= width / 2);
    assert.ok(low >= -height / 2 + bottom && low + tr.height * s.y <= height / 2 - top);
    for (let node = button; node; node = node.parent) assert.equal(node.active, true);
    h.click(1132); h.click(1132); assert.equal(h.records.exits, 1); assert.equal(h.records.ads, 0);
  }
});

test('battle HUD preserves sliced fill clipping and permits ordinary upgrades', () => {
  const h = harness({ phase: 'playing', progress: .083, remainingSeconds: 55.3 });
  h.hud.update(0);
  assert.equal(h.hud.isOpen, true); assert.equal(h.hud.blocksUpgrades, false);
  assert.equal(h.node(1457).active, true); assert.equal(h.node(32526).active, false);
  assert.equal(h.node(117195).getComponent(h.Label).string, '8%');
  assert.equal(h.node(117305).getComponent(h.Label).string, '56s');
  const fill = h.node(1318), image = fill.children.find(child => child.name === 'OriginalImage');
  assert.ok(Math.abs(fill.getComponent(h.UITransform).width / image.getComponent(h.UITransform).width - 55.3 / 60) < 1e-8);
  h.state.remainingSeconds = 55; h.hud.update(0);
  assert.equal(h.node(117305).getComponent(h.Label).string, '56s', 'native Time_Reload truncates time + 1 even at an exact integer');
  h.click(174); assert.equal(h.records.exits, 1); assert.equal(h.state.phase, 'exiting');
});

test('win reveals original timed controls, base reward and optional ad reward without paid branch', () => {
  const h = harness(); h.state.phase = 'won'; h.state.resultElapsed = 0; h.hud.update(0);
  assert.equal(h.node(548).active, false); assert.equal(h.node(2298).active, false);
  assert.deepEqual(h.records.sounds, [11]);
  h.state.resultElapsed = 1.49; h.hud.update(.1); assert.equal(h.node(2298).active, false);
  h.state.resultElapsed = 1.51; h.hud.update(.1); assert.equal(h.node(2298).active, true);
  assert.equal(h.node(117223).getComponent(h.Label).string, '240');
  assert.equal(h.node(117137).getComponent(h.Label).string, '60');
  assert.equal(h.node(548).scale.x, 1);
  h.click(1132); assert.equal(h.records.ads, 1); assert.equal(h.modal.node.active, true);
  const button = h.modal.node.children[0].children.find(node => node.name === 'Ad1'); h.clickNode(button);
  assert.deepEqual(h.records.results, [{ token: 'ad-token', outcome: 'cancel' }]);
  assert.equal(h.state.phase, 'won'); assert.equal(h.node(2298).active, true);
  h.click(2298); assert.equal(h.records.exits, 1);
});

test('failure uses its own sound, zero reward, delayed exit and cleans all owned UI resources', () => {
  const h = harness(); h.state.phase = 'failed'; h.state.resultElapsed = .1; h.hud.update(0);
  assert.equal(h.node(1435).active, false); assert.deepEqual(h.records.sounds, [12]);
  h.state.resultElapsed = 1.6; h.hud.update(.1);
  assert.equal(h.node(1435).active, true); assert.equal(h.node(117389).getComponent(h.Label).string, '0');
  h.click(1752); assert.equal(h.records.exits, 1);
  h.hud.destroy(); h.hud.destroy(); assert.equal(h.hud.node.destroyed, true);
  assert.ok(h.borrowedFrames.every(frame => frame.destroyCalls === 0));
  assert.ok(h.bitmapFrames.every(frame => frame.destroyCalls === 1));
});

test('dismiss and resize invalidate pressed gestures; disabled ad cannot create a token', () => {
  const h = harness(); h.hud.open(); h.hud.update(.31);
  h.emit(h.node(2179), 'start'); h.hud.resize(390, 844); h.emit(h.node(2179), 'end');
  assert.equal(h.records.starts, 0); h.hud.close(); assert.equal(h.hud.isOpen, false);
  h.state.phase = 'won'; h.state.resultElapsed = 2; h.state.adAvailable = false; h.hud.update(0);
  h.click(1132); assert.equal(h.records.ads, 0);
});

test('ad success and failure consume one token and closing pending ad cancels it', () => {
  for (const [index, outcome] of [[0, 'success'], [2, 'failure']]) {
    const h = harness({ phase: 'won', resultElapsed: 2 }); h.click(1132);
    const button = h.modal.node.children[0].children.find(node => node.name === `Ad${index}`);
    h.clickNode(button); h.clickNode(button);
    assert.deepEqual(h.records.results, [{ token: 'ad-token', outcome }]);
    assert.equal(h.state.phase, outcome === 'success' ? 'exiting' : 'won');
    assert.deepEqual(h.records.alerts, outcome === 'failure' ? ['广告加载失败。'] : []);
  }
  const h = harness({ phase: 'won', resultElapsed: 2 }); h.click(1132); h.hud.close();
  assert.deepEqual(h.records.results, [{ outcome: 'cancel' }]); assert.equal(h.state.phase, 'won');
  assert.equal(h.modal.node.active, false);
});

test('background cancellation invalidates all held ad fingers before reopening', () => {
  const h = harness({ phase: 'won', resultElapsed: 2 }); h.click(1132);
  const buttons = h.modal.node.children[0].children.filter(node => /^Ad\d$/.test(node.name));
  h.emit(buttons[0], 'start', 11); h.emit(buttons[2], 'start', 22);
  h.hud.cancelInteractions();
  assert.deepEqual(h.records.results, [{ outcome: 'cancel' }]);
  h.click(1132);
  h.emit(buttons[0], 'end', 11); h.emit(buttons[2], 'end', 22);
  assert.equal(h.state.phase, 'adPending');
  assert.equal(h.records.results.length, 1, 'obsolete fingers cannot complete the new token');
  h.emit(buttons[0], 'start', 33); h.emit(buttons[0], 'end', 33);
  assert.deepEqual(h.records.results, [{ outcome: 'cancel' }, { token: 'ad-token-2', outcome: 'success' }]);
});

test('simultaneous ad actions accept one completion and clear the other held finger', () => {
  const h = harness({ phase: 'won', resultElapsed: 2 }); h.click(1132);
  const buttons = h.modal.node.children[0].children.filter(node => /^Ad\d$/.test(node.name));
  h.emit(buttons[0], 'start', 11); h.emit(buttons[2], 'start', 22);
  h.emit(buttons[2], 'end', 22);
  h.click(1132); h.emit(buttons[0], 'end', 11);
  assert.deepEqual(h.records.results, [{ token: 'ad-token', outcome: 'failure' }]);
  assert.equal(h.state.phase, 'adPending');
  h.emit(buttons[0], 'start', 33); h.emit(buttons[0], 'start', 44);
  h.emit(buttons[0], 'cancel', 44); h.emit(buttons[0], 'end', 44);
  assert.equal(h.records.results.length, 1, 'another finger cannot replace or cancel the owning finger');
  h.emit(buttons[0], 'end', 33);
  assert.deepEqual(h.records.results, [{ token: 'ad-token', outcome: 'failure' }, { token: 'ad-token-2', outcome: 'success' }]);
});

test('resizing and externally ending an ad invalidate its pending gesture', () => {
  for (const reason of ['resize', 'external']) {
    const h = harness({ phase: 'won', resultElapsed: 2 }); h.click(1132);
    const button = h.modal.node.children[0].children.find(node => node.name === 'Ad0');
    h.emit(button, 'start', 11);
    if (reason === 'resize') { h.hud.resize(390, 844); h.modal.resize(390, 844); }
    else { h.state.phase = 'won'; h.hud.update(0); h.click(1132); }
    h.emit(button, 'end', 11);
    assert.equal(h.records.results.length, 0);
    assert.equal(h.state.phase, 'adPending');
  }
});

test('a busy shared provider may fail synchronously without leaving a token or accepting a second result', () => {
  const h = harness({ phase: 'won', resultElapsed: 2 });
  h.presenter.showRewardedAd = (token, placement, complete) => {
    assert.equal(placement, 'speedrun'); complete('failure'); complete('success');
  };
  h.click(1132);
  assert.equal(h.state.phase, 'won'); assert.equal(h.modal.isOpen, false);
  assert.deepEqual(h.records.results, [{ token: 'ad-token', outcome: 'failure' }]);
});
