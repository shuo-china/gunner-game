const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { projectPath } = require('./support/paths.cjs');
const { pngAlpha } = require('./support/png-alpha.cjs');
const visuals = require('../assets/resources/art/skin-system/visuals.json');
const foxRig = require('../assets/resources/art/characters/cat_basic/rig.json');
const originalJunction = require('./fixtures/original-cat-foot-junction.json');

test('shared torso and feet retain the exact original coverage at their animated junctions', () => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  for (const [id, expected] of Object.entries(originalJunction.parts)) {
    const imagePath = id === 'body' ? visuals.bodyContour.path : visuals.skins[0].parts.find(p => p.id === id).path;
    const bytes = fs.readFileSync(projectPath('assets/resources', imagePath + '.png')), image = pngAlpha(bytes);
    assert.deepEqual([image.width, image.height], [expected.width, expected.height]);
    const alpha = Buffer.from(Array.from({ length: image.width*image.height }, (_, i) => image.at(i%image.width, Math.floor(i/image.width))));
    assert.equal(hash(alpha), expected.alphaSha256, `${id} must meet the original foot-root silhouette`);
    if (id === 'body') {
      assert.equal(hash(bytes), expected.pngSha256, 'reuse the original border and antialiasing without repainting');
      const meta = JSON.parse(fs.readFileSync(projectPath('assets/resources', imagePath + '.png.meta')));
      const frame = Object.values(meta.subMetas).find(item => item.importer === 'sprite-frame').userData;
      assert.equal(frame.trimType, 'none'); assert.equal(frame.packable, false);
      assert.deepEqual([frame.width, frame.height], [149, 99]);
    }
  }
});

test('costumes use a single native body, avoiding exposed second torso and foot-junction caps', () => {
  const expected = ['body', 'ear_left', 'ear_right', 'foot_left', 'foot_right',
    'hand_left', 'hand_right', 'head', 'tail'].sort();
  for (const skin of visuals.skins) {
    assert.deepEqual(skin.parts.map(p => p.id).sort(), expected, `skin ${skin.id}`);
    const body = skin.parts.find(p => p.id === 'body');
    const image = pngAlpha(fs.readFileSync(projectPath('assets/resources', body.path + '.png')));
    assert.deepEqual([image.width, image.height], body.sizePx);
  }
});

test('all outfits use one body canvas and shoulder registration while preserving original fox limbs', () => {
  const bareBody = foxRig.parts.find(p => p.id === 'body');
  for (const skin of visuals.skins) {
    for (const expected of foxRig.parts.filter(p => p.id !== 'body')) {
      const part = skin.parts.find(p => p.id === expected.id);
      for (const key of ['sizePx', 'anchor', 'localPosition', 'localScale'])
        part[key].forEach((n, i) => assert.ok(Math.abs(n - expected[key][i]) < 1e-6, `skin ${skin.id} ${part.id} ${key}`));
      assert.equal(part.bone, expected.bone);
      assert.ok(Math.abs(part.localRotationDeg - expected.localRotationDeg) < 1e-6);
      assert.equal(part.path, visuals.skins[0].parts.find(p => p.id === part.id).path);
    }
    assert.deepEqual(skin.handColor, skin.furColor, 'holding hand matches the selected fur palette');
    const body = skin.parts.find(p => p.id === 'body');
    for (const key of ['sizePx', 'sizeUnits', 'bone', 'anchor', 'localScale', 'localRotationDeg', 'localPosition', 'drawOrder'])
      assert.deepEqual(body[key], bareBody[key], `skin ${skin.id} common body ${key}`);
    const meta = JSON.parse(fs.readFileSync(projectPath('assets/resources', body.path + '.png.meta')));
    const sprite = Object.values(meta.subMetas).find(item => item.importer === 'sprite-frame').userData;
    assert.deepEqual([sprite.width, sprite.height], [149, 99]);
    assert.equal(sprite.trimType, 'none');
    assert.equal(sprite.packable, false, 'canonical contour and costume must share unatlased UV coordinates');
    for (const name of ['foot_left', 'foot_right', 'head'])
      assert.ok(body.drawOrder < skin.parts.find(p => p.id === name).drawOrder);
  }
});
