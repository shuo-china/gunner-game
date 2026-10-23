const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { synchronize, tint, readCatalog, policy } = require('../tools/sync-weapon-effect-colors.cjs');
const visuals = require('../assets/resources/art/weapon-system/visuals.json');
const gradeEffects = require('../assets/resources/art/weapon-grade-effects/config.json');
const catalog = readCatalog(), grades = Object.keys(policy);
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const neutral = c => { close(c[0], c[1]); close(c[1], c[2]); };

test('all 65 weapons bind the right family and grade, with complete projectile and release assets', () => {
  assert.equal(catalog.length, 65);
  for (const weapon of catalog) {
    const appearance = visuals.weapons.find(w => w.id === weapon.id), grade = grades[weapon.grade];
    assert.ok(appearance, weapon.name);
    if (['bow', 'crossbow'].includes(weapon.category)) assert.equal(appearance.projectileSkin, `arrow-${grade}`);
    if (weapon.category === 'glove') assert.equal(appearance.projectileSkin, `shuriken-${grade}`);
    assert.ok(visuals.projectileSkins[appearance.projectileSkin].some(p => p.kind === 'hit'), weapon.name);
    assert.ok(visuals.muzzleSkins[appearance.muzzleSkin], weapon.name);
    const custom = visuals.customProjectiles[appearance.projectileSkin];
    if (custom) rgb(policy[grade].theme1).forEach((c, i) => close(custom.bodyPalette.mid[i], c));
    for (const p of visuals.projectileSkins[appearance.projectileSkin])
      assert.ok(fs.existsSync(path.join(__dirname, '../assets/resources', p.image.path + '.png')), p.image.path);
    if (weapon.category === 'staff') rgb(policy[grade].theme1).forEach((c, i) => {
      close(appearance.castColor[i], c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    });
  }
});

test('both C crossbows and C bows emit silver arrows, neutral pressure fronts and neutral impact glows', () => {
  for (const id of [2, 3, 61, 63]) {
    const key = visuals.weapons.find(w => w.id === id).projectileSkin, p = visuals.customProjectiles[key];
    neutral(p.bodyPalette.mid); neutral(p.airFlow.innerColor);
    for (const spec of visuals.projectileSkins[key]) {
      neutral(spec.startColor); neutral(spec.materialColor);
      for (const stop of spec.gradient?.colors ?? []) neutral(stop.slice(1));
    }
  }
  neutral(visuals.customProjectiles['shuriken-C'].cometTrail.innerColor);
});

test('S and SS handguns keep separate gold and red muzzle definitions in a mixed squad', () => {
  const s = visuals.weapons.find(w => w.id === 18), ss = visuals.weapons.find(w => w.id === 22);
  assert.notEqual(s.muzzleSkin, ss.muzzleSkin);
  assert.notDeepEqual(visuals.muzzleSkins[s.muzzleSkin], visuals.muzzleSkins[ss.muzzleSkin]);
  const strip = value => JSON.parse(JSON.stringify(value, (key, v) => key === 'colors' ? undefined : v));
  assert.deepEqual(strip(visuals.muzzleSkins[s.muzzleSkin]), strip(visuals.muzzleSkins[ss.muzzleSkin]));
});

test('FX synchronization is idempotent across all projectiles, muzzles, staff casts and grade auras', () => {
  const v = structuredClone(visuals), g = structuredClone(gradeEffects);
  synchronize(v, g, catalog);
  assert.deepEqual(v, visuals); assert.deepEqual(g, gradeEffects);
  synchronize(v, g, catalog);
  assert.deepEqual(v, visuals); assert.deepEqual(g, gradeEffects);
});

test('tinting preserves smoke, grayscale HDR, alpha and colored HDR intensity without repeated drift', () => {
  const gold = rgb(policy.S.theme1);
  for (const color of [[1, 1, 1, .3], [2.5, 2.5, 2.5, 1], [.24, .27, .31, .8], [0, 0, 0, 0]])
    assert.deepEqual(tint(color, gold), color);
  for (const color of [[1, 0, .4, .5333334], [4, .2, .3, .27]]) {
    const changed = tint(color, gold);
    assert.equal(changed[3], color[3]); assert.equal(Math.max(...changed.slice(0, 3)), Math.max(...color.slice(0, 3)));
    assert.equal(Math.min(...changed.slice(0, 3)), Math.min(...color.slice(0, 3)));
    assert.deepEqual(tint(changed, gold), changed);
  }
});
