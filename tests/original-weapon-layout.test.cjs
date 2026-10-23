const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require(path.join(root, 'assets/resources/art/weapon-system/config.json'));
const ids = { draw: 'level0:606', ordinary: 'level0:802', daily: 'level0:1491', currency: 'level0:36875', collection: 'level0:2053', card: 'level0:22270', starPrice: 'level0:355', drawPrice: 'level0:1106', adReward: 'level0:23102' };

// Exercise the real source renderer and original hierarchy. These stubs supply
// only Cocos component ownership and scale/translation of its actual hit boxes.
function harness(rootName = 'inventory', configOverride = config) {
  const config = configOverride;
  const frameLoads = [], fontLoads = [], bitmapFrames = [];
  class Vec2 { constructor(x, y) { Object.assign(this, { x, y }); } }
  class UITransform {
    width = 0; height = 0; anchorX = .5; anchorY = .5;
    setContentSize(width, height) { Object.assign(this, { width, height }); }
    setAnchorPoint(anchorX, anchorY) { Object.assign(this, { anchorX, anchorY }); }
    getBoundingBoxToWorld() {
      const p = this.node.worldPosition, s = this.node.worldScale;
      const box = { x: p.x - this.anchorX * this.width * s.x, y: p.y - this.anchorY * this.height * s.y, width: this.width * s.x, height: this.height * s.y };
      box.contains = point => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
      return box;
    }
  }
  class Node {
    constructor(name) { Object.assign(this, { name, children: [], components: new Map(), active: true, isValid: true, angle: 0, position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }); }
    addChild(node) { node.parent = this; this.children.push(node); }
    addComponent(Type) { const value = new Type(); value.node = this; this.components.set(Type, value); return value; }
    getComponent(Type) { return this.components.get(Type); }
    get activeInHierarchy() { return this.active && (!this.parent || this.parent.activeInHierarchy); }
    setPosition(x, y, z = 0) { this.position = { x, y, z }; }
    setScale(x, y, z = 1) { this.scale = { x, y, z }; }
    get worldScale() { const p = this.parent?.worldScale || { x: 1, y: 1, z: 1 }; return { x: this.scale.x * p.x, y: this.scale.y * p.y, z: this.scale.z * p.z }; }
    get worldPosition() { const p = this.parent?.worldPosition || { x: 0, y: 0, z: 0 }, s = this.parent?.worldScale || { x: 1, y: 1, z: 1 }; return { x: p.x + this.position.x * s.x, y: p.y + this.position.y * s.y, z: p.z + this.position.z * s.z }; }
    setWorldPosition(x, y, z = 0) { const p = this.parent?.worldPosition || { x: 0, y: 0, z: 0 }, s = this.parent?.worldScale || { x: 1, y: 1, z: 1 }; this.setPosition((x - p.x) / s.x, (y - p.y) / s.y, (z - p.z) / s.z); }
    destroy() { this.isValid = false; this.active = false; this.children.forEach(child => child.destroy()); }
  }
  class Color { static WHITE = new Color(255, 255, 255, 255); constructor(r, g, b, a) { Object.assign(this, { r, g, b, a }); } }
  class Graphics {
    points = [];
    clear() { this.points = []; }
    rect() {} roundRect() {} fill() {} stroke() {}
    moveTo(x, y) { this.points.push([x, y]); }
    lineTo(x, y) { this.points.push([x, y]); }
  }
  class Label { static HorizontalAlign = { LEFT: 0, RIGHT: 1, CENTER: 2 }; static VerticalAlign = { TOP: 0, BOTTOM: 1, CENTER: 2 }; static Overflow = { SHRINK: 0, CLAMP: 1 }; }
  class LabelOutline {}
  class Font {}
  class RichText {}
  class SpriteAtlas { spriteFrames = {}; destroy() {} }
  class SpriteFrame {
    constructor() { bitmapFrames.push(this); }
    reset(value) { Object.assign(this, value); }
    destroy() {}
  }
  class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
  class Size { constructor(width, height) { Object.assign(this, { width, height }); } }
  class Sprite { static SizeMode = { CUSTOM: 0 }; static Type = { SLICED: 0, TILED: 1, SIMPLE: 2 }; }
  class Mask { static Type = { GRAPHICS_RECT: 0 }; }
  const makeNode = (name, parent) => { const node = new Node(name); node.addComponent(UITransform); if (parent) parent.addChild(node); return node; };
  const paths = [...Object.values(config.images).map(image => image.path), ...Object.values(config.bitmapFonts ?? {}).flatMap(font => font.pages)];
  const art = { frames: new Map(paths.map(path => [path, { texture: { path } }])), image: (name, spec, parent) => makeNode(name, parent),
    json: async resource => { assert.equal(resource, 'art/weapon-system/config'); return config; },
    loadFrame: async resource => { frameLoads.push(resource); return art.frames.get(resource); } };
  const resources = { load: (resource, Type, callback) => { fontLoads.push(resource); callback(null, new Type()); } };
  const cc = { Color, Font, Graphics, Label, LabelOutline, Mask, Node, resources, RichText, Sprite, SpriteAtlas, SpriteFrame, Rect, Size, UITransform, Vec2, BlockInputEvents: class {} };
  const imports = { cc, './ArtLibrary': { makeNode } };
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in imports, `missing ${key}`); return imports[key]; } });
    imports[`./${file}`] = module.exports;
  }
  const { OriginalWeaponUi, OriginalGradeBadgePool, loadWeaponHudAssets, loadWeaponCollectionAssets, weaponHudImagePaths, weaponCollectionWindow, fitUiImage, applyWeaponUiDisplay } = imports['./OriginalWeaponUi'];
  const ui = new OriginalWeaponUi(art, { config, chineseFont: new Font(), originalFont: new Font(), numberFont: new Font() });
  const canvas = makeNode('Canvas'), inventory = ui.create(config.roots[rootName], canvas); inventory.active = true;
  const resize = (width = 1080, height = 1920) => { const scale = width / config.referenceWidth; canvas.getComponent(UITransform).setContentSize(width, height); ui.layout(config.roots[rootName], 1080, height / scale); inventory.setScale(scale, scale, 1); };
  const node = key => ui.node(ids[key]), tr = key => node(key).getComponent(UITransform), box = key => tr(key).getBoundingBoxToWorld();
  const rich = key => node(key).children.find(child => child.name === 'OriginalInlineText')?.getComponent(RichText);
  const glyphs = key => node(key).children.filter(child => child.name === 'OriginalGlyph' && child.active);
  resize();
  return { ui, node, tr, box, resize, rich, art, glyphs, UITransform, Label, Sprite, Graphics, bitmapFrames, loadWeaponHudAssets, loadWeaponCollectionAssets, weaponHudImagePaths, weaponCollectionWindow, fitUiImage, applyWeaponUiDisplay, frameLoads, fontLoads, OriginalWeaponUi, OriginalGradeBadgePool, makeNode };
}

