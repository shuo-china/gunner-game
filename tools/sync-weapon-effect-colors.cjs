// Match combat FX to the reviewed 2026-10-14 weapon grade palette.
// Recolor numeric tints only: textures, alpha, HDR strength and motion stay intact.
const fs = require('node:fs');
const path = require('node:path');
const policy = require('./weapon-effect-color-policy.json');
const root = path.resolve(__dirname, '..');
// Numeric catalog grades must not depend on JSON property ordering.
const grades = ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS', 'X', 'XX', 'XXX', 'Z', 'ZZ', 'ZZZ'];
const round = n => Math.round(n * 1e7) / 1e7;
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;

// Particle colors are already linear, unlike the custom body's sRGB palette.
// Preserve near-neutral smoke/highlights and the original color's min/max,
// including HDR values. Hue remapping is idempotent, so repeated builds are safe.
function tint(color, primary) {
  const hi = round(Math.max(...color.slice(0, 3))), lo = round(Math.min(...color.slice(0, 3)));
  if (hi === 0 || (hi - lo) / hi < .25) return color.slice();
  const target = primary.map(linear), max = Math.max(...target), min = Math.min(...target);
  const neutral = max - min < .025;
  return [...target.map(c => round(neutral ? hi : lo + (hi - lo) * (c - min) / (max - min))), ...color.slice(3)];
}
function particleColors(spec, primary) {
  for (const key of ['materialColor', 'startColor', 'startColorMin'])
    if (spec[key]) spec[key] = tint(spec[key], primary);
  if (spec.gradient) spec.gradient.colors = spec.gradient.colors.map(([time, ...c]) => [time, ...tint(c, primary)]);
  if (spec.mesh?.colors) spec.mesh.colors = spec.mesh.colors.map(c => tint(c, primary));
  // Grade trails use Unity's serialized Color objects.
  function trailColors(value) {
    if (!value || typeof value !== 'object') return;
    if (['r', 'g', 'b'].every(k => typeof value[k] === 'number'))
      [value.r, value.g, value.b] = tint([value.r, value.g, value.b], primary);
    else Object.values(value).forEach(trailColors);
  }
  if (spec.trail) trailColors(spec.trail);
}
function synchronize(visuals, gradeEffects, catalog) {
  const projectileGrades = new Map(), muzzleGrades = new Map();
  // S handgun historically borrowed SS's muzzle. Split before recoloring so
  // equipping S and SS together never changes the other weapon's effect.
  const sHandgun = visuals.weapons.find(w => catalog[w.id].category === 'handgun' && catalog[w.id].grade === 4);
  if (sHandgun && sHandgun.muzzleSkin !== 'handgun-S-muzzle') {
    visuals.muzzleSkins['handgun-S-muzzle'] = structuredClone(visuals.muzzleSkins[sHandgun.muzzleSkin]);
    sHandgun.muzzleSkin = 'handgun-S-muzzle';
  }
  for (const appearance of visuals.weapons) {
    const weapon = catalog[appearance.id], grade = grades[weapon.grade], primary = rgb(policy[grade].theme1);
    for (const [map, key] of [[projectileGrades, appearance.projectileSkin], [muzzleGrades, appearance.muzzleSkin]]) {
      if (key === 'none') continue;
      if (map.has(key) && map.get(key) !== grade) throw new Error(`Cross-grade shared effect: ${key}`);
      map.set(key, grade);
    }
    if (weapon.category === 'staff') appearance.castColor = primary.map(linear).map(round);
  }
  for (const [key, grade] of projectileGrades) {
    const primary = rgb(policy[grade].theme1);
    if (!visuals.projectileSkins[key]) throw new Error(`Missing projectile: ${key}`);
    visuals.projectileSkins[key].forEach(spec => particleColors(spec, primary));
    const custom = visuals.customProjectiles?.[key];
    if (custom) {
      custom.bodyPalette = {
        shadow: primary.map(c => round(c * .68)), mid: primary.map(round),
        highlight: primary.map(c => round(c + (1 - c) * .4)),
        strength: custom.bodyPalette?.strength ?? .94,
      };
      // These colors feed linear mesh vertices directly. Keep the existing
      // opacity and make the inner light a pale version of the same hue.
      const light = primary.map(c => round(linear(c + (1 - c) * .65)));
      if (custom.airFlow) custom.airFlow.innerColor = [...light, custom.airFlow.innerColor[3]];
      if (custom.cometTrail) {
        custom.cometTrail.outerColor = [...primary.map(linear).map(round), custom.cometTrail.outerColor[3]];
        custom.cometTrail.innerColor = [...light, custom.cometTrail.innerColor[3]];
      }
    }
  }
  for (const [key, grade] of muzzleGrades)
    visuals.muzzleSkins[key].particleSystems.forEach(spec => particleColors(spec, rgb(policy[grade].theme1)));
  for (const entry of gradeEffects.grades)
    entry.systems.forEach(spec => particleColors(spec, rgb(policy[grades[entry.grade]].theme1)));
  return { weapons: visuals.weapons.length, projectileSkins: projectileGrades.size, muzzleSkins: muzzleGrades.size, grades: grades.length };
}
function readCatalog() {
  const source = fs.readFileSync(path.join(root, 'assets/scripts/core/WeaponData.ts'), 'utf8');
  return JSON.parse(source.match(/= (\[[\s\S]*\]);/)[1]);
}
if (require.main === module) {
  const files = ['assets/resources/art/weapon-system/visuals.json', 'assets/resources/art/weapon-grade-effects/config.json'];
  const input = files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  const data = input.map(JSON.parse), before = data.map(v => JSON.stringify(v));
  const report = synchronize(...data, readCatalog());
  const changed = files.filter((_, i) => before[i] !== JSON.stringify(data[i]));
  if (process.argv.includes('--write')) {
    files.forEach((file, i) => {
      if (changed.includes(file)) fs.writeFileSync(path.join(root, file), JSON.stringify(data[i]) + '\n');
    });
  } else if (changed.length) {
    console.error('Weapon FX colors need synchronization: ' + changed.join(', ')); process.exitCode = 1;
  }
  console.log(JSON.stringify({ ...report, changed, mode: process.argv.includes('--write') ? 'write' : 'check' }));
}
module.exports = { synchronize, tint, particleColors, readCatalog, policy };
