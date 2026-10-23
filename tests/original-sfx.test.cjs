const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { resourceModules } = require('./support/resource-modules.cjs');
const root = path.resolve(__dirname, '..');
const config = require(path.join(root, 'assets/resources/art/original-sfx/config.json'));
const source = fs.readFileSync(path.join(root, 'assets/scripts/view/OriginalSfx.ts'), 'utf8');

function harness(overrides = {}, { browser = false, activated = false } = {}) {
  const calls = [], requests = [];
  class Node {
    isValid = true; children = []; destroyCalls = 0;
    addComponent(Type) { return new Type(); }
    destroy() { this.isValid = false; this.destroyCalls++; }
  }
  class AudioSource { playOneShot(clip, volume) { calls.push({ clip, volume }); } }
  class AudioClip {}
  const cc = { Node, AudioSource, AudioClip, sys: { isBrowser: browser }, resources: { load: (key, Type, callback) => {
    assert.equal(Type, AudioClip); requests.push(key); callback(null, { key });
  } } };
  const makeNode = (name, parent) => { const node = new Node(); node.name = name; parent.children.push(node); return node; };
  const module = { exports: {} }, imports = { cc, './ArtLibrary': { makeNode } };
  const listeners = new Map();
  const document = {
    addEventListener: (name, callback, capture) => { assert.equal(capture, true); listeners.set(name, callback); },
    removeEventListener: (name, callback, capture) => { assert.equal(capture, true); assert.equal(listeners.get(name), callback); listeners.delete(name); },
  };
  const gesture = (name, isTrusted = true) => listeners.get(name)?.({ isTrusted });
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
    { module, exports: module.exports, document, navigator: { userActivation: { hasBeenActive: activated } },
      require: key => { assert.ok(key in imports); return imports[key]; } });
  const sharedClips = new Map(), clips = new Map();
  for (const entry of config.entries) {
    if (!sharedClips.has(entry.path)) sharedClips.set(entry.path, { key: entry.path });
    clips.set(entry.id, sharedClips.get(entry.path));
  }
  const assets = { config: { ...config, ...overrides }, clips };
  const sfx = new module.exports.OriginalSfx(new Node(), assets);
  return { sfx, calls, requests, clips, listeners, gesture, exports: module.exports, art: {
    resourceLoader: new (resourceModules(cc)('GameResourceLoader').GameResourceLoader)(), json: async key => {
    assert.equal(key, 'art/original-sfx/config'); return assets.config;
  } } };
}

test('source Sound_manager IDs retain 15 used clip/volume mappings, original pitch, and shared clip aliases', () => {
  const originalEntries = config.entries.filter(entry => entry.id < 17);
  assert.equal(config.entries.length, 21);
  assert.deepEqual(originalEntries.map(entry => entry.id), Array.from({ length: 17 }, (_, id) => id).filter(id => id !== 0 && id !== 14));
  assert.equal(config.source, 'level0:125642');
  assert.equal(config.sourcePitch, 1); assert.equal(config.sourceVolume, 1);
  assert.equal(config.blockSameFrameDuplicate, true); assert.equal(config.blockCooldownDuplicate, true);
  assert.equal(config.cooldownSeconds, Math.fround(.05));
  assert.deepEqual(originalEntries.map(e => Number(e.sourceClip.split(':')[1])), [288,279,294,280,293,284,294,291,281,286,285,292,281,285,290]);
  assert.deepEqual(originalEntries.map(e => e.volume), [.5,1,Math.fround(.4),1,1,1,1,Math.fround(.3),1,1,1,1,1,1,1]);
  for (const entry of config.entries) assert.ok(fs.existsSync(path.join(root, `assets/resources/${entry.path}.wav`)));
});

test('loader reuses existing WAVs and coalesces the source IDs that point to one clip', async () => {
  const h = harness(), loaded = await h.exports.loadOriginalSfxAssets(h.art);
  assert.equal(loaded.clips.size, 21); assert.equal(h.requests.length, 18);
  assert.equal(new Set(h.requests).size, 18);
  assert.equal(loaded.clips.get(3), loaded.clips.get(7));
  assert.equal(loaded.clips.get(9), loaded.clips.get(13));
  assert.equal(loaded.clips.get(11), loaded.clips.get(15));
});

