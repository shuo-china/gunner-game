#!/usr/bin/env node
'use strict';

// Generate a fresh Creator staging project. Never edit or delete source assets.
// Usage: node tools/prune-release-source.cjs [--out ABSOLUTE_EMPTY_DIRECTORY]
// Without --out, print the same manifest without writing anything.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const sourceRoot = path.resolve(__dirname, '..');
const resourceRoot = path.join(sourceRoot, 'assets/resources');
const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== '--out')) {
  throw new Error('Usage: node tools/prune-release-source.cjs [--out ABSOLUTE_EMPTY_DIRECTORY]');
}
const outputRoot = argv.length ? path.resolve(argv[1]) : null;
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
if (outputRoot && (inside(sourceRoot, outputRoot) || inside(outputRoot, sourceRoot))) {
  throw new Error('Staging must be outside, and must not contain, the source project.');
}
if (outputRoot && fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length) {
  throw new Error('Refusing to overwrite a nonempty staging directory.');
}
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${path.join(dir, entry.name)}`);
    return entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)];
  });
}
const posix = value => value.split(path.sep).join('/');
const relative = file => posix(path.relative(sourceRoot, file));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const jsonFiles = files(resourceRoot).filter(file => file.endsWith('.json'));
const scriptFiles = files(path.join(sourceRoot, 'assets/scripts')).filter(file => file.endsWith('.ts'));
const configs = new Map(jsonFiles.map(file => [file, readJson(file)]));
const scripts = new Map(scriptFiles.map(file => [file, fs.readFileSync(file, 'utf8')]));
const visualsFile = path.join(resourceRoot, 'art/weapon-system/visuals.json');
const sfxFile = path.join(resourceRoot, 'art/original-sfx/config.json');
const visuals = configs.get(visualsFile);
const sfx = configs.get(sfxFile);
const originalHashes = { [relative(visualsFile)]: hash(visualsFile), [relative(sfxFile)]: hash(sfxFile) };
const removedRecords = {};
const usedProjectiles = new Set(visuals.weapons.map(weapon => weapon.projectileSkin));
const usedMuzzles = new Set(visuals.weapons.map(weapon => weapon.muzzleSkin));
function filterRecord(name, used) {
  removedRecords[name] = Object.keys(visuals[name] || {}).filter(key => !used.has(key));
  visuals[name] = Object.fromEntries(Object.entries(visuals[name] || {}).filter(([key]) => used.has(key)));
}
filterRecord('projectileSkins', usedProjectiles);
filterRecord('muzzleSkins', usedMuzzles);
filterRecord('customProjectiles', usedProjectiles);
for (const weapon of visuals.weapons) {
  if (!visuals.projectileSkins[weapon.projectileSkin] || !visuals.muzzleSkins[weapon.muzzleSkin]) {
    throw new Error(`Weapon ${weapon.id} has an unresolved appearance dependency.`);
  }
}

// Actual numeric call sites plus data-driven UI and weapon sound IDs.
// All calls to play/sound are inspected; unresolved forwarding expressions are
// recorded so a future code change cannot silently masquerade as proof.
const soundIds = new Set();
const soundEvidence = [];
const unresolvedCalls = [];
function addSound(value, evidence) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    soundIds.add(value); soundEvidence.push({ id: value, evidence });
  }
}
function visitData(value, visitor, trail = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    visitor(key, item, trail);
    visitData(item, visitor, [...trail, key]);
  }
}
for (const [file, config] of configs) {
  visitData(config, (key, item, trail) => {
    if (key === 'soundId' || key === 'clickSound') addSound(item, `${relative(file)}:${[...trail, key].join('.')}`);
    if (key === 'sounds' && item && typeof item === 'object') {
      for (const [name, id] of Object.entries(item)) addSound(id, `${relative(file)}:${[...trail, key, name].join('.')}`);
    }
  });
}
for (const [file, source] of scripts) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function numbers(node, evidence) {
    if (ts.isNumericLiteral(node)) addSound(Number(node.text), evidence);
    else if (ts.isConditionalExpression(node)) { numbers(node.whenTrue, evidence); numbers(node.whenFalse, evidence); }
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) numbers(node.right, evidence);
  }
  function visit(node) {
    if (ts.isCallExpression(node) && /(?:\.playSfx|\.sound|sfx\??\.play)$/.test(node.expression.getText(ast))) {
      const location = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      const evidence = `${relative(file)}:${location.line + 1}:${node.getText(ast)}`;
      for (const argument of node.arguments) {
        numbers(argument, evidence);
        if (!ts.isNumericLiteral(argument)) unresolvedCalls.push(evidence);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
// Existing dynamic branches use exactly these data-backed/forwarded forms.
// Fail closed if future changes introduce a new unknown sound dispatch.
const allowedDynamicArguments = new Set([
  'id', 'spec.clickSound', 'this.assets.config.sounds[transition.kind]',
  "this.art.weaponVisuals?.appearance(event.weaponId).soundId??8",
  "state.phase === 'failed' ? 12 : 11", 'success ? 4 : 5',
  "result.status === 'success' ? 15 : 16", 'merged ? 3 : 9',
]);
for (const [file, source] of scripts) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node) && /(?:\.playSfx|\.sound|sfx\??\.play)$/.test(node.expression.getText(ast))) {
      for (const argument of node.arguments) {
        if (!ts.isNumericLiteral(argument) && !allowedDynamicArguments.has(argument.getText(ast))) {
          throw new Error(`Unreviewed dynamic sound dispatch in ${relative(file)}: ${argument.getText(ast)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
filterRecord('sounds', new Set([...soundIds].map(String)));
removedRecords.originalSfxEntries = sfx.entries.filter(entry => !soundIds.has(entry.id)).map(entry => entry.id);
sfx.entries = sfx.entries.filter(entry => soundIds.has(entry.id));
for (const id of soundIds) if (!sfx.entries.some(entry => entry.id === id)) throw new Error(`Missing runtime sound ${id}`);

// Some source fields are executable runtime data: confetti.record.source,
// blend.source, sourceTransform, sourceVolume, sourcePitch. Report, never strip.
const auditFields = new Map();
for (const [file, config] of configs) visitData(config, (key, item, trail) => {
  if (!/^source/i.test(key)) return;
  const summary = auditFields.get(key) || { field: key, occurrences: 0, serializedBytes: 0, examples: [] };
  summary.occurrences++;
  summary.serializedBytes += Buffer.byteLength(JSON.stringify({ [key]: item }));
  if (summary.examples.length < 3) summary.examples.push(`${relative(file)}:${[...trail, key].join('.')}`);
  auditFields.set(key, summary);
});

const changed = new Map([[visualsFile, JSON.stringify(visuals) + '\n'], [sfxFile, JSON.stringify(sfx) + '\n']]);
const allReferences = [...configs.values()].map(value => JSON.stringify(value)).concat([...scripts.values()]).join('\n');
const omitted = [];
// These candidates were also independently checked for UUID and dynamic-path
// references. Retain future unknown candidates until they receive that review.
const reviewedUnusedFiles = new Set([
  'assets/resources/art/raid-system/images/s589.png',
  'assets/resources/art/raid-system/images/s656.png',
  'assets/resources/art/raid-system/images/s812.png',
  'assets/resources/art/weapon-system/audio/sfx-0.wav',
  'assets/resources/art/weapon-system/audio/sfx-14.wav',
  'assets/resources/art/weapons/redesigned/bow_A_1452044.png',
  'assets/resources/art/weapons/redesigned/bow_B_1452011.png',
  'assets/resources/art/weapons/redesigned/bow_C_1452006.png',
]);
for (const file of files(resourceRoot)) {
  // Auto-atlases/effects use Creator-managed dependencies and are retained.
  if (!/\.(?:png|wav|mp3|ttf)$/.test(file)) continue;
  const resourcePath = posix(path.relative(resourceRoot, file)).replace(/\.[^.]+$/, '');
  if (reviewedUnusedFiles.has(relative(file)) && !allReferences.includes(resourcePath)) {
    omitted.push({ file: relative(file), bytes: fs.statSync(file).size, sha256: hash(file), reason: 'No remaining runtime script or resource-config path reference' });
  }
}
const selectedSourcesFile = path.join(resourceRoot, 'art/weapon-system/audio/selected-sources.json');
if (fs.existsSync(selectedSourcesFile) && !allReferences.includes('art/weapon-system/audio/selected-sources')) {
  omitted.push({ file: relative(selectedSourcesFile), bytes: fs.statSync(selectedSourcesFile).size, sha256: hash(selectedSourcesFile), reason: 'Audio authoring provenance, not loaded by runtime' });
}
const omitFiles = new Set(omitted.flatMap(item => [item.file, item.file + '.meta']));
const configChanges = [...changed].map(([file, contents]) => ({ file: relative(file), beforeBytes: fs.statSync(file).size, afterBytes: Buffer.byteLength(contents) }));
const manifest = {
  version: 1, sourceRoot, outputRoot, originalHashes,
  preservedWeaponCount: visuals.weapons.length, removedRecords,
  retainedSoundIds: [...soundIds].sort((a, b) => a - b), soundEvidence,
  reviewedDynamicSoundCalls: [...new Set(unresolvedCalls)], configChanges, omitted,
  savedResourceBytes: omitted.reduce((sum, item) => sum + item.bytes, 0),
  savedConfigBytes: configChanges.reduce((sum, item) => sum + item.beforeBytes - item.afterBytes, 0),
  sourceFieldPolicy: 'Report only. Never globally strip source-prefixed fields; several contain runtime simulation, blending, and audio data.',
  sourceFieldAudit: [...auditFields.values()].sort((a, b) => b.serializedBytes - a.serializedBytes),
};
if (outputRoot) {
  fs.mkdirSync(outputRoot, { recursive: true });
  const roots = ['assets', 'settings', 'build-templates', 'extensions', 'package.json', 'package-lock.json', 'tsconfig.json', 'build-wechat.json'];
  for (const name of roots) {
    const entry = path.join(sourceRoot, name);
    if (!fs.existsSync(entry)) continue;
    const sourceFiles = fs.statSync(entry).isDirectory() ? files(entry) : [entry];
    for (const file of sourceFiles) {
      const rel = relative(file);
      if (omitFiles.has(rel)) continue;
      const target = path.join(outputRoot, rel);
      if (!inside(outputRoot, target)) throw new Error('Staging path escaped its root.');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (changed.has(file)) fs.writeFileSync(target, changed.get(file));
      else fs.copyFileSync(file, target);
    }
  }
  for (const [file, expected] of Object.entries(originalHashes)) {
    if (hash(path.join(sourceRoot, file)) !== expected) throw new Error(`Source changed while staging: ${file}`);
  }
  fs.writeFileSync(path.join(outputRoot, 'release-prune-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
