const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');
const projection = require('./.build/core/projection.js');
const particleMath = require('./.build/feedback/view/OriginalParticleSimulation.js');
function load(name, imports) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath(`assets/scripts/view/${name}.ts`), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
  { exports: module.exports, module, require: dependency => imports[dependency] ?? {} });
  return module.exports;
}
const math = load('CustomProjectileMotion', { '../core/projection': projection, './OriginalParticleSimulation': particleMath });
const curve = { mode: 1, value: 1, min: 1, keys: [{ time: 0, value: 1, inSlope: -1, outSlope: -1 }, { time: 1, value: 0, inSlope: -1, outSlope: -1 }], minKeys: [] };
const profile = kind => ({ body: 'painted', bodyLength: kind === 'arrow' ? 5.22 : 4.2, spinSpeed: kind === 'arrow' ? 0 : 20,
  anchor: kind === 'arrow' ? 'tip' : 'center', hitTrigger: kind === 'arrow' ? 'impact' : 'hit',
  sprite: { path: kind, width: kind === 'arrow' ? 128 : 64, height: kind === 'arrow' ? 32 : 64,
    aspect: kind === 'arrow' ? 126 / 29 : 1, uv: kind === 'arrow' ? [1 / 128, 1 / 32, 127 / 128, 30 / 32] : [1 / 64, 1 / 64, 63 / 64, 63 / 64] },
  bodyPalette: { shadow: [.3, .2, .1], mid: [.807843, .568627, .384314], highlight: [.9, .8, .7], strength: .94 },
  flightRamp: { duration: .26, spinStart: .65 },
  ...(kind === 'arrow' ? { airFlow: { image: { path: 'ring' }, period: .12, flowPeriod: .24, maxSizeScale: .85,
    extension: { start: .19, duration: .17, length: .23 }, innerColor: [1, .9, .8, 1] } } : {
    afterimage: { angleLag: .48, alpha: .16 },
    cometTrail: { image: { path: 'circle' }, minLifetime: .035, lifetime: .18, distanceStep: .5, scale: .3535714,
      coreScale: .4444445, sizeCurve: curve, attachment: .16, coreBlendLength: 1.7, outerColor: [.6, .3, .1, 1], innerColor: [1, .7, .7, 1] } }) });
const head = (age, angle = .8) => ({ x: Math.cos(angle) * age * 70, z: Math.sin(angle) * age * 70, height: 2,
  dx: Math.cos(angle), dz: Math.sin(angle), age, traveled: age * 70, speed: 70 });
const close = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const allFinite = geometry => assert.ok([...geometry.positions.flat(), ...geometry.uv.flat(), ...geometry.colors.flat()].every(Number.isFinite));

test('arrow body keeps its physical tip on the real projected bullet in every direction', () => {
  for (const angle of [0, .5, 1, 2, 3, 4, 5]) {
    const p = profile('arrow'), b = head(.32, angle), before = JSON.stringify(b), pose = math.projectileBodyPose(p, b);
    const point = projection.projectWorld({ x: b.x, z: b.z }, b.height);
    close(pose.x + Math.cos(pose.angle) * pose.width / 2, point.x);
    close(pose.y + Math.sin(pose.angle) * pose.width / 2, point.y);
    const geometry = math.projectileGeometry(4, [0, 1, 2, 2, 1, 3]); math.fillProjectileBody(geometry, p, pose);
    close(geometry.uv[0][0], 1 / 128); close(geometry.uv[0][1], 2 / 32);
    assert.equal(JSON.stringify(b), before); allFinite(geometry);
  }
});

test('pressure front reproduces the approved single surface through growth and rear extension', () => {
  const p = profile('arrow'), geometry = math.pressureGeometry(), positions = geometry.positions, colors = geometry.colors;
  assert.equal(positions.length, 246); assert.equal(geometry.indices.length, 1200);
  for (const age of [0, .05, .19, .26, .36, .5]) {
    const b = head(age), pose = math.projectileBodyPose(p, b);
    math.fillPressureFront(geometry, p, b, pose); allFinite(geometry);
    assert.equal(geometry.positions, positions); assert.equal(geometry.colors, colors);
    // All samples at either shoulder are transparent; no enclosing rear ring.
    for (let j = 0; j < 6; j++) { close(colors[j][3], 0); close(colors[240 + j][3], 0); }
    const growth = math.projectileGrowth(p, age), compression = .5 - .5 * Math.cos(age / .12 * Math.PI * 2);
    const rx = p.bodyLength * (.05 + .145 * growth) * (1 - .05 * compression * growth) * (1 - .15 * growth);
    const center = positions[20 * 6 + 5], front = -.018 * p.bodyLength + rx;
    close(center[0], pose.tipX + front * Math.cos(pose.angle));
    close(center[1], pose.tipY + front * Math.sin(pose.angle));
  }
});

