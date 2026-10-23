const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness({ failMaterialAt = 0, failTextureAt = 0 } = {}) {
  const resources = [], nodes = [], events = new Map(), descriptorCache = new Map();
  class Vec3 { constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); } }
  class Node {
    constructor(name) { Object.assign(this, { name, children: [], components: new Map(), layer: 1 << 25, active: true, isValid: true,
      position: new Vec3(), scale: new Vec3(1, 1, 1), worldRotation: {}, destroyCalls: 0 }); nodes.push(this); }
    addChild(node) { node.parent = this; this.children.push(node); }
    addComponent(Type) { const value = new Type(); value.node = this; value.isValid = true; this.components.set(Type, value); return value; }
    getComponent(Type) { return this.components.get(Type); }
    setScale(x, y, z) { this.scale = new Vec3(x, y, z); }
    setWorldPosition(x, y, z) { const v = typeof x === 'number' ? new Vec3(x, y, z) : x, p = this.parent?.worldPosition ?? new Vec3(), s = this.parent?.worldScale ?? new Vec3(1, 1, 1); this.position = new Vec3((v.x - p.x) / s.x, (v.y - p.y) / s.y, (v.z - p.z) / s.z); }
    setWorldRotation(value) { this.worldRotation = value; }
    get worldPosition() { const p = this.parent?.worldPosition ?? new Vec3(), s = this.parent?.worldScale ?? new Vec3(1, 1, 1); return new Vec3(p.x + this.position.x * s.x, p.y + this.position.y * s.y, p.z + this.position.z * s.z); }
    get worldScale() { const p = this.parent?.worldScale ?? new Vec3(1, 1, 1); return new Vec3(this.scale.x * p.x, this.scale.y * p.y, this.scale.z * p.z); }
    destroy() { if (!this.isValid) return; this.destroyCalls++; this.isValid = false; this.children.forEach(child => child.destroy()); this.components.forEach(component => { component.node = null; component.isValid = false; }); }
  }
  class UITransform { setContentSize(width, height) { Object.assign(this, { width, height }); } hitTest(point, windowId) { this.lastHit = { layer: this.node.layer, point, windowId }; if (this.throwHit) throw new Error('hit failed'); return point.inMask; } }
  class Camera { static ProjectionType = { ORTHO: 1 }; static ClearFlag = { SOLID_COLOR: 7 }; constructor() { Object.assign(this, { priority: 10, visibility: (1 << 25) | (1 << 30), targetTexture: null, rect: { x: 0, y: 0, width: 1, height: 1 }, near: 0, far: 2000, orthoHeight: 960 }); }
    get targetTexture() { return this._targetTexture; } set targetTexture(value) {
      if (this._targetTexture === value) return;
      this._targetTexture?.window?.cameras.delete(this); this._targetTexture = value; value?.window?.cameras.add(this);
      this.targetAssignments?.push(value); if (value && this.resetOrthoOnTarget) this.orthoHeight = this.resetOrthoOnTarget;
    }
  }
  class Canvas { alignCanvasWithScreen = true; }
  class Resource { constructor() { this.destroyCalls = 0; resources.push(this); } destroy() { this.destroyCalls++; } }
  let materialCount = 0;
  class Material extends Resource { setProperty(name, value) { (this.properties ||= {})[name] = value; } initialize(value) { Object.assign(this, value); if (++materialCount === failMaterialAt) throw new Error('material failed'); } }
  let textureId = 0, textureInitializations = 0;
  class RenderTexture extends Resource {
    constructor() { super(); this.hash = ++textureId; }
    initialize(value) {
      if (++textureInitializations === failTextureAt) throw new Error('texture failed');
      if (this.gfxTexture) this.gfxTexture.alive = false;
      this.window ??= { cameras: new Set() }; this.window.cameras.clear(); this.gfxTexture = { alive: true };
      this.initializations = (this.initializations || 0) + 1; Object.assign(this, value);
    }
    setWrapMode(...value) { this.wrap = value; }
    resize(width, height) { this.resizeCalls = (this.resizeCalls || 0) + 1; Object.assign(this, { width: Math.min(2048, width), height: Math.min(2048, height) }); }
    destroy() { if (this.gfxTexture) this.gfxTexture.alive = false; this.window?.cameras.clear(); descriptorCache.delete(this.hash); super.destroy(); }
  }
  class SpriteFrame extends Resource { reset(value, full) { Object.assign(this, value); this.fullReset = full; } }
  class Sprite { static SizeMode = { CUSTOM: 1 }; }
  class Color { constructor(r, g, b, a) { Object.assign(this, { r, g, b, a }); } }
  const director = {
    on: (event, callback, receiver) => { const listeners = events.get(event) ?? []; listeners.push({ callback, receiver }); events.set(event, listeners); },
    off: (event, callback, receiver) => { const listeners = (events.get(event) ?? []).filter(value => value.callback !== callback || value.receiver !== receiver);
      if (listeners.length) events.set(event, listeners); else events.delete(event); },
    emit: event => { for (const value of [...(events.get(event) ?? [])]) value.callback.call(value.receiver); },
  };
  const cc = { Node, UITransform, Camera, Canvas, Material, RenderTexture, SpriteFrame, Sprite, Color, director, Director: { EVENT_BEFORE_DRAW: 'draw', EVENT_AFTER_DRAW: 'afterDraw' }, view: { scaleY: 1, getScaleY() { return this.scaleY; } },
    screen: { windowSize: { width: 720, height: 1280 } }, Texture2D: { WrapMode: { CLAMP_TO_EDGE: 1 } } };
  const makeNode = (name, parent) => { const node = new Node(name); node.layer = parent?.layer ?? 1 << 25; node.addComponent(UITransform); parent?.addChild(node); return node; };
  const module = { exports: {} }, source = fs.readFileSync(path.join(__dirname, '../assets/scripts/view/SkinHudColorPipeline.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
    { module, exports: module.exports, require: key => key === 'cc' ? cc : { makeNode } });
  const canvas = makeNode('Canvas'); canvas.position = new Vec3(360, 640);
  const mainNode = makeNode('MainCamera', canvas), camera = mainNode.addComponent(Camera); mainNode.position = new Vec3(0, 0, 1000);
  const hud = makeNode('GameInterface', canvas), owner = makeNode('Skin', hud); owner.setScale(2 / 3, 2 / 3, 1); owner.position = new Vec3(0, -10);
  // Creator's 2D descriptor cache keys by the texture asset hash, not the GFX
  // texture recreated by RenderTexture.initialize. Reusing that key samples a dead texture.
  const sampleSprite = sprite => {
    const texture = sprite.spriteFrame.texture;
    if (!descriptorCache.has(texture.hash)) descriptorCache.set(texture.hash, texture.gfxTexture);
    return descriptorCache.get(texture.hash);
  };
  return { ...module.exports, cc, makeNode, canvas, hud, owner, camera, resources, nodes, events, sampleSprite, descriptorCache,
    failNextTextureInitialization: (offset = 1) => { failTextureAt = textureInitializations + offset; } };
}

