const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getWeaponCatalog } = require('./.build/session/core/WeaponCatalog.js');
const { computeCollectionSizes, updateCollectionText, syncWeaponCollectionSizes } = require('../tools/sync-weapon-collection-sizes.cjs');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/weapon-system/config.json');
const policy = require('../tools/weapon-battle-size-policy.json');
const baselines = require('../tools/weapon-collection-size-baselines.json');
const catalog = getWeaponCatalog();
const clone = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);
const buffers = new Map();
const readPng = resourcePath => {
  if (!buffers.has(resourcePath)) buffers.set(resourcePath, fs.readFileSync(path.join(root, 'assets/resources', resourcePath + '.png')));
  return buffers.get(resourcePath);
};
const nodeFor = (source, key) => source.nodes[key] || Object.values(source.nodes).find(node => node.transform === key || node.components.includes(key));
const roleFor = (source, id) => Object.values(source.roles).find(role => role.type === 'Gun_Item_Collection' && role.GunNum === id);
const compute = source => computeCollectionSizes({ policy, baselines, catalog, config: source, readPng });
const measure = (size, metric) => metric === 'width' ? size[0] : metric === 'height' ? size[1] : Math.sqrt(size[0] * size[1]);

// Shared equipment and collection baseline sizes, in card coordinates before
// artwork rotation and excluding the card's common 0.9 scale.
const accepted = {
  bow: { referenceVisibleSize: [52.58826733219382, 115.55876769992807], referenceLocalScale: [.07700000032782556, .07700000032782556] },
  crossbow: { referenceVisibleSize: [121.01920756369435, 105.86220309387745], referenceLocalScale: [.07000000029802322, .07000000029802322] },
  glove: { referenceVisibleSize: [112.21574917392452, 67.50478661243896], referenceLocalScale: [.08470000036060812, .08470000036060812] },
  staff: { referenceVisibleSize: [42.63022720852414, 133.90598975929052], referenceLocalScale: [.08820000037550926, .08820000037550926] },
  fan: { referenceVisibleSize: [86.07827063674634, 116.90205455176161], referenceLocalScale: [.07700000032782556, .07700000032782556] },
  handgun: { referenceVisibleSize: [128.5336829796613, 61.00329094542519], referenceLocalScale: [.047250000201165675, .047250000201165675] },
  cannon: { referenceVisibleSize: [171.37824397288176, 81.67244439332646], referenceLocalScale: [.0630000002682209, .0630000002682209] },
};

test('collection keeps the equipment category baselines at every grade, independently of battle growth', () => {
  assert.equal(baselines.version, 1);
  for (const [category, prior] of Object.entries(accepted)) {
    const current = baselines.categories[category], metric = policy.categories[category].metric;
    near(measure(current.referenceVisibleSize, metric), measure(prior.referenceVisibleSize, metric), `${category}: original UI target remains exact`);
    current.referenceVisibleSize.forEach((value, axis) => assert.ok(Math.abs(value / prior.referenceVisibleSize[axis] - 1) < .02, `${category}: minor raster rounding below two percent`));
  }
  assert.equal(baselines.gradeProgression, false);
  assert.deepEqual(computeCollectionSizes({ policy: { ...policy, gradeStep: .5 }, baselines, catalog, config, readPng }), compute(config), 'battle grade growth cannot affect UI');
  assert.equal(policy.alphaThreshold, 16);
  assert.deepEqual(Object.keys(policy.categories).sort(), Object.keys(accepted).sort());
  const entries = compute(config);
  assert.equal(entries.length, 65);
  assert.equal(new Set(entries.map(entry => entry.nodeId)).size, 65, 'each weapon owns a separate collection artwork parent');
  assert.ok(entries.every(entry => !entry.changed), 'installed collection scales match the policy');
  const grouped = new Map();
  for (const entry of entries) {
    const rule = policy.categories[entry.category], baseline = baselines.categories[entry.category];
    near(entry.multiplier, 1, `${entry.id}: no UI grade multiplier`);
    near(entry.targetSize, measure(baseline.referenceVisibleSize, rule.metric) * entry.multiplier, `${entry.id}: target uses UI units`);
    near(measure(entry.visibleSize, rule.metric), entry.targetSize, `${entry.id}: normalized size`);
    assert.equal(entry.localScale[0], entry.localScale[1], `${entry.id}: no artwork distortion`);
    const key = entry.category;
    if (grouped.has(key)) near(entry.targetSize, grouped.get(key), `${key}: all grades share the same size`);
    grouped.set(key, entry.targetSize);
    if (entry.id === rule.referenceWeaponId) {
      assert.deepEqual(entry.localScale, baseline.referenceLocalScale, `${entry.category}: accepted baseline scale remains exact`);
      entry.visibleSize.forEach((value, axis) => near(value, baseline.referenceVisibleSize[axis], `${entry.category}: accepted baseline dimension ${axis}`));
    }
  }
});