test('all 2525 weapon nodes can be created and laid out in bounded steps with identical geometry', () => {
  const h = harness(), sync = new h.OriginalWeaponUi(h.art, h.ui.assets), sliced = new h.OriginalWeaponUi(h.art, h.ui.assets);
  const syncRoot = h.makeNode('Sync'), slicedRoot = h.makeNode('Sliced');
  let creationSteps = 0, layoutSteps = 0;
  for (const id of Object.values(config.roots)) {
    sync.create(id, syncRoot); sync.layout(id, 1080, 1800, 30, 20);
    const create = sliced.createSteps(id, slicedRoot);
    for (;;) {
      const next = create.next(); if (next.done) break;
      creationSteps++;
      // Aliases refer to the same node: count authored ids, not map entries.
      assert.equal(Object.keys(config.nodes).filter(key => sliced.get(key)).length, creationSteps);
    }
    for (const _ of sliced.layoutSteps(id, 1080, 1800, 30, 20)) layoutSteps++;
  }
  assert.equal(creationSteps, Object.keys(config.nodes).length);
  assert.ok(layoutSteps >= creationSteps, 'layout yields for each node as well');
  for (const id of Object.keys(config.nodes)) {
    const a = sync.node(id), b = sliced.node(id), at = a.getComponent(h.UITransform), bt = b.getComponent(h.UITransform);
    assert.deepEqual([a.active,a.position.x,a.position.y,at.width,at.height], [b.active,b.position.x,b.position.y,bt.width,bt.height], id);
  }
  sync.destroy(); sliced.destroy(); syncRoot.destroy(); slicedRoot.destroy();
});

test('managed preparation retains every authored weapon root and final text geometry before resolving', async () => {
  const h = harness(), sync = new h.OriginalWeaponUi(h.art, h.ui.assets), managed = new h.OriginalWeaponUi(h.art, h.ui.assets);
  const parent = h.makeNode('PreparationCanvas'), syncOwner = h.makeNode('Sync', parent), managedOwner = h.makeNode('Managed', parent);
  const initialize = function* (ui, owner) {
    for (const id of Object.values(config.roots)) yield* ui.createSteps(id, owner);
    for (const id of Object.values(config.roots)) yield* ui.layoutSteps(id, 1080, 1800, 30, 20);
  };
  await sync.prepare(syncOwner, parent, initialize(sync, syncOwner));
  const driver = require('./support/ui-preparation.cjs').preparationDriver(); driver.prepare.managed = true;
  const prepared = managed.prepare(managedOwner, parent, initialize(managed, managedOwner), driver.prepare);
  await driver.flush(); await prepared;
  const snapshot = node => {
    const tr = node.getComponent(h.UITransform), label = node.getComponent(h.Label);
    return [node.active, node.position, tr.width, tr.height, label && [label.string, label.fontSize, label.color],
      node.children.filter(child => child.active && ['OriginalGlyph', 'SystemGlyph'].includes(child.name)).map(child => {
        const childTr = child.getComponent(h.UITransform), sprite = child.getComponent(h.Sprite), text = child.getComponent(h.Label);
        return [child.name, child.position, childTr.width, childTr.height,
          sprite && [sprite.color, sprite.spriteFrame.rect ?? sprite.spriteFrame.texture.path], text && [text.string, text.fontSize, text.color]];
      })];
  };
  for (const id of Object.keys(config.nodes)) assert.deepEqual(snapshot(managed.node(id)), snapshot(sync.node(id)), id);
  assert.equal(managedOwner.active, false, 'publication remains owned by the scene commit');
  sync.destroy(); managed.destroy(); h.ui.destroy(); parent.destroy();
});

function near(actual, expected, message) { assert.ok(Math.abs(actual - expected) < .001, `${message ? `${message}: ` : ''}${actual} != ${expected}`); }
function overlap(a, b) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y; }

test('all backpack cards retain the original Unity artwork and category text positions', () => {
  const h = harness('inventory');
  const roles = Object.values(config.roles).filter(role => role.type === 'Gun_Item');
  assert.equal(roles.length, 16);
  for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) {
    h.resize(width, height);
    for (const role of roles) {
      const shadow = h.ui.node(role.Shadow_img), name = h.ui.node(role.Type_txt);
      // Original bundle RectTransforms: Gun (4.3, .6), Type_txt (11.1, -38.5).
      near(shadow.position.x, 4.3, 'weapon stays centred instead of shifted right');
      near(shadow.position.y, .6);
      near(name.position.x, 11.1);
      near(name.position.y, -38.5, 'category keeps the original bottom inset');
      const label = name.getComponent(h.Label);
      assert.equal(label.horizontalAlign, h.Label.HorizontalAlign.RIGHT);
      assert.equal(label.verticalAlign, h.Label.VerticalAlign.CENTER);
    }
  }
  h.ui.destroy();
});

test('all dynamic UI surfaces render the same equipment proportions after grade changes, reuse and resize', () => {
  const catalog = require('./.build/session/core/WeaponCatalog.js').getWeaponCatalog();
  const policy = require('../tools/weapon-battle-size-policy.json');
  const baselines = require('../tools/weapon-collection-size-baselines.json');
  const layout = require('../tools/weapon-inventory-size-layout.json');
  const raid = require('../assets/resources/art/raid-system/config.json');
  const measure = (size, metric) => metric === 'width' ? size[0] : metric === 'height' ? size[1] : Math.sqrt(size[0] * size[1]);
  for (const [source, rootName, surface] of [[config,'inventory','Gun_Item'],[config,'inventory','Gun_Slot'],
    [config,'detail','Gun_Info_UI'],[config,'newGun','NewGun_UI'],[raid,'selection','Gun_Item_Demo'],[raid,'start','Raid_GunSlot']]) {
    const h = harness(rootName, source), role = Object.values(source.roles).find(r => r.type === surface);
    const card = h.ui.node(role.node), space = h.ui.node(role.Shadow_img).parent;
    for (const [width, height] of [[360,640],[390,844],[412,915],[360,640]]) {
      h.resize(width,height);
      const hit = card.getComponent(h.UITransform), originalHit = [hit.width,hit.height,card.scale.x,card.scale.y];
      for (const weapon of [...catalog,catalog[8],catalog[0]]) {
        h.applyWeaponUiDisplay(source,role,weapon.id,key => h.ui.node(key));
        const icon=source.gunIcons[weapon.id],image=source.images[icon],bounds=image.uiVisibleBoundsPx,dimensions=[];
        for (const key of [role.Gun_img,role.Shadow_img]) {
          h.ui.image(key,icon);
          const node=h.ui.node(key),child=node.children.find(n=>n.name==='OriginalImage'),tr=child.getComponent(h.UITransform);
          let factor=tr.width/image.sizePx[0];
          for(let ancestor=node;ancestor!==space;ancestor=ancestor.parent) factor*=ancestor.scale.x;
          const size=[bounds[2]-bounds[0],bounds[3]-bounds[1]].map(n=>n*factor);dimensions.push(size);
          near(tr.width/tr.height,image.sizePx[0]/image.sizePx[1],surface+': source aspect ratio');
          near(measure(size,policy.categories[weapon.category].metric),
            measure(baselines.categories[weapon.category].referenceVisibleSize,policy.categories[weapon.category].metric)*layout.surfaces[surface].collectionScale,
            surface+'/'+weapon.id+': rendered fixed category size');
        }
        dimensions[0].forEach((n,i)=>near(n,dimensions[1][i],surface+': foreground and shadow agree'));
        assert.deepEqual([hit.width,hit.height,card.scale.x,card.scale.y],originalHit,'card hit box remains fixed');
      }
    }
    h.ui.destroy();
  }
});

