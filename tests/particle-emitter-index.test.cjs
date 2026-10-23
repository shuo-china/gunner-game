const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath, fixturePath } = require('./support/paths.cjs');
const feedbackView = path.join(__dirname, '.build/feedback/view');
const { OriginalParticleSimulation: Indexed } = require(path.join(feedbackView, 'OriginalParticleSimulation.js'));

// Frozen before the emitter-index optimization. Keep the independent integrator,
// allocation policy and random call order as the oracle, not a rewritten mock.
const legacyModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(fixturePath('particle-simulation-before-emitter-index.ts.txt'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS },
}).outputText, { module: legacyModule, exports: legacyModule.exports,
  require: name => require(path.resolve(feedbackView, name)),
});
const Legacy = legacyModule.exports.OriginalParticleSimulation;
const visuals = require(projectPath('assets/resources/art/weapon-system/visuals.json'));
const base = require(projectPath('assets/resources/art/effects/original-feedback.json')).particles.systems[0];
const curve = value => ({ mode: 0, value, min: 0, keys: [], minKeys: [] });
const spec = (overrides = {}) => ({ ...base, id: 'local', kind: 'bullet', sortingOrder: 0, scale: 1,
  lifetime: curve(1), size: curve(1), speed: curve(0), gravity: curve(0), rotation: curve(0),
  emissionRate: 0, timeEmissionRate: 0, duration: 2, looping: false, prewarm: false,
  bursts: [{ time: 0, count: 1 }], maxParticles: 8, shape: null, sphereRadius: 0,
  simulationSpace: 0, sourceTransform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
  sizeCurve: null, gradient: null, rotationCurve: null, inheritVelocity: null, limitVelocity: null, ...overrides });
const bullet = (id, overrides = {}) => ({ id, active: true, damaging: true, age: .05, traveled: .5,
  position: { x: .5, z: id }, direction: { x: 1, z: 0 }, speed: 10, height: 2, ...overrides });
