const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');

const filename = projectPath('assets/scripts/view/LoadingPerformanceTrace.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS },
}).outputText;
const exportsForTest = { exports: {} };
vm.runInNewContext(compiled, { module: exportsForTest, exports: exportsForTest.exports }, { filename });
const { LoadingPerformanceTrace } = exportsForTest.exports;
const plain = value => JSON.parse(JSON.stringify(value));

test('loading trace associates completion and CPU phases with the current frame without inferring GPU or GC work', () => {
  let now = 10;
  const trace = new LoadingPerformanceTrace(() => now);
  trace.mark('settings', 'resources-ready');
  now = 26; trace.frame(.016);
  now = 27; trace.mark('settings', 'construct', 1);
  now = 58; trace.frame(.032);
  trace.mark('settings', 'commit', .5);
  const snapshot = plain(trace.snapshot());
  assert.deepEqual(snapshot.frames, [
    { frame: 1, atMs: 26, intervalMs: 16 }, { frame: 2, atMs: 58, intervalMs: 32 },
  ]);
  assert.deepEqual(snapshot.events, [
    { frame: 0, atMs: 10, feature: 'settings', phase: 'resources-ready', workMs: 0 },
    { frame: 1, atMs: 27, feature: 'settings', phase: 'construct', workMs: 1 },
    { frame: 2, atMs: 58, feature: 'settings', phase: 'commit', workMs: .5 },
  ]);
  assert.equal(snapshot.gpuTiming, 'unobserved');
  assert.equal(snapshot.garbageCollection, 'unobserved');
});

test('loading trace retains bounded chronological history after ring wrap and snapshots cannot mutate history', () => {
  let now = 0;
  const trace = new LoadingPerformanceTrace(() => now);
  const initial = trace.snapshot();
  assert.equal(initial.frames.length, 0); assert.equal(initial.events.length, 0);
  for (let i = 1; i <= initial.frameCapacity + 17; i++) {
    now = i; trace.frame(.01); trace.mark('weapons', `phase-${i}`, i);
  }
  const first = trace.snapshot();
  assert.equal(first.frames.length, initial.frameCapacity);
  assert.equal(first.events.length, initial.eventCapacity);
  assert.equal(first.frames[0].frame, 18);
  assert.equal(first.frames.at(-1).frame, initial.frameCapacity + 17);
  assert.equal(first.events[0].frame, initial.frameCapacity + 18 - initial.eventCapacity);
  for (const list of [first.frames, first.events]) {
    for (let i = 1; i < list.length; i++) assert.equal(list[i].frame, list[i - 1].frame + 1);
  }
  first.frames[0].intervalMs = 999; first.events[0].phase = 'mutated'; first.events.length = 0;
  const second = trace.snapshot();
  assert.equal(second.frames[0].intervalMs, 10);
  assert.notEqual(second.events[0].phase, 'mutated');
  assert.equal(second.events.length, initial.eventCapacity);
});

test('loading CPU measurement preserves results and errors and records failed work once', () => {
  let now = 100;
  const trace = new LoadingPerformanceTrace(() => now), value = {}, failure = new Error('construction failed');
  trace.frame(0);
  assert.equal(trace.measure('settings', 'construct', () => { now += 7; return value; }), value);
  assert.throws(() => trace.measure('weapons', 'commit', () => { now += 3; throw failure; }), error => error === failure);
  assert.deepEqual(plain(trace.snapshot().events).map(({ feature, phase, workMs }) => ({ feature, phase, workMs })), [
    { feature: 'settings', phase: 'construct', workMs: 7 }, { feature: 'weapons', phase: 'commit', workMs: 3 },
  ]);
});

test('loading trace sanitizes invalid durations while retaining valid zero and fractional timings', () => {
  const trace = new LoadingPerformanceTrace(() => 0);
  for (const value of [-1, NaN, Infinity, 0, .0015]) { trace.frame(value); trace.mark('x', 'prepare', value); }
  const snapshot = plain(trace.snapshot());
  assert.deepEqual(snapshot.frames.map(sample => sample.intervalMs), [0, 0, 0, 0, 1.5]);
  assert.deepEqual(snapshot.events.map(sample => sample.workMs), [0, 0, 0, 0, .0015]);
});
