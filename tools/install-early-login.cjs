'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function buildEarlyLogin(sourceRoot = path.join(__dirname, '../assets/scripts')) {
  const modules = new Map();
  function visit(id) {
    if (modules.has(id)) return;
    const file = path.join(sourceRoot, id + '.ts');
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS, removeComments: true,
    } }).outputText;
    modules.set(id, output);
    for (const match of output.matchAll(/require\("([^"]+)"\)/g)) {
      if (!match[1].startsWith('.')) throw new Error('Early login must not depend on the engine or external modules: ' + match[1]);
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(id), match[1])));
    }
  }
  visit('session/EarlyWechatLogin');
  const factories = Array.from(modules, ([id, source]) => JSON.stringify(id) + ':function(require,module,exports){\n' + source + '\n}').join(',\n');
  return `'use strict';\nconst modules={${factories}},cache={};\nfunction load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](name=>{const parts=(id.slice(0,id.lastIndexOf('/')+1)+name).split('/'),out=[];for(const p of parts){if(p==='..')out.pop();else if(p!=='.'&&p)out.push(p);}return load(out.join('/'));},m,m.exports);return m.exports;}\nmodule.exports=load('session/EarlyWechatLogin');\n`;
}
function installEarlyLogin(directory) {
  const file = path.join(directory, 'game.js');
  let source = fs.readFileSync(file, 'utf8');
  const marker = '/* FOREST_GUNNER_ENV_END */';
  if (!source.includes(marker)) throw new Error('Inject the environment before early login');
  const call = "require('./early-login').beginEarlyWechatLogin(globalThis);";
  if (!source.includes(call)) source = source.replace(marker, marker + '\n' + call);
  fs.writeFileSync(path.join(directory, 'early-login.js'), buildEarlyLogin());
  fs.writeFileSync(file, source);
}
module.exports = { buildEarlyLogin, installEarlyLogin };
if (require.main === module) installEarlyLogin(process.argv[2]);
