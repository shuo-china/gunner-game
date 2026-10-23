'use strict';
// Absolute targets are frozen in the policy; rerunning never compounds growth.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pngAlpha } = require('./lib/png-alpha.cjs');

function pair(value, positive = true) {
  return Array.isArray(value) && value.length === 2 && value.every(n =>
    Number.isFinite(n) && (positive ? n > 0 : n !== 0));
}
function metric(size, kind) {
  if (kind === 'width') return size[0];
  if (kind === 'height') return size[1];
  if (kind === 'sqrtArea') return Math.sqrt(size[0] * size[1]);
  throw new Error(`Unknown battle size metric: ${kind}`);
}

function computeBattleSizes({ policy, catalog, visuals, readPng }) {
  assert.equal(policy.version, 1, 'Unsupported battle size policy version');
  assert.ok(Number.isInteger(policy.alphaThreshold) && policy.alphaThreshold > 0 && policy.alphaThreshold <= 255, 'Invalid alpha threshold');
  assert.ok(Number.isFinite(policy.gradeStep) && policy.gradeStep > 0, 'Invalid grade step');
  assert.ok(Number.isInteger(policy.scalePrecision) && policy.scalePrecision >= 8 && policy.scalePrecision <= 15, 'Invalid scale precision');
  assert.ok(policy.categories && typeof policy.categories === 'object', 'Missing category policy');
  assert.ok(Array.isArray(catalog) && catalog.length > 0 && Array.isArray(visuals.weapons), 'Missing weapon catalog or appearances');
  const definitions = new Map(), appearances = new Map();
  for (const weapon of catalog) {
    assert.ok(Number.isInteger(weapon.id) && weapon.id >= 0 && !definitions.has(weapon.id), 'Invalid or duplicate weapon ID');
    assert.ok(Number.isInteger(weapon.grade) && weapon.grade >= 0, `Invalid weapon grade: ${weapon.id}`);
    assert.ok(Object.hasOwn(policy.categories, weapon.category), `Missing category policy: ${weapon.category}`);
    definitions.set(weapon.id, weapon);
  }
  for (const appearance of visuals.weapons) {
    assert.ok(definitions.has(appearance.id) && !appearances.has(appearance.id), `Invalid or duplicate appearance: ${appearance.id}`);
    appearances.set(appearance.id, appearance);
  }
  assert.equal(appearances.size, definitions.size, 'Appearance/catalog count mismatch');
  for (const [category, rule] of Object.entries(policy.categories)) {
    const reference = definitions.get(rule.referenceWeaponId);
    assert.ok(reference && reference.category === category && reference.grade === rule.baseGrade, `Invalid reference for ${category}`);
    assert.ok(pair(rule.referenceVisibleSize) && pair(rule.referenceLocalScale, false), `Invalid frozen reference size for ${category}`);
    metric(rule.referenceVisibleSize, rule.metric);
    const minimum = Math.min(...catalog.filter(w => w.category === category).map(w => w.grade));
    assert.equal(rule.baseGrade, minimum, `${category}: reference must be the lowest grade`);
  }

  return catalog.map(weapon => {
    const image = appearances.get(weapon.id).image, rule = policy.categories[weapon.category];
    assert.ok(image && typeof image.path === 'string' && pair(image.sizePx) && pair(image.sizeUnits) && pair(image.localScale, false), `Invalid image geometry: ${weapon.id}`);
    const pixels = pngAlpha(readPng(image.path), policy.alphaThreshold);
    assert.deepEqual([pixels.width, pixels.height], image.sizePx, `${weapon.id}: PNG size disagrees with registration`);
    assert.ok(pixels.bounds, `${weapon.id}: weapon has no visible pixels`);
    const raw = [0, 1].map(axis => (pixels.bounds[axis + 2] - pixels.bounds[axis]) / image.sizePx[axis] * image.sizeUnits[axis]);
    // Preserve the authored category proportions, including the crossbow's
    // existing 0.875 horizontal/vertical ratio and the vertical sprite flip.
    const shape = rule.referenceLocalScale.map(n => n / Math.abs(rule.referenceLocalScale[1]));
    const unitSize = raw.map((n, axis) => n * Math.abs(shape[axis]));
    const multiplier = 1 + policy.gradeStep * (weapon.grade - rule.baseGrade);
    const targetSize = metric(rule.referenceVisibleSize, rule.metric) * multiplier;
    const scalar = targetSize / metric(unitSize, rule.metric);
    let localScale = shape.map(n => Number((n * scalar).toFixed(policy.scalePrecision)));
    if (weapon.id === rule.referenceWeaponId) {
      const referenceSize = raw.map((n, axis) => n * Math.abs(rule.referenceLocalScale[axis]));
      assert.ok(referenceSize.every((n, axis) => Math.abs(n - rule.referenceVisibleSize[axis]) < 1e-9), `${weapon.category}: frozen reference artwork or geometry changed; review its baseline`);
      localScale = rule.referenceLocalScale.slice();
    }
    assert.ok(pair(localScale, false), `${weapon.id}: invalid computed scale`);
    const visibleSize = raw.map((n, axis) => n * Math.abs(localScale[axis]));
    if (weapon.category === 'glove') {
      assert.ok(visibleSize.every((n, axis) => n + 1e-8 >= rule.referenceVisibleSize[axis]), `${weapon.id}: glove would be smaller than the approved C reference`);
    }
    return { id: weapon.id, category: weapon.category, grade: weapon.grade, multiplier,
      localScale, currentLocalScale: image.localScale.slice(), visibleSize, targetSize,
      changed: localScale.some((n, axis) => n !== image.localScale[axis]) };
  });
}