test('skin linear compositor separates capture, linear blend and display with full-resolution stencil targets', () => {
  const h = harness(), visibility = h.camera.visibility, pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  assert.equal(pipeline.content.active, false);
  pipeline.resize(720, 1280); pipeline.setActive(true);
  assert.equal(h.camera.targetTexture, pipeline.textures[0]);
  assert.equal(pipeline.cameras[0].targetTexture, pipeline.textures[1]);
  assert.equal(pipeline.cameras[1].targetTexture, null);
  assert.equal(pipeline.cameras[0].visibility, h.SKIN_LINEAR_LAYER);
  assert.equal(h.camera.visibility & (h.SKIN_LINEAR_LAYER | h.SKIN_PRESENT_LAYER | h.SKIN_FOREGROUND_LAYER), 0);
  assert.ok(h.camera.priority < pipeline.cameras[0].priority && pipeline.cameras[0].priority < pipeline.cameras[1].priority);
  assert.equal(pipeline.ownedMaterials[2].defines.SAMPLE_FROM_RT, true);
  assert.equal(pipeline.ownedMaterials[2].properties.backgroundTexture, pipeline.textures[0]);
  assert.equal(pipeline.cameras[0].clearColor.a, 0);
  assert.equal(pipeline.quads.length, 1);
  for (const texture of pipeline.textures) assert.deepEqual([texture.width, texture.height], [720, 1280]);
  for (const quad of pipeline.quads) {
    assert.equal(quad.worldScale.x, 1); assert.equal(quad.worldScale.y, 1);
    assert.equal(quad.worldPosition.x, 360); assert.equal(quad.worldPosition.y, 640);
  }
  h.cc.screen.windowSize = { width: 1080, height: 2340 }; pipeline.resize(720, 1560);
  for (const texture of pipeline.textures) assert.deepEqual([texture.width, texture.height], [1080, 2340]);
  for (const frame of pipeline.frames) assert.equal(frame.fullReset, true);
  pipeline.setActive(false); assert.equal(h.camera.targetTexture, null); assert.equal(h.camera.visibility, visibility);
  assert.equal(pipeline.content.active, false);
  assert.ok(pipeline.cameraNodes.every(node => !node.active)); pipeline.destroy(); pipeline.destroy();
  assert.ok(h.resources.every(resource => resource.destroyCalls === 1)); assert.equal(h.events.size, 0);
});

