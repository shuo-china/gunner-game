const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { resourceModules } = require('./support/resource-modules.cjs');
const root = path.resolve(__dirname, '..');
const config = require(path.join(root, 'assets/resources/art/original-bgm/config.json'));
const source = fs.readFileSync(path.join(root, 'assets/scripts/view/OriginalBgm.ts'), 'utf8');

function harness({ browser = false, activated = false, failPath = null } = {}) {
  const calls = [], requests = [], listeners = new Map();
  class Node {
    isValid = true; children = []; destroyCalls = 0;
    addComponent(Type) { return this.audio = new Type(); }
    destroy() { this.isValid = false; this.destroyCalls++; }
  }
  class AudioSource {
    currentTime = 0; isPlaying = false; _clip = null;
    set clip(value) { this._clip = value; this.isPlaying = false; this.currentTime = 0; calls.push({ action: 'clip', clip: value }); }
    get clip() { return this._clip; }
    play() { if (this.isPlaying) this.currentTime = 0; this.isPlaying = true; calls.push({ action: 'play', clip: this.clip, time: this.currentTime, volume: this.volume }); }
    pause() { this.isPlaying = false; calls.push({ action: 'pause', time: this.currentTime }); }
    stop() { this.isPlaying = false; this.currentTime = 0; calls.push({ action: 'stop' }); }
  }
  class AudioClip {}
  const cc = { Node, AudioSource, AudioClip, sys: { isBrowser: browser }, resources: {
    load(key, Type, callback) { assert.equal(Type, AudioClip); requests.push(key); callback(key === failPath ? new Error('missing audio') : null, { key }); },
  } };
  const makeNode = (name, parent) => { const node = new Node(); node.name = name; parent.children.push(node); return node; };
  const imports = { cc, './ArtLibrary': { makeNode } }, module = { exports: {} };
  const document = {
    addEventListener(name, callback, capture) { assert.equal(capture, true); listeners.set(name, callback); },
    removeEventListener(name, callback, capture) { assert.equal(capture, true); assert.equal(listeners.get(name), callback); listeners.delete(name); },
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
    { module, exports: module.exports, document, navigator: { userActivation: { hasBeenActive: activated } }, require: key => {
      assert.ok(key in imports, key); return imports[key];
    } });
  const assets = { config, clips: { main: { key: config.main.path }, contents: { key: config.contents.path } } };
  const bgm = new module.exports.OriginalBgm(new Node(), assets);
  return { bgm, audio: bgm.node.audio, assets, calls, requests, listeners, exports: module.exports,
    gesture: (name, isTrusted = true) => listeners.get(name)?.({ isTrusted }),
    art: { resourceLoader: new (resourceModules(cc)('GameResourceLoader').GameResourceLoader)(),
      json: async key => { assert.equal(key, 'art/original-bgm/config'); return config; } } };
}
const actions = h => h.calls.map(call => call.action);

test('main-only BGM startup defers and coalesces the contents download', async () => {
  const h = harness(), assets = await h.exports.loadOriginalBgmAssets(h.art, 'main');
  assert.deepEqual(h.requests, [config.main.path]); assert.equal(assets.clips.contents, undefined);
  await Promise.all([assets.ensureClip('contents'), assets.ensureClip('contents')]);
  assert.deepEqual(h.requests, [config.main.path, config.contents.path]);
});

