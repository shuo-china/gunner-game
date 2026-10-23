const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { pngAlpha } = require('../tools/lib/png-alpha.cjs');

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
function png({ type = 3, width = 4, height = 2, rows, alpha, palette = true }) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = type;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    ...(type === 3 && palette ? [chunk('PLTE', Buffer.from([0,0,0, 88,63,33, 255,233,193, 248,151,57]))] : []),
    ...(alpha ? [chunk('tRNS', Buffer.from(alpha))] : []), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('PNG8 alpha decoder handles Sub/Up filters and implicit opaque palette entries', () => {
  const image = pngAlpha(png({ rows: [1,0,1,1,1, 2,3,1,255,253], alpha: [0,64,128] }), 127);
  assert.deepEqual([image.width, image.height, image.bounds], [4,2,[0,0,4,2]]);
  assert.deepEqual([0,1,2,3].map(x => image.at(x,0)), [0,64,128,255]);
  assert.deepEqual([0,1,2,3].map(x => image.at(x,1)), [255,128,64,0]);
});
test('PNG8 without tRNS remains opaque and invalid palette references are rejected', () => {
  assert.deepEqual(pngAlpha(png({ rows: [0,0,1,2,3, 0,3,2,1,0] })).bounds, [0,0,4,2]);
  assert.throws(() => pngAlpha(png({ rows: [0,4,1,2,3, 0,3,2,1,0] })), /defined palette/);
  assert.throws(() => pngAlpha(png({ rows: [0,0,1,2,3, 0,3,2,1,0], palette: false })), /palette/);
});
test('RGBA decoding still uses four-byte filter stride and the requested alpha threshold', () => {
  const image = pngAlpha(png({ type:6,width:2,height:1,rows:[1,88,63,33,0, 0,0,0,128] }), 127);
  assert.deepEqual(image.bounds,[1,0,2,1]); assert.equal(image.at(0,0),0); assert.equal(image.at(1,0),128);
});
