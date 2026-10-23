const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('modal font encoding preserves coverage, dimensions and bounds RGB error', () => {
  const script = `
import sys, io
sys.path.insert(0, 'tools')
from PIL import Image
from font_atlas_encoding import encode_font_atlas
source=Image.new('RGBA',(256,4))
pixels=[(i,(i*17)%256,(i*37)%256,alpha) for alpha in (0,1,127,255) for i in range(256)]
source.putdata(pixels)
result=Image.open(io.BytesIO(encode_font_atlas(source))).convert('RGBA')
assert result.size == source.size
for old,new in zip(pixels,result.getdata()):
 assert old[3] == new[3], 'Coverage/outline alpha changed'
 if old[3]: assert max(abs(a-b) for a,b in zip(old[:3],new[:3])) <= 4, 'Excessive RGB rounding'
assert encode_font_atlas(result) == encode_font_atlas(source), 'Repeated build changed pixels'
`;
  const result = spawnSync('python', ['-B', '-c', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

test('shared font atlases fit the displayed sizes without retaining oversized 2x modal banks', () => {
  const root = path.resolve(__dirname, '../assets/resources/art/latin-fonts');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  for (const font of manifest.fonts.filter(font => font.id !== 'hud')) {
    assert.ok(font.rasterScale >= 1 && font.rasterScale <= 1.25, font.id);
    assert.ok(font.rasterScale * 90 >= font.maxDisplaySize * 1.5, `${font.id}: insufficient density`);
  }
  // Includes adventure's supplementary colours. Previously its 213 MiB of
  // independent pages were absent from this manifest and the old 120 MiB cap.
  assert.ok(manifest.rgbaBytes < 135 * 1024 * 1024, 'Generated font texture budget regressed');
});

test('adventure uses shared font pages with source metrics and bounded density', () => {
  const root = path.resolve(__dirname, '../assets/resources');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'art/adventure-system/config.json'), 'utf8'));
  const pages = new Set();
  for (const [key, font] of Object.entries(config.bitmapFonts)) {
    const profile = config.textProfiles[key];
    assert.deepEqual(font.source, profile.source, key);
    for (const field of ['pointSize', 'scale', 'ascent', 'descent']) assert.equal(font[field], profile[field], `${key}:${field}`);
    assert.ok(font.rasterScale >= 1 && font.rasterScale <= 1.25, key);
    for (const page of font.pages) {
      assert.ok(page.startsWith('art/latin-fonts/'), page);
      pages.add(page);
    }
  }
  let rgbaBytes = 0;
  for (const page of pages) {
    const png = fs.readFileSync(path.join(root, page + '.png'));
    rgbaBytes += png.readUInt32BE(16) * png.readUInt32BE(20) * 4;
  }
  assert.ok(rgbaBytes < 60 * 1024 * 1024, 'Adventure reintroduced oversized independent font pages');
  assert.ok([...pages].some(page => !page.includes('/latin-extra-')), 'Adventure stopped sharing common glyphs');
});
