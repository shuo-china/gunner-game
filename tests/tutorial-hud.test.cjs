const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/tutorial-system/config.json');
const near = (actual, expected, tolerance = .00001) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

function fixture() {
  const nodes = [];
  class Vec3 {
    constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
    set(x, y, z) { if (typeof x === 'object') ({ x, y, z } = x); Object.assign(this, { x, y, z }); return this; }
  }
  class UITransform {
    width = 100; height = 100; anchorX = .5; anchorY = .5;
    setContentSize(width, height) { this.width = width; this.height = height; }
    setAnchorPoint(x, y) { this.anchorX = x; this.anchorY = y; }
    convertToWorldSpaceAR(point, out) {
      const p = this.node.worldPosition, s = this.node.worldScale;
      return out.set(p.x + point.x * s.x, p.y + point.y * s.y, p.z + point.z * s.z);
    }
  }
  class Node {
    constructor(name) { this.name = name; this.active = true; this.isValid = true; this.children = []; this.components = new Map();
      this.position = { x: 0, y: 0, z: 0 }; this.scale = { x: 1, y: 1, z: 1 }; this.listeners = []; nodes.push(this); }
    addChild(child) { child.parent = this; this.children.push(child); }
    addComponent(Type) { const component = new Type(); component.node = this; this.components.set(Type, component); return component; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y, z = 0) { this.position = { x, y, z }; }
    setScale(x, y, z = 1) { this.scale = { x, y, z }; }
    get worldScale() { const p = this.parent?.worldScale ?? { x: 1, y: 1, z: 1 }; return { x: p.x * this.scale.x, y: p.y * this.scale.y, z: p.z * this.scale.z }; }
    get worldPosition() {
      const p = this.parent?.worldPosition ?? { x: 0, y: 0, z: 0 }, s = this.parent?.worldScale ?? { x: 1, y: 1, z: 1 };
      return { x: p.x + this.position.x * s.x, y: p.y + this.position.y * s.y, z: p.z + this.position.z * s.z };
    }
    setWorldPosition(x, y, z) {
      const p = this.parent?.worldPosition ?? { x: 0, y: 0, z: 0 }, s = this.parent?.worldScale ?? { x: 1, y: 1, z: 1 };
      this.setPosition((x - p.x) / s.x, (y - p.y) / s.y, (z - p.z) / s.z);
    }
    setSiblingIndex(index) { const siblings = this.parent?.children; if (!siblings) return; siblings.splice(siblings.indexOf(this), 1); siblings.splice(index, 0, this); }
    on(...args) { this.listeners.push(args); }
    destroy() { this.isValid = false; this.children.forEach(child => child.destroy()); }
  }
  class Sprite {}
  class Color { constructor(r, g, b, a) { Object.assign(this, { r, g, b, a }); } }
  const makeNode = (name, parent) => { const node = new Node(name); node.addComponent(UITransform); parent?.addChild(node); return node; };
  const calls = [];
  const art = {
    json: async key => { calls.push(key); return config; }, loadFrame: async key => { calls.push(key); return {}; },
    image(name, spec, parent) {
      const node = makeNode(name, parent); node.addComponent(Sprite); node.getComponent(UITransform).setContentSize(...spec.sizeUnits);
      node.setPosition(...spec.localPosition); node.setScale(...spec.localScale); return node;
    },
  };
  const module = { exports: {} }, source = fs.readFileSync(path.join(root, 'assets/scripts/view/TutorialHud.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, { module, exports: module.exports, require: name => {
    if (name === 'cc') return { Node, UITransform, Sprite, Color, Vec3 };
    if (name === './ArtLibrary') return { makeNode };
    throw new Error(name);
  } });
  const canvas = makeNode('Canvas'), panel = makeNode('WeaponPanel', canvas), upgrade = makeNode('Power', canvas);
  const entry = makeNode('WeaponEntry', canvas), buy = makeNode('Buy', panel), from = makeNode('Backpack', panel), to = makeNode('Slot2', panel);
  upgrade.setPosition(-320, -820); entry.setPosition(-475, -600); buy.setPosition(110, -800); from.setPosition(-200, -300); to.setPosition(200, -100);
  const hud = new module.exports.TutorialHud(canvas, art, config), pointer = hud.node.children[0], hand = pointer.children[0];
  const targets = { upgrade, entry, buy, from, to, canUpgrade: true, weaponOpen: false, blocked: false };
  const update = (step, dt = 0, extra = {}) => hud.update({ active: true, step, drawCount: 0 }, { ...targets, ...extra }, dt);
  hud.resize(1080, 1920);
  return { ...module.exports, hud, pointer, hand, targets, update, nodes, canvas, panel, Sprite, UITransform, art, calls };
}

