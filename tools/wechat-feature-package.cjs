'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { collectNativeFiles, decodeUuid } = require('./lib/bundle-native-files.cjs');
const { battleResourceGroups } = require('./lib/battle-resource-groups.cjs');

function uiConfig(input, config, assetPath, matchesConfig) {
  const item = Object.entries(config.paths).find(([, p]) => p[0] === assetPath && config.types[p[1]] === 'cc.JsonAsset');
  if (!item) throw new Error('Missing compiled UI config: ' + assetPath);
  const pack = Object.entries(config.packs || {}).find(([, indices]) => indices.includes(Number(item[0])));
  const uuid = pack ? pack[0] : decodeUuid(config.uuids[Number(item[0])]);
  const directory = path.join(input, 'remote/resources/import', uuid.slice(0, 2));
  const file = fs.readdirSync(directory).find(name => name.startsWith(uuid + '.') && name.endsWith('.json'));
  if (!file) throw new Error('Missing UI config import: ' + assetPath);
  const matches = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (matchesConfig(value)) matches.push(value);
    else Object.values(value).forEach(visit);
  };
  visit(JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')));
  if (matches.length !== 1) throw new Error('Ambiguous UI config import: ' + assetPath);
  return matches[0];
}

// Match OriginalWeaponUi.weaponHudImagePaths: only collection-exclusive art is
// deferred. Retain dynamic icons and every image whose ownership is uncertain.
function collectionOnlyImages(ui) {
  const collect = roots => {
    const found = new Set(), visited = new Set();
    const visit = id => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = ui.nodes && ui.nodes[id];
      if (!node) return;
      const image = node.image && ui.images[node.image.sprite];
      if (image) found.add(image.path);
      (node.children || []).forEach(visit);
    };
    roots.forEach(visit); return found;
  };
  const collection = collect([ui.roots.collection]);
  const common = collect(Object.entries(ui.roots).filter(([name]) => name !== 'collection').map(([, root]) => root));
  for (const key of [...(ui.gunIcons || []), ...Object.values(ui.inlineSprites || {})]) {
    if (ui.images[key]) common.add(ui.images[key].path);
  }
  return new Set(Array.from(collection).filter(image => !common.has(image)));
}

// Exact ownership combinations proliferate after content deduplication: dozens
// of tiny, almost identical consumer sets must not each consume a platform slot.
// Merge only intersecting sets, bounding both package size and each consumer's
// added bytes across the entire shared tier. Private feature assets stay apart.
function coalesceSharedResources(ownersByFile, sizeOf, totalExtraLimit = 128 * 1024) {
  const exact = new Map(), packageLimit = 512 * 1024 - 64, perPackageExtraLimit = 64 * 1024;
  for (const [file, consumers] of Array.from(ownersByFile).sort(([a], [b]) => a.localeCompare(b))) {
    const owners = Array.from(consumers).sort(); if (owners.length < 2) continue;
    const key = owners.join(','), bytes = sizeOf(file);
    if (!exact.has(key)) exact.set(key, { files: [], required: new Map(owners.map(name => [name, 0])), bytes: 0 });
    const group = exact.get(key); group.files.push(file); group.bytes += bytes;
    for (const name of owners) group.required.set(name, group.required.get(name) + bytes);
  }
  const groups = Array.from(exact.values()), originalGroups = groups.length;
  const extra = group => new Map(Array.from(group.required, ([name, bytes]) => [name, group.bytes - bytes]));
  const totalExtra = new Map();
  for (;;) {
    let best;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i], b = groups[j], bytes = a.bytes + b.bytes;
      if (bytes > packageLimit || !Array.from(a.required.keys()).some(name => b.required.has(name))) continue;
      const required = new Map(a.required), aExtra = extra(a), bExtra = extra(b);
      for (const [name, count] of b.required) required.set(name, (required.get(name) || 0) + count);
      let cost = 0, permitted = true;
      for (const [name, count] of required) {
        const additional = bytes - count, delta = additional - (aExtra.get(name) || 0) - (bExtra.get(name) || 0);
        if (additional > perPackageExtraLimit || (totalExtra.get(name) || 0) + delta > totalExtraLimit) { permitted = false; break; }
        cost += delta;
      }
      if (permitted && (!best || cost < best.cost || cost === best.cost && bytes > best.group.bytes)) {
        best = { i, j, cost, group: { files: [...a.files, ...b.files].sort(), required, bytes } };
      }
    }
    if (!best) break;
    for (const group of [groups[best.i], groups[best.j]]) for (const [name, bytes] of extra(group)) {
      totalExtra.set(name, (totalExtra.get(name) || 0) - bytes);
    }
    for (const [name, bytes] of extra(best.group)) totalExtra.set(name, (totalExtra.get(name) || 0) + bytes);
    groups[best.i] = best.group; groups.splice(best.j, 1);
  }
  return { groups: groups.map(group => ({ files: group.files, bytes: group.bytes,
    consumers: Array.from(group.required.keys()).sort(), extraBytesByConsumer: Object.fromEntries(extra(group)) })),
    report: { originalGroups, mergedGroups: groups.length, packageLimitBytes: packageLimit,
      perPackageExtraLimitBytes: perPackageExtraLimit, totalExtraLimitBytes: totalExtraLimit,
      extraBytesByConsumer: Object.fromEntries(Array.from(totalExtra).sort(([a], [b]) => a.localeCompare(b))) } };
}