test('all five installed arrows shrink body and pressure by another 10 percent around the unchanged physical tip', () => {
  const installed=require('../assets/resources/art/weapon-system/visuals.json').customProjectiles;
  const arrowKeys=Object.keys(installed).filter(key=>key.startsWith('arrow-'));
  assert.deepEqual(arrowKeys.sort(),['arrow-A','arrow-B','arrow-C','arrow-D','arrow-S']);
  for(const key of arrowKeys) {
    const current=installed[key],original={...current,bodyLength:3.915};
    close(current.bodyLength,3.5235);assert.equal(current.anchor,'tip');assert.equal(current.hitTrigger,'impact');
    for(const age of [0,.05,.19,.26,.36,.5])for(const direction of [.6,2.5]) {
      const bullet=head(age,direction),before=JSON.stringify(bullet);
      const pose=math.projectileBodyPose(current,bullet),oldPose=math.projectileBodyPose(original,bullet);
      close(pose.tipX,oldPose.tipX);close(pose.tipY,oldPose.tipY);
      close(pose.width,oldPose.width*.9);close(pose.height,oldPose.height*.9);
      for(const kind of ['body','pressure']) {
        const currentMesh=kind==='body'?math.projectileGeometry(4,[0,1,2,2,1,3]):math.pressureGeometry();
        const oldMesh=kind==='body'?math.projectileGeometry(4,[0,1,2,2,1,3]):math.pressureGeometry();
        if(kind==='body') {
          math.fillProjectileBody(currentMesh,current,pose);math.fillProjectileBody(oldMesh,original,oldPose);
        } else {
          math.fillPressureFront(currentMesh,current,bullet,pose);math.fillPressureFront(oldMesh,original,bullet,oldPose);
        }
        for(let i=0;i<currentMesh.positions.length;i++) {
          close(currentMesh.positions[i][0]-pose.tipX,(oldMesh.positions[i][0]-pose.tipX)*.9);
          close(currentMesh.positions[i][1]-pose.tipY,(oldMesh.positions[i][1]-pose.tipY)*.9);
        }
        assert.deepEqual(currentMesh.colors,oldMesh.colors,'growth, opacity and pressure flow are unchanged');
        assert.deepEqual(currentMesh.uv,oldMesh.uv);
      }
      assert.equal(JSON.stringify(bullet),before,'visual resizing cannot mutate flight or collision state');
    }
  }
});

test('all twelve installed shuriken shrink body, afterimage and ribbon width by 25 percent around the unchanged flight center', () => {
  const installed = require('../assets/resources/art/weapon-system/visuals.json').customProjectiles;
  const keys = Object.keys(installed).filter(key => key.startsWith('shuriken-'));
  assert.deepEqual(keys.sort(), ['C', 'B', 'A', 'S', 'SS', 'SSS', 'X', 'XX', 'XXX', 'Z', 'ZZ', 'ZZZ'].map(grade => `shuriken-${grade}`).sort());
  for (const key of keys) {
    const current = installed[key], original = { ...current, bodyLength: 4.2 };
    close(current.bodyLength, 3.15);
    assert.equal(current.anchor, 'center'); assert.equal(current.hitTrigger, 'hit');
    for (const age of [0, .05, .19, .26, .36, .5]) for (const direction of [.6, 2.5]) {
      const bullet = head(age, direction), before = JSON.stringify(bullet);
      const pose = math.projectileBodyPose(current, bullet), oldPose = math.projectileBodyPose(original, bullet);
      close(pose.x, oldPose.x); close(pose.y, oldPose.y); close(pose.angle, oldPose.angle);
      close(pose.width, oldPose.width * .75); close(pose.height, oldPose.height * .75);
      for (const ghost of [false, true]) {
        const geometry = math.projectileGeometry(4, [0, 1, 2, 2, 1, 3]);
        const oldGeometry = math.projectileGeometry(4, [0, 1, 2, 2, 1, 3]);
        const alpha = ghost ? current.afterimage.alpha : 1;
        const angle = pose.angle + (ghost ? current.afterimage.angleLag : 0);
        math.fillProjectileBody(geometry, current, pose, alpha, angle);
        math.fillProjectileBody(oldGeometry, original, oldPose, alpha, angle);
        for (let i = 0; i < geometry.positions.length; i++) {
          close(geometry.positions[i][0] - pose.x, (oldGeometry.positions[i][0] - pose.x) * .75);
          close(geometry.positions[i][1] - pose.y, (oldGeometry.positions[i][1] - pose.y) * .75);
        }
        assert.deepEqual(geometry.uv, oldGeometry.uv); assert.deepEqual(geometry.colors, oldGeometry.colors);
      }
      assert.equal(JSON.stringify(bullet), before, 'visual scaling cannot change the simulated projectile');
    }
    const bullet = head(.5), history = Array.from({ length: 51 }, (_, i) => head(i / 100));
    const outer = math.ribbonPoints(), core = math.ribbonPoints(), oldOuter = math.ribbonPoints(), oldCore = math.ribbonPoints();
    const count = math.sampleRibbon(current, bullet, history, 0, outer, core, {});
    const oldCount = math.sampleRibbon(original, bullet, history, 0, oldOuter, oldCore, {});
    let compared = 0;
    for (let i = 0; i < count; i++) {
      const j = oldOuter.slice(0, oldCount).findIndex(point => Math.hypot(point.x - outer[i].x, point.y - outer[i].y) < 1e-8);
      if (j < 0) continue; // The final point follows the resized body attachment.
      close(outer[i].width, oldOuter[j].width * .75); close(core[i].width, oldCore[j].width * .75);
      close(outer[i].alpha, oldOuter[j].alpha); compared++;
    }
    assert.ok(compared > 10, `${key}: compare widths at the same trail positions`);
    const center = math.projectedPoint(bullet);
    const gap = point => Math.hypot(point.x - center[0], point.y - center[1]);
    close(gap(outer[count - 1]), gap(oldOuter[oldCount - 1]) * .75);
    assert.equal(math.sampleRibbon(current, bullet, history, current.cometTrail.lifetime, outer, core, {}), 0);
  }
});

