const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inflateSync, deflateSync } = require('node:zlib');

const root = path.resolve(__dirname, '..');
const sources = [
  'art/effects/original-feedback.json', 'art/effects/money-numbers/config.json',
  'art/weapon-system/critical/config.json', 'art/mine-system/diamond-numbers/config.json',
];
const target = 'art/effects/number-atlas';
const padding = 2, width = 512;

// The exported source glyphs are noninterlaced RGBA8 PNGs. Keep every color
// channel, including RGB under transparent pixels, unchanged when packing.
function decodeRgba(png) {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png[24] !== 8 || png[25] !== 6 || png[28] !== 0) throw new Error('Expected RGBA8 PNG');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 4, rgba = Buffer.alloc(width * height * 4);
  if (raw.length !== (stride + 1) * height) throw new Error('Invalid PNG scanline size');
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error(`Unknown PNG filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x >= 4 ? rgba[at - 4] : 0;
      const up = y > 0 ? rgba[at - stride] : 0, upperLeft = x >= 4 && y > 0 ? rgba[at - stride - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = up;
      if (filter === 3) predictor = Math.floor((left + up) / 2);
      if (filter === 4) {
        const p = left + up - upperLeft, a = Math.abs(p-left), b = Math.abs(p-up), c = Math.abs(p-upperLeft);
        predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      }
      rgba[at] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  return { width, height, rgba };
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind, data) {
  const type = Buffer.from(kind), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); type.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([type, data])), result.length - 4); return result;
}
function encodeRgba(width, height, rgba) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function buildAtlas() {
  const glyphPaths = new Set();
  for (const source of sources) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'assets/resources', source), 'utf8'));
    for (const spec of Object.values((config.damage ?? config).glyphs)) glyphPaths.add(spec.path);
  }
  const glyphs = Array.from(glyphPaths, resource => ({ resource,
    ...decodeRgba(fs.readFileSync(path.join(root, 'assets/resources', `${resource}.png`))) }));
  glyphs.sort((a,b) => b.height-a.height || b.width-a.width || a.resource.localeCompare(b.resource, 'en'));
  let x = 0, y = 0, rowHeight = 0;
  const frames = {};
  for (const glyph of glyphs) {
    const w = glyph.width + padding * 2, h = glyph.height + padding * 2;
    if (w > width) throw new Error('Glyph exceeds atlas width');
    if (x + w > width) { x = 0; y += rowHeight; rowHeight = 0; }
    glyph.x = x + padding; glyph.y = y + padding;
    frames[glyph.resource] = { rect: [glyph.x, glyph.y, glyph.width, glyph.height],
      rgbaSha256: crypto.createHash('sha256').update(glyph.rgba).digest('hex') };
    x += w; rowHeight = Math.max(rowHeight, h);
  }
  const height = 2 ** Math.ceil(Math.log2(y + rowHeight)), rgba = Buffer.alloc(width * height * 4);
  for (const glyph of glyphs) {
    // Extrude the source edge through the gutter, reproducing clamp-to-edge
    // linear sampling at the original glyph boundary without neighbor bleed.
    for (let gy = -padding; gy < glyph.height + padding; gy++) for (let gx = -padding; gx < glyph.width + padding; gx++) {
      const from = (Math.min(glyph.height - 1, Math.max(0, gy)) * glyph.width + Math.min(glyph.width - 1, Math.max(0, gx))) * 4;
      glyph.rgba.copy(rgba, ((glyph.y + gy) * width + glyph.x + gx) * 4, from, from + 4);
    }
  }
  return { png: encodeRgba(width, height, rgba), manifest: { atlas: `${target}/atlas`, width, height, padding, frames } };
}
function main() {
  const { png, manifest } = buildAtlas(), directory = path.join(root, 'assets/resources', target);
  const outputs = [['atlas.png', png], ['config.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]];
  if (process.argv.includes('--check')) {
    for (const [file, bytes] of outputs) if (!fs.existsSync(path.join(directory, file)) || !fs.readFileSync(path.join(directory, file)).equals(bytes)) throw new Error(`Stale number atlas: ${file}`);
  } else {
    fs.mkdirSync(directory, { recursive: true });
    for (const [file, bytes] of outputs) fs.writeFileSync(path.join(directory, file), bytes);
  }
  console.log(`Number atlas: ${Object.keys(manifest.frames).length} glyphs, ${manifest.width}x${manifest.height}${process.argv.includes('--check') ? ' verified' : ' written'}`);
}
if (require.main === module) main();
module.exports = { decodeRgba, buildAtlas };
