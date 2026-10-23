'use strict';
// Adapt the fixed equipment UI baselines to all dynamic weapon previews.
// A single factor per surface preserves category proportions; grades never grow.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { pngAlpha } = require('./lib/png-alpha.cjs');

const sources = { weapon: ['Gun_Item', 'Gun_Slot', 'Gun_Info_UI', 'NewGun_UI'], raid: ['Gun_Item_Demo', 'Raid_GunSlot'] };
const surfaceNames = Object.values(sources).flat();
const nestedSurfaces = new Set(['Gun_Item', 'NewGun_UI', 'Gun_Item_Demo']);
const positivePair = value => Array.isArray(value) && value.length === 2 && value.every(n => Number.isFinite(n) && n > 0);
const finitePair = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
function metric(size, kind) {
  if (kind === 'width') return size[0];
  if (kind === 'height') return size[1];
  assert.equal(kind, 'sqrtArea', 'Unknown inventory size metric');
  return Math.sqrt(size[0] * size[1]);
}
function projectedHeight(image, angle) {
  const points = image.uiVisibleHullPx;
  assert.ok(positivePair(image.sizePx) && points?.length >= 3 && points.every(p => finitePair(p) &&
    p[0] >= 0 && p[1] >= 0 && p[0] <= image.sizePx[0] && p[1] <= image.sizePx[1]), 'Invalid UI silhouette');
  const radians = angle * Math.PI / 180;
  const ys = points.map(([x, y]) => Math.sin(radians) * x - Math.cos(radians) * y);
  const height = Math.max(...ys) - Math.min(...ys);
  assert.ok(height > 0, 'Empty UI silhouette');
  return height;
}
function rawVisibleSize(image, config, box, angle) {
  const reference = image.uiHeightReference && config.images[image.uiHeightReference];
  assert.ok(!image.uiHeightReference || reference, 'Missing UI height reference');
  const frame = reference?.uiHeightReferenceFrame;
  const baseSize = frame?.sizePx ?? image.sizePx;
  assert.ok(positivePair(baseSize), 'Invalid fit reference size');
  const heightScale = reference ? projectedHeight(frame ?? reference, angle) / projectedHeight(image, angle) : 1;
  const displayScale = Number.isFinite(image.uiDisplayScale) && image.uiDisplayScale > 0 ? image.uiDisplayScale : 1;
  const fit = Math.min(box[0] / baseSize[0], box[1] / baseSize[1]) * heightScale * displayScale;
  return [0, 1].map(axis => (image.uiVisibleBoundsPx[axis + 2] - image.uiVisibleBoundsPx[axis]) * fit);
}

