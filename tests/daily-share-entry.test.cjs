const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');

function fixture() {
  const texts = [], sounds = [], loads = [];
  let clicks = 0;
  class UITransform {
    setContentSize(width, height) { this.contentSize = { width, height }; }
    getBoundingBoxToWorld() { return { contains: point => point.inside }; }
  }
  class Node {
    static EventType = { TOUCH_START: 'start', TOUCH_END: 'end', TOUCH_CANCEL: 'cancel' };
    events = {}; children = []; components = new Map(); active = true;
    constructor(name) { this.name = name; this.addComponent(UITransform); }
    addChild(child) { this.children.push(child); child.parent = this; }
    addComponent(Type) { const value = new Type(); value.node = this; this.components.set(Type, value); return value; }
    getComponent(Type) { return this.components.get(Type); }
    on(name, handler) { this.events[name] = handler; }
    setPosition(x, y, z = 0) { this.position = { x, y, z }; }
    setScale(x, y, z) { this.scale = { x, y, z }; }
    destroy() { this.destroyed = true; }
  }
  const makeNode = (name, parent) => { const node = new Node(name); parent?.addChild(node); return node; };
  const imports = {
    cc: { Node, UITransform, Font: class {} },
    './ArtLibrary': { makeNode },
    './OriginalWeaponUi': { OriginalWeaponUi: class {
      create(id, parent) { return makeNode(id, parent); }
      setText(id, value) { texts.push({ id, value }); }
      show() {} layout() {} destroy() {}
    } },
    './OriginalWeaponFeedback': { OriginalWeaponFeedback: class { press() {} release() {} clear() {} update() {} } },
  };
  for (const name of ['FeatureEntry', 'DailyShareEntry']) {
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath(`assets/scripts/view/${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
    }).outputText, { module, exports: module.exports, require: name => { assert.ok(name in imports, name); return imports[name]; } });
    imports[`./${name}`] = module.exports;
  }
  const shareModule = imports['./DailyShareEntry'], config = shareModule.dailyShareEntryConfig();
  const art = { loadFrame: async path => loads.push(path) };
  const entry = new shareModule.DailyShareEntry(makeNode('Canvas'), art, { config }, () => clicks++, id => sounds.push(id));
  const emit = (name, id = 1, inside = true) => entry.entry.events[name]({ getID: () => id, getUILocation: () => ({ inside }) });
  return { entry, emit, config, texts, sounds, loads, art, shareModule, clicks: () => clicks,
    rightMenuOffsets: imports['./FeatureEntry'].rightMenuOffsets,
    rightMenuShareOffset: imports['./FeatureEntry'].rightMenuShareOffset };
}

test('share entry uses one integrated icon with the existing right-menu panel and share label', async () => {
  const h = fixture();
  const mine = require('../assets/resources/art/feature-entries/mine.json');
  const icon = h.config.nodes.ShareIcon;
  assert.equal(h.config.images[icon.image.sprite].path, 'art/share-system/images/entry-share');
  assert.equal(icon.image.preserveAspect, true);
  assert.equal(h.config.images.background.path, mine.images.s803.path);
  assert.equal(Object.values(h.config.nodes).filter(node => node.image && node.id !== h.config.roots.entry).length, 1,
    'the diamond and sharing action are one sprite rather than separately drawn pieces');
  for (const image of Object.values(h.config.images)) {
    const bytes = fs.readFileSync(projectPath('assets/resources', image.path + '.png'));
    assert.equal(bytes.readUInt32BE(16), image.sizePx[0]); assert.equal(bytes.readUInt32BE(20), image.sizePx[1]);
  }
  const assets = await h.shareModule.loadDailyShareEntryAssets(h.art);
  assert.equal(h.loads.length, 2); assert.deepEqual(h.loads.sort(), Object.values(h.config.images).map(image => image.path).sort());
  assert.equal(assets.config.nodes.ShareLabel.text.value, '分享');
  assert.equal(h.config.nodes.ShareAmount, undefined, 'the icon must not include a +80 amount overlay');
  assert.deepEqual(Object.values(h.config.nodes).filter(node => node.text).map(node => node.text.value), ['分享']);
  assert.equal(h.config.nodes.ShareLabel.text.outline, true);
  h.entry.destroy();
});

test('share reward state controls visibility and interactivity without writing an amount label', () => {
  const h = fixture();
  assert.equal(h.entry.node.active, false);
  h.entry.setRewardState(true, false);
  assert.equal(h.entry.node.active, true);
  h.entry.setRewardState(true, true);
  h.emit('start'); h.emit('end'); assert.equal(h.clicks(), 0);
  h.entry.setRewardState(true, false);
  h.emit('start'); h.emit('end'); assert.equal(h.clicks(), 1);
  assert.deepEqual(h.texts, [], 'state refreshes never create a numeric reward overlay');
  h.entry.setRewardState(false, true);
  assert.equal(h.entry.node.active, false); h.entry.destroy();
});

test('share entry preserves pointer cancellation, blocked state and the existing click sound', () => {
  const h = fixture(); h.entry.setRewardState(true, false);
  h.emit('start'); h.emit('end', 2); assert.equal(h.clicks(), 0);
  h.emit('end'); assert.equal(h.clicks(), 1); assert.deepEqual(h.sounds, [1]);
  h.emit('start'); h.entry.setRewardState(true, true); h.emit('end'); assert.equal(h.clicks(), 1);
  h.entry.setRewardState(true, false); h.emit('start'); h.emit('cancel'); h.emit('end'); assert.equal(h.clicks(), 1);
  h.emit('start'); h.emit('end', 1, false); assert.equal(h.clicks(), 1);
  h.emit('start'); h.entry.setRewardState(false, true); h.emit('end'); assert.equal(h.clicks(), 1);
  h.entry.destroy();
});

test('share stays above every visible right-menu entry through all visibility combinations', () => {
  const h = fixture(), names = ['speedrun', 'mine', 'boss', 'hunt', 'adventure', 'raid'];
  for (let mask = 0; mask < 1 << names.length; mask++) {
    const visible = Object.fromEntries(names.map((name, index) => [name, !!(mask & (1 << index))]));
    const gameplayOffsets = Object.values(h.rightMenuOffsets(visible));
    assert.equal(h.rightMenuShareOffset(visible), (gameplayOffsets.length ? Math.max(...gameplayOffsets) : 230) + 125);
  }
  assert.equal(h.rightMenuShareOffset({ weapons: true, skins: true, rebirth: true }), 355, 'left entries never displace the right menu');
  h.entry.resize(720, 1280, 40, 20); h.entry.setEntryOffset(1105);
  assert.equal(h.entry.entry.position.x, 540);
  assert.equal(h.entry.node.position.y, -10, 'the right entry retains safe-area centering');
  assert.equal(h.entry.entry.position.y, 190); h.entry.destroy();
});
