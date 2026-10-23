const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { resolveRuntimeEnvironment } = require('./.build/session/session/RuntimeEnvironment.js');
const projectRoot = path.resolve(__dirname, '..');
const injectorPath = path.join(projectRoot, 'tools/inject-environment.cjs');
const { makeEnvironmentEntry, injectEnvironment } = require(injectorPath);

test('Missing injection selects editor preview test and standalone production independently of DEBUG', () => {
  assert.equal(resolveRuntimeEnvironment(undefined, true), 'test');
  assert.equal(resolveRuntimeEnvironment(undefined, false), 'production');
  assert.equal(resolveRuntimeEnvironment({ environment: 'test' }, false), 'test');
  assert.equal(resolveRuntimeEnvironment({ environment: 'production' }, true), 'production');
});

test('Malformed runtime configuration fails closed even inside editor preview', () => {
  for (const value of [null, true, 'test', 1, [], {}, { environment: true },
    { environment: 'TEST' }, { environment: 'staging' }, { environment: undefined }]) {
    assert.equal(resolveRuntimeEnvironment(value, true), 'production', JSON.stringify(value));
    assert.equal(resolveRuntimeEnvironment(value, false), 'production', JSON.stringify(value));
  }
});

test('Web environment executes before the first game script, ignoring commented examples', () => {
  const html = '<!doctype html>\r\n<!-- <script>comment</script> -->\r\n<head></head><body>\r\n<script>globalThis.observed = globalThis.__FOREST_GUNNER_ENV__.environment;</script>\r\n</body>';
  const result = makeEnvironmentEntry(html, 'web', 'test');
  const liveScripts = [...result.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const context = vm.createContext({});
  for (const script of liveScripts) vm.runInContext(script[1], context);
  assert.equal(context.observed, 'test');
  assert.equal(result.replace(/<!-- FOREST_GUNNER_ENV_START -->[\s\S]*?<!-- FOREST_GUNNER_ENV_END -->\r\n/, ''), html);
});

test('WeChat environment executes before application code with debug disabled', () => {
  const source = '\uFEFFconst DEBUG = false;\nif (!DEBUG) globalThis.observed = globalThis.__FOREST_GUNNER_ENV__.environment;\n';
  const result = makeEnvironmentEntry(source, 'wechat', 'test');
  const context = vm.createContext({});
  vm.runInContext(result, context);
  assert.equal(context.observed, 'test');
  assert.ok(result.startsWith('\uFEFF/* FOREST_GUNNER_ENV_START */'));
});

test('Repeated injection is stable and changing environments replaces only the prior block', () => {
  for (const [platform, source] of [
    ['web', '<html>\n<script src="game.js"></script>\n</html>'],
    ['wechat', 'require("./web-adapter");\r\nrequire("./application.js");\r\n'],
  ]) {
    const testing = makeEnvironmentEntry(source, platform, 'test');
    assert.equal(makeEnvironmentEntry(testing, platform, 'test'), testing);
    const production = makeEnvironmentEntry(testing, platform, 'production');
    assert.equal(production, makeEnvironmentEntry(source, platform, 'production'));
    assert.equal(production.split('FOREST_GUNNER_ENV_START').length - 1, 1);
    assert.ok(!production.includes('"environment":"test"'));
  }
});

test('Unexpected entry shape and invalid arguments are rejected before writing', () => {
  assert.throws(() => makeEnvironmentEntry('<html></html>', 'web', 'test'), /no script tag/);
  assert.throws(() => makeEnvironmentEntry('game();', 'wechat', 'staging'), /Environment/);
  assert.throws(() => makeEnvironmentEntry('game();', 'android', 'test'), /Platform/);
  assert.throws(() => makeEnvironmentEntry('/* FOREST_GUNNER_ENV_START */\ngame();', 'wechat', 'test'), /markers/);
  const duplicate = makeEnvironmentEntry('game();', 'wechat', 'test').repeat(2);
  assert.throws(() => makeEnvironmentEntry(duplicate, 'wechat', 'test'), /markers/);
});

test('Injection verifies real output files and preserves invalid builds', t => {
  const fixtureParent = path.resolve(__dirname, '.build');
  const fixture = fs.mkdtempSync(path.join(fixtureParent, 'environment-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixture)), fixtureParent);
    assert.ok(path.basename(fixture).startsWith('environment-fixture-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const webEntry = path.join(fixture, 'index.html');
  fs.writeFileSync(webEntry, '<script>start();</script>');
  assert.equal(injectEnvironment(fixture, 'web', 'test'), webEntry);
  const afterFirst = fs.readFileSync(webEntry, 'utf8');
  injectEnvironment(fixture, 'web', 'test');
  assert.equal(fs.readFileSync(webEntry, 'utf8'), afterFirst);
  const cli = spawnSync(process.execPath, [injectorPath, 'web', fixture, 'production'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Forest Gunner environment: production/);
  assert.match(fs.readFileSync(webEntry, 'utf8'), /"environment":"production"/);
  fs.writeFileSync(webEntry, '<html>unfinished</html>');
  assert.throws(() => injectEnvironment(fixture, 'web', 'test'), /no script tag/);
  assert.equal(fs.readFileSync(webEntry, 'utf8'), '<html>unfinished</html>');
  assert.throws(() => injectEnvironment(fixture, 'wechat', 'test'), /ENOENT/);
});

test('Build environment resolves parameter then variable then production before starting Creator', { skip: process.platform !== 'win32' }, () => {
  const cases = [
    { variable: undefined, parameter: undefined, expected: 'production' },
    { variable: 'test', parameter: undefined, expected: 'test' },
    { variable: 'test', parameter: 'production', expected: 'production' },
    { variable: 'invalid', parameter: 'test', expected: 'test' },
    { variable: 'invalid', parameter: undefined, expected: null },
    { variable: 'test', parameter: 'TEST', expected: null },
  ];
  for (const entry of cases) {
    const env = { ...process.env };
    // Windows environment variable names are case-insensitive.
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'FOREST_GUNNER_ENV') delete env[key];
    if (entry.variable !== undefined) env.FOREST_GUNNER_ENV = entry.variable;
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'tools/build.ps1'),
      '-EnginePath', path.join(projectRoot, 'tools/nonexistent-environment-test-creator.exe')];
    if (entry.parameter !== undefined) args.push('-Environment', entry.parameter);
    const result = spawnSync('powershell.exe', args, { env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.error?.message);
    const output = result.stdout + result.stderr;
    // Windows PowerShell wraps error text at the console width, even halfway
    // through a word when the checkout path is long.
    const compactOutput = output.replace(/\s+/g, '');
    if (entry.expected) {
      assert.ok(output.includes(`Build environment: ${entry.expected}`), output);
      assert.ok(compactOutput.includes('CocosCreator3.8.8wasnotfound'), output);
    } else {
      assert.ok(compactOutput.includes('mustbeexactlytestorproduction'), output);
      assert.doesNotMatch(compactOutput, /Buildenvironment:|CocosCreator3\.8\.8wasnotfound/);
    }
  }
});