test('shuriken spin acceleration is continuous and does not change its flight center', () => {
  const p = profile('shuriken'), a = math.projectileBodyPose(p, head(.26 - 1e-6)), b = math.projectileBodyPose(p, head(.26 + 1e-6));
  assert.ok(Math.abs(a.angle - b.angle) < .0001);
  const pose = math.projectileBodyPose(p, head(.4)); close(pose.x, pose.tipX); close(pose.y, pose.tipY);
});

test('continuous two-layer ribbon follows variable-frame path samples and expires after stopping', () => {
  const p = profile('shuriken'), outer = math.ribbonPoints(), core = math.ribbonPoints(), scratch = {};
  const history = [0, .011, .049, .08, .14, .207, .26, .333, .4].map(t => head(t));
  const count = math.sampleRibbon(p, head(.4), history, 0, outer, core, scratch);
  assert.ok(count > 10 && count <= math.RIBBON_POINTS);
  const geometry = math.ribbonGeometry(); math.fillRibbon(geometry, outer, count, p.cometTrail.outerColor); allFinite(geometry);
  for (let i = 0; i < count; i++) {
    close(core[i].width, outer[i].width * p.cometTrail.coreScale);
    assert.ok(core[i].alpha <= outer[i].alpha);
  }
  assert.equal(math.sampleRibbon(p, head(.4), history, .181, outer, core, scratch), 0);
  const sample = math.sampleProjectilePath(history, .3 * 70, scratch); close(sample.age, .3); close(sample.x, head(.3).x);
});

test('custom pools preserve a stopped trail, reset reused emitters, and share palette materials', () => {
  let materials = 0, meshes = 0;
  class Material { constructor() { materials++; this.properties = {}; } initialize() {} setProperty(k, v) { this.properties[k] = v; } destroy() { this.destroyed = true; } }
  class Sprite {}
  class Vec4 { constructor(x, y, z, w) { Object.assign(this, { x, y, z, w }); } }
  class Mesh { constructor(sprite, geometry) { meshes++; this.geometry = geometry; } updateProjected() { allFinite(this.geometry); } }
  const art = { image() { const sprite = {}; return { isValid: true, active: false, getComponent: () => sprite, destroy() { this.isValid = false; } }; } };
  const { CustomProjectiles } = load('CustomProjectiles', { cc: { Material, Sprite, Vec4 }, './OriginalParticleMesh': { OriginalParticleMesh: Mesh }, './CustomProjectileMotion': math });
  const runtime = new CustomProjectiles(art, profile('shuriken'), () => ({}), {});
  const bullet = t => ({ id: 7, active: true, damaging: true, position: { x: head(t).x, z: head(t).z },
    direction: { x: head(t).dx, z: head(t).dz }, ...head(t) });
  for (const t of [.1, .2, .3]) runtime.update(.1, [bullet(t)]);
  assert.equal(materials, 2); assert.equal(meshes, 4); assert.equal(runtime.diagnostics().active, 4);
  const before = JSON.stringify(bullet(.3)); runtime.update(.01, [bullet(.3)]); assert.equal(JSON.stringify(bullet(.3)), before);
  runtime.update(.02, [{ ...bullet(.3), damaging: false }]); assert.equal(runtime.diagnostics().active, 2);
  runtime.update(.2, []); assert.equal(runtime.diagnostics().active, 0); assert.equal(runtime.hasActiveParticles, false);
  runtime.shot(7); runtime.update(.01, [bullet(.01)]); assert.equal(meshes, 4);
  runtime.reset(); assert.equal(runtime.diagnostics().active, 0);
  assert.equal(runtime.emitters.get(7).history.length, 0);
  runtime.destroy(); assert.equal(runtime.diagnostics().pooled, 0);
});

test('projectile hit routing requests per-target shuriken flashes without changing ordinary impact routing', () => {
  class Color {}
  const { OriginalProjectiles } = load('OriginalProjectiles', { cc: { Color } });
  const art = { weaponVisuals: { appearance: id => ({ projectileSkin: id === 1 ? 'shuriken-C' : 'arrow-C' }),
    config: { customProjectiles: { 'shuriken-C': profile('shuriken'), 'arrow-C': profile('arrow') } } } };
  const renderer = new OriginalProjectiles(art, {});
  assert.equal(renderer.hitTrigger(1), 'hit'); assert.equal(renderer.hitTrigger(2), 'impact');
});
