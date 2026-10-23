'use strict';
// Exact source-byte deduplication, before Creator hashes or imports the files.
// Default/--check is read-only. --write rewrites explicit JSON resource paths
// first, then removes only the verified duplicates/unreferenced PNGs and WAVs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const posix = value => value.split(path.sep).join('/');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory() && ['.build', 'node_modules', '__pycache__'].includes(entry.name)) return [];
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Resource audit refuses symlinks: ' + file);
    return entry.isDirectory() ? files(file) : [file];
  }).sort();
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
/** UUIDs and editor display names identify an import, not its rendered meaning.
 * Filtering, slices, pivots, trim, vertices, compression, wrap, and audio import
 * settings must otherwise agree exactly. External UUID references stay intact. */
function importSignature(meta) {
  if (!meta || typeof meta.uuid !== 'string' || !['image', 'audio-clip'].includes(meta.importer)) return null;
  const identity = meta.uuid;
  const normalize = (value, inUserData = false) => {
    if (typeof value === 'string') return value === identity || value.startsWith(identity + '@') ? '$SELF' + value.slice(identity.length) : value;
    if (Array.isArray(value)) return value.map(item => normalize(item, inUserData));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key, item]) => inUserData || (key !== 'displayName' && !(key === 'uuid' && typeof item === 'string' && (item === identity || item.startsWith(identity + '@')))))
      .map(([key, item]) => [key, normalize(item, inUserData || key === 'userData')]));
  };
  return JSON.stringify(stable(normalize(meta)));
}
function uuidForms(uuid) {
  const hex = uuid.replace(/-/g, '');
  if (!/^[a-f\d]{32}$/i.test(hex)) return [uuid];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const compress = prefix => {
    let value = hex.slice(0, prefix);
    for (let index = prefix; index < hex.length; index += 3) {
      const number = parseInt(hex.slice(index, index + 3), 16);
      value += alphabet[number >> 6] + alphabet[number & 63];
    }
    return value;
  };
  return [uuid, hex, compress(2), compress(5)];
}
function jsonStrings(value, visit, visitKey = () => {}) {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach(item => jsonStrings(item, visit, visitKey));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { visitKey(key); jsonStrings(item, visit, visitKey); });
}
/** Replacing string values preserves all unrelated numeric spelling, including
 * animation negative zero. Object keys are deliberately never rewritten. */
function rewriteJson(text, replacements) {
  return text.replace(/"(?:\\.|[^"\\])*"/g, (literal, offset) => {
    if (/^\s*:/.test(text.slice(offset + literal.length))) return literal;
    const value = JSON.parse(literal);
    for (const suffix of ['', '/spriteFrame', '/texture', '.png', '.wav']) {
      if (suffix && !value.endsWith(suffix)) continue;
      const key = suffix ? value.slice(0, -suffix.length) : value, replacement = replacements.get(key);
      if (replacement) return JSON.stringify(replacement + suffix);
    }
    return literal;
  });
}