test('all 65 collection cards render equipment category sizes at every grade with matching shadows', () => {
  const { getWeaponCatalog } = require('./.build/session/core/WeaponCatalog.js');
  const { pngAlpha } = require('./support/png-alpha.cjs');
  const policy = require('../tools/weapon-battle-size-policy.json');
  const baselines = require('../tools/weapon-collection-size-baselines.json');
  const collection = Object.values(config.roles).find(role => role.type === 'Gun_Collection_UI');
  const roles = new Map(collection.Gun_Item_list.map(key => [config.roles[key].GunNum, config.roles[key]]));
  const catalog = getWeaponCatalog(), pixels = new Map();
  for (const weapon of catalog) {
    const image = config.images[config.gunIcons[weapon.id]];
    pixels.set(weapon.id, pngAlpha(fs.readFileSync(path.join(root, 'assets/resources', image.path + '.png')), 16));
  }
  const h = harness('collection');
  const measure = (size, metric) => metric === 'width' ? size[0] : metric === 'height' ? size[1] : Math.sqrt(size[0] * size[1]);
  assert.equal(roles.size, 65);
  for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) {
    h.resize(width, height);
    const sameGrade = new Map();
    for (const weapon of catalog) {
      const role = roles.get(weapon.id), card = h.ui.node(role.node), cardRect = card.getComponent(h.UITransform);
      const image = config.images[config.gunIcons[weapon.id]], bounds = pixels.get(weapon.id).bounds;
      const rule = policy.categories[weapon.category], baseline = baselines.categories[weapon.category].referenceVisibleSize;
      const target = measure(baseline, rule.metric);
      near(cardRect.width, 210, `${weapon.id}: card width remains fixed`);
      near(cardRect.height, 240, `${weapon.id}: taller card leaves space for its labels`);
      near(card.scale.x, .9, `${weapon.id}: card and hit area scale remain fixed`);
      near(card.scale.y, .9, `${weapon.id}: card and hit area scale remain fixed`);
      const sizes = [role.Gun_img, role.Shadow_img].map(key => {
        const slot = h.ui.node(key), child = slot.children.find(node => node.name === 'OriginalImage');
        const drawn = child.getComponent(h.UITransform);
        // Read fitted geometry from the real renderer; exclude the card and
        // canvas transforms so this checks source axes before icon rotation.
        const factor = drawn.width / image.sizePx[0];
        near(factor, drawn.height / image.sizePx[1], `${weapon.id}: artwork keeps its proportions`);
        return [0, 1].map(axis => (bounds[axis + 2] - bounds[axis]) * factor *
          Math.abs(child.worldScale[axis ? 'y' : 'x'] / card.worldScale[axis ? 'y' : 'x']));
      });
      for (const size of sizes) {
        near(measure(size, rule.metric), target, `${width}/${weapon.id}: rendered size follows the baseline and grade`);
      }
      sizes[0].forEach((value, axis) => near(value, sizes[1][axis], `${weapon.id}: foreground and shadow have identical dimensions`));
      const group = weapon.category, value = measure(sizes[0], rule.metric);
      if (sameGrade.has(group)) near(value, sameGrade.get(group), `${group}: all grades render equal category size`);
      sameGrade.set(group, value);
      if (weapon.id === rule.referenceWeaponId) sizes[0].forEach((value, axis) => near(value, baseline[axis], `${weapon.category}: baseline remains visually unchanged`));
      near(h.ui.node(role.Shadow_img).angle, weapon.category === 'staff' ? -45 : 24, `${weapon.id}: approved icon tilt is retained`);
    }
  }
  h.ui.destroy();
});

test('collection lays out thirteen complete rows and keeps its labels inset from the taller card edges', () => {
  const { getWeaponCatalog } = require('./.build/session/core/WeaponCatalog.js');
  const catalog = getWeaponCatalog();
  const collection = Object.values(config.roles).find(role => role.type === 'Gun_Collection_UI');
  const roles = collection.Gun_Item_list.map(key => config.roles[key]);
  const content = Object.values(config.nodes).find(node => node.children.includes(roles[0].node));
  assert.equal(content.layoutType, 'GridLayoutGroup');
  assert.deepEqual(content.layout.m_CellSize, { x: 210, y: 240 });
  assert.deepEqual(content.layout.m_Spacing, { x: 0, y: 0 });
  assert.equal(content.layout.m_Padding.m_Top, 20);
  assert.equal(content.layout.m_Padding.m_Bottom, 20);
  assert.equal(roles.length, 13 * 5);
  assert.equal(content.rect.size[1], 20 + 13 * 240 + 20, 'scroll content includes every row and both edge paddings');
  const h = harness('collection');
  for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) {
    h.resize(width, height);
    const contentNode = h.ui.node(content.id), contentRect = contentNode.getComponent(h.UITransform);
    near(contentRect.height, 3160, 'the renderer uses the full scrollable height');
    for (const [index, role] of roles.entries()) {
      const row = Math.floor(index / 5), column = index % 5;
      const card = h.ui.node(role.node), rect = card.getComponent(h.UITransform), spec = config.nodes[role.node];
      assert.equal(card.parent, contentNode);
      near(spec.rect.position[0], 121.5 + column * 210, `${role.GunNum}: five aligned columns`);
      near(spec.rect.position[1], -140 - row * 240, `${role.GunNum}: thirteen evenly spaced rows`);
      near(card.position.y, -140 - row * 240, `${role.GunNum}: rendered row position`);
      const top = card.position.y + rect.height * (1 - rect.anchorY) * card.scale.y;
      const bottom = card.position.y - rect.height * rect.anchorY * card.scale.y;
      assert.ok(top <= -20 && bottom >= -contentRect.height + 20, `${role.GunNum}: full card remains inside padded scroll content`);
      if (row) {
        const previous = h.ui.node(roles[index - 5].node), previousRect = previous.getComponent(h.UITransform);
        const previousBottom = previous.position.y - previousRect.height * previousRect.anchorY * previous.scale.y;
        near(previousBottom - top, 24, `${role.GunNum}: neighboring row hit boxes retain a clear gap`);
      }
      const grade = catalog.find(weapon => weapon.id === role.GunNum).grade;
      const degree = h.ui.node(role.Degree_objs[grade]), degreeContainer = degree.parent;
      const type = h.ui.node(role.Type_txt), typeRect = type.getComponent(h.UITransform);
      near(degreeContainer.position.y, 86, `${role.GunNum}: grade container moves with the top edge`);
      near(rect.height / 2 - degreeContainer.position.y, 34, `${role.GunNum}: original grade-center top inset is preserved`);
      near(type.position.y, -83.5, `${role.GunNum}: category text moves with the bottom edge`);
      near(rect.height / 2 + type.position.y, 36.5, `${role.GunNum}: original category-center bottom inset is preserved`);
      const cardBox = rect.getBoundingBoxToWorld(), degreeBox = degree.getComponent(h.UITransform).getBoundingBoxToWorld();
      const typeBox = typeRect.getBoundingBoxToWorld(), scale = card.worldScale.y;
      near((cardBox.y + cardBox.height - degreeBox.y - degreeBox.height) / scale, 9, `${role.GunNum}: grade text box stays inside the top edge`);
      near((typeBox.y - cardBox.y) / scale, 11.489200592041016, `${role.GunNum}: category text box stays inside the bottom edge`);
      near((degreeBox.y - typeBox.y - typeBox.height) / scale, 119.48920059204102, `${role.GunNum}: upper and lower text boxes retain the expanded artwork space`);
    }
  }
  h.ui.destroy();
});

