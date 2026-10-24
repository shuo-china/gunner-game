const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./paths.cjs');

const supported = new Set(['ResourceLoadingPolicy', 'ResourceBatch', 'BackgroundPreparationScheduler', 'BackgroundResourceQueue', 'FeatureResourceManifest', 'GameResourceLoader', 'UiPreparationQueue', 'ResourceModuleManager', 'StartupPreparationBudget', 'StartupTimeline']);
const compiled = new Map();

function resourceModules(cc = {}, globals = {}) {
  const modules = new Map();
  function load(name) {
    if (!supported.has(name)) throw new Error(`Unexpected resource test dependency: ${name}`);
    if (modules.has(name)) return modules.get(name);
    const filename = projectPath('assets/scripts/view', name + '.ts');
    if (!compiled.has(name)) compiled.set(name, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS },
    }).outputText);
    const module = { exports: {} };
    vm.runInNewContext(compiled.get(name), { module, exports: module.exports, setTimeout, clearTimeout, ...globals,
      require: dependency => dependency === 'cc' ? cc : load(path.basename(dependency)) }, { filename });
    modules.set(name, module.exports);
    return module.exports;
  }
  return load;
}

module.exports = { resourceModules };
