const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');
const { pngAlpha } = require('../tools/lib/png-alpha.cjs');
const generator = require('../tools/sync-tree-hit-surfaces.cjs');
const { projectWorld, unprojectGround } = require('./.build/core/projection.js');
const stages = require('../assets/resources/art/stages/config.json');
function load(name, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath(`assets/scripts/view/${name}.ts`), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
  { exports: module.exports, module, require: dep => imports[dep] ?? {} });
  return module.exports;
}
const data = load('TreeHitSurfaceData');
const { treeHitSurface } = load('TreeHitSurface', { './TreeHitSurfaceData': data });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('building hit surfaces are generated from the current artwork, including transparent holes', () => {
  assert.equal(fs.readFileSync(projectPath('assets/scripts/view/TreeHitSurfaceData.ts'), 'utf8'), generator.source());
  for (const sprite of stages.treeSprites) {
    const png = pngAlpha(fs.readFileSync(projectPath('assets/resources', sprite.path + '.png')));
    const surface = data.TREE_HIT_SURFACES[sprite.path];
    assert.equal(surface.width, png.width); assert.equal(surface.height, png.height);
    for (const row of surface.rows) for (let i = 1; i < row.length; i += 2) {
      for (let x = row[i]; x <= row[i + 1]; x++) assert.ok(png.at(x, row[0]) >= 128);
      if (row[i] > 0) assert.ok(png.at(row[i] - 1, row[0]) < 128);
      if (row[i + 1] + 1 < png.width) assert.ok(png.at(row[i + 1] + 1, row[0]) < 128);
    }
  }
});

test('all building hit points land on opaque pixels under scale, bounce, rotation and reflection', () => {
  for (const [index, sprite] of stages.treeSprites.entries()) {
    const png = pngAlpha(fs.readFileSync(projectPath('assets/resources', sprite.path + '.png')));
    const config = index % 4 === 3 ? stages.boss : stages.normal;
    for (const angle of [0, .6]) for (const flip of [1, -1]) {
      const sx = config.skinScale[0] * sprite.localScale[0] * flip, sy = config.skinScale[1] * sprite.localScale[1];
      const ax = { x: Math.cos(angle) * sx * .9, y: Math.sin(angle) * sx * 1.1 * config.projectionScaleY };
      const ay = { x: -Math.sin(angle) * sy * .9, y: Math.cos(angle) * sy * 1.1 * config.projectionScaleY };
      const origin = { x: 13, y: -7 }, determinant = ax.x * ay.y - ax.y * ay.x;
      for (let direction = 0; direction < 16; direction++) {
        const theta = direction * Math.PI / 8;
        const point = { x: origin.x + Math.cos(theta) * 8, y: origin.y + Math.sin(theta) * 8 };
        const hit = treeHitSurface(point, sprite, origin, ax, ay);
        const dx = hit.x - origin.x, dy = hit.y - origin.y;
        const localX = (dx * ay.y - dy * ay.x) / determinant, localY = (dy * ax.x - dx * ax.y) / determinant;
        const pixelX = Math.floor((localX / sprite.sizeUnits[0] + sprite.anchor[0]) * png.width);
        const pixelY = Math.floor((1 - localY / sprite.sizeUnits[1] - sprite.anchor[1]) * png.height);
        assert.ok(png.at(pixelX, pixelY) >= 128, `${index} ${angle} ${flip}: ${pixelX},${pixelY}`);
      }
    }
  }
});

test('the forest-ruins side impact lies outside the scaled stone and is brought onto its visible surface', () => {
  const sprite = stages.treeSprites.find(spec => spec.path === 'art/stages/maps/0/forest_ruins/standing_stone'), config = stages.normal;
  assert.ok(sprite, 'forest-ruins stone remains present after stage reordering');
  const oldPoint = projectWorld({ x: 1, z: 5 }, 2);
  const sx = config.skinScale[0] * sprite.localScale[0], sy = config.skinScale[1] * sprite.localScale[1] * config.projectionScaleY;
  const rightEdge = (1 - sprite.anchor[0]) * sprite.sizeUnits[0] * sx;
  assert.ok(oldPoint.x - rightEdge > 2, 'reproduces the enlarged collider outside the painted stone');
  const hit = treeHitSurface(oldPoint, sprite, { x: 0, y: 0 }, { x: sx, y: 0 }, { x: 0, y: sy });
  assert.ok(hit.x < rightEdge);
  const ground = unprojectGround({ x: hit.x, y: hit.y - projectWorld({ x: 0, z: 0 }, 2).y });
  const projected = projectWorld(ground, 2); near(projected.x, hit.x); near(projected.y, hit.y);
});
