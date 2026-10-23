'use strict';
// Generate small runtime catalogs from the reviewed, full authoring data.
// Never rewrite the authoring JSON; preserve negative zero and every effect value.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { compactMeshMetadata } = require('./lib/compact-mesh-metadata.cjs');
const root = path.resolve(__dirname, '..');
const resourceRoot = path.join(root, 'assets/resources');
const base = 'art/weapon-runtime';
function stringify(value) {
  if (Object.is(value, -0)) return '-0';
  if (Array.isArray(value)) return '[' + value.map(stringify).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .map(([key, item]) => JSON.stringify(key) + ':' + stringify(item)).join(',') + '}';
  return JSON.stringify(value);
}
function generate() {
  const visuals = JSON.parse(fs.readFileSync(path.join(resourceRoot, 'art/weapon-system/visuals.json'), 'utf8'));
  const source = fs.readFileSync(path.join(root, 'assets/scripts/core/WeaponData.ts'), 'utf8');
  const definitions = JSON.parse(source.slice(source.indexOf('= [') + 2, source.lastIndexOf(';')));
  const categories = new Map(definitions.map(item => [item.id, item.category]));
  const groups = new Map(), projectileGroups = {};
  for (const weapon of visuals.weapons) {
    let group = categories.get(weapon.id);
    if (!group) throw new Error('Missing weapon category: ' + weapon.id);
    if (group === 'bow' || group === 'crossbow') group = 'archery';
    const key = weapon.projectileSkin;
    if (projectileGroups[key] && projectileGroups[key] !== `${base}/projectiles/${group}`)
      throw new Error('Projectile shared across unrelated categories: ' + key);
    projectileGroups[key] = `${base}/projectiles/${group}`;
    if (!groups.has(group)) groups.set(group, { projectileSkins: {}, customProjectiles: {} });
    const value = groups.get(group);
    if (!visuals.projectileSkins[key]) throw new Error('Missing projectile: ' + key);
    value.projectileSkins[key] = visuals.projectileSkins[key];
    if (visuals.customProjectiles?.[key]) value.customProjectiles[key] = visuals.customProjectiles[key];
  }
  const { projectileSkins, customProjectiles, ...catalog } = visuals;
  const files = new Map([[`${base}/index.json`, stringify({ ...catalog, version: 1, projectileGroups }) + '\n']]);
  for (const [group, value] of groups) {
    const compact = compactMeshMetadata({ version: 1, files: { config: stringify(value) } }).metadata;
    files.set(`${base}/projectiles/${group}.json`, stringify({ version: 1,
      data: JSON.parse(compact.files.config), meshGeometries: compact.meshGeometries ?? [],
      meshes: compact.meshes?.config ?? [] }) + '\n');
  }
  return files;
}
function uuid(name) {
  const hex = crypto.createHash('sha256').update('forest-gunner-runtime:' + name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function meta(name, directory) {
  return JSON.stringify({ ver: directory ? '1.2.0' : '2.0.1', importer: directory ? 'directory' : 'json',
    imported: true, uuid: uuid(name), files: directory ? [] : ['.json'], subMetas: {}, userData: {} }, null, 2) + '\n';
}
function run(check) {
  const files = generate(), output = new Map();
  for (const directory of [base, `${base}/projectiles`]) output.set(directory + '.meta', meta(directory, true));
  for (const [name, contents] of files) { output.set(name, contents); output.set(name + '.meta', meta(name, false)); }
  for (const [name, contents] of output) {
    const target = path.join(resourceRoot, name);
    if (check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== contents) throw new Error('Stale weapon runtime resource: ' + name);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== contents) fs.writeFileSync(target, contents);
    }
  }
  console.log(JSON.stringify({ checked: check, files: [...files].map(([name, text]) => ({ name, bytes: Buffer.byteLength(text) })) }));
}
if (require.main === module) {
  if (process.argv.slice(2).some(arg => !['--check', '--write'].includes(arg))) throw new Error('Usage: build-weapon-runtime.cjs [--check|--write]');
  run(process.argv.includes('--check'));
}
module.exports = { generate, stringify };
