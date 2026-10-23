const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A feature may share its canonical PNG with another feature. Validate what
// Creator will import at the configured path instead of its historical folder.
function assertResourceImageMetadata(resourcesRoot, image) {
  assert.match(image.path, /^art\//);
  const file = path.resolve(resourcesRoot, image.path + '.png');
  const relative = path.relative(resourcesRoot, file);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), image.path + ': resource path stays inside resources');
  const bytes = fs.readFileSync(file), meta = JSON.parse(fs.readFileSync(file + '.meta'));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', image.path + ': PNG signature');
  assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], image.sizePx, image.path + ': native dimensions');
  assert.equal(meta.importer, 'image');
  const texture = meta.subMetas['6c48a'], frame = meta.subMetas.f9941;
  assert.equal(texture.importer, 'texture'); assert.equal(frame.importer, 'sprite-frame');
  assert.equal(texture.uuid, meta.uuid + '@6c48a'); assert.equal(frame.uuid, meta.uuid + '@f9941');
  assert.equal(texture.userData.imageUuidOrDatabaseUri, meta.uuid);
  assert.equal(frame.userData.imageUuidOrDatabaseUri, texture.uuid);
  assert.deepEqual([texture.userData.minfilter, texture.userData.magfilter, texture.userData.mipfilter], ['linear', 'linear', 'none']);
  assert.deepEqual([texture.userData.wrapModeS, texture.userData.wrapModeT], ['clamp-to-edge', 'clamp-to-edge']);
  const data = frame.userData;
  assert.equal(data.trimType, 'none'); assert.equal(data.rotated, false); assert.equal(data.packable, false);
  assert.deepEqual([data.width, data.height], image.sizePx);
  assert.deepEqual([data.rawWidth, data.rawHeight], image.sizePx);
  assert.deepEqual([data.trimX, data.trimY, data.offsetX, data.offsetY], [0, 0, 0, 0]);
  assert.deepEqual([data.borderLeft, data.borderBottom, data.borderRight, data.borderTop], image.border);
  assert.deepEqual([data.pivotX, data.pivotY], image.anchor);
  assert.equal(data.pixelsToUnit, image.ppu ?? 100);
  return meta;
}

module.exports = { assertResourceImageMetadata };
