const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { pngAlpha } = require('./support/png-alpha.cjs');
const { computeInventorySizes, updateInventoryText, syncWeaponInventorySizes } = require('../tools/sync-weapon-inventory-sizes.cjs');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/weapon-system/config.json');
const raidConfig = require('../assets/resources/art/raid-system/config.json');
const policy = require('../tools/weapon-battle-size-policy.json');
const baselines = require('../tools/weapon-collection-size-baselines.json');
const layout = require('../tools/weapon-inventory-size-layout.json');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'assets/scripts/core/WeaponData.ts'), 'utf8').match(/=\s*(\[[\s\S]*\]);/)[1]);
const clone = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);
const measure = (size, metric) => metric === 'width' ? size[0] : metric === 'height' ? size[1] : Math.sqrt(size[0] * size[1]);
const nodeFor = (source, key) => source.nodes[key] || Object.values(source.nodes).find(node => node.transform === key || node.components.includes(key));
const buffers = new Map();
const readPng = resourcePath => {
  if (!buffers.has(resourcePath)) buffers.set(resourcePath, fs.readFileSync(path.join(root, 'assets/resources', resourcePath + '.png')));
  return buffers.get(resourcePath);
};
const compute = (overrides = {}) => computeInventorySizes({ policy, baselines, layout, catalog, config, readPng, ...overrides });