test('alerts, tutorials and later canvas overlays keep their foreground order and restore original layers', () => {
  const h = harness(), behind = h.makeNode('BeforeSkin', h.hud); h.hud.children.splice(h.hud.children.indexOf(behind), 1); h.hud.children.unshift(behind);
  const alert = h.makeNode('Alert', h.hud), text = h.makeNode('AlertText', alert), loading = h.makeNode('Loading', h.canvas);
  const original = text.layer, pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  pipeline.resize(720, 1280); pipeline.setActive(true); h.cc.director.emit('draw');
  assert.equal(behind.layer, original); assert.equal(alert.layer, h.SKIN_FOREGROUND_LAYER); assert.equal(text.layer, h.SKIN_FOREGROUND_LAYER); assert.equal(loading.layer, h.SKIN_FOREGROUND_LAYER);
  assert.ok(pipeline.cameras[1].visibility & alert.layer); assert.equal(h.camera.visibility & alert.layer, 0);
  const lateGlyph = h.makeNode('LateGlyph', alert);
  pipeline.setActive(false); for (const node of [alert, text, lateGlyph, loading]) assert.equal(node.layer, original);
  pipeline.setActive(true);
  h.hud.children.splice(h.hud.children.indexOf(alert), 1); h.hud.children.unshift(alert); h.cc.director.emit('draw');
  assert.equal(alert.layer, original); assert.equal(text.layer, original); assert.equal(loading.layer, h.SKIN_FOREGROUND_LAYER);
  pipeline.destroy(); assert.equal(loading.layer, original);
});

test('skin compositor restores borrowed target and survives scene-first destruction and partial initialization', () => {
  const h = harness(), originalTarget = { name: 'borrowed-target' }; h.camera.targetTexture = originalTarget;
  const pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  pipeline.setActive(true); assert.equal(pipeline.cameras[1].targetTexture, originalTarget);
  pipeline.setActive(false); assert.equal(h.camera.targetTexture, originalTarget);
  pipeline.setActive(true); h.canvas.destroy(); assert.doesNotThrow(() => { pipeline.destroy(); pipeline.destroy(); });
  assert.ok(h.resources.every(resource => resource.destroyCalls === 1)); assert.equal(h.events.size, 0);
  for (let failMaterialAt = 1; failMaterialAt <= 3; failMaterialAt++) {
    const failed = harness({ failMaterialAt }), visibility = failed.camera.visibility;
    assert.throws(() => new failed.SkinHudColorPipeline(failed.owner, { camera: failed.camera, effects: [{}, {}, {}] }), /material failed/);
    assert.equal(failed.camera.visibility, visibility); assert.equal(failed.camera.targetTexture, null);
    assert.ok(failed.resources.every(resource => resource.destroyCalls === 1)); assert.equal(failed.events.size, 0);
  }
});

test('source black skin overlay retains its serialized alpha and its linear blend explains the original brown', () => {
  const config = require('../assets/resources/art/skin-system/config.json'), item = config.roles[config.roles['level0:123519'].Skin_item_list[1]];
  const color = config.nodes[item.Locked_obj].image.color; assert.deepEqual(color, [0, 0, 0, 194]);
  const decode = c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  const encode = c => c <= .0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - .055;
  const source = [252, 214, 144], linear = source.map(c => Math.round(encode(decode(c / 255) * (1 - color[3] / 255)) * 255));
  const gamma = source.map(c => Math.round(c * (1 - color[3] / 255)));
  assert.deepEqual(gamma, [60, 51, 34]); assert.deepEqual(linear, [133, 112, 73]);
});

test('offscreen skin hit testing uses the screen camera query and keeps engine mask checks, pointer state and render layer', () => {
  const h = harness(), pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  const card = h.makeNode('Card', pipeline.content), tr = card.getComponent(h.cc.UITransform), original = tr.hitTest;
  pipeline.bindInput(); assert.equal(tr.hitTest({ inMask: true }, 0), false);
  pipeline.setActive(true); assert.equal(tr.hitTest({ inMask: true }, 3), true);
  assert.equal(tr.lastHit.layer, h.SKIN_PRESENT_LAYER); assert.equal(tr.lastHit.windowId, 3); assert.equal(card.layer, h.SKIN_LINEAR_LAYER);
  assert.equal(tr.hitTest({ inMask: false }, 3), false);
  tr.throwHit = true; assert.throws(() => tr.hitTest({ inMask: true }, 3), /hit failed/); assert.equal(card.layer, h.SKIN_LINEAR_LAYER);
  pipeline.destroy(); assert.equal(tr.hitTest, original);
});

