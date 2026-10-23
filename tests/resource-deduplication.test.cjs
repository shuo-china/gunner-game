'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scan, apply, importSignature, rewriteJson, uuidForms } = require('../tools/dedupe-resources.cjs');

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-dedupe-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const write = (relative, data) => { const file = path.join(project, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  fs.mkdirSync(path.join(project, 'assets/resources'), { recursive: true });
  const asset = (name, bytes = 'identical source bytes', options = {}) => {
    const extension = options.extension || '.png', uuid = options.uuid || crypto.randomUUID();
    const meta = { ver: '1', importer: extension === '.wav' ? 'audio-clip' : 'image', uuid, imported: true, files: ['.json', extension], subMetas: {}, userData: {} };
    if (extension === '.png') meta.subMetas.frame = { uuid: uuid + '@frame', displayName: name.split('/').pop(), importer: 'sprite-frame', userData: { texture: uuid + '@texture', trim: 'none', pivot: { x: 0.5, y: 0.5 }, ...options.settings } };
    const file = write('assets/resources/' + name + extension, bytes);
    write('assets/resources/' + name + extension + '.meta', JSON.stringify(meta));
    return { file, meta, uuid, name, bytes: fs.readFileSync(file) };
  };
  const config = value => write('assets/resources/art/config.json', typeof value === 'string' ? value : JSON.stringify(value));
  return { project, write, asset, config };
}

test('check is read-only; write rewrites explicit values, preserves unrelated data, and is idempotent', t => {
  const f = fixture(t), a = f.asset('art/dedupe/a'), b = f.asset('art/dedupe/b');
  const file = f.config('{"image":"art/dedupe/b","frame":"art/dedupe/b/spriteFrame","native":"art/dedupe/b.png","a":"art/dedupe/a","geometry":-0,"note":"unchanged"}\n');
  const original = fs.readFileSync(file, 'utf8'), plan = scan(f.project);
  assert.equal(plan.report.summary.removedDuplicates, 1); assert.equal(fs.readFileSync(file, 'utf8'), original); assert.ok(fs.existsSync(b.file));
  apply(plan);
  assert.ok(fs.existsSync(a.file)); assert.equal(fs.existsSync(b.file), false); assert.equal(fs.existsSync(b.file + '.meta'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), original.replaceAll('art/dedupe/b', 'art/dedupe/a'));
  assert.deepEqual(fs.readFileSync(a.file), a.bytes);
  const again = scan(f.project); assert.equal(again.removed.length, 0); assert.equal(again.changes.length, 0);
});

test('different import filtering, slice/pivot and external redirects cannot be merged', t => {
  const f = fixture(t), a = f.asset('art/dedupe/a'), b = f.asset('art/dedupe/b', undefined, { settings: { pivot: { x: 0.1, y: 0.5 } } });
  const c = f.asset('art/dedupe/c', undefined, { settings: { texture: crypto.randomUUID() } });
  f.config([a.name, b.name, c.name]);
  assert.notEqual(importSignature(a.meta), importSignature(b.meta)); assert.notEqual(importSignature(a.meta), importSignature(c.meta));
  const plan = scan(f.project); assert.equal(plan.removed.length, 0); assert.equal(plan.report.summary.retainedReasonCounts['different-import-semantics'], 3);
});

test('selected audio/static runtime paths become canonical; WAV bytes are not encoded', t => {
  const f = fixture(t), a = f.asset('art/dedupe/a', Buffer.from([0, 12, 23, 255]), { extension: '.wav' }), z = f.asset('art/dedupe/z', a.bytes, { extension: '.wav' });
  f.config([a.name, z.name]); f.write('assets/scripts/play.ts', "const selected = 'art/dedupe/z';");
  const plan = scan(f.project); assert.equal(plan.removed[0].path, a.name); assert.equal(plan.removed[0].canonical, z.name);
  apply(plan); assert.deepEqual(fs.readFileSync(z.file), a.bytes);
});

test('runtime templates, concatenation and directory loads protect dynamically addressed files', t => {
  const f = fixture(t);
  for (const name of ['art/dynamic/a', 'art/joined/a', 'art/directory/a', 'art/split/a']) f.asset(name);
  f.write('assets/scripts/dynamic.ts', "const a = `art/dynamic/${name}`; const b = 'art/joined/' + index; resources.loadDir('art/directory', callback); const c = ['art','split', name].join('/');");
  const plan = scan(f.project); assert.equal(plan.removed.length, 0);
  assert.ok(plan.report.retained.some(item => item.reasons.some(reason => reason.startsWith('dynamic-runtime-path:'))));
  assert.ok(plan.report.retained.some(item => item.reasons.some(reason => reason.startsWith('directory-load:'))));
});

test('implicit atlas membership and inherited directory import settings retain source identities', t => {
  const f = fixture(t); f.asset('art/atlas/a'); f.asset('art/custom/a');
  f.write('assets/resources/art/atlas/atlas.pac', '{"__type__":"cc.SpriteAtlas"}');
  f.write('assets/resources/art/custom.meta', JSON.stringify({ importer: 'directory', userData: { isBundle: true } }));
  const plan = scan(f.project); assert.equal(plan.removed.length, 0);
  assert.ok(plan.report.retained.some(item => item.reasons.some(reason => reason.startsWith('implicit-atlas-membership:'))));
  assert.ok(plan.report.retained.some(item => item.reasons.some(reason => reason.startsWith('inherited-directory-import:'))));
});

test('relative native filenames and JSON directory prefixes are uncertain references and remain intact', t => {
  const f = fixture(t), a = f.asset('art/relative/sheet'), b = f.asset('art/prefix/dynamic');
  f.write('assets/resources/art/relative/atlas.plist', '<string>sheet.png</string>'); f.config({ prefix: 'art/prefix' });
  const plan = scan(f.project); assert.equal(plan.removed.length, 0);
  assert.ok(plan.report.retained.some(item => item.path === a.name && item.reasons.some(reason => reason.startsWith('relative-native-reference:'))));
  assert.ok(plan.report.retained.some(item => item.path === b.name && item.reasons.some(reason => reason.startsWith('json-directory-reference:'))));
});

test('UUID references preserve native identity in full, compact and Creator compressed forms', t => {
  const f = fixture(t), assets = Array.from({ length: 4 }, (_, i) => f.asset('art/uuid/' + i));
  f.write('assets/Main.scene', JSON.stringify(assets.map((item, index) => ({ __uuid__: uuidForms(item.uuid)[index] + '@frame' }))));
  const plan = scan(f.project); assert.equal(plan.removed.length, 0);
  assert.equal(plan.report.summary.retainedReasonCounts['uuid-reference'], 4);
});

test('JSON keys and embedded references stay unchanged and protect assets; unknown metadata is retained', t => {
  const f = fixture(t), a = f.asset('art/dedupe/key'), b = f.asset('art/dedupe/embedded'), c = f.asset('art/dedupe/unknown');
  f.config({ [a.name]: 1, value: 'resource=' + b.name }); f.write('assets/resources/' + c.name + '.png.meta', '{"importer":"unknown"}');
  const plan = scan(f.project); assert.equal(plan.removed.length, 0); assert.equal(plan.changes.length, 0);
  assert.ok(plan.report.retained.some(item => item.reasons.includes('missing-or-unsupported-import-metadata')));
  assert.equal(rewriteJson('{"art/dedupe/a":"art/dedupe/a"}', new Map([['art/dedupe/a', 'art/dedupe/b']])), '{"art/dedupe/a":"art/dedupe/b"}');
});

test('a unique unused resource is pruned only when its import and complete reference inventory are known', t => {
  const f = fixture(t), a = f.asset('art/dedupe/unused', 'unique bytes');
  const plan = scan(f.project); assert.equal(plan.removed[0].reason, 'unreferenced'); apply(plan); assert.equal(fs.existsSync(a.file), false);
});

test('concurrent input edits and new files fail before any JSON rewrite or deletion', t => {
  const f = fixture(t), a = f.asset('art/dedupe/a'), b = f.asset('art/dedupe/b'), config = f.config([a.name, b.name]);
  const plan = scan(f.project); fs.appendFileSync(config, '\n');
  assert.throws(() => apply(plan), /Source changed/); assert.ok(fs.existsSync(b.file));
  const second = scan(f.project); f.write('assets/scripts/new.ts', "const path='art/dedupe/b';");
  assert.throws(() => apply(second), /inventory changed/); assert.ok(fs.existsSync(b.file));
});

test('deletion validates every resolved path is inside assets/resources', t => {
  const f = fixture(t), a = f.asset('art/dedupe/a'); f.config([a.name]);
  const outside = f.write('assets/outside.png', 'must remain'), outsideMeta = f.write('assets/outside.png.meta', '{}');
  const plan = scan(f.project); plan.removed.push({ file: outside, metaFile: outsideMeta });
  assert.throws(() => apply(plan), /outside the real assets\/resources/); assert.ok(fs.existsSync(outside));
});

test('build deduplicates after generators and before Creator generates asset hashes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../tools/build.ps1'), 'utf8');
  const dedupe = source.indexOf("'dedupe-resources.cjs'");
  assert.ok(dedupe > source.indexOf("'sync-feature-entries.cjs'"));
  assert.ok(dedupe > source.indexOf("'sync-weapon-audio.cjs'"));
  assert.ok(dedupe < source.indexOf('Start-Process -FilePath $EnginePath'));
});
