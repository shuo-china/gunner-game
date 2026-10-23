'use strict';

// Imported by the package hooks before Cocos starts. No platform API wrapping,
// file probes, payloads, URLs or error messages are retained by this collector.
const PHASES = ['platformSubpackage', 'metadataRead', 'metadataInflate', 'metadataParse', 'metadataHydrate'];
const LIMIT = 96, RECENT_LIMIT = 64;
const startedAt = Date.now(), phases = {}, packages = new Map(), recent = [], longOperations = [];
const reuse = { inFlight: 0, ready: 0, failed: 0, unknown: 0 };
let lateCallbacks = 0, droppedPackages = 0;
for (const phase of PHASES) phases[phase] = { started: 0, active: 0, failed: 0, totalMs: 0, maxMs: 0 };
const label = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : 'other';
function packageState(name) {
  const key = label(name);
  if (!packages.has(key)) {
    if (packages.size >= LIMIT) { packages.delete(packages.keys().next().value); droppedPackages++; }
    packages.set(key, { name: key, attempts: 0, active: 0, failed: 0, timedOut: 0, lateCallbacks: 0,
      inFlightReuse: 0, readyReuse: 0, failureReuse: 0, totalMs: 0, maxMs: 0, outcome: 'unknown' });
  }
  return packages.get(key);
}
function begin(phase, name, source) {
  const totals = phases[phase], at = Date.now();
  totals.started++; totals.active++;
  let completed = false;
  return outcome => {
    if (completed) return null;
    completed = true;
    const durationMs = Math.max(0, Date.now() - at), failed = outcome !== 'success';
    totals.active--; totals.failed += failed ? 1 : 0;
    totals.totalMs += durationMs; totals.maxMs = Math.max(totals.maxMs, durationMs);
    const record = { phase, name: label(name), source: label(source), startedAt: at, durationMs, outcome };
    recent.push(record); if (recent.length > RECENT_LIMIT) recent.shift();
    if (durationMs >= 16) { longOperations.push(record); if (longOperations.length > RECENT_LIMIT) longOperations.shift(); }
    return record;
  };
}
function beginPackage(name, source) {
  const entry = packageState(name), finish = begin('platformSubpackage', name, source);
  entry.attempts++; entry.active++; entry.outcome = 'pending'; entry.lastStartedAt = Date.now(); entry.lastSource = label(source);
  return outcome => {
    const record = finish(outcome);
    if (!record) { entry.lateCallbacks++; lateCallbacks++; return; }
    entry.active--; entry.failed += outcome === 'success' ? 0 : 1;
    entry.timedOut += outcome === 'timeout' ? 1 : 0;
    entry.outcome = outcome; entry.lastSource = record.source;
    entry.lastFinishedAt = record.startedAt + record.durationMs;
    entry.totalMs += record.durationMs; entry.maxMs = Math.max(entry.maxMs, record.durationMs);
  };
}
function reusePackage(name) {
  const entry = packages.get(label(name));
  if (!entry) { reuse.unknown++; return; }
  if (entry.active) { entry.inFlightReuse++; reuse.inFlight++; }
  else if (entry.outcome === 'success') { entry.readyReuse++; reuse.ready++; }
  else { entry.failureReuse++; reuse.failed++; }
}
function measureMetadata(phase, name, operation) {
  const finish = begin(phase, name, 'metadata');
  try { const value = operation(); finish('success'); return value; }
  catch (error) { finish('failed'); throw error; }
}
function snapshot() {
  const totals = {};
  for (const phase of PHASES) totals[phase] = { ...phases[phase] };
  return { available: true, startedAt, capturedAt: Date.now(),
    clock: 'Date.now; starts in game.js before Cocos; excludes platform launch before game.js',
    subpackageMeaning: 'wx.loadSubpackage attempts; transfer versus platform cache is unknown',
    metadataMeaning: 'synchronous read, inflate, JSON/text parse and font/mesh restoration; phase totals can overlap other pipeline phases',
    phases: totals, packages: Array.from(packages.values(), value => ({ ...value })),
    reuse: { ...reuse }, lateCallbacks, droppedPackages,
    recent: recent.map(value => ({ ...value })), longOperations: longOperations.map(value => ({ ...value })),
    limits: { packages: LIMIT, recent: RECENT_LIMIT, longOperations: RECENT_LIMIT } };
}
const api = Object.freeze({ snapshot });
// The public surface exposes copies only; gameplay/retry/cache mutation stays private.
if (typeof globalThis !== 'undefined') {
  try { globalThis.__forestGunnerPlatformTiming = api; } catch (_) { /* Optional diagnostics. */ }
}
function publishEarlySnapshot() {
  if (typeof globalThis === 'undefined' || globalThis.__forestGunnerLoading) return;
  try { globalThis.__forestGunnerLoading = Object.freeze({ snapshot: () => {
    const platform = snapshot();
    return { startup: { phase: 'platform-loader', interactive: false, clock: platform.clock },
      timings: { resources: { phases: platform.phases, observed: ['package-hooks-before-Cocos'], platform } } };
  } }); } catch (_) { /* Optional diagnostics. */ }
}
module.exports = { beginPackage, reusePackage, measureMetadata, publishEarlySnapshot, snapshot };
