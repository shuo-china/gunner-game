'use strict';
const fs = require('node:fs');
const path = require('node:path');

function decodeUuid(uuid) {
  const [value, ...suffix] = uuid.split('@');
  if (value.length !== 22) return uuid;
  const hex = value.slice(0, 2) + Buffer.from(value.slice(2), 'base64').toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
    + (suffix.length ? '@' + suffix.join('@') : '');
}

// Follow the compiled bundle's dependencies, including packed Texture2D and
// shared import records. A SpriteFrame path need not have its own ImageAsset path.
function collectNativeFiles(input, config, roots) {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const imports = new Map(), natives = new Map(), packs = new Map();
  for (const file of walk(path.join(input, 'remote/resources'))) {
    const relative = path.relative(input, file).split(path.sep).join('/');
    const id = path.basename(file).split('.')[0];
    if (relative.includes('/import/')) imports.set(id, file);
    // Creator emits images as <uuid>.<hash>.png, but fonts as
    // <uuid>.<hash>/<font-name>.ttf. Both belong to the UUID segment.
    if (relative.includes('/native/')) natives.set(relative.split('/')[4].split('.')[0], relative);
  }
  for (const [id, indices] of Object.entries(config.packs || {})) {
    indices.forEach((index, offset) => packs.set(index, { id, offset }));
  }
  const indices = new Map(config.uuids.map((uuid, i) => [uuid, i]));
  const assets = new Map(Object.entries(config.paths).map(([i, p]) => [config.types[p[1]] + ':' + p[0], Number(i)]));
  const visited = new Set(), files = new Set(), parsed = new Map();
  function scan(value) {
    if (typeof value === 'string' && indices.has(value)) visit(indices.get(value));
    else if (value && typeof value === 'object') Object.values(value).forEach(scan);
  }
  function visit(index) {
    if (visited.has(index)) return;
    visited.add(index);
    const uuid = decodeUuid(config.uuids[index]), pack = packs.get(index);
    const imported = imports.get(pack ? pack.id : uuid);
    if (imported) {
      if (!parsed.has(imported)) parsed.set(imported, JSON.parse(fs.readFileSync(imported, 'utf8')));
      const data = parsed.get(imported);
      if (!pack) scan(data);
      else if (data.type === 'cc.Texture2D') scan(data.data[pack.offset]);
      else if (Array.isArray(data) && data[0] === 1) { scan(data.slice(0, 5)); scan(data[5][pack.offset]); }
      else throw new Error('Unsupported bundle pack: ' + imported);
    }
    if (natives.has(uuid)) files.add(natives.get(uuid));
  }
  for (const root of roots) {
    if (!assets.has(root)) throw new Error('Missing map asset: ' + root);
    visit(assets.get(root));
  }
  return Array.from(files).sort();
}

module.exports = { collectNativeFiles, decodeUuid };
