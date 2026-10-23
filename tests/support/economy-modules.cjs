const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../.build/session');
const original = require(path.join(root, 'core/EconomyConfig.js'));

// Load the real compiled dependency graph with an independently edited config.
// Neither the release source nor Node's shared require cache is mutated.
function economyModules(edit = () => {}) {
  const config = JSON.parse(JSON.stringify(original.ECONOMY_CONFIG));
  edit(config); original.validateEconomyConfig(config);
  function freeze(value) { Object.values(value).forEach(v => { if (v && typeof v === 'object') freeze(v); }); return Object.freeze(value); }
  freeze(config);
  const cache = new Map([[path.join(root, 'core/EconomyConfig.js'), { ...original, ECONOMY_CONFIG: config }]]);
  function load(name, parent = root) {
    const filename = path.resolve(parent, name.endsWith('.js') ? name : name + '.js');
    if (!filename.startsWith(root + path.sep)) throw new Error('Unexpected economy test dependency');
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} }; cache.set(filename, module.exports);
    const source = fs.existsSync(filename) ? filename : path.resolve(root, '..', path.relative(root, filename));
    vm.runInThisContext(`(function(require, module, exports) {\n${fs.readFileSync(source, 'utf8')}\n})`, { filename })(
      dependency => load(dependency, path.dirname(filename)), module, module.exports);
    cache.set(filename, module.exports); return module.exports;
  }
  return load;
}
module.exports = { economyModules };
