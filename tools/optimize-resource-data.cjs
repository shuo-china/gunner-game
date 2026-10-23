'use strict';
// Remove only unreferenced historical font atlases and unreachable font metadata.
// --check is read-only. --write requires a fresh backup outside the project.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const project = path.resolve(__dirname, '..');
const resources = path.join(project, 'assets/resources');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const relative = file => path.relative(project, file).split(path.sep).join('/');
function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${path.join(root, entry.name)}`);
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
function visit(value, fn, trail = []) {
  if (!value || typeof value !== 'object') return;
  fn(value, trail);
  for (const [key, item] of Object.entries(value)) visit(item, fn, [...trail, key]);
}
function compactJson(value) {
  // JSON.stringify converts negative zero to positive zero. Preserve the exact
  // parsed numeric values of original animation/quaternion data as well.
  if (Object.is(value, -0)) return '-0';
  if (Array.isArray(value)) return '[' + value.map(compactJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .map(([key, item]) => JSON.stringify(key) + ':' + compactJson(item)).join(',') + '}';
  return JSON.stringify(value);
}
function optimizeConfig(config) {
  const edits = [];
  // OriginalWeaponUi.setText returns through OriginalBitmapText when this
  // profile has a bitmap font. Its Latin advances come from glyph.advance;
  // Chinese/absent glyphs use platform measurement, not textProfiles.advances.
  // Keep the dictionary shape for old authoring tools. Profiles without a
  // bitmap implementation retain their entire legacy fallback width table.
  for (const [key, profile] of Object.entries(config.textProfiles ?? {})) {
    const font = config.bitmapFonts?.[key];
    if (font && Array.isArray(font.pages) && font.glyphs && profile.advances && Object.keys(profile.advances).length) {
      edits.push({ path: ['textProfiles', key, 'advances'], kind: 'unused-bitmap-fallback-advances', entries: Object.keys(profile.advances).length });
      profile.advances = {};
    }
  }
  visit(config, (font, trail) => {
    if (!Array.isArray(font.pages) || !font.glyphs || !font.kerning) return;
    for (const [key, adjustment] of Object.entries(font.kerning)) {
      const pair = key.split(':');
      // Both tokens must have glyphs before OriginalBitmapText looks up a pair.
      // Keep even zero pairs when reachable, preserving all supported kerning.
      if (pair.length === 2 && (!font.glyphs[pair[0]] || !font.glyphs[pair[1]])) {
        edits.push({ path: [...trail, 'kerning', key], kind: 'unreachable-glyph-pair' });
        delete font.kerning[key];
      }
    }
  });
  return edits;
}
function scan() {
  const resourceFiles = files(resources), jsonFiles = resourceFiles.filter(f => f.endsWith('.json'));
  const sourceTexts = ['assets', 'settings', 'build-templates', 'extensions'].flatMap(name => {
    const root = path.join(project, name);
    return fs.existsSync(root) ? files(root) : [];
  }).filter(file => /\.(?:json|ts|js|cjs|scene|prefab|mtl|effect|pac|meta)$/.test(file))
    .map(file => ({ file, text: fs.readFileSync(file, 'utf8') }));
  const retire = [];
  for (const file of resourceFiles.filter(file => /[/\\]fonts[/\\][^/\\]+\.png$/.test(file))) {
    const resourcePath = path.relative(resources, file).split(path.sep).join('/').replace(/\.png$/, '');
    const metadata = file + '.meta', uuid = JSON.parse(fs.readFileSync(metadata, 'utf8')).uuid;
    assert.equal(typeof uuid, 'string');
    const references = sourceTexts.filter(source => source.file !== metadata &&
      (source.text.includes(resourcePath) || source.text.includes(uuid)));
    if (!references.length) retire.push(file, metadata);
  }
  // Explicitly reject directory-wide or legacy font-path loading rather than
  // allowing a future loader change to invalidate this static reference audit.
  const dynamicFonts = sourceTexts.filter(source => source.file.endsWith('.ts') &&
    /\bloadDir\s*\(|['"`][^'"`\r\n]*\/fonts\//.test(source.text));
  if (retire.length && dynamicFonts.length) throw new Error('Review dynamic font loading before retiring atlases: ' + dynamicFonts.map(s => relative(s.file)).join(', '));
  const changes = [];
  for (const file of jsonFiles) {
    const original = fs.readFileSync(file), config = JSON.parse(original.toString('utf8'));
    const edits = optimizeConfig(config), candidate = Buffer.from(compactJson(config) + '\n');
    // This tool never expands a file merely to normalize formatting.
    if (candidate.length < original.length) changes.push({ file, original, candidate, edits });
  }
  return { resourceFiles, retire, changes };
}
function run(argv) {
  const write = argv[0] === '--write', check = argv.length === 1 && argv[0] === '--check';
  if (!check && !(write && argv.length === 3 && argv[1] === '--backup')) {
    throw new Error('Usage: node tools/optimize-resource-data.cjs --check | --write --backup ABSOLUTE_FRESH_DIRECTORY');
  }
  const plan = scan();
  const resourceOnly = plan.resourceFiles.filter(file => !file.endsWith('.meta'));
  const report = {
    version: 1, resourcesBefore: resourceOnly.reduce((n, file) => n + fs.statSync(file).size, 0),
    retiredFonts: plan.retire.filter(f => f.endsWith('.png')).map(file => ({ path: relative(file), bytes: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) })),
    json: plan.changes.map(c => ({ path: relative(c.file), beforeBytes: c.original.length, afterBytes: c.candidate.length,
      beforeSha256: hash(c.original), afterSha256: hash(c.candidate), edits: c.edits })),
  };
  report.savedFontBytes = report.retiredFonts.reduce((n, f) => n + f.bytes, 0);
  report.savedJsonBytes = report.json.reduce((n, f) => n + f.beforeBytes - f.afterBytes, 0);
  report.resourcesAfter = report.resourcesBefore - report.savedFontBytes - report.savedJsonBytes;
  if (write) {
    const backup = path.resolve(argv[2]);
    if (!path.isAbsolute(argv[2]) || inside(project, backup) || inside(backup, project) || backup === project || fs.existsSync(backup)) {
      throw new Error('Backup must be a fresh absolute directory outside the project.');
    }
    // Finish and verify every backup before touching project data.
    for (const file of [...plan.retire, ...plan.changes.map(c => c.file)]) {
      if (!inside(resources, file)) throw new Error('Resource path escaped project: ' + file);
      const target = path.join(backup, relative(file));
      if (!inside(backup, target)) throw new Error('Backup path escaped its root: ' + target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
      assert.equal(hash(fs.readFileSync(target)), hash(fs.readFileSync(file)));
    }
    fs.writeFileSync(path.join(backup, 'optimization-report.json'), JSON.stringify(report, null, 2) + '\n');
    for (const c of plan.changes) {
      assert.equal(hash(fs.readFileSync(c.file)), hash(c.original), 'Source changed during optimization');
      fs.writeFileSync(c.file, c.candidate);
    }
    for (const file of plan.retire) {
      if (!inside(resources, file)) throw new Error('Unsafe font path: ' + file);
      assert.equal(hash(fs.readFileSync(file)), hash(fs.readFileSync(path.join(backup, relative(file)))));
      fs.unlinkSync(file);
    }
    report.backup = backup;
  }
  console.log(JSON.stringify({ fonts: report.retiredFonts.length, jsonFiles: report.json.length,
    savedFontBytes: report.savedFontBytes, savedJsonBytes: report.savedJsonBytes,
    resourcesBefore: report.resourcesBefore, resourcesAfter: report.resourcesAfter, backup: report.backup ?? null }));
  if (check && (plan.retire.length || plan.changes.length)) process.exitCode = 1;
  return report;
}
if (require.main === module) run(process.argv.slice(2));
module.exports = { optimizeConfig, compactJson, scan };