test('three cats and repeated UI callbacks share per-ID frame and 50ms gates with exact source shot volume', () => {
  const { sfx, calls } = harness();
  sfx.play(8); sfx.play(8); sfx.play(8); sfx.play(4); sfx.play(4);
  assert.deepEqual(calls.map(c => c.volume), [Math.fround(.3), 1]);
  sfx.update(.03); sfx.play(8); sfx.play(4); assert.equal(calls.length, 2);
  sfx.update(.019); sfx.play(8); assert.equal(calls.length, 2);
  sfx.update(.001); sfx.play(8); assert.equal(calls.length, 3, 'the float32 50ms boundary permits the next sound');
  sfx.play(8); assert.equal(calls.length, 3, 'a second call in the accepted frame is rejected');
});

test('selected weapon families play independently in one frame at unit volume and each retains the 50ms gate', () => {
  const { sfx, calls } = harness(), ids = [17, 18, 19, 20, 21, 22];
  const paths = ['bow', 'crossbow', 'staff', 'fan', 'dart', 'missile'].map(name => `art/weapon-system/audio/attack-${name}`);
  assert.deepEqual(config.entries.filter(entry => entry.id >= 17).map(entry => [entry.id, entry.path, entry.volume]),
    ids.map((id, index) => [id, paths[index], 1]));
  for (const id of ids) { sfx.play(id); sfx.play(id); sfx.play(id); }
  assert.deepEqual(calls.map(call => [call.clip.key, call.volume]), paths.map(path => [path, 1]));
  sfx.play(8);
  assert.equal(calls.length, 7, 'the retained handgun remains independent of every replacement');
  assert.equal(calls[6].volume, Math.fround(.3));
  sfx.update(.03); for (const id of ids) sfx.play(id);
  sfx.update(.019); for (const id of ids) sfx.play(id);
  assert.equal(calls.length, 7, 'all six families suppress another shot inside 50ms');
  sfx.update(.001); for (const id of ids) { sfx.play(id); sfx.play(id); }
  assert.deepEqual(calls.slice(7).map(call => [call.clip.key, call.volume]), paths.map(path => [path, 1]),
    'each ID accepts exactly one new shot at 50ms; rejected attempts did not move the cooldown');
});

test('IDs that share a clip remain independently audible and retain their different source volumes', () => {
  const { sfx, calls } = harness(); sfx.play(3); sfx.play(7);
  assert.equal(calls.length, 2); assert.equal(calls[0].clip, calls[1].clip);
  assert.deepEqual(calls.map(c => c.volume), [Math.fround(.4), 1]);
});

test('cooldown rejections record the attempted frame, never extend the last accepted cooldown', () => {
  const { sfx, calls } = harness(); sfx.play(8);
  sfx.update(.025); sfx.play(8);
  assert.equal(sfx.lastFrames.get(8), 1); assert.equal(sfx.lastTimes.get(8), 0);
  sfx.update(.025); sfx.play(8); assert.equal(calls.length, 2);
  sfx.play(-1); sfx.play(999); assert.equal(calls.length, 2);
});

test('unscaled updates keep the gate responsive while combat is paused; invalid deltas and teardown cannot play audio', () => {
  const { sfx, calls } = harness(); sfx.play(4);
  sfx.update(0); sfx.play(4); sfx.update(NaN); sfx.play(4); sfx.update(-1); sfx.play(4);
  assert.equal(calls.length, 1);
  sfx.update(.06); sfx.play(4); assert.equal(calls.length, 2);
  sfx.destroy(); sfx.destroy(); sfx.update(10); sfx.play(4);
  assert.equal(calls.length, 2); assert.equal(sfx.node.destroyCalls, 1);
});

