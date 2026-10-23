const test = require('node:test');
const assert = require('node:assert/strict');
const { projectPath } = require('./support/paths.cjs');
const { advanceParticleExtra } = require('./.build/feedback/view/OriginalParticleExtraMotion.js');
const { OriginalParticleSimulation } = require('./.build/feedback/view/OriginalParticleSimulation.js');
const visuals = require(projectPath('assets/resources/art/weapon-system/visuals.json'));

const { getWeaponCatalog } = require('./.build/core/WeaponCatalog.js');
const sources = getWeaponCatalog().filter(w => w.category === 'cannon').map(w => ({ weaponId: w.id, speed: w.missileSpeed, skin: visuals.weapons[w.id].projectileSkin }));
// Keep the retired original S missile's noise regression alongside all eight active cannons.
sources.push({ weaponId: 'legacy-24', speed: 50, skin: '69419-67673' });
assert.equal(sources.length, 9);
const missiles = sources.map(({ weaponId, speed, skin }) => {
  const systems = visuals.projectileSkins[skin] ?? require('./fixtures/retired-projectile-profiles.json')[skin];
  const spec = systems.find(system => system.noise);
  assert.ok(spec, `weapon ${weaponId} must exercise its extracted noise module`);
  return { weaponId, speed, systems, spec };
});
const position = p => [p.x, p.y, p.z];
const distance = (a, b) => Math.hypot(...a.map((value, axis) => value - b[axis]));
const makeParticle = (spec, random = .5, at = [0, 2, 0]) => ({
  index: 0, spec, active: true, age: 0, life: spec.lifetime.value,
  size: spec.size.value * spec.scale, x: at[0], y: at[1], z: at[2],
  vx: 0, vy: 0, vz: 0, rotation: 0, random,
});

// These source modules use one shared, decreasing strength curve, no remap,
// and frequency damping. This is a movement envelope, not a claim that our
// deterministic reconstruction reproduces Unity's native noise samples.
const speedBound = spec => spec.scale * spec.noise.strength.scalar *
  spec.noise.positionAmount.scalar / (spec.noise.damping ? spec.noise.frequency : 1);
function step(p, dt) {
  const from = { x: p.x, y: p.y, z: p.z };
  advanceParticleExtra(p, dt, from, []);
  p.age += dt;
}
function path(spec, random, dt, duration = .4) {
  const particle = makeParticle(spec, random);
  const steps = Math.round(duration / dt);
  let length = 0;
  for (let frame = 0; frame < steps; frame++) {
    const before = position(particle);
    step(particle, dt);
    length += distance(before, position(particle));
  }
  return { end: position(particle), length };
}

test('all nine authored missile trails start continuously instead of teleporting at birth', () => {
  for (const { weaponId, spec } of missiles) {
    for (const at of [[0, 2, 0], [-100, 3, -10], [23, 12, 37]]) {
      for (let seed = 0; seed < 32; seed++) {
        for (const dt of [0, .000001, .001, 1 / 60]) {
          const p = makeParticle(spec, (seed + .5) / 32, at);
          step(p, dt);
          const movement = distance(at, position(p));
          assert.ok(movement <= speedBound(spec) * dt + 1e-8,
            `weapon ${weaponId}, seed ${seed}, dt ${dt}: birth movement ${movement}`);
        }
      }
    }
  }
});

test('missile turbulence stays within its authored motion envelope on every frame', () => {
  for (const { weaponId, spec } of missiles) {
    for (const seed of [.01, .2, .5, .8, .99]) {
      const p = makeParticle(spec, seed);
      let length = 0;
      for (let frame = 0; frame < 48; frame++) {
        // Exercise alternating render-frame durations as well as tiny steps.
        const dt = [1 / 120, 1 / 60, .001][frame % 3];
        const before = position(p);
        step(p, dt);
        const movement = distance(before, position(p));
        length += movement;
        assert.ok(position(p).every(Number.isFinite));
        assert.ok(movement <= speedBound(spec) * dt + 1e-8,
          `weapon ${weaponId}, seed ${seed}, frame ${frame}: jump ${movement}`);
      }
      assert.ok(length <= speedBound(spec) * p.age + 1e-7);
      assert.ok(length > .0001, `weapon ${weaponId}: keep visible turbulence`);
    }
  }
});

test('missile noise produces comparable paths across render rates and delayed updates', () => {
  for (const { weaponId, spec } of missiles) {
    for (const seed of [.1, .5, .9]) {
      const fine = path(spec, seed, 1 / 240);
      for (const dt of [1 / 30, 1 / 60, 1 / 120, .4]) {
        const actual = path(spec, seed, dt);
        assert.ok(distance(actual.end, fine.end) <= .08 * spec.scale,
          `weapon ${weaponId}, seed ${seed}, dt ${dt}: frame rate changes trajectory`);
        if (dt < .4) assert.ok(Math.abs(actual.length - fine.length) <= .08 * spec.scale,
          `weapon ${weaponId}, seed ${seed}, dt ${dt}: frame rate changes travelled distance`);
      }
    }
  }
});

