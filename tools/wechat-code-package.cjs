'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const FEATURE_MODULES = { weapons: 'WeaponHud', speedrun: 'SpeedRunHud', rebirth: 'RebirthHud', raid: 'RaidHud',
  boss: 'BossHud', hunt: 'HuntHud', mine: 'MineHud', skins: 'SkinHud', pets: 'PetHud', fish: 'FishHud', adventure: 'AdventureHud' };

function splitModules(source) {
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error('Cannot parse Creator script bundle');
  const modules = new Map();
  for (const statement of ast.statements) {
    const call = statement.expression;
    if (!call || !ts.isCallExpression(call) || call.expression.getText(ast) !== 'System.register') continue;
    const [name, deps] = call.arguments;
    if (!ts.isStringLiteral(name) || !ts.isArrayLiteralExpression(deps) || deps.elements.some(x => !ts.isStringLiteral(x))) throw new Error('Unexpected System.register');
    if (modules.has(name.text)) throw new Error('Duplicate module ' + name.text);
    modules.set(name.text, { id: name.text, deps: deps.elements.map(x => new URL(x.text, name.text).href),
      rawDeps: deps.elements.map(x => x.text), start: statement.getStart(ast), end: statement.end, text: statement.getText(ast) });
  }
  const root = 'chunks:///_virtual/', barrel = modules.get(root + 'main');
  if (!barrel || !modules.has(root + 'GameBootstrap.ts')) throw new Error('Expected Creator main module and bootstrap');
  const closure = seeds => {
    const found = new Set();
    const visit = id => { if (found.has(id) || !modules.has(id)) return; found.add(id); for (const dep of modules.get(id).deps) visit(dep); };
    seeds.forEach(visit); return found;
  };
  const features = Object.fromEntries(Object.entries(FEATURE_MODULES).map(([name, stem]) => {
    const id = root + stem + '.ts';
    if (!modules.has(id)) throw new Error('Missing lazy feature module ' + id);
    return [name, closure([id])];
  }));
  const candidates = new Set(Object.values(features).flatMap(x => [...x]));
  // Preserve every other script's side effects, plus all static dependencies of
  // Bootstrap. Only modules exclusively owned by dynamic feature imports move.
  const eager = closure([...modules.keys()].filter(id => id !== barrel.id && (!candidates.has(id) || id === root + 'GameBootstrap.ts')));
  const deferred = [...candidates].filter(id => !eager.has(id));
  if (!deferred.length) throw new Error('No deferred feature code; check for accidental static HUD imports');
  const groups = new Map();
  for (const id of deferred) {
    const owners = Object.keys(features).filter(name => features[name].has(id)).sort();
    const key = owners.length > 1 ? 'shared' : owners[0];
    if (!groups.has(key)) groups.set(key, { owners, modules: [] });
    else groups.get(key).owners = [...new Set([...groups.get(key).owners, ...owners])];
    groups.get(key).modules.push(modules.get(id));
  }
  const removed = new Set(deferred), edits = deferred.map(id => ({ ...modules.get(id), replacement: '' }));
  const kept = barrel.rawDeps.filter((_, i) => !removed.has(barrel.deps[i]));
  edits.push({ ...barrel, replacement: `System.register(${JSON.stringify(barrel.id)},${JSON.stringify(kept)},function(){return{setters:[${kept.map(()=>'function(){}').join(',')}],execute:function(){}}});` });
  let main = source;
  for (const edit of edits.sort((a,b) => b.start - a.start)) main = main.slice(0, edit.start) + edit.replacement + main.slice(edit.end);
  return { main, groups: [...groups.values()], deferred, retained: modules.size - deferred.length };
}

function packageFeatureCode(codeDirectory) {
  const directory = path.join(codeDirectory, 'assets/main');
  const names = fs.readdirSync(directory).filter(name => /^index(?:\.[a-f0-9]+)?\.js$/.test(name));
  if (names.length !== 1) throw new Error('Expected one main script bundle');
  const file = path.join(directory, names[0]), source = fs.readFileSync(file, 'utf8'), split = splitModules(source);
  const packages = [], features = Object.fromEntries(Object.keys(FEATURE_MODULES).map(name => [name, []]));
  for (const [index, group] of split.groups.entries()) {
    const name = 'forest-code-' + (group.owners.length === 1 ? group.owners[0] : 'shared-' + index);
    const root = 'subpackages/' + name + '/';
    fs.mkdirSync(path.join(codeDirectory, root), { recursive: true });
    fs.writeFileSync(path.join(codeDirectory, root, 'game.js'), '// Feature module registration is loaded explicitly after delivery.\n');
    const script = group.modules.map(x => x.text).join('\n') + '\n';
    fs.writeFileSync(path.join(codeDirectory, root, 'index.js'), script);
    packages.push({ name, root, modules: group.modules.map(x=>x.id), bytes: Buffer.byteLength(script) });
    group.owners.forEach(owner => features[owner].push(name));
  }
  fs.writeFileSync(file, split.main);
  const runtime = fs.readFileSync(path.join(__dirname, 'wechat-code-runtime.cjs'), 'utf8');
  fs.writeFileSync(path.join(codeDirectory, 'feature-code.js'), runtime + '\ninstallFeatureCode(' + JSON.stringify(features) + ',globalThis,require);\n');
  const entryFile = path.join(codeDirectory, 'game.js');
  let entry = fs.readFileSync(entryFile, 'utf8');
  const anchor = "require('./startup-features').installFeatureResources(cc);";
  if (!entry.includes(anchor)) throw new Error('Feature resource hook missing');
  entry = entry.replace(anchor, anchor + "\n        require('./feature-code');");
  fs.writeFileSync(entryFile, entry);
  return { packages, features, deferredModules: split.deferred.length, retainedModules: split.retained,
    mainScriptBeforeBytes: Buffer.byteLength(source), mainScriptAfterBytes: Buffer.byteLength(split.main) };
}
module.exports = { splitModules, packageFeatureCode };