function updateVisualsText(original, entries) {
  const expected = JSON.parse(original);
  let text = original;
  for (const entry of entries) {
    const appearance = expected.weapons.find(w => w.id === entry.id);
    assert.ok(appearance && pair(entry.localScale, false), `Invalid scale update: ${entry.id}`);
    if (entry.localScale.every((n, axis) => n === appearance.image.localScale[axis])) continue;
    const pattern = new RegExp('("id"\\s*:\\s*' + entry.id + '\\s*,\\s*"image"\\s*:\\s*)(\\{[^{}]+\\})', 'g');
    let matches = 0;
    text = text.replace(pattern, (_, prefix, image) => {
      matches++;
      assert.equal((image.match(/"localScale"\s*:/g) || []).length, 1, `${entry.id}: ambiguous scale field`);
      return prefix + image.replace(/"localScale"\s*:\s*\[[^\]]*\]/, '"localScale":' + JSON.stringify(entry.localScale));
    });
    assert.equal(matches, 1, `${entry.id}: expected one registered image`);
    appearance.image.localScale = entry.localScale.slice();
  }
  assert.deepEqual(JSON.parse(text), expected, 'Only battle image localScale may change');
  return text;
}

function syncWeaponBattleSizes(projectRoot = path.resolve(__dirname, '..'), { write = false } = {}) {
  const read = relative => fs.readFileSync(path.join(projectRoot, relative), 'utf8');
  const policy = JSON.parse(read('tools/weapon-battle-size-policy.json'));
  const match = read('assets/scripts/core/WeaponData.ts').match(/=\s*(\[[\s\S]*\]);/);
  assert.ok(match, 'Cannot read the authored weapon catalog');
  const relative = 'assets/resources/art/weapon-system/visuals.json';
  const original = read(relative);
  const entries = computeBattleSizes({ policy, catalog: JSON.parse(match[1]), visuals: JSON.parse(original),
    readPng: resourcePath => fs.readFileSync(path.join(projectRoot, 'assets/resources', resourcePath + '.png')) });
  const changed = entries.filter(entry => entry.changed).map(entry => entry.id);
  if (write && changed.length) fs.writeFileSync(path.join(projectRoot, relative), updateVisualsText(original, entries));
  return { weapons: entries.length, changed, matches: changed.length === 0, entries };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let write = false, mode, projectRoot = path.resolve(__dirname, '..');
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--check' || args[i] === '--write') {
        assert.ok(!mode, 'Choose exactly one of --check or --write');
        mode = args[i]; write = mode === '--write';
      } else if (args[i] === '--project') {
        assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), '--project requires a path');
        projectRoot = path.resolve(args[++i]);
      } else throw new Error(`Unknown argument: ${args[i]}`);
    }
    const result = syncWeaponBattleSizes(projectRoot, { write });
    console.log('Weapon battle sizes: ' + JSON.stringify({ weapons: result.weapons, changed: result.changed, mode: write ? 'write' : 'check' }));
    if (!write && !result.matches) {
      console.error('Battle sizes differ from policy. Run node tools/sync-weapon-battle-sizes.cjs --write to synchronize them.');
      process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { computeBattleSizes, updateVisualsText, syncWeaponBattleSizes };
