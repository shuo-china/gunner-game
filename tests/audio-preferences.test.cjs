const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../assets/scripts/session/AudioPreferences.ts'), 'utf8');
const moduleValue = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS,
} }).outputText, { module: moduleValue, exports: moduleValue.exports });
const { AudioPreferences, audioPreferencesStorageKey } = moduleValue.exports;

function store(initial = []) {
  const data = new Map(initial), writes = [];
  return { data, writes, getItem: key => data.get(key) ?? null, setItem(key, value) { writes.push({ key, value }); data.set(key, value); } };
}

test('audio preferences default on and persist each real toggle without touching progression or tutorial data', () => {
  const economyKey = 'forest-gunner:economy:v3:test';
  const storage = store([[economyKey, 'existing progression']]);
  const preferences = new AudioPreferences({ environment: 'test', storage });
  assert.equal(preferences.bgmEnabled, true); assert.equal(preferences.soundEnabled, true);
  assert.equal(storage.writes.length, 0, 'reading defaults does not rewrite existing state');
  preferences.setBgmEnabled(false);
  assert.deepEqual(JSON.parse(storage.writes[0].value), { version: 1, bgmEnabled: false, soundEnabled: true });
  preferences.setSoundEnabled(false); preferences.setSoundEnabled(false);
  assert.equal(storage.writes.length, 2, 'an unchanged selection does not write again');
  assert.equal(storage.writes[0].key, 'forest-gunner:audio:v1:test');
  assert.equal(storage.data.get(economyKey), 'existing progression');
  const reloaded = new AudioPreferences({ environment: 'test', storage });
  assert.equal(reloaded.bgmEnabled, false); assert.equal(reloaded.soundEnabled, false);
  reloaded.setBgmEnabled(true);
  assert.deepEqual(JSON.parse(storage.data.get(audioPreferencesStorageKey('test'))), { version: 1, bgmEnabled: true, soundEnabled: false });
});

test('audio preferences isolate production from test builds and preserve either valid boolean independently', () => {
  const storage = store([[audioPreferencesStorageKey('test'), JSON.stringify({ version: 1, bgmEnabled: false, soundEnabled: 'false' })]]);
  const preferences = new AudioPreferences({ environment: 'test', storage });
  assert.equal(preferences.bgmEnabled, false); assert.equal(preferences.soundEnabled, true);
  const production = new AudioPreferences({ environment: 'production', storage });
  assert.equal(production.bgmEnabled, true); assert.equal(production.soundEnabled, true);
  production.setSoundEnabled(false);
  assert.equal(storage.writes[0].key, 'forest-gunner:audio:v1:production');
  assert.equal(new AudioPreferences({ environment: 'test', storage }).soundEnabled, true);
});

test('damaged, missing and future preferences keep source defaults without throwing', () => {
  for (const raw of [null, '', '{', 'null', 'false', '[]', '{"version":2,"bgmEnabled":false,"soundEnabled":false}', '{"bgmEnabled":false}', '{"version":1,"bgmEnabled":0,"soundEnabled":null}']) {
    const preferences = new AudioPreferences({ environment: 'production', storage: store([[audioPreferencesStorageKey('production'), raw]]) });
    assert.equal(preferences.bgmEnabled, true, String(raw)); assert.equal(preferences.soundEnabled, true, String(raw));
  }
});

test('unavailable storage leaves both switches functional in memory', () => {
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  for (const storage of [undefined, denied]) {
    const preferences = new AudioPreferences({ environment: 'production', storage });
    preferences.setBgmEnabled(false); preferences.setSoundEnabled(false);
    assert.equal(preferences.bgmEnabled, false); assert.equal(preferences.soundEnabled, false);
    preferences.setBgmEnabled(true); assert.equal(preferences.bgmEnabled, true);
  }
});
