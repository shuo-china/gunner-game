const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const core = require('./.build/core/index.js');
const economy = require('./.build/core/EconomyConfig.js');
const original = require('./.build/core/OriginalInfVal.js');
const definition = require('../assets/resources/art/maps/forest/map.json');
const mine = require('../assets/resources/art/mine-system/visuals.json');
const resource = require('./support/resource-modules.cjs').resourceModules();
function moduleFrom(name, modules) {
  const context = { exports: {}, require: id => {
    if (id === './ResourceBatch') return resource('ResourceBatch');
    assert.ok(id in modules, id); return modules[id];
  } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, `../assets/scripts/view/${name}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText, context);
  return context.exports;
}

test('Mine loads every original scene/number/particle sprite before declaring battle ready', async () => {
  const loaded = [], requested = [];
  const art = { catalog: {}, frames: new Map(), json: async path => { requested.push(path); return mine; },
    loadFrame: async path => { loaded.push(path); art.frames.set(path, {}); } };
  const { BattleAssetLoader } = moduleFrom('BattleAssetLoader', { './OriginalMapView': { OriginalMapView: { stageFrames: () => [] } } });
  const loader = new BattleAssetLoader(art, definition), stage = new core.MinePlacement(42).stage;
  assert.equal(loader.ready(stage), false); await loader.load(stage); assert.equal(loader.ready(stage), true);
  assert.deepEqual(requested, ['art/mine-system/visuals']);
  for (const spec of [mine.ground, ...mine.oreSprites, mine.ore.health.image, mine.ore.healthFill.image,
    ...mine.dustParticles.map(p => p.image), ...Object.values(mine.diamondNumbers.glyphs)]) assert.ok(loaded.includes(spec.path), spec.path);
  assert.equal(mine.dustParticles.reduce((sum, p) => sum + p.bursts.reduce((n, b) => n + b.count, 0), 0), 5);
  assert.equal(mine.diamondNumbers.cooldown, 0);
});

test('Mine uses the original double-size ground plane/UV and restores Main afterward', () => {
  class Sprite {} class UITransform {} class Vec4 { constructor(...values) { this.values = values; } }
  const { OriginalMapView } = moduleFrom('OriginalMapView', { cc: { Sprite, UITransform, Vec4, Texture2D: { WrapMode: { REPEAT: 1 } } },
    '../core': core, './ArtLibrary': {}, './MapBorderGeometry': {}, './OriginalParticleMesh': {} });
  const map = Object.create(OriginalMapView.prototype);
  const node = () => ({ active: true, position: { x: 0, y: 0 }, sprite: {}, transform: {
    setContentSize(...size) { this.size = size; }, setAnchorPoint(...anchor) { this.anchor = anchor; } },
    getComponent(Type) { return Type === Sprite ? this.sprite : this.transform; }, setPosition(x, y) { this.position = { x, y }; }, setScale(x, y) { this.scale = { x, y }; } });
  const frame = spec => ({ rect: { x: 0, y: 0, width: spec.sizePx[0], height: spec.sizePx[1] }, rotated: false,
    texture: { width: spec.sizePx[0], height: spec.sizePx[1], setWrapMode() {} } });
  map.definition = definition; map.skinIndex = 0; map.origin = { x: 0, z: 0 }; map.arena = map.raid = map.hunt = map.mine = false;
  map.fillItems = []; map.shadowLayer = node(); map.material = { setProperty(name, value) { this[name] = value; } };
  map.art = { catalog: { mine }, frames: new Map([definition.sprites.ground, mine.ground].map(spec => [spec.path, frame(spec)])) };
  map.spriteItems = ['ground', definition.borders[0].asset].map((asset, index) => {
    const item = { node: node(), asset, basis: index ? definition.borders[0] : definition.ground }; item.visible = { node: item.node }; return item; });
  map.visibleItems = map.spriteItems.map(item => item.visible); const ground = map.spriteItems[0].node;
  map.setBattlefield(new core.MinePlacement(1).stage);
  assert.equal(ground.sprite.spriteFrame, map.art.frames.get(mine.ground.path));
  assert.deepEqual(ground.transform.size, [10.24, 10.24]); assert.deepEqual(ground.position, core.projectWorld({ x: -100, z: 0 }));
  assert.ok(Math.abs(ground.scale.x - 30) < 1e-5); assert.ok(Math.abs(ground.scale.y - 17.32034) < 1e-4);
  assert.deepEqual(map.material.uvTransform.values, [14, 7.480000019073486, 0, 0]);
  assert.deepEqual(map.material.groundClip.values, [.5, .5, .25, 1]); assert.equal(map.spriteItems[1].node.active, false);
  map.setBattlefield(core.createStageDefinition(0, 0, 1));
  assert.equal(ground.sprite.spriteFrame, map.art.frames.get(definition.sprites.ground.path));
  assert.equal(map.spriteItems[1].node.active, true); assert.deepEqual(map.material.groundClip.values, [.5, .5, .25, 0]);
});

test('Mine shows original normal/rare ore, reveals health only on hit and emits fractional diamond text without throttling', () => {
  class Node {
    constructor(name) { Object.assign(this, { name, children: [], components: new Map(), active: true }); }
    addComponent(Type) { const component = new Type(); component.node = this; this.components.set(Type, component); return component; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y, z = 0) { this.position = { x, y, z }; } setScale(x, y, z = 1) { this.scale = { x, y, z }; }
    destroy() { this.destroyed = true; }
  }
  class UITransform { setContentSize(...size) { this.size = size; } }
  class Sprite { static Type = { FILLED: 1 }; static FillType = { HORIZONTAL: 1 }; }
  class Color {}
  const makeNode = (name, parent) => { const node = new Node(name); node.addComponent(UITransform); if (parent) { node.parent = parent; parent.children.push(node); } return node; };
  const texts = [], dust = [];
  const modules = { cc: { Node, Sprite, UITransform, Color, gfx: { BlendFactor: { ONE: 1 } } }, '../core': core,
    '../core/projection': core, '../core/OriginalInfVal': original, '../core/EconomyConfig': economy, './ArtLibrary': { makeNode },
    './DamageNumbers': { DamageNumbers: class { update() {} reset() {} diagnostics() { return { active: texts.length }; }
      spawnStyledText(...args) { texts.push(args); } } },
    './OriginalParticleSimulation': { OriginalParticleSimulation: class { particles = []; update() {} reset() {} hit(...args) { dust.push(args); } } }, './OriginalParticleMesh': {} };
  modules['./OriginalFeedbackMath'] = moduleFrom('OriginalFeedbackMath', modules);
  const { MineView } = moduleFrom('MineView', modules);
  const root = makeNode('root'), health = makeNode('health'), fill = makeNode('fill');
  const art = { catalog: { mine }, image: (name, spec, parent) => { const node = makeNode(name, parent); node.addComponent(Sprite).path = spec.path; return node; } };
  const ores = [core.createMineOre(0, { x: -100, z: 30 }), core.createMineOre(1, { x: -100, z: 34 }, true)];
  const view = new MineView(art, ores, root, health, fill, () => root);
  assert.equal(health.children.length, 0); assert.equal(view.renderGroups.length, 2);
  assert.equal(view.views.get(ores[0].id).sprite.getComponent(Sprite).path, mine.oreSprites[0].path);
  assert.equal(view.views.get(ores[1].id).sprite.getComponent(Sprite).path, mine.oreSprites[1].path);
  ores[0].health = core.DecimalAmount.from(2); view.hit(ores[0].id); view.update(.01, .01);
  assert.equal(health.children[0].active, true); assert.equal(fill.children[0].getComponent(Sprite).fillRange, 2 / 3);
  ores[0].alive = false; view.die(ores[0].position, ores[0].score, .01); view.die(ores[1].position, ores[1].score, .01); view.update(.01, .02);
  assert.equal(health.children[0].active, false); assert.equal(view.views.get(ores[0].id).node.active, false);
  assert.deepEqual(texts.map(args => args[2]), ['+0.2', '+2']); assert.equal(texts[0][1], 4); assert.equal(texts[0][4], .01);
  assert.equal(dust.length, 2); assert.equal(dust[0][2], 4);
  view.setActive(false); assert.equal(view.views.get(ores[1].id).node.active, false);
  view.destroy(); assert.equal(health.children[0].destroyed, true);
});

test('Mine dust renders single original atlas tiles, reuses frames and expires without destroying the shared texture', () => {
  class Node {
    constructor(name) { Object.assign(this, { name, children: [], components: new Map(), active: true }); }
    addComponent(Type) { const component = new Type(); component.node = this; this.components.set(Type, component); return component; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y, z = 0) { this.position = { x, y, z }; }
    setScale(x, y, z = 1) { this.scale = { x, y, z }; }
    destroy() { this.destroyed = true; }
  }
  class UITransform { setContentSize(width, height) { Object.assign(this, { width, height }); } }
  class Sprite { static Type = { FILLED: 1 }; static FillType = { HORIZONTAL: 1 }; updateMaterial() {} }
  class Color { constructor(...values) { this.values = values; } }
  class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
  class Size { constructor(width, height) { Object.assign(this, { width, height }); } }
  class SpriteFrame { reset(options) { Object.assign(this, options); } destroy() { this.destroyed = true; } }
  const makeNode = (name, parent) => { const node = new Node(name); node.addComponent(UITransform);
    if (parent) { node.parent = parent; parent.children.push(node); } return node; };
  const { OriginalParticleSimulation } = require('./.build/feedback/view/OriginalParticleSimulation.js');
  const modules = {
    cc: { Node, Sprite, UITransform, Color, Rect, Size, SpriteFrame,
      gfx: { BlendFactor: { ZERO: 0, ONE: 1, SRC_ALPHA: 5, ONE_MINUS_SRC_ALPHA: 10 } } },
    '../core': core, '../core/projection': core, '../core/OriginalInfVal': original, '../core/EconomyConfig': economy,
    './ArtLibrary': { makeNode }, './OriginalParticleMesh': {},
    './DamageNumbers': { DamageNumbers: class { update() {} reset() {} spawnStyledText() {} diagnostics() { return { active: 0 }; } } },
    './OriginalParticleSimulation': { OriginalParticleSimulation: class extends OriginalParticleSimulation {
      constructor(specs) { super(specs, () => .5); }
    } },
  };
  modules['./OriginalFeedbackMath'] = moduleFrom('OriginalFeedbackMath', modules);
  const { MineView } = moduleFrom('MineView', modules), root = makeNode('root');
  const spec = mine.dustParticles[0], texture = { id: 'original dust atlas' };
  const atlas = { texture, rect: new Rect(0, 0, 256, 256) };
  const art = { catalog: { mine }, frames: new Map([[spec.image.path, atlas]]), image(name, image, parent) {
    const node = makeNode(name, parent), sprite = node.addComponent(Sprite);
    sprite.spriteFrame = art.frames.get(image.path); return node;
  } };
  const ore = core.createMineOre(0, { x: -100, z: 30 });
  const view = new MineView(art, [ore], root, root, root, () => root);
  view.hit(ore.id); view.update(.02, .02);
  assert.equal(view.diagnostics().dust, 0, 'ordinary hits do not emit Ore.Die_Reload debris');
  view.die(ore.position, ore.score, .02); view.update(0, .02);
  const live = () => view.particleViews.filter(p => p.node.active);
  assert.equal(live().length, 5, 'Ore.Die_Reload emits exactly five particles at Y=4');
  for (const particle of live()) {
    // Constant seeded sample .5 selects frame 6 of the original 4x4 sheet.
    assert.deepEqual({ ...particle.sprite.spriteFrame.rect }, { x: 128, y: 64, width: 64, height: 64 });
    assert.equal(particle.sprite.spriteFrame.texture, texture);
    assert.equal(particle.sprite.spriteFrame.packable, false);
    assert.equal(particle.transform.width, 2, 'tile cropping retains authored world size');
    assert.equal(particle.sprite.srcBlendFactor, 5); assert.equal(particle.sprite._dstBlendFactor, 10);
  }
  const tile = live()[0].sprite.spriteFrame;
  assert.ok(live().every(p => p.sprite.spriteFrame === tile), 'particles share cached tile frames');
  view.clearTransientEffects(); view.update(0, .02); assert.equal(live().length, 0);
  view.die(ore.position, ore.score, .02); view.update(.1, .12);
  assert.ok(live().every(p => p.sprite.spriteFrame === tile), 'pooled particles retain the correct tile');
  view.setActive(false); view.update(.1, .22); assert.equal(live().length, 5, 'emitted dust survives leaving Mine');
  view.update(3, 3.22); assert.equal(live().length, 0);
  view.destroy(); assert.equal(tile.destroyed, true); assert.equal(atlas.destroyed, undefined); assert.equal(texture.destroyed, undefined);
});

test('leaving Mine retains its global diamond/dust effects until expiry and a full reset clears them', () => {
  const source = fs.readFileSync(path.join(__dirname, '../assets/scripts/view/BattlefieldView.ts'), 'utf8');
  const context = { exports: {}, require: id => id === '../core' ? core : {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText, context);
  const field = Object.create(context.exports.BattlefieldView.prototype), noop = () => {}, effects = { dust: 1, numbers: 1 };
  let hidden = false, destroyed = 0, updates = 0;
  const mineView = { setActive: active => { hidden = !active; }, destroy: () => destroyed++, diagnostics: () => effects,
    update: () => updates++ };
  Object.assign(field, { world: { stage: {}, players: [], trees: [], damageTargets: [], bulletWalls: [], simulationTime: 2, bullets: [], player: { position: { x: 0, z: 0 } } },
    map: { setBattlefield: noop, cameraCenter: () => ({ x: 0, y: 0 }), updateCamera: noop }, node: { setPosition: noop },
    cats: new Map(), trees: new Map(), retiredMineViews: [], mineView, aspect: 1,
    createTrees: noop, createRaidBoss: noop, createBoss: noop, setParticleColliders: noop, syncCharacters: noop, syncPets: noop, sortRenderGroups: noop,
    target: { reset: noop, update: noop }, projectiles: { reset: noop, update: noop }, numbers: { reset: noop, update: noop },
    moneyBurst: { reset: noop, setWalls: noop, update: noop }, impactTimeOffset: 0, lastImpactSourceTime: 0 });
  field.reset({ preserveTransientEffects: true }); assert.equal(hidden, true); assert.equal(destroyed, 0);
  assert.equal(field.mineView, undefined); assert.equal(field.retiredMineViews[0], mineView);
  field.update(.1); assert.equal(updates, 1); assert.equal(destroyed, 0);
  effects.dust = effects.numbers = 0; field.update(.1); assert.equal(destroyed, 1); assert.equal(field.retiredMineViews.length, 0);
  field.retiredMineViews.push(mineView); field.reset(); assert.equal(destroyed, 2); assert.equal(field.retiredMineViews.length, 0);
});

test('Mine routes ordinary white hit numbers and separate diamond rewards through their respective pools', () => {
  const source = fs.readFileSync(path.join(__dirname, '../assets/scripts/view/BattlefieldView.ts'), 'utf8');
  const context = { exports: {}, require: id => id === '../core' ? core : {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText, context);
  const field = Object.create(context.exports.BattlefieldView.prototype), hits = [], numbers = [], diamonds = [];
  const ore = core.createMineOre(0, { x: -100, z: 30 });
  Object.assign(field, { world: { stage: { ores: [ore] }, simulationTime: .02 }, trees: new Map(),
    lastImpactSourceTime: 0, impactTimeOffset: 0, impactFx: { beginFrame() {} }, projectiles: {},
    mineView: { hit: id => hits.push(id), die: (...args) => diamonds.push(args) },
    numbers: { spawn: (...args) => numbers.push(args) } });
  const meta = { position: ore.position, damage: core.DecimalAmount.from(1), sourceTime: .02, critical: false, height: 2 };
  field.handleEvents([{ type: 'hit', treeId: ore.id, ...meta }, { type: 'oreDied', oreId: ore.id, position: ore.position, score: 1, sourceTime: .02 }], []);
  assert.deepEqual(hits, [ore.id]); assert.equal(numbers.length, 1); assert.equal(numbers[0][1].toString(), '1');
  assert.equal(numbers[0][3], false); assert.equal(diamonds.length, 1); assert.equal(diamonds[0][1], 1);
  field.handleEvents([{ type: 'damageText', ...meta }], []);
  assert.equal(numbers.length, 2); assert.equal(hits.length, 1); assert.equal(diamonds.length, 1);
});