test('visible bow centres fill the original image slots without changing canvas or tier scale', () => {
  const { fitUiImage } = harness('detail');
  for (const bounds of [[74, 25, 104, 118], [56, 12, 108, 133], [68, 10, 107, 134], [67, 9, 108, 128]]) {
    for (const box of [[256, 143], [180, 200], [2752, 1537.25]]) for (const anchor of [[.5, .5], [.2, .75]]) {
      const image = { sizePx: [256, 143], uiVisibleBoundsPx: bounds }, result = fitUiImage(image, box, anchor);
      const factor = Math.min(box[0] / 256, box[1] / 143);
      near(result.size[0], 256 * factor); near(result.size[1], 143 * factor);
      near(result.position[0] + ((bounds[0] + bounds[2]) / 2 - anchor[0] * 256) * factor, (.5 - anchor[0]) * box[0]);
      near(result.position[1] + (143 - (bounds[1] + bounds[3]) / 2 - anchor[1] * 143) * factor, (.5 - anchor[1]) * box[1]);
    }
  }
  for (const bounds of [undefined, [20, 20, 10, 10], [0, 0, 300, 143], [0, NaN, 10, 10]]) {
    const result = fitUiImage({ sizePx: [256, 143], uiVisibleBoundsPx: bounds }, [128, 100], [.5, .5]);
    assert.deepEqual(Array.from(result.position), [0, 0]);
    assert.deepEqual(Array.from(result.size), [128, 71.5]);
  }
});

test('bow UI includes the single resting string in centering and keeps it registered during image changes and resizing', () => {
  const raidConfig = require('../assets/resources/art/raid-system/config.json');
  const raidSlot = Object.values(raidConfig.roles).find(role => role.type === 'Raid_GunSlot');
  for (const [source, rootName, key] of [[config, 'collection', 'level0:17006'], [config, 'detail', 'level0:1391'],
    [config, 'inventory', 'level0:17458'], [config, 'inventory', 'level0:25887'], [config, 'newGun', 'level0:34100'],
    [raidConfig, 'start', raidSlot.Gun_img], [raidConfig, 'start', raidSlot.Shadow_img]]) {
    const local = structuredClone(source), image = local.images.testBow = {
      ...local.images[local.gunIcons[0]], path: 'test/stringless-bow', sizePx: [256, 143], uiVisibleHullPx: undefined, uiHeightReference: undefined,
      uiVisibleBoundsPx: [74, 25, 104, 118],
      uiBowString: { upperPx: [100, 25], lowerPx: [100, 118], bracePx: [46, 71.5], color: [210, 180, 145, 255], widthPx: 2 },
    };
    // All current weapons have measured bounds; keep an explicit legacy image
    // fixture to exercise clearing both string and centering on image changes.
    local.images.testUnregistered = { ...image, path: 'test/unregistered', uiBowString: undefined,
      uiVisibleBoundsPx: undefined, uiVisibleHullPx: undefined, uiHeightReferenceFrame: undefined };
    const spec = Object.values(local.nodes).find(node => node.id === key || node.components.includes(key));
    spec.image.sprite = 'testBow'; spec.image.preserveAspect = false;
    const h = harness(rootName, local), slot = h.ui.node(key), child = slot.children.find(node => node.name === 'OriginalImage');
    const sourcePosition = { ...slot.position }, stringNode = child.children.find(node => node.name === 'OriginalBowString');
    assert.ok(stringNode, `${rootName}: initially authored bow draws its resting string`);
    const graphic = stringNode.getComponent(h.Graphics);
    function verify() {
      const slotRect = slot.getComponent(h.UITransform), imageRect = child.getComponent(h.UITransform);
      const factor = imageRect.width / 256;
      // Combined alpha + stroked-string bounds are [45, 24, 104, 119].
      near(child.position.x + (74.5 - imageRect.anchorX * 256) * factor, (.5 - slotRect.anchorX) * slotRect.width, rootName);
      near(child.position.y + (71.5 - imageRect.anchorY * 143) * factor, (.5 - slotRect.anchorY) * slotRect.height, rootName);
      near(graphic.lineWidth, 2 * factor);
      assert.equal(graphic.points.length, 3, 'one continuous string, with one brace point');
      for (const [i, point] of [image.uiBowString.upperPx, image.uiBowString.bracePx, image.uiBowString.lowerPx].entries()) {
        near(graphic.points[i][0], (point[0] - imageRect.anchorX * 256) * factor);
        near(graphic.points[i][1], (143 * (1 - imageRect.anchorY) - point[1]) * factor);
      }
    }
    verify();
    h.ui.image(key, 'testBow'); assert.deepEqual(slot.position, sourcePosition, 'authored slot and shadow offsets stay intact');
    for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) { h.resize(width, height); verify(); }
    h.ui.tint(key, [0, 0, 0, 90]);
    assert.deepEqual([graphic.strokeColor.r, graphic.strokeColor.g, graphic.strokeColor.b], [0, 0, 0]);
    assert.equal(graphic.strokeColor.a, 255, 'string inherits its image alpha without applying shadow alpha twice');
    h.ui.tint(key, [128, 64, 255, 128]);
    for (const [channel, value, tint] of [['r', 210, 128], ['g', 180, 64], ['b', 145, 255]]) near(graphic.strokeColor[channel], value * tint / 255);
    h.ui.show(key, false); h.ui.image(key, 'testBow');
    assert.equal(slot.active, false, 'refreshing a hidden weapon does not show it');
    assert.equal(stringNode.activeInHierarchy, false, 'the string shares its image visibility');
    h.ui.show(key, true); assert.equal(stringNode.active, true);
    h.ui.tint(key, [255, 255, 255, 255]);
    assert.deepEqual([graphic.strokeColor.r, graphic.strokeColor.g, graphic.strokeColor.b, graphic.strokeColor.a], image.uiBowString.color);
    h.ui.image(key, 'testUnregistered');
    assert.equal(stringNode.active, false); near(child.position.x, 0); near(child.position.y, 0);
    h.ui.image(key, 'testBow'); verify(); assert.equal(stringNode.active, true);
    assert.equal(child.children.filter(node => node.name === 'OriginalBowString').length, 1, 'reuses the string renderer');
    h.ui.destroy();
    assert.equal(h.ui.currentImages.size, 0); assert.equal(h.ui.bowStrings.size, 0, 'destroy releases new image and string references');
  }
});

test('all seven bows retain equal projected height in each rotated UI slot', () => {
  const {fitUiImage}=harness('detail'),keys=config.gunIcons.filter(k=>k.startsWith('bow_'));
  assert.equal(keys.length,7);
  for(const angle of [0,15,22.6,24,-24]) for(const box of [[180,200],[2752,1536],[256,143]]) {
    const heights=keys.map(key=>{
      const image=config.images[key],reference=config.images[image.uiHeightReference];
      const result=fitUiImage(image,box,[.5,.5],angle,reference);
      near(result.size[0]/result.size[1],image.sizePx[0]/image.sizePx[1],'no horizontal stretch');
      const radians=angle*Math.PI/180,ys=image.uiVisibleHullPx.map(([x,y])=>Math.sin(radians)*x-Math.cos(radians)*y);
      return (Math.max(...ys)-Math.min(...ys))*result.size[1]/image.sizePx[1];
    });
    heights.forEach(h=>near(h,heights[0],'projected bow height'));
  }
});

