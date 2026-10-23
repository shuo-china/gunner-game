const assert = require('node:assert/strict');
const { inflateSync } = require('node:zlib');

// Decode noninterlaced 8-bit RGBA and indexed PNGs directly so stale registration
// data cannot make an asset check pass after the artwork itself has changed.
function pngAlpha(buffer, threshold = 16) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  assert.equal(buffer[24], 8, '8-bit exported PNG');
  const indexed = buffer[25] === 3;
  assert.ok(indexed || buffer[25] === 6, 'RGBA or indexed exported PNG');
  assert.equal(buffer[28], 0, 'noninterlaced exported PNG');
  const chunks = []; let paletteEntries = 0, transparency = Buffer.alloc(0);
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), kind = buffer.toString('ascii', offset + 4, offset + 8);
    if (kind === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (kind === 'PLTE') { assert.equal(length % 3, 0); paletteEntries = length / 3; }
    if (kind === 'tRNS') transparency = buffer.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
  }
  if (indexed) {
    assert.ok(paletteEntries > 0 && paletteEntries <= 256, 'indexed PNG palette');
    assert.ok(transparency.length <= paletteEntries, 'indexed PNG alpha entries');
  }
  const bytesPerPixel = indexed ? 1 : 4;
  const data = inflateSync(Buffer.concat(chunks)), stride = width * bytesPerPixel;
  assert.equal(data.length, height * (stride + 1));
  let previous = Buffer.alloc(stride), left = width, top = height, right = 0, bottom = 0;
  const alpha = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), filter = data[start], row = Buffer.alloc(stride);
    assert.ok(filter <= 4, `valid PNG scanline filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0, b = previous[x], c = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      if (filter === 2) predictor = b;
      if (filter === 3) predictor = Math.floor((a + b) / 2);
      if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = (data[start + x + 1] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      if (indexed) {
        const index = row[x];
        assert.ok(index < paletteEntries, 'pixel references a defined palette entry');
        alpha[y * width + x] = index < transparency.length ? transparency[index] : 255;
      } else alpha[y * width + x] = row[x * 4 + 3];
      if (alpha[y * width + x] < threshold) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
    previous = row;
  }
  return { width, height, bounds: right > left ? [left, top, right, bottom] : null,
    at: (x, y) => alpha[Math.floor(y) * width + Math.floor(x)] };
}

module.exports = { pngAlpha };
