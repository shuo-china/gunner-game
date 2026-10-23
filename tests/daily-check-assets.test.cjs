const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const resources = path.resolve(__dirname, '../assets/resources');
const config = require('../assets/resources/art/daily-check-system/config.json');
const entry = require('../assets/resources/art/feature-entries/dailyCheck.json');
const roles = config.dailyCheckUi;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.001, `${actual} != ${expected}`);

test('seven-day cards retain the original 3+3+1 geometry and source state layers', () => {
  assert.equal(config.roots.dailyCheck, 'level0:11219');
  assert.equal(config.roots.panel, config.roots.dailyCheck, 'panel is an alias, not a duplicate tree');
  assert.equal(roles.panel, config.roots.dailyCheck);
  assert.equal(roles.background, 'level0:28272');
  assert.deepEqual(config.nodes[roles.background].image.color, [103, 90, 52, 224]);
  assert.deepEqual(config.nodes[roles.close].rect.position, [0, -655]);
  assert.deepEqual(config.nodes[roles.close].rect.size, [100, 100]);
  assert.deepEqual(roles.cards.map(card => card.index), [0, 1, 2, 3, 4, 5, 6]);
  const originalPositions = [[-305, 417.0846], [0, 417.0846], [305, 417.0846], [-305, 82], [0, 82], [305, 82], [0, -275]];
  const roots = new Set();
  for (const card of roles.cards) {
    assert.ok(!roots.has(card.root)); roots.add(card.root);
    const node = config.nodes[card.root];
    node.rect.position.forEach((value, axis) => near(value, originalPositions[card.index][axis]));
    near(node.rect.size[0], card.index === 6 ? 911.1 : 280);
    assert.equal(node.rect.size[1], 320);
    assert.equal(config.nodes[card.date].text.value, `Day ${card.index + 1}`);
    assert.equal(config.nodes[card.date].text.size, 35);
    assert.equal(config.nodes[card.amount].text.size, 40);
    assert.equal(config.nodes[card.getable].active, false);
    assert.equal(config.nodes[card.claimed].active, false);
    assert.equal(config.images[config.nodes[card.glow].image.sprite].source, 'sharedassets0.assets:880');
    for (const field of ['root', 'amount', 'getable', 'claimed', 'glow', 'date']) assert.ok(config.nodes[card[field]], `${card.index}:${field}`);
  }
  assert.equal(config.rotations.length, 7);
  for (const rotation of config.rotations) {
    assert.ok(roles.cards.some(card => card.glow === rotation.node));
    assert.equal(rotation.duration, 1); assert.equal(rotation.angle, -180);
    assert.deepEqual(rotation.end, [0, 0, -180]);
    assert.equal(rotation.relative, false); assert.equal(rotation.rotationMode, 0);
    assert.equal(rotation.from, false); assert.equal(rotation.autoPlay, true);
    assert.equal(rotation.independentUpdate, false); assert.equal(rotation.ease, 1);
    assert.equal(rotation.loopType, 2); assert.equal(rotation.loops, -1);
    const glow = config.nodes[rotation.node].rect;
    near(glow.angle, -148.507374); glow.scale.forEach(value => near(value, 1.2));
    near(rotation.end[2] - glow.angle, -31.492626);
  }
});

test('art cannot supply reward amounts or expose the original external promotion and test controls', () => {
  for (const card of roles.cards) assert.equal(config.nodes[card.amount].text.value, '', 'amount must be filled from the economy snapshot');
  assert.equal(config.nodes[roles.moneyText].text.value, '');
  assert.equal(config.nodes[roles.diamondText].text.value, '');
  assert.equal(config.DiaReward_list, undefined);
  assert.equal(JSON.stringify(config).includes('"DiaReward_list"'), false);
  const forbiddenNames = /Coupang|Test_obj|Event_obj|Purchase|InApp/i;
  for (const node of Object.values(config.nodes)) {
    assert.equal(forbiddenNames.test(node.name), false, node.name);
    assert.ok(node.children.every(child => config.nodes[child]), `${node.id} has an unexported child`);
    for (const button of node.button || []) assert.equal(/Coupang|Test_Btn|Purchase/i.test(button.method), false);
  }
  assert.deepEqual(Object.keys(entry.roots), ['entry']);
  assert.equal(entry.roots.entry, config.roots.entry);
  assert.equal(Object.keys(entry.nodes).length, 1, 'entry excludes the unrelated external-promotion badge');
  const button = entry.nodes[entry.roots.entry];
  assert.deepEqual(button, config.nodes[config.roots.entry], 'build synchronization preserves every authored entry property');
  assert.deepEqual(button.entryLayout, { parentSizeDelta: [-980, -1820] });
  assert.equal(button.active, true); assert.deepEqual(button.rect.size, [65, 65]);
  near(button.rect.position[0], -357.3); assert.equal(button.rect.position[1], 812);
  assert.equal(entry.images[button.image.sprite].source, 'sharedassets0.assets:752');
});

