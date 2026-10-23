'use strict';
// Bake the equipment UI baselines into collection artwork without grade growth.
// These seven baselines are independent of battle units and runtime fitting.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pngAlpha } = require('./lib/png-alpha.cjs');

const pair = value => Array.isArray(value) && value.length === 2 && value.every(n => Number.isFinite(n) && n > 0);
function metric(size, kind) {
  if (kind === 'width') return size[0];
  if (kind === 'height') return size[1];
  assert.equal(kind, 'sqrtArea', 'Unknown collection size metric');
  return Math.sqrt(size[0] * size[1]);
}
function projectedHeight(image, angle) {
  const points = image.uiVisibleHullPx;
  assert.ok(points?.length >= 3 && points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)), 'Missing UI silhouette');
  const radians = angle * Math.PI / 180;
  const ys = points.map(([x, y]) => Math.sin(radians) * x - Math.cos(radians) * y);
  const height = Math.max(...ys) - Math.min(...ys);
  assert.ok(height > 0, 'Empty UI silhouette');
  return height;
}

function computeCollectionSizes({ policy, baselines, catalog, config, readPng }) {
  assert.equal(policy.version, 1, 'Unsupported grade policy');
  assert.equal(baselines.version, 1, 'Unsupported collection baselines');
  assert.equal(baselines.gradeProgression, false, 'UI categories use fixed sizes without grade growth');
  assert.ok(Number.isInteger(policy.alphaThreshold) && policy.alphaThreshold > 0 && policy.alphaThreshold <= 255, 'Invalid alpha threshold');
  assert.ok(Number.isInteger(policy.scalePrecision) && policy.scalePrecision >= 8 && policy.scalePrecision <= 15, 'Invalid scale precision');
  const nodes = new Map(), parents = new Map();
  for (const node of Object.values(config.nodes)) {
    for (const key of [node.id, node.transform, ...node.components]) nodes.set(key, node);
    for (const child of node.children) parents.set(child, node);
  }
  const root = Object.values(config.roles).find(role => role.type === 'Gun_Collection_UI');
  assert.ok(root?.Gun_Item_list, 'Missing collection');
  const roles = new Map();
  for (const key of root.Gun_Item_list) {
    const role = config.roles[key];
    assert.ok(role?.type === 'Gun_Item_Collection' && !roles.has(role.GunNum), 'Invalid or duplicate collection card');
    roles.set(role.GunNum, role);
  }
  assert.equal(roles.size, catalog.length, 'Collection/catalog count mismatch');
  assert.equal(new Set(catalog.map(w => w.id)).size, catalog.length, 'Duplicate weapon ID');
  for (const [category, rule] of Object.entries(policy.categories)) {
    const reference = catalog.find(w => w.id === rule.referenceWeaponId), baseline = baselines.categories[category];
    assert.ok(reference && reference.category === category && reference.grade === rule.baseGrade, `Invalid reference for ${category}`);
    assert.equal(rule.baseGrade, Math.min(...catalog.filter(w => w.category === category).map(w => w.grade)), 'Reference must be lowest grade');
    assert.ok(pair(baseline?.referenceVisibleSize) && pair(baseline?.referenceLocalScale), `Invalid collection baseline: ${category}`);
    assert.equal(baseline.referenceLocalScale[0], baseline.referenceLocalScale[1], 'Collection scale must be uniform');
  }
  return catalog.map(weapon => {
    const rule = policy.categories[weapon.category], baseline = baselines.categories[weapon.category], role = roles.get(weapon.id);
    assert.ok(rule && baseline && role, `Missing collection weapon ${weapon.id}`);
    assert.ok(Number.isInteger(weapon.grade) && weapon.grade >= rule.baseGrade, 'Invalid weapon grade');
    const node = nodes.get(role.Shadow_img), foreground = nodes.get(role.Gun_img), card = nodes.get(role.node);
    assert.ok(node && foreground && card && parents.get(foreground.id) === node && parents.get(node.id) === card, 'Unexpected collection artwork hierarchy');
    assert.deepEqual(foreground.rect.scale, [1, 1], 'Unexpected foreground scale');
    assert.equal(foreground.rect.angle, 0, 'Unexpected foreground rotation');
    assert.deepEqual(foreground.rect.size, node.rect.size, 'Shadow and foreground must share their image box');
    assert.ok(pair(node.rect.size) && pair(node.rect.scale) && node.rect.scale[0] === node.rect.scale[1], 'Invalid collection artwork geometry');
    for (const part of [node, foreground]) assert.deepEqual(part.rect.min, part.rect.max, 'Collection artwork must use a fixed box');
    let angle = 0;
    for (let ancestor = node; ancestor; ancestor = parents.get(ancestor.id)) angle += ancestor.rect.angle;
    const image = config.images[config.gunIcons[weapon.id]];
    assert.ok(image && pair(image.sizePx), `Missing icon ${weapon.id}`);
    const pixels = pngAlpha(readPng(image.path), policy.alphaThreshold);
    assert.deepEqual([pixels.width, pixels.height], image.sizePx, 'PNG dimensions differ from registration');
    assert.ok(pixels.bounds, 'Empty weapon image');
    assert.deepEqual(pixels.bounds, image.uiVisibleBoundsPx, 'UI bounds differ from alpha measurement');
    // Match fitUiImage's existing slot fit, including frozen bow/glove frames.
    // Renderer tests independently verify these generated scales on real nodes.
    const reference = image.uiHeightReference && config.images[image.uiHeightReference];
    assert.ok(!image.uiHeightReference || reference, 'Missing UI height reference');
    const frame = reference?.uiHeightReferenceFrame;
    const baseSize = frame?.sizePx ?? image.sizePx;
    const heightScale = reference ? projectedHeight(frame ?? reference, angle) / projectedHeight(image, angle) : 1;
    const displayScale = Number.isFinite(image.uiDisplayScale) && image.uiDisplayScale > 0 ? image.uiDisplayScale : 1;
    const fit = Math.min(node.rect.size[0] / baseSize[0], node.rect.size[1] / baseSize[1]) * heightScale * displayScale;
    const raw = [0, 1].map(axis => (pixels.bounds[axis + 2] - pixels.bounds[axis]) * fit);
    const multiplier = 1;
    const targetSize = metric(baseline.referenceVisibleSize, rule.metric) * multiplier;
    const scale = Number((targetSize / metric(raw, rule.metric)).toFixed(policy.scalePrecision));
    let localScale = [scale, scale];
    if (weapon.id === rule.referenceWeaponId) {
      assert.ok(raw.every((n, axis) => Math.abs(n * baseline.referenceLocalScale[axis] - baseline.referenceVisibleSize[axis]) < 1e-8),
        `${weapon.category}: collection baseline geometry changed; review its size`);
      localScale = baseline.referenceLocalScale.slice();
    }
    assert.ok(pair(localScale), 'Invalid computed collection scale');
    const visibleSize = raw.map((n, axis) => n * localScale[axis]);
    return { id: weapon.id, category: weapon.category, grade: weapon.grade, multiplier, nodeId: node.id,
      localScale, currentLocalScale: node.rect.scale.slice(), visibleSize, targetSize,
      changed: localScale.some((n, axis) => n !== node.rect.scale[axis]) };
  });
}