test('crossbow silhouettes stay centered through all weapon UI slots, grade changes and three portrait layouts', () => {
  const raidConfig = require('../assets/resources/art/raid-system/config.json');
  const raidSlot = Object.values(raidConfig.roles).find(role => role.type === 'Raid_GunSlot');
  const crossbowKeys = config.gunIcons.filter(key => key.startsWith('crossbow_'));
  assert.equal(crossbowKeys.length, 8);
  for (const [source, rootName, key] of [[config, 'collection', 'level0:17006'], [config, 'detail', 'level0:1391'],
    [config, 'inventory', 'level0:17458'], [config, 'inventory', 'level0:25887'], [config, 'newGun', 'level0:34100'],
    [raidConfig, 'start', raidSlot.Gun_img], [raidConfig, 'start', raidSlot.Shadow_img]]) {
    const h = harness(rootName, source), slot = h.ui.node(key), child = slot.children.find(node => node.name === 'OriginalImage');
    for (const crossbowKey of crossbowKeys) {
      const sourcePosition = { ...slot.position };
      h.ui.image(key, crossbowKey);
      assert.deepEqual(slot.position, sourcePosition, 'authored parent and shadow placement stay unchanged');
      const image = source.images[crossbowKey];
      for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) {
        h.resize(width, height);
        const slotRect = slot.getComponent(h.UITransform), imageRect = child.getComponent(h.UITransform);
        const factor = imageRect.width / image.sizePx[0];
        let angle=0;
        for(let node=child;node;node=node.parent) angle+=node.angle;
        const radians=angle*Math.PI/180, cosine=Math.cos(radians), sine=Math.sin(radians);
        const rotate=([x,y])=>[cosine*x-sine*y,sine*x+cosine*y];
        const points=image.uiVisibleHullPx.map(([x,y])=>rotate([
          child.position.x+(x-imageRect.anchorX*image.sizePx[0])*factor,
          child.position.y+(image.sizePx[1]-y-imageRect.anchorY*image.sizePx[1])*factor]));
        const expected=rotate([(.5-slotRect.anchorX)*slotRect.width,(.5-slotRect.anchorY)*slotRect.height]);
        near((Math.min(...points.map(p=>p[0]))+Math.max(...points.map(p=>p[0])))/2,
          expected[0],`${rootName}/${crossbowKey}: rotated visible center X`);
        near((Math.min(...points.map(p=>p[1]))+Math.max(...points.map(p=>p[1])))/2,
          expected[1],`${rootName}/${crossbowKey}: rotated visible center Y`);
        near(imageRect.width / imageRect.height, image.sizePx[0] / image.sizePx[1], 'sprite keeps uniform aspect ratio');
      }
    }
    h.ui.destroy();
  }
});

test('UI enlargement validates its optional multiplier and centers the enlarged visible silhouette', () => {
  const { fitUiImage } = harness('detail');
  const image = { sizePx: [256, 143], uiVisibleBoundsPx: [20, 41, 118, 101] };
  for (const uiDisplayScale of [undefined, 0, -1, NaN, Infinity]) {
    const result = fitUiImage({ ...image, uiDisplayScale }, [128, 100], [.5, .5]);
    assert.deepEqual(Array.from(result.size), [128, 71.5], 'invalid or absent scale retains legacy size');
  }
  for (const anchor of [[.5, .5], [.2, .75]]) {
    const result = fitUiImage({ ...image, uiDisplayScale: 1.25 }, [128, 100], anchor);
    assert.deepEqual(Array.from(result.size), [160, 89.375]);
    near(result.position[0] + (69 - anchor[0] * 256) * .625, (.5 - anchor[0]) * 128);
    near(result.position[1] + (72 - anchor[1] * 143) * .625, (.5 - anchor[1]) * 100);
  }
});

test('gloves and their shadows share C-grade projected height and center at each real UI angle', () => {
  const raidConfig = require('../assets/resources/art/raid-system/config.json');
  const gloveKeys = config.gunIcons.filter(key => key.startsWith('claw_'));
  assert.equal(gloveKeys.length, 12);
  const surfaces = [[config, 'collection', 'Gun_Item_Collection'], [config, 'detail', 'Gun_Info_UI'],
    [config, 'inventory', 'Gun_Item'], [config, 'inventory', 'Gun_Slot'], [config, 'newGun', 'NewGun_UI'],
    [raidConfig, 'start', 'Raid_GunSlot'], [raidConfig, 'selection', 'Gun_Item_Demo']];
  for (const [source, rootName, roleType] of surfaces) {
    const role = Object.values(source.roles).find(role => role.type === roleType);
    const h = harness(rootName, source);
    for (const key of [role.Gun_img, role.Shadow_img]) {
      const slot = h.ui.node(key), child = slot.children.find(node => node.name === 'OriginalImage');
      const hitNode = h.ui.node(role.node), sourcePosition = { ...slot.position };
      for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) {
        h.resize(width, height);
        const slotRect = slot.getComponent(h.UITransform), hitRect = hitNode.getComponent(h.UITransform);
        const slotSize = [slotRect.width, slotRect.height], hitBox = hitRect.getBoundingBoxToWorld();
        const reference = source.images.claw_C_1472000.uiHeightReferenceFrame;
        assert.deepEqual(reference.sizePx, [256, 143], 'all gloves retain the original C reference canvas after the C redraw');
        const referenceFactor = Math.min(slotRect.width / reference.sizePx[0], slotRect.height / reference.sizePx[1]);
        for (const gloveKey of gloveKeys) {
          h.ui.image(key, gloveKey);
          const image = source.images[gloveKey];
          const imageRect = child.getComponent(h.UITransform), factor = imageRect.width / image.sizePx[0];
          let angle = 0;
          for (let node = child; node; node = node.parent) angle += node.angle;
          const cosine = Math.cos(angle * Math.PI / 180), sine = Math.sin(angle * Math.PI / 180);
          const rotate = ([x, y]) => [cosine * x - sine * y, sine * x + cosine * y];
          const visible = image.uiVisibleHullPx.map(([x, y]) => rotate([
            child.position.x + (x - imageRect.anchorX * image.sizePx[0]) * factor,
            child.position.y + ((1 - imageRect.anchorY) * image.sizePx[1] - y) * factor]));
          const limits = [Math.min(...visible.map(point => point[0])), Math.min(...visible.map(point => point[1])),
            Math.max(...visible.map(point => point[0])), Math.max(...visible.map(point => point[1]))];
          const target = rotate([(.5 - slotRect.anchorX) * slotRect.width, (.5 - slotRect.anchorY) * slotRect.height]);
          near((limits[0] + limits[2]) / 2, target[0], `${rootName}/${gloveKey}: projected visible center X`);
          near((limits[1] + limits[3]) / 2, target[1], `${rootName}/${gloveKey}: projected visible center Y`);
          const referenceY = reference.uiVisibleHullPx.map(([x, y]) => rotate([x, -y])[1]);
          near(limits[3] - limits[1], (Math.max(...referenceY) - Math.min(...referenceY)) * referenceFactor,
            `${rootName}/${gloveKey}: same-angle C-grade projected height`);
          assert.ok(factor < referenceFactor, '512-pixel artwork fits the frozen low-resolution reference height');
          near(imageRect.width / imageRect.height, image.sizePx[0] / image.sizePx[1], 'enlargement preserves aspect ratio');
          assert.deepEqual(slot.position, sourcePosition, 'authored slot and shadow offsets remain unchanged');
          assert.deepEqual([slotRect.width, slotRect.height], slotSize, 'image fitting leaves the authored slot size fixed');
          const currentHitBox = hitRect.getBoundingBoxToWorld();
          for (const field of ['x', 'y', 'width', 'height']) near(currentHitBox[field], hitBox[field], 'click and drag region remains unchanged');
        }
      }
    }
    h.ui.destroy();
  }
});

