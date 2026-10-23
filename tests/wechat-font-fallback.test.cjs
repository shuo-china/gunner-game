const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');

function fixture(scope = {}) {
  const module = { exports: {} }, warnings = [], registrations = [];
  const source = fs.readFileSync(projectPath('assets/scripts/session/WeChatFontFallback.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  vm.runInNewContext(compiled, { ...scope, module, exports: module.exports,
    console: { warn: (...args) => warnings.push(args) } });
  const handlers = new Map([['.png', () => 'original image handler']]);
  const parser = { register(extension, handler) { registrations.push(extension); handlers.set(extension, handler); } };
  return { install: module.exports.installWeChatFontFallback, parser, handlers, warnings, registrations };
}

test('WeChat TTF loading retains the adapter receiver, path, and returned font family', () => {
  const calls = [], adapter = { family: 'CustomFont42', loadFont(path) { calls.push([this, path]); return this.family; } };
  const f = fixture({ __globalAdapter: adapter }), completed = [];
  const imageHandler = f.handlers.get('.png');
  assert.equal(f.install(f.parser), true);
  f.handlers.get('.ttf')('wxfile://tmp/font.ttf', {}, (...args) => completed.push(args));
  assert.deepEqual(calls, [[adapter, 'wxfile://tmp/font.ttf']]);
  assert.deepEqual(completed, [[null, 'CustomFont42']]);
  assert.equal(f.handlers.get('.png'), imageHandler);
  assert.deepEqual(f.registrations, ['.ttf']);
  assert.deepEqual(f.warnings, []);
});

test('permission exceptions settle every resource with Arial and warn only once', () => {
  const failure = new Error('loadFont:fail no permission');
  const f = fixture({ __globalAdapter: { loadFont() { throw failure; } } });
  f.install(f.parser);
  const completed = [];
  for (const file of ['one.ttf', 'two.ttf']) f.handlers.get('.ttf')(file, {}, (...args) => completed.push(args));
  assert.deepEqual(completed, [[null, 'Arial'], [null, 'Arial']]);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0][1], failure);
});

test('a separate host window adapter is used when globalThis has no usable font adapter', () => {
  for (const direct of [undefined, {}]) {
    const adapter = { family: 'WindowFont', loadFont() { return this.family; } };
    const f = fixture({ __globalAdapter: direct, window: { __globalAdapter: adapter } });
    assert.equal(f.install(f.parser), true);
    const completed = [];
    f.handlers.get('.ttf')('font.ttf', {}, (...args) => completed.push(args));
    assert.deepEqual(completed, [[null, 'WindowFont']]);
  }
});

test('falsy platform results fall back, while a later successful load keeps its family', () => {
  const results = [undefined, null, '', 'RecoveredFont'];
  const f = fixture({ __globalAdapter: { loadFont() { return results.shift(); } } });
  f.install(f.parser);
  const completed = [];
  for (let i = 0; i < 4; i++) f.handlers.get('.ttf')(`${i}.ttf`, {}, (...args) => completed.push(args));
  assert.deepEqual(completed, [[null, 'Arial'], [null, 'Arial'], [null, 'Arial'], [null, 'RecoveredFont']]);
  assert.equal(f.warnings.length, 1);
});

test('repeated installation does not replace the handler or reset warning deduplication', () => {
  const f = fixture({ __globalAdapter: { loadFont() { return null; } } });
  assert.equal(f.install(f.parser), true);
  const handler = f.handlers.get('.ttf');
  handler('first.ttf', {}, () => {});
  assert.equal(f.install(f.parser), false);
  assert.equal(f.handlers.get('.ttf'), handler);
  handler('second.ttf', {}, () => {});
  assert.deepEqual(f.registrations, ['.ttf']);
  assert.equal(f.warnings.length, 1);
});

test('web or missing adapters leave every parser untouched and can install after adapter initialization', () => {
  for (const scope of [{}, { __globalAdapter: {} }, { __globalAdapter: { loadFont: null } }]) {
    const f = fixture(scope);
    assert.equal(f.install(f.parser), false);
    assert.deepEqual(f.registrations, []);
    assert.equal(f.handlers.has('.ttf'), false);
    assert.deepEqual(f.warnings, []);
    assert.equal(f.install(f.parser, { __globalAdapter: { loadFont: () => 'ReadyFont' } }), true);
  }
});

test('a throwing completion callback is propagated without invoking it twice', () => {
  for (const loadFont of [() => 'CustomFont', () => { throw new Error('platform rejected font'); }]) {
    const f = fixture({ __globalAdapter: { loadFont } }), callbackFailure = new Error('consumer failure');
    f.install(f.parser);
    let count = 0;
    assert.throws(() => f.handlers.get('.ttf')('font.ttf', {}, () => { count++; throw callbackFailure; }),
      error => error === callbackFailure);
    assert.equal(count, 1);
  }
});

test('logging failures cannot strand the font resource', () => {
  const f = fixture(), completed = [];
  f.install(f.parser, { __globalAdapter: { loadFont() { throw new Error('permission denied'); } } },
    () => { throw new Error('console unavailable'); });
  f.handlers.get('.ttf')('font.ttf', {}, (...args) => completed.push(args));
  assert.deepEqual(completed, [[null, 'Arial']]);
});

test('a failed parser registration can be retried', () => {
  const f = fixture({ __globalAdapter: { loadFont: () => 'CustomFont' } });
  const register = f.parser.register;
  f.parser.register = () => { throw new Error('not ready'); };
  assert.throws(() => f.install(f.parser), /not ready/);
  f.parser.register = register;
  assert.equal(f.install(f.parser), true);
});
