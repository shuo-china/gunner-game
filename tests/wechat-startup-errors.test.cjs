const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { projectPath } = require('./support/paths.cjs');
const { installStartupErrorHandler } = require('../tools/wechat-startup-package.cjs');
const source = fs.readFileSync(projectPath('tools/wechat-startup-errors.cjs'), 'utf8');

test('a rejected startup reports the error and shows one readable versioned failure prompt', () => {
  const messages = [], errors = [], module = { exports: {} };
  vm.runInNewContext(source, { module, console: { error: (...args) => errors.push(args) },
    __FOREST_GUNNER_RELEASE__: '0.1.12', wx: { showModal: options => messages.push(options) } });
  const failure = new Error('resource configuration 404');
  module.exports.reportStartupError(failure);
  module.exports.reportStartupError(failure);
  assert.equal(errors.length, 2);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /0\.1\.12/);
  assert.match(messages[0].content, /resource configuration 404/);
  assert.equal(messages[0].showCancel, false);
});

test('missing or failing native prompt APIs never hide the original startup error', () => {
  for (const wx of [undefined, {}, { showModal() { throw new Error('unavailable'); } }]) {
    const module = { exports: {} }, logged = [];
    vm.runInNewContext(source, { module, wx, console: { error: (...args) => logged.push(args) } });
    assert.doesNotThrow(() => module.exports.reportStartupError({ errMsg: 'failed' }));
    assert.equal(logged.length, 1);
  }
});

test('packaging connects an actual rejected startup promise to the native error prompt', async t => {
  const parent = projectPath('tests');
  const fixture = fs.mkdtempSync(path.join(parent, '.startup-errors-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('.startup-errors-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const entryPath = path.join(fixture, 'game.js');
  const entry = "Promise.resolve().then(() => { throw new Error('404'); }).catch((err) => { console.error(err); });";
  fs.writeFileSync(entryPath, entry);
  installStartupErrorHandler(fixture);
  const errors = [];
  await vm.runInNewContext(fs.readFileSync(entryPath, 'utf8'), { require(name) {
    assert.equal(name, './startup-errors');
    return { reportStartupError: err => errors.push(err.message) };
  } });
  assert.deepEqual(errors, ['404']);
  assert.equal(fs.readFileSync(path.join(fixture, 'startup-errors.js'), 'utf8'), source);
  fs.writeFileSync(entryPath, entry + entry);
  assert.throws(() => installStartupErrorHandler(fixture), /Expected one/);
  assert.equal(fs.readFileSync(entryPath, 'utf8'), entry + entry);
});
