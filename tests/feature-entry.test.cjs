const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function fixture() {
  const sounds = [], feedback = []; let opened = 0;
  class Node {
    static EventType = { TOUCH_START: 'start', TOUCH_END: 'end', TOUCH_CANCEL: 'cancel' };
    events = {}; active = true;
    on(name, handler) { this.events[name] = handler; }
    getComponent() { return { getBoundingBoxToWorld: () => ({ contains: at => at.inside }) }; }
    destroy() {}
  }
  const spec = { id: 'entry', clickSound: 1 }, config = { roots: { entry: 'entry' }, nodes: { entry: spec } };
  const imports = { cc: { Node, UITransform: class {} }, './ArtLibrary': { makeNode: () => new Node() },
    './OriginalWeaponUi': { OriginalWeaponUi: class { create() { return new Node(); } destroy() {} } },
    './OriginalWeaponFeedback': { OriginalWeaponFeedback: class {
      press() { feedback.push('press'); } release() { feedback.push('release'); }
      clear() { feedback.push('clear'); } update() {}
    } } };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../assets/scripts/view/FeatureEntry.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  }).outputText, { module, exports: module.exports, require: name => { assert.ok(name in imports, name); return imports[name]; } });
  const entry = new module.exports.FeatureEntry(new Node(), {}, { config }, 'weapons', () => opened++, id => sounds.push(id));
  const emit = (name, id = 1, inside = true) => entry.entry.events[name]({ getID: () => id, getUILocation: () => ({ inside }) });
  return { entry, emit, sounds, feedback, opened: () => opened, rightMenuOffsets: module.exports.rightMenuOffsets };
}

test('lightweight entries preserve click sound and accept only the originating pointer released inside', () => {
  const h = fixture(); h.emit('start'); h.emit('end', 2); assert.equal(h.opened(), 0);
  h.emit('end'); assert.equal(h.opened(), 1); assert.deepEqual(h.sounds, [1]);
  assert.deepEqual(h.feedback, ['press', 'release']);
  h.emit('start'); h.emit('end', 1, false); assert.equal(h.opened(), 1);
});

test('cancelled, hidden, or blocked entry presses cannot open a panel later', () => {
  for (const change of [h => h.emit('cancel'), h => h.entry.setState(false, false, false), h => h.entry.setState(true, false, true)]) {
    const h = fixture(); h.emit('start'); change(h); h.emit('end');
    assert.equal(h.opened(), 0); assert.deepEqual(h.sounds, []); assert.ok(h.feedback.includes('clear'));
  }
});

test('right menu includes mine in source order and collapses hidden features', () => {
  const { rightMenuOffsets } = fixture();
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(rightMenuOffsets({ speedrun: true, mine: true, boss: true, hunt: true, raid: true })),
    { speedrun: 355, mine: 480, boss: 605, hunt: 730, raid: 855 });
  assert.deepEqual(plain(rightMenuOffsets({ speedrun: true, mine: false, boss: true, hunt: false, raid: true })),
    { speedrun: 355, boss: 480, raid: 605 });
  assert.deepEqual(plain(rightMenuOffsets({})), {});
  assert.deepEqual(plain(rightMenuOffsets({ speedrun: true, mine: true, boss: true, hunt: true, adventure: true, raid: true })),
    { speedrun: 355, mine: 480, boss: 605, hunt: 730, adventure: 855, raid: 980 });
  assert.deepEqual(plain(rightMenuOffsets({ adventure: true, raid: true })), { adventure: 355, raid: 480 });
});
