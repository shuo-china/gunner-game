const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const core = require('./.build/core/index.js');
const definition = require('../assets/resources/art/maps/forest/map.json');
const boss = require('../assets/resources/art/boss-system/visuals.json');

test('Boss switches the exact ground texture, plane, unlit material and clipping, then restores Main and challenge', () => {
  class Sprite {}
  class UITransform {}
  class Vec4 { constructor(...values) { this.values = values; } }
  const Texture2D = { WrapMode: { REPEAT: 1 } };
  const context = { exports: {}, require: id => id === 'cc' ? { Sprite, UITransform, Vec4, Texture2D } :
    id === '../core' ? core : {} };
  const source = fs.readFileSync(path.join(__dirname, '../assets/scripts/view/OriginalMapView.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText, context);
  const map = Object.create(context.exports.OriginalMapView.prototype);
  const node = () => ({ active: true, position: { x: 0, y: 0 }, sprite: {}, transform: {
    setContentSize(...size) { this.size = size; }, setAnchorPoint(...anchor) { this.anchor = anchor; },
  }, getComponent(Type) { return Type === Sprite ? this.sprite : this.transform; },
  setPosition(x, y) { this.position = { x, y }; }, setScale(x, y) { this.scale = { x, y }; } });
  const frame = spec => ({ rect: { x: 0, y: 0, width: spec.sizePx[0], height: spec.sizePx[1] }, rotated: false,
    texture: { width: spec.sizePx[0], height: spec.sizePx[1], setWrapMode() {} } });
  map.definition = definition; map.skinIndex = 0; map.origin = { x: 0, z: 0 }; map.arena = map.raid = map.boss = false;
  map.fillItems = []; map.shadowLayer = node(); map.material = { setProperty(name, value) { this[name] = value; } };
  map.art = { catalog: { boss }, frames: new Map([definition.sprites.ground, boss.ground].map(spec => [spec.path, frame(spec)])) };
  map.spriteItems = ['ground', definition.borders[0].asset].map((asset, index) => {
    const item = { node: node(), asset, basis: index ? definition.borders[0] : definition.ground };
    item.visible = { node: item.node }; return item;
  });
  map.visibleItems = map.spriteItems.map(item => item.visible);
  const ground = map.spriteItems[0].node;
  map.setBattlefield({skinIndex:0,mapLayout:'boss',mapOrigin:{x:-100,z:0}});
  assert.equal(ground.sprite.spriteFrame, map.art.frames.get(boss.ground.path));
  assert.deepEqual(ground.transform.size, boss.ground.sizeUnits);
  assert.deepEqual(ground.position, core.projectWorld({ x: -100, z: 0 }));
  assert.ok(Math.abs(ground.scale.x - 15) < 1e-5); assert.ok(Math.abs(ground.scale.y - 8.66017) < 1e-4);
  assert.deepEqual(map.material.irradiance.values, [1, 1, 1, 1]);
  assert.deepEqual(map.material.uvTransform.values, [7, 3.740000009536743, 0, 0]);
  assert.deepEqual(map.material.groundClip.values, [.5, .5, .25, 1]);
  assert.equal(map.spriteItems[1].node.active, false); assert.deepEqual(map.shadowLayer.position, { x: 0, y: 0 });
  map.setBattlefieldActive(false); map.updateCamera(core.projectWorld({ x: -100, z: 0 }), 100, 100);
  assert.equal(ground.active, false);
  map.setBattlefield(core.createStageDefinition(0, 0, 1));
  assert.equal(ground.sprite.spriteFrame, map.art.frames.get(definition.sprites.ground.path));
  assert.deepEqual(map.material.irradiance.values, [...definition.ground.lighting.irradiance, 1]);
  assert.deepEqual(map.material.groundClip.values, [.5, .5, .25, 0]);
  assert.equal(map.spriteItems[1].node.active, true);
  map.setBattlefield(core.createSpeedRunDefinition(0, 1));
  assert.equal(ground.sprite.spriteFrame, map.art.frames.get(definition.sprites.ground.path));
  assert.deepEqual(map.material.groundClip.values, [.5, .5, .25, 1]);
});
