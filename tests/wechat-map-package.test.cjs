const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { packageMapResources } = require('../tools/wechat-map-package.cjs');

function fixture(context, { packed = false } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gunner-map-package-'));
  context.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('gunner-map-package-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const input = path.join(temporary, 'input'), code = path.join(temporary, 'code');
  fs.mkdirSync(code); fs.writeFileSync(path.join(code, 'game.js'), "require('./startup-metadata').installStartupMetadata(cc);");
  const config = { paths: {}, types: ['cc.SpriteFrame', 'cc.JsonAsset'], uuids: [] }, assets = new Map();
  function write(relative, data) {
    const file = path.join(input, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
  }
  function asset(name, type) {
    const index = config.uuids.length, uuid = crypto.randomUUID();
    config.paths[index] = [name, type]; config.uuids.push(uuid); assets.set(name, { index, uuid });
    return { index, uuid };
  }
  const native = uuid => `remote/resources/native/${uuid.slice(0, 2)}/${uuid}.abcd.png`;
  const imported = uuid => `remote/resources/import/${uuid.slice(0, 2)}/${uuid}.abcd.json`;
  function frame(name, bytes = 100) {
    const { uuid } = asset(name + '/spriteFrame', 0); write(native(uuid), Buffer.alloc(bytes));
    return { path: name };
  }
  function alias(name, target) {
    const { uuid } = asset(name + '/spriteFrame', 0);
    write(imported(uuid), JSON.stringify([assets.get(target.path + '/spriteFrame').uuid]));
    return { path: name };
  }
  const common = frame('art/maps/forest/common'), external = frame('art/hunt-system/images/health');
  const map = { version: 1, sprites: { ground: common }, ground: {}, borders: [] };
  const stages = { version: 1, skins: [], treeSprites: [], normal: { healthBar: { background: external, fill: external } },
    boss: { healthBar: { background: external, fill: external }, sparkles: { image: frame('art/stages/boss_sparkle') } } };
  for (let stage = 0; stage < 10; stage++) {
    stages.skins.push({ sprites: { ground: frame(`art/stages/maps/${stage}/current/ground`) } });
    for (let tree = 0; tree < 4; tree++) stages.treeSprites.push(frame(stage === 0 && tree === 0
      ? 'art/stages/trees/0' : `art/stages/trees/${stage * 4 + tree}`));
  }
  const legacy = [frame('art/stages/maps/0/fixture-old/ground'), frame('art/stages/maps/0/fixture-harvest/ground', 400)];
  alias('art/stages/maps/0/fixture-old/alias', stages.skins[0].sprites.ground);
  const shared = frame('art/stages/shared-atlas');
  stages.skins[0].sprites.shared = alias('art/stages/maps/0/shared', shared);
  stages.skins[1].sprites.shared = alias('art/stages/maps/1/shared', shared);
  const mapAsset = asset('art/maps/forest/map', 1), stagesAsset = asset('art/stages/config', 1);
  function saveConfigs() {
    if (packed) {
      const uuid = '00112233-4455-6677-8899-aabbccddeeff';
      config.packs = { [uuid]: [mapAsset.index, stagesAsset.index] };
      write(imported(uuid), JSON.stringify([1, [], [], [], [], [[map], [stages]]]));
    } else {
      write(imported(mapAsset.uuid), JSON.stringify([map]));
      write(imported(stagesAsset.uuid), JSON.stringify([stages]));
    }
  }
  const evidencePath = path.join(temporary, 'index.json');
  function run() {
    saveConfigs();
    const result = packageMapResources(input, code, config, 'https://example.test/', evidencePath);
    const evidence = JSON.parse(fs.readFileSync(evidencePath));
    const owner = spec => evidence.files.find(file => file.remote === native(assets.get(spec.path + '/spriteFrame').uuid))?.package;
    return { result, evidence, owner };
  }
  return { input, code, config, map, stages, common, external, shared, legacy, frame, alias, run };
}

test('compiled stage consumers isolate unused themes and preserve all ten maps and shared native bytes', context => {
  const h = fixture(context);
  // The replacement's directory number deliberately disagrees with its consumer.
  const replaced = h.stages.skins[4].sprites.ground;
  h.stages.skins[4].sprites.ground = h.frame('art/stages/maps/0/replacement/ground');
  const { result, evidence, owner } = h.run();
  for (let stage = 0; stage < 10; stage++) {
    assert.equal(owner(h.stages.skins[stage].sprites.ground), 'forest-map-' + stage);
    for (const tree of h.stages.treeSprites.slice(stage * 4, stage * 4 + 4)) assert.equal(owner(tree), 'forest-map-' + stage);
  }
  for (const item of [...h.legacy, replaced]) assert.match(owner(item), /^forest-map-legacy-\d+$/);
  assert.notEqual(owner(h.legacy[0]), owner(h.legacy[1]), 'an old ground cannot pull an unrelated retired theme');
  assert.equal(owner(h.common), 'forest-map-common'); assert.equal(owner(h.shared), 'forest-map-common');
  assert.equal(owner(h.external), undefined, 'external deduplicated HUD files stay with the existing feature hook');
  assert.equal(result.packages.length, 14);
  assert.equal(new Set(evidence.files.map(file => file.remote)).size, evidence.files.length);
  assert.ok(result.packages.every(group => group.bytes < 3 * 1024 * 1024));
  for (const file of evidence.files) {
    const original = fs.readFileSync(path.join(h.input, file.remote));
    assert.deepEqual(fs.readFileSync(path.join(h.code, file.local)), original);
    assert.equal(file.sha256, crypto.createHash('sha256').update(original).digest('hex'));
  }
});

test('packed map definitions and legacy aliases retain their actual active consumer', context => {
  const h = fixture(context, { packed: true }), { owner, result } = h.run();
  assert.equal(owner(h.stages.skins[0].sprites.ground), 'forest-map-0', 'an unused alias must not promote its active texture to common');
  assert.match(owner(h.legacy[0]), /^forest-map-legacy-\d+$/);
  assert.equal(result.files, 55, 'all original map natives survive exactly once, including legacy exports');
});

test('an atlas shared only by retired themes stays outside the active common package', context => {
  const h = fixture(context), shared = h.frame('art/stages/unused-atlas');
  h.alias('art/stages/maps/0/fixture-harvest/alias', shared);
  h.alias('art/stages/maps/0/fixture-old/alias-two', shared);
  const { owner } = h.run();
  assert.equal(owner(shared), 'forest-map-legacy');
});

test('missing or malformed compiled stage definitions stop packaging instead of guessing folder ownership', context => {
  for (const mutation of [h => { delete h.config.paths[Object.keys(h.config.paths).find(key => h.config.paths[key][0] === 'art/stages/config')]; },
    h => { h.stages.treeSprites.pop(); }, h => { h.stages.skins[0].sprites.ground.path = 'art/stages/missing'; }]) {
    const h = fixture(context); mutation(h);
    assert.throws(h.run, /Missing compiled map config|Invalid original stage assets|Missing map asset/);
    assert.equal(fs.existsSync(path.join(h.code, 'subpackages')), false);
  }
});

test('unused maps keep the existing bounded split-package behavior', context => {
  const h = fixture(context);
  h.frame('art/stages/maps/0/fixture-harvest/large-one', 2 * 1024 * 1024);
  h.frame('art/stages/maps/0/fixture-harvest/large-two', 2 * 1024 * 1024);
  const { result, owner } = h.run();
  const group = result.packages.find(item => item.name === owner(h.legacy[1])).stage;
  const theme = 'forest-map-' + group, legacy = result.packages.filter(item => item.stage === group);
  assert.equal(legacy.length, 2);
  assert.deepEqual(legacy.map(item => item.name), [theme, theme + '-1']);
  assert.ok(result.packages.every(group => group.bytes <= 3 * 1024 * 1024));
});
