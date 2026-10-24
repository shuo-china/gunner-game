const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { inflateSync } = require('node:zlib');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');
const map = require('../assets/resources/art/maps/forest/map.json');
const { skins } = require('../assets/resources/art/stages/config.json');
const moduleContext = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view/MapBorderGeometry.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText, moduleContext);
const { MAP_BORDER_SEAMS, createMapBorderGeometry } = moduleContext.exports;
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);

test('all ten wall skins keep their bounds, anchors, UV coverage and winding when seam geometry is reused', () => {
  let topology;
  for (const [skinIndex, skin] of skins.entries()) for (const key of ['borderUp', 'borderDown']) {
    const spec = skin.sprites[key], seam = key === 'borderUp' ? MAP_BORDER_SEAMS[skinIndex] : undefined;
    const geometry = createMapBorderGeometry(spec, seam);
    assert.equal(geometry.positions.length, geometry.uv.length);
    assert.ok(geometry.indices.every(index => Number.isInteger(index) && index >= 0 && index < geometry.positions.length));
    const current = JSON.stringify([geometry.positions.length, geometry.indices]);
    topology ??= current;
    assert.equal(current, topology, 'swapping skins must fit the mesh buffers allocated for the first correction');
    let changed = 0;
    for (const [index, point] of geometry.positions.entries()) {
      const [u, v] = geometry.uv[index], originalY = (v - spec.anchor[1]) * spec.sizeUnits[1];
      assert.ok(point.every(Number.isFinite)); assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1);
      near(point[0], (u - spec.anchor[0]) * spec.sizeUnits[0], 'horizontal anchors remain authored');
      near(point[2], 0, 'border geometry stays in its local plane');
      if (Math.abs(point[1] - originalY) > 1e-8) changed++;
      if (!seam || u * spec.sizePx[0] >= 64 || v === 0 || v === 1) {
        near(point[1], originalY, `${skinIndex}/${key}: top, floor and interior remain untouched`);
      }
      assert.ok(point[1] >= -spec.anchor[1] * spec.sizeUnits[1] - 1e-8);
      assert.ok(point[1] <= (1 - spec.anchor[1]) * spec.sizeUnits[1] + 1e-8);
    }
    assert.equal(changed > 0, !!seam, 'only the three mismatched upper lips deform');
    for (let offset = 0; offset < geometry.indices.length; offset += 3) {
      const [a, b, c] = geometry.indices.slice(offset, offset + 3).map(index => geometry.positions[index]);
      assert.ok((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0,
        `${skinIndex}/${key}: no folded or degenerate triangles`);
    }
  }
});

// Decode the actual border pixels: the seam calibration must fail when art
// changes, rather than continuing to pass against a copied landmark fixture.
function readRgba(resourcePath) {
  const bytes = fs.readFileSync(projectPath(`assets/resources/${resourcePath}.png`));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes[24], 8); assert.equal(bytes[25], 6); assert.equal(bytes[28], 0);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 4, pixels = Buffer.alloc(width * height * 4);
  assert.equal(raw.length, (stride + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) {
    const filter = raw[y * (stride + 1)], left = x < 4 ? 0 : pixels[y * stride + x - 4];
    const up = y ? pixels[(y - 1) * stride + x] : 0, diagonal = y && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
    let predictor = 0;
    if (filter === 1) predictor = left;
    else if (filter === 2) predictor = up;
    else if (filter === 3) predictor = Math.floor((left + up) / 2);
    else if (filter === 4) {
      const p = left + up - diagonal, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - diagonal);
      predictor = a <= b && a <= c ? left : b <= c ? up : diagonal;
    } else assert.equal(filter, 0);
    pixels[y * stride + x] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
  }
  return { width, height, pixel: (x, y) => pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4) };
}

function lipAt(image, x) {
  const column = value => {
    const ix = Math.max(0, Math.min(image.width - 1, value)), background = image.pixel(ix, 0);
    for (let y = 0; y < image.height; y++) {
      const color = image.pixel(ix, y);
      if (color[3] > 127 && color.slice(0, 3).reduce((sum, value, index) => sum + Math.abs(value - background[index]), 0) > 90) return y;
    }
    assert.fail('wall lip is missing from the source edge');
  };
  const floor = Math.floor(x), fraction = x - floor;
  return column(floor) * (1 - fraction) + column(floor + 1) * fraction;
}

function localPoint(geometry, spec, x, y) {
  const u = x / spec.sizePx[0], v = 1 - y / spec.sizePx[1];
  for (let offset = 0; offset < geometry.indices.length; offset += 3) {
    const ids = geometry.indices.slice(offset, offset + 3), [a, b, c] = ids.map(index => geometry.uv[index]);
    const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    const first = ((b[1] - c[1]) * (u - c[0]) + (c[0] - b[0]) * (v - c[1])) / denominator;
    const second = ((c[1] - a[1]) * (u - c[0]) + (a[0] - c[0]) * (v - c[1])) / denominator;
    const weights = [first, second, 1 - first - second];
    if (weights.some(weight => weight < -1e-8)) continue;
    return [0, 1].map(axis => ids.reduce((sum, index, corner) => sum + geometry.positions[index][axis] * weights[corner], 0));
  }
  assert.fail(`source point outside mesh: ${x}, ${y}`);
}

test('wood, cake and castle wall lips join at both authored overlap widths and drawing orders', () => {
  const upper = map.borders.map((border, order) => ({ ...border, order })).filter(border => border.asset === 'borderUp')
    .sort((left, right) => left.position[0] - right.position[0]);
  let reversedOrder = 0;
  for (const skinIndex of [1, 6, 9]) {
    const spec = skins[skinIndex].sprites.borderUp, image = readRgba(spec.path);
    const corrected = createMapBorderGeometry(spec, MAP_BORDER_SEAMS[skinIndex]), original = createMapBorderGeometry(spec);
    assert.deepEqual([image.width, image.height], spec.sizePx);
    for (let index = 1; index < upper.length; index++) {
      const left = upper[index - 1], right = upper[index];
      const unitsPerPixelX = left.axisX[0] * spec.sizeUnits[0] / image.width;
      const unitsPerPixelY = left.axisY[1] * spec.sizeUnits[1] / image.height;
      const stride = (right.position[0] - left.position[0]) / unitsPerPixelX;
      const rightDrawnLast = right.order > left.order;
      const xLeft = rightDrawnLast ? stride : image.width, xRight = rightDrawnLast ? 0 : image.width - stride;
      if (!rightDrawnLast) reversedOrder++;
      const worldY = (mesh, border, x) => {
        const point = localPoint(mesh, spec, x, lipAt(image, x));
        return border.position[1] + border.axisX[1] * point[0] + border.axisY[1] * point[1];
      };
      const before = Math.abs(worldY(original, left, xLeft) - worldY(original, right, xRight)) / unitsPerPixelY;
      const after = Math.abs(worldY(corrected, left, xLeft) - worldY(corrected, right, xRight)) / unitsPerPixelY;
      assert.ok(before > 5, `skin ${skinIndex}: this seam reproduces the source discontinuity`);
      assert.ok(after < 2, `skin ${skinIndex}, ${left.name} → ${right.name}: ${before.toFixed(2)}px → ${after.toFixed(2)}px`);
    }
  }
  assert.ok(reversedOrder > 0, 'the authored nonspatial draw order is covered as well as adjacent grid pairs');
});