test('WeChat capture uses the actual render surface and preserves screen projection when Canvas retargets the camera', () => {
  const h = harness(), surface = { width: 645, height: 1398 };
  h.cc.screen.windowSize = { width: 882, height: 1398 };
  h.camera.camera = { window: surface }; h.camera.orthoHeight = 780; h.camera.resetOrthoOnTarget = 1066;
  h.canvas.addComponent(h.cc.Canvas).cameraComponent = h.camera; h.cc.view.scaleY = 1398 / 1560;
  const rect = h.camera.rect = { x: 0, y: 0, width: 1, height: 1 };
  const pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  pipeline.resize(720, 1560); pipeline.setActive(true);
  for (const texture of pipeline.textures) assert.deepEqual([texture.width, texture.height], [645, 1398]);
  assert.equal(h.camera.orthoHeight, 780);
  for (const camera of pipeline.cameras) { assert.equal(camera.orthoHeight, 780); assert.equal(camera.rect, rect); }
  surface.height = 1500; h.cc.screen.windowSize.height = 1500; h.cc.view.scaleY = 1500 / 1680;
  pipeline.resize(720, 1680); h.cc.director.emit('draw');
  for (const texture of pipeline.textures) assert.deepEqual([texture.width, texture.height], [645, 1500]);
  assert.equal(h.camera.orthoHeight, 840);
  pipeline.setActive(false); assert.equal(h.camera.orthoHeight, 840); pipeline.destroy();
});

test('portrait RTs above 2048 retain aspect and rebind every attached camera after exact-size recreation', () => {
  const h = harness(), surface = { width: 1290, height: 2796 }; h.camera.camera = { window: surface };
  h.cc.director.root = { device: { capabilities: { maxTextureSize: 4096 } } };
  const pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  pipeline.resize(720, 1560); pipeline.setActive(true);
  for (const texture of pipeline.textures) { assert.deepEqual([texture.width, texture.height], [1290, 2796]); assert.equal(texture.resizeCalls, undefined); }
  h.camera.targetAssignments = []; pipeline.cameras[0].targetAssignments = [];
  surface.width = 1170; surface.height = 2532; pipeline.resize(720, 1558);
  assert.deepEqual(h.camera.targetAssignments, [pipeline.textures[0]]);
  assert.deepEqual(pipeline.cameras[0].targetAssignments, [pipeline.textures[1]]);
  for (const texture of pipeline.textures) assert.deepEqual([texture.width, texture.height], [1170, 2532]);
  surface.width = 4320; surface.height = 7680; pipeline.resize(720, 1280);
  for (const texture of pipeline.textures) assert.deepEqual([texture.width, texture.height], [2304, 4096]);
  pipeline.destroy();
});

test('resizing an open cached popup replaces its sampler resources and recaptures without losing cameras', () => {
  const h = harness(), surface = { width: 936, height: 1244 }; h.camera.camera = { window: surface };
  const pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  pipeline.resize(720, 1244 * 720 / 936); pipeline.setActive(true);
  h.cc.director.emit('draw'); h.cc.director.emit('afterDraw');
  const sprite = pipeline.quads[0].getComponent(h.cc.Sprite), originalTextures = [...pipeline.textures], originalFrames = [...pipeline.frames];
  const previousSample = h.sampleSprite(sprite); assert.equal(previousSample.alive, true);
  surface.width = 390; surface.height = 844; pipeline.resize(720, 844 * 720 / 390);
  assert.equal(pipeline.active, true); assert.equal(pipeline.content.active, true);
  assert.equal(pipeline.cameras[1].node.active, true); assert.equal(pipeline.cameras[1].targetTexture, null);
  assert.equal(h.sampleSprite(sprite).alive, true);
  assert.equal(h.sampleSprite(sprite), pipeline.textures[1].gfxTexture);
  assert.notEqual(h.sampleSprite(sprite), previousSample);
  assert.equal(previousSample.alive, false);
  for (let i = 0; i < 2; i++) {
    assert.notEqual(pipeline.textures[i], originalTextures[i]); assert.notEqual(pipeline.frames[i], originalFrames[i]);
    assert.equal(originalTextures[i].destroyCalls, 1); assert.equal(originalFrames[i].destroyCalls, 1);
    assert.deepEqual(pipeline.textures[i].wrap, [1, 1]);
    assert.deepEqual([pipeline.textures[i].width, pipeline.textures[i].height], [390, 844]);
  }
  assert.equal(pipeline.textures[0].window.cameras.has(h.camera), true);
  assert.equal(pipeline.textures[1].window.cameras.has(pipeline.cameras[0]), true);
  assert.equal(pipeline.ownedMaterials[2].properties.backgroundTexture, pipeline.textures[0]);
  assert.equal(h.descriptorCache.has(originalTextures[1].hash), false);
  h.cc.director.emit('draw'); assert.equal(pipeline.cameraNodes[0].active, true);
  h.cc.director.emit('afterDraw'); h.cc.director.emit('draw'); assert.equal(pipeline.cameraNodes[0].active, false);
  const stableTextures = [...pipeline.textures]; pipeline.resize(720, 844 * 720 / 390);
  stableTextures.forEach((texture, i) => assert.equal(pipeline.textures[i], texture));
  pipeline.setActive(false); assert.equal(h.camera.targetTexture, null);
  pipeline.destroy(); assert.ok(h.resources.every(resource => resource.destroyCalls === 1));
});