test('tutorial artwork is an independent exact original cat hand with source pulse and drag timings', async () => {
  const f = fixture(); assert.equal(await f.loadTutorialHudAssets(f.art), config);
  assert.deepEqual(f.calls, ['art/tutorial-system/config', 'art/tutorial-system/cat-hand']);
  const image = fs.readFileSync(path.join(root, 'assets/resources/art/tutorial-system/cat-hand.png'));
  assert.deepEqual(image, fs.readFileSync(path.join(root, 'assets/resources/art/weapon-system/images/s796.png')));
  assert.equal(config.hand.source, 'sharedassets0.assets:796'); assert.deepEqual(config.hand.sizeUnits, [208, 208]);
  assert.deepEqual(config.hand.localPosition, [37, -72]); near(config.hand.localScale[0], .9);
  assert.equal(config.source.raycastTarget, false); assert.equal(config.pulse.duration, 1);
  assert.equal(config.pulse.ease, 'OutQuad'); assert.equal(config.pulse.loop, 'Yoyo'); near(config.pulse.endScale, 1.2);
  near(config.drag.moveDuration, 1.2); near(config.drag.scaleDuration, .15); near(config.drag.pauseAtTarget, .15);
});

test('affordable upgrades pulse without blocking any input until the shared unlock gate is met', () => {
  const f = fixture(); f.update('upgrade'); assert.equal(f.hud.node.active, true);
  assert.deepEqual(f.pointer.worldPosition, f.targets.upgrade.worldPosition); assert.equal(f.hand.getComponent(f.Sprite).color.a, 255);
  f.update('upgrade', .5); near(f.pointer.scale.x, 1.15);
  f.update('upgrade', .5); near(f.pointer.scale.x, 1.2);
  f.update('upgrade', .5); near(f.pointer.scale.x, 1.15);
  assert.ok(f.nodes.every(node => node.listeners.length === 0));
  f.update('upgrade', 0, { canUpgrade: false }); assert.equal(f.hud.node.active, false);
  f.update('upgrade'); assert.equal(f.hud.node.active, true);
  f.update('upgrade', 0, { weaponOpen: true }); assert.equal(f.hud.node.active, false);
});

test('gun steps point at the correct entry or buy button and reopen the panel when closed', () => {
  const f = fixture();
  for (const step of ['gunOpen', 'gunBuy', 'gunMerge', 'gunEquip']) {
    f.update(step); assert.equal(f.hud.node.active, true); assert.deepEqual(f.pointer.worldPosition, f.targets.entry.worldPosition);
  }
  f.update('gunOpen', 0, { weaponOpen: true }); assert.equal(f.hud.node.active, false);
  f.update('gunBuy', 0, { weaponOpen: true }); assert.deepEqual(f.pointer.worldPosition, f.targets.buy.worldPosition);
  assert.equal(f.hand.getComponent(f.Sprite).color.a, 210);
  f.hud.update({ active: true, step: 'gunBuy', drawCount: 1 }, { ...f.targets, weaponOpen: true });
  assert.deepEqual(f.pointer.worldPosition, f.targets.buy.worldPosition, 'the second purchase keeps pointing at the draw button');
});

test('merge guidance drags between the two backpack cards and requires both targets', () => {
  const f = fixture(), { scaleDuration, moveDuration } = config.drag;
  f.update('gunMerge', 0, { weaponOpen: true });
  assert.deepEqual(f.pointer.worldPosition, f.targets.from.worldPosition);
  f.update('gunMerge', scaleDuration + moveDuration, { weaponOpen: true });
  assert.deepEqual(f.pointer.worldPosition, f.targets.to.worldPosition);
  for (const missing of [{ from: null }, { to: null }]) {
    f.update('gunMerge', 0, { weaponOpen: true, ...missing }); assert.equal(f.hud.node.active, false);
  }
  f.update('gunMerge', 0, { weaponOpen: false });
  assert.deepEqual(f.pointer.worldPosition, f.targets.entry.worldPosition);
  f.update('gunMerge', 0, { weaponOpen: true });
  assert.deepEqual(f.pointer.worldPosition, f.targets.from.worldPosition, 'reopening resumes the merge gesture from its source');
});

test('left-anchored weapon entry points at its rectangle center instead of the screen edge', () => {
  const f = fixture(), entry = f.targets.entry, transform = entry.getComponent(f.UITransform);
  entry.setPosition(-540, -605); transform.setContentSize(160, 120); transform.setAnchorPoint(0, .5);
  f.update('gunOpen'); near(f.pointer.worldPosition.x, -460); near(f.pointer.worldPosition.y, -605);
  f.update('gunOpen', 1); near(f.pointer.worldPosition.x, -460); near(f.pointer.scale.x, 1.2);
  entry.components.delete(f.UITransform); f.update('gunOpen');
  assert.deepEqual(f.pointer.worldPosition, entry.worldPosition, 'non-UI targets retain the world-position fallback');
});

