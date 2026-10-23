const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { packageMapResources } = require('../tools/wechat-map-package.cjs');

test('map packaging separates stage maps and trees while shared textures are copied only once', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gunner-map-package-'));
  try {
    const input = path.join(temporary, 'input'), code = path.join(temporary, 'code');
    fs.mkdirSync(code); fs.writeFileSync(path.join(code, 'game.js'), "require('./startup-metadata').installStartupMetadata(cc);");
    const paths = ['art/stages/maps/0/ground/spriteFrame', 'art/stages/maps/1/ground/spriteFrame',
      'art/stages/trees/0/spriteFrame', 'art/stages/trees/4/spriteFrame',
      'art/maps/forest/common/spriteFrame', 'art/stages/maps/0/shared/spriteFrame', 'art/stages/maps/1/shared/spriteFrame'];
    const uuids = Array.from({ length: 8 }, () => crypto.randomUUID());
    const config = { paths: Object.fromEntries(paths.map((name, index) => [index, [name, 0]])), types: ['cc.SpriteFrame'], uuids };
    function write(relative, data) {
      const file = path.join(input, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
    }
    const native = index => `remote/resources/native/${uuids[index].slice(0,2)}/${uuids[index]}.abcd.png`;
    for (const index of [0, 1, 2, 3, 4, 7]) write(native(index), Buffer.alloc(100 + index));
    for (const index of [5, 6]) write(`remote/resources/import/${uuids[index].slice(0,2)}/${uuids[index]}.abcd.json`, JSON.stringify([uuids[7]]));
    const evidenceFile = path.join(temporary, 'index.json');
    const result = packageMapResources(input, code, config, 'https://example.test/', evidenceFile);
    const evidence = JSON.parse(fs.readFileSync(evidenceFile));
    const owner = index => evidence.files.find(file => file.remote === native(index)).package;
    assert.equal(owner(0), 'forest-map-0'); assert.equal(owner(2), 'forest-map-0');
    assert.equal(owner(1), 'forest-map-1'); assert.equal(owner(3), 'forest-map-1');
    assert.equal(owner(4), 'forest-map-common'); assert.equal(owner(7), 'forest-map-common');
    assert.equal(result.files, 6); assert.equal(result.packages.length, 3);
    assert.ok(result.packages.every(group => group.bytes < 3 * 1024 * 1024));
    for (const file of evidence.files) assert.deepEqual(fs.readFileSync(path.join(code, file.local)), fs.readFileSync(path.join(input, file.remote)));
  } finally {
    // mkdtemp owns this exact directory; never remove an arbitrary project path.
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('gunner-map-package-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