function scan(project = path.resolve(__dirname, '..')) {
  project = fs.realpathSync(path.resolve(project));
  const resources = path.join(project, 'assets/resources');
  if (!fs.existsSync(resources) || fs.realpathSync(resources) !== resources) throw new Error('Expected a real assets/resources directory inside the project.');
  const roots = ['assets', 'settings', 'build-templates', 'extensions', 'tools', 'tests'];
  const inventory = roots.flatMap(name => files(path.join(project, name))).filter(file => !/[\\/](?:\.build|node_modules|__pycache__)[\\/]/.test(file));
  const relative = file => posix(path.relative(project, file));
  const resourceFiles = inventory.filter(file => inside(resources, file));
  const inputs = new Map(), read = file => { const data = fs.readFileSync(file); inputs.set(file, hash(data)); return data; };
  const documents = [], configs = [], candidates = [];
  for (const file of inventory) {
    if (/\.(?:json|meta|scene|prefab|pac|mtl|material|effect|atlas|plist|txt|md|ts|js|cjs|mjs|ps1|py)$/i.test(file)) {
      const text = read(file).toString('utf8'), document = { file, text, location: relative(file) };
      documents.push(document);
      if (inside(resources, file) && file.endsWith('.json')) {
        try { configs.push({ ...document, value: JSON.parse(text) }); }
        catch { throw new Error('Cannot prove resource references in invalid JSON: ' + relative(file)); }
      }
    }
  }
  for (const file of resourceFiles.filter(file => /\.(?:png|wav)$/i.test(file))) {
    const bytes = read(file), metaFile = file + '.meta';
    let meta, signature = null;
    if (fs.existsSync(metaFile)) {
      try { meta = JSON.parse(read(metaFile).toString('utf8')); signature = importSignature(meta); }
      catch { /* Invalid/unknown import semantics protect the asset below. */ }
    }
    candidates.push({ file, metaFile, path: posix(path.relative(resources, file)).replace(/\.[^.]+$/, ''),
      extension: path.extname(file).toLowerCase(), bytes: bytes.length, sha256: hash(bytes), meta, signature, references: 0, reasons: new Set() });
  }
  const paths = new Map(candidates.map(item => [item.path, item])), aliases = new Map();
  const sourceFiles = new Map(candidates.map(item => [item.file, item]));
  const protect = (item, reason) => { if (item) item.reasons.add(reason); };
  for (const item of candidates) {
    if (!item.signature) protect(item, 'missing-or-unsupported-import-metadata');
    for (const uuid of uuidForms(item.meta?.uuid ?? '')) if (uuid) aliases.set(uuid, item);
  }
  for (const document of documents) {
    // Atlas frame names and custom inherited folder import settings are not
    // explicit JSON resource paths. Preserve those source identities.
    if (document.file.endsWith('.pac') && inside(resources, document.file)) {
      const directory = path.dirname(document.file) + path.sep;
      for (const item of candidates) if (item.file.startsWith(directory)) protect(item, 'implicit-atlas-membership:' + document.location);
    }
    if (document.file.endsWith('.meta') && inside(resources, document.file.slice(0, -5)) && fs.existsSync(document.file.slice(0, -5)) && fs.statSync(document.file.slice(0, -5)).isDirectory()) {
      let metadata; try { metadata = JSON.parse(document.text); } catch { metadata = { userData: { unknown: true } }; }
      if (Object.keys(metadata.userData ?? {}).length) {
        const directory = document.file.slice(0, -5) + path.sep;
        for (const item of candidates) if (item.file.startsWith(directory)) protect(item, 'inherited-directory-import:' + document.location);
      }
    }
  }
  const fromString = value => {
    for (const suffix of ['', '/spriteFrame', '/texture', '.png', '.wav']) {
      if (suffix && !value.endsWith(suffix)) continue;
      const item = paths.get(suffix ? value.slice(0, -suffix.length) : value);
      if (item) return item;
    }
  };
  for (const config of configs) jsonStrings(config.value, value => {
    const item = fromString(value); if (item) item.references++;
    else {
      for (const match of value.matchAll(/art\/[\w./-]+/g)) protect(fromString(match[0]), 'embedded-json-reference:' + config.location);
      if (value.startsWith('art/')) for (const candidate of candidates) if (candidate.path.startsWith(value.replace(/\/$/, '') + '/')) protect(candidate, 'json-directory-reference:' + config.location);
    }
  }, key => protect(fromString(key), 'json-key-reference:' + config.location));
  const configFiles = new Set(configs.map(config => config.file));
  for (const document of documents) {
    // Text atlases/plists and authoring data can name sibling native files.
    // These are not resource-path values, so do not rewrite them speculatively.
    for (const match of document.text.matchAll(/[\w./-]+\.(?:png|wav)\b/gi)) {
      const file = path.resolve(path.dirname(document.file), match[0]);
      protect(sourceFiles.get(file), 'relative-native-reference:' + document.location);
    }
    // Every UUID reference outside the asset's own importer metadata blocks
    // deletion, including Creator's 22/23-character compressed UUID spelling.
    const tokens = document.text.match(/[A-Za-z\d+/_-]{20,}(?:@[A-Za-z\d_-]+)?/g) ?? [];
    for (const token of tokens) {
      const item = aliases.get(token.split('@')[0]);
      if (item && document.file !== item.metaFile) protect(item, 'uuid-reference:' + document.location);
    }
    if (!configFiles.has(document.file)) for (const match of document.text.matchAll(/art\/[\w./-]+/g)) {
      let value = match[0].replace(/\.(?:meta)$/, '');
      protect(fromString(value), 'non-json-path-reference:' + document.location);
      if (!value.endsWith('/')) value += '/';
      // An explicitly named resource directory can be used by a dynamic lookup.
      // Do not infer global directory loads from authoring scripts or prose.
      if (/^assets\/scripts\//.test(document.location) && fs.existsSync(path.join(resources, value)))
        for (const item of candidates) if (item.path.startsWith(value)) protect(item, 'runtime-directory-reference:' + document.location + ':' + value);
    }
    if (!/^assets\/scripts\/.*\.(?:ts|js)$/.test(document.location)) continue;
    const ast = ts.createSourceFile(document.file, document.text, ts.ScriptTarget.Latest, true);
    const segments = node => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
      if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.flatMap(span => [null, span.literal.text])];
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...segments(node.left), ...segments(node.right)];
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join') {
        const array = node.expression.expression;
        const parts = ts.isArrayLiteralExpression(array) && node.arguments[0]?.text === '/' ? array.elements : /^(?:path|posix)\.join$/.test(node.expression.getText(ast)) ? node.arguments : null;
        if (parts) return parts.flatMap((part, index) => [...(index ? ['/'] : []), ...segments(part)]);
      }
      return [null];
    };
    const visit = node => {
      if (ts.isTemplateExpression(node) || ts.isCallExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
        const raw = segments(node), parts = [];
        for (const part of raw) { if (part !== null && typeof parts.at(-1) === 'string') parts[parts.length - 1] += part; else parts.push(part); }
        const first = parts.findIndex(part => part?.includes('art/'));
        if (first >= 0 && parts.includes(null)) {
          const pattern = parts.slice(first); pattern[0] = pattern[0].slice(pattern[0].indexOf('art/'));
          const expression = new RegExp('^' + pattern.map(part => part === null ? '.*' : escape(part)).join('') + '(?:/spriteFrame|/texture|\\.png|\\.wav)?$');
          for (const item of candidates) if (expression.test(item.path) || expression.test(item.path + item.extension)) protect(item, 'dynamic-runtime-path:' + document.location);
        }
      }
      if (ts.isCallExpression(node) && /\.loadDir$/.test(node.expression.getText(ast))) {
        const arg = node.arguments[0], prefix = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text.replace(/\/$/, '') : '';
        for (const item of candidates) if (!prefix || item.path === prefix || item.path.startsWith(prefix + '/')) protect(item, 'directory-load:' + document.location);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const groups = new Map();
  for (const item of candidates) {
    const key = item.extension + ':' + item.sha256;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const replacements = new Map(), removed = [], retained = [], duplicateGroups = [];
  const keep = (item, extra) => { retained.push({ path: item.path, reasons: [...item.reasons, ...(extra ? [extra] : [])].sort() }); };
  for (const group of groups.values()) {
    const compatible = new Map();
    for (const item of group) {
      // Unique unknown import signatures can never be treated as equivalent.
      const key = item.signature ?? item.path;
      if (!compatible.has(key)) compatible.set(key, []);
      compatible.get(key).push(item);
    }
    if (group.length > 1) duplicateGroups.push({ paths: group.map(item => item.path), compatibleGroups: compatible.size });
    for (const items of compatible.values()) {
      const referenced = items.filter(item => item.references || item.reasons.size);
      if (!referenced.length) {
        for (const item of items) removed.push({ ...item, reason: 'unreferenced' });
        continue;
      }
      // Prefer an externally pinned identity, then a JSON-referenced identity.
      // Ordering is deterministic and stable over repeated runs.
      const canonical = [...referenced].sort((a, b) => Number(!!b.reasons.size) - Number(!!a.reasons.size) || a.path.localeCompare(b.path, 'en'))[0];
      for (const item of items) {
        if (item === canonical) continue;
        if (item.reasons.size) { keep(item); continue; }
        replacements.set(item.path, canonical.path); removed.push({ ...item, canonical: canonical.path, reason: 'exact-duplicate' });
      }
      if (group.length > 1 && compatible.size > 1) keep(canonical, 'different-import-semantics');
      else if (canonical.reasons.size) keep(canonical);
    }
  }
  const changes = configs.map(config => ({ file: config.file, original: config.text, updated: rewriteJson(config.text, replacements) }))
    .filter(change => change.original !== change.updated);
  const reasonCounts = {};
  for (const item of retained) for (const reason of item.reasons) { const kind = reason.split(':')[0]; reasonCounts[kind] = (reasonCounts[kind] ?? 0) + 1; }
  const byExtension = {};
  for (const item of removed) { const value = byExtension[item.extension] ?? { files: 0, bytes: 0 }; value.files++; value.bytes += item.bytes; byExtension[item.extension] = value; }
  const report = { version: 1, resourcesRoot: resources, summary: { assetsScanned: candidates.length,
    assetBytesBefore: candidates.reduce((sum, item) => sum + item.bytes, 0), exactDuplicateGroups: duplicateGroups.length,
    removedDuplicates: removed.filter(item => item.reason === 'exact-duplicate').length, removedUnused: removed.filter(item => item.reason === 'unreferenced').length,
    removedAssetBytes: removed.reduce((sum, item) => sum + item.bytes, 0), changedJsonFiles: changes.length, byExtension, retainedReasonCounts: reasonCounts },
    removed: removed.map(({ path, canonical, reason, bytes, sha256 }) => ({ path, canonical, reason, bytes, sha256 })), retained,
    json: changes.map(change => ({ path: relative(change.file), beforeSha256: hash(change.original), afterSha256: hash(change.updated) })) };
  return { project, resources, roots, inventory, inputs, removed, changes, report };
}

function apply(plan) {
  const verifyPath = file => {
    const absolute = path.resolve(file);
    if (!inside(plan.resources, absolute) || fs.realpathSync(absolute) !== absolute || fs.lstatSync(absolute).isSymbolicLink())
      throw new Error('Refusing a write/delete outside the real assets/resources tree: ' + file);
  };
  // Verify all observations, including scripts and metadata, before the first
  // write. A concurrent generator/new reference cannot silently invalidate it.
  const current = plan.roots.flatMap(name => files(path.join(plan.project, name))).filter(file => !/[\\/](?:\.build|node_modules|__pycache__)[\\/]/.test(file));
  if (JSON.stringify(current) !== JSON.stringify(plan.inventory)) throw new Error('Project file inventory changed during resource audit.');
  for (const [file, expected] of plan.inputs) if (hash(fs.readFileSync(file)) !== expected) throw new Error('Source changed during resource audit: ' + file);
  for (const change of plan.changes) { verifyPath(change.file); if (fs.statSync(change.file).nlink > 1) throw new Error('Refusing to rewrite a hard-linked JSON file.'); }
  for (const item of plan.removed) { verifyPath(item.file); verifyPath(item.metaFile); }
  // All canonical files already exist. If a JSON write fails, the duplicate
  // sources still exist, so both old and updated references remain valid.
  for (const change of plan.changes) fs.writeFileSync(change.file, change.updated);
  const changed = new Map(plan.changes.map(change => [change.file, hash(change.updated)]));
  const beforeDelete = plan.roots.flatMap(name => files(path.join(plan.project, name))).filter(file => !/[\\/](?:\.build|node_modules|__pycache__)[\\/]/.test(file));
  if (JSON.stringify(beforeDelete) !== JSON.stringify(plan.inventory)) throw new Error('Project file inventory changed before resource deletion.');
  for (const [file, expected] of plan.inputs) if (hash(fs.readFileSync(file)) !== (changed.get(file) ?? expected)) throw new Error('Source changed before resource deletion: ' + file);
  for (const item of plan.removed) {
    verifyPath(item.file); verifyPath(item.metaFile);
    fs.unlinkSync(item.file); fs.unlinkSync(item.metaFile);
  }
  return plan.report;
}
function run(argv = process.argv.slice(2)) {
  if (argv.length > 1 || (argv.length && !['--check', '--write'].includes(argv[0]))) throw new Error('Usage: node tools/dedupe-resources.cjs [--check | --write]');
  const plan = scan(); if (argv[0] === '--write') apply(plan);
  console.log(JSON.stringify({ mode: argv[0] === '--write' ? 'write' : 'check', ...plan.report }, null, 2));
  return plan.report;
}
if (require.main === module) { try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { scan, apply, importSignature, rewriteJson, uuidForms, run };
