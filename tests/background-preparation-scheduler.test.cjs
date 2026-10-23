const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./support/resource-modules.cjs').resourceModules();
const { BackgroundPreparationScheduler } = load('BackgroundPreparationScheduler');
const { RESOURCE_LOADING_POLICY: { backgroundScheduling: policy } } = load('ResourceLoadingPolicy');

test('background UI waits for startup stability then receives one admission on every rendering frame', () => {
  let now = 0; const scheduler = new BackgroundPreparationScheduler(() => now);
  for (let i = 0; i < 80; i++) { now = i * 16; assert.equal(scheduler.allow(1 / 60, 2), false); }
  now = policy.startupDelayMs; assert.equal(scheduler.allow(1 / 60, 2), true);
  assert.equal(scheduler.allow(1 / 60, 2), false, 'same timestamp cannot dispatch more work');
  for(let frame=0;frame<60;frame++){now+=1000/60;assert.equal(scheduler.allow(1/60,2),true);}
  assert.equal(scheduler.snapshot().admitted,61);
});

test('slow rendering or expensive gameplay defers background work until cooldown and recovery', () => {
  for (const [dt, work] of [[.08, 1], [1 / 60, 14], [NaN, 1], [1 / 60, NaN]]) {
    let now = 0; const scheduler = new BackgroundPreparationScheduler(() => now);
    now = 2000; for (let i = 0; i < policy.stableFrames; i++) scheduler.allow(1 / 60, 1);
    assert.equal(scheduler.allow(dt, work), false); assert.equal(scheduler.snapshot().reason, 'busy-frame');
    for (let i = 1; i < policy.stableFrames; i++) { now = 2000 + i * 16; assert.equal(scheduler.allow(1 / 60, 1), false); }
    now = 2000 + Math.max(policy.busyFrameDelayMs, policy.stableFrames * 16); assert.equal(scheduler.allow(1 / 60, 1), true);
    assert.equal(scheduler.allow(.08, 1), false);
    now += 1000; assert.equal(scheduler.allow(1 / 60, 1), true, 'one bounded slice eventually bypasses the stable-frame requirement');
    assert.equal(scheduler.lastAdmissionForced, true);
  }
});

test('periodic jank and consistently busy updates cannot starve a one-step recovery slice', () => {
  for (const profile of ['stalls', 'busy']) {
    let now = 0, last = 0, admissions = 0;
    const scheduler = new BackgroundPreparationScheduler(() => now); scheduler.reset(0);
    for (let frame = 0; frame < 7200; frame++) {
      const dt = profile === 'stalls' ? .1 : 1 / 60;
      now += dt * 1000;
      if (scheduler.allow(dt, profile === 'busy' ? 20 : 2)) {
        assert.ok(now - last <= policy.maxDeferralMs + 100, `${profile}: bounded progress`);
        last = now; admissions++;
      }
    }
    assert.ok(admissions >= 100, profile);
    assert.ok(scheduler.snapshot().forcedAdmissions > 0);
  }
});

test('9 ms gameplay and periodic jank retain useful preparation throughput with rendering headroom', () => {
  for (const profile of ['60hz', '30hz', 'periodic']) {
    let now=0, admitted=0, frames=0;const scheduler=new BackgroundPreparationScheduler(()=>now);scheduler.reset(0);
    while(now<60000){
      const dt=profile==='30hz'?1/30:profile==='periodic'&&frames%20===0?.08:1/60;
      now+=dt*1000;frames++;if(scheduler.allow(dt,9))admitted++;
    }
    assert.ok(admitted>frames*.6,`${profile}: ${admitted}/${frames} frames received a bounded slice`);
    assert.equal(scheduler.hasFrameHeadroom(1/30,25),true);
    assert.equal(scheduler.hasFrameHeadroom(1/60,25),false,'never infer more CPU headroom from a single long frame');
  }
});

test('30 fps devices keep preparing; resume restarts the settling window without catch-up bursts', () => {
  let now = 0, count = 0; const scheduler = new BackgroundPreparationScheduler(() => now);
  for (let i = 0; i < 90; i++) { now += 1000 / 30; if (scheduler.allow(1 / 30, 2)) count++; }
  assert.ok(count > 30, 'steady 30 Hz is not treated as a permanent stall');
  scheduler.reset(policy.recoveryDelayMs);
  for (let i = 0; i < 10; i++) { now += 1000 / 30; assert.equal(scheduler.allow(1 / 30, 2), false); }
  now += 1000; assert.equal(scheduler.allow(1 / 30, 2), true);
  assert.equal(scheduler.allow(1 / 30, 2), false);
});

test('an early slow frame cannot shorten the initial settling delay', () => {
  let now = 0; const scheduler = new BackgroundPreparationScheduler(() => now);
  scheduler.allow(.1, 1);
  for (let i = 0; i < policy.stableFrames; i++) scheduler.allow(1 / 60, 1);
  now = policy.startupDelayMs - 1; assert.equal(scheduler.allow(1 / 60, 1), false);
  now++; assert.equal(scheduler.allow(1 / 60, 1), true);
});
