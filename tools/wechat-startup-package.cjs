'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { STARTUP_METADATA_PACKAGE } = require('./wechat-startup-runtime.cjs');
const { decodeUuid } = require('./lib/bundle-native-files.cjs');
const { battleResourceGroups } = require('./lib/battle-resource-groups.cjs');
const { metadataGroupForPath, metadataResourceGroups } = require('./lib/metadata-resource-groups.cjs');
const { compactMeshMetadata } = require('./lib/compact-mesh-metadata.cjs');

function list(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? list(path.join(dir, entry.name)) : [path.join(dir, entry.name)]).sort();
}

function encodeMetadata(value) {
  // ASCII outer JSON avoids relying on TextDecoder in the mini-game host.
  const ascii = JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  const compressed = zlib.deflateSync(Buffer.from(ascii, 'ascii'), { level: 9 });
  if (zlib.inflateSync(compressed).toString('ascii') !== ascii) throw new Error('Metadata round trip failed');
  return compressed;
}

function compactFontMetadata(files, base) {
  const candidates = new Map(), parsed = new Map();
  const inspect = (value, location, file) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.pages) && value.glyphs && typeof value.glyphs === 'object' && !Array.isArray(value.glyphs)) {
      const metrics = { ...value, glyphs: {} }, variants = {};
      delete metrics.pages;
      for (const [code, glyph] of Object.entries(value.glyphs)) {
        metrics.glyphs[code] = { ...glyph };
        if (Object.prototype.hasOwnProperty.call(glyph, 'variants')) {
          variants[code] = glyph.variants;
          delete metrics.glyphs[code].variants;
        }
      }
      const signature = JSON.stringify(metrics);
      if (!candidates.has(signature)) candidates.set(signature, []);
      candidates.get(signature).push({ file, location, metrics, pages: value.pages, variants });
      return;
    }
    for (const [key, child] of Object.entries(value)) inspect(child, location.concat(key), file);
  };
  for (const [file, source] of Object.entries(files)) {
    const data = JSON.parse(source); parsed.set(file, data); inspect(data, [], file);
  }
  const fontMetrics = [], fonts = {}, compact = { ...files };
  let copiesRemoved = 0, bytesAvoided = 0;
  for (const [signature, matches] of candidates) {
    if (matches.length < 2 || signature.length < 1024) continue;
    const index = fontMetrics.length;
    // Store a canonical JSON source once. Native JSON.parse can materialize an
    // isolated copy much faster than a JavaScript walk of thousands of glyph
    // metric fields on mobile, while the container avoids repeated copies.
    fontMetrics.push(signature);
    copiesRemoved += matches.length - 1;
    bytesAvoided += (matches.length - 1) * Buffer.byteLength(signature);
    for (const item of matches) {
      if (!fonts[item.file]) fonts[item.file] = [];
      fonts[item.file].push({ path: item.location, index, pages: item.pages, variants: item.variants });
      if (!item.location.length) parsed.set(item.file, null);
      else {
        let parent = parsed.get(item.file);
        for (const key of item.location.slice(0, -1)) parent = parent[key];
        parent[item.location[item.location.length - 1]] = null;
      }
    }
  }
  if (!fontMetrics.length) return { metadata: { version: 1, base, files }, copiesRemoved, bytesAvoided };
  for (const file of Object.keys(fonts)) compact[file] = JSON.stringify(parsed.get(file));
  return { metadata: { version: 2, base, files: compact, fontMetrics, fonts }, copiesRemoved, bytesAvoided };
}