function computeInventorySizes({ policy, baselines, layout, catalog, config, readPng, source = 'weapon' }) {
  assert.equal(layout.version, 1, 'Unsupported inventory layout');
  assert.equal(layout.gradeProgression, false, 'Inventory categories use a fixed size without grade growth');
  assert.deepEqual(Object.keys(layout.surfaces).sort(), surfaceNames.slice().sort(), 'Expected all UI surfaces');
  assert.equal(baselines.gradeProgression, false, 'UI categories use a fixed size');
  assert.ok(sources[source], 'Unknown UI config source');
  assert.deepEqual(catalog.map(w => w.id).sort((a, b) => a - b), Array.from({ length: catalog.length }, (_, id) => id), 'Dense weapon IDs required');
  for (const weapon of catalog) {
    const image = config.images[config.gunIcons[weapon.id]], rule = policy.categories[weapon.category];
    assert.ok(image && rule && positivePair(baselines.categories[weapon.category]?.referenceVisibleSize), 'Missing UI baseline or image');
    const pixels = pngAlpha(readPng(image.path), policy.alphaThreshold);
    assert.deepEqual([pixels.width, pixels.height], image.sizePx, 'PNG dimensions differ from registration');
    assert.deepEqual(pixels.bounds, image.uiVisibleBoundsPx, 'UI bounds differ from alpha measurement');
  }
  const nodes = new Map(), parents = new Map();
  for (const node of Object.values(config.nodes)) {
    for (const key of [node.id, node.transform, ...node.components]) nodes.set(key, node);
    for (const child of node.children) {
      assert.ok(!parents.has(child), `Multiple UI parents: ${child}`);
      parents.set(child, node);
    }
  }
  const rolesBySurface = Object.fromEntries(sources[source].map(surface =>
    [surface, Object.values(config.roles).filter(role => role.type === surface)]));
  if (source === 'weapon') {
    const list = Object.values(config.roles).find(role => role.type === 'Gun_Item_List');
    assert.ok(Array.isArray(list?.Gun_Item_Pool) && list.Gun_Item_Pool.length, 'Missing inventory pool');
    assert.deepEqual(list.Gun_Item_Pool.slice().sort(), Object.entries(config.roles).filter(([, r]) => r.type === 'Gun_Item').map(([key]) => key).sort(), 'Unlisted backpack card');
  }
  const displays = {}, entries = [], surfaceCounts = {};
  for (const surface of sources[source]) {
    assert.equal(layout.surfaces[surface].source, source, 'Wrong UI surface source');
    const collectionScale = layout.surfaces[surface].collectionScale;
    assert.ok(Number.isFinite(collectionScale) && collectionScale > 0, `Invalid ${surface} collectionScale`);
    const roles = rolesBySurface[surface];
    assert.ok(roles.length && roles.every(role => role?.type === surface), `Missing ${surface} roles`);
    assert.equal(new Set(roles.map(role => role.node)).size, roles.length, `Duplicate ${surface} card`);
    assert.equal(roles.length, Object.values(config.roles).filter(role => role.type === surface).length, `Unlisted ${surface} card`);
    surfaceCounts[surface] = roles.length;
    let template;
    for (const role of roles) {
      const foreground = nodes.get(role.Gun_img), shadow = nodes.get(role.Shadow_img), card = nodes.get(role.node);
      assert.ok(foreground && shadow && card, `Missing ${surface} artwork`);
      for (const node of [foreground, shadow]) {
        assert.ok(positivePair(node.rect.size) && positivePair(node.rect.scale) && finitePair(node.rect.position) &&
          finitePair(node.rect.pivot) && Number.isFinite(node.rect.angle), `Invalid ${surface} artwork geometry`);
        assert.deepEqual(node.rect.min, node.rect.max, `${surface} artwork must use a fixed box`);
        assert.equal(node.rect.scale[0], node.rect.scale[1], `${surface} artwork must scale uniformly`);
      }
      assert.deepEqual(foreground.rect.size, shadow.rect.size, `${surface} image boxes differ`);
      assert.deepEqual(foreground.rect.pivot, shadow.rect.pivot, `${surface} image pivots differ`);
      if (nestedSurfaces.has(surface)) {
        assert.equal(parents.get(foreground.id), shadow, 'Gun_Item foreground must be a shadow child');
        if (surface !== 'NewGun_UI') assert.equal(parents.get(shadow.id), card, 'Nested shadow must be a card child');
        assert.deepEqual(foreground.rect.scale, [1, 1], 'Gun_Item foreground scale must be one');
        assert.equal(foreground.rect.angle, 0, 'Gun_Item foreground angle must be zero');
      } else {
        assert.equal(parents.get(foreground.id), parents.get(shadow.id), 'Gun_Slot artwork must be siblings');
        assert.deepEqual(foreground.rect.scale, shadow.rect.scale, 'Gun_Slot authored scales differ');
        assert.equal(foreground.rect.angle, shadow.rect.angle, 'Gun_Slot authored angles differ');
      }
      const ancestors = [];
      for (let node = parents.get(shadow.id); node; node = parents.get(node.id)) {
        assert.ok(Number.isFinite(node.rect.angle), 'Invalid inventory ancestor angle');
        assert.ok(positivePair(node.rect.scale) && node.rect.scale[0] === node.rect.scale[1], 'UI ancestors must scale uniformly');
        ancestors.push({ id: node.id, angle: node.rect.angle, scale: node.rect.scale });
      }
      assert.ok(ancestors.some(node => node.id === card.id), `${surface} artwork must descend from its card`);
      const geometry = { foreground: foreground.rect, shadow: shadow.rect,
        ancestors: ancestors.map(({ angle, scale }) => ({ angle, scale })) };
      if (template) assert.deepEqual(geometry, template.geometry, `${surface} slots must share artwork geometry`);
      else template = { geometry, foreground, shadow, ancestorAngle: ancestors.reduce((sum, node) => sum + node.angle, 0) };
    }
    displays[surface] = [];
    for (const weapon of catalog.slice().sort((a, b) => a.id - b.id)) {
      const rule = policy.categories[weapon.category], baseline = baselines.categories[weapon.category];
      const image = config.images[config.gunIcons[weapon.id]];
      const angle = weapon.category === 'staff' ? -45 : template.shadow.rect.angle;
      const totalAngle = angle + template.ancestorAngle;
      const raw = rawVisibleSize(image, config, template.shadow.rect.size, totalAngle);
      const baselineTargetSize = metric(baseline.referenceVisibleSize, rule.metric);
      const targetSize = baselineTargetSize * collectionScale;
      const scale = Number((targetSize / metric(raw, rule.metric)).toFixed(policy.scalePrecision));
      assert.ok(Number.isFinite(scale) && scale > 0, 'Invalid generated inventory scale');
      const display = { scale, angle };
      if (nestedSurfaces.has(surface)) {
        const original = template.foreground.rect.position;
        // The foreground is a shadow child. Compensate both rotation and scale
        // so every weapon keeps the original card-space centre and shadow gap.
        const delta = (template.shadow.rect.angle - angle) * Math.PI / 180;
        const offsetScale = template.shadow.rect.scale[0] / scale;
        display.foregroundPosition = [Math.cos(delta) * original[0] - Math.sin(delta) * original[1],
          Math.sin(delta) * original[0] + Math.cos(delta) * original[1]]
          .map(n => Number((n * offsetScale).toFixed(policy.scalePrecision)));
      }
      displays[surface].push(display);
      entries.push({ id: weapon.id, surface, category: weapon.category, grade: weapon.grade, multiplier: 1,
        collectionMultiplier: 1, collectionScale, collectionTargetSize: baselineTargetSize,
        baselineTargetSize, targetSize, visibleSize: raw.map(n => n * scale), ...display });
    }
  }
  return { displays, entries, surfaceCounts };
}