test('browser combat cannot queue one-shots before audio unlock; the first real UI gesture sounds without replaying history', () => {
  const { sfx, calls, listeners, gesture } = harness({}, { browser: true });
  assert.equal(listeners.size, 3);
  // Exceeds Creator's 24-channel cap many times before the first user click.
  for (let shot = 0; shot < 100; shot++) { sfx.update(.06); sfx.play(8); }
  assert.equal(calls.length, 0); assert.equal(sfx.lastTimes.size, 0);
  gesture('mouseup', false); sfx.play(4); assert.equal(calls.length, 0);
  gesture('mouseup'); assert.equal(listeners.size, 0); assert.equal(calls.length, 0);
  sfx.play(4); sfx.play(8); sfx.play(8);
  assert.deepEqual(calls.map(call => call.volume), [1, Math.fround(.3)]);
  sfx.update(.06); sfx.play(8); assert.equal(calls.length, 3);
});

test('browser gesture hooks are released on teardown, and a gesture during loading needs no second interaction', () => {
  const pending = harness({}, { browser: true });
  pending.sfx.destroy(); pending.sfx.destroy();
  assert.equal(pending.listeners.size, 0); pending.gesture('touchend'); pending.sfx.play(8);
  assert.equal(pending.calls.length, 0);
  const active = harness({}, { browser: true, activated: true });
  assert.equal(active.listeners.size, 0); active.sfx.play(8); assert.equal(active.calls.length, 1);
  const miniature = harness();
  assert.equal(miniature.listeners.size, 0); miniature.sfx.play(8); assert.equal(miniature.calls.length, 1);
});

test('Sound mute blocks every new UI and weapon one-shot before bookkeeping while existing tails remain untouched', () => {
  const { sfx, calls } = harness();
  sfx.play(8); sfx.setEnabled(false);
  assert.equal(calls.length, 1, 'the existing one-shot is not stopped or replayed');
  sfx.update(.06);
  for (const entry of config.entries) sfx.play(entry.id);
  assert.equal(calls.length, 1); assert.equal(sfx.lastTimes.size, 1); assert.equal(sfx.lastFrames.size, 1);
  assert.equal(sfx.lastTimes.get(8), 0, 'muted attempts do not extend the accepted cooldown');
  sfx.setEnabled(true); sfx.play(8); sfx.play(4);
  assert.equal(calls.length, 3, 'restoring Sound resumes both combat and UI immediately');
});

test('a browser gesture can unlock audio while Sound is disabled without replaying muted sounds', () => {
  const h = harness({}, { browser: true }); h.sfx.setEnabled(false);
  h.gesture('mouseup'); h.sfx.play(4); h.sfx.play(8);
  assert.equal(h.listeners.size, 0); assert.equal(h.calls.length, 0); assert.equal(h.sfx.lastTimes.size, 0);
  h.sfx.setEnabled(true); h.sfx.play(4); assert.equal(h.calls.length, 1);
});

test('lazy SFX starts without WAV requests and coalesces shared clip IDs on demand', async () => {
  const h = harness(), assets = await h.exports.loadOriginalSfxAssets(h.art, []);
  assert.equal(assets.clips.size, 0); assert.equal(h.requests.length, 0);
  await Promise.all([assets.ensureClip(3), assets.ensureClip(7), assets.ensureClip(3)]);
  assert.equal(h.requests.length, 1);
  assert.equal(assets.clips.get(3), assets.clips.get(7));
  assert.equal(assets.clips.has(8), false);
  assert.equal(await assets.ensureClip(0), undefined, 'retired clip stays absent');
});

test('muted SFX never starts a lazy download and delayed shots are not replayed', async () => {
  const h = harness(); h.clips.clear();
  let release, requests = 0;
  const pending = new Promise(resolve => { release = resolve; });
  h.sfx.assets.ensureClip = async id => { requests++; await pending; h.clips.set(id, { id }); };
  h.sfx.setEnabled(false); await h.sfx.preload([8]); h.sfx.play(8);
  assert.equal(requests, 0);
  h.sfx.setEnabled(true); h.sfx.play(8); h.sfx.play(8);
  const ready = h.sfx.preload([8]); assert.equal(requests, 1);
  release(); await ready; assert.equal(h.calls.length, 0);
  h.sfx.play(8); assert.equal(h.calls.length, 1);
});