function updateCollectionText(original, entries) {
  const expected = JSON.parse(original);
  let text = original;
  for (const entry of entries) {
    const node = expected.nodes[entry.nodeId];
    assert.ok(node && pair(entry.localScale), `Invalid node update ${entry.nodeId}`);
    if (entry.localScale.every((n, axis) => n === node.rect.scale[axis])) continue;
    const key = entry.nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('("' + key + '"\\s*:\\s*\\{[^{}]*"rect"\\s*:\\s*)(\\{[^{}]*\\})', 'g');
    let matches = 0;
    text = text.replace(pattern, (_, prefix, rect) => {
      matches++;
      assert.equal((rect.match(/"scale"\s*:/g) || []).length, 1, 'Ambiguous collection scale');
      return prefix + rect.replace(/"scale"\s*:\s*\[[^\]]*\]/, '"scale":' + JSON.stringify(entry.localScale));
    });
    assert.equal(matches, 1, `Expected one collection node ${entry.nodeId}`);
    node.rect.scale = entry.localScale.slice();
  }
  assert.deepEqual(JSON.parse(text), expected, 'Only collection Gun rect.scale may change');
  return text;
}

function syncWeaponCollectionSizes(projectRoot = path.resolve(__dirname, '..'), { write = false } = {}) {
  const read = relative => fs.readFileSync(path.join(projectRoot, relative), 'utf8');
  const policy = JSON.parse(read('tools/weapon-battle-size-policy.json'));
  const baselines = JSON.parse(read('tools/weapon-collection-size-baselines.json'));
  const match = read('assets/scripts/core/WeaponData.ts').match(/=\s*(\[[\s\S]*\]);/);
  assert.ok(match, 'Cannot read weapon catalog');
  const relative = 'assets/resources/art/weapon-system/config.json', original = read(relative);
  const entries = computeCollectionSizes({ policy, baselines, catalog: JSON.parse(match[1]), config: JSON.parse(original),
    readPng: resourcePath => fs.readFileSync(path.join(projectRoot, 'assets/resources', resourcePath + '.png')) });
  const changed = entries.filter(entry => entry.changed).map(entry => entry.id);
  if (write && changed.length) fs.writeFileSync(path.join(projectRoot, relative), updateCollectionText(original, entries));
  return { weapons: entries.length, changed, matches: changed.length === 0, entries };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length <= 1 && (!args.length || ['--check', '--write'].includes(args[0])), 'Use --check or --write');
    const write = args[0] === '--write', result = syncWeaponCollectionSizes(undefined, { write });
    console.log('Weapon collection sizes: ' + JSON.stringify({ weapons: result.weapons, changed: result.changed, mode: write ? 'write' : 'check' }));
    if (!write && !result.matches) {
      console.error('Collection sizes differ from policy. Run node tools/sync-weapon-collection-sizes.cjs --write.');
      process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { computeCollectionSizes, updateCollectionText, syncWeaponCollectionSizes };