test('a failed resize allocation preserves the active capture and releases only its incomplete replacements', () => {
  const h = harness(), pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  pipeline.resize(720, 1280); pipeline.setActive(true);
  const originalTextures = [...pipeline.textures], originalFrames = [...pipeline.frames], resourceCount = h.resources.length;
  const sprite = pipeline.quads[0].getComponent(h.cc.Sprite), sample = h.sampleSprite(sprite);
  h.cc.screen.windowSize = { width: 390, height: 844 }; h.failNextTextureInitialization(2);
  assert.throws(() => pipeline.resize(720, 844 * 720 / 390), /texture failed/);
  originalTextures.forEach((texture, i) => assert.equal(pipeline.textures[i], texture));
  originalFrames.forEach((frame, i) => assert.equal(pipeline.frames[i], frame));
  assert.equal(h.camera.targetTexture, originalTextures[0]); assert.equal(pipeline.cameras[0].targetTexture, originalTextures[1]);
  assert.equal(h.sampleSprite(sprite), sample); assert.equal(sample.alive, true);
  assert.ok(originalTextures.every(texture => texture.destroyCalls === 0));
  assert.ok(h.resources.slice(resourceCount).every(resource => resource.destroyCalls === 1));
  pipeline.resize(720, 844 * 720 / 390); assert.equal(h.sampleSprite(sprite).alive, true);
  pipeline.destroy(); assert.ok(h.resources.every(resource => resource.destroyCalls === 1));
});

test('late Canvas layout updates do not multiply a viewport projection twice while the skin is open', () => {
  const h = harness(); h.canvas.addComponent(h.cc.Canvas).cameraComponent = h.camera;
  const pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  h.cc.screen.windowSize = { width: 412, height: 915 }; h.cc.view.scaleY = 412 / 720;
  pipeline.resize(720, 1558); pipeline.setActive(true); pipeline.resize(720, 915 * 720 / 412);
  assert.equal(h.camera.orthoHeight, 915 * 720 / 412 / 2);
  h.cc.screen.windowSize = { width: 715, height: 1272 }; h.cc.view.scaleY = 715 / 720;
  pipeline.resize(720, 915 * 720 / 412); h.cc.director.emit('draw');
  const expected = 1272 * 720 / 715 / 2;
  assert.ok(Math.abs(h.camera.orthoHeight - expected) < 1e-9);
  pipeline.resize(720, expected * 2); h.cc.director.emit('draw');
  assert.ok(Math.abs(h.camera.orthoHeight - expected) < 1e-9);
  pipeline.destroy();
});

test('a completed unchanged UI frame is cached while the background and final camera remain live', () => {
  const h = harness(), pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  pipeline.resize(720, 1280); pipeline.setActive(true);
  // open() may call sync before Director's draw event. It must not consume the
  // invalidation until an actual frame has completed.
  h.cc.director.emit('draw'); assert.equal(pipeline.cameraNodes[0].active, true);
  h.cc.director.emit('afterDraw'); assert.equal(pipeline.cameraNodes[0].active, false);
  for (let i = 0; i < 3; i++) {
    h.cc.director.emit('draw'); assert.equal(pipeline.cameraNodes[0].active, false);
    assert.equal(pipeline.cameraNodes[1].active, true);
    assert.equal(h.camera.targetTexture, pipeline.textures[0]);
    assert.equal(pipeline.content.active, true); // input and ScrollView stay live
    h.cc.director.emit('afterDraw');
  }
  pipeline.invalidate(); h.cc.director.emit('draw'); assert.equal(pipeline.cameraNodes[0].active, true);
  // A later invalidation in the same frame must survive its AFTER_DRAW event.
  pipeline.invalidate(); h.cc.director.emit('afterDraw'); h.cc.director.emit('draw');
  assert.equal(pipeline.cameraNodes[0].active, true);
  h.cc.director.emit('afterDraw'); h.cc.director.emit('draw');
  assert.equal(pipeline.cameraNodes[0].active, false);
  pipeline.setActive(false); pipeline.setActive(true); h.cc.director.emit('draw');
  assert.equal(pipeline.cameraNodes[0].active, true); pipeline.destroy();
});

test('late visual invalidation and changed viewport geometry redraw the UI cache exactly once', () => {
  const h = harness(), pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  let changed = false;
  pipeline.setInvalidationSource(() => { const result = changed; changed = false; return result; });
  pipeline.resize(720, 1280); pipeline.setActive(true); h.cc.director.emit('draw'); h.cc.director.emit('afterDraw');
  changed = true; h.cc.director.emit('draw'); assert.equal(pipeline.cameraNodes[0].active, true);
  h.cc.director.emit('afterDraw'); h.cc.director.emit('draw'); assert.equal(pipeline.cameraNodes[0].active, false);
  h.camera.node.position.x = 10; h.cc.director.emit('draw'); assert.equal(pipeline.cameraNodes[0].active, true);
  h.cc.director.emit('afterDraw'); h.cc.director.emit('draw'); assert.equal(pipeline.cameraNodes[0].active, false);
  pipeline.resize(720, 1560); h.cc.director.emit('draw'); assert.equal(pipeline.cameraNodes[0].active, true);
  h.cc.director.emit('afterDraw'); h.cc.director.emit('draw'); assert.equal(pipeline.cameraNodes[0].active, false);
  pipeline.destroy();
});

