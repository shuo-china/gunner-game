'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { collectNativeFiles, decodeUuid } = require('./lib/bundle-native-files.cjs');

function compiledMapConfig(input, config, assetPath, matches) {
  const item = Object.entries(config.paths).find(([, value]) => value[0] === assetPath && config.types[value[1]] === 'cc.JsonAsset');
  if (!item) throw new Error('Missing compiled map config: ' + assetPath);
  const pack = Object.entries(config.packs || {}).find(([, indices]) => indices.includes(Number(item[0])));
  const uuid = pack ? pack[0] : decodeUuid(config.uuids[Number(item[0])]);
  const directory = path.join(input, 'remote/resources/import', uuid.slice(0, 2));
  const files = fs.readdirSync(directory).filter(name => name.startsWith(uuid + '.') && name.endsWith('.json'));
  if (files.length !== 1) throw new Error('Ambiguous map config import: ' + assetPath);
  const found = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (matches(value)) found.push(value);
    else Object.values(value).forEach(visit);
  };
  visit(JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8')));
  if (found.length !== 1) throw new Error('Invalid compiled map config: ' + assetPath);
  return found[0];
}

function packageMapResources(input, code, config, base, evidencePath) {
  const roots = Object.values(config.paths).filter(p => config.types[p[1]] === 'cc.SpriteFrame'
    && /^art\/(maps\/forest|stages)\//.test(p[0])).map(p => 'cc.SpriteFrame:' + p[0]);
  if (!roots.length) throw new Error('No map sprite frames found');
  const map = compiledMapConfig(input, config, 'art/maps/forest/map', value => value.version === 1
    && value.sprites && value.ground && Array.isArray(value.borders));
  const stages = compiledMapConfig(input, config, 'art/stages/config', value => value.version === 1
    && Array.isArray(value.skins) && Array.isArray(value.treeSprites));
  if (stages.skins.length !== 10 || stages.treeSprites.length !== 40 || !stages.normal?.healthBar || !stages.boss?.healthBar) {
    throw new Error('Invalid original stage assets');
  }
  const available = new Set(Object.values(config.paths).filter(value => config.types[value[1]] === 'cc.SpriteFrame')
    .map(value => 'cc.SpriteFrame:' + value[0]));
  const groups = new Map(), referenced = new Set();
  const add = (name, frames) => {
    const paths = frames.map(frame => {
      const root = frame && 'cc.SpriteFrame:' + frame.path + '/spriteFrame';
      if (!available.has(root)) throw new Error('Missing map asset: ' + root);
      referenced.add(root); return root;
    });
    groups.set(name, paths);
  };
  // Follow OriginalMapView.stageFrames, not authoring folder names: a stage can
  // replace its trees and theme while keeping older exports in resources.
  add('common', [...Object.values(map.sprites), stages.normal.healthBar.background, stages.normal.healthBar.fill,
    stages.boss.healthBar.background, stages.boss.healthBar.fill, ...(stages.boss.sparkles ? [stages.boss.sparkles.image] : [])]);
  for (let stage = 0; stage < stages.skins.length; stage++) {
    const skin = stages.skins[stage];
    if (!skin?.sprites || Array.isArray(skin.sprites)) throw new Error('Invalid stage sprites: ' + stage);
    add(String(stage), [...Object.values(skin.sprites), ...stages.treeSprites.slice(stage * 4, stage * 4 + 4)]);
  }
  // Keep retired themes separate from older flat exports: the old stage-zero
  // ground is still used by hunt/mine, and must not pull an unused harvest theme.
  const legacyGroups = new Map();
  for (const root of roots.filter(root => !referenced.has(root))) {
    const asset = root.slice('cc.SpriteFrame:'.length).replace(/\/spriteFrame$/, '');
    const tree = /^art\/stages\/trees\/(\d+)$/.exec(asset);
    const key = tree ? 'trees/' + Math.floor(Number(tree[1]) / 4) : asset.slice(0, asset.lastIndexOf('/'));
    if (!legacyGroups.has(key)) legacyGroups.set(key, []);
    legacyGroups.get(key).push(root);
  }
  Array.from(legacyGroups).sort(([a], [b]) => a.localeCompare(b))
    .forEach(([, paths], index) => groups.set('legacy-' + index, paths));
  const mapFiles = new Set(collectNativeFiles(input, config, roots));
  // Creator can atlas frames from multiple stages into one texture. Such native
  // dependencies belong in common. Keep this hook's existing map inventory;
  // deduplicated HUD images outside it retain the feature resource hook.
  const owners = new Map();
  for (const [group, paths] of groups) for (const file of collectNativeFiles(input, config, paths)) {
    if (!mapFiles.has(file)) continue;
    if (!owners.has(file)) owners.set(file, new Set());
    owners.get(file).add(group);
  }
  const grouped = new Map();
  for (const [file, uses] of owners) {
    // An unused alias is not an active consumer of a shared native texture.
    const active = Array.from(uses).filter(name => !name.startsWith('legacy-'));
    const group = active.length ? active.length > 1 || active.includes('common') ? 'common' : active[0]
      : uses.size > 1 ? 'legacy' : Array.from(uses)[0];
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(file);
  }
  const files = Array.from(owners.keys()).sort();
  const index = { version: 1, base, files: {} }, packages = [];
  const limit = 3 * 1024 * 1024;
  const script = '// Original map images. Loaded through wx.loadSubpackage.\n';
  const order = name => name === 'common' ? -1 : name.startsWith('legacy') ? 10 : Number(name);
  for (const [group, groupFiles] of Array.from(grouped).sort(([a],[b]) => order(a)-order(b) || a.localeCompare(b))) {
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
  return { files: files.length, nativeFiles: files, imageBytes: packages.reduce((sum, p) => sum + p.bytes - Buffer.byteLength(script), 0),
    packages, indexSha256: crypto.createHash('sha256').update(JSON.stringify(index)).digest('hex'), remoteFilesUnchanged: true };
}

module.exports = { packageMapResources };