test('daily text reuses the exact native white glyphs and atlas rectangles without adding TTF dependencies', () => {
  const existing = require('../assets/resources/art/mine-system/config.json').bitmapFonts['1006:75'];
  const font = config.bitmapFonts['1006:75'];
  assert.deepEqual(Object.keys(config.bitmapFonts), ['1006:75']);
  assert.deepEqual(font.source, { font: 'sharedassets0.assets:1006', material: 'sharedassets0.assets:75', fontFile: 'sharedassets0.assets:320' });
  for (const key of ['pointSize', 'scale', 'ascent', 'descent', 'lineHeight', 'kerning', 'rasterScale']) assert.deepEqual(font[key], existing[key], key);
  for (const [code, glyph] of Object.entries(font.glyphs)) {
    const original = existing.glyphs[code]; assert.ok(original, code);
    const { variants, ...metrics } = glyph, { variants: originalVariants, ...originalMetrics } = original;
    assert.deepEqual(metrics, originalMetrics, `glyph ${code} metrics`);
    const variant = variants['255,255,255,255'], source = originalVariants['255,255,255,255'];
    if (variant) {
      assert.deepEqual(variant.rect, source.rect, `glyph ${code} pixels`);
      assert.equal(font.pages[variant.page], existing.pages[source.page], `glyph ${code} atlas`);
    }
  }
  for (const character of 'Day 0123456789.,ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') assert.ok(font.glyphs[String(character.codePointAt(0))], character);
  assert.ok(font.pages.length >= 1 && font.pages.length <= 2, 'display-size atlases retain every glyph using at most the original two pages');
  assert.ok(font.pages.every(page => page.startsWith('art/latin-fonts/')));
  assert.equal(config.fonts, undefined); assert.equal(config.fontVariants, undefined);
  for (const node of Object.values(config.nodes)) if (node.text) assert.equal(node.text.profile, '1006:75');
});

test('all image dimensions, nine-slice borders, shared font pages and metadata resolve locally', () => {
  assert.equal(Object.keys(config.images).length, 13);
  for (const image of Object.values(config.images)) {
    const file = path.join(resources, image.path + '.png'), bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], image.sizePx, image.path);
    const frame = JSON.parse(fs.readFileSync(file + '.meta')).subMetas.f9941.userData;
    const importedBorder = image.border.slice();
    if (image.source === 'sharedassets0.assets:658' || image.source === 'sharedassets0.assets:499') {
      // These original Unity borders total 78 vertically on a 76px image.
      // Cocos 3.8.8 retains the 34px top and clamps bottom to height - top (42).
      assert.deepEqual(image.sizePx, [64, 76], image.path);
      assert.deepEqual(image.border, [32, 44, 32, 34], image.path);
      importedBorder[1] = image.sizePx[1] - image.border[3];
    }
    assert.deepEqual([frame.borderLeft, frame.borderBottom, frame.borderRight, frame.borderTop], importedBorder, image.path);
  }
  for (const page of config.bitmapFonts['1006:75'].pages) {
    assert.ok(fs.existsSync(path.join(resources, page + '.png')));
    assert.ok(fs.existsSync(path.join(resources, page + '.png.meta')));
  }
  for (const resource of ['art/daily-check-system/config.json', 'art/feature-entries/dailyCheck.json']) assert.ok(fs.existsSync(path.join(resources, resource + '.meta')));
});

test('claim feedback retains eight original particles, attractor curves and arrival bounce', () => {
  const fx = config.diamondFx, particle = fx.particle;
  assert.equal(fx.source, 'level0:124527'); assert.equal(fx.count, 8);
  assert.equal(config.images[fx.image].source, 'sharedassets0.assets:904');
  assert.equal(fx.arrivalSound, 14); assert.equal(fx.claimSound, 7);
  assert.equal(particle._lifetime.m_ConstantMin, 0.5); assert.equal(particle._lifetime.m_ConstantMax, 1);
  assert.equal(particle._startSpeed.m_ConstantMin, 1); assert.equal(particle._startSpeed.m_ConstantMax, 15);
  assert.equal(particle._startSize.mainCurve.m_ConstantMax, 60);
  assert.equal(particle._radius, 50); assert.equal(particle._emitOnSurface, 1);
  assert.equal(particle._targetModule.enabled, 1); assert.equal(particle._toTarget.m_Mode, 2);
  for (const curve of [particle._toTarget.m_CurveMin, particle._toTarget.m_CurveMax]) {
    assert.equal(curve.m_Curve.length, 2); assert.ok(curve.m_Curve[0].time > 0.69 && curve.m_Curve[0].time < 0.70);
    assert.equal(curve.m_Curve.at(-1).time, 1); assert.equal(curve.m_Curve.at(-1).value, 1);
  }
  assert.equal(particle._vortexModule.enabled, 1); assert.equal(particle._velocityModule.enabled, 1);
  assert.equal(particle._noiseModule.enabled, 0); assert.equal(particle._gravityModule.enabled, 0); assert.equal(particle._trailModule.enabled, 0);
  assert.equal(particle._onParticleFinish.m_PersistentCalls.m_Calls[0].m_MethodName, 'Dia_FX_End');
  assert.equal(roles.diamondTarget, 'level0:23329');
  assert.equal(roles.diamondBounce.node, 'level0:32529');
  near(roles.diamondBounce.scale, 0.9); near(roles.diamondBounce.duration, 0.2);
});