test('drag endpoints use both rectangle centers through non-central anchors and nested scaling', () => {
  const f = fixture(), source = f.targets.from.getComponent(f.UITransform), destination = f.targets.to.getComponent(f.UITransform);
  f.panel.setPosition(25, -140); f.panel.setScale(.5, .75);
  f.targets.from.setScale(2, 1); source.setContentSize(100, 80); source.setAnchorPoint(0, 1);
  f.targets.to.setScale(.5, 2); destination.setContentSize(200, 60); destination.setAnchorPoint(1, 0);
  f.update('gunEquip', 0, { weaponOpen: true });
  near(f.pointer.worldPosition.x, -25); near(f.pointer.worldPosition.y, -395);
  f.update('gunEquip', config.drag.scaleDuration + config.drag.moveDuration / 2, { weaponOpen: true });
  near(f.pointer.worldPosition.x, 37.5); near(f.pointer.worldPosition.y, -282.5);
  f.panel.setPosition(50, -100); f.hud.resize(540, 1100, 30, 50);
  near(f.pointer.worldPosition.x, 62.5); near(f.pointer.worldPosition.y, -242.5);
  f.update('gunEquip', config.drag.moveDuration / 2, { weaponOpen: true });
  near(f.pointer.worldPosition.x, 125); near(f.pointer.worldPosition.y, -130);
});

test('equipment hand presses, drags to the second slot, releases, pauses and starts again', () => {
  const f = fixture(), { scaleDuration: s, moveDuration: m, pauseAtTarget: p, scaleSmall } = config.drag;
  const step = dt => f.update('gunEquip', dt, { weaponOpen: true });
  step(0); assert.deepEqual(f.pointer.worldPosition, f.targets.from.worldPosition); near(f.pointer.scale.x, 1);
  step(s / 2); near(f.pointer.scale.x, (1 + scaleSmall) / 2);
  step(s / 2 + m / 2); near(f.pointer.worldPosition.x, 0); near(f.pointer.worldPosition.y, -200); near(f.pointer.scale.x, scaleSmall);
  step(m / 2); assert.deepEqual(f.pointer.worldPosition, f.targets.to.worldPosition); near(f.pointer.scale.x, scaleSmall);
  step(s); near(f.pointer.scale.x, 1); assert.deepEqual(f.pointer.worldPosition, f.targets.to.worldPosition);
  step(p + .001); near(f.pointer.worldPosition.x, f.targets.from.worldPosition.x);
});

test('nested targets and safe-area moves remain aligned after resize, including midway through a drag', () => {
  const f = fixture(); f.panel.setScale(.5, .5); f.panel.setPosition(25, -140);
  f.update('gunEquip', config.drag.scaleDuration + config.drag.moveDuration / 2, { weaponOpen: true });
  near(f.pointer.worldPosition.x, 25); near(f.pointer.worldPosition.y, -240);
  f.panel.setPosition(50, -100); f.hud.resize(540, 1100, 30, 50);
  near(f.pointer.worldPosition.x, 50); near(f.pointer.worldPosition.y, -200); near(f.hud.node.scale.x, .5);
  near(f.hand.worldScale.x, config.drag.scaleSmall * .5 * .9);
});

test('missing, hidden, destroyed targets and blocking modals hide immediately; resume restarts animation', () => {
  const f = fixture(); const equip = extra => f.update('gunEquip', .2, { weaponOpen: true, ...extra });
  equip({}); assert.equal(f.hud.node.active, true);
  equip({ blocked: true }); assert.equal(f.hud.node.active, false);
  f.update('gunEquip', 0, { weaponOpen: true }); near(f.pointer.scale.x, 1);
  equip({ from: null }); assert.equal(f.hud.node.active, false);
  equip({ to: null }); assert.equal(f.hud.node.active, false);
  f.panel.active = false; equip({}); assert.equal(f.hud.node.active, false);
  f.panel.active = true; f.targets.to.destroy(); equip({}); assert.equal(f.hud.node.active, false);
});

test('hide, completion, inactive state and destruction leave no delayed animation or revival', () => {
  const f = fixture(); f.update('upgrade', NaN); near(f.pointer.scale.x, 1);
  f.update('upgrade', -5); near(f.pointer.scale.x, 1);
  f.hud.hide(); assert.equal(f.hud.node.active, false);
  f.update('done', 1000); assert.equal(f.hud.node.active, false);
  f.hud.update({ active: false, step: 'upgrade' }, f.targets, 1); assert.equal(f.hud.node.active, false);
  f.update('upgrade', 1000000); assert.ok(Number.isFinite(f.pointer.scale.x));
  f.hud.destroy(); f.hud.destroy(); f.update('upgrade'); f.hud.resize(400, 800);
  assert.equal(f.hud.node.active, false); assert.equal(f.hud.node.isValid, false);
});
