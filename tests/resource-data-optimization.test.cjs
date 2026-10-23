const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { optimizeConfig, compactJson, scan } = require('../tools/optimize-resource-data.cjs');

test('compact serialization preserves exact numeric values, negative zero and escaped text', () => {
  const original = { rotation: [-0, 0, -0.000000000000001, .3535533845424652, 1e30],
    text: '中文 "引号" \\ 路径\n换行', nested: { empty: null, enabled: true } };
  assert.deepEqual(JSON.parse(compactJson(original)), original);
  assert.ok(Object.is(JSON.parse(compactJson(original)).rotation[0], -0));
});

test('font data compaction retains legacy TTF fallback widths and every non-font field', () => {
  const original = {
    textProfiles: { legacy: { advances: { 65: .6, 20013: 1 } }, bitmap: { advances: { 65: .6, 20013: 1 }, outlineColor: [1, 2, 3, 255] } },
    bitmapFonts: { bitmap: { pages: ['atlas'], glyphs: { 65: { advance: 60, variants: {} } } } },
    source: { runtime: true }, particle: { source: { speed: 5 }, curve: [.00001, .9] },
  };
  const config = structuredClone(original);
  optimizeConfig(config);
  assert.deepEqual(config.textProfiles.legacy, original.textProfiles.legacy);
  assert.deepEqual(config.textProfiles.bitmap.advances, {});
  assert.deepEqual(config.bitmapFonts, original.bitmapFonts);
  assert.deepEqual(config.source, original.source);
  assert.deepEqual(config.particle, original.particle);
  assert.deepEqual(config.textProfiles.bitmap.outlineColor, original.textProfiles.bitmap.outlineColor);
  assert.deepEqual(optimizeConfig(config), [], 'second run does not change data');
});

test('removing unreachable kerning pairs preserves placement and advances for every supported glyph pair', () => {
  const original = { pages: ['atlas'], glyphs: { 65: { advance: 60 }, 76: { advance: 58 }, 118: { advance: 51 } },
    kerning: { '76:118': [[0, 1, -5.4], [2, 0, -.25]], '65:65': [[0, 0, 0], [0, 0, 0]],
      '65:20013': [[0, 0, -20], [0, 0, 0]], '20013:76': [[0, 0, 0], [0, 0, -20]] } };
  const font = structuredClone(original);optimizeConfig({ bitmapFont: font });
  for (const left of Object.keys(original.glyphs)) for (const right of Object.keys(original.glyphs)) {
    assert.deepEqual(font.kerning[left + ':' + right], original.kerning[left + ':' + right]);
  }
  assert.ok(font.kerning['65:65'], 'reachable zero pairs are preserved');
  assert.equal(font.kerning['65:20013'], undefined);
  assert.deepEqual(font.glyphs, original.glyphs);
});

test('current source has no unused historical font atlases or reachable font metadata regressions', () => {
  const plan = scan();
  assert.deepEqual(plan.retire, [], 'unused fonts must remain outside the runtime resources tree');
  for (const file of plan.resourceFiles.filter(file => file.endsWith('.json'))) {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(optimizeConfig(structuredClone(config)), [], `unoptimized font data: ${path.relative(__dirname, file)}`);
    // OriginalWeaponUi's production nodes must take the bitmap renderer path.
    if (!config.bitmapFonts || !config.textProfiles) continue;
    for (const node of Object.values(config.nodes ?? {})) {
      if (node.text?.profile) assert.ok(config.bitmapFonts[node.text.profile], `${file}:${node.id}: missing bitmap font`);
    }
  }
});
