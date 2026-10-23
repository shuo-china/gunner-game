const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../assets/resources/art/rebirth-system/config.json');

test('rebirth inline currency samples the original TMP sprite sheet independently of the UI currency sprite', () => {
  const image = config.images[config.inlineSprites['2']];
  assert.equal(image.source, 'sharedassets0.assets:159');
  assert.equal(image.sourceSpriteAsset, 'sharedassets0.assets:1016');
  assert.equal(image.sourceGlyphIndex, 2);
  assert.deepEqual(image.sourceGlyphRect, [296, 0, 148, 148]);
  assert.deepEqual(image.sizePx, [148, 148]);
  assert.notEqual(image.path, config.images.s379.path);
  assert.equal(config.images.s379.source, 'sharedassets0.assets:379');

  // Independently read from the shipped Texture2D 159, then cropped by its
  // serialized glyph rect. The packed Sprite 379 has a different RGB decode.
  const png = fs.readFileSync(path.join(__dirname, '../assets/resources', image.path + '.png'));
  assert.equal(crypto.createHash('sha256').update(png).digest('hex'),
    'd637769c7eff7907144b543906ba197149a609f2551efc1a19f51352dd90d8da');
  const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/resources', image.path + '.png.meta'), 'utf8'));
  const frame = metadata.subMetas.f9941.userData;
  assert.equal(frame.trimType, 'none');
  assert.equal(frame.rawWidth, 148);
  assert.equal(frame.rawHeight, 148);
});