test('staff images and shadows remain centered through all UI surfaces, grade changes and portrait resizes', () => {
  const raidConfig = require('../assets/resources/art/raid-system/config.json');
  const staffKeys = config.gunIcons.filter(key => key.startsWith('wand_'));
  assert.equal(staffKeys.length, 11);
  const surfaces = [[config, 'collection', 'Gun_Item_Collection'], [config, 'detail', 'Gun_Info_UI'],
    [config, 'inventory', 'Gun_Item'], [config, 'inventory', 'Gun_Slot'], [config, 'newGun', 'NewGun_UI'],
    [raidConfig, 'start', 'Raid_GunSlot'], [raidConfig, 'selection', 'Gun_Item_Demo']];
  for (const [source, rootName, roleType] of surfaces) {
    const role = Object.values(source.roles).find(role => role.type === roleType), h = harness(rootName, source);
    for (const key of [role.Gun_img, role.Shadow_img]) {
      const slot = h.ui.node(key), child = slot.children.find(node => node.name === 'OriginalImage');
      const hitNode = h.ui.node(role.node);
      for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) {
        h.resize(width, height);
        const originalPosition = { ...slot.position }, slotRect = slot.getComponent(h.UITransform);
        const originalSize = [slotRect.width, slotRect.height], hitBox = hitNode.getComponent(h.UITransform).getBoundingBoxToWorld();
        for (const staffKey of staffKeys) {
          h.ui.image(key, staffKey);
          const image = source.images[staffKey];
          const rect = child.getComponent(h.UITransform), factor = rect.width / image.sizePx[0];
          let angle = 0;
          for (let node = child; node; node = node.parent) angle += node.angle;
          const cosine = Math.cos(angle * Math.PI / 180), sine = Math.sin(angle * Math.PI / 180);
          const rotate = ([x, y]) => [cosine * x - sine * y, sine * x + cosine * y];
          const visible = image.uiVisibleHullPx.map(([x, y]) => rotate([
            child.position.x + (x - rect.anchorX * image.sizePx[0]) * factor,
            child.position.y + ((1 - rect.anchorY) * image.sizePx[1] - y) * factor]));
          const limits = [Math.min(...visible.map(p => p[0])), Math.min(...visible.map(p => p[1])),
            Math.max(...visible.map(p => p[0])), Math.max(...visible.map(p => p[1]))];
          const target = rotate([(.5 - slotRect.anchorX) * slotRect.width, (.5 - slotRect.anchorY) * slotRect.height]);
          near((limits[0] + limits[2]) / 2, target[0], `${rootName}/${staffKey}: projected alpha center X`);
          near((limits[1] + limits[3]) / 2, target[1], `${rootName}/${staffKey}: projected alpha center Y`);
          near(factor, Math.min(slotRect.width / image.sizePx[0], slotRect.height / image.sizePx[1]), 'centering does not change authored staff size');
          near(rect.width / rect.height, image.sizePx[0] / image.sizePx[1], 'staff artwork preserves its aspect ratio');
          assert.deepEqual(slot.position, originalPosition, 'authored slot and shadow offsets remain unchanged');
          assert.deepEqual([slotRect.width, slotRect.height], originalSize, 'image fit does not resize the slot');
          const currentHitBox = hitNode.getComponent(h.UITransform).getBoundingBoxToWorld();
          for (const field of ['x', 'y', 'width', 'height']) near(currentHitBox[field], hitBox[field], 'click and drag region remains unchanged');
        }
      }
    }
    h.ui.destroy();
  }
});

test('hidden daily draw leaves the source-sized ordinary button centered', () => {
  const { node, tr } = harness();
  assert.deepEqual(config.nodes[ids.draw].contentSizeFitter, { horizontalFit: 2, verticalFit: 0 });
  assert.equal(node('daily').active, false);
  near(tr('draw').width, 306.5581970214844);
  near(tr('ordinary').width, 306.5581970214844);
  near(node('ordinary').position.x, 0);
});

test('showing daily draw expands and centers the source horizontal group without shrinking either button', () => {
  const { ui, node, tr, box } = harness(); ui.show(ids.daily, true);
  near(tr('draw').width, 526.5581970214844);
  near(node('draw').position.x, 0);
  near(node('ordinary').position.x, -110);
  near(node('daily').position.x, 163.2790985107422);
  near(tr('ordinary').width, 306.5581970214844);
  near(tr('daily').width, 200);
  near(box('daily').x - box('ordinary').x - box('ordinary').width, 20);
  near(box('currency').x - box('daily').x - box('daily').width, 40.72090148925781);
  near(box('collection').x - box('daily').x - box('daily').width, 40.72090148925781);
});

test('actual daily button hit boxes remain separate and fully inside all acceptance viewports', () => {
  const { ui, box, node, resize } = harness(); ui.show(ids.daily, true);
  for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) {
    resize(width, height); const daily = box('daily'), scale = width / 1080;
    near(daily.width, 200 * scale);
    near(box('currency').x - daily.x - daily.width, 40.72090148925781 * scale);
    assert.ok(daily.x >= -width / 2 && daily.x + daily.width <= width / 2);
    assert.ok(daily.y >= -height / 2 && daily.y + daily.height <= height / 2);
    for (const key of ['ordinary', 'currency', 'collection']) {
      assert.equal(overlap(daily, box(key)), false, `${width}: daily hit box does not overlap ${key}`);
      assert.equal(box(key).contains(node('daily').worldPosition), false, `${width}: daily click cannot hit ${key}`);
    }
    assert.equal(daily.contains(node('daily').worldPosition), true);
  }
});

test('claiming hides the daily button and recenters the ordinary draw immediately', () => {
  const { ui, node, tr } = harness(); ui.show(ids.daily, true); ui.show(ids.daily, false);
  assert.equal(node('daily').active, false);
  near(tr('draw').width, 306.5581970214844);
  near(node('ordinary').position.x, 0);
  near(node('ordinary').worldPosition.x, 0);
});

test('local visibility reflow never resets an in-flight backpack card or drifts after repeated toggles', () => {
  const { ui, node, tr } = harness();
  node('card').setWorldPosition(73, -61); const duringDrag = { ...node('card').worldPosition };
  for (let i = 0; i < 20; i++) {
    ui.show(ids.daily, true); ui.show(ids.daily, true);
    near(tr('draw').width, 526.5581970214844); near(node('ordinary').position.x, -110); near(node('daily').position.x, 163.2790985107422);
    assert.deepEqual(node('card').worldPosition, duringDrag, 'show only lays out Draw and its descendants');
    ui.show(ids.daily, false); ui.show(ids.daily, false);
    near(tr('draw').width, 306.5581970214844); near(node('ordinary').position.x, 0);
    assert.deepEqual(node('card').worldPosition, duringDrag, 'hide only lays out Draw and its descendants');
  }
});

test('resizing respects the current visible children rather than the serialized inactive daily snapshot', () => {
  const { ui, tr, node, resize } = harness();
  ui.show(ids.daily, true); resize(390, 844); resize(412, 915);
  near(tr('draw').width, 526.5581970214844); near(node('ordinary').position.x, -110);
  ui.show(ids.daily, false); resize(360, 640);
  near(tr('draw').width, 306.5581970214844); near(node('ordinary').position.x, 0);
});

