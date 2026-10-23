const { projectPath, fixturePath } = require('./support/paths.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const engine = fixturePath('cocos-3.8.8');

function load(file, imports) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(compiled, { module, exports: module.exports, Float32Array, Uint16Array,
    require: name => {
      assert.ok(name in imports, `Unstubbed import ${name}`);
      return imports[name];
    },
  });
  return module.exports;
}

// Exercise the pinned Creator 3.8.8 source snapshot's real index growth/upload/reset contract.
// GPU transfers are stubbed; the Uint16Array upload boundary remains real.
const { MeshBuffer } = load(path.join(engine, 'mesh-buffer.ts.txt'), {
  'internal:constants': { JSB: false }, '../../gfx': {}, './vertex-format': {},
  '../../core': { sys: { __isWebIOS14OrIPadOS14Env: false } }, './native-2d': {},
});
const { StaticVBAccessor } = load(path.join(engine, 'static-vb-accessor.ts.txt'), {
  'internal:constants': { JSB: false }, './mesh-buffer': { MeshBuffer },
  './buffer-accessor': { BufferAccessor: class {} }, '../../game': {},
  '../../core': { Pool: class {} },
});
const { OriginalParticleMesh } = load(projectPath('assets/scripts/view/OriginalParticleMesh.ts'), {
  '../core/projection': { CAMERA_BASIS: {
    rightX: 1, rightZ: 0, upX: 0, upY: 1, upZ: 0, forwardX: 0, forwardY: 0, forwardZ: 1,
  } },
});
const visuals = require(projectPath('assets/resources/art/weapon-system/visuals.json'));
const impact = require('./fixtures/retired-projectile-profiles.json')['69419-67673'].find(s => s.mesh?.positions.length === 425).mesh;

function fixture(vertexCapacity = 1024) {
  const buffer = new MeshBuffer();
  buffer.vData = new Float32Array(vertexCapacity * 9);
  buffer.iData = new Uint16Array(vertexCapacity * StaticVBAccessor.IB_SCALE);
  const uploaded = [];
  const gpuBuffer = recording => ({ size: 0, resize(size) { this.size = size; },
    update(data) { if (recording) uploaded.push(Array.from(data)); } });
  buffer._iaPool = [{ vertexBuffers: [gpuBuffer(false)], indexBuffer: gpuBuffer(true) }];
  const accessor = Object.create(StaticVBAccessor.prototype);
  accessor._buffers = [buffer]; accessor._freeLists = [[]];
  let vertexOffset = 0;
  function sprite() {
    const result = {
      color: { r: 255, g: 255, b: 255, a: 255 },
      spriteFrame: { uv: [0, 0, 1, 0, 0, 1, 1, 1] },
      node: { worldMatrix: { m00: 1, m01: 0, m02: 0, m04: 0, m05: 1, m06: 0, m12: 0, m13: 0, m14: 0 },
        setPosition() {}, setScale() {}, angle: 0 },
      get renderData() { return this._renderData; },
      destroyRenderData() { this._renderData = null; },
      getRenderMaterial() { return {}; }, markForUpdateRenderData() {},
      requestRenderData() {
        const data = { floatStride: 9, data: [], updateRenderData() {},
          set dataLength(length) { this.data = Array.from({ length }, () => ({})); },
          resize(count) {
            this.chunk = { meshBuffer: buffer, vertexAccessor: accessor, bufferId: 0, vertexOffset,
              vb: buffer.vData.subarray(vertexOffset * 9, (vertexOffset + count) * 9), setIndexBuffer() {} };
            vertexOffset += count; buffer.byteOffset = vertexOffset * 9 * 4;
          },
        };
        this._renderData = data; return data;
      },
    };
    return result;
  }
  return { buffer, accessor, uploaded, sprite };
}

