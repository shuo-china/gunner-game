'use strict';
// Selected audio is a persistent overlay over the original resource exporters.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { compactJson } = require('./optimize-resource-data.cjs');

function syncWeaponAudio(project = path.resolve(__dirname, '..')) {
  const resources = path.join(project, 'assets/resources');
  const read = relative => JSON.parse(fs.readFileSync(path.join(resources, relative), 'utf8'));
  const selected = JSON.parse(fs.readFileSync(path.join(project, 'tools/weapon-audio-selected-sources.json'), 'utf8'));
  const sfx = read('art/original-sfx/config.json');
  const visuals = read('art/weapon-system/visuals.json');
  const catalogSource = fs.readFileSync(path.join(project, 'assets/scripts/core/WeaponData.ts'), 'utf8');
  const data = catalogSource.match(/=\s*(\[[\s\S]*\]);/);
  if (!data) throw new Error('Cannot read the authored weapon catalog.');
  const catalog = JSON.parse(data[1]);
  if (selected.version !== 1 || selected.selections.length !== 6) throw new Error('Incomplete selected weapon audio.');
  const original = sfx.entries.find(entry => entry.id === selected.flintlock.soundId);
  if (!original || original.path !== selected.flintlock.resourcePath || original.volume !== selected.flintlock.volume) {
    throw new Error('Original flintlock audio mapping changed unexpectedly.');
  }
  for (const entry of [selected.flintlock, ...selected.selections]) {
    const wav = path.join(resources, entry.resourcePath + '.wav');
    if (crypto.createHash('sha256').update(fs.readFileSync(wav)).digest('hex') !== entry.wavSha256) {
      throw new Error(`Selected audio bytes changed: ${entry.resourcePath}`);
    }
  }
  const categories = new Map([[selected.flintlock.weaponCategory, selected.flintlock.soundId]]);
  const ids = new Set(sfx.entries.filter(entry => entry.id < 17).map(entry => entry.id));
  for (const entry of selected.selections) {
    if (categories.has(entry.weaponCategory) || ids.has(entry.soundId) || entry.volume !== 1) {
      throw new Error(`Conflicting selected audio mapping: ${entry.id}`);
    }
    categories.set(entry.weaponCategory, entry.soundId); ids.add(entry.soundId);
    const config = { id: entry.soundId, sourceClip: `selected:${entry.id}`, clipName: entry.id,
      path: entry.resourcePath, volume: entry.volume };
    const index = sfx.entries.findIndex(item => item.id === entry.soundId);
    if (index < 0) sfx.entries.push(config); else sfx.entries[index] = config;
    visuals.sounds[String(entry.soundId)] = entry.resourcePath;
  }
  const definitions = new Map(catalog.map(weapon => [weapon.id, weapon]));
  if (visuals.weapons.length !== definitions.size) throw new Error('Appearance/catalog count mismatch.');
  for (const appearance of visuals.weapons) {
    const category = definitions.get(appearance.id)?.category;
    if (!categories.has(category)) throw new Error(`Missing attack audio for weapon ${appearance.id}`);
    appearance.soundId = categories.get(category);
  }
  const writes = [
    ['art/original-sfx/config.json', compactJson(sfx) + '\n'],
    ['art/weapon-system/visuals.json', compactJson(visuals) + '\n'],
  ];
  const changed = [];
  for (const [relative, contents] of writes) {
    const target = path.join(resources, relative);
    if (fs.readFileSync(target, 'utf8') !== contents) { fs.writeFileSync(target, contents); changed.push(relative); }
  }
  return { weapons: visuals.weapons.length, selectedSounds: selected.selections.length, changed };
}

if (require.main === module) {
  try { console.log('Weapon audio: ' + JSON.stringify(syncWeaponAudio())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { syncWeaponAudio };
