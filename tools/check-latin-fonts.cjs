'use strict';
// Validate generated fonts without requiring the original Unity evidence/tools.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const art = path.join(root, 'assets/resources/art');
const codes = [...Array.from({ length: 95 }, (_, i) => String(i + 32)), '215', '247', '8722'];
const allowed = new Set(codes);
const pages = new Map();
let fonts = 0, texts = 0;
function check(font, name) {
  fonts++;
  assert.deepEqual(Object.keys(font.glyphs).sort(), [...codes].sort(), `${name}: Latin character coverage`);
  for (const code of Object.keys(font.glyphs)) assert.ok(allowed.has(code), `${name}: unexpected character ${code}`);
  for (const page of font.pages) {
    assert.ok(page.startsWith('art/latin-fonts/'), `${name}: historical Chinese atlas dependency`);
    if (pages.has(page)) continue;
    const file = path.join(root, 'assets/resources', page + '.png');
    const png = fs.readFileSync(file);
    assert.equal(png.subarray(1, 4).toString(), 'PNG', page);
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    const meta = JSON.parse(fs.readFileSync(file + '.meta', 'utf8'));
    const info = meta.subMetas.f9941.userData;
    assert.equal(info.width, width, page); assert.equal(info.height, height, page);
    assert.equal(info.packable, false, page);
    pages.set(page, { width, height, bytes: png.length });
  }
  for (const [code, glyph] of Object.entries(font.glyphs)) {
    assert.ok(Number.isFinite(glyph.advance), `${name}:${code}: advance`);
    if (glyph.empty) continue;
    assert.ok(glyph.variants['255,255,255,255'], `${name}:${code}: white base`);
    for (const variant of Object.values(glyph.variants)) {
      const page = pages.get(font.pages[variant.page]);
      assert.ok(page, `${name}:${code}: page index`);
      const [x, y, width, height] = variant.rect;
      assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= page.width && y + height <= page.height,
        `${name}:${code}: glyph rectangle`);
    }
  }
}
for (const entry of fs.readdirSync(art, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(art, entry.name, 'config.json');
  if (!fs.existsSync(file)) continue;
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.bitmapFont) check(config.bitmapFont, entry.name);
  for (const [key, font] of Object.entries(config.bitmapFonts || {})) check(font, `${entry.name}:${key}`);
  for (const node of Object.values(config.nodes || {})) {
    if (!node.text) continue;
    texts++;
    assert.ok(config.bitmapFonts?.[node.text.profile], `${entry.name}:${node.id}: missing text profile`);
    const font = config.bitmapFonts[node.text.profile], color = node.text.color.join(',');
    for (const ch of node.text.value.replace(/<[^>]*>/g, '')) {
      const glyph = font.glyphs[String(ch.codePointAt(0))];
      if (glyph && !glyph.empty) assert.ok(glyph.variants[color], `${entry.name}:${node.id}:${ch}: authored color`);
    }
  }
  if (config.input?.bitmapFont) {
    check(config.input.bitmapFont, `${entry.name}:input`);
    assert.equal(config.input.bitmapFont.source.fontFile, 'sharedassets0.assets:317');
  }
}
const hud = JSON.parse(fs.readFileSync(path.join(art, 'hud/config.json'), 'utf8')).bitmapFont;
assert.equal(hud.rasterScale, 1); assert.equal(hud.pages.length, 1);
assert.equal(hud.source.font, 'sharedassets0.assets:1006');
console.log(JSON.stringify({ fonts, texts, uniquePages: pages.size,
  pngBytes: [...pages.values()].reduce((n, p) => n + p.bytes, 0),
  rgbaBytes: [...pages.values()].reduce((n, p) => n + p.width * p.height * 4, 0) }));
