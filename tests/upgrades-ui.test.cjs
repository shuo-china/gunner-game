const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const { assertResourceImageMetadata } = require('./support/resource-image-metadata.cjs');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/scripts/view/UpgradeInput.ts'), 'utf8');
const module_ = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS,
} }).outputText, { module: module_, exports: module_.exports });
const { UpgradeInput } = module_.exports;

test('short press purchases on release, long press matches original .4/.1 coroutine and release click', () => {
  const bought = []; const input = new UpgradeInput(type => { bought.push(type); return true; });
  input.setEnabled(true); input.press('power', 1); input.update(.2);
  assert.deepEqual(bought, []); assert.equal(input.release(1), true); assert.deepEqual(bought, ['power']);
  input.press('speed', 2); input.update(.399); assert.equal(bought.length, 1);
  input.update(.001); assert.equal(bought.length, 2);
  input.update(.099); assert.equal(bought.length, 2);
  input.update(.001); assert.equal(bought.length, 3);
  input.release(2); assert.equal(bought.length, 4);
  input.update(1); assert.equal(bought.length, 4);
});

test('one pointer owns all cards; secondary release/cancel cannot purchase or steal the hold', () => {
  const bought = []; const input = new UpgradeInput(type => { bought.push(type); return true; });
  input.setEnabled(true); assert.equal(input.press('money', 1), true); assert.equal(input.press('power', 2), false);
  assert.equal(input.release(2), false); input.cancel(2); assert.equal(input.pressedType, 'money');
  input.update(.4); assert.deepEqual(bought, ['money']); input.cancel(1); input.release(1);
  assert.equal(bought.length, 1);
});

test('failed purchase stops repeat; disable, cancellation and frame stalls never replay a backlog', () => {
  let calls = 0; let succeeds = false;
  const input = new UpgradeInput(() => { calls++; return succeeds; });
  input.setEnabled(true); input.press('power', 1); input.update(.4); input.update(10); assert.equal(calls, 1);
  input.cancel(); succeeds = true; input.press('power', 1); input.update(10); assert.equal(calls, 2);
  input.setEnabled(false); input.update(10); input.release(1); assert.equal(calls, 2);
  assert.equal(input.press('power', 1), false);
  input.setEnabled(true); input.press('power', 1); input.update(NaN); input.update(-1); input.update(.1);
  assert.equal(calls, 2); input.cancel(); input.release(1); assert.equal(calls, 2);
});

test('a successful purchase can synchronously refresh the HUD with dt=0 without repeating or reviving a released gesture', () => {
  let calls = 0;
  const input = new UpgradeInput(() => { calls++; input.setEnabled(true); input.update(0); return true; });
  input.setEnabled(true); input.press('power', 1); input.update(.4); assert.equal(calls, 1);
  input.release(1); assert.equal(calls, 2); assert.equal(input.pressedType, undefined);
  input.update(.4); assert.equal(calls, 2);
});

test('exported upgrade assets retain source identifiers, native nine-slice and subset identity', () => {
  const folder = path.join(root, 'assets/resources/art/upgrades');
  const config = JSON.parse(fs.readFileSync(path.join(folder, 'config.json')));
  assert.deepEqual(config.titles, ['攻击力', '攻击速度', '金币加成']);
  for (const [name, id] of Object.entries({ panel: 509, outline: 546, price: 891, cash: 372, power: 907, speed: 383, money: 927, flash: 884 })) {
    assert.equal(config.images[name].originalSource ?? config.images[name].source, `sharedassets0.assets:${id}`);
    assertResourceImageMetadata(path.join(root, 'assets/resources'), config.images[name]);
  }
  assert.deepEqual(config.images.panel.border, [67, 67, 67, 67]);
  assert.deepEqual(config.images.price.border, [41, 0, 41, 0]);
  const font = fs.readFileSync(path.join(root, `assets/resources/${config.font.path}.ttf`));
  assert.ok(font.length < 50000);
  assert.equal(crypto.createHash('sha256').update(font).digest('hex'), config.font.subsetSha256);
  assert.equal(config.source.fillDirection, 'Up'); assert.equal(config.source.maxLabel, 'Max');
  assert.equal(config.animation.duration, .25);
  const peak = config.animation.peakTime;
  const [a, b, c, d] = config.animation.grow;
  assert.ok(Math.abs(((a * peak + b) * peak + c) * peak + d - 20) < .001);
});