// Exercise the real pure renderer function in memory, without writing or
// depending on tests/.build. The generation tool has its own fit calculation.
const uiSource = fs.readFileSync(path.join(root, 'assets/scripts/view/OriginalWeaponUi.ts'), 'utf8');
const fitSource = uiSource.slice(uiSource.indexOf('function bowString'), uiSource.indexOf('export interface OriginalUiNode'));
assert.ok(fitSource.includes('export function fitUiImage'));
const runtime = { exports: {} };
vm.runInNewContext(ts.transpileModule(fitSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, runtime);
const { fitUiImage } = runtime.exports;

for (const [source, activeConfig, surfaceCounts] of [['weapon',config,{ Gun_Item:16,Gun_Slot:3,Gun_Info_UI:1,NewGun_UI:1 }],['raid',raidConfig,{ Gun_Item_Demo:20,Raid_GunSlot:3 }]]) {
test(source + ': all 65 weapons on all UI surfaces render at fixed category baseline sizes without grade growth', () => {
  const config = activeConfig, result = compute({ source, config }), parents = new Map();
  for (const node of Object.values(config.nodes)) for (const id of node.children) parents.set(id, node);
  assert.equal(layout.gradeProgression, false);
  assert.equal(result.entries.length, Object.keys(surfaceCounts).length * 65);
  assert.deepEqual(result.surfaceCounts, surfaceCounts);
  assert.equal(catalog.length, 65);
  for (const surface of Object.keys(surfaceCounts)) {
    assert.equal(result.displays[surface].length, 65);
    const role = Object.values(config.roles).find(role => role.type === surface);
    const shadow = nodeFor(config, role.Shadow_img);
    for (const weapon of catalog) {
      const display = result.displays[surface][weapon.id], image = config.images[config.gunIcons[weapon.id]];
      const { bounds } = pngAlpha(readPng(image.path), 16);
      let angle = display.angle;
      for (let ancestor = parents.get(shadow.id); ancestor; ancestor = parents.get(ancestor.id)) angle += ancestor.rect.angle;
      const fitted = fitUiImage(image, shadow.rect.size, shadow.rect.pivot, angle, config.images[image.uiHeightReference]);
      const size = [0, 1].map(axis => (bounds[axis + 2] - bounds[axis]) * fitted.size[axis] / image.sizePx[axis] * display.scale);
      const rule = policy.categories[weapon.category];
      const expected = measure(baselines.categories[weapon.category].referenceVisibleSize, rule.metric) * layout.surfaces[surface].collectionScale;
      near(measure(size, rule.metric), expected, `${surface}/${weapon.id}: measured PNG silhouette after actual renderer fit`);
      const reported = result.entries.find(entry => entry.id === weapon.id && entry.surface === surface);
      near(reported.targetSize, expected, `${surface}/${weapon.id}: reported target`);
      assert.equal(reported.multiplier, 1, 'inventory does not inherit collection grade growth');
      size.forEach((value, axis) => near(reported.visibleSize[axis], value, `${surface}/${weapon.id}: reported dimension ${axis}`));
      near(reported.targetSize, reported.collectionTargetSize * reported.collectionScale, 'all grades retain their fixed category size');
      assert.deepEqual(result.displays[surface][weapon.id], config.inventoryWeaponDisplays[surface][weapon.id], 'installed display matches generation');
    }
  }
});

test(source + ': staff angles and shadow gaps survive category changes', () => {
  const config = activeConfig, result = compute({ source, config });
  const rotate = ([x, y], angle) => {
    const radians = angle * Math.PI / 180;
    return [Math.cos(radians) * x - Math.sin(radians) * y, Math.sin(radians) * x + Math.cos(radians) * y];
  };
  for (const surface of Object.keys(surfaceCounts)) {
    const role = Object.values(config.roles).find(role => role.type === surface);
    const shadow = nodeFor(config, role.Shadow_img), foreground = nodeFor(config, role.Gun_img);
    for (const weapon of catalog) {
      const display = result.displays[surface][weapon.id];
      if (weapon.category === 'staff') {
        assert.equal(display.angle, -45);
      } else assert.equal(display.angle, shadow.rect.angle, 'other categories retain the surface authored angle');
      if (['Gun_Item','NewGun_UI','Gun_Item_Demo'].includes(surface)) {
        const before = rotate(foreground.rect.position, shadow.rect.angle).map(n => n * shadow.rect.scale[0]);
        const after = rotate(display.foregroundPosition, display.angle).map(n => n * display.scale);
        before.forEach((value, axis) => near(after[axis], value, `${weapon.id}: card-space foreground offset ${axis}`));
      } else assert.equal(Object.hasOwn(display, 'foregroundPosition'), false, 'sibling artwork keeps its authored offsets');
    }
  }
});

}

test('inventory computation is read-only and generated text changes only its top-level field, idempotently', () => {
  const input = { policy: clone(policy), baselines: clone(baselines), layout: clone(layout), catalog: clone(catalog), config: clone(config) };
  const before = clone(input), generated = computeInventorySizes({ ...input, readPng });
  assert.deepEqual(input, before);
  const source = clone(config);
  delete source.inventoryWeaponDisplays;
  source.unrelatedInventoryText = 'escaped "inventoryWeaponDisplays": { "example": true }';
  source.nestedInventoryExample = { inventoryWeaponDisplays: { untouched: true } };
  for (const original of [JSON.stringify(source) + '\n', JSON.stringify(source, null, 2).replace(/\n/g, '\r\n') + '\r\n']) {
    const updated = updateInventoryText(original, generated.displays);
    assert.deepEqual(JSON.parse(updated), { ...source, inventoryWeaponDisplays: generated.displays });
    const close = original.lastIndexOf('}');
    assert.equal(updated.slice(0, close), original.slice(0, close), 'adding the field preserves every preceding original byte');
    assert.equal(updateInventoryText(updated, generated.displays), updated);
    assert.deepEqual(compute({ config: JSON.parse(updated) }).displays, generated.displays, 'existing generated values never compound');
  }
  const oldValue = { Gun_Item: [{ scale: 123, angle: 45 }], Gun_Slot: [] };
  const prefix = '{ "nested": { "inventoryWeaponDisplays": [1] }, "inventoryWeaponDisplays" : ';
  const suffix = ', "other": ["a brace } and comma ,", true] }\r\n';
  const patched = updateInventoryText(prefix + JSON.stringify(oldValue) + suffix, generated.displays);
  assert.equal(patched, prefix + JSON.stringify(generated.displays) + suffix, 'replacement preserves all bytes outside the generated value');
});

test('sync checks never write and explicit sync updates only inventory metadata without changing authored config or artwork', t => {
  const parent = path.resolve(os.tmpdir()), fixture = fs.mkdtempSync(path.join(parent, 'forest-gunner-inventory-sizes-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('forest-gunner-inventory-sizes-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const configPath = 'assets/resources/art/weapon-system/config.json';
  const files = ['tools/weapon-battle-size-policy.json', 'tools/weapon-collection-size-baselines.json', 'tools/weapon-inventory-size-layout.json',
    'assets/scripts/core/WeaponData.ts', configPath, 'assets/resources/art/raid-system/config.json', 'assets/resources/art/weapon-system/visuals.json',
    ...catalog.map(weapon => `assets/resources/${config.images[config.gunIcons[weapon.id]].path}.png`)];
  for (const relative of files) {
    const destination = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  const input = clone(config); delete input.inventoryWeaponDisplays;
  fs.writeFileSync(path.join(fixture, configPath), JSON.stringify(input) + '\n');
  const before = new Map(files.map(relative => [relative, fs.readFileSync(path.join(fixture, relative))]));
  for (const options of [{}, { write: false }]) {
    const result = syncWeaponInventorySizes(fixture, options);
    assert.equal(result.weapons, 65); assert.equal(result.matches, false); assert.equal(result.changed.length, 260);
    for (const [relative, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), bytes, `${relative}: check is read-only`);
  }
  const result = syncWeaponInventorySizes(fixture, { write: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture, configPath), 'utf8')), { ...input, inventoryWeaponDisplays: Object.fromEntries(Object.keys(config.inventoryWeaponDisplays).map(key => [key, result.displays[key]])) });
  for (const [relative, bytes] of before) if (relative !== configPath) assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), bytes, `${relative}: untouched by sync`);
  const once = fs.readFileSync(path.join(fixture, configPath));
  const repeated = syncWeaponInventorySizes(fixture, { write: true });
  assert.equal(repeated.matches, true); assert.deepEqual(repeated.changed, []);
  assert.deepEqual(fs.readFileSync(path.join(fixture, configPath)), once);
  assert.equal(syncWeaponInventorySizes(fixture).matches, true);
});