test('upgrade cost uses the original TMP baseline and spacing for the gem and digits', () => {
  const { ui, node, tr, rich, art, glyphs, UITransform, Label, Sprite } = harness('star');
  const spec = config.nodes[ids.starPrice].text, font = config.bitmapFonts[spec.profile];
  const gemImage = config.images[config.inlineSprites['1015-0']];
  assert.equal(config.nodes[ids.starPrice].text.spriteAsset, '1015');
  assert.equal(gemImage.source, 'sharedassets0.assets:96');
  assert.equal(gemImage.sourceSpriteAsset, 'sharedassets0.assets:1015');
  assert.equal(gemImage.sourceGlyphIndex, 0);
  assert.equal(spec.profile, '1006:75');
  assert.equal(rich('starPrice'), undefined, 'platform RichText must not choose a different baseline for its image and digits');
  assert.equal(node('starPrice').getComponent(Label).enabled, false);
  assert.equal(node('starPrice').children.some(child => child.name === 'InlineCurrency'), false);
  ui.setText(ids.starPrice, '<sprite=0>250');
  const [gem, two, five, zero] = glyphs('starPrice');
  assert.equal(gem.getComponent(Sprite).spriteFrame, art.frames.get(gemImage.path));
  near(tr('starPrice').width, 200); near(tr('starPrice').height, 50);
  near(node('starPrice').position.y, 6, 'source price box remains six units above the button center');
  near(node('starPrice').getComponent(Label).fontSize, 45);
  near(gem.getComponent(UITransform).width, 48.375); near(gem.getComponent(UITransform).height, 48.375);
  // Source TMP 117163, font 1006, sprite asset 1015: these baselines and
  // advances come from the original face/sprite metrics, not platform text.
  near(gem.position.x, -75.75906224);
  near(gem.position.y, 22.56233137);
  for (const [digit, code, pen] of [[two, '50', -22.70406241], [five, '53', 11.67593741], [zero, '48', 46.05593724]]) {
    near(digit.position.x - font.glyphs[code].bearingX * .5, pen);
    near(digit.position.y - font.glyphs[code].bearingY * .5, -16.98749971);
  }
  const gemCenter = gem.position.y - gem.getComponent(UITransform).height / 2;
  const zeroCenter = zero.position.y - zero.getComponent(UITransform).height / 2;
  near(zeroCenter - gemCenter, 1.05954392, 'the digit and gem visible centers differ by only the original source metric offset');
  assert.equal(font.glyphs['48'].origin, 'source-sdf');
  assert.equal(font.glyphs['50'].origin, 'source-font');
});

test('upgrade cost keeps its source glyph positions through value changes and viewport resizing', () => {
  const { ui, node, tr, glyphs, UITransform, resize } = harness('star');
  for (const value of [50, 100, 200, 250, 1000]) {
    ui.setText(ids.starPrice, `<sprite=0>${value}`);
    const row = glyphs('starPrice');
    assert.equal(row.length, String(value).length + 1);
    const positions = row.map(glyph => ({ ...glyph.position }));
    for (const [width, height] of [[360, 640], [390, 844], [412, 915]]) {
      resize(width, height); near(node('starPrice').position.x, 0); near(tr('starPrice').width, 200);
      assert.deepEqual(glyphs('starPrice').map(glyph => ({ ...glyph.position })), positions);
      near(row[0].getComponent(UITransform).getBoundingBoxToWorld().height, 48.375 * width / 1080);
    }
  }
});

test('upgrade cost uses the source red atlas when unaffordable and MAX leaves no stale gem', () => {
  const { ui, node, glyphs, Sprite, art, bitmapFrames } = harness('star');
  const font = config.bitmapFonts[config.nodes[ids.starPrice].text.profile];
  const gemFrame = art.frames.get(config.images[config.inlineSprites['1015-0']].path);
  ui.setText(ids.starPrice, '<sprite=0>250');
  const [gem, two, five, zero] = glyphs('starPrice'), originals = [two, five, zero].map(glyph => glyph.getComponent(Sprite).spriteFrame);
  ui.tint(ids.starPrice, [255, 95, 95, 255]);
  assert.equal(gem.getComponent(Sprite).spriteFrame, gemFrame, 'the currency artwork retains its source color');
  for (const [index, code] of ['50', '53', '48'].entries()) {
    const frame = [two, five, zero][index].getComponent(Sprite).spriteFrame;
    assert.notEqual(frame, originals[index]);
    assert.deepEqual(Object.values(frame.rect), font.glyphs[code].variants['255,95,95,255'].rect);
  }
  ui.tint(ids.starPrice, [255, 255, 255, 255]);
  assert.ok([two, five, zero].every((glyph, index) => glyph.getComponent(Sprite).spriteFrame === originals[index]));
  const children = [...node('starPrice').children], frames = bitmapFrames.length;
  ui.setText(ids.starPrice, '<sprite=0>250');
  assert.equal(bitmapFrames.length, frames, 'unchanged values allocate no new atlas frame views');
  ui.setText(ids.starPrice, 'MAX');
  assert.equal(glyphs('starPrice').length, 3);
  assert.ok(glyphs('starPrice').every(glyph => glyph.getComponent(Sprite).spriteFrame !== gemFrame));
  assert.equal(zero.active, false, 'unused pooled nodes stop rendering');
  ui.setText(ids.starPrice, '<sprite=0>250');
  assert.deepEqual(node('starPrice').children, children, 'returning from MAX reuses the existing glyph nodes');
  assert.equal(glyphs('starPrice')[0].getComponent(Sprite).spriteFrame, gemFrame);
});

test('weapon assets load every source bitmap page before the HUD can render its price', async () => {
  const { loadWeaponHudAssets, art, frameLoads, fontLoads } = harness('star');
  const assets = await loadWeaponHudAssets(art);
  assert.equal(assets.config, config);
  assert.deepEqual(fontLoads, [], 'Latin atlases and the system Chinese font need no TTF loading');
  const pages = Object.values(config.bitmapFonts).flatMap(font => font.pages);
  assert.ok(pages.length > 0);
  for (const page of pages) {
    assert.ok(frameLoads.includes(page), `missing bitmap page ${page}`);
    assert.ok(fs.existsSync(path.join(root, 'assets/resources', `${page}.png`)), `missing bundled bitmap page ${page}`);
  }
});

test('other currency labels retain their own source sprite-asset indices', () => {
  for (const [root, key, index, image] of [['inventory', 'drawPrice', '1016-1', 's904'], ['newGun', 'adReward', '1018-0', 's372']]) {
    const { rich, art, glyphs, Sprite } = harness(root);
    assert.equal(rich(key), undefined, 'currency shares the bitmap baseline with its source digits');
    assert.equal(config.inlineSprites[index], image);
    assert.equal(glyphs(key)[0].getComponent(Sprite).spriteFrame, art.frames.get(config.images[image].path));
  }
});

