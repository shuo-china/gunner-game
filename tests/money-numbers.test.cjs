const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require(path.join(root, 'assets/resources/art/effects/money-numbers/config.json'));
const damage = require(path.join(root, 'assets/resources/art/effects/original-feedback.json')).damage;
const source = require('./fixtures/original-money-numbers.json');
const core = require('./.build/core/index.js');
const math = require('./.build/feedback/view/OriginalFeedbackMath.js');
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a-b) <= tolerance, `${a} != ${b}`);

function harness(money = config) {
  class Color {
    constructor(r, g, b, a = 255) { Object.assign(this, { r, g, b, a }); }
    static WHITE = new Color(255, 255, 255, 255);
  }
  class UITransform {
    setContentSize(width, height) { this.size = { width, height }; }
    setAnchorPoint(x, y) { this.anchor = { x, y }; }
  }
  class Sprite {}
  class UIOpacity { opacity = 255; }
  class Node {
    static EventType={NODE_DESTROYED:'destroyed'};
    once() {}
    constructor(name) { this.name = name; this.children = []; this.components = new Map(); this.active = true; }
    addChild(node) { this.children.push(node); node.parent = this; }
    addComponent(type) { const component = new type(); this.components.set(type, component); return component; }
    getComponent(type) { return this.components.get(type); }
    setPosition(x, y, z) { this.position = { x, y, z }; }
    setScale(x, y, z) { this.scale = { x, y, z }; }
  }
  const makeNode = (name, parent) => {
    const node = new Node(name); node.addComponent(UITransform); parent?.addChild(node); return node;
  };
  const loads = [];
  const art = { catalog: { feedback: { damage } },
    frames: new Map([...Object.values(damage.glyphs), ...Object.values(config.glyphs)].map(glyph => [glyph.path, glyph.path])),
    image(name, spec, parent) {
      const node = makeNode(name, parent), sprite = node.addComponent(Sprite);
      sprite.spriteFrame = spec.path; sprite.color = spec.color ? new Color(...spec.color) : Color.WHITE;
      return node;
    },
    async json(resource) { assert.equal(resource, 'art/effects/money-numbers/config'); return config; },
    async loadFrame(resource) { loads.push(resource); return resource; },
  };
  const module = { exports: {} };
  const imports = { cc: { Color, Node, Sprite, UIOpacity, UITransform }, '../core': core,
    './ArtLibrary': { makeNode }, './OriginalFeedbackMath': math,
    './OrderedQuadBatch': { OrderedQuadBatch: require('./support/number-batch-harness.cjs').NumberBatchHarness },
    './NumberGlyphAtlas': { loadNumberGlyphAtlas: async () => { loads.push('number-atlas'); },
      retainNumberGlyphAtlas:()=>()=>{}, numberGlyphFrame: (art, path) => art.frames.get(path) } };
  const fakeMath = Object.create(Math); fakeMath.random = () => 0;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'assets/scripts/view/DamageNumbers.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
    { module, exports: module.exports, Math: fakeMath, require(name) {
      assert.ok(name in imports, `Unknown import ${name}`); return imports[name];
    } });
  const parent = makeNode('Numbers');
  const view = new module.exports.DamageNumbers(art, parent, money);
  return { view, parent, Sprite, UITransform, art, loads, load: module.exports.loadOriginalMoneyNumbers };
}

test('money settings retain original Font315 provenance, spacing, height and 50 baked curves', () => {
  assert.equal(source.font.m_DefaultMaterial.m_PathID, 38);
  assert.equal(source.animation.font.m_PathID, 315);
  assert.equal(source.settings.settings.find(entry => entry.key === 'money').setting.m_PathID, 960);
  assert.equal(config.duration, source.animation.duration);
  assert.equal(config.duration, 1.5);
  assert.equal(config.gap, -.36);
  assert.equal(config.height, 0);
  assert.equal(config.cooldown, Math.fround(.2));
  assert.equal(config.bucketSize, 1.5);
  assert.equal(config.curves.length, 50);
  assert.equal(Object.keys(config.glyphs).length, 42);
  for (const glyph of source.font.m_CharacterRects) {
    const spec = config.glyphs[String.fromCodePoint(glyph.index)];
    assert.equal(spec.source.character, glyph.index);
    assert.equal(spec.source.texturePathId, 98);
    close(spec.sizeUnits[0], glyph.vert.width*.02);
    assert.ok(fs.existsSync(path.join(root, 'assets/resources', `${spec.path}.png`)));
    assert.ok(fs.existsSync(path.join(root, 'assets/resources', `${spec.path}.png.meta`)));
  }
  assert.equal(config.glyphs['+'].source.character, 43);
  assert.notEqual(config.glyphs['+'].source.rgbaSha256, config.glyphs['0'].source.rgbaSha256);
  for (let i = 0; i < 50; i++) {
    const curve = config.curves[i], original = source.animation.curves[i];
    for (const channel of ['movementX', 'movementY', 'alpha', 'scale']) {
      assert.equal(curve[channel].length, 65);
      assert.ok(curve[channel].every(Number.isFinite));
      close(curve[channel][0], original[channel].m_Curve[0].value);
      close(curve[channel][64], original[channel].m_Curve.at(-1).value);
    }
    // Each original X curve is linear; preserve its 50 different fan directions.
    close(curve.movementX[32], original.movementX.m_Curve[1].value/2);
  }
  assert.equal(config.curves[0].movementX[64], 400);
  assert.equal(config.curves[49].movementX[64], -400);
});

