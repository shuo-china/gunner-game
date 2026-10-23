const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { packageFeatureResources, collectionOnlyImages, coalesceSharedResources, coalesceSharedPackages } = require('../tools/wechat-feature-package.cjs');

test('font and image packages coalesce only for identical consumers within their byte budget', () => {
  const input=[
    {name:'font-a',files:['font.png'],bytes:200,consumers:['settings','weapons']},
    {name:'image-a',files:['icon.png'],bytes:50,consumers:['weapons','settings']},
    {name:'locked',files:['fish.png'],bytes:10,consumers:['weapons','fish']},
    {name:'large',files:['large.png'],bytes:490,consumers:['weapons','settings']},
  ];
  const result=coalesceSharedPackages(input,500),reversed=coalesceSharedPackages([...input].reverse(),500);
  assert.deepEqual(result,reversed);assert.equal(result.groups.length,3);assert.equal(result.report.addedBytes,0);
  const combined=result.groups.find(group=>group.files.includes('font.png'));
  assert.deepEqual(combined.files,['font.png','icon.png']);assert.equal(combined.bytes,250);
  assert.deepEqual(result.groups.find(group=>group.files.includes('fish.png')).files,['fish.png']);
  assert.ok(result.groups.every(group=>group.bytes<=500));
  for(const consumer of ['settings','weapons','fish']){
    const files=groups=>groups.filter(group=>group.consumers.includes(consumer)).flatMap(group=>group.files).sort();
    assert.deepEqual(files(result.groups),files(input),'each consumer downloads exactly the original files');
  }
});