test('reused missile particle slots have the same new motion as fresh slots', () => {
  for (const { weaponId, spec } of missiles) {
    const reused = makeParticle(spec, .7, [-40, 8, 12]);
    for (let frame = 0; frame < 24; frame++) step(reused, 1 / 60);
    Object.assign(reused, makeParticle(spec, .2, [5, 2, -7]));
    const fresh = makeParticle(spec, .2, [5, 2, -7]);
    for (let frame = 0; frame < 24; frame++) {
      step(reused, 1 / 60);
      step(fresh, 1 / 60);
      assert.ok(distance(position(reused), position(fresh)) < 1e-8,
        `weapon ${weaponId}: old particle lifetime leaked into pooled reuse`);
    }
  }
});

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('actual missile visual systems never mutate combat trajectories or source configurations', () => {
  for (const { weaponId, systems } of missiles) {
    const originalSource = JSON.stringify(systems);
    let seed = 37;
    const simulation = new OriginalParticleSimulation(systems, () =>
      ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296));
    simulation.shot(1);
    simulation.hit({ x: 20, z: 0 }, 13, 0);
    let sawNoise = false;
    for (let frame = 1; frame <= 24; frame++) {
      const age = frame / 60, t = age / .4;
      const combatBullet = freeze({
        id: 1, weaponId, weaponType: 'MISSILE', active: true, damaging: true,
        age, traveled: age * 50, speed: 50, position: { x: age * 50, z: 0 },
        direction: { x: 1, z: 0 }, height: 2 * (1 - t) + 32 * t * (1 - t),
        missileStart: { x: 0, z: 0 }, missileTarget: { x: 20, z: 0 },
        missileDuration: .4, missileArcHeight: 8, damage: '2000000000',
        explosionRadius: 13, hitIds: [7, 11], trailTime: 0,
      });
      const before = JSON.stringify(combatBullet);
      simulation.update(1 / 60, freeze([combatBullet]));
      assert.equal(JSON.stringify(combatBullet), before, `weapon ${weaponId}: visual update changed combat`);
      sawNoise ||= simulation.particles.some(p => p.active && p.spec.noise);
    }
    assert.ok(sawNoise, `weapon ${weaponId}: exercise live authored noise particles`);
    assert.equal(JSON.stringify(systems), originalSource, `weapon ${weaponId}: original resource configuration changed`);
  }
});

test('production missile spawning only adds age-bounded turbulence to first-frame trail particles', () => {
  for (const { weaponId, speed, systems, spec } of missiles) {
    const originalSource = JSON.stringify(systems);
    const referenceSystems = JSON.parse(originalSource);
    for (const system of referenceSystems) delete system.noise;
    const referenceSource = JSON.stringify(referenceSystems);
    for (const initialSeed of [1, 37, 7919]) {
      // At 35 units/s the X cannon has not emitted its first distance-based
      // particle after 1/60s, so start with a 30 Hz frame for every skin.
      for (const dt of [1 / 30, 1 / 20, .2]) {
        const seededRandom = () => {
          let seed = initialSeed;
          return () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
        };
        const actual = new OriginalParticleSimulation(systems, seededRandom());
        const reference = new OriginalParticleSimulation(referenceSystems, seededRandom());
        const duration = 20 / speed, t = dt / duration;
        const bullet = freeze({
          id: 1, weaponId, weaponType: 'MISSILE', active: true, damaging: true,
          age: dt, traveled: speed * dt, speed, position: { x: speed * dt, z: 0 },
          direction: { x: 1, z: 0 }, height: 2 * (1 - t) + 32 * t * (1 - t),
          missileStart: { x: 0, z: 0 }, missileTarget: { x: 20, z: 0 },
          missileDuration: duration, missileArcHeight: 8,
        });
        actual.shot(1);
        reference.shot(1);
        actual.update(dt, [bullet]);
        reference.update(dt, [bullet]);
        const smoke = actual.particles.filter(p => p.active && p.spec.id === spec.id);
        assert.ok(smoke.length > 0, `weapon ${weaponId}: first update must emit a real trail particle`);
        for (const particle of smoke) {
          const baseline = reference.particles[particle.index];
          assert.ok(baseline.active);
          assert.equal(baseline.spec.id, particle.spec.id);
          assert.equal(baseline.random, particle.random, 'noise does not consume or reorder visual RNG samples');
          assert.equal(baseline.age, particle.age);
          const displacement = distance(position(particle), position(baseline));
          assert.ok(displacement <= speedBound(spec) * particle.age + 1e-7,
            `weapon ${weaponId}, seed ${initialSeed}, dt ${dt}: first-spawn noise moved ${displacement} in ${particle.age}s`);
        }
      }
    }
    assert.equal(JSON.stringify(systems), originalSource, 'production source specs remain unchanged');
    assert.equal(JSON.stringify(referenceSystems), referenceSource, 'reference source specs remain unchanged');
  }
});
