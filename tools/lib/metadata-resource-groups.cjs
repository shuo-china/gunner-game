'use strict';
const path = require('node:path');
const { decodeUuid } = require('./bundle-native-files.cjs');

const imagePath = asset => asset.replace(/\/(spriteFrame|texture)$/, '');

function metadataGroupForPath(asset, groups) {
  const explicit = groups.get(imagePath(asset));
  if (explicit) return explicit;
  const feature = /^art\/([a-z-]+)-system\//.exec(asset);
  if (feature) return feature[1] === 'weapon' ? 'weapons' : feature[1];
  if (/^art\/feature-entries\//.test(asset)) return 'entries';
  if (/^art\/(stages|maps)\//.test(asset)) return 'maps';
  if (/^art\/latin-fonts\//.test(asset)) return 'fonts';
  return 'core';
}

// Native PNG ownership already follows consumers. Its ImageAsset, Texture2D
// and SpriteFrame imports must do the same, or a small shared image can still
// download a complete unrelated feature through its original directory.
function metadataResourceGroups(config, sources, battleGroups) {
  const groups = new Map(battleGroups), images = new Set(), consumers = new Map();
  const packs = new Map(), imports = new Map(), parsed = new Map(), inspected = new Set();
  for (const [uuid, indices] of Object.entries(config.packs || {})) {
    for (const index of indices) packs.set(String(index), uuid);
  }
  for (const file of Object.keys(sources)) {
    if (file.includes('/import/')) imports.set(path.basename(file).split('.')[0], file);
  }
  for (const item of Object.values(config.paths || {})) {
    if (['cc.ImageAsset', 'cc.Texture2D', 'cc.SpriteFrame'].includes(config.types[item[1]])) images.add(imagePath(item[0]));
  }
  const inspect = (value, consumer) => {
    if (typeof value === 'string') {
      const asset = imagePath(value);
      if (!images.has(asset)) return;
      if (!consumers.has(asset)) consumers.set(asset, new Set());
      consumers.get(asset).add(consumer);
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) inspect(child, consumer);
    }
  };
  for (const [index, item] of Object.entries(config.paths || {})) {
    if (config.types[item[1]] !== 'cc.JsonAsset') continue;
    const uuid = packs.get(index) || decodeUuid(config.uuids[Number(index)]), file = imports.get(uuid);
    if (!file) throw new Error('Missing resource definition: ' + item[0]);
    const consumer = metadataGroupForPath(item[0], battleGroups), key = consumer + ':' + file;
    if (consumer === 'weapon-authoring') continue;
    if (inspected.has(key)) continue;
    inspected.add(key);
    if (!parsed.has(file)) parsed.set(file, JSON.parse(sources[file]));
    // A compiled import pack stays indivisible. Inspect all its records for
    // every owning consumer; grouping may be conservative but never detaches
    // the records or changes their bytes, UUIDs, or versioned URLs.
    inspect(parsed.get(file), consumer);
  }
  for (const [asset, owners] of consumers) {
    groups.set(asset, owners.size === 1 ? owners.values().next().value : 'shared');
  }
  return groups;
}

module.exports = { metadataGroupForPath, metadataResourceGroups };
