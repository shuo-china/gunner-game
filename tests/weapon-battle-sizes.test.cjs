const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getWeaponCatalog } = require('./.build/session/core/WeaponCatalog.js');
const { pngAlpha } = require('./support/png-alpha.cjs');
const { computeBattleSizes, updateVisualsText, syncWeaponBattleSizes } = require('../tools/sync-weapon-battle-sizes.cjs');
const root = path.resolve(__dirname, '..');
const policy = require('../tools/weapon-battle-size-policy.json');
const visuals = require('../assets/resources/art/weapon-system/visuals.json');
const catalog = getWeaponCatalog();
const clone = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);
const resourceFile = resourcePath => path.join(root, 'assets/resources', resourcePath + '.png');
const pngBuffers = new Map();
const readPng = resourcePath => {
  if (!pngBuffers.has(resourcePath)) pngBuffers.set(resourcePath, fs.readFileSync(resourceFile(resourcePath)));
  return pngBuffers.get(resourcePath);
};
const visibleSize = image => {
  const { bounds } = pngAlpha(readPng(image.path), 16);
  return [0, 1].map(axis => (bounds[axis + 2] - bounds[axis]) * image.sizeUnits[axis] /
    image.sizePx[axis] * Math.abs(image.localScale[axis]));
};

// Accepted battle sizes before grade normalization. These values intentionally
// do not come from the policy or its output, so regenerating both cannot move a baseline unnoticed.
const accepted = {
  bow: { referenceWeaponId: 0, baseGrade: 0, metric: 'height', referenceVisibleSize: [3.4913593750000005, 7.672], referenceLocalScale: [.42, -.42] },
  crossbow: { referenceWeaponId: 1, baseGrade: 0, metric: 'width', referenceVisibleSize: [6.492255, 6.4904399999999995], referenceLocalScale: [.4032, -.4608] },
  glove: { referenceWeaponId: 4, baseGrade: 1, metric: 'sqrtArea', referenceVisibleSize: [5.479774843859345, 3.2964270545091376], referenceLocalScale: [.4, -.4] },
  staff: { referenceWeaponId: 8, baseGrade: 2, metric: 'height', referenceVisibleSize: [2.74405097704116, 8.619350308251988], referenceLocalScale: [.38, -.38] },
  fan: { referenceWeaponId: 13, baseGrade: 3, metric: 'height', referenceVisibleSize: [5.0608076277171, 6.87303317079882], referenceLocalScale: [.62073, -.62073] },
  handgun: { referenceWeaponId: 18, baseGrade: 4, metric: 'width', referenceVisibleSize: [7.7732822779942365, 3.689272643657421], referenceLocalScale: [.4356, -.4356] },
  cannon: { referenceWeaponId: 23, baseGrade: 5, metric: 'width', referenceVisibleSize: [8.01090028649212, 3.8176946677814008], referenceLocalScale: [.552, -.552] },
};
const measure = (size, metric) => metric === 'width' ? size[0] : metric === 'height' ? size[1] : Math.sqrt(size[0] * size[1]);

test('battle size policy freezes the seven approved references and the linear three-percent rule', () => {
  assert.equal(policy.version, 1);
  assert.equal(policy.alphaThreshold, 16);
  assert.equal(policy.gradeStep, .03);
  assert.equal(policy.scalePrecision, 12);
  assert.deepEqual(Object.keys(policy.categories).sort(), Object.keys(accepted).sort());
  for (const [category, expected] of Object.entries(accepted)) {
    const actual = policy.categories[category];
    for (const field of ['referenceWeaponId', 'baseGrade', 'metric', 'referenceLocalScale']) {
      assert.deepEqual(actual[field], expected[field], `${category}: frozen ${field}`);
    }
    near(measure(actual.referenceVisibleSize, actual.metric), measure(expected.referenceVisibleSize, actual.metric), `${category}: frozen size target survives downsampling`);
    actual.referenceVisibleSize.forEach((value, axis) => assert.ok(Math.abs(value / expected.referenceVisibleSize[axis] - 1) < .02, `${category}: raster rounding stays below two percent on axis ${axis}`));
    const reference = catalog.find(weapon => weapon.id === expected.referenceWeaponId);
    assert.equal(reference.category, category);
    assert.equal(reference.grade, expected.baseGrade);
    const image = visuals.weapons.find(weapon => weapon.id === reference.id).image;
    assert.deepEqual(image.localScale, expected.referenceLocalScale, `${category}: baseline image scale is unchanged`);
    visibleSize(image).forEach((value, axis) => near(value, actual.referenceVisibleSize[axis], `${category}: actual baseline alpha16 dimension ${axis}`));
  }
});