// Locate a top-level value without serializing any other part of the asset.
function fieldRange(text, wanted) {
  let index = 0, found;
  const whitespace = () => { while (/\s/.test(text[index] ?? '') && index < text.length) index++; };
  const stringEnd = start => {
    let end = start + 1;
    while (end < text.length) { if (text[end] === '\\') end += 2; else if (text[end++] === '"') return end; else continue; }
    throw new Error('Unterminated JSON string');
  };
  whitespace(); assert.equal(text[index++], '{'); whitespace();
  while (text[index] !== '}') {
    assert.equal(text[index], '"');
    const end = stringEnd(index), key = JSON.parse(text.slice(index, end));
    index = end; whitespace(); assert.equal(text[index++], ':'); whitespace();
    const start = index; let depth = 0;
    while (index < text.length) {
      const ch = text[index];
      if (ch === '"') { index = stringEnd(index); continue; }
      if (depth === 0 && (ch === ',' || ch === '}')) break;
      if (ch === '{' || ch === '[') depth++;
      if (ch === '}' || ch === ']') depth--;
      index++;
    }
    let valueEnd = index; while (/\s/.test(text[valueEnd - 1] ?? '')) valueEnd--;
    if (key === wanted) { assert.equal(found, undefined, `Duplicate ${wanted} field`); found = { start, end: valueEnd }; }
    if (text[index] === ',') { index++; whitespace(); } else break;
  }
  assert.equal(text[index], '}');
  return { found, close: index };
}