function metadataOwners(config, resourceGroups) {
  const owners = new Map();
  const groupFor = assetPath => metadataGroupForPath(assetPath, resourceGroups);
  const add = (uuid, group) => {
    if (!owners.has(uuid)) owners.set(uuid, new Set());
    owners.get(uuid).add(group);
  };
  for (const [index, item] of Object.entries(config.paths || {})) {
    const uuid = config.uuids && config.uuids[Number(index)];
    if (uuid) add(decodeUuid(uuid), groupFor(item[0]));
  }
  // A Creator import pack is indivisible: preserve every member and route the
  // whole JSON file once. Mixed ownership belongs to shared dependencies.
  for (const [uuid, indices] of Object.entries(config.packs || {})) {
    for (const index of indices) {
      const item = config.paths && config.paths[index];
      add(uuid, item ? groupFor(item[0]) : 'dependencies');
    }
  }
  return owners;
}

// WeaponVisualAssets.load always prepares weapon 0 before applying the saved
// squad. Derive its catalog from the compiled index instead of assuming that
// the starter remains an archery weapon. An ambiguous/legacy export stays lazy.
function requiredWeaponMetadataGroups(config, files, resourceGroups) {
  const entry = Object.entries(config.paths || {}).find(([, item]) => item[0] === 'art/weapon-runtime/index'
    && config.types[item[1]] === 'cc.JsonAsset');
  if (!entry) return new Set();
  const pack = Object.entries(config.packs || {}).find(([, indices]) => indices.includes(Number(entry[0])));
  const uuid = pack ? pack[0] : decodeUuid(config.uuids[Number(entry[0])]);
  const file = Object.keys(files).find(file => file.includes('/import/') && path.basename(file).split('.')[0] === uuid);
  if (!file) return new Set();
  const candidates = [];
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.weapons) && value.projectileGroups && typeof value.projectileGroups === 'object') candidates.push(value);
    else Object.values(value).forEach(inspect);
  };
  inspect(JSON.parse(files[file]));
  if (candidates.length !== 1) return new Set();
  const index = candidates[0], starters = index.weapons.filter(weapon => weapon.id === 0);
  const category = starters.length === 1 && index.projectileGroups[starters[0].projectileSkin];
  if (typeof category !== 'string' || !/^art\/weapon-runtime\/projectiles\/[a-z-]+$/.test(category)) return new Set();
  return new Set(['battle-weapon-core', 'battle-weapon', metadataGroupForPath(category, resourceGroups)]);
}

/** Keep the bundle index in the boot package. Imports retain their exact URLs
 * and bytes, but are inflated only when that feature/dependency is requested. */