test('compiled Latin atlases ship locally for boot and every feature without packaging legacy TTFs', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gunner-ui-package-'));
  try {
    const input = path.join(temporary, 'input'), code = path.join(temporary, 'code');
    fs.mkdirSync(code); fs.writeFileSync(path.join(code, 'game.js'), "require('./startup-metadata').installStartupMetadata(cc);");
    const config = { paths: {}, types: ['cc.JsonAsset', 'cc.SpriteFrame', 'cc.TTFFont'], uuids: [] };
    const write = (relative, data) => { const file = path.join(input, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
    const add = (name, type, data) => {
      const uuid = crypto.randomUUID(), index = config.uuids.length;
      config.uuids.push(uuid); config.paths[index] = [name, type];
      const file = type === 0 ? `remote/resources/import/${uuid.slice(0, 2)}/${uuid}.abcd.json`
        : `remote/resources/native/${uuid.slice(0, 2)}/${uuid}.abcd${type === 2 ? '/font317.ttf' : '.png'}`;
      write(file, type === 0 ? JSON.stringify(data) : Buffer.alloc(100));
      return file;
    };
    const font = name => ({ pages: ['art/latin-fonts/' + name] });
    const panels = {
      'weapon-system': { gunIcons: [], roles: {}, roots: { entry: 'weapon-entry', inventory: 'inventory' }, images: { icon: { path: 'art/weapon-system/icon' } }, bitmapFonts: { main: font('weapon') }, fonts: { original: 'art/weapon-system/original' } },
      'settings-system': { settingsUi: {}, roots: {}, images: { panel: { path: 'art/settings-system/panel' } }, bitmapFonts: { main: font('settings') }, input: { fontPath: 'art/settings-system/font317', bitmapFont: font('input') } },
      hud: { joystick: {}, layout: {}, format: {}, bitmapFont: font('hud') },
      'ui-alert': { poolSize: 1, messages: {}, layout: {}, bitmapFont: font('alerts') },
      'stage-transition': { roots: { loading: 'loading' }, bannerAnimation: {}, bitmapFonts: { main: font('stage') } },
      'rebirth-system': { roots: { normal: 'normal', ad: 'ad' } },
      'speedrun-system': { treeIcons: [] },
      'raid-system': { bossSprites: [], images: { shared: { path: 'art/cross-feature/shared' } } },
      'boss-system': { bossHeads: [], images: { shared: { path: 'art/cross-feature/shared' } } },
      'skin-system': { roots: { list: 'list' }, skinCount: 25, previewMode: 'battle-parts' },
      'pet-system': { roots: { newPet: 'newPet' }, portraits: [] },
      'fish-system': { fishSprites: [] },
      'hunt-system': { monsterSprites: [] },
      'mine-system': { roots: { start: 'start' }, ticketDisabledColor: [] },
      'adventure-system': { roots: { petSelect: 'pets', relicDraw: 'draw' }, images: { forest: { path: 'art/adventure-system/forest' } } },
      'offline-system': { roots: { offline: 'offline' }, offlineUi: { close: 'close' }, images: { cat: { path: 'art/offline-system/cat' } } },
      'daily-check-system': { roots: { dailyCheck: 'daily-panel', entry: 'daily-entry' }, dailyCheckUi: { close: 'daily-close' },
        images: { entry: { path: 'art/daily-check-system/entry' }, card: { path: 'art/daily-check-system/card' } } },
    };
    const imports = {}, pageNames = new Set();
    for (const [name, panel] of Object.entries(panels)) {
      if (!panel.bitmapFont && !panel.bitmapFonts) panel.bitmapFonts = { main: font(name) };
      for (const bitmap of [...Object.values(panel.bitmapFonts || {}), panel.bitmapFont, panel.input?.bitmapFont].filter(Boolean)) bitmap.pages.forEach(page => pageNames.add(page));
      imports[name] = add('art/' + name + '/config', 0, panel);
    }
    const weaponEntry = { roles: {}, roots: { entry: 'weapon-entry' }, images: { entry: { path: 'art/weapon-system/entry' } }, bitmapFonts: { main: font('weapon') } };
    // A packed JSON can contain another catalog; use its actual authored roots.
    write(imports['weapon-system'], JSON.stringify([weaponEntry, panels['weapon-system']]));
    add('art/feature-entries/weapons', 0, [panels['weapon-system'], weaponEntry]);
    const pageFiles = new Map([...pageNames].map(name => [name, add(name + '/spriteFrame', 1)]));
    for (const name of ['art/hud/joystick_background', 'art/hud/joystick_handle', 'art/weapon-system/icon', 'art/weapon-system/entry', 'art/settings-system/panel', 'art/offline-system/cat', 'art/daily-check-system/entry', 'art/daily-check-system/card']) add(name + '/spriteFrame', 1);
    const adventureImage = add('art/adventure-system/forest/spriteFrame', 1);
    const sharedImage = add('art/cross-feature/shared/spriteFrame', 1);
    const skinPaths = ['art/skin-system/characters/0/body', 'art/skin-system/characters/1/body', 'art/skin-system/characters/0/head'];
    const skinVisuals = { sharedRig: 'art/characters/cat_basic/rig', bodyContour: { path: 'art/skin-system/body-contour', sizePx: [149, 99] }, skins: [
      { parts: [skinPaths[0], skinPaths[2]].map(path => ({ path, sizeUnits: [1, 1] })) },
      { parts: [skinPaths[1], skinPaths[2]].map(path => ({ path, sizeUnits: [1, 1] })) },
    ] };
    const skinImport = add('art/skin-system/visuals', 0, skinVisuals);
    const facePath = 'art/characters/cat_basic/face';
    add(skinVisuals.sharedRig, 0, { bones: [], attachments: { face: { path: facePath, sizeUnits: [1, 1] } } });
    const skinNatives = [...skinPaths, facePath, skinVisuals.bodyContour.path].map(name => add(name + '/spriteFrame', 1));
    add('art/settings-system/font317', 2); add('art/weapon-system/original', 2);
    const evidence = path.join(temporary, 'evidence.json');
    const result = packageFeatureResources(input, code, config, 'https://nurse.kylinsit.com/forest-gunner/', evidence);
    assert.equal(result.packages.some(item => item.name === 'forest-ui-fonts-0'), false);
    assert.ok(result.packages.some(item => item.name.startsWith('forest-ui-fonts-shared-')));
    assert.ok(result.packages.filter(item => item.name.includes('-fonts-')).every(item => item.bytes <= 512 * 1024));
    const files = JSON.parse(fs.readFileSync(evidence)).files;
    for (const remote of skinNatives) {
      const matches = files.filter(item => item.remote === remote);
      assert.equal(matches.length, 1, 'Live skin parts and face ship once even without panel.images references');
      assert.match(matches[0].package, /^forest-ui-images-shared-/, 'Battle reuse must not load skin panel art or lettering');
    }
    const sharedImages = files.filter(item => item.remote === sharedImage);
    assert.equal(sharedImages.length, 1, 'cross-feature deduplication keeps one native image copy');
    assert.match(sharedImages[0].package, /^forest-ui-images-shared-[0-9a-f]{8}-0$/,
      'shared dependencies are routed by actual config paths, independent of their resource directory');
    assert.equal(files.filter(item => item.package === null).length, 1, 'Loading and HUD glyphs must be in the main package');
    assert.equal(files.filter(item => item.remote.endsWith('.ttf')).length, 0);
    assert.equal(files.filter(item => item.package === 'forest-ui-entry-weapons-0').length, 1);
    assert.equal(files.filter(item => item.package === 'forest-ui-offline-0').length, 1, 'Offline art is independent of shared lettering');
    assert.equal(files.find(item => item.remote === adventureImage).package, 'forest-ui-adventure-0', 'Travel art participates in local feature packages');
    assert.equal(files.filter(item => item.package === 'forest-ui-daily-check-0').length, 2, 'Daily entry and reward art remain packaged');
    assert.equal(files.filter(item => item.package === 'forest-ui-fonts-daily-check-0' && item.localOnly).length, 1, 'Daily lettering remains local in its own dependency group');
    assert.equal(files.filter(item => item.package === 'forest-ui-weapons-0').length, 1, 'Full panel reuses entry glyph pages');
    for (const [page, remote] of pageFiles) {
      const item = files.find(file => file.remote === remote);
      assert.ok(item, page + ' is mapped locally'); assert.equal(item.localOnly, true, page + ' must not need a CDN deployment');
      if (page === 'art/latin-fonts/hud') assert.ok(item.local.startsWith('startup-ui/'));
      if (['art/latin-fonts/alerts', 'art/latin-fonts/stage'].includes(page)) assert.ok(item.local.startsWith('subpackages/forest-ui-startup-fonts-'));
      if (page === 'art/latin-fonts/weapon') assert.match(item.package, /^forest-ui-fonts-shared-/);
      if (page === 'art/latin-fonts/fish-system') assert.equal(item.package, 'forest-ui-fonts-fish-0');
    }
    for (const item of files) assert.deepEqual(fs.readFileSync(path.join(code, item.local)), fs.readFileSync(path.join(input, item.remote)));
    const sharedRoot = 'subpackages/forest-feature-settings-0/';
    fs.mkdirSync(path.join(code, sharedRoot), { recursive: true });
    fs.writeFileSync(path.join(code, sharedRoot, 'game.js'), "'use strict';\n");
    fs.writeFileSync(path.join(code, sharedRoot, 'metadata.bin'), Buffer.alloc(20));
    const metadataPackages = [{ name: 'forest-feature-settings-0', root: sharedRoot, group: 'settings', bytes: 34, files: 1 }];
    const combined = packageFeatureResources(input, code, config, 'https://nurse.kylinsit.com/forest-gunner/', evidence, metadataPackages);
    const combinedFiles = JSON.parse(fs.readFileSync(evidence)).files;
    const settingsFiles = combinedFiles.filter(item => item.package === 'forest-feature-settings-0');
    assert.equal(settingsFiles.length, 3, 'settings metadata, art and its private font pages share one platform package');
    assert.equal(combined.packages.filter(item => item.name === 'forest-feature-settings-0').length, 1);
    assert.equal(metadataPackages[0].bytes, 334);
    assert.equal(fs.readFileSync(path.join(code, sharedRoot, 'metadata.bin')).length, 20);
    assert.equal(combined.packages.some(item => item.name === 'forest-ui-fonts-settings-0'), false);
    // Even a battle image referenced by an otherwise private UI must not pull
    // that panel's complete package into the first battle.
    skinVisuals.skins[0].parts.push({ path: 'art/weapon-system/icon', sizeUnits: [1, 1] });
    write(skinImport, JSON.stringify(skinVisuals));
    add('art/upgrades/config', 0, { images: { cash: { path: 'art/settings-system/panel', sizePx: [148, 148] } } });
    packageFeatureResources(input, code, config, 'https://nurse.kylinsit.com/forest-gunner/', evidence);
    const battleSafeFiles = JSON.parse(fs.readFileSync(evidence)).files;
    const weaponIcon = files.find(item => item.package === 'forest-ui-weapons-0').remote;
    assert.match(battleSafeFiles.find(item => item.remote === weaponIcon).package, /^forest-ui-images-shared-/);
    const hudImage = files.find(item => item.package === 'forest-ui-settings-0').remote;
    assert.match(battleSafeFiles.find(item => item.remote === hudImage).package, /^forest-ui-images-shared-/,
      'core HUD art reused by a private panel must not pull that panel into startup');
    // Older builds without the optional daily catalog remain packageable.
    const dailyPath = Object.keys(config.paths).find(key => config.paths[key][0] === 'art/daily-check-system/config');
    const dailyCatalog = config.paths[dailyPath]; delete config.paths[dailyPath];
    const legacy = packageFeatureResources(input, code, config, 'https://nurse.kylinsit.com/forest-gunner/', evidence);
    assert.equal(legacy.packages.some(item => item.name.startsWith('forest-ui-daily-check-')), false);
    config.paths[dailyPath] = dailyCatalog;
    delete panels['settings-system'].input.bitmapFont;
    write(imports['settings-system'], JSON.stringify(panels['settings-system']));
    assert.throws(() => packageFeatureResources(input, code, config, 'https://nurse.kylinsit.com/forest-gunner/', evidence), /Latin bitmap font conversion is missing/);
  } finally {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('gunner-ui-package-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('collection ownership excludes shared tree images, dynamic gun icons and inline sprites', () => {
  const ui = { roots: { inventory: 'bag', collection: 'book' },
    nodes: { bag: { children: ['shared'] }, shared: { image: { sprite: 'shared' } },
      book: { children: ['shared', 'only', 'gun', 'inline'] }, only: { image: { sprite: 'only' } },
      gun: { image: { sprite: 'gun' } }, inline: { image: { sprite: 'inline' } } },
    images: Object.fromEntries(['shared', 'only', 'gun', 'inline', 'uncertain'].map(key => [key, { path: 'art/' + key }])),
    gunIcons: ['gun'], inlineSprites: { coin: 'inline' } };
  assert.deepEqual(Array.from(collectionOnlyImages(ui)), ['art/only']);
});

test('small overlapping consumer combinations share bounded packets without duplicating files or swallowing private assets', () => {
  const owners = new Map(), bytes = new Map();
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    const file = `shared-${i}-${j}`; owners.set(file, new Set(['panel-' + i, 'panel-' + j])); bytes.set(file, 1024);
  }
  owners.set('private', new Set(['panel-0'])); bytes.set('private', 2 * 1024 * 1024);
  const result = coalesceSharedResources(owners, file => bytes.get(file));
  assert.equal(result.report.originalGroups, 28); assert.ok(result.groups.length < 8);
  const files = result.groups.flatMap(group => group.files);
  assert.equal(files.length, 28); assert.equal(new Set(files).size, 28); assert.equal(files.includes('private'), false);
  assert.deepEqual(result, coalesceSharedResources(new Map(Array.from(owners).reverse()), file => bytes.get(file)), 'input enumeration must not churn the grouping');
  for (const group of result.groups) {
    assert.ok(group.bytes <= 512 * 1024); assert.ok(Object.values(group.extraBytesByConsumer).every(extra => extra <= 64 * 1024));
  }
});

test('disjoint consumers and large private costs remain separate instead of forming one shared UI bundle', () => {
  const owners = new Map([
    ['a', new Set(['weapons', 'settings'])], ['b', new Set(['fish', 'pets'])],
    ['large', new Set(['weapons', 'raid'])],
  ]);
  const result = coalesceSharedResources(owners, file => file === 'large' ? 480 * 1024 : 32 * 1024);
  assert.equal(result.groups.length, 3);
  assert.deepEqual(result.report.extraBytesByConsumer, {});
});

test('merging bounds aggregate extra download per consumer across all shared packets', () => {
  const owners = new Map(Array.from({ length: 12 }, (_, index) => [`file-${index}`,
    new Set(['common', index % 2 ? 'odd' : 'even', 'distinct-' + index])]));
  const sizeOf = () => 8192, limit = 16384;
  const result = coalesceSharedResources(owners, sizeOf, limit), observed = new Map();
  assert.ok(result.groups.length < owners.size); assert.ok(result.groups.length > 1);
  for (const group of result.groups) for (const owner of group.consumers) {
    const required = group.files.filter(file => owners.get(file).has(owner)).reduce((sum, file) => sum + sizeOf(file), 0);
    const extra = group.bytes - required;
    assert.equal(group.extraBytesByConsumer[owner], extra);
    observed.set(owner, (observed.get(owner) || 0) + extra);
  }
  assert.ok(Array.from(observed.values()).some(bytes => bytes > 0));
  for (const [owner, bytes] of observed) { assert.ok(bytes <= limit, owner); assert.equal(result.report.extraBytesByConsumer[owner] || 0, bytes); }
});