function random(seed) {
  let count = 0;
  const next = () => { count++; seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  next.count = () => count;
  return next;
}
function pair(specs) {
  const leftRandom = random(0x124816), rightRandom = random(0x124816);
  return { actual: new Indexed(specs, leftRandom), expected: new Legacy(specs, rightRandom), leftRandom, rightRandom };
}
function snapshot(simulation) {
  return JSON.parse(JSON.stringify({
    particles: simulation.particles.map(p => ({ ...p, spec: p.spec.id,
      pose: p.active ? simulation.pose(p) : undefined })),
    emissions: Array.from(simulation.emissions),
    hits: simulation.hitEmissions.map(hit => ({ ...hit, group: hit.group.spec.id })),
    active: simulation.hasActiveParticles,
  }));
}
function same(p, label) {
  assert.equal(p.leftRandom.count(), p.rightRandom.count(), `${label}: random call count`);
  assert.deepEqual(snapshot(p.actual), snapshot(p.expected), label);
}
function apply(p, method, ...args) {
  p.actual[method](...args); p.expected[method](...args);
  same(p, method);
}

test('indexed emitters exactly match the legacy seeded simulation across complete source profiles', () => {
  for (const key of ['73882-69531', '72452-72010', '70679-72213', 'shuriken-ZZZ']) {
    const p = pair(visuals.projectileSkins[key]);
    for (let frame = 0; frame < 90; frame++) {
      const dt = [1 / 60, 1 / 30, .08][frame % 3], bullets = [];
      for (let id = 1; id <= 6; id++) {
        const age = ((frame + id * 3) % 24) / 30;
        if ((frame + id) % 19 === 0) apply(p, 'shot', id);
        if ((frame + id) % 17 === 0) continue;
        const angle = frame * .07 + id;
        bullets.push(bullet(id, { age, traveled: age * 70, speed: 70,
          position: { x: Math.cos(angle) * age * 70, z: Math.sin(angle) * age * 70 },
          direction: { x: Math.cos(angle), z: Math.sin(angle) },
          damaging: frame % 11 !== 0, trailTime: .1 }));
      }
      if (frame % 5 === 0) apply(p, 'hit', { x: frame / 4, z: 3 }, 20, frame % 2 ? 0 : 2);
      if (frame % 13 === 0) apply(p, 'clearEmitter', 3);
      if (frame === 51) apply(p, 'reset');
      apply(p, 'update', dt, bullets);
    }
  }
});

test('duplicate IDs keep sequential local movement, stop-on-death and reset ordering', () => {
  const p = pair([spec(), spec({ id: 'stopped', sortingOrder: 1, stopOnDeath: true }),
    spec({ id: 'world', sortingOrder: 2, simulationSpace: 1 })]);
  apply(p, 'shot', 1); apply(p, 'update', .05, [bullet(1)]);
  const trace = [], expectedTrace = [];
  for (const [sim, result] of [[p.actual, trace], [p.expected, expectedTrace]]) {
    for (const method of ['moveLocal', 'advance']) {
      const original = sim[method];
      sim[method] = function (particle, ...args) { result.push([method, particle.index]); return original.call(this, particle, ...args); };
    }
  }
  apply(p, 'update', .05, [
    bullet(1, { age: .1, traveled: 1, position: { x: 1, z: 2 }, direction: { x: 0, z: 1 } }),
    bullet(1, { age: .15, traveled: 1.5, position: { x: 2, z: 3 }, damaging: false }),
    bullet(1, { age: .2, traveled: .1, position: { x: 4, z: 5 } }),
  ]);
  assert.deepEqual(trace, expectedTrace, 'all original moveLocal calls precede the unchanged advance order');
  apply(p, 'update', .2, [bullet(1, { age: .3, traveled: 2 }), bullet(1, { age: .4, traveled: 3 })]);
});

test('slot transfer preserves first-inactive reuse and clearing cannot kill its new owner', () => {
  const p = pair([spec({ maxParticles: 2, lifetime: curve(.2) })]);
  apply(p, 'update', .01, [bullet(1), bullet(2)]);
  const identities = [...p.actual.particles];
  apply(p, 'clearEmitter', 1);
  apply(p, 'update', .01, [bullet(3)]);
  assert.equal(p.actual.particles[0].emitterId, 3);
  apply(p, 'shot', 1);
  assert.equal(p.actual.particles[0].active, true, 'old owner cannot clear the transferred slot');
  apply(p, 'update', .5, []);
  apply(p, 'shot', 2); apply(p, 'update', .01, [bullet(2)]);
  assert.equal(p.actual.particles[0].emitterId, 2, 'lowest inactive slot remains first');
  assert.ok(p.actual.particles.every((particle, index) => particle === identities[index]));
});

test('owned inactive slots support direct active toggles after death, clear and reset', () => {
  const p = pair([spec({ maxParticles: 2, lifetime: curve(.1) })]);
  apply(p, 'update', .01, [bullet(7)]);
  for (const operation of ['death', 'clearEmitter', 'reset']) {
    if (operation === 'death') apply(p, 'update', .3, []);
    else apply(p, operation, 7);
    for (const sim of [p.actual, p.expected]) {
      const particle = sim.particles[0]; particle.active = true; particle.age = 0; particle.life = 1;
    }
    apply(p, 'update', .01, [bullet(7, { age: .1, traveled: 1, position: { x: 2, z: 1 } })]);
    apply(p, 'shot', 7);
    assert.equal(p.actual.particles[0].active, false);
  }
});

test('reclaiming a lower slot keeps each emitter traversal in original global slot order', () => {
  const p = pair([spec({ maxParticles: 3 })]);
  apply(p, 'update', .01, [bullet(1), bullet(2)]);
  apply(p, 'clearEmitter', 1); apply(p, 'shot', 2);
  apply(p, 'update', .01, [bullet(2)]);
  const trace = [], legacyTrace = [];
  for (const [sim, result] of [[p.actual, trace], [p.expected, legacyTrace]]) {
    sim.particles[1].active = true;
    const original = sim.moveLocal;
    sim.moveLocal = function (particle, ...args) { result.push(particle.index); return original.call(this, particle, ...args); };
  }
  apply(p, 'update', .01, [bullet(2, { age: .1, traveled: 1 })]);
  assert.deepEqual(trace, [0, 1]);
  assert.deepEqual(trace, legacyTrace);
});

test('full pools, immediate expiration, delayed bursts, prewarm and invalid dt keep random and timing contracts', () => {
  const p = pair([
    spec({ id: 'full', maxParticles: 2, bursts: [{ time: 0, count: 9 }], lifetime: curve(.1) }),
    spec({ id: 'warm', sortingOrder: -2, maxParticles: 8, bursts: [], timeEmissionRate: 12,
      duration: .4, looping: true, prewarm: true, lifetime: curve(.07) }),
    spec({ id: 'hits', kind: 'hit', maxParticles: 3, timeEmissionRate: 10, duration: .3,
      bursts: [{ time: 0, count: 4 }, { time: .2, count: 2 }], lifetime: curve(.1) }),
  ]);
  apply(p, 'hit', { x: 1, z: 4 });
  for (const dt of [0, -1, NaN, Infinity, .01, .08, .3, 1])
    apply(p, 'update', dt, [bullet(1), bullet(2)]);
  apply(p, 'reset'); apply(p, 'hit', { x: 2, z: 3 });
  apply(p, 'update', .25, [bullet(1)]);
});

function countReads(simulation) {
  const counts = { active: 0, owner: 0 };
  for (const particle of simulation.particles) {
    for (const [field, counter] of [['active', 'active'], ['emitterId', 'owner']]) {
      let value = particle[field];
      Object.defineProperty(particle, field, { configurable: true, enumerable: true,
        get() { counts[counter]++; return value; }, set(next) { value = next; } });
    }
  }
  return counts;
}
test('30 emitters visit only their slots, and shot/clear do not rescan an 869-slot source pool', () => {
  const specs = visuals.projectileSkins['73882-69531'], actual = new Indexed(specs, () => .5), expected = new Legacy(specs, () => .5);
  const bullets = Array.from({ length: 30 }, (_, id) => bullet(id, { age: .1, traveled: 7, speed: 70 }));
  for (const sim of [actual, expected]) { for (const b of bullets) sim.shot(b.id); sim.update(1 / 60, bullets); }
  const left = countReads(actual), right = countReads(expected);
  actual.update(1 / 60, bullets); expected.update(1 / 60, bullets);
  assert.equal(actual.particles.length, 869);
  assert.equal(right.active, 869 * 31, 'legacy baseline really scans the pool once per emitter');
  assert.ok(left.active <= 869 * 2, `${left.active} active reads must be bounded by two pool passes`);
  assert.equal(left.owner, 0, 'indexed update never searches all particle owner fields');
  left.owner = right.owner = 0;
  actual.shot(0); expected.shot(0); actual.clearEmitter(1); expected.clearEmitter(1);
  assert.equal(right.owner, 869 + specs.filter(s => s.kind === 'bullet').reduce((n, s) => n + actual.particles.filter(p => p.spec === s).length, 0));
  assert.equal(left.owner, 0, 'shot and clear use the existing owner index');
  assert.deepEqual(snapshot(actual), snapshot(expected));
});

test('ownership index stays bounded while thousands of sequential emitter IDs recycle the same slots', () => {
  const simulation = new Indexed([spec({ maxParticles: 2, lifetime: curve(.001) })], () => .5);
  for (let id = 0; id < 1000; id++) simulation.update(.01, [bullet(id)]);
  assert.ok(simulation.emitterParticles.size <= simulation.particles.length);
  assert.equal(Array.from(simulation.emitterParticles.values()).reduce((n, slots) => n + slots.length, 0), 1);
  simulation.reset();
  assert.equal(simulation.hasActiveParticles, false);
});
