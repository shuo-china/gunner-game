'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { collectNativeFiles } = require('./lib/bundle-native-files.cjs');

function packageMapResources(input, code, config, base, evidencePath) {
  const roots = Object.values(config.paths).filter(p => config.types[p[1]] === 'cc.SpriteFrame'
    && /^art\/(maps\/forest|stages)\//.test(p[0])).map(p => 'cc.SpriteFrame:' + p[0]);
  if (!roots.length) throw new Error('No map sprite frames found');
  const groups = new Map([['common', []]]);
  for (const root of roots) {
    const map = /art\/stages\/maps\/(\d+)(?:\/|$)/.exec(root), tree = /art\/stages\/trees\/(\d+)(?:\/|$)/.exec(root);
    const group = map ? map[1] : tree ? String(Math.floor(Number(tree[1]) / 4)) : 'common';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(root);
  }
  // Creator can atlas frames from multiple stages into one texture. Such native
  // dependencies belong in common, so any stage pulls them only once.
  const owners = new Map();
  for (const [group, paths] of groups) for (const file of collectNativeFiles(input, config, paths)) {
    if (!owners.has(file)) owners.set(file, new Set());
    owners.get(file).add(group);
  }
  const grouped = new Map();
  for (const [file, uses] of owners) {
    const group = uses.size > 1 || uses.has('common') ? 'common' : Array.from(uses)[0];
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(file);
  }
  const files = Array.from(owners.keys()).sort();
  const index = { version: 1, base, files: {} }, packages = [];
  const limit = 3 * 1024 * 1024;
  const script = '// Original map images. Loaded through wx.loadSubpackage.\n';
  for (const [group, groupFiles] of Array.from(grouped).sort(([a],[b]) => a === 'common' ? -1 : b === 'common' ? 1 : Number(a)-Number(b))) {
  let current, part = 0;
  for (const remote of groupFiles.sort()) {
    if (!/^remote\/resources\/native\/[0-9a-f]{2}\/[0-9a-f-]+\.[0-9a-f]+\.png$/.test(remote)) {
      throw new Error('Unexpected map native file: ' + remote);
    }
    const data = fs.readFileSync(path.join(input, remote));
    if (data.length + Buffer.byteLength(script) > limit) throw new Error('Map image exceeds subpackage budget');
    if (!current || current.bytes + data.length > limit) {
      const name = 'forest-map-' + group + (part ? '-' + part : ''), root = 'subpackages/' + name + '/';
      part++;
      current = { name, root, stage: group, bytes: Buffer.byteLength(script), files: 0 };
      packages.push(current);
      fs.mkdirSync(path.join(code, root), { recursive: true });
      fs.writeFileSync(path.join(code, root, 'game.js'), script);
    }
    const local = current.root + remote.slice('remote/resources/'.length);
    fs.mkdirSync(path.dirname(path.join(code, local)), { recursive: true });
    fs.writeFileSync(path.join(code, local), data);
    index.files[remote] = { package: current.name, path: local };
    current.bytes += data.length; current.files++;
  }
  }
  const evidence = { version: 1, base, files: files.map(remote => {
    const data = fs.readFileSync(path.join(input, remote));
    const item = index.files[remote];
    return { remote, local: item.path, package: item.package, bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex') };
  }) };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  const runtime = fs.readFileSync(path.join(__dirname, 'wechat-map-runtime.cjs'), 'utf8');
  fs.copyFileSync(path.join(__dirname, 'wechat-resource-timing.js'), path.join(code, 'wechat-resource-timing.js'));
  fs.writeFileSync(path.join(code, 'startup-maps.js'), runtime.replace('__FOREST_GUNNER_MAP_INDEX__', JSON.stringify(index)));
  const entryPath = path.join(code, 'game.js'), entry = fs.readFileSync(entryPath, 'utf8');
  const marker = "require('./startup-metadata').installStartupMetadata(cc);";
  if (entry.split(marker).length !== 2) throw new Error('Missing unique startup metadata hook');
  fs.writeFileSync(entryPath, entry.replace(marker, marker + "\n        require('./startup-maps').installMapResources(cc);"));
  return { files: files.length, imageBytes: packages.reduce((sum, p) => sum + p.bytes - Buffer.byteLength(script), 0),
    packages, indexSha256: crypto.createHash('sha256').update(JSON.stringify(index)).digest('hex'), remoteFilesUnchanged: true };
}

module.exports = { packageMapResources };