test('collection normalization repairs drifting baselines without mutating input or compounding growth', () => {
  const input = clone(config);
  for (const id of [0, 58]) nodeFor(input, roleFor(input, id).Shadow_img).rect.scale = [.1, .1];
  const before = clone(input), entries = compute(input);
  assert.deepEqual(input, before, 'computation is read-only');
  assert.deepEqual(entries.filter(entry => entry.changed).map(entry => entry.id), [0, 58]);
  assert.deepEqual(entries.find(entry => entry.id === 0).localScale, baselines.categories.bow.referenceLocalScale, 'a drifting D bow does not redefine the baseline');
  for (const entry of entries) {
    assert.deepEqual(entry.currentLocalScale, input.nodes[entry.nodeId].rect.scale);
    input.nodes[entry.nodeId].rect.scale = entry.localScale;
  }
  const repeated = compute(input);
  assert.ok(repeated.every(entry => !entry.changed));
  assert.deepEqual(repeated.map(entry => entry.localScale), entries.map(entry => entry.localScale));
});

test('collection text writes affect only the 65 artwork parent scales and preserve card layout, shadows and other UI', () => {
  const drifted = clone(config);
  for (const weapon of catalog) nodeFor(drifted, roleFor(drifted, weapon.id).Shadow_img).rect.scale = [.1, .1];
  const entries = compute(drifted);
  for (const original of [JSON.stringify(drifted) + '\n', JSON.stringify(drifted, null, 2).replace(/\n/g, '\r\n') + '\r\n']) {
    const updated = updateCollectionText(original, entries), expected = clone(drifted);
    for (const entry of entries) {
      const role = roleFor(expected, entry.id);
      assert.equal(nodeFor(expected, role.Shadow_img).id, entry.nodeId, 'only collection Shadow_img parents may be written');
      expected.nodes[entry.nodeId].rect.scale = entry.localScale;
    }
    assert.deepEqual(JSON.parse(updated), expected, 'image registrations, foreground offsets, angles, cards, hit boxes and other UI remain unchanged');
    const maskScales = text => text.replace(/"scale"\s*:\s*\[[^\]]*\]/g, '"scale":<scale>');
    assert.equal(maskScales(updated), maskScales(original), 'all bytes outside scale fields are unchanged');
    assert.equal(updateCollectionText(updated, entries), updated, 'repeat updates are byte-identical');
  }
});

test('collection sync checks are read-only and explicit writes preserve battle and Raid resources', t => {
  const parent = path.resolve(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(parent, 'forest-gunner-collection-sizes-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('forest-gunner-collection-sizes-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const configPath = 'assets/resources/art/weapon-system/config.json';
  const files = ['tools/weapon-battle-size-policy.json', 'tools/weapon-collection-size-baselines.json', 'assets/scripts/core/WeaponData.ts',
    configPath, 'assets/resources/art/weapon-system/visuals.json', 'assets/resources/art/raid-system/config.json',
    ...catalog.map(weapon => `assets/resources/${config.images[config.gunIcons[weapon.id]].path}.png`)];
  for (const relative of files) {
    const destination = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  const drifted = clone(config);
  nodeFor(drifted, roleFor(drifted, 58).Shadow_img).rect.scale = [.1, .1];
  fs.writeFileSync(path.join(fixture, configPath), JSON.stringify(drifted) + '\n');
  const before = new Map(files.map(relative => [relative, fs.readFileSync(path.join(fixture, relative))]));
  for (const options of [{}, { write: false }]) {
    const result = syncWeaponCollectionSizes(fixture, options);
    assert.equal(result.matches, false);
    assert.deepEqual(result.changed, [58]);
    for (const [relative, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), bytes, `${relative}: check does not write`);
  }
  const result = syncWeaponCollectionSizes(fixture, { write: true });
  assert.equal(result.weapons, 65);
  assert.deepEqual(result.changed, [58]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture, configPath), 'utf8')), config);
  for (const [relative, bytes] of before) if (relative !== configPath) {
    assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), bytes, `${relative}: only collection config is written`);
  }
  const after = fs.readFileSync(path.join(fixture, configPath));
  assert.deepEqual(syncWeaponCollectionSizes(fixture, { write: true }).changed, []);
  assert.deepEqual(fs.readFileSync(path.join(fixture, configPath)), after);
  assert.equal(syncWeaponCollectionSizes(fixture).matches, true);
});

test('collection generation rejects stale baselines and unexpected artwork hierarchy before any mutation', () => {
  const cases = [
    ['UI grade growth', input => { input.baselines.gradeProgression = true; }],
    ['stale frozen baseline', input => { input.baselines.categories.bow.referenceVisibleSize[1] *= 2; }],
    ['missing reference baseline', input => { delete input.baselines.categories.fan; }],
    ['duplicate collection card', input => { const role = Object.values(input.config.roles).find(role => role.type === 'Gun_Collection_UI'); role.Gun_Item_list[1] = role.Gun_Item_list[0]; }],
    ['detached foreground', input => { nodeFor(input.config, roleFor(input.config, 0).Shadow_img).children = []; }],
    ['unexpected foreground scale', input => { nodeFor(input.config, roleFor(input.config, 0).Gun_img).rect.scale = [2, 2]; }],
    ['stale alpha registration', input => { input.config.images[input.config.gunIcons[0]].uiVisibleBoundsPx[0] += 1; }],
  ];
  for (const [label, invalidate] of cases) {
    const input = { policy: clone(policy), baselines: clone(baselines), catalog: clone(catalog), config: clone(config) };
    invalidate(input);
    const before = clone(input);
    assert.throws(() => computeCollectionSizes({ ...input, readPng }), undefined, label);
    assert.deepEqual(input, before, `${label}: invalid input remains untouched`);
  }
});