test('money uses the original Font315 cash icon and green glyph assets without tinting', () => {
  const cash = config.glyphs['+'];
  assert.equal(cash.path, 'art/effects/money-numbers/glyph_43');
  assert.deepEqual(cash.sizePx, [51, 51]);
  assert.deepEqual(cash.sizeUnits, [1.2, 1.2]);
  assert.deepEqual(cash.anchor, [0, 0]);
  for (const [char, glyph] of Object.entries(config.glyphs)) {
    assert.equal(glyph.path, `art/effects/money-numbers/glyph_${char.codePointAt(0)}`);
    assert.deepEqual(glyph.sizePx, [51, 51]);
    assert.deepEqual(glyph.anchor, [0, 0]);
    assert.equal(glyph.color, undefined, 'Font315 keeps its authored green colors');
    assert.equal(glyph.source.fontPathId, 315);
    assert.equal(glyph.currentDesign, undefined);
    if (damage.glyphs[char]) assert.notEqual(glyph.path, damage.glyphs[char].path);
  }
});

test('loader prepares the shared number atlas without changing the damage catalog', async () => {
  const { art, loads, load } = harness();
  const result = await load(art);
  assert.equal(result, config);
  assert.equal(loads.length, 1);
  assert.deepEqual(loads, ['number-atlas']);
  assert.equal(art.catalog.feedback.damage, damage);
});

test('lethal damage and money display together at original distinct Y buckets and projections', () => {
  const { view, parent, Sprite, UITransform } = harness();
  const position = { x: 3, z: 10 };
  view.spawn(position, 100, .02);
  view.spawnMoney(position, 20, .02);
  assert.equal(view.slots.length, 2);
  assert.equal(view.cooldowns.size, 2, 'both styles share the same dictionary but use source world Y');
  const money = view.slots[1];
  assert.deepEqual({ ...money.origin }, core.projectWorld(position, 0));
  assert.deepEqual({ ...view.slots[0].origin }, core.projectWorld(position, 2));
  assert.deepEqual(Array.from(money.digits, digit => digit.frame),
    ['+', '2', '0'].map(char => config.glyphs[char].path));
  close(money.digits[0].x, -1.26);
  close(money.digits[1].x-money.digits[0].x, .84);
  close(money.digits[0].width, 1.2);
  view.update(1/30, 1/30);
  close(view.slots[0].time, 1-(1/30-.02));
  close(money.time, 1.5-(1/30-.02));
});

test('money throttles same world XY bucket for .2 seconds and ignores Z separation', () => {
  const { view, parent } = harness();
  view.spawnMoney({ x: 0, z: 0 }, 20, 0);
  view.spawnMoney({ x: 0, z: 90 }, 36, .19);
  assert.equal(view.slots.length, 1);
  view.spawnMoney({ x: 0, z: 90 }, 36, .2);
  assert.equal(view.slots.length, 2);
  assert.equal(view.cooldowns.size, 1);
});

test('a shared bucket applies the requesting style cooldown across different number styles', () => {
  // Inject a coincident height to isolate shared-key behavior; shipped money stays at Y=0.
  const { view, parent } = harness({ ...config, height: 2 });
  view.spawn({ x: 0, z: 0 }, 100, 0);
  view.spawnMoney({ x: 0, z: 0 }, 20, .15);
  assert.equal(view.slots.length, 1, 'money requires .2 after the accepted damage');
  view.spawnMoney({ x: 0, z: 0 }, 20, .2);
  assert.equal(view.slots.length, 2);
  view.spawn({ x: 0, z: 0 }, 100, .31);
  assert.equal(view.slots.length, 2);
  view.spawn({ x: 0, z: 0 }, 100, .33);
  assert.equal(view.slots.length, 3, 'damage needs only its .12 cooldown after money');
  assert.equal(view.cooldowns.size, 1);
});