test('rapid mode changes keep one pending music request and start the final track once', async () => {
  const h = harness(); delete h.assets.clips.main; delete h.assets.clips.contents;
  const pending = {}, requests = [];
  h.assets.ensureClip = track => {
    requests.push(track);
    return new Promise(resolve => { pending[track] = () => {
      const clip = { key: track }; h.assets.clips[track] = clip; resolve(clip);
    }; });
  };
  h.bgm.setEnabled(false); h.bgm.setMode('Main'); assert.deepEqual(requests, []);
  h.bgm.setEnabled(true); h.bgm.setMode('Boss'); h.bgm.setMode('Main'); h.bgm.setMode('Raid');
  assert.deepEqual(requests, ['main', 'contents']);
  pending.main(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(actions(h).includes('play'), false, 'stale main completion cannot play');
  pending.contents(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.audio.isPlaying, true); assert.equal(h.audio.clip.key, 'contents');
  assert.equal(actions(h).filter(action => action === 'play').length, 1);
});

test('BGM loads the two original loop tracks and rejects incomplete configurations or failed audio', async () => {
  assert.equal(config.version, 1); assert.equal(config.volume, 1); assert.equal(config.loop, true);
  assert.equal(config.main.sourceClip, 'sharedassets0.assets:287');
  assert.equal(config.contents.sourceClip, 'sharedassets0.assets:289');
  for (const track of [config.main, config.contents]) {
    assert.ok(fs.existsSync(path.join(root, `assets/resources/${track.path}.mp3`)));
    const meta = JSON.parse(fs.readFileSync(path.join(root, `assets/resources/${track.path}.mp3.meta`), 'utf8'));
    assert.equal(meta.importer, 'audio-clip');
  }
  const h = harness(), assets = await h.exports.loadOriginalBgmAssets(h.art);
  assert.deepEqual(h.requests, [config.main.path, config.contents.path]);
  assert.equal(assets.clips.main.key, config.main.path); assert.equal(assets.clips.contents.key, config.contents.path);
  await assert.rejects(() => h.exports.loadOriginalBgmAssets({ json: async () => ({ ...config, loop: false }) }), /Unsupported original BGM/);
  const missing = harness({ failPath: config.contents.path });
  await assert.rejects(() => missing.exports.loadOriginalBgmAssets(missing.art), /missing audio/);
});

test('one looping source changes between Main and contents without restarting a shared contents track', () => {
  const h = harness(); assert.equal(h.audio.loop, true); assert.equal(h.audio.playOnAwake, false);
  assert.deepEqual(h.calls, [], 'preferences can be restored before any playback');
  h.bgm.setMode('Main'); assert.deepEqual(actions(h), ['clip', 'play']);
  h.audio.currentTime = 17; h.bgm.setMode('Main'); assert.equal(h.audio.currentTime, 17); assert.equal(h.calls.length, 2);
  h.bgm.setMode('SpeedRun'); assert.equal(h.audio.clip, h.assets.clips.contents); assert.equal(h.audio.currentTime, 0);
  h.audio.currentTime = 23;
  for (const mode of ['Raid', 'Boss', 'Mine', 'Monster']) h.bgm.setMode(mode);
  assert.equal(h.audio.currentTime, 23); assert.deepEqual(actions(h), ['clip', 'play', 'clip', 'play']);
  h.bgm.setMode('Main'); assert.equal(h.audio.clip, h.assets.clips.main); assert.equal(h.audio.currentTime, 0);
});

test('BGM mute only changes volume while background pause resumes the same playback position', () => {
  const h = harness(); h.bgm.setEnabled(false); h.bgm.setMode('Main');
  assert.deepEqual(actions(h), ['clip'], 'a saved disabled preference does not start playback');
  h.bgm.setEnabled(true); h.audio.currentTime = 37; assert.equal(h.audio.volume, 1); assert.equal(h.audio.currentTime, 37);
  h.bgm.setEnabled(false); assert.equal(h.audio.volume, 0); assert.equal(h.audio.isPlaying, true); assert.equal(h.calls.length, 2);
  h.bgm.setPaused(true); h.bgm.setPaused(true); assert.equal(h.audio.isPlaying, false); assert.equal(h.audio.currentTime, 37);
  h.bgm.setMode('Main'); h.bgm.setEnabled(true); assert.equal(h.calls.length, 3);
  h.bgm.setPaused(false); h.bgm.setPaused(false);
  assert.equal(h.audio.isPlaying, true); assert.equal(h.audio.currentTime, 37);
  assert.deepEqual(actions(h), ['clip', 'play', 'pause', 'play']);
});

test('background mode changes keep only the latest selected track and defer its start until foreground', () => {
  const h = harness(); h.bgm.setPaused(true); h.bgm.setMode('Main'); h.bgm.setMode('SpeedRun');
  assert.deepEqual(actions(h), ['clip', 'clip']); h.bgm.setPaused(false);
  assert.equal(h.calls.at(-1).clip, h.assets.clips.contents); assert.deepEqual(actions(h), ['clip', 'clip', 'play']);
});

test('browser waits for one trusted gesture and starts only the current track without queued history', () => {
  const h = harness({ browser: true }); assert.equal(h.listeners.size, 3);
  h.bgm.setMode('Main'); h.bgm.setMode('SpeedRun'); h.bgm.setMode('Main');
  h.gesture('mouseup', false); assert.equal(actions(h).includes('play'), false);
  h.gesture('touchend'); assert.equal(h.listeners.size, 0);
  assert.equal(h.calls.filter(call => call.action === 'play').length, 1);
  assert.equal(h.calls.at(-1).clip, h.assets.clips.main);
  h.gesture('keydown'); h.bgm.setMode('Main'); assert.equal(h.calls.filter(call => call.action === 'play').length, 1);
});

test('a gesture while backgrounded unlocks without playing; loading-time activation needs no second gesture', () => {
  const h = harness({ browser: true }); h.bgm.setPaused(true); h.bgm.setMode('Main'); h.gesture('mouseup');
  assert.equal(h.listeners.size, 0); assert.deepEqual(actions(h), ['clip']);
  h.bgm.setPaused(false); assert.deepEqual(actions(h), ['clip', 'play']);
  const activated = harness({ browser: true, activated: true });
  assert.equal(activated.listeners.size, 0); activated.bgm.setMode('Main'); assert.deepEqual(actions(activated), ['clip', 'play']);
});

test('destroy stops playback once, removes unlock hooks, and ignores all later commands', () => {
  for (const browser of [false, true]) {
    const h = harness({ browser }); h.bgm.setMode('Main'); h.bgm.destroy(); h.bgm.destroy();
    const count = h.calls.length;
    h.gesture('touchend'); h.bgm.setPaused(true); h.bgm.setPaused(false); h.bgm.setEnabled(false); h.bgm.setMode('Boss');
    assert.equal(h.calls.length, count); assert.equal(h.listeners.size, 0); assert.equal(h.bgm.node.destroyCalls, 1);
    assert.equal(h.calls.filter(call => call.action === 'stop').length, 1);
  }
});