function packageStartupMetadata(input, code, base) {
  const files = Object.create(null);
  let sourceBytes = 0;
  const resourceDirectory = path.join(input, 'remote', 'resources');
  const configs = fs.readdirSync(resourceDirectory).filter(name => /^config\.[0-9a-f]+\.json$/.test(name));
  if (configs.length !== 1) throw new Error('Expected one versioned resource bundle config');
  for (const file of [...list(path.join(resourceDirectory, 'import')), path.join(resourceDirectory, configs[0])]) {
    if (!file.endsWith('.json')) continue;
    const source = fs.readFileSync(file, 'utf8');
    JSON.parse(source);
    files[path.relative(input, file).split(path.sep).join('/')] = source;
    sourceBytes += Buffer.byteLength(source);
  }
  if (!Object.keys(files).length) throw new Error('No resource import metadata found');
  const configPath = 'remote/resources/' + configs[0];
  const config = JSON.parse(files[configPath]);
  const resourceGroups = metadataResourceGroups(config, files, battleResourceGroups(input, config, files).groups);
  const owners = metadataOwners(config, resourceGroups);
  const requiredWeaponGroups = requiredWeaponMetadataGroups(config, files, resourceGroups);
  const grouped = new Map();
  for (const [file, source] of Object.entries(files)) {
    if (file === configPath) continue;
    const owner = owners.get(path.basename(file).split('.')[0]);
    const originalGroup = !owner ? 'dependencies' : owner.size === 1 ? Array.from(owner)[0] : 'shared';
    const group = requiredWeaponGroups.has(originalGroup) ? 'core' : originalGroup;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push([file, source]);
  }
  const metadata = { version: 2, base, files: { [configPath]: files[configPath] }, routes: {}, groups: {} };
  const pending = [], script = "'use strict';\n";
  for (const [group, entries] of Array.from(grouped).sort(([a], [b]) => a.localeCompare(b))) {
    const feature = !['core', 'entries', 'maps', 'fonts', 'shared', 'dependencies'].includes(group);
    const partBudget = (feature ? 8 : 1) * 1024 * 1024;
    let part = [], bytes = 0, partIndex = 0;
    const finish = () => {
      if (!part.length) return;
      const name = `forest-${feature ? 'feature' : 'metadata'}-${group}-${partIndex++}`, root = `subpackages/${name}/`, local = root + 'metadata.bin';
      const contents = Object.fromEntries(part), compacted = compactFontMetadata(contents, base);
      const meshes = compactMeshMetadata(compacted.metadata);
      const data = encodeMetadata(meshes.metadata);
      const packageInfo = { name, root, path: local, group, bytes: data.length + Buffer.byteLength(script),
        files: part.length, sourceBytes: bytes };
      if (packageInfo.bytes > 4 * 1024 * 1024) throw new Error(`Lazy metadata subpackage exceeds 4 MiB: ${packageInfo.bytes}`);
      metadata.groups[name] = { name, path: local };
      for (const [file] of part) metadata.routes[file] = name;
      pending.push({ packageInfo, data, sources: contents, copiesRemoved: compacted.copiesRemoved, bytesAvoided: compacted.bytesAvoided,
        meshCopiesRemoved: meshes.copiesRemoved, meshBytesAvoided: meshes.bytesAvoided });
      part = []; bytes = 0;
    };
    for (const entry of entries) {
      const size = Buffer.byteLength(entry[1]);
      if (part.length && bytes + size > partBudget) finish();
      part.push(entry); bytes += size;
    }
    finish();
  }
  // Keep the existing bounded 1 MiB source partitions as the fallback. Merge
  // adjacent, always-required core fragments only when their actual expanded
  // ASCII payload and compressed bytes both fit the small startup budget.
  // Other feature groups, entries and unknown dependencies keep their routes.
  let corePackagesMerged = 0;
  for (let i = 0; i + 1 < pending.length; i++) {
    const current = pending[i], next = pending[i + 1];
    if (current.packageInfo.group !== 'core' || next.packageInfo.group !== 'core') continue;
    const sources = { ...current.sources, ...next.sources };
    const compacted = compactFontMetadata(sources, base), meshes = compactMeshMetadata(compacted.metadata);
    const data = encodeMetadata(meshes.metadata);
    if (data.length + Buffer.byteLength(script) > 512 * 1024 || zlib.inflateSync(data).length > 2 * 1024 * 1024) continue;
    current.packageInfo.bytes = data.length + Buffer.byteLength(script);
    current.packageInfo.files += next.packageInfo.files;
    current.packageInfo.sourceBytes += next.packageInfo.sourceBytes;
    Object.assign(current, { data, sources, copiesRemoved: compacted.copiesRemoved, bytesAvoided: compacted.bytesAvoided,
      meshCopiesRemoved: meshes.copiesRemoved, meshBytesAvoided: meshes.bytesAvoided });
    for (const file of Object.keys(next.sources)) metadata.routes[file] = current.packageInfo.name;
    delete metadata.groups[next.packageInfo.name];
    pending.splice(i + 1, 1); corePackagesMerged++; i--;
  }
  const compressed = encodeMetadata(metadata);
  const subpackage = { name: STARTUP_METADATA_PACKAGE.name, root: STARTUP_METADATA_PACKAGE.root,
    bytes: compressed.length + Buffer.byteLength(script), files: 1 };
  if (subpackage.bytes > 4 * 1024 * 1024) throw new Error(`Startup metadata subpackage exceeds 4 MiB: ${subpackage.bytes}`);
  fs.mkdirSync(path.join(code, subpackage.root), { recursive: true });
  fs.writeFileSync(path.join(code, subpackage.root, 'game.js'), script);
  fs.writeFileSync(path.join(code, STARTUP_METADATA_PACKAGE.path), compressed);
  for (const { packageInfo, data } of pending) {
    fs.mkdirSync(path.join(code, packageInfo.root), { recursive: true });
    fs.writeFileSync(path.join(code, packageInfo.root, 'game.js'), script);
    fs.writeFileSync(path.join(code, packageInfo.path), data);
  }
  fs.copyFileSync(path.join(__dirname, 'wechat-startup-runtime.cjs'), path.join(code, 'startup-metadata.js'));
  fs.copyFileSync(path.join(__dirname, 'wechat-resource-timing.js'), path.join(code, 'wechat-resource-timing.js'));
  fs.copyFileSync(path.join(__dirname, 'vendor', 'startup-inflate.cjs'), path.join(code, 'startup-inflate.js'));
  fs.copyFileSync(path.join(__dirname, 'vendor', 'startup-inflate.LICENSE.txt'), path.join(code, 'startup-inflate.LICENSE.txt'));
  const entryPath = path.join(code, 'game.js');
  const entry = fs.readFileSync(entryPath, 'utf8');
  const adapterLoads = entry.match(/require\(['"]\.\/engine-adapter(?:\.[0-9a-f]+)?(?:\.js)?['"]\);/g) || [];
  const initialization = 'return application.init(cc);';
  if (adapterLoads.length !== 1 || entry.includes("require('./startup-metadata')")
    || entry.split(initialization).length !== 2 || entry.indexOf(adapterLoads[0]) > entry.indexOf(initialization)) {
    throw new Error('Unexpected Creator game entry; refusing ambiguous metadata hook');
  }
  // Start the official index download before parsing/initializing the engine;
  // installation still waits for the adapter and the completed index request.
  fs.writeFileSync(entryPath, "const __forestGunnerMetadataReady = require('./startup-metadata').prepareStartupMetadata();\n" + entry.replace(initialization,
    "return __forestGunnerMetadataReady.then(() => {\n"
    + "          require('./startup-metadata').installStartupMetadata(cc);\n"
    + "          return application.init(cc);\n        });"));
  return { files: Object.keys(files).length, sourceBytes, compressedBytes: compressed.length,
    sha256: crypto.createHash('sha256').update(compressed).digest('hex'),
    path: STARTUP_METADATA_PACKAGE.path, package: subpackage,
    packages: [subpackage, ...pending.map(item => item.packageInfo)],
    startupSourceBytes: Buffer.byteLength(files[configPath]),
    totalCompressedBytes: compressed.length + pending.reduce((sum, item) => sum + item.data.length, 0),
    corePackagesMerged,
    fontMetricCopiesRemoved: pending.reduce((sum, item) => sum + item.copiesRemoved, 0),
    fontMetricBytesAvoided: pending.reduce((sum, item) => sum + item.bytesAvoided, 0),
    meshGeometryCopiesRemoved: pending.reduce((sum, item) => sum + item.meshCopiesRemoved, 0),
    meshGeometryBytesAvoided: pending.reduce((sum, item) => sum + item.meshBytesAvoided, 0),
    remoteFilesUnchanged: true };
}

function installStartupErrorHandler(code) {
  const entryPath = path.join(code, 'game.js');
  const entry = fs.readFileSync(entryPath, 'utf8');
  const marker = /\}\)\.catch\(\(err\) => \{\s*console\.error\(err\);\s*\}\);/g;
  const matches = entry.match(marker) || [];
  if (matches.length !== 1) throw new Error('Expected one startup error handler');
  fs.copyFileSync(path.join(__dirname, 'wechat-startup-errors.cjs'), path.join(code, 'startup-errors.js'));
  fs.writeFileSync(entryPath, entry.replace(marker,
    "}).catch((err) => {\n    require('./startup-errors').reportStartupError(err);\n});"));
}

module.exports = { packageStartupMetadata, installStartupErrorHandler };