test('all 65 actual silhouettes use equal same-grade sizes and additive grade growth without changing aspect or flip', () => {
  const sizes = new Map();
  for (const weapon of catalog) {
    const image = visuals.weapons.find(entry => entry.id === weapon.id).image;
    const base = accepted[weapon.category], size = visibleSize(image);
    const value = measure(size, base.metric), baseline = measure(base.referenceVisibleSize, base.metric);
    near(value, baseline * (1 + .03 * (weapon.grade - base.baseGrade)), `${weapon.id}: grade target from actual PNG alpha16`);
    assert.equal(Math.sign(image.localScale[0]), Math.sign(base.referenceLocalScale[0]), `${weapon.id}: horizontal orientation`);
    assert.equal(Math.sign(image.localScale[1]), Math.sign(base.referenceLocalScale[1]), `${weapon.id}: vertical orientation`);
    near(image.localScale[0] / image.localScale[1], base.referenceLocalScale[0] / base.referenceLocalScale[1], `${weapon.id}: authored aspect correction`);
    if (weapon.category === 'glove') size.forEach((dimension, axis) => assert.ok(dimension + 1e-8 >= policy.categories.glove.referenceVisibleSize[axis], `${weapon.id}: C glove dimension ${axis} floor`));
    const key = `${weapon.category}:${weapon.grade}`;
    if (sizes.has(key)) near(value, sizes.get(key), `${key}: same-grade silhouettes have the same size`);
    sizes.set(key, value);
  }
  assert.equal(catalog.length, 65);
  for (const [category, base] of Object.entries(accepted)) {
    const grades = [...new Set(catalog.filter(weapon => weapon.category === category).map(weapon => weapon.grade))].sort((a, b) => a - b);
    for (let index = 1; index < grades.length; index++) {
      const current = grades[index], previous = grades[index - 1];
      near(sizes.get(`${category}:${current}`) - sizes.get(`${category}:${previous}`),
        measure(base.referenceVisibleSize, base.metric) * .03 * (current - previous), `${category}: each grade adds the same baseline increment`);
    }
  }
});

test('size computation repairs scale drift from frozen references without mutating inputs or compounding on rerun', () => {
  const input = { policy: clone(policy), catalog: clone(catalog), visuals: clone(visuals) };
  input.visuals.weapons.find(weapon => weapon.id === 0).image.localScale = [.84, -.84];
  input.visuals.weapons.find(weapon => weapon.id === 64).image.localScale = [.2, -.7];
  const before = clone(input);
  const entries = computeBattleSizes({ ...input, readPng });
  assert.deepEqual(input, before, 'calculating sizes must not edit policy, catalog or visuals');
  assert.deepEqual(entries.filter(entry => entry.changed).map(entry => entry.id).sort((a, b) => a - b), [0, 64]);
  assert.deepEqual(entries.find(entry => entry.id === 0).localScale, [.42, -.42], 'a drifting reference does not redefine its accepted size');
  for (const entry of entries) {
    const appearance = input.visuals.weapons.find(weapon => weapon.id === entry.id);
    assert.deepEqual(entry.currentLocalScale, appearance.image.localScale);
    appearance.image.localScale = entry.localScale;
    visibleSize(appearance.image).forEach((value, axis) => near(entry.visibleSize[axis], value, `${entry.id}: reported visible size ${axis}`));
    const base = accepted[entry.category];
    near(entry.targetSize, measure(base.referenceVisibleSize, base.metric) * (1 + .03 * (entry.grade - base.baseGrade)), `${entry.id}: reported target`);
  }
  const again = computeBattleSizes({ ...input, readPng });
  assert.ok(again.every(entry => !entry.changed), 'normalized values do not drift on repeated computation');
  assert.deepEqual(again.map(entry => entry.localScale), entries.map(entry => entry.localScale));
});