test('money to damage to money pool reuse restores color, glyphs, duration and hides leftovers', () => {
  const { view, parent, Sprite } = harness();
  const palette = slot => Array.from(slot.digits.slice(0,slot.glyphCount), digit => Array.from(digit.color, value => value*255));
  const white = [255, 255, 255, 255];
  view.spawnMoney({ x: 0, z: 0 }, 36, 0);
  assert.deepEqual(palette(view.slots[0]), [white, white, white]);
  view.update(1, 1);
  assert.ok(view.slots[0].time > 0, 'money outlives the one-second damage style');
  close(view.slots[0].time, .5);
  view.update(.5, 1.5);
  assert.equal(view.slots[0].time, 0);
  view.slots[0].digits[1].color = [251/255,199/255,62/255,1];
  view.spawn({ x: 0, z: 0 }, 90, 1.5);
  assert.equal(view.slots.length, 1);
  assert.equal(view.slots[0].time, 1);
  assert.equal(view.slots[0].glyphCount, 2);
  assert.equal(view.slots[0].digits[0].frame, damage.glyphs['9'].path);
  assert.deepEqual(palette(view.slots[0]), [white, white], 'pool reuse clears a stale tint');
  view.update(1, 2.5);
  view.slots[0].digits[1].color = [251/255,199/255,62/255,1];
  view.spawnMoney({ x: 3, z: 5 }, 20, 2.5);
  assert.equal(view.slots.length, 1);
  assert.equal(view.slots[0].time, 1.5);
  assert.deepEqual(Array.from(view.slots[0].digits, digit => digit.frame),
    ['+', '2', '0'].map(char => config.glyphs[char].path));
  assert.deepEqual(palette(view.slots[0]), [white, white, white], 'Font315 assets stay untinted when the pool returns to money');
});

test('money advances after combat completion, freezes with scaled time and reset clears all callbacks/state', () => {
  const { view, parent } = harness();
  const world = new core.CombatWorld(1);
  world.stats.complete = true;
  view.spawnMoney(world.player.position, 20, world.simulationTime);
  for (let i = 0; i < 30; i++) { world.step(1/60); view.update(1/60, world.simulationTime); }
  assert.equal(world.stats.elapsed, 0);
  close(view.slots[0].time, 1);
  world.pause();
  const snapshot = () => JSON.stringify({ time: view.slots[0].time, x: view.slots[0].x, y: view.slots[0].y,
    scale: view.slots[0].scale, alpha: view.slots[0].opacity, keys: view.slots[0].dirtyKeys });
  const before = snapshot();
  for (let i = 0; i < 600; i++) { world.step(1/60); view.update(0, world.simulationTime); }
  assert.equal(snapshot(), before);
  world.resume();
  for (let i = 0; i < 61; i++) { world.step(1/60); view.update(1/60, world.simulationTime); }
  assert.equal(view.slots[0].time, 0);
  view.reset();
  assert.equal(view.cooldowns.size, 0);
  view.spawnMoney({ x: 0, z: 0 }, 36);
  assert.equal(view.slots[0].startedAt, 0);
  assert.equal(view.slots[0].time, 1.5);
  assert.equal(view.slots.length, 1);
});

test('number poses reuse dirty keys and expired numbers do not update transforms or opacity',()=>{
  const {view}=harness();view.spawnMoney({x:3,z:5},20,0);
  const slot=view.slots[0],keys=slot.dirtyKeys;
  for(let i=1;i<30;i++){view.update(1/60,i/60);assert.equal(slot.dirtyKeys,keys);}
  for(const field of ['x','y','scale','opacity'])Object.defineProperty(slot,field,{get:()=>255,set:()=>assert.fail(`expired number must not update ${field}`)});
  view.update(3,3);assert.equal(slot.time,0);view.update(1,4);
});

test('the shared number pool grows as needed and repeated reset reuses its high-water allocation', () => {
  const { view, parent } = harness();
  for (let i = 0; i < 30; i++) {
    view.spawn({ x: i*3, z: 0 }, 100, 0);
    view.spawnMoney({ x: i*3, z: 0 }, i%2 ? 36 : 20, 0);
  }
  assert.equal(view.slots.length, 60);
  assert.deepEqual({ ...view.diagnostics() }, { active: 60, pooled: 60 });
  for (let round = 0; round < 4; round++) {
    view.reset();
    assert.ok(view.slots.every(slot => slot.time===0));
    assert.equal(view.batch.quads.length,0);
    assert.deepEqual({ ...view.diagnostics() }, { active: 0, pooled: 60 });
    for (let i = 0; i < 30; i++) view.spawnMoney({ x: i*3, z: 0 }, 20, 0);
    assert.equal(view.slots.length, 60);
    assert.deepEqual({ ...view.diagnostics() }, { active: 30, pooled: 60 });
  }
});

test('decimal rewards and large upgrade damage use original compact number glyphs', () => {
  const { view, Sprite } = harness();
  const D = core.DecimalAmount;
  view.spawnMoney({ x: 0, z: 0 }, D.from('21.6'), 0);
  const chars = (slot, glyphs) => slot.digits.slice(0,slot.glyphCount).map(digit =>
    Object.keys(glyphs).find(char => glyphs[char].path === digit.frame)).join('');
  assert.equal(chars(view.slots[0], config.glyphs), '+21', 'original display truncates small amounts without truncating the wallet');
  view.spawn({ x: 3, z: 0 }, D.from('12300'), 0);
  assert.equal(chars(view.slots[1], damage.glyphs), '12.3a');
  view.spawnMoney({ x: 6, z: 0 }, D.from('1.23e2206'), 0);
  assert.equal(chars(view.slots[2], config.glyphs), '+1.23e+2206');
  assert.ok(view.slots[2].digits.length < 20, 'scientific fallback must not allocate thousands of digit nodes');
});