test('stable foreground nodes avoid layer churn and late children restore their inherited original layer', () => {
  const h = harness(), alert = h.makeNode('Alert', h.hud), text = h.makeNode('Text', alert), original = alert.layer;
  const pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  pipeline.resize(720, 1280); pipeline.setActive(true); h.cc.director.emit('draw');
  let layer = text.layer, writes = 0;
  Object.defineProperty(text, 'layer', { get: () => layer, set: value => { writes++; layer = value; } });
  for (let i = 0; i < 3; i++) { h.cc.director.emit('afterDraw'); h.cc.director.emit('draw'); }
  assert.equal(writes, 0);
  const glyph = h.makeNode('LateGlyph', text); h.cc.director.emit('draw');
  assert.equal(glyph.layer, h.SKIN_FOREGROUND_LAYER);
  pipeline.setActive(false); assert.equal(text.layer, original); assert.equal(glyph.layer, original);
  pipeline.destroy();
});

test('reparented foreground glyphs and inherited descendants restore outside their former root', () => {
  const h = harness(), pool = h.makeNode('Pool', h.hud);
  h.hud.children.splice(h.hud.children.indexOf(pool), 1); h.hud.children.unshift(pool);
  const alert = h.makeNode('Alert', h.hud), glyph = h.makeNode('Glyph', alert), original = glyph.layer;
  const pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  const move = (node, parent) => { node.parent.children.splice(node.parent.children.indexOf(node), 1); parent.addChild(node); };
  pipeline.resize(720, 1280); pipeline.setActive(true); h.cc.director.emit('draw');
  const inherited = h.makeNode('LateInheritedGlyph', glyph); move(glyph, pool);
  h.cc.director.emit('draw');
  assert.equal(glyph.layer, original); assert.equal(inherited.layer, original);
  assert.equal(pipeline.foreground.has(glyph), false);
  move(glyph, alert); h.cc.director.emit('draw'); assert.equal(glyph.layer, h.SKIN_FOREGROUND_LAYER);
  move(glyph, pool); pipeline.setActive(false);
  assert.equal(glyph.layer, original); assert.equal(inherited.layer, original);
  pipeline.destroy();
});

test('premultiplied linear UI composition equals source-order blending over different moving backgrounds', () => {
  const decode = c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  const encode = c => c <= .0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - .055;
  // Covers translucent screen dimmers, an opaque card, its black locked layer,
  // and antialiased sprite/Graphics edges. RGB is straight before blending.
  const sequences = [[], [[[0, 0, 0], .6]], [[[.98, .84, .56], 1], [[0, 0, 0], 194 / 255]],
    [[[.8, .7, .5], .2], [[.2, .3, .4], .7], [[1, .5, .3], .12]]];
  for (const layers of sequences) {
    let ui = [0, 0, 0], alpha = 0;
    for (const [rgb, a] of layers) { ui = ui.map((value, i) => decode(rgb[i]) * a + value * (1 - a)); alpha = a + alpha * (1 - a); }
    for (const background of [[0, 0, 0], [1, 1, 1], [0, 1, 0], [.8, .7, .4]]) {
      let direct = background.map(decode);
      for (const [rgb, a] of layers) direct = direct.map((value, i) => decode(rgb[i]) * a + value * (1 - a));
      const cached = ui.map((value, i) => encode(value + decode(background[i]) * (1 - alpha)));
      direct.forEach((value, i) => assert.ok(Math.abs(encode(value) - cached[i]) < 1e-12));
    }
  }
  const shader = fs.readFileSync(path.join(__dirname, '../assets/resources/art/rendering/original-skin-composite.effect'), 'utf8');
  assert.match(shader, /blend: false/); assert.match(shader, /CC_HANDLE_RT_SAMPLE_FLIP\(uv0\)/);
  assert.match(shader, /ui\.rgb \+ decodeSrgb\(background\) \* \(1\.0 - ui\.a\)/);
  assert.doesNotMatch(shader, /ALPHA_TEST/); // transparent cached pixels retain the live background
});

