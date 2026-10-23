const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getWeaponCatalog } = require('./.build/core/index.js');
const root = path.resolve(__dirname, '..');
const resource = key => path.join(root, 'assets/resources', key);
const visuals = require('../assets/resources/art/weapon-system/visuals.json');
const config = require('../assets/resources/art/original-sfx/config.json');
const provenance = require('../tools/weapon-audio-selected-sources.json');

// Frozen from the six user-confirmed WAVs; tests must not depend on audition folders.
const selected = [
  { id: 'bow-b', category: 'bow', soundId: 17, file: 'bow', frames: 14400,
    sha256: '6e99a4c154fb4baf454b38f8b45e3f264a434d848a6e7c8e13f2261c2a228b3c',
    sourcePage: 'https://opengameart.org/content/medieval-sound-effects-weapon-textures', author: 'Ben Jaszczak & Brian Nelson', license: 'CC0 1.0' },
  { id: 'crossbow-b', category: 'crossbow', soundId: 18, file: 'crossbow', frames: 12000,
    sha256: '0b5b0c7ae6d9d3633b169564b16bc28b0d7a46c46477d0a5057b405e9ef45c62',
    sourcePage: 'https://opengameart.org/content/medieval-sound-effects-weapon-textures', author: 'Ben Jaszczak & Brian Nelson', license: 'CC0 1.0' },
  { id: 'staff-g', category: 'staff', soundId: 19, file: 'staff', frames: 3456,
    sha256: '468b5e2411f99174962f837d53bc246ddc0795d54d3529ae5a7eba3d13ddca0d',
    sourcePage: 'https://opengameart.org/content/fireball-1', author: 'Julien Matthey', license: 'CC0 1.0' },
  { id: 'fan-c', category: 'fan', soundId: 20, file: 'fan', frames: 10080,
    sha256: '96a2c5d38e53df51857aa3763283de61a33b06226b6f942b0a8a19f649d2d5b9',
    sourcePage: 'https://opengameart.org/content/swish-bamboo-stick-weapon-swhoshes', author: 'qubodup / Iwan Gabovitch', license: 'CC0' },
  { id: 'dart-b', category: 'glove', soundId: 21, file: 'dart', frames: 3044,
    sha256: '22d7048109698242873316284b44658343b65e186d4d61d3bc2ca21368c0b8b7',
    sourcePage: 'https://opengameart.org/content/swishes-sound-pack', author: 'artisticdude', license: 'CC0 1.0' },
  { id: 'missile-c', category: 'cannon', soundId: 22, file: 'missile', frames: 14400,
    sha256: 'a6594b9263701baa93dab9255ab9a73ce6af0f2484e2f7825d009a189128f797',
    sourcePage: 'https://opengameart.org/content/4-projectile-launches', author: 'Michel Baradari', license: 'CC-BY 3.0' },
];
const soundIds = { bow: 17, crossbow: 18, staff: 19, fan: 20, glove: 21, cannon: 22, handgun: 8 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('all 65 weapon appearances select their family attack sound while handguns retain the original shot', () => {
  const catalog = getWeaponCatalog();
  assert.equal(catalog.length, 65); assert.equal(visuals.weapons.length, 65);
  assert.equal(new Set(visuals.weapons.map(weapon => weapon.id)).size, 65);
  const entries = new Map(config.entries.map(entry => [entry.id, entry]));
  assert.equal(entries.size, config.entries.length, 'sound IDs remain unique');
  for (const weapon of catalog) {
    const appearance = visuals.weapons.find(item => item.id === weapon.id);
    assert.ok(appearance, `weapon ${weapon.id} has an appearance`);
    assert.equal(appearance.soundId, soundIds[weapon.category], `${weapon.id}/${weapon.category}`);
    assert.ok(entries.has(appearance.soundId), `weapon ${weapon.id} resolves to a loaded sound`);
  }
  const handgun = entries.get(8);
  assert.equal(handgun.path, 'art/weapon-system/audio/sfx-8');
  assert.equal(handgun.volume, Math.fround(.3));
  assert.equal(hash(fs.readFileSync(resource(handgun.path + '.wav'))),
    'edce96a85f8be558815f55179509fdcdf3a859a1fc6b30059ce1278e03b1577b');
});

test('the six imported attack WAVs preserve the approved bytes and valid PCM16 stereo 48kHz resources', () => {
  const audioDirectory = resource('art/weapon-system/audio');
  const existingMetaIds = fs.readdirSync(audioDirectory).filter(name => name.endsWith('.wav.meta'))
    .map(name => JSON.parse(fs.readFileSync(path.join(audioDirectory, name), 'utf8')).uuid);
  for (const expected of selected) {
    const key = `art/weapon-system/audio/attack-${expected.file}`;
    const entry = config.entries.find(item => item.id === expected.soundId);
    assert.ok(entry, expected.id); assert.equal(entry.path, key); assert.equal(entry.volume, 1);
    const wav = fs.readFileSync(resource(key + '.wav'));
    assert.equal(hash(wav), expected.sha256, `${expected.id}: use the selected WAV without another gain or crop`);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(4) + 8, wav.length);
    const chunks = new Map();
    let offset = 12;
    while (offset + 8 <= wav.length) {
      const tag = wav.toString('ascii', offset, offset + 4), length = wav.readUInt32LE(offset + 4);
      assert.ok(offset + 8 + length <= wav.length, `${expected.id}: complete ${tag} chunk`);
      assert.ok(!chunks.has(tag), `${expected.id}: unambiguous ${tag} chunk`);
      chunks.set(tag, wav.subarray(offset + 8, offset + 8 + length));
      offset += 8 + length + (length % 2);
    }
    assert.equal(offset, wav.length);
    const format = chunks.get('fmt '), data = chunks.get('data');
    assert.ok(format && format.length >= 16); assert.ok(data && data.length > 0);
    assert.equal(format.readUInt16LE(0), 1, 'integer PCM'); assert.equal(format.readUInt16LE(2), 2, 'stereo');
    assert.equal(format.readUInt32LE(4), 48000); assert.equal(format.readUInt32LE(8), 192000);
    assert.equal(format.readUInt16LE(12), 4); assert.equal(format.readUInt16LE(14), 16);
    assert.equal(data.length, expected.frames * 4, `${expected.id}: selected duration`);
    const meta = JSON.parse(fs.readFileSync(resource(key + '.wav.meta'), 'utf8'));
    assert.equal(meta.importer, 'audio-clip'); assert.ok(meta.files.includes('.wav'));
    assert.match(meta.uuid, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    assert.equal(existingMetaIds.filter(uuid => uuid === meta.uuid).length, 1, `${expected.id}: unique audio UUID`);
  }
});

test('the shipped source manifest links each selected sound to its credited author and license', () => {
  assert.equal(provenance.version, 1); assert.equal(provenance.selections.length, selected.length);
  assert.equal(new Set(provenance.selections.map(item => item.id)).size, selected.length);
  for (const expected of selected) {
    const source = provenance.selections.find(item => item.id === expected.id);
    assert.ok(source, expected.id);
    assert.equal(source.weaponCategory, expected.category); assert.equal(source.soundId, expected.soundId);
    assert.equal(source.resourcePath, `art/weapon-system/audio/attack-${expected.file}`);
    assert.equal(source.wavSha256, expected.sha256); assert.equal(source.sourcePage, expected.sourcePage);
    assert.equal(source.author, expected.author); assert.equal(source.license, expected.license);
  }
});