function updateInventoryText(original, displays) {
  const expected = JSON.parse(original);
  assert.ok(Object.values(sources).some(names => isDeepStrictEqual(Object.keys(displays).sort(), names.slice().sort())), 'Expected all surfaces of one UI config');
  if (isDeepStrictEqual(expected.inventoryWeaponDisplays, displays)) return original;
  const { found, close } = fieldRange(original, 'inventoryWeaponDisplays');
  const value = JSON.stringify(displays);
  const text = found ? original.slice(0, found.start) + value + original.slice(found.end) :
    original.slice(0, close) + (Object.keys(expected).length ? ',' : '') + '\n"inventoryWeaponDisplays":' + value + '\n' + original.slice(close);
  expected.inventoryWeaponDisplays = displays;
  assert.deepEqual(JSON.parse(text), expected, 'Only inventoryWeaponDisplays may change');
  return text;
}

function syncWeaponInventorySizes(projectRoot = path.resolve(__dirname, '..'), { write = false } = {}) {
  const read = relative => fs.readFileSync(path.join(projectRoot, relative), 'utf8');
  const policy = JSON.parse(read('tools/weapon-battle-size-policy.json'));
  const baselines = JSON.parse(read('tools/weapon-collection-size-baselines.json'));
  const layout = JSON.parse(read('tools/weapon-inventory-size-layout.json'));
  const match = read('assets/scripts/core/WeaponData.ts').match(/=\s*(\[[\s\S]*\]);/);
  assert.ok(match, 'Cannot read weapon catalog');
  const catalog = JSON.parse(match[1]);
  // Validate both configurations completely before writing either one.
  const results = Object.entries(sources).map(([source, names]) => {
    const relative = 'assets/resources/art/' + (source === 'weapon' ? 'weapon-system' : 'raid-system') + '/config.json';
    const original = read(relative), config = JSON.parse(original);
    const result = computeInventorySizes({ policy, baselines, layout, catalog, config, source,
      readPng: resourcePath => fs.readFileSync(path.join(projectRoot, 'assets/resources', resourcePath + '.png')) });
    const changed = names.flatMap(surface => result.displays[surface].flatMap((display, id) =>
      isDeepStrictEqual(display, config.inventoryWeaponDisplays?.[surface]?.[id]) ? [] : [{ surface, id }]));
    return { relative, original, result, changed, matches: isDeepStrictEqual(config.inventoryWeaponDisplays, result.displays) };
  });
  const updates = results.map(item => ({ ...item, updated: updateInventoryText(item.original, item.result.displays) }));
  if (write) for (const item of updates) if (!item.matches) fs.writeFileSync(path.join(projectRoot, item.relative), item.updated);
  return { weapons: catalog.length, changed: results.flatMap(r => r.changed), matches: results.every(r => r.matches),
    displays: Object.assign({}, ...results.map(r => r.result.displays)), entries: results.flatMap(r => r.result.entries),
    surfaceCounts: Object.assign({}, ...results.map(r => r.result.surfaceCounts)) };

}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length <= 1 && (!args.length || ['--check', '--write'].includes(args[0])), 'Use --check or --write');
    const write = args[0] === '--write', result = syncWeaponInventorySizes(undefined, { write });
    console.log('Weapon inventory sizes: ' + JSON.stringify({ weapons: result.weapons, changed: result.changed.length, surfaces: result.surfaceCounts, mode: write ? 'write' : 'check' }));
    if (!write && !result.matches) {
      console.error('Inventory sizes differ from policy. Run node tools/sync-weapon-inventory-sizes.cjs --write.');
      process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { computeInventorySizes, updateInventoryText, syncWeaponInventorySizes };