// Font and image grouping used to run independently, even when every consumer
// needs both packages. Combine only identical consumer sets: this adds zero
// download bytes for every consumer and never couples a private/locked panel.
function coalesceSharedPackages(groups, limit = 512 * 1024 - 64) {
  const buckets = new Map(), result = [], merges = [];
  for (const group of groups) {
    const key = [...group.consumers].sort().join(',');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(group);
  }
  for (const [key, candidates] of Array.from(buckets).sort(([a], [b]) => a.localeCompare(b))) {
    const bins = [];
    for (const group of candidates.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))) {
      let bin = bins.find(item => item.bytes + group.bytes <= limit);
      if (!bin) { bin = { parts: [], bytes: 0 }; bins.push(bin); }
      bin.parts.push(group); bin.bytes += group.bytes;
    }
    for (const bin of bins) {
      if (bin.parts.length === 1) { result.push(bin.parts[0]); continue; }
      const files = bin.parts.flatMap(part => part.files).sort();
      const name = 'assets-shared-' + crypto.createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 8);
      const consumers = key.split(',');
      result.push({ name, files, bytes: bin.bytes, consumers });
      merges.push({ name, from: bin.parts.map(part => part.name).sort(), consumers, bytes: bin.bytes });
    }
  }
  return { groups: result.sort((a, b) => a.name.localeCompare(b.name)),
    report: { originalGroups: groups.length, mergedGroups: result.length, limitBytes: limit, addedBytes: 0, merges } };
}