test('visuals text updates only battle image localScale and preserve all other registrations and formatting', () => {
  const drifted = clone(visuals);
  drifted.weapons.find(weapon => weapon.id === 58).image.localScale = [.2, -.2];
  const entries = computeBattleSizes({ policy, catalog, visuals: drifted, readPng });
  for (const original of [JSON.stringify(drifted) + '\n', JSON.stringify(drifted, null, 2).replace(/\n/g, '\r\n') + '\r\n']) {
    const updated = updateVisualsText(original, entries), parsed = JSON.parse(updated);
    const expected = clone(drifted);
    for (const entry of entries) expected.weapons.find(weapon => weapon.id === entry.id).image.localScale = entry.localScale;
    assert.deepEqual(parsed, expected, 'muzzle, grips, art, animation and projectile settings remain intact');
    const maskScaleFields = text => text.replace(/"localScale"\s*:\s*\[[^\]]*\]/g, '"localScale":<scale>');
    assert.equal(maskScaleFields(updated), maskScaleFields(original), 'all bytes outside scale fields, including whitespace, are preserved');
    assert.equal(updateVisualsText(updated, entries), updated, 'text updates are idempotent');
  }
});

test('sync check detects drift without writing and explicit write is limited and idempotent', t => {
  const parent = path.resolve(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(parent, 'forest-gunner-battle-sizes-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('forest-gunner-battle-sizes-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const files = ['tools/weapon-battle-size-policy.json', 'assets/scripts/core/WeaponData.ts',
    'assets/resources/art/weapon-system/visuals.json',
    ...visuals.weapons.map(weapon => `assets/resources/${weapon.image.path}.png`)];
  for (const relative of files) {
    const destination = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  const visualsFile = path.join(fixture, 'assets/resources/art/weapon-system/visuals.json');
  const drifted = clone(visuals);
  drifted.weapons.find(weapon => weapon.id === 58).image.localScale = [.2, -.2];
  fs.writeFileSync(visualsFile, JSON.stringify(drifted) + '\n');
  const before = new Map(files.map(relative => [relative, fs.readFileSync(path.join(fixture, relative))]));
  const snapshot = syncWeaponBattleSizes(fixture, { write: false });
  assert.equal(snapshot.weapons, 65);
  assert.equal(snapshot.matches, false);
  assert.deepEqual(snapshot.changed, [58]);
  const cli = args => spawnSync(process.execPath, [path.join(root, 'tools/sync-weapon-battle-sizes.cjs'), '--project', fixture, ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true });
  for (const args of [[], ['--check']]) {
    const result = cli(args);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    for (const [relative, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), bytes, `${relative}: checks never write`);
  }
  const written = cli(['--write']);
  assert.equal(written.status, 0, written.stderr || written.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(visualsFile, 'utf8')), visuals, 'explicit write restores only the drifting battle scale');
  for (const [relative, bytes] of before) if (!relative.endsWith('/visuals.json')) {
    assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), bytes, `${relative}: synchronization leaves source art, catalog and policy unchanged`);
  }
  const after = fs.readFileSync(visualsFile);
  const repeated = cli(['--write']);
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.deepEqual(fs.readFileSync(visualsFile), after, 'repeat writes leave normalized content byte-identical');
  const check = cli(['--check']);
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.equal(syncWeaponBattleSizes(fixture, { write: false }).matches, true);
});

test('invalid catalogs and size policies fail instead of producing partial output', () => {
  const cases = [
    ['duplicate catalog ID', input => { input.catalog[1].id = input.catalog[0].id; }],
    ['missing catalog entry', input => { input.catalog.pop(); }],
    ['unknown category', input => { input.catalog[0].category = 'unknown'; }],
    ['fractional grade', input => { input.catalog[0].grade = .5; }],
    ['unsupported policy version', input => { input.policy.version = 99; }],
    ['negative grade increment', input => { input.policy.gradeStep = -.03; }],
    ['invalid alpha threshold', input => { input.policy.alphaThreshold = 0; }],
    ['missing category rule', input => { delete input.policy.categories.bow; }],
    ['missing reference', input => { input.policy.categories.bow.referenceWeaponId = 999; }],
    ['wrong baseline grade', input => { input.policy.categories.bow.baseGrade = 1; }],
    ['unknown metric', input => { input.policy.categories.bow.metric = 'diagonal'; }],
    ['nonpositive reference size', input => { input.policy.categories.bow.referenceVisibleSize[0] = 0; }],
    ['stale reference dimensions', input => { input.policy.categories.bow.referenceVisibleSize[1] *= 2; }],
  ];
  for (const [label, invalidate] of cases) {
    const input = { policy: clone(policy), catalog: clone(catalog), visuals: clone(visuals) };
    invalidate(input);
    const before = clone(input);
    assert.throws(() => computeBattleSizes({ ...input, readPng }), undefined, label);
    assert.deepEqual(input, before, `${label}: rejected input stays untouched`);
  }
});