test('six prepared hidden popups allocate no targets and share exactly one full-resolution pair when opened', () => {
  const h = harness(), visibility = h.camera.visibility;
  const pipelines = Array.from({ length: 6 }, (_, index) => new h.SkinHudColorPipeline(h.makeNode(`Feature${index}`, h.hud), { camera: h.camera, effects: [{}, {}, {}] }));
  pipelines.forEach(pipeline => pipeline.resize(720, 1280));
  assert.equal(h.skinHudPresentationSnapshot(h.camera).textures, 0);
  assert.equal(h.skinHudPresentationSnapshot(h.camera).views, 6);
  assert.equal(h.resources.filter(resource => resource instanceof h.cc.RenderTexture).length, 0);
  assert.equal(h.camera.targetTexture, null); assert.equal(h.camera.visibility, visibility);
  let targets;
  for (const pipeline of pipelines) {
    pipeline.setActive(true); h.cc.director.emit('draw'); h.cc.director.emit('afterDraw');
    targets ??= [...pipeline.textures];
    targets.forEach((texture, index) => assert.equal(pipeline.textures[index], texture));
    const snapshot = h.skinHudPresentationSnapshot(h.camera);
    assert.deepEqual([snapshot.textures, snapshot.leases, snapshot.width, snapshot.height], [2, 1, 720, 1280]);
    assert.equal(snapshot.owner, pipeline.content.parent.name);
    pipeline.setActive(false);
    assert.equal(h.skinHudPresentationSnapshot(h.camera).leases, 0);
    assert.ok(targets.every(texture => texture.destroyCalls === 0));
  }
  assert.equal(h.resources.filter(resource => resource instanceof h.cc.RenderTexture).length, 2);
  pipelines.forEach(pipeline => pipeline.destroy());
  assert.equal(h.skinHudPresentationSnapshot(h.camera).textures, 0);
  assert.ok(h.resources.every(resource => resource.destroyCalls === 1)); assert.equal(h.events.size, 0);
});

test('handoff captures the restored camera and an old view destroy cannot release the new lease', () => {
  const h = harness(), borrowed = { name: 'original-target' }, visibility = h.camera.visibility;
  h.camera.targetTexture = borrowed; h.camera.orthoHeight = 780;
  const a = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  a.resize(720, 1560); a.setActive(true);
  const generation = a.leaseGeneration, targets = [...a.textures];
  // Creating B while A is open must not save A's temporary capture as B's baseline.
  const b = new h.SkinHudColorPipeline(h.makeNode('Pet', h.hud), { camera: h.camera, effects: [{}, {}, {}] });
  b.resize(720, 1560); b.setActive(true);
  assert.equal(a.active, false); assert.equal(a.content.active, false); assert.ok(a.cameraNodes.every(node => !node.active));
  assert.ok(b.leaseGeneration > generation); assert.equal(b.cameras[1].targetTexture, borrowed);
  assert.equal(a.cameras[0].targetTexture, null); assert.equal(a.cameras[1].targetTexture, null);
  a.destroy(); assert.equal(h.camera.targetTexture, targets[0]); assert.equal(b.cameras[0].targetTexture, targets[1]);
  assert.ok(targets.every(texture => texture.destroyCalls === 0));
  h.cc.director.emit('draw'); assert.equal(b.cameraNodes[0].active, true);
  b.setActive(false); assert.equal(h.camera.targetTexture, borrowed); assert.equal(h.camera.visibility, visibility); assert.equal(h.camera.orthoHeight, 780);
  b.destroy(); assert.ok(h.resources.every(resource => resource.destroyCalls === 1));
});

test('inactive resize cannot replace another owner targets and a viewport change replaces the pool only once', () => {
  const h = harness(), a = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  const b = new h.SkinHudColorPipeline(h.makeNode('Fish', h.hud), { camera: h.camera, effects: [{}, {}, {}] });
  a.resize(720, 1280); a.setActive(true);
  const old = [...a.textures], resources = h.resources.length;
  h.cc.screen.windowSize = { width: 390, height: 844 };
  b.resize(720, 1558);
  assert.equal(h.resources.length, resources); assert.equal(h.camera.targetTexture, old[0]);
  a.resize(720, 1558); const replacement = [...a.textures], afterResize = h.resources.length;
  b.resize(720, 1558); a.resize(720, 1558);
  assert.equal(h.resources.length, afterResize);
  assert.ok(old.every(texture => texture.destroyCalls === 1));
  for (const pipeline of [a, b]) {
    replacement.forEach((texture, index) => assert.equal(pipeline.textures[index], texture));
    assert.equal(pipeline.quads[0].getComponent(h.cc.Sprite).spriteFrame, a.frames[1]);
    assert.equal(pipeline.compositeMaterial.properties.backgroundTexture, replacement[0]);
  }
  b.setActive(true); assert.equal(h.resources.length, afterResize);
  a.destroy(); b.destroy(); assert.ok(h.resources.every(resource => resource.destroyCalls === 1));
});

