const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');

const filename = projectPath('assets/scripts/view/StartupTimeline.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS },
}).outputText;
const moduleForTest = { exports: {} };
vm.runInNewContext(compiled, { module: moduleForTest, exports: moduleForTest.exports }, { filename });
const { StartupTimeline } = moduleForTest.exports;
const plain = value => JSON.parse(JSON.stringify(value));

test('startup keeps the original boot epoch and retains failed and retried requests without hiding idle waits', () => {
  let now = 1100;
  const timeline = new StartupTimeline(1000, () => now);
  const first = timeline.begin('login');
  now = 1600; first('failed');
  now = 4600; const retry = timeline.begin('login');
  now = 4800; retry();
  const snapshot = plain(timeline.snapshot());
  assert.equal(snapshot.bootStartedAt, 1000); assert.equal(snapshot.elapsedMs, 3800);
  assert.equal(snapshot.currentPhase, null); assert.deepEqual(snapshot.activePhases, []);
  assert.deepEqual(snapshot.phases.login, { attempts: 2, active: 0, succeeded: 1, failed: 1, cancelled: 0, totalMs: 700, activeMs: 0 });
  assert.deepEqual(snapshot.attempts, [
    { phase: 'login', attempt: 1, startedAtMs: 100, finishedAtMs: 600, status: 'failed', durationMs: 500 },
    { phase: 'login', attempt: 2, startedAtMs: 3600, finishedAtMs: 3800, status: 'success', durationMs: 200 },
  ]);
});

test('startup records concurrent resource and data phases independently of total wall time', () => {
  let now = 100;
  const timeline = new StartupTimeline(0, () => now);
  const core = timeline.begin('core'), login = timeline.begin('login');
  now = 300; login();
  const read = timeline.begin('cloudRead');
  now = 350;
  let snapshot = plain(timeline.snapshot());
  assert.equal(snapshot.currentPhase, 'cloudRead'); assert.deepEqual(snapshot.activePhases, ['cloudRead', 'core']);
  assert.equal(snapshot.phases.core.activeMs, 250); assert.equal(snapshot.phases.cloudRead.activeMs, 50);
  now = 400; read();
  const offline = timeline.begin('offline'); now = 500; offline();
  const write = timeline.begin('cloudWrite'); now = 600; write();
  snapshot = plain(timeline.snapshot()); assert.equal(snapshot.currentPhase, 'core');
  now = 700; core();
  const panels = timeline.begin('panels'); now = 800; panels(); timeline.complete();
  snapshot = plain(timeline.snapshot());
  assert.equal(snapshot.elapsedMs, 800); assert.equal(snapshot.currentPhase, null);
  assert.equal(Object.values(snapshot.phases).reduce((sum, phase) => sum + phase.totalMs, 0), 1200);
  assert.ok(Object.values(snapshot.phases).every(phase => phase.attempts === 1 && phase.succeeded === 1));
});

test('startup completions are idempotent and overlapping attempts in one phase retain separate durations', () => {
  let now = 0;
  const timeline = new StartupTimeline(0, () => now), first = timeline.begin('core');
  now = 10; const second = timeline.begin('core');
  now = 20; assert.equal(timeline.snapshot().phases.core.activeMs, 30);
  first('cancelled'); first(); first('failed');
  now = 30; second(); second('failed');
  assert.deepEqual(plain(timeline.snapshot().phases.core), {
    attempts: 2, active: 0, succeeded: 1, failed: 0, cancelled: 1, totalMs: 40, activeMs: 0,
  });
});

test('startup async measurement preserves results and original rejection identities without retaining payloads', async () => {
  let now = 0;
  const timeline = new StartupTimeline(0, () => now), result = { account: 'do-not-record' }, error = new Error('private-server-response');
  assert.equal(await timeline.measureAsync('login', async () => { now += 10; return result; }), result);
  await assert.rejects(timeline.measureAsync('cloudRead', async () => { now += 20; throw error; }), value => value === error);
  await assert.rejects(timeline.measureAsync('cloudWrite', () => { now += 5; throw error; }), value => value === error);
  const snapshot = timeline.snapshot();
  assert.equal(snapshot.phases.login.succeeded, 1); assert.equal(snapshot.phases.cloudRead.failed, 1);
  assert.equal(snapshot.phases.cloudWrite.failed, 1); assert.equal(snapshot.phases.cloudWrite.totalMs, 5);
  assert.doesNotMatch(JSON.stringify(snapshot), /do-not-record|private-server-response|account/);
});

test('startup history is bounded and detached while lifetime counters include evicted and still active attempts', () => {
  let now = 0;
  const timeline = new StartupTimeline(0, () => now), old = timeline.begin('core');
  const capacity = timeline.snapshot().attemptCapacity;
  for (let i = 0; i < capacity + 7; i++) {
    const finish = timeline.begin('login'); now++; finish(i % 2 ? 'success' : 'failed');
  }
  old();
  const first = timeline.snapshot();
  assert.equal(first.attempts.length, capacity); assert.equal(first.droppedAttempts, 8);
  assert.equal(first.attempts[0].attempt, 8); assert.equal(first.attempts.at(-1).attempt, capacity + 7);
  assert.equal(first.phases.login.attempts, capacity + 7); assert.equal(first.phases.login.totalMs, capacity + 7);
  assert.equal(first.phases.core.succeeded, 1); assert.equal(first.phases.core.totalMs, capacity + 7);
  first.attempts[0].status = 'mutated'; first.attempts.length = 0;
  first.activePhases.push('mutated'); first.phases.login.failed = 999;
  const second = timeline.snapshot();
  assert.equal(second.attempts.length, capacity); assert.notEqual(second.attempts[0].status, 'mutated');
  assert.equal(second.phases.login.failed, 36); assert.deepEqual(plain(second.activePhases), []);
});

test('startup completion freezes launch and active durations, ignores late phase starts, and remains idempotent', () => {
  let now = 100;
  const timeline = new StartupTimeline(0, () => now), finish = timeline.begin('panels');
  now = 200; timeline.complete();
  now = 10000; timeline.complete(); timeline.begin('login')();
  const before = timeline.snapshot();
  assert.equal(before.elapsedMs, 200); assert.equal(before.capturedAt, 10000); assert.equal(before.completed, true);
  assert.equal(before.phases.panels.activeMs, 100); assert.equal(before.phases.login.attempts, 0);
  finish();
  assert.equal(timeline.snapshot().phases.panels.totalMs, 100); assert.equal(timeline.snapshot().currentPhase, null);
});

test('startup clock adjustments and invalid samples never produce negative or nonfinite timings', () => {
  let now = 50;
  const timeline = new StartupTimeline(100, () => now), finish = timeline.begin('offline');
  now = 130; assert.equal(timeline.snapshot().elapsedMs, 30);
  for (const invalid of [20, NaN, Infinity]) {
    now = invalid; assert.equal(timeline.snapshot().elapsedMs, 30);
  }
  finish(); assert.equal(timeline.snapshot().phases.offline.totalMs, 30);
  assert.equal(new StartupTimeline(NaN, () => 12).bootStartedAt, 12);
  assert.equal(new StartupTimeline(NaN, () => NaN).snapshot().elapsedMs, 0);
});