test('a separately prepared collection stays hidden throughout real renderer construction',()=>{
  const h=harness('inventory'),ui=new h.OriginalWeaponUi(h.art,h.ui.assets),parent=h.makeNode('DeferredCollection');
  const work=ui.createSteps(config.roots.collection,parent,false);
  let steps=0;
  for(;;){const next=work.next();if(next.done)break;steps++;assert.equal(ui.node(config.roots.collection).active,false);}
  assert.equal(steps,1702);assert.equal(ui.node(config.roots.collection).active,false);
  ui.layout(config.roots.collection,1080,1920);
  assert.ok(ui.node(config.roots.collection).children.length>0);ui.destroy();parent.destroy();
});

test('backpack assets exclude only collection-exclusive artwork and collection loading completes that dependency set',async()=>{
  const h=harness(),common=new Set(h.weaponHudImagePaths(config)),all=new Set(h.weaponHudImagePaths(config,true));
  const manifest=require('./support/resource-modules.cjs').resourceModules()('FeatureResourceManifest');
  assert.deepEqual([...common].sort(),Array.from(manifest.weaponPanelImagePaths(config)).sort(),'background and foreground discover the same panel dependencies');
  const exclusive=[...all].filter(path=>!common.has(path)).sort();
  assert.deepEqual(exclusive, ['s385','s386','s388','s875'].map(name=>config.images[name].path).sort());
  await h.loadWeaponHudAssets(h.art);
  assert.ok(exclusive.every(path=>!h.frameLoads.includes(path)));
  for(const key of config.gunIcons)assert.ok(h.frameLoads.includes(config.images[key].path),'all dynamic backpack previews are ready');
  const before=h.frameLoads.length;await h.loadWeaponCollectionAssets(h.art,config);
  assert.deepEqual(h.frameLoads.slice(before).sort(),exclusive);
});

test('virtual collection rows cover the viewport and one row either side at top, row boundary and bottom',()=>{
  const {weaponCollectionWindow:window}=harness();
  assert.deepEqual(Array.from(window(65,5,240,20,0,1292)),Array.from({length:35},(_,i)=>i));
  assert.deepEqual(Array.from(window(65,5,240,20,260,1292)),Array.from({length:40},(_,i)=>i));
  assert.deepEqual(Array.from(window(65,5,240,20,1868,1292)),Array.from({length:35},(_,i)=>i+30));
  assert.deepEqual(Array.from(window(65,5,240,20,0,250)),Array.from({length:10},(_,i)=>i),'top padding does not count as another visible row');
});

test('one pooled card reproduces all 65 authored cards including grade styling, bow strings and transforms',()=>{
  const {getWeaponGrade}=require('./.build/session/core/WeaponCatalog.js');
  const h=harness('collection'),roles=Object.values(config.roles).find(role=>role.type==='Gun_Collection_UI').Gun_Item_list.map(key=>config.roles[key]);
  const template=roles[0],pool=new h.OriginalWeaponUi(h.art,h.ui.assets),parent=h.makeNode('Pooled');
  const omitted=new Set(roles.map(role=>role.node));
  for(const _ of pool.createSteps(config.roots.collection,parent,false,key=>!omitted.has(key))){}
  const content=pool.node('level0:103947'),unused=new Set(template.Degree_objs.slice(1));
  for(const _ of pool.createSteps(template.node,content,false,key=>!unused.has(key))){}
  pool.layout(config.roots.collection,1080,1920);
  const nodesBefore=[...new Set(pool.nodes.values())];
  const geometry=node=>{const tr=node.getComponent(h.UITransform);return [node.angle,node.scale.x,node.scale.y,node.position.x,node.position.y,tr.width,tr.height,tr.anchorX,tr.anchorY];};
  const walk=(targetId,sourceId,overrides)=>{
    const a=pool.node(targetId),b=h.ui.node(sourceId);
    geometry(a).forEach((n,i)=>near(n,geometry(b)[i],`${sourceId}: geometry ${i}`));
    const imageA=a.children.find(node=>node.name==='OriginalImage'),imageB=b.children.find(node=>node.name==='OriginalImage');
    if(imageA){geometry(imageA).forEach((n,i)=>near(n,geometry(imageB)[i],`${sourceId}: image ${i}`));
      const spriteA=imageA.getComponent(h.Sprite),spriteB=imageB.getComponent(h.Sprite);
      if(spriteA){assert.equal(spriteA.spriteFrame.texture.path,spriteB.spriteFrame.texture.path);assert.deepEqual({...spriteA.color},{...spriteB.color});}
      const stringA=imageA.children.find(n=>n.name==='OriginalBowString'),stringB=imageB.children.find(n=>n.name==='OriginalBowString');
      assert.equal(!!stringA?.active,!!stringB?.active,`${sourceId}: bow string visibility`);
      if(stringB?.active)assert.deepEqual(stringA.getComponent(h.Graphics).points,stringB.getComponent(h.Graphics).points);
    }
    const target=config.nodes[targetId],source=config.nodes[sourceId];
    target.children.forEach((child,i)=>{if(pool.get(child))walk(child,overrides.get(child)||source.children[i],overrides);});
  };
  for(const role of [...roles,...roles.slice().reverse()]){
    const overrides=new Map([[template.Degree_objs[0],role.Degree_objs[getWeaponGrade(role.GunNum)]]]);
    pool.rebindTree(template.node,role.node,overrides);walk(template.node,role.node,overrides);
    assert.deepEqual([...new Set(pool.nodes.values())],nodesBefore,'source UI node identities are reused');
  }
  assert.equal(Object.keys(config.nodes).filter(id=>pool.get(id)).length,26,'12 shell nodes and 14 card nodes');
  pool.destroy();parent.destroy();h.ui.destroy();
});

test('backpack and equipment reuse one grade label with identical rendering across all 65 weapons and resizing',()=>{
  const {getWeaponGrade}=require('./.build/session/core/WeaponCatalog.js');
  const {gradeBadgeRendering}=require('./support/grade-badge-rendering.cjs');
  const h=harness('inventory'),roles=Object.values(config.roles).filter(role=>['Gun_Item','Gun_Slot'].includes(role.type));
  const badges=new h.OriginalGradeBadgePool(roles),ui=new h.OriginalWeaponUi(h.art,h.ui.assets),parent=h.makeNode('CompactInventory');
  for(const _ of ui.createSteps(config.roots.inventory,parent,false,badges.include)){}
  assert.equal(Object.keys(config.nodes).filter(id=>ui.get(id)).length,444,'228 unused authored grade labels are omitted');
  const targets=roles.map(role=>ui.node(role.Degree_objs[0]));
  for(const [width,height] of [[390,844],[412,915]]){
    h.resize(width,height);ui.layout(config.roots.inventory,1080,height*1080/width);
    for(const id of [...Array.from({length:65},(_,i)=>i),...Array.from({length:65},(_,i)=>64-i)])for(const role of roles){
      const grade=getWeaponGrade(id),target=ui.node(role.Degree_objs[0]);
      badges.update(ui,role.Degree_objs,-1);assert.equal(target.active,false,'empty slot hides its sole badge');
      badges.update(ui,role.Degree_objs,grade);assert.equal(target.active,true);
      assert.deepEqual(gradeBadgeRendering(target,h),gradeBadgeRendering(h.ui.node(role.Degree_objs[grade]),h),`${role.type} ${role.node} weapon ${id}`);
      assert.ok(role.Degree_objs.slice(1).every(key=>!ui.get(key)),'no hidden alternate grade renderer is constructed');
    }
  }
  assert.deepEqual(roles.map(role=>ui.node(role.Degree_objs[0])),targets,'grade changes preserve node identity');
  ui.destroy();parent.destroy();h.ui.destroy();
});