test('failed first activation releases partial targets, restores the camera and permits retry', () => {
  const h = harness(), pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  pipeline.resize(720, 1280); const visibility = h.camera.visibility, before = h.resources.length;
  h.failNextTextureInitialization(2);
  assert.throws(() => pipeline.setActive(true), /texture failed/);
  assert.equal(pipeline.active, false); assert.equal(pipeline.content.active, false);
  assert.equal(h.camera.targetTexture, null); assert.equal(h.camera.visibility, visibility);
  assert.equal(h.skinHudPresentationSnapshot(h.camera).leases, 0); assert.equal(h.skinHudPresentationSnapshot(h.camera).textures, 0);
  assert.ok(h.resources.slice(before).every(resource => resource.destroyCalls === 1));
  pipeline.setActive(true); assert.equal(h.skinHudPresentationSnapshot(h.camera).textures, 2);
  pipeline.destroy(); assert.ok(h.resources.every(resource => resource.destroyCalls === 1));
});

test('an AFTER_DRAW from the previous owner cannot mark a newly acquired UI cache clean', () => {
  const h = harness(), a = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  const b = new h.SkinHudColorPipeline(h.makeNode('Pet', h.hud), { camera: h.camera, effects: [{}, {}, {}] });
  a.setActive(true); h.cc.director.emit('draw');
  b.setActive(true); h.cc.director.emit('afterDraw');
  assert.equal(b.dirty, true, 'the replacement has not participated in BEFORE_DRAW');
  h.cc.director.emit('draw'); assert.equal(b.cameraNodes[0].active, true);
  h.cc.director.emit('afterDraw'); assert.equal(b.dirty, false);
  b.setActive(false); b.setActive(true); h.cc.director.emit('afterDraw'); assert.equal(b.dirty, true, 'same owner also has a fresh generation');
  a.destroy(); b.destroy();
});

test('explicit scene disposal restores the owner camera, leaves another camera pool alive and is idempotent', () => {
  const h = harness(), a = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  const b = new h.SkinHudColorPipeline(h.makeNode('Pet', h.hud), { camera: h.camera, effects: [{}, {}, {}] });
  const other = h.makeNode('OtherCamera', h.canvas).addComponent(h.cc.Camera);
  const c = new h.SkinHudColorPipeline(h.makeNode('OtherHud', h.hud), { camera: other, effects: [{}, {}, {}] });
  a.setActive(true); c.setActive(true); const otherTargets = [...c.textures];
  h.disposeSkinHudPresentation(h.camera); h.disposeSkinHudPresentation(h.camera);
  assert.equal(h.camera.targetTexture, null); assert.equal(a.destroyed, true); assert.equal(b.destroyed, true);
  assert.equal(h.skinHudPresentationSnapshot(h.camera).textures, 0);
  assert.equal(other.targetTexture, otherTargets[0]); assert.ok(otherTargets.every(texture => texture.destroyCalls === 0));
  a.destroy(); b.destroy(); c.destroy(); assert.ok(h.resources.every(resource => resource.destroyCalls === 1));
  assert.equal(h.events.size, 0);
});

test('input preparation binds one runtime node per step and cancellation leaves no stale hit-test wrappers', () => {
  const h = harness(), pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}] });
  const card = h.makeNode('Card', pipeline.content), glyph = h.makeNode('Glyph', card), tr = card.getComponent(h.cc.UITransform), original = tr.hitTest;
  const steps = pipeline.bindInputSteps();
  assert.equal(pipeline.inputTests.size, 0); assert.equal(steps.next().done, false); assert.equal(pipeline.inputTests.size, 1);
  assert.equal(steps.next().done, false); assert.equal(pipeline.inputTests.size, 2); assert.notEqual(tr.hitTest, original);
  assert.equal(pipeline.inputTests.has(glyph.getComponent(h.cc.UITransform)), false);
  pipeline.destroy(); assert.equal(tr.hitTest, original); assert.equal(steps.next().done, true);
});

test('presentation diagnostics observe CPU stages without controlling rendering or reporting a synthetic draw', () => {
  const h = harness(), phases = [], pipeline = new h.SkinHudColorPipeline(h.owner, { camera: h.camera, effects: [{}, {}, {}],
    trace: (phase, workMs) => { assert.ok(Number.isFinite(workMs) && workMs >= 0); phases.push(phase); if (phase === 'presentationAcquire') throw Error('observer failed'); } });
  pipeline.resize(720, 1280); assert.equal(phases.length, 0);
  pipeline.setActive(true); assert.deepEqual(phases, ['presentationResize', 'presentationAcquire']);
  h.cc.director.emit('draw'); assert.equal(phases.at(-1), 'presentationBeforeDraw');
  h.cc.director.emit('afterDraw'); const count = phases.length;
  h.cc.director.emit('draw'); assert.equal(phases.length, count);
  pipeline.setActive(false); assert.equal(phases.at(-1), 'presentationRelease'); pipeline.destroy();
});
