const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');
const config = require('../assets/resources/art/skin-system/visuals.json');

function harness(art) {
  const created = [];
  class Material {
    constructor() { created.push(this); this.destroyCount = 0; }
    initialize({ effectAsset, defines }) { this.effectAsset = effectAsset; this.defines = defines; }
    setProperty(key, value) { this[key] = value; }
    destroy() { this.destroyCount++; }
  }
  class Vec4 { constructor(...values) { this.values = values; } }
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view/SkinVisualAssets.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports, require: name => { assert.equal(name, 'cc'); return { Material, Vec4 }; } });
  return { assets: new module.exports.SkinVisualAssets(config, art), created };
}

test('every costume shares the canonical torso coverage and border, with separate cached world and UI passes', () => {
  const texture = {}, frame = { texture };
  const bodyPath = config.bodyContour.path;
  const art = { frames: new Map([[bodyPath, frame]]) };
  const { assets, created } = harness(art), world = { effectAsset: {} }, ui = { effectAsset: world.effectAsset };
  assert.equal(assets.bodyMaterial(), undefined);
  const body = assets.bodyMaterial(world);
  for (let id = 0; id < 25; id++) assert.equal(assets.bodyMaterial(world), body);
  assert.equal(body.skinBodyTemplate, texture);
  assert.equal(body.defines.SKIN_BODY_TEMPLATE, true);
  assert.equal(body.defines.SKIN_FUR_PALETTE, undefined);
  assert.notEqual(assets.bodyMaterial(ui), body);
  assert.equal(created.length, 2, 'skin switching does not allocate per-costume contour materials');
  assets.dispose(); assets.dispose();
  assert.ok(created.every(material => material.destroyCount === 1));
  art.frames.clear();
  assert.throws(() => assets.bodyMaterial(world), /Canonical skin body must be loaded/);
});

test('25 distinct authored fur palettes keep holding hands in sync and retain the original starter fox', () => {
  assert.equal(new Set(config.skins.map(skin => skin.furColor.join(','))).size, 25);
  assert.deepEqual(config.skins[0].furColor, [248, 151, 57, 255]);
  for (const skin of config.skins) {
    assert.equal(skin.furColor.length, 4);
    assert.ok(skin.furColor.every(value => Number.isInteger(value) && value >= 0 && value <= 255));
    assert.equal(skin.furColor[3], 255);
    assert.deepEqual(skin.handColor, skin.furColor);
  }
});

test('lower costume artwork fits reuse materials without changing other skins or the original contour', () => {
  const texture = {}, art = { frames: new Map([[config.bodyContour.path, { texture }]]) };
  const { assets, created } = harness(art), world = { effectAsset: {} }, ui = { effectAsset: world.effectAsset };
  const affected = [6, 7, 8, 10, 12, 13, 14, 17, 19, 24];
  const native = assets.bodyMaterial(world, 0), fitted = assets.bodyMaterial(world, affected[0]);
  assert.notEqual(native, fitted);
  const profiles = new Map();
  for (let round = 0; round < 3; round++) for (const skin of config.skins) {
    const material = assets.bodyMaterial(world, skin.id);
    if (!affected.includes(skin.id)) assert.equal(material, native, `skin ${skin.id + 1}`);
    else {
      const key = JSON.stringify([skin.bodyArtworkFit, skin.bodyArtworkHem]);
      if (!profiles.has(key)) profiles.set(key, material);
      assert.equal(material, profiles.get(key), 'identical artwork/fabric profiles must reuse their material');
      assert.notEqual(material, native);
      if (skin.bodyArtworkHem) assert.deepEqual(material.skinBodyHemReference.values, [...skin.bodyArtworkHem, 0]);
      else assert.equal(material.skinBodyHemReference, undefined, 'use the shared plain-fabric reference');
    }
    assert.equal(material.skinBodyTemplate, texture, 'coverage and border must retain original UVs');
  }
  assert.equal(native.defines.SKIN_BODY_ART_FIT, false);
  assert.equal(fitted.defines.SKIN_BODY_ART_FIT, true);
  assert.deepEqual(fitted.skinBodyArtworkFit.values, [.32, .91, .78, 0]);
  const preview = assets.bodyMaterial(ui, affected[0]);
  assert.notEqual(preview, fitted, 'HUD and world materials cannot share pass state');
  assert.deepEqual(preview.skinBodyArtworkFit.values, fitted.skinBodyArtworkFit.values);
  assert.equal(created.length, 5, 'native and three fabric profiles are reused across repeated skin switches');
  assets.dispose(); assets.dispose();
  assert.ok(created.every(material => material.destroyCount === 1));
});

test('skin switching reuses palette materials across cats, isolates UI sources and resets the starter to its base material', () => {
  const { assets, created } = harness(), world = { effectAsset: {} }, ui = { effectAsset: world.effectAsset };
  assert.equal(assets.paletteMaterial(1), undefined);
  assert.equal(assets.paletteMaterial(0, world), world);
  const first = assets.paletteMaterial(1, world);
  assert.equal(assets.paletteMaterial(1, world), first);
  assert.equal(first.effectAsset, world.effectAsset);
  assert.equal(first.defines.SKIN_FUR_PALETTE, true);
  assert.equal(first.defines.SKIN_PORTRAIT, undefined);
  assert.deepEqual(first.skinFurColor.values, [...config.skins[1].furColor.slice(0, 3).map(v => v / 255), 1]);
  assert.notEqual(assets.paletteMaterial(2, world), first);
  const portrait = assets.paletteMaterial(1, ui);
  assert.notEqual(portrait, first);
  assert.equal(portrait.defines.SKIN_PORTRAIT, undefined);
  assert.deepEqual(portrait.skinFurColor.values, first.skinFurColor.values);
  assert.equal(assets.paletteMaterial(1, ui), portrait);
  assert.equal(assets.paletteMaterial(0, ui), ui);
  assert.equal(created.length, 3);
  assets.dispose(); assets.dispose();
  assert.ok(created.every(material => material.destroyCount === 1));
  assert.notEqual(assets.paletteMaterial(1, world), first);
});
