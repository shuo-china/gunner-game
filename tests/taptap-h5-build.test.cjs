const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeEnvironmentEntry } = require('../tools/inject-environment.cjs');
const { auditTapTapH5 } = require('../tools/audit-taptap-h5.cjs');

test('TapTap channel is visible before startup and reinjection cannot leave stale channel configuration', () => {
  const original = '<!-- <script>ignored</script> --><script>globalThis.observed = [globalThis.__FOREST_GUNNER_ENV__.environment,globalThis.__FOREST_GUNNER_PLATFORM__.channel];</script>';
  const injected = makeEnvironmentEntry(original, 'taptap-h5', 'production');
  const context = vm.createContext({});
  for (const match of injected.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
  assert.equal(JSON.stringify(context.observed), '["production","taptap-h5"]');
  assert.equal(makeEnvironmentEntry(injected, 'taptap-h5', 'production'), injected);
  assert.equal(makeEnvironmentEntry(injected, 'web', 'production'), makeEnvironmentEntry(original, 'web', 'production'));
});

function fixture(t) {
  const parent = path.resolve(__dirname, '.build');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'h5-audit-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('h5-audit-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
  const settings = { CocosEngine: '3.8.8', engine: { debug: false, platform: 'web-mobile' },
    splashScreen: { totalTime: 0, logo: { type: 'none' } },
    screen: { orientation: 'portrait' }, assets: { server: '', remoteBundles: [], subpackages: [], projectBundles: ['resources'], bundleVers: { resources: 'abc' } },
    scripting: { scriptPackages: ['../src/chunks/bundle.js'] } };
  write('src/settings.abc.json', JSON.stringify(settings));
  write('src/import-map.abc.json', JSON.stringify({ imports: { cc: './../cocos-js/cc.js' } }));
  write('cocos-js/cc.js', '/* engine fixture */');
  write('src/chunks/bundle.js', 'const app="tapmcg8evaubisjmzc",api="https://nurse.kylinsit.com/game/v1";');
  write('assets/resources/config.abc.json', '{}');
  write('index.html', makeEnvironmentEntry('<html><script src="src/chunks/bundle.js"></script></html>', 'taptap-h5', 'production'));
  return { root, settings, write };
}

test('H5 release audit checks local settings, content hashes and actual referenced files', t => {
  const { root, write } = fixture(t);
  const first = auditTapTapH5(root);
  assert.equal(first.channel, 'taptap-h5');
  assert.equal(first.fileCount, 6);
  assert.match(first.realHostAcceptance, /PENDING/);
  assert.ok(first.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  write('cocos-js/cc.js', '/* changed engine fixture */');
  const second = auditTapTapH5(root);
  assert.notEqual(first.files.find(file => file.path === 'cocos-js/cc.js').sha256, second.files.find(file => file.path === 'cocos-js/cc.js').sha256);
  fs.unlinkSync(path.join(root, 'cocos-js/cc.js'));
  assert.throws(() => auditTapTapH5(root), /Missing or escaping local asset/);
});

test('H5 release audit rejects debug, remote assets, stale environments and leaked configuration', async t => {
  const cases = [
    ['debug engine', f => { f.settings.engine.debug = true; f.write('src/settings.abc.json', JSON.stringify(f.settings)); }, /production Creator/],
    ['remote bundle', f => { f.settings.assets.remoteBundles = ['resources']; f.write('src/settings.abc.json', JSON.stringify(f.settings)); }, /production Creator/],
    ['source map', f => f.write('bundle.js.map', '{}'), /Unexpected source/],
    ['environment file', f => f.write('.env', 'EXAMPLE=redacted'), /Unexpected source/],
    ['private key', f => f.write('leak.js', '"-----BEGIN PRIVATE KEY-----"'), /secret configuration/],
    ['sourceMappingURL', f => f.write('cocos-js/cc.js', '//# sourceMappingURL=debug.map'), /Debug or secret/],
    ['late channel', f => f.write('index.html', '<script src="cocos-js/cc.js"></script>' + fs.readFileSync(path.join(f.root, 'index.html'), 'utf8')), /before all scripts/],
    ['test environment', f => f.write('index.html', makeEnvironmentEntry('<script src="cocos-js/cc.js"></script>', 'taptap-h5', 'test')), /production/],
    ['root asset', f => f.write('index.html', makeEnvironmentEntry('<script src="/cocos-js/cc.js"></script>', 'taptap-h5', 'production')), /relative local asset/],
    ['escaping asset', f => f.write('index.html', makeEnvironmentEntry('<script src="../escape.js"></script>', 'taptap-h5', 'production')), /escaping local asset/],
  ];
  for (const [name, mutate, message] of cases) await t.test(name, t => { const f = fixture(t); mutate(f); assert.throws(() => auditTapTapH5(f.root), message); });
});