test('overlapping source impact meshes upload past the default index capacity and reset every frame', () => {
  const f = fixture(), sprites = [f.sprite(), f.sprite()];
  const meshes = sprites.map(sprite => new OriginalParticleMesh(sprite, impact));
  assert.equal(impact.indices.length, 2304);
  for (let frame = 0; frame < 120; frame++) {
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].update({ position: [i, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
      sprites[i]._assembler.updateRenderData(); sprites[i]._assembler.fillBuffers();
    }
    // Real sprite assemblers append quads without a capacity check.
    const offset = f.buffer.indexOffset;
    for (let i = 0; i < 6; i++) f.buffer.iData[offset + i] = 850 + [0, 1, 2, 1, 3, 2][i];
    f.buffer.indexOffset += 6;
    assert.equal(f.buffer.indexOffset, 4614);
    assert.doesNotThrow(() => f.accessor.uploadBuffers(), 'no RangeError may interrupt the frame reset');
    const indices = f.uploaded.at(-1);
    assert.equal(indices.length, 4614);
    assert.ok(indices.slice(0, 2304).every(index => index < 425));
    assert.ok(indices.slice(2304, 4608).every(index => index >= 425 && index < 850));
    assert.deepEqual(indices.slice(-6), [850, 851, 852, 851, 853, 852]);
    f.accessor.reset(); assert.equal(f.buffer.indexOffset, 0);
  }
  assert.equal(f.uploaded.length, 120);
});

test('a dense mesh reserves space for unchecked sprite draws that follow it', () => {
  const f = fixture(), sprite = f.sprite();
  new OriginalParticleMesh(sprite, impact);
  // Existing draws end just below the original 4096-index capacity.
  f.buffer.indexOffset = 1791;
  sprite._assembler.fillBuffers();
  assert.equal(f.buffer.indexOffset, 4095);
  for (let i = 0; i < 6; i++) f.buffer.iData[f.buffer.indexOffset++] = i;
  assert.doesNotThrow(() => f.accessor.uploadBuffers());
  assert.deepEqual(f.uploaded.at(-1).slice(-6), [0, 1, 2, 3, 4, 5]);
});

test('mesh color changes coalesce into one HDR upload and dynamic colors keep fixed buffers', () => {
  const f=fixture(),sprite=f.sprite();
  const geometry={positions:[[0,0,0],[1,0,0],[0,1,0]],uv:[[0,0],[1,0],[0,1]],indices:[0,1,2]};
  const mesh=new OriginalParticleMesh(sprite,geometry),vb=sprite.renderData.chunk.vb;
  let colorWrites=0;
  sprite.renderData.chunk.vb=new Proxy(vb,{set(target,key,value){
    if(/^\d+$/.test(String(key))&&Number(key)%9>=5)colorWrites++;
    target[key]=value;return true;
  }});
  sprite.color={r:255,g:128,b:64,a:255};sprite._assembler.updateColor();
  mesh.setTint([2.5,2,1,2]);const tint=mesh.tint;
  mesh.setTint([3,2,1,2]);assert.equal(mesh.tint,tint);assert.equal(colorWrites,0);
  sprite._assembler.updateRenderData();sprite._assembler.fillBuffers();
  assert.equal(colorWrites,12);assert.deepEqual(Array.from(vb.slice(5,9)),[3,2,1,2]);
  // Creator's post-fill updateOpacity overwrites alpha on color-dirty frames.
  // The following frame must restore HDR alpha even when setTint is unchanged.
  vb[8]=1;mesh.setTint([3,2,1,2]);sprite._assembler.updateRenderData();
  assert.equal(colorWrites,24);assert.equal(vb[8],2);
  geometry.colors=[[.5,1,1,.25],[1,1,1,1],[1,1,1,1]];
  mesh.updateProjected();sprite._assembler.updateRenderData();assert.equal(colorWrites,36);
  assert.deepEqual(Array.from(vb.slice(5,9)),[1.5,2,1,.5]);
  geometry.colors[0][3]=.5;mesh.updateProjected();sprite._assembler.updateRenderData();
  assert.equal(colorWrites,48);assert.equal(vb[8],1);
  sprite.color={r:255,g:255,b:255,a:255};sprite._assembler.updateColor();
  sprite._assembler.fillBuffers();assert.equal(colorWrites,60,'color-only updates are submitted even without a pose update');
});