test('unexpected host hierarchy, per-slot geometry, or reenabled inventory grade growth fail without mutation', () => {
  const roleFor = (input, surface, index = 0) => Object.values(input.config.roles).filter(role => role.type === surface)[index];
  const cases = [
    ['grade progression', input => { input.layout.gradeProgression = true; }],
    ['invalid surface factor', input => { input.layout.surfaces.Gun_Item.collectionScale = 0; }],
    ['unlisted backpack slot', input => { Object.values(input.config.roles).find(role => role.type === 'Gun_Item_List').Gun_Item_Pool.pop(); }],
    ['backpack foreground scale', input => { nodeFor(input.config, roleFor(input, 'Gun_Item').Gun_img).rect.scale = [2, 2]; }],
    ['backpack foreground detached', input => { nodeFor(input.config, roleFor(input, 'Gun_Item').Shadow_img).children = []; }],
    ['different later backpack image box', input => { const role = roleFor(input, 'Gun_Item', 15); for (const key of ['Gun_img', 'Shadow_img']) nodeFor(input.config, role[key]).rect.size[0] += 1; }],
    ['different later equipment angle', input => { const role = roleFor(input, 'Gun_Slot', 2); for (const key of ['Gun_img', 'Shadow_img']) nodeFor(input.config, role[key]).rect.angle += 1; }],
    ['rotated later card ancestor', input => { nodeFor(input.config, roleFor(input, 'Gun_Slot', 2).node).rect.angle = 15; }],
    ['unequal sibling scale', input => { nodeFor(input.config, roleFor(input, 'Gun_Slot').Gun_img).rect.scale = [.1, .1]; }],
    ['stretched artwork box', input => { nodeFor(input.config, roleFor(input, 'Gun_Slot').Gun_img).rect.max = [1, 1]; }],
  ];
  for (const [label, invalidate] of cases) {
    const input = { policy: clone(policy), baselines: clone(baselines), layout: clone(layout), catalog: clone(catalog), config: clone(config) };
    invalidate(input); const before = clone(input);
    assert.throws(() => computeInventorySizes({ ...input, readPng }), undefined, label);
    assert.deepEqual(input, before, `${label}: rejected input stays unchanged`);
  }
});
