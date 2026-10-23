const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');

function loader(name, fontFailure) {
  class Font {}
  const module = { exports: {} }, fontRequests = [];
  const cc = { Font, resources: { load(resource, Type, callback) {
    fontRequests.push(resource);
    try { const value = fontFailure(); callback(value ? null : Error('platform font returned no family'), value); }
    catch (error) { callback(error); }
  } } };
  const imports = { cc, './ResourceBatch': { loadResourceBatch: jobs => Promise.all(jobs.map(job => job())) } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view', name + '.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports, require: key => imports[key] || {} });
  return { exports: module.exports, fontRequests };
}

for (const mode of ['throws', 'returns empty']) test(`UI asset loading succeeds when the platform font loader ${mode}`, async () => {
  const requests = new Set(), configs = [];
  const art = {
    async json(name) { const config = JSON.parse(fs.readFileSync(projectPath('assets/resources', name + '.json'), 'utf8')); configs.push(config); return config; },
    async loadFrame(name) { assert.ok(fs.existsSync(projectPath('assets/resources', name + '.png')), name); requests.add(name); return {}; },
  };
  const failure = () => { if (mode === 'throws') throw Error('WeChat font API is unavailable'); return null; };
  for (const [name, method, args] of [
    ['OriginalHudAssets', 'loadOriginalHudAssets', []],
    ['OriginalAlerts', 'loadOriginalAlertAssets', []],
    ['OriginalWeaponUi', 'loadWeaponHudAssets', []],
    ['SettingsHud', 'loadSettingsHudAssets', []],
    ['FeatureEntry', 'loadFeatureEntry', ['weapons']],
  ]) {
    const target = loader(name, failure);
    await target.exports[method](art, ...args);
    assert.deepEqual(target.fontRequests, [], name + ' must not request a TTF');
  }
  for (const config of configs) {
    const fonts = [...Object.values(config.bitmapFonts || {}), config.bitmapFont, config.input?.bitmapFont].filter(Boolean);
    for (const font of fonts) for (const page of font.pages) assert.ok(requests.has(page), 'page was not preloaded: ' + page);
  }
  assert.ok(configs.some(config => config.bitmapFont), 'includes startup bitmap font catalogs');
});
