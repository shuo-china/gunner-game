const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const core = require('./.build/core/index.js');
const definition = require('../assets/resources/art/maps/forest/map.json');
const raid = require('../assets/resources/art/raid-system/visuals.json');

test('Raid switches the exact ground texture, plane, unlit material and clipping, then restores Main and challenge', () => {
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
  map.definition = definition; map.skinIndex = 0; map.origin = { x: 0, z: 0 }; map.arena = map.raid = false;
  map.fillItems = []; map.shadowLayer = node(); map.material = { setProperty(name, value) { this[name] = value; } };
  map.art = { catalog: { raid }, frames: new Map([definition.sprites.ground, raid.ground].map(spec => [spec.path, frame(spec)])) };
  map.spriteItems = ['ground', definition.borders[0].asset].map((asset, index) => {
    const item = { node: node(), asset, basis: index ? definition.borders[0] : definition.ground };
    item.visible = { node: item.node }; return item;
  });
  map.visibleItems = map.spriteItems.map(item => item.visible);
  const ground = map.spriteItems[0].node;
  map.setBattlefield(core.createRaidDefinition(new core.RaidBossCombat(3)));
  assert.equal(ground.sprite.spriteFrame, map.art.frames.get(raid.ground.path));
  assert.deepEqual(ground.transform.size, raid.ground.sizeUnits);
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

test('smoke collides with the Raid sphere surface and can pass through the old box corners', () => {
  const { advanceParticleExtra } = require('./.build/feedback/view/OriginalParticleExtraMotion.js');
  const visuals = require('../assets/resources/art/weapon-system/visuals.json');
  const source = Object.values(visuals.projectileSkins).flat().find(spec => spec.collision);
  const make = (x, z) => ({ spec: { ...source, noise: undefined }, active: true,
    x, y: 2, z, vx: 10, vy: 0, vz: 0, size: .1, age: 0, life: 10, random: .5 });
  const sphere = { minX: -1, maxX: 1, minY: 1, maxY: 3, minZ: -1, maxZ: 1,
    sphere: { x: 0, y: 2, z: 0, radius: 1 } };
  const corner = make(-.8, .95);
  advanceParticleExtra(corner, .12, { x: -2, y: 2, z: .95 }, [sphere]);
  assert.equal(corner.x, -.8); assert.equal(corner.age, 0); assert.equal(corner.vx, 10);
  const center = make(2, 0);
  advanceParticleExtra(center, .4, { x: -2, y: 2, z: 0 }, [sphere]);
  assert.ok(center.x < -1); assert.ok(center.vx < 0); assert.ok(center.age > 0);
});