function packageFeatureResources(input, code, config, base, evidencePath, metadataPackages = []) {
  const ui = uiConfig(input, config, 'art/weapon-system/config', value => Array.isArray(value.gunIcons) && value.images && value.roles && value.roots?.inventory);
  const settings = uiConfig(input, config, 'art/settings-system/config', value => value.settingsUi && value.input && value.images && value.roots);
  const hud = uiConfig(input, config, 'art/hud/config', value => value.joystick && value.layout && value.format);
  const alerts = uiConfig(input, config, 'art/ui-alert/config', value => value.poolSize && value.messages && value.layout);
  const stage = uiConfig(input, config, 'art/stage-transition/config', value => value.roots?.loading && value.bannerAnimation);
  // Validate compiled data: packaging an old build would leave the new renderer
  // dependent on undeployed pages or the old platform TTF fallback.
  if (!hud.bitmapFont?.pages?.length || !alerts.bitmapFont?.pages?.length || !settings.input.bitmapFont?.pages?.length
    || !stage.bitmapFonts || !ui.bitmapFonts) throw new Error('Latin bitmap font conversion is missing from the build');
  const fontRoots = panel => [...Object.values(panel.bitmapFonts || {}), panel.bitmapFont, panel.input?.bitmapFont]
    .filter(Boolean).flatMap(font => font.pages.map(page => 'cc.SpriteFrame:' + page + '/spriteFrame'));
  const imageRoots = panel => [...Object.values(panel.images || {}).map(image => 'cc.SpriteFrame:' + image.path + '/spriteFrame'), ...fontRoots(panel)];
  const namedPanels = [['weapons', ui], ['settings', settings], ...[
    ['rebirth', value => value.roots?.normal && value.roots?.ad],
    ['speedrun', value => Array.isArray(value.treeIcons)],
    ['raid', value => Array.isArray(value.bossSprites)],
    ['boss', value => Array.isArray(value.bossHeads)],
    ['skin', value => value.roots?.list && (value.previewMode === 'battle-parts' || Array.isArray(value.portraits))],
    ['pet', value => value.roots?.newPet && Array.isArray(value.portraits)],
    ['fish', value => Array.isArray(value.fishSprites)],
    ['hunt', value => Array.isArray(value.monsterSprites)],
  ].map(([name, matches]) => [name, uiConfig(input, config, `art/${name}-system/config`, matches)])];
  // Mine is being introduced independently; include it whenever this build
  // contains the catalog, without imposing it on builds that do not use it.
  if (Object.values(config.paths).some(value => value[0] === 'art/mine-system/config')) {
    namedPanels.push(['mine', uiConfig(input, config, 'art/mine-system/config', value => value.roots?.start && value.ticketDisabledColor)]);
  }
  if (Object.values(config.paths).some(value => value[0] === 'art/adventure-system/config')) {
    namedPanels.push(['adventure', uiConfig(input, config, 'art/adventure-system/config', value => value.roots?.petSelect && value.roots?.relicDraw)]);
  }
  const offline = Object.values(config.paths).some(value => value[0] === 'art/offline-system/config')
    ? uiConfig(input, config, 'art/offline-system/config', value => value.roots?.offline && value.offlineUi) : null;
  if (offline) namedPanels.push(['offline', offline]);
  const dailyCheck = Object.values(config.paths).some(value => value[0] === 'art/daily-check-system/config')
    ? uiConfig(input, config, 'art/daily-check-system/config', value => value.roots?.dailyCheck && value.dailyCheckUi) : null;
  if (dailyCheck) namedPanels.push(['daily-check', dailyCheck]);
  const startupFonts = collectNativeFiles(input, config, fontRoots(hud));
  const transitionFonts = collectNativeFiles(input, config, [alerts, stage].flatMap(fontRoots));
  const panelFonts = collectNativeFiles(input, config, namedPanels.flatMap(([, panel]) => fontRoots(panel)));
  const fontFiles = new Set([...startupFonts, ...transitionFonts, ...panelFonts]);
  // The small menu must not trigger a multi-megabyte full weapon panel download.
  // Identify its compiled JSON by the matching authored root, even in shared packs.
  const weaponEntry = uiConfig(input, config, 'art/feature-entries/weapons', value => value.roots?.entry === ui.roots.entry && Object.keys(value.roots).length === 1 && value.images && value.roles);
  const fontOwners = new Map();
  for (const [name, panel] of [...namedPanels, ['entry-weapons', weaponEntry]]) {
    for (const file of collectNativeFiles(input, config, fontRoots(panel))) {
      fontFiles.add(file);
      if (startupFonts.includes(file) || transitionFonts.includes(file)) continue;
      if (!fontOwners.has(file)) fontOwners.set(file, new Set());
      fontOwners.get(file).add(name);
    }
  }
  const fontGroups = new Map();
  for (const [file, owners] of fontOwners) {
    const names = Array.from(owners).sort();
    if (names.length > 1) continue;
    const group = metadataPackages.length ? names[0] : 'fonts-' + names[0];
    if (!fontGroups.has(group)) fontGroups.set(group, []);
    fontGroups.get(group).push(file);
  }
  const sizeOf = file => fs.statSync(path.join(input, file)).size;
  const sharedFonts = coalesceSharedResources(fontOwners, sizeOf, 64 * 1024);
  const sharedName = (prefix, group) => prefix + crypto.createHash('sha256').update(group.files.join('\n')).digest('hex').slice(0, 8);
  const collectionImages = collectionOnlyImages(ui);
  const weaponImages = Object.values(ui.images).map(image => image.path);
  const imageFiles = paths => collectNativeFiles(input, config, paths.map(path => 'cc.SpriteFrame:' + path + '/spriteFrame'));
  // Live skin views no longer list whole portraits in panel.images. Follow the
  // same appearance parts and face attachment as SkinHud so these textures also
  // ship locally, while the battle consumer below keeps them out of UI packages.
  const skinPanel = namedPanels.find(([name]) => name === 'skin')[1];
  const skinPreviewPaths = new Set();
  if (skinPanel.previewMode === 'battle-parts') {
    const visuals = uiConfig(input, config, 'art/skin-system/visuals', value => Array.isArray(value.skins) && typeof value.sharedRig === 'string');
    if (visuals.bodyContour?.path) skinPreviewPaths.add(visuals.bodyContour.path);
    for (const skin of visuals.skins) for (const part of skin.parts) skinPreviewPaths.add(part.path);
    const rig = uiConfig(input, config, visuals.sharedRig, value => Array.isArray(value.bones) && value.attachments?.face?.path);
    skinPreviewPaths.add(rig.attachments.face.path);
  }
  const imageGroups = [
    ['input', collectNativeFiles(input, config, ['cc.SpriteFrame:art/hud/joystick_background/spriteFrame', 'cc.SpriteFrame:art/hud/joystick_handle/spriteFrame'])],
    ...namedPanels.filter(([name]) => name !== 'weapons').map(([name, panel]) => [name, collectNativeFiles(input, config,
      [...imageRoots(panel), ...(name === 'skin' ? Array.from(skinPreviewPaths, asset => 'cc.SpriteFrame:' + asset + '/spriteFrame') : [])])]),
    ['entry-weapons', collectNativeFiles(input, config, imageRoots(weaponEntry))],
    ['weapons', imageFiles(weaponImages.filter(image => !collectionImages.has(image)))],
    ['collection', imageFiles(weaponImages.filter(image => collectionImages.has(image)))],
  ];
  const imageOwners = new Map();
  for (const [group, files] of imageGroups) for (const file of files) {
    if (fontFiles.has(file)) continue;
    if (!imageOwners.has(file)) imageOwners.set(file, new Set());
    imageOwners.get(file).add(group);
  }
  const independentImages = new Map();
  // A battle texture also used by a panel must live in a bounded shared image
  // package, never drag that panel's complete metadata/fonts/images into boot.
  const battleImages = battleResourceGroups(input, config).images;
  const spritePaths = new Set(Object.values(config.paths).filter(item => config.types[item[1]] === 'cc.SpriteFrame').map(item => item[0]));
  const battleFiles = imageFiles(Array.from(battleImages).filter(asset => spritePaths.has(asset + '/spriteFrame')));
  for (const file of battleFiles) if (imageOwners.has(file)) imageOwners.get(file).add('battle');
  for (const [file, owners] of imageOwners) {
    const names = Array.from(owners).sort();
    if (names.length > 1) continue;
    const group = names[0];
    if (!independentImages.has(group)) independentImages.set(group, []);
    independentImages.get(group).push(file);
  }
  const sharedImages = coalesceSharedResources(imageOwners, sizeOf);
  const sharedNative = coalesceSharedPackages([
    ...sharedFonts.groups.map(group => ({ ...group, name: sharedName('fonts-shared-', group) })),
    ...sharedImages.groups.map(group => ({ ...group, name: sharedName('images-shared-', group) })),
  ]);
  for (const group of sharedNative.groups) fontGroups.set(group.name, group.files);
  const groups = new Map([
    // Loading text and the main HUD precede all subpackage/CDN requests. Stage
    // and alert glyphs preload from a subpackage to preserve the 4 MiB main limit.
    ['startup', startupFonts],
    // Keep these together; UUID-sorted pages from every panel would otherwise
    // make the initial stage loader pull several unrelated 3 MiB font packages.
    ['startup-fonts', transitionFonts],
    // A page shared by two panels must not drag all other panels' atlases into
    // the same download. Fonts are claimed before any panel's image group.
    ...Array.from(fontGroups).sort(([a], [b]) => a.localeCompare(b)).map(([name, files]) => [name, files.sort()]),
  ]);
  for (const [group, files] of Array.from(independentImages).sort(([a], [b]) => a.localeCompare(b))) {
    groups.set(group, [...(groups.get(group) || []), ...files.sort()]);
  }
  const index = { version: 2, base, files: {} }, packages = [], evidence = [];
  const script = '// Versioned first-use UI resources.\n';
  for (const [group, files] of groups) {
    const limit = group.startsWith('fonts-') || group.includes('-shared-') || group === 'startup-fonts' ? 512 * 1024 : 3 * 1024 * 1024;
    const existing = metadataPackages.filter(item => item.name.startsWith('forest-feature-') && item.group === group);
    let current, part = existing.length;
    for (const remote of files) {
      if (index.files[remote]) continue;
      if (!/^remote\/resources\/native\/[0-9a-f]{2}\/[0-9a-f-]+\.[0-9a-f]+\.png$/.test(remote)) throw new Error('Unexpected UI native: ' + remote);
      const bytes = fs.readFileSync(path.join(input, remote));
      // Individual font pages remain indivisible; one may exceed the preferred
      // small grouping budget, but never the official package budget.
      if (bytes.length + Buffer.byteLength(script) > 3 * 1024 * 1024) throw new Error('UI asset exceeds subpackage budget');
      if (group !== 'startup' && (!current || current.bytes + bytes.length > limit)) {
        current = existing.find(item => item.bytes + bytes.length <= limit);
        if (!current) {
          const name = `forest-${existing.length ? 'feature' : 'ui'}-${group}-${part++}`, root = 'subpackages/' + name + '/';
          current = { name, root, bytes: Buffer.byteLength(script), files: 0 };
          fs.mkdirSync(path.join(code, root), { recursive: true }); fs.writeFileSync(path.join(code, root, 'game.js'), script);
        }
        if (!packages.includes(current)) packages.push(current);
      }
      const local = (group === 'startup' ? 'startup-ui/' : current.root) + remote.slice('remote/resources/'.length);
      fs.mkdirSync(path.dirname(path.join(code, local)), { recursive: true }); fs.writeFileSync(path.join(code, local), bytes);
      const packageName = group === 'startup' ? null : current.name;
      index.files[remote] = { package: packageName, path: local, localOnly: fontFiles.has(remote) };
      if (current) { current.bytes += bytes.length; current.files++; }
      evidence.push({ remote, local, package: packageName, localOnly: fontFiles.has(remote), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  }
  const sharedGroups = { fonts: sharedFonts.report, images: sharedImages.report, combined: sharedNative.report };
  fs.writeFileSync(evidencePath, JSON.stringify({ ...index, files: evidence, sharedGroups }, null, 2) + '\n');
  const runtime = fs.readFileSync(path.join(__dirname, 'wechat-feature-runtime.cjs'), 'utf8');
  fs.copyFileSync(path.join(__dirname, 'wechat-resource-timing.js'), path.join(code, 'wechat-resource-timing.js'));
  fs.writeFileSync(path.join(code, 'startup-features.js'), runtime.replace('__FOREST_GUNNER_FEATURE_INDEX__', JSON.stringify(index)));
  const entryPath = path.join(code, 'game.js'), entry = fs.readFileSync(entryPath, 'utf8');
  const marker = "require('./startup-metadata').installStartupMetadata(cc);";
  if (entry.split(marker).length !== 2) throw new Error('Missing startup metadata hook');
  fs.writeFileSync(entryPath, entry.replace(marker, marker + "\n        require('./startup-features').installFeatureResources(cc);"));
  return { files: evidence.length, bytes: evidence.reduce((sum, file) => sum + file.bytes, 0), packages, sharedGroups };
}
module.exports = { packageFeatureResources, collectionOnlyImages, coalesceSharedResources, coalesceSharedPackages };
